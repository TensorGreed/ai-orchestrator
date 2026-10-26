/**
 * Phase 13.1 — PostgresStore: Guard profiles, versions, bindings, events, vault and revision.
 * Plain functions over a PgContext; PostgresStore delegates here. Each matches the SqliteStore method of the same
 * name (shapes, ordering, null handling). Text ordering uses the "C" collation, which compares like SQLite's BINARY;
 * `lower(… COLLATE "C")` folds ASCII only, like SQLite's NOCASE.
 */
import type { PoolClient } from "pg";
import type {
  GuardBindingRecord,
  GuardBindingScope,
  GuardEventFilters,
  GuardEventInsert,
  GuardEventRecord,
  GuardEventStats,
  GuardProfileRecord,
  GuardProfileVersionRecord,
  GuardVaultRow
} from "../database.js";
import { SUBJECT_EXECUTION_TRIGGERS } from "../database.js";
import { type Store } from "../store.js";
import { nulSafeJsonb, toNum, toStr } from "./helpers.js";
import type { PgContext } from "./context.js";

export const UNIMPLEMENTED_METHODS: readonly (keyof Store)[] = [];

type Row = Record<string, unknown>;

const nullableText = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

function parseJsonList<T>(raw: unknown): T[] {
  try {
    const parsed = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function mapGuardProfileRow(row: Row): GuardProfileRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    description: nullableText(row.description),
    builtIn: Number(row.built_in) === 1,
    latestVersion: Number(row.latest_version),
    latestHash: String(row.latest_hash ?? ""),
    createdAt: String(row.created_at),
    createdBy: nullableText(row.created_by),
    updatedAt: String(row.updated_at),
    updatedBy: nullableText(row.updated_by)
  };
}

function mapGuardProfileVersionRow(row: Row): GuardProfileVersionRecord {
  let document: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(row.document_json));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) document = parsed as Record<string, unknown>;
  } catch {
    document = {};
  }
  return {
    profileId: String(row.profile_id),
    version: Number(row.version),
    hash: String(row.hash),
    document,
    note: nullableText(row.note),
    createdAt: String(row.created_at),
    createdBy: nullableText(row.created_by)
  };
}

function mapGuardBindingRow(row: Row): GuardBindingRecord {
  return {
    scope: String(row.scope) === "workflow" ? "workflow" : "project",
    scopeId: String(row.scope_id),
    mode: String(row.mode),
    profileId: nullableText(row.profile_id),
    updatedAt: String(row.updated_at),
    updatedBy: nullableText(row.updated_by)
  };
}

function mapGuardEventRow(row: Row): GuardEventRecord {
  return {
    id: String(row.id),
    verdictId: String(row.verdict_id),
    executionId: String(row.execution_id),
    workflowId: nullableText(row.workflow_id),
    projectId: nullableText(row.project_id),
    nodeId: String(row.node_id),
    placement: String(row.placement),
    iteration: row.iteration === null || row.iteration === undefined ? null : Number(row.iteration),
    toolName: nullableText(row.tool_name),
    channel: String(row.channel),
    detectorId: nullableText(row.detector_id),
    category: nullableText(row.category),
    dataClass: nullableText(row.data_class),
    score: row.score === null || row.score === undefined ? null : Number(row.score),
    requestedAction: String(row.requested_action),
    effectiveAction: String(row.effective_action),
    verdictAction: String(row.verdict_action),
    shadow: Number(row.shadow) === 1,
    evidence: parseJsonList<GuardEventRecord["evidence"][number]>(row.evidence_json),
    profileId: String(row.profile_id),
    profileVersion: Number(row.profile_version),
    profileHash: String(row.profile_hash),
    latencyMs: Number(row.latency_ms ?? 0),
    budgetExceeded: Number(row.budget_exceeded) === 1,
    skippedDetectors: parseJsonList<string>(row.skipped_detectors_json),
    createdAt: String(row.created_at)
  };
}

const PROFILE_SELECT = `SELECT p.*, v.hash AS latest_hash FROM guard_profiles p
  LEFT JOIN guard_profile_versions v ON v.profile_id = p.id AND v.version = p.latest_version`;

async function oneRow(client: PoolClient, sql: string, params: unknown[]): Promise<Row | null> {
  const result = await client.query(sql, params);
  return (result.rows[0] as Row | undefined) ?? null;
}

