import pg from "pg";
import { parseStoredDataLabels, type DataLabels } from "@ai-orchestrator/shared";

/** Phase 16 — `{ labels }` from a stored labels column, parsed once; nothing when none were recorded. */
export function labelsField(value: string | null | undefined): { labels?: DataLabels } {
  const labels = parseStoredDataLabels(value ?? null);
  return labels ? { labels } : {};
}

/**
 * SQL that reads a stored JSON text column as jsonb, NUL-proof. jsonb (and json's operators) refuse the escape
 * `\u0000` with 22P05 anywhere in the document, so one NUL in a user's string would fail every query that reads the
 * column. The escape is swapped for `\ufffd` (the same width, still valid JSON) before the cast, so the other fields
 * read as SQLite's JSON functions read them. `column` is a fixed column name, never input.
 */
export function nulSafeJsonb(column: string): string {
  return `replace(${column}, '\\u0000', '\\ufffd')::jsonb`;
}

// Helper to safely parse JSON
export function parseJsonSafe(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function parseTagsJson(value: string | null | undefined): string[] | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = parseJsonSafe(value);
  if (!Array.isArray(parsed)) return undefined;
  return parsed.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0);
}

export function toNum(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

export function toStr(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

export const PG_TIMESTAMPTZ_OID = 1184;
const pgTimestamptzParser = pg.types.getTypeParser(PG_TIMESTAMPTZ_OID) as (value: string) => unknown;

/**
 * Phase 13.1 — a TIMESTAMPTZ value as an ISO-8601 string (`2026-10-26T07:00:00.000Z`), the shape the SQLite store
 * returns. pg's own parser reads the text (offsets with seconds, BC dates); a value with no ISO form (`infinity`)
 * comes back as Postgres wrote it.
 */
export function parseTimestamptz(value: string): string {
  const parsed = pgTimestamptzParser(value);
  return parsed instanceof Date && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : value;
}
