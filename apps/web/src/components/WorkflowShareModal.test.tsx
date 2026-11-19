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
    expect(screen.getByText(/They see only their own runs of it/)).toBeInTheDocument();

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

describe("WorkflowShareModal projects", () => {
  const projects = [
    { id: "default", name: "Default" },
    { id: "ops", name: "Ops" }
  ] as unknown as Parameters<typeof WorkflowShareModal>[0]["projects"];
  const projectShare = { workflowId: "wf", projectId: "ops", accessLevel: "read" as const, sharedBy: "owner@example.com", createdAt: "2026-11-18T00:00:00.000Z" };

  it("shows who may not manage shares the current project shares only, with no Share or Unshare", async () => {
    vi.mocked(api.fetchWorkflowShares).mockResolvedValue({ shares: [projectShare] });
    render(<WorkflowShareModal workflowId="wf" workflowName="Orders" owningProjectId="default" projects={projects} onClose={() => undefined} />);
    expect(await screen.findByRole("cell", { name: "Ops" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Target project")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Unshare" })).not.toBeInTheDocument();
    expect(screen.getByText(/Only someone who may add members to this workflow's project can share it/)).toBeInTheDocument();
  });

  it("lets someone who may manage shares share with a project and unshare", async () => {
    vi.mocked(api.fetchWorkflowShares).mockResolvedValue({ shares: [projectShare], userShares: [] });
    render(<WorkflowShareModal workflowId="wf" workflowName="Orders" owningProjectId="default" projects={projects} onClose={() => undefined} />);
    expect(await screen.findByRole("button", { name: "Unshare" })).toBeInTheDocument();
    expect(screen.queryByText(/Only someone who may add members/)).not.toBeInTheDocument();
  });
});
