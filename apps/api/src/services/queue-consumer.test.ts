/**
 * Phase 13.1 — the queue consumer and producer on their own (SQLite store): the unleased single-instance path, leased
 * claims with heartbeats, a lost lease stopping the job, self-fencing when renewals fail, the cancel backstop, the
 * shutdown drain (finish or give back without counting an attempt) and enqueue backpressure.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createTestStore, type TestStore } from "../test-support/test-store.js";
import {
  QueueConsumer,
  QueueDrainAbort,
  QueueFullError,
  QueueLeaseLostAbort,
  QueueProducer,
  QueueService,
  type QueueJobContext,
  type QueuedExecutionPayload
} from "./queue-service.js";
import type { Store } from "../db/store.js";
import { WORKER_SHUTDOWN_INTERRUPTED_ERROR } from "../db/queue-leases.js";

async function until<T>(read: () => T | Promise<T>, what: string, timeoutMs = 10_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A handler that records each call and waits until released (or its signal aborts). */
function blockingHandler() {
  const calls: Array<{ payload: QueuedExecutionPayload; context: QueueJobContext }> = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handler = async (payload: QueuedExecutionPayload, context: QueueJobContext) => {
    calls.push({ payload, context });
    await Promise.race([
      gate,
      new Promise<void>((resolve) => {
        if (context.signal.aborted) resolve();
        context.signal.addEventListener("abort", () => resolve(), { once: true });
      })
    ]);
  };
  return { calls, handler, release: () => release() };
}

