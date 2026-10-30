/**
 * Phase 12.4 — policy simulation over argument summaries: every operator
 * against every kind of summary value (kept, hashed, length only, missing,
 * lists, labels), determined vs undetermined, the current -> draft
 * transition, and a seeded property test that checks every DETERMINED
 * answer against the real evaluator on the real arguments.
 */
import { describe, expect, it } from "vitest";
import type { McpPolicyCondition, McpToolPolicyEffect, McpToolPolicyRule, ToolArgumentSummary } from "@ai-orchestrator/shared";
import { evaluateMcpToolPolicy, MAX_RESOLVED_VALUES } from "./tool-policy";
import { hashToolArgumentValue, summarizeToolArguments, toolArgumentHashKeyId, type ToolArgumentDetector } from "./tool-argument-summary";
import {
  decisionWork,
  evaluateConditionOnSummary,
  evaluateRuleOnSummary,
  MAX_UNDECIDED_RULES_PER_CALL,
  simulatePolicyTransition,
  simulationBucket,
  type PolicySimulationCall,
  type SimulationTruth
} from "./tool-policy-simulation";

const hashKey = new Uint8Array(32).fill(11);
const context = { hashKey };
const h = (value: string | number | boolean) => hashToolArgumentValue(value, hashKey);
const kid = toolArgumentHashKeyId(hashKey);
const noDetect: ToolArgumentDetector = () => [];
const summarize = (args: unknown, inputSchema?: unknown) => summarizeToolArguments(args, { detect: noDetect, hashKey, inputSchema });

function rule(partial: Partial<McpToolPolicyRule> & Pick<McpToolPolicyRule, "id" | "effect">): McpToolPolicyRule {
  return { name: null, description: null, projectId: null, roles: [], serverId: null, toolPattern: "*", enabled: true, ...partial };
}

function call(summary: ToolArgumentSummary, partial: Partial<PolicySimulationCall> = {}): PolicySimulationCall {
  return {
    role: "builder",
    projectId: "default",
    workflowId: "wf_1",
    clientId: null,
    adapterId: "http_mcp",
    registryServerId: "mcp_github",
    toolName: "create_issue",
    labels: "unknown",
    summary,
    ...partial
  };
}

const any = (condition: McpPolicyCondition, summary: ToolArgumentSummary, labels: "none" | "unknown" = "unknown"): SimulationTruth =>
  evaluateConditionOnSummary(condition, { summary, labels }, "any", context).value;
const every = (condition: McpPolicyCondition, summary: ToolArgumentSummary): SimulationTruth =>
  evaluateConditionOnSummary(condition, { summary, labels: "unknown" }, "every", context).value;

describe("conditions on a kept value", () => {
  const summary = summarize({ env: "prod", limit: 50, draft: true, empty: null });

  it("decides every value operator from a kept token", () => {
    expect(summary.fields.env).toMatchObject({ values: ["prod"] });
    expect(any({ path: "env", op: "equals", value: "prod" }, summary)).toBe(true);
    expect(any({ path: "env", op: "equals", value: "PROD", ignoreCase: true }, summary)).toBe(true);
    expect(any({ path: "env", op: "one_of", value: ["dev", "test"] }, summary)).toBe(false);
    expect(any({ path: "env", op: "not_one_of", value: ["dev"] }, summary)).toBe(true);
    expect(any({ path: "env", op: "starts_with", value: "pr" }, summary)).toBe(true);
    expect(any({ path: "env", op: "ends_with", value: "x" }, summary)).toBe(false);
    expect(any({ path: "env", op: "matches", value: "p*d" }, summary)).toBe(true);
    // A text value under a number operator is unreadable: a match for deny, never for allow.
    expect(any({ path: "env", op: "gt", value: 3 }, summary)).toBe(true);
    expect(every({ path: "env", op: "gt", value: 3 }, summary)).toBe(false);
  });

  it("decides numbers, booleans and null", () => {
    expect(any({ path: "limit", op: "gt", value: 10 }, summary)).toBe(true);
    expect(any({ path: "limit", op: "lte", value: 49 }, summary)).toBe(false);
    expect(any({ path: "limit", op: "between", value: [1, 100] }, summary)).toBe(true);
    expect(any({ path: "limit", op: "one_of", value: ["50"] }, summary)).toBe(true);
    expect(any({ path: "draft", op: "equals", value: true }, summary)).toBe(true);
    expect(any({ path: "draft", op: "equals", value: "true" }, summary)).toBe(true);
    expect(any({ path: "empty", op: "one_of", value: [null] }, summary)).toBe(true);
    // null under not_one_of reads like a missing argument: deny matches, allow does not.
    expect(any({ path: "empty", op: "not_one_of", value: ["x"] }, summary)).toBe(true);
    expect(every({ path: "empty", op: "not_one_of", value: ["x"] }, summary)).toBe(false);
  });

  it("decides exists from key presence and types", () => {
    expect(any({ path: "env", op: "exists" }, summary)).toBe(true);
    expect(any({ path: "env", op: "exists", value: false }, summary)).toBe(false);
    expect(any({ path: "empty", op: "exists" }, summary)).toBe(false);
    expect(any({ path: "missing", op: "exists" }, summary)).toBe(false);
    expect(any({ path: "missing", op: "exists", value: false }, summary)).toBe(true);
  });

  it("treats a missing path as the evaluator does", () => {
    expect(any({ path: "missing", op: "equals", value: "x" }, summary)).toBe(false);
    expect(any({ path: "missing", op: "not_one_of", value: ["x"] }, summary)).toBe(true);
    expect(every({ path: "missing", op: "not_one_of", value: ["x"] }, summary)).toBe(false);
    expect(any({ path: "missing", op: "starts_with", value: "x" }, summary)).toBe(false);
  });
});

