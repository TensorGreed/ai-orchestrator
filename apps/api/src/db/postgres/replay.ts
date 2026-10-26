/**
 * Phase 13.1 — PostgresStore: Replay recordings, golden runs and sets, replay candidates and MCP cassettes (tapes).
 * Plain functions over a PgContext; PostgresStore delegates here. Methods that are not implemented yet throw
 * StoreNotImplementedError and are listed in UNIMPLEMENTED_METHODS (remove both together when implementing one).
 *
 * Ordering: SQLite breaks `created_at` ties by rowid (insertion order); here `seq`, the identity column v40 adds to
 * mcp_cassettes and replay_recordings as the stand-in for rowid, does.
 *
 * Golden-run limits (count per workflow, bytes per workflow, bytes in the deployment) are checked and the row written
 * while holding one transaction-scoped advisory lock (REPLAY_GOLDEN_LOCK). READ COMMITTED alone would let two
 * transactions both read the old totals and both insert; the lock makes every checked golden-run write (checked
 * save, capture promotion into a set, golden-set import) run one at a time, as SQLite's single writer does. The lock
 * is released at COMMIT/ROLLBACK, also when the connection is lost.
 */
import type {
  McpCassette,
  McpCassetteBadge,
  McpCassetteRecord,
  McpCassetteSource,
  McpCassetteSummary,
  ModelMemorySeed,
  ModelTape,
  ReplayCaptureInfo,
  ReplayGoldenBadge,
  ReplayRecordedNode,
  ReplayRecordingCapabilities,
  ReplayRecordingSummary,
  RunFacts
} from "@ai-orchestrator/shared";
import type { PoolClient } from "pg";
import type { ReplayRecordingInsert, ReplayRecordingRecord } from "../database.js";
import { type ReplayRecordingLimits, type ReplayRecordingRefusal, type Store } from "../store.js";
import type { PgContext } from "./context.js";
import { toNum, toStr } from "./helpers.js";

/**
 * Advisory-lock class ("L2R") for checked golden-run writes, alongside the classes listed in postgres-store.ts
 * (0x4c324d migrations, 0x4c324e leader). Key 0: one lock for the deployment, because the total-bytes limit spans
 * every workflow.
 */
export const ADVISORY_LOCK_CLASS_REPLAY_GOLDEN = 0x4c3252;
const REPLAY_GOLDEN_LOCK_KEY = 0;

export const UNIMPLEMENTED_METHODS: readonly (keyof Store)[] = [];

type Queryable = Pick<PoolClient, "query">;

async function one<T extends object>(db: Queryable, sql: string, params: unknown[] = []): Promise<T | null> {
  const result = await db.query(sql, params);
  return (result.rows[0] as T | undefined) ?? null;
}

