/**
 * Phase 11.2 — approval requests.
 *
 * A run that pauses for a person (an Approval Gate, a Human Approval node, a
 * guard hand-off or the agent-level gate before MCP write tools) keeps its
 * paused state in `workflow_executions`; this service records the matching
 * request in `approval_requests`: who may decide it, when it expires and,
 * once decided, who decided what and why.
 *
 * - Access follows the shared project authorization (run-access.ts),
 *   always against the workflow as it is now: a run the user cannot read
 *   answers 404 and nothing is written for it; deciding then needs
 *   `workflow:execute` on the workflow and on every workflow along a
 *   sub-workflow path (403 otherwise), and the inbox is narrowed to readable
 *   workflows in SQL before its limit. Admins pass, as everywhere else.
 * - Deciding checks, in order: visibility, expiry, project access, the
 *   request's approvers and the self-approval rule, the reason and the
 *   edits. Claiming the paused run and recording the decision are
 *   one transaction, so a second decision (another approver, or the
 *   timeout sweeper) gets a 409 and a crash never leaves one without the
 *   other.
 * - A recorded decision is never lost: when its resume cannot be started
 *   or fails, the request goes back to pending (same expiry) and the run
 *   back to waiting, so it can be decided again.
 * - The leader expires overdue requests on a timer and once at startup;
 *   an expired request resumes the run with a `timeout` decision. Each
 *   sweep also re-drives runs left in `resuming` (the process stopped
 *   mid-resume). A recovered resume runs the post-gate nodes again: resumes
 *   are at-least-once.
 * - Every request, decision and timeout is audited (`approval.requested`,
 *   `approval.decided`, `approval.timed_out`) and requests and timeouts are
 *   sent through the notification channels.
 *
 * Resuming is handed to `dispatch`, which runs the resume inline or puts it
 * on the execution queue.
 */

import { randomUUID } from "node:crypto";
import {
  checkApprover,
  defaultApprovalRequest,
  resolvePendingApproval,
  validateApprovalEdits,
  type ApprovalDecisionValue,
  type ApprovalEligibilityView,
  type ApprovalRequestSpec,
  type ApprovalRequestView,
  type WorkflowExecutionState
} from "@ai-orchestrator/shared";
import type { ApprovalReadScope, ApprovalRequestRecord } from "../db/database.js";
import { approvalEditsDigest, newApprovalEditsSalt } from "./approval-digest.js";
import type { AuditEventInput } from "./audit-service.js";
import type { SafeUser } from "./auth-service.js";
import type { RunAccessResult, RunPermission } from "../run-access.js";
import type { NotificationEvent } from "./notification-service.js";
import type { Store } from "../db/store.js";
import { someAsync } from "../async-array.js";
import { isOnePendingApprovalViolation } from "../db/store-errors.js";

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
  /** Set when recovery re-drives a resume on the queue: gives the queue item a fresh id. */
  retryTag?: string;
}

export class ApprovalDecisionError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 403 | 404 | 409 | 503,
    readonly details?: Array<{ key: string; message: string }>
  ) {
    super(message);
    this.name = "ApprovalDecisionError";
  }
}

type WorkflowRef = { id: string; projectId?: string };

