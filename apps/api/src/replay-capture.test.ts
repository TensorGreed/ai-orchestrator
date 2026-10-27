/**
 * Phase 15.6 — production capture over the API: zero-config, sampling and
 * limits, which runs are never captured, the published-version rule,
 * masking with keyed surrogates (and a `models: "replay"` job that still
 * hits the masked tape), size caps, eviction, retention, the inbox routes
 * and their authorization, candidates refused by golden sets and replays,
 * and the admin data-subject lookup.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { MaskIdentifierError, MaskUnscannableError, surrogateFor } from "@ai-orchestrator/guard-sdk";
import type {
  EvalRunView,
  ReplayCaptureSettingsView,
  ReplayCaptureView,
  ReplayFindSubjectDeleteResult,
  ReplayFindSubjectResult,
  ReplayRecordingDetail,
  ReplayRecordingSummary,
  RunFacts,
  Workflow
} from "@ai-orchestrator/shared";
import Fastify from "fastify";
import { createApp } from "./app.js";
import { registerReplayCaptureRoutes } from "./replay-capture-routes.js";
import type { RunAccess } from "./run-access.js";
import type { SafeUser } from "./services/auth-service.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { openTestStore } from "./test-support/test-store.js";
import { testSql } from "./test-support/test-sql.js";
import { MIGRATIONS } from "./db/migrations.js";
import { AuthService } from "./services/auth-service.js";
import { deriveCaptureSurrogateKey, ReplayCaptureService, seededRandom } from "./services/replay-capture-service.js";
import { SecretService } from "./services/secret-service.js";
import { WorkflowVersionService } from "./services/workflow-version-service.js";

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
const MASTER_KEY = crypto.randomBytes(32).toString("base64");
const SURROGATE_KEY = deriveCaptureSurrogateKey(Buffer.from(MASTER_KEY, "base64"));
const MODEL_KEY = "sk-model-CAPTURE-key-0a1b2c3d4e5f60718293";
const EMAIL = "jane.doe@example.com";
const CARD = "4111 1111 1111 1111";

async function createTestContext(overrides: Record<string, string> = {}, existing?: { tempDir: string; dbPath: string }): Promise<TestContext> {
  const tempDir = existing?.tempDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "ao-capture-"));
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

/** An OpenAI-style endpoint that echoes the last user message, so the answer carries the same personal data. */
async function startEchoModel() {
  const calls: string[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      let last = "";
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages?: Array<{ role: string; content: unknown }> };
        last = String([...(body.messages ?? [])].reverse().find((message) => message.role === "user")?.content ?? "");
      } catch {
        last = "";
      }
      calls.push(last);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: `Noted: ${last}` } }], usage: { prompt_tokens: 50, completion_tokens: 10 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to bind fake model");
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, calls };
}

const node = (id: string, type: string, config: Record<string, unknown> = {}, x = 0) => ({ id, type, name: id, position: { x, y: 0 }, config });

