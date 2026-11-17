/**
 * v76 — PostgresStore: content redaction maps, through the shared SQL of content-redaction-store.ts (`?` placeholders
 * numbered here).
 */
import { createContentRedactionSqlStore, type ContentRedactionStore } from "../content-redaction-store.js";
import { toPgPlaceholders } from "../legal-hold-sql.js";
import type { PgContext } from "./context.js";

const bind = (params: unknown[] | undefined): unknown[] => (params ?? []).map((value) => (value === undefined ? null : value));

export function pgContentRedactionStore(ctx: PgContext): ContentRedactionStore {
  return createContentRedactionSqlStore({
    all: async (sql, params) => await ctx.query<Record<string, unknown>>(toPgPlaceholders(sql), bind(params)),
    run: async (sql, params) => (await ctx.pool.query(toPgPlaceholders(sql), bind(params))).rowCount ?? 0
  });
}
