/**
 * 13.3 — retention on Postgres: per-table purges by age (the same rows as SqliteStore, from RETENTION_TABLES), the
 * backlog count, and the purge log. Purges never wait for a row lock (prune.ts): a row another transaction holds is
 * skipped and goes on a later purge.
 */
import crypto from "node:crypto";
import type { RetentionPolicyRecord, RetentionRunView } from "@ai-orchestrator/shared";
import type { Store } from "../store.js";
import type { PgContext } from "./context.js";
import { deleteUnlockedInBatches } from "./prune.js";
import {
  RETENTION_BATCH_ROWS,
  RETENTION_TABLES,
  isRetentionTable,
  retentionPolicyFromRow,
  retentionRunFromRow,
  retentionScopeWhere,
  type RetentionPolicyRow,
  type RetentionRunRow,
  type RetentionScope,
  type RetentionTable
} from "../retention-tables.js";

export async function pruneRetentionTable(ctx: PgContext, table: RetentionTable, scope: RetentionScope): Promise<number> {
  if (!isRetentionTable(table)) throw new Error(`Not a retention table: ${String(table)}`);
  const limit = Math.floor(scope.limit);
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  const where = retentionScopeWhere(table, scope, "postgres");
  return await deleteUnlockedInBatches(ctx.pool, table, where.sql, where.params, RETENTION_BATCH_ROWS, {
    key: RETENTION_TABLES[table].key === "row" ? "ctid" : "id",
    maxRows: limit
  });
}

export async function countRetentionDue(ctx: PgContext, table: RetentionTable, input: Parameters<Store["countRetentionDue"]>[1]): Promise<number> {
  if (!isRetentionTable(table)) throw new Error(`Not a retention table: ${String(table)}`);
  const where = retentionScopeWhere(table, input, "postgres");
  const row = await ctx.queryOne<{ n: string | number }>(
    `SELECT count(*) AS n FROM (SELECT 1 FROM ${table} WHERE ${where.sql} LIMIT $${where.params.length + 1}) AS due`,
    [...where.params, Math.max(0, Math.floor(input.cap))]
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

export async function listRetentionPolicies(ctx: PgContext, filter: { scopeId?: string } = {}): Promise<RetentionPolicyRecord[]> {
  const rows =
    filter.scopeId === undefined
      ? await ctx.query<RetentionPolicyRow>(
          `SELECT scope_type, scope_id, data_class, days, updated_by, updated_at FROM retention_policies
           WHERE scope_type = 'project' ORDER BY scope_id COLLATE "C", data_class COLLATE "C"`
        )
      : await ctx.query<RetentionPolicyRow>(
          `SELECT scope_type, scope_id, data_class, days, updated_by, updated_at FROM retention_policies
           WHERE scope_type = 'project' AND scope_id = $1 ORDER BY data_class COLLATE "C"`,
          [filter.scopeId]
        );
  return rows.map(retentionPolicyFromRow).filter((row): row is RetentionPolicyRecord => row !== null);
}

export async function setRetentionPolicies(ctx: PgContext, input: Parameters<Store["setRetentionPolicies"]>[0]): Promise<RetentionPolicyRecord[]> {
  return await ctx.withTransaction(async (client) => {
    const before = (
      await client.query<RetentionPolicyRow>(
        `SELECT scope_type, scope_id, data_class, days, updated_by, updated_at FROM retention_policies
         WHERE scope_type = 'project' AND scope_id = $1 ORDER BY data_class COLLATE "C" FOR UPDATE`,
        [input.scopeId]
      )
    ).rows
      .map(retentionPolicyFromRow)
      .filter((row): row is RetentionPolicyRecord => row !== null);
    const now = new Date().toISOString();
    for (const [dataClass, days] of Object.entries(input.values)) {
      if (days === undefined) continue;
      if (days === null) {
        await client.query(`DELETE FROM retention_policies WHERE scope_type = 'project' AND scope_id = $1 AND data_class = $2`, [input.scopeId, dataClass]);
      } else {
        await client.query(
          `INSERT INTO retention_policies (id, scope_type, scope_id, data_class, days, updated_by, updated_at)
           VALUES ($1, 'project', $2, $3, $4, $5, $6)
           ON CONFLICT (scope_type, scope_id, data_class) DO UPDATE SET days = EXCLUDED.days, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
          [crypto.randomUUID(), input.scopeId, dataClass, days, input.updatedBy, now]
        );
      }
    }
    return before;
  });
}

export async function listExistingExecutionIds(ctx: PgContext, executionIds: readonly string[]): Promise<string[]> {
  const ids = [...new Set(executionIds)];
  if (ids.length === 0) return [];
  const rows = await ctx.query<{ id: string }>(`SELECT id FROM execution_history WHERE id = ANY($1::text[])`, [ids]);
  return rows.map((row) => String(row.id));
}
