/**
 * 13.3 — data-subject erasure: what deleting a subject's row takes with it, the erasure tombstones every deletion
 * writes, the staff authorship columns a staff erasure pseudonymises, and re-applying tombstones after a restore.
 * Both stores and the restore scripts (db:import, db:copy) build their statements from this module, so they cannot
 * drift apart. Statements use `?` placeholders; Postgres callers number them (toPgPlaceholders).
 *
 * Tombstones keep ids only, never values. A run, approval, cassette, golden run, case, result or vault token is named
 * by its own id. An agent memory session (whose session id is often the person's email or phone) and a staff member
 * (their email) are named by a keyed hash under the subject key, so a restore needs SECRET_MASTER_KEY_BASE64 to re-apply
 * them; the rest re-applies without it.
 *
 * Everything here is trusted SQL over fixed table and column names; values only ever go in as parameters.
 */
import crypto from "node:crypto";
import type { LegalHoldRef } from "@ai-orchestrator/shared";
import type { SubjectStoreKind } from "./database.js";
import { heldRowSql, type HoldableTable, type LegalHoldTarget } from "./legal-hold-sql.js";
import { parseMemoryArtifactRowId, parseMemorySessionRowId, type SubjectScanKind } from "./subject-store.js";

/** The kinds a tombstone names. `staff`: a staff member's pseudonymised authorship and deleted user row. */
export const ERASURE_KINDS = [
  "run",
  "approval",
  "memory_session",
  "memory_artifact",
  "cassette",
  "golden_run",
  "golden_set_case",
  "eval_result",
  "vault_token",
  "staff"
] as const;
export type ErasureKind = (typeof ERASURE_KINDS)[number];

/**
 * A marker db:import or db:copy writes when an operator skipped re-applying erasures (--skip-erasures --i-understand):
 * the next API start audits it and removes it. Never re-applied.
 */
export const RESTORE_SKIPPED_KIND = "restore_skipped";

/** What a data-subject deletion names: the lookup's own stores, or the kinds a request's scan reads. */
export type SubjectDeleteKind = SubjectStoreKind | SubjectScanKind;

/** The tombstone kind of a deleted row. A paused run is a run: deleting either removes the whole run. */
export function erasureKindOf(kind: SubjectDeleteKind): ErasureKind {
  switch (kind) {
    case "execution":
    case "production_execution":
    case "paused_run":
      return "run";
    case "recording":
      return "golden_run";
    case "fixture":
      return "golden_set_case";
    case "eval_result":
      return "eval_result";
    case "cassette":
    case "cassette_any":
      return "cassette";
    case "approval":
      return "approval";
    case "memory_session":
      return "memory_session";
    case "memory_artifact":
      return "memory_artifact";
  }
}

export interface ErasureStatement {
  sql: string;
  params: unknown[];
}

/**
 * A whole run, by execution id: its tool calls, rule events, MCP cassettes, approval requests, questions to the user,
 * queue jobs (and their dead letters), paused state, subject references and the history row. Usage rows are kept
 * with the person cleared (user id and email), so token and cost totals and budgets do not move.
 */
export function runErasureStatements(executionId: string): ErasureStatement[] {
  const id = [executionId];
  return [
    { sql: "DELETE FROM mcp_tool_calls WHERE execution_id = ?", params: id },
    { sql: "DELETE FROM guard_events WHERE execution_id = ?", params: id },
    { sql: "DELETE FROM mcp_cassettes WHERE execution_id = ?", params: id },
    { sql: "DELETE FROM approval_requests WHERE execution_id = ?", params: id },
    { sql: "DELETE FROM mcp_elicitations WHERE execution_id = ?", params: id },
    { sql: "DELETE FROM execution_queue_dlq WHERE original_id IN (SELECT q.id FROM execution_queue q WHERE q.execution_id = ?)", params: id },
    { sql: "DELETE FROM execution_queue WHERE execution_id = ?", params: id },
    { sql: "DELETE FROM workflow_executions WHERE id = ?", params: id },
    { sql: "DELETE FROM subject_refs WHERE kind = 'run' AND row_id = ?", params: id },
    { sql: "DELETE FROM execution_history WHERE id = ?", params: id }
  ];
}

