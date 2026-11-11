/**
 * 13.3 — PostgresStore: the data-subject tables (v67) and lookups. Each function matches the SqliteStore method of the
 * same name (subject-sqlite.ts).
 *
 * Scan cursors: runs and cassettes page by `seq` (v40's stand-in for rowid); paused runs and approvals by id; agent
 * memory by its primary key. Each cursor is opaque text to the caller. Rows written while a scan runs may be missed
 * (as in the data-subject lookup): they are not part of its answer.
 */
import type { SubjectTextRow } from "../database.js";
import { SUBJECT_CASSETTE_SOURCES, SUBJECT_EXECUTION_TRIGGERS } from "../store-shared.js";
import {
  STAFF_SECTION_SQL,
  STAFF_SUBJECT_ROWS_CAP,
  SUBJECT_REQUEST_COLUMNS,
  mapSubjectExportRow,
  mapSubjectRefRow,
  mapSubjectRequestRow,
  mapSubjectScanRow,
  numbered,
  plainRow,
  scanRowId,
  scanRowParams,
  staffEmailsOf,
  subjectRequestPatchSql,
  subjectRequestValues,
  type StaffSubjectRows,
  type SubjectExportWrite,
  type SubjectRefWrite,
  type SubjectRequestPatch,
  type SubjectRequestRecord,
  type SubjectScanKind
} from "../subject-store.js";
import type { SubjectRequestStatus } from "@ai-orchestrator/shared";
import type { PgContext } from "./context.js";

type Row = Record<string, unknown>;

const quoted = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");
const SUBJECT_KEY_ID = "default";

/**
 * Each scan kind: its rows as a subquery with the cursor columns, how the cursor compares, the order, and the lookup by
 * id. `cursor` turns the last row into the opaque cursor; `after` turns a cursor into the parameters of `compare`.
 */
interface ScanQuery {
  select: string;
  compare: string;
  order: string;
  cursor: (row: Row) => string;
  after: (cursor: string) => unknown[] | null;
  byId: string;
}

const seqCursor = (row: Row) => String(row.rid);
const seqAfter = (cursor: string) => {
  const n = Number(cursor);
  return Number.isFinite(n) ? [n] : null;
};
const idCursor = (row: Row) => String(row.id);
const jsonAfter = (size: number) => (cursor: string) => {
  try {
    const parsed: unknown = JSON.parse(cursor);
    return Array.isArray(parsed) && parsed.length === size && parsed.every((part) => typeof part === "string") ? parsed : null;
  } catch {
    return null;
  }
};

