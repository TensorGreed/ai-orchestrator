import { z } from "zod";
import { APPROVAL_MAX_TIMEOUT_MINUTES, APPROVAL_REASON_MAX_LENGTH, APPROVER_ROLE_VALUES } from "./approval-gate";
import { REPLAY_MCP_MODES } from "./replay";

/**
 * Phase 15.4 — release gate and publish: the shared contract.
 *
 * A workflow with a published version runs that version for production
 * traffic (production webhooks, schedules, app triggers, the MCP gateway,
 * chat, forms, queued runs and sub-workflow calls from those runs); the
 * editor, manual runs and `/webhook-test/` run the draft. Without a
 * published version every entry point runs the draft, as before.
 *
 * With the gate enabled, publishing a saved version needs a completed replay
 * job for that exact workflow hash over the gate's golden sets, judged by
 * `judgeReleaseGate` under the gate policy in force at publish time. A
 * blocked publish can be sent to the gate's approvers, and an admin can
 * override it with a reason. Both are audited and stored on the release.
 */

/** Golden runs older than this push the gate to a fresh baseline rerun (decision 3). */
export const RELEASE_DEFAULT_MAX_RECORDING_AGE_DAYS = 30;
/** How long a release approval request waits by default: 7 days. */
export const RELEASE_APPROVAL_DEFAULT_TIMEOUT_MINUTES = 10_080;
/** Most golden sets one gate may require. */
export const RELEASE_GATE_MAX_DATASETS = 10;

export const RELEASE_COMPARE_MODES = ["recording", "baseline_rerun"] as const;
export type ReleaseCompareMode = (typeof RELEASE_COMPARE_MODES)[number];
export const RELEASE_AGGREGATE_MODES = ["all", "majority", "any"] as const;
export type ReleaseAggregateMode = (typeof RELEASE_AGGREGATE_MODES)[number];

/** How a release came about. `approved`: an approver accepted a release request. */
export const RELEASE_VERDICTS = ["passed", "overridden", "ungated", "rollback", "approved"] as const;
export type ReleaseVerdict = (typeof RELEASE_VERDICTS)[number];

export const RELEASE_CHANNELS = ["production", "draft"] as const;
/** Which version an entry point runs: `production` the published one (when there is one), `draft` the saved workflow. */
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

const idSchema = z.string().trim().min(1).max(200);
const reasonSchema = z.string().trim().min(1, "A reason is required").max(APPROVAL_REASON_MAX_LENGTH);
const pctSchema = z.number().min(0).max(1e6);

export const releaseGatePolicySchema = z
  .object({
    /** Share of judged cases that must pass, 0..1. */
    minPassRate: z.number().min(0).max(1).default(1),
    /** Cases that passed on the baseline but fail on the candidate. */
    maxRegressions: z.number().int().min(0).max(100_000).default(0),
    /** Inconclusive cases (a strict cassette miss, a timeout) count as failures. */
    errorsCountAsFailures: z.boolean().default(true),
    /** Scorer types that must pass on every judged case. */
    requiredScorers: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
    /** Total candidate cost over total baseline cost, in percent above it. */
    maxCostIncreasePct: pctSchema.optional(),
    /** p95 candidate latency over p95 baseline latency, in percent above it. */
    maxP95LatencyIncreasePct: pctSchema.optional(),
    /** No case may add a non-shadow `block` or `review` guard verdict. */
    noNewGuardBlocks: z.boolean().default(true),
    /** Refuse to pass a near-empty set. */
    minCases: z.number().int().min(1).max(10_000).default(3),
    /** Golden runs older than this pass only in a job with `compare: "baseline_rerun"`. */
    maxRecordingAgeDays: z.number().int().min(1).max(3650).default(RELEASE_DEFAULT_MAX_RECORDING_AGE_DAYS)
  })
  .strict();
export type ReleaseGatePolicy = z.output<typeof releaseGatePolicySchema>;
export type ReleaseGatePolicyInput = z.input<typeof releaseGatePolicySchema>;

