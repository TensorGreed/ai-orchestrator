import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { McpToolPolicyRule } from "@ai-orchestrator/shared";
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
    fetchSecrets: vi.fn(),
    fetchProjects: vi.fn(),
    fetchMcpToolPolicies: vi.fn(),
    createMcpToolPolicy: vi.fn(),
    updateMcpToolPolicy: vi.fn(),
    deleteMcpToolPolicy: vi.fn(),
    evaluateMcpToolPolicy: vi.fn(),
    setMcpToolClassification: vi.fn()
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

function makeRule(overrides: Partial<McpToolPolicyRule> = {}): McpToolPolicyRule {
  return {
    id: "rule_1",
    name: "Viewers: no calculator",
    description: null,
    effect: "deny",
    projectId: null,
    roles: ["viewer"],
    serverId: "mcp_1",
    toolPattern: "calculator",
    enabled: true,
    createdBy: "admin@example.com",
    createdAt: "2026-10-20T10:00:00.000Z",
    updatedAt: "2026-10-20T10:00:00.000Z",
    ...overrides
  };
}

function setupServers() {
  vi.mocked(api.fetchMcpServers).mockResolvedValue({
    servers: [server],
    adapters: [{ id: "mock-mcp", label: "Mock MCP" }],
    defaultProbeIntervalMs: 300000
  });
  vi.mocked(api.fetchMcpServer).mockResolvedValue({ server, probes: [], snapshots: [], usages: [] });
  vi.mocked(api.fetchMcpServerTools).mockResolvedValue({
    serverId: "mcp_1",
    snapshotId: "snap_1",
    probedAt: server.lastProbeAt,
    policy: { role: "viewer", projectId: "default" },
    tools: [
      {
        name: "calculator",
        inputSchema: { type: "object", properties: {} },
        classification: { readOnly: false, source: "unknown" },
        manualReadOnly: null,
        access: { allowed: false, reason: "policy", ruleId: "rule_1", ruleName: "Viewers: no calculator", message: "blocked" }
      },
      {
        name: "lookup_kb",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
        classification: { readOnly: true, source: "annotation" },
        manualReadOnly: null,
        access: { allowed: true }
      }
    ]
  });
  vi.mocked(api.fetchMcpServerTelemetry).mockImplementation(async (_id, window = "7d") => ({
    serverId: "mcp_1",
    window,
    since: "2026-10-13T10:00:00.000Z",
    totals: { calls: 0, errors: 0, errorRate: 0, p50Ms: null, p95Ms: null, inputTokens: 0, outputTokens: 0, costUsd: null, lastCalledAt: null },
    tools: []
  }));
}

