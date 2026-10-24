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
 * What only an admin may do on an enforced gate: turn it off or loosen it,
 * change who approves (approvers, self-approval, the request timeout) or the
 * replay job settings it accepts (candidate options, scorers included),
 * remove cases from or change case scorers in its golden sets, roll back,
 * and delete the workflow. Allowing self-approval is an admin's call on
 * every gate; without it neither the requester nor the person who saved the
 * version may approve the release.
 *
 * The gate decides what passing means: a job counts only when it ran with
 * the gate's own scorers and candidate options, over golden sets that still
 * hold what they held when the job was queued (the set snapshot), and, when
 * the job says so itself, `releaseEligible` is true. Only the cases of the
 * gate's own sets are judged.
 *
 * Turning a gate on publishes the current saved version as the baseline
 * (verdict `ungated`) when nothing is published yet, so production keeps
 * running what it ran. A gate that is on with no published version that
 * loads (the workflow was deleted and created again: the gate and the
 * release history outlive it) makes production refuse runs until a version
 * is published through the gate.
 *
 * Production routing keys (webhook, form and MCP trigger paths) belong to
 * what serves production: a gated workflow's published version, an active
 * ungated workflow's published version or else its saved workflow. A gated
 * workflow's draft claims nothing. A save is refused only when it would put
 * an active ungated workflow on a path another workflow claims; publishing,
 * turning a gate on, rollback and approving a release are refused when the
 * version's paths are claimed by another workflow.
 *
 * Deactivating a gated workflow is its kill switch: production refuses runs
 * with "this workflow is deactivated". Without a gate, deactivating only
 * unregisters schedules and triggers, as before releases existed.
 *
 * Every gate change, publish, override, rollback and release-request event is
 * audited (category `release`). Release tables need the SQLite store; on
 * Postgres the routes answer 501 and every channel runs the draft.
 */

import { randomUUID } from "node:crypto";
import { goldenSetSnapshots } from "./release-snapshot.js";
import { admissionState, gateAdmissionSnapshot, judgeAdmission, nextAdmittedIds } from "./gate-admission-state.js";
import {
  RELEASE_APPROVAL_REQUEST_PREFIX,
  aggregateReleaseRepeats,
  checkApprover,
  defaultReleaseGate,
  judgeReleaseGate,
  releaseApproversSchema,
  releaseGateAdminOnlyChanges,
  releaseScorersMatch,
  releaseCandidateOptionsSchema,
  releaseAdmissionLoosening,
  releaseGateLoosening,
  releaseGatePolicySchema,
  releaseGateSettingsSchema,
  type EvalCaseDetail,
  type EvalCaseResult,
  type EvalRunView,
  type ReleaseApprovalRequestView,
  type ReleaseApprovers,
  type ReleaseCandidateOptions,
  type ReleaseAggregateMode,
  type ReleaseCaseStatus,
  type ReleaseChannel,
  type ReleaseGateCase,
  type ReleaseGateEvidence,
  type ReleaseGateJudgement,
  type ReleaseGateSettingsInput,
  type ReleaseGateView,
  type ReleasePublishInput,
  type ReleasePublishPreview,
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
  /** Saves the draft as a new version (the baseline a gate publishes when it is turned on); returns its number. */
  snapshotDraft: (workflowId: string, actor: SafeUser) => number;
  appPublicUrl?: string;
  logger?: { warn: (message: string, fields?: Record<string, unknown>) => void };
  now?: () => Date;
}

export type PublishOutcome =
  | { status: 200; release: WorkflowRelease }
  | { status: 202; verdict: "needs_approval"; approvalRequestId: string; reasons: string[] }
  | { status: 409; verdict: "blocked"; reasons: string[]; replayRunId?: string; canRequestApproval: boolean };

const SELF_APPROVAL_MESSAGE = "You asked for this release, and this gate does not allow approving your own release.";
const AUTHOR_APPROVAL_MESSAGE = "You saved this version, and this gate does not allow approving a release of your own change.";
const BASELINE_REASON = "Baseline: the release gate was turned on, so the version production already ran is published as the starting point.";
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

/** Candidate fields a plain job carries; `workflow` is an inline candidate, whose content the hash covers. */
const PLAIN_CANDIDATE_KEYS = new Set(["kind", "version", "workflowHash", "workflow", "baseHash", "releaseEligible", "releaseIneligibleReasons", "ineligibleReasons"]);
/** Job options that do not change what is tested (the budget, the job's own eligibility verdict), or that the judge checks itself (MCP mode). */
const NEUTRAL_OPTION_KEYS = new Set(["maxCostUsd", "releaseEligible", "releaseIneligibleReasons", "ineligibleReasons", "mcpMode"]);
const GATE_OPTION_DEFAULTS: Record<string, unknown> = { compare: "recording", repeats: 1, aggregate: "all", models: "live" };

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length === 0;
  return false;
}

/**
 * Phase 15.4 — what a replay job ran with beyond the gate's own candidate
 * options. Guard-profile, MCP-mode and live-read overrides do not change a
 * job's candidate hash, so a job run on the unchanged version under weaker
 * settings would otherwise pass as proof. Every field is read defensively:
 * a field this release does not know counts against the job, and one the
 * gate names counts only when its value differs from the gate's. A
 * `baseline_rerun` comparison is always acceptable: it is the stricter one,
 * and the only one that passes once a golden run is too old (decision 3).
 * The MCP mode is the judge's own check (strict by default).
 */
