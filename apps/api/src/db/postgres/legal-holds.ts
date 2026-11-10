/**
 * 13.3 — legal holds on Postgres: placing (under the legal-hold advisory lock, exclusive), releasing, listing, and the
 * holds that keep a delete's target. The predicate every purge carries is in ../legal-hold-sql.ts.
 */
import type { PoolClient } from "pg";
import type { LegalHoldItemView, LegalHoldRef, LegalHoldStatus, LegalHoldView } from "@ai-orchestrator/shared";
import type { PgContext } from "./context.js";
import {
  LEGAL_HOLD_COLUMNS,
  LEGAL_HOLD_LOCK_EXCLUSIVE_SQL,
  LEGAL_HOLD_LOCK_SHARED_SQL,
  LegalHoldError,
  holdRefs,
  legalHoldFromRow,
  legalHoldItemFromRow,
  legalHoldsOnSql,
  toPgPlaceholders,
  type LegalHoldInsert,
  type LegalHoldRow,
  type LegalHoldTarget
} from "../legal-hold-sql.js";

type Queryable = Pick<PoolClient, "query">;

/** Items written per INSERT. */
const ITEM_CHUNK = 500;

async function getHold(db: Queryable, id: string): Promise<LegalHoldView | null> {
  const row = (await db.query<LegalHoldRow>(`SELECT ${LEGAL_HOLD_COLUMNS} FROM legal_holds h WHERE h.id = $1`, [id])).rows[0];
  return row ? legalHoldFromRow(row) : null;
}

export async function placeLegalHold(ctx: PgContext, input: LegalHoldInsert): Promise<LegalHoldView> {
  return await ctx.withTransaction(async (client) => {
    // Exclusive: waits for every purge batch and hold-checked delete under way; each later one sees this hold.
    await client.query(LEGAL_HOLD_LOCK_EXCLUSIVE_SQL);
    await client.query(
      `INSERT INTO legal_holds (id, name, reason, matter_ref, scope_type, scope_id, status, ends_at, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $9)`,
      [input.id, input.name, input.reason, input.matterRef, input.scopeType, input.scopeId, input.endsAt, input.createdBy, input.createdAt]
    );
    for (let start = 0; start < input.items.length; start += ITEM_CHUNK) {
      const chunk = input.items.slice(start, start + ITEM_CHUNK);
      await client.query(
        `INSERT INTO legal_hold_items (hold_id, kind, row_id, added_at)
         SELECT $1, kind, row_id, $2 FROM unnest($3::text[], $4::text[]) AS t(kind, row_id)
         ON CONFLICT DO NOTHING`,
        [input.id, input.createdAt, chunk.map((item) => item.kind), chunk.map((item) => item.rowId)]
      );
    }
    return (await getHold(client, input.id))!;
  });
}

export async function releaseLegalHold(
  ctx: PgContext,
  input: { id: string; releasedBy: string | null; reason: string; releasedAt: string }
): Promise<LegalHoldView | null> {
  await ctx.execute(
    `UPDATE legal_holds SET status = 'released', released_by = $1, released_at = $2, release_reason = $3 WHERE id = $4 AND status = 'active'`,
    [input.releasedBy, input.releasedAt, input.reason, input.id]
  );
  return await getHold(ctx.pool, input.id);
}

export async function getLegalHold(ctx: PgContext, id: string): Promise<LegalHoldView | null> {
  return await getHold(ctx.pool, id);
}

export async function listLegalHolds(ctx: PgContext, options: { status?: LegalHoldStatus } = {}): Promise<LegalHoldView[]> {
  const rows = options.status
    ? await ctx.query<LegalHoldRow>(`SELECT ${LEGAL_HOLD_COLUMNS} FROM legal_holds h WHERE h.status = $1 ORDER BY h.created_at DESC, h.id DESC`, [options.status])
    : await ctx.query<LegalHoldRow>(`SELECT ${LEGAL_HOLD_COLUMNS} FROM legal_holds h ORDER BY h.created_at DESC, h.id DESC`);
  return rows.map(legalHoldFromRow);
}

export async function listLegalHoldItems(
  ctx: PgContext,
  holdId: string,
  page: { offset: number; limit: number }
): Promise<{ items: LegalHoldItemView[]; total: number }> {
  const total = Number((await ctx.queryOne<{ n: string }>(`SELECT COUNT(*) AS n FROM legal_hold_items WHERE hold_id = $1`, [holdId]))?.n ?? 0);
  const rows = await ctx.query<{ kind: string; row_id: string; added_at: unknown }>(
    `SELECT kind, row_id, added_at FROM legal_hold_items WHERE hold_id = $1 ORDER BY added_at, kind COLLATE "C", row_id COLLATE "C" LIMIT $2 OFFSET $3`,
    [holdId, Math.max(1, Math.min(500, Math.floor(page.limit))), Math.max(0, Math.floor(page.offset))]
  );
  return { items: rows.map(legalHoldItemFromRow), total };
}

/** The active holds on `target`, read with the connection given (inside a delete's transaction, after its lock). */
export async function legalHoldsOnWith(db: Queryable, target: LegalHoldTarget): Promise<LegalHoldRef[]> {
  const { sql, params } = legalHoldsOnSql(target);
  return holdRefs((await db.query<{ id: string; name: string }>(toPgPlaceholders(sql), params)).rows);
}

export async function legalHoldsOn(ctx: PgContext, target: LegalHoldTarget): Promise<LegalHoldRef[]> {
  return await legalHoldsOnWith(ctx.pool, target);
}

/**
 * For a delete inside `client`'s transaction: takes the legal-hold lock shared (before any row lock the delete takes),
 * then throws LegalHoldError when a hold keeps anything deleting `target` would remove. Held to commit, so no hold is
 * placed between this check and the delete.
 */
export async function refuseIfHeld(client: Queryable, target: LegalHoldTarget, what: string, refused?: string): Promise<void> {
  await client.query(LEGAL_HOLD_LOCK_SHARED_SQL);
  const holds = await legalHoldsOnWith(client, target);
  if (holds.length > 0) throw new LegalHoldError(what, holds, refused);
}
