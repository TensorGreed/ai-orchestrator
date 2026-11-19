import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Edge } from "reactflow";
import type { WorkflowExecutionResult } from "@ai-orchestrator/shared";
import { RunTape } from "./RunTape";
import { WorkflowCanvasArea } from "./WorkflowCanvasArea";

/** A Loop runs its body once per item, so a run lists the body node once per pass. */
const loopRun: WorkflowExecutionResult = {
  workflowId: "wf-loop",
  status: "success",
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:00:01.000Z",
  nodeResults: [
    { nodeId: "loop", status: "success", startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:01.000Z", durationMs: 1000 },
    { nodeId: "set_node-upnla6", status: "success", startedAt: "2026-01-01T00:00:00.100Z", completedAt: "2026-01-01T00:00:00.200Z", durationMs: 100, output: { pass: 1 } },
    { nodeId: "set_node-upnla6", status: "success", startedAt: "2026-01-01T00:00:00.300Z", completedAt: "2026-01-01T00:00:00.400Z", durationMs: 100, output: { pass: 2 } }
  ]
};

const meta = new Map([
  ["loop", { label: "Loop", type: "loop_node" }],
  ["set_node-upnla6", { label: "Each record", type: "set_node" }]
]);

function duplicateKeyWarnings(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((call: unknown[]) => call.map(String).join(" ")).filter((text: string) => text.includes("same key"));
}

describe("a run with a Loop body's passes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("draws one run tape lane per pass without a duplicate React key", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<RunTape executionResult={loopRun} nodeMetaById={meta} />);
    expect(screen.getAllByTitle(/Each record/)).toHaveLength(2);
    expect(duplicateKeyWarnings(errors)).toEqual([]);
  });

  it("lists one log entry per pass without a duplicate React key", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const user = userEvent.setup();
    render(
      <WorkflowCanvasArea
        isLogsPanelCollapsed={false}
        canvasAndLogsStyle={{}}
        flowWrapperRef={createRef<HTMLDivElement>()}
        onDrop={vi.fn()}
        onDragOver={vi.fn()}
        showNodeDrawer={false}
        onCloseNodeDrawer={vi.fn()}
        onOpenNodeDrawer={vi.fn()}
        groupedDefinitions={new Map()}
        onCreateNodeFromDefinition={vi.fn()}
        nodes={[]}
        edges={[] as Edge[]}
        nodeTypes={{}}
        edgeTypes={{}}
        onNodesChange={vi.fn()}
        onEdgesChange={vi.fn()}
        onConnect={vi.fn()}
        onDeleteEdge={vi.fn()}
        onInit={vi.fn()}
        onOpenNodeConfig={vi.fn()}
        reactFlowInstance={null}
        onClearCanvas={vi.fn()}
        debugMode
        onDebugModeChange={vi.fn()}
        onExecuteWorkflow={vi.fn()}
        onExecuteWebhook={vi.fn()}
        busy={false}
        onLogsResizeStart={vi.fn()}
        logsTab="logs"
        onLogsTabChange={vi.fn()}
        onClearLogs={vi.fn()}
        onToggleLogsPanel={vi.fn()}
        executionResult={loopRun}
        statusColors={{ success: "#0a0" }}
        systemPrompt=""
        onSystemPromptChange={vi.fn()}
        userPrompt=""
        onUserPromptChange={vi.fn()}
        sessionId="s"
        onSessionIdChange={vi.fn()}
      />
    );
    await user.click(screen.getByRole("tab", { name: "Logs" }));
    expect(document.querySelectorAll(".node-status-item")).toHaveLength(3);
    expect(duplicateKeyWarnings(errors)).toEqual([]);
  });
});
