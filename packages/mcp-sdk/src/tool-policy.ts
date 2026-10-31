import { createHash } from "node:crypto";
import {
  MCP_ADAPTERS_WITHOUT_NETWORK,
  mcpServerDestinationRef,
  resolveDestination,
  type DataDestinationRow,
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
  type McpToolPolicyRule,
  type DestinationTier,
  type McpOpenWorldResolution,
  type McpToolCallLabels
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
 *     call's arguments and data labels (`all` or `any` of them). Conditions
 *     fail closed for the rule's effect (see `evaluatePolicyCondition`): an
 *     odd argument may make a deny or require_approval match, never an allow.
 *   - A rule whose stored conditions no longer validate (`invalid`) also
 *     fails closed: an allow never matches, a deny or require_approval covers
 *     its whole scope.
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
  /**
   * Phase 12.2 — the tool's resolved open-world value (see `resolveToolOpenWorld`): it decides `open_world` /
   * `not_open_world` hints. Absent: the annotation alone decides, as before. Unless it is an admin's override
   * (`openWorldManual`), it can only tighten: see `ruleHintMatches`.
   */
  openWorld?: boolean | null;
  /** Phase 12.2 — `openWorld` is an admin's per-tool override, which decides alone. */
  openWorldManual?: boolean;
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
  manualReadOnly?: boolean | null,
  /** Phase 12.2 — the resolved open-world value (`resolveToolOpenWorld`); replaces `openWorldHint` when given. */
  openWorld?: boolean | null
): EffectiveToolHints {
  const readOnly =
    typeof manualReadOnly === "boolean" ? manualReadOnly : annotations?.readOnlyHint === true && annotations?.destructiveHint !== true;
  return {
    readOnly,
    destructive: readOnly ? false : annotations?.destructiveHint !== false,
    idempotent: readOnly ? true : annotations?.idempotentHint === true,
    openWorld: typeof openWorld === "boolean" ? openWorld : annotations?.openWorldHint !== false
  };
}

/**
 * Phase 12.2 — where the tool's server sends what it is given, as `resolveToolOpenWorld` reads it: the resolved
 * destination of the server (tier, and whether a row or a built-in classified it), `"none"` for an adapter with no
 * network (the mock server), or null when it is not known.
 */
export type ToolOpenWorldDestination = { tier: DestinationTier; matchedBy: "row" | "builtin" | "unmatched" } | "none" | null;

/**
 * Phase 12.2 — the destination of an MCP server as `resolveToolOpenWorld` reads it, from the host of its endpoint
 * and the admin's destination rows (with the built-in ones): `"none"` for an adapter with no network.
 */
export function serverOpenWorldDestination(
  server: { adapterId: string; registryServerId?: string | null; connection?: unknown },
  rows: readonly DataDestinationRow[]
): ToolOpenWorldDestination {
  if (MCP_ADAPTERS_WITHOUT_NETWORK.has(server.adapterId)) return "none";
  const ref = mcpServerDestinationRef({
    adapterId: server.adapterId,
    ...(server.registryServerId ? { registryServerId: server.registryServerId } : {}),
    connection: server.connection
  });
  if (!ref) return "none";
  const resolved = resolveDestination(ref, rows);
  return { tier: resolved.tier, matchedBy: resolved.matchedBy };
}

/**
 * Phase 12.2 — whether a tool counts as open world (it can send what it is given outside the organisation), in
 * order:
 *   1. an admin's per-tool override, either way;
 *   2. the server's destination: a vendor or public tier is open world;
 *   3. a local or private server (or one with no network): the tool's own `openWorldHint` decides, with the MCP
 *      default (a missing hint is open world), since a local server can still reach out (a fetch or browser tool);
 *   4. a destination that is not known or that no row or built-in classifies: open world. It fails closed.
 * Only an admin override can make a tool on an unknown or vendor/public server closed-world.
 */
export function resolveToolOpenWorld(input: {
  override?: boolean | null;
  destination: ToolOpenWorldDestination | undefined;
  annotations?: McpToolAnnotations | null;
}): McpOpenWorldResolution {
  if (typeof input.override === "boolean") return { openWorld: input.override, source: "manual" };
  const destination = input.destination;
  if (destination !== "none") {
    if (!destination || destination.matchedBy === "unmatched") return { openWorld: true, source: "unknown" };
    if (destination.tier === "vendor" || destination.tier === "public") return { openWorld: true, source: "destination" };
  }
  return { openWorld: input.annotations?.openWorldHint !== false, source: "annotation" };
}

