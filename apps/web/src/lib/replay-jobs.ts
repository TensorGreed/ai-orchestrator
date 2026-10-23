import {
  effectiveModelFor,
  LLM_JUDGE_RUBRIC_MAX,
  LLM_JUDGE_VOTES_MAX,
  REPLAY_IGNORE_PATHS_MAX,
  REPLAY_REPEATS_MAX,
  replayLiveReadRefusal,
  type EvalRunView,
  type ReplayAggregateRule,
  type ReplayCandidateOverrides,
  type ReplayCompareMode,
  type ReplayJobOptions,
  type ReplayModelMode,
  type ReplayServerMode,
  type Workflow,
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
 *
 * Phase 15.3 — the candidate can be a workflow file, with overrides (models
 * per node or provider, a guard profile, MCP modes per server, read nodes
 * that run live), model calls live or from the golden runs' tapes, a
 * baseline rerun and repeats.
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

export interface ReplayModelOverrideRow {
  /** Empty: every node of `provider`. */
  nodeId: string;
  provider: string;
  model: string;
  /** The secret an LLM Call node uses after a provider switch (by reference; required when the node has its own key or base URL). */
  secretId?: string;
}

export interface ReplayCandidateFile {
  name: string;
  workflow: Record<string, unknown>;
}

export interface ReplayJobForm {
  /** The draft, a saved version, or the uploaded workflow file. */
  candidate: "draft" | number | "file";
  candidateFile: ReplayCandidateFile | null;
  modelOverrides: ReplayModelOverrideRow[];
  guardProfileId: string;
  /** Empty: the profile's latest version. */
  guardProfileVersion: string;
  /** Registry server id → mode; servers left out use the job's MCP mode. */
  mcpServers: Record<string, ReplayServerMode>;
  liveReadNodes: string[];
  models: ReplayModelMode;
  compare: ReplayCompareMode;
  repeats: string;
  aggregate: ReplayAggregateRule;
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
    candidateFile: null,
    modelOverrides: [],
    guardProfileId: "",
    guardProfileVersion: "",
    mcpServers: {},
    liveReadNodes: [],
    models: "live",
    compare: "recording",
    repeats: "1",
    aggregate: "all",
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
  const repeats = optionalNumber(form.repeats, "Repeats", { min: 1, max: REPLAY_REPEATS_MAX, integer: true });
  if (!repeats.ok) return repeats;
  const overrides = overridesFromForm(form);
  if (!overrides.ok) return overrides;
  if (form.candidate === "file" && !form.candidateFile) return { ok: false, error: "Choose a workflow file for the candidate." };
  const candidate: Pick<ReplayJobRequest, "draft" | "version" | "workflow"> =
    form.candidate === "draft" ? { draft: true } : form.candidate === "file" ? { workflow: form.candidateFile!.workflow } : { version: form.candidate };
  const request: ReplayJobRequest = {
    datasetIds,
    ...candidate,
    ...(overrides.overrides ? { overrides: overrides.overrides } : {}),
    ...(form.models !== "live" ? { models: form.models } : {}),
    ...(form.compare !== "recording" ? { compare: form.compare } : {}),
    ...(repeats.value !== undefined && repeats.value > 1 ? { repeats: repeats.value, aggregate: form.aggregate } : {}),
    mcpMode: form.mcpMode,
    ...(ignorePaths.length > 0 ? { ignorePaths } : {}),
    ...(tolerance.value !== undefined ? { numberTolerance: tolerance.value } : {}),
    ...(maxCost.value !== undefined ? { maxCostUsd: maxCost.value } : {}),
    ...(scorers.scorers.length > 0 ? { scorers: scorers.scorers } : {})
  };
  return { ok: true, request };
}

/** The dialog's overrides as the request carries them; undefined when there are none. */
export function overridesFromForm(form: ReplayJobForm): { ok: true; overrides: ReplayCandidateOverrides | undefined } | { ok: false; error: string } {
  const models: NonNullable<ReplayCandidateOverrides["models"]> = [];
  for (const row of form.modelOverrides) {
    const model = row.model.trim();
    const provider = row.provider.trim();
    const nodeId = row.nodeId.trim();
    if (!model && !provider && !nodeId) continue;
    if (!model) return { ok: false, error: "Each model override needs a model." };
    if (!nodeId && !provider) return { ok: false, error: "A model override needs a node or a provider." };
    const secretId = row.secretId?.trim() ?? "";
    models.push({ ...(nodeId ? { nodeId } : {}), ...(provider ? { provider } : {}), model, ...(secretId ? { secretRef: { secretId } } : {}) });
  }
  const version = optionalNumber(form.guardProfileVersion, "Guard profile version", { min: 1, integer: true });
  if (!version.ok) return version;
  const guardId = form.guardProfileId.trim();
  if (!guardId && version.value !== undefined) return { ok: false, error: "Pick a guard profile for the version." };
  const mcpServers = Object.fromEntries(Object.entries(form.mcpServers).filter(([id, mode]) => id && mode));
  const overrides: ReplayCandidateOverrides = {
    ...(models.length > 0 ? { models } : {}),
    ...(guardId ? { guardProfile: { profileId: guardId, ...(version.value !== undefined ? { version: version.value } : {}) } } : {}),
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    ...(form.liveReadNodes.length > 0 ? { liveReadNodes: [...new Set(form.liveReadNodes)] } : {})
  };
  return { ok: true, overrides: Object.keys(overrides).length > 0 ? overrides : undefined };
}

/**
 * A workflow file chosen as the candidate: a workflow JSON or an export
 * holding one. It must be this workflow's (the same id). The server
 * validates it fully; this only catches the wrong file early.
 */
export function parseCandidateFile(name: string, text: string, workflowId: string): { ok: true; file: ReplayCandidateFile } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: `${name} is not JSON.` };
  }
  const record = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
  const outer = record(parsed);
  const inner = outer && !Array.isArray(outer.nodes) && record(outer.workflow) ? record(outer.workflow)! : outer;
  if (!inner || !Array.isArray(inner.nodes) || !Array.isArray(inner.edges)) return { ok: false, error: `${name} is not a workflow file.` };
  if (inner.id !== workflowId) return { ok: false, error: `${name} is for workflow ${String(inner.id)}, not this golden set's workflow (${workflowId}).` };
  return { ok: true, file: { name, workflow: inner } };
}

