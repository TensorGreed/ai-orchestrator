/**
 * Phase 13.1 — PostgresStore: Approval requests (Phase 11.2) and the paused-run claim that goes with a decision.
 * Plain functions over a PgContext; PostgresStore delegates here.
 *
 * A decision is applied once: every decide/reopen/cancel is a conditional UPDATE on the request's status, and its
 * rowCount says whether it applied. The claim-and-decide and release-and-reopen pairs run in one transaction.
 */
import type { PoolClient } from "pg";
import type {
  ApprovalRequestKind,
  ApprovalRequestSpec,
  ApprovalStatus,
  PendingApprovalInfo
} from "@ai-orchestrator/shared";
import type { ApprovalReadScope, ApprovalRequestInsert, ApprovalRequestRecord } from "../database.js";
import type { ApprovalDecisionInput, QueueClaimFence, Store } from "../store.js";
import { QueueClaimLostError } from "../queue-leases.js";
import { claimExecutionForResumeOn, releaseExecutionClaimOn, withQueueClaim } from "./executions.js";
import { parseJsonSafe, toNum, toStr } from "./helpers.js";
import type { PgContext } from "./context.js";

type Queryable = Pick<PoolClient, "query">;

interface ApprovalRequestRow {
  id: string;
  execution_id: string;
  workflow_id: string;
  workflow_name: string | null;
  project_id: string;
  node_id: string;
  node_type: string | null;
  kind: string;
  status: string;
  message: string | null;
  spec_json: string;
  path_json: string | null;
  details_json: string | null;
  requested_by_user_id: string | null;
  requested_by: string | null;
  timeout_minutes: number | null;
  expires_at: string | null;
  decided_by_user_id: string | null;
  decided_by: string | null;
  decided_at: string | null;
  reason: string | null;
  edits_json: string | null;
  edited_fields_json: string | null;
  asking_workflow_id: string | null;
  edits_salt: string | null;
  workflow_deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

const nullableText = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

function parseStringArray(raw: string | null): string[] {
  const parsed = parseJsonSafe(raw);
  return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
}

function mapApprovalRequestRow(row: ApprovalRequestRow): ApprovalRequestRecord {
  const spec = parseJsonSafe(row.spec_json);
  const path = parseJsonSafe(row.path_json);
  const details = row.details_json ? parseJsonSafe(row.details_json) : null;
  const edits = row.edits_json ? parseJsonSafe(row.edits_json) : null;
  return {
    id: toStr(row.id),
    executionId: toStr(row.execution_id),
    workflowId: toStr(row.workflow_id),
    workflowName: nullableText(row.workflow_name),
    projectId: toStr(row.project_id),
    nodeId: toStr(row.node_id),
    nodeType: nullableText(row.node_type),
    kind: toStr(row.kind) as ApprovalRequestKind,
    status: toStr(row.status) as ApprovalStatus,
    message: nullableText(row.message),
    spec: (spec && typeof spec === "object" ? spec : {}) as ApprovalRequestSpec,
    path: Array.isArray(path) ? (path as PendingApprovalInfo["path"]) : [],
    details: details && typeof details === "object" && !Array.isArray(details) ? (details as Record<string, unknown>) : null,
    requestedByUserId: nullableText(row.requested_by_user_id),
    requestedBy: nullableText(row.requested_by),
    timeoutMinutes: row.timeout_minutes === null || row.timeout_minutes === undefined ? null : toNum(row.timeout_minutes),
    expiresAt: nullableText(row.expires_at),
    decidedByUserId: nullableText(row.decided_by_user_id),
    decidedBy: nullableText(row.decided_by),
    decidedAt: nullableText(row.decided_at),
    reason: nullableText(row.reason),
    edits: edits && typeof edits === "object" && !Array.isArray(edits) ? (edits as Record<string, unknown>) : null,
    editedFields: parseStringArray(row.edited_fields_json),
    askingWorkflowId: nullableText(row.asking_workflow_id),
    editsSalt: nullableText(row.edits_salt),
    workflowDeletedAt: nullableText(row.workflow_deleted_at),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at)
  };
}

