/**
 * Release gate admission and required cases over the API (migration 36):
 * on an enforced gate, cases added after enforcement run but do not count
 * until admitted (the 18/20 -> 58/60 dilution is blocked), builders cannot
 * remove admitted cases, required cases block whatever the pass rate, the
 * approvals inbox admits and removes cases, every add path (golden runs,
 * hand-written cases, golden-set file import) lands pending, and unenforced
 * gates judge exactly as before.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { GateCaseRequestView, ReleaseGateCasesView, ReleaseGateView, ReleasePublishPreview, Workflow, WorkflowNode } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import { SqliteStore } from "./db/database.js";
import { MIGRATIONS } from "./db/migrations.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import { goldenSetSnapshots } from "./services/release-snapshot.js";
import { WorkflowVersionService } from "./services/workflow-version-service.js";

interface TestContext {
  app: FastifyInstance;
  store: SqliteStore;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
  dbPath: string;
}

const contexts: TestContext[] = [];

async function createTestContext(): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-admission-"));
  const dbPath = path.join(tempDir, "orchestrator.db");
  const store = await SqliteStore.create(dbPath);
  store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "sync")
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = createApp(config, store, secretService, authService);
  await app.ready();
  const context: TestContext = { app, store, authService, config, tempDir, dbPath };
  contexts.push(context);
  return context;
}

afterEach(async () => {
  while (contexts.length > 0) {
    const context = contexts.pop()!;
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

/** start → label → output that answers `answer`. */
function labelWorkflow(id: string, answer: string): Workflow {
  return {
    id,
    name: `Admission ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      node("start", "manual_trigger"),
      node("label", "set_node", { assignments: [{ key: "answer", valueTemplate: answer }] }),
      node("output", "output", { responseTemplate: "answer {{results.label.answer}}" })
    ],
    edges: [
      { id: "e1", source: "start", target: "label" },
      { id: "e2", source: "label", target: "output" }
    ]
  } as Workflow;
}

function save(context: TestContext, workflow: Workflow): number {
  const saved = context.store.upsertWorkflow(workflow);
  return new WorkflowVersionService(context.store).snapshot({ workflow: saved, changeNote: "test" }).version;
}

/** Golden-run cases in a set: each with its own (fake) recording id, so they count as golden-run cases. */
function addCases(context: TestContext, setId: string, prefix: string, count: number): string[] {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `${prefix}_${index}`;
    context.store.createEvalFixture({ id, datasetId: setId, name: `${prefix} ${index + 1}`, input: {}, recordingId: `rec_${id}` });
    ids.push(id);
  }
  return ids;
}

const plainDiff = { verdict: "same", reasons: [], diff: { totals: { costUsd: { baseline: 0.01, candidate: 0.01 }, latencyMs: { baseline: 100, candidate: 100 } }, guard: { added: [], changed: [] } } };

/** A finished replay job over the sets as they are now, with the given status per case. */
function seedJob(context: TestContext, input: { workflowId: string; datasetIds: string[]; version: number; hash: string; statuses: Record<string, "pass" | "fail" | "error"> }): string {
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
    options: { mcpMode: "strict", maxCostUsd: 5 }
  });
  context.store.setEvalRunSetSnapshot(id, goldenSetSnapshots(input.datasetIds, (datasetId) => context.store.listEvalFixtures(datasetId)));
  Object.entries(input.statuses).forEach(([fixtureId, status], index) => {
    context.store.recordEvalResult({
      id: `res_${index}_${id}`,
      runId: id,
      fixtureId,
      status,
      score: { pass: status === "pass", details: [{ type: "status", pass: status === "pass", reason: status }] },
      diff: plainDiff
    });
  });
  context.store.finalizeEvalRun({ id, status: "completed" });
  return id;
}

const statusesOf = (ids: string[], status: "pass" | "fail" | "error") => Object.fromEntries(ids.map((id) => [id, status])) as Record<string, "pass" | "fail" | "error">;

async function putGate(context: TestContext, cookie: string, workflowId: string, settings: Record<string, unknown>): Promise<ReleaseGateView> {
  const response = await call(context, "PUT", `/api/workflows/${workflowId}/release-gate`, cookie, { enabled: true, ...settings });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ gate: ReleaseGateView }>().gate;
}

async function preview(context: TestContext, cookie: string, workflowId: string, version: number, runId?: string): Promise<ReleasePublishPreview> {
  const response = await call(context, "GET", `/api/workflows/${workflowId}/publish-preview?version=${version}${runId ? `&replayRunId=${runId}` : ""}`, cookie);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ preview: ReleasePublishPreview }>().preview;
}

async function casesOf(context: TestContext, cookie: string, workflowId: string): Promise<ReleaseGateCasesView> {
  const response = await call(context, "GET", `/api/workflows/${workflowId}/release-gate/cases`, cookie);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ cases: ReleaseGateCasesView }>().cases;
}

const auditLog = (context: TestContext) => context.store.listAuditLogs({ category: "release", pageSize: 500 }).items;
const auditTypes = (context: TestContext) => auditLog(context).map((entry) => entry.eventType);

/**
 * A workflow whose enforced gate admitted 20 golden-run cases (18 pass and 2
 * fail on version 2): 90% against a 95% gate that tolerates the 2 regressions.
 */
async function dilutionSetup(context: TestContext, workflowId: string, enforced: boolean) {
  const admin = await login(context, "admin");
  const builder = await login(context, "builder");
  save(context, labelWorkflow(workflowId, "v1"));
  const setId = `set-${workflowId}`;
  context.store.createEvalDataset({ id: setId, name: `Golden ${workflowId}`, workflowId });
  const original = addCases(context, setId, `${workflowId}_orig`, 20);
  await putGate(context, admin.cookie, workflowId, { datasetIds: [setId], policy: { minPassRate: 0.95, maxRegressions: 5 }, ...(enforced ? { enforced: true } : {}) });
  const version = save(context, labelWorkflow(workflowId, "v2"));
  const hash = (await preview(context, builder.cookie, workflowId, version)).workflowHash;
  const statuses = { ...statusesOf(original.slice(0, 18), "pass"), ...statusesOf(original.slice(18), "fail") };
  return { admin, builder, setId, original, version, hash, statuses };
}

describe("dilution on an enforced gate", () => {
  it("adding 40 easy cases does not turn 18/20 (blocked) into 58/60 (passed): they wait for admission, then count once admitted", async () => {
    const context = await createTestContext();
    const { admin, builder, setId, version, hash, statuses } = await dilutionSetup(context, "wf-dilute", true);
    const before = seedJob(context, { workflowId: "wf-dilute", datasetIds: [setId], version, hash, statuses });
    const first = await preview(context, builder.cookie, "wf-dilute", version, before);
    expect(first.verdict).toBe("blocked");
    expect(first.reasons.join()).toMatch(/Pass rate 90% is below the required 95%/);

    // The builder adds 40 always-passing cases through the API, one by one.
    for (let index = 0; index < 40; index += 1) {
      const added = await call(context, "POST", `/api/eval/datasets/${setId}/fixtures`, builder.cookie, { name: `Easy ${index + 1}`, input: {} });
      expect(added.statusCode, added.body).toBe(200);
    }
    const easy = context.store.listEvalFixtures(setId).filter((fixture) => fixture.name.startsWith("Easy ")).map((fixture) => fixture.id);
    const diluted = seedJob(context, { workflowId: "wf-dilute", datasetIds: [setId], version, hash, statuses: { ...statuses, ...statusesOf(easy, "pass") } });
    const judged = await preview(context, builder.cookie, "wf-dilute", version, diluted);
    expect(judged.verdict).toBe("blocked");
    expect(judged.stats).toMatchObject({ cases: 20, pass: 18, passRate: 0.9 });
    expect(judged.stats?.admission).toMatchObject({ admitted: 20, pending: 40, required: 0 });
    const published = await call(context, "POST", "/api/workflows/wf-dilute/publish", builder.cookie, { version, replayRunId: diluted });
    expect(published.statusCode).toBe(409);

    const view = await casesOf(context, builder.cookie, "wf-dilute");
    expect(view).toMatchObject({ enforced: true, counts: { admitted: 20, pending: 40, required: 0 }, canAdmit: false, canRequest: true });

    // A builder cannot admit; an admin can, and the same job then passes at 58/60.
    expect((await call(context, "POST", "/api/workflows/wf-dilute/release-gate/cases/admit", builder.cookie, { fixtureIds: easy })).statusCode).toBe(403);
    const admitted = await call(context, "POST", "/api/workflows/wf-dilute/release-gate/cases/admit", admin.cookie, { fixtureIds: easy, reason: "Reviewed" });
    expect(admitted.statusCode, admitted.body).toBe(200);
    expect(admitted.json<{ cases: ReleaseGateCasesView }>().cases.counts).toEqual({ admitted: 60, pending: 0, required: 0 });
    const after = await preview(context, builder.cookie, "wf-dilute", version, diluted);
    expect(after.verdict).toBe("passed");
    expect(after.stats).toMatchObject({ cases: 60, pass: 58 });
    expect(auditTypes(context)).toEqual(expect.arrayContaining(["release.gate.cases_admitted", "release.gate.cases_refused"]));
  });

  it("an unenforced gate behaves exactly as before: every case counts and required marks are ignored", async () => {
    const context = await createTestContext();
    const { builder, setId, original, version, hash, statuses } = await dilutionSetup(context, "wf-open", false);
    const easy = addCases(context, setId, "wf-open_easy", 40);
    // A required mark left on a case (from an earlier enforcement) changes nothing on an unenforced gate.
    context.store.setEvalFixtureRequired(original[19]!, true);
    const job = seedJob(context, { workflowId: "wf-open", datasetIds: [setId], version, hash, statuses: { ...statuses, ...statusesOf(easy, "pass") } });
    const judged = await preview(context, builder.cookie, "wf-open", version, job);
    expect(judged.verdict).toBe("passed");
    expect(judged.stats).toMatchObject({ cases: 60, pass: 58 });
    expect(judged.stats?.admission).toBeUndefined();
    expect(await casesOf(context, builder.cookie, "wf-open")).toEqual({
      workflowId: "wf-open",
      enforced: false,
      cases: [],
      counts: { admitted: 0, pending: 0, required: 0 },
      canAdmit: false,
      canRequest: false
    });
    expect(context.store.getReleaseGate("wf-open")?.admittedFixtureIds).toBeNull();
    // Builders remove cases of an unenforced gate's set as before.
    expect((await call(context, "DELETE", `/api/eval/fixtures/${original[0]}`, builder.cookie)).statusCode).toBe(200);
    // Admission routes refuse an unenforced gate.
    const admin = await login(context, "admin");
    expect((await call(context, "POST", "/api/workflows/wf-open/release-gate/cases/admit", admin.cookie, { fixtureIds: [easy[0]] })).statusCode).toBe(409);
  });
});

describe("removing cases from an enforced gate", () => {
  it("refuses a builder deleting an admitted failing case (403, plain message), lets them drop a pending one, and lets an admin remove either", async () => {
    const context = await createTestContext();
    const { admin, builder, setId, original } = await dilutionSetup(context, "wf-del", true);
    const failingCase = original[19]!;
    const refused = await call(context, "DELETE", `/api/eval/fixtures/${failingCase}`, builder.cookie);
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ error: string }>().error).toBe(
      "An enforced release gate counts this case: only an admin can remove it. Ask for its removal from the gate's Cases panel, and an approver decides in the approvals inbox."
    );
    expect(context.store.getEvalFixture(failingCase)).not.toBeNull();
    // The whole set follows the same rule.
    const setRefused = await call(context, "DELETE", `/api/eval/datasets/${setId}`, builder.cookie);
    expect(setRefused.statusCode).toBe(403);
    expect(setRefused.json<{ error: string }>().error).toMatch(/only an admin can delete it/);
    // So does a golden run an admitted case replays.
    expect(auditTypes(context)).toContain("release.golden_set_change.refused");

    // A pending case is not counted, so removing it loosens nothing.
    const [pendingCase] = addCases(context, setId, "wf-del_new", 1);
    expect((await call(context, "DELETE", `/api/eval/fixtures/${pendingCase}`, builder.cookie)).statusCode).toBe(200);

    expect((await call(context, "DELETE", `/api/eval/fixtures/${failingCase}`, admin.cookie)).statusCode).toBe(200);
    expect((await casesOf(context, admin.cookie, "wf-del")).counts).toEqual({ admitted: 19, pending: 0, required: 0 });
  });

  it("a builder's removal request, approved in the inbox by another approver, removes the case; rejecting needs a reason", async () => {
    const context = await createTestContext();
    const { admin, builder, original } = await dilutionSetup(context, "wf-rm", true);
    const target = original[19]!;
    const asked = await call(context, "POST", "/api/workflows/wf-rm/release-gate/cases/requests", builder.cookie, { action: "remove", fixtureIds: [target], reason: "Flaky upstream" });
    expect(asked.statusCode, asked.body).toBe(202);
    const request = asked.json<{ request: GateCaseRequestView }>().request;
    expect(request).toMatchObject({ kind: "remove_cases", status: "pending", approverRoles: ["admin"], canDecide: false });
    expect((await casesOf(context, builder.cookie, "wf-rm")).cases.find((entry) => entry.fixtureId === target)).toMatchObject({ requestId: request.id, requestKind: "remove_cases" });
    // A pending case cannot be asked for removal: the builder may delete it directly.
    const [fresh] = addCases(context, "set-wf-rm", "wf-rm_new", 1);
    expect((await call(context, "POST", "/api/workflows/wf-rm/release-gate/cases/requests", builder.cookie, { action: "remove", fixtureIds: [fresh], reason: "x" })).statusCode).toBe(409);

    expect((await call(context, "POST", `/api/approvals/${request.id}/reject`, admin.cookie, {})).statusCode).toBe(400);
    const approved = await call(context, "POST", `/api/approvals/${request.id}/approve`, admin.cookie, { reason: "Agreed" });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json<{ request: GateCaseRequestView }>().request.status).toBe("approved");
    expect(context.store.getEvalFixture(target)).toBeNull();
    expect((await casesOf(context, admin.cookie, "wf-rm")).counts).toMatchObject({ admitted: 19 });
    expect(auditTypes(context)).toEqual(expect.arrayContaining(["release.gate.case_request.requested", "release.gate.case_request.decided", "release.gate.cases_removed"]));
  });
});

describe("required cases", () => {
  it("a failing required case blocks the publish although every other case passes and the pass rate is met; only admins set it", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    save(context, labelWorkflow("wf-req", "v1"));
    context.store.createEvalDataset({ id: "set-req", name: "Golden", workflowId: "wf-req" });
    const ids = addCases(context, "set-req", "req", 20);
    await putGate(context, admin.cookie, "wf-req", { datasetIds: ["set-req"], enforced: true, policy: { minPassRate: 0.9, maxRegressions: 5 } });
    const version = save(context, labelWorkflow("wf-req", "v2"));
    const hash = (await preview(context, builder.cookie, "wf-req", version)).workflowHash;
    const job = seedJob(context, { workflowId: "wf-req", datasetIds: ["set-req"], version, hash, statuses: { ...statusesOf(ids.slice(0, 19), "pass"), [ids[19]!]: "fail" } });
    expect((await preview(context, builder.cookie, "wf-req", version, job)).verdict).toBe("passed");

    expect((await call(context, "PUT", `/api/workflows/wf-req/release-gate/cases/${ids[19]}/required`, builder.cookie, { required: true })).statusCode).toBe(403);
    const marked = await call(context, "PUT", `/api/workflows/wf-req/release-gate/cases/${ids[19]}/required`, admin.cookie, { required: true });
    expect(marked.statusCode, marked.body).toBe(200);
    expect(marked.json<{ cases: ReleaseGateCasesView }>().cases.counts.required).toBe(1);
    const blocked = await preview(context, builder.cookie, "wf-req", version, job);
    expect(blocked.verdict).toBe("blocked");
    expect(blocked.stats).toMatchObject({ passRate: 0.95 });
    expect(blocked.reasons).toEqual(['Required case "req 20" failed: a required case must pass whatever the pass rate.']);
    expect(blocked.stats?.admission?.requiredFailures).toEqual([{ id: ids[19], name: "req 20", problem: "failed" }]);
    // The fixtures API shows the mark (the golden-set page's chip).
    expect((await call(context, "GET", "/api/eval/datasets/set-req/fixtures", builder.cookie)).json<{ fixtures: Array<{ id: string; required: boolean }> }>().fixtures.find((entry) => entry.id === ids[19])?.required).toBe(true);

    // An erroring required case blocks too while errors count as failures.
    const erroring = seedJob(context, { workflowId: "wf-req", datasetIds: ["set-req"], version, hash, statuses: { ...statusesOf(ids.slice(0, 19), "pass"), [ids[19]!]: "error" } });
    expect((await preview(context, builder.cookie, "wf-req", version, erroring)).reasons).toEqual(['Required case "req 20" was inconclusive: a required case must pass whatever the pass rate.']);

    // Builders cannot clear it, nor delete the required case.
    expect((await call(context, "PUT", `/api/workflows/wf-req/release-gate/cases/${ids[19]}/required`, builder.cookie, { required: false })).statusCode).toBe(403);
    expect((await call(context, "DELETE", `/api/eval/fixtures/${ids[19]}`, builder.cookie)).statusCode).toBe(403);

    const cleared = await call(context, "PUT", `/api/workflows/wf-req/release-gate/cases/${ids[19]}/required`, admin.cookie, { required: false });
    expect(cleared.statusCode).toBe(200);
    expect((await preview(context, builder.cookie, "wf-req", version, job)).verdict).toBe("passed");
    const required = auditLog(context).filter((entry) => entry.eventType === "release.gate.case_required");
    expect(required.map((entry) => (entry.metadata as Record<string, unknown> | null)?.loosened)).toEqual(expect.arrayContaining([[], ['stops requiring case "req 20"']]));
    // A hand-written case cannot be required: replay jobs skip it.
    const handWritten = await call(context, "POST", "/api/eval/datasets/set-req/fixtures", admin.cookie, { name: "Typed", input: {} });
    const handId = handWritten.json<{ fixture: { id: string } }>().fixture.id;
    expect((await call(context, "PUT", `/api/workflows/wf-req/release-gate/cases/${handId}/required`, admin.cookie, { required: true })).statusCode).toBe(400);
  });

  it("marking a pending case required admits it", async () => {
    const context = await createTestContext();
    const { admin, setId } = await dilutionSetup(context, "wf-req2", true);
    const [late] = addCases(context, setId, "late", 1);
    expect((await casesOf(context, admin.cookie, "wf-req2")).counts.pending).toBe(1);
    const marked = await call(context, "PUT", `/api/workflows/wf-req2/release-gate/cases/${late}/required`, admin.cookie, { required: true });
    expect(marked.json<{ cases: ReleaseGateCasesView }>().cases.counts).toEqual({ admitted: 21, pending: 0, required: 1 });
  });
});

describe("admission through the approvals inbox", () => {
  it("a builder asks, cannot approve their own request, and another approver's approval admits the cases; requests are project-scoped", async () => {
    const context = await createTestContext();
    const { admin, builder, setId, version, hash, statuses } = await dilutionSetup(context, "wf-ask", true);
    // A named builder approver.
    const lead = await login(context, "builder", "lead");
    await putGate(context, admin.cookie, "wf-ask", { datasetIds: [setId], enforced: true, policy: { minPassRate: 0.95, maxRegressions: 5 }, approvers: { approverUsers: [lead.email] } });
    const easy = addCases(context, setId, "ask_easy", 40);
    const job = seedJob(context, { workflowId: "wf-ask", datasetIds: [setId], version, hash, statuses: { ...statuses, ...statusesOf(easy, "pass") } });
    expect((await preview(context, builder.cookie, "wf-ask", version, job)).verdict).toBe("blocked");

    const missingReason = await call(context, "POST", "/api/workflows/wf-ask/release-gate/cases/requests", builder.cookie, { action: "admit", fixtureIds: easy });
    expect(missingReason.statusCode).toBe(400);
    const asked = await call(context, "POST", "/api/workflows/wf-ask/release-gate/cases/requests", builder.cookie, { action: "admit", fixtureIds: easy, reason: "New refund scenarios" });
    expect(asked.statusCode, asked.body).toBe(202);
    const request = asked.json<{ request: GateCaseRequestView }>().request;
    expect(request).toMatchObject({ kind: "admit_cases", approverUsers: [lead.email], allowSelfApproval: false });
    expect(request.cases).toHaveLength(40);
    // Asking twice for the same cases answers the same request; someone else's overlapping ask is refused.
    expect((await call(context, "POST", "/api/workflows/wf-ask/release-gate/cases/requests", builder.cookie, { action: "admit", fixtureIds: easy, reason: "again" })).json<{ request: GateCaseRequestView }>().request.id).toBe(request.id);
    expect((await call(context, "POST", "/api/workflows/wf-ask/release-gate/cases/requests", lead.cookie, { action: "admit", fixtureIds: [easy[0]], reason: "me too" })).statusCode).toBe(409);

    const inbox = await call(context, "GET", "/api/approvals", lead.cookie);
    const item = inbox.json<{ items: Array<{ id: string; kind: string; canDecide: boolean }> }>().items.find((entry) => entry.id === request.id);
    expect(item).toMatchObject({ kind: "admit_cases", canDecide: true });
    const own = await call(context, "POST", `/api/approvals/${request.id}/approve`, builder.cookie, {});
    expect(own.statusCode).toBe(403);
    expect(own.json<{ error: string }>().error).toMatch(/not one of this gate's approvers|your own request/);

    const approved = await call(context, "POST", `/api/approvals/${request.id}/approve`, lead.cookie, {});
    expect(approved.statusCode, approved.body).toBe(200);
    expect((await casesOf(context, builder.cookie, "wf-ask")).counts).toEqual({ admitted: 60, pending: 0, required: 0 });
    expect((await preview(context, builder.cookie, "wf-ask", version, job)).verdict).toBe("passed");
    // Deciding again is refused.
    expect((await call(context, "POST", `/api/approvals/${request.id}/approve`, lead.cookie, {})).statusCode).toBe(409);
  });

  it("a request goes stale when the gate stops being enforced or its cases were admitted meanwhile", async () => {
    const context = await createTestContext();
    const { admin, builder, setId } = await dilutionSetup(context, "wf-stale", true);
    const late = addCases(context, setId, "stale", 2);
    const asked = await call(context, "POST", "/api/workflows/wf-stale/release-gate/cases/requests", builder.cookie, { action: "admit", fixtureIds: late, reason: "please" });
    const id = asked.json<{ request: GateCaseRequestView }>().request.id;
    expect((await call(context, "POST", "/api/workflows/wf-stale/release-gate/cases/admit", admin.cookie, { fixtureIds: late })).statusCode).toBe(200);
    const stale = await call(context, "POST", `/api/approvals/${id}/approve`, admin.cookie, {});
    expect(stale.statusCode).toBe(409);
    expect(stale.json<{ error: string }>().error).toMatch(/stale and was canceled/);
    expect(context.store.getGateCaseRequest(id)?.status).toBe("canceled");
  });

  it("is project-scoped: unreadable answers 404, readable without publish 403, on the cases routes and the inbox", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const requester = await login(context, "builder", "requester");
    const outsider = await login(context, "builder", "outsider");
    const reader = await login(context, "builder", "reader");
    context.store.upsertProject({ id: "p-sec", name: "Secret" });
    context.store.upsertCustomRole({ id: "none-sec", projectId: "p-sec", name: "None", permissions: [] });
    context.store.upsertCustomRole({ id: "read-sec", projectId: "p-sec", name: "Read", permissions: ["workflow:read"] });
    context.store.upsertProjectRole({ userId: outsider.id, projectId: "p-sec", role: "custom", customRoleId: "none-sec" });
    context.store.upsertProjectRole({ userId: reader.id, projectId: "p-sec", role: "custom", customRoleId: "read-sec" });
    save(context, { ...labelWorkflow("wf-sec", "v1"), projectId: "p-sec" });
    context.store.createEvalDataset({ id: "set-sec", name: "Golden", workflowId: "wf-sec" });
    addCases(context, "set-sec", "sec", 3);
    await putGate(context, admin.cookie, "wf-sec", { datasetIds: ["set-sec"], enforced: true, approvers: { approverRoles: ["builder"] } });
    const late = addCases(context, "set-sec", "sec_late", 1);
    const asked = await call(context, "POST", "/api/workflows/wf-sec/release-gate/cases/requests", requester.cookie, { action: "admit", fixtureIds: late, reason: "r" });
    expect(asked.statusCode, asked.body).toBe(202);
    const id = asked.json<{ request: GateCaseRequestView }>().request.id;
    expect((await call(context, "GET", "/api/workflows/wf-sec/release-gate/cases", outsider.cookie)).statusCode).toBe(404);
    expect((await call(context, "POST", "/api/workflows/wf-sec/release-gate/cases/requests", outsider.cookie, { action: "admit", fixtureIds: late, reason: "r" })).statusCode).toBe(404);
    expect((await call(context, "POST", `/api/approvals/${id}/approve`, outsider.cookie, {})).statusCode).toBe(404);
    expect((await call(context, "GET", "/api/approvals", outsider.cookie)).json<{ items: unknown[] }>().items).toEqual([]);
    expect((await call(context, "GET", "/api/workflows/wf-sec/release-gate/cases", reader.cookie)).statusCode).toBe(200);
    expect((await call(context, "POST", "/api/workflows/wf-sec/release-gate/cases/requests", reader.cookie, { action: "admit", fixtureIds: late, reason: "r" })).statusCode).toBe(403);
    const refused = await call(context, "POST", `/api/approvals/${id}/approve`, reader.cookie, {});
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ error: string }>().error).toMatch(/may not publish this workflow/);
  });
});

describe("every add path lands pending", () => {
  it("golden runs added through the API, hand-written cases, and a golden-set file import added to the gate by a builder wait for admission; a set an admin adds is admitted", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    context.store.upsertWorkflow(labelWorkflow("wf-paths", "v1"));
    const recordings: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const run = await call(context, "POST", "/api/workflows/wf-paths/execute", builder.cookie, {});
      expect(run.statusCode, run.body).toBe(200);
      const saved = await call(context, "POST", "/api/replay/recordings", builder.cookie, { executionId: run.json<{ executionId: string }>().executionId, name: `Golden ${index + 1}` });
      expect(saved.statusCode, saved.body).toBe(201);
      recordings.push(saved.json<{ recording: { id: string } }>().recording.id);
    }
    save(context, labelWorkflow("wf-paths", "v1"));
    const created = await call(context, "POST", "/api/eval/datasets", builder.cookie, { name: "Suite", workflowId: "wf-paths" });
    const setId = created.json<{ dataset: { id: string } }>().dataset.id;
    for (const recordingId of recordings.slice(0, 2)) expect((await call(context, "POST", `/api/eval/datasets/${setId}/recordings`, builder.cookie, { recordingId })).statusCode).toBe(201);
    await putGate(context, admin.cookie, "wf-paths", { datasetIds: [setId], enforced: true });
    expect((await casesOf(context, builder.cookie, "wf-paths")).counts).toEqual({ admitted: 2, pending: 0, required: 0 });

    // A golden run added through the API, and a hand-written case.
    expect((await call(context, "POST", `/api/eval/datasets/${setId}/recordings`, builder.cookie, { recordingId: recordings[2] })).statusCode).toBe(201);
    expect((await call(context, "POST", `/api/eval/datasets/${setId}/fixtures`, builder.cookie, { name: "Typed", input: {} })).statusCode).toBe(200);
    expect((await casesOf(context, builder.cookie, "wf-paths")).counts).toEqual({ admitted: 2, pending: 2, required: 0 });

    // A golden-set file import makes a new set; a builder adding it to the enforced gate leaves its cases pending.
    const file = (await call(context, "GET", `/api/eval/datasets/${setId}/export`, builder.cookie)).json();
    const imported = await call(context, "POST", "/api/eval/datasets/import", builder.cookie, { file, workflowId: "wf-paths", name: "Imported" });
    expect(imported.statusCode, imported.body).toBe(201);
    const importedId = imported.json<{ dataset: { id: string } }>().dataset.id;
    await putGate(context, builder.cookie, "wf-paths", { datasetIds: [setId, importedId] });
    const afterImport = await casesOf(context, builder.cookie, "wf-paths");
    expect(afterImport.counts).toEqual({ admitted: 2, pending: 5, required: 0 });
    expect(afterImport.cases.filter((entry) => entry.datasetId === importedId).every((entry) => entry.admission === "pending")).toBe(true);

    // The banner text the web shows comes from these counts; the replay job view carries them for the CLI.
    const job = seedJob(context, { workflowId: "wf-paths", datasetIds: [setId, importedId], version: 1, hash: "a".repeat(64), statuses: {} });
    const jobView = (await call(context, "GET", `/api/replay/runs/${job}`, builder.cookie)).json<{ run: { releaseGate?: { admittedFixtureIds: string[]; pendingFixtureIds: string[] } } }>().run;
    expect(jobView.releaseGate?.admittedFixtureIds).toHaveLength(2);
    expect(jobView.releaseGate?.pendingFixtureIds).toHaveLength(5);

    // An admin adding a set admits its cases only when they confirm it (admitAddedSetCases); a builder cannot.
    const second = await call(context, "POST", "/api/eval/datasets/import", builder.cookie, { file, workflowId: "wf-paths", name: "Imported by admin" });
    const secondId = second.json<{ dataset: { id: string } }>().dataset.id;
    const builderAdmits = await call(context, "PUT", "/api/workflows/wf-paths/release-gate", builder.cookie, { enabled: true, datasetIds: [setId, importedId, secondId], admitAddedSetCases: true });
    expect(builderAdmits.statusCode).toBe(403);
    await putGate(context, admin.cookie, "wf-paths", { datasetIds: [setId, importedId, secondId], enforced: true });
    expect((await casesOf(context, builder.cookie, "wf-paths")).counts).toEqual({ admitted: 2, pending: 8, required: 0 });
    const third = await call(context, "POST", "/api/eval/datasets/import", builder.cookie, { file, workflowId: "wf-paths", name: "Third" });
    const thirdId = third.json<{ dataset: { id: string } }>().dataset.id;
    await putGate(context, admin.cookie, "wf-paths", { datasetIds: [setId, importedId, secondId, thirdId], enforced: true, admitAddedSetCases: true });
    expect((await casesOf(context, builder.cookie, "wf-paths")).counts).toEqual({ admitted: 5, pending: 8, required: 0 });
    const updated = auditLog(context).find((entry) => entry.eventType === "release.gate.updated" && (entry.metadata as Record<string, unknown> | null)?.admitAddedSetCases === true);
    expect((updated?.metadata as Record<string, unknown> | undefined)?.newlyAdmittedFixtureIds).toHaveLength(3);

    // Lifting enforcement keeps the admission state; enforcing again restores it: nothing that was waiting is admitted.
    await putGate(context, admin.cookie, "wf-paths", { datasetIds: [setId, importedId, secondId, thirdId], enforced: false });
    expect(context.store.getReleaseGate("wf-paths")?.admittedFixtureIds).toHaveLength(5);
    expect((await casesOf(context, builder.cookie, "wf-paths")).enforced).toBe(false);
    await putGate(context, admin.cookie, "wf-paths", { datasetIds: [setId, importedId, secondId, thirdId], enforced: true });
    expect((await casesOf(context, builder.cookie, "wf-paths")).counts).toEqual({ admitted: 5, pending: 8, required: 0 });
  });

  it("re-enforcing a gate with 20 admitted and 5 pending cases leaves the 5 pending", async () => {
    const context = await createTestContext();
    const { admin, setId } = await dilutionSetup(context, "wf-reenforce", true);
    addCases(context, setId, "wf-reenforce_late", 5);
    expect((await casesOf(context, admin.cookie, "wf-reenforce")).counts).toEqual({ admitted: 20, pending: 5, required: 0 });
    const settings = { datasetIds: [setId], policy: { minPassRate: 0.95, maxRegressions: 5 } };
    await putGate(context, admin.cookie, "wf-reenforce", { ...settings, enforced: false });
    await putGate(context, admin.cookie, "wf-reenforce", { ...settings, enforced: true });
    expect((await casesOf(context, admin.cookie, "wf-reenforce")).counts).toEqual({ admitted: 20, pending: 5, required: 0 });
    // A case added while the gate was not enforced waits too.
    await putGate(context, admin.cookie, "wf-reenforce", { ...settings, enforced: false });
    addCases(context, setId, "wf-reenforce_open", 1);
    await putGate(context, admin.cookie, "wf-reenforce", { ...settings, enforced: true });
    expect((await casesOf(context, admin.cookie, "wf-reenforce")).counts).toEqual({ admitted: 20, pending: 6, required: 0 });
  });
});

describe("migration 36", () => {
  it("adds the columns and table in SQLite and Postgres (with a down path), and admits every case of a gate enforced before it once (so old jobs judge the same), then fails closed", async () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 36)!;
    expect(migration.up).toMatch(/ALTER TABLE eval_fixtures ADD COLUMN IF NOT EXISTS required INTEGER NOT NULL DEFAULT 0/);
    expect(migration.up).toMatch(/CREATE TABLE IF NOT EXISTS gate_case_requests/);
    expect(migration.up).toMatch(/UPDATE release_gates g/);
    expect(migration.down).toMatch(/DROP TABLE IF EXISTS gate_case_requests/);
    expect(migration.down).toMatch(/ALTER TABLE eval_fixtures DROP COLUMN IF EXISTS required/);

    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    expect(context.store.getSchemaMarker("gate_admission_backfill")).not.toBeNull();
    save(context, labelWorkflow("wf-old", "v1"));
    context.store.createEvalDataset({ id: "set-old", name: "Golden", workflowId: "wf-old" });
    const ids = addCases(context, "set-old", "old", 3);
    await putGate(context, admin.cookie, "wf-old", { datasetIds: ["set-old"], enforced: true });
    const version = save(context, labelWorkflow("wf-old", "v2"));
    const hash = (await preview(context, builder.cookie, "wf-old", version)).workflowHash;
    const job = seedJob(context, { workflowId: "wf-old", datasetIds: ["set-old"], version, hash, statuses: statusesOf(ids, "pass") });
    await context.app.close();
    context.store.close();

    // As a database from before migration 36 left it: no admission columns, no backfill marker.
    const raw = new Database(context.dbPath);
    raw.exec("ALTER TABLE release_gates DROP COLUMN admitted_fixture_ids_json; ALTER TABLE release_gates DROP COLUMN admission_updated_at; ALTER TABLE release_gates DROP COLUMN admission_updated_by;");
    raw.prepare("DELETE FROM schema_markers WHERE name = 'gate_admission_backfill'").run();
    raw.close();

    const reopened = await SqliteStore.create(context.dbPath);
    try {
      // Backfilled once: the gate admits every case its sets held, so it judges as before.
      expect(reopened.getReleaseGate("wf-old")?.admittedFixtureIds).toEqual([...ids].sort());
      expect(reopened.getReleaseGate("wf-old")?.admissionUpdatedBy).toBe("migration 36");
      expect(reopened.listEvalFixtures("set-old").every((fixture) => fixture.required === false)).toBe(true);
      const columns = (reopened as unknown as { queryAll: (sql: string) => Array<{ name: string }> }).queryAll("PRAGMA table_info(gate_case_requests)").map((row) => row.name);
      expect(columns).toEqual(expect.arrayContaining(["id", "workflow_id", "action", "fixtures_json", "status", "gate_authority"]));
    } finally {
      reopened.close();
    }

    // Afterwards the backfill never runs again: an enforced gate that lost its admission fails closed.
    const lost = new Database(context.dbPath);
    lost.prepare("UPDATE release_gates SET admitted_fixture_ids_json = NULL WHERE workflow_id = ?").run("wf-old");
    lost.close();
    const again = await SqliteStore.create(context.dbPath);
    const secretService = new SecretService(again, context.config.SECRET_MASTER_KEY_BASE64);
    const authService = new AuthService(again, context.config.SESSION_TTL_HOURS);
    const app = createApp(context.config, again, secretService, authService);
    await app.ready();
    try {
      expect(again.getReleaseGate("wf-old")?.admittedFixtureIds).toBeNull();
      const restarted = { ...context, app, store: again, authService };
      const adminAgain = await login(restarted, "admin");
      const counted = await preview(restarted, adminAgain.cookie, "wf-old", version, job);
      expect(counted.verdict).toBe("blocked");
      expect(counted.stats).toMatchObject({ cases: 0 });
      expect((await casesOf(restarted, adminAgain.cookie, "wf-old")).counts).toEqual({ admitted: 0, pending: 3, required: 0 });
      // An admin re-confirms by admitting the cases.
      expect((await call(restarted, "POST", "/api/workflows/wf-old/release-gate/cases/admit", adminAgain.cookie, { fixtureIds: ids })).statusCode).toBe(200);
      expect((await preview(restarted, adminAgain.cookie, "wf-old", version, job)).verdict).toBe("passed");
    } finally {
      await app.close();
      try {
        again.close();
      } catch {
        // Closed by the app's shutdown hooks.
      }
    }
    contexts.splice(contexts.indexOf(context), 1);
    fs.rmSync(context.tempDir, { recursive: true, force: true });
  });
});

describe("gate case requests are decided against the gate as it is now", () => {
  it("an approver removed from the gate after a removal request can no longer approve it: the request is stale and the case stays", async () => {
    const context = await createTestContext();
    const { admin, builder, setId, original } = await dilutionSetup(context, "wf-tighten", true);
    const lead = await login(context, "builder", "lead");
    const settings = { datasetIds: [setId], enforced: true, policy: { minPassRate: 0.95, maxRegressions: 5 } };
    await putGate(context, admin.cookie, "wf-tighten", { ...settings, approvers: { approverUsers: [lead.email] } });
    const failing = original[19]!;
    const asked = await call(context, "POST", "/api/workflows/wf-tighten/release-gate/cases/requests", builder.cookie, { action: "remove", fixtureIds: [failing], reason: "Flaky" });
    expect(asked.statusCode, asked.body).toBe(202);
    const id = asked.json<{ request: GateCaseRequestView }>().request.id;

    // The admin sees the risk and hands the decision to admins only.
    await putGate(context, admin.cookie, "wf-tighten", { ...settings, approvers: { approverRoles: ["admin"] } });
    const inbox = (await call(context, "GET", "/api/approvals", lead.cookie)).json<{ items: GateCaseRequestView[] }>().items.find((entry) => entry.id === id);
    expect(inbox).toMatchObject({ canDecide: false, approverRoles: ["admin"], approverUsers: [] });
    expect(inbox?.cannotDecideReason).toMatch(/stale: Who decides the release gate's cases .* changed after the request was made/);

    const refused = await call(context, "POST", `/api/approvals/${id}/approve`, lead.cookie, {});
    expect(refused.statusCode).toBe(403);
    expect(context.store.getEvalFixture(failing)).not.toBeNull();
    // An admin trying it learns it is stale, in plain words, and it is canceled.
    const stale = await call(context, "POST", `/api/approvals/${id}/approve`, admin.cookie, {});
    expect(stale.statusCode).toBe(409);
    expect(stale.json<{ error: string }>().error).toMatch(/stale and was canceled: Who decides the release gate's cases \(its approvers, self-approval or enforcement\) changed/);
    expect(context.store.getGateCaseRequest(id)?.status).toBe("canceled");
    expect(context.store.getEvalFixture(failing)).not.toBeNull();
  });

  it("turning self-approval off after a request makes it stale, and the requester cannot approve it", async () => {
    const context = await createTestContext();
    const { admin, setId } = await dilutionSetup(context, "wf-self", true);
    const lead = await login(context, "builder", "lead");
    const settings = { datasetIds: [setId], enforced: true, policy: { minPassRate: 0.95, maxRegressions: 5 } };
    await putGate(context, admin.cookie, "wf-self", { ...settings, approvers: { approverUsers: [lead.email], allowSelfApproval: true } });
    const late = addCases(context, setId, "self_late", 1);
    const asked = await call(context, "POST", "/api/workflows/wf-self/release-gate/cases/requests", lead.cookie, { action: "admit", fixtureIds: late, reason: "Mine" });
    const id = asked.json<{ request: GateCaseRequestView }>().request.id;
    expect(asked.json<{ request: GateCaseRequestView }>().request.canDecide).toBe(true);

    await putGate(context, admin.cookie, "wf-self", { ...settings, approvers: { approverUsers: [lead.email], allowSelfApproval: false } });
    const own = await call(context, "POST", `/api/approvals/${id}/approve`, lead.cookie, {});
    expect(own.statusCode).toBe(403);
    expect(own.json<{ error: string }>().error).toMatch(/your own request/);
    expect((await casesOf(context, admin.cookie, "wf-self")).counts.pending).toBe(1);
    // A stale request no longer blocks asking again.
    const again = await call(context, "POST", "/api/workflows/wf-self/release-gate/cases/requests", lead.cookie, { action: "admit", fixtureIds: late, reason: "Again" });
    expect(again.statusCode, again.body).toBe(202);
    expect(again.json<{ request: GateCaseRequestView }>().request.id).not.toBe(id);
    expect(context.store.getGateCaseRequest(id)?.status).toBe("canceled");
  });

  it("deleting the workflow cancels its pending gate case requests", async () => {
    const context = await createTestContext();
    const { admin, builder, setId } = await dilutionSetup(context, "wf-gone", true);
    const late = addCases(context, setId, "gone_late", 1);
    const asked = await call(context, "POST", "/api/workflows/wf-gone/release-gate/cases/requests", builder.cookie, { action: "admit", fixtureIds: late, reason: "r" });
    const id = asked.json<{ request: GateCaseRequestView }>().request.id;
    expect((await call(context, "DELETE", "/api/workflows/wf-gone", admin.cookie)).statusCode).toBe(200);
    expect(context.store.getGateCaseRequest(id)).toMatchObject({ status: "canceled", decisionReason: "The workflow was deleted" });
  });
});

describe("every admission change is audited", () => {
  /** Oldest first. */
  const metadataOf = (context: TestContext, eventType: string) =>
    auditLog(context)
      .filter((entry) => entry.eventType === eventType)
      .map((entry) => (entry.metadata ?? {}) as Record<string, unknown>)
      .reverse();

  it("admit, reject, required set and cleared, and approval-driven admit and remove each write an audit row", async () => {
    const context = await createTestContext();
    const { admin, builder, setId, original } = await dilutionSetup(context, "wf-audit", true);
    const late = addCases(context, setId, "audit_late", 3);
    expect((await call(context, "POST", "/api/workflows/wf-audit/release-gate/cases/admit", admin.cookie, { fixtureIds: [late[0]] })).statusCode).toBe(200);
    expect(metadataOf(context, "release.gate.cases_admitted")).toContainEqual(expect.objectContaining({ fixtureIds: [late[0]], requestId: null }));
    expect((await call(context, "POST", "/api/workflows/wf-audit/release-gate/cases/reject", admin.cookie, { fixtureIds: [late[1]] })).statusCode).toBe(200);
    expect(metadataOf(context, "release.gate.cases_rejected")).toContainEqual(expect.objectContaining({ fixtureIds: [late[1]] }));
    expect((await call(context, "PUT", `/api/workflows/wf-audit/release-gate/cases/${original[0]}/required`, admin.cookie, { required: true })).statusCode).toBe(200);
    expect((await call(context, "PUT", `/api/workflows/wf-audit/release-gate/cases/${original[0]}/required`, admin.cookie, { required: false })).statusCode).toBe(200);
    expect(metadataOf(context, "release.gate.case_required").map((entry) => entry.required).sort()).toEqual([false, true]);

    const admitAsk = await call(context, "POST", "/api/workflows/wf-audit/release-gate/cases/requests", builder.cookie, { action: "admit", fixtureIds: [late[2]], reason: "r" });
    expect((await call(context, "POST", `/api/approvals/${admitAsk.json<{ request: GateCaseRequestView }>().request.id}/approve`, admin.cookie, {})).statusCode).toBe(200);
    expect(metadataOf(context, "release.gate.cases_admitted")).toContainEqual(expect.objectContaining({ fixtureIds: [late[2]], requestId: expect.stringMatching(/^gcr_/) }));
    const removeAsk = await call(context, "POST", "/api/workflows/wf-audit/release-gate/cases/requests", builder.cookie, { action: "remove", fixtureIds: [original[1]], reason: "r" });
    expect((await call(context, "POST", `/api/approvals/${removeAsk.json<{ request: GateCaseRequestView }>().request.id}/approve`, admin.cookie, {})).statusCode).toBe(200);
    expect(metadataOf(context, "release.gate.cases_removed")).toContainEqual(expect.objectContaining({ fixtureIds: [original[1]], requestId: expect.stringMatching(/^gcr_/) }));
  });

  it("an admin deleting an admitted or required case, a set, a golden run or the workflow writes release.gate.cases_removed", async () => {
    const context = await createTestContext();
    const { admin, builder, setId, original } = await dilutionSetup(context, "wf-admin-del", true);
    expect((await call(context, "PUT", `/api/workflows/wf-admin-del/release-gate/cases/${original[0]}/required`, admin.cookie, { required: true })).statusCode).toBe(200);

    // The fixture path: a required, admitted case.
    expect((await call(context, "DELETE", `/api/eval/fixtures/${original[0]}`, admin.cookie)).statusCode).toBe(200);
    const fixtureRow = metadataOf(context, "release.gate.cases_removed").find((entry) => entry.via === "fixture");
    expect(fixtureRow).toMatchObject({ via: "fixture", fixtureIds: [original[0]], requiredFixtureIds: [original[0]] });
    expect(fixtureRow?.loosened).toEqual(['removes admitted case "wf-admin-del_orig 1"', 'stops requiring case "wf-admin-del_orig 1"']);
    // A pending case deleted by a builder counts toward nothing: no row.
    const [pending] = addCases(context, setId, "admin_del_pending", 1);
    const before = metadataOf(context, "release.gate.cases_removed").length;
    expect((await call(context, "DELETE", `/api/eval/fixtures/${pending}`, builder.cookie)).statusCode).toBe(200);
    expect(metadataOf(context, "release.gate.cases_removed")).toHaveLength(before);

    // The golden-run path: a real golden run replayed by an admitted case.
    const run = await call(context, "POST", "/api/workflows/wf-admin-del/execute", admin.cookie, {});
    const saved = await call(context, "POST", "/api/replay/recordings", admin.cookie, { executionId: run.json<{ executionId: string }>().executionId, name: "Real golden" });
    const recordingId = saved.json<{ recording: { id: string } }>().recording.id;
    const added = await call(context, "POST", `/api/eval/datasets/${setId}/recordings`, admin.cookie, { recordingId });
    const caseId = added.json<{ fixture: { id: string } }>().fixture.id;
    expect((await call(context, "POST", "/api/workflows/wf-admin-del/release-gate/cases/admit", admin.cookie, { fixtureIds: [caseId] })).statusCode).toBe(200);
    expect((await call(context, "DELETE", `/api/replay/recordings/${recordingId}`, admin.cookie)).statusCode).toBe(200);
    expect(metadataOf(context, "release.gate.cases_removed")).toContainEqual(expect.objectContaining({ via: "golden_run", recordingId, fixtureIds: [caseId] }));

    // The set path names every admitted case it drops.
    expect((await call(context, "DELETE", `/api/eval/datasets/${setId}`, admin.cookie)).statusCode).toBe(200);
    const setRow = metadataOf(context, "release.gate.cases_removed").find((entry) => entry.via === "golden_set");
    expect(setRow).toMatchObject({ via: "golden_set", datasetId: setId });
    expect(setRow?.fixtureIds).toHaveLength(20);
  });

  it("deleting the workflow of an enforced gate audits the admitted cases whose golden runs go with it", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    save(context, labelWorkflow("wf-wipe", "v1"));
    context.store.createEvalDataset({ id: "set-wipe", name: "Golden", workflowId: "wf-wipe" });
    const ids = addCases(context, "set-wipe", "wipe", 2);
    await putGate(context, admin.cookie, "wf-wipe", { datasetIds: ["set-wipe"], enforced: true });
    expect((await call(context, "DELETE", "/api/workflows/wf-wipe", admin.cookie)).statusCode).toBe(200);
    expect(metadataOf(context, "release.gate.cases_removed")).toContainEqual(expect.objectContaining({ via: "workflow", fixtureIds: ids }));
  });

  it("removing a set from the gate names the admitted cases it drops", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    save(context, labelWorkflow("wf-drop", "v1"));
    context.store.createEvalDataset({ id: "set-keep", name: "Keep", workflowId: "wf-drop" });
    context.store.createEvalDataset({ id: "set-drop", name: "Drop", workflowId: "wf-drop" });
    addCases(context, "set-keep", "keep", 1);
    addCases(context, "set-drop", "drop", 1);
    await putGate(context, admin.cookie, "wf-drop", { datasetIds: ["set-keep", "set-drop"], enforced: true });
    await putGate(context, admin.cookie, "wf-drop", { datasetIds: ["set-keep"], enforced: true });
    const updated = auditLog(context).find((entry) => entry.eventType === "release.gate.updated" && ((entry.metadata as Record<string, unknown>).loosened as string[]).length > 0);
    expect((updated?.metadata as Record<string, unknown>).loosened).toEqual(expect.arrayContaining(['removes admitted case "drop 1"']));
  });
});

describe("required cases count only once admitted", () => {
  it("a required mark on a pending case does not block, and a builder may delete that pending case", async () => {
    const context = await createTestContext();
    const { admin, builder, setId, version, hash, statuses, original } = await dilutionSetup(context, "wf-req-pending", true);
    // A required case leaves the gate when its set is dropped, and comes back pending when a builder adds the set again.
    expect((await call(context, "PUT", `/api/workflows/wf-req-pending/release-gate/cases/${original[19]}/required`, admin.cookie, { required: true })).statusCode).toBe(200);
    context.store.createEvalDataset({ id: "set-other", name: "Other", workflowId: "wf-req-pending" });
    addCases(context, "set-other", "other", 1);
    const settings = { policy: { minPassRate: 0.5, maxRegressions: 5 } };
    await putGate(context, admin.cookie, "wf-req-pending", { ...settings, datasetIds: ["set-other"], enforced: true, admitAddedSetCases: true });
    await putGate(context, builder.cookie, "wf-req-pending", { ...settings, datasetIds: ["set-other", setId] });
    const view = await casesOf(context, builder.cookie, "wf-req-pending");
    expect(view.counts).toMatchObject({ admitted: 1, pending: 20, required: 0 });
    expect(view.cases.find((entry) => entry.fixtureId === original[19])).toMatchObject({ admission: "pending", required: false });
    const job = seedJob(context, { workflowId: "wf-req-pending", datasetIds: ["set-other", setId], version, hash, statuses: { ...statuses, other_0: "pass" } });
    const judged = await preview(context, builder.cookie, "wf-req-pending", version, job);
    expect(judged.reasons.join(" ")).not.toMatch(/Required case/);
    expect((await call(context, "DELETE", `/api/eval/fixtures/${original[19]}`, builder.cookie)).statusCode).toBe(200);
  });
});

describe("release requests are judged again when approved", () => {
  it("a request filed while the version passed is refused when an admin has since required a case the job failed", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const approver = await login(context, "builder", "approver");
    save(context, labelWorkflow("wf-rejudge", "v1"));
    context.store.createEvalDataset({ id: "set-rejudge", name: "Golden", workflowId: "wf-rejudge" });
    const ids = addCases(context, "set-rejudge", "rejudge", 10);
    await putGate(context, admin.cookie, "wf-rejudge", {
      datasetIds: ["set-rejudge"],
      enforced: true,
      policy: { minPassRate: 0.8, maxRegressions: 5 },
      requireApproval: true,
      approvers: { approverUsers: [approver.email] }
    });
    const version = save(context, labelWorkflow("wf-rejudge", "v2"));
    const hash = (await preview(context, builder.cookie, "wf-rejudge", version)).workflowHash;
    const job = seedJob(context, { workflowId: "wf-rejudge", datasetIds: ["set-rejudge"], version, hash, statuses: { ...statusesOf(ids.slice(0, 9), "pass"), [ids[9]!]: "fail" } });
    const published = await call(context, "POST", "/api/workflows/wf-rejudge/publish", builder.cookie, { version, replayRunId: job });
    expect(published.statusCode, published.body).toBe(202);
    const requestId = published.json<{ approvalRequestId: string }>().approvalRequestId;

    // The admission changes, not the gate's settings: the request is not stale by its gate timestamp.
    expect((await call(context, "PUT", `/api/workflows/wf-rejudge/release-gate/cases/${ids[9]}/required`, admin.cookie, { required: true })).statusCode).toBe(200);
    const approved = await call(context, "POST", `/api/approvals/${requestId}/approve`, approver.cookie, { reason: "ok" });
    expect(approved.statusCode).toBe(409);
    const body = approved.json<{ error: string; details?: { reasons?: string[] } }>();
    expect(body.error).toMatch(/stale and was canceled\. The release gate now judges version \d+ differently/);
    expect(body.error).toContain('Required case "rejudge 10" failed');
    expect(body.details?.reasons).toEqual(['Required case "rejudge 10" failed: a required case must pass whatever the pass rate.']);
    expect(context.store.getReleaseApprovalRequest(requestId)?.status).toBe("canceled");
    expect(context.store.getPublishedVersion("wf-rejudge")).not.toBe(version);
  });

  it("a request still judged the same is approved and publishes", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const approver = await login(context, "builder", "approver");
    save(context, labelWorkflow("wf-same", "v1"));
    context.store.createEvalDataset({ id: "set-same", name: "Golden", workflowId: "wf-same" });
    const ids = addCases(context, "set-same", "same", 3);
    await putGate(context, admin.cookie, "wf-same", { datasetIds: ["set-same"], enforced: true, requireApproval: true, approvers: { approverUsers: [approver.email] } });
    const version = save(context, labelWorkflow("wf-same", "v2"));
    const hash = (await preview(context, builder.cookie, "wf-same", version)).workflowHash;
    // A failing case still pending admission counts toward nothing, when filed and when approved.
    const [late] = addCases(context, "set-same", "same_late", 1);
    const job = seedJob(context, { workflowId: "wf-same", datasetIds: ["set-same"], version, hash, statuses: { ...statusesOf(ids, "pass"), [late!]: "fail" } });
    const published = await call(context, "POST", "/api/workflows/wf-same/publish", builder.cookie, { version, replayRunId: job });
    expect(published.statusCode, published.body).toBe(202);
    const requestId = published.json<{ approvalRequestId: string }>().approvalRequestId;
    const approved = await call(context, "POST", `/api/approvals/${requestId}/approve`, approver.cookie, {});
    expect(approved.statusCode, approved.body).toBe(200);
    expect(context.store.getPublishedVersion("wf-same")).toBe(version);
  });
});

/**
 * An enforced gate with a release request waiting: 10 admitted golden-run
 * cases, a case `pending` that existed (pending) when the job ran, and a job
 * on version 2 in which `statuses` hold.
 */
async function waitingRequestSetup(
  context: TestContext,
  workflowId: string,
  input: { policy: Record<string, unknown>; statuses: (ids: string[], pending: string) => Record<string, "pass" | "fail" | "error">; requestApproval?: boolean }
) {
  const admin = await login(context, "admin");
  const builder = await login(context, "builder");
  const approver = await login(context, "builder", "approver");
  save(context, labelWorkflow(workflowId, "v1"));
  const setId = `set-${workflowId}`;
  context.store.createEvalDataset({ id: setId, name: "Golden", workflowId });
  const ids = addCases(context, setId, `${workflowId}_case`, 10);
  const settings = { datasetIds: [setId], enforced: true, policy: input.policy, requireApproval: !input.requestApproval, approvers: { approverUsers: [approver.email] } };
  await putGate(context, admin.cookie, workflowId, settings);
  const [pending] = addCases(context, setId, `${workflowId}_pending`, 1);
  const version = save(context, labelWorkflow(workflowId, "v2"));
  const hash = (await preview(context, builder.cookie, workflowId, version)).workflowHash;
  const job = seedJob(context, { workflowId, datasetIds: [setId], version, hash, statuses: input.statuses(ids, pending!) });
  const published = await call(context, "POST", `/api/workflows/${workflowId}/publish`, builder.cookie, {
    version,
    replayRunId: job,
    ...(input.requestApproval ? { requestApproval: { reason: "Known flaky cases" } } : {})
  });
  expect(published.statusCode, published.body).toBe(202);
  const requestId = published.json<{ approvalRequestId: string }>().approvalRequestId;
  return { admin, builder, approver, setId, ids, pending: pending!, version, hash, job, requestId, settings };
}

describe("on an enforced gate only admitted cases can make a job stale", () => {
  it("a builder adding a hand-written case and a golden-run case, then deleting a pending case, leaves the release request publishable", async () => {
    const context = await createTestContext();
    const setup = await waitingRequestSetup(context, "wf-pending-churn", { policy: { minPassRate: 0.9 }, statuses: (ids, pending) => ({ ...statusesOf(ids, "pass"), [pending]: "fail" }) });
    const handWritten = await call(context, "POST", `/api/eval/datasets/${setup.setId}/fixtures`, setup.builder.cookie, { name: "Hand-written", input: {} });
    expect(handWritten.statusCode, handWritten.body).toBe(200);
    addCases(context, setup.setId, "churn_late", 1);
    expect((await call(context, "DELETE", `/api/eval/fixtures/${setup.pending}`, setup.builder.cookie)).statusCode).toBe(200);

    const judged = await preview(context, setup.builder.cookie, "wf-pending-churn", setup.version, setup.job);
    expect(judged.reasons.join(" ")).not.toMatch(/changed after replay job/);
    const approved = await call(context, "POST", `/api/approvals/${setup.requestId}/approve`, setup.approver.cookie, {});
    expect(approved.statusCode, approved.body).toBe(200);
    expect(context.store.getPublishedVersion("wf-pending-churn")).toBe(setup.version);
  });

  it("an admin admitting a case added after the job makes the job stale, and the release request is refused", async () => {
    const context = await createTestContext();
    const setup = await waitingRequestSetup(context, "wf-admit-late", { policy: { minPassRate: 0.9 }, statuses: (ids, pending) => ({ ...statusesOf(ids, "pass"), [pending]: "pass" }) });
    const [late] = addCases(context, setup.setId, "admit_late", 1);
    // Admitting a case the job did run changes nothing about staleness.
    expect((await call(context, "POST", "/api/workflows/wf-admit-late/release-gate/cases/admit", setup.admin.cookie, { fixtureIds: [setup.pending] })).statusCode).toBe(200);
    expect((await preview(context, setup.builder.cookie, "wf-admit-late", setup.version, setup.job)).reasons.join(" ")).not.toMatch(/changed after replay job/);
    expect((await call(context, "POST", "/api/workflows/wf-admit-late/release-gate/cases/admit", setup.admin.cookie, { fixtureIds: [late] })).statusCode).toBe(200);

    const judged = await preview(context, setup.builder.cookie, "wf-admit-late", setup.version, setup.job);
    expect(judged.verdict).toBe("blocked");
    expect(judged.reasons.join(" ")).toMatch(/changed after replay job .* was queued/);
    const approved = await call(context, "POST", `/api/approvals/${setup.requestId}/approve`, setup.approver.cookie, {});
    expect(approved.statusCode).toBe(409);
    expect(approved.json<{ details?: { reasons?: string[] } }>().details?.reasons?.join(" ")).toMatch(/changed after replay job/);
    expect(context.store.getReleaseApprovalRequest(setup.requestId)?.status).toBe("canceled");
  });

  it("changing the golden run an admitted case replays makes the job stale", async () => {
    const context = await createTestContext();
    const setup = await waitingRequestSetup(context, "wf-rerecord", { policy: { minPassRate: 0.9 }, statuses: (ids) => statusesOf(ids, "pass") });
    const target = context.store.getEvalFixture(setup.ids[0]!)!;
    context.store.deleteEvalFixture(target.id);
    context.store.createEvalFixture({ id: target.id, datasetId: setup.setId, name: target.name, input: {}, recordingId: "rec_rerecorded" });
    const judged = await preview(context, setup.builder.cookie, "wf-rerecord", setup.version, setup.job);
    expect(judged.verdict).toBe("blocked");
    expect(judged.reasons.join(" ")).toMatch(/changed after replay job/);
  });

  it("on an unenforced gate adding any case still makes earlier jobs stale", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    save(context, labelWorkflow("wf-loose", "v1"));
    context.store.createEvalDataset({ id: "set-loose", name: "Golden", workflowId: "wf-loose" });
    const ids = addCases(context, "set-loose", "loose", 3);
    await putGate(context, admin.cookie, "wf-loose", { datasetIds: ["set-loose"], policy: { minPassRate: 0.5 } });
    const version = save(context, labelWorkflow("wf-loose", "v2"));
    const hash = (await preview(context, builder.cookie, "wf-loose", version)).workflowHash;
    const job = seedJob(context, { workflowId: "wf-loose", datasetIds: ["set-loose"], version, hash, statuses: statusesOf(ids, "pass") });
    expect((await preview(context, builder.cookie, "wf-loose", version, job)).verdict).toBe("passed");
    expect((await call(context, "POST", "/api/eval/datasets/set-loose/fixtures", builder.cookie, { name: "Later", input: {} })).statusCode).toBe(200);
    const judged = await preview(context, builder.cookie, "wf-loose", version, job);
    expect(judged.verdict).toBe("blocked");
    expect(judged.reasons.join(" ")).toMatch(/changed after replay job/);
  });

  it("a job queued before per-case fingerprints keeps the whole-set rule", async () => {
    const context = await createTestContext();
    const setup = await waitingRequestSetup(context, "wf-legacy-snap", { policy: { minPassRate: 0.9 }, statuses: (ids) => statusesOf(ids, "pass") });
    const current = goldenSetSnapshots([setup.setId], (datasetId) => context.store.listEvalFixtures(datasetId));
    // The 15.4 form: set id -> hash only.
    (context.store as unknown as { exec(sql: string, params: unknown[]): void }).exec(`UPDATE eval_runs SET set_snapshot_json = ? WHERE id = ?`, [
      JSON.stringify({ [setup.setId]: current[setup.setId]!.hash }),
      setup.job
    ]);
    expect(context.store.getEvalRunSetSnapshot(setup.job)).toEqual({ [setup.setId]: { hash: current[setup.setId]!.hash, cases: null } });
    expect((await preview(context, setup.builder.cookie, "wf-legacy-snap", setup.version, setup.job)).reasons.join(" ")).not.toMatch(/changed after replay job/);
    addCases(context, setup.setId, "legacy_late", 1);
    expect((await preview(context, setup.builder.cookie, "wf-legacy-snap", setup.version, setup.job)).reasons.join(" ")).toMatch(/changed after replay job/);
  });
});

describe("only admin-only changes make gate case requests stale", () => {
  it("a builder's unchanged save and a builder's tightening leave an open request approvable, and an unchanged save leaves the gate's timestamp alone", async () => {
    const context = await createTestContext();
    const { admin, builder, setId } = await dilutionSetup(context, "wf-builder-save", true);
    const lead = await login(context, "builder", "lead");
    const settings = { datasetIds: [setId], enforced: true, policy: { minPassRate: 0.95, maxRegressions: 5 }, approvers: { approverUsers: [lead.email] } };
    const gate = await putGate(context, admin.cookie, "wf-builder-save", settings);
    const late = addCases(context, setId, "save_late", 2);
    const asked = await call(context, "POST", "/api/workflows/wf-builder-save/release-gate/cases/requests", builder.cookie, { action: "admit", fixtureIds: [late[0]], reason: "Reviewed" });
    expect(asked.statusCode, asked.body).toBe(202);
    const first = asked.json<{ request: GateCaseRequestView }>().request.id;
    const second = (await call(context, "POST", "/api/workflows/wf-builder-save/release-gate/cases/requests", builder.cookie, { action: "admit", fixtureIds: [late[1]], reason: "Reviewed" })).json<{
      request: GateCaseRequestView;
    }>().request.id;

    const unchanged = await putGate(context, builder.cookie, "wf-builder-save", settings);
    expect(unchanged.updatedAt).toBe(gate.updatedAt);
    expect(auditLog(context).find((entry) => entry.eventType === "release.gate.updated")?.metadata).toMatchObject({ settingsUnchanged: true });
    const tightened = await putGate(context, builder.cookie, "wf-builder-save", { ...settings, policy: { minPassRate: 0.97, maxRegressions: 5 } });
    expect(tightened.updatedAt).not.toBe(gate.updatedAt);

    const inbox = (await call(context, "GET", "/api/approvals", lead.cookie)).json<{ items: GateCaseRequestView[] }>().items.find((entry) => entry.id === first);
    expect(inbox).toMatchObject({ canDecide: true });
    const approved = await call(context, "POST", `/api/approvals/${first}/approve`, lead.cookie, {});
    expect(approved.statusCode, approved.body).toBe(200);
    expect(context.store.getGateCaseRequest(first)?.status).toBe("approved");

    // An admin changing who decides makes the other one stale.
    await putGate(context, admin.cookie, "wf-builder-save", { ...settings, policy: { minPassRate: 0.97, maxRegressions: 5 }, approvers: { approverUsers: [lead.email, admin.email] } });
    const stale = await call(context, "POST", `/api/approvals/${second}/approve`, lead.cookie, {});
    expect(stale.statusCode).toBe(409);
    expect(context.store.getGateCaseRequest(second)?.status).toBe("canceled");
  });

  it("a builder's unchanged save leaves a pending release request publishable", async () => {
    const context = await createTestContext();
    const setup = await waitingRequestSetup(context, "wf-noop-release", { policy: { minPassRate: 0.9 }, statuses: (ids) => statusesOf(ids, "pass") });
    await putGate(context, setup.builder.cookie, "wf-noop-release", setup.settings);
    const approved = await call(context, "POST", `/api/approvals/${setup.requestId}/approve`, setup.approver.cookie, {});
    expect(approved.statusCode, approved.body).toBe(200);
  });
});

describe("release requests are re-judged by reason codes, not wording", () => {
  it("better numbers and a case waiting for admission do not cancel a request filed while blocked; a worse measure does", async () => {
    const context = await createTestContext();
    // 8 of 10 admitted pass (80% against 90%), and the gate wants 20 cases: blocked for two reasons.
    const setup = await waitingRequestSetup(context, "wf-codes", {
      policy: { minPassRate: 0.9, minCases: 20, maxRegressions: 5 },
      statuses: (ids, pending) => ({ ...statusesOf(ids.slice(0, 8), "pass"), ...statusesOf(ids.slice(8), "fail"), [pending]: "pass" }),
      requestApproval: true
    });
    const request = context.store.getReleaseApprovalRequest(setup.requestId)!;
    expect(request.origin).toBe("blocked");
    expect(request.gateChecks?.map((check) => check.code)).toEqual(["min_cases", "pass_rate"]);
    expect(request.gateReasons.join(" ")).not.toMatch(/waiting for admission/);

    // A builder adds a case (pending); an admin admits the passing case the job ran: 9 of 11, still blocked, but better.
    addCases(context, setup.setId, "codes_late", 1);
    expect((await call(context, "POST", "/api/workflows/wf-codes/release-gate/cases/admit", setup.admin.cookie, { fixtureIds: [setup.pending] })).statusCode).toBe(200);
    const judged = await preview(context, setup.builder.cookie, "wf-codes", setup.version, setup.job);
    expect(judged.verdict).toBe("blocked");
    expect(judged.reasons).not.toEqual(request.gateReasons);
    const approved = await call(context, "POST", `/api/approvals/${setup.requestId}/approve`, setup.approver.cookie, {});
    expect(approved.statusCode, approved.body).toBe(200);
  });

  it("a request filed while blocked is canceled when an admin's change makes the same reason worse", async () => {
    const context = await createTestContext();
    const setup = await waitingRequestSetup(context, "wf-codes-worse", {
      policy: { minPassRate: 0.9, maxRegressions: 5 },
      statuses: (ids, pending) => ({ ...statusesOf(ids.slice(0, 8), "pass"), ...statusesOf(ids.slice(8), "fail"), [pending]: "fail" }),
      requestApproval: true
    });
    // Admitting the failing case the job ran: 8 of 11, a lower pass rate.
    expect((await call(context, "POST", "/api/workflows/wf-codes-worse/release-gate/cases/admit", setup.admin.cookie, { fixtureIds: [setup.pending] })).statusCode).toBe(200);
    const approved = await call(context, "POST", `/api/approvals/${setup.requestId}/approve`, setup.approver.cookie, {});
    expect(approved.statusCode).toBe(409);
    expect(approved.json<{ details?: { reasons?: string[] } }>().details?.reasons?.join(" ")).toMatch(/Pass rate 72.7%/);
  });
});

describe("release requests go stale by who decides, and are judged again for the rest", () => {
  const approve = (context: TestContext, requestId: string, cookie: string) => call(context, "POST", `/api/approvals/${requestId}/approve`, cookie, {});

  it("a builder's tightening that the job still meets leaves a policy-filed request publishable", async () => {
    const context = await createTestContext();
    const setup = await waitingRequestSetup(context, "wf-tighten-ok", { policy: { minPassRate: 0.5 }, statuses: (ids) => statusesOf(ids, "pass") });
    const tightened = await putGate(context, setup.builder.cookie, "wf-tighten-ok", { ...setup.settings, policy: { minPassRate: 0.9 } });
    expect(tightened.policy.minPassRate).toBe(0.9);
    expect(context.store.getReleaseApprovalRequest(setup.requestId)?.gateAuthority).toBeTruthy();
    const approved = await approve(context, setup.requestId, setup.approver.cookie);
    expect(approved.statusCode, approved.body).toBe(200);
    expect(context.store.getPublishedVersion("wf-tighten-ok")).toBe(setup.version);
  });

  it("a builder's tightening that the job fails cancels the request with the reasons", async () => {
    const context = await createTestContext();
    const setup = await waitingRequestSetup(context, "wf-tighten-bad", {
      policy: { minPassRate: 0.5, maxRegressions: 5 },
      statuses: (ids) => ({ ...statusesOf(ids.slice(0, 8), "pass"), ...statusesOf(ids.slice(8), "fail") })
    });
    await putGate(context, setup.builder.cookie, "wf-tighten-bad", { ...setup.settings, policy: { minPassRate: 0.95, maxRegressions: 5 } });
    const refused = await approve(context, setup.requestId, setup.approver.cookie);
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ details?: { reasons?: string[] } }>().details?.reasons?.join(" ")).toMatch(/Pass rate 80%/);
    expect(context.store.getReleaseApprovalRequest(setup.requestId)?.status).toBe("canceled");
  });

  it("a builder adding a set of pending cases leaves the request publishable; once an admin admits one of its cases it is refused", async () => {
    const context = await createTestContext();
    const setup = await waitingRequestSetup(context, "wf-add-set", { policy: { minPassRate: 0.9 }, statuses: (ids) => statusesOf(ids, "pass") });
    context.store.createEvalDataset({ id: "set-added", name: "Added", workflowId: "wf-add-set" });
    const added = addCases(context, "set-added", "added", 2);
    await putGate(context, setup.builder.cookie, "wf-add-set", { ...setup.settings, datasetIds: [setup.setId, "set-added"] });
    const before = await preview(context, setup.builder.cookie, "wf-add-set", setup.version, setup.job);
    expect(before.reasons.join(" ")).not.toMatch(/did not cover|changed after replay job/);

    expect((await call(context, "POST", "/api/workflows/wf-add-set/release-gate/cases/admit", setup.admin.cookie, { fixtureIds: [added[0]] })).statusCode).toBe(200);
    const after = await preview(context, setup.builder.cookie, "wf-add-set", setup.version, setup.job);
    expect(after.verdict).toBe("blocked");
    expect(after.reasons.join(" ")).toMatch(/did not cover/);
    const refused = await approve(context, setup.requestId, setup.approver.cookie);
    expect(refused.statusCode).toBe(409);
    expect(context.store.getReleaseApprovalRequest(setup.requestId)?.status).toBe("canceled");
  });

  it("an admin's approver change makes the request stale", async () => {
    const context = await createTestContext();
    const setup = await waitingRequestSetup(context, "wf-approver-change", { policy: { minPassRate: 0.9 }, statuses: (ids) => statusesOf(ids, "pass") });
    await putGate(context, setup.admin.cookie, "wf-approver-change", { ...setup.settings, approvers: { approverUsers: [setup.approver.email, setup.admin.email] } });
    const stale = await approve(context, setup.requestId, setup.approver.cookie);
    expect(stale.statusCode).toBe(409);
    expect(stale.json<{ error: string }>().error).toMatch(/Who may approve this release/);
    expect(context.store.getReleaseApprovalRequest(setup.requestId)?.status).toBe("canceled");
  });

  it("a request made before the fingerprint existed keeps the timestamp rule", async () => {
    const context = await createTestContext();
    const setup = await waitingRequestSetup(context, "wf-legacy-authority", { policy: { minPassRate: 0.5 }, statuses: (ids) => statusesOf(ids, "pass") });
    (context.store as unknown as { exec(sql: string, params: unknown[]): void }).exec(`UPDATE release_approval_requests SET gate_authority = NULL WHERE id = ?`, [setup.requestId]);
    await putGate(context, setup.builder.cookie, "wf-legacy-authority", { ...setup.settings, policy: { minPassRate: 0.6 } });
    const stale = await approve(context, setup.requestId, setup.approver.cookie);
    expect(stale.statusCode).toBe(409);
    expect(stale.json<{ error: string }>().error).toMatch(/settings changed/);
  });

  it("a request filed on one stale set is canceled when an admin's admission makes another set stale too", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const approver = await login(context, "builder", "approver");
    save(context, labelWorkflow("wf-two-sets", "v1"));
    context.store.createEvalDataset({ id: "set-two-a", name: "A", workflowId: "wf-two-sets" });
    context.store.createEvalDataset({ id: "set-two-b", name: "B", workflowId: "wf-two-sets" });
    const a = addCases(context, "set-two-a", "two_a", 3);
    const b = addCases(context, "set-two-b", "two_b", 3);
    await putGate(context, admin.cookie, "wf-two-sets", { datasetIds: ["set-two-a", "set-two-b"], enforced: true, policy: { minPassRate: 0.5 }, approvers: { approverUsers: [approver.email] } });
    const version = save(context, labelWorkflow("wf-two-sets", "v2"));
    const hash = (await preview(context, builder.cookie, "wf-two-sets", version)).workflowHash;
    const job = seedJob(context, { workflowId: "wf-two-sets", datasetIds: ["set-two-a", "set-two-b"], version, hash, statuses: statusesOf([...a, ...b], "pass") });
    // Set A's admitted case now replays another golden run: the job is stale for A.
    const target = context.store.getEvalFixture(a[0]!)!;
    context.store.deleteEvalFixture(target.id);
    context.store.createEvalFixture({ id: target.id, datasetId: "set-two-a", name: target.name, input: {}, recordingId: "rec_rerecorded" });
    const published = await call(context, "POST", "/api/workflows/wf-two-sets/publish", builder.cookie, { version, replayRunId: job, requestApproval: { reason: "Known" } });
    expect(published.statusCode, published.body).toBe(202);
    const requestId = published.json<{ approvalRequestId: string }>().approvalRequestId;
    expect(context.store.getReleaseApprovalRequest(requestId)?.gateChecks?.map((check) => check.code)).toEqual(["stale_sets:set-two-a"]);

    // An admin admits a case in set B that the job never ran: B is stale as well, a new reason.
    const [late] = addCases(context, "set-two-b", "two_b_late", 1);
    expect((await call(context, "POST", "/api/workflows/wf-two-sets/release-gate/cases/admit", admin.cookie, { fixtureIds: [late] })).statusCode).toBe(200);
    const refused = await approve(context, requestId, approver.cookie);
    expect(refused.statusCode).toBe(409);
    expect(context.store.getReleaseApprovalRequest(requestId)?.status).toBe("canceled");
  });
});
