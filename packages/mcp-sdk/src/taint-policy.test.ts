/**
 * Phase 12.2 — open-world resolution, the resolved value in rule matching, labels on decision records and the
 * simulator's use of recorded labels.
 */
import { describe, expect, it } from "vitest";
import { mcpSafetyPresetRule, type McpToolPolicyRule, type ToolArgumentSummary } from "@ai-orchestrator/shared";
import { untrustedWriteSwitchRule } from "@ai-orchestrator/shared";
import {
  approvalMayCarve,
  decidePolicyOutcome,
  effectiveToolHints,
  evaluateMcpToolPolicy,
  isStrictlyNarrower,
  openWorldRequestFields,
  policyDecisionRecord,
  resolveToolOpenWorld,
  ruleHintMatches,
  serverOpenWorldDestination
} from "./tool-policy";
import { evaluateRuleOnSummary, simulatePolicyTransition, type PolicySimulationCall } from "./tool-policy-simulation";

describe("resolveToolOpenWorld", () => {
  const vendor = { tier: "vendor" as const, matchedBy: "builtin" as const };
  const privateRow = { tier: "private" as const, matchedBy: "row" as const };

  it("lets an admin override decide either way", () => {
    expect(resolveToolOpenWorld({ override: false, destination: vendor, annotations: null })).toEqual({ openWorld: false, source: "manual" });
    expect(resolveToolOpenWorld({ override: true, destination: privateRow, annotations: { openWorldHint: false } })).toEqual({ openWorld: true, source: "manual" });
  });

  it("counts vendor and public servers as open world whatever the hint says", () => {
    expect(resolveToolOpenWorld({ destination: vendor, annotations: { openWorldHint: false } })).toEqual({ openWorld: true, source: "destination" });
    expect(resolveToolOpenWorld({ destination: { tier: "public", matchedBy: "row" }, annotations: { openWorldHint: false } })).toEqual({ openWorld: true, source: "destination" });
  });

  it("fails closed when the destination is unknown or unclassified", () => {
    expect(resolveToolOpenWorld({ destination: null, annotations: { openWorldHint: false } })).toEqual({ openWorld: true, source: "unknown" });
    expect(resolveToolOpenWorld({ destination: undefined, annotations: { openWorldHint: false } })).toEqual({ openWorld: true, source: "unknown" });
    expect(resolveToolOpenWorld({ destination: { tier: "public", matchedBy: "unmatched" }, annotations: { openWorldHint: false } })).toEqual({
      openWorld: true,
      source: "unknown"
    });
  });

  it("falls back to the tool's hint on local and private servers, with the MCP default", () => {
    expect(resolveToolOpenWorld({ destination: privateRow, annotations: { openWorldHint: false } })).toEqual({ openWorld: false, source: "annotation" });
    expect(resolveToolOpenWorld({ destination: { tier: "local", matchedBy: "builtin" }, annotations: null })).toEqual({ openWorld: true, source: "annotation" });
    expect(resolveToolOpenWorld({ destination: "none", annotations: { openWorldHint: false } })).toEqual({ openWorld: false, source: "annotation" });
  });

  it("classifies a server from the host of its endpoint and the destination rows", () => {
    expect(serverOpenWorldDestination({ adapterId: "mock-mcp" }, [])).toBe("none");
    expect(serverOpenWorldDestination({ adapterId: "http_mcp", connection: { endpoint: "http://localhost:8080/mcp" } }, [])).toEqual({ tier: "local", matchedBy: "builtin" });
    expect(serverOpenWorldDestination({ adapterId: "http_mcp", connection: { endpoint: "https://mcp.example.com" } }, [])).toEqual({ tier: "public", matchedBy: "unmatched" });
    expect(serverOpenWorldDestination({ adapterId: "http_mcp" }, [])).toEqual({ tier: "public", matchedBy: "unmatched" });
    // stdio servers are local processes.
    expect(serverOpenWorldDestination({ adapterId: "stdio_mcp" }, [])).toEqual({ tier: "local", matchedBy: "builtin" });
  });
});

