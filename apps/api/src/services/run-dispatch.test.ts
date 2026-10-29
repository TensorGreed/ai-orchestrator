import { describe, expect, it } from "vitest";
import type { WorkflowExecutionResult } from "@ai-orchestrator/shared";
import type { ClusterInstanceRecord } from "../db/store.js";
import {
  cronQueueItemId,
  decideDispatch,
  DispatchBusyError,
  DispatchClientGoneError,
  DispatchFailedError,
  DispatchGate,
  DispatchTimeoutError,
  QUEUE_DISPATCH_CAPABILITY,
  readDispatchedRunSpec,
  RunDispatcher,
  triggerQueueItemId,
  type DispatchedRunSpec,
  type RunDispatcherDeps
} from "./run-dispatch.js";
import { QueueFullError } from "./queue-service.js";
import type { RunRelayEnd } from "./run-event-relay.js";

const instance = (overrides: Partial<ClusterInstanceRecord>): ClusterInstanceRecord => ({
  id: "w1",
  workerMode: "worker",
  haEnabled: true,
  isLeader: false,
  pools: ["default"],
  concurrency: 5,
  running: 0,
  appVersion: "1.0.0",
  schemaVersion: 46,
  capabilities: ["bus-v1", "fenced-claims-v1", QUEUE_DISPATCH_CAPABILITY],
  hostname: "h",
  busConnected: true,
  startedAt: "s",
  heartbeatAt: "h",
  live: true,
  ...overrides
});

const spec = (executionId = "exec-1"): DispatchedRunSpec => ({
  v: 1,
  run: { executionId, triggerType: "manual", workflow: { id: "wf", name: "Flow", nodes: [], edges: [] } as never },
  progress: null,
  history: {}
});

describe("decideDispatch (capability gate)", () => {
  it("queues only while live consumers serve the pool and all of them can run dispatched jobs", () => {
    expect(decideDispatch([], "default")).toMatchObject({ queue: false, reason: expect.stringContaining("no live queue consumer") });
    expect(decideDispatch([instance({})], "default")).toEqual({ queue: true, reason: null });
    // An api replica, a stopped worker and another pool's worker do not count.
    expect(
      decideDispatch(
        [instance({}), instance({ id: "api", workerMode: "api", capabilities: [] }), instance({ id: "dead", live: false, capabilities: [] }), instance({ id: "gpu", pools: ["gpu"], capabilities: [] })],
        "default"
      )
    ).toEqual({ queue: true, reason: null });
    const mixed = decideDispatch([instance({}), instance({ id: "old", appVersion: "0.9.0", capabilities: ["bus-v1"] })], "default");
    expect(mixed.queue).toBe(false);
    expect(mixed.reason).toContain("old (0.9.0)");
    expect(decideDispatch([instance({})], "gpu").queue).toBe(false);
  });

  it("DispatchGate never reads the registry with inline, caches a decision, reports changes once, and falls back when the read fails", async () => {
    let reads = 0;
    let now = 0;
    let instances = [instance({})];
    const changes: Array<[boolean, string | null]> = [];
    const inline = new DispatchGate({ mode: "inline", listInstances: async () => (reads += 1, instances) });
    expect(await inline.useQueue("default")).toBe(false);
    expect(reads).toBe(0);
    expect(inline.status()).toEqual({ mode: "inline", fallback: false, reason: null });

    let fail = false;
    const gate = new DispatchGate({
      mode: "queue",
      listInstances: async () => {
        reads += 1;
        if (fail) throw new Error("db down");
        return instances;
      },
      onChange: (fallback, reason) => changes.push([fallback, reason]),
      cacheMs: 1_000,
      now: () => now
    });
    expect(await gate.useQueue("default")).toBe(true);
    instances = [instance({ capabilities: [] })];
    expect(await gate.useQueue("default")).toBe(true);
    expect(reads).toBe(1);
    now = 2_000;
    expect(await gate.useQueue("default")).toBe(false);
    expect(await gate.useQueue("default")).toBe(false);
    expect(gate.status()).toMatchObject({ mode: "queue", fallback: true });
    now = 4_000;
    fail = true;
    expect(await gate.useQueue("default")).toBe(false);
    expect(gate.status().reason).toContain("db down");
    now = 6_000;
    fail = false;
    instances = [instance({})];
    expect(await gate.useQueue("default")).toBe(true);
    expect(changes.map(([fallback]) => fallback)).toEqual([true, true, false]);
  });
});

describe("queue item ids", () => {
  it("a schedule's fire is keyed on the matched second", () => {
    expect(cronQueueItemId("wf", "cron1", "2026-10-29T10:00:05.000Z", "2026-10-29T10:00:05.731Z")).toBe(`cron:wf:cron1:${Date.parse("2026-10-29T10:00:05Z") / 1000}`);
    expect(cronQueueItemId("wf", "cron1", undefined, "2026-10-29T10:00:05.731Z")).toBe(`cron:wf:cron1:${Date.parse("2026-10-29T10:00:05Z") / 1000}`);
  });

  it("a trigger's fire is keyed on what it reports, when it names it", () => {
    const rss = triggerQueueItemId("wf", "n", "rss", { rss_items: [{ id: "a" }, { id: "b" }] });
    expect(rss).toMatch(/^trig:wf:n:[0-9a-f]{32}$/);
    expect(triggerQueueItemId("wf", "n", "rss", { rss_items: [{ id: "a" }, { id: "b" }], feed_url: "other" })).toBe(rss);
    expect(triggerQueueItemId("wf", "n", "rss", { rss_items: [{ id: "a" }, { id: "c" }] })).not.toBe(rss);
    expect(triggerQueueItemId("wf", "n", "sse", { sse_event: { event: "m", id: "42" } })).toMatch(/^trig:/);
    expect(triggerQueueItemId("wf", "n", "sse", { sse_event: { event: "m" } })).toBeNull();
    expect(triggerQueueItemId("wf", "n", "file", { file_events: [{ path: "a", mtimeMs: 1 }] })).toMatch(/^trig:/);
    expect(triggerQueueItemId("wf", "n", "mq", { message: 1 })).toBeNull();
  });
});

