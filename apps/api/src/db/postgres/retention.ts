/**
 * 13.3 — retention on Postgres: per-table purges by age (the same rows as SqliteStore, from RETENTION_TABLES), the
 * backlog count, and the purge log. Purges never wait for a row lock (prune.ts): a row another transaction holds is
 * skipped and goes on a later purge.
 */
import type { RetentionRunView } from "@ai-orchestrator/shared";
import type { PgContext } from "./context.js";
import { deleteUnlockedInBatches } from "./prune.js";
import { LEGAL_HOLD_LOCK_SHARED_SQL } from "../legal-hold-sql.js";
import {
  RETENTION_BATCH_ROWS,
  RETENTION_TABLES,
  isRetentionTable,
  retentionRunFromRow,
  retentionWhere,
  type RetentionRunRow,
  type RetentionScope,
  type RetentionTable
} from "../retention-tables.js";

export async function pruneRetentionTable(ctx: PgContext, table: RetentionTable, scope: RetentionScope): Promise<number> {
  if (!isRetentionTable(table)) throw new Error(`Not a retention table: ${String(table)}`);
  const limit = Math.floor(scope.limit);
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return await deleteUnheldInBatches(ctx, table, retentionWhere(table, "$1"), [scope.before], {
    key: RETENTION_TABLES[table].key === "row" ? "ctid" : "id",
    maxRows: limit
  });
}

/**
 * 13.3 — deleteUnlockedInBatches for a purge `where` that leaves out held rows (legal-hold-sql.ts): each batch is its
 * own short transaction that takes the legal-hold lock shared before it reads, so a hold placed meanwhile (which takes
 * it exclusively) waits for the batch under way and is seen by the next one.
 */
export async function deleteUnheldInBatches(
  ctx: PgContext,
  table: string,
  where: string,
  params: unknown[],
  options: { key?: "id" | "ctid"; maxRows?: number; batchRows?: number } = {}
): Promise<number> {
  const maxRows = options.maxRows ?? Number.POSITIVE_INFINITY;
  const batchRows = options.batchRows ?? RETENTION_BATCH_ROWS;
  let total = 0;
  while (total < maxRows) {
    const batch = Math.min(batchRows, maxRows - total);
    const deleted = await ctx.withTransaction(async (client) => {
      await client.query(LEGAL_HOLD_LOCK_SHARED_SQL);
      return await deleteUnlockedInBatches(client, table, where, params, batch, { key: options.key, maxRows: batch });
    });
    total += deleted;
    if (deleted < batch) break;
  }
  return total;
}

export async function countRetentionDue(ctx: PgContext, table: RetentionTable, input: { before: string; cap: number }): Promise<number> {
  if (!isRetentionTable(table)) throw new Error(`Not a retention table: ${String(table)}`);
  const row = await ctx.queryOne<{ n: string | number }>(
    `SELECT count(*) AS n FROM (SELECT 1 FROM ${table} WHERE ${retentionWhere(table, "$1")} LIMIT $2) AS due`,
    [input.before, Math.max(0, Math.floor(input.cap))]
  );
  return row ? Number(row.n) : 0;
}

export async function saveRetentionRun(ctx: PgContext, run: RetentionRunView): Promise<void> {
  await ctx.execute(
    `INSERT INTO retention_runs (id, started_at, finished_at, instance_id, reason, outcome, counts_json, capped_json, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [run.id, run.startedAt, run.finishedAt, run.instanceId, run.reason, run.outcome, JSON.stringify(run.counts), JSON.stringify(run.capped), run.error]
  );
}

export async function listRetentionRuns(ctx: PgContext, limit: number): Promise<RetentionRunView[]> {
  const rows = await ctx.query<RetentionRunRow>(
    `SELECT id, started_at, finished_at, instance_id, reason, outcome, counts_json, capped_json, error
     FROM retention_runs ORDER BY started_at DESC, id DESC LIMIT $1`,
    [Math.max(1, Math.min(500, Math.floor(limit)))]
  );
  return rows.map(retentionRunFromRow);
}
