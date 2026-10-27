/**
 * Phase 15.3 — replay candidates, the model tape and fair comparison over
 * the API: a model swap on one agent across a golden set, repeated three
 * times and compared with a baseline rerun, estimated first; a guard-only
 * candidate replayed from the model tape (no model calls); two versions of
 * a guard profile; strict and lenient tape misses; golden runs without a
 * tape; the budget across repeats; inline candidates and their checks.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { EvalCaseDetail, EvalCaseResult, EvalRunView, ReplayJobEstimate, ReplayRecordingSummary, Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { openTestStore } from "./test-support/test-store.js";
import { testSql } from "./test-support/test-sql.js";
import { projectSessionNamespace } from "./run-scope.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";

interface TestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  secretService: SecretService;
  config: AppConfig;
  tempDir: string;
  dbPath: string;
}

const contexts: TestContext[] = [];
const closers: Array<() => Promise<void>> = [];
const MODEL_KEY = "sk-model-CANDIDATE-key-0a1b2c3d4e5f60718293";
const MASTER_KEY = crypto.randomBytes(32).toString("base64");

async function createTestContext(overrides: Record<string, string> = {}, existing?: { tempDir: string; dbPath: string }): Promise<TestContext> {
  const tempDir = existing?.tempDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "ao-replay-cand-"));
  const dbPath = existing?.dbPath ?? path.join(tempDir, "orchestrator.db");
  const store = await openTestStore(dbPath);
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: MASTER_KEY,
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "git"),
    ...overrides
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = await createApp(config, store, secretService, authService);
  await app.ready();
  const context = { app, store, authService, secretService, config, tempDir, dbPath };
  if (!existing) contexts.push(context);
  return context;
}

async function closeContext(context: TestContext): Promise<void> {
  await context.app.close();
  try {
    await context.store.close();
  } catch {
    // Already closed by the app shutdown hooks.
  }
}

afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
  while (contexts.length > 0) {
    const context = contexts.pop()!;
    await closeContext(context);
    fs.rmSync(context.tempDir, { recursive: true, force: true });
  }
});

type Role = "admin" | "builder" | "operator" | "viewer";

async function login(context: TestContext, role: Role, name: string = role): Promise<{ cookie: string; id: string }> {
  const email = `${name}@example.com`;
  const password = `${name}-Pass-123!`;
  const user = await context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  if (response.statusCode !== 200) throw new Error(`Login failed for ${name}: ${response.body}`);
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : [raw ?? ""];
  const cookie = values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`));
  if (!cookie) throw new Error("No session cookie");
  return { cookie: cookie.split(";")[0]!, id: user.id };
}

const call = (context: TestContext, method: "GET" | "POST" | "PUT" | "DELETE", url: string, cookie: string, payload?: unknown) =>
  context.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Counts hits per path: stands in for Slack. */
async function startCounter() {
  const hits = new Map<string, number>();
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const key = (request.url ?? "/").split("?")[0]!;
      hits.set(key, (hits.get(key) ?? 0) + 1);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to bind counter");
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { base: `http://127.0.0.1:${address.port}`, count: (route: string) => hits.get(route) ?? 0 };
}


/** An OpenAI-style endpoint: answers `answer(model)` and records each call's model and bearer token. */
async function startModel(answer: (model: string) => string = () => "hello") {
  const calls: Array<{ model: string; auth: string }> = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      let model = "";
      try {
        model = String((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: unknown }).model ?? "");
      } catch {
        model = "";
      }
      calls.push({ model, auth: String(request.headers.authorization ?? "") });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: answer(model) } }], usage: { prompt_tokens: 400, completion_tokens: 20 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to bind fake model");
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, calls };
}

/** start → agent_1 (chat model: `model`) → output. */
function agentWorkflow(baseUrl: string, secretId: string, projectId = "default", id = "wf-cand"): Workflow {
  return {
    id,
    name: "Candidate agent",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId,
    nodes: [
      { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
      { id: "agent_1", type: "agent_orchestrator", name: "Agent", position: { x: 150, y: 0 }, config: { systemPromptTemplate: "Be brief.", userPromptTemplate: "Say hi", maxIterations: 1, toolCallingEnabled: false } },
      { id: "model", type: "llm_call", name: "Model", position: { x: 150, y: 160 }, config: { provider: { providerId: "openai", model: "gpt-4o-mini", baseUrl, secretRef: { secretId }, extra: { maxRetries: 0 } } } },
      { id: "output", type: "output", name: "Output", position: { x: 300, y: 0 }, config: {} }
    ],
    edges: [
      { id: "e1", source: "start", target: "agent_1" },
      { id: "e2", source: "agent_1", sourceHandle: "chat_model", target: "model" },
      { id: "e3", source: "agent_1", target: "output" }
    ]
  } as Workflow;
}

/** start → label → Slack (a write) → output. */
function writeWorkflow(base: string, answer = "v1"): Workflow {
  return {
    id: "wf-write",
    name: "Writes",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
      { id: "label", type: "set_node", name: "Label", position: { x: 150, y: 0 }, config: { assignments: [{ key: "answer", valueTemplate: answer }] } },
      { id: "notify", type: "slack_send_message", name: "Notify", position: { x: 300, y: 0 }, config: { authType: "webhook", webhookUrl: `${base}/slack`, text: "done" } },
      { id: "output", type: "output", name: "Output", position: { x: 450, y: 0 }, config: { responseTemplate: "answer {{results.label.answer}}" } }
    ],
    edges: [
      { id: "e1", source: "start", target: "label" },
      { id: "e2", source: "label", target: "notify" },
      { id: "e3", source: "notify", target: "output" }
    ]
  } as Workflow;
}

/** webhook → guard (no profile on the node: the run's profiles) → pass | blocked. */
function guardWorkflow(): Workflow {
  return {
    id: "wf-guarded",
    name: "Guarded",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      { id: "hook", type: "webhook_input", name: "Webhook", position: { x: 0, y: 0 }, config: { path: "hook-guarded", method: "POST" } },
      { id: "guard", type: "guard", name: "Prompt guard", position: { x: 200, y: 0 }, config: {} },
      { id: "pass", type: "output", name: "Pass", position: { x: 400, y: 0 }, config: { responseTemplate: "passed" } },
      { id: "blocked", type: "output", name: "Blocked", position: { x: 400, y: 200 }, config: { responseTemplate: "blocked" } }
    ],
    edges: [
      { id: "e1", source: "hook", target: "guard" },
      { id: "e2", source: "guard", sourceHandle: "pass", target: "pass" },
      { id: "e3", source: "guard", sourceHandle: "blocked", target: "blocked" }
    ]
  } as Workflow;
}

function emailProfile(action: "allow" | "block"): Record<string, unknown> {
  return {
    id: "cand-guard",
    name: "Candidate guard",
    version: "1",
    channels: { prompt: { detectors: [{ id: "dlp.patterns", threshold: 0.5 }], actions: { email: { action } }, defaultAction: { action: "allow" } } }
  };
}

