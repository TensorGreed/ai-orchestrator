/**
 * Phase 13.1 — values both stores use, kept out of database.ts so the Postgres store (db/postgres/**) never loads the
 * SQLite module (and its better-sqlite3 binding) for a constant.
 */
import {
  DEFAULT_MCP_SAMPLING_SETTINGS,
  MCP_TOOL_POLICY_EFFECTS,
  mcpToolPolicyConditionsSchema,
  parseToolArgumentSummary,
  MCP_POLICY_SUGGESTION_STATUSES,
  type McpGatewayApproval,
  type McpGatewayApprovalStatus,
  type McpPolicySuggestedRule,
  type McpPolicySuggestion,
  type McpPolicySuggestionEvidence,
  type McpSamplingSettings,
  type McpToolPolicyDecisionRecord,
  type McpToolPolicyEffect,
  type McpToolPolicyRule
} from "@ai-orchestrator/shared";
import type { McpToolCallRecord, McpToolCallWrite } from "./database.js";
import type { McpToolCallScanFilter } from "./store.js";

/** Trigger types of runs made from golden runs and golden-set cases (replays, replay jobs, gate and eval runs). */
export const SUBJECT_EXECUTION_TRIGGERS = ["replay", "mcp_replay", "eval", "eval_judge"] as const;
/** Cassette sources made from golden runs and golden-set cases. */
export const SUBJECT_CASSETTE_SOURCES = ["replay", "eval"] as const;

export function normalizeMcpSamplingSettings(value: unknown): McpSamplingSettings {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const defaultModel =
    raw.defaultModel && typeof raw.defaultModel === "object" && !Array.isArray(raw.defaultModel)
      ? (raw.defaultModel as Record<string, unknown>)
      : null;
  const providerId = typeof defaultModel?.providerId === "string" ? defaultModel.providerId.trim() : "";
  const model = typeof defaultModel?.model === "string" ? defaultModel.model.trim() : "";
  const maxTokens = Number(raw.maxTokens);
  const maxRequests = Number(raw.maxRequestsPerCall);
  return {
    allow: raw.allow === true,
    maxTokens: Number.isFinite(maxTokens) && maxTokens >= 1 ? Math.floor(maxTokens) : DEFAULT_MCP_SAMPLING_SETTINGS.maxTokens,
    allowedModels: Array.isArray(raw.allowedModels)
      ? raw.allowedModels.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim())
      : [],
    maxRequestsPerCall:
      Number.isFinite(maxRequests) && maxRequests >= 0 ? Math.floor(maxRequests) : DEFAULT_MCP_SAMPLING_SETTINGS.maxRequestsPerCall,
    defaultModel: providerId && model ? { providerId, model } : null
  };
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function stringList(value: unknown): string[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
}

const UNREADABLE = Symbol("unreadable");

/**
 * A rule's stored conditions: `null` only for SQL NULL, an empty string or the JSON literal `null` (no conditions);
 * `UNREADABLE` for anything else that does not parse as JSON (or is not text), so it fails closed like conditions that
 * no longer validate instead of reading as "none".
 */
function storedConditions(value: unknown): unknown {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return UNREADABLE;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return UNREADABLE;
  }
}

/** Rules already reported as having invalid conditions, so a busy evaluator logs each one once per process. */
const reportedInvalidRules = new Set<string>();

/**
 * Phase 12.4 — the v47 rule columns of an `mcp_tool_policies` row (both stores). Stored conditions that no longer
 * parse or validate (caps tightened later, a manual or restored edit) are not guessed at: the rule is marked `invalid`
 * and fails closed in the evaluator (an allow never matches, a deny or require_approval covers its whole scope), and
 * the API and UI show it as needing a fix.
 */
export function mapMcpToolPolicyExtras(row: {
  id?: unknown;
  conditions_json?: unknown;
  mode?: unknown;
  workflow_ids_json?: unknown;
  client_ids_json?: unknown;
}): Pick<McpToolPolicyRule, "conditions" | "mode" | "workflowIds" | "clientIds" | "invalid"> {
  const stored = storedConditions(row.conditions_json);
  const conditions = stored === null || stored === UNREADABLE ? null : mcpToolPolicyConditionsSchema.safeParse(stored);
  const invalid = stored === UNREADABLE || (conditions !== null && !conditions.success);
  if (invalid) {
    const id = String(row.id ?? "");
    if (!reportedInvalidRules.has(id)) {
      reportedInvalidRules.add(id);
      console.warn(
        `MCP tool policy rule ${id || "(unknown)"} has stored conditions that no longer parse or validate; it fails closed until fixed.`
      );
    }
  }
  return {
    conditions: conditions?.success ? conditions.data : null,
    ...(invalid ? { invalid: true } : {}),
    mode: row.mode === "shadow" ? "shadow" : "enforce",
    workflowIds: stringList(row.workflow_ids_json),
    clientIds: stringList(row.client_ids_json)
  };
}