describe("conditions on a hashed value", () => {
  // `title` is a sensitive key: its text is kept only as a hash.
  const summary = summarize({ title: "Quarterly report", count: 12345678, code: 42 });

  it("decides equality by hashing the rule's literal", () => {
    expect(summary.fields.title).toMatchObject({ hashes: [h("Quarterly report")] });
    expect(any({ path: "title", op: "equals", value: "Quarterly report" }, summary)).toBe(true);
    expect(any({ path: "title", op: "equals", value: "  Quarterly report " }, summary)).toBe(true);
    expect(any({ path: "title", op: "equals", value: "Other" }, summary)).toBe(false);
    expect(any({ path: "title", op: "one_of", value: ["a", "Quarterly report"] }, summary)).toBe(true);
    expect(any({ path: "title", op: "not_one_of", value: ["a", "b"] }, summary)).toBe(true);
    expect(any({ path: "title", op: "not_one_of", value: ["Quarterly report"] }, summary)).toBe(false);
  });

  it("cannot rule out a case variant under ignoreCase, but a matching variant proves equality", () => {
    const mixed = summarize({ title: "Release NOTES" });
    expect(any({ path: "title", op: "equals", value: "release notes", ignoreCase: true }, mixed)).toBe("unknown");
    expect(any({ path: "title", op: "not_one_of", value: ["release notes"], ignoreCase: true }, mixed)).toBe("unknown");
    expect(any({ path: "title", op: "equals", value: "Release NOTES", ignoreCase: true }, mixed)).toBe(true);
    expect(any({ path: "title", op: "equals", value: "quarterly report", ignoreCase: true }, summary)).toBe(true);
    // Text without cased letters has no case variants to miss.
    const digits = summarize({ title: "2026-10-30" });
    expect(any({ path: "title", op: "equals", value: "2026-10-31", ignoreCase: true }, digits)).toBe(false);
  });

  it("leaves text and number operators undetermined", () => {
    for (const op of ["starts_with", "ends_with", "matches"] as const) {
      expect(any({ path: "title", op, value: "Q" }, summary)).toBe("unknown");
      expect(every({ path: "title", op, value: "Q" }, summary)).toBe("unknown");
    }
    for (const op of ["lt", "lte", "gt", "gte"] as const) {
      expect(any({ path: "count", op, value: 10 }, summary)).toBe("unknown");
    }
    expect(any({ path: "count", op: "between", value: [1, 2] }, summary)).toBe("unknown");
  });

  it("compares a hashed number with number literals, and with strings only one way", () => {
    expect(summary.fields.count).toMatchObject({ mag: 7 });
    expect(any({ path: "count", op: "equals", value: 12345678 }, summary)).toBe(true);
    expect(any({ path: "count", op: "equals", value: 5 }, summary)).toBe(false);
    expect(any({ path: "count", op: "equals", value: "12345678.0" }, summary)).toBe(true);
    // A sensitive number: kept as a hash only.
    expect(any({ path: "code", op: "one_of", value: [42, 43] }, summary)).toBe(true);
  });

  it("cannot rule out a numeric string that equals a number literal", () => {
    const text = summarize({ title: "0042" });
    expect(any({ path: "title", op: "equals", value: 42 }, text)).toBe("unknown");
    expect(any({ path: "title", op: "equals", value: "0042" }, text)).toBe(true);
    // A numeric string literal: equal to the number 42, not to the string "42"; a hashed "42" may be either.
    const ambiguous = summarize({ title: "42" });
    expect(any({ path: "title", op: "equals", value: "42.0" }, ambiguous)).toBe("unknown");
    expect(any({ path: "title", op: "equals", value: "42" }, ambiguous)).toBe(true);
  });

  it("keeps a deny that matches unreadable values determined", () => {
    const nested = summarize({ meta: { a: 1 } });
    expect(any({ path: "meta", op: "equals", value: "x" }, nested)).toBe(true);
    expect(every({ path: "meta", op: "equals", value: "x" }, nested)).toBe(false);
  });
});

