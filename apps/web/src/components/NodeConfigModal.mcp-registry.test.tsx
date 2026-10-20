import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, vi } from "vitest";
import type { Node } from "reactflow";
import type { EditorNodeData } from "../lib/workflow";
import * as api from "../lib/api";
import { NodeInspector } from "./NodeConfigModal";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchMcpServers: vi.fn(),
    fetchMcpServerTools: vi.fn(),
    fetchMcpPresets: vi.fn(),
    discoverMcpTools: vi.fn()
  };
});

const registered: api.McpRegisteredServer = {
  id: "mcp_gh",
  name: "GitHub tools",
  description: null,
  adapterId: "stdio_mcp",
  connection: { command: "npx" },
  secretId: "sec_1",
  owner: null,
  projectId: null,
  probeEnabled: true,
  probeIntervalMs: null,
  blockOnBreakingChange: true,
  status: "healthy",
  lastProbeAt: "2026-10-20T10:00:00.000Z",
  lastProbeOk: true,
  lastProbeLatencyMs: 80,
  lastProbeError: null,
  toolCount: 1,
  currentSnapshotId: "snap_1",
  pendingBreakingSnapshotId: "snap_1",
  createdBy: null,
  createdAt: "2026-10-19T10:00:00.000Z",
  updatedAt: "2026-10-20T10:00:00.000Z",
  latency: { samples: 1, p50Ms: 80, p95Ms: 80, errorRate: 0 }
};

function makeToolNode(config: Record<string, unknown>): Node<EditorNodeData> {
  return {
    id: "tool-1",
    type: "workflowNode",
    position: { x: 0, y: 0 },
    data: { label: "GitHub", nodeType: "mcp_tool", config }
  };
}

function makeProps(node: Node<EditorNodeData>, onSave = vi.fn()): Parameters<typeof NodeInspector>[0] {
  return {
    node,
    inputOptions: [],
    executionResult: null,
    workflowContext: { id: "wf-1", name: "Workflow 1", vars: {} },
    pinnedData: {},
    showRuntimeInspection: false,
    secrets: [],
    onRefreshSecrets: vi.fn(),
    mcpServerDefinitions: [{ id: "http_mcp", label: "HTTP MCP", description: "" }],
    onClose: vi.fn(),
    onSave,
    onExecuteStep: vi.fn(),
    onPinNodeOutput: vi.fn(),
    onUnpinNodeOutput: vi.fn()
  };
}

