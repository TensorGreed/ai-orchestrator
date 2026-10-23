/**
 * Phase 11.2 — approval requests.
 *
 * A run that pauses for a person (an Approval Gate, a Human Approval node, a
 * guard hand-off or the agent-level gate before MCP write tools) keeps its
 * paused state in `workflow_executions`; this service records the matching
 * request in `approval_requests`: who may decide it, when it expires and,
 * once decided, who decided what and why.
 *
 * - Deciding checks project access first (the caller passes `canExecute`),
 *   then the request's approvers and the self-approval rule, then the
 *   reason and the edits, and claims the paused run so a second decision
 *   (another approver, or the timeout sweeper) gets a 409.
 * - The leader expires overdue requests on a timer and once at startup;
 *   an expired request resumes the run with a `timeout` decision.
 * - Every request, decision and timeout is audited (`approval.requested`,
 *   `approval.decided`, `approval.timed_out`) and requests and timeouts are
 *   sent through the notification channels.
 *
 * Resuming is handed to `dispatch`, which runs the resume inline or puts it
 * on the execution queue.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  checkApprover,
  defaultApprovalRequest,
  resolvePendingApproval,
  validateApprovalEdits,
  type ApprovalDecisionValue,
  type ApprovalRequestSpec,
  type ApprovalRequestView,
  type WorkflowExecutionState
} from "@ai-orchestrator/shared";
import type { ApprovalRequestRecord, SqliteStore } from "../db/database.js";
import type { AuditEventInput } from "./audit-service.js";
import type { SafeUser } from "./auth-service.js";
import type { NotificationEvent } from "./notification-service.js";

export interface ApprovalResumeJob {
  executionId: string;
  requestId: string;
  decision: ApprovalDecisionValue;
  /** Email of the approver, or `system` for a timeout. */
  actedBy: string;
  actorUserId: string | null;
  reason?: string;
  edits?: Record<string, unknown>;
  editedFields?: string[];
}

export class ApprovalDecisionError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 403 | 404 | 409,
    readonly details?: Array<{ key: string; message: string }>
  ) {
    super(message);
    this.name = "ApprovalDecisionError";
  }
}

type WorkflowRef = { id: string; projectId?: string };

export interface ApprovalServiceOptions {
  audit: (event: AuditEventInput) => void;
  notify: (event: NotificationEvent) => Promise<void>;
  /** Runs the resume inline or enqueues it; resolves with the run result when inline. */
  dispatch: (job: ApprovalResumeJob) => Promise<unknown>;
  isLeader: () => boolean;
  canRead: (user: SafeUser, workflow: WorkflowRef) => boolean;
  canExecute: (user: SafeUser, workflow: WorkflowRef) => boolean;
  /** Masks secret values in text shown to approvers. */
  redact: (value: unknown) => unknown;
  sweepIntervalMs: number;
  /** The web app's public URL, for inbox links in notifications. */
  appPublicUrl?: string;
  /** With the queue, an interrupted resume is retried by the queue itself. */
  recoverInterruptedResumes: boolean;
  logger?: { info: (msg: string, fields?: Record<string, unknown>) => void; warn: (msg: string, fields?: Record<string, unknown>) => void };
  now?: () => Date;
}

const SYSTEM_ACTOR = "system";

function digestOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function describeApprovers(spec: ApprovalRequestSpec): string {
  const parts = [...spec.approverRoles.map((role) => `role ${role}`), ...spec.approverUsers];
  return parts.length > 0 ? parts.join(", ") : "operators, builders and admins";
}

function requesterFromState(state: WorkflowExecutionState): { userId: string | null; email: string | null } {
  const subject = state.toolPolicySubject;
  if (subject?.source === "user") return { userId: subject.userId ?? null, email: subject.email ?? null };
  return { userId: null, email: null };
}

export class ApprovalService {
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    private readonly store: SqliteStore,
    private readonly options: ApprovalServiceOptions
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private log(level: "info" | "warn", message: string, fields?: Record<string, unknown>) {
    this.options.logger?.[level](message, fields);
  }

  private inboxLink(requestId: string): string | undefined {
    const base = this.options.appPublicUrl?.replace(/\/+$/, "");
    return base ? `${base}/?mode=approvals&request=${encodeURIComponent(requestId)}` : undefined;
  }

