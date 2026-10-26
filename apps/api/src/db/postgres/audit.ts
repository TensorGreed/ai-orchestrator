/**
 * Phase 13.1 — PostgresStore: Audit log, log streaming, audit export, signing keys and execution manifests.
 * Plain functions over a PgContext; PostgresStore delegates here. Same observable behaviour as the SqliteStore
 * methods of the same names.
 *
 * Insertion order. SQLite orders the audit chain and the export cursor by rowid. Postgres has no rowid, so the chain
 * order is `created_at` (then id): every append runs under one advisory transaction lock and, when the caller gives
 * no `createdAt`, stores GREATEST(now, latest created_at + 1 µs). TIMESTAMPTZ keeps the microseconds, so rows written
 * in one millisecond still sort in insertion order, while the read path (parseTimestamptz) returns the millisecond ISO
 * string the SQLite store returns. The hash covers exactly that returned string, so verifyAuditChain recomputes it.
 * A caller-given `createdAt` (tests only; AuditService never passes one) is stored as given, so a backdated entry
 * sorts where its time puts it.
 *
 * Advisory lock keys, beside ADVISORY_LOCK_CLASS_MIGRATIONS (0x4c324d) and ADVISORY_LOCK_CLASS_LEADER (0x4c324e) in
 * postgres-store.ts:
 *   0x4c324f ("L2O")  audit writes — key 1: the audit-log chain append; key 2: signing-key activation.
 */
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { AuditSigningKeyRecord, ExecutionManifestRecord, LogStreamDestinationRecord } from "../database.js";
import { type Store } from "../store.js";
import { parseJsonSafe, toNum, toStr } from "./helpers.js";
import type { PgContext } from "./context.js";

export const UNIMPLEMENTED_METHODS: readonly (keyof Store)[] = [];

export const ADVISORY_LOCK_CLASS_AUDIT = 0x4c324f;
const AUDIT_LOCK_CHAIN = 1;
const AUDIT_LOCK_SIGNING_KEYS = 2;
const GENESIS_HASH = "0".repeat(64);

type Row = Record<string, unknown>;

function nullableStr(value: unknown): string | null {
  return value ? toStr(value) : null;
}

/**
 * A stored optional audit field as the write path hashed it: NULL stays null and "" stays "" (the writer hashes
 * `value ?? null`). Reading by truthiness would turn "" into null and break the chain at that row.
 */
function storedAuditText(value: unknown): string | null {
  return value === null || value === undefined ? null : toStr(value);
}

