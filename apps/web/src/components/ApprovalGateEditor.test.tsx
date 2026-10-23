import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReactFlowProvider, type NodeProps } from "reactflow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowListItem } from "@ai-orchestrator/shared";
import * as api from "../lib/api";
import type { ExecutionHistorySummary } from "../lib/api";
import { summarizeNode } from "../lib/stages";
import type { EditorNodeData } from "../lib/workflow";
import { AppSidebar } from "./AppSidebar";
import { ApprovalGateNodeFields, approvalGateConfigIssues } from "./ApprovalGateNodeFields";
import { ExecutionHistoryPanel } from "./ExecutionHistoryPanel";
import { WorkflowCanvasNode } from "./WorkflowCanvasNode";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, fetchMcpElicitations: vi.fn() };
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.fetchMcpElicitations).mockResolvedValue({ items: [] });
});

function renderGate(config: Record<string, unknown> = {}) {
  const props = {
    id: "gate",
    type: "workflowNode",
    selected: false,
    zIndex: 0,
    isConnectable: true,
    xPos: 0,
    yPos: 0,
    dragging: false,
    data: { label: "Approval Gate", nodeType: "approval_gate", config } as EditorNodeData
  } as NodeProps<EditorNodeData>;
  return render(
    <ReactFlowProvider>
      <WorkflowCanvasNode {...props} />
    </ReactFlowProvider>
  );
}

function Fields({ initial, onChange }: { initial: Record<string, unknown>; onChange: (config: Record<string, unknown>) => void }) {
  const [config, setConfigState] = useState(initial);
  return (
    <ApprovalGateNodeFields
      config={config}
      setConfig={(update) =>
        setConfigState((current) => {
          const next = update(current);
          onChange(next);
          return next;
        })
      }
    />
  );
}

describe("Approval Gate in the editor", () => {
  it("has approved, rejected and timed out outputs on the canvas", () => {
    const { container } = renderGate({ approverRoles: ["admin"], timeoutMinutes: 120 });
    for (const label of ["Approved", "Rejected", "Timed out"]) expect(screen.getByText(label)).toBeInTheDocument();
    for (const id of ["approved", "rejected", "timed_out"]) expect(container.querySelector(`[data-handleid="${id}"]`)).not.toBeNull();
    expect(screen.getByText("admin · 2 h")).toBeInTheDocument();
  });

  it("summarises approvers, timeout and editable fields", () => {
    expect(summarizeNode({ type: "approval_gate", config: {} })).toBe("any operator · 24 h");
    expect(summarizeNode({ type: "approval_gate", config: { approverUsers: ["a@x.io"], timeoutMinutes: 45, editableFields: [{ key: "a" }] } })).toBe(
      "1 user · 45 min · 1 editable"
    );
  });

  it("reports config problems with the shared schema", () => {
    expect(approvalGateConfigIssues({})).toEqual([]);
    const issues = approvalGateConfigIssues({ editableFields: [{ key: "approved", type: "string" }, { key: "1bad", type: "string" }] });
    expect(issues[0]).toMatch(/^editableFields › field 1 › key: /);
    expect(issues[1]).toMatch(/^editableFields › field 2 › key: /);
  });

  it("edits roles, users, timeout and editable fields", async () => {
    const onChange = vi.fn();
    render(<Fields initial={{}} onChange={onChange} />);
    const last = () => onChange.mock.calls.at(-1)?.[0] as Record<string, unknown>;

    await userEvent.click(screen.getByRole("checkbox", { name: "operator" }));
    expect(last().approverRoles).toEqual(["operator"]);

    await userEvent.type(screen.getByLabelText("Approver users"), "ops@example.com\nlead@example.com");
    expect(last().approverUsers).toEqual(["ops@example.com", "lead@example.com"]);

    const timeout = screen.getByLabelText("Timeout (minutes)");
    await userEvent.clear(timeout);
    await userEvent.type(timeout, "99999");
    expect(last().timeoutMinutes).toBe(43_200);

    await userEvent.selectOptions(screen.getByLabelText("When nobody decides in time"), "fallback");
    expect(last().timeoutOutcome).toBe("fallback");

    await userEvent.click(screen.getByRole("button", { name: "Add field" }));
    const key = screen.getByLabelText("Key");
    await userEvent.clear(key);
    await userEvent.type(key, "approval");
    await userEvent.selectOptions(screen.getByLabelText("Type"), "number");
    await userEvent.click(screen.getByRole("checkbox", { name: "Required" }));
    expect(last().editableFields).toEqual([{ key: "approval", type: "number", required: true }]);
    expect(screen.getByRole("alert")).toHaveTextContent(/set by the gate itself/);

    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(last().editableFields).toEqual([]);
  });
});

describe("Approvals around the editor", () => {
  it("links a waiting run to the Approvals inbox", async () => {
    const onReview = vi.fn();
    const item: ExecutionHistorySummary = {
      id: "ex-wait",
      workflowId: "wf-1",
      workflowName: "Refunds",
      status: "waiting_approval",
      startedAt: "2026-10-23T10:00:00.000Z",
      completedAt: null,
      durationMs: null,
      triggerType: "manual",
      triggeredBy: "builder@example.com",
      customData: {},
      error: null,
      createdAt: "2026-10-23T10:00:00.000Z"
    };
    render(
      <ExecutionHistoryPanel
        executionHistoryTotal={1}
        executionsLoading={false}
        executionsError={null}
        executionHistoryItems={[item, { ...item, id: "ex-done", status: "success" }]}
        workflowList={[{ id: "wf-1", name: "Refunds", schemaVersion: "1.0.0", workflowVersion: 1, createdAt: "", updatedAt: "" } as WorkflowListItem]}
        filters={{ status: "", workflowId: "", startedFrom: "", startedTo: "" }}
        expandedExecutionIds={[]}
        executionDetailById={{}}
        statusColors={{}}
        onFiltersChange={vi.fn()}
        onRefresh={vi.fn()}
        onToggleRow={vi.fn()}
        onDebugExecution={vi.fn()}
        onRerunExecution={vi.fn()}
        onCancelExecution={vi.fn()}
        onReviewApproval={onReview}
      />
    );
    const buttons = screen.getAllByRole("button", { name: "Review approval" });
    expect(buttons).toHaveLength(1);
    await userEvent.click(buttons[0]!);
    expect(onReview).toHaveBeenCalledWith("ex-wait");
  });

  it("shows the pending count on the Approvals item", () => {
    render(<AppSidebar activeMode="dashboard" canManageSecrets={false} onModeChange={vi.fn()} badges={{ approvals: 3 }} />);
    const item = screen.getByRole("button", { name: /Approvals/ });
    expect(item).toHaveTextContent("3");
    expect(item).toHaveAttribute("title", "Approvals (3 waiting)");
  });
});
