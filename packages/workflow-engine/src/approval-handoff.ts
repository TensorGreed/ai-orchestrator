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

/**
 * Approvals granted through `rerun` hand-offs live in the paused state's
 * `approvedHandoffKeys`, which only the resume path writes; never in the run
 * globals, which run input and variables reach.
 */
export function approvedHandoffKeysFromState(state: { approvedHandoffKeys?: unknown } | undefined): Set<string> {
  const raw = state?.approvedHandoffKeys;
  return new Set(Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : []);
}

/** Keys starting with `__` are reserved for the engine: dropped from run input and variables before they become globals. */
export function withoutReservedKeys(record: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!record) return {};
  return Object.fromEntries(Object.entries(record).filter(([key]) => !key.startsWith("__")));
}
