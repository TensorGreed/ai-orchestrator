import { z } from "zod";
import { REPLAY_MCP_MODES, replayIgnorePathSchema, REPLAY_IGNORE_PATHS_MAX, type ReplayRunResponse } from "./replay";
import { checkRegexSafety, jsonSchemaRegexProblem } from "./regex-safety";

/**
 * Phase 15.2 — golden sets, replay jobs and scorers: the shared contract.
 *
 * A golden set is an eval dataset tied to one workflow; its cases are golden
 * runs (a fixture with a `recordingId`, whose expected output defaults to
 * the recorded one) and, optionally, hand-written fixtures. A replay job is
 * an eval run of kind `replay`: every golden-run case of the chosen sets is
 * replayed against one candidate (the draft or a saved version) and scored.
 * Plain eval runs (kind `eval`) and replay jobs share one background runner
 * with a deployment-wide cap on cases running at once.
 *
 * Every scorer returns `pass`, a `score` in 0..1 and a human-readable
 * `reason`. The scorers that compare with a baseline use the golden run's
 * recorded run facts; on a plain eval run without a golden run they say so
 * and fail.
 */

const pathSchema = z.string().trim().max(256);
const thresholdSchema = z.number().min(0).max(1);
const secretRefSchema = z.object({ secretId: z.string().trim().min(1).max(200) }).strict();

/** What a comparing scorer compares the candidate with: the case's expected value, or the golden run's recorded output. */
export const EVAL_COMPARE_TARGETS = ["expected", "baseline"] as const;
export type EvalCompareTarget = (typeof EVAL_COMPARE_TARGETS)[number];

export const TOOL_SEQUENCE_MODES = ["exact", "subsequence", "set", "superset_allowed"] as const;
export type ToolSequenceMode = (typeof TOOL_SEQUENCE_MODES)[number];
export const TOOL_SEQUENCE_ARG_MODES = ["exact", "keys", "ignore"] as const;
export type ToolSequenceArgMode = (typeof TOOL_SEQUENCE_ARG_MODES)[number];
export const LLM_JUDGE_MODES = ["absolute", "pairwise"] as const;
export type LlmJudgeMode = (typeof LLM_JUDGE_MODES)[number];

/** Longest rubric an LLM-judge scorer may carry. */
export const LLM_JUDGE_RUBRIC_MAX = 4000;
/** Most votes one LLM-judge scorer takes per case (pairwise makes two judge calls per vote). */
export const LLM_JUDGE_VOTES_MAX = 5;
/** Most judge calls all of a case's scorers make together; the next call fails the scorer. */
export const EVAL_JUDGE_CALLS_PER_CASE_MAX = 50;
/** Sampling temperature for a judge that takes several votes (one vote is asked at temperature 0). */
export const LLM_JUDGE_VOTE_TEMPERATURE = 0.7;
/** Most text (UTF-16 code units of the output, or of its JSON) a regex or json_schema scorer matches against. */
export const EVAL_SCORER_INPUT_MAX_BYTES = 262_144;
/** Most scorers on one case or one run. */
export const EVAL_SCORERS_MAX = 20;
/** Largest JSON Schema a json_schema scorer may carry, as JSON text. */
export const JSON_SCHEMA_SCORER_MAX_BYTES = 65_536;