describe("values the summary does not show", () => {
  it("is undetermined for text kept only by length", () => {
    const summary = summarize({ body_id: "x".repeat(3000) });
    expect(summary.fields.body_id).toMatchObject({ len: "2049+" });
    expect(summary.fields.body_id?.hashes).toBeUndefined();
    expect(any({ path: "body_id", op: "equals", value: "x" }, summary)).toBe("unknown");
    expect(any({ path: "body_id", op: "exists" }, summary)).toBe(true);
  });

  it("is undetermined when a list of values was dropped (more)", () => {
    const values = Array.from({ length: 20 }, (_, index) => `tag${String.fromCharCode(97 + index)}`);
    const summary = summarize({ tags: values });
    expect(summary.fields["tags[]"]).toMatchObject({ more: true });
    expect(any({ path: "tags", op: "one_of", value: ["nope"] }, summary)).toBe("unknown");
    expect(every({ path: "tags", op: "one_of", value: ["nope"] }, summary)).toBe("unknown");
  });

  it("is undetermined when a truncated summary may hide the path", () => {
    const summary: ToolArgumentSummary = { v: 3, kid, fields: { a: { type: "string", values: ["x"] } }, truncated: true };
    expect(any({ path: "b", op: "equals", value: "x" }, summary)).toBe("unknown");
    expect(any({ path: "b", op: "exists" }, summary)).toBe("unknown");
    // A value it does show can still prove a deny.
    expect(any({ path: "a", op: "equals", value: "x" }, summary)).toBe(true);
  });

  it("is undetermined for an index step", () => {
    const summary = summarize({ items: ["a", "b"] });
    const result = evaluateConditionOnSummary({ path: "items[0]", op: "equals", value: "a" }, { summary, labels: "unknown" }, "any", context);
    expect(result.value).toBe("unknown");
    expect(result.reason).toMatch(/index step/);
  });

  it("reads labels only where the call carried none", () => {
    const summary = summarize({});
    expect(any({ op: "label_present", value: "email" }, summary, "unknown")).toBe("unknown");
    expect(any({ op: "label_present", value: "email" }, summary, "none")).toBe(false);
    expect(any({ op: "label_absent", value: "email" }, summary, "none")).toBe(true);
    expect(evaluateConditionOnSummary({ op: "label_absent", value: "email" }, { summary, labels: "none" }, "every", context).value).toBe(false);
  });

  it("does not trust a location number near the rule's limit", () => {
    const summary = summarize({ lat: 51.47 });
    expect(summary.fields.lat).toMatchObject({ values: [51.5] });
    expect(any({ path: "lat", op: "gt", value: 51.48 }, summary)).toBe("unknown");
    expect(any({ path: "lat", op: "gt", value: 50 }, summary)).toBe(true);
    expect(any({ path: "lat", op: "lt", value: 50 }, summary)).toBe(false);
    expect(any({ path: "lat", op: "equals", value: 51.5 }, summary)).toBe("unknown");
    expect(any({ path: "lat", op: "between", value: [51, 52] }, summary)).toBe(true);
    expect(any({ path: "lat", op: "between", value: [10, 20] }, summary)).toBe(false);
  });

  it("does not trust readings when argument text could exhaust the call budget", () => {
    const summary = summarize({ docs: Array.from({ length: 64 }, (_, index) => `${"y".repeat(2000)}${index}`), env: "prod" });
    const deny = rule({ id: "d", effect: "deny", conditions: { all: [{ path: "docs", op: "equals", value: "x" }, { path: "env", op: "equals", value: "dev" }] } });
    expect(evaluateRuleOnSummary(deny, call(summary), context).state).toBe("no_match");
    const big: ToolArgumentSummary = {
      v: 3,
      kid,
      fields: { docs: { type: "array", items: 600 }, "docs[]": { type: "string", count: 600, len: "513-2048", hashes: [h("a")] }, env: { type: "string", values: ["prod"] } }
    };
    const onEnv = rule({ id: "e", effect: "deny", conditions: { all: [{ path: "docs", op: "equals", value: "zzz" }, { path: "env", op: "equals", value: "dev" }] } });
    // Up to 1.2M characters of docs text: the evaluator may run out of its text budget before it reads env, and an
    // unreadable env matches a deny. Neither reading is trusted.
    expect(evaluateRuleOnSummary(onEnv, call(big), context).state).toBe("unknown");
    const onDocs = rule({ id: "f", effect: "deny", conditions: { all: [{ path: "docs", op: "not_one_of", value: [h("zz")] }] } });
    expect(evaluateRuleOnSummary(onDocs, call(big), context).state).toBe("match");
    const allowDocs = rule({ id: "g", effect: "allow", conditions: { all: [{ path: "docs", op: "not_one_of", value: ["zz"] }] } });
    expect(evaluateRuleOnSummary(allowDocs, call(big), context).state).toBe("unknown");
  });
});

