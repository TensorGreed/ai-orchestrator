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
import { SqliteStore } from "./db/database.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";

interface TestContext {
  app: FastifyInstance;
  store: SqliteStore;
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
  const store = await SqliteStore.create(dbPath);
  store.ensureDefaultProject();
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
  const app = createApp(config, store, secretService, authService);
  await app.ready();
  const context = { app, store, authService, secretService, config, tempDir, dbPath };
  if (!existing) contexts.push(context);
  return context;
}

async function closeContext(context: TestContext): Promise<void> {
  await context.app.close();
  try {
    context.store.close();
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
  const user = context.authService.register({ email, password, role });
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

async function agentSetup(answer?: (model: string) => string, golden = 2, body?: Record<string, unknown>) {
  const model = await startModel(answer);
  const context = await createTestContext({ REPLAY_CONCURRENCY: "2" });
  const builder = await login(context, "builder");
  const secret = context.secretService.createSecret({ name: "Model key", provider: "openai", value: MODEL_KEY });
  context.store.upsertWorkflow(agentWorkflow(model.baseUrl, secret.secretId));
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
    context.store.upsertWorkflow(guardWorkflow());
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
    context.store.upsertWorkflow(writeWorkflow(counter.base));
    const recordings = await goldenRuns(context, builder.cookie, "wf-write", 2);
    const setId = await goldenSet(context, builder.cookie, "wf-write", recordings);
    expect(counter.count("/slack")).toBe(2);
    const before = context.store.getWorkflow("wf-write");

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
    expect(context.store.getWorkflow("wf-write")).toEqual(before);
    expect(counter.count("/slack")).toBe(2);

    // A user who may run the workflow but not edit it: plain jobs only.
    context.store.upsertProject({ id: "team", name: "Team" });
    const shared = { ...writeWorkflow(counter.base), id: "wf-team", projectId: "team" };
    context.store.upsertWorkflow(shared);
    const teamGolden = await goldenRuns(context, admin.cookie, "wf-team", 1);
    const teamSet = await goldenSet(context, admin.cookie, "wf-team", teamGolden);
    // In the team project the builder may read and run workflows, not edit them.
    context.store.upsertCustomRole({ id: "run-only", projectId: "team", name: "Run only", permissions: ["workflow:read", "workflow:execute"] });
    context.store.upsertProjectRole({ userId: builder.id, projectId: "team", role: "custom", customRoleId: "run-only" });
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