export async function insertApprovalRequest(ctx: PgContext, input: ApprovalRequestInsert, options: { fence?: QueueClaimFence } = {}): Promise<ApprovalRequestRecord> {
  const now = input.createdAt ?? new Date().toISOString();
  const insert = async (db: Queryable) => (await db.query<ApprovalRequestRow>(
    `INSERT INTO approval_requests (
       id, execution_id, workflow_id, workflow_name, project_id, node_id, node_type, kind, status, message,
       spec_json, path_json, details_json, requested_by_user_id, requested_by, timeout_minutes, expires_at,
       asking_workflow_id, edits_salt, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
     RETURNING *`,
    [
      input.id,
      input.executionId,
      input.workflowId,
      input.workflowName ?? null,
      input.projectId,
      input.nodeId,
      input.nodeType ?? null,
      input.kind,
      input.message ?? null,
      JSON.stringify(input.spec),
      JSON.stringify(input.path ?? []),
      input.details ? JSON.stringify(input.details) : null,
      input.requestedByUserId ?? null,
      input.requestedBy ?? null,
      typeof input.timeoutMinutes === "number" ? Math.floor(input.timeoutMinutes) : null,
      input.expiresAt ?? null,
      input.askingWorkflowId ?? null,
      input.editsSalt ?? null,
      now,
      now
    ]
  )).rows[0]!;
  if (!options.fence) return mapApprovalRequestRow(await insert(ctx.pool));
  // Phase 13.1 — a queued run in cluster mode asks for approval only while its claim still holds the queue item.
  const row = await withQueueClaim(ctx, options.fence, insert);
  if (!row) throw new QueueClaimLostError("an approval request");
  return mapApprovalRequestRow(row);
}

export async function getApprovalRequest(ctx: PgContext, id: string): Promise<ApprovalRequestRecord | null> {
  const row = await ctx.queryOne<ApprovalRequestRow>(`SELECT * FROM approval_requests WHERE id = $1`, [id]);
  return row ? mapApprovalRequestRow(row) : null;
}

/** The newest pending request of a paused run. */
export async function getPendingApprovalRequestForExecution(ctx: PgContext, executionId: string): Promise<ApprovalRequestRecord | null> {
  const row = await ctx.queryOne<ApprovalRequestRow>(
    `SELECT * FROM approval_requests WHERE execution_id = $1 AND status = 'pending' ORDER BY created_at DESC, id COLLATE "C" DESC LIMIT 1`,
    [executionId]
  );
  return row ? mapApprovalRequestRow(row) : null;
}

export async function listApprovalRequestsForExecution(ctx: PgContext, executionId: string): Promise<ApprovalRequestRecord[]> {
  const rows = await ctx.query<ApprovalRequestRow>(
    `SELECT * FROM approval_requests WHERE execution_id = $1 ORDER BY created_at ASC, id COLLATE "C" ASC`,
    [executionId]
  );
  return rows.map(mapApprovalRequestRow);
}

export async function listApprovalRequests(ctx: PgContext, filter: {
  status: "pending" | "decided" | "all";
  workflowId?: string;
  executionId?: string;
  limit?: number;
  scope?: ApprovalReadScope;
}): Promise<ApprovalRequestRecord[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  // Filtered before the limit, so other projects' requests never crowd out the user's own.
  if (filter.scope && !filter.scope.all) {
    // By workflow, not the stored project_id: a workflow moved to another project takes its requests with it.
    const { workflowIds } = filter.scope;
    if (workflowIds.length === 0) return [];
    params.push(workflowIds);
    clauses.push(`workflow_id = ANY($${params.length}::text[])`);
    // A deleted workflow's requests stay admin-only, also when a new workflow reuses its id.
    clauses.push(`workflow_deleted_at IS NULL`);
  }
  if (filter.status === "pending") clauses.push(`status = 'pending'`);
  if (filter.status === "decided") clauses.push(`status <> 'pending'`);
  if (filter.workflowId) {
    params.push(filter.workflowId);
    clauses.push(`workflow_id = $${params.length}`);
  }
  if (filter.executionId) {
    params.push(filter.executionId);
    clauses.push(`execution_id = $${params.length}`);
  }
  const limit = Math.max(1, Math.min(1_000, Math.floor(filter.limit ?? 200)));
  const order = filter.status === "decided" ? "COALESCE(decided_at, updated_at) DESC" : "created_at DESC";
  params.push(limit);
  const rows = await ctx.query<ApprovalRequestRow>(
    `SELECT * FROM approval_requests ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY ${order}, id COLLATE "C" DESC LIMIT $${params.length}`,
    params
  );
  return rows.map(mapApprovalRequestRow);
}

