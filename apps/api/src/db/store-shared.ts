/**
 * Phase 13.1 — values both stores use, kept out of database.ts so the Postgres store (db/postgres/**) never loads the
 * SQLite module (and its better-sqlite3 binding) for a constant.
 */
import {
  DEFAULT_MCP_SAMPLING_SETTINGS,
  MCP_TOOL_POLICY_EFFECTS,
  mcpToolPolicyConditionsSchema,
  type McpGatewayApproval,
  type McpGatewayApprovalStatus,
  type McpSamplingSettings,
  type McpToolPolicyDecisionRecord,
  type McpToolPolicyEffect,
  type McpToolPolicyRule
} from "@ai-orchestrator/shared";

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

/**
 * Phase 12.4 — the v47 rule columns of an `mcp_tool_policies` row (both stores). Stored conditions that no longer
 * validate are dropped rather than guessed at: the rule then has none, which the API never writes.
 */
export function mapMcpToolPolicyExtras(row: {
  conditions_json?: unknown;
  mode?: unknown;
  workflow_ids_json?: unknown;
  client_ids_json?: unknown;
}): Pick<McpToolPolicyRule, "conditions" | "mode" | "workflowIds" | "clientIds"> {
  const conditions = mcpToolPolicyConditionsSchema.safeParse(parseJson(row.conditions_json));
  return {
    conditions: conditions.success ? conditions.data : null,
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
