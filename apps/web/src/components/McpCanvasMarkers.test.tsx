import { render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReactFlowProvider, type NodeProps } from "reactflow";
import { beforeEach, vi } from "vitest";
import * as api from "../lib/api";
import { deriveCanvasMarker, type McpCanvasMarker } from "../lib/mcp-control-plane";
import { clearMcpCanvasStatusCache, useMcpCanvasStatus } from "../lib/use-mcp-canvas-status";
import type { EditorNodeData } from "../lib/workflow";
import { WorkflowCanvasNode } from "./WorkflowCanvasNode";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, fetchMcpToolCatalog: vi.fn() };
});

function marker(overrides: Partial<McpCanvasMarker> = {}): McpCanvasMarker {
  return {
    serverId: "mcp_a",
    serverName: "GitHub tools",
    status: "healthy",
    statusLabel: "Healthy",
    breakingPending: false,
    circuit: null,
    policy: "read_only",
    blockingRuleId: null,
    blockingRuleName: null,
    blockedCount: 0,
    toolCount: 1,
    description: "GitHub tools: Healthy · read-only",
    ...overrides
  };
}

function renderNode(data: Partial<EditorNodeData>, onOpen = vi.fn()) {
  const props = {
    id: "n1",
    type: "workflowNode",
    selected: false,
    zIndex: 0,
    isConnectable: true,
    xPos: 0,
    yPos: 0,
    dragging: false,
    data: {
      label: "Search issues",
      nodeType: "mcp_tool",
      config: { registryServerId: "mcp_a", toolName: "search_issues" },
      onOpenMcpTarget: onOpen,
      ...data
    } as EditorNodeData
  } as NodeProps<EditorNodeData>;
  render(
    <ReactFlowProvider>
      <WorkflowCanvasNode {...props} />
    </ReactFlowProvider>
  );
  return onOpen;
}