/** webhook → output. */
function hookWorkflow(id: string, answer = "ok", projectId = "default"): Workflow {
  return {
    id,
    name: `Capture ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId,
    nodes: [node("hook", "webhook_input", { path: `hook-${id}`, method: "POST" }), node("out", "output", { responseTemplate: answer }, 200)],
    edges: [{ id: "e1", source: "hook", target: "out" }]
  } as Workflow;
}

/** webhook (user_prompt) → agent (chat model: the echo model) → output. */
function agentWorkflow(baseUrl: string, secretId: string, id = "wf-agent"): Workflow {
  return {
    id,
    name: "Support agent",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      node("hook", "webhook_input", { path: `hook-${id}`, method: "POST" }),
      node("agent_1", "agent_orchestrator", { systemPromptTemplate: "Be brief. Escalations go to support@acme.test.", maxIterations: 1, toolCallingEnabled: false }, 150),
      node("model", "llm_call", { provider: { providerId: "openai", model: "gpt-4o-mini", baseUrl, secretRef: { secretId }, extra: { maxRetries: 0 } } }, 150),
      node("output", "output", {}, 300)
    ],
    edges: [
      { id: "e1", source: "hook", target: "agent_1" },
      { id: "e2", source: "agent_1", sourceHandle: "chat_model", target: "model" },
      { id: "e3", source: "agent_1", target: "output" }
    ]
  } as Workflow;
}

async function save(context: TestContext, workflow: Workflow): Promise<number> {
  const saved = await context.store.upsertWorkflow(workflow);
  return (await new WorkflowVersionService(context.store).snapshot({ workflow: saved, changeNote: "test" })).version;
}

const hook = (context: TestContext, workflowId: string, payload: Record<string, unknown> = {}) =>
  context.app.inject({ method: "POST", url: `/webhook/hook-${workflowId}`, payload });

async function enableCapture(context: TestContext, cookie: string, workflowId: string, settings: Record<string, unknown> = {}): Promise<ReplayCaptureSettingsView> {
  const response = await call(context, "PUT", `/api/workflows/${workflowId}/replay-capture`, cookie, { enabled: true, rate: 1, ...settings });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ settings: ReplayCaptureSettingsView }>().settings;
}

async function inbox(context: TestContext, cookie: string, workflowId: string, query = ""): Promise<{ items: ReplayCaptureView[]; total: number }> {
  const response = await call(context, "GET", `/api/workflows/${workflowId}/replay-captures${query}`, cookie);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ items: ReplayCaptureView[]; total: number }>();
}

/** Waits until the inbox holds `count` captures (captures are queued after the run answers). */
async function waitForCaptures(context: TestContext, cookie: string, workflowId: string, count: number, timeoutMs = 20_000): Promise<ReplayCaptureView[]> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const page = await inbox(context, cookie, workflowId);
    if (page.total >= count) return page.items;
    if (Date.now() > until) throw new Error(`Only ${page.total} of ${count} captures arrived`);
    await sleep(25);
  }
}

/** Lets queued captures finish: a few event-loop turns plus a short pause. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  await sleep(150);
}

async function rawRecordingText(context: TestContext, id: string): Promise<string> {
  const row = await context.store.subjectTextRow("recording", id);
  if (!row) throw new Error(`No recording ${id}`);
  return Object.values(row.texts).filter(Boolean).join("\n");
}

async function runJob(context: TestContext, cookie: string, body: Record<string, unknown>, timeoutMs = 45_000) {
  const started = await call(context, "POST", "/api/replay/runs", cookie, body);
  expect(started.statusCode, started.body).toBe(202);
  const runId = started.json<{ run: EvalRunView }>().run.id;
  const until = Date.now() + timeoutMs;
  for (;;) {
    const response = await call(context, "GET", `/api/replay/runs/${runId}`, cookie);
    const run = response.json<{ run: EvalRunView & { results: Array<{ status: string; error?: string | null }> } }>().run;
    if (!["queued", "running"].includes(run.status)) return run;
    if (Date.now() > until) throw new Error(`Job ${runId} still ${run.status}`);
    await sleep(50);
  }
}

describe("without a 32-byte master key", () => {
  // createApp itself refuses to start without the key (MFA needs it, and index.ts checks it), so the routes are
  // registered here on their own with capture off: they answer 501, exactly as before on SQLite.
  it("every capture route answers 501", async () => {
    const app = Fastify();
    closers.push(async () => await app.close());
    const user = { id: "u1", email: "admin@example.com", role: "admin" } as SafeUser;
    registerReplayCaptureRoutes({
      app,
      store: {} as Store,
      captures: {} as ReplayCaptureService,
      requireRole: async () => user,
      runAccess: {} as RunAccess,
      audit: () => undefined,
      available: false
    });
    await app.ready();
    for (const [method, url] of [
      ["GET", "/api/workflows/wf-any/replay-capture"],
      ["PUT", "/api/workflows/wf-any/replay-capture"],
      ["GET", "/api/workflows/wf-any/replay-captures"]
    ] as const) {
      const response = await app.inject({ method, url, ...(method === "PUT" ? { payload: {} } : {}) });
      expect(response.statusCode, `${method} ${url}`).toBe(501);
      expect(response.json<{ error: string }>().error).toMatch(/32-byte SECRET_MASTER_KEY_BASE64/);
    }
  });
});

describe("migration 34", () => {
  it("adds capture settings and recording status in Postgres DDL with a down path, and the same in SQLite", async () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 34)!;
    expect(migration.up).toContain("ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'golden'");
    expect(migration.up).toContain("ADD COLUMN IF NOT EXISTS captured_at");
    expect(migration.up).toContain("CREATE TABLE IF NOT EXISTS replay_capture_settings");
    expect(migration.up).toContain("last_drop_outcome TEXT");
    expect(migration.down).toContain("DROP TABLE IF EXISTS replay_capture_settings");
    expect(migration.down).toContain("DROP COLUMN IF EXISTS status");
    const context = await createTestContext();
    const sql = testSql(context.store);
    const columns = async (table: string) =>
      (sql.kind === "sqlite"
        ? await sql.all<{ name: string }>(`PRAGMA table_info(${table})`)
        : await sql.all<{ name: string }>("SELECT column_name AS name FROM information_schema.columns WHERE table_name = ?", table)
      ).map((row) => row.name);
    expect(await columns("replay_recordings")).toEqual(expect.arrayContaining(["status", "captured_at"]));
    expect(await columns("replay_capture_settings")).toEqual(
      expect.arrayContaining(["workflow_id", "enabled", "rate", "max_per_day", "only_statuses_json", "dlp", "dlp_off_reason", "target_dataset_id", "last_drop_outcome", "last_drop_at"])
    );
  });
});

describe("zero-config: capture off changes nothing", () => {
  it("never records a workflow that has no capture settings, and reports the defaults", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    await save(context, hookWorkflow("wf-off"));
    for (let i = 0; i < 3; i += 1) expect((await hook(context, "wf-off", { user_prompt: `hello ${EMAIL}` })).statusCode).toBe(200);
    await settle();
    expect((await inbox(context, builder.cookie, "wf-off")).total).toBe(0);
    expect((await context.store.listReplayRecordings({})).total).toBe(0);
    const settings = (await call(context, "GET", "/api/workflows/wf-off/replay-capture", builder.cookie)).json<{ settings: ReplayCaptureSettingsView }>().settings;
    expect(settings).toMatchObject({ configured: false, enabled: false, rate: 0.1, maxPerDay: 20, dlp: true, onlyStatuses: ["success", "error", "canceled"], effectiveRate: 0, candidates: 0 });
    expect(settings.deployment).toMatchObject({ enabled: true, maxRate: 1, retentionDays: 14, maxCandidates: 200 });
  });

  it("the kill switch stops every workflow's capture", async () => {
    const context = await createTestContext({ REPLAY_CAPTURE_ENABLED: "false" });
    const builder = await login(context, "builder");
    await save(context, hookWorkflow("wf-kill"));
    const settings = await enableCapture(context, builder.cookie, "wf-kill");
    expect(settings.effectiveRate).toBe(0);
    await hook(context, "wf-kill");
    await settle();
    expect((await inbox(context, builder.cookie, "wf-kill")).total).toBe(0);
  });
});

describe("sampling and limits", () => {
  function service(context: TestContext, seed: number, maxRate = 1) {
    return new ReplayCaptureService({
      store: context.store,
      recordings: {} as never,
      datasets: {} as never,
      surrogateKey: SURROGATE_KEY,
      dictionariesFor: async () => [],
      dictionaryClasses: async () => [],
      publishedVersion: async (workflowId) => await context.store.getPublishedVersion(workflowId),
      deployment: { enabled: true, maxRate, retentionDays: 14, maxPerWorkflow: 200, maxBytesPerWorkflow: 209_715_200 },
      random: seededRandom(seed),
      log: { warn: () => undefined, info: () => undefined }
    });
  }

  it("samples at the configured rate with a seeded generator, capped by the deployment ceiling", async () => {
    const context = await createTestContext();
    await save(context, hookWorkflow("wf-rate"));
    await context.store.saveReplayCaptureSettings({ workflowId: "wf-rate", enabled: true, rate: 0.1, maxPerDay: 1_000, onlyStatuses: ["success"], dlp: true, dlpOffReason: null, targetDatasetId: null, updatedBy: null });
    const draws = async (rate: number, maxRate: number, seed: number) => {
      const capture = service(context, seed, maxRate);
      const expected = (() => {
        const random = seededRandom(seed);
        let hits = 0;
        for (let i = 0; i < 10_000; i += 1) if (random() < Math.min(rate, maxRate)) hits += 1;
        return hits;
      })();
      let sampled = 0;
      for (let i = 0; i < 10_000; i += 1) {
        const ticket = await capture.decide({ workflow: { id: "wf-rate" }, channel: "production", triggerType: "webhook", releaseVersion: null, excluded: false });
        if (ticket) {
          sampled += 1;
          capture.abandon(ticket);
        }
      }
      return { sampled, expected };
    };
    const tenth = await draws(0.1, 1, 42);
    expect(tenth.sampled).toBe(tenth.expected);
    expect(tenth.sampled).toBeGreaterThan(850);
    expect(tenth.sampled).toBeLessThan(1_150);
    const capped = await draws(0.1, 0.02, 7);
    expect(capped.sampled).toBe(capped.expected);
    expect(capped.sampled).toBeLessThan(300);
    // Same seed, same decisions.
    expect((await draws(0.1, 1, 42)).sampled).toBe(tenth.sampled);
  }, 120_000); // 40,000 sampling decisions, each reading the settings row: far slower over a network database

  it("counts runs in flight against the daily limit, and excludes non-production runs", async () => {
    const context = await createTestContext();
    await save(context, hookWorkflow("wf-day"));
    await context.store.saveReplayCaptureSettings({ workflowId: "wf-day", enabled: true, rate: 1, maxPerDay: 3, onlyStatuses: ["success"], dlp: true, dlpOffReason: null, targetDatasetId: null, updatedBy: null });
    const capture = service(context, 1);
    const decide = async (overrides: Partial<Parameters<ReplayCaptureService["decide"]>[0]> = {}) =>
      await capture.decide({ workflow: { id: "wf-day" }, channel: "production", triggerType: "webhook", releaseVersion: null, excluded: false, ...overrides });
    for (const excluded of [
      { channel: "draft" },
      { triggerType: "manual" },
      { triggerType: "webhook_test" },
      { triggerType: "replay" },
      { triggerType: "manual_retry" },
      { triggerType: "approval_resume" },
      { triggerType: "eval" },
      { excluded: true }
    ]) {
      expect(await decide(excluded)).toBeNull();
    }
    const tickets = [await decide(), await decide(), await decide()];
    expect(tickets.every(Boolean)).toBe(true);
    expect(await decide()).toBeNull();
    capture.abandon(tickets[0]!);
    expect(await decide()).not.toBeNull();
  });

  it("captures only runs of the published version once there is one", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const v1 = await save(context, hookWorkflow("wf-pub", "one"));
    await save(context, hookWorkflow("wf-pub", "two"));
    expect((await call(context, "POST", "/api/workflows/wf-pub/publish", builder.cookie, { version: v1 })).statusCode).toBe(200);
    await context.store.saveReplayCaptureSettings({ workflowId: "wf-pub", enabled: true, rate: 1, maxPerDay: 10, onlyStatuses: ["success"], dlp: true, dlpOffReason: null, targetDatasetId: null, updatedBy: null });
    const capture = service(context, 3);
    expect(await capture.decide({ workflow: { id: "wf-pub" }, channel: "production", triggerType: "webhook", releaseVersion: 2, excluded: false })).toBeNull();
    expect(await capture.decide({ workflow: { id: "wf-pub" }, channel: "production", triggerType: "webhook", releaseVersion: null, excluded: false })).toBeNull();
    expect(await capture.decide({ workflow: { id: "wf-pub" }, channel: "production", triggerType: "webhook", releaseVersion: v1, excluded: false })).not.toBeNull();

    // Over the API: production runs the published version, and the capture says so.
    expect((await hook(context, "wf-pub")).json<{ output: unknown }>().output).toMatchObject({ result: "one" });
    const [captured] = await waitForCaptures(context, builder.cookie, "wf-pub", 1);
    expect(captured!.capabilities.capture).toMatchObject({ publishedVersion: v1, rate: 1, masked: true });
  });

  it("keeps a daily limit per workflow over the API and records why runs were skipped", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    await save(context, hookWorkflow("wf-limit"));
    await enableCapture(context, builder.cookie, "wf-limit", { maxPerDay: 2 });
    for (let i = 0; i < 4; i += 1) expect((await hook(context, "wf-limit")).statusCode).toBe(200);
    await waitForCaptures(context, builder.cookie, "wf-limit", 2);
    await settle();
    expect((await inbox(context, builder.cookie, "wf-limit")).total).toBe(2);
    const view = (await call(context, "GET", "/api/workflows/wf-limit/replay-capture", builder.cookie)).json<{ settings: ReplayCaptureSettingsView }>().settings;
    expect(view).toMatchObject({ candidates: 2, capturedToday: 2, effectiveRate: 1 });
    const metrics = await context.app.inject({ method: "GET", url: "/metrics" });
    if (metrics.statusCode === 200) {
      expect(metrics.body).toContain('replay_captures_total{outcome="captured"} 2');
      expect(metrics.body).toContain('replay_captures_total{outcome="skipped_daily_limit"} 2');
    }
  });

  it("drops a run whose status is not wanted at completion", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    await save(context, hookWorkflow("wf-status"));
    await enableCapture(context, builder.cookie, "wf-status", { onlyStatuses: ["error"] });
    await hook(context, "wf-status");
    await settle();
    expect((await inbox(context, builder.cookie, "wf-status")).total).toBe(0);
    // A miss does not use up the day.
    const view = (await call(context, "GET", "/api/workflows/wf-status/replay-capture", builder.cookie)).json<{ settings: ReplayCaptureSettingsView }>().settings;
    expect(view.capturedToday).toBe(0);
  });

  it("captures execute-API runs made with an API key, never editor (session) runs; the run stays `manual` everywhere else", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    // The output echoes the trigger the workflow sees: a template branching on trigger_type == "manual" behaves as before.
    await save(context, hookWorkflow("wf-api", "trigger={{trigger_type}}"));
    await enableCapture(context, builder.cookie, "wf-api", { maxPerDay: 10 });
    const key = (await call(context, "POST", "/api/auth/api-keys", builder.cookie, { name: "CI" })).json<{ key: string }>().key;
    const viaKey = await context.app.inject({ method: "POST", url: "/api/workflows/wf-api/execute", headers: { authorization: `Bearer ${key}` }, payload: { input: { user_prompt: `hi ${EMAIL}` } } });
    expect(viaKey.statusCode, viaKey.body).toBe(200);
    expect(viaKey.body).toContain("trigger=manual");
    const streamed = await context.app.inject({ method: "POST", url: "/api/workflows/wf-api/execute/stream", headers: { authorization: `Bearer ${key}` }, payload: {} });
    expect(streamed.statusCode).toBe(200);
    expect(streamed.body).toContain('"triggerType":"manual_stream"');
    expect((await call(context, "POST", "/api/workflows/wf-api/execute", builder.cookie, {})).statusCode).toBe(200);
    // A body cannot claim the API-key marker: a session run that names it is still not captured.
    expect((await call(context, "POST", "/api/workflows/wf-api/execute", builder.cookie, { captureSource: "api_key", input: {} })).statusCode).toBeLessThan(500);
    const items = await waitForCaptures(context, builder.cookie, "wf-api", 2);
    await settle();
    expect((await inbox(context, builder.cookie, "wf-api")).total).toBe(2);
    expect(items.map((item) => item.sourceTriggerType).sort()).toEqual(["manual", "manual_stream"]);
    expect(items.every((item) => item.name.startsWith("Captured API-key run"))).toBe(true);
    // Run history and its filter are unchanged: every run of the execute routes is a manual run, API-key runs included.
    const manual = (await call(context, "GET", "/api/executions?workflowId=wf-api&triggerType=manual&pageSize=50", builder.cookie)).json<{ items: Array<{ id: string }> }>();
    expect(manual.items.length).toBeGreaterThanOrEqual(3);
    const captured: Array<string | null> = [];
    for (const item of items) captured.push((await context.store.getReplayRecording(item.id))!.sourceExecutionId);
    for (const executionId of captured) {
      const history = (await context.store.getExecutionHistory(executionId!))!;
      expect(["manual", "manual_stream"]).toContain(history.triggerType);
    }
    const manualCaptured: Array<string | null> = [];
    for (const id of captured) if ((await context.store.getExecutionHistory(id!))!.triggerType === "manual") manualCaptured.push(id);
    expect(manual.items.map((item) => item.id)).toEqual(expect.arrayContaining(manualCaptured));
    expect((await call(context, "GET", "/api/executions?triggerType=api_execute", builder.cookie)).json<{ items: unknown[] }>().items).toEqual([]);

    // Ruling (b): the recording says an API key started it; the inbox filters on that, not on the trigger.
    expect(items.every((item) => item.source === "api_key" && item.capabilities.capture?.source === "api_key")).toBe(true);
    expect((await inbox(context, builder.cookie, "wf-api", "?trigger=api_key")).total).toBe(2);
    expect((await inbox(context, builder.cookie, "wf-api", "?trigger=webhook")).total).toBe(0);
    await save(context, hookWorkflow("wf-api-hook"));
    await enableCapture(context, builder.cookie, "wf-api-hook");
    await hook(context, "wf-api-hook", { user_prompt: "from a webhook" });
    const [webhookCapture] = await waitForCaptures(context, builder.cookie, "wf-api-hook", 1);
    expect(webhookCapture!.source).toBeNull();
    expect((await inbox(context, builder.cookie, "wf-api-hook", "?trigger=api_key")).total).toBe(0);
    // A golden-set file never carries the source back in: an import drops it.
    const promoted = await call(context, "POST", `/api/replay/captures/${items[0]!.id}/promote`, builder.cookie, {});
    expect(promoted.statusCode, promoted.body).toBe(200);
    const datasetId = promoted.json<{ result: { datasetId: string } }>().result.datasetId;
    const file = (await call(context, "GET", `/api/eval/datasets/${datasetId}/export`, builder.cookie)).json<{ cases: Array<{ recording: { capture?: Record<string, unknown> } }> }>();
    file.cases[0]!.recording.capture = { ...file.cases[0]!.recording.capture, source: "api_key" };
    const imported = await call(context, "POST", "/api/eval/datasets/import", builder.cookie, { file, workflowId: "wf-api", name: "Imported API-key run" });
    expect(imported.statusCode, imported.body).toBe(201);
    const importedId = (await context.store.listEvalFixtures(imported.json<{ dataset: { id: string } }>().dataset.id))[0]!.recordingId!;
    expect((await context.store.getReplayRecording(importedId))!.capabilities.capture?.source).toBeUndefined();
  });

  it("a run that pauses for approval keeps nothing and frees its slot; its resume is never captured", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const workflow = {
      ...hookWorkflow("wf-gate"),
      nodes: [
        node("hook", "webhook_input", { path: "hook-wf-gate", method: "POST" }),
        node("gate", "approval_gate", { message: "Send?", approverRoles: ["admin"], timeoutMinutes: 60, timeoutOutcome: "fallback" }, 100),
        node("sent", "output", { responseTemplate: "sent" }, 200),
        node("stopped", "output", { responseTemplate: "rejected" }, 200),
        node("late", "output", { responseTemplate: "late" }, 200)
      ],
      edges: [
        { id: "e1", source: "hook", target: "gate" },
        { id: "e2", source: "gate", sourceHandle: "approved", target: "sent" },
        { id: "e3", source: "gate", sourceHandle: "rejected", target: "stopped" },
        { id: "e4", source: "gate", sourceHandle: "timed_out", target: "late" }
      ]
    } as Workflow;
    await save(context, workflow);
    await enableCapture(context, builder.cookie, "wf-gate", { maxPerDay: 1 });
    const paused = await hook(context, "wf-gate", { user_prompt: `pay ${EMAIL}` });
    expect(paused.statusCode, paused.body).toBeLessThan(300);
    const executionId = (await context.store.listExecutionHistory({ workflowId: "wf-gate", page: 1, pageSize: 5 })).items[0]!.id;
    expect((await context.store.getExecutionHistory(executionId))?.status).toBe("waiting_approval");
    await settle();
    // Nothing kept, and the day's only slot is free again.
    expect((await inbox(context, builder.cookie, "wf-gate")).total).toBe(0);
    const view = (await call(context, "GET", "/api/workflows/wf-gate/replay-capture", builder.cookie)).json<{ settings: ReplayCaptureSettingsView }>().settings;
    expect(view.capturedToday).toBe(0);

    const approved = await call(context, "POST", `/api/approvals/${executionId}/approve`, admin.cookie, {});
    expect(approved.statusCode, approved.body).toBe(200);
    const until = Date.now() + 10_000;
    while ((await context.store.getExecutionHistory(executionId))?.status !== "success") {
      if (Date.now() > until) throw new Error(`Resume did not finish: ${(await context.store.getExecutionHistory(executionId))?.status}`);
      await sleep(25);
    }
    await settle();
    expect((await inbox(context, builder.cookie, "wf-gate")).total).toBe(0);
    expect((await context.store.listReplayRecordings({})).total).toBe(0);
    // The free slot is real: the next production run is captured.
    await hook(context, "wf-gate", { user_prompt: "again" });
    await settle();
    const fresh = await call(context, "GET", "/api/workflows/wf-gate/replay-capture", builder.cookie);
    expect(fresh.json<{ settings: ReplayCaptureSettingsView }>().settings.capturedToday).toBeLessThanOrEqual(1);
  });

  it("drops a run whose content cannot be scanned completely (fail closed), and deep input never reaches storage raw", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    await save(context, hookWorkflow("wf-deep"));
    // Over the API: content past the history depth limit is already a placeholder before masking, never the raw value.
    await enableCapture(context, builder.cookie, "wf-deep", { maxPerDay: 10 });
    let deep: Record<string, unknown> = { mail: EMAIL };
    for (let i = 0; i < 70; i += 1) deep = { next: deep };
    expect((await hook(context, "wf-deep", deep)).statusCode).toBe(200);
    for (const item of (await inbox(context, builder.cookie, "wf-deep")).items) expect(await rawRecordingText(context, item.id)).not.toContain(EMAIL);
    await settle();
    for (const item of (await inbox(context, builder.cookie, "wf-deep")).items) expect(await rawRecordingText(context, item.id)).not.toContain(EMAIL);

    // The service: a part masking could not scan completely drops the capture with outcome dropped_unscannable.
    const executionId = (await context.store.listExecutionHistory({ workflowId: "wf-deep", page: 1, pageSize: 5 })).items[0]!.id;
    const outcomes: string[] = [];
    const capture = new ReplayCaptureService({
      store: context.store,
      recordings: {
        createCapture: async () => {
          throw new MaskUnscannableError("too deep");
        }
      } as never,
      datasets: {} as never,
      surrogateKey: SURROGATE_KEY,
      dictionariesFor: async () => [],
      dictionaryClasses: async () => [],
      publishedVersion: async () => null,
      deployment: { enabled: true, maxRate: 1, retentionDays: 14, maxPerWorkflow: 200, maxBytesPerWorkflow: 209_715_200 },
      log: { warn: () => undefined, info: () => undefined },
      metric: (outcome) => outcomes.push(outcome)
    });
    const ticket = (await capture.decide({ workflow: { id: "wf-deep" }, channel: "production", triggerType: "webhook", releaseVersion: null, excluded: false }))!;
    capture.finish(ticket, { executionId, workflow: { id: "wf-deep", name: "x", projectId: "default" }, plan: {} as never });
    await capture.idle();
    expect(outcomes).toEqual(["dropped_unscannable"]);
    expect(capture.inFlightFor("wf-deep")).toBe(0);
  });

  it("reads the settings again when the capture is built: capture turned off mid-run discards it", async () => {
    const context = await createTestContext();
    await save(context, hookWorkflow("wf-mid"));
    await context.store.saveReplayCaptureSettings({ workflowId: "wf-mid", enabled: true, rate: 1, maxPerDay: 10, onlyStatuses: ["success"], dlp: true, dlpOffReason: null, targetDatasetId: null, updatedBy: null });
    const outcomes: string[] = [];
    const created: string[] = [];
    const capture = new ReplayCaptureService({
      store: context.store,
      recordings: { createCapture: async () => created.push("x") } as never,
      datasets: {} as never,
      surrogateKey: SURROGATE_KEY,
      dictionariesFor: async () => [],
      dictionaryClasses: async () => [],
      publishedVersion: async () => null,
      deployment: { enabled: true, maxRate: 1, retentionDays: 14, maxPerWorkflow: 200, maxBytesPerWorkflow: 209_715_200 },
      log: { warn: () => undefined, info: () => undefined },
      metric: (outcome) => outcomes.push(outcome)
    });
    const ticket = (await capture.decide({ workflow: { id: "wf-mid" }, channel: "production", triggerType: "cron", releaseVersion: null, excluded: false }))!;
    expect(ticket.inputOrigin).toBe("external");
    expect(capture.inFlightFor("wf-mid")).toBe(1);
    await context.store.saveReplayCaptureSettings({ workflowId: "wf-mid", enabled: false, rate: 1, maxPerDay: 10, onlyStatuses: ["success"], dlp: true, dlpOffReason: null, targetDatasetId: null, updatedBy: null });
    capture.finish(ticket, { executionId: "exec-none", workflow: { id: "wf-mid", name: "x", projectId: "default" }, plan: {} as never });
    await capture.idle();
    expect(created).toEqual([]);
    expect(outcomes).toContain("discarded_disabled");
    expect(capture.inFlightFor("wf-mid")).toBe(0);
    // A ticket is given back once, however many paths reach it.
    capture.abandon(ticket);
    expect(capture.inFlightFor("wf-mid")).toBe(0);
  });

  it("never captures editor runs, test webhooks or replays", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    await save(context, hookWorkflow("wf-manual"));
    await enableCapture(context, builder.cookie, "wf-manual");
    expect((await call(context, "POST", "/api/workflows/wf-manual/execute", builder.cookie, {})).statusCode).toBe(200);
    expect((await context.app.inject({ method: "POST", url: "/webhook-test/hook-wf-manual", payload: {} })).statusCode).toBe(200);
    // A golden run saved by hand, then replayed.
    const run = await call(context, "POST", "/api/workflows/wf-manual/execute", builder.cookie, { record: true });
    const saved = await call(context, "POST", "/api/replay/recordings", builder.cookie, { executionId: run.json<{ executionId: string }>().executionId, name: "Hand" });
    expect(saved.statusCode, saved.body).toBe(201);
    const replayed = await call(context, "POST", `/api/replay/recordings/${saved.json<{ recording: ReplayRecordingSummary }>().recording.id}/replay`, builder.cookie, {});
    expect(replayed.statusCode, replayed.body).toBe(200);
    await settle();
    expect((await inbox(context, builder.cookie, "wf-manual")).total).toBe(0);
  });

  it("evicts the oldest candidate at the per-workflow cap; the golden cap counts golden runs only", async () => {
    const context = await createTestContext({ REPLAY_CAPTURES_MAX_PER_WORKFLOW: "2", REPLAY_RECORDINGS_MAX_PER_WORKFLOW: "1" });
    const builder = await login(context, "builder");
    await save(context, hookWorkflow("wf-evict"));
    await enableCapture(context, builder.cookie, "wf-evict", { maxPerDay: 10 });
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      await hook(context, "wf-evict");
      const items = await waitForCaptures(context, builder.cookie, "wf-evict", Math.min(i + 1, 2));
      await settle();
      ids.push(...items.map((item) => item.id).filter((id) => !ids.includes(id)));
    }
    const left = (await inbox(context, builder.cookie, "wf-evict")).items.map((item) => item.id);
    expect(left).toHaveLength(2);
    expect(left).not.toContain(ids[0]);
    // Candidates do not count toward REPLAY_RECORDINGS_MAX_PER_WORKFLOW (1): a run can still be saved by hand.
    const run = await call(context, "POST", "/api/workflows/wf-evict/execute", builder.cookie, {});
    const saved = await call(context, "POST", "/api/replay/recordings", builder.cookie, { executionId: run.json<{ executionId: string }>().executionId, name: "Hand" });
    expect(saved.statusCode, saved.body).toBe(201);
    // ...and promoting now hits the golden cap.
    const promote = await call(context, "POST", `/api/replay/captures/${left[0]}/promote`, builder.cookie, {});
    expect(promote.statusCode).toBe(409);
    expect(promote.json<{ error: string }>().error).toMatch(/REPLAY_RECORDINGS_MAX_PER_WORKFLOW/);
    // A refused promote leaves nothing behind: no empty "Captured" set.
    const sets = (await call(context, "GET", "/api/eval/datasets?workflowId=wf-evict", builder.cookie)).json<{ datasets: Array<{ name: string }> }>().datasets;
    expect(sets.map((set) => set.name)).not.toContain("Captured");
    expect(await context.store.getReplayRecordingSummary(left[0]!)).toMatchObject({ status: "candidate" });
  });

  it("evicts the oldest candidates to stay within REPLAY_CAPTURES_MAX_BYTES_PER_WORKFLOW", async () => {
    const context = await createTestContext({ REPLAY_CAPTURES_MAX_BYTES_PER_WORKFLOW: "1048576" });
    const builder = await login(context, "builder");
    await save(context, hookWorkflow("wf-bytes"));
    await enableCapture(context, builder.cookie, "wf-bytes", { maxPerDay: 10 });
    // Words, not one long token (a long token-like string is scrubbed to a placeholder).
    const note = (letter: string) => `${letter}${letter} `.repeat(60_000);
    await hook(context, "wf-bytes", { note: note("a") });
    const [first] = await waitForCaptures(context, builder.cookie, "wf-bytes", 1);
    await hook(context, "wf-bytes", { note: note("b") });
    await waitForCaptures(context, builder.cookie, "wf-bytes", 2);
    await hook(context, "wf-bytes", { note: note("c") });
    await hook(context, "wf-bytes", { note: note("d") });
    const until = Date.now() + 30_000;
    while (await context.store.getReplayRecordingSummary(first!.id) && Date.now() < until) await sleep(50);
    await settle();
    const left = (await inbox(context, builder.cookie, "wf-bytes")).items;
    expect(left.map((item) => item.id)).not.toContain(first!.id);
    expect(left.length).toBeGreaterThanOrEqual(1);
    expect(await context.store.sumReplayCaptureBytesForWorkflow("wf-bytes")).toBeLessThanOrEqual(1_048_576);
  }, 60_000);

  it("refuses a capture whose fixed parts are over REPLAY_RECORDING_MAX_BYTES, and the run is unaffected", async () => {
    const context = await createTestContext({ REPLAY_RECORDING_MAX_BYTES: "16384" });
    const builder = await login(context, "builder");
    await save(context, hookWorkflow("wf-big"));
    await enableCapture(context, builder.cookie, "wf-big");
    const response = await hook(context, "wf-big", { blob: "x".repeat(80_000) });
    expect(response.statusCode).toBe(200);
    await settle();
    expect((await inbox(context, builder.cookie, "wf-big")).total).toBe(0);
    // A small run still fits.
    await hook(context, "wf-big", { small: true });
    await waitForCaptures(context, builder.cookie, "wf-big", 1);
  });

  it("deletes candidates past retention at startup and keeps golden runs", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    await save(context, hookWorkflow("wf-old"));
    await enableCapture(context, builder.cookie, "wf-old", { maxPerDay: 10 });
    await hook(context, "wf-old");
    await hook(context, "wf-old");
    const [first, second] = await waitForCaptures(context, builder.cookie, "wf-old", 2);
    const promoted = await call(context, "POST", `/api/replay/captures/${second!.id}/promote`, builder.cookie, {});
    expect(promoted.statusCode, promoted.body).toBe(200);
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    await testSql(context.store).run("UPDATE replay_recordings SET captured_at = ?", old);
    await context.app.close();
    const reopened = await createTestContext({}, { tempDir: context.tempDir, dbPath: context.dbPath });
    contexts.push(reopened);
    contexts.splice(contexts.indexOf(context), 1);
    expect(await reopened.store.getReplayRecordingSummary(first!.id)).toBeNull();
    expect(await reopened.store.getReplayRecordingSummary(second!.id)).toMatchObject({ status: "golden" });
  });
});

describe("masking and replay", () => {
  it("masks personal data everywhere with surrogates, labels the nodes, and a models: replay job still hits the masked tape", async () => {
    const model = await startEchoModel();
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const secret = await context.secretService.createSecret({ name: "Model key", provider: "openai", value: MODEL_KEY });
    await save(context, agentWorkflow(model.baseUrl, secret.secretId));
    await enableCapture(context, builder.cookie, "wf-agent");
    const prompt = `Customer ${EMAIL} paid with card ${CARD}; escalate to support@acme.test`;
    const response = await hook(context, "wf-agent", { user_prompt: prompt });
    expect(response.statusCode, response.body).toBe(200);
    expect(model.calls).toHaveLength(1);
    const [captured] = await waitForCaptures(context, builder.cookie, "wf-agent", 1);
    expect(captured).toMatchObject({ status: "candidate", createdBy: null, sourceTriggerType: "webhook", masked: true });
    expect(captured!.dataClasses).toEqual(expect.arrayContaining(["email", "card_number"]));
    expect(captured!.capabilities).toMatchObject({ models: "tape", mcp: "cassette" });

    // No raw value anywhere in the stored row; the workflow's own literal stays.
    const text = await rawRecordingText(context, captured!.id);
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain(CARD);
    expect(text).not.toContain("4111111111111111");
    expect(text).toContain(surrogateFor(EMAIL, "email", SURROGATE_KEY));
    expect(text).toContain("support@acme.test");
    expect(text).not.toContain(MODEL_KEY);

    // Per-node labels from the scan.
    const detail = (await call(context, "GET", `/api/replay/recordings/${captured!.id}`, builder.cookie)).json<{ recording: ReplayRecordingDetail }>().recording;
    const facts = detail.facts as RunFacts;
    const hookNode = facts.nodes.find((entry) => entry.nodeId === "hook")!;
    // Provenance is where the content came from (a webhook: outside), never derived from the scan.
    expect(hookNode.labels).toMatchObject({ source: "scan", provenance: ["untrusted_external"] });
    expect(hookNode.labels!.dataClasses).toEqual(expect.arrayContaining(["email", "card_number"]));
    const agentNode = facts.nodes.find((entry) => entry.nodeId === "agent_1")!;
    expect(agentNode.labels!.dataClasses).toContain("email");

    // Promote into the auto-created "Captured" set, then replay from the tape: no model call.
    const promoted = await call(context, "POST", `/api/replay/captures/${captured!.id}/promote`, builder.cookie, {});
    expect(promoted.statusCode, promoted.body).toBe(200);
    const datasetId = promoted.json<{ result: { datasetId: string } }>().result.datasetId;
    const sets = (await call(context, "GET", "/api/eval/datasets?workflowId=wf-agent", builder.cookie)).json<{ datasets: Array<{ id: string; name: string }> }>().datasets;
    expect(sets.find((set) => set.id === datasetId)?.name).toBe("Captured");
    const job = await runJob(context, builder.cookie, { datasetIds: [datasetId], models: "replay" });
    expect(job.status, job.error ?? "").toBe("completed");
    expect(job.results.map((result) => result.status)).toEqual(["pass"]);
    expect(model.calls).toHaveLength(1);

    // A golden-set file keeps the node labels and the masked flag, out and back in.
    const exported = await call(context, "GET", `/api/eval/datasets/${datasetId}/export`, builder.cookie);
    expect(exported.statusCode, exported.body).toBe(200);
    const file = exported.json<{ cases: Array<{ recording: { capture?: { masked: boolean; dataClasses: string[] }; facts: RunFacts } }> }>();
    const exportedCase = file.cases[0]!.recording;
    expect(exportedCase.capture).toMatchObject({ masked: true, dataClasses: expect.arrayContaining(["email", "card_number"]) });
    expect(exportedCase.facts.nodes.find((entry) => entry.nodeId === "hook")!.labels).toMatchObject({ source: "scan", provenance: ["untrusted_external"] });
    const imported = await call(context, "POST", "/api/eval/datasets/import", builder.cookie, { file, workflowId: "wf-agent", name: "Imported capture" });
    expect(imported.statusCode, imported.body).toBe(201);
    const importedRecording = (await context.store.listEvalFixtures(imported.json<{ dataset: { id: string } }>().dataset.id))[0]!.recordingId!;
    const importedDetail = (await call(context, "GET", `/api/replay/recordings/${importedRecording}`, builder.cookie)).json<{ recording: ReplayRecordingDetail }>().recording;
    expect(importedDetail.capabilities.capture).toMatchObject({ masked: true, dataClasses: expect.arrayContaining(["email", "card_number"]) });
    expect((importedDetail.facts as RunFacts).nodes.find((entry) => entry.nodeId === "hook")!.labels!.dataClasses).toEqual(expect.arrayContaining(["email"]));
  }, 60_000);

  it("stores runs unmasked when an admin turned masking off with a reason (audited)", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    await save(context, hookWorkflow("wf-raw"));
    await enableCapture(context, builder.cookie, "wf-raw");
    expect((await call(context, "PUT", "/api/workflows/wf-raw/replay-capture", builder.cookie, { dlp: false, reason: "debugging" })).statusCode).toBe(403);
    expect((await call(context, "PUT", "/api/workflows/wf-raw/replay-capture", admin.cookie, { dlp: false })).statusCode).toBe(400);
    const off = await call(context, "PUT", "/api/workflows/wf-raw/replay-capture", admin.cookie, { dlp: false, reason: "Synthetic test traffic only" });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json<{ settings: ReplayCaptureSettingsView }>().settings).toMatchObject({ dlp: false, dlpOffReason: "Synthetic test traffic only" });
    // Builders do not see the reason.
    const builderView = (await call(context, "GET", "/api/workflows/wf-raw/replay-capture", builder.cookie)).json<{ settings: ReplayCaptureSettingsView }>().settings;
    expect(builderView).toMatchObject({ dlp: false, dlpOffReason: null });
    const audits = (await context.store.listAuditLogs({ pageSize: 200 })).items.map((entry) => entry.eventType);
    expect(audits).toContain("replay.capture.masking_disabled");
    await hook(context, "wf-raw", { user_prompt: `mail ${EMAIL}` });
    const [captured] = await waitForCaptures(context, builder.cookie, "wf-raw", 1);
    expect(captured).toMatchObject({ masked: false, dataClasses: [] });
    expect(await rawRecordingText(context, captured!.id)).toContain(EMAIL);
  });
});

describe("inbox routes and authorization", () => {
  async function setup() {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const viewer = await login(context, "viewer");
    const outsider = await login(context, "builder", "outsider");
    await save(context, hookWorkflow("wf-inbox"));
    return { context, admin, builder, viewer, outsider };
  }

  it("answers 404 to users who cannot read the workflow and 403 to those who cannot change it, on every route", async () => {
    const { context, builder, viewer, outsider } = await setup();
    await enableCapture(context, builder.cookie, "wf-inbox");
    await hook(context, "wf-inbox", { user_prompt: EMAIL });
    const [captured] = await waitForCaptures(context, builder.cookie, "wf-inbox", 1);
    const id = captured!.id;

    expect((await call(context, "GET", "/api/workflows/wf-inbox/replay-capture", viewer.cookie)).statusCode).toBe(200);
    expect((await call(context, "GET", "/api/workflows/wf-inbox/replay-captures", viewer.cookie)).statusCode).toBe(200);
    expect((await call(context, "PUT", "/api/workflows/wf-inbox/replay-capture", viewer.cookie, { enabled: false })).statusCode).toBe(403);
    expect((await call(context, "POST", `/api/replay/captures/${id}/promote`, viewer.cookie, {})).statusCode).toBe(403);
    expect((await call(context, "DELETE", `/api/replay/captures/${id}`, viewer.cookie)).statusCode).toBe(403);
    expect((await call(context, "POST", "/api/replay/captures/discard", viewer.cookie, { ids: [id] })).statusCode).toBe(403);

    // A builder locked out of the workflow's project cannot see it at all.
    await context.store.upsertCustomRole({ id: "none-default", projectId: "default", name: "No access", permissions: [] });
    await context.store.upsertProjectRole({ userId: outsider.id, projectId: "default", role: "custom", customRoleId: "none-default" });
    {
      expect((await call(context, "GET", "/api/workflows/wf-inbox/replay-capture", outsider.cookie)).statusCode).toBe(404);
      expect((await call(context, "GET", "/api/workflows/wf-inbox/replay-captures", outsider.cookie)).statusCode).toBe(404);
      expect((await call(context, "PUT", "/api/workflows/wf-inbox/replay-capture", outsider.cookie, { enabled: false })).statusCode).toBe(404);
      expect((await call(context, "POST", `/api/replay/captures/${id}/promote`, outsider.cookie, {})).statusCode).toBe(404);
      expect((await call(context, "DELETE", `/api/replay/captures/${id}`, outsider.cookie)).statusCode).toBe(404);
      const bulk = (await call(context, "POST", "/api/replay/captures/promote", outsider.cookie, { ids: [id] })).json<{ results: Array<{ ok: boolean; error: string }> }>();
      expect(bulk.results).toEqual([{ id, ok: false, error: "Captured run not found" }]);
    }
    expect((await call(context, "POST", "/api/replay/recordings/find-subject", builder.cookie, { value: EMAIL })).statusCode).toBe(403);
    expect(await context.store.getReplayRecordingSummary(id)).toMatchObject({ status: "candidate" });
  });

  it("validates settings: rate ceiling, target set of this workflow", async () => {
    const { context, builder } = await setup();
    const capped = await createTestContext({ REPLAY_CAPTURE_MAX_RATE: "0.2" });
    const cappedBuilder = await login(capped, "builder");
    await save(capped, hookWorkflow("wf-cap"));
    const over = await call(capped, "PUT", "/api/workflows/wf-cap/replay-capture", cappedBuilder.cookie, { enabled: true, rate: 0.5 });
    expect(over.statusCode).toBe(400);
    expect(over.json<{ error: string }>().error).toMatch(/REPLAY_CAPTURE_MAX_RATE/);
    expect((await call(capped, "PUT", "/api/workflows/wf-cap/replay-capture", cappedBuilder.cookie, { enabled: true, rate: 0.2 })).statusCode).toBe(200);

    await save(context, hookWorkflow("wf-elsewhere"));
    const foreign = await call(context, "POST", "/api/eval/datasets", builder.cookie, { name: "Other set", workflowId: "wf-elsewhere" });
    const foreignId = foreign.json<{ dataset: { id: string } }>().dataset.id;
    expect((await call(context, "PUT", "/api/workflows/wf-inbox/replay-capture", builder.cookie, { targetDatasetId: foreignId })).statusCode).toBe(400);
    expect((await call(context, "PUT", "/api/workflows/wf-inbox/replay-capture", builder.cookie, { rate: 0 })).statusCode).toBe(400);
    expect((await call(context, "PUT", "/api/workflows/wf-inbox/replay-capture", builder.cookie, { onlyStatuses: [] })).statusCode).toBe(400);
    expect((await call(context, "PUT", "/api/workflows/wf-inbox/replay-capture", builder.cookie, { surprise: 1 })).statusCode).toBe(400);
  });

  it("filters the inbox, promotes in bulk to the target set, discards, and candidates stay out of golden-run paths", async () => {
    const { context, builder } = await setup();
    const target = (await call(context, "POST", "/api/eval/datasets", builder.cookie, { name: "Regression", workflowId: "wf-inbox" })).json<{ dataset: { id: string } }>().dataset.id;
    await enableCapture(context, builder.cookie, "wf-inbox", { maxPerDay: 10, targetDatasetId: target });
    for (let i = 0; i < 4; i += 1) await hook(context, "wf-inbox", { user_prompt: `case ${i}` });
    const items = await waitForCaptures(context, builder.cookie, "wf-inbox", 4);
    expect((await inbox(context, builder.cookie, "wf-inbox", "?trigger=webhook")).total).toBe(4);
    expect((await inbox(context, builder.cookie, "wf-inbox", "?trigger=chat")).total).toBe(0);
    expect((await inbox(context, builder.cookie, "wf-inbox", "?runStatus=error")).total).toBe(0);
    expect((await inbox(context, builder.cookie, "wf-inbox", `?from=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`)).total).toBe(0);

    const [a, b, c, d] = items.map((item) => item.id);
    // Candidates are not golden runs: not listed, not addable, not replayable, not exported.
    const golden = (await call(context, "GET", "/api/replay/recordings?workflowId=wf-inbox", builder.cookie)).json<{ total: number }>();
    expect(golden.total).toBe(0);
    expect((await call(context, "POST", `/api/eval/datasets/${target}/recordings`, builder.cookie, { recordingId: a })).statusCode).toBe(409);
    expect((await call(context, "POST", `/api/replay/recordings/${a}/replay`, builder.cookie, {})).statusCode).toBe(409);

    const bulk = await call(context, "POST", "/api/replay/captures/promote", builder.cookie, { ids: [a, b, "rec_missing"] });
    expect(bulk.statusCode, bulk.body).toBe(200);
    const results = bulk.json<{ results: Array<{ id: string; ok: boolean; datasetId?: string }>; promoted: number }>();
    expect(results.promoted).toBe(2);
    expect(results.results.filter((result) => result.ok).every((result) => result.datasetId === target)).toBe(true);
    expect((await context.store.listEvalFixtures(target)).map((fixture) => fixture.recordingId).sort()).toEqual([a, b].sort());
    expect(await context.store.getReplayRecordingSummary(a!)).toMatchObject({ status: "golden", createdBy: "builder@example.com" });
    expect((await context.store.getReplayRecordingSummary(a!))!.capturedAt).toBeTruthy();
    // Promoting twice is refused: it is no longer in the inbox.
    expect((await call(context, "POST", `/api/replay/captures/${a}/promote`, builder.cookie, {})).statusCode).toBe(404);

    expect((await call(context, "DELETE", `/api/replay/captures/${c}`, builder.cookie)).statusCode).toBe(200);
    const discarded = await call(context, "POST", "/api/replay/captures/discard", builder.cookie, { ids: [d, a] });
    expect(discarded.json<{ discarded: number }>().discarded).toBe(1);
    expect(await context.store.getReplayRecordingSummary(c!)).toBeNull();
    expect(await context.store.getReplayRecordingSummary(d!)).toBeNull();
    // A golden run is not discarded by the inbox route.
    expect(await context.store.getReplayRecordingSummary(a!)).toMatchObject({ status: "golden" });
    expect((await inbox(context, builder.cookie, "wf-inbox")).total).toBe(0);

    // Export carries promoted runs only.
    const exported = await call(context, "GET", `/api/eval/datasets/${target}/export`, builder.cookie);
    expect(exported.statusCode, exported.body).toBe(200);
    const audits = (await context.store.listAuditLogs({ pageSize: 200 })).items.map((entry) => entry.eventType);
    expect(audits).toEqual(expect.arrayContaining(["replay.capture.settings_updated", "replay.capture.promoted", "replay.capture.discarded"]));
  });
});

describe("data-subject lookup", () => {
  it("finds a value as its surrogate in masked captures and raw in hand-saved runs, and deletes them with their cases", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    await save(context, hookWorkflow("wf-subject"));
    await save(context, hookWorkflow("wf-bystander"));
    await enableCapture(context, builder.cookie, "wf-subject", { maxPerDay: 10 });
    await hook(context, "wf-subject", { user_prompt: `Hi, I am ${EMAIL.toUpperCase()}` });
    await hook(context, "wf-subject", { user_prompt: "nothing personal" });
    const captures = await waitForCaptures(context, builder.cookie, "wf-subject", 2);
    const promoted = await call(context, "POST", `/api/replay/captures/${captures.find((item) => item.dataClasses.includes("email"))!.id}/promote`, builder.cookie, {});
    expect(promoted.statusCode, promoted.body).toBe(200);
    // A hand-saved golden run keeps raw values.
    const run = await call(context, "POST", "/api/workflows/wf-bystander/execute", builder.cookie, { input: { user_prompt: `contact ${EMAIL}` } });
    const saved = await call(context, "POST", "/api/replay/recordings", builder.cookie, { executionId: run.json<{ executionId: string }>().executionId, name: "Hand" });
    expect(saved.statusCode, saved.body).toBe(201);

    const found = await call(context, "POST", "/api/replay/recordings/find-subject", admin.cookie, { value: EMAIL });
    expect(found.statusCode, found.body).toBe(200);
    const result = found.json<ReplayFindSubjectResult>();
    expect(found.body).not.toContain(EMAIL);
    expect(result.classesTried).toContain("email");
    const recordings = result.matches.filter((match) => match.kind === "recording");
    expect(recordings).toHaveLength(2);
    const masked = recordings.find((match) => match.workflowId === "wf-subject")!;
    expect(masked).toMatchObject({ status: "golden", matchedAs: ["email"] });
    expect(masked.fields).toContain("input");
    expect(recordings.find((match) => match.workflowId === "wf-bystander")).toMatchObject({ matchedAs: ["raw"] });
    // The promoted run's golden-set case holds the masked input too.
    expect(result.counts.fixture).toBe(1);
    expect(result.covered.length).toBeGreaterThan(0);
    expect(result.notCovered.join(" ")).toMatch(/EXECUTION_HISTORY_RETENTION_DAYS/);
    // Searching deletes nothing.
    expect((await context.store.listReplayRecordings({})).total).toBe(3);

    // A target that does not hold the value is skipped, never deleted.
    const other = captures.find((item) => !item.dataClasses.includes("email"))!;
    const targets = [...result.matches.map((match) => ({ kind: match.kind, id: match.id })), { kind: "recording" as const, id: other.id }];
    const removed = await call(context, "POST", "/api/replay/recordings/find-subject/delete", admin.cookie, { value: EMAIL, targets });
    expect(removed.statusCode, removed.body).toBe(200);
    const outcome = removed.json<ReplayFindSubjectDeleteResult>();
    expect(outcome.deleted.recording).toBe(2);
    expect(outcome.deleted.fixture).toBe(1);
    expect(outcome.skipped).toEqual([{ kind: "recording", id: other.id, reason: "no_match" }]);
    expect((await call(context, "POST", "/api/replay/recordings/find-subject", admin.cookie, { value: EMAIL })).json<ReplayFindSubjectResult>().matches).toEqual([]);
    // The other capture is untouched; the audit names every deleted id, never the value.
    expect((await inbox(context, builder.cookie, "wf-subject")).total).toBe(1);
    const audit = (await context.store.listAuditLogs({ pageSize: 200 })).items.filter((entry) => entry.eventType.startsWith("replay.find_subject"));
    expect(audit.map((entry) => entry.eventType).sort()).toEqual([
      "replay.find_subject.delete_started",
      "replay.find_subject.deleted",
      "replay.find_subject.searched",
      "replay.find_subject.searched"
    ]);
    const trail = JSON.stringify(audit.filter((entry) => entry.eventType === "replay.find_subject.deleted"));
    for (const removedRow of outcome.removed) expect(trail).toContain(`${removedRow.kind}:${removedRow.id}`);
    // The intent row names the rows about to be deleted (the matching targets), never the skipped one.
    const intent = JSON.stringify(audit.find((entry) => entry.eventType === "replay.find_subject.delete_started"));
    for (const match of result.matches) expect(intent).toContain(`${match.kind}:${match.id}`);
    expect(intent).not.toContain(other.id);
    // Every match says why it matched, masked.
    for (const match of result.matches) {
      expect(match.hits.length).toBeGreaterThan(0);
      for (const hit of match.hits) expect(hit.excerpt).not.toContain(EMAIL);
    }
    expect(JSON.stringify(audit)).not.toContain(EMAIL);
  });
});

describe("data-subject lookup: matching and reach", () => {
  it("matches whole values only, needs 6 characters for an unrecognised value, and finds a phone with or without its country code", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    await save(context, hookWorkflow("wf-near"));
    // Hand-saved (unmasked) runs: one holds joann@x.com, one holds the phone with its country code.
    for (const prompt of ["contact joann@x.com", "call +1 415-555-0123 please"]) {
      const run = await call(context, "POST", "/api/workflows/wf-near/execute", builder.cookie, { input: { user_prompt: prompt } });
      expect((await call(context, "POST", "/api/replay/recordings", builder.cookie, { executionId: run.json<{ executionId: string }>().executionId, name: prompt })).statusCode).toBe(201);
    }
    const search = async (value: string) => call(context, "POST", "/api/replay/recordings/find-subject", admin.cookie, { value });
    expect((await search("ann@x.co")).json<ReplayFindSubjectResult>().matches).toEqual([]);
    expect((await search("joann@x.com")).json<ReplayFindSubjectResult>().counts.recording).toBe(1);
    expect((await search("415-555-0123")).json<ReplayFindSubjectResult>().counts.recording).toBe(1);
    expect((await search("+1 (415) 555-0123")).json<ReplayFindSubjectResult>().counts.recording).toBe(1);
    // Digits typed without separators are not classified as a phone: they are searched as exact text only.
    const bare = (await search("4155550123")).json<ReplayFindSubjectResult>();
    expect(bare.dataClass).toBeNull();
    expect(bare.counts.recording).toBe(0);
    const short = await search("inc");
    expect(short.statusCode).toBe(400);
    expect(short.body).not.toContain('"inc"');
    expect((await search("contac")).json<ReplayFindSubjectResult>().matches).toEqual([]);
  });

  it("searches replay results, replay executions and their cassettes, and deletes them", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    await save(context, hookWorkflow("wf-reach", "{{user_prompt}}"));
    const run = await call(context, "POST", "/api/workflows/wf-reach/execute", builder.cookie, { input: { user_prompt: `mail ${EMAIL}` }, record: true });
    const saved = await call(context, "POST", "/api/replay/recordings", builder.cookie, { executionId: run.json<{ executionId: string }>().executionId, name: "Hand" });
    const recordingId = saved.json<{ recording: ReplayRecordingSummary }>().recording.id;
    const set = (await call(context, "POST", "/api/eval/datasets", builder.cookie, { name: "Set", workflowId: "wf-reach" })).json<{ dataset: { id: string } }>().dataset.id;
    expect((await call(context, "POST", `/api/eval/datasets/${set}/recordings`, builder.cookie, { recordingId })).statusCode).toBe(201);
    const job = await runJob(context, builder.cookie, { datasetIds: [set] });
    expect(job.status, job.error ?? "").toBe("completed");

    const found = (await call(context, "POST", "/api/replay/recordings/find-subject", admin.cookie, { value: EMAIL })).json<ReplayFindSubjectResult>();
    expect(found.counts.recording).toBe(1);
    expect(found.counts.fixture).toBe(1);
    expect(found.counts.execution).toBeGreaterThanOrEqual(1);
    const removed = await call(context, "POST", "/api/replay/recordings/find-subject/delete", admin.cookie, {
      value: EMAIL,
      targets: found.matches.map((match) => ({ kind: match.kind, id: match.id }))
    });
    expect(removed.statusCode, removed.body).toBe(200);
    const after = (await call(context, "POST", "/api/replay/recordings/find-subject", admin.cookie, { value: EMAIL })).json<ReplayFindSubjectResult>();
    expect(after.counts).toMatchObject({ recording: 0, fixture: 0, eval_result: 0, execution: 0, cassette: 0 });
  }, 60_000);
});

describe("re-review round 2: lookup precision, lifecycle, audit and import trust", () => {
  /** A hand-saved (unmasked) golden run holding `prompt` in its input. */
  async function handSaved(context: TestContext, cookie: string, workflowId: string, prompt: string): Promise<string> {
    const run = await call(context, "POST", `/api/workflows/${workflowId}/execute`, cookie, { input: { user_prompt: prompt } });
    const saved = await call(context, "POST", "/api/replay/recordings", cookie, { executionId: run.json<{ executionId: string }>().executionId, name: prompt.slice(0, 40) });
    expect(saved.statusCode, saved.body).toBe(201);
    return saved.json<{ recording: ReplayRecordingSummary }>().recording.id;
  }

  it("N2: never matches another person's phone or number, still matches the same number in every form, and delete re-checks strictly", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    await save(context, hookWorkflow("wf-probe"));
    // Other people's data (the reviewer's probes).
    const bystanders: string[] = [];
    for (const prompt of ["uk office +44 20 7946 0958", "call +1 912-345-6788", "order 99123456788", "account 777456789012", "invoice no. 2024155551234", "card 4000 0041 5555 1234"]) {
      bystanders.push(await handSaved(context, builder.cookie, "wf-probe", prompt));
    }
    const search = async (value: string) => {
      const response = await call(context, "POST", "/api/replay/recordings/find-subject", admin.cookie, { value });
      expect(response.statusCode, response.body).toBe(200);
      return response.json<ReplayFindSubjectResult>();
    };
    for (const value of ["+1 (207) 946-0958", "123-45-6788", "123456789012", "+1 415-555-1234"]) {
      expect((await search(value)).matches, value).toEqual([]);
    }
    expect((await search("+1 415-555-1234")).dataClass).toBe("phone");
    expect((await search("123-45-6788")).dataClass).toBe("us_ssn");

    // The same number written three ways matches; the bystanders still do not.
    const own: string[] = [];
    for (const prompt of ["e164 +14155551234", "national (415) 555-1234", "dashed 415-555-1234"]) own.push(await handSaved(context, builder.cookie, "wf-probe", prompt));
    const found = await search("+1 415-555-1234");
    expect(found.matches.map((match) => match.id).sort()).toEqual([...own].sort());
    for (const match of found.matches) {
      expect(match.hits[0]).toMatchObject({ matchedAs: "raw", dataClass: "phone" });
      // A masked excerpt: the last two digits and the shape, never the number.
      expect(match.hits[0]!.excerpt).not.toMatch(/555/);
      expect(match.hits[0]!.excerpt).toMatch(/34\]/);
    }

    // Round 3: only the copy written with its country code is certain; the national forms are possible matches, listed after it.
    expect(found.matches.map((match) => match.certainty)).toEqual(["exact", "national_only", "national_only"]);
    expect(found.matches[0]!.id).toBe(own[0]);

    // Delete: bystanders named as targets are re-checked with the same strict test and skipped; possible matches need a confirmation each.
    const removed = await call(context, "POST", "/api/replay/recordings/find-subject/delete", admin.cookie, {
      value: "+1 415-555-1234",
      targets: [...own, ...bystanders].map((id) => ({ kind: "recording", id }))
    });
    expect(removed.statusCode, removed.body).toBe(200);
    const outcome = removed.json<ReplayFindSubjectDeleteResult>();
    expect(outcome.deleted.recording).toBe(1);
    expect(outcome.removed).toEqual([{ kind: "recording", id: own[0] }]);
    expect(outcome.skipped.filter((entry) => entry.reason === "no_match").map((entry) => entry.id).sort()).toEqual([...bystanders].sort());
    expect(outcome.skipped.filter((entry) => entry.reason === "possible_match_unconfirmed").map((entry) => entry.id).sort()).toEqual([own[1], own[2]].sort());
    for (const id of [...bystanders, own[1]!, own[2]!]) expect(await context.store.getReplayRecordingSummary(id)).not.toBeNull();
    const confirmed = await call(context, "POST", "/api/replay/recordings/find-subject/delete", admin.cookie, {
      value: "+1 415-555-1234",
      targets: [own[1], own[2]].map((id) => ({ kind: "recording", id, confirmPossible: true }))
    });
    expect(confirmed.json<ReplayFindSubjectDeleteResult>().deleted.recording).toBe(2);
    for (const id of bystanders) expect(await context.store.getReplayRecordingSummary(id)).not.toBeNull();
  });

  it("N2/N3: masked captures of two people sharing nine digits are found apart, and a capture is found by its national form", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    await save(context, hookWorkflow("wf-twins"));
    await enableCapture(context, builder.cookie, "wf-twins", { maxPerDay: 10 });
    await hook(context, "wf-twins", { user_prompt: "call +1 312 345 6788" });
    await hook(context, "wf-twins", { user_prompt: "call +1 412 345 6788" });
    await hook(context, "wf-twins", { user_prompt: "ring +47 2212 3456", note: "22123456" });
    const items = await waitForCaptures(context, builder.cookie, "wf-twins", 3);
    for (const item of items) {
      const text = await rawRecordingText(context, item.id);
      expect(text).not.toMatch(/345\D?6788/);
      expect(text).not.toContain("22123456");
      expect(text).not.toMatch(/2212 3456/);
    }
    const search = async (value: string) => (await call(context, "POST", "/api/replay/recordings/find-subject", admin.cookie, { value })).json<ReplayFindSubjectResult>();
    const first = await search("+1 312 345 6788");
    expect(first.matches).toHaveLength(1);
    expect(first.matches[0]!.matchedAs).toEqual(["phone"]);
    expect((await search("+1 412 345 6788")).matches).toHaveLength(1);
    expect(first.matches[0]!.id).not.toBe((await search("+1 412 345 6788")).matches[0]!.id);
    const norway = await search("+47 2212 3456");
    expect(norway.matches).toHaveLength(1);
    expect(norway.matches[0]!.hits.length).toBeGreaterThan(0);
  });

  function lifecycleService(context: TestContext, overrides: Partial<ConstructorParameters<typeof ReplayCaptureService>[0]> = {}) {
    const outcomes: string[] = [];
    const warnings: Array<Record<string, unknown>> = [];
    const service = new ReplayCaptureService({
      store: context.store,
      recordings: { createCapture: async () => ({ id: "x", bytes: 1 }) } as never,
      datasets: {} as never,
      surrogateKey: SURROGATE_KEY,
      dictionariesFor: async () => [],
      dictionaryClasses: async () => [],
      publishedVersion: async () => null,
      deployment: { enabled: true, maxRate: 1, retentionDays: 14, maxPerWorkflow: 200, maxBytesPerWorkflow: 209_715_200 },
      log: { warn: (data) => warnings.push(data), info: () => undefined },
      metric: (outcome) => outcomes.push(outcome),
      ...overrides
    });
    return { service, outcomes, warnings };
  }

  const settings = (workflowId: string, maxPerDay = 10) => ({
    workflowId,
    enabled: true,
    rate: 1,
    maxPerDay,
    onlyStatuses: ["success" as const],
    dlp: true,
    dlpOffReason: null,
    targetDatasetId: null,
    updatedBy: null
  });

  it("N5: leaked tickets are swept before a run is refused for the daily limit", async () => {
    const context = await createTestContext();
    await save(context, hookWorkflow("wf-leak"));
    await context.store.saveReplayCaptureSettings(settings("wf-leak", 1));
    const leaked: Array<Awaited<ReturnType<ReplayCaptureService["decide"]>>> = [];
    let sweeps = 0;
    const { service, outcomes } = lifecycleService(context, {
      sweepStale: () => {
        sweeps += 1;
        // The caller's sweep gives back tickets whose run never wrote its final history.
        for (const ticket of leaked.splice(0)) if (ticket) service.abandon(ticket, "skipped_stale");
      }
    });
    const decide = async () => await service.decide({ workflow: { id: "wf-leak" }, channel: "production", triggerType: "webhook", releaseVersion: null, excluded: false });
    leaked.push(await decide());
    expect(service.inFlightFor("wf-leak")).toBe(1);
    // The day's only slot is held by a leaked ticket: the sweep frees it and this run is sampled.
    expect(await decide()).not.toBeNull();
    expect(sweeps).toBe(1);
    expect(outcomes).toContain("skipped_stale");
    // Still over the limit after a sweep: refused.
    expect(await decide()).toBeNull();
    expect(outcomes).toContain("skipped_daily_limit");
  });

  it("N4: a manual run is eligible only with the server's API-key marker", async () => {
    const context = await createTestContext();
    await save(context, hookWorkflow("wf-marker"));
    await context.store.saveReplayCaptureSettings(settings("wf-marker"));
    const { service } = lifecycleService(context);
    const base = { workflow: { id: "wf-marker" }, channel: "production", releaseVersion: null, excluded: false };
    expect(await service.decide({ ...base, triggerType: "manual" })).toBeNull();
    expect(await service.decide({ ...base, triggerType: "manual_retry", captureSource: "api_key" })).toBeNull();
    expect(await service.decide({ ...base, triggerType: "manual", captureSource: "api_key" })).toMatchObject({ triggerType: "manual", captureSource: "api_key" });
  });

  it("N6: a capture whose run or workflow was deleted while it was being masked is discarded", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    await save(context, hookWorkflow("wf-gone"));
    expect((await hook(context, "wf-gone", { user_prompt: `hi ${EMAIL}` })).statusCode).toBe(200);
    const executionId = (await context.store.listExecutionHistory({ workflowId: "wf-gone", page: 1, pageSize: 5 })).items[0]!.id;
    await context.store.saveReplayCaptureSettings(settings("wf-gone"));
    const saved: string[] = [];
    const { service, outcomes } = lifecycleService(context, {
      recordings: {
        createCapture: async (_input: unknown, capture: { beforeSave: (bytes: number) => Promise<void> }) => {
          // Masking yields; meanwhile someone deletes the run (for privacy, say).
          await testSql(context.store).run("DELETE FROM execution_history WHERE id = ?", executionId);
          await capture.beforeSave(10);
          saved.push("saved");
          return { id: "x", bytes: 10 };
        }
      } as never
    });
    const ticket = (await service.decide({ workflow: { id: "wf-gone" }, channel: "production", triggerType: "webhook", releaseVersion: null, excluded: false }))!;
    service.finish(ticket, { executionId, workflow: { id: "wf-gone", name: "x", projectId: "default" }, plan: {} as never });
    await service.idle();
    expect(saved).toEqual([]);
    expect(outcomes).toEqual(["discarded_source_deleted"]);
    expect(service.inFlightFor("wf-gone")).toBe(0);
    expect((await inbox(context, builder.cookie, "wf-gone")).total).toBe(0);
  });

  it("N9: a capture failure logs the error class and a scrubbed message only", async () => {
    const context = await createTestContext();
    await save(context, hookWorkflow("wf-log"));
    expect((await hook(context, "wf-log", {})).statusCode).toBe(200);
    const executionId = (await context.store.listExecutionHistory({ workflowId: "wf-log", page: 1, pageSize: 5 })).items[0]!.id;
    await context.store.saveReplayCaptureSettings(settings("wf-log"));
    class ParserBlewUp extends Error {
      constructor(message: string) {
        super(message);
        this.name = "ParserBlewUp";
      }
    }
    const { service, outcomes, warnings } = lifecycleService(context, {
      recordings: {
        createCapture: async () => {
          throw new ParserBlewUp(`Unexpected token near ${EMAIL} card ${CARD} key ${MODEL_KEY} account 123456789012`);
        }
      } as never,
      redact: (text) => text.replaceAll(MODEL_KEY, "[REDACTED]")
    });
    const ticket = (await service.decide({ workflow: { id: "wf-log" }, channel: "production", triggerType: "webhook", releaseVersion: null, excluded: false }))!;
    service.finish(ticket, { executionId, workflow: { id: "wf-log", name: "x", projectId: "default" }, plan: {} as never });
    await service.idle();
    expect(outcomes).toEqual(["failed"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ outcome: "failed", errorClass: "ParserBlewUp" });
    const logged = JSON.stringify(warnings[0]);
    for (const raw of [EMAIL, CARD, CARD.replace(/ /g, ""), MODEL_KEY, "123456789012"]) expect(logged).not.toContain(raw);
    expect(logged).toContain("Unexpected token");
  });

  it("N10/N11: the delete intent row is written before anything is deleted (and stays after a crash); a run takes its side rows", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    await save(context, hookWorkflow("wf-crash", "{{user_prompt}}"));
    const ids = [await handSaved(context, builder.cookie, "wf-crash", `one ${EMAIL}`), await handSaved(context, builder.cookie, "wf-crash", `two ${EMAIL}`)];
    // The server stops in the middle of the delete: the first row goes, the second throws.
    const store = context.store as unknown as { deleteSubjectRow: (kind: string, id: string) => unknown };
    const original = store.deleteSubjectRow.bind(context.store);
    let calls = 0;
    store.deleteSubjectRow = (kind, id) => {
      calls += 1;
      if (calls === 2) throw new Error("disk gone");
      return original(kind, id);
    };
    const crashed = await call(context, "POST", "/api/replay/recordings/find-subject/delete", admin.cookie, { value: EMAIL, targets: ids.map((id) => ({ kind: "recording", id })) });
    expect(crashed.statusCode).toBe(500);
    store.deleteSubjectRow = original;
    const audit = (await context.store.listAuditLogs({ pageSize: 200 })).items.filter((entry) => entry.eventType.startsWith("replay.find_subject.delete"));
    expect(audit.map((entry) => entry.eventType)).toEqual(["replay.find_subject.delete_started"]);
    for (const id of ids) expect(JSON.stringify(audit[0])).toContain(`recording:${id}`);
    expect(JSON.stringify(audit)).not.toContain(EMAIL);

    // N11: a replay execution's tool-call, guard-event and usage rows go with it.
    const recordingId = ids[1]!;
    const replayed = await call(context, "POST", `/api/replay/recordings/${recordingId}/replay`, builder.cookie, {});
    expect(replayed.statusCode, replayed.body).toBe(200);
    const found = (await call(context, "POST", "/api/replay/recordings/find-subject", admin.cookie, { value: EMAIL })).json<ReplayFindSubjectResult>();
    const executions = found.matches.filter((match) => match.kind === "execution").map((match) => match.id);
    expect(executions.length).toBeGreaterThan(0);
    const sql = testSql(context.store);
    const now = new Date().toISOString();
    for (const executionId of executions) {
      await sql.run("INSERT INTO mcp_tool_calls (id, execution_id, workflow_id, node_id, adapter_id, tool_name, started_at, ok, error) VALUES (?, ?, 'wf-crash', 'n', 'mock-mcp', 'find', ?, 0, ?)", `tc-${executionId}`, executionId, now, `failed for ${EMAIL}`);
      await sql.run(
        "INSERT INTO guard_events (id, verdict_id, execution_id, node_id, placement, channel, requested_action, effective_action, verdict_action, profile_id, profile_version, profile_hash, created_at) VALUES (?, 'v', ?, 'n', 'input', 'input', 'mask', 'mask', 'mask', 'p', 1, 'h', ?)",
        `ge-${executionId}`,
        executionId,
        now
      );
      await sql.run("INSERT INTO usage_events (id, execution_id, workflow_id, status) VALUES (?, ?, 'wf-crash', 'success')", `ue-${executionId}`, executionId);
    }
    const sideRows = async () => {
      const counts: number[] = [];
      for (const table of ["mcp_tool_calls", "guard_events", "usage_events"]) {
        const row = await sql.get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM ${table} WHERE execution_id IN (${executions.map(() => "?").join(", ")})`, ...executions);
        counts.push(Number(row?.n ?? 0));
      }
      return counts;
    };
    expect((await sideRows()).every((count) => count >= 1)).toBe(true);
    const removed = await call(context, "POST", "/api/replay/recordings/find-subject/delete", admin.cookie, {
      value: EMAIL,
      targets: found.matches.map((match) => ({ kind: match.kind, id: match.id }))
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(await sideRows()).toEqual([0, 0, 0]);
    const trail = (await context.store.listAuditLogs({ pageSize: 200 })).items.filter((entry) => entry.eventType.startsWith("replay.find_subject.delete"));
    expect(trail.filter((entry) => entry.eventType === "replay.find_subject.delete_started")).toHaveLength(2);
    expect(trail.filter((entry) => entry.eventType === "replay.find_subject.deleted")).toHaveLength(1);
  });

  it("N8: an imported golden-set file's masked flag and provenance labels are never trusted", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    await save(context, hookWorkflow("wf-trust"));
    await enableCapture(context, builder.cookie, "wf-trust", { maxPerDay: 10 });
    await hook(context, "wf-trust", { user_prompt: `I am ${EMAIL}` });
    const [capture] = await waitForCaptures(context, builder.cookie, "wf-trust", 1);
    const promoted = await call(context, "POST", `/api/replay/captures/${capture!.id}/promote`, builder.cookie, {});
    expect(promoted.statusCode, promoted.body).toBe(200);
    const datasetId = promoted.json<{ result: { datasetId: string } }>().result.datasetId;
    const exported = await call(context, "GET", `/api/eval/datasets/${datasetId}/export`, builder.cookie);
    expect(exported.statusCode, exported.body).toBe(200);
    const file = exported.json<{ cases: Array<{ recording: { facts: RunFacts; capture?: { masked: boolean; dataClasses: string[] }; input?: unknown } }> }>();
    // A forged file: raw content, claimed masked, claimed trusted.
    const forged = file.cases[0]!.recording;
    forged.input = { user_prompt: `I am ${EMAIL}` };
    forged.capture = { masked: true, dataClasses: ["email"] };
    forged.facts.nodes = forged.facts.nodes.map((entry) => ({ ...entry, labels: { provenance: ["trusted"], dataClasses: ["email"], source: "scan" } }));
    const imported = await call(context, "POST", "/api/eval/datasets/import", builder.cookie, { file, workflowId: "wf-trust", name: "Forged" });
    expect(imported.statusCode, imported.body).toBe(201);
    const listed = (await call(context, "GET", "/api/replay/recordings?workflowId=wf-trust", builder.cookie)).json<{ items: ReplayRecordingSummary[] }>().items;
    const importedRun = listed.find((entry) => entry.capabilities.origin === "imported")!;
    expect(importedRun.capabilities.capture).toMatchObject({ masked: true, maskingVerified: false });
    const stored = (await context.store.getReplayRecording(importedRun.id))!;
    for (const entry of stored.facts.nodes) {
      expect(entry.labels?.source).toBe("file");
      expect(entry.labels?.provenance).not.toContain("trusted");
    }
    // Exported again, it no longer claims to be masked.
    const importedSet = imported.json<{ dataset: { id: string } }>().dataset.id;
    const again = (await call(context, "GET", `/api/eval/datasets/${importedSet}/export`, builder.cookie)).json<typeof file>();
    expect(again.cases[0]!.recording.capture).toMatchObject({ masked: false });
  });
});

