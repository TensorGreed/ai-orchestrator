import { describe, expect, it } from "vitest";
import {
  BUDGET_SCOPE_TYPES,
  effectiveGatewayRateLimit,
  isBudgetScopeType,
  mcpClientUpdateSchema,
  mcpGatewayRateLimitSchema,
  normalizeGatewayRateLimit,
  parseStoredGatewayRateLimit
} from "./gateway-limits";
import { mcpToolsetInputSchema, mcpToolsetUpdateSchema } from "./schemas";

describe("gateway rate limits", () => {
  it("accepts optional fields and refuses a burst without a rate, zero, fractions and unknown keys", () => {
    expect(mcpGatewayRateLimitSchema.safeParse({}).success).toBe(true);
    expect(mcpGatewayRateLimitSchema.safeParse({ requestsPerMinute: 60, burst: 10, maxConcurrent: 2 }).success).toBe(true);
    expect(mcpGatewayRateLimitSchema.safeParse({ maxConcurrent: 3 }).success).toBe(true);
    expect(mcpGatewayRateLimitSchema.safeParse({ burst: 5 }).success).toBe(false);
    expect(mcpGatewayRateLimitSchema.safeParse({ requestsPerMinute: 0 }).success).toBe(false);
    expect(mcpGatewayRateLimitSchema.safeParse({ requestsPerMinute: 1.5 }).success).toBe(false);
    expect(mcpGatewayRateLimitSchema.safeParse({ maxConcurrent: 1001 }).success).toBe(false);
    expect(mcpGatewayRateLimitSchema.safeParse({ rpm: 5 }).success).toBe(false);
  });

  it("normalizes to every field, and to null when nothing is limited", () => {
    expect(normalizeGatewayRateLimit({ requestsPerMinute: 60 })).toEqual({ requestsPerMinute: 60, burst: null, maxConcurrent: null });
    expect(normalizeGatewayRateLimit({ maxConcurrent: 2 })).toEqual({ requestsPerMinute: null, burst: null, maxConcurrent: 2 });
    expect(normalizeGatewayRateLimit({})).toBeNull();
    expect(normalizeGatewayRateLimit({ requestsPerMinute: null, maxConcurrent: null })).toBeNull();
    expect(normalizeGatewayRateLimit(null)).toBeNull();
  });

  it("reads stored JSON back, and anything invalid as no limit", () => {
    expect(parseStoredGatewayRateLimit('{"requestsPerMinute":30,"burst":5,"maxConcurrent":null}')).toEqual({ requestsPerMinute: 30, burst: 5, maxConcurrent: null });
    expect(parseStoredGatewayRateLimit(null)).toBeNull();
    expect(parseStoredGatewayRateLimit("not json")).toBeNull();
    expect(parseStoredGatewayRateLimit('{"burst":5}')).toBeNull();
  });

  it("uses the client's own limit as a whole, else the toolset default, keyed per client or per client and toolset", () => {
    const own = { requestsPerMinute: 10, burst: null, maxConcurrent: null };
    const fallback = { requestsPerMinute: null, burst: null, maxConcurrent: 4 };
    expect(effectiveGatewayRateLimit({ id: "c1", rateLimit: own }, { id: "t1", rateLimit: fallback })).toEqual({ limit: own, source: "client", key: "client:c1" });
    expect(effectiveGatewayRateLimit({ id: "c1", rateLimit: null }, { id: "t1", rateLimit: fallback })).toEqual({ limit: fallback, source: "toolset", key: "client:c1:toolset:t1" });
    expect(effectiveGatewayRateLimit({ id: "c1" }, { id: "t1" })).toBeNull();
  });

  it("lets a client update change only its name and rate limit", () => {
    expect(mcpClientUpdateSchema.safeParse({ name: "Renamed" }).success).toBe(true);
    expect(mcpClientUpdateSchema.safeParse({ rateLimit: null }).success).toBe(true);
    expect(mcpClientUpdateSchema.safeParse({ rateLimit: { requestsPerMinute: 5 } }).success).toBe(true);
    expect(mcpClientUpdateSchema.safeParse({}).success).toBe(false);
    expect(mcpClientUpdateSchema.safeParse({ role: "admin" }).success).toBe(false);
    expect(mcpClientUpdateSchema.safeParse({ toolsetIds: ["t2"] }).success).toBe(false);
  });

  it("lets a toolset carry a default limit, and clear it", () => {
    expect(mcpToolsetInputSchema.safeParse({ name: "T", rateLimit: { maxConcurrent: 2 } }).success).toBe(true);
    expect(mcpToolsetUpdateSchema.safeParse({ rateLimit: null }).success).toBe(true);
    expect(mcpToolsetUpdateSchema.safeParse({ rateLimit: { burst: 3 } }).success).toBe(false);
  });
});

describe("budget scopes", () => {
  it("include the gateway client scope", () => {
    expect(BUDGET_SCOPE_TYPES).toEqual(["global", "project", "workflow", "user", "mcp_client"]);
    expect(isBudgetScopeType("mcp_client")).toBe(true);
    expect(isBudgetScopeType("toolset")).toBe(false);
  });
});
