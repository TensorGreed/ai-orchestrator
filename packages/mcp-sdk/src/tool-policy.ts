import { createHash } from "node:crypto";
import {
  canonicalMcpToolPolicyRule,
  conditionList,
  parseMcpPolicyPath,
  type McpHiddenTool,
  type McpPolicyCondition,
  type McpPolicyKind,
  type McpPolicyPathStep,
  type McpPolicyRole,
  type McpPolicyScalar,
  type McpToolAnnotations,
  type McpToolClassification,
  type McpToolHintCondition,
  type McpToolPolicyDecisionRecord,
  type McpToolPolicyEffect,
  type McpToolPolicyMode,
  type McpToolPolicyRule
} from "@ai-orchestrator/shared";

/**
 * Phase 10.2 — MCP tool policy evaluation. Pure functions shared by the
 * workflow engine (discovery filter and call-time check) and the API
 * (dry-run evaluator, discovery marking).
 *
 * Evaluation order for one tool call:
 *   1. Collect the enabled rules whose scope matches the call: kind (tool,
 *      resource, prompt or sampling), project, role, server, tool pattern and
 *      (Phase 10.5) annotation hint must all match.
 *   2. No matching rule → allowed (the default; installs without rules behave
 *      as before).
 *   3. No matching deny rule → allowed.
 *   4. A matching deny rule is set aside when a matching allow rule is
 *      strictly narrower than it: the allow's scope sits inside the deny's in
 *      every field and is smaller in at least one. That is how an allow rule
 *      carves an exception out of a broader deny.
 *   5. Any matching deny rule left → denied by the first such rule (rules are
 *      considered in the order given, oldest first). Deny wins every tie.
 *
 * Phase 12.4 — argument-aware rules:
 *   - Scope also covers workflows (`workflowIds`) and gateway clients
 *     (`clientIds`); an empty list matches every workflow / caller.
 *   - A rule with `conditions` matches a call only when they hold for the
 *     call's arguments and data labels (`all` or `any` of them). An argument
 *     path that does not resolve, or a value of the wrong type, makes that
 *     condition false; label conditions are false when the run does not
 *     track labels.
 *   - Effects: deny > require_approval > allow. A deny is set aside by a
 *     strictly narrower allow or require_approval rule (the call is then
 *     allowed, or needs approval); a require_approval is set aside by a
 *     strictly narrower allow. A rule with conditions is narrower than the
 *     same scope without them; two rules with different conditions are never
 *     nested (conditions are compared by their canonical form).
 *   - Discovery (no arguments yet): a rule with conditions cannot be decided.
 *     Its deny or require_approval does not hide the tool, and its allow
 *     counts as a possible carve-out, so a tool is only hidden when some
 *     unconditional deny blocks every call. The call itself is checked again
 *     with its arguments.
 *   - Shadow rules (`mode: "shadow"`) never change the outcome. When one
 *     matches, the decision also says what the outcome would have been with
 *     the shadow rules enforced (`shadow`), for logging.
 */

export interface McpToolPolicyRequest {
  /**
   * Phase 10.5 — what is being asked for. Defaults to `tool`. For
   * `resource` the `toolName` is the resource URI, for `prompt` the prompt
   * name and for `sampling` the model name the request resolves to.
   */
  kind?: McpPolicyKind;
  projectId?: string | null;
  role: McpPolicyRole;
  /** Adapter id the tool's server runs on (`http_mcp`, `stdio_mcp`, `mock-mcp`, ...). */
  adapterId: string;
  /** Registry entry the server came from; absent for servers configured inline on a node. */
  registryServerId?: string;
  toolName: string;
  /** Phase 10.5 — the tool's annotations, for rules with an `annotationHint`. */
  annotations?: McpToolAnnotations | null;
  /** Admin read-only override; it also decides `read_only` / `destructive` hints. */
  manualReadOnly?: boolean | null;
  /** Phase 12.4 — the workflow whose run makes the call; absent for gateway calls. */
  workflowId?: string | null;
  /** Phase 12.4 — the MCP gateway client making the call (directly or through a run it started). */
  clientId?: string | null;
  /**
   * Phase 12.4 — the call's arguments. Absent at discovery, when no call is
   * being made yet: rules with conditions are then undecided (see above).
   */
  arguments?: Record<string, unknown>;
  /** Phase 12.4 — the run's data labels at the call; absent when the run does not track labels. */
  dataLabels?: { provenance: readonly string[]; dataClasses: readonly string[] } | null;
}

