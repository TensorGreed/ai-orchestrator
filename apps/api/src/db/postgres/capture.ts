/**
 * Phase 13.1 — PostgresStore: Replay capture settings, captured runs and retention.
 * Plain functions over a PgContext; PostgresStore delegates here. Methods that are not implemented yet throw
 * StoreNotImplementedError and are listed in UNIMPLEMENTED_METHODS (remove both together when implementing one).
 *
 * Each write is one statement (a conditional UPDATE / DELETE whose row count is the answer), so two API processes on
 * one database never promote the same candidate twice or double-count a prune. SQLite orders candidates captured in
 * the same instant by rowid; here `seq` (v40's identity column on replay_recordings, the stand-in for rowid) does.
 */
import {
  REPLAY_CAPTURE_API_KEY_FILTER,
  REPLAY_CAPTURE_STATUSES,
  type ReplayCaptureInfo,
  type ReplayCaptureStatus,
  type ReplayRecordingCapabilities,
  type ReplayRecordingSummary
} from "@ai-orchestrator/shared";
import type { ReplayCaptureSettingsRecord } from "../database.js";
import { type Store } from "../store.js";
import type { PgContext } from "./context.js";
import { toNum, toStr } from "./helpers.js";

export const UNIMPLEMENTED_METHODS: readonly (keyof Store)[] = [];

const REPLAY_RECORDING_SUMMARY_COLUMNS =
  "id, workflow_id, project_id, name, notes, source_execution_id, source_trigger_type, source_status, workflow_hash, workflow_saved_version, capabilities_json, bytes, truncated, created_at, created_by, status, captured_at";

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function mapReplayCaptureInfo(raw: Partial<ReplayCaptureInfo>): ReplayCaptureInfo {
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
  const counts: Record<string, number> = {};
  if (raw.values && typeof raw.values === "object") {
    for (const [name, count] of Object.entries(raw.values)) if (typeof count === "number") counts[name] = count;
  }
  return {
    rate: typeof raw.rate === "number" ? raw.rate : 0,
    masked: raw.masked === true,
    ...(raw.maskingVerified === false ? { maskingVerified: false } : {}),
    dataClasses: strings(raw.dataClasses),
    values: counts,
    notDetectableAfterMasking: strings(raw.notDetectableAfterMasking),
    keptFromWorkflow: typeof raw.keptFromWorkflow === "number" ? raw.keptFromWorkflow : 0,
    publishedVersion: typeof raw.publishedVersion === "number" ? raw.publishedVersion : null,
    ...(raw.source === "api_key" ? { source: "api_key" as const } : {})
  };
}

/** The same summary SQLite's mapReplayRecordingSummary builds. */
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

function mapReplayCaptureSettings(row: Record<string, unknown>): ReplayCaptureSettingsRecord {
  const statuses = safeJsonParse(toStr(row.only_statuses_json));
  return {
    workflowId: toStr(row.workflow_id),
    enabled: toNum(row.enabled) === 1,
    rate: toNum(row.rate),
    maxPerDay: toNum(row.max_per_day),
    onlyStatuses: Array.isArray(statuses)
      ? statuses.filter((entry): entry is ReplayCaptureStatus => (REPLAY_CAPTURE_STATUSES as readonly string[]).includes(String(entry)))
      : [...REPLAY_CAPTURE_STATUSES],
    dlp: toNum(row.dlp) !== 0,
    dlpOffReason: typeof row.dlp_off_reason === "string" ? row.dlp_off_reason : null,
    targetDatasetId: typeof row.target_dataset_id === "string" && row.target_dataset_id ? row.target_dataset_id : null,
    updatedAt: toStr(row.updated_at),
    updatedBy: typeof row.updated_by === "string" ? row.updated_by : null,
    lastDropOutcome: typeof row.last_drop_outcome === "string" && row.last_drop_outcome ? row.last_drop_outcome : null,
    lastDropAt: typeof row.last_drop_at === "string" && row.last_drop_at ? row.last_drop_at : null
  };
}

