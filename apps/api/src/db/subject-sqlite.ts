/**
 * 13.3 — SqliteStore's data-subject tables (v67) and lookups. Each function matches the SubjectStore method of the
 * same name; SqliteStore delegates to them. The tables are created in SqliteStore.migrate (ensureSubjectSchema).
 *
 * Scans page in rowid order (every table read here has one), so the cursor is the last rowid as text.
 */
import type { Database as BetterSqlite3Database } from "better-sqlite3";
import type { SubjectTextRow } from "./database.js";
import { SUBJECT_CASSETTE_SOURCES, SUBJECT_EXECUTION_TRIGGERS } from "./store-shared.js";
import {
  STAFF_SECTION_SQL,
  STAFF_SUBJECT_ROWS_CAP,
  SUBJECT_REQUEST_COLUMNS,
  mapSubjectExportRow,
  mapSubjectRefRow,
  mapSubjectRequestRow,
  mapSubjectScanRow,
  plainRow,
  scanRowId,
  scanRowParams,
  staffEmailsOf,
  subjectRequestPatchSql,
  subjectRequestValues,
  type StaffSubjectRows,
  type SubjectExportWrite,
  type SubjectScanKind,
  type SubjectStore
} from "./subject-store.js";

type Row = Record<string, unknown>;

