/**
 * Phase 13.1 — PostgresStore: subject-row text paging and erasure (the data-subject lookup). Each function matches
 * the SqliteStore method of the same name.
 *
 * SQLite pages in rowid order. Postgres has no stable row number (ctid moves on every UPDATE), so the cursor here is
 * `seq`, the identity column v40 adds to replay_recordings, eval_fixtures, eval_results, execution_history and
 * mcp_cassettes as the stand-in for rowid (each with a unique index): assigned once on insert, never reused and never
 * changed by an UPDATE, so a row that existed when the lookup started is read exactly once. Identity values are
 * drawn at insert, not at commit, so a row inserted while the lookup runs can be missed: its transaction may commit
 * after the cursor has passed a later seq. Rows written during a lookup are not part of its answer.
 */
import type { PoolClient } from "pg";
import type { SubjectStoreKind, SubjectTextRow } from "../database.js";
import { SUBJECT_CASSETTE_SOURCES, SUBJECT_EXECUTION_TRIGGERS } from "../store-shared.js";
import { type Store } from "../store.js";
import { toNum, toStr } from "./helpers.js";
import type { PgContext } from "./context.js";
import { LEGAL_HOLD_LOCK_SHARED_SQL, toPgPlaceholders } from "../legal-hold-sql.js";
import {
  CLEAR_RUN_USAGE_SQL,
  deletionTombstones,
  holdsOnAny,
  memoryArtifactErasureStatements,
  memorySessionErasureStatements,
  runErasureStatements,
  subjectRowHoldTargets,
  type ErasureStatement,
  type SubjectDeleteKind,
  type SubjectErasure,
  type SubjectRowDeletion
} from "../erasure.js";
import { parseMemoryArtifactRowId, parseMemorySessionRowId } from "../subject-store.js";
import { legalHoldsOnWith } from "./legal-holds.js";
import { writeErasureTombstonesWith } from "./erasure.js";

type Row = Record<string, unknown>;

const quoted = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");

/** Each kind's rows with their cursor (`rid`), as a subquery. */
const SUBJECT_QUERIES: Record<SubjectStoreKind, string> = {
  recording: `SELECT r.seq AS rid, r.id, r.workflow_id, r.project_id, r.name, r.status, r.notes, r.input_json, r.node_outputs_json, r.facts_json,
                     r.mcp_cassette_json, r.model_tape_json, r.memory_seed_json, r.captured_workflow_json
              FROM replay_recordings r`,
  fixture: `SELECT f.seq AS rid, f.id, d.workflow_id, d.project_id, f.name, NULL::text AS status, f.input_json, f.expected_json
            FROM eval_fixtures f LEFT JOIN eval_datasets d ON d.id = f.dataset_id`,
  eval_result: `SELECT x.seq AS rid, x.id, run.workflow_id, w.project_id, COALESCE(x.fixture_name, x.id) AS name, x.status, x.output_json, x.error, x.diff_json
                FROM eval_results x LEFT JOIN eval_runs run ON run.id = x.run_id LEFT JOIN workflows w ON w.id = run.workflow_id`,
  execution: `SELECT h.seq AS rid, h.id, h.workflow_id, w.project_id, COALESCE(h.workflow_name, h.id) AS name, h.status, h.input_json, h.output_json,
                     h.node_results_json, h.custom_data_json, h.error
              FROM execution_history h LEFT JOIN workflows w ON w.id = h.workflow_id
              WHERE h.trigger_type IN (${quoted(SUBJECT_EXECUTION_TRIGGERS)})`,
  cassette: `SELECT c.seq AS rid, c.id, c.workflow_id, c.project_id, COALESCE(c.workflow_name, c.id) AS name, NULL::text AS status, c.cassette_json
             FROM mcp_cassettes c WHERE c.source IN (${quoted(SUBJECT_CASSETTE_SOURCES)})`
};

