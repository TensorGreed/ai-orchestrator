/**
 * Phase 12.4 — argument-aware tool policy rules: every condition operator,
 * paths, types, principals, precedence, carve-outs, discovery and shadow mode.
 */
import { describe, expect, it } from "vitest";
import type { McpPolicyCondition, McpToolPolicyRule } from "@ai-orchestrator/shared";
import {
  describePolicyConditions,
  evaluateMcpToolAccess,
  evaluateMcpToolPolicy,
  evaluatePolicyCondition,
  hashMcpToolPolicyRule,
  isStrictlyNarrower,
  matchesValueGlob,
  policyDecisionRecord,
  policyNeedsArguments,
  resolvePolicyPath,
  type McpToolPolicyRequest
} from "./tool-policy";

function rule(partial: Partial<McpToolPolicyRule> & Pick<McpToolPolicyRule, "id" | "effect">): McpToolPolicyRule {
  return { name: null, description: null, projectId: null, roles: [], serverId: null, toolPattern: "*", enabled: true, ...partial };
}

const request = (partial: Partial<McpToolPolicyRequest> = {}): McpToolPolicyRequest => ({
  projectId: "default",
  role: "builder",
  adapterId: "http_mcp",
  registryServerId: "mcp_github",
  toolName: "create_issue",
  arguments: {},
  ...partial
});

const args = {
  repo: "acme/api",
  owner: { login: "octo", id: 7 },
  title: "Fix the build",
  count: 5,
  draft: false,
  nothing: null,
  labels: ["bug", "p1"],
  items: [
    { id: "a", qty: 2 },
    { id: "b", qty: 40 }
  ],
  matrix: [
    [1, 2],
    [3, 4]
  ]
};

const holds = (condition: McpPolicyCondition, input: Record<string, unknown> = args, labels?: McpToolPolicyRequest["dataLabels"]) =>
  evaluatePolicyCondition(condition, input, labels);

describe("resolvePolicyPath", () => {
  it("reads keys, indexes and any-element steps", () => {
    expect(resolvePolicyPath(args, "repo")).toEqual(["acme/api"]);
    expect(resolvePolicyPath(args, "owner.login")).toEqual(["octo"]);
    expect(resolvePolicyPath(args, "labels[1]")).toEqual(["p1"]);
    expect(resolvePolicyPath(args, "items[*].id")).toEqual(["a", "b"]);
    expect(resolvePolicyPath(args, "matrix[1][*]")).toEqual([3, 4]);
    expect(resolvePolicyPath(args, "nothing")).toEqual([null]);
  });

  it("returns nothing for unknown paths, wrong shapes and bad syntax", () => {
    expect(resolvePolicyPath(args, "missing")).toEqual([]);
    expect(resolvePolicyPath(args, "repo.name")).toEqual([]);
    expect(resolvePolicyPath(args, "labels[9]")).toEqual([]);
    expect(resolvePolicyPath(args, "owner[*]")).toEqual([]);
    expect(resolvePolicyPath(args, "items..id")).toEqual([]);
    // Inherited properties are not arguments.
    expect(resolvePolicyPath(args, "constructor")).toEqual([]);
  });
});