/**
 * Phase 12.2 — the request fields for a resolved open-world value: `openWorld`, and `openWorldManual` when an admin's
 * override decided it. Empty when nothing was resolved, so the annotation alone decides.
 */
export function openWorldRequestFields(
  resolution: McpOpenWorldResolution | null | undefined
): Pick<McpToolPolicyRequest, "openWorld" | "openWorldManual"> {
  if (!resolution) return {};
  return { openWorld: resolution.openWorld, ...(resolution.source === "manual" ? { openWorldManual: true } : {}) };
}

/** Phase 12.2 — true when an enabled rule reads the open-world hint, so a tool's open-world value must be resolved. */
export function policyReadsOpenWorld(rules: ReadonlyArray<Pick<McpToolPolicyRule, "enabled" | "annotationHint">>): boolean {
  return rules.some((rule) => rule.enabled && isOpenWorldHint(rule.annotationHint));
}

/** Phase 12.2 — `open_world` or `not_open_world`. */
export function isOpenWorldHint(condition: McpToolHintCondition | null | undefined): boolean {
  return condition === "open_world" || condition === "not_open_world";
}

/**
 * Whether a rule's annotation hint holds for a tool. Phase 12.2 — for an open-world hint without an admin override,
 * the resolved value (destination tier) may only tighten what the annotation alone decided: a deny or
 * require_approval rule matches when the annotation-only reading OR the resolved one matches; an allow rule (a
 * carve-out) only when BOTH do. So a `not_open_world` deny keeps matching a tool that declares `openWorldHint:false`
 * on an unclassified server, and an `open_world` allow does not start carving out tools it never matched. An admin's
 * override decides alone.
 */
export function ruleHintMatches(
  rule: Pick<McpToolPolicyRule, "annotationHint" | "effect">,
  input: {
    annotations?: McpToolAnnotations | null;
    manualReadOnly?: boolean | null;
    openWorld?: boolean | null;
    openWorldManual?: boolean;
  }
): boolean {
  const hint = rule.annotationHint;
  if (!hint) return true;
  const resolved = matchesHintCondition(hint, effectiveToolHints(input.annotations, input.manualReadOnly, input.openWorld));
  if (!isOpenWorldHint(hint) || typeof input.openWorld !== "boolean" || input.openWorldManual === true) return resolved;
  const annotationOnly = matchesHintCondition(hint, effectiveToolHints(input.annotations, input.manualReadOnly));
  return rule.effect === "allow" ? resolved && annotationOnly : resolved || annotationOnly;
}

/**
 * Phase 12.2 — whether a matched require_approval rule may also set a broader deny aside. Matching uses the
 * EITHER reading (`ruleHintMatches`), so an approval can always ADD a gate; but setting a deny aside works like an
 * allow, so as a carve-out an approval with an open-world hint counts only when BOTH readings match (or an admin's
 * override decides). Rules of any other kind or hint are unaffected.
 */
