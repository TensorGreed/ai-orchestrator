/**
 * Phase 13.1 — store contract: release gates, publishing, releases, release approval requests, gate admission and
 * gate case requests, eval run-set snapshots and the channel a run ran on. The same assertions on SQLite and, with
 * TEST_POSTGRES_URL, on Postgres.
 */
import { expect, it } from "vitest";
import { describeStoreContract } from "../../test-support/test-store.js";
import type { Store } from "../store.js";
import type { GateCaseRequestRecord, ReleaseApprovalRequestRecord, ReleaseGateRecord } from "../database.js";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const at = (offsetMs: number) => new Date(Date.UTC(2026, 9, 26, 8, 0, 0) + offsetMs).toISOString();

async function workflow(store: Store, id: string): Promise<void> {
  await store.upsertWorkflow({ id, name: `Workflow ${id}`, schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [] } as never);
}

/** A workflow with `count` saved versions (1..count). */
async function workflowWithVersions(store: Store, id: string, count: number): Promise<void> {
  await workflow(store, id);
  for (let index = 0; index < count; index += 1) {
    await store.appendWorkflowVersion({ id: `${id}-v${index + 1}`, workflowId: id, workflowJson: JSON.stringify({ id, n: index }), retention: 0 });
  }
}

function gate(workflowId: string, overrides: Partial<ReleaseGateRecord> = {}): ReleaseGateRecord {
  return {
    workflowId,
    enabled: true,
    enforced: false,
    datasetIds: ["set-a"],
    candidateOptions: { maxCases: 5 },
    policy: { minPassRate: 0.9 },
    requireApproval: false,
    approvers: null,
    updatedAt: at(0),
    updatedBy: "ana",
    ...overrides
  };
}

function release(workflowId: string, id: string, version: number, overrides: Partial<{ workflowHash: string; publishedAt: string }> = {}) {
  return {
    id,
    workflowId,
    version,
    workflowHash: overrides.workflowHash ?? `hash-${version}`,
    replayRunId: null,
    verdict: "pass",
    reason: null,
    gateReasons: ["ok"],
    approval: null,
    publishedAt: overrides.publishedAt ?? at(version * 1000),
    publishedBy: "ana",
    publishedByUserId: "u-ana"
  };
}

function releaseRequest(id: string, overrides: Partial<ReleaseApprovalRequestRecord> = {}): ReleaseApprovalRequestRecord {
  return {
    id,
    workflowId: "wf-1",
    workflowName: "Workflow wf-1",
    projectId: "default",
    version: 1,
    workflowHash: "hash-1",
    replayRunId: "run-1",
    origin: "policy",
    gateReasons: ["needs approval"],
    gateUpdatedAt: at(0),
    gateChecks: [{ code: "pass_rate", measure: 0.5 }],
    gateAuthority: "auth-1",
    publishedVersionAtRequest: null,
    spec: { approvers: ["bo"] },
    status: "pending",
    requestReason: "ship it",
    requestedByUserId: "u-ana",
    requestedBy: "ana",
    expiresAt: null,
    decidedByUserId: null,
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    releaseId: null,
    createdAt: at(0),
    updatedAt: at(0),
    ...overrides
  };
}

function caseRequest(id: string, overrides: Partial<GateCaseRequestRecord> = {}): GateCaseRequestRecord {
  return {
    id,
    workflowId: "wf-1",
    workflowName: "Workflow wf-1",
    projectId: "default",
    action: "admit",
    fixtures: [{ fixtureId: "fx-1", name: "Case 1", datasetId: "set-a" }],
    spec: { approvers: ["bo"] },
    gateAuthority: "auth-1",
    status: "pending",
    requestReason: null,
    requestedByUserId: "u-ana",
    requestedBy: "ana",
    expiresAt: null,
    decidedByUserId: null,
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    createdAt: at(0),
    updatedAt: at(0),
    ...overrides
  };
}