/** The holdable tables a run's delete takes rows of by `execution_id` (runErasureStatements). */
export const RUN_SIDE_HOLDABLE = ["mcp_tool_calls", "guard_events", "mcp_cassettes", "approval_requests", "execution_queue"] as const;

/** Clears the person from a run's usage rows; tokens and cost stay. */
export const CLEAR_RUN_USAGE_SQL = "UPDATE usage_events SET user_id = NULL, user_email = NULL WHERE execution_id = ? AND (user_id IS NOT NULL OR user_email IS NOT NULL)";

/** An agent memory session: its messages, artifacts, cached tool results and subject references. */
export function memorySessionErasureStatements(namespace: string, sessionId: string): ErasureStatement[] {
  const keys = [namespace, sessionId];
  return [
    { sql: "DELETE FROM session_artifacts WHERE namespace = ? AND session_id = ?", params: keys },
    { sql: "DELETE FROM session_tool_cache WHERE namespace = ? AND session_id = ?", params: keys },
    { sql: "DELETE FROM session_memory WHERE namespace = ? AND session_id = ?", params: keys },
    { sql: "DELETE FROM subject_refs WHERE kind = 'memory_session' AND row_id = ?", params: [JSON.stringify(keys)] }
  ];
}

export function memoryArtifactErasureStatements(namespace: string, sessionId: string, artifactKey: string): ErasureStatement[] {
  return [{ sql: "DELETE FROM session_artifacts WHERE namespace = ? AND session_id = ? AND artifact_key = ?", params: [namespace, sessionId, artifactKey] }];
}

/** A golden run with the golden-set cases made from it and their results. */
export function goldenRunErasureStatements(recordingId: string): ErasureStatement[] {
  const id = [recordingId];
  return [
    { sql: "DELETE FROM eval_results WHERE fixture_id IN (SELECT f.id FROM eval_fixtures f WHERE f.recording_id = ?)", params: id },
    { sql: "DELETE FROM eval_fixtures WHERE recording_id = ?", params: id },
    { sql: "DELETE FROM replay_recordings WHERE id = ?", params: id }
  ];
}

/** The statements that erase a tombstone named by its own id; null for kinds named by a keyed hash. */
export function idErasureStatements(kind: ErasureKind, rowId: string): ErasureStatement[] | null {
  switch (kind) {
    case "run":
      return [...runErasureStatements(rowId), { sql: CLEAR_RUN_USAGE_SQL, params: [rowId] }];
    case "approval":
      return [{ sql: "DELETE FROM approval_requests WHERE id = ?", params: [rowId] }];
    case "cassette":
      return [{ sql: "DELETE FROM mcp_cassettes WHERE id = ?", params: [rowId] }];
    case "golden_run":
      return goldenRunErasureStatements(rowId);
    case "golden_set_case":
      return [
        { sql: "DELETE FROM eval_results WHERE fixture_id = ?", params: [rowId] },
        { sql: "DELETE FROM eval_fixtures WHERE id = ?", params: [rowId] }
      ];
    case "eval_result":
      return [{ sql: "DELETE FROM eval_results WHERE id = ?", params: [rowId] }];
    case "vault_token":
      return [{ sql: "DELETE FROM guard_token_vault WHERE token = ?", params: [rowId] }];
    case "memory_session":
    case "memory_artifact":
    case "staff":
      return null;
  }
}

// -----------------------------------------------------------------------------------------------------------------
// Keyed tombstone ids and the staff pseudonym

function keyed(key: Buffer, label: string, text: string): string {
  return crypto.createHmac("sha256", key).update(`${label}\u0000${text}`).digest("hex");
}

/** A memory session's tombstone id: a keyed hash of its namespace and session id. */
export function memorySessionTombstoneId(key: Buffer, namespace: string, sessionId: string): string {
  return keyed(key, "erasure:memory_session:v1", JSON.stringify([namespace, sessionId]));
}

