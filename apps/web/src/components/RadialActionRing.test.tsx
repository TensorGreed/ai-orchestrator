import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EditorNode } from "../lib/workflow";
import { RadialActionRing } from "./RadialActionRing";

const node = { id: "agent", type: "workflowNode", position: { x: 0, y: 0 }, data: { label: "Agent", nodeType: "agent_orchestrator", config: {} } } as EditorNode;

describe("RadialActionRing", () => {
  it("offers only Edit on a view-only workflow", () => {
    const onAction = vi.fn();
    render(<RadialActionRing node={node} center={{ x: 100, y: 100 }} onAction={onAction} readOnly />);
    expect(screen.queryByRole("button", { name: "Delete (Del)" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Duplicate (Ctrl+D)" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit (Enter)" }), { detail: 1 });
    expect(onAction).toHaveBeenCalledWith({ kind: "edit" });
  });

  it("acts on a single click", () => {
    const onAction = vi.fn();
    render(<RadialActionRing node={node} center={{ x: 100, y: 100 }} onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete (Del)" }), { detail: 1 });
    expect(onAction).toHaveBeenCalledWith({ kind: "delete" });
  });

  it("ignores the second click of a double-click: the ring appeared under the pointer after the first click selected the node", () => {
    const onAction = vi.fn();
    render(<RadialActionRing node={node} center={{ x: 100, y: 100 }} onAction={onAction} />);
    for (const name of ["Delete (Del)", "Duplicate (Ctrl+D)", "Disable (E)", "Edit (Enter)"]) {
      fireEvent.click(screen.getByRole("button", { name }), { detail: 2 });
    }
    expect(onAction).not.toHaveBeenCalled();
  });

  it("opens the node when a double-click ends on the ring, as a double-click on the node does", () => {
    const onAction = vi.fn();
    render(<RadialActionRing node={node} center={{ x: 100, y: 100 }} onAction={onAction} />);
    const remove = screen.getByRole("button", { name: "Delete (Del)" });
    fireEvent.click(remove, { detail: 2 });
    fireEvent.doubleClick(remove);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith({ kind: "edit" });
  });
});
