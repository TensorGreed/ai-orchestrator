/**
 * Postgres lock-order tests: pause one store's transaction at a chosen query, watch who waits on it, and bound every
 * lock wait. Used by the *-lock-order tests in db/.
 */
import type { Pool, PoolClient } from "pg";
import type { PostgresStore } from "../db/postgres-store.js";

type QueryFn = (...args: unknown[]) => Promise<unknown>;

/** Every pause's resume, so a failed test never leaves a transaction open behind it. */
const resumers: Array<() => void> = [];

/** Resumes every paused transaction (call it first in afterEach). */
export function resumeAllPaused(): void {
  while (resumers.length > 0) resumers.pop()!();
}

/**
 * Pauses the store's next transaction right after the first query whose text matches `after`; `reached` resolves
 * with the paused backend's pid. Only clients handed to transactions are paused, never `pool.query` statements.
 */
export function pauseAfter(store: PostgresStore, after: RegExp): { reached: Promise<number>; resume: () => void } {
  let reach!: (pid: number) => void;
  let resume!: () => void;
  const reached = new Promise<number>((resolve) => (reach = resolve));
  const resumed = new Promise<void>((resolve) => (resume = resolve));
  resumers.push(resume);
  let armed = true;
  const wrapped = new WeakSet<PoolClient>();
  const pool = (store as unknown as { pool: Pool }).pool;
  const connect = pool.connect.bind(pool) as (callback?: unknown) => Promise<PoolClient>;
  // pool.query checks a client out with a callback; only the clients handed to transactions (no callback) are wrapped.
  (pool as unknown as { connect: (callback?: unknown) => unknown }).connect = (callback?: unknown) => {
    if (callback !== undefined) return connect(callback);
    return connect().then(wrap);
  };
  const wrap = (client: PoolClient): PoolClient => {
    if (wrapped.has(client)) return client;
    wrapped.add(client);
    const query = client.query.bind(client) as unknown as QueryFn;
    (client as unknown as { query: QueryFn }).query = async (...args: unknown[]) => {
      const result = await query(...args);
      const text = typeof args[0] === "string" ? args[0] : String((args[0] as { text?: unknown })?.text ?? "");
      if (armed && after.test(text)) {
        armed = false;
        reach((client as unknown as { processID: number }).processID);
        await resumed;
      }
      return result;
    };
    return client;
  };
  return { reached, resume };
}

/**
 * Every transaction of this store's pool gets a lock timeout, so a lock order regression that leaves a statement
 * waiting for good fails the test within seconds (a lock timeout error) instead of at the test's own timeout.
 * Statements run with `pool.query` (outside a transaction) get no lock timeout: a regressed one waits until the paused
 * transaction resumes and then fails as a deadlock, which is still a clear failure.
 */
export function limitLockWaits(store: PostgresStore, timeout = "5s"): void {
  const pool = (store as unknown as { pool: Pool }).pool;
  const connect = pool.connect.bind(pool) as (callback?: unknown) => Promise<PoolClient>;
  (pool as unknown as { connect: (callback?: unknown) => unknown }).connect = (callback?: unknown) => {
    if (callback !== undefined) return connect(callback);
    return connect().then(async (client) => {
      await client.query(`SET lock_timeout = '${timeout}'`);
      return client;
    });
  };
}

export const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether `promise` is still pending after `ms`. */
export async function stillPending(promise: Promise<unknown>, ms = 300): Promise<boolean> {
  const marker = Symbol("pending");
  const outcome = await Promise.race([promise.then(() => null, () => null), delay(ms).then(() => marker)]);
  return outcome === marker;
}

/** Waits until a backend of this database is blocked by the backend `blockerPid` (a paused transaction). */
export async function waitsOnBackend(watcher: Pool, blockerPid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await watcher.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND $1::int = ANY(pg_blocking_pids(pid))`,
      [blockerPid]
    );
    if ((result.rows[0]?.n ?? 0) > 0) return true;
    await delay(20);
  }
  return false;
}
