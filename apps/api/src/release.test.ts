/**
 * Phase 15.4 — release gate and publish over the API: production traffic
 * runs the published version while the editor and /webhook-test/ run the
 * draft; publishing binds to the exact hash of a saved version and a
 * passing replay job judged under the current policy; admin overrides,
 * enforced gates, release requests in the approvals inbox, rollback,
 * retention pinning, project scoping and migration 33.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { goldenSetSnapshots } from "./services/release-snapshot.js";
import { productionRoutingKeys, withUniqueTriggerPaths } from "./services/release-service.js";
import { WorkflowVersionService } from "./services/workflow-version-service.js";

const SAMPLES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../samples");

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

/** A case's replay as the 15.2 runner stores it: a run diff with no cost or latency change and no guard verdicts. */
const plainDiff = { verdict: "same", reasons: [], diff: { totals: { costUsd: { baseline: 0.01, candidate: 0.01 }, latencyMs: { baseline: 100, candidate: 100 } }, guard: { added: [], changed: [] } } };

/**
 * A finished replay job as the 15.2 runner stores it, without running
 * anything: one case per status, on cases of the first set (created when the
 * set has fewer), with a run diff and the snapshot of its sets as they are now.
 */
function seedJob(
  context: TestContext,
  input: {
    workflowId: string;
    datasetIds: string[];
    version: number;
    hash: string;
    statuses: Array<"pass" | "fail" | "error">;
    status?: string;
    options?: Record<string, unknown>;
    scorers?: Array<Record<string, unknown>>;
    diff?: unknown;
  }
): string {
  const id = `run_${crypto.randomUUID()}`;
  const setId = input.datasetIds[0]!;
  const fixtures = context.store.listEvalFixtures(setId);
  for (let index = fixtures.length; index < input.statuses.length; index += 1) {
    context.store.createEvalFixture({ id: `fx_${index}_${setId}`, datasetId: setId, name: `Case ${index + 1}`, input: {} });
  }
  const caseIds = context.store.listEvalFixtures(setId).map((fixture) => fixture.id);
  context.store.createEvalRun({
    id,
    datasetId: setId,
    workflowId: input.workflowId,
    kind: "replay",
    status: "running",
    datasetIds: input.datasetIds,
    candidate: { kind: "version", version: input.version, workflowHash: input.hash },
    workflowHash: input.hash,
    workflowVersion: input.version,
    options: { mcpMode: "strict", maxCostUsd: 5, ...(input.options ?? {}) },
    ...(input.scorers ? { scorers: input.scorers } : {})
  });
  context.store.setEvalRunSetSnapshot(id, goldenSetSnapshots(input.datasetIds, (datasetId) => context.store.listEvalFixtures(datasetId)));
  input.statuses.forEach((status, index) => {
    context.store.recordEvalResult({
      id: `res_${index}_${id}`,
      runId: id,
      fixtureId: caseIds[index]!,
      status,
      score: { pass: status === "pass", details: [{ type: "status", pass: status === "pass", reason: status }] },
      diff: input.diff === undefined ? plainDiff : input.diff
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
    expect(state).toEqual({ draftVersion: v3, publishedVersion: v3, aheadBy: 0, gateEnabled: true, gateEnforced: false, productionRefused: false, canPublish: true, canEditGate: true });
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

  it("a job counts as proof only with no settings beyond the gate's own candidate options", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const version = save(context, hookWorkflow("wf-ovr", "x"));
    await enableGate(context, builder.cookie, "wf-ovr");
    const hash = await versionHash(context, builder.cookie, "wf-ovr", version);
    const job = (extra: { options?: Record<string, unknown>; candidate?: Record<string, unknown> } = {}) => {
      const id = seedJob(context, { workflowId: "wf-ovr", datasetIds: ["set-wf-ovr"], version, hash, statuses: ["pass", "pass", "pass"], ...(extra.options ? { options: extra.options } : {}) });
      if (extra.candidate) {
        const db = (context.store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db;
        db.prepare("UPDATE eval_runs SET candidate_json = ? WHERE id = ?").run(JSON.stringify({ kind: "version", version, workflowHash: hash, ...extra.candidate }), id);
      }
      return id;
    };
    const verdictOf = async (runId: string) => {
      const response = await call(context, "GET", `/api/workflows/wf-ovr/publish-preview?version=${version}&replayRunId=${runId}`, builder.cookie);
      expect(response.statusCode, response.body).toBe(200);
      return response.json<{ preview: { verdict: string; reasons: string[] } }>().preview;
    };
    // Overrides that keep the version's hash: a weaker guard profile, live reads, a model swap, looser comparison, or a field this release does not know.
    for (const [extra, pattern] of [
      [{ options: { overrides: { guardProfiles: { g1: "permissive" } } } }, /overrides \(guardProfiles\)/],
      [{ candidate: { overrides: { mcpServers: { srv: "live_read_only" } } } }, /candidate overrides \(mcpServers\)/],
      [{ options: { models: "replay" } }, /models replay/],
      [{ options: { ignorePaths: ["$.answer"] } }, /ignorePaths/],
      [{ options: { numberTolerance: 0.5 } }, /numberTolerance/],
      [{ options: { repeats: 3, aggregate: "any" } }, /repeats 3, aggregate any/],
      [{ options: { somethingNew: true } }, /somethingNew/]
    ] as Array<[{ options?: Record<string, unknown>; candidate?: Record<string, unknown> }, RegExp]>) {
      const preview = await verdictOf(job(extra));
      expect(preview.verdict, JSON.stringify(extra)).toBe("blocked");
      expect(preview.reasons.join("\n"), JSON.stringify(extra)).toMatch(pattern);
    }
    // A plain job (no override fields, empty ones, models live, the budget) is proof.
    expect((await verdictOf(job({ options: { overrides: {}, models: "live", maxCostUsd: 2 } }))).verdict).toBe("passed");
    // Options the gate itself names count when they match it.
    await enableGate(context, builder.cookie, "wf-ovr", { candidateOptions: { mcpMode: "strict", compare: "baseline_rerun", repeats: 3, aggregate: "majority" } });
    expect((await verdictOf(job({ options: { compare: "baseline_rerun", repeats: 3, aggregate: "majority" } }))).verdict).toBe("passed");
    expect((await verdictOf(job({ options: { compare: "recording", repeats: 3, aggregate: "majority" } }))).reasons.join()).toMatch(/compare recording/);
    // Publishing without naming a job skips disqualified ones and finds no proof among them.
    const fresh = save(context, hookWorkflow("wf-ovr", "y"));
    const freshHash = await versionHash(context, builder.cookie, "wf-ovr", fresh);
    seedJob(context, { workflowId: "wf-ovr", datasetIds: ["set-wf-ovr"], version: fresh, hash: freshHash, statuses: ["pass", "pass", "pass"], options: { compare: "baseline_rerun", repeats: 3, aggregate: "majority", overrides: { guardProfiles: { g1: "off" } } } });
    const refused = await call(context, "POST", "/api/workflows/wf-ovr/publish", builder.cookie, { version: fresh });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ reasons: string[] }>().reasons.join()).toMatch(/guardProfiles/);
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
    save(context, hookWorkflow("wf-approve", "before"));
    // Turning the gate on publishes the saved version as the baseline.
    await enableGate(context, requester.cookie, "wf-approve", { requireApproval: true, approvers: { approverRoles: ["builder"] } });
    expect(context.store.getPublishedVersion("wf-approve")).toBe(1);
    const version = save(context, hookWorkflow("wf-approve", "approved"));
    const hash = await versionHash(context, requester.cookie, "wf-approve", version);
    const runId = seedJob(context, { workflowId: "wf-approve", datasetIds: ["set-wf-approve"], version, hash, statuses: ["pass", "pass", "pass"] });
    const asked = await call(context, "POST", "/api/workflows/wf-approve/publish", requester.cookie, { version });
    expect(asked.statusCode, asked.body).toBe(202);
    const { approvalRequestId } = asked.json<{ verdict: string; approvalRequestId: string }>();
    expect(asked.json()).toMatchObject({ verdict: "needs_approval" });
    // Asking again returns the same pending request.
    expect((await call(context, "POST", "/api/workflows/wf-approve/publish", requester.cookie, { version })).json()).toMatchObject({ approvalRequestId });
    expect(context.store.getPublishedVersion("wf-approve")).toBe(1);

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
    save(context, hookWorkflow("wf-blocked", "before"));
    await enableGate(context, requester.cookie, "wf-blocked", { approvers: { approverUsers: [lead.email] } });
    const version = save(context, hookWorkflow("wf-blocked", "x"));
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
    expect(context.store.getPublishedVersion("wf-blocked")).toBe(1);
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
    save(context, hookWorkflow("wf-team", "before", "p-team"));
    await enableGate(context, requester.cookie, "wf-team", { requireApproval: true, approvers: { approverRoles: ["builder"] } });
    const version = save(context, hookWorkflow("wf-team", "x", "p-team"));
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
    expect(context.store.getPublishedVersion("wf-team")).toBe(1);

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
  const routes = (workflowId: string): Array<["GET" | "POST" | "PUT", string, unknown, "read" | "write"]> => [
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

// ---------------------------------------------------------------------------
// Review fixes (H1-H3, M1-M8, L1-L7, contract addendum)
// ---------------------------------------------------------------------------

const rawDb = (context: TestContext) => (context.store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Saves the draft and snapshots it as `actor`'s version, as the save route does. */
function saveAs(context: TestContext, workflow: Workflow, actorId: string): number {
  const saved = context.store.upsertWorkflow(workflow, { createdBy: actorId });
  return new WorkflowVersionService(context.store).snapshot({ workflow: saved, createdBy: actorId, changeNote: "test" }).version;
}

describe("enforced gates: only admins weaken them", () => {
  it("a builder cannot add themselves as approver or allow self-approval (H1); the version's author cannot approve its release (L7)", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const author = await login(context, "builder", "author");
    const lead = await login(context, "builder", "lead");
    save(context, hookWorkflow("wf-h1", "v1"));
    await enableGate(context, admin.cookie, "wf-h1", { enforced: true });
    const put = (body: Record<string, unknown>) => call(context, "PUT", "/api/workflows/wf-h1/release-gate", builder.cookie, { enabled: true, datasetIds: ["set-wf-h1"], ...body });
    // The exact sequence from the review: self as approver with self-approval on an enforced gate without approvers.
    const selfAdd = await put({ approvers: { approverUsers: [builder.email], allowSelfApproval: true } });
    expect(selfAdd.statusCode, selfAdd.body).toBe(403);
    expect(selfAdd.json<{ error: string }>().error).toMatch(/self-approval/);
    expect((await put({ approvers: { approverUsers: [builder.email] } })).statusCode).toBe(403);
    expect((await put({ approvers: {} })).statusCode).toBe(403);
    // Self-approval is the admin's call on an unenforced gate too.
    save(context, hookWorkflow("wf-l7", "v1"));
    await enableGate(context, builder.cookie, "wf-l7", { approvers: { approverRoles: ["builder"] } });
    expect((await call(context, "PUT", "/api/workflows/wf-l7/release-gate", builder.cookie, { enabled: true, datasetIds: ["set-wf-l7"], approvers: { approverRoles: ["builder"], allowSelfApproval: true } })).statusCode).toBe(403);
    expect(auditTypes(context)).toContain("release.gate.update_refused");

    // The author saves a version; a colleague asks to publish it; the author may not approve it, another builder may.
    const version = saveAs(context, hookWorkflow("wf-l7", "authored"), author.id);
    const asked = await call(context, "POST", "/api/workflows/wf-l7/publish", builder.cookie, { version, requestApproval: { reason: "please" } });
    expect(asked.statusCode, asked.body).toBe(202);
    const id = asked.json<{ approvalRequestId: string }>().approvalRequestId;
    const byAuthor = await call(context, "POST", `/api/approvals/${id}/approve`, author.cookie, {});
    expect(byAuthor.statusCode).toBe(403);
    expect(byAuthor.json<{ error: string }>().error).toMatch(/You saved this version/);
    const view = (await call(context, "GET", "/api/approvals", author.cookie)).json<{ items: ReleaseApprovalRequestView[] }>().items.find((entry) => entry.id === id)!;
    expect(view).toMatchObject({ canDecide: false });
    expect((await call(context, "POST", `/api/approvals/${id}/approve`, lead.cookie, {})).statusCode).toBe(200);
  });

  it("any change to the candidate options is admin-only on an enforced gate (M2)", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    save(context, hookWorkflow("wf-m2", "v1"));
    await enableGate(context, admin.cookie, "wf-m2", { enforced: true });
    for (const candidateOptions of [{ repeats: 5, aggregate: "any" }, { compare: "recording", mcpMode: "lenient" }, { scorers: [{ type: "status" }] }, { maxCostUsd: 50 }]) {
      const response = await call(context, "PUT", "/api/workflows/wf-m2/release-gate", builder.cookie, { enabled: true, datasetIds: ["set-wf-m2"], candidateOptions });
      expect(response.statusCode, JSON.stringify(candidateOptions)).toBe(403);
      expect(response.json<{ error: string }>().error).toMatch(/only admins/);
    }
    // Naming the default (strict) changes nothing, and an admin may change anything.
    expect((await call(context, "PUT", "/api/workflows/wf-m2/release-gate", builder.cookie, { enabled: true, datasetIds: ["set-wf-m2"], candidateOptions: { mcpMode: "strict" } })).statusCode).toBe(200);
    expect((await call(context, "PUT", "/api/workflows/wf-m2/release-gate", admin.cookie, { enabled: true, datasetIds: ["set-wf-m2"], candidateOptions: { repeats: 3, aggregate: "majority" } })).statusCode).toBe(200);
  });

  it("rollback on an enforced gate is the admin's, with a reason; elsewhere it needs workflow:publish and a reason (M5)", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const v1 = save(context, hookWorkflow("wf-m5", "one"));
    await enableGate(context, admin.cookie, "wf-m5", { enforced: true });
    const v2 = save(context, hookWorkflow("wf-m5", "two"));
    expect((await call(context, "POST", "/api/workflows/wf-m5/publish", admin.cookie, { version: v2, override: { reason: "test" } })).statusCode).toBe(200);
    expect((await call(context, "POST", "/api/workflows/wf-m5/rollback", builder.cookie, { version: v1, reason: "back" })).statusCode).toBe(403);
    expect((await call(context, "POST", "/api/workflows/wf-m5/rollback", admin.cookie, { version: v1 })).statusCode).toBe(400);
    const rolled = await call(context, "POST", "/api/workflows/wf-m5/rollback", admin.cookie, { version: v1, reason: "Incident 7" });
    expect(rolled.statusCode, rolled.body).toBe(200);
    expect(rolled.json<{ release: WorkflowRelease }>().release).toMatchObject({ verdict: "rollback", reason: "Incident 7" });
    expect(auditTypes(context)).toEqual(expect.arrayContaining(["release.rollback.refused", "release.rolled_back"]));
  });

  it("removing cases from, deleting, or adding scored cases to an enforced gate's golden set is admin-only; adding a plain case is fine and makes older jobs stale (M4)", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    save(context, hookWorkflow("wf-m4", "v1"));
    await enableGate(context, admin.cookie, "wf-m4", { enforced: true });
    const v2 = save(context, hookWorkflow("wf-m4", "v2"));
    const hash = await versionHash(context, builder.cookie, "wf-m4", v2);
    const job = seedJob(context, { workflowId: "wf-m4", datasetIds: ["set-wf-m4"], version: v2, hash, statuses: ["pass", "pass", "pass"] });
    const preview = async () => (await call(context, "GET", `/api/workflows/wf-m4/publish-preview?version=${v2}&replayRunId=${job}`, builder.cookie)).json<{ preview: { verdict: string; reasons: string[] } }>().preview;
    expect((await preview()).verdict).toBe("passed");
    const [first] = context.store.listEvalFixtures("set-wf-m4");
    expect((await call(context, "DELETE", `/api/eval/fixtures/${first!.id}`, builder.cookie)).statusCode).toBe(403);
    expect((await call(context, "DELETE", "/api/eval/datasets/set-wf-m4", builder.cookie)).statusCode).toBe(403);
    expect((await call(context, "POST", "/api/eval/datasets/set-wf-m4/fixtures", builder.cookie, { name: "Always passes", input: {}, scorers: [{ type: "status" }] })).statusCode).toBe(403);
    expect(context.store.listEvalFixtures("set-wf-m4")).toHaveLength(3);
    expect(auditTypes(context)).toContain("release.golden_set_change.refused");
    // Adding a plain case is allowed, and the job no longer proves anything.
    expect((await call(context, "POST", "/api/eval/datasets/set-wf-m4/fixtures", builder.cookie, { name: "New case", input: {} })).statusCode).toBe(200);
    const stale = await preview();
    expect(stale.verdict).toBe("blocked");
    expect(stale.reasons.join()).toMatch(/set-wf-m4 changed after replay job/);
    // An admin may remove a case.
    expect((await call(context, "DELETE", `/api/eval/fixtures/${first!.id}`, admin.cookie)).statusCode).toBe(200);
  });
});

describe("what counts as passing is the gate's call", () => {
  it("a job with its own always-pass scorers is no proof unless the gate names exactly those scorers (H2)", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    save(context, hookWorkflow("wf-h2", "v1"));
    await enableGate(context, builder.cookie, "wf-h2");
    const v2 = save(context, hookWorkflow("wf-h2", "v2"));
    const hash = await versionHash(context, builder.cookie, "wf-h2", v2);
    const alwaysPass = [{ type: "regex", pattern: ".*" }];
    seedJob(context, { workflowId: "wf-h2", datasetIds: ["set-wf-h2"], version: v2, hash, statuses: ["pass", "pass", "pass"], scorers: alwaysPass });
    const refused = await call(context, "POST", "/api/workflows/wf-h2/publish", builder.cookie, { version: v2 });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ reasons: string[] }>().reasons.join()).toMatch(/ran with its own scorers \(regex\)/);
    // A gate that names its scorers refuses a job with the defaults, and accepts one with exactly its own.
    await enableGate(context, builder.cookie, "wf-h2", { candidateOptions: { scorers: [{ type: "status" }] } });
    const defaults = seedJob(context, { workflowId: "wf-h2", datasetIds: ["set-wf-h2"], version: v2, hash, statuses: ["pass", "pass", "pass"] });
    expect((await call(context, "POST", "/api/workflows/wf-h2/publish", builder.cookie, { version: v2, replayRunId: defaults })).json<{ reasons: string[] }>().reasons.join()).toMatch(/default scorers/);
    const own = seedJob(context, { workflowId: "wf-h2", datasetIds: ["set-wf-h2"], version: v2, hash, statuses: ["pass", "pass", "pass"], scorers: [{ type: "status" }] });
    expect((await call(context, "POST", "/api/workflows/wf-h2/publish", builder.cookie, { version: v2, replayRunId: own })).statusCode).toBe(200);
  });

  it("requires releaseEligible when a job carries it (contract addendum)", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    save(context, hookWorkflow("wf-elig", "v1"));
    await enableGate(context, builder.cookie, "wf-elig");
    const v2 = save(context, hookWorkflow("wf-elig", "v2"));
    const hash = await versionHash(context, builder.cookie, "wf-elig", v2);
    const job = seedJob(context, { workflowId: "wf-elig", datasetIds: ["set-wf-elig"], version: v2, hash, statuses: ["pass", "pass", "pass"] });
    rawDb(context).prepare("UPDATE eval_runs SET candidate_json = ? WHERE id = ?").run(JSON.stringify({ kind: "version", version: v2, workflowHash: hash, releaseEligible: false, releaseIneligibleReasons: ["a guard profile override"] }), job);
    const refused = await call(context, "POST", "/api/workflows/wf-elig/publish", builder.cookie, { version: v2, replayRunId: job });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ reasons: string[] }>().reasons.join()).toMatch(/not eligible to prove a release \(a guard profile override\)/);
    rawDb(context).prepare("UPDATE eval_runs SET candidate_json = ? WHERE id = ?").run(JSON.stringify({ kind: "version", version: v2, workflowHash: hash, releaseEligible: true, releaseIneligibleReasons: [] }), job);
    expect((await call(context, "POST", "/api/workflows/wf-elig/publish", builder.cookie, { version: v2, replayRunId: job })).statusCode).toBe(200);
  });

  it("accepts a baseline_rerun job with a golden run older than 30 days, and refuses a recording comparison of it (M3)", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    context.store.upsertWorkflow(hookWorkflow("wf-m3", "v1"));
    // A real golden run, recorded from a run of the draft, then aged to 40 days.
    const run = await call(context, "POST", "/api/workflows/wf-m3/execute", builder.cookie, {});
    const recording = await call(context, "POST", "/api/replay/recordings", builder.cookie, { executionId: run.json<{ executionId: string }>().executionId, name: "Old golden run" });
    expect(recording.statusCode, recording.body).toBe(201);
    const recordingId = recording.json<{ recording: { id: string } }>().recording.id;
    rawDb(context).prepare("UPDATE replay_recordings SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 40 * 86_400_000).toISOString(), recordingId);
    save(context, hookWorkflow("wf-m3", "v1"));
    await enableGate(context, builder.cookie, "wf-m3", { policy: { minCases: 1 } });
    const v2 = save(context, hookWorkflow("wf-m3", "v2"));
    const hash = await versionHash(context, builder.cookie, "wf-m3", v2);
    const aged = (compare?: string) => {
      const id = seedJob(context, { workflowId: "wf-m3", datasetIds: ["set-wf-m3"], version: v2, hash, statuses: ["pass"], ...(compare ? { options: { compare } } : {}) });
      rawDb(context).prepare("UPDATE eval_results SET recording_id = ? WHERE run_id = ?").run(recordingId, id);
      return id;
    };
    const recordingJob = aged();
    const old = await call(context, "POST", "/api/workflows/wf-m3/publish", builder.cookie, { version: v2, replayRunId: recordingJob });
    expect(old.statusCode).toBe(409);
    expect(old.json<{ reasons: string[] }>().reasons.join()).toMatch(/40 days old.*baseline_rerun/);
    // The gate does not name compare; a baseline rerun is stricter and passes.
    const rerun = await call(context, "POST", "/api/workflows/wf-m3/publish", builder.cookie, { version: v2, replayRunId: aged("baseline_rerun") });
    expect(rerun.statusCode, rerun.body).toBe(200);
  });

  it("judges only the gate's own sets, every job for the hash, and counts a case without a diff as an error (L4, L5, L6)", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    save(context, hookWorkflow("wf-low", "v1"));
    await enableGate(context, builder.cookie, "wf-low");
    const extra = goldenSet(context, "wf-low", "set-wf-low-extra");
    const v2 = save(context, hookWorkflow("wf-low", "v2"));
    const hash = await versionHash(context, builder.cookie, "wf-low", v2);
    // L6: failing cases of a set the gate does not use do not count.
    const pooled = seedJob(context, { workflowId: "wf-low", datasetIds: ["set-wf-low", extra], version: v2, hash, statuses: ["pass", "pass", "pass"] });
    for (let index = 0; index < 3; index += 1) {
      context.store.createEvalFixture({ id: `fx_extra_${index}`, datasetId: extra, name: `Extra ${index}`, input: {} });
      context.store.recordEvalResult({ id: `res_extra_${index}`, runId: pooled, fixtureId: `fx_extra_${index}`, status: "fail", score: { pass: false, details: [] }, diff: plainDiff });
    }
    const pooledPreview = (await call(context, "GET", `/api/workflows/wf-low/publish-preview?version=${v2}&replayRunId=${pooled}`, builder.cookie)).json<{ preview: { verdict: string; stats: { cases: number } } }>().preview;
    expect(pooledPreview).toMatchObject({ verdict: "passed", stats: { cases: 3 } });
    // L5: a case whose diff is missing is an error under the default guard limit.
    const blind = seedJob(context, { workflowId: "wf-low", datasetIds: ["set-wf-low"], version: v2, hash, statuses: ["pass", "pass", "pass"], diff: null });
    const blindPreview = (await call(context, "GET", `/api/workflows/wf-low/publish-preview?version=${v2}&replayRunId=${blind}`, builder.cookie)).json<{ preview: { verdict: string; stats: { error: number } } }>().preview;
    expect(blindPreview).toMatchObject({ verdict: "blocked", stats: { error: 3 } });
    // L4: an older passing job is found behind more than 20 newer failing ones.
    await sleep(5);
    for (let index = 0; index < 22; index += 1) seedJob(context, { workflowId: "wf-low", datasetIds: ["set-wf-low"], version: v2, hash, statuses: ["fail", "fail", "fail"] });
    const published = await call(context, "POST", "/api/workflows/wf-low/publish", builder.cookie, { version: v2 });
    expect(published.statusCode, published.body).toBe(200);
    expect(published.json<{ release: WorkflowRelease }>().release.replayRunId).toBe(pooled);
  });
});

