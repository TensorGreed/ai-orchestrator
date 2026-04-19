import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import type { Node } from "reactflow";
import type { EditorNodeData } from "../lib/workflow";
import { NodeConfigModal } from "./NodeConfigModal";

function makeNode(): Node<EditorNodeData> {
  return {
    id: "node-1",
    type: "workflowNode",
    position: { x: 100, y: 120 },
    data: {
      label: "User Prompt",
      nodeType: "user_prompt",
      config: {
        text: "What should I help with?"
      }
    }
  };
}

function makeProps(overrides: Partial<Parameters<typeof NodeConfigModal>[0]> = {}): Parameters<typeof NodeConfigModal>[0] {
  return {
    node: makeNode(),
    inputOptions: [],
    executionResult: null,
    workflowContext: { id: "wf-1", name: "Workflow 1", vars: {} },
    pinnedData: {},
    showRuntimeInspection: false,
    secrets: [],
    onRefreshSecrets: vi.fn(),
    mcpServerDefinitions: [],
    onClose: vi.fn(),
    onSave: vi.fn(),
    onExecuteStep: vi.fn(),
    onPinNodeOutput: vi.fn(),
    onUnpinNodeOutput: vi.fn(),
    ...overrides
  };
}

describe("NodeConfigModal", () => {
  it("saves updated user prompt text", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();

    render(<NodeConfigModal {...makeProps({ onSave })} />);

    const textArea = screen.getByLabelText("Text");
    await user.clear(textArea);
    await user.type(textArea, "Updated prompt for test");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "User Prompt",
        config: expect.objectContaining({
          text: "Updated prompt for test"
        })
      })
    );
  });

  it("closes modal when cancel is clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(<NodeConfigModal {...makeProps({ onClose })} />);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