describe("readDispatchedRunSpec", () => {
  it("accepts this build's format only", () => {
    expect(readDispatchedRunSpec(spec())).toEqual(spec());
    expect(readDispatchedRunSpec({ ...spec(), v: 2 })).toBeNull();
    expect(readDispatchedRunSpec({ ...spec(), run: { executionId: "x" } })).toBeNull();
    expect(readDispatchedRunSpec(null)).toBeNull();
  });
});

describe("RunDispatcher", () => {
  const result = { workflowId: "wf", status: "success", startedAt: "s", completedAt: "c", nodeResults: [] } as WorkflowExecutionResult;
  const make = (options: { queue: boolean; end?: RunRelayEnd; enqueueError?: Error; backpressure?: Error; maxWaiting?: number }) => {
    const calls: string[] = [];
    const deps: RunDispatcherDeps = {
      gate: new DispatchGate({ mode: options.queue ? "queue" : "inline", listInstances: async () => [instance({})] }),
      executeLocally: async () => (calls.push("local"), result),
      checkBackpressure: async () => {
        calls.push("backpressure");
        if (options.backpressure) throw options.backpressure;
      },
      recordQueued: async () => void calls.push("recordQueued"),
      recordNotQueued: async (_spec, error) => void calls.push(`recordNotQueued:${error}`),
      enqueue: async (_spec, enqueueOptions) => {
        calls.push(`enqueue:${enqueueOptions.queueItemId ?? "-"}`);
        if (options.enqueueError) throw options.enqueueError;
      },
      openRelay: async () => {
        calls.push("subscribe");
        return {
          ended: () => (options.end ? Promise.resolve(options.end) : new Promise<RunRelayEnd>(() => undefined)),
          check: () => undefined,
          close: () => void calls.push("close")
        };
      },
      waitTimeoutMs: () => 1_000,
      maxWaiting: options.maxWaiting ?? 10
    };
    return { dispatcher: new RunDispatcher(deps), calls };
  };

  it("inline runs in this process and never touches the queue", async () => {
    const { dispatcher, calls } = make({ queue: false });
    expect(await dispatcher.run(spec(), { pool: "default", enforceBackpressure: true })).toBe(result);
    expect(await dispatcher.fire(spec(), { pool: "default", queueItemId: "cron:x" })).toEqual({ queued: false });
    expect(calls).toEqual(["local", "local"]);
  });

  it("queue subscribes, records and enqueues in that order, then answers with the relayed result", async () => {
    const { dispatcher, calls } = make({ queue: true, end: { kind: "result", result: { ...result, warnings: ["w"] } } });
    expect(await dispatcher.run(spec(), { pool: "default", enforceBackpressure: true })).toEqual({ ...result, warnings: ["w"] });
    expect(calls).toEqual(["backpressure", "subscribe", "recordQueued", "enqueue:-", "close"]);
    expect(dispatcher.waitingCount()).toBe(0);
  });

  it("maps a dead job, a timeout and a client that went away to their errors", async () => {
    await expect(make({ queue: true, end: { kind: "failed", error: "boom" } }).dispatcher.run(spec(), { pool: "default" })).rejects.toBeInstanceOf(DispatchFailedError);
    await expect(make({ queue: true, end: { kind: "timeout" } }).dispatcher.run(spec(), { pool: "default" })).rejects.toBeInstanceOf(DispatchTimeoutError);
    await expect(make({ queue: true }).dispatcher.run(spec(), { pool: "default", closed: Promise.resolve() })).rejects.toBeInstanceOf(DispatchClientGoneError);
  });

  it("a refused or failed enqueue ends the queued record and is thrown; a full pool is refused before anything is written", async () => {
    const failed = make({ queue: true, enqueueError: new Error("db down") });
    await expect(failed.dispatcher.run(spec(), { pool: "default" })).rejects.toThrow("db down");
    expect(failed.calls).toEqual(["subscribe", "recordQueued", "enqueue:-", "recordNotQueued:The run could not be queued: db down", "close"]);

    const full = make({ queue: true, backpressure: new QueueFullError("default", 1, 5) });
    await expect(full.dispatcher.run(spec(), { pool: "default", enforceBackpressure: true })).rejects.toBeInstanceOf(QueueFullError);
    expect(full.calls).toEqual(["backpressure"]);
  });

  it("refuses with 503 once DISPATCH_MAX_WAITING requests wait", async () => {
    const { dispatcher } = make({ queue: true, maxWaiting: 1 });
    const first = dispatcher.run(spec("a"), { pool: "default" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(dispatcher.waitingCount()).toBe(1);
    const second = dispatcher.run(spec("b"), { pool: "default" });
    await expect(second).rejects.toBeInstanceOf(DispatchBusyError);
    await expect(second).rejects.toMatchObject({ statusCode: 503 });
    void first.catch(() => undefined);
  });

  it("fire enqueues under the idempotent id without waiting", async () => {
    const { dispatcher, calls } = make({ queue: true });
    expect(await dispatcher.fire(spec(), { pool: "default", queueItemId: "cron:wf:n:1" })).toEqual({ queued: true });
    expect(calls).toEqual(["enqueue:cron:wf:n:1"]);
  });
});
