import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../lib/api";
import { McpServersPage } from "./McpServersPage";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchMcpServers: vi.fn(),
    fetchMcpServer: vi.fn(),
    fetchMcpServerTools: vi.fn(),
    fetchMcpServerTelemetry: vi.fn(),
    fetchMcpPresets: vi.fn(),
    fetchSecrets: vi.fn(),
    fetchProjects: vi.fn(),
    fetchMcpToolsets: vi.fn(),
    fetchMcpToolsetCandidates: vi.fn(),
    createMcpToolset: vi.fn(),
    updateMcpToolset: vi.fn(),
    deleteMcpToolset: vi.fn(),
    previewMcpToolset: vi.fn(),
    fetchMcpClients: vi.fn(),
    createMcpClient: vi.fn(),
    revokeMcpClient: vi.fn(),
    fetchMcpClientUsage: vi.fn()
  };
});

const server: api.McpRegisteredServer = {
  id: "mcp_1",
  name: "Demo tools",
  description: null,
  adapterId: "mock-mcp",
  connection: {},
  secretId: null,
  owner: null,
  projectId: null,
  probeEnabled: true,
  probeIntervalMs: null,
  blockOnBreakingChange: true,
  status: "healthy",
  lastProbeAt: "2026-10-20T10:00:00.000Z",
  lastProbeOk: true,
  lastProbeLatencyMs: 12,
  lastProbeError: null,
  toolCount: 2,
  currentSnapshotId: "snap_1",
  pendingBreakingSnapshotId: null,
  createdBy: null,
  createdAt: "2026-10-19T10:00:00.000Z",
  updatedAt: "2026-10-20T10:00:00.000Z",
  latency: { samples: 1, p50Ms: 12, p95Ms: 12, errorRate: 0 }
};

const toolset: api.McpToolsetView = {
  id: "mts_1",
  slug: "support",
  name: "Support tools",
  description: null,
  projectId: null,
  enabled: true,
  createdBy: "admin@example.com",
  createdAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-20T10:00:00.000Z",
  endpointPath: "/mcp/support",
  activeSessions: 0,
  members: [
    { id: "m1", kind: "workflow", workflowId: "wf_1", label: "Ticket lookup", missing: false },
    { id: "m2", kind: "server", serverId: "mcp_1", toolGlob: "lookup_*", label: "Demo tools", missing: false }
  ]
};

const activeClient: api.McpClientView = {
  id: "mcc_1",
  name: "Team IDE",
  tokenPrefix: "l2m_mcp_abcdefghijkl",
  toolsetIds: ["mts_1"],
  role: "builder",
  createdBy: "usr_1",
  createdByEmail: "admin@example.com",
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
  createdAt: "2026-10-20T10:00:00.000Z",
  status: "active",
  effectiveRole: "builder",
  activeSessions: 1,
  usage: { calls: 3, errors: 1, lastCalledAt: "2026-10-20T11:00:00.000Z" }
};

