import { describe, expect, it } from "vitest";
import type { ApprovalEditableField, ApprovalRequestView } from "@ai-orchestrator/shared";
import { ApiError } from "./api";
import {
  approversSummary,
  buildApprovalEdits,
  decisionError,
  decisionOutcome,
  initialFieldDrafts,
  matchesApprovalFilter,
  relativeTime
} from "./approvals";

const fields: ApprovalEditableField[] = [
  { key: "subject", type: "string", required: true, maxLength: 10, value: "Hello" },
  { key: "amount", type: "number", value: 12 },
  { key: "urgent", type: "boolean", value: false },
  { key: "payload", type: "json", value: { a: 1 } }
];

function approvalView(overrides: Partial<ApprovalRequestView> = {}): ApprovalRequestView {
  return {
    requestId: "req-1",
    id: "ex-1",
    executionId: "ex-1",
    workflowId: "wf-1",
    workflowName: "Refunds",
    projectId: "default",
    nodeId: "gate",
    nodeType: "approval_gate",
    kind: "approval_gate",
    status: "pending",
    message: "Approve the refund?",
    approvalMessage: "Approve the refund?",
    timeoutMinutes: 60,
    approverRoles: ["admin"],
    approverUsers: [],
    allowSelfApproval: false,
    timeoutOutcome: "reject",
    requireRejectReason: true,
    editableFields: [],
    path: [],
    details: null,
    requestedBy: "builder@example.com",
    triggerType: "manual",
    triggeredBy: "builder@example.com",
    createdAt: "2026-10-23T10:00:00.000Z",
    expiresAt: "2026-10-23T11:00:00.000Z",
    decidedBy: null,
    decidedAt: null,
    reason: null,
    editedFields: [],
    canDecide: true,
    cannotDecideReason: null,
    ...overrides
  };
}

describe("approvals helpers", () => {
  it("formats relative times both ways", () => {
    const now = Date.parse("2026-10-23T10:00:00.000Z");
    expect(relativeTime("2026-10-23T09:55:00.000Z", now)).toBe("5 min ago");
    expect(relativeTime("2026-10-23T13:00:00.000Z", now)).toBe("in 3 h");
    expect(relativeTime("2026-10-26T10:00:00.000Z", now)).toBe("in 3 d");
    expect(relativeTime("2026-10-23T10:00:10.000Z", now)).toBe("just now");
    expect(relativeTime(null, now)).toBe("");
  });

  it("starts drafts from the proposed values", () => {
    expect(initialFieldDrafts(fields)).toEqual({ subject: "Hello", amount: "12", urgent: false, payload: JSON.stringify({ a: 1 }, null, 2) });
  });

  it("sends only changed fields, typed, and checks them with the shared validator", () => {
    const drafts = { ...initialFieldDrafts(fields), amount: "15.5", urgent: true };
    expect(buildApprovalEdits(fields, drafts)).toEqual({ edits: { amount: 15.5, urgent: true }, errors: {} });

    const bad = buildApprovalEdits(fields, { ...initialFieldDrafts(fields), subject: "", amount: "x", payload: "{" });
    expect(bad.errors).toEqual({ subject: "is required", amount: "must be a number", payload: "must be valid JSON" });
    expect(buildApprovalEdits(fields, { ...initialFieldDrafts(fields), subject: "far too long text" }).errors.subject).toMatch(/at most 10/);
  });

  it("maps refused decisions to field errors", () => {
    const keyed = decisionError(new ApiError("Invalid edits", 400, { error: "Invalid edits", details: [{ key: "subject", message: "is required" }] }));
    expect(keyed).toEqual({ message: "Invalid edits", fieldErrors: { subject: "is required" } });
    const zod = decisionError(new ApiError("Invalid approval payload", 400, { details: [{ path: ["reason"], message: "Too long" }] }));
    expect(zod.fieldErrors).toEqual({ reason: "Too long" });
    expect(decisionError(new Error("offline"))).toEqual({ message: "offline", fieldErrors: {} });
  });

  it("describes the outcome, queued or inline", () => {
    expect(decisionOutcome("approve", { queued: true, executionId: "ex-1", requestId: "r", decision: "approve" })).toBe("Approved. The run resumes on the queue.");
    expect(decisionOutcome("reject", { status: "success" } as never)).toBe("Rejected. The run is now success.");
  });

  it("summarises approvers and filters by text", () => {
    expect(approversSummary(approvalView())).toBe("roles: admin · not the requester");
    expect(approversSummary(approvalView({ approverRoles: [], allowSelfApproval: true }))).toBe("operators and above with run access");
    const tool = approvalView({ kind: "agent_tool", details: { toolName: "delete_ticket" } });
    expect(matchesApprovalFilter(tool, "DELETE")).toBe(true);
    expect(matchesApprovalFilter(tool, "refunds")).toBe(true);
    expect(matchesApprovalFilter(tool, "nothing")).toBe(false);
  });
});