describe("the resolved value in rule matching", () => {
  const rule: McpToolPolicyRule = { id: "r", name: null, description: null, effect: "deny", projectId: null, roles: [], serverId: null, toolPattern: "*", annotationHint: "open_world", enabled: true };
  const base = { role: "admin" as const, adapterId: "http_mcp", toolName: "fetch" };

  it("replaces the annotation when given and keeps the old reading when not", () => {
    expect(effectiveToolHints({ openWorldHint: false }, null).openWorld).toBe(false);
    expect(effectiveToolHints({ openWorldHint: false }, null, true).openWorld).toBe(true);
    expect(evaluateMcpToolPolicy([rule], { ...base, annotations: { openWorldHint: false } }).effect).toBe("allow");
    expect(evaluateMcpToolPolicy([rule], { ...base, annotations: { openWorldHint: false }, openWorld: true }).effect).toBe("deny");
    // Without an override, a resolved "not open world" cannot loosen what the annotation decided (missing = open).
    expect(evaluateMcpToolPolicy([rule], { ...base, openWorld: false }).effect).toBe("deny");
    expect(evaluateMcpToolPolicy([rule], { ...base, openWorld: false, openWorldManual: true }).effect).toBe("allow");
  });

  // A tool on an http server no destination row classifies, declaring openWorldHint:false.
  const unmatched = resolveToolOpenWorld({ destination: { tier: "public", matchedBy: "unmatched" }, annotations: { openWorldHint: false } });
  const request = { ...base, annotations: { openWorldHint: false }, ...openWorldRequestFields(unmatched) };

  it("keeps a not_open_world deny or approval matching a tool the resolution made open world", () => {
    const denyInternal: McpToolPolicyRule = { ...rule, id: "internal", annotationHint: "not_open_world" };
    expect(evaluateMcpToolPolicy([denyInternal], { ...base, annotations: { openWorldHint: false } }).effect).toBe("deny");
    expect(evaluateMcpToolPolicy([denyInternal], request).effect).toBe("deny");
    const approveInternal: McpToolPolicyRule = { ...denyInternal, effect: "require_approval" };
    expect(evaluateMcpToolPolicy([approveInternal], request).effect).toBe("require_approval");
    // The resolution tightens open_world rules as before.
    expect(evaluateMcpToolPolicy([rule], request).effect).toBe("deny");
    // An admin's override decides alone.
    const overridden = { ...base, annotations: { openWorldHint: false }, ...openWorldRequestFields(resolveToolOpenWorld({ override: true, destination: null })) };
    expect(evaluateMcpToolPolicy([denyInternal], overridden).effect).toBe("allow");
  });

  it("does not let an open_world allow carve out a tool only the resolution made open world", () => {
    const denyServer: McpToolPolicyRule = { ...rule, id: "server", annotationHint: null, serverId: "http_mcp" };
    const allowOpen: McpToolPolicyRule = { ...rule, id: "carve", effect: "allow", serverId: "http_mcp", annotationHint: "open_world" };
    expect(evaluateMcpToolPolicy([denyServer, allowOpen], { ...base, annotations: { openWorldHint: false } }).effect).toBe("deny");
    expect(evaluateMcpToolPolicy([denyServer, allowOpen], request).effect).toBe("deny");
    // A tool both readings call open world is still carved out.
    expect(evaluateMcpToolPolicy([denyServer, allowOpen], { ...base, annotations: {}, openWorld: true }).effect).toBe("allow");
    // With an override, the allow reads the override.
    expect(evaluateMcpToolPolicy([denyServer, allowOpen], { ...base, annotations: { openWorldHint: false }, openWorld: true, openWorldManual: true }).effect).toBe("allow");
  });

  it("does not let an open_world approval carve a deny for a tool only the resolution made open world", () => {
    const denyServer: McpToolPolicyRule = { ...rule, id: "server", annotationHint: null, serverId: "http_mcp" };
    const approveOpen: McpToolPolicyRule = { ...rule, id: "approve", effect: "require_approval", serverId: "http_mcp", annotationHint: "open_world" };
    // The reviewer's probe: unclassified server, openWorldHint:false. Deny before the branch, deny now.
    expect(evaluateMcpToolPolicy([denyServer, approveOpen], { ...base, annotations: { openWorldHint: false } }).effect).toBe("deny");
    expect(evaluateMcpToolPolicy([denyServer, approveOpen], request).effect).toBe("deny");
    // Alone, the approval still adds its gate on the EITHER reading.
    expect(evaluateMcpToolPolicy([approveOpen], request).effect).toBe("require_approval");
    // When both readings agree, it still carves the deny into an approval; an override decides alone.
    expect(evaluateMcpToolPolicy([denyServer, approveOpen], { ...base, annotations: {}, openWorld: true }).effect).toBe("require_approval");
    expect(evaluateMcpToolPolicy([denyServer, approveOpen], { ...base, annotations: { openWorldHint: false }, openWorld: true, openWorldManual: true }).effect).toBe(
      "require_approval"
    );
    expect(approvalMayCarve(approveOpen, request)).toBe(false);
    expect(approvalMayCarve({ ...approveOpen, annotationHint: "not_read_only" }, request)).toBe(true);
  });

  it("reads the hint per rule effect", () => {
    const input = { annotations: { openWorldHint: false }, openWorld: true };
    expect(ruleHintMatches({ annotationHint: "not_open_world", effect: "deny" }, input)).toBe(true);
    expect(ruleHintMatches({ annotationHint: "not_open_world", effect: "allow" }, input)).toBe(false);
    expect(ruleHintMatches({ annotationHint: "open_world", effect: "allow" }, input)).toBe(false);
    expect(ruleHintMatches({ annotationHint: "open_world", effect: "require_approval" }, input)).toBe(true);
    // Other hints ignore the open-world value.
    expect(ruleHintMatches({ annotationHint: "read_only", effect: "allow" }, { annotations: { readOnlyHint: true }, openWorld: true })).toBe(true);
  });
});

