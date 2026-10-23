/**
 * Phase 15.4 — release gate and publish.
 *
 * A workflow's published version is what production traffic runs; the draft
 * (the workflow as saved) is what the editor, manual runs and
 * `/webhook-test/` run. `resolveRunnableWorkflow(id, channel)` is the one
 * place every entry point asks which one to run. Without a published version
 * both channels run the draft, exactly as before releases existed.
 *
 * Publishing a version (`publish`):
 *   - always needs `workflow:publish` on the workflow;
 *   - with the gate off, publishes at once (`ungated`);
 *   - with the gate on, binds to the exact hash of that saved version (the
 *     same hash replay jobs record for their candidate) and to a completed
 *     replay job for that hash over the gate's golden sets, judged again by
 *     `judgeReleaseGate` under the policy in force now, so loosening the
 *     policy after the job is visible in the audit trail;
 *   - a gate that requires approval, or a blocked publish sent with
 *     `requestApproval`, becomes a release request in the approvals inbox;
 *   - an admin may override a blocked gate with a reason.
 *
 * A release request is decided by an approver who can read the workflow,
 * holds `workflow:publish` on it (so approvers are project-scoped) and
 * satisfies the gate's approver list and self-approval rule. Approving
 * publishes exactly the requested version and hash as the approver. The
 * request is stale (refused with 409 and canceled) when, since it was made,
 * the version's hash changed (the workflow moved project), the gate's
 * settings changed, or another version was published.
 *
 * Every gate change, publish, override, rollback and release-request event is
 * audited (category `release`). Release tables need the SQLite store; on
 * Postgres the routes answer 501 and every channel runs the draft.
 */

import { randomUUID } from "node:crypto";
import {
  RELEASE_APPROVAL_REQUEST_PREFIX,
  aggregateReleaseRepeats,
  checkApprover,
  defaultReleaseGate,
  judgeReleaseGate,
  releaseApproversSchema,
  releaseCandidateOptionsSchema,
  releaseGateLoosening,
  releaseGatePolicySchema,
  releaseGateSettingsSchema,
  type EvalCaseDetail,
  type EvalCaseResult,
  type EvalRunView,
  type ReleaseApprovalRequestView,
  type ReleaseApprovers,
  type ReleaseAggregateMode,
  type ReleaseCaseStatus,
  type ReleaseChannel,
  type ReleaseGateCase,
  type ReleaseGateEvidence,
  type ReleaseGateJudgement,
  type ReleaseGateSettingsInput,
  type ReleaseGateView,
  type ReleasePublishInput,
  type ReleaseRollbackInput,
  type ReleaseStateView,
  type ReleaseVerdict,
  type Workflow,
  type WorkflowRelease
} from "@ai-orchestrator/shared";
import type { ReleaseApprovalRequestRecord, ReleaseGateRecord, SqliteStore, WorkflowReleaseRecord } from "../db/database.js";
import type { AuditEventInput } from "./audit-service.js";
import type { SafeUser } from "./auth-service.js";
import type { NotificationEvent } from "./notification-service.js";
import type { RunAccessResult } from "../run-access.js";

export type ReleasePermission = "workflow:read" | "workflow:write" | "workflow:publish";

export class ReleaseError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 403 | 404 | 409 | 501,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ReleaseError";
  }
}

type JobView = EvalRunView & { results: EvalCaseResult[] };

export interface ReleaseServiceOptions {
  store: SqliteStore;
  /** False on stores without release tables (Postgres in this release): every channel runs the draft. */
  available: boolean;
  /**
   * A saved version as a runnable workflow, under the workflow's current
   * project and folder: the same candidate a replay job builds for it.
   * Throws when the version does not exist.
   */
  resolveVersion: (workflowId: string, version: number) => Workflow;
  /** The candidate hash replay jobs record (workflowForHash + canonical JSON). */
  hashOf: (workflow: Workflow) => string;
  loadJob: (runId: string) => JobView | null;
  loadCase: (runId: string, resultId: string) => EvalCaseDetail | null;
  recordingCreatedAt: (recordingId: string) => string | null;
  /** The shared run-access check (run-access.ts): 404 unreadable, 403 without the permission; admins pass. */
  access: (user: SafeUser, workflowId: string, permission: ReleasePermission) => RunAccessResult<object>;
  readableWorkflowIds: (user: SafeUser) => string[] | null;
  audit: (event: AuditEventInput) => void;
  notify: (event: NotificationEvent) => Promise<void>;
  redact: (value: string) => string;
  /** Called after the published version moved: schedules and app triggers re-register from it. */
  onPublished: (workflowId: string) => void;
  appPublicUrl?: string;
  logger?: { warn: (message: string, fields?: Record<string, unknown>) => void };
  now?: () => Date;
}

export type PublishOutcome =
  | { status: 200; release: WorkflowRelease }
  | { status: 202; verdict: "needs_approval"; approvalRequestId: string; reasons: string[] }
  | { status: 409; verdict: "blocked"; reasons: string[]; replayRunId?: string; canRequestApproval: boolean };

