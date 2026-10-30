import type { McpPolicyCondition, McpToolPolicyConditions, McpToolPolicyRule } from "./types";

/**
 * Phase 12.4 — argument paths and the canonical form of a tool policy rule.
 *
 * A path is dot-separated keys; a key may be followed by `[n]` (that array
 * element) or `[*]` (any element), any number of times: `repo`,
 * `owner.login`, `items[*].id`, `matrix[0][*]`. Keys use letters, digits and
 * `_`, `-`, `$`, `@`; a key that holds a dot cannot be addressed.
 */

export const MCP_POLICY_PATH_MAX_LENGTH = 200;
export const MCP_POLICY_PATH_MAX_SEGMENTS = 16;

export type McpPolicyPathStep = { key: string } | { index: number } | { any: true };

const KEY = /^[A-Za-z0-9_$@-]+$/;
const KEY_WITH_INDEXES = /^([A-Za-z0-9_$@-]+)((?:\[(?:\*|\d{1,6})\])*)$/;
const INDEX = /\[(\*|\d{1,6})\]/g;

/** The steps of `path`, or null when it is not a valid path. */
export function parseMcpPolicyPath(path: string): McpPolicyPathStep[] | null {
  if (typeof path !== "string" || path.length === 0 || path.length > MCP_POLICY_PATH_MAX_LENGTH) return null;
  const steps: McpPolicyPathStep[] = [];
  for (const part of path.split(".")) {
    const match = KEY_WITH_INDEXES.exec(part);
    if (!match || !KEY.test(match[1])) return null;
    steps.push({ key: match[1] });
    for (const index of match[2].matchAll(INDEX)) {
      steps.push(index[1] === "*" ? { any: true } : { index: Number(index[1]) });
    }
  }
  return steps.length > MCP_POLICY_PATH_MAX_SEGMENTS ? null : steps;
}

/** JSON with object keys sorted and undefined members left out, so equal values always serialise the same. */
export function canonicalPolicyJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalPolicyJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalPolicyJson(entry)}`).join(",")}}`;
}

/** The conditions of a rule as a list and how they combine; an empty list means the rule has none. */
export function conditionList(conditions: McpToolPolicyConditions | null | undefined): { combine: "all" | "any"; items: McpPolicyCondition[] } {
  if (!conditions) return { combine: "all", items: [] };
  if ("any" in conditions && Array.isArray(conditions.any)) return { combine: "any", items: conditions.any };
  if ("all" in conditions && Array.isArray(conditions.all)) return { combine: "all", items: conditions.all };
  return { combine: "all", items: [] };
}

function canonicalCondition(condition: McpPolicyCondition): Record<string, unknown> {
  const value =
    (condition.op === "one_of" || condition.op === "not_one_of") && Array.isArray(condition.value)
      ? [...new Set(condition.value.map((entry) => canonicalPolicyJson(entry)))].sort().map((entry) => JSON.parse(entry) as unknown)
      : condition.value;
  return {
    op: condition.op,
    ...(condition.path !== undefined ? { path: condition.path } : {}),
    ...(value !== undefined ? { value } : {})
  };
}

/**
 * The canonical text of what a rule governs and does: effect, kind, scope
 * (project, roles, workflows, clients, server, tool pattern, annotation
 * hint) and conditions. Name, description, mode, enabled and timestamps are
 * left out, so a rule keeps its hash when it is renamed, switched between
 * shadow and enforce, or turned off. Lists are sorted and de-duplicated
 * (roles, workflows, clients, `one_of` values and the conditions
 * themselves, which combine the same in any order); a single condition
 * under `any` is the same rule as under `all`.
 */
export function canonicalMcpToolPolicyRule(rule: McpToolPolicyRule): string {
  const sorted = (values: readonly string[] | undefined) => [...new Set(values ?? [])].sort();
  const { combine, items } = conditionList(rule.conditions);
  const conditions = [...new Set(items.map((item) => canonicalPolicyJson(canonicalCondition(item))))].sort();
  return canonicalPolicyJson({
    v: 1,
    effect: rule.effect,
    kind: rule.kind ?? "tool",
    projectId: rule.projectId ?? null,
    roles: sorted(rule.roles),
    workflowIds: sorted(rule.workflowIds),
    clientIds: sorted(rule.clientIds),
    serverId: rule.serverId ?? null,
    toolPattern: rule.toolPattern.trim() || "*",
    annotationHint: rule.annotationHint ?? null,
    conditions:
      conditions.length === 0
        ? null
        : { combine: conditions.length === 1 ? "all" : combine, items: conditions.map((entry) => JSON.parse(entry) as unknown) }
  });
}
