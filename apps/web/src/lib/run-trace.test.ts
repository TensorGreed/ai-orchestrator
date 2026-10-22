import { describe, expect, it, vi } from "vitest";
import type { WorkflowExecutionResult } from "@ai-orchestrator/shared";
import {
  LIVE_TEXT_LIMIT,
  appendCappedText,
  applyLlmDeltaToExecutionResult,
  applyNodeCompleteToExecutionResult,
  applyNodeStartToExecutionResult,
  buildStreamFailureResult,
  createPartialExecutionResult,
  createTraceStreamHandlers,
  pickStreamFailureMessage,
  runningElapsedMs,
  summarizeInputPreview,
  tailPreview,
  type LiveNodeResult
} from "./run-trace";

const T0 = "2026-01-01T00:00:00.000Z";

function runningTrace(): WorkflowExecutionResult {
  return applyNodeStartToExecutionResult(createPartialExecutionResult("wf", T0), { nodeId: "llm", nodeType: "llm_call", startedAt: T0 }, 5000);
}

describe("run trace helpers", () => {
  it("records the browser start time on node start and keeps it on repeat starts", () => {
    const first = runningTrace();
    expect((first.nodeResults[0] as LiveNodeResult).liveStartedAtMs).toBe(5000);
    const again = applyNodeStartToExecutionResult(first, { nodeId: "llm", nodeType: "llm_call", startedAt: T0 }, 9000);
    expect((again.nodeResults[0] as LiveNodeResult).liveStartedAtMs).toBe(5000);
  });

  it("keeps the error category, remediation and retryable flag from node_complete", () => {
    const result = applyNodeCompleteToExecutionResult(runningTrace(), {
      nodeId: "llm",
      nodeType: "llm_call",
      status: "error",
      completedAt: T0,
      durationMs: 1200,
      error: "401 unauthorized",
      errorCategory: "AUTH",
      errorRemediation: "Check the API key.",
      retryable: false
    });
    expect(result.nodeResults[0]).toMatchObject({
      status: "error",
      error: "401 unauthorized",
      errorCategory: "AUTH",
      errorRemediation: "Check the API key.",
      retryable: false
    });
  });

  it("appends deltas to liveText and caps it to the tail", () => {
    let result: WorkflowExecutionResult | null = runningTrace();
    result = applyLlmDeltaToExecutionResult(result, { nodeId: "llm", delta: "Hel" });
    result = applyLlmDeltaToExecutionResult(result, { nodeId: "llm", delta: "lo" });
    expect((result!.nodeResults[0] as LiveNodeResult).liveText).toBe("Hello");

    const capped = appendCappedText("a".repeat(LIVE_TEXT_LIMIT), "tail");
    expect(capped).toHaveLength(LIVE_TEXT_LIMIT);
    expect(capped.endsWith("tail")).toBe(true);
  });

  it("ignores deltas for unknown nodes and clears liveText on completion", () => {
    const base = runningTrace();
    expect(applyLlmDeltaToExecutionResult(base, { nodeId: "other", delta: "x" })).toBe(base);
    const withText = applyLlmDeltaToExecutionResult(base, { nodeId: "llm", delta: "x" })!;
    const done = applyNodeCompleteToExecutionResult(withText, { nodeId: "llm", nodeType: "llm_call", status: "success", completedAt: T0, durationMs: 1 });
    expect((done.nodeResults[0] as LiveNodeResult).liveText).toBeUndefined();
    expect(applyLlmDeltaToExecutionResult(done, { nodeId: "llm", delta: "late" })).toBe(done);
  });

  it("marks running nodes as errored on stream failure and keeps finished ones", () => {
    let trace = applyNodeStartToExecutionResult(createPartialExecutionResult("wf", T0), { nodeId: "a", nodeType: "input", startedAt: T0 });
    trace = applyNodeCompleteToExecutionResult(trace, { nodeId: "a", nodeType: "input", status: "success", completedAt: T0, durationMs: 3 });
    trace = applyNodeStartToExecutionResult(trace, { nodeId: "llm", nodeType: "llm_call", startedAt: T0 });

    const failed = buildStreamFailureResult(trace, "wf", "Provider timed out", "2026-01-01T00:01:00.000Z");
    expect(failed.status).toBe("error");
    expect(failed.error).toBe("Provider timed out");
    expect(failed.nodeResults.map((entry) => entry.status)).toEqual(["success", "error"]);
    expect(failed.nodeResults[1]!.error).toBe("Stream ended before the node finished: Provider timed out");
  });

  it("falls back to a bare error result when there is no trace", () => {
    const failed = buildStreamFailureResult(null, "wf", "down");
    expect(failed.nodeResults).toEqual([]);
    expect(failed.error).toBe("down");
    expect(buildStreamFailureResult(createPartialExecutionResult("wf", T0), "wf", "down").nodeResults).toEqual([]);
  });

  it("prefers the server's error over the generic missing-final-result message", () => {
    const generic = "Streaming request completed without a final result event";
    expect(pickStreamFailureMessage("Model not found", generic)).toBe("Model not found");
    expect(pickStreamFailureMessage(null, generic)).toBe(generic);
    expect(pickStreamFailureMessage("Model not found", "Network error")).toBe("Network error");
  });

  it("previews the prompt text for an object input, else the fallback summary", () => {
    const summarize = () => "{ keys }";
    expect(summarizeInputPreview({ user_prompt: "Write a haiku", other: 1 }, summarize)).toBe("Write a haiku");
    expect(summarizeInputPreview({ a: 1 }, summarize)).toBe("{ keys }");
    expect(summarizeInputPreview("plain", summarize)).toBe("{ keys }");
  });

  it("shows the tail of live text on one line", () => {
    expect(tailPreview("one\ntwo")).toBe("one two");
    const tail = tailPreview("x".repeat(300), 50);
    expect(tail).toHaveLength(50);
    expect(tail.startsWith("…")).toBe(true);
  });

  it("measures running elapsed time from the browser start, else the server start", () => {
    expect(runningElapsedMs({ liveStartedAtMs: 1000 }, 4500)).toBe(3500);
    expect(runningElapsedMs({ startedAt: "2026-01-01T00:00:00.000Z" }, Date.parse("2026-01-01T00:00:02.000Z"))).toBe(2000);
    expect(runningElapsedMs({}, 1000)).toBe(0);
  });
});

