/**
 * Phase 15.2 — golden sets and replay jobs over the API: a set of ten golden
 * runs replayed in the background (202, progress, per-case scores and
 * diffs), an LLM judge that authenticates with a secret from SecretService,
 * regressions, project scoping and RBAC, cancel, server-sent progress, eval
 * runs on the same runner, interrupted-on-restart and migration 31.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { EvalCaseDetail, EvalCaseResult, EvalRunView, ReplayRecordingSummary, Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import { SqliteStore } from "./db/database.js";
import { MIGRATIONS } from "./db/migrations.js";
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
const JUDGE_KEY = "sk-judge-REPLAY-JOB-key-9f8e7d6c5b4a39281706";
const MASTER_KEY = crypto.randomBytes(32).toString("base64");

async function createTestContext(overrides: Record<string, string> = {}, existing?: { tempDir: string; dbPath: string }): Promise<TestContext> {
  const tempDir = existing?.tempDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "ao-replay-jobs-"));
  const dbPath = existing?.dbPath ?? path.join(tempDir, "orchestrator.db");
  const store = await SqliteStore.create(dbPath);
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

const call = (context: TestContext, method: "GET" | "POST" | "DELETE", url: string, cookie: string, payload?: unknown) =>
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

/** An OpenAI-style endpoint that answers `content` after `delayMs` and records the bearer token of every call. */
async function startModel(content: string, delayMs = 0) {
  const auth: string[] = [];
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      auth.push(String(request.headers.authorization ?? ""));
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 400, completion_tokens: 20 } }));
      }, delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to bind fake model");
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, auth };
}

/** start → label → Slack → output. */
function setWorkflow(base: string, answer = "v1", projectId = "default"): Workflow {
  return {
    id: "wf-set",
    name: "Golden set",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId,
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

/** start → agent (fake model) → output. */
function agentWorkflow(baseUrl: string, secretId: string): Workflow {
  return {
    id: "wf-agent",
    name: "Agent",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
      { id: "agent", type: "agent_orchestrator", name: "Agent", position: { x: 150, y: 0 }, config: { systemPromptTemplate: "Be brief.", userPromptTemplate: "Say hi", maxIterations: 1, toolCallingEnabled: false } },
      { id: "model", type: "llm_call", name: "Model", position: { x: 150, y: 160 }, config: { provider: { providerId: "openai", model: "gpt-4o-mini", baseUrl, secretRef: { secretId }, extra: { maxRetries: 0 } } } },
      { id: "output", type: "output", name: "Output", position: { x: 300, y: 0 }, config: {} }
    ],
    edges: [
      { id: "e1", source: "start", target: "agent" },
      { id: "e2", source: "agent", sourceHandle: "chat_model", target: "model" },
      { id: "e3", source: "agent", target: "output" }
    ]
  } as Workflow;
}

async function goldenRuns(context: TestContext, cookie: string, workflowId: string, count: number): Promise<ReplayRecordingSummary[]> {
  const out: ReplayRecordingSummary[] = [];
  for (let index = 0; index < count; index += 1) {
    const run = await call(context, "POST", `/api/workflows/${workflowId}/execute`, cookie, {});
    expect(run.statusCode, run.body).toBe(200);
    const saved = await call(context, "POST", "/api/replay/recordings", cookie, { executionId: run.json<{ executionId: string }>().executionId, name: `Golden ${index + 1}` });
    expect(saved.statusCode, saved.body).toBe(201);
    out.push(saved.json<{ recording: ReplayRecordingSummary }>().recording);
  }
  return out;
}

async function goldenSet(context: TestContext, cookie: string, workflowId: string, recordings: ReplayRecordingSummary[]): Promise<string> {
  const created = await call(context, "POST", "/api/eval/datasets", cookie, { name: "Regression suite", workflowId });
  expect(created.statusCode, created.body).toBe(200);
  const set = created.json<{ dataset: { id: string; workflowId: string; projectId: string } }>().dataset;
  expect(set).toMatchObject({ workflowId, projectId: "default" });
  for (const recording of recordings) {
    const added = await call(context, "POST", `/api/eval/datasets/${set.id}/recordings`, cookie, { recordingId: recording.id });
    expect(added.statusCode, added.body).toBe(201);
  }
  return set.id;
}

async function waitForJob(context: TestContext, cookie: string, runId: string, timeoutMs = 20_000): Promise<EvalRunView & { results: EvalCaseResult[] }> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const response = await call(context, "GET", `/api/replay/runs/${runId}`, cookie);
    expect(response.statusCode, response.body).toBe(200);
    const run = response.json<{ run: EvalRunView & { results: EvalCaseResult[] } }>().run;
    if (!["queued", "running"].includes(run.status)) return run;
    if (Date.now() > until) throw new Error(`Job ${runId} still ${run.status}`);
    await sleep(50);
  }
}

