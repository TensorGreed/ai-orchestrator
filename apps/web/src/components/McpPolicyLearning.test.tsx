/**
 * Phase 12.4 — simulate a rule from the editor, review least-privilege suggestions (preview, accept in shadow,
 * dismiss, enforce) and see shadow hits on shadow rules.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  emptyMcpPolicySimulationCounts,
  type McpPolicySimulationResult,
  type McpPolicySuggestion,
  type McpToolPolicyRule
} from "@ai-orchestrator/shared";
import { beforeEach, vi } from "vitest";
import * as api from "../lib/api";
import { McpPoliciesView } from "./McpPoliciesView";
import { enforceReadiness, summaryLines } from "./McpPolicyLearning";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchProjects: vi.fn(),
    fetchMcpToolPolicies: vi.fn(),
    fetchWorkflows: vi.fn(),
    fetchMcpClients: vi.fn(),
    fetchMcpGatewayApprovals: vi.fn(),
    evaluateMcpToolPolicy: vi.fn(),
    simulateMcpToolPolicies: vi.fn(),
    fetchMcpPolicyShadowHits: vi.fn(),
    fetchMcpPolicySuggestions: vi.fn(),
    generateMcpPolicySuggestions: vi.fn(),
    decideMcpPolicySuggestion: vi.fn(),
    enforceMcpToolPolicy: vi.fn()
  };
});

const DAY = 24 * 60 * 60 * 1000;

function rule(overrides: Partial<McpToolPolicyRule> = {}): McpToolPolicyRule {
  return {
    id: "rule_1",
    name: "No deletes",
    description: null,
    effect: "deny",
    projectId: null,
    roles: [],
    serverId: null,
    toolPattern: "delete_*",
    enabled: true,
    mode: "enforce",
    ...overrides
  };
}

function simulation(overrides: Partial<McpPolicySimulationResult> = {}): McpPolicySimulationResult {
  const counts = { ...emptyMcpPolicySimulationCounts(), newly_denied: 3, unchanged: 40, undetermined: 2 };
  return {
    windowDays: 7,
    since: "2026-10-23T00:00:00.000Z",
    until: "2026-10-30T00:00:00.000Z",
    scanned: 45,
    capped: false,
    scanCap: 50000,
    oldestScannedAt: "2026-10-23T01:00:00.000Z",
    counts,
    rules: [
      { ruleId: "draft", name: "Draft", effect: "deny", mode: "enforce", presence: "draft", matched: 3, undetermined: 2, newlyDenied: 3, newlyNeedsApproval: 0, noLongerDenied: 0, noLongerNeedsApproval: 0 }
    ],
    groups: [{ kind: "workflow", id: "wf_1", name: "Release bot", counts }],
    groupsCapped: false,
    examples: {
      ...Object.fromEntries(Object.keys(counts).map((bucket) => [bucket, []])),
      newly_denied: [
        {
          callId: "mtc_1",
          startedAt: "2026-10-29T10:00:00.000Z",
          toolName: "delete_issue",
          serverId: "mcp_1",
          serverName: "GitHub",
          source: "workflow",
          workflowId: "wf_1",
          workflowName: "Release bot",
          clientId: null,
          clientName: null,
          role: "builder",
          currentEffect: "allow",
          draftEffect: "deny",
          currentRuleId: null,
          draftRuleId: "draft",
          reason: null,
          summary: { v: 2, fields: { repo: { type: "string", values: ["docs"] }, body: { type: "string", hashes: ["h"], len: "33-128" } } }
        }
      ]
    } as McpPolicySimulationResult["examples"],
    ...overrides
  };
}

function suggestion(overrides: Partial<McpPolicySuggestion> = {}): McpPolicySuggestion {
  return {
    id: "mps_1",
    scopeKind: "workflow",
    scopeId: "wf_1",
    scopeName: "Release bot",
    serverId: "mcp_1",
    serverName: "GitHub",
    status: "open",
    fingerprint: "fp",
    rules: [
      { name: "deny", description: null, effect: "deny", projectId: null, roles: ["builder", "operator", "viewer"], serverId: "mcp_1", toolPattern: "*", workflowIds: ["wf_1"], clientIds: [], conditions: null, kind: "tool" },
      {
        name: "allow",
        description: null,
        effect: "allow",
        projectId: null,
        roles: ["builder", "operator", "viewer"],
        serverId: "mcp_1",
        toolPattern: "create_issue",
        workflowIds: ["wf_1"],
        clientIds: [],
        conditions: { all: [{ path: "repo", op: "one_of", value: ["api", "docs"] }] },
        kind: "tool"
      }
    ],
    evidence: {
      calls: 24,
      scopeCalls: 30,
      roles: ["builder"],
      capped: false,
      tools: [{ toolName: "create_issue", calls: 24, constraints: [{ path: "repo", kind: "one_of", values: ["api", "docs"] }], skipped: [{ path: "title", reason: "hashed" }] }]
    },
    windowDays: 30,
    windowStart: "2026-09-30T00:00:00.000Z",
    windowEnd: "2026-10-30T00:00:00.000Z",
    callCount: 24,
    acceptedRuleIds: [],
    createdBy: "admin@example.com",
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z",
    decidedBy: null,
    decidedAt: null,
    ...overrides
  };
}

function renderView(isAdmin = true) {
  return render(<McpPoliciesView isAdmin={isAdmin} servers={[]} adapters={[{ id: "mock-mcp", label: "Mock MCP" }]} activeProjectId="default" />);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.fetchProjects).mockResolvedValue({ projects: [] });
  vi.mocked(api.fetchWorkflows).mockResolvedValue([]);
  vi.mocked(api.fetchMcpClients).mockResolvedValue({ usageWindow: "7d", clients: [] });
  vi.mocked(api.fetchMcpGatewayApprovals).mockResolvedValue({ approvals: [], approvalWindowMs: 900000 });
  vi.mocked(api.fetchMcpToolPolicies).mockResolvedValue({ rules: [rule()], roles: ["admin", "builder", "operator", "viewer"] });
  vi.mocked(api.fetchMcpPolicySuggestions).mockResolvedValue({ suggestions: [] });
  vi.mocked(api.fetchMcpPolicyShadowHits).mockResolvedValue({ shadowHits: { days: 7, since: "", scanned: 0, capped: false, rules: [], groups: [] } });
});

describe("policy simulation in the rule editor", () => {
  it("simulates a new rule as an added rule and shows buckets, rules, callers and summary-only examples", async () => {
    const user = userEvent.setup();
    vi.mocked(api.simulateMcpToolPolicies).mockResolvedValue({ simulation: simulation() });
    renderView();
    await user.click(await screen.findByRole("button", { name: "+ Add rule" }));
    const form = screen.getByRole("form", { name: "Add tool policy rule" });
    await user.clear(within(form).getByLabelText("Tool name or pattern"));
    await user.type(within(form).getByLabelText("Tool name or pattern"), "delete_issue");
    await user.click(within(form).getByRole("button", { name: "What would this have done in the last 7 days?" }));

    expect(api.simulateMcpToolPolicies).toHaveBeenCalledWith(
      expect.objectContaining({ windowDays: 7, addRule: expect.objectContaining({ toolPattern: "delete_issue", mode: "enforce", effect: "deny" }) })
    );
    const report = await within(form).findByLabelText("Simulation result");
    expect(within(report).getByRole("button", { name: /3 Newly denied/ })).toBeInTheDocument();
    expect(within(report).getByRole("button", { name: /2 Undetermined/ })).toBeInTheDocument();
    expect(within(report).getByText("Release bot")).toBeInTheDocument();
    await user.click(within(report).getByRole("button", { name: /3 Newly denied/ }));
    const examples = within(report).getByRole("list", { name: "Newly denied examples" });
    expect(within(examples).getByText('repo: "docs"')).toBeInTheDocument();
    expect(within(examples).getByText("body: 1 hashed value; text of 33-128 chars")).toBeInTheDocument();
  });

  it("simulates an edit in place of the rule it changes, keeping the others by id", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchMcpToolPolicies).mockResolvedValue({
      rules: [rule(), rule({ id: "rule_2", name: "Second", toolPattern: "drop_*" })],
      roles: ["admin", "builder", "operator", "viewer"]
    });
    vi.mocked(api.simulateMcpToolPolicies).mockResolvedValue({ simulation: simulation({ capped: true, scanned: 50000, scanCap: 50000 }) });
    renderView();
    const list = await screen.findByRole("list", { name: "Tool policy rules" });
    await user.click(within(list).getAllByRole("button", { name: "Edit" })[1]!);
    const form = screen.getByRole("form", { name: "Edit tool policy rule" });
    await user.selectOptions(within(form).getByLabelText("Simulation window"), "30");
    await user.click(within(form).getByRole("button", { name: "What would this have done in the last 30 days?" }));
    expect(api.simulateMcpToolPolicies).toHaveBeenCalledWith({
      windowDays: 30,
      rules: [{ keep: "rule_1" }, expect.objectContaining({ id: "rule_2", toolPattern: "drop_*", mode: "enforce" })]
    });
    expect(await within(form).findByText(/Stopped at 50,000 calls/)).toBeInTheDocument();
  });
});

describe("least-privilege suggestions", () => {
  it("generates, previews, accepts and dismisses suggestions", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchMcpPolicySuggestions).mockImplementation(async (status) => ({ suggestions: status === "open" ? [suggestion()] : [] }));
    vi.mocked(api.generateMcpPolicySuggestions).mockResolvedValue({
      result: {
        windowDays: 30,
        since: "",
        until: "",
        minCalls: 20,
        scanned: 120,
        capped: false,
        created: 1,
        updated: 0,
        unchanged: 0,
        skipped: [{ scopeKind: "workflow", scopeId: "wf_2", scopeName: "Other", serverId: null, reason: "too_few_calls" }],
        suggestions: [suggestion()]
      }
    });
    vi.mocked(api.simulateMcpToolPolicies).mockResolvedValue({ simulation: simulation() });
    vi.mocked(api.decideMcpPolicySuggestion).mockResolvedValue({ suggestion: suggestion({ status: "accepted" }) });
    renderView();

    const panel = await screen.findByRole("region", { name: "Rule suggestions" });
    await user.click(within(panel).getByRole("button", { name: "Suggest rules" }));
    expect(await within(panel).findByText(/Read 120 calls from the last 30 days; 1 new, 0 changed, 0 unchanged; no suggestion for 1 \(too few calls\)/)).toBeInTheDocument();

    const item = within(panel).getByRole("listitem", { name: "Suggestion for Workflow Release bot" });
    expect(within(item).getByText("every other tool")).toBeInTheDocument();
    expect(within(item).getAllByText("create_issue", { selector: "code" })).toHaveLength(2);
    expect(within(item).getByText(/no constraint on title \(hashed\)/)).toBeInTheDocument();

    await user.click(within(item).getByRole("button", { name: "Preview impact" }));
    expect(api.simulateMcpToolPolicies).toHaveBeenCalledWith({
      windowDays: 30,
      rules: [{ keep: "rule_1" }, expect.objectContaining({ toolPattern: "*", mode: "enforce" }), expect.objectContaining({ toolPattern: "create_issue", mode: "enforce" })],
      filters: { serverId: "mcp_1" }
    });
    expect(await within(item).findByLabelText("Simulation result")).toBeInTheDocument();

    await user.click(within(item).getByRole("button", { name: "Accept in shadow mode" }));
    expect(api.decideMcpPolicySuggestion).toHaveBeenCalledWith("mps_1", "accept", suggestion().fingerprint);
    await waitFor(() => expect(api.fetchMcpToolPolicies).toHaveBeenCalledTimes(2));

    await user.click(within(item).getByRole("button", { name: "Dismiss" }));
    expect(api.decideMcpPolicySuggestion).toHaveBeenCalledWith("mps_1", "dismiss", suggestion().fingerprint);
  });

  it("shows shadow hits and enforces an accepted suggestion as a whole, however old, asking first when it is not quiet", async () => {
    const user = userEvent.setup();
    const shadowRules = [
      rule({ id: "mtp_deny", name: "Least privilege deny", toolPattern: "*", mode: "shadow" }),
      rule({ id: "mtp_allow", effect: "allow", toolPattern: "create_issue", mode: "shadow" }),
      rule({ id: "mtp_lone", name: "Lone shadow", toolPattern: "drop_*", mode: "shadow" })
    ];
    vi.mocked(api.fetchMcpToolPolicies).mockResolvedValue({ rules: shadowRules, roles: ["admin", "builder", "operator", "viewer"] });
    vi.mocked(api.fetchMcpPolicyShadowHits).mockResolvedValue({
      shadowHits: {
        days: 7,
        since: "",
        scanned: 10,
        capped: false,
        rules: [
          { ruleId: "mtp_deny", matched: 10, wouldChange: 10, lastMatchedAt: null, lastWouldChangeAt: null },
          { ruleId: "mtp_allow", matched: 6, wouldChange: 0, lastMatchedAt: null, lastWouldChangeAt: null },
          { ruleId: "mtp_lone", matched: 0, wouldChange: 0, lastMatchedAt: null, lastWouldChangeAt: null }
        ],
        groups: [{ suggestionId: "mps_1", ruleIds: ["mtp_deny", "mtp_allow"], matched: 10, wouldChange: 1, lastWouldChangeAt: null }]
      }
    });
    const accepted = suggestion({ status: "accepted", acceptedRuleIds: ["mtp_deny", "mtp_allow"], decidedAt: new Date(Date.now() - 2 * DAY).toISOString() });
    // Accepted suggestions in shadow come from the uncapped lookup: an old one is past the newest-first list's cap.
    vi.mocked(api.fetchMcpPolicySuggestions).mockImplementation(async (status, options) => ({
      suggestions: status === "accepted" && options?.inShadow ? [accepted] : []
    }));
    vi.mocked(api.decideMcpPolicySuggestion).mockResolvedValue({ suggestion: accepted, rules: [] });
    vi.mocked(api.enforceMcpToolPolicy).mockResolvedValue({ rule: { ...shadowRules[2]!, mode: "enforce" } });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);
    renderView();

    // A lone deny would block every call it matched; the suggestion as a whole changes one.
    expect(await screen.findByLabelText("Shadow hits for Least privilege deny")).toHaveTextContent(
      "matched 10 calls; if you enforce just this rule, 10 would change. Part of an accepted suggestion"
    );
    const item = await screen.findByRole("listitem", { name: "Accepted suggestion for Workflow Release bot" });
    expect(within(item).getByText(/would have changed 1 of the 10 calls/)).toBeInTheDocument();
    await user.click(within(item).getByRole("button", { name: "Enforce suggestion now" }));
    expect(api.decideMcpPolicySuggestion).not.toHaveBeenCalled();
    await user.click(within(item).getByRole("button", { name: "Enforce suggestion now" }));
    expect(api.decideMcpPolicySuggestion).toHaveBeenCalledWith("mps_1", "enforce", accepted.fingerprint);

    // The suggestion's rules have no Enforce of their own; a lone shadow rule keeps one.
    const list = screen.getByRole("list", { name: "Tool policy rules" });
    const enforceButtons = within(list).getAllByRole("button", { name: "Enforce" });
    expect(enforceButtons).toHaveLength(1);
    await user.click(enforceButtons[0]!);
    expect(api.enforceMcpToolPolicy).toHaveBeenCalledWith("mtp_lone");
    confirmSpy.mockRestore();
  });

  it("says when nothing was suggested from a capped scan, and labels an update of accepted rules", async () => {
    const user = userEvent.setup();
    const update = suggestion({
      id: "mps_2",
      evidence: { ...suggestion().evidence, updates: { suggestionIds: ["mps_1"], ruleIds: ["r1", "r2"], addedTools: ["add_label"] }, unknownRoleCalls: 2, inlineAdapter: true }
    });
    vi.mocked(api.fetchMcpPolicySuggestions).mockImplementation(async (status) => ({ suggestions: status === "open" ? [update] : [] }));
    vi.mocked(api.generateMcpPolicySuggestions).mockResolvedValue({
      result: { windowDays: 30, since: "", until: "", minCalls: 20, scanned: 50000, capped: true, notGenerated: "scan_capped", created: 0, updated: 0, unchanged: 0, skipped: [], suggestions: [] }
    });
    renderView();
    const panel = await screen.findByRole("region", { name: "Rule suggestions" });
    const item = await within(panel).findByRole("listitem", { name: "Suggestion for Workflow Release bot" });
    expect(within(item).getByText(/Update accepted rules:/)).toBeInTheDocument();
    expect(within(item).getByText(/started using 'add_label' after its suggested rules were accepted/)).toBeInTheDocument();
    expect(within(item).getByText(/2 of them had no recorded role/)).toBeInTheDocument();
    expect(within(item).getByText(/every inline server of the/)).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Suggest rules" }));
    expect(await within(panel).findByText(/Nothing suggested: .*never suggested from part of the calls/)).toBeInTheDocument();
  });

  it("is not shown to builders", async () => {
    renderView(false);
    await screen.findByRole("list", { name: "Tool policy rules" });
    expect(screen.queryByRole("region", { name: "Rule suggestions" })).not.toBeInTheDocument();
    expect(api.fetchMcpPolicySuggestions).not.toHaveBeenCalled();
    expect(api.fetchMcpPolicyShadowHits).not.toHaveBeenCalled();
  });
});

describe("helpers", () => {
  it("reads readiness from the suggestion's shadow hits, time in shadow, and never from a capped scan", () => {
    const hits = {
      days: 7,
      since: "",
      scanned: 5,
      capped: false,
      rules: [{ ruleId: "r", matched: 5, wouldChange: 5, lastMatchedAt: null, lastWouldChangeAt: null }],
      groups: [{ suggestionId: "s", ruleIds: ["r"], matched: 5, wouldChange: 0, lastWouldChangeAt: null }]
    };
    const old = new Date(Date.now() - 8 * DAY).toISOString();
    expect(enforceReadiness({ id: "s", decidedAt: old }, hits).ready).toBe(true);
    expect(enforceReadiness({ id: "s", decidedAt: new Date(Date.now() - 1 * DAY).toISOString() }, hits)).toMatchObject({ ready: false });
    expect(enforceReadiness({ id: "s", decidedAt: old }, { ...hits, capped: true })).toMatchObject({ ready: false, text: expect.stringMatching(/^Not ready \(scan capped\)/) });
    expect(enforceReadiness({ id: "s", decidedAt: old }, null).ready).toBe(false);
  });

  it("describes summaries without raw arguments", () => {
    expect(summaryLines({ v: 2, fields: { n: { type: "number", mag: 7 }, tags: { type: "array", items: 3 }, x: { type: "string", more: true } }, truncated: true })).toEqual([
      "n: number around 1e7",
      "tags: 3 items",
      "x: too many values to keep",
      "(summary truncated)"
    ]);
    expect(summaryLines({ v: 3, fields: { branch: { type: "string", values: ["main"], adj: true } } })).toEqual(['branch: "main"; kept in a normalised form']);
  });
});