describe("createTraceStreamHandlers", () => {
  function setup(enabled = true) {
    let result: WorkflowExecutionResult | null = null;
    let statuses: Record<string, string> = {};
    const handlers = createTraceStreamHandlers({
      workflowId: "wf",
      enabled,
      setExecutionResult: (update) => {
        result = update(result);
      },
      setLiveNodeStatuses: (update) => {
        statuses = update(statuses);
      },
      normalizeStatus: (status) => (typeof status === "string" ? status : undefined),
      flushMs: 100
    });
    return { handlers, get: () => ({ result: result as WorkflowExecutionResult | null, statuses }) };
  }

  it("batches deltas into one update per flush window", () => {
    vi.useFakeTimers();
    try {
      const { handlers, get } = setup();
      handlers.onNodeStart({ nodeId: "llm", nodeType: "llm_call", startedAt: T0 });
      handlers.onLlmDelta({ nodeId: "llm", delta: "a", index: 0 });
      handlers.onLlmDelta({ nodeId: "llm", delta: "b", index: 1 });
      expect((get().result!.nodeResults[0] as LiveNodeResult).liveText).toBeUndefined();
      vi.advanceTimersByTime(100);
      expect((get().result!.nodeResults[0] as LiveNodeResult).liveText).toBe("ab");
      expect(get().statuses).toEqual({ llm: "running" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispose flushes pending text and remembers the last error", () => {
    vi.useFakeTimers();
    try {
      const { handlers, get } = setup();
      handlers.onNodeStart({ nodeId: "llm", nodeType: "llm_call", startedAt: T0 });
      handlers.onLlmDelta({ nodeId: "llm", delta: "tail", index: 0 });
      handlers.onError({ message: "boom" });
      handlers.dispose();
      expect((get().result!.nodeResults[0] as LiveNodeResult).liveText).toBe("tail");
      expect(handlers.lastError()).toBe("boom");
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops tokens still buffered at node_complete so the node's next run starts clean", () => {
    vi.useFakeTimers();
    try {
      const { handlers, get } = setup();
      handlers.onNodeStart({ nodeId: "llm", nodeType: "llm_call", startedAt: T0 });
      handlers.onLlmDelta({ nodeId: "llm", delta: "first run", index: 0 });
      handlers.onNodeComplete({ nodeId: "llm", nodeType: "llm_call", status: "success", completedAt: T0, durationMs: 1 });
      vi.advanceTimersByTime(100);
      expect((get().result!.nodeResults[0] as LiveNodeResult).liveText).toBeUndefined();

      handlers.onNodeStart({ nodeId: "llm", nodeType: "llm_call", startedAt: T0 });
      handlers.onLlmDelta({ nodeId: "llm", delta: "second", index: 0 });
      vi.advanceTimersByTime(100);
      expect((get().result!.nodeResults[0] as LiveNodeResult).liveText).toBe("second");
    } finally {
      vi.useRealTimers();
    }
  });

  it("builds nothing when debug mode is off", () => {
    const { handlers, get } = setup(false);
    handlers.onNodeStart({ nodeId: "llm", nodeType: "llm_call", startedAt: T0 });
    expect(get().result).toBeNull();
  });
});