function setup() {
  vi.mocked(api.fetchMcpServers).mockResolvedValue({
    servers: [server],
    adapters: [{ id: "mock-mcp", label: "Mock MCP" }],
    defaultProbeIntervalMs: 300000
  });
  vi.mocked(api.fetchMcpServer).mockResolvedValue({ server, probes: [], snapshots: [], usages: [] });
  vi.mocked(api.fetchMcpServerTools).mockResolvedValue({ serverId: "mcp_1", snapshotId: null, probedAt: null, tools: [] });
  vi.mocked(api.fetchMcpServerTelemetry).mockImplementation(async (_id, window = "7d") => ({
    serverId: "mcp_1",
    window,
    since: "2026-10-13T10:00:00.000Z",
    totals: { calls: 0, errors: 0, errorRate: 0, p50Ms: null, p95Ms: null, inputTokens: 0, outputTokens: 0, costUsd: null, lastCalledAt: null },
    tools: []
  }));
  vi.mocked(api.fetchMcpPresets).mockResolvedValue({ presets: [] });
  vi.mocked(api.fetchSecrets).mockResolvedValue([]);
  vi.mocked(api.fetchProjects).mockResolvedValue({ projects: [] });
  vi.mocked(api.fetchMcpToolsets).mockResolvedValue({
    toolsets: [toolset],
    gatewayBaseUrl: "https://l2m.example.com",
    protocolVersions: ["2025-11-25", "2025-06-18", "2025-03-26"]
  });
  vi.mocked(api.fetchMcpToolsetCandidates).mockResolvedValue({
    workflows: [{ id: "wf_1", name: "Ticket lookup", projectId: null, tools: ["lookup_ticket"] }]
  });
  vi.mocked(api.previewMcpToolset).mockImplementation(async (_id, role) => ({
    toolsetId: "mts_1",
    role,
    projectId: null,
    warnings: [],
    tools: [
      {
        name: "lookup_ticket",
        kind: "workflow",
        description: "Find a ticket",
        inputSchema: { type: "object" },
        workflowId: "wf_1",
        workflowName: "Ticket lookup",
        readOnly: false
      },
      ...(role === "viewer"
        ? []
        : [
            {
              name: "demo_tools__lookup_kb",
              kind: "server" as const,
              description: "Search the KB",
              inputSchema: { type: "object" },
              serverId: "mcp_1",
              serverName: "Demo tools",
              toolName: "lookup_kb",
              readOnly: true
            }
          ])
    ],
    hidden:
      role === "viewer"
        ? [
            {
              name: "demo_tools__lookup_kb",
              serverId: "mcp_1",
              serverName: "Demo tools",
              toolName: "lookup_kb",
              ruleId: "rule_1",
              ruleName: "Viewers: no KB",
              message: "blocked"
            }
          ]
        : []
  }));
  vi.mocked(api.fetchMcpClients).mockResolvedValue({ usageWindow: "7d", clients: [activeClient] });
}