/** Same as the SQLite store's canonicalAuditPayload: explicit field order, never sorted. */
function canonicalAuditPayload(input: {
  id: string;
  createdAt: string;
  eventType: string;
  category: string;
  action: string;
  outcome: string;
  actorUserId: string | null;
  actorEmail: string | null;
  actorType: string;
  resourceType: string | null;
  resourceId: string | null;
  projectId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadataJson: string | null;
  message: string | null;
}): string {
  return JSON.stringify([
    input.id,
    input.createdAt,
    input.eventType,
    input.category,
    input.action,
    input.outcome,
    input.actorUserId,
    input.actorEmail,
    input.actorType,
    input.resourceType,
    input.resourceId,
    input.projectId,
    input.ipAddress,
    input.userAgent,
    input.metadataJson,
    input.message
  ]);
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

async function advisoryXactLock(client: PoolClient, key: number): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock($1, $2)`, [ADVISORY_LOCK_CLASS_AUDIT, key]);
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export async function writeAuditLog(ctx: PgContext, entry: Parameters<Store["writeAuditLog"]>[0]): Promise<void> {
  const metadataJson = entry.metadata === undefined ? null : JSON.stringify(entry.metadata);
  await ctx.withTransaction(async (client) => {
    await advisoryXactLock(client, AUDIT_LOCK_CHAIN);
    // `iso` comes back through parseTimestamptz (the string every read returns); `exact` keeps the microseconds.
    const stamp = entry.createdAt === undefined
      ? await client.query<{ iso: string; exact: string }>(
          `SELECT ts AS iso, ts::text AS exact FROM (
             SELECT GREATEST($1::timestamptz, (SELECT MAX(created_at) FROM audit_logs) + interval '1 microsecond') AS ts
           ) s`,
          [new Date().toISOString()]
        )
      : await client.query<{ iso: string; exact: string }>(`SELECT $1::timestamptz AS iso, $1::timestamptz::text AS exact`, [entry.createdAt]);
    const createdAt = toStr(stamp.rows[0]?.iso);
    const createdAtExact = toStr(stamp.rows[0]?.exact);
    const last = await client.query<{ entry_hash: string | null }>(
      `SELECT entry_hash FROM audit_logs WHERE entry_hash IS NOT NULL ORDER BY created_at DESC, id COLLATE "C" DESC LIMIT 1`
    );
    const prevHash = last.rows[0]?.entry_hash ? toStr(last.rows[0].entry_hash) : GENESIS_HASH;
    const canonical = canonicalAuditPayload({
      id: entry.id,
      createdAt,
      eventType: entry.eventType,
      category: entry.category,
      action: entry.action,
      outcome: entry.outcome,
      actorUserId: entry.actorUserId ?? null,
      actorEmail: entry.actorEmail ?? null,
      actorType: entry.actorType ?? "user",
      resourceType: entry.resourceType ?? null,
      resourceId: entry.resourceId ?? null,
      projectId: entry.projectId ?? null,
      ipAddress: entry.ipAddress ?? null,
      userAgent: entry.userAgent ?? null,
      metadataJson,
      message: entry.message ?? null
    });
    const entryHash = sha256Hex(prevHash + canonical);
    await client.query(
      `INSERT INTO audit_logs
         (id, event_type, category, action, outcome, actor_user_id, actor_email, actor_type,
          resource_type, resource_id, project_id, ip_address, user_agent, metadata_json, message, created_at,
          prev_hash, entry_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::timestamptz, $17, $18)`,
      [
        entry.id,
        entry.eventType,
        entry.category,
        entry.action,
        entry.outcome,
        entry.actorUserId ?? null,
        entry.actorEmail ?? null,
        entry.actorType ?? "user",
        entry.resourceType ?? null,
        entry.resourceId ?? null,
        entry.projectId ?? null,
        entry.ipAddress ?? null,
        entry.userAgent ?? null,
        metadataJson,
        entry.message ?? null,
        createdAtExact,
        prevHash,
        entryHash
      ]
    );
  });
}

export async function verifyAuditChain(ctx: PgContext): ReturnType<Store["verifyAuditChain"]> {
  const rows = await ctx.query<Row>(
    `SELECT id, event_type, category, action, outcome, actor_user_id, actor_email, actor_type,
            resource_type, resource_id, project_id, ip_address, user_agent, metadata_json, message,
            created_at, prev_hash, entry_hash
     FROM audit_logs WHERE entry_hash IS NOT NULL
     ORDER BY created_at ASC, id COLLATE "C" ASC`
  );
  let prev = GENESIS_HASH;
  let checked = 0;
  for (const row of rows) {
    const stored = toStr(row.entry_hash ?? "");
    const storedPrev = toStr(row.prev_hash ?? "");
    if (storedPrev !== prev) {
      return {
        ok: false,
        rowsChecked: checked,
        firstBrokenAt: { id: toStr(row.id), createdAt: toStr(row.created_at), expected: prev, stored: storedPrev }
      };
    }
    const canonical = canonicalAuditPayload({
      id: toStr(row.id),
      createdAt: toStr(row.created_at),
      eventType: toStr(row.event_type),
      category: toStr(row.category),
      action: toStr(row.action),
      outcome: toStr(row.outcome),
      actorUserId: storedAuditText(row.actor_user_id),
      actorEmail: storedAuditText(row.actor_email),
      actorType: toStr(row.actor_type),
      resourceType: storedAuditText(row.resource_type),
      resourceId: storedAuditText(row.resource_id),
      projectId: storedAuditText(row.project_id),
      ipAddress: storedAuditText(row.ip_address),
      userAgent: storedAuditText(row.user_agent),
      metadataJson: storedAuditText(row.metadata_json),
      message: storedAuditText(row.message)
    });
    const expected = sha256Hex(prev + canonical);
    if (expected !== stored) {
      return {
        ok: false,
        rowsChecked: checked,
        firstBrokenAt: { id: toStr(row.id), createdAt: toStr(row.created_at), expected, stored }
      };
    }
    prev = expected;
    checked += 1;
  }
  return { ok: true, rowsChecked: checked };
}

function mapAuditLogRow(row: Row) {
  return {
    id: toStr(row.id),
    eventType: toStr(row.event_type),
    category: toStr(row.category),
    action: toStr(row.action),
    outcome: toStr(row.outcome),
    actorUserId: nullableStr(row.actor_user_id),
    actorEmail: nullableStr(row.actor_email),
    actorType: toStr(row.actor_type),
    resourceType: nullableStr(row.resource_type),
    resourceId: nullableStr(row.resource_id),
    projectId: nullableStr(row.project_id),
    ipAddress: nullableStr(row.ip_address),
    userAgent: nullableStr(row.user_agent),
    metadata: row.metadata_json ? parseJsonSafe(toStr(row.metadata_json)) : null,
    message: nullableStr(row.message),
    createdAt: toStr(row.created_at)
  };
}

const AUDIT_LOG_COLUMNS = `id, event_type, category, action, outcome, actor_user_id, actor_email, actor_type,
              resource_type, resource_id, project_id, ip_address, user_agent, metadata_json, message, created_at`;

export async function listAuditLogs(ctx: PgContext, filter: Parameters<Store["listAuditLogs"]>[0] = {}): ReturnType<Store["listAuditLogs"]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    clauses.push(sql.replace("?", `$${params.length}`));
  };
  if (filter.category) add(`category = ?`, filter.category);
  if (filter.eventType) add(`event_type = ?`, filter.eventType);
  if (filter.outcome) add(`outcome = ?`, filter.outcome);
  if (filter.actorUserId) add(`actor_user_id = ?`, filter.actorUserId);
  if (filter.resourceType) add(`resource_type = ?`, filter.resourceType);
  if (filter.resourceId) add(`resource_id = ?`, filter.resourceId);
  if (filter.projectId) add(`project_id = ?`, filter.projectId);
  if (filter.from) add(`created_at >= ?`, filter.from);
  if (filter.to) add(`created_at <= ?`, filter.to);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const totalRow = await ctx.queryOne<{ count: string }>(`SELECT COUNT(*) AS count FROM audit_logs ${where}`, params);
  const total = totalRow ? toNum(totalRow.count) : 0;

  const pageSize = Math.max(1, Math.min(500, filter.pageSize ?? 50));
  const page = Math.max(1, filter.page ?? 1);
  const offset = (page - 1) * pageSize;
  const rows = await ctx.query<Row>(
    `SELECT ${AUDIT_LOG_COLUMNS}
     FROM audit_logs ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset]
  );
  return { items: rows.map(mapAuditLogRow), total, page, pageSize };
}

