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

    // An admin adding a set admits its cases.
    const second = await call(context, "POST", "/api/eval/datasets/import", builder.cookie, { file, workflowId: "wf-paths", name: "Imported by admin" });
    const secondId = second.json<{ dataset: { id: string } }>().dataset.id;
    await putGate(context, admin.cookie, "wf-paths", { datasetIds: [setId, importedId, secondId], enforced: true });
    expect((await casesOf(context, builder.cookie, "wf-paths")).counts).toEqual({ admitted: 5, pending: 5, required: 0 });
    // Lifting enforcement drops the admission state; enforcing again admits everything the sets hold.
    await putGate(context, admin.cookie, "wf-paths", { datasetIds: [setId, importedId, secondId], enforced: false });
    expect(context.store.getReleaseGate("wf-paths")?.admittedFixtureIds).toBeNull();
    await putGate(context, admin.cookie, "wf-paths", { datasetIds: [setId, importedId, secondId], enforced: true });
    expect((await casesOf(context, builder.cookie, "wf-paths")).counts).toEqual({ admitted: 10, pending: 0, required: 0 });
  });
});

describe("migration 36", () => {
  it("adds the columns and table in SQLite and Postgres (with a down path), and admits every case of a gate enforced before it so old jobs judge the same", async () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 36)!;
    expect(migration.up).toMatch(/ALTER TABLE eval_fixtures ADD COLUMN IF NOT EXISTS required INTEGER NOT NULL DEFAULT 0/);
    expect(migration.up).toMatch(/CREATE TABLE IF NOT EXISTS gate_case_requests/);
    expect(migration.up).toMatch(/UPDATE release_gates g/);
    expect(migration.down).toMatch(/DROP TABLE IF EXISTS gate_case_requests/);
    expect(migration.down).toMatch(/ALTER TABLE eval_fixtures DROP COLUMN IF EXISTS required/);

    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    save(context, labelWorkflow("wf-old", "v1"));
    context.store.createEvalDataset({ id: "set-old", name: "Golden", workflowId: "wf-old" });
    const ids = addCases(context, "set-old", "old", 3);
    await putGate(context, admin.cookie, "wf-old", { datasetIds: ["set-old"], enforced: true });
    const version = save(context, labelWorkflow("wf-old", "v2"));
    const hash = (await preview(context, builder.cookie, "wf-old", version)).workflowHash;
    const job = seedJob(context, { workflowId: "wf-old", datasetIds: ["set-old"], version, hash, statuses: statusesOf(ids, "pass") });
    // As a gate enforced before migration 36 left it: no admission state.
    const raw = new Database(context.dbPath);
    raw.prepare("UPDATE release_gates SET admitted_fixture_ids_json = NULL WHERE workflow_id = ?").run("wf-old");
    raw.close();
    expect(context.store.getReleaseGate("wf-old")?.admittedFixtureIds).toBeNull();
    // Without a stored admission the gate counts every case, as before.
    expect((await preview(context, builder.cookie, "wf-old", version, job)).verdict).toBe("passed");
    await context.app.close();
    context.store.close();

    const reopened = await SqliteStore.create(context.dbPath);
    try {
      expect(reopened.getReleaseGate("wf-old")?.admittedFixtureIds).toEqual([...ids].sort());
      expect(reopened.listEvalFixtures("set-old").every((fixture) => fixture.required === false)).toBe(true);
      const columns = (reopened as unknown as { queryAll: (sql: string) => Array<{ name: string }> }).queryAll("PRAGMA table_info(gate_case_requests)").map((row) => row.name);
      expect(columns).toEqual(expect.arrayContaining(["id", "workflow_id", "action", "fixtures_json", "status"]));
    } finally {
      reopened.close();
    }
    contexts.splice(contexts.indexOf(context), 1);
    fs.rmSync(context.tempDir, { recursive: true, force: true });
  });
});