/** Pending requests past their expiry, oldest first. */
export async function listExpiredApprovalRequests(ctx: PgContext, now: string, limit = 100): Promise<ApprovalRequestRecord[]> {
  const rows = await ctx.query<ApprovalRequestRow>(
    `SELECT * FROM approval_requests WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= $1
      ORDER BY expires_at ASC, created_at ASC, id COLLATE "C" LIMIT $2`,
    [now, Math.max(1, Math.floor(limit))]
  );
  return rows.map(mapApprovalRequestRow);
}

async function decideOn(db: Queryable, input: ApprovalDecisionInput): Promise<boolean> {
  const decidedAt = input.decidedAt ?? new Date().toISOString();
  const result = await db.query(
    `UPDATE approval_requests
        SET status = $1, decided_by_user_id = $2, decided_by = $3, decided_at = $4, reason = $5, edits_json = $6, edited_fields_json = $7, updated_at = $4
      WHERE id = $8 AND status = 'pending'`,
    [
      input.status,
      input.decidedByUserId ?? null,
      input.decidedBy ?? null,
      decidedAt,
      input.reason ?? null,
      input.edits ? JSON.stringify(input.edits) : null,
      JSON.stringify(input.editedFields ?? []),
      input.id
    ]
  );
  return (result.rowCount ?? 0) > 0;
}

async function reopenOn(db: Queryable, id: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE approval_requests
        SET status = 'pending', decided_by_user_id = NULL, decided_by = NULL, decided_at = NULL, reason = NULL,
            edits_json = NULL, edited_fields_json = NULL, updated_at = $1
      WHERE id = $2 AND status IN ('approved', 'rejected', 'timed_out')`,
    [new Date().toISOString(), id]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Records a decision once: false when the request was no longer pending. */
export async function decideApprovalRequest(ctx: PgContext, input: ApprovalDecisionInput): Promise<boolean> {
  return decideOn(ctx.pool, input);
}

/** Puts a decided request back to pending (its resume could not run). False when it was not in a decided state. */
export async function reopenApprovalRequest(ctx: PgContext, id: string): Promise<boolean> {
  return reopenOn(ctx.pool, id);
}

/** Cancels every pending request of a run (the run was canceled or its workflow deleted). */
export async function cancelPendingApprovalRequests(ctx: PgContext, filter: { executionId?: string; workflowId?: string }, reason: string): Promise<number> {
  const column = filter.executionId ? "execution_id" : "workflow_id";
  const value = filter.executionId ?? filter.workflowId;
  if (!value) return 0;
  const now = new Date().toISOString();
  const result = await ctx.pool.query(
    `UPDATE approval_requests SET status = 'canceled', reason = $1, decided_at = $2, updated_at = $2 WHERE ${column} = $3 AND status = 'pending'`,
    [reason, now, value]
  );
  return result.rowCount ?? 0;
}

class DecisionLost extends Error {}

/**
 * Claims the paused run and records the decision in one transaction. False (and nothing changed) when the run was
 * not waiting or the request was no longer pending: a lost decision rolls the claim back.
 */
export async function claimExecutionAndDecideApproval(ctx: PgContext, executionId: string, decision: ApprovalDecisionInput): Promise<boolean> {
  try {
    return await ctx.withTransaction(async (client) => {
      if (!(await claimExecutionForResumeOn(client, executionId))) return false;
      if (!(await decideOn(client, decision))) throw new DecisionLost();
      return true;
    });
  } catch (error) {
    if (error instanceof DecisionLost) return false;
    throw error;
  }
}

/** Hands a claimed run back and reopens its request, together. False when the run was not claimed. */
export async function releaseExecutionClaimAndReopenApproval(ctx: PgContext, executionId: string, requestId: string): Promise<boolean> {
  return ctx.withTransaction(async (client) => {
    if (!(await releaseExecutionClaimOn(client, executionId))) return false;
    await reopenOn(client, requestId);
    return true;
  });
}
