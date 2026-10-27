/**
 * Agent evals (Phase 7.3, 9.5, 10.8) and replay jobs (Phase 15.2).
 *
 * Datasets hold fixtures (input, expected, scorers). A golden set is a
 * dataset tied to one workflow whose fixtures are golden runs. Two kinds of
 * run go through one background runner:
 *
 *   eval    every fixture runs live against the workflow as saved now
 *           (optionally recording or replaying its MCP calls), then scored;
 *   replay  every golden-run fixture of one or more golden sets is replayed
 *           (15.1 replay: stubbed side effects, MCP from the cassette,
 *           sandboxed state) against one candidate, then scored against the
 *           golden run. Hand-written fixtures are skipped.
 *
 * The runner caps how many cases run at once in this process
 * (`REPLAY_CONCURRENCY`), reports progress after every case (store and
 * listeners), can cancel a run (queued cases are dropped, running
 * executions are aborted), stops a run that reaches its cost budget, and
 * marks runs left queued or running by a stopped server `interrupted` when
 * it starts. A run executes in the process that accepted it.
 *
 * Budgets: before a case starts, the worst-case cost of its judge calls is
 * reserved against the run's budget, so cases in flight can never spend
 * more on judges than the budget has left. A case's own model calls are
 * not known in advance, so a run can overshoot by at most the model spend
 * of the cases in flight (at most `REPLAY_CONCURRENCY`). An unpriced model
 * or judge call makes the run's cost "unknown": the spend is a lower bound
 * and the run carries a warning.
 *
 * Token and latency aggregation pulls from the `_telemetry` blob the host
 * reads off node results; cost comes from the run facts (priced with the
 * deployment's price table) plus any LLM-judge calls.
 *
 * Phase 15.3 — a replay job's candidate can be an inline workflow plus
 * overrides; its cases can run several times (`repeats`, combined by the
 * `aggregate` rule) and next to a baseline rerun of the golden run's own
 * version (`compare: "baseline_rerun"`), with model calls live or from the
 * golden run's tape (`models`). A case is still one stored result: its
 * status is the aggregate, its diff the deciding repeat with every repeat
 * listed. The budget counts every execution of a case as it finishes, so a
 * case stops between repeats (and between a baseline and its candidate)
 * once the job's spend reaches the budget. `estimateReplayJob` says what a
 * request would run and cost before it starts.
 *
 * Phase 15.3 review fixes:
 *   - before each execution its estimated cost (the golden run's recorded
 *     tokens at the models it will call) is reserved against what is left
 *     of the budget; an execution that would not fit is skipped
 *     (budget_exhausted) and the reservation is settled to the actual cost
 *     afterwards. A job may run at most REPLAY_JOB_MAX_EXECUTIONS executions;
 *   - model calls answered from a model tape cost nothing (budget, spend and
 *     summary); their recorded cost is kept apart (`recordedCostUsd`);
 *   - the job stores whether it can count as release proof
 *     (`candidate.releaseEligible`, with the reasons when it cannot);
 *   - a case that ran fewer repeats than asked for is an error, whatever
 *     the repeats it did run said.
 *
 * Phase 15.6 — a guard policy simulation queues one replay job per workflow
 * through `enqueueSimulationJob`: its cases are recordings named directly
 * (a server-internal source; the public request only takes golden sets).
 * Each case replays its recording twice, models from the tape and strict
 * MCP: under the current profiles (the baseline) and with the simulated
 * guard profile swapped in, and stores the comparison of the two. Such a
 * job reads like any replay job, is never release proof, yields its worker
 * slots to every other job, and its starter needs read access to the
 * workflow (nothing it replays reaches a model, a server or a side effect)
 * and must still be allowed to simulate the profile, checked on every case.
 */

import { CASSETTE_REDACTED } from "@ai-orchestrator/mcp-sdk";
import { candidateRefusal, type CandidatePolicy } from "./candidate-policy.js";
import { randomUUID } from "node:crypto";
import {
  aggregateReplayAttempts,
  effectiveModelFor,
  EVAL_JUDGE_CALLS_PER_CASE_MAX,
  EVAL_RUN_FINISHED_STATUSES,
  GUARD_SIMULATION_RELEASE_REASON,
  guardSimulationJobDatasetId,
  REPLAY_STALE_RECORDING_DAYS,
  replayJobReleaseIneligibleReasons,
  replayNewGuardBlocks,
  type ReplayAttemptStatus,
  type ReplayCandidateOverrides,
  type ReplayCaseAttempt,
  type DataDestinationRow,
  type ReplayCaseRepeats,
  type ReplayJobEstimate,
  type EvalStoredTruncation,
  type EvalCaseDetail,
  type EvalCaseResult,
  type EvalCaseStatus,
  type EvalRunProgress,
  type EvalRunSummary,
  type EvalRunView,
  type EvalScoreDetail,
  type EvalScorerSpec,
  type McpReplayMode,
  type ReplayCaseDiff,
  type ReplayJobCandidate,
  type ReplayJobOptions,
  type ReplayJobRequest,
  type ReplayRunResponse,
  type RunFacts,
  type Workflow
} from "@ai-orchestrator/shared";
import type { EvalFixtureRecord, EvalResultRecord, EvalRunRecord, ReplayRecordingRecord } from "../db/database.js";
import type { SafeUser } from "./auth-service.js";
import type { GuardProfileSubstitute } from "./guard-service.js";
import { simulateCase, type SimulatedReplay } from "./guard-simulation-diff.js";
import { GuardSimulationSink, type GuardSimulationRun } from "./guard-simulation-sink.js";
import { goldenSetSnapshots } from "./release-snapshot.js";
import { captureExpectsMasking } from "./run-diff.js";
import { applyScorer, judgeCallsFor, __scorerTest__, type EvalJudgeContext, type EvalLlmJudge } from "./eval-scorers.js";
import type { Store } from "../db/store.js";
import { mapAsync } from "../async-array.js";

export type { EvalLlmJudge, EvalJudgeContext, EvalJudgeResponse } from "./eval-scorers.js";
export type { EvalRunSummary, EvalScoreDetail };

/** Kept for callers that predate the shared schema. */
export type ScorerSpec = EvalScorerSpec;

export interface EvalRunRequest {
  datasetId: string;
  workflowId: string;
  /**
   * Run-level scorers applied to every fixture. A fixture's own scorers take
   * precedence. Defaults to a single `exact_match` over the whole output if
   * neither set provides one.
   */
  scorers?: ScorerSpec[];
  /** The starting user: every case runs as them, looked up again by id (with this email) each time. */
  triggeredBy: string;
  triggeredByUserId: string;
  /** Phase 10.8 — record each fixture's MCP calls into a cassette. */
  recordMcp?: boolean;
  /**
   * Phase 10.8 — answer MCP calls from cassettes instead of live servers:
   * one cassette for every fixture, or the cassette a past eval run recorded
   * for each fixture.
   */
  replayMcp?: EvalMcpReplay;
}

export interface EvalMcpReplay {
  cassetteId?: string;
  evalRunId?: string;
  mode?: McpReplayMode;
}

/**
 * Workflow-execution callback the EvalService uses to run one fixture. The
 * caller (apps/api/src/app.ts) wires this to the in-process execution path
 * so eval runs share routing, telemetry, and history.
 */
export interface EvalWorkflowExecutor {
  (input: {
    workflowId: string;
    fixtureInput: unknown;
    fixtureName: string;
    /** Phase 10.8 — matches a fixture to the cassette a past eval run recorded for it. */
    fixtureId: string;
    runId: string;
    /** Phase 15.2 — the id the execution must use, so a cancel can abort it. Generated when omitted. */
    executionId?: string;
    triggeredBy: string;
    triggeredByUserId: string;
    mcp?: { record?: boolean; replay?: EvalMcpReplay };
  }): Promise<{
    executionId?: string;
    output: unknown;
    error?: string;
    durationMs?: number;
    tokens?: { input?: number; output?: number; total?: number };
    /** Phase 15.2 — the run's facts, for the status, tool, guard and budget scorers. */
    facts?: RunFacts;
  }>;
}

type CandidateKind = "draft" | "version" | "inline";

/** Phase 15.3 — a candidate resolved once for a whole job. */
export interface EvalReplayCandidate {
  workflow: Workflow;
  kind: CandidateKind;
  version: number | null;
  workflowHash: string;
  /** The hash before model overrides. */
  baseHash?: string;
  overrides?: ReplayCandidateOverrides | null;
  name?: string;
  /** The guard profile override as it will run (version pinned when the job is created). */
  guardProfile?: { profileId: string; version: number; hash: string } | null;
}

/** Phase 15.3 — the default of REPLAY_JOB_MAX_EXECUTIONS. */
export const REPLAY_JOB_MAX_EXECUTIONS_DEFAULT = 500;

/** Phase 15.3 — the marker in the reason a case or job stopped on its budget. */
export const REPLAY_BUDGET_EXHAUSTED = "budget_exhausted";

/** Phase 15.2 — what a replay job needs from the replay machinery (15.1). */
export interface EvalReplayDeps {
  /** The candidate, resolved once when the job is created so every case runs the same workflow. */
  resolveCandidate: (
    workflowId: string,
    request: { draft?: boolean; version?: number; workflow?: Record<string, unknown>; overrides?: ReplayCandidateOverrides },
    /** Phase 15.3 — who is asking (an admin may pin an older version of a bound guard profile). */
    context?: { actor?: SafeUser | null }
  ) => Promise<EvalReplayCandidate>;
  getRecording: (id: string) => Promise<ReplayRecordingRecord | null>;
  /** Replays one golden run against the candidate in the replay sandbox, as `actor`, with this execution id. */
  replayCase: (input: {
    recording: ReplayRecordingRecord;
    candidate: { workflow: Workflow; kind: CandidateKind; version: number | null };
    request: { mcpMode?: McpReplayMode; ignorePaths?: string[]; numberTolerance?: number };
    actor: SafeUser;
    executionId: string;
    /** Phase 15.3 */
    models?: "live" | "replay";
    overrides?: ReplayCandidateOverrides | null;
    /** Compare with this baseline run instead of the recording. */
    baseline?: { facts: RunFacts; executionId: string };
    role?: "candidate" | "baseline";
    repeatIndex?: number;
    /** Phase 15.6 — a guard policy simulation's execution: the profile it swaps in (none for the baseline), its sink and vault. */
    simulation?: GuardSimulationRun;
  }) => Promise<ReplayRunResponse>;
  /**
   * Phase 15.3 — the golden run's own workflow, for a baseline rerun.
   * `source: "captured"` means the saved version is gone (or never existed)
   * and only the scrubbed copy captured with the golden run is left.
   */
  baselineFor?: (recording: ReplayRecordingRecord) => Promise<{ workflow: Workflow; kind: CandidateKind; version: number | null; source?: "version" | "captured" }>;
  /** Phase 15.3 — the price of one model call, for the estimate; null when the model has no price. */
  priceCall?: (providerId: string, model: string, inputTokens: number, outputTokens: number) => number | null;
  /**
   * The user a job runs as (tool policy subject and project scope), looked up
   * again for every case; null when they can no longer run the workflow, or
   * no longer hold `permission` on it (Phase 15.3: an inline or overridden
   * candidate needs `workflow:write` for every case, not only at the start).
   */
  actorFor: (userId: string, email: string, workflowId: string, permission?: "workflow:read" | "workflow:execute" | "workflow:write") => Promise<SafeUser | null>;
}