describe("re-review round 3: lookup certainty, hints, international phones, kept identifiers", () => {
  async function handSaved(context: TestContext, cookie: string, workflowId: string, prompt: string): Promise<string> {
    const run = await call(context, "POST", `/api/workflows/${workflowId}/execute`, cookie, { input: { user_prompt: prompt } });
    const saved = await call(context, "POST", "/api/replay/recordings", cookie, { executionId: run.json<{ executionId: string }>().executionId, name: prompt.slice(0, 40) });
    expect(saved.statusCode, saved.body).toBe(201);
    return saved.json<{ recording: ReplayRecordingSummary }>().recording.id;
  }
  const find = async (context: TestContext, cookie: string, body: Record<string, unknown>) => {
    const response = await call(context, "POST", "/api/replay/recordings/find-subject", cookie, body);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<ReplayFindSubjectResult>();
  };
  const erase = async (context: TestContext, cookie: string, body: Record<string, unknown>) => {
    const response = await call(context, "POST", "/api/replay/recordings/find-subject/delete", cookie, body);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<ReplayFindSubjectDeleteResult>();
  };

  it("A1: every re-review 2 over-match is a possible match or no match, never exact, and never deleted without a confirmation", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    await save(context, hookWorkflow("wf-a1"));
    const rows: Array<[string, string, "national_only" | null]> = [
      ["+44 20 7946 0958", "call (207) 946-0958", "national_only"],
      ["+1 (207) 946-0958", "ring 020 7946 0958", "national_only"],
      ["(415) 555-1234", "fr +33 415 555 1234", "national_only"],
      ["(415) 555-1234", "de +49 415 555 1234", "national_only"],
      ["(207) 946-0958", "uk 44 207 946 0958", null],
      ["020 7946 0958", "us (207) 946-0958", "national_only"],
      ["020 7946 0958", "us +1 207 946 0958", "national_only"],
      ["415-555-1234", "ids 7 415 555 1234", null],
      ["415-555-1234", "ids 86 415 555 1234", null]
    ];
    for (const [query, stored, expected] of rows) {
      const id = await handSaved(context, builder.cookie, "wf-a1", stored);
      const result = await find(context, admin.cookie, { value: query });
      const match = result.matches.find((entry) => entry.id === id);
      expect(result.matches.some((entry) => entry.certainty === "exact"), `${query} vs ${stored}`).toBe(false);
      expect(match?.certainty ?? null, `${query} vs ${stored}`).toBe(expected);
      if (match) {
        expect(match.hits.every((hit) => hit.certainty === "national_only")).toBe(true);
        // The stored copy's own country code is shown, so the admin can see it is someone else's.
        if (stored.includes("+33")) expect(match.hits[0]!.storedCallingCode).toBe("33");
        // Delete without a confirmation keeps it.
        const outcome = await erase(context, admin.cookie, { value: query, targets: [{ kind: "recording", id }] });
        expect(outcome.deleted.recording).toBe(0);
        expect(outcome.skipped).toEqual([{ kind: "recording", id, reason: "possible_match_unconfirmed" }]);
        expect(await context.store.getReplayRecordingSummary(id)).not.toBeNull();
      }
      await context.store.deleteReplayRecording(id);
    }
    // The intent audit row counts confirmed possible matches apart.
    const id = await handSaved(context, builder.cookie, "wf-a1", "call (207) 946-0958");
    expect((await erase(context, admin.cookie, { value: "+44 20 7946 0958", targets: [{ kind: "recording", id, confirmPossible: true }] })).deleted.recording).toBe(1);
    const started = (await context.store.listAuditLogs({ pageSize: 200 })).items.find((entry) => entry.eventType === "replay.find_subject.delete_started")!;
    expect(started.metadata).toMatchObject({ rows: 1, confirmedPossible: 1 });
  }, 60_000);

  it("ruling (a): a class hint and a country; refusals are plain and never repeat the value", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    await save(context, hookWorkflow("wf-hint"));
    const intl = await handSaved(context, builder.cookie, "wf-hint", "call +1 415 555 1234");
    const national = await handSaved(context, builder.cookie, "wf-hint", "call (415) 555-1234");
    const other = await handSaved(context, builder.cookie, "wf-hint", "call +33 415 555 1234");
    const raw = await handSaved(context, builder.cookie, "wf-hint", "ref 4155551234 on file");

    // No hint: bare digits are text, matched exactly as typed.
    const text = await find(context, admin.cookie, { value: "4155551234" });
    expect(text).toMatchObject({ dataClass: null, callingCode: null });
    expect(text.matches.map((match) => match.id)).toEqual([raw]);
    // A `+` number with an assigned calling code is a phone without a hint (E.164, no separators).
    const e164 = await find(context, admin.cookie, { value: "+14155551234" });
    expect(e164).toMatchObject({ dataClass: "phone", callingCode: "1" });
    expect(e164.matches.find((match) => match.id === intl)?.certainty).toBe("exact");
    // Read as a phone, no country: possible matches only.
    const plain = await find(context, admin.cookie, { value: "4155551234", dataClass: "phone" });
    expect(plain).toMatchObject({ dataClass: "phone", callingCode: null });
    expect(plain.matches.map((match) => match.id).sort()).toEqual([intl, national, other, raw].sort());
    expect(plain.matches.every((match) => match.certainty === "national_only")).toBe(true);
    // With a country: the +1 copy is exact, +33 is someone else, the national copies stay possible.
    const us = await find(context, admin.cookie, { value: "4155551234", dataClass: "phone", country: "US" });
    expect(us).toMatchObject({ dataClass: "phone", callingCode: "1" });
    const certainty = Object.fromEntries(us.matches.map((match) => [match.id, match.certainty]));
    expect(certainty).toEqual({ [intl]: "exact", [national]: "national_only", [raw]: "national_only" });
    expect((await find(context, admin.cookie, { value: "(415) 555-1234", country: "+1" })).callingCode).toBe("1");
    // A country alone makes bare digits a phone.
    expect((await find(context, admin.cookie, { value: "4155551234", country: "US" })).dataClass).toBe("phone");

    const refused = async (body: Record<string, unknown>, message: RegExp) => {
      for (const route of ["/api/replay/recordings/find-subject", "/api/replay/recordings/find-subject/delete"]) {
        const response = await call(context, "POST", route, admin.cookie, route.endsWith("delete") ? { ...body, targets: [{ kind: "recording", id: intl }] } : body);
        expect(response.statusCode, `${route} ${JSON.stringify(body)}`).toBe(400);
        expect(response.json<{ error: string }>().error).toMatch(message);
        expect(response.body).not.toContain(String(body.value));
      }
    };
    await refused({ value: "call me 41", dataClass: "phone" }, /does not read as a phone number/);
    await refused({ value: "4155551234", dataClass: "email" }, /does not read as an email address/);
    await refused({ value: "123-45-678", dataClass: "us_ssn" }, /does not read as a US Social Security number/);
    await refused({ value: "4155551234", dataClass: "phone", country: "ZZ" }, /country is not one the lookup knows/);
    await refused({ value: "jane.doe@example.com", country: "US" }, /phone numbers only/);
    await refused({ value: "+44 20 7946 0958", country: "US" }, /own country code is not the country chosen/);
    expect((await call(context, "POST", "/api/replay/recordings/find-subject", admin.cookie, { value: "4155551234", country: "United States" })).statusCode).toBe(400);
    expect(await context.store.getReplayRecordingSummary(intl)).not.toBeNull();
  }, 60_000);

  it("A2: an E.164 or international number the DLP pattern does not read is masked in a capture and found by the lookup", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    await save(context, hookWorkflow("wf-intl"));
    await enableCapture(context, builder.cookie, "wf-intl", { maxPerDay: 20 });
    const numbers: Array<[string, string]> = [
      ["+14155551234", "4155551234"],
      ["+447700900123", "7700900123"],
      ["+33 1 23 45 67 89", "123456789"],
      ["+44 (0) 20 7946 0958", "2079460958"],
      ["+61 2 9876 5432", "298765432"],
      ["+91 98765 43210", "9876543210"],
      ["+81 3-1234-5678", "312345678"],
      ["+353 1 234 5678", "12345678"],
      ["+36 1 234 5678", "12345678"],
      ["+7 495 123-45-67", "4951234567"]
    ];
    for (const [written] of numbers) await hook(context, "wf-intl", { crm: { phone: written } });
    const items = await waitForCaptures(context, builder.cookie, "wf-intl", numbers.length);
    for (const item of items) {
      expect(item.dataClasses).toContain("phone");
      const stored = (await rawRecordingText(context, item.id)).replace(/\D/g, "");
      for (const [, national] of numbers) expect(stored).not.toContain(national);
    }
    for (const [written] of numbers) {
      const result = await find(context, admin.cookie, { value: written });
      expect(result.dataClass, written).toBe("phone");
      const exact = result.matches.filter((match) => match.certainty === "exact");
      expect(exact.map((match) => match.matchedAs), written).toEqual([["phone"]]);
    }
  }, 60_000);

  it("A3: a captured run whose tool argument and resource URI hold an email replays with strict MCP matching", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const created = await call(context, "POST", "/api/mcp/servers", admin.cookie, {
      name: "Mock CRM",
      adapterId: "mock-mcp",
      probeEnabled: false,
      connection: { kbOverrides: { [EMAIL]: "Profile on file." } }
    });
    expect(created.statusCode, created.body).toBe(201);
    const serverId = created.json<{ server: { id: string } }>().server.id;
    expect((await call(context, "POST", `/api/mcp/servers/${serverId}/probe`, admin.cookie)).statusCode).toBe(200);
    await save(context, {
      id: "wf-mcp",
      name: "CRM lookup",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "default",
      nodes: [
        node("hook", "webhook_input", { path: "hook-wf-mcp", method: "POST" }),
        node("tool", "mcp_tool", { registryServerId: serverId, toolName: "lookup_kb", argsTemplate: JSON.stringify({ topic: "{{user_prompt}}" }), retry: { enabled: false } }, 150),
        node("profile", "mcp_tool", { registryServerId: serverId, operation: "read_resource", resourceUri: "mock://kb/{{user_prompt}}", retry: { enabled: false } }, 300),
        node("out", "output", { responseTemplate: "done" }, 450)
      ],
      edges: [
        { id: "e1", source: "hook", target: "tool" },
        { id: "e2", source: "tool", target: "profile" },
        { id: "e3", source: "profile", target: "out" }
      ]
    } as Workflow);
    await enableCapture(context, builder.cookie, "wf-mcp");
    const response = await hook(context, "wf-mcp", { user_prompt: EMAIL });
    expect(response.statusCode, response.body).toBe(200);
    const [captured] = await waitForCaptures(context, builder.cookie, "wf-mcp", 1);
    expect(captured!.capabilities).toMatchObject({ mcp: "cassette" });
    const text = await rawRecordingText(context, captured!.id);
    expect(text).not.toContain(EMAIL);
    const recording = (await context.store.getReplayRecording(captured!.id))!;
    const cassette = recording.mcpCassette!;
    const surrogate = surrogateFor(EMAIL, "email", SURROGATE_KEY);
    // Routing identifiers as written; the resource URI and the arguments masked.
    expect(cassette.servers[0]!.key).toBe(`registry:${serverId}`);
    const call1 = cassette.entries.find((entry) => entry.method === "tools/call")!;
    expect(call1).toMatchObject({ server: `registry:${serverId}`, name: "lookup_kb" });
    expect(JSON.stringify(call1.args)).toContain(surrogate);
    expect(cassette.entries.find((entry) => entry.method === "resources/read")!.name).toBe(`mock://kb/${surrogate}`);

    const promoted = await call(context, "POST", `/api/replay/captures/${captured!.id}/promote`, builder.cookie, {});
    expect(promoted.statusCode, promoted.body).toBe(200);
    const datasetId = promoted.json<{ result: { datasetId: string } }>().result.datasetId;
    const job = await runJob(context, builder.cookie, { datasetIds: [datasetId], mcpMode: "strict" });
    expect(job.status, job.error ?? "").toBe("completed");
    expect(job.results.map((result) => [result.status, result.error ?? null])).toEqual([["pass", null]]);
  }, 60_000);

  it("round 4 B1: bare digits searched as text are a possible match inside another country's number, and never deleted without a confirmation", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    await save(context, hookWorkflow("wf-b1"));
    const french = [
      await handSaved(context, builder.cookie, "wf-b1", "fr +33 4155551234"),
      await handSaved(context, builder.cookie, "wf-b1", "fr 0033 4155551234"),
      await handSaved(context, builder.cookie, "wf-b1", "fr +33(0)4155551234")
    ];
    const plain = await handSaved(context, builder.cookie, "wf-b1", "ref 4155551234 on file");
    const query = { value: "4155551234" };
    const result = await find(context, admin.cookie, query);
    expect(result.dataClass).toBeNull();
    const certainty = new Map(result.matches.map((match) => [match.id, match]));
    for (const id of french) {
      expect(certainty.get(id)?.certainty, id).toBe("national_only");
      expect(certainty.get(id)!.hits.every((hit) => hit.certainty === "national_only")).toBe(true);
      // The stored copy's country code is shown, so the admin can see it is someone else's.
      expect(certainty.get(id)!.hits[0]!.storedCallingCode).toBe("33");
    }
    expect(certainty.get(plain)?.certainty).toBe("exact");
    // Certain matches first.
    expect(result.matches[0]!.id).toBe(plain);

    const outcome = await erase(context, admin.cookie, { ...query, targets: [...french, plain].map((id) => ({ kind: "recording", id })) });
    expect(outcome.removed).toEqual([{ kind: "recording", id: plain }]);
    expect(outcome.skipped).toEqual(french.map((id) => ({ kind: "recording", id, reason: "possible_match_unconfirmed" })));
    for (const id of french) expect(await context.store.getReplayRecordingSummary(id)).not.toBeNull();
    expect(await context.store.getReplayRecordingSummary(plain)).toBeNull();
    // Confirmed row by row, a possible match is deleted.
    const confirmed = await erase(context, admin.cookie, { ...query, targets: [{ kind: "recording", id: french[0]!, confirmPossible: true }] });
    expect(confirmed.removed).toEqual([{ kind: "recording", id: french[0]! }]);
  }, 60_000);

  it("round 4 B3: a row named both with and without a confirmation is refused in either order, and nothing is deleted", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    await save(context, hookWorkflow("wf-b3"));
    const id = await handSaved(context, builder.cookie, "wf-b3", "call (207) 946-0958");
    const other = await handSaved(context, builder.cookie, "wf-b3", "uk +44 20 7946 0958");
    const query = { value: "+44 20 7946 0958" };
    for (const targets of [
      [{ kind: "recording", id: other }, { kind: "recording", id }, { kind: "recording", id, confirmPossible: true }],
      [{ kind: "recording", id, confirmPossible: true }, { kind: "recording", id: other }, { kind: "recording", id }]
    ]) {
      const response = await call(context, "POST", "/api/replay/recordings/find-subject/delete", admin.cookie, { ...query, targets });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json<{ error: string }>().error).toBe("A row is listed twice, once confirmed as a possible match and once not. List each row once.");
      expect(response.body).not.toContain("7946");
      expect(await context.store.getReplayRecordingSummary(id)).not.toBeNull();
      expect(await context.store.getReplayRecordingSummary(other)).not.toBeNull();
    }
    expect((await context.store.listAuditLogs({ pageSize: 200 })).items.some((entry) => entry.eventType === "replay.find_subject.delete_started")).toBe(false);
    // The same row twice with the same confirmation is still one target.
    const twice = await erase(context, admin.cookie, { ...query, targets: [{ kind: "recording", id, confirmPossible: true }, { kind: "recording", id, confirmPossible: true }] });
    expect(twice.removed).toEqual([{ kind: "recording", id }]);
  }, 60_000);

  it("round 4 B2: a dropped capture is noted on the workflow's settings, with when and why", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    await save(context, hookWorkflow("wf-drop"));
    expect((await hook(context, "wf-drop", {})).statusCode).toBe(200);
    const executionId = (await context.store.listExecutionHistory({ workflowId: "wf-drop", page: 1, pageSize: 5 })).items[0]!.id;
    await enableCapture(context, builder.cookie, "wf-drop");
    const before = await call(context, "GET", "/api/workflows/wf-drop/replay-capture", builder.cookie);
    expect(before.json<{ settings: ReplayCaptureSettingsView }>().settings.lastDrop).toBeNull();
    const outcomes: string[] = [];
    const service = new ReplayCaptureService({
      store: context.store,
      recordings: {
        createCapture: async () => {
          throw new MaskIdentifierError("A detected value appears in cassette entry 1 tool name, which is kept as written for replay.");
        }
      } as never,
      datasets: {} as never,
      surrogateKey: SURROGATE_KEY,
      dictionariesFor: async () => [],
      dictionaryClasses: async () => [],
      publishedVersion: async () => null,
      deployment: { enabled: true, maxRate: 1, retentionDays: 14, maxPerWorkflow: 200, maxBytesPerWorkflow: 209_715_200 },
      log: { warn: () => undefined, info: () => undefined },
      metric: (outcome) => outcomes.push(outcome),
      now: () => new Date("2026-10-24T10:00:00.000Z")
    });
    const ticket = (await service.decide({ workflow: { id: "wf-drop" }, channel: "production", triggerType: "webhook", releaseVersion: null, excluded: false }))!;
    expect(ticket).toBeTruthy();
    service.finish(ticket, { executionId, workflow: { id: "wf-drop", name: "x", projectId: "default" }, plan: {} as never });
    await service.idle();
    expect(outcomes).toEqual(["dropped_identifier_value"]);
    const after = await call(context, "GET", "/api/workflows/wf-drop/replay-capture", builder.cookie);
    expect(after.json<{ settings: ReplayCaptureSettingsView }>().settings.lastDrop).toEqual({ outcome: "dropped_identifier_value", at: "2026-10-24T10:00:00.000Z" });
    // Saving the settings again keeps the note.
    expect((await call(context, "PUT", "/api/workflows/wf-drop/replay-capture", builder.cookie, { rate: 0.5 })).statusCode).toBe(200);
    expect((await service.view("wf-drop")).lastDrop?.outcome).toBe("dropped_identifier_value");
  }, 60_000);

  it("A4 and A5: Hungarian and Russian national forms are possible matches; an excerpt starts at the bracket", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    await save(context, hookWorkflow("wf-trunk"));
    const hu = await handSaved(context, builder.cookie, "wf-trunk", "call 06 1 234 5678");
    const ru = await handSaved(context, builder.cookie, "wf-trunk", "call 8 (495) 123-45-67");
    const us = await handSaved(context, builder.cookie, "wf-trunk", "call (207) 946-0958");
    const huFound = await find(context, admin.cookie, { value: "+36 1 234 5678" });
    expect(huFound.matches.map((match) => [match.id, match.certainty])).toEqual([[hu, "national_only"]]);
    const ruFound = await find(context, admin.cookie, { value: "+7 495 123 4567" });
    expect(ruFound.matches.map((match) => [match.id, match.certainty])).toEqual([[ru, "national_only"]]);
    const usFound = await find(context, admin.cookie, { value: "+1 207 946 0958" });
    const hit = usFound.matches.find((match) => match.id === us)!.hits[0]!;
    expect(hit.excerpt).toContain("[(");
    expect(hit.excerpt).not.toContain("946");

    // Masked captures: the national form written with a two-digit trunk gets the same surrogate, so the lookup finds both copies.
    await save(context, hookWorkflow("wf-trunk-cap"));
    await enableCapture(context, builder.cookie, "wf-trunk-cap");
    await hook(context, "wf-trunk-cap", { user_prompt: "call +36 30 123 4567", note: "or 06 30 123 4567" });
    const [captured] = await waitForCaptures(context, builder.cookie, "wf-trunk-cap", 1);
    expect((await rawRecordingText(context, captured!.id)).replace(/\D/g, "")).not.toContain("301234567");
    const capFound = await find(context, admin.cookie, { value: "+36 30 123 4567" });
    const match = capFound.matches.find((entry) => entry.id === captured!.id)!;
    expect(match.certainty).toBe("exact");
    expect(match.hits.some((entry) => entry.certainty === "national_only")).toBe(true);
  }, 60_000);
});

