import type {
  McpHiddenTool,
  McpPolicyKind,
  McpPolicyRole,
  McpToolAnnotations,
  McpToolClassification,
  McpToolHintCondition,
  McpToolPolicyRule
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
  allowed: boolean;
  /** `default`: no rule matched. `rule`: decided by `rule`. */
  decidedBy: "default" | "rule";
  rule?: McpToolPolicyRule;
  /** Every enabled rule whose scope matched, in evaluation order. */
  matchedRules: McpToolPolicyRule[];
  /** Deny rules that a narrower allow rule set aside. */
  overriddenDenies: Array<{ deny: McpToolPolicyRule; by: McpToolPolicyRule }>;
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

export function ruleMatches(rule: McpToolPolicyRule, request: McpToolPolicyRequest): boolean {
  if (!rule.enabled) return false;
  if (policyRuleKind(rule) !== (request.kind ?? "tool")) return false;
  if (rule.projectId && rule.projectId !== (request.projectId ?? null)) return false;
  if (rule.roles.length > 0 && !rule.roles.includes(request.role)) return false;
  if (!matchesPolicyServer(rule.serverId, request)) return false;
  if (!matchesToolPattern(rule.toolPattern, request.toolName)) return false;
  if (rule.annotationHint) {
    return matchesHintCondition(rule.annotationHint, effectiveToolHints(request.annotations, request.manualReadOnly));
  }
  return true;
}

/** True when any enabled rule needs the tool's annotations to decide whether it matches. */
export function policyNeedsAnnotations(rules: readonly McpToolPolicyRule[]): boolean {
  return rules.some((rule) => rule.enabled && Boolean(rule.annotationHint));
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

/** True when `inner`'s scope sits inside `outer`'s in every field and is smaller in at least one. */
export function isStrictlyNarrower(inner: McpToolPolicyRule, outer: McpToolPolicyRule): boolean {
  if (policyRuleKind(inner) !== policyRuleKind(outer)) return false;
  const within =
    scalarWithin(inner.projectId, outer.projectId) &&
    rolesWithin(inner.roles, outer.roles) &&
    scalarWithin(inner.serverId, outer.serverId) &&
    patternWithin(inner.toolPattern, outer.toolPattern) &&
    scalarWithin(inner.annotationHint, outer.annotationHint);
  if (!within) return false;
  const reverse =
    scalarWithin(outer.projectId, inner.projectId) &&
    rolesWithin(outer.roles, inner.roles) &&
    scalarWithin(outer.serverId, inner.serverId) &&
    patternWithin(outer.toolPattern, inner.toolPattern) &&
    scalarWithin(outer.annotationHint, inner.annotationHint);
  return !reverse;
}

export function evaluateMcpToolPolicy(
  rules: readonly McpToolPolicyRule[],
  request: McpToolPolicyRequest
): McpToolPolicyDecision {
  const matchedRules = rules.filter((rule) => ruleMatches(rule, request));
  if (matchedRules.length === 0) {
    return { allowed: true, decidedBy: "default", matchedRules, overriddenDenies: [] };
  }
  const allows = matchedRules.filter((rule) => rule.effect === "allow");
  const denies = matchedRules.filter((rule) => rule.effect === "deny");
  const overriddenDenies: McpToolPolicyDecision["overriddenDenies"] = [];
  let blocking: McpToolPolicyRule | undefined;
  for (const deny of denies) {
    const carve = allows.find((allow) => isStrictlyNarrower(allow, deny));
    if (carve) {
      overriddenDenies.push({ deny, by: carve });
    } else if (!blocking) {
      blocking = deny;
    }
  }
  if (blocking) {
    return { allowed: false, decidedBy: "rule", rule: blocking, matchedRules, overriddenDenies };
  }
  const deciding = overriddenDenies[0]?.by ?? allows[0];
  return { allowed: true, decidedBy: "rule", rule: deciding, matchedRules, overriddenDenies };
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
}

export function describePolicyRule(rule: Pick<McpToolPolicyRule, "id" | "name">): string {
  return rule.name?.trim() ? `'${rule.name.trim()}' (${rule.id})` : `'${rule.id}'`;
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
      message: `${toolLabel} is blocked by policy ${describePolicyRule(policy.rule)} for role ${input.role}${
        policy.rule.annotationHint ? ` (rule applies to ${describeHintCondition(policy.rule.annotationHint)} tools)` : ""
      }.`
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