/** Who may approve a release request. With no roles and no users, anyone else with `workflow:publish` may. */
export const releaseApproversSchema = z
  .object({
    approverRoles: z.array(z.enum(APPROVER_ROLE_VALUES)).max(APPROVER_ROLE_VALUES.length).default([]),
    /** User ids or emails. */
    approverUsers: z.array(z.string().trim().min(1).max(320)).max(50).default([]),
    allowSelfApproval: z.boolean().default(false),
    timeoutMinutes: z.number().int().min(1).max(APPROVAL_MAX_TIMEOUT_MINUTES).default(RELEASE_APPROVAL_DEFAULT_TIMEOUT_MINUTES)
  })
  .strict();
export type ReleaseApprovers = z.output<typeof releaseApproversSchema>;

/** Defaults for the replay jobs the gate asks for ("Run gate" in the publish dialog, `l2m release`). */
export const releaseCandidateOptionsSchema = z
  .object({
    mcpMode: z.enum(REPLAY_MCP_MODES).optional(),
    compare: z.enum(RELEASE_COMPARE_MODES).optional(),
    repeats: z.number().int().min(1).max(5).optional(),
    aggregate: z.enum(RELEASE_AGGREGATE_MODES).optional(),
    maxCostUsd: z.number().positive().max(100_000).optional()
  })
  .strict();
export type ReleaseCandidateOptions = z.output<typeof releaseCandidateOptionsSchema>;

/** `PUT /api/workflows/:id/release-gate`. */
export const releaseGateSettingsSchema = z
  .object({
    enabled: z.boolean(),
    /** Admins only: builders cannot then disable or loosen the gate. */
    enforced: z.boolean().optional(),
    datasetIds: z.array(idSchema).max(RELEASE_GATE_MAX_DATASETS).default([]),
    candidateOptions: releaseCandidateOptionsSchema.default({}),
    policy: releaseGatePolicySchema.default(releaseGatePolicySchema.parse({})),
    /** Every publish waits for an approver, even when the replay job passed. */
    requireApproval: z.boolean().default(false),
    /** Who may approve; also what makes "request approval" possible for a blocked publish. */
    approvers: releaseApproversSchema.nullable().default(null)
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.enabled && value.datasetIds.length === 0) {
      ctx.addIssue({ code: "custom", path: ["datasetIds"], message: "An enabled gate needs at least one golden set" });
    }
    if (new Set(value.datasetIds).size !== value.datasetIds.length) {
      ctx.addIssue({ code: "custom", path: ["datasetIds"], message: "A golden set is listed twice" });
    }
    if (value.requireApproval && !value.approvers) {
      ctx.addIssue({ code: "custom", path: ["approvers"], message: "Requiring approval needs approvers" });
    }
  });
export type ReleaseGateSettingsInput = z.input<typeof releaseGateSettingsSchema>;
export type ReleaseGateSettings = z.output<typeof releaseGateSettingsSchema>;