describe("replay jobs over golden sets", () => {
  it("replays ten golden runs in the background, scores each one and judges with a secret from SecretService", async () => {
    const judge = await startModel('{"score": 0.9, "reason": "answers the question"}');
    const context = await createTestContext({ EVAL_JUDGE_ENABLED: "true", EVAL_JUDGE_BASE_URL: judge.baseUrl, REPLAY_CONCURRENCY: "2" });
    const builder = await login(context, "builder");
    const viewer = await login(context, "viewer");
    const counter = await startCounter();
    await context.store.upsertWorkflow(setWorkflow(counter.base));
    const recordings = await goldenRuns(context, builder.cookie, "wf-set", 10);
    expect(counter.count("/slack")).toBe(10);

    // Viewers read golden sets but cannot make or change them.
    expect((await call(context, "POST", "/api/eval/datasets", viewer.cookie, { name: "x", workflowId: "wf-set" })).statusCode).toBe(403);
    const setId = await goldenSet(context, builder.cookie, "wf-set", recordings);
    expect((await call(context, "POST", `/api/eval/datasets/${setId}/recordings`, builder.cookie, { recordingId: recordings[0]!.id })).statusCode).toBe(409);
    expect((await call(context, "POST", `/api/eval/datasets/${setId}/recordings`, builder.cookie, { recordingId: "rec_missing" })).statusCode).toBe(404);
    expect((await call(context, "POST", `/api/eval/datasets/${setId}/recordings`, viewer.cookie, { recordingId: recordings[0]!.id })).statusCode).toBe(403);
    const sets = (await call(context, "GET", "/api/eval/datasets?workflowId=wf-set", viewer.cookie)).json<{ datasets: Array<{ id: string; goldenRunCount: number }> }>().datasets;
    expect(sets).toEqual([expect.objectContaining({ id: setId, goldenRunCount: 10 })]);
    const fixtures = (await call(context, "GET", `/api/eval/datasets/${setId}/fixtures`, viewer.cookie)).json<{ fixtures: Array<{ recordingId: string; expected: unknown }> }>().fixtures;
    expect(fixtures).toHaveLength(10);
    expect(fixtures.every((fixture) => fixture.recordingId && fixture.expected === null)).toBe(true);

    const secret = await context.secretService.createSecret({ name: "Judge key", provider: "openai", value: JUDGE_KEY });
    const scorers = [
      { type: "status" },
      { type: "json_equal" },
      { type: "budget", maxTokens: 10 },
      { type: "llm_judge", rubric: "The output states an answer.", providerId: "openai", model: "gpt-4o-mini", secretRef: { secretId: secret.secretId } }
    ];
    // A secret that does not exist is refused before anything runs; so are viewers.
    expect((await call(context, "POST", "/api/replay/runs", builder.cookie, { datasetIds: [setId], scorers: [{ type: "llm_judge", rubric: "r", providerId: "openai", secretRef: { secretId: "missing" } }] })).statusCode).toBe(400);
    expect((await call(context, "POST", "/api/replay/runs", viewer.cookie, { datasetIds: [setId] })).statusCode).toBe(403);
    expect((await call(context, "POST", "/api/replay/runs", builder.cookie, { datasetIds: [setId], live: true })).statusCode).toBe(400);

    const started = await call(context, "POST", "/api/replay/runs", builder.cookie, { datasetIds: [setId], scorers });
    expect(started.statusCode, started.body).toBe(202);
    const queued = started.json<{ run: EvalRunView }>().run;
    expect(queued).toMatchObject({ kind: "replay", workflowId: "wf-set", datasetIds: [setId], candidate: { kind: "draft" }, options: { mcpMode: "strict", maxCostUsd: 5 } });
    expect(["queued", "running"]).toContain(queued.status);
    expect(queued.candidate!.workflowHash).toMatch(/^[0-9a-f]{64}$/);

    const job = await waitForJob(context, viewer.cookie, queued.id);
    expect(job.status, job.error ?? "").toBe("completed");
    expect(job.summary).toMatchObject({ total: 10, pass: 10, fail: 0, error: 0, passRate: 1 });
    expect(job.progress).toMatchObject({ total: 10, done: 10, running: 0, pass: 10 });
    expect(job.summary!.judgeCostUsd).toBeGreaterThan(0);
    expect(job.summary!.costUsd).toBeGreaterThanOrEqual(job.summary!.judgeCostUsd!);
    // Nothing external ran: Slack was answered from the golden runs.
    expect(counter.count("/slack")).toBe(10);
    // The judge was called once per case with the key from SecretService.
    expect(judge.auth).toHaveLength(10);
    expect(judge.auth.every((header) => header === `Bearer ${JUDGE_KEY}`)).toBe(true);

    const first = job.results[0]!;
    expect(first).toMatchObject({ status: "pass", verdict: "pass" });
    expect(first.score!.details.map((detail) => [detail.type, detail.pass])).toEqual([["status", true], ["json_equal", true], ["budget", true], ["llm_judge", true]]);
    expect(first.score!.details[3]!.reason).toContain("answers the question");
    const caseDetail = await call(context, "GET", `/api/replay/runs/${job.id}/results/${first.id}`, viewer.cookie);
    expect(caseDetail.statusCode).toBe(200);
    const detail = caseDetail.json<{ result: EvalCaseDetail }>().result;
    expect(detail.replay).toMatchObject({ verdict: "pass", diff: { output: { equal: true }, status: { baseline: "success", candidate: "success" } } });
    expect(detail.replay!.recordingId).toBe(first.recordingId);
    expect((await call(context, "GET", `/api/replay/runs/${job.id}/results/res_missing`, viewer.cookie)).statusCode).toBe(404);

    // Lists, and the finished job's event stream.
    const listed = (await call(context, "GET", "/api/replay/runs?workflowId=wf-set", viewer.cookie)).json<{ runs: EvalRunView[] }>().runs;
    expect(listed.map((run) => run.id)).toEqual([job.id]);
    const events = await call(context, "GET", `/api/eval/runs/${job.id}/events`, viewer.cookie);
    expect(events.headers["content-type"]).toContain("text/event-stream");
    expect(events.body).toContain("event: done");
    expect(events.body).toContain('"status":"completed"');
    expect((await call(context, "POST", `/api/replay/runs/${job.id}/cancel`, builder.cookie)).statusCode).toBe(409);
    expect((await call(context, "POST", `/api/replay/runs/${job.id}/cancel`, viewer.cookie)).statusCode).toBe(403);

    // Every judge call is a usage event of the workflow's project.
    const usage = new Database(context.dbPath, { readonly: true });
    try {
      const rows = usage.prepare("SELECT * FROM usage_events WHERE trigger_type = 'eval_judge'").all() as Array<{ project_id: string; workflow_id: string; user_email: string; llm_call_count: number; cost_usd: number }>;
      expect(rows).toHaveLength(10);
      expect(rows[0]).toMatchObject({ project_id: "default", workflow_id: "wf-set", user_email: "builder@example.com", llm_call_count: 1 });
      expect(rows[0]!.cost_usd).toBeGreaterThan(0);
    } finally {
      usage.close();
    }

    // The judge's key appears nowhere in what was stored.
    const db = new Database(context.dbPath, { readonly: true });
    try {
      const stored = JSON.stringify([db.prepare("SELECT * FROM eval_runs").all(), db.prepare("SELECT * FROM eval_results").all(), db.prepare("SELECT * FROM eval_fixtures").all()]);
      expect(stored).not.toContain(JUDGE_KEY);
      expect(stored).toContain(secret.secretId);
    } finally {
      db.close();
    }
  }, 60_000);

  it("fails the cases a regressing draft breaks, and keeps other projects out", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const outsider = await login(context, "builder", "outsider");
    const counter = await startCounter();
    await context.store.upsertWorkflow(setWorkflow(counter.base));
    const recordings = await goldenRuns(context, builder.cookie, "wf-set", 3);
    const setId = await goldenSet(context, builder.cookie, "wf-set", recordings);
    // A hand-written case in the set is skipped by replay jobs.
    expect((await call(context, "POST", `/api/eval/datasets/${setId}/fixtures`, builder.cookie, { name: "hand-written", input: { q: 1 }, scorers: [{ type: "nope" }] })).statusCode).toBe(400);
    expect((await call(context, "POST", `/api/eval/datasets/${setId}/fixtures`, builder.cookie, { name: "hand-written", input: { q: 1 } })).statusCode).toBe(200);

    await context.store.upsertWorkflow(setWorkflow(counter.base, "v2"));
    const started = await call(context, "POST", "/api/replay/runs", builder.cookie, { datasetIds: [setId] });
    expect(started.statusCode, started.body).toBe(202);
    const job = await waitForJob(context, builder.cookie, started.json<{ run: EvalRunView }>().run.id);
    expect(job.summary).toMatchObject({ total: 4, pass: 0, fail: 3, error: 0, skipped: 1 });
    const failed = job.results.find((result) => result.status === "fail")!;
    expect(failed.score!.details.find((detail) => detail.type === "json_equal")!.reason).toContain("answer v1");
    expect(job.results.find((result) => result.status === "skipped")!.fixtureName).toBe("hand-written");

    // A builder locked out of the workflow's project sees none of it.
    await context.store.upsertProject({ id: "hidden", name: "Hidden" });
    await context.store.upsertCustomRole({ id: "none-hidden", projectId: "hidden", name: "No access", permissions: [] });
    await context.store.upsertProjectRole({ userId: outsider.id, projectId: "hidden", role: "custom", customRoleId: "none-hidden" });
    await context.store.upsertWorkflow(setWorkflow(counter.base, "v2", "hidden"));
    // Ids the user cannot read answer 404, the same as ids that do not exist.
    for (const [method, url, payload] of [
      ["GET", `/api/replay/runs/${job.id}`],
      ["GET", `/api/replay/runs/${job.id}/results/${failed.id}`],
      ["GET", `/api/eval/runs/${job.id}`],
      ["GET", `/api/eval/runs/${job.id}/events`],
      ["POST", `/api/replay/runs/${job.id}/cancel`],
      ["GET", `/api/eval/datasets/${setId}/fixtures`],
      ["POST", `/api/eval/datasets/${setId}/fixtures`, { name: "x", input: {} }],
      ["POST", "/api/replay/runs", { datasetIds: [setId] }],
      ["DELETE", `/api/eval/datasets/${setId}`],
      ["GET", "/api/replay/runs?workflowId=wf-set"]
    ] as Array<["GET" | "POST" | "DELETE", string, unknown?]>) {
      const response = await call(context, method, url, outsider.cookie, payload);
      expect(response.statusCode, `${method} ${url}`).toBe(404);
      // A foreign event stream never starts: no event is written.
      expect(response.body).not.toContain("event:");
    }
    expect((await call(context, "GET", "/api/replay/runs", outsider.cookie)).json<{ runs: EvalRunView[] }>().runs).toEqual([]);
    expect((await call(context, "GET", "/api/eval/runs", outsider.cookie)).json<{ runs: EvalRunView[] }>().runs).toEqual([]);
    expect((await call(context, "GET", "/api/eval/datasets", outsider.cookie)).json<{ datasets: unknown[] }>().datasets).toEqual([]);
    expect((await call(context, "GET", `/api/replay/runs/${job.id}`, admin.cookie)).statusCode).toBe(200);
  }, 60_000);

  it("cancels a running job: queued cases never start", async () => {
    const model = await startModel("hello", 400);
    const context = await createTestContext({ REPLAY_CONCURRENCY: "1" });
    const builder = await login(context, "builder");
    const secret = await context.secretService.createSecret({ name: "Model key", provider: "openai", value: JUDGE_KEY });
    await context.store.upsertWorkflow(agentWorkflow(model.baseUrl, secret.secretId));
    const recordings = await goldenRuns(context, builder.cookie, "wf-agent", 3);
    const setId = await goldenSet(context, builder.cookie, "wf-agent", recordings);
    const before = model.auth.length;

    const started = await call(context, "POST", "/api/replay/runs", builder.cookie, { datasetIds: [setId] });
    expect(started.statusCode).toBe(202);
    const runId = started.json<{ run: EvalRunView }>().run.id;
    await sleep(100);
    const canceled = await call(context, "POST", `/api/replay/runs/${runId}/cancel`, builder.cookie);
    expect(canceled.statusCode, canceled.body).toBe(200);
    expect(canceled.json<{ run: EvalRunView }>().run.status).toBe("canceled");
    await sleep(900);
    const job = await waitForJob(context, builder.cookie, runId);
    expect(job.status).toBe("canceled");
    expect(job.results.length).toBeLessThanOrEqual(1);
    expect(model.auth.length - before).toBeLessThanOrEqual(1);
  }, 60_000);
});

