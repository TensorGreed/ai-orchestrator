/**
 * Small helpers shared by app.ts and the route modules that start runs (pure functions, no app state).
 */
import { ErrorCategory, WorkflowError } from "@ai-orchestrator/shared";

/**
 * True when a run's abort signal fired because the execution timeout ran
 * out, not because a person stopped it. A timed-out run ends as an error
 * on the node that was running; a stopped run ends as canceled.
 */
export function isExecutionTimeoutAbort(signal: AbortSignal | undefined): boolean {
  const reason: unknown = signal?.aborted ? signal.reason : undefined;
  return reason instanceof WorkflowError && reason.category === ErrorCategory.WORKFLOW_TIMEOUT;
}

export function normalizeExecutionTimeoutMs(
  primary: unknown,
  secondary: unknown,
  fallbackMs: number
): number {
  const candidate =
    typeof primary === "number" && Number.isFinite(primary) && primary > 0
      ? primary
      : typeof secondary === "number" && Number.isFinite(secondary) && secondary > 0
        ? secondary
        : fallbackMs;
  const bounded = Math.floor(candidate);
  return Math.max(1_000, Math.min(86_400_000, bounded));
}

export function normalizeIsoDateFilter(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const timestamp = Date.parse(value.trim());
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }
  return new Date(timestamp).toISOString();
}

// Phase 8.3 — surface a Retry-After hint when a budget block rejects.
// Returns seconds until the start of the next budget period.
export function retryAfterSeconds(period: "day" | "week" | "month"): number {
  const now = new Date();
  let next: Date;
  if (period === "day") {
    next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  } else if (period === "week") {
    const day = now.getUTCDay();
    const daysFromMonday = (day + 6) % 7;
    next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysFromMonday + 7));
  } else {
    next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  }
  return Math.max(60, Math.floor((next.getTime() - now.getTime()) / 1000));
}

export function normalizeSessionId(sessionId?: string, sessionIdSnakeCase?: string): string | undefined {
  const camel = typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : undefined;
  const snake = typeof sessionIdSnakeCase === "string" && sessionIdSnakeCase.trim() ? sessionIdSnakeCase.trim() : undefined;
  return camel ?? snake;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
