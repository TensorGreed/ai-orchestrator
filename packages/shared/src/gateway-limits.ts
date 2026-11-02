import { z } from "zod";

/**
 * 12.6 (D5, D6) — budgets and rate limits for the MCP gateway.
 *
 * A rate limit is optional on a client and, as a default for each of its clients, on a toolset. A client's own limit
 * replaces the toolset's default as a whole (fields are not mixed). Absent everywhere = no limit, as before.
 */

/** The most each field accepts. */
export const MCP_GATEWAY_RATE_LIMIT_MAX = { requestsPerMinute: 100_000, burst: 100_000, maxConcurrent: 1_000 } as const;

/** Calls a client may make: per minute (with a burst), and at once. Each field is optional; null = no limit there. */
export interface McpGatewayRateLimit {
  /** Sustained `tools/call` rate per minute; null = no rate limit. */
  requestsPerMinute: number | null;
  /** Calls allowed at once before the per-minute rate applies; null = the per-minute rate. Needs `requestsPerMinute`. */
  burst: number | null;
  /** Calls in flight at once; null = no limit. */
  maxConcurrent: number | null;
}

const limitField = (max: number) => z.number().int().min(1).max(max).nullable().optional();

/**
 * A rate limit as an admin sends it. Missing fields mean "no limit there"; null (or a limit with every field empty)
 * removes the limit.
 */
export const mcpGatewayRateLimitSchema = z
  .object({
    requestsPerMinute: limitField(MCP_GATEWAY_RATE_LIMIT_MAX.requestsPerMinute),
    burst: limitField(MCP_GATEWAY_RATE_LIMIT_MAX.burst),
    maxConcurrent: limitField(MCP_GATEWAY_RATE_LIMIT_MAX.maxConcurrent)
  })
  .strict()
  .refine((value) => value.burst === undefined || value.burst === null || (value.requestsPerMinute !== undefined && value.requestsPerMinute !== null), {
    message: "burst needs requestsPerMinute",
    path: ["burst"]
  });

export type McpGatewayRateLimitInput = z.infer<typeof mcpGatewayRateLimitSchema>;

/** The stored form: every field present; null when no field sets a limit. */
export function normalizeGatewayRateLimit(input: McpGatewayRateLimitInput | McpGatewayRateLimit | null | undefined): McpGatewayRateLimit | null {
  if (!input) return null;
  const limit: McpGatewayRateLimit = {
    requestsPerMinute: input.requestsPerMinute ?? null,
    burst: input.requestsPerMinute ? (input.burst ?? null) : null,
    maxConcurrent: input.maxConcurrent ?? null
  };
  return limit.requestsPerMinute === null && limit.maxConcurrent === null ? null : limit;
}

/** Reads a stored rate limit (JSON text or an object); anything that does not validate counts as no limit. */
export function parseStoredGatewayRateLimit(value: unknown): McpGatewayRateLimit | null {
  if (value === null || value === undefined || value === "") return null;
  let raw: unknown = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const parsed = mcpGatewayRateLimitSchema.safeParse(raw);
  return parsed.success ? normalizeGatewayRateLimit(parsed.data) : null;
}

/** Where the limit a call runs under comes from: the client's own, or the toolset's default for each client. */
export type McpGatewayRateLimitSource = "client" | "toolset";

/**
 * The limit for a client's calls through a toolset: the client's own when it has one, else the toolset's default.
 * A client's own limit is one budget across every toolset it calls; a toolset default is one budget per client and
 * toolset. Null = no limit.
 */
export function effectiveGatewayRateLimit(
  client: { id: string; rateLimit?: McpGatewayRateLimit | null },
  toolset: { id: string; rateLimit?: McpGatewayRateLimit | null }
): { limit: McpGatewayRateLimit; source: McpGatewayRateLimitSource; key: string } | null {
  if (client.rateLimit) return { limit: client.rateLimit, source: "client", key: `client:${client.id}` };
  if (toolset.rateLimit) return { limit: toolset.rateLimit, source: "toolset", key: `client:${client.id}:toolset:${toolset.id}` };
  return null;
}

/** An admin's change to a gateway client: its name and its rate limit (null removes it). Nothing else changes. */
export const mcpClientUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    rateLimit: mcpGatewayRateLimitSchema.nullable().optional()
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "Empty update payload" });

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/**
 * What a budget counts. `mcp_client` (12.6): an MCP gateway client's usage (the workflow runs its tool calls start,
 * and the sampling its server tool calls use). A toolset's project budget also counts that toolset's gateway usage.
 */
export const BUDGET_SCOPE_TYPES = ["global", "project", "workflow", "user", "mcp_client"] as const;
export type BudgetScopeType = (typeof BUDGET_SCOPE_TYPES)[number];

export function isBudgetScopeType(value: unknown): value is BudgetScopeType {
  return typeof value === "string" && (BUDGET_SCOPE_TYPES as readonly string[]).includes(value);
}

/** One budget that applies to a gateway client, with what it counted so far this period (the client's Governance). */
export interface McpClientBudgetUsage {
  budgetId: string;
  name: string;
  scopeType: BudgetScopeType;
  scopeId: string | null;
  period: "day" | "week" | "month";
  limitType: "usd" | "tokens";
  limitValue: number;
  action: "warn" | "block";
  enabled: boolean;
  /** What the budget counted from `periodStart` until now (USD or tokens, as `limitType`). */
  current: number;
  periodStart: string;
}