describe("MCP gateway views", () => {
  const writeText = vi.fn(async () => undefined);

  beforeEach(() => {
    vi.resetAllMocks();
    setup();
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists toolsets with their endpoint, copies it, and previews tools per role", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<McpServersPage view="toolsets" isAdmin activeProjectId={null} />);

    expect(await screen.findByTestId("toolset-endpoint")).toHaveTextContent("https://l2m.example.com/mcp/support");
    expect(screen.getByText("lookup_*")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy endpoint URL" }));
    expect(writeText).toHaveBeenCalledWith("https://l2m.example.com/mcp/support");

    const builderList = await screen.findByRole("list", { name: "Tools visible to builder" });
    expect(within(builderList).getByText("demo_tools__lookup_kb")).toBeInTheDocument();
    expect(api.previewMcpToolset).toHaveBeenCalledWith("mts_1", "builder");

    await user.click(screen.getByRole("tab", { name: "viewer" }));
    const hidden = await screen.findByRole("list", { name: "Tools hidden from viewer" });
    expect(within(hidden).getByText("demo_tools__lookup_kb")).toBeInTheDocument();
    expect(within(hidden).getByText("rule Viewers: no KB")).toBeInTheDocument();
    const viewerList = screen.getByRole("list", { name: "Tools visible to viewer" });
    expect(within(viewerList).queryByText("demo_tools__lookup_kb")).not.toBeInTheDocument();
  });

  it("creates a toolset with a workflow and a server glob", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchMcpToolsets).mockResolvedValue({ toolsets: [], gatewayBaseUrl: null, protocolVersions: [] });
    vi.mocked(api.createMcpToolset).mockResolvedValue({ toolset });
    render(<McpServersPage view="toolsets" isAdmin activeProjectId={null} />);
    await user.click(await screen.findByRole("button", { name: "+ New toolset" }));

    const form = screen.getByRole("form", { name: "New toolset" });
    await user.type(within(form).getByLabelText("Name"), "Support tools");
    await user.click(within(form).getByRole("checkbox", { name: /Ticket lookup/ }));
    await user.click(within(form).getByRole("button", { name: "+ Add server" }));
    await user.type(within(form).getByLabelText("Tool glob for server 1"), "lookup_*");
    await user.click(within(form).getByRole("button", { name: "Create toolset" }));

    await waitFor(() =>
      expect(api.createMcpToolset).toHaveBeenCalledWith({
        name: "Support tools",
        description: null,
        projectId: null,
        enabled: true,
        members: [
          { kind: "workflow", workflowId: "wf_1" },
          { kind: "server", serverId: "mcp_1", toolGlob: "lookup_*" }
        ]
      })
    );
    expect(await screen.findByTestId("toolset-endpoint")).toBeInTheDocument();
  });

  it("hides toolset admin actions from builders", async () => {
    const user = userEvent.setup();
    render(<McpServersPage view="toolsets" isAdmin={false} activeProjectId={null} />);
    await screen.findByTestId("toolset-endpoint");
    expect(screen.queryByRole("button", { name: "+ New toolset" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });

  it("creates a client and reveals the token once with config snippets", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const token = "l2m_mcp_abcdefghijkl.secretpart";
    vi.mocked(api.createMcpClient).mockResolvedValue({
      client: { ...activeClient, id: "mcc_2", name: "Laptop agent", activeSessions: 0, usage: { calls: 0, errors: 0, lastCalledAt: null } },
      token
    });
    render(<McpServersPage view="clients" isAdmin activeProjectId={null} />);
    await user.click(await screen.findByRole("button", { name: "+ New client" }));

    const form = screen.getByRole("form", { name: "New MCP client" });
    await user.type(within(form).getByLabelText("Name"), "Laptop agent");
    await user.selectOptions(within(form).getByLabelText("Role"), "builder");
    await user.selectOptions(within(form).getByLabelText("Expires"), "never");
    await user.click(within(form).getByRole("button", { name: "Create client" }));

    await waitFor(() =>
      expect(api.createMcpClient).toHaveBeenCalledWith({ name: "Laptop agent", toolsetIds: ["mts_1"], role: "builder", expiresAt: null })
    );
    const reveal = await screen.findByRole("region", { name: "New client token" });
    expect(within(reveal).getByTestId("client-token")).toHaveTextContent(token);
    expect(within(reveal).getByText("mcpServers JSON")).toBeInTheDocument();
    expect(within(reveal).getByText(".vscode/mcp.json")).toBeInTheDocument();
    expect(within(reveal).getByText("CLI add command")).toBeInTheDocument();
    expect(reveal.textContent).toContain('"url": "https://l2m.example.com/mcp/support"');
    expect(reveal.textContent).toContain(`Bearer ${token}`);

    await user.click(within(reveal).getByRole("button", { name: "Copy .vscode/mcp.json" }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"type": "http"'));

    await user.click(within(reveal).getByRole("button", { name: "I've stored the token" }));
    expect(screen.queryByRole("region", { name: "New client token" })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(token);
    expect(screen.getByText("Laptop agent")).toBeInTheDocument();
  });

  it("revokes a client after confirmation and shows its usage", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(api.revokeMcpClient).mockResolvedValue({
      client: { ...activeClient, status: "revoked", revokedAt: "2026-10-20T12:00:00.000Z", activeSessions: 0 }
    });
    vi.mocked(api.fetchMcpClientUsage).mockImplementation(async (_id, window = "7d") => ({
      clientId: "mcc_1",
      lastUsedAt: null,
      window,
      since: "2026-10-13T10:00:00.000Z",
      totals: { calls: 3, errors: 1, errorRate: 1 / 3, p50Ms: 20, p95Ms: 40, inputTokens: 0, outputTokens: 0, costUsd: null, lastCalledAt: null },
      tools: [{ toolName: "lookup_ticket", adapterId: "workflow", calls: 3, errors: 1, errorRate: 1 / 3, p50Ms: 20, p95Ms: 40, inputTokens: 0, outputTokens: 0, costUsd: null, lastCalledAt: null }]
    }));
    render(<McpServersPage view="clients" isAdmin activeProjectId={null} />);

    const list = await screen.findByRole("list", { name: "MCP clients" });
    expect(within(list).getByText("Active")).toBeInTheDocument();
    expect(within(list).getByText("Support tools")).toBeInTheDocument();

    await user.click(within(list).getByRole("button", { name: "Usage" }));
    expect(await within(list).findByText("lookup_ticket")).toBeInTheDocument();
    expect(api.fetchMcpClientUsage).toHaveBeenCalledWith("mcc_1", "7d");
    await user.click(within(list).getByRole("tab", { name: "30d" }));
    await waitFor(() => expect(api.fetchMcpClientUsage).toHaveBeenCalledWith("mcc_1", "30d"));

    await user.click(within(list).getByRole("button", { name: "Revoke" }));
    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() => expect(api.revokeMcpClient).toHaveBeenCalledWith("mcc_1"));
    expect((await within(list).findAllByText("Revoked"))[0]).toHaveClass("mcp-status-down");
    expect(within(list).queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument();
  });
});
