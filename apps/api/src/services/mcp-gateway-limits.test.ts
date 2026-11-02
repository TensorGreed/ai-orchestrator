import { describe, expect, it, vi } from "vitest";
import { GatewayClientLimiter, sharedWindow } from "./mcp-gateway-limits.js";

const limit = (requestsPerMinute: number | null, burst: number | null = null, maxConcurrent: number | null = null) => ({ requestsPerMinute, burst, maxConcurrent });

describe("GatewayClientLimiter", () => {
  it("allows the burst at once, then refills at the per-minute rate", async () => {
    let now = 0;
    const limiter = new GatewayClientLimiter({ now: () => now });
    const rule = limit(60, 3);
    for (let index = 0; index < 3; index += 1) expect((await limiter.acquire("c", rule)).ok).toBe(true);
    const refused = await limiter.acquire("c", rule);
    expect(refused).toMatchObject({ ok: false, reason: "rate_limited", retryAfterMs: 1000 });
    now += 1000;
    expect((await limiter.acquire("c", rule)).ok).toBe(true);
    expect((await limiter.acquire("c", rule)).ok).toBe(false);
    // Another key has its own bucket.
    expect((await limiter.acquire("d", rule)).ok).toBe(true);
  });

  it("without a burst allows the per-minute count at once", async () => {
    const limiter = new GatewayClientLimiter({ now: () => 0 });
    for (let index = 0; index < 2; index += 1) expect((await limiter.acquire("c", limit(2))).ok).toBe(true);
    expect((await limiter.acquire("c", limit(2))).ok).toBe(false);
  });

  it("caps calls in flight, frees a slot on release once, and gives the slot back when the rate refuses", async () => {
    let now = 0;
    const limiter = new GatewayClientLimiter({ now: () => now });
    const first = await limiter.acquire("c", limit(null, null, 2));
    const second = await limiter.acquire("c", limit(null, null, 2));
    expect(first.ok && second.ok).toBe(true);
    expect(await limiter.acquire("c", limit(null, null, 2))).toMatchObject({ ok: false, reason: "concurrency_limited" });
    if (first.ok) {
      first.release();
      first.release();
    }
    expect(limiter.inFlightFor("c")).toBe(1);
    expect((await limiter.acquire("c", limit(null, null, 2))).ok).toBe(true);
    // Rate refusals do not hold a slot.
    const both = limit(1, null, 5);
    expect((await limiter.acquire("r", both)).ok).toBe(true);
    expect((await limiter.acquire("r", both)).ok).toBe(false);
    expect(limiter.inFlightFor("r")).toBe(1);
    now += 60_000;
  });

  it("counts the rate in the shared bucket in cluster mode, keyed by the limit, and falls back to memory when the database fails", async () => {
    const counts = new Map<string, number>();
    const hit = vi.fn(async ({ key }: { key: string; windowMs: number }) => {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return { count: counts.get(key)!, ttlMs: 4_000 };
    });
    const warn = vi.fn();
    const limiter = new GatewayClientLimiter({ shared: { hitRateLimitBucket: hit }, now: () => 0, logger: { warn } });
    expect((await limiter.acquire("client:c1", limit(30, 2))).ok).toBe(true);
    expect((await limiter.acquire("client:c1", limit(30, 2))).ok).toBe(true);
    expect(await limiter.acquire("client:c1", limit(30, 2))).toMatchObject({ ok: false, reason: "rate_limited", retryAfterMs: 4_000 });
    expect(hit).toHaveBeenLastCalledWith({ key: "rl:mcp-gateway:client:c1:30:2", windowMs: 4_000 });
    hit.mockRejectedValue(new Error("db down"));
    expect((await limiter.acquire("client:c2", limit(30, 1))).ok).toBe(true);
    expect((await limiter.acquire("client:c2", limit(30, 1))).ok).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    // A concurrency-only limit never touches the database.
    hit.mockClear();
    expect((await limiter.acquire("client:c3", limit(null, null, 1))).ok).toBe(true);
    expect(hit).not.toHaveBeenCalled();
  });

  it("sizes the shared window so the capacity per window is the per-minute rate, and never longer than a minute", () => {
    expect(sharedWindow(60, 60)).toEqual({ windowMs: 60_000, capacity: 60 });
    expect(sharedWindow(60, 10)).toEqual({ windowMs: 10_000, capacity: 10 });
    expect(sharedWindow(100_000, 1)).toEqual({ windowMs: 1, capacity: 1 });
    // A burst above the per-minute rate: a one-minute window of the per-minute rate (no ten-minute lockout).
    expect(sharedWindow(60, 600)).toEqual({ windowMs: 60_000, capacity: 60 });
  });

  it("in cluster mode a burst above the per-minute rate allows one minute's calls and a retry within the minute", async () => {
    const counts = new Map<string, number>();
    const windows: number[] = [];
    const hit = vi.fn(async ({ key, windowMs }: { key: string; windowMs: number }) => {
      windows.push(windowMs);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return { count: counts.get(key)!, ttlMs: 42_000 };
    });
    const limiter = new GatewayClientLimiter({ shared: { hitRateLimitBucket: hit }, now: () => 0 });
    for (let index = 0; index < 3; index += 1) expect((await limiter.acquire("client:c1", limit(3, 30))).ok).toBe(true);
    const refused = await limiter.acquire("client:c1", limit(3, 30));
    expect(refused).toMatchObject({ ok: false, reason: "rate_limited", retryAfterMs: 42_000 });
    expect(new Set(windows)).toEqual(new Set([60_000]));
  });
});