export function approvalMayCarve(
  rule: Pick<McpToolPolicyRule, "annotationHint" | "effect">,
  input: Parameters<typeof ruleHintMatches>[1]
): boolean {
  if (rule.effect !== "require_approval" || !isOpenWorldHint(rule.annotationHint)) return true;
  return ruleHintMatches({ annotationHint: rule.annotationHint, effect: "allow" }, input);
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

/**
 * Glob comparison steps one tool-call evaluation may spend in total, across
 * every `matches` condition of every enforced rule (about 0.1 s of work in
 * the worst case; shadow rules have a budget of their own). Each value is linear to match, but many long values against a long
 * self-overlapping pattern add up; once the budget is spent, every further
 * `matches` reads as a value the operator cannot read, so it fails closed:
 * a match for deny and require_approval, never for allow.
 */
export const MAX_GLOB_STEPS_PER_EVALUATION = 20_000_000;

/**
 * Characters of argument text one tool-call evaluation reads in total (1 MB of
 * text), each argument value counted once however many conditions read it.
 * Every operator but `exists` reads a value's text; a value that does not fit
 * in what is left reads as a value the operator cannot read, so it fails
 * closed: a match for deny and require_approval, never for allow. Arguments no
 * condition reads are not counted.
 */
export const MAX_EVALUATED_ARGUMENT_CHARS = 1_000_000;

/** An argument string read once per evaluation: trimmed, with its folded and number forms made on first use. */
interface ArgumentText {
  text: string;
  folded?: string;
  number?: number | null;
}

/**
 * Phase 12.4 — work left for one tool-call evaluation (see
 * `MAX_GLOB_STEPS_PER_EVALUATION` and `MAX_EVALUATED_ARGUMENT_CHARS`), and
 * the argument strings already read, by the object or list that holds them
 * and their key (`null`: did not fit).
 */
export interface PolicyEvaluationBudget {
  globSteps: number;
  argumentChars: number;
  readonly texts: WeakMap<object, Map<string | number, ArgumentText | null>>;
}

export function createPolicyEvaluationBudget(): PolicyEvaluationBudget {
  return { globSteps: MAX_GLOB_STEPS_PER_EVALUATION, argumentChars: MAX_EVALUATED_ARGUMENT_CHARS, texts: new WeakMap() };
}

/**
 * The two-pointer walk behind `matchesGlob`. Charges one step per character
 * comparison to `budget` when given; `undefined` when the budget ran out
 * before an answer.
 */
function globWalk(pattern: string, text: string, questionMark: boolean, budget?: PolicyEvaluationBudget): boolean | undefined {
  if (budget && budget.globSteps <= 0) return undefined;
  let p = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  let steps = 0;
  while (t < text.length) {
    if (budget && ++steps >= budget.globSteps) {
      budget.globSteps = 0;
      return undefined;
    }
    const char = pattern[p];
    if (p < pattern.length && char !== "*" && (char === text[t] || (questionMark && char === "?"))) {
      p += 1;
      t += 1;
    } else if (p < pattern.length && char === "*") {
      star = p;
      resume = t;
      p += 1;
    } else if (star !== -1) {
      p = star + 1;
      resume += 1;
      t = resume;
    } else {
      if (budget) budget.globSteps -= steps;
      return false;
    }
  }
  if (budget) budget.globSteps -= steps;
  while (p < pattern.length && pattern[p] === "*") p += 1;
  return p === pattern.length;
}

/**
 * Glob match without regular expressions: `*` matches any run of characters
 * (including none) and, when `questionMark` is set, `?` exactly one;
 * everything else is literal. The classic two-pointer walk that only ever
 * backtracks to the last `*`, so the worst case is O(text × pattern) with no
 * catastrophic backtracking whatever the input.
 */
export function matchesGlob(pattern: string, text: string, questionMark = false): boolean {
  return globWalk(pattern, text, questionMark) === true;
}

export function isToolGlob(pattern: string): boolean {
  return pattern.includes("*");
}

/** Exact match, or glob where `*` matches any run of characters (including none). */
export function matchesToolPattern(pattern: string, toolName: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed || trimmed === "*") return true;
  if (!isToolGlob(trimmed)) return trimmed === toolName;
  return matchesGlob(trimmed, toolName);
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
  return ruleHintMatches(rule, request);
}

/**
 * Whether the rule matches the call: scope, then conditions. `undecided`
 * when the scope matches but the rule has conditions and the request carries
 * no arguments (discovery). `budget` is the call's evaluation budget, shared
 * by every enforced rule evaluated for it (shadow rules share their own); a fresh one when absent.
 */
export function ruleMatchState(
  rule: McpToolPolicyRule,
  request: McpToolPolicyRequest,
  budget: PolicyEvaluationBudget = createPolicyEvaluationBudget()
): "match" | "no_match" | "undecided" {
  if (!ruleScopeMatches(rule, request)) return "no_match";
  // Stored conditions that no longer validate fail closed: an allow never matches, anything else covers its whole scope.
  if (rule.invalid) return rule.effect === "allow" ? "no_match" : "match";
  if (!policyRuleHasConditions(rule)) return "match";
  if (request.arguments === undefined) return "undecided";
  return matchesPolicyConditions(rule.conditions, request.arguments, request.dataLabels, rule.effect, budget) ? "match" : "no_match";
}

