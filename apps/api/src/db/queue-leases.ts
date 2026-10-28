/**
 * Phase 13.1 — queue leases: what happens to a job whose worker was lost (its lease ran out) or that a worker gave
 * back while shutting down. Shared by both stores so they decide identically.
 *
 * Worker-loss policy (user decision 2): a run is re-queued automatically only if none of its nodes had completed;
 * a run with a completed node is marked `interrupted: worker lost` and dead-lettered for a person to retry, so side
 * effects such as e-mails or tool writes are never repeated silently. A lost worker always counts an attempt, so a
 * job that kills its worker every time ends in the dead-letter queue instead of looping.
 */
import { QUEUE_POOL_NAME_PATTERN } from "@ai-orchestrator/shared";

/** The history error and dead-letter reason of a run interrupted because its worker was lost. */
export const WORKER_LOST_INTERRUPTED_ERROR = "interrupted: worker lost";
/** The dead-letter reason of a job whose worker was lost on its last attempt (no node had completed). */
export const WORKER_LOST_ERROR = "worker lost";
/** The history error and dead-letter reason of a run a worker stopped while shutting down, after a node completed. */
export const WORKER_SHUTDOWN_INTERRUPTED_ERROR = "interrupted: worker shut down";

/**
 * A write fenced on a queue claim that no longer holds its item (the job was taken back, so another worker may run
 * it): nothing was written.
 */
export class QueueClaimLostError extends Error {
  constructor(what: string) {
    super(`Refused ${what}: this worker's queue claim was taken back`);
    this.name = "QueueClaimLostError";
  }
}

/** The node statuses that mean a node ran to an end (and so may have had side effects). */
const COMPLETED_NODE_STATUSES = new Set(["success", "error", "waiting_approval"]);

/** Run record statuses a final write leaves (`partial` counts only with a completed_at). */
const FINAL_RUN_STATUSES = new Set(["success", "error", "canceled", "partial"]);

/** Whether a stored node-results JSON (an array of `{ nodeId, status }`) holds a node that completed. */
export function hasCompletedNode(nodeResultsJson: unknown): boolean {
  let parsed: unknown = nodeResultsJson;
  if (typeof nodeResultsJson === "string") {
    try {
      parsed = JSON.parse(nodeResultsJson);
    } catch {
      return false;
    }
  }
  if (!Array.isArray(parsed)) return false;
  return parsed.some((entry) => {
    const status = entry && typeof entry === "object" ? (entry as { status?: unknown }).status : undefined;
    return typeof status === "string" && COMPLETED_NODE_STATUSES.has(status);
  });
}

export type LostJobDecision =
  /** The run's own record is over: the job is completed, nothing runs again. */
  | "finished"
  /** Back to pending for another worker. */
  | "requeue"
  /** No attempt left: dead-lettered with `worker lost`; a running record is marked interrupted. */
  | "dead_letter"
  /** A node had completed: the record is marked interrupted and the job dead-lettered for a manual retry. */
  | "interrupt";

export interface LostJobInput {
  /** Attempts after this loss was counted (a shutdown release does not count one). */
  attempts: number;
  maxAttempts: number;
  /** Whether this loss counts an attempt (a lost worker does; a clean shutdown does not). */
  countsAttempt: boolean;
  /**
   * The payload carries an approval resume (Phase 11.2). Its history record still reads as the pause (a resume writes
   * no progress there), so what it did is read from the paused state and the queue row instead.
   */
  resume: boolean;
  /** A resume only: the status of the run's paused state (`resuming` while the resume is due), or null when it is gone. */
  resumeStateStatus?: string | null;
  /** A resume only: nodes the resume completed under its claims (the queue row's nodes_completed). */
  resumeNodesCompleted?: number;
  /** The run's history record, if one was written. */
  history: { status: string; completedAt: unknown; nodeResultsJson: unknown } | null;
}

/** A record whose final write landed: `partial` only once it has a completed_at. */
function isFinalRecord(history: NonNullable<LostJobInput["history"]>): boolean {
  if (history.status === "partial") return history.completedAt !== null && history.completedAt !== undefined;
  return FINAL_RUN_STATUSES.has(history.status);
}

export function decideLostJob(input: LostJobInput): LostJobDecision {
  if (input.resume) {
    // The resume is over once its run's final write landed, or once the paused state left `resuming` (it paused again
    // at a later gate, finished, or was handed back to waiting): nothing runs it again.
    if (input.history && isFinalRecord(input.history)) return "finished";
    if (input.resumeStateStatus !== "resuming") return "finished";
    // A clean shutdown gives a resume back with its paused state intact; the next worker resumes it from the decision.
    if (!input.countsAttempt) return "requeue";
    // A lost worker: like any run, re-run only if nothing completed since the resume started.
    if ((input.resumeNodesCompleted ?? 0) > 0) return "interrupt";
    return input.attempts >= input.maxAttempts ? "dead_letter" : "requeue";
  }
  if (input.history) {
    if (isFinalRecord(input.history) || input.history.status === "waiting_approval") return "finished";
    if (input.history.status === "running" && hasCompletedNode(input.history.nodeResultsJson)) return "interrupt";
  }
  if (input.countsAttempt && input.attempts >= input.maxAttempts) return "dead_letter";
  return "requeue";
}

/** One job the reaper (or a shutdown release) settled, for logs and metrics. */
export interface LostJobOutcome {
  id: string;
  workflowId: string;
  executionId: string;
  decision: LostJobDecision;
  attempts: number;
}

/** The execution id a queue payload runs as (the queue item id when the payload has none). */
export function payloadExecutionId(payloadJson: unknown, fallback: string): string {
  let parsed: unknown = payloadJson;
  if (typeof payloadJson === "string") {
    try {
      parsed = JSON.parse(payloadJson);
    } catch {
      return fallback;
    }
  }
  const value = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).executionId : undefined;
  return typeof value === "string" && value ? value : fallback;
}

/** Whether a queue payload resumes a paused run (Phase 11.2). */
export function payloadIsResume(payloadJson: unknown): boolean {
  let parsed: unknown = payloadJson;
  if (typeof payloadJson === "string") {
    try {
      parsed = JSON.parse(payloadJson);
    } catch {
      return false;
    }
  }
  const value = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).resume : undefined;
  return Boolean(value && typeof value === "object");
}

/** Pool names: a letter or digit, then letters, digits, `_` or `-` (at most 63); one definition, in the shared schema. */
export const QUEUE_POOL_PATTERN = QUEUE_POOL_NAME_PATTERN;
export const DEFAULT_QUEUE_POOL = "default";

/**
 * The candidate window a fair claim ranks over: eight times the batch, at least 64 and at most 512 rows. It is read
 * through the claim index without locks (only the picked rows are locked), so a wider window costs little.
 */
export function fairClaimWindow(limit: number): number {
  return Math.min(512, Math.max(64, limit * 8));
}