describe("eval runs on the background runner", () => {
  it("answers 202, streams progress, and keeps ?wait=true", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const counter = await startCounter();
    await context.store.upsertWorkflow(setWorkflow(counter.base));
    const dataset = (await call(context, "POST", "/api/eval/datasets", builder.cookie, { name: "Plain" })).json<{ dataset: { id: string } }>().dataset;
    for (const name of ["a", "b"]) {
      expect((await call(context, "POST", `/api/eval/datasets/${dataset.id}/fixtures`, builder.cookie, { name, input: { q: name }, scorers: [{ type: "contains", needle: "answer v1" }, { type: "status" }, { type: "tool_sequence", mode: "set" }] })).statusCode).toBe(200);
    }
    const queued = await call(context, "POST", "/api/eval/runs", builder.cookie, { datasetId: dataset.id, workflowId: "wf-set" });
    expect(queued.statusCode, queued.body).toBe(202);
    const run = queued.json<{ run: EvalRunView; runId: string }>();
    expect(run.runId).toBe(run.run.id);
    expect(run.run.kind).toBe("eval");
    const stream = await call(context, "GET", `/api/eval/runs/${run.runId}/events`, builder.cookie);
    expect(stream.body).toContain("event: done");
    const finished = (await call(context, "GET", `/api/eval/runs/${run.runId}`, builder.cookie)).json<EvalRunView & { results: EvalCaseResult[] }>();
    expect(finished.status).toBe("completed");
    // `status` passes from the run's facts; `tool_sequence` has no golden run to compare with.
    expect(finished.results[0]!.score!.details.map((detail) => detail.pass)).toEqual([true, true, false]);

    const waited = await call(context, "POST", "/api/eval/runs?wait=true", builder.cookie, { datasetId: dataset.id, workflowId: "wf-set", scorers: [{ type: "contains", needle: "answer v1" }] });
    expect(waited.statusCode).toBe(200);
    expect(waited.headers.deprecation).toBe("true");
    expect(waited.json<{ ok: boolean; summary: { total: number } }>()).toMatchObject({ ok: true, summary: { total: 2 } });
    expect((await call(context, "POST", "/api/eval/runs", builder.cookie, { datasetId: "ds_missing", workflowId: "wf-set" })).statusCode).toBe(404);
    expect((await call(context, "POST", "/api/eval/runs?wait=true", builder.cookie, { datasetId: dataset.id, workflowId: "wf-missing" })).statusCode).toBe(404);
  }, 30_000);

  it("marks runs left running by a stopped server as interrupted on the next boot", async () => {
    const first = await createTestContext();
    await first.store.createEvalRun({ id: "run_left", datasetId: "ds", workflowId: "wf-set", kind: "replay", status: "running", progress: { updatedAt: new Date().toISOString() } });
    await closeContext(first);
    contexts.splice(contexts.indexOf(first), 1);
    const second = await createTestContext({}, { tempDir: first.tempDir, dbPath: first.dbPath });
    try {
      expect(await second.store.getEvalRun("run_left")).toMatchObject({ status: "interrupted", error: expect.stringContaining("server stopped") });
    } finally {
      await closeContext(second);
      fs.rmSync(first.tempDir, { recursive: true, force: true });
    }
  });
});