export const evalScorerSpecSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("exact_match"), path: pathSchema.optional(), ignoreCase: z.boolean().optional() }),
  z.object({ type: z.literal("contains"), path: pathSchema.optional(), needle: z.string().max(2000).optional(), ignoreCase: z.boolean().optional() }),
  z.object({
    type: z.literal("regex"),
    path: pathSchema.optional(),
    pattern: z
      .string()
      .max(2000)
      .superRefine((value, ctx) => {
        const check = checkRegexSafety(value);
        if (!check.safe) ctx.addIssue({ code: "custom", message: `This pattern is not allowed: ${check.reason}` });
      })
      .optional(),
    flags: z.string().max(8).optional()
  }),
  z.object({ type: z.literal("context_precision"), contextPath: pathSchema.optional(), threshold: thresholdSchema.optional(), relevanceThreshold: thresholdSchema.optional() }),
  z.object({ type: z.literal("context_recall"), contextPath: pathSchema.optional(), threshold: thresholdSchema.optional() }),
  z.object({
    type: z.literal("faithfulness"),
    contextPath: pathSchema.optional(),
    answerPath: pathSchema.optional(),
    providerId: z.string().trim().min(1).max(120).optional(),
    model: z.string().trim().min(1).max(200).optional(),
    threshold: thresholdSchema.optional()
  }),
  z.object({
    type: z.literal("answer_relevance"),
    questionPath: pathSchema.optional(),
    answerPath: pathSchema.optional(),
    providerId: z.string().trim().min(1).max(120).optional(),
    model: z.string().trim().min(1).max(200).optional(),
    threshold: thresholdSchema.optional()
  }),
  // Phase 15.2
  z.object({
    type: z.literal("json_equal"),
    path: pathSchema.optional(),
    against: z.enum(EVAL_COMPARE_TARGETS).optional(),
    ignorePaths: z.array(replayIgnorePathSchema).max(REPLAY_IGNORE_PATHS_MAX).optional(),
    numberTolerance: z.number().min(0).max(1e9).optional(),
    ignoreArrayOrder: z.boolean().optional()
  }),
  z.object({
    type: z.literal("json_schema"),
    path: pathSchema.optional(),
    schema: z
      .record(z.string(), z.unknown())
      .refine((value) => JSON.stringify(value).length <= JSON_SCHEMA_SCORER_MAX_BYTES, { message: `The schema must be at most ${JSON_SCHEMA_SCORER_MAX_BYTES} bytes of JSON` })
      .superRefine((value, ctx) => {
        const problem = jsonSchemaRegexProblem(value);
        if (problem) ctx.addIssue({ code: "custom", message: problem.charAt(0).toUpperCase() + problem.slice(1) });
      })
  }),
  z.object({
    type: z.literal("text_similarity"),
    path: pathSchema.optional(),
    against: z.enum(EVAL_COMPARE_TARGETS).optional(),
    threshold: thresholdSchema.optional()
  }),
  z.object({
    type: z.literal("tool_sequence"),
    mode: z.enum(TOOL_SEQUENCE_MODES).optional(),
    args: z.enum(TOOL_SEQUENCE_ARG_MODES).optional(),
    /** Compare with this list instead of the golden run's calls. */
    expected: z
      .array(z.object({ tool: z.string().trim().min(1).max(200), server: z.string().trim().min(1).max(200).optional(), args: z.unknown().optional() }))
      .max(200)
      .optional(),
    forbiddenTools: z.array(z.string().trim().min(1).max(200)).max(50).optional()
  }),
  z.object({ type: z.literal("status"), expect: z.string().trim().min(1).max(40).optional() }),
  z.object({ type: z.literal("no_new_guard_blocks"), failOnRemoved: z.boolean().optional() }),
  z
    .object({
      type: z.literal("budget"),
      maxCostUsd: z.number().min(0).max(1e6).optional(),
      maxTokens: z.number().int().min(0).max(1e9).optional(),
      maxLatencyMs: z.number().int().min(0).max(1e9).optional(),
      maxCostIncreasePct: z.number().min(0).max(1e6).optional(),
      maxTokensIncreasePct: z.number().min(0).max(1e6).optional(),
      maxLatencyIncreasePct: z.number().min(0).max(1e6).optional()
    })
    .refine((value) => Object.keys(value).some((key) => key !== "type"), { message: "A budget scorer needs at least one limit" }),
  z.object({
    type: z.literal("llm_judge"),
    rubric: z.string().trim().min(1).max(LLM_JUDGE_RUBRIC_MAX),
    mode: z.enum(LLM_JUDGE_MODES).optional(),
    votes: z.number().int().min(1).max(LLM_JUDGE_VOTES_MAX).optional(),
    threshold: thresholdSchema.optional(),
    path: pathSchema.optional(),
    providerId: z.string().trim().min(1).max(120).optional(),
    model: z.string().trim().min(1).max(200).optional(),
    /** Provider credentials, resolved through the secret store; never a raw key. */
    secretRef: secretRefSchema.optional()
  })
]);
export type EvalScorerSpec = z.infer<typeof evalScorerSpecSchema>;
export type EvalScorerType = EvalScorerSpec["type"];