export interface ReleaseGateView extends Omit<ReleaseGateSettings, "enforced"> {
  workflowId: string;
  enforced: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** The gate of a workflow that never configured one. */
export function defaultReleaseGate(workflowId: string): ReleaseGateView {
  return {
    workflowId,
    ...releaseGateSettingsSchema.parse({ enabled: false }),
    enforced: false,
    updatedAt: null,
    updatedBy: null
  };
}

/** `POST /api/workflows/:id/publish`. */
export const releasePublishInputSchema = z
  .object({
    version: z.number().int().positive(),
    /** The hash the caller tested; refused when the version's hash differs. */
    workflowHash: z.string().regex(/^[a-f0-9]{64}$/, "A workflow hash is 64 hex characters").optional(),
    /** The replay job to judge; without it the newest completed job for the version's hash is used. */
    replayRunId: idSchema.optional(),
    /** Admins only: publish although the gate does not pass. */
    override: z.object({ reason: reasonSchema }).strict().optional(),
    /** Send a blocked publish (or one the gate always sends) to the gate's approvers. */
    requestApproval: z.object({ reason: reasonSchema }).strict().optional()
  })
  .strict()
  .refine((value) => !(value.override && value.requestApproval), { message: "Choose an override or an approval request, not both" });
export type ReleasePublishInput = z.infer<typeof releasePublishInputSchema>;

/** `POST /api/workflows/:id/rollback`: back to a version that was published before. */
export const releaseRollbackInputSchema = z
  .object({
    version: z.number().int().positive(),
    reason: reasonSchema
  })
  .strict();
export type ReleaseRollbackInput = z.infer<typeof releaseRollbackInputSchema>;

export interface ReleaseApprovalInfo {
  requestId: string;
  requestedBy: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
}

export interface WorkflowRelease {
  id: string;
  workflowId: string;
  version: number;
  workflowHash: string;
  previousVersion: number | null;
  /** The passing (or judged) replay job; null for an ungated publish or a rollback. */
  replayRunId: string | null;
  verdict: ReleaseVerdict;
  /** The override, rollback or approval-request reason. */
  reason: string | null;
  /** The gate's reasons at publish time, when it did not pass (an override or an approval). */
  gateReasons: string[];
  approval: ReleaseApprovalInfo | null;
  publishedAt: string;
  publishedBy: string | null;
}

export interface WorkflowReleasesView {
  releases: WorkflowRelease[];
  publishedVersion: number | null;
}

// ---------------------------------------------------------------------------
// Judging a replay job against the gate
// ---------------------------------------------------------------------------

export type ReleaseCaseStatus = "pass" | "fail" | "error" | "skipped";

/** One golden run of the job, its repeats already aggregated. */
export interface ReleaseGateCase {
  id: string;
  status: ReleaseCaseStatus;
  /** The baseline's own result in a `baseline_rerun` job; null when compared with the recording (which passed). */
  baselineStatus?: ReleaseCaseStatus | null;
  scorers: Array<{ type: string; pass: boolean }>;
  costUsd: { baseline: number | null; candidate: number | null };
  latencyMs: { baseline: number | null; candidate: number | null };
  /** Non-shadow `block` or `review` guard verdicts the candidate added. */
  newGuardBlocks: number;
  /** When the golden run was saved. */
  recordingCreatedAt: string | null;
}

export interface ReleaseGateJob {
  id: string;
  status: string;
  workflowHash: string | null;
  datasetIds: string[];
  /** A job without the option compared with the recording. */
  compare?: string | null;
  mcpMode?: string | null;
  /** The job made (or was allowed to make) live write calls: never acceptable for a gate. */
  liveWrites: boolean;
}

export interface ReleaseGateEvidence {
  job: ReleaseGateJob;
  cases: ReleaseGateCase[];
}

export interface ReleaseGateExpectation {
  /** The hash of the version being published. */
  workflowHash: string;
  /** The gate's golden sets: the job must cover all of them. */
  datasetIds: string[];
  /** The gate's MCP mode: a strict gate refuses a lenient job. */
  mcpMode?: string;
}

export interface ReleaseGateStats {
  cases: number;
  pass: number;
  fail: number;
  error: number;
  skipped: number;
  /** 0..1 over judged cases (errors are left out when they do not count as failures). */
  passRate: number;
  regressions: number;
  costIncreasePct: number | null;
  p95LatencyIncreasePct: number | null;
  newGuardBlocks: number;
  oldestRecordingDays: number | null;
}

export type ReleaseGateVerdict = "passed" | "blocked" | "needs_approval";

export interface ReleaseGateJudgement {
  verdict: ReleaseGateVerdict;
  reasons: string[];
  stats: ReleaseGateStats;
}

const DAY_MS = 86_400_000;

/** A case's status over its repeats: `all` every repeat passes, `majority` more than half, `any` at least one. */
export function aggregateReleaseRepeats(statuses: readonly ReleaseCaseStatus[], mode: ReleaseAggregateMode = "all"): ReleaseCaseStatus {
  const judged = statuses.filter((status) => status !== "skipped");
  if (judged.length === 0) return "skipped";
  const pass = judged.filter((status) => status === "pass").length;
  const fail = judged.filter((status) => status === "fail").length;
  const passes = mode === "any" ? pass > 0 : mode === "majority" ? pass * 2 > judged.length : pass === judged.length;
  if (passes) return "pass";
  // A failure only counts when the repeats that did run say so; otherwise the case is inconclusive.
  const failsAnyway = mode === "any" ? fail === judged.length : mode === "majority" ? fail * 2 >= judged.length : fail > 0;
  return failsAnyway ? "fail" : "error";
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index]!;
}

function increasePct(baseline: number | null, candidate: number | null): number | null {
  if (baseline === null || candidate === null) return null;
  if (baseline === 0) return candidate > 0 ? Number.POSITIVE_INFINITY : 0;
  return ((candidate - baseline) / baseline) * 100;
}

