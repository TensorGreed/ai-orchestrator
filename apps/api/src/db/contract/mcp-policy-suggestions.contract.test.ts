/**
 * Phase 12.4 — store contract, both stores: the v49 suggestion table (one open suggestion per scope and server,
 * refresh vs change, conditional decisions, decided lookups by fingerprint) and the tool-call window scan (newest
 * first, keyset pages that never skip or repeat a row on equal timestamps, filters).
 */
import { expect, it } from "vitest";
import type { McpPolicySuggestionEvidence, McpPolicySuggestedRule } from "@ai-orchestrator/shared";
import { describeStoreContract } from "../../test-support/test-store.js";
import type { McpToolCallWrite } from "../database.js";
import type { McpPolicySuggestionWrite } from "../store.js";

const T0 = "2026-10-30T10:00:00.000Z";
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

const evidence: McpPolicySuggestionEvidence = { calls: 25, scopeCalls: 30, roles: ["builder"], tools: [], capped: false };
const rules: McpPolicySuggestedRule[] = [
  { name: "deny", description: null, effect: "deny", projectId: null, roles: ["builder"], serverId: "mcp_github", toolPattern: "*", workflowIds: ["wf_1"], clientIds: [], conditions: null, kind: "tool" }
];

function suggestion(overrides: Partial<McpPolicySuggestionWrite> = {}): McpPolicySuggestionWrite {
  return {
    id: "mps_1",
    scopeKind: "workflow",
    scopeId: "wf_1",
    scopeName: "Release notes",
    serverId: "mcp_github",
    serverName: "GitHub",
    fingerprint: "fp-a",
    rules,
    evidence,
    windowDays: 30,
    windowStart: at(-30 * 24 * 60),
    windowEnd: T0,
    callCount: 25,
    createdBy: "admin@example.com",
    now: T0,
    ...overrides
  };
}

function toolCall(id: string, startedAt: string, overrides: Partial<McpToolCallWrite> = {}): McpToolCallWrite {
  return {
    id,
    executionId: `exec_${id}`,
    workflowId: "wf_1",
    nodeId: "agent",
    registryServerId: "mcp_github",
    adapterId: "http_mcp",
    toolName: "create_issue",
    startedAt,
    durationMs: 10,
    ok: true,
    error: null,
    turnInputTokens: null,
    turnOutputTokens: null,
    estimatedCostUsd: null,
    ...overrides
  };
}

