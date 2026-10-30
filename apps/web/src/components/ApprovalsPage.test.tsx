import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequestView } from "@ai-orchestrator/shared";
import * as api from "../lib/api";
import { ApprovalsPage } from "./ApprovalsPage";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, listApprovals: vi.fn(), approveApproval: vi.fn(), rejectApproval: vi.fn() };
});

function view(overrides: Partial<ApprovalRequestView> = {}): ApprovalRequestView {
  const now = Date.now();
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
    editableFields: [
      { key: "amount", label: "Amount", type: "number", required: true, value: 40 },
      { key: "note", type: "text", value: "Customer asked twice" }
    ],
    path: [],
    details: null,
    requestedBy: "builder@example.com",
    triggerType: "manual",
    triggeredBy: "builder@example.com",
    createdAt: new Date(now - 5 * 60_000).toISOString(),
    expiresAt: new Date(now + 55 * 60_000).toISOString(),
    decidedBy: null,
    decidedAt: null,
    reason: null,
    editedFields: [],
    canDecide: true,
    cannotDecideReason: null,
    ...overrides
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("ApprovalsPage", () => {
  it("lists pending requests with their details and reports the decidable count", async () => {
    vi.mocked(api.listApprovals).mockResolvedValue({
      items: [
        view(),
        view({
          requestId: "req-2",
          executionId: "ex-2",
          kind: "agent_tool",
          message: "Agent wants to call delete_ticket",
          editableFields: [],
          details: {
            toolName: "delete_ticket",
            server: "Helpdesk",
            arguments: '{"id":42}',
            policyReason: "MCP tool 'delete_ticket' needs approval by policy 'Deletes' (mtp_1); the call matches: id > 10."
          },
          path: [{ workflowId: "wf-parent", workflowName: "Parent flow", nodeId: "call_child" }],
          canDecide: false,
          cannotDecideReason: "You started this run; someone else must approve it."
        })
      ]
    });
    const onCount = vi.fn();
    render(<ApprovalsPage onPendingCountChange={onCount} />);

    expect(await screen.findByText("Approve the refund?")).toBeInTheDocument();
    expect(api.listApprovals).toHaveBeenCalledWith({ status: "pending" });
    expect(onCount).toHaveBeenCalledWith(1);
    expect(screen.getByText("delete_ticket")).toBeInTheDocument();
    expect(screen.getByText('{"id":42}')).toBeInTheDocument();
    expect(screen.getByText(/the call matches: id > 10/)).toBeInTheDocument();
    expect(screen.getByText(/Parent flow/)).toBeInTheDocument();
    expect(screen.getByText("You started this run; someone else must approve it.")).toBeInTheDocument();

    const toolCard = screen.getByText("Agent wants to call delete_ticket").closest("article")!;
    expect(within(toolCard).getByRole("button", { name: "Approve" })).toBeDisabled();

    await userEvent.type(screen.getByLabelText("Filter"), "delete");
    expect(screen.queryByText("Approve the refund?")).toBeNull();
  });

  it("approves with typed edits and a reason, and shows a queued outcome", async () => {
    vi.mocked(api.listApprovals).mockResolvedValue({ items: [view()] });
    vi.mocked(api.approveApproval).mockResolvedValue({ queued: true, executionId: "ex-1", requestId: "req-1", decision: "approve" });
    render(<ApprovalsPage />);

    const amount = await screen.findByLabelText(/Amount/);
    expect(amount).toHaveValue(40);
    await userEvent.clear(amount);
    await userEvent.type(amount, "35");
    await userEvent.type(screen.getByLabelText(/Reason/), "Partial refund");
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(api.approveApproval).toHaveBeenCalledWith("ex-1", { requestId: "req-1", reason: "Partial refund", edits: { amount: 35 } })
    );
    expect(await screen.findByText("Approved. The run resumes on the queue.")).toBeInTheDocument();
    expect(api.listApprovals).toHaveBeenCalledTimes(2);
  });

  it("shows field errors before sending and from a refused decision", async () => {
    vi.mocked(api.listApprovals).mockResolvedValue({ items: [view()] });
    vi.mocked(api.approveApproval).mockRejectedValue(
      new api.ApiError("Invalid edits", 400, { error: "Invalid edits", details: [{ key: "note", message: "must be at most 5 characters" }] })
    );
    render(<ApprovalsPage />);

    const amount = await screen.findByLabelText(/Amount/);
    await userEvent.clear(amount);
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText("Amount is required")).toBeInTheDocument();
    expect(api.approveApproval).not.toHaveBeenCalled();

    await userEvent.type(amount, "10");
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText("note must be at most 5 characters")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Invalid edits");
  });

  it("requires a reason to reject when the request says so", async () => {
    vi.mocked(api.listApprovals).mockResolvedValue({ items: [view()] });
    vi.mocked(api.rejectApproval).mockResolvedValue({ status: "success" } as never);
    render(<ApprovalsPage />);

    await userEvent.click(await screen.findByRole("button", { name: "Reject" }));
    expect(screen.getByText("A reason is required to reject this request")).toBeInTheDocument();
    expect(api.rejectApproval).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText(/Reason/), "Wrong customer");
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(api.rejectApproval).toHaveBeenCalledWith("ex-1", { requestId: "req-1", reason: "Wrong customer" }));
    expect(await screen.findByText("Rejected. The run is now success.")).toBeInTheDocument();
  });

  it("says when the requester is unknown (a webhook or schedule started the run)", async () => {
    vi.mocked(api.listApprovals).mockResolvedValue({ items: [view({ requestedBy: null, triggeredBy: null, triggerType: null })] });
    render(<ApprovalsPage />);
    expect(await screen.findByText("Requester unknown (automatic trigger)")).toBeInTheDocument();
  });

  it("opens a deep-linked request that was already decided on the Decided tab", async () => {
    window.history.replaceState(null, "", "/?mode=approvals&request=req-9");
    vi.mocked(api.listApprovals).mockImplementation(async (filter) =>
      filter?.status === "decided"
        ? { items: [view({ requestId: "req-9", status: "rejected", decidedBy: "admin@example.com", decidedAt: new Date().toISOString(), reason: "No budget" })] }
        : { items: [] }
    );
    render(<ApprovalsPage />);

    const card = await screen.findByText("“No budget”");
    expect(card.closest("article")).toHaveClass("is-focused");
    expect(screen.getByRole("tab", { name: "Decided" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });
});
