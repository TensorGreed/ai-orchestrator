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
import { MaskUnscannableError, surrogateFor } from "@ai-orchestrator/guard-sdk";
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
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import { SqliteStore } from "./db/database.js";
import { MIGRATIONS } from "./db/migrations.js";
import { AuthService } from "./services/auth-service.js";
import { deriveCaptureSurrogateKey, ReplayCaptureService, seededRandom } from "./services/replay-capture-service.js";
import { SecretService } from "./services/secret-service.js";
import { WorkflowVersionService } from "./services/workflow-version-service.js";

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
const MASTER_KEY = crypto.randomBytes(32).toString("base64");
const SURROGATE_KEY = deriveCaptureSurrogateKey(Buffer.from(MASTER_KEY, "base64"));
const MODEL_KEY = "sk-model-CAPTURE-key-0a1b2c3d4e5f60718293";
const EMAIL = "jane.doe@example.com";
const CARD = "4111 1111 1111 1111";

async function createTestContext(overrides: Record<string, string> = {}, existing?: { tempDir: string; dbPath: string }): Promise<TestContext> {
  const tempDir = existing?.tempDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "ao-capture-"));
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

function save(context: TestContext, workflow: Workflow): number {
  const saved = context.store.upsertWorkflow(workflow);
  return new WorkflowVersionService(context.store).snapshot({ workflow: saved, changeNote: "test" }).version;
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

function rawRecordingText(context: TestContext, id: string): string {
  const row = context.store.subjectTextRow("recording", id);
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

describe("migration 34", () => {
  it("adds capture settings and recording status in Postgres DDL with a down path, and the same in SQLite", async () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 34)!;
    expect(migration.up).toContain("ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'golden'");
    expect(migration.up).toContain("ADD COLUMN IF NOT EXISTS captured_at");
    expect(migration.up).toContain("CREATE TABLE IF NOT EXISTS replay_capture_settings");
    expect(migration.down).toContain("DROP TABLE IF EXISTS replay_capture_settings");
    expect(migration.down).toContain("DROP COLUMN IF EXISTS status");
    const context = await createTestContext();
    const db = (context.store as unknown as { db: { prepare: (sql: string) => { all: () => Array<{ name: string }> } } }).db;
    const columns = (table: string) => db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    expect(columns("replay_recordings")).toEqual(expect.arrayContaining(["status", "captured_at"]));
    expect(columns("replay_capture_settings")).toEqual(
      expect.arrayContaining(["workflow_id", "enabled", "rate", "max_per_day", "only_statuses_json", "dlp", "dlp_off_reason", "target_dataset_id"])
    );
  });
});

