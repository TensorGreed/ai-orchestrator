/**
 * Phase 13.1 — the cluster-mode MCP OAuth refresh lock is bounded per instance: at most a few refreshes hold or wait
 * for the advisory lock at once, the rest wait in the process without a pooled connection, a slot is given back on
 * every path (done, thrown, timed out), and the wait for a slot and the lock share one budget. On Postgres, a burst of
 * distinct expiring connections on one instance with a small pool leaves a connection for other store calls.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { PostgresStore } from "../db/postgres-store.js";
import { ADVISORY_LOCK_CLASS_MCP_OAUTH_REFRESH } from "../db/postgres/cluster.js";
import { createTestStore, noticePostgresSkipped, testPostgresUrl, type TestStore } from "../test-support/test-store.js";
import { createClusterRefreshLock, MCP_OAUTH_REFRESH_LOCK_CONCURRENCY, type ClusterLockRunner } from "./mcp-oauth-service.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A lock runner that always gets the lock at once and counts how many bodies run together. */
function countingRunner() {
  const seen = { active: 0, peak: 0, waits: [] as number[] };
  const runner: ClusterLockRunner = async (_key, waitMs, fn) => {
    seen.waits.push(waitMs);
    seen.active += 1;
    seen.peak = Math.max(seen.peak, seen.active);
    try {
      return { acquired: true, value: await fn() };
    } finally {
      seen.active -= 1;
    }
  };
  return { seen, runner };
}

describe("createClusterRefreshLock", () => {
  it("runs at most the bound at once and queues the rest", async () => {
    const { seen, runner } = countingRunner();
    const lock = createClusterRefreshLock(runner, { concurrency: 2 });
    const gate = deferred();
    const started: string[] = [];
    const calls = ["a", "b", "c", "d", "e"].map((key) =>
      lock(key, async () => {
        started.push(key);
        await gate.promise;
        return key;
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toEqual(["a", "b"]);
    gate.resolve();
    expect(await Promise.all(calls)).toEqual(["a", "b", "c", "d", "e"]);
    expect(seen.peak).toBe(2);
  });

  it("defaults to a small bound independent of the pool", () => {
    expect(MCP_OAUTH_REFRESH_LOCK_CONCURRENCY).toBe(2);
  });

  it("gives the slot back when the body throws or the lock is not acquired", async () => {
    let acquire = false;
    const runner: ClusterLockRunner = async (_key, _waitMs, fn) => (acquire ? { acquired: true, value: await fn() } : { acquired: false });
    const lock = createClusterRefreshLock(runner, { concurrency: 1 });
    await expect(lock("a", async () => "never")).rejects.toThrow(/Try again shortly/);
    acquire = true;
    await expect(lock("a", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    // Both failures released the single slot.
    expect(await lock("a", async () => "ok")).toBe("ok");
  });

  it("fails a caller that waits for a slot past the budget, and keeps the queue moving", async () => {
    const { seen, runner } = countingRunner();
    const lock = createClusterRefreshLock(runner, { concurrency: 1, waitMs: 50 });
    const gate = deferred();
    const holder = lock("a", async () => {
      await gate.promise;
      return "a";
    });
    await expect(lock("b", async () => "b")).rejects.toThrow(/Try again shortly/);
    gate.resolve();
    expect(await holder).toBe("a");
    expect(await lock("c", async () => "c")).toBe("c");
    // The lock wait is what is left of the budget after the slot wait.
    expect(seen.waits.every((waitMs) => waitMs <= 50)).toBe(true);
  });
});

const run = testPostgresUrl() ? describe : describe.skip;
if (!testPostgresUrl()) noticePostgresSkipped("bounded MCP OAuth refresh lock");

run("bounded MCP OAuth refresh lock on Postgres", () => {
  let primary: TestStore | undefined;

  afterEach(async () => {
    await primary?.cleanup();
    primary = undefined;
  }, 60_000);

  it("many distinct connections refreshing at once on a small pool do not starve other store calls", async () => {
    primary = await createTestStore({ kind: "postgres", maxConnections: 3 });
    const store = primary.store as PostgresStore;
    const lock = createClusterRefreshLock(
      async (key, waitMs, fn) => await store.withClusterLock(ADVISORY_LOCK_CLASS_MCP_OAUTH_REFRESH, `mcp-oauth:${key}`, { waitMs }, fn)
    );
    const refreshing = deferred();
    let inside = 0;
    // Eight delegated connections due together: each refresh re-reads its row, waits on the token endpoint, writes back.
    const refreshes = Array.from({ length: 8 }, (_, i) =>
      lock(`srv_${i}::user_${i}`, async () => {
        await store.getMcpUserOAuthConnection(`srv_${i}`, `user_${i}`);
        inside += 1;
        if (inside === MCP_OAUTH_REFRESH_LOCK_CONCURRENCY) refreshing.resolve();
        await new Promise((resolve) => setTimeout(resolve, 300));
        await store.getMcpUserOAuthConnection(`srv_${i}`, `user_${i}`);
        return i;
      })
    );
    await refreshing.promise;
    // A plain store call while refreshes hold their locks and others queue: it gets a connection at once.
    const startedAt = Date.now();
    expect(await store.countUsers()).toBeGreaterThanOrEqual(0);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(await Promise.all(refreshes)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  }, 30_000);
});