export function memoryArtifactTombstoneId(key: Buffer, namespace: string, sessionId: string, artifactKey: string): string {
  return keyed(key, "erasure:memory_artifact:v1", JSON.stringify([namespace, sessionId, artifactKey]));
}

/** A staff member's tombstone id: a keyed hash of their email, lower-cased. */
export function staffTombstoneId(key: Buffer, email: string): string {
  return keyed(key, "erasure:staff:v1", email.trim().toLowerCase());
}

/** The pseudonym a staff member's email becomes: `erased-user-` and the first 8 hex of the keyed hash. */
export function staffPseudonym(tombstoneId: string): string {
  return `erased-user-${tombstoneId.slice(0, 8)}`;
}

// -----------------------------------------------------------------------------------------------------------------
// Staff authorship columns

/** How a hold keeps a row of a table that is not itself holdable: SQL over the row alias `t`, true when held. */
const WORKFLOW_HELD = (workflowColumn: string) =>
  `EXISTS (SELECT 1 FROM legal_holds lhs WHERE lhs.status = 'active' AND ((lhs.scope_type = 'workflow' AND lhs.scope_id = t.${workflowColumn}) OR (lhs.scope_type = 'project' AND lhs.scope_id = (SELECT w.project_id FROM workflows w WHERE w.id = t.${workflowColumn}))))`;

export interface StaffAuthorshipColumn {
  table: string;
  column: string;
  /** SQL over the row alias `t` that is true while a legal hold keeps the row (its pseudonymisation waits). */
  held?: string;
}

const holdable = (table: HoldableTable, column: string): StaffAuthorshipColumn => ({ table, column, held: heldRowSql(table, "t", "lhs") });

/**
 * Every column that records a staff member as the author or decider of a row, by email. A staff erasure replaces the
 * email with the pseudonym in each (a column that holds user ids never matches an email). Rows a legal hold keeps
 * wait for the hold. Not here: `audit_logs` (kept for security logging; rewriting it would break the hash chain),
 * `users.email` and the user's credentials (the user row is deleted), and free text inside run data (an end-user
 * deletion covers that).
 */
export const STAFF_AUTHORSHIP_COLUMNS: readonly StaffAuthorshipColumn[] = [
  holdable("execution_history", "triggered_by"),
  holdable("workflow_executions", "triggered_by"),
  holdable("usage_events", "user_email"),
  holdable("approval_requests", "requested_by"),
  holdable("approval_requests", "decided_by"),
  holdable("mcp_gateway_approvals", "decided_by"),
  holdable("eval_runs", "triggered_by"),
  holdable("mcp_cassettes", "created_by"),
  holdable("replay_recordings", "created_by"),
  holdable("eval_datasets", "created_by"),
  { table: "workflows", column: "created_by", held: `(${WORKFLOW_HELD("id")})` },
  { table: "workflow_versions", column: "created_by", held: `(${WORKFLOW_HELD("workflow_id")})` },
  { table: "workflow_releases", column: "published_by", held: `(${WORKFLOW_HELD("workflow_id")})` },
  {
    table: "projects",
    column: "created_by",
    held: "EXISTS (SELECT 1 FROM legal_holds lhs WHERE lhs.status = 'active' AND lhs.scope_type = 'project' AND lhs.scope_id = t.id)"
  },
  { table: "users", column: "created_by" },
  { table: "user_invites", column: "created_by" },
  { table: "gate_case_requests", column: "requested_by" },
  { table: "gate_case_requests", column: "decided_by" },
  { table: "release_approval_requests", column: "requested_by" },
  { table: "release_approval_requests", column: "decided_by" },
  { table: "release_gates", column: "updated_by" },
  { table: "release_gates", column: "admission_updated_by" },
  { table: "guard_profiles", column: "created_by" },
  { table: "guard_profiles", column: "updated_by" },
  { table: "guard_profile_versions", column: "created_by" },
  { table: "guard_bindings", column: "updated_by" },
  { table: "guard_simulations", column: "created_by" },
  { table: "guard_benchmarks", column: "created_by" },
  { table: "mcp_servers", column: "created_by" },
  { table: "mcp_servers", column: "owner" },
  { table: "mcp_toolsets", column: "created_by" },
  { table: "mcp_tool_policies", column: "created_by" },
  { table: "mcp_clients", column: "created_by" },
  { table: "mcp_clients", column: "created_by_email" },
  { table: "mcp_policy_suggestions", column: "created_by" },
  { table: "mcp_policy_suggestions", column: "decided_by" },
  { table: "mcp_tool_classifications", column: "set_by" },
  { table: "mcp_tool_open_world_overrides", column: "set_by" },
  { table: "mcp_tool_snapshots", column: "acknowledged_by" },
  { table: "mcp_elicitations", column: "created_by" },
  { table: "mcp_elicitations", column: "answered_by" },
  { table: "mcp_oauth_connections", column: "connected_by" },
  { table: "ai_gateway_route_sets", column: "created_by" },
  { table: "ai_gateway_routes", column: "created_by" },
  { table: "ai_gateway_client_grants", column: "created_by" },
  { table: "budgets", column: "created_by" },
  { table: "custom_roles", column: "created_by" },
  { table: "data_destinations", column: "created_by" },
  { table: "data_destinations", column: "updated_by" },
  { table: "audit_export_destinations", column: "created_by" },
  { table: "log_stream_destinations", column: "created_by" },
  { table: "external_secret_providers", column: "created_by" },
  { table: "knowledge_bases", column: "created_by" },
  { table: "model_allowlist_entries", column: "created_by" },
  { table: "variables", column: "created_by" },
  { table: "secret_shares", column: "shared_by" },
  { table: "workflow_shares", column: "shared_by" },
  { table: "replay_capture_settings", column: "updated_by" },
  { table: "retention_policies", column: "updated_by" },
  { table: "git_configs", column: "user_email" },
  { table: "legal_holds", column: "created_by" },
  { table: "legal_holds", column: "released_by" },
  { table: "subject_requests", column: "created_by" },
  { table: "subject_exports", column: "downloaded_by" }
];