/** Phase 15.6 — one workflow's part of a guard policy simulation, as a replay job. */
export interface SimulationJobRequest {
  simulationId: string;
  workflowId: string;
  /** The recordings to replay, newest first; all of `workflowId`. */
  recordingIds: string[];
  substitute: GuardProfileSubstitute;
  /** The profile's version the simulation started against, swapped in for the baseline side; null when the profile had none (the baseline runs the profiles in force). */
  baseSubstitute: GuardProfileSubstitute | null;
  /** The saved version to replay (the published one, when the workflow has one); the draft when absent. */
  version?: number;
  /** The simulation's vault: `protect` tokens stay in memory. */
  vault: GuardSimulationRun["vault"];
  /** The simulated profile differs from the profile's latest saved version. */
  profileChanged: boolean;
  /** Why the starter may no longer simulate this profile (their role or the profile changed); null when they still may. Checked on every case. */
  canRun: (actor: SafeUser) => string | null | Promise<string | null>;
  /** Phase 16 — a destination preview: the stored rows (baseline) and the admin's unsaved rows (candidate). */
  destinationRows?: { baseline: DataDestinationRow[]; candidate: DataDestinationRow[] };
}

export interface EvalServiceOptions {
  /** Cases running at once across all runs of this process. Default 2. */
  concurrency?: number;
  /** Most cases one run may have. Default 200. */
  maxCases?: number;
  /** Phase 15.3 — most executions one replay job may run (REPLAY_JOB_MAX_EXECUTIONS). Default 500. */
  maxExecutions?: number;
  /** A replay job's budget when the request names none, in USD. Default 5. */
  defaultMaxCostUsd?: number;
  /** An eval run's budget, in USD. Default 5. */
  evalRunMaxCostUsd?: number;
  /**
   * The most one judge call of this scorer can cost (the longest prompt and
   * the reply's token cap, priced), reserved before a case starts; null when
   * the model has no price. Without it nothing is reserved.
   */
  judgeCallCeilingUsd?: (scorer: { providerId?: string; model?: string }) => number | null;
  /** A stored case output or run diff larger than this (JSON bytes) is replaced by a truncation marker. Default 256 KB. */
  maxResultBytes?: number;
  /** Removes secrets from text that is stored and shown (case errors, score reasons). */
  scrub?: (text: string) => Promise<string>;
  replay?: EvalReplayDeps;
  /** Aborts a running execution (cancel). */
  abortExecution?: (executionId: string, reason: string) => void;
  /** Writes `progress.updatedAt` this often while a run is running, so another instance can tell it is alive. Default 30 s. */
  heartbeatMs?: number;
  now?: () => Date;
  random?: () => number;
  logger?: { warn: (message: string, fields?: Record<string, unknown>) => void };
}

export class EvalRunError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "invalid" | "limit" | "forbidden"
  ) {
    super(message);
    this.name = "EvalRunError";
  }
}

/** Runs left `running` by an instance that has not reported for this long are interrupted by any instance that starts. */
export const EVAL_RUN_STALE_MS = 5 * 60_000;

type Listener = (run: EvalRunView, done: boolean) => void;

interface CaseOutcome {
  status: EvalCaseStatus;
  /** Phase 15.3 — the case's repeats did not agree. */
  flaky?: boolean;
  /** Phase 15.3 — executions the case ran (repeats and baseline reruns). */
  executions?: number;
  /** Phase 15.3 — the case stopped early because the job reached its budget. */
  budgetStop?: string;
  /** Phase 15.3 — the case's repeat counts (stored with its score). */
  repeats?: ReplayCaseRepeats;
  /** Phase 15.3 — model calls answered from the tape, and what they cost when recorded. */
  replayedModelCalls?: number;
  recordedCostUsd?: number;
  /** A model or judge call of the case had no price. */
  costUnknown?: boolean;
  executionId?: string;
  score?: { pass: boolean; details: EvalScoreDetail[] };
  output?: unknown;
  error?: string;
  durationMs?: number;
  tokens?: { input?: number; output?: number; total?: number };
  costUsd?: number | null;
  judgeCostUsd?: number;
  recordingId?: string;
  verdict?: string;
  diff?: ReplayCaseDiff;
}

interface ActiveRun {
  runId: string;
  canceled: boolean;
  inFlight: Set<string>;
  listeners: Set<Listener>;
  done: Promise<void>;
  resolveDone: () => void;
  progress: EvalRunProgress;
  summary: EvalRunSummary;
  /** Woken whenever a case finishes or the run is canceled (a case waiting for budget headroom). */
  caseWaiters: Array<() => void>;
  warnings: Set<string>;
  /** Phase 15.3 — spend of executions that finished inside cases still running. */
  inflightUsd: number;
  /** Phase 15.3 — a case stopped on the budget; the run ends `failed` with this. */
  budgetStop: string | null;
}

/** Phase 15.3 — what a running case may do besides its first execution. */
interface CaseRunContext {
  /** A fresh execution id the run can abort on cancel. */
  nextExecutionId: () => string;
  canceled: () => boolean;
  /** Counts spend as soon as an execution (or a judge call, with `judge`) of the case finishes. */
  spend: (usd: number, judge?: boolean) => void;
  /**
   * Phase 15.3 — holds `usd` (an execution's estimated cost) against what is
   * left of the budget; false (nothing held) when it does not fit. Give it
   * back with `release` once the execution has finished and its actual cost
   * was spent.
   */
  reserve: (usd: number) => boolean;
  release: (usd: number) => void;
  /** The job has reached its budget. */
  overBudget: () => boolean;
  maxCostUsd: number | undefined;
}

type RunCaseFn = (spec: CaseSpec, executionId: string, context: CaseRunContext) => Promise<CaseOutcome>;

interface CaseSpec {
  fixture: EvalFixtureRecord;
  /** The worst-case judge spend reserved before the case starts, and whether a judge model has no price. */
  reserveUsd: number;
  reserveUnknown: boolean;
}

const UNPRICED_WARNING = "Some model or judge calls have no price in the price table: the spend shown leaves them out, and the budget cannot stop on them.";

interface ReplayJobContext {
  actorUserId: string;
  actorEmail: string;
  /** Phase 15.3 — an inline or overridden candidate: every case re-checks workflow:write. */
  needsWrite: boolean;
  /** Phase 15.6 — a guard policy simulation's job (see `runSimulationCase`). */
  simulation?: {
    id: string;
    substitute: GuardProfileSubstitute;
    baseSubstitute: GuardProfileSubstitute | null;
    vault: GuardSimulationRun["vault"];
    canRun: SimulationJobRequest["canRun"];
    profileChanged: boolean;
    destinationRows?: SimulationJobRequest["destinationRows"];
  };
  candidate: EvalReplayCandidate;
  options: ReplayJobOptions;
  scorers: EvalScorerSpec[] | null;
  /** Phase 15.6 — server-internal jobs only (a policy simulation over recent traffic): captured candidates may be replayed. */
  allowCandidates?: boolean;
}

/** Phase 15.3 — a validated replay job request, before it is stored and launched. */
interface PreparedReplayJob {
  datasetIds: string[];
  fixtures: EvalFixtureRecord[];
  /** Executions the job would run: golden-run cases x repeats (x 2 with a baseline rerun). */
  executions: number;
  candidate: EvalReplayCandidate;
  options: ReplayJobOptions;
  scorers: EvalScorerSpec[] | null;
}

/**
 * Slots shared by every run, first in, first out. Phase 15.6: a low-priority
 * case (a guard policy simulation's) waits while any other case waits, and
 * low-priority cases never hold more than all but one slot, so release-gate
 * and ordinary replay jobs are never stuck behind simulations.
 */
export class EvalSlots {
  private free: number;
  private lowRunning = 0;
  private readonly waiting: Array<{ low: boolean; start: () => void }> = [];

  constructor(private readonly size: number) {
    this.size = Math.max(1, Math.floor(size));
    this.free = this.size;
  }

  private get lowCap(): number {
    return Math.max(1, this.size - 1);
  }

  acquire(low = false): Promise<void> {
    return new Promise((resolve) => {
      this.waiting.push({ low, start: resolve });
      this.drain();
    });
  }

  release(low = false): void {
    this.free += 1;
    if (low) this.lowRunning = Math.max(0, this.lowRunning - 1);
    this.drain();
  }

  private drain(): void {
    while (this.free > 0) {
      let index = this.waiting.findIndex((entry) => !entry.low);
      if (index < 0 && this.lowRunning < this.lowCap) index = this.waiting.findIndex((entry) => entry.low);
      if (index < 0) return;
      const [next] = this.waiting.splice(index, 1);
      this.free -= 1;
      if (next!.low) this.lowRunning += 1;
      next!.start();
    }
  }
}

function emptySummary(total: number): EvalRunSummary {
  return {
    total,
    pass: 0,
    fail: 0,
    error: 0,
    skipped: 0,
    passRate: 0,
    totalTokenInput: 0,
    totalTokenOutput: 0,
    totalTokenTotal: 0,
    totalDurationMs: 0,
    avgDurationMs: 0,
    costUsd: 0,
    judgeCostUsd: 0
  };
}

