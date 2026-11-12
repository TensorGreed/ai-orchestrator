/**
 * 13.3 — the data-subject part of the Store contract (subject references, requests, sealed exports, the subject key,
 * and the lookups a request reads), and the row mapping both stores share. SQLite: subject-sqlite.ts; Postgres:
 * postgres/subject.ts.
 *
 * References are keyed hashes of the subject's value; a session reference's row id names the memory session, whose
 * session id may be the value itself (as in session_memory). A request keeps its value sealed with the master key only
 * while its lookup runs, and exports are sealed.
 */
import {
  SUBJECT_KINDS,
  SUBJECT_REQUEST_STATUSES,
  SUBJECT_REQUEST_TYPES,
  type SubjectKind,
  type SubjectRequestStatus,
  type SubjectRequestType
} from "@ai-orchestrator/shared";
import type { SubjectTextRow } from "./database.js";

/** What a subject reference points at: a run (execution_history id) or an agent memory session. */
export const SUBJECT_REF_KINDS = ["run", "memory_session"] as const;
export type SubjectRefKind = (typeof SUBJECT_REF_KINDS)[number];

/**
 * The stored kinds a request's scan reads beyond the data-subject lookup's five (which keep their own paging): every
 * other run, paused runs, approval requests, agent memory and artifacts, and every other cassette.
 */
export const SUBJECT_SCAN_KINDS = ["production_execution", "paused_run", "approval", "memory_session", "memory_artifact", "cassette_any"] as const;
export type SubjectScanKind = (typeof SUBJECT_SCAN_KINDS)[number];

export interface SubjectRefWrite {
  hash: string;
  kind: SubjectRefKind;
  rowId: string;
  projectId: string | null;
  workflowId: string | null;
  createdAt: string;
}

export interface SubjectRefRow {
  kind: SubjectRefKind;
  rowId: string;
  projectId: string | null;
  workflowId: string | null;
  createdAt: string;
}

/**
 * A memory session's row id: its namespace and session id. A session reference's row id therefore holds the session id
 * in clear, next to its hash (session_memory holds the same id); deleting the session should delete its references.
 */
export function memorySessionRowId(namespace: string, sessionId: string): string {
  return JSON.stringify([namespace, sessionId]);
}

export function parseMemorySessionRowId(rowId: string): { namespace: string; sessionId: string } | null {
  try {
    const parsed: unknown = JSON.parse(rowId);
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
      return { namespace: parsed[0], sessionId: parsed[1] };
    }
  } catch {
    // Not a memory session id.
  }
  return null;
}

/** A memory artifact's row id: namespace, session id and artifact key. */
export function memoryArtifactRowId(namespace: string, sessionId: string, artifactKey: string): string {
  return JSON.stringify([namespace, sessionId, artifactKey]);
}

export function parseMemoryArtifactRowId(rowId: string): { namespace: string; sessionId: string; artifactKey: string } | null {
  try {
    const parsed: unknown = JSON.parse(rowId);
    if (Array.isArray(parsed) && parsed.length === 3 && parsed.every((part) => typeof part === "string")) {
      return { namespace: parsed[0] as string, sessionId: parsed[1] as string, artifactKey: parsed[2] as string };
    }
  } catch {
    // Not a memory artifact id.
  }
  return null;
}

export interface SubjectRequestRecord {
  id: string;
  type: SubjectRequestType;
  subjectKind: SubjectKind;
  queryHash: string;
  /** The value sealed with the master key, while the lookup runs; null otherwise. */
  valueSealed: string | null;
  scan: boolean;
  revealTokens: boolean;
  status: SubjectRequestStatus;
  dueAt: string;
  dueNotifiedAt: string | null;
  counts: Record<string, number>;
  /** The lookup's state (where it is and what it found so far); the service owns its shape. */
  progress: Record<string, unknown>;
  deferred: unknown[];
  createdBy: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  error: string | null;
}