export async function listReplayCaptures(ctx: PgContext, ...[options]: Parameters<Store["listReplayCaptures"]>): ReturnType<Store["listReplayCaptures"]> {
  const params: unknown[] = [options.workflowId];
  const bind = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const where = ["workflow_id = $1", "status = 'candidate'"];
  if (options.runStatus) where.push(`source_status = ${bind(options.runStatus)}`);
  if (options.trigger === REPLAY_CAPTURE_API_KEY_FILTER) {
    // Runs an API key started keep the trigger `manual`; the capture info records the source.
    where.push(`(capabilities_json::jsonb #>> '{capture,source}') = 'api_key'`);
  } else if (options.trigger) {
    where.push(`source_trigger_type = ${bind(options.trigger)}`);
  }
  if (options.from) where.push(`captured_at >= ${bind(options.from)}`);
  if (options.to) where.push(`captured_at <= ${bind(options.to)}`);
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = await ctx.queryOne<{ count: string }>(`SELECT COUNT(*) AS count FROM replay_recordings ${clause}`, params);
  const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 50)));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const pageParams = [...params, limit, offset];
  const rows = await ctx.query<Record<string, unknown>>(
    `SELECT ${REPLAY_RECORDING_SUMMARY_COLUMNS} FROM replay_recordings ${clause}
     ORDER BY captured_at DESC, seq DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    pageParams
  );
  return { items: rows.map(mapReplayRecordingSummary), total: total ? toNum(total.count) : 0 };
}

export async function countReplayCapturesSince(ctx: PgContext, ...[workflowId, since]: Parameters<Store["countReplayCapturesSince"]>): ReturnType<Store["countReplayCapturesSince"]> {
  const row = await ctx.queryOne<{ count: string }>(`SELECT COUNT(*) AS count FROM replay_recordings WHERE workflow_id = $1 AND captured_at >= $2`, [workflowId, since]);
  return row ? toNum(row.count) : 0;
}

export async function oldestReplayCaptureIds(ctx: PgContext, ...[workflowId, count]: Parameters<Store["oldestReplayCaptureIds"]>): ReturnType<Store["oldestReplayCaptureIds"]> {
  if (count <= 0) return [];
  const rows = await ctx.query<{ id: string }>(
    `SELECT id FROM replay_recordings WHERE workflow_id = $1 AND status = 'candidate' ORDER BY captured_at ASC, seq ASC LIMIT $2`,
    [workflowId, count]
  );
  return rows.map((row) => toStr(row.id));
}

export async function pruneReplayCaptures(ctx: PgContext, ...[before]: Parameters<Store["pruneReplayCaptures"]>): ReturnType<Store["pruneReplayCaptures"]> {
  const result = await ctx.pool.query(`DELETE FROM replay_recordings WHERE status = 'candidate' AND captured_at < $1`, [before]);
  return result.rowCount ?? 0;
}

export async function promoteReplayCapture(ctx: PgContext, ...[id, input]: Parameters<Store["promoteReplayCapture"]>): ReturnType<Store["promoteReplayCapture"]> {
  // One conditional UPDATE: of two promotions at once, only the one that still finds a candidate changes the row.
  const result = await ctx.pool.query(
    `UPDATE replay_recordings SET status = 'golden', name = $1, captured_workflow_json = $2, input_json = $3, node_outputs_json = $4, facts_json = $5,
       mcp_cassette_json = $6, model_tape_json = $7, memory_seed_json = $8, bytes = $9, workflow_hash = $10, created_by = $11
     WHERE id = $12 AND status = 'candidate'`,
    [
      input.name,
      input.capturedWorkflowJson,
      input.inputJson,
      input.nodeOutputsJson,
      input.factsJson,
      input.mcpCassetteJson,
      input.modelTapeJson ?? null,
      input.memorySeedJson ?? null,
      input.bytes,
      input.workflowHash,
      input.createdBy,
      id
    ]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getReplayCaptureSettings(ctx: PgContext, ...[workflowId]: Parameters<Store["getReplayCaptureSettings"]>): ReturnType<Store["getReplayCaptureSettings"]> {
  const row = await ctx.queryOne<Record<string, unknown>>(`SELECT * FROM replay_capture_settings WHERE workflow_id = $1`, [workflowId]);
  return row ? mapReplayCaptureSettings(row) : null;
}

export async function saveReplayCaptureSettings(ctx: PgContext, ...[input]: Parameters<Store["saveReplayCaptureSettings"]>): ReturnType<Store["saveReplayCaptureSettings"]> {
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  const row = await ctx.queryOne<Record<string, unknown>>(
    `INSERT INTO replay_capture_settings (workflow_id, enabled, rate, max_per_day, only_statuses_json, dlp, dlp_off_reason, target_dataset_id, updated_at, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (workflow_id) DO UPDATE SET
       enabled = EXCLUDED.enabled, rate = EXCLUDED.rate, max_per_day = EXCLUDED.max_per_day,
       only_statuses_json = EXCLUDED.only_statuses_json, dlp = EXCLUDED.dlp, dlp_off_reason = EXCLUDED.dlp_off_reason,
       target_dataset_id = EXCLUDED.target_dataset_id, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by
     RETURNING *`,
    [
      input.workflowId,
      input.enabled ? 1 : 0,
      input.rate,
      input.maxPerDay,
      JSON.stringify(input.onlyStatuses),
      input.dlp ? 1 : 0,
      input.dlpOffReason,
      input.targetDatasetId,
      updatedAt,
      input.updatedBy
    ]
  );
  return mapReplayCaptureSettings(row!);
}

export async function recordReplayCaptureDrop(ctx: PgContext, ...[workflowId, outcome, at]: Parameters<Store["recordReplayCaptureDrop"]>): ReturnType<Store["recordReplayCaptureDrop"]> {
  await ctx.execute(`UPDATE replay_capture_settings SET last_drop_outcome = $1, last_drop_at = $2 WHERE workflow_id = $3`, [outcome, at, workflowId]);
}

export async function sumReplayCaptureBytesForWorkflow(ctx: PgContext, ...[workflowId]: Parameters<Store["sumReplayCaptureBytesForWorkflow"]>): ReturnType<Store["sumReplayCaptureBytesForWorkflow"]> {
  const row = await ctx.queryOne<{ total: string | null }>(
    `SELECT COALESCE(SUM(bytes), 0) AS total FROM replay_recordings WHERE workflow_id = $1 AND status = 'candidate'`,
    [workflowId]
  );
  return row ? toNum(row.total ?? 0) : 0;
}

export async function oldestReplayCaptures(ctx: PgContext, ...[workflowId, limit]: Parameters<Store["oldestReplayCaptures"]>): ReturnType<Store["oldestReplayCaptures"]> {
  const rows = await ctx.query<{ id: string; bytes: number }>(
    `SELECT id, bytes FROM replay_recordings WHERE workflow_id = $1 AND status = 'candidate' ORDER BY captured_at ASC, seq ASC LIMIT $2`,
    [workflowId, Math.max(1, limit)]
  );
  return rows.map((row) => ({ id: toStr(row.id), bytes: toNum(row.bytes) }));
}
