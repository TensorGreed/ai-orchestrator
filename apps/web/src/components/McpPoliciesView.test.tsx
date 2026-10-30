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
    setMcpToolClassification: vi.fn(),
    fetchWorkflows: vi.fn(),
    fetchMcpClients: vi.fn(),
    fetchMcpGatewayApprovals: vi.fn(),
    decideMcpGatewayApproval: vi.fn()
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
    vi.mocked(api.fetchWorkflows).mockResolvedValue([
      { id: "wf_1", name: "Release bot", schemaVersion: "1.0.0", workflowVersion: 1, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" }
    ]);
    vi.mocked(api.fetchMcpClients).mockResolvedValue({
      usageWindow: "7d",
      clients: [{ id: "mcpc_1", name: "IDE agent", status: "active" } as api.McpClientView]
    });
    vi.mocked(api.fetchMcpGatewayApprovals).mockResolvedValue({ approvals: [], approvalWindowMs: 900000 });
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
    // Two classification badges plus the readOnlyHint annotation chip on lookup_kb.
    expect(within(table).getAllByText("Read-only")).toHaveLength(3);

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

    render(<McpServersPage view="policies" isAdmin activeProjectId="default" />);

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
      annotationHint: null,
      kind: "tool",
      enabled: true,
      mode: "enforce",
      conditions: null,
      workflowIds: [],
      clientIds: []
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

  it("adds a rule that targets destructive tools and shows the condition in the list", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchMcpToolPolicies).mockResolvedValue({ rules: [], roles: ["admin", "builder", "operator", "viewer"] });
    vi.mocked(api.createMcpToolPolicy).mockImplementation(async (payload) => ({
      rule: makeRule({
        id: "rule_3",
        name: payload.name ?? null,
        roles: payload.roles ?? [],
        serverId: payload.serverId ?? null,
        toolPattern: payload.toolPattern ?? "*",
        annotationHint: payload.annotationHint ?? null
      })
    }));

    render(<McpServersPage view="policies" isAdmin activeProjectId="default" />);
    await user.click(await screen.findByRole("button", { name: "+ Add rule" }));
    const form = screen.getByRole("form", { name: "Add tool policy rule" });
    await user.type(within(form).getByLabelText("Name"), "Operators: no destructive tools");
    await user.click(within(form).getByLabelText("operator"));
    await user.click(within(form).getByText("Advanced"));
    await user.selectOptions(within(form).getByLabelText("Annotation condition"), "destructive");
    await user.click(within(form).getByRole("button", { name: "Add rule" }));

    expect(api.createMcpToolPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ roles: ["operator"], toolPattern: "*", annotationHint: "destructive" })
    );
    const list = await screen.findByRole("list", { name: "Tool policy rules" });
    expect(await within(list).findByText("Destructive tools")).toBeInTheDocument();
  });

  it("is read-only for builders", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchMcpToolPolicies).mockResolvedValue({ rules: [makeRule()], roles: ["admin", "builder", "operator", "viewer"] });
    render(<McpServersPage view="policies" isAdmin={false} />);
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

    render(<McpServersPage view="policies" isAdmin={false} activeProjectId="default" />);
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

  it("builds conditions, scopes a rule to a client and marks a shadow rule", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchMcpToolPolicies).mockResolvedValue({ rules: [], roles: ["admin", "builder", "operator", "viewer"] });
    vi.mocked(api.createMcpToolPolicy).mockImplementation(async (payload) => ({
      rule: makeRule({
        id: "rule_4",
        name: payload.name ?? null,
        effect: payload.effect,
        roles: [],
        mode: payload.mode,
        conditions: payload.conditions ?? null,
        clientIds: payload.clientIds ?? []
      })
    }));

    render(<McpServersPage view="policies" isAdmin activeProjectId="default" />);
    await user.click(await screen.findByRole("button", { name: "+ Add rule" }));
    const form = screen.getByRole("form", { name: "Add tool policy rule" });
    await user.type(within(form).getByLabelText("Name"), "Prod pushes need a person");
    await user.selectOptions(within(form).getByLabelText("Effect"), "require_approval");

    await user.click(within(form).getByRole("button", { name: "+ Add condition" }));
    await user.type(within(form).getByLabelText("Condition 1 argument path"), "repo");
    await user.selectOptions(within(form).getByLabelText("Condition 1 operator"), "one_of");
    await user.type(within(form).getByLabelText("Condition 1 value"), "acme/prod, acme/infra");
    await user.click(within(form).getByRole("button", { name: "+ Add condition" }));
    await user.selectOptions(within(form).getByLabelText("Condition 2 operator"), "between");
    await user.click(within(form).getByLabelText("Condition 2 argument path"));
    await user.paste("files[*].size");
    await user.type(within(form).getByLabelText("Condition 2 value"), "10");
    await user.type(within(form).getByLabelText("Condition 2 upper bound"), "5");
    await user.click(within(form).getByRole("button", { name: "Add rule" }));
    // Bounds the wrong way round are caught before saving.
    expect(within(form).getByText(/Condition 2: the lower bound is above the upper bound/)).toBeInTheDocument();
    expect(api.createMcpToolPolicy).not.toHaveBeenCalled();
    await user.click(within(form).getByLabelText("Remove condition 2"));

    await user.click(within(form).getByRole("button", { name: "+ Add condition" }));
    await user.selectOptions(within(form).getByLabelText("Condition 2 operator"), "label_present");
    expect(within(form).queryByLabelText("Condition 2 argument path")).not.toBeInTheDocument();
    await user.type(within(form).getByLabelText("Condition 2 value"), "pii");
    await user.selectOptions(within(form).getByLabelText("Combine conditions"), "any");
    await user.click(within(form).getByLabelText("Shadow mode"));
    await user.click(within(form).getByText("Advanced"));
    await user.selectOptions(within(form).getByLabelText("Only for gateway clients"), "mcpc_1");
    await user.click(within(form).getByRole("button", { name: "Add rule" }));

    expect(api.createMcpToolPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        effect: "require_approval",
        mode: "shadow",
        conditions: { any: [{ path: "repo", op: "one_of", value: ["acme/prod", "acme/infra"] }, { op: "label_present", value: "pii" }] },
        workflowIds: [],
        clientIds: ["mcpc_1"]
      })
    );
    const list = await screen.findByRole("list", { name: "Tool policy rules" });
    expect(await within(list).findByText("Needs approval")).toBeInTheDocument();
    expect(within(list).getByText("Shadow")).toBeInTheDocument();
    expect(within(list).getByText('repo is one of "acme/prod", "acme/infra" or data has label pii')).toBeInTheDocument();
    expect(within(list).getByText("IDE agent")).toBeInTheDocument();
  });

  it("tests a call with arguments and shows the matched rule, why, and what shadow rules would do", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchMcpToolPolicies).mockResolvedValue({ rules: [], roles: ["admin", "builder", "operator", "viewer"] });
    vi.mocked(api.evaluateMcpToolPolicy).mockResolvedValue({
      allowed: true,
      effect: "require_approval",
      approval: { ruleId: "rule_9", ruleName: "Big sums", message: "MCP tool 'calculator' needs approval by policy 'Big sums' (rule_9)." },
      reason: null,
      ruleId: null,
      ruleName: null,
      message: null,
      decidedBy: "rule",
      decidingRuleId: "rule_9",
      matchedRules: [],
      overriddenDenies: [],
      why: [{ ruleId: "rule_9", ruleName: "Big sums", effect: "require_approval", mode: "enforce", conditions: 'expression starts with "1000"' }],
      undecided: [],
      shadow: {
        effect: "deny",
        ruleId: "rule_s",
        ruleName: "Trial",
        changed: true,
        matchedRules: [{ ruleId: "rule_s", ruleName: "Trial", effect: "deny", mode: "shadow", conditions: null }]
      },
      classification: { readOnly: false, source: "unknown" },
      manualReadOnly: null,
      server: { kind: "registry", id: "mcp_1", name: "Demo tools", adapterId: "mock-mcp" }
    });

    render(<McpServersPage view="policies" isAdmin={false} activeProjectId="default" />);
    const form = await screen.findByRole("form", { name: "Test a tool against the policy" });
    await user.type(within(form).getByLabelText("Tool"), "calculator");
    await user.type(within(form).getByLabelText("Arguments (JSON, optional)"), "not json");
    await user.click(within(form).getByRole("button", { name: "Check" }));
    expect(await screen.findByText(/Arguments must be a JSON object/)).toBeInTheDocument();
    expect(api.evaluateMcpToolPolicy).not.toHaveBeenCalled();

    await user.clear(within(form).getByLabelText("Arguments (JSON, optional)"));
    await user.click(within(form).getByLabelText("Arguments (JSON, optional)"));
    await user.paste('{"expression": "1000*3"}');
    await user.type(within(form).getByLabelText("Data labels (optional)"), "pii, email");
    await user.selectOptions(within(form).getByLabelText("Gateway client (optional)"), "mcpc_1");
    await user.click(within(form).getByRole("button", { name: "Check" }));

    expect(api.evaluateMcpToolPolicy).toHaveBeenCalledWith({
      projectId: "default",
      role: "viewer",
      serverId: "mcp_1",
      toolName: "calculator",
      noWriteTools: false,
      arguments: { expression: "1000*3" },
      labels: ["pii", "email"],
      clientId: "mcpc_1"
    });
    const result = await screen.findByRole("status");
    expect(within(result).getAllByText("Needs approval").length).toBeGreaterThan(0);
    expect(within(result).getByText(/needs approval by policy 'Big sums'/)).toBeInTheDocument();
    expect(within(result).getByText('Matched: needs approval Big sums (when expression starts with "1000")')).toBeInTheDocument();
    expect(within(result).getByText(/Shadow rules would change this to: Deny/)).toBeInTheDocument();
  });

  it("lets admins approve and reject held-back gateway calls", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchMcpToolPolicies).mockResolvedValue({ rules: [], roles: ["admin", "builder", "operator", "viewer"] });
    const pending = {
      id: "mga_1",
      clientId: "mcpc_1",
      clientName: "IDE agent",
      toolsetId: "mts_1",
      projectId: "default",
      serverId: "mcp_1",
      serverName: "Demo tools",
      toolName: "calculator",
      gatewayToolName: "demo_tools__calculator",
      argsHash: "h",
      argsPreview: '{"expression":"1000*3"}',
      ruleId: "rule_9",
      ruleName: "Big sums",
      message: "needs approval",
      status: "pending" as const,
      requestedAt: "2026-10-30T10:00:00.000Z",
      expiresAt: "2026-10-31T10:00:00.000Z",
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
      usedAt: null
    };
    vi.mocked(api.fetchMcpGatewayApprovals).mockResolvedValue({ approvals: [pending, { ...pending, id: "mga_2", argsPreview: "{}" }], approvalWindowMs: 900000 });
    vi.mocked(api.decideMcpGatewayApproval).mockImplementation(async (id, decision) => ({
      approval: { ...pending, id, status: decision === "approve" ? "approved" : "rejected", decidedBy: "admin@example.com" }
    }));

    render(<McpServersPage view="policies" isAdmin activeProjectId="default" />);
    const list = await screen.findByRole("list", { name: "Gateway approval requests" });
    expect(screen.getByText(/once within 15 minutes/)).toBeInTheDocument();
    expect(within(list).getByLabelText("Arguments of mga_1")).toHaveTextContent('{"expression":"1000*3"}');
    await user.click(within(within(list).getAllByRole("listitem")[0]).getByRole("button", { name: "Approve" }));
    expect(api.decideMcpGatewayApproval).toHaveBeenCalledWith("mga_1", "approve");
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(1));
    await user.click(within(list).getByRole("button", { name: "Reject" }));
    expect(api.decideMcpGatewayApproval).toHaveBeenCalledWith("mga_2", "reject");
    expect(await screen.findByText("Nothing is waiting for approval.")).toBeInTheDocument();
  });

  it("does not show gateway approvals to builders", async () => {
    vi.mocked(api.fetchMcpToolPolicies).mockResolvedValue({ rules: [makeRule()], roles: ["admin", "builder", "operator", "viewer"] });
    render(<McpServersPage view="policies" isAdmin={false} />);
    await screen.findByText("Viewers: no calculator");
    expect(screen.queryByText("Gateway approvals")).not.toBeInTheDocument();
    expect(api.fetchMcpGatewayApprovals).not.toHaveBeenCalled();
  });
});
