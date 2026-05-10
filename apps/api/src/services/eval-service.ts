/**
 * Phase 7.3 — Agent eval framework.
 *
 * Runs a workflow against every fixture in a dataset, applies one or more
 * scorers per fixture (exact_match / contains in this MVP), and persists
 * pass/fail results plus aggregated cost + latency. Surfaced through the
 * Settings → Evals tab.
 *
 * SQLite-only at the moment — see /docs/extensions/eval-framework for the
 * Postgres-parity follow-up note.
 *
 * Design choices for the MVP:
 *   - Runs execute serially, in-process. For long datasets this is slow but
 *     simple. Background-queue execution is a follow-up that lifts into the
 *     existing queue-service infrastructure.
 *   - Scorers are pure functions over (output, expected). LLM-as-judge is
 *     deferred — the plan calls for using existing classifier/extractor
 *     nodes; that would require wiring a dedicated scorer-workflow concept
 *     and is bigger than the MVP scope.
 *   - Token + latency aggregation pulls from the existing _telemetry blob
 *     attached by Phase 7.1 to llm_call and agent_orchestrator nodes.
 */

import { randomUUID } from "node:crypto";
import type { SqliteStore } from "../db/database.js";

export type ScorerSpec =
  | { type: "exact_match"; path?: string; ignoreCase?: boolean }
  | { type: "contains"; path?: string; needle?: string; ignoreCase?: boolean }
  | { type: "regex"; path?: string; pattern?: string; flags?: string }
  // Phase 9.5 — RAG-specific scorers.
  // Programmatic (token-overlap heuristic):
  //   - context_precision: of the retrieved chunks, what fraction overlap
  //     meaningfully with the expected answer? Bounded [0, 1].
  //   - context_recall: of the tokens in the expected answer, what fraction
  //     appear somewhere in the concatenated context? Bounded [0, 1].
  // LLM-judge (require an `EvalLlmJudge` wired into EvalService):
  //   - faithfulness: are the claims in the generated answer supported by
  //     the retrieved context? Useful for hallucination detection.
  //   - answer_relevance: does the answer actually address the question?
  //     Useful for off-topic detection.
  //
  // All four return `pass = score >= threshold` (default threshold 0.5)
  // and surface the numeric score in `EvalScoreDetail.score` so dashboards
  // can chart trends rather than only pass/fail counts.
  | {
      type: "context_precision";
      contextPath?: string;        // default "documents"
      threshold?: number;          // default 0.5
      relevanceThreshold?: number; // a chunk is relevant if its expected-token overlap >= this. Default 0.3.
    }
  | {
      type: "context_recall";
      contextPath?: string;
      threshold?: number;
    }
  | {
      type: "faithfulness";
      contextPath?: string;
      answerPath?: string;         // default "answer"
      providerId?: string;
      model?: string;
      threshold?: number;
    }
  | {
      type: "answer_relevance";
      questionPath?: string;       // when omitted, uses fixtureInput verbatim (string)
      answerPath?: string;
      providerId?: string;
      model?: string;
      threshold?: number;
    };

/**
 * Phase 9.5 — LLM-judge callback. The host (apps/api) wires this to the
 * existing provider registry so judge calls share secret resolution +
 * telemetry with the rest of the system. EvalService stays free of any
 * direct provider-SDK coupling.
 */
export type EvalLlmJudge = (input: {
  prompt: string;
  providerId?: string;
  model?: string;
}) => Promise<string>;

export interface EvalRunRequest {
  datasetId: string;
  workflowId: string;
  /**
   * Run-level scorers applied to every fixture. Combined with any per-fixture
   * scorers (which take precedence on conflicting paths). Defaults to a
   * single `exact_match` over the whole output if neither set provides one.
   */
  scorers?: ScorerSpec[];
  triggeredBy?: string;
}

export interface EvalScoreDetail {
  type: string;
  path?: string;
  pass: boolean;
  reason: string;
  /**
   * Phase 9.5 — numeric score in [0, 1] for scorers that produce one
   * (context_precision, context_recall, faithfulness, answer_relevance).
   * Programmatic scorers (exact_match, contains, regex) leave it undefined.
   */
  score?: number;
}

export interface EvalRunSummary {
  total: number;
  pass: number;
  fail: number;
  error: number;
  passRate: number;
  totalTokenInput: number;
  totalTokenOutput: number;
  totalTokenTotal: number;
  totalDurationMs: number;
  avgDurationMs: number;
}

