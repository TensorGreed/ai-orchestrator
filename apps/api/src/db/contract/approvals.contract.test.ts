/**
 * Phase 13.1 — store contract: approval requests and the paused-run claim, on both stores. A decision applies once,
 * also when two deciders race (on Postgres the pool gives each its own connection, so the race is real).
 */
import { expect, it } from "vitest";
import type { ApprovalRequestInsert } from "../database.js";
import type { Store } from "../store.js";
import { isOnePendingApprovalViolation } from "../store-errors.js";
import { describeStoreContract } from "../../test-support/test-store.js";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const spec = { kind: "approval_gate", approverRoles: ["admin"], approverUsers: [], allowSelfApproval: false, timeoutOutcome: "reject", requireRejectReason: true, editableFields: [] } as ApprovalRequestInsert["spec"];

function request(id: string, overrides: Partial<ApprovalRequestInsert> = {}): ApprovalRequestInsert {
  return { id, executionId: "run-1", workflowId: "wf", projectId: "default", nodeId: "gate", kind: "approval_gate", spec, ...overrides };
}

async function pausedRun(store: Store, id: string): Promise<void> {
  const startedAt = new Date().toISOString();
  await store.saveExecutionHistory({ id, workflowId: "wf", status: "waiting_approval", startedAt });
  await store.saveWorkflowExecutionState({ id, workflowId: "wf", status: "waiting_approval", waitingNodeId: "gate", startedAt, state: {} });
}