export async function pruneAuditLogs(ctx: PgContext, options: { before: string }): Promise<number> {
  // Phase 11.1 — cached run manifests older than the audit-log retention whose execution history is gone.
  await pruneExecutionManifests(ctx, options);
  const result = await ctx.pool.query(`DELETE FROM audit_logs WHERE created_at < $1`, [options.before]);
  return result.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Log streaming destinations + delivery history
// ---------------------------------------------------------------------------

const LOG_STREAM_DESTINATION_COLUMNS = `id, name, type, enabled, categories_json, min_level, config_iv, config_auth_tag,
              config_ciphertext, last_success_at, last_error_at, last_error, dispatched_count,
              failed_count, created_by, created_at, updated_at`;

function parseStringArray(value: unknown): string[] {
  const parsed = typeof value === "string" ? parseJsonSafe(value) : null;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function mapLogStreamDestinationRow(row: Row): LogStreamDestinationRecord {
  return {
    id: toStr(row.id),
    name: toStr(row.name),
    type: toStr(row.type),
    enabled: toNum(row.enabled) === 1,
    categories: parseStringArray(row.categories_json),
    minLevel: toStr(row.min_level),
    configIv: nullableStr(row.config_iv),
    configAuthTag: nullableStr(row.config_auth_tag),
    configCiphertext: nullableStr(row.config_ciphertext),
    lastSuccessAt: nullableStr(row.last_success_at),
    lastErrorAt: nullableStr(row.last_error_at),
    lastError: nullableStr(row.last_error),
    dispatchedCount: toNum(row.dispatched_count),
    failedCount: toNum(row.failed_count),
    createdBy: nullableStr(row.created_by),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at)
  };
}

export async function listLogStreamDestinations(ctx: PgContext): Promise<LogStreamDestinationRecord[]> {
  const rows = await ctx.query<Row>(`SELECT ${LOG_STREAM_DESTINATION_COLUMNS} FROM log_stream_destinations ORDER BY created_at DESC`);
  return rows.map(mapLogStreamDestinationRow);
}

export async function getLogStreamDestination(ctx: PgContext, id: string): Promise<LogStreamDestinationRecord | null> {
  const row = await ctx.queryOne<Row>(`SELECT ${LOG_STREAM_DESTINATION_COLUMNS} FROM log_stream_destinations WHERE id = $1`, [id]);
  return row ? mapLogStreamDestinationRow(row) : null;
}

export async function upsertLogStreamDestination(ctx: PgContext, input: Parameters<Store["upsertLogStreamDestination"]>[0]): Promise<void> {
  const now = new Date().toISOString();
  // A new row starts with no delivery history; an existing one keeps its history, creator and creation time.
  await ctx.execute(
    `INSERT INTO log_stream_destinations
       (id, name, type, enabled, categories_json, min_level, config_iv, config_auth_tag,
        config_ciphertext, last_success_at, last_error_at, last_error, dispatched_count,
        failed_count, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, NULL, NULL, 0, 0, $10, $11, $12)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       type = EXCLUDED.type,
       enabled = EXCLUDED.enabled,
       categories_json = EXCLUDED.categories_json,
       min_level = EXCLUDED.min_level,
       config_iv = EXCLUDED.config_iv,
       config_auth_tag = EXCLUDED.config_auth_tag,
       config_ciphertext = EXCLUDED.config_ciphertext,
       updated_at = EXCLUDED.updated_at`,
    [
      input.id,
      input.name,
      input.type,
      input.enabled === false ? 0 : 1,
      JSON.stringify(input.categories ?? []),
      input.minLevel ?? "info",
      input.configIv ?? null,
      input.configAuthTag ?? null,
      input.configCiphertext ?? null,
      input.createdBy ?? null,
      now,
      now
    ]
  );
}

export async function deleteLogStreamDestination(ctx: PgContext, id: string): Promise<boolean> {
  return ctx.withTransaction(async (client) => {
    const deleted = await client.query(`DELETE FROM log_stream_destinations WHERE id = $1`, [id]);
    if ((deleted.rowCount ?? 0) === 0) return false;
    await client.query(`DELETE FROM log_stream_events WHERE destination_id = $1`, [id]);
    return true;
  });
}

export async function recordLogStreamDispatch(ctx: PgContext, input: Parameters<Store["recordLogStreamDispatch"]>[0]): Promise<void> {
  const now = input.at ?? new Date().toISOString();
  if (input.success) {
    await ctx.execute(
      `UPDATE log_stream_destinations
       SET last_success_at = $1, dispatched_count = dispatched_count + 1, updated_at = $2
       WHERE id = $3`,
      [now, now, input.destinationId]
    );
  } else {
    await ctx.execute(
      `UPDATE log_stream_destinations
       SET last_error_at = $1, last_error = $2, failed_count = failed_count + 1, updated_at = $3
       WHERE id = $4`,
      [now, input.error ?? "unknown error", now, input.destinationId]
    );
  }
}

export async function writeLogStreamEvent(ctx: PgContext, entry: Parameters<Store["writeLogStreamEvent"]>[0]): Promise<void> {
  const createdAt = entry.createdAt ?? new Date().toISOString();
  await ctx.execute(
    `INSERT INTO log_stream_events
       (id, destination_id, category, event_type, level, status, attempts, error, payload_json, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      entry.id,
      entry.destinationId,
      entry.category,
      entry.eventType,
      entry.level,
      entry.status,
      entry.attempts ?? 0,
      entry.error ?? null,
      entry.payload === undefined ? null : JSON.stringify(entry.payload),
      createdAt
    ]
  );
}

export async function listLogStreamEvents(ctx: PgContext, filter: Parameters<Store["listLogStreamEvents"]>[0] = {}): ReturnType<Store["listLogStreamEvents"]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.destinationId) {
    params.push(filter.destinationId);
    clauses.push(`destination_id = $${params.length}`);
  }
  if (filter.status) {
    params.push(filter.status);
    clauses.push(`status = $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(500, filter.limit ?? 100));
  const rows = await ctx.query<Row>(
    `SELECT id, destination_id, category, event_type, level, status, attempts, error, payload_json, created_at
     FROM log_stream_events ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length + 1}`,
    [...params, limit]
  );
  return rows.map((row) => ({
    id: toStr(row.id),
    destinationId: toStr(row.destination_id),
    category: toStr(row.category),
    eventType: toStr(row.event_type),
    level: toStr(row.level),
    status: toStr(row.status),
    attempts: toNum(row.attempts),
    error: nullableStr(row.error),
    payload: row.payload_json ? parseJsonSafe(toStr(row.payload_json)) : null,
    createdAt: toStr(row.created_at)
  }));
}

export async function pruneLogStreamEvents(ctx: PgContext, options: { before: string }): Promise<number> {
  const result = await ctx.pool.query(`DELETE FROM log_stream_events WHERE created_at < $1`, [options.before]);
  return result.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Audit export destinations + runs
// ---------------------------------------------------------------------------

export async function createAuditExportDestination(ctx: PgContext, input: Parameters<Store["createAuditExportDestination"]>[0]): Promise<void> {
  const now = new Date().toISOString();
  await ctx.execute(
    `INSERT INTO audit_export_destinations
       (id, name, kind, config_json, interval_seconds, enabled, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.id,
      input.name,
      input.kind,
      JSON.stringify(input.config),
      input.intervalSeconds ?? 3600,
      input.enabled === false ? 0 : 1,
      input.createdBy ?? null,
      now,
      now
    ]
  );
}

export async function updateAuditExportDestination(
  ctx: PgContext,
  id: string,
  patch: Parameters<Store["updateAuditExportDestination"]>[1]
): Promise<boolean> {
  const fields: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown) => {
    params.push(value);
    fields.push(`${column} = $${params.length}`);
  };
  if (patch.name !== undefined) set("name", patch.name);
  if (patch.config !== undefined) set("config_json", JSON.stringify(patch.config));
  if (patch.intervalSeconds !== undefined) set("interval_seconds", patch.intervalSeconds);
  if (patch.enabled !== undefined) set("enabled", patch.enabled ? 1 : 0);
  if (fields.length === 0) return false;
  set("updated_at", new Date().toISOString());
  params.push(id);
  await ctx.execute(`UPDATE audit_export_destinations SET ${fields.join(", ")} WHERE id = $${params.length}`, params);
  return true;
}

export async function deleteAuditExportDestination(ctx: PgContext, id: string): Promise<boolean> {
  await ctx.withTransaction(async (client) => {
    await client.query(`DELETE FROM audit_export_runs WHERE destination_id = $1`, [id]);
    await client.query(`DELETE FROM audit_export_destinations WHERE id = $1`, [id]);
  });
  return true;
}

type AuditExportDestination = Awaited<ReturnType<Store["listAuditExportDestinations"]>>[number];

function mapAuditExportDestination(r: Row): AuditExportDestination {
  return {
    id: toStr(r.id),
    name: toStr(r.name),
    kind: toStr(r.kind),
    config: r.config_json ? (JSON.parse(toStr(r.config_json)) as Record<string, unknown>) : {},
    intervalSeconds: toNum(r.interval_seconds),
    enabled: toNum(r.enabled) === 1,
    lastExportId: nullableStr(r.last_export_id),
    lastExportAt: nullableStr(r.last_export_at),
    lastStatus: nullableStr(r.last_status),
    lastError: nullableStr(r.last_error),
    createdBy: nullableStr(r.created_by),
    createdAt: toStr(r.created_at),
    updatedAt: toStr(r.updated_at)
  };
}

export async function listAuditExportDestinations(ctx: PgContext): Promise<AuditExportDestination[]> {
  const rows = await ctx.query<Row>(`SELECT * FROM audit_export_destinations ORDER BY name COLLATE "C"`);
  return rows.map(mapAuditExportDestination);
}

export async function getAuditExportDestination(ctx: PgContext, id: string): Promise<AuditExportDestination | null> {
  const row = await ctx.queryOne<Row>(`SELECT * FROM audit_export_destinations WHERE id = $1`, [id]);
  return row ? mapAuditExportDestination(row) : null;
}

/** Rows after the cursor row in insertion order (created_at, see the header), or from the start when it is gone. */
export async function listAuditLogsAfter(ctx: PgContext, input: { afterId: string | null; limit: number }): ReturnType<Store["listAuditLogsAfter"]> {
  const limit = Math.min(Math.max(input.limit, 1), 5000);
  let where = "";
  const params: unknown[] = [];
  if (input.afterId) {
    const cursor = await ctx.queryOne<{ created_at: string; exact: string; id: string }>(
      `SELECT created_at, created_at::text AS exact, id FROM audit_logs WHERE id = $1`,
      [input.afterId]
    );
    if (cursor) {
      params.push(cursor.exact, cursor.id);
      where = `WHERE (created_at > $1::timestamptz OR (created_at = $1::timestamptz AND id COLLATE "C" > $2 COLLATE "C"))`;
    }
  }
  const rows = await ctx.query<Row>(
    `SELECT ${AUDIT_LOG_COLUMNS}, entry_hash
     FROM audit_logs ${where}
     ORDER BY created_at ASC, id COLLATE "C" ASC LIMIT $${params.length + 1}`,
    [...params, limit]
  );
  return rows.map((r) => ({ ...mapAuditLogRow(r), entryHash: nullableStr(r.entry_hash) }));
}

export async function recordAuditExportRun(ctx: PgContext, input: Parameters<Store["recordAuditExportRun"]>[0]): Promise<void> {
  await ctx.withTransaction(async (client) => {
    await client.query(
      `INSERT INTO audit_export_runs
         (id, destination_id, started_at, completed_at, status, rows_exported, first_id, last_id, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        input.id,
        input.destinationId,
        input.startedAt,
        input.completedAt,
        input.status,
        input.rowsExported,
        input.firstId ?? null,
        input.lastId ?? null,
        input.error ?? null
      ]
    );
    if (input.status === "success" && input.lastId) {
      await client.query(
        `UPDATE audit_export_destinations
         SET last_export_id = $1, last_export_at = $2, last_status = $3, last_error = NULL, updated_at = $4
         WHERE id = $5`,
        [input.lastId, input.completedAt, input.status, new Date().toISOString(), input.destinationId]
      );
    } else if (input.status === "failure") {
      await client.query(
        `UPDATE audit_export_destinations
         SET last_status = $1, last_error = $2, updated_at = $3
         WHERE id = $4`,
        [input.status, input.error ?? "unknown", new Date().toISOString(), input.destinationId]
      );
    }
  });
}