export type SubjectRequestPatch = Partial<
  Pick<SubjectRequestRecord, "status" | "valueSealed" | "counts" | "progress" | "deferred" | "error" | "dueNotifiedAt">
> & { updatedAt: string };

export interface SubjectExportWrite {
  id: string;
  requestId: string;
  sealedBlob: string;
  bytes: number;
  sha256: string;
  createdAt: string;
  expiresAt: string;
}

export interface SubjectExportRecord {
  id: string;
  requestId: string;
  bytes: number;
  sha256: string;
  createdAt: string;
  expiresAt: string;
  downloadedAt: string | null;
  downloadedBy: string | null;
  /** Whether the sealed file is still stored (cleared once downloaded or expired). */
  stored: boolean;
}

/** A staff member's identity and what they authored, for a staff export. Credentials (hashes, secrets) never. */
export interface StaffSubjectRows {
  user: Record<string, unknown> | null;
  ssoIdentities: Array<Record<string, unknown>>;
  projectRoles: Array<Record<string, unknown>>;
  apiKeys: Array<Record<string, unknown>>;
  runsTriggered: Array<Record<string, unknown>>;
  workflowsCreated: Array<Record<string, unknown>>;
  approvals: Array<Record<string, unknown>>;
  evalRuns: Array<Record<string, unknown>>;
  releasesPublished: Array<Record<string, unknown>>;
  auditEntries: Array<Record<string, unknown>>;
}

/**
 * The two emails the authored sections of a staff export match (`IN (?, ?)`): the stored user's email (or the value
 * when no user has it) and the value lower-cased, which is how the app stores emails. A value typed with capitals
 * still finds every authored row.
 */
export function staffEmailsOf(user: Record<string, unknown> | undefined | null, email: string): [string, string] {
  const lower = email.trim().toLowerCase();
  return [user && typeof user.email === "string" && user.email ? user.email : email.trim(), lower];
}

/** Rows per section of a staff export at most. */
export const STAFF_SUBJECT_ROWS_CAP = 10_000;

export interface SubjectStore {
  /** The sealed subject key, or null before the first use. */
  getSubjectRefKey(): Promise<string | null>;
  /** Stores `sealed` as the subject key unless one exists; returns the stored one (the first writer wins a race). */
  initSubjectRefKey(sealed: string, createdAt: string): Promise<string>;
  /** Adds references; one already stored is left as it is. */
  addSubjectRefs(refs: SubjectRefWrite[]): Promise<void>;
  /** The rows a hash points at, oldest first, at most `limit`. */
  listSubjectRefs(hash: string, limit: number): Promise<SubjectRefRow[]>;
  /** Deletes up to `limit` references whose run or memory session is gone; returns how many. */
  pruneOrphanSubjectRefs(limit: number): Promise<number>;

  createSubjectRequest(record: SubjectRequestRecord): Promise<void>;
  getSubjectRequest(id: string): Promise<SubjectRequestRecord | null>;
  /** Newest first. */
  listSubjectRequests(input: { limit: number; statuses?: SubjectRequestStatus[] }): Promise<SubjectRequestRecord[]>;
  /** Applies `patch`; with `expectStatus`, only while the request is still in that status. Returns whether it applied. */
  updateSubjectRequest(id: string, patch: SubjectRequestPatch, expectStatus?: SubjectRequestStatus): Promise<boolean>;