describe("evaluatePolicyCondition", () => {
  it("equals compares scalars strictly", () => {
    expect(holds({ path: "repo", op: "equals", value: "acme/api" })).toBe(true);
    expect(holds({ path: "count", op: "equals", value: 5 })).toBe(true);
    expect(holds({ path: "count", op: "equals", value: "5" })).toBe(false);
    expect(holds({ path: "draft", op: "equals", value: false })).toBe(true);
    expect(holds({ path: "nothing", op: "equals", value: null })).toBe(true);
    expect(holds({ path: "owner", op: "equals", value: "octo" })).toBe(false);
  });

  it("one_of and not_one_of need a scalar at the path", () => {
    expect(holds({ path: "repo", op: "one_of", value: ["acme/web", "acme/api"] })).toBe(true);
    expect(holds({ path: "repo", op: "one_of", value: ["acme/web"] })).toBe(false);
    expect(holds({ path: "repo", op: "not_one_of", value: ["acme/web"] })).toBe(true);
    expect(holds({ path: "repo", op: "not_one_of", value: ["acme/api"] })).toBe(false);
    // Unknown path and wrong type: false for both.
    expect(holds({ path: "missing", op: "not_one_of", value: ["x"] })).toBe(false);
    expect(holds({ path: "owner", op: "not_one_of", value: ["x"] })).toBe(false);
  });

  it("starts_with, ends_with and matches read strings only", () => {
    expect(holds({ path: "repo", op: "starts_with", value: "acme/" })).toBe(true);
    expect(holds({ path: "repo", op: "ends_with", value: "/api" })).toBe(true);
    expect(holds({ path: "repo", op: "starts_with", value: "other/" })).toBe(false);
    expect(holds({ path: "count", op: "starts_with", value: "5" })).toBe(false);
    expect(holds({ path: "repo", op: "matches", value: "acme/*" })).toBe(true);
    expect(holds({ path: "repo", op: "matches", value: "acme/ap?" })).toBe(true);
    expect(holds({ path: "repo", op: "matches", value: "acme.api" })).toBe(false);
  });

  it("number operators read finite numbers only", () => {
    expect(holds({ path: "count", op: "lt", value: 6 })).toBe(true);
    expect(holds({ path: "count", op: "lt", value: 5 })).toBe(false);
    expect(holds({ path: "count", op: "lte", value: 5 })).toBe(true);
    expect(holds({ path: "count", op: "gt", value: 4 })).toBe(true);
    expect(holds({ path: "count", op: "gte", value: 6 })).toBe(false);
    expect(holds({ path: "count", op: "between", value: [5, 10] })).toBe(true);
    expect(holds({ path: "count", op: "between", value: [6, 10] })).toBe(false);
    expect(holds({ path: "repo", op: "gt", value: 0 })).toBe(false);
    expect(holds({ path: "count", op: "gt", value: "1" as unknown as number })).toBe(false);
  });

  it("exists treats null as absent and supports exists: false", () => {
    expect(holds({ path: "repo", op: "exists" })).toBe(true);
    expect(holds({ path: "nothing", op: "exists" })).toBe(false);
    expect(holds({ path: "missing", op: "exists" })).toBe(false);
    expect(holds({ path: "missing", op: "exists", value: false })).toBe(true);
    expect(holds({ path: "repo", op: "exists", value: false })).toBe(false);
  });

  it("[*] holds when any element satisfies the condition", () => {
    expect(holds({ path: "items[*].qty", op: "gt", value: 30 })).toBe(true);
    expect(holds({ path: "items[*].qty", op: "gt", value: 50 })).toBe(false);
    expect(holds({ path: "labels[*]", op: "one_of", value: ["p1"] })).toBe(true);
  });

  it("label conditions read provenance and data classes, and are false without labels", () => {
    const labels = { provenance: ["untrusted_external"], dataClasses: ["email"] };
    expect(holds({ op: "label_present", value: "email" }, args, labels)).toBe(true);
    expect(holds({ op: "label_present", value: "untrusted_external" }, args, labels)).toBe(true);
    expect(holds({ op: "label_absent", value: "card_number" }, args, labels)).toBe(true);
    expect(holds({ op: "label_absent", value: "email" }, args, labels)).toBe(false);
    expect(holds({ op: "label_present", value: "email" }, args, undefined)).toBe(false);
    expect(holds({ op: "label_absent", value: "email" }, args, null)).toBe(false);
  });

  it("is total on malformed conditions", () => {
    expect(holds({ op: "equals", value: 1 })).toBe(false);
    expect(holds({ path: "repo", op: "one_of", value: "acme/api" })).toBe(false);
    expect(holds({ path: "count", op: "between", value: [1] })).toBe(false);
    expect(holds({ path: "repo", op: "nope" as McpPolicyCondition["op"], value: 1 })).toBe(false);
  });
});

describe("matchesValueGlob", () => {
  it("treats regex characters literally", () => {
    expect(matchesValueGlob("a.b(c)", "a.b(c)")).toBe(true);
    expect(matchesValueGlob("a.b", "axb")).toBe(false);
    expect(matchesValueGlob("*", "multi\nline")).toBe(true);
  });
});

