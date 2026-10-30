/**
 * Phase 12.4 — store contract, both stores: the v47 rule columns (conditions, mode, workflow and client
 * principals), the per-call policy decision on tool-call rows, and gateway approvals (one pending request per
 * identical call, decide once, use once inside the window, expiry, retention).
 */
import { expect, it } from "vitest";
import type { McpToolPolicyDecisionRecord } from "@ai-orchestrator/shared";
import { describeStoreContract } from "../../test-support/test-store.js";
import type { McpGatewayApprovalCreate } from "../store.js";

const T0 = "2026-10-30T10:00:00.000Z";
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

function approvalInput(id: string, overrides: Partial<McpGatewayApprovalCreate> = {}): McpGatewayApprovalCreate {
  return {
    id,
    clientId: "mcpc_1",
    clientName: "CI bot",
    toolsetId: "mts_1",
    projectId: "default",
    serverId: "mcp_github",
    serverName: "GitHub",
    toolName: "push",
    gatewayToolName: "github__push",
    argsHash: "hash-a",
    argsPreview: '{"repo":"acme/prod"}',
    ruleId: "mtp_1",
    ruleName: "Prod pushes",
    message: "needs approval",
    requestedAt: T0,
    expiresAt: at(60),
    ...overrides
  };
}

describeStoreContract("store contract: argument-aware MCP tool rules", (ctx) => {
  it("stores conditions, mode and principals on a rule, defaults old-style rules, and updates them", async () => {
    const store = ctx.store();
    const plain = await store.createMcpToolPolicy({
      id: "mtp_plain",
      name: null,
      description: null,
      effect: "deny",
      projectId: null,
      roles: [],
      serverId: null,
      toolPattern: "*",
      enabled: true
    });
    expect(plain).toMatchObject({ mode: "enforce", conditions: null, workflowIds: [], clientIds: [] });

    const conditions = { any: [{ path: "repo", op: "one_of" as const, value: ["acme/prod", "acme/infra"] }, { op: "label_present" as const, value: "email" }] };
    const rich = await store.createMcpToolPolicy({
      id: "mtp_rich",
      name: "Prod",
      description: null,
      effect: "require_approval",
      projectId: null,
      roles: ["builder"],
      serverId: null,
      toolPattern: "push",
      conditions,
      mode: "shadow",
      workflowIds: ["wf-1"],
      clientIds: ["mcpc_1", "mcpc_2"],
      enabled: true
    });
    expect(rich).toMatchObject({ effect: "require_approval", conditions, mode: "shadow", workflowIds: ["wf-1"], clientIds: ["mcpc_1", "mcpc_2"] });

    const updated = await store.updateMcpToolPolicy("mtp_rich", { mode: "enforce", conditions: null, clientIds: [] });
    expect(updated).toMatchObject({ mode: "enforce", conditions: null, clientIds: [], workflowIds: ["wf-1"] });
    expect((await store.listMcpToolPolicies()).map((rule) => [rule.id, rule.mode])).toEqual([
      ["mtp_plain", "enforce"],
      ["mtp_rich", "enforce"]
    ]);
  });

  it("records a call's policy decision, and none when no rule matched", async () => {
    const store = ctx.store();
    const decision: McpToolPolicyDecisionRecord = {
      effect: "allow",
      decidedBy: "default",
      matched: [{ ruleId: "mtp_s", mode: "shadow", effect: "deny" }],
      shadow: { effect: "deny", ruleId: "mtp_s", changed: true }
    };
    const base = {
      executionId: "exec-1",
      workflowId: "wf",
      nodeId: "agent",
      registryServerId: null,
      adapterId: "mock-mcp",
      toolName: "push",
      startedAt: T0,
      durationMs: 5,
      ok: true,
      error: null,
      turnInputTokens: null,
      turnOutputTokens: null,
      estimatedCostUsd: null
    };
    await store.replaceMcpToolCallsForExecution("exec-1", [
      { ...base, id: "mtc_1", policyDecision: decision },
      { ...base, id: "mtc_2" }
    ]);
    await store.insertMcpToolCall({ ...base, id: "mtc_3", executionId: "gw-1", source: "gateway", clientId: "mcpc_1", policyDecision: { ...decision, effect: "require_approval", approval: "approved" } });
    const rows = [...(await store.listMcpToolCalls({ registryServerId: null, since: at(-1) })), ...(await store.listMcpToolCallsForClient("mcpc_1", at(-1)))];
    const byId = new Map(rows.map((row) => [row.id, row.policyDecision]));
    expect(byId.get("mtc_1")).toEqual(decision);
    expect(byId.get("mtc_2")).toBeNull();
    expect(byId.get("mtc_3")).toMatchObject({ effect: "require_approval", approval: "approved" });
  });

  it("gateway approvals: one pending request per identical call, decided once, used once inside the window", async () => {
    const store = ctx.store();
    const first = await store.createMcpGatewayApproval(approvalInput("mga_1"), T0);
    expect(first.created).toBe(true);
    expect(first.approval).toMatchObject({ id: "mga_1", status: "pending", argsHash: "hash-a", decidedBy: null, usedAt: null });
    // The identical call again: the same pending request.
    const again = await store.createMcpGatewayApproval(approvalInput("mga_2"), at(1));
    expect(again).toMatchObject({ created: false, approval: { id: "mga_1" } });
    // Other arguments: a request of their own.
    expect((await store.createMcpGatewayApproval(approvalInput("mga_3", { argsHash: "hash-b" }), at(1))).created).toBe(true);

    const key = { clientId: "mcpc_1", serverId: "mcp_github", toolName: "push", argsHash: "hash-a" };
    expect(await store.findUsableMcpGatewayApproval(key, at(2))).toBeNull();
    const decision = { status: "approved" as const, decidedBy: "admin@example.com", decidedAt: at(2), reason: null, expiresAt: at(17) };
    expect(await store.decideMcpGatewayApproval("mga_1", decision, at(2))).toBe(true);
    expect(await store.decideMcpGatewayApproval("mga_1", { ...decision, status: "rejected" }, at(2))).toBe(false);
    const usable = await store.findUsableMcpGatewayApproval(key, at(3));
    expect(usable).toMatchObject({ id: "mga_1", status: "approved", decidedBy: "admin@example.com", expiresAt: at(17) });
    // Another client's identical call is not covered.
    expect(await store.findUsableMcpGatewayApproval({ ...key, clientId: "mcpc_2" }, at(3))).toBeNull();

    expect(await store.consumeMcpGatewayApproval("mga_1", at(4))).toBe(true);
    expect(await store.consumeMcpGatewayApproval("mga_1", at(4))).toBe(false);
    expect(await store.findUsableMcpGatewayApproval(key, at(4))).toBeNull();
    expect(await store.getMcpGatewayApproval("mga_1")).toMatchObject({ status: "used", usedAt: at(4) });
    // Once used, the identical call asks again.
    expect((await store.createMcpGatewayApproval(approvalInput("mga_4"), at(5))).created).toBe(true);
  });

  it("gateway approvals: an approval past its window cannot be used, and a pending request expires", async () => {
    const store = ctx.store();
    await store.createMcpGatewayApproval(approvalInput("mga_w", { expiresAt: at(60) }), T0);
    await store.decideMcpGatewayApproval("mga_w", { status: "approved", decidedBy: "a", decidedAt: at(1), reason: null, expiresAt: at(16) }, at(1));
    const key = { clientId: "mcpc_1", serverId: "mcp_github", toolName: "push", argsHash: "hash-a" };
    expect(await store.findUsableMcpGatewayApproval(key, at(16))).toBeNull();
    expect(await store.consumeMcpGatewayApproval("mga_w", at(16))).toBe(false);

    await store.createMcpGatewayApproval(approvalInput("mga_p", { argsHash: "hash-p", expiresAt: at(10) }), T0);
    // Past its expiry it can no longer be decided, and listing marks it expired.
    expect(await store.decideMcpGatewayApproval("mga_p", { status: "approved", decidedBy: "a", decidedAt: at(11), reason: null, expiresAt: at(26) }, at(11))).toBe(false);
    const listed = await store.listMcpGatewayApprovals({}, at(11));
    expect(listed.find((entry) => entry.id === "mga_p")?.status).toBe("expired");
    expect((await store.listMcpGatewayApprovals({ status: "pending" }, at(11))).map((entry) => entry.id)).toEqual([]);
    // An expired request does not block a new one for the same call.
    expect((await store.createMcpGatewayApproval(approvalInput("mga_p2", { argsHash: "hash-p", requestedAt: at(12), expiresAt: at(70) }), at(12))).created).toBe(true);
    expect((await store.listMcpGatewayApprovals({ status: "pending" }, at(12))).map((entry) => entry.id)).toEqual(["mga_p2"]);
  });

  it("gateway approvals: a rejection blocks the identical call until its expiry, and the first refusal is marked once", async () => {
    const store = ctx.store();
    await store.createMcpGatewayApproval(approvalInput("mga_r"), T0);
    const key = { clientId: "mcpc_1", serverId: "mcp_github", toolName: "push", argsHash: "hash-a" };
    expect(await store.findBlockingMcpGatewayRejection(key, at(1))).toBeNull();
    expect(await store.decideMcpGatewayApproval("mga_r", { status: "rejected", decidedBy: "a", decidedAt: at(2), reason: "No", expiresAt: at(17) }, at(2))).toBe(true);
    const first = await store.findBlockingMcpGatewayRejection(key, at(3));
    expect(first).toMatchObject({ firstRefusal: true, approval: { id: "mga_r", status: "rejected", decisionReason: "No", expiresAt: at(17), usedAt: at(3) } });
    expect(await store.findBlockingMcpGatewayRejection(key, at(4))).toMatchObject({ firstRefusal: false, approval: { id: "mga_r" } });
    expect(await store.findBlockingMcpGatewayRejection({ ...key, argsHash: "hash-b" }, at(4))).toBeNull();
    expect(await store.findBlockingMcpGatewayRejection({ ...key, clientId: "mcpc_2" }, at(4))).toBeNull();
    expect(await store.findBlockingMcpGatewayRejection(key, at(17))).toBeNull();
  });

  it("gateway approvals: a consumed approval can be put back, once", async () => {
    const store = ctx.store();
    await store.createMcpGatewayApproval(approvalInput("mga_b"), T0);
    await store.decideMcpGatewayApproval("mga_b", { status: "approved", decidedBy: "a", decidedAt: at(1), reason: null, expiresAt: at(16) }, at(1));
    expect(await store.restoreMcpGatewayApproval("mga_b")).toBe(false);
    expect(await store.consumeMcpGatewayApproval("mga_b", at(2))).toBe(true);
    expect(await store.restoreMcpGatewayApproval("mga_b")).toBe(true);
    expect(await store.getMcpGatewayApproval("mga_b")).toMatchObject({ status: "approved", usedAt: null, expiresAt: at(16) });
    expect(await store.restoreMcpGatewayApproval("mga_b")).toBe(false);
    expect(await store.consumeMcpGatewayApproval("mga_b", at(3))).toBe(true);
  });

  it("gateway approvals: a client's pending requests are capped; the identical call still gets its request back", async () => {
    const store = ctx.store();
    const cap = { maxPendingPerClient: 2 };
    expect((await store.createMcpGatewayApproval(approvalInput("mga_c1", { argsHash: "h1" }), T0, cap)).created).toBe(true);
    expect((await store.createMcpGatewayApproval(approvalInput("mga_c2", { argsHash: "h2" }), T0, cap)).created).toBe(true);
    expect(await store.createMcpGatewayApproval(approvalInput("mga_c3", { argsHash: "h3" }), T0, cap)).toEqual({ approval: null, created: false, capped: true });
    expect(await store.createMcpGatewayApproval(approvalInput("mga_c4", { argsHash: "h1" }), T0, cap)).toMatchObject({ created: false, approval: { id: "mga_c1" } });
    // Another client has its own budget.
    expect((await store.createMcpGatewayApproval(approvalInput("mga_c5", { clientId: "mcpc_2", argsHash: "h3" }), T0, cap)).created).toBe(true);
    // A decided request frees a slot.
    await store.decideMcpGatewayApproval("mga_c2", { status: "rejected", decidedBy: "a", decidedAt: at(1), reason: null, expiresAt: at(16) }, at(1));
    expect((await store.createMcpGatewayApproval(approvalInput("mga_c6", { argsHash: "h3" }), at(1), cap)).created).toBe(true);
  });

  it("gateway approvals: decided requests are deleted 30 days after they were asked for, whatever the history retention", async () => {
    const store = ctx.store();
    const old = "2026-09-01T00:00:00.000Z";
    const oldAt = (minutes: number) => new Date(Date.parse(old) + minutes * 60_000).toISOString();
    await store.createMcpGatewayApproval(approvalInput("mga_d1", { requestedAt: old, expiresAt: oldAt(60) }), old);
    await store.decideMcpGatewayApproval("mga_d1", { status: "rejected", decidedBy: "a", decidedAt: oldAt(1), reason: null, expiresAt: oldAt(16) }, oldAt(1));
    // Never decided: it expires, then goes the same way.
    await store.createMcpGatewayApproval(approvalInput("mga_d2", { argsHash: "h2", requestedAt: old, expiresAt: oldAt(60) }), old);
    await store.createMcpGatewayApproval(approvalInput("mga_d3", { argsHash: "h3", requestedAt: at(-60), expiresAt: at(-30) }), at(-60));
    const listed = await store.listMcpGatewayApprovals({}, T0);
    expect(listed.map((entry) => entry.id)).toEqual(["mga_d3"]);
    expect(await store.getMcpGatewayApproval("mga_d1")).toBeNull();
    expect(await store.getMcpGatewayApproval("mga_d2")).toBeNull();
  });

  it("gateway approvals follow the execution-history retention", async () => {
    const store = ctx.store();
    await store.createMcpGatewayApproval(approvalInput("mga_old", { requestedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-01T01:00:00.000Z" }), "2026-01-01T00:00:00.000Z");
    await store.createMcpGatewayApproval(approvalInput("mga_new", { argsHash: "hash-n" }), T0);
    await store.pruneExecutionHistory({ before: "2026-06-01T00:00:00.000Z" });
    expect(await store.getMcpGatewayApproval("mga_old")).toBeNull();
    expect(await store.getMcpGatewayApproval("mga_new")).not.toBeNull();
  });
});