/**
 * Phase 10.5 — a tool's annotation hints with the MCP defaults filled in, the
 * way the spec defines a missing hint: `readOnlyHint` false,
 * `destructiveHint` true, `idempotentHint` false, `openWorldHint` true. An
 * admin's read-only override replaces `readOnlyHint`. `destructiveHint: true`
 * wins over `readOnlyHint: true` (a server claiming both is not read-only).
 * `destructiveHint` and `idempotentHint` only mean something for a tool that
 * is not read-only, so a read-only tool is never destructive. A tool without annotations therefore
 * counts as destructive and open-world, which is the safe reading for deny
 * rules.
 */
export interface EffectiveToolHints {
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
  openWorld: boolean;
}

export function effectiveToolHints(
  annotations?: McpToolAnnotations | null,
  manualReadOnly?: boolean | null
): EffectiveToolHints {
  const readOnly =
    typeof manualReadOnly === "boolean" ? manualReadOnly : annotations?.readOnlyHint === true && annotations?.destructiveHint !== true;
  return {
    readOnly,
    destructive: readOnly ? false : annotations?.destructiveHint !== false,
    idempotent: readOnly ? true : annotations?.idempotentHint === true,
    openWorld: annotations?.openWorldHint !== false
  };
}

const HINT_KEYS: Record<string, keyof EffectiveToolHints> = {
  destructive: "destructive",
  read_only: "readOnly",
  idempotent: "idempotent",
  open_world: "openWorld"
};

/** True when the tool's effective hints satisfy `condition`; a null condition matches every tool. */
export function matchesHintCondition(
  condition: McpToolHintCondition | null | undefined,
  hints: EffectiveToolHints
): boolean {
  if (!condition) return true;
  const negated = condition.startsWith("not_");
  const key = HINT_KEYS[negated ? condition.slice(4) : condition];
  if (!key) return false;
  return negated ? !hints[key] : hints[key];
}

/** Human-readable form of a hint condition, for messages and the UI. */
export function describeHintCondition(condition: McpToolHintCondition): string {
  const negated = condition.startsWith("not_");
  const base = (negated ? condition.slice(4) : condition).replace("_", "-");
  return negated ? `not ${base}` : base;
}

export interface McpToolPolicyDecision {
  /** False only when the outcome is `deny`; a call that needs approval is allowed once approved. */
  allowed: boolean;
  /** Phase 12.4 — the enforced outcome. */
  effect: McpToolPolicyEffect;
  /** `default`: no rule matched. `rule`: decided by `rule`. */
  decidedBy: "default" | "rule";
  rule?: McpToolPolicyRule;
  /** Every enabled, enforced rule that matched, in evaluation order. */
  matchedRules: McpToolPolicyRule[];
  /** Deny rules that a narrower allow (or require_approval) rule set aside. */
  overriddenDenies: Array<{ deny: McpToolPolicyRule; by: McpToolPolicyRule }>;
  /** Phase 12.4 — require_approval rules that a narrower allow rule set aside. */
  overriddenApprovals?: Array<{ approval: McpToolPolicyRule; by: McpToolPolicyRule }>;
  /** Phase 12.4 — rules with conditions that could not be decided (discovery: no arguments yet). */
  undecided?: McpToolPolicyRule[];
  /**
   * Phase 12.4 — present when a shadow rule matched: the outcome had the
   * matching shadow rules been enforced too. Never applied.
   */
  shadow?: {
    effect: McpToolPolicyEffect;
    rule?: McpToolPolicyRule;
    matchedRules: McpToolPolicyRule[];
    /** True when the shadow rules would have changed the outcome. */
    changed: boolean;
  };
}

const globCache = new Map<string, RegExp>();

function globToRegExp(pattern: string): RegExp {
  const cached = globCache.get(pattern);
  if (cached) return cached;
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  const regex = new RegExp(`^${source}$`);
  globCache.set(pattern, regex);
  return regex;
}