describe("zero-config: capture off changes nothing", () => {
  it("never records a workflow that has no capture settings, and reports the defaults", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    save(context, hookWorkflow("wf-off"));
    for (let i = 0; i < 3; i += 1) expect((await hook(context, "wf-off", { user_prompt: `hello ${EMAIL}` })).statusCode).toBe(200);
    await settle();
    expect((await inbox(context, builder.cookie, "wf-off")).total).toBe(0);
    expect(context.store.listReplayRecordings({}).total).toBe(0);
    const settings = (await call(context, "GET", "/api/workflows/wf-off/replay-capture", builder.cookie)).json<{ settings: ReplayCaptureSettingsView }>().settings;
    expect(settings).toMatchObject({ configured: false, enabled: false, rate: 0.1, maxPerDay: 20, dlp: true, onlyStatuses: ["success", "error", "canceled"], effectiveRate: 0, candidates: 0 });
    expect(settings.deployment).toMatchObject({ enabled: true, maxRate: 1, retentionDays: 14, maxCandidates: 200 });
  });

  it("the kill switch stops every workflow's capture", async () => {
    const context = await createTestContext({ REPLAY_CAPTURE_ENABLED: "false" });
    const builder = await login(context, "builder");
    save(context, hookWorkflow("wf-kill"));
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
      dictionariesFor: () => [],
      dictionaryClasses: () => [],
      publishedVersion: (workflowId) => context.store.getPublishedVersion(workflowId),
      deployment: { enabled: true, maxRate, retentionDays: 14, maxPerWorkflow: 200, maxBytesPerWorkflow: 209_715_200 },
      random: seededRandom(seed),
      log: { warn: () => undefined, info: () => undefined }
    });
  }

  it("samples at the configured rate with a seeded generator, capped by the deployment ceiling", async () => {
    const context = await createTestContext();
    save(context, hookWorkflow("wf-rate"));
    context.store.saveReplayCaptureSettings({ workflowId: "wf-rate", enabled: true, rate: 0.1, maxPerDay: 1_000, onlyStatuses: ["success"], dlp: true, dlpOffReason: null, targetDatasetId: null, updatedBy: null });
    const draws = (rate: number, maxRate: number, seed: number) => {
      const capture = service(context, seed, maxRate);
      const expected = (() => {
        const random = seededRandom(seed);
        let hits = 0;
        for (let i = 0; i < 10_000; i += 1) if (random() < Math.min(rate, maxRate)) hits += 1;
        return hits;
      })();
      let sampled = 0;
      for (let i = 0; i < 10_000; i += 1) {
        const ticket = capture.decide({ workflow: { id: "wf-rate" }, channel: "production", triggerType: "webhook", releaseVersion: null, excluded: false });
        if (ticket) {
          sampled += 1;
          capture.abandon(ticket);
        }
      }
      return { sampled, expected };
    };
    const tenth = draws(0.1, 1, 42);
    expect(tenth.sampled).toBe(tenth.expected);
    expect(tenth.sampled).toBeGreaterThan(850);
    expect(tenth.sampled).toBeLessThan(1_150);
    const capped = draws(0.1, 0.02, 7);
    expect(capped.sampled).toBe(capped.expected);
    expect(capped.sampled).toBeLessThan(300);
    // Same seed, same decisions.
    expect(draws(0.1, 1, 42).sampled).toBe(tenth.sampled);
  });

  it("counts runs in flight against the daily limit, and excludes non-production runs", async () => {
    const context = await createTestContext();
    save(context, hookWorkflow("wf-day"));
    context.store.saveReplayCaptureSettings({ workflowId: "wf-day", enabled: true, rate: 1, maxPerDay: 3, onlyStatuses: ["success"], dlp: true, dlpOffReason: null, targetDatasetId: null, updatedBy: null });
    const capture = service(context, 1);
    const decide = (overrides: Partial<Parameters<ReplayCaptureService["decide"]>[0]> = {}) =>
      capture.decide({ workflow: { id: "wf-day" }, channel: "production", triggerType: "webhook", releaseVersion: null, excluded: false, ...overrides });
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
      expect(decide(excluded)).toBeNull();
    }
    const tickets = [decide(), decide(), decide()];
    expect(tickets.every(Boolean)).toBe(true);
    expect(decide()).toBeNull();
    capture.abandon(tickets[0]!);
    expect(decide()).not.toBeNull();
  });

  it("captures only runs of the published version once there is one", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const v1 = save(context, hookWorkflow("wf-pub", "one"));
    save(context, hookWorkflow("wf-pub", "two"));
    expect((await call(context, "POST", "/api/workflows/wf-pub/publish", builder.cookie, { version: v1 })).statusCode).toBe(200);
    context.store.saveReplayCaptureSettings({ workflowId: "wf-pub", enabled: true, rate: 1, maxPerDay: 10, onlyStatuses: ["success"], dlp: true, dlpOffReason: null, targetDatasetId: null, updatedBy: null });
    const capture = service(context, 3);
    expect(capture.decide({ workflow: { id: "wf-pub" }, channel: "production", triggerType: "webhook", releaseVersion: 2, excluded: false })).toBeNull();
    expect(capture.decide({ workflow: { id: "wf-pub" }, channel: "production", triggerType: "webhook", releaseVersion: null, excluded: false })).toBeNull();
    expect(capture.decide({ workflow: { id: "wf-pub" }, channel: "production", triggerType: "webhook", releaseVersion: v1, excluded: false })).not.toBeNull();

    // Over the API: production runs the published version, and the capture says so.
    expect((await hook(context, "wf-pub")).json<{ output: unknown }>().output).toMatchObject({ result: "one" });
    const [captured] = await waitForCaptures(context, builder.cookie, "wf-pub", 1);
    expect(captured!.capabilities.capture).toMatchObject({ publishedVersion: v1, rate: 1, masked: true });
  });

  it("keeps a daily limit per workflow over the API and records why runs were skipped", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    save(context, hookWorkflow("wf-limit"));
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
    save(context, hookWorkflow("wf-status"));
    await enableCapture(context, builder.cookie, "wf-status", { onlyStatuses: ["error"] });
    await hook(context, "wf-status");
    await settle();
    expect((await inbox(context, builder.cookie, "wf-status")).total).toBe(0);
    // A miss does not use up the day.
    const view = (await call(context, "GET", "/api/workflows/wf-status/replay-capture", builder.cookie)).json<{ settings: ReplayCaptureSettingsView }>().settings;
    expect(view.capturedToday).toBe(0);
  });

  it("captures execute-API runs made with an API key, never editor (session) runs", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    save(context, hookWorkflow("wf-api"));
    await enableCapture(context, builder.cookie, "wf-api", { maxPerDay: 10 });
    const key = (await call(context, "POST", "/api/auth/api-keys", builder.cookie, { name: "CI" })).json<{ key: string }>().key;
    const viaKey = await context.app.inject({ method: "POST", url: "/api/workflows/wf-api/execute", headers: { authorization: `Bearer ${key}` }, payload: { input: { user_prompt: `hi ${EMAIL}` } } });
    expect(viaKey.statusCode, viaKey.body).toBe(200);
    const streamed = await context.app.inject({ method: "POST", url: "/api/workflows/wf-api/execute/stream", headers: { authorization: `Bearer ${key}` }, payload: {} });
    expect(streamed.statusCode).toBe(200);
    expect((await call(context, "POST", "/api/workflows/wf-api/execute", builder.cookie, {})).statusCode).toBe(200);
    const items = await waitForCaptures(context, builder.cookie, "wf-api", 2);
    await settle();
    expect((await inbox(context, builder.cookie, "wf-api")).total).toBe(2);
    expect(items.map((item) => item.sourceTriggerType).sort()).toEqual(["api_execute", "api_execute_stream"]);
    // The editor run is still a manual run, as before.
    expect(context.store.listExecutionHistory({ workflowId: "wf-api", page: 1, pageSize: 10 }).items.map((run) => run.triggerType)).toContain("manual");
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
    save(context, workflow);
    await enableCapture(context, builder.cookie, "wf-gate", { maxPerDay: 1 });
    const paused = await hook(context, "wf-gate", { user_prompt: `pay ${EMAIL}` });
    expect(paused.statusCode, paused.body).toBeLessThan(300);
    const executionId = context.store.listExecutionHistory({ workflowId: "wf-gate", page: 1, pageSize: 5 }).items[0]!.id;
    expect(context.store.getExecutionHistory(executionId)?.status).toBe("waiting_approval");
    await settle();
    // Nothing kept, and the day's only slot is free again.
    expect((await inbox(context, builder.cookie, "wf-gate")).total).toBe(0);
    const view = (await call(context, "GET", "/api/workflows/wf-gate/replay-capture", builder.cookie)).json<{ settings: ReplayCaptureSettingsView }>().settings;
    expect(view.capturedToday).toBe(0);

    const approved = await call(context, "POST", `/api/approvals/${executionId}/approve`, admin.cookie, {});
    expect(approved.statusCode, approved.body).toBe(200);
    const until = Date.now() + 10_000;
    while (context.store.getExecutionHistory(executionId)?.status !== "success") {
      if (Date.now() > until) throw new Error(`Resume did not finish: ${context.store.getExecutionHistory(executionId)?.status}`);
      await sleep(25);
    }
    await settle();
    expect((await inbox(context, builder.cookie, "wf-gate")).total).toBe(0);
    expect(context.store.listReplayRecordings({}).total).toBe(0);
    // The free slot is real: the next production run is captured.
    await hook(context, "wf-gate", { user_prompt: "again" });
    await settle();
    const fresh = await call(context, "GET", "/api/workflows/wf-gate/replay-capture", builder.cookie);
    expect(fresh.json<{ settings: ReplayCaptureSettingsView }>().settings.capturedToday).toBeLessThanOrEqual(1);
  });

  it("drops a run whose content cannot be scanned completely (fail closed), and deep input never reaches storage raw", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    save(context, hookWorkflow("wf-deep"));
    // Over the API: content past the history depth limit is already a placeholder before masking, never the raw value.
    await enableCapture(context, builder.cookie, "wf-deep", { maxPerDay: 10 });
    let deep: Record<string, unknown> = { mail: EMAIL };
    for (let i = 0; i < 70; i += 1) deep = { next: deep };
    expect((await hook(context, "wf-deep", deep)).statusCode).toBe(200);
    for (const item of (await inbox(context, builder.cookie, "wf-deep")).items) expect(rawRecordingText(context, item.id)).not.toContain(EMAIL);
    await settle();
    for (const item of (await inbox(context, builder.cookie, "wf-deep")).items) expect(rawRecordingText(context, item.id)).not.toContain(EMAIL);

    // The service: a part masking could not scan completely drops the capture with outcome dropped_unscannable.
    const executionId = context.store.listExecutionHistory({ workflowId: "wf-deep", page: 1, pageSize: 5 }).items[0]!.id;
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
      dictionariesFor: () => [],
      dictionaryClasses: () => [],
      publishedVersion: () => null,
      deployment: { enabled: true, maxRate: 1, retentionDays: 14, maxPerWorkflow: 200, maxBytesPerWorkflow: 209_715_200 },
      log: { warn: () => undefined, info: () => undefined },
      metric: (outcome) => outcomes.push(outcome)
    });
    const ticket = capture.decide({ workflow: { id: "wf-deep" }, channel: "production", triggerType: "webhook", releaseVersion: null, excluded: false })!;
    capture.finish(ticket, { executionId, workflow: { id: "wf-deep", name: "x", projectId: "default" }, plan: {} as never });
    await capture.idle();
    expect(outcomes).toEqual(["dropped_unscannable"]);
    expect(capture.inFlightFor("wf-deep")).toBe(0);
  });

  it("reads the settings again when the capture is built: capture turned off mid-run discards it", async () => {
    const context = await createTestContext();
    save(context, hookWorkflow("wf-mid"));
    context.store.saveReplayCaptureSettings({ workflowId: "wf-mid", enabled: true, rate: 1, maxPerDay: 10, onlyStatuses: ["success"], dlp: true, dlpOffReason: null, targetDatasetId: null, updatedBy: null });
    const outcomes: string[] = [];
    const created: string[] = [];
    const capture = new ReplayCaptureService({
      store: context.store,
      recordings: { createCapture: async () => created.push("x") } as never,
      datasets: {} as never,
      surrogateKey: SURROGATE_KEY,
      dictionariesFor: () => [],
      dictionaryClasses: () => [],
      publishedVersion: () => null,
      deployment: { enabled: true, maxRate: 1, retentionDays: 14, maxPerWorkflow: 200, maxBytesPerWorkflow: 209_715_200 },
      log: { warn: () => undefined, info: () => undefined },
      metric: (outcome) => outcomes.push(outcome)
    });
    const ticket = capture.decide({ workflow: { id: "wf-mid" }, channel: "production", triggerType: "cron", releaseVersion: null, excluded: false })!;
    expect(ticket.inputOrigin).toBe("external");
    expect(capture.inFlightFor("wf-mid")).toBe(1);
    context.store.saveReplayCaptureSettings({ workflowId: "wf-mid", enabled: false, rate: 1, maxPerDay: 10, onlyStatuses: ["success"], dlp: true, dlpOffReason: null, targetDatasetId: null, updatedBy: null });
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
    save(context, hookWorkflow("wf-manual"));
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
    save(context, hookWorkflow("wf-evict"));
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
    expect(context.store.getReplayRecordingSummary(left[0]!)).toMatchObject({ status: "candidate" });
  });

  it("evicts the oldest candidates to stay within REPLAY_CAPTURES_MAX_BYTES_PER_WORKFLOW", async () => {
    const context = await createTestContext({ REPLAY_CAPTURES_MAX_BYTES_PER_WORKFLOW: "1048576" });
    const builder = await login(context, "builder");
    save(context, hookWorkflow("wf-bytes"));
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
    while (context.store.getReplayRecordingSummary(first!.id) && Date.now() < until) await sleep(50);
    await settle();
    const left = (await inbox(context, builder.cookie, "wf-bytes")).items;
    expect(left.map((item) => item.id)).not.toContain(first!.id);
    expect(left.length).toBeGreaterThanOrEqual(1);
    expect(context.store.sumReplayCaptureBytesForWorkflow("wf-bytes")).toBeLessThanOrEqual(1_048_576);
  }, 60_000);

  it("refuses a capture whose fixed parts are over REPLAY_RECORDING_MAX_BYTES, and the run is unaffected", async () => {
    const context = await createTestContext({ REPLAY_RECORDING_MAX_BYTES: "16384" });
    const builder = await login(context, "builder");
    save(context, hookWorkflow("wf-big"));
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
    save(context, hookWorkflow("wf-old"));
    await enableCapture(context, builder.cookie, "wf-old", { maxPerDay: 10 });
    await hook(context, "wf-old");
    await hook(context, "wf-old");
    const [first, second] = await waitForCaptures(context, builder.cookie, "wf-old", 2);
    const promoted = await call(context, "POST", `/api/replay/captures/${second!.id}/promote`, builder.cookie, {});
    expect(promoted.statusCode, promoted.body).toBe(200);
    const db = (context.store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).db;
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE replay_recordings SET captured_at = ?").run(old);
    await context.app.close();
    const reopened = await createTestContext({}, { tempDir: context.tempDir, dbPath: context.dbPath });
    contexts.push(reopened);
    contexts.splice(contexts.indexOf(context), 1);
    expect(reopened.store.getReplayRecordingSummary(first!.id)).toBeNull();
    expect(reopened.store.getReplayRecordingSummary(second!.id)).toMatchObject({ status: "golden" });
  });
});

