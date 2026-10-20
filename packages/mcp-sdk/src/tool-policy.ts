import type {
  McpHiddenTool,
  McpPolicyRole,
  McpToolAnnotations,
  McpToolClassification,
  McpToolPolicyRule
} from "@ai-orchestrator/shared";

/**
 * Phase 10.2 — MCP tool policy evaluation. Pure functions shared by the
 * workflow engine (discovery filter and call-time check) and the API
 * (dry-run evaluator, discovery marking).
 *
 * Evaluation order for one tool call:
 *   1. Collect the enabled rules whose scope matches the call: project, role,
 *      server and tool pattern must all match.
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
  projectId?: string | null;
  role: McpPolicyRole;
  /** Adapter id the tool's server runs on (`http_mcp`, `stdio_mcp`, `mock-mcp`, ...). */
  adapterId: string;
  /** Registry entry the server came from; absent for servers configured inline on a node. */
  registryServerId?: string;
  toolName: string;
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

export function ruleMatches(rule: McpToolPolicyRule, request: McpToolPolicyRequest): boolean {
  if (!rule.enabled) return false;
  if (rule.projectId && rule.projectId !== (request.projectId ?? null)) return false;
  if (rule.roles.length > 0 && !rule.roles.includes(request.role)) return false;
  if (!matchesPolicyServer(rule.serverId, request)) return false;
  return matchesToolPattern(rule.toolPattern, request.toolName);
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

function scalarWithin(inner: string | null, outer: string | null): boolean {
  return outer === null || inner === outer;
}

/** True when `inner`'s scope sits inside `outer`'s in every field and is smaller in at least one. */
export function isStrictlyNarrower(inner: McpToolPolicyRule, outer: McpToolPolicyRule): boolean {
  const within =
    scalarWithin(inner.projectId, outer.projectId) &&
    rolesWithin(inner.roles, outer.roles) &&
    scalarWithin(inner.serverId, outer.serverId) &&
    patternWithin(inner.toolPattern, outer.toolPattern);
  if (!within) return false;
  const reverse =
    scalarWithin(outer.projectId, inner.projectId) &&
    rolesWithin(outer.roles, inner.roles) &&
    scalarWithin(outer.serverId, inner.serverId) &&
    patternWithin(outer.toolPattern, inner.toolPattern);
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
 * `readOnlyHint` annotation; otherwise the tool counts as a write tool.
 */
export function classifyMcpTool(input: {
  manualReadOnly?: boolean | null;
  annotations?: McpToolAnnotations | null;
}): McpToolClassification {
  if (typeof input.manualReadOnly === "boolean") {
    return { readOnly: input.manualReadOnly, source: "manual" };
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
  annotations?: McpToolAnnotations | null;
  manualReadOnly?: boolean | null;
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
  const toolLabel = `MCP tool '${input.toolName}' on server '${input.serverLabel?.trim() || input.registryServerId || input.adapterId}'`;
  if (!policy.allowed && policy.rule) {
    return {
      allowed: false,
      reason: "policy",
      ruleId: policy.rule.id,
      ...(policy.rule.name ? { ruleName: policy.rule.name } : {}),
      policy,
      classification,
      message: `${toolLabel} is blocked by policy ${describePolicyRule(policy.rule)} for role ${input.role}.`
    };
  }
  if (input.noWriteTools && !classification.readOnly) {
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
