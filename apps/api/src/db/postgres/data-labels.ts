/**
 * Phase 13.1 — PostgresStore: subject-row text paging and erasure (the data-subject lookup). Each function matches
 * the SqliteStore method of the same name.
 *
 * SQLite pages in rowid order. Postgres tables have no stable row number (ctid moves on every UPDATE), so the cursor
 * here is the row's creation time in epoch microseconds, plus one (so a row with no creation time is still after
 * the first cursor, 0). A row's creation time never changes, so a row is never skipped or read twice while the
 * lookup pages, even when rows are updated in between. Rows created in the same microsecond share a cursor value:
 * a page that ends inside such a group also returns the rest of the group, so the next page can start after it.
 */
import type { PoolClient } from "pg";
import { SUBJECT_CASSETTE_SOURCES, SUBJECT_EXECUTION_TRIGGERS, type SubjectStoreKind, type SubjectTextRow } from "../database.js";
import { type Store } from "../store.js";
import { toNum, toStr } from "./helpers.js";
import type { PgContext } from "./context.js";

export const UNIMPLEMENTED_METHODS: readonly (keyof Store)[] = [];

type Row = Record<string, unknown>;

const cursorOf = (column: string) => `(COALESCE((EXTRACT(EPOCH FROM ${column}) * 1000000)::bigint, 0) + 1)`;
const quoted = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");

/** Each kind's rows with their cursor (`rid`), as a subquery. */
const SUBJECT_QUERIES: Record<SubjectStoreKind, string> = {
  recording: `SELECT ${cursorOf("r.created_at")} AS rid, r.id, r.workflow_id, r.project_id, r.name, r.status, r.notes, r.input_json, r.node_outputs_json, r.facts_json,
                     r.mcp_cassette_json, r.model_tape_json, r.memory_seed_json, r.captured_workflow_json
              FROM replay_recordings r`,
  fixture: `SELECT ${cursorOf("f.created_at")} AS rid, f.id, d.workflow_id, d.project_id, f.name, NULL::text AS status, f.input_json, f.expected_json
            FROM eval_fixtures f LEFT JOIN eval_datasets d ON d.id = f.dataset_id`,
  eval_result: `SELECT ${cursorOf("x.created_at")} AS rid, x.id, run.workflow_id, w.project_id, COALESCE(x.fixture_name, x.id) AS name, x.status, x.output_json, x.error, x.diff_json
                FROM eval_results x LEFT JOIN eval_runs run ON run.id = x.run_id LEFT JOIN workflows w ON w.id = run.workflow_id`,
  execution: `SELECT ${cursorOf("h.created_at")} AS rid, h.id, h.workflow_id, w.project_id, COALESCE(h.workflow_name, h.id) AS name, h.status, h.input_json, h.output_json,
                     h.node_results_json, h.custom_data_json, h.error
              FROM execution_history h LEFT JOIN workflows w ON w.id = h.workflow_id
              WHERE h.trigger_type IN (${quoted(SUBJECT_EXECUTION_TRIGGERS)})`,
  cassette: `SELECT ${cursorOf("c.created_at")} AS rid, c.id, c.workflow_id, c.project_id, COALESCE(c.workflow_name, c.id) AS name, NULL::text AS status, c.cassette_json
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

/** A page of one store's searchable text, in cursor order after `afterRowid`, for the data-subject lookup. */
export async function subjectTextPage(ctx: PgContext, kind: SubjectStoreKind, afterRowid: number, limit: number): Promise<{ rows: SubjectTextRow[]; lastRowid: number | null }> {
  const select = SUBJECT_QUERIES[kind];
  const size = Math.max(1, Math.min(500, limit));
  const rows = await ctx.query<Row>(`SELECT * FROM (${select}) s WHERE s.rid > $1 ORDER BY s.rid ASC, s.id COLLATE "C" ASC LIMIT $2`, [afterRowid, size]);
  if (rows.length === 0) return { rows: [], lastRowid: null };
  const last = rows[rows.length - 1]!;
  if (rows.length === size) {
    // The rest of the last cursor value's group, so the next page (after that value) misses none of it.
    const rest = await ctx.query<Row>(`SELECT * FROM (${select}) s WHERE s.rid = $1 AND s.id COLLATE "C" > $2 ORDER BY s.id COLLATE "C" ASC`, [last.rid, toStr(last.id)]);
    rows.push(...rest);
  }
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
 * Deletes one row the data-subject lookup found, in one transaction. A golden run takes the golden-set cases made
 * from it, and the results of those cases, with it.
 */
export async function deleteSubjectRow(
  ctx: PgContext,
  kind: SubjectStoreKind,
  id: string
): Promise<{ deleted: boolean; cascaded: Array<{ kind: SubjectStoreKind; id: string }> }> {
  return ctx.withTransaction(async (client) => {
    const resultsOf = async (fixtureIds: string[]) => {
      if (fixtureIds.length === 0) return [];
      const resultIds = await ids(client, `SELECT id FROM eval_results WHERE fixture_id = ANY($1::text[]) ORDER BY created_at, id COLLATE "C"`, [fixtureIds]);
      if (resultIds.length > 0) await client.query(`DELETE FROM eval_results WHERE fixture_id = ANY($1::text[])`, [fixtureIds]);
      return resultIds.map((resultId) => ({ kind: "eval_result" as const, id: resultId }));
    };
    switch (kind) {
      case "recording": {
        const found = await client.query(`SELECT 1 FROM replay_recordings WHERE id = $1 FOR UPDATE`, [id]);
        if ((found.rowCount ?? 0) === 0) return { deleted: false, cascaded: [] };
        const fixtureIds = await ids(client, `SELECT id FROM eval_fixtures WHERE recording_id = $1 ORDER BY created_at, id COLLATE "C"`, [id]);
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
      case "execution": {
        if (!(await deleted(client, `DELETE FROM execution_history WHERE id = $1`, [id]))) return { deleted: false, cascaded: [] };
        // The run's side rows go with it: tool-call telemetry (arguments and errors), guard events and usage.
        for (const table of ["mcp_tool_calls", "guard_events", "usage_events"]) await client.query(`DELETE FROM ${table} WHERE execution_id = $1`, [id]);
        return { deleted: true, cascaded: [] };
      }
      case "cassette":
        return { deleted: await deleted(client, `DELETE FROM mcp_cassettes WHERE id = $1`, [id]), cascaded: [] };
    }
  });
}
