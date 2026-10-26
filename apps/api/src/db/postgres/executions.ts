/**
 * Phase 13.1 — PostgresStore: Execution history, workflow execution state, runs, cancellation and paused-run claims.
 * Plain functions over a PgContext; PostgresStore delegates here. Methods that are not implemented yet throw
 * StoreNotImplementedError and are listed in UNIMPLEMENTED_METHODS (remove both together when implementing one).
 */
import { StoreNotImplementedError } from "../store-errors.js";
import { type CancelExecutionResult, type Store } from "../store.js";
import { parseJsonSafe, toNum, toStr } from "./helpers.js";
import type { PgContext } from "./context.js";

export const UNIMPLEMENTED_METHODS: readonly (keyof Store)[] = [
  "claimWorkflowExecutionForResume",
  "listResumingWorkflowExecutionIds",
  "listResumingWorkflowExecutions",
  "releaseWorkflowExecutionClaim"
];

export async function saveExecutionHistory(ctx: PgContext, input: {
  id: string;
  workflowId: string;
  workflowName?: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  triggerType?: string;
  triggeredBy?: string;
  inputJson?: unknown;
  outputJson?: unknown;
  nodeResultsJson?: unknown;
  customData?: unknown;
  error?: string;
}, options?: { unlessFinished?: boolean; unlessCanceled?: boolean }): Promise<boolean> {
  const guard = options?.unlessFinished
    ? `
       WHERE NOT (execution_history.status IN ('success', 'error', 'canceled') OR (execution_history.status = 'partial' AND execution_history.completed_at IS NOT NULL))`
    : options?.unlessCanceled
      ? `
       WHERE execution_history.status <> 'canceled' OR EXCLUDED.status = 'canceled'`
      : "";
  const result = await ctx.pool.query(
    `INSERT INTO execution_history (id, workflow_id, workflow_name, status, started_at, completed_at, duration_ms, trigger_type, triggered_by, input_json, output_json, node_results_json, custom_data_json, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (id) DO UPDATE SET
         workflow_id = EXCLUDED.workflow_id,
         workflow_name = EXCLUDED.workflow_name,
         status = EXCLUDED.status,
         started_at = EXCLUDED.started_at,
         completed_at = EXCLUDED.completed_at,
         duration_ms = EXCLUDED.duration_ms,
         trigger_type = EXCLUDED.trigger_type,
         triggered_by = EXCLUDED.triggered_by,
         input_json = EXCLUDED.input_json,
         output_json = EXCLUDED.output_json,
         node_results_json = EXCLUDED.node_results_json,
         custom_data_json = EXCLUDED.custom_data_json,
         error = EXCLUDED.error${guard}`,
    [
      input.id,
      input.workflowId,
      input.workflowName ?? null,
      input.status,
      input.startedAt,
      input.completedAt ?? null,
      typeof input.durationMs === "number" ? Math.floor(input.durationMs) : null,
      input.triggerType ?? null,
      input.triggeredBy ?? null,
      input.inputJson === undefined ? null : JSON.stringify(input.inputJson),
      input.outputJson === undefined ? null : JSON.stringify(input.outputJson),
      input.nodeResultsJson === undefined ? null : JSON.stringify(input.nodeResultsJson),
      input.customData === undefined ? null : JSON.stringify(input.customData),
      input.error ?? null
    ]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function listExecutionHistory(ctx: PgContext, input: {
  page?: number;
  pageSize?: number;
  status?: string;
  workflowId?: string;
  workflowIds?: string[];
  triggerType?: string;
  startedFrom?: string;
  startedTo?: string;
}): Promise<{
  total: number;
  page: number;
  pageSize: number;
  items: Array<{
    id: string;
    workflowId: string;
    workflowName: string | null;
    status: string;
    startedAt: string;
    completedAt: string | null;
    durationMs: number | null;
    triggerType: string | null;
    triggeredBy: string | null;
    customData: unknown;
    error: string | null;
    createdAt: string;
  }>;
}> {
  const page = Math.max(1, Math.floor(input.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(input.pageSize ?? 20)));
  const offset = (page - 1) * pageSize;

  const whereParts: string[] = [];
  const whereParams: unknown[] = [];
  let paramIdx = 1;

  if (input.status) {
    whereParts.push(`status = $${paramIdx++}`);
    whereParams.push(input.status);
  }
  if (input.workflowId) {
    whereParts.push(`workflow_id = $${paramIdx++}`);
    whereParams.push(input.workflowId);
  }
  if (input.workflowIds) {
    if (input.workflowIds.length === 0) {
      whereParts.push("1 = 0");
    } else {
      whereParts.push(`workflow_id IN (${input.workflowIds.map(() => `$${paramIdx++}`).join(", ")})`);
      whereParams.push(...input.workflowIds);
    }
  }
  if (input.triggerType) {
    whereParts.push(`trigger_type = $${paramIdx++}`);
    whereParams.push(input.triggerType);
  }
  if (input.startedFrom) {
    whereParts.push(`started_at >= $${paramIdx++}`);
    whereParams.push(input.startedFrom);
  }
  if (input.startedTo) {
    whereParts.push(`started_at <= $${paramIdx++}`);
    whereParams.push(input.startedTo);
  }

  const whereClause = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";
  const countRow = await ctx.queryOne<{ count: string }>(
    `SELECT COUNT(*) as count FROM execution_history ${whereClause}`,
    whereParams
  );
  const total = countRow ? toNum(countRow.count) : 0;

  const rows = await ctx.query<{
    id: string;
    workflow_id: string;
    workflow_name: string | null;
    status: string;
    started_at: string;
    completed_at: string | null;
    duration_ms: number | null;
    trigger_type: string | null;
    triggered_by: string | null;
    custom_data_json: string | null;
    error: string | null;
    created_at: string;
  }>(
    `SELECT id, workflow_id, workflow_name, status, started_at, completed_at, duration_ms, trigger_type, triggered_by, custom_data_json, error, created_at
       FROM execution_history
       ${whereClause}
       ORDER BY started_at DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
    [...whereParams, pageSize, offset]
  );

  return {
    total,
    page,
    pageSize,
    items: rows.map((row) => ({
      id: toStr(row.id),
      workflowId: toStr(row.workflow_id),
      workflowName: row.workflow_name ? toStr(row.workflow_name) : null,
      status: toStr(row.status),
      startedAt: toStr(row.started_at),
      completedAt: row.completed_at ? toStr(row.completed_at) : null,
      durationMs: row.duration_ms === null ? null : toNum(row.duration_ms),
      triggerType: row.trigger_type ? toStr(row.trigger_type) : null,
      triggeredBy: row.triggered_by ? toStr(row.triggered_by) : null,
      customData: parseJsonSafe(row.custom_data_json),
      error: row.error ? toStr(row.error) : null,
      createdAt: toStr(row.created_at)
    }))
  };
}

export async function getExecutionHistory(ctx: PgContext, id: string): Promise<{
  id: string;
  workflowId: string;
  workflowName: string | null;
  status: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  triggerType: string | null;
  triggeredBy: string | null;
  input: unknown;
  output: unknown;
  nodeResults: unknown;
  customData: unknown;
  error: string | null;
  createdAt: string;
} | null> {
  const row = await ctx.queryOne<{
    id: string;
    workflow_id: string;
    workflow_name: string | null;
    status: string;
    started_at: string;
    completed_at: string | null;
    duration_ms: number | null;
    trigger_type: string | null;
    triggered_by: string | null;
    input_json: string | null;
    output_json: string | null;
    node_results_json: string | null;
    custom_data_json: string | null;
    error: string | null;
    created_at: string;
  }>(
    `SELECT id, workflow_id, workflow_name, status, started_at, completed_at, duration_ms, trigger_type, triggered_by, input_json, output_json, node_results_json, custom_data_json, error, created_at
       FROM execution_history WHERE id = $1`,
    [id]
  );
  if (!row) return null;
  return {
    id: toStr(row.id),
    workflowId: toStr(row.workflow_id),
    workflowName: row.workflow_name ? toStr(row.workflow_name) : null,
    status: toStr(row.status),
    startedAt: toStr(row.started_at),
    completedAt: row.completed_at ? toStr(row.completed_at) : null,
    durationMs: row.duration_ms === null ? null : toNum(row.duration_ms),
    triggerType: row.trigger_type ? toStr(row.trigger_type) : null,
    triggeredBy: row.triggered_by ? toStr(row.triggered_by) : null,
    input: parseJsonSafe(row.input_json),
    output: parseJsonSafe(row.output_json),
    nodeResults: parseJsonSafe(row.node_results_json),
    customData: parseJsonSafe(row.custom_data_json),
    error: row.error ? toStr(row.error) : null,
    createdAt: toStr(row.created_at)
  };
}

export async function cancelExecution(ctx: PgContext, input: {
  id: string;
  onlyFrom: readonly string[];
  completedAt?: string;
  error?: string;
  deletePausedState?: boolean;
  cancelClaimed?: boolean;
}): Promise<CancelExecutionResult> {
  const client = await ctx.pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query(`SELECT status, started_at, completed_at FROM execution_history WHERE id = $1 FOR UPDATE`, [input.id]);
    const existing = found.rows[0] as { status: string; started_at: unknown; completed_at: unknown } | undefined;
    const refuse = (outcome: CancelExecutionResult["outcome"]): CancelExecutionResult => ({ outcome, canceledRequestIds: [] });
    const result = await (async (): Promise<CancelExecutionResult> => {
      if (!existing) return refuse("missing");
      const open = existing.status !== "partial" || !existing.completed_at;
      if (!input.onlyFrom.includes(existing.status) || !open) return refuse("not_cancelable");
      if (input.deletePausedState) {
        const paused = await client.query(`SELECT status FROM workflow_executions WHERE id = $1 FOR UPDATE`, [input.id]);
        const pausedStatus = (paused.rows[0] as { status: string } | undefined)?.status;
        if (pausedStatus !== undefined && pausedStatus !== "waiting_approval" && !input.cancelClaimed) return refuse("decided");
        if (pausedStatus !== undefined) await client.query(`DELETE FROM workflow_executions WHERE id = $1`, [input.id]);
      }
      const completedAt = input.completedAt ?? new Date().toISOString();
      const canceledRequestIds: string[] = [];
      if (input.deletePausedState) {
        const canceled = await client.query(
          `UPDATE approval_requests SET status = 'canceled', reason = $1, decided_at = $2, updated_at = $2 WHERE execution_id = $3 AND status = 'pending' RETURNING id`,
          [input.error ?? "Execution canceled", completedAt, input.id]
        );
        for (const row of canceled.rows as Array<{ id: unknown }>) canceledRequestIds.push(toStr(row.id));
      }
      const started = Date.parse(toStr(existing.started_at));
      const completed = Date.parse(completedAt);
      const durationMs = Number.isFinite(started) && Number.isFinite(completed) ? Math.max(0, Math.floor(completed - started)) : null;
      await client.query(
        `UPDATE execution_history SET status = 'canceled', completed_at = $1, duration_ms = $2, error = $3 WHERE id = $4`,
        [completedAt, durationMs, input.error ?? "Execution canceled", input.id]
      );
      return { outcome: "canceled", canceledRequestIds };
    })();
    await client.query(result.outcome === "canceled" ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function pruneExecutionHistory(ctx: PgContext, input: { before: string }): Promise<number> {
  const result = await ctx.pool.query(
    `DELETE FROM execution_history WHERE started_at < $1`,
    [input.before]
  );
  // Phase 10.1 — tool-call telemetry follows the execution-history retention.
  await ctx.pool.query(`DELETE FROM mcp_tool_calls WHERE started_at < $1`, [input.before]);
  return result.rowCount ?? 0;
}

export async function saveWorkflowExecutionState(ctx: PgContext, input: {
  id: string;
  workflowId: string;
  workflowName?: string;
  status: string;
  waitingNodeId: string;
  approvalMessage?: string;
  timeoutMinutes?: number;
  triggerType?: string;
  triggeredBy?: string;
  startedAt: string;
  state: unknown;
}): Promise<void> {
  const now = new Date().toISOString();
  await ctx.execute(
    `INSERT INTO workflow_executions (id, workflow_id, workflow_name, status, waiting_node_id, approval_message, timeout_minutes, trigger_type, triggered_by, started_at, state_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (id) DO UPDATE SET
         workflow_id = EXCLUDED.workflow_id,
         workflow_name = EXCLUDED.workflow_name,
         status = EXCLUDED.status,
         waiting_node_id = EXCLUDED.waiting_node_id,
         approval_message = EXCLUDED.approval_message,
         timeout_minutes = EXCLUDED.timeout_minutes,
         trigger_type = EXCLUDED.trigger_type,
         triggered_by = EXCLUDED.triggered_by,
         started_at = EXCLUDED.started_at,
         state_json = EXCLUDED.state_json,
         updated_at = EXCLUDED.updated_at`,
    [
      input.id,
      input.workflowId,
      input.workflowName ?? null,
      input.status,
      input.waitingNodeId,
      input.approvalMessage ?? null,
      typeof input.timeoutMinutes === "number" ? Math.floor(input.timeoutMinutes) : null,
      input.triggerType ?? null,
      input.triggeredBy ?? null,
      input.startedAt,
      JSON.stringify(input.state),
      now,
      now
    ]
  );
}

export async function getWorkflowExecutionState(ctx: PgContext, id: string): Promise<{
  id: string;
  workflowId: string;
  workflowName: string | null;
  status: string;
  waitingNodeId: string;
  approvalMessage: string | null;
  timeoutMinutes: number | null;
  triggerType: string | null;
  triggeredBy: string | null;
  startedAt: string;
  state: unknown;
  createdAt: string;
  updatedAt: string;
} | null> {
  const row = await ctx.queryOne<{
    id: string;
    workflow_id: string;
    workflow_name: string | null;
    status: string;
    waiting_node_id: string;
    approval_message: string | null;
    timeout_minutes: number | null;
    trigger_type: string | null;
    triggered_by: string | null;
    started_at: string;
    state_json: string;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, workflow_id, workflow_name, status, waiting_node_id, approval_message, timeout_minutes, trigger_type, triggered_by, started_at, state_json, created_at, updated_at
       FROM workflow_executions WHERE id = $1`,
    [id]
  );
  if (!row) return null;
  let state: unknown = null;
  try { state = JSON.parse(toStr(row.state_json)); } catch { state = null; }
  return {
    id: toStr(row.id),
    workflowId: toStr(row.workflow_id),
    workflowName: row.workflow_name ? toStr(row.workflow_name) : null,
    status: toStr(row.status),
    waitingNodeId: toStr(row.waiting_node_id),
    approvalMessage: row.approval_message ? toStr(row.approval_message) : null,
    timeoutMinutes: row.timeout_minutes === null ? null : toNum(row.timeout_minutes),
    triggerType: row.trigger_type ? toStr(row.trigger_type) : null,
    triggeredBy: row.triggered_by ? toStr(row.triggered_by) : null,
    startedAt: toStr(row.started_at),
    state,
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at)
  };
}

export async function listPendingApprovals(ctx: PgContext): Promise<Array<{
  id: string;
  workflowId: string;
  workflowName: string | null;
  waitingNodeId: string;
  approvalMessage: string | null;
  timeoutMinutes: number | null;
  triggerType: string | null;
  triggeredBy: string | null;
  startedAt: string;
  createdAt: string;
  updatedAt: string;
}>> {
  const rows = await ctx.query<{
    id: string;
    workflow_id: string;
    workflow_name: string | null;
    waiting_node_id: string;
    approval_message: string | null;
    timeout_minutes: number | null;
    trigger_type: string | null;
    triggered_by: string | null;
    started_at: string;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, workflow_id, workflow_name, waiting_node_id, approval_message, timeout_minutes, trigger_type, triggered_by, started_at, created_at, updated_at
       FROM workflow_executions
       WHERE status = 'waiting_approval'
       ORDER BY created_at DESC`
  );
  return rows.map((row) => ({
    id: toStr(row.id),
    workflowId: toStr(row.workflow_id),
    workflowName: row.workflow_name ? toStr(row.workflow_name) : null,
    waitingNodeId: toStr(row.waiting_node_id),
    approvalMessage: row.approval_message ? toStr(row.approval_message) : null,
    timeoutMinutes: row.timeout_minutes === null ? null : toNum(row.timeout_minutes),
    triggerType: row.trigger_type ? toStr(row.trigger_type) : null,
    triggeredBy: row.triggered_by ? toStr(row.triggered_by) : null,
    startedAt: toStr(row.started_at),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at)
  }));
}

export async function deleteWorkflowExecution(ctx: PgContext, id: string): Promise<boolean> {
  const result = await ctx.pool.query(`DELETE FROM workflow_executions WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function claimWorkflowExecutionForResume(_ctx: PgContext, ..._args: Parameters<Store["claimWorkflowExecutionForResume"]>): ReturnType<Store["claimWorkflowExecutionForResume"]> {
  throw new StoreNotImplementedError("claimWorkflowExecutionForResume");
}

export async function listResumingWorkflowExecutionIds(_ctx: PgContext, ..._args: Parameters<Store["listResumingWorkflowExecutionIds"]>): ReturnType<Store["listResumingWorkflowExecutionIds"]> {
  throw new StoreNotImplementedError("listResumingWorkflowExecutionIds");
}

export async function listResumingWorkflowExecutions(_ctx: PgContext, ..._args: Parameters<Store["listResumingWorkflowExecutions"]>): ReturnType<Store["listResumingWorkflowExecutions"]> {
  throw new StoreNotImplementedError("listResumingWorkflowExecutions");
}

export async function releaseWorkflowExecutionClaim(_ctx: PgContext, ..._args: Parameters<Store["releaseWorkflowExecutionClaim"]>): ReturnType<Store["releaseWorkflowExecutionClaim"]> {
  throw new StoreNotImplementedError("releaseWorkflowExecutionClaim");
}
