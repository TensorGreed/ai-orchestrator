import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, vi } from "vitest";
import * as api from "../lib/api";
import { McpChangesPage } from "./McpChangesPage";
import { McpOverviewPage } from "./McpOverviewPage";
import { McpToolsPage } from "./McpToolsPage";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchMcpOverview: vi.fn(),
    fetchMcpToolCatalog: vi.fn(),
    fetchMcpChanges: vi.fn(),
    fetchMcpServers: vi.fn(),
    fetchProjects: vi.fn(),
    evaluateMcpToolPolicy: vi.fn()
  };
});

function emptyOverview(): api.McpOverview {
  return {
    window: "7d",
    since: "2026-10-14T00:00:00.000Z",
    servers: { total: 0, byStatus: { healthy: 0, degraded: 0, down: 0, unknown: 0 }, list: [] },
    pendingBreaking: [],
    oauthAttention: [],
    elicitations: { pending: 0, oldestAt: null },
    sampling: [],
    tools: { calls: 0, errors: 0, busiest: [], errorProne: [] },
    clients: { total: 0, active: 0, top: [] },
    changes: []
  };
}

const latency = { samples: 3, p50Ms: 20, p95Ms: 80, errorRate: 0 };

function busyOverview(): api.McpOverview {
  return {
    ...emptyOverview(),
    servers: {
      total: 3,
      byStatus: { healthy: 1, degraded: 0, down: 1, unknown: 1 },
      list: [
        { id: "mcp_a", name: "GitHub tools", status: "healthy", lastProbeAt: "2026-10-20T10:00:00.000Z", latency },
        { id: "mcp_b", name: "Offline", status: "down", lastProbeAt: "2026-10-20T10:00:00.000Z", latency },
        { id: "mcp_c", name: "New", status: "unknown", lastProbeAt: null, latency }
      ]
    },
    pendingBreaking: [
      { serverId: "mcp_a", serverName: "GitHub tools", snapshotId: "snap", detectedAt: "2026-10-20T10:00:00.000Z", breakingChanges: 2, blocksRuns: true }
    ],
    oauthAttention: [{ serverId: "mcp_c", serverName: "New", state: "expired", expiresAt: null }],
    elicitations: { pending: 2, oldestAt: "2026-10-20T09:00:00.000Z" },
    sampling: [{ serverId: "mcp_a", serverName: "GitHub tools", maxTokens: 1024, maxRequestsPerCall: 3, allowedModels: 1 }],
    tools: {
      calls: 40,
      errors: 4,
      busiest: [
        { serverId: "mcp_a", serverName: "GitHub tools", toolName: "search_issues", calls: 30, errors: 1, errorRate: 1 / 30, p95Ms: 120, costUsd: 0.12 },
        { serverId: "mcp_a", serverName: "GitHub tools", toolName: "create_issue", calls: 10, errors: 3, errorRate: 0.3, p95Ms: 300, costUsd: null }
      ],
      errorProne: [
        { serverId: "mcp_a", serverName: "GitHub tools", toolName: "create_issue", calls: 10, errors: 3, errorRate: 0.3, p95Ms: 300, costUsd: null }
      ]
    },
    clients: { total: 2, active: 1, top: [{ id: "c1", name: "IDE", calls: 12, errors: 0, lastCalledAt: "2026-10-20T10:00:00.000Z" }] },
    changes: [
      {
        id: "snapshot:snap",
        at: "2026-10-20T10:00:00.000Z",
        kind: "schema",
        severity: "breaking",
        serverId: "mcp_a",
        serverName: "GitHub tools",
        title: "Breaking schema change on GitHub tools: 2 breaking of 3",
        detail: "Waiting for review",
        link: { page: "servers", serverId: "mcp_a" }
      }
    ]
  };
}