  private notify(record: ApprovalRequestRecord, type: "approval.requested" | "approval.timed_out", outcome?: string) {
    const link = this.inboxLink(record.id);
    this.options
      .notify({
        type,
        workflowId: record.workflowId,
        workflowName: record.workflowName ?? record.workflowId,
        executionId: record.executionId,
        timestamp: this.now().toISOString(),
        approval: {
          requestId: record.id,
          nodeId: record.nodeId,
          message: record.message ? String(this.options.redact(record.message)) : null,
          expiresAt: record.expiresAt,
          approvers: describeApprovers(record.spec),
          ...(link ? { link } : {}),
          ...(outcome ? { outcome } : {})
        }
      })
      .catch((error) => this.log("warn", "Approval notification failed", { error: error instanceof Error ? error.message : String(error) }));
  }

  private auditMetadata(record: ApprovalRequestRecord, extra: Record<string, unknown> = {}) {
    return {
      requestId: record.id,
      executionId: record.executionId,
      nodeId: record.nodeId,
      nodeType: record.nodeType,
      kind: record.kind,
      subWorkflowPath: record.path.map((step) => step.nodeId),
      ...extra
    };
  }

  /**
   * Records the request of a run that just paused. The requester is the
   * person who started the run (kept from the run's first request, since a
   * resumed run is triggered by its approver).
   */
  recordPause(input: { executionId: string; workflowId: string; workflowName?: string; projectId: string; state: WorkflowExecutionState; message: string; timeoutMinutes: number }): ApprovalRequestRecord {
    const info = resolvePendingApproval(input.state);
    const earlier = this.store.listApprovalRequestsForExecution(input.executionId);
    this.store.cancelPendingApprovalRequests({ executionId: input.executionId }, "Superseded by a newer request of the same run");
    const first = earlier[0];
    const requester = first ? { userId: first.requestedByUserId, email: first.requestedBy } : requesterFromState(input.state);
    const createdAt = this.now();
    const timeoutMinutes = input.timeoutMinutes > 0 ? Math.floor(input.timeoutMinutes) : null;
    const record = this.store.insertApprovalRequest({
      id: `apr_${randomUUID()}`,
      executionId: input.executionId,
      workflowId: input.workflowId,
      workflowName: input.workflowName ?? null,
      projectId: input.projectId,
      nodeId: info.nodeId,
      nodeType: info.nodeType,
      kind: info.request.kind,
      message: input.message,
      spec: info.request,
      path: info.path,
      details: info.details,
      requestedByUserId: requester.userId,
      requestedBy: requester.email,
      timeoutMinutes,
      expiresAt: timeoutMinutes ? new Date(createdAt.getTime() + timeoutMinutes * 60_000).toISOString() : null,
      createdAt: createdAt.toISOString()
    });
    this.options.audit({
      category: "approval",
      eventType: "approval.requested",
      action: "request",
      outcome: "success",
      actor: { type: "system", email: requester.email, userId: requester.userId },
      resourceType: "workflow",
      resourceId: record.workflowId,
      projectId: record.projectId,
      metadata: this.auditMetadata(record, { expiresAt: record.expiresAt, approverRoles: record.spec.approverRoles, approverUsers: record.spec.approverUsers.length })
    });
    this.notify(record, "approval.requested");
    return record;
  }

  /**
   * A request for a run that paused before approval requests existed (or
   * whose request row is missing): built from the paused state with the
   * permissive defaults, expiring from when the run paused.
   */
  private backfill(pending: NonNullable<ReturnType<SqliteStore["getWorkflowExecutionState"]>>): ApprovalRequestRecord | null {
    const state = pending.state as WorkflowExecutionState | null;
    if (!state || typeof state !== "object" || !state.workflow) return null;
    const info = resolvePendingApproval(state);
    const created = Date.parse(pending.createdAt);
    const timeoutMinutes = pending.timeoutMinutes && pending.timeoutMinutes > 0 ? pending.timeoutMinutes : null;
    const requester = requesterFromState(state);
    return this.store.insertApprovalRequest({
      id: `apr_${randomUUID()}`,
      executionId: pending.id,
      workflowId: pending.workflowId,
      workflowName: pending.workflowName,
      projectId: state.workflow.projectId ?? "default",
      nodeId: info.nodeId,
      nodeType: info.nodeType,
      kind: info.request.kind,
      message: pending.approvalMessage,
      spec: info.request,
      path: info.path,
      details: info.details,
      requestedByUserId: requester.userId,
      requestedBy: requester.email,
      timeoutMinutes,
      expiresAt: timeoutMinutes && Number.isFinite(created) ? new Date(created + timeoutMinutes * 60_000).toISOString() : null,
      createdAt: pending.createdAt
    });
  }

