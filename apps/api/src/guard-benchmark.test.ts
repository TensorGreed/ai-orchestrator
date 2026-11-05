/**
 * 12.7 — red-team benchmarks over the API: migration 58 in both stores, the
 * benchmark route (stored saved versions, unstored drafts, the comparison
 * with the previous result, RBAC, one at a time), eval runs under a content rules
 * rule set override scored by `guard_outcome`, and eval-run verdicts kept out
 * of the Security page's numbers by default.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { GuardBenchmarkResponse, Workflow } from "@ai-orchestrator/shared";
import { DEFAULT_GUARD_PROFILE_DOCUMENT } from "@ai-orchestrator/guard-sdk";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { MIGRATIONS } from "./db/migrations.js";
import { contiguousMigrationVersions } from "./db/migration-versions.test-helper.js";
import { testSql } from "./test-support/test-sql.js";
import { openTestStore } from "./test-support/test-store.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import { QueueService } from "./services/queue-service.js";

interface TestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];

async function createTestContext(options: { queue?: boolean } = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-guard-benchmark-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "info",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "sync")
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const queue = options.queue ? new QueueService(store, { pollIntervalMs: 20 }) : undefined;
  const app = await createApp(config, store, secretService, authService, undefined, queue);
  await app.ready();
  const context = { app, store, authService, config, tempDir };
  contexts.push(context);
  return context;
}

afterEach(async () => {
  while (contexts.length > 0) {
    const context = contexts.pop()!;
    await context.app.close();
    try {
      await context.store.close();
    } catch {
      // Already closed by the app shutdown hooks.
    }
    fs.rmSync(context.tempDir, { recursive: true, force: true });
  }
});

type Role = "admin" | "builder" | "operator" | "viewer";

async function login(context: TestContext, role: Role, name: string = role): Promise<string> {
  const email = `${name}@example.com`;
  const password = `${name}-Pass-123!`;
  await context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  if (response.statusCode !== 200) throw new Error(`Login failed for ${name}: ${response.body}`);
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : [raw ?? ""];
  const cookie = values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`));
  if (!cookie) throw new Error("No session cookie");
  return cookie.split(";")[0]!;
}

const call = (context: TestContext, method: "GET" | "POST" | "PUT" | "DELETE", url: string, cookie: string, payload?: unknown) =>
  context.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

/** A rule set that blocks e-mail addresses in prompts (the built-in one allows them). */
function emailBlocking(id: string): Record<string, unknown> {
  return {
    id,
    name: "Email blocking",
    version: "1",
    channels: {
      prompt: { detectors: [{ id: "dlp.patterns", threshold: 0.5 }], actions: { email: { action: "block" }, sensitive_data: { action: "allow" } }, defaultAction: { action: "allow" } }
    }
  };
}

function guardWorkflow(id: string): Workflow {
  return {
    id,
    name: `Guarded ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      { id: "hook", type: "webhook_input", name: "Webhook", position: { x: 0, y: 0 }, config: { path: `hook-${id}`, method: "POST" } },
      { id: "guard", type: "guard", name: "Prompt content rules", position: { x: 200, y: 0 }, config: { inputField: "message" } },
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

describe("migration 59", () => {
  it("adds guard_benchmarks and guard_events.run_source, with a rollback, keeping v55-v57 reserved", () => {
    const versions = MIGRATIONS.map((entry) => entry.version).sort((a, b) => a - b);
    expect(versions).toEqual(contiguousMigrationVersions(versions));
    const migration = MIGRATIONS.find((entry) => entry.version === 59)!;
    expect(migration.description).toContain("12.7");
    for (const fragment of ["CREATE TABLE IF NOT EXISTS guard_benchmarks", "detection_rate DOUBLE PRECISION NOT NULL", "report_json TEXT NOT NULL", "created_at TIMESTAMPTZ NOT NULL", "ALTER TABLE guard_events ADD COLUMN IF NOT EXISTS run_source TEXT"]) {
      expect(migration.up).toContain(fragment);
    }
    expect(migration.down).toContain("DROP TABLE IF EXISTS guard_benchmarks");
    expect(migration.down).toContain("DROP COLUMN IF EXISTS run_source");
    expect(migration.up).not.toMatch(/AUTOINCREMENT|datetime\(|\bREAL\b/);
  });

  it("creates the table and the column in the store", async () => {
    const context = await createTestContext();
    const sql = testSql(context.store);
    const table = sql.kind === "sqlite"
      ? await sql.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, "guard_benchmarks")
      : await sql.all(`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?`, "guard_benchmarks");
    expect(table).toHaveLength(1);
    const column = sql.kind === "sqlite"
      ? (await sql.all(`PRAGMA table_info(guard_events)`)).filter((row) => (row as { name: string }).name === "run_source")
      : await sql.all(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'guard_events' AND column_name = ?`, "run_source");
    expect(column).toHaveLength(1);
  });
});