export const evalScorerListSchema = z.array(evalScorerSpecSchema).max(EVAL_SCORERS_MAX);

export interface EvalScoreDetail {
  type: string;
  path?: string;
  pass: boolean;
  /** 0..1. Every Phase 15.2 scorer sets it; the older programmatic ones (exact_match, contains, regex) leave it out. */
  score?: number;
  reason: string;
  /** LLM-judge scorers: what the judge calls cost, in USD, when the model is priced. */
  costUsd?: number;
  /** A judge call had no price (an unpriced model): `costUsd` is a lower bound. */
  costUnknown?: boolean;
}

// ---------------------------------------------------------------------------
// Runs and replay jobs
// ---------------------------------------------------------------------------

export const EVAL_RUN_KINDS = ["eval", "replay"] as const;
export type EvalRunKind = (typeof EVAL_RUN_KINDS)[number];

/**
 * `queued` → `running` → `completed` | `failed` | `canceled`. `interrupted`:
 * the server stopped while the run was queued or running. `errored` is the
 * pre-15.2 failure status, kept for old rows.
 */
export const EVAL_RUN_STATUSES = ["queued", "running", "completed", "failed", "canceled", "interrupted", "errored"] as const;
export type EvalRunStatus = (typeof EVAL_RUN_STATUSES)[number];
export const EVAL_RUN_FINISHED_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "canceled", "interrupted", "errored"]);

export type EvalCaseStatus = "pass" | "fail" | "error" | "skipped";

export interface EvalRunProgress {
  total: number;
  done: number;
  running: number;
  pass: number;
  fail: number;
  error: number;
  skipped: number;
  /** Model and judge spend so far, in USD: a lower bound when `costUnknown`. */
  spentUsd: number;
  /** A model or judge call of this run had no price, so `spentUsd` leaves it out and the budget cannot count it. */
  costUnknown?: boolean;
  updatedAt: string;
}

export interface EvalRunSummary {
  total: number;
  pass: number;
  fail: number;
  error: number;
  /** Phase 15.2 — cases a replay job could not replay (hand-written fixtures). */
  skipped?: number;
  passRate: number;
  totalTokenInput: number;
  totalTokenOutput: number;
  totalTokenTotal: number;
  totalDurationMs: number;
  avgDurationMs: number;
  /** Phase 15.2 — model plus judge spend, in USD. */
  costUsd?: number;
  /** Phase 15.2 — the judge's share of `costUsd`. */
  judgeCostUsd?: number;
  /** Phase 15.2 — some model or judge call had no price: `costUsd` is a lower bound. */
  costUnknown?: boolean;
  /** Phase 15.2 — what the reader should know about the numbers (an unpriced model, a budget estimate). */
  warnings?: string[];
}

export interface ReplayJobCandidate {
  kind: "draft" | "version";
  version: number | null;
  workflowHash: string;
}

/** Replay-job options kept on the run. */
export interface ReplayJobOptions {
  mcpMode: (typeof REPLAY_MCP_MODES)[number];
  ignorePaths?: string[];
  numberTolerance?: number;
  maxCostUsd: number;
}

export interface EvalRunView {
  id: string;
  kind: EvalRunKind;
  datasetId: string;
  datasetIds: string[];
  workflowId: string;
  workflowName: string | null;
  status: string;
  startedAt: string;
  completedAt: string | null;
  triggeredBy: string | null;
  summary: EvalRunSummary | null;
  progress: EvalRunProgress | null;
  candidate: ReplayJobCandidate | null;
  options: ReplayJobOptions | null;
  error: string | null;
}