async function all<T extends object>(db: Queryable, sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await db.query(sql, params);
  return result.rows as T[];
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Phase 10.8 — MCP cassettes
// ---------------------------------------------------------------------------

interface McpCassetteRow {
  id: string;
  execution_id: string | null;
  workflow_id: string | null;
  workflow_name: string | null;
  project_id: string | null;
  source: string;
  eval_run_id: string | null;
  fixture_id: string | null;
  call_count: number;
  server_count: number;
  bytes: number;
  truncated: number;
  cassette_json?: string;
  created_at: string;
  created_by: string | null;
}

const MCP_CASSETTE_SOURCES: readonly McpCassetteSource[] = ["manual", "eval", "replay", "import"];

const MCP_CASSETTE_SUMMARY_COLUMNS =
  "id, execution_id, workflow_id, workflow_name, project_id, source, eval_run_id, fixture_id, call_count, server_count, bytes, truncated, created_at, created_by";

function mapMcpCassetteSummary(row: McpCassetteRow): McpCassetteSummary {
  const source = MCP_CASSETTE_SOURCES.includes(row.source as McpCassetteSource) ? (row.source as McpCassetteSource) : "manual";
  return {
    id: toStr(row.id),
    executionId: row.execution_id ? toStr(row.execution_id) : null,
    workflowId: row.workflow_id ? toStr(row.workflow_id) : null,
    workflowName: row.workflow_name ? toStr(row.workflow_name) : null,
    projectId: row.project_id ? toStr(row.project_id) : null,
    source,
    evalRunId: row.eval_run_id ? toStr(row.eval_run_id) : null,
    fixtureId: row.fixture_id ? toStr(row.fixture_id) : null,
    callCount: toNum(row.call_count),
    serverCount: toNum(row.server_count),
    bytes: toNum(row.bytes),
    truncated: toNum(row.truncated) === 1,
    createdAt: toStr(row.created_at),
    createdBy: row.created_by ? toStr(row.created_by) : null
  };
}

async function cassetteSummary(db: Queryable, id: string): Promise<McpCassetteSummary | null> {
  const row = await one<McpCassetteRow>(db, `SELECT ${MCP_CASSETTE_SUMMARY_COLUMNS} FROM mcp_cassettes WHERE id = $1`, [id]);
  return row ? mapMcpCassetteSummary(row) : null;
}

async function cassetteRecord(db: Queryable, id: string): Promise<McpCassetteRecord | null> {
  const row = await one<McpCassetteRow>(db, `SELECT * FROM mcp_cassettes WHERE id = $1`, [id]);
  if (!row) return null;
  return { ...mapMcpCassetteSummary(row), cassette: safeJsonParse(toStr(row.cassette_json)) as McpCassette };
}

export async function saveMcpCassette(ctx: PgContext, ...[input]: Parameters<Store["saveMcpCassette"]>): ReturnType<Store["saveMcpCassette"]> {
  const createdAt = new Date().toISOString();
  await ctx.execute(
    `INSERT INTO mcp_cassettes (
       id, execution_id, workflow_id, workflow_name, project_id, source, eval_run_id, fixture_id,
       call_count, server_count, bytes, truncated, cassette_json, created_at, created_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      input.id,
      input.executionId,
      input.workflowId,
      input.workflowName,
      input.projectId,
      input.source,
      input.evalRunId ?? null,
      input.fixtureId ?? null,
      input.cassette.entries.length,
      input.cassette.servers.length,
      input.cassette.bytes,
      input.cassette.truncated ? 1 : 0,
      JSON.stringify(input.cassette),
      createdAt,
      input.createdBy
    ]
  );
  return (await cassetteSummary(ctx.pool, input.id))!;
}

export async function getMcpCassetteSummary(ctx: PgContext, ...[id]: Parameters<Store["getMcpCassetteSummary"]>): ReturnType<Store["getMcpCassetteSummary"]> {
  return cassetteSummary(ctx.pool, id);
}

export async function getMcpCassette(ctx: PgContext, ...[id]: Parameters<Store["getMcpCassette"]>): ReturnType<Store["getMcpCassette"]> {
  return cassetteRecord(ctx.pool, id);
}

export async function getMcpCassetteForExecution(ctx: PgContext, ...[executionId]: Parameters<Store["getMcpCassetteForExecution"]>): ReturnType<Store["getMcpCassetteForExecution"]> {
  const row = await ctx.queryOne<{ id: string }>(
    `SELECT id FROM mcp_cassettes WHERE execution_id = $1 ORDER BY created_at DESC, seq DESC LIMIT 1`,
    [executionId]
  );
  return row ? cassetteRecord(ctx.pool, toStr(row.id)) : null;
}

export async function listMcpCassettesForEvalRun(ctx: PgContext, ...[evalRunId]: Parameters<Store["listMcpCassettesForEvalRun"]>): ReturnType<Store["listMcpCassettesForEvalRun"]> {
  const rows = await ctx.query<McpCassetteRow>(
    `SELECT ${MCP_CASSETTE_SUMMARY_COLUMNS} FROM mcp_cassettes WHERE eval_run_id = $1 ORDER BY created_at ASC, seq ASC`,
    [evalRunId]
  );
  return rows.map(mapMcpCassetteSummary);
}

export async function listMcpCassettes(ctx: PgContext, ...[options = {}]: Parameters<Store["listMcpCassettes"]>): ReturnType<Store["listMcpCassettes"]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const next = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  // Project scope: only cassettes of these workflows (an empty list matches nothing).
  if (options.workflowIds) {
    where.push(options.workflowIds.length > 0 ? `workflow_id = ANY(${next(options.workflowIds)}::text[])` : "1 = 0");
  }
  if (options.workflowId) where.push(`workflow_id = ${next(options.workflowId)}`);
  if (options.projectId) where.push(`project_id = ${next(options.projectId)}`);
  if (options.evalRunId) where.push(`eval_run_id = ${next(options.evalRunId)}`);
  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const total = await ctx.queryOne<{ count: string }>(`SELECT COUNT(*) AS count FROM mcp_cassettes ${clause}`, params);
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 50)));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const items = (
    await ctx.query<McpCassetteRow>(
      `SELECT ${MCP_CASSETTE_SUMMARY_COLUMNS} FROM mcp_cassettes ${clause} ORDER BY created_at DESC, seq DESC LIMIT ${next(limit)} OFFSET ${next(offset)}`,
      params
    )
  ).map(mapMcpCassetteSummary);
  return { items, total: total ? toNum(total.count) : 0 };
}

export async function mcpCassetteBadgesForExecutions(ctx: PgContext, ...[executionIds]: Parameters<Store["mcpCassetteBadgesForExecutions"]>): ReturnType<Store["mcpCassetteBadgesForExecutions"]> {
  const out = new Map<string, McpCassetteBadge>();
  const ids = [...new Set(executionIds.filter(Boolean))].slice(0, 500);
  if (ids.length === 0) return out;
  const rows = await ctx.query<{ id: string; execution_id: string; call_count: number; truncated: number }>(
    `SELECT id, execution_id, call_count, truncated FROM mcp_cassettes
     WHERE execution_id = ANY($1::text[])
     ORDER BY created_at ASC, seq ASC`,
    [ids]
  );
  for (const row of rows) {
    out.set(toStr(row.execution_id), { id: toStr(row.id), callCount: toNum(row.call_count), truncated: toNum(row.truncated) === 1 });
  }
  return out;
}

export async function deleteMcpCassette(ctx: PgContext, ...[id]: Parameters<Store["deleteMcpCassette"]>): ReturnType<Store["deleteMcpCassette"]> {
  const result = await ctx.pool.query(`DELETE FROM mcp_cassettes WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Phase 15.1 — golden runs. Never pruned by retention; removed by a person or with their workflow.
// ---------------------------------------------------------------------------

const REPLAY_RECORDING_SUMMARY_COLUMNS =
  "id, workflow_id, project_id, name, notes, source_execution_id, source_trigger_type, source_status, workflow_hash, workflow_saved_version, capabilities_json, bytes, truncated, created_at, created_by, status, captured_at";

function mapReplayCaptureInfo(raw: Partial<ReplayCaptureInfo>): ReplayCaptureInfo {
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
  const counts: Record<string, number> = {};
  if (raw.values && typeof raw.values === "object") {
    for (const [name, count] of Object.entries(raw.values)) if (typeof count === "number") counts[name] = count;
  }
  return {
    rate: typeof raw.rate === "number" ? raw.rate : 0,
    masked: raw.masked === true,
    // An imported run keeps `maskingVerified: false`; a run captured here has no such field.
    ...(raw.maskingVerified === false ? { maskingVerified: false } : {}),
    dataClasses: strings(raw.dataClasses),
    values: counts,
    notDetectableAfterMasking: strings(raw.notDetectableAfterMasking),
    keptFromWorkflow: typeof raw.keptFromWorkflow === "number" ? raw.keptFromWorkflow : 0,
    publishedVersion: typeof raw.publishedVersion === "number" ? raw.publishedVersion : null,
    ...(raw.source === "api_key" ? { source: "api_key" as const } : {})
  };
}

function mapReplayRecordingSummary(row: Record<string, unknown>): ReplayRecordingSummary {
  const capabilities = safeJsonParse(toStr(row.capabilities_json)) as Partial<ReplayRecordingCapabilities> | null;
  return {
    id: toStr(row.id),
    workflowId: toStr(row.workflow_id),
    projectId: typeof row.project_id === "string" ? row.project_id : null,
    name: toStr(row.name),
    notes: typeof row.notes === "string" ? row.notes : null,
    sourceExecutionId: typeof row.source_execution_id === "string" ? row.source_execution_id : null,
    sourceTriggerType: typeof row.source_trigger_type === "string" ? row.source_trigger_type : null,
    sourceStatus: toStr(row.source_status),
    workflowHash: toStr(row.workflow_hash),
    workflowSavedVersion: row.workflow_saved_version === null || row.workflow_saved_version === undefined ? null : toNum(row.workflow_saved_version),
    capabilities: {
      mcp: capabilities?.mcp === "cassette" ? "cassette" : "none",
      models: capabilities?.models === "tape" ? "tape" : "live",
      memory: capabilities?.memory === "seeded" ? "seeded" : "empty",
      workflowSource: capabilities?.workflowSource === "captured" ? "captured" : "current",
      ...(capabilities?.scrubbed && typeof capabilities.scrubbed === "object"
        ? {
            scrubbed: {
              input: capabilities.scrubbed.input === true,
              output: capabilities.scrubbed.output === true,
              nodes: Array.isArray(capabilities.scrubbed.nodes) ? capabilities.scrubbed.nodes.filter((id): id is string => typeof id === "string") : []
            }
          }
        : {}),
      ...(capabilities?.origin === "imported"
        ? {
            origin: "imported" as const,
            ...(typeof capabilities.recordedAt === "string" ? { recordedAt: capabilities.recordedAt } : {}),
            ...(typeof capabilities.importedAt === "string" ? { importedAt: capabilities.importedAt } : {}),
            sourceWorkflowId: typeof capabilities.sourceWorkflowId === "string" ? capabilities.sourceWorkflowId : null
          }
        : {}),
      ...(capabilities?.capture && typeof capabilities.capture === "object" ? { capture: mapReplayCaptureInfo(capabilities.capture) } : {})
    },
    bytes: toNum(row.bytes),
    truncated: toNum(row.truncated) === 1,
    createdAt: toStr(row.created_at),
    createdBy: typeof row.created_by === "string" ? row.created_by : null,
    status: row.status === "candidate" ? "candidate" : "golden",
    capturedAt: typeof row.captured_at === "string" && row.captured_at ? row.captured_at : null
  };
}

async function recordingSummary(db: Queryable, id: string): Promise<ReplayRecordingSummary | null> {
  const row = await one<Record<string, unknown>>(db, `SELECT ${REPLAY_RECORDING_SUMMARY_COLUMNS} FROM replay_recordings WHERE id = $1`, [id]);
  return row ? mapReplayRecordingSummary(row) : null;
}

async function recordingRecord(db: Queryable, id: string): Promise<ReplayRecordingRecord | null> {
  const row = await one<Record<string, unknown>>(db, `SELECT * FROM replay_recordings WHERE id = $1`, [id]);
  if (!row) return null;
  const parse = (value: unknown) => (typeof value === "string" && value ? safeJsonParse(value) : null);
  return {
    ...mapReplayRecordingSummary(row),
    capturedWorkflow: (parse(row.captured_workflow_json) ?? {}) as Record<string, unknown>,
    input: parse(row.input_json),
    nodes: (parse(row.node_outputs_json) ?? {}) as Record<string, ReplayRecordedNode>,
    facts: parse(row.facts_json) as RunFacts,
    mcpCassette: parse(row.mcp_cassette_json) as McpCassette | null,
    modelTape: parse(row.model_tape_json) as ModelTape | null,
    memorySeed: parse(row.memory_seed_json) as ModelMemorySeed | null
  };
}

async function insertRecording(db: Queryable, input: ReplayRecordingInsert): Promise<ReplayRecordingSummary> {
  await db.query(
    `INSERT INTO replay_recordings (
       id, workflow_id, project_id, name, notes, source_execution_id, source_trigger_type, source_status,
       workflow_hash, workflow_saved_version, captured_workflow_json, input_json, node_outputs_json, facts_json,
       mcp_cassette_json, model_tape_json, memory_seed_json, capabilities_json, bytes, truncated, created_at, created_by,
       status, captured_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)`,
    [
      input.id,
      input.workflowId,
      input.projectId,
      input.name,
      input.notes,
      input.sourceExecutionId,
      input.sourceTriggerType,
      input.sourceStatus,
      input.workflowHash,
      input.workflowSavedVersion,
      input.capturedWorkflowJson,
      input.inputJson,
      input.nodeOutputsJson,
      input.factsJson,
      input.mcpCassetteJson,
      input.modelTapeJson ?? null,
      input.memorySeedJson ?? null,
      JSON.stringify(input.capabilities),
      input.bytes,
      input.truncated ? 1 : 0,
      input.createdAt,
      input.createdBy,
      input.status ?? "golden",
      input.capturedAt ?? null
    ]
  );
  return (await recordingSummary(db, input.id))!;
}

async function goldenBytesForWorkflow(db: Queryable, workflowId: string): Promise<number> {
  const row = await one<{ total: string | null }>(db, `SELECT COALESCE(SUM(bytes), 0) AS total FROM replay_recordings WHERE workflow_id = $1 AND status = 'golden'`, [workflowId]);
  return row ? toNum(row.total ?? 0) : 0;
}

async function goldenBytes(db: Queryable): Promise<number> {
  const row = await one<{ total: string | null }>(db, `SELECT COALESCE(SUM(bytes), 0) AS total FROM replay_recordings WHERE status = 'golden'`);
  return row ? toNum(row.total ?? 0) : 0;
}

async function recordingIdForExecution(db: Queryable, executionId: string, status: "candidate" | "golden"): Promise<string | null> {
  const row = await one<{ id: string }>(
    db,
    `SELECT id FROM replay_recordings WHERE source_execution_id = $1 AND status = $2 ORDER BY created_at ASC, seq ASC LIMIT 1`,
    [executionId, status]
  );
  return row ? toStr(row.id) : null;
}

async function recordingCountForWorkflow(db: Queryable, workflowId: string, status: "candidate" | "golden"): Promise<number> {
  const row = await one<{ count: string }>(db, `SELECT COUNT(*) AS count FROM replay_recordings WHERE workflow_id = $1 AND status = $2`, [workflowId, status]);
  return row ? toNum(row.count) : 0;
}

export async function saveReplayRecording(ctx: PgContext, ...[input]: Parameters<Store["saveReplayRecording"]>): ReturnType<Store["saveReplayRecording"]> {
  return insertRecording(ctx.pool, input);
}

export async function getReplayRecordingSummary(ctx: PgContext, ...[id]: Parameters<Store["getReplayRecordingSummary"]>): ReturnType<Store["getReplayRecordingSummary"]> {
  return recordingSummary(ctx.pool, id);
}

export async function getReplayRecording(ctx: PgContext, ...[id]: Parameters<Store["getReplayRecording"]>): ReturnType<Store["getReplayRecording"]> {
  return recordingRecord(ctx.pool, id);
}

export async function listReplayRecordings(ctx: PgContext, ...[options = {}]: Parameters<Store["listReplayRecordings"]>): ReturnType<Store["listReplayRecordings"]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const next = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (options.status) where.push(`status = ${next(options.status)}`);
  if (options.workflowId) where.push(`workflow_id = ${next(options.workflowId)}`);
  if (options.workflowIds) {
    if (options.workflowIds.length === 0) return { items: [], total: 0 };
    where.push(`workflow_id = ANY(${next(options.workflowIds)}::text[])`);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const total = await ctx.queryOne<{ count: string }>(`SELECT COUNT(*) AS count FROM replay_recordings ${clause}`, params);
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 50)));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const items = (
    await ctx.query<Record<string, unknown>>(
      `SELECT ${REPLAY_RECORDING_SUMMARY_COLUMNS} FROM replay_recordings ${clause} ORDER BY created_at DESC, seq DESC LIMIT ${next(limit)} OFFSET ${next(offset)}`,
      params
    )
  ).map(mapReplayRecordingSummary);
  return { items, total: total ? toNum(total.count) : 0 };
}

