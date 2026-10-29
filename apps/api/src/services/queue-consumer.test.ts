/**
 * Phase 13.1 — the queue consumer and producer on their own (SQLite store): the unleased single-instance path, leased
 * claims with heartbeats, a lost lease stopping the job, self-fencing when renewals fail, the cancel backstop, the
 * shutdown drain (finish or give back without counting an attempt) and enqueue backpressure.
 */
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { createTestStore, type TestStore } from "../test-support/test-store.js";
import {
  QueueConsumer,
  QueueDrainAbort,
  QueueFullError,
  QueueLeaseLostAbort,
  QueueProducer,
  QueueService,
  type LagHistogram,
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
    expect(seen).toEqual([{ queueItemId: executionId, claimToken: null, signal: expect.any(AbortSignal), attempts: 0, pool: "default", leaseFresh: expect.any(Function), leaseLost: expect.any(Function) }]);
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

  it("a renew that hangs does not hold the self-fence back: the job stops, claiming pauses, and resumes once renewals answer", async () => {
    const store = await setup();
    const hanging = Object.create(store) as Store;
    let hang = true;
    hanging.renewQueueLeases = (input) => (hang ? new Promise<string[]>(() => undefined) : store.renewQueueLeases(input));
    hanging.countPendingQueueItems = (pool) => (hang ? new Promise<number>(() => undefined) : store.countPendingQueueItems(pool));
    const queue = consumer(hanging, { concurrency: 1 });
    queue.enableLeases({ instanceId: "w1", heartbeatMs: 20, leaseMs: 150, reaperIntervalMs: 60_000, pools: ["default"] });
    const logs: string[] = [];
    queue.setObserver({ log: (_level, message) => logs.push(message) });
    const blocking = blockingHandler();
    queue.setHandler(blocking.handler);
    await queue.enqueue({ workflowId: "wf" });
    queue.start();
    await until(() => blocking.calls.length === 1, "the job to start");
    const first = blocking.calls[0]!.context;
    await until(() => first.signal.aborted, "the self-fence");
    expect(first.signal.reason).toBeInstanceOf(QueueLeaseLostAbort);
    expect(first.leaseFresh()).toBe(false);
    expect(logs).toContain("Queue leases could not be confirmed in time: stopping their jobs and claiming nothing new");
    await until(() => queue.inFlightCount() === 0, "the job to wind down");
    // Its row is still claimed (the reaper takes it back); a new job is not claimed while leases cannot be confirmed.
    await queue.enqueue({ workflowId: "wf2" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(blocking.calls).toHaveLength(1);
    hang = false;
    await until(() => blocking.calls.length === 2, "claiming to resume");
    expect(logs).toContain("Queue leases confirmed again: claiming resumes");
    expect(blocking.calls[1]!.context.leaseFresh()).toBe(true);
    blocking.release();
  });

  it("a refused fenced write stops the job at once (leaseLost), and an unleased job always reads as fresh", async () => {
    const store = await setup();
    const queue = consumer(store);
    queue.enableLeases({ instanceId: "w1", heartbeatMs: 1_000, leaseMs: 60_000, reaperIntervalMs: 60_000, pools: ["default"] });
    queue.setObserver({ log: () => undefined });
    const blocking = blockingHandler();
    queue.setHandler(blocking.handler);
    await queue.enqueue({ workflowId: "wf" });
    queue.start();
    await until(() => blocking.calls.length === 1, "the job to start");
    const context = blocking.calls[0]!.context;
    expect(context.leaseFresh()).toBe(true);
    context.leaseLost("a progress write was refused");
    expect(context.signal.aborted).toBe(true);
    expect(context.signal.reason).toBeInstanceOf(QueueLeaseLostAbort);
    expect(context.leaseFresh()).toBe(false);
    await until(() => queue.inFlightCount() === 0, "the job to wind down");
    // Not completed here: the job is the queue's (the reaper's) again.
    expect(await store.getQueueDepth()).toEqual({ pending: 0, running: 1, dlq: 0 });

    queue.stopClaiming();
    const plain = consumer(store);
    const unleased = blockingHandler();
    plain.setHandler(unleased.handler);
    await store.enqueueExecution({ id: "plain", workflowId: "wf", payload: { executionId: "plain" } });
    plain.start();
    await until(() => unleased.calls.length === 1, "the unleased job to start");
    expect(unleased.calls[0]!.context.leaseFresh()).toBe(true);
    unleased.release();
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
    // One run already completed a node (its worker marked the claim before the node started): not re-run silently.
    const halfwayContext = blocking.calls.find((call) => call.context.queueItemId === halfway)!.context;
    expect(await store.markQueueEffectsStarted({ queueItemId: halfway, claimToken: halfwayContext.claimToken! })).toBe(true);
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

describe("queue claim gates", () => {
  let test: TestStore | undefined;
  const consumers: QueueConsumer[] = [];
  afterEach(async () => {
    for (const consumer of consumers.splice(0)) consumer.stop();
    await test?.cleanup();
    test = undefined;
  });

  const MB = 1024 * 1024;

  /** A consumer whose claims are counted, with fake probes. */
  async function gated(config: ConstructorParameters<typeof QueueConsumer>[1]) {
    test = await createTestStore({ kind: "sqlite" });
    const queue = new QueueConsumer(test.store, { pollIntervalMs: 15, concurrency: 5, ...config });
    consumers.push(queue);
    queue.setObserver({ log: () => undefined });
    const blocking = blockingHandler();
    /** When each job was handed over: one poll claims its batch within one tick, the next poll comes 15 ms later. */
    const claimedAt: number[] = [];
    queue.setHandler(async (payload, context) => {
      claimedAt.push(performance.now());
      await blocking.handler(payload, context);
    });
    for (let i = 0; i < 8; i += 1) await queue.enqueue({ workflowId: `wf-${i}` });
    /** The first poll after the gate re-opened claimed exactly one job. */
    const firstPollTookOne = () => claimedAt.length >= 2 && claimedAt[1]! - claimedAt[0]! >= 10;
    return { queue, blocking, claimedAt, firstPollTookOne };
  }

  it("memory: closes above the limit, stays closed between the resume threshold and the limit, then re-opens with one job", async () => {
    let rss = 200 * MB;
    const { queue, blocking, firstPollTookOne } = await gated({ maxRssMb: 100, probes: { rssBytes: () => rss } });
    queue.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(blocking.calls).toHaveLength(0);
    // Just under the limit: a gate without hysteresis would claim every free slot here.
    rss = 95 * MB;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(blocking.calls).toHaveLength(0);
    rss = 80 * MB;
    // The first poll after re-opening takes one job; later polls take the rest of the slots.
    await until(() => blocking.calls.length === 5, "the slots to fill");
    expect(firstPollTookOne()).toBe(true);
    blocking.release();
  });

  it("event-loop lag: a fresh, empty window right after a reset does not re-open a closed gate", async () => {
    const window = { p99Ms: 500, count: 50 };
    const histogram: LagHistogram = {
      enable: () => undefined,
      disable: () => undefined,
      reset: () => {
        window.count = 0;
      },
      percentile: () => window.p99Ms * 1e6,
      get count() {
        return window.count;
      }
    };
    const { queue, blocking, firstPollTookOne } = await gated({ maxEventLoopLagMs: 100, probes: { createLagHistogram: () => histogram } });
    queue.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(blocking.calls).toHaveLength(0);
    // The window resets (no samples yet) after a second: the last full window's 500 ms p99 still counts.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(window.count).toBe(0);
    expect(blocking.calls).toHaveLength(0);
    // Calm now, but only just under the limit: still closed (resume below 80 ms).
    window.p99Ms = 90;
    window.count = 50;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    window.count = 50;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(blocking.calls).toHaveLength(0);
    window.p99Ms = 20;
    await until(() => blocking.calls.length === 5, "claiming to resume", 5_000);
    expect(firstPollTookOne()).toBe(true);
    blocking.release();
  }, 15_000);
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