describe("evaluateMcpToolPolicy with conditions", () => {
  const prodDeny = rule({ id: "prod", name: "No prod repo", effect: "deny", conditions: { all: [{ path: "repo", op: "equals", value: "acme/prod" }] } });

  it("matches a conditional rule only when its conditions hold", () => {
    expect(evaluateMcpToolPolicy([prodDeny], request({ arguments: { repo: "acme/prod" } }))).toMatchObject({ allowed: false, effect: "deny", rule: prodDeny });
    expect(evaluateMcpToolPolicy([prodDeny], request({ arguments: { repo: "acme/dev" } }))).toMatchObject({ allowed: true, decidedBy: "default" });
  });

  it("combines with all and any", () => {
    const all = rule({ id: "all", effect: "deny", conditions: { all: [{ path: "repo", op: "starts_with", value: "acme/" }, { path: "count", op: "gt", value: 10 }] } });
    const any = rule({ id: "any", effect: "deny", conditions: { any: [{ path: "repo", op: "starts_with", value: "acme/" }, { path: "count", op: "gt", value: 10 }] } });
    const call = request({ arguments: { repo: "acme/api", count: 3 } });
    expect(evaluateMcpToolPolicy([all], call).allowed).toBe(true);
    expect(evaluateMcpToolPolicy([any], call).allowed).toBe(false);
  });

  it("scopes by workflow and by gateway client", () => {
    const wf = rule({ id: "wf", effect: "deny", workflowIds: ["wf-1"] });
    expect(evaluateMcpToolPolicy([wf], request({ workflowId: "wf-1" })).allowed).toBe(false);
    expect(evaluateMcpToolPolicy([wf], request({ workflowId: "wf-2" })).allowed).toBe(true);
    expect(evaluateMcpToolPolicy([wf], request()).allowed).toBe(true);
    const client = rule({ id: "client", effect: "deny", clientIds: ["mcpc_1"] });
    expect(evaluateMcpToolPolicy([client], request({ clientId: "mcpc_1" })).allowed).toBe(false);
    expect(evaluateMcpToolPolicy([client], request({ clientId: "mcpc_2" })).allowed).toBe(true);
    expect(evaluateMcpToolPolicy([client], request()).allowed).toBe(true);
  });

  it("orders deny > require_approval > allow", () => {
    const allow = rule({ id: "allow", effect: "allow" });
    const approve = rule({ id: "approve", effect: "require_approval" });
    const deny = rule({ id: "deny", effect: "deny" });
    expect(evaluateMcpToolPolicy([allow, approve], request())).toMatchObject({ allowed: true, effect: "require_approval", rule: approve });
    expect(evaluateMcpToolPolicy([approve, deny, allow], request())).toMatchObject({ allowed: false, effect: "deny", rule: deny });
    expect(evaluateMcpToolPolicy([allow], request())).toMatchObject({ allowed: true, effect: "allow", rule: allow });
  });

  it("lets a narrower allow carve out of a require_approval, and a narrower approval out of a deny", () => {
    const approveAll = rule({ id: "approve", effect: "require_approval", serverId: "mcp_github" });
    const allowSafe = rule({ id: "safe", effect: "allow", serverId: "mcp_github", conditions: { all: [{ path: "repo", op: "one_of", value: ["acme/sandbox"] }] } });
    expect(evaluateMcpToolPolicy([approveAll, allowSafe], request({ arguments: { repo: "acme/sandbox" } }))).toMatchObject({
      effect: "allow",
      rule: allowSafe,
      overriddenApprovals: [{ approval: approveAll, by: allowSafe }]
    });
    expect(evaluateMcpToolPolicy([approveAll, allowSafe], request({ arguments: { repo: "acme/api" } })).effect).toBe("require_approval");

    const denyAll = rule({ id: "deny", effect: "deny", serverId: "mcp_github" });
    const approveIssue = rule({ id: "issue", effect: "require_approval", serverId: "mcp_github", toolPattern: "create_issue" });
    const decision = evaluateMcpToolPolicy([denyAll, approveIssue], request());
    expect(decision).toMatchObject({ allowed: true, effect: "require_approval", rule: approveIssue });
    expect(decision.overriddenDenies).toEqual([{ deny: denyAll, by: approveIssue }]);
  });

  it("never nests rules whose conditions differ", () => {
    const a = rule({ id: "a", effect: "deny", conditions: { all: [{ path: "repo", op: "equals", value: "x" }] } });
    const b = rule({ id: "b", effect: "allow", toolPattern: "create_issue", conditions: { all: [{ path: "repo", op: "equals", value: "y" }] } });
    const sameAsA = rule({ id: "c", effect: "allow", toolPattern: "create_issue", conditions: { all: [{ path: "repo", op: "equals", value: "x" }] } });
    expect(isStrictlyNarrower(b, a)).toBe(false);
    expect(isStrictlyNarrower(sameAsA, a)).toBe(true);
    expect(isStrictlyNarrower(a, rule({ id: "plain", effect: "deny" }))).toBe(true);
    expect(isStrictlyNarrower(rule({ id: "plain", effect: "allow" }), a)).toBe(false);
    expect(isStrictlyNarrower(rule({ id: "w", effect: "allow", workflowIds: ["wf"] }), rule({ id: "all", effect: "deny" }))).toBe(true);
    expect(isStrictlyNarrower(rule({ id: "w", effect: "allow", clientIds: ["c1"] }), rule({ id: "c", effect: "deny", clientIds: ["c1", "c2"] }))).toBe(true);
  });

  it("at discovery, conditional rules neither hide a tool nor stop a carve-out", () => {
    const discovery = request({ arguments: undefined });
    const conditionalDeny = evaluateMcpToolPolicy([prodDeny], discovery);
    expect(conditionalDeny).toMatchObject({ allowed: true, decidedBy: "default", undecided: [prodDeny] });

    const denyAll = rule({ id: "deny", effect: "deny", serverId: "mcp_github" });
    const allowSandbox = rule({ id: "sandbox", effect: "allow", serverId: "mcp_github", conditions: { all: [{ path: "repo", op: "equals", value: "acme/sandbox" }] } });
    expect(evaluateMcpToolPolicy([denyAll, allowSandbox], discovery).allowed).toBe(true);
    expect(evaluateMcpToolPolicy([denyAll, allowSandbox], request({ arguments: { repo: "acme/api" } })).allowed).toBe(false);
    expect(evaluateMcpToolPolicy([denyAll, allowSandbox], request({ arguments: { repo: "acme/sandbox" } })).allowed).toBe(true);
    // An unconditional deny still hides the tool.
    expect(evaluateMcpToolPolicy([denyAll], discovery).allowed).toBe(false);
  });

  it("shadow rules never change the outcome but report it", () => {
    const shadowDeny = rule({ id: "shadow", name: "Would block prod", effect: "deny", mode: "shadow", conditions: { all: [{ path: "repo", op: "equals", value: "acme/prod" }] } });
    const decision = evaluateMcpToolPolicy([shadowDeny], request({ arguments: { repo: "acme/prod" } }));
    expect(decision).toMatchObject({ allowed: true, effect: "allow", decidedBy: "default", matchedRules: [] });
    expect(decision.shadow).toMatchObject({ effect: "deny", rule: shadowDeny, matchedRules: [shadowDeny], changed: true });
    expect(evaluateMcpToolPolicy([shadowDeny], request({ arguments: { repo: "acme/dev" } })).shadow).toBeUndefined();

    const enforcedDeny = rule({ id: "deny", effect: "deny" });
    const shadowAllow = rule({ id: "carve", effect: "allow", mode: "shadow", toolPattern: "create_issue" });
    const both = evaluateMcpToolPolicy([enforcedDeny, shadowAllow], request());
    expect(both).toMatchObject({ allowed: false, effect: "deny", rule: enforcedDeny });
    expect(both.shadow).toMatchObject({ effect: "allow", changed: true });

    const shadowApproval = rule({ id: "ask", effect: "require_approval", mode: "shadow" });
    expect(evaluateMcpToolPolicy([enforcedDeny, shadowApproval], request()).shadow).toMatchObject({ effect: "deny", changed: false });
  });
});

