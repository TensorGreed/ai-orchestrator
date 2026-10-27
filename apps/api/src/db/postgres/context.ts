import type { Pool, PoolClient } from "pg";
import type { Store } from "../store.js";

/**
 * Phase 13.1 — what every postgres/<domain>.ts function receives, built once by PostgresStore. `store` is the
 * PostgresStore itself, for the few methods that call a method of another domain.
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

export function createPgContext(pool: Pool, store: Store): PgContext {
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