  /** Stores a request's export unless one is stored already (an export is never replaced or re-opened). */
  saveSubjectExport(input: SubjectExportWrite): Promise<void>;
  /**
   * Finishes a request: applies `patch` and stores its export in one transaction, only while the request is still
   * `searching`. False (nothing written) when another worker finished, failed or expired it first.
   */
  completeSubjectRequest(id: string, patch: SubjectRequestPatch, exported: SubjectExportWrite): Promise<boolean>;
  /** Open requests (`searching`, `ready`, `running`) past `at` and not yet notified, oldest due first. */
  listOverdueSubjectRequests(at: string, limit: number): Promise<SubjectRequestRecord[]>;
  /** Marks `ready` export requests that have no export row (a restore leaves exports out) `expired`; returns their ids. */
  expireReadySubjectRequestsWithoutExport(at: string): Promise<string[]>;
  getSubjectExport(requestId: string): Promise<SubjectExportRecord | null>;
  /**
   * Takes the sealed file of a request's export for its one download: only when it was not downloaded and has not
   * expired at `at`. Marks it downloaded and clears the stored file in the same statement. Null when refused.
   */
  claimSubjectExport(input: { requestId: string; by: string; at: string }): Promise<string | null>;
  /** Clears the files of exports that expired before `at` and were never downloaded; returns their request ids. */
  expireSubjectExports(at: string): Promise<string[]>;

  /** A page of a scan kind's searchable text, after the opaque cursor `after` (null: from the start). */
  subjectScanPage(kind: SubjectScanKind, after: string | null, limit: number): Promise<{ rows: SubjectTextRow[]; next: string | null }>;
  /** One row's searchable text by id (a run by id whatever its trigger), or null when it is gone. */
  subjectScanRow(kind: SubjectScanKind, id: string): Promise<SubjectTextRow | null>;
  /** A memory session and its artifacts, as export rows. */
  memorySessionSubjectRows(namespace: string, sessionId: string): Promise<SubjectTextRow[]>;
  /**
   * A staff member's identity and authored rows, by email in any case (each section at most STAFF_SUBJECT_ROWS_CAP
   * rows). The authored sections match the stored user's email, or the lower-cased value when no user has it.
   */
  staffSubjectRows(email: string): Promise<StaffSubjectRows>;
}

type Row = Record<string, unknown>;

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed === null || parsed === undefined ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}

function timestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function optionalTimestamp(value: unknown): string | null {
  return value === null || value === undefined || value === "" ? null : timestamp(value);
}

function optionalText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export const SUBJECT_REQUEST_COLUMNS =
  "id, type, subject_kind, query_hash, value_sealed, scan, reveal_tokens, status, due_at, due_notified_at, counts_json, progress_json, deferred_json, created_by, created_by_user_id, created_at, updated_at, error";

export function mapSubjectRequestRow(row: Row): SubjectRequestRecord {
  const type = String(row.type);
  const kind = String(row.subject_kind);
  const status = String(row.status);
  const counts = parseJson<Record<string, unknown>>(row.counts_json, {});
  return {
    id: String(row.id),
    type: ((SUBJECT_REQUEST_TYPES as readonly string[]).includes(type) ? type : "export") as SubjectRequestType,
    subjectKind: ((SUBJECT_KINDS as readonly string[]).includes(kind) ? kind : "end_user") as SubjectKind,
    queryHash: String(row.query_hash),
    valueSealed: optionalText(row.value_sealed),
    scan: Number(row.scan) === 1,
    revealTokens: Number(row.reveal_tokens) === 1,
    status: ((SUBJECT_REQUEST_STATUSES as readonly string[]).includes(status) ? status : "failed") as SubjectRequestStatus,
    dueAt: timestamp(row.due_at),
    dueNotifiedAt: optionalTimestamp(row.due_notified_at),
    counts: Object.fromEntries(
      Object.entries(counts && typeof counts === "object" && !Array.isArray(counts) ? counts : {})
        .map(([key, value]) => [key, Number(value)] as const)
        .filter(([, value]) => Number.isFinite(value))
    ),
    progress: (() => {
      const progress = parseJson<unknown>(row.progress_json, {});
      return progress && typeof progress === "object" && !Array.isArray(progress) ? (progress as Record<string, unknown>) : {};
    })(),
    deferred: (() => {
      const deferred = parseJson<unknown>(row.deferred_json, []);
      return Array.isArray(deferred) ? deferred : [];
    })(),
    createdBy: optionalText(row.created_by),
    createdByUserId: optionalText(row.created_by_user_id),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    error: optionalText(row.error)
  };
}