export interface EvalCaseResult {
  id: string;
  runId: string;
  fixtureId: string;
  fixtureName: string | null;
  recordingId: string | null;
  status: string;
  executionId: string | null;
  score: { pass: boolean; details: EvalScoreDetail[] } | null;
  error: string | null;
  durationMs: number | null;
  tokenInput: number | null;
  tokenOutput: number | null;
  tokenTotal: number | null;
  costUsd: number | null;
  /** Replay cases: the replay verdict, without the diff (fetch the case for it). */
  verdict: ReplayRunResponse["verdict"] | null;
}

/** One replayed case with its run diff: what the case diff drawer shows. */
export type ReplayCaseDiff = Omit<ReplayRunResponse, "facts">;

/**
 * What is stored in place of a case output or run diff whose JSON is over
 * the per-case limit (EVAL_RESULT_MAX_BYTES): its size and the start of it.
 * Scorers always saw the full value.
 */
export interface EvalStoredTruncation {
  truncated: true;
  bytes: number;
  maxBytes: number;
  /** The first 2000 characters of the JSON. */
  preview: string;
}

export interface EvalCaseDetail extends EvalCaseResult {
  /** The output, or an `EvalStoredTruncation` when it was too large to store. */
  output: unknown;
  replay: ReplayCaseDiff | null;
  /** The run diff was too large to store: `replay` is null and this says how large it was. */
  replayTruncated?: EvalStoredTruncation;
}

export const replayJobRequestSchema = z
  .object({
    datasetIds: z.array(z.string().trim().min(1).max(200)).min(1).max(10),
    draft: z.boolean().optional(),
    version: z.number().int().positive().optional(),
    mcpMode: z.enum(REPLAY_MCP_MODES).optional(),
    ignorePaths: z.array(replayIgnorePathSchema).max(REPLAY_IGNORE_PATHS_MAX).optional(),
    numberTolerance: z.number().min(0).max(1e9).optional(),
    /** Scorers for every case; a case's own scorers come first. Default: `status` and `json_equal` against the golden run. */
    scorers: evalScorerListSchema.optional(),
    /** Stop scheduling cases once the job has spent this much (model plus judge calls). */
    maxCostUsd: z.number().positive().max(100_000).optional()
  })
  .strict()
  .refine((value) => !(value.draft === true && value.version !== undefined), { message: "Choose the draft or a version, not both" });
export type ReplayJobRequest = z.infer<typeof replayJobRequestSchema>;

/** A golden set: an eval dataset tied to a workflow. */
export const goldenSetCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).optional(),
    workflowId: z.string().trim().min(1).max(200).optional(),
    projectId: z.string().trim().min(1).max(200).optional()
  })
  .strict();
export type GoldenSetCreateInput = z.infer<typeof goldenSetCreateSchema>;

/** Adds a golden run to a golden set as a case. */
export const goldenSetAddRecordingSchema = z
  .object({
    recordingId: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(120).optional(),
    scorers: evalScorerListSchema.optional()
  })
  .strict();
export type GoldenSetAddRecordingInput = z.infer<typeof goldenSetAddRecordingSchema>;

/** Server-sent event on `GET /api/eval/runs/:id/events`. */
export type EvalRunEvent = { type: "progress"; run: EvalRunView } | { type: "done"; run: EvalRunView };

/**
 * Exit code for `l2m replay run --set`: 0 every case passed, 1 a case failed
 * (a regression), 4 the job could not complete (an inconclusive case, a
 * canceled, failed or interrupted job). Shared by the CLI and its tests.
 */
export function replayJobExitCode(run: Pick<EvalRunView, "status" | "summary">): 0 | 1 | 4 {
  if (run.status !== "completed" || !run.summary) return 4;
  if (run.summary.fail > 0) return 1;
  if (run.summary.error > 0) return 4;
  if (run.summary.pass === 0) return 4;
  return 0;
}
