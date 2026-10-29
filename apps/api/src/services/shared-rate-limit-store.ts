/**
 * Phase 13.1 — a store for `@fastify/rate-limit` that keeps the auth and webhook buckets in the database, so their
 * limits hold across every instance (cluster mode: Postgres with HA_ENABLED=true). Each hit is one atomic upsert
 * (`Store.hitRateLimitBucket`, an UNLOGGED table on Postgres); these routes are low volume, so the round trip is cheap.
 *
 * Everything else stays in memory per instance, exactly as the plugin's own LocalStore keeps it: the global limiter
 * (every request) is per replica by design, documented on the cluster operations page. A route opts in by carrying
 * `[SHARED_RATE_LIMIT_BUCKET]: "auth" | "webhook"` in its `config.rateLimit`.
 *
 * Buckets are fixed windows per route and client key, as LocalStore's are. If the database cannot be reached, the hit
 * is counted in this instance's memory instead (the limit then holds per replica until it is back), so a database
 * hiccup never turns sign-in into an error.
 */
import { createRequire } from "node:module";
import type { Store } from "../db/store.js";

const require = createRequire(import.meta.url);

/** What the plugin calls on a store (its callback receives the count in the window and the milliseconds left). */
export interface RateLimitStoreLike {
  incr(key: string, callback: (error: Error | null, result?: { current: number; ttl: number }) => void, timeWindow?: number, max?: number): void;
  child(routeOptions: Record<string, unknown>): RateLimitStoreLike;
}

type LocalStoreCtor = new (continueExceeding: boolean, exponentialBackoff: boolean, cache?: number) => RateLimitStoreLike;
const LocalStore = require("@fastify/rate-limit/store/LocalStore") as LocalStoreCtor;

/** Route `config.rateLimit` key naming the shared bucket a route counts in. */
export const SHARED_RATE_LIMIT_BUCKET = "l2mSharedBucket";
export type SharedRateLimitBucket = "auth" | "webhook";

export interface SharedRateLimitStoreOptions {
  store: Pick<Store, "hitRateLimitBucket">;
  logger?: { warn: (message: string, fields?: Record<string, unknown>) => void };
  /** Shortest gap between two "database unreachable" warnings. Default 60 s. */
  warnEveryMs?: number;
}

function routeLabel(routeInfo: unknown): string {
  const info = (routeInfo ?? {}) as { method?: unknown; url?: unknown };
  const method = Array.isArray(info.method) ? info.method.map(String).join(",") : String(info.method ?? "");
  return `${method} ${String(info.url ?? "")}`;
}

/** One shared bucket per route: hits go to the database; on a database error, to this instance's memory. */
class DatabaseBucketStore implements RateLimitStoreLike {
  private lastWarnAt = 0;

  constructor(
    private readonly options: SharedRateLimitStoreOptions,
    private readonly prefix: string,
    private readonly fallback: RateLimitStoreLike
  ) {}

  incr(key: string, callback: (error: Error | null, result?: { current: number; ttl: number }) => void, timeWindow?: number, max?: number): void {
    const windowMs = typeof timeWindow === "number" && Number.isFinite(timeWindow) ? timeWindow : 60_000;
    this.options.store.hitRateLimitBucket({ key: `${this.prefix}${key}`, windowMs }).then(
      (hit) => callback(null, { current: hit.count, ttl: hit.ttlMs }),
      (error: unknown) => {
        const now = Date.now();
        if (now - this.lastWarnAt >= (this.options.warnEveryMs ?? 60_000)) {
          this.lastWarnAt = now;
          this.options.logger?.warn("Shared rate-limit bucket unavailable; counting on this instance only until the database answers", {
            bucket: this.prefix,
            error: error instanceof Error ? error.message : String(error)
          });
        }
        this.fallback.incr(key, callback, timeWindow, max);
      }
    );
  }

  child(): RateLimitStoreLike {
    return this;
  }
}

/**
 * The store class to pass as `store` to `@fastify/rate-limit` (the plugin constructs it with its global settings and
 * asks it for a child per route with a limit of its own).
 */
export function createSharedRateLimitStore(options: SharedRateLimitStoreOptions): new (params: Record<string, unknown>) => RateLimitStoreLike {
  return class SharedRateLimitStore implements RateLimitStoreLike {
    private readonly local: RateLimitStoreLike;

    constructor(params: Record<string, unknown>) {
      this.local = new LocalStore(params.continueExceeding === true, params.exponentialBackoff === true);
    }

    incr(key: string, callback: (error: Error | null, result?: { current: number; ttl: number }) => void, timeWindow?: number, max?: number): void {
      this.local.incr(key, callback, timeWindow, max);
    }

    child(routeOptions: Record<string, unknown>): RateLimitStoreLike {
      const local = this.local.child(routeOptions);
      const bucket = routeOptions[SHARED_RATE_LIMIT_BUCKET];
      if (bucket !== "auth" && bucket !== "webhook") return local;
      return new DatabaseBucketStore(options, `rl:${bucket}:${routeLabel(routeOptions.routeInfo)}:`, local);
    }
  };
}