function tool(overrides: Partial<api.McpCatalogTool> = {}): api.McpCatalogTool {
  return {
    serverId: "mcp_a",
    serverName: "GitHub tools",
    serverStatus: "healthy",
    adapterId: "http_mcp",
    name: "search_issues",
    description: "Find issues",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    annotations: { readOnlyHint: true },
    classification: { readOnly: true, source: "annotation" },
    manualReadOnly: null,
    access: { allowed: true },
    telemetry: {
      toolName: "search_issues",
      calls: 30,
      errors: 1,
      errorRate: 1 / 30,
      p50Ms: 40,
      p95Ms: 120,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0.12,
      samplingRequests: 0,
      samplingInputTokens: 0,
      samplingOutputTokens: 0,
      lastCalledAt: "2026-10-20T10:00:00.000Z"
    },
    recentCalls: [
      { startedAt: "2026-10-20T10:00:00.000Z", ok: false, durationMs: 50, source: "workflow", workflowId: "wf-1", error: "rate limited" }
    ],
    usages: [{ workflowId: "wf-1", workflowName: "Triage", nodeId: "n1", nodeName: "Search", nodeType: "mcp_tool", allTools: false }],
    ...overrides
  };
}

function catalog(): api.McpToolCatalogResponse {
  return {
    window: "7d",
    since: "2026-10-14T00:00:00.000Z",
    policy: { role: "builder", projectId: "default" },
    servers: [
      { id: "mcp_a", name: "GitHub tools", status: "healthy", adapterId: "http_mcp", projectId: null, lastProbeAt: null, pendingBreakingSnapshotId: null, toolCount: 2, policyProjectId: "default" },
      { id: "mcp_b", name: "Files", status: "down", adapterId: "stdio_mcp", projectId: null, lastProbeAt: null, pendingBreakingSnapshotId: null, toolCount: 1, policyProjectId: "default" }
    ],
    tools: [
      tool(),
      tool({
        name: "delete_repo",
        description: "Deletes a repository",
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
        classification: { readOnly: false, source: "annotation" },
        access: { allowed: false, ruleId: "rule_1", ruleName: "No deletes", message: "Denied by rule No deletes" },
        outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
        telemetry: null,
        recentCalls: [],
        usages: []
      }),
      tool({
        serverId: "mcp_b",
        serverName: "Files",
        serverStatus: "down",
        name: "read_file",
        annotations: undefined,
        classification: { readOnly: false, source: "unknown" },
        telemetry: {
          ...tool().telemetry!,
          toolName: "read_file",
          calls: 90,
          errors: 0,
          errorRate: 0,
          p95Ms: 20,
          costUsd: null
        },
        usages: []
      })
    ]
  };
}

beforeEach(() => {
  vi.mocked(api.fetchProjects).mockResolvedValue({ projects: [] });
});

describe("McpOverviewPage", () => {
  it("invites registering a server when the fleet is empty", async () => {
    vi.mocked(api.fetchMcpOverview).mockResolvedValue(emptyOverview());
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    render(<McpOverviewPage onNavigate={onNavigate} />);
    expect(await screen.findByText("No MCP servers registered yet.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Go to servers" }));
    expect(onNavigate).toHaveBeenCalledWith({ page: "servers" });
  });

  it("shows fleet health with labels, attention items, tools, clients and changes", async () => {
    vi.mocked(api.fetchMcpOverview).mockResolvedValue(busyOverview());
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    render(<McpOverviewPage onNavigate={onNavigate} />);

    const bar = await screen.findByRole("list", { name: "3 servers by status" });
    const segments = within(bar).getAllByRole("listitem");
    expect(segments.map((segment) => segment.getAttribute("aria-label"))).toEqual([
      "Down: 1 of 3 servers",
      "Healthy: 1 of 3 servers",
      "Not probed: 1 of 3 servers"
    ]);
    const legend = screen.getByRole("list", { name: "Status counts" });
    expect(within(legend).getByText("Degraded")).toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: "Show table" })[0]);
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("Offline");

    expect(screen.getByRole("button", { name: "Review the breaking change on GitHub tools" })).toBeInTheDocument();
    expect(screen.getByText(/runs blocked until accepted/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New: Token expired" })).toBeInTheDocument();
    expect(screen.getByText(/2 open questions from MCP servers/)).toBeInTheDocument();
    expect(screen.getByText(/up to 1,024 tokens/)).toBeInTheDocument();
    expect(screen.getByText("IDE")).toBeInTheDocument();

    const busiest = screen.getByRole("region", { name: "Busiest tools" });
    const row = within(busiest).getByRole("button", { name: "search_issues on GitHub tools: 30 calls" });
    expect(row).toHaveAttribute("title", "search_issues on GitHub tools: 30 calls");
    await user.click(row);
    expect(onNavigate).toHaveBeenLastCalledWith({ page: "tools", serverId: "mcp_a", toolName: "search_issues" });

    const errorProne = screen.getByRole("region", { name: "Most error-prone tools" });
    expect(within(errorProne).getByText("30% · 3 of 10 failed")).toBeInTheDocument();

    const changes = screen.getByRole("region", { name: "Latest changes" });
    expect(within(changes).getByText("Breaking")).toBeInTheDocument();
    await user.click(within(changes).getByRole("button", { name: /Breaking schema change/ }));
    expect(onNavigate).toHaveBeenLastCalledWith({ page: "servers", serverId: "mcp_a" });

    await user.click(screen.getByRole("button", { name: "24h" }));
    await waitFor(() => expect(api.fetchMcpOverview).toHaveBeenLastCalledWith("24h"));
  });
});