describe("gates outlive their workflow; turning one on publishes a baseline", () => {
  it("delete needs an admin on an enforced gate; a workflow created again under the id inherits the gate and fails closed (H3)", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const original = hookWorkflow("wf-h3", "reviewed");
    save(context, original);
    await enableGate(context, admin.cookie, "wf-h3", { enforced: true });
    expect(await prodHook(context, "hook-wf-h3")).toMatchObject({ status: 200, output: { result: "reviewed" } });
    const refused = await call(context, "DELETE", "/api/workflows/wf-h3", builder.cookie);
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ error: string }>().error).toMatch(/enforced release gate/);
    expect(auditTypes(context)).toContain("release.workflow_delete.refused");
    expect((await call(context, "DELETE", "/api/workflows/wf-h3", admin.cookie)).statusCode).toBe(200);
    expect(context.store.getReleaseGate("wf-h3")).toMatchObject({ enabled: true, enforced: true });
    expect(context.store.listWorkflowReleases("wf-h3").length).toBeGreaterThan(0);

    // Re-import the same id with an edited output: the gate is still there, and production refuses runs.
    const edited = hookWorkflow("wf-h3", "unreviewed");
    const imported = await call(context, "POST", "/api/workflows/import", builder.cookie, { workflow: edited });
    expect(imported.statusCode, imported.body).toBe(200);
    expect((await call(context, "GET", "/api/workflows/wf-h3/release-gate", builder.cookie)).json<{ gate: ReleaseGateView }>().gate).toMatchObject({ enabled: true, enforced: true });
    expect((await prodHook(context, "hook-wf-h3")).status).toBe(404);
    expect(await testHook(context, "hook-wf-h3")).toMatchObject({ output: { result: "unreviewed" } });
    expect((await call(context, "GET", "/api/workflows/wf-h3/release-state", builder.cookie)).json<{ state: { productionRefused: boolean } }>().state.productionRefused).toBe(true);
    // The builder cannot turn the gate off, and saving a version does not publish it.
    expect((await call(context, "PUT", "/api/workflows/wf-h3/release-gate", builder.cookie, { enabled: false })).statusCode).toBe(403);
    const saved = await call(context, "PUT", "/api/workflows/wf-h3", builder.cookie, edited);
    expect(saved.statusCode, saved.body).toBe(200);
    const version = context.store.maxWorkflowVersionNumber("wf-h3");
    expect((await call(context, "POST", "/api/workflows/wf-h3/publish", builder.cookie, { version })).statusCode).toBe(409);
    // The old release of this version number had another hash: no rollback to it.
    const back = await call(context, "POST", "/api/workflows/wf-h3/rollback", admin.cookie, { version: 1, reason: "restore" });
    expect(back.statusCode).toBe(409);
    expect((await prodHook(context, "hook-wf-h3")).status).toBe(404);
    // An admin override with a reason is one way back to production.
    expect((await call(context, "POST", "/api/workflows/wf-h3/publish", admin.cookie, { version, override: { reason: "Reviewed by hand" } })).statusCode).toBe(200);
    expect(await prodHook(context, "hook-wf-h3")).toMatchObject({ status: 200, output: { result: "unreviewed" } });
  });

  it("turning a gate on publishes the version production already runs as the baseline, and never breaks production", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    save(context, hookWorkflow("wf-base", "one"));
    const v2 = save(context, hookWorkflow("wf-base", "two"));
    expect(context.store.getPublishedVersion("wf-base")).toBeNull();
    await enableGate(context, builder.cookie, "wf-base");
    expect(context.store.getPublishedVersion("wf-base")).toBe(v2);
    const [baseline] = (await call(context, "GET", "/api/workflows/wf-base/releases", builder.cookie)).json<{ releases: WorkflowRelease[] }>().releases;
    expect(baseline).toMatchObject({ version: v2, verdict: "ungated", publishedBy: builder.email });
    expect(baseline!.reason).toMatch(/Baseline/);
    expect(await prodHook(context, "hook-wf-base")).toMatchObject({ output: { result: "two" } });
    const audit = context.store.listAuditLogs({ eventType: "release.published", pageSize: 5 }).items[0]!;
    expect(JSON.stringify(audit.metadata)).toContain('"baseline":true');

    // A draft saved without a version (an import) is snapshotted first, so the baseline is what production ran.
    context.store.upsertWorkflow(hookWorkflow("wf-unsaved", "draft-only"));
    await enableGate(context, builder.cookie, "wf-unsaved");
    expect(context.store.getPublishedVersion("wf-unsaved")).toBe(1);
    expect(await prodHook(context, "hook-wf-unsaved")).toMatchObject({ output: { result: "draft-only" } });

    // A gate turned on over a published version keeps it; turning it off and on again does not publish the draft.
    const v1 = save(context, hookWorkflow("wf-kept", "published"));
    expect((await call(context, "POST", "/api/workflows/wf-kept/publish", builder.cookie, { version: v1 })).statusCode).toBe(200);
    save(context, hookWorkflow("wf-kept", "newer draft"));
    await enableGate(context, builder.cookie, "wf-kept");
    expect(context.store.getPublishedVersion("wf-kept")).toBe(v1);
  });
});

