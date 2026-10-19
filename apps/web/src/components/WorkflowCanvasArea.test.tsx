import { createRef } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import type { WorkflowExecutionResult } from "@ai-orchestrator/shared";
import { Position, ReactFlowProvider, type Edge, type Node, type NodeProps, type ReactFlowInstance } from "reactflow";
import { WorkflowCanvasArea } from "./WorkflowCanvasArea";
import { WorkflowCanvasNode } from "./WorkflowCanvasNode";
import { AttachmentSpokeEdge, WorkflowCanvasEdge } from "./WorkflowCanvasEdge";
import type { EditorNodeData } from "../lib/workflow";

const nodeTypes = { workflowNode: WorkflowCanvasNode };
const edgeTypes = { workflowBezier: WorkflowCanvasEdge, attachmentSpoke: AttachmentSpokeEdge };

function makeNode(id: string, nodeType: EditorNodeData["nodeType"], label: string, position = { x: 0, y: 0 }, extra: Partial<EditorNodeData> = {}): Node<EditorNodeData> {
  return { id, type: "workflowNode", position, data: { label, nodeType, config: {}, ...extra } };
}

function nodeProps(node: Node<EditorNodeData>): NodeProps<EditorNodeData> {
  return {
    id: node.id,
    type: node.type ?? "workflowNode",
    data: node.data,
    selected: false,
    isConnectable: true,
    xPos: node.position.x,
    yPos: node.position.y,
    zIndex: 0,
    dragging: false,
    sourcePosition: Position.Right,
    targetPosition: Position.Left
  };
}

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
    nodeTypes,
    edgeTypes,
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