describe("POST /api/guard/profiles/:id/benchmark", () => {
  it("benchmarks and stores the default rule set, compares the next run with it, and lists and reads the results", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const first = await call(context, "POST", "/api/guard/profiles/default/benchmark", admin, {});
    expect(first.statusCode, first.body).toBe(200);
    const body = first.json<GuardBenchmarkResponse>();
    expect(body).toMatchObject({ draft: false, comparison: null, baseline: null });
    expect(body.stored?.id).toMatch(/^gbm_/);
    expect(body.report.profile).toMatchObject({ id: "default", version: "1" });
    expect(body.report.splits).toEqual(["main", "heldout"]);
    expect(body.report.categories).toHaveLength(22);
    expect(body.report.workflow).toBeUndefined();
    // Ids and counts only: no corpus content in the response.
    expect(first.body).not.toContain("Ignore all previous instructions");

    const second = (await call(context, "POST", "/api/guard/profiles/default/benchmark", admin, { suites: ["profile", "workflow"] })).json<GuardBenchmarkResponse>();
    expect(second.baseline?.id).toBe(body.stored!.id);
    expect(second.comparison).toMatchObject({ ok: true, failures: [], newlyMissed: [], newlyFlagged: [], corpusChanged: false });
    expect(second.report.workflow?.results.filter((result) => result.split === "main").map((result) => [result.configuration, result.split, result.attackSucceeded])).toEqual([
      ["guard", "main", 0],
      ["guard_untrusted_write_approval", "main", 0]
    ]);

    const list = (await call(context, "GET", "/api/guard/profiles/default/benchmarks", admin)).json<{ benchmarks: Array<{ id: string; profileVersion: number; splits: unknown[]; attackSuccessRate: number | null; suites: string[] }> }>().benchmarks;
    expect(list.map((entry) => entry.id)).toEqual([second.stored!.id, body.stored!.id]);
    expect(list[0]).toMatchObject({ profileVersion: 1, suites: ["profile", "workflow"] });
    expect(list[1]!.splits).toHaveLength(2);
    const one = await call(context, "GET", `/api/guard/benchmarks/${body.stored!.id}`, admin);
    expect(one.json<{ report: { corpus: { hash: string } } }>().report.corpus.hash).toBe(body.report.corpus.hash);
    expect(one.body).not.toContain("createdByUserId");
    expect((await call(context, "GET", "/api/guard/benchmarks/gbm_missing", admin)).statusCode).toBe(404);

    // Benchmark verdicts never reach guard_events.
    expect((await call(context, "GET", "/api/guard/events?includeEval=true", admin)).json<{ total: number }>().total).toBe(0);
  }, 60_000);

  it("returns a draft's result without storing it, compared with the saved version's", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    // A copy of the default rule set, then a draft that checks nothing.
    expect((await call(context, "POST", "/api/guard/profiles", builder, { document: { ...DEFAULT_GUARD_PROFILE_DOCUMENT, id: "mine", name: "Mine" } })).statusCode).toBe(201);
    const saved = (await call(context, "POST", "/api/guard/profiles/mine/benchmark", builder, {})).json<GuardBenchmarkResponse>();
    expect(saved.stored).not.toBeNull();
    const looser = { id: "mine", name: "Mine", version: "1", channels: {} };
    const draft = await call(context, "POST", "/api/guard/profiles/mine/benchmark", builder, { document: looser, categories: ["direct_injection", "dlp_secrets"] });
    expect(draft.statusCode, draft.body).toBe(200);
    const body = draft.json<GuardBenchmarkResponse>();
    expect(body).toMatchObject({ draft: true, stored: null, baseline: { id: saved.stored!.id, profileVersion: 1 } });
    expect(body.report.profile).toMatchObject({ id: "mine", version: "draft" });
    // The draft checks nothing, so the data rules detections it loses are regressions.
    expect(body.comparison?.ok).toBe(false);
    expect(body.comparison?.failures.some((failure) => failure.category === "dlp_secrets" && failure.metric === "detection")).toBe(true);
    expect((await call(context, "GET", "/api/guard/profiles/mine/benchmarks", builder)).json<{ benchmarks: unknown[] }>().benchmarks).toHaveLength(1);

    const invalid = await call(context, "POST", "/api/guard/profiles/mine/benchmark", builder, { document: { id: "mine", name: "x", version: "1", channels: { prompt: { detectors: [{ id: "dlp.patterns", threshold: 7 }] } } } });
    expect(invalid.statusCode).toBe(400);
    expect((await call(context, "POST", "/api/guard/profiles/mine/benchmark", builder, { categories: ["nope"] })).statusCode).toBe(400);
    expect((await call(context, "POST", "/api/guard/profiles/mine/benchmark", builder, { version: 1, document: looser })).statusCode).toBe(400);
    expect((await call(context, "POST", "/api/guard/profiles/mine/benchmark", builder, { version: 9 })).statusCode).toBe(404);

    // Deleting the rule set deletes its benchmarks.
    expect((await call(context, "DELETE", "/api/guard/profiles/mine", builder)).statusCode).toBeLessThan(300);
    expect(await context.store.getGuardBenchmark(saved.stored!.id)).toBeNull();
  });

  it("lets builders benchmark saved versions of any rule set, drafts only of rule sets they may edit, and viewers read results", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const viewer = await login(context, "viewer");
    const ok = await call(context, "POST", "/api/guard/profiles/default/benchmark", builder, {});
    expect(ok.statusCode).toBe(200);
    const draftOfBuiltIn = await call(context, "POST", "/api/guard/profiles/default/benchmark", builder, { document: emailBlocking("default"), categories: ["sql_injection"] });
    expect(draftOfBuiltIn.statusCode).toBe(403);
    expect(draftOfBuiltIn.json<{ error: string }>().error).toContain("default rule set is read-only");
    expect((await call(context, "POST", "/api/guard/profiles/default/benchmark", viewer, {})).statusCode).toBe(403);
    expect((await call(context, "POST", "/api/guard/profiles/nope/benchmark", builder, {})).statusCode).toBe(404);
    expect((await call(context, "GET", "/api/guard/profiles/default/benchmarks", viewer)).json<{ benchmarks: unknown[] }>().benchmarks).toHaveLength(1);
    expect((await call(context, "GET", "/api/guard/profiles/nope/benchmarks", viewer)).statusCode).toBe(404);
  });

  it("stores only full runs, never uses a partial one as the baseline, and lets a builder store one run per version every 10 minutes", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const full = (await call(context, "POST", "/api/guard/profiles/default/benchmark", builder, {})).json<GuardBenchmarkResponse>();
    expect(full).toMatchObject({ partial: false });
    expect(full.stored).not.toBeNull();
    for (const filter of [{ categories: ["sql_injection"] }, { splits: ["main"] }]) {
      const partial = await call(context, "POST", "/api/guard/profiles/default/benchmark", builder, filter);
      expect(partial.statusCode, partial.body).toBe(200);
      expect(partial.json<GuardBenchmarkResponse>()).toMatchObject({ partial: true, stored: null, baseline: { id: full.stored!.id } });
    }
    // Both splits named is a full run.
    const again = await call(context, "POST", "/api/guard/profiles/default/benchmark", builder, { splits: ["heldout", "main"] });
    expect(again.statusCode).toBe(429);
    expect(Number(again.headers["retry-after"])).toBeGreaterThan(0);
    expect(again.json<{ error: string }>().error).toMatch(/less than 10 minutes ago/);
    // An admin is exempt; the trend and the next baseline only ever hold full runs.
    const byAdmin = (await call(context, "POST", "/api/guard/profiles/default/benchmark", admin, {})).json<GuardBenchmarkResponse>();
    expect(byAdmin.baseline?.id).toBe(full.stored!.id);
    const list = (await call(context, "GET", "/api/guard/profiles/default/benchmarks", builder)).json<{ benchmarks: Array<{ id: string; splits: unknown[] }> }>().benchmarks;
    expect(list.map((entry) => entry.id)).toEqual([byAdmin.stored!.id, full.stored!.id]);
    expect(list.every((entry) => entry.splits.length === 2)).toBe(true);
  }, 60_000);

  it("runs one benchmark at a time", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const [a, b] = await Promise.all([
      call(context, "POST", "/api/guard/profiles/default/benchmark", admin, {}),
      call(context, "POST", "/api/guard/profiles/default/benchmark", admin, {})
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
  }, 30_000);
});