export function ruleMatches(rule: McpToolPolicyRule, request: McpToolPolicyRequest): boolean {
  return ruleMatchState(rule, request) === "match";
}

// ---------------------------------------------------------------------------
// Phase 12.4 — conditions
// ---------------------------------------------------------------------------

/**
 * At most this many values are read for one condition (through `[*]` steps
 * and a path that ends on an array). A value set cut by this cap is
 * incomplete and fails closed: a match for deny and require_approval, never
 * for allow.
 */
export const MAX_RESOLVED_VALUES = 1000;

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

/**
 * The values at a path, and how far they can be trusted:
 * `incomplete` when the path cannot be read (bad syntax, over the length or
 * step cap) or a cap cut the values; `partial` when some element reached
 * through `[*]` lacks the rest of the path (or ends on an empty list). Each
 * value comes with the object or list holding it and its key there, so its
 * text is read once per evaluation however many conditions reach it.
 */
interface ResolvedSlot {
  value: unknown;
  holder: object | null;
  key: string | number;
}

interface ResolvedValues {
  slots: ResolvedSlot[];
  incomplete: boolean;
  partial: boolean;
}

function resolveValues(root: unknown, path: string, readEndArrays: boolean): ResolvedValues {
  const steps = pathSteps(path);
  if (!steps) return { slots: [], incomplete: true, partial: false };
  let current: ResolvedSlot[] = [{ value: root, holder: null, key: "" }];
  let afterWildcard = false;
  let incomplete = false;
  let partial = false;
  const takeElements = (into: ResolvedSlot[], list: unknown[]) => {
    const room = MAX_RESOLVED_VALUES - into.length;
    if (list.length > room) incomplete = true;
    const count = Math.min(list.length, Math.max(0, room));
    for (let index = 0; index < count; index += 1) into.push({ value: list[index], holder: list, key: index });
  };
  for (const step of steps) {
    const next: ResolvedSlot[] = [];
    for (const { value } of current) {
      const before = next.length;
      if ("key" in step) {
        if (isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, step.key) && value[step.key] !== undefined) {
          next.push({ value: value[step.key], holder: value, key: step.key });
        }
      } else if ("index" in step) {
        if (Array.isArray(value) && step.index < value.length) next.push({ value: value[step.index], holder: value, key: step.index });
      } else if (Array.isArray(value)) {
        takeElements(next, value);
      }
      if (next.length === before && afterWildcard) partial = true;
      if (incomplete) break;
    }
    if ("any" in step) afterWildcard = true;
    current = next;
    if (incomplete || current.length === 0) break;
  }
  if (!readEndArrays || incomplete) return { slots: current, incomplete, partial };
  const slots: ResolvedSlot[] = [];
  for (const slot of current) {
    if (Array.isArray(slot.value)) {
      // An element reached through `[*]` whose list is empty gives nothing to check: like an element lacking the path.
      if (slot.value.length === 0 && afterWildcard) partial = true;
      takeElements(slots, slot.value);
    } else {
      if (slots.length >= MAX_RESOLVED_VALUES) incomplete = true;
      else slots.push(slot);
    }
    if (incomplete) break;
  }
  return { slots, incomplete, partial };
}

/** Every value at `path` in `root` (at most `MAX_RESOLVED_VALUES`); empty when the path does not resolve. */
export function resolvePolicyPath(root: unknown, path: string): unknown[] {
  return resolveValues(root, path, false).slots.map((slot) => slot.value);
}

