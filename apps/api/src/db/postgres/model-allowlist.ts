/**
 * 12.6 — PostgresStore: model allowlist entries. Each function matches the SqliteStore method of the same name; text
 * ordering uses the "C" collation, which compares like SQLite's BINARY.
 */
import type { ModelAllowlistEntry } from "@ai-orchestrator/shared";
import type { ModelAllowlistInsertResult } from "../database.js";
import { toStr } from "./helpers.js";
import type { PgContext } from "./context.js";

type Row = Record<string, unknown>;

function mapModelAllowlistRow(row: Row): ModelAllowlistEntry {
  const projectId = toStr(row.project_id);
  return {
    id: toStr(row.id),
    scope: toStr(row.scope) === "project" ? "project" : "deployment",
    projectId: projectId ? projectId : null,
    providerId: toStr(row.provider_id),
    modelGlob: toStr(row.model_glob),
    note: row.note === null || row.note === undefined ? null : toStr(row.note),
    createdAt: toStr(row.created_at),
    createdBy: row.created_by === null || row.created_by === undefined ? null : toStr(row.created_by)
  };
}

export async function listModelAllowlistEntries(ctx: PgContext): Promise<ModelAllowlistEntry[]> {
  const rows = await ctx.query<Row>(
    `SELECT * FROM model_allowlist_entries ORDER BY scope COLLATE "C", project_id COLLATE "C", created_at, id COLLATE "C"`
  );
  return rows.map(mapModelAllowlistRow);
}

/**
 * One statement: the insert happens only while the scope holds fewer than `maxPerScope` entries, and a duplicate is
 * left alone by the unique index. Two concurrent inserts into a full-but-one scope may both pass the count (the limit
 * is a size cap, not a security boundary).
 */
export async function insertModelAllowlistEntry(ctx: PgContext, entry: ModelAllowlistEntry, maxPerScope: number): Promise<ModelAllowlistInsertResult> {
  const projectKey = entry.projectId ?? "";
  const inserted = await ctx.queryOne<Row>(
    `INSERT INTO model_allowlist_entries (id, scope, project_id, provider_id, model_glob, note, created_at, created_by)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8
      WHERE (SELECT COUNT(*) FROM model_allowlist_entries WHERE scope = $2 AND project_id = $3) < $9
     ON CONFLICT (scope, project_id, provider_id, model_glob) DO NOTHING
     RETURNING id`,
    [entry.id, entry.scope, projectKey, entry.providerId, entry.modelGlob, entry.note, entry.createdAt, entry.createdBy, maxPerScope]
  );
  if (inserted) return { ok: true, entry };
  const duplicate = await ctx.queryOne<Row>(
    `SELECT id FROM model_allowlist_entries WHERE scope = $1 AND project_id = $2 AND provider_id = $3 AND model_glob = $4`,
    [entry.scope, projectKey, entry.providerId, entry.modelGlob]
  );
  return { ok: false, reason: duplicate ? "duplicate" : "limit" };
}

export async function deleteModelAllowlistEntry(ctx: PgContext, id: string): Promise<ModelAllowlistEntry | null> {
  const row = await ctx.queryOne<Row>(`DELETE FROM model_allowlist_entries WHERE id = $1 RETURNING *`, [id]);
  return row ? mapModelAllowlistRow(row) : null;
}