export function isToolGlob(pattern: string): boolean {
  return pattern.includes("*");
}

/** Exact match, or glob where `*` matches any run of characters (including none). */
export function matchesToolPattern(pattern: string, toolName: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed || trimmed === "*") return true;
  if (!isToolGlob(trimmed)) return trimmed === toolName;
  return globToRegExp(trimmed).test(toolName);
}

/**
 * A rule's `serverId` names a registry entry, or an adapter id for servers
 * configured inline. An adapter id never matches a registry server, so a rule
 * on `http_mcp` does not reach every registered HTTP server.
 */
export function matchesPolicyServer(ruleServerId: string | null, request: Pick<McpToolPolicyRequest, "adapterId" | "registryServerId">): boolean {
  if (!ruleServerId) return true;
  if (request.registryServerId) return ruleServerId === request.registryServerId;
  return ruleServerId === request.adapterId;
}

/** A rule's kind; rules written before kinds existed govern tool calls. */
export function policyRuleKind(rule: Pick<McpToolPolicyRule, "kind">): McpPolicyKind {
  return rule.kind ?? "tool";
}

/** Phase 12.4 — absent means `enforce`. */
export function policyRuleMode(rule: Pick<McpToolPolicyRule, "mode">): McpToolPolicyMode {
  return rule.mode === "shadow" ? "shadow" : "enforce";
}

/** True when a rule has at least one condition. */
export function policyRuleHasConditions(rule: Pick<McpToolPolicyRule, "conditions">): boolean {
  return conditionList(rule.conditions).items.length > 0;
}

/** Whether the rule's scope covers the call: everything but its conditions. */
export function ruleScopeMatches(rule: McpToolPolicyRule, request: McpToolPolicyRequest): boolean {
  if (!rule.enabled) return false;
  if (policyRuleKind(rule) !== (request.kind ?? "tool")) return false;
  if (rule.projectId && rule.projectId !== (request.projectId ?? null)) return false;
  if (rule.roles.length > 0 && !rule.roles.includes(request.role)) return false;
  if (rule.workflowIds?.length && !(request.workflowId && rule.workflowIds.includes(request.workflowId))) return false;
  if (rule.clientIds?.length && !(request.clientId && rule.clientIds.includes(request.clientId))) return false;
  if (!matchesPolicyServer(rule.serverId, request)) return false;
  if (!matchesToolPattern(rule.toolPattern, request.toolName)) return false;
  if (rule.annotationHint) {
    return matchesHintCondition(rule.annotationHint, effectiveToolHints(request.annotations, request.manualReadOnly));
  }
  return true;
}

/**
 * Whether the rule matches the call: scope, then conditions. `undecided`
 * when the scope matches but the rule has conditions and the request carries
 * no arguments (discovery).
 */
export function ruleMatchState(rule: McpToolPolicyRule, request: McpToolPolicyRequest): "match" | "no_match" | "undecided" {
  if (!ruleScopeMatches(rule, request)) return "no_match";
  if (!policyRuleHasConditions(rule)) return "match";
  if (request.arguments === undefined) return "undecided";
  return matchesPolicyConditions(rule.conditions, request.arguments, request.dataLabels) ? "match" : "no_match";
}

export function ruleMatches(rule: McpToolPolicyRule, request: McpToolPolicyRequest): boolean {
  return ruleMatchState(rule, request) === "match";
}

// ---------------------------------------------------------------------------
// Phase 12.4 — conditions
// ---------------------------------------------------------------------------

/** At most this many values are read through `[*]` steps for one condition. */
const MAX_RESOLVED_VALUES = 1000;

const pathCache = new Map<string, McpPolicyPathStep[] | null>();

function pathSteps(path: string): McpPolicyPathStep[] | null {
  if (pathCache.has(path)) return pathCache.get(path)!;
  const steps = parseMcpPolicyPath(path);
  if (pathCache.size > 2000) pathCache.clear();
  pathCache.set(path, steps);
  return steps;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Every value at `path` in `root`; empty when the path does not resolve. */
export function resolvePolicyPath(root: unknown, path: string): unknown[] {
  const steps = pathSteps(path);
  if (!steps) return [];
  let current: unknown[] = [root];
  for (const step of steps) {
    const next: unknown[] = [];
    for (const value of current) {
      if ("key" in step) {
        if (isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, step.key)) next.push(value[step.key]);
      } else if ("index" in step) {
        if (Array.isArray(value) && step.index < value.length) next.push(value[step.index]);
      } else if (Array.isArray(value)) {
        next.push(...value.slice(0, MAX_RESOLVED_VALUES));
      }
      if (next.length >= MAX_RESOLVED_VALUES) break;
    }
    current = next.slice(0, MAX_RESOLVED_VALUES);
    if (current.length === 0) return [];
  }
  return current.filter((value) => value !== undefined);
}

