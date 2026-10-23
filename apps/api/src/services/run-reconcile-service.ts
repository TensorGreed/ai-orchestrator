import type { SqliteStore } from "../db/database.js";
import { STUCK_JOB_MARGIN_MS } from "./queue-service.js";

export const INTERRUPTED_RUN_ERROR = "interrupted: the server stopped while this run was in progress";

export interface ReconcileOptions {
  /** With several replicas another instance may own a live run, so only runs older than any run could last are touched. */
  haEnabled: boolean;
  executionTimeoutMs: number;
  now?: number;
}

/**
 * Marks runs left as "running" by a stopped server as errors. Runs paused for approval are durable
 * (their status is waiting_approval) and runs the queue still owns are skipped by the store.
 */
export function reconcileInterruptedRuns(store: SqliteStore, options: ReconcileOptions): Array<{ id: string; workflowId: string }> {
  const now = options.now ?? Date.now();
  const startedBefore = options.haEnabled
    ? new Date(now - options.executionTimeoutMs - STUCK_JOB_MARGIN_MS).toISOString()
    : undefined;
  return store.reconcileOrphanedExecutions({ error: INTERRUPTED_RUN_ERROR, startedBefore });
}
