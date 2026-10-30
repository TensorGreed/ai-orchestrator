import { z } from "zod";
import { mcpToolPolicyRuleInputSchema } from "./schemas";
import type { ToolArgumentSummary } from "./tool-argument-summary";
import type { McpPolicyRole, McpToolPolicyEffect, McpToolPolicyMode, McpToolPolicyRule } from "./types";

/**
 * Phase 12.4 — policies learned from real runs, part 2.
 *
 * Simulation: a draft set of MCP tool rules is evaluated against the tool
 * calls recorded in the last 7 or 30 days (their subject, tool and argument
 * SUMMARY; nothing is replayed) and compared with the current rules.
 * Suggestions: least-privilege rules proposed per workflow and per gateway
 * client from the calls they made, reviewed by an admin, accepted in shadow
 * mode and enforced later.
 */

export const MCP_POLICY_SIMULATION_WINDOW_DAYS = [7, 30] as const;
export type McpPolicySimulationWindowDays = (typeof MCP_POLICY_SIMULATION_WINDOW_DAYS)[number];

/** Most rules a draft rule set may hold. */
export const MCP_POLICY_SIMULATION_MAX_RULES = 200;
/** Most example calls shown per bucket. */
export const MCP_POLICY_SIMULATION_MAX_EXAMPLES = 20;

/**
 * What the draft does to a recorded call compared with the current rules.
 * `undetermined`: the argument summary cannot say (never counted as allowed or
 * denied). `not_summarised`: the call has no summary (summaries were off, or it
 * was recorded before they existed).
 */
export const MCP_POLICY_SIMULATION_BUCKETS = [
  "newly_denied",
  "newly_needs_approval",
  "no_longer_denied",
  "no_longer_needs_approval",
  "unchanged",
  "undetermined",
  "not_summarised"
] as const;
export type McpPolicySimulationBucketName = (typeof MCP_POLICY_SIMULATION_BUCKETS)[number];
export type McpPolicySimulationCounts = Record<McpPolicySimulationBucketName, number>;

const principalIdSchema = z.string().trim().min(1).max(200);

/** A draft rule: a rule as created through the API, with the id of the rule it edits (absent for a new one). */
export const mcpPolicyDraftRuleSchema = mcpToolPolicyRuleInputSchema.and(z.object({ id: principalIdSchema.optional() }));
export type McpPolicyDraftRule = z.infer<typeof mcpPolicyDraftRuleSchema>;

export const mcpPolicySimulationRequestSchema = z
  .object({
    windowDays: z.union([z.literal(7), z.literal(30)]).default(7),
    /** The whole draft rule set (the current rules with edits, additions or removals), in evaluation order. */
    rules: z.array(mcpPolicyDraftRuleSchema).max(MCP_POLICY_SIMULATION_MAX_RULES).optional(),
    /** One draft rule added after the current rules; it is simulated as enforced whatever its mode. */
    addRule: mcpPolicyDraftRuleSchema.optional(),
    filters: z
      .object({
        workflowId: principalIdSchema.optional(),
        clientId: principalIdSchema.optional(),
        serverId: principalIdSchema.optional(),
        toolName: z.string().trim().min(1).max(500).optional()
      })
      .strict()
      .optional(),
    /** Example calls per bucket (at most 20). */
    examples: z.number().int().min(0).max(MCP_POLICY_SIMULATION_MAX_EXAMPLES).optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.rules === undefined) === (value.addRule === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rules"], message: "Give either the whole draft rule set (rules) or one rule to add (addRule)" });
    }
  });
export type McpPolicySimulationRequest = z.input<typeof mcpPolicySimulationRequestSchema>;

export interface McpPolicySimulationExample {
  callId: string;
  startedAt: string;
  toolName: string;
  serverId: string;
  serverName: string | null;
  source: "workflow" | "gateway";
  workflowId: string | null;
  workflowName: string | null;
  clientId: string | null;
  clientName: string | null;
  role: McpPolicyRole | null;
  /** null when the summary cannot decide it. */
  currentEffect: McpToolPolicyEffect | null;
  draftEffect: McpToolPolicyEffect | null;
  /** The draft rule that decided the call, when one did in every reading. */
  draftRuleId: string | null;
  currentRuleId: string | null;
  /** Why the call is undetermined. */
  reason: string | null;
  /** The recorded argument summary (never the arguments). */
  summary: ToolArgumentSummary | null;
}

export interface McpPolicySimulationRuleRow {
  ruleId: string;
  name: string | null;
  effect: McpToolPolicyEffect;
  mode: McpToolPolicyMode;
  /** `current`: removed in the draft; `draft`: new in the draft; `both`: kept (possibly edited). */
  presence: "current" | "draft" | "both";
  /** Calls the rule matched in the draft (enforced draft rules only). */
  matched: number;
  /** Calls where the summary cannot tell whether the rule matches. */
  undetermined: number;
  /** Calls this rule newly denies / newly sends for approval (as the deciding draft rule). */
  newlyDenied: number;
  newlyNeedsApproval: number;
  /** Calls this rule denied / sent for approval under the current rules and no longer does. */
  noLongerDenied: number;
  noLongerNeedsApproval: number;
}

export interface McpPolicySimulationGroup {
  kind: "workflow" | "client";
  id: string;
  name: string | null;
  counts: McpPolicySimulationCounts;
}

export interface McpPolicySimulationResult {
  windowDays: McpPolicySimulationWindowDays;
  since: string;
  until: string;
  /** Calls read (newest first). */
  scanned: number;
  /** True when the scan stopped at `scanCap` before the start of the window; `oldestScannedAt` says how far it got. */
  capped: boolean;
  scanCap: number;
  oldestScannedAt: string | null;
  counts: McpPolicySimulationCounts;
  rules: McpPolicySimulationRuleRow[];
  groups: McpPolicySimulationGroup[];
  /** More groups than listed (the ones with the most changes come first). */
  groupsCapped: boolean;
  examples: Record<McpPolicySimulationBucketName, McpPolicySimulationExample[]>;
}