describe("McpToolsPage", () => {
  beforeEach(() => {
    vi.mocked(api.fetchMcpToolCatalog).mockResolvedValue(catalog());
  });

  function rowNames() {
    const table = screen.getByRole("table");
    return within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) => within(row).getAllByRole("cell")[0].querySelector("button")?.textContent);
  }

  it("filters the catalogue and sorts by telemetry columns", async () => {
    const user = userEvent.setup();
    render(<McpToolsPage activeProjectId="default" onNavigate={vi.fn()} />);
    await screen.findByRole("button", { name: "search_issues" });
    expect(api.fetchMcpToolCatalog).toHaveBeenCalledWith({ projectId: "default", window: "7d" });
    // Default: busiest first, tools without calls last.
    expect(rowNames()).toEqual(["read_file", "search_issues", "delete_repo"]);
    expect(screen.getByText("3 of 3 tools · telemetry for the last 7d")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^p95/ }));
    expect(screen.getByRole("columnheader", { name: /p95/ })).toHaveAttribute("aria-sort", "descending");
    expect(rowNames()).toEqual(["search_issues", "read_file", "delete_repo"]);
    await user.click(screen.getByRole("button", { name: /^Tool/ }));
    expect(rowNames()).toEqual(["delete_repo", "read_file", "search_issues"]);

    await user.click(screen.getByRole("button", { name: "Blocked for my role" }));
    expect(rowNames()).toEqual(["delete_repo"]);
    expect(screen.getByRole("button", { name: "Blocked for my role" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Clear 1 filter" }));

    await user.click(screen.getByRole("button", { name: "Destructive" }));
    await user.click(screen.getByRole("button", { name: "Open world" }));
    await user.click(screen.getByRole("button", { name: "Has output schema" }));
    expect(rowNames()).toEqual(["delete_repo"]);
    await user.click(screen.getByRole("button", { name: "Clear 3 filters" }));

    await user.selectOptions(screen.getByRole("combobox", { name: "Read-only or write" }), "read");
    expect(rowNames()).toEqual(["search_issues"]);
    await user.selectOptions(screen.getByRole("combobox", { name: "Read-only or write" }), "any");

    await user.selectOptions(screen.getByRole("combobox", { name: "Server" }), "mcp_b");
    expect(rowNames()).toEqual(["read_file"]);
    await user.selectOptions(screen.getByRole("combobox", { name: "Server" }), "");

    await user.selectOptions(screen.getByRole("combobox", { name: "Server status" }), "down");
    expect(rowNames()).toEqual(["read_file"]);
    await user.selectOptions(screen.getByRole("combobox", { name: "Server status" }), "any");

    await user.type(screen.getByRole("searchbox", { name: "Search tools" }), "repository");
    expect(rowNames()).toEqual(["delete_repo"]);
    await user.clear(screen.getByRole("searchbox", { name: "Search tools" }));
    await user.type(screen.getByRole("searchbox", { name: "Search tools" }), "nothing-matches");
    expect(screen.getByText("No tool matches these filters.")).toBeInTheDocument();
  });

  it("opens a detail drawer with schemas, annotations, policy decision, recent calls and usages", async () => {
    vi.mocked(api.evaluateMcpToolPolicy).mockImplementation(async (payload) => ({
      allowed: payload.role !== "builder",
      reason: payload.role === "builder" ? "policy" : null,
      ruleId: payload.role === "builder" ? "rule_1" : null,
      ruleName: payload.role === "builder" ? "No deletes" : null,
      message: payload.role === "builder" ? "Denied by rule No deletes" : null,
      decidedBy: payload.role === "builder" ? "rule" : "default",
      decidingRuleId: payload.role === "builder" ? "rule_1" : null,
      matchedRules: [],
      overriddenDenies: [],
      classification: { readOnly: false, source: "annotation" },
      manualReadOnly: null,
      server: { kind: "registry", id: "mcp_a", name: "GitHub tools", adapterId: "http_mcp" }
    }));
    const onNavigate = vi.fn();
    const onOpenWorkflow = vi.fn();
    const user = userEvent.setup();
    render(<McpToolsPage activeProjectId="default" onNavigate={onNavigate} onOpenWorkflow={onOpenWorkflow} />);

    const opener = await screen.findByRole("button", { name: "delete_repo" });
    await user.click(opener);
    const drawer = screen.getByRole("dialog", { name: "delete_repo" });
    expect(within(drawer).getByText("Destructive", { selector: ".mcp-hint" })).toBeInTheDocument();
    expect(within(drawer).getByText("Open world")).toBeInTheDocument();
    expect(within(drawer).getByRole("region", { name: "Output schema" })).toHaveTextContent("ok");
    expect(within(drawer).getByRole("region", { name: "Input schema" })).toHaveTextContent('"query"');
    await waitFor(() =>
      expect(api.evaluateMcpToolPolicy).toHaveBeenCalledWith({ role: "builder", projectId: "default", serverId: "mcp_a", toolName: "delete_repo" })
    );
    // The block is stated once in plain words, with the rule's name, not the raw policy message.
    expect(within(drawer).getByText(/^Blocked for you by rule “No deletes”\./)).toBeInTheDocument();
    const decision = within(drawer).getByRole("region", { name: "Policy decision" });
    expect(await within(decision).findByText("Blocked")).toBeInTheDocument();
    expect(decision).toHaveTextContent("Denied by rule “No deletes”.");
    expect(drawer).not.toHaveTextContent("Denied by rule No deletes");
    await user.selectOptions(within(decision).getByRole("combobox", { name: "Role" }), "admin");
    expect(await within(decision).findByText("Allowed")).toBeInTheDocument();
    expect(within(decision).getByText(/allowed by default/)).toBeInTheDocument();
    await user.selectOptions(within(decision).getByRole("combobox", { name: "Role" }), "builder");
    await user.click(await within(decision).findByRole("button", { name: "Open rule" }));
    expect(onNavigate).toHaveBeenLastCalledWith({ page: "policies", policyId: "rule_1" });

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "search_issues" }));
    const second = screen.getByRole("dialog", { name: "search_issues" });
    const recent = within(second).getByRole("region", { name: "Recent calls" });
    expect(within(recent).getByText("failed")).toBeInTheDocument();
    expect(within(recent).getByText("rate limited")).toBeInTheDocument();
    await user.click(within(second).getByRole("button", { name: "Triage" }));
    expect(onOpenWorkflow).toHaveBeenCalledWith("wf-1");
    await user.click(within(second).getByRole("button", { name: "Close tool details" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens the focused tool's drawer on arrival", async () => {
    vi.mocked(api.evaluateMcpToolPolicy).mockResolvedValue({
      allowed: true,
      reason: null,
      ruleId: null,
      ruleName: null,
      message: null,
      decidedBy: "default",
      decidingRuleId: null,
      matchedRules: [],
      overriddenDenies: [],
      classification: { readOnly: true, source: "annotation" },
      manualReadOnly: null,
      server: { kind: "registry", id: "mcp_b", name: "Files", adapterId: "stdio_mcp" }
    });
    render(<McpToolsPage focus={{ serverId: "mcp_b", toolName: "read_file" }} onNavigate={vi.fn()} />);
    expect(await screen.findByRole("dialog", { name: "read_file" })).toBeInTheDocument();
  });
});

