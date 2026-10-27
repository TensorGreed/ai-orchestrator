/**
 * Phase 13.1 — one clamp for list limits, used by both stores so a limit means the same on SQLite and Postgres.
 * A limit is floored; a missing, zero or non-numeric one takes `fallback`; the result stays within 1..max.
 */
export function clampLimit(value: number | undefined, options: { fallback: number; max: number }): number {
  const floored = value === undefined ? Number.NaN : Math.floor(value);
  return Math.max(1, Math.min(options.max, floored || options.fallback));
}

/** Upper bounds for the clamped store lists (above every caller's value; they only stop runaway inputs). */
export const LIMIT_MAX = {
  knowledgeBaseChunkPreviews: 500,
  dequeueNext: 1000,
  mcpServerProbes: 1000,
  mcpToolSnapshots: 1000,
  usageRollup: 500,
  usageEvents: 500,
  budgetAlerts: 500
} as const;
