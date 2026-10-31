/**
 * Phase 12.2 — open-world resolution, the resolved value in rule matching, labels on decision records and the
 * simulator's use of recorded labels.
 */
import { describe, expect, it } from "vitest";
import { mcpSafetyPresetRule, type McpToolPolicyRule, type ToolArgumentSummary } from "@ai-orchestrator/shared";
import {
  effectiveToolHints,
  evaluateMcpToolPolicy,
  policyDecisionRecord,
  resolveToolOpenWorld,
  serverOpenWorldDestination
} from "./tool-policy";
import { evaluateRuleOnSummary, type PolicySimulationCall } from "./tool-policy-simulation";

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
    expect(evaluateMcpToolPolicy([rule], { ...base, openWorld: false }).effect).toBe("allow");
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
});