describe("production paths belong to what serves production (M1, N1, N2)", () => {
  it("a copy's taken trigger paths get -copy, -copy-2, ...; free ones and other nodes stay", () => {
    const source = {
      nodes: [
        node("hook", "webhook_input", { path: "Orders", method: "POST" }),
        node("bare", "webhook_input", {}),
        node("form", "form_trigger", { path: "feedback" }),
        node("tool", "mcp_server_trigger", { path: "helper" }),
        node("free", "form_trigger", { path: "unused" }),
        node("slack", "slack_trigger", { path: "slack-events" })
      ]
    };
    const used = new Set(["webhook:orders", "webhook:orders-copy", "webhook:bare", "form:feedback", "mcp:helper"]);
    const copy = withUniqueTriggerPaths(source, used);
    expect(copy.nodes.map((entry) => (entry.config as { path?: string }).path)).toEqual(["Orders-copy-2", "bare-copy", "feedback-copy", "helper-copy", "unused", "slack-events"]);
    expect(productionRoutingKeys(copy).every((entry) => !used.has(entry.key))).toBe(true);
    expect((source.nodes[0]!.config as { path: string }).path).toBe("Orders");
  });

  it("refuses a save, import or external import onto a path a published workflow serves; a duplicate gets its own paths instead", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const v1 = save(context, hookWorkflow("wf-owner", "owner", "default", "lead-enrich"));
    expect((await call(context, "POST", "/api/workflows/wf-owner/publish", builder.cookie, { version: v1 })).statusCode).toBe(200);
    const thief = hookWorkflow("wf-thief", "thief", "default", "Lead-Enrich");
    const created = await call(context, "POST", "/api/workflows", builder.cookie, thief);
    expect(created.statusCode).toBe(409);
    expect(created.json<{ error: string }>().error).toMatch(/Webhook path "lead-enrich" is already used by workflow "Release wf-owner" \(wf-owner\)/);
    expect((await call(context, "POST", "/api/workflows/import", builder.cookie, { workflow: thief })).statusCode).toBe(409);
    // An export from another builder that answers on the same path (N1).
    const external = JSON.parse(fs.readFileSync(path.join(SAMPLES_DIR, "external-imports", "webhook-http-set.json"), "utf8")) as Record<string, unknown>;
    const externalImport = await call(context, "POST", "/api/workflows/import/external", builder.cookie, { source: external });
    expect(externalImport.statusCode, externalImport.body).toBe(409);
    expect(externalImport.json<{ error: string }>().error).toMatch(/lead-enrich.*wf-owner/);
    expect(context.store.listWorkflows().map((summary) => summary.id)).toEqual(["wf-owner"]);
    expect(await prodHook(context, "lead-enrich")).toMatchObject({ output: { result: "owner" } });
    // Saving the owner itself is fine.
    expect((await call(context, "PUT", "/api/workflows/wf-owner", builder.cookie, hookWorkflow("wf-owner", "owner 2", "default", "lead-enrich"))).statusCode).toBe(200);

    // Duplicating a published triggered workflow never answers 409: the copy's paths are rewritten.
    const copy = await call(context, "POST", "/api/workflows/wf-owner/duplicate", builder.cookie, { name: "Copy" });
    expect(copy.statusCode, copy.body).toBe(200);
    expect(copy.json<Workflow>().nodes.find((entry) => entry.id === "hook")!.config).toMatchObject({ path: "lead-enrich-copy" });
    const second = await call(context, "POST", "/api/workflows/wf-owner/duplicate", builder.cookie, { name: "Copy 2" });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json<Workflow>().nodes.find((entry) => entry.id === "hook")!.config).toMatchObject({ path: "lead-enrich-copy-2" });
    expect(await prodHook(context, "lead-enrich")).toMatchObject({ output: { result: "owner" } });
    expect(await prodHook(context, "lead-enrich-copy")).toMatchObject({ output: { result: "owner 2" } });
    // A template made from it: using it gives the new workflow paths nobody uses either.
    const template = (await call(context, "POST", "/api/templates", builder.cookie, { name: "Owner template", workflowId: "wf-owner" })).json<{ id: string }>();
    const used = await call(context, "POST", `/api/templates/${template.id}/use`, builder.cookie);
    expect(used.statusCode, used.body).toBe(200);
    const fromTemplate = context.store.getWorkflow(used.json<{ workflowId: string }>().workflowId)!;
    expect(fromTemplate.nodes.find((entry) => entry.id === "hook")!.config).toMatchObject({ path: "lead-enrich-copy-3" });
  });

  it("a gated draft claims nothing: it saves onto a claimed path, never blocks the claimant, and cannot be published there (the cross-project probe)", async () => {
    const context = await createTestContext();
    const lead = await login(context, "builder", "lead");
    const other = await login(context, "builder", "other");
    context.store.upsertProject({ id: "p-a", name: "A" });
    context.store.upsertProject({ id: "p-b", name: "B" });
    context.store.upsertProjectRole({ userId: lead.id, projectId: "p-a", role: "editor" });
    context.store.upsertProjectRole({ userId: other.id, projectId: "p-b", role: "editor" });
    context.store.upsertCustomRole({ id: "none-b", projectId: "p-b", name: "None", permissions: [] });
    context.store.upsertProjectRole({ userId: lead.id, projectId: "p-b", role: "custom", customRoleId: "none-b" });
    save(context, hookWorkflow("wf-a", "a", "p-a", "path-a"));
    await enableGate(context, lead.cookie, "wf-a");
    save(context, hookWorkflow("wf-b", "b", "p-b", "path-b"));

    // A's draft moves onto B's path: it serves nothing until published, so the save is fine.
    const moved = await call(context, "PUT", "/api/workflows/wf-a", lead.cookie, hookWorkflow("wf-a", "a moved", "p-a", "path-b"));
    expect(moved.statusCode, moved.body).toBe(200);
    // B, in another project, still saves (a rename), and still serves its path.
    const renamed = await call(context, "PUT", "/api/workflows/wf-b", other.cookie, { ...hookWorkflow("wf-b", "b", "p-b", "path-b"), name: "B renamed" });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(await prodHook(context, "path-b")).toMatchObject({ output: { result: "b" } });
    expect(await prodHook(context, "path-a")).toMatchObject({ output: { result: "a" } });
    // A cannot publish onto B's path; the owner it cannot read stays unnamed.
    const version = context.store.maxWorkflowVersionNumber("wf-a");
    const blocked = await call(context, "POST", "/api/workflows/wf-a/publish", lead.cookie, { version });
    expect(blocked.statusCode).toBe(409);
    const reasons = blocked.json<{ reasons: string[] }>().reasons.join(" ");
    expect(reasons).toMatch(/Webhook path "path-b" is already used by another workflow\./);
    expect(reasons).not.toContain("wf-b");
    expect(context.store.getPublishedVersion("wf-a")).toBe(1);
  });

  it("every ungated workflow claims its saved paths, active or not; publishing or gating a collision is refused", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    // Two ungated workflows that already share a path (from before this release): each still saves, neither may be published or gated.
    context.store.upsertWorkflow(hookWorkflow("wf-x", "x", "default", "old-shared"));
    context.store.upsertWorkflow(hookWorkflow("wf-y", "y", "default", "old-shared"));
    expect((await call(context, "PUT", "/api/workflows/wf-x", builder.cookie, { ...hookWorkflow("wf-x", "x", "default", "old-shared"), name: "X renamed" })).statusCode).toBe(200);
    const vx = context.store.maxWorkflowVersionNumber("wf-x");
    const blocked = await call(context, "POST", "/api/workflows/wf-x/publish", builder.cookie, { version: vx });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<{ reasons: string[] }>().reasons.join()).toMatch(/old-shared.*wf-y/);
    const enable = await call(context, "PUT", "/api/workflows/wf-x/release-gate", builder.cookie, { enabled: true, datasetIds: [goldenSetId(context, "wf-x")] });
    expect(enable.statusCode).toBe(409);
    expect(context.store.getReleaseGate("wf-x")).toBeNull();

    // A new ungated workflow cannot take another ungated workflow's path, even a deactivated one's:
    // deactivating an ungated workflow leaves its webhook serving production.
    save(context, hookWorkflow("wf-live", "live", "default", "live-path"));
    expect((await call(context, "POST", "/api/workflows", builder.cookie, hookWorkflow("wf-new", "new", "default", "live-path"))).statusCode).toBe(409);
    expect((await call(context, "POST", "/api/workflows/wf-live/deactivate", builder.cookie, {})).statusCode).toBe(200);
    expect(await prodHook(context, "live-path")).toMatchObject({ status: 200, output: { result: "live" } });
    const taken = await call(context, "POST", "/api/workflows", builder.cookie, hookWorkflow("wf-new", "new", "default", "live-path"));
    expect(taken.statusCode).toBe(409);
    expect(taken.json<{ error: string }>().error).toMatch(/live-path.*wf-live/);
    expect(context.store.getWorkflow("wf-new")).toBeFalsy();
    // The deactivated owner itself still saves, and activates again.
    expect((await call(context, "PUT", "/api/workflows/wf-live", builder.cookie, { ...context.store.getWorkflow("wf-live")!, name: "Live renamed" })).statusCode).toBe(200);
    expect((await call(context, "POST", "/api/workflows/wf-live/activate", builder.cookie, {})).statusCode).toBe(200);
  });

  it("git pull refuses only the workflow that would take a served path, with its reason; the rest import (N1)", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const v1 = save(context, hookWorkflow("wf-served", "served", "default", "served-path"));
    expect((await call(context, "POST", "/api/workflows/wf-served/publish", admin.cookie, { version: v1 })).statusCode).toBe(200);
    // A repository with one workflow on the served path and one on its own path.
    const bare = path.join(context.tempDir, "remote.git");
    const work = path.join(context.tempDir, "seed");
    const git = (cwd: string, ...args: string[]) => {
      const result = spawnSync("git", ["-c", "user.email=seed@example.com", "-c", "user.name=Seed", ...args], { cwd, encoding: "utf8" });
      if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    };
    fs.mkdirSync(work, { recursive: true });
    git(context.tempDir, "init", "--bare", "-b", "main", bare);
    git(work, "init", "-b", "main");
    fs.mkdirSync(path.join(work, "workflows"));
    fs.writeFileSync(path.join(work, "workflows", "wf-taker.json"), JSON.stringify(hookWorkflow("wf-taker", "taker", "default", "served-path")));
    fs.writeFileSync(path.join(work, "workflows", "wf-fine.json"), JSON.stringify(hookWorkflow("wf-fine", "fine", "default", "fine-path")));
    git(work, "add", ".");
    git(work, "commit", "-m", "seed");
    git(work, "push", bare, "main");
    expect((await call(context, "PUT", "/api/git", admin.cookie, { repoUrl: bare, defaultBranch: "main" })).statusCode).toBe(200);

    const pulled = await call(context, "POST", "/api/git/pull", admin.cookie, { branch: "main" });
    expect(pulled.statusCode, pulled.body).toBe(200);
    const result = pulled.json<{ ok: boolean; workflowsImported: number; workflowsRefused: Array<{ workflowId: string; file: string; reason: string }> }>();
    expect(result).toMatchObject({ ok: true, workflowsImported: 1 });
    expect(result.workflowsRefused).toEqual([{ workflowId: "wf-taker", file: "wf-taker.json", reason: expect.stringMatching(/served-path.*wf-served/) }]);
    expect(context.store.getWorkflow("wf-taker")).toBeNull();
    expect(context.store.getWorkflow("wf-fine")).not.toBeNull();
    expect(await prodHook(context, "served-path")).toMatchObject({ output: { result: "served" } });
  });

  it("a duplicate, a template copy and a re-created id never inherit a deleted workflow's gate (N6)", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    save(context, hookWorkflow("wf-gone", "gone"));
    await enableGate(context, admin.cookie, "wf-gone");
    save(context, hookWorkflow("wf-src", "src"));
    expect((await call(context, "DELETE", "/api/workflows/wf-gone", admin.cookie)).statusCode).toBe(200);
    // A duplicate asking for the deleted gated id lands on a fresh one.
    const copy = await call(context, "POST", "/api/workflows/wf-src/duplicate", admin.cookie, { name: "Copy", id: "wf-gone" });
    expect(copy.statusCode, copy.body).toBe(200);
    expect(copy.json<Workflow>().id).toBe("wf-gone-2");
    expect(context.store.getReleaseGate("wf-gone-2")).toBeNull();
  });
});

