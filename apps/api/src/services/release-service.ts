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
 * Unpublishing (`unpublish`, `workflow:publish`) takes the published version
 * down: production runs the draft, as a never-published workflow does, until
 * a version is published again. The gate never blocks it (it is the way out),
 * and on a gated workflow the draft then serves production ungated: the
 * workflow row's unpublish mark tells it apart from a workflow created again
 * under a gated id, which still fails closed. Rollback afterwards is a
 * rollback as before (to a version published before, same rules).
 *
 * Every gate change, publish, override, rollback, unpublish and
 * release-request event is audited (category `release`).
 */

import { createHash, randomUUID } from "node:crypto";
import { goldenSetSnapshots, staleGoldenSetCount, staleGoldenSets, type GoldenSetSnapshot } from "./release-snapshot.js";
import { gateAuthority } from "./gate-authority.js";
import { admissionState, gateAdmissionSnapshot, judgeAdmission, nextAdmittedIds } from "./gate-admission-state.js";
import {
  RELEASE_APPROVAL_REQUEST_PREFIX,
  aggregateReleaseRepeats,
  checkApprover,
  defaultReleaseGate,
  judgeReleaseGate,
  releaseApproversSchema,
  releaseCanonicalJson,
  releaseGateChecksWorsened,
  releaseGateAdminOnlyChanges,
  releaseScorersMatch,
  releaseCandidateOptionsSchema,
  releaseAdmissionLoosening,
  releaseGateLoosening,
  releaseGatePolicySchema,
  releaseGateSettingsSchema,
  releaseUnpublishNotice,
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
  type ReleaseGateJobAdmission,
  type ReleaseGateJudgement,
  type ReleaseGateSettingsInput,
  type ReleaseGateView,
  type ReleasePublishInput,
  type ReleasePublishPreview,
  type ReleaseRollbackInput,
  type ReleaseStateView,
  type ReleaseUnpublishInput,
  type ReleaseUnpublishResult,
  type ReleaseVerdict,
  type Workflow,
  type WorkflowRelease
} from "@ai-orchestrator/shared";
import type { EvalFixtureRecord, ReleaseApprovalRequestRecord, ReleaseGateRecord, WorkflowReleaseRecord } from "../db/database.js";
import type { AuditEventInput } from "./audit-service.js";
import type { SafeUser } from "./auth-service.js";
import type { NotificationEvent } from "./notification-service.js";
import type { RunAccessResult } from "../run-access.js";
import type { Store } from "../db/store.js";
import { mapAsync } from "../async-array.js";

/** The gate's sets as they are now (see `ReleaseService.gateSets`). */
interface GateSets {
  fixtureIds: Set<string>;
  snapshots: Record<string, GoldenSetSnapshot>;
  /** Enforced gates with stored admission: the admitted cases; null otherwise. */
  admittedIds: ReadonlySet<string> | null;
}

export type ReleasePermission = "workflow:read" | "workflow:write" | "workflow:publish";

export class ReleaseError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 403 | 404 | 409,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ReleaseError";
  }
}

type JobView = EvalRunView & { results: EvalCaseResult[] };

/** Why a job whose case results a data-subject delete removed is no longer release proof. */
export const DATA_SUBJECT_EVIDENCE_REMOVED = "Stale: a data-subject delete removed some of this job's case results after it ran, so it can no longer prove a release. Run the job again.";

export interface ReleaseServiceOptions {
  store: Store;
  /**
   * A saved version as a runnable workflow, under the workflow's current
   * project and folder: the same candidate a replay job builds for it.
   * Throws when the version does not exist.
   */
  resolveVersion: (workflowId: string, version: number) => Promise<Workflow>;
  /** The candidate hash replay jobs record (workflowForHash + canonical JSON). */
  hashOf: (workflow: Workflow) => string;
  loadJob: (runId: string) => Promise<JobView | null>;
  loadCase: (runId: string, resultId: string) => Promise<EvalCaseDetail | null>;
  recordingCreatedAt: (recordingId: string) => Promise<string | null>;
  /** The shared run-access check (run-access.ts): 404 unreadable, 403 without the permission; admins pass. */
  access: (user: SafeUser, workflowId: string, permission: ReleasePermission) => Promise<RunAccessResult<object>>;
  readableWorkflowIds: (user: SafeUser) => Promise<string[] | null>;
  audit: (event: AuditEventInput) => void | Promise<void>;
  notify: (event: NotificationEvent) => Promise<void>;
  redact: (value: string) => string;
  /** Called after the published version moved: schedules and app triggers re-register from it. */
  onPublished: (workflowId: string) => void | Promise<void>;
  /** Saves the draft as a new version (the baseline a gate publishes when it is turned on); returns its number. */
  snapshotDraft: (workflowId: string, actor: SafeUser) => Promise<number>;
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

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private get store(): Store {
    return this.options.store;
  }

  private async check(user: SafeUser, workflowId: string, permission: ReleasePermission): Promise<void> {
    const result = await this.options.access(user, workflowId, permission);
    if (!result.ok) throw new ReleaseError(result.error, result.status);
  }

  // -------------------------------------------------------------------------
  // Which version runs
  // -------------------------------------------------------------------------

  /**
   * The workflow an entry point runs: the published version for `production`
   * when one is set, otherwise the draft. A published version whose snapshot
   * is gone or unreadable fails closed (null), so production never falls back
   * to an unreviewed draft. After an unpublish production runs the draft, on
   * a gated workflow too (the gate does not check it).
   */
  async resolveRunnableWorkflow(workflowId: string, channel: ReleaseChannel): Promise<Workflow | null> {
    const draft = await this.store.getWorkflow(workflowId);
    if (!draft || channel === "draft") return draft;
    const gateOn = Boolean((await this.store.getReleaseGate(workflowId))?.enabled);
    // On a gated workflow deactivating is the kill switch: it stops production whatever version is published.
    // Without a gate, deactivating only unregisters schedules and triggers, as it always did.
    if (gateOn && isWorkflowDeactivated(draft)) return null;
    // One read of the row: a republish between two reads must not show "nothing published" without its mark.
    const { publishedVersion: published, unpublishedAt } = await this.store.getPublishState(workflowId);
    if (published === null) {
      // A gate that is on has a published version unless someone unpublished it (production runs the draft) or the
      // workflow was created again under a gated id (no unpublish mark on the new row): that one fails closed.
      if (gateOn && unpublishedAt === null) {
        this.options.logger?.warn("The release gate is on but no version is published; production traffic is refused", { workflowId });
        return null;
      }
      return draft;
    }
    return await this.versionWorkflow(workflowId, published);
  }

  /**
   * Why production refuses runs of an existing workflow (`resolveRunnableWorkflow`
   * answered null for it), as every production entry point reports it; null
   * when production runs it, or when the workflow does not exist.
   */
  async productionRefusal(workflowId: string): Promise<string | null> {
    const draft = await this.store.getWorkflow(workflowId);
    if (!draft) return null;
    const gateOn = Boolean((await this.store.getReleaseGate(workflowId))?.enabled);
    if (gateOn && isWorkflowDeactivated(draft)) return DEACTIVATED_MESSAGE;
    return await this.resolveRunnableWorkflow(workflowId, "production") === null ? NOTHING_PUBLISHED_MESSAGE : null;
  }

  /**
   * The published version of a deactivated gated workflow: what production
   * would run were it active. Path routing uses it to answer "deactivated"
   * rather than "not found".
   */
  async deactivatedProductionWorkflow(workflowId: string): Promise<Workflow | null> {
    const draft = await this.store.getWorkflow(workflowId);
    if (!draft || !isWorkflowDeactivated(draft) || !(await this.store.getReleaseGate(workflowId))?.enabled) return null;
    const { publishedVersion: published, unpublishedAt } = await this.store.getPublishState(workflowId);
    // Unpublished: what production would run is the draft.
    if (published === null) return unpublishedAt === null ? null : draft;
    try {
      return await this.options.resolveVersion(workflowId, published);
    } catch {
      return null;
    }
  }