const SUBJECT_TEXT_COLUMNS: Record<SubjectStoreKind, Record<string, string>> = {
  recording: {
    input: "input_json",
    nodes: "node_outputs_json",
    facts: "facts_json",
    cassette: "mcp_cassette_json",
    modelTape: "model_tape_json",
    memorySeed: "memory_seed_json",
    workflow: "captured_workflow_json",
    notes: "notes"
  },
  fixture: { input: "input_json", expected: "expected_json" },
  eval_result: { output: "output_json", error: "error", diff: "diff_json" },
  execution: { input: "input_json", output: "output_json", nodes: "node_results_json", customData: "custom_data_json", error: "error" },
  cassette: { cassette: "cassette_json" }
};

function mapSubjectTextRow(kind: SubjectStoreKind, row: Row): SubjectTextRow {
  const texts: Record<string, string | null> = {};
  for (const [field, column] of Object.entries(SUBJECT_TEXT_COLUMNS[kind])) texts[field] = typeof row[column] === "string" ? (row[column] as string) : null;
  return {
    kind,
    id: toStr(row.id),
    workflowId: typeof row.workflow_id === "string" ? row.workflow_id : null,
    projectId: typeof row.project_id === "string" ? row.project_id : null,
    name: toStr(row.name),
    status: typeof row.status === "string" ? row.status : null,
    texts
  };
}

/** A page of one store's searchable text, in `seq` order after `afterRowid`, for the data-subject lookup. */
export async function subjectTextPage(ctx: PgContext, kind: SubjectStoreKind, afterRowid: number, limit: number): Promise<{ rows: SubjectTextRow[]; lastRowid: number | null }> {
  const select = SUBJECT_QUERIES[kind];
  const size = Math.max(1, Math.min(500, limit));
  const rows = await ctx.query<Row>(`SELECT * FROM (${select}) s WHERE s.rid > $1 ORDER BY s.rid ASC LIMIT $2`, [afterRowid, size]);
  if (rows.length === 0) return { rows: [], lastRowid: null };
  const last = rows[rows.length - 1]!;
  return { rows: rows.map((row) => mapSubjectTextRow(kind, row)), lastRowid: toNum(last.rid) };
}

/** One row's searchable text (null when it is gone or not in the searched set). */
export async function subjectTextRow(ctx: PgContext, kind: SubjectStoreKind, id: string): Promise<SubjectTextRow | null> {
  const row = await ctx.queryOne<Row>(`SELECT * FROM (${SUBJECT_QUERIES[kind]}) s WHERE s.id = $1`, [id]);
  return row ? mapSubjectTextRow(kind, row) : null;
}

/** Rows the data-subject lookup searches, per store. */
export async function countSubjectRows(ctx: PgContext, kind: SubjectStoreKind): Promise<number> {
  const row = await ctx.queryOne<{ count: unknown }>(`SELECT COUNT(*) AS count FROM (${SUBJECT_QUERIES[kind]}) s`);
  return row ? toNum(row.count) : 0;
}

async function ids(client: PoolClient, sql: string, params: unknown[]): Promise<string[]> {
  return (await client.query<{ id: string }>(sql, params)).rows.map((row) => toStr(row.id));
}

async function deleted(client: PoolClient, sql: string, params: unknown[]): Promise<boolean> {
  return ((await client.query(sql, params)).rowCount ?? 0) > 0;
}

/**
 * Deletes one row a data-subject lookup or request found, with what belongs to it, in one transaction (as on SQLite;
 * db/erasure.ts). The legal-hold lock is taken shared first, then the holds are checked; with `erasure`, tombstones
 * are written in the same transaction.
 */
export async function deleteSubjectRow(ctx: PgContext, kind: SubjectDeleteKind, id: string, erasure?: SubjectErasure): Promise<SubjectRowDeletion> {
  return ctx.withTransaction(async (client) => {
    // 13.3 — a row a legal hold keeps stays: the lock first (shared, to commit), then the check.
    await client.query(LEGAL_HOLD_LOCK_SHARED_SQL);
    const heldBy = await holdsOnAny(subjectRowHoldTargets(kind, id), async (target) => await legalHoldsOnWith(client, target));
    if (heldBy.length > 0) return { deleted: false, cascaded: [], heldBy };
    const outcome = await deleteSubjectRowWith(client, kind, id);
    if (erasure) await writeErasureTombstonesWith(client, deletionTombstones(kind, id, outcome, erasure));
    return outcome;
  });
}

