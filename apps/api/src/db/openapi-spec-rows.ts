/**
 * v81 — the openapi_specs row shape and its mapping, shared by the SQLite and Postgres stores.
 */
import type { OpenApiCatalog } from "@ai-orchestrator/shared";
import type { OpenApiSpecRecord } from "./store.js";

export interface OpenApiSpecRow {
  id: string;
  project_id: string;
  name: string;
  source_url: string | null;
  base_url: string;
  catalog_json: string;
  operation_count: number | string;
  created_by: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  fetched_at: string | Date;
}

/** Every column but spec_text (read only on refresh and export). */
export const OPENAPI_SPEC_COLUMNS =
  "id, project_id, name, source_url, base_url, catalog_json, operation_count, created_by, created_at, updated_at, fetched_at";

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function parseCatalog(raw: string): OpenApiCatalog {
  try {
    const parsed = JSON.parse(raw) as Partial<OpenApiCatalog>;
    return {
      title: typeof parsed.title === "string" ? parsed.title : "API",
      version: typeof parsed.version === "string" ? parsed.version : "",
      ...(typeof parsed.description === "string" ? { description: parsed.description } : {}),
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : "",
      operations: Array.isArray(parsed.operations) ? parsed.operations : [],
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : []
    };
  } catch {
    return { title: "API", version: "", baseUrl: "", operations: [], warnings: ["The stored operations could not be read. Refresh the spec."] };
  }
}

export function mapOpenApiSpecRow(row: OpenApiSpecRow): OpenApiSpecRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name),
    sourceUrl: row.source_url ? String(row.source_url) : null,
    baseUrl: String(row.base_url ?? ""),
    catalog: parseCatalog(String(row.catalog_json ?? "")),
    operationCount: Number(row.operation_count) || 0,
    createdBy: row.created_by ? String(row.created_by) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    fetchedAt: iso(row.fetched_at)
  };
}
