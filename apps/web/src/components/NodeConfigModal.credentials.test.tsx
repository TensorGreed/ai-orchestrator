import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Node } from "reactflow";
import { nodeDefinitions } from "@ai-orchestrator/shared";
import type { EditorNodeData } from "../lib/workflow";
import { NodeInspector } from "./NodeConfigModal";

const secret = { id: "secret-1", name: "Team Secret", provider: "custom", createdAt: "2026-01-01T00:00:00.000Z" };

function propsFor(nodeType: string, config: Record<string, unknown>, onSave = vi.fn()) {
  const node: Node<EditorNodeData> = {
    id: "n1",
    type: "workflowNode",
    position: { x: 0, y: 0 },
    data: { label: "Node", nodeType: nodeType as EditorNodeData["nodeType"], config }
  };
  return {
    node,
    inputOptions: [],
    executionResult: null,
    workflowContext: { id: "wf-1", name: "Workflow 1", vars: {} },
    pinnedData: {},
    showRuntimeInspection: false,
    secrets: [secret],
    onRefreshSecrets: vi.fn(),
    mcpServerDefinitions: [],
    onClose: vi.fn(),
    onSave,
    onExecuteStep: vi.fn(),
    onPinNodeOutput: vi.fn(),
    onUnpinNodeOutput: vi.fn()
  } as Parameters<typeof NodeInspector>[0];
}

const credentialNodes = nodeDefinitions.filter((definition) => (definition.credentials ?? []).length > 0);

describe("NodeInspector credential pickers", () => {
  it("covers a meaningful set of node types", () => {
    expect(credentialNodes.length).toBeGreaterThanOrEqual(25);
  });

  it("shows a required secret picker with a hint for google_calendar_create_event", () => {
    render(<NodeInspector {...propsFor("google_calendar_create_event", {})} />);
    expect(screen.getByLabelText("Google Access Token Secret (required)")).toBeInTheDocument();
    expect(screen.getByText(/Google OAuth access token/)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("A credential is required");
    expect(screen.getByLabelText("Calendar Id (required)")).toBeInTheDocument();
  });

  it.each(credentialNodes.flatMap((definition) => definition.credentials!.map((spec) => [definition.type, spec] as const)))(
    "%s exposes a picker for %j that writes secretRef",
    async (type, spec) => {
      const user = userEvent.setup();
      const onSave = vi.fn();
      render(<NodeInspector {...propsFor(type, {}, onSave)} />);
      const label = spec.required ? `${spec.label} (required)` : spec.label;
      await user.selectOptions(screen.getByLabelText(label), "secret-1");
      await user.click(screen.getByRole("button", { name: "Save changes" }));
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ config: expect.objectContaining({ [spec.key]: { secretId: "secret-1" } }) })
      );
    }
  );

  it("never renders the secret value, only its name", () => {
    render(<NodeInspector {...propsFor("twilio_send_sms", { secretRef: { secretId: "secret-1" } })} />);
    expect(screen.getByRole("option", { name: "Team Secret (custom)" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