describe("policyDecisionRecord", () => {
  it("records rule id, hash, mode and decision, and nothing when no rule matched", () => {
    const deny = rule({ id: "deny", name: "Block", effect: "deny", conditions: { all: [{ path: "repo", op: "equals", value: "p" }] } });
    const shadow = rule({ id: "s", effect: "require_approval", mode: "shadow" });
    expect(policyDecisionRecord(evaluateMcpToolPolicy([], request()))).toBeUndefined();
    const record = policyDecisionRecord(evaluateMcpToolPolicy([deny, shadow], request({ arguments: { repo: "p" } })));
    expect(record).toEqual({
      effect: "deny",
      decidedBy: "rule",
      ruleId: "deny",
      ruleName: "Block",
      ruleHash: hashMcpToolPolicyRule(deny),
      matched: [
        { ruleId: "deny", mode: "enforce", effect: "deny" },
        { ruleId: "s", mode: "shadow", effect: "require_approval" }
      ],
      shadow: { effect: "deny", ruleId: "deny", ruleName: "Block", ruleHash: hashMcpToolPolicyRule(deny), changed: false }
    });
    const approval = policyDecisionRecord(evaluateMcpToolPolicy([rule({ id: "a", effect: "require_approval" })], request()), "pending");
    expect(approval).toMatchObject({ effect: "require_approval", approval: "pending" });
  });

  it("hashes stably", () => {
    const a = rule({ id: "a", effect: "deny", name: "x", conditions: { all: [{ path: "repo", op: "equals", value: "p" }] } });
    expect(hashMcpToolPolicyRule(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashMcpToolPolicyRule({ ...a, id: "b", name: "y", mode: "shadow" })).toBe(hashMcpToolPolicyRule(a));
    expect(hashMcpToolPolicyRule({ ...a, effect: "allow" })).not.toBe(hashMcpToolPolicyRule(a));
  });
});

describe("evaluateMcpToolAccess with conditions", () => {
  it("explains a conditional deny and reports approval without blocking", () => {
    const deny = rule({ id: "prod", name: "No prod", effect: "deny", conditions: { all: [{ path: "repo", op: "one_of", value: ["acme/prod"] }] } });
    const blocked = evaluateMcpToolAccess({ ...request({ arguments: { repo: "acme/prod" } }), rules: [deny] });
    expect(blocked.allowed).toBe(false);
    expect(blocked.message).toContain('the call matches: repo is one of "acme/prod"');

    const approve = rule({ id: "big", name: "Big orders", effect: "require_approval", conditions: { all: [{ path: "count", op: "gt", value: 100 }] } });
    const pending = evaluateMcpToolAccess({ ...request({ arguments: { count: 500 } }), rules: [approve] });
    expect(pending).toMatchObject({ allowed: true, approval: { ruleId: "big", ruleName: "Big orders" } });
    expect(pending.approval?.message).toContain("needs approval by policy 'Big orders' (big)");
    expect(evaluateMcpToolAccess({ ...request({ arguments: { count: 5 } }), rules: [approve] }).approval).toBeUndefined();
  });

  it("describes conditions in words", () => {
    expect(
      describePolicyConditions({
        any: [
          { path: "n", op: "between", value: [1, 5] },
          { path: "x", op: "exists", value: false },
          { op: "label_present", value: "email" }
        ]
      })
    ).toBe("n is between 1 and 5 or x does not exist or label present: email");
  });

  it("knows when arguments matter", () => {
    expect(policyNeedsArguments([rule({ id: "a", effect: "deny" })])).toBe(false);
    expect(policyNeedsArguments([rule({ id: "a", effect: "deny", conditions: { all: [{ path: "a", op: "exists" }] } })])).toBe(true);
    expect(policyNeedsArguments([rule({ id: "a", effect: "deny", enabled: false, conditions: { all: [{ path: "a", op: "exists" }] } })])).toBe(false);
  });
});