function isScalar(value: unknown): value is McpPolicyScalar {
  return value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

/**
 * How a condition reads several values (a `[*]` step, or a path that ends on
 * an array), chosen by the rule's effect so that every reading fails closed:
 * `any` (deny, require_approval) holds when one value satisfies the condition
 * and treats a missing argument as satisfying the negated operators;
 * `every` (allow) holds only when every value does, there is at least one, and
 * no value is of a type the operator cannot read.
 */
export type PolicyConditionQuantifier = "any" | "every";

export function conditionQuantifier(effect: McpToolPolicyEffect | undefined): PolicyConditionQuantifier {
  return effect === "allow" ? "every" : "any";
}

/** Longest text a `matches` glob is run against; a longer value matches for deny and approval, never for allow. */
export const MAX_GLOB_TEXT_LENGTH = 64 * 1024;

const NUMERIC_TEXT = /^\s*-?\d+(\.\d+)?(e[+-]?\d+)?\s*$/i;

/** The number a trimmed text holds, if any. */
function parseNumber(text: string): number | undefined {
  if (!NUMERIC_TEXT.test(text)) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** A non-null scalar as trimmed text, folded when `ignoreCase`; undefined for null, objects and arrays. */
function scalarText(value: unknown, ignoreCase: boolean): string | undefined {
  let text: string | undefined;
  if (typeof value === "string") text = value.trim();
  else if (typeof value === "boolean") text = String(value);
  else if (typeof value === "number" && Number.isFinite(value)) text = String(value);
  if (text === undefined) return undefined;
  return ignoreCase ? text.toLowerCase() : text;
}

/**
 * A non-null scalar argument, read once per evaluation: its trimmed text, the
 * folded text and the number it holds. Strings are charged to the
 * evaluation's argument text budget the first time they are read; one that
 * does not fit is `"unreadable"`.
 */
interface ScalarView {
  kind: "string" | "number" | "boolean";
  text: (ignoreCase: boolean) => string;
  number: () => number | undefined;
}

function viewScalar(slot: ResolvedSlot, budget: PolicyEvaluationBudget): ScalarView | "unreadable" {
  const value = slot.value;
  if (typeof value === "number") {
    const text = String(value);
    return { kind: "number", text: (ignoreCase) => (ignoreCase ? text.toLowerCase() : text), number: () => value };
  }
  if (typeof value === "boolean") {
    const text = String(value);
    return { kind: "boolean", text: () => text, number: () => undefined };
  }
  const raw = value as string;
  let byKey = slot.holder ? budget.texts.get(slot.holder) : undefined;
  let entry = byKey?.get(slot.key);
  if (entry === undefined) {
    if (raw.length > budget.argumentChars) {
      entry = null;
    } else {
      budget.argumentChars -= raw.length;
      entry = { text: raw.trim() };
    }
    if (slot.holder) {
      if (!byKey) {
        byKey = new Map();
        budget.texts.set(slot.holder, byKey);
      }
      byKey.set(slot.key, entry);
    }
  }
  if (entry === null) return "unreadable";
  const read = entry;
  return {
    kind: "string",
    text: (ignoreCase) => (ignoreCase ? (read.folded ??= read.text.toLowerCase()) : read.text),
    number: () => {
      if (read.number === undefined) read.number = parseNumber(read.text) ?? null;
      return read.number ?? undefined;
    }
  };
}

/**
 * The scalars of an `equals` / `one_of` / `not_one_of` condition, prepared
 * once per condition so each value is checked in constant time. Equality is
 * the same as comparing one by one: identical, numerically equal when either
 * side is a number and both hold one, otherwise equal as trimmed (and, with
 * `ignoreCase`, folded) text.
 */
interface ScalarSet {
  hasNull: boolean;
  /** Entries that are numbers. */
  numbers: Set<number>;
  /** Entries that are numeric strings, by the number they hold. */
  numericStrings: Set<number>;
  /** Text of the number entries. */
  numberTexts: Set<string>;
  /** Text of the string and boolean entries. */
  texts: Set<string>;
}

const scalarSetCache = new WeakMap<McpPolicyCondition, ScalarSet | null>();

function scalarSet(condition: McpPolicyCondition): ScalarSet | null {
  const cached = scalarSetCache.get(condition);
  if (cached !== undefined) return cached;
  const expected = condition.value;
  const ignoreCase = condition.ignoreCase === true;
  let entries: unknown[] | null = null;
  if (condition.op === "equals") entries = Array.isArray(expected) || expected === undefined ? null : [expected];
  else entries = Array.isArray(expected) ? expected : null;
  let set: ScalarSet | null = null;
  if (entries) {
    set = { hasNull: false, numbers: new Set(), numericStrings: new Set(), numberTexts: new Set(), texts: new Set() };
    for (const entry of entries) {
      if (entry === null) {
        set.hasNull = true;
      } else if (typeof entry === "number") {
        if (!Number.isFinite(entry)) continue;
        set.numbers.add(entry);
        set.numberTexts.add(scalarText(entry, ignoreCase)!);
      } else if (typeof entry === "string" || typeof entry === "boolean") {
        const text = scalarText(entry, ignoreCase)!;
        set.texts.add(text);
        if (typeof entry === "string") {
          const number = parseNumber(entry.trim());
          if (number !== undefined) set.numericStrings.add(number);
        }
      }
    }
  }
  scalarSetCache.set(condition, set);
  return set;
}

function inScalarSet(set: ScalarSet, view: ScalarView, ignoreCase: boolean): boolean {
  if (view.kind === "number") {
    const number = view.number()!;
    return set.numbers.has(number) || set.numericStrings.has(number);
  }
  const text = view.text(ignoreCase);
  if (view.kind === "boolean") return set.texts.has(text);
  const number = view.number();
  return (number !== undefined ? set.numbers.has(number) : set.numberTexts.has(text)) || set.texts.has(text);
}

/** Glob for argument values: `*` any run of characters, `?` one character; everything else literal. */
export function matchesValueGlob(pattern: string, value: string): boolean {
  return matchesGlob(pattern, value, true);
}

/**
 * One value against one argument operator. `true` / `false` when the value
 * can be read; `"unreadable"` when it is of a type the operator cannot read
 * (an object or a nested list for any operator, a non-numeric value for a
 * number operator), longer than `MAX_GLOB_TEXT_LENGTH` for `matches`, does
 * not fit in the call's argument text budget, or the call's glob budget is
 * spent. The quantifier resolves it fail-closed.
 */
function valueSatisfies(condition: McpPolicyCondition, slot: ResolvedSlot, budget: PolicyEvaluationBudget): boolean | "unreadable" {
  const expected = condition.value;
  const ignoreCase = condition.ignoreCase === true;
  const value = slot.value;
  if (value !== null && !isScalar(value)) return "unreadable";
  const view = value === null ? null : viewScalar(slot, budget);
  if (view === "unreadable") return "unreadable";
  switch (condition.op) {
    case "equals":
    case "one_of": {
      const set = scalarSet(condition);
      if (!set) return false;
      return view === null ? set.hasNull : inScalarSet(set, view, ignoreCase);
    }
    case "not_one_of": {
      const set = scalarSet(condition);
      if (!set) return false;
      // null reads like a missing argument: it "is not one of" the list for deny and approval, never for an allow.
      if (view === null) return set.hasNull ? false : "unreadable";
      return !inScalarSet(set, view, ignoreCase);
    }
    case "starts_with":
    case "ends_with":
    case "matches": {
      if (typeof expected !== "string" || view === null) return false;
      const text = view.text(ignoreCase);
      const wanted = ignoreCase ? expected.toLowerCase() : expected;
      if (condition.op === "starts_with") return text.startsWith(wanted);
      if (condition.op === "ends_with") return text.endsWith(wanted);
      if (text.length > MAX_GLOB_TEXT_LENGTH) return "unreadable";
      return globWalk(wanted, text, true, budget) ?? "unreadable";
    }
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      const limit = typeof expected === "number" && Number.isFinite(expected) ? expected : undefined;
      if (limit === undefined) return false;
      if (view === null) return false;
      const actual = view.number();
      if (actual === undefined) return "unreadable";
      if (condition.op === "lt") return actual < limit;
      if (condition.op === "lte") return actual <= limit;
      if (condition.op === "gt") return actual > limit;
      return actual >= limit;
    }
    case "between": {
      if (!Array.isArray(expected) || expected.length !== 2) return false;
      const [min, max] = expected;
      if (typeof min !== "number" || typeof max !== "number" || !Number.isFinite(min) || !Number.isFinite(max)) return false;
      if (view === null) return false;
      const actual = view.number();
      if (actual === undefined) return "unreadable";
      return actual >= min && actual <= max;
    }
    default:
      return false;
  }
}

/**
 * Phase 12.4 (simulation) — one value against a condition's operator, read
 * exactly as `evaluatePolicyCondition` reads each value a path resolves to:
 * `true` / `false`, or `"unreadable"` for a value the operator cannot read.
 * The policy simulator uses it on the values an argument summary keeps, so
 * a kept value compares the same way it does at call time.
 */
export function evaluatePolicyConditionValue(condition: McpPolicyCondition, value: unknown): boolean | "unreadable" {
  return valueSatisfies(condition, { value, holder: null, key: "" }, createPolicyEvaluationBudget());
}

const NEGATED_OPS = new Set<McpPolicyCondition["op"]>(["not_one_of", "label_absent"]);

/**
 * One condition against a call. Pure and total. Fails closed for the rule's
 * effect (see `PolicyConditionQuantifier`):
 * - under `any` (deny, require_approval, the default) a missing argument, an
 *   empty array or labels the run does not track satisfy only the negated
 *   operators; a value the operator cannot read (`"5000x"` for `gt`, an
 *   object or a nested list for any operator) satisfies it; and so does an
 *   incomplete reading: a path that cannot be read, more than
 *   `MAX_RESOLVED_VALUES` values, a value past the argument text budget, or a
 *   spent glob budget;
 * - under `every` (allow) none of those do, and neither does a `[*]` element
 *   that lacks the rest of the path or ends on an empty list.
 * Work is linear in the arguments read: each value's text is read once per
 * evaluation (`budget`), and list operators look values up in a set.
 * `exists` reads the path as given: true when some value is not null,
 * `exists: false` when none is. An operator with a malformed value is false.
 */
export function evaluatePolicyCondition(
  condition: McpPolicyCondition,
  args: Record<string, unknown>,
  labels?: McpToolPolicyRequest["dataLabels"],
  quantifier: PolicyConditionQuantifier = "any",
  budget: PolicyEvaluationBudget = createPolicyEvaluationBudget()
): boolean {
  if (condition.op === "label_present" || condition.op === "label_absent") {
    if (typeof condition.value !== "string") return false;
    if (!labels) return condition.op === "label_absent" && quantifier === "any";
    const present = labels.provenance.includes(condition.value) || labels.dataClasses.includes(condition.value);
    return condition.op === "label_present" ? present : !present;
  }
  if (typeof condition.path !== "string") return quantifier === "any";
  const resolved = resolveValues(args, condition.path, condition.op !== "exists");
  if (resolved.incomplete) return quantifier === "any";
  if (quantifier === "every" && resolved.partial) return false;
  const { slots } = resolved;
  if (condition.op === "exists") {
    const exists = slots.some((slot) => slot.value !== null);
    return condition.value === false ? !exists : exists;
  }
  if (slots.length === 0) return quantifier === "any" && NEGATED_OPS.has(condition.op) && Array.isArray(condition.value);
  if (quantifier === "every") return slots.every((slot) => valueSatisfies(condition, slot, budget) === true);
  return slots.some((slot) => valueSatisfies(condition, slot, budget) !== false);
}

/**
 * True when the conditions hold (`all`: every one, `any`: at least one); a
 * rule without conditions always holds. `effect` is the rule's: an allow
 * reads several values with `every`, anything else with `any`.
 */
export function matchesPolicyConditions(
  conditions: McpToolPolicyRule["conditions"],
  args: Record<string, unknown>,
  labels?: McpToolPolicyRequest["dataLabels"],
  effect?: McpToolPolicyEffect,
  budget: PolicyEvaluationBudget = createPolicyEvaluationBudget()
): boolean {
  const { combine, items } = conditionList(conditions);
  if (items.length === 0) return true;
  const quantifier = conditionQuantifier(effect);
  return combine === "any"
    ? items.some((condition) => evaluatePolicyCondition(condition, args, labels, quantifier, budget))
    : items.every((condition) => evaluatePolicyCondition(condition, args, labels, quantifier, budget));
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

/**
 * Precedence over the rules that matched: deny > require_approval > allow, with strictly narrower carve-outs.
 * Phase 12.2 — an additive rule (a safety preset's or the workflow switch's) never carves: it can add an approval,
 * never set a deny (or another approval) aside. Neither does an approval in `nonCarving` (see `approvalMayCarve`).
 */
function decideOutcome(
  matched: readonly McpToolPolicyRule[],
  possibleCarveOuts: readonly McpToolPolicyRule[],
  /** Phase 12.2 — matched approvals that may add a gate but not set a deny aside (`approvalMayCarve`). */
  nonCarving: ReadonlySet<McpToolPolicyRule> = new Set()
): PolicyOutcome {
  const allows = [...matched.filter((rule) => rule.effect === "allow"), ...possibleCarveOuts.filter((rule) => rule.effect === "allow")].filter(
    (rule) => rule.additive !== true
  );
  const approvals = matched.filter((rule) => rule.effect === "require_approval");
  const carvingApprovals = approvals.filter((rule) => rule.additive !== true && !nonCarving.has(rule));
  const denies = matched.filter((rule) => rule.effect === "deny");
  const overriddenDenies: PolicyOutcome["overriddenDenies"] = [];
  const overriddenApprovals: PolicyOutcome["overriddenApprovals"] = [];
  let blocking: McpToolPolicyRule | undefined;
  const carvedToApproval: McpToolPolicyRule[] = [];
  for (const deny of denies) {
    const carve = allows.find((allow) => isStrictlyNarrower(allow, deny)) ?? carvingApprovals.find((approval) => isStrictlyNarrower(approval, deny));
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

/**
 * Phase 12.4 (simulation) — the precedence step of `evaluateMcpToolPolicy`
 * (deny > require_approval > allow, with strictly narrower carve-outs) over
 * rules already known to match the call. The caller passes the enforced
 * rules only; the result is the enforced outcome and the rule deciding it.
 */
export function decidePolicyOutcome(
  matched: readonly McpToolPolicyRule[],
  /** Phase 12.2 — matched approvals that may not set a deny aside for this call (`approvalMayCarve`). */
  nonCarving?: ReadonlySet<McpToolPolicyRule>
): { effect: McpToolPolicyEffect; rule?: McpToolPolicyRule } {
  const outcome = decideOutcome(matched, [], nonCarving);
  return { effect: outcome.effect, ...(outcome.rule && matched.length > 0 ? { rule: outcome.rule } : {}) };
}

export function evaluateMcpToolPolicy(
  rules: readonly McpToolPolicyRule[],
  request: McpToolPolicyRequest
): McpToolPolicyDecision {
  const matchedAll: McpToolPolicyRule[] = [];
  const undecided: McpToolPolicyRule[] = [];
  // Shadow rules get their own budget, so their work can never change an enforced rule's reading.
  const enforcedBudget = createPolicyEvaluationBudget();
  const shadowBudget = createPolicyEvaluationBudget();
  for (const rule of rules) {
    const state = ruleMatchState(rule, request, policyRuleMode(rule) === "shadow" ? shadowBudget : enforcedBudget);
    if (state === "match") matchedAll.push(rule);
    else if (state === "undecided") undecided.push(rule);
  }
  // Discovery: an undecided allow may carve an exception for some calls, so it keeps a tool visible.
  const carveOuts = (shadowToo: boolean) => undecided.filter((rule) => shadowToo || policyRuleMode(rule) === "enforce");
  const matchedRules = matchedAll.filter((rule) => policyRuleMode(rule) === "enforce");
  const nonCarving = new Set(matchedAll.filter((rule) => !approvalMayCarve(rule, request)));
  const enforced = decideOutcome(matchedRules, carveOuts(false), nonCarving);
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
    const withShadow = decideOutcome(matchedAll, carveOuts(true), nonCarving);
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
  approval?: McpToolPolicyDecisionRecord["approval"],
  /** Phase 12.2 — the labels the call was decided with (`recordedCallLabels`); recorded as given. */
  labels?: McpToolCallLabels
): McpToolPolicyDecisionRecord | undefined {
  const shadowRules = decision.shadow?.matchedRules ?? [];
  if (decision.matchedRules.length === 0 && shadowRules.length === 0) return undefined;
  return {
    ...(labels ? { labels } : {}),
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
  approval?: { ruleId: string; ruleName?: string; message: string; ruleHash?: string };
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
  const text = `${condition.path ?? "?"} ${CONDITION_WORDS[condition.op]} ${describeValue(condition.value)}`;
  return condition.ignoreCase ? `${text} (ignoring case)` : text;
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
        ruleHash: hashMcpToolPolicyRule(policy.rule),
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