  /** Requests for paused runs that have none yet. */
  backfillMissing(): number {
    let created = 0;
    for (const pending of this.store.listPendingApprovals()) {
      if (this.store.getPendingApprovalRequestForExecution(pending.id)) continue;
      const full = this.store.getWorkflowExecutionState(pending.id);
      if (full && this.backfill(full)) created += 1;
    }
    return created;
  }

  private requestFor(executionId: string): ApprovalRequestRecord | null {
    const existing = this.store.getPendingApprovalRequestForExecution(executionId);
    if (existing) return existing;
    const pending = this.store.getWorkflowExecutionState(executionId);
    return pending && pending.status === "waiting_approval" ? this.backfill(pending) : null;
  }

  private decisionCheck(record: ApprovalRequestRecord, user: SafeUser): { allowed: true } | { allowed: false; message: string; code: string } {
    const workflow = { id: record.workflowId, projectId: record.projectId };
    if (!this.options.canExecute(user, workflow)) {
      return { allowed: false, code: "project_access", message: "You do not have execute access to this workflow's project." };
    }
    const spec = { ...defaultApprovalRequest(record.kind), ...record.spec };
    const check = checkApprover(spec, user, { userId: record.requestedByUserId, email: record.requestedBy });
    return check.allowed ? { allowed: true } : { allowed: false, code: check.code, message: check.message };
  }

  toView(record: ApprovalRequestRecord, user: SafeUser): ApprovalRequestView {
    const spec = { ...defaultApprovalRequest(record.kind), ...record.spec };
    const check = record.status === "pending" ? this.decisionCheck(record, user) : { allowed: false as const, message: "Already decided.", code: "decided" };
    const redact = <T>(value: T): T => this.options.redact(value) as T;
    return {
      requestId: record.id,
      id: record.executionId,
      executionId: record.executionId,
      workflowId: record.workflowId,
      workflowName: record.workflowName,
      projectId: record.projectId,
      nodeId: record.nodeId,
      nodeType: record.nodeType,
      kind: record.kind,
      status: record.status,
      message: record.message ? redact(record.message) : null,
      approvalMessage: record.message ? redact(record.message) : null,
      timeoutMinutes: record.timeoutMinutes,
      approverRoles: spec.approverRoles,
      approverUsers: spec.approverUsers,
      allowSelfApproval: spec.allowSelfApproval,
      timeoutOutcome: spec.timeoutOutcome,
      requireRejectReason: spec.requireRejectReason,
      // Field definitions are the gate's own; only the proposed values come from the run.
      editableFields: spec.editableFields.map((field) => (field.value === undefined ? field : { ...field, value: redact(field.value) })),
      path: record.path,
      details: record.details ? redact(record.details) : null,
      requestedBy: record.requestedBy,
      triggerType: null,
      triggeredBy: record.requestedBy,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      decidedBy: record.decidedBy,
      decidedAt: record.decidedAt,
      reason: record.reason ? redact(record.reason) : null,
      editedFields: record.editedFields,
      canDecide: check.allowed,
      cannotDecideReason: check.allowed ? null : check.message
    };
  }

  /** Requests the user can see: workflows of projects they can read. */
  list(user: SafeUser, filter: { status: "pending" | "decided" | "all"; workflowId?: string; executionId?: string; limit?: number }): ApprovalRequestView[] {
    if (filter.status !== "decided") this.backfillMissing();
    const limit = Math.max(1, Math.min(500, filter.limit ?? 200));
    const rows = this.store.listApprovalRequests({ ...filter, limit: limit * 4 });
    const readable = new Map<string, boolean>();
    const visible: ApprovalRequestView[] = [];
    for (const row of rows) {
      const key = `${row.workflowId}\u0000${row.projectId}`;
      if (!readable.has(key)) readable.set(key, this.options.canRead(user, { id: row.workflowId, projectId: row.projectId }));
      if (!readable.get(key)) continue;
      visible.push(this.toView(row, user));
      if (visible.length >= limit) break;
    }
    return visible;
  }