describe("queue consumer", () => {
  let test: TestStore | undefined;
  const consumers: QueueConsumer[] = [];

  afterEach(async () => {
    for (const consumer of consumers.splice(0)) consumer.stop();
    await test?.cleanup();
    test = undefined;
  });

  async function setup(): Promise<Store> {
    test = await createTestStore({ kind: "sqlite" });
    return test.store;
  }

  function consumer(store: Store, config: ConstructorParameters<typeof QueueConsumer>[1] = {}): QueueConsumer {
    const created = new QueueConsumer(store, { pollIntervalMs: 20, ...config });
    consumers.push(created);
    return created;
  }

  it("keeps the original name and the unleased path: no token, completion unfenced", async () => {
    const store = await setup();
    expect(QueueService).toBe(QueueConsumer);
    const queue = consumer(store);
    const seen: QueueJobContext[] = [];
    queue.setHandler(async (_payload, context) => {
      seen.push(context);
    });
    const executionId = await queue.enqueue({ workflowId: "wf" });
    queue.start();
    await until(async () => (await store.getQueueDepth()).pending === 0 && (await store.getQueueDepth()).running === 0, "the job to complete");
    expect(seen).toEqual([{ queueItemId: executionId, claimToken: null, signal: expect.any(AbortSignal), attempts: 0, pool: "default" }]);
    expect(queue.leaseOptions()).toBeNull();
  });

  it("a leased claim hands the token to the handler and completes fenced on it", async () => {
    const store = await setup();
    const queue = consumer(store);
    queue.enableLeases({ instanceId: "w1", heartbeatMs: 30, leaseMs: 60_000, reaperIntervalMs: 60_000, pools: ["default"] });
    const tokens: Array<string | null> = [];
    queue.setHandler(async (_payload, context) => {
      tokens.push(context.claimToken);
    });
    await queue.enqueue({ workflowId: "wf" });
    queue.start();
    await until(async () => (await store.getQueueDepth()).running === 0 && tokens.length === 1, "the job to complete");
    expect(tokens[0]).toEqual(expect.any(String));
    expect(await store.getQueueDepth()).toEqual({ pending: 0, running: 0, dlq: 0 });
    expect(() => queue.enableLeases({ instanceId: "w1", heartbeatMs: 30, leaseMs: 60_000, reaperIntervalMs: 60_000, pools: ["default"] })).toThrow(/before start/);
  });

  it("a job whose lease was taken back is stopped at the next heartbeat and not completed here", async () => {
    const store = await setup();
    const queue = consumer(store, { concurrency: 1 });
    queue.enableLeases({ instanceId: "w1", heartbeatMs: 30, leaseMs: 60_000, reaperIntervalMs: 60_000, pools: ["default"] });
    const blocking = blockingHandler();
    queue.setHandler(blocking.handler);
    const executionId = await queue.enqueue({ workflowId: "wf" });
    queue.start();
    await until(() => blocking.calls.length === 1, "the job to start");
    // Another instance's reaper takes it back (its lease looks expired from there).
    queue.stopClaiming();
    await until(async () => (await store.reapExpiredQueueLeases({ leaseMs: 1 })).length > 0, "the reap");
    const signal = blocking.calls[0]!.context.signal;
    await until(() => signal.aborted, "the job to be stopped");
    expect(signal.reason).toBeInstanceOf(QueueLeaseLostAbort);
    await until(() => queue.inFlightCount() === 0, "the job to wind down");
    // Still pending for the next claimant: the stopped worker neither completed nor failed it.
    expect(await store.getQueueDepth()).toEqual({ pending: 1, running: 0, dlq: 0 });
    expect(await store.hasActiveQueueItem(executionId)).toBe(true);
  });

  it("a worker that cannot renew its leases stops its jobs before the lease runs out", async () => {
    const store = await setup();
    const failing = Object.create(store) as Store;
    failing.renewQueueLeases = async () => {
      throw new Error("database unreachable");
    };
    const queue = consumer(failing);
    queue.enableLeases({ instanceId: "w1", heartbeatMs: 20, leaseMs: 120, reaperIntervalMs: 60_000, pools: ["default"] });
    const logs: string[] = [];
    queue.setObserver({ log: (_level, message) => logs.push(message) });
    const blocking = blockingHandler();
    queue.setHandler(blocking.handler);
    await queue.enqueue({ workflowId: "wf" });
    queue.start();
    await until(() => blocking.calls.length === 1, "the job to start");
    const signal = blocking.calls[0]!.context.signal;
    await until(() => signal.aborted, "the self-fence");
    expect(signal.reason).toBeInstanceOf(QueueLeaseLostAbort);
    expect(logs).toContain("Failed to renew queue leases");
  });

  it("a cancel recorded elsewhere reaches the cancel handler on the heartbeat", async () => {
    const store = await setup();
    const queue = consumer(store);
    queue.enableLeases({ instanceId: "w1", heartbeatMs: 20, leaseMs: 60_000, reaperIntervalMs: 60_000, pools: ["default"] });
    const canceled: string[] = [];
    queue.setCancelHandler((executionId) => canceled.push(executionId));
    const blocking = blockingHandler();
    queue.setHandler(blocking.handler);
    const executionId = await queue.enqueue({ workflowId: "wf" });
    queue.start();
    await until(() => blocking.calls.length === 1, "the job to start");
    await store.saveExecutionHistory({ id: executionId, workflowId: "wf", status: "canceled", startedAt: new Date().toISOString() });
    await until(() => canceled.includes(executionId), "the cancel to be noticed");
    blocking.release();
  });

  it("the reaper runs only behind the sweep gate", async () => {
    const store = await setup();
    await store.enqueueExecution({ id: "orphan", workflowId: "wf", payload: { executionId: "orphan" } });
    await store.claimQueueItems({ limit: 1, owner: "dead-worker", pools: ["default"] });
    const queue = consumer(store);
    queue.enableLeases({ instanceId: "w1", heartbeatMs: 20, leaseMs: 300, reaperIntervalMs: 20, pools: ["default"] });
    let leader = false;
    queue.setSweepGate(() => leader);
    const lost: string[] = [];
    queue.setObserver({ onLost: (outcomes) => lost.push(...outcomes.map((outcome) => `${outcome.id}:${outcome.decision}`)), log: () => undefined });
    queue.start();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(lost).toEqual([]);
    leader = true;
    await until(() => lost.length > 0, "the reap");
    expect(lost).toEqual(["orphan:requeue"]);
  });

  it("a drain lets a job finish within the timeout", async () => {
    const store = await setup();
    const queue = consumer(store);
    const blocking = blockingHandler();
    queue.setHandler(blocking.handler);
    await queue.enqueue({ workflowId: "wf" });
    queue.start();
    await until(() => blocking.calls.length === 1, "the job to start");
    setTimeout(() => blocking.release(), 50);
    expect(await queue.drain(5_000)).toEqual({ finished: 1, released: 0 });
    expect(await store.getQueueDepth()).toEqual({ pending: 0, running: 0, dlq: 0 });
    // No more claims after a drain.
    await queue.enqueue({ workflowId: "wf" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(blocking.calls).toHaveLength(1);
  });

  it("a drain stops what is still running and gives it back without counting an attempt", async () => {
    const store = await setup();
    const queue = consumer(store, { concurrency: 2 });
    queue.enableLeases({ instanceId: "w1", heartbeatMs: 20, leaseMs: 60_000, reaperIntervalMs: 60_000, pools: ["default"] });
    queue.setObserver({ log: () => undefined });
    const blocking = blockingHandler();
    queue.setHandler(blocking.handler);
    const fresh = await queue.enqueue({ workflowId: "wf", maxAttempts: 1 });
    const halfway = await queue.enqueue({ workflowId: "wf2" });
    queue.start();
    await until(() => blocking.calls.length === 2, "both jobs to start");
    // One run already completed a node: it is not re-run silently.
    await store.saveExecutionHistory({
      id: halfway,
      workflowId: "wf2",
      status: "running",
      startedAt: new Date().toISOString(),
      nodeResultsJson: [{ nodeId: "email", status: "success" }]
    });
    expect(await queue.drain(30)).toEqual({ finished: 0, released: 2 });
    for (const call of blocking.calls) expect(call.context.signal.reason).toBeInstanceOf(QueueDrainAbort);
    expect(await store.getExecutionHistory(halfway)).toMatchObject({ status: "error", error: WORKER_SHUTDOWN_INTERRUPTED_ERROR });
    expect((await store.listDlqItems()).map((item) => [item.originalId, item.attempts])).toEqual([[halfway, 0]]);
    // The fresh job is pending again with its one attempt unused.
    const [again] = await store.claimQueueItems({ limit: 1, owner: "w2", pools: ["default"] });
    expect(again).toMatchObject({ id: fresh, attempts: 0 });
  });

  it("a drain gives back a job whose handler ignores the stop", async () => {
    const store = await setup();
    const queue = consumer(store);
    queue.setObserver({ log: () => undefined });
    let finish: () => void = () => undefined;
    queue.setHandler(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    await queue.enqueue({ workflowId: "wf" });
    queue.start();
    await until(async () => (await store.getQueueDepth()).running === 1, "the job to start");
    expect(await queue.drain(20, 20)).toEqual({ finished: 0, released: 1 });
    expect(await store.getQueueDepth()).toEqual({ pending: 1, running: 0, dlq: 0 });
    finish();
  });

  it("stops claiming above the memory limit", async () => {
    const store = await setup();
    const queue = consumer(store, { maxRssMb: 64 });
    let ran = 0;
    queue.setHandler(async () => {
      ran += 1;
    });
    await queue.enqueue({ workflowId: "wf" });
    queue.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    // A test process holds far more than 64 MB, so nothing is claimed.
    expect(ran).toBe(0);
    expect(await store.getQueueDepth()).toEqual({ pending: 1, running: 0, dlq: 0 });
  });
});

describe("queue producer", () => {
  let test: TestStore | undefined;
  afterEach(async () => {
    await test?.cleanup();
    test = undefined;
  });

  it("refuses an enforced enqueue once the pool holds QUEUE_MAX_PENDING jobs; other pools and internal enqueues pass", async () => {
    test = await createTestStore({ kind: "sqlite" });
    const producer = new QueueProducer(test.store, { maxPending: 2 });
    await producer.enqueue({ workflowId: "wf" }, { enforceBackpressure: true });
    await producer.enqueue({ workflowId: "wf" }, { enforceBackpressure: true });
    const refused = await producer.enqueue({ workflowId: "wf" }, { enforceBackpressure: true }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(QueueFullError);
    expect(refused).toMatchObject({ pool: "default", retryAfterSeconds: 5 });
    await producer.enqueue({ workflowId: "wf", pool: "gpu" }, { enforceBackpressure: true });
    await producer.enqueue({ workflowId: "wf" });
    expect(await producer.getDepthByPool()).toEqual([
      { pool: "default", pending: 3, running: 0 },
      { pool: "gpu", pending: 1, running: 0 }
    ]);
    await expect(producer.enqueue({ workflowId: "wf", pool: "bad pool" })).rejects.toThrow(/Invalid queue pool/);
    // No limit set: never refused.
    const open = new QueueProducer(test.store);
    for (let i = 0; i < 5; i += 1) await open.enqueue({ workflowId: "wf" }, { enforceBackpressure: true });
  });
});