/** Nodes whose model a candidate can change, with the model they call now. */
export function modelNodesOf(workflow: Pick<Workflow, "nodes" | "edges"> | null): Array<{ id: string; name: string; providerId: string; model: string }> {
  if (!workflow) return [];
  const out: Array<{ id: string; name: string; providerId: string; model: string }> = [];
  for (const node of workflow.nodes) {
    // Chat model nodes attached to an agent are changed through the agent.
    const attached = workflow.edges.some((edge) => edge.target === node.id && edge.sourceHandle === "chat_model");
    if (attached) continue;
    const model = effectiveModelFor(workflow, node.id);
    if (model) out.push({ id: node.id, name: node.name || node.id, ...model });
  }
  return out;
}

/**
 * Nodes that may run live in a replay: only the pure reads on the shared
 * allow-list (`REPLAY_LIVE_READ_POLICY`), never triggers, browsers, raw
 * queries or writes. The server checks the same list.
 */
export function readNodesOf(workflow: Pick<Workflow, "nodes"> | null): Array<{ id: string; name: string }> {
  if (!workflow) return [];
  return workflow.nodes.filter((node) => replayLiveReadRefusal(node) === null).map((node) => ({ id: node.id, name: node.name || node.id }));
}

/** Phase 15.3 — whether a job counts as release proof, and why not, for the job page. */
export function releaseProofLine(candidate: ReplayJobCandidate | null): { eligible: boolean; text: string; reasons: string[] } | null {
  if (!candidate) return null;
  if (candidate.releaseEligible === true) return { eligible: true, text: "Eligible as release proof (the gate also checks its own settings).", reasons: [] };
  const reasons = candidate.releaseIneligibleReasons ?? [];
  return { eligible: false, text: "Not release proof.", reasons: reasons.length > 0 ? reasons : ["This job was made before release proof was recorded."] };
}

/** `draft`, `v3` or `file: name`. */
export function candidateLabel(candidate: ReplayJobCandidate | null): string {
  if (!candidate) return "—";
  if (candidate.kind === "inline") return candidate.name ? `file: ${candidate.name}` : "file";
  return candidate.kind === "version" && candidate.version !== null ? `v${candidate.version}` : "draft";
}

/** One line per override of a job's candidate, for the job page. */
export function overrideLines(candidate: ReplayJobCandidate | null): string[] {
  const overrides = candidate?.overrides;
  if (!overrides) return [];
  const lines: string[] = [];
  for (const entry of overrides.models ?? []) {
    lines.push(`Model ${entry.nodeId ? `on ${entry.nodeId}` : `for every ${entry.provider} node`}: ${entry.provider && entry.nodeId ? `${entry.provider}/` : ""}${entry.model}`);
  }
  if (overrides.guardProfile) lines.push(`Guard profile ${overrides.guardProfile.profileId}${overrides.guardProfile.version ? ` v${overrides.guardProfile.version}` : " (latest)"}`);
  for (const [server, mode] of Object.entries(overrides.mcpServers ?? {})) lines.push(`MCP ${server}: ${SERVER_MODE_LABELS[mode]}`);
  if (overrides.liveReadNodes && overrides.liveReadNodes.length > 0) lines.push(`Live reads: ${overrides.liveReadNodes.join(", ")}`);
  return lines;
}

export const SERVER_MODE_LABELS: Record<ReplayServerMode, string> = {
  strict: "strict",
  lenient: "lenient",
  live_read_only: "live reads only"
};

/** How a job compares and repeats, for the job page. */
export function comparisonLabel(options: ReplayJobOptions | null): string {
  if (!options) return "";
  const parts = [
    options.models === "replay" ? "models from tape" : "live models",
    options.compare === "baseline_rerun" ? "vs baseline rerun" : "vs recording"
  ];
  if ((options.repeats ?? 1) > 1) parts.push(`${options.repeats}× (${options.aggregate ?? "all"})`);
  return parts.join(" · ");
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
  /** A model or judge call had no price: `spentUsd` is a lower bound. */
  costUnknown: boolean;
}

/** Spend as shown: a lower bound gets a trailing "+". */
export function formatSpend(counts: Pick<JobCounts, "spentUsd" | "costUnknown">): string {
  return `${formatUsd(counts.spentUsd)}${counts.costUnknown && counts.spentUsd !== null ? "+" : ""}`;
}

/** What a reader should know about a job's numbers: the finished summary's warnings, or the live one. */
export function jobWarnings(run: Pick<EvalRunView, "summary" | "progress">): string[] {
  if (run.summary?.warnings && run.summary.warnings.length > 0) return run.summary.warnings;
  if (!run.summary && run.progress?.costUnknown) return ["Some model or judge calls have no price in the price table: the spend shown leaves them out, and the budget cannot stop on them."];
  return [];
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
      spentUsd: run.summary.costUsd ?? run.progress?.spentUsd ?? null,
      costUnknown: Boolean(run.summary.costUnknown ?? run.progress?.costUnknown)
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
    spentUsd: progress?.spentUsd ?? null,
    costUnknown: Boolean(progress?.costUnknown)
  };
}