/**
 * Workflow-execution callback the EvalService uses to invoke runs. The
 * caller (apps/api/src/app.ts) wires this to the existing in-process
 * execution path so eval runs share routing, telemetry, and history.
 */
export interface EvalWorkflowExecutor {
  (input: {
    workflowId: string;
    fixtureInput: unknown;
    fixtureName: string;
    runId: string;
    triggeredBy?: string;
  }): Promise<{
    executionId?: string;
    output: unknown;
    error?: string;
    durationMs?: number;
    tokens?: { input?: number; output?: number; total?: number };
  }>;
}

export class EvalService {
  constructor(
    private readonly store: SqliteStore,
    private readonly executor: EvalWorkflowExecutor,
    /**
     * Phase 9.5 — optional LLM-judge callback. When omitted, judge-based
     * scorers (faithfulness, answer_relevance) fail with a clear "no
     * judge wired" reason rather than a silent error so operators can see
     * exactly what's needed to enable them.
     */
    private readonly llmJudge?: EvalLlmJudge
  ) {}

  // ---------------------------------------------------------------------------
  // Datasets
  // ---------------------------------------------------------------------------

  createDataset(input: { name: string; description?: string; projectId?: string; createdBy?: string }) {
    const id = `ds_${randomUUID()}`;
    this.store.createEvalDataset({ id, ...input });
    return this.store.getEvalDataset(id);
  }

  listDatasets(options: { projectId?: string } = {}) {
    return this.store.listEvalDatasets(options);
  }

  deleteDataset(id: string): boolean {
    return this.store.deleteEvalDataset(id);
  }

  // ---------------------------------------------------------------------------
  // Fixtures
  // ---------------------------------------------------------------------------

  addFixture(input: {
    datasetId: string;
    name: string;
    input: unknown;
    expected?: unknown;
    scorers?: ScorerSpec[];
  }) {
    const id = `fix_${randomUUID()}`;
    this.store.createEvalFixture({
      id,
      datasetId: input.datasetId,
      name: input.name,
      input: input.input,
      expected: input.expected,
      scorers: input.scorers as Array<Record<string, unknown>> | undefined
    });
    return this.store.listEvalFixtures(input.datasetId).find((f) => f.id === id) ?? null;
  }

  listFixtures(datasetId: string) {
    return this.store.listEvalFixtures(datasetId);
  }

  deleteFixture(id: string): boolean {
    return this.store.deleteEvalFixture(id);
  }

  // ---------------------------------------------------------------------------
  // Runs
  // ---------------------------------------------------------------------------

