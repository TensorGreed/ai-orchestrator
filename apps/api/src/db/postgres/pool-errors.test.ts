/**
 * Phase 13.1 (review round 2, P-1) — a pooled Postgres connection the server ends while it sits idle (a Postgres
 * restart or failover, an admin's pg_terminate_backend, a role's idle_session_timeout, a pooler recycling server
 * connections) makes pg's Pool emit 'error'. Without a listener that is an unhandled 'error' event and the process
 * exits. The store's pool, a checked-out client, and the leader lock's own connection must all survive it, and the
 * next query must work. Postgres only (skipped without TEST_POSTGRES_URL).
 */
import { afterEach, describe, expect, it } from "vitest";
import { createTestStore, noticePostgresSkipped, testPostgresUrl, testStorePool, type TestStore } from "../../test-support/test-store.js";
import type { PostgresStore } from "../postgres-store.js";
import { attachPoolErrorHandler } from "./pool.js";

const run = testPostgresUrl() ? describe : describe.skip;
if (!testPostgresUrl()) noticePostgresSkipped("Postgres pool error handling");

describe("attachPoolErrorHandler", () => {
  it("logs the first error, then at most one line per interval with the count it held back; never the password", () => {
    const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    const pool = { on: (event: string, fn: (...args: unknown[]) => void) => void (listeners[event] ??= []).push(fn) };
    const lines: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    let now = 1_000_000;
    attachPoolErrorHandler(pool as never, {
      label: "store",
      logIntervalMs: 60_000,
      now: () => now,
      logger: { warn: (message, fields) => void lines.push({ message, ...(fields ? { fields } : {}) }) }
    });
    const fail = (message: string) => {
      const error = Object.assign(new Error(message), { code: "57P01" });
      for (const fn of listeners.error ?? []) fn(error);
    };
    fail("terminating connection due to administrator command");
    fail("again");
    now += 30_000;
    fail("again");
    now += 31_000;
    fail("connect to postgres://l2m:hunter2@db:5432/x failed");
    expect(lines).toHaveLength(2);
    expect(lines[0]!.fields).toMatchObject({ pool: "store", code: "57P01", heldBack: 0 });
    expect(lines[1]!.fields).toMatchObject({ heldBack: 2 });
    expect(JSON.stringify(lines)).not.toContain("hunter2");
    // A checked-out client gets a listener too, so an error between its queries is not unhandled either.
    const clientListeners: string[] = [];
    for (const fn of listeners.connect ?? []) fn({ on: (event: string) => void clientListeners.push(event) });
    expect(clientListeners).toEqual(["error"]);
  });
});

run("Postgres connections the server ends", () => {
  let test: TestStore | undefined;
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!().catch(() => undefined);
    await test?.cleanup();
    test = undefined;
  }, 30_000);

  async function terminate(admin: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<{ n: number }> }> }, where: string, params: unknown[]) {
    const result = await admin.query(
      `SELECT count(pg_terminate_backend(pid))::int AS n FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND ${where}`,
      params
    );
    return result.rows[0]!.n;
  }

  it("idle pooled connections of the store ended by the server: the process stays up, the next query works", async () => {
    test = await createTestStore({ kind: "postgres", maxConnections: 4 });
    const store = test.store as PostgresStore;
    const admin = testStorePool(test, { max: 1 });
    cleanups.push(async () => await admin.end());
    // Open a few pooled connections, then let them go idle.
    await Promise.all(Array.from({ length: 4 }, () => store.listWorkflows()));
    await admin.query("SELECT 1");
    const adminPid = (await admin.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    const killed = await terminate(admin as never, "datname = $1 AND pid <> $2 AND application_name <> 'l2m-leader'", [test.postgres!.database, adminPid]);
    expect(killed).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await store.listWorkflows()).toEqual([]);
  }, 30_000);

  it("a checked-out client whose session is ended between its queries: its next query fails, nothing crashes, the pool recovers", async () => {
    test = await createTestStore({ kind: "postgres", maxConnections: 2 });
    const store = test.store as PostgresStore;
    const admin = testStorePool(test, { max: 1 });
    cleanups.push(async () => await admin.end());
    const ctx = (store as unknown as { ctx: { withClient: <T>(fn: (client: { query: (sql: string) => Promise<{ rows: Array<{ pid: number }> }> }) => Promise<T>) => Promise<T> } }).ctx;
    const outcome = await ctx
      .withClient(async (client) => {
        const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
        await admin.query("SELECT pg_terminate_backend($1)", [pid]);
        await new Promise((resolve) => setTimeout(resolve, 500));
        await client.query("SELECT 1");
        return "answered";
      })
      .catch((error: unknown) => `failed: ${error instanceof Error ? error.message : String(error)}`);
    expect(outcome).toMatch(/^failed: /);
    expect(await store.listWorkflows()).toEqual([]);
  }, 30_000);

  it("the leader lock's connection ended by the server: the process stays up, the lock comes back", async () => {
    test = await createTestStore({ kind: "postgres" });
    const store = test.store as PostgresStore;
    const admin = testStorePool(test, { max: 1 });
    cleanups.push(async () => await admin.end());
    const lock = store.leaderLock({ leaseName: "primary", holderId: "A", ttlMs: 30_000, renewIntervalMs: 1_000 });
    let lost = 0;
    lock.onLost(() => void (lost += 1));
    expect(await lock.check()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await terminate(admin as never, "datname = $1 AND application_name = 'l2m-leader'", [test.postgres!.database])).toBe(1);
    const deadline = Date.now() + 10_000;
    while (!(lost > 0 && (await lock.check()))) {
      if (Date.now() > deadline) throw new Error("the lock never came back");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(await store.listWorkflows()).toEqual([]);
  }, 30_000);
});