describe("API-key callers and retries (M7)", () => {
  it("an API-key caller of /execute runs the published version; the editor runs the draft; a retry runs what the failed run ran", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const v1 = save(context, hookWorkflow("wf-m7", "published"));
    expect((await call(context, "POST", "/api/workflows/wf-m7/publish", builder.cookie, { version: v1 })).statusCode).toBe(200);
    save(context, hookWorkflow("wf-m7", "draft"));
    const key = (await call(context, "POST", "/api/auth/api-keys", builder.cookie, { name: "CI" })).json<{ key: string }>().key;
    const viaKey = await context.app.inject({ method: "POST", url: "/api/workflows/wf-m7/execute", headers: { authorization: `Bearer ${key}` }, payload: {} });
    expect(viaKey.statusCode, viaKey.body).toBe(200);
    expect(viaKey.json<{ output: unknown }>().output).toMatchObject({ result: "published" });
    const streamed = await context.app.inject({ method: "POST", url: "/api/workflows/wf-m7/execute/stream", headers: { authorization: `Bearer ${key}` }, payload: {} });
    expect(streamed.body).toContain("published");
    expect(streamed.body).not.toContain('"result":"draft"');
    expect((await call(context, "POST", "/api/workflows/wf-m7/execute", builder.cookie, {})).json<{ output: unknown }>().output).toMatchObject({ result: "draft" });

    // A production run records its version; retrying it (once it failed) runs that version again.
    const production = viaKey.json<{ executionId: string }>().executionId;
    expect(context.store.getExecutionRelease(production)).toEqual({ channel: "production", version: v1 });
    rawDb(context).prepare("UPDATE execution_history SET status = 'error' WHERE id = ?").run(production);
    const retried = await call(context, "POST", `/api/executions/${production}/retry`, builder.cookie, {});
    expect(retried.statusCode, retried.body).toBe(200);
    expect(JSON.stringify(retried.json())).toContain("published");
    expect(JSON.stringify(retried.json())).not.toContain('"result":"draft"');
  });
});