/** Golden runs of `workflowId`, from runs recorded with Record calls on (`record`) or not. */
async function goldenRuns(context: TestContext, cookie: string, workflowId: string, count: number, body: Record<string, unknown> = { record: true }): Promise<ReplayRecordingSummary[]> {
  const out: ReplayRecordingSummary[] = [];
  for (let index = 0; index < count; index += 1) {
    const run = await call(context, "POST", `/api/workflows/${workflowId}/execute`, cookie, body);
    expect(run.statusCode, run.body).toBe(200);
    const saved = await call(context, "POST", "/api/replay/recordings", cookie, { executionId: run.json<{ executionId: string }>().executionId, name: `Golden ${index + 1}` });
    expect(saved.statusCode, saved.body).toBe(201);
    out.push(saved.json<{ recording: ReplayRecordingSummary }>().recording);
  }
  return out;
}

async function goldenSet(context: TestContext, cookie: string, workflowId: string, recordings: ReplayRecordingSummary[]): Promise<string> {
  const created = await call(context, "POST", "/api/eval/datasets", cookie, { name: "Suite", workflowId });
  expect(created.statusCode, created.body).toBe(200);
  const set = created.json<{ dataset: { id: string } }>().dataset;
  for (const recording of recordings) {
    const added = await call(context, "POST", `/api/eval/datasets/${set.id}/recordings`, cookie, { recordingId: recording.id });
    expect(added.statusCode, added.body).toBe(201);
  }
  return set.id;
}

type JobView = EvalRunView & { results: EvalCaseResult[] };

async function runJob(context: TestContext, cookie: string, body: Record<string, unknown>, timeoutMs = 45_000): Promise<JobView> {
  const started = await call(context, "POST", "/api/replay/runs", cookie, body);
  expect(started.statusCode, started.body).toBe(202);
  const runId = started.json<{ run: EvalRunView }>().run.id;
  const until = Date.now() + timeoutMs;
  for (;;) {
    const response = await call(context, "GET", `/api/replay/runs/${runId}`, cookie);
    expect(response.statusCode, response.body).toBe(200);
    const run = response.json<{ run: JobView }>().run;
    if (!["queued", "running"].includes(run.status)) return run;
    if (Date.now() > until) throw new Error(`Job ${runId} still ${run.status}`);
    await sleep(50);
  }
}

async function caseDetail(context: TestContext, cookie: string, runId: string, resultId: string): Promise<EvalCaseDetail> {
  const response = await call(context, "GET", `/api/replay/runs/${runId}/results/${resultId}`, cookie);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ result: EvalCaseDetail }>().result;
}

async function agentSetup(answer?: (model: string) => string, golden = 2, body?: Record<string, unknown>, options: { config?: Record<string, string>; saveVersion?: boolean } = {}) {
  const model = await startModel(answer);
  const context = await createTestContext({ REPLAY_CONCURRENCY: "2", ...options.config });
  const builder = await login(context, "builder");
  const secret = await context.secretService.createSecret({ name: "Model key", provider: "openai", value: MODEL_KEY });
  await context.store.upsertWorkflow(agentWorkflow(model.baseUrl, secret.secretId));
  // Saved as version 1, so a baseline rerun replays that version (not the scrubbed captured copy).
  if (options.saveVersion !== false) {
    await context.store.writeWorkflowVersion({ id: "wf-cand-v1", workflowId: "wf-cand", version: 1, workflowJson: JSON.stringify(await context.store.getWorkflow("wf-cand")) });
  }
  const recordings = await goldenRuns(context, builder.cookie, "wf-cand", golden, body);
  const setId = await goldenSet(context, builder.cookie, "wf-cand", recordings);
  return { context, builder, model, setId, recordings, secret };
}

