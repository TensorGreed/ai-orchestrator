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
 * eval_results, eval_runs, in that order) or with each other, whatever tables they touch. Execution history, approval
 * requests, cassettes, guard events, tool calls and captures go in that order, in batches that each commit on their own.
 * Replay jobs and eval runs go whole or not at all (deleteRunsWhole): in one short transaction per chunk of at most a
 * few hundred runs (pruneEvalRuns) or of simulations (pruneGuardSimulations), each run row is locked first and then
 * its case results, skipping whatever is held, and a run is deleted, with its results, only when the run and every one
 * of its results were obtained. With no waits the order cannot cycle; it is kept consistent for readability. So no
 * prune holds locks for longer than one batch or one chunk.
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
 * Deletes the finished replay jobs and eval runs among `runIds`, each whole or not at all, without waiting for a lock;
 * returns the ids of the runs deleted. Call it inside a transaction: the locks it takes are what keep a run and its
 * results together until the commit.
 *
 * 1. Lock the finished run rows, skipping held ones.
 * 2. Lock the case results of those runs, skipping held ones, and count them against all their results.
 * 3. Delete the results and the run only for a run whose row and every result were obtained.
 *
 * A run whose row or any one of its results another transaction holds (a workflow delete under way, a data-subject
 * delete marking it ineligible) keeps its row and all its results for a later prune, so a job is never left listed
 * with part of its results gone. The deletes re-lock with SKIP LOCKED, and a run goes only once none of its results is
 * left, so even a result committed after the count is neither waited for nor orphaned (its run then stays for a
 * later prune).
 */
export async function deleteRunsWhole(tx: Queryable, runIds: readonly string[]): Promise<Set<string>> {
  if (runIds.length === 0) return new Set();
  const locked = (
    await tx.query<{ id: string }>(
      `SELECT id FROM eval_runs WHERE id = ANY($1::text[]) AND status NOT IN ('queued', 'running') ORDER BY id FOR UPDATE SKIP LOCKED`,
      [runIds]
    )
  ).rows.map((row) => String(row.id));
  if (locked.length === 0) return new Set();
  const obtained = new Map<string, number>();
  for (const row of (
    await tx.query<{ run_id: string; n: number }>(
      `WITH held AS (SELECT run_id FROM eval_results WHERE run_id = ANY($1::text[]) FOR UPDATE SKIP LOCKED)
       SELECT run_id, count(*)::int AS n FROM held GROUP BY run_id`,
      [locked]
    )
  ).rows) {
    obtained.set(String(row.run_id), Number(row.n));
  }
  const totals = new Map<string, number>();
  for (const row of (
    await tx.query<{ run_id: string; n: number }>(`SELECT run_id, count(*)::int AS n FROM eval_results WHERE run_id = ANY($1::text[]) GROUP BY run_id`, [locked])
  ).rows) {
    totals.set(String(row.run_id), Number(row.n));
  }
  const whole = locked.filter((id) => (obtained.get(id) ?? 0) === (totals.get(id) ?? 0));
  if (whole.length === 0) return new Set();
  await deleteUnlockedInBatches(tx, "eval_results", "run_id = ANY($1::text[])", [whole]);
  const deleted = await tx.query<{ id: string }>(
    `DELETE FROM eval_runs WHERE id = ANY($1::text[]) AND NOT EXISTS (SELECT 1 FROM eval_results r WHERE r.run_id = eval_runs.id) RETURNING id`,
    [whole]
  );
  return new Set(deleted.rows.map((row) => String(row.id)));
}
