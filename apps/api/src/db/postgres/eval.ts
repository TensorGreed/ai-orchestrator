/**
 * Phase 13.1 — PostgresStore: Eval datasets, fixtures, runs and results.
 * Plain functions over a PgContext; PostgresStore delegates here. Every method is implemented.
 *
 * Ordering: where SQLite breaks ties by rowid (insert order), these queries use `seq`, the identity column v40 adds
 * to eval_fixtures, eval_runs and eval_results as Postgres's stand-in for rowid.
 */
import { GUARD_SIMULATION_JOB_DATASET_PREFIX } from "@ai-orchestrator/shared";
import type { EvalDatasetRecord, EvalFixtureRecord, EvalResultRecord, EvalRunRecord } from "../database.js";
import { type Store } from "../store.js";
import type { PgContext } from "./context.js";
import { toNum, toStr } from "./helpers.js";

function rowCount(result: { rowCount: number | null }): number {
  return result.rowCount ?? 0;
}

function parseJson<T>(value: unknown): T | null {
  return value ? (JSON.parse(toStr(value)) as T) : null;
}

function nullableNum(value: unknown): number | null {
  return value !== null && value !== undefined ? toNum(value) : null;
}

export async function createEvalDataset(ctx: PgContext, ...[input]: Parameters<Store["createEvalDataset"]>): ReturnType<Store["createEvalDataset"]> {
  const now = new Date().toISOString();
  await ctx.execute(
    `INSERT INTO eval_datasets (id, name, description, project_id, workflow_id, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [input.id, input.name, input.description ?? null, input.projectId ?? null, input.workflowId ?? null, input.createdBy ?? null, now, now]
  );
}

export async function listEvalDatasets(ctx: PgContext, ...[options = {}]: Parameters<Store["listEvalDatasets"]>): ReturnType<Store["listEvalDatasets"]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.projectId) { params.push(options.projectId); clauses.push(`d.project_id = $${params.length}`); }
  if (options.workflowId) { params.push(options.workflowId); clauses.push(`d.workflow_id = $${params.length}`); }
  if (options.id) { params.push(options.id); clauses.push(`d.id = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = await ctx.query<Record<string, unknown>>(
    `SELECT d.id, d.name, d.description, d.project_id, d.workflow_id, d.created_by, d.created_at, d.updated_at,
            (SELECT COUNT(*) FROM eval_fixtures WHERE dataset_id = d.id) AS fixture_count,
            (SELECT COUNT(*) FROM eval_fixtures WHERE dataset_id = d.id AND recording_id IS NOT NULL) AS golden_count
     FROM eval_datasets d
     ${where}
     ORDER BY d.created_at DESC, d.id DESC`,
    params
  );
  return rows.map((r): EvalDatasetRecord => ({
    id: toStr(r.id),
    name: toStr(r.name),
    description: r.description ? toStr(r.description) : null,
    projectId: r.project_id ? toStr(r.project_id) : null,
    workflowId: r.workflow_id ? toStr(r.workflow_id) : null,
    createdBy: r.created_by ? toStr(r.created_by) : null,
    createdAt: toStr(r.created_at),
    updatedAt: toStr(r.updated_at),
    fixtureCount: toNum(r.fixture_count),
    goldenRunCount: toNum(r.golden_count)
  }));
}

export async function getEvalDataset(ctx: PgContext, ...[id]: Parameters<Store["getEvalDataset"]>): ReturnType<Store["getEvalDataset"]> {
  return (await listEvalDatasets(ctx, { id }))[0] ?? null;
}

export async function deleteEvalDataset(ctx: PgContext, ...[id]: Parameters<Store["deleteEvalDataset"]>): ReturnType<Store["deleteEvalDataset"]> {
  return ctx.withTransaction(async (client) => {
    // Lock the set first: a promotion or import adding a case holds it FOR SHARE, so this delete waits for that case
    // (and removes it below), and one that starts after this lock finds the set gone.
    await client.query(`SELECT id FROM eval_datasets WHERE id = $1 FOR UPDATE`, [id]);
    await client.query(`DELETE FROM eval_results WHERE run_id IN (SELECT id FROM eval_runs WHERE dataset_id = $1)`, [id]);
    await client.query(`DELETE FROM eval_runs WHERE dataset_id = $1`, [id]);
    await client.query(`DELETE FROM eval_fixtures WHERE dataset_id = $1`, [id]);
    // Like SQLite's changes(): whether the dataset row itself went.
    return rowCount(await client.query(`DELETE FROM eval_datasets WHERE id = $1`, [id])) > 0;
  });
}

export async function createEvalFixture(ctx: PgContext, ...[input]: Parameters<Store["createEvalFixture"]>): ReturnType<Store["createEvalFixture"]> {
  const now = new Date().toISOString();
  await ctx.execute(
    `INSERT INTO eval_fixtures (id, dataset_id, name, input_json, expected_json, scorers_json, recording_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.id, input.datasetId, input.name,
      JSON.stringify(input.input ?? null),
      input.expected !== undefined ? JSON.stringify(input.expected) : null,
      input.scorers && input.scorers.length > 0 ? JSON.stringify(input.scorers) : null,
      input.recordingId ?? null,
      now, now
    ]
  );
}

const FIXTURE_COLUMNS = "id, dataset_id, name, input_json, expected_json, scorers_json, recording_id, required, created_at, updated_at";

function mapEvalFixture(r: Record<string, unknown>): EvalFixtureRecord {
  return {
    id: toStr(r.id),
    datasetId: toStr(r.dataset_id),
    name: toStr(r.name),
    input: JSON.parse(toStr(r.input_json) || "null"),
    expected: r.expected_json ? JSON.parse(toStr(r.expected_json)) : null,
    scorers: r.scorers_json ? (JSON.parse(toStr(r.scorers_json)) as Array<Record<string, unknown>>) : null,
    recordingId: r.recording_id ? toStr(r.recording_id) : null,
    required: Number(r.required ?? 0) === 1,
    createdAt: toStr(r.created_at),
    updatedAt: toStr(r.updated_at)
  };
}

export async function listEvalFixtures(ctx: PgContext, ...[datasetId]: Parameters<Store["listEvalFixtures"]>): ReturnType<Store["listEvalFixtures"]> {
  const rows = await ctx.query<Record<string, unknown>>(
    `SELECT ${FIXTURE_COLUMNS} FROM eval_fixtures WHERE dataset_id = $1 ORDER BY created_at, seq`,
    [datasetId]
  );
  return rows.map(mapEvalFixture);
}

export async function getEvalFixture(ctx: PgContext, ...[id]: Parameters<Store["getEvalFixture"]>): ReturnType<Store["getEvalFixture"]> {
  const row = await ctx.queryOne<Record<string, unknown>>(`SELECT ${FIXTURE_COLUMNS} FROM eval_fixtures WHERE id = $1`, [id]);
  return row ? mapEvalFixture(row) : null;
}

export async function findEvalFixtureByRecording(ctx: PgContext, ...[datasetId, recordingId]: Parameters<Store["findEvalFixtureByRecording"]>): ReturnType<Store["findEvalFixtureByRecording"]> {
  const row = await ctx.queryOne<Record<string, unknown>>(
    `SELECT ${FIXTURE_COLUMNS} FROM eval_fixtures WHERE dataset_id = $1 AND recording_id = $2 ORDER BY seq LIMIT 1`,
    [datasetId, recordingId]
  );
  return row ? mapEvalFixture(row) : null;
}

export async function getEvalFixtureDatasetId(ctx: PgContext, ...[id]: Parameters<Store["getEvalFixtureDatasetId"]>): ReturnType<Store["getEvalFixtureDatasetId"]> {
  const row = await ctx.queryOne<{ dataset_id: string }>(`SELECT dataset_id FROM eval_fixtures WHERE id = $1`, [id]);
  return row ? toStr(row.dataset_id) : null;
}

export async function deleteEvalFixture(ctx: PgContext, ...[id]: Parameters<Store["deleteEvalFixture"]>): ReturnType<Store["deleteEvalFixture"]> {
  return rowCount(await ctx.pool.query(`DELETE FROM eval_fixtures WHERE id = $1`, [id])) > 0;
}

export async function setEvalFixtureRequired(ctx: PgContext, ...[id, required]: Parameters<Store["setEvalFixtureRequired"]>): ReturnType<Store["setEvalFixtureRequired"]> {
  const result = await ctx.pool.query(`UPDATE eval_fixtures SET required = $1, updated_at = $2 WHERE id = $3`, [required ? 1 : 0, new Date().toISOString(), id]);
  return rowCount(result) > 0;
}

export async function createEvalRun(ctx: PgContext, ...[input]: Parameters<Store["createEvalRun"]>): ReturnType<Store["createEvalRun"]> {
  const now = new Date().toISOString();
  await ctx.execute(
    `INSERT INTO eval_runs (id, dataset_id, workflow_id, workflow_name, status, started_at,
                             triggered_by, triggered_by_user_id, scorers_json, kind, dataset_ids_json, candidate_json,
                             workflow_hash, workflow_version, options_json, progress_json, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [
      input.id, input.datasetId, input.workflowId, input.workflowName ?? null,
      input.status ?? "running", now, input.triggeredBy ?? null, input.triggeredByUserId ?? null,
      input.scorers && input.scorers.length > 0 ? JSON.stringify(input.scorers) : null,
      input.kind ?? "eval",
      input.datasetIds ? JSON.stringify(input.datasetIds) : null,
      input.candidate ? JSON.stringify(input.candidate) : null,
      input.workflowHash ?? null,
      typeof input.workflowVersion === "number" ? input.workflowVersion : null,
      input.options ? JSON.stringify(input.options) : null,
      input.progress ? JSON.stringify(input.progress) : null,
      now
    ]
  );
}

export async function updateEvalRunProgress(ctx: PgContext, ...[input]: Parameters<Store["updateEvalRunProgress"]>): ReturnType<Store["updateEvalRunProgress"]> {
  if (input.status) {
    await ctx.execute(`UPDATE eval_runs SET status = $1, progress_json = $2 WHERE id = $3 AND status IN ('queued', 'running')`, [
      input.status,
      JSON.stringify(input.progress),
      input.id
    ]);
  } else {
    await ctx.execute(`UPDATE eval_runs SET progress_json = $1 WHERE id = $2 AND status IN ('queued', 'running')`, [JSON.stringify(input.progress), input.id]);
  }
}

export async function pruneEvalRuns(ctx: PgContext, ...[input]: Parameters<Store["pruneEvalRuns"]>): ReturnType<Store["pruneEvalRuns"]> {
  return ctx.withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string; dataset_id: string; dataset_ids_json: string | null; status: string; started_at: string }>(
      `SELECT id, dataset_id, dataset_ids_json, status, started_at FROM eval_runs ORDER BY started_at DESC, seq DESC`
    );
    const newest = new Set<string>();
    const newestFinished = new Set<string>();
    const keep = new Set<string>();
    const doomed: string[] = [];
    for (const row of rows) {
      const id = toStr(row.id);
      const status = toStr(row.status);
      const finished = status !== "queued" && status !== "running";
      let sets: string[] = [toStr(row.dataset_id)];
      try {
        const parsed = row.dataset_ids_json ? (JSON.parse(toStr(row.dataset_ids_json)) as unknown) : null;
        if (Array.isArray(parsed)) sets = [...new Set([...sets, ...parsed.map((entry) => String(entry))])];
      } catch {
        // A malformed list: the first set still counts.
      }
      for (const set of sets) {
        if (!newest.has(set)) {
          newest.add(set);
          keep.add(id);
        }
        if (finished && !newestFinished.has(set)) {
          newestFinished.add(set);
          keep.add(id);
        }
      }
      if (finished && !keep.has(id) && toStr(row.started_at) < input.before) doomed.push(id);
    }
    // Counted from the deletes, so a prune running beside another one never counts a run twice.
    let deleted = 0;
    for (let index = 0; index < doomed.length; index += 500) {
      const chunk = doomed.slice(index, index + 500);
      await client.query(`DELETE FROM eval_results WHERE run_id = ANY($1::text[])`, [chunk]);
      deleted += rowCount(await client.query(`DELETE FROM eval_runs WHERE id = ANY($1::text[])`, [chunk]));
    }
    return deleted;
  });
}