const formatPct = (value: number) => (Number.isFinite(value) ? `${Math.round(value * 10) / 10}%` : "from zero");

function statsOf(evidence: ReleaseGateEvidence, policy: ReleaseGatePolicy, now: number): ReleaseGateStats {
  const cases = evidence.cases;
  const count = (status: ReleaseCaseStatus) => cases.filter((entry) => entry.status === status).length;
  const pass = count("pass");
  const fail = count("fail");
  const error = count("error");
  const skipped = count("skipped");
  const denominator = pass + fail + (policy.errorsCountAsFailures ? error : 0);
  const baselinePassed = (entry: ReleaseGateCase) => !entry.baselineStatus || entry.baselineStatus === "pass";
  const regressions = cases.filter(
    (entry) => baselinePassed(entry) && (entry.status === "fail" || (policy.errorsCountAsFailures && entry.status === "error"))
  ).length;
  const priced = cases.filter((entry) => entry.costUsd.baseline !== null && entry.costUsd.candidate !== null);
  const costBaseline = priced.length > 0 ? priced.reduce((sum, entry) => sum + entry.costUsd.baseline!, 0) : null;
  const costCandidate = priced.length > 0 ? priced.reduce((sum, entry) => sum + entry.costUsd.candidate!, 0) : null;
  const timed = cases.filter((entry) => entry.latencyMs.baseline !== null && entry.latencyMs.candidate !== null);
  const p95Baseline = percentile(timed.map((entry) => entry.latencyMs.baseline!), 0.95);
  const p95Candidate = percentile(timed.map((entry) => entry.latencyMs.candidate!), 0.95);
  const ages = cases
    .map((entry) => (entry.recordingCreatedAt ? Date.parse(entry.recordingCreatedAt) : Number.NaN))
    .filter((value) => Number.isFinite(value))
    .map((value) => Math.max(0, (now - value) / DAY_MS));
  return {
    cases: cases.length - skipped,
    pass,
    fail,
    error,
    skipped,
    passRate: denominator > 0 ? pass / denominator : 0,
    regressions,
    costIncreasePct: increasePct(costBaseline, costCandidate),
    p95LatencyIncreasePct: increasePct(p95Baseline, p95Candidate),
    newGuardBlocks: cases.reduce((sum, entry) => sum + entry.newGuardBlocks, 0),
    oldestRecordingDays: ages.length > 0 ? Math.floor(Math.max(...ages)) : null
  };
}

/**
 * Judges a replay job against the gate policy. Pure: shared by the API
 * (at publish time, always under the policy in force now) and the CLI.
 *
 * `blocked` lists every reason; `needs_approval` is a job that passes on a
 * gate that sends every publish to its approvers; `passed` otherwise. A
 * missing job (`evidence` null) is blocked.
 */
