import type { SqliteStore } from "../db/database.js";
import { MAX_RUN_TIMEOUT_MS, STUCK_JOB_MARGIN_MS } from "../db/queue-timeouts.js";

export const INTERRUPTED_RUN_ERROR = "interrupted: the server stopped while this run was in progress";

export interface ReconcileOptions {
  /** Another process may be running runs against this database, so only runs older than any run could last are touched. */
  sharedDatabase: boolean;
  now?: number;
}

/**
 * Marks runs left as "running" by a stopped server as errors. Runs paused for approval are durable
 * (their status is waiting_approval) and runs the queue still owns are skipped by the store.
 * History rows do not record the per-run time limit, so on a shared database the cutoff is the longest limit a run can have.
 */
export async function reconcileInterruptedRuns(
  store: SqliteStore,
  options: ReconcileOptions
): Promise<Array<{ id: string; workflowId: string }>> {
  const now = options.now ?? Date.now();
  const startedBefore = options.sharedDatabase
    ? new Date(now - MAX_RUN_TIMEOUT_MS - STUCK_JOB_MARGIN_MS).toISOString()
    : undefined;
  // PostgresStore implements this asynchronously behind the SqliteStore type.
  return await Promise.resolve(store.reconcileOrphanedExecutions({ error: INTERRUPTED_RUN_ERROR, startedBefore }));
}
