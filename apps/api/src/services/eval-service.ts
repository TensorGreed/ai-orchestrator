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
 */

import { randomUUID } from "node:crypto";
import {
  EVAL_JUDGE_CALLS_PER_CASE_MAX,
  EVAL_RUN_FINISHED_STATUSES,
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
import type { EvalFixtureRecord, EvalResultRecord, EvalRunRecord, ReplayRecordingRecord, SqliteStore } from "../db/database.js";
import type { SafeUser } from "./auth-service.js";
import { applyScorer, judgeCallsFor, __scorerTest__, type EvalJudgeContext, type EvalLlmJudge } from "./eval-scorers.js";

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
  triggeredBy?: string;
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
    triggeredBy?: string;
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

/** Phase 15.2 — what a replay job needs from the replay machinery (15.1). */
export interface EvalReplayDeps {
  /** The candidate, resolved once when the job is created so every case runs the same workflow. */
  resolveCandidate: (workflowId: string, request: { draft?: boolean; version?: number }) => { workflow: Workflow; kind: "draft" | "version"; version: number | null; workflowHash: string };
  getRecording: (id: string) => ReplayRecordingRecord | null;
  /** Replays one golden run against the candidate in the replay sandbox, as `actor`, with this execution id. */
  replayCase: (input: {
    recording: ReplayRecordingRecord;
    candidate: { workflow: Workflow; kind: "draft" | "version"; version: number | null };
    request: { mcpMode?: McpReplayMode; ignorePaths?: string[]; numberTolerance?: number };
    actor: SafeUser;
    executionId: string;
  }) => Promise<ReplayRunResponse>;
  /**
   * The user a job runs as (tool policy subject and project scope), looked up
   * again for every case; null when they can no longer run the workflow.
   */
  actorFor: (email: string, workflowId: string) => SafeUser | null;
}

export interface EvalServiceOptions {
  /** Cases running at once across all runs of this process. Default 2. */
  concurrency?: number;
  /** Most cases one run may have. Default 200. */
  maxCases?: number;
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
  scrub?: (text: string) => string;
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
    readonly code: "not_found" | "invalid" | "limit"
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
}

interface CaseSpec {
  fixture: EvalFixtureRecord;
  /** The worst-case judge spend reserved before the case starts, and whether a judge model has no price. */
  reserveUsd: number;
  reserveUnknown: boolean;
}

const UNPRICED_WARNING = "Some model or judge calls have no price in the price table: the spend shown leaves them out, and the budget cannot stop on them.";

interface ReplayJobContext {
  actorEmail: string;
  candidate: { workflow: Workflow; kind: "draft" | "version"; version: number | null; workflowHash: string };
  options: ReplayJobOptions;
  scorers: EvalScorerSpec[] | null;
}

/** First-in, first-out slots shared by every run. */
class Slots {
  private free: number;
  private readonly waiting: Array<() => void> = [];

  constructor(size: number) {
    this.free = Math.max(1, Math.floor(size));
  }

  acquire(): Promise<void> {
    if (this.free > 0) {
      this.free -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.free += 1;
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

function isTruncation(value: unknown): value is EvalStoredTruncation {
  return Boolean(value && typeof value === "object" && (value as { truncated?: unknown }).truncated === true && typeof (value as { bytes?: unknown }).bytes === "number");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export class EvalService {
  private readonly slots: Slots;
  private readonly active = new Map<string, ActiveRun>();
  private readonly options: Required<Pick<EvalServiceOptions, "maxCases" | "defaultMaxCostUsd" | "evalRunMaxCostUsd" | "maxResultBytes" | "heartbeatMs">> & EvalServiceOptions;

  constructor(
    private readonly store: SqliteStore,
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
    this.slots = new Slots(options.concurrency ?? 2);
  }

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  // ---------------------------------------------------------------------------
  // Datasets and golden sets
  // ---------------------------------------------------------------------------

  createDataset(input: { name: string; description?: string; projectId?: string; workflowId?: string; createdBy?: string }) {
    const id = `ds_${randomUUID()}`;
    this.store.createEvalDataset({ id, ...input });
    return this.store.getEvalDataset(id);
  }

  listDatasets(options: { projectId?: string; workflowId?: string } = {}) {
    return this.store.listEvalDatasets(options);
  }

  getDataset(id: string) {
    return this.store.getEvalDataset(id);
  }

  deleteDataset(id: string): boolean {
    for (let page = 0; page < 100; page += 1) {
      const live = this.store.listEvalRuns({ datasetId: id, statuses: ["queued", "running"], limit: 500 });
      for (const run of live) this.cancel(run.id);
      if (live.length < 500) break;
    }
    return this.store.deleteEvalDataset(id);
  }

  // ---------------------------------------------------------------------------
  // Fixtures
  // ---------------------------------------------------------------------------

  addFixture(input: { datasetId: string; name: string; input: unknown; expected?: unknown; scorers?: ScorerSpec[]; recordingId?: string }) {
    const id = `fix_${randomUUID()}`;
    this.store.createEvalFixture({
      id,
      datasetId: input.datasetId,
      name: input.name,
      input: input.input,
      expected: input.expected,
      scorers: input.scorers as Array<Record<string, unknown>> | undefined,
      ...(input.recordingId ? { recordingId: input.recordingId } : {})
    });
    return this.store.getEvalFixture(id);
  }

  /**
   * Phase 15.2 — a golden run becomes a case of a golden set: its recorded
   * input is the case input, and its recorded output is the expected value
   * (read from the golden run when the case runs, so it is not copied).
   */
  addGoldenRun(input: { datasetId: string; recording: ReplayRecordingRecord; name?: string; scorers?: ScorerSpec[] }) {
    return this.addFixture({
      datasetId: input.datasetId,
      name: input.name ?? input.recording.name,
      input: input.recording.input ?? null,
      scorers: input.scorers,
      recordingId: input.recording.id
    });
  }

  listFixtures(datasetId: string) {
    return this.store.listEvalFixtures(datasetId);
  }

  getFixture(id: string) {
    return this.store.getEvalFixture(id);
  }

  deleteFixture(id: string): boolean {
    return this.store.deleteEvalFixture(id);
  }

  // ---------------------------------------------------------------------------
  // Runs
  // ---------------------------------------------------------------------------

  /** Creates an eval run and queues it; the run executes in the background. */
  enqueueRun(request: EvalRunRequest): EvalRunView {
    const dataset = this.store.getEvalDataset(request.datasetId);
    if (!dataset) throw new EvalRunError(`Eval dataset not found: ${request.datasetId}`, "not_found");
    const fixtures = this.store.listEvalFixtures(request.datasetId);
    if (fixtures.length === 0) throw new EvalRunError(`Dataset ${request.datasetId} has no fixtures`, "invalid");
    if (fixtures.length > this.options.maxCases) throw new EvalRunError(`Dataset ${request.datasetId} has ${fixtures.length} fixtures; a run can have at most ${this.options.maxCases} (REPLAY_JOB_MAX_CASES).`, "limit");
    if (dataset.workflowId && dataset.workflowId !== request.workflowId) throw new EvalRunError("This golden set belongs to another workflow.", "invalid");
    if (fixtures.every((fixture) => fixture.recordingId)) throw new EvalRunError("This golden set holds only golden runs: run it as a replay job, which replays them without side effects.", "invalid");
    const workflow = this.store.getWorkflow(request.workflowId);

    const runId = `run_${randomUUID()}`;
    const progress = this.initialProgress(fixtures.length);
    this.store.createEvalRun({
      id: runId,
      kind: "eval",
      status: "queued",
      datasetId: request.datasetId,
      workflowId: request.workflowId,
      ...(workflow?.name ? { workflowName: workflow.name } : {}),
      triggeredBy: request.triggeredBy,
      scorers: request.scorers as Array<Record<string, unknown>> | undefined,
      progress: progress as unknown as Record<string, unknown>
    });
    const cases = fixtures.map((fixture) => this.caseSpec(fixture, request.scorers));
    this.launch(runId, cases, (spec, executionId) => this.runEvalCase(request, runId, spec, executionId), { maxCostUsd: this.options.evalRunMaxCostUsd });
    return this.view(this.store.getEvalRun(runId)!);
  }

  /**
   * Runs every fixture of a dataset against the workflow and returns once
   * the run finished (the pre-15.2 behaviour, behind `?wait=true`).
   */
  async startRun(request: EvalRunRequest): Promise<{ runId: string; summary: EvalRunSummary }> {
    const run = this.enqueueRun(request);
    await this.wait(run.id);
    const finished = this.store.getEvalRun(run.id);
    return { runId: run.id, summary: (finished?.summary as unknown as EvalRunSummary) ?? emptySummary(0) };
  }

  /**
   * Phase 15.2 — a replay job: every golden run in the sets, replayed against
   * one candidate and scored. The sets must belong to `workflowId`.
   */
  enqueueReplayJob(request: ReplayJobRequest, context: { workflowId: string; actor: SafeUser }): EvalRunView {
    const replay = this.options.replay;
    if (!replay) throw new EvalRunError("Replay jobs are not available on this server.", "invalid");
    const datasetIds = [...new Set(request.datasetIds)];
    const fixtures: EvalFixtureRecord[] = [];
    for (const datasetId of datasetIds) {
      const dataset = this.store.getEvalDataset(datasetId);
      if (!dataset) throw new EvalRunError(`Golden set not found: ${datasetId}`, "not_found");
      if (dataset.workflowId !== context.workflowId) throw new EvalRunError(`Golden set ${datasetId} does not belong to this workflow.`, "invalid");
      fixtures.push(...this.store.listEvalFixtures(datasetId));
    }
    if (!fixtures.some((fixture) => fixture.recordingId)) throw new EvalRunError("These golden sets hold no golden runs to replay.", "invalid");
    if (fixtures.length > this.options.maxCases) throw new EvalRunError(`These golden sets hold ${fixtures.length} cases; a replay job can have at most ${this.options.maxCases} (REPLAY_JOB_MAX_CASES).`, "limit");

    let candidate: ReplayJobContext["candidate"];
    try {
      candidate = replay.resolveCandidate(context.workflowId, { ...(request.draft !== undefined ? { draft: request.draft } : {}), ...(request.version !== undefined ? { version: request.version } : {}) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new EvalRunError(message, /not found|no longer exists/i.test(message) ? "not_found" : "invalid");
    }
    const options: ReplayJobOptions = {
      mcpMode: request.mcpMode ?? "strict",
      ...(request.ignorePaths && request.ignorePaths.length > 0 ? { ignorePaths: request.ignorePaths } : {}),
      ...(request.numberTolerance !== undefined ? { numberTolerance: request.numberTolerance } : {}),
      maxCostUsd: request.maxCostUsd ?? this.options.defaultMaxCostUsd
    };
    const jobCandidate: ReplayJobCandidate = { kind: candidate.kind, version: candidate.version, workflowHash: candidate.workflowHash };
    const runId = `run_${randomUUID()}`;
    const progress = this.initialProgress(fixtures.length);
    this.store.createEvalRun({
      id: runId,
      kind: "replay",
      status: "queued",
      datasetId: datasetIds[0]!,
      datasetIds,
      workflowId: context.workflowId,
      workflowName: candidate.workflow.name,
      triggeredBy: context.actor.email,
      scorers: request.scorers as Array<Record<string, unknown>> | undefined,
      candidate: jobCandidate as unknown as Record<string, unknown>,
      workflowHash: candidate.workflowHash,
      workflowVersion: candidate.version,
      options: options as unknown as Record<string, unknown>,
      progress: progress as unknown as Record<string, unknown>
    });
    const job: ReplayJobContext = { actorEmail: context.actor.email, candidate, options, scorers: request.scorers && request.scorers.length > 0 ? request.scorers : null };
    this.launch(
      runId,
      fixtures.map((fixture) => this.caseSpec(fixture, job.scorers)),
      (spec, executionId) => this.runReplayCase(job, runId, context.workflowId, spec, executionId),
      { maxCostUsd: options.maxCostUsd }
    );
    return this.view(this.store.getEvalRun(runId)!);
  }

  /** Resolves when the run has finished (immediately for a run this process is not running). */
  async wait(runId: string): Promise<void> {
    await this.active.get(runId)?.done;
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
  cancel(runId: string): EvalRunView | null {
    const record = this.store.getEvalRun(runId);
    if (!record) return null;
    if (EVAL_RUN_FINISHED_STATUSES.has(record.status)) return this.view(record);
    const active = this.active.get(runId);
    if (active) {
      active.canceled = true;
      for (const executionId of active.inFlight) this.options.abortExecution?.(executionId, "The eval run was canceled.");
      this.wake(active);
    }
    const progress = active ? { ...active.progress, updatedAt: this.now().toISOString() } : (record.progress as unknown as EvalRunProgress | null);
    this.store.finalizeEvalRun({
      id: runId,
      status: "canceled",
      ...(active ? { summary: this.finishSummary(active) as unknown as Record<string, unknown> } : {}),
      ...(progress ? { progress: progress as unknown as Record<string, unknown> } : {}),
      error: "Canceled",
      onlyFrom: ["queued", "running"]
    });
    const view = this.view(this.store.getEvalRun(runId)!);
    if (active) this.emit(active, view, false);
    return view;
  }

  /**
   * The server is stopping: every run this process is executing stops
   * scheduling cases, its running executions are aborted, and it is marked
   * `interrupted` (cases that finish afterwards are still recorded if the
   * store is open).
   */
  shutdown(): void {
    for (const active of this.active.values()) {
      if (active.canceled) continue;
      active.canceled = true;
      for (const executionId of active.inFlight) this.options.abortExecution?.(executionId, "The server is stopping.");
      this.wake(active);
      this.safely(() => {
        this.store.finalizeEvalRun({
          id: active.runId,
          status: "interrupted",
          summary: this.finishSummary(active) as unknown as Record<string, unknown>,
          progress: { ...active.progress, updatedAt: this.now().toISOString() } as unknown as Record<string, unknown>,
          error: "The server stopped before this run finished.",
          onlyFrom: ["queued", "running"]
        });
      });
    }
  }

  /**
   * Marks runs a stopped server left queued or running as `interrupted`. In
   * a single-instance deployment that is every such run; with `onlyStale`
   * (several instances share the database) only runs whose progress has not
   * been written for `EVAL_RUN_STALE_MS`, so runs another live instance is
   * executing are left alone.
   */
  recoverInterrupted(options: { onlyStale?: boolean } = {}): number {
    let count = 0;
    // Runs left alone stay in the list, so the next page starts after them.
    let kept = 0;
    const nowMs = this.now().getTime();
    for (;;) {
      const page = this.store.listEvalRuns({ statuses: ["queued", "running"], limit: 500, offset: kept });
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
        if (this.store.finalizeEvalRun({ id: run.id, status: "interrupted", error: "The server stopped before this run finished.", onlyFrom: ["queued", "running"] })) count += 1;
        else kept += 1;
      }
      if (page.length < 500) break;
    }
    return count;
  }

  listRuns(options: { datasetId?: string; workflowId?: string; workflowIds?: string[]; kind?: "eval" | "replay"; limit?: number } = {}): EvalRunView[] {
    return this.store.listEvalRuns(options).map((run) => this.view(run));
  }

  getRun(id: string): (EvalRunView & { results: Array<EvalCaseResult & { output: unknown }> }) | null {
    const run = this.store.getEvalRun(id);
    if (!run) return null;
    const results = this.store.listEvalResults(id).map((result) => ({ ...this.caseView(result), output: result.output }));
    return { ...this.view(run), results };
  }

  getRunView(id: string): EvalRunView | null {
    const run = this.store.getEvalRun(id);
    return run ? this.view(run) : null;
  }

  getCase(runId: string, resultId: string): EvalCaseDetail | null {
    const result = this.store.getEvalResult(runId, resultId);
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
  private caseSpec(fixture: EvalFixtureRecord, runScorers: EvalScorerSpec[] | null | undefined): CaseSpec {
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
    return { fixture, reserveUsd: roundUsd(reserveUsd), reserveUnknown };
  }

  private launch(runId: string, cases: CaseSpec[], runCase: (spec: CaseSpec, executionId: string) => Promise<CaseOutcome>, limits: { maxCostUsd?: number } = {}): void {
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const record = this.store.getEvalRun(runId)!;
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
      warnings: new Set()
    };
    this.active.set(runId, active);
    this.execute(active, cases, runCase, limits)
      .catch((error) => {
        this.options.logger?.warn("Eval run failed", { runId, error: error instanceof Error ? error.message : String(error) });
        this.safely(() => {
          this.store.finalizeEvalRun({
            id: runId,
            status: "failed",
            summary: this.finishSummary(active) as unknown as Record<string, unknown>,
            error: `The run stopped on an internal error: ${error instanceof Error ? error.message : String(error)}`,
            onlyFrom: ["queued", "running"]
          });
        });
      })
      .finally(() => {
        this.active.delete(runId);
        this.wake(active);
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

  private async execute(active: ActiveRun, cases: CaseSpec[], runCase: (spec: CaseSpec, executionId: string) => Promise<CaseOutcome>, limits: { maxCostUsd?: number }): Promise<void> {
    const heartbeat = setInterval(() => {
      if (active.canceled) return;
      active.progress = { ...active.progress, updatedAt: this.now().toISOString() };
      this.safely(() => this.store.updateEvalRunProgress({ id: active.runId, progress: active.progress as unknown as Record<string, unknown> }));
    }, this.options.heartbeatMs);
    heartbeat.unref?.();
    const running: Array<Promise<void>> = [];
    let started = false;
    let budgetStop: string | null = null;
    // Judge spend reserved by the cases in flight.
    let reserved = 0;
    try {
      for (const spec of cases) {
        await this.slots.acquire();
        const max = limits.maxCostUsd;
        if (max !== undefined) {
          // Wait for cases in flight to give back their reservations while this one does not fit.
          while (!active.canceled && reserved > 0 && active.progress.spentUsd + reserved + spec.reserveUsd > max) await this.nextCaseDone(active);
        }
        if (active.canceled) {
          this.slots.release();
          break;
        }
        if (max !== undefined) {
          const spent = active.progress.spentUsd;
          if (spent >= max) {
            budgetStop = `Stopped after ${active.progress.done} of ${cases.length} cases: the run spent $${spent.toFixed(4)} of its $${max} budget.`;
          } else if (spent + spec.reserveUsd > max) {
            budgetStop = `Stopped after ${active.progress.done} of ${cases.length} cases: the next case's judge calls could cost up to $${spec.reserveUsd.toFixed(4)}, more than the $${(max - spent).toFixed(4)} left of the run's $${max} budget.`;
          }
          if (budgetStop) {
            this.slots.release();
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
          this.safely(() => this.store.updateEvalRunProgress({ id: active.runId, status: "running", progress: active.progress as unknown as Record<string, unknown> }));
        }
        const executionId = randomUUID();
        active.inFlight.add(executionId);
        active.progress = { ...active.progress, running: active.progress.running + 1 };
        reserved = roundUsd(reserved + spec.reserveUsd);
        running.push(
          (async () => {
            let outcome: CaseOutcome;
            try {
              outcome = await runCase(spec, executionId);
            } catch (error) {
              outcome = { status: "error", error: error instanceof Error ? error.message : String(error), ...(spec.fixture.recordingId ? { recordingId: spec.fixture.recordingId } : {}) };
            } finally {
              active.inFlight.delete(executionId);
              this.slots.release();
            }
            reserved = Math.max(0, roundUsd(reserved - spec.reserveUsd));
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
    const summary = this.finishSummary(active);
    const progress = { ...active.progress, running: 0, updatedAt: this.now().toISOString() };
    active.progress = progress;
    if (active.canceled) {
      // The run is already `canceled`; keep its summary current with the cases that finished after the cancel.
      this.safely(() => this.store.updateEvalRunSummary(active.runId, summary as unknown as Record<string, unknown>, progress as unknown as Record<string, unknown>));
    } else {
      this.safely(() =>
        this.store.finalizeEvalRun({
          id: active.runId,
          status: budgetStop ? "failed" : "completed",
          summary: summary as unknown as Record<string, unknown>,
          progress: progress as unknown as Record<string, unknown>,
          ...(budgetStop ? { error: budgetStop } : {}),
          onlyFrom: ["queued", "running"]
        })
      );
    }
    this.safely(() => {
      const record = this.store.getEvalRun(active.runId);
      if (record) this.emit(active, this.view(record), true);
    });
  }

  private safely(write: () => void): void {
    try {
      write();
    } catch (error) {
      this.options.logger?.warn("Eval run bookkeeping failed", { error: error instanceof Error ? error.message : String(error) });
    }
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

  private scrubText(text: string): string {
    if (!this.options.scrub) return text;
    try {
      return this.options.scrub(text);
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

    const error = outcome.error ? this.scrubText(outcome.error) : undefined;
    const score = outcome.score ? { pass: outcome.score.pass, details: outcome.score.details.map((detail) => ({ ...detail, reason: this.scrubText(detail.reason) })) } : undefined;
    this.safely(() => {
      // The run was deleted with its golden set while this case ran: store nothing.
      if (!this.store.getEvalRun(active.runId)) return;
      this.store.recordEvalResult({
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
      this.safely(() => this.store.updateEvalRunProgress({ id: active.runId, progress: active.progress as unknown as Record<string, unknown> }));
    }
    this.safely(() => {
      const record = this.store.getEvalRun(active.runId);
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
      { runId, workflowId: request.workflowId, actorEmail: request.triggeredBy ?? null, ...(exec.executionId ? { executionId: exec.executionId } : {}) }
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

  private async runReplayCase(job: ReplayJobContext, runId: string, workflowId: string, spec: CaseSpec, executionId: string): Promise<CaseOutcome> {
    const { fixture } = spec;
    const replay = this.options.replay!;
    if (!fixture.recordingId) {
      return { status: "skipped", error: "A hand-written case; replay jobs replay golden runs only. Run it with an eval run." };
    }
    const recordingId = fixture.recordingId;
    const recording = replay.getRecording(recordingId);
    if (!recording) return { status: "error", recordingId, error: "The golden run for this case was deleted." };
    if (recording.workflowId !== workflowId) return { status: "error", recordingId, error: "The golden run for this case belongs to another workflow." };
    const actor = replay.actorFor(job.actorEmail, workflowId);
    if (!actor) return { status: "error", recordingId, error: `The user who started this job (${job.actorEmail}) can no longer run this workflow.` };

    const response = await replay.replayCase({
      recording,
      candidate: { workflow: job.candidate.workflow, kind: job.candidate.kind, version: job.candidate.version },
      request: { mcpMode: job.options.mcpMode, ...(job.options.ignorePaths ? { ignorePaths: job.options.ignorePaths } : {}), ...(job.options.numberTolerance !== undefined ? { numberTolerance: job.options.numberTolerance } : {}) },
      actor,
      executionId
    });
    const { facts, ...diff } = response;
    const modelCost = facts.totals.costUsd;
    const tokens = { input: facts.totals.inputTokens, output: facts.totals.outputTokens, total: facts.totals.totalTokens };
    const base = {
      executionId: response.executionId,
      recordingId,
      verdict: response.verdict,
      diff,
      output: facts.output,
      durationMs: facts.totals.durationMs ?? undefined,
      tokens
    };
    const modelCostUnknown = modelCostIsUnknown(facts);
    if (response.verdict === "error") {
      return { ...base, status: "error", error: response.reasons.join(" ") || "The replay was inconclusive.", costUsd: modelCost, costUnknown: modelCostUnknown };
    }
    const fallback: EvalScorerSpec[] = [
      { type: "status", expect: recording.facts.status },
      { type: "json_equal", against: "baseline", ...(job.options.ignorePaths ? { ignorePaths: job.options.ignorePaths } : {}), ...(job.options.numberTolerance !== undefined ? { numberTolerance: job.options.numberTolerance } : {}) }
    ];
    const { score, judgeCostUsd, judgeCostUnknown } = await this.score(
      this.effectiveScorers(fixture, job.scorers, fallback),
      {
        output: facts.output,
        expected: fixture.expected ?? recording.facts.output,
        fixtureInput: recording.input,
        baseline: recording.facts,
        candidate: facts,
        ...(this.options.random ? { random: this.options.random } : {})
      },
      { runId, workflowId, actorEmail: job.actorEmail, executionId: response.executionId }
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
      verdict: (result.verdict as EvalCaseResult["verdict"]) ?? null
    };
  }
}

// Re-export internals for tests.
export const __test__ = __scorerTest__;
