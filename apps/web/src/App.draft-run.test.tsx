import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { vi } from "vitest";
import type { Workflow, WorkflowListItem } from "@ai-orchestrator/shared";
import App from "./App";

const fetchAuthMeMock = vi.fn();
const fetchWorkflowsMock = vi.fn();
const fetchWorkflowMock = vi.fn();
const fetchExecutionsMock = vi.fn();
const fetchExecutionByIdMock = vi.fn();
const saveWorkflowMock = vi.fn();
const validateStoredWorkflowMock = vi.fn();
const runWebhookStreamMock = vi.fn();

vi.mock("./lib/api", async () => {
  const actual = await vi.importActual<typeof import("./lib/api")>("./lib/api");
  return {
    ...actual,
    fetchAuthMe: (...args: unknown[]) => fetchAuthMeMock(...args),
    fetchWorkflows: (...args: unknown[]) => fetchWorkflowsMock(...args),
    fetchWorkflow: (...args: unknown[]) => fetchWorkflowMock(...args),
    fetchExecutions: (...args: unknown[]) => fetchExecutionsMock(...args),
    fetchExecutionById: (...args: unknown[]) => fetchExecutionByIdMock(...args),
    saveWorkflow: (...args: unknown[]) => saveWorkflowMock(...args),
    validateStoredWorkflow: (...args: unknown[]) => validateStoredWorkflowMock(...args),
    runWebhookStream: (...args: unknown[]) => runWebhookStreamMock(...args)
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

const hookWorkflow = (settings?: Workflow["settings"]): Workflow =>
  ({
    ...listItem("wf-hook", "Orders hook"),
    nodes: [
      { id: "hook", type: "webhook_input", name: "Orders hook", position: { x: 100, y: 100 }, config: { path: "orders", method: "POST" } },
      { id: "set", type: "set_node", name: "Order line", position: { x: 400, y: 100 }, config: { assignments: [{ key: "line", valueTemplate: "{{webhook.customer}}" }] } }
    ],
    edges: [{ id: "e1", source: "hook", target: "set" }],
    ...(settings ? { settings } : {})
  }) as unknown as Workflow;

const finishedRun = {
  id: "ex-1",
  workflowId: "wf-hook",
  status: "success",
  triggerType: "webhook_api_stream",
  startedAt: "2026-11-18T10:00:00.000Z",
  completedAt: "2026-11-18T10:00:01.500Z",
  durationMs: 1500
};

function openEditorOn(workflowId: string) {
  window.history.replaceState(null, "", `/?workflowId=${workflowId}&mode=editor`);
}

describe("editor drafts and run feedback", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.localStorage.setItem("l2m:welcome-dismissed", "1");
    window.history.replaceState(null, "", "/");
    fetchAuthMeMock.mockResolvedValue({ user: { id: "u1", email: "admin@example.com", role: "admin" } });
    fetchWorkflowsMock.mockResolvedValue([listItem("wf-hook", "Orders hook")]);
    fetchWorkflowMock.mockReset().mockResolvedValue(hookWorkflow());
    fetchExecutionsMock.mockReset().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 1 });
    fetchExecutionByIdMock.mockReset();
    saveWorkflowMock.mockReset().mockImplementation(async (workflow: Workflow) => ({ ...workflow, updatedAt: new Date().toISOString() }));
    validateStoredWorkflowMock.mockReset().mockResolvedValue({ valid: true, issues: [] });
    runWebhookStreamMock.mockReset();
  });

  it("shows the latest run's status and data when a workflow is opened", async () => {
    fetchExecutionsMock.mockResolvedValue({ items: [finishedRun], total: 1, page: 1, pageSize: 1 });
    fetchExecutionByIdMock.mockResolvedValue({
      ...finishedRun,
      nodeResults: [
        { nodeId: "hook", status: "success", startedAt: finishedRun.startedAt, completedAt: finishedRun.startedAt, output: {} },
        { nodeId: "set", status: "success", startedAt: finishedRun.startedAt, completedAt: finishedRun.completedAt, output: { line: "Ana" } }
      ],
      output: { line: "Ana" }
    });
    openEditorOn("wf-hook");
    render(<App />);

    const runLabel = () => document.querySelector(".hud-run-label")?.textContent ?? "";
    await waitFor(() => expect(runLabel()).toBe("last run 1.5 s · 2 ok"), { timeout: 4000 });
    expect(screen.queryByRole("option", { name: "No run loaded" })).not.toBeInTheDocument();
  });

  it("does not save a new workflow until its first edit", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Orders hook" });
    fireEvent.click(await screen.findByRole("button", { name: "New workflow" }));

    const name = await screen.findByLabelText("Workflow name");
    expect(name).toHaveValue("Workflow 2");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(saveWorkflowMock).not.toHaveBeenCalled();
    // It stays open: nothing loads another workflow over it.
    expect(fetchWorkflowMock).not.toHaveBeenCalled();

    fireEvent.change(name, { target: { value: "Order intake" } });
    await waitFor(() => expect(saveWorkflowMock).toHaveBeenCalledTimes(1));
    expect((saveWorkflowMock.mock.calls[0]![0] as Workflow).name).toBe("Order intake");
  });

  it("asks for the webhook test payload, refuses credentials, and runs with it", async () => {
    runWebhookStreamMock.mockResolvedValue({
      workflowId: "wf-hook",
      status: "success",
      startedAt: finishedRun.startedAt,
      completedAt: finishedRun.completedAt,
      nodeResults: []
    });
    fetchWorkflowMock.mockResolvedValue(hookWorkflow({ testWebhookPayload: { customer: "Bo" } }));
    openEditorOn("wf-hook");
    render(<App />);

    await waitFor(() => expect(screen.getByLabelText("Workflow name")).toHaveValue("Orders hook"));
    const webhookRun = await screen.findByRole("button", { name: "Webhook run" });
    await waitFor(() => expect(webhookRun).toBeEnabled());
    fireEvent.click(webhookRun);
    const dialog = await screen.findByRole("dialog", { name: "Webhook run" });
    const field = within(dialog).getByLabelText("Test payload (JSON)");
    expect(field).toHaveValue(JSON.stringify({ customer: "Bo" }, null, 2));

    fireEvent.change(field, { target: { value: '{"customer": "Ana", "password": "hunter2"}' } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Run" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("cannot hold credentials");
    expect(runWebhookStreamMock).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: '{"customer": "Ana"}' } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Run" }));
    await waitFor(() => expect(runWebhookStreamMock).toHaveBeenCalledTimes(1));
    expect(runWebhookStreamMock.mock.calls[0]![0]).toMatchObject({ workflow_id: "wf-hook", payload: { customer: "Ana" } });
    expect((saveWorkflowMock.mock.calls[0]![0] as Workflow).settings?.testWebhookPayload).toEqual({ customer: "Ana" });
    expect(screen.queryByRole("dialog", { name: "Webhook run" })).not.toBeInTheDocument();
  });

  it("shows a saved draft's unfinished settings as warnings", async () => {
    validateStoredWorkflowMock.mockResolvedValue({
      valid: false,
      issues: [{ code: "missing_http_request_url_template", message: "HTTP Request node requires a non-empty urlTemplate.", nodeId: "set" }]
    });
    openEditorOn("wf-hook");
    render(<App />);
    const notice = await screen.findByTestId("draft-warnings");
    expect(notice).toHaveTextContent("Saved as a draft");
    expect(within(notice).getByRole("button", { name: "Order line" })).toBeInTheDocument();
  });
});