describe("replay candidates and fair comparison", () => {
  it("swaps the model on agent_1 across a golden set, three repeats against a baseline rerun, estimated first", async () => {
    const { context, builder, model, setId, recordings } = await agentSetup();
    expect(model.calls).toHaveLength(2);
    // The golden runs carry a model tape.
    expect(recordings[0]!.capabilities).toMatchObject({ models: "tape", mcp: "cassette" });
    const detail = (await call(context, "GET", `/api/replay/recordings/${recordings[0]!.id}`, builder.cookie)).json<{ recording: { modelCallCount: number } }>().recording;
    expect(detail.modelCallCount).toBe(1);

    const body = { datasetIds: [setId], overrides: { models: [{ nodeId: "agent_1", model: "gpt-5-mini" }] }, repeats: 3, compare: "baseline_rerun", aggregate: "majority" };
    const estimate = await call(context, "POST", "/api/replay/estimate", builder.cookie, body);
    expect(estimate.statusCode, estimate.body).toBe(200);
    const estimated = estimate.json<ReplayJobEstimate>();
    expect(estimated).toMatchObject({ cases: 2, runsPerCase: 6, modelCallsEstimate: 12 });
    expect(Array.isArray(estimated.warnings)).toBe(true);
    expect(estimated.costUnknown || estimated.estimatedCostUsd > 0).toBe(true);
    // The estimate ran nothing.
    expect(model.calls).toHaveLength(2);

    const job = await runJob(context, builder.cookie, body);
    expect(job.status, job.error ?? "").toBe("completed");
    expect(job.candidate).toMatchObject({ kind: "draft", overrides: { models: [{ nodeId: "agent_1", model: "gpt-5-mini" }] } });
    expect(job.candidate!.workflowHash).not.toBe(job.candidate!.baseHash);
    expect(job.options).toMatchObject({ models: "live", compare: "baseline_rerun", repeats: 3, aggregate: "majority" });
    expect(job.summary).toMatchObject({ total: 2, pass: 2, executions: 12 });
    // Every execution called the model once: six baselines on the recorded model, six candidates on the new one.
    const replayCalls = model.calls.slice(2);
    expect(replayCalls).toHaveLength(12);
    expect(replayCalls.filter((entry) => entry.model === "gpt-5-mini")).toHaveLength(6);
    expect(replayCalls.filter((entry) => entry.model === "gpt-4o-mini")).toHaveLength(6);
    expect(model.calls.every((entry) => entry.auth === `Bearer ${MODEL_KEY}`)).toBe(true);

    for (const result of job.results) {
      expect(result.repeats).toMatchObject({ total: 3, pass: 3, aggregate: "majority", flaky: false });
      const caseView = await caseDetail(context, builder.cookie, job.id, result.id);
      expect(caseView.replay).toMatchObject({ compare: "baseline_rerun" });
      expect(caseView.replay!.attempts).toHaveLength(3);
      for (const attempt of caseView.replay!.attempts!) {
        expect(attempt.baselineExecutionId).toBeTruthy();
        expect(attempt.executionId).toBeTruthy();
        expect(attempt.baselineExecutionId).not.toBe(attempt.executionId);
      }
    }
  }, 90_000);

  it("replays a guard-only candidate from the model tape without calling the model", async () => {
    const { context, builder, model, setId } = await agentSetup();
    expect(model.calls).toHaveLength(2);
    const job = await runJob(context, builder.cookie, { datasetIds: [setId], overrides: { guardProfile: { profileId: "default" } }, models: "replay" });
    expect(job.status, job.error ?? "").toBe("completed");
    expect(job.summary).toMatchObject({ total: 2, pass: 2, error: 0 });
    expect(job.candidate!.workflowHash).toBe(job.candidate!.baseHash);
    // Zero model calls: every one was answered from the tape.
    expect(model.calls).toHaveLength(2);
    const estimate = (await call(context, "POST", "/api/replay/estimate", builder.cookie, { datasetIds: [setId], models: "replay" })).json<ReplayJobEstimate>();
    expect(estimate).toMatchObject({ cases: 2, runsPerCase: 1, modelCallsEstimate: 0 });
  }, 60_000);

  it("fails a strict tape miss without calling the model, and calls the live model on a lenient one", async () => {
    const { context, builder, model, setId } = await agentSetup(undefined, 1);
    const overrides = { models: [{ nodeId: "agent_1", model: "gpt-5-mini" }] };
    const strictEstimate = (await call(context, "POST", "/api/replay/estimate", builder.cookie, { datasetIds: [setId], overrides, models: "replay" })).json<ReplayJobEstimate>();
    expect(strictEstimate.warnings.join(" ")).toContain("strict mode those cases are inconclusive");

    const strict = await runJob(context, builder.cookie, { datasetIds: [setId], overrides, models: "replay" });
    expect(strict.summary).toMatchObject({ total: 1, error: 1 });
    expect(model.calls).toHaveLength(1);
    const strictCase = await caseDetail(context, builder.cookie, strict.id, strict.results[0]!.id);
    expect(strictCase.replay!.diff.health.map((warning) => warning.kind)).toContain("model_unmatched");

    const lenient = await runJob(context, builder.cookie, { datasetIds: [setId], overrides, models: "replay", mcpMode: "lenient" });
    expect(lenient.summary).toMatchObject({ total: 1, pass: 1 });
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]!.model).toBe("gpt-5-mini");
    const lenientCase = await caseDetail(context, builder.cookie, lenient.id, lenient.results[0]!.id);
    expect(lenientCase.replay!.diff.health.map((warning) => warning.kind)).toContain("model_live");
  }, 60_000);

  it("a required case made inconclusive by a strict tape miss blocks an enforced gate even when errors do not count as failures", async () => {
    const { context, builder, setId } = await agentSetup(undefined, 2);
    const admin = await login(context, "admin");
    const gate = await call(context, "PUT", "/api/workflows/wf-cand/release-gate", admin.cookie, {
      enabled: true,
      enforced: true,
      datasetIds: [setId],
      policy: { minPassRate: 0, minCases: 1, maxRegressions: 5, errorsCountAsFailures: false }
    });
    expect(gate.statusCode, gate.body).toBe(200);
    const fixtures = (await call(context, "GET", `/api/eval/datasets/${setId}/fixtures`, builder.cookie)).json<{ fixtures: Array<{ id: string; name: string }> }>().fixtures;
    const required = fixtures[0]!;
    const marked = await call(context, "PUT", `/api/workflows/wf-cand/release-gate/cases/${required.id}/required`, admin.cookie, { required: true });
    expect(marked.statusCode, marked.body).toBe(200);

    // The candidate swaps the model, and strict model replay has no tape entry for it: every case is inconclusive.
    const job = await runJob(context, builder.cookie, { datasetIds: [setId], overrides: { models: [{ nodeId: "agent_1", model: "gpt-5-mini" }] }, models: "replay" });
    expect(job.summary).toMatchObject({ total: 2, error: 2 });
    const view = (await call(context, "GET", `/api/replay/runs/${job.id}`, builder.cookie)).json<{
      run: { releaseGate?: { verdict?: string; reasons?: string[]; requiredFixtureIds: string[] } };
    }>().run;
    expect(view.releaseGate?.requiredFixtureIds).toEqual([required.id]);
    expect(view.releaseGate?.verdict).toBe("blocked");
    expect(view.releaseGate?.reasons).toContain(`Required case "${required.name}" was inconclusive: a required case must pass whatever the pass rate.`);
  }, 60_000);

  it("makes golden runs without a model tape inconclusive under models replay, running nothing", async () => {
    const { context, builder, model, setId, recordings } = await agentSetup(undefined, 1, {});
    expect(recordings[0]!.capabilities.models).toBe("live");
    const estimate = (await call(context, "POST", "/api/replay/estimate", builder.cookie, { datasetIds: [setId], models: "replay" })).json<ReplayJobEstimate>();
    expect(estimate.warnings.join(" ")).toContain("no model tape");
    const job = await runJob(context, builder.cookie, { datasetIds: [setId], models: "replay" });
    expect(job.summary).toMatchObject({ total: 1, error: 1 });
    expect(job.results[0]!.error).toContain("no model tape");
    expect(model.calls).toHaveLength(1);
  }, 60_000);

  it("stops a repeated job on its budget between executions", async () => {
    const { context, builder, setId } = await agentSetup(undefined, 2);
    const estimate = (await call(context, "POST", "/api/replay/estimate", builder.cookie, { datasetIds: [setId], repeats: 3, compare: "baseline_rerun", maxCostUsd: 0.0001 })).json<ReplayJobEstimate>();
    expect(estimate.warnings.join(" ")).toContain("over the job's budget");
    const job = await runJob(context, builder.cookie, { datasetIds: [setId], repeats: 3, compare: "baseline_rerun", maxCostUsd: 0.0001 });
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/budget/);
    expect(job.summary!.executions ?? 0).toBeLessThan(12);
    expect(job.progress!.spentUsd).toBeGreaterThan(0);
  }, 60_000);

  it("compares two versions of a guard profile: the newer one's block shows in the guard diff", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    expect((await call(context, "POST", "/api/guard/profiles", admin.cookie, { document: emailProfile("allow") })).statusCode).toBe(201);
    expect((await call(context, "PUT", "/api/guard/profiles/cand-guard", admin.cookie, { document: emailProfile("block") })).statusCode).toBe(200);
    await context.store.upsertWorkflow(guardWorkflow());
    const recordings = await goldenRuns(context, builder.cookie, "wf-guarded", 1, { record: true, user_prompt: "Write to someone@example.com please" });
    const setId = await goldenSet(context, builder.cookie, "wf-guarded", recordings);

    // A profile or version that does not exist is refused before anything runs.
    expect((await call(context, "POST", "/api/replay/runs", builder.cookie, { datasetIds: [setId], overrides: { guardProfile: { profileId: "missing" } } })).statusCode).toBe(400);
    expect((await call(context, "POST", "/api/replay/runs", builder.cookie, { datasetIds: [setId], overrides: { guardProfile: { profileId: "cand-guard", version: 9 } } })).statusCode).toBe(400);

    const v1 = await runJob(context, builder.cookie, { datasetIds: [setId], overrides: { guardProfile: { profileId: "cand-guard", version: 1 } } });
    const v2 = await runJob(context, builder.cookie, { datasetIds: [setId], overrides: { guardProfile: { profileId: "cand-guard", version: 2 } } });
    expect(v1.summary).toMatchObject({ pass: 1 });
    expect(v2.summary).toMatchObject({ fail: 1 });
    const v1Case = await caseDetail(context, builder.cookie, v1.id, v1.results[0]!.id);
    const v2Case = await caseDetail(context, builder.cookie, v2.id, v2.results[0]!.id);
    expect(JSON.stringify(v1Case.replay!.diff.guard)).not.toContain('"effectiveAction":"block"');
    const v2Guard = v2Case.replay!.diff.guard;
    expect([...v2Guard.added, ...v2Guard.changed.map((change) => change.candidate)].some((verdict) => verdict.effectiveAction === "block")).toBe(true);

    // The verdicts name the candidate's profile and version.
    const events = (await call(context, "GET", `/api/executions/${v2.results[0]!.executionId}/guard-events`, admin.cookie)).json<{ events: Array<{ profileId: string; profileVersion: number; effectiveAction: string }> }>().events;
    expect(events.some((event) => event.profileId === "cand-guard" && event.profileVersion === 2 && event.effectiveAction === "block")).toBe(true);
  }, 60_000);

  it("checks inline candidates and overrides: write access, the workflow id, validation and write nodes", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const viewer = await login(context, "viewer");
    const counter = await startCounter();
    await context.store.upsertWorkflow(writeWorkflow(counter.base));
    const recordings = await goldenRuns(context, builder.cookie, "wf-write", 2);
    const setId = await goldenSet(context, builder.cookie, "wf-write", recordings);
    expect(counter.count("/slack")).toBe(2);
    const before = await context.store.getWorkflow("wf-write");

    // Validation: another workflow's file, an invalid file, both a version and a file, overrides that match nothing, a write node run live.
    const other = { ...writeWorkflow(counter.base, "v2"), id: "wf-other" };
    const refused = [
      { datasetIds: [setId], workflow: other },
      { datasetIds: [setId], workflow: { id: "wf-write", nodes: "nope" } },
      { datasetIds: [setId], workflow: writeWorkflow(counter.base, "v2"), version: 1 },
      { datasetIds: [setId], overrides: { models: [{ nodeId: "missing", model: "x" }] } },
      { datasetIds: [setId], overrides: { liveReadNodes: ["notify"] } },
      { datasetIds: [setId], overrides: { mcpServers: { srv: "live" } } }
    ];
    for (const body of refused) {
      for (const url of ["/api/replay/runs", "/api/replay/estimate"]) {
        const response = await call(context, "POST", url, builder.cookie, body);
        expect(response.statusCode, `${url} ${JSON.stringify(body).slice(0, 120)}`).toBe(400);
      }
    }
    expect((await call(context, "POST", "/api/replay/runs", builder.cookie, { datasetIds: [setId], workflow: other })).json<{ error: string }>().error).toContain("wf-other");
    expect((await call(context, "POST", "/api/replay/runs", builder.cookie, { datasetIds: [setId], overrides: { liveReadNodes: ["notify"] } })).json<{ error: string }>().error).toContain("never run those live");
    expect((await call(context, "POST", "/api/replay/estimate", viewer.cookie, { datasetIds: [setId] })).statusCode).toBe(403);

    // An inline candidate runs and is never saved; nothing external runs.
    const inline = await runJob(context, builder.cookie, { datasetIds: [setId], workflow: { workflow: writeWorkflow(counter.base, "v2") } });
    expect(inline.status, inline.error ?? "").toBe("completed");
    expect(inline.candidate).toMatchObject({ kind: "inline", version: null, name: "Writes" });
    expect(inline.summary).toMatchObject({ total: 2, fail: 2 });
    expect(await context.store.getWorkflow("wf-write")).toEqual(before);
    expect(counter.count("/slack")).toBe(2);

    // A user who may run the workflow but not edit it: plain jobs only.
    await context.store.upsertProject({ id: "team", name: "Team" });
    const shared = { ...writeWorkflow(counter.base), id: "wf-team", projectId: "team" };
    await context.store.upsertWorkflow(shared);
    const teamGolden = await goldenRuns(context, admin.cookie, "wf-team", 1);
    const teamSet = await goldenSet(context, admin.cookie, "wf-team", teamGolden);
    // In the team project the builder may read and run workflows, not edit them.
    await context.store.upsertCustomRole({ id: "run-only", projectId: "team", name: "Run only", permissions: ["workflow:read", "workflow:execute"] });
    await context.store.upsertProjectRole({ userId: builder.id, projectId: "team", role: "custom", customRoleId: "run-only" });
    for (const body of [{ datasetIds: [teamSet], workflow: { ...shared, name: "Changed" } }, { datasetIds: [teamSet], overrides: { guardProfile: { profileId: "default" } } }]) {
      for (const url of ["/api/replay/runs", "/api/replay/estimate"]) {
        const response = await call(context, "POST", url, builder.cookie, body);
        expect(response.statusCode, response.body).toBe(403);
        expect(response.json<{ error: string }>().error).toContain("workflow:write");
      }
    }
    expect((await call(context, "POST", "/api/replay/estimate", builder.cookie, { datasetIds: [teamSet] })).statusCode).toBe(200);
    const plain = await runJob(context, builder.cookie, { datasetIds: [teamSet] });
    expect(plain.status, plain.error ?? "").toBe("completed");
  }, 90_000);
});

