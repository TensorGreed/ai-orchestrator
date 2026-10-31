import { describe, expect, it } from "vitest";
import { canonicalMcpToolPolicyRule, parseMcpPolicyPath } from "./mcp-tool-policy";
import { mcpToolPolicyRuleInputSchema, mcpToolPolicyRuleUpdateSchema } from "./schemas";
import type { McpToolPolicyRule } from "./types";

function rule(partial: Partial<McpToolPolicyRule> = {}): McpToolPolicyRule {
  return {
    id: "r1",
    name: null,
    description: null,
    effect: "deny",
    projectId: null,
    roles: [],
    serverId: null,
    toolPattern: "*",
    enabled: true,
    ...partial
  };
}

describe("parseMcpPolicyPath", () => {
  it("parses keys, indexes and any-element steps", () => {
    expect(parseMcpPolicyPath("repo")).toEqual([{ key: "repo" }]);
    expect(parseMcpPolicyPath("owner.login")).toEqual([{ key: "owner" }, { key: "login" }]);
    expect(parseMcpPolicyPath("items[*].id")).toEqual([{ key: "items" }, { any: true }, { key: "id" }]);
    expect(parseMcpPolicyPath("matrix[0][*]")).toEqual([{ key: "matrix" }, { index: 0 }, { any: true }]);
  });

  it("refuses malformed paths", () => {
    for (const bad of ["", ".repo", "repo.", "a..b", "[0]", "items[x]", "items[*", "a b", "a.b c", "x".repeat(201)]) {
      expect(parseMcpPolicyPath(bad), bad).toBeNull();
    }
    expect(parseMcpPolicyPath(Array.from({ length: 17 }, () => "a").join("."))).toBeNull();
  });
});

describe("mcpToolPolicyRuleInputSchema", () => {
  it("accepts conditions, modes, principals and require_approval", () => {
    const parsed = mcpToolPolicyRuleInputSchema.safeParse({
      effect: "require_approval",
      mode: "shadow",
      workflowIds: ["wf-1"],
      clientIds: ["mcpc_1"],
      conditions: {
        all: [
          { path: "repo", op: "one_of", value: ["acme/api", "acme/web"] },
          { path: "items[*].qty", op: "between", value: [1, 10] },
          { path: "force", op: "exists", value: false },
          { op: "label_present", value: "pii_email" }
        ]
      }
    });
    expect(parsed.success).toBe(true);
  });

  it("keeps old payloads valid", () => {
    expect(mcpToolPolicyRuleInputSchema.safeParse({ effect: "deny", toolPattern: "delete_*" }).success).toBe(true);
  });

  it("reports field-level errors", () => {
    const parsed = mcpToolPolicyRuleInputSchema.safeParse({
      effect: "deny",
      conditions: {
        any: [
          { path: "a b", op: "equals", value: 1 },
          { path: "n", op: "gt", value: "5" },
          { path: "n", op: "between", value: [5, 1] },
          { path: "x", op: "label_present", value: "pii" },
          { op: "one_of", value: [] }
        ]
      }
    });
    expect(parsed.success).toBe(false);
    const paths = parsed.error!.issues.map((issue) => issue.path.join("."));
    expect(paths).toEqual(
      expect.arrayContaining(["conditions.any.0.path", "conditions.any.1.value", "conditions.any.2.value", "conditions.any.3.path", "conditions.any.4.path", "conditions.any.4.value"])
    );
  });

  it("caps conditions, list values and value length", () => {
    const many = Array.from({ length: 21 }, () => ({ path: "a", op: "exists" as const }));
    expect(mcpToolPolicyRuleInputSchema.safeParse({ effect: "deny", conditions: { all: many } }).success).toBe(false);
    const longList = Array.from({ length: 101 }, (_, index) => `v${index}`);
    expect(mcpToolPolicyRuleInputSchema.safeParse({ effect: "deny", conditions: { all: [{ path: "a", op: "one_of", value: longList }] } }).success).toBe(false);
    expect(
      mcpToolPolicyRuleInputSchema.safeParse({ effect: "deny", conditions: { all: [{ path: "a", op: "equals", value: "x".repeat(501) }] } }).success
    ).toBe(false);
    expect(mcpToolPolicyRuleInputSchema.safeParse({ effect: "deny", clientIds: Array.from({ length: 101 }, (_, i) => `c${i}`) }).success).toBe(false);
  });

  it("takes ignoreCase on text operators only and caps glob wildcards", () => {
    const parse = (condition: Record<string, unknown>) => mcpToolPolicyRuleInputSchema.safeParse({ effect: "deny", conditions: { all: [condition] } });
    expect(parse({ path: "env", op: "one_of", value: ["prod"], ignoreCase: true }).success).toBe(true);
    const numeric = parse({ path: "n", op: "gt", value: 1, ignoreCase: true });
    expect(numeric.success).toBe(false);
    expect(numeric.error!.issues[0].path).toEqual(["conditions", "all", 0, "ignoreCase"]);
    expect(parse({ path: "repo", op: "matches", value: "*".repeat(16) }).success).toBe(true);
    expect(parse({ path: "repo", op: "matches", value: "*a".repeat(17) }).success).toBe(false);
  });

  it("limits approval and conditions to tool rules", () => {
    const approval = mcpToolPolicyRuleInputSchema.safeParse({ effect: "require_approval", kind: "resource" });
    expect(approval.success).toBe(false);
    expect(approval.error!.issues[0].path).toEqual(["effect"]);
    const conditions = mcpToolPolicyRuleInputSchema.safeParse({ effect: "deny", kind: "sampling", conditions: { all: [{ op: "label_present", value: "pii" }] } });
    expect(conditions.success).toBe(false);
    expect(conditions.error!.issues[0].path).toEqual(["conditions"]);
  });

  it("accepts partial updates with the new fields", () => {
    expect(mcpToolPolicyRuleUpdateSchema.safeParse({ mode: "enforce" }).success).toBe(true);
    expect(mcpToolPolicyRuleUpdateSchema.safeParse({ conditions: null }).success).toBe(true);
    expect(mcpToolPolicyRuleUpdateSchema.safeParse({}).success).toBe(false);
  });
});