  /** A saved version as production runs it, remembered as that version for the run's history; null when it cannot load. */
  async versionWorkflow(workflowId: string, version: number): Promise<Workflow | null> {
    try {
      const workflow = await this.options.resolveVersion(workflowId, version);
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
  async publishedVersion(workflowId: string): Promise<number | null> {
    return await this.store.getPublishedVersion(workflowId);
  }

  async state(user: SafeUser, workflowId: string): Promise<ReleaseStateView> {
    await this.check(user, workflowId, "workflow:read");
    const draftVersion = await this.store.maxWorkflowVersionNumber(workflowId) || null;
    const { publishedVersion, unpublishedAt } = await this.store.getPublishState(workflowId);
    const gate = await this.store.getReleaseGate(workflowId);
    const aheadBy = publishedVersion !== null && draftVersion !== null ? Math.max(0, draftVersion - publishedVersion) : 0;
    return {
      draftVersion,
      publishedVersion,
      aheadBy,
      gateEnabled: gate?.enabled ?? false,
      gateEnforced: gate?.enforced ?? false,
      productionRefused: Boolean(gate?.enabled) && ((publishedVersion === null && unpublishedAt === null) || await this.resolveRunnableWorkflow(workflowId, "production") === null),
      unpublishedAt: publishedVersion === null ? unpublishedAt : null,
      canPublish: (await this.options.access(user, workflowId, "workflow:publish")).ok,
      canEditGate: (await this.options.access(user, workflowId, "workflow:write")).ok
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

  async gate(user: SafeUser, workflowId: string): Promise<ReleaseGateView> {
    await this.check(user, workflowId, "workflow:read");
    return this.settingsOf(await this.store.getReleaseGate(workflowId), workflowId);
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
  async updateGate(user: SafeUser, workflowId: string, input: ReleaseGateSettingsInput): Promise<ReleaseGateView> {
    await this.check(user, workflowId, "workflow:write");
    const parsed = releaseGateSettingsSchema.safeParse(input);
    if (!parsed.success) throw new ReleaseError("Invalid gate settings", 400, { issues: parsed.error.issues });
    const next = parsed.data;
    const previousRecord = await this.store.getReleaseGate(workflowId);
    const current = this.settingsOf(previousRecord, workflowId);
    const isAdmin = user.role === "admin";
    const enforced = next.enforced ?? current.enforced;
    if (enforced !== current.enforced && !isAdmin) throw new ReleaseError("Only admins can enforce a gate or lift enforcement", 403);
    const admitAddedSetCases = next.admitAddedSetCases === true;
    if (admitAddedSetCases && !isAdmin) throw new ReleaseError("Only admins can admit cases to an enforced release gate. Ask the gate's approvers from its Cases panel instead.", 403);
    if (!isAdmin && next.approvers?.allowSelfApproval && !current.approvers?.allowSelfApproval) {
      throw new ReleaseError("Only admins can allow self-approval on a release gate", 403);
    }
    if (current.enforced && !isAdmin) {
      const changes = releaseGateAdminOnlyChanges(current, next);
      if (changes.length > 0) {
        await this.options.audit({
          category: "release",
          eventType: "release.gate.update_refused",
          action: "update",
          outcome: "denied",
          actor: { userId: user.id, email: user.email, type: "user" },
          resourceType: "workflow",
          resourceId: workflowId,
          projectId: await this.projectOf(workflowId),
          metadata: { changes }
        });
        throw new ReleaseError(`This gate is enforced: only admins can make this change (it ${changes.join(", ")})`, 403, { loosening: changes });
      }
    }
    for (const datasetId of next.datasetIds) {
      const dataset = await this.store.getEvalDataset(datasetId);
      if (!dataset || dataset.workflowId !== workflowId) throw new ReleaseError(`Golden set ${datasetId} is not one of this workflow's golden sets`, 400);
    }
    const publishedVersion = await this.store.getPublishedVersion(workflowId);
    const enabling = next.enabled && !current.enabled;
    if (enabling) {
      // What production will run once the gate is on: the published version, or the saved workflow as the baseline.
      const production = publishedVersion !== null ? await this.versionWorkflow(workflowId, publishedVersion) : await this.store.getWorkflow(workflowId);
      await this.assertNoRoutingConflicts(user, workflowId, production, "turn the release gate on");
    }
    let baseline: { version: number; workflowHash: string } | null = null;
    if (enabling && publishedVersion === null) {
      // Turning the gate on here publishes a baseline release in this user's name.
      await this.check(user, workflowId, "workflow:publish");
      if (!await this.store.getWorkflow(workflowId)) throw new ReleaseError("Workflow not found", 404);
      const version = await this.baselineVersion(user, workflowId);
      baseline = { version, workflowHash: (await this.versionCandidate(workflowId, version)).workflowHash };
    }
    const admissionBefore = await gateAdmissionSnapshot(this.store, previousRecord);
    // A save that changes nothing leaves the gate (and its `updated_at`) alone, so it makes no open request stale.
    const settingsKey = (settings: Pick<ReleaseGateRecord, "enabled" | "enforced" | "datasetIds" | "candidateOptions" | "policy" | "requireApproval"> & { approvers?: unknown }) =>
      releaseCanonicalJson({
        enabled: settings.enabled,
        enforced: settings.enforced,
        datasetIds: settings.datasetIds,
        candidateOptions: settings.candidateOptions,
        policy: settings.policy,
        requireApproval: settings.requireApproval,
        approvers: settings.approvers ?? null
      });
    const unchanged =
      previousRecord !== null &&
      settingsKey(previousRecord) ===
        settingsKey({ enabled: next.enabled, enforced, datasetIds: next.datasetIds, candidateOptions: next.candidateOptions, policy: next.policy, requireApproval: next.requireApproval, approvers: next.approvers });
    // The settings and the cases the gate counts are saved together, or not at all, and only onto the gate as read above.
    const savedAt = this.now().toISOString();
    const gateRecord: ReleaseGateRecord | null = unchanged && previousRecord ? null : {
      workflowId,
      enabled: next.enabled,
      enforced,
      datasetIds: next.datasetIds,
      candidateOptions: next.candidateOptions,
      policy: next.policy,
      requireApproval: next.requireApproval,
      approvers: next.approvers,
      updatedAt: savedAt,
      updatedBy: user.email
    };
    // Enforcing for the first time admits what the sets hold now; afterwards nothing is admitted without an explicit admin decision.
    const admitted = await nextAdmittedIds(this.store, previousRecord, { enforced, datasetIds: next.datasetIds }, { byAdmin: isAdmin, admitAddedSetCases });
    const saved = await this.store.saveReleaseGate({ gate: gateRecord, admittedFixtureIds: admitted, expected: previousRecord, updatedAt: savedAt, updatedBy: user.email });
    if (!saved) throw new ReleaseError("The release gate changed while it was being saved. Reload and save again.", 409);
    const view = this.settingsOf(saved, workflowId);
    const admissionAfter = await gateAdmissionSnapshot(this.store, await this.store.getReleaseGate(workflowId));
    const previouslyAdmitted = new Set(admissionBefore ? admissionBefore.admittedIds : []);
    const newlyAdmitted = admissionAfter ? [...admissionAfter.admittedIds].filter((id) => !previouslyAdmitted.has(id)) : [];
    const admissionLoosening =
      admissionBefore && admissionAfter
        ? { before: admissionState(admissionBefore), after: admissionState(admissionAfter), names: { ...admissionAfter.names, ...admissionBefore.names } }
        : undefined;
    await this.options.audit({
      category: "release",
      eventType: "release.gate.updated",
      action: "update",
      outcome: "success",
      actor: { userId: user.id, email: user.email, type: "user" },
      resourceType: "workflow",
      resourceId: workflowId,
      projectId: await this.projectOf(workflowId),
      metadata: {
        enabled: view.enabled,
        enforced: view.enforced,
        datasetIds: view.datasetIds,
        candidateOptions: { ...view.candidateOptions, scorers: view.candidateOptions.scorers?.map((scorer) => scorer.type) },
        policy: view.policy,
        requireApproval: view.requireApproval,
        approvers: view.approvers ? { roles: view.approvers.approverRoles, users: view.approvers.approverUsers.length, allowSelfApproval: view.approvers.allowSelfApproval } : null,
        loosened: releaseGateLoosening(current, next, admissionLoosening),
        enforcedChanged: enforced !== current.enforced,
        admittedCases: admissionAfter ? admissionAfter.admittedIds.size : null,
        pendingCases: admissionAfter ? admissionAfter.fixtures.length - admissionAfter.admittedIds.size : null,
        newlyAdmittedFixtureIds: newlyAdmitted,
        admitAddedSetCases,
        storedAdmittedCases: admitted === null ? null : admitted.length,
        settingsUnchanged: unchanged,
        baselineVersion: baseline?.version ?? null
      }
    });
    if (baseline) {
      await this.commitRelease({
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
  private async baselineVersion(user: SafeUser, workflowId: string): Promise<number> {
    const draft = (await this.store.getWorkflow(workflowId))!;
    const latest = await this.store.maxWorkflowVersionNumber(workflowId);
    if (latest > 0) {
      try {
        if (this.options.hashOf(await this.options.resolveVersion(workflowId, latest)) === this.options.hashOf(draft)) return latest;
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
   * paths (its draft claims nothing, unless it was unpublished: then the
   * draft serves production and claims its paths); an ungated workflow, active or not,
   * claims its published version's paths when it has one, else its saved
   * workflow's: deactivating an ungated workflow only unregisters schedules
   * and triggers, so its webhooks, forms and MCP triggers keep serving
   * production. `draft` stands in for the saved workflow (a save being
   * checked).
   */
  private async claimedKeys(workflowId: string, draft?: Workflow | null): Promise<ProductionRoutingKey[]> {
    const saved = draft === undefined ? await this.store.getWorkflow(workflowId) : draft;
    const gateOn = Boolean((await this.store.getReleaseGate(workflowId))?.enabled);
    if (!gateOn && !saved) return [];
    const { publishedVersion: published, unpublishedAt } = await this.store.getPublishState(workflowId);
    if (published !== null) {
      try {
        return productionRoutingKeys(await this.options.resolveVersion(workflowId, published));
      } catch {
        // An unreadable published version answers no traffic.
        return [];
      }
    }
    if (!saved) return [];
    return gateOn && unpublishedAt === null ? [] : productionRoutingKeys(saved);
  }

  /** The workflows other than `workflowId` that claim each production path. */
  private async otherClaims(workflowId: string): Promise<Map<string, string[]>> {
    const claims = new Map<string, string[]>();
    for (const summary of await this.store.listWorkflows()) {
      if (summary.id === workflowId) continue;
      for (const entry of await this.claimedKeys(summary.id)) {
        const owners = claims.get(entry.key) ?? [];
        if (!owners.includes(summary.id)) owners.push(summary.id);
        claims.set(entry.key, owners);
      }
    }
    return claims;
  }

  /** The paths in `keys` another workflow claims. */
  private async claimedByOthers(workflowId: string, keys: ProductionRoutingKey[]): Promise<RoutingConflict[]> {
    if (keys.length === 0) return [];
    const claims = await this.otherClaims(workflowId);
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
  async usedRoutingKeys(): Promise<Set<string>> {
    const used = new Set<string>();
    for (const summary of await this.store.listWorkflows()) {
      const draft = await this.store.getWorkflow(summary.id);
      if (draft) for (const entry of productionRoutingKeys(draft)) used.add(entry.key);
      const published = await this.store.getPublishedVersion(summary.id);
      if (published === null) continue;
      try {
        for (const entry of productionRoutingKeys(await this.options.resolveVersion(summary.id, published))) used.add(entry.key);
      } catch {
        // An unreadable published version answers no traffic.
      }
    }
    return used;
  }

  /** How a conflict reads to `user`: another workflow they cannot read stays unnamed. */
  async describeConflicts(user: SafeUser, conflicts: RoutingConflict[]): Promise<string[]> {
    return await mapAsync(conflicts, async (conflict) => {
      const readable = (await this.options.access(user, conflict.workflowId, "workflow:read")).ok;
      const other = readable ? `workflow "${(await this.store.getWorkflow(conflict.workflowId))?.name ?? conflict.workflowId}" (${conflict.workflowId})` : "another workflow";
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
  async claimConflict(user: SafeUser, workflow: Workflow): Promise<string | null> {
    const before = new Set(await this.store.getWorkflow(workflow.id) ? (await this.claimedKeys(workflow.id)).map((entry) => entry.key) : []);
    const added = (await this.claimedKeys(workflow.id, workflow)).filter((entry) => !before.has(entry.key));
    const conflicts = await this.claimedByOthers(workflow.id, added);
    if (conflicts.length === 0) return null;
    return `${(await this.describeConflicts(user, conflicts)).join(" ")} Production traffic on that path already goes to another workflow: choose another path.`;
  }

  private async assertNoRoutingConflicts(user: SafeUser, workflowId: string, workflow: Workflow | null, what: string): Promise<void> {
    const conflicts = workflow ? await this.claimedByOthers(workflowId, productionRoutingKeys(workflow)) : [];
    if (conflicts.length === 0) return;
    throw new ReleaseError(`Cannot ${what} while another workflow serves production on one of its paths: ${(await this.describeConflicts(user, conflicts)).join(" ")}`, 409, {
      conflicts: conflicts.map((conflict) => conflict.key)
    });
  }

  /** Why publishing `workflow` (a version) would put it on paths another workflow claims. */
  private async conflictReasons(user: SafeUser, workflowId: string, workflow: Workflow): Promise<string[]> {
    const conflicts = await this.claimedByOthers(workflowId, productionRoutingKeys(workflow));
    if (conflicts.length === 0) return [];
    return [...(await this.describeConflicts(user, conflicts)), "Production traffic on that path already goes to another workflow: give this version its own paths before publishing."];
  }

  // -------------------------------------------------------------------------
  // What only admins may do on an enforced gate
  // -------------------------------------------------------------------------

  private async enforcedGateOf(workflowId: string): Promise<ReleaseGateRecord | null> {
    const gate = await this.store.getReleaseGate(workflowId);
    return gate?.enforced ? gate : null;
  }

  private async refuse(user: SafeUser, workflowId: string, eventType: string, action: string, metadata: Record<string, unknown>): Promise<void> {
    await this.options.audit({
      category: "release",
      eventType,
      action,
      outcome: "denied",
      actor: { userId: user.id, email: user.email, type: "user" },
      resourceType: "workflow",
      resourceId: workflowId,
      projectId: await this.projectOf(workflowId),
      metadata
    });
  }

  /** Why `user` may not delete this workflow (an enforced gate: admins only); null when they may. Audits a refusal. */
  async deleteDenial(user: SafeUser, workflowId: string): Promise<string | null> {
    if (user.role === "admin" || !await this.enforcedGateOf(workflowId)) return null;
    await this.refuse(user, workflowId, "release.workflow_delete.refused", "delete", {});
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
  async goldenSetChangeDenial(user: SafeUser, datasetId: string, change: "remove_case" | "delete_set" | "add_case_with_scorers", target: { fixtureId?: string } = {}): Promise<string | null> {
    if (user.role === "admin") return null;
    const dataset = await this.store.getEvalDataset(datasetId);
    if (!dataset?.workflowId) return null;
    const gate = await this.enforcedGateOf(dataset.workflowId);
    if (!gate || !gate.datasetIds.includes(datasetId)) return null;
    if (change === "remove_case") {
      const snapshot = await gateAdmissionSnapshot(this.store, gate);
      if (snapshot && target.fixtureId) {
        const before = admissionState(snapshot);
        const after = { admittedIds: before.admittedIds.filter((id) => id !== target.fixtureId), requiredIds: before.requiredIds.filter((id) => id !== target.fixtureId) };
        const loosening = releaseAdmissionLoosening(before, after, snapshot.names);
        if (loosening.length === 0) return null;
        await this.refuse(user, dataset.workflowId, "release.golden_set_change.refused", "update", { datasetId, change, fixtureId: target.fixtureId, loosening });
        return "An enforced release gate counts this case: only an admin can remove it. Ask for its removal from the gate's Cases panel, and an approver decides in the approvals inbox.";
      }
    }
    await this.refuse(user, dataset.workflowId, "release.golden_set_change.refused", "update", { datasetId, change });
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
  async recordingDeleteDenial(user: SafeUser, workflowId: string, recordingId: string): Promise<string | null> {
    if (user.role === "admin") return null;
    const gate = await this.enforcedGateOf(workflowId);
    if (!gate) return null;
    const snapshot = await gateAdmissionSnapshot(this.store, gate);
    const counted = snapshot?.fixtures.find((fixture) => fixture.recordingId === recordingId && snapshot.admittedIds.has(fixture.id));
    if (!counted) return null;
    await this.refuse(user, workflowId, "release.golden_set_change.refused", "delete", { datasetId: counted.datasetId, change: "delete_recording", recordingId, fixtureId: counted.id });
    return "An enforced release gate counts a case that replays this golden run: only an admin can delete it.";
  }

  /**
   * Before a delete that can take cases away from the workflow's enforced
   * gate: a function that audits it (`release.gate.cases_removed`, naming
   * the admitted and required cases it took and how it loosens the gate)
   * once the delete is done; null when it takes no admitted case.
   *   - `fixture` / `golden_set`: the case, or every case of the set, leaves the gate;
   *   - `golden_run` / `workflow`: the cases replaying the deleted golden run
   *     (every golden run, for a deleted workflow) stay admitted but can no
   *     longer pass, so they are inconclusive from then on.
   */
  async gateCasesRemoval(
    user: SafeUser,
    workflowId: string,
    target:
      | { via: "fixture"; fixtureId: string }
      | { via: "golden_set"; datasetId: string }
      | { via: "golden_run"; recordingId: string }
      | { via: "workflow" }
      | { via: "data_subject"; fixtureIds: readonly string[]; kind: string; id: string }
  ): Promise<(() => Promise<void>) | null> {
    const snapshot = await gateAdmissionSnapshot(this.store, await this.store.getReleaseGate(workflowId));
    if (!snapshot) return null;
    const hit = (fixture: EvalFixtureRecord) => {
      switch (target.via) {
        case "fixture":
          return fixture.id === target.fixtureId;
        case "golden_set":
          return fixture.datasetId === target.datasetId;
        case "golden_run":
          return fixture.recordingId === target.recordingId;
        case "data_subject":
          return target.fixtureIds.includes(fixture.id);
        default:
          return Boolean(fixture.recordingId);
      }
    };
    const taken = snapshot.fixtures.filter((fixture) => snapshot.admittedIds.has(fixture.id) && hit(fixture));
    if (taken.length === 0) return null;
    const ids = taken.map((fixture) => fixture.id);
    const required = snapshot.requiredIds.filter((id) => ids.includes(id));
    const before = admissionState(snapshot);
    const label = ids.map((id) => `"${snapshot.names[id] ?? id}"`).join(", ");
    const leaves = target.via === "fixture" || target.via === "golden_set" || target.via === "data_subject";
    const loosened = leaves
      ? releaseAdmissionLoosening(before, { admittedIds: before.admittedIds.filter((id) => !ids.includes(id)), requiredIds: before.requiredIds.filter((id) => !ids.includes(id)) }, snapshot.names)
      : [`deletes the golden run${ids.length === 1 ? "" : "s"} admitted case${ids.length === 1 ? "" : "s"} ${label} replay${ids.length === 1 ? "s" : ""}, so ${ids.length === 1 ? "it is" : "they are"} inconclusive from now on`];
    return async () => {
      await this.options.audit({
        category: "release",
        eventType: "release.gate.cases_removed",
        action: "delete",
        outcome: "success",
        actor: { userId: user.id, email: user.email, type: "user" },
        resourceType: "workflow",
        resourceId: workflowId,
        projectId: await this.projectOf(workflowId),
        metadata: {
          via: target.via,
          ...(target.via === "fixture" ? { fixtureId: target.fixtureId } : {}),
          ...(target.via === "golden_set" ? { datasetId: target.datasetId } : {}),
          ...(target.via === "golden_run" ? { recordingId: target.recordingId } : {}),
          ...(target.via === "data_subject" ? { target: `${target.kind}:${target.id}` } : {}),
          fixtureIds: ids,
          requiredFixtureIds: required,
          loosened
        }
      });
    };
  }

  /**
   * Before an admin's data-subject delete removes one row (find-subject):
   * a function to call once the row is gone, or null when the row touches
   * no golden-set case and no job's results. Erasure is a legal obligation,
   * so it is never refused here, even for admitted cases of an enforced
   * gate; instead
   *   - the admitted and required cases it takes (a golden run takes every
   *     case replaying it; a case takes itself) are audited as loosening
   *     (`release.gate.cases_removed`, via `data_subject`), and
   *   - every job that held a result of a removed case, or a removed
   *     result, is stale for good: it is marked release-ineligible, so the
   *     release gate and pending release approvals stop accepting it
   *     (`release.jobs.evidence_removed`).
   */
  async dataSubjectRemoval(user: SafeUser, row: { kind: string; id: string }): Promise<(() => Promise<void>) | null> {
    let workflowId: string | null = null;
    let fixtureIds: string[] = [];
    let resultIds: string[] = [];
    if (row.kind === "recording") {
      workflowId = (await this.store.getReplayRecordingSummary(row.id))?.workflowId ?? null;
      fixtureIds = await this.store.evalFixtureIdsForRecording(row.id);
    } else if (row.kind === "fixture") {
      const fixture = await this.store.getEvalFixture(row.id);
      if (fixture) {
        workflowId = (await this.store.getEvalDataset(fixture.datasetId))?.workflowId ?? null;
        fixtureIds = [fixture.id];
      }
    } else if (row.kind === "eval_result") {
      resultIds = [row.id];
    } else {
      return null;
    }
    const runIds = await this.store.evalRunIdsForResults({ fixtureIds, resultIds });
    const casesRemoved = workflowId && fixtureIds.length > 0 ? await this.gateCasesRemoval(user, workflowId, { via: "data_subject", fixtureIds, kind: row.kind, id: row.id }) : null;
    if (!casesRemoved && runIds.length === 0) return null;
    return async () => {
      await casesRemoved?.();
      const stale = await this.store.markEvalRunsReleaseIneligible(runIds, DATA_SUBJECT_EVIDENCE_REMOVED);
      if (stale.length === 0) return;
      await this.options.audit({
        category: "release",
        eventType: "release.jobs.evidence_removed",
        action: "update",
        outcome: "success",
        actor: { userId: user.id, email: user.email, type: "user" },
        resourceType: workflowId ? "workflow" : "eval_run",
        resourceId: workflowId ?? stale[0]!,
        projectId: workflowId ? await this.projectOf(workflowId) : null,
        metadata: { via: "data_subject", target: `${row.kind}:${row.id}`, runIds: stale, fixtureIds, resultIds }
      });
    };
  }

  /**
   * What a replay job view carries when the workflow's enforced gate uses
   * one of the job's golden sets: the gate's admitted, pending and required
   * cases, and how the gate judges the job's case results under its current
   * policy and admission (the CLI's exit code follows that verdict). Whether
   * the job may prove a release (its hash, sets, eligibility, scorers) is
   * left out here: the job view reports it on its own. Null otherwise.
   */
  async jobGateAdmission(job: JobView): Promise<ReleaseGateJobAdmission | null> {
    const record = await this.store.getReleaseGate(job.workflowId);
    const jobSets = job.datasetIds ?? [];
    if (!record?.enforced || !record.datasetIds.some((datasetId) => jobSets.includes(datasetId))) return null;
    const snapshot = await gateAdmissionSnapshot(this.store, record);
    if (!snapshot) return null;
    const gate = this.settingsOf(record, job.workflowId);
    const evidence = await this.evidenceFor(job, gate);
    const workflowHash = evidence.job.workflowHash ?? "";
    const judgement = judgeReleaseGate(
      {
        job: { id: evidence.job.id, status: evidence.job.status, workflowHash, datasetIds: gate.datasetIds, compare: evidence.job.compare ?? null, liveWrites: false },
        cases: evidence.cases
      },
      gate.policy,
      { expected: { workflowHash, datasetIds: [] }, requireApproval: gate.requireApproval, now: this.now(), admission: judgeAdmission(snapshot) }
    );
    return {
      enforced: true,
      admittedFixtureIds: [...snapshot.admittedIds],
      pendingFixtureIds: snapshot.fixtures.map((fixture) => fixture.id).filter((id) => !snapshot.admittedIds.has(id)),
      requiredFixtureIds: snapshot.requiredIds,
      requiredCaseNames: Object.fromEntries(snapshot.requiredIds.map((id) => [id, snapshot.names[id] ?? id])),
      errorsCountAsFailures: gate.policy.errorsCountAsFailures,
      verdict: judgement.verdict,
      reasons: judgement.reasons,
      setsChanged: Boolean(evidence.job.noSetSnapshot) || (evidence.job.staleSets?.length ?? 0) > 0
    };
  }

  private async projectOf(workflowId: string): Promise<string | null> {
    return (await this.store.getWorkflow(workflowId))?.projectId ?? null;
  }

  // -------------------------------------------------------------------------
  // Judging
  // -------------------------------------------------------------------------

  /** The version as it would run, and its hash; 404 when it does not exist. */
  async versionCandidate(workflowId: string, version: number): Promise<{ workflow: Workflow; workflowHash: string }> {
    if (!await this.store.getWorkflowVersion(workflowId, version)) throw new ReleaseError(`Version ${version} of this workflow was not found`, 404);
    let workflow: Workflow;
    try {
      workflow = await this.options.resolveVersion(workflowId, version);
    } catch (error) {
      throw new ReleaseError(error instanceof Error ? error.message : `Version ${version} could not be read`, 404);
    }
    return { workflow, workflowHash: this.options.hashOf(workflow) };
  }

  /**
   * What the gate's own sets hold now: their case ids and snapshots, and,
   * for an enforced gate whose admission is stored, the admitted cases
   * (staleness is then judged over those alone).
   */
  private async gateSets(gate: Pick<ReleaseGateView, "workflowId" | "datasetIds" | "enforced">): Promise<GateSets> {
    const fixtureIds = new Set<string>();
    const snapshots = await goldenSetSnapshots(gate.datasetIds, async (datasetId) => {
      const fixtures = await this.store.listEvalFixtures(datasetId);
      for (const fixture of fixtures) fixtureIds.add(fixture.id);
      return fixtures;
    });
    const admission = gate.enforced ? await gateAdmissionSnapshot(this.store, await this.store.getReleaseGate(gate.workflowId)) : null;
    return { fixtureIds, snapshots, admittedIds: admission && !admission.admissionMissing ? admission.admittedIds : null };
  }

  /**
   * What `judgeReleaseGate` needs from a replay job: the cases of the gate's
   * own sets with repeats aggregated, and how the job's scorers, set
   * snapshot and own eligibility compare with the gate.
   */
  async evidenceFor(job: JobView, gate: Pick<ReleaseGateView, "workflowId" | "datasetIds" | "candidateOptions" | "enforced">, sets?: GateSets): Promise<ReleaseGateEvidence> {
    const current = sets ?? await this.gateSets(gate);
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
        const diff = asRecord((await this.options.loadCase(job.id, result.id))?.replay?.diff);
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
        recordingCreatedAt: first.recordingId ? await this.options.recordingCreatedAt(first.recordingId) : null,
        diffMissing
      });
    }
    const candidate = asRecord(job.candidate);
    const eligible = candidate.releaseEligible ?? options.releaseEligible;
    const ineligible = candidate.releaseIneligibleReasons ?? options.releaseIneligibleReasons ?? candidate.ineligibleReasons ?? options.ineligibleReasons;
    const record = await this.store.getEvalRun(job.id);
    const jobScorers = (record?.scorers ?? null) as unknown[] | null;
    let scorerMismatch: string | null = null;
    if (!releaseScorersMatch(gate.candidateOptions.scorers, jobScorers)) {
      const types = (jobScorers ?? []).map((scorer) => String(asRecord(scorer).type ?? "unknown"));
      scorerMismatch = types.length > 0 ? `ran with its own scorers (${types.join(", ")})` : "ran with the default scorers, not the ones the gate names";
    }
    const jobSnapshot = await this.store.getEvalRunSetSnapshot(job.id);
    const staleSets = jobSnapshot ? staleGoldenSets(gate.datasetIds, jobSnapshot, current.snapshots, current.admittedIds) : [...gate.datasetIds];
    const staleSetCounts = Object.fromEntries(staleSets.map((id) => [id, jobSnapshot ? staleGoldenSetCount(jobSnapshot[id], current.snapshots[id], current.admittedIds) : 1]));
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
        ...(jobSnapshot ? { staleSetCounts } : {}),
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
  async judge(gate: ReleaseGateView, workflowId: string, workflowHash: string, replayRunId?: string): Promise<{ judgement: ReleaseGateJudgement; replayRunId?: string }> {
    const sets = await this.gateSets(gate);
    // On an enforced gate a set with no admitted case yet counts for nothing, so a job that did not run it still covers the gate.
    const datasetIds = sets.admittedIds
      ? gate.datasetIds.filter((id) => Object.keys(sets.snapshots[id]?.cases ?? {}).some((fixtureId) => sets.admittedIds!.has(fixtureId)))
      : gate.datasetIds;
    const expected = {
      workflowHash,
      datasetIds,
      mcpMode: gate.candidateOptions.mcpMode ?? "strict",
      setCaseCounts: Object.fromEntries(
        gate.datasetIds.map((id) => {
          const cases = Object.keys(sets.snapshots[id]?.cases ?? {});
          return [id, sets.admittedIds ? cases.filter((fixtureId) => sets.admittedIds!.has(fixtureId)).length : cases.length];
        })
      ),
      scorersKey: createHash("sha256").update(releaseCanonicalJson(gate.candidateOptions.scorers ?? null)).digest("hex").slice(0, 16)
    };
    // Enforced gates count only admitted cases, and required cases must pass (null: every case counts, as before).
    const admission = gate.enforced ? judgeAdmission(await gateAdmissionSnapshot(this.store, await this.store.getReleaseGate(workflowId))) : null;
    const judgeJob = async (job: JobView) =>
      judgeReleaseGate(await this.evidenceFor(job, gate, sets), gate.policy, { expected, requireApproval: gate.requireApproval, now: this.now(), admission });
    if (replayRunId) {
      const job = await this.options.loadJob(replayRunId);
      if (!job || job.kind !== "replay" || job.workflowId !== workflowId) throw new ReleaseError("Replay job not found", 404);
      return { judgement: await judgeJob(job), replayRunId: job.id };
    }
    let newest: { judgement: ReleaseGateJudgement; replayRunId: string } | null = null;
    for (const id of await this.store.listReplayRunIdsForHash(workflowId, workflowHash)) {
      const job = await this.options.loadJob(id);
      if (!job || job.status !== "completed") continue;
      const judged = { judgement: await judgeJob(job), replayRunId: job.id };
      if (judged.judgement.verdict !== "blocked") return judged;
      newest ??= judged;
    }
    return newest ?? { judgement: judgeReleaseGate(null, gate.policy, { expected, now: this.now(), admission }) };
  }

  /** The publish dialog's preview: the verdict publishing would get now. */
  async preview(user: SafeUser, workflowId: string, version: number, replayRunId?: string): Promise<ReleasePublishPreview> {
    await this.check(user, workflowId, "workflow:read");
    const gate = this.settingsOf(await this.store.getReleaseGate(workflowId), workflowId);
    const { workflowHash } = await this.versionCandidate(workflowId, version);
    if (!gate.enabled) return { version, workflowHash, gateEnabled: false, verdict: "passed", reasons: [], replayRunId: null, stats: null, canRequestApproval: false };
    const { judgement, replayRunId: judgedRun } = await this.judge(gate, workflowId, workflowHash, replayRunId);
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

  async releases(user: SafeUser, workflowId: string, limit?: number): Promise<{ releases: WorkflowRelease[]; publishedVersion: number | null }> {
    await this.check(user, workflowId, "workflow:read");
    return {
      releases: (await this.store.listWorkflowReleases(workflowId, limit)).map((record) => this.toRelease(record)),
      publishedVersion: await this.store.getPublishedVersion(workflowId)
    };
  }

  private async commitRelease(input: {
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
  }): Promise<WorkflowRelease> {
    const record = await this.store.publishWorkflowVersion(
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
    await this.options.audit({
      category: "release",
      eventType: input.verdict === "rollback" ? "release.rolled_back" : input.verdict === "overridden" ? "release.overridden" : "release.published",
      action: input.verdict === "rollback" ? "rollback" : "publish",
      outcome: "success",
      actor: { userId: input.actor.id, email: input.actor.email, type: "user" },
      resourceType: "workflow",
      resourceId: input.workflowId,
      projectId: await this.projectOf(input.workflowId),
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
      await this.options.onPublished(input.workflowId);
    } catch (error) {
      this.options.logger?.warn("Re-registering triggers after a release failed", { workflowId: input.workflowId, error: error instanceof Error ? error.message : String(error) });
    }
    return release;
  }

  async publish(user: SafeUser, workflowId: string, input: ReleasePublishInput): Promise<PublishOutcome> {
    await this.check(user, workflowId, "workflow:publish");
    const { workflowHash } = await this.versionCandidate(workflowId, input.version);
    const gate = this.settingsOf(await this.store.getReleaseGate(workflowId), workflowId);
    const previous = await this.store.getPublishedVersion(workflowId);
    if (input.workflowHash && input.workflowHash !== workflowHash) {
      return {
        status: 409,
        verdict: "blocked",
        reasons: [`Version ${input.version} has hash ${workflowHash}, not the ${input.workflowHash} given: the version is not what was tested.`],
        canRequestApproval: false
      };
    }
    if (input.override && user.role !== "admin") throw new ReleaseError("Only admins can override the release gate", 403);
    const conflicts = await this.conflictReasons(user, workflowId, (await this.versionCandidate(workflowId, input.version)).workflow);
    if (conflicts.length > 0) {
      // Not even an override: production routing would be ambiguous, whatever the gate says.
      return { status: 409, verdict: "blocked", reasons: conflicts, canRequestApproval: false };
    }
    if (!gate.enabled) {
      return {
        status: 200,
        release: await this.commitRelease({ actor: user, workflowId, version: input.version, workflowHash, verdict: "ungated", replayRunId: null, reason: null, gateReasons: [], approval: null, expectedPrevious: previous })
      };
    }
    const { judgement, replayRunId } = await this.judge(gate, workflowId, workflowHash, input.replayRunId);
    if (judgement.verdict === "passed") {
      return {
        status: 200,
        release: await this.commitRelease({ actor: user, workflowId, version: input.version, workflowHash, verdict: "passed", replayRunId: replayRunId ?? null, reason: null, gateReasons: [], approval: null, expectedPrevious: previous })
      };
    }
    if (input.override) {
      return {
        status: 200,
        release: await this.commitRelease({
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
      const request = await this.requestApproval({
        user,
        workflowId,
        version: input.version,
        workflowHash,
        replayRunId: replayRunId ?? null,
        origin: judgement.verdict === "needs_approval" ? "policy" : "blocked",
        gate,
        reasons: judgement.verdict === "needs_approval" ? [] : judgement.reasons,
        checks: judgement.verdict === "needs_approval" ? [] : judgement.checks,
        requestReason: input.requestApproval?.reason ?? null,
        publishedVersion: previous
      });
      return { status: 202, verdict: "needs_approval", approvalRequestId: request.id, reasons: judgement.reasons };
    }
    await this.options.audit({
      category: "release",
      eventType: "release.blocked",
      action: "publish",
      outcome: "denied",
      actor: { userId: user.id, email: user.email, type: "user" },
      resourceType: "workflow",
      resourceId: workflowId,
      projectId: await this.projectOf(workflowId),
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
  async rollback(user: SafeUser, workflowId: string, input: ReleaseRollbackInput): Promise<WorkflowRelease> {
    await this.check(user, workflowId, "workflow:publish");
    if (await this.enforcedGateOf(workflowId) && user.role !== "admin") {
      await this.refuse(user, workflowId, "release.rollback.refused", "rollback", { version: input.version });
      throw new ReleaseError("This workflow's release gate is enforced: only an admin can roll back", 403);
    }
    const previous = await this.store.getPublishedVersion(workflowId);
    if (previous === input.version) throw new ReleaseError(`Version ${input.version} is already published`, 409);
    if (!await this.store.hasReleasedVersion(workflowId, input.version)) {
      throw new ReleaseError(`Version ${input.version} was never published, so it cannot be rolled back to; publish it instead`, 409);
    }
    const { workflow, workflowHash } = await this.versionCandidate(workflowId, input.version);
    if (!(await this.store.listReleasedVersionHashes(workflowId, input.version)).includes(workflowHash)) {
      throw new ReleaseError(`Version ${input.version} no longer has the hash it was released with (the workflow moved project or was created again), so it cannot be rolled back to; publish it through the gate instead`, 409);
    }
    const conflicts = await this.conflictReasons(user, workflowId, workflow);
    if (conflicts.length > 0) throw new ReleaseError(conflicts.join(" "), 409);
    return await this.commitRelease({ actor: user, workflowId, version: input.version, workflowHash, verdict: "rollback", replayRunId: null, reason: input.reason, gateReasons: [], approval: null, expectedPrevious: previous });
  }

  /**
   * Takes the published version down: production runs the draft until a
   * version is published again. Needs `workflow:publish` (as publish does);
   * the gate never blocks it, and with a gate on the answer says plainly that
   * production now runs the ungated draft. Refused (409) when nothing is
   * published, a second call included, and when the draft's production paths
   * are another workflow's. With `expectedVersion` it takes down only that version (409 when another one is live,
   * nothing changed). Audited as `release.unpublished`.
   */
  async unpublish(user: SafeUser, workflowId: string, input: ReleaseUnpublishInput): Promise<ReleaseUnpublishResult> {
    await this.check(user, workflowId, "workflow:publish");
    const nothingPublished = () => new ReleaseError("Nothing is published: production already runs the draft", 409);
    const versionChanged = (live: number) =>
      new ReleaseError(`v${live} is live now, not v${input.expectedVersion}: it was published or rolled back after you opened this. Reload and check before unpublishing`, 409);
    const refusal = async (): Promise<ReleaseError> => {
      const { publishedVersion } = await this.store.getPublishState(workflowId);
      return publishedVersion === null ? nothingPublished() : versionChanged(publishedVersion);
    };
    const live = (await this.store.getPublishState(workflowId)).publishedVersion;
    if (live === null) throw nothingPublished();
    if (input.expectedVersion !== undefined && input.expectedVersion !== live) throw versionChanged(live);
    // The draft is about to serve production: its paths must be its own, as for a publish.
    await this.assertNoRoutingConflicts(user, workflowId, await this.store.getWorkflow(workflowId), "unpublish");
    const gate = await this.store.getReleaseGate(workflowId);
    const reason = input.reason?.trim() ? input.reason.trim() : null;
    const record = await this.store.unpublishWorkflowVersion({
      id: `rel_${randomUUID()}`,
      workflowId,
      reason,
      expectedVersion: input.expectedVersion ?? null,
      unpublishedAt: this.now().toISOString(),
      unpublishedBy: user.email,
      unpublishedByUserId: user.id
    });
    // Another unpublish or a republish got there first: the store wrote nothing.
    if (!record) throw await refusal();
    const release = this.toRelease(record);
    const gateEnabled = gate?.enabled ?? false;
    const gateEnforced = gateEnabled && (gate?.enforced ?? false);
    await this.options.audit({
      category: "release",
      eventType: "release.unpublished",
      action: "unpublish",
      outcome: "success",
      actor: { userId: user.id, email: user.email, type: "user" },
      resourceType: "workflow",
      resourceId: workflowId,
      projectId: await this.projectOf(workflowId),
      metadata: { releaseId: release.id, version: release.version, workflowHash: release.workflowHash, reason: release.reason, gateEnabled, gateEnforced }
    });
    try {
      await this.options.onPublished(workflowId);
    } catch (error) {
      this.options.logger?.warn("Re-registering triggers after an unpublish failed", { workflowId, error: error instanceof Error ? error.message : String(error) });
    }
    return { release, productionRuns: "draft", gateEnabled, gateEnforced, notice: releaseUnpublishNotice({ version: release.version, gateEnabled, gateEnforced }) };
  }

  // -------------------------------------------------------------------------
  // Release requests (the approvals inbox)
  // -------------------------------------------------------------------------

  private async requestApproval(input: {
    user: SafeUser;
    workflowId: string;
    version: number;
    workflowHash: string;
    replayRunId: string | null;
    origin: "policy" | "blocked";
    gate: ReleaseGateView;
    reasons: string[];
    /** The reasons as stable codes (`ReleaseGateJudgement.checks`), judged again when the request is decided. */
    checks: ReleaseGateJudgement["checks"];
    requestReason: string | null;
    publishedVersion: number | null;
  }): Promise<ReleaseApprovalRequestRecord> {
    // Each requester has their own request (their reason, their name on it); stale and expired ones are closed first.
    await this.sweepExpired();
    for (const existing of await this.store.listPendingReleaseApprovalRequests(input.workflowId, input.version, input.workflowHash)) {
      const stale = await this.staleReason(existing);
      if (stale) {
        await this.closeRequest(existing, "canceled", `Stale: ${stale}`, null);
        continue;
      }
      if (!sameIdentity({ id: existing.requestedByUserId, email: existing.requestedBy }, input.user)) continue;
      // Asking again after the gate got worse must not hand back a request that approval would cancel.
      const worse = await this.newGateReasons(existing);
      if (worse) {
        await this.closeRequest(existing, "canceled", `Stale: The release gate now judges version ${existing.version} differently than when the request was made: ${worse.join(" ")}`, null);
        continue;
      }
      return existing;
    }
    const approvers: ReleaseApprovers = input.gate.approvers ?? releaseApproversSchema.parse({});
    const createdAt = this.now();
    const workflow = await this.store.getWorkflow(input.workflowId);
    const record = await this.store.insertReleaseApprovalRequest({
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
      gateChecks: input.checks,
      gateAuthority: gateAuthority(input.gate),
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
    await this.options.audit({
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
  private async sweepExpired(): Promise<void> {
    for (const record of await this.store.timeOutExpiredReleaseApprovalRequests(this.now().toISOString())) {
      await this.options.audit({
        category: "release",
        eventType: "release.approval.timed_out",
        action: "timeout",
        outcome: "success",
        actor: { type: "system", email: "system" },
        resourceType: "workflow",
        resourceId: record.workflowId,
        projectId: await this.projectOf(record.workflowId),
        metadata: { requestId: record.id, version: record.version, workflowHash: record.workflowHash }
      });
    }
  }

  /** Why approving this request now would publish something other than what was asked; null when it is still valid. */
  async staleReason(record: ReleaseApprovalRequestRecord): Promise<string | null> {
    let hash: string;
    try {
      hash = (await this.versionCandidate(record.workflowId, record.version)).workflowHash;
    } catch {
      return `Version ${record.version} no longer exists.`;
    }
    if (hash !== record.workflowHash) return `Version ${record.version} no longer has the hash that was asked for (the workflow moved project).`;
    const gate = await this.store.getReleaseGate(record.workflowId);
    // Who decides is what a settings change must not move under a request; a builder's tightening is judged again by the reasons instead.
    // Requests made before the fingerprint existed keep the timestamp rule.
    if (record.gateAuthority) {
      if (!gate || gateAuthority(gate) !== record.gateAuthority) return "Who may approve this release (the gate's approvers, self-approval or enforcement) changed after the request was made.";
    } else if ((gate?.updatedAt ?? null) !== record.gateUpdatedAt) {
      return "The release gate's settings changed after the request was made.";
    }
    const publishedNow = await this.store.getPublishedVersion(record.workflowId);
    if (publishedNow !== record.publishedVersionAtRequest) {
      return publishedNow === null ? "Production was unpublished after the request was made." : "Another version was published after the request was made.";
    }
    return null;
  }

  /**
   * The gate's current reasons against the request's version when it now
   * blocks it worse than when the request was made: a kind of reason it did
   * not give (an admitted case the job never ran, a new failing required
   * case) or a worse measure of one it gave (a lower pass rate against the
   * minimum, more regressions); null when it does not. Reasons are compared
   * by their stable codes, never their wording, so better numbers or a case
   * waiting for admission change nothing. The request's own replay job is
   * judged again, or, when it named none, the jobs for the version's hash.
   */
  private async newGateReasons(record: ReleaseApprovalRequestRecord): Promise<string[] | null> {
    const gate = this.settingsOf(await this.store.getReleaseGate(record.workflowId), record.workflowId);
    if (!gate.enabled) return null;
    let judgement: ReleaseGateJudgement;
    try {
      judgement = (await this.judge(gate, record.workflowId, record.workflowHash, record.replayRunId ?? undefined)).judgement;
    } catch (error) {
      if (!(error instanceof ReleaseError) || error.statusCode !== 404) throw error;
      return [`Replay job ${record.replayRunId} no longer exists.`];
    }
    if (judgement.verdict !== "blocked") return null;
    // Requests made before reason codes existed: their reasons, worded as then, are all there is to compare.
    if (!record.gateChecks) {
      const known = new Set(record.gateReasons);
      return judgement.reasons.some((reason) => !known.has(reason)) ? judgement.reasons : null;
    }
    return releaseGateChecksWorsened(record.gateChecks, judgement.checks).length > 0 ? judgement.reasons : null;
  }

  private async personCheck(record: ReleaseApprovalRequestRecord, user: SafeUser): Promise<{ allowed: true } | { allowed: false; code: string; message: string }> {
    if (!(await this.options.access(user, record.workflowId, "workflow:publish")).ok) {
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
    const author = (await this.store.getWorkflowVersion(record.workflowId, record.version))?.createdBy ?? null;
    if (author && spec.allowSelfApproval !== true && sameIdentity({ id: author, email: author }, user)) {
      return { allowed: false, code: "self_approval", message: AUTHOR_APPROVAL_MESSAGE };
    }
    return { allowed: true };
  }

  private async toView(record: ReleaseApprovalRequestRecord, user: SafeUser): Promise<ReleaseApprovalRequestView> {
    const spec = asRecord(record.spec);
    const status = record.status === "pending" && this.expired(record) ? "timed_out" : record.status;
    const check = status === "pending" ? await this.personCheck(record, user) : { allowed: false as const, message: "Already decided." };
    return {
      kind: "release",
      requestId: record.id,
      id: record.id,
      workflowId: record.workflowId,
      workflowName: record.workflowName,
      projectId: (await this.store.getWorkflow(record.workflowId))?.projectId ?? record.projectId,
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
  async listRequests(user: SafeUser, filter: { status: "pending" | "decided" | "all"; workflowId?: string; limit?: number }): Promise<ReleaseApprovalRequestView[]> {
    await this.sweepExpired();
    const workflowIds = await this.options.readableWorkflowIds(user);
    const rows = await this.store.listReleaseApprovalRequests({ ...filter, now: this.now().toISOString(), scope: workflowIds === null ? { all: true } : { workflowIds } });
    const views: ReleaseApprovalRequestView[] = [];
    for (const row of rows) {
      if (!(await this.options.access(user, row.workflowId, "workflow:read")).ok) continue;
      const view = await this.toView(row, user);
      // An expired request is decided (timed out) for the inbox's filters.
      if (filter.status === "pending" && view.status !== "pending") continue;
      views.push(view);
    }
    return views;
  }

  private async closeRequest(record: ReleaseApprovalRequestRecord, status: "canceled" | "timed_out", reason: string, actor: SafeUser | null): Promise<void> {
    if (!await this.store.decideReleaseApprovalRequest({ id: record.id, status, decisionReason: reason, decidedByUserId: actor?.id ?? null, decidedBy: actor?.email ?? "system" })) return;
    await this.options.audit({
      category: "release",
      eventType: status === "timed_out" ? "release.approval.timed_out" : "release.approval.canceled",
      action: status === "timed_out" ? "timeout" : "cancel",
      outcome: "success",
      actor: actor ? { userId: actor.id, email: actor.email, type: "user" } : { type: "system", email: "system" },
      resourceType: "workflow",
      resourceId: record.workflowId,
      projectId: await this.projectOf(record.workflowId),
      metadata: { requestId: record.id, version: record.version, workflowHash: record.workflowHash, reason }
    });
  }

  /**
   * Decides a release request. Approving publishes exactly the requested
   * version and hash, as the approver; the decision and the release commit
   * together. Throws a `ReleaseError` with the HTTP status when refused.
   */
  async decide(user: SafeUser, requestId: string, decision: "approve" | "reject", reason?: string): Promise<{ request: ReleaseApprovalRequestView; release: WorkflowRelease | null }> {
    const record = await this.store.getReleaseApprovalRequest(requestId);
    if (!record || !(await this.options.access(user, record.workflowId, "workflow:read")).ok) throw new ReleaseError("Pending approval not found", 404);
    if (record.status !== "pending") throw new ReleaseError("This approval was already decided", 409);
    if (this.expired(record)) {
      await this.closeRequest(record, "timed_out", "Nobody decided before the release request expired", null);
      throw new ReleaseError("This release request expired; ask again", 409);
    }
    const check = await this.personCheck(record, user);
    if (!check.allowed) {
      await this.options.audit({
        category: "release",
        eventType: "release.approval.decided",
        action: decision,
        outcome: "denied",
        actor: { userId: user.id, email: user.email, type: "user" },
        resourceType: "workflow",
        resourceId: record.workflowId,
        projectId: await this.projectOf(record.workflowId),
        metadata: { requestId: record.id, version: record.version, refused: check.code }
      });
      throw new ReleaseError(check.message, 403);
    }
    const trimmed = reason?.trim() || null;
    if (decision === "reject") {
      if (!trimmed) throw new ReleaseError("A reason is required to reject a release request", 400);
      if (!await this.store.decideReleaseApprovalRequest({ id: record.id, status: "rejected", decidedByUserId: user.id, decidedBy: user.email, decisionReason: trimmed })) {
        throw new ReleaseError("This approval was already decided", 409);
      }
      await this.auditDecision(record, user, decision, trimmed, null);
      return { request: await this.toView((await this.store.getReleaseApprovalRequest(record.id))!, user), release: null };
    }
    const stale = await this.staleReason(record);
    if (stale) {
      await this.closeRequest(record, "canceled", `Stale: ${stale}`, user);
      throw new ReleaseError(`This release request is stale and was canceled: ${stale} Ask again.`, 409);
    }
    const conflicts = await this.conflictReasons(user, record.workflowId, (await this.versionCandidate(record.workflowId, record.version)).workflow);
    if (conflicts.length > 0) throw new ReleaseError(conflicts.join(" "), 409);
    // Judged again now: admitted cases, required cases and the policy may have changed since the request was made.
    const worse = await this.newGateReasons(record);
    if (worse) {
      const why = `The release gate now judges version ${record.version} differently than when the request was made: ${worse.join(" ")}`;
      await this.closeRequest(record, "canceled", `Stale: ${why}`, user);
      throw new ReleaseError(`This release request is stale and was canceled. ${why} Ask again.`, 409, { reasons: worse });
    }
    const decidedAt = this.now().toISOString();
    const releaseId = `rel_${randomUUID()}`;
    // The decision and the publish commit together: a lost race leaves the request pending and nothing published.
    const outcome = await this.store.approveReleaseRequestAndPublish(
      { id: record.id, status: "approved", decidedByUserId: user.id, decidedBy: user.email, decisionReason: trimmed, releaseId },
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
    if ("refused" in outcome) {
      throw new ReleaseError(outcome.refused === "decided" ? "This approval was already decided" : "Another version was published at the same time; ask again", 409);
    }
    const release = outcome.release;
    const view = this.toRelease(release);
    await this.auditDecision(record, user, decision, trimmed, view.id);
    await this.options.audit({
      category: "release",
      eventType: "release.published",
      action: "publish",
      outcome: "success",
      actor: { userId: user.id, email: user.email, type: "user" },
      resourceType: "workflow",
      resourceId: record.workflowId,
      projectId: await this.projectOf(record.workflowId),
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
      await this.options.onPublished(record.workflowId);
    } catch (error) {
      this.options.logger?.warn("Re-registering triggers after a release failed", { workflowId: record.workflowId, error: error instanceof Error ? error.message : String(error) });
    }
    return { request: await this.toView((await this.store.getReleaseApprovalRequest(record.id))!, user), release: view };
  }

  private async auditDecision(record: ReleaseApprovalRequestRecord, user: SafeUser, decision: "approve" | "reject", reason: string | null, releaseId: string | null): Promise<void> {
    await this.options.audit({
      category: "release",
      eventType: "release.approval.decided",
      action: decision,
      outcome: "success",
      actor: { userId: user.id, email: user.email, type: "user" },
      resourceType: "workflow",
      resourceId: record.workflowId,
      projectId: await this.projectOf(record.workflowId),
      metadata: { requestId: record.id, version: record.version, workflowHash: record.workflowHash, decision, reason: reason ? this.options.redact(reason) : null, releaseId }
    });
  }
}

