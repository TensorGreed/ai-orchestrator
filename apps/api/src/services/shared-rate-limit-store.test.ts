/**
 * Phase 13.1 — SharedRateLimitStore: routes that name a shared bucket count in the store (one bucket per route and
 * client key), everything else (the global limiter) stays in memory as the plugin's LocalStore keeps it, and a store
 * error falls back to memory with one warning.
 */
import { describe, expect, it, vi } from "vitest";
import { createSharedRateLimitStore, SHARED_RATE_LIMIT_BUCKET, type RateLimitStoreLike } from "./shared-rate-limit-store.js";

function incr(store: RateLimitStoreLike, key: string, windowMs = 60_000): Promise<{ current: number; ttl: number }> {
  return new Promise((resolve, reject) => store.incr(key, (error, result) => (error ? reject(error) : resolve(result!)), windowMs, 5));
}

describe("SharedRateLimitStore", () => {
  it("counts a shared-bucket route in the store, keyed by bucket, route and client", async () => {
    const hits: Array<{ key: string; windowMs: number }> = [];
    const counts = new Map<string, number>();
    const Store = createSharedRateLimitStore({
      store: {
        hitRateLimitBucket: async (input) => {
          hits.push(input);
          const count = (counts.get(input.key) ?? 0) + 1;
          counts.set(input.key, count);
          return { count, ttlMs: 42_000 };
        }
      }
    });
    const root = new Store({});
    const login = root.child({ [SHARED_RATE_LIMIT_BUCKET]: "auth", routeInfo: { method: "POST", url: "/api/auth/login" } });
    expect(await incr(login, "10.0.0.1")).toEqual({ current: 1, ttl: 42_000 });
    expect(await incr(login, "10.0.0.1")).toEqual({ current: 2, ttl: 42_000 });
    const hook = root.child({ [SHARED_RATE_LIMIT_BUCKET]: "webhook", routeInfo: { method: ["GET", "POST"], url: "/webhook/:path" } });
    await incr(hook, "10.0.0.1", 1_000);
    expect(hits.map((hit) => hit.key)).toEqual([
      "rl:auth:POST /api/auth/login:10.0.0.1",
      "rl:auth:POST /api/auth/login:10.0.0.1",
      "rl:webhook:GET,POST /webhook/:path:10.0.0.1"
    ]);
    expect(hits[2]!.windowMs).toBe(1_000);
  });

  it("keeps the global limiter and routes without a shared bucket in memory", async () => {
    const hitRateLimitBucket = vi.fn();
    const Store = createSharedRateLimitStore({ store: { hitRateLimitBucket } });
    const root = new Store({});
    expect((await incr(root, "ip")).current).toBe(1);
    expect((await incr(root, "ip")).current).toBe(2);
    const plain = root.child({ routeInfo: { method: "GET", url: "/x" } });
    expect((await incr(plain, "ip")).current).toBe(1);
    expect(hitRateLimitBucket).not.toHaveBeenCalled();
  });

  it("counts in memory when the store fails, warning once per interval", async () => {
    const warn = vi.fn();
    const Store = createSharedRateLimitStore({
      store: { hitRateLimitBucket: async () => { throw new Error("connection refused"); } },
      logger: { warn }
    });
    const login = new Store({}).child({ [SHARED_RATE_LIMIT_BUCKET]: "auth", routeInfo: { method: "POST", url: "/api/auth/login" } });
    expect((await incr(login, "ip")).current).toBe(1);
    expect((await incr(login, "ip")).current).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
