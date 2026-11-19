/**
 * v80 — the background fill of `execution_history.triggered_by_user_id` for the runs recorded before v80, on Postgres
 * (see db/execution-starter-fill.ts for the markers and services/execution-starter-fill-service.ts for who runs it).
 */
import {
  STARTER_FILL_AFTER_PREFIX,
  STARTER_FILL_BATCH_SIZE,
  STARTER_FILL_DONE_MARKER,
  isStarterFillProgressMarker,
  starterFillState,
  type ExecutionStarterFillBatch,
  type ExecutionStarterFillState
} from "../execution-starter-fill.js";
import type { PgContext } from "./context.js";

const FILL_MARKERS_SQL = `SELECT name FROM schema_markers WHERE name = $1 OR left(name, length($2)) = $2`;
/** The prefix every progress marker shares (`execution_starter_fill_upto:` and `execution_starter_fill_after:`). */
const PROGRESS_PREFIX = "execution_starter_fill_";
/** The advisory lock class the batches take turns on (see the key space in postgres-store.ts). */
export const ADVISORY_LOCK_CLASS_STARTER_FILL = 0x4c3246;

/** v80 — see Store.getExecutionStarterFill. */
export async function getExecutionStarterFill(ctx: PgContext): Promise<ExecutionStarterFillState> {
  const rows = await ctx.query<{ name: string }>(FILL_MARKERS_SQL, [STARTER_FILL_DONE_MARKER, PROGRESS_PREFIX]);
  return starterFillState(rows.map((row) => String(row.name)));
}

/**
 * v80 — see Store.fillExecutionStarters. Migration 80's rule: for a run that asked for an approval, its first request's
 * requester (an older build wrote the approver into triggered_by when it resumed), by user id, else by email; a resumed
 * run with no request names nobody; any other run, its triggered_by. That names the account with that user id, or with
 * that email (any case) when the account was created before the run started. No account, or two: NULL.
 *
 * One transaction per batch: it takes a transaction-level advisory lock first, so two instances that both ran a batch
 * take turns, then reads the markers in a statement of its own (READ COMMITTED: it sees the progress the other one
 * committed; a `FOR UPDATE` read of the markers would not see a marker the other one inserted, and would start over).
 * Then at most `limit` runs by `seq` are filled and the progress marker moves past them.
 */
export async function fillExecutionStarters(ctx: PgContext, limit: number = STARTER_FILL_BATCH_SIZE): Promise<ExecutionStarterFillBatch> {
  const size = Math.max(1, Math.min(Math.floor(limit), 50_000));
  const began = performance.now();
  const outcome = await ctx.withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock($1, hashtext(current_schema()))`, [ADVISORY_LOCK_CLASS_STARTER_FILL]);
    const names = (await client.query<{ name: string }>(FILL_MARKERS_SQL, [STARTER_FILL_DONE_MARKER, PROGRESS_PREFIX])).rows.map((row) =>
      String(row.name)
    );
    const state = starterFillState(names);
    if (state.done || state.upTo === null) return { visited: 0, filled: 0, done: true };
    const batch = (
      // `seq` read as text (a BIGINT), ordered as the number it is.
      await client.query<{ id: string; seq_text: string }>(
        `SELECT id, seq::text AS seq_text FROM execution_history
          WHERE seq > $1 AND seq <= $2 AND triggered_by_user_id IS NULL
          ORDER BY seq LIMIT $3`,
        [state.after, state.upTo, size]
      )
    ).rows;
    if (batch.length === 0) {
      const progress = names.filter(isStarterFillProgressMarker);
      if (progress.length > 0) await client.query(`DELETE FROM schema_markers WHERE name = ANY($1::text[])`, [progress]);
      await client.query(`INSERT INTO schema_markers (name, created_at) VALUES ($1, CURRENT_TIMESTAMP) ON CONFLICT (name) DO NOTHING`, [
        STARTER_FILL_DONE_MARKER
      ]);
      return { visited: 0, filled: 0, done: true };
    }
    const ids = batch.map((row) => String(row.id));
    const last = Number(batch[batch.length - 1]!.seq_text);
    // Three equality joins (by the request's user id, by id, by email) instead of one join on OR, so each is a hash
    // join: the OR form compared every run of a batch with every account.
    const updated = await client.query(
      `UPDATE execution_history eh SET triggered_by_user_id = m.user_id
       FROM (
         WITH s AS (
           SELECT h.id, h.started_at,
             fr.requested_by_user_id AS ref_id,
             CASE WHEN fr.execution_id IS NOT NULL THEN fr.requested_by
                  WHEN h.trigger_type = 'approval_resume' THEN NULL
                  ELSE h.triggered_by END AS ref
           FROM execution_history h
           LEFT JOIN LATERAL (
             SELECT a.execution_id, a.requested_by_user_id, a.requested_by FROM approval_requests a
             WHERE a.execution_id = h.id ORDER BY a.created_at, a.id LIMIT 1
           ) fr ON TRUE
           WHERE h.id = ANY($1::text[]) AND h.triggered_by_user_id IS NULL
         ),
         c AS (
           SELECT s.id, u.id AS user_id FROM s JOIN users u ON u.id = s.ref_id
           UNION
           SELECT s.id, u.id FROM s JOIN users u ON u.id = s.ref WHERE s.ref_id IS NULL
           UNION
           SELECT s.id, u.id FROM s JOIN users u ON LOWER(u.email) = LOWER(s.ref)
           WHERE s.ref_id IS NULL AND u.created_at <= s.started_at
         )
         SELECT c.id, MIN(c.user_id) AS user_id FROM c GROUP BY c.id HAVING COUNT(*) = 1
       ) m
       WHERE eh.id = m.id AND eh.triggered_by_user_id IS NULL`,
      [ids]
    );
    const passed = names.filter((name) => name.startsWith(STARTER_FILL_AFTER_PREFIX));
    if (passed.length > 0) await client.query(`DELETE FROM schema_markers WHERE name = ANY($1::text[])`, [passed]);
    await client.query(`INSERT INTO schema_markers (name, created_at) VALUES ($1, CURRENT_TIMESTAMP) ON CONFLICT (name) DO NOTHING`, [
      `${STARTER_FILL_AFTER_PREFIX}${last}`
    ]);
    return { visited: batch.length, filled: updated.rowCount ?? 0, done: false };
  });
  return { ...outcome, transactionMs: performance.now() - began };
}