/** The v67 tables, as the Postgres chain creates them (TEXT timestamps). */
export function ensureSubjectSchema(db: BetterSqlite3Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS subject_ref_keys (
      id TEXT PRIMARY KEY,
      key_sealed TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS subject_refs (
      hash TEXT NOT NULL,
      kind TEXT NOT NULL,
      row_id TEXT NOT NULL,
      project_id TEXT,
      workflow_id TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (hash, kind, row_id)
    );
    CREATE INDEX IF NOT EXISTS idx_subject_refs_row ON subject_refs(kind, row_id);
    CREATE INDEX IF NOT EXISTS idx_subject_refs_created ON subject_refs(created_at);
    CREATE TABLE IF NOT EXISTS subject_requests (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      subject_kind TEXT NOT NULL,
      query_hash TEXT NOT NULL,
      value_sealed TEXT,
      scan INTEGER NOT NULL DEFAULT 1,
      reveal_tokens INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      due_at TEXT NOT NULL,
      due_notified_at TEXT,
      counts_json TEXT NOT NULL DEFAULT '{}',
      progress_json TEXT NOT NULL DEFAULT '{}',
      deferred_json TEXT NOT NULL DEFAULT '[]',
      created_by TEXT,
      created_by_user_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_subject_requests_status ON subject_requests(status);
    CREATE INDEX IF NOT EXISTS idx_subject_requests_created ON subject_requests(created_at);
    CREATE TABLE IF NOT EXISTS subject_exports (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      sealed_blob TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      downloaded_at TEXT,
      downloaded_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_subject_exports_expires ON subject_exports(expires_at);
  `);
}

/** The v69 table (erasure tombstones), as the Postgres chain creates it (TEXT timestamps). */
export function ensureErasureSchema(db: BetterSqlite3Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS erasure_tombstones (
      kind TEXT NOT NULL,
      row_id TEXT NOT NULL,
      request_id TEXT,
      erased_at TEXT NOT NULL,
      PRIMARY KEY (kind, row_id)
    );
    CREATE INDEX IF NOT EXISTS idx_erasure_tombstones_erased ON erasure_tombstones(erased_at);
  `);
}

const quoted = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");

/** Each scan kind's rows with `rid` (the cursor) and `id`. `{where}` takes the extra condition. */
const SCAN_QUERIES: Record<SubjectScanKind, { select: string; rowid: string; byId: string }> = {
  production_execution: {
    select: `SELECT h.rowid AS rid, h.id, h.workflow_id, w.project_id, COALESCE(h.workflow_name, h.id) AS name, h.status, h.input_json, h.output_json,
                    h.node_results_json, h.custom_data_json, h.error
             FROM execution_history h LEFT JOIN workflows w ON w.id = h.workflow_id
             WHERE (h.trigger_type IS NULL OR h.trigger_type NOT IN (${quoted(SUBJECT_EXECUTION_TRIGGERS)}))`,
    rowid: "h.rowid",
    byId: `SELECT h.id, h.workflow_id, w.project_id, COALESCE(h.workflow_name, h.id) AS name, h.status, h.input_json, h.output_json,
                  h.node_results_json, h.custom_data_json, h.error
           FROM execution_history h LEFT JOIN workflows w ON w.id = h.workflow_id WHERE h.id = ?`
  },
  paused_run: {
    select: `SELECT e.rowid AS rid, e.id, e.workflow_id, w.project_id, COALESCE(e.workflow_name, e.id) AS name, e.status, e.state_json, e.approval_message
             FROM workflow_executions e LEFT JOIN workflows w ON w.id = e.workflow_id WHERE 1 = 1`,
    rowid: "e.rowid",
    byId: `SELECT e.id, e.workflow_id, w.project_id, COALESCE(e.workflow_name, e.id) AS name, e.status, e.state_json, e.approval_message
           FROM workflow_executions e LEFT JOIN workflows w ON w.id = e.workflow_id WHERE e.id = ?`
  },
  approval: {
    select: `SELECT a.rowid AS rid, a.id, a.workflow_id, a.project_id, COALESCE(a.workflow_name, a.id) AS name, a.status, a.message, a.details_json,
                    a.spec_json, a.edits_json, a.reason
             FROM approval_requests a WHERE 1 = 1`,
    rowid: "a.rowid",
    byId: `SELECT a.id, a.workflow_id, a.project_id, COALESCE(a.workflow_name, a.id) AS name, a.status, a.message, a.details_json, a.spec_json,
                  a.edits_json, a.reason
           FROM approval_requests a WHERE a.id = ?`
  },
  memory_session: {
    select: `SELECT m.rowid AS rid, m.namespace, m.session_id, m.namespace AS name, NULL AS status, m.messages_json FROM session_memory m WHERE 1 = 1`,
    rowid: "m.rowid",
    byId: `SELECT m.namespace, m.session_id, m.namespace AS name, NULL AS status, m.messages_json FROM session_memory m WHERE m.namespace = ? AND m.session_id = ?`
  },
  memory_artifact: {
    select: `SELECT s.rowid AS rid, s.namespace, s.session_id, s.artifact_key, s.artifact_key AS name, NULL AS status, s.value_json FROM session_artifacts s WHERE 1 = 1`,
    rowid: "s.rowid",
    byId: `SELECT s.namespace, s.session_id, s.artifact_key, s.artifact_key AS name, NULL AS status, s.value_json
           FROM session_artifacts s WHERE s.namespace = ? AND s.session_id = ? AND s.artifact_key = ?`
  },
  cassette_any: {
    select: `SELECT c.rowid AS rid, c.id, c.workflow_id, c.project_id, COALESCE(c.workflow_name, c.id) AS name, NULL AS status, c.cassette_json
             FROM mcp_cassettes c WHERE c.source NOT IN (${quoted(SUBJECT_CASSETTE_SOURCES)})`,
    rowid: "c.rowid",
    byId: `SELECT c.id, c.workflow_id, c.project_id, COALESCE(c.workflow_name, c.id) AS name, NULL AS status, c.cassette_json FROM mcp_cassettes c WHERE c.id = ?`
  }
};

/** References whose run, or memory session (with its artifacts), is gone. */
const ORPHAN_REFS_WHERE = `(r.kind = 'run' AND NOT EXISTS (SELECT 1 FROM execution_history h WHERE h.id = r.row_id))
   OR (r.kind = 'memory_session' AND (
        json_valid(r.row_id) = 0
        OR (NOT EXISTS (SELECT 1 FROM session_memory m WHERE m.namespace = json_extract(r.row_id, '$[0]') AND m.session_id = json_extract(r.row_id, '$[1]'))
            AND NOT EXISTS (SELECT 1 FROM session_artifacts s WHERE s.namespace = json_extract(r.row_id, '$[0]') AND s.session_id = json_extract(r.row_id, '$[1]')))))`;

const SUBJECT_KEY_ID = "default";

export function sqliteSubjectStore(db: BetterSqlite3Database): SubjectStore {
  const all = <T = Row>(sql: string, params: unknown[] = []): T[] => db.prepare(sql).all(...params) as T[];
  const one = <T = Row>(sql: string, params: unknown[] = []): T | null => (db.prepare(sql).get(...params) as T | undefined) ?? null;
  const run = (sql: string, params: unknown[] = []) => db.prepare(sql).run(...params);

  const insertExport = (input: SubjectExportWrite): void => {
    run(
      `INSERT INTO subject_exports (id, request_id, sealed_blob, bytes, sha256, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (request_id) DO NOTHING`,
      [input.id, input.requestId, input.sealedBlob, input.bytes, input.sha256, input.createdAt, input.expiresAt]
    );
  };

  return {
    async getSubjectRefKey() {
      return one<{ key_sealed: string }>("SELECT key_sealed FROM subject_ref_keys WHERE id = ?", [SUBJECT_KEY_ID])?.key_sealed ?? null;
    },

    async initSubjectRefKey(sealed, createdAt) {
      run("INSERT INTO subject_ref_keys (id, key_sealed, created_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING", [SUBJECT_KEY_ID, sealed, createdAt]);
      return one<{ key_sealed: string }>("SELECT key_sealed FROM subject_ref_keys WHERE id = ?", [SUBJECT_KEY_ID])!.key_sealed;
    },

    async addSubjectRefs(refs) {
      if (refs.length === 0) return;
      const insert = db.prepare(
        `INSERT INTO subject_refs (hash, kind, row_id, project_id, workflow_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (hash, kind, row_id) DO NOTHING`
      );
      db.transaction(() => {
        for (const ref of refs) insert.run(ref.hash, ref.kind, ref.rowId, ref.projectId, ref.workflowId, ref.createdAt);
      })();
    },

    async listSubjectRefs(hash, limit) {
      return all(
        "SELECT kind, row_id, project_id, workflow_id, created_at FROM subject_refs WHERE hash = ? ORDER BY created_at, kind, row_id LIMIT ?",
        [hash, Math.max(1, Math.floor(limit))]
      ).map(mapSubjectRefRow);
    },

    async pruneOrphanSubjectRefs(limit) {
      const cap = Math.max(0, Math.floor(limit));
      if (cap === 0) return 0;
      return run(`DELETE FROM subject_refs WHERE rowid IN (SELECT r.rowid FROM subject_refs r WHERE ${ORPHAN_REFS_WHERE} LIMIT ?)`, [cap]).changes;
    },

    async createSubjectRequest(record) {
      run(
        `INSERT INTO subject_requests (${SUBJECT_REQUEST_COLUMNS}) VALUES (${SUBJECT_REQUEST_COLUMNS.split(",").map(() => "?").join(", ")})`,
        subjectRequestValues(record)
      );
    },

    async getSubjectRequest(id) {
      const row = one(`SELECT ${SUBJECT_REQUEST_COLUMNS} FROM subject_requests WHERE id = ?`, [id]);
      return row ? mapSubjectRequestRow(row) : null;
    },

    async listSubjectRequests({ limit, statuses }) {
      const size = Math.max(1, Math.min(500, Math.floor(limit)));
      if (statuses && statuses.length === 0) return [];
      const where = statuses ? `WHERE status IN (${statuses.map(() => "?").join(", ")})` : "";
      return all(`SELECT ${SUBJECT_REQUEST_COLUMNS} FROM subject_requests ${where} ORDER BY created_at DESC, id DESC LIMIT ?`, [
        ...(statuses ?? []),
        size
      ]).map(mapSubjectRequestRow);
    },

    async updateSubjectRequest(id, patch, expectStatus) {
      const { set, values } = subjectRequestPatchSql(patch, () => "?");
      const guard = expectStatus ? " AND status = ?" : "";
      return run(`UPDATE subject_requests SET ${set} WHERE id = ?${guard}`, [...values, id, ...(expectStatus ? [expectStatus] : [])]).changes > 0;
    },

    async saveSubjectExport(input) {
      insertExport(input);
    },

    async completeSubjectRequest(id, patch, exported) {
      const { set, values } = subjectRequestPatchSql(patch, () => "?");
      return db.transaction(() => {
        if (run(`UPDATE subject_requests SET ${set} WHERE id = ? AND status = 'searching'`, [...values, id]).changes === 0) return false;
        insertExport(exported);
        return true;
      })();
    },

    async listOverdueSubjectRequests(at, limit) {
      return all(
        `SELECT ${SUBJECT_REQUEST_COLUMNS} FROM subject_requests
         WHERE status IN ('searching', 'ready', 'running') AND due_notified_at IS NULL AND due_at < ? ORDER BY due_at, id LIMIT ?`,
        [at, Math.max(1, Math.min(500, Math.floor(limit)))]
      ).map(mapSubjectRequestRow);
    },

    async expireReadySubjectRequestsWithoutExport(at) {
      return db.transaction(() => {
        const where = `type = 'export' AND status = 'ready' AND NOT EXISTS (SELECT 1 FROM subject_exports e WHERE e.request_id = subject_requests.id)`;
        const ids = all<{ id: string }>(`SELECT id FROM subject_requests WHERE ${where}`, []).map((row) => String(row.id));
        if (ids.length > 0) run(`UPDATE subject_requests SET status = 'expired', updated_at = ? WHERE ${where}`, [at]);
        return ids;
      })();
    },

    async getSubjectExport(requestId) {
      const row = one(
        `SELECT id, request_id, bytes, sha256, created_at, expires_at, downloaded_at, downloaded_by, CASE WHEN sealed_blob <> '' THEN 1 ELSE 0 END AS stored
         FROM subject_exports WHERE request_id = ?`,
        [requestId]
      );
      return row ? mapSubjectExportRow(row) : null;
    },

    async claimSubjectExport({ requestId, by, at }) {
      return db.transaction(() => {
        const row = one<{ sealed_blob: string }>(
          `SELECT sealed_blob FROM subject_exports WHERE request_id = ? AND downloaded_at IS NULL AND expires_at > ? AND sealed_blob <> ''`,
          [requestId, at]
        );
        if (!row) return null;
        run(`UPDATE subject_exports SET downloaded_at = ?, downloaded_by = ?, sealed_blob = '' WHERE request_id = ?`, [at, by, requestId]);
        return row.sealed_blob;
      })();
    },

    async expireSubjectExports(at) {
      return db.transaction(() => {
        const ids = all<{ request_id: string }>(
          `SELECT request_id FROM subject_exports WHERE downloaded_at IS NULL AND expires_at <= ? AND sealed_blob <> ''`,
          [at]
        ).map((row) => String(row.request_id));
        if (ids.length > 0) run(`UPDATE subject_exports SET sealed_blob = '' WHERE downloaded_at IS NULL AND expires_at <= ? AND sealed_blob <> ''`, [at]);
        return ids;
      })();
    },

    async subjectScanPage(kind, after, limit) {
      const query = SCAN_QUERIES[kind];
      const cursor = after === null ? 0 : Number(after);
      const rows = all(`${query.select} AND ${query.rowid} > ? ORDER BY ${query.rowid} ASC LIMIT ?`, [
        Number.isFinite(cursor) ? cursor : 0,
        Math.max(1, Math.min(500, Math.floor(limit)))
      ]);
      const mapped = rows.map((row) => mapSubjectScanRow(kind, row, scanRowId(kind, row)));
      return { rows: mapped, next: rows.length > 0 ? String(rows[rows.length - 1]!.rid) : null };
    },

    async subjectScanRow(kind, id) {
      const params = scanRowParams(kind, id);
      if (!params) return null;
      const row = one(SCAN_QUERIES[kind].byId, params);
      return row ? mapSubjectScanRow(kind, row, scanRowId(kind, row)) : null;
    },

    async memorySessionSubjectRows(namespace, sessionId) {
      const rows: SubjectTextRow[] = [];
      const session = one(SCAN_QUERIES.memory_session.byId, [namespace, sessionId]);
      if (session) rows.push(mapSubjectScanRow("memory_session", session, scanRowId("memory_session", session)));
      for (const artifact of all(
        `SELECT s.namespace, s.session_id, s.artifact_key, s.artifact_key AS name, NULL AS status, s.value_json
         FROM session_artifacts s WHERE s.namespace = ? AND s.session_id = ? ORDER BY s.artifact_key`,
        [namespace, sessionId]
      )) {
        rows.push(mapSubjectScanRow("memory_artifact", artifact, scanRowId("memory_artifact", artifact)));
      }
      return rows;
    },

    async staffSubjectRows(email) {
      const cap = STAFF_SUBJECT_ROWS_CAP;
      const user = one(STAFF_SECTION_SQL.user, [email]);
      const userId = user ? String(user.id) : null;
      const byUser = (sql: string) => (userId ? all(sql, [userId, cap]).map(plainRow) : []);
      const emails = staffEmailsOf(user, email);
      const rows: StaffSubjectRows = {
        user: user ? plainRow(user) : null,
        ssoIdentities: byUser(STAFF_SECTION_SQL.ssoIdentities),
        projectRoles: byUser(STAFF_SECTION_SQL.projectRoles),
        apiKeys: byUser(STAFF_SECTION_SQL.apiKeys),
        runsTriggered: all(STAFF_SECTION_SQL.runsTriggered, [...emails, cap]).map(plainRow),
        workflowsCreated: all(STAFF_SECTION_SQL.workflowsCreated, [...emails, cap]).map(plainRow),
        approvals: all(STAFF_SECTION_SQL.approvals, [...emails, ...emails, cap]).map(plainRow),
        evalRuns: all(STAFF_SECTION_SQL.evalRuns, [...emails, cap]).map(plainRow),
        releasesPublished: all(STAFF_SECTION_SQL.releasesPublished, [...emails, cap]).map(plainRow),
        auditEntries: all(STAFF_SECTION_SQL.auditEntries, [...emails, userId ?? "", cap]).map(plainRow)
      };
      return rows;
    }
  };
}
