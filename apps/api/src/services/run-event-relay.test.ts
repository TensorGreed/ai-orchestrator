import { describe, expect, it } from "vitest";
import { LocalClusterBus } from "./cluster-bus-local.js";
import type { RunBusEvent } from "./cluster-bus.js";
import type { QueueItemOutcome } from "../db/store.js";
import {
  decodeRunEvent,
  encodeRunEvent,
  LocalRunEvents,
  onceEachElicitationEvent,
  openRunRelay,
  RunEventPublisher,
  type PersistedRun,
  type RunEventName
} from "./run-event-relay.js";

const waitFor = async (check: () => boolean, what: string, timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe("run event encoding", () => {
  it("sends node_complete by reference with its small fields, and small events as they are", () => {
    expect(encodeRunEvent("node_complete", { nodeId: "n1", nodeType: "llm_call", status: "success", completedAt: "t", durationMs: 5, output: "x".repeat(10) })).toEqual({
      t: "node_complete",
      ref: true,
      nodeId: "n1",
      nodeType: "llm_call",
      status: "success",
      completedAt: "t",
      durationMs: 5,
      hasError: false
    });
    expect(encodeRunEvent("node_start", { nodeId: "n1", nodeType: "llm_call", startedAt: "t", input: { a: 1 } })).toEqual({
      t: "node_start",
      nodeId: "n1",
      nodeType: "llm_call",
      startedAt: "t",
      input: { a: 1 }
    });
  });

  it("replaces an event over the limit with a reference that keeps what identifies it", () => {
    const big = "y".repeat(500);
    expect(encodeRunEvent("node_start", { nodeId: "n1", nodeType: "t", startedAt: "s", input: big }, 200)).toEqual({ t: "node_start", ref: true, nodeId: "n1", nodeType: "t", startedAt: "s" });
    expect(encodeRunEvent("node_activity", { nodeId: "n1", seq: 7, kind: "x", detail: big }, 200)).toEqual({ t: "node_activity", ref: true, nodeId: "n1", seq: 7 });
    expect(encodeRunEvent("mcp_elicitation", { phase: "created", elicitation: { id: "e1", message: big } }, 200)).toEqual({
      t: "mcp_elicitation",
      ref: true,
      phase: "created",
      elicitationId: "e1"
    });
    expect(encodeRunEvent("node_progress", { nodeId: "n1", message: big }, 200)).toEqual({ t: "node_progress", ref: true, nodeId: "n1" });
  });
});

describe("RunEventPublisher", () => {
  it("coalesces deltas per node, flushes them before the next event, and keeps the order", async () => {
    const sent: RunBusEvent[] = [];
    const publisher = new RunEventPublisher({ publish: async (event) => void sent.push(event), coalesceMs: 1_000 });
    publisher.emit("node_start", { nodeId: "n1" });
    publisher.emit("llm_delta", { nodeId: "n1", delta: "Hel", index: 0 });
    publisher.emit("llm_delta", { nodeId: "n1", delta: "lo", index: 1 });
    publisher.emit("llm_delta", { nodeId: "n2", delta: "!", index: 0 });
    publisher.emit("node_complete", { nodeId: "n1", nodeType: "llm_call", status: "success", completedAt: "t", durationMs: 1 });
    await publisher.done("success");
    expect(sent.map((event) => [event.t, event.nodeId, event.delta])).toEqual([
      ["node_start", "n1", undefined],
      ["llm_delta", "n1", "Hello"],
      ["llm_delta", "n2", "!"],
      ["node_complete", "n1", undefined],
      ["done", undefined, undefined]
    ]);
    expect(sent[1]?.index).toBe(0);
    publisher.emit("node_start", { nodeId: "late" });
    await publisher.flush();
    expect(sent).toHaveLength(5);
  });

  it("flushes deltas on its timer and splits a burst that would not fit", async () => {
    const sent: RunBusEvent[] = [];
    const publisher = new RunEventPublisher({ publish: async (event) => void sent.push(event), coalesceMs: 10, maxBytes: 1_000 });
    publisher.emit("llm_delta", { nodeId: "n1", delta: "a".repeat(3_000), index: 0 });
    await waitFor(() => sent.length > 0, "the timer flush");
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.map((event) => event.delta).join("")).toBe("a".repeat(3_000));
    for (const event of sent) expect(JSON.stringify(event).length).toBeLessThanOrEqual(1_000);
  });

  it("a failed publish is reported and the next events still go out", async () => {
    const sent: string[] = [];
    const errors: unknown[] = [];
    let fail = true;
    const publisher = new RunEventPublisher({
      publish: async (event) => {
        if (fail) {
          fail = false;
          throw new Error("down");
        }
        sent.push(event.t);
      },
      onError: (error) => errors.push(error)
    });
    publisher.emit("node_start", { nodeId: "a" });
    publisher.emit("node_start", { nodeId: "b" });
    await publisher.done("success");
    expect(errors).toHaveLength(1);
    expect(sent).toEqual(["node_start", "done"]);
  });
});

