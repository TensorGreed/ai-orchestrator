/**
 * Phase 13.1 — PostgresStore: The execution queue and its dead-letter list.
 * Plain functions over a PgContext; PostgresStore delegates here. Methods that are not implemented yet throw
 * StoreNotImplementedError and are listed in UNIMPLEMENTED_METHODS (remove both together when implementing one).
 */
import { randomUUID } from "node:crypto";
import { queuedRunTimeoutMs, STUCK_JOB_MARGIN_MS } from "../queue-timeouts.js";
import { StoreNotImplementedError } from "../store-errors.js";
import { type Store } from "../store.js";
import { toNum, toStr } from "./helpers.js";
import type { PgContext } from "./context.js";

export const UNIMPLEMENTED_METHODS: readonly (keyof Store)[] = [
  "hasActiveQueueItem"
];

export async function enqueueExecution(ctx: PgContext, input: {
  id: string;
  workflowId: string;
  workflowName?: string;
  payload: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
  scheduledAt?: string;
}): Promise<void> {
  const now = new Date().toISOString();
  await ctx.execute(
    `INSERT INTO execution_queue (id, workflow_id, workflow_name, payload_json, status, priority, attempts, max_attempts, last_error, scheduled_at, started_at, completed_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'pending', $5, 0, $6, NULL, $7, NULL, NULL, $8, $9)
       ON CONFLICT (id) DO NOTHING`,
    [
      input.id,
      input.workflowId,
      input.workflowName ?? null,
      JSON.stringify(input.payload),
      input.priority ?? 0,
      input.maxAttempts ?? 3,
      input.scheduledAt ?? now,
      now,
      now
    ]
  );
}

export async function dequeueNext(ctx: PgContext, limit = 1): Promise<Array<{
  id: string;
  workflowId: string;
  workflowName: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  scheduledAt: string;
}>> {
  const now = new Date().toISOString();
  const rows = await ctx.query<{
    id: string;
    workflow_id: string;
    workflow_name: string | null;
    payload_json: string;
    attempts: number;
    max_attempts: number;
    scheduled_at: string;
  }>(
    `SELECT id, workflow_id, workflow_name, payload_json, attempts, max_attempts, scheduled_at
       FROM execution_queue
       WHERE status = 'pending' AND scheduled_at <= $1
       ORDER BY priority DESC, scheduled_at ASC
       LIMIT $2`,
    [now, limit]
  );

  if (rows.length === 0) return [];

  for (const row of rows) {
    await ctx.execute(
      `UPDATE execution_queue SET status = 'running', started_at = $1, updated_at = $2 WHERE id = $3`,
      [now, now, row.id]
    );
  }

  return rows.map((row) => {
    let payload: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(toStr(row.payload_json));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch { /* ignore */ }
    return {
      id: toStr(row.id),
      workflowId: toStr(row.workflow_id),
      workflowName: row.workflow_name ? toStr(row.workflow_name) : null,
      payload,
      attempts: toNum(row.attempts),
      maxAttempts: toNum(row.max_attempts),
      scheduledAt: toStr(row.scheduled_at)
    };
  });
}

export async function markQueueItemRunning(ctx: PgContext, id: string): Promise<void> {
  const now = new Date().toISOString();
  await ctx.execute(
    `UPDATE execution_queue SET status = 'running', started_at = $1, updated_at = $2 WHERE id = $3`,
    [now, now, id]
  );
}

export async function markQueueItemCompleted(ctx: PgContext, id: string): Promise<void> {
  const now = new Date().toISOString();
  await ctx.execute(
    `UPDATE execution_queue SET status = 'completed', completed_at = $1, updated_at = $2 WHERE id = $3`,
    [now, now, id]
  );
}

