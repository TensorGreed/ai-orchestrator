import { describe, expect, it } from "vitest";
import {
  emptyMcpPolicySimulationCounts,
  MCP_POLICY_SIMULATION_BUCKETS,
  MCP_POLICY_SIMULATION_MAX_RULES,
  mcpPolicyShadowHitsQuerySchema,
  mcpPolicySimulationRequestSchema,
  mcpPolicySuggestionGenerateSchema
} from "./mcp-policy-simulation";

describe("policy simulation request", () => {
  const rule = { effect: "deny" as const, toolPattern: "delete_*" };

  it("takes either a whole draft rule set or one rule to add", () => {
    expect(mcpPolicySimulationRequestSchema.safeParse({ addRule: rule }).success).toBe(true);
    expect(mcpPolicySimulationRequestSchema.safeParse({ rules: [{ ...rule, id: "mtp_1" }], windowDays: 30 }).success).toBe(true);
    expect(mcpPolicySimulationRequestSchema.safeParse({ rules: [] }).success).toBe(true);
    expect(mcpPolicySimulationRequestSchema.safeParse({}).success).toBe(false);
    expect(mcpPolicySimulationRequestSchema.safeParse({ addRule: rule, rules: [] }).success).toBe(false);
  });

  it("keeps a draft rule's id and defaults the window to 7 days", () => {
    const parsed = mcpPolicySimulationRequestSchema.parse({ rules: [{ ...rule, id: "mtp_1" }] });
    expect(parsed.windowDays).toBe(7);
    expect(parsed.rules?.[0]).toMatchObject({ id: "mtp_1", effect: "deny" });
  });

  it("caps the window, the rule count, the examples and refuses unknown fields", () => {
    expect(mcpPolicySimulationRequestSchema.safeParse({ addRule: rule, windowDays: 14 }).success).toBe(false);
    expect(mcpPolicySimulationRequestSchema.safeParse({ rules: Array.from({ length: MCP_POLICY_SIMULATION_MAX_RULES + 1 }, () => rule) }).success).toBe(false);
    expect(mcpPolicySimulationRequestSchema.safeParse({ addRule: rule, examples: 21 }).success).toBe(false);
    expect(mcpPolicySimulationRequestSchema.safeParse({ addRule: rule, replay: true }).success).toBe(false);
    expect(mcpPolicySimulationRequestSchema.safeParse({ addRule: rule, filters: { arguments: {} } }).success).toBe(false);
  });

  it("validates draft rules like saved ones", () => {
    expect(mcpPolicySimulationRequestSchema.safeParse({ addRule: { effect: "deny", conditions: { all: [{ op: "equals", value: "x" }] } } }).success).toBe(false);
    expect(mcpPolicySimulationRequestSchema.safeParse({ addRule: { effect: "require_approval", kind: "sampling" } }).success).toBe(false);
  });

  it("has a zero count for every bucket", () => {
    expect(Object.keys(emptyMcpPolicySimulationCounts())).toEqual([...MCP_POLICY_SIMULATION_BUCKETS]);
  });

  it("bounds generation and shadow-hit queries", () => {
    expect(mcpPolicySuggestionGenerateSchema.safeParse({ minCalls: 2 }).success).toBe(false);
    expect(mcpPolicySuggestionGenerateSchema.safeParse({}).success).toBe(true);
    expect(mcpPolicyShadowHitsQuerySchema.parse({ days: "7" })).toEqual({ days: 7 });
    expect(mcpPolicyShadowHitsQuerySchema.safeParse({ days: "90" }).success).toBe(false);
  });
});