describe("values kept or hashed in another form", () => {
  const deny = (condition: McpPolicyCondition) => rule({ id: "d", effect: "deny", conditions: { all: [condition] } });
  const simulated = (args: Record<string, unknown>, condition: McpPolicyCondition) =>
    simulatePolicyTransition([], [deny(condition)], call(summarize(args)), context).bucket;

  it("never decides a hashed location number (rounded before hashing)", () => {
    expect(simulated({ address: { lat: 51.5074 } }, { path: "address.lat", op: "equals", value: 51.5074 })).toBe("undetermined");
    expect(simulated({ address: { lat: 51.54 } }, { path: "address.lat", op: "equals", value: 51.5 })).toBe("undetermined");
    for (const op of ["one_of", "not_one_of"] as const) {
      expect(any({ path: "address.lat", op, value: [51.5] }, summarize({ address: { lat: 51.54 } }))).toBe("unknown");
    }
    // Even with no adj mark (a value already at one decimal), the hash of a location number is not compared.
    const unmarked: ToolArgumentSummary = { v: 3, kid, fields: { address: { type: "object", keys: 1 }, "address.lat": { type: "number", mag: 1, hashes: [h(51.5)] } } };
    expect(any({ path: "address.lat", op: "equals", value: 51.5 }, unmarked)).toBe("unknown");
    expect(any({ path: "address.lat", op: "not_one_of", value: [51.5] }, unmarked)).toBe("unknown");
  });

  it("does not decide text with surrounding whitespace or a compatibility form, nor a rounded number", () => {
    expect(simulated({ branch: "main " }, { path: "branch", op: "equals", value: "main" })).toBe("undetermined");
    expect(simulated({ branch: "ｍａｉｎ" }, { path: "branch", op: "equals", value: "main" })).toBe("undetermined");
    expect(simulated({ branch: "ｍａｉｎ" }, { path: "branch", op: "starts_with", value: "ma" })).toBe("undetermined");
    expect(simulated({ amount: 100.00004 }, { path: "amount", op: "gt", value: 100 })).toBe("undetermined");
    expect(simulated({ amount: 1.00001 }, { path: "amount", op: "equals", value: 1 })).toBe("undetermined");
    // Values kept as they are still decide.
    expect(simulated({ branch: "main" }, { path: "branch", op: "equals", value: "main" })).toBe("newly_denied");
    expect(simulated({ amount: 100.5 }, { path: "amount", op: "gt", value: 100 })).toBe("newly_denied");
    expect(simulated({ title: "Hello World" }, { path: "title", op: "equals", value: "Hello World" })).toBe("newly_denied");
  });

  it("does not compare hashes made under another key", () => {
    const other = summarizeToolArguments({ title: "Hello World" }, { detect: noDetect, hashKey: new Uint8Array(32).fill(12) });
    expect(other.kid).not.toBe(kid);
    expect(any({ path: "title", op: "equals", value: "Hello World" }, other)).toBe("unknown");
    expect(any({ path: "title", op: "not_one_of", value: ["x"] }, other)).toBe("unknown");
    const noKid = { ...summarize({ title: "Hello World" }) };
    delete noKid.kid;
    expect(any({ path: "title", op: "equals", value: "Hello World" }, noKid)).toBe("unknown");
  });

  it("reads format 2 summaries cautiously: text and non-integer numbers undetermined, integers decided", () => {
    const legacy: ToolArgumentSummary = {
      v: 2,
      fields: {
        env: { type: "string", values: ["prod"] },
        title: { type: "string", hashes: [h("Hello World")], len: "9-32" },
        limit: { type: "number", values: [50], min: 50, max: 50 },
        ratio: { type: "number", values: [1.5], min: 1.5, max: 1.5 },
        draft: { type: "boolean", values: [true] }
      }
    };
    expect(any({ path: "env", op: "equals", value: "prod" }, legacy)).toBe("unknown");
    expect(any({ path: "title", op: "equals", value: "Hello World" }, legacy)).toBe("unknown");
    expect(any({ path: "ratio", op: "gt", value: 1 }, legacy)).toBe("unknown");
    expect(any({ path: "limit", op: "gt", value: 10 }, legacy)).toBe(true);
    expect(any({ path: "draft", op: "equals", value: true }, legacy)).toBe(true);
  });

  it("reads a malformed literal as the evaluator does, whatever the summary holds", () => {
    const summary = summarize({ title: "Hello World", branch: "main " });
    for (const path of ["title", "branch"]) {
      const condition = { path, op: "not_one_of", value: "not a list" } as unknown as McpPolicyCondition;
      expect(any(condition, summary)).toBe(false);
      expect(every(condition, summary)).toBe(false);
    }
  });
});