export function subjectRequestValues(record: SubjectRequestRecord): unknown[] {
  return [
    record.id,
    record.type,
    record.subjectKind,
    record.queryHash,
    record.valueSealed,
    record.scan ? 1 : 0,
    record.revealTokens ? 1 : 0,
    record.status,
    record.dueAt,
    record.dueNotifiedAt,
    JSON.stringify(record.counts),
    JSON.stringify(record.progress),
    JSON.stringify(record.deferred),
    record.createdBy,
    record.createdByUserId,
    record.createdAt,
    record.updatedAt,
    record.error
  ];
}

/** The SET list and values of a patch, with `placeholder(n)` naming the n-th parameter (1-based). */
export function subjectRequestPatchSql(patch: SubjectRequestPatch, placeholder: (n: number) => string): { set: string; values: unknown[] } {
  const parts: string[] = [];
  const values: unknown[] = [];
  const add = (column: string, value: unknown) => {
    values.push(value);
    parts.push(`${column} = ${placeholder(values.length)}`);
  };
  if (patch.status !== undefined) add("status", patch.status);
  if (patch.valueSealed !== undefined) add("value_sealed", patch.valueSealed);
  if (patch.counts !== undefined) add("counts_json", JSON.stringify(patch.counts));
  if (patch.progress !== undefined) add("progress_json", JSON.stringify(patch.progress));
  if (patch.deferred !== undefined) add("deferred_json", JSON.stringify(patch.deferred));
  if (patch.error !== undefined) add("error", patch.error);
  if (patch.dueNotifiedAt !== undefined) add("due_notified_at", patch.dueNotifiedAt);
  add("updated_at", patch.updatedAt);
  return { set: parts.join(", "), values };
}

export function mapSubjectExportRow(row: Row): SubjectExportRecord {
  return {
    id: String(row.id),
    requestId: String(row.request_id),
    bytes: Number(row.bytes),
    sha256: String(row.sha256),
    createdAt: timestamp(row.created_at),
    expiresAt: timestamp(row.expires_at),
    downloadedAt: optionalTimestamp(row.downloaded_at),
    downloadedBy: optionalText(row.downloaded_by),
    stored: Number(row.stored) === 1 || row.stored === true
  };
}

export function mapSubjectRefRow(row: Row): SubjectRefRow {
  const kind = String(row.kind);
  return {
    kind: ((SUBJECT_REF_KINDS as readonly string[]).includes(kind) ? kind : "run") as SubjectRefKind,
    rowId: String(row.row_id),
    projectId: optionalText(row.project_id),
    workflowId: optionalText(row.workflow_id),
    createdAt: timestamp(row.created_at)
  };
}

/** Each scan kind's searchable columns, by field name (both stores read the same columns). */
export const SUBJECT_SCAN_TEXT_COLUMNS: Record<SubjectScanKind, Record<string, string>> = {
  production_execution: { input: "input_json", output: "output_json", nodes: "node_results_json", customData: "custom_data_json", error: "error" },
  paused_run: { state: "state_json", message: "approval_message" },
  approval: { message: "message", details: "details_json", spec: "spec_json", edits: "edits_json", reason: "reason" },
  memory_session: { messages: "messages_json" },
  memory_artifact: { value: "value_json" },
  cassette_any: { cassette: "cassette_json" }
};