describe("McpChangesPage", () => {
  const items: api.McpChangeItem[] = [
    {
      id: "snapshot:s2",
      at: "2026-10-20T10:00:00.000Z",
      kind: "schema",
      severity: "breaking",
      serverId: "mcp_a",
      serverName: "GitHub tools",
      title: "Breaking schema change on GitHub tools: 1 breaking of 2",
      detail: "Waiting for review",
      link: { page: "servers", serverId: "mcp_a" },
      changes: [
        { tool: "search_issues", kind: "property_now_required", breaking: true, detail: "property repo is now required" },
        { tool: "create_issue", kind: "tool_added", breaking: false, detail: "tool create_issue added" }
      ]
    },
    {
      id: "status:p1",
      at: "2026-10-20T09:00:00.000Z",
      kind: "status",
      severity: "warning",
      serverId: "mcp_b",
      serverName: "Files",
      title: "Files: Healthy → Down",
      detail: "connect ECONNREFUSED",
      link: { page: "servers", serverId: "mcp_b" },
      transition: { from: "healthy", to: "down" }
    },
    {
      id: "audit:a1",
      at: "2026-10-19T09:00:00.000Z",
      kind: "policy",
      severity: "change",
      serverId: null,
      serverName: null,
      title: "Policy rule added: No deletes",
      detail: null,
      link: { page: "policies", policyId: "rule_1" },
      actor: "admin@example.com"
    }
  ];

  beforeEach(() => {
    vi.mocked(api.fetchMcpServers).mockResolvedValue({
      servers: [
        { id: "mcp_a", name: "GitHub tools" } as api.McpRegisteredServer,
        { id: "mcp_b", name: "Files" } as api.McpRegisteredServer
      ],
      adapters: [],
      defaultProbeIntervalMs: 0
    });
    vi.mocked(api.fetchMcpChanges).mockResolvedValue({ kinds: [], total: items.length, items });
  });

  it("lists changes by day, opens breaking diffs and links to the owning page", async () => {
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    render(<McpChangesPage isAdmin onNavigate={onNavigate} />);

    const breaking = (await screen.findByText(/Breaking schema change/)).closest("li") as HTMLElement;
    // Unreviewed breaking diffs open by default.
    expect(within(breaking).getByText("property repo is now required")).toBeInTheDocument();
    await user.click(within(breaking).getByRole("button", { name: "Hide diff" }));
    expect(within(breaking).queryByText("property repo is now required")).not.toBeInTheDocument();
    await user.click(within(breaking).getByRole("button", { name: "Open server" }));
    expect(onNavigate).toHaveBeenLastCalledWith({ page: "servers", serverId: "mcp_a" });

    const policy = screen.getByText("Policy rule added: No deletes").closest("li") as HTMLElement;
    expect(within(policy).getByText("by admin@example.com")).toBeInTheDocument();
    await user.click(within(policy).getByRole("button", { name: "Open rule" }));
    expect(onNavigate).toHaveBeenLastCalledWith({ page: "policies", policyId: "rule_1" });

    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(2);
  });

  it("filters by server, kind and breaking only", async () => {
    const user = userEvent.setup();
    render(<McpChangesPage isAdmin={false} initialServerId="mcp_b" onNavigate={vi.fn()} />);
    await waitFor(() => expect(api.fetchMcpChanges).toHaveBeenCalledWith({ serverId: "mcp_b", kinds: [], limit: 200 }));
    expect(screen.getByText(/visible to admins in the audit log/)).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Server" }), "mcp_a");
    await waitFor(() => expect(api.fetchMcpChanges).toHaveBeenLastCalledWith({ serverId: "mcp_a", kinds: [], limit: 200 }));

    await user.click(screen.getByRole("button", { name: "Policy" }));
    await user.click(screen.getByRole("button", { name: "Status" }));
    await waitFor(() =>
      expect(api.fetchMcpChanges).toHaveBeenLastCalledWith({ serverId: "mcp_a", kinds: ["policy", "status"], limit: 200 })
    );
    expect(screen.getByRole("button", { name: "Policy" })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "Breaking only" }));
    expect(screen.getByText(/Breaking schema change/)).toBeInTheDocument();
    expect(screen.queryByText("Files: Healthy → Down")).not.toBeInTheDocument();
    expect(screen.getByText("1 change")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(api.fetchMcpChanges).toHaveBeenLastCalledWith({ serverId: null, kinds: [], limit: 200 }));
    expect(screen.getByText("Files: Healthy → Down")).toBeInTheDocument();
  });
});
