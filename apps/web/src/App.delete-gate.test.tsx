import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { vi } from "vitest";
import type { WorkflowListItem } from "@ai-orchestrator/shared";
import App from "./App";

const fetchAuthMeMock = vi.fn();
const fetchWorkflowsMock = vi.fn();
const fetchReleaseStateMock = vi.fn();
const deleteWorkflowMock = vi.fn();

vi.mock("./lib/api", async () => {
  const actual = await vi.importActual<typeof import("./lib/api")>("./lib/api");
  return {
    ...actual,
    fetchAuthMe: (...args: unknown[]) => fetchAuthMeMock(...args),
    fetchWorkflows: (...args: unknown[]) => fetchWorkflowsMock(...args),
    fetchReleaseState: (...args: unknown[]) => fetchReleaseStateMock(...args),
    deleteWorkflow: (...args: unknown[]) => deleteWorkflowMock(...args)
  };
});

const item: WorkflowListItem = {
  id: "wf-one",
  name: "Gated flow",
  schemaVersion: "1.0.0",
  workflowVersion: 1,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  projectId: "default"
};

const REFUSAL = "This workflow's release gate is enforced: only an admin can delete it";

async function chooseDelete() {
  const heading = await screen.findByRole("heading", { name: "Gated flow" });
  const card = heading.closest("article") as HTMLElement;
  fireEvent.click(within(card).getByRole("button", { name: "More actions for Gated flow" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
}

describe("Delete with an enforced release gate", () => {
  let confirmSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    fetchWorkflowsMock.mockResolvedValue([item]);
    fetchReleaseStateMock.mockReset();
    deleteWorkflowMock.mockReset();
    deleteWorkflowMock.mockResolvedValue(undefined);
    confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
  });

  afterEach(() => confirmSpy.mockRestore());

  const asRole = (role: string) => fetchAuthMeMock.mockResolvedValue({ user: { id: "u1", email: "u@example.com", role } });

  it("tells a builder why, without the confirm, when the gate is on and enforced", async () => {
    asRole("builder");
    fetchReleaseStateMock.mockResolvedValue({ state: { gateEnabled: true, gateEnforced: true } });
    render(<App />);
    await chooseDelete();
    expect(await screen.findByText(REFUSAL)).toBeTruthy();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(deleteWorkflowMock).not.toHaveBeenCalled();
  });

  it("confirms for a builder when the gate is off, even if flagged enforced", async () => {
    asRole("builder");
    fetchReleaseStateMock.mockResolvedValue({ state: { gateEnabled: false, gateEnforced: true } });
    render(<App />);
    await chooseDelete();
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(REFUSAL)).toBeNull();
  });

  it("goes straight to the confirm for an admin without reading the release state", async () => {
    asRole("admin");
    render(<App />);
    await chooseDelete();
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    expect(fetchReleaseStateMock).not.toHaveBeenCalled();
  });

  it("falls back to the confirm when the release state cannot be read", async () => {
    asRole("builder");
    fetchReleaseStateMock.mockRejectedValue(new Error("network"));
    render(<App />);
    await chooseDelete();
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(REFUSAL)).toBeNull();
  });
});