  /**
   * Synchronously execute every fixture in a dataset against the given
   * workflow, applying scorers per fixture and persisting results. Returns
   * the run summary once complete. Long datasets block until done — for
   * background execution, dispatch this to the queue-service in a follow-up.
   */
  async startRun(request: EvalRunRequest): Promise<{ runId: string; summary: EvalRunSummary }> {
    const dataset = this.store.getEvalDataset(request.datasetId);
    if (!dataset) throw new Error(`Eval dataset not found: ${request.datasetId}`);
    const fixtures = this.store.listEvalFixtures(request.datasetId);
    if (fixtures.length === 0) throw new Error(`Dataset ${request.datasetId} has no fixtures`);

    const runId = `run_${randomUUID()}`;
    this.store.createEvalRun({
      id: runId,
      datasetId: request.datasetId,
      workflowId: request.workflowId,
      triggeredBy: request.triggeredBy,
      scorers: request.scorers as Array<Record<string, unknown>> | undefined
    });

    const summary: EvalRunSummary = {
      total: fixtures.length,
      pass: 0,
      fail: 0,
      error: 0,
      passRate: 0,
      totalTokenInput: 0,
      totalTokenOutput: 0,
      totalTokenTotal: 0,
      totalDurationMs: 0,
      avgDurationMs: 0
    };

    for (const fixture of fixtures) {
      const fixtureScorers = (fixture.scorers ?? []) as ScorerSpec[];
      const runScorers = (request.scorers ?? []) as ScorerSpec[];
      const effectiveScorers = fixtureScorers.length > 0 ? fixtureScorers : runScorers.length > 0 ? runScorers : [{ type: "exact_match" } as ScorerSpec];

      try {
        const exec = await this.executor({
          workflowId: request.workflowId,
          fixtureInput: fixture.input,
          fixtureName: fixture.name,
          runId,
          triggeredBy: request.triggeredBy
        });

        if (exec.error) {
          this.store.recordEvalResult({
            id: `res_${randomUUID()}`,
            runId,
            fixtureId: fixture.id,
            fixtureName: fixture.name,
            status: "error",
            executionId: exec.executionId,
            error: exec.error,
            durationMs: exec.durationMs,
            tokenInput: exec.tokens?.input,
            tokenOutput: exec.tokens?.output,
            tokenTotal: exec.tokens?.total
          });
          summary.error += 1;
          continue;
        }

        const scoreDetails = await Promise.all(
          effectiveScorers.map((scorer) =>
            applyScorer(scorer, {
              output: exec.output,
              expected: fixture.expected,
              fixtureInput: fixture.input,
              llmJudge: this.llmJudge
            })
          )
        );
        const allPass = scoreDetails.every((s) => s.pass);

        this.store.recordEvalResult({
          id: `res_${randomUUID()}`,
          runId,
          fixtureId: fixture.id,
          fixtureName: fixture.name,
          status: allPass ? "pass" : "fail",
          executionId: exec.executionId,
          score: { pass: allPass, details: scoreDetails },
          output: exec.output,
          durationMs: exec.durationMs,
          tokenInput: exec.tokens?.input,
          tokenOutput: exec.tokens?.output,
          tokenTotal: exec.tokens?.total
        });
        if (allPass) summary.pass += 1;
        else summary.fail += 1;
        if (typeof exec.durationMs === "number") summary.totalDurationMs += exec.durationMs;
        if (typeof exec.tokens?.input === "number") summary.totalTokenInput += exec.tokens.input;
        if (typeof exec.tokens?.output === "number") summary.totalTokenOutput += exec.tokens.output;
        if (typeof exec.tokens?.total === "number") summary.totalTokenTotal += exec.tokens.total;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.store.recordEvalResult({
          id: `res_${randomUUID()}`,
          runId,
          fixtureId: fixture.id,
          fixtureName: fixture.name,
          status: "error",
          error: message
        });
        summary.error += 1;
      }
    }

    summary.passRate = summary.total > 0 ? summary.pass / summary.total : 0;
    summary.avgDurationMs = summary.total > 0 ? Math.round(summary.totalDurationMs / summary.total) : 0;

    this.store.finalizeEvalRun({
      id: runId,
      status: "completed",
      summary: summary as unknown as Record<string, unknown>
    });

    return { runId, summary };
  }

  listRuns(options: { datasetId?: string; workflowId?: string; limit?: number } = {}) {
    return this.store.listEvalRuns(options);
  }

  getRun(id: string) {
    const run = this.store.getEvalRun(id);
    if (!run) return null;
    const results = this.store.listEvalResults(id);
    return { ...run, results };
  }
}

// ---------------------------------------------------------------------------
// Scorers
// ---------------------------------------------------------------------------

