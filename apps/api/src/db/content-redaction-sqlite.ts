/**
 * v76 — SqliteStore's content redaction maps: the shared SQL of content-redaction-store.ts over better-sqlite3. The
 * table is created in SqliteStore.migrate (ensureContentRedactionSchema).
 */
import type { Database as BetterSqlite3Database } from "better-sqlite3";
import { createContentRedactionSqlStore, SQLITE_CONTENT_REDACTION_SCHEMA, type ContentRedactionStore } from "./content-redaction-store.js";

export function ensureContentRedactionSchema(db: BetterSqlite3Database): void {
  db.exec(SQLITE_CONTENT_REDACTION_SCHEMA);
}

const bind = (params: unknown[] | undefined): unknown[] => (params ?? []).map((value) => (value === undefined ? null : value));

export function sqliteContentRedactionStore(db: BetterSqlite3Database): ContentRedactionStore {
  return createContentRedactionSqlStore({
    all: async (sql, params) => db.prepare(sql).all(...bind(params)) as Array<Record<string, unknown>>,
    run: async (sql, params) => db.prepare(sql).run(...bind(params)).changes
  });
}
