import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WorkflowListItem } from "@ai-orchestrator/shared";
import { vi } from "vitest";
import type { ExecutionHistoryDetail, ExecutionHistorySummary } from "../lib/api";
import { ExecutionHistoryPanel } from "./ExecutionHistoryPanel";

function makeWorkflowList(): WorkflowListItem[] {
  return [
    {
      id: "wf-1",
      name: "Workflow 1",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }
  ];
}

function makeSummary(overrides: Partial<ExecutionHistorySummary> = {}): ExecutionHistorySummary {
  return {
    id: "ex-1",
    workflowId: "wf-1",
    workflowName: "Workflow 1",
    status: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    durationMs: null,
    triggerType: "manual",
    triggeredBy: "admin@example.com",
    customData: {},
    error: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function makeProps(overrides: Partial<Parameters<typeof ExecutionHistoryPanel>[0]> = {}): Parameters<typeof ExecutionHistoryPanel>[0] {
  const detail: ExecutionHistoryDetail = {
    ...makeSummary(),
    input: { user_prompt: "hello" },
    output: { result: "hello" },
    nodeResults: [{ nodeId: "n1", status: "success", durationMs: 12 }]
  };

  return {
    executionHistoryTotal: 0,
    executionsLoading: false,
    executionsError: null,
    executionHistoryItems: [],
    workflowList: makeWorkflowList(),
    filters: { status: "", workflowId: "", startedFrom: "", startedTo: "" },
    expandedExecutionIds: [],
    executionDetailById: { "ex-1": detail },
    statusColors: { running: "#aaa", success: "#0a0", error: "#a00", partial: "#aa0", canceled: "#888" },
    onFiltersChange: vi.fn(),
    onRefresh: vi.fn(),
    onToggleRow: vi.fn(),
    onDebugExecution: vi.fn(),
    onRerunExecution: vi.fn(),
    onCancelExecution: vi.fn(),
    ...overrides
  };
}

describe("ExecutionHistoryPanel", () => {
  it("shows empty state when no executions are present", () => {
    render(<ExecutionHistoryPanel {...makeProps()} />);
    expect(screen.getByText("No executions yet. Run a workflow from the editor to populate history.")).toBeInTheDocument();
  });

  it("shows error banner when API error exists", () => {
    render(<ExecutionHistoryPanel {...makeProps({ executionsError: "Failed to fetch executions" })} />);
    expect(screen.getByText("Failed to fetch executions")).toBeInTheDocument();
  });

  it("invokes debug and cancel actions from row buttons", async () => {
    const user = userEvent.setup();
    const onDebugExecution = vi.fn();
    const onCancelExecution = vi.fn();

    render(
      <ExecutionHistoryPanel
        {...makeProps({
          executionHistoryTotal: 1,
          executionHistoryItems: [makeSummary()],
          onDebugExecution,
          onCancelExecution
        })}
      />
    );

    await user.click(screen.getByRole("button", { name: "Debug" }));
    expect(onDebugExecution).toHaveBeenCalledWith("ex-1");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancelExecution).toHaveBeenCalledWith("ex-1");
  });
});