describe("MCP tool policy UI", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.fetchMcpPresets).mockResolvedValue({ presets: [] });
    vi.mocked(api.fetchSecrets).mockResolvedValue([]);
    vi.mocked(api.fetchProjects).mockResolvedValue({
      projects: [{ id: "default", name: "Default", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }]
    });
    setupServers();
  });

  it("shows read-only classification with its source, blocked marks, and lets admins override", async () => {
    const user = userEvent.setup();
    vi.mocked(api.setMcpToolClassification).mockResolvedValue({
      serverId: "mcp_1",
      toolName: "calculator",
      classification: { readOnly: true, source: "manual" },
      manualReadOnly: true
    });

    render(<McpServersPage isAdmin activeProjectId="default" />);

    const table = (await screen.findByRole("columnheader", { name: "Access" })).closest("table") as HTMLTableElement;
    await waitFor(() => expect(within(table).getByText("unknown → write")).toBeInTheDocument());
    expect(api.fetchMcpServerTools).toHaveBeenCalledWith("mcp_1", "default");
    expect(within(table).getByText("annotation")).toBeInTheDocument();
    expect(within(table).getByText("Blocked for your role: Viewers: no calculator")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Classification for calculator"), "read");
    expect(api.setMcpToolClassification).toHaveBeenCalledWith("mcp_1", "calculator", true);
    await waitFor(() => expect(within(table).getByText("manual")).toBeInTheDocument());
    expect(within(table).getAllByText("Read-only")).toHaveLength(2);

    await user.selectOptions(screen.getByLabelText("Classification for calculator"), "auto");
    expect(api.setMcpToolClassification).toHaveBeenLastCalledWith("mcp_1", "calculator", null);
  });

  it("hides the override control from non-admins", async () => {
    render(<McpServersPage isAdmin={false} />);
    await screen.findByText("unknown → write");
    expect(screen.queryByLabelText("Classification for calculator")).not.toBeInTheDocument();
  });

  it("lists, adds, edits, disables and deletes policy rules as an admin", async () => {
    const user = userEvent.setup();
    const existing = makeRule();
    vi.mocked(api.fetchMcpToolPolicies).mockResolvedValue({ rules: [existing], roles: ["admin", "builder", "operator", "viewer"] });
    vi.mocked(api.createMcpToolPolicy).mockImplementation(async (payload) => ({
      rule: makeRule({
        id: "rule_2",
        name: payload.name ?? null,
        effect: payload.effect,
        roles: payload.roles ?? [],
        serverId: payload.serverId ?? null,
        toolPattern: payload.toolPattern ?? "*"
      })
    }));
    vi.mocked(api.updateMcpToolPolicy).mockImplementation(async (id, patch) => ({
      rule: { ...existing, ...patch, id } as McpToolPolicyRule
    }));
    vi.mocked(api.deleteMcpToolPolicy).mockResolvedValue({ ok: true });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<McpServersPage isAdmin activeProjectId="default" />);
    await user.click(await screen.findByRole("tab", { name: "Policies" }));

    const list = await screen.findByRole("list", { name: "Tool policy rules" });
    expect(within(list).getByText("Viewers: no calculator")).toBeInTheDocument();
    expect(within(list).getByText("Deny")).toBeInTheDocument();
    expect(within(list).getByText("Demo tools")).toBeInTheDocument();
    expect(within(list).getByText("viewer")).toBeInTheDocument();
    expect(within(list).getByText("All projects")).toBeInTheDocument();

    // Add
    await user.click(screen.getByRole("button", { name: "+ Add rule" }));
    const form = screen.getByRole("form", { name: "Add tool policy rule" });
    await user.type(within(form).getByLabelText("Name"), "Builders: no deletes");
    await user.selectOptions(within(form).getByLabelText("Server"), "mock-mcp");
    await user.clear(within(form).getByLabelText("Tool name or pattern"));
    await user.type(within(form).getByLabelText("Tool name or pattern"), "delete_*");
    await user.click(within(form).getByLabelText("builder"));
    await user.click(within(form).getByRole("button", { name: "Add rule" }));
    expect(api.createMcpToolPolicy).toHaveBeenCalledWith({
      name: "Builders: no deletes",
      description: null,
      effect: "deny",
      projectId: null,
      roles: ["builder"],
      serverId: "mock-mcp",
      toolPattern: "delete_*",
      enabled: true
    });
    expect(await within(list).findByText("Builders: no deletes")).toBeInTheDocument();
    expect(within(list).getByText("mock-mcp (inline)")).toBeInTheDocument();

    // Disable
    await user.click(screen.getByLabelText("Enable rule Viewers: no calculator"));
    expect(api.updateMcpToolPolicy).toHaveBeenCalledWith("rule_1", { enabled: false });
    expect(await within(list).findByText("disabled")).toBeInTheDocument();

    // Edit
    const firstRule = within(list).getAllByRole("listitem")[0];
    await user.click(within(firstRule).getByRole("button", { name: "Edit" }));
    const editForm = screen.getByRole("form", { name: "Edit tool policy rule" });
    await user.selectOptions(within(editForm).getByLabelText("Effect"), "allow");
    await user.click(within(editForm).getByRole("button", { name: "Save rule" }));
    expect(api.updateMcpToolPolicy).toHaveBeenLastCalledWith("rule_1", expect.objectContaining({ effect: "allow", toolPattern: "calculator" }));

    // Delete
    await user.click(within(within(list).getAllByRole("listitem")[0]).getByRole("button", { name: "Delete" }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(api.deleteMcpToolPolicy).toHaveBeenCalledWith("rule_1");
    await waitFor(() => expect(within(list).queryByText("Viewers: no calculator")).not.toBeInTheDocument());
    confirmSpy.mockRestore();
  });

  it("is read-only for builders", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchMcpToolPolicies).mockResolvedValue({ rules: [makeRule()], roles: ["admin", "builder", "operator", "viewer"] });
    render(<McpServersPage isAdmin={false} />);
    await user.click(await screen.findByRole("tab", { name: "Policies" }));
    await screen.findByText("Viewers: no calculator");
    expect(screen.queryByRole("button", { name: "+ Add rule" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Enable rule Viewers: no calculator")).not.toBeInTheDocument();
  });

  it("tests a tool against the policy and explains the decision", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchMcpToolPolicies).mockResolvedValue({ rules: [makeRule()], roles: ["admin", "builder", "operator", "viewer"] });
    vi.mocked(api.evaluateMcpToolPolicy).mockResolvedValue({
      allowed: false,
      reason: "policy",
      ruleId: "rule_1",
      ruleName: "Viewers: no calculator",
      message: "MCP tool 'calculator' on server 'Demo tools' is blocked by policy 'Viewers: no calculator' (rule_1) for role viewer.",
      decidedBy: "rule",
      decidingRuleId: "rule_1",
      matchedRules: [makeRule()],
      overriddenDenies: [],
      classification: { readOnly: false, source: "unknown" },
      manualReadOnly: null,
      server: { kind: "registry", id: "mcp_1", name: "Demo tools", adapterId: "mock-mcp" }
    });

    render(<McpServersPage isAdmin={false} activeProjectId="default" />);
    await user.click(await screen.findByRole("tab", { name: "Policies" }));
    const form = await screen.findByRole("form", { name: "Test a tool against the policy" });
    await user.type(within(form).getByLabelText("Tool"), "calculator");
    await user.click(within(form).getByRole("button", { name: "Check" }));

    expect(api.evaluateMcpToolPolicy).toHaveBeenCalledWith({
      projectId: "default",
      role: "viewer",
      serverId: "mcp_1",
      toolName: "calculator",
      noWriteTools: false
    });
    const result = await screen.findByRole("status");
    expect(within(result).getByText("Blocked")).toBeInTheDocument();
    expect(within(result).getByText(/blocked by policy 'Viewers: no calculator'/)).toBeInTheDocument();
    expect(within(result).getByText(/unknown → write/)).toBeInTheDocument();
  });
});
