/**
 * Phase 13.1 — values both stores use, kept out of database.ts so the Postgres store (db/postgres/**) never loads the
 * SQLite module (and its better-sqlite3 binding) for a constant.
 */
import { DEFAULT_MCP_SAMPLING_SETTINGS, type McpSamplingSettings } from "@ai-orchestrator/shared";

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