function roundUsd(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

/** A model call of the run had no price, so its cost is not in `totals.costUsd`. */
function modelCostIsUnknown(facts: RunFacts | undefined | null): boolean {
  return Boolean(facts?.modelCalls.some((call) => call.costUsd === null));
}

/**
 * What one repeat of a replay case measured, by the definitions the case
 * diff uses: the candidate's latency (`totals.latencyMs.candidate`) and its
 * new guard blocks against the reference run (`replayNewGuardBlocks`). Null
 * when the diff does not carry the figure.
 */
function replayAttemptMetrics(response: ReplayRunResponse): { latencyMs: number | null; newGuardBlocks: number | null } {
  const diff = response.diff as Partial<ReplayRunResponse["diff"]> | undefined;
  const latency = diff?.totals?.latencyMs?.candidate;
  const guard = diff?.guard;
  return {
    latencyMs: typeof latency === "number" && Number.isFinite(latency) ? latency : null,
    newGuardBlocks: guard && Array.isArray(guard.added) && Array.isArray(guard.changed) ? replayNewGuardBlocks(guard) : null
  };
}

function isTruncation(value: unknown): value is EvalStoredTruncation {
  return Boolean(value && typeof value === "object" && (value as { truncated?: unknown }).truncated === true && typeof (value as { bytes?: unknown }).bytes === "number");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export class EvalService {
  private readonly slots: EvalSlots;
  private readonly active = new Map<string, ActiveRun>();
  private bookkeeping: Promise<void> = Promise.resolve();
  private readonly options: Required<Pick<EvalServiceOptions, "maxCases" | "defaultMaxCostUsd" | "evalRunMaxCostUsd" | "maxResultBytes" | "heartbeatMs">> & EvalServiceOptions;

  constructor(
    private readonly store: Store,
    private readonly executor: EvalWorkflowExecutor,
    /**
     * Phase 9.5 — optional LLM-judge callback. When omitted, judge-based
     * scorers fail with a clear "no judge wired" reason rather than a
     * silent error so operators can see exactly what's needed to enable them.
     */
    private readonly llmJudge?: EvalLlmJudge,
    options: EvalServiceOptions = {}
  ) {
    this.options = { maxCases: 200, defaultMaxCostUsd: 5, evalRunMaxCostUsd: 5, maxResultBytes: 262_144, heartbeatMs: 30_000, ...options };
    this.slots = new EvalSlots(options.concurrency ?? 2);
  }

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  // ---------------------------------------------------------------------------
  // Datasets and golden sets
  // ---------------------------------------------------------------------------

  async createDataset(input: { name: string; description?: string; projectId?: string; workflowId?: string; createdBy?: string }) {
    const id = `ds_${randomUUID()}`;
    await this.store.createEvalDataset({ id, ...input });
    return await this.store.getEvalDataset(id);
  }

  async listDatasets(options: { projectId?: string; workflowId?: string } = {}) {
    return await this.store.listEvalDatasets(options);
  }

  async getDataset(id: string) {
    return await this.store.getEvalDataset(id);
  }

  async deleteDataset(id: string): Promise<boolean> {
    for (let page = 0; page < 100; page += 1) {
      const live = await this.store.listEvalRuns({ datasetId: id, statuses: ["queued", "running"], limit: 500 });
      for (const run of live) await this.cancel(run.id);
      if (live.length < 500) break;
    }
    return await this.store.deleteEvalDataset(id);
  }

  // ---------------------------------------------------------------------------
  // Fixtures
  // ---------------------------------------------------------------------------

  async addFixture(input: { datasetId: string; name: string; input: unknown; expected?: unknown; scorers?: ScorerSpec[]; recordingId?: string }) {
    const id = `fix_${randomUUID()}`;
    await this.store.createEvalFixture({
      id,
      datasetId: input.datasetId,
      name: input.name,
      input: input.input,
      expected: input.expected,
      scorers: input.scorers as Array<Record<string, unknown>> | undefined,
      ...(input.recordingId ? { recordingId: input.recordingId } : {})
    });
    return await this.store.getEvalFixture(id);
  }

  /**
   * Phase 15.2 — a golden run becomes a case of a golden set: its recorded
   * input is the case input, and its recorded output is the expected value
   * (read from the golden run when the case runs, so it is not copied).
   */
  async addGoldenRun(input: { datasetId: string; recording: ReplayRecordingRecord; name?: string; scorers?: ScorerSpec[] }) {
    return await this.addFixture({
      datasetId: input.datasetId,
      name: input.name ?? input.recording.name,
      input: input.recording.input ?? null,
      scorers: input.scorers,
      recordingId: input.recording.id
    });
  }

  async listFixtures(datasetId: string) {
    return await this.store.listEvalFixtures(datasetId);
  }

  async getFixture(id: string) {
    return await this.store.getEvalFixture(id);
  }

  async deleteFixture(id: string): Promise<boolean> {
    return await this.store.deleteEvalFixture(id);
  }

  // ---------------------------------------------------------------------------
  // Runs
  // ---------------------------------------------------------------------------

  /** Creates an eval run and queues it; the run executes in the background. */
  async enqueueRun(request: EvalRunRequest): Promise<EvalRunView> {
    const dataset = await this.store.getEvalDataset(request.datasetId);
    if (!dataset) throw new EvalRunError(`Eval dataset not found: ${request.datasetId}`, "not_found");
    const fixtures = await this.store.listEvalFixtures(request.datasetId);
    if (fixtures.length === 0) throw new EvalRunError(`Dataset ${request.datasetId} has no fixtures`, "invalid");
    if (fixtures.length > this.options.maxCases) throw new EvalRunError(`Dataset ${request.datasetId} has ${fixtures.length} fixtures; a run can have at most ${this.options.maxCases} (REPLAY_JOB_MAX_CASES).`, "limit");
    if (dataset.workflowId && dataset.workflowId !== request.workflowId) throw new EvalRunError("This golden set belongs to another workflow.", "invalid");
    if (fixtures.every((fixture) => fixture.recordingId)) throw new EvalRunError("This golden set holds only golden runs: run it as a replay job, which replays them without side effects.", "invalid");
    const workflow = await this.store.getWorkflow(request.workflowId);

    const runId = `run_${randomUUID()}`;
    const progress = this.initialProgress(fixtures.length);
    await this.store.createEvalRun({
      id: runId,
      kind: "eval",
      status: "queued",
      datasetId: request.datasetId,
      workflowId: request.workflowId,
      ...(workflow?.name ? { workflowName: workflow.name } : {}),
      triggeredBy: request.triggeredBy,
      triggeredByUserId: request.triggeredByUserId,
      scorers: request.scorers as Array<Record<string, unknown>> | undefined,
      progress: progress as unknown as Record<string, unknown>
    });
    const cases = fixtures.map((fixture) => this.caseSpec(fixture, request.scorers));
    await this.launch(runId, cases, (spec, executionId) => this.runEvalCase(request, runId, spec, executionId), { maxCostUsd: this.options.evalRunMaxCostUsd });
    return this.view((await this.store.getEvalRun(runId))!);
  }

  /**
   * Runs every fixture of a dataset against the workflow and returns once
   * the run finished (the pre-15.2 behaviour, behind `?wait=true`).
   */
  async startRun(request: EvalRunRequest): Promise<{ runId: string; summary: EvalRunSummary }> {
    const run = await this.enqueueRun(request);
    await this.wait(run.id);
    const finished = await this.store.getEvalRun(run.id);
    return { runId: run.id, summary: (finished?.summary as unknown as EvalRunSummary) ?? emptySummary(0) };
  }

  /**
   * Phase 15.2 — a replay job: every golden run in the sets, replayed against
   * one candidate and scored. The sets must belong to `workflowId`.
   */
  async enqueueReplayJob(request: ReplayJobRequest, context: { workflowId: string; actor: SafeUser }): Promise<EvalRunView> {
    const prepared = await this.prepareReplayJob(request, context.workflowId, context.actor);
    const { candidate, options, fixtures, datasetIds } = prepared;
    const maxExecutions = this.maxExecutions();
    if (prepared.executions > maxExecutions) {
      throw new EvalRunError(
        `This job would run ${prepared.executions} executions (golden-run cases x repeats${options.compare === "baseline_rerun" ? " x 2 for the baseline reruns" : ""}); a replay job can run at most ${maxExecutions} (REPLAY_JOB_MAX_EXECUTIONS). Use fewer repeats or cases.`,
        "invalid"
      );
    }
    // Server-computed release proof: a release gate requires `releaseEligible` and never re-derives it.
    const releaseIneligibleReasons = replayJobReleaseIneligibleReasons({ kind: candidate.kind, overrides: candidate.overrides ?? null }, options);
    const jobCandidate: ReplayJobCandidate = {
      kind: candidate.kind,
      version: candidate.version,
      workflowHash: candidate.workflowHash,
      ...(candidate.baseHash !== undefined ? { baseHash: candidate.baseHash } : {}),
      ...(candidate.overrides !== undefined ? { overrides: candidate.overrides } : {}),
      ...(candidate.kind === "inline" && candidate.name ? { name: candidate.name } : {}),
      ...(candidate.guardProfile ? { guardProfile: candidate.guardProfile } : {}),
      releaseEligible: releaseIneligibleReasons.length === 0,
      releaseIneligibleReasons
    };
    const runId = `run_${randomUUID()}`;
    const progress = this.initialProgress(fixtures.length);
    await this.store.createEvalRun({
      id: runId,
      kind: "replay",
      status: "queued",
      datasetId: datasetIds[0]!,
      datasetIds,
      workflowId: context.workflowId,
      workflowName: candidate.workflow.name,
      triggeredBy: context.actor.email,
      triggeredByUserId: context.actor.id,
      scorers: request.scorers as Array<Record<string, unknown>> | undefined,
      candidate: jobCandidate as unknown as Record<string, unknown>,
      workflowHash: candidate.workflowHash,
      workflowVersion: candidate.version,
      options: options as unknown as Record<string, unknown>,
      progress: progress as unknown as Record<string, unknown>
    });
    // Phase 15.4 — what each set holds now (the job's own cases); the release gate accepts the job only while its sets still match.
    // Taken here, after the job row exists, never in the estimate path.
    try {
      await this.store.setEvalRunSetSnapshot(runId, await goldenSetSnapshots(datasetIds, async (datasetId) => await this.store.listEvalFixtures(datasetId)));
    } catch (error) {
      // Never leave a job queued that will not launch.
      await this.store.finalizeEvalRun({ id: runId, status: "errored", error: "The golden sets could not be recorded for this job." });
      throw error;
    }
    const job: ReplayJobContext = {
      actorUserId: context.actor.id,
      actorEmail: context.actor.email,
      needsWrite: candidate.kind === "inline" || Boolean(candidate.overrides),
      candidate,
      options,
      scorers: prepared.scorers
    };
    const repeats = options.repeats ?? 1;
    await this.launch(
      runId,
      fixtures.map((fixture) => this.caseSpec(fixture, job.scorers, repeats)),
      (spec, executionId, caseContext) => this.runReplayCase(job, runId, context.workflowId, spec, executionId, caseContext),
      { maxCostUsd: options.maxCostUsd }
    );
    return this.view((await this.store.getEvalRun(runId))!);
  }

  /**
   * Phase 15.6 — one workflow's replay job for a guard policy simulation:
   * the named recordings (a server-internal source, never in the public
   * request), the published version or the draft, models from the tape,
   * strict MCP and the simulated profile swapped in. Never release proof.
   */
  async enqueueSimulationJob(request: SimulationJobRequest, actor: SafeUser): Promise<EvalRunView> {
    const replay = this.options.replay;
    if (!replay) throw new EvalRunError("Replay jobs are not available on this server.", "invalid");
    const recordingIds = [...new Set(request.recordingIds)];
    if (recordingIds.length === 0) throw new EvalRunError("A simulation job needs at least one recording.", "invalid");
    if (recordingIds.length > this.options.maxCases) throw new EvalRunError(`A replay job can have at most ${this.options.maxCases} cases (REPLAY_JOB_MAX_CASES).`, "limit");
    let candidate: EvalReplayCandidate;
    try {
      candidate = await replay.resolveCandidate(request.workflowId, request.version !== undefined ? { version: request.version } : {}, { actor });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new EvalRunError(message, (error as { code?: unknown }).code === "not_found" ? "not_found" : "invalid");
    }
    const options: ReplayJobOptions = { mcpMode: "strict", maxCostUsd: this.options.defaultMaxCostUsd, models: "replay", compare: "recording", repeats: 1, aggregate: "all" };
    const fixtures: EvalFixtureRecord[] = await mapAsync(recordingIds, async (recordingId) => {
      const recording = await replay.getRecording(recordingId);
      const at = recording?.createdAt ?? this.now().toISOString();
      return { id: `rec:${recordingId}`, datasetId: guardSimulationJobDatasetId(request.simulationId), name: recording?.name ?? recordingId, input: null, expected: null, scorers: null, required: false, recordingId, createdAt: at, updatedAt: at };
    });
    const { substitute } = request;
    const jobCandidate: ReplayJobCandidate = {
      kind: candidate.kind,
      version: candidate.version,
      workflowHash: candidate.workflowHash,
      ...(candidate.baseHash !== undefined ? { baseHash: candidate.baseHash } : {}),
      overrides: null,
      guardProfile: { profileId: substitute.profileId, version: substitute.version, hash: substitute.hash },
      releaseEligible: false,
      releaseIneligibleReasons: [GUARD_SIMULATION_RELEASE_REASON, ...replayJobReleaseIneligibleReasons({ kind: candidate.kind, overrides: null }, options)],
      simulation: { id: request.simulationId, profileId: substitute.profileId, version: substitute.version, hash: substitute.hash, inline: substitute.inline }
    };
    const runId = `run_${randomUUID()}`;
    await this.store.createEvalRun({
      id: runId,
      kind: "replay",
      status: "queued",
      datasetId: guardSimulationJobDatasetId(request.simulationId),
      datasetIds: [],
      workflowId: request.workflowId,
      workflowName: candidate.workflow.name,
      triggeredBy: actor.email,
      triggeredByUserId: actor.id,
      candidate: jobCandidate as unknown as Record<string, unknown>,
      workflowHash: candidate.workflowHash,
      workflowVersion: candidate.version,
      options: options as unknown as Record<string, unknown>,
      progress: this.initialProgress(fixtures.length) as unknown as Record<string, unknown>
    });
    const job: ReplayJobContext = {
      actorUserId: actor.id,
      actorEmail: actor.email,
      needsWrite: false,
      // Recent traffic includes captured runs still in the inbox: server-internal, never from a request body.
      allowCandidates: true,
      simulation: {
        id: request.simulationId,
        substitute,
        baseSubstitute: request.baseSubstitute,
        vault: request.vault,
        canRun: request.canRun,
        profileChanged: request.profileChanged,
        ...(request.destinationRows ? { destinationRows: request.destinationRows } : {})
      },
      candidate,
      options,
      scorers: null
    };
    await this.launch(
      runId,
      fixtures.map((fixture) => this.caseSpec(fixture, null)),
      (spec, executionId, caseContext) => this.runSimulationCase(job, request.workflowId, spec, executionId, caseContext),
      // Simulations yield: another job's case always starts first, and they never take every slot.
      { maxCostUsd: options.maxCostUsd, priority: "low" }
    );
    return this.view((await this.store.getEvalRun(runId))!);
  }

  /**
   * Phase 15.3 — what a replay job request would run and cost: cases,
   * executions per case, model calls (none for calls a model tape answers)
   * and USD (the golden runs' recorded tokens priced at the candidate's
   * models, plus the most the judges can cost), with warnings. Validates the
   * request exactly as `enqueueReplayJob` does; nothing is stored or run.
   */
  async estimateReplayJob(request: ReplayJobRequest, context: { workflowId: string; actor?: SafeUser | null } & CandidatePolicy): Promise<ReplayJobEstimate> {
    const replay = this.options.replay!;
    const { candidate, options, fixtures, executions } = await this.prepareReplayJob(request, context.workflowId, context.actor ?? null);
    const repeats = options.repeats ?? 1;
    const baseline = options.compare === "baseline_rerun";
    const fromTape = options.models === "replay";
    const warnings: string[] = [];
    let cases = 0;
    let modelCalls = 0;
    let costUsd = 0;
    let costUnknown = false;
    let noTape = 0;
    let stale = 0;
    let changedModelCalls = 0;
    let missing = 0;
    let capturedBaselines = 0;
    const nowMs = this.now().getTime();
    for (const fixture of fixtures) {
      if (!fixture.recordingId) continue;
      const recording = await replay.getRecording(fixture.recordingId);
      if (!recording || recording.workflowId !== context.workflowId || candidateRefusal(recording, context)) {
        missing += 1;
        continue;
      }
      cases += 1;
      const ageDays = (nowMs - Date.parse(recording.createdAt)) / 86_400_000;
      if (Number.isFinite(ageDays) && ageDays > REPLAY_STALE_RECORDING_DAYS) stale += 1;
      if (fromTape && !recording.modelTape) noTape += 1;
      const own = this.executionEstimate(recording, candidate.workflow, options);
      modelCalls += repeats * own.calls;
      costUsd += repeats * own.usd;
      changedModelCalls += own.changed;
      if (own.unknown) costUnknown = true;
      if (baseline) {
        if (await this.baselineSourceOf(recording) === "redacted") capturedBaselines += 1;
        const rerun = this.executionEstimate(recording, null, options);
        modelCalls += repeats * rerun.calls;
        costUsd += repeats * rerun.usd;
        if (rerun.unknown) costUnknown = true;
      }
    }
    // The judges' worst case, as the runner reserves it.
    for (const fixture of fixtures) {
      if (!fixture.recordingId) continue;
      const spec = this.caseSpec(fixture, this.normalisedScorers(request), repeats);
      costUsd += spec.reserveUsd;
      if (spec.reserveUnknown) costUnknown = true;
    }
    const handWritten = fixtures.filter((fixture) => !fixture.recordingId).length;
    if (handWritten > 0) warnings.push(`${handWritten} hand-written case${handWritten === 1 ? " is" : "s are"} skipped: replay jobs replay golden runs only.`);
    if (missing > 0) warnings.push(`${missing} case${missing === 1 ? "'s golden run was" : "s' golden runs were"} deleted; ${missing === 1 ? "it" : "they"} will be inconclusive.`);
    if (noTape > 0) {
      warnings.push(
        `${noTape} of ${cases} golden run${cases === 1 ? " has" : "s have"} no model tape: with models "replay" ${noTape === 1 ? "that case is" : "those cases are"} inconclusive. Save golden runs from runs recorded with Record calls on, or replay with live models.`
      );
    }
    if (fromTape && changedModelCalls > 0) {
      warnings.push(
        options.mcpMode === "lenient"
          ? "The model overrides change model calls a tape cannot answer: those calls go to the live model (lenient)."
          : "The model overrides change model calls a tape cannot answer: in strict mode those cases are inconclusive. Use live models, or lenient to let them call the live model."
      );
    }
    if (capturedBaselines > 0) {
      warnings.push(
        `${capturedBaselines} golden run${capturedBaselines === 1 ? " has" : "s have"} no saved version to rerun, and the workflow captured with ${capturedBaselines === 1 ? "it" : "them"} had credentials scrubbed out, so ${capturedBaselines === 1 ? "that case is" : "those cases are"} inconclusive under a baseline rerun. Re-record ${capturedBaselines === 1 ? "this golden run" : "these golden runs"} from a saved version, or compare with the recording.`
      );
    }
    if (!baseline && stale > 0) {
      warnings.push(
        `${stale} golden run${stale === 1 ? " is" : "s are"} more than ${REPLAY_STALE_RECORDING_DAYS} days old: compare with a baseline rerun so model drift since then is not blamed on the candidate.`
      );
    }
    if (costUnknown) warnings.push("Some models have no price in the price table: the estimate leaves them out.");
    const estimatedCostUsd = roundUsd(costUsd);
    if (estimatedCostUsd > options.maxCostUsd) {
      warnings.push(`The estimate ($${estimatedCostUsd.toFixed(4)}) is over the job's budget ($${options.maxCostUsd}): the job stops once it has spent the budget.`);
    }
    const maxExecutions = this.maxExecutions();
    if (executions > maxExecutions) {
      warnings.push(`The job would run ${executions} executions, more than REPLAY_JOB_MAX_EXECUTIONS (${maxExecutions}): starting it is refused. Use fewer repeats or cases.`);
    }
    return { cases, runsPerCase: repeats * (baseline ? 2 : 1), modelCallsEstimate: modelCalls, estimatedCostUsd, costUnknown, warnings, executions, maxExecutions };
  }

  private maxExecutions(): number {
    return this.options.maxExecutions ?? REPLAY_JOB_MAX_EXECUTIONS_DEFAULT;
  }

  /** Phase 15.3 — where a golden run's baseline would come from: its saved version, else the scrubbed captured copy. */
  private async baselineSourceOf(recording: ReplayRecordingRecord): Promise<"version" | "captured" | "redacted" | "none"> {
    try {
      const found = await this.options.replay?.baselineFor?.(recording);
      if (found?.source === "captured") return capturedWorkflowIsRedacted(found.workflow) ? "redacted" : "captured";
      return "version";
    } catch {
      return "none";
    }
  }

  /**
   * Phase 15.3 — what one execution of a golden run is expected to cost:
   * its recorded model calls priced at the models `workflow` calls (null:
   * the recorded models, a baseline rerun). A call the tape answers costs
   * nothing; with models "replay" only a lenient call the tape cannot answer
   * (a changed model) goes live. `changed` counts calls the candidate makes
   * on another model than the recording.
   */
  private executionEstimate(
    recording: ReplayRecordingRecord,
    workflow: Workflow | null,
    options: Pick<ReplayJobOptions, "models" | "mcpMode">
  ): { usd: number; calls: number; changed: number; unknown: boolean } {
    const replay = this.options.replay!;
    const fromTape = options.models === "replay";
    const hasTape = Boolean(recording.modelTape);
    let usd = 0;
    let calls = 0;
    let changed = 0;
    let unknown = false;
    // Without a tape a model replay is inconclusive before anything runs.
    if (fromTape && !hasTape) return { usd, calls, changed, unknown };
    for (const call of recording.facts.modelCalls) {
      const target = (workflow ? effectiveModelFor(workflow, call.nodeId) : null) ?? { providerId: call.providerId, model: call.model };
      const isChanged = target.providerId !== call.providerId || target.model !== call.model;
      if (isChanged) changed += 1;
      const live = !fromTape || (isChanged && options.mcpMode === "lenient");
      if (!live) continue;
      calls += 1;
      if (call.inputTokens === null && call.outputTokens === null) continue;
      const price = replay.priceCall ? replay.priceCall(target.providerId, target.model, call.inputTokens ?? 0, call.outputTokens ?? 0) : null;
      if (price === null || !Number.isFinite(price)) unknown = true;
      else usd += price;
    }
    return { usd: roundUsd(usd), calls, changed, unknown };
  }

  private normalisedScorers(request: ReplayJobRequest): EvalScorerSpec[] | null {
    return request.scorers && request.scorers.length > 0 ? request.scorers : null;
  }

  /** Phase 15.3 — checks a replay job request and resolves its candidate, without storing anything. */
  private async prepareReplayJob(request: ReplayJobRequest, workflowId: string, actor: SafeUser | null = null): Promise<PreparedReplayJob> {
    const replay = this.options.replay;
    if (!replay) throw new EvalRunError("Replay jobs are not available on this server.", "invalid");
    const datasetIds = [...new Set(request.datasetIds)];
    const fixtures: EvalFixtureRecord[] = [];
    for (const datasetId of datasetIds) {
      const dataset = await this.store.getEvalDataset(datasetId);
      if (!dataset) throw new EvalRunError(`Golden set not found: ${datasetId}`, "not_found");
      if (dataset.workflowId !== workflowId) throw new EvalRunError(`Golden set ${datasetId} does not belong to this workflow.`, "invalid");
      fixtures.push(...await this.store.listEvalFixtures(datasetId));
    }
    if (!fixtures.some((fixture) => fixture.recordingId)) throw new EvalRunError("These golden sets hold no golden runs to replay.", "invalid");
    if (fixtures.length > this.options.maxCases) throw new EvalRunError(`These golden sets hold ${fixtures.length} cases; a replay job can have at most ${this.options.maxCases} (REPLAY_JOB_MAX_CASES).`, "limit");
    if (request.compare === "baseline_rerun" && !replay.baselineFor) throw new EvalRunError("Baseline reruns are not available on this server.", "invalid");

    let candidate: EvalReplayCandidate;
    try {
      candidate = await replay.resolveCandidate(workflowId, {
        ...(request.draft !== undefined ? { draft: request.draft } : {}),
        ...(request.version !== undefined ? { version: request.version } : {}),
        ...(request.workflow !== undefined ? { workflow: request.workflow } : {}),
        ...(request.overrides !== undefined ? { overrides: request.overrides } : {})
      }, { actor });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = (error as { code?: unknown }).code;
      throw new EvalRunError(
        message,
        code === "forbidden" ? "forbidden" : code === "not_found" || (code === undefined && /not found|no longer exists/i.test(message)) ? "not_found" : "invalid"
      );
    }
    const options: ReplayJobOptions = {
      mcpMode: request.mcpMode ?? "strict",
      ...(request.ignorePaths && request.ignorePaths.length > 0 ? { ignorePaths: request.ignorePaths } : {}),
      ...(request.numberTolerance !== undefined ? { numberTolerance: request.numberTolerance } : {}),
      maxCostUsd: request.maxCostUsd ?? this.options.defaultMaxCostUsd,
      models: request.models ?? "live",
      compare: request.compare ?? "recording",
      repeats: request.repeats ?? 1,
      aggregate: request.aggregate ?? "all"
    };
    const goldenCases = fixtures.filter((fixture) => fixture.recordingId).length;
    const executions = goldenCases * (options.repeats ?? 1) * (options.compare === "baseline_rerun" ? 2 : 1);
    return { datasetIds, fixtures, executions, candidate, options, scorers: this.normalisedScorers(request) };
  }

  /** Resolves when the run has finished (immediately for a run this process is not running). */
  async wait(runId: string): Promise<void> {
    await this.active.get(runId)?.done;
    // A run that just finished leaves `active` before its last writes land (see launch); wait for those too, so the
    // stored run is final whether or not this call found it active. The chain is serial and the run queued its last
    // writes before it left `active`, so its current tail covers them; writes other runs queue later are not waited on.
    await this.settled();
  }

  isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  /**
   * Listens to a run's progress; the listener gets the run after every case
   * and once more, with `done`, when it finishes. Returns the unsubscribe
   * function, or null when this process is not running the run.
   */
  subscribe(runId: string, listener: Listener): (() => void) | null {
    const active = this.active.get(runId);
    if (!active) return null;
    active.listeners.add(listener);
    return () => active.listeners.delete(listener);
  }

  /**
   * Cancels a queued or running run: no further cases start, running
   * executions are aborted, and the run is `canceled`. Returns the run, or
   * null when it does not exist. A finished run is returned unchanged.
   */
  async cancel(runId: string): Promise<EvalRunView | null> {
    const record = await this.store.getEvalRun(runId);
    if (!record) return null;
    if (EVAL_RUN_FINISHED_STATUSES.has(record.status)) return this.view(record);
    const active = this.active.get(runId);
    if (active) {
      active.canceled = true;
      for (const executionId of active.inFlight) this.options.abortExecution?.(executionId, "The eval run was canceled.");
      this.wake(active);
    }
    const progress = active ? { ...active.progress, updatedAt: this.now().toISOString() } : (record.progress as unknown as EvalRunProgress | null);
    await this.store.finalizeEvalRun({
      id: runId,
      status: "canceled",
      ...(active ? { summary: this.finishSummary(active) as unknown as Record<string, unknown> } : {}),
      ...(progress ? { progress: progress as unknown as Record<string, unknown> } : {}),
      error: "Canceled",
      onlyFrom: ["queued", "running"]
    });
    const view = this.view((await this.store.getEvalRun(runId))!);
    if (active) this.emit(active, view, false);
    return view;
  }

  /**
   * The server is stopping: every run this process is executing stops
   * scheduling cases, its running executions are aborted, and it is marked
   * `interrupted` (cases that finish afterwards are still recorded if the
   * store is open).
   */
  async shutdown(): Promise<void> {
    for (const active of this.active.values()) {
      if (active.canceled) continue;
      active.canceled = true;
      for (const executionId of active.inFlight) this.options.abortExecution?.(executionId, "The server is stopping.");
      this.wake(active);
      this.safely(async () => {
        await this.store.finalizeEvalRun({
          id: active.runId,
          status: "interrupted",
          summary: this.finishSummary(active) as unknown as Record<string, unknown>,
          progress: { ...active.progress, updatedAt: this.now().toISOString() } as unknown as Record<string, unknown>,
          error: "The server stopped before this run finished.",
          onlyFrom: ["queued", "running"]
        });
      });
    }
    await this.flush();
  }

  /**
   * Marks runs a stopped server left queued or running as `interrupted`. In
   * a single-instance deployment that is every such run; with `onlyStale`
   * (several instances share the database) only runs whose progress has not
   * been written for `EVAL_RUN_STALE_MS`, so runs another live instance is
   * executing are left alone.
   */
  async recoverInterrupted(options: { onlyStale?: boolean } = {}): Promise<number> {
    let count = 0;
    // Runs left alone stay in the list, so the next page starts after them.
    let kept = 0;
    const nowMs = this.now().getTime();
    for (;;) {
      const page = await this.store.listEvalRuns({ statuses: ["queued", "running"], limit: 500, offset: kept });
      for (const run of page) {
        let keep = this.active.has(run.id);
        if (!keep && options.onlyStale) {
          const seen = Date.parse(String((run.progress as { updatedAt?: unknown } | null)?.updatedAt ?? run.startedAt));
          keep = Number.isFinite(seen) && nowMs - seen < EVAL_RUN_STALE_MS;
        }
        if (keep) {
          kept += 1;
          continue;
        }
        if (await this.store.finalizeEvalRun({ id: run.id, status: "interrupted", error: "The server stopped before this run finished.", onlyFrom: ["queued", "running"] })) count += 1;
        else kept += 1;
      }
      if (page.length < 500) break;
    }
    return count;
  }

  async listRuns(options: { datasetId?: string; workflowId?: string; workflowIds?: string[]; kind?: "eval" | "replay"; limit?: number; excludeSimulations?: boolean } = {}): Promise<EvalRunView[]> {
    return (await this.store.listEvalRuns(options)).map((run) => this.view(run));
  }

  async getRun(id: string): Promise<(EvalRunView & { results: Array<EvalCaseResult & { output: unknown }> }) | null> {
    const run = await this.store.getEvalRun(id);
    if (!run) return null;
    const results = (await this.store.listEvalResults(id)).map((result) => ({ ...this.caseView(result), output: result.output }));
    return { ...this.view(run), results };
  }

  async getRunView(id: string): Promise<EvalRunView | null> {
    const run = await this.store.getEvalRun(id);
    return run ? this.view(run) : null;
  }

  async getCase(runId: string, resultId: string): Promise<EvalCaseDetail | null> {
    const result = await this.store.getEvalResult(runId, resultId);
    if (!result) return null;
    const diff = (result.diff as ReplayCaseDiff | EvalStoredTruncation | null) ?? null;
    if (isTruncation(diff)) return { ...this.caseView(result), output: result.output, replay: null, replayTruncated: diff };
    return { ...this.caseView(result), output: result.output, replay: diff };
  }

  // ---------------------------------------------------------------------------
  // Runner
  // ---------------------------------------------------------------------------

  private initialProgress(total: number): EvalRunProgress {
    return { total, done: 0, running: 0, pass: 0, fail: 0, error: 0, skipped: 0, spentUsd: 0, updatedAt: this.now().toISOString() };
  }

  /** A case and the judge spend to reserve for it (its own scorers, else the run's; default scorers never call a judge). */
  private caseSpec(fixture: EvalFixtureRecord, runScorers: EvalScorerSpec[] | null | undefined, repeats = 1): CaseSpec {
    let calls = 0;
    let reserveUsd = 0;
    let reserveUnknown = false;
    for (const scorer of this.effectiveScorers(fixture, runScorers, [])) {
      const wanted = Math.min(judgeCallsFor(scorer), EVAL_JUDGE_CALLS_PER_CASE_MAX - calls);
      if (wanted <= 0 || !this.options.judgeCallCeilingUsd) continue;
      calls += wanted;
      const judge = scorer as { providerId?: string; model?: string };
      const ceiling = this.options.judgeCallCeilingUsd({ ...(judge.providerId ? { providerId: judge.providerId } : {}), ...(judge.model ? { model: judge.model } : {}) });
      if (ceiling === null || !Number.isFinite(ceiling)) reserveUnknown = true;
      else reserveUsd += wanted * ceiling;
    }
    // Phase 15.3 — every repeat of a case is scored, so its judges are reserved once per repeat.
    return { fixture, reserveUsd: roundUsd(reserveUsd * Math.max(1, repeats)), reserveUnknown };
  }

  private async launch(runId: string, cases: CaseSpec[], runCase: RunCaseFn, limits: { maxCostUsd?: number; priority?: "low" } = {}): Promise<void> {
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const record = (await this.store.getEvalRun(runId))!;
    const active: ActiveRun = {
      runId,
      canceled: false,
      inFlight: new Set(),
      listeners: new Set(),
      done,
      resolveDone,
      progress: (record.progress as unknown as EvalRunProgress) ?? this.initialProgress(cases.length),
      summary: emptySummary(cases.length),
      caseWaiters: [],
      warnings: new Set(),
      inflightUsd: 0,
      budgetStop: null
    };
    this.active.set(runId, active);
    this.execute(active, cases, runCase, limits)
      .catch((error) => {
        this.options.logger?.warn("Eval run failed", { runId, error: error instanceof Error ? error.message : String(error) });
        this.safely(async () => {
          await this.store.finalizeEvalRun({
            id: runId,
            status: "failed",
            summary: this.finishSummary(active) as unknown as Record<string, unknown>,
            error: `The run stopped on an internal error: ${error instanceof Error ? error.message : String(error)}`,
            onlyFrom: ["queued", "running"]
          });
        });
      })
      // promise-ok: finally waits for the returned promise; flush never rejects
      .finally(async () => {
        this.active.delete(runId);
        this.wake(active);
        await this.settled();
        active.resolveDone();
      });
  }

  private wake(active: ActiveRun): void {
    const waiters = active.caseWaiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  private nextCaseDone(active: ActiveRun): Promise<void> {
    return new Promise((resolve) => active.caseWaiters.push(resolve));
  }

  private async execute(active: ActiveRun, cases: CaseSpec[], runCase: RunCaseFn, limits: { maxCostUsd?: number; priority?: "low" }): Promise<void> {
    const low = limits.priority === "low";
    const heartbeat = setInterval(() => {
      if (active.canceled) return;
      active.progress = { ...active.progress, updatedAt: this.now().toISOString() };
      this.safely(async () => await this.store.updateEvalRunProgress({ id: active.runId, progress: active.progress as unknown as Record<string, unknown> }));
    }, this.options.heartbeatMs);
    heartbeat.unref?.();
    const running: Array<Promise<void>> = [];
    let started = false;
    let budgetStop: string | null = null;
    // Spend so far: recorded cases plus executions that finished inside cases still running (Phase 15.3).
    const spentNow = () => roundUsd(active.progress.spentUsd + active.inflightUsd);
    // Judge spend reserved by the cases in flight.
    let reserved = 0;
    // Phase 15.3 — the part of `reserved` already spent (counted in inflightUsd too), and execution estimates held.
    let judgeConsumed = 0;
    let executionsHeld = 0;
    try {
      for (const spec of cases) {
        await this.slots.acquire(low);
        const max = limits.maxCostUsd;
        if (max !== undefined) {
          // Wait for cases in flight to give back their reservations while this one does not fit.
          while (!active.canceled && !active.budgetStop && reserved > 0 && spentNow() + reserved + spec.reserveUsd > max) await this.nextCaseDone(active);
        }
        if (active.canceled || active.budgetStop) {
          this.slots.release(low);
          break;
        }
        if (max !== undefined) {
          const spent = spentNow();
          if (spent >= max) {
            budgetStop = `Stopped after ${active.progress.done} of ${cases.length} cases (${REPLAY_BUDGET_EXHAUSTED}): the run spent $${spent.toFixed(4)} of its $${max} budget.`;
          } else if (spent + spec.reserveUsd > max) {
            budgetStop = `Stopped after ${active.progress.done} of ${cases.length} cases (${REPLAY_BUDGET_EXHAUSTED}): the next case's judge calls could cost up to $${spec.reserveUsd.toFixed(4)}, more than the $${(max - spent).toFixed(4)} left of the run's $${max} budget.`;
          }
          if (budgetStop) {
            this.slots.release(low);
            break;
          }
        }
        if (spec.reserveUnknown && !active.warnings.has(UNPRICED_WARNING)) {
          active.warnings.add(UNPRICED_WARNING);
          active.progress = { ...active.progress, costUnknown: true };
        }
        if (!started) {
          started = true;
          active.progress = { ...active.progress, updatedAt: this.now().toISOString() };
          this.safely(async () => await this.store.updateEvalRunProgress({ id: active.runId, status: "running", progress: active.progress as unknown as Record<string, unknown> }));
        }
        const executionId = randomUUID();
        active.inFlight.add(executionId);
        active.progress = { ...active.progress, running: active.progress.running + 1 };
        reserved = roundUsd(reserved + spec.reserveUsd);
        // Phase 15.3 — a case's later executions (repeats, baseline reruns) are abortable too, and count toward the budget at once.
        const caseExecutions = [executionId];
        let caseSpent = 0;
        let caseJudgeSpent = 0;
        let caseHeld = 0;
        const consumedOf = () => Math.min(spec.reserveUsd, caseJudgeSpent);
        const caseContext: CaseRunContext = {
          nextExecutionId: () => {
            const next = randomUUID();
            caseExecutions.push(next);
            active.inFlight.add(next);
            return next;
          },
          canceled: () => active.canceled,
          spend: (usd, judge) => {
            if (!Number.isFinite(usd) || usd <= 0) return;
            caseSpent = roundUsd(caseSpent + usd);
            active.inflightUsd = roundUsd(active.inflightUsd + usd);
            if (judge) {
              const before = consumedOf();
              caseJudgeSpent = roundUsd(caseJudgeSpent + usd);
              judgeConsumed = roundUsd(judgeConsumed + consumedOf() - before);
            }
          },
          reserve: (usd) => {
            const amount = Number.isFinite(usd) && usd > 0 ? usd : 0;
            if (max !== undefined) {
              // Spent, plus judge reservations not spent yet, plus other executions' estimates still running.
              const committed = spentNow() + Math.max(0, reserved - judgeConsumed) + executionsHeld;
              if (committed + amount > max) return false;
            }
            executionsHeld = roundUsd(executionsHeld + amount);
            caseHeld = roundUsd(caseHeld + amount);
            return true;
          },
          release: (usd) => {
            const amount = Math.min(caseHeld, Number.isFinite(usd) && usd > 0 ? usd : 0);
            executionsHeld = Math.max(0, roundUsd(executionsHeld - amount));
            caseHeld = Math.max(0, roundUsd(caseHeld - amount));
          },
          overBudget: () => max !== undefined && spentNow() >= max,
          maxCostUsd: max
        };
        running.push(
          (async () => {
            let outcome: CaseOutcome;
            try {
              outcome = await runCase(spec, executionId, caseContext);
            } catch (error) {
              outcome = { status: "error", error: error instanceof Error ? error.message : String(error), ...(spec.fixture.recordingId ? { recordingId: spec.fixture.recordingId } : {}) };
            } finally {
              for (const id of caseExecutions) active.inFlight.delete(id);
              this.slots.release(low);
            }
            active.inflightUsd = Math.max(0, roundUsd(active.inflightUsd - caseSpent));
            if (outcome.budgetStop && !active.budgetStop) active.budgetStop = outcome.budgetStop;
            reserved = Math.max(0, roundUsd(reserved - spec.reserveUsd));
            judgeConsumed = Math.max(0, roundUsd(judgeConsumed - consumedOf()));
            executionsHeld = Math.max(0, roundUsd(executionsHeld - caseHeld));
            caseHeld = 0;
            try {
              this.record(active, spec, outcome);
            } catch (error) {
              this.options.logger?.warn("Eval case bookkeeping failed", { runId: active.runId, error: error instanceof Error ? error.message : String(error) });
            } finally {
              this.wake(active);
            }
          })()
        );
      }
      await Promise.all(running);
    } finally {
      clearInterval(heartbeat);
    }
    budgetStop = budgetStop ?? active.budgetStop;
    const summary = this.finishSummary(active);
    const progress = { ...active.progress, running: 0, updatedAt: this.now().toISOString() };
    active.progress = progress;
    if (active.canceled) {
      // The run is already `canceled`; keep its summary current with the cases that finished after the cancel.
      this.safely(async () => await this.store.updateEvalRunSummary(active.runId, summary as unknown as Record<string, unknown>, progress as unknown as Record<string, unknown>));
    } else {
      this.safely(async () =>
        await this.store.finalizeEvalRun({
          id: active.runId,
          status: budgetStop ? "failed" : "completed",
          summary: summary as unknown as Record<string, unknown>,
          progress: progress as unknown as Record<string, unknown>,
          ...(budgetStop ? { error: budgetStop } : {}),
          onlyFrom: ["queued", "running"]
        })
      );
    }
    this.safely(async () => {
      const record = await this.store.getEvalRun(active.runId);
      if (record) this.emit(active, this.view(record), true);
    });
  }

  /**
   * Queues a bookkeeping write behind the ones before it, so progress,
   * results and the final status land in the order they were made (a
   * pooled database could otherwise run them out of order). A failed write
   * is logged and does not stop the ones after it.
   */
  private safely(write: () => unknown): void {
    this.bookkeeping = this.bookkeeping.then(async () => {
      await write();
    }).catch((error: unknown) => {
      this.options.logger?.warn("Eval run bookkeeping failed", { error: error instanceof Error ? error.message : String(error) });
    });
  }

  /**
   * Resolves once every bookkeeping write queued so far has finished (the chain is serial, so its current tail covers
   * them all); writes queued afterwards are not waited on. Never rejects (safely catches each write).
   */
  private async settled(): Promise<void> {
    await this.bookkeeping;
  }

  /** Resolves once every queued bookkeeping write has finished, including writes queued while it waits. */
  async flush(): Promise<void> {
    let last: Promise<void>;
    do {
      last = this.bookkeeping;
      await last;
      // promise-ok: identity check: a write queued while waiting replaced the tail
    } while (last !== this.bookkeeping);
  }

  /** A value to store as it is, or a truncation marker when its JSON is over `maxResultBytes`. */
  private capped(value: unknown): unknown {
    if (value === undefined) return undefined;
    const json = JSON.stringify(value);
    if (json === undefined) return value;
    const bytes = Buffer.byteLength(json, "utf8");
    if (bytes <= this.options.maxResultBytes) return value;
    const marker: EvalStoredTruncation = { truncated: true, bytes, maxBytes: this.options.maxResultBytes, preview: json.slice(0, 2000) };
    return marker;
  }

  private async scrubText(text: string): Promise<string> {
    if (!this.options.scrub) return text;
    try {
      return await this.options.scrub(text);
    } catch {
      return text;
    }
  }

  private record(active: ActiveRun, spec: CaseSpec, outcome: CaseOutcome): void {
    const summary = active.summary;
    if (outcome.status === "skipped") summary.skipped = (summary.skipped ?? 0) + 1;
    else summary[outcome.status] += 1;
    if (outcome.status === "pass" || outcome.status === "fail") {
      if (typeof outcome.durationMs === "number") summary.totalDurationMs += outcome.durationMs;
      if (typeof outcome.tokens?.input === "number") summary.totalTokenInput += outcome.tokens.input;
      if (typeof outcome.tokens?.output === "number") summary.totalTokenOutput += outcome.tokens.output;
      if (typeof outcome.tokens?.total === "number") summary.totalTokenTotal += outcome.tokens.total;
    }
    const cost = typeof outcome.costUsd === "number" && Number.isFinite(outcome.costUsd) ? outcome.costUsd : 0;
    summary.costUsd = roundUsd((summary.costUsd ?? 0) + cost);
    summary.judgeCostUsd = roundUsd((summary.judgeCostUsd ?? 0) + (outcome.judgeCostUsd ?? 0));
    if (outcome.costUnknown) active.warnings.add(UNPRICED_WARNING);
    if (outcome.flaky) summary.flaky = (summary.flaky ?? 0) + 1;
    if (typeof outcome.executions === "number") summary.executions = (summary.executions ?? 0) + outcome.executions;
    if (outcome.replayedModelCalls) summary.replayedModelCalls = (summary.replayedModelCalls ?? 0) + outcome.replayedModelCalls;
    if (outcome.recordedCostUsd) summary.recordedCostUsd = roundUsd((summary.recordedCostUsd ?? 0) + outcome.recordedCostUsd);

    this.safely(async () => {
      const error = outcome.error ? await this.scrubText(outcome.error) : undefined;
      const score = outcome.score
        ? {
            pass: outcome.score.pass,
            details: await mapAsync(outcome.score.details, async (detail) => ({ ...detail, reason: await this.scrubText(detail.reason) })),
            ...(outcome.repeats ? { repeats: outcome.repeats } : {})
          }
        : outcome.repeats
          ? { pass: outcome.status === "pass", details: [], repeats: outcome.repeats }
          : undefined;
      // The run was deleted with its golden set while this case ran: store nothing.
      if (!await this.store.getEvalRun(active.runId)) return;
      await this.store.recordEvalResult({
        id: `res_${randomUUID()}`,
        runId: active.runId,
        fixtureId: spec.fixture.id,
        fixtureName: spec.fixture.name,
        status: outcome.status,
        ...(outcome.executionId ? { executionId: outcome.executionId } : {}),
        ...(score ? { score: score as unknown as Record<string, unknown> } : {}),
        ...(outcome.output !== undefined ? { output: this.capped(outcome.output) } : {}),
        ...(error ? { error } : {}),
        ...(typeof outcome.durationMs === "number" ? { durationMs: outcome.durationMs } : {}),
        ...(typeof outcome.tokens?.input === "number" ? { tokenInput: outcome.tokens.input } : {}),
        ...(typeof outcome.tokens?.output === "number" ? { tokenOutput: outcome.tokens.output } : {}),
        ...(typeof outcome.tokens?.total === "number" ? { tokenTotal: outcome.tokens.total } : {}),
        ...(outcome.recordingId ? { recordingId: outcome.recordingId } : {}),
        ...(outcome.verdict ? { verdict: outcome.verdict } : {}),
        ...(outcome.diff ? { diff: this.capped(outcome.diff) as Record<string, unknown> } : {}),
        costUsd: outcome.costUsd ?? null
      });
    });

    active.progress = {
      ...active.progress,
      done: active.progress.done + 1,
      running: Math.max(0, active.progress.running - 1),
      [outcome.status]: active.progress[outcome.status] + 1,
      spentUsd: roundUsd(active.progress.spentUsd + cost),
      ...(outcome.costUnknown ? { costUnknown: true } : {}),
      updatedAt: this.now().toISOString()
    };
    if (!active.canceled) {
      this.safely(async () => await this.store.updateEvalRunProgress({ id: active.runId, progress: active.progress as unknown as Record<string, unknown> }));
    }
    this.safely(async () => {
      const record = await this.store.getEvalRun(active.runId);
      if (record) this.emit(active, { ...this.view(record), progress: active.progress }, false);
    });
  }

  private finishSummary(active: ActiveRun): EvalRunSummary {
    const summary = { ...active.summary };
    const scored = summary.total - (summary.skipped ?? 0);
    summary.passRate = scored > 0 ? summary.pass / scored : 0;
    summary.avgDurationMs = scored > 0 ? Math.round(summary.totalDurationMs / scored) : 0;
    if (active.warnings.size > 0) summary.warnings = [...active.warnings];
    if (active.warnings.has(UNPRICED_WARNING)) summary.costUnknown = true;
    return summary;
  }

  private emit(active: ActiveRun, view: EvalRunView, done: boolean): void {
    for (const listener of active.listeners) {
      try {
        listener(view, done);
      } catch {
        // A listener (an SSE response) that fails is the listener's problem, never the run's.
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Cases
  // ---------------------------------------------------------------------------

  private effectiveScorers(fixture: EvalFixtureRecord, runScorers: EvalScorerSpec[] | null | undefined, fallback: EvalScorerSpec[]): EvalScorerSpec[] {
    const own = (fixture.scorers ?? []) as EvalScorerSpec[];
    if (own.length > 0) return own;
    if (runScorers && runScorers.length > 0) return runScorers;
    return fallback;
  }

  /** The judge for one case: every call carries who it is for, so the host can check the secret and record usage. */
  private judgeFor(context: EvalJudgeContext): EvalLlmJudge | undefined {
    const judge = this.llmJudge;
    if (!judge) return undefined;
    return (input) => judge({ ...input, context });
  }

  private async score(
    scorers: EvalScorerSpec[],
    ctx: Omit<Parameters<typeof applyScorer>[1], "llmJudge" | "judgeCalls">,
    context: EvalJudgeContext
  ): Promise<{ score: { pass: boolean; details: EvalScoreDetail[] }; judgeCostUsd: number; judgeCostUnknown: boolean }> {
    // One counter for every scorer of the case: at most EVAL_JUDGE_CALLS_PER_CASE_MAX judge calls in all.
    const shared = { ...ctx, llmJudge: this.judgeFor(context), judgeCalls: { count: 0 } };
    const details = await Promise.all(scorers.map((scorer) => applyScorer(scorer, shared)));
    const judgeCostUsd = roundUsd(details.reduce((sum, detail) => sum + (detail.costUsd ?? 0), 0));
    return { score: { pass: details.every((detail) => detail.pass), details }, judgeCostUsd, judgeCostUnknown: details.some((detail) => detail.costUnknown) };
  }

  private async runEvalCase(request: EvalRunRequest, runId: string, spec: CaseSpec, executionId: string): Promise<CaseOutcome> {
    const { fixture } = spec;
    if (fixture.recordingId) {
      // A golden run replays without side effects in a replay job; an eval run would run it live.
      return { status: "skipped", recordingId: fixture.recordingId, error: "A golden run; golden runs run as replay jobs, never live in an eval run." };
    }
    const exec = await this.executor({
      workflowId: request.workflowId,
      fixtureInput: fixture.input,
      fixtureName: fixture.name,
      fixtureId: fixture.id,
      runId,
      executionId,
      triggeredBy: request.triggeredBy,
      triggeredByUserId: request.triggeredByUserId,
      ...(request.recordMcp || request.replayMcp
        ? { mcp: { ...(request.recordMcp ? { record: true } : {}), ...(request.replayMcp ? { replay: request.replayMcp } : {}) } }
        : {})
    });
    const modelCost = exec.facts?.totals.costUsd ?? null;
    const modelCostUnknown = modelCostIsUnknown(exec.facts);
    if (exec.error) {
      return { status: "error", executionId: exec.executionId, error: exec.error, durationMs: exec.durationMs, tokens: exec.tokens, costUsd: modelCost, costUnknown: modelCostUnknown };
    }
    const { score, judgeCostUsd, judgeCostUnknown } = await this.score(
      this.effectiveScorers(fixture, request.scorers, [{ type: "exact_match" }]),
      {
        output: exec.output,
        expected: fixture.expected ?? undefined,
        fixtureInput: fixture.input,
        baseline: null,
        candidate: exec.facts ?? null,
        ...(this.options.random ? { random: this.options.random } : {})
      },
      { runId, workflowId: request.workflowId, actorUserId: request.triggeredByUserId, actorEmail: request.triggeredBy, ...(exec.executionId ? { executionId: exec.executionId } : {}) }
    );
    return {
      status: score.pass ? "pass" : "fail",
      costUnknown: modelCostUnknown || judgeCostUnknown,
      executionId: exec.executionId,
      score,
      output: exec.output,
      durationMs: exec.durationMs,
      tokens: exec.tokens,
      costUsd: roundUsd((modelCost ?? 0) + judgeCostUsd),
      judgeCostUsd
    };
  }

  /**
   * Phase 15.6 — one case of a guard policy simulation: the recording
   * replayed under the current profiles (the baseline) and with the
   * simulated profile swapped in, both from the tape with strict MCP, their
   * verdicts kept in memory (never in guard_events), and the comparison
   * stored as the case's diff (`{ simulation: GuardSimulationCase }`).
   */
  private async runSimulationCase(job: ReplayJobContext, workflowId: string, spec: CaseSpec, executionId: string, context?: CaseRunContext): Promise<CaseOutcome> {
    const simulation = job.simulation!;
    const replay = this.options.replay!;
    const recordingId = spec.fixture.recordingId!;
    const recording = await replay.getRecording(recordingId);
    const meta = recording ? { id: recording.id, name: recording.name, createdAt: recording.createdAt } : null;
    const finish = (entry: Awaited<ReturnType<typeof simulateCase>>, executions: number): CaseOutcome => ({
      status: entry.outcome === "not_simulated" ? "error" : "pass",
      recordingId,
      ...(entry.executionId ? { executionId: entry.executionId } : {}),
      ...(entry.reason ? { error: entry.reason } : {}),
      verdict: entry.outcome,
      diff: { simulation: entry } as unknown as ReplayCaseDiff,
      costUsd: 0,
      executions
    });
    const skip = async (reason: string) => finish(await simulateCase({ recordingId, recording: meta, baseline: null, candidate: null, skipped: reason, scrub: (text) => this.scrubText(text) }), 0);
    if (!recording) return await skip("The recording was deleted before it could be replayed.");
    if (recording.workflowId !== workflowId) return await skip("The recording belongs to another workflow.");
    // Phase 15.6 — the same candidate policy as every golden-run path; a simulation job allows captured runs.
    const refusal = candidateRefusal(recording, { allowCandidates: job.allowCandidates });
    if (refusal) return await skip(refusal);
    const actor = await replay.actorFor(job.actorUserId, job.actorEmail, workflowId, "workflow:read");
    if (!actor) return await skip(`The user who started this simulation (${job.actorEmail}) can no longer read this workflow.`);
    const denied = await simulation.canRun(actor);
    if (denied) return await skip(`The user who started this simulation (${job.actorEmail}) may no longer simulate this profile: ${denied}`);

    const candidate = { workflow: job.candidate.workflow, kind: job.candidate.kind, version: job.candidate.version };
    const request = { mcpMode: "strict" as const };
    const side = async (substitute: GuardProfileSubstitute | null, id: string, role: "baseline" | "candidate") => {
      const rows = simulation.destinationRows ? (role === "baseline" ? simulation.destinationRows.baseline : simulation.destinationRows.candidate) : undefined;
      const run: GuardSimulationRun = { id: simulation.id, substitute, sink: new GuardSimulationSink(), vault: simulation.vault, ...(rows ? { destinationRows: rows } : {}) };
      let replayed: SimulatedReplay;
      try {
        const response = await replay.replayCase({ recording, candidate, request, actor, executionId: id, models: "replay", overrides: null, role, simulation: run });
        const { facts: _facts, ...rest } = response;
        replayed = { status: response.status, error: response.verdict === "error" ? response.reasons.join(" ") || null : null, executionId: response.executionId, response: rest };
      } catch (error) {
        replayed = { status: "error", error: error instanceof Error ? error.message : String(error), executionId: null, response: null };
      }
      return { replay: replayed, checks: run.sink.checks };
    };
    const nodeNames = new Map(job.candidate.workflow.nodes.map((node) => [node.id, node.name] as const));
    const baseline = await side(simulation.baseSubstitute, executionId, "baseline");
    if (context?.canceled()) {
      return finish(await simulateCase({ recordingId, recording: meta, baseline, candidate: null, nodeNames, scrub: (text) => this.scrubText(text) }), 1);
    }
    const simulated = await side(simulation.substitute, context?.nextExecutionId() ?? randomUUID(), "candidate");
    return finish(await simulateCase({ recordingId, recording: meta, baseline, candidate: simulated, nodeNames, profileChanged: simulation.profileChanged, scrub: (text) => this.scrubText(text) }), 2);
  }

  private async runReplayCase(job: ReplayJobContext, runId: string, workflowId: string, spec: CaseSpec, executionId: string, context?: CaseRunContext): Promise<CaseOutcome> {
    const { fixture } = spec;
    const replay = this.options.replay!;
    if (!fixture.recordingId) {
      return { status: "skipped", error: "A hand-written case; replay jobs replay golden runs only. Run it with an eval run." };
    }
    const recordingId = fixture.recordingId;
    const recording = await replay.getRecording(recordingId);
    if (!recording) return { status: "error", recordingId, error: "The golden run for this case was deleted." };
    if (recording.workflowId !== workflowId) return { status: "error", recordingId, error: "The golden run for this case belongs to another workflow." };
    // Phase 15.6 — a captured run is not a golden run until a builder promotes it.
    const refusal = candidateRefusal(recording, { allowCandidates: job.allowCandidates });
    if (refusal) return { status: "error", recordingId, error: refusal };
    const actor = await replay.actorFor(job.actorUserId, job.actorEmail, workflowId, job.needsWrite ? "workflow:write" : "workflow:execute");
    if (!actor) {
      return {
        status: "error",
        recordingId,
        error: job.needsWrite
          ? `The user who started this job (${job.actorEmail}) can no longer edit this workflow (workflow:write), which a job with a workflow file or overrides needs for every case.`
          : `The user who started this job (${job.actorEmail}) can no longer run this workflow.`
      };
    }

    const repeats = Math.max(1, job.options.repeats ?? 1);
    const compareBaseline = job.options.compare === "baseline_rerun";
    const models = job.options.models ?? "live";
    const overrides = job.candidate.overrides ?? null;
    const request = {
      mcpMode: job.options.mcpMode,
      ...(job.options.ignorePaths ? { ignorePaths: job.options.ignorePaths } : {}),
      ...(job.options.numberTolerance !== undefined ? { numberTolerance: job.options.numberTolerance } : {})
    };
    let baselineCandidate: { workflow: Workflow; kind: CandidateKind; version: number | null } | null = null;
    if (compareBaseline) {
      try {
        const found = await replay.baselineFor!(recording);
        if (found.source === "captured" && capturedWorkflowIsRedacted(found.workflow)) {
          return {
            status: "error",
            recordingId,
            error:
              "The baseline rerun is inconclusive: this golden run has no saved version to rerun, and the workflow captured with it had credentials scrubbed out when it was saved, so it cannot be rerun as a fair baseline. Re-record this golden run from a saved version, or compare with the recording instead.",
            executions: 0
          };
        }
        baselineCandidate = found;
      } catch (error) {
        return { status: "error", recordingId, error: `No baseline to rerun: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    // The baseline runs under the same replay settings; only the candidate gets its guard profile (and its model overrides are in its workflow).
    const baselineOverrides = overrides && (overrides.mcpServers || overrides.liveReadNodes)
      ? { ...(overrides.mcpServers ? { mcpServers: overrides.mcpServers } : {}), ...(overrides.liveReadNodes ? { liveReadNodes: overrides.liveReadNodes } : {}) }
      : null;
    // Phase 15.3 — what each execution is expected to cost, reserved against the budget before it starts.
    const candidateEstimate = this.executionEstimate(recording, job.candidate.workflow, job.options).usd;
    const baselineEstimate = compareBaseline ? this.executionEstimate(recording, null, job.options).usd : 0;

    interface Attempt {
      record: ReplayCaseAttempt;
      outcome: CaseOutcome;
    }
    const attempts: Attempt[] = [];
    let executions = 0;
    let spentUsd = 0;
    let judgeTotal = 0;
    let costUnknown = false;
    let budgetStop: string | undefined;
    let replayedModelCalls = 0;
    let recordedCostUsd = 0;
    const spend = (usd: number | null | undefined, judge = false) => {
      if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) return;
      spentUsd = roundUsd(spentUsd + usd);
      context?.spend(usd, judge);
    };
    const tapeUsage = (response: ReplayRunResponse) => {
      if (!response.modelTape) return;
      replayedModelCalls += response.modelTape.replayedCalls;
      recordedCostUsd = roundUsd(recordedCostUsd + (response.modelTape.recordedUsage.costUsd ?? 0));
    };
    const stopReason = () =>
      `Stopped this case after ${attempts.length} of ${repeats} repeat${repeats === 1 ? "" : "s"} (${REPLAY_BUDGET_EXHAUSTED}): the job reached its $${context?.maxCostUsd} budget.`;
    const skipReason = (estimate: number) =>
      `Skipped the rest of this case after ${attempts.length} of ${repeats} repeat${repeats === 1 ? "" : "s"} (${REPLAY_BUDGET_EXHAUSTED}): its next execution could cost about $${estimate.toFixed(6)}, more than is left of the job's $${context?.maxCostUsd} budget.`;
    const nextId = () => (executions === 0 ? executionId : (context?.nextExecutionId() ?? randomUUID()));

    for (let repeatIndex = 0; repeatIndex < repeats; repeatIndex += 1) {
      if (executions > 0 && context) {
        if (context.canceled()) break;
        if (context.overBudget()) {
          budgetStop = stopReason();
          break;
        }
      }
      let baseline: { facts: RunFacts; executionId: string } | undefined;
      if (baselineCandidate) {
        if (context && !context.reserve(baselineEstimate)) {
          budgetStop = skipReason(baselineEstimate);
          break;
        }
        const baselineId = nextId();
        let baselineResponse: ReplayRunResponse;
        try {
          baselineResponse = await replay.replayCase({
            recording,
            candidate: baselineCandidate,
            request,
            actor,
            executionId: baselineId,
            models,
            overrides: baselineOverrides,
            role: "baseline",
            repeatIndex
          });
        } finally {
          context?.release(baselineEstimate);
        }
        executions += 1;
        spend(baselineResponse.facts.totals.costUsd);
        tapeUsage(baselineResponse);
        if (modelCostIsUnknown(baselineResponse.facts)) costUnknown = true;
        if (baselineResponse.verdict === "error") {
          const reason = `The baseline rerun was inconclusive: ${baselineResponse.reasons.join(" ") || "it could not be judged."}`;
          attempts.push({
            record: {
              repeatIndex,
              status: "error",
              executionId: null,
              baselineExecutionId: baselineResponse.executionId,
              verdict: "error",
              reasons: [reason],
              costUsd: baselineResponse.facts.totals.costUsd,
              // The candidate never ran in this repeat.
              latencyMs: null,
              newGuardBlocks: null
            },
            outcome: { status: "error", recordingId, error: reason, executionId: baselineResponse.executionId }
          });
          continue;
        }
        baseline = { facts: baselineResponse.facts, executionId: baselineResponse.executionId };
        if (context?.canceled()) break;
        if (context?.overBudget()) {
          budgetStop = stopReason();
          break;
        }
      }

      if (context && !context.reserve(candidateEstimate)) {
        budgetStop = skipReason(candidateEstimate);
        break;
      }
      let response: ReplayRunResponse;
      try {
        response = await replay.replayCase({
          recording,
          candidate: { workflow: job.candidate.workflow, kind: job.candidate.kind, version: job.candidate.version },
          request,
          actor,
          executionId: nextId(),
          models,
          overrides,
          ...(baseline ? { baseline } : {}),
          role: "candidate",
          repeatIndex
        });
      } finally {
        context?.release(candidateEstimate);
      }
      executions += 1;
      spend(response.facts.totals.costUsd);
      tapeUsage(response);
      const outcome = await this.scoreReplayAttempt(job, runId, workflowId, fixture, recording, response, baseline?.facts ?? null);
      spend(outcome.judgeCostUsd, true);
      judgeTotal = roundUsd(judgeTotal + (outcome.judgeCostUsd ?? 0));
      if (outcome.costUnknown) costUnknown = true;
      attempts.push({
        record: {
          repeatIndex,
          status: outcome.status as ReplayAttemptStatus,
          executionId: response.executionId,
          baselineExecutionId: baseline?.executionId ?? null,
          verdict: response.verdict,
          reasons: response.reasons,
          costUsd: outcome.costUsd ?? null,
          ...replayAttemptMetrics(response)
        },
        outcome
      });
    }

    const tape = replayedModelCalls > 0 ? { replayedModelCalls, recordedCostUsd } : {};
    if (attempts.length === 0) {
      return { status: "error", recordingId, error: budgetStop ?? "The job was canceled before this case ran.", costUsd: spentUsd, executions, ...tape, ...(budgetStop ? { budgetStop } : {}) };
    }
    const statuses = attempts.map((attempt) => attempt.record.status);
    const aggregate = job.options.aggregate ?? "all";
    // Fewer repeats than asked for (the budget, a cancel) never decide a case: it is inconclusive.
    const incomplete = attempts.length < repeats;
    const status: ReplayAttemptStatus = incomplete ? "error" : aggregateReplayAttempts(statuses, aggregate);
    const decisive = attempts.find((attempt) => attempt.record.status === status) ?? attempts[attempts.length - 1]!;
    const flaky = attempts.length > 1 && new Set(statuses).size > 1;
    const repeatCounts: ReplayCaseRepeats = {
      total: attempts.length,
      pass: statuses.filter((value) => value === "pass").length,
      fail: statuses.filter((value) => value === "fail").length,
      error: statuses.filter((value) => value === "error").length,
      aggregate,
      flaky
    };
    const several = repeats > 1 || compareBaseline;
    const diff: ReplayCaseDiff | undefined = decisive.outcome.diff
      ? {
          ...decisive.outcome.diff,
          ...(compareBaseline ? { compare: "baseline_rerun" as const, baselineExecutionId: decisive.record.baselineExecutionId } : {}),
          ...(several ? { attempts: attempts.map((attempt) => attempt.record) } : {})
        }
      : undefined;
    const incompleteReason = incomplete
      ? budgetStop ?? `Only ${attempts.length} of ${repeats} repeats ran (the job was canceled), so the case is inconclusive.`
      : undefined;
    const error = incompleteReason ?? (status === "error" ? decisive.outcome.error ?? "The replay was inconclusive." : budgetStop);
    return {
      ...decisive.outcome,
      status,
      ...(diff ? { diff } : {}),
      ...(error ? { error } : {}),
      costUsd: spentUsd,
      judgeCostUsd: judgeTotal,
      costUnknown,
      executions,
      ...tape,
      ...(several ? { repeats: repeatCounts } : {}),
      ...(flaky ? { flaky } : {}),
      ...(budgetStop ? { budgetStop } : {})
    };
  }

  /** One replay of a case, scored against the recording (or the baseline rerun it was compared with). */
  private async scoreReplayAttempt(
    job: ReplayJobContext,
    runId: string,
    workflowId: string,
    fixture: EvalFixtureRecord,
    recording: ReplayRecordingRecord,
    response: ReplayRunResponse,
    baselineFacts: RunFacts | null
  ): Promise<CaseOutcome> {
    const { facts, ...diff } = response;
    const reference = baselineFacts ?? recording.facts;
    const modelCost = facts.totals.costUsd;
    const tokens = { input: facts.totals.inputTokens, output: facts.totals.outputTokens, total: facts.totals.totalTokens };
    const base = {
      executionId: response.executionId,
      recordingId: recording.id,
      verdict: response.verdict,
      diff,
      output: facts.output,
      durationMs: facts.totals.durationMs ?? undefined,
      tokens
    };
    const modelCostUnknown = modelCostIsUnknown(facts);
    if (response.verdict === "error") {
      return { ...base, status: "error", error: response.reasons.join(" ") || "The replay was inconclusive.", costUsd: modelCost, judgeCostUsd: 0, costUnknown: modelCostUnknown };
    }
    const fallback: EvalScorerSpec[] = [
      { type: "status", expect: reference.status },
      { type: "json_equal", against: "baseline", ...(job.options.ignorePaths ? { ignorePaths: job.options.ignorePaths } : {}), ...(job.options.numberTolerance !== undefined ? { numberTolerance: job.options.numberTolerance } : {}) }
    ];
    const { score, judgeCostUsd, judgeCostUnknown } = await this.score(
      this.effectiveScorers(fixture, job.scorers, fallback),
      {
        output: facts.output,
        expected: fixture.expected ?? reference.output,
        fixtureInput: recording.input,
        baseline: reference,
        candidate: facts,
        maskedCapture: captureExpectsMasking(recording.capabilities?.capture),
        baselineUnverified: !baselineFacts && recording.capabilities?.origin === "imported",
        ...(this.options.random ? { random: this.options.random } : {})
      },
      { runId, workflowId, actorUserId: job.actorUserId, actorEmail: job.actorEmail, executionId: response.executionId }
    );
    return { ...base, status: score.pass ? "pass" : "fail", score, costUsd: roundUsd((modelCost ?? 0) + judgeCostUsd), judgeCostUsd, costUnknown: modelCostUnknown || judgeCostUnknown };
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  private view(run: EvalRunRecord): EvalRunView {
    return {
      id: run.id,
      kind: run.kind,
      datasetId: run.datasetId,
      datasetIds: run.datasetIds,
      workflowId: run.workflowId,
      workflowName: run.workflowName,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      triggeredBy: run.triggeredBy,
      summary: (run.summary as unknown as EvalRunSummary | null) ?? null,
      progress: (run.progress as unknown as EvalRunProgress | null) ?? null,
      candidate: (run.candidate as unknown as ReplayJobCandidate | null) ?? null,
      options: (run.options as unknown as ReplayJobOptions | null) ?? null,
      error: run.error
    };
  }

  private caseView(result: EvalResultRecord): EvalCaseResult {
    const score = asRecord(result.score);
    return {
      id: result.id,
      runId: result.runId,
      fixtureId: result.fixtureId,
      fixtureName: result.fixtureName,
      recordingId: result.recordingId,
      status: result.status,
      executionId: result.executionId,
      score: score ? { pass: Boolean(score.pass), details: Array.isArray(score.details) ? (score.details as EvalScoreDetail[]) : [] } : null,
      error: result.error,
      durationMs: result.durationMs,
      tokenInput: result.tokenInput,
      tokenOutput: result.tokenOutput,
      tokenTotal: result.tokenTotal,
      costUsd: result.costUsd,
      verdict: (result.verdict as EvalCaseResult["verdict"]) ?? null,
      ...(score?.repeats && typeof score.repeats === "object" ? { repeats: score.repeats as ReplayCaseRepeats } : {})
    };
  }
}

// Re-export internals for tests.
export const __test__ = __scorerTest__;

/** Whether scrubbing left a redaction marker in a workflow captured with a golden run (so it cannot be rerun faithfully). */
function capturedWorkflowIsRedacted(workflow: Workflow): boolean {
  return JSON.stringify(workflow).includes(CASSETTE_REDACTED);
}
