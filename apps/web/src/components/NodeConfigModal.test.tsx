import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, vi } from "vitest";
import type { Node } from "reactflow";
import type { EditorNodeData } from "../lib/workflow";
import * as api from "../lib/api";
import { NodeConfigModal } from "./NodeConfigModal";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchProviderModels: vi.fn()
  };
});

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
  beforeEach(() => {
    vi.resetAllMocks();
  });

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

  it("loads model options for AI gateway chat models", async () => {
    vi.mocked(api.fetchProviderModels).mockResolvedValue({
      models: [{ id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" }]
    });

    render(
      <NodeConfigModal
        {...makeProps({
          node: {
            id: "gateway-model",
            type: "workflowNode",
            position: { x: 100, y: 120 },
            data: {
              label: "AI Gateway",
              nodeType: "ai_gateway_chat_model",
              config: {
                apiProvider: "anthropic",
                baseUrl: "https://llm.company.example/v1",
                secretRef: { secretId: "secret-gateway" },
                model: ""
              }
            }
          },
          secrets: [
            {
              id: "secret-gateway",
              name: "Corporate Gateway",
              provider: "anthropic",
              createdAt: "2026-01-01T00:00:00.000Z"
            }
          ]
        })}
      />
    );

    await waitFor(() => {
      expect(api.fetchProviderModels).toHaveBeenCalledWith({
        providerId: "anthropic",
        secretRef: { secretId: "secret-gateway" },
        baseUrl: "https://llm.company.example/v1"
      });
    });
    expect(await screen.findByRole("option", { name: "Claude Haiku 4.5" })).toBeInTheDocument();
  });
});