/** Phase 12.4 — a rule effect read from storage; anything unknown reads as `deny` (the safe side), as before. */
export function toMcpToolPolicyEffect(value: unknown): McpToolPolicyEffect {
  return MCP_TOOL_POLICY_EFFECTS.includes(value as McpToolPolicyEffect) ? (value as McpToolPolicyEffect) : "deny";
}

/** Phase 12.4 — `mcp_tool_calls.policy_decision_json`; null when absent or unreadable. */
export function parseMcpPolicyDecision(value: unknown): McpToolPolicyDecisionRecord | null {
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as McpToolPolicyDecisionRecord;
  return MCP_TOOL_POLICY_EFFECTS.includes(record.effect) && Array.isArray(record.matched) ? record : null;
}

const GATEWAY_APPROVAL_STATUSES: readonly McpGatewayApprovalStatus[] = ["pending", "approved", "rejected", "expired", "used"];

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

/** Phase 12.4 — an `mcp_gateway_approvals` row (both stores). */
export function mapMcpGatewayApproval(row: Record<string, unknown>): McpGatewayApproval {
  const text = (value: unknown) => (value === null || value === undefined || value === "" ? null : String(value));
  const status = String(row.status) as McpGatewayApprovalStatus;
  return {
    id: String(row.id),
    clientId: String(row.client_id),
    clientName: text(row.client_name),
    toolsetId: String(row.toolset_id),
    projectId: text(row.project_id),
    serverId: String(row.server_id),
    serverName: text(row.server_name),
    toolName: String(row.tool_name),
    gatewayToolName: String(row.gateway_tool_name),
    argsHash: String(row.args_hash),
    argsPreview: text(row.args_preview),
    ruleId: text(row.rule_id),
    ruleName: text(row.rule_name),
    message: text(row.message),
    status: GATEWAY_APPROVAL_STATUSES.includes(status) ? status : "expired",
    requestedAt: isoOrNull(row.requested_at) ?? "",
    expiresAt: isoOrNull(row.expires_at) ?? "",
    decidedBy: text(row.decided_by),
    decidedAt: isoOrNull(row.decided_at),
    decisionReason: text(row.decision_reason),
    usedAt: isoOrNull(row.used_at)
  };
}

/** Phase 12.4 — the argument summary and subject columns of an mcp_tool_calls row (shared with the Postgres store). */
export function mapMcpToolCallContext(row: {
  args_summary_json?: unknown;
  subject_role?: unknown;
  subject_source?: unknown;
  project_id?: unknown;
}): Pick<McpToolCallRecord, "argsSummary" | "subjectRole" | "subjectSource" | "projectId"> {
  const role = row.subject_role;
  const source = row.subject_source;
  return {
    argsSummary: row.args_summary_json ? parseToolArgumentSummary(String(row.args_summary_json)) : null,
    subjectRole: role === "admin" || role === "builder" || role === "operator" || role === "viewer" ? role : null,
    subjectSource: source === "user" || source === "owner" || source === "fallback" || source === "client" ? source : null,
    projectId: row.project_id ? String(row.project_id) : null
  };
}

/** Phase 12.4 — the values written to the argument summary and subject columns, in column order. */
export function mcpToolCallContextValues(call: McpToolCallWrite): [string | null, string | null, string | null, string | null] {
  return [call.argsSummary ? JSON.stringify(call.argsSummary) : null, call.subjectRole ?? null, call.subjectSource ?? null, call.projectId ?? null];
}

/**
 * Phase 12.4 — the columns a tool-call window scan reads (both stores). Timings, tokens and costs are not needed by
 * simulation, suggestions or shadow hits, so they read as NULL and are not loaded.
 */