describe("decodeRunEvent", () => {
  const run: PersistedRun = {
    id: "x",
    workflowId: "wf",
    status: "running",
    startedAt: "s",
    nodeResults: [
      { nodeId: "n1", status: "success", input: { q: 1 }, output: { a: 2 }, error: "bad", progress: { progress: 1, total: 2 }, activity: [{ nodeId: "n1", seq: 3, kind: "k" }] }
    ]
  };
  const readers = { readRun: async () => run, readElicitation: async (id: string) => (id === "e1" ? { id: "e1" } : null) };

  it("fills a reference from the run's persisted progress", async () => {
    expect(await decodeRunEvent({ t: "node_complete", ref: true, nodeId: "n1", nodeType: "llm", status: "error", completedAt: "c", durationMs: 4, hasError: true }, readers)).toEqual({
      name: "node_complete",
      payload: { nodeId: "n1", nodeType: "llm", status: "error", completedAt: "c", durationMs: 4, input: { q: 1 }, output: { a: 2 }, error: "bad" }
    });
    expect((await decodeRunEvent({ t: "node_start", ref: true, nodeId: "n1", nodeType: "llm", startedAt: "s" }, readers))?.payload.input).toEqual({ q: 1 });
    expect((await decodeRunEvent({ t: "node_progress", ref: true, nodeId: "n1" }, readers))?.payload).toEqual({ nodeId: "n1", progress: 1, total: 2 });
    expect((await decodeRunEvent({ t: "node_activity", ref: true, nodeId: "n1", seq: 3 }, readers))?.payload).toEqual({ nodeId: "n1", seq: 3, kind: "k" });
    expect(await decodeRunEvent({ t: "node_activity", ref: true, nodeId: "n1", seq: 9 }, readers)).toBeNull();
    expect((await decodeRunEvent({ t: "mcp_elicitation", ref: true, phase: "created", elicitationId: "e1" }, readers))?.payload).toEqual({ phase: "created", elicitation: { id: "e1" } });
  });

  it("round-trips a failing node's node_complete to exactly the inline event, and trims only an oversized remediation", async () => {
    const inline = {
      nodeId: "n1",
      nodeType: "llm",
      status: "error",
      completedAt: "c",
      durationMs: 4,
      input: { q: 1 },
      output: { a: 2 },
      error: "bad",
      errorCategory: "auth",
      errorRemediation: "Check the API key.",
      retryable: false
    };
    const encoded = encodeRunEvent("node_complete", inline);
    expect(encoded).not.toHaveProperty("input");
    expect(encoded).not.toHaveProperty("error");
    expect(await decodeRunEvent(JSON.parse(JSON.stringify(encoded)) as RunBusEvent, readers)).toEqual({ name: "node_complete", payload: inline });

    const huge = encodeRunEvent("node_complete", { ...inline, errorRemediation: "é".repeat(20_000) }, 2_000);
    expect(Buffer.byteLength(JSON.stringify(huge))).toBeLessThanOrEqual(2_000);
    expect(String(huge.errorRemediation).length).toBeGreaterThan(100);
    expect(huge).toMatchObject({ errorCategory: "auth", retryable: false, hasError: true });
  });

  it("passes an inline event through without the bus fields and ignores unknown types", async () => {
    expect(await decodeRunEvent({ t: "llm_delta", v: 1, from: "a", nodeId: "n1", delta: "x", index: 0 } as RunBusEvent, readers)).toEqual({
      name: "llm_delta",
      payload: { nodeId: "n1", delta: "x", index: 0 }
    });
    expect(await decodeRunEvent({ t: "something_new" }, readers)).toBeNull();
  });
});

