import { render, screen } from "@testing-library/react";
import { ReactFlowProvider, type NodeProps } from "reactflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NodeActivityEvent, WorkflowExecutionResult } from "@ai-orchestrator/shared";
import type { EditorNodeData } from "../lib/workflow";
import * as api from "../lib/api";
import { NodeActivityList } from "./NodeActivityList";
import { RunTape } from "./RunTape";
import { WorkflowCanvasNode } from "./WorkflowCanvasNode";

const T0 = "2026-01-01T00:00:00.000Z";
const activity: NodeActivityEvent[] = [
  { nodeId: "llm", at: T0, seq: 1, kind: "resolved_input", fields: { providerId: "openai", model: "gpt-4o", tools: ["a", "b"] } },
  { nodeId: "llm", at: "2026-01-01T00:00:01.500Z", seq: 2, kind: "tool_call", phase: "start", toolName: "search_docs", argsPreview: '{"q":"hi"}' }
];

describe("NodeActivityList", () => {
  it("shows offsets, lines, resolved fields and collapsible tool arguments", () => {
    render(<NodeActivityList activity={activity} startedAt={T0} />);
    expect(screen.getByText("Using gpt-4o · openai")).toBeInTheDocument();
    expect(screen.getByText("+1.5s")).toBeInTheDocument();
    expect(screen.getByTestId("activity-resolved-fields")).toHaveTextContent("a, b");
    expect(screen.getByText("Calling search_docs")).toBeInTheDocument();
    expect(screen.getByText("Arguments").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText('{"q":"hi"}')).toBeInTheDocument();
  });
});

describe("RunTape now line", () => {
  it("shows the current step under a running lane only", () => {
    const base: WorkflowExecutionResult = {
      workflowId: "wf",
      status: "partial",
      startedAt: T0,
      completedAt: T0,
      nodeResults: [{ nodeId: "llm", status: "running", startedAt: T0, activity }]
    };
    const meta = new Map([["llm", { label: "Agent", type: "agent_orchestrator" }]]);
    const { rerender } = render(<RunTape executionResult={base} nodeMetaById={meta} />);
    expect(screen.getByText("Now: Calling search_docs")).toBeInTheDocument();
    rerender(<RunTape executionResult={{ ...base, nodeResults: [{ ...base.nodeResults[0]!, status: "success", durationMs: 5 }] }} nodeMetaById={meta} />);
    expect(screen.queryByText(/^Now:/)).toBeNull();
  });
});

describe("canvas node Now line", () => {
  it("renders Now above the live text", () => {
    const props = {
      id: "n",
      type: "workflowNode",
      selected: false,
      zIndex: 0,
      isConnectable: true,
      xPos: 0,
      yPos: 0,
      dragging: false,
      data: {
        label: "Agent",
        nodeType: "llm_call",
        config: {},
        executionStatus: "running",
        executionPreview: { now: "Calling gpt-4o (step 2)", live: "partial text" }
      } as EditorNodeData
    } as NodeProps<EditorNodeData>;
    const { container } = render(
      <ReactFlowProvider>
        <WorkflowCanvasNode {...props} />
      </ReactFlowProvider>
    );
    const rows = Array.from(container.querySelectorAll(".wf-node-debug-preview > div")).map((row) => row.textContent);
    expect(rows).toEqual(["Now Calling gpt-4o (step 2)", "Live partial text"]);
  });
});

describe("node_activity stream frame", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes node_activity events to onNodeActivity", async () => {
    const frames = [
      `event: node_activity\ndata: ${JSON.stringify(activity[1])}\n\n`,
      `event: result\ndata: ${JSON.stringify({ workflowId: "wf", status: "success", startedAt: "a", completedAt: "b", nodeResults: [] })}\n\n`
    ];
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      }
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })));
    const onNodeActivity = vi.fn();
    await api.executeWorkflowStream("wf", {}, { onNodeActivity });
    expect(onNodeActivity).toHaveBeenCalledWith(expect.objectContaining({ kind: "tool_call", toolName: "search_docs", seq: 2 }));
  });
});