const SCAN_QUERIES: Record<SubjectScanKind, ScanQuery> = {
  production_execution: {
    select: `SELECT h.seq AS rid, h.id, h.workflow_id, w.project_id, COALESCE(h.workflow_name, h.id) AS name, h.status, h.input_json, h.output_json,
                    h.node_results_json, h.custom_data_json, h.error
             FROM execution_history h LEFT JOIN workflows w ON w.id = h.workflow_id
             WHERE (h.trigger_type IS NULL OR h.trigger_type NOT IN (${quoted(SUBJECT_EXECUTION_TRIGGERS)}))`,
    compare: "s.rid > $1",
    order: "s.rid",
    cursor: seqCursor,
    after: seqAfter,
    byId: `SELECT h.id, h.workflow_id, w.project_id, COALESCE(h.workflow_name, h.id) AS name, h.status, h.input_json, h.output_json,
                  h.node_results_json, h.custom_data_json, h.error
           FROM execution_history h LEFT JOIN workflows w ON w.id = h.workflow_id WHERE h.id = $1`
  },
  paused_run: {
    select: `SELECT e.id, e.workflow_id, w.project_id, COALESCE(e.workflow_name, e.id) AS name, e.status, e.state_json, e.approval_message
             FROM workflow_executions e LEFT JOIN workflows w ON w.id = e.workflow_id`,
    compare: "s.id > $1",
    order: "s.id",
    cursor: idCursor,
    after: (cursor) => [cursor],
    byId: `SELECT e.id, e.workflow_id, w.project_id, COALESCE(e.workflow_name, e.id) AS name, e.status, e.state_json, e.approval_message
           FROM workflow_executions e LEFT JOIN workflows w ON w.id = e.workflow_id WHERE e.id = $1`
  },
  approval: {
    select: `SELECT a.id, a.workflow_id, a.project_id, COALESCE(a.workflow_name, a.id) AS name, a.status, a.message, a.details_json, a.spec_json,
                    a.edits_json, a.reason
             FROM approval_requests a`,
    compare: "s.id > $1",
    order: "s.id",
    cursor: idCursor,
    after: (cursor) => [cursor],
    byId: `SELECT a.id, a.workflow_id, a.project_id, COALESCE(a.workflow_name, a.id) AS name, a.status, a.message, a.details_json, a.spec_json,
                  a.edits_json, a.reason
           FROM approval_requests a WHERE a.id = $1`
  },
  memory_session: {
    select: `SELECT m.namespace, m.session_id, m.namespace AS name, NULL::text AS status, m.messages_json FROM session_memory m`,
    compare: "(s.namespace, s.session_id) > ($1, $2)",
    order: "s.namespace, s.session_id",
    cursor: (row) => JSON.stringify([String(row.namespace), String(row.session_id)]),
    after: jsonAfter(2),
    byId: `SELECT m.namespace, m.session_id, m.namespace AS name, NULL::text AS status, m.messages_json FROM session_memory m
           WHERE m.namespace = $1 AND m.session_id = $2`
  },
  memory_artifact: {
    select: `SELECT a.namespace, a.session_id, a.artifact_key, a.artifact_key AS name, NULL::text AS status, a.value_json FROM session_artifacts a`,
    compare: "(s.namespace, s.session_id, s.artifact_key) > ($1, $2, $3)",
    order: "s.namespace, s.session_id, s.artifact_key",
    cursor: (row) => JSON.stringify([String(row.namespace), String(row.session_id), String(row.artifact_key)]),
    after: jsonAfter(3),
    byId: `SELECT a.namespace, a.session_id, a.artifact_key, a.artifact_key AS name, NULL::text AS status, a.value_json FROM session_artifacts a
           WHERE a.namespace = $1 AND a.session_id = $2 AND a.artifact_key = $3`
  },
  cassette_any: {
    select: `SELECT c.seq AS rid, c.id, c.workflow_id, c.project_id, COALESCE(c.workflow_name, c.id) AS name, NULL::text AS status, c.cassette_json
             FROM mcp_cassettes c WHERE c.source NOT IN (${quoted(SUBJECT_CASSETTE_SOURCES)})`,
    compare: "s.rid > $1",
    order: "s.rid",
    cursor: seqCursor,
    after: seqAfter,
    byId: `SELECT c.id, c.workflow_id, c.project_id, COALESCE(c.workflow_name, c.id) AS name, NULL::text AS status, c.cassette_json
           FROM mcp_cassettes c WHERE c.id = $1`
  }
};

/** A memory session reference's keys, or nothing for a row id that is not one (such a reference is an orphan). */
const MEMORY_KEY = (index: number) => `(CASE WHEN r.row_id LIKE '[%' THEN (r.row_id::jsonb ->> ${index}) END)`;
const ORPHAN_REFS_WHERE = `(r.kind = 'run' AND NOT EXISTS (SELECT 1 FROM execution_history h WHERE h.id = r.row_id))
   OR (r.kind = 'memory_session'
       AND NOT EXISTS (SELECT 1 FROM session_memory m WHERE m.namespace = ${MEMORY_KEY(0)} AND m.session_id = ${MEMORY_KEY(1)})
       AND NOT EXISTS (SELECT 1 FROM session_artifacts a WHERE a.namespace = ${MEMORY_KEY(0)} AND a.session_id = ${MEMORY_KEY(1)}))`;

export async function getSubjectRefKey(ctx: PgContext): Promise<string | null> {
  return (await ctx.queryOne<{ key_sealed: string }>("SELECT key_sealed FROM subject_ref_keys WHERE id = $1", [SUBJECT_KEY_ID]))?.key_sealed ?? null;
}