describe("review fixes over the API", () => {
  const hiddenProject = async (context: TestContext) => {
    await context.store.upsertProject({ id: "hidden", name: "Hidden" });
    return await context.secretService.createSecret({ name: "Hidden key", provider: "openai", value: JUDGE_KEY, projectId: "hidden" });
  };

  it("refuses a judge secret from another project on fixture add and on eval run start, also for cases stored before the check", async () => {
    const judge = await startModel('{"score": 1}');
    const context = await createTestContext({ EVAL_JUDGE_ENABLED: "true", EVAL_JUDGE_BASE_URL: judge.baseUrl });
    const builder = await login(context, "builder");
    const counter = await startCounter();
    await context.store.upsertWorkflow(setWorkflow(counter.base));
    const foreign = await hiddenProject(context);
    const judgeScorer = { type: "llm_judge", rubric: "r", providerId: "openai", secretRef: { secretId: foreign.secretId } };
    // A project-only dataset (no workflow) is checked against its project too.
    const dataset = (await call(context, "POST", "/api/eval/datasets", builder.cookie, { name: "Plain", projectId: "default" })).json<{ dataset: { id: string } }>().dataset;
    const added = await call(context, "POST", `/api/eval/datasets/${dataset.id}/fixtures`, builder.cookie, { name: "a", input: {}, scorers: [judgeScorer] });
    expect(added.statusCode, added.body).toBe(400);
    expect(added.json<{ error: string }>().error).toContain(foreign.secretId);
    // A case that already holds the secret (stored before this check existed) stops the run before anything runs.
    await context.store.createEvalFixture({ id: "fix_old", datasetId: dataset.id, name: "old", input: {}, scorers: [judgeScorer] });
    const started = await call(context, "POST", "/api/eval/runs", builder.cookie, { datasetId: dataset.id, workflowId: "wf-set" });
    expect(started.statusCode, started.body).toBe(400);
    expect(started.json<{ error: string }>().error).toContain(foreign.secretId);
    expect(judge.auth).toHaveLength(0);
    expect(counter.count("/slack")).toBe(0);
  }, 30_000);

  it("checks the judge's secret again for every call: a secret removed mid-run fails the later cases", async () => {
    const judge = await startModel('{"score": 1}', 300);
    const context = await createTestContext({ EVAL_JUDGE_ENABLED: "true", EVAL_JUDGE_BASE_URL: judge.baseUrl, REPLAY_CONCURRENCY: "1" });
    const builder = await login(context, "builder");
    const counter = await startCounter();
    await context.store.upsertWorkflow(setWorkflow(counter.base));
    const setId = await goldenSet(context, builder.cookie, "wf-set", await goldenRuns(context, builder.cookie, "wf-set", 3));
    const secret = await context.secretService.createSecret({ name: "Judge key", provider: "openai", value: JUDGE_KEY });
    const started = await call(context, "POST", "/api/replay/runs", builder.cookie, { datasetIds: [setId], scorers: [{ type: "llm_judge", rubric: "r", providerId: "openai", secretRef: { secretId: secret.secretId } }] });
    expect(started.statusCode, started.body).toBe(202);
    const until = Date.now() + 10_000;
    while (judge.auth.length === 0 && Date.now() < until) await sleep(10);
    await context.secretService.deleteSecret(secret.secretId);
    const job = await waitForJob(context, builder.cookie, started.json<{ run: EvalRunView }>().run.id);
    expect(job.summary).toMatchObject({ pass: 1, fail: 2 });
    const failed = job.results.filter((result) => result.status === "fail");
    for (const result of failed) expect(result.score!.details[0]!.reason).toContain("cannot be used by the user who started this run");
    expect(judge.auth).toHaveLength(1);
  }, 30_000);

  it("never uses the server's provider keys for a judge without a secretRef unless the operator allows it, and EVAL_JUDGE_ENABLED=false stops every judge", async () => {
    const judge = await startModel('{"score": 1}');
    for (const [overrides, expected] of [
      [{ EVAL_JUDGE_ENABLED: "true" }, "has no secretRef"],
      [{ EVAL_JUDGE_ENABLED: "false" }, "turned off"]
    ] as const) {
      const context = await createTestContext({ ...overrides, EVAL_JUDGE_BASE_URL: judge.baseUrl, OPENAI_API_KEY: "sk-env-key-should-never-be-sent-0000" });
      const builder = await login(context, "builder");
      const counter = await startCounter();
      await context.store.upsertWorkflow(setWorkflow(counter.base));
      const dataset = (await call(context, "POST", "/api/eval/datasets", builder.cookie, { name: "Plain" })).json<{ dataset: { id: string } }>().dataset;
      expect((await call(context, "POST", `/api/eval/datasets/${dataset.id}/fixtures`, builder.cookie, { name: "a", input: {}, scorers: [{ type: "llm_judge", rubric: "r", providerId: "openai" }] })).statusCode).toBe(200);
      const waited = await call(context, "POST", "/api/eval/runs?wait=true", builder.cookie, { datasetId: dataset.id, workflowId: "wf-set" });
      expect(waited.statusCode, waited.body).toBe(200);
      const run = (await call(context, "GET", `/api/eval/runs/${waited.json<{ runId: string }>().runId}`, builder.cookie)).json<EvalRunView & { results: EvalCaseResult[] }>();
      expect(run.results[0]!.score!.details[0]).toMatchObject({ pass: false, reason: expect.stringContaining(expected) });
    }
    expect(judge.auth).toHaveLength(0);
  }, 30_000);

  it("streams progress before done for a running job", async () => {
    const model = await startModel("hello", 150);
    const context = await createTestContext({ REPLAY_CONCURRENCY: "1" });
    const builder = await login(context, "builder");
    const secret = await context.secretService.createSecret({ name: "Model key", provider: "openai", value: JUDGE_KEY });
    await context.store.upsertWorkflow(agentWorkflow(model.baseUrl, secret.secretId));
    const setId = await goldenSet(context, builder.cookie, "wf-agent", await goldenRuns(context, builder.cookie, "wf-agent", 2));
    const started = await call(context, "POST", "/api/replay/runs", builder.cookie, { datasetIds: [setId] });
    const stream = await call(context, "GET", `/api/eval/runs/${started.json<{ run: EvalRunView }>().run.id}/events`, builder.cookie);
    const progress = stream.body.indexOf("event: progress");
    expect(progress).toBeGreaterThan(-1);
    expect(stream.body.indexOf("event: done")).toBeGreaterThan(progress);
    expect(stream.body.match(/event: progress/g)!.length).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it("keeps golden runs out of live eval runs, and other workflows' sets out of both", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const counter = await startCounter();
    await context.store.upsertWorkflow(setWorkflow(counter.base));
    await context.store.upsertWorkflow({ ...setWorkflow(counter.base), id: "wf-other", name: "Secret project name" });
    const setId = await goldenSet(context, builder.cookie, "wf-set", await goldenRuns(context, builder.cookie, "wf-set", 1));
    const before = counter.count("/slack");
    const live = await call(context, "POST", "/api/eval/runs", builder.cookie, { datasetId: setId, workflowId: "wf-set" });
    expect(live.statusCode).toBe(400);
    expect(live.json<{ error: string }>().error).toContain("replay job");
    expect((await call(context, "POST", "/api/eval/runs", builder.cookie, { datasetId: setId, workflowId: "wf-other" })).json<{ error: string }>().error).toContain("another workflow");
    expect(counter.count("/slack")).toBe(before);
    // A set of another workflow in a replay job is a 404 that names nothing.
    const otherSet = (await call(context, "POST", "/api/eval/datasets", builder.cookie, { name: "Other suite", workflowId: "wf-other" })).json<{ dataset: { id: string } }>().dataset;
    const mixed = await call(context, "POST", "/api/replay/runs", builder.cookie, { datasetIds: [setId, otherSet.id] });
    expect(mixed.statusCode).toBe(404);
    expect(mixed.body).not.toContain("Other suite");
    expect((await call(context, "POST", "/api/replay/runs", builder.cookie, { datasetIds: [setId, "ds_missing"] })).statusCode).toBe(404);
  }, 30_000);

  it("refuses to replay MCP answers from another project's cassette or eval run", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const counter = await startCounter();
    await context.store.upsertWorkflow(setWorkflow(counter.base));
    await context.store.upsertProject({ id: "hidden", name: "Hidden" });
    await context.store.upsertCustomRole({ id: "none-hidden", projectId: "hidden", name: "No access", permissions: [] });
    await context.store.upsertProjectRole({ userId: builder.id, projectId: "hidden", role: "custom", customRoleId: "none-hidden" });
    await context.store.upsertWorkflow({ ...setWorkflow(counter.base, "v1", "hidden"), id: "wf-hidden" });
    const cassette = await context.store.saveMcpCassette({
      id: "cas_hidden",
      executionId: null,
      workflowId: "wf-hidden",
      workflowName: "Hidden",
      projectId: "hidden",
      source: "manual",
      cassette: { format: "l2m.mcp-cassette", version: 1, recordedAt: new Date().toISOString(), servers: [], entries: [], truncated: false, bytes: 0, llm: "not_recorded" } as never,
      createdBy: null
    });
    await context.store.createEvalRun({ id: "run_hidden", datasetId: "ds_hidden", workflowId: "wf-hidden", status: "completed" });
    const dataset = (await call(context, "POST", "/api/eval/datasets", builder.cookie, { name: "Plain" })).json<{ dataset: { id: string } }>().dataset;
    await call(context, "POST", `/api/eval/datasets/${dataset.id}/fixtures`, builder.cookie, { name: "a", input: {} });
    expect((await call(context, "POST", "/api/eval/runs", builder.cookie, { datasetId: dataset.id, workflowId: "wf-set", replay: { cassetteId: cassette.id } })).statusCode).toBe(404);
    expect((await call(context, "POST", "/api/eval/runs", builder.cookie, { datasetId: dataset.id, workflowId: "wf-set", replay: { evalRunId: "run_hidden" } })).statusCode).toBe(404);
  }, 30_000);

  it("boots on a store without eval storage instead of crashing", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-replay-jobs-noeval-"));
    const real = await SqliteStore.create(path.join(tempDir, "orchestrator.db"));
    await real.ensureDefaultProject();
    const missing = new Set(["listEvalRuns", "pruneEvalRuns"]);
    const store = new Proxy(real, {
      get(target, key, receiver) {
        if (typeof key === "string" && missing.has(key)) return undefined;
        const value = Reflect.get(target, key, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    const config = parseConfig({ LOG_LEVEL: "warn", SEED_SAMPLE_WORKFLOWS: "false", SECRET_MASTER_KEY_BASE64: MASTER_KEY, COOKIE_SECURE: "false", RATE_LIMIT_ENABLED: "false", MCP_PROBE_INTERVAL_MS: "0", GIT_SYNC_WORKDIR: path.join(tempDir, "git") });
    const app = await createApp(config, store, new SecretService(store, config.SECRET_MASTER_KEY_BASE64), new AuthService(store, config.SESSION_TTL_HOURS));
    try {
      await app.ready();
      expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    } finally {
      await app.close();
      try {
        await real.close();
      } catch {
        // Closed by the app.
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("project authorization on golden sets, replay jobs and eval runs", () => {
  /** A user locked out of a project: a membership whose custom role grants nothing. */
  const lockOut = async (context: TestContext, userId: string, projectId: string) => {
    await context.store.upsertProject({ id: projectId, name: projectId });
    await context.store.upsertCustomRole({ id: `none-${projectId}`, projectId, name: "No access", permissions: [] });
    await context.store.upsertProjectRole({ userId, projectId, role: "custom", customRoleId: `none-${projectId}` });
  };

  /** start → HTTP request with a secret → output. */
  const secretWorkflow = (id: string, projectId: string, baseUrl: string, secretId: string): Workflow =>
    ({
      id,
      name: id,
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId,
      nodes: [
        { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
        { id: "req", type: "http_request", name: "Req", position: { x: 150, y: 0 }, config: { method: "GET", urlTemplate: `${baseUrl}/echo`, secretRef: { secretId } } },
        { id: "output", type: "output", name: "Output", position: { x: 300, y: 0 }, config: {} }
      ],
      edges: [
        { id: "e1", source: "start", target: "req" },
        { id: "e2", source: "req", target: "output" }
      ]
    }) as Workflow;

  const waitForEvalRun = async (context: TestContext, cookie: string, runId: string) => {
    const until = Date.now() + 20_000;
    for (;;) {
      const run = (await call(context, "GET", `/api/eval/runs/${runId}`, cookie)).json<EvalRunView & { results: EvalCaseResult[] }>();
      if (!["queued", "running"].includes(run.status)) return run;
      if (Date.now() > until) throw new Error(`Eval run ${runId} still ${run.status}`);
      await sleep(50);
    }
  };

  it("read-only project: golden sets and replay jobs are readable but every write and start answers 403", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const counter = await startCounter();
    await context.store.upsertProject({ id: "ro", name: "Read only" });
    await context.store.upsertProjectRole({ userId: builder.id, projectId: "ro", role: "viewer" });
    await context.store.upsertWorkflow({ ...setWorkflow(counter.base, "v1", "ro"), id: "wf-ro" });
    const recordings = await goldenRuns(context, admin.cookie, "wf-ro", 2);
    const created = await call(context, "POST", "/api/eval/datasets", admin.cookie, { name: "Read-only suite", workflowId: "wf-ro" });
    const set = created.json<{ dataset: { id: string; projectId: string } }>().dataset;
    expect(set.projectId).toBe("ro");
    expect((await call(context, "POST", `/api/eval/datasets/${set.id}/recordings`, admin.cookie, { recordingId: recordings[0]!.id })).statusCode).toBe(201);
    const started = await call(context, "POST", "/api/replay/runs", admin.cookie, { datasetIds: [set.id] });
    expect(started.statusCode, started.body).toBe(202);
    const job = await waitForJob(context, admin.cookie, started.json<{ run: EvalRunView }>().run.id);
    const fixtureId = (await call(context, "GET", `/api/eval/datasets/${set.id}/fixtures`, admin.cookie)).json<{ fixtures: Array<{ id: string }> }>().fixtures[0]!.id;

    // Reads work.
    expect((await call(context, "GET", `/api/eval/datasets/${set.id}/fixtures`, builder.cookie)).statusCode).toBe(200);
    expect((await call(context, "GET", `/api/replay/runs/${job.id}`, builder.cookie)).statusCode).toBe(200);
    expect((await call(context, "GET", `/api/replay/runs/${job.id}/results/${job.results[0]!.id}`, builder.cookie)).statusCode).toBe(200);
    expect((await call(context, "GET", "/api/eval/datasets", builder.cookie)).json<{ datasets: Array<{ id: string }> }>().datasets.map((dataset) => dataset.id)).toContain(set.id);
    expect((await call(context, "GET", "/api/replay/runs", builder.cookie)).json<{ runs: EvalRunView[] }>().runs.map((run) => run.id)).toEqual([job.id]);

    // Writes and starts are 403, with nothing changed.
    for (const [method, url, payload] of [
      ["POST", "/api/eval/datasets", { name: "x", workflowId: "wf-ro" }],
      ["POST", "/api/eval/datasets", { name: "x", projectId: "ro" }],
      ["POST", `/api/eval/datasets/${set.id}/fixtures`, { name: "x", input: {} }],
      ["POST", `/api/eval/datasets/${set.id}/recordings`, { recordingId: recordings[1]!.id }],
      ["DELETE", `/api/eval/fixtures/${fixtureId}`],
      ["DELETE", `/api/eval/datasets/${set.id}`],
      ["POST", "/api/replay/runs", { datasetIds: [set.id] }],
      ["POST", `/api/replay/runs/${job.id}/cancel`],
      ["POST", `/api/eval/runs/${job.id}/cancel`]
    ] as Array<["POST" | "DELETE", string, unknown?]>) {
      const response = await call(context, method, url, builder.cookie, payload);
      expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(403);
    }
    expect(await context.store.getEvalDataset(set.id)).toBeTruthy();
    expect((await call(context, "GET", `/api/eval/datasets/${set.id}/fixtures`, admin.cookie)).json<{ fixtures: unknown[] }>().fixtures).toHaveLength(1);
    expect((await call(context, "GET", "/api/replay/runs", admin.cookie)).json<{ runs: unknown[] }>().runs).toHaveLength(1);
  }, 60_000);

  it("lists only readable projects' sets and runs, before the limit", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    await lockOut(context, builder.id, "hidden");
    const counter = await startCounter();
    await context.store.upsertWorkflow(setWorkflow(counter.base));
    await context.store.upsertWorkflow({ ...setWorkflow(counter.base, "v1", "hidden"), id: "wf-hidden" });
    const hiddenSet = (await call(context, "POST", "/api/eval/datasets", admin.cookie, { name: "Hidden suite", workflowId: "wf-hidden" })).json<{ dataset: { id: string } }>().dataset;
    const hiddenPlain = (await call(context, "POST", "/api/eval/datasets", admin.cookie, { name: "Hidden plain", projectId: "hidden" })).json<{ dataset: { id: string } }>().dataset;
    const openSet = (await call(context, "POST", "/api/eval/datasets", builder.cookie, { name: "Open suite", workflowId: "wf-set" })).json<{ dataset: { id: string } }>().dataset;
    // The hidden runs are the newest, so a limit applied before the filter would return nothing.
    await context.store.createEvalRun({ id: "run_open", datasetId: openSet.id, workflowId: "wf-set", kind: "replay", status: "completed" });
    await sleep(5);
    await context.store.createEvalRun({ id: "run_hidden_1", datasetId: hiddenSet.id, workflowId: "wf-hidden", kind: "replay", status: "completed" });
    await context.store.createEvalRun({ id: "run_hidden_2", datasetId: hiddenPlain.id, workflowId: "wf-hidden", kind: "eval", status: "completed" });
    const datasets = (await call(context, "GET", "/api/eval/datasets", builder.cookie)).json<{ datasets: Array<{ id: string }> }>().datasets.map((dataset) => dataset.id);
    expect(datasets).toContain(openSet.id);
    expect(datasets).not.toContain(hiddenSet.id);
    expect(datasets).not.toContain(hiddenPlain.id);
    expect((await call(context, "GET", "/api/replay/runs?limit=1", builder.cookie)).json<{ runs: EvalRunView[] }>().runs.map((run) => run.id)).toEqual(["run_open"]);
    expect((await call(context, "GET", "/api/eval/runs?limit=1", builder.cookie)).json<{ runs: EvalRunView[] }>().runs.map((run) => run.id)).toEqual(["run_open"]);
    expect((await call(context, "GET", "/api/eval/runs?workflowId=wf-hidden", builder.cookie)).statusCode).toBe(404);
    expect((await call(context, "GET", `/api/eval/datasets/${hiddenPlain.id}/fixtures`, builder.cookie)).statusCode).toBe(404);
    expect((await call(context, "GET", "/api/eval/runs/run_hidden_2", builder.cookie)).statusCode).toBe(404);
    expect((await call(context, "GET", "/api/replay/runs", admin.cookie)).json<{ runs: unknown[] }>().runs).toHaveLength(2);
  }, 30_000);

  it("refuses another project's golden run, golden set and eval run as a replay source", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    await lockOut(context, builder.id, "hidden");
    const counter = await startCounter();
    await context.store.upsertWorkflow(setWorkflow(counter.base));
    await context.store.upsertWorkflow({ ...setWorkflow(counter.base, "v1", "hidden"), id: "wf-hidden" });
    await context.store.upsertWorkflow({ ...setWorkflow(counter.base), id: "wf-sibling" });
    const hiddenRecording = (await goldenRuns(context, admin.cookie, "wf-hidden", 1))[0]!;
    const openSet = await goldenSet(context, builder.cookie, "wf-set", await goldenRuns(context, builder.cookie, "wf-set", 1));
    // Another project's golden run cannot be added to your set.
    const added = await call(context, "POST", `/api/eval/datasets/${openSet}/recordings`, builder.cookie, { recordingId: hiddenRecording.id });
    expect(added.statusCode).toBe(404);
    // A hidden golden set in a replay job: 404, alone or next to your own.
    const hiddenSet = (await call(context, "POST", "/api/eval/datasets", admin.cookie, { name: "Hidden suite", workflowId: "wf-hidden" })).json<{ dataset: { id: string } }>().dataset;
    expect((await call(context, "POST", "/api/replay/runs", builder.cookie, { datasetIds: [hiddenSet.id] })).statusCode).toBe(404);
    expect((await call(context, "POST", "/api/replay/runs", builder.cookie, { datasetIds: [openSet, hiddenSet.id] })).statusCode).toBe(404);
    // Eval run replay sources: hidden is 404, readable but another workflow's is 409, and a missing one is 404 even in the background.
    const plain = (await call(context, "POST", "/api/eval/datasets", builder.cookie, { name: "Plain" })).json<{ dataset: { id: string } }>().dataset;
    await call(context, "POST", `/api/eval/datasets/${plain.id}/fixtures`, builder.cookie, { name: "a", input: {} });
    await context.store.createEvalRun({ id: "run_hidden", datasetId: plain.id, workflowId: "wf-hidden", status: "completed" });
    await context.store.createEvalRun({ id: "run_sibling", datasetId: plain.id, workflowId: "wf-sibling", status: "completed" });
    const replayFrom = (evalRunId: string) => call(context, "POST", "/api/eval/runs", builder.cookie, { datasetId: plain.id, workflowId: "wf-set", replay: { evalRunId } });
    expect((await replayFrom("run_hidden")).json()).toEqual({ error: "Eval run not found" });
    expect((await replayFrom("run_hidden")).statusCode).toBe(404);
    expect((await replayFrom("run_missing")).statusCode).toBe(404);
    const sibling = await replayFrom("run_sibling");
    expect(sibling.statusCode).toBe(409);
    expect(sibling.json<{ error: string }>().error).toContain("different workflow");
    // A hidden plain dataset cannot feed its cases through your workflow.
    const hiddenPlain = (await call(context, "POST", "/api/eval/datasets", admin.cookie, { name: "Hidden plain", projectId: "hidden" })).json<{ dataset: { id: string } }>().dataset;
    expect((await call(context, "POST", "/api/eval/runs", builder.cookie, { datasetId: hiddenPlain.id, workflowId: "wf-set" })).statusCode).toBe(404);
    expect((await call(context, "GET", "/api/eval/runs", builder.cookie)).json<{ runs: EvalRunView[] }>().runs.map((run) => run.id)).toEqual(["run_sibling"]);
  }, 60_000);

  it("background eval runs resolve secrets in their own project only, as the user who started them", async () => {
    const echo = await startModel("{}");
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    await context.store.upsertProject({ id: "hidden", name: "Hidden" });
    const hiddenSecret = (await context.secretService.createSecret({ name: "hidden", provider: "custom", value: "hidden-token", projectId: "hidden" })).secretId;
    const ownSecret = (await context.secretService.createSecret({ name: "own", provider: "custom", value: "own-token" })).secretId;
    const base = echo.baseUrl.replace(/\/v1$/, "");
    await context.store.upsertWorkflow(secretWorkflow("wf-steal", "default", base, hiddenSecret));
    await context.store.upsertWorkflow(secretWorkflow("wf-own", "default", base, ownSecret));
    const dataset = (await call(context, "POST", "/api/eval/datasets", builder.cookie, { name: "Plain" })).json<{ dataset: { id: string } }>().dataset;
    await call(context, "POST", `/api/eval/datasets/${dataset.id}/fixtures`, builder.cookie, { name: "a", input: {} });

    const stolen = await call(context, "POST", "/api/eval/runs", builder.cookie, { datasetId: dataset.id, workflowId: "wf-steal" });
    expect(stolen.statusCode, stolen.body).toBe(202);
    const refused = await waitForEvalRun(context, builder.cookie, stolen.json<{ runId: string }>().runId);
    expect(JSON.stringify(refused.results)).toContain("belongs to another project");
    // Not even an admin's run widens the workflow's project.
    const asAdmin = await call(context, "POST", "/api/eval/runs", admin.cookie, { datasetId: dataset.id, workflowId: "wf-steal" });
    expect(JSON.stringify((await waitForEvalRun(context, admin.cookie, asAdmin.json<{ runId: string }>().runId)).results)).toContain("belongs to another project");
    expect(echo.auth).toEqual([]);

    const own = await call(context, "POST", "/api/eval/runs", builder.cookie, { datasetId: dataset.id, workflowId: "wf-own" });
    const finished = await waitForEvalRun(context, builder.cookie, own.json<{ runId: string }>().runId);
    expect(finished.summary).toMatchObject({ error: 0 });
    expect(echo.auth).toEqual(["Bearer own-token"]);
  }, 30_000);

  it("strict: other projects are invisible, the default project's secrets need a share, also for judges", async () => {
    const judge = await startModel('{"score": 1}');
    const context = await createTestContext({ PROJECT_ISOLATION: "strict", EVAL_JUDGE_ENABLED: "true", EVAL_JUDGE_BASE_URL: judge.baseUrl });
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const counter = await startCounter();
    await context.store.upsertProject({ id: "team", name: "Team" });
    await context.store.upsertProject({ id: "other", name: "Other" });
    await context.store.upsertProjectRole({ userId: builder.id, projectId: "team", role: "editor" });
    await context.store.upsertWorkflow({ ...setWorkflow(counter.base, "v1", "team"), id: "wf-team" });
    await context.store.upsertWorkflow({ ...setWorkflow(counter.base, "v1", "other"), id: "wf-other" });
    const otherSet = (await call(context, "POST", "/api/eval/datasets", admin.cookie, { name: "Other suite", workflowId: "wf-other" })).json<{ dataset: { id: string } }>().dataset;
    const legacy = (await call(context, "POST", "/api/eval/datasets", admin.cookie, { name: "Legacy" })).json<{ dataset: { id: string } }>().dataset;
    const recordings = await goldenRuns(context, builder.cookie, "wf-team", 1);
    const teamSet = (await call(context, "POST", "/api/eval/datasets", builder.cookie, { name: "Team suite", workflowId: "wf-team" })).json<{ dataset: { id: string; projectId: string } }>().dataset;
    expect(teamSet.projectId).toBe("team");
    expect((await call(context, "POST", `/api/eval/datasets/${teamSet.id}/recordings`, builder.cookie, { recordingId: recordings[0]!.id })).statusCode).toBe(201);

    const listed = (await call(context, "GET", "/api/eval/datasets", builder.cookie)).json<{ datasets: Array<{ id: string }> }>().datasets.map((dataset) => dataset.id);
    expect(listed).toContain(teamSet.id);
    expect(listed).not.toContain(otherSet.id);
    expect((await call(context, "GET", `/api/eval/datasets/${otherSet.id}/fixtures`, builder.cookie)).statusCode).toBe(404);
    expect((await call(context, "POST", "/api/replay/runs", builder.cookie, { datasetIds: [otherSet.id] })).statusCode).toBe(404);
    // In strict isolation the builder is no member of the default project: no new datasets there, no writes to a legacy one.
    expect((await call(context, "POST", "/api/eval/datasets", builder.cookie, { name: "Default" })).statusCode).toBe(404);
    expect((await call(context, "POST", `/api/eval/datasets/${legacy.id}/fixtures`, builder.cookie, { name: "x", input: {} })).statusCode).toBe(404);

    // A judge with a default-project secret: refused until the secret is shared to the team project.
    const defaultKey = (await context.secretService.createSecret({ name: "Default key", provider: "openai", value: JUDGE_KEY })).secretId;
    const judged = { datasetIds: [teamSet.id], scorers: [{ type: "llm_judge", rubric: "Is it right?", providerId: "openai", secretRef: { secretId: defaultKey } }] };
    const refused = await call(context, "POST", "/api/replay/runs", builder.cookie, judged);
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json<{ error: string }>().error).toContain(defaultKey);
    expect((await call(context, "POST", `/api/secrets/${defaultKey}/shares`, admin.cookie, { projectId: "team" })).statusCode).toBe(200);
    const started = await call(context, "POST", "/api/replay/runs", builder.cookie, judged);
    expect(started.statusCode, started.body).toBe(202);
    const job = await waitForJob(context, builder.cookie, started.json<{ run: EvalRunView }>().run.id);
    expect(job.summary).toMatchObject({ total: 1, error: 0 });
    expect(judge.auth.length).toBeGreaterThan(0);
    expect(judge.auth.every((header) => header === `Bearer ${JUDGE_KEY}`)).toBe(true);
    expect((await call(context, "GET", "/api/replay/runs", builder.cookie)).json<{ runs: EvalRunView[] }>().runs.map((run) => run.id)).toEqual([job.id]);
  }, 60_000);
});

describe("authorization review fixes", () => {
  type Loss = "locked out of the project" | "demoted to viewer" | "deleted" | "replaced by a new account with the same email";

  const lose = async (context: TestContext, userId: string, email: string, loss: Loss) => {
    if (loss === "locked out of the project") {
      await context.store.upsertCustomRole({ id: "none-default", projectId: "default", name: "No access", permissions: [] });
      await context.store.upsertProjectRole({ userId, projectId: "default", role: "custom", customRoleId: "none-default" });
    } else if (loss === "demoted to viewer") {
      await context.store.updateUserRole(userId, "viewer");
    } else {
      await context.store.deleteUser(userId);
      if (loss === "replaced by a new account with the same email") {
        await context.authService.register({ email, password: "replacement-Pass-123!", role: "builder" });
      }
    }
  };

  const losses: Loss[] = ["locked out of the project", "demoted to viewer", "deleted", "replaced by a new account with the same email"];

  for (const loss of losses) {
    for (const kind of ["replay job", "eval run"] as const) {
      it(`${kind}: the user ${loss} while it is queued or running; the remaining cases fail and nothing more runs`, async () => {
        // One case at a time and a slow model: the first case is in flight when access changes.
        const model = await startModel("hello", 400);
        const context = await createTestContext({ REPLAY_CONCURRENCY: "1" });
        const admin = await login(context, "admin");
        const builder = await login(context, "builder");
        const secret = await context.secretService.createSecret({ name: "Model key", provider: "openai", value: JUDGE_KEY });
        await context.store.upsertWorkflow(agentWorkflow(model.baseUrl, secret.secretId));
        let runId: string;
        let before: number;
        if (kind === "replay job") {
          const setId = await goldenSet(context, builder.cookie, "wf-agent", await goldenRuns(context, builder.cookie, "wf-agent", 3));
          before = model.auth.length;
          const started = await call(context, "POST", "/api/replay/runs", builder.cookie, { datasetIds: [setId] });
          expect(started.statusCode, started.body).toBe(202);
          runId = started.json<{ run: EvalRunView }>().run.id;
        } else {
          const dataset = (await call(context, "POST", "/api/eval/datasets", builder.cookie, { name: "Plain" })).json<{ dataset: { id: string } }>().dataset;
          for (const name of ["a", "b", "c"]) await call(context, "POST", `/api/eval/datasets/${dataset.id}/fixtures`, builder.cookie, { name, input: {} });
          before = model.auth.length;
          const started = await call(context, "POST", "/api/eval/runs", builder.cookie, { datasetId: dataset.id, workflowId: "wf-agent" });
          expect(started.statusCode, started.body).toBe(202);
          runId = started.json<{ runId: string }>().runId;
        }
        // The first case has reached the model; every later case starts after the change.
        const until = Date.now() + 15_000;
        while (model.auth.length === before && Date.now() < until) await sleep(5);
        expect(model.auth.length - before).toBe(1);
        await lose(context, builder.id, "builder@example.com", loss);

        const finished = await (kind === "replay job" ? waitForJob(context, admin.cookie, runId) : waitForEvalRunAs(context, admin.cookie, runId));
        expect(finished.results).toHaveLength(3);
        const refused = finished.results.filter((result) => result.error?.includes("can no longer run this workflow"));
        expect(refused).toHaveLength(2);
        expect(refused.every((result) => result.status === "error")).toBe(true);
        // Only the case that was already running reached the model; the other two never executed.
        expect(model.auth.length - before).toBe(1);
      }, 60_000);
    }
  }

  const waitForEvalRunAs = async (context: TestContext, cookie: string, runId: string) => {
    const until = Date.now() + 20_000;
    for (;;) {
      const run = (await call(context, "GET", `/api/eval/runs/${runId}`, cookie)).json<EvalRunView & { results: EvalCaseResult[] }>();
      if (!["queued", "running"].includes(run.status)) return run;
      if (Date.now() > until) throw new Error(`Eval run ${runId} still ${run.status}`);
      await sleep(50);
    }
  };

  it("makes no judge call for the cases after the starting user lost access", async () => {
    const judge = await startModel('{"score": 1}', 300);
    const context = await createTestContext({ EVAL_JUDGE_ENABLED: "true", EVAL_JUDGE_BASE_URL: judge.baseUrl, REPLAY_CONCURRENCY: "1" });
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const counter = await startCounter();
    await context.store.upsertWorkflow(setWorkflow(counter.base));
    const secret = await context.secretService.createSecret({ name: "Judge key", provider: "openai", value: JUDGE_KEY });
    const dataset = (await call(context, "POST", "/api/eval/datasets", builder.cookie, { name: "Plain" })).json<{ dataset: { id: string } }>().dataset;
    for (const name of ["a", "b", "c"]) await call(context, "POST", `/api/eval/datasets/${dataset.id}/fixtures`, builder.cookie, { name, input: {} });
    const scorers = [{ type: "llm_judge", rubric: "r", providerId: "openai", secretRef: { secretId: secret.secretId } }];
    const started = await call(context, "POST", "/api/eval/runs", builder.cookie, { datasetId: dataset.id, workflowId: "wf-set", scorers });
    expect(started.statusCode, started.body).toBe(202);
    const until = Date.now() + 15_000;
    while (judge.auth.length === 0 && Date.now() < until) await sleep(5);
    await context.store.deleteUser(builder.id);
    const finished = await waitForEvalRunAs(context, admin.cookie, started.json<{ runId: string }>().runId);
    expect(finished.results.filter((result) => result.error?.includes("can no longer run this workflow"))).toHaveLength(2);
    expect(judge.auth).toHaveLength(1);
    expect(counter.count("/slack")).toBe(1);
  }, 60_000);

  it("stores the starting user's id on the run", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const counter = await startCounter();
    await context.store.upsertWorkflow(setWorkflow(counter.base));
    const dataset = (await call(context, "POST", "/api/eval/datasets", builder.cookie, { name: "Plain" })).json<{ dataset: { id: string } }>().dataset;
    await call(context, "POST", `/api/eval/datasets/${dataset.id}/fixtures`, builder.cookie, { name: "a", input: {} });
    const started = await call(context, "POST", "/api/eval/runs", builder.cookie, { datasetId: dataset.id, workflowId: "wf-set" });
    const runId = started.json<{ runId: string }>().runId;
    await waitForEvalRunAs(context, builder.cookie, runId);
    const db = new Database(context.dbPath, { readonly: true });
    try {
      expect(db.prepare("SELECT triggered_by, triggered_by_user_id FROM eval_runs WHERE id = ?").get(runId)).toEqual({ triggered_by: "builder@example.com", triggered_by_user_id: builder.id });
    } finally {
      db.close();
    }
  }, 30_000);

  it("fails a judge whose secret resolves to nothing instead of falling back to the server's provider keys", async () => {
    const judge = await startModel('{"score": 1}');
    const context = await createTestContext({ EVAL_JUDGE_ENABLED: "true", EVAL_JUDGE_BASE_URL: judge.baseUrl, OPENAI_API_KEY: "sk-env-key-should-never-be-sent-0000" });
    const builder = await login(context, "builder");
    const counter = await startCounter();
    await context.store.upsertWorkflow(setWorkflow(counter.base));
    const empty = await context.secretService.createSecret({ name: "Empty key", provider: "openai", value: "" });
    const dataset = (await call(context, "POST", "/api/eval/datasets", builder.cookie, { name: "Plain" })).json<{ dataset: { id: string } }>().dataset;
    const scorer = { type: "llm_judge", rubric: "r", providerId: "openai", secretRef: { secretId: empty.secretId } };
    expect((await call(context, "POST", `/api/eval/datasets/${dataset.id}/fixtures`, builder.cookie, { name: "a", input: {}, scorers: [scorer] })).statusCode).toBe(200);
    const waited = await call(context, "POST", "/api/eval/runs?wait=true", builder.cookie, { datasetId: dataset.id, workflowId: "wf-set" });
    expect(waited.statusCode, waited.body).toBe(200);
    const run = (await call(context, "GET", `/api/eval/runs/${waited.json<{ runId: string }>().runId}`, builder.cookie)).json<EvalRunView & { results: EvalCaseResult[] }>();
    expect(run.results[0]!.score!.details[0]).toMatchObject({ pass: false, reason: expect.stringContaining("has no value") });
    expect(judge.auth).toHaveLength(0);
  }, 30_000);

  it("strict: a judge may use a secret of the project a workflow is shared from when it is shared with execute", async () => {
    const judge = await startModel('{"score": 1}');
    const context = await createTestContext({ PROJECT_ISOLATION: "strict", EVAL_JUDGE_ENABLED: "true", EVAL_JUDGE_BASE_URL: judge.baseUrl });
    const builder = await login(context, "builder");
    const counter = await startCounter();
    await context.store.upsertProject({ id: "pa", name: "Owner" });
    await context.store.upsertProject({ id: "pb", name: "Consumer" });
    await context.store.upsertProjectRole({ userId: builder.id, projectId: "pb", role: "editor" });
    await context.store.upsertWorkflow({ ...setWorkflow(counter.base, "v1", "pa"), id: "wf-a" });
    const key = (await context.secretService.createSecret({ name: "Owner key", provider: "openai", value: JUDGE_KEY, projectId: "pa" })).secretId;
    const dataset = (await call(context, "POST", "/api/eval/datasets", builder.cookie, { name: "Plain", projectId: "pb" })).json<{ dataset: { id: string } }>().dataset;
    await call(context, "POST", `/api/eval/datasets/${dataset.id}/fixtures`, builder.cookie, { name: "a", input: {} });
    const scorers = [{ type: "llm_judge", rubric: "r", providerId: "openai", secretRef: { secretId: key } }];
    await context.store.upsertWorkflowShare({ workflowId: "wf-a", projectId: "pb", accessLevel: "execute" });
    const started = await call(context, "POST", "/api/eval/runs", builder.cookie, { datasetId: dataset.id, workflowId: "wf-a", scorers });
    expect(started.statusCode, started.body).toBe(202);
    const finished = await waitForEvalRunAs(context, builder.cookie, started.json<{ runId: string }>().runId);
    expect(finished.summary).toMatchObject({ total: 1, error: 0 });
    expect(judge.auth).toEqual([`Bearer ${JUDGE_KEY}`]);
  }, 30_000);

  it("strict: datasets without a project belong to the default project, for reads too", async () => {
    const context = await createTestContext({ PROJECT_ISOLATION: "strict" });
    const teamUser = await login(context, "builder", "teamer");
    const defaultUser = await login(context, "builder", "defaulter");
    await context.store.upsertProject({ id: "team", name: "Team" });
    await context.store.upsertProjectRole({ userId: teamUser.id, projectId: "team", role: "editor" });
    await context.store.upsertProjectRole({ userId: defaultUser.id, projectId: "default", role: "editor" });
    // One from before projects scoped datasets (no project), one created through the API without a project.
    await context.store.createEvalDataset({ id: "ds_legacy", name: "Legacy" });
    await context.store.createEvalFixture({ id: "fix_legacy", datasetId: "ds_legacy", name: "l", input: { secretish: "payroll-data" } });
    const created = await call(context, "POST", "/api/eval/datasets", defaultUser.cookie, { name: "Fresh" });
    expect(created.statusCode, created.body).toBe(200);
    const fresh = created.json<{ dataset: { id: string; projectId: string } }>().dataset;
    expect(fresh.projectId).toBe("default");
    expect((await call(context, "POST", `/api/eval/datasets/${fresh.id}/fixtures`, defaultUser.cookie, { name: "f", input: { secretish: "payroll-data" } })).statusCode).toBe(200);

    const idsFor = async (cookie: string) => (await call(context, "GET", "/api/eval/datasets", cookie)).json<{ datasets: Array<{ id: string }> }>().datasets.map((dataset) => dataset.id);
    expect(await idsFor(teamUser.cookie)).toEqual([]);
    for (const id of ["ds_legacy", fresh.id]) {
      expect((await call(context, "GET", `/api/eval/datasets/${id}/fixtures`, teamUser.cookie)).statusCode).toBe(404);
      expect((await call(context, "GET", `/api/eval/datasets/${id}/fixtures`, defaultUser.cookie)).statusCode).toBe(200);
    }
    expect((await idsFor(defaultUser.cookie)).sort()).toEqual(["ds_legacy", fresh.id].sort());
    // The project filter treats the legacy dataset as the default project's too.
    expect((await call(context, "GET", "/api/eval/datasets?projectId=default", defaultUser.cookie)).json<{ datasets: unknown[] }>().datasets).toHaveLength(2);
  }, 30_000);

  it("role isolation: a dataset without a project stays readable by builders", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    await context.store.createEvalDataset({ id: "ds_legacy", name: "Legacy" });
    expect((await call(context, "GET", "/api/eval/datasets/ds_legacy/fixtures", builder.cookie)).statusCode).toBe(200);
    const created = await call(context, "POST", "/api/eval/datasets", builder.cookie, { name: "Fresh" });
    expect(created.json<{ dataset: { projectId: string } }>().dataset.projectId).toBe("default");
  }, 30_000);

  it("golden sets follow their workflow's current project in the project filter and the audit events", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const counter = await startCounter();
    await context.store.upsertProject({ id: "moved", name: "Moved" });
    await context.store.upsertWorkflow(setWorkflow(counter.base));
    const set = (await call(context, "POST", "/api/eval/datasets", admin.cookie, { name: "Suite", workflowId: "wf-set" })).json<{ dataset: { id: string } }>().dataset;
    await context.store.upsertWorkflow({ ...setWorkflow(counter.base), projectId: "moved" });
    const inProject = async (projectId: string) =>
      (await call(context, "GET", `/api/eval/datasets?projectId=${projectId}`, admin.cookie)).json<{ datasets: Array<{ id: string }> }>().datasets.map((dataset) => dataset.id);
    expect(await inProject("moved")).toEqual([set.id]);
    expect(await inProject("default")).toEqual([]);
    // Deleting the set audits the project its workflow is in now.
    expect((await call(context, "DELETE", `/api/eval/datasets/${set.id}`, admin.cookie)).statusCode).toBe(200);
    const events = (await context.store.listAuditLogs({ eventType: "replay.golden_set.deleted" })).items;
    expect(events.map((event) => event.projectId)).toEqual(["moved"]);
  }, 30_000);

  it("records the project on the cancel audit event", async () => {
    const model = await startModel("hello", 300);
    const context = await createTestContext({ REPLAY_CONCURRENCY: "1" });
    const builder = await login(context, "builder");
    const secret = await context.secretService.createSecret({ name: "Model key", provider: "openai", value: JUDGE_KEY });
    await context.store.upsertWorkflow(agentWorkflow(model.baseUrl, secret.secretId));
    const setId = await goldenSet(context, builder.cookie, "wf-agent", await goldenRuns(context, builder.cookie, "wf-agent", 2));
    const started = await call(context, "POST", "/api/replay/runs", builder.cookie, { datasetIds: [setId] });
    const runId = started.json<{ run: EvalRunView }>().run.id;
    expect((await call(context, "POST", `/api/replay/runs/${runId}/cancel`, builder.cookie)).statusCode).toBe(200);
    const events = (await context.store.listAuditLogs({ eventType: "replay.job.canceled" })).items;
    expect(events.map((event) => event.projectId)).toEqual(["default"]);
  }, 30_000);

  it("eval runs: a cassette of another workflow is 409, an unreadable or missing one is 404; a replay job result of another run is 404", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const counter = await startCounter();
    await context.store.upsertWorkflow(setWorkflow(counter.base));
    await context.store.upsertWorkflow({ ...setWorkflow(counter.base), id: "wf-sibling" });
    await context.store.saveMcpCassette({
      id: "cas_sibling",
      executionId: null,
      workflowId: "wf-sibling",
      workflowName: "Sibling",
      projectId: "default",
      source: "manual",
      cassette: { format: "l2m.mcp-cassette", version: 1, recordedAt: new Date().toISOString(), servers: [], entries: [], truncated: false, bytes: 0, llm: "not_recorded" } as never,
      createdBy: null
    });
    const dataset = (await call(context, "POST", "/api/eval/datasets", builder.cookie, { name: "Plain" })).json<{ dataset: { id: string } }>().dataset;
    await call(context, "POST", `/api/eval/datasets/${dataset.id}/fixtures`, builder.cookie, { name: "a", input: {} });
    const replayFrom = (cassetteId: string) => call(context, "POST", "/api/eval/runs", builder.cookie, { datasetId: dataset.id, workflowId: "wf-set", replay: { cassetteId } });
    const sibling = await replayFrom("cas_sibling");
    expect(sibling.statusCode).toBe(409);
    expect(sibling.json<{ error: string }>().error).toContain("different workflow");
    const missing = await replayFrom("cas_missing");
    expect(missing.statusCode).toBe(404);
    expect(missing.json<{ error: string }>().error).toBe("Cassette not found");

    // A result id belongs to its own run: asking for it through another job is a 404.
    const setId = await goldenSet(context, builder.cookie, "wf-set", await goldenRuns(context, builder.cookie, "wf-set", 1));
    const first = (await call(context, "POST", "/api/replay/runs", builder.cookie, { datasetIds: [setId] })).json<{ run: EvalRunView }>().run;
    const second = (await call(context, "POST", "/api/replay/runs", builder.cookie, { datasetIds: [setId] })).json<{ run: EvalRunView }>().run;
    const firstDone = await waitForJob(context, builder.cookie, first.id);
    await waitForJob(context, builder.cookie, second.id);
    const resultId = firstDone.results[0]!.id;
    expect((await call(context, "GET", `/api/replay/runs/${first.id}/results/${resultId}`, builder.cookie)).statusCode).toBe(200);
    expect((await call(context, "GET", `/api/replay/runs/${second.id}/results/${resultId}`, builder.cookie)).statusCode).toBe(404);
  }, 60_000);
});

describe("migration 31", () => {
  it("adds the golden-set and replay-job columns in Postgres DDL with a down path", () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 31)!;
    expect(migration.description).toContain("15.2");
    for (const fragment of [
      "ALTER TABLE eval_datasets ADD COLUMN IF NOT EXISTS workflow_id TEXT",
      "ALTER TABLE eval_fixtures ADD COLUMN IF NOT EXISTS recording_id TEXT",
      "ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'eval'",
      "ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS progress_json TEXT",
      "ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS triggered_by_user_id TEXT",
      "ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS diff_json TEXT",
      "ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS cost_usd DOUBLE PRECISION",
      "idx_eval_runs_kind"
    ]) {
      expect(migration.up).toContain(fragment);
    }
    expect(migration.down).toContain("ALTER TABLE eval_runs DROP COLUMN IF EXISTS kind");
  });

  it("adds the same columns in SQLite, and old eval runs read as kind eval", async () => {
    const context = await createTestContext();
    const db = new Database(context.dbPath, { readonly: true });
    try {
      const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
      expect(columns("eval_datasets")).toContain("workflow_id");
      expect(columns("eval_fixtures")).toContain("recording_id");
      expect(columns("eval_runs")).toEqual(expect.arrayContaining(["kind", "triggered_by_user_id", "dataset_ids_json", "candidate_json", "workflow_hash", "workflow_version", "options_json", "progress_json"]));
      expect(columns("eval_results")).toEqual(expect.arrayContaining(["recording_id", "verdict", "diff_json", "cost_usd"]));
    } finally {
      db.close();
    }
    await context.store.createEvalRun({ id: "run_legacy", datasetId: "ds", workflowId: "wf" });
    expect(await context.store.getEvalRun("run_legacy")).toMatchObject({ kind: "eval", datasetIds: ["ds"], candidate: null });
  });
});
