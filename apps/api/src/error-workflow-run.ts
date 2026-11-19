import crypto from "node:crypto";

/**
 * An error workflow's run is recorded like any other run, under an id derived from the failed run's id: one failed run
 * starts at most one error workflow run, a queued fire of it is queued once, and the failed run's record can name the
 * run its error workflow made without storing anything more on it.
 */
export const ERROR_WORKFLOW_TRIGGER_TYPE = "error";

/** The execution id of the error workflow run a failed run starts (UUID-shaped, like every other run id). */
export function errorWorkflowRunId(failedExecutionId: string): string {
  const hex = crypto.createHash("sha256").update(`l2m:error-workflow-run:${failedExecutionId}`).digest("hex");
  // Version 5 and RFC 4122 variant bits, so the id reads as an ordinary name-based UUID.
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

/** The input an error workflow run receives (its Error Trigger's output), also stored as the run's input. */
export interface ErrorWorkflowInput {
  error: string;
  errorStack?: string;
  sourceWorkflowId: string;
  sourceWorkflowName: string;
  executionId?: string;
  timestamp: string;
}

/** The failed run an error workflow run handled, read from its stored input; null for any other run. */
export function errorWorkflowSourceOf(run: { triggerType?: string | null; input?: unknown }): { executionId: string; workflowId: string; workflowName: string } | null {
  if (run.triggerType !== ERROR_WORKFLOW_TRIGGER_TYPE) return null;
  const input = run.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (typeof record.executionId !== "string" || !record.executionId || typeof record.sourceWorkflowId !== "string") return null;
  return {
    executionId: record.executionId,
    workflowId: record.sourceWorkflowId,
    workflowName: typeof record.sourceWorkflowName === "string" ? record.sourceWorkflowName : record.sourceWorkflowId
  };
}

/** A run named from another run's record: a failed run's error workflow run, or the failed run an error run handled. */
export interface ErrorWorkflowRunLink {
  executionId: string;
  workflowId: string;
  workflowName: string;
  status: string;
}