export async function finalizeEvalRun(ctx: PgContext, ...[input]: Parameters<Store["finalizeEvalRun"]>): ReturnType<Store["finalizeEvalRun"]> {
  const now = new Date().toISOString();
  const params: unknown[] = [
    input.status,
    now,
    input.summary ? JSON.stringify(input.summary) : null,
    input.progress ? JSON.stringify(input.progress) : null,
    input.error ?? null,
    input.id
  ];
  let guard = "";
  if (input.onlyFrom && input.onlyFrom.length > 0) {
    params.push(input.onlyFrom);
    guard = ` AND status = ANY($${params.length}::text[])`;
  }
  const result = await ctx.pool.query(
    `UPDATE eval_runs SET status = $1, completed_at = $2, summary_json = COALESCE($3::text, summary_json),
       progress_json = COALESCE($4::text, progress_json), error = $5 WHERE id = $6${guard}`,
    params
  );
  return rowCount(result) > 0;
}

export async function updateEvalRunSummary(ctx: PgContext, ...[id, summary, progress]: Parameters<Store["updateEvalRunSummary"]>): ReturnType<Store["updateEvalRunSummary"]> {
  await ctx.execute(`UPDATE eval_runs SET summary_json = $1, progress_json = $2 WHERE id = $3`, [JSON.stringify(summary), JSON.stringify(progress), id]);
}

