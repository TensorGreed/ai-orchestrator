import { z } from "zod";
import { APPROVAL_MAX_TIMEOUT_MINUTES, APPROVAL_REASON_MAX_LENGTH, APPROVER_ROLE_VALUES } from "./approval-gate";
import { evalScorerListSchema } from "./evals";
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

/**
 * The replay jobs the gate accepts ("Run gate" in the publish dialog, `l2m release`).
 * A job counts only when it ran with exactly these settings: `mcpMode`
 * defaults to strict, `compare` to recording (a `baseline_rerun` job is
 * always acceptable, being stricter), `repeats` to 1, `aggregate` to all.
 * `scorers` is the gate's own scorer list: unset means the job default
 * (`status` and `json_equal` against the golden run), and a job that ran
 * with any other run-level scorers is no proof. A case's own scorers belong
 * to the golden set and are bound through the set snapshot.
 */
export const releaseCandidateOptionsSchema = z
  .object({
    mcpMode: z.enum(REPLAY_MCP_MODES).optional(),
    compare: z.enum(RELEASE_COMPARE_MODES).optional(),
    repeats: z.number().int().min(1).max(5).optional(),
    aggregate: z.enum(RELEASE_AGGREGATE_MODES).optional(),
    maxCostUsd: z.number().positive().max(100_000).optional(),
    scorers: evalScorerListSchema.optional()
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
  /**
   * The case's run diff is missing or was truncated, so its cost, latency and
   * guard verdicts are unknown: with a cost, latency or guard limit in the
   * policy such a case counts as an error.
   */
  diffMissing?: boolean;
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
  /**
   * Options or overrides the job ran with that the gate's own candidate
   * options do not specify (a guard profile, MCP mode or model override,
   * an unknown field). Such a job carries the version's hash without having
   * tested it as it ships, so it is no proof.
   */
  overrides?: string[];
  /**
   * The replay job's own server-computed eligibility (Phase 15.3). `false`
   * blocks; a job without the field is judged by the gate's checks alone.
   */
  releaseEligible?: boolean | null;
  releaseIneligibleReasons?: string[];
  /** The job ran with run-level scorers other than the gate's own (or the gate's while it names none). */
  scorerMismatch?: string | null;
  /** Gate golden sets whose contents (cases, golden runs, case scorers) changed since the job was queued, or that the job holds no snapshot of. */
  staleSets?: string[];
  /** The job holds no snapshot of its sets: it was queued before release gates existed. */
  noSetSnapshot?: boolean;
  /** The job repeated its cases and the replay recorded latency or guard verdicts for only one repeat of some case. */
  repeatsUnchecked?: boolean;
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
  /** The gate's MCP mode (default strict): a strict gate refuses a lenient job. */
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
  /**
   * Gate admission (enforced gates only): which cases counted, which ran
   * while pending admission, and the required cases. Absent when the gate
   * judged every case (unenforced gates, and jobs judged without admission).
   */
  admission?: ReleaseGateAdmissionStats;
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
  options: {
    expected: ReleaseGateExpectation;
    requireApproval?: boolean;
    now?: Date;
    /**
     * Enforced gates: the admitted cases and the required ones. Cases not
     * admitted run and are reported but count toward nothing; a required case
     * that fails (or errors, when errors count as failures) blocks whatever
     * the pass rate. Without it every case counts, as before admission existed.
     */
    admission?: ReleaseGateAdmission | null;
  }
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
  if ((options.expected.mcpMode ?? "strict") === "strict" && job.mcpMode && job.mcpMode !== "strict") {
    reasons.push(`The gate replays MCP calls strictly; job ${job.id} used ${job.mcpMode}.`);
  }
  if (job.liveWrites) reasons.push(`Replay job ${job.id} allowed live write calls, which a gate run never may.`);
  if (job.overrides && job.overrides.length > 0) {
    reasons.push(`Replay job ${job.id} ran with settings the gate does not specify (${job.overrides.join(", ")}), so it does not test the version as it ships.`);
  }
  if (job.releaseEligible !== undefined && job.releaseEligible !== null && job.releaseEligible !== true) {
    const why = job.releaseIneligibleReasons && job.releaseIneligibleReasons.length > 0 ? ` (${job.releaseIneligibleReasons.join("; ")})` : "";
    reasons.push(`Replay job ${job.id} is not eligible to prove a release${why}.`);
  }
  if (job.repeatsUnchecked && (policy.maxP95LatencyIncreasePct !== undefined || policy.noNewGuardBlocks)) {
    reasons.push(
      `This gate checks latency and guard limits per run, but replay job ${job.id} repeated its cases and recorded them for only one repeat: run the gate's suite with repeats 1, or remove those limits.`
    );
  }
  if (job.scorerMismatch) reasons.push(`Replay job ${job.id} ${job.scorerMismatch}: the gate judges with its own scorers.`);
  if (job.noSetSnapshot) {
    reasons.push(`Replay job ${job.id} was queued before release gates existed, so it holds no record of the golden sets it ran on: run the gate again.`);
  } else if (job.staleSets && job.staleSets.length > 0) {
    reasons.push(
      `The golden set${job.staleSets.length === 1 ? "" : "s"} ${job.staleSets.join(", ")} changed after replay job ${job.id} was queued (cases, golden runs or case scorers): run the gate again.`
    );
  }

  // A case whose diff is missing cannot show it stays within a cost, latency or guard limit: it counts as an error.
  const limited = policy.maxCostIncreasePct !== undefined || policy.maxP95LatencyIncreasePct !== undefined || policy.noNewGuardBlocks;
  const judged: ReleaseGateEvidence = limited
    ? { ...evidence, cases: evidence.cases.map((entry) => (entry.diffMissing && entry.status !== "skipped" ? { ...entry, status: "error" as const } : entry)) }
    : evidence;

  const admission = options.admission ?? null;
  const { counted, pending } = splitAdmittedCases(judged.cases, admission);
  const stats: ReleaseGateStats = statsOf({ ...judged, cases: counted }, policy, now);
  if (admission) stats.admission = summarizeReleaseGateAdmission(judged.cases, admission, policy);
  const waiting = pending.filter((entry) => entry.status !== "skipped").length;
  if (stats.cases < policy.minCases) {
    const more = waiting > 0 ? ` (${waiting} more ${waiting === 1 ? "is" : "are"} waiting for admission and do not count yet)` : "";
    reasons.push(`Only ${stats.cases} case${stats.cases === 1 ? "" : "s"} judged${more}; the gate needs at least ${policy.minCases}.`);
  }
  if (stats.passRate < policy.minPassRate) {
    reasons.push(`Pass rate ${Math.round(stats.passRate * 1000) / 10}% is below the required ${Math.round(policy.minPassRate * 1000) / 10}%.`);
  }
  if (stats.regressions > policy.maxRegressions) {
    reasons.push(`${stats.regressions} regression${stats.regressions === 1 ? "" : "s"}; the gate allows ${policy.maxRegressions}.`);
  }
  for (const failure of stats.admission?.requiredFailures ?? []) {
    reasons.push(`Required case "${failure.name}" ${failure.problem}: a required case must pass whatever the pass rate.`);
  }
  for (const scorer of policy.requiredScorers) {
    const failing = counted.filter((entry) => entry.status !== "skipped" && !entry.scorers.some((detail) => detail.type === scorer && detail.pass));
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
// Gate admission and required cases (enforced gates)
// ---------------------------------------------------------------------------

/**
 * Which cases an enforced gate counts. When an admin enforces the gate (or
 * adds golden sets to it) the cases of its sets are admitted; a case added
 * afterwards, by any path, is pending admission until an admin admits it or
 * a gate approver approves an `admit_cases` request. A pending case runs and
 * is reported, but counts toward nothing: not the pass rate, not minCases,
 * not regressions or any other limit. Required cases (admins only) must pass
 * whatever the pass rate.
 */
export interface ReleaseGateAdmission {
  /** Case (fixture) ids the gate counts. */
  admittedIds: readonly string[];
  /** Case ids that must pass on every publish. */
  requiredIds?: readonly string[];
  /** Case names, for reasons people read. */
  caseNames?: Readonly<Record<string, string>>;
}

export interface ReleaseGateRequiredFailure {
  id: string;
  name: string;
  /** "failed", "was inconclusive" or "did not run". */
  problem: string;
}

export interface ReleaseGateAdmissionStats {
  /** Admitted cases the job ran (skipped ones included). */
  admitted: number;
  /** Cases the job ran that are pending admission. */
  pending: number;
  /** Pending cases that failed or were inconclusive: reported, not counted. */
  pendingNotPassing: number;
  /** Required cases of the gate. */
  required: number;
  /** Required cases that block the publish, with why. */
  requiredFailures: ReleaseGateRequiredFailure[];
}

/** Splits cases into those the gate counts and those pending admission; without admission every case counts. */
export function splitAdmittedCases<T extends { id: string }>(cases: readonly T[], admission: ReleaseGateAdmission | null | undefined): { counted: T[]; pending: T[] } {
  if (!admission) return { counted: [...cases], pending: [] };
  const admitted = new Set(admission.admittedIds);
  const counted: T[] = [];
  const pending: T[] = [];
  for (const entry of cases) (admitted.has(entry.id) ? counted : pending).push(entry);
  return { counted, pending };
}

/**
 * Admitted, pending and required counts over a job's cases (one entry per
 * case, repeats already aggregated), and the required cases that block.
 * Shared by the gate judge and the CLI, so both report the same numbers.
 * A required case blocks when it failed, when it was inconclusive and errors
 * count as failures, or when the job did not run it.
 */
export function summarizeReleaseGateAdmission(
  cases: ReadonlyArray<{ id: string; status: ReleaseCaseStatus }>,
  admission: ReleaseGateAdmission,
  policy: Pick<ReleaseGatePolicy, "errorsCountAsFailures">
): ReleaseGateAdmissionStats {
  const { counted, pending } = splitAdmittedCases(cases, admission);
  const byId = new Map(cases.map((entry) => [entry.id, entry]));
  const requiredIds = [...new Set(admission.requiredIds ?? [])];
  const requiredFailures: ReleaseGateRequiredFailure[] = [];
  for (const id of requiredIds) {
    const entry = byId.get(id);
    const problem =
      !entry || entry.status === "skipped"
        ? "did not run"
        : entry.status === "fail"
          ? "failed"
          : entry.status === "error" && policy.errorsCountAsFailures
            ? "was inconclusive"
            : null;
    if (problem) requiredFailures.push({ id, name: admission.caseNames?.[id] ?? id, problem });
  }
  return {
    admitted: counted.length,
    pending: pending.length,
    pendingNotPassing: pending.filter((entry) => entry.status === "fail" || entry.status === "error").length,
    required: requiredIds.length,
    requiredFailures
  };
}

/** An enforced gate's admission state: what the loosening check compares. */
export interface ReleaseGateAdmissionState {
  admittedIds: readonly string[];
  requiredIds: readonly string[];
}

/**
 * Why going from `before` to `after` loosens an enforced gate's cases:
 * an admitted case leaves the gate (deleted or no longer admitted), or a
 * case stops being required. Empty when it does not. Admitting cases and
 * marking them required only tighten the gate.
 */
export function releaseAdmissionLoosening(before: ReleaseGateAdmissionState, after: ReleaseGateAdmissionState, names: Readonly<Record<string, string>> = {}): string[] {
  const reasons: string[] = [];
  const label = (ids: string[]) => ids.map((id) => `"${names[id] ?? id}"`).join(", ");
  const admittedAfter = new Set(after.admittedIds);
  const removed = before.admittedIds.filter((id) => !admittedAfter.has(id));
  if (removed.length > 0) reasons.push(`removes admitted case${removed.length === 1 ? "" : "s"} ${label(removed)}`);
  const requiredAfter = new Set(after.requiredIds);
  const cleared = before.requiredIds.filter((id) => !requiredAfter.has(id));
  if (cleared.length > 0) reasons.push(`stops requiring case${cleared.length === 1 ? "" : "s"} ${label(cleared)}`);
  return reasons;
}

/**
 * What a replay job view carries when the workflow's enforced gate uses one
 * of the job's golden sets (`GET /api/replay/runs/:id`): enough for the CLI
 * to report admitted, pending and required cases as the gate counts them.
 */
export interface ReleaseGateJobAdmission {
  enforced: true;
  admittedFixtureIds: string[];
  /** Cases of the gate's sets waiting for admission: they run but do not count. */
  pendingFixtureIds: string[];
  requiredFixtureIds: string[];
  errorsCountAsFailures: boolean;
}

/** One case of an enforced gate's golden sets, as the gate's Cases panel shows it. */
export interface ReleaseGateCaseView {
  fixtureId: string;
  datasetId: string;
  datasetName: string | null;
  name: string;
  recordingId: string | null;
  admission: "admitted" | "pending";
  required: boolean;
  /** The pending inbox request about this case, when there is one. */
  requestId: string | null;
  requestKind: GateCaseRequestKind | null;
  createdAt: string;
}

/** `GET /api/workflows/:id/release-gate/cases`. Unenforced gates answer `enforced: false` and no cases. */
export interface ReleaseGateCasesView {
  workflowId: string;
  enforced: boolean;
  cases: ReleaseGateCaseView[];
  counts: { admitted: number; pending: number; required: number };
  /** Admins admit, reject and mark cases required directly. */
  canAdmit: boolean;
  /** Builders (workflow:write) ask the gate's approvers instead. */
  canRequest: boolean;
}

const fixtureIdsSchema = z.array(idSchema).min(1, "Name at least one case").max(500);

/** `POST /api/workflows/:id/release-gate/cases/admit` and `/reject` (admins). */
export const gateCaseDecisionInputSchema = z
  .object({
    fixtureIds: fixtureIdsSchema,
    reason: reasonSchema.optional()
  })
  .strict();
export type GateCaseDecisionInput = z.infer<typeof gateCaseDecisionInputSchema>;

/** `PUT /api/workflows/:id/release-gate/cases/:fixtureId/required` (admins). */
export const gateCaseRequiredInputSchema = z.object({ required: z.boolean() }).strict();

export const GATE_CASE_REQUEST_ACTIONS = ["admit", "remove"] as const;
export type GateCaseRequestAction = (typeof GATE_CASE_REQUEST_ACTIONS)[number];
export const GATE_CASE_REQUEST_KINDS = ["admit_cases", "remove_cases"] as const;
export type GateCaseRequestKind = (typeof GATE_CASE_REQUEST_KINDS)[number];

/** `POST /api/workflows/:id/release-gate/cases/requests`: a builder asks the gate's approvers. */
export const gateCaseRequestInputSchema = z
  .object({
    action: z.enum(GATE_CASE_REQUEST_ACTIONS),
    fixtureIds: fixtureIdsSchema,
    reason: reasonSchema
  })
  .strict();
export type GateCaseRequestInput = z.infer<typeof gateCaseRequestInputSchema>;

export const GATE_CASE_REQUEST_PREFIX = "gcr_";

/** True for an approvals-inbox id that names a gate case request (admit or remove cases). */
export function isGateCaseRequestId(id: string): boolean {
  return id.startsWith(GATE_CASE_REQUEST_PREFIX);
}

/**
 * A request to admit cases to an enforced gate, or to remove admitted ones,
 * as the approvals inbox shows it. `id` is what `/api/approvals/:id/approve`
 * and `/reject` take.
 */
export interface GateCaseRequestView {
  kind: GateCaseRequestKind;
  requestId: string;
  id: string;
  workflowId: string;
  workflowName: string | null;
  projectId: string;
  status: "pending" | "approved" | "rejected" | "timed_out" | "canceled";
  message: string;
  cases: Array<{ fixtureId: string; name: string; datasetId: string | null }>;
  requestReason: string | null;
  approverRoles: string[];
  approverUsers: string[];
  allowSelfApproval: boolean;
  requestedBy: string | null;
  createdAt: string;
  expiresAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  reason: string | null;
  canDecide: boolean;
  cannotDecideReason: string | null;
}

// ---------------------------------------------------------------------------
// Enforced gates: what counts as loosening
// ---------------------------------------------------------------------------

/**
 * Why `after` is looser than `before`; empty when it is not. On an enforced
 * gate only admins may make such a change. With `admission`, an admitted
 * case leaving the gate or a case no longer required also loosens it
 * (`releaseAdmissionLoosening`).
 */
export function releaseGateLoosening(
  before: ReleaseGateSettings,
  after: ReleaseGateSettings,
  admission?: { before: ReleaseGateAdmissionState; after: ReleaseGateAdmissionState; names?: Readonly<Record<string, string>> }
): string[] {
  const reasons: string[] = admission ? releaseAdmissionLoosening(admission.before, admission.after, admission.names) : [];
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
  const beforeMode = before.candidateOptions.mcpMode ?? "strict";
  const afterMode = after.candidateOptions.mcpMode ?? "strict";
  if (beforeMode === "strict" && afterMode !== "strict") reasons.push("stops replaying MCP calls strictly");
  const AGGREGATE_RANK: Record<string, number> = { all: 2, majority: 1, any: 0 };
  const beforeAggregate = before.candidateOptions.aggregate ?? "all";
  const afterAggregate = after.candidateOptions.aggregate ?? "all";
  if ((AGGREGATE_RANK[afterAggregate] ?? 0) < (AGGREGATE_RANK[beforeAggregate] ?? 0)) reasons.push("accepts a case that passes on fewer repeats");
  if (afterAggregate !== "all" && (after.candidateOptions.repeats ?? 1) > (before.candidateOptions.repeats ?? 1)) reasons.push("gives a flaky case more tries to pass");
  if (before.candidateOptions.compare === "baseline_rerun" && (after.candidateOptions.compare ?? "recording") !== "baseline_rerun") reasons.push("stops rerunning the baseline");
  if (canonicalScorers(before.candidateOptions.scorers) !== canonicalScorers(after.candidateOptions.scorers)) reasons.push("changes the scorers the gate judges with");
  if (before.requireApproval && !after.requireApproval) reasons.push("stops requiring approval");
  const oldApprovers = before.approvers;
  const newApprovers = after.approvers;
  if (!oldApprovers && newApprovers) {
    // No approvers: only an admin override could pass a blocked publish. Any approver list widens that.
    reasons.push("widens who may approve");
    if (newApprovers.allowSelfApproval) reasons.push("allows self-approval");
  } else if (oldApprovers) {
    if (!newApprovers) reasons.push("removes the approvers");
    else {
      if (!oldApprovers.allowSelfApproval && newApprovers.allowSelfApproval) reasons.push("allows self-approval");
      const restricted = oldApprovers.approverRoles.length > 0 || oldApprovers.approverUsers.length > 0;
      const opened = newApprovers.approverRoles.length === 0 && newApprovers.approverUsers.length === 0;
      const addedRoles = newApprovers.approverRoles.filter((role) => !oldApprovers.approverRoles.includes(role));
      const addedUsers = newApprovers.approverUsers.filter((entry) => !oldApprovers.approverUsers.some((old) => old.toLowerCase() === entry.toLowerCase()));
      if ((restricted && opened) || addedRoles.length > 0 || addedUsers.length > 0) reasons.push("widens who may approve");
      if (newApprovers.timeoutMinutes > oldApprovers.timeoutMinutes) reasons.push("lets release requests wait longer");
    }
  }
  return reasons;
}

/** Stable JSON: object keys sorted, so equal settings compare equal whatever their key order. */
export function releaseCanonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => releaseCanonicalJson(entry)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${releaseCanonicalJson(entry)}`).join(",")}}`;
}

/** A scorer list as the gate compares it: no list and an empty list are the same (the job default). */
function canonicalScorers(scorers: readonly unknown[] | null | undefined): string {
  return scorers && scorers.length > 0 ? releaseCanonicalJson(scorers) : "[]";
}

/** Whether a job's run-level scorers are exactly the gate's own (both empty means the job default). */
export function releaseScorersMatch(gateScorers: readonly unknown[] | null | undefined, jobScorers: readonly unknown[] | null | undefined): boolean {
  return canonicalScorers(gateScorers) === canonicalScorers(jobScorers);
}

function canonicalApprovers(approvers: ReleaseApprovers | null): string {
  if (!approvers) return "null";
  return releaseCanonicalJson({
    approverRoles: [...approvers.approverRoles].sort(),
    approverUsers: approvers.approverUsers.map((entry) => entry.toLowerCase()).sort(),
    allowSelfApproval: approvers.allowSelfApproval,
    timeoutMinutes: approvers.timeoutMinutes
  });
}

/**
 * What only an admin may change on an enforced gate: anything that loosens
 * it (`releaseGateLoosening`), and any change at all to who approves (the
 * approver list, self-approval, the request timeout) or to the candidate
 * options (MCP mode, compare, repeats, aggregate, scorers, budget), since
 * those decide what counts as passing. Empty when the change is allowed.
 */
export function releaseGateAdminOnlyChanges(before: ReleaseGateSettings, after: ReleaseGateSettings): string[] {
  const reasons = releaseGateLoosening(before, after);
  if (canonicalApprovers(before.approvers) !== canonicalApprovers(after.approvers) && !reasons.includes("widens who may approve")) {
    reasons.push("changes who may approve");
  }
  const options = (value: ReleaseCandidateOptions) => releaseCanonicalJson({ ...value, mcpMode: value.mcpMode ?? "strict", scorers: value.scorers && value.scorers.length > 0 ? value.scorers : undefined });
  if (options(before.candidateOptions) !== options(after.candidateOptions)) reasons.push("changes the replay job settings the gate accepts");
  return [...new Set(reasons)];
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
  /**
   * The gate is on but there is no published version production can load
   * (the workflow was deleted and created again with the same id): every
   * production entry point refuses runs until a version is published.
   */
  productionRefused: boolean;
  /** Whether the caller holds `workflow:publish` on this workflow (project roles included). */
  canPublish: boolean;
  /** Whether the caller may change the gate's settings (`workflow:write`; admin-only fields on an enforced gate aside). */
  canEditGate: boolean;
}

/** Global roles that can hold `workflow:publish`, so the only ones worth naming as release approvers. */
export const RELEASE_APPROVER_ROLE_CHOICES = ["admin", "builder"] as const;

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
