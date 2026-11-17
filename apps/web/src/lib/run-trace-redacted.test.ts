/**
 * `node_redacted`: when values are revealed later in a run, the server sends each node's data as the run's history
 * keeps it, and the editor's live trace replaces what earlier events showed of that node.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowExecutionResult } from "@ai-orchestrator/shared";
import { executeWorkflowStream, type StreamNodeRedactedEvent } from "./api";
import { applyNodeRedactedToExecutionResult, createTraceStreamHandlers, traceStreamCallbacks, type LiveNodeResult } from "./run-trace";

const T0 = "2026-11-17T10:00:00.000Z";

function live(): WorkflowExecutionResult {
  const hook: LiveNodeResult = { nodeId: "hook", status: "success", startedAt: T0, input: { user_prompt: "Mail ana@example.org" }, output: { text: "ana@example.org" } };
  const agent: LiveNodeResult = { nodeId: "agent", status: "running", startedAt: T0, liveText: "Writing to ana@example.org" };
  return { workflowId: "wf", status: "partial", startedAt: T0, nodeResults: [hook, agent] } as WorkflowExecutionResult;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("applyNodeRedactedToExecutionResult", () => {
  it("replaces the node's input, output, error and activity, and drops its streamed text", () => {
    const event: StreamNodeRedactedEvent = { nodeId: "hook", status: "success", input: { user_prompt: "Mail [EMAIL_1]" }, output: { text: "[EMAIL_1]" } };
    const next = applyNodeRedactedToExecutionResult(live(), event)!;
    expect(next.nodeResults[0]).toMatchObject({ nodeId: "hook", status: "success", input: { user_prompt: "Mail [EMAIL_1]" }, output: { text: "[EMAIL_1]" } });
    const running = applyNodeRedactedToExecutionResult(next, { nodeId: "agent", activity: [{ nodeId: "agent", seq: 1, at: T0, kind: "resolved_input", fields: {} }] })!;
    expect(running.nodeResults[1]).toMatchObject({ nodeId: "agent", status: "running" });
    expect((running.nodeResults[1] as LiveNodeResult).liveText).toBeUndefined();
    expect(running.nodeResults[1]!.activity).toHaveLength(1);
    expect(JSON.stringify(running)).not.toContain("ana@example.org");
  });

  it("leaves the trace alone for a node it does not have, or without a trace", () => {
    const current = live();
    expect(applyNodeRedactedToExecutionResult(current, { nodeId: "other" })).toBe(current);
    expect(applyNodeRedactedToExecutionResult(null, { nodeId: "hook" })).toBeNull();
  });

  it("is wired into the trace stream handlers and their stream callbacks", () => {
    let state: WorkflowExecutionResult | null = live();
    const trace = createTraceStreamHandlers({
      workflowId: "wf",
      enabled: true,
      setExecutionResult: (update) => {
        state = update(state);
      },
      setLiveNodeStatuses: () => undefined,
      normalizeStatus: () => undefined
    });
    traceStreamCallbacks(trace, () => undefined).onNodeRedacted({ nodeId: "hook", output: { text: "[EMAIL_1]" } });
    expect(state!.nodeResults[0]!.output).toEqual({ text: "[EMAIL_1]" });
  });
});

describe("the run stream", () => {
  it("hands node_redacted events to onNodeRedacted", async () => {
    const frames = [
      `event: node_redacted\ndata: ${JSON.stringify({ nodeId: "hook", output: { text: "[EMAIL_1]" } })}\n\n`,
      `event: result\ndata: ${JSON.stringify({ workflowId: "wf", status: "success", startedAt: T0, nodeResults: [] })}\n\n`
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(frames.join(""), { status: 200, headers: { "content-type": "text/event-stream" } }))
    );
    const seen: StreamNodeRedactedEvent[] = [];
    const result = await executeWorkflowStream("wf", {}, { onNodeRedacted: (event) => seen.push(event) });
    expect(result.status).toBe("success");
    expect(seen).toEqual([{ nodeId: "hook", output: { text: "[EMAIL_1]" } }]);
  });
});