describe("canonicalMcpToolPolicyRule", () => {
  it("ignores name, mode, enabled and ordering", () => {
    const a = rule({
      roles: ["viewer", "builder"],
      clientIds: ["c2", "c1"],
      conditions: {
        all: [
          { path: "repo", op: "one_of", value: ["b", "a", "a"] },
          { path: "n", op: "gt", value: 3 }
        ]
      }
    });
    const b = rule({
      id: "other",
      name: "Renamed",
      mode: "shadow",
      enabled: false,
      roles: ["builder", "viewer"],
      clientIds: ["c1", "c2"],
      conditions: {
        all: [
          { path: "n", op: "gt", value: 3 },
          { path: "repo", op: "one_of", value: ["a", "b"] }
        ]
      }
    });
    expect(canonicalMcpToolPolicyRule(a)).toBe(canonicalMcpToolPolicyRule(b));
  });

  it("changes with what the rule governs", () => {
    const base = canonicalMcpToolPolicyRule(rule());
    expect(canonicalMcpToolPolicyRule(rule({ effect: "allow" }))).not.toBe(base);
    expect(canonicalMcpToolPolicyRule(rule({ workflowIds: ["wf"] }))).not.toBe(base);
    // Phase 12.2 — an additive rule decides differently; a rule without the flag keeps its old hash.
    expect(canonicalMcpToolPolicyRule(rule({ additive: true }))).not.toBe(base);
    expect(canonicalMcpToolPolicyRule(rule({ additive: false }))).toBe(base);
    expect(canonicalMcpToolPolicyRule(rule({ conditions: { all: [{ path: "a", op: "exists" }] } }))).not.toBe(base);
    const all = rule({ conditions: { all: [{ path: "a", op: "exists" }, { path: "b", op: "exists" }] } });
    const any = rule({ conditions: { any: [{ path: "a", op: "exists" }, { path: "b", op: "exists" }] } });
    expect(canonicalMcpToolPolicyRule(all)).not.toBe(canonicalMcpToolPolicyRule(any));
    const exact = rule({ conditions: { all: [{ path: "env", op: "equals", value: "prod" }] } });
    const folded = rule({ conditions: { all: [{ path: "env", op: "equals", value: "prod", ignoreCase: true }] } });
    expect(canonicalMcpToolPolicyRule(folded)).not.toBe(canonicalMcpToolPolicyRule(exact));
    expect(canonicalMcpToolPolicyRule(rule({ conditions: { all: [{ path: "env", op: "equals", value: "prod", ignoreCase: false }] } }))).toBe(
      canonicalMcpToolPolicyRule(exact)
    );
    // One condition combines the same either way.
    expect(canonicalMcpToolPolicyRule(rule({ conditions: { any: [{ path: "a", op: "exists" }] } }))).toBe(
      canonicalMcpToolPolicyRule(rule({ conditions: { all: [{ path: "a", op: "exists" }] } }))
    );
  });
});
