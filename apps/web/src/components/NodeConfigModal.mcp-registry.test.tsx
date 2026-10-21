import { render, screen, waitFor, within } from "@testing-library/react";
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
    discoverMcpTools: vi.fn(),
    fetchMcpServerPrompts: vi.fn(),
    fetchMcpServerResources: vi.fn()
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

  it("switches an MCP Tool node to reading a resource picked from the server's catalog", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    vi.mocked(api.fetchMcpServerResources).mockResolvedValue({
      serverId: "mcp_gh",
      capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
      updatedAt: registered.lastProbeAt,
      policy: { role: "builder", projectId: "default" },
      resources: [{ uri: "gh://repo/README.md", name: "readme", title: "Read me", access: { allowed: true } }],
      resourceTemplates: [{ uriTemplate: "gh://repo/{path}", name: "file", access: { allowed: true } }]
    });
    render(<NodeInspector {...makeProps(makeToolNode({ registryServerId: "mcp_gh", serverId: "stdio_mcp", toolName: "search_issues" }), onSave)} />);

    await user.selectOptions(await screen.findByRole("combobox", { name: /^Operation/ }), "read_resource");
    expect(screen.queryByRole("button", { name: /Discover/ })).not.toBeInTheDocument();
    await waitFor(() => expect(api.fetchMcpServerResources).toHaveBeenCalledWith("mcp_gh", { projectId: null }));
    const picker = await screen.findByRole("combobox", { name: /Pick from the server/ });
    await waitFor(() => expect(within(picker).getByRole("option", { name: /Read me/ })).toBeInTheDocument());
    await user.selectOptions(picker, "gh://repo/{path}");
    expect(screen.getByRole("textbox", { name: "Resource URI" })).toHaveValue("gh://repo/{path}");

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].config).toMatchObject({ operation: "read_resource", resourceUri: "gh://repo/{path}", registryServerId: "mcp_gh" });
  });

  it("binds a server prompt as the system message of an agent node", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    vi.mocked(api.fetchMcpServerPrompts).mockResolvedValue({
      serverId: "mcp_gh",
      capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
      updatedAt: registered.lastProbeAt,
      policy: { role: "builder", projectId: "default" },
      prompts: [
        {
          name: "triage",
          title: "Triage issues",
          description: "Sorts issues by area",
          arguments: [{ name: "area", required: true }],
          access: { allowed: true }
        }
      ]
    });
    const node: Node<EditorNodeData> = {
      id: "agent-1",
      type: "workflowNode",
      position: { x: 0, y: 0 },
      data: { label: "Agent", nodeType: "agent_orchestrator", config: { systemPromptTemplate: "{{system_prompt}}" } }
    };
    render(<NodeInspector {...makeProps(node, onSave)} />);

    const serverPicker = await screen.findByRole("combobox", { name: /^Server prompt/ });
    await user.selectOptions(serverPicker, "mcp_gh");
    await waitFor(() => expect(api.fetchMcpServerPrompts).toHaveBeenCalledWith("mcp_gh", { projectId: null }));
    const promptPicker = screen.getByRole("combobox", { name: /^Prompt/ });
    await waitFor(() => expect(within(promptPicker).getByRole("option", { name: "Triage issues" })).toBeInTheDocument());
    await user.selectOptions(promptPicker, "triage");
    expect(screen.getByText("Sorts issues by area")).toBeInTheDocument();
    await user.type(screen.getByLabelText("area (required)"), "billing");
    await user.selectOptions(screen.getByRole("combobox", { name: /^Use as/ }), "user");

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].config).toMatchObject({
      serverPrompt: { registryServerId: "mcp_gh", name: "triage", arguments: { area: "billing" }, target: "user" }
    });
  });

  it("shows sampling, elicitation and server prompt entries on the Trace tab", async () => {
    const user = userEvent.setup();
    const node = makeToolNode({ registryServerId: "mcp_gh", serverId: "stdio_mcp", toolName: "search_issues" });
    const executionResult = {
      workflowId: "wf-1",
      status: "success" as const,
      startedAt: "2026-10-20T10:00:00.000Z",
      completedAt: "2026-10-20T10:00:01.000Z",
      nodeResults: [
        {
          nodeId: "tool-1",
          status: "success" as const,
          output: {
            result: "ok",
            _serverPrompt: { registryServerId: "mcp_gh", name: "triage", target: "system", chars: 120, messageCount: 1 },
            _mcpSampling: [
              {
                toolName: "search_issues",
                call: 1,
                serverId: "stdio_mcp",
                requestedModels: ["fast-model"],
                model: "gpt-test",
                ok: true,
                prompt: "Summarise",
                response: "Two issues.",
                maxTokens: 200,
                inputTokens: 11,
                outputTokens: 5,
                durationMs: 40,
                at: "2026-10-20T10:00:00.500Z"
              }
            ],
            _mcpElicitations: [
              {
                toolName: "search_issues",
                serverId: "stdio_mcp",
                message: "Which repo?",
                action: "decline",
                source: "unattended",
                note: "Unattended run (webhook): nobody can answer, declined automatically.",
                durationMs: 1,
                at: "2026-10-20T10:00:00.600Z"
              }
            ]
          }
        }
      ]
    };
    render(<NodeInspector {...makeProps(node)} executionResult={executionResult as never} />);
    await user.click(await screen.findByRole("tab", { name: /Trace/ }));

    expect(screen.getByTestId("insp-trace-server-prompt")).toHaveTextContent("triage");
    const sampling = screen.getByTestId("insp-trace-sampling");
    expect(sampling).toHaveTextContent("generate 1 time");
    expect(sampling).toHaveTextContent("gpt-test answered (asked for fast-model)");
    expect(sampling).toHaveTextContent("Two issues.");
    const elicitations = screen.getByTestId("insp-trace-elicitations");
    expect(elicitations).toHaveTextContent("Which repo?");
    expect(elicitations).toHaveTextContent("declined automatically (unattended run)");
  });
});