describe("additive rules", () => {
  const writeDeny: McpToolPolicyRule = {
    id: "admin-deny",
    name: "No writes",
    description: null,
    effect: "deny",
    projectId: null,
    roles: [],
    serverId: null,
    toolPattern: "*",
    annotationHint: "not_read_only",
    enabled: true
  };
  const untrustedWrite = {
    role: "builder" as const,
    adapterId: "http_mcp",
    toolName: "push",
    workflowId: "wf1",
    annotations: { readOnlyHint: false },
    arguments: {},
    dataLabels: { provenance: ["untrusted_external"], dataClasses: [] }
  };

  it("never sets aside a deny added after the workflow switch", () => {
    const switchRule = untrustedWriteSwitchRule("wf1");
    expect(switchRule.additive).toBe(true);
    expect(isStrictlyNarrower(switchRule, writeDeny)).toBe(true);
    expect(evaluateMcpToolPolicy([switchRule, writeDeny], untrustedWrite).effect).toBe("deny");
    // The same rule without the flag would carve the deny into "approvable": the flag is what keeps it out.
    expect(evaluateMcpToolPolicy([{ ...switchRule, additive: false }, writeDeny], untrustedWrite).effect).toBe("require_approval");
    // Alone, it still adds its approval.
    expect(evaluateMcpToolPolicy([switchRule], untrustedWrite).effect).toBe("require_approval");
  });

  it("never sets aside a deny added after the global preset is enforced", () => {
    const preset = { ...mcpSafetyPresetRule("untrusted_write_approval"), mode: "enforce" as const };
    const narrowerDeny: McpToolPolicyRule = { ...writeDeny, toolPattern: "push*" };
    expect(evaluateMcpToolPolicy([preset, writeDeny], untrustedWrite).effect).toBe("deny");
    expect(evaluateMcpToolPolicy([preset, narrowerDeny], untrustedWrite).effect).toBe("deny");
    expect(decidePolicyOutcome([preset, writeDeny]).effect).toBe("deny");
  });

  it("is honoured by simulation", () => {
    const switchRule = untrustedWriteSwitchRule("wf1");
    const shadowDeny: McpToolPolicyRule = { ...writeDeny, mode: "shadow" };
    const recorded: PolicySimulationCall = {
      role: "builder",
      projectId: null,
      workflowId: "wf1",
      clientId: null,
      adapterId: "http_mcp",
      toolName: "push",
      annotations: { readOnlyHint: false },
      manualReadOnly: null,
      labels: { provenance: ["untrusted_external"], tracked: false },
      summary: { v: 3, kid: "k", fields: {} } as unknown as ToolArgumentSummary
    };
    // Enforcing the deny after the switch: the simulator reports the call as newly denied, not as approvable.
    const transition = simulatePolicyTransition([switchRule, shadowDeny], [switchRule, { ...shadowDeny, mode: "enforce" }], recorded, {
      hashKey: new Uint8Array(32)
    });
    expect(transition.current.effect).toBe("require_approval");
    expect(transition.draft.effect).toBe("deny");
    // Without the flag the deny would be carved and nothing would change.
    const loose = { ...switchRule, additive: false };
    expect(simulatePolicyTransition([loose, shadowDeny], [loose, { ...shadowDeny, mode: "enforce" }], recorded, { hashKey: new Uint8Array(32) }).draft.effect).toBe(
      "require_approval"
    );
  });
});