/** Rows a staff pseudonymisation updates per statement. */
export const STAFF_BATCH = 1000;

/** `?, ?, …` for `count` values. */
export function marks(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/**
 * The rows of a column holding one of `emails` (lower-cased, staffEmails), in any case, that no hold keeps (`t`
 * aliases the table).
 */
export function staffWhere(column: StaffAuthorshipColumn, emailCount: number, which: "unheld" | "held"): string {
  const match = `lower(t.${column.column}) IN (${marks(emailCount)})`;
  if (!column.held) return which === "unheld" ? match : "1 = 0";
  return which === "unheld" ? `${match} AND NOT ${column.held}` : `${match} AND ${column.held}`;
}

/** The emails a staff member's rows match (staffWhere compares lower-cased): the request's and the account's, each once. */
export function staffEmails(email: string, storedEmail?: string | null): string[] {
  return [...new Set([email, ...(storedEmail ? [storedEmail] : [])].map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

// -----------------------------------------------------------------------------------------------------------------
// Re-applying tombstones after a restore

/** Runs `?`-placeholder SQL on the restored database (inside the restore's transaction). */
export interface ErasureExecutor {
  all(sql: string, params: unknown[]): Promise<Array<Record<string, unknown>>>;
  /** Resolves with the number of rows changed. */
  run(sql: string, params: unknown[]): Promise<number>;
}

export interface TombstoneRow {
  kind: string;
  row_id: string;
  request_id?: string | null;
  erased_at?: unknown;
}

export interface ReapplyReport {
  /** Tombstones re-applied (every one of a known kind, whether its rows were still there or not). */
  erasures: number;
  /** Rows deleted or changed because a restore brought them back. */
  rowsChanged: number;
  /** Tombstones named by a keyed hash that could not be re-applied without the subject key. */
  needKey: number;
  /**
   * Keyed rows left alone: a memory session or account created after its erasure (the same session id or email used
   * again), a staff member's rows a legal hold keeps, and the only admin who can sign in.
   */
  rowsKept: number;
}

/** A timestamp as either driver returns it (Date, ISO text, or SQLite `YYYY-MM-DD HH:MM:SS` in UTC); NaN when unknown. */
export function timeOf(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== "string" || value === "") return Number.NaN;
  const sqlite = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
  return Date.parse(sqlite);
}

/** Whether a row created at `createdAt` predates (or may predate: unknown time) an erasure at `erasedAt`. */
function createdBy(createdAt: unknown, erasedAt: number): boolean {
  const created = timeOf(createdAt);
  return Number.isNaN(created) || Number.isNaN(erasedAt) || created <= erasedAt;
}

/**
 * Re-applies every tombstone in the restored database. A tombstone named by its row id records a row that was really
 * erased, so holds are not consulted for it (an erased row cannot be held). Tombstones named by a keyed hash need
 * `subjectKey` (opened from subject_ref_keys) and match by value, so they are re-applied only to rows created before
 * the erasure (a session id or email used again later is another person's, or a re-hired one's), staff authorship rows
 * a legal hold keeps are left as the live erasure left them, and the only admin who can sign in is never deleted.
 */
export async function reapplyErasures(exec: ErasureExecutor, subjectKey: Buffer | null): Promise<ReapplyReport> {
  const rows = (await exec.all("SELECT kind, row_id, erased_at FROM erasure_tombstones ORDER BY erased_at, kind, row_id", [])) as unknown as TombstoneRow[];
  const report: ReapplyReport = { erasures: 0, rowsChanged: 0, needKey: 0, rowsKept: 0 };
  const sessions = new Map<string, number>();
  const artifacts = new Map<string, number>();
  const staff = new Map<string, number>();
  for (const row of rows) {
    const kind = String(row.kind) as ErasureKind;
    const rowId = String(row.row_id);
    if (!(ERASURE_KINDS as readonly string[]).includes(kind)) continue;
    const statements = idErasureStatements(kind, rowId);
    if (statements) {
      for (const statement of statements) report.rowsChanged += await exec.run(statement.sql, statement.params);
      report.erasures += 1;
      continue;
    }
    if (!subjectKey) {
      report.needKey += 1;
      continue;
    }
    const target = kind === "memory_session" ? sessions : kind === "memory_artifact" ? artifacts : staff;
    // The latest erasure of the same value counts.
    target.set(rowId, Math.max(target.get(rowId) ?? Number.NEGATIVE_INFINITY, timeOf(row.erased_at)));
    report.erasures += 1;
  }
  if (!subjectKey) return report;

  if (sessions.size > 0) {
    const erasedAtOf = (namespace: string, sessionId: string) => sessions.get(memorySessionTombstoneId(subjectKey, namespace, sessionId));
    for (const row of await exec.all("SELECT namespace, session_id, created_at FROM session_memory", [])) {
      const erasedAt = erasedAtOf(String(row.namespace), String(row.session_id));
      if (erasedAt === undefined) continue;
      if (!createdBy(row.created_at, erasedAt)) {
        report.rowsKept += 1;
        continue;
      }
      report.rowsChanged += await exec.run("DELETE FROM session_memory WHERE namespace = ? AND session_id = ?", [row.namespace, row.session_id]);
      report.rowsChanged += await exec.run("DELETE FROM subject_refs WHERE kind = 'memory_session' AND row_id = ?", [JSON.stringify([String(row.namespace), String(row.session_id)])]);
    }
    for (const row of await exec.all("SELECT namespace, session_id, artifact_key, created_at FROM session_artifacts", [])) {
      const erasedAt = erasedAtOf(String(row.namespace), String(row.session_id));
      if (erasedAt === undefined) continue;
      if (!createdBy(row.created_at, erasedAt)) {
        report.rowsKept += 1;
        continue;
      }
      report.rowsChanged += await exec.run("DELETE FROM session_artifacts WHERE namespace = ? AND session_id = ? AND artifact_key = ?", [row.namespace, row.session_id, row.artifact_key]);
    }
    for (const row of await exec.all("SELECT id, namespace, session_id, created_at FROM session_tool_cache", [])) {
      const erasedAt = erasedAtOf(String(row.namespace), String(row.session_id));
      if (erasedAt === undefined) continue;
      if (!createdBy(row.created_at, erasedAt)) {
        report.rowsKept += 1;
        continue;
      }
      report.rowsChanged += await exec.run("DELETE FROM session_tool_cache WHERE id = ?", [row.id]);
    }
  }
  if (artifacts.size > 0) {
    for (const key of await exec.all("SELECT namespace, session_id, artifact_key, created_at FROM session_artifacts", [])) {
      const [namespace, sessionId, artifactKey] = [String(key.namespace), String(key.session_id), String(key.artifact_key)];
      const erasedAt = artifacts.get(memoryArtifactTombstoneId(subjectKey, namespace, sessionId, artifactKey));
      if (erasedAt === undefined) continue;
      if (!createdBy(key.created_at, erasedAt)) {
        report.rowsKept += 1;
        continue;
      }
      for (const statement of memoryArtifactErasureStatements(namespace, sessionId, artifactKey)) report.rowsChanged += await exec.run(statement.sql, statement.params);
    }
  }
  if (staff.size > 0) {
    // A staff member whose email has an account created after the erasure was re-hired: their tombstone is left out
    // (their rows are theirs again). The others' accounts are deleted, unless one is the only admin who can sign in.
    const users = await exec.all("SELECT id, email, role, kind, created_at FROM users", []);
    const rehired = new Set<string>();
    for (const user of users) {
      const id = staffTombstoneId(subjectKey, String(user.email));
      const erasedAt = staff.get(id);
      if (erasedAt !== undefined && !createdBy(user.created_at, erasedAt)) rehired.add(id);
    }
    for (const id of rehired) {
      staff.delete(id);
      report.rowsKept += 1;
    }
    // Every distinct email the authorship columns hold, hashed: the erased ones are replaced where no hold keeps them.
    for (const column of STAFF_AUTHORSHIP_COLUMNS) {
      for (const value of await exec.all(`SELECT DISTINCT ${column.column} AS v FROM ${column.table} WHERE ${column.column} IS NOT NULL`, [])) {
        const email = String(value.v);
        const id = staffTombstoneId(subjectKey, email);
        if (!staff.has(id)) continue;
        const where = `t.${column.column} = ?`;
        report.rowsChanged += await exec.run(
          `UPDATE ${column.table} AS t SET ${column.column} = ? WHERE ${where}${column.held ? ` AND NOT ${column.held}` : ""}`,
          [staffPseudonym(id), email]
        );
        if (column.held) {
          const kept = await exec.all(`SELECT COUNT(*) AS n FROM ${column.table} t WHERE ${where} AND ${column.held}`, [email]);
          report.rowsKept += Number(kept[0]?.n ?? 0);
        }
      }
    }
    const isSignInAdmin = (user: Record<string, unknown>) => user.role === "admin" && (user.kind ?? "human") === "human";
    let admins = users.filter(isSignInAdmin).length;
    for (const user of users) {
      if (!staff.has(staffTombstoneId(subjectKey, String(user.email)))) continue;
      if (isSignInAdmin(user)) {
        if (admins <= 1) {
          report.rowsKept += 1;
          continue;
        }
        admins -= 1;
      }
      for (const statement of userErasureStatements(String(user.id))) report.rowsChanged += await exec.run(statement.sql, statement.params);
    }
  }
  return report;
}

/** A user row and everything that belongs to it, as the store's user delete removes them. */
export function userErasureStatements(userId: string): ErasureStatement[] {
  const id = [userId];
  return [
    ...["sessions", "api_keys", "mfa_secrets", "sso_identities", "user_project_roles", "user_invites", "mcp_user_oauth_connections"].map((table) => ({
      sql: `DELETE FROM ${table} WHERE user_id = ?`,
      params: id
    })),
    { sql: "DELETE FROM users WHERE id = ?", params: id }
  ];
}

/** Which request erased a row, when, and (memory kinds) the keyed tombstone id to record it by. */
export interface SubjectErasure {
  /** The data-subject request, or null for the replay data-subject lookup's own delete. */
  requestId: string | null;
  erasedAt: string;
  /** Required for memory sessions and artifacts (memorySessionTombstoneId / memoryArtifactTombstoneId). */
  tombstoneId?: string;
}

/** What deleting one subject row did. */
export interface SubjectRowDeletion {
  deleted: boolean;
  /** Golden-set cases and results removed with a golden run or case. */
  cascaded: Array<{ kind: SubjectStoreKind; id: string }>;
  /** The holds that kept the row (nothing was deleted). */
  heldBy?: LegalHoldRef[];
  /** Usage rows of a deleted run kept with the person cleared. */
  usageCleared?: number;
}

/** A tombstone as written. */
export interface ErasureTombstoneWrite {
  kind: ErasureKind;
  rowId: string;
  requestId: string | null;
  erasedAt: string;
}

export const INSERT_TOMBSTONE_SQL = `INSERT INTO erasure_tombstones (kind, row_id, request_id, erased_at) VALUES (?, ?, ?, ?)
  ON CONFLICT (kind, row_id) DO UPDATE SET request_id = excluded.request_id, erased_at = excluded.erased_at`;

/** The tombstones a deletion writes: the row itself, then what it took with it. */
export function deletionTombstones(kind: SubjectDeleteKind, id: string, outcome: SubjectRowDeletion, erasure: SubjectErasure): ErasureTombstoneWrite[] {
  if (!outcome.deleted) return [];
  const own = erasureKindOf(kind);
  if ((own === "memory_session" || own === "memory_artifact") && !erasure.tombstoneId) {
    throw new Error("Deleting agent memory needs its keyed tombstone id");
  }
  const rows: ErasureTombstoneWrite[] = [{ kind: own, rowId: erasure.tombstoneId ?? id, requestId: erasure.requestId, erasedAt: erasure.erasedAt }];
  for (const cascaded of outcome.cascaded) {
    rows.push({ kind: erasureKindOf(cascaded.kind), rowId: cascaded.id, requestId: erasure.requestId, erasedAt: erasure.erasedAt });
  }
  return rows;
}

/** The hold lookups that keep a subject row (any one answering keeps it). */
export function subjectRowHoldTargets(kind: SubjectDeleteKind, id: string): LegalHoldTarget[] {
  switch (kind) {
    case "execution":
    case "production_execution":
    case "paused_run":
      // The run and every side row its delete takes (a hold may name a cassette or reach a tool call by its project).
      return [
        { kind: "row", table: "execution_history", id },
        { kind: "row", table: "workflow_executions", id },
        ...RUN_SIDE_HOLDABLE.map((table) => ({ kind: "row" as const, table, id, idColumn: "execution_id" as const }))
      ];
    case "recording":
      return [{ kind: "row", table: "replay_recordings", id }];
    case "fixture":
      return [{ kind: "row", table: "eval_fixtures", id }];
    case "eval_result":
      return [{ kind: "row", table: "eval_results", id }];
    case "cassette":
    case "cassette_any":
      return [{ kind: "row", table: "mcp_cassettes", id }];
    case "approval":
      return [{ kind: "row", table: "approval_requests", id }];
    case "memory_session": {
      const key = parseMemorySessionRowId(id);
      return key ? [{ kind: "namespace", table: "session_memory", namespace: key.namespace }] : [];
    }
    case "memory_artifact": {
      const key = parseMemoryArtifactRowId(id);
      return key ? [{ kind: "namespace", table: "session_artifacts", namespace: key.namespace }] : [];
    }
    default:
      // Never deleted without its hold check.
      throw new Error(`Unknown subject row kind: ${String(kind)}`);
  }
}

/** The first holds found on any of `targets`, each once. */
export async function holdsOnAny(targets: LegalHoldTarget[], lookup: (target: LegalHoldTarget) => Promise<LegalHoldRef[]> | LegalHoldRef[]): Promise<LegalHoldRef[]> {
  const seen = new Map<string, LegalHoldRef>();
  for (const target of targets) for (const hold of await lookup(target)) seen.set(hold.id, hold);
  return [...seen.values()];
}