export async function listGuardProfiles(ctx: PgContext): Promise<GuardProfileRecord[]> {
  const rows = await ctx.query<Row>(`${PROFILE_SELECT} ORDER BY p.built_in DESC, lower(p.name COLLATE "C") ASC`);
  return rows.map(mapGuardProfileRow);
}

export async function getGuardProfile(ctx: PgContext, id: string): Promise<GuardProfileRecord | null> {
  const row = await ctx.queryOne<Row>(`${PROFILE_SELECT} WHERE p.id = $1`, [id]);
  return row ? mapGuardProfileRow(row) : null;
}

/** The v37 trigger counter; undefined when its row is missing (callers then read the database, not their caches). */
export async function guardProfileRevision(ctx: PgContext): Promise<number | undefined> {
  const row = await ctx.queryOne<{ revision: unknown }>(`SELECT revision FROM guard_profile_revision WHERE id = 1`);
  return row === null || row.revision === null || row.revision === undefined ? undefined : Number(row.revision);
}

/** Per store (context): the last anyGuardProfileUsesLabels answer and the revision it was read at. */
const labelsCache = new WeakMap<PgContext, { revision: number; value: boolean }>();

export async function anyGuardProfileUsesLabels(ctx: PgContext): Promise<boolean> {
  const revision = await guardProfileRevision(ctx);
  const cached = labelsCache.get(ctx);
  if (revision !== undefined && cached?.revision === revision) return cached.value;
  // Read as JSON (not as text), so key order and formatting never matter. A document that is not a JSON object
  // cannot match (SQLite's json_valid + json_extract read it as no match too); CASE keeps the cast behind the check.
  // A NUL character in any string of any version must not fail this check (every run calls it): nulSafeJsonb.
  const doc = nulSafeJsonb("document_json");
  const row = await ctx.queryOne<{ found: number }>(
    `SELECT 1 AS found FROM guard_profile_versions
      WHERE CASE WHEN document_json IS JSON OBJECT THEN (
        (${doc} ->> 'labels') IS NOT DISTINCT FROM 'propagated'
        OR (jsonb_typeof(${doc} -> 'destinations' -> 'rules') = 'array'
            AND jsonb_array_length(${doc} -> 'destinations' -> 'rules') > 0)
        OR jsonb_typeof(${doc} -> 'channels' -> 'egress') = 'object'
      ) ELSE false END
      LIMIT 1`
  );
  const value = Boolean(row);
  if (revision !== undefined) labelsCache.set(ctx, { revision, value });
  return value;
}

export async function countObservedDestinationBlocks(ctx: PgContext, profileId: string, since: string): Promise<number> {
  const triggers = SUBJECT_EXECUTION_TRIGGERS.map((_, index) => `$${index + 3}`).join(", ");
  const row = await ctx.queryOne<{ total: unknown }>(
    `SELECT COUNT(DISTINCT verdict_id) AS total FROM guard_events
      WHERE profile_id = $1 AND detector_id = '<destinations>' AND shadow = 1
        AND effective_action IN ('block', 'review', 'require_approval') AND created_at >= $2
        AND execution_id NOT IN (SELECT id FROM execution_history WHERE trigger_type IN (${triggers}))`,
    [profileId, since, ...SUBJECT_EXECUTION_TRIGGERS]
  );
  return toNum(row?.total ?? 0);
}

async function readProfileVersion(
  run: (sql: string, params: unknown[]) => Promise<Row | null>,
  profileId: string,
  version?: number
): Promise<GuardProfileVersionRecord | null> {
  const row =
    version === undefined
      ? await run(
          `SELECT v.* FROM guard_profile_versions v JOIN guard_profiles p ON p.id = v.profile_id AND p.latest_version = v.version WHERE v.profile_id = $1`,
          [profileId]
        )
      : await run(`SELECT * FROM guard_profile_versions WHERE profile_id = $1 AND version = $2`, [profileId, version]);
  return row ? mapGuardProfileVersionRow(row) : null;
}

export async function getGuardProfileVersion(ctx: PgContext, profileId: string, version?: number): Promise<GuardProfileVersionRecord | null> {
  return readProfileVersion((sql, params) => ctx.queryOne<Row>(sql, params), profileId, version);
}