function isScalar(value: unknown): value is McpPolicyScalar {
  return value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

function sameScalar(left: McpPolicyScalar, right: unknown): boolean {
  return isScalar(right) && left === right;
}

const valueGlobCache = new Map<string, RegExp>();

/** Glob for argument values: `*` any run of characters, `?` one character; everything else literal. */
export function matchesValueGlob(pattern: string, value: string): boolean {
  let regex = valueGlobCache.get(pattern);
  if (!regex) {
    const source = [...pattern]
      .map((char) => (char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.+?^${}()|[\]\\]/g, "\\$&")))
      .join("");
    regex = new RegExp(`^${source}$`, "s");
    if (valueGlobCache.size > 2000) valueGlobCache.clear();
    valueGlobCache.set(pattern, regex);
  }
  return regex.test(value);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** One value against one argument operator; false for a value of the wrong type. */
function valueSatisfies(condition: McpPolicyCondition, value: unknown): boolean {
  const expected = condition.value;
  switch (condition.op) {
    case "equals":
      return !Array.isArray(expected) && expected !== undefined && sameScalar(expected, value);
    case "one_of":
      return Array.isArray(expected) && isScalar(value) && expected.some((entry) => entry === value);
    case "not_one_of":
      return Array.isArray(expected) && isScalar(value) && !expected.some((entry) => entry === value);
    case "starts_with":
      return typeof expected === "string" && typeof value === "string" && value.startsWith(expected);
    case "ends_with":
      return typeof expected === "string" && typeof value === "string" && value.endsWith(expected);
    case "matches":
      return typeof expected === "string" && typeof value === "string" && matchesValueGlob(expected, value);
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      const actual = numberValue(value);
      const limit = numberValue(expected);
      if (actual === undefined || limit === undefined) return false;
      if (condition.op === "lt") return actual < limit;
      if (condition.op === "lte") return actual <= limit;
      if (condition.op === "gt") return actual > limit;
      return actual >= limit;
    }
    case "between": {
      const actual = numberValue(value);
      if (actual === undefined || !Array.isArray(expected) || expected.length !== 2) return false;
      const min = numberValue(expected[0]);
      const max = numberValue(expected[1]);
      return min !== undefined && max !== undefined && actual >= min && actual <= max;
    }
    default:
      return false;
  }
}

/**
 * One condition against a call. Pure and total: malformed conditions, paths
 * that do not resolve and values of the wrong type all make it false (except
 * `exists: false`, which holds exactly when the path has no value).
 */
export function evaluatePolicyCondition(
  condition: McpPolicyCondition,
  args: Record<string, unknown>,
  labels?: McpToolPolicyRequest["dataLabels"]
): boolean {
  if (condition.op === "label_present" || condition.op === "label_absent") {
    if (!labels || typeof condition.value !== "string") return false;
    const present = labels.provenance.includes(condition.value) || labels.dataClasses.includes(condition.value);
    return condition.op === "label_present" ? present : !present;
  }
  if (typeof condition.path !== "string") return false;
  const values = resolvePolicyPath(args, condition.path);
  if (condition.op === "exists") {
    const exists = values.some((value) => value !== null);
    return condition.value === false ? !exists : exists;
  }
  return values.some((value) => valueSatisfies(condition, value));
}

/** True when the conditions hold (`all`: every one, `any`: at least one); a rule without conditions always holds. */
export function matchesPolicyConditions(
  conditions: McpToolPolicyRule["conditions"],
  args: Record<string, unknown>,
  labels?: McpToolPolicyRequest["dataLabels"]
): boolean {
  const { combine, items } = conditionList(conditions);
  if (items.length === 0) return true;
  return combine === "any"
    ? items.some((condition) => evaluatePolicyCondition(condition, args, labels))
    : items.every((condition) => evaluatePolicyCondition(condition, args, labels));
}

