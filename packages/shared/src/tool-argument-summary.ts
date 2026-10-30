import { z } from "zod";

/**
 * Phase 12.4 — a safe summary of one MCP tool call's arguments, kept on its
 * telemetry row (`mcp_tool_calls.args_summary_json`) so policies can later be
 * suggested and simulated from real runs without keeping the arguments.
 *
 * Keyed by argument path: object keys joined with `.`, array elements as
 * `[]` (`labels[]`, `files[].path`). A key that is not a short plain name, or
 * that a data detector flags, is written `<k:HASH>`.
 *
 * Format 2 is an allow-list: a raw string is kept only when the tool's schema
 * lists it in an `enum` / `const`, or when it is a short lower-case token
 * outside any sensitive path; every other scalar is kept as its shape plus a
 * keyed hash (HMAC-SHA-256 under a key derived from the master key), so equal
 * values can be counted and compared without being stored.
 */
export const TOOL_ARGUMENT_SUMMARY_VERSION = 2;

export type ToolArgumentValueType = "string" | "number" | "boolean" | "null" | "object" | "array";

/** Length buckets for strings whose text is not kept. */
export const TOOL_ARGUMENT_LENGTH_BUCKETS = ["0", "1-8", "9-32", "33-128", "129-512", "513-2048", "2049+"] as const;
export type ToolArgumentLengthBucket = (typeof TOOL_ARGUMENT_LENGTH_BUCKETS)[number];

/** What a path held, merged over every value seen there (several under an array). */
export interface ToolArgumentFieldSummary {
  /** `mixed` when values of several types were seen; `types` then lists them. */
  type: ToolArgumentValueType | "mixed";
  types?: ToolArgumentValueType[];
  /** How many values were seen at this path, when more than one. */
  count?: number;
  /** Kept values: booleans, small numbers and safe tokens or schema enum values; distinct and sorted. */
  values?: Array<string | number | boolean>;
  /** Kept numbers: smallest and largest seen. */
  min?: number;
  max?: number;
  /** Numbers not kept (seven or more integer digits, or under a sensitive path): largest order of magnitude, floor(log10(|n|)). */
  mag?: number;
  /** Keyed hashes (16 bytes, base64url) of the values not kept; distinct and sorted. */
  hashes?: string[];
  /** Identifier prefixes: `owner/` of a repository, `@domain` of an email, scheme and host of a URL, a path root. */
  prefixes?: string[];
  /** Data classes a detector found (`email`, `card_number`, `credential`, ...). */
  classes?: string[];
  /** Largest length bucket of the strings whose text was not kept. */
  len?: ToolArgumentLengthBucket;
  /** Arrays: largest element count. Objects: largest key count. */
  items?: number;
  keys?: number;
  /** More distinct values, hashes or prefixes than kept; that list is dropped then. */
  more?: true;
}

export interface ToolArgumentSummary {
  v: typeof TOOL_ARGUMENT_SUMMARY_VERSION;
  fields: Record<string, ToolArgumentFieldSummary>;
  /** A size, depth or scan cap was reached; some values were summarised less precisely or skipped. */
  truncated?: true;
}

const valueTypeSchema = z.enum(["string", "number", "boolean", "null", "object", "array"]);

export const toolArgumentFieldSummarySchema = z
  .object({
    type: z.union([valueTypeSchema, z.literal("mixed")]),
    types: z.array(valueTypeSchema).optional(),
    count: z.number().int().nonnegative().optional(),
    values: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    mag: z.number().int().optional(),
    hashes: z.array(z.string()).optional(),
    prefixes: z.array(z.string()).optional(),
    classes: z.array(z.string()).optional(),
    len: z.enum(TOOL_ARGUMENT_LENGTH_BUCKETS).optional(),
    items: z.number().int().nonnegative().optional(),
    keys: z.number().int().nonnegative().optional(),
    more: z.literal(true).optional()
  })
  .strict();

export const toolArgumentSummarySchema = z
  .object({
    v: z.literal(TOOL_ARGUMENT_SUMMARY_VERSION),
    fields: z.record(z.string(), toolArgumentFieldSummarySchema),
    truncated: z.literal(true).optional()
  })
  .strict();

/** A stored summary, or null when it is missing, unreadable or of another version. */
export function parseToolArgumentSummary(value: unknown): ToolArgumentSummary | null {
  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const parsed = toolArgumentSummarySchema.safeParse(raw);
  return parsed.success ? (parsed.data as ToolArgumentSummary) : null;
}
