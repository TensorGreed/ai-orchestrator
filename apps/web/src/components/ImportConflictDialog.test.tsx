import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { diffWorkflows } from "@ai-orchestrator/shared";
import { diffSummaryLines, ImportConflictDialog } from "./ImportConflictDialog";

const position = { x: 0, y: 0 };
const stored = {
  nodes: [
    { id: "in", type: "text_input", name: "Input", position, config: {} },
    { id: "out", type: "output", name: "Output", position, config: {} }
  ],
  edges: [{ id: "e1", source: "in", target: "out" }]
};
const file = {
  nodes: [
    { id: "in", type: "text_input", name: "Input", position, config: { text: "changed" } },
    { id: "set", type: "set_node", name: "Set", position, config: {} }
  ],
  edges: [{ id: "e2", source: "in", target: "set" }]
};

describe("ImportConflictDialog", () => {
  it("defaults to importing as new and confirms that choice", async () => {
    const onConfirm = vi.fn();
    render(
      <ImportConflictDialog
        fileName="rag-flow.json"
        importedName="RAG Flow"
        existing={{ id: "wf-rag-flow", name: "RAG Flow", updatedAt: null }}
        diff={diffWorkflows(stored, file)}
        onConfirm={onConfirm}
        onClose={() => undefined}
      />
    );
    expect(screen.getByRole("radio", { name: /Import as a new workflow/ })).toBeChecked();
    expect(screen.queryByText(/What the replace changes/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Import as new" }));
    expect(onConfirm).toHaveBeenCalledWith("new");
  });

  it("shows what a replace changes and needs the replace button", async () => {
    const onConfirm = vi.fn();
    render(
      <ImportConflictDialog
        importedName="RAG Flow"
        existing={{ id: "wf-rag-flow", name: "RAG Flow", updatedAt: null }}
        diff={diffWorkflows(stored, file)}
        onConfirm={onConfirm}
        onClose={() => undefined}
      />
    );
    await userEvent.click(screen.getByRole("radio", { name: /Replace RAG Flow/ }));
    expect(screen.getByText("1 node added: Set")).toBeInTheDocument();
    expect(screen.getByText("1 node removed: Output")).toBeInTheDocument();
    expect(screen.getByText("1 node changed: Input")).toBeInTheDocument();
    expect(screen.getByText("1 connection added")).toBeInTheDocument();
    expect(screen.getByText("1 connection removed")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Replace RAG Flow" }));
    expect(onConfirm).toHaveBeenCalledWith("replace");
  });

  it("says when the file matches the saved workflow, and closes on Escape", async () => {
    const onClose = vi.fn();
    render(
      <ImportConflictDialog
        importedName="RAG Flow"
        existing={{ id: "wf-rag-flow", name: "RAG Flow", updatedAt: null }}
        diff={diffWorkflows(stored, stored)}
        onConfirm={() => undefined}
        onClose={onClose}
      />
    );
    await userEvent.click(screen.getByRole("radio", { name: /Replace RAG Flow/ }));
    expect(screen.getByText(/the file matches the saved workflow/)).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("caps long name lists", () => {
    const many = { nodes: Array.from({ length: 7 }, (_, index) => ({ id: `n${index}`, type: "set_node", name: `N${index}`, position, config: {} })), edges: [] };
    expect(diffSummaryLines(diffWorkflows({ nodes: [], edges: [] }, many))[0]).toBe("7 nodes added: N0, N1, N2, N3, N4 and 2 more");
  });
});