describeStoreContract("store contract: release gates and publishing", (ctx) => {
  it("a release gate round-trips with booleans, JSON and no admission; only enabled gates are listed", async () => {
    const store = ctx.store();
    expect(await store.getReleaseGate("wf-1")).toBeNull();
    const saved = await store.upsertReleaseGate(gate("wf-1", { approvers: { users: ["bo"] }, requireApproval: true }));
    expect(saved).toEqual({
      ...gate("wf-1", { approvers: { users: ["bo"] }, requireApproval: true }),
      admittedFixtureIds: null,
      admissionUpdatedAt: null,
      admissionUpdatedBy: null
    });
    await store.upsertReleaseGate(gate("wf-2", { enabled: false }));
    expect(await store.listEnabledReleaseGateWorkflowIds()).toEqual(["wf-1"]);
    const updated = await store.upsertReleaseGate(gate("wf-1", { enforced: true, updatedAt: at(5000), updatedBy: "bo" }));
    expect(updated).toMatchObject({ enforced: true, requireApproval: false, approvers: null, updatedAt: at(5000), updatedBy: "bo" });
  });

  it("gate admission is stored deduplicated and sorted, cleared with null, and leaves the gate's updatedAt alone", async () => {
    const store = ctx.store();
    await store.upsertReleaseGate(gate("wf-1"));
    await store.setReleaseGateAdmission("wf-1", ["fx-b", "fx-a", "fx-b"], at(9000), "bo");
    expect(await store.getReleaseGate("wf-1")).toMatchObject({ admittedFixtureIds: ["fx-a", "fx-b"], admissionUpdatedAt: at(9000), admissionUpdatedBy: "bo", updatedAt: at(0) });
    // An upsert keeps the admission (upsertReleaseGate never writes it).
    await store.upsertReleaseGate(gate("wf-1", { updatedAt: at(10_000) }));
    expect((await store.getReleaseGate("wf-1"))?.admittedFixtureIds).toEqual(["fx-a", "fx-b"]);
    await store.setReleaseGateAdmission("wf-1", null, at(11_000), null);
    expect(await store.getReleaseGate("wf-1")).toMatchObject({ admittedFixtureIds: null, admissionUpdatedAt: at(11_000), admissionUpdatedBy: null });
  });

  it("saveReleaseGate is a compare-and-set on the stored gate and saves the admission with it", async () => {
    const store = ctx.store();
    const created = await store.saveReleaseGate({ gate: gate("wf-1"), expected: null, updatedAt: at(0), updatedBy: "ana" });
    expect(created).toMatchObject({ workflowId: "wf-1", enabled: true });
    // A second create from "nothing there" is refused.
    expect(await store.saveReleaseGate({ gate: gate("wf-1", { updatedBy: "bo" }), expected: null, updatedAt: at(0), updatedBy: "bo" })).toBeNull();
    const current = (await store.getReleaseGate("wf-1"))!;
    const saved = await store.saveReleaseGate({
      gate: gate("wf-1", { enforced: true, updatedAt: at(1000), updatedBy: "bo" }),
      admittedFixtureIds: ["fx-2", "fx-1"],
      expected: current,
      updatedAt: at(1000),
      updatedBy: "bo"
    });
    expect(saved).toMatchObject({ enforced: true, updatedBy: "bo" });
    expect(await store.getReleaseGate("wf-1")).toMatchObject({ admittedFixtureIds: ["fx-1", "fx-2"], admissionUpdatedAt: at(1000), admissionUpdatedBy: "bo" });
    // A stale `expected` is refused and changes nothing.
    expect(await store.saveReleaseGate({ gate: gate("wf-1", { enabled: false }), expected: current, updatedAt: at(2000), updatedBy: "cy" })).toBeNull();
    expect((await store.getReleaseGate("wf-1"))?.enabled).toBe(true);
    // gate: null with a matching expected saves only the admission and answers the current gate.
    const now = (await store.getReleaseGate("wf-1"))!;
    const kept = await store.saveReleaseGate({ gate: null, admittedFixtureIds: ["fx-1"], expected: now, updatedAt: at(3000), updatedBy: "cy" });
    expect(kept?.workflowId).toBe("wf-1");
    expect((await store.getReleaseGate("wf-1"))?.admittedFixtureIds).toEqual(["fx-1"]);
    expect(await store.saveReleaseGate({ gate: null, expected: null, updatedAt: at(0), updatedBy: null })).toBeNull();
  });

  it("publishes a version once from the expected previous one, pins it and records the release", async () => {
    const store = ctx.store();
    await workflowWithVersions(store, "wf-1", 3);
    expect(await store.getPublishedVersion("wf-1")).toBeNull();
    expect(await store.getPublishedVersion("missing")).toBeNull();
    expect(await store.isWorkflowVersionPinned("wf-1", 1)).toBe(false);

    const first = await store.publishWorkflowVersion(release("wf-1", "rel-1", 1), null);
    expect(first).toEqual({ ...release("wf-1", "rel-1", 1), previousVersion: null });
    expect(await store.getPublishedVersion("wf-1")).toBe(1);
    expect(await store.isWorkflowVersionPinned("wf-1", 1)).toBe(true);

    // Expected previous no longer matches: refused, nothing changes.
    expect(await store.publishWorkflowVersion(release("wf-1", "rel-x", 2), null)).toBeNull();
    // A version that does not exist: refused.
    expect(await store.publishWorkflowVersion(release("wf-1", "rel-y", 9), 1)).toBeNull();
    expect(await store.getPublishedVersion("wf-1")).toBe(1);
    expect(await store.isWorkflowVersionPinned("wf-1", 2)).toBe(false);

    const second = await store.publishWorkflowVersion(release("wf-1", "rel-2", 3), 1);
    expect(second?.previousVersion).toBe(1);
    // A rollback to 1 under a second hash.
    await store.publishWorkflowVersion(release("wf-1", "rel-3", 1, { workflowHash: "hash-1b", publishedAt: at(9000) }), 3);

    const releases = await store.listWorkflowReleases("wf-1");
    expect(releases.map((entry) => entry.id)).toEqual(["rel-3", "rel-2", "rel-1"]);
    expect(releases[2]).toEqual({ ...release("wf-1", "rel-1", 1), previousVersion: null });
    expect(releases[2]!.publishedAt).toMatch(ISO);
    expect((await store.listWorkflowReleases("wf-1", 1)).map((entry) => entry.id)).toEqual(["rel-3"]);
    expect(await store.hasReleasedVersion("wf-1", 1)).toBe(true);
    expect(await store.hasReleasedVersion("wf-1", 2)).toBe(false);
    expect((await store.listReleasedVersionHashes("wf-1", 1)).sort()).toEqual(["hash-1", "hash-1b"]);
    expect(await store.listReleasedVersionHashes("wf-1", 2)).toEqual([]);
  });

  it("the channel and version a run ran on round-trip; a run with none answers null", async () => {
    const store = ctx.store();
    await workflow(store, "wf-1");
    await store.saveExecutionHistory({ id: "ex-1", workflowId: "wf-1", status: "success", startedAt: at(0) });
    await store.saveExecutionHistory({ id: "ex-2", workflowId: "wf-1", status: "success", startedAt: at(0) });
    expect(await store.getExecutionRelease("ex-1")).toBeNull();
    expect(await store.getExecutionRelease("missing")).toBeNull();
    await store.setExecutionRelease("ex-1", "production", 4);
    await store.setExecutionRelease("ex-2", "draft", null);
    expect(await store.getExecutionRelease("ex-1")).toEqual({ channel: "production", version: 4 });
    expect(await store.getExecutionRelease("ex-2")).toEqual({ channel: "draft", version: null });
  });

  it("a replay job's set snapshot round-trips (old hash-only entries read as cases: null); release proof skips simulation jobs", async () => {
    const store = ctx.store();
    await store.createEvalRun({ id: "run-old", datasetId: "set-a", workflowId: "wf-1", kind: "replay", status: "completed", workflowHash: "h1" });
    expect(await store.getEvalRunSetSnapshot("run-old")).toBeNull();
    await store.setEvalRunSetSnapshot("run-old", { "set-a": { hash: "sa", cases: { "fx-1": "f1" } }, "set-b": { hash: "sb", cases: null } });
    expect(await store.getEvalRunSetSnapshot("run-old")).toEqual({ "set-a": { hash: "sa", cases: { "fx-1": "f1" } }, "set-b": { hash: "sb", cases: null } });
    await store.setEvalRunSetSnapshot("run-old", { "set-a": "legacy" } as never);
    expect(await store.getEvalRunSetSnapshot("run-old")).toEqual({ "set-a": { hash: "legacy", cases: null } });
    expect(await store.getEvalRunSetSnapshot("missing")).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.createEvalRun({ id: "run-new", datasetId: "set-a", workflowId: "wf-1", kind: "replay", status: "completed", workflowHash: "h1" });
    await store.createEvalRun({ id: "run-running", datasetId: "set-a", workflowId: "wf-1", kind: "replay", status: "running", workflowHash: "h1" });
    await store.createEvalRun({ id: "run-eval", datasetId: "set-a", workflowId: "wf-1", kind: "eval", status: "completed", workflowHash: "h1" });
    await store.createEvalRun({ id: "run-sim", datasetId: "guard-simulation:sim-1", workflowId: "wf-1", kind: "replay", status: "completed", workflowHash: "h1" });
    await store.createEvalRun({ id: "run-other", datasetId: "set-a", workflowId: "wf-1", kind: "replay", status: "completed", workflowHash: "h2" });
    expect(await store.listReplayRunIdsForHash("wf-1", "h1")).toEqual(["run-new", "run-old"]);
  });

  it("marks runs release-ineligible once per reason and keeps earlier reasons", async () => {
    const store = ctx.store();
    await store.createEvalRun({ id: "run-1", datasetId: "set-a", workflowId: "wf-1", kind: "replay", status: "completed", candidate: { releaseEligible: true, note: "x" } });
    await store.createEvalRun({ id: "run-2", datasetId: "set-a", workflowId: "wf-1", kind: "replay", status: "completed" });
    expect((await store.markEvalRunsReleaseIneligible(["run-1", "run-1", "run-2", "missing"], "evidence removed")).sort()).toEqual(["run-1", "run-2"]);
    expect(await store.markEvalRunsReleaseIneligible(["run-1"], "evidence removed")).toEqual([]);
    expect(await store.markEvalRunsReleaseIneligible(["run-1"], "second reason")).toEqual(["run-1"]);
    expect(await store.markEvalRunsReleaseIneligible([], "x")).toEqual([]);
    const run = await store.getEvalRun("run-1");
    expect(run?.candidate).toMatchObject({ note: "x", releaseEligible: false, releaseIneligibleReasons: ["evidence removed", "second reason"] });
  });
});

