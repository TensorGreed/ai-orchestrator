/**
 * Phase 13.1 — the control-message handlers and their reconciliation, over a fake bus (messages from any sender, and
 * a resync on demand) with fakes for the runs, eval runs and schedules they act on.
 */
import { describe, expect, it } from "vitest";
import type { ClusterBus, ClusterBusStatus, ClusterMessage, ClusterMessageHandler } from "./cluster-bus.js";
import { CLUSTER_CANCEL_REASON_MAX_LENGTH, REMOTE_CANCEL_REASON, clusterCancelReason, startClusterSignals } from "./cluster-signals.js";

async function until(read: () => boolean | Promise<boolean>, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await read())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A bus the test drives: `deliver` hands a message (from any instance) to the subscribers; `resync` fires a resync. */
class FakeBus implements ClusterBus {
  readonly kind = "postgres" as const;
  readonly instanceId = "me";
  private readonly handlers = new Set<ClusterMessageHandler>();
  private readonly resyncs = new Set<() => void | Promise<void>>();
  async start(): Promise<void> {}
  async close(): Promise<void> {}
  async publish(): Promise<void> {}
  subscribe(_topic: string, handler: ClusterMessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  async publishRunEvent(): Promise<void> {}
  async subscribeRun(): Promise<() => void> {
    return () => undefined;
  }
  onResync(handler: () => void | Promise<void>): () => void {
    this.resyncs.add(handler);
    return () => this.resyncs.delete(handler);
  }
  status(): ClusterBusStatus {
    return { kind: "postgres", connected: true, disconnectedSince: null, reconnects: 0, channels: 1 };
  }
  async deliver(message: Omit<ClusterMessage, "v"> & { v?: number }): Promise<void> {
    await Promise.all([...this.handlers].map(async (handler) => await handler({ v: 1, from: "other", ...message } as ClusterMessage)));
  }
  async resync(): Promise<void> {
    await Promise.all([...this.resyncs].map(async (handler) => await handler()));
  }
}

function harness(options: { canceled?: string[]; isLeader?: boolean; cancelCheckMs?: number } = {}) {
  const bus = new FakeBus();
  const active = new Set(["run-1", "run-2"]);
  const aborted: Array<[string, string]> = [];
  const evalStopped: string[] = [];
  const reloaded: string[] = [];
  const counts = { synced: 0, evalRechecks: 0 };
  const canceledInStore = new Set(options.canceled ?? []);
  const signals = startClusterSignals({
    bus,
    store: { listCanceledExecutionIds: async (ids) => ids.filter((id) => canceledInStore.has(id)) },
    activeExecutionIds: () => [...active],
    abortExecution: (id, reason) => {
      if (active.has(id)) aborted.push([id, reason]);
    },
    evalRuns: {
      stopIfCanceledElsewhere: async (runId) => {
        evalStopped.push(runId);
        return true;
      },
      stopRunsCanceledElsewhere: async () => {
        counts.evalRechecks += 1;
        return 0;
      }
    },
    workflows: {
      isLeader: () => options.isLeader ?? true,
      reload: async (id) => {
        reloaded.push(id);
      },
      syncAll: async () => {
        counts.synced += 1;
      }
    },
    cancelCheckMs: options.cancelCheckMs ?? 0,
    logger: { warn: () => undefined }
  });
  return { bus, signals, aborted, evalStopped, reloaded, counts };
}

describe("clusterCancelReason", () => {
  it("drops control characters, collapses whitespace and caps the length", () => {
    expect(clusterCancelReason("  stop\u0000 it\n\tnow\u001b[31m ")).toBe("stop it now [31m");
    expect(clusterCancelReason("\u0000\n")).toBeUndefined();
    expect(clusterCancelReason(7)).toBeUndefined();
    const long = clusterCancelReason("x".repeat(1_000))!;
    expect(long).toHaveLength(CLUSTER_CANCEL_REASON_MAX_LENGTH);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("cluster signals", () => {
  it("aborts a local run on `cancel`, with the message's reason, and ignores runs that are not here", async () => {
    const h = harness({ canceled: ["run-1", "run-2", "elsewhere"] });
    await h.bus.deliver({ t: "cancel", id: "run-1", reason: "stop" });
    await h.bus.deliver({ t: "cancel", id: "elsewhere" });
    await h.bus.deliver({ t: "cancel", id: "run-2" });
    expect(h.aborted).toEqual([
      ["run-1", "stop"],
      ["run-2", REMOTE_CANCEL_REASON]
    ]);
    h.signals.stop();
  });

  it("does not abort a local run on a `cancel` the store does not confirm (a NOTIFY from anyone with database access)", async () => {
    const h = harness({ canceled: [] });
    await h.bus.deliver({ t: "cancel", id: "run-1", reason: "forged" });
    expect(h.aborted).toEqual([]);
    h.signals.stop();
  });

  it("ignores messages with wrong field types, oversized or control-character ids, or a bad sender", async () => {
    const h = harness({ canceled: ["run-1"], isLeader: true });
    await h.bus.deliver({ t: "cancel", id: "run-1", reason: 42 });
    await h.bus.deliver({ t: "cancel", id: "run-1", from: { forged: true } });
    await h.bus.deliver({ t: "workflow_changed", id: "x".repeat(513) });
    await h.bus.deliver({ t: "workflow_changed", id: "wf\u0000evil" });
    await h.bus.deliver({ t: "eval_cancel", runId: ["eval-1"] });
    expect(h.aborted).toEqual([]);
    expect(h.reloaded).toEqual([]);
    expect(h.evalStopped).toEqual([]);
    h.signals.stop();
  });

  it("stops a local eval run on `eval_cancel`, and ignores malformed and unknown messages", async () => {
    const h = harness();
    await h.bus.deliver({ t: "eval_cancel" });
    await h.bus.deliver({ t: "something_new", id: "run-1" });
    await h.bus.deliver({ t: "cancel", id: 42 });
    await h.bus.deliver({ t: "eval_cancel", runId: "eval-1" });
    expect(h.evalStopped).toEqual(["eval-1"]);
    expect(h.aborted).toEqual([]);
    h.signals.stop();
  });

  it("reloads a changed workflow on the leader only, and not for its own announcements", async () => {
    const leader = harness({ isLeader: true });
    await leader.bus.deliver({ t: "workflow_changed", id: "wf-own", from: "me" });
    await leader.bus.deliver({ t: "workflow_changed", id: "wf-1" });
    expect(leader.reloaded).toEqual(["wf-1"]);
    leader.signals.stop();
    const follower = harness({ isLeader: false });
    await follower.bus.deliver({ t: "workflow_changed", id: "wf-1" });
    expect(follower.reloaded).toEqual([]);
    follower.signals.stop();
  });

  it("the cancel check aborts local runs the store shows canceled, on its timer and on a resync", async () => {
    const h = harness({ canceled: ["run-2", "not-here"], cancelCheckMs: 20 });
    await until(() => h.aborted.length >= 1, "the timer's abort");
    expect(h.aborted[0]).toEqual(["run-2", REMOTE_CANCEL_REASON]);
    h.signals.stop();

    const r = harness({ canceled: ["run-1"], isLeader: true });
    expect(await r.signals.checkCanceled()).toEqual(["run-1"]);
    r.aborted.length = 0;
    await r.bus.resync();
    expect(r.aborted).toEqual([["run-1", REMOTE_CANCEL_REASON]]);
    expect(r.counts).toEqual({ synced: 1, evalRechecks: 1 });
    r.signals.stop();

    // A follower's resync re-reads its runs but leaves the schedules to the leader.
    const f = harness({ isLeader: false });
    await f.bus.resync();
    expect(f.counts).toEqual({ synced: 0, evalRechecks: 1 });
    f.signals.stop();
  });

  it("stops handling messages and resyncs once stopped", async () => {
    const h = harness({ canceled: ["run-1"] });
    h.signals.stop();
    await h.bus.deliver({ t: "cancel", id: "run-1" });
    await h.bus.resync();
    expect(h.aborted).toEqual([]);
  });
});
