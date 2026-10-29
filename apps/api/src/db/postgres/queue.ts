/**
 * Phase 13.1 — PostgresStore: The execution queue and its dead-letter list.
 * Plain functions over a PgContext; PostgresStore delegates here. Every method is implemented.
 */
import { randomUUID } from "node:crypto";
import { queuedRunTimeoutMs, STUCK_JOB_MARGIN_MS } from "../queue-timeouts.js";
import type { QueueClaimedItem, QueueClaimFence, QueueItemOutcome, Store } from "../store.js";
import { toNum, toStr } from "./helpers.js";
import type { PgContext } from "./context.js";
import { clampLimit, LIMIT_MAX } from "../store-limits.js";
import {
  decideLostJob,
  lostJobEffects,
  DEFAULT_QUEUE_POOL,
  fairClaimWindow,
  payloadExecutionId,
  payloadIsResume,
  WORKER_LOST_REASONS,
  WORKER_SHUTDOWN_REASONS,
  type LostJobOutcome,
  type LostJobReasons
} from "../queue-leases.js";
import type { PoolClient } from "pg";

export async function enqueueExecution(ctx: PgContext, input: {
  id: string;
  workflowId: string;
  workflowName?: string;
  payload: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
  scheduledAt?: string;
  pool?: string;
  replaceFinishedBefore?: string;
}): Promise<boolean> {
  const now = new Date().toISOString();
  // A finished item past the window is replaced by the new job: every column back to a fresh pending item.
  const onConflict = input.replaceFinishedBefore
    ? `ON CONFLICT (id) DO UPDATE SET
         workflow_id = EXCLUDED.workflow_id, workflow_name = EXCLUDED.workflow_name, payload_json = EXCLUDED.payload_json,
         status = 'pending', priority = EXCLUDED.priority, attempts = 0, max_attempts = EXCLUDED.max_attempts, last_error = NULL,
         scheduled_at = EXCLUDED.scheduled_at, started_at = NULL, completed_at = NULL, created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at, pool = EXCLUDED.pool, execution_id = EXCLUDED.execution_id, claimed_by = NULL,
         claim_token = NULL, heartbeat_at = NULL, lost_count = 0, nodes_completed = 0, result_json = NULL,
         effects_token = NULL, effects_started = 0
       WHERE execution_queue.status IN ('completed', 'dead') AND execution_queue.created_at < $12`
    : `ON CONFLICT (id) DO NOTHING`;
  const result = await ctx.pool.query(
    `INSERT INTO execution_queue (id, workflow_id, workflow_name, payload_json, status, priority, attempts, max_attempts, last_error, scheduled_at, started_at, completed_at, created_at, updated_at, pool, execution_id)
       VALUES ($1, $2, $3, $4, 'pending', $5, 0, $6, NULL, $7, NULL, NULL, $8, $9, $10, $11)
       ${onConflict}`,
    [
      input.id,
      input.workflowId,
      input.workflowName ?? null,
      JSON.stringify(input.payload),
      input.priority ?? 0,
      input.maxAttempts ?? 3,
      input.scheduledAt ?? now,
      now,
      now,
      input.pool ?? DEFAULT_QUEUE_POOL,
      payloadExecutionId(input.payload, input.id),
      ...(input.replaceFinishedBefore ? [input.replaceFinishedBefore] : [])
    ]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Claims up to `limit` due jobs, highest priority first, then oldest schedule. One statement: the rows are picked with
 * `FOR UPDATE SKIP LOCKED` and moved to `running` together, so two pollers (or two API instances) never claim the same
 * job; a poller skips rows another one is claiming instead of waiting for them.
 */
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
    priority: number;
    attempts: number;
    max_attempts: number;
    scheduled_at: string;
    created_at: string;
  }>(
    `WITH picked AS (
       SELECT id FROM execution_queue
        WHERE status = 'pending' AND scheduled_at <= $1
        ORDER BY priority DESC, scheduled_at ASC, created_at ASC, id COLLATE "C"
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     )
     UPDATE execution_queue AS q SET status = 'running', started_at = $1, updated_at = $1
       FROM picked WHERE q.id = picked.id
     RETURNING q.id, q.workflow_id, q.workflow_name, q.payload_json, q.priority, q.attempts, q.max_attempts, q.scheduled_at, q.created_at`,
    [now, clampLimit(limit, { fallback: 1, max: LIMIT_MAX.dequeueNext })]
  );
  // RETURNING has no order; give the claim order back.
  rows.sort((a, b) =>
    toNum(b.priority) - toNum(a.priority) ||
    Date.parse(toStr(a.scheduled_at)) - Date.parse(toStr(b.scheduled_at)) ||
    Date.parse(toStr(a.created_at)) - Date.parse(toStr(b.created_at)) ||
    (toStr(a.id) < toStr(b.id) ? -1 : toStr(a.id) > toStr(b.id) ? 1 : 0)
  );
  return rows.map((row) => {
    let payload: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(toStr(row.payload_json));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch { /* a malformed payload runs with none, as on SQLite */ }
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

export async function markQueueItemCompleted(ctx: PgContext, id: string, options: { claimToken?: string } = {}): Promise<boolean> {
  if (options.claimToken !== undefined) {
    // Fenced: only the claim that still holds the item completes it (database time).
    const result = await ctx.pool.query(
      `UPDATE execution_queue SET status = 'completed', completed_at = now(), updated_at = now(), heartbeat_at = NULL
         WHERE id = $1 AND claim_token = $2 AND status = 'running'`,
      [id, options.claimToken]
    );
    return (result.rowCount ?? 0) > 0;
  }
  const now = new Date().toISOString();
  const result = await ctx.pool.query(
    `UPDATE execution_queue SET status = 'completed', completed_at = $1, updated_at = $2 WHERE id = $3`,
    [now, now, id]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Retries with backoff until max attempts; `retryable: false` moves the job to the DLQ now. One transaction. With a
 * claim token, only while the item is still running under that token.
 */
export async function markQueueItemFailed(ctx: PgContext, id: string, error: string, options: { retryable?: boolean; claimToken?: string } = {}): Promise<boolean> {
  const now = new Date().toISOString();
  return await ctx.withTransaction(async (client) => {
    const row = (await client.query<{
      id: string;
      workflow_id: string;
      workflow_name: string | null;
      payload_json: string;
      attempts: number;
      max_attempts: number;
      status: string;
      claim_token: string | null;
    }>(
      `SELECT id, workflow_id, workflow_name, payload_json, attempts, max_attempts, status, claim_token FROM execution_queue WHERE id = $1 FOR UPDATE`,
      [id]
    )).rows[0];
    if (!row) return false;
    if (options.claimToken !== undefined && (row.status !== "running" || row.claim_token !== options.claimToken)) return false;

    const attempts = toNum(row.attempts) + 1;
    const maxAttempts = toNum(row.max_attempts);

    if (attempts >= maxAttempts || options.retryable === false) {
      await client.query(
        `INSERT INTO execution_queue_dlq (id, original_id, workflow_id, workflow_name, payload_json, attempts, final_error, failed_at, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          randomUUID(),
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
      await client.query(
        `UPDATE execution_queue SET status = 'dead', attempts = $1, last_error = $2, updated_at = $3, heartbeat_at = NULL WHERE id = $4`,
        [attempts, error, now, id]
      );
    } else {
      const backoffMs = 1000 * Math.pow(2, attempts - 1);
      if (options.claimToken !== undefined) {
        // A leased claim retries on the database clock, like every lease comparison.
        await client.query(
          `UPDATE execution_queue SET status = 'pending', attempts = $1, last_error = $2, scheduled_at = now() + make_interval(secs => $3::double precision / 1000),
                  updated_at = now(), claimed_by = NULL, claim_token = NULL, heartbeat_at = NULL, started_at = NULL
            WHERE id = $4`,
          [attempts, error, backoffMs, id]
        );
      } else {
        const retryAt = new Date(Date.now() + backoffMs).toISOString();
        await client.query(
          `UPDATE execution_queue SET status = 'pending', attempts = $1, last_error = $2, scheduled_at = $3, updated_at = $4 WHERE id = $5`,
          [attempts, error, retryAt, now, id]
        );
      }
    }
    return true;
  });
}

export async function requeueStuckItems(ctx: PgContext, stuckAfterMs = 600_000, excludeIds: string[] = [], marginMs = STUCK_JOB_MARGIN_MS): Promise<number> {
  const nowMs = Date.now();
  const stuckBefore = new Date(nowMs - stuckAfterMs).toISOString();
  const candidates = await ctx.pool.query(
    `SELECT id, started_at, payload_json FROM execution_queue
       WHERE status = 'running' AND started_at <= $1 AND NOT (id = ANY($2::text[]))
         AND heartbeat_at IS NULL`,
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
    `UPDATE execution_queue SET status = 'pending', started_at = NULL, updated_at = $1, claimed_by = NULL, claim_token = NULL, heartbeat_at = NULL
       WHERE status = 'running' AND id = ANY($2::text[]) AND started_at <= $3 AND heartbeat_at IS NULL`,
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

/** Of these execution ids, the ones a pending or running job drives (by execution_id, else by its id or `<id>:…`). */
export async function listExecutionIdsWithActiveQueueJob(ctx: PgContext, executionIds: string[]): Promise<string[]> {
  const ids = [...new Set(executionIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (ids.length === 0) return [];
  const rows = await ctx.query<{ execution_id: string }>(
    `SELECT DISTINCT wanted.id AS execution_id
       FROM unnest($1::text[]) AS wanted(id)
       JOIN execution_queue q
         ON q.status IN ('pending', 'running')
        AND (q.execution_id = wanted.id
             OR (q.execution_id IS NULL AND (q.id = wanted.id OR starts_with(q.id, wanted.id || ':'))))`,
    [ids]
  );
  return rows.map((row) => row.execution_id).sort();
}

/** Whether `id`, or a job keyed `<id>:…`, is pending or running. LIKE is case-insensitive on SQLite, so ILIKE here. */
export async function hasActiveQueueItem(ctx: PgContext, id: string): Promise<boolean> {
  const row = await ctx.queryOne<{ id: string }>(
    `SELECT id FROM execution_queue WHERE (id = $1 OR id ILIKE $2 ESCAPE '\\') AND status IN ('pending', 'running') LIMIT 1`,
    [id, `${id.replace(/[\\%_]/g, "\\$&")}:%`]
  );
  return Boolean(row);
}

// ---------------------------------------------------------------------------
// Phase 13.1 — leased claims (cluster mode). Every lease comparison uses the database clock (now()), never a host's.
// ---------------------------------------------------------------------------

function parsePayload(raw: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(toStr(raw));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* a malformed payload runs with none, as on SQLite */ }
  return {};
}

/**
 * Claims up to `limit` due items of `pools` for `owner`. A bounded candidate window (queue-leases.ts fairClaimWindow)
 * is read in claim order and ranked per workflow, so a batch takes one item of each workflow before a second of any
 * (priority, then due time, decide within a rank). Only the picked rows are locked, with SKIP LOCKED below the LIMIT:
 * concurrent claimers pass over each other's rows, and a row another claim already moved to running fails the
 * re-checked `status = 'pending'`. The picked rows move to running with a fresh fencing token and a heartbeat in the
 * same statement, in database time.
 */
export async function claimQueueItems(ctx: PgContext, input: { limit: number; owner: string; pools: string[] }): Promise<QueueClaimedItem[]> {
  const limit = clampLimit(input.limit, { fallback: 1, max: LIMIT_MAX.dequeueNext });
  if (input.pools.length === 0) return [];
  // One pool (the usual case) reads the window as an ordered scan of the claim index, stopping at the window size.
  const poolMatch = input.pools.length === 1 ? "pool = $1::text" : "pool = ANY($1::text[])";
  const rows = await ctx.query<{
    id: string;
    workflow_id: string;
    workflow_name: string | null;
    payload_json: string;
    attempts: number;
    max_attempts: number;
    scheduled_at: string;
    pool: string;
    claim_token: string;
    wait_ms: string | number;
    rk: string | number;
    priority: number;
    created_at: string;
  }>(
    `WITH cand AS (
       SELECT id, workflow_id, priority, scheduled_at, created_at FROM execution_queue
        WHERE status = 'pending' AND ${poolMatch} AND scheduled_at <= now()
        ORDER BY priority DESC, scheduled_at, created_at, id
        LIMIT $2
     ), ranked AS (
       SELECT id, priority, scheduled_at, created_at,
              row_number() OVER (PARTITION BY workflow_id ORDER BY priority DESC, scheduled_at, created_at, id) AS rk
         FROM cand
     ), picked AS (
       SELECT q.id, r.rk, gen_random_uuid()::text AS token FROM execution_queue q JOIN ranked r ON r.id = q.id
        WHERE q.status = 'pending'
        ORDER BY r.rk, r.priority DESC, r.scheduled_at, r.created_at, q.id
        LIMIT $3
        FOR UPDATE OF q SKIP LOCKED
     )
     UPDATE execution_queue AS q
        SET status = 'running', started_at = now(), heartbeat_at = now(), claimed_by = $4,
            claim_token = picked.token, updated_at = now(),
            -- This claim tracks side effects (the worker-loss policy): none started yet.
            effects_token = picked.token, effects_started = 0
       FROM picked
      WHERE q.id = picked.id
     RETURNING q.id, q.workflow_id, q.workflow_name, q.payload_json, q.attempts, q.max_attempts, q.scheduled_at, q.pool,
               q.claim_token, q.priority, q.created_at, picked.rk,
               GREATEST(0, EXTRACT(EPOCH FROM (now() - q.scheduled_at)) * 1000) AS wait_ms`,
    [input.pools.length === 1 ? input.pools[0] : input.pools, fairClaimWindow(limit), limit, input.owner]
  );
  // RETURNING has no order; give the claim order back.
  rows.sort((a, b) =>
    toNum(a.rk) - toNum(b.rk) ||
    toNum(b.priority) - toNum(a.priority) ||
    Date.parse(toStr(a.scheduled_at)) - Date.parse(toStr(b.scheduled_at)) ||
    Date.parse(toStr(a.created_at)) - Date.parse(toStr(b.created_at)) ||
    (toStr(a.id) < toStr(b.id) ? -1 : toStr(a.id) > toStr(b.id) ? 1 : 0)
  );
  return rows.map((row) => ({
    id: toStr(row.id),
    workflowId: toStr(row.workflow_id),
    workflowName: row.workflow_name ? toStr(row.workflow_name) : null,
    payload: parsePayload(row.payload_json),
    attempts: toNum(row.attempts),
    maxAttempts: toNum(row.max_attempts),
    scheduledAt: toStr(row.scheduled_at),
    pool: toStr(row.pool),
    claimToken: toStr(row.claim_token),
    waitMs: Math.round(Number(row.wait_ms) || 0)
  }));
}

export async function renewQueueLeases(ctx: PgContext, input: { owner: string; claimTokens: string[] }): Promise<string[]> {
  if (input.claimTokens.length === 0) return [];
  const rows = await ctx.query<{ claim_token: string }>(
    `UPDATE execution_queue SET heartbeat_at = now()
      WHERE status = 'running' AND claimed_by = $1 AND claim_token = ANY($2::text[])
      RETURNING claim_token`,
    [input.owner, input.claimTokens]
  );
  return rows.map((row) => toStr(row.claim_token));
}

export async function isQueueClaimHeld(ctx: PgContext, fence: QueueClaimFence): Promise<boolean> {
  const row = await ctx.queryOne<{ id: string }>(
    `SELECT id FROM execution_queue WHERE id = $1 AND claim_token = $2 AND status = 'running'`,
    [fence.queueItemId, fence.claimToken]
  );
  return Boolean(row);
}

export async function saveQueueItemResult(ctx: PgContext, input: { id: string; claimToken: string | null; result: unknown }): Promise<boolean> {
  const json = JSON.stringify(input.result ?? null);
  const result = input.claimToken !== null
    ? await ctx.pool.query(
        `UPDATE execution_queue SET result_json = $3, updated_at = now() WHERE id = $1 AND claim_token = $2 AND status = 'running'`,
        [input.id, input.claimToken, json]
      )
    : await ctx.pool.query(`UPDATE execution_queue SET result_json = $2, updated_at = now() WHERE id = $1`, [input.id, json]);
  return (result.rowCount ?? 0) > 0;
}

export async function releaseQueueItemResult(ctx: PgContext, id: string): Promise<void> {
  await ctx.pool.query(
    `UPDATE execution_queue SET result_json = NULL, payload_json = json_build_object('executionId', execution_id)::text
      WHERE id = $1 AND status = 'completed' AND (result_json IS NOT NULL OR payload_json LIKE '%"dispatch"%')`,
    [id]
  );
}

export async function getQueueItemOutcome(ctx: PgContext, id: string): Promise<QueueItemOutcome | null> {
  const row = await ctx.queryOne<{ status: string; result_json: string | null; last_error: string | null; attempts: number }>(
    `SELECT status, result_json, last_error, attempts FROM execution_queue WHERE id = $1`,
    [id]
  );
  if (!row) return null;
  return {
    status: toStr(row.status),
    result: parseStoredResult(row.result_json),
    lastError: row.last_error === null || row.last_error === undefined ? null : toStr(row.last_error),
    attempts: toNum(row.attempts)
  };
}

function parseStoredResult(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(toStr(raw));
  } catch {
    return null;
  }
}

export async function recordQueueJobProgress(ctx: PgContext, fence: QueueClaimFence): Promise<boolean> {
  const result = await ctx.pool.query(
    `UPDATE execution_queue SET nodes_completed = nodes_completed + 1 WHERE id = $1 AND claim_token = $2 AND status = 'running'`,
    [fence.queueItemId, fence.claimToken]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function markQueueEffectsStarted(ctx: PgContext, fence: QueueClaimFence): Promise<boolean> {
  const result = await ctx.query<{ id: string }>(
    `UPDATE execution_queue SET effects_started = 1
      WHERE id = $1 AND claim_token = $2 AND status = 'running'
      RETURNING id`,
    [fence.queueItemId, fence.claimToken]
  );
  return result.length > 0;
}

export async function listCanceledExecutionIds(ctx: PgContext, executionIds: readonly string[]): Promise<string[]> {
  if (executionIds.length === 0) return [];
  const rows = await ctx.query<{ id: string }>(
    `SELECT id FROM execution_history WHERE id = ANY($1::text[]) AND status = 'canceled'`,
    [[...executionIds]]
  );
  return rows.map((row) => toStr(row.id));
}

interface LockedQueueRow {
  id: string;
  workflow_id: string;
  workflow_name: string | null;
  payload_json: string;
  attempts: number;
  max_attempts: number;
  nodes_completed: number;
  claim_token: string | null;
  effects_token: string | null;
  effects_started: number;
}

const LOCKED_QUEUE_COLUMNS =
  "id, workflow_id, workflow_name, payload_json, attempts, max_attempts, nodes_completed, claim_token, effects_token, effects_started";

/**
 * Settles one locked running item by the worker-loss policy. The caller holds the item's row lock; the run's history
 * row (and, for an approval resume, its paused state) is locked here: queue row, then history row, then paused state,
 * the order fenced writes take them too.
 */
async function settleLostJob(
  client: PoolClient,
  row: LockedQueueRow,
  countsAttempt: boolean,
  reasons: LostJobReasons
): Promise<LostJobOutcome> {
  const id = toStr(row.id);
  const executionId = payloadExecutionId(row.payload_json, id);
  const attempts = toNum(row.attempts) + (countsAttempt ? 1 : 0);
  const history = (await client.query<{ status: string; completed_at: unknown; node_results_json: string | null }>(
    `SELECT status, completed_at, node_results_json FROM execution_history WHERE id = $1 FOR UPDATE`,
    [executionId]
  )).rows[0];
  const resume = payloadIsResume(row.payload_json);
  const pausedState = resume
    ? (await client.query<{ status: string }>(`SELECT status FROM workflow_executions WHERE id = $1 FOR UPDATE`, [executionId])).rows[0]
    : undefined;
  const decision = decideLostJob({
    attempts,
    maxAttempts: toNum(row.max_attempts),
    countsAttempt,
    resume,
    resumeStateStatus: pausedState ? toStr(pausedState.status) : null,
    resumeNodesCompleted: toNum(row.nodes_completed),
    history: history ? { status: toStr(history.status), completedAt: history.completed_at, nodeResultsJson: history.node_results_json } : null,
    effects: lostJobEffects(row)
  });
  const lost = countsAttempt ? 1 : 0;
  if (decision === "finished") {
    await client.query(
      `UPDATE execution_queue SET status = 'completed', completed_at = now(), updated_at = now(), heartbeat_at = NULL,
              attempts = $2, lost_count = lost_count + $3
        WHERE id = $1`,
      [id, attempts, lost]
    );
  } else if (decision === "requeue") {
    await client.query(
      `UPDATE execution_queue SET status = 'pending', claimed_by = NULL, claim_token = NULL, started_at = NULL, heartbeat_at = NULL,
              attempts = $2, lost_count = lost_count + $3, scheduled_at = now(), updated_at = now()
        WHERE id = $1`,
      [id, attempts, lost]
    );
  } else {
    const reason = decision === "interrupt" ? reasons.interrupted : reasons.exhausted;
    // The run's record says why it stopped; only a record still running (or, for a resume, still reading as the
    // pause) is changed: a cancel or a final write stays.
    await client.query(
      `UPDATE execution_history
          SET status = 'error', error = $2, completed_at = now(),
              duration_ms = GREATEST(0, (EXTRACT(EPOCH FROM (now() - started_at::timestamptz)) * 1000)::bigint)
        WHERE id = $1 AND status = ANY($3::text[])`,
      [executionId, reason, resume ? ["running", "waiting_approval"] : ["running"]]
    );
    // The record is final now, so approval recovery never drives the run on again: the dead-letter entry is its one
    // way forward (a manual retry). An interrupted resume also loses its paused state, for a lost worker and a shutdown release alike.
    if (resume) await client.query(`DELETE FROM workflow_executions WHERE id = $1 AND status = 'resuming'`, [executionId]);
    await client.query(
      `INSERT INTO execution_queue_dlq (id, original_id, workflow_id, workflow_name, payload_json, attempts, final_error, failed_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())`,
      [randomUUID(), id, toStr(row.workflow_id), row.workflow_name ? toStr(row.workflow_name) : null, toStr(row.payload_json), attempts, reason]
    );
    await client.query(
      `UPDATE execution_queue SET status = 'dead', last_error = $2, attempts = $3, lost_count = lost_count + $4,
              heartbeat_at = NULL, updated_at = now()
        WHERE id = $1`,
      [id, reason, attempts, lost]
    );
  }
  return { id, workflowId: toStr(row.workflow_id), executionId, decision, attempts };
}

export async function reapExpiredQueueLeases(ctx: PgContext, input: { leaseMs: number; limit?: number }): Promise<LostJobOutcome[]> {
  return await ctx.withTransaction(async (client) => {
    const rows = (await client.query<LockedQueueRow>(
      `SELECT ${LOCKED_QUEUE_COLUMNS} FROM execution_queue
        WHERE status = 'running' AND heartbeat_at IS NOT NULL
          AND heartbeat_at < now() - make_interval(secs => $1::double precision / 1000)
        ORDER BY heartbeat_at, id COLLATE "C"
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [input.leaseMs, Math.max(1, Math.min(1_000, input.limit ?? 100))]
    )).rows;
    const outcomes: LostJobOutcome[] = [];
    for (const row of rows) {
      outcomes.push(await settleLostJob(client, row, true, WORKER_LOST_REASONS));
    }
    return outcomes;
  });
}

export async function releaseQueueItem(ctx: PgContext, input: { id: string; claimToken: string | null }): Promise<LostJobOutcome | null> {
  return await ctx.withTransaction(async (client) => {
    const row = (await client.query<LockedQueueRow>(
      `SELECT ${LOCKED_QUEUE_COLUMNS} FROM execution_queue
        WHERE id = $1 AND status = 'running' AND ($2::text IS NULL OR claim_token = $2)
        FOR UPDATE`,
      [input.id, input.claimToken]
    )).rows[0];
    if (!row) return null;
    return await settleLostJob(client, row, false, WORKER_SHUTDOWN_REASONS);
  });
}

export async function getQueueDepthByPool(ctx: PgContext): Promise<Array<{ pool: string; pending: number; running: number }>> {
  const rows = await ctx.query<{ pool: string; status: string; count: string }>(
    `SELECT pool, status, COUNT(*) AS count FROM execution_queue WHERE status IN ('pending', 'running') GROUP BY pool, status`
  );
  const byPool = new Map<string, { pool: string; pending: number; running: number }>();
  for (const row of rows) {
    const pool = toStr(row.pool);
    const entry = byPool.get(pool) ?? { pool, pending: 0, running: 0 };
    if (toStr(row.status) === "pending") entry.pending = toNum(row.count);
    else entry.running = toNum(row.count);
    byPool.set(pool, entry);
  }
  return [...byPool.values()].sort((a, b) => (a.pool < b.pool ? -1 : a.pool > b.pool ? 1 : 0));
}

export async function countPendingQueueItems(ctx: PgContext, pool: string): Promise<number> {
  const row = await ctx.queryOne<{ count: string }>(
    `SELECT COUNT(*) AS count FROM execution_queue WHERE status = 'pending' AND pool = $1`,
    [pool]
  );
  return row ? toNum(row.count) : 0;
}
