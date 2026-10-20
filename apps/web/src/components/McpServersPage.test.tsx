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
    fetchMcpServerTelemetry: vi.fn(),
    fetchMcpPresets: vi.fn(),
    fetchMcpCatalog: vi.fn(),
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

function emptyTotals(): api.McpTelemetryTotals {
  return { calls: 0, errors: 0, errorRate: 0, p50Ms: null, p95Ms: null, inputTokens: 0, outputTokens: 0, costUsd: null, lastCalledAt: null };
}

function emptyTelemetry(window: api.McpTelemetryWindow): api.McpTelemetryResponse & { serverId: string } {
  return { serverId: "mcp_1", window, since: "2026-10-13T10:00:00.000Z", totals: emptyTotals(), tools: [] };
}

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
    vi.mocked(api.fetchMcpCatalog).mockResolvedValue({
      status: {
        configured: false,
        fileName: null,
        mode: "merge",
        enforce: false,
        state: "off",
        loadedAt: null,
        entryCount: 0,
        approvedCount: 0,
        errors: []
      },
      entries: []
    });
    vi.mocked(api.fetchSecrets).mockResolvedValue([]);
    vi.mocked(api.fetchMcpServerTelemetry).mockImplementation(async (_id, window = "7d") => emptyTelemetry(window));
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
    expect(screen.getByRole("cell", { name: /search_issues/ })).toBeInTheDocument();
    expect(screen.getByText("Triage")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ Register server" })).not.toBeInTheDocument();
  });

  it("shows per-tool call telemetry in the tools table and switches the window", async () => {
    const user = userEvent.setup();
    const server = makeServer();
    vi.mocked(api.fetchMcpServers).mockResolvedValue({ servers: [server], adapters: [], defaultProbeIntervalMs: 300000 });
    mockDetail(server);
    vi.mocked(api.fetchMcpServerTools).mockResolvedValue({
      serverId: server.id,
      snapshotId: "snap_2",
      probedAt: server.lastProbeAt,
      tools: [
        { name: "create_issue", description: "Create an issue", inputSchema: { type: "object", properties: {} } },
        { name: "search_issues", description: "Search issues", inputSchema: { type: "object", properties: {} } }
      ]
    });
    vi.mocked(api.fetchMcpServerTelemetry).mockImplementation(async (_id, window = "7d") => {
      if (window === "30d") {
        return {
          ...emptyTelemetry(window),
          totals: { ...emptyTotals(), calls: 900, errors: 0 },
          tools: [{ ...emptyTotals(), toolName: "create_issue", calls: 900, p50Ms: 75, p95Ms: 2400, inputTokens: 1200, outputTokens: 300, costUsd: 1.5 }]
        };
      }
      return {
        ...emptyTelemetry(window),
        totals: { ...emptyTotals(), calls: 12, errors: 3, costUsd: 0.0042 },
        tools: [
          {
            toolName: "search_issues",
            calls: 12,
            errors: 3,
            errorRate: 0.25,
            p50Ms: 140,
            p95Ms: 880,
            inputTokens: 900,
            outputTokens: 150,
            costUsd: 0.0042,
            lastCalledAt: "2026-10-20T09:00:00.000Z"
          }
        ]
      };
    });

    render(<McpServersPage isAdmin={false} />);

    const table = (await screen.findByRole("columnheader", { name: "Calls" })).closest("table") as HTMLTableElement;
    for (const header of ["p50", "p95", "Errors", "Tokens", "Cost"]) {
      expect(within(table).getByRole("columnheader", { name: header })).toBeInTheDocument();
    }
    await waitFor(() => expect(within(table).getByText("12")).toBeInTheDocument());
    expect(api.fetchMcpServerTelemetry).toHaveBeenCalledWith("mcp_1", "7d");

    const rows = within(table).getAllByRole("row").slice(1);
    // Busiest first: search_issues has calls, create_issue has none.
    expect(within(rows[0]).getByText("search_issues")).toBeInTheDocument();
    expect(within(rows[0]).getByText("140 ms")).toBeInTheDocument();
    expect(within(rows[0]).getByText("880 ms")).toBeInTheDocument();
    expect(within(rows[0]).getByText(/3 · 25%/)).toBeInTheDocument();
    expect(within(rows[0]).getByText("1.1k")).toBeInTheDocument();
    expect(within(rows[0]).getByText("$0.0042")).toBeInTheDocument();
    expect(within(rows[1]).getByText("create_issue")).toBeInTheDocument();
    expect(within(rows[1]).getAllByText("—")).toHaveLength(7);
    expect(screen.getByText(/12 calls in the last 7 days · 3 failed/)).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Telemetry window"), "30d");
    await waitFor(() => expect(api.fetchMcpServerTelemetry).toHaveBeenLastCalledWith("mcp_1", "30d"));
    await waitFor(() => expect(within(table).getByText("900")).toBeInTheDocument());
    const after = within(table).getAllByRole("row").slice(1);
    expect(within(after[0]).getByText("create_issue")).toBeInTheDocument();
    expect(within(after[0]).getByText("2.4 s")).toBeInTheDocument();
    expect(within(after[0]).getByText("$1.50")).toBeInTheDocument();
    expect(within(after[1]).getAllByText("—")).toHaveLength(7);
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

  it("offers config import and the playground to builders, and shows catalog errors", async () => {
    const user = userEvent.setup();
    const server = makeServer();
    vi.mocked(api.fetchMcpServers).mockResolvedValue({ servers: [server], adapters: [], defaultProbeIntervalMs: 300000 });
    mockDetail(server);
    vi.mocked(api.fetchMcpCatalog).mockResolvedValue({
      status: {
        configured: true,
        fileName: "catalog.json",
        mode: "exclusive",
        enforce: true,
        state: "partial",
        loadedAt: "2026-10-20T10:00:00.000Z",
        entryCount: 2,
        approvedCount: 1,
        errors: [{ index: 2, entryId: "fs", path: "connection.args", message: "'fs' is not pinned to an exact version" }]
      },
      entries: []
    });

    render(<McpServersPage isAdmin={false} canBuild />);
    expect(await screen.findByRole("region", { name: "MCP catalog" })).toHaveTextContent("is not pinned");
    expect(screen.getByText("Enforced for stdio servers")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reload" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Import config" }));
    expect(screen.getByRole("dialog", { name: "Import MCP client config" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close import dialog" }));

    await user.click(screen.getByRole("tab", { name: "Playground" }));
    expect(await screen.findByRole("region", { name: "MCP playground" })).toBeInTheDocument();
  });

  it("hides import and the playground from viewers", async () => {
    vi.mocked(api.fetchMcpServers).mockResolvedValue({ servers: [], adapters: [], defaultProbeIntervalMs: 300000 });
    render(<McpServersPage isAdmin={false} canBuild={false} />);
    expect(await screen.findByText(/No servers registered yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Import config" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Playground" })).not.toBeInTheDocument();
  });
});
