/**
 * Phase 13.1 — store contract: leased queue claims (cluster mode), on both stores. A claim records its owner, a
 * fencing token and a heartbeat; completions, failures and the run's history writes are fenced on the token; the
 * reaper settles expired leases by the worker-loss policy and always counts the attempt; a shutdown release does not.
 */
import { expect, it } from "vitest";
import { describeStoreContract } from "../../test-support/test-store.js";
import type { Store } from "../store.js";
import { QueueClaimLostError, WORKER_LOST_ERROR, WORKER_LOST_INTERRUPTED_ERROR, WORKER_SHUTDOWN_INTERRUPTED_ERROR } from "../queue-leases.js";

const past = (ms: number) => new Date(Date.now() - ms).toISOString();

/** Polls `read` until it returns a non-empty array (a lease of 1 ms expires within a few ms). */
async function until<T>(read: () => Promise<T[]>, what: string, timeoutMs = 5_000): Promise<T[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value.length > 0) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function history(store: Store, id: string, status: string, nodeResults: unknown[] = []): Promise<void> {
  await store.saveExecutionHistory({ id, workflowId: "wf", status, startedAt: past(1_000), nodeResultsJson: nodeResults });
}

describeStoreContract("store contract: leased queue claims", (ctx) => {
  it("a claim sets owner, token and heartbeat, filters by pool and reports the wait", async () => {
    const store = ctx.store();
    await store.enqueueExecution({ id: "a", workflowId: "wf", payload: { executionId: "a" }, scheduledAt: past(2_000) });
    await store.enqueueExecution({ id: "b", workflowId: "wf", payload: {}, scheduledAt: past(1_000), pool: "gpu" });
    await store.enqueueExecution({ id: "later", workflowId: "wf", payload: {}, scheduledAt: new Date(Date.now() + 60_000).toISOString() });

    const claimed = await store.claimQueueItems({ limit: 5, owner: "w1", pools: ["default"] });
    expect(claimed).toEqual([
      expect.objectContaining({ id: "a", pool: "default", attempts: 0, maxAttempts: 3, payload: { executionId: "a" }, claimToken: expect.any(String) })
    ]);
    expect(claimed[0]!.waitMs).toBeGreaterThanOrEqual(1_000);
    expect(await store.getQueueDepthByPool()).toEqual([
      { pool: "default", pending: 1, running: 1 },
      { pool: "gpu", pending: 1, running: 0 }
    ]);
    expect(await store.countPendingQueueItems("gpu")).toBe(1);
    expect(await store.claimQueueItems({ limit: 5, owner: "w1", pools: [] })).toEqual([]);
    const gpu = await store.claimQueueItems({ limit: 5, owner: "w2", pools: ["gpu", "other"] });
    expect(gpu.map((job) => [job.id, job.pool])).toEqual([["b", "gpu"]]);
    expect(gpu[0]!.claimToken).not.toBe(claimed[0]!.claimToken);
    expect(await store.countPendingQueueItems("gpu")).toBe(0);
  });

  it("completion and failure are fenced on the claim token", async () => {
    const store = ctx.store();
    await store.enqueueExecution({ id: "j", workflowId: "wf", payload: {}, scheduledAt: past(1_000), maxAttempts: 2 });
    const [job] = await store.claimQueueItems({ limit: 1, owner: "w1", pools: ["default"] });
    expect(await store.markQueueItemCompleted("j", { claimToken: "stale" })).toBe(false);
    expect(await store.markQueueItemFailed("j", "boom", { claimToken: "stale" })).toBe(false);
    expect(await store.getQueueDepth()).toEqual({ pending: 0, running: 1, dlq: 0 });

    // The holder's failure retries: back to pending with the claim cleared, so the old token no longer completes it.
    expect(await store.markQueueItemFailed("j", "boom", { claimToken: job!.claimToken })).toBe(true);
    expect(await store.getQueueDepth()).toEqual({ pending: 1, running: 0, dlq: 0 });
    expect(await store.markQueueItemCompleted("j", { claimToken: job!.claimToken })).toBe(false);
    expect(await store.renewQueueLeases({ owner: "w1", claimTokens: [job!.claimToken] })).toEqual([]);

    await store.enqueueExecution({ id: "k", workflowId: "wf", payload: {}, scheduledAt: past(1_000) });
    const [k] = await store.claimQueueItems({ limit: 1, owner: "w1", pools: ["default"] });
    expect(k!.id).toBe("k");
    expect(await store.markQueueItemCompleted("k", { claimToken: k!.claimToken })).toBe(true);
    expect(await store.markQueueItemCompleted("k", { claimToken: k!.claimToken })).toBe(false);
  });

  it("a heartbeat renews only the claims the owner still holds", async () => {
    const store = ctx.store();
    for (const id of ["x", "y"]) await store.enqueueExecution({ id, workflowId: "wf", payload: {}, scheduledAt: past(1_000) });
    const claims = await store.claimQueueItems({ limit: 2, owner: "w1", pools: ["default"] });
    const tokens = claims.map((job) => job.claimToken);
    expect((await store.renewQueueLeases({ owner: "w1", claimTokens: tokens })).sort()).toEqual([...tokens].sort());
    expect(await store.renewQueueLeases({ owner: "w2", claimTokens: tokens })).toEqual([]);
    await store.markQueueItemCompleted(claims[0]!.id, { claimToken: claims[0]!.claimToken });
    expect(await store.renewQueueLeases({ owner: "w1", claimTokens: tokens })).toEqual([claims[1]!.claimToken]);
    expect(await store.renewQueueLeases({ owner: "w1", claimTokens: [] })).toEqual([]);
  });

  it("the reaper requeues an expired lease with no completed node, counts the attempt, then dead-letters at max", async () => {
    const store = ctx.store();
    await store.enqueueExecution({ id: "p", workflowId: "wf", workflowName: "Flow", payload: { executionId: "p" }, scheduledAt: past(1_000), maxAttempts: 2 });
    const [first] = await store.claimQueueItems({ limit: 1, owner: "w1", pools: ["default"] });
    // A node started but none completed.
    await history(store, "p", "running", [{ nodeId: "n1", status: "running" }]);
    const reaped = await until(() => store.reapExpiredQueueLeases({ leaseMs: 1 }), "the first reap");
    expect(reaped).toEqual([{ id: "p", workflowId: "wf", executionId: "p", decision: "requeue", attempts: 1 }]);
    // The zombie's token is dead: its completion and heartbeat are refused.
    expect(await store.markQueueItemCompleted("p", { claimToken: first!.claimToken })).toBe(false);
    expect(await store.renewQueueLeases({ owner: "w1", claimTokens: [first!.claimToken] })).toEqual([]);

    const [second] = await store.claimQueueItems({ limit: 1, owner: "w2", pools: ["default"] });
    expect(second).toMatchObject({ id: "p", attempts: 1 });
    const again = await until(() => store.reapExpiredQueueLeases({ leaseMs: 1 }), "the second reap");
    expect(again).toEqual([{ id: "p", workflowId: "wf", executionId: "p", decision: "dead_letter", attempts: 2 }]);
    expect(await store.listDlqItems()).toEqual([
      { id: expect.any(String), originalId: "p", workflowId: "wf", workflowName: "Flow", attempts: 2, finalError: WORKER_LOST_ERROR, failedAt: expect.any(String) }
    ]);
    expect(await store.getExecutionHistory("p")).toMatchObject({ status: "error", error: WORKER_LOST_ERROR });
    expect(await store.hasActiveQueueItem("p")).toBe(false);
  });

  it("the reaper interrupts a run with a completed node and settles a finished run without re-running it", async () => {
    const store = ctx.store();
    await store.enqueueExecution({ id: "sent", workflowId: "wf", payload: { executionId: "sent" }, scheduledAt: past(1_000), maxAttempts: 5 });
    await store.enqueueExecution({ id: "done", workflowId: "wf2", payload: { executionId: "done" }, scheduledAt: past(1_000) });
    await store.claimQueueItems({ limit: 2, owner: "w1", pools: ["default"] });
    await history(store, "sent", "running", [{ nodeId: "email", status: "success" }, { nodeId: "n2", status: "running" }]);
    await history(store, "done", "success");
    const reaped = await until(() => store.reapExpiredQueueLeases({ leaseMs: 1 }), "the reap");
    expect(reaped.map((outcome) => [outcome.id, outcome.decision, outcome.attempts]).sort()).toEqual([
      ["done", "finished", 1],
      ["sent", "interrupt", 1]
    ]);
    expect(await store.getExecutionHistory("sent")).toMatchObject({ status: "error", error: WORKER_LOST_INTERRUPTED_ERROR });
    expect(await store.getExecutionHistory("done")).toMatchObject({ status: "success" });
    expect((await store.listDlqItems()).map((item) => [item.originalId, item.finalError])).toEqual([["sent", WORKER_LOST_INTERRUPTED_ERROR]]);
    expect(await store.getQueueDepth()).toEqual({ pending: 0, running: 0, dlq: 1 });
  });

  it("the reaper leaves unleased claims to the legacy rule", async () => {
    const store = ctx.store();
    await store.enqueueExecution({ id: "old", workflowId: "wf", payload: {}, scheduledAt: past(1_000) });
    await store.dequeueNext(1);
    await store.enqueueExecution({ id: "leased", workflowId: "wf", payload: {}, scheduledAt: past(1_000) });
    await store.claimQueueItems({ limit: 1, owner: "w1", pools: ["default"] });
    const reaped = await until(() => store.reapExpiredQueueLeases({ leaseMs: 1 }), "the reap");
    expect(reaped.map((outcome) => outcome.id)).toEqual(["leased"]);
    expect(await store.reapExpiredQueueLeases({ leaseMs: 1 })).toEqual([]);
    expect(await store.getQueueDepth()).toEqual({ pending: 1, running: 1, dlq: 0 });
  });

  it("the legacy stuck rule leaves every leased claim to the reaper, however old its heartbeat", async () => {
    const store = ctx.store();
    await store.enqueueExecution({ id: "live", workflowId: "wf", payload: {}, scheduledAt: past(1_000) });
    await store.claimQueueItems({ limit: 1, owner: "w1", pools: ["default"] });
    await store.enqueueExecution({ id: "plain", workflowId: "wf", payload: {}, scheduledAt: past(1_000) });
    await store.dequeueNext(1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Both started (and the lease last renewed) more than 10 ms ago: only the unleased claim is the legacy rule's.
    expect(await store.requeueStuckItems(10, [], 0)).toBe(1);
    expect(await store.getQueueDepth()).toEqual({ pending: 1, running: 1, dlq: 0 });
    expect(await store.hasActiveQueueItem("plain")).toBe(true);
  });

  it("a shutdown release gives the job back without counting an attempt, unless a node completed", async () => {
    const store = ctx.store();
    await store.enqueueExecution({ id: "r", workflowId: "wf", payload: { executionId: "r" }, scheduledAt: past(1_000), maxAttempts: 1 });
    await store.enqueueExecution({ id: "s", workflowId: "wf2", payload: { executionId: "s" }, scheduledAt: past(1_000) });
    const claims = await store.claimQueueItems({ limit: 2, owner: "w1", pools: ["default"] });
    const tokenOf = (id: string) => claims.find((job) => job.id === id)!.claimToken;
    expect(await store.releaseQueueItem({ id: "r", claimToken: "stale" })).toBeNull();
    // One attempt allowed, none counted: requeued, not dead-lettered.
    expect(await store.releaseQueueItem({ id: "r", claimToken: tokenOf("r") })).toMatchObject({ decision: "requeue", attempts: 0 });
    expect(await store.releaseQueueItem({ id: "r", claimToken: tokenOf("r") })).toBeNull();
    await history(store, "s", "running", [{ nodeId: "n1", status: "success" }]);
    expect(await store.releaseQueueItem({ id: "s", claimToken: tokenOf("s") })).toMatchObject({ decision: "interrupt", attempts: 0 });
    expect(await store.getExecutionHistory("s")).toMatchObject({ status: "error", error: WORKER_SHUTDOWN_INTERRUPTED_ERROR });
    const [again] = await store.claimQueueItems({ limit: 1, owner: "w2", pools: ["default"] });
    expect(again).toMatchObject({ id: "r", attempts: 0 });

    // An unleased claim (no token) is released by id.
    await store.enqueueExecution({ id: "u", workflowId: "wf3", payload: {}, scheduledAt: past(1_000) });
    await store.dequeueNext(1);
    expect(await store.releaseQueueItem({ id: "u", claimToken: null })).toMatchObject({ decision: "requeue" });
  });

  it("a fenced history write lands only while the claim holds the item", async () => {
    const store = ctx.store();
    await store.enqueueExecution({ id: "f", workflowId: "wf", payload: { executionId: "f" }, scheduledAt: past(1_000) });
    const [claim] = await store.claimQueueItems({ limit: 1, owner: "w1", pools: ["default"] });
    const record = { id: "f", workflowId: "wf", status: "running", startedAt: past(500), nodeResultsJson: [] };
    expect(await store.saveExecutionHistory(record, { unlessFinished: true, fence: { queueItemId: "f", claimToken: "stale" } })).toBe(false);
    expect(await store.getExecutionHistory("f")).toBeNull();
    expect(await store.saveExecutionHistory(record, { unlessFinished: true, fence: { queueItemId: "f", claimToken: claim!.claimToken } })).toBe(true);
    await until(() => store.reapExpiredQueueLeases({ leaseMs: 1 }), "the reap");
    // Taken back: the zombie's final write is refused and the record stays as the reaper left it.
    expect(
      await store.saveExecutionHistory({ ...record, status: "success", completedAt: new Date().toISOString() }, { unlessCanceled: true, fence: { queueItemId: "f", claimToken: claim!.claimToken } })
    ).toBe(false);
    expect(await store.getExecutionHistory("f")).toMatchObject({ status: "running" });
    // The new claim writes.
    const [next] = await store.claimQueueItems({ limit: 1, owner: "w2", pools: ["default"] });
    expect(
      await store.saveExecutionHistory({ ...record, status: "success", completedAt: new Date().toISOString() }, { unlessCanceled: true, fence: { queueItemId: "f", claimToken: next!.claimToken } })
    ).toBe(true);
    expect(await store.getExecutionHistory("f")).toMatchObject({ status: "success" });
  });

  it("listCanceledExecutionIds reports only canceled runs", async () => {
    const store = ctx.store();
    await history(store, "c1", "canceled");
    await history(store, "c2", "running");
    expect(await store.listCanceledExecutionIds(["c1", "c2", "missing"])).toEqual(["c1"]);
    expect(await store.listCanceledExecutionIds([])).toEqual([]);
  });

  it("a fair claim takes one job per workflow before a second of any", async () => {
    const store = ctx.store();
    // Workflow a's burst is older, so a strict order would hand it every slot.
    for (let i = 0; i < 20; i += 1) {
      for (const wf of ["a", "b", "c"]) {
        const offset = wf === "a" ? 100_000 : wf === "b" ? 50_000 : 10_000;
        await store.enqueueExecution({ id: `${wf}-${String(i).padStart(2, "0")}`, workflowId: wf, payload: {}, scheduledAt: past(offset - i) });
      }
    }
    const round = await store.claimQueueItems({ limit: 3, owner: "w1", pools: ["default"] });
    expect(round.map((job) => job.workflowId).sort()).toEqual(["a", "b", "c"]);
    expect(round.map((job) => job.id)).toEqual(["a-00", "b-00", "c-00"]);
    const six = await store.claimQueueItems({ limit: 6, owner: "w1", pools: ["default"] });
    const count = (wf: string) => six.filter((job) => job.workflowId === wf).length;
    expect([count("a"), count("b"), count("c")]).toEqual([2, 2, 2]);
    // Priority still comes first within a rank.
    await store.enqueueExecution({ id: "urgent", workflowId: "c", payload: {}, priority: 9, scheduledAt: past(1) });
    const next = await store.claimQueueItems({ limit: 1, owner: "w1", pools: ["default"] });
    expect(next.map((job) => job.id)).toEqual(["urgent"]);
  });

  it("a job records the execution it drives, so other recovery can skip runs the queue owns", async () => {
    const store = ctx.store();
    await store.enqueueExecution({ id: "run-1", workflowId: "wf", payload: { executionId: "run-1" }, scheduledAt: past(1_000) });
    // An approval resume: its queue id is not its execution id.
    await store.enqueueExecution({ id: "run-2:req-9:1700000000000", workflowId: "wf", payload: { executionId: "run-2", resume: {} }, scheduledAt: past(1_000) });
    // No execution id in the payload: the queue id is the execution id.
    await store.enqueueExecution({ id: "run-3", workflowId: "wf", payload: {}, scheduledAt: past(1_000) });
    await store.enqueueExecution({ id: "run-4", workflowId: "wf", payload: { executionId: "run-4" }, scheduledAt: past(1_000) });
    await store.markQueueItemCompleted("run-4");

    expect(await store.listExecutionIdsWithActiveQueueJob([])).toEqual([]);
    expect(await store.listExecutionIdsWithActiveQueueJob(["run-1", "run-2", "run-3", "run-4", "run-2:req-9", "other"])).toEqual(["run-1", "run-2", "run-3"]);
    // Running counts too; a finished job does not.
    const [claimed] = await store.claimQueueItems({ limit: 1, owner: "w1", pools: ["default"] });
    expect(await store.listExecutionIdsWithActiveQueueJob([claimed!.id.split(":")[0]!])).toEqual([claimed!.id.split(":")[0]]);
    await store.markQueueItemCompleted(claimed!.id, { claimToken: claimed!.claimToken! });
    expect(await store.listExecutionIdsWithActiveQueueJob([claimed!.id.split(":")[0]!])).toEqual([]);
  });

  it("concurrent leased claimers claim every job exactly once", async () => {
    const store = ctx.store();
    const ids = Array.from({ length: 40 }, (_, i) => `job-${i}`);
    for (const [index, id] of ids.entries()) await store.enqueueExecution({ id, workflowId: `wf-${index % 4}`, payload: {}, scheduledAt: past(1_000) });
    const claimed: string[] = [];
    await Promise.all(
      Array.from({ length: 6 }, async (_, worker) => {
        for (;;) {
          const batch = await store.claimQueueItems({ limit: 3, owner: `w${worker}`, pools: ["default"] });
          if (batch.length === 0) {
            if ((await store.countPendingQueueItems("default")) === 0) return;
            continue;
          }
          claimed.push(...batch.map((job) => job.id));
        }
      })
    );
    expect(claimed.sort()).toEqual([...ids].sort());
  });

  /** A paused run whose decision was taken: state `resuming`, history still reading as the pause. */
  async function decidedPause(store: Store, executionId: string): Promise<void> {
    await history(store, executionId, "waiting_approval", [{ nodeId: "draft", status: "success" }, { nodeId: "gate", status: "waiting_approval" }]);
    await store.saveWorkflowExecutionState({
      id: executionId,
      workflowId: "wf",
      status: "waiting_approval",
      waitingNodeId: "gate",
      startedAt: past(1_000),
      state: { paused: true }
    });
    expect(await store.claimWorkflowExecutionForResume(executionId)).toBe(true);
  }

  const resumePayload = (executionId: string) => ({ executionId, resume: { executionId, requestId: "req", decision: "approve" } });

  it("a lost approval resume with no node completed since it started is re-queued, its paused state intact", async () => {
    const store = ctx.store();
    await decidedPause(store, "run-r");
    await store.enqueueExecution({ id: "run-r:req:1", workflowId: "wf", payload: resumePayload("run-r"), scheduledAt: past(1_000) });
    await store.claimQueueItems({ limit: 1, owner: "w1", pools: ["default"] });
    const reaped = await until(() => store.reapExpiredQueueLeases({ leaseMs: 1 }), "the reap");
    expect(reaped.map((outcome) => [outcome.id, outcome.decision, outcome.attempts])).toEqual([["run-r:req:1", "requeue", 1]]);
    expect((await store.getWorkflowExecutionState("run-r"))?.status).toBe("resuming");
    expect(await store.getExecutionHistory("run-r")).toMatchObject({ status: "waiting_approval" });
    expect(await store.listDlqItems()).toEqual([]);
  });

  it("a lost approval resume that completed a node is interrupted and dead-lettered, and its paused state is gone", async () => {
    const store = ctx.store();
    await decidedPause(store, "run-s");
    await store.enqueueExecution({ id: "run-s:req:1", workflowId: "wf", payload: resumePayload("run-s"), scheduledAt: past(1_000) });
    const [claim] = await store.claimQueueItems({ limit: 1, owner: "w1", pools: ["default"] });
    const fence = { queueItemId: claim!.id, claimToken: claim!.claimToken };
    expect(await store.recordQueueJobProgress({ ...fence, claimToken: "stale" })).toBe(false);
    expect(await store.recordQueueJobProgress(fence)).toBe(true);
    const reaped = await until(() => store.reapExpiredQueueLeases({ leaseMs: 1 }), "the reap");
    expect(reaped.map((outcome) => [outcome.id, outcome.decision])).toEqual([["run-s:req:1", "interrupt"]]);
    expect(await store.recordQueueJobProgress(fence)).toBe(false);
    expect(await store.getExecutionHistory("run-s")).toMatchObject({ status: "error", error: WORKER_LOST_INTERRUPTED_ERROR });
    // Approval recovery lists only runs in `resuming`: this one has one way forward, the dead-letter entry.
    expect(await store.getWorkflowExecutionState("run-s")).toBeNull();
    expect((await store.listDlqItems()).map((item) => [item.originalId, item.finalError])).toEqual([["run-s:req:1", WORKER_LOST_INTERRUPTED_ERROR]]);
  });

  it("a lost approval resume out of attempts is dead-lettered as worker lost; one whose run moved on is finished", async () => {
    const store = ctx.store();
    await decidedPause(store, "run-t");
    await store.enqueueExecution({ id: "run-t:req:1", workflowId: "wf", payload: resumePayload("run-t"), scheduledAt: past(1_000), maxAttempts: 1 });
    await decidedPause(store, "run-u");
    await store.enqueueExecution({ id: "run-u:req:1", workflowId: "wf2", payload: resumePayload("run-u"), scheduledAt: past(1_000) });
    await store.claimQueueItems({ limit: 2, owner: "w1", pools: ["default"] });
    // run-u paused again at a later gate before its worker was lost.
    await store.releaseWorkflowExecutionClaim("run-u");
    const reaped = await until(() => store.reapExpiredQueueLeases({ leaseMs: 1 }), "the reap");
    expect(reaped.map((outcome) => [outcome.id, outcome.decision]).sort()).toEqual([
      ["run-t:req:1", "dead_letter"],
      ["run-u:req:1", "finished"]
    ]);
    expect(await store.getExecutionHistory("run-t")).toMatchObject({ status: "error", error: WORKER_LOST_ERROR });
    expect(await store.getWorkflowExecutionState("run-t")).toBeNull();
    expect((await store.getWorkflowExecutionState("run-u"))?.status).toBe("waiting_approval");
  });

  it("a shutdown release gives an approval resume with no node completed back, its paused state intact", async () => {
    const store = ctx.store();
    await decidedPause(store, "run-v");
    await store.enqueueExecution({ id: "run-v:req:1", workflowId: "wf", payload: resumePayload("run-v"), scheduledAt: past(1_000) });
    const [claim] = await store.claimQueueItems({ limit: 1, owner: "w1", pools: ["default"] });
    expect(await store.releaseQueueItem({ id: claim!.id, claimToken: claim!.claimToken })).toMatchObject({ decision: "requeue", attempts: 0 });
    expect((await store.getWorkflowExecutionState("run-v"))?.status).toBe("resuming");
    expect(await store.getExecutionHistory("run-v")).toMatchObject({ status: "waiting_approval" });
    // An unleased claim (one instance) the same way.
    const [again] = await store.dequeueNext(1);
    expect(await store.releaseQueueItem({ id: again!.id, claimToken: null })).toMatchObject({ decision: "requeue", attempts: 0 });
    expect((await store.getWorkflowExecutionState("run-v"))?.status).toBe("resuming");
    expect(await store.listDlqItems()).toEqual([]);
  });

  it("a shutdown release interrupts an approval resume after a node completed: dead-lettered, its paused state gone", async () => {
    const store = ctx.store();
    await decidedPause(store, "run-w");
    await store.enqueueExecution({ id: "run-w:req:1", workflowId: "wf", payload: resumePayload("run-w"), scheduledAt: past(1_000) });
    const [claim] = await store.claimQueueItems({ limit: 1, owner: "w1", pools: ["default"] });
    expect(await store.recordQueueJobProgress({ queueItemId: claim!.id, claimToken: claim!.claimToken })).toBe(true);
    expect(await store.releaseQueueItem({ id: claim!.id, claimToken: "stale" })).toBeNull();
    expect(await store.releaseQueueItem({ id: claim!.id, claimToken: claim!.claimToken })).toMatchObject({ decision: "interrupt", attempts: 0 });
    // Never re-run silently: the record is final and the paused state goes in the same write, so the dead-letter entry
    // is the run's one way forward.
    expect(await store.getExecutionHistory("run-w")).toMatchObject({ status: "error", error: WORKER_SHUTDOWN_INTERRUPTED_ERROR });
    expect(await store.getWorkflowExecutionState("run-w")).toBeNull();
    expect((await store.listDlqItems()).map((item) => [item.originalId, item.finalError, item.attempts])).toEqual([["run-w:req:1", WORKER_SHUTDOWN_INTERRUPTED_ERROR, 0]]);
    expect(await store.getQueueDepth()).toEqual({ pending: 0, running: 0, dlq: 1 });
    expect(await store.dequeueNext(1)).toEqual([]);
    expect(await store.releaseQueueItem({ id: claim!.id, claimToken: claim!.claimToken })).toBeNull();
  });

  it("a zombie's late pause leaves no paused state and no approval request; the holder's pause lands", async () => {
    const store = ctx.store();
    await store.enqueueExecution({ id: "z", workflowId: "wf", payload: { executionId: "z" }, scheduledAt: past(1_000) });
    const [stale] = await store.claimQueueItems({ limit: 1, owner: "w1", pools: ["default"] });
    await until(() => store.reapExpiredQueueLeases({ leaseMs: 1 }), "the reap");
    const [current] = await store.claimQueueItems({ limit: 1, owner: "w2", pools: ["default"] });
    const pause = { id: "z", workflowId: "wf", status: "waiting_approval", waitingNodeId: "gate", startedAt: past(500), state: { paused: true } };
    const request = (id: string) => ({
      id,
      executionId: "z",
      workflowId: "wf",
      projectId: "default",
      nodeId: "gate",
      kind: "human_approval" as const,
      spec: { kind: "human_approval", approverRoles: [], approverUsers: [] } as never
    });
    const staleFence = { queueItemId: "z", claimToken: stale!.claimToken };
    expect(await store.isQueueClaimHeld(staleFence)).toBe(false);
    expect(await store.saveWorkflowExecutionState(pause, { fence: staleFence })).toBe(false);
    await expect(store.insertApprovalRequest(request("apr-zombie"), { fence: staleFence })).rejects.toBeInstanceOf(QueueClaimLostError);
    expect(await store.getWorkflowExecutionState("z")).toBeNull();
    expect(await store.listApprovalRequestsForExecution("z")).toEqual([]);

    const fence = { queueItemId: "z", claimToken: current!.claimToken };
    expect(await store.isQueueClaimHeld(fence)).toBe(true);
    expect(await store.saveWorkflowExecutionState(pause, { fence })).toBe(true);
    expect(await store.insertApprovalRequest(request("apr-holder"), { fence })).toMatchObject({ id: "apr-holder", status: "pending" });
    // A zombie's later pause supersedes nothing: the cancel of the holder's request is fenced with its insert.
    await expect(store.insertApprovalRequest(request("apr-zombie-2"), { fence: staleFence, supersedeReason: "superseded" })).rejects.toBeInstanceOf(QueueClaimLostError);
    expect((await store.listApprovalRequestsForExecution("z")).map((entry) => [entry.id, entry.status])).toEqual([["apr-holder", "pending"]]);
    // The holder's next pause supersedes its own earlier request in the same transaction.
    expect(await store.insertApprovalRequest(request("apr-holder-2"), { fence, supersedeReason: "superseded" })).toMatchObject({ id: "apr-holder-2", status: "pending" });
    expect(await store.getApprovalRequest("apr-holder")).toMatchObject({ status: "canceled", reason: "superseded" });
    // Unfenced (one instance) as before.
    expect(await store.saveWorkflowExecutionState({ ...pause, id: "plain" })).toBe(true);
    expect(await store.insertApprovalRequest({ ...request("apr-plain-2"), executionId: "z" }, { supersedeReason: "superseded" })).toMatchObject({ status: "pending" });
    expect(await store.getApprovalRequest("apr-holder-2")).toMatchObject({ status: "canceled" });
  });
});
