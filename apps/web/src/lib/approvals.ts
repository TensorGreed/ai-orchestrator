import { validateApprovalEdits, type ApprovalEditableField, type ApprovalRequestView, type ReleaseApprovalRequestView } from "@ai-orchestrator/shared";
import { ApiError, type ApprovalDecisionResponse, type ApprovalInboxItem } from "./api";

/** Phase 11.2 — helpers behind the approvals inbox. */

export type FieldDraft = string | boolean;
export type FieldDrafts = Record<string, FieldDraft>;

const KIND_LABELS: Record<ApprovalInboxItem["kind"], string> = {
  release: "Release",
  approval_gate: "Approval gate",
  human_approval: "Human approval",
  guard: "Guard",
  agent_tool: "Write tool"
};

const STATUS_LABELS: Record<ApprovalRequestView["status"], string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  timed_out: "Timed out",
  canceled: "Canceled"
};

export function approvalKindLabel(kind: ApprovalInboxItem["kind"]): string {
  return KIND_LABELS[kind] ?? kind;
}

export function approvalStatusLabel(status: ApprovalRequestView["status"]): string {
  return STATUS_LABELS[status] ?? status;
}

/** "5 min ago", "in 3 h", "just now". */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const diff = at - now;
  const abs = Math.abs(diff);
  if (abs < 45_000) return "just now";
  const minutes = Math.round(abs / 60_000);
  const text =
    minutes < 60
      ? `${minutes} min`
      : minutes < 60 * 48
        ? `${Math.round(minutes / 60)} h`
        : `${Math.round(minutes / (60 * 24))} d`;
  return diff < 0 ? `${text} ago` : `in ${text}`;
}

/** Who may decide, in words. */
export function approversSummary(view: Pick<ApprovalRequestView, "approverRoles" | "approverUsers" | "allowSelfApproval">): string {
  const parts: string[] = [];
  if (view.approverRoles.length > 0) parts.push(`roles: ${view.approverRoles.join(", ")}`);
  if (view.approverUsers.length > 0) parts.push(`users: ${view.approverUsers.join(", ")}`);
  const who = parts.length > 0 ? parts.join("; ") : "operators and above with run access";
  return view.allowSelfApproval ? who : `${who} · not the requester`;
}

/** The draft an input starts from: the value the run proposed, as the input shows it. */
export function fieldDraft(field: ApprovalEditableField): FieldDraft {
  const value = field.value;
  if (field.type === "boolean") return value === true;
  if (value === undefined || value === null) return "";
  if (field.type === "json") return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return String(value);
}

export function initialFieldDrafts(fields: readonly ApprovalEditableField[]): FieldDrafts {
  const drafts: FieldDrafts = {};
  for (const field of fields) drafts[field.key] = fieldDraft(field);
  return drafts;
}

/**
 * The edits to send: only fields the approver changed, typed the way the API
 * checks them, plus the errors the shared validator finds before sending.
 */
export function buildApprovalEdits(
  fields: readonly ApprovalEditableField[],
  drafts: FieldDrafts
): { edits: Record<string, unknown>; errors: Record<string, string> } {
  const edits: Record<string, unknown> = {};
  for (const field of fields) {
    const draft = drafts[field.key];
    if (draft === undefined || draft === fieldDraft(field)) continue;
    edits[field.key] = field.type === "number" && typeof draft === "string" && draft.trim() !== "" && Number.isFinite(Number(draft)) ? Number(draft) : draft;
  }
  const checked = validateApprovalEdits(fields, edits);
  const errors: Record<string, string> = {};
  // An emptied required field reads better as "is required" than as a type error.
  for (const field of fields) {
    const draft = edits[field.key];
    if (field.required && typeof draft === "string" && draft.trim() === "") errors[field.key] = "is required";
  }
  for (const error of checked.errors) errors[error.key] = errors[error.key] ?? error.message;
  return { edits, errors };
}

/** Message and per-field errors from a refused decision (`{ error, details }`). */
export function decisionError(error: unknown): { message: string; fieldErrors: Record<string, string> } {
  const fieldErrors: Record<string, string> = {};
  if (error instanceof ApiError) {
    const details = Array.isArray(error.payload?.details) ? (error.payload.details as unknown[]) : [];
    for (const detail of details) {
      if (!detail || typeof detail !== "object") continue;
      const record = detail as { key?: unknown; path?: unknown; message?: unknown };
      const key =
        typeof record.key === "string"
          ? record.key
          : Array.isArray(record.path)
            ? record.path.filter((part) => part !== "edits").join(".")
            : "";
      const message = typeof record.message === "string" ? record.message : "is invalid";
      const target = key || "*";
      fieldErrors[target] = fieldErrors[target] ?? message;
    }
    return { message: error.message, fieldErrors };
  }
  return { message: error instanceof Error ? error.message : "The decision failed", fieldErrors };
}

/** One line describing what happened after a decision. */
export function decisionOutcome(decision: "approve" | "reject", response: ApprovalDecisionResponse): string {
  const verb = decision === "approve" ? "Approved" : "Rejected";
  if (response.queued) return `${verb}. The run resumes on the queue.`;
  const status = typeof response.status === "string" ? response.status.replace(/_/g, " ") : "updated";
  return `${verb}. The run is now ${status}.`;
}

/** Phase 15.4 — a release request rather than a paused run. */
export function isReleaseInboxItem(item: ApprovalInboxItem): item is ReleaseApprovalRequestView {
  return item.kind === "release";
}

/** Whether an inbox item is the one a deep link names (a request id, or a paused run's execution id). */
export function matchesFocus(item: ApprovalInboxItem, focusId: string | null): boolean {
  if (!focusId) return false;
  return item.requestId === focusId || (!isReleaseInboxItem(item) && item.executionId === focusId);
}

/** One line describing a decided release request. */
export function releaseDecisionOutcome(decision: "approve" | "reject", version: number, published: boolean): string {
  if (decision === "reject") return `Rejected. Version ${version} was not published.`;
  return published ? `Approved. Version ${version} is now in production.` : `Approved.`;
}

/** Case-insensitive match over the text an approver would search by. */
export function matchesApprovalFilter(view: ApprovalInboxItem, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (!needle) return true;
  if (isReleaseInboxItem(view)) {
    return [view.message, view.workflowName, view.workflowId, "release", `v${view.version}`, view.requestedBy, view.decidedBy, view.requestReason]
      .filter((part): part is string => typeof part === "string")
      .join(" ")
      .toLowerCase()
      .includes(needle);
  }
  const details = view.details ?? {};
  const haystack = [
    view.message,
    view.workflowName,
    view.workflowId,
    view.nodeId,
    view.kind,
    view.requestedBy,
    view.decidedBy,
    typeof details.toolName === "string" ? details.toolName : null,
    ...view.path.map((step) => step.workflowName ?? step.workflowId)
  ]
    .filter((part): part is string => typeof part === "string")
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}
