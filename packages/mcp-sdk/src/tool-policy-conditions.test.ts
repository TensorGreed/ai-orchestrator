/**
 * Phase 12.4 — argument-aware tool policy rules: every condition operator,
 * paths, types, principals, precedence, carve-outs, discovery and shadow mode.
 */
import { describe, expect, it } from "vitest";
import type { McpPolicyCondition, McpToolPolicyRule } from "@ai-orchestrator/shared";
import {
  describePolicyConditions,
  evaluateMcpToolAccess,
  createPolicyEvaluationBudget,
  evaluateMcpToolPolicy,
  evaluatePolicyCondition,
  hashMcpToolPolicyRule,
  isStrictlyNarrower,
  MAX_EVALUATED_ARGUMENT_CHARS,
  MAX_GLOB_STEPS_PER_EVALUATION,
  MAX_GLOB_TEXT_LENGTH,
  MAX_RESOLVED_VALUES,
  matchesToolPattern,
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

/** An allow rule's reading of the same condition (every value must satisfy it). */
const allowHolds = (condition: McpPolicyCondition, input: Record<string, unknown> = args, labels?: McpToolPolicyRequest["dataLabels"]) =>
  evaluatePolicyCondition(condition, input, labels, "every");

describe("evaluatePolicyCondition", () => {
  it("equals compares scalars as trimmed text and numbers by value", () => {
    expect(holds({ path: "repo", op: "equals", value: "acme/api" })).toBe(true);
    expect(holds({ path: "count", op: "equals", value: 5 })).toBe(true);
    expect(holds({ path: "count", op: "equals", value: "5" })).toBe(true);
    expect(holds({ path: "n", op: "equals", value: 5000 }, { n: "5000.0" })).toBe(true);
    expect(holds({ path: "zip", op: "equals", value: "007" }, { zip: "007" })).toBe(true);
    expect(holds({ path: "zip", op: "equals", value: "007" }, { zip: "7" })).toBe(false);
    expect(holds({ path: "env", op: "equals", value: "prod" }, { env: " prod " })).toBe(true);
    expect(holds({ path: "draft", op: "equals", value: false })).toBe(true);
    expect(holds({ path: "draft", op: "equals", value: false }, { draft: "false" })).toBe(true);
    expect(holds({ path: "nothing", op: "equals", value: null })).toBe(true);
    // An object is a value equals cannot read: a match for deny and approval, never for allow.
    expect(holds({ path: "owner", op: "equals", value: "octo" })).toBe(true);
    expect(allowHolds({ path: "owner", op: "equals", value: "octo" })).toBe(false);
  });

  it("compares text with case only when ignoreCase is off", () => {
    expect(holds({ path: "env", op: "one_of", value: ["prod"] }, { env: "PROD" })).toBe(false);
    expect(holds({ path: "env", op: "one_of", value: ["prod"], ignoreCase: true }, { env: "PROD" })).toBe(true);
    expect(holds({ path: "repo", op: "starts_with", value: "ACME/", ignoreCase: true })).toBe(true);
    expect(holds({ path: "repo", op: "matches", value: "*/API", ignoreCase: true })).toBe(true);
    expect(holds({ path: "env", op: "not_one_of", value: ["dev"], ignoreCase: true }, { env: "DEV" })).toBe(false);
  });

  it("one_of and not_one_of", () => {
    expect(holds({ path: "repo", op: "one_of", value: ["acme/web", "acme/api"] })).toBe(true);
    expect(holds({ path: "repo", op: "one_of", value: ["acme/web"] })).toBe(false);
    expect(holds({ path: "repo", op: "not_one_of", value: ["acme/web"] })).toBe(true);
    expect(holds({ path: "repo", op: "not_one_of", value: ["acme/api"] })).toBe(false);
  });

  it("a missing argument satisfies only the negated operators, and only for deny and approval", () => {
    // "missing is not one of dev": deny env not_one_of [dev] fires when env is left out.
    expect(holds({ path: "missing", op: "not_one_of", value: ["x"] })).toBe(true);
    expect(holds({ path: "empty", op: "not_one_of", value: ["x"] }, { empty: [] })).toBe(true);
    expect(holds({ path: "missing", op: "one_of", value: ["x"] })).toBe(false);
    expect(holds({ path: "missing", op: "gt", value: 1 })).toBe(false);
    expect(allowHolds({ path: "missing", op: "not_one_of", value: ["x"] })).toBe(false);
    expect(allowHolds({ path: "empty", op: "not_one_of", value: ["x"] }, { empty: [] })).toBe(false);
    // null reads like a missing argument.
    expect(holds({ path: "nothing", op: "not_one_of", value: ["x"] })).toBe(true);
    expect(allowHolds({ path: "nothing", op: "not_one_of", value: ["x"] })).toBe(false);
    expect(holds({ path: "nothing", op: "not_one_of", value: [null] })).toBe(false);
    expect(holds({ path: "nothing", op: "one_of", value: ["x"] })).toBe(false);
  });

  it("a value the operator cannot read matches for deny and approval, never for allow", () => {
    expect(holds({ path: "owner", op: "not_one_of", value: ["x"] })).toBe(true);
    expect(allowHolds({ path: "owner", op: "not_one_of", value: ["x"] })).toBe(false);
    expect(holds({ path: "repo", op: "gt", value: 0 })).toBe(true);
    expect(allowHolds({ path: "repo", op: "gt", value: 0 })).toBe(false);
    expect(holds({ path: "nothing", op: "gt", value: 0 })).toBe(false);
  });

  it("starts_with, ends_with and matches read scalars as trimmed text", () => {
    expect(holds({ path: "repo", op: "starts_with", value: "acme/" })).toBe(true);
    expect(holds({ path: "repo", op: "starts_with", value: "acme/" }, { repo: "  acme/x" })).toBe(true);
    expect(holds({ path: "repo", op: "ends_with", value: "/api" })).toBe(true);
    expect(holds({ path: "repo", op: "starts_with", value: "other/" })).toBe(false);
    expect(holds({ path: "count", op: "starts_with", value: "5" })).toBe(true);
    expect(holds({ path: "owner", op: "starts_with", value: "o" })).toBe(true);
    expect(allowHolds({ path: "owner", op: "starts_with", value: "o" })).toBe(false);
    expect(holds({ path: "repo", op: "matches", value: "acme/*" })).toBe(true);
    expect(holds({ path: "repo", op: "matches", value: "acme/ap?" })).toBe(true);
    expect(holds({ path: "repo", op: "matches", value: "acme.api" })).toBe(false);
  });

  it("number operators read numbers and numeric strings", () => {
    expect(holds({ path: "count", op: "lt", value: 6 })).toBe(true);
    expect(holds({ path: "count", op: "lt", value: 5 })).toBe(false);
    expect(holds({ path: "count", op: "lte", value: 5 })).toBe(true);
    expect(holds({ path: "count", op: "gt", value: 4 })).toBe(true);
    expect(holds({ path: "count", op: "gte", value: 6 })).toBe(false);
    expect(holds({ path: "count", op: "between", value: [5, 10] })).toBe(true);
    expect(holds({ path: "count", op: "between", value: [6, 10] })).toBe(false);
    expect(holds({ path: "amount", op: "gt", value: 100 }, { amount: "5000" })).toBe(true);
    expect(holds({ path: "amount", op: "gt", value: 100 }, { amount: " 1e4 " })).toBe(true);
    expect(holds({ path: "amount", op: "gt", value: 100 }, { amount: "50" })).toBe(false);
    expect(allowHolds({ path: "amount", op: "lte", value: 100 }, { amount: "50" })).toBe(true);
    expect(holds({ path: "count", op: "gt", value: "1" as unknown as number })).toBe(false);
  });

  it("exists treats null as absent and supports exists: false", () => {
    expect(holds({ path: "repo", op: "exists" })).toBe(true);
    expect(holds({ path: "nothing", op: "exists" })).toBe(false);
    expect(holds({ path: "missing", op: "exists" })).toBe(false);
    expect(holds({ path: "missing", op: "exists", value: false })).toBe(true);
    expect(holds({ path: "repo", op: "exists", value: false })).toBe(false);
  });

  it("several values: any of them for deny and approval, every one (and at least one) for allow", () => {
    expect(holds({ path: "items[*].qty", op: "gt", value: 30 })).toBe(true);
    expect(holds({ path: "items[*].qty", op: "gt", value: 50 })).toBe(false);
    expect(allowHolds({ path: "items[*].qty", op: "gt", value: 30 })).toBe(false);
    expect(allowHolds({ path: "items[*].qty", op: "gt", value: 1 })).toBe(true);
    expect(holds({ path: "labels[*]", op: "one_of", value: ["p1"] })).toBe(true);
    const mixed = { repos: ["myorg/a", "evil/b"] };
    expect(holds({ path: "repos[*]", op: "starts_with", value: "evil/" }, mixed)).toBe(true);
    expect(allowHolds({ path: "repos[*]", op: "starts_with", value: "myorg/" }, mixed)).toBe(false);
    expect(allowHolds({ path: "repos[*]", op: "starts_with", value: "myorg/" }, { repos: ["myorg/a", "myorg/b"] })).toBe(true);
    expect(allowHolds({ path: "repos[*]", op: "starts_with", value: "myorg/" }, { repos: [] })).toBe(false);
  });

  it("a path that ends on an array reads its elements", () => {
    expect(holds({ path: "env", op: "one_of", value: ["prod"] }, { env: ["prod"] })).toBe(true);
    expect(holds({ path: "amount", op: "gt", value: 100 }, { amount: [5000] })).toBe(true);
    expect(holds({ path: "env", op: "not_one_of", value: ["dev"] }, { env: ["prod"] })).toBe(true);
    expect(holds({ path: "labels", op: "one_of", value: ["p1"] })).toBe(true);
    expect(allowHolds({ path: "labels", op: "one_of", value: ["p1"] })).toBe(false);
    expect(allowHolds({ path: "labels", op: "one_of", value: ["p1", "bug"] })).toBe(true);
  });

  it("objects and nested lists are values no operator can read: deny matches, allow does not", () => {
    // The review's probes (N-L2).
    expect(holds({ path: "env", op: "one_of", value: ["prod"] }, { env: { v: "prod" } })).toBe(true);
    expect(holds({ path: "env", op: "one_of", value: ["prod"] }, { env: [["prod"]] })).toBe(true);
    expect(holds({ path: "repo", op: "starts_with", value: "evil/" }, { repo: [["evil/x"]] })).toBe(true);
    expect(holds({ path: "repo", op: "matches", value: "evil/*" }, { repo: { name: "evil/x" } })).toBe(true);
    expect(allowHolds({ path: "repo", op: "starts_with", value: "myorg/" }, { repo: [["myorg/x"]] })).toBe(false);
    // null still reads as missing.
    expect(holds({ path: "env", op: "one_of", value: ["prod"] }, { env: null })).toBe(false);
  });

  it("an allow needs every [*] element to have the rest of the path (N-L3)", () => {
    const files = { files: [{ path: "/safe/a" }, { other: "/etc/passwd" }] };
    expect(allowHolds({ path: "files[*].path", op: "starts_with", value: "/safe/" }, files)).toBe(false);
    expect(allowHolds({ path: "files[*].path", op: "starts_with", value: "/safe/" }, { files: [{ path: "/safe/a" }, { path: "/safe/b" }] })).toBe(true);
    expect(allowHolds({ path: "files[*].path", op: "exists" }, files)).toBe(false);
    expect(allowHolds({ path: "groups[*][*]", op: "one_of", value: ["a"] }, { groups: [["a"], "a"] })).toBe(false);
    // For deny and approval the element without the key is simply missing.
    expect(holds({ path: "files[*].path", op: "starts_with", value: "/etc/" }, files)).toBe(false);
    expect(holds({ path: "files[*].path", op: "starts_with", value: "/safe/" }, files)).toBe(true);
  });

  it("values past the cap make the reading incomplete: deny matches, allow does not (N-H1)", () => {
    const padded = { repos: [...Array.from({ length: MAX_RESOLVED_VALUES }, (_, index) => `myorg/r${index}`), "evil/b"] };
    for (const path of ["repos[*]", "repos"]) {
      expect(holds({ path, op: "starts_with", value: "evil/" }, padded), path).toBe(true);
      expect(holds({ path, op: "one_of", value: ["nothing-here"] }, padded), path).toBe(true);
      expect(allowHolds({ path, op: "starts_with", value: "myorg/" }, padded), path).toBe(false);
    }
    // Through nested [*] steps too.
    const nested = { orgs: [{ repos: padded.repos.slice(0, 600) }, { repos: padded.repos.slice(600) }] };
    expect(holds({ path: "orgs[*].repos[*]", op: "starts_with", value: "evil/" }, nested)).toBe(true);
    expect(allowHolds({ path: "orgs[*].repos[*]", op: "starts_with", value: "myorg/" }, nested)).toBe(false);
    // Exactly at the cap nothing is cut.
    const full = { repos: Array.from({ length: MAX_RESOLVED_VALUES }, (_, index) => `myorg/r${index}`) };
    expect(allowHolds({ path: "repos[*]", op: "starts_with", value: "myorg/" }, full)).toBe(true);
    expect(holds({ path: "repos[*]", op: "starts_with", value: "evil/" }, full)).toBe(false);
  });

  it("label conditions read provenance and data classes; untracked labels count as absent for deny only", () => {
    const labels = { provenance: ["untrusted_external"], dataClasses: ["email"] };
    expect(holds({ op: "label_present", value: "email" }, args, labels)).toBe(true);
    expect(holds({ op: "label_present", value: "untrusted_external" }, args, labels)).toBe(true);
    expect(holds({ op: "label_absent", value: "card_number" }, args, labels)).toBe(true);
    expect(holds({ op: "label_absent", value: "email" }, args, labels)).toBe(false);
    expect(holds({ op: "label_present", value: "email" }, args, undefined)).toBe(false);
    expect(holds({ op: "label_absent", value: "email" }, args, null)).toBe(true);
    expect(allowHolds({ op: "label_absent", value: "email" }, args, null)).toBe(false);
  });

  it("is total on malformed conditions; a path it cannot read fails closed", () => {
    expect(holds({ op: "equals", value: 1 })).toBe(true);
    expect(allowHolds({ op: "equals", value: 1 })).toBe(false);
    expect(holds({ path: "items..id", op: "equals", value: 1 })).toBe(true);
    expect(allowHolds({ path: "items..id", op: "equals", value: 1 })).toBe(false);
    expect(holds({ path: "repo", op: "one_of", value: "acme/api" })).toBe(false);
    expect(holds({ path: "missing", op: "not_one_of", value: "acme/api" })).toBe(false);
    expect(holds({ path: "count", op: "between", value: [1] })).toBe(false);
    expect(holds({ path: "repo", op: "nope" as McpPolicyCondition["op"], value: 1 })).toBe(false);
  });
});

describe("matchesValueGlob", () => {
  it("treats regex characters literally", () => {
    expect(matchesValueGlob("a.b(c)", "a.b(c)")).toBe(true);
    expect(matchesValueGlob("a.b", "axb")).toBe(false);
    expect(matchesValueGlob("*", "multi\nline")).toBe(true);
    expect(matchesValueGlob("a*b?d", "aXXbcd")).toBe(true);
    expect(matchesValueGlob("a*b?d", "aXXbd")).toBe(false);
    expect(matchesValueGlob("**", "")).toBe(true);
  });

  it("runs in linear-ish time on pathological patterns", () => {
    const started = performance.now();
    expect(matchesValueGlob("*a*a*b", "a".repeat(3000))).toBe(false);
    expect(matchesValueGlob("*a*a*a*b", "a".repeat(1000))).toBe(false);
    expect(matchesValueGlob(`${"*a".repeat(10)}*b`, "a".repeat(60_000))).toBe(false);
    expect(matchesToolPattern(`${"*a".repeat(10)}*b`, "a".repeat(100_000))).toBe(false);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("spends one budget per evaluation and fails closed once it is gone (N-M2)", () => {
    const pattern = `*${"a".repeat(498)}b`;
    const values = Array.from({ length: 150 }, () => "a".repeat(64 * 1024));
    const started = performance.now();
    expect(holds({ path: "body[*]", op: "matches", value: pattern }, { body: values })).toBe(true);
    expect(allowHolds({ path: "body[*]", op: "matches", value: pattern }, { body: values })).toBe(false);
    const budget = createPolicyEvaluationBudget();
    expect(evaluatePolicyCondition({ path: "body", op: "matches", value: pattern }, { body: values[0] }, undefined, "any", budget)).toBe(true);
    expect(budget.globSteps).toBe(0);
    // Spent: even a cheap match now reads as unreadable for the rest of the call.
    expect(evaluatePolicyCondition({ path: "repo", op: "matches", value: "nope*" }, args, undefined, "any", budget)).toBe(true);
    expect(evaluatePolicyCondition({ path: "repo", op: "matches", value: "acme/*" }, args, undefined, "every", budget)).toBe(false);
    // Spending a full glob budget is slow on shared CI runners; this only guards against a hang.
    expect(performance.now() - started).toBeLessThan(15_000);
    // A fresh budget is far from spent by ordinary values.
    const fresh = createPolicyEvaluationBudget();
    expect(evaluatePolicyCondition({ path: "repo", op: "matches", value: "acme/*" }, args, undefined, "every", fresh)).toBe(true);
    expect(fresh.globSteps).toBeGreaterThan(MAX_GLOB_STEPS_PER_EVALUATION - 100);
  });

  it("does not run a glob on text over the cap: deny matches, allow does not", () => {
    const huge = { body: "x".repeat(MAX_GLOB_TEXT_LENGTH + 1) };
    expect(holds({ path: "body", op: "matches", value: "*secret*" }, huge)).toBe(true);
    expect(allowHolds({ path: "body", op: "matches", value: "*" }, huge)).toBe(false);
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

  it("an allow carve-out on [*] needs every element: a mixed array stays denied", () => {
    const denyPush = rule({ id: "deny", effect: "deny", toolPattern: "push" });
    const allowMyorg = rule({ id: "myorg", effect: "allow", toolPattern: "push", conditions: { all: [{ path: "repos[*]", op: "starts_with", value: "myorg/" }] } });
    const call = (repos: string[]) => request({ toolName: "push", arguments: { repos } });
    expect(evaluateMcpToolPolicy([denyPush, allowMyorg], call(["myorg/a", "evil/b"]))).toMatchObject({ allowed: false, rule: denyPush });
    expect(evaluateMcpToolPolicy([denyPush, allowMyorg], call(["myorg/a", "myorg/b"]))).toMatchObject({ allowed: true, rule: allowMyorg });
    expect(evaluateMcpToolPolicy([denyPush, allowMyorg], call([])).allowed).toBe(false);
  });

  it("padding a list past the cap neither escapes a deny nor widens an allow (N-H1)", () => {
    const denyPush = rule({ id: "deny", effect: "deny", toolPattern: "push" });
    const allowMyorg = rule({ id: "myorg", effect: "allow", toolPattern: "push", conditions: { all: [{ path: "repos[*]", op: "starts_with", value: "myorg/" }] } });
    const denyEvil = rule({ id: "evil", effect: "deny", toolPattern: "push", conditions: { all: [{ path: "repos[*]", op: "starts_with", value: "evil/" }] } });
    const padded = [...Array.from({ length: 1000 }, (_, index) => `myorg/r${index}`), "evil/b"];
    const call = request({ toolName: "push", arguments: { repos: padded } });
    expect(evaluateMcpToolPolicy([denyPush, allowMyorg], call)).toMatchObject({ allowed: false, rule: denyPush });
    expect(evaluateMcpToolPolicy([denyEvil], call)).toMatchObject({ allowed: false, rule: denyEvil });
  });

  it("one glob budget covers every rule of a call: long values cannot stall it (N-M2)", () => {
    const pattern = `*${"a".repeat(498)}b`;
    const body = Array.from({ length: 150 }, () => "a".repeat(64 * 1024));
    const denyBody = rule({ id: "deny-body", effect: "deny", conditions: { all: [{ path: "body", op: "matches", value: pattern }] } });
    const denyAll = rule({ id: "deny-all", effect: "deny" });
    const allowBody = rule({ id: "allow-body", effect: "allow", conditions: { all: [{ path: "body", op: "matches", value: pattern }] } });
    const started = performance.now();
    expect(evaluateMcpToolPolicy([denyBody], request({ arguments: { body } }))).toMatchObject({ allowed: false, rule: denyBody });
    expect(evaluateMcpToolPolicy([denyAll, allowBody], request({ arguments: { body } }))).toMatchObject({ allowed: false, rule: denyAll });
    // Spending a full glob budget is slow on shared CI runners; this only guards against a hang.
    expect(performance.now() - started).toBeLessThan(15_000);
  });

  it("deny rules catch the sloppy arguments of the review", () => {
    const amount = rule({ id: "amount", effect: "deny", conditions: { all: [{ path: "amount", op: "gt", value: 100 }] } });
    for (const value of ["5000", [5000], "lots"]) {
      expect(evaluateMcpToolPolicy([amount], request({ arguments: { amount: value } })).allowed, JSON.stringify(value)).toBe(false);
    }
    const prod = rule({ id: "prod", effect: "deny", conditions: { all: [{ path: "env", op: "one_of", value: ["prod"], ignoreCase: true }] } });
    for (const value of ["PROD", ["prod"], "prod "]) {
      expect(evaluateMcpToolPolicy([prod], request({ arguments: { env: value } })).allowed, JSON.stringify(value)).toBe(false);
    }
    const notDev = rule({ id: "notdev", effect: "deny", conditions: { all: [{ path: "env", op: "not_one_of", value: ["dev"] }] } });
    expect(evaluateMcpToolPolicy([notDev], request({ arguments: {} })).allowed).toBe(false);
    expect(evaluateMcpToolPolicy([notDev], request({ arguments: { env: ["prod"] } })).allowed).toBe(false);
    expect(evaluateMcpToolPolicy([notDev], request({ arguments: { env: "dev" } })).allowed).toBe(true);
  });

  it("a rule with invalid stored conditions fails closed", () => {
    const badAllow = rule({ id: "bad-allow", effect: "allow", toolPattern: "create_issue", conditions: null, invalid: true });
    const deny = rule({ id: "deny", effect: "deny" });
    expect(evaluateMcpToolPolicy([deny, badAllow], request()).allowed).toBe(false);
    expect(evaluateMcpToolPolicy([deny, badAllow], request({ arguments: undefined })).allowed).toBe(false);
    const badDeny = rule({ id: "bad-deny", effect: "deny", conditions: null, invalid: true });
    expect(evaluateMcpToolPolicy([badDeny], request({ arguments: { repo: "anything" } }))).toMatchObject({ allowed: false, rule: badDeny });
    const badApproval = rule({ id: "bad-ask", effect: "require_approval", conditions: null, invalid: true });
    expect(evaluateMcpToolPolicy([badApproval], request()).effect).toBe("require_approval");
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

describe("evaluation cost is linear in the arguments read (N2-M1)", () => {
  const entries = (count: number, make: (index: number) => McpPolicyCondition["value"]) => Array.from({ length: count }, (_, index) => make(index));
  const listRules = (count: number, ops: { op: McpPolicyCondition["op"]; value: McpPolicyCondition["value"]; ignoreCase?: boolean }) =>
    entries(count, (index) => index).map((index) =>
      rule({
        id: `r${String(index)}`,
        effect: "deny",
        conditions: { any: entries(20, (n) => n).map(() => ({ path: "v", ...ops })) as McpPolicyCondition[] }
      })
    );

  it("decides the review's 9 MB value against 10 rules of 20 one_of lists quickly, and fails closed", () => {
    const rules = listRules(10, { op: "one_of", value: entries(100, (index) => `Entry-${String(index)}`) as string[], ignoreCase: true });
    const started = performance.now();
    const decision = evaluateMcpToolPolicy(rules, request({ arguments: { v: "a".repeat(9 * 1024 * 1024) } }));
    expect(performance.now() - started).toBeLessThan(1_000);
    // Past the argument text budget the value cannot be read: the deny-list matches.
    expect(decision).toMatchObject({ allowed: false, effect: "deny" });
  });

  it("reads a large value inside the budget once, however many conditions read it", () => {
    const value = `${"a".repeat(MAX_EVALUATED_ARGUMENT_CHARS - 10)}`;
    const rules = listRules(20, { op: "one_of", value: entries(100, (index) => `Entry-${String(index)}`) as string[], ignoreCase: true });
    const numeric = listRules(20, { op: "one_of", value: entries(100, (index) => index) as number[] });
    const started = performance.now();
    expect(evaluateMcpToolPolicy([...rules, ...numeric], request({ arguments: { v: value } })).allowed).toBe(true);
    expect(evaluateMcpToolPolicy([...rules, ...numeric], request({ arguments: { v: `${" ".repeat(MAX_EVALUATED_ARGUMENT_CHARS - 10)}7` } })).allowed).toBe(false);
    expect(performance.now() - started).toBeLessThan(1_000);
    const budget = createPolicyEvaluationBudget();
    for (const op of ["equals", "starts_with", "ends_with"] as const) {
      evaluatePolicyCondition({ path: "v", op, value: "x", ignoreCase: true }, { v: value }, undefined, "any", budget);
    }
    expect(budget.argumentChars).toBe(10);
  });

  it("over the budget: deny and approval match, allow does not; unread arguments are not counted", () => {
    const big = "a".repeat(MAX_EVALUATED_ARGUMENT_CHARS + 1);
    expect(holds({ path: "v", op: "one_of", value: ["b"] }, { v: big })).toBe(true);
    expect(holds({ path: "v", op: "equals", value: "b" }, { v: big })).toBe(true);
    expect(holds({ path: "v", op: "gt", value: 1 }, { v: big })).toBe(true);
    expect(allowHolds({ path: "v", op: "starts_with", value: "a" }, { v: big })).toBe(false);
    expect(allowHolds({ path: "v", op: "not_one_of", value: ["b"] }, { v: big })).toBe(false);
    // `exists` does not read the text.
    expect(allowHolds({ path: "v", op: "exists" }, { v: big })).toBe(true);
    // A large argument no condition reads costs nothing.
    const call = { path: "/srv/app.txt", content: big };
    expect(allowHolds({ path: "path", op: "starts_with", value: "/srv/" }, call)).toBe(true);
    expect(holds({ path: "path", op: "starts_with", value: "/etc/" }, call)).toBe(false);
    // Values share the budget: the first ones read fit, the rest fail closed.
    const half = "a".repeat(MAX_EVALUATED_ARGUMENT_CHARS / 2);
    expect(allowHolds({ path: "v[*]", op: "starts_with", value: "a" }, { v: [half, half] })).toBe(true);
    expect(allowHolds({ path: "v[*]", op: "starts_with", value: "a" }, { v: [half, half, "a"] })).toBe(false);
  });

  it("keeps scalar equality the same as comparing one by one", () => {
    expect(holds({ path: "v", op: "one_of", value: [5000] }, { v: "5000" })).toBe(true);
    expect(holds({ path: "v", op: "one_of", value: [5000] }, { v: " 5e3 " })).toBe(true);
    expect(holds({ path: "v", op: "one_of", value: ["5000.0"] }, { v: 5000 })).toBe(true);
    expect(holds({ path: "v", op: "one_of", value: ["5000"] }, { v: "5000.0" })).toBe(false);
    expect(holds({ path: "v", op: "one_of", value: [5000] }, { v: "5000x" })).toBe(false);
    expect(holds({ path: "v", op: "one_of", value: ["TRUE"], ignoreCase: true }, { v: true })).toBe(true);
    expect(holds({ path: "v", op: "one_of", value: ["TRUE"] }, { v: true })).toBe(false);
    expect(holds({ path: "v", op: "one_of", value: [true] }, { v: "true" })).toBe(true);
    expect(holds({ path: "v", op: "equals", value: null }, { v: null })).toBe(true);
    expect(holds({ path: "v", op: "equals", value: "Prod" }, { v: " prod " })).toBe(false);
    expect(holds({ path: "v", op: "equals", value: "Prod", ignoreCase: true }, { v: " prod " })).toBe(true);
    expect(holds({ path: "v", op: "not_one_of", value: ["dev", 1] }, { v: "1.0" })).toBe(false);
    expect(holds({ path: "v", op: "not_one_of", value: ["dev", 1] }, { v: "DEV" })).toBe(true);
    expect(holds({ path: "v", op: "not_one_of", value: ["dev", null] }, { v: null })).toBe(false);
  });

  it("an element reached through [*] whose list is empty does not satisfy an allow", () => {
    const allow = { path: "r[*].n", op: "starts_with" as const, value: "myorg/" };
    expect(allowHolds(allow, { r: [{ n: "myorg/a" }, { n: [] }] })).toBe(false);
    expect(allowHolds(allow, { r: [{ n: "myorg/a" }, { n: ["myorg/b"] }] })).toBe(true);
  });
});

describe("shadow rules have their own budget (N2-L1)", () => {
  it("a shadow rule spending its glob budget never changes an enforced decision", () => {
    const shadow = rule({
      id: "shadow",
      effect: "deny",
      mode: "shadow",
      toolPattern: "push",
      conditions: { all: [{ path: "v[*]", op: "matches", value: `*${"a".repeat(498)}b` }] }
    });
    const deny = rule({ id: "deny", effect: "deny", toolPattern: "push" });
    const allow = rule({ id: "allow", effect: "allow", toolPattern: "push", conditions: { all: [{ path: "r", op: "matches", value: "myorg/*" }] } });
    const call = request({ toolName: "push", arguments: { v: Array.from({ length: 150 }, () => "a".repeat(64 * 1024)), r: "myorg/x" } });
    const withShadow = evaluateMcpToolPolicy([shadow, deny, allow], call);
    expect(withShadow).toMatchObject({ allowed: true, effect: "allow", rule: allow });
    expect(withShadow.shadow).toMatchObject({ effect: "deny", changed: true });
    expect(evaluateMcpToolPolicy([deny, allow], call)).toMatchObject({ allowed: true, rule: allow });
  });
});