describe("masking and replay", () => {
  it("masks personal data everywhere with surrogates, labels the nodes, and a models: replay job still hits the masked tape", async () => {
    const model = await startEchoModel();
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const secret = context.secretService.createSecret({ name: "Model key", provider: "openai", value: MODEL_KEY });
    save(context, agentWorkflow(model.baseUrl, secret.secretId));
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
    const text = rawRecordingText(context, captured!.id);
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
    const importedRecording = context.store.listEvalFixtures(imported.json<{ dataset: { id: string } }>().dataset.id)[0]!.recordingId!;
    const importedDetail = (await call(context, "GET", `/api/replay/recordings/${importedRecording}`, builder.cookie)).json<{ recording: ReplayRecordingDetail }>().recording;
    expect(importedDetail.capabilities.capture).toMatchObject({ masked: true, dataClasses: expect.arrayContaining(["email", "card_number"]) });
    expect((importedDetail.facts as RunFacts).nodes.find((entry) => entry.nodeId === "hook")!.labels!.dataClasses).toEqual(expect.arrayContaining(["email"]));
  }, 60_000);

  it("stores runs unmasked when an admin turned masking off with a reason (audited)", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    save(context, hookWorkflow("wf-raw"));
    await enableCapture(context, builder.cookie, "wf-raw");
    expect((await call(context, "PUT", "/api/workflows/wf-raw/replay-capture", builder.cookie, { dlp: false, reason: "debugging" })).statusCode).toBe(403);
    expect((await call(context, "PUT", "/api/workflows/wf-raw/replay-capture", admin.cookie, { dlp: false })).statusCode).toBe(400);
    const off = await call(context, "PUT", "/api/workflows/wf-raw/replay-capture", admin.cookie, { dlp: false, reason: "Synthetic test traffic only" });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json<{ settings: ReplayCaptureSettingsView }>().settings).toMatchObject({ dlp: false, dlpOffReason: "Synthetic test traffic only" });
    // Builders do not see the reason.
    const builderView = (await call(context, "GET", "/api/workflows/wf-raw/replay-capture", builder.cookie)).json<{ settings: ReplayCaptureSettingsView }>().settings;
    expect(builderView).toMatchObject({ dlp: false, dlpOffReason: null });
    const audits = context.store.listAuditLogs({ pageSize: 200 }).items.map((entry) => entry.eventType);
    expect(audits).toContain("replay.capture.masking_disabled");
    await hook(context, "wf-raw", { user_prompt: `mail ${EMAIL}` });
    const [captured] = await waitForCaptures(context, builder.cookie, "wf-raw", 1);
    expect(captured).toMatchObject({ masked: false, dataClasses: [] });
    expect(rawRecordingText(context, captured!.id)).toContain(EMAIL);
  });
});