export async function sumReplayRecordingBytesForWorkflow(ctx: PgContext, ...[workflowId]: Parameters<Store["sumReplayRecordingBytesForWorkflow"]>): ReturnType<Store["sumReplayRecordingBytesForWorkflow"]> {
  return goldenBytesForWorkflow(ctx.pool, workflowId);
}

export async function sumReplayRecordingBytes(ctx: PgContext): ReturnType<Store["sumReplayRecordingBytes"]> {
  return goldenBytes(ctx.pool);
}

export async function findReplayRecordingIdForExecution(ctx: PgContext, ...[executionId, status = "golden"]: Parameters<Store["findReplayRecordingIdForExecution"]>): ReturnType<Store["findReplayRecordingIdForExecution"]> {
  return recordingIdForExecution(ctx.pool, executionId, status);
}

export async function countReplayRecordingsForWorkflow(ctx: PgContext, ...[workflowId, status = "golden"]: Parameters<Store["countReplayRecordingsForWorkflow"]>): ReturnType<Store["countReplayRecordingsForWorkflow"]> {
  return recordingCountForWorkflow(ctx.pool, workflowId, status);
}

export async function replayGoldenBadgesForExecutions(ctx: PgContext, ...[executionIds]: Parameters<Store["replayGoldenBadgesForExecutions"]>): ReturnType<Store["replayGoldenBadgesForExecutions"]> {
  const out = new Map<string, ReplayGoldenBadge>();
  const ids = [...new Set(executionIds.filter(Boolean))].slice(0, 500);
  if (ids.length === 0) return out;
  const rows = await ctx.query<{ id: string; source_execution_id: string }>(
    `SELECT id, source_execution_id FROM replay_recordings
     WHERE status = 'golden' AND source_execution_id = ANY($1::text[])
     ORDER BY created_at ASC, seq ASC`,
    [ids]
  );
  for (const row of rows) {
    const executionId = toStr(row.source_execution_id);
    out.set(executionId, { count: (out.get(executionId)?.count ?? 0) + 1, latestId: toStr(row.id) });
  }
  return out;
}

