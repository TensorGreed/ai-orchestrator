/**
 * 13.3 — retention on Postgres: per-table purges by age (the same rows as SqliteStore, from RETENTION_TABLES), the
 * backlog count, and the purge log. Purges never wait for a row lock (prune.ts): a row another transaction holds is
 * skipped and goes on a later purge.
 */
import type { RetentionRunView } from "@ai-orchestrator/shared";
import type { PgContext } from "./context.js";
import { deleteUnlockedInBatches } from "./prune.js";
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
  return await deleteUnlockedInBatches(ctx.pool, table, retentionWhere(table, "$1"), [scope.before], RETENTION_BATCH_ROWS, {
    key: RETENTION_TABLES[table].key === "row" ? "ctid" : "id",
    maxRows: limit
  });
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