// ---------------------------------------------------------------------------
// Review fixes (H1, M1-M4, L1-L9)
// ---------------------------------------------------------------------------

/** An OpenAI-style endpoint that keeps every request body; `delayMs` slows each answer, `failFirst` fails the first call. */
async function startRecordingModel(options: { answer?: string; delayMs?: number; failFirst?: number; contentBytes?: number } = {}) {
  const bodies: Array<{ model: string; messages: Array<{ role: string; content: unknown }> }> = [];
  let failures = options.failFirst ?? 0;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { model?: string; messages?: Array<{ role: string; content: unknown }> };
      bodies.push({ model: String(body.model ?? ""), messages: body.messages ?? [] });
      const reply = () => {
        if (failures > 0) {
          failures -= 1;
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "temporarily unavailable" } }));
          return;
        }
        const content = options.contentBytes ? "the quick brown fox. ".repeat(Math.ceil(options.contentBytes / 21)) : (options.answer ?? "hello");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 400, completion_tokens: 20 } }));
      };
      if (options.delayMs) setTimeout(reply, options.delayMs);
      else reply();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to bind fake model");
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, bodies };
}

async function registerMockServer(context: TestContext, adminCookie: string): Promise<string> {
  const created = await call(context, "POST", "/api/mcp/servers", adminCookie, { name: "Mock", adapterId: "mock-mcp", probeEnabled: false });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json<{ server: { id: string } }>().server.id;
  expect((await call(context, "POST", `/api/mcp/servers/${id}/probe`, adminCookie)).statusCode).toBe(200);
  return id;
}