/** Maps a scan row (columns id, workflow_id, project_id, name, status plus the text columns) to a SubjectTextRow. */
export function mapSubjectScanRow(kind: SubjectScanKind, row: Row, id: string): SubjectTextRow {
  const texts: Record<string, string | null> = {};
  for (const [field, column] of Object.entries(SUBJECT_SCAN_TEXT_COLUMNS[kind])) texts[field] = typeof row[column] === "string" ? (row[column] as string) : null;
  return {
    // The lookup's own kinds are reused where they mean the same rows; the service maps scan kinds to row kinds.
    kind: kind as unknown as SubjectTextRow["kind"],
    id,
    workflowId: typeof row.workflow_id === "string" ? row.workflow_id : null,
    projectId: typeof row.project_id === "string" ? row.project_id : null,
    name: row.name === null || row.name === undefined ? id : String(row.name),
    status: typeof row.status === "string" ? row.status : null,
    texts
  };
}

/** The id a scan row is known by: its own id, or the memory keys as JSON. */
export function scanRowId(kind: SubjectScanKind, row: Record<string, unknown>): string {
  if (kind === "memory_session") return memorySessionRowId(String(row.namespace), String(row.session_id));
  if (kind === "memory_artifact") return memoryArtifactRowId(String(row.namespace), String(row.session_id), String(row.artifact_key));
  return String(row.id);
}

/** Parameters that find one scan row by id, or null when the id cannot name one. */
export function scanRowParams(kind: SubjectScanKind, id: string): string[] | null {
  if (kind === "memory_session") {
    const key = parseMemorySessionRowId(id);
    return key ? [key.namespace, key.sessionId] : null;
  }
  if (kind === "memory_artifact") {
    const key = parseMemoryArtifactRowId(id);
    return key ? [key.namespace, key.sessionId, key.artifactKey] : null;
  }
  return [id];
}

/** Columns of each staff section (never a password hash, key hash or secret). */
export const STAFF_SECTION_SQL = {
  user: "SELECT id, email, role, kind, description, created_by, created_at, updated_at FROM users WHERE lower(email) = lower(?)",
  ssoIdentities: "SELECT id, provider, subject, email, attributes_json, created_at, updated_at FROM sso_identities WHERE user_id = ? ORDER BY created_at LIMIT ?",
  projectRoles: "SELECT project_id, role, custom_role_id, created_at, updated_at FROM user_project_roles WHERE user_id = ? ORDER BY project_id LIMIT ?",
  apiKeys: "SELECT id, name, key_prefix, scopes_json, last_used_at, expires_at, revoked_at, created_at FROM api_keys WHERE user_id = ? ORDER BY created_at LIMIT ?",
  runsTriggered:
    "SELECT id, workflow_id, workflow_name, status, trigger_type, started_at, completed_at FROM execution_history WHERE triggered_by IN (?, ?) ORDER BY started_at LIMIT ?",
  workflowsCreated: "SELECT id, name, project_id, created_at FROM workflows WHERE created_by IN (?, ?) ORDER BY created_at LIMIT ?",
  approvals:
    "SELECT id, execution_id, workflow_id, project_id, kind, status, requested_by, decided_by, decided_at, created_at FROM approval_requests WHERE requested_by IN (?, ?) OR decided_by IN (?, ?) ORDER BY created_at LIMIT ?",
  evalRuns: "SELECT id, workflow_id, status, started_at FROM eval_runs WHERE triggered_by IN (?, ?) ORDER BY started_at LIMIT ?",
  releasesPublished: "SELECT id, workflow_id, version, verdict, published_at FROM workflow_releases WHERE published_by IN (?, ?) ORDER BY published_at LIMIT ?",
  auditEntries:
    "SELECT id, event_type, category, action, outcome, resource_type, resource_id, project_id, ip_address, user_agent, message, created_at FROM audit_logs WHERE actor_email IN (?, ?) OR actor_user_id = ? ORDER BY created_at LIMIT ?"
} as const;

/** `?` placeholders numbered for Postgres. */
export function numbered(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${(n += 1)}`);
}

export function plainRow(row: Row): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[key] = value instanceof Date ? value.toISOString() : typeof value === "bigint" ? Number(value) : value;
  return out;
}
