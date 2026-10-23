/**
 * Phase 15.4 — release gate and publish over the API: production traffic
 * runs the published version while the editor and /webhook-test/ run the
 * draft; publishing binds to the exact hash of a saved version and a
 * passing replay job judged under the current policy; admin overrides,
 * enforced gates, release requests in the approvals inbox, rollback,
 * retention pinning, project scoping and migration 33.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { EvalRunView, ReleaseApprovalRequestView, ReleaseGateView, Workflow, WorkflowNode, WorkflowRelease } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import { SqliteStore } from "./db/database.js";
import { MIGRATIONS } from "./db/migrations.js";
import { AuthService } from "./services/auth-service.js";
import { SchedulerService } from "./services/scheduler-service.js";
import { SecretService } from "./services/secret-service.js";
import { WorkflowVersionService } from "./services/workflow-version-service.js";

interface TestContext {
  app: FastifyInstance;
  store: SqliteStore;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
  scheduler?: SchedulerService;
}

const contexts: TestContext[] = [];

async function createTestContext(options: { overrides?: Record<string, string>; scheduler?: boolean } = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-release-"));
  const store = await SqliteStore.create(path.join(tempDir, "orchestrator.db"));
  store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "sync"),
    ...(options.overrides ?? {})
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const scheduler = options.scheduler ? new SchedulerService(store, () => undefined) : undefined;
  const app = createApp(config, store, secretService, authService, scheduler);
  await app.ready();
  const context: TestContext = { app, store, authService, config, tempDir, ...(scheduler ? { scheduler } : {}) };
  contexts.push(context);
  return context;
}

afterEach(async () => {
  while (contexts.length > 0) {
    const context = contexts.pop()!;
    context.scheduler?.stop();
    await context.app.close();
    try {
      context.store.close();
    } catch {
      // Already closed by the app shutdown hooks.
    }
    fs.rmSync(context.tempDir, { recursive: true, force: true });
  }
});

type Role = "admin" | "builder" | "operator" | "viewer";

async function login(context: TestContext, role: Role, name: string = role): Promise<{ cookie: string; id: string; email: string }> {
  const email = `${name}@example.com`;
  const password = `${name}-Pass-123!`;
  const existing = context.store.getUserByEmail(email);
  const id = existing ? existing.id : context.authService.register({ email, password, role }).id;
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  if (response.statusCode !== 200) throw new Error(`Login failed for ${name}: ${response.body}`);
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : [raw ?? ""];
  const cookie = values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`))!;
  return { cookie: cookie.split(";")[0]!, id, email };
}

const call = (context: TestContext, method: "GET" | "POST" | "PUT" | "DELETE", url: string, cookie: string, payload?: unknown) =>
  context.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

function node(id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], name: id, position: { x: 0, y: 0 }, config };
}

/** webhook → output that answers `answer`. */
function hookWorkflow(id: string, answer: string, projectId = "default", hookPath = `hook-${id}`): Workflow {
  return {
    id,
    name: `Release ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId,
    nodes: [node("hook", "webhook_input", { path: hookPath, method: "POST" }), node("out", "output", { responseTemplate: answer })],
    edges: [{ id: "e1", source: "hook", target: "out" }]
  } as Workflow;
}

/** Saves the draft and snapshots it as the next version, as the save route does. */
function save(context: TestContext, workflow: Workflow): number {
  const saved = context.store.upsertWorkflow(workflow);
  return new WorkflowVersionService(context.store).snapshot({ workflow: saved, changeNote: "test" }).version;
}

function goldenSet(context: TestContext, workflowId: string, id = `set-${workflowId}`): string {
  context.store.createEvalDataset({ id, name: `Golden ${workflowId}`, workflowId });
  return id;
}

async function versionHash(context: TestContext, cookie: string, workflowId: string, version: number): Promise<string> {
  const response = await call(context, "GET", `/api/workflows/${workflowId}/publish-preview?version=${version}`, cookie);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ preview: { workflowHash: string } }>().preview.workflowHash;
}

/** A finished replay job as the 15.2 runner stores it, without running anything. */
function seedJob(
  context: TestContext,
  input: { workflowId: string; datasetIds: string[]; version: number; hash: string; statuses: Array<"pass" | "fail" | "error">; status?: string; options?: Record<string, unknown> }
): string {
  const id = `run_${crypto.randomUUID()}`;
  context.store.createEvalRun({
    id,
    datasetId: input.datasetIds[0]!,
    workflowId: input.workflowId,
    kind: "replay",
    status: "running",
    datasetIds: input.datasetIds,
    candidate: { kind: "version", version: input.version, workflowHash: input.hash },
    workflowHash: input.hash,
    workflowVersion: input.version,
    options: { mcpMode: "strict", maxCostUsd: 5, ...(input.options ?? {}) }
  });
  input.statuses.forEach((status, index) => {
    context.store.recordEvalResult({
      id: `res_${index}_${id}`,
      runId: id,
      fixtureId: `fx_${index}`,
      status,
      score: { pass: status === "pass", details: [{ type: "status", pass: status === "pass", reason: status }] }
    });
  });
  context.store.finalizeEvalRun({ id, status: (input.status ?? "completed") as "completed" });
  return id;
}

async function enableGate(context: TestContext, cookie: string, workflowId: string, settings: Record<string, unknown> = {}): Promise<ReleaseGateView> {
  const response = await call(context, "PUT", `/api/workflows/${workflowId}/release-gate`, cookie, { enabled: true, datasetIds: [goldenSetId(context, workflowId)], ...settings });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ gate: ReleaseGateView }>().gate;
}

function goldenSetId(context: TestContext, workflowId: string): string {
  const id = `set-${workflowId}`;
  if (!context.store.getEvalDataset(id)) goldenSet(context, workflowId, id);
  return id;
}

const prodHook = async (context: TestContext, hookPath: string) => {
  const response = await context.app.inject({ method: "POST", url: `/webhook/${hookPath}`, payload: {} });
  return { status: response.statusCode, output: response.json<{ output?: unknown }>().output };
};
const testHook = async (context: TestContext, hookPath: string) => {
  const response = await context.app.inject({ method: "POST", url: `/webhook-test/${hookPath}`, payload: {} });
  return { status: response.statusCode, output: response.json<{ output?: unknown }>().output };
};

const auditTypes = (context: TestContext) => context.store.listAuditLogs({ category: "release", pageSize: 200 }).items.map((entry) => entry.eventType);

describe("migration 33", () => {
  it("adds the release tables in Postgres DDL with a down path, and the same in SQLite", async () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 33)!;
    expect(migration.up).toContain("ADD COLUMN IF NOT EXISTS published_version");
    expect(migration.up).toContain("ADD COLUMN IF NOT EXISTS pinned");
    for (const table of ["release_gates", "workflow_releases", "release_approval_requests"]) {
      expect(migration.up).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(migration.down).toContain(`DROP TABLE IF EXISTS ${table}`);
    }
    const context = await createTestContext();
    const db = (context.store as unknown as { db: { prepare: (sql: string) => { all: () => Array<{ name: string }> } } }).db;
    const columns = (table: string) => db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    expect(columns("workflows")).toContain("published_version");
    expect(columns("workflow_versions")).toContain("pinned");
    expect(columns("release_gates")).toEqual(expect.arrayContaining(["enforced", "policy_json", "require_approval", "approvers_json"]));
    expect(columns("workflow_releases")).toEqual(expect.arrayContaining(["version", "workflow_hash", "verdict", "reason", "approval_json"]));
    expect(columns("release_approval_requests")).toEqual(expect.arrayContaining(["version", "workflow_hash", "spec_json", "status", "release_id"]));
  });
});

describe("gate off: nothing changes", () => {
  it("runs the draft everywhere until a version is published", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    save(context, hookWorkflow("wf-off", "one"));
    save(context, hookWorkflow("wf-off", "two"));
    expect(await prodHook(context, "hook-wf-off")).toMatchObject({ status: 200, output: { result: "two" } });
    const releases = (await call(context, "GET", "/api/workflows/wf-off/releases", builder.cookie)).json<{ releases: WorkflowRelease[]; publishedVersion: number | null }>();
    expect(releases).toEqual({ releases: [], publishedVersion: null });
    const gate = (await call(context, "GET", "/api/workflows/wf-off/release-gate", builder.cookie)).json<{ gate: ReleaseGateView }>().gate;
    expect(gate).toMatchObject({ enabled: false, enforced: false, datasetIds: [], requireApproval: false, approvers: null });
    // An ungated publish pins production to that version.
    const published = await call(context, "POST", "/api/workflows/wf-off/publish", builder.cookie, { version: 1 });
    expect(published.statusCode, published.body).toBe(200);
    expect(published.json<{ release: WorkflowRelease }>().release).toMatchObject({ version: 1, verdict: "ungated", previousVersion: null, publishedBy: builder.email });
    expect(await prodHook(context, "hook-wf-off")).toMatchObject({ output: { result: "one" } });
    expect(await testHook(context, "hook-wf-off")).toMatchObject({ output: { result: "two" } });
    expect(auditTypes(context)).toContain("release.published");
  });
});

describe("the release gate", () => {
  it("acceptance: a regressing edit can be saved and tested but reaches production only through a passing job, an approver or an admin override", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const v1 = save(context, hookWorkflow("wf-gate", "good"));
    expect((await call(context, "POST", "/api/workflows/wf-gate/publish", builder.cookie, { version: v1 })).statusCode).toBe(200);
    await enableGate(context, builder.cookie, "wf-gate");
    const setId = goldenSetId(context, "wf-gate");

    // The regressing edit saves and runs on the test webhook; production still answers v1.
    const v2 = save(context, hookWorkflow("wf-gate", "bad"));
    expect(await testHook(context, "hook-wf-gate")).toMatchObject({ output: { result: "bad" } });
    expect(await prodHook(context, "hook-wf-gate")).toMatchObject({ output: { result: "good" } });
    const manual = await call(context, "POST", "/api/workflows/wf-gate/execute", builder.cookie, {});
    expect(manual.json<{ output: unknown }>().output).toMatchObject({ result: "bad" });

    // No job for that hash: blocked.
    const noJob = await call(context, "POST", "/api/workflows/wf-gate/publish", builder.cookie, { version: v2 });
    expect(noJob.statusCode).toBe(409);
    expect(noJob.json()).toMatchObject({ verdict: "blocked", canRequestApproval: false });
    expect(noJob.json<{ reasons: string[] }>().reasons.join()).toMatch(/No completed replay job/);

    // A failing job: blocked, with the job named.
    const hash2 = await versionHash(context, builder.cookie, "wf-gate", v2);
    const failing = seedJob(context, { workflowId: "wf-gate", datasetIds: [setId], version: v2, hash: hash2, statuses: ["pass", "fail", "fail"] });
    const blocked = await call(context, "POST", "/api/workflows/wf-gate/publish", builder.cookie, { version: v2 });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ verdict: "blocked", replayRunId: failing });
    expect(blocked.json<{ reasons: string[] }>().reasons.join("\n")).toMatch(/2 regressions/);
    expect(await prodHook(context, "hook-wf-gate")).toMatchObject({ output: { result: "good" } });

    // A builder cannot override; an admin can, with a reason, and it is audited and stored.
    expect((await call(context, "POST", "/api/workflows/wf-gate/publish", builder.cookie, { version: v2, override: { reason: "ship it" } })).statusCode).toBe(403);
    expect((await call(context, "POST", "/api/workflows/wf-gate/publish", admin.cookie, { version: v2, override: { reason: "" } })).statusCode).toBe(400);
    const overridden = await call(context, "POST", "/api/workflows/wf-gate/publish", admin.cookie, { version: v2, override: { reason: "Hotfix for incident 42" } });
    expect(overridden.statusCode, overridden.body).toBe(200);
    expect(overridden.json<{ release: WorkflowRelease }>().release).toMatchObject({
      version: v2,
      verdict: "overridden",
      reason: "Hotfix for incident 42",
      replayRunId: failing,
      previousVersion: v1
    });
    expect(await prodHook(context, "hook-wf-gate")).toMatchObject({ output: { result: "bad" } });
    const overrideAudit = context.store.listAuditLogs({ eventType: "release.overridden", pageSize: 10 }).items[0]!;
    expect(overrideAudit).toMatchObject({ actorEmail: admin.email, resourceId: "wf-gate" });
    expect(JSON.stringify(overrideAudit.metadata)).toContain("Hotfix for incident 42");

    // Roll back to v1: production answers good again.
    expect((await call(context, "POST", "/api/workflows/wf-gate/rollback", builder.cookie, { version: v1 })).statusCode).toBe(400);
    const rolledBack = await call(context, "POST", "/api/workflows/wf-gate/rollback", builder.cookie, { version: v1, reason: "Regression in prod" });
    expect(rolledBack.statusCode, rolledBack.body).toBe(200);
    expect(rolledBack.json<{ release: WorkflowRelease }>().release).toMatchObject({ version: v1, verdict: "rollback", previousVersion: v2 });
    expect(await prodHook(context, "hook-wf-gate")).toMatchObject({ output: { result: "good" } });
    expect((await call(context, "POST", "/api/workflows/wf-gate/rollback", builder.cookie, { version: v1, reason: "again" })).statusCode).toBe(409);

    // A fixed version with a passing job publishes as passed; the hash must match.
    const v3 = save(context, hookWorkflow("wf-gate", "fixed"));
    expect((await call(context, "POST", "/api/workflows/wf-gate/rollback", builder.cookie, { version: v3, reason: "never published" })).statusCode).toBe(409);
    const hash3 = await versionHash(context, builder.cookie, "wf-gate", v3);
    expect(hash3).not.toBe(hash2);
    const passing = seedJob(context, { workflowId: "wf-gate", datasetIds: [setId], version: v3, hash: hash3, statuses: ["pass", "pass", "pass"] });
    // A job for another version's hash does not count.
    const wrongJob = await call(context, "POST", "/api/workflows/wf-gate/publish", builder.cookie, { version: v3, replayRunId: failing });
    expect(wrongJob.statusCode).toBe(409);
    expect(wrongJob.json<{ reasons: string[] }>().reasons.join()).toMatch(/different workflow hash/);
    const mismatch = await call(context, "POST", "/api/workflows/wf-gate/publish", builder.cookie, { version: v3, workflowHash: hash2 });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json<{ reasons: string[] }>().reasons.join()).toMatch(/not what was tested/);
    const passed = await call(context, "POST", "/api/workflows/wf-gate/publish", builder.cookie, { version: v3, workflowHash: hash3 });
    expect(passed.statusCode, passed.body).toBe(200);
    expect(passed.json<{ release: WorkflowRelease }>().release).toMatchObject({ version: v3, verdict: "passed", replayRunId: passing });
    expect(await prodHook(context, "hook-wf-gate")).toMatchObject({ output: { result: "fixed" } });

    const history = (await call(context, "GET", "/api/workflows/wf-gate/releases", builder.cookie)).json<{ releases: WorkflowRelease[]; publishedVersion: number }>();
    expect(history.publishedVersion).toBe(v3);
    expect(history.releases.map((release) => release.verdict)).toEqual(["passed", "rollback", "overridden", "ungated"]);
    expect(auditTypes(context)).toEqual(expect.arrayContaining(["release.gate.updated", "release.blocked", "release.overridden", "release.rolled_back", "release.published"]));
    const state = (await call(context, "GET", "/api/workflows/wf-gate/release-state", builder.cookie)).json<{ state: Record<string, unknown> }>().state;
    expect(state).toEqual({ draftVersion: v3, publishedVersion: v3, aheadBy: 0, gateEnabled: true, gateEnforced: false });
  });

  it("re-judges a job under the policy in force at publish time", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const version = save(context, hookWorkflow("wf-rejudge", "x"));
    await enableGate(context, builder.cookie, "wf-rejudge");
    const hash = await versionHash(context, builder.cookie, "wf-rejudge", version);
    seedJob(context, { workflowId: "wf-rejudge", datasetIds: ["set-wf-rejudge"], version, hash, statuses: ["pass", "pass", "fail"] });
    expect((await call(context, "POST", "/api/workflows/wf-rejudge/publish", builder.cookie, { version })).statusCode).toBe(409);
    await enableGate(context, builder.cookie, "wf-rejudge", { policy: { maxRegressions: 1, minPassRate: 0.6 } });
    const published = await call(context, "POST", "/api/workflows/wf-rejudge/publish", builder.cookie, { version });
    expect(published.statusCode, published.body).toBe(200);
    // The loosening is in the audit trail.
    const loosened = context.store.listAuditLogs({ eventType: "release.gate.updated", pageSize: 10 }).items.map((entry) => JSON.stringify(entry.metadata));
    expect(loosened.some((entry) => entry.includes("allows more regressions"))).toBe(true);
    // Tightening again blocks the next publish of a job that passed before.
    await enableGate(context, builder.cookie, "wf-rejudge", { policy: { minCases: 5 } });
    const v2 = save(context, hookWorkflow("wf-rejudge", "y"));
    const hash2 = await versionHash(context, builder.cookie, "wf-rejudge", v2);
    seedJob(context, { workflowId: "wf-rejudge", datasetIds: ["set-wf-rejudge"], version: v2, hash: hash2, statuses: ["pass", "pass", "pass"] });
    const tooFew = await call(context, "POST", "/api/workflows/wf-rejudge/publish", builder.cookie, { version: v2 });
    expect(tooFew.statusCode).toBe(409);
    expect(tooFew.json<{ reasons: string[] }>().reasons.join()).toMatch(/at least 5/);
  });

  it("refuses jobs that are unfinished, miss a golden set, used lenient MCP on a strict gate or allowed live writes", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const version = save(context, hookWorkflow("wf-jobs", "x"));
    const second = goldenSet(context, "wf-jobs", "set-wf-jobs-2");
    await enableGate(context, builder.cookie, "wf-jobs", { datasetIds: ["set-wf-jobs", second].map((id) => (id === "set-wf-jobs" ? goldenSetId(context, "wf-jobs") : id)), candidateOptions: { mcpMode: "strict" } });
    const hash = await versionHash(context, builder.cookie, "wf-jobs", version);
    const reasonsFor = async (runId: string) => {
      const response = await call(context, "POST", "/api/workflows/wf-jobs/publish", builder.cookie, { version, replayRunId: runId });
      expect(response.statusCode).toBe(409);
      return response.json<{ reasons: string[] }>().reasons.join("\n");
    };
    const all = ["set-wf-jobs", second];
    expect(await reasonsFor(seedJob(context, { workflowId: "wf-jobs", datasetIds: ["set-wf-jobs"], version, hash, statuses: ["pass", "pass", "pass"] }))).toMatch(/did not cover/);
    expect(await reasonsFor(seedJob(context, { workflowId: "wf-jobs", datasetIds: all, version, hash, statuses: ["pass", "pass", "pass"], status: "canceled" }))).toMatch(/canceled, not completed/);
    expect(await reasonsFor(seedJob(context, { workflowId: "wf-jobs", datasetIds: all, version, hash, statuses: ["pass", "pass", "pass"], options: { mcpMode: "lenient" } }))).toMatch(/strictly/);
    expect(await reasonsFor(seedJob(context, { workflowId: "wf-jobs", datasetIds: all, version, hash, statuses: ["pass", "pass", "pass"], options: { overrides: { mcpServers: { srv: "live" } } } }))).toMatch(/live write/);
    // Another workflow's job is not found.
    save(context, hookWorkflow("wf-other", "x"));
    const foreign = seedJob(context, { workflowId: "wf-other", datasetIds: [goldenSet(context, "wf-other")], version: 1, hash, statuses: ["pass", "pass", "pass"] });
    expect((await call(context, "POST", "/api/workflows/wf-jobs/publish", builder.cookie, { version, replayRunId: foreign })).statusCode).toBe(404);
    // A gate's golden set must be the workflow's own.
    expect((await call(context, "PUT", "/api/workflows/wf-jobs/release-gate", builder.cookie, { enabled: true, datasetIds: ["set-wf-other"] })).statusCode).toBe(400);
    expect((await call(context, "PUT", "/api/workflows/wf-jobs/release-gate", builder.cookie, { enabled: true, datasetIds: [] })).statusCode).toBe(400);
    expect((await call(context, "POST", "/api/workflows/wf-jobs/publish", builder.cookie, { version: 99 })).statusCode).toBe(404);
  });

  it("an enforced gate cannot be disabled or loosened by a builder", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    save(context, hookWorkflow("wf-enforced", "x"));
    expect((await call(context, "PUT", "/api/workflows/wf-enforced/release-gate", builder.cookie, { enabled: true, enforced: true, datasetIds: [goldenSetId(context, "wf-enforced")] })).statusCode).toBe(403);
    const gate = await enableGate(context, admin.cookie, "wf-enforced", { enforced: true, policy: { maxCostIncreasePct: 10 } });
    expect(gate.enforced).toBe(true);
    const put = (body: Record<string, unknown>) => call(context, "PUT", "/api/workflows/wf-enforced/release-gate", builder.cookie, { enabled: true, datasetIds: ["set-wf-enforced"], policy: { maxCostIncreasePct: 10 }, ...body });
    expect((await put({ enabled: false })).statusCode).toBe(403);
    const looser = await put({ policy: { maxCostIncreasePct: 50 } });
    expect(looser.statusCode).toBe(403);
    expect(looser.json<{ error: string }>().error).toMatch(/raises or removes the cost limit/);
    expect((await put({ policy: {} })).statusCode).toBe(403);
    expect((await put({ enforced: false })).statusCode).toBe(403);
    // Tightening is fine, and the gate stays enforced.
    const tighter = await put({ policy: { maxCostIncreasePct: 5, minCases: 4 } });
    expect(tighter.statusCode, tighter.body).toBe(200);
    expect(tighter.json<{ gate: ReleaseGateView }>().gate).toMatchObject({ enforced: true, policy: { maxCostIncreasePct: 5, minCases: 4 } });
    // An admin may lift it.
    expect((await call(context, "PUT", "/api/workflows/wf-enforced/release-gate", admin.cookie, { enabled: false, enforced: false })).statusCode).toBe(200);
  });
});

describe("release requests in the approvals inbox", () => {
  it("a gate that requires approval answers 202; another approver publishes, the requester cannot self-approve", async () => {
    const context = await createTestContext();
    const requester = await login(context, "builder", "requester");
    const lead = await login(context, "builder", "lead");
    const operator = await login(context, "operator", "ops");
    const version = save(context, hookWorkflow("wf-approve", "approved"));
    await enableGate(context, requester.cookie, "wf-approve", { requireApproval: true, approvers: { approverRoles: ["builder"] } });
    const hash = await versionHash(context, requester.cookie, "wf-approve", version);
    const runId = seedJob(context, { workflowId: "wf-approve", datasetIds: ["set-wf-approve"], version, hash, statuses: ["pass", "pass", "pass"] });
    const asked = await call(context, "POST", "/api/workflows/wf-approve/publish", requester.cookie, { version });
    expect(asked.statusCode, asked.body).toBe(202);
    const { approvalRequestId } = asked.json<{ verdict: string; approvalRequestId: string }>();
    expect(asked.json()).toMatchObject({ verdict: "needs_approval" });
    // Asking again returns the same pending request.
    expect((await call(context, "POST", "/api/workflows/wf-approve/publish", requester.cookie, { version })).json()).toMatchObject({ approvalRequestId });
    expect(context.store.getPublishedVersion("wf-approve")).toBeNull();

    const items = (await call(context, "GET", "/api/approvals", lead.cookie)).json<{ items: Array<ReleaseApprovalRequestView> }>().items;
    const item = items.find((entry) => entry.id === approvalRequestId)!;
    expect(item).toMatchObject({ kind: "release", version, workflowHash: hash, replayRunId: runId, origin: "policy", status: "pending", canDecide: true, requestedBy: requester.email });
    const own = (await call(context, "GET", "/api/approvals", requester.cookie)).json<{ items: Array<ReleaseApprovalRequestView> }>().items.find((entry) => entry.id === approvalRequestId)!;
    expect(own).toMatchObject({ canDecide: false });
    expect(own.cannotDecideReason).toMatch(/your own release/);
    // Filtered to one execution, the inbox holds no release requests.
    expect((await call(context, "GET", "/api/approvals?executionId=nope", lead.cookie)).statusCode).toBe(404);

    expect((await call(context, "POST", `/api/approvals/${approvalRequestId}/approve`, requester.cookie, {})).statusCode).toBe(403);
    // An operator cannot publish, so cannot approve.
    expect((await call(context, "POST", `/api/approvals/${approvalRequestId}/approve`, operator.cookie, {})).statusCode).toBe(403);
    const approved = await call(context, "POST", `/api/approvals/${approvalRequestId}/approve`, lead.cookie, { reason: "Looks right" });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json<{ release: WorkflowRelease }>().release).toMatchObject({ version, workflowHash: hash, verdict: "approved", publishedBy: lead.email, approval: { requestId: approvalRequestId, requestedBy: requester.email, decidedBy: lead.email } });
    expect(context.store.getPublishedVersion("wf-approve")).toBe(version);
    expect(await prodHook(context, "hook-wf-approve")).toMatchObject({ output: { result: "approved" } });
    expect((await call(context, "POST", `/api/approvals/${approvalRequestId}/approve`, lead.cookie, {})).statusCode).toBe(409);
    expect(auditTypes(context)).toEqual(expect.arrayContaining(["release.approval.requested", "release.approval.decided", "release.published"]));
    const decided = (await call(context, "GET", "/api/approvals?status=decided", lead.cookie)).json<{ items: Array<ReleaseApprovalRequestView> }>().items;
    expect(decided.find((entry) => entry.id === approvalRequestId)).toMatchObject({ status: "approved", decidedBy: lead.email });
  });

  it("a blocked publish can be sent to the gate's approvers with a reason; reject needs a reason", async () => {
    const context = await createTestContext();
    const requester = await login(context, "builder", "requester");
    const lead = await login(context, "builder", "lead");
    const version = save(context, hookWorkflow("wf-blocked", "x"));
    await enableGate(context, requester.cookie, "wf-blocked", { approvers: { approverUsers: [lead.email] } });
    const blocked = await call(context, "POST", "/api/workflows/wf-blocked/publish", requester.cookie, { version });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ verdict: "blocked", canRequestApproval: true });
    const asked = await call(context, "POST", "/api/workflows/wf-blocked/publish", requester.cookie, { version, requestApproval: { reason: "The failing case is a known flake" } });
    expect(asked.statusCode, asked.body).toBe(202);
    const id = asked.json<{ approvalRequestId: string }>().approvalRequestId;
    const item = (await call(context, "GET", "/api/approvals", lead.cookie)).json<{ items: Array<ReleaseApprovalRequestView> }>().items.find((entry) => entry.id === id)!;
    expect(item).toMatchObject({ origin: "blocked", requestReason: "The failing case is a known flake", approverUsers: [lead.email], canDecide: true });
    expect(item.gateReasons.join()).toMatch(/No completed replay job/);
    expect((await call(context, "POST", `/api/approvals/${id}/reject`, lead.cookie, {})).statusCode).toBe(400);
    const rejected = await call(context, "POST", `/api/approvals/${id}/reject`, lead.cookie, { reason: "Fix the case first" });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(rejected.json<{ request: ReleaseApprovalRequestView; release: null }>()).toMatchObject({ request: { status: "rejected", reason: "Fix the case first" }, release: null });
    expect(context.store.getPublishedVersion("wf-blocked")).toBeNull();
  });

  it("refuses an approver from another project and a stale request", async () => {
    const context = await createTestContext();
    const requester = await login(context, "builder", "requester");
    const lead = await login(context, "builder", "lead");
    const outsider = await login(context, "builder", "outsider");
    const reader = await login(context, "builder", "reader");
    context.store.upsertProject({ id: "p-team", name: "Team" });
    context.store.upsertCustomRole({ id: "none-team", projectId: "p-team", name: "No access", permissions: [] });
    context.store.upsertCustomRole({ id: "read-team", projectId: "p-team", name: "Read only", permissions: ["workflow:read"] });
    context.store.upsertProjectRole({ userId: outsider.id, projectId: "p-team", role: "custom", customRoleId: "none-team" });
    context.store.upsertProjectRole({ userId: reader.id, projectId: "p-team", role: "custom", customRoleId: "read-team" });
    const version = save(context, hookWorkflow("wf-team", "x", "p-team"));
    await enableGate(context, requester.cookie, "wf-team", { requireApproval: true, approvers: { approverRoles: ["builder"] } });
    const hash = await versionHash(context, requester.cookie, "wf-team", version);
    seedJob(context, { workflowId: "wf-team", datasetIds: ["set-wf-team"], version, hash, statuses: ["pass", "pass", "pass"] });
    const id = (await call(context, "POST", "/api/workflows/wf-team/publish", requester.cookie, { version })).json<{ approvalRequestId: string }>().approvalRequestId;
    // The outsider cannot see it; the reader sees it but may not publish.
    expect((await call(context, "POST", `/api/approvals/${id}/approve`, outsider.cookie, {})).statusCode).toBe(404);
    expect((await call(context, "GET", "/api/approvals", outsider.cookie)).json<{ items: unknown[] }>().items).toEqual([]);
    expect((await call(context, "POST", `/api/approvals/${id}/approve`, reader.cookie, {})).statusCode).toBe(403);

    // The gate changes after the request: approving would publish under settings nobody asked about.
    await enableGate(context, requester.cookie, "wf-team", { requireApproval: true, approvers: { approverRoles: ["builder"] }, policy: { minCases: 2 } });
    const stale = await call(context, "POST", `/api/approvals/${id}/approve`, lead.cookie, {});
    expect(stale.statusCode).toBe(409);
    expect(stale.json<{ error: string }>().error).toMatch(/stale.*settings changed/);
    expect(context.store.getReleaseApprovalRequest(id)!.status).toBe("canceled");
    expect(context.store.getPublishedVersion("wf-team")).toBeNull();

    // Another version published meanwhile also makes a request stale.
    const id2 = (await call(context, "POST", "/api/workflows/wf-team/publish", requester.cookie, { version })).json<{ approvalRequestId: string }>().approvalRequestId;
    expect(id2).not.toBe(id);
    const admin = await login(context, "admin");
    const v2 = save(context, hookWorkflow("wf-team", "y", "p-team"));
    expect((await call(context, "POST", "/api/workflows/wf-team/publish", admin.cookie, { version: v2, override: { reason: "urgent" } })).statusCode).toBe(200);
    const stale2 = await call(context, "POST", `/api/approvals/${id2}/approve`, lead.cookie, {});
    expect(stale2.statusCode).toBe(409);
    expect(stale2.json<{ error: string }>().error).toMatch(/Another version was published/);
  });
});

describe("production entry points run the published version", () => {
  it("schedules register from and run the published version", async () => {
    const context = await createTestContext({ scheduler: true });
    const builder = await login(context, "builder");
    const scheduled = (answer: string, cron: string): Workflow => ({
      id: "wf-cron",
      name: "Cron",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "default",
      nodes: [node("tick", "schedule_trigger", { cronExpression: cron, timezone: "UTC", active: true }), node("out", "output", { responseTemplate: answer })],
      edges: [{ id: "e1", source: "tick", target: "out" }]
    }) as Workflow;
    const v1 = save(context, scheduled("published", "0 3 * * *"));
    expect((await call(context, "POST", "/api/workflows/wf-cron/publish", builder.cookie, { version: v1 })).statusCode).toBe(200);
    save(context, scheduled("draft", "0 4 * * *"));
    context.scheduler!.reloadWorkflow("wf-cron");
    const jobs = (context.scheduler as unknown as { jobs: Map<string, unknown> }).jobs;
    expect([...jobs.keys()].length).toBe(1);
    const handler = (context.scheduler as unknown as { executeHandler: (input: Record<string, string>) => Promise<void> }).executeHandler;
    await handler({ workflowId: "wf-cron", workflowName: "Cron", scheduleNodeId: "tick", cronExpression: "0 3 * * *", timezone: "UTC", firedAt: new Date().toISOString() });
    const run = context.store.listExecutionHistory({ workflowId: "wf-cron", page: 1, pageSize: 5 }).items[0]!;
    expect(run.triggerType).toBe("cron");
    expect(JSON.stringify(context.store.getExecutionHistory(run.id)!.output)).toContain("published");
  });

  it("chat runs the published version; a sub-workflow called from production runs the child's published version", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const chat = (answer: string): Workflow => ({
      id: "wf-chat",
      name: "Chat",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "default",
      nodes: [node("chat", "chat_trigger", {}), node("out", "output", { responseTemplate: answer })],
      edges: [{ id: "e1", source: "chat", target: "out" }]
    }) as Workflow;
    const c1 = save(context, chat("chat-published"));
    expect((await call(context, "POST", "/api/workflows/wf-chat/publish", builder.cookie, { version: c1 })).statusCode).toBe(200);
    save(context, chat("chat-draft"));
    const chatted = await context.app.inject({ method: "POST", url: "/api/chat/wf-chat", payload: { message: "hi" } });
    expect(chatted.statusCode, chatted.body).toBe(200);
    expect(JSON.stringify(chatted.json().output)).toContain("chat-published");

    const child = (answer: string): Workflow => ({
      id: "wf-child",
      name: "Child",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "default",
      nodes: [node("start", "manual_trigger"), node("out", "output", { responseTemplate: answer })],
      edges: [{ id: "c1", source: "start", target: "out" }]
    }) as Workflow;
    const k1 = save(context, child("child-published"));
    expect((await call(context, "POST", "/api/workflows/wf-child/publish", builder.cookie, { version: k1 })).statusCode).toBe(200);
    save(context, child("child-draft"));
    // The parent itself has no published version: production runs its draft, but calls the child's published version.
    save(context, {
      id: "wf-parent",
      name: "Parent",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "default",
      nodes: [node("hook", "webhook_input", { path: "hook-parent", method: "POST" }), node("call", "execute_workflow", { workflowId: "wf-child" }), node("out", "output", { responseTemplate: "parent got {{result}}" })],
      edges: [{ id: "p1", source: "hook", target: "call" }, { id: "p2", source: "call", target: "out" }]
    } as Workflow);
    expect(JSON.stringify((await prodHook(context, "hook-parent")).output)).toContain("child-published");
    expect(JSON.stringify((await testHook(context, "hook-parent")).output)).toContain("child-draft");
    const manual = await call(context, "POST", "/api/workflows/wf-parent/execute", builder.cookie, {});
    expect(JSON.stringify(manual.json().output)).toContain("child-draft");
  });

  it("a production webhook routes by the published version's path, and a paused run resumes on the version it started with", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const lead = await login(context, "builder", "lead");
    const v1 = save(context, hookWorkflow("wf-path", "old", "default", "old-path"));
    expect((await call(context, "POST", "/api/workflows/wf-path/publish", builder.cookie, { version: v1 })).statusCode).toBe(200);
    save(context, hookWorkflow("wf-path", "new", "default", "new-path"));
    expect(await prodHook(context, "old-path")).toMatchObject({ status: 200, output: { result: "old" } });
    expect((await prodHook(context, "new-path")).status).toBe(404);
    expect(await testHook(context, "new-path")).toMatchObject({ output: { result: "new" } });

    const gated = (answer: string): Workflow => ({
      id: "wf-pause",
      name: "Pause",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "default",
      nodes: [
        node("hook", "webhook_input", { path: "hook-pause", method: "POST" }),
        node("gate", "approval_gate", { message: "Go?", approverUsers: [lead.email] }),
        node("out", "output", { responseTemplate: answer })
      ],
      edges: [{ id: "e1", source: "hook", target: "gate" }, { id: "e2", source: "gate", sourceHandle: "approved", target: "out" }]
    }) as Workflow;
    const p1 = save(context, gated("started-version"));
    expect((await call(context, "POST", "/api/workflows/wf-pause/publish", builder.cookie, { version: p1 })).statusCode).toBe(200);
    const paused = await context.app.inject({ method: "POST", url: "/webhook/hook-pause", payload: {} });
    expect(paused.json<{ output: Record<string, unknown> }>().output).toMatchObject({ waitingForApproval: true });
    const executionId = context.store.listExecutionHistory({ workflowId: "wf-pause", page: 1, pageSize: 1 }).items[0]!.id;
    expect(context.store.getWorkflowExecutionState(executionId)!.state).toMatchObject({ releaseChannel: "production" });
    const p2 = save(context, gated("later-version"));
    expect((await call(context, "POST", "/api/workflows/wf-pause/publish", builder.cookie, { version: p2 })).statusCode).toBe(200);
    const resumed = await call(context, "POST", `/api/approvals/${executionId}/approve`, lead.cookie, {});
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(JSON.stringify(resumed.json().output)).toContain("started-version");
  });
});

describe("retention", () => {
  it("never prunes a pinned (published or released) version", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    for (let index = 1; index <= 3; index += 1) save(context, hookWorkflow("wf-keep", `v${index}`));
    expect((await call(context, "POST", "/api/workflows/wf-keep/publish", builder.cookie, { version: 1 })).statusCode).toBe(200);
    const versions = new WorkflowVersionService(context.store, 2);
    for (let index = 4; index <= 6; index += 1) versions.snapshot({ workflow: context.store.upsertWorkflow(hookWorkflow("wf-keep", `v${index}`)) });
    expect(context.store.listWorkflowVersions("wf-keep").map((entry) => entry.version)).toEqual([6, 5, 1]);
    expect(context.store.isWorkflowVersionPinned("wf-keep", 1)).toBe(true);
    expect(await prodHook(context, "hook-wf-keep")).toMatchObject({ output: { result: "v1" } });
  });
});

describe("project authorization on the release routes", () => {
  const routes = (workflowId: string): Array<["GET" | "POST" | "PUT", string, unknown?, "read" | "write"]> => [
    ["GET", `/api/workflows/${workflowId}/release-gate`, undefined, "read"],
    ["GET", `/api/workflows/${workflowId}/releases`, undefined, "read"],
    ["GET", `/api/workflows/${workflowId}/release-state`, undefined, "read"],
    ["GET", `/api/workflows/${workflowId}/publish-preview?version=1`, undefined, "read"],
    ["PUT", `/api/workflows/${workflowId}/release-gate`, { enabled: false }, "write"],
    ["POST", `/api/workflows/${workflowId}/publish`, { version: 1 }, "write"],
    ["POST", `/api/workflows/${workflowId}/rollback`, { version: 1, reason: "x" }, "write"]
  ];

  it("answers 404 for an unreadable workflow and 403 for a readable one the user may not change", async () => {
    const context = await createTestContext();
    const outsider = await login(context, "builder", "outsider");
    const reader = await login(context, "builder", "reader");
    context.store.upsertProject({ id: "p-sec", name: "Secret" });
    context.store.upsertCustomRole({ id: "none-sec", projectId: "p-sec", name: "None", permissions: [] });
    context.store.upsertCustomRole({ id: "read-sec", projectId: "p-sec", name: "Read", permissions: ["workflow:read", "workflow:execute"] });
    context.store.upsertProjectRole({ userId: outsider.id, projectId: "p-sec", role: "custom", customRoleId: "none-sec" });
    context.store.upsertProjectRole({ userId: reader.id, projectId: "p-sec", role: "custom", customRoleId: "read-sec" });
    save(context, hookWorkflow("wf-sec", "x", "p-sec"));
    for (const [method, url, payload, kind] of routes("wf-sec")) {
      expect((await call(context, method, url, outsider.cookie, payload)).statusCode, `${method} ${url}`).toBe(404);
      const response = await call(context, method, url, reader.cookie, payload);
      expect(response.statusCode, `${method} ${url} ${response.body}`).toBe(kind === "read" ? 200 : 403);
    }
    // workflow:publish is its own permission: a custom role with write but without publish may configure the gate but not publish.
    context.store.upsertCustomRole({ id: "read-sec", projectId: "p-sec", name: "Write", permissions: ["workflow:read", "workflow:write", "workflow:execute"] });
    expect((await call(context, "PUT", "/api/workflows/wf-sec/release-gate", reader.cookie, { enabled: false })).statusCode).toBe(200);
    expect((await call(context, "POST", "/api/workflows/wf-sec/publish", reader.cookie, { version: 1 })).statusCode).toBe(403);
    context.store.upsertCustomRole({ id: "read-sec", projectId: "p-sec", name: "Publish", permissions: ["workflow:read", "workflow:publish"] });
    expect((await call(context, "POST", "/api/workflows/wf-sec/publish", reader.cookie, { version: 1 })).statusCode).toBe(200);
    // A missing workflow is 404 too.
    expect((await call(context, "GET", "/api/workflows/nope/release-gate", reader.cookie)).statusCode).toBe(404);
  });

  it("strict isolation: a builder without a membership sees nothing", async () => {
    const context = await createTestContext({ overrides: { PROJECT_ISOLATION: "strict" } });
    const builder = await login(context, "builder");
    const member = await login(context, "builder", "member");
    context.store.upsertProjectRole({ userId: member.id, projectId: "default", role: "editor" });
    save(context, hookWorkflow("wf-strict", "x"));
    for (const [method, url, payload] of routes("wf-strict")) {
      expect((await call(context, method, url, builder.cookie, payload)).statusCode, `${method} ${url}`).toBe(404);
    }
    expect((await call(context, "POST", "/api/workflows/wf-strict/publish", member.cookie, { version: 1 })).statusCode).toBe(200);
    const runs = await call(context, "GET", "/api/replay/runs?workflowId=wf-strict", builder.cookie);
    expect(runs.statusCode).toBe(404);
    expect((await call(context, "GET", "/api/approvals", builder.cookie)).json<{ items: EvalRunView[] }>().items).toEqual([]);
  });
});

describe("the MCP gateway", () => {
  it("lists and runs a workflow tool from the published version", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const tool = (answer: string, description: string): Workflow => ({
      id: "wf-tool",
      name: "Tool",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "default",
      nodes: [
        node("trigger", "mcp_server_trigger", { path: "wf-tool-path", toolName: "release_tool", toolDescription: description, inputSchema: { type: "object", properties: {} }, authMode: "public" }),
        node("out", "output", { outputKey: "result", responseTemplate: answer })
      ],
      edges: [{ id: "e1", source: "trigger", target: "out" }]
    }) as Workflow;
    const v1 = save(context, tool("tool-published", "Published description"));
    expect((await call(context, "POST", "/api/workflows/wf-tool/publish", admin.cookie, { version: v1 })).statusCode).toBe(200);
    save(context, tool("tool-draft", "Draft description"));
    const toolset = await call(context, "POST", "/api/mcp/toolsets", admin.cookie, { name: "Release tools", projectId: "default", members: [{ kind: "workflow", workflowId: "wf-tool" }] });
    expect(toolset.statusCode, toolset.body).toBe(201);
    const slug = toolset.json<{ toolset: { id: string; slug: string } }>().toolset;
    const client = await call(context, "POST", "/api/mcp/clients", admin.cookie, { name: "IDE", toolsetIds: [slug.id], role: "builder" });
    expect(client.statusCode, client.body).toBe(201);
    const token = client.json<{ token: string }>().token;
    const rpc = (body: unknown, headers: Record<string, string> = {}) =>
      context.app.inject({
        method: "POST",
        url: `/mcp/${slug.slug}`,
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, ...headers },
        payload: JSON.stringify(body)
      });
    const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw", version: "1" } } });
    expect(init.statusCode, init.body).toBe(200);
    const session = { "mcp-session-id": init.headers["mcp-session-id"] as string };
    const listed = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, session);
    const tools = listed.json<{ result: { tools: Array<{ name: string; description: string }> } }>().result.tools;
    expect(tools.find((entry) => entry.name === "release_tool")?.description).toContain("Published description");
    const called = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "release_tool", arguments: {} } }, session);
    const text = JSON.stringify(called.json());
    expect(text).toContain("tool-published");
    expect(text).not.toContain("tool-draft");
  });
});
