/** The longest a single run may be given (matches normalizeExecutionTimeoutMs in app.ts). */
export const MAX_RUN_TIMEOUT_MS = 86_400_000;

/** Margin on top of a run time limit before a running job counts as stuck. */
export const STUCK_JOB_MARGIN_MS = 60_000;

/** The per-run time limit a queued payload asked for, bounded like the runner bounds it, or null. */
export function queuedRunTimeoutMs(payloadJson: unknown): number | null {
  let parsed: unknown;
  try {
    parsed = typeof payloadJson === "string" ? JSON.parse(payloadJson) : payloadJson;
  } catch {
    return null;
  }
  const value = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).executionTimeoutMs : undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.max(1_000, Math.min(MAX_RUN_TIMEOUT_MS, Math.floor(value)));
}
