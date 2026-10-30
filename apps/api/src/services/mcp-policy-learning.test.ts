/**
 * Phase 12.4 — policy simulation over recorded calls, shadow hit counts and least-privilege suggestions, against a
 * real store (SQLite by default; TEST_STORE=postgres runs it on Postgres).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpPolicyDraftRule, McpToolPolicyRule, ToolArgumentSummary, Workflow } from "@ai-orchestrator/shared";
import { createTestStore, type TestStore } from "../test-support/test-store.js";
import type { McpToolCallWrite } from "../db/database.js";
import { McpPolicySimulationService } from "./mcp-policy-simulation-service.js";
import { McpPolicySuggestionError, McpPolicySuggestionService, callReachedServer, constraintsFromSummaries } from "./mcp-policy-suggestion-service.js";

const NOW = new Date("2026-10-30T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR).toISOString();
const hashKey = new Uint8Array(32).fill(7);

let test: TestStore;
let seq = 0;

beforeEach(async () => {
  test = await createTestStore();
  seq = 0;
});
afterEach(async () => {
  await test.cleanup();
});

function workflow(id: string, name: string): Workflow {
  return { id, name, schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [] };
}

function summary(fields: ToolArgumentSummary["fields"]): ToolArgumentSummary {
  return { v: 2, fields } as ToolArgumentSummary;
}

async function record(overrides: Partial<McpToolCallWrite> = {}): Promise<string> {
  seq += 1;
  const id = `mtc_${String(seq).padStart(5, "0")}`;
  await test.store.insertMcpToolCall({
    id,
    executionId: `exec_${seq}`,
    workflowId: "wf_notes",
    nodeId: "agent",
    registryServerId: "mcp_github",
    adapterId: "http_mcp",
    toolName: "create_issue",
    startedAt: ago(1 + seq / 1000),
    durationMs: 5,
    ok: true,
    error: null,
    turnInputTokens: null,
    turnOutputTokens: null,
    estimatedCostUsd: null,
    subjectRole: "builder",
    subjectSource: "user",
    projectId: null,
    argsSummary: summary({ repo: { type: "string", values: ["docs"] } }),
    ...overrides
  });
  return id;
}

function rule(overrides: Partial<McpToolPolicyRule> & Pick<McpToolPolicyRule, "id" | "effect">): Omit<McpToolPolicyRule, "createdAt" | "updatedAt"> {
  return {
    name: overrides.id,
    description: null,
    projectId: null,
    roles: [],
    serverId: null,
    toolPattern: "*",
    annotationHint: null,
    kind: "tool",
    enabled: true,
    conditions: null,
    mode: "enforce",
    workflowIds: [],
    clientIds: [],
    ...overrides
  };
}

function simulation(options: { scanCap?: number; pageSize?: number } = {}) {
  return new McpPolicySimulationService({ store: test.store, hashKey, now: () => NOW, ...options });
}

const denyDocs: McpPolicyDraftRule = {
  effect: "deny",
  toolPattern: "create_issue",
  conditions: { all: [{ path: "repo", op: "equals", value: "docs" }] }
};

describe("policy simulation", () => {
  it("buckets calls by what the draft changes, with counts per rule and group and summary-only examples", async () => {
    await test.store.upsertWorkflow(workflow("wf_notes", "Release notes"));
    await record();
    await record();
    await record({ argsSummary: summary({ repo: { type: "string", values: ["api"] } }) });
    // A hash that is not HMAC("docs") proves the value is something else.
    await record({ argsSummary: summary({ repo: { type: "string", hashes: ["AAAAAAAAAAAAAAAAAAAAAA"], len: "1-8" } }) });
    // Too many values to keep: the summary cannot say whether one of them is "docs".
    await record({ argsSummary: summary({ repo: { type: "string", count: 40, more: true } }) });
    await record({ argsSummary: null });
    // Out of the window, a playground call and the gateway's own workflow-tool row are never read.
    await record({ startedAt: ago(24 * 8) });
    await record({ source: "playground", workflowId: "" });
    await record({ source: "gateway", workflowId: "", adapterId: "workflow", registryServerId: null, clientId: "mcpc_1" });

    const result = await simulation().simulate({ windowDays: 7, addRule: denyDocs });
    expect(result.scanned).toBe(6);
    expect(result.capped).toBe(false);
    expect(result.counts).toMatchObject({ newly_denied: 2, unchanged: 2, undetermined: 1, not_summarised: 1 });
    const draftRow = result.rules.find((row) => row.presence === "draft")!;
    expect(draftRow).toMatchObject({ matched: 2, undetermined: 1, newlyDenied: 2 });
    expect(result.groups).toEqual([
      { kind: "workflow", id: "wf_notes", name: "Release notes", counts: expect.objectContaining({ newly_denied: 2, undetermined: 1 }) }
    ]);
    const example = result.examples.newly_denied[0]!;
    expect(example).toMatchObject({ toolName: "create_issue", workflowName: "Release notes", currentEffect: "allow", draftEffect: "deny" });
    expect(example.summary).toEqual(summary({ repo: { type: "string", values: ["docs"] } }));
    expect(result.examples.undetermined[0]?.reason).toBeTruthy();
    // Responses never carry anything but the stored summary.
    expect(JSON.stringify(result)).not.toContain("arguments");
  });

  it("compares a whole draft set with the current rules, keeping rules by id", async () => {
    await test.store.createMcpToolPolicy(rule({ id: "mtp_block", effect: "deny", toolPattern: "create_issue" }));
    await test.store.createMcpToolPolicy(rule({ id: "mtp_other", effect: "deny", toolPattern: "delete_repo" }));
    await record();
    await record({ toolName: "delete_repo" });
    const result = await simulation().simulate({ windowDays: 7, rules: [{ keep: "mtp_other" }] });
    expect(result.counts).toMatchObject({ no_longer_denied: 1, unchanged: 1 });
    expect(result.rules.find((row) => row.ruleId === "mtp_block")).toMatchObject({ presence: "current", noLongerDenied: 1 });
    expect(result.rules.find((row) => row.ruleId === "mtp_other")).toMatchObject({ presence: "both", matched: 1 });
    await expect(simulation().simulate({ windowDays: 7, rules: [{ keep: "mtp_missing" }] })).rejects.toThrow(/does not exist/);
  });

  it("stops at the scan cap and says so", async () => {
    for (let index = 0; index < 7; index += 1) await record();
    const result = await simulation({ scanCap: 5, pageSize: 2 }).simulate({ windowDays: 7, addRule: denyDocs });
    expect(result).toMatchObject({ scanned: 5, capped: true, scanCap: 5 });
    const exact = await simulation({ scanCap: 7, pageSize: 7 }).simulate({ windowDays: 7, addRule: denyDocs });
    expect(exact).toMatchObject({ scanned: 7, capped: false });
  });

  it("never decides a workflow-scoped gateway client run whose client was not recorded", async () => {
    await record({ subjectSource: "client" });
    const result = await simulation().simulate({ windowDays: 7, addRule: { ...denyDocs, clientIds: ["mcpc_1"] } });
    expect(result.counts.undetermined).toBe(1);
  });

  it("counts shadow rule hits from recorded decisions", async () => {
    await test.store.createMcpToolPolicy(rule({ id: "mtp_shadow", effect: "deny", mode: "shadow" }));
    await test.store.createMcpToolPolicy(rule({ id: "mtp_quiet", effect: "deny", mode: "shadow", toolPattern: "nothing" }));
    const matched = [{ ruleId: "mtp_shadow", mode: "shadow" as const, effect: "deny" as const }];
    await record({ policyDecision: { effect: "allow", decidedBy: "default", matched, shadow: { effect: "deny", ruleId: "mtp_shadow", changed: true } } });
    await record({ policyDecision: { effect: "deny", decidedBy: "rule", matched, shadow: { effect: "deny", changed: false } } });
    await record({ policyDecision: { effect: "allow", decidedBy: "default", matched }, startedAt: ago(24 * 3) });
    const hits = await simulation().shadowHits(1);
    expect(hits.rules.find((row) => row.ruleId === "mtp_shadow")).toMatchObject({ matched: 2, wouldChange: 1 });
    expect(hits.rules.find((row) => row.ruleId === "mtp_quiet")).toMatchObject({ matched: 0, wouldChange: 0, lastMatchedAt: null });
    expect((await simulation().shadowHits(7)).rules.find((row) => row.ruleId === "mtp_shadow")?.matched).toBe(3);
  });
});

describe("constraints from summaries", () => {
  const calls = (fields: Array<ToolArgumentSummary["fields"]>) => fields.map((entry) => ({ argsSummary: summary(entry) }) as never);

  it("proposes one_of for few repeated kept values and a padded max for numbers", () => {
    const { conditions, evidence } = constraintsFromSummaries(
      calls([
        { repo: { type: "string", values: ["docs"] }, limit: { type: "number", values: [10] }, draft: { type: "boolean", values: [true] } },
        { repo: { type: "string", values: ["api"] }, limit: { type: "number", values: [41] }, draft: { type: "boolean", values: [true] } },
        { repo: { type: "string", values: ["docs"] }, limit: { type: "number", values: [3] }, draft: { type: "boolean", values: [true] } },
        { repo: { type: "string", values: ["api"] }, limit: { type: "number", values: [7] }, draft: { type: "boolean", values: [true] } }
      ])
    );
    expect(conditions).toEqual([
      { path: "draft", op: "one_of", value: [true] },
      { path: "limit", op: "lte", value: 62 },
      { path: "repo", op: "one_of", value: ["api", "docs"] }
    ]);
    expect(evidence.constraints.find((entry) => entry.path === "limit")).toMatchObject({ observedMax: 41, limit: 62 });
  });

  it("skips hashed values, free text, rare values, absent paths and locations", () => {
    const { conditions, evidence } = constraintsFromSummaries(
      calls([
        { title: { type: "string", hashes: ["h1"] }, body: { type: "string", len: "33-128" }, label: { type: "string", values: ["bug"] }, lat: { type: "number", values: [51.5] } },
        { title: { type: "string", hashes: ["h2"] }, body: { type: "string", len: "33-128" }, label: { type: "string", values: ["docs"] }, lat: { type: "number", values: [51.5] }, extra: { type: "number", values: [1] } }
      ])
    );
    expect(conditions).toEqual([]);
    expect(Object.fromEntries(evidence.skipped.map((entry) => [entry.path, entry.reason]))).toEqual({
      body: "free_text",
      extra: "not_always_present",
      label: "rare_values",
      lat: "location",
      title: "hashed"
    });
  });

  it("proposes nothing when a summary was truncated or missing", () => {
    expect(constraintsFromSummaries([{ argsSummary: { v: 2, fields: {}, truncated: true } } as never]).conditions).toEqual([]);
    expect(constraintsFromSummaries([{ argsSummary: null } as never]).conditions).toEqual([]);
  });

  it("tells calls that reached the server from refused ones", () => {
    expect(callReachedServer({ ok: true, error: null })).toBe(true);
    expect(callReachedServer({ ok: false, error: "upstream 500" })).toBe(true);
    expect(callReachedServer({ ok: false, error: "Tool 'x' was blocked by the guard" })).toBe(false);
    expect(callReachedServer({ ok: false, error: null, rejection: { kind: "rate_limited" } as never })).toBe(false);
    expect(callReachedServer({ ok: true, error: null, policyDecision: { effect: "require_approval", decidedBy: "rule", approval: "pending", matched: [] } })).toBe(false);
    expect(callReachedServer({ ok: true, error: null, policyDecision: { effect: "require_approval", decidedBy: "rule", approval: "approved", matched: [] } })).toBe(true);
  });
});

describe("least-privilege suggestions", () => {
  let clock = NOW;
  const service = (cooldownMs = 0) =>
    new McpPolicySuggestionService({ store: test.store, simulation: new McpPolicySimulationService({ store: test.store, hashKey, now: () => clock }), now: () => clock, cooldownMs });

  beforeEach(async () => {
    clock = NOW;
    await test.store.upsertWorkflow(workflow("wf_notes", "Release notes"));
  });

  async function usage(count: number, overrides: Partial<McpToolCallWrite> = {}) {
    for (let index = 0; index < count; index += 1) {
      await record({
        toolName: index % 2 === 0 ? "create_issue" : "list_issues",
        argsSummary: summary({ repo: { type: "string", values: [index % 4 < 2 ? "docs" : "api"] } }),
        ...overrides
      });
    }
  }

  it("proposes allows for the used tools and a deny for the rest, for non-admin roles only", async () => {
    await usage(20);
    const result = await service().generate({ createdBy: "admin@example.com" });
    expect(result.created).toBe(1);
    const [suggestion] = result.suggestions;
    expect(suggestion).toMatchObject({ scopeKind: "workflow", scopeId: "wf_notes", scopeName: "Release notes", serverId: "mcp_github", status: "open", callCount: 20 });
    expect(suggestion!.rules.map((entry) => [entry.effect, entry.toolPattern])).toEqual([
      ["deny", "*"],
      ["allow", "create_issue"],
      ["allow", "list_issues"]
    ]);
    for (const entry of suggestion!.rules) {
      expect(entry.roles).not.toContain("admin");
      expect(entry.workflowIds).toEqual(["wf_notes"]);
    }
    expect(suggestion!.rules[1]!.conditions).toEqual({ all: [{ path: "repo", op: "one_of", value: ["api", "docs"] }] });

    // Generating again refreshes the same open suggestion.
    const again = await service().generate({ createdBy: "admin@example.com" });
    expect(again).toMatchObject({ created: 0, unchanged: 1 });
    expect(again.suggestions[0]!.id).toBe(suggestion!.id);
  });

  it("needs enough usable calls, and leaves out admin, unknown-role, refused and playground calls", async () => {
    await usage(19);
    await usage(5, { subjectRole: "admin" });
    await usage(5, { subjectRole: null });
    await usage(5, { ok: false, error: "Tool 'x' was blocked by the guard" });
    await usage(5, { source: "playground", workflowId: "" });
    const result = await service().generate({ createdBy: null });
    expect(result.suggestions).toEqual([]);
    expect(result.skipped).toEqual([expect.objectContaining({ scopeId: "wf_notes", reason: "too_few_calls" })]);
    expect((await service().generate({ createdBy: null, minCalls: 5 })).created).toBe(1);
  });

  it("only tightens: never carves an exception out of an existing deny", async () => {
    await test.store.createMcpToolPolicy(rule({ id: "mtp_block", effect: "deny", toolPattern: "create_issue" }));
    await usage(20);
    const result = await service().generate({ createdBy: null });
    expect(result.suggestions).toEqual([]);
    expect(result.skipped).toEqual([expect.objectContaining({ reason: "would_loosen" })]);
  });

  it("does not offer a dismissed proposal again", async () => {
    await usage(20);
    const [first] = (await service().generate({ createdBy: null })).suggestions;
    await test.store.transitionMcpPolicySuggestion(first!.id, { from: "open", to: "dismissed", decidedBy: "admin", decidedAt: NOW.toISOString() });
    const result = await service().generate({ createdBy: null });
    expect(result.suggestions).toEqual([]);
    expect(result.skipped).toEqual([expect.objectContaining({ reason: "dismissed_before" })]);
  });

  it("suggests per gateway client too", async () => {
    await test.store.createMcpClient({
      id: "mcpc_1",
      name: "Desk agent",
      tokenPrefix: "l2m_x",
      tokenHash: "h",
      toolsetIds: [],
      role: "operator",
      createdBy: null,
      createdByEmail: null,
      expiresAt: null
    });
    await usage(20, { source: "gateway", workflowId: "", clientId: "mcpc_1", subjectRole: "operator", subjectSource: "client" });
    const [suggestion] = (await service().generate({ createdBy: null })).suggestions;
    expect(suggestion).toMatchObject({ scopeKind: "client", scopeId: "mcpc_1", scopeName: "Desk agent" });
    expect(suggestion!.rules[0]).toMatchObject({ clientIds: ["mcpc_1"], workflowIds: [] });
  });

  it("is rate limited", async () => {
    const limited = service(30_000);
    await limited.generate({ createdBy: null });
    await expect(limited.generate({ createdBy: null })).rejects.toMatchObject({ statusCode: 429 });
    clock = new Date(NOW.getTime() + 31_000);
    await expect(limited.generate({ createdBy: null })).resolves.toBeTruthy();
    expect(new McpPolicySuggestionError("x", 429)).toBeInstanceOf(Error);
  });
});
