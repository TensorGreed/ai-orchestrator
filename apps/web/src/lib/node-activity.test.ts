import { describe, expect, it } from "vitest";
import { NODE_ACTIVITY_LIMIT, type NodeActivityEvent } from "@ai-orchestrator/shared";
import {
  applyNodeActivityToExecutionResult,
  applyNodeCompleteToExecutionResult,
  applyNodeStartToExecutionResult,
  createPartialExecutionResult,
  createTraceStreamHandlers,
  currentActivity,
  describeActivity
} from "./run-trace";
import { latestResolvedFields } from "../components/NodeActivityList";

const T0 = "2026-01-01T00:00:00.000Z";

function ev(seq: number, body: Record<string, unknown>, extra: Record<string, unknown> = {}): NodeActivityEvent {
  return { nodeId: "agent", at: T0, seq, ...body, ...extra } as NodeActivityEvent;
}

function running() {
  return applyNodeStartToExecutionResult(createPartialExecutionResult("wf", T0), { nodeId: "agent", nodeType: "agent_orchestrator", startedAt: T0 });
}

describe("describeActivity", () => {
  it("describes resolved input by node kind", () => {
    expect(describeActivity(ev(1, { kind: "resolved_input", fields: { providerId: "openai", model: "gpt-4o" } }))).toBe("Using gpt-4o · openai");
    expect(describeActivity(ev(1, { kind: "resolved_input", fields: { method: "POST", url: "https://api.x.com/v1/items" } }))).toBe("POST https://api.x.com/v1/items");
    expect(describeActivity(ev(1, { kind: "resolved_input", fields: { serverId: "docs-server", toolName: "search_docs" } }))).toBe("Tool search_docs on docs-server");
  });

  it("describes model calls, retries, steps and tools", () => {
    expect(describeActivity(ev(1, { kind: "llm_call", phase: "start", providerId: "p", model: "gpt-4o", iteration: 2 }))).toBe("Calling gpt-4o (step 2)");
    expect(describeActivity(ev(1, { kind: "llm_call", phase: "end", providerId: "p", model: "m", latencyMs: 1200 }))).toBe("Model replied after 1.2s");
    expect(describeActivity(ev(1, { kind: "llm_call", phase: "end", providerId: "p", model: "m", error: "boom" }))).toBe("Model call failed: boom");
    expect(describeActivity(ev(1, { kind: "retry", scope: "provider", attempt: 1, maxAttempts: 4, delayMs: 4000, reason: "503 Service Unavailable" }))).toBe(
      "Retrying model request in 4.0s (attempt 2 of 4): 503 Service Unavailable"
    );
    expect(describeActivity(ev(1, { kind: "retry", scope: "node", attempt: 1, delayMs: 500, reason: "x" }))).toContain("Retrying node in 500ms");
    expect(describeActivity(ev(1, { kind: "agent_step", phase: "start", iteration: 3, maxIterations: 10 }))).toBe("Step 3 of 10");
    expect(describeActivity(ev(1, { kind: "agent_step", phase: "end", iteration: 3, maxIterations: 10, toolCalls: ["search_docs", "get_page"] }))).toBe(
      "Step 3 asked for search_docs, get_page"
    );
    expect(describeActivity(ev(1, { kind: "agent_step", phase: "end", iteration: 3, maxIterations: 10, final: true }))).toBe("Step 3 gave the final answer");
    expect(describeActivity(ev(1, { kind: "tool_call", phase: "start", toolName: "search_docs" }))).toBe("Calling search_docs");
    expect(describeActivity(ev(1, { kind: "tool_call", phase: "end", toolName: "search_docs", durationMs: 820, outcome: "ok" }))).toBe("search_docs done in 820ms");
    expect(describeActivity(ev(1, { kind: "tool_call", phase: "end", toolName: "search_docs", outcome: "error", error: "timeout" }))).toBe("search_docs failed: timeout");
    expect(describeActivity(ev(1, { kind: "tool_call", phase: "end", toolName: "search_docs", outcome: "blocked" }))).toBe("search_docs blocked by the guard");
  });

  it("prefixes worker entries", () => {
    expect(describeActivity(ev(1, { kind: "tool_call", phase: "start", toolName: "t" }, { workerNodeId: "w1" }))).toBe("Worker w1: Calling t");
  });
});

