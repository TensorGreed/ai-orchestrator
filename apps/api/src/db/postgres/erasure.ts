/**
 * 13.3 — PostgresStore: erasure tombstones, token vault deletion and staff pseudonymisation (db/erasure.ts). Each
 * function matches the SqliteStore method of the same name. A staff pseudonymisation updates each column in batches
 * that skip rows another transaction holds locked (`FOR UPDATE SKIP LOCKED`), each batch in its own transaction under
 * the legal-hold lock (shared), so a hold placed meanwhile is seen by the next batch.
 */
import {
  INSERT_TOMBSTONE_SQL,
  RESTORE_SKIPPED_KIND,
  STAFF_AUTHORSHIP_COLUMNS,
  STAFF_BATCH,
  staffWhere,
  type ErasureTombstoneWrite,
  type SubjectErasure
} from "../erasure.js";
import { LEGAL_HOLD_LOCK_SHARED_SQL, toPgPlaceholders } from "../legal-hold-sql.js";
import { yieldToEventLoop } from "../retention-tables.js";
import type { PoolClient } from "pg";
import type { PgContext } from "./context.js";

type Queryable = Pick<PoolClient, "query">;

export async function writeErasureTombstonesWith(client: Queryable, rows: ErasureTombstoneWrite[]): Promise<void> {
  const sql = toPgPlaceholders(INSERT_TOMBSTONE_SQL);
  for (const row of rows) await client.query(sql, [row.kind, row.rowId, row.requestId, row.erasedAt]);
}

export async function writeErasureTombstones(ctx: PgContext, rows: ErasureTombstoneWrite[]): Promise<void> {
  if (rows.length === 0) return;
  await ctx.withTransaction(async (client) => await writeErasureTombstonesWith(client, rows));
}

export async function deleteGuardVaultTokens(ctx: PgContext, tokens: string[], erasure: Pick<SubjectErasure, "requestId" | "erasedAt">): Promise<number> {
  const unique = [...new Set(tokens)];
  if (unique.length === 0) return 0;
  return await ctx.withTransaction(async (client) => {
    const gone = (await client.query<{ token: string }>(`DELETE FROM guard_token_vault WHERE token = ANY($1::text[]) RETURNING token`, [unique])).rows.map((row) => String(row.token));
    await writeErasureTombstonesWith(
      client,
      gone.map((token) => ({ kind: "vault_token" as const, rowId: token, requestId: erasure.requestId, erasedAt: erasure.erasedAt }))
    );
    return gone.length;
  });
}

export async function pruneErasureTombstones(ctx: PgContext, before: string, limit: number): Promise<number> {
  const cap = Math.max(0, Math.floor(limit));
  if (cap === 0) return 0;
  const result = await ctx.pool.query(
    `DELETE FROM erasure_tombstones WHERE ctid IN (SELECT ctid FROM erasure_tombstones WHERE erased_at < $1 AND kind <> $2 LIMIT $3)`,
    [before, RESTORE_SKIPPED_KIND, cap]
  );
  return result.rowCount ?? 0;
}

export async function takeRestoreSkippedMarkers(ctx: PgContext): Promise<Array<{ id: string; at: string }>> {
  const rows = await ctx.query<{ row_id: string; erased_at: unknown }>(`DELETE FROM erasure_tombstones WHERE kind = $1 RETURNING row_id, erased_at`, [RESTORE_SKIPPED_KIND]);
  return rows.map((row) => ({ id: String(row.row_id), at: row.erased_at instanceof Date ? row.erased_at.toISOString() : String(row.erased_at) }));
}

export async function countErasureTombstones(ctx: PgContext): Promise<number> {
  const row = await ctx.queryOne<{ n: string | number }>(`SELECT COUNT(*) AS n FROM erasure_tombstones WHERE kind <> $1`, [RESTORE_SKIPPED_KIND]);
  return Number(row?.n ?? 0);
}

export async function pseudonymiseStaff(
  ctx: PgContext,
  input: { emails: string[]; pseudonym: string; batch?: number }
): Promise<{ changed: number; held: number; remaining: number }> {
  const emails = [...new Set(input.emails.map((email) => email.trim().toLowerCase()))].filter(Boolean);
  if (emails.length === 0) return { changed: 0, held: 0, remaining: 0 };
  const batch = Math.max(1, Math.floor(input.batch ?? STAFF_BATCH));
  let changed = 0;
  let held = 0;
  let remaining = 0;
  for (const column of STAFF_AUTHORSHIP_COLUMNS) {
    const unheld = staffWhere(column, emails.length, "unheld");
    const update = toPgPlaceholders(
      `UPDATE ${column.table} SET ${column.column} = ? WHERE ctid IN (SELECT t.ctid FROM ${column.table} t WHERE ${unheld} LIMIT ? FOR UPDATE SKIP LOCKED)`
    );
    for (;;) {
      const step = await ctx.withTransaction(async (client) => {
        await client.query(LEGAL_HOLD_LOCK_SHARED_SQL);
        return (await client.query(update, [input.pseudonym, ...emails, batch])).rowCount ?? 0;
      });
      changed += step;
      if (step < batch) break;
      await yieldToEventLoop();
    }
    const left = await ctx.queryOne<{ n: string | number }>(toPgPlaceholders(`SELECT COUNT(*) AS n FROM ${column.table} t WHERE ${unheld}`), emails);
    remaining += Number(left?.n ?? 0);
    // A column no hold can keep has no held rows (and its "held" predicate takes no parameter).
    if (!column.held) continue;
    const kept = await ctx.queryOne<{ n: string | number }>(toPgPlaceholders(`SELECT COUNT(*) AS n FROM ${column.table} t WHERE ${staffWhere(column, emails.length, "held")}`), emails);
    held += Number(kept?.n ?? 0);
  }
  return { changed, held, remaining };
}
