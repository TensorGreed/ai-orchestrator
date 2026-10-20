import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, vi } from "vitest";
import * as api from "../lib/api";
import { McpServersPage } from "./McpServersPage";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchMcpServers: vi.fn(),
    fetchMcpServer: vi.fn(),
    fetchMcpServerTools: vi.fn(),
    fetchMcpPresets: vi.fn(),
    fetchSecrets: vi.fn(),
    createMcpServer: vi.fn(),
    probeMcpServer: vi.fn(),
    acceptMcpServerChange: vi.fn(),
    deleteMcpServer: vi.fn()
  };
});

function makeServer(overrides: Partial<api.McpRegisteredServer> = {}): api.McpRegisteredServer {
  return {
    id: "mcp_1",
    name: "GitHub tools",
    description: "Issue triage",
    adapterId: "stdio_mcp",
    connection: { command: "npx" },
    secretId: null,
    owner: "ops@example.com",
    projectId: null,
    probeEnabled: true,
    probeIntervalMs: null,
    blockOnBreakingChange: true,
    status: "healthy",
    lastProbeAt: "2026-10-20T10:00:00.000Z",
    lastProbeOk: true,
    lastProbeLatencyMs: 120,
    lastProbeError: null,
    toolCount: 2,
    currentSnapshotId: "snap_2",
    pendingBreakingSnapshotId: null,
    createdBy: "ops@example.com",
    createdAt: "2026-10-19T10:00:00.000Z",
    updatedAt: "2026-10-20T10:00:00.000Z",
    latency: { samples: 3, p50Ms: 110, p95Ms: 340, errorRate: 1 / 3 },
    ...overrides
  };
}

const probes: api.McpServerProbe[] = [
  { id: "p3", serverId: "mcp_1", startedAt: "2026-10-20T10:00:00.000Z", ok: true, latencyMs: 120, toolCount: 2, error: null, snapshotId: "snap_2" },
  { id: "p2", serverId: "mcp_1", startedAt: "2026-10-20T09:55:00.000Z", ok: false, latencyMs: 30000, toolCount: 0, error: "Probe timed out", snapshotId: null },
  { id: "p1", serverId: "mcp_1", startedAt: "2026-10-20T09:50:00.000Z", ok: true, latencyMs: 340, toolCount: 2, error: null, snapshotId: "snap_1" }
];

const breakingSnapshot: api.McpToolSnapshotSummary = {
  id: "snap_2",
  serverId: "mcp_1",
  hash: "b",
  toolCount: 2,
  previousSnapshotId: "snap_1",
  changes: [
    { tool: "search_issues", kind: "property_now_required", path: "repo", breaking: true, detail: "property repo is now required" },
    { tool: "create_issue", kind: "tool_added", breaking: false, detail: "tool create_issue added" }
  ],
  breaking: true,
  acknowledgedAt: null,
  acknowledgedBy: null,
  createdAt: "2026-10-20T10:00:00.000Z"
};

function mockDetail(server: api.McpRegisteredServer) {
  vi.mocked(api.fetchMcpServer).mockResolvedValue({
    server,
    probes,
    snapshots: [breakingSnapshot],
    usages: [{ workflowId: "wf-1", workflowName: "Triage", nodeId: "tool", nodeName: "GitHub", nodeType: "mcp_tool" }]
  });
  vi.mocked(api.fetchMcpServerTools).mockResolvedValue({
    serverId: server.id,
    snapshotId: "snap_2",
    probedAt: server.lastProbeAt,
    tools: [
      {
        name: "search_issues",
        description: "Search issues",
        inputSchema: { type: "object", properties: { query: {}, repo: {} }, required: ["repo"] }
      }
    ]
  });
}

