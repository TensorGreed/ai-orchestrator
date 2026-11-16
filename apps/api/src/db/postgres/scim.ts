/**
 * 13.2 — PostgresStore: the SCIM tables (v75), through the shared SQL of scim-store.ts (`?` placeholders numbered
 * here). setUserDisabled lives in postgres/auth.ts with the other users writes.
 */
import { createScimSqlStore, type ScimSqlExecutor, type ScimStore } from "../scim-store.js";
import { toPgPlaceholders } from "../legal-hold-sql.js";
import type { PgContext } from "./context.js";

const bind = (params: unknown[] | undefined): unknown[] => (params ?? []).map((value) => (value === undefined ? null : value));

export function pgScimExecutor(ctx: PgContext): ScimSqlExecutor {
  return {
    all: async (sql, params) => await ctx.query<Record<string, unknown>>(toPgPlaceholders(sql), bind(params)),
    run: async (sql, params) => (await ctx.pool.query(toPgPlaceholders(sql), bind(params))).rowCount ?? 0,
    batch: async (statements) =>
      await ctx.withTransaction(async (client) => {
        const counts: number[] = [];
        for (const statement of statements) {
          const changes = (await client.query(toPgPlaceholders(statement.sql), bind(statement.params))).rowCount ?? 0;
          counts.push(changes);
          if (statement.stopUnlessChanged && changes === 0) break;
        }
        return counts;
      })
  };
}

export function pgScimStore(ctx: PgContext): Omit<ScimStore, "setUserDisabled"> {
  return createScimSqlStore(pgScimExecutor(ctx));
}