export const MCP_TOOL_CALL_SCAN_COLUMNS = [
  "id",
  "execution_id",
  "workflow_id",
  "node_id",
  "registry_server_id",
  "adapter_id",
  "tool_name",
  "started_at",
  "NULL AS duration_ms",
  "ok",
  "error",
  "NULL AS turn_input_tokens",
  "NULL AS turn_output_tokens",
  "NULL AS estimated_cost_usd",
  "NULL AS sampling_requests",
  "NULL AS sampling_input_tokens",
  "NULL AS sampling_output_tokens",
  "source",
  "client_id",
  "rejection",
  "policy_decision_json",
  "args_summary_json",
  "subject_role",
  "subject_source",
  "project_id",
  "created_at"
].join(", ");

/**
 * Phase 12.4 — the WHERE clause and parameters of a tool-call scan page (both stores), with `placeholder(n)` writing
 * the n-th parameter (`?` on SQLite, `$n` on Postgres) and `idOrder` the id column as the store orders it.
 */
export function mcpToolCallScanWhere(
  filter: McpToolCallScanFilter,
  placeholder: (index: number) => string,
  idOrder: string
): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const next = (value: unknown) => {
    params.push(value);
    return placeholder(params.length);
  };
  const clauses = [`started_at >= ${next(filter.since)}`, `started_at < ${next(filter.until)}`];
  const sources: readonly string[] = filter.sources.length > 0 ? filter.sources : ["workflow"];
  clauses.push(`source IN (${sources.map((source) => next(source)).join(", ")})`);
  if (filter.before) {
    const at = next(filter.before.startedAt);
    const sameAt = next(filter.before.startedAt);
    clauses.push(`(started_at < ${at} OR (started_at = ${sameAt} AND ${idOrder} < ${next(filter.before.id)}))`);
  }
  if (filter.excludeAdapterId) clauses.push(`adapter_id <> ${next(filter.excludeAdapterId)}`);
  if (filter.workflowId) clauses.push(`workflow_id = ${next(filter.workflowId)}`);
  if (filter.clientId) clauses.push(`client_id = ${next(filter.clientId)}`);
  if (filter.serverId) {
    const registry = next(filter.serverId);
    clauses.push(`(registry_server_id = ${registry} OR (registry_server_id IS NULL AND adapter_id = ${next(filter.serverId)}))`);
  }
  if (filter.toolName) clauses.push(`tool_name = ${next(filter.toolName)}`);
  if (filter.withPolicyDecision) clauses.push(`policy_decision_json IS NOT NULL`);
  return { where: clauses.join(" AND "), params };
}

function parseJsonValue(value: unknown): unknown {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const EMPTY_SUGGESTION_EVIDENCE: McpPolicySuggestionEvidence = { calls: 0, scopeCalls: 0, roles: [], tools: [], capped: false };

/** Phase 12.4 — an `mcp_policy_suggestions` row (both stores). */
export function mapMcpPolicySuggestion(row: Record<string, unknown>): McpPolicySuggestion {
  const text = (value: unknown) => (value === null || value === undefined || value === "" ? null : String(value));
  const status = String(row.status) as McpPolicySuggestion["status"];
  const rules = parseJsonValue(row.rules_json);
  const evidence = parseJsonValue(row.evidence_json);
  const accepted = parseJsonValue(row.accepted_rule_ids_json);
  return {
    id: String(row.id),
    scopeKind: row.scope_kind === "client" ? "client" : "workflow",
    scopeId: String(row.scope_id),
    scopeName: text(row.scope_name),
    serverId: String(row.server_id),
    serverName: text(row.server_name),
    status: MCP_POLICY_SUGGESTION_STATUSES.includes(status) ? status : "dismissed",
    rules: Array.isArray(rules) ? (rules as McpPolicySuggestedRule[]) : [],
    evidence: evidence && typeof evidence === "object" && !Array.isArray(evidence) ? (evidence as McpPolicySuggestionEvidence) : EMPTY_SUGGESTION_EVIDENCE,
    fingerprint: String(row.fingerprint),
    windowDays: Number(row.window_days),
    windowStart: isoOrNull(row.window_start) ?? "",
    windowEnd: isoOrNull(row.window_end) ?? "",
    callCount: Number(row.call_count),
    acceptedRuleIds: Array.isArray(accepted) ? accepted.filter((id): id is string => typeof id === "string") : [],
    createdBy: text(row.created_by),
    createdAt: isoOrNull(row.created_at) ?? "",
    updatedAt: isoOrNull(row.updated_at) ?? "",
    decidedBy: text(row.decided_by),
    decidedAt: isoOrNull(row.decided_at)
  };
}
