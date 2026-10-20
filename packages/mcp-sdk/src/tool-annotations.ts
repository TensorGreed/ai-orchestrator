import type { McpToolAnnotations } from "@ai-orchestrator/shared";

const BOOLEAN_HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

/**
 * Phase 10.2 — keep the MCP tool annotations a server sent with `tools/list`.
 * Only the known hint fields are kept, and only with the right types, so a
 * server cannot smuggle arbitrary data into snapshots or traces. Returns
 * `undefined` when nothing usable was sent.
 */
export function normalizeToolAnnotations(raw: unknown): McpToolAnnotations | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const out: McpToolAnnotations = {};
  if (typeof record.title === "string" && record.title.trim()) {
    out.title = record.title.slice(0, 200);
  }
  for (const key of BOOLEAN_HINTS) {
    if (typeof record[key] === "boolean") {
      out[key] = record[key] as boolean;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Spread helper for adapters: `{ annotations }` when the server sent any, else `{}`. */
export function withToolAnnotations(raw: unknown): { annotations?: McpToolAnnotations } {
  const annotations = normalizeToolAnnotations(raw);
  return annotations ? { annotations } : {};
}