describe("labels on the decision record", () => {
  it("records the labels only when some rule matched, and as given", () => {
    const rule = { ...mcpSafetyPresetRule("untrusted_write_approval"), mode: "enforce" as const };
    const request = { role: "admin" as const, adapterId: "http_mcp", toolName: "push", arguments: {}, dataLabels: { provenance: ["untrusted_external"], dataClasses: [] } };
    const labels = { provenance: ["untrusted_external" as const], tracked: false };
    expect(policyDecisionRecord(evaluateMcpToolPolicy([rule], request), undefined, labels)).toMatchObject({ effect: "require_approval", labels });
    expect(policyDecisionRecord(evaluateMcpToolPolicy([], request), undefined, labels)).toBeUndefined();
    expect(policyDecisionRecord(evaluateMcpToolPolicy([rule], request))).not.toHaveProperty("labels");
  });
});

describe("simulation over recorded labels", () => {
  const summary: ToolArgumentSummary = { v: 3, kid: "k", fields: {} } as unknown as ToolArgumentSummary;
  const context = { hashKey: new Uint8Array(32) };
  const call = (labels: PolicySimulationCall["labels"]): PolicySimulationCall => ({
    role: "admin",
    projectId: null,
    workflowId: "wf",
    clientId: null,
    adapterId: "http_mcp",
    toolName: "push",
    annotations: {},
    manualReadOnly: null,
    labels,
    summary
  });
  const untrusted = { ...mcpSafetyPresetRule("untrusted_write_approval"), mode: "enforce" as const };
  const sensitive = { ...mcpSafetyPresetRule("sensitive_no_open_world"), mode: "enforce" as const };
  const byClass: McpToolPolicyRule = { ...sensitive, id: "c", conditions: { all: [{ op: "label_present", value: "email" }] } };

  it("stays undetermined for calls recorded without labels", () => {
    expect(evaluateRuleOnSummary(untrusted, call("unknown"), context)).toMatchObject({ state: "unknown", reason: expect.stringContaining("not recorded") });
  });

  it("decides provenance conditions from the recorded labels", () => {
    expect(evaluateRuleOnSummary(untrusted, call({ provenance: ["untrusted_external"], tracked: false }), context)).toEqual({ state: "match" });
    expect(evaluateRuleOnSummary(untrusted, call({ provenance: ["user"], tracked: false }), context)).toEqual({ state: "no_match" });
  });

  it("decides sensitive and class conditions only for runs that tracked labels", () => {
    expect(evaluateRuleOnSummary(sensitive, call({ provenance: ["user"], tracked: false }), context)).toMatchObject({ state: "unknown", reason: expect.stringContaining("did not track") });
    expect(evaluateRuleOnSummary(byClass, call({ provenance: ["user"], tracked: false }), context).state).toBe("unknown");
    expect(evaluateRuleOnSummary(sensitive, call({ provenance: ["user", "sensitive"], dataClasses: [], tracked: true }), context)).toEqual({ state: "match" });
    expect(evaluateRuleOnSummary(byClass, call({ provenance: ["user"], dataClasses: ["email"], tracked: true }), context)).toEqual({ state: "match" });
    expect(evaluateRuleOnSummary(byClass, call({ provenance: ["user"], dataClasses: [], tracked: true }), context)).toEqual({ state: "no_match" });
  });

  it("reads the resolved open-world value when given", () => {
    const openWorldOnly: McpToolPolicyRule = { ...sensitive, id: "o", conditions: null };
    expect(evaluateRuleOnSummary(openWorldOnly, { ...call("unknown"), annotations: { openWorldHint: false } }, context)).toEqual({ state: "no_match" });
    expect(evaluateRuleOnSummary(openWorldOnly, { ...call("unknown"), annotations: { openWorldHint: false }, openWorld: true }, context)).toEqual({ state: "match" });
  });

  it("reads open world as the evaluator does: without an override it only tightens", () => {
    const denyInternal: McpToolPolicyRule = { ...sensitive, id: "i", annotationHint: "not_open_world", conditions: null };
    const allowOpen: McpToolPolicyRule = { ...denyInternal, id: "a", effect: "allow", annotationHint: "open_world" };
    const resolvedOpen = { ...call("unknown"), annotations: { openWorldHint: false }, openWorld: true };
    expect(evaluateRuleOnSummary(denyInternal, resolvedOpen, context)).toEqual({ state: "match" });
    expect(evaluateRuleOnSummary(allowOpen, resolvedOpen, context)).toEqual({ state: "no_match" });
    expect(evaluateRuleOnSummary(denyInternal, { ...resolvedOpen, openWorldManual: true }, context)).toEqual({ state: "no_match" });
    expect(evaluateRuleOnSummary(allowOpen, { ...resolvedOpen, openWorldManual: true }, context)).toEqual({ state: "match" });
  });

  it("lets an open_world approval carve a deny only when both readings match", () => {
    const denyServer: McpToolPolicyRule = { ...untrusted, id: "deny-server", effect: "deny", annotationHint: null, conditions: null, serverId: "http_mcp", additive: false };
    const approveOpen: McpToolPolicyRule = { ...denyServer, id: "approve-open", effect: "require_approval", annotationHint: "open_world" };
    const shadowDeny: McpToolPolicyRule = { ...denyServer, mode: "shadow" };
    const resolvedOnly = { ...call("unknown"), annotations: { openWorldHint: false }, openWorld: true };
    const enforcing = (recorded: PolicySimulationCall) =>
      simulatePolicyTransition([approveOpen, shadowDeny], [approveOpen, { ...shadowDeny, mode: "enforce" }], recorded, context).draft.effect;
    expect(enforcing(resolvedOnly)).toBe("deny");
    expect(enforcing({ ...call("unknown"), annotations: {}, openWorld: true })).toBe("require_approval");
  });

  it("leaves only open-world hints unknown when the override changed after the call", () => {
    const openWorldOnly: McpToolPolicyRule = { ...sensitive, id: "o", conditions: null };
    const writes: McpToolPolicyRule = { ...untrusted, id: "w", conditions: null };
    const changed = { ...call("unknown"), annotations: { readOnlyHint: false }, openWorld: "unknown" as const };
    expect(evaluateRuleOnSummary(openWorldOnly, changed, context)).toMatchObject({ state: "unknown", reason: expect.stringContaining("override") });
    expect(evaluateRuleOnSummary(writes, changed, context)).toEqual({ state: "match" });
    expect(evaluateRuleOnSummary({ ...writes, annotationHint: "read_only" }, changed, context)).toEqual({ state: "no_match" });
  });

  it("decides a sensitive label recorded as present on an untracked run", () => {
    const absent: McpToolPolicyRule = { ...sensitive, id: "s-absent", conditions: { all: [{ op: "label_absent", value: "sensitive" }] } };
    const recorded = call({ provenance: ["user", "sensitive"], tracked: false });
    expect(evaluateRuleOnSummary(sensitive, recorded, context)).toEqual({ state: "match" });
    expect(evaluateRuleOnSummary(absent, recorded, context)).toEqual({ state: "no_match" });
    // Its absence still needs tracking.
    expect(evaluateRuleOnSummary(absent, call({ provenance: ["user"], tracked: false }), context).state).toBe("unknown");
  });
});