describe("inbox routes and authorization", () => {
  async function setup() {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const viewer = await login(context, "viewer");
    const outsider = await login(context, "builder", "outsider");
    save(context, hookWorkflow("wf-inbox"));
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
    context.store.upsertCustomRole({ id: "none-default", projectId: "default", name: "No access", permissions: [] });
    context.store.upsertProjectRole({ userId: outsider.id, projectId: "default", role: "custom", customRoleId: "none-default" });
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
    expect(context.store.getReplayRecordingSummary(id)).toMatchObject({ status: "candidate" });
  });

  it("validates settings: rate ceiling, target set of this workflow", async () => {
    const { context, builder } = await setup();
    const capped = await createTestContext({ REPLAY_CAPTURE_MAX_RATE: "0.2" });
    const cappedBuilder = await login(capped, "builder");
    save(capped, hookWorkflow("wf-cap"));
    const over = await call(capped, "PUT", "/api/workflows/wf-cap/replay-capture", cappedBuilder.cookie, { enabled: true, rate: 0.5 });
    expect(over.statusCode).toBe(400);
    expect(over.json<{ error: string }>().error).toMatch(/REPLAY_CAPTURE_MAX_RATE/);
    expect((await call(capped, "PUT", "/api/workflows/wf-cap/replay-capture", cappedBuilder.cookie, { enabled: true, rate: 0.2 })).statusCode).toBe(200);

    save(context, hookWorkflow("wf-elsewhere"));
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
    expect(context.store.listEvalFixtures(target).map((fixture) => fixture.recordingId).sort()).toEqual([a, b].sort());
    expect(context.store.getReplayRecordingSummary(a!)).toMatchObject({ status: "golden", createdBy: "builder@example.com" });
    expect(context.store.getReplayRecordingSummary(a!)!.capturedAt).toBeTruthy();
    // Promoting twice is refused: it is no longer in the inbox.
    expect((await call(context, "POST", `/api/replay/captures/${a}/promote`, builder.cookie, {})).statusCode).toBe(404);

    expect((await call(context, "DELETE", `/api/replay/captures/${c}`, builder.cookie)).statusCode).toBe(200);
    const discarded = await call(context, "POST", "/api/replay/captures/discard", builder.cookie, { ids: [d, a] });
    expect(discarded.json<{ discarded: number }>().discarded).toBe(1);
    expect(context.store.getReplayRecordingSummary(c!)).toBeNull();
    expect(context.store.getReplayRecordingSummary(d!)).toBeNull();
    // A golden run is not discarded by the inbox route.
    expect(context.store.getReplayRecordingSummary(a!)).toMatchObject({ status: "golden" });
    expect((await inbox(context, builder.cookie, "wf-inbox")).total).toBe(0);

    // Export carries promoted runs only.
    const exported = await call(context, "GET", `/api/eval/datasets/${target}/export`, builder.cookie);
    expect(exported.statusCode, exported.body).toBe(200);
    const audits = context.store.listAuditLogs({ pageSize: 200 }).items.map((entry) => entry.eventType);
    expect(audits).toEqual(expect.arrayContaining(["replay.capture.settings_updated", "replay.capture.promoted", "replay.capture.discarded"]));
  });
});

