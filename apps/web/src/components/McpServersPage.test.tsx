import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    updateMcpServer: vi.fn(),
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
    await user.click(within(form).getByLabelText("Other"));
    expect(within(form).getByLabelText("Adapter")).toHaveValue("mock-mcp");
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
    await user.click(within(form).getByText("Advanced: edit as JSON"));
    const connection = within(form).getByLabelText(/Connection \(JSON\)/);
    await user.clear(connection);
    await user.type(connection, "[[1]"); // "[[" types a literal "["
    await user.click(within(form).getByRole("button", { name: "Register server" }));

    expect(await within(form).findByText("Connection must be a JSON object.")).toBeInTheDocument();
    expect(api.createMcpServer).not.toHaveBeenCalled();
  });

  describe("transport choice", () => {
    const formAdapters = [
      { id: "http_mcp", label: "HTTP MCP" },
      { id: "stdio_mcp", label: "Stdio MCP Server" },
      { id: "mock-mcp", label: "Mock MCP Server" }
    ];

    async function openForm(user: ReturnType<typeof userEvent.setup>) {
      vi.mocked(api.fetchMcpServers).mockResolvedValue({ servers: [], adapters: formAdapters, defaultProbeIntervalMs: 300000 });
      render(<McpServersPage isAdmin activeProjectId="proj_1" />);
      await user.click(await screen.findByRole("button", { name: "+ Register server" }));
      return screen.getByRole("form", { name: "Register MCP server" });
    }

    const json = (form: HTMLElement) => (within(form).getByLabelText(/Connection \(JSON\)/) as HTMLTextAreaElement).value;

    it("starts as a remote server and swaps the connection template when switching", async () => {
      const user = userEvent.setup();
      const form = await openForm(user);
      expect(within(form).getByLabelText("Remote server (HTTP)")).toBeChecked();
      expect(within(form).getByLabelText("Endpoint URL")).toHaveValue("http://127.0.0.1:7001/mcp");

      await user.click(within(form).getByLabelText("Local command (stdio)"));
      expect(within(form).queryByLabelText("Endpoint URL")).not.toBeInTheDocument();
      expect(JSON.parse(json(form))).toEqual({ command: "", args: [] });
      expect(within(form).getByText(/runs on the machine running the L2M API/)).toBeInTheDocument();
      expect(within(form).getByRole("group", { name: "Sandbox" })).toBeInTheDocument();

      await user.click(within(form).getByLabelText("Remote server (HTTP)"));
      expect(JSON.parse(json(form))).toEqual({ endpoint: "http://127.0.0.1:7001/mcp", transport: "http_streamable" });
      expect(within(form).queryByRole("group", { name: "Sandbox" })).not.toBeInTheDocument();

      await user.click(within(form).getByLabelText("Other"));
      expect(JSON.parse(json(form))).toEqual({});
    });

    it("registers a stdio server from the fields, keeping spaces inside arguments", async () => {
      const user = userEvent.setup();
      vi.mocked(api.createMcpServer).mockResolvedValue({ server: makeServer({ id: "mcp_new" }) });
      const form = await openForm(user);
      await user.type(within(form).getByLabelText("Name"), "Files");
      await user.click(within(form).getByLabelText("Local command (stdio)"));
      await user.click(within(form).getByRole("button", { name: "Register server" }));
      expect(await within(form).findByRole("alert")).toHaveTextContent("A local command server needs a command.");
      expect(api.createMcpServer).not.toHaveBeenCalled();

      await user.type(within(form).getByLabelText("Command"), "npx");
      await user.click(within(form).getByRole("button", { name: "+ Add argument" }));
      await user.type(within(form).getByLabelText("Argument 1"), "my docs");
      await user.click(within(form).getByRole("button", { name: "+ Add argument" }));
      await user.type(within(form).getByLabelText("Argument 2"), "-y");
      await user.click(within(form).getByRole("button", { name: "Move argument 2 up" }));
      await user.type(within(form).getByLabelText("Working folder (optional)"), "/srv");
      await user.click(within(form).getByRole("button", { name: "+ Add variable" }));
      await user.type(within(form).getByLabelText("Variable 1 name"), "DEBUG");
      await user.type(within(form).getByLabelText("Variable 1 value"), "1");
      expect(JSON.parse(json(form))).toEqual({ command: "npx", args: ["-y", "my docs"], cwd: "/srv", env: { DEBUG: "1" } });

      await user.click(within(form).getByRole("button", { name: "Register server" }));
      await waitFor(() =>
        expect(api.createMcpServer).toHaveBeenCalledWith(
          expect.objectContaining({
            adapterId: "stdio_mcp",
            connection: { command: "npx", args: ["-y", "my docs"], cwd: "/srv", env: { DEBUG: "1" } }
          })
        )
      );
    });

    it("fills the command and arguments from a pasted command line", async () => {
      const user = userEvent.setup();
      const form = await openForm(user);
      await user.click(within(form).getByLabelText("Local command (stdio)"));
      await user.click(within(form).getByLabelText("Paste a command line"));
      await user.paste(`npx -y server "/home/me/my docs"`);
      await user.click(within(form).getByRole("button", { name: "Fill command and arguments" }));
      expect(within(form).getByLabelText("Command")).toHaveValue("npx");
      expect(within(form).getByLabelText("Argument 3")).toHaveValue("/home/me/my docs");
      expect(JSON.parse(json(form)).args).toEqual(["-y", "server", "/home/me/my docs"]);

      await user.click(within(form).getByLabelText("Paste a command line"));
      await user.paste(`node "unclosed`);
      await user.click(within(form).getByRole("button", { name: "Fill command and arguments" }));
      expect(await within(form).findByText(/unclosed double quote/)).toBeInTheDocument();
    });

    it("keeps the fields and the JSON editor in sync both ways and refuses to save invalid JSON", async () => {
      const user = userEvent.setup();
      const form = await openForm(user);
      await user.type(within(form).getByLabelText("Name"), "Sync");
      await user.click(within(form).getByLabelText("Local command (stdio)"));
      await user.click(within(form).getByText("Advanced: edit as JSON"));
      const editor = within(form).getByLabelText(/Connection \(JSON\)/);
      fireEvent.change(editor, { target: { value: '{"command":"node","args":["a b","c"],"env":{"K":"v"}}' } });
      expect(within(form).getByLabelText("Command")).toHaveValue("node");
      expect(within(form).getByLabelText("Argument 1")).toHaveValue("a b");
      expect(within(form).getByLabelText("Variable 1 name")).toHaveValue("K");

      await user.type(within(form).getByLabelText("Command"), "x");
      expect(JSON.parse(json(form)).command).toBe("nodex");

      fireEvent.change(editor, { target: { value: '{"command":' } });
      expect(await within(form).findByText(/will not save until this is fixed/)).toBeInTheDocument();
      expect(within(form).queryByLabelText("Command")).not.toBeInTheDocument();
      await user.click(within(form).getByRole("button", { name: "Register server" }));
      expect(api.createMcpServer).not.toHaveBeenCalled();
    });

    it("opens an existing stdio server on the local command option with its fields", async () => {
      const user = userEvent.setup();
      const server = makeServer({
        connection: { command: "uvx", args: ["srv", "two words"], cwd: "/opt/x", env: { A: "b" }, secretEnvVar: "TOKEN" }
      });
      vi.mocked(api.fetchMcpServers).mockResolvedValue({ servers: [server], adapters: formAdapters, defaultProbeIntervalMs: 300000 });
      mockDetail(server);
      vi.mocked(api.updateMcpServer).mockResolvedValue({ server });
      render(<McpServersPage isAdmin />);
      await user.click(await screen.findByRole("button", { name: /GitHub tools/ }));
      await user.click(await screen.findByRole("button", { name: "Edit" }));
      const form = await screen.findByRole("form", { name: "Edit MCP server" });
      expect(within(form).getByLabelText("Local command (stdio)")).toBeChecked();
      expect(within(form).getByLabelText("Command")).toHaveValue("uvx");
      expect(within(form).getByLabelText("Argument 2")).toHaveValue("two words");
      expect(within(form).getByLabelText("Working folder (optional)")).toHaveValue("/opt/x");
      expect(within(form).getByLabelText("Variable 1 value")).toHaveValue("b");

      await user.click(within(form).getByRole("button", { name: "Remove argument 1" }));
      await user.click(within(form).getByRole("button", { name: "Save changes" }));
      await waitFor(() =>
        expect(api.updateMcpServer).toHaveBeenCalledWith(
          "mcp_1",
          expect.objectContaining({
            adapterId: "stdio_mcp",
            connection: { command: "uvx", args: ["two words"], cwd: "/opt/x", env: { A: "b" }, secretEnvVar: "TOKEN" }
          })
        )
      );
    });

    async function openEdit(user: ReturnType<typeof userEvent.setup>, connection: Record<string, unknown>) {
      const server = makeServer({ connection });
      vi.mocked(api.fetchMcpServers).mockResolvedValue({ servers: [server], adapters: formAdapters, defaultProbeIntervalMs: 300000 });
      mockDetail(server);
      vi.mocked(api.updateMcpServer).mockResolvedValue({ server });
      render(<McpServersPage isAdmin />);
      await user.click(await screen.findByRole("button", { name: /GitHub tools/ }));
      await user.click(await screen.findByRole("button", { name: "Edit" }));
      return screen.findByRole("form", { name: "Edit MCP server" });
    }
    const savedConnection = () => (vi.mocked(api.updateMcpServer).mock.calls[0]?.[1] as { connection: unknown }).connection;

    it("keeps an empty-string argument through load, edit and save", async () => {
      const user = userEvent.setup();
      const form = await openEdit(user, { command: "x", args: ["a", "", "b"] });
      expect(within(form).getByLabelText("Argument 2")).toHaveValue("");
      expect(within(form).getByLabelText("Argument 2 is an empty argument")).toBeChecked();
      await user.type(within(form).getByLabelText("Working folder (optional)"), "/srv");
      await user.click(within(form).getByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(api.updateMcpServer).toHaveBeenCalled());
      expect(savedConnection()).toEqual({ command: "x", args: ["a", "", "b"], cwd: "/srv" });
    });

    it("keeps a pasted empty argument, and drops an added blank row unless it is marked empty", async () => {
      const user = userEvent.setup();
      const form = await openForm(user);
      await user.click(within(form).getByLabelText("Local command (stdio)"));
      await user.click(within(form).getByLabelText("Paste a command line"));
      await user.paste('cmd ""');
      await user.click(within(form).getByRole("button", { name: "Fill command and arguments" }));
      expect(JSON.parse(json(form))).toEqual({ command: "cmd", args: [""] });

      await user.click(within(form).getByRole("button", { name: "+ Add argument" }));
      expect(JSON.parse(json(form)).args).toEqual([""]);
      await user.click(within(form).getByLabelText("Argument 2 is an empty argument"));
      expect(JSON.parse(json(form)).args).toEqual(["", ""]);
      await user.click(within(form).getByLabelText("Argument 2 is an empty argument"));
      expect(JSON.parse(json(form)).args).toEqual([""]);
    });

    it("restores the saved connection after switching transport and back", async () => {
      const user = userEvent.setup();
      const original = { command: "uvx", args: ["srv", ""], env: { A: "b" }, secretEnvVar: "TOKEN", timeoutMs: 5000 };
      const form = await openEdit(user, original);
      await user.click(within(form).getByLabelText("Remote server (HTTP)"));
      expect(within(form).getByLabelText("Endpoint URL")).toBeInTheDocument();
      await user.click(within(form).getByLabelText("Local command (stdio)"));
      expect(within(form).getByLabelText("Command")).toHaveValue("uvx");
      await user.click(within(form).getByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(api.updateMcpServer).toHaveBeenCalled());
      expect(savedConnection()).toEqual(original);
    });

    it("shows non-string args and env read-only and saves them unchanged", async () => {
      const user = userEvent.setup();
      const original = { command: "x", args: ["a", 1, { k: 2 }], env: { N: 3 } };
      const form = await openEdit(user, original);
      expect(within(form).getByText(/values the form can't edit; use Advanced: edit as JSON/)).toBeInTheDocument();
      expect(within(form).getByLabelText("Argument 2")).toHaveAttribute("readonly");
      expect(within(form).getByLabelText("Argument 2")).toHaveValue("1");
      expect(within(form).queryByRole("button", { name: "+ Add argument" })).not.toBeInTheDocument();
      await user.type(within(form).getByLabelText("Command"), "y");
      await user.click(within(form).getByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(api.updateMcpServer).toHaveBeenCalled());
      expect(savedConnection()).toEqual({ ...original, command: "xy" });
    });

    it("marks the empty command invalid, links its error, focuses it and shows an alert by the Save button", async () => {
      const user = userEvent.setup();
      const form = await openForm(user);
      await user.type(within(form).getByLabelText("Name"), "Files");
      await user.click(within(form).getByLabelText("Local command (stdio)"));
      await user.click(within(form).getByRole("button", { name: "Register server" }));
      const command = within(form).getByLabelText("Command");
      await waitFor(() => expect(command).toHaveFocus());
      expect(command).toHaveAttribute("aria-invalid", "true");
      const describedBy = (command.getAttribute("aria-describedby") ?? "").split(" ");
      expect(describedBy.map((id) => document.getElementById(id)?.textContent).join(" ")).toMatch(/needs a command/);
      const alert = within(form).getByRole("alert");
      expect(alert.compareDocumentPosition(within(form).getByRole("button", { name: "Register server" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      await user.type(command, "npx");
      expect(command).not.toHaveAttribute("aria-invalid");
    });

    it("marks an empty endpoint invalid and focuses it", async () => {
      const user = userEvent.setup();
      const form = await openForm(user);
      await user.type(within(form).getByLabelText("Name"), "Remote");
      await user.clear(within(form).getByLabelText("Endpoint URL"));
      await user.click(within(form).getByRole("button", { name: "Register server" }));
      const endpoint = within(form).getByLabelText("Endpoint URL");
      await waitFor(() => expect(endpoint).toHaveFocus());
      expect(endpoint).toHaveAttribute("aria-invalid", "true");
      expect(api.createMcpServer).not.toHaveBeenCalled();
    });

    it("offers the secret's variable name once an Auth secret is chosen and flags duplicate variables", async () => {
      const user = userEvent.setup();
      vi.mocked(api.fetchSecrets).mockResolvedValue([{ id: "sec_1", name: "Token" } as unknown as api.SecretListItem]);
      const form = await openForm(user);
      await user.click(within(form).getByLabelText("Local command (stdio)"));
      expect(within(form).queryByLabelText(/Environment variable for the secret/)).not.toBeInTheDocument();
      await user.selectOptions(await within(form).findByLabelText("Auth secret"), "sec_1");
      await user.type(within(form).getByLabelText(/Environment variable for the secret/), "API_TOKEN");
      expect(JSON.parse(json(form)).secretEnvVar).toBe("API_TOKEN");

      await user.click(within(form).getByRole("button", { name: "+ Add variable" }));
      await user.type(within(form).getByLabelText("Variable 1 name"), "A");
      await user.click(within(form).getByRole("button", { name: "+ Add variable" }));
      await user.type(within(form).getByLabelText("Variable 2 name"), "A");
      expect(within(form).getByLabelText("Variable 2 name")).toHaveAttribute("aria-invalid", "true");
      expect(within(form).getAllByText(/is used more than once/)).toHaveLength(2);
    });

    it("has a single Server type label", async () => {
      const user = userEvent.setup();
      const form = await openForm(user);
      expect(within(form).getAllByText("Server type")).toHaveLength(1);
      expect(within(form).getByRole("group", { name: "Server type" })).toBeInTheDocument();
      expect(within(form).queryByRole("radiogroup")).not.toBeInTheDocument();
    });

    it("applies a preset's transport", async () => {
      const user = userEvent.setup();
      vi.mocked(api.fetchMcpPresets).mockResolvedValue({
        presets: [
          {
            id: "fs",
            name: "Filesystem",
            description: "Files",
            category: "Files",
            serverAdapter: "stdio_mcp",
            connection: { command: "npx", args: ["-y", "fs"] }
          } as unknown as api.McpPreset
        ]
      });
      const form = await openForm(user);
      await user.selectOptions(await within(form).findByLabelText("Start from a preset"), "fs");
      expect(within(form).getByLabelText("Local command (stdio)")).toBeChecked();
      expect(within(form).getByLabelText("Command")).toHaveValue("npx");
      expect(within(form).getByLabelText("Argument 2")).toHaveValue("fs");
    });
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

    const { unmount } = render(<McpServersPage isAdmin={false} canBuild />);
    expect(await screen.findByRole("region", { name: "MCP catalog" })).toHaveTextContent("is not pinned");
    expect(screen.getByText("Enforced for stdio servers")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reload" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Import config" }));
    expect(screen.getByRole("dialog", { name: "Import MCP client config" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close import dialog" }));

    unmount();
    render(<McpServersPage view="playground" isAdmin={false} canBuild />);
    expect(await screen.findByRole("heading", { name: "MCP playground" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "MCP playground" })).toBeInTheDocument();
  });

  it("hides import and the playground from viewers", async () => {
    vi.mocked(api.fetchMcpServers).mockResolvedValue({ servers: [], adapters: [], defaultProbeIntervalMs: 300000 });
    render(<McpServersPage isAdmin={false} canBuild={false} />);
    expect(await screen.findByText(/No servers registered yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Import config" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "MCP playground" })).not.toBeInTheDocument();
  });

  it("keeps the playground closed to viewers when they open its page", async () => {
    vi.mocked(api.fetchMcpServers).mockResolvedValue({ servers: [], adapters: [], defaultProbeIntervalMs: 300000 });
    render(<McpServersPage view="playground" isAdmin={false} canBuild={false} />);
    expect(await screen.findByRole("heading", { name: "MCP playground" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "MCP playground" })).not.toBeInTheDocument();
  });

  it("selects the focused server when opened from another page", async () => {
    vi.mocked(api.fetchMcpServers).mockResolvedValue({
      servers: [makeServer(), makeServer({ id: "mcp_2", name: "Search tools" })],
      adapters: [],
      defaultProbeIntervalMs: 300000
    });
    render(<McpServersPage isAdmin={false} focusServerId="mcp_2" />);
    await waitFor(() => expect(api.fetchMcpServer).toHaveBeenCalledWith("mcp_2"));
    expect(screen.getByRole("button", { name: /Search tools/ })).toHaveClass("active");
  });
});
