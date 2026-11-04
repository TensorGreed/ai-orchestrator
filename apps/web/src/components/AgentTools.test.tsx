import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Node } from "reactflow";
import type { Workflow } from "@ai-orchestrator/shared";
import type { EditorNodeData } from "../lib/workflow";
import * as api from "../lib/api";
import { NodeInspector } from "./NodeConfigModal";
import { NodePalette, paletteKey } from "./NodePalette";
import { BUILT_IN_TOOL_PRESETS, withAgentToolPresets } from "../lib/agent-tool-presets";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchWorkflows: vi.fn(),
    fetchWorkflow: vi.fn(),
    fetchMcpServers: vi.fn(),
    fetchMcpPresets: vi.fn(),
    discoverMcpTools: vi.fn()
  };
});

function makeNode(nodeType: EditorNodeData["nodeType"], config: Record<string, unknown>): Node<EditorNodeData> {
  return { id: "n1", type: "workflowNode", position: { x: 0, y: 0 }, data: { label: "Tool", nodeType, config } };
}

function makeProps(node: Node<EditorNodeData>, onSave = vi.fn()): Parameters<typeof NodeInspector>[0] {
  return {
    node,
    inputOptions: [],
    executionResult: null,
    workflowContext: { id: "wf-parent", name: "Parent", vars: {} },
    pinnedData: {},
    showRuntimeInspection: false,
    secrets: [],
    onRefreshSecrets: vi.fn(),
    mcpServerDefinitions: [
      { id: "l2m-tools", label: "L2M built-in tools", description: "" },
      { id: "l2m-workflow", label: "Workflow tools", description: "" },
      { id: "mock-mcp", label: "Mock MCP Server", description: "" }
    ],
    onClose: vi.fn(),
    onSave,
    onExecuteStep: vi.fn(),
    onPinNodeOutput: vi.fn(),
    onUnpinNodeOutput: vi.fn()
  };
}

const child: Workflow = {
  id: "wf-lookup",
  name: "Order lookup",
  schemaVersion: "1.0.0",
  workflowVersion: 1,
  nodes: [
    {
      id: "start",
      type: "sub_workflow_trigger",
      name: "Start",
      position: { x: 0, y: 0 },
      config: { description: "Looks up an order.", inputSchema: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] } }
    }
  ],
  edges: []
};

describe("agent tool presets in the palette", () => {
  it("adds one MCP Tool preset per built-in provider, each with its own key and ready configuration", async () => {
    expect(withAgentToolPresets([])).toEqual([]);
    const definitions = withAgentToolPresets([{ type: "mcp_tool", label: "MCP Tool", category: "MCP", description: "", sampleConfig: {} }]);
    expect(definitions.map(paletteKey)).toEqual(["mcp_tool", "built-in-tool:wikipedia", "built-in-tool:searxng", "built-in-tool:serpapi", "built-in-tool:wolfram"]);

    const onPick = vi.fn();
    render(
      <NodePalette
        title="Tools"
        subtitle=""
        sections={[{ key: "apps", title: "Apps", description: "", icon: "app", items: [...BUILT_IN_TOOL_PRESETS] }]}
        onPick={onPick}
        onClose={vi.fn()}
      />
    );
    await userEvent.setup().click(screen.getByRole("option", { name: /Wikipedia/ }));
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ type: "mcp_tool", sampleConfig: { serverId: "l2m-tools", toolName: "__all__", connection: { provider: "wikipedia" } } })
    );
    expect(screen.getAllByRole("option")).toHaveLength(4);
  });
});

describe("built-in tool fields on an MCP Tool node", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.fetchMcpPresets).mockResolvedValue({ presets: [] });
    vi.mocked(api.fetchMcpServers).mockResolvedValue({ servers: [], adapters: [], defaultProbeIntervalMs: 300000 });
    vi.mocked(api.discoverMcpTools).mockResolvedValue({ serverId: "l2m-tools", tools: [] });
  });

  it("shows the provider, endpoint and key hint, and never offers the workflow adapter", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<NodeInspector {...makeProps(makeNode("mcp_tool", { serverId: "l2m-tools", toolName: "__all__", connection: { provider: "wikipedia" } }), onSave)} />);
    expect(await screen.findByRole("combobox", { name: /Built-in tool/ })).toHaveValue("wikipedia");
    expect(screen.getByLabelText(/Language edition/)).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Workflow tools/ })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: /Built-in tool/ }), "serpapi");
    expect(screen.getByText(/Your SerpAPI API key/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Language edition/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].config).toMatchObject({ serverId: "l2m-tools", toolName: "__all__", connection: { provider: "serpapi" } });
  });
});

describe("Workflow Tool node", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.fetchMcpPresets).mockResolvedValue({ presets: [] });
    vi.mocked(api.fetchMcpServers).mockResolvedValue({ servers: [], adapters: [], defaultProbeIntervalMs: 300000 });
    vi.mocked(api.fetchWorkflows).mockResolvedValue([{ id: "wf-lookup", name: "Order lookup" }] as unknown as Awaited<ReturnType<typeof api.fetchWorkflows>>);
    vi.mocked(api.fetchWorkflow).mockResolvedValue(child);
  });

  it("picks the child workflow, previews the tool the agent sees, and saves the overrides", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<NodeInspector {...makeProps(makeNode("workflow_tool", { workflowId: "" }), onSave)} />);
    const picker = await screen.findByRole("combobox", { name: /^Workflow/ });
    await waitFor(() => expect(screen.getByRole("option", { name: /Order lookup \(wf-lookup\)/ })).toBeInTheDocument());
    await user.selectOptions(picker, "wf-lookup");

    const preview = await screen.findByTestId("workflow-tool-preview");
    expect(preview).toHaveTextContent("order_lookup");
    expect(preview).toHaveTextContent("Sub-Workflow Trigger");
    expect(preview).toHaveTextContent("Looks up an order.");
    expect(preview).toHaveTextContent('"order_id"');
    expect(api.fetchWorkflow).toHaveBeenCalledWith("wf-lookup");
    expect(screen.getByText("workflow:wf-lookup")).toBeInTheDocument();

    await user.type(screen.getByLabelText(/Tool name/), "find order");
    expect(await screen.findByTestId("workflow-tool-preview")).toHaveTextContent("find_order");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].config).toMatchObject({ workflowId: "wf-lookup", toolName: "find order" });
  });

  it("says why when the child cannot be loaded", async () => {
    vi.mocked(api.fetchWorkflow).mockRejectedValue(new Error("Workflow not found"));
    render(<NodeInspector {...makeProps(makeNode("workflow_tool", { workflowId: "wf-gone" }))} />);
    expect(await screen.findByTestId("workflow-tool-error")).toHaveTextContent("Workflow not found");
  });
});
