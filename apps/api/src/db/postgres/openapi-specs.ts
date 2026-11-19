/**
 * v81 — PostgresStore: OpenAPI specs offered in the palette (see SqliteStore for the same methods).
 */
import type { OpenApiSpecRecord, OpenApiSpecWrite } from "../store.js";
import { mapOpenApiSpecRow, OPENAPI_SPEC_COLUMNS, type OpenApiSpecRow } from "../openapi-spec-rows.js";
import { toStr } from "./helpers.js";
import type { PgContext } from "./context.js";

/** SQLite orders by name then id in byte order; the "C" collation matches it. */
export async function listOpenApiSpecs(ctx: PgContext, projectId?: string): Promise<OpenApiSpecRecord[]> {
  const rows = projectId
    ? await ctx.query<OpenApiSpecRow>(
        `SELECT ${OPENAPI_SPEC_COLUMNS} FROM openapi_specs WHERE project_id = $1 ORDER BY name COLLATE "C", id COLLATE "C"`,
        [projectId]
      )
    : await ctx.query<OpenApiSpecRow>(`SELECT ${OPENAPI_SPEC_COLUMNS} FROM openapi_specs ORDER BY name COLLATE "C", id COLLATE "C"`);
  return rows.map(mapOpenApiSpecRow);
}

export async function getOpenApiSpec(ctx: PgContext, id: string): Promise<OpenApiSpecRecord | null> {
  const row = await ctx.queryOne<OpenApiSpecRow>(`SELECT ${OPENAPI_SPEC_COLUMNS} FROM openapi_specs WHERE id = $1`, [id]);
  return row ? mapOpenApiSpecRow(row) : null;
}

export async function getOpenApiSpecText(ctx: PgContext, id: string): Promise<string | null> {
  const row = await ctx.queryOne<{ spec_text: string }>(`SELECT spec_text FROM openapi_specs WHERE id = $1`, [id]);
  return row ? toStr(row.spec_text) : null;
}

/** An existing id keeps its project, creator and creation time. */
export async function saveOpenApiSpec(ctx: PgContext, input: OpenApiSpecWrite): Promise<OpenApiSpecRecord> {
  const now = new Date().toISOString();
  await ctx.execute(
    `INSERT INTO openapi_specs (id, project_id, name, source_url, base_url, spec_text, catalog_json, operation_count, created_by, created_at, updated_at, fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, source_url = EXCLUDED.source_url, base_url = EXCLUDED.base_url,
       spec_text = EXCLUDED.spec_text, catalog_json = EXCLUDED.catalog_json, operation_count = EXCLUDED.operation_count,
       updated_at = EXCLUDED.updated_at, fetched_at = EXCLUDED.fetched_at`,
    [
      input.id,
      input.projectId,
      input.name,
      input.sourceUrl,
      input.baseUrl,
      input.specText,
      JSON.stringify(input.catalog),
      input.catalog.operations.length,
      input.createdBy,
      now,
      input.fetchedAt ?? now
    ]
  );
  return (await getOpenApiSpec(ctx, input.id))!;
}

export async function deleteOpenApiSpec(ctx: PgContext, id: string): Promise<boolean> {
  const result = await ctx.pool.query(`DELETE FROM openapi_specs WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}
