import type { ApprovalHandoffState } from "@ai-orchestrator/shared";

/**
 * Phase 12.1 — approval hand-off. Any node can ask the run to pause for a
 * person's decision by throwing `ApprovalHandoffSignal` from its handler;
 * the executor turns it into the same `waiting_approval` pause a Human
 * Approval node produces (`persistPausedExecution`, `/api/approvals`), and
 * `resumeWorkflowExecution` applies the stored `ApprovalHandoffState`:
 *
 * - `route`: record `onApprove` or `onReject` as the node's output and route
 *   from it (the guard node sends rejected items to `blocked`);
 * - `rerun`: on approval run the node again with `approvalKey` accepted, on
 *   rejection fail the node (an agent whose guard asked mid-loop).
 *
 * Approval gates (11.2) build on this: they only need to throw the signal.
 */

export interface ApprovalHandoffRequest {
  /** Shown to the approver. */
  message: string;
  timeoutMinutes: number;
  handoff: ApprovalHandoffState;
  /** Safe details recorded on the waiting node result (never raw content). */
  details?: Record<string, unknown>;
}

export class ApprovalHandoffSignal extends Error {
  readonly request: ApprovalHandoffRequest;
  constructor(request: ApprovalHandoffRequest) {
    super(request.message);
    this.name = "ApprovalHandoffSignal";
    this.request = request;
  }
}

export function isApprovalHandoffSignal(error: unknown): error is ApprovalHandoffSignal {
  return error instanceof ApprovalHandoffSignal;
}

/** Run-scoped approvals granted through `rerun` hand-offs, kept in the run globals so they survive the pause. */
export const APPROVED_HANDOFF_KEYS_GLOBAL = "__approved_handoff_keys";

export function approvedHandoffKeys(globals: Record<string, unknown>): Set<string> {
  const raw = globals[APPROVED_HANDOFF_KEYS_GLOBAL];
  return new Set(Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : []);
}

export function grantHandoffKey(globals: Record<string, unknown>, key: string): void {
  const keys = approvedHandoffKeys(globals);
  keys.add(key);
  globals[APPROVED_HANDOFF_KEYS_GLOBAL] = [...keys];
}
