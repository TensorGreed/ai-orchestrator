import pg from "pg";
import { parseStoredDataLabels, type DataLabels } from "@ai-orchestrator/shared";

/** Phase 16 — `{ labels }` from a stored labels column, parsed once; nothing when none were recorded. */
export function labelsField(value: string | null | undefined): { labels?: DataLabels } {
  const labels = parseStoredDataLabels(value ?? null);
  return labels ? { labels } : {};
}

/**
 * SQL that reads a stored JSON text column as jsonb, for any text SQLite's JSON functions read. jsonb refuses two
 * escapes that JSON.stringify writes and SQLite accepts: `\u0000` (22P05) and a lone surrogate such as `\ud800`, one
 * not part of a high + low pair (22P02). One such character in a user's string would fail every query that reads the
 * column, so both are swapped for `�` (still valid JSON, a string of the same length) before the cast. Keys,
 * types and array lengths never change, and every other string reads as it did. Linear in the text, in four steps:
 *  1. every escaped backslash `\\` becomes `\` (the same character), so each `\u` left starts a real escape and a
 *     literal backslash followed by `ud800` is never read as an escape;
 *  2. `\u0000` becomes `�`;
 *  3. valid surrogate pairs are set aside as `\U…\U…` (no JSON text holds `\U`), then every surrogate escape left,
 *     the lone ones, becomes `�`;
 *  4. `\U` goes back to `\u`.
 * `column` is a fixed column name, never input.
 */
export function storedJsonb(column: string): string {
  const hex = "[0-9a-fA-F]";
  const high = `[dD][89abAB]${hex}{2}`;
  const low = `[dD][c-fC-F]${hex}{2}`;
  const escapedBackslashes = `replace(${column}, '\\\\', '\\u005c')`;
  const noNul = `replace(${escapedBackslashes}, '\\u0000', '\\ufffd')`;
  const pairsAside = `regexp_replace(${noNul}, '\\\\u(${high})\\\\u(${low})', '\\\\U\\1\\\\U\\2', 'g')`;
  const noLone = `regexp_replace(${pairsAside}, '\\\\u[dD][89a-fA-F]${hex}{2}', '\\ufffd', 'g')`;
  return `replace(${noLone}, '\\U', '\\u')::jsonb`;
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