describe("release requests: expiry and duplicates (L1, L2)", () => {
  it("an expired request is closed and listed as decided; a second requester gets their own request and stale ones are closed", async () => {
    const context = await createTestContext();
    const first = await login(context, "builder", "first");
    const second = await login(context, "builder", "second");
    const lead = await login(context, "admin", "lead");
    save(context, hookWorkflow("wf-req", "v1"));
    await enableGate(context, first.cookie, "wf-req", { approvers: { approverRoles: ["admin"] } });
    const version = save(context, hookWorkflow("wf-req", "v2"));
    const ask = async (who: { cookie: string }, reason: string) =>
      (await call(context, "POST", "/api/workflows/wf-req/publish", who.cookie, { version, requestApproval: { reason } })).json<{ approvalRequestId: string }>().approvalRequestId;
    const a = await ask(first, "first reason");
    const b = await ask(second, "second reason");
    expect(b).not.toBe(a);
    expect(await ask(first, "again")).toBe(a);
    const pending = (await call(context, "GET", "/api/approvals?status=pending", lead.cookie)).json<{ items: ReleaseApprovalRequestView[] }>().items;
    expect(pending.filter((entry) => entry.kind === "release").map((entry) => entry.requestReason).sort()).toEqual(["first reason", "second reason"]);

    rawDb(context).prepare("UPDATE release_approval_requests SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), a);
    const afterExpiry = (await call(context, "GET", "/api/approvals?status=pending", lead.cookie)).json<{ items: ReleaseApprovalRequestView[] }>().items;
    expect(afterExpiry.map((entry) => entry.id)).toEqual([b]);
    const decided = (await call(context, "GET", "/api/approvals?status=decided", lead.cookie)).json<{ items: ReleaseApprovalRequestView[] }>().items;
    expect(decided.find((entry) => entry.id === a)).toMatchObject({ status: "timed_out" });
    expect(context.store.getReleaseApprovalRequest(a)!.status).toBe("timed_out");
    expect(auditTypes(context)).toContain("release.approval.timed_out");

    // The gate changes: asking again closes the stale request and makes a new one.
    await enableGate(context, first.cookie, "wf-req", { approvers: { approverRoles: ["admin"] }, policy: { minCases: 4 } });
    const c = await ask(second, "after the change");
    expect(c).not.toBe(b);
    expect(context.store.getReleaseApprovalRequest(b)!.status).toBe("canceled");
  });
});

describe("a real replay job proves a release (M8)", () => {
  /** start → label → output: deterministic, no external calls. */
  const labelled = (answer: string, label = "Label"): Workflow =>
    ({
      id: "wf-real",
      name: "Real gate",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "default",
      nodes: [
        { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
        { id: "label", type: "set_node", name: label, position: { x: 150, y: 0 }, config: { assignments: [{ key: "answer", valueTemplate: answer }] } },
        { id: "output", type: "output", name: "Output", position: { x: 300, y: 0 }, config: { responseTemplate: "answer {{results.label.answer}}" } }
      ],
      edges: [
        { id: "e1", source: "start", target: "label" },
        { id: "e2", source: "label", target: "output" }
      ]
    }) as Workflow;

  async function goldenRun(context: TestContext, cookie: string, name: string): Promise<string> {
    const run = await call(context, "POST", "/api/workflows/wf-real/execute", cookie, {});
    expect(run.statusCode, run.body).toBe(200);
    const saved = await call(context, "POST", "/api/replay/recordings", cookie, { executionId: run.json<{ executionId: string }>().executionId, name });
    expect(saved.statusCode, saved.body).toBe(201);
    return saved.json<{ recording: { id: string } }>().recording.id;
  }

  async function runJob(context: TestContext, cookie: string, body: Record<string, unknown>): Promise<EvalRunView & { results: Array<{ status: string }> }> {
    const started = await call(context, "POST", "/api/replay/runs", cookie, body);
    expect(started.statusCode, started.body).toBe(202);
    const id = started.json<{ run: EvalRunView }>().run.id;
    const until = Date.now() + 30_000;
    for (;;) {
      const run = (await call(context, "GET", `/api/replay/runs/${id}`, cookie)).json<{ run: EvalRunView & { results: Array<{ status: string }> } }>().run;
      if (!["queued", "running"].includes(run.status)) return run;
      if (Date.now() > until) throw new Error(`Job ${id} still ${run.status}`);
      await sleep(50);
    }
  }

  it("a real 15.3 job with an override or a comparison setting the gate does not name is refused by publish; the same job without them is accepted", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    context.store.upsertWorkflow(labelled("forty-two"));
    const recordings = [await goldenRun(context, builder.cookie, "Golden A"), await goldenRun(context, builder.cookie, "Golden B"), await goldenRun(context, builder.cookie, "Golden C")];
    const created = await call(context, "POST", "/api/eval/datasets", builder.cookie, { name: "Override suite", workflowId: "wf-real" });
    const setId = created.json<{ dataset: { id: string } }>().dataset.id;
    for (const recordingId of recordings) expect((await call(context, "POST", `/api/eval/datasets/${setId}/recordings`, builder.cookie, { recordingId })).statusCode).toBe(201);
    expect((await call(context, "PUT", "/api/workflows/wf-real/release-gate", builder.cookie, { enabled: true, datasetIds: [setId] })).statusCode).toBe(200);
    const version = save(context, labelled("forty-two", "Renamed"));

    // A guard profile override (pinned to the version it resolved to): the server marks the job ineligible, and the gate
    // refuses it although every case passed.
    const overridden = await runJob(context, builder.cookie, { datasetIds: [setId], version, overrides: { guardProfile: { profileId: "default" } } });
    expect(overridden.status).toBe("completed");
    expect(overridden.results.every((result) => result.status === "pass")).toBe(true);
    expect(overridden.candidate).toMatchObject({ releaseEligible: false, guardProfile: { profileId: "default", version: expect.any(Number) } });
    const refused = await call(context, "POST", "/api/workflows/wf-real/publish", builder.cookie, { version, replayRunId: overridden.id });
    expect(refused.statusCode, refused.body).toBe(409);
    const reasons = refused.json<{ reasons: string[] }>().reasons.join(" ");
    expect(reasons).toMatch(/not eligible to prove a release/);
    expect(reasons).toMatch(/A guard profile override replaced the workflow's guard bindings/);
    expect(reasons).toMatch(/candidate overrides \(guardProfile\)/);

    // An eligible job (no override) that loosens the comparison: still refused, by the gate's own check.
    const loosened = await runJob(context, builder.cookie, { datasetIds: [setId], version, ignorePaths: ["answer"] });
    expect(loosened.candidate).toMatchObject({ releaseEligible: true });
    const looseRefused = await call(context, "POST", "/api/workflows/wf-real/publish", builder.cookie, { version, replayRunId: loosened.id });
    expect(looseRefused.statusCode).toBe(409);
    expect(looseRefused.json<{ reasons: string[] }>().reasons.join(" ")).toMatch(/settings the gate does not specify \(ignorePaths\)/);
    expect(context.store.getPublishedVersion("wf-real")).toBe(1);

    // The plain job is eligible and publishes.
    const plain = await runJob(context, builder.cookie, { datasetIds: [setId], version });
    expect(plain.candidate).toMatchObject({ releaseEligible: true, releaseIneligibleReasons: [] });
    const published = await call(context, "POST", "/api/workflows/wf-real/publish", builder.cookie, { version, replayRunId: plain.id });
    expect(published.statusCode, published.body).toBe(200);
    expect(published.json<{ release: WorkflowRelease }>().release).toMatchObject({ version, verdict: "passed", replayRunId: plain.id });
  });

  it("runs a job through the replay-job API, waits for it and publishes with it; a failing job, one with an extra scorer and a stale one are refused", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    context.store.upsertWorkflow(labelled("forty-two"));
    const recordings = [await goldenRun(context, builder.cookie, "Golden 1"), await goldenRun(context, builder.cookie, "Golden 2"), await goldenRun(context, builder.cookie, "Golden 3")];
    const created = await call(context, "POST", "/api/eval/datasets", builder.cookie, { name: "Release suite", workflowId: "wf-real" });
    const setId = created.json<{ dataset: { id: string } }>().dataset.id;
    for (const recordingId of recordings) expect((await call(context, "POST", `/api/eval/datasets/${setId}/recordings`, builder.cookie, { recordingId })).statusCode).toBe(201);
    const enabled = await call(context, "PUT", "/api/workflows/wf-real/release-gate", builder.cookie, { enabled: true, datasetIds: [setId] });
    expect(enabled.statusCode, enabled.body).toBe(200);
    const baseline = context.store.getPublishedVersion("wf-real");
    expect(baseline).toBe(1);

    // A refactor that keeps the answer: a real job passes and proves it.
    const good = save(context, labelled("forty-two", "Answer"));
    const passing = await runJob(context, builder.cookie, { datasetIds: [setId], version: good });
    expect(passing.status).toBe("completed");
    expect(passing.results.map((result) => result.status)).toEqual(["pass", "pass", "pass"]);
    const published = await call(context, "POST", "/api/workflows/wf-real/publish", builder.cookie, { version: good, replayRunId: passing.id });
    expect(published.statusCode, published.body).toBe(200);
    expect(published.json<{ release: WorkflowRelease }>().release).toMatchObject({ version: good, verdict: "passed", replayRunId: passing.id });

    // A regression: the real job fails, and the publish is blocked with its regressions.
    const bad = save(context, labelled("forty-three", "Answer"));
    const failing = await runJob(context, builder.cookie, { datasetIds: [setId], version: bad });
    expect(failing.results.every((result) => result.status === "fail")).toBe(true);
    const blocked = await call(context, "POST", "/api/workflows/wf-real/publish", builder.cookie, { version: bad });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<{ reasons: string[] }>().reasons.join()).toMatch(/3 regressions/);

    // The same regression with an extra scorer the gate does not name passes its cases, and is still no proof.
    const lenient = await runJob(context, builder.cookie, { datasetIds: [setId], version: bad, scorers: [{ type: "status" }] });
    expect(lenient.results.every((result) => result.status === "pass")).toBe(true);
    const scorerRefused = await call(context, "POST", "/api/workflows/wf-real/publish", builder.cookie, { version: bad, replayRunId: lenient.id });
    expect(scorerRefused.statusCode).toBe(409);
    expect(scorerRefused.json<{ reasons: string[] }>().reasons.join()).toMatch(/its own scorers \(status\)/);

    // A passing job whose set gained a golden run since it was queued is stale.
    const fresh = save(context, labelled("forty-two", "Answer again"));
    const before = await runJob(context, builder.cookie, { datasetIds: [setId], version: fresh });
    expect(before.status).toBe("completed");
    const extra = await goldenRun(context, builder.cookie, "Golden 4");
    expect((await call(context, "POST", `/api/eval/datasets/${setId}/recordings`, builder.cookie, { recordingId: extra })).statusCode).toBe(201);
    const stale = await call(context, "POST", "/api/workflows/wf-real/publish", builder.cookie, { version: fresh, replayRunId: before.id });
    expect(stale.statusCode).toBe(409);
    expect(stale.json<{ reasons: string[] }>().reasons.join()).toMatch(/changed after replay job/);
    expect(context.store.getPublishedVersion("wf-real")).toBe(good);
  });
});