const SELF_APPROVAL_MESSAGE = "You asked for this release, and this gate does not allow approving your own release.";
const SAFE_MCP_SERVER_MODES = new Set(["strict", "lenient", "live_read_only"]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function caseStatus(status: string): ReleaseCaseStatus {
  return status === "pass" || status === "fail" || status === "error" || status === "skipped" ? status : "error";
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Whether a job's options or candidate let any call write for real: unknown modes count as write. */
export function replayJobAllowsLiveWrites(run: Pick<EvalRunView, "options" | "candidate">): boolean {
  for (const source of [asRecord(run.options), asRecord(asRecord(run.candidate).overrides), asRecord(asRecord(run.options).overrides)]) {
    const servers = asRecord(source.mcpServers);
    if (Object.values(servers).some((mode) => typeof mode !== "string" || !SAFE_MCP_SERVER_MODES.has(mode))) return true;
    if (source.mcpMode !== undefined && (typeof source.mcpMode !== "string" || !SAFE_MCP_SERVER_MODES.has(source.mcpMode))) return true;
    for (const key of ["liveWriteNodes", "liveNodes", "liveWrites"]) {
      const value = source[key];
      if (value === true || (Array.isArray(value) && value.length > 0)) return true;
    }
  }
  return false;
}

export class ReleaseService {
  constructor(private readonly options: ReleaseServiceOptions) {}

  get available(): boolean {
    return this.options.available;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private get store(): SqliteStore {
    return this.options.store;
  }

  private requireAvailable(): void {
    if (!this.options.available) throw new ReleaseError("Releases need the SQLite store in this release", 501);
  }

  private check(user: SafeUser, workflowId: string, permission: ReleasePermission): void {
    const result = this.options.access(user, workflowId, permission);
    if (!result.ok) throw new ReleaseError(result.error, result.status);
  }

  // -------------------------------------------------------------------------
  // Which version runs
  // -------------------------------------------------------------------------

  /**
   * The workflow an entry point runs: the published version for `production`
   * when one is set, otherwise the draft. A published version whose snapshot
   * is gone or unreadable fails closed (null), so production never falls back
   * to an unreviewed draft.
   */
  resolveRunnableWorkflow(workflowId: string, channel: ReleaseChannel): Workflow | null {
    const draft = this.store.getWorkflow(workflowId);
    if (!draft || channel === "draft" || !this.options.available) return draft;
    const published = this.store.getPublishedVersion(workflowId);
    if (published === null) return draft;
    try {
      return this.options.resolveVersion(workflowId, published);
    } catch (error) {
      this.options.logger?.warn("The published version of a workflow could not be loaded; production traffic is refused", {
        workflowId,
        version: published,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  /** The published version of a workflow, or null (gate off: the draft runs everywhere). */
  publishedVersion(workflowId: string): number | null {
    return this.options.available ? this.store.getPublishedVersion(workflowId) : null;
  }

  state(user: SafeUser, workflowId: string): ReleaseStateView {
    this.check(user, workflowId, "workflow:read");
    const draftVersion = this.store.maxWorkflowVersionNumber(workflowId) || null;
    const publishedVersion = this.publishedVersion(workflowId);
    const gate = this.options.available ? this.store.getReleaseGate(workflowId) : null;
    const aheadBy = publishedVersion !== null && draftVersion !== null ? Math.max(0, draftVersion - publishedVersion) : 0;
    return { draftVersion, publishedVersion, aheadBy, gateEnabled: gate?.enabled ?? false, gateEnforced: gate?.enforced ?? false };
  }

  // -------------------------------------------------------------------------
  // Gate settings
  // -------------------------------------------------------------------------

  private settingsOf(record: ReleaseGateRecord | null, workflowId: string): ReleaseGateView {
    if (!record) return defaultReleaseGate(workflowId);
    const policy = releaseGatePolicySchema.safeParse(record.policy);
    const candidateOptions = releaseCandidateOptionsSchema.safeParse(record.candidateOptions);
    const approvers = record.approvers ? releaseApproversSchema.safeParse(record.approvers) : null;
    return {
      workflowId,
      enabled: record.enabled,
      enforced: record.enforced,
      datasetIds: record.datasetIds,
      candidateOptions: candidateOptions.success ? candidateOptions.data : {},
      // A stored policy that no longer parses is read as the strictest default.
      policy: policy.success ? policy.data : releaseGatePolicySchema.parse({}),
      requireApproval: record.requireApproval,
      approvers: approvers && approvers.success ? approvers.data : null,
      updatedAt: record.updatedAt,
      updatedBy: record.updatedBy
    };
  }

  gate(user: SafeUser, workflowId: string): ReleaseGateView {
    this.requireAvailable();
    this.check(user, workflowId, "workflow:read");
    return this.settingsOf(this.store.getReleaseGate(workflowId), workflowId);
  }

  /**
   * Saves the gate. Builders (`workflow:write`) configure an unenforced gate;
   * only admins set or clear `enforced`, and on an enforced gate builders may
   * not disable or loosen anything (403 with the reasons). Every golden set
   * must be this workflow's.
   */
  updateGate(user: SafeUser, workflowId: string, input: ReleaseGateSettingsInput): ReleaseGateView {
    this.requireAvailable();
    this.check(user, workflowId, "workflow:write");
    const parsed = releaseGateSettingsSchema.safeParse(input);
    if (!parsed.success) throw new ReleaseError("Invalid gate settings", 400, { issues: parsed.error.issues });
    const next = parsed.data;
    const current = this.settingsOf(this.store.getReleaseGate(workflowId), workflowId);
    const isAdmin = user.role === "admin";
    const enforced = next.enforced ?? current.enforced;
    if (enforced !== current.enforced && !isAdmin) throw new ReleaseError("Only admins can enforce a gate or lift enforcement", 403);
    if (current.enforced && !isAdmin) {
      const loosening = releaseGateLoosening(current, next);
      if (loosening.length > 0) {
        throw new ReleaseError(`This gate is enforced: only admins can loosen it (the change ${loosening.join(", ")})`, 403, { loosening });
      }
    }
    for (const datasetId of next.datasetIds) {
      const dataset = this.store.getEvalDataset(datasetId);
      if (!dataset || dataset.workflowId !== workflowId) throw new ReleaseError(`Golden set ${datasetId} is not one of this workflow's golden sets`, 400);
    }
    const saved = this.store.upsertReleaseGate({
      workflowId,
      enabled: next.enabled,
      enforced,
      datasetIds: next.datasetIds,
      candidateOptions: next.candidateOptions,
      policy: next.policy,
      requireApproval: next.requireApproval,
      approvers: next.approvers,
      updatedAt: this.now().toISOString(),
      updatedBy: user.email
    });
    const view = this.settingsOf(saved, workflowId);
    this.options.audit({
      category: "release",
      eventType: "release.gate.updated",
      action: "update",
      outcome: "success",
      actor: { userId: user.id, email: user.email, type: "user" },
      resourceType: "workflow",
      resourceId: workflowId,
      projectId: this.projectOf(workflowId),
      metadata: {
        enabled: view.enabled,
        enforced: view.enforced,
        datasetIds: view.datasetIds,
        policy: view.policy,
        requireApproval: view.requireApproval,
        approvers: view.approvers ? { roles: view.approvers.approverRoles, users: view.approvers.approverUsers.length, allowSelfApproval: view.approvers.allowSelfApproval } : null,
        loosened: releaseGateLoosening(current, next),
        enforcedChanged: enforced !== current.enforced
      }
    });
    return view;
  }

  private projectOf(workflowId: string): string | null {
    return this.store.getWorkflow(workflowId)?.projectId ?? null;
  }

  // -------------------------------------------------------------------------
  // Judging
  // -------------------------------------------------------------------------

  /** The version as it would run, and its hash; 404 when it does not exist. */
  versionCandidate(workflowId: string, version: number): { workflow: Workflow; workflowHash: string } {
    if (!this.store.getWorkflowVersion(workflowId, version)) throw new ReleaseError(`Version ${version} of this workflow was not found`, 404);
    let workflow: Workflow;
    try {
      workflow = this.options.resolveVersion(workflowId, version);
    } catch (error) {
      throw new ReleaseError(error instanceof Error ? error.message : `Version ${version} could not be read`, 404);
    }
    return { workflow, workflowHash: this.options.hashOf(workflow) };
  }

  /** What `judgeReleaseGate` needs from a replay job: its cases with repeats aggregated. */
  evidenceFor(job: JobView): ReleaseGateEvidence {
    const options = asRecord(job.options);
    const aggregate = (typeof options.aggregate === "string" ? options.aggregate : "all") as ReleaseAggregateMode;
    const groups = new Map<string, Array<EvalCaseResult & Record<string, unknown>>>();
    for (const result of job.results as Array<EvalCaseResult & Record<string, unknown>>) {
      // A baseline rerun's own results are compared with, not judged.
      if (result.role === "baseline" || result.baseline === true) continue;
      const key = result.fixtureId || result.recordingId || result.id;
      const list = groups.get(key) ?? [];
      list.push(result);
      groups.set(key, list);
    }
    const cases: ReleaseGateCase[] = [];
    for (const [key, results] of groups) {
      const status = aggregateReleaseRepeats(results.map((result) => caseStatus(result.status)), aggregate);
      const scorerPass = new Map<string, boolean>();
      for (const result of results) {
        for (const detail of result.score?.details ?? []) {
          scorerPass.set(detail.type, (scorerPass.get(detail.type) ?? true) && detail.pass);
        }
      }
      // Repeats: the baseline is the same for every repeat; the candidate counts at its most expensive and slowest.
      let costBaseline: number | null = null;
      let latencyBaseline: number | null = null;
      const costs: number[] = [];
      const latencies: number[] = [];
      let newGuardBlocks = 0;
      const blocking = (action: string) => action === "block" || action === "review";
      for (const result of results) {
        const diff = this.options.loadCase(job.id, result.id)?.replay?.diff;
        if (!diff) continue;
        costBaseline = numberOrNull(diff.totals.costUsd.baseline) ?? costBaseline;
        latencyBaseline = numberOrNull(diff.totals.latencyMs.baseline) ?? latencyBaseline;
        const cost = numberOrNull(diff.totals.costUsd.candidate);
        if (cost !== null) costs.push(cost);
        const latency = numberOrNull(diff.totals.latencyMs.candidate);
        if (latency !== null) latencies.push(latency);
        const added = diff.guard.added.filter((verdict) => !verdict.shadow && blocking(verdict.effectiveAction)).length;
        const escalated = diff.guard.changed.filter((change) => !change.candidate.shadow && blocking(change.candidate.effectiveAction) && !blocking(change.baseline.effectiveAction)).length;
        newGuardBlocks = Math.max(newGuardBlocks, added + escalated);
      }
      const costCandidate = costs.length > 0 ? Math.max(...costs) : null;
      const latencyCandidate = latencies.length > 0 ? Math.max(...latencies) : null;
      const first = results[0]!;
      const baseline = typeof first.baselineStatus === "string" ? caseStatus(first.baselineStatus) : null;
      cases.push({
        id: key,
        status,
        baselineStatus: baseline,
        scorers: [...scorerPass].map(([type, pass]) => ({ type, pass })),
        costUsd: { baseline: costBaseline, candidate: costCandidate },
        latencyMs: { baseline: latencyBaseline, candidate: latencyCandidate },
        newGuardBlocks,
        recordingCreatedAt: first.recordingId ? this.options.recordingCreatedAt(first.recordingId) : null
      });
    }
    const candidate = asRecord(job.candidate);
    return {
      job: {
        id: job.id,
        status: job.status,
        workflowHash: typeof candidate.workflowHash === "string" ? candidate.workflowHash : null,
        datasetIds: job.datasetIds,
        compare: typeof options.compare === "string" ? options.compare : null,
        mcpMode: typeof options.mcpMode === "string" ? options.mcpMode : null,
        liveWrites: replayJobAllowsLiveWrites(job)
      },
      cases
    };
  }

  /**
   * Judges the job (the given one, else the newest completed job for this
   * hash that passes, else the newest one) under the gate's current policy.
   */
  judge(gate: ReleaseGateView, workflowId: string, workflowHash: string, replayRunId?: string): { judgement: ReleaseGateJudgement; replayRunId?: string } {
    const expected = { workflowHash, datasetIds: gate.datasetIds, ...(gate.candidateOptions.mcpMode ? { mcpMode: gate.candidateOptions.mcpMode } : {}) };
    const judgeJob = (job: JobView) => judgeReleaseGate(this.evidenceFor(job), gate.policy, { expected, requireApproval: gate.requireApproval, now: this.now() });
    if (replayRunId) {
      const job = this.options.loadJob(replayRunId);
      if (!job || job.kind !== "replay" || job.workflowId !== workflowId) throw new ReleaseError("Replay job not found", 404);
      return { judgement: judgeJob(job), replayRunId: job.id };
    }
    let newest: { judgement: ReleaseGateJudgement; replayRunId: string } | null = null;
    for (const id of this.store.listReplayRunIdsForHash(workflowId, workflowHash)) {
      const job = this.options.loadJob(id);
      if (!job || job.status !== "completed") continue;
      const judged = { judgement: judgeJob(job), replayRunId: job.id };
      if (judged.judgement.verdict !== "blocked") return judged;
      newest ??= judged;
    }
    return newest ?? { judgement: judgeReleaseGate(null, gate.policy, { expected, now: this.now() }) };
  }

  /** The publish dialog's preview: the verdict publishing would get now. */
  preview(user: SafeUser, workflowId: string, version: number, replayRunId?: string) {
    this.requireAvailable();
    this.check(user, workflowId, "workflow:read");
    const gate = this.settingsOf(this.store.getReleaseGate(workflowId), workflowId);
    const { workflowHash } = this.versionCandidate(workflowId, version);
    if (!gate.enabled) return { version, workflowHash, gateEnabled: false, verdict: "passed" as const, reasons: [], replayRunId: null, stats: null, canRequestApproval: false };
    const { judgement, replayRunId: judgedRun } = this.judge(gate, workflowId, workflowHash, replayRunId);
    return {
      version,
      workflowHash,
      gateEnabled: true,
      verdict: judgement.verdict,
      reasons: judgement.reasons,
      replayRunId: judgedRun ?? null,
      stats: judgement.stats,
      canRequestApproval: Boolean(gate.approvers)
    };
  }

  // -------------------------------------------------------------------------
  // Publish and rollback
  // -------------------------------------------------------------------------

  private toRelease(record: WorkflowReleaseRecord): WorkflowRelease {
    const approval = record.approval;
    return {
      id: record.id,
      workflowId: record.workflowId,
      version: record.version,
      workflowHash: record.workflowHash,
      previousVersion: record.previousVersion,
      replayRunId: record.replayRunId,
      verdict: record.verdict as ReleaseVerdict,
      reason: record.reason ? this.options.redact(record.reason) : null,
      gateReasons: record.gateReasons,
      approval: approval
        ? {
            requestId: String(approval.requestId ?? ""),
            requestedBy: typeof approval.requestedBy === "string" ? approval.requestedBy : null,
            decidedBy: typeof approval.decidedBy === "string" ? approval.decidedBy : null,
            decidedAt: typeof approval.decidedAt === "string" ? approval.decidedAt : null
          }
        : null,
      publishedAt: record.publishedAt,
      publishedBy: record.publishedBy
    };
  }

  releases(user: SafeUser, workflowId: string, limit?: number): { releases: WorkflowRelease[]; publishedVersion: number | null } {
    this.requireAvailable();
    this.check(user, workflowId, "workflow:read");
    return {
      releases: this.store.listWorkflowReleases(workflowId, limit).map((record) => this.toRelease(record)),
      publishedVersion: this.store.getPublishedVersion(workflowId)
    };
  }

  private commitRelease(input: {
    actor: SafeUser;
    workflowId: string;
    version: number;
    workflowHash: string;
    verdict: ReleaseVerdict;
    replayRunId: string | null;
    reason: string | null;
    gateReasons: string[];
    approval: Record<string, unknown> | null;
    expectedPrevious: number | null;
  }): WorkflowRelease {
    const record = this.store.publishWorkflowVersion(
      {
        id: `rel_${randomUUID()}`,
        workflowId: input.workflowId,
        version: input.version,
        workflowHash: input.workflowHash,
        replayRunId: input.replayRunId,
        verdict: input.verdict,
        reason: input.reason,
        gateReasons: input.gateReasons,
        approval: input.approval,
        publishedAt: this.now().toISOString(),
        publishedBy: input.actor.email,
        publishedByUserId: input.actor.id
      },
      input.expectedPrevious
    );
    if (!record) throw new ReleaseError("Another release was published at the same time; reload and try again", 409);
    const release = this.toRelease(record);
    this.options.audit({
      category: "release",
      eventType: input.verdict === "rollback" ? "release.rolled_back" : input.verdict === "overridden" ? "release.overridden" : "release.published",
      action: input.verdict === "rollback" ? "rollback" : "publish",
      outcome: "success",
      actor: { userId: input.actor.id, email: input.actor.email, type: "user" },
      resourceType: "workflow",
      resourceId: input.workflowId,
      projectId: this.projectOf(input.workflowId),
      metadata: {
        releaseId: release.id,
        version: release.version,
        previousVersion: release.previousVersion,
        workflowHash: release.workflowHash,
        verdict: release.verdict,
        replayRunId: release.replayRunId,
        reason: release.reason,
        gateReasons: release.gateReasons,
        approvalRequestId: input.approval?.requestId ?? null
      }
    });
    try {
      this.options.onPublished(input.workflowId);
    } catch (error) {
      this.options.logger?.warn("Re-registering triggers after a release failed", { workflowId: input.workflowId, error: error instanceof Error ? error.message : String(error) });
    }
    return release;
  }

  publish(user: SafeUser, workflowId: string, input: ReleasePublishInput): PublishOutcome {
    this.requireAvailable();
    this.check(user, workflowId, "workflow:publish");
    const { workflowHash } = this.versionCandidate(workflowId, input.version);
    const gate = this.settingsOf(this.store.getReleaseGate(workflowId), workflowId);
    const previous = this.store.getPublishedVersion(workflowId);
    if (input.workflowHash && input.workflowHash !== workflowHash) {
      return {
        status: 409,
        verdict: "blocked",
        reasons: [`Version ${input.version} has hash ${workflowHash}, not the ${input.workflowHash} given: the version is not what was tested.`],
        canRequestApproval: false
      };
    }
    if (input.override && user.role !== "admin") throw new ReleaseError("Only admins can override the release gate", 403);
    if (!gate.enabled) {
      return {
        status: 200,
        release: this.commitRelease({ actor: user, workflowId, version: input.version, workflowHash, verdict: "ungated", replayRunId: null, reason: null, gateReasons: [], approval: null, expectedPrevious: previous })
      };
    }
    const { judgement, replayRunId } = this.judge(gate, workflowId, workflowHash, input.replayRunId);
    if (judgement.verdict === "passed") {
      return {
        status: 200,
        release: this.commitRelease({ actor: user, workflowId, version: input.version, workflowHash, verdict: "passed", replayRunId: replayRunId ?? null, reason: null, gateReasons: [], approval: null, expectedPrevious: previous })
      };
    }
    if (input.override) {
      return {
        status: 200,
        release: this.commitRelease({
          actor: user,
          workflowId,
          version: input.version,
          workflowHash,
          verdict: "overridden",
          replayRunId: replayRunId ?? null,
          reason: input.override.reason,
          gateReasons: judgement.reasons,
          approval: null,
          expectedPrevious: previous
        })
      };
    }
    const canRequestApproval = Boolean(gate.approvers);
    if (judgement.verdict === "needs_approval" || (input.requestApproval && canRequestApproval)) {
      const request = this.requestApproval({
        user,
        workflowId,
        version: input.version,
        workflowHash,
        replayRunId: replayRunId ?? null,
        origin: judgement.verdict === "needs_approval" ? "policy" : "blocked",
        gate,
        reasons: judgement.verdict === "needs_approval" ? [] : judgement.reasons,
        requestReason: input.requestApproval?.reason ?? null,
        publishedVersion: previous
      });
      return { status: 202, verdict: "needs_approval", approvalRequestId: request.id, reasons: judgement.reasons };
    }
    this.options.audit({
      category: "release",
      eventType: "release.blocked",
      action: "publish",
      outcome: "denied",
      actor: { userId: user.id, email: user.email, type: "user" },
      resourceType: "workflow",
      resourceId: workflowId,
      projectId: this.projectOf(workflowId),
      metadata: { version: input.version, workflowHash, replayRunId: replayRunId ?? null, reasons: judgement.reasons }
    });
    return {
      status: 409,
      verdict: "blocked",
      reasons: input.requestApproval && !canRequestApproval ? [...judgement.reasons, "This gate has no approvers, so the publish cannot be sent for approval."] : judgement.reasons,
      ...(replayRunId ? { replayRunId } : {}),
      canRequestApproval
    };
  }

  /** Back to a version that was published before; the gate is skipped because that version was released once. */
  rollback(user: SafeUser, workflowId: string, input: ReleaseRollbackInput): WorkflowRelease {
    this.requireAvailable();
    this.check(user, workflowId, "workflow:publish");
    const previous = this.store.getPublishedVersion(workflowId);
    if (previous === input.version) throw new ReleaseError(`Version ${input.version} is already published`, 409);
    if (!this.store.hasReleasedVersion(workflowId, input.version)) {
      throw new ReleaseError(`Version ${input.version} was never published, so it cannot be rolled back to; publish it instead`, 409);
    }
    const { workflowHash } = this.versionCandidate(workflowId, input.version);
    return this.commitRelease({ actor: user, workflowId, version: input.version, workflowHash, verdict: "rollback", replayRunId: null, reason: input.reason, gateReasons: [], approval: null, expectedPrevious: previous });
  }

  // -------------------------------------------------------------------------
  // Release requests (the approvals inbox)
  // -------------------------------------------------------------------------

  private requestApproval(input: {
    user: SafeUser;
    workflowId: string;
    version: number;
    workflowHash: string;
    replayRunId: string | null;
    origin: "policy" | "blocked";
    gate: ReleaseGateView;
    reasons: string[];
    requestReason: string | null;
    publishedVersion: number | null;
  }): ReleaseApprovalRequestRecord {
    const existing = this.store.findPendingReleaseApprovalRequest(input.workflowId, input.version, input.workflowHash);
    if (existing && !this.staleReason(existing) && !this.expired(existing)) return existing;
    const approvers: ReleaseApprovers = input.gate.approvers ?? releaseApproversSchema.parse({});
    const createdAt = this.now();
    const workflow = this.store.getWorkflow(input.workflowId);
    const record = this.store.insertReleaseApprovalRequest({
      id: `${RELEASE_APPROVAL_REQUEST_PREFIX}${randomUUID()}`,
      workflowId: input.workflowId,
      workflowName: workflow?.name ?? null,
      projectId: workflow?.projectId ?? "default",
      version: input.version,
      workflowHash: input.workflowHash,
      replayRunId: input.replayRunId,
      origin: input.origin,
      gateReasons: input.reasons,
      gateUpdatedAt: input.gate.updatedAt,
      publishedVersionAtRequest: input.publishedVersion,
      spec: { approverRoles: approvers.approverRoles, approverUsers: approvers.approverUsers, allowSelfApproval: approvers.allowSelfApproval },
      status: "pending",
      requestReason: input.requestReason,
      requestedByUserId: input.user.id,
      requestedBy: input.user.email,
      expiresAt: new Date(createdAt.getTime() + approvers.timeoutMinutes * 60_000).toISOString(),
      decidedByUserId: null,
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
      releaseId: null,
      createdAt: createdAt.toISOString(),
      updatedAt: createdAt.toISOString()
    });
    this.options.audit({
      category: "release",
      eventType: "release.approval.requested",
      action: "request",
      outcome: "success",
      actor: { userId: input.user.id, email: input.user.email, type: "user" },
      resourceType: "workflow",
      resourceId: input.workflowId,
      projectId: record.projectId,
      metadata: {
        requestId: record.id,
        version: record.version,
        workflowHash: record.workflowHash,
        replayRunId: record.replayRunId,
        origin: record.origin,
        gateReasons: record.gateReasons,
        reason: record.requestReason ? this.options.redact(record.requestReason) : null,
        approverRoles: approvers.approverRoles,
        approverUsers: approvers.approverUsers.length
      }
    });
    const base = this.options.appPublicUrl?.replace(/\/+$/, "");
    // Channels are not project-scoped: only the workflow, version and approvers go out, never the reasons.
    this.options
      .notify({
        type: "approval.requested",
        workflowId: record.workflowId,
        workflowName: record.workflowName ?? record.workflowId,
        timestamp: createdAt.toISOString(),
        release: { version: record.version },
        approval: {
          requestId: record.id,
          nodeId: `release:v${record.version}`,
          expiresAt: record.expiresAt,
          approvers: [...approvers.approverRoles.map((role) => `role ${role}`), ...approvers.approverUsers].join(", ") || "anyone else who may publish",
          ...(base ? { link: `${base}/?mode=approvals&request=${encodeURIComponent(record.id)}` } : {})
        }
      })
      .catch((error) => this.options.logger?.warn("Release request notification failed", { error: error instanceof Error ? error.message : String(error) }));
    return record;
  }

  private expired(record: ReleaseApprovalRequestRecord): boolean {
    return Boolean(record.expiresAt && Date.parse(record.expiresAt) <= this.now().getTime());
  }

  /** Why approving this request now would publish something other than what was asked; null when it is still valid. */
  staleReason(record: ReleaseApprovalRequestRecord): string | null {
    let hash: string;
    try {
      hash = this.versionCandidate(record.workflowId, record.version).workflowHash;
    } catch {
      return `Version ${record.version} no longer exists.`;
    }
    if (hash !== record.workflowHash) return `Version ${record.version} no longer has the hash that was asked for (the workflow moved project).`;
    const gate = this.store.getReleaseGate(record.workflowId);
    if ((gate?.updatedAt ?? null) !== record.gateUpdatedAt) return "The release gate's settings changed after the request was made.";
    if (this.store.getPublishedVersion(record.workflowId) !== record.publishedVersionAtRequest) return "Another version was published after the request was made.";
    return null;
  }

  private personCheck(record: ReleaseApprovalRequestRecord, user: SafeUser): { allowed: true } | { allowed: false; code: string; message: string } {
    if (!this.options.access(user, record.workflowId, "workflow:publish").ok) {
      return { allowed: false, code: "project_access", message: "You may not publish this workflow, so you cannot approve its releases." };
    }
    const spec = asRecord(record.spec);
    const check = checkApprover(
      {
        approverRoles: (Array.isArray(spec.approverRoles) ? spec.approverRoles : []) as ReleaseApprovers["approverRoles"],
        approverUsers: (Array.isArray(spec.approverUsers) ? spec.approverUsers : []) as string[],
        allowSelfApproval: spec.allowSelfApproval === true
      },
      { id: user.id, email: user.email, role: user.role },
      { userId: record.requestedByUserId, email: record.requestedBy }
    );
    if (check.allowed) return { allowed: true };
    return { allowed: false, code: check.code, message: check.code === "self_approval" ? SELF_APPROVAL_MESSAGE : check.message };
  }

  private toView(record: ReleaseApprovalRequestRecord, user: SafeUser): ReleaseApprovalRequestView {
    const spec = asRecord(record.spec);
    const status = record.status === "pending" && this.expired(record) ? "timed_out" : record.status;
    const check = status === "pending" ? this.personCheck(record, user) : { allowed: false as const, message: "Already decided." };
    return {
      kind: "release",
      requestId: record.id,
      id: record.id,
      workflowId: record.workflowId,
      workflowName: record.workflowName,
      projectId: this.store.getWorkflow(record.workflowId)?.projectId ?? record.projectId,
      status: status as ReleaseApprovalRequestView["status"],
      message: record.origin === "policy" ? `Publish version ${record.version}: this gate needs an approver for every release.` : `Publish version ${record.version} although the release gate blocked it.`,
      version: record.version,
      workflowHash: record.workflowHash,
      replayRunId: record.replayRunId,
      origin: record.origin,
      gateReasons: record.gateReasons,
      requestReason: record.requestReason ? this.options.redact(record.requestReason) : null,
      approverRoles: (Array.isArray(spec.approverRoles) ? spec.approverRoles : []) as string[],
      approverUsers: (Array.isArray(spec.approverUsers) ? spec.approverUsers : []) as string[],
      allowSelfApproval: spec.allowSelfApproval === true,
      requestedBy: record.requestedBy,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      decidedBy: record.decidedBy,
      decidedAt: record.decidedAt,
      reason: record.decisionReason ? this.options.redact(record.decisionReason) : null,
      releaseId: record.releaseId,
      canDecide: check.allowed,
      cannotDecideReason: check.allowed ? null : check.message
    };
  }

  /** Release requests of workflows the user can read, narrowed in SQL before the limit. */
  listRequests(user: SafeUser, filter: { status: "pending" | "decided" | "all"; workflowId?: string; limit?: number }): ReleaseApprovalRequestView[] {
    if (!this.options.available) return [];
    const workflowIds = this.options.readableWorkflowIds(user);
    const rows = this.store.listReleaseApprovalRequests({ ...filter, scope: workflowIds === null ? { all: true } : { workflowIds } });
    const views: ReleaseApprovalRequestView[] = [];
    for (const row of rows) {
      if (!this.options.access(user, row.workflowId, "workflow:read").ok) continue;
      const view = this.toView(row, user);
      // An expired request is decided (timed out) for the inbox's filters.
      if (filter.status === "pending" && view.status !== "pending") continue;
      views.push(view);
    }
    return views;
  }

  private closeRequest(record: ReleaseApprovalRequestRecord, status: "canceled" | "timed_out", reason: string, actor: SafeUser | null): void {
    if (!this.store.decideReleaseApprovalRequest({ id: record.id, status, decisionReason: reason, decidedByUserId: actor?.id ?? null, decidedBy: actor?.email ?? "system" })) return;
    this.options.audit({
      category: "release",
      eventType: status === "timed_out" ? "release.approval.timed_out" : "release.approval.canceled",
      action: status === "timed_out" ? "timeout" : "cancel",
      outcome: "success",
      actor: actor ? { userId: actor.id, email: actor.email, type: "user" } : { type: "system", email: "system" },
      resourceType: "workflow",
      resourceId: record.workflowId,
      projectId: this.projectOf(record.workflowId),
      metadata: { requestId: record.id, version: record.version, workflowHash: record.workflowHash, reason }
    });
  }

  /**
   * Decides a release request. Approving publishes exactly the requested
   * version and hash, as the approver; the decision and the release commit
   * together. Throws a `ReleaseError` with the HTTP status when refused.
   */
  decide(user: SafeUser, requestId: string, decision: "approve" | "reject", reason?: string): { request: ReleaseApprovalRequestView; release: WorkflowRelease | null } {
    this.requireAvailable();
    const record = this.store.getReleaseApprovalRequest(requestId);
    if (!record || !this.options.access(user, record.workflowId, "workflow:read").ok) throw new ReleaseError("Pending approval not found", 404);
    if (record.status !== "pending") throw new ReleaseError("This approval was already decided", 409);
    if (this.expired(record)) {
      this.closeRequest(record, "timed_out", "Nobody decided before the release request expired", null);
      throw new ReleaseError("This release request expired; ask again", 409);
    }
    const check = this.personCheck(record, user);
    if (!check.allowed) {
      this.options.audit({
        category: "release",
        eventType: "release.approval.decided",
        action: decision,
        outcome: "denied",
        actor: { userId: user.id, email: user.email, type: "user" },
        resourceType: "workflow",
        resourceId: record.workflowId,
        projectId: this.projectOf(record.workflowId),
        metadata: { requestId: record.id, version: record.version, refused: check.code }
      });
      throw new ReleaseError(check.message, 403);
    }
    const trimmed = reason?.trim() || null;
    if (decision === "reject") {
      if (!trimmed) throw new ReleaseError("A reason is required to reject a release request", 400);
      if (!this.store.decideReleaseApprovalRequest({ id: record.id, status: "rejected", decidedByUserId: user.id, decidedBy: user.email, decisionReason: trimmed })) {
        throw new ReleaseError("This approval was already decided", 409);
      }
      this.auditDecision(record, user, decision, trimmed, null);
      return { request: this.toView(this.store.getReleaseApprovalRequest(record.id)!, user), release: null };
    }
    const stale = this.staleReason(record);
    if (stale) {
      this.closeRequest(record, "canceled", `Stale: ${stale}`, user);
      throw new ReleaseError(`This release request is stale and was canceled: ${stale} Ask again.`, 409);
    }
    const decidedAt = this.now().toISOString();
    const release = this.store.transaction(() => {
      const releaseId = `rel_${randomUUID()}`;
      if (!this.store.decideReleaseApprovalRequest({ id: record.id, status: "approved", decidedByUserId: user.id, decidedBy: user.email, decisionReason: trimmed, releaseId })) {
        throw new ReleaseError("This approval was already decided", 409);
      }
      const committed = this.store.publishWorkflowVersion(
        {
          id: releaseId,
          workflowId: record.workflowId,
          version: record.version,
          workflowHash: record.workflowHash,
          replayRunId: record.replayRunId,
          verdict: "approved",
          reason: record.requestReason,
          gateReasons: record.gateReasons,
          approval: { requestId: record.id, requestedBy: record.requestedBy, decidedBy: user.email, decidedAt, reason: trimmed },
          publishedAt: decidedAt,
          publishedBy: user.email,
          publishedByUserId: user.id
        },
        record.publishedVersionAtRequest
      );
      // Throwing rolls the decision back.
      if (!committed) throw new ReleaseError("Another version was published at the same time; ask again", 409);
      return committed;
    });
    const view = this.toRelease(release);
    this.auditDecision(record, user, decision, trimmed, view.id);
    this.options.audit({
      category: "release",
      eventType: "release.published",
      action: "publish",
      outcome: "success",
      actor: { userId: user.id, email: user.email, type: "user" },
      resourceType: "workflow",
      resourceId: record.workflowId,
      projectId: this.projectOf(record.workflowId),
      metadata: {
        releaseId: view.id,
        version: view.version,
        previousVersion: view.previousVersion,
        workflowHash: view.workflowHash,
        verdict: view.verdict,
        replayRunId: view.replayRunId,
        approvalRequestId: record.id,
        requestedBy: record.requestedBy,
        gateReasons: view.gateReasons
      }
    });
    try {
      this.options.onPublished(record.workflowId);
    } catch (error) {
      this.options.logger?.warn("Re-registering triggers after a release failed", { workflowId: record.workflowId, error: error instanceof Error ? error.message : String(error) });
    }
    return { request: this.toView(this.store.getReleaseApprovalRequest(record.id)!, user), release: view };
  }

  private auditDecision(record: ReleaseApprovalRequestRecord, user: SafeUser, decision: "approve" | "reject", reason: string | null, releaseId: string | null): void {
    this.options.audit({
      category: "release",
      eventType: "release.approval.decided",
      action: decision,
      outcome: "success",
      actor: { userId: user.id, email: user.email, type: "user" },
      resourceType: "workflow",
      resourceId: record.workflowId,
      projectId: this.projectOf(record.workflowId),
      metadata: { requestId: record.id, version: record.version, workflowHash: record.workflowHash, decision, reason: reason ? this.options.redact(reason) : null, releaseId }
    });
  }
}