export function judgeReleaseGate(
  evidence: ReleaseGateEvidence | null,
  policy: ReleaseGatePolicy,
  options: { expected: ReleaseGateExpectation; requireApproval?: boolean; now?: Date }
): ReleaseGateJudgement {
  const now = (options.now ?? new Date()).getTime();
  const empty: ReleaseGateStats = {
    cases: 0, pass: 0, fail: 0, error: 0, skipped: 0, passRate: 0, regressions: 0,
    costIncreasePct: null, p95LatencyIncreasePct: null, newGuardBlocks: 0, oldestRecordingDays: null
  };
  if (!evidence) {
    return { verdict: "blocked", reasons: ["No completed replay job for this version's workflow hash. Run the gate first."], stats: empty };
  }
  const reasons: string[] = [];
  const { job } = evidence;
  if (job.status !== "completed") reasons.push(`Replay job ${job.id} is ${job.status}, not completed.`);
  if (job.workflowHash !== options.expected.workflowHash) {
    reasons.push(`Replay job ${job.id} tested a different workflow hash than this version.`);
  }
  const covered = new Set(job.datasetIds);
  const missing = options.expected.datasetIds.filter((id) => !covered.has(id));
  if (missing.length > 0) reasons.push(`Replay job ${job.id} did not cover the gate's golden set${missing.length === 1 ? "" : "s"} ${missing.join(", ")}.`);
  if (options.expected.mcpMode === "strict" && job.mcpMode && job.mcpMode !== "strict") {
    reasons.push(`The gate replays MCP calls strictly; job ${job.id} used ${job.mcpMode}.`);
  }
  if (job.liveWrites) reasons.push(`Replay job ${job.id} allowed live write calls, which a gate run never may.`);

  const stats = statsOf(evidence, policy, now);
  if (stats.cases < policy.minCases) reasons.push(`Only ${stats.cases} case${stats.cases === 1 ? "" : "s"} judged; the gate needs at least ${policy.minCases}.`);
  if (stats.passRate < policy.minPassRate) {
    reasons.push(`Pass rate ${Math.round(stats.passRate * 1000) / 10}% is below the required ${Math.round(policy.minPassRate * 1000) / 10}%.`);
  }
  if (stats.regressions > policy.maxRegressions) {
    reasons.push(`${stats.regressions} regression${stats.regressions === 1 ? "" : "s"}; the gate allows ${policy.maxRegressions}.`);
  }
  for (const scorer of policy.requiredScorers) {
    const failing = evidence.cases.filter((entry) => entry.status !== "skipped" && !entry.scorers.some((detail) => detail.type === scorer && detail.pass));
    if (failing.length > 0) reasons.push(`Required scorer ${scorer} did not pass on ${failing.length} case${failing.length === 1 ? "" : "s"}.`);
  }
  if (policy.maxCostIncreasePct !== undefined && stats.costIncreasePct !== null && stats.costIncreasePct > policy.maxCostIncreasePct) {
    reasons.push(`Cost rose ${formatPct(stats.costIncreasePct)}; the gate allows ${policy.maxCostIncreasePct}%.`);
  }
  if (policy.maxP95LatencyIncreasePct !== undefined && stats.p95LatencyIncreasePct !== null && stats.p95LatencyIncreasePct > policy.maxP95LatencyIncreasePct) {
    reasons.push(`p95 latency rose ${formatPct(stats.p95LatencyIncreasePct)}; the gate allows ${policy.maxP95LatencyIncreasePct}%.`);
  }
  if (policy.noNewGuardBlocks && stats.newGuardBlocks > 0) {
    reasons.push(`The candidate added ${stats.newGuardBlocks} guard block${stats.newGuardBlocks === 1 ? "" : "s"} or review${stats.newGuardBlocks === 1 ? "" : "s"}.`);
  }
  const compare = job.compare ?? "recording";
  if (stats.oldestRecordingDays !== null && stats.oldestRecordingDays > policy.maxRecordingAgeDays && compare !== "baseline_rerun") {
    reasons.push(
      `A golden run is ${stats.oldestRecordingDays} days old (the gate allows ${policy.maxRecordingAgeDays}): run the gate with compare "baseline_rerun" or re-record it.`
    );
  }
  if (reasons.length > 0) return { verdict: "blocked", reasons, stats };
  if (options.requireApproval) return { verdict: "needs_approval", reasons: ["This gate sends every publish to its approvers."], stats };
  return { verdict: "passed", reasons: [], stats };
}

// ---------------------------------------------------------------------------
// Enforced gates: what counts as loosening
// ---------------------------------------------------------------------------

/**
 * Why `after` is looser than `before`; empty when it is not. On an enforced
 * gate only admins may make such a change.
 */