/** start → MCP clock tool → output. */
function clockWorkflow(serverId: string): Workflow {
  return {
    id: "wf-clock",
    name: "Clock",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
      { id: "tool", type: "mcp_tool", name: "Clock", position: { x: 150, y: 0 }, config: { registryServerId: serverId, toolName: "get_current_time", argsTemplate: JSON.stringify({ tz: "UTC" }), retry: { enabled: false } } },
      { id: "output", type: "output", name: "Output", position: { x: 300, y: 0 }, config: { responseTemplate: "at {{results.tool.tool_output}}" } }
    ],
    edges: [
      { id: "e1", source: "start", target: "tool" },
      { id: "e2", source: "tool", target: "output" }
    ]
  } as Workflow;
}

describe("replay candidates: review fixes", () => {
  it("refuses polling triggers, browser nodes and other unlisted nodes as live reads, naming the node (H1, M4)", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const counter = await startCounter();
    await context.store.upsertWorkflow(writeWorkflow(counter.base));
    const setId = await goldenSet(context, builder.cookie, "wf-write", await goldenRuns(context, builder.cookie, "wf-write", 1));
    // The draft gains nodes after the golden run; naming them as live reads is refused before anything runs.
    const draft = writeWorkflow(counter.base);
    const extra = [
      { id: "redis_in", type: "redis_trigger", config: { key: "jobs" } },
      { id: "pg_in", type: "postgres_trigger", config: { query: "UPDATE jobs SET picked = true RETURNING *" } },
      { id: "browse", type: "web_browse", config: { urlTemplate: "https://example.com" } },
      { id: "pdf", type: "pdf_output", config: { renderMode: "html" } },
      { id: "fetch", type: "http_request", config: { method: "GET", urlTemplate: `${counter.base}/get` } }
    ];
    draft.nodes.push(...(extra.map((node) => ({ ...node, name: node.id, position: { x: 0, y: 300 } })) as Workflow["nodes"]));
    await context.store.upsertWorkflow(draft);
    for (const nodeId of ["redis_in", "pg_in", "browse", "pdf"]) {
      for (const url of ["/api/replay/runs", "/api/replay/estimate"]) {
        const response = await call(context, "POST", url, builder.cookie, { datasetIds: [setId], overrides: { liveReadNodes: [nodeId] } });
        expect(response.statusCode, `${url} ${nodeId}`).toBe(400);
        expect(response.json<{ error: string }>().error).toContain(`node ${nodeId}`);
      }
    }
    // A GET request is on the allow-list.
    expect((await call(context, "POST", "/api/replay/estimate", builder.cookie, { datasetIds: [setId], overrides: { liveReadNodes: ["fetch"] } })).statusCode).toBe(200);
  }, 60_000);

  it("counts model calls answered from the tape as zero spend and reports their recorded cost apart (M1)", async () => {
    const { context, builder, setId } = await agentSetup();
    const estimate = (await call(context, "POST", "/api/replay/estimate", builder.cookie, { datasetIds: [setId], models: "replay", compare: "baseline_rerun", repeats: 2 })).json<ReplayJobEstimate>();
    expect(estimate).toMatchObject({ cases: 2, runsPerCase: 4, modelCallsEstimate: 0, estimatedCostUsd: 0, executions: 8 });

    const job = await runJob(context, builder.cookie, { datasetIds: [setId], models: "replay", compare: "baseline_rerun", repeats: 2 });
    expect(job.status, job.error ?? "").toBe("completed");
    expect(job.summary).toMatchObject({ total: 2, pass: 2, costUsd: 0, replayedModelCalls: 8 });
    expect(job.progress!.spentUsd).toBe(0);
    expect(job.summary!.recordedCostUsd ?? 0).toBeGreaterThan(0);
    const detail = await caseDetail(context, builder.cookie, job.id, job.results[0]!.id);
    expect(detail.costUsd).toBe(0);
    expect(detail.replay).toMatchObject({ modelTape: { replayedCalls: 1, liveCalls: 0 } });
    expect(detail.replay!.modelTape!.recordedUsage.inputTokens).toBe(400);
    // The cost dashboards record no spend for the replay executions either.
    {
      const rows = await testSql(context.store).all<{ cost_usd: number | string; input_tokens: number | string; llm_call_count: number | string }>("SELECT cost_usd, input_tokens, llm_call_count FROM usage_events WHERE trigger_type = 'replay'");
      expect(rows).toHaveLength(8);
      expect(rows.every((row) => Number(row.cost_usd) === 0 && Number(row.input_tokens) === 0 && Number(row.llm_call_count) === 0)).toBe(true);
    }
  }, 60_000);

  it("budgets only the live calls of a lenient tape miss (M1, L9)", async () => {
    const { context, builder, setId } = await agentSetup(undefined, 1);
    const job = await runJob(context, builder.cookie, { datasetIds: [setId], overrides: { models: [{ nodeId: "agent_1", model: "gpt-4o" }] }, models: "replay", mcpMode: "lenient" });
    expect(job.summary).toMatchObject({ total: 1, pass: 1 });
    expect(job.summary!.replayedModelCalls ?? 0).toBe(0);
    expect(job.progress!.spentUsd).toBeGreaterThan(0);
    const detail = await caseDetail(context, builder.cookie, job.id, job.results[0]!.id);
    expect(detail.replay).toMatchObject({ modelTape: { replayedCalls: 0, liveCalls: 1 } });
  }, 60_000);

  it("stores release eligibility and pins the guard profile version a job runs (M2)", async () => {
    const { context, builder, setId } = await agentSetup(undefined, 1);
    const plain = await runJob(context, builder.cookie, { datasetIds: [setId] });
    expect(plain.candidate).toMatchObject({ kind: "draft", releaseEligible: true, releaseIneligibleReasons: [] });
    const version = await runJob(context, builder.cookie, { datasetIds: [setId], version: 1 });
    expect(version.candidate).toMatchObject({ kind: "version", version: 1, releaseEligible: true });

    // "latest" is resolved once, when the job is created, and stored with its hash.
    const guarded = await runJob(context, builder.cookie, { datasetIds: [setId], overrides: { guardProfile: { profileId: "default" } } });
    const latest = await context.store.getGuardProfileVersion("default");
    expect(guarded.candidate!.overrides!.guardProfile).toEqual({ profileId: "default", version: latest!.version });
    expect(guarded.candidate!.guardProfile).toEqual({ profileId: "default", version: latest!.version, hash: latest!.hash });
    expect(guarded.candidate!.releaseEligible).toBe(false);
    expect(guarded.candidate!.releaseIneligibleReasons!.join(" ")).toMatch(/guard profile/);
    // Stored on the job, not only in the response.
    const stored = (await context.store.getEvalRun(guarded.id))!.candidate as { releaseEligible?: boolean; guardProfile?: { version: number } };
    expect(stored).toMatchObject({ releaseEligible: false, guardProfile: { version: latest!.version } });

    const taped = await runJob(context, builder.cookie, { datasetIds: [setId], models: "replay" });
    expect(taped.candidate!.releaseEligible).toBe(false);
    expect(taped.candidate!.releaseIneligibleReasons!.join(" ")).toMatch(/model tape/);
    const lenient = await runJob(context, builder.cookie, { datasetIds: [setId], mcpMode: "lenient" });
    expect(lenient.candidate!.releaseIneligibleReasons!.join(" ")).toMatch(/Lenient/);
  }, 90_000);

  it("refuses an older version of a bound guard profile to a builder, and lets an admin replay it (M2)", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    expect((await call(context, "POST", "/api/guard/profiles", admin.cookie, { document: emailProfile("allow") })).statusCode).toBe(201);
    expect((await call(context, "PUT", "/api/guard/profiles/cand-guard", admin.cookie, { document: emailProfile("block") })).statusCode).toBe(200);
    await context.store.upsertWorkflow(guardWorkflow());
    const setId = await goldenSet(context, builder.cookie, "wf-guarded", await goldenRuns(context, builder.cookie, "wf-guarded", 1, { record: true, user_prompt: "Write to someone@example.com please" }));
    // The project enforces cand-guard (latest: version 2).
    expect((await call(context, "PUT", "/api/guard/bindings/projects/default", admin.cookie, { mode: "enforced", profileId: "cand-guard" })).statusCode).toBe(200);
    const refused = await call(context, "POST", "/api/replay/runs", builder.cookie, { datasetIds: [setId], overrides: { guardProfile: { profileId: "cand-guard", version: 1 } } });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json<{ error: string }>().error).toMatch(/older than version 2.*Only an admin/);
    expect((await call(context, "POST", "/api/replay/estimate", builder.cookie, { datasetIds: [setId], overrides: { guardProfile: { profileId: "cand-guard", version: 1 } } })).statusCode).toBe(400);
    const asAdmin = await runJob(context, admin.cookie, { datasetIds: [setId], overrides: { guardProfile: { profileId: "cand-guard", version: 1 } } });
    expect(asAdmin.candidate!.guardProfile).toMatchObject({ profileId: "cand-guard", version: 1 });
    expect(asAdmin.candidate!.releaseEligible).toBe(false);
  }, 60_000);

  it("caps executions per job and reserves each execution's cost before it runs (M3, L8)", async () => {
    const capped = await agentSetup(undefined, 2, undefined, { config: { REPLAY_JOB_MAX_EXECUTIONS: "4" } });
    const body = { datasetIds: [capped.setId], repeats: 3 };
    const estimate = (await call(capped.context, "POST", "/api/replay/estimate", capped.builder.cookie, body)).json<ReplayJobEstimate>();
    expect(estimate).toMatchObject({ executions: 6, maxExecutions: 4 });
    expect(estimate.warnings.join(" ")).toContain("REPLAY_JOB_MAX_EXECUTIONS");
    const refused = await call(capped.context, "POST", "/api/replay/runs", capped.builder.cookie, body);
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ error: string }>().error).toContain("REPLAY_JOB_MAX_EXECUTIONS");
    expect((await call(capped.context, "POST", "/api/replay/runs", capped.builder.cookie, { datasetIds: [capped.setId], repeats: 2 })).statusCode).toBe(202);

    // One golden run, three repeats, a budget for about one execution: the second is skipped before it runs.
    const { context, builder, model, setId } = await agentSetup(undefined, 1);
    const perExecution = (await call(context, "POST", "/api/replay/estimate", builder.cookie, { datasetIds: [setId] })).json<ReplayJobEstimate>().estimatedCostUsd;
    expect(perExecution).toBeGreaterThan(0);
    const before = model.calls.length;
    const job = await runJob(context, builder.cookie, { datasetIds: [setId], repeats: 3, maxCostUsd: perExecution * 1.5 });
    expect(job.status).toBe("failed");
    expect(job.error).toContain("budget_exhausted");
    expect(model.calls.length - before).toBe(1);
    // Never more than the budget: the next execution was reserved, did not fit and never started.
    expect(job.progress!.spentUsd).toBeLessThanOrEqual(perExecution * 1.5);
    // The repeat that ran passed, but one of three repeats does not decide the case (L8).
    expect(job.results[0]).toMatchObject({ status: "error", repeats: { total: 1, pass: 1 } });
    expect(job.results[0]!.error).toContain("budget_exhausted");
  }, 90_000);

  it("reruns the captured workflow as the baseline when nothing was scrubbed out of it (N2)", async () => {
    const { context, builder, model, setId } = await agentSetup(undefined, 1, undefined, { saveVersion: false });
    const body = { datasetIds: [setId], compare: "baseline_rerun" };
    const estimate = (await call(context, "POST", "/api/replay/estimate", builder.cookie, body)).json<ReplayJobEstimate>();
    expect(estimate.warnings.join(" ")).not.toContain("scrubbed out");
    const before = model.calls.length;
    const job = await runJob(context, builder.cookie, body);
    expect(job.summary).toMatchObject({ total: 1, pass: 1 });
    expect(job.results[0]).toMatchObject({ status: "pass" });
    // The candidate and the baseline both ran.
    expect(model.calls.length - before).toBe(2);
  }, 60_000);

  it("makes a baseline rerun inconclusive when the captured workflow had an inline credential redacted, and warns in the estimate (N2, L7)", async () => {
    const model = await startModel();
    const context = await createTestContext({ REPLAY_CONCURRENCY: "2" });
    const builder = await login(context, "builder");
    const secret = await context.secretService.createSecret({ name: "Model key", provider: "openai", value: MODEL_KEY });
    const workflow = agentWorkflow(model.baseUrl, secret.secretId);
    workflow.nodes = workflow.nodes.map((node) => (node.id === "output" ? { ...node, config: { apiKey: "inline-credential-1234567890" } } : node));
    await context.store.upsertWorkflow(workflow);
    const setId = await goldenSet(context, builder.cookie, "wf-cand", await goldenRuns(context, builder.cookie, "wf-cand", 1));
    const body = { datasetIds: [setId], compare: "baseline_rerun" };
    const estimate = (await call(context, "POST", "/api/replay/estimate", builder.cookie, body)).json<ReplayJobEstimate>();
    expect(estimate.warnings.join(" ")).toContain("scrubbed out");
    const before = model.calls.length;
    const job = await runJob(context, builder.cookie, body);
    expect(job.summary).toMatchObject({ total: 1, error: 1 });
    expect(job.results[0]!.error).toContain("Re-record this golden run");
    expect(model.calls.length).toBe(before);
  }, 60_000);

  it("counts the MCP cassette toward the golden run size limit (L6)", async () => {
    const context = await createTestContext({ REPLAY_RECORDING_MAX_BYTES: "16384" });
    const admin = await login(context, "admin");
    const serverId = await registerMockServer(context, admin.cookie);
    // The calculator echoes its expression, so the tool output (in the cassette and in the node output) is about 2.5 KB.
    const workflow = clockWorkflow(serverId);
    workflow.nodes = workflow.nodes.map((node) =>
      node.id === "tool" ? { ...node, config: { ...node.config, toolName: "calculator", argsTemplate: JSON.stringify({ expression: `1${" ".repeat(2500)}+1` }) } } : node
    );
    await context.store.upsertWorkflow(workflow);
    const run = await call(context, "POST", "/api/workflows/wf-clock/execute", admin.cookie, { record: true });
    expect(run.statusCode, run.body).toBe(200);
    const saved = await call(context, "POST", "/api/replay/recordings", admin.cookie, { executionId: run.json<{ executionId: string }>().executionId, name: "Calculator" });
    expect(saved.statusCode, saved.body).toBe(201);
    const stored = (await context.store.getReplayRecording(saved.json<{ recording: { id: string } }>().recording.id))!;
    expect(stored.mcpCassette).toBeTruthy();
    expect(JSON.stringify(stored.mcpCassette).length).toBeGreaterThan(2000);
    // Workflow + cassette + node outputs would be over the limit: the node output gave way, the total fits.
    expect(stored.bytes).toBeLessThanOrEqual(16384);
    expect(stored.truncated).toBe(true);
  }, 60_000);

  it("re-checks workflow:write for every case of an overridden job (L3)", async () => {
    const model = await startRecordingModel({ delayMs: 400 });
    const context = await createTestContext({ REPLAY_CONCURRENCY: "1" });
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    await context.store.upsertProject({ id: "team", name: "Team" });
    const secret = await context.secretService.createSecret({ name: "Model key", provider: "openai", value: MODEL_KEY });
    await context.store.upsertWorkflow(agentWorkflow(model.baseUrl, secret.secretId, "team", "wf-team-agent"));
    const setId = await goldenSet(context, admin.cookie, "wf-team-agent", await goldenRuns(context, admin.cookie, "wf-team-agent", 3));
    const started = await call(context, "POST", "/api/replay/runs", builder.cookie, { datasetIds: [setId], overrides: { models: [{ nodeId: "agent_1", model: "gpt-5-mini" }] } });
    expect(started.statusCode, started.body).toBe(202);
    // Write access goes; run access stays.
    await context.store.upsertCustomRole({ id: "run-only", projectId: "team", name: "Run only", permissions: ["workflow:read", "workflow:execute"] });
    await context.store.upsertProjectRole({ userId: builder.id, projectId: "team", role: "custom", customRoleId: "run-only" });
    const runId = started.json<{ run: EvalRunView }>().run.id;
    await call(context, "GET", `/api/replay/runs/${runId}?wait=true`, admin.cookie);
    let run: JobView | null = null;
    for (let index = 0; index < 400; index += 1) {
      run = (await call(context, "GET", `/api/replay/runs/${runId}`, admin.cookie)).json<{ run: JobView }>().run;
      if (!["queued", "running"].includes(run.status)) break;
      await sleep(50);
    }
    const refusedCases = run!.results.filter((result) => result.status === "error" && (result.error ?? "").includes("workflow:write"));
    expect(refusedCases.length).toBeGreaterThanOrEqual(2);
  }, 90_000);

  it("refuses a provider switch on a node with its own secret unless the override names a usable secret (L4)", async () => {
    const { context, builder, setId, secret } = await agentSetup(undefined, 1);
    const switched = { nodeId: "model", provider: "anthropic", model: "claude-sonnet-5-5" };
    const refused = await call(context, "POST", "/api/replay/estimate", builder.cookie, { datasetIds: [setId], overrides: { models: [switched] } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ error: string }>().error).toContain("secretRef");
    const unknown = await call(context, "POST", "/api/replay/estimate", builder.cookie, { datasetIds: [setId], overrides: { models: [{ ...switched, secretRef: { secretId: "sec_missing" } }] } });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json<{ error: string }>().error).toContain("sec_missing");
    const other = await context.secretService.createSecret({ name: "Anthropic key", provider: "anthropic", value: "sk-ant-other-0123456789abcdef" });
    expect((await call(context, "POST", "/api/replay/estimate", builder.cookie, { datasetIds: [setId], overrides: { models: [{ ...switched, secretRef: { secretId: other.secretId } }] } })).statusCode).toBe(200);
    // A model change on the same provider keeps the node's secret, with no secretRef needed.
    expect((await call(context, "POST", "/api/replay/estimate", builder.cookie, { datasetIds: [setId], overrides: { models: [{ nodeId: "model", model: "gpt-5-mini" }] } })).statusCode).toBe(200);
    expect(secret.secretId).toBeTruthy();
  }, 60_000);

  it("shows model tape bodies and the memory seed to editors only; export needs workflow:write (L5)", async () => {
    const model = await startRecordingModel();
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    await context.store.upsertProject({ id: "team", name: "Team" });
    const secret = await context.secretService.createSecret({ name: "Model key", provider: "openai", value: MODEL_KEY });
    await context.store.upsertWorkflow(agentWorkflow(model.baseUrl, secret.secretId, "team", "wf-team-agent"));
    const run = await call(context, "POST", "/api/workflows/wf-team-agent/execute", admin.cookie, { record: true });
    const cassetteId = run.json<{ mcpCassette?: { id: string } }>().mcpCassette!.id;
    const full = (await call(context, "GET", `/api/mcp/cassettes/${cassetteId}`, builder.cookie)).json<{ cassette: { cassette: { models: { entries: Array<Record<string, unknown>> }; omitted?: unknown } } }>().cassette.cassette;
    expect(full.models.entries[0]!.request).toBeTruthy();
    expect(full.omitted).toBeUndefined();

    await context.store.upsertCustomRole({ id: "run-only", projectId: "team", name: "Run only", permissions: ["workflow:read", "workflow:execute"] });
    await context.store.upsertProjectRole({ userId: builder.id, projectId: "team", role: "custom", customRoleId: "run-only" });
    const limited = await call(context, "GET", `/api/mcp/cassettes/${cassetteId}`, builder.cookie);
    expect(limited.statusCode).toBe(200);
    const view = limited.json<{ cassette: { cassette: { models: { entries: Array<Record<string, unknown>> }; memorySeed?: unknown; omitted?: { modelTapeBodies: boolean } } } }>().cassette.cassette;
    expect(view.models.entries).toHaveLength(1);
    expect(view.models.entries[0]).toMatchObject({ providerId: "openai", model: "gpt-4o-mini" });
    expect(view.models.entries[0]!.request).toBeUndefined();
    expect(view.models.entries[0]!.response).toBeUndefined();
    expect(view.memorySeed).toBeUndefined();
    expect(view.omitted).toMatchObject({ modelTapeBodies: true });
    expect(limited.body).not.toContain("Say hi");
    expect((await call(context, "GET", `/api/mcp/cassettes/${cassetteId}/export`, builder.cookie)).statusCode).toBe(403);
    expect((await call(context, "GET", `/api/mcp/cassettes/${cassetteId}/export`, admin.cookie)).statusCode).toBe(200);
  }, 60_000);

  it("caps an inline candidate at 2 MiB, and cuts a model tape that does not fit the golden run's size limit (L6)", async () => {
    const model = await startRecordingModel({ contentBytes: 12_000 });
    const context = await createTestContext({ REPLAY_RECORDING_MAX_BYTES: "16384" });
    const builder = await login(context, "builder");
    const secret = await context.secretService.createSecret({ name: "Model key", provider: "openai", value: MODEL_KEY });
    await context.store.upsertWorkflow(agentWorkflow(model.baseUrl, secret.secretId));
    const recordings = await goldenRuns(context, builder.cookie, "wf-cand", 1);
    expect(recordings[0]!.truncated).toBe(true);
    const stored = (await context.store.getReplayRecording(recordings[0]!.id))!;
    expect(stored.modelTape).toMatchObject({ truncated: true, entries: [] });
    expect(stored.bytes).toBeLessThanOrEqual(16384);
    const setId = await goldenSet(context, builder.cookie, "wf-cand", recordings);
    const job = await runJob(context, builder.cookie, { datasetIds: [setId], models: "replay" });
    expect(job.summary).toMatchObject({ error: 1 });
    const detail = await caseDetail(context, builder.cookie, job.id, job.results[0]!.id);
    expect(detail.replay!.diff.health.find((warning) => warning.kind === "model_unmatched")!.message).toContain("cut to fit");

    const big = agentWorkflow(model.baseUrl, secret.secretId) as Workflow & { description?: string };
    big.description = "x".repeat(2 * 1024 * 1024 + 10);
    const tooBig = await call(context, "POST", "/api/replay/estimate", builder.cookie, { datasetIds: [setId], workflow: big as unknown as Record<string, unknown> });
    expect(tooBig.statusCode).toBe(400);
    expect(tooBig.json<{ error: string }>().error).toContain("2 MiB");
  }, 60_000);

  it("answers read-only tools live on a live_read_only server only when an admin marked them read-only (L1, L2, L9)", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const serverId = await registerMockServer(context, admin.cookie);
    await context.store.upsertWorkflow(clockWorkflow(serverId));
    const setId = await goldenSet(context, builder.cookie, "wf-clock", await goldenRuns(context, builder.cookie, "wf-clock", 1));
    const body = { datasetIds: [setId], overrides: { mcpServers: { [serverId]: "live_read_only" } } };
    // The mock server annotates get_current_time readOnlyHint: true. That claim alone keeps it on the cassette.
    const annotatedOnly = await runJob(context, builder.cookie, body);
    expect(annotatedOnly.summary).toMatchObject({ total: 1, pass: 1 });
    const first = await caseDetail(context, builder.cookie, annotatedOnly.id, annotatedOnly.results[0]!.id);
    expect(first.replay!.diff.health.map((warning) => warning.kind)).not.toContain("mcp_live_read");

    await context.store.setMcpToolClassification({ registryServerId: serverId, toolName: "get_current_time", readOnly: true, setBy: admin.id });
    const marked = await runJob(context, builder.cookie, body);
    const second = await caseDetail(context, builder.cookie, marked.id, marked.results[0]!.id);
    expect(second.replay!.diff.health.map((warning) => warning.kind)).toContain("mcp_live_read");
    expect(marked.candidate!.releaseEligible).toBe(false);
  }, 60_000);

  it("seeds a replay's session memory from the golden run: the agent reads the recorded history (L9)", async () => {
    const model = await startRecordingModel();
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const secret = await context.secretService.createSecret({ name: "Model key", provider: "openai", value: MODEL_KEY });
    const workflow = agentWorkflow(model.baseUrl, secret.secretId);
    workflow.nodes.push({ id: "memory", type: "local_memory", name: "Memory", position: { x: 300, y: 160 }, config: { namespace: "seed-mem", sessionIdTemplate: "{{session_id}}" } } as Workflow["nodes"][number]);
    workflow.edges.push({ id: "e4", source: "agent_1", sourceHandle: "memory", target: "memory" });
    await context.store.upsertWorkflow(workflow);
    // A first run fills the session; the recorded second run starts from it.
    expect((await call(context, "POST", "/api/workflows/wf-cand/execute", builder.cookie, { session_id: "s-1" })).statusCode).toBe(200);
    const recordings = await goldenRuns(context, builder.cookie, "wf-cand", 1, { record: true, session_id: "s-1" });
    expect(recordings[0]!.capabilities.memory).toBe("seeded");
    const recordedMessages = model.bodies[1]!.messages.length;
    expect(recordedMessages).toBeGreaterThan(model.bodies[0]!.messages.length);
    const memoryBefore = await context.store.loadSessionMemory(projectSessionNamespace("default", "seed-mem"), "s-1");
    expect(memoryBefore.length).toBeGreaterThan(0);

    const setId = await goldenSet(context, builder.cookie, "wf-cand", recordings);
    const job = await runJob(context, builder.cookie, { datasetIds: [setId] });
    expect(job.summary, job.error ?? "").toMatchObject({ total: 1, pass: 1 });
    // The replay's model call carried the seeded history, as the recorded run's did.
    expect(model.bodies.at(-1)!.messages.length).toBe(recordedMessages);
    // Nothing the replay did reached the real session.
    expect(await context.store.loadSessionMemory(projectSessionNamespace("default", "seed-mem"), "s-1")).toEqual(memoryBefore);
  }, 60_000);

  it("leaves a live run's answer and retries unchanged when its model calls are recorded (L9)", async () => {
    const model = await startRecordingModel({ failFirst: 1, answer: "steady" });
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const secret = await context.secretService.createSecret({ name: "Model key", provider: "openai", value: MODEL_KEY });
    const workflow = agentWorkflow(model.baseUrl, secret.secretId);
    workflow.nodes = workflow.nodes.map((node) =>
      node.id === "model" ? ({ ...node, config: { provider: { providerId: "openai", model: "gpt-4o-mini", baseUrl: model.baseUrl, secretRef: { secretId: secret.secretId }, extra: { maxRetries: 1 } } } } as typeof node) : node
    );
    await context.store.upsertWorkflow(workflow);
    const recorded = await call(context, "POST", "/api/workflows/wf-cand/execute", builder.cookie, { record: true });
    expect(recorded.json<{ status: string }>().status).toBe("success");
    // The failed first call was retried, as in an unrecorded run.
    expect(model.bodies).toHaveLength(2);
    const plain = await call(context, "POST", "/api/workflows/wf-cand/execute", builder.cookie, {});
    expect(plain.json<{ output: unknown }>().output).toEqual(recorded.json<{ output: unknown }>().output);
    expect(JSON.stringify(recorded.json<{ output: unknown }>().output)).toContain("steady");
  }, 60_000);
});