export async function deleteReplayRecording(ctx: PgContext, ...[id]: Parameters<Store["deleteReplayRecording"]>): ReturnType<Store["deleteReplayRecording"]> {
  const result = await ctx.pool.query(`DELETE FROM replay_recordings WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Checked golden-run writes (one transaction each, serialised by REPLAY_GOLDEN_LOCK).
// ---------------------------------------------------------------------------

async function lockGoldenWrites(client: PoolClient): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock($1, $2)`, [ADVISORY_LOCK_CLASS_REPLAY_GOLDEN, REPLAY_GOLDEN_LOCK_KEY]);
}

/** The first golden-run limit a save of `bytes` for `workflowId` would break, as the store is now (lock held). */
async function recordingRefusal(db: Queryable, workflowId: string, bytes: number, limits: ReplayRecordingLimits): Promise<ReplayRecordingRefusal | null> {
  const count = await recordingCountForWorkflow(db, workflowId, "golden");
  if (count >= limits.maxPerWorkflow) return { refused: "count", used: count, bytes };
  const workflowBytes = await goldenBytesForWorkflow(db, workflowId);
  if (workflowBytes + bytes > limits.maxBytesPerWorkflow) return { refused: "workflow_bytes", used: workflowBytes, bytes };
  const totalBytes = await goldenBytes(db);
  if (totalBytes + bytes > limits.maxTotalBytes) return { refused: "total_bytes", used: totalBytes, bytes };
  return null;
}