export interface ApprovalServiceOptions {
  audit: (event: AuditEventInput) => void | Promise<void>;
  notify: (event: NotificationEvent) => Promise<void>;
  /** Runs the resume inline or enqueues it; resolves with the run result when inline. */
  dispatch: (job: ApprovalResumeJob) => Promise<unknown>;
  isLeader: () => boolean;
  /**
   * The shared run-access check for a run of this workflow: 404 when the user
   * cannot read it, 403 without `permission`; admins pass, also for a deleted
   * workflow's runs (which are admin-only).
   */
  access: (user: SafeUser, workflowId: string, permission: RunPermission) => Promise<RunAccessResult<object>>;
  /** Workflow ids the user can read, or null for everything (admins); applied in SQL before the list limit. */
  readableWorkflowIds: (user: SafeUser) => Promise<string[] | null>;
  /**
   * Execute access for the editor's "who could approve" check, where the
   * workflow may not be saved yet (then its project decides).
   */
  canExecuteDraft: (user: SafeUser, workflow: WorkflowRef) => Promise<boolean>;
  /** Every user, for the editor's "who could approve" check. */
  listUsers: () => Promise<SafeUser[]>;
  /** Masks secret values in text shown to approvers. */
  redact: (value: unknown) => unknown;
  sweepIntervalMs: number;
  /** The web app's public URL, for inbox links in notifications. */
  appPublicUrl?: string;
  /** Resumes run on the execution queue (recovery checks the queue for a live item first). */
  queueMode: boolean;
  /** True while this process is running the resume inline. */
  isResumeActive: (executionId: string) => boolean;
  /**
   * How long a run may stay in `resuming` before a sweep re-drives it
   * inline: past the execution timeout, so a resume still running on
   * another instance is never started twice.
   */
  resumeStaleAfterMs: number;
  /** Single instance: at startup nothing else can be resuming, so recover at once. */
  recoverAtStartupImmediately: boolean;
  logger?: { info: (msg: string, fields?: Record<string, unknown>) => void; warn: (msg: string, fields?: Record<string, unknown>) => void };
  now?: () => Date;
}

/**
 * Resumes running in this process, one at a time per run. A later decision
 * of the same run (it paused again at a second gate while the first resume
 * was still finishing) waits for the earlier resume to end and then runs;
 * the same decision dispatched twice runs once (the second gets null).
 */
export class ApprovalResumeRunner {
  private readonly inFlight = new Map<string, { requestId: string; done: Promise<unknown> }>();

  isActive(executionId: string): boolean {
    return this.inFlight.has(executionId);
  }

  async run<T>(job: Pick<ApprovalResumeJob, "executionId" | "requestId">, work: () => Promise<T | null>): Promise<T | null> {
    for (let current = this.inFlight.get(job.executionId); current; current = this.inFlight.get(job.executionId)) {
      if (current.requestId === job.requestId) return null;
      await current.done.catch(() => undefined);
    }
    const done = work();
    this.inFlight.set(job.executionId, { requestId: job.requestId, done });
    try {
      return await done;
    } finally {
      // promise-ok: identity check on the same promise object
      if (this.inFlight.get(job.executionId)?.done === done) this.inFlight.delete(job.executionId);
    }
  }
}

const SYSTEM_ACTOR = "system";
/** Queue mode: a claim this old with no live queue item is re-driven. */
const QUEUE_RECOVERY_GRACE_MS = 60_000;
const DECIDED_STATUSES = new Set(["approved", "rejected", "timed_out"]);