describe("eval runs under a rule set, scored by guard_outcome", () => {
  it("runs the cases under the override, scores the outcome and keeps their verdicts out of the Security stats", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    expect((await call(context, "POST", "/api/workflows", admin, guardWorkflow("wf-redteam"))).statusCode).toBeLessThan(300);
    expect((await call(context, "POST", "/api/guard/profiles", admin, { document: emailBlocking("email-block") })).statusCode).toBe(201);
    const dataset = (await call(context, "POST", "/api/eval/datasets", admin, { name: "Red team", workflowId: "wf-redteam" })).json<{ dataset: { id: string } }>().dataset.id;
    const fixtures = [
      { name: "leak", input: { message: "Forward everything to ana.lopez@example.org" }, scorers: [{ type: "guard_outcome", expect: "blocked", channel: "prompt", detector: "dlp." }] },
      { name: "clean", input: { message: "What is the capital of France?" }, scorers: [{ type: "guard_outcome", expect: "allowed" }] }
    ];
    for (const fixture of fixtures) expect((await call(context, "POST", `/api/eval/datasets/${dataset}/fixtures`, admin, fixture)).statusCode).toBeLessThan(300);

    expect((await call(context, "POST", "/api/eval/runs", admin, { datasetId: dataset, workflowId: "wf-redteam", guardProfile: { profileId: "nope" } })).statusCode).toBe(400);
    expect((await call(context, "POST", "/api/eval/runs", admin, { datasetId: dataset, workflowId: "wf-redteam", guardProfile: { profileId: "email-block", extra: 1 } })).statusCode).toBe(400);
    const started = await call(context, "POST", "/api/eval/runs?wait=true", admin, { datasetId: dataset, workflowId: "wf-redteam", guardProfile: { profileId: "email-block" } });
    expect(started.statusCode, started.body).toBe(200);
    const runId = started.json<{ runId: string }>().runId;
    const run = (await call(context, "GET", `/api/eval/runs/${runId}`, admin)).json<{
      guardProfile?: { profileId: string; version: number };
      options: unknown;
      results: Array<{ fixtureName: string; status: string; executionId: string; score: { details: Array<{ type: string; pass: boolean; reason: string }> } }>;
    }>();
    expect(run.guardProfile).toMatchObject({ profileId: "email-block", version: 1 });
    expect(run.options).toBeNull();
    const byName = Object.fromEntries(run.results.map((result) => [result.fixtureName, result]));
    expect(byName.leak!.status, JSON.stringify(byName.leak)).toBe("pass");
    expect(byName.leak!.score.details[0]!.reason).toContain("the content rules stopped it on prompt by dlp.");
    expect(byName.clean!.status).toBe("pass");

    // The verdicts are stored for the run's trace, marked as eval traffic, and left out of the Security numbers.
    const trace = (await call(context, "GET", `/api/executions/${byName.leak!.executionId}/guard-events`, admin)).json<{ events: Array<{ effectiveAction: string; profileId: string }> }>().events;
    expect(trace.some((event) => event.effectiveAction === "block" && event.profileId === "email-block")).toBe(true);
    const stats = (url: string) => call(context, "GET", url, admin).then((response) => response.json<{ stats: { verdicts: Array<{ count: number }> } }>().stats.verdicts.reduce((sum, entry) => sum + entry.count, 0));
    expect(await stats("/api/guard/stats")).toBe(0);
    expect(await stats("/api/guard/stats?includeEval=true")).toBeGreaterThan(0);
    expect((await call(context, "GET", "/api/guard/events", admin)).json<{ total: number }>().total).toBe(0);
    expect((await call(context, "GET", "/api/guard/events?includeEval=1", admin)).json<{ total: number }>().total).toBeGreaterThan(0);

    // A production run of the same workflow still counts.
    expect((await context.app.inject({ method: "POST", url: "/webhook/hook-wf-redteam", payload: { message: "hello" } })).statusCode).toBeLessThan(500);
  });

  it("refuses reserved trigger names on enqueue, so a queued production run's verdicts stay on the Security page", async () => {
    const context = await createTestContext({ queue: true });
    const admin = await login(context, "admin");
    const operator = await login(context, "operator");
    expect((await call(context, "POST", "/api/workflows", admin, guardWorkflow("wf-queued"))).statusCode).toBeLessThan(300);
    for (const triggerType of ["eval", "Eval", " replay ", "replay_live", "approval_resume", "eval_judge", "mcp_replay"]) {
      const refused = await call(context, "POST", "/api/workflows/wf-queued/enqueue", operator, { triggerType, input: { message: "hello" } });
      expect(refused.statusCode, triggerType).toBe(400);
      expect(refused.json<{ error: string }>().error).toContain("reserved");
    }
    expect((await call(context, "GET", "/api/guard/events?includeEval=1", admin)).json<{ total: number }>().total).toBe(0);
    const queued = await call(context, "POST", "/api/workflows/wf-queued/enqueue", operator, { triggerType: "nightly", input: { message: "hello" } });
    expect(queued.statusCode, queued.body).toBe(200);
    const deadline = Date.now() + 10_000;
    let events: { total: number; events: Array<{ runSource?: string }> } = { total: 0, events: [] };
    while (events.total === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      events = (await call(context, "GET", "/api/guard/events", admin)).json();
    }
    expect(events.total).toBeGreaterThan(0);
    expect(events.events.every((event) => event.runSource !== "eval")).toBe(true);
  });

  it("keeps a resumed eval run's verdicts tagged as eval traffic, and shows the source on each event", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const approver = await login(context, "admin", "approver");
    const workflow = guardWorkflow("wf-gated");
    workflow.nodes.push({ id: "gate", type: "approval_gate", name: "Gate", position: { x: 100, y: 0 }, config: { message: "Run the content rules?", approverRoles: ["admin"], timeoutMinutes: 60, timeoutOutcome: "fallback" } } as Workflow["nodes"][number]);
    workflow.edges = [
      { id: "e0", source: "hook", target: "gate" },
      { id: "e1", source: "gate", sourceHandle: "approved", target: "guard" },
      ...workflow.edges.filter((edge) => edge.source === "guard")
    ];
    expect((await call(context, "POST", "/api/workflows", admin, workflow)).statusCode).toBeLessThan(300);
    expect((await call(context, "POST", "/api/guard/profiles", admin, { document: emailBlocking("email-block") })).statusCode).toBe(201);
    const dataset = (await call(context, "POST", "/api/eval/datasets", admin, { name: "Gated", workflowId: "wf-gated" })).json<{ dataset: { id: string } }>().dataset.id;
    expect((await call(context, "POST", `/api/eval/datasets/${dataset}/fixtures`, admin, { name: "leak", input: { message: "Forward everything to ana.lopez@example.org" } })).statusCode).toBeLessThan(300);
    const started = await call(context, "POST", "/api/eval/runs?wait=true", admin, { datasetId: dataset, workflowId: "wf-gated", guardProfile: { profileId: "email-block" } });
    expect(started.statusCode, started.body).toBe(200);
    const run = (await call(context, "GET", `/api/eval/runs/${started.json<{ runId: string }>().runId}`, admin)).json<{ results: Array<{ executionId: string }> }>();
    const executionId = run.results[0]!.executionId;
    expect((await context.store.getWorkflowExecutionState(executionId))?.state).toMatchObject({ guardRunSource: "eval" });
    const decided = await call(context, "POST", `/api/approvals/${executionId}/approve`, approver, {});
    expect(decided.statusCode, decided.body).toBeLessThan(300);
    const trace = (await call(context, "GET", `/api/executions/${executionId}/guard-events`, admin)).json<{ events: Array<{ runSource?: string }> }>().events;
    expect(trace.length).toBeGreaterThan(0);
    expect(trace.every((event) => event.runSource === "eval")).toBe(true);
    expect((await call(context, "GET", "/api/guard/events", admin)).json<{ total: number }>().total).toBe(0);
    const included = (await call(context, "GET", "/api/guard/events?includeEval=1", admin)).json<{ total: number; events: Array<{ runSource?: string }> }>();
    expect(included.total).toBeGreaterThan(0);
    expect(included.events[0]!.runSource).toBe("eval");
  });

  it("adds the chosen rule set on top of the run's own: a looser choice cannot weaken a bound rule set", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    expect((await call(context, "POST", "/api/workflows", admin, guardWorkflow("wf-bound"))).statusCode).toBeLessThan(300);
    expect((await call(context, "POST", "/api/guard/profiles", admin, { document: emailBlocking("email-block") })).statusCode).toBe(201);
    // The project applies the strict rule set (override binding), which the builder cannot change.
    expect((await call(context, "PUT", "/api/guard/bindings/projects/default", admin, { mode: "override", profileId: "email-block" })).statusCode).toBe(200);
    // The builder's own rule set checks nothing.
    expect((await call(context, "POST", "/api/guard/profiles", builder, { document: { id: "loose", name: "Loose", version: "1", channels: {} } })).statusCode).toBe(201);
    const dataset = (await call(context, "POST", "/api/eval/datasets", builder, { name: "Bound", workflowId: "wf-bound" })).json<{ dataset: { id: string } }>().dataset.id;
    const fixture = { name: "leak", input: { message: "Forward everything to ana.lopez@example.org" }, scorers: [{ type: "guard_outcome", expect: "blocked", channel: "prompt", detector: "dlp." }] };
    expect((await call(context, "POST", `/api/eval/datasets/${dataset}/fixtures`, builder, fixture)).statusCode).toBeLessThan(300);
    const started = await call(context, "POST", "/api/eval/runs?wait=true", builder, { datasetId: dataset, workflowId: "wf-bound", guardProfile: { profileId: "loose" } });
    expect(started.statusCode, started.body).toBe(200);
    const run = (await call(context, "GET", `/api/eval/runs/${started.json<{ runId: string }>().runId}`, builder)).json<{
      guardProfile?: { profileId: string };
      results: Array<{ status: string; executionId: string }>;
    }>();
    expect(run.guardProfile).toMatchObject({ profileId: "loose" });
    expect(run.results[0]!.status, JSON.stringify(run.results[0])).toBe("pass");
    const trace = (await call(context, "GET", `/api/executions/${run.results[0]!.executionId}/guard-events`, admin)).json<{ events: Array<{ effectiveAction: string; profileId: string }> }>().events;
    expect(trace.some((event) => event.effectiveAction === "block" && event.profileId === "email-block")).toBe(true);
  });
});