describe("deactivation (L9, N3)", () => {
  it("without a gate, deactivating only unregisters schedules and triggers: production webhooks and API-key runs keep working, as before releases", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const v1 = save(context, hookWorkflow("wf-plain", "live"));
    expect((await call(context, "POST", "/api/workflows/wf-plain/publish", builder.cookie, { version: v1 })).statusCode).toBe(200);
    save(context, hookWorkflow("wf-draft-only", "draft"));
    expect((await call(context, "POST", "/api/workflows/wf-plain/deactivate", builder.cookie, {})).statusCode).toBe(200);
    expect((await call(context, "POST", "/api/workflows/wf-draft-only/deactivate", builder.cookie, {})).statusCode).toBe(200);
    expect(await prodHook(context, "hook-wf-plain")).toMatchObject({ status: 200, output: { result: "live" } });
    expect(await prodHook(context, "hook-wf-draft-only")).toMatchObject({ status: 200, output: { result: "draft" } });
    const key = (await call(context, "POST", "/api/auth/api-keys", builder.cookie, { name: "CI" })).json<{ key: string }>().key;
    const viaKey = await context.app.inject({ method: "POST", url: "/api/workflows/wf-draft-only/execute", headers: { authorization: `Bearer ${key}` }, payload: {} });
    expect(viaKey.statusCode, viaKey.body).toBe(200);
    expect(viaKey.json<{ output: unknown }>().output).toMatchObject({ result: "draft" });
  });

  it("on a gated workflow deactivating is the kill switch: every production route says it is deactivated, a production parent fails with it, the test route still runs", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    save(context, hookWorkflow("wf-kill", "live"));
    await enableGate(context, builder.cookie, "wf-kill");
    save(context, {
      id: "wf-caller",
      name: "Caller",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "default",
      nodes: [node("hook", "webhook_input", { path: "hook-caller", method: "POST" }), node("call", "execute_workflow", { workflowId: "wf-kill" }), node("out", "output", { responseTemplate: "caller got {{result}}" })],
      edges: [{ id: "p1", source: "hook", target: "call" }, { id: "p2", source: "call", target: "out" }]
    } as Workflow);
    expect(await prodHook(context, "hook-wf-kill")).toMatchObject({ status: 200, output: { result: "live" } });
    expect((await call(context, "POST", "/api/workflows/wf-kill/deactivate", builder.cookie, {})).statusCode).toBe(200);

    const hook = await context.app.inject({ method: "POST", url: "/webhook/hook-wf-kill", payload: {} });
    expect(hook.statusCode).toBe(409);
    expect(hook.json<{ error: string }>().error).toBe("This workflow is deactivated, so production runs are refused. Activate it to serve production again.");
    expect(hook.body).not.toMatch(/release gate/i);
    const key = (await call(context, "POST", "/api/auth/api-keys", builder.cookie, { name: "CI" })).json<{ key: string }>().key;
    const viaKey = await context.app.inject({ method: "POST", url: "/api/workflows/wf-kill/execute", headers: { authorization: `Bearer ${key}` }, payload: {} });
    expect(viaKey.statusCode).toBe(409);
    expect(viaKey.json<{ error: string }>().error).toMatch(/^This workflow is deactivated/);
    expect(viaKey.body).not.toMatch(/release gate/i);
    const compat = await call(context, "POST", "/api/webhooks/execute", builder.cookie, { workflow_id: "wf-kill", input: {} });
    expect(compat.statusCode).toBe(409);
    expect(compat.json<{ error: string }>().error).toMatch(/^This workflow is deactivated/);
    // A production parent fails with the child's reason; the editor's run of the parent calls the child's draft.
    const parent = await context.app.inject({ method: "POST", url: "/webhook/hook-caller", payload: {} });
    expect(parent.body).toMatch(/Sub-workflow 'wf-kill': This workflow is deactivated/);
    expect(JSON.stringify((await call(context, "POST", "/api/workflows/wf-caller/execute", builder.cookie, {})).json().output)).toContain("live");
    // The draft's test route still runs; activating restores production.
    expect(await testHook(context, "hook-wf-kill")).toMatchObject({ output: { result: "live" } });
    expect((await call(context, "POST", "/api/workflows/wf-kill/activate", builder.cookie, {})).statusCode).toBe(200);
    expect(await prodHook(context, "hook-wf-kill")).toMatchObject({ status: 200, output: { result: "live" } });
  });
});