const definitions = new Map([
  [
    "LLM",
    [
      {
        type: "openai_chat_model",
        label: "OpenAI Chat Model",
        category: "LLM",
        description: "Calls OpenAI chat models.",
        sampleConfig: {}
      },
      {
        type: "llm_call",
        label: "LLM Call",
        category: "LLM",
        description: "Executes a model completion call.",
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

describe("WorkflowCanvasArea", () => {
  it("shows the run tape placeholder by default and the logs placeholder on the Logs tab", async () => {
    const user = userEvent.setup();
    render(<WorkflowCanvasArea {...makeProps()} />);
    expect(screen.getByText("No run yet. Run the workflow to see per-node timing here.")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Logs" }));
    expect(screen.getByText("No debug trace yet. Send a chat message or call a webhook endpoint.")).toBeInTheDocument();
  });

  it("fires the webhook run from the canvas toolbar and leaves the primary run to the HUD", async () => {
    const user = userEvent.setup();
    const onExecuteWebhook = vi.fn();

    render(<WorkflowCanvasArea {...makeProps({ onExecuteWebhook })} />);

    expect(screen.queryByRole("button", { name: "Execute workflow" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Webhook run" }));
    expect(onExecuteWebhook).toHaveBeenCalledTimes(1);
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

    render(
      <WorkflowCanvasArea
        {...makeProps({
          showNodeDrawer: true,
          groupedDefinitions: definitions,
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

    expect(screen.getByRole("heading", { name: "Language Models" })).toBeInTheDocument();
    expect(screen.getByText("OpenAI Chat Model")).toBeInTheDocument();
    expect(screen.queryByText("MCP Tool")).not.toBeInTheDocument();

    await user.click(screen.getByRole("option", { name: /OpenAI Chat Model/i }));
    expect(onCreateNodeFromDefinition).toHaveBeenCalledWith(expect.objectContaining({ type: "openai_chat_model" }));
  });

  it("palette groups by category, focuses search, filters and supports keyboard picking", async () => {
    const user = userEvent.setup();
    const onCreateNodeFromDefinition = vi.fn();
    const onCloseNodeDrawer = vi.fn();

    render(
      <WorkflowCanvasArea
        {...makeProps({ showNodeDrawer: true, groupedDefinitions: definitions, onCreateNodeFromDefinition, onCloseNodeDrawer })}
      />
    );

    const search = screen.getByRole("textbox", { name: "Search nodes" });
    expect(search).toHaveFocus();
    expect(screen.getByText("AI")).toBeInTheDocument();
    expect(screen.getByText("Action in an App")).toBeInTheDocument();

    await user.keyboard("mcp");
    expect(screen.queryByText("OpenAI Chat Model")).not.toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(onCreateNodeFromDefinition).toHaveBeenCalledWith(expect.objectContaining({ type: "mcp_tool" }));

    await user.keyboard("{Escape}");
    expect(onCloseNodeDrawer).toHaveBeenCalled();
  });

  it("renders a stage strip with one pill per stage and focuses the stage on click", async () => {
    const user = userEvent.setup();
    const fitView = vi.fn();
    const nodes = [
      makeNode("trigger", "webhook_input", "Webhook", { x: 0, y: 0 }, { executionStatus: "success" }),
      makeNode("a", "llm_call", "Summarise", { x: 400, y: 0 }, { executionStatus: "error" }),
      makeNode("b", "http_request", "Fetch", { x: 400, y: 200 }),
      makeNode("out", "output", "Output", { x: 800, y: 0 })
    ];
    const edges: Edge[] = [
      { id: "e1", source: "trigger", target: "a" },
      { id: "e2", source: "trigger", target: "b" },
      { id: "e3", source: "a", target: "out" },
      { id: "e4", source: "b", target: "out" }
    ];

    render(
      <WorkflowCanvasArea
        {...makeProps({ nodes, edges, reactFlowInstance: { fitView } as unknown as ReactFlowInstance })}
      />
    );

    const strip = screen.getByRole("navigation", { name: "Workflow stages" });
    const pills = within(strip).getAllByRole("button");
    expect(pills).toHaveLength(3);
    expect(pills[0]).toHaveTextContent("Trigger");
    expect(pills[1]).toHaveTextContent("Stage 02");
    expect(pills[1]).toHaveTextContent("2 in parallel");
    expect(pills[1]).toHaveClass("stage-pill-error");

    await user.click(pills[1]!);
    expect(fitView).toHaveBeenCalledWith(expect.objectContaining({ nodes: [{ id: "a" }, { id: "b" }] }));
  });

  it("hides the stage strip when the canvas is empty", () => {
    render(<WorkflowCanvasArea {...makeProps()} />);
    expect(screen.queryByRole("navigation", { name: "Workflow stages" })).not.toBeInTheDocument();
  });

  it("renders hub slots for empty ports and opens the attachment drawer on click", async () => {
    const user = userEvent.setup();
    const onOpenAgentAttachmentDrawer = vi.fn();
    const hub = makeNode("agent", "agent_orchestrator", "Planner", { x: 300, y: 300 }, {
      slots: { chat_model: [], memory: [], tool: ["tool"], worker: [] },
      onOpenAgentAttachmentDrawer
    });

    render(
      <ReactFlowProvider>
        <WorkflowCanvasNode {...nodeProps(hub)} />
      </ReactFlowProvider>
    );

    const modelSlot = screen.getByRole("button", { name: /Add chat model \(required\)/ });
    expect(modelSlot).toHaveTextContent("+ model");
    expect(screen.getByRole("button", { name: /^Add memory/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Add tool/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Add worker/ })).not.toBeInTheDocument();
    expect(screen.getByText("Planner")).toHaveClass("wf-hub-title");

    await user.click(modelSlot);
    expect(onOpenAgentAttachmentDrawer).toHaveBeenCalledWith("chat_model");
  });

  it("renders a supervisor with a worker slot and attached resources as satellites", () => {
    const supervisor = makeNode("sup", "supervisor_node", "Lead", { x: 0, y: 0 }, { slots: { chat_model: ["m"], memory: [], tool: [], worker: [] } });
    const satellite = makeNode("m", "openai_chat_model", "GPT", { x: 0, y: 0 }, { attachedTo: "sup", attachedAs: "chat_model" });

    render(
      <ReactFlowProvider>
        <WorkflowCanvasNode {...nodeProps(supervisor)} />
        <WorkflowCanvasNode {...nodeProps(satellite)} />
      </ReactFlowProvider>
    );

    expect(screen.getByRole("button", { name: /^Add worker/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add chat model/ })).not.toBeInTheDocument();
    const sat = document.querySelector(".wf-node-satellite-chat_model");
    expect(sat).not.toBeNull();
    expect(sat!.querySelector(".wf-satellite-name")).toHaveTextContent("GPT");
    expect(sat!.querySelector(".wf-satellite-port")).toHaveTextContent("Chat Model");
  });

  it("renders a card with type and config summary in mono", () => {
    const card = makeNode("h", "http_request", "Fetch users", { x: 0, y: 0 }, { config: { method: "GET", urlTemplate: "https://api.example.com/users" } });
    render(
      <ReactFlowProvider>
        <WorkflowCanvasNode {...nodeProps(card)} />
      </ReactFlowProvider>
    );
    expect(document.querySelector(".wf-card-type")).toHaveTextContent("http_request");
    expect(document.querySelector(".wf-card-summary")).toHaveTextContent("GET · https://api.example.com/users");
    expect(screen.getByLabelText("Idle")).toHaveClass("wf-status-idle");
  });

  it("snaps attached nodes onto the hub orbit through onNodesChange", () => {
    const onNodesChange = vi.fn();
    const nodes = [
      makeNode("agent", "agent_orchestrator", "Planner", { x: 300, y: 300 }),
      makeNode("model", "openai_chat_model", "GPT", { x: 0, y: 0 })
    ];
    const edges: Edge[] = [{ id: "att", source: "agent", target: "model", sourceHandle: "chat_model" }];

    render(<WorkflowCanvasArea {...makeProps({ nodes, edges, onNodesChange })} />);

    const positionChanges = onNodesChange.mock.calls.flatMap((call) => call[0]).filter((change: { type: string }) => change.type === "position");
    expect(positionChanges).toEqual([expect.objectContaining({ id: "model", type: "position" })]);
  });

  it("renders the run tape with LLM time from node telemetry", () => {
    const executionResult: WorkflowExecutionResult = {
      workflowId: "wf",
      status: "success",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:05.000Z",
      nodeResults: [
        { nodeId: "trigger", status: "success", startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:00.200Z", durationMs: 200 },
        {
          nodeId: "a",
          status: "success",
          startedAt: "2026-01-01T00:00:00.200Z",
          completedAt: "2026-01-01T00:00:04.200Z",
          durationMs: 4000,
          output: { answer: "x", _telemetry: { latencyMs: 3000, providerId: "openai" } }
        },
        { nodeId: "out", status: "error", startedAt: "2026-01-01T00:00:04.200Z", durationMs: 50, error: "boom" }
      ]
    };
    const nodes = [makeNode("trigger", "webhook_input", "Webhook"), makeNode("a", "llm_call", "Summarise", { x: 400, y: 0 }), makeNode("out", "output", "Output", { x: 800, y: 0 })];

    render(<WorkflowCanvasArea {...makeProps({ nodes, executionResult })} />);

    const tape = screen.getByRole("table", { name: "Run tape" });
    const rows = within(tape).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent("Summarise");
    expect(rows[1]!.querySelector(".run-tape-llm")).toHaveStyle({ width: "75%" });
    expect(rows[2]!.querySelector(".run-tape-bar")).toHaveClass("run-tape-bar-error");
  });
});