/** The decision a request status stands for; null while it is pending or expired without a decision. */
export function approvalDecisionOf(status: string): ApprovalDecisionValue | null {
  return status === "approved" ? "approve" : status === "rejected" ? "reject" : status === "timed_out" ? "timeout" : null;
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

export type ApprovalCheck = { allowed: true } | { allowed: false; message: string; code: string };

/**
 * May `user` decide this request: execute access to the workflow and to every
 * workflow along its sub-workflow path, then the request's approver rules.
 * `skipSelfApproval` leaves out the "you started this run" rule, which only
 * applies when a decision is taken: a queued or recovered resume re-checks
 * the person who already decided with this same check. `accessOnly` stops
 * after the access checks (the requester of a timed-out run is no approver).
 */
export async function approvalPersonCheck(
  record: ApprovalRequestRecord,
  user: SafeUser,
  access: ApprovalServiceOptions["access"],
  options: { skipSelfApproval?: boolean; accessOnly?: boolean } = {}
): Promise<ApprovalCheck> {
  if (!(await access(user, record.workflowId, "workflow:execute")).ok) {
    return { allowed: false, code: "project_access", message: "You do not have execute access to this workflow's project." };
  }
  // A gate inside a sub-workflow: execute access on every workflow down to the one that asked.
  const along = new Set([...record.path.map((step) => step.workflowId), record.askingWorkflowId ?? ""].filter((id) => id && id !== record.workflowId));
  for (const workflowId of along) {
    if (!(await access(user, workflowId, "workflow:execute")).ok) {
      return { allowed: false, code: "project_access", message: "You do not have execute access to the project of a sub-workflow this request comes from." };
    }
  }
  if (options.accessOnly) return { allowed: true };
  const spec = { ...defaultApprovalRequest(record.kind), ...record.spec, ...(options.skipSelfApproval ? { allowSelfApproval: true } : {}) };
  const check = checkApprover(spec, user, { userId: record.requestedByUserId, email: record.requestedBy });
  return check.allowed ? { allowed: true } : { allowed: false, code: check.code, message: check.message };
}

export class ApprovalService {
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    private readonly store: Store,
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
          expiresAt: record.expiresAt,
          approvers: describeApprovers(record.spec),
          ...(link ? { link } : {}),
          ...(outcome ? { outcome } : {})
        }
      })
      .catch((error) => this.log("warn", "Approval notification failed", { error: error instanceof Error ? error.message : String(error) }));
  }

  /** The workflow's project now (it may have moved since the pause), else the one stored with the request. */
  private async currentProjectId(record: Pick<ApprovalRequestRecord, "workflowId" | "projectId">, memo?: Map<string, string>): Promise<string> {
    const known = memo?.get(record.workflowId);
    if (known !== undefined) return known;
    const projectId = (await this.store.getWorkflow(record.workflowId))?.projectId ?? record.projectId;
    memo?.set(record.workflowId, projectId);
    return projectId;
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
  async recordPause(input: { executionId: string; workflowId: string; workflowName?: string; projectId: string; state: WorkflowExecutionState; message: string; timeoutMinutes: number }): Promise<ApprovalRequestRecord> {
    const info = resolvePendingApproval(input.state);
    const earlier = await this.store.listApprovalRequestsForExecution(input.executionId);
    await this.store.cancelPendingApprovalRequests({ executionId: input.executionId }, "Superseded by a newer request of the same run");
    const first = earlier[0];
    const requester = first ? { userId: first.requestedByUserId, email: first.requestedBy } : requesterFromState(input.state);
    const createdAt = this.now();
    const timeoutMinutes = input.timeoutMinutes > 0 ? Math.floor(input.timeoutMinutes) : null;
    const insert = () => this.store.insertApprovalRequest({
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
      askingWorkflowId: info.workflowId || null,
      editsSalt: newApprovalEditsSalt(),
      createdAt: createdAt.toISOString()
    });
    let record: ApprovalRequestRecord;
    try {
      record = await insert();
    } catch (error) {
      // Another instance backfilled a request for this pause between the cancel above and the insert (v41 allows one
      // pending request per run): this pause's own request replaces it.
      if (!isOnePendingApprovalViolation(error)) throw error;
      await this.store.cancelPendingApprovalRequests({ executionId: input.executionId }, "Superseded by a newer request of the same run");
      record = await insert();
    }
    await this.options.audit({
      category: "approval",
      eventType: "approval.requested",
      action: "request",
      outcome: "success",
      actor: { type: "system", email: requester.email, userId: requester.userId },
      resourceType: "workflow",
      resourceId: record.workflowId,
      projectId: await this.currentProjectId(record),
      metadata: this.auditMetadata(record, { expiresAt: record.expiresAt, approverRoles: record.spec.approverRoles, approverUsers: record.spec.approverUsers.length })
    });
    this.notify(record, "approval.requested");
    return record;
  }

  /**
   * A request for a run that paused before approval requests existed (or
   * whose request row is missing): built from the paused state with the
   * permissive defaults. It expires one timeout after the run last paused,
   * except that a run paused before approval requests came up (the first
   * boot with migration 32) gets one full timeout counted from then, never
   * an immediate rejection.
   */
  private async backfill(pending: NonNullable<Awaited<ReturnType<Store["getWorkflowExecutionState"]>>>, grace?: string[]): Promise<ApprovalRequestRecord | null> {
    const state = pending.state as WorkflowExecutionState | null;
    if (!state || typeof state !== "object" || !state.workflow) return null;
    const info = resolvePendingApproval(state);
    const pausedAt = Date.parse(pending.updatedAt || pending.createdAt);
    const upgradedAt = Date.parse(await this.store.getSchemaMarker("approval_requests") ?? "");
    const fromUpgrade = Number.isFinite(upgradedAt) && (!Number.isFinite(pausedAt) || pausedAt < upgradedAt);
    const countFrom = fromUpgrade ? upgradedAt : pausedAt;
    if (fromUpgrade) grace?.push(pending.id);
    const timeoutMinutes = pending.timeoutMinutes && pending.timeoutMinutes > 0 ? pending.timeoutMinutes : null;
    const requester = requesterFromState(state);
    try {
      return await this.store.insertApprovalRequest({
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
        expiresAt: timeoutMinutes && Number.isFinite(countFrom) ? new Date(countFrom + timeoutMinutes * 60_000).toISOString() : null,
        askingWorkflowId: info.workflowId || null,
        editsSalt: newApprovalEditsSalt(),
        createdAt: Number.isFinite(pausedAt) ? new Date(pausedAt).toISOString() : pending.createdAt
      });
    } catch (error) {
      // Another instance backfilled this run first (v41: one pending request per run); nothing new was created.
      if (isOnePendingApprovalViolation(error)) return null;
      throw error;
    }
  }

  /** Requests for paused runs that have none yet. */
  async backfillMissing(): Promise<number> {
    let created = 0;
    const grace: string[] = [];
    for (const pending of await this.store.listPendingApprovals()) {
      if (await this.store.getPendingApprovalRequestForExecution(pending.id)) continue;
      const full = await this.store.getWorkflowExecutionState(pending.id);
      if (full && await this.backfill(full, grace)) created += 1;
    }
    if (grace.length > 0) {
      this.log("warn", "Approval timeouts are now enforced: runs paused before this upgrade get one full timeout from the upgrade", { executionIds: grace });
    }
    return created;
  }

  private async requestFor(executionId: string): Promise<ApprovalRequestRecord | null> {
    const existing = await this.store.getPendingApprovalRequestForExecution(executionId);
    if (existing) return existing;
    const pending = await this.store.getWorkflowExecutionState(executionId);
    if (!pending || pending.status !== "waiting_approval") return null;
    return (await this.backfill(pending)) ?? (await this.store.getPendingApprovalRequestForExecution(executionId));
  }

  private async decisionCheck(record: ApprovalRequestRecord, user: SafeUser): Promise<ApprovalCheck> {
    return await approvalPersonCheck(record, user, this.options.access);
  }

  /**
   * Who could approve a request with these approver settings on this
   * workflow if `requester` started the run: project execute access and the
   * approver check, as at decision time.
   */
  /**
   * `accountBlind` callers (no right to see the project's members) get an answer that
   * does not depend on which accounts exist: any approver user other than themselves
   * counts as "someone else could approve", and admins do not count through roles.
   */
  async eligibility(input: {
    workflow: WorkflowRef;
    spec: Pick<ApprovalRequestSpec, "approverRoles" | "approverUsers" | "allowSelfApproval">;
    requester: SafeUser;
    accountBlind?: boolean;
  }): Promise<ApprovalEligibilityView> {
    const requester = { userId: input.requester.id, email: input.requester.email };
    const blind = input.accountBlind === true;
    const isRequester = (entry: string) => entry === requester.userId || entry.toLowerCase() === requester.email.toLowerCase();
    const named = blind ? input.spec.approverUsers.filter(isRequester) : input.spec.approverUsers;
    const spec = { ...input.spec, approverUsers: named };
    const can = async (user: SafeUser) => await this.options.canExecuteDraft(user, input.workflow) && checkApprover(spec, user, requester).allowed;
    const someoneElseNamed = blind && input.spec.approverUsers.some((entry) => !isRequester(entry));
    const others = (await this.options.listUsers()).filter((user) => user.id !== input.requester.id && (!blind || user.role !== "admin"));
    return {
      othersCanApprove: someoneElseNamed || (await someAsync(others, can)),
      requesterCanApprove: await can(input.requester)
    };
  }

  async toView(record: ApprovalRequestRecord, user: SafeUser, projects?: Map<string, string>): Promise<ApprovalRequestView> {
    const spec = { ...defaultApprovalRequest(record.kind), ...record.spec };
    const check = record.status === "pending" ? await this.decisionCheck(record, user) : { allowed: false as const, message: "Already decided.", code: "decided" };
    const redact = <T>(value: T): T => this.options.redact(value) as T;
    return {
      requestId: record.id,
      id: record.executionId,
      executionId: record.executionId,
      workflowId: record.workflowId,
      workflowName: record.workflowName,
      projectId: await this.currentProjectId(record, projects),
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
  async list(user: SafeUser, filter: { status: "pending" | "decided" | "all"; workflowId?: string; executionId?: string; limit?: number }): Promise<ApprovalRequestView[]> {
    if (filter.status !== "decided") await this.backfillMissing();
    const limit = Math.max(1, Math.min(500, filter.limit ?? 200));
    const workflowIds = await this.options.readableWorkflowIds(user);
    const scope: ApprovalReadScope = workflowIds === null ? { all: true } : { workflowIds };
    const rows = await this.store.listApprovalRequests({ ...filter, limit, scope });
    // The SQL scope already holds only readable workflows; this re-check is per workflow, not per row.
    const readable = new Map<string, boolean>();
    const visible: ApprovalRequestView[] = [];
    const projects = new Map<string, string>();
    for (const row of rows) {
      // A deleted workflow's requests stay admin-only, even if a new workflow reuses the id.
      if (row.workflowDeletedAt && user.role !== "admin") continue;
      if (!readable.has(row.workflowId)) readable.set(row.workflowId, (await this.options.access(user, row.workflowId, "workflow:read")).ok);
      if (!readable.get(row.workflowId)) continue;
      visible.push(await this.toView(row, user, projects));
      if (visible.length >= limit) break;
    }
    return visible;
  }

  /**
   * Records a person's decision and claims the paused run. Throws an
   * `ApprovalDecisionError` with the HTTP status when it may not be taken.
   */
  async decide(input: {
    executionId: string;
    user: SafeUser;
    decision: "approve" | "reject";
    reason?: string;
    edits?: Record<string, unknown>;
    requestId?: string;
  }): Promise<{ job: ApprovalResumeJob; record: ApprovalRequestRecord }> {
    const pending = await this.store.getWorkflowExecutionState(input.executionId);
    if (!pending) throw new ApprovalDecisionError("Pending approval not found", 404);
    const state = pending.state as WorkflowExecutionState | null;
    const validState = Boolean(state && typeof state === "object" && state.workflow);
    // Visibility first, by the workflow's current project: another project's run
    // (or a deleted workflow's, for non-admins) answers as if it did not exist,
    // and nothing is written for it.
    if (!(await this.options.access(input.user, pending.workflowId, "workflow:read")).ok) {
      throw new ApprovalDecisionError("Pending approval not found", 404);
    }
    if (pending.status === "resuming") throw new ApprovalDecisionError("This approval was already decided", 409);
    if (pending.status !== "waiting_approval") throw new ApprovalDecisionError("Pending approval not found", 404);
    if (!validState) throw new ApprovalDecisionError("Stored execution state is invalid and cannot be resumed", 400);
    const record = await this.requestFor(input.executionId);
    if (!record) throw new ApprovalDecisionError("Pending approval not found", 404);
    if (record.workflowId !== pending.workflowId || !(await this.options.access(input.user, record.workflowId, "workflow:read")).ok) {
      throw new ApprovalDecisionError("Pending approval not found", 404);
    }
    if (input.requestId && input.requestId !== record.id) {
      throw new ApprovalDecisionError("This run is now waiting on a newer approval request; reload and decide that one", 409);
    }
    // Past its expiry the timeout outcome applies, even before the next sweep.
    if (record.expiresAt && Date.parse(record.expiresAt) <= this.now().getTime()) {
      void this.sweep().catch((error) => this.log("warn", "Approval sweep failed", { error: error instanceof Error ? error.message : String(error) }));
      throw new ApprovalDecisionError("This approval expired; its timeout outcome applies", 409);
    }
    const check = await this.decisionCheck(record, input.user);
    if (!check.allowed) {
      await this.options.audit({
        category: "approval",
        eventType: "approval.decided",
        action: input.decision,
        outcome: "denied",
        actor: { userId: input.user.id, email: input.user.email, type: "user" },
        resourceType: "workflow",
        resourceId: record.workflowId,
        projectId: await this.currentProjectId(record),
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
    const decidedAt = this.now().toISOString();
    const claimed = await this.claimAndDecide(input.executionId, {
      id: record.id,
      status: input.decision === "approve" ? "approved" : "rejected",
      decidedByUserId: input.user.id,
      decidedBy: input.user.email,
      reason: reason ?? null,
      edits: edits && editedFields.length > 0 ? edits : null,
      editedFields,
      decidedAt
    });
    if (!claimed) throw new ApprovalDecisionError("This approval was already decided", 409);
    const decided = (await this.store.getApprovalRequest(record.id))!;
    await this.options.audit({
      category: "approval",
      eventType: "approval.decided",
      action: input.decision,
      outcome: "success",
      actor: { userId: input.user.id, email: input.user.email, type: "user" },
      resourceType: "workflow",
      resourceId: record.workflowId,
      projectId: await this.currentProjectId(record),
      metadata: this.auditMetadata(decided, {
        decision: input.decision,
        reason: reason ? String(this.options.redact(reason)) : null,
        editedFields,
        editsDigest: editedFields.length > 0 ? approvalEditsDigest(decided.editsSalt, edits) : null
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
   * Claims the paused run and records the decision in one transaction: both
   * commit, or neither does. False when another decision got there first.
   */
  private async claimAndDecide(executionId: string, decision: Parameters<Store["decideApprovalRequest"]>[0]): Promise<boolean> {
    return await this.store.claimExecutionAndDecideApproval(executionId, decision);
  }

  /**
   * A decided request whose resume could not be started or failed: the run
   * goes back to waiting and the request back to pending with its expiry
   * unchanged, in one transaction, so it can be decided (or expire) again.
   * Nothing changes when the run is no longer claimed (it paused again, or
   * finished). Returns whether it was handed back.
   */
  async reopenAfterFailedResume(job: Pick<ApprovalResumeJob, "executionId" | "requestId">): Promise<boolean> {
    return await this.store.releaseExecutionClaimAndReopenApproval(job.executionId, job.requestId);
  }

  /**
   * Expires overdue requests (leader only) and resumes their runs with a
   * `timeout` decision, then re-drives runs left in `resuming`. Returns how
   * many it expired.
   */
  async sweep(): Promise<number> {
    if (this.sweeping || !this.options.isLeader()) return 0;
    this.sweeping = true;
    let expired = 0;
    try {
      await this.backfillMissing();
      for (const record of await this.store.listExpiredApprovalRequests(this.now().toISOString())) {
        const pending = await this.store.getWorkflowExecutionState(record.executionId);
        if (!pending) {
          await this.store.cancelPendingApprovalRequests({ executionId: record.executionId }, "The paused run no longer exists");
          continue;
        }
        if (!await this.claimAndDecide(record.executionId, { id: record.id, status: "timed_out", decidedBy: SYSTEM_ACTOR, reason: "Nobody decided before the approval expired" })) continue;
        expired += 1;
        const spec = { ...defaultApprovalRequest(record.kind), ...record.spec };
        const outcome = spec.timeoutOutcome === "fallback" && record.kind === "approval_gate" ? "fallback branch" : "rejected";
        await this.options.audit({
          category: "approval",
          eventType: "approval.timed_out",
          action: "timeout",
          outcome: "success",
          actor: { type: "system", email: SYSTEM_ACTOR },
          resourceType: "workflow",
          resourceId: record.workflowId,
          projectId: await this.currentProjectId(record),
          metadata: this.auditMetadata(record, { expiresAt: record.expiresAt, outcome })
        });
        this.notify(record, "approval.timed_out", outcome);
        const job: ApprovalResumeJob = { executionId: record.executionId, requestId: record.id, decision: "timeout", actedBy: SYSTEM_ACTOR, actorUserId: null, reason: "Approval timed out" };
        this.options.dispatch(job).catch(async (error) => {
          // Still expired: the next sweep expires it again.
          await this.reopenAfterFailedResume(job);
          this.log("warn", "Resuming a timed-out approval failed", { executionId: record.executionId, error: error instanceof Error ? error.message : String(error) });
        });
      }
      await this.recoverInterrupted("periodic");
    } finally {
      this.sweeping = false;
    }
    return expired;
  }

  /**
   * Runs whose decision was recorded but whose resume did not finish (the
   * process stopped, or a queue item was lost): resume them again with the
   * recorded decision for the pause they are in. A run in `resuming` with no
   * decision for its current pause is handed back to waiting. Leader only.
   */
  async recoverInterrupted(mode: "startup" | "periodic" = "periodic"): Promise<number> {
    if (!this.options.isLeader()) return 0;
    const immediate = mode === "startup" && this.options.recoverAtStartupImmediately;
    const graceMs = this.options.queueMode ? QUEUE_RECOVERY_GRACE_MS : this.options.resumeStaleAfterMs;
    const before = immediate ? undefined : new Date(this.now().getTime() - graceMs).toISOString();
    let recovered = 0;
    for (const { id: executionId } of await this.store.listResumingWorkflowExecutions(before)) {
      if (this.options.isResumeActive(executionId)) continue;
      const pending = await this.store.getWorkflowExecutionState(executionId);
      const state = pending?.state as WorkflowExecutionState | null | undefined;
      const waitingNodeId = state && typeof state === "object" && state.workflow ? resolvePendingApproval(state).nodeId : null;
      // The decision must belong to the pause the run is in now, never to an earlier one.
      const latest = (await this.store.listApprovalRequestsForExecution(executionId)).at(-1);
      if (!latest || !DECIDED_STATUSES.has(latest.status) || !waitingNodeId || latest.nodeId !== waitingNodeId) {
        await this.store.releaseWorkflowExecutionClaim(executionId);
        continue;
      }
      if (this.options.queueMode && await this.store.hasActiveQueueItem(`${executionId}:${latest.id}`)) continue;
      recovered += 1;
      const decision: ApprovalDecisionValue = approvalDecisionOf(latest.status) ?? "timeout";
      const job: ApprovalResumeJob = {
        executionId,
        requestId: latest.id,
        decision,
        actedBy: latest.decidedBy ?? SYSTEM_ACTOR,
        actorUserId: latest.decidedByUserId,
        ...(latest.reason ? { reason: latest.reason } : {}),
        ...(latest.edits ? { edits: latest.edits, editedFields: latest.editedFields } : {}),
        ...(this.options.queueMode ? { retryTag: this.now().getTime().toString(36) } : {})
      };
      this.log("info", "Re-driving an interrupted approval resume", { executionId, requestId: latest.id });
      this.options.dispatch(job).catch(async (error) => {
        await this.reopenAfterFailedResume(job);
        this.log("warn", "Recovering an interrupted approval resume failed", { executionId, error: error instanceof Error ? error.message : String(error) });
      });
    }
    return recovered;
  }

  /** Marks the run's pending request canceled (the run was canceled). */
  /**
   * Cancels the run's pending request. "decided": a request was pending when read but a decision took it before
   * the cancel did, so the run belongs to that decision. "none": the run had no pending request.
   */
  async cancelForExecution(executionId: string, reason: string, user?: SafeUser | null): Promise<"canceled" | "decided" | "none"> {
    const pending = await this.store.getPendingApprovalRequestForExecution(executionId);
    const canceled = await this.store.cancelPendingApprovalRequests({ executionId }, reason);
    if (canceled === 0) return pending ? "decided" : "none";
    if (pending) await this.auditCanceled(pending, user);
    return "canceled";
  }

  /** Audits requests another write already canceled (the run cancel's own transaction cancels any still pending). */
  async auditCanceledRequests(requestIds: readonly string[], user?: SafeUser | null): Promise<void> {
    for (const id of requestIds) {
      const record = await this.store.getApprovalRequest(id);
      if (record) await this.auditCanceled(record, user);
    }
  }

  private async auditCanceled(record: ApprovalRequestRecord, user?: SafeUser | null): Promise<void> {
    await this.options.audit({
      category: "approval",
      eventType: "approval.canceled",
      action: "cancel",
      outcome: "success",
      actor: user ? { userId: user.id, email: user.email, type: "user" } : { type: "system", email: SYSTEM_ACTOR },
      resourceType: "workflow",
      resourceId: record.workflowId,
      projectId: await this.currentProjectId(record),
      metadata: this.auditMetadata(record)
    });
  }

  /** Startup: backfill, recover interrupted resumes and expire what is overdue; then sweep on a timer. */
  async start(): Promise<void> {
    if (this.timer) return;
    try {
      await this.backfillMissing();
      await this.recoverInterrupted("startup");
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