async function runStatements(client: PoolClient, statements: ErasureStatement[]): Promise<number> {
  let changed = 0;
  for (const statement of statements) changed += (await client.query(toPgPlaceholders(statement.sql), statement.params)).rowCount ?? 0;
  return changed;
}

async function deleteSubjectRowWith(client: PoolClient, kind: SubjectDeleteKind, id: string): Promise<SubjectRowDeletion> {
  const resultsOf = async (fixtureIds: string[]) => {
    if (fixtureIds.length === 0) return [];
    const resultIds = await ids(client, `SELECT id FROM eval_results WHERE fixture_id = ANY($1::text[]) ORDER BY seq`, [fixtureIds]);
    if (resultIds.length > 0) await client.query(`DELETE FROM eval_results WHERE fixture_id = ANY($1::text[])`, [fixtureIds]);
    return resultIds.map((resultId) => ({ kind: "eval_result" as const, id: resultId }));
  };
  switch (kind) {
    case "recording": {
      const found = await client.query(`SELECT 1 FROM replay_recordings WHERE id = $1 FOR UPDATE`, [id]);
      if ((found.rowCount ?? 0) === 0) return { deleted: false, cascaded: [] };
      const fixtureIds = await ids(client, `SELECT id FROM eval_fixtures WHERE recording_id = $1 ORDER BY seq`, [id]);
      const cascaded = [...(await resultsOf(fixtureIds)), ...fixtureIds.map((fixtureId) => ({ kind: "fixture" as const, id: fixtureId }))];
      await client.query(`DELETE FROM eval_fixtures WHERE recording_id = $1`, [id]);
      return { deleted: await deleted(client, `DELETE FROM replay_recordings WHERE id = $1`, [id]), cascaded };
    }
    case "fixture": {
      const cascaded = await resultsOf([id]);
      return { deleted: await deleted(client, `DELETE FROM eval_fixtures WHERE id = $1`, [id]), cascaded };
    }
    case "eval_result":
      return { deleted: await deleted(client, `DELETE FROM eval_results WHERE id = $1`, [id]), cascaded: [] };
    case "execution":
    case "production_execution":
    case "paused_run": {
      const found = await client.query(
        `SELECT 1 FROM execution_history WHERE id = $1 UNION ALL SELECT 1 FROM workflow_executions WHERE id = $1`,
        [id]
      );
      if ((found.rowCount ?? 0) === 0) return { deleted: false, cascaded: [] };
      // 13.3 — usage rows stay with the person cleared (totals and budgets do not move); the rest of the run goes.
      const usageCleared = (await client.query(toPgPlaceholders(CLEAR_RUN_USAGE_SQL), [id])).rowCount ?? 0;
      await runStatements(client, runErasureStatements(id));
      return { deleted: true, cascaded: [], usageCleared };
    }
    case "approval":
      return { deleted: await deleted(client, `DELETE FROM approval_requests WHERE id = $1`, [id]), cascaded: [] };
    case "cassette":
    case "cassette_any":
      return { deleted: await deleted(client, `DELETE FROM mcp_cassettes WHERE id = $1`, [id]), cascaded: [] };
    case "memory_session": {
      const key = parseMemorySessionRowId(id);
      return { deleted: key ? (await runStatements(client, memorySessionErasureStatements(key.namespace, key.sessionId))) > 0 : false, cascaded: [] };
    }
    case "memory_artifact": {
      const key = parseMemoryArtifactRowId(id);
      return {
        deleted: key ? (await runStatements(client, memoryArtifactErasureStatements(key.namespace, key.sessionId, key.artifactKey))) > 0 : false,
        cascaded: []
      };
    }
  }
}