describe("lists and wildcards", () => {
  it("reads a path ending on a list element by element", () => {
    const summary = summarize({ repos: ["alpha", "beta"] });
    expect(any({ path: "repos", op: "one_of", value: ["beta"] }, summary)).toBe(true);
    expect(every({ path: "repos", op: "one_of", value: ["beta"] }, summary)).toBe(false);
    expect(every({ path: "repos", op: "one_of", value: ["alpha", "beta"] }, summary)).toBe(true);
  });

  it("knows when every element has the rest of the path, and when one does not", () => {
    const full = summarize({ files: [{ path: "src" }, { path: "lib" }] });
    expect(every({ path: "files[*].path", op: "one_of", value: ["src", "lib"] }, full)).toBe(true);
    const gap = summarize({ files: [{ path: "src" }, { name: "x" }] });
    expect(every({ path: "files[*].path", op: "one_of", value: ["src", "lib"] }, gap)).toBe(false);
    expect(any({ path: "files[*].path", op: "one_of", value: ["src"] }, gap)).toBe(true);
  });

  it("cannot tell whether every list reached through [*] is non-empty", () => {
    const summary = summarize({ groups: [{ ids: ["a"] }, { ids: ["b"] }] });
    expect(every({ path: "groups[*].ids", op: "one_of", value: ["a", "b"] }, summary)).toBe("unknown");
    const one = summarize({ groups: [{ ids: ["a", "b"] }] });
    expect(every({ path: "groups[*].ids", op: "one_of", value: ["a", "b"] }, one)).toBe(true);
  });

  it("fails closed when the path holds more values than the evaluator reads", () => {
    const summary: ToolArgumentSummary = {
      v: 3,
      kid,
      fields: { ids: { type: "array", items: 64, count: 30 }, "ids[]": { type: "string", count: MAX_RESOLVED_VALUES + 1, values: ["a"] } }
    };
    expect(any({ path: "ids", op: "equals", value: "zzz" }, summary)).toBe(true);
    expect(every({ path: "ids", op: "equals", value: "a" }, summary)).toBe(false);
  });

  it("finds keys the summary hashed", () => {
    const summary = summarize({ "x.y": "prod" });
    const segment = Object.keys(summary.fields)[0]!;
    expect(segment).toMatch(/^<k:/);
    // A dotted key cannot be written as a policy path; a non-plain key that can is looked up by its hash.
    const odd = summarize({ "1abc": "prod" });
    expect(Object.keys(odd.fields)[0]).toBe(`<k:${h("1abc")}>`);
    expect(any({ path: "1abc", op: "equals", value: "prod" }, odd)).toBe(true);
  });
});

describe("rules against a recorded call", () => {
  const summary = summarize({ env: "prod" });

  it("leaves a rule on an unrecorded principal undetermined", () => {
    expect(evaluateRuleOnSummary(rule({ id: "r", effect: "deny", roles: ["viewer"] }), call(summary, { role: null }), context).state).toBe("unknown");
    expect(evaluateRuleOnSummary(rule({ id: "r", effect: "deny", roles: ["viewer"] }), call(summary), context).state).toBe("no_match");
    expect(evaluateRuleOnSummary(rule({ id: "c", effect: "deny", clientIds: ["mcpc_1"] }), call(summary, { clientId: undefined }), context).state).toBe("unknown");
    expect(evaluateRuleOnSummary(rule({ id: "c", effect: "deny", clientIds: ["mcpc_1"] }), call(summary, { clientId: "mcpc_1" }), context).state).toBe("match");
    expect(evaluateRuleOnSummary(rule({ id: "a", effect: "deny", annotationHint: "destructive" }), call(summary), context).state).toBe("unknown");
    expect(evaluateRuleOnSummary(rule({ id: "a", effect: "deny", annotationHint: "destructive" }), call(summary, { annotations: { readOnlyHint: true } }), context).state).toBe(
      "no_match"
    );
  });

  it("fails closed on an invalid stored rule", () => {
    expect(evaluateRuleOnSummary(rule({ id: "i", effect: "allow", invalid: true }), call(summary), context).state).toBe("no_match");
    expect(evaluateRuleOnSummary(rule({ id: "i", effect: "deny", invalid: true }), call(summary), context).state).toBe("match");
  });

  it("combines conditions with all / any three-valued", () => {
    const unknownOne: McpPolicyCondition = { path: "env", op: "starts_with", value: "p" };
    const hashed = summarize({ title: "secret plan", env: "prod" });
    const all = rule({ id: "all", effect: "deny", conditions: { all: [{ path: "title", op: "starts_with", value: "s" }, { path: "env", op: "equals", value: "dev" }] } });
    expect(evaluateRuleOnSummary(all, call(hashed), context).state).toBe("no_match");
    const anyRule = rule({ id: "any", effect: "deny", conditions: { any: [{ path: "title", op: "starts_with", value: "s" }, { path: "env", op: "equals", value: "prod" }] } });
    expect(evaluateRuleOnSummary(anyRule, call(hashed), context).state).toBe("match");
    const open = rule({ id: "open", effect: "deny", conditions: { any: [{ path: "title", op: "starts_with", value: "s" }, { path: "env", op: "equals", value: "dev" }] } });
    const state = evaluateRuleOnSummary(open, call(hashed), context);
    expect(state.state).toBe("unknown");
    expect(state.reason).toMatch(/title starts with "s": the value is kept only as a hash/);
    expect(evaluateRuleOnSummary(rule({ id: "u", effect: "deny", conditions: { all: [unknownOne] } }), call(summary), context).state).toBe("match");
  });
});