export async function listAuditExportRuns(ctx: PgContext, destinationId: string, limit = 25): ReturnType<Store["listAuditExportRuns"]> {
  const rows = await ctx.query<Row>(
    `SELECT * FROM audit_export_runs WHERE destination_id = $1 ORDER BY started_at DESC LIMIT $2`,
    [destinationId, Math.min(Math.max(limit, 1), 200)]
  );
  return rows.map((r) => ({
    id: toStr(r.id),
    destinationId: toStr(r.destination_id),
    startedAt: toStr(r.started_at),
    completedAt: nullableStr(r.completed_at),
    status: toStr(r.status),
    rowsExported: toNum(r.rows_exported),
    firstId: nullableStr(r.first_id),
    lastId: nullableStr(r.last_id),
    error: nullableStr(r.error)
  }));
}

// ---------------------------------------------------------------------------
// Execution manifests (Phase 11.1)
// ---------------------------------------------------------------------------

function mapExecutionManifest(row: Row): ExecutionManifestRecord {
  let runContext: unknown = null;
  if (typeof row.run_context_json === "string" && row.run_context_json) {
    try {
      runContext = JSON.parse(row.run_context_json);
    } catch {
      runContext = null;
    }
  }
  return {
    executionId: toStr(row.execution_id),
    runContext,
    manifestJson: typeof row.manifest_json === "string" ? row.manifest_json : null,
    manifestDigest: typeof row.manifest_digest === "string" ? row.manifest_digest : null,
    keyId: typeof row.key_id === "string" ? row.key_id : null,
    signature: typeof row.signature === "string" ? row.signature : null,
    signedAt: typeof row.signed_at === "string" ? row.signed_at : null,
    createdAt: toStr(row.created_at)
  };
}