describeStoreContract("store contract: release approval requests", (ctx) => {
  it("a request round-trips; pending ones for a version and hash list newest first", async () => {
    const store = ctx.store();
    const inserted = await store.insertReleaseApprovalRequest(releaseRequest("rr-1"));
    expect(inserted).toEqual(releaseRequest("rr-1"));
    await store.insertReleaseApprovalRequest(releaseRequest("rr-2", { createdAt: at(1000), updatedAt: at(1000), gateChecks: null, gateAuthority: null, origin: "blocked", expiresAt: at(60_000) }));
    await store.insertReleaseApprovalRequest(releaseRequest("rr-3", { workflowHash: "other" }));
    expect(await store.getReleaseApprovalRequest("rr-2")).toMatchObject({ gateChecks: null, gateAuthority: null, origin: "blocked", expiresAt: at(60_000) });
    expect(await store.getReleaseApprovalRequest("missing")).toBeNull();
    expect((await store.listPendingReleaseApprovalRequests("wf-1", 1, "hash-1")).map((request) => request.id)).toEqual(["rr-2", "rr-1"]);
  });

  it("a decision applies to a pending request once", async () => {
    const store = ctx.store();
    await store.insertReleaseApprovalRequest(releaseRequest("rr-1"));
    expect(await store.decideReleaseApprovalRequest({ id: "rr-1", status: "approved", decidedByUserId: "u-bo", decidedBy: "bo", decisionReason: "fine", releaseId: "rel-1" })).toBe(true);
    expect(await store.decideReleaseApprovalRequest({ id: "rr-1", status: "rejected" })).toBe(false);
    expect(await store.decideReleaseApprovalRequest({ id: "missing", status: "rejected" })).toBe(false);
    const decided = (await store.getReleaseApprovalRequest("rr-1"))!;
    expect(decided).toMatchObject({ status: "approved", decidedByUserId: "u-bo", decidedBy: "bo", decisionReason: "fine", releaseId: "rel-1" });
    expect(decided.decidedAt).toMatch(ISO);
    expect(decided.updatedAt).toBe(decided.decidedAt);
    expect(await store.listPendingReleaseApprovalRequests("wf-1", 1, "hash-1")).toEqual([]);
  });

  it("the inbox listing filters pending, decided and all, applies expiry, scope and limit", async () => {
    const store = ctx.store();
    const now = at(100_000);
    await store.insertReleaseApprovalRequest(releaseRequest("p-1", { createdAt: at(1000) }));
    await store.insertReleaseApprovalRequest(releaseRequest("p-2", { createdAt: at(2000), workflowId: "wf-2" }));
    await store.insertReleaseApprovalRequest(releaseRequest("expired", { createdAt: at(3000), expiresAt: at(50_000), updatedAt: at(4000) }));
    await store.insertReleaseApprovalRequest(releaseRequest("done", { createdAt: at(500), status: "rejected", decidedAt: at(90_000), updatedAt: at(90_000) }));
    const ids = (requests: ReleaseApprovalRequestRecord[]) => requests.map((request) => request.id);
    expect(ids(await store.listReleaseApprovalRequests({ status: "pending", now }))).toEqual(["p-2", "p-1"]);
    // Decided: newest decision (or update) first; an expired pending one counts as decided.
    expect(ids(await store.listReleaseApprovalRequests({ status: "decided", now }))).toEqual(["done", "expired"]);
    expect(ids(await store.listReleaseApprovalRequests({ status: "all", now }))).toEqual(["expired", "p-2", "p-1", "done"]);
    expect(ids(await store.listReleaseApprovalRequests({ status: "all", workflowId: "wf-2", now }))).toEqual(["p-2"]);
    expect(ids(await store.listReleaseApprovalRequests({ status: "all", scope: { workflowIds: [] }, now }))).toEqual([]);
    expect(ids(await store.listReleaseApprovalRequests({ status: "all", scope: { workflowIds: ["wf-2", "wf-x"] }, now }))).toEqual(["p-2"]);
    expect(ids(await store.listReleaseApprovalRequests({ status: "all", scope: { all: true }, limit: 2, now }))).toEqual(["expired", "p-2"]);
  });

  it("expired pending requests time out once and are answered as they were before", async () => {
    const store = ctx.store();
    await store.insertReleaseApprovalRequest(releaseRequest("old", { expiresAt: at(10_000) }));
    await store.insertReleaseApprovalRequest(releaseRequest("later", { expiresAt: at(900_000) }));
    await store.insertReleaseApprovalRequest(releaseRequest("open"));
    expect(await store.timeOutExpiredReleaseApprovalRequests(at(5000))).toEqual([]);
    const closed = await store.timeOutExpiredReleaseApprovalRequests(at(20_000));
    expect(closed).toEqual([releaseRequest("old", { expiresAt: at(10_000) })]);
    expect(await store.getReleaseApprovalRequest("old")).toMatchObject({
      status: "timed_out",
      decidedBy: "system",
      decidedAt: at(20_000),
      updatedAt: at(20_000),
      decisionReason: "Nobody decided before the release request expired"
    });
    expect(await store.timeOutExpiredReleaseApprovalRequests(at(20_000))).toEqual([]);
    expect((await store.getReleaseApprovalRequest("later"))?.status).toBe("pending");
  });

  it("approve-and-publish decides and publishes together; a lost publish rolls the decision back", async () => {
    const store = ctx.store();
    await workflowWithVersions(store, "wf-1", 2);
    await store.insertReleaseApprovalRequest(releaseRequest("rr-1"));
    await store.insertReleaseApprovalRequest(releaseRequest("rr-2", { version: 2, workflowHash: "hash-2" }));
    const decision = (id: string) => ({ id, status: "approved" as const, decidedByUserId: "u-bo", decidedBy: "bo", decisionReason: null, releaseId: `rel-${id}` });

    const done = await store.approveReleaseRequestAndPublish(decision("rr-1"), release("wf-1", "rel-rr-1", 1), null);
    expect(done).toEqual({ release: { ...release("wf-1", "rel-rr-1", 1), previousVersion: null } });
    expect((await store.getReleaseApprovalRequest("rr-1"))?.status).toBe("approved");
    expect(await store.approveReleaseRequestAndPublish(decision("rr-1"), release("wf-1", "rel-again", 1), 1)).toEqual({ refused: "decided" });

    // rr-2 expects nothing published, but version 1 is: conflict, and rr-2 stays pending.
    expect(await store.approveReleaseRequestAndPublish(decision("rr-2"), release("wf-1", "rel-rr-2", 2), null)).toEqual({ refused: "conflict" });
    expect((await store.getReleaseApprovalRequest("rr-2"))?.status).toBe("pending");
    expect(await store.getPublishedVersion("wf-1")).toBe(1);
    expect((await store.listWorkflowReleases("wf-1")).map((entry) => entry.id)).toEqual(["rel-rr-1"]);
  });
});

