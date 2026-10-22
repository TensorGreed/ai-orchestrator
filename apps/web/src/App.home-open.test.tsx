import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { vi } from "vitest";
import type { Workflow, WorkflowListItem } from "@ai-orchestrator/shared";
import App from "./App";

const fetchAuthMeMock = vi.fn();
const fetchWorkflowsMock = vi.fn();
const fetchWorkflowMock = vi.fn();

vi.mock("./lib/api", async () => {
  const actual = await vi.importActual<typeof import("./lib/api")>("./lib/api");
  return {
    ...actual,
    fetchAuthMe: (...args: unknown[]) => fetchAuthMeMock(...args),
    fetchWorkflows: (...args: unknown[]) => fetchWorkflowsMock(...args),
    fetchWorkflow: (...args: unknown[]) => fetchWorkflowMock(...args)
  };
});

const listItem = (id: string, name: string): WorkflowListItem => ({
  id,
  name,
  schemaVersion: "1.0.0",
  workflowVersion: 1,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  projectId: "default"
});

const fullWorkflow = (id: string, name: string): Workflow =>
  ({ ...listItem(id, name), nodes: [], edges: [] }) as unknown as Workflow;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Home Open", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    fetchAuthMeMock.mockResolvedValue({ user: { id: "u1", email: "admin@example.com", role: "admin" } });
    fetchWorkflowsMock.mockResolvedValue([listItem("wf-first", "First flow"), listItem("wf-second", "Second flow")]);
    fetchWorkflowMock.mockReset();
  });

  it("opens the clicked workflow even when another load is slower", async () => {
    const pending = new Map<string, ReturnType<typeof deferred<Workflow>>>();
    fetchWorkflowMock.mockImplementation((id: string) => {
      const entry = deferred<Workflow>();
      pending.set(id, entry);
      return entry.promise;
    });

    render(<App />);

    const heading = await screen.findByRole("heading", { name: "Second flow" });
    const card = heading.closest("article") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Open" }));

    await waitFor(() => expect(pending.has("wf-second")).toBe(true));
    await act(async () => {
      pending.get("wf-second")!.resolve(fullWorkflow("wf-second", "Second flow"));
    });
    await act(async () => {
      pending.get("wf-first")?.resolve(fullWorkflow("wf-first", "First flow"));
    });

    await waitFor(() => expect(new URLSearchParams(window.location.search).get("workflowId")).toBe("wf-second"));
    expect(fetchWorkflowMock).not.toHaveBeenCalledWith("wf-first");
  });
});