describe("API keys and retries (N4, N5)", () => {
  it("an API key runs the draft with channel=draft when it may change the workflow; a production retry runs what production runs now", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const v1 = save(context, hookWorkflow("wf-n4", "one"));
    expect((await call(context, "POST", "/api/workflows/wf-n4/publish", builder.cookie, { version: v1 })).statusCode).toBe(200);
    save(context, hookWorkflow("wf-n4", "draft"));
    const key = (await call(context, "POST", "/api/auth/api-keys", builder.cookie, { name: "CI" })).json<{ key: string }>().key;
    const run = (query: string) => context.app.inject({ method: "POST", url: `/api/workflows/wf-n4/execute${query}`, headers: { authorization: `Bearer ${key}` }, payload: {} });
    expect((await run("")).json<{ output: unknown }>().output).toMatchObject({ result: "one" });
    expect((await run("?channel=draft")).json<{ output: unknown }>().output).toMatchObject({ result: "draft" });
    expect((await run("?channel=other")).statusCode).toBe(400);
    // A key whose owner may execute but not change the workflow cannot ask for the draft.
    const runner = await login(context, "builder", "runner");
    context.store.upsertCustomRole({ id: "run-only", projectId: "default", name: "Run", permissions: ["workflow:read", "workflow:execute"] });
    context.store.upsertProjectRole({ userId: runner.id, projectId: "default", role: "custom", customRoleId: "run-only" });
    const runnerKey = (await call(context, "POST", "/api/auth/api-keys", runner.cookie, { name: "Runner" })).json<{ key: string }>().key;
    const refused = await context.app.inject({ method: "POST", url: "/api/workflows/wf-n4/execute?channel=draft", headers: { authorization: `Bearer ${runnerKey}` }, payload: {} });
    expect(refused.statusCode, refused.body).toBe(403);

    // A production run of version 1, retried after version 3 is published, runs version 3.
    const failed = (await run("")).json<{ executionId: string }>().executionId;
    rawDb(context).prepare("UPDATE execution_history SET status = 'error' WHERE id = ?").run(failed);
    const v3 = save(context, hookWorkflow("wf-n4", "three"));
    expect((await call(context, "POST", "/api/workflows/wf-n4/publish", builder.cookie, { version: v3 })).statusCode).toBe(200);
    const retried = await call(context, "POST", `/api/executions/${failed}/retry`, builder.cookie, {});
    expect(retried.statusCode, retried.body).toBe(200);
    expect(JSON.stringify(retried.json())).toContain("three");
    expect(context.store.getExecutionRelease(retried.json<{ executionId: string }>().executionId)).toEqual({ channel: "production", version: v3 });
  });
});

