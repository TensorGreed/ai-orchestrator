import { responseBoundaryForTrigger } from "@ai-orchestrator/shared";
import type { UserRole } from "./services/auth-service.js";

/**
 * Phase 12 coverage — run views for readers below builder. A run that answered an external caller (webhook, chat,
 * MCP trigger invoke) keeps each node's result as it ran: builders debug from it. Its output is the checked one the
 * caller got. While response rules exist, a viewer or operator (who may be that caller: a chat signed in as a viewer,
 * a viewer service account) would otherwise read the withheld or redacted output back from the node results, so for
 * them those results show status and timing only, and run events that carry node data are not sent.
 */
export const HIDDEN_BY_RESPONSE_RULES = "Hidden by content rules: this run answered an external caller under response rules.";

const BELOW_BUILDER: ReadonlySet<UserRole> = new Set<UserRole>(["viewer", "operator"]);

/** Whether this user's view of this run hides node data. `rulesExist`: a stored rule set has a `response` channel. */
export function runViewHidesNodeData(role: UserRole, triggerType: string | null | undefined, rulesExist: boolean): boolean {
  return rulesExist && BELOW_BUILDER.has(role) && responseBoundaryForTrigger(triggerType) !== undefined;
}

/** The node result fields that carry no run data. */
const KEPT_NODE_FIELDS = ["nodeId", "nodeType", "status", "startedAt", "completedAt", "durationMs", "attempts", "retryable", "errorCategory"] as const;

/** One node result (or a node_complete event) with status and timing only. */
export function maskNodeResult(entry: unknown): unknown {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
  const source = entry as Record<string, unknown>;
  const masked: Record<string, unknown> = {};
  for (const key of KEPT_NODE_FIELDS) if (key in source) masked[key] = source[key];
  masked.output = HIDDEN_BY_RESPONSE_RULES;
  if (typeof source.error === "string" && source.error) masked.error = HIDDEN_BY_RESPONSE_RULES;
  return masked;
}

/** A stored run or a run result with every node result masked; the run's own output (already checked) stays. */
export function maskRunNodeData<T>(run: T): T {
  if (!run || typeof run !== "object" || Array.isArray(run)) return run;
  const record = run as Record<string, unknown>;
  const masked: Record<string, unknown> = { ...record };
  if (Array.isArray(record.nodeResults)) masked.nodeResults = record.nodeResults.map(maskNodeResult);
  // A failed run's error can quote node data; the caller got a generic one.
  if (typeof record.error === "string" && record.error && record.status === "error") masked.error = HIDDEN_BY_RESPONSE_RULES;
  return masked as T;
}

/**
 * A reattach event for a masked view: the stored run and the result are masked, node_complete keeps status and
 * timing, and events made of node data (model deltas, progress, activity) are dropped (null).
 */
export function maskRunEvent(event: string, payload: unknown): unknown | null {
  if (event === "execution" || event === "result") return maskRunNodeData(payload);
  if (event === "node_complete") return maskNodeResult(payload);
  if (event === "llm_delta" || event === "node_progress" || event === "node_activity") return null;
  return payload;
}
