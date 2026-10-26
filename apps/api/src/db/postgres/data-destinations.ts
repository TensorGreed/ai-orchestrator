/**
 * Phase 13.1 — PostgresStore: Data destinations and destination rules. Each function matches the SqliteStore method
 * of the same name; text ordering uses the "C" collation, which compares like SQLite's BINARY.
 */
import { DESTINATION_KINDS, DESTINATION_TIERS, type DataDestinationRow } from "@ai-orchestrator/shared";
import type { DataDestinationWrite } from "../database.js";
import { type Store } from "../store.js";
import { toStr } from "./helpers.js";
import type { PgContext } from "./context.js";

export const UNIMPLEMENTED_METHODS: readonly (keyof Store)[] = [];

type Row = Record<string, unknown>;

function parseJsonArray(raw: unknown): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(typeof raw === "string" ? raw : String(raw));
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
  return [];
}

function mapDataDestinationRow(row: Row): DataDestinationRow {
  const optionalString = (value: unknown) => (value === null || value === undefined ? null : toStr(value));
  const kind = toStr(row.kind);
  const tier = toStr(row.tier);
  return {
    id: toStr(row.id),
    name: toStr(row.name),
    kind: (DESTINATION_KINDS as readonly string[]).includes(kind) ? (kind as DataDestinationRow["kind"]) : "http",
    targetId: optionalString(row.target_id),
    host: optionalString(row.host),
    // An unreadable tier is treated as public, the strictest.
    tier: (DESTINATION_TIERS as readonly string[]).includes(tier) ? (tier as DataDestinationRow["tier"]) : "public",
    region: toStr(row.region) || "unknown",
    holdsDataClasses: parseJsonArray(row.holds_data_classes_json),
    note: optionalString(row.note),
    builtIn: false,
    createdAt: optionalString(row.created_at),
    updatedAt: optionalString(row.updated_at),
    createdBy: optionalString(row.created_by),
    updatedBy: optionalString(row.updated_by)
  };
}

/** Every workflow's draft JSON and, when one is published, the published version's JSON, in one query. */
export async function listWorkflowConfigsForDestinations(ctx: PgContext): Promise<Array<{ id: string; name: string; draftJson: string; publishedJson: string | null }>> {
  const rows = await ctx.query<{ id: string; name: string; workflow_json: string; published_json: string | null }>(
    `SELECT w.id, w.name, w.workflow_json, v.workflow_json AS published_json
       FROM workflows w
       LEFT JOIN workflow_versions v ON v.workflow_id = w.id AND v.version = w.published_version
      ORDER BY w.updated_at DESC`
  );
  return rows.map((row) => ({
    id: toStr(row.id),
    name: toStr(row.name),
    draftJson: toStr(row.workflow_json),
    publishedJson: row.published_json ? toStr(row.published_json) : null
  }));
}

export async function listDataDestinations(ctx: PgContext): Promise<DataDestinationRow[]> {
  const rows = await ctx.query<Row>(`SELECT * FROM data_destinations ORDER BY tier COLLATE "C", name COLLATE "C", id COLLATE "C"`);
  return rows.map(mapDataDestinationRow);
}

export async function getDataDestination(ctx: PgContext, id: string): Promise<DataDestinationRow | null> {
  const row = await ctx.queryOne<Row>(`SELECT * FROM data_destinations WHERE id = $1`, [id]);
  return row ? mapDataDestinationRow(row) : null;
}

/** The row with exactly this match (kind, target id, host), if any. */
export async function findDataDestinationByMatch(ctx: PgContext, kind: string, targetId: string | null, host: string | null): Promise<DataDestinationRow | null> {
  const row = await ctx.queryOne<Row>(
    `SELECT * FROM data_destinations WHERE kind = $1 AND COALESCE(target_id, '') = $2 AND COALESCE(host, '') = $3`,
    [kind, targetId ?? "", host ?? ""]
  );
  return row ? mapDataDestinationRow(row) : null;
}

export async function insertDataDestination(ctx: PgContext, input: DataDestinationWrite & { id: string; actor: string | null; at?: string }): Promise<DataDestinationRow> {
  const at = input.at ?? new Date().toISOString();
  const row = await ctx.queryOne<Row>(
    `INSERT INTO data_destinations (id, name, kind, target_id, host, tier, region, holds_data_classes_json, note, created_at, created_by, updated_at, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [input.id, input.name, input.kind, input.targetId, input.host, input.tier, input.region, JSON.stringify(input.holdsDataClasses), input.note, at, input.actor, at, input.actor]
  );
  return mapDataDestinationRow(row!);
}

/** Replaces a row's fields; null when it does not exist. */
export async function updateDataDestination(ctx: PgContext, id: string, input: DataDestinationWrite & { actor: string | null; at?: string }): Promise<DataDestinationRow | null> {
  const at = input.at ?? new Date().toISOString();
  const row = await ctx.queryOne<Row>(
    `UPDATE data_destinations SET name = $1, kind = $2, target_id = $3, host = $4, tier = $5, region = $6, holds_data_classes_json = $7, note = $8, updated_at = $9, updated_by = $10
      WHERE id = $11
      RETURNING *`,
    [input.name, input.kind, input.targetId, input.host, input.tier, input.region, JSON.stringify(input.holdsDataClasses), input.note, at, input.actor, id]
  );
  return row ? mapDataDestinationRow(row) : null;
}

export async function deleteDataDestination(ctx: PgContext, id: string): Promise<boolean> {
  const result = await ctx.pool.query(`DELETE FROM data_destinations WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}