export async function listGuardProfileVersions(ctx: PgContext, profileId: string): Promise<GuardProfileVersionRecord[]> {
  const rows = await ctx.query<Row>(`SELECT * FROM guard_profile_versions WHERE profile_id = $1 ORDER BY version DESC`, [profileId]);
  return rows.map(mapGuardProfileVersionRow);
}

export async function insertGuardProfile(ctx: PgContext, input: Parameters<Store["insertGuardProfile"]>[0]): Promise<GuardProfileRecord> {
  const now = new Date().toISOString();
  return ctx.withTransaction(async (client) => {
    await client.query(
      `INSERT INTO guard_profiles (id, name, description, built_in, latest_version, created_at, created_by, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8)`,
      [input.id, input.name, input.description ?? null, input.builtIn ? 1 : 0, now, input.createdBy, now, input.createdBy]
    );
    await client.query(
      `INSERT INTO guard_profile_versions (profile_id, version, hash, document_json, note, created_at, created_by) VALUES ($1, 1, $2, $3, $4, $5, $6)`,
      [input.id, input.hash, JSON.stringify(input.document), input.note ?? null, now, input.createdBy]
    );
    const row = await oneRow(client, `${PROFILE_SELECT} WHERE p.id = $1`, [input.id]);
    return mapGuardProfileRow(row!);
  });
}

/**
 * Appends an immutable version and makes it the latest. The profile row is locked (`FOR UPDATE`) while the next
 * number is read and taken, so two concurrent saves get consecutive versions instead of colliding.
 */