describeStoreContract("store contract: MCP policy suggestions and tool-call scans", (ctx) => {
  it("keeps one open suggestion per scope and server, refreshing or replacing it", async () => {
    const store = ctx.store();
    const first = await store.upsertOpenMcpPolicySuggestion(suggestion());
    expect(first.outcome).toBe("created");
    expect(first.suggestion).toMatchObject({
      id: "mps_1",
      status: "open",
      scopeKind: "workflow",
      scopeId: "wf_1",
      serverId: "mcp_github",
      fingerprint: "fp-a",
      rules,
      evidence,
      windowDays: 30,
      windowEnd: T0,
      callCount: 25,
      acceptedRuleIds: [],
      createdBy: "admin@example.com",
      createdAt: T0,
      decidedAt: null
    });

    const refreshed = await store.upsertOpenMcpPolicySuggestion(suggestion({ id: "mps_2", callCount: 31, now: at(5), windowEnd: at(5) }));
    expect(refreshed.outcome).toBe("unchanged");
    expect(refreshed.suggestion).toMatchObject({ id: "mps_1", callCount: 31, createdAt: T0, updatedAt: at(5) });

    const changed = await store.upsertOpenMcpPolicySuggestion(suggestion({ id: "mps_3", fingerprint: "fp-b", now: at(6) }));
    expect(changed.outcome).toBe("updated");
    expect(changed.suggestion).toMatchObject({ id: "mps_1", fingerprint: "fp-b" });

    // Another server or another scope gets its own row.
    expect((await store.upsertOpenMcpPolicySuggestion(suggestion({ id: "mps_4", serverId: "mcp_jira" }))).outcome).toBe("created");
    expect((await store.upsertOpenMcpPolicySuggestion(suggestion({ id: "mps_5", scopeKind: "client", scopeId: "mcpc_1" }))).outcome).toBe("created");
    expect((await store.listMcpPolicySuggestions({ status: "open" })).map((row) => row.id).sort()).toEqual(["mps_1", "mps_4", "mps_5"]);
  });

  it("decides a suggestion once, and opens a new one after a decision", async () => {
    const store = ctx.store();
    await store.upsertOpenMcpPolicySuggestion(suggestion());
    const accepted = await store.transitionMcpPolicySuggestion("mps_1", {
      from: "open",
      to: "accepted",
      decidedBy: "admin@example.com",
      decidedAt: at(1),
      acceptedRuleIds: ["mtp_a", "mtp_b"]
    });
    expect(accepted).toMatchObject({ status: "accepted", decidedBy: "admin@example.com", decidedAt: at(1), acceptedRuleIds: ["mtp_a", "mtp_b"] });
    expect(await store.transitionMcpPolicySuggestion("mps_1", { from: "open", to: "dismissed", decidedBy: "x", decidedAt: at(2) })).toBeNull();
    expect((await store.getMcpPolicySuggestion("mps_1"))?.status).toBe("accepted");

    // A later generation opens a fresh suggestion for the same scope and server.
    const next = await store.upsertOpenMcpPolicySuggestion(suggestion({ id: "mps_9", now: at(3) }));
    expect(next.outcome).toBe("created");
    const decided = await store.listDecidedMcpPolicySuggestions({ scopeKind: "workflow", scopeId: "wf_1", serverId: "mcp_github", fingerprint: "fp-a" });
    expect(decided.map((row) => row.id)).toEqual(["mps_1"]);
    expect(await store.listDecidedMcpPolicySuggestions({ scopeKind: "workflow", scopeId: "wf_1", serverId: "mcp_github", fingerprint: "fp-z" })).toEqual([]);
    expect(await store.getMcpPolicySuggestion("nope")).toBeNull();
    // A dismissal keeps the accepted rule ids it had (none here) when none are given.
    const dismissed = await store.transitionMcpPolicySuggestion("mps_9", { from: "open", to: "dismissed", decidedBy: "admin@example.com", decidedAt: at(4) });
    expect(dismissed).toMatchObject({ status: "dismissed", acceptedRuleIds: [] });
  });

  it("scans a window newest first in keyset pages, with filters", async () => {
    const store = ctx.store();
    // Three rows share a timestamp: the id breaks the tie, so pages neither skip nor repeat.
    await store.insertMcpToolCall(toolCall("mtc_a", at(1)));
    await store.insertMcpToolCall(toolCall("mtc_b", at(2)));
    await store.insertMcpToolCall(toolCall("mtc_c", at(2)));
    await store.insertMcpToolCall(toolCall("mtc_d", at(2), { toolName: "delete_repo" }));
    await store.insertMcpToolCall(toolCall("mtc_e", at(3), { source: "gateway", workflowId: "", clientId: "mcpc_1" }));
    await store.insertMcpToolCall(toolCall("mtc_f", at(4), { source: "playground", workflowId: "" }));
    await store.insertMcpToolCall(toolCall("mtc_g", at(5), { source: "gateway", adapterId: "gateway_workflow", registryServerId: null, clientId: "mcpc_1" }));
    await store.insertMcpToolCall(toolCall("mtc_h", at(-10)));
    await store.insertMcpToolCall(
      toolCall("mtc_i", at(6), { registryServerId: null, adapterId: "mock-mcp", policyDecision: { effect: "allow", decidedBy: "rule", matched: [{ ruleId: "r", mode: "shadow", effect: "deny" }] } })
    );

    const base = { since: T0, until: at(60), sources: ["workflow", "gateway"] as const };
    const all: string[] = [];
    let before: { startedAt: string; id: string } | null = null;
    for (let page = 0; page < 10; page += 1) {
      const rows = await store.scanMcpToolCalls({ ...base, sources: [...base.sources], limit: 2, before });
      if (rows.length === 0) break;
      all.push(...rows.map((row) => row.id));
      const last = rows[rows.length - 1]!;
      before = { startedAt: last.startedAt, id: last.id };
    }
    expect(all).toEqual(["mtc_i", "mtc_g", "mtc_e", "mtc_d", "mtc_c", "mtc_b", "mtc_a"]);

    const scan = async (extra: Record<string, unknown>) =>
      (await store.scanMcpToolCalls({ ...base, sources: [...base.sources], limit: 100, ...extra })).map((row) => row.id);
    expect(await scan({ excludeAdapterId: "gateway_workflow" })).toEqual(["mtc_i", "mtc_e", "mtc_d", "mtc_c", "mtc_b", "mtc_a"]);
    expect(await scan({ clientId: "mcpc_1" })).toEqual(["mtc_g", "mtc_e"]);
    expect(await scan({ workflowId: "wf_1", toolName: "delete_repo" })).toEqual(["mtc_d"]);
    expect(await scan({ serverId: "mock-mcp" })).toEqual(["mtc_i"]);
    expect(await scan({ serverId: "mcp_github", sources: ["workflow"] })).toEqual(["mtc_d", "mtc_c", "mtc_b", "mtc_a"]);
    expect(await scan({ withPolicyDecision: true })).toEqual(["mtc_i"]);
    expect(await scan({ sources: ["playground"] })).toEqual(["mtc_f"]);
    expect(await scan({ until: at(2) })).toEqual(["mtc_a"]);
    const row = (await store.scanMcpToolCalls({ ...base, sources: [...base.sources], limit: 1 }))[0]!;
    expect(row.policyDecision).toMatchObject({ matched: [{ ruleId: "r", mode: "shadow" }] });
  });
});
