/**
 * Phase 13.1 — store contract: queue dispatch, on both stores. The worker that runs a dispatched job stores the run's
 * result on its queue item under its claim; the instance waiting on the run reads the item's status, result and last
 * error, then drops it. Fire ids deduplicate within a window, and finished items follow the history retention.
 */
import { expect, it } from "vitest";
import { describeStoreContract } from "../../test-support/test-store.js";

describeStoreContract("store contract: queue dispatch results", (ctx) => {
  it("stores a result only under the claim that holds the item, and reads it back with the status", async () => {
    const store = ctx.store();
    expect(await store.getQueueItemOutcome("missing")).toBeNull();
    await store.enqueueExecution({ id: "exec-1", workflowId: "wf", payload: { executionId: "exec-1" } });
    expect(await store.getQueueItemOutcome("exec-1")).toEqual({ status: "pending", result: null, lastError: null, attempts: 0 });

    const [claim] = await store.claimQueueItems({ limit: 1, owner: "w1", pools: ["default"] });
    expect(claim?.id).toBe("exec-1");
    const result = { workflowId: "wf", status: "success", output: { text: "héllo" }, nodeResults: [{ nodeId: "n1" }], warnings: ["w"] };
    // Another claim's token is refused; the holder's is stored.
    expect(await store.saveQueueItemResult({ id: "exec-1", claimToken: "not-the-token", result })).toBe(false);
    expect((await store.getQueueItemOutcome("exec-1"))?.result).toBeNull();
    expect(await store.saveQueueItemResult({ id: "exec-1", claimToken: claim!.claimToken, result })).toBe(true);
    expect(await store.getQueueItemOutcome("exec-1")).toEqual({ status: "running", result, lastError: null, attempts: 0 });

    // Once completed the claim no longer holds the item: a late write is refused, the stored result stays.
    await store.markQueueItemCompleted("exec-1", { claimToken: claim!.claimToken });
    expect(await store.saveQueueItemResult({ id: "exec-1", claimToken: claim!.claimToken, result: { status: "error" } })).toBe(false);
    expect(await store.getQueueItemOutcome("exec-1")).toEqual({ status: "completed", result, lastError: null, attempts: 0 });
  });

  it("an unleased item takes a result without a token, and a dead item reports its last error", async () => {
    const store = ctx.store();
    await store.enqueueExecution({ id: "exec-2", workflowId: "wf", payload: {} });
    expect(await store.saveQueueItemResult({ id: "exec-2", claimToken: null, result: null })).toBe(true);
    expect((await store.getQueueItemOutcome("exec-2"))?.result).toBeNull();

    await store.enqueueExecution({ id: "exec-3", workflowId: "wf", payload: {}, maxAttempts: 1 });
    await store.markQueueItemFailed("exec-3", "could not run", { retryable: false });
    expect(await store.getQueueItemOutcome("exec-3")).toEqual({ status: "dead", result: null, lastError: "could not run", attempts: 1 });
  });

  it("drops a delivered result and the run's spec from a completed item, or a running one that stored its result", async () => {
    const store = ctx.store();
    const spec = { v: 1, run: { executionId: "exec-4", directInput: { secretish: "raw body" } } };
    await store.enqueueExecution({ id: "exec-4", workflowId: "wf", payload: { executionId: "exec-4", dispatch: spec } });
    const [claim] = await store.claimQueueItems({ limit: 1, owner: "w1", pools: ["default"] });
    // Running without a stored result (the run is still going): nothing is dropped.
    await store.releaseQueueItemResult("exec-4");
    expect(await store.getQueueItemOutcome("exec-4")).toMatchObject({ status: "running", result: null });

    // Delivered between the worker storing its result and the queue marking the item completed: dropped all the same,
    // and the holder still completes it under its claim.
    expect(await store.saveQueueItemResult({ id: "exec-4", claimToken: claim!.claimToken, result: { status: "success" } })).toBe(true);
    await store.releaseQueueItemResult("exec-4");
    expect(await store.getQueueItemOutcome("exec-4")).toEqual({ status: "running", result: null, lastError: null, attempts: 0 });
    expect(await store.markQueueItemCompleted("exec-4", { claimToken: claim!.claimToken })).toBe(true);
    expect(await store.getQueueItemOutcome("exec-4")).toEqual({ status: "completed", result: null, lastError: null, attempts: 0 });

    // Delivered after the item completed.
    await store.enqueueExecution({ id: "exec-5", workflowId: "wf", payload: { executionId: "exec-5", dispatch: spec } });
    const [second] = await store.claimQueueItems({ limit: 1, owner: "w1", pools: ["default"] });
    expect(await store.saveQueueItemResult({ id: "exec-5", claimToken: second!.claimToken, result: { status: "success" } })).toBe(true);
    await store.markQueueItemCompleted("exec-5", { claimToken: second!.claimToken });
    await store.releaseQueueItemResult("exec-5");
    expect(await store.getQueueItemOutcome("exec-5")).toEqual({ status: "completed", result: null, lastError: null, attempts: 0 });
    await store.releaseQueueItemResult("missing");
  });

  it("an idempotent id suppresses a second enqueue only within the window; a finished item past it is replaced", async () => {
    const store = ctx.store();
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(await store.enqueueExecution({ id: "trig:wf:n:h", workflowId: "wf", payload: { executionId: "run-a" }, replaceFinishedBefore: past })).toBe(true);
    // A pending item always wins, whatever the window.
    expect(await store.enqueueExecution({ id: "trig:wf:n:h", workflowId: "wf", payload: { executionId: "run-b" }, replaceFinishedBefore: future })).toBe(false);
    const [claim] = await store.claimQueueItems({ limit: 1, owner: "w1", pools: ["default"] });
    expect(claim?.payload).toMatchObject({ executionId: "run-a" });
    expect(await store.saveQueueItemResult({ id: "trig:wf:n:h", claimToken: claim!.claimToken, result: { status: "success" } })).toBe(true);
    await store.markQueueItemCompleted("trig:wf:n:h", { claimToken: claim!.claimToken });

    // Finished, but created within the window (created after `past`): a duplicate, nothing is added.
    expect(await store.enqueueExecution({ id: "trig:wf:n:h", workflowId: "wf", payload: { executionId: "run-c" }, replaceFinishedBefore: past })).toBe(false);
    // Without a window an existing item always wins.
    expect(await store.enqueueExecution({ id: "trig:wf:n:h", workflowId: "wf", payload: { executionId: "run-c" } })).toBe(false);
    expect((await store.getQueueItemOutcome("trig:wf:n:h"))?.status).toBe("completed");

    // Finished and created before the window: the new job replaces it, as a fresh pending item.
    expect(await store.enqueueExecution({ id: "trig:wf:n:h", workflowId: "wf", payload: { executionId: "run-d" }, replaceFinishedBefore: future })).toBe(true);
    expect(await store.getQueueItemOutcome("trig:wf:n:h")).toEqual({ status: "pending", result: null, lastError: null, attempts: 0 });
    expect(await store.listExecutionIdsWithActiveQueueJob(["run-a", "run-d"])).toEqual(["run-d"]);
    const [again] = await store.claimQueueItems({ limit: 1, owner: "w2", pools: ["default"] });
    expect(again?.payload).toMatchObject({ executionId: "run-d" });
    expect(again?.attempts).toBe(0);
  });

  it("the history retention prune removes finished queue items and dead-letter entries, never pending or running ones", async () => {
    const store = ctx.store();
    await store.enqueueExecution({ id: "done", workflowId: "wf", payload: { executionId: "done" } });
    await store.enqueueExecution({ id: "dead", workflowId: "wf", payload: { executionId: "dead" }, maxAttempts: 1 });
    await store.enqueueExecution({ id: "busy", workflowId: "wf", payload: { executionId: "busy" } });
    await store.enqueueExecution({ id: "waiting", workflowId: "wf", payload: { executionId: "waiting" }, scheduledAt: new Date(Date.now() + 3_600_000).toISOString() });
    const claims = await store.claimQueueItems({ limit: 3, owner: "w1", pools: ["default"] });
    const tokenOf = (id: string) => claims.find((job) => job.id === id)!.claimToken!;
    await store.markQueueItemCompleted("done", { claimToken: tokenOf("done") });
    await store.markQueueItemFailed("dead", "boom", { retryable: false, claimToken: tokenOf("dead") });
    expect((await store.listDlqItems()).map((item) => item.originalId)).toEqual(["dead"]);

    // A cutoff before they finished keeps them.
    await store.pruneExecutionHistory({ before: new Date(Date.now() - 60_000).toISOString() });
    expect(await store.getQueueItemOutcome("done")).not.toBeNull();
    expect(await store.listDlqItems()).toHaveLength(1);

    await store.pruneExecutionHistory({ before: new Date(Date.now() + 60_000).toISOString() });
    expect(await store.getQueueItemOutcome("done")).toBeNull();
    expect(await store.getQueueItemOutcome("dead")).toBeNull();
    expect(await store.listDlqItems()).toEqual([]);
    expect((await store.getQueueItemOutcome("busy"))?.status).toBe("running");
    expect((await store.getQueueItemOutcome("waiting"))?.status).toBe("pending");
  });
});
