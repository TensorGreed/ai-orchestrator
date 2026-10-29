/**
 * Phase 13.1 — store contract: queue dispatch, on both stores. The worker that runs a dispatched job stores the run's
 * result on its queue item under its claim; the instance waiting on the run reads the item's status, result and last
 * error.
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
});
