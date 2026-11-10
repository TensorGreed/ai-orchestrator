import { describe, expect, it, vi } from "vitest";
import { RESPONSE_WITHHELD_MESSAGE, type DataLabels, type WorkflowExecutionResult } from "@ai-orchestrator/shared";
import { adoptOutputLabels, outputLabelsOf } from "@ai-orchestrator/workflow-engine";
import type { ClusterInstanceRecord } from "../db/store.js";
import {
  cronQueueItemId,
  decideDispatch,
  DispatchBusyError,
  FIRE_DEDUPE_WINDOW_MS,
  DispatchClientGoneError,
  DispatchFailedError,
  DispatchGate,
  DispatchTimeoutError,
  QUEUE_DISPATCH_CAPABILITY,
  QUEUE_RESULT_OUTPUT_LABELS_KEY,
  RESPONSE_BOUNDARY_CAPABILITY,
  capabilitiesFor,
  readDispatchedRunSpec,
  resultForQueue,
  resultFromQueue,
  RunDispatcher,
  triggerQueueItemId,
  type DispatchedRunSpec,
  type RunDispatcherDeps
} from "./run-dispatch.js";
import { QueueFullError } from "./queue-service.js";
import type { RunRelayEnd } from "./run-event-relay.js";
import { MetricsService } from "./metrics-service.js";

