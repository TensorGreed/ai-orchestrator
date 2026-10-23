import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvalRunEvent, EvalRunView } from "@ai-orchestrator/shared";
import { subscribeEvalRun } from "./api";

function run(status: string, done = 0): EvalRunView {
  return {
    id: "run_1",
    kind: "replay",
    datasetId: "set_1",
    datasetIds: ["set_1"],
    workflowId: "wf-1",
    workflowName: null,
    status,
    startedAt: "",
    completedAt: null,
    triggeredBy: null,
    summary: null,
    progress: { total: 2, done, running: 0, pass: done, fail: 0, error: 0, skipped: 0, spentUsd: 0, updatedAt: "" },
    candidate: null,
    options: null,
    error: null
  };
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, (event: MessageEvent<string>) => void>();
  onerror: (() => void) | null = null;
  closed = false;
  constructor(
    public url: string,
    public init?: EventSourceInit
  ) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, listener);
  }
  close() {
    this.closed = true;
  }
  emit(type: "progress" | "done", payload: EvalRunView) {
    this.listeners.get(type)?.({ data: JSON.stringify({ type, run: payload }) } as MessageEvent<string>);
  }
}

describe("subscribeEvalRun", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("follows server-sent events with the session cookie and stops when done", () => {
    const events: EvalRunEvent[] = [];
    subscribeEvalRun("run_1", (event) => events.push(event));
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe("/api/eval/runs/run_1/events");
    expect(source.init).toEqual({ withCredentials: true });
    source.emit("progress", run("running", 1));
    source.emit("done", run("completed", 2));
    expect(events.map((event) => event.type)).toEqual(["progress", "done"]);
    expect(source.closed).toBe(true);
  });

  it("falls back to polling when the stream errors", async () => {
    vi.useFakeTimers();
    const poll = vi.fn<(id: string) => Promise<EvalRunView>>().mockResolvedValueOnce(run("running", 1)).mockResolvedValueOnce(run("completed", 2));
    const events: EvalRunEvent[] = [];
    subscribeEvalRun("run_1", (event) => events.push(event), { poll, pollIntervalMs: 1500 });
    FakeEventSource.instances[0]!.onerror?.();
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([{ type: "progress", run: run("running", 1) }]);
    await vi.advanceTimersByTimeAsync(1500);
    expect(events.at(-1)?.type).toBe("done");
    await vi.advanceTimersByTimeAsync(5000);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("stops polling when unsubscribed", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", undefined);
    const poll = vi.fn<(id: string) => Promise<EvalRunView>>().mockResolvedValue(run("running", 1));
    const stop = subscribeEvalRun("run_1", () => undefined, { poll });
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(poll).toHaveBeenCalledTimes(1);
  });
});
