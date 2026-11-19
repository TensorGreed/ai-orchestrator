import { render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import App from "./App";

const fetchAuthMeMock = vi.fn();
const fetchWorkflowsMock = vi.fn();
const fetchProjectsMock = vi.fn();
const fetchWorkflowsSharedWithMeMock = vi.fn();
const fetchProjectSharedWorkflowsMock = vi.fn();

vi.mock("./lib/api", async () => {
  const actual = await vi.importActual<typeof import("./lib/api")>("./lib/api");
  return {
    ...actual,
    fetchAuthMe: (...args: unknown[]) => fetchAuthMeMock(...args),
    fetchWorkflows: (...args: unknown[]) => fetchWorkflowsMock(...args),
    fetchProjects: (...args: unknown[]) => fetchProjectsMock(...args),
    fetchWorkflowsSharedWithMe: (...args: unknown[]) => fetchWorkflowsSharedWithMeMock(...args),
    fetchProjectSharedWorkflows: (...args: unknown[]) => fetchProjectSharedWorkflowsMock(...args)
  };
});

const project = { id: "default", name: "Default Project", description: "", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" };

describe("the lists Home loads", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.localStorage.setItem("l2m:welcome-dismissed", "1");
    window.history.replaceState(null, "", "/");
    fetchWorkflowsMock.mockReset().mockResolvedValue([]);
    fetchWorkflowsSharedWithMeMock.mockReset().mockResolvedValue({
      workflows: [{ id: "wf-shared", name: "Shared intake", projectId: "team", accessLevel: "execute", effectiveAccess: "execute", updatedAt: "2026-10-01T00:00:00.000Z" }]
    });
    fetchProjectSharedWorkflowsMock.mockReset().mockResolvedValue({ workflows: [] });
  });

  it("does not ask what is shared with a project when the person is in none (share-only access)", async () => {
    fetchAuthMeMock.mockResolvedValue({ user: { id: "u2", email: "olive@example.com", role: "operator" } });
    fetchProjectsMock.mockReset().mockResolvedValue({ projects: [] });
    render(<App />);
    expect(await screen.findByText("You are not a member of any project yet")).toBeInTheDocument();
    await waitFor(() => expect(fetchWorkflowsSharedWithMeMock).toHaveBeenCalled());
    expect(fetchProjectSharedWorkflowsMock).not.toHaveBeenCalled();
  });

  it("still asks for a project the person is in", async () => {
    fetchAuthMeMock.mockResolvedValue({ user: { id: "u1", email: "admin@example.com", role: "admin" } });
    fetchProjectsMock.mockReset().mockResolvedValue({ projects: [project] });
    render(<App />);
    await waitFor(() => expect(fetchProjectSharedWorkflowsMock).toHaveBeenCalledWith("default"));
  });
});