/** Retries with backoff until max attempts; `retryable: false` moves the job to the DLQ now. */
export async function markQueueItemFailed(ctx: PgContext, id: string, error: string, options: { retryable?: boolean } = {}): Promise<void> {
  const now = new Date().toISOString();
  const row = await ctx.queryOne<{
    id: string;
    workflow_id: string;
    workflow_name: string | null;
    payload_json: string;
    attempts: number;
    max_attempts: number;
  }>(
    `SELECT id, workflow_id, workflow_name, payload_json, attempts, max_attempts FROM execution_queue WHERE id = $1`,
    [id]
  );
  if (!row) return;

  const attempts = toNum(row.attempts) + 1;
  const maxAttempts = toNum(row.max_attempts);

  if (attempts >= maxAttempts || options.retryable === false) {
    const dlqId = randomUUID();
    await ctx.execute(
      `INSERT INTO execution_queue_dlq (id, original_id, workflow_id, workflow_name, payload_json, attempts, final_error, failed_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        dlqId,
        toStr(row.id),
        toStr(row.workflow_id),
        row.workflow_name ? toStr(row.workflow_name) : null,
        toStr(row.payload_json),
        attempts,
        error,
        now,
        now
      ]
    );
    await ctx.execute(
      `UPDATE execution_queue SET status = 'dead', attempts = $1, last_error = $2, updated_at = $3 WHERE id = $4`,
      [attempts, error, now, id]
    );
  } else {
    const backoffMs = 1000 * Math.pow(2, attempts - 1);
    const retryAt = new Date(Date.now() + backoffMs).toISOString();
    await ctx.execute(
      `UPDATE execution_queue SET status = 'pending', attempts = $1, last_error = $2, scheduled_at = $3, updated_at = $4 WHERE id = $5`,
      [attempts, error, retryAt, now, id]
    );
  }
}

export async function requeueStuckItems(ctx: PgContext, stuckAfterMs = 600_000, excludeIds: string[] = [], marginMs = STUCK_JOB_MARGIN_MS): Promise<number> {
  const nowMs = Date.now();
  const stuckBefore = new Date(nowMs - stuckAfterMs).toISOString();
  const candidates = await ctx.pool.query(
    `SELECT id, started_at, payload_json FROM execution_queue
       WHERE status = 'running' AND started_at <= $1 AND NOT (id = ANY($2::text[]))`,
    [stuckBefore, excludeIds]
  );
  const ids = candidates.rows
    .filter((row: { started_at: Date | string; payload_json: string }) => {
      // A job may carry its own, longer run time limit; it is not stuck before that limit and the margin have passed.
      const runTimeout = queuedRunTimeoutMs(row.payload_json);
      return runTimeout === null || new Date(row.started_at).getTime() <= nowMs - Math.max(stuckAfterMs, runTimeout + marginMs);
    })
    .map((row: { id: string }) => row.id);
  if (ids.length === 0) return 0;
  const result = await ctx.pool.query(
    `UPDATE execution_queue SET status = 'pending', started_at = NULL, updated_at = $1
       WHERE status = 'running' AND id = ANY($2::text[]) AND started_at <= $3`,
    [new Date(nowMs).toISOString(), ids, stuckBefore]
  );
  return result.rowCount ?? 0;
}

export async function reconcileOrphanedExecutions(ctx: PgContext, input: {
  error: string;
  startedBefore?: string;
}): Promise<Array<{ id: string; workflowId: string }>> {
  const completedAt = new Date().toISOString();
  const result = await ctx.pool.query(
    `UPDATE execution_history
       SET status = 'error', completed_at = $1, error = $2,
           duration_ms = GREATEST(0, (EXTRACT(EPOCH FROM ($4::timestamptz - started_at::timestamptz)) * 1000)::bigint)
       WHERE status = 'running'
         AND ($3::timestamptz IS NULL OR started_at < $3::timestamptz)
         AND id NOT IN (SELECT id FROM execution_queue WHERE status IN ('pending', 'running'))
       RETURNING id, workflow_id`,
    [completedAt, input.error, input.startedBefore ?? null, completedAt]
  );
  return result.rows.map((row: { id: string; workflow_id: string }) => ({ id: row.id, workflowId: row.workflow_id }));
}

export async function getQueueDepth(ctx: PgContext): Promise<{ pending: number; running: number; dlq: number }> {
  const pendingRow = await ctx.queryOne<{ count: string }>(
    `SELECT COUNT(*) as count FROM execution_queue WHERE status = 'pending'`
  );
  const runningRow = await ctx.queryOne<{ count: string }>(
    `SELECT COUNT(*) as count FROM execution_queue WHERE status = 'running'`
  );
  const dlqRow = await ctx.queryOne<{ count: string }>(
    `SELECT COUNT(*) as count FROM execution_queue_dlq`
  );
  return {
    pending: pendingRow ? toNum(pendingRow.count) : 0,
    running: runningRow ? toNum(runningRow.count) : 0,
    dlq: dlqRow ? toNum(dlqRow.count) : 0
  };
}

export async function listDlqItems(ctx: PgContext, limit = 50, workflowIds?: string[]): Promise<Array<{
  id: string;
  originalId: string;
  workflowId: string;
  workflowName: string | null;
  attempts: number;
  finalError: string;
  failedAt: string;
}>> {
  if (workflowIds && workflowIds.length === 0) return [];
  const scope = workflowIds ? `WHERE workflow_id IN (${workflowIds.map((_, index) => `$${index + 1}`).join(", ")})` : "";
  const rows = await ctx.query<{
    id: string;
    original_id: string;
    workflow_id: string;
    workflow_name: string | null;
    attempts: number;
    final_error: string;
    failed_at: string;
  }>(
    `SELECT id, original_id, workflow_id, workflow_name, attempts, final_error, failed_at
       FROM execution_queue_dlq
       ${scope}
       ORDER BY failed_at DESC
       LIMIT $${(workflowIds?.length ?? 0) + 1}`,
    [...(workflowIds ?? []), limit]
  );
  return rows.map((row) => ({
    id: toStr(row.id),
    originalId: toStr(row.original_id),
    workflowId: toStr(row.workflow_id),
    workflowName: row.workflow_name ? toStr(row.workflow_name) : null,
    attempts: toNum(row.attempts),
    finalError: toStr(row.final_error),
    failedAt: toStr(row.failed_at)
  }));
}

export async function hasActiveQueueItem(_ctx: PgContext, ..._args: Parameters<Store["hasActiveQueueItem"]>): ReturnType<Store["hasActiveQueueItem"]> {
  throw new StoreNotImplementedError("hasActiveQueueItem");
}