/** Phase 12.4 — sha256 of the rule's canonical form (see `canonicalMcpToolPolicyRule`). */
export function hashMcpToolPolicyRule(rule: McpToolPolicyRule): string {
  return createHash("sha256").update(canonicalMcpToolPolicyRule(rule)).digest("hex");
}

/** True when any enabled rule needs the tool's annotations to decide whether it matches. */
export function policyNeedsAnnotations(rules: readonly McpToolPolicyRule[]): boolean {
  return rules.some((rule) => rule.enabled && Boolean(rule.annotationHint));
}

/** Phase 12.4 — true when any enabled rule has conditions, so the call's arguments (or labels) can change its outcome. */
export function policyNeedsArguments(rules: readonly McpToolPolicyRule[]): boolean {
  return rules.some((rule) => rule.enabled && policyRuleHasConditions(rule));
}

/**
 * Pattern containment, conservatively: `inner ⊆ outer` when they are equal,
 * when outer is `*`, or when inner is an exact name the outer glob matches.
 * Two different globs are never treated as nested.
 */
function patternWithin(inner: string, outer: string): boolean {
  const a = inner.trim() || "*";
  const b = outer.trim() || "*";
  if (a === b || b === "*") return true;
  if (!isToolGlob(a) && isToolGlob(b)) return matchesToolPattern(b, a);
  return false;
}

function rolesWithin(inner: McpPolicyRole[], outer: McpPolicyRole[]): boolean {
  if (outer.length === 0) return true;
  if (inner.length === 0) return false;
  return inner.every((role) => outer.includes(role));
}

function scalarWithin(inner: string | null | undefined, outer: string | null | undefined): boolean {
  return outer === null || outer === undefined || inner === outer;
}

/** An empty list covers everything; otherwise `inner` must be non-empty and inside `outer`. */
function idsWithin(inner: readonly string[] | undefined, outer: readonly string[] | undefined): boolean {
  if (!outer || outer.length === 0) return true;
  if (!inner || inner.length === 0) return false;
  return inner.every((id) => outer.includes(id));
}

const canonicalConditionsCache = new WeakMap<object, string>();

function canonicalConditions(rule: McpToolPolicyRule): string {
  const conditions = rule.conditions;
  if (!conditions) return "";
  const cached = canonicalConditionsCache.get(conditions);
  if (cached !== undefined) return cached;
  // Only the conditions part of the canonical rule matters here.
  const text = canonicalMcpToolPolicyRule({ ...rule, effect: "deny", kind: "tool", projectId: null, roles: [], workflowIds: [], clientIds: [], serverId: null, toolPattern: "*", annotationHint: null });
  canonicalConditionsCache.set(conditions, text);
  return text;
}

/** No conditions covers every call; otherwise only the same conditions (canonically) count as inside. */
function conditionsWithin(inner: McpToolPolicyRule, outer: McpToolPolicyRule): boolean {
  if (!policyRuleHasConditions(outer)) return true;
  if (!policyRuleHasConditions(inner)) return false;
  return canonicalConditions(inner) === canonicalConditions(outer);
}

function scopeWithin(inner: McpToolPolicyRule, outer: McpToolPolicyRule): boolean {
  return (
    scalarWithin(inner.projectId, outer.projectId) &&
    rolesWithin(inner.roles, outer.roles) &&
    idsWithin(inner.workflowIds, outer.workflowIds) &&
    idsWithin(inner.clientIds, outer.clientIds) &&
    scalarWithin(inner.serverId, outer.serverId) &&
    patternWithin(inner.toolPattern, outer.toolPattern) &&
    scalarWithin(inner.annotationHint, outer.annotationHint) &&
    conditionsWithin(inner, outer)
  );
}

/** True when `inner`'s scope sits inside `outer`'s in every field and is smaller in at least one. */
export function isStrictlyNarrower(inner: McpToolPolicyRule, outer: McpToolPolicyRule): boolean {
  if (policyRuleKind(inner) !== policyRuleKind(outer)) return false;
  return scopeWithin(inner, outer) && !scopeWithin(outer, inner);
}

