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
    const context = await createTestContext({ EVAL_JUDGE_BASE_URL: judge.baseUrl, REPLAY_CONCURRENCY: "2" });
    const builder = await login(context, "builder");
    const viewer = await login(context, "viewer");
    const counter = await startCounter();
    context.store.upsertWorkflow(setWorkflow(counter.base));
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

    const secret = context.secretService.createSecret({ name: "Judge key", provider: "openai", value: JUDGE_KEY });
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
    context.store.upsertWorkflow(setWorkflow(counter.base));
    const recordings = await goldenRuns(context, builder.cookie, "wf-set", 3);
    const setId = await goldenSet(context, builder.cookie, "wf-set", recordings);
    // A hand-written case in the set is skipped by replay jobs.
    expect((await call(context, "POST", `/api/eval/datasets/${setId}/fixtures`, builder.cookie, { name: "hand-written", input: { q: 1 }, scorers: [{ type: "nope" }] })).statusCode).toBe(400);
    expect((await call(context, "POST", `/api/eval/datasets/${setId}/fixtures`, builder.cookie, { name: "hand-written", input: { q: 1 } })).statusCode).toBe(200);

    context.store.upsertWorkflow(setWorkflow(counter.base, "v2"));
    const started = await call(context, "POST", "/api/replay/runs", builder.cookie, { datasetIds: [setId] });
    expect(started.statusCode, started.body).toBe(202);
    const job = await waitForJob(context, builder.cookie, started.json<{ run: EvalRunView }>().run.id);
    expect(job.summary).toMatchObject({ total: 4, pass: 0, fail: 3, error: 0, skipped: 1 });
    const failed = job.results.find((result) => result.status === "fail")!;
    expect(failed.score!.details.find((detail) => detail.type === "json_equal")!.reason).toContain("answer v1");
    expect(job.results.find((result) => result.status === "skipped")!.fixtureName).toBe("hand-written");

    // A builder locked out of the workflow's project sees none of it.
    context.store.upsertProject({ id: "hidden", name: "Hidden" });
    context.store.upsertCustomRole({ id: "none-hidden", projectId: "hidden", name: "No access", permissions: [] });
    context.store.upsertProjectRole({ userId: outsider.id, projectId: "hidden", role: "custom", customRoleId: "none-hidden" });
    context.store.upsertWorkflow(setWorkflow(counter.base, "v2", "hidden"));
    expect((await call(context, "GET", `/api/replay/runs/${job.id}`, outsider.cookie)).statusCode).toBe(403);
    expect((await call(context, "GET", `/api/replay/runs/${job.id}/results/${failed.id}`, outsider.cookie)).statusCode).toBe(403);
    expect((await call(context, "GET", `/api/eval/runs/${job.id}`, outsider.cookie)).statusCode).toBe(403);
    expect((await call(context, "GET", `/api/eval/datasets/${setId}/fixtures`, outsider.cookie)).statusCode).toBe(403);
    expect((await call(context, "POST", "/api/replay/runs", outsider.cookie, { datasetIds: [setId] })).statusCode).toBe(403);
    expect((await call(context, "DELETE", `/api/eval/datasets/${setId}`, outsider.cookie)).statusCode).toBe(403);
    expect((await call(context, "GET", "/api/replay/runs", outsider.cookie)).json<{ runs: EvalRunView[] }>().runs).toEqual([]);
    expect((await call(context, "GET", "/api/eval/runs", outsider.cookie)).json<{ runs: EvalRunView[] }>().runs).toEqual([]);
    expect((await call(context, "GET", "/api/eval/datasets", outsider.cookie)).json<{ datasets: unknown[] }>().datasets).toEqual([]);
    expect((await call(context, "GET", `/api/replay/runs/${job.id}`, admin.cookie)).statusCode).toBe(200);
  }, 60_000);

  it("cancels a running job: queued cases never start", async () => {
    const model = await startModel("hello", 400);
    const context = await createTestContext({ REPLAY_CONCURRENCY: "1" });
    const builder = await login(context, "builder");
    const secret = context.secretService.createSecret({ name: "Model key", provider: "openai", value: JUDGE_KEY });
    context.store.upsertWorkflow(agentWorkflow(model.baseUrl, secret.secretId));
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
    context.store.upsertWorkflow(setWorkflow(counter.base));
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
    expect((await call(context, "POST", "/api/eval/runs", builder.cookie, { datasetId: "ds_missing", workflowId: "wf-set" })).statusCode).toBe(400);
  }, 30_000);

  it("marks runs left running by a stopped server as interrupted on the next boot", async () => {
    const first = await createTestContext();
    first.store.createEvalRun({ id: "run_left", datasetId: "ds", workflowId: "wf-set", kind: "replay", status: "running", progress: { updatedAt: new Date().toISOString() } });
    await closeContext(first);
    contexts.splice(contexts.indexOf(first), 1);
    const second = await createTestContext({}, { tempDir: first.tempDir, dbPath: first.dbPath });
    try {
      expect(second.store.getEvalRun("run_left")).toMatchObject({ status: "interrupted", error: expect.stringContaining("server stopped") });
    } finally {
      await closeContext(second);
      fs.rmSync(first.tempDir, { recursive: true, force: true });
    }
  });
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
      expect(columns("eval_runs")).toEqual(expect.arrayContaining(["kind", "dataset_ids_json", "candidate_json", "workflow_hash", "workflow_version", "options_json", "progress_json"]));
      expect(columns("eval_results")).toEqual(expect.arrayContaining(["recording_id", "verdict", "diff_json", "cost_usd"]));
    } finally {
      db.close();
    }
    context.store.createEvalRun({ id: "run_legacy", datasetId: "ds", workflowId: "wf" });
    expect(context.store.getEvalRun("run_legacy")).toMatchObject({ kind: "eval", datasetIds: ["ds"], candidate: null });
  });
});