describeStoreContract("store contract: approvals", (ctx) => {
  it("inserts a request and reads it back with every field", async () => {
    const store = ctx.store();
    const saved = await store.insertApprovalRequest(request("r1", {
      workflowName: "Flow", nodeType: "approval_gate", message: "Please check", path: [{ nodeId: "a", label: "A" }] as never,
      details: { amount: 3 }, requestedByUserId: "u1", requestedBy: "u1@example.com", timeoutMinutes: 30.7,
      expiresAt: "2030-01-01T00:00:00.000Z", askingWorkflowId: "wf-parent", editsSalt: "salt", createdAt: "2026-01-01T00:00:00.000Z"
    }));
    expect(saved).toEqual({
      id: "r1", executionId: "run-1", workflowId: "wf", workflowName: "Flow", projectId: "default", nodeId: "gate", nodeType: "approval_gate",
      kind: "approval_gate", status: "pending", message: "Please check", spec, path: [{ nodeId: "a", label: "A" }], details: { amount: 3 },
      requestedByUserId: "u1", requestedBy: "u1@example.com", timeoutMinutes: 30, expiresAt: "2030-01-01T00:00:00.000Z",
      decidedByUserId: null, decidedBy: null, decidedAt: null, reason: null, edits: null, editedFields: [], askingWorkflowId: "wf-parent",
      editsSalt: "salt", workflowDeletedAt: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
    });
    expect(await store.getApprovalRequest("r1")).toEqual(saved);
    expect(await store.getApprovalRequest("missing")).toBeNull();
    const bare = await store.insertApprovalRequest(request("r2", { executionId: "run-2" }));
    expect(bare).toMatchObject({ workflowName: null, nodeType: null, message: null, path: [], details: null, timeoutMinutes: null, expiresAt: null });
    expect(bare.createdAt).toMatch(ISO);
  });

  it("decides once, reopens a decided request, and cancels pending ones", async () => {
    const store = ctx.store();
    await store.insertApprovalRequest(request("r1"));
    const decision = { id: "r1", status: "approved" as const, decidedByUserId: "u1", decidedBy: "u1@example.com", reason: "ok", edits: { a: 1 }, editedFields: ["a"], decidedAt: "2026-02-02T00:00:00.000Z" };
    expect(await store.decideApprovalRequest(decision)).toBe(true);
    expect(await store.decideApprovalRequest({ id: "r1", status: "rejected" })).toBe(false);
    expect(await store.getApprovalRequest("r1")).toMatchObject({ status: "approved", decidedBy: "u1@example.com", decidedAt: "2026-02-02T00:00:00.000Z", reason: "ok", edits: { a: 1 }, editedFields: ["a"], updatedAt: "2026-02-02T00:00:00.000Z" });
    expect(await store.reopenApprovalRequest("r1")).toBe(true);
    expect(await store.getApprovalRequest("r1")).toMatchObject({ status: "pending", decidedBy: null, decidedAt: null, reason: null, edits: null, editedFields: [] });
    expect(await store.reopenApprovalRequest("r1")).toBe(false);

    await store.insertApprovalRequest(request("r2", { executionId: "run-3" }));
    await store.insertApprovalRequest(request("r3", { executionId: "run-2" }));
    expect(await store.cancelPendingApprovalRequests({ executionId: "run-1" }, "Run canceled")).toBe(1);
    expect(await store.getApprovalRequest("r1")).toMatchObject({ status: "canceled", reason: "Run canceled" });
    expect(await store.reopenApprovalRequest("r1")).toBe(false);
    expect(await store.cancelPendingApprovalRequests({ workflowId: "wf" }, "gone")).toBe(2);
    expect(await store.cancelPendingApprovalRequests({}, "nothing")).toBe(0);
  });

  it("lists per execution, pending first-newest, decided by decision time, scoped and limited", async () => {
    const store = ctx.store();
    // One run's requests: each earlier pause decided before the next one asks (one pending request per run, v41).
    await store.insertApprovalRequest(request("r-d", { createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-01T00:10:00.000Z" }));
    await store.insertApprovalRequest(request("r-a2", { createdAt: "2026-01-01T00:00:01.000Z", executionId: "run-2" }));
    expect((await store.listApprovalRequests({ status: "pending" })).map((r) => r.id)).toEqual(["r-a2", "r-d"]);
    expect((await store.listApprovalRequests({ status: "pending", limit: 1 })).map((r) => r.id)).toEqual(["r-a2"]);
    await store.decideApprovalRequest({ id: "r-a2", status: "rejected", decidedAt: "2026-02-01T00:00:00.000Z" });
    await store.decideApprovalRequest({ id: "r-d", status: "approved", decidedAt: "2026-04-01T00:00:00.000Z" });
    await store.insertApprovalRequest(request("r-a", { createdAt: "2026-01-01T00:00:01.000Z" }));
    await store.decideApprovalRequest({ id: "r-a", status: "rejected", decidedAt: "2026-03-01T00:00:00.000Z" });
    await store.insertApprovalRequest(request("r-b", { createdAt: "2026-01-01T00:00:02.000Z" }));
    await store.insertApprovalRequest(request("r-C", { createdAt: "2026-01-01T00:00:02.000Z", workflowId: "wf-other", executionId: "run-9" }));
    expect((await store.listApprovalRequestsForExecution("run-1")).map((r) => r.id)).toEqual(["r-d", "r-a", "r-b"]);
    expect((await store.getPendingApprovalRequestForExecution("run-1"))?.id).toBe("r-b");
    expect(await store.getPendingApprovalRequestForExecution("run-x")).toBeNull();

    expect((await store.listApprovalRequests({ status: "pending" })).map((r) => r.id)).toEqual(["r-b", "r-C"]);
    expect((await store.listApprovalRequests({ status: "pending", limit: 1 })).map((r) => r.id)).toEqual(["r-b"]);
    expect((await store.listApprovalRequests({ status: "all", scope: { workflowIds: ["wf-other"] } })).map((r) => r.id)).toEqual(["r-C"]);
    expect(await store.listApprovalRequests({ status: "all", scope: { workflowIds: [] } })).toEqual([]);
    expect((await store.listApprovalRequests({ status: "all", scope: { all: true }, executionId: "run-9" })).map((r) => r.id)).toEqual(["r-C"]);

    expect((await store.listApprovalRequests({ status: "decided" })).map((r) => r.id)).toEqual(["r-d", "r-a", "r-a2"]);
    expect((await store.listApprovalRequests({ status: "decided", workflowId: "wf-other" }))).toEqual([]);

    await store.insertApprovalRequest(request("r-e", { executionId: "run-5", expiresAt: "2026-01-01T00:05:00.000Z" }));
    await store.insertApprovalRequest(request("r-f", { executionId: "run-6", expiresAt: "2026-01-01T00:01:00.000Z" }));
    expect((await store.listExpiredApprovalRequests("2026-01-01T00:06:00.000Z")).map((r) => r.id)).toEqual(["r-f", "r-e"]);
    expect((await store.listExpiredApprovalRequests("2026-01-01T00:06:00.000Z", 1)).map((r) => r.id)).toEqual(["r-f"]);
  });

  it("v41: a run has one pending request; a second is refused by the index, a decided one may sit beside a new one", async () => {
    const store = ctx.store();
    await store.insertApprovalRequest(request("p1"));
    const second = await store.insertApprovalRequest(request("p2")).then(() => null, (error: unknown) => error);
    expect(isOnePendingApprovalViolation(second)).toBe(true);
    expect(await store.getApprovalRequest("p2")).toBeNull();
    expect(await store.decideApprovalRequest({ id: "p1", status: "approved" })).toBe(true);
    await store.insertApprovalRequest(request("p2"));
    expect((await store.getPendingApprovalRequestForExecution("run-1"))?.id).toBe("p2");
    // Reopening a decided request while a newer one is pending is refused the same way.
    const reopened = await store.reopenApprovalRequest("p1").then((ok) => ok, (error: unknown) => error);
    expect(isOnePendingApprovalViolation(reopened)).toBe(true);
    expect(isOnePendingApprovalViolation(new Error("other"))).toBe(false);
  });

  it("a deleted workflow's requests leave scoped lists", async () => {
    const store = ctx.store();
    await store.insertApprovalRequest(request("r1"));
    await store.deleteWorkflow("wf");
    expect(await store.listApprovalRequests({ status: "all", scope: { workflowIds: ["wf"] } })).toEqual([]);
    expect((await store.listApprovalRequests({ status: "all", scope: { all: true } })).map((r) => r.id)).toEqual(["r1"]);
  });

  it("paused-run claims: claim once, release once, list resuming runs oldest claim first", async () => {
    const store = ctx.store();
    await pausedRun(store, "run-1");
    await pausedRun(store, "run-2");
    expect(await store.claimWorkflowExecutionForResume("run-1")).toBe(true);
    expect(await store.claimWorkflowExecutionForResume("run-1")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await store.claimWorkflowExecutionForResume("run-2")).toBe(true);
    expect(await store.listResumingWorkflowExecutionIds()).toEqual(["run-1", "run-2"]);
    const resuming = await store.listResumingWorkflowExecutions();
    expect(resuming.map((r) => r.id)).toEqual(["run-1", "run-2"]);
    expect(resuming[0]?.claimedAt).toMatch(ISO);
    expect((await store.listResumingWorkflowExecutions(resuming[1]!.claimedAt)).map((r) => r.id)).toEqual(["run-1"]);
    expect(await store.releaseWorkflowExecutionClaim("run-1")).toBe(true);
    expect(await store.releaseWorkflowExecutionClaim("run-1")).toBe(false);
    expect((await store.getWorkflowExecutionState("run-1"))?.status).toBe("waiting_approval");
    expect(await store.claimWorkflowExecutionForResume("missing")).toBe(false);
  });

  it("claim-and-decide is one write: a lost decision rolls the claim back; release-and-reopen hands both back", async () => {
    const store = ctx.store();
    await pausedRun(store, "run-1");
    await store.insertApprovalRequest(request("r1"));
    expect(await store.claimExecutionAndDecideApproval("run-1", { id: "r1", status: "approved", decidedBy: "a" })).toBe(true);
    expect((await store.getWorkflowExecutionState("run-1"))?.status).toBe("resuming");
    expect((await store.getApprovalRequest("r1"))?.status).toBe("approved");

    expect(await store.releaseExecutionClaimAndReopenApproval("run-1", "r1")).toBe(true);
    expect((await store.getWorkflowExecutionState("run-1"))?.status).toBe("waiting_approval");
    expect((await store.getApprovalRequest("r1"))?.status).toBe("pending");
    expect(await store.releaseExecutionClaimAndReopenApproval("run-1", "r1")).toBe(false);

    // The request was decided elsewhere: the claim must not stick.
    await store.decideApprovalRequest({ id: "r1", status: "rejected" });
    expect(await store.claimExecutionAndDecideApproval("run-1", { id: "r1", status: "approved" })).toBe(false);
    expect((await store.getWorkflowExecutionState("run-1"))?.status).toBe("waiting_approval");
    expect((await store.getApprovalRequest("r1"))?.status).toBe("rejected");
  });

  it("two deciders racing: exactly one claim-and-decide wins, and the request keeps the winner's decision", async () => {
    const store = ctx.store();
    for (let round = 0; round < 8; round += 1) {
      const run = `run-race-${round}`;
      await pausedRun(store, run);
      await store.insertApprovalRequest(request(`r-${round}`, { executionId: run }));
      const results = await Promise.all([
        store.claimExecutionAndDecideApproval(run, { id: `r-${round}`, status: "approved", decidedBy: "alice" }),
        store.claimExecutionAndDecideApproval(run, { id: `r-${round}`, status: "rejected", decidedBy: "bob" })
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const winner = results[0] ? "alice" : "bob";
      expect((await store.getApprovalRequest(`r-${round}`))?.decidedBy).toBe(winner);
      expect((await store.getWorkflowExecutionState(run))?.status).toBe("resuming");
    }
  });

  it("two plain decides racing: exactly one applies", async () => {
    const store = ctx.store();
    for (let round = 0; round < 8; round += 1) {
      await store.insertApprovalRequest(request(`d-${round}`));
      const results = await Promise.all([
        store.decideApprovalRequest({ id: `d-${round}`, status: "approved", decidedBy: "alice" }),
        store.decideApprovalRequest({ id: `d-${round}`, status: "timed_out", decidedBy: "sweeper" })
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    }
  });
});