describe("onceEachElicitationEvent", () => {
  it("sends each elicitation id and phase once, whichever path reports it first", () => {
    const sent: unknown[] = [];
    const send = onceEachElicitationEvent((event) => void sent.push(event));
    send({ phase: "created", elicitation: { id: "e1" } });
    send({ phase: "created", elicitation: { id: "e1" } });
    send({ phase: "settled", elicitation: { id: "e1", status: "accepted" } });
    send({ phase: "settled", elicitation: { id: "e1", status: "accepted" } });
    send({ phase: "created", elicitation: { id: "e2" } });
    expect(sent).toEqual([
      { phase: "created", elicitation: { id: "e1" } },
      { phase: "settled", elicitation: { id: "e1", status: "accepted" } },
      { phase: "created", elicitation: { id: "e2" } }
    ]);
  });
});

describe("openRunRelay", () => {
  const setup = (state: { run: PersistedRun | null; outcome: QueueItemOutcome | null }) => {
    const bus = new LocalClusterBus("test");
    const events: Array<[RunEventName, Record<string, unknown>]> = [];
    const source = {
      bus,
      readRun: async () => state.run,
      readOutcome: async () => state.outcome,
      pollMs: 20
    };
    return { bus, events, source };
  };

  it("relays events in order and ends with the stored result on done", async () => {
    const state: { run: PersistedRun | null; outcome: QueueItemOutcome | null } = {
      run: { id: "e", workflowId: "wf", status: "running", startedAt: "s", nodeResults: [{ nodeId: "n1", output: "out" }] },
      outcome: { status: "running", result: null, lastError: null, attempts: 0 }
    };
    const { bus, events, source } = setup(state);
    const relay = await openRunRelay({ ...source, pollMs: 60_000 }, { executionId: "e", queueItemId: "e", onEvent: (name, payload) => void events.push([name, payload]) });
    await bus.publishRunEvent("e", { t: "node_start", nodeId: "n1" });
    await bus.publishRunEvent("e", { t: "node_complete", ref: true, nodeId: "n1", nodeType: "x", status: "success", completedAt: "c", durationMs: 1 });
    state.outcome = { status: "running", result: { status: "success", output: "out", warnings: ["w"] }, lastError: null, attempts: 0 };
    await bus.publishRunEvent("e", { t: "done", status: "success" });
    const end = await relay.ended(5_000);
    expect(end).toEqual({ kind: "result", result: { status: "success", output: "out", warnings: ["w"] } });
    expect(events.map(([name]) => name)).toEqual(["node_start", "node_complete"]);
    expect(events[1]?.[1].output).toBe("out");
  });

  it("a lost done still ends the relay from the database", async () => {
    const state: { run: PersistedRun | null; outcome: QueueItemOutcome | null } = { run: null, outcome: { status: "running", result: null, lastError: null, attempts: 0 } };
    const { source } = setup(state);
    const relay = await openRunRelay(source, { executionId: "e", queueItemId: "e", onEvent: () => undefined });
    setTimeout(() => {
      state.outcome = { status: "completed", result: { status: "error" }, lastError: null, attempts: 0 };
    }, 30);
    expect(await relay.ended(5_000)).toEqual({ kind: "result", result: { status: "error" } });
  });

  it("ends failed on a dead job, with the canceled record for a run canceled while queued, and times out", async () => {
    const dead = setup({ run: null, outcome: { status: "dead", result: null, lastError: "no workflow", attempts: 3 } });
    expect(await (await openRunRelay(dead.source, { executionId: "e", queueItemId: "e", onEvent: () => undefined })).ended(5_000)).toEqual({ kind: "failed", error: "no workflow" });

    const canceled = setup({
      run: { id: "e", workflowId: "wf", status: "canceled", startedAt: "s", completedAt: "c", error: "stop" },
      outcome: { status: "pending", result: null, lastError: null, attempts: 0 }
    });
    const end = await (await openRunRelay(canceled.source, { executionId: "e", queueItemId: "e", onEvent: () => undefined })).ended(5_000);
    expect(end).toMatchObject({ kind: "result", result: { status: "canceled", executionId: "e", error: "stop", nodeResults: [] } });

    // A running claim keeps the relay waiting even when the history already reads canceled (the worker reports it).
    const running = setup({
      run: { id: "e", workflowId: "wf", status: "canceled", startedAt: "s" },
      outcome: { status: "running", result: null, lastError: null, attempts: 0 }
    });
    expect(await (await openRunRelay(running.source, { executionId: "e", queueItemId: "e", onEvent: () => undefined })).ended(120)).toEqual({ kind: "timeout" });
  });

  it("without a queue item ends once the history row is settled (an inline run), and close ends it", async () => {
    const state: { run: PersistedRun | null; outcome: QueueItemOutcome | null } = { run: { id: "e", workflowId: "wf", status: "running", startedAt: "s" }, outcome: null };
    const { source } = setup(state);
    const relay = await openRunRelay(source, { executionId: "e", onEvent: () => undefined });
    state.run = { id: "e", workflowId: "wf", status: "waiting_approval", startedAt: "s", completedAt: "c" };
    expect(await relay.ended(5_000)).toMatchObject({ kind: "result", result: { status: "waiting_approval" } });

    const open = await openRunRelay({ ...source, readRun: async () => ({ id: "e", workflowId: "wf", status: "running", startedAt: "s" }) }, { executionId: "e", onEvent: () => undefined });
    open.close();
    expect(await open.ended()).toEqual({ kind: "closed" });
  });

  it("a paused run that is being resumed is followed to the resume's end, not answered with the stale pause", async () => {
    const paused = { status: "waiting_approval", output: null };
    const state: { run: PersistedRun | null; outcome: QueueItemOutcome | null; resuming: boolean } = {
      run: { id: "e", workflowId: "wf", status: "waiting_approval", startedAt: "s" },
      outcome: { status: "completed", result: paused, lastError: null, attempts: 0 },
      resuming: true
    };
    const { source } = setup(state);
    const relay = await openRunRelay(
      { ...source, readRun: async () => state.run, readOutcome: async () => state.outcome, resumeActive: async () => state.resuming },
      { executionId: "e", queueItemId: "e", onEvent: () => undefined }
    );
    relay.check();
    expect(await relay.ended(150)).toEqual({ kind: "timeout" });

    const again = await openRunRelay(
      { ...source, readRun: async () => state.run, readOutcome: async () => state.outcome, resumeActive: async () => state.resuming },
      { executionId: "e", queueItemId: "e", onEvent: () => undefined }
    );
    // The resume's final write lands: the run's record is the end.
    state.run = { id: "e", workflowId: "wf", status: "success", startedAt: "s", completedAt: "c" };
    state.resuming = false;
    expect(await again.ended(5_000)).toMatchObject({ kind: "result", result: { status: "success" } });

    // No resume running: the pause is the end, as before.
    const idle = setup({ run: { id: "e", workflowId: "wf", status: "waiting_approval", startedAt: "s" }, outcome: { status: "completed", result: paused, lastError: null, attempts: 0 } });
    expect(await (await openRunRelay({ ...idle.source, resumeActive: async () => false }, { executionId: "e", queueItemId: "e", onEvent: () => undefined })).ended(5_000)).toEqual({ kind: "result", result: paused });
  });

  it("reads LocalRunEvents like the bus, and emitting without a listener costs nothing", async () => {
    const local = new LocalRunEvents();
    expect(local.has("e")).toBe(false);
    local.emit("e", "node_start", { nodeId: "n" });
    const events: string[] = [];
    const relay = await openRunRelay(
      { bus: local, readRun: async () => ({ id: "e", workflowId: "wf", status: "running", startedAt: "s" }), pollMs: 60_000 },
      { executionId: "e", onEvent: (name) => void events.push(name) }
    );
    expect(local.has("e")).toBe(true);
    local.emit("e", "node_start", { nodeId: "n" });
    await waitFor(() => events.length === 1, "the local event");
    relay.close();
    expect(local.has("e")).toBe(false);
  });
});