type EvalDatasetInput = Parameters<Store["createEvalDataset"]>[0];
type EvalFixtureInput = Parameters<Store["createEvalFixture"]>[0];

/** Same row as the eval module's createEvalDataset, written on the transaction's client. */
async function insertEvalDataset(db: Queryable, input: EvalDatasetInput): Promise<void> {
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO eval_datasets (id, name, description, project_id, workflow_id, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [input.id, input.name, input.description ?? null, input.projectId ?? null, input.workflowId ?? null, input.createdBy ?? null, now, now]
  );
}

/** Same row as the eval module's createEvalFixture, written on the transaction's client. */
async function insertEvalFixture(db: Queryable, input: EvalFixtureInput): Promise<void> {
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO eval_fixtures (id, dataset_id, name, input_json, expected_json, scorers_json, recording_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.id,
      input.datasetId,
      input.name,
      JSON.stringify(input.input ?? null),
      input.expected !== undefined ? JSON.stringify(input.expected) : null,
      input.scorers && input.scorers.length > 0 ? JSON.stringify(input.scorers) : null,
      input.recordingId ?? null,
      now,
      now
    ]
  );
}

/** Thrown inside a transaction to roll it back and answer `outcome`. */
class Refused<T> {
  constructor(readonly outcome: T) {}
}