interface PolicyOutcome {
  effect: McpToolPolicyEffect;
  rule?: McpToolPolicyRule;
  overriddenDenies: McpToolPolicyDecision["overriddenDenies"];
  overriddenApprovals: NonNullable<McpToolPolicyDecision["overriddenApprovals"]>;
}

/** Precedence over the rules that matched: deny > require_approval > allow, with strictly narrower carve-outs. */
function decideOutcome(matched: readonly McpToolPolicyRule[], possibleCarveOuts: readonly McpToolPolicyRule[]): PolicyOutcome {
  const allows = [...matched.filter((rule) => rule.effect === "allow"), ...possibleCarveOuts.filter((rule) => rule.effect === "allow")];
  const approvals = matched.filter((rule) => rule.effect === "require_approval");
  const denies = matched.filter((rule) => rule.effect === "deny");
  const overriddenDenies: PolicyOutcome["overriddenDenies"] = [];
  const overriddenApprovals: PolicyOutcome["overriddenApprovals"] = [];
  let blocking: McpToolPolicyRule | undefined;
  const carvedToApproval: McpToolPolicyRule[] = [];
  for (const deny of denies) {
    const carve = allows.find((allow) => isStrictlyNarrower(allow, deny)) ?? approvals.find((approval) => isStrictlyNarrower(approval, deny));
    if (carve) {
      overriddenDenies.push({ deny, by: carve });
      if (carve.effect === "require_approval") carvedToApproval.push(carve);
    } else if (!blocking) {
      blocking = deny;
    }
  }
  if (blocking) return { effect: "deny", rule: blocking, overriddenDenies, overriddenApprovals };
  let pending: McpToolPolicyRule | undefined;
  for (const approval of approvals) {
    const carve = allows.find((allow) => isStrictlyNarrower(allow, approval));
    if (carve) {
      overriddenApprovals.push({ approval, by: carve });
    } else if (!pending) {
      pending = approval;
    }
  }
  if (pending) return { effect: "require_approval", rule: pending, overriddenDenies, overriddenApprovals };
  const matchedAllows = matched.filter((rule) => rule.effect === "allow");
  const deciding =
    overriddenDenies.find((entry) => entry.by.effect === "allow")?.by ?? overriddenApprovals[0]?.by ?? matchedAllows[0] ?? carvedToApproval[0];
  return { effect: "allow", ...(deciding ? { rule: deciding } : {}), overriddenDenies, overriddenApprovals };
}

export function evaluateMcpToolPolicy(
  rules: readonly McpToolPolicyRule[],
  request: McpToolPolicyRequest
): McpToolPolicyDecision {
  const matchedAll: McpToolPolicyRule[] = [];
  const undecided: McpToolPolicyRule[] = [];
  for (const rule of rules) {
    const state = ruleMatchState(rule, request);
    if (state === "match") matchedAll.push(rule);
    else if (state === "undecided") undecided.push(rule);
  }
  // Discovery: an undecided allow may carve an exception for some calls, so it keeps a tool visible.
  const carveOuts = (shadowToo: boolean) => undecided.filter((rule) => shadowToo || policyRuleMode(rule) === "enforce");
  const matchedRules = matchedAll.filter((rule) => policyRuleMode(rule) === "enforce");
  const enforced = decideOutcome(matchedRules, carveOuts(false));
  const decision: McpToolPolicyDecision = {
    allowed: enforced.effect !== "deny",
    effect: enforced.effect,
    decidedBy: enforced.rule && matchedRules.length > 0 ? "rule" : "default",
    ...(enforced.rule && matchedRules.length > 0 ? { rule: enforced.rule } : {}),
    matchedRules,
    overriddenDenies: enforced.overriddenDenies,
    ...(enforced.overriddenApprovals.length > 0 ? { overriddenApprovals: enforced.overriddenApprovals } : {}),
    ...(undecided.length > 0 ? { undecided } : {})
  };
  const shadowMatched = matchedAll.filter((rule) => policyRuleMode(rule) === "shadow");
  if (shadowMatched.length > 0) {
    const withShadow = decideOutcome(matchedAll, carveOuts(true));
    decision.shadow = {
      effect: withShadow.effect,
      ...(withShadow.rule ? { rule: withShadow.rule } : {}),
      matchedRules: shadowMatched,
      changed: withShadow.effect !== enforced.effect
    };
  }
  return decision;
}

