import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../lib/api";
import { WorkflowShareModal } from "./WorkflowShareModal";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, fetchWorkflowShares: vi.fn(), shareWorkflowWithUser: vi.fn(), unshareWorkflowWithUser: vi.fn(), shareWorkflow: vi.fn(), unshareWorkflow: vi.fn() };
});

beforeEach(() => {
  vi.resetAllMocks();
});

const share = (over: Partial<api.WorkflowUserShareRecord> = {}): api.WorkflowUserShareRecord => ({
  workflowId: "wf",
  userId: "usr_v",
  email: "victor@example.com",
  role: "viewer",
  disabled: false,
  accessLevel: "execute",
  effectiveAccess: "read",
  sharedBy: "owner@example.com",
  createdAt: "2026-11-18T00:00:00.000Z",
  ...over
});

function renderModal() {
  render(<WorkflowShareModal workflowId="wf" workflowName="Orders" owningProjectId="default" projects={[]} onClose={() => undefined} />);
}

describe("WorkflowShareModal people", () => {
  it("lists people with what they get, shares by email and removes", async () => {
    vi.mocked(api.fetchWorkflowShares).mockResolvedValue({ shares: [], userShares: [share()] });
    vi.mocked(api.shareWorkflowWithUser).mockResolvedValue({
      ok: true,
      share: { userId: "usr_o", email: "olivia@example.com", role: "viewer", accessLevel: "execute", effectiveAccess: "read" }
    });
    vi.mocked(api.unshareWorkflowWithUser).mockResolvedValue({ ok: true });
    renderModal();
    expect(await screen.findByText("victor@example.com")).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: /Can view \(role cannot run\)/ })).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Email"), "olivia@example.com");
    await userEvent.selectOptions(screen.getByLabelText("Access"), "execute");
    await userEvent.click(screen.getByRole("button", { name: "Share with person" }));
    expect(api.shareWorkflowWithUser).toHaveBeenCalledWith("wf", { email: "olivia@example.com", accessLevel: "execute" });
    expect(await screen.findByRole("status")).toHaveTextContent("olivia@example.com is a viewer, so they can view it but not run it.");

    await userEvent.click(screen.getByRole("button", { name: "Stop sharing with victor@example.com" }));
    expect(api.unshareWorkflowWithUser).toHaveBeenCalledWith("wf", "usr_v");
  });

  it("hides the people section from someone who cannot manage shares", async () => {
    vi.mocked(api.fetchWorkflowShares).mockResolvedValue({ shares: [] });
    renderModal();
    await waitFor(() => expect(api.fetchWorkflowShares).toHaveBeenCalled());
    expect(screen.queryByRole("heading", { name: "People" })).not.toBeInTheDocument();
  });
});