export async function getExecutionManifest(ctx: PgContext, executionId: string): Promise<ExecutionManifestRecord | null> {
  const row = await ctx.queryOne<Row>(`SELECT * FROM execution_manifests WHERE execution_id = $1`, [executionId]);
  return row ? mapExecutionManifest(row) : null;
}

export async function saveExecutionRunContext(ctx: PgContext, executionId: string, runContext: unknown, createdAt: string): Promise<void> {
  await ctx.execute(
    `INSERT INTO execution_manifests (execution_id, run_context_json, created_at) VALUES ($1, $2, $3)
     ON CONFLICT (execution_id) DO UPDATE SET run_context_json = EXCLUDED.run_context_json, created_at = EXCLUDED.created_at
     WHERE execution_manifests.manifest_json IS NULL`,
    [executionId, JSON.stringify(runContext), createdAt]
  );
}

export async function saveExecutionManifest(ctx: PgContext, input: Parameters<Store["saveExecutionManifest"]>[0]): Promise<ExecutionManifestRecord> {
  await ctx.execute(
    `INSERT INTO execution_manifests (execution_id, manifest_json, manifest_digest, key_id, signature, signed_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (execution_id) DO UPDATE SET
       manifest_json = EXCLUDED.manifest_json,
       manifest_digest = EXCLUDED.manifest_digest,
       key_id = EXCLUDED.key_id,
       signature = EXCLUDED.signature,
       signed_at = EXCLUDED.signed_at
     WHERE execution_manifests.manifest_json IS NULL`,
    [input.executionId, input.manifestJson, input.manifestDigest, input.keyId, input.signature, input.signedAt, input.signedAt]
  );
  return (await getExecutionManifest(ctx, input.executionId))!;
}

