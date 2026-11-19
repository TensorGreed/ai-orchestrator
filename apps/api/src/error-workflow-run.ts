import crypto from "node:crypto";
import type { Store } from "./db/store.js";

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

/** The claim's record: one row per failed run in the webhook idempotency table (insert-only, so one racer wins). */
const ERROR_WORKFLOW_CLAIM_ENDPOINT = "l2m:error-workflow-run";
/** How long a failed run's claim is kept: longer than any re-run of that run (a lost lease, a dead-letter retry). */
const ERROR_WORKFLOW_CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type ClaimStore = Pick<Store, "saveWebhookIdempotencyPending" | "getWebhookIdempotency" | "clearExpiredWebhookSecurityState" | "releaseWebhookIdempotencyPending">;

/**
 * Claims the error workflow run of a failed run: true for the first caller, false when the failed run already started
 * its error workflow (the same run executed again, as after a lost lease). A store error other than the claim being
 * taken counts as claimed, so the error workflow still runs, as it did before claims. When the error workflow's dispatch
 * is then refused (a budget, a queue that failed to take it), the caller gives the claim back (releaseErrorWorkflowRun), so the
 * failed run executed again tries again.
 */
export async function claimErrorWorkflowRun(store: ClaimStore, failedExecutionId: string, now = Date.now()): Promise<boolean> {
  const key = { endpointKey: ERROR_WORKFLOW_CLAIM_ENDPOINT, idempotencyKey: failedExecutionId };
  try {
    await store.saveWebhookIdempotencyPending({ ...key, requestHash: errorWorkflowRunId(failedExecutionId), expiresAt: new Date(now + ERROR_WORKFLOW_CLAIM_TTL_MS).toISOString() });
    // Expired claims (and webhook replay state) go now: nothing else purges them on an instance without signed webhooks.
    void store.clearExpiredWebhookSecurityState(new Date(now).toISOString()).catch(() => undefined);
    return true;
  } catch {
    const existing = await store.getWebhookIdempotency(key).catch(() => null);
    return existing === null;
  }
}

/**
 * Gives back the claim of a failed run whose error workflow run was refused before it started, so a later execution of
 * that failed run tries again. Never throws: a claim that cannot be given back stays taken (the error workflow is then
 * not retried, as before claims could be given back).
 */
export async function releaseErrorWorkflowRun(store: ClaimStore, failedExecutionId: string): Promise<boolean> {
  try {
    return await store.releaseWebhookIdempotencyPending({
      endpointKey: ERROR_WORKFLOW_CLAIM_ENDPOINT,
      idempotencyKey: failedExecutionId,
      requestHash: errorWorkflowRunId(failedExecutionId)
    });
  } catch {
    return false;
  }
}