export function replayJobOverrideFindings(run: Pick<EvalRunView, "options" | "candidate">, gateOptions: ReleaseCandidateOptions): string[] {
  const findings = new Set<string>();
  const candidate = asRecord(run.candidate);
  for (const [key, value] of Object.entries(candidate)) {
    if (PLAIN_CANDIDATE_KEYS.has(key) || isEmptyValue(value)) continue;
    findings.add(key === "overrides" ? `candidate overrides (${Object.keys(asRecord(value)).join(", ") || "unreadable"})` : `candidate.${key}`);
  }
  const gate = gateOptions as Record<string, unknown>;
  for (const [key, value] of Object.entries(asRecord(run.options))) {
    if (NEUTRAL_OPTION_KEYS.has(key) || isEmptyValue(value)) continue;
    if (key === "overrides") {
      findings.add(`overrides (${Object.keys(asRecord(value)).join(", ") || "unreadable"})`);
      continue;
    }
    if (key === "compare" && value === "baseline_rerun") continue;
    if (key in GATE_OPTION_DEFAULTS) {
      const expected = gate[key] ?? GATE_OPTION_DEFAULTS[key];
      if (value !== expected) findings.add(`${key} ${String(value)}`);
      continue;
    }
    // ignorePaths, numberTolerance and anything newer loosen or change the comparison the gate did not ask for.
    findings.add(key);
  }
  return [...findings];
}

/** A production routing key: what a request names to reach a workflow without its id. */
export interface ProductionRoutingKey {
  key: string;
  label: string;
}

function routingPath(value: unknown, fallback: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return (raw || fallback).replace(/^\/+/, "").replace(/\/+$/, "").toLowerCase();
}

/** Whether the workflow was deactivated (`POST /api/workflows/:id/deactivate`), which is stored on the draft. */
export function isWorkflowDeactivated(workflow: Pick<Workflow, "settings">): boolean {
  const settings = workflow.settings as Record<string, unknown> | undefined;
  return Boolean(settings && typeof settings === "object" && settings.active === false);
}

/** What a production run of a deactivated gated workflow answers, on every production entry point. */
export const DEACTIVATED_MESSAGE = "This workflow is deactivated, so production runs are refused. Activate it to serve production again.";
const NOTHING_PUBLISHED_MESSAGE = "No published version of this workflow can be loaded, so production runs are refused until a version is published.";

const TRIGGER_PATH_NODE_TYPES = new Set(["webhook_input", "form_trigger", "mcp_server_trigger"]);

/**
 * The webhook, form and MCP-trigger paths a workflow answers on, compared
 * without case. Webhooks count by path whatever their method, as
 * `/webhook/:path` routing matches the path first; an empty path falls back
 * to the node id, as routing does.
 */
export function productionRoutingKeys(workflow: Pick<Workflow, "nodes">): ProductionRoutingKey[] {
  const keys = new Map<string, string>();
  for (const node of workflow.nodes ?? []) {
    const config = asRecord(node.config);
    if (node.type === "webhook_input") {
      const path = routingPath(config.path, node.id);
      keys.set(`webhook:${path}`, `Webhook path "${path}"`);
    } else if (node.type === "form_trigger" && typeof config.path === "string" && config.path.trim()) {
      keys.set(`form:${config.path.trim().toLowerCase()}`, `Form path "${config.path.trim()}"`);
    } else if (node.type === "mcp_server_trigger" && typeof config.path === "string" && config.path.trim()) {
      keys.set(`mcp:${config.path.trim().toLowerCase()}`, `MCP trigger path "${config.path.trim()}"`);
    }
  }
  return [...keys].map(([key, label]) => ({ key, label }));
}

/**
 * A copy of `workflow` whose trigger paths (webhook, form, MCP trigger) are
 * not in `used`: each taken path gets `-copy`, then `-copy-2`, `-copy-3`, ...
 * A webhook with no path (it answers on its node id) gets one. Used by
 * duplicate and template use, so a copy never answers on its source's paths.
 */
export function withUniqueTriggerPaths<T extends Pick<Workflow, "nodes">>(workflow: T, used: Set<string>): T {
  const taken = new Set(used);
  const nodes = (workflow.nodes ?? []).map((node) => {
    if (!TRIGGER_PATH_NODE_TYPES.has(node.type)) return node;
    const config = asRecord(node.config);
    const prefix = node.type === "webhook_input" ? "webhook" : node.type === "form_trigger" ? "form" : "mcp";
    const raw = typeof config.path === "string" ? config.path.trim() : "";
    if (!raw && node.type !== "webhook_input") return node;
    const base = (raw || node.id).replace(/^\/+/, "").replace(/\/+$/, "") || node.id;
    const keyOf = (path: string) => `${prefix}:${path.toLowerCase()}`;
    if (!taken.has(keyOf(base))) {
      taken.add(keyOf(base));
      return node;
    }
    let candidate = `${base}-copy`;
    for (let index = 2; taken.has(keyOf(candidate)); index += 1) candidate = `${base}-copy-${index}`;
    taken.add(keyOf(candidate));
    return { ...node, config: { ...config, path: candidate } };
  });
  return { ...workflow, nodes };
}