function getValueAtPath(value: unknown, path: string | undefined): unknown {
  if (!path || !path.trim()) return value;
  const parts = path.split(".").filter(Boolean);
  let current: unknown = value;
  for (const part of parts) {
    if (current && typeof current === "object" && part in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function toComparable(value: unknown, ignoreCase: boolean): string {
  const s = typeof value === "string" ? value : value === undefined || value === null ? "" : JSON.stringify(value);
  return ignoreCase ? s.toLowerCase() : s;
}

interface ApplyScorerInput {
  output: unknown;
  expected: unknown;
  fixtureInput: unknown;
  llmJudge?: EvalLlmJudge;
}

async function applyScorer(scorer: ScorerSpec, ctx: ApplyScorerInput): Promise<EvalScoreDetail> {
  const { output, expected, fixtureInput, llmJudge } = ctx;
  switch (scorer.type) {
    case "exact_match": {
      const actual = getValueAtPath(output, scorer.path);
      if (expected === undefined) {
        return { type: scorer.type, path: scorer.path, pass: false, reason: "no `expected` set on fixture" };
      }
      const expectedAt = scorer.path ? getValueAtPath(expected, scorer.path) ?? expected : expected;
      const a = toComparable(actual, scorer.ignoreCase ?? false);
      const e = toComparable(expectedAt, scorer.ignoreCase ?? false);
      const pass = a === e;
      return {
        type: scorer.type,
        path: scorer.path,
        pass,
        reason: pass ? "exact match" : `mismatch: expected ${truncate(e, 80)}, got ${truncate(a, 80)}`
      };
    }
    case "contains": {
      const actual = getValueAtPath(output, scorer.path);
      const needle = scorer.needle ?? (typeof expected === "string" ? expected : "");
      if (!needle) {
        return { type: scorer.type, path: scorer.path, pass: false, reason: "no `needle` provided" };
      }
      const haystack = toComparable(actual, scorer.ignoreCase ?? false);
      const n = scorer.ignoreCase ? needle.toLowerCase() : needle;
      const pass = haystack.includes(n);
      return {
        type: scorer.type,
        path: scorer.path,
        pass,
        reason: pass ? `contains '${truncate(needle, 40)}'` : `'${truncate(needle, 40)}' not found in ${truncate(haystack, 80)}`
      };
    }
    case "regex": {
      const actual = getValueAtPath(output, scorer.path);
      if (!scorer.pattern) {
        return { type: scorer.type, path: scorer.path, pass: false, reason: "no `pattern` provided" };
      }
      let re: RegExp;
      try {
        re = new RegExp(scorer.pattern, scorer.flags ?? "");
      } catch (err) {
        return { type: scorer.type, path: scorer.path, pass: false, reason: `invalid regex: ${(err as Error).message}` };
      }
      const haystack = typeof actual === "string" ? actual : actual === undefined ? "" : JSON.stringify(actual);
      const pass = re.test(haystack);
      return {
        type: scorer.type,
        path: scorer.path,
        pass,
        reason: pass ? `regex matched` : `regex did not match: ${truncate(haystack, 80)}`
      };
    }

    // -----------------------------------------------------------------------
    // Phase 9.5 — RAG-specific scorers
    // -----------------------------------------------------------------------

    case "context_precision": {
      const documents = extractDocuments(output, scorer.contextPath ?? "documents");
      if (documents.length === 0) {
        return { type: scorer.type, pass: false, reason: "no retrieved context to score" };
      }
      const expectedString = stringifyForScorer(expected);
      if (!expectedString) {
        return { type: scorer.type, pass: false, reason: "no `expected` set on fixture" };
      }
      const score = scoreContextPrecision(
        documents,
        expectedString,
        scorer.relevanceThreshold ?? 0.3
      );
      const threshold = scorer.threshold ?? 0.5;
      const pass = score >= threshold;
      return {
        type: scorer.type,
        pass,
        score,
        reason: `context_precision=${score.toFixed(3)} (threshold ${threshold}, ${documents.length} chunks)`
      };
    }

    case "context_recall": {
      const documents = extractDocuments(output, scorer.contextPath ?? "documents");
      if (documents.length === 0) {
        return { type: scorer.type, pass: false, reason: "no retrieved context to score" };
      }
      const expectedString = stringifyForScorer(expected);
      if (!expectedString) {
        return { type: scorer.type, pass: false, reason: "no `expected` set on fixture" };
      }
      const score = scoreContextRecall(documents, expectedString);
      const threshold = scorer.threshold ?? 0.5;
      const pass = score >= threshold;
      return {
        type: scorer.type,
        pass,
        score,
        reason: `context_recall=${score.toFixed(3)} (threshold ${threshold})`
      };
    }

    case "faithfulness": {
      if (!llmJudge) {
        return {
          type: scorer.type,
          pass: false,
          reason: "no LLM judge wired — set EVAL_JUDGE_PROVIDER_ID + provider credentials in apps/api"
        };
      }
      const documents = extractDocuments(output, scorer.contextPath ?? "documents");
      if (documents.length === 0) {
        return { type: scorer.type, pass: false, reason: "no retrieved context — faithfulness needs both context and answer" };
      }
      const answer = String(getValueAtPath(output, scorer.answerPath ?? "answer") ?? "").trim();
      if (!answer) {
        return { type: scorer.type, pass: false, reason: `no answer at path '${scorer.answerPath ?? "answer"}'` };
      }
      const context = documents.map((d, i) => `[${i + 1}] ${d.text}`).join("\n");
      const prompt = buildFaithfulnessPrompt({ context, answer });
      try {
        const response = await llmJudge({ prompt, providerId: scorer.providerId, model: scorer.model });
        const parsed = parseJudgeJson<{ supported?: number; unsupported?: number; details?: unknown }>(response);
        if (!parsed) {
          return { type: scorer.type, pass: false, reason: `judge response was not parseable JSON: ${truncate(response, 80)}` };
        }
        const supported = Number(parsed.supported ?? 0);
        const unsupported = Number(parsed.unsupported ?? 0);
        const total = supported + unsupported;
        const score = total > 0 ? supported / total : 0;
        const threshold = scorer.threshold ?? 0.7;
        return {
          type: scorer.type,
          pass: score >= threshold,
          score,
          reason: `faithfulness=${score.toFixed(3)} (${supported}/${total} claims supported, threshold ${threshold})`
        };
      } catch (err) {
        return { type: scorer.type, pass: false, reason: `judge call failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    case "answer_relevance": {
      if (!llmJudge) {
        return {
          type: scorer.type,
          pass: false,
          reason: "no LLM judge wired — set EVAL_JUDGE_PROVIDER_ID + provider credentials in apps/api"
        };
      }
      const question = scorer.questionPath
        ? String(getValueAtPath(output, scorer.questionPath) ?? "").trim()
        : typeof fixtureInput === "string"
          ? fixtureInput
          : stringifyForScorer(fixtureInput);
      if (!question) {
        return { type: scorer.type, pass: false, reason: "no question available — set fixture input or scorer.questionPath" };
      }
      const answer = String(getValueAtPath(output, scorer.answerPath ?? "answer") ?? "").trim();
      if (!answer) {
        return { type: scorer.type, pass: false, reason: `no answer at path '${scorer.answerPath ?? "answer"}'` };
      }
      const prompt = buildAnswerRelevancePrompt({ question, answer });
      try {
        const response = await llmJudge({ prompt, providerId: scorer.providerId, model: scorer.model });
        const parsed = parseJudgeJson<{ score?: number; reasoning?: string }>(response);
        if (!parsed || typeof parsed.score !== "number") {
          return { type: scorer.type, pass: false, reason: `judge response was not parseable JSON: ${truncate(response, 80)}` };
        }
        const score = Math.max(0, Math.min(1, parsed.score));
        const threshold = scorer.threshold ?? 0.6;
        return {
          type: scorer.type,
          pass: score >= threshold,
          score,
          reason: `answer_relevance=${score.toFixed(3)} (threshold ${threshold})${parsed.reasoning ? ` — ${truncate(parsed.reasoning, 60)}` : ""}`
        };
      } catch (err) {
        return { type: scorer.type, pass: false, reason: `judge call failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ---------------------------------------------------------------------------
// Phase 9.5 — RAG scorer helpers
// ---------------------------------------------------------------------------

interface ScoredDocument {
  text: string;
  metadata?: Record<string, unknown>;
}

/**
 * Best-effort extraction of retrieved chunks from a workflow output. Looks
 * at `output[contextPath]` and accepts:
 *   - Array<{ text: string }>            (rag_retrieve / rerank shape)
 *   - Array<string>                       (loose convention)
 *   - { documents: ... } nested object   (one level of unwrap)
 *   - string                              (single concatenated context)
 */
function extractDocuments(output: unknown, contextPath: string): ScoredDocument[] {
  let value = getValueAtPath(output, contextPath);
  if (value === undefined && contextPath !== "context") {
    // Common fallback: some workflows expose the joined string at "context"
    value = getValueAtPath(output, "context");
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === "string") return [{ text: item }];
      if (item && typeof item === "object") {
        const text = (item as { text?: unknown }).text;
        if (typeof text === "string") {
          return [{ text, metadata: (item as { metadata?: Record<string, unknown> }).metadata }];
        }
      }
      return [];
    });
  }
  if (value && typeof value === "object") {
    const docs = (value as { documents?: unknown }).documents;
    if (Array.isArray(docs)) return extractDocuments({ documents: docs }, "documents");
  }
  if (typeof value === "string" && value.trim()) {
    return [{ text: value }];
  }
  return [];
}

function stringifyForScorer(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((v) => stringifyForScorer(v)).join(" ");
  if (typeof value === "object") {
    const text = (value as { text?: unknown }).text;
    if (typeof text === "string") return text;
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * Tokenize text into a Set of normalized lowercase tokens. Drops single-
 * character noise + a small English stopword list — without this, common
 * function words make every chunk look "relevant" and the score collapses.
 */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "for", "of", "to",
  "in", "on", "at", "with", "without", "from", "by", "as", "is", "are",
  "was", "were", "be", "been", "being", "do", "does", "did", "have", "has",
  "had", "this", "that", "these", "those", "it", "its", "they", "them",
  "their", "what", "which", "who", "how", "when", "where", "why", "i",
  "you", "he", "she", "we", "us", "our", "your", "my", "me", "not", "no"
]);

function tokenizeForOverlap(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return new Set(tokens);
}

function scoreContextPrecision(
  documents: ScoredDocument[],
  expected: string,
  relevanceThreshold: number
): number {
  const expectedTokens = tokenizeForOverlap(expected);
  if (expectedTokens.size === 0) return 0;
  let relevantCount = 0;
  for (const doc of documents) {
    const docTokens = tokenizeForOverlap(doc.text);
    let overlap = 0;
    for (const t of expectedTokens) if (docTokens.has(t)) overlap += 1;
    const overlapRatio = overlap / expectedTokens.size;
    if (overlapRatio >= relevanceThreshold) relevantCount += 1;
  }
  return relevantCount / documents.length;
}

function scoreContextRecall(documents: ScoredDocument[], expected: string): number {
  const expectedTokens = tokenizeForOverlap(expected);
  if (expectedTokens.size === 0) return 1; // nothing to recall
  const allContextTokens = new Set<string>();
  for (const doc of documents) {
    for (const t of tokenizeForOverlap(doc.text)) allContextTokens.add(t);
  }
  let covered = 0;
  for (const t of expectedTokens) if (allContextTokens.has(t)) covered += 1;
  return covered / expectedTokens.size;
}

// ---------------------------------------------------------------------------
// LLM-judge prompts
// ---------------------------------------------------------------------------

function buildFaithfulnessPrompt(input: { context: string; answer: string }): string {
  return [
    "You are evaluating whether an ANSWER is faithful to its source CONTEXT.",
    "",
    "Identify each factual claim in the ANSWER. For each claim:",
    "  - Mark SUPPORTED if the claim is directly stated or clearly implied in the CONTEXT.",
    "  - Mark UNSUPPORTED otherwise.",
    "",
    "Stylistic claims (\"the answer is concise\") and meta-claims about the question itself don't count.",
    "",
    "Respond with ONLY a single JSON object on one line, no markdown fences, no commentary:",
    '{"supported": <integer>, "unsupported": <integer>}',
    "",
    "CONTEXT:",
    input.context,
    "",
    "ANSWER:",
    input.answer
  ].join("\n");
}

function buildAnswerRelevancePrompt(input: { question: string; answer: string }): string {
  return [
    "You are evaluating whether an ANSWER addresses a QUESTION.",
    "",
    "Score the answer's relevance from 0 (off-topic, evasive, or non-answer) to 1 (directly addresses the question).",
    "Don't grade correctness here — only relevance / on-topic-ness.",
    "",
    "Respond with ONLY a single JSON object on one line, no markdown fences, no commentary:",
    '{"score": <number 0..1>, "reasoning": "<one short sentence>"}',
    "",
    "QUESTION:",
    input.question,
    "",
    "ANSWER:",
    input.answer
  ].join("\n");
}

/**
 * Parse a JSON object from a judge response. Tolerant of:
 *   - Surrounding markdown fences (```json ... ```)
 *   - Leading/trailing text outside the object
 *   - Trailing commas (light cleanup)
 * Returns null on any failure so callers can surface a clear "non-parseable"
 * reason rather than a cryptic SyntaxError.
 */
function parseJudgeJson<T>(raw: string): T | null {
  if (!raw) return null;
  // Strip ```json ... ``` fences
  const stripped = raw.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  // Find the first {...} block (greedy on the closing brace)
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const candidate = stripped.slice(start, end + 1);
  try {
    return JSON.parse(candidate) as T;
  } catch {
    // Light cleanup: drop trailing commas before } or ]
    try {
      return JSON.parse(candidate.replace(/,\s*([}\]])/g, "$1")) as T;
    } catch {
      return null;
    }
  }
}

// Re-export internals for tests.
export const __test__ = {
  scoreContextPrecision,
  scoreContextRecall,
  tokenizeForOverlap,
  parseJudgeJson,
  buildFaithfulnessPrompt,
  buildAnswerRelevancePrompt,
  extractDocuments
};