describe("execute channels and fail-closed retries", () => {
  it("a session cannot ask /execute for production; every run records its channel; a gated run whose channel went unrecorded retries the published version", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const v1 = save(context, hookWorkflow("wf-fc", "published"));
    expect((await call(context, "POST", "/api/workflows/wf-fc/publish", builder.cookie, { version: v1 })).statusCode).toBe(200);
    const gate = await call(context, "PUT", "/api/workflows/wf-fc/release-gate", builder.cookie, { enabled: true, datasetIds: [goldenSetId(context, "wf-fc")] });
    expect(gate.statusCode, gate.body).toBe(200);
    save(context, hookWorkflow("wf-fc", "draft"));

    // The editor (a session) runs the draft and cannot ask for production.
    const asked = await call(context, "POST", "/api/workflows/wf-fc/execute?channel=production", builder.cookie, {});
    expect(asked.statusCode).toBe(400);
    const editorRun = await call(context, "POST", "/api/workflows/wf-fc/execute", builder.cookie, {});
    expect(editorRun.json<{ output: unknown }>().output).toMatchObject({ result: "draft" });
    const editorId = editorRun.json<{ executionId: string }>().executionId;
    expect(context.store.getExecutionRelease(editorId)).toEqual({ channel: "draft", version: null });

    // A recorded editor run retries the draft.
    rawDb(context).prepare("UPDATE execution_history SET status = 'error' WHERE id = ?").run(editorId);
    const draftRetry = await call(context, "POST", `/api/executions/${editorId}/retry`, builder.cookie, {});
    expect(draftRetry.statusCode, draftRetry.body).toBe(200);
    expect(JSON.stringify(draftRetry.json())).toContain("draft");

    // The same run with its channel lost retries as production on the gated workflow: the published version.
    rawDb(context).prepare("UPDATE execution_history SET release_channel = NULL, release_version = NULL WHERE id = ?").run(editorId);
    const unknownRetry = await call(context, "POST", `/api/executions/${editorId}/retry`, builder.cookie, {});
    expect(unknownRetry.statusCode, unknownRetry.body).toBe(200);
    expect(JSON.stringify(unknownRetry.json())).toContain("published");
    expect(JSON.stringify(unknownRetry.json())).not.toContain("\"draft\"");
    expect(context.store.getExecutionRelease(unknownRetry.json<{ executionId: string }>().executionId)).toEqual({ channel: "production", version: v1 });

    // Without a gate an unrecorded run retries the draft, as before releases.
    const plain = save(context, hookWorkflow("wf-fc-plain", "plain-draft"));
    expect(plain).toBeGreaterThan(0);
    const plainRun = (await call(context, "POST", "/api/workflows/wf-fc-plain/execute", builder.cookie, {})).json<{ executionId: string }>().executionId;
    rawDb(context).prepare("UPDATE execution_history SET status = 'error', release_channel = NULL WHERE id = ?").run(plainRun);
    const plainRetry = await call(context, "POST", `/api/executions/${plainRun}/retry`, builder.cookie, {});
    expect(plainRetry.statusCode, plainRetry.body).toBe(200);
    expect(JSON.stringify(plainRetry.json())).toContain("plain-draft");
  });
});

describe("enforced gates and golden runs, turning a gate on (N7, N8)", () => {
  it("only an admin deletes a golden run an enforced gate's set uses; turning a gate on that publishes a baseline needs workflow:publish", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const workflow: Workflow = {
      id: "wf-n8",
      name: "N8",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "default",
      nodes: [node("start", "manual_trigger"), node("out", "output", { responseTemplate: "ok" })],
      edges: [{ id: "e1", source: "start", target: "out" }]
    } as Workflow;
    context.store.upsertWorkflow(workflow);
    const executed = await call(context, "POST", "/api/workflows/wf-n8/execute", builder.cookie, {});
    const recording = await call(context, "POST", "/api/replay/recordings", builder.cookie, { executionId: executed.json<{ executionId: string }>().executionId, name: "Golden" });
    expect(recording.statusCode, recording.body).toBe(201);
    const recordingId = recording.json<{ recording: { id: string } }>().recording.id;
    const setId = (await call(context, "POST", "/api/eval/datasets", builder.cookie, { name: "Suite", workflowId: "wf-n8" })).json<{ dataset: { id: string } }>().dataset.id;
    expect((await call(context, "POST", `/api/eval/datasets/${setId}/recordings`, builder.cookie, { recordingId })).statusCode).toBe(201);
    expect((await call(context, "PUT", "/api/workflows/wf-n8/release-gate", admin.cookie, { enabled: true, enforced: true, datasetIds: [setId] })).statusCode).toBe(200);
    const refused = await call(context, "DELETE", `/api/replay/recordings/${recordingId}`, builder.cookie);
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ error: string }>().error).toMatch(/only an admin can delete it/);
    expect(auditTypes(context)).toContain("release.golden_set_change.refused");
    expect((await call(context, "DELETE", `/api/replay/recordings/${recordingId}`, admin.cookie)).statusCode).toBe(200);

    // A custom role with write but without publish may not turn a gate on when that publishes a baseline.
    const writer = await login(context, "builder", "writer");
    context.store.upsertProject({ id: "p-w", name: "W" });
    context.store.upsertCustomRole({ id: "write-only", projectId: "p-w", name: "Write", permissions: ["workflow:read", "workflow:write", "workflow:execute"] });
    context.store.upsertProjectRole({ userId: writer.id, projectId: "p-w", role: "custom", customRoleId: "write-only" });
    save(context, hookWorkflow("wf-n7", "x", "p-w"));
    goldenSet(context, "wf-n7");
    const enable = await call(context, "PUT", "/api/workflows/wf-n7/release-gate", writer.cookie, { enabled: true, datasetIds: ["set-wf-n7"] });
    expect(enable.statusCode).toBe(403);
    expect(context.store.getPublishedVersion("wf-n7")).toBeNull();
    expect(context.store.getReleaseGate("wf-n7")?.enabled ?? false).toBe(false);
  });
});

describe("repeats and old jobs (M1, L2, L3)", () => {
  const withAttempts = (costs: number[], extra: Record<string, unknown> = {}) => ({
    ...plainDiff,
    diff: { ...plainDiff.diff, attempts: costs.map((costUsd, repeatIndex) => ({ repeatIndex, status: "pass", costUsd, ...extra })) }
  });
  const publish = async (context: TestContext, cookie: string, id: string, version: number) => call(context, "POST", `/api/workflows/${id}/publish`, cookie, { version });

  async function setup(id: string, policy: Record<string, unknown>, repeats = 2) {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    save(context, hookWorkflow(id, "v1"));
    await enableGate(context, admin.cookie, id, { policy, candidateOptions: { repeats, aggregate: "all" } });
    const version = save(context, hookWorkflow(id, "v2"));
    const hash = await versionHash(context, admin.cookie, id, version);
    return { context, admin, version, hash };
  }

  it("judges cost at the worst repeat", async () => {
    const { context, admin, version, hash } = await setup("wf-rep-cost", { maxCostIncreasePct: 20 });
    seedJob(context, { workflowId: "wf-rep-cost", datasetIds: ["set-wf-rep-cost"], version, hash, statuses: ["pass", "pass", "pass"], options: { repeats: 2, aggregate: "all" }, diff: withAttempts([0.0105, 0.018], { latencyMs: 100, newGuardBlocks: 0 }) });
    const blocked = await publish(context, admin.cookie, "wf-rep-cost", version);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<{ reasons: string[] }>().reasons.join()).toMatch(/Cost rose 80/);
  });

  it("blocks a latency limit with repeats above 1 unless every attempt has latency and guard data", async () => {
    const { context, admin, version, hash } = await setup("wf-rep-lat", { maxP95LatencyIncreasePct: 50 });
    seedJob(context, { workflowId: "wf-rep-lat", datasetIds: ["set-wf-rep-lat"], version, hash, statuses: ["pass", "pass", "pass"], options: { repeats: 2, aggregate: "all" }, diff: withAttempts([0.01, 0.01]) });
    const blocked = await publish(context, admin.cookie, "wf-rep-lat", version);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<{ reasons: string[] }>().reasons.join()).toMatch(/repeats 1, or remove those limits/);
    seedJob(context, { workflowId: "wf-rep-lat", datasetIds: ["set-wf-rep-lat"], version, hash, statuses: ["pass", "pass", "pass"], options: { repeats: 2, aggregate: "all" }, diff: withAttempts([0.01, 0.01], { latencyMs: 100, newGuardBlocks: 0 }) });
    expect((await publish(context, admin.cookie, "wf-rep-lat", version)).statusCode).toBe(200);
  });

  it("leaves repeats 1 unchanged", async () => {
    const { context, admin, version, hash } = await setup("wf-rep-one", { maxP95LatencyIncreasePct: 50 }, 1);
    seedJob(context, { workflowId: "wf-rep-one", datasetIds: ["set-wf-rep-one"], version, hash, statuses: ["pass", "pass", "pass"] });
    expect((await publish(context, admin.cookie, "wf-rep-one", version)).statusCode).toBe(200);
  });

  it("names a job queued before gates existed", async () => {
    const { context, admin, version, hash } = await setup("wf-old", {}, 1);
    const job = seedJob(context, { workflowId: "wf-old", datasetIds: ["set-wf-old"], version, hash, statuses: ["pass", "pass", "pass"] });
    const preview = async () => (await call(context, "GET", `/api/workflows/wf-old/publish-preview?version=${version}&replayRunId=${job}`, admin.cookie)).json<{ preview: { reasons: string[] } }>().preview;
    expect((await preview()).reasons).toEqual([]);
    context.store.setEvalRunSetSnapshot(job, {});
    expect((await preview()).reasons.join()).toMatch(/changed after replay job/);
    (context.store as unknown as { exec: (sql: string, params: unknown[]) => void }).exec("UPDATE eval_runs SET set_snapshot_json = NULL WHERE id = ?", [job]);
    expect((await preview()).reasons.join()).toMatch(/queued before release gates existed/);
  });
});
