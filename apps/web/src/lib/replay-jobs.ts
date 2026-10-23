import {
  LLM_JUDGE_RUBRIC_MAX,
  LLM_JUDGE_VOTES_MAX,
  REPLAY_IGNORE_PATHS_MAX,
  type EvalRunView,
  type EvalScorerSpec,
  type LlmJudgeMode,
  type ReplayJobCandidate,
  type ReplayJobRequest,
  type ReplayMcpMode,
  type ToolSequenceMode
} from "@ai-orchestrator/shared";

/**
 * Phase 15.2 — pure helpers behind the Evaluations page: turning the
 * "Run replay" dialog into a ReplayJobRequest, and the labels the golden-set
 * and replay-job views share.
 */

export interface ReplayJobScorerForm {
  status: boolean;
  jsonEqual: boolean;
  textSimilarity: { enabled: boolean; threshold: string };
  toolSequence: { enabled: boolean; mode: ToolSequenceMode };
  noNewGuardBlocks: boolean;
  budget: { enabled: boolean; maxCostUsd: string; maxTokens: string; maxLatencyMs: string };
  llmJudge: { enabled: boolean; rubric: string; mode: LlmJudgeMode; votes: string; threshold: string; providerId: string; model: string; secretId: string };
}

export interface ReplayJobForm {
  candidate: "draft" | number;
  mcpMode: ReplayMcpMode;
  /** One path per line. */
  ignorePaths: string;
  numberTolerance: string;
  maxCostUsd: string;
  scorers: ReplayJobScorerForm;
}

export function emptyReplayJobForm(): ReplayJobForm {
  return {
    candidate: "draft",
    mcpMode: "strict",
    ignorePaths: "",
    numberTolerance: "",
    maxCostUsd: "",
    scorers: {
      status: false,
      jsonEqual: false,
      textSimilarity: { enabled: false, threshold: "0.8" },
      toolSequence: { enabled: false, mode: "exact" },
      noNewGuardBlocks: false,
      budget: { enabled: false, maxCostUsd: "", maxTokens: "", maxLatencyMs: "" },
      llmJudge: { enabled: false, rubric: "", mode: "absolute", votes: "1", threshold: "", providerId: "", model: "", secretId: "" }
    }
  };
}

export type ReplayJobFormResult = { ok: true; request: ReplayJobRequest } | { ok: false; error: string };