export interface RoutingConflict {
  key: string;
  label: string;
  workflowId: string;
}

function sameIdentity(a: { id?: string | null; email?: string | null }, b: { id?: string | null; email?: string | null }): boolean {
  if (a.id && b.id && a.id === b.id) return true;
  return Boolean(a.email && b.email && a.email.toLowerCase() === b.email.toLowerCase());
}

export class ReleaseService {
  /** The published version each resolved production workflow object came from, for the run's history (retry runs it again). */
  private readonly versions = new WeakMap<Workflow, number>();

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
    const gateOn = Boolean(this.store.getReleaseGate(workflowId)?.enabled);
    // On a gated workflow deactivating is the kill switch: it stops production whatever version is published.
    // Without a gate, deactivating only unregisters schedules and triggers, as it always did.
    if (gateOn && isWorkflowDeactivated(draft)) return null;
    const published = this.store.getPublishedVersion(workflowId);
    if (published === null) {
      // A gate that is on always has a published version, except for a workflow created again under a gated id: fail closed.
      if (gateOn) {
        this.options.logger?.warn("The release gate is on but no version is published; production traffic is refused", { workflowId });
        return null;
      }
      return draft;
    }
    return this.versionWorkflow(workflowId, published);
  }

  /**
   * Why production refuses runs of an existing workflow (`resolveRunnableWorkflow`
   * answered null for it), as every production entry point reports it; null
   * when production runs it, or when the workflow does not exist.
   */
  productionRefusal(workflowId: string): string | null {
    if (!this.options.available) return null;
    const draft = this.store.getWorkflow(workflowId);
    if (!draft) return null;
    const gateOn = Boolean(this.store.getReleaseGate(workflowId)?.enabled);
    if (gateOn && isWorkflowDeactivated(draft)) return DEACTIVATED_MESSAGE;
    return this.resolveRunnableWorkflow(workflowId, "production") === null ? NOTHING_PUBLISHED_MESSAGE : null;
  }

  /**
   * The published version of a deactivated gated workflow: what production
   * would run were it active. Path routing uses it to answer "deactivated"
   * rather than "not found".
   */
  deactivatedProductionWorkflow(workflowId: string): Workflow | null {
    if (!this.options.available) return null;
    const draft = this.store.getWorkflow(workflowId);
    if (!draft || !isWorkflowDeactivated(draft) || !this.store.getReleaseGate(workflowId)?.enabled) return null;
    const published = this.store.getPublishedVersion(workflowId);
    if (published === null) return null;
    try {
      return this.options.resolveVersion(workflowId, published);
    } catch {
      return null;
    }
  }

  /** A saved version as production runs it, remembered as that version for the run's history; null when it cannot load. */
  versionWorkflow(workflowId: string, version: number): Workflow | null {
    try {
      const workflow = this.options.resolveVersion(workflowId, version);
      this.versions.set(workflow, version);
      return workflow;
    } catch (error) {
      this.options.logger?.warn("The published version of a workflow could not be loaded; production traffic is refused", {
        workflowId,
        version,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  /** The published version a workflow object returned by `resolveRunnableWorkflow` is, or null for a draft. */
  versionOf(workflow: Workflow): number | null {
    return this.versions.get(workflow) ?? null;
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
    return {
      draftVersion,
      publishedVersion,
      aheadBy,
      gateEnabled: gate?.enabled ?? false,
      gateEnforced: gate?.enforced ?? false,
      productionRefused: Boolean(gate?.enabled) && (publishedVersion === null || this.resolveRunnableWorkflow(workflowId, "production") === null),
      canPublish: this.options.access(user, workflowId, "workflow:publish").ok,
      canEditGate: this.options.access(user, workflowId, "workflow:write").ok
    };
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
   * only admins set or clear `enforced`, allow self-approval, or make an
   * admin-only change to an enforced gate (`releaseGateAdminOnlyChanges`:
   * 403 with the reasons). Every golden set must be this workflow's.
   *
   * Turning the gate on is refused while another workflow shares one of
   * this workflow's production paths, and, when nothing is published yet,
   * publishes the current saved version as the baseline (verdict `ungated`),
   * saving the draft as a version first when it differs from the newest one.
   */
  updateGate(user: SafeUser, workflowId: string, input: ReleaseGateSettingsInput): ReleaseGateView {
    this.requireAvailable();
    this.check(user, workflowId, "workflow:write");
    const parsed = releaseGateSettingsSchema.safeParse(input);
    if (!parsed.success) throw new ReleaseError("Invalid gate settings", 400, { issues: parsed.error.issues });
    const next = parsed.data;
    const previousRecord = this.store.getReleaseGate(workflowId);
    const current = this.settingsOf(previousRecord, workflowId);
    const isAdmin = user.role === "admin";
    const enforced = next.enforced ?? current.enforced;
    if (enforced !== current.enforced && !isAdmin) throw new ReleaseError("Only admins can enforce a gate or lift enforcement", 403);
    if (!isAdmin && next.approvers?.allowSelfApproval && !current.approvers?.allowSelfApproval) {
      throw new ReleaseError("Only admins can allow self-approval on a release gate", 403);
    }
    if (current.enforced && !isAdmin) {
      const changes = releaseGateAdminOnlyChanges(current, next);
      if (changes.length > 0) {
        this.options.audit({
          category: "release",
          eventType: "release.gate.update_refused",
          action: "update",
          outcome: "denied",
          actor: { userId: user.id, email: user.email, type: "user" },
          resourceType: "workflow",
          resourceId: workflowId,
          projectId: this.projectOf(workflowId),
          metadata: { changes }
        });
        throw new ReleaseError(`This gate is enforced: only admins can make this change (it ${changes.join(", ")})`, 403, { loosening: changes });
      }
    }
    for (const datasetId of next.datasetIds) {
      const dataset = this.store.getEvalDataset(datasetId);
      if (!dataset || dataset.workflowId !== workflowId) throw new ReleaseError(`Golden set ${datasetId} is not one of this workflow's golden sets`, 400);
    }
    const publishedVersion = this.store.getPublishedVersion(workflowId);
    const enabling = next.enabled && !current.enabled;
    if (enabling) {
      // What production will run once the gate is on: the published version, or the saved workflow as the baseline.
      const production = publishedVersion !== null ? this.versionWorkflow(workflowId, publishedVersion) : this.store.getWorkflow(workflowId);
      this.assertNoRoutingConflicts(user, workflowId, production, "turn the release gate on");
    }
    let baseline: { version: number; workflowHash: string } | null = null;
    if (enabling && publishedVersion === null) {
      // Turning the gate on here publishes a baseline release in this user's name.
      this.check(user, workflowId, "workflow:publish");
      if (!this.store.getWorkflow(workflowId)) throw new ReleaseError("Workflow not found", 404);
      const version = this.baselineVersion(user, workflowId);
      baseline = { version, workflowHash: this.versionCandidate(workflowId, version).workflowHash };
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
    // Enforced gates count only admitted cases: enforcing admits what the sets hold now, an admin adding a set admits its cases.
    const currentRecord = this.store.getReleaseGate(workflowId);
    const admitted = nextAdmittedIds(this.store, previousRecord, { enforced, datasetIds: next.datasetIds }, isAdmin);
    const admissionChanged =
      JSON.stringify(admitted === null ? null : [...admitted].sort()) !== JSON.stringify(currentRecord?.admittedFixtureIds === undefined ? null : currentRecord.admittedFixtureIds);
    if (admissionChanged) this.store.setReleaseGateAdmission(workflowId, admitted, this.now().toISOString(), user.email);
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
        candidateOptions: { ...view.candidateOptions, scorers: view.candidateOptions.scorers?.map((scorer) => scorer.type) },
        policy: view.policy,
        requireApproval: view.requireApproval,
        approvers: view.approvers ? { roles: view.approvers.approverRoles, users: view.approvers.approverUsers.length, allowSelfApproval: view.approvers.allowSelfApproval } : null,
        loosened: releaseGateLoosening(current, next),
        enforcedChanged: enforced !== current.enforced,
        admittedCases: admitted === null ? null : admitted.length,
        baselineVersion: baseline?.version ?? null
      }
    });
    if (baseline) {
      this.commitRelease({
        actor: user,
        workflowId,
        version: baseline.version,
        workflowHash: baseline.workflowHash,
        verdict: "ungated",
        replayRunId: null,
        reason: BASELINE_REASON,
        gateReasons: [],
        approval: null,
        expectedPrevious: null,
        baseline: true
      });
    }
    return view;
  }

  /** The saved version that matches the draft production runs now: the newest one, or a fresh snapshot of the draft. */
  private baselineVersion(user: SafeUser, workflowId: string): number {
    const draft = this.store.getWorkflow(workflowId)!;
    const latest = this.store.maxWorkflowVersionNumber(workflowId);
    if (latest > 0) {
      try {
        if (this.options.hashOf(this.options.resolveVersion(workflowId, latest)) === this.options.hashOf(draft)) return latest;
      } catch {
        // An unreadable newest version: save the draft as a new one below.
      }
    }
    return this.options.snapshotDraft(workflowId, user);
  }

  // -------------------------------------------------------------------------
  // Production routing keys
  // -------------------------------------------------------------------------

  /**
   * The production paths a workflow claims: those of what actually serves
   * its production traffic. A gated workflow claims its published version's
   * paths (its draft claims nothing); an ungated workflow, active or not,
   * claims its published version's paths when it has one, else its saved
   * workflow's: deactivating an ungated workflow only unregisters schedules
   * and triggers, so its webhooks, forms and MCP triggers keep serving
   * production. `draft` stands in for the saved workflow (a save being
   * checked).
   */
  private claimedKeys(workflowId: string, draft?: Workflow | null): ProductionRoutingKey[] {
    const saved = draft === undefined ? this.store.getWorkflow(workflowId) : draft;
    const gateOn = Boolean(this.store.getReleaseGate(workflowId)?.enabled);
    if (!gateOn && !saved) return [];
    const published = this.store.getPublishedVersion(workflowId);
    if (published !== null) {
      try {
        return productionRoutingKeys(this.options.resolveVersion(workflowId, published));
      } catch {
        // An unreadable published version answers no traffic.
        return [];
      }
    }
    return gateOn || !saved ? [] : productionRoutingKeys(saved);
  }

  /** The workflows other than `workflowId` that claim each production path. */
  private otherClaims(workflowId: string): Map<string, string[]> {
    const claims = new Map<string, string[]>();
    for (const summary of this.store.listWorkflows()) {
      if (summary.id === workflowId) continue;
      for (const entry of this.claimedKeys(summary.id)) {
        const owners = claims.get(entry.key) ?? [];
        if (!owners.includes(summary.id)) owners.push(summary.id);
        claims.set(entry.key, owners);
      }
    }
    return claims;
  }

  /** The paths in `keys` another workflow claims. */
  private claimedByOthers(workflowId: string, keys: ProductionRoutingKey[]): RoutingConflict[] {
    if (!this.options.available || keys.length === 0) return [];
    const claims = this.otherClaims(workflowId);
    const conflicts: RoutingConflict[] = [];
    for (const entry of keys) {
      for (const owner of claims.get(entry.key) ?? []) conflicts.push({ key: entry.key, label: entry.label, workflowId: owner });
    }
    return conflicts;
  }

  /**
   * Every trigger path any workflow answers on or may answer on (drafts and
   * published versions alike), so a copy can pick paths nobody uses.
   */
  usedRoutingKeys(): Set<string> {
    const used = new Set<string>();
    for (const summary of this.store.listWorkflows()) {
      const draft = this.store.getWorkflow(summary.id);
      if (draft) for (const entry of productionRoutingKeys(draft)) used.add(entry.key);
      const published = this.options.available ? this.store.getPublishedVersion(summary.id) : null;
      if (published === null) continue;
      try {
        for (const entry of productionRoutingKeys(this.options.resolveVersion(summary.id, published))) used.add(entry.key);
      } catch {
        // An unreadable published version answers no traffic.
      }
    }
    return used;
  }

  /** How a conflict reads to `user`: another workflow they cannot read stays unnamed. */
  describeConflicts(user: SafeUser, conflicts: RoutingConflict[]): string[] {
    return conflicts.map((conflict) => {
      const readable = this.options.access(user, conflict.workflowId, "workflow:read").ok;
      const other = readable ? `workflow "${this.store.getWorkflow(conflict.workflowId)?.name ?? conflict.workflowId}" (${conflict.workflowId})` : "another workflow";
      return `${conflict.label} is already used by ${other}.`;
    });
  }

  /**
   * Why saving `workflow` would put an ungated workflow on a
   * production path another workflow claims; null when it would not. A gated
   * workflow's draft claims nothing, so it always saves (its publish is
   * checked instead), and a path the workflow already claimed before this
   * save never blocks it.
   */
  claimConflict(user: SafeUser, workflow: Workflow): string | null {
    if (!this.options.available) return null;
    const before = new Set(this.store.getWorkflow(workflow.id) ? this.claimedKeys(workflow.id).map((entry) => entry.key) : []);
    const added = this.claimedKeys(workflow.id, workflow).filter((entry) => !before.has(entry.key));
    const conflicts = this.claimedByOthers(workflow.id, added);
    if (conflicts.length === 0) return null;
    return `${this.describeConflicts(user, conflicts).join(" ")} Production traffic on that path already goes to another workflow: choose another path.`;
  }

  private assertNoRoutingConflicts(user: SafeUser, workflowId: string, workflow: Workflow | null, what: string): void {
    const conflicts = workflow ? this.claimedByOthers(workflowId, productionRoutingKeys(workflow)) : [];
    if (conflicts.length === 0) return;
    throw new ReleaseError(`Cannot ${what} while another workflow serves production on one of its paths: ${this.describeConflicts(user, conflicts).join(" ")}`, 409, {
      conflicts: conflicts.map((conflict) => conflict.key)
    });
  }

  /** Why publishing `workflow` (a version) would put it on paths another workflow claims. */
  private conflictReasons(user: SafeUser, workflowId: string, workflow: Workflow): string[] {
    const conflicts = this.claimedByOthers(workflowId, productionRoutingKeys(workflow));
    if (conflicts.length === 0) return [];
    return [...this.describeConflicts(user, conflicts), "Production traffic on that path already goes to another workflow: give this version its own paths before publishing."];
  }

  // -------------------------------------------------------------------------
  // What only admins may do on an enforced gate
  // -------------------------------------------------------------------------

  private enforcedGateOf(workflowId: string): ReleaseGateRecord | null {
    if (!this.options.available) return null;
    const gate = this.store.getReleaseGate(workflowId);
    return gate?.enforced ? gate : null;
  }

  private refuse(user: SafeUser, workflowId: string, eventType: string, action: string, metadata: Record<string, unknown>): void {
    this.options.audit({
      category: "release",
      eventType,
      action,
      outcome: "denied",
      actor: { userId: user.id, email: user.email, type: "user" },
      resourceType: "workflow",
      resourceId: workflowId,
      projectId: this.projectOf(workflowId),
      metadata
    });
  }

  /** Why `user` may not delete this workflow (an enforced gate: admins only); null when they may. Audits a refusal. */
  deleteDenial(user: SafeUser, workflowId: string): string | null {
    if (user.role === "admin" || !this.enforcedGateOf(workflowId)) return null;
    this.refuse(user, workflowId, "release.workflow_delete.refused", "delete", {});
    return "This workflow has an enforced release gate: only an admin can delete it.";
  }

  /**
   * Why `user` may not make this change to a golden set (null when they
   * may), on a set an enforced gate uses: deleting the set and adding a case
   * with its own scorers are admin-only, and so is removing a case the gate
   * counts (an admitted case: `releaseAdmissionLoosening`). A builder may
   * remove a case still pending admission, or ask for removal of an
   * admitted one in the approvals inbox. Audits a refusal.
   */
  goldenSetChangeDenial(user: SafeUser, datasetId: string, change: "remove_case" | "delete_set" | "add_case_with_scorers", target: { fixtureId?: string } = {}): string | null {
    if (user.role === "admin") return null;
    const dataset = this.store.getEvalDataset(datasetId);
    if (!dataset?.workflowId) return null;
    const gate = this.enforcedGateOf(dataset.workflowId);
    if (!gate || !gate.datasetIds.includes(datasetId)) return null;
    if (change === "remove_case") {
      const snapshot = gateAdmissionSnapshot(this.store, gate);
      if (snapshot && target.fixtureId) {
        const before = admissionState(snapshot);
        const after = { admittedIds: before.admittedIds.filter((id) => id !== target.fixtureId), requiredIds: before.requiredIds.filter((id) => id !== target.fixtureId) };
        const loosening = releaseAdmissionLoosening(before, after, snapshot.names);
        if (loosening.length === 0) return null;
        this.refuse(user, dataset.workflowId, "release.golden_set_change.refused", "update", { datasetId, change, fixtureId: target.fixtureId, loosening });
        return "An enforced release gate counts this case: only an admin can remove it. Ask for its removal from the gate's Cases panel, and an approver decides in the approvals inbox.";
      }
    }
    this.refuse(user, dataset.workflowId, "release.golden_set_change.refused", "update", { datasetId, change });
    if (change === "delete_set") {
      return "An enforced release gate uses this golden set: only an admin can delete it. Ask for removal of its cases from the gate's Cases panel instead.";
    }
    const what = change === "remove_case" ? "remove a case from this golden set" : "add a case with its own scorers to this golden set";
    return `An enforced release gate uses this golden set: only an admin can ${what}.`;
  }

  /**
   * Why `user` may not delete a golden run that an admitted case of an
   * enforced gate's golden set replays (admins only); null when they may.
   * Audits a refusal.
   */
  recordingDeleteDenial(user: SafeUser, workflowId: string, recordingId: string): string | null {
    if (user.role === "admin") return null;
    const gate = this.enforcedGateOf(workflowId);
    if (!gate) return null;
    const snapshot = gateAdmissionSnapshot(this.store, gate);
    const counted = snapshot?.fixtures.find((fixture) => fixture.recordingId === recordingId && snapshot.admittedIds.has(fixture.id));
    if (!counted) return null;
    this.refuse(user, workflowId, "release.golden_set_change.refused", "delete", { datasetId: counted.datasetId, change: "delete_recording", recordingId, fixtureId: counted.id });
    return "An enforced release gate counts a case that replays this golden run: only an admin can delete it.";
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

  /** What the gate's own sets hold now: their case ids and snapshots. */
  private gateSets(gate: Pick<ReleaseGateView, "datasetIds">): { fixtureIds: Set<string>; snapshots: Record<string, string> } {
    const fixtureIds = new Set<string>();
    const snapshots = goldenSetSnapshots(gate.datasetIds, (datasetId) => {
      const fixtures = this.store.listEvalFixtures(datasetId);
      for (const fixture of fixtures) fixtureIds.add(fixture.id);
      return fixtures;
    });
    return { fixtureIds, snapshots };
  }

  /**
   * What `judgeReleaseGate` needs from a replay job: the cases of the gate's
   * own sets with repeats aggregated, and how the job's scorers, set
   * snapshot and own eligibility compare with the gate.
   */
  evidenceFor(job: JobView, gate: Pick<ReleaseGateView, "datasetIds" | "candidateOptions">, sets?: { fixtureIds: Set<string>; snapshots: Record<string, string> }): ReleaseGateEvidence {
    const current = sets ?? this.gateSets(gate);
    const options = asRecord(job.options);
    const aggregate = (typeof options.aggregate === "string" ? options.aggregate : "all") as ReleaseAggregateMode;
    const groups = new Map<string, Array<EvalCaseResult & Record<string, unknown>>>();
    for (const result of job.results as Array<EvalCaseResult & Record<string, unknown>>) {
      // A baseline rerun's own results are compared with, not judged.
      if (result.role === "baseline" || result.baseline === true) continue;
      // Only the gate's own sets count (a job may cover more).
      if (!current.fixtureIds.has(result.fixtureId)) continue;
      const key = result.fixtureId || result.recordingId || result.id;
      const list = groups.get(key) ?? [];
      list.push(result);
      groups.set(key, list);
    }
    const cases: ReleaseGateCase[] = [];
    let repeatsUnchecked = false;
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
      let diffMissing = false;
      const blocking = (action: unknown) => action === "block" || action === "review";
      for (const result of results) {
        if (caseStatus(result.status) === "skipped") continue;
        const diff = asRecord(this.options.loadCase(job.id, result.id)?.replay?.diff);
        const totals = asRecord(diff.totals);
        const guard = asRecord(diff.guard);
        if (!diff.totals || !Array.isArray(guard.added) || !Array.isArray(guard.changed)) {
          // No diff (or a truncated one): cost, latency and guard verdicts are unknown.
          diffMissing = true;
          continue;
        }
        const cost = asRecord(totals.costUsd);
        const latency = asRecord(totals.latencyMs);
        costBaseline = numberOrNull(cost.baseline) ?? costBaseline;
        latencyBaseline = numberOrNull(latency.baseline) ?? latencyBaseline;
        // Repeats: the row's totals come from one attempt; cost is kept for every attempt, so the worst one counts.
        const attempts = Array.isArray(diff.attempts) ? (diff.attempts as unknown[]).map(asRecord) : [];
        const attemptCosts = attempts.map((attempt) => numberOrNull(attempt.costUsd)).filter((value): value is number => value !== null);
        const candidateCost = attemptCosts.length > 0 ? Math.max(...attemptCosts) : numberOrNull(cost.candidate);
        if (candidateCost !== null) costs.push(candidateCost);
        // Latency and guard verdicts are per attempt only when the replay recorded them for every attempt.
        const attemptLatencies = attempts.map((attempt) => numberOrNull(attempt.latencyMs)).filter((value): value is number => value !== null);
        const attemptGuards = attempts.map((attempt) => numberOrNull(attempt.newGuardBlocks)).filter((value): value is number => value !== null);
        const perAttemptLatency = attempts.length > 1 && attemptLatencies.length === attempts.length;
        const perAttemptGuard = attempts.length > 1 && attemptGuards.length === attempts.length;
        if (attempts.length > 1 && !(perAttemptLatency && perAttemptGuard)) repeatsUnchecked = true;
        const candidateLatency = perAttemptLatency ? Math.max(...attemptLatencies) : numberOrNull(latency.candidate);
        if (candidateLatency !== null) latencies.push(candidateLatency);
        const added = (guard.added as unknown[]).map(asRecord).filter((verdict) => !verdict.shadow && blocking(verdict.effectiveAction)).length;
        const escalated = (guard.changed as unknown[])
          .map(asRecord)
          .filter((change) => {
            const after = asRecord(change.candidate);
            return !after.shadow && blocking(after.effectiveAction) && !blocking(asRecord(change.baseline).effectiveAction);
          }).length;
        newGuardBlocks = Math.max(newGuardBlocks, perAttemptGuard ? Math.max(...attemptGuards) : added + escalated);
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
        recordingCreatedAt: first.recordingId ? this.options.recordingCreatedAt(first.recordingId) : null,
        diffMissing
      });
    }
    const candidate = asRecord(job.candidate);
    const eligible = candidate.releaseEligible ?? options.releaseEligible;
    const ineligible = candidate.releaseIneligibleReasons ?? options.releaseIneligibleReasons ?? candidate.ineligibleReasons ?? options.ineligibleReasons;
    const record = this.store.getEvalRun(job.id);
    const jobScorers = (record?.scorers ?? null) as unknown[] | null;
    let scorerMismatch: string | null = null;
    if (!releaseScorersMatch(gate.candidateOptions.scorers, jobScorers)) {
      const types = (jobScorers ?? []).map((scorer) => String(asRecord(scorer).type ?? "unknown"));
      scorerMismatch = types.length > 0 ? `ran with its own scorers (${types.join(", ")})` : "ran with the default scorers, not the ones the gate names";
    }
    const jobSnapshot = this.store.getEvalRunSetSnapshot(job.id);
    const staleSets = gate.datasetIds.filter((datasetId) => !jobSnapshot || jobSnapshot[datasetId] !== current.snapshots[datasetId]);
    return {
      job: {
        id: job.id,
        status: job.status,
        workflowHash: typeof candidate.workflowHash === "string" ? candidate.workflowHash : null,
        datasetIds: job.datasetIds,
        compare: typeof options.compare === "string" ? options.compare : null,
        mcpMode: typeof options.mcpMode === "string" ? options.mcpMode : null,
        liveWrites: replayJobAllowsLiveWrites(job),
        overrides: replayJobOverrideFindings(job, gate.candidateOptions),
        ...(eligible !== undefined ? { releaseEligible: eligible === true ? true : false } : {}),
        ...(Array.isArray(ineligible) ? { releaseIneligibleReasons: ineligible.map((entry) => String(entry)) } : {}),
        scorerMismatch,
        staleSets: jobSnapshot ? staleSets : [],
        ...(jobSnapshot ? {} : { noSetSnapshot: true }),
        ...(repeatsUnchecked ? { repeatsUnchecked: true } : {})
      },
      cases
    };
  }

  /**
   * Judges the job (the given one, else the newest completed job for this
   * hash that passes, else the newest one) under the gate's current policy.
   * Every completed job for the hash is considered.
   */
  judge(gate: ReleaseGateView, workflowId: string, workflowHash: string, replayRunId?: string): { judgement: ReleaseGateJudgement; replayRunId?: string } {
    const expected = { workflowHash, datasetIds: gate.datasetIds, mcpMode: gate.candidateOptions.mcpMode ?? "strict" };
    const sets = this.gateSets(gate);
    // Enforced gates count only admitted cases, and required cases must pass (null: every case counts, as before).
    const admission = gate.enforced ? judgeAdmission(gateAdmissionSnapshot(this.store, this.store.getReleaseGate(workflowId))) : null;
    const judgeJob = (job: JobView) =>
      judgeReleaseGate(this.evidenceFor(job, gate, sets), gate.policy, { expected, requireApproval: gate.requireApproval, now: this.now(), admission });
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
    return newest ?? { judgement: judgeReleaseGate(null, gate.policy, { expected, now: this.now(), admission }) };
  }

  /** The publish dialog's preview: the verdict publishing would get now. */
  preview(user: SafeUser, workflowId: string, version: number, replayRunId?: string): ReleasePublishPreview {
    this.requireAvailable();
    this.check(user, workflowId, "workflow:read");
    const gate = this.settingsOf(this.store.getReleaseGate(workflowId), workflowId);
    const { workflowHash } = this.versionCandidate(workflowId, version);
    if (!gate.enabled) return { version, workflowHash, gateEnabled: false, verdict: "passed", reasons: [], replayRunId: null, stats: null, canRequestApproval: false };
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
    /** The baseline a gate publishes when it is turned on. */
    baseline?: boolean;
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
        approvalRequestId: input.approval?.requestId ?? null,
        ...(input.baseline ? { baseline: true } : {})
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
    const conflicts = this.conflictReasons(user, workflowId, this.versionCandidate(workflowId, input.version).workflow);
    if (conflicts.length > 0) {
      // Not even an override: production routing would be ambiguous, whatever the gate says.
      return { status: 409, verdict: "blocked", reasons: conflicts, canRequestApproval: false };
    }
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

  /**
   * Back to a version that was published before, with a reason (audited).
   * The gate's replay check is skipped because that version was released
   * once; on an enforced gate only an admin may roll back. The version must
   * still have the hash it had when it was released (a workflow moved to
   * another project, or created again under the same id, does not).
   */
  rollback(user: SafeUser, workflowId: string, input: ReleaseRollbackInput): WorkflowRelease {
    this.requireAvailable();
    this.check(user, workflowId, "workflow:publish");
    if (this.enforcedGateOf(workflowId) && user.role !== "admin") {
      this.refuse(user, workflowId, "release.rollback.refused", "rollback", { version: input.version });
      throw new ReleaseError("This workflow's release gate is enforced: only an admin can roll back", 403);
    }
    const previous = this.store.getPublishedVersion(workflowId);
    if (previous === input.version) throw new ReleaseError(`Version ${input.version} is already published`, 409);
    if (!this.store.hasReleasedVersion(workflowId, input.version)) {
      throw new ReleaseError(`Version ${input.version} was never published, so it cannot be rolled back to; publish it instead`, 409);
    }
    const { workflow, workflowHash } = this.versionCandidate(workflowId, input.version);
    if (!this.store.listReleasedVersionHashes(workflowId, input.version).includes(workflowHash)) {
      throw new ReleaseError(`Version ${input.version} no longer has the hash it was released with (the workflow moved project or was created again), so it cannot be rolled back to; publish it through the gate instead`, 409);
    }
    const conflicts = this.conflictReasons(user, workflowId, workflow);
    if (conflicts.length > 0) throw new ReleaseError(conflicts.join(" "), 409);
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
    // Each requester has their own request (their reason, their name on it); stale and expired ones are closed first.
    this.sweepExpired();
    for (const existing of this.store.listPendingReleaseApprovalRequests(input.workflowId, input.version, input.workflowHash)) {
      const stale = this.staleReason(existing);
      if (stale) {
        this.closeRequest(existing, "canceled", `Stale: ${stale}`, null);
        continue;
      }
      if (sameIdentity({ id: existing.requestedByUserId, email: existing.requestedBy }, input.user)) return existing;
    }
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

  /** Closes the release requests whose time ran out (lazily, on list and on request), audited as timed out. */
  private sweepExpired(): void {
    for (const record of this.store.timeOutExpiredReleaseApprovalRequests(this.now().toISOString())) {
      this.options.audit({
        category: "release",
        eventType: "release.approval.timed_out",
        action: "timeout",
        outcome: "success",
        actor: { type: "system", email: "system" },
        resourceType: "workflow",
        resourceId: record.workflowId,
        projectId: this.projectOf(record.workflowId),
        metadata: { requestId: record.id, version: record.version, workflowHash: record.workflowHash }
      });
    }
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
    if (!check.allowed) return { allowed: false, code: check.code, message: check.code === "self_approval" ? SELF_APPROVAL_MESSAGE : check.message };
    // The person who saved the version is no more independent than the one who asked.
    const author = this.store.getWorkflowVersion(record.workflowId, record.version)?.createdBy ?? null;
    if (author && spec.allowSelfApproval !== true && sameIdentity({ id: author, email: author }, user)) {
      return { allowed: false, code: "self_approval", message: AUTHOR_APPROVAL_MESSAGE };
    }
    return { allowed: true };
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
    this.sweepExpired();
    const workflowIds = this.options.readableWorkflowIds(user);
    const rows = this.store.listReleaseApprovalRequests({ ...filter, now: this.now().toISOString(), scope: workflowIds === null ? { all: true } : { workflowIds } });
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
    const conflicts = this.conflictReasons(user, record.workflowId, this.versionCandidate(record.workflowId, record.version).workflow);
    if (conflicts.length > 0) throw new ReleaseError(conflicts.join(" "), 409);
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

