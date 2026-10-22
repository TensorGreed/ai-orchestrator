import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReactFlowProvider, type NodeProps } from "reactflow";
import { describe, expect, it, vi } from "vitest";
import type { EditorNodeData } from "../lib/workflow";
import { WorkflowCanvasNode } from "./WorkflowCanvasNode";

function renderGuard(data: Partial<EditorNodeData>) {
  const props = {
    id: "g1",
    type: "workflowNode",
    selected: false,
    zIndex: 0,
    isConnectable: true,
    xPos: 0,
    yPos: 0,
    dragging: false,
    data: { label: "Guard", nodeType: "guard", config: { profileId: "effective", channel: "prompt" }, ...data } as EditorNodeData
  } as NodeProps<EditorNodeData>;
  return render(
    <ReactFlowProvider>
      <WorkflowCanvasNode {...props} />
    </ReactFlowProvider>
  );
}

describe("Guard node on the canvas", () => {
  it("has pass, blocked and review outputs and an empty protection slot", async () => {
    const onOpen = vi.fn();
    const { container } = renderGuard({ onOpenAgentAttachmentDrawer: onOpen });
    expect(screen.getByText("Pass")).toBeInTheDocument();
    expect(screen.getByText("Blocked")).toBeInTheDocument();
    expect(screen.getByText("Review")).toBeInTheDocument();
    for (const id of ["pass", "blocked", "review", "protection"]) {
      expect(container.querySelector(`[data-handleid="${id}"]`)).not.toBeNull();
    }
    await userEvent.click(screen.getByRole("button", { name: /Add protection/ }));
    expect(onOpen).toHaveBeenCalledWith("protection");
  });

  it("hides the protection slot once a provider is attached", () => {
    renderGuard({ slots: { chat_model: [], memory: [], tool: [], worker: [], protection: ["vault"], carrier: "guard" } });
    expect(screen.queryByRole("button", { name: /Add protection/ })).toBeNull();
  });
});