export function releaseGateLoosening(before: ReleaseGateSettings, after: ReleaseGateSettings): string[] {
  const reasons: string[] = [];
  const a = before.policy;
  const b = after.policy;
  if (before.enabled && !after.enabled) reasons.push("disables the gate");
  const removed = before.datasetIds.filter((id) => !after.datasetIds.includes(id));
  if (removed.length > 0) reasons.push(`removes golden set${removed.length === 1 ? "" : "s"} ${removed.join(", ")}`);
  if (b.minPassRate < a.minPassRate) reasons.push("lowers the minimum pass rate");
  if (b.maxRegressions > a.maxRegressions) reasons.push("allows more regressions");
  if (a.errorsCountAsFailures && !b.errorsCountAsFailures) reasons.push("stops counting errors as failures");
  const droppedScorers = a.requiredScorers.filter((type) => !b.requiredScorers.includes(type));
  if (droppedScorers.length > 0) reasons.push(`drops required scorer${droppedScorers.length === 1 ? "" : "s"} ${droppedScorers.join(", ")}`);
  const looserLimit = (left: number | undefined, right: number | undefined) => left !== undefined && (right === undefined || right > left);
  if (looserLimit(a.maxCostIncreasePct, b.maxCostIncreasePct)) reasons.push("raises or removes the cost limit");
  if (looserLimit(a.maxP95LatencyIncreasePct, b.maxP95LatencyIncreasePct)) reasons.push("raises or removes the latency limit");
  if (a.noNewGuardBlocks && !b.noNewGuardBlocks) reasons.push("allows new guard blocks");
  if (b.minCases < a.minCases) reasons.push("lowers the minimum number of cases");
  if (b.maxRecordingAgeDays > a.maxRecordingAgeDays) reasons.push("accepts older golden runs");
  if (before.candidateOptions.mcpMode === "strict" && after.candidateOptions.mcpMode !== "strict") reasons.push("stops replaying MCP calls strictly");
  if (before.requireApproval && !after.requireApproval) reasons.push("stops requiring approval");
  const oldApprovers = before.approvers;
  const newApprovers = after.approvers;
  if (oldApprovers) {
    if (!newApprovers) reasons.push("removes the approvers");
    else {
      if (!oldApprovers.allowSelfApproval && newApprovers.allowSelfApproval) reasons.push("allows self-approval");
      const restricted = oldApprovers.approverRoles.length > 0 || oldApprovers.approverUsers.length > 0;
      const opened = newApprovers.approverRoles.length === 0 && newApprovers.approverUsers.length === 0;
      const addedRoles = newApprovers.approverRoles.filter((role) => !oldApprovers.approverRoles.includes(role));
      const addedUsers = newApprovers.approverUsers.filter((entry) => !oldApprovers.approverUsers.some((old) => old.toLowerCase() === entry.toLowerCase()));
      if ((restricted && opened) || addedRoles.length > 0 || addedUsers.length > 0) reasons.push("widens who may approve");
    }
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// The editor's version pill
// ---------------------------------------------------------------------------

/** `GET /api/workflows/:id/publish-preview`: the verdict publishing a version would get now. */
export interface ReleasePublishPreview {
  version: number;
  workflowHash: string;
  gateEnabled: boolean;
  verdict: ReleaseGateVerdict;
  reasons: string[];
  /** The replay job the verdict was judged on, when there is one. */
  replayRunId: string | null;
  stats: ReleaseGateStats | null;
  /** The gate has approvers, so a blocked publish can be sent to them. */
  canRequestApproval: boolean;
}

export interface ReleaseStateView {
  /** The newest saved version (the draft). */
  draftVersion: number | null;
  publishedVersion: number | null;
  /** Saved versions after the published one. */
  aheadBy: number;
  gateEnabled: boolean;
  gateEnforced: boolean;
}

// ---------------------------------------------------------------------------
// Release requests in the approvals inbox
// ---------------------------------------------------------------------------

export const RELEASE_APPROVAL_REQUEST_PREFIX = "rar_";

/** True for an approvals-inbox id that names a release request rather than a paused run. */
export function isReleaseApprovalRequestId(id: string): boolean {
  return id.startsWith(RELEASE_APPROVAL_REQUEST_PREFIX);
}

/**
 * A release request as the approvals inbox shows it. `id` is what
 * `/api/approvals/:id/approve` and `/reject` take, as for paused runs.
 */
export interface ReleaseApprovalRequestView {
  kind: "release";
  requestId: string;
  id: string;
  workflowId: string;
  workflowName: string | null;
  projectId: string;
  status: "pending" | "approved" | "rejected" | "timed_out" | "canceled";
  /** Shown as the request's message. */
  message: string;
  version: number;
  workflowHash: string;
  replayRunId: string | null;
  /** `policy`: the gate sends every publish to approvers; `blocked`: the gate blocked it and the requester asked anyway. */
  origin: "policy" | "blocked";
  gateReasons: string[];
  requestReason: string | null;
  approverRoles: string[];
  approverUsers: string[];
  allowSelfApproval: boolean;
  requestedBy: string | null;
  createdAt: string;
  expiresAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  /** The decision's reason (or why the request was canceled). */
  reason: string | null;
  releaseId: string | null;
  canDecide: boolean;
  cannotDecideReason: string | null;
}