export async function addGuardProfileVersion(ctx: PgContext, input: Parameters<Store["addGuardProfileVersion"]>[0]): Promise<GuardProfileVersionRecord> {
  return ctx.withTransaction(async (client) => {
    const current = await oneRow(client, `SELECT latest_version FROM guard_profiles WHERE id = $1 FOR UPDATE`, [input.profileId]);
    if (!current) throw new Error(`Guard profile '${input.profileId}' not found`);
    const version = Number(current.latest_version) + 1;
    const now = new Date().toISOString();
    await client.query(
      `INSERT INTO guard_profile_versions (profile_id, version, hash, document_json, note, created_at, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [input.profileId, version, input.hash, JSON.stringify(input.document), input.note ?? null, now, input.createdBy]
    );
    await client.query(`UPDATE guard_profiles SET name = $1, description = $2, latest_version = $3, updated_at = $4, updated_by = $5 WHERE id = $6`, [
      input.name,
      input.description ?? null,
      version,
      now,
      input.createdBy,
      input.profileId
    ]);
    const record = await readProfileVersion((sql, params) => oneRow(client, sql, params), input.profileId, version);
    return record!;
  });
}

export async function deleteGuardProfile(ctx: PgContext, id: string): Promise<boolean> {
  return ctx.withTransaction(async (client) => {
    const existing = await oneRow(client, `SELECT id FROM guard_profiles WHERE id = $1 FOR UPDATE`, [id]);
    if (!existing) return false;
    await client.query(`DELETE FROM guard_profile_versions WHERE profile_id = $1`, [id]);
    await client.query(`DELETE FROM guard_profiles WHERE id = $1`, [id]);
    return true;
  });
}

export async function getGuardBinding(ctx: PgContext, scope: GuardBindingScope, scopeId: string): Promise<GuardBindingRecord | null> {
  const row = await ctx.queryOne<Row>(`SELECT * FROM guard_bindings WHERE scope = $1 AND scope_id = $2`, [scope, scopeId]);
  return row ? mapGuardBindingRow(row) : null;
}

export async function listGuardBindingsForProfile(ctx: PgContext, profileId: string): Promise<GuardBindingRecord[]> {
  const rows = await ctx.query<Row>(`SELECT * FROM guard_bindings WHERE profile_id = $1 ORDER BY scope COLLATE "C", scope_id COLLATE "C"`, [profileId]);
  return rows.map(mapGuardBindingRow);
}

export async function setGuardBinding(ctx: PgContext, input: Parameters<Store["setGuardBinding"]>[0]): Promise<GuardBindingRecord> {
  const now = new Date().toISOString();
  const row = await ctx.queryOne<Row>(
    `INSERT INTO guard_bindings (scope, scope_id, mode, profile_id, updated_at, updated_by) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (scope, scope_id) DO UPDATE SET mode = EXCLUDED.mode, profile_id = EXCLUDED.profile_id, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by
     RETURNING *`,
    [input.scope, input.scopeId, input.mode, input.profileId, now, input.updatedBy]
  );
  return mapGuardBindingRow(row!);
}

const GUARD_EVENT_COLUMNS = [
  "id", "verdict_id", "execution_id", "workflow_id", "project_id", "node_id", "placement", "iteration", "tool_name", "channel",
  "detector_id", "category", "data_class", "score", "requested_action", "effective_action", "verdict_action", "shadow",
  "evidence_json", "profile_id", "profile_version", "profile_hash", "latency_ms", "budget_exceeded", "skipped_detectors_json", "created_at"
] as const;
/** Rows per INSERT statement (26 parameters each, well under Postgres' 65535). */
const GUARD_EVENT_CHUNK = 200;

function guardEventValues(row: GuardEventInsert): unknown[] {
  return [
    row.id,
    row.verdictId,
    row.executionId,
    row.workflowId,
    row.projectId,
    row.nodeId,
    row.placement,
    row.iteration,
    row.toolName,
    row.channel,
    row.detectorId,
    row.category,
    row.dataClass,
    row.score,
    row.requestedAction,
    row.effectiveAction,
    row.verdictAction,
    row.shadow ? 1 : 0,
    JSON.stringify(row.evidence),
    row.profileId,
    row.profileVersion,
    row.profileHash,
    row.latencyMs,
    row.budgetExceeded ? 1 : 0,
    JSON.stringify(row.skippedDetectors),
    row.createdAt
  ];
}

/** All rows or none (one transaction), in chunks of multi-row INSERTs. */
export async function insertGuardEvents(ctx: PgContext, rows: GuardEventInsert[]): Promise<void> {
  if (rows.length === 0) return;
  const width = GUARD_EVENT_COLUMNS.length;
  await ctx.withTransaction(async (client) => {
    for (let start = 0; start < rows.length; start += GUARD_EVENT_CHUNK) {
      const chunk = rows.slice(start, start + GUARD_EVENT_CHUNK);
      const params: unknown[] = [];
      const tuples = chunk.map((row, index) => {
        params.push(...guardEventValues(row));
        return `(${Array.from({ length: width }, (_, column) => `$${index * width + column + 1}`).join(", ")})`;
      });
      await client.query(`INSERT INTO guard_events (${GUARD_EVENT_COLUMNS.join(", ")}) VALUES ${tuples.join(", ")}`, params);
    }
  });
}

function guardEventWhere(filters: GuardEventFilters): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    clauses.push(sql.replace("?", `$${params.length}`));
  };
  if (filters.executionId) add("execution_id = ?", filters.executionId);
  if (filters.projectId) add("project_id = ?", filters.projectId);
  if (filters.workflowId) add("workflow_id = ?", filters.workflowId);
  if (filters.workflowIds) {
    if (filters.workflowIds.length === 0) clauses.push("1 = 0");
    else {
      const marks = filters.workflowIds.map((id) => {
        params.push(id);
        return `$${params.length}`;
      });
      clauses.push(`workflow_id IN (${marks.join(", ")})`);
    }
  }
  if (filters.profileId) add("profile_id = ?", filters.profileId);
  if (filters.channel) add("channel = ?", filters.channel);
  if (filters.action) add("effective_action = ?", filters.action);
  if (filters.since) add("created_at >= ?", filters.since);
  if (filters.onlyFindings) clauses.push("detector_id IS NOT NULL");
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

export async function listGuardEvents(
  ctx: PgContext,
  filters: GuardEventFilters & { limit?: number; offset?: number } = {}
): Promise<{ events: GuardEventRecord[]; total: number }> {
  const { where, params } = guardEventWhere(filters);
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 500);
  const offset = Math.max(filters.offset ?? 0, 0);
  const total = await ctx.queryOne<{ count: unknown }>(`SELECT COUNT(*) AS count FROM guard_events ${where}`, params);
  const rows = await ctx.query<Row>(
    `SELECT * FROM guard_events ${where} ORDER BY created_at DESC, id COLLATE "C" ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  return { events: rows.map(mapGuardEventRow), total: total ? toNum(total.count) : 0 };
}

export async function listGuardEventsForExecution(ctx: PgContext, executionId: string): Promise<GuardEventRecord[]> {
  const rows = await ctx.query<Row>(`SELECT * FROM guard_events WHERE execution_id = $1 ORDER BY created_at ASC, id COLLATE "C" ASC`, [executionId]);
  return rows.map(mapGuardEventRow);
}

export async function guardEventStats(ctx: PgContext, filters: GuardEventFilters = {}): Promise<GuardEventStats> {
  const { where, params } = guardEventWhere(filters);
  const and = (extra: string) => (where ? `${where} AND ${extra}` : `WHERE ${extra}`);
  const keyed = (rows: Array<{ key: unknown; count: unknown }>) =>
    rows.map((row) => ({ key: row.key === null || row.key === undefined ? "" : toStr(row.key), count: toNum(row.count) }));
  const group = async (column: string, extraWhere?: string) =>
    keyed(
      await ctx.query<{ key: unknown; count: unknown }>(
        `SELECT ${column} AS key, COUNT(*) AS count FROM guard_events ${extraWhere ? and(extraWhere) : where} GROUP BY ${column} ORDER BY count DESC`,
        params
      )
    );
  const distinctCount = async (sql: string) => toNum((await ctx.queryOne<{ count: unknown }>(sql, params))?.count ?? 0);
  const verdicts = keyed(
    await ctx.query<{ key: unknown; count: unknown }>(
      `SELECT verdict_action AS key, COUNT(DISTINCT verdict_id) AS count FROM guard_events ${where} GROUP BY verdict_action ORDER BY count DESC`,
      params
    )
  );
  const shadowWouldBlock = await distinctCount(`SELECT COUNT(DISTINCT verdict_id) AS count FROM guard_events ${and("shadow = 1 AND effective_action = 'block'")}`);
  const shadowFindings = await distinctCount(`SELECT COUNT(*) AS count FROM guard_events ${and("shadow = 1")}`);
  const budgetExceeded = await distinctCount(`SELECT COUNT(DISTINCT verdict_id) AS count FROM guard_events ${and("budget_exceeded = 1")}`);
  // SQLite takes the first 10 characters of the stored ISO string: the UTC day.
  const daily = (
    await ctx.query<{ day: unknown; action: unknown; count: unknown }>(
      `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, verdict_action AS action, COUNT(DISTINCT verdict_id) AS count
         FROM guard_events ${where}
        GROUP BY 1, verdict_action ORDER BY 1 ASC`,
      params
    )
  ).map((row) => ({ day: toStr(row.day), action: toStr(row.action), count: toNum(row.count) }));
  const channels = keyed(
    await ctx.query<{ key: unknown; count: unknown }>(
      `SELECT channel AS key, COUNT(DISTINCT verdict_id) AS count FROM guard_events ${where} GROUP BY channel ORDER BY count DESC`,
      params
    )
  );
  return {
    verdicts,
    actions: await group("effective_action", "detector_id IS NOT NULL"),
    categories: await group("category", "detector_id IS NOT NULL"),
    channels,
    detectors: (await group("detector_id", "detector_id IS NOT NULL")).slice(0, 10),
    shadowWouldBlock,
    shadowFindings,
    budgetExceeded,
    daily
  };
}

function mapVaultRow(row: Row | null): GuardVaultRow | null {
  if (!row) return null;
  return {
    token: toStr(row.token),
    data_class: toStr(row.data_class),
    value_hash: nullableText(row.value_hash),
    value_sealed: toStr(row.value_sealed),
    created_at: toStr(row.created_at)
  };
}

export async function getGuardVaultByToken(ctx: PgContext, token: string): Promise<GuardVaultRow | null> {
  return mapVaultRow(await ctx.queryOne<Row>(`SELECT * FROM guard_token_vault WHERE token = $1`, [token]));
}

export async function getGuardVaultByHash(ctx: PgContext, valueHash: string): Promise<GuardVaultRow | null> {
  return mapVaultRow(await ctx.queryOne<Row>(`SELECT * FROM guard_token_vault WHERE value_hash = $1`, [valueHash]));
}

/** Stores a token; a concurrent insert of the same token or value hash keeps the first one (like INSERT OR IGNORE). */
export async function putGuardVault(ctx: PgContext, input: Parameters<Store["putGuardVault"]>[0]): Promise<void> {
  await ctx.execute(
    `INSERT INTO guard_token_vault (token, data_class, value_hash, value_sealed, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
    [input.token, input.dataClass, input.valueHash, input.valueSealed, input.createdAt]
  );
}