export async function listAuditLogsForExecution(ctx: PgContext, executionId: string): ReturnType<Store["listAuditLogsForExecution"]> {
  const rows = await ctx.query<Row>(
    `SELECT a.event_type, a.action, a.outcome, a.actor_user_id, a.actor_email, a.actor_type, a.message, a.created_at,
            a.resource_type, a.resource_id, a.metadata_json, u.role AS actor_role
     FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
     WHERE (a.resource_type = 'execution' AND a.resource_id = $1) OR strpos(a.metadata_json, $2) > 0
     ORDER BY a.created_at, a.id COLLATE "C"`,
    [executionId, JSON.stringify(executionId)]
  );
  return rows
    .filter((row) => {
      if (row.resource_type === "execution" && row.resource_id === executionId) return true;
      try {
        const metadata = JSON.parse(String(row.metadata_json ?? "null")) as unknown;
        return Boolean(metadata) && typeof metadata === "object" && (metadata as Record<string, unknown>).executionId === executionId;
      } catch {
        return false;
      }
    })
    .map((row) => ({
      eventType: toStr(row.event_type),
      action: toStr(row.action),
      outcome: toStr(row.outcome),
      actorUserId: typeof row.actor_user_id === "string" ? row.actor_user_id : null,
      actorRole: typeof row.actor_role === "string" ? row.actor_role : null,
      actorEmail: typeof row.actor_email === "string" ? row.actor_email : null,
      actorType: toStr(row.actor_type),
      message: typeof row.message === "string" ? row.message : null,
      createdAt: toStr(row.created_at)
    }));
}