describe("McpServersPage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.fetchMcpPresets).mockResolvedValue({ presets: [] });
    vi.mocked(api.fetchSecrets).mockResolvedValue([]);
  });

  it("lists servers and shows health, latency, tools and usages for the selected one", async () => {
    const server = makeServer();
    vi.mocked(api.fetchMcpServers).mockResolvedValue({
      servers: [server],
      adapters: [{ id: "stdio_mcp", label: "Stdio MCP Server" }],
      defaultProbeIntervalMs: 300000
    });
    mockDetail(server);

    render(<McpServersPage isAdmin={false} />);

    expect(await screen.findByRole("heading", { name: "GitHub tools" })).toBeInTheDocument();
    expect(screen.getByText(/5 min by default/)).toBeInTheDocument();
    expect(screen.getAllByText("Healthy").length).toBeGreaterThan(0);
    expect(screen.getByText("340 ms")).toBeInTheDocument();
    expect(screen.getByText("33%")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Last 3 probes, oldest first" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "search_issues" })).toBeInTheDocument();
    expect(screen.getByText("Triage")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ Register server" })).not.toBeInTheDocument();
  });

  it("switches the probe chart to a table", async () => {
    const user = userEvent.setup();
    const server = makeServer();
    vi.mocked(api.fetchMcpServers).mockResolvedValue({ servers: [server], adapters: [], defaultProbeIntervalMs: 300000 });
    mockDetail(server);

    render(<McpServersPage isAdmin={false} />);
    await user.click(await screen.findByRole("button", { name: "Show table" }));

    expect(screen.getByText("Probe timed out")).toBeInTheDocument();
  });

  it("shows a pending breaking change and lets an admin accept it", async () => {
    const user = userEvent.setup();
    const pending = makeServer({ pendingBreakingSnapshotId: "snap_2" });
    vi.mocked(api.fetchMcpServers)
      .mockResolvedValueOnce({ servers: [pending], adapters: [], defaultProbeIntervalMs: 300000 })
      .mockResolvedValue({ servers: [makeServer()], adapters: [], defaultProbeIntervalMs: 300000 });
    mockDetail(pending);
    vi.mocked(api.acceptMcpServerChange).mockResolvedValue({ server: makeServer() });

    render(<McpServersPage isAdmin />);

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/Runs that use this server are blocked/)).toBeInTheDocument();
    expect(within(alert).getByText("property repo is now required")).toBeInTheDocument();

    await user.click(within(alert).getByRole("button", { name: "Accept change" }));
    await waitFor(() => expect(api.acceptMcpServerChange).toHaveBeenCalledWith("mcp_1"));
  });

  it("registers a server from the form", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchMcpServers).mockResolvedValue({
      servers: [],
      adapters: [
        { id: "http_mcp", label: "HTTP MCP" },
        { id: "mock-mcp", label: "Mock MCP Server" }
      ],
      defaultProbeIntervalMs: 300000
    });
    vi.mocked(api.createMcpServer).mockResolvedValue({ server: makeServer({ id: "mcp_new", name: "Demo" }) });

    render(<McpServersPage isAdmin activeProjectId="proj_1" />);
    await user.click(await screen.findByRole("button", { name: "+ Register server" }));

    const form = screen.getByRole("form", { name: "Register MCP server" });
    await user.type(within(form).getByLabelText("Name"), "Demo");
    await user.selectOptions(within(form).getByLabelText("Adapter"), "mock-mcp");
    await user.click(within(form).getByLabelText(/Block runs/));
    await user.click(within(form).getByRole("button", { name: "Register server" }));

    await waitFor(() =>
      expect(api.createMcpServer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Demo",
          adapterId: "mock-mcp",
          projectId: "proj_1",
          probeIntervalMs: null,
          blockOnBreakingChange: true,
          secretRef: null
        })
      )
    );
  });

  it("rejects connection JSON that is not an object", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchMcpServers).mockResolvedValue({
      servers: [],
      adapters: [{ id: "http_mcp", label: "HTTP MCP" }],
      defaultProbeIntervalMs: 300000
    });

    render(<McpServersPage isAdmin />);
    await user.click(await screen.findByRole("button", { name: "+ Register server" }));
    const form = screen.getByRole("form", { name: "Register MCP server" });
    await user.type(within(form).getByLabelText("Name"), "Broken");
    const connection = within(form).getByLabelText(/Connection/);
    await user.clear(connection);
    await user.type(connection, "[[1]"); // "[[" types a literal "["
    await user.click(within(form).getByRole("button", { name: "Register server" }));

    expect(await within(form).findByText("Connection must be a JSON object.")).toBeInTheDocument();
    expect(api.createMcpServer).not.toHaveBeenCalled();
  });
});