export function parseIgnorePaths(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

type NumberCheck = { ok: true; value: number | undefined } | { ok: false; error: string };

function optionalNumber(raw: string, label: string, options: { min?: number; max?: number; integer?: boolean; positive?: boolean } = {}): NumberCheck {
  const text = raw.trim();
  if (!text) return { ok: true, value: undefined };
  const value = Number(text);
  if (!Number.isFinite(value)) return { ok: false, error: `${label} must be a number.` };
  if (options.integer && !Number.isInteger(value)) return { ok: false, error: `${label} must be a whole number.` };
  if (options.positive && value <= 0) return { ok: false, error: `${label} must be more than 0.` };
  if (options.min !== undefined && value < options.min) return { ok: false, error: `${label} must be at least ${options.min}.` };
  if (options.max !== undefined && value > options.max) return { ok: false, error: `${label} must be at most ${options.max}.` };
  return { ok: true, value };
}

/** The scorers the dialog picked, in a stable order; an empty list means the server default. */
export function scorersFromForm(form: ReplayJobForm): { ok: true; scorers: EvalScorerSpec[] } | { ok: false; error: string } {
  const picked = form.scorers;
  const scorers: EvalScorerSpec[] = [];
  const ignorePaths = parseIgnorePaths(form.ignorePaths);
  const tolerance = optionalNumber(form.numberTolerance, "Number tolerance", { min: 0 });
  if (!tolerance.ok) return tolerance;

  if (picked.status) scorers.push({ type: "status" });
  if (picked.jsonEqual) {
    scorers.push({
      type: "json_equal",
      against: "baseline",
      ...(ignorePaths.length > 0 ? { ignorePaths } : {}),
      ...(tolerance.value !== undefined ? { numberTolerance: tolerance.value } : {})
    });
  }
  if (picked.textSimilarity.enabled) {
    const threshold = optionalNumber(picked.textSimilarity.threshold, "Text similarity threshold", { min: 0, max: 1 });
    if (!threshold.ok) return threshold;
    scorers.push({ type: "text_similarity", against: "baseline", ...(threshold.value !== undefined ? { threshold: threshold.value } : {}) });
  }
  if (picked.toolSequence.enabled) scorers.push({ type: "tool_sequence", mode: picked.toolSequence.mode });
  if (picked.noNewGuardBlocks) scorers.push({ type: "no_new_guard_blocks" });
  if (picked.budget.enabled) {
    const cost = optionalNumber(picked.budget.maxCostUsd, "Budget max cost", { min: 0 });
    if (!cost.ok) return cost;
    const tokens = optionalNumber(picked.budget.maxTokens, "Budget max tokens", { min: 0, integer: true });
    if (!tokens.ok) return tokens;
    const latency = optionalNumber(picked.budget.maxLatencyMs, "Budget max latency", { min: 0, integer: true });
    if (!latency.ok) return latency;
    if (cost.value === undefined && tokens.value === undefined && latency.value === undefined) {
      return { ok: false, error: "The budget scorer needs at least one limit." };
    }
    scorers.push({
      type: "budget",
      ...(cost.value !== undefined ? { maxCostUsd: cost.value } : {}),
      ...(tokens.value !== undefined ? { maxTokens: tokens.value } : {}),
      ...(latency.value !== undefined ? { maxLatencyMs: latency.value } : {})
    });
  }
  if (picked.llmJudge.enabled) {
    const judge = picked.llmJudge;
    const rubric = judge.rubric.trim();
    if (!rubric) return { ok: false, error: "The LLM judge needs a rubric." };
    if (rubric.length > LLM_JUDGE_RUBRIC_MAX) return { ok: false, error: `The rubric must be at most ${LLM_JUDGE_RUBRIC_MAX} characters.` };
    const votes = optionalNumber(judge.votes, "Judge votes", { min: 1, max: LLM_JUDGE_VOTES_MAX, integer: true });
    if (!votes.ok) return votes;
    const threshold = optionalNumber(judge.threshold, "Judge threshold", { min: 0, max: 1 });
    if (!threshold.ok) return threshold;
    scorers.push({
      type: "llm_judge",
      rubric,
      mode: judge.mode,
      ...(votes.value !== undefined ? { votes: votes.value } : {}),
      ...(threshold.value !== undefined ? { threshold: threshold.value } : {}),
      ...(judge.providerId.trim() ? { providerId: judge.providerId.trim() } : {}),
      ...(judge.model.trim() ? { model: judge.model.trim() } : {}),
      // Credentials by reference only; the server resolves them through the secret store.
      ...(judge.secretId ? { secretRef: { secretId: judge.secretId } } : {})
    });
  }
  return { ok: true, scorers };
}

export function buildReplayJobRequest(datasetIds: string[], form: ReplayJobForm): ReplayJobFormResult {
  if (datasetIds.length === 0) return { ok: false, error: "Pick a golden set." };
  const ignorePaths = parseIgnorePaths(form.ignorePaths);
  if (ignorePaths.length > REPLAY_IGNORE_PATHS_MAX) return { ok: false, error: `At most ${REPLAY_IGNORE_PATHS_MAX} ignore paths.` };
  const tolerance = optionalNumber(form.numberTolerance, "Number tolerance", { min: 0 });
  if (!tolerance.ok) return tolerance;
  const maxCost = optionalNumber(form.maxCostUsd, "Max cost", { positive: true, max: 100_000 });
  if (!maxCost.ok) return maxCost;
  const scorers = scorersFromForm(form);
  if (!scorers.ok) return scorers;
  const request: ReplayJobRequest = {
    datasetIds,
    ...(form.candidate === "draft" ? { draft: true } : { version: form.candidate }),
    mcpMode: form.mcpMode,
    ...(ignorePaths.length > 0 ? { ignorePaths } : {}),
    ...(tolerance.value !== undefined ? { numberTolerance: tolerance.value } : {}),
    ...(maxCost.value !== undefined ? { maxCostUsd: maxCost.value } : {}),
    ...(scorers.scorers.length > 0 ? { scorers: scorers.scorers } : {})
  };
  return { ok: true, request };
}

/** `draft` or `v3`. */
export function candidateLabel(candidate: ReplayJobCandidate | null): string {
  if (!candidate) return "—";
  return candidate.kind === "version" && candidate.version !== null ? `v${candidate.version}` : "draft";
}

export function shortHash(hash: string | null | undefined, length = 8): string {
  if (!hash) return "";
  return hash.replace(/^sha256:/, "").slice(0, length);
}

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} m ${Math.round((ms % 60_000) / 1000)} s`;
}

/** The `.status-pill` tone for a run or case status. */
export function statusTone(status: string): "success" | "error" | "partial" | "running" | "skipped" {
  switch (status) {
    case "pass":
    case "completed":
      return "success";
    case "fail":
    case "failed":
    case "errored":
      return "error";
    case "error":
    case "interrupted":
      return "partial";
    case "queued":
    case "running":
      return "running";
    default:
      return "skipped";
  }
}

/** How a case status reads in a chip: an `error` case is inconclusive, not a regression. */
export function caseStatusLabel(status: string): string {
  return status === "error" ? "inconclusive" : status;
}

export interface JobCounts {
  pass: number;
  fail: number;
  error: number;
  skipped: number;
  total: number;
  done: number;
  running: number;
  spentUsd: number | null;
}

/** Counts for a job from its summary when finished, else from its live progress. */
export function jobCounts(run: Pick<EvalRunView, "summary" | "progress">): JobCounts {
  if (run.summary) {
    return {
      pass: run.summary.pass,
      fail: run.summary.fail,
      error: run.summary.error,
      skipped: run.summary.skipped ?? 0,
      total: run.summary.total,
      done: run.summary.total,
      running: 0,
      spentUsd: run.summary.costUsd ?? run.progress?.spentUsd ?? null
    };
  }
  const progress = run.progress;
  return {
    pass: progress?.pass ?? 0,
    fail: progress?.fail ?? 0,
    error: progress?.error ?? 0,
    skipped: progress?.skipped ?? 0,
    total: progress?.total ?? 0,
    done: progress?.done ?? 0,
    running: progress?.running ?? 0,
    spentUsd: progress?.spentUsd ?? null
  };
}
