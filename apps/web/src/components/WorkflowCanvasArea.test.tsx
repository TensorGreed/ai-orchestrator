import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import type { WorkflowExecutionResult } from "@ai-orchestrator/shared";
import type { Edge, ReactFlowInstance } from "reactflow";
import { WorkflowCanvasArea } from "./WorkflowCanvasArea";

function makeProps(overrides: Partial<Parameters<typeof WorkflowCanvasArea>[0]> = {}): Parameters<typeof WorkflowCanvasArea>[0] {
  const executionResult: WorkflowExecutionResult | null = null;
  return {
    isLogsPanelCollapsed: false,
    canvasAndLogsStyle: { gridTemplateRows: "minmax(280px, 1fr) 8px 210px" },
    flowWrapperRef: createRef<HTMLDivElement>(),
    onDrop: vi.fn(),
    onDragOver: vi.fn(),
    showNodeDrawer: false,
    onCloseNodeDrawer: vi.fn(),
    onOpenNodeDrawer: vi.fn(),
    groupedDefinitions: new Map(),
    onCreateNodeFromDefinition: vi.fn(),
    nodes: [],
    edges: [] as Edge[],
    nodeTypes: {},
    edgeTypes: {},
    onNodesChange: vi.fn(),
    onEdgesChange: vi.fn(),
    onConnect: vi.fn(),
    onDeleteEdge: vi.fn(),
    onInit: vi.fn((_: ReactFlowInstance) => undefined),
    onOpenNodeConfig: vi.fn(),
    reactFlowInstance: null,
    onClearCanvas: vi.fn(),
    debugMode: true,
    onDebugModeChange: vi.fn(),
    onExecuteWorkflow: vi.fn(),
    onExecuteWebhook: vi.fn(),
    busy: false,
    onLogsResizeStart: vi.fn(),
    logsTab: "logs",
    onLogsTabChange: vi.fn(),
    onClearLogs: vi.fn(),
    onToggleLogsPanel: vi.fn(),
    executionResult,
    statusColors: { running: "#aaa", success: "#0a0", error: "#a00" },
    systemPrompt: "system",
    onSystemPromptChange: vi.fn(),
    userPrompt: "user",
    onUserPromptChange: vi.fn(),
    sessionId: "session-1",
    onSessionIdChange: vi.fn(),
    ...overrides
  };
}

describe("WorkflowCanvasArea", () => {
  it("renders debug placeholder when no execution trace exists", () => {
    render(<WorkflowCanvasArea {...makeProps()} />);
    expect(screen.getByText("No debug trace yet. Send a chat message or call a webhook endpoint.")).toBeInTheDocument();
  });

  it("fires execute workflow action from execute strip", async () => {
    const user = userEvent.setup();
    const onExecuteWorkflow = vi.fn();

    render(<WorkflowCanvasArea {...makeProps({ onExecuteWorkflow })} />);

    await user.click(screen.getByRole("button", { name: "Execute workflow" }));
    expect(onExecuteWorkflow).toHaveBeenCalledTimes(1);
  });

  it("toggles debug mode via debug button", async () => {
    const user = userEvent.setup();
    const onDebugModeChange = vi.fn();

    render(<WorkflowCanvasArea {...makeProps({ debugMode: false, onDebugModeChange })} />);

    await user.click(screen.getByRole("button", { name: "Debug mode: OFF" }));
    expect(onDebugModeChange).toHaveBeenCalledWith(true);
  });

  it("shows stop run and invokes cancel callback when a run is cancelable", async () => {
    const user = userEvent.setup();
    const onCancelRun = vi.fn();

    render(<WorkflowCanvasArea {...makeProps({ canCancelRun: true, onCancelRun })} />);

    await user.click(screen.getByRole("button", { name: "Stop run" }));
    expect(onCancelRun).toHaveBeenCalledTimes(1);
  });

  it("filters node drawer for agent attachment ports", async () => {
    const user = userEvent.setup();
    const onCreateNodeFromDefinition = vi.fn();
    const groupedDefinitions = new Map([
      [
        "LLM",
        [
          {
            type: "openai_chat_model",
            label: "OpenAI Chat Model",
            category: "LLM",
            description: "Calls OpenAI chat models.",
            sampleConfig: {}
          }
        ]
      ],
      [
        "MCP",
        [
          {
            type: "mcp_tool",
            label: "MCP Tool",
            category: "MCP",
            description: "Calls an MCP tool.",
            sampleConfig: {}
          }
        ]
      ]
    ]);

    render(
      <WorkflowCanvasArea
        {...makeProps({
          showNodeDrawer: true,
          groupedDefinitions,
          nodeDrawerContext: {
            title: "Language Models",
            description: "Choose a chat model.",
            allowedTypes: ["openai_chat_model"],
            sourceNodeId: "agent-1",
            sourceHandle: "chat_model"
          },
          onCreateNodeFromDefinition
        })}
      />
    );

    expect(screen.getByText("Language Models")).toBeInTheDocument();
    expect(screen.getByText("OpenAI Chat Model")).toBeInTheDocument();
    expect(screen.queryByText("MCP Tool")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /OpenAI Chat Model/i }));
    expect(onCreateNodeFromDefinition).toHaveBeenCalledWith(expect.objectContaining({ type: "openai_chat_model" }));
  });
});
