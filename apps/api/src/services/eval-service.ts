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
  | { type: "regex"; path?: string; pattern?: string; flags?: string };

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
    private readonly executor: EvalWorkflowExecutor
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

        const scoreDetails = effectiveScorers.map((scorer) =>
          applyScorer(scorer, exec.output, fixture.expected)
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

function applyScorer(scorer: ScorerSpec, output: unknown, expected: unknown): EvalScoreDetail {
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
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