  /**
   * Records a person's decision and claims the paused run. Throws an
   * `ApprovalDecisionError` with the HTTP status when it may not be taken.
   */
  decide(input: {
    executionId: string;
    user: SafeUser;
    decision: "approve" | "reject";
    reason?: string;
    edits?: Record<string, unknown>;
    requestId?: string;
  }): { job: ApprovalResumeJob; record: ApprovalRequestRecord } {
    const pending = this.store.getWorkflowExecutionState(input.executionId);
    if (!pending) throw new ApprovalDecisionError("Pending approval not found", 404);
    if (pending.status === "resuming") throw new ApprovalDecisionError("This approval was already decided", 409);
    if (pending.status !== "waiting_approval") throw new ApprovalDecisionError("Pending approval not found", 404);
    const state = pending.state as WorkflowExecutionState | null;
    if (!state || typeof state !== "object" || !state.workflow) {
      throw new ApprovalDecisionError("Stored execution state is invalid and cannot be resumed", 400);
    }
    const record = this.requestFor(input.executionId);
    if (!record) throw new ApprovalDecisionError("Pending approval not found", 404);
    if (!this.options.canRead(input.user, { id: record.workflowId, projectId: record.projectId })) {
      // Not visible to this user: answer as if it did not exist.
      throw new ApprovalDecisionError("Pending approval not found", 404);
    }
    if (input.requestId && input.requestId !== record.id) {
      throw new ApprovalDecisionError("This run is now waiting on a newer approval request; reload and decide that one", 409);
    }
    const check = this.decisionCheck(record, input.user);
    if (!check.allowed) {
      this.options.audit({
        category: "approval",
        eventType: "approval.decided",
        action: input.decision,
        outcome: "denied",
        actor: { userId: input.user.id, email: input.user.email, type: "user" },
        resourceType: "workflow",
        resourceId: record.workflowId,
        projectId: record.projectId,
        metadata: this.auditMetadata(record, { refused: check.code })
      });
      throw new ApprovalDecisionError(check.message, 403);
    }
    const spec = { ...defaultApprovalRequest(record.kind), ...record.spec };
    const reason = input.reason?.trim() || undefined;
    if (input.decision === "reject" && spec.requireRejectReason && !reason) {
      throw new ApprovalDecisionError("A reason is required to reject this approval", 400);
    }
    let edits: Record<string, unknown> | undefined;
    let editedFields: string[] = [];
    if (input.decision === "approve" && (spec.editableFields.length > 0 || (input.edits && Object.keys(input.edits).length > 0))) {
      const checked = validateApprovalEdits(spec.editableFields, input.edits);
      if (!checked.ok) throw new ApprovalDecisionError("Invalid edits", 400, checked.errors);
      edits = checked.values;
      editedFields = checked.changed;
    }
    if (!this.store.claimWorkflowExecutionForResume(input.executionId)) {
      throw new ApprovalDecisionError("This approval was already decided", 409);
    }
    const decidedAt = this.now().toISOString();
    const recorded = this.store.decideApprovalRequest({
      id: record.id,
      status: input.decision === "approve" ? "approved" : "rejected",
      decidedByUserId: input.user.id,
      decidedBy: input.user.email,
      reason: reason ?? null,
      edits: edits && editedFields.length > 0 ? edits : null,
      editedFields,
      decidedAt
    });
    if (!recorded) {
      this.store.releaseWorkflowExecutionClaim(input.executionId);
      throw new ApprovalDecisionError("This approval was already decided", 409);
    }
    const decided = this.store.getApprovalRequest(record.id)!;
    this.options.audit({
      category: "approval",
      eventType: "approval.decided",
      action: input.decision,
      outcome: "success",
      actor: { userId: input.user.id, email: input.user.email, type: "user" },
      resourceType: "workflow",
      resourceId: record.workflowId,
      projectId: record.projectId,
      metadata: this.auditMetadata(decided, {
        decision: input.decision,
        reason: reason ? String(this.options.redact(reason)) : null,
        editedFields,
        editsDigest: editedFields.length > 0 ? digestOf(edits) : null
      })
    });
    return {
      record: decided,
      job: {
        executionId: input.executionId,
        requestId: record.id,
        decision: input.decision,
        actedBy: input.user.email,
        actorUserId: input.user.id,
        ...(reason ? { reason } : {}),
        ...(edits ? { edits } : {}),
        ...(editedFields.length > 0 ? { editedFields } : {})
      }
    };
  }

