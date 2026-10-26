/**
 * Phase 13.1 — store contract: the execution queue, on both stores. On Postgres `dequeueNext` claims with
 * FOR UPDATE SKIP LOCKED, so concurrent pollers never claim one job twice.
 */
import { expect, it } from "vitest";
import { describeStoreContract } from "../../test-support/test-store.js";

const past = (ms: number) => new Date(Date.now() - ms).toISOString();

describeStoreContract("store contract: execution queue", (ctx) => {
  it("claims due jobs by priority then schedule, moves them to running, and skips future ones", async () => {
    const store = ctx.store();
    await store.enqueueExecution({ id: "low-old", workflowId: "wf", workflowName: "Flow", payload: { a: 1 }, scheduledAt: past(5_000) });
    await store.enqueueExecution({ id: "high", workflowId: "wf", payload: {}, priority: 5, scheduledAt: past(1_000) });
    await store.enqueueExecution({ id: "low-new", workflowId: "wf", payload: {}, scheduledAt: past(2_000), maxAttempts: 7 });
    await store.enqueueExecution({ id: "later", workflowId: "wf", payload: {}, scheduledAt: new Date(Date.now() + 60_000).toISOString() });
    // An existing id is left alone.
    await store.enqueueExecution({ id: "high", workflowId: "other", payload: { replaced: true }, priority: 0 });

    const first = await store.dequeueNext(2);
    expect(first.map((job) => job.id)).toEqual(["high", "low-old"]);
    expect(first[1]).toEqual({ id: "low-old", workflowId: "wf", workflowName: "Flow", payload: { a: 1 }, attempts: 0, maxAttempts: 3, scheduledAt: expect.any(String) });
    expect(first[0]?.workflowName).toBeNull();
    const second = await store.dequeueNext(5);
    expect(second.map((job) => [job.id, job.maxAttempts])).toEqual([["low-new", 7]]);
    expect(await store.dequeueNext()).toEqual([]);
    expect(await store.getQueueDepth()).toEqual({ pending: 1, running: 3, dlq: 0 });
  });

  it("hasActiveQueueItem matches the id or an `<id>:` job while pending or running", async () => {
    const store = ctx.store();
    await store.enqueueExecution({ id: "sched_1:2026", workflowId: "wf", payload: {} });
    await store.enqueueExecution({ id: "a_b", workflowId: "wf", payload: {} });
    expect(await store.hasActiveQueueItem("sched_1")).toBe(true);
    expect(await store.hasActiveQueueItem("sched_1:2026")).toBe(true);
    expect(await store.hasActiveQueueItem("sched")).toBe(false);
    // `_` and `%` are literal.
    expect(await store.hasActiveQueueItem("a%")).toBe(false);
    expect(await store.hasActiveQueueItem("axb")).toBe(false);
    await store.markQueueItemCompleted("sched_1:2026");
    expect(await store.hasActiveQueueItem("sched_1")).toBe(false);
  });

  it("a failure retries with backoff, then dead-letters; a non-retryable failure dead-letters at once", async () => {
    const store = ctx.store();
    await store.enqueueExecution({ id: "j1", workflowId: "wf", workflowName: "Flow", payload: {}, maxAttempts: 2, scheduledAt: past(1_000) });
    await store.dequeueNext();
    await store.markQueueItemFailed("j1", "boom");
    expect(await store.dequeueNext()).toEqual([]);
    expect(await store.getQueueDepth()).toEqual({ pending: 1, running: 0, dlq: 0 });
    await store.markQueueItemFailed("j1", "boom again");
    const dlq = await store.listDlqItems();
    expect(dlq).toEqual([{ id: expect.any(String), originalId: "j1", workflowId: "wf", workflowName: "Flow", attempts: 2, finalError: "boom again", failedAt: expect.any(String) }]);
    expect(await store.hasActiveQueueItem("j1")).toBe(false);

    await store.enqueueExecution({ id: "j2", workflowId: "wf2", payload: {} });
    await store.markQueueItemFailed("j2", "bad input", { retryable: false });
    expect((await store.listDlqItems(50, ["wf2"])).map((item) => [item.originalId, item.attempts])).toEqual([["j2", 1]]);
    expect(await store.listDlqItems(50, [])).toEqual([]);
    await store.markQueueItemFailed("missing", "x");
  });

  it("concurrent pollers claim every job exactly once", async () => {
    const store = ctx.store();
    const ids = Array.from({ length: 40 }, (_, i) => `job-${i}`);
    for (const id of ids) await store.enqueueExecution({ id, workflowId: "wf", payload: {}, scheduledAt: past(1_000) });
    const claimed: string[] = [];
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        for (;;) {
          const batch = await store.dequeueNext(3);
          if (batch.length === 0) return;
          claimed.push(...batch.map((job) => job.id));
        }
      })
    );
    expect(claimed.sort()).toEqual([...ids].sort());
  });
});