describe("current vs draft", () => {
  const summary = summarize({ env: "prod", title: "secret plan" });
  const denyProd = rule({ id: "deny_prod", effect: "deny", conditions: { all: [{ path: "env", op: "equals", value: "prod" }] } });
  const approveAll = rule({ id: "approve", effect: "require_approval" });

  it("names each change", () => {
    expect(simulationBucket("allow", "deny")).toBe("newly_denied");
    expect(simulationBucket("require_approval", "deny")).toBe("newly_denied");
    expect(simulationBucket("allow", "require_approval")).toBe("newly_needs_approval");
    expect(simulationBucket("deny", "allow")).toBe("no_longer_denied");
    expect(simulationBucket("deny", "require_approval")).toBe("no_longer_denied");
    expect(simulationBucket("require_approval", "allow")).toBe("no_longer_needs_approval");
    expect(simulationBucket("deny", "deny")).toBe("unchanged");
  });

  it("reports a determined change with the deciding rule", () => {
    const result = simulatePolicyTransition([], [denyProd], call(summary), context);
    expect(result).toMatchObject({ bucket: "newly_denied", current: { effect: "allow" }, draft: { effect: "deny", ruleId: "deny_prod" } });
    expect(simulatePolicyTransition([denyProd], [], call(summary), context).bucket).toBe("no_longer_denied");
    expect(simulatePolicyTransition([], [approveAll], call(summary), context).bucket).toBe("newly_needs_approval");
  });

  it("never counts an undetermined call as allowed or denied", () => {
    const onTitle = rule({ id: "t", effect: "deny", conditions: { all: [{ path: "title", op: "starts_with", value: "secret" }] } });
    const result = simulatePolicyTransition([], [onTitle], call(summary), context);
    expect(result.bucket).toBe("undetermined");
    expect(result.draft.effect).toBeNull();
    expect(result.reason).toMatch(/kept only as a hash/);
  });

  it("charges each reading for its decision work: matched denies times matched allows, current and draft", () => {
    // 8 rules the summary cannot decide (256 readings), and 40 denies and 40 allows that all match.
    const undecided = Array.from({ length: 8 }, (_, index) =>
      rule({ id: `u${index}`, effect: "deny", conditions: { all: [{ path: "title", op: "starts_with", value: `x${index}` }] } })
    );
    const denies = Array.from({ length: 40 }, (_, index) => rule({ id: `d${index}`, effect: "deny", roles: ["builder", "operator"], description: `d${index}` }));
    const allows = Array.from({ length: 40 }, (_, index) => rule({ id: `a${index}`, effect: "allow", description: `a${index}` }));
    const rules = [...undecided, ...denies, ...allows];
    const result = simulatePolicyTransition(rules, rules, call(summary), context);
    // Every reading compares at least the 40 matched denies with the 40 matched allows, on both sides.
    expect(result.work).toBeGreaterThanOrEqual(256 * 2 * 40 * 40);
    expect(decisionWork([...denies, ...allows])).toBe(80 + 40 * 40);
    expect(decisionWork([rule({ id: "r", effect: "require_approval" }), ...denies.slice(0, 2), ...allows.slice(0, 3)])).toBe(6 + 3 * 4);
  });

  it("is determined when every reading lands in the same bucket", () => {
    const onTitle = rule({ id: "t", effect: "deny", conditions: { all: [{ path: "title", op: "starts_with", value: "secret" }] } });
    // The same undecidable rule on both sides: whatever it decides, nothing changes.
    expect(simulatePolicyTransition([onTitle], [onTitle], call(summary), context).bucket).toBe("unchanged");
    // An unconditional deny in the draft wins whatever the undecidable rule does.
    const denyAll = rule({ id: "all", effect: "deny" });
    expect(simulatePolicyTransition([onTitle], [onTitle, denyAll], call(summary), context)).toMatchObject({ bucket: "undetermined" });
    expect(simulatePolicyTransition([], [denyAll, onTitle], call(summary), context)).toMatchObject({ bucket: "newly_denied", draft: { effect: "deny", ruleId: "all" } });
    // The deciding rule depends on the undecidable one: the effect is known, the rule is not named.
    const second = simulatePolicyTransition([], [onTitle, denyAll], call(summary), context);
    expect(second).toMatchObject({ bucket: "newly_denied", draft: { effect: "deny" } });
    expect(second.draft.ruleId).toBeUndefined();
  });

  it("ignores shadow rules, which never change an outcome", () => {
    const shadow = { ...denyProd, id: "shadow", mode: "shadow" as const };
    expect(simulatePolicyTransition([], [shadow], call(summary), context).bucket).toBe("unchanged");
  });

  it("gives up past the undecided-rule cap", () => {
    const many = Array.from({ length: MAX_UNDECIDED_RULES_PER_CALL + 1 }, (_, index) =>
      rule({ id: `u${index}`, effect: "deny", conditions: { all: [{ path: "title", op: "starts_with", value: `s${index}` }] } })
    );
    expect(simulatePolicyTransition([], many, call(summary), context).bucket).toBe("undetermined");
  });

  it("applies carve-outs the way the evaluator does", () => {
    const denyServer = rule({ id: "deny_srv", effect: "deny", serverId: "mcp_github" });
    const allowTool = rule({ id: "allow_tool", effect: "allow", serverId: "mcp_github", toolPattern: "create_issue", conditions: { all: [{ path: "env", op: "one_of", value: ["prod", "dev"] }] } });
    expect(simulatePolicyTransition([], [denyServer, allowTool], call(summary), context)).toMatchObject({ bucket: "unchanged", draft: { effect: "allow" } });
    expect(simulatePolicyTransition([], [denyServer, allowTool], call(summary, { toolName: "delete_repo" }), context).bucket).toBe("newly_denied");
    const other = summarize({ env: "staging" });
    expect(simulatePolicyTransition([], [denyServer, allowTool], call(other), context).bucket).toBe("newly_denied");
  });
});