describe("MCP markers on canvas nodes", () => {
  it.each([
    ["healthy", "Healthy"],
    ["degraded", "Degraded"],
    ["down", "Down"],
    ["unknown", "Not probed"]
  ] as const)("names the %s probe status on a card", async (status, label) => {
    const user = userEvent.setup();
    const onOpen = renderNode({ mcpMarker: marker({ status, statusLabel: label, description: `GitHub tools: ${label}` }) });
    const button = screen.getByRole("button", { name: `MCP server GitHub tools: ${label}. Open server` });
    expect(button).toHaveTextContent(label);
    expect(button).toHaveAttribute("title", `GitHub tools: ${label}`);
    await user.click(button);
    expect(onOpen).toHaveBeenCalledWith({ page: "servers", serverId: "mcp_a" });
  });

  it("marks a pending breaking change and opens the server", async () => {
    const user = userEvent.setup();
    const onOpen = renderNode({ mcpMarker: marker({ breakingPending: true }) });
    await user.click(screen.getByRole("button", { name: "Breaking change pending on GitHub tools. Open server to review" }));
    expect(onOpen).toHaveBeenCalledWith({ page: "servers", serverId: "mcp_a" });
  });

  it("shows Circuit open when the server's breaker is open and opens the server", async () => {
    const user = userEvent.setup();
    const onOpen = renderNode({ mcpMarker: marker({ circuit: "open" }) });
    const chip = screen.getByRole("button", { name: "Circuit open on GitHub tools. Open server" });
    expect(chip).toHaveTextContent("Circuit open");
    expect(chip).toHaveAttribute("title", expect.stringMatching(/calls are paused/));
    await user.click(chip);
    expect(onOpen).toHaveBeenCalledWith({ page: "servers", serverId: "mcp_a" });
    document.body.innerHTML = "";
    renderNode({ mcpMarker: marker({ circuit: "half_open" }) });
    expect(screen.getByRole("button", { name: "Circuit half-open on GitHub tools. Open server" })).toHaveTextContent("Half-open");
    document.body.innerHTML = "";
    renderNode({ mcpMarker: marker() });
    expect(screen.queryByRole("button", { name: /Circuit/ })).not.toBeInTheDocument();
  });

  it("opens the blocking rule from a blocked marker", async () => {
    const user = userEvent.setup();
    const onOpen = renderNode({
      mcpMarker: marker({ policy: "blocked", blockingRuleId: "rule_1", blockingRuleName: "No deletes", blockedCount: 1 })
    });
    const blocked = screen.getByRole("button", { name: "Blocked for you by policy (rule No deletes). Open the rule" });
    expect(blocked).toHaveTextContent("Blocked");
    await user.click(blocked);
    expect(onOpen).toHaveBeenCalledWith({ page: "policies", policyId: "rule_1" });
  });

  it("labels write and destructive tools and stays quiet for read-only ones", () => {
    renderNode({ mcpMarker: marker({ policy: "write" }) });
    expect(screen.getByRole("img", { name: "Write tool" })).toHaveTextContent("Write");
    document.body.innerHTML = "";
    renderNode({ mcpMarker: marker({ policy: "destructive" }) });
    expect(screen.getByRole("img", { name: "Destructive tool" })).toHaveTextContent("Destructive");
    document.body.innerHTML = "";
    renderNode({ mcpMarker: marker() });
    expect(screen.queryByRole("img", { name: /tool$/ })).not.toBeInTheDocument();
  });

  it("shows a compact marker on a tool satellite with the same accessible names", async () => {
    const user = userEvent.setup();
    const onOpen = renderNode({
      attachedTo: "agent",
      attachedAs: "tool",
      mcpMarker: marker({ status: "down", statusLabel: "Down", policy: "write", blockedCount: 2, toolCount: 5 })
    });
    const status = screen.getByRole("button", { name: "MCP server GitHub tools: Down. Open server" });
    expect(status).not.toHaveTextContent("Down");
    expect(screen.getByRole("img", { name: "Uses write tools" })).toHaveTextContent("Write");
    const partial = screen.getByRole("button", { name: "2 of 5 tools blocked for you. Open the tools" });
    expect(partial).toHaveTextContent("2/5 blocked");
    await user.click(partial);
    expect(onOpen).toHaveBeenCalledWith({ page: "tools", serverId: "mcp_a" });
  });

  it("renders nothing extra for nodes without a registered server", () => {
    renderNode({ config: { serverId: "mock-mcp", toolName: "x" } });
    expect(screen.queryByRole("button", { name: /MCP server/ })).not.toBeInTheDocument();
  });
});

describe("deriveCanvasMarker", () => {
  const servers = new Map([
    ["mcp_a", { id: "mcp_a", name: "GitHub tools", status: "degraded" as const, pendingBreakingSnapshotId: "snap" }]
  ]);
  const tool = (name: string, extra: Partial<api.McpCatalogTool> = {}): api.McpCatalogTool => ({
    serverId: "mcp_a",
    serverName: "GitHub tools",
    serverStatus: "degraded",
    adapterId: "http_mcp",
    name,
    inputSchema: {},
    classification: { readOnly: true, source: "annotation" },
    manualReadOnly: null,
    access: { allowed: true },
    ...extra
  });
  const tools = new Map([
    [
      "mcp_a",
      [
        tool("search"),
        tool("create", { classification: { readOnly: false, source: "annotation" } }),
        tool("drop", {
          classification: { readOnly: false, source: "annotation" },
          annotations: { destructiveHint: true },
          access: { allowed: false, ruleId: "rule_1", ruleName: "No drops" }
        })
      ]
    ]
  ]);

  it("describes one tool's status and policy", () => {
    expect(deriveCanvasMarker({ registryServerId: "mcp_a", toolName: "search" }, servers, tools)).toMatchObject({
      status: "degraded",
      breakingPending: true,
      policy: "read_only",
      description: "GitHub tools: Degraded · breaking change pending · read-only"
    });
    expect(deriveCanvasMarker({ registryServerId: "mcp_a", toolName: "drop" }, servers, tools)).toMatchObject({
      policy: "blocked",
      blockingRuleId: "rule_1",
      description: "GitHub tools: Degraded · breaking change pending · blocked for you by policy"
    });
  });

  it("summarises all tools without calling the node blocked when some remain", () => {
    expect(deriveCanvasMarker({ registryServerId: "mcp_a", toolName: "__all__" }, servers, tools)).toMatchObject({
      policy: "write",
      blockedCount: 1,
      toolCount: 3,
      blockingRuleId: "rule_1"
    });
    expect(deriveCanvasMarker({ registryServerId: "mcp_a", toolName: "__all__", allowedTools: ["drop"] }, servers, tools)).toMatchObject({
      policy: "blocked"
    });
  });

  it("carries the breaker state into the marker", () => {
    const open = new Map([
      ["mcp_a", { id: "mcp_a", name: "GitHub tools", status: "healthy" as const, pendingBreakingSnapshotId: null, breakerState: "open" as const }]
    ]);
    expect(deriveCanvasMarker({ registryServerId: "mcp_a", toolName: "search" }, open, tools)).toMatchObject({
      circuit: "open",
      description: "GitHub tools: Healthy · circuit open: calls are paused after repeated failures · read-only"
    });
    expect(deriveCanvasMarker({ registryServerId: "mcp_a", toolName: "search" }, servers, tools)?.circuit).toBeNull();
  });

  it("ignores inline servers and unknown registry ids", () => {
    expect(deriveCanvasMarker({ serverId: "mock-mcp" }, servers, tools)).toBeNull();
    expect(deriveCanvasMarker({ registryServerId: "gone" }, servers, tools)).toBeNull();
  });
});