describe("captures stored before surrogates dropped the visible tail", () => {
  /** A fixed master key, so the stored forms below are the exact strings ae2f542 wrote for it. */
  const FIXED_MASTER_KEY = "yMfGxcTDwsHAv769vLu6ubi3trW0s7KxsK+urayrqqk=";
  /** [value, what a masked capture stored at ae2f542 (tailed surrogate), what a capture stores now]. */
  const OLD_CAPTURES: Array<[string, string, string]> = [
    ["4111 1111 1111 1111", "4587 5312 1569 1111", "4587 5312 1562 9558"],
    ["GB82 WEST 1234 5698 7654 32", "GB89 SEDQ 8755 0331 9354 32", "GB68 SEDQ 8755 0331 9348 40"],
    ["+1 415-555-0123", "+1 285-239-8523", "+1 285-239-8505"],
    ["AB 12 34 56 C", "ZY 28 87 56 C", "ZY 28 87 73 A"],
    ["123-45-6788", "573-71-6788", "573-71-3165"]
  ];

  it("are still found and deleted by the data-subject lookup (tailed forms, phone plain copies included)", async () => {
    const context = await createTestContext({ SECRET_MASTER_KEY_BASE64: FIXED_MASTER_KEY });
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    await save(context, hookWorkflow("wf-old-tail"));
    const key = deriveCaptureSurrogateKey(Buffer.from(FIXED_MASTER_KEY, "base64"));
    const store = async (text: string) => {
      const run = await call(context, "POST", "/api/workflows/wf-old-tail/execute", builder.cookie, { input: { user_prompt: text } });
      const saved = await call(context, "POST", "/api/replay/recordings", builder.cookie, { executionId: run.json<{ executionId: string }>().executionId, name: text.slice(0, 40) });
      expect(saved.statusCode, saved.body).toBe(201);
      return saved.json<{ recording: ReplayRecordingSummary }>().recording.id;
    };
    const search = async (value: string) => {
      const response = await call(context, "POST", "/api/replay/recordings/find-subject", admin.cookie, { value });
      expect(response.statusCode, response.body).toBe(200);
      return response.json<ReplayFindSubjectResult>();
    };

    for (const [value, oldStored, nowStored] of OLD_CAPTURES) {
      // The fixtures are what they claim: today's surrogate is the untailed form, never the stored one.
      expect(surrogateFor(value, (await search(value)).dataClass!, key)).toBe(nowStored);
      const id = await store(`value ${oldStored} end`);
      const found = await search(value);
      const match = found.matches.find((entry) => entry.id === id);
      expect(match, `${value} as ${oldStored}`).toBeDefined();
      expect(match!.hits[0]!.matchedAs).toBe(found.dataClass);
      const removed = await call(context, "POST", "/api/replay/recordings/find-subject/delete", admin.cookie, {
        value,
        targets: [{ kind: "recording", id, confirmPossible: true }]
      });
      expect(removed.statusCode, removed.body).toBe(200);
      expect(removed.json<ReplayFindSubjectDeleteResult>().removed, value).toEqual([{ kind: "recording", id }]);
      expect(await context.store.getReplayRecordingSummary(id)).toBeNull();
    }

    // A copy of the phone written without its `+` was keyed on its own digits; main kept its last two as well.
    const plain = await store("plain 37596597523 end");
    const found = await search("+1 415-555-0123");
    expect(found.matches.map((entry) => entry.id)).toContain(plain);
    const removed = await call(context, "POST", "/api/replay/recordings/find-subject/delete", admin.cookie, {
      value: "+1 415-555-0123",
      targets: [{ kind: "recording", id: plain, confirmPossible: true }]
    });
    expect(removed.json<ReplayFindSubjectDeleteResult>().removed).toEqual([{ kind: "recording", id: plain }]);
  }, 60_000);
});