describe("MCP Tool node registry picker", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.fetchMcpPresets).mockResolvedValue({ presets: [] });
    vi.mocked(api.discoverMcpTools).mockResolvedValue({ serverId: "http_mcp", tools: [] });
    vi.mocked(api.fetchMcpServers).mockResolvedValue({
      servers: [registered],
      adapters: [],
      defaultProbeIntervalMs: 300000
    });
    vi.mocked(api.fetchMcpServerTools).mockResolvedValue({
      serverId: "mcp_gh",
      snapshotId: "snap_1",
      probedAt: registered.lastProbeAt,
      tools: [{ name: "search_issues", description: "Search", inputSchema: { type: "object" } }]
    });
  });

  it("switches the node to a registered server and drops the inline connection and secret", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <NodeInspector
        {...makeProps(
          makeToolNode({
            serverId: "http_mcp",
            toolName: "__all__",
            connection: { endpoint: "http://old/mcp" },
            secretRef: { secretId: "sec_old" }
          }),
          onSave
        )}
      />
    );

    const picker = await screen.findByRole("combobox", { name: /Registered server/ });
    await user.selectOptions(picker, "mcp_gh");

    expect(await screen.findByText(/Found 1 tools from the registered server's last probe/)).toBeInTheDocument();
    expect(api.fetchMcpServerTools).toHaveBeenCalledWith("mcp_gh");
    expect(screen.getByText(/Breaking tool schema change pending/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /MCP Server Adapter/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const saved = onSave.mock.calls[0][0].config as Record<string, unknown>;
    expect(saved).toMatchObject({ registryServerId: "mcp_gh", serverId: "stdio_mcp" });
    expect(saved).not.toHaveProperty("connection");
    expect(saved).not.toHaveProperty("secretRef");
  });

  it("shows annotation chips and the output schema for a registered server's tool", async () => {
    vi.mocked(api.fetchMcpServerTools).mockResolvedValue({
      serverId: "mcp_gh",
      snapshotId: "snap_1",
      probedAt: registered.lastProbeAt,
      tools: [
        {
          name: "search_issues",
          description: "Search",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true, openWorldHint: false, title: "Search issues" },
          outputSchema: { type: "object", properties: { total: { type: "integer" } }, required: ["total"] }
        }
      ]
    });
    render(<NodeInspector {...makeProps(makeToolNode({ registryServerId: "mcp_gh", serverId: "stdio_mcp", toolName: "search_issues" }))} />);

    expect((await screen.findAllByText("Read-only")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Closed world").length).toBeGreaterThan(0);
    expect(screen.getAllByText("total*").length).toBeGreaterThan(0);
    expect(screen.queryByText("No output schema; the tool returns text.")).not.toBeInTheDocument();
  });

  it("keeps inline configuration when no server is registered", async () => {
    vi.mocked(api.fetchMcpServers).mockResolvedValue({ servers: [], adapters: [], defaultProbeIntervalMs: 300000 });
    render(<NodeInspector {...makeProps(makeToolNode({ serverId: "http_mcp", toolName: "__all__" }))} />);

    expect(await screen.findByRole("combobox", { name: /MCP Server Adapter/ })).toBeInTheDocument();
    await waitFor(() => expect(api.fetchMcpServers).toHaveBeenCalled());
    expect(screen.queryByRole("combobox", { name: /Registered server/ })).not.toBeInTheDocument();
  });

  it("opens a node that uses a registered server without marking it dirty", async () => {
    render(<NodeInspector {...makeProps(makeToolNode({ registryServerId: "mcp_gh", serverId: "stdio_mcp", toolName: "search_issues" }))} />);

    await screen.findByText(/Found 1 tools/);
    expect(screen.getByRole("button", { name: "Save changes" })).not.toHaveAttribute("data-dirty");
  });

  it("notes when the selected tool is blocked for the current user", async () => {
    vi.mocked(api.fetchMcpServerTools).mockResolvedValue({
      serverId: "mcp_gh",
      snapshotId: "snap_1",
      probedAt: registered.lastProbeAt,
      policy: { role: "viewer", projectId: "proj_a" },
      tools: [
        {
          name: "create_issue",
          inputSchema: { type: "object" },
          classification: { readOnly: false, source: "unknown" },
          manualReadOnly: null,
          access: { allowed: false, reason: "policy", ruleId: "r1", ruleName: "Viewers: no GitHub writes", message: "blocked" }
        },
        {
          name: "search_issues",
          inputSchema: { type: "object" },
          classification: { readOnly: true, source: "annotation" },
          manualReadOnly: null,
          access: { allowed: true }
        }
      ]
    });
    const props = makeProps(makeToolNode({ registryServerId: "mcp_gh", serverId: "stdio_mcp", toolName: "create_issue" }));
    render(<NodeInspector {...props} workflowContext={{ ...props.workflowContext, projectId: "proj_a" }} />);

    const note = await screen.findByTestId("mcp-policy-blocked");
    expect(api.fetchMcpServerTools).toHaveBeenCalledWith("mcp_gh", "proj_a");
    expect(note).toHaveTextContent("Blocked for you by MCP tool policy");
    expect(note).toHaveTextContent("create_issue: blocked by Viewers: no GitHub writes");
    expect(note).not.toHaveTextContent("search_issues");
  });

  it("shows no policy note when the selected tool is allowed", async () => {
    render(<NodeInspector {...makeProps(makeToolNode({ registryServerId: "mcp_gh", serverId: "stdio_mcp", toolName: "search_issues" }))} />);
    await screen.findByText(/Found 1 tools/);
    expect(screen.queryByTestId("mcp-policy-blocked")).not.toBeInTheDocument();
  });

  it("flags a reference to a server that was deleted", async () => {
    render(<NodeInspector {...makeProps(makeToolNode({ registryServerId: "mcp_gone", serverId: "stdio_mcp", toolName: "__all__" }))} />);

    expect(await screen.findByText(/no longer exists/)).toBeInTheDocument();
  });
});
