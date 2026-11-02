/**
 * 12.6 (D6) — per-client rate limits on the MCP gateway.
 *
 * A client's own limit (or its toolset's default, see `effectiveGatewayRateLimit`) caps its `tools/call` requests:
 * `requestsPerMinute` with a `burst`, and `maxConcurrent` calls in flight. Each call counts, also each call of a
 * batch. A call over the rate or the concurrency is refused at once (the gateway answers JSON-RPC `retryLater`); it
 * never waits.
 *
 * Where the counts live:
 *   - single instance: in this process (a token bucket per client key: `burst` calls at once, refilled at
 *     `requestsPerMinute`);
 *   - cluster mode (Postgres with HA_ENABLED): the rate is counted in the database, in the buckets the auth and
 *     webhook rate limits share (`Store.hitRateLimitBucket`), so it holds across replicas. A bucket is a fixed window
 *     of `60 s × burst / requestsPerMinute` holding `burst` calls, which gives the same sustained rate. When the
 *     database cannot be reached the call is counted in this instance's memory instead (logged).
 *   - concurrency is always per instance: a call runs on the instance that holds its session.
 *
 * Nothing is counted for a client with no limit.
 */
import type { McpGatewayRateLimit } from "@ai-orchestrator/shared";
import type { Store } from "../db/store.js";

export type GatewayLimitRefusal = {
  ok: false;
  reason: "rate_limited" | "concurrency_limited";
  retryAfterMs: number;
  message: string;
};

export type GatewayLimitDecision = { ok: true; release: () => void } | GatewayLimitRefusal;

export interface GatewayClientLimiterOptions {
  /** Cluster mode: count the rate in the shared database buckets. Absent: in this process only. */
  shared?: Pick<Store, "hitRateLimitBucket"> | null;
  now?: () => number;
  logger?: { warn: (message: string, fields?: Record<string, unknown>) => void };
  /** Shortest gap between two "database unreachable" warnings. Default 60 s. */
  warnEveryMs?: number;
}

interface LocalBucket {
  tokens: number;
  last: number;
  ratePerMinute: number;
  capacity: number;
}

/** A concurrency slot is refused with this retry hint (a slot frees when a call in flight ends). */
const CONCURRENCY_RETRY_MS = 1_000;
/** Keys kept in memory before idle ones are dropped. */
const MAX_LOCAL_KEYS = 10_000;

function seconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

/** The fixed window a shared bucket counts in, so `capacity` calls per window is `ratePerMinute` sustained. */
export function sharedWindowMs(ratePerMinute: number, capacity: number): number {
  return Math.max(1, Math.ceil((60_000 * capacity) / ratePerMinute));
}

export class GatewayClientLimiter {
  private readonly buckets = new Map<string, LocalBucket>();
  private readonly inFlight = new Map<string, number>();
  private readonly now: () => number;
  private lastWarnAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: GatewayClientLimiterOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Calls in flight for a key on this instance (tests, the Governance view). */
  inFlightFor(key: string): number {
    return this.inFlight.get(key) ?? 0;
  }

  /**
   * Admits one call under `limit`, counted under `key`. On success the caller must call `release()` once the call
   * ends (it frees the concurrency slot).
   */
  async acquire(key: string, limit: McpGatewayRateLimit): Promise<GatewayLimitDecision> {
    // The slot is taken before the (possibly asynchronous) rate check, so two calls of one batch cannot both pass a
    // full concurrency cap; it is given back when the rate refuses the call.
    if (limit.maxConcurrent !== null) {
      const current = this.inFlight.get(key) ?? 0;
      if (current >= limit.maxConcurrent) {
        return {
          ok: false,
          reason: "concurrency_limited",
          retryAfterMs: CONCURRENCY_RETRY_MS,
          message: `Concurrency limit: this client already has ${current} calls in flight (at most ${limit.maxConcurrent}). Try again when one ends.`
        };
      }
    }
    this.inFlight.set(key, (this.inFlight.get(key) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const left = (this.inFlight.get(key) ?? 1) - 1;
      if (left <= 0) this.inFlight.delete(key);
      else this.inFlight.set(key, left);
    };
    if (limit.requestsPerMinute !== null) {
      let refusal: GatewayLimitRefusal | null;
      try {
        refusal = await this.takeRate(key, limit.requestsPerMinute, limit.burst ?? limit.requestsPerMinute);
      } catch (error) {
        release();
        throw error;
      }
      if (refusal) {
        release();
        return refusal;
      }
    }
    return { ok: true, release };
  }

  private rateRefusal(ratePerMinute: number, retryAfterMs: number): GatewayLimitRefusal {
    return {
      ok: false,
      reason: "rate_limited",
      retryAfterMs,
      message: `Rate limited: this client may make ${ratePerMinute} calls per minute. Try again in ${seconds(retryAfterMs)} s.`
    };
  }

  private async takeRate(key: string, ratePerMinute: number, capacity: number): Promise<GatewayLimitRefusal | null> {
    const shared = this.options.shared;
    if (shared) {
      const windowMs = sharedWindowMs(ratePerMinute, capacity);
      try {
        // The limit is part of the bucket name: a changed limit starts counting afresh.
        const hit = await shared.hitRateLimitBucket({ key: `rl:mcp-gateway:${key}:${ratePerMinute}:${capacity}`, windowMs });
        return hit.count > capacity ? this.rateRefusal(ratePerMinute, Math.max(1, hit.ttlMs)) : null;
      } catch (error) {
        const now = this.now();
        if (now - this.lastWarnAt >= (this.options.warnEveryMs ?? 60_000)) {
          this.lastWarnAt = now;
          this.options.logger?.warn("Shared gateway rate-limit bucket unavailable; counting on this instance only until the database answers", {
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }
    return this.takeLocal(key, ratePerMinute, capacity);
  }

  private takeLocal(key: string, ratePerMinute: number, capacity: number): GatewayLimitRefusal | null {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.ratePerMinute !== ratePerMinute || bucket.capacity !== capacity) {
      // A new or changed limit starts full (a changed one keeps no more than it had).
      const tokens = bucket ? Math.min(capacity, bucket.tokens) : capacity;
      bucket = { tokens, last: now, ratePerMinute, capacity };
      if (this.buckets.size >= MAX_LOCAL_KEYS) this.pruneIdle(now);
      this.buckets.set(key, bucket);
    }
    const elapsed = Math.max(0, now - bucket.last);
    bucket.last = now;
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + (elapsed * bucket.ratePerMinute) / 60_000);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return null;
    }
    return this.rateRefusal(ratePerMinute, Math.ceil(((1 - bucket.tokens) * 60_000) / bucket.ratePerMinute));
  }

  /** Drops the buckets that refilled completely (nothing to remember for them). */
  private pruneIdle(now: number): void {
    for (const [key, bucket] of this.buckets) {
      const tokens = bucket.tokens + ((now - bucket.last) * bucket.ratePerMinute) / 60_000;
      if (tokens >= bucket.capacity && !this.inFlight.has(key)) this.buckets.delete(key);
    }
  }
}