export async function listEvalRuns(ctx: PgContext, ...[options = {}]: Parameters<Store["listEvalRuns"]>): ReturnType<Store["listEvalRuns"]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const bind = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (options.id) clauses.push(`id = ${bind(options.id)}`);
  // Phase 15.6 — a guard policy simulation's replay jobs are listed with their simulation, not with the workflow's jobs.
  if (options.excludeSimulations) clauses.push(`dataset_id NOT LIKE ${bind(`${GUARD_SIMULATION_JOB_DATASET_PREFIX}%`)}`);
  if (options.datasetId) {
    // The id is matched as a JSON string inside the list; `%`, `_` and `\` in it are literal.
    const needle = JSON.stringify(options.datasetId).replace(/[\\%_]/g, (char) => `\\${char}`);
    clauses.push(`(dataset_id = ${bind(options.datasetId)} OR dataset_ids_json LIKE ${bind(`%${needle}%`)} ESCAPE '\\')`);
  }
  if (options.workflowId) clauses.push(`workflow_id = ${bind(options.workflowId)}`);
  // Project scope: only runs of these workflows (an empty list matches nothing).
  if (options.workflowIds) clauses.push(options.workflowIds.length > 0 ? `workflow_id = ANY(${bind(options.workflowIds)}::text[])` : "1 = 0");
  if (options.kind) clauses.push(`kind = ${bind(options.kind)}`);
  if (options.statuses && options.statuses.length > 0) clauses.push(`status = ANY(${bind(options.statuses)}::text[])`);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(500, options.limit ?? 100));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const rows = await ctx.query<Record<string, unknown>>(
    `SELECT id, dataset_id, workflow_id, workflow_name, status, started_at, completed_at,
            triggered_by, scorers_json, summary_json, error, kind, dataset_ids_json, candidate_json,
            workflow_hash, workflow_version, options_json, progress_json
     FROM eval_runs ${where} ORDER BY started_at DESC, seq DESC LIMIT ${bind(limit)} OFFSET ${bind(offset)}`,
    params
  );
  return rows.map((r): EvalRunRecord => ({
    id: toStr(r.id),
    kind: r.kind === "replay" ? "replay" : "eval",
    datasetId: toStr(r.dataset_id),
    datasetIds: parseJson<string[]>(r.dataset_ids_json) ?? [toStr(r.dataset_id)],
    workflowId: toStr(r.workflow_id),
    workflowName: r.workflow_name ? toStr(r.workflow_name) : null,
    status: toStr(r.status),
    startedAt: toStr(r.started_at),
    completedAt: r.completed_at ? toStr(r.completed_at) : null,
    triggeredBy: r.triggered_by ? toStr(r.triggered_by) : null,
    scorers: parseJson<Array<Record<string, unknown>>>(r.scorers_json),
    summary: parseJson<Record<string, unknown>>(r.summary_json),
    error: r.error ? toStr(r.error) : null,
    candidate: parseJson<Record<string, unknown>>(r.candidate_json),
    workflowHash: r.workflow_hash ? toStr(r.workflow_hash) : null,
    workflowVersion: nullableNum(r.workflow_version),
    options: parseJson<Record<string, unknown>>(r.options_json),
    progress: parseJson<Record<string, unknown>>(r.progress_json)
  }));
}