describe("useMcpCanvasStatus", () => {
  beforeEach(() => {
    clearMcpCanvasStatusCache();
    vi.mocked(api.fetchMcpToolCatalog).mockReset();
    vi.mocked(api.fetchMcpToolCatalog).mockResolvedValue({
      window: "7d",
      since: "",
      policy: { role: "builder", projectId: "default" },
      servers: [
        { id: "mcp_a", name: "GitHub tools", status: "down", adapterId: "http_mcp", projectId: null, lastProbeAt: null, pendingBreakingSnapshotId: null, toolCount: 1, policyProjectId: "default" }
      ],
      tools: []
    });
  });

  const nodes = [
    { id: "n1", data: { nodeType: "mcp_tool", config: { registryServerId: "mcp_a", toolName: "x" } } },
    { id: "n2", data: { nodeType: "mcp_tool", config: { registryServerId: "mcp_a", toolName: "y" } } },
    { id: "n3", data: { nodeType: "llm_call", config: {} } }
  ];

  it("fetches once per workflow, caches, and refreshes on focus", async () => {
    const { result, rerender } = renderHook((props: { nodes: typeof nodes }) => useMcpCanvasStatus(props.nodes, { projectId: "default", enabled: true }), {
      initialProps: { nodes }
    });
    await waitFor(() => expect(Object.keys(result.current)).toEqual(["n1", "n2"]));
    expect(result.current.n1.status).toBe("down");
    expect(api.fetchMcpToolCatalog).toHaveBeenCalledTimes(1);
    expect(api.fetchMcpToolCatalog).toHaveBeenCalledWith({ projectId: "default", serverIds: ["mcp_a"], detail: false });

    // Moving nodes does not refetch.
    rerender({ nodes: nodes.map((node) => ({ ...node })) });
    expect(api.fetchMcpToolCatalog).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(api.fetchMcpToolCatalog).toHaveBeenCalledTimes(2));
  });

  it("does nothing when disabled or without registered servers", () => {
    renderHook(() => useMcpCanvasStatus(nodes, { projectId: "default", enabled: false }));
    renderHook(() => useMcpCanvasStatus([nodes[2]], { projectId: "default", enabled: true }));
    expect(api.fetchMcpToolCatalog).not.toHaveBeenCalled();
  });
});

describe("marker container", () => {
  it("keeps every marker in one container that carries the summary tooltip", () => {
    renderNode({ mcpMarker: marker({ breakingPending: true, policy: "destructive" }) });
    const container = screen.getByRole("button", { name: /MCP server/ }).parentElement as HTMLElement;
    expect(within(container).getAllByRole("button")).toHaveLength(2);
    expect(container).toHaveAttribute("title", "GitHub tools: Healthy · read-only");
  });
});