export async function initSubjectRefKey(ctx: PgContext, sealed: string, createdAt: string): Promise<string> {
  await ctx.execute("INSERT INTO subject_ref_keys (id, key_sealed, created_at) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING", [
    SUBJECT_KEY_ID,
    sealed,
    createdAt
  ]);
  return (await getSubjectRefKey(ctx))!;
}

export async function addSubjectRefs(ctx: PgContext, refs: SubjectRefWrite[]): Promise<void> {
  if (refs.length === 0) return;
  const values: unknown[] = [];
  const tuples = refs.map((ref) => {
    values.push(ref.hash, ref.kind, ref.rowId, ref.projectId, ref.workflowId, ref.createdAt);
    const base = values.length - 6;
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
  });
  await ctx.execute(
    `INSERT INTO subject_refs (hash, kind, row_id, project_id, workflow_id, created_at) VALUES ${tuples.join(", ")}
     ON CONFLICT (hash, kind, row_id) DO NOTHING`,
    values
  );
}

export async function listSubjectRefs(ctx: PgContext, hash: string, limit: number) {
  const rows = await ctx.query<Row>(
    `SELECT kind, row_id, project_id, workflow_id, created_at FROM subject_refs WHERE hash = $1
     ORDER BY created_at, kind COLLATE "C", row_id COLLATE "C" LIMIT $2`,
    [hash, Math.max(1, Math.floor(limit))]
  );
  return rows.map(mapSubjectRefRow);
}

export async function pruneOrphanSubjectRefs(ctx: PgContext, limit: number): Promise<number> {
  const cap = Math.max(0, Math.floor(limit));
  if (cap === 0) return 0;
  const result = await ctx.pool.query(
    `DELETE FROM subject_refs WHERE ctid IN (SELECT r.ctid FROM subject_refs r WHERE ${ORPHAN_REFS_WHERE} LIMIT $1 FOR UPDATE SKIP LOCKED)`,
    [cap]
  );
  return result.rowCount ?? 0;
}

