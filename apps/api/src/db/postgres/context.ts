import type { Pool, PoolClient } from "pg";
import type { Store } from "../store.js";

/**
 * Phase 13.1 — what every postgres/<domain>.ts function receives, built once by PostgresStore. `store` is the
 * PostgresStore itself, for the few methods that call a method of another domain.
 *
 * NUL characters: Postgres TEXT cannot hold U+0000 (22021), where SQLite stores it. Every query made through this
 * context (`query`, `queryOne`, `execute`, `pool.query`, and the clients `withClient` / `withTransaction` /
 * `pool.connect` hand out) writes each string parameter with U+0000 replaced by U+FFFD (pgText), so a NUL from tool
 * output or a user's text is stored instead of failing the write, and a lookup by a NUL-bearing key finds nothing
 * instead of failing. The audit chain normalises its text itself before hashing (audit-chain.ts wellFormedAuditText:
 * U+0000 and lone surrogates → U+FFFD, the same U+0000 rule as pgText), so the mapping is a no-op for audit_logs and
 * the hash covers the stored value.
 */
export interface PgContext {
  pool: Pool;
  store: Store;
  query<T extends object>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T extends object>(sql: string, params?: unknown[]): Promise<T | null>;
  execute(sql: string, params?: unknown[]): Promise<void>;
  /** Runs `fn` on one pooled connection and releases it afterwards, also when `fn` throws. */
  withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
  /** Runs `fn` on one connection inside BEGIN/COMMIT; a throw rolls back and rethrows. */
  withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
}

/** A string as the Postgres store writes it: U+0000 becomes U+FFFD (TEXT cannot hold NUL). Anything else as is. */
export function pgText<T>(value: T): T {
  return (typeof value === "string" && value.includes("\u0000") ? value.replaceAll("\u0000", "�") : value) as T;
}

/** pgText over one parameter: strings, and strings inside arrays (`= ANY($n::text[])`). Buffers and objects as is. */
function pgParam(value: unknown): unknown {
  if (typeof value === "string") return pgText(value);
  if (Array.isArray(value)) return value.some((item) => typeof item === "string" || Array.isArray(item)) ? value.map(pgParam) : value;
  return value;
}

export function pgParams(params: unknown[] | undefined): unknown[] | undefined {
  return params === undefined ? undefined : params.map(pgParam);
}

type QueryFn = (...args: unknown[]) => unknown;

/** pg's query(text, values?, cb?) and query({ text, values }, cb?), with the values mapped through pgParam. */
function mappedQuery(target: { query: QueryFn }): QueryFn {
  return (...args: unknown[]) => {
    const [first, second, ...rest] = args;
    if (Array.isArray(second)) return target.query(first, pgParams(second), ...rest);
    // A plain config object (not a submittable such as a cursor, which must keep its identity).
    if (first !== null && typeof first === "object" && typeof (first as { submit?: unknown }).submit !== "function" && Array.isArray((first as { values?: unknown }).values)) {
      const config = first as { values: unknown[] };
      return target.query({ ...config, values: pgParams(config.values) }, ...args.slice(1));
    }
    return target.query(...args);
  };
}

/** The client with `query` mapped; every other member (release, on, …) is the client's own. */
function mappedClient(client: PoolClient): PoolClient {
  const query = mappedQuery(client as unknown as { query: QueryFn });
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === "query") return query;
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

/** The pool with `query` and `connect` mapped; every other member (end, totalCount, …) is the pool's own. */
function mappedPool(pool: Pool): Pool {
  const query = mappedQuery(pool as unknown as { query: QueryFn });
  const connect = async (callback?: unknown): Promise<PoolClient> => {
    if (callback !== undefined) throw new Error("PgContext.pool.connect does not take a callback; await it instead.");
    return mappedClient(await pool.connect());
  };
  return new Proxy(pool, {
    get(target, property) {
      if (property === "query") return query;
      if (property === "connect") return connect;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

export function createPgContext(rawPool: Pool, store: Store): PgContext {
  const pool = mappedPool(rawPool);
  const query = async <T extends object>(sql: string, params?: unknown[]): Promise<T[]> => {
    const result = await pool.query(sql, params);
    return result.rows as T[];
  };
  const withClient = async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  };
  return {
    pool,
    store,
    query,
    queryOne: async <T extends object>(sql: string, params?: unknown[]): Promise<T | null> => {
      const rows = await query<T>(sql, params);
      return rows[0] ?? null;
    },
    execute: async (sql, params) => {
      await pool.query(sql, params);
    },
    withClient,
    withTransaction: (fn) =>
      withClient(async (client) => {
        await client.query("BEGIN");
        try {
          const result = await fn(client);
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        }
      })
  };
}