describe("applyNodeActivityToExecutionResult", () => {
  it("appends in seq order, de-duplicates and ignores unknown nodes", () => {
    let trace = running();
    trace = applyNodeActivityToExecutionResult(trace, ev(2, { kind: "agent_step", phase: "start", iteration: 1, maxIterations: 3 }))!;
    trace = applyNodeActivityToExecutionResult(trace, ev(1, { kind: "resolved_input", fields: { model: "m" } }))!;
    trace = applyNodeActivityToExecutionResult(trace, ev(2, { kind: "agent_step", phase: "start", iteration: 1, maxIterations: 3 }))!;
    expect(trace.nodeResults[0]!.activity!.map((entry) => entry.seq)).toEqual([1, 2]);
    const same = applyNodeActivityToExecutionResult(trace, ev(1, { kind: "retry", scope: "node", attempt: 1, delayMs: 1, reason: "r" }, { nodeId: "ghost" }));
    expect(same).toBe(trace);
    expect(applyNodeActivityToExecutionResult(null, ev(1, { kind: "resolved_input", fields: {} }))).toBeNull();
  });

  it("keeps only the newest NODE_ACTIVITY_LIMIT entries", () => {
    let trace = running();
    for (let seq = 1; seq <= NODE_ACTIVITY_LIMIT + 5; seq += 1) {
      trace = applyNodeActivityToExecutionResult(trace, ev(seq, { kind: "tool_call", phase: "start", toolName: "t" }))!;
    }
    const activity = trace.nodeResults[0]!.activity!;
    expect(activity).toHaveLength(NODE_ACTIVITY_LIMIT);
    expect(activity[0]!.seq).toBe(6);
  });

  it("survives node_complete", () => {
    let trace = applyNodeActivityToExecutionResult(running(), ev(1, { kind: "resolved_input", fields: { model: "m" } }))!;
    trace = applyNodeCompleteToExecutionResult(trace, { nodeId: "agent", status: "success", completedAt: T0, durationMs: 1 } as never);
    expect(trace.nodeResults[0]!.activity).toHaveLength(1);
  });

  it("is wired into the trace stream handlers only when enabled", () => {
    let state: ReturnType<typeof running> | null = running();
    const make = (enabled: boolean) =>
      createTraceStreamHandlers({
        workflowId: "wf",
        enabled,
        setExecutionResult: (update) => {
          state = update(state);
        },
        setLiveNodeStatuses: () => undefined,
        normalizeStatus: () => undefined
      });
    make(false).onNodeActivity(ev(1, { kind: "resolved_input", fields: {} }));
    expect(state!.nodeResults[0]!.activity).toBeUndefined();
    make(true).onNodeActivity(ev(1, { kind: "resolved_input", fields: {} }));
    expect(state!.nodeResults[0]!.activity).toHaveLength(1);
  });
});

describe("currentActivity", () => {
  it("shows a retry wait while a model call or step is still open", () => {
    const activity = [
      ev(1, { kind: "agent_step", phase: "start", iteration: 1, maxIterations: 5 }),
      ev(2, { kind: "llm_call", phase: "start", providerId: "openai", model: "gpt-4o", iteration: 1 }),
      ev(3, { kind: "retry", scope: "provider", attempt: 1, maxAttempts: 4, delayMs: 2000, reason: "HTTP 503 from openai" })
    ];
    expect(currentActivity({ activity })?.kind).toBe("retry");
    const resumed = [...activity, ev(4, { kind: "llm_call", phase: "end", providerId: "openai", model: "gpt-4o", iteration: 1, latencyMs: 900 })];
    expect(currentActivity({ activity: resumed })?.kind).toBe("agent_step");
  });

  it("returns the last start without an end, else the last entry", () => {
    expect(currentActivity(undefined)).toBeUndefined();
    const open = [
      ev(1, { kind: "agent_step", phase: "start", iteration: 1, maxIterations: 3 }),
      ev(2, { kind: "llm_call", phase: "start", providerId: "p", model: "m" }),
      ev(3, { kind: "llm_call", phase: "end", providerId: "p", model: "m", latencyMs: 5 }),
      ev(4, { kind: "tool_call", phase: "start", toolName: "a", toolCallId: "1" }),
      ev(5, { kind: "tool_call", phase: "start", toolName: "b", toolCallId: "2" }),
      ev(6, { kind: "tool_call", phase: "end", toolName: "b", toolCallId: "2", outcome: "ok" })
    ];
    expect(currentActivity({ activity: open })!.seq).toBe(4);
    const closed = [
      ...open,
      ev(7, { kind: "tool_call", phase: "end", toolName: "a", toolCallId: "1", outcome: "ok" }),
      ev(8, { kind: "agent_step", phase: "end", iteration: 1, maxIterations: 3, final: true })
    ];
    expect(currentActivity({ activity: closed })!.seq).toBe(8);
  });
});

describe("latestResolvedFields", () => {
  it("ignores a worker's resolved input on a Supervisor", () => {
    const activity = [
      ev(1, { kind: "resolved_input", fields: { providerId: "openai", model: "supervisor-model" } }),
      ev(2, { kind: "resolved_input", fields: { providerId: "openai", model: "worker-model" } }, { workerNodeId: "worker-1" })
    ];
    expect(latestResolvedFields(activity)).toEqual({ providerId: "openai", model: "supervisor-model" });
  });
});