describeStoreContract("store contract: gate case requests and gate case changes", (ctx) => {
  it("a gate case request round-trips; pending ones list newest first; decided once", async () => {
    const store = ctx.store();
    expect(await store.insertGateCaseRequest(caseRequest("gc-1"))).toEqual(caseRequest("gc-1"));
    await store.insertGateCaseRequest(caseRequest("gc-2", { action: "remove", createdAt: at(1000), gateAuthority: null, fixtures: [{ fixtureId: "fx-9", name: "Nine", datasetId: null }] }));
    expect(await store.getGateCaseRequest("gc-2")).toMatchObject({ action: "remove", gateAuthority: null, fixtures: [{ fixtureId: "fx-9", name: "Nine", datasetId: null }] });
    expect(await store.getGateCaseRequest("missing")).toBeNull();
    expect((await store.listPendingGateCaseRequests("wf-1")).map((request) => request.id)).toEqual(["gc-2", "gc-1"]);
    expect(await store.decideGateCaseRequest({ id: "gc-1", status: "rejected", decidedBy: "bo", decisionReason: "no" })).toBe(true);
    expect(await store.decideGateCaseRequest({ id: "gc-1", status: "approved" })).toBe(false);
    expect(await store.getGateCaseRequest("gc-1")).toMatchObject({ status: "rejected", decidedBy: "bo", decidedByUserId: null, decisionReason: "no" });
    expect((await store.listPendingGateCaseRequests("wf-1")).map((request) => request.id)).toEqual(["gc-2"]);
  });

  it("the gate case inbox filters like the release inbox; expired requests time out once", async () => {
    const store = ctx.store();
    const now = at(100_000);
    await store.insertGateCaseRequest(caseRequest("p-1", { createdAt: at(1000) }));
    await store.insertGateCaseRequest(caseRequest("expired", { createdAt: at(3000), expiresAt: at(50_000) }));
    await store.insertGateCaseRequest(caseRequest("done", { createdAt: at(500), status: "approved", decidedAt: at(90_000), updatedAt: at(90_000), workflowId: "wf-2" }));
    const ids = (requests: GateCaseRequestRecord[]) => requests.map((request) => request.id);
    expect(ids(await store.listGateCaseRequests({ status: "pending", now }))).toEqual(["p-1"]);
    expect(ids(await store.listGateCaseRequests({ status: "decided", now }))).toEqual(["done", "expired"]);
    expect(ids(await store.listGateCaseRequests({ status: "all", now }))).toEqual(["expired", "p-1", "done"]);
    expect(ids(await store.listGateCaseRequests({ status: "all", scope: { workflowIds: ["wf-2"] }, now }))).toEqual(["done"]);
    expect(ids(await store.listGateCaseRequests({ status: "all", scope: { workflowIds: [] }, now }))).toEqual([]);
    expect(ids(await store.listGateCaseRequests({ status: "all", workflowId: "wf-1", limit: 1, now }))).toEqual(["expired"]);

    const closed = await store.timeOutExpiredGateCaseRequests(now);
    expect(closed).toEqual([caseRequest("expired", { createdAt: at(3000), expiresAt: at(50_000) })]);
    expect(await store.getGateCaseRequest("expired")).toMatchObject({ status: "timed_out", decidedBy: "system", decidedAt: now, decisionReason: "Nobody decided before the request expired" });
    expect(await store.timeOutExpiredGateCaseRequests(now)).toEqual([]);
  });

  it("updateReleaseGateCases refuses a decided request or changed admission and otherwise applies everything", async () => {
    const store = ctx.store();
    await store.upsertReleaseGate(gate("wf-1", { enforced: true }));
    await store.setReleaseGateAdmission("wf-1", ["fx-1"], at(0), "ana");
    await store.createEvalDataset({ id: "set-a", name: "Set A", workflowId: "wf-1" });
    await store.createEvalFixture({ id: "fx-1", datasetId: "set-a", name: "One", input: { q: 1 } });
    await store.createEvalFixture({ id: "fx-2", datasetId: "set-a", name: "Two", input: { q: 2 } });
    await store.createEvalFixture({ id: "fx-3", datasetId: "set-a", name: "Three", input: { q: 3 } });
    await store.insertGateCaseRequest(caseRequest("gc-1"));
    await store.decideGateCaseRequest({ id: "gc-1", status: "canceled" });
    await store.insertGateCaseRequest(caseRequest("gc-2"));

    const base = { workflowId: "wf-1", updatedAt: at(5000), updatedBy: "bo" };
    expect(await store.updateReleaseGateCases({ ...base, decideRequest: { id: "gc-1", status: "approved" }, admittedFixtureIds: ["fx-1", "fx-2"] })).toBe("decided");
    expect(await store.updateReleaseGateCases({ ...base, expectedAdmittedFixtureIds: ["fx-9"], admittedFixtureIds: ["fx-2"] })).toBe("changed");
    // A refusal after the request decision rolls that decision back.
    expect(await store.updateReleaseGateCases({ ...base, decideRequest: { id: "gc-2", status: "approved" }, expectedAdmittedFixtureIds: null })).toBe("changed");
    expect((await store.getGateCaseRequest("gc-2"))?.status).toBe("pending");
    expect((await store.getReleaseGate("wf-1"))?.admittedFixtureIds).toEqual(["fx-1"]);

    expect(
      await store.updateReleaseGateCases({
        ...base,
        decideRequest: { id: "gc-2", status: "approved", decidedBy: "bo" },
        expectedAdmittedFixtureIds: ["fx-1"],
        admittedFixtureIds: ["fx-2", "fx-1"],
        deleteFixtureIds: ["fx-3"],
        required: { fixtureId: "fx-2", required: true }
      })
    ).toBe("ok");
    expect((await store.getGateCaseRequest("gc-2"))?.status).toBe("approved");
    expect(await store.getReleaseGate("wf-1")).toMatchObject({ admittedFixtureIds: ["fx-1", "fx-2"], admissionUpdatedAt: at(5000), admissionUpdatedBy: "bo", updatedAt: at(0) });
    expect(await store.getEvalFixture("fx-3")).toBeNull();
    expect((await store.getEvalFixture("fx-2"))?.required).toBe(true);
    // A change with nothing to check or apply is ok.
    expect(await store.updateReleaseGateCases({ ...base, required: { fixtureId: "fx-2", required: false } })).toBe("ok");
    expect((await store.getEvalFixture("fx-2"))?.required).toBe(false);
  });
});
