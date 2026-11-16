/**
 * 13.2 — SqliteStore's SCIM tables (v75): the shared SQL of scim-store.ts over better-sqlite3. The tables are created
 * in SqliteStore.migrate (ensureScimSchema); setUserDisabled lives in database.ts with the other users writes.
 */
import type { Database as BetterSqlite3Database } from "better-sqlite3";
import { createScimSqlStore, SQLITE_SCIM_SCHEMA, type ScimSqlExecutor, type ScimStore } from "./scim-store.js";

export function ensureScimSchema(db: BetterSqlite3Database): void {
  db.exec(SQLITE_SCIM_SCHEMA);
}

const bind = (params: unknown[] | undefined): unknown[] => (params ?? []).map((value) => (value === undefined ? null : value));

export function sqliteScimExecutor(db: BetterSqlite3Database): ScimSqlExecutor {
  return {
    all: async (sql, params) => db.prepare(sql).all(...bind(params)) as Array<Record<string, unknown>>,
    run: async (sql, params) => db.prepare(sql).run(...bind(params)).changes,
    batch: async (statements) =>
      db
        .transaction(() => {
          const counts: number[] = [];
          for (const statement of statements) {
            const changes = db.prepare(statement.sql).run(...bind(statement.params)).changes;
            counts.push(changes);
            if (statement.stopUnlessChanged && changes === 0) break;
          }
          return counts;
        })
        .immediate()
  };
}

export function sqliteScimStore(db: BetterSqlite3Database): Omit<ScimStore, "setUserDisabled"> {
  return createScimSqlStore(sqliteScimExecutor(db));
}