/**
 * Phase 12.4 — the record of one call's decision for the run trace and the
 * telemetry row; undefined when no rule (enforced or shadow) matched.
 */
export function policyDecisionRecord(
  decision: McpToolPolicyDecision,
  approval?: McpToolPolicyDecisionRecord["approval"]
): McpToolPolicyDecisionRecord | undefined {
  const shadowRules = decision.shadow?.matchedRules ?? [];
  if (decision.matchedRules.length === 0 && shadowRules.length === 0) return undefined;
  return {
    effect: decision.effect,
    decidedBy: decision.decidedBy,
    ...(decision.rule ? { ruleId: decision.rule.id, ruleHash: hashMcpToolPolicyRule(decision.rule) } : {}),
    ...(decision.rule?.name ? { ruleName: decision.rule.name } : {}),
    ...(approval && decision.effect === "require_approval" ? { approval } : {}),
    matched: [...decision.matchedRules, ...shadowRules].map((rule) => ({ ruleId: rule.id, mode: policyRuleMode(rule), effect: rule.effect })),
    ...(decision.shadow
      ? {
          shadow: {
            effect: decision.shadow.effect,
            ...(decision.shadow.rule ? { ruleId: decision.shadow.rule.id, ruleHash: hashMcpToolPolicyRule(decision.shadow.rule) } : {}),
            ...(decision.shadow.rule?.name ? { ruleName: decision.shadow.rule.name } : {}),
            changed: decision.shadow.changed
          }
        }
      : {})
  };
}

/**
 * Read-only classification. Order: an admin's manual override (registry
 * servers only) wins in both directions; otherwise the server's
 * `readOnlyHint` annotation, except that `destructiveHint: true` always wins
 * over it; otherwise the tool counts as a write tool.
 */
export function classifyMcpTool(input: {
  manualReadOnly?: boolean | null;
  annotations?: McpToolAnnotations | null;
}): McpToolClassification {
  if (typeof input.manualReadOnly === "boolean") {
    return { readOnly: input.manualReadOnly, source: "manual" };
  }
  if (input.annotations?.destructiveHint === true) {
    return { readOnly: false, source: "annotation" };
  }
  const hint = input.annotations?.readOnlyHint;
  if (typeof hint === "boolean") {
    return { readOnly: hint, source: "annotation" };
  }
  return { readOnly: false, source: "unknown" };
}

export interface McpToolAccessInput extends McpToolPolicyRequest {
  rules: readonly McpToolPolicyRule[];
  noWriteTools?: boolean;
  /** Display name for the server in messages (a registry server's name); ids are used when omitted. */
  serverLabel?: string;
}

export interface McpToolAccessDecision {
  allowed: boolean;
  reason?: McpHiddenTool["reason"];
  ruleId?: string;
  ruleName?: string;
  policy: McpToolPolicyDecision;
  classification: McpToolClassification;
  /** Human-readable explanation when the tool is blocked. */
  message?: string;
  /**
   * Phase 12.4 — the call is allowed once a person approves it: a
   * require_approval rule matched (and no deny). The caller hands it off
   * for approval; `evaluateMcpToolAccess` itself never blocks it.
   */
  approval?: { ruleId: string; ruleName?: string; message: string };
}

export function describePolicyRule(rule: Pick<McpToolPolicyRule, "id" | "name">): string {
  return rule.name?.trim() ? `'${rule.name.trim()}' (${rule.id})` : `'${rule.id}'`;
}

const CONDITION_WORDS: Record<McpPolicyCondition["op"], string> = {
  equals: "equals",
  one_of: "is one of",
  not_one_of: "is not one of",
  starts_with: "starts with",
  ends_with: "ends with",
  matches: "matches",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
  between: "is between",
  exists: "exists",
  label_present: "label present:",
  label_absent: "label absent:"
};

function describeValue(value: McpPolicyCondition["value"]): string {
  if (Array.isArray(value)) {
    const shown = value.slice(0, 5).map((entry) => JSON.stringify(entry)).join(", ");
    return value.length > 5 ? `${shown}, ...` : shown;
  }
  return JSON.stringify(value ?? null);
}