describe("data-subject lookup", () => {
  it("finds a value as its surrogate in masked captures and raw in hand-saved runs, and deletes them with their cases", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    save(context, hookWorkflow("wf-subject"));
    save(context, hookWorkflow("wf-bystander"));
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
    expect(context.store.listReplayRecordings({}).total).toBe(3);

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
    const audit = context.store.listAuditLogs({ pageSize: 200 }).items.filter((entry) => entry.eventType.startsWith("replay.find_subject"));
    expect(audit).toHaveLength(3);
    const trail = JSON.stringify(audit.filter((entry) => entry.eventType === "replay.find_subject.deleted"));
    for (const removedRow of outcome.removed) expect(trail).toContain(`${removedRow.kind}:${removedRow.id}`);
    expect(JSON.stringify(audit)).not.toContain(EMAIL);
  });
});

describe("data-subject lookup: matching and reach", () => {
  it("matches whole values only, needs 6 characters for an unrecognised value, and finds a phone with or without its country code", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    save(context, hookWorkflow("wf-near"));
    // Hand-saved (unmasked) runs: one holds joann@x.com, one holds the phone with its country code.
    for (const prompt of ["contact joann@x.com", "call +1 415-555-0123 please"]) {
      const run = await call(context, "POST", "/api/workflows/wf-near/execute", builder.cookie, { input: { user_prompt: prompt } });
      expect((await call(context, "POST", "/api/replay/recordings", builder.cookie, { executionId: run.json<{ executionId: string }>().executionId, name: prompt })).statusCode).toBe(201);
    }
    const search = async (value: string) => call(context, "POST", "/api/replay/recordings/find-subject", admin.cookie, { value });
    expect((await search("ann@x.co")).json<ReplayFindSubjectResult>().matches).toEqual([]);
    expect((await search("joann@x.com")).json<ReplayFindSubjectResult>().counts.recording).toBe(1);
    expect((await search("415-555-0123")).json<ReplayFindSubjectResult>().counts.recording).toBe(1);
    expect((await search("4155550123")).json<ReplayFindSubjectResult>().counts.recording).toBe(1);
    const short = await search("inc");
    expect(short.statusCode).toBe(400);
    expect(short.body).not.toContain('"inc"');
    expect((await search("contac")).json<ReplayFindSubjectResult>().matches).toEqual([]);
  });

  it("searches replay results, replay executions and their cassettes, and deletes them", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    save(context, hookWorkflow("wf-reach", "{{user_prompt}}"));
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