  /**
   * Expires overdue requests (leader only) and resumes their runs with a
   * `timeout` decision. Returns how many it expired.
   */
  async sweep(): Promise<number> {
    if (this.sweeping || !this.options.isLeader()) return 0;
    this.sweeping = true;
    let expired = 0;
    try {
      this.backfillMissing();
      for (const record of this.store.listExpiredApprovalRequests(this.now().toISOString())) {
        const pending = this.store.getWorkflowExecutionState(record.executionId);
        if (!pending) {
          this.store.cancelPendingApprovalRequests({ executionId: record.executionId }, "The paused run no longer exists");
          continue;
        }
        if (!this.store.claimWorkflowExecutionForResume(record.executionId)) continue;
        if (!this.store.decideApprovalRequest({ id: record.id, status: "timed_out", decidedBy: SYSTEM_ACTOR, reason: "Nobody decided before the approval expired" })) {
          this.store.releaseWorkflowExecutionClaim(record.executionId);
          continue;
        }
        expired += 1;
        const spec = { ...defaultApprovalRequest(record.kind), ...record.spec };
        const outcome = spec.timeoutOutcome === "fallback" && record.kind === "approval_gate" ? "fallback branch" : "rejected";
        this.options.audit({
          category: "approval",
          eventType: "approval.timed_out",
          action: "timeout",
          outcome: "success",
          actor: { type: "system", email: SYSTEM_ACTOR },
          resourceType: "workflow",
          resourceId: record.workflowId,
          projectId: record.projectId,
          metadata: this.auditMetadata(record, { expiresAt: record.expiresAt, outcome })
        });
        this.notify(record, "approval.timed_out", outcome);
        this.options
          .dispatch({ executionId: record.executionId, requestId: record.id, decision: "timeout", actedBy: SYSTEM_ACTOR, actorUserId: null, reason: "Approval timed out" })
          .catch((error) => this.log("warn", "Resuming a timed-out approval failed", { executionId: record.executionId, error: error instanceof Error ? error.message : String(error) }));
      }
    } finally {
      this.sweeping = false;
    }
    return expired;
  }

  /**
   * Runs whose decision was taken but whose resume did not finish because
   * the process stopped: resume them again with the recorded decision.
   */
  recoverInterrupted(): number {
    if (!this.options.recoverInterruptedResumes || !this.options.isLeader()) return 0;
    let recovered = 0;
    for (const executionId of this.store.listResumingWorkflowExecutionIds()) {
      const decided = this.store
        .listApprovalRequestsForExecution(executionId)
        .filter((entry) => entry.status === "approved" || entry.status === "rejected" || entry.status === "timed_out")
        .at(-1);
      if (!decided) {
        this.store.releaseWorkflowExecutionClaim(executionId);
        continue;
      }
      recovered += 1;
      const decision: ApprovalDecisionValue = decided.status === "approved" ? "approve" : decided.status === "rejected" ? "reject" : "timeout";
      this.options
        .dispatch({
          executionId,
          requestId: decided.id,
          decision,
          actedBy: decided.decidedBy ?? SYSTEM_ACTOR,
          actorUserId: decided.decidedByUserId,
          ...(decided.reason ? { reason: decided.reason } : {}),
          ...(decided.edits ? { edits: decided.edits, editedFields: decided.editedFields } : {})
        })
        .catch((error) => this.log("warn", "Recovering an interrupted approval resume failed", { executionId, error: error instanceof Error ? error.message : String(error) }));
    }
    return recovered;
  }

  /** Marks the run's pending request canceled (the run was canceled). */
  cancelForExecution(executionId: string, reason: string, user?: SafeUser | null): void {
    const pending = this.store.getPendingApprovalRequestForExecution(executionId);
    if (this.store.cancelPendingApprovalRequests({ executionId }, reason) > 0 && pending) {
      this.options.audit({
        category: "approval",
        eventType: "approval.canceled",
        action: "cancel",
        outcome: "success",
        actor: user ? { userId: user.id, email: user.email, type: "user" } : { type: "system", email: SYSTEM_ACTOR },
        resourceType: "workflow",
        resourceId: pending.workflowId,
        projectId: pending.projectId,
        metadata: this.auditMetadata(pending)
      });
    }
  }

  /** Startup: backfill, recover interrupted resumes and expire what is overdue; then sweep on a timer. */
  start(): void {
    if (this.timer) return;
    try {
      this.backfillMissing();
      this.recoverInterrupted();
    } catch (error) {
      this.log("warn", "Approval startup reconciliation failed", { error: error instanceof Error ? error.message : String(error) });
    }
    void this.sweep().catch((error) => this.log("warn", "Approval sweep failed", { error: error instanceof Error ? error.message : String(error) }));
    this.timer = setInterval(() => {
      void this.sweep().catch((error) => this.log("warn", "Approval sweep failed", { error: error instanceof Error ? error.message : String(error) }));
    }, this.options.sweepIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