// The engine does not cap data classes, but it only adopts labels that validate: a test sets what a run produced.
const produced = vi.hoisted(() => ({ labels: undefined as unknown }));
vi.mock("@ai-orchestrator/workflow-engine", async (importOriginal) => {
  const engine = await importOriginal<typeof import("@ai-orchestrator/workflow-engine")>();
  return { ...engine, outputLabelsOf: (result: Parameters<typeof engine.outputLabelsOf>[0]) => (produced.labels as DataLabels | undefined) ?? engine.outputLabelsOf(result) };
});

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

  it("a run that answers an external caller needs workers that check responses (mixed versions go inline)", async () => {
    const current = instance({ capabilities: ["bus-v1", "fenced-claims-v1", QUEUE_DISPATCH_CAPABILITY, RESPONSE_BOUNDARY_CAPABILITY] });
    const older = instance({ id: "older", appVersion: "0.9.9" });
    expect(decideDispatch([current, older], "default")).toEqual({ queue: true, reason: null });
    const refused = decideDispatch([current, older], "default", [RESPONSE_BOUNDARY_CAPABILITY]);
    expect(refused.queue).toBe(false);
    expect(refused.reason).toContain(RESPONSE_BOUNDARY_CAPABILITY);
    expect(refused.reason).toContain("older (0.9.9)");
    expect(decideDispatch([current], "default", [RESPONSE_BOUNDARY_CAPABILITY])).toEqual({ queue: true, reason: null });

    const boundary: DispatchedRunSpec = { ...spec(), run: { ...spec().run, responseBoundary: { surface: "webhook" } } };
    expect(capabilitiesFor(spec())).toEqual([]);
    expect(capabilitiesFor(boundary)).toEqual([RESPONSE_BOUNDARY_CAPABILITY]);
    // The gate keeps one decision per pool and capability set.
    const reported: Array<{ label: string; inline: boolean; changed: boolean }> = [];
    const changes: boolean[] = [];
    const gate = new DispatchGate({
      mode: "queue",
      listInstances: async () => [current, older],
      onChange: (fallback) => void changes.push(fallback),
      onRequiredInline: ({ label, inline, changed }) => void reported.push({ label, inline, changed })
    });
    expect(await gate.useQueue("default")).toBe(true);
    expect(await gate.useQueue("default", capabilitiesFor(boundary))).toBe(false);
    expect(await gate.useQueue("default", capabilitiesFor(boundary))).toBe(false);
    expect(await gate.useQueue("default")).toBe(true);
    // Runs that need the capability report on their own label; the pool's status (and its warning) never flips.
    expect(gate.status()).toEqual({ mode: "queue", fallback: false, reason: null });
    expect(changes).toEqual([]);
    expect(reported).toEqual([
      { label: `capability:${RESPONSE_BOUNDARY_CAPABILITY}`, inline: true, changed: true },
      { label: `capability:${RESPONSE_BOUNDARY_CAPABILITY}`, inline: true, changed: false }
    ]);
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
  const make = (options: { queue: boolean; end?: RunRelayEnd; enqueueError?: Error; backpressure?: Error; maxWaiting?: number; duplicate?: boolean; instances?: ClusterInstanceRecord[] }) => {
    const calls: string[] = [];
    const deps: RunDispatcherDeps = {
      gate: new DispatchGate({ mode: options.queue ? "queue" : "inline", listInstances: async () => options.instances ?? [instance({})] }),
      executeLocally: async () => (calls.push("local"), result),
      checkBackpressure: async () => {
        calls.push("backpressure");
        if (options.backpressure) throw options.backpressure;
      },
      recordQueued: async () => void calls.push("recordQueued"),
      recordNotQueued: async (_spec, error) => void calls.push(`recordNotQueued:${error}`),
      enqueue: async (_spec, enqueueOptions) => {
        calls.push(`enqueue:${enqueueOptions.queueItemId ?? "-"}${enqueueOptions.dedupeWindowMs !== undefined ? `@${enqueueOptions.dedupeWindowMs}` : ""}`);
        if (options.enqueueError) throw options.enqueueError;
        return !options.duplicate;
      },
      releaseResult: async () => void calls.push("release"),
      onDeduplicated: (_spec, id) => void calls.push(`deduplicated:${id}`),
      onQueued: () => void calls.push("queued"),
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
    expect(await dispatcher.fire(spec(), { pool: "default", queueItemId: "cron:x" })).toEqual({ queued: false, result });
    expect(calls).toEqual(["local", "local"]);
  });

  it("queue subscribes, records and enqueues in that order, then answers with the relayed result", async () => {
    const { dispatcher, calls } = make({ queue: true, end: { kind: "result", result: { ...result, warnings: ["w"] } } });
    expect(await dispatcher.run(spec(), { pool: "default", enforceBackpressure: true })).toEqual({ ...result, warnings: ["w"] });
    // The delivered result is released from the queue row.
    expect(calls).toEqual(["backpressure", "subscribe", "recordQueued", "enqueue:-", "queued", "release", "close"]);
    expect(dispatcher.waitingCount()).toBe(0);
  });

  it("runs a response-boundary run inline while a worker of its pool cannot check responses, and queues it once all can", async () => {
    const boundary: DispatchedRunSpec = { ...spec(), run: { ...spec().run, responseBoundary: { surface: "chat" } } };
    const older = make({ queue: true, end: { kind: "result", result } });
    expect(await older.dispatcher.run(boundary, { pool: "default" })).toBe(result);
    expect(await older.dispatcher.fire(boundary, { pool: "default" })).toEqual({ queued: false, result });
    expect(older.calls).toEqual(["local", "local"]);
    const current = make({
      queue: true,
      end: { kind: "result", result },
      instances: [instance({ capabilities: ["bus-v1", "fenced-claims-v1", QUEUE_DISPATCH_CAPABILITY, RESPONSE_BOUNDARY_CAPABILITY] })]
    });
    await current.dispatcher.run(boundary, { pool: "default" });
    expect(current.calls).toContain("enqueue:-");
  });

  it("withholds a queued boundary run's result that no worker stamped (an older worker claimed it)", async () => {
    const boundary: DispatchedRunSpec = { ...spec(), run: { ...spec().run, responseBoundary: { surface: "webhook" } } };
    const capable = [instance({ capabilities: ["bus-v1", "fenced-claims-v1", QUEUE_DISPATCH_CAPABILITY, RESPONSE_BOUNDARY_CAPABILITY] })];
    const raw = { ...result, output: { result: "raw answer" } };
    const unstamped = make({ queue: true, end: { kind: "result", result: raw }, instances: capable });
    const answered = await unstamped.dispatcher.run(boundary, { pool: "default" });
    expect(answered.output).toEqual({ error: RESPONSE_WITHHELD_MESSAGE, code: "content_filter" });
    expect(answered.responseCheck).toMatchObject({ withheld: true });
    const stamped = { ...raw, responseRules: { surface: "webhook" as const, apply: false } };
    const checked = make({ queue: true, end: { kind: "result", result: stamped }, instances: capable });
    expect((await checked.dispatcher.run(boundary, { pool: "default" })).output).toEqual({ result: "raw answer" });
    // A run without a boundary is answered as it came.
    const plain = make({ queue: true, end: { kind: "result", result: raw } });
    expect((await plain.dispatcher.run(spec(), { pool: "default" })).output).toEqual({ result: "raw answer" });
  });

  it("answers with the output labels a worker stored beside the result, and without them when it stored none", async () => {
    const labels = { provenance: ["untrusted_external", "sensitive"], dataClasses: ["email"], source: "propagated" } as const;
    const ran = { ...result };
    adoptOutputLabels(ran, labels);
    // What the worker stores goes through JSON (the queue row).
    const stored = JSON.parse(JSON.stringify(resultForQueue(ran))) as unknown;
    expect(stored).toMatchObject({ [QUEUE_RESULT_OUTPUT_LABELS_KEY]: { provenance: ["untrusted_external", "sensitive"], dataClasses: ["email"] } });
    const answered = await make({ queue: true, end: { kind: "result", result: stored } }).dispatcher.run(spec(), { pool: "default" });
    expect(answered).toEqual(result);
    expect(answered).not.toHaveProperty(QUEUE_RESULT_OUTPUT_LABELS_KEY);
    expect(outputLabelsOf(answered)).toMatchObject({ provenance: ["untrusted_external", "sensitive"], dataClasses: ["email"] });
    // A worker that does not send them (or sends something unreadable): unknown, as before.
    const older = await make({ queue: true, end: { kind: "result", result: JSON.parse(JSON.stringify(result)) as unknown } }).dispatcher.run(spec(), { pool: "default" });
    expect(outputLabelsOf(older)).toBeUndefined();
    const garbled = resultFromQueue({ ...result, [QUEUE_RESULT_OUTPUT_LABELS_KEY]: { provenance: ["root"] } });
    expect(garbled).not.toHaveProperty(QUEUE_RESULT_OUTPUT_LABELS_KEY);
    expect(outputLabelsOf(garbled)).toBeUndefined();
    // A run without labels is stored as it is.
    expect(resultForQueue(result)).toBe(result);
  });

  it("stores at most 100 data classes so the labels validate, and keeps sensitive", async () => {
    const classes = Array.from({ length: 150 }, (_, index) => `class_${String(149 - index).padStart(3, "0")}`);
    produced.labels = { provenance: ["untrusted_external", "sensitive"], dataClasses: classes, source: "propagated" };
    const stored = JSON.parse(JSON.stringify(resultForQueue({ ...result }))) as Record<string, { dataClasses: string[] }>;
    produced.labels = undefined;
    expect(stored[QUEUE_RESULT_OUTPUT_LABELS_KEY]!.dataClasses).toEqual([...classes].sort().slice(0, 100));
    const answered = resultFromQueue(stored);
    expect(outputLabelsOf(answered)).toMatchObject({ provenance: ["untrusted_external", "sensitive"] });
    expect(outputLabelsOf(answered)?.dataClasses).toHaveLength(100);
  });

  it("maps a dead job, a timeout and a client that went away to their errors", async () => {
    await expect(make({ queue: true, end: { kind: "failed", error: "boom" } }).dispatcher.run(spec(), { pool: "default" })).rejects.toBeInstanceOf(DispatchFailedError);
    // The job's raw last error is kept for the log only, never in the message a client may see.
    const failed = (await make({ queue: true, end: { kind: "failed", error: "pg: password authentication failed for user x" } })
      .dispatcher.run(spec(), { pool: "default" })
      .catch((error: unknown) => error)) as DispatchFailedError;
    expect(failed.message).not.toContain("password");
    expect(failed.reason).toBe("pg: password authentication failed for user x");
    await expect(make({ queue: true, end: { kind: "timeout" } }).dispatcher.run(spec(), { pool: "default" })).rejects.toBeInstanceOf(DispatchTimeoutError);
    await expect(make({ queue: true }).dispatcher.run(spec(), { pool: "default", closed: Promise.resolve() })).rejects.toBeInstanceOf(DispatchClientGoneError);
  });

  it("a refused or failed enqueue ends the queued record and is thrown; a full pool is refused before anything is written", async () => {
    const failed = make({ queue: true, enqueueError: new Error("db down") });
    await expect(failed.dispatcher.run(spec(), { pool: "default" })).rejects.toThrow("db down");
    expect(failed.calls).toEqual(["backpressure", "subscribe", "recordQueued", "enqueue:-", "recordNotQueued:The run could not be queued: db down", "close"]);

    const full = make({ queue: true, backpressure: new QueueFullError("default", 1, 5) });
    await expect(full.dispatcher.run(spec(), { pool: "default" })).rejects.toBeInstanceOf(QueueFullError);
    expect(full.calls).toEqual(["backpressure"]);
    const unchecked = make({ queue: true, backpressure: new QueueFullError("default", 1, 5), end: { kind: "result", result } });
    expect(await unchecked.dispatcher.run(spec(), { pool: "default", enforceBackpressure: false })).toBe(result);
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

  it("fire enqueues under the idempotent id, deduplicated within the window, without waiting", async () => {
    const { dispatcher, calls } = make({ queue: true });
    expect(await dispatcher.fire(spec(), { pool: "default", queueItemId: "cron:wf:n:1" })).toEqual({ queued: true, deduplicated: false });
    expect(calls).toEqual([`enqueue:cron:wf:n:1@${FIRE_DEDUPE_WINDOW_MS}`, "queued"]);
  });

  it("a duplicate fire is reported and not counted as a dispatched run", async () => {
    const { dispatcher, calls } = make({ queue: true, duplicate: true });
    expect(await dispatcher.fire(spec(), { pool: "default", queueItemId: "trig:wf:n:abc" })).toEqual({ queued: true, deduplicated: true });
    expect(calls).toEqual([`enqueue:trig:wf:n:abc@${FIRE_DEDUPE_WINDOW_MS}`, "deduplicated:trig:wf:n:abc"]);
  });
});

describe("inline runs that need a worker capability (metrics)", () => {
  it("are counted per capability label, apart from the pool's fallback", () => {
    const metrics = new MetricsService();
    metrics.recordDispatchInlineRun(`capability:${RESPONSE_BOUNDARY_CAPABILITY}`);
    metrics.recordDispatchInlineRun(`capability:${RESPONSE_BOUNDARY_CAPABILITY}`);
    const text = metrics.formatPrometheus();
    expect(text).toMatch(/_dispatch_inline_runs_total\{reason="capability:content-rules-response-v1"\} 2/);
    expect(text).not.toMatch(/_dispatch_inline_fallback /);
  });
});
