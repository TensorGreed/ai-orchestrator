/**
 * Phase 13.1 — raw SQL beside a test store, on either store. Tests that set up a state no route can reach (an
 * expired approval, a row from an older release, a corrupted snapshot) write it with this instead of opening the
 * SQLite file, so they run on Postgres too.
 *
 *   const sql = testSql(store);
 *   await sql.run("UPDATE approval_requests SET expires_at = ? WHERE id = ?", past, id);
 *   const row = await sql.get<{ status: string }>("SELECT status FROM approval_requests WHERE id = ?", id);
 *
 * Placeholders are `?` on both stores (rewritten to `$1…` for Postgres, outside quotes). Rows come back as each driver
 * returns them: Postgres BIGINT/COUNT as strings, TIMESTAMPTZ as ISO strings, JSONB as parsed values, booleans as
 * booleans (SQLite: 0/1). Compare through the helpers a test needs, or write the SQL to return the same shape
 * (`COUNT(*) AS n` → `Number(row.n)`).
 */
import type { Database as BetterSqlite3Database } from "better-sqlite3";
import type { Pool } from "pg";
import { SqliteStore } from "../db/database.js";
import { PostgresStore } from "../db/postgres-store.js";
import type { Store } from "../db/store.js";

export interface TestSql {
  readonly kind: "sqlite" | "postgres";
  /** Runs a statement; resolves with the number of rows it changed. */
  run(sql: string, ...params: unknown[]): Promise<number>;
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
}

/** `?` → `$1`, `$2`… outside single-quoted strings, double-quoted identifiers and comments. */
export function toPostgresPlaceholders(sql: string): string {
  let out = "";
  let index = 0;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i]!;
    if (char === "'" || char === '"') {
      const end = sql.indexOf(char, i + 1);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(i, stop + 1);
      i = stop;
    } else if (char === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(i, stop);
      i = stop - 1;
    } else if (char === "?") {
      index += 1;
      out += `$${index}`;
    } else {
      out += char;
    }
  }
  return out;
}

function sqliteValue(value: unknown): unknown {
  if (typeof value === "boolean") return value ? 1 : 0;
  return value === undefined ? null : value;
}

export function testSql(store: Store): TestSql {
  if ((store as object) instanceof SqliteStore) {
    const db = (store as unknown as { db: BetterSqlite3Database }).db;
    return {
      kind: "sqlite",
      async run(sql, ...params) {
        return db.prepare(sql).run(...params.map(sqliteValue)).changes;
      },
      async get<T>(sql: string, ...params: unknown[]) {
        return db.prepare(sql).get(...params.map(sqliteValue)) as T | undefined;
      },
      async all<T>(sql: string, ...params: unknown[]) {
        return db.prepare(sql).all(...params.map(sqliteValue)) as T[];
      }
    };
  }
  if ((store as object) instanceof PostgresStore) {
    const pool = (store as unknown as { pool: Pool }).pool;
    const values = (params: unknown[]) => params.map((value) => (value === undefined ? null : value));
    return {
      kind: "postgres",
      async run(sql, ...params) {
        return (await pool.query(toPostgresPlaceholders(sql), values(params))).rowCount ?? 0;
      },
      async get<T>(sql: string, ...params: unknown[]) {
        return (await pool.query(toPostgresPlaceholders(sql), values(params))).rows[0] as T | undefined;
      },
      async all<T>(sql: string, ...params: unknown[]) {
        return (await pool.query(toPostgresPlaceholders(sql), values(params))).rows as T[];
      }
    };
  }
  throw new Error("testSql needs a SqliteStore or a PostgresStore.");
}