export async function pruneExecutionManifests(ctx: PgContext, options: { before: string }): Promise<number> {
  const result = await ctx.pool.query(
    `DELETE FROM execution_manifests
     WHERE created_at < $1 AND NOT EXISTS (SELECT 1 FROM execution_history h WHERE h.id = execution_manifests.execution_id)`,
    [options.before]
  );
  return result.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Audit signing keys (Phase 11.1)
// ---------------------------------------------------------------------------

function mapAuditSigningKey(row: Row): AuditSigningKeyRecord {
  return {
    keyId: toStr(row.key_id),
    algorithm: toStr(row.algorithm),
    publicKey: toStr(row.public_key),
    source: row.source === "env" ? "env" : "generated",
    secretId: typeof row.secret_id === "string" && row.secret_id ? row.secret_id : null,
    status: row.status === "active" ? "active" : "retired",
    createdAt: toStr(row.created_at),
    retiredAt: typeof row.retired_at === "string" ? row.retired_at : null
  };
}

export async function listAuditSigningKeys(ctx: PgContext): Promise<AuditSigningKeyRecord[]> {
  const rows = await ctx.query<Row>(`SELECT * FROM audit_signing_keys ORDER BY created_at DESC, key_id COLLATE "C" ASC`);
  return rows.map(mapAuditSigningKey);
}

export async function getAuditSigningKey(ctx: PgContext, keyId: string): Promise<AuditSigningKeyRecord | null> {
  const row = await ctx.queryOne<Row>(`SELECT * FROM audit_signing_keys WHERE key_id = $1`, [keyId]);
  return row ? mapAuditSigningKey(row) : null;
}

export async function getActiveAuditSigningKey(ctx: PgContext): Promise<AuditSigningKeyRecord | null> {
  const row = await ctx.queryOne<Row>(`SELECT * FROM audit_signing_keys WHERE status = 'active'`);
  return row ? mapAuditSigningKey(row) : null;
}

/**
 * One transaction under the signing-key advisory lock: the expected-active check, the retire and the activation
 * cannot interleave with another activation, so exactly one of two racing writers wins and the other gets false.
 */
export async function activateAuditSigningKey(
  ctx: PgContext,
  key: Omit<AuditSigningKeyRecord, "status" | "retiredAt">,
  expectedActiveKeyId: string | null
): Promise<boolean> {
  const now = new Date().toISOString();
  return ctx.withTransaction(async (client) => {
    await advisoryXactLock(client, AUDIT_LOCK_SIGNING_KEYS);
    const current = await client.query<{ key_id: string }>(`SELECT key_id FROM audit_signing_keys WHERE status = 'active'`);
    const currentKeyId = current.rows[0] ? toStr(current.rows[0].key_id) : null;
    if (currentKeyId !== expectedActiveKeyId) return false;
    if (currentKeyId && currentKeyId !== key.keyId) {
      await client.query(`UPDATE audit_signing_keys SET status = 'retired', retired_at = $1, secret_id = NULL WHERE key_id = $2`, [now, currentKeyId]);
    }
    await client.query(
      `INSERT INTO audit_signing_keys (key_id, algorithm, public_key, source, secret_id, status, created_at, retired_at)
       VALUES ($1, $2, $3, $4, $5, 'active', $6, NULL)
       ON CONFLICT (key_id) DO UPDATE SET status = 'active', retired_at = NULL, source = EXCLUDED.source, secret_id = EXCLUDED.secret_id`,
      [key.keyId, key.algorithm, key.publicKey, key.source, key.secretId, key.createdAt]
    );
    return true;
  });
}
