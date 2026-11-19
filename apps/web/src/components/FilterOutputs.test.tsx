import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReactFlowProvider, type NodeProps } from "reactflow";
import type { EditorNodeData } from "../lib/workflow";
import { CanvasInsertContext } from "./canvas-insert-context";
import { WorkflowCanvasNode } from "./WorkflowCanvasNode";

function renderFilter(config: Record<string, unknown>, connected: Array<string | null> = []) {
  const props = {
    id: "f",
    type: "workflowNode",
    selected: false,
    zIndex: 0,
    isConnectable: true,
    xPos: 0,
    yPos: 0,
    dragging: false,
    data: { label: "Filter", nodeType: "filter_node", config } as EditorNodeData
  } as NodeProps<EditorNodeData>;
  const actions = { onAddAfter: () => undefined, isConnected: (_node: string, handle: string | null) => connected.includes(handle) };
  return render(
    <ReactFlowProvider>
      <CanvasInsertContext.Provider value={actions}>
        <WorkflowCanvasNode {...props} />
      </CanvasInsertContext.Provider>
    </ReactFlowProvider>
  );
}

describe("Filter outputs on the canvas", () => {
  it("Pass or stop: Pass and Stopped", () => {
    const { container } = renderFilter({});
    expect(screen.getByText("Pass")).toBeInTheDocument();
    expect(screen.getByText("Stopped")).toBeInTheDocument();
    for (const id of ["pass", "filtered"]) expect(container.querySelector(`[data-handleid="${id}"]`)).not.toBeNull();
  });

  it("Items mode: Kept and Rejected", () => {
    renderFilter({ mode: "items" });
    expect(screen.getByText("Kept")).toBeInTheDocument();
    expect(screen.getByText("Rejected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add a node after the Rejected output" })).toBeInTheDocument();
  });

  it("an edge saved without a handle counts as connected on Pass", () => {
    renderFilter({}, [null]);
    expect(screen.getByRole("button", { name: "Add a node after the Pass output" })).toHaveClass("wf-handle-add-connected");
    expect(screen.getByRole("button", { name: "Add a node after the Stopped output" })).not.toHaveClass("wf-handle-add-connected");
  });
});