export async function saveReplayRecordingChecked(ctx: PgContext, ...[input, checks]: Parameters<Store["saveReplayRecordingChecked"]>): ReturnType<Store["saveReplayRecordingChecked"]> {
  return ctx.withTransaction(async (client): Promise<{ saved: ReplayRecordingSummary } | ReplayRecordingRefusal> => {
    await lockGoldenWrites(client);
    if (checks.uniqueExecution && input.sourceExecutionId) {
      const existingId = await recordingIdForExecution(client, input.sourceExecutionId, input.status ?? "golden");
      if (existingId) return { refused: "duplicate", existingId };
    }
    if (checks.limits) {
      const refusal = await recordingRefusal(client, input.workflowId, input.bytes, checks.limits);
      if (refusal) return refusal;
    }
    return { saved: await insertRecording(client, input) };
  });
}

export async function promoteReplayCaptureToGoldenSet(ctx: PgContext, ...[input]: Parameters<Store["promoteReplayCaptureToGoldenSet"]>): ReturnType<Store["promoteReplayCaptureToGoldenSet"]> {
  type Outcome = Awaited<ReturnType<Store["promoteReplayCaptureToGoldenSet"]>>;
  try {
    return await ctx.withTransaction(async (client): Promise<Outcome> => {
      await lockGoldenWrites(client);
      const candidate = await recordingSummary(client, input.recordingId);
      if (!candidate || candidate.status !== "candidate") return { refused: "not_candidate" };
      const refusal = await recordingRefusal(client, candidate.workflowId, input.promotion.bytes, input.limits);
      if (refusal) return refusal;
      let datasetId: string;
      if ("datasetId" in input.target) {
        // FOR SHARE: a delete of the set waits for this transaction instead of removing it under the new case.
        const dataset = await one<{ id: string }>(client, `SELECT id FROM eval_datasets WHERE id = $1 FOR SHARE`, [input.target.datasetId]);
        if (!dataset) return { refused: "set_gone" };
        datasetId = input.target.datasetId;
      } else {
        const wanted = input.target.findOrCreate;
        // The newest of the workflow's sets with this name, as the SQLite store's list (created_at DESC) finds it.
        const existing = await one<{ id: string }>(
          client,
          `SELECT id FROM eval_datasets WHERE workflow_id = $1 AND name = $2 ORDER BY created_at DESC, id DESC LIMIT 1 FOR SHARE`,
          [wanted.workflowId, wanted.name]
        );
        if (existing) {
          datasetId = toStr(existing.id);
        } else {
          await insertEvalDataset(client, wanted);
          datasetId = wanted.id;
        }
      }
      const promotion = input.promotion;
      const updated = await client.query(
        `UPDATE replay_recordings SET status = 'golden', name = $1, captured_workflow_json = $2, input_json = $3, node_outputs_json = $4, facts_json = $5,
           mcp_cassette_json = $6, model_tape_json = $7, memory_seed_json = $8, bytes = $9, workflow_hash = $10, created_by = $11
         WHERE id = $12 AND status = 'candidate'`,
        [
          promotion.name,
          promotion.capturedWorkflowJson,
          promotion.inputJson,
          promotion.nodeOutputsJson,
          promotion.factsJson,
          promotion.mcpCassetteJson,
          promotion.modelTapeJson ?? null,
          promotion.memorySeedJson ?? null,
          promotion.bytes,
          promotion.workflowHash,
          promotion.createdBy,
          input.recordingId
        ]
      );
      // Rolls back a set made above.
      if ((updated.rowCount ?? 0) === 0) throw new Refused<Outcome>({ refused: "not_candidate" });
      const promoted = (await recordingRecord(client, input.recordingId))!;
      await insertEvalFixture(client, {
        id: input.fixture.id,
        datasetId,
        name: input.fixture.name ?? promoted.name,
        input: promoted.input ?? null,
        recordingId: promoted.id
      });
      return { datasetId, fixtureId: input.fixture.id };
    });
  } catch (error) {
    if (error instanceof Refused) return error.outcome as Outcome;
    throw error;
  }
}

export async function importGoldenSet(ctx: PgContext, ...[input]: Parameters<Store["importGoldenSet"]>): ReturnType<Store["importGoldenSet"]> {
  try {
    return await ctx.withTransaction(async (client) => {
      await lockGoldenWrites(client);
      await insertEvalDataset(client, input.dataset);
      const recordingIds: string[] = [];
      for (const entry of input.cases) {
        const refusal = await recordingRefusal(client, entry.recording.workflowId, entry.recording.bytes, input.limits);
        // Throwing rolls back the set and the cases saved before this one.
        if (refusal) throw new Refused<ReplayRecordingRefusal>(refusal);
        const summary = await insertRecording(client, entry.recording);
        await insertEvalFixture(client, { ...entry.fixture, datasetId: input.dataset.id, recordingId: summary.id });
        recordingIds.push(summary.id);
      }
      return { recordingIds };
    });
  } catch (error) {
    if (error instanceof Refused) return error.outcome as ReplayRecordingRefusal;
    throw error;
  }
}