export async function getEvalRun(ctx: PgContext, ...[id]: Parameters<Store["getEvalRun"]>): ReturnType<Store["getEvalRun"]> {
  return (await listEvalRuns(ctx, { id, limit: 1 }))[0] ?? null;
}

export async function recordEvalResult(ctx: PgContext, ...[input]: Parameters<Store["recordEvalResult"]>): ReturnType<Store["recordEvalResult"]> {
  const now = new Date().toISOString();
  await ctx.execute(
    `INSERT INTO eval_results (id, run_id, fixture_id, fixture_name, status, execution_id,
                                score_json, output_json, error, duration_ms,
                                token_input, token_output, token_total, recording_id, verdict, diff_json, cost_usd, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
    [
      input.id, input.runId, input.fixtureId, input.fixtureName ?? null,
      input.status, input.executionId ?? null,
      input.score ? JSON.stringify(input.score) : null,
      input.output !== undefined ? JSON.stringify(input.output) : null,
      input.error ?? null,
      typeof input.durationMs === "number" ? Math.floor(input.durationMs) : null,
      typeof input.tokenInput === "number" ? Math.floor(input.tokenInput) : null,
      typeof input.tokenOutput === "number" ? Math.floor(input.tokenOutput) : null,
      typeof input.tokenTotal === "number" ? Math.floor(input.tokenTotal) : null,
      input.recordingId ?? null,
      input.verdict ?? null,
      input.diff !== undefined ? JSON.stringify(input.diff) : null,
      typeof input.costUsd === "number" && Number.isFinite(input.costUsd) ? input.costUsd : null,
      now
    ]
  );
}

function mapEvalResult(r: Record<string, unknown>, withDetail: boolean): EvalResultRecord {
  return {
    id: toStr(r.id),
    runId: toStr(r.run_id),
    fixtureId: toStr(r.fixture_id),
    fixtureName: r.fixture_name ? toStr(r.fixture_name) : null,
    recordingId: r.recording_id ? toStr(r.recording_id) : null,
    status: toStr(r.status),
    executionId: r.execution_id ? toStr(r.execution_id) : null,
    score: r.score_json ? (JSON.parse(toStr(r.score_json)) as Record<string, unknown>) : null,
    output: r.output_json ? JSON.parse(toStr(r.output_json)) : null,
    error: r.error ? toStr(r.error) : null,
    durationMs: nullableNum(r.duration_ms),
    tokenInput: nullableNum(r.token_input),
    tokenOutput: nullableNum(r.token_output),
    tokenTotal: nullableNum(r.token_total),
    costUsd: nullableNum(r.cost_usd),
    verdict: r.verdict ? toStr(r.verdict) : null,
    ...(withDetail ? { diff: r.diff_json ? (JSON.parse(toStr(r.diff_json)) as unknown) : null } : {})
  };
}

export async function listEvalResults(ctx: PgContext, ...[runId]: Parameters<Store["listEvalResults"]>): ReturnType<Store["listEvalResults"]> {
  const rows = await ctx.query<Record<string, unknown>>(
    `SELECT id, run_id, fixture_id, fixture_name, status, execution_id,
            score_json, output_json, error, duration_ms, token_input, token_output, token_total,
            recording_id, verdict, NULL AS diff_json, cost_usd
     FROM eval_results WHERE run_id = $1 ORDER BY created_at, seq`,
    [runId]
  );
  return rows.map((r) => mapEvalResult(r, false));
}

export async function getEvalResult(ctx: PgContext, ...[runId, resultId]: Parameters<Store["getEvalResult"]>): ReturnType<Store["getEvalResult"]> {
  const row = await ctx.queryOne<Record<string, unknown>>(
    `SELECT id, run_id, fixture_id, fixture_name, status, execution_id,
            score_json, output_json, error, duration_ms, token_input, token_output, token_total,
            recording_id, verdict, diff_json, cost_usd
     FROM eval_results WHERE run_id = $1 AND id = $2`,
    [runId, resultId]
  );
  return row ? mapEvalResult(row, true) : null;
}

export async function evalFixtureIdsForRecording(ctx: PgContext, ...[recordingId]: Parameters<Store["evalFixtureIdsForRecording"]>): ReturnType<Store["evalFixtureIdsForRecording"]> {
  const rows = await ctx.query<{ id: string }>(`SELECT id FROM eval_fixtures WHERE recording_id = $1`, [recordingId]);
  return rows.map((row) => toStr(row.id));
}

export async function evalRunIdsForResults(ctx: PgContext, ...[input]: Parameters<Store["evalRunIdsForResults"]>): ReturnType<Store["evalRunIdsForResults"]> {
  const out = new Set<string>();
  const collect = async (column: "fixture_id" | "id", ids: readonly string[] | undefined) => {
    const unique = [...new Set(ids ?? [])];
    for (let start = 0; start < unique.length; start += 500) {
      const chunk = unique.slice(start, start + 500);
      const rows = await ctx.query<{ run_id: string }>(`SELECT DISTINCT run_id FROM eval_results WHERE ${column} = ANY($1::text[])`, [chunk]);
      for (const row of rows) out.add(toStr(row.run_id));
    }
  };
  await collect("fixture_id", input.fixtureIds);
  await collect("id", input.resultIds);
  return [...out];
}

export async function deleteEvalFixturesForRecording(ctx: PgContext, ...[recordingId]: Parameters<Store["deleteEvalFixturesForRecording"]>): ReturnType<Store["deleteEvalFixturesForRecording"]> {
  return rowCount(await ctx.pool.query(`DELETE FROM eval_fixtures WHERE recording_id = $1`, [recordingId]));
}