// ---------------------------------------------------------------------------
// Property test: whenever the simulator decides, it agrees with the evaluator.
// ---------------------------------------------------------------------------

function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe("agreement with the evaluator on real arguments", () => {
  const random = seeded(20261030);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  // Texts and numbers include forms the summary keeps differently: surrounding whitespace, compatibility
  // characters, digits past the fourth decimal, and location numbers that are hashed under a sensitive key.
  const tokens = ["prod", "dev", "main", "alpha", "beta", "read", "write"];
  const texts = ["Quarterly report", "Hello World", "release-2026", "PROD", "Prod", "0042", "42", "5.0", "true", "main ", " prod", "ｍａｉｎ", "Ｈello World "];
  const numbers = [0, 1, 5, 42, 51.47, 51.5, 51.5074, 99.5, 100, 100.00004, 1.00001, 250, 1000, 12345678, -3];
  const keys = ["env", "repo", "title", "limit", "count", "tags", "items", "lat", "flag", "1abc", "address"];

  const scalar = (): unknown => {
    const roll = random();
    if (roll < 0.3) return pick(tokens);
    if (roll < 0.5) return pick(texts);
    if (roll < 0.75) return pick(numbers);
    if (roll < 0.85) return random() < 0.5;
    if (roll < 0.9) return null;
    if (roll < 0.93) return `p${"x".repeat(2100)}`;
    return { nested: pick(tokens) };
  };
  const value = (depth: number): unknown => {
    if (depth < 2 && random() < 0.25) {
      // Mostly short lists; sometimes past the summary's 16 kept values or its 64 walked items.
      const length = random() < 0.9 ? Math.floor(random() * 4) : pick([20, 70]);
      return Array.from({ length }, (_, index) => (length > 4 ? `${pick(tokens)}${String.fromCharCode(97 + (index % 26))}` : random() < 0.3 ? value(depth + 1) : scalar()));
    }
    if (depth < 2 && random() < 0.1) return { name: scalar(), id: scalar() };
    if (depth < 2 && random() < 0.08) return { lat: pick(numbers), lng: scalar() };
    return scalar();
  };
  const args = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    const count = 1 + Math.floor(random() * 4);
    for (let index = 0; index < count; index += 1) out[pick(keys)] = value(0);
    return out;
  };
  const literal = (): string | number | boolean | null => {
    const roll = random();
    if (roll < 0.3) return pick(tokens);
    if (roll < 0.55) return pick(texts);
    if (roll < 0.85) return pick(numbers);
    if (roll < 0.95) return random() < 0.5;
    return null;
  };
  const path = (): string => {
    const key = pick(keys);
    const roll = random();
    if (roll < 0.6) return key;
    if (roll < 0.75) return `${key}[*]`;
    if (roll < 0.9) return `${key}[*].${pick(["name", "id"])}`;
    return `${key}.${pick(["name", "id", "nested", "lat", "lng"])}`;
  };
  const condition = (): McpPolicyCondition => {
    const op = pick(["equals", "one_of", "not_one_of", "starts_with", "ends_with", "matches", "lt", "lte", "gt", "gte", "between", "exists", "label_absent"] as const);
    const ignoreCase = random() < 0.2;
    switch (op) {
      case "equals":
        return { path: path(), op, value: literal(), ...(ignoreCase ? { ignoreCase } : {}) };
      case "one_of":
      case "not_one_of":
        return { path: path(), op, value: [literal(), literal()], ...(ignoreCase ? { ignoreCase } : {}) };
      case "starts_with":
      case "ends_with":
        return { path: path(), op, value: pick(["p", "Q", "re", "a", "4"]), ...(ignoreCase ? { ignoreCase } : {}) };
      case "matches":
        return { path: path(), op, value: pick(["p*", "*a*", "?e*", "*rt"]) };
      case "between":
        return { path: path(), op, value: [pick([0, 10, 50]), pick([60, 100, 1000])] };
      case "exists":
        return { path: path(), op, ...(random() < 0.3 ? { value: false } : {}) };
      case "label_absent":
        return { op, value: "email" };
      default:
        return { path: path(), op, value: pick(numbers) };
    }
  };
  const effects: McpToolPolicyEffect[] = ["allow", "deny", "require_approval"];
  const randomRule = (index: number): McpToolPolicyRule =>
    rule({
      id: `r${index}`,
      effect: pick(effects),
      ...(random() < 0.3 ? { toolPattern: pick(["create_issue", "delete_*", "*"]) } : {}),
      ...(random() < 0.85 ? { conditions: random() < 0.7 ? { all: [condition(), ...(random() < 0.4 ? [condition()] : [])] } : { any: [condition(), condition()] } } : {})
    });

  it("never contradicts the evaluator on 10,000 random calls and rule sets", () => {
    let determined = 0;
    let undetermined = 0;
    const seen = { truncated: 0, more: 0, lengthOnly: 0, hashed: 0, adjusted: 0, hashedLocation: 0 };
    for (let trial = 0; trial < 10_000; trial += 1) {
      const callArgs = args();
      const rules = Array.from({ length: 1 + Math.floor(random() * 3) }, (_, index) => randomRule(index));
      const toolName = pick(["create_issue", "delete_repo"]);
      const gateway = random() < 0.5;
      const recorded = call(summarize(callArgs), { toolName, labels: gateway ? "none" : "unknown" });
      const fields = Object.values(recorded.summary.fields);
      if (recorded.summary.truncated) seen.truncated += 1;
      if (fields.some((field) => field.more)) seen.more += 1;
      if (fields.some((field) => field.len === "2049+")) seen.lengthOnly += 1;
      if (fields.some((field) => field.hashes?.length)) seen.hashed += 1;
      if (fields.some((field) => field.adj)) seen.adjusted += 1;
      if (Object.entries(recorded.summary.fields).some(([key, field]) => /^address\.lat$/.test(key) && field.hashes?.length)) seen.hashedLocation += 1;
      const real = evaluateMcpToolPolicy(rules, {
        role: "builder",
        projectId: "default",
        adapterId: "http_mcp",
        registryServerId: "mcp_github",
        toolName,
        workflowId: "wf_1",
        clientId: null,
        arguments: callArgs,
        dataLabels: null
      });
      for (const each of rules) {
        const simulated = evaluateRuleOnSummary(each, recorded, context);
        if (simulated.state === "unknown") continue;
        const realMatch = real.matchedRules.includes(each);
        if ((simulated.state === "match") !== realMatch) {
          throw new Error(`rule ${JSON.stringify(each.conditions)} effect ${each.effect} on ${JSON.stringify(callArgs)}: simulated ${simulated.state}, real ${realMatch}`);
        }
      }
      const transition = simulatePolicyTransition([], rules, recorded, context);
      if (transition.bucket === "undetermined") {
        undetermined += 1;
        continue;
      }
      determined += 1;
      expect(transition.draft.effect).toBe(real.effect);
    }
    // Most calls decide; the test would be vacuous otherwise.
    expect(determined).toBeGreaterThan(5000);
    // The generator reaches every lossy part of a summary.
    expect(Math.min(seen.truncated, seen.more, seen.lengthOnly)).toBeGreaterThan(20);
    expect(seen.hashed).toBeGreaterThan(1000);
    expect(seen.adjusted).toBeGreaterThan(500);
    expect(seen.hashedLocation).toBeGreaterThan(20);
    expect(undetermined).toBeGreaterThan(200);
    // 10,000 trials take a few seconds locally and longer on a shared CI runner.
  }, 60_000);
});