export function emptyMcpPolicySimulationCounts(): McpPolicySimulationCounts {
  return Object.fromEntries(MCP_POLICY_SIMULATION_BUCKETS.map((bucket) => [bucket, 0])) as McpPolicySimulationCounts;
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

export const MCP_POLICY_SUGGESTION_STATUSES = ["open", "accepted", "dismissed"] as const;
export type McpPolicySuggestionStatus = (typeof MCP_POLICY_SUGGESTION_STATUSES)[number];

/** Calls a workflow or gateway client needs in the window before rules are suggested for it. */
export const MCP_POLICY_SUGGESTION_MIN_CALLS_DEFAULT = 20;
export const MCP_POLICY_SUGGESTION_WINDOW_DAYS = 30;
/** One_of constraints: at most this many distinct values, each seen in at least two calls. */
export const MCP_POLICY_SUGGESTION_MAX_DISTINCT = 10;
export const MCP_POLICY_SUGGESTION_MIN_SEEN = 2;
/** Numeric maximum constraints: observed maximum times this, rounded up. */
export const MCP_POLICY_SUGGESTION_NUMBER_HEADROOM = 1.5;

export const mcpPolicySuggestionGenerateSchema = z
  .object({
    minCalls: z.number().int().min(5).max(100_000).optional()
  })
  .strict();

export const mcpPolicySuggestionListQuerySchema = z
  .object({
    status: z.enum(["open", "accepted", "dismissed", "all"]).optional()
  })
  .strict();

/** A rule a suggestion proposes, as it would be created (accepting creates it in shadow mode). */
export type McpPolicySuggestedRule = Pick<
  McpToolPolicyRule,
  "name" | "description" | "effect" | "projectId" | "roles" | "serverId" | "toolPattern" | "workflowIds" | "clientIds" | "conditions"
> & { kind: "tool" };

/** An argument constraint the evidence supports, or why one was not proposed. */
export interface McpPolicySuggestionConstraint {
  path: string;
  kind: "one_of" | "max";
  /** Kept values (tokens, schema enum values, booleans) for `one_of`; never a hashed value. */
  values?: Array<string | number | boolean>;
  /** For `max`: the largest value seen and the proposed limit. */
  observedMax?: number;
  limit?: number;
}

export type McpPolicySuggestionSkipReason =
  | "hashed"
  | "free_text"
  | "too_many_values"
  | "rare_values"
  | "not_always_present"
  | "location"
  | "not_positive"
  | "mixed_types"
  | "both_values";

export interface McpPolicySuggestionToolEvidence {
  toolName: string;
  calls: number;
  constraints: McpPolicySuggestionConstraint[];
  skipped: Array<{ path: string; reason: McpPolicySuggestionSkipReason }>;
}

export interface McpPolicySuggestionEvidence {
  /** Calls the suggestion is built from (reached the server, not by an admin, with a recorded role). */
  calls: number;
  /** Calls of the workflow or client in the window, before those exclusions. */
  scopeCalls: number;
  roles: McpPolicyRole[];
  tools: McpPolicySuggestionToolEvidence[];
  /** True when the scan stopped at its cap before the start of the window. */
  capped: boolean;
}

export interface McpPolicySuggestion {
  id: string;
  scopeKind: "workflow" | "client";
  scopeId: string;
  scopeName: string | null;
  /** A registry server id, or an adapter id for servers configured inline. */
  serverId: string;
  serverName: string | null;
  status: McpPolicySuggestionStatus;
  rules: McpPolicySuggestedRule[];
  evidence: McpPolicySuggestionEvidence;
  /** sha256 of the proposed rules (their canonical hashes): the same proposal is not offered again once dismissed. */
  fingerprint: string;
  windowDays: number;
  windowStart: string;
  windowEnd: string;
  callCount: number;
  /** Rules created when the suggestion was accepted (in shadow mode). */
  acceptedRuleIds: string[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
}

/** Why a workflow or client got no suggestion in a generation run. */
export interface McpPolicySuggestionSkip {
  scopeKind: "workflow" | "client";
  scopeId: string;
  scopeName: string | null;
  serverId: string | null;
  reason: "too_few_calls" | "would_loosen" | "dismissed_before" | "already_accepted" | "already_in_place" | "glob_tool_name";
  detail?: string;
}

export interface McpPolicySuggestionGenerateResult {
  windowDays: number;
  since: string;
  until: string;
  minCalls: number;
  scanned: number;
  capped: boolean;
  created: number;
  updated: number;
  unchanged: number;
  skipped: McpPolicySuggestionSkip[];
  suggestions: McpPolicySuggestion[];
}

/** Shadow rule hits read from recorded policy decisions (`mcp_tool_calls.policy_decision_json`). */
export interface McpPolicyShadowHitRow {
  ruleId: string;
  /** Calls the shadow rule matched. */
  matched: number;
  /** Calls whose outcome the shadow rule would have changed, had it been enforced. */
  wouldChange: number;
  lastMatchedAt: string | null;
  lastWouldChangeAt: string | null;
}

export interface McpPolicyShadowHits {
  days: number;
  since: string;
  scanned: number;
  capped: boolean;
  rules: McpPolicyShadowHitRow[];
}

export const mcpPolicyShadowHitsQuerySchema = z
  .object({
    days: z.coerce.number().int().min(1).max(30).optional()
  })
  .strict();