/** Phase 12.4 — one condition in words, for messages and the UI: `repo is one of "a", "b"`. */
export function describePolicyCondition(condition: McpPolicyCondition): string {
  if (condition.op === "label_present" || condition.op === "label_absent") {
    return `${CONDITION_WORDS[condition.op]} ${String(condition.value ?? "")}`;
  }
  if (condition.op === "exists") return `${condition.path ?? "?"} ${condition.value === false ? "does not exist" : "exists"}`;
  if (condition.op === "between" && Array.isArray(condition.value)) {
    return `${condition.path ?? "?"} is between ${describeValue(condition.value[0])} and ${describeValue(condition.value[1])}`;
  }
  return `${condition.path ?? "?"} ${CONDITION_WORDS[condition.op]} ${describeValue(condition.value)}`;
}

/** Phase 12.4 — a rule's conditions in words; empty when it has none. */
export function describePolicyConditions(conditions: McpToolPolicyRule["conditions"]): string {
  const { combine, items } = conditionList(conditions);
  if (items.length === 0) return "";
  return items.map(describePolicyCondition).join(combine === "any" ? " or " : " and ");
}

function ruleQualifiers(rule: McpToolPolicyRule): string {
  const parts: string[] = [];
  if (rule.annotationHint) parts.push(`rule applies to ${describeHintCondition(rule.annotationHint)} tools`);
  const conditions = describePolicyConditions(rule.conditions);
  if (conditions) parts.push(`the call matches: ${conditions}`);
  return parts.length > 0 ? ` (${parts.join("; ")})` : "";
}

/** Policy first, then the workflow's "no write tools" switch. */
export function evaluateMcpToolAccess(input: McpToolAccessInput): McpToolAccessDecision {
  const policy = evaluateMcpToolPolicy(input.rules, input);
  const classification = classifyMcpTool({ manualReadOnly: input.manualReadOnly, annotations: input.annotations });
  const serverName = input.serverLabel?.trim() || input.registryServerId || input.adapterId;
  const kind = input.kind ?? "tool";
  const toolLabel =
    kind === "resource"
      ? `MCP resource '${input.toolName}' on server '${serverName}'`
      : kind === "prompt"
        ? `MCP prompt '${input.toolName}' on server '${serverName}'`
        : kind === "sampling"
          ? `Sampling with model '${input.toolName}' for server '${serverName}'`
          : `MCP tool '${input.toolName}' on server '${serverName}'`;
  if (!policy.allowed && policy.rule) {
    return {
      allowed: false,
      reason: "policy",
      ruleId: policy.rule.id,
      ...(policy.rule.name ? { ruleName: policy.rule.name } : {}),
      policy,
      classification,
      message: `${toolLabel} is blocked by policy ${describePolicyRule(policy.rule)} for role ${input.role}${ruleQualifiers(policy.rule)}.`
    };
  }
  // Reading a resource and fetching a prompt never write; sampling is governed by its own rules.
  if (kind === "tool" && input.noWriteTools && !classification.readOnly) {
    const why =
      classification.source === "unknown"
        ? "it has no read-only annotation, so it counts as a write tool"
        : classification.source === "manual"
          ? "an admin marked it as a write tool"
          : "its server marks it as not read-only";
    return {
      allowed: false,
      reason: "no_write_tools",
      policy,
      classification,
      message: `${toolLabel} is blocked: this workflow allows no write tools and ${why}.`
    };
  }
  if (policy.effect === "require_approval" && policy.rule) {
    return {
      allowed: true,
      policy,
      classification,
      approval: {
        ruleId: policy.rule.id,
        ...(policy.rule.name ? { ruleName: policy.rule.name } : {}),
        message: `${toolLabel} needs approval by policy ${describePolicyRule(policy.rule)}${ruleQualifiers(policy.rule)}.`
      }
    };
  }
  return { allowed: true, policy, classification };
}

export class McpToolPolicyError extends Error {
  readonly hidden: McpHiddenTool;
  constructor(message: string, hidden: McpHiddenTool) {
    super(message);
    this.name = "McpToolPolicyError";
    this.hidden = hidden;
  }
}