describe("replay comparison of guard-masked spans", () => {
  it("compares masked spans as masks for a masked capture only; a hand-saved run compares exactly", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    await save(context, hookWorkflow("wf-masked-diff", "Card {{user_prompt}} on file"));
    const sql = testSql(context.store);
    // The golden run's output masked one card; the replay masks another (as a surrogate's mask reads differently).
    const used = new Set<string>();
    const record = async (masked: boolean) => {
      expect((await hook(context, "wf-masked-diff", { user_prompt: "•••• •••• •••• 9876" })).json()).toEqual({ output: { result: "Card •••• •••• •••• 9876 on file" } });
      const executionId = (await context.store.listExecutionHistory({ workflowId: "wf-masked-diff", triggerType: "webhook" })).items.find((item) => !used.has(item.id))!.id;
      used.add(executionId);
      const saved = await call(context, "POST", "/api/replay/recordings", builder.cookie, { executionId, name: `masked ${masked}` });
      expect(saved.statusCode, saved.body).toBe(201);
      const id = saved.json<{ recording: ReplayRecordingSummary }>().recording.id;
      const recording = (await context.store.getReplayRecording(id))!;
      const facts = JSON.stringify(recording.facts).replaceAll("•••• •••• •••• 9876", "•••• •••• •••• 1111");
      const capabilities = masked
        ? { ...recording.capabilities, capture: { rate: 1, masked: true, dataClasses: ["card_number"], values: { card_number: 1 }, notDetectableAfterMasking: [], keptFromWorkflow: 0, publishedVersion: 1 } }
        : recording.capabilities;
      await sql.run("UPDATE replay_recordings SET facts_json = ?, capabilities_json = ? WHERE id = ?", facts, JSON.stringify(capabilities), id);
      return id;
    };
    const replayOf = async (id: string) => {
      const response = await call(context, "POST", `/api/replay/recordings/${id}/replay`, builder.cookie, {});
      expect(response.statusCode, response.body).toBe(200);
      return response.json<{ diff: { output: { equal: boolean } } }>();
    };
    const maskedId = await record(true);
    const handId = await record(false);
    expect((await replayOf(maskedId)).diff.output.equal).toBe(true);
    expect((await replayOf(handId)).diff.output.equal).toBe(false);
    // A replay job scores the same way (its json_equal scorer compares with the golden run).
    const jobOf = async (recordingId: string) => {
      const set = (await call(context, "POST", "/api/eval/datasets", builder.cookie, { name: `Set ${recordingId}`, workflowId: "wf-masked-diff" })).json<{ dataset: { id: string } }>().dataset.id;
      expect((await call(context, "POST", `/api/eval/datasets/${set}/recordings`, builder.cookie, { recordingId })).statusCode).toBe(201);
      const job = await runJob(context, builder.cookie, { datasetIds: [set] });
      expect(job.status, job.error ?? "").toBe("completed");
      return job.results.map((result) => result.status);
    };
    expect(await jobOf(maskedId)).toEqual(["pass"]);
    expect(await jobOf(handId)).toEqual(["fail"]);
  }, 60_000);
});