export async function createSubjectRequest(ctx: PgContext, record: SubjectRequestRecord): Promise<void> {
  const columns = SUBJECT_REQUEST_COLUMNS.split(",");
  await ctx.execute(
    `INSERT INTO subject_requests (${SUBJECT_REQUEST_COLUMNS}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
    subjectRequestValues(record)
  );
}

export async function getSubjectRequest(ctx: PgContext, id: string): Promise<SubjectRequestRecord | null> {
  const row = await ctx.queryOne<Row>(`SELECT ${SUBJECT_REQUEST_COLUMNS} FROM subject_requests WHERE id = $1`, [id]);
  return row ? mapSubjectRequestRow(row) : null;
}

export async function listSubjectRequests(ctx: PgContext, input: { limit: number; statuses?: SubjectRequestStatus[] }): Promise<SubjectRequestRecord[]> {
  const size = Math.max(1, Math.min(500, Math.floor(input.limit)));
  if (input.statuses && input.statuses.length === 0) return [];
  const rows = input.statuses
    ? await ctx.query<Row>(
        `SELECT ${SUBJECT_REQUEST_COLUMNS} FROM subject_requests WHERE status = ANY($1::text[]) ORDER BY created_at DESC, id COLLATE "C" DESC LIMIT $2`,
        [input.statuses, size]
      )
    : await ctx.query<Row>(`SELECT ${SUBJECT_REQUEST_COLUMNS} FROM subject_requests ORDER BY created_at DESC, id COLLATE "C" DESC LIMIT $1`, [size]);
  return rows.map(mapSubjectRequestRow);
}

export async function updateSubjectRequest(ctx: PgContext, id: string, patch: SubjectRequestPatch, expectStatus?: SubjectRequestStatus): Promise<boolean> {
  const { set, values } = subjectRequestPatchSql(patch, (n) => `$${n}`);
  const params = [...values, id];
  let where = `id = $${params.length}`;
  if (expectStatus) {
    params.push(expectStatus);
    where += ` AND status = $${params.length}`;
  }
  const result = await ctx.pool.query(`UPDATE subject_requests SET ${set} WHERE ${where}`, params);
  return (result.rowCount ?? 0) > 0;
}

const INSERT_EXPORT_SQL = `INSERT INTO subject_exports (id, request_id, sealed_blob, bytes, sha256, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
   ON CONFLICT (request_id) DO NOTHING`;
const exportParams = (input: SubjectExportWrite) => [input.id, input.requestId, input.sealedBlob, input.bytes, input.sha256, input.createdAt, input.expiresAt];

export async function saveSubjectExport(ctx: PgContext, input: SubjectExportWrite): Promise<void> {
  await ctx.execute(INSERT_EXPORT_SQL, exportParams(input));
}

export async function completeSubjectRequest(ctx: PgContext, id: string, patch: SubjectRequestPatch, exported: SubjectExportWrite): Promise<boolean> {
  const { set, values } = subjectRequestPatchSql(patch, (n) => `$${n}`);
  return await ctx.withTransaction(async (client) => {
    const updated = await client.query(`UPDATE subject_requests SET ${set} WHERE id = $${values.length + 1} AND status = 'searching'`, [...values, id]);
    if ((updated.rowCount ?? 0) === 0) return false;
    await client.query(INSERT_EXPORT_SQL, exportParams(exported));
    return true;
  });
}

export async function listOverdueSubjectRequests(ctx: PgContext, at: string, limit: number): Promise<SubjectRequestRecord[]> {
  const rows = await ctx.query<Row>(
    `SELECT ${SUBJECT_REQUEST_COLUMNS} FROM subject_requests
     WHERE status IN ('searching', 'ready') AND due_notified_at IS NULL AND due_at < $1 ORDER BY due_at, id COLLATE "C" LIMIT $2`,
    [at, Math.max(1, Math.min(500, Math.floor(limit)))]
  );
  return rows.map(mapSubjectRequestRow);
}

export async function expireReadySubjectRequestsWithoutExport(ctx: PgContext, at: string): Promise<string[]> {
  const rows = await ctx.query<{ id: string }>(
    `UPDATE subject_requests r SET status = 'expired', updated_at = $1
     WHERE r.status = 'ready' AND NOT EXISTS (SELECT 1 FROM subject_exports e WHERE e.request_id = r.id) RETURNING r.id`,
    [at]
  );
  return rows.map((row) => String(row.id));
}

export async function getSubjectExport(ctx: PgContext, requestId: string) {
  const row = await ctx.queryOne<Row>(
    `SELECT id, request_id, bytes, sha256, created_at, expires_at, downloaded_at, downloaded_by, (sealed_blob <> '') AS stored
     FROM subject_exports WHERE request_id = $1`,
    [requestId]
  );
  return row ? mapSubjectExportRow(row) : null;
}

export async function claimSubjectExport(ctx: PgContext, input: { requestId: string; by: string; at: string }): Promise<string | null> {
  // One statement: the row is locked while its file is read and cleared, so two downloads at once give it to one.
  const row = await ctx.queryOne<{ sealed_blob: string }>(
    `WITH taken AS (
       SELECT request_id, sealed_blob FROM subject_exports
       WHERE request_id = $1 AND downloaded_at IS NULL AND expires_at > $2 AND sealed_blob <> ''
       FOR UPDATE
     )
     UPDATE subject_exports e SET downloaded_at = $2, downloaded_by = $3, sealed_blob = ''
     FROM taken WHERE e.request_id = taken.request_id
     RETURNING taken.sealed_blob`,
    [input.requestId, input.at, input.by]
  );
  return row?.sealed_blob ?? null;
}

export async function expireSubjectExports(ctx: PgContext, at: string): Promise<string[]> {
  const rows = await ctx.query<{ request_id: string }>(
    `UPDATE subject_exports SET sealed_blob = '' WHERE downloaded_at IS NULL AND expires_at <= $1 AND sealed_blob <> '' RETURNING request_id`,
    [at]
  );
  return rows.map((row) => String(row.request_id));
}

export async function subjectScanPage(ctx: PgContext, kind: SubjectScanKind, after: string | null, limit: number): Promise<{ rows: SubjectTextRow[]; next: string | null }> {
  const query = SCAN_QUERIES[kind];
  const size = Math.max(1, Math.min(500, Math.floor(limit)));
  const afterParams = after === null ? null : query.after(after);
  const rows =
    afterParams === null
      ? await ctx.query<Row>(`SELECT * FROM (${query.select}) s ORDER BY ${query.order} LIMIT $1`, [size])
      : await ctx.query<Row>(
          `SELECT * FROM (${query.select}) s WHERE ${query.compare} ORDER BY ${query.order} LIMIT $${afterParams.length + 1}`,
          [...afterParams, size]
        );
  return {
    rows: rows.map((row) => mapSubjectScanRow(kind, row, scanRowId(kind, row))),
    next: rows.length > 0 ? query.cursor(rows[rows.length - 1]!) : null
  };
}

export async function subjectScanRow(ctx: PgContext, kind: SubjectScanKind, id: string): Promise<SubjectTextRow | null> {
  const params = scanRowParams(kind, id);
  if (!params) return null;
  const row = await ctx.queryOne<Row>(SCAN_QUERIES[kind].byId, params);
  return row ? mapSubjectScanRow(kind, row, scanRowId(kind, row)) : null;
}

export async function memorySessionSubjectRows(ctx: PgContext, namespace: string, sessionId: string): Promise<SubjectTextRow[]> {
  const rows: SubjectTextRow[] = [];
  const session = await ctx.queryOne<Row>(SCAN_QUERIES.memory_session.byId, [namespace, sessionId]);
  if (session) rows.push(mapSubjectScanRow("memory_session", session, scanRowId("memory_session", session)));
  const artifacts = await ctx.query<Row>(
    `SELECT a.namespace, a.session_id, a.artifact_key, a.artifact_key AS name, NULL::text AS status, a.value_json
     FROM session_artifacts a WHERE a.namespace = $1 AND a.session_id = $2 ORDER BY a.artifact_key COLLATE "C"`,
    [namespace, sessionId]
  );
  for (const artifact of artifacts) rows.push(mapSubjectScanRow("memory_artifact", artifact, scanRowId("memory_artifact", artifact)));
  return rows;
}

export async function staffSubjectRows(ctx: PgContext, email: string): Promise<StaffSubjectRows> {
  const cap = STAFF_SUBJECT_ROWS_CAP;
  const all = async (sql: string, params: unknown[]) => (await ctx.query<Row>(numbered(sql), params)).map(plainRow);
  const user = await ctx.queryOne<Row>(numbered(STAFF_SECTION_SQL.user), [email]);
  const userId = user ? String(user.id) : null;
  const byUser = async (sql: string) => (userId ? await all(sql, [userId, cap]) : []);
  const emails = staffEmailsOf(user, email);
  return {
    user: user ? plainRow(user) : null,
    ssoIdentities: await byUser(STAFF_SECTION_SQL.ssoIdentities),
    projectRoles: await byUser(STAFF_SECTION_SQL.projectRoles),
    apiKeys: await byUser(STAFF_SECTION_SQL.apiKeys),
    runsTriggered: await all(STAFF_SECTION_SQL.runsTriggered, [...emails, cap]),
    workflowsCreated: await all(STAFF_SECTION_SQL.workflowsCreated, [...emails, cap]),
    approvals: await all(STAFF_SECTION_SQL.approvals, [...emails, ...emails, cap]),
    evalRuns: await all(STAFF_SECTION_SQL.evalRuns, [...emails, cap]),
    releasesPublished: await all(STAFF_SECTION_SQL.releasesPublished, [...emails, cap]),
    auditEntries: await all(STAFF_SECTION_SQL.auditEntries, [...emails, userId ?? "", cap])
  };
}
