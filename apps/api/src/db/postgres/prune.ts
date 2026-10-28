/**
 * Retention pruning on Postgres, and its lock order against a workflow delete and every other writer.
 *
 * Rule: a prune never waits for a row lock. Each table is pruned in short batches, each one statement that locks only
 * rows nobody else holds (`FOR UPDATE SKIP LOCKED`) and deletes them:
 *
 *   WITH doomed AS (SELECT id FROM <table> WHERE <old rows> LIMIT <n> FOR UPDATE SKIP LOCKED)
 *   DELETE FROM <table> USING doomed WHERE <table>.id = doomed.id
 *
 * A row that another transaction holds (a workflow delete that is under way, an approval being decided, a run being
 * finished) is skipped and goes on a later run. A transaction that never waits for a lock cannot be part of a
 * deadlock, so the prune jobs cannot deadlock with a workflow delete (which locks the workflow row and then
 * execution_history, workflow_executions, approval_requests, mcp_cassettes, replay_recordings, guard_events, …,
 * eval_results, eval_runs, in that order) or with each other, whatever tables they touch. They still visit the tables
 * in the delete's relative order (history, approval requests, cassettes, guard events; golden-run results before
 * their runs), and each batch commits on its own (or, for replay jobs, with its chunk), so no prune holds locks for
 * longer than one batch.
 *
 * Before this rule the execution-history prune ran in one transaction that deleted cassettes and guard events and
 * then waited for approval requests, while a workflow delete held its approval requests and then waited for its
 * cassettes: Postgres aborted one of them as a deadlock (postgres-prune-lock-order.test.ts).
 *
 * SQLite needs none of this: the SQLite store runs on one connection in one process, and every store write runs
 * synchronously to its end, so no prune and delete ever interleave.
 */
import type { PoolClient } from "pg";

type Queryable = Pick<PoolClient, "query">;

/** Rows one prune statement deletes at most. */
export const PRUNE_BATCH_ROWS = 1000;

/**
 * Deletes the rows of `table` (keyed by `id`) that match `where`, in batches of `batchRows`, skipping rows another
 * transaction holds; returns how many it deleted. `where` is trusted SQL over `params` ($1, $2, …).
 */
export async function deleteUnlockedInBatches(db: Queryable, table: string, where: string, params: unknown[], batchRows = PRUNE_BATCH_ROWS): Promise<number> {
  let total = 0;
  for (;;) {
    const result = await db.query(
      `WITH doomed AS (SELECT id FROM ${table} WHERE ${where} LIMIT ${batchRows} FOR UPDATE SKIP LOCKED)
       DELETE FROM ${table} USING doomed WHERE ${table}.id = doomed.id`,
      params
    );
    const deleted = result.rowCount ?? 0;
    total += deleted;
    if (deleted < batchRows) return total;
  }
}

/**
 * The replay jobs and eval runs `runIds` (finished ones) with their case results, without waiting for a lock: the
 * results first, then each run whose results are all gone. A run whose results another transaction holds stays, with
 * them, for a later prune. Returns the runs deleted.
 */
export async function deleteRunsUnlocked(db: Queryable, runIds: readonly string[]): Promise<number> {
  if (runIds.length === 0) return 0;
  await deleteUnlockedInBatches(db, "eval_results", "run_id = ANY($1::text[])", [runIds]);
  return await deleteUnlockedInBatches(
    db,
    "eval_runs",
    "id = ANY($1::text[]) AND status NOT IN ('queued', 'running') AND NOT EXISTS (SELECT 1 FROM eval_results r WHERE r.run_id = eval_runs.id)",
    [runIds]
  );
}
