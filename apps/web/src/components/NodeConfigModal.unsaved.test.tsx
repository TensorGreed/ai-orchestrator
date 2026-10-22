import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, vi } from "vitest";
import type { Node } from "reactflow";
import type { EditorNodeData } from "../lib/workflow";
import * as api from "../lib/api";
import { NodeInspector, type NodeInspectorHandle } from "./NodeConfigModal";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchProviderModels: vi.fn()
  };
});

function makeAnthropicNode(config: Record<string, unknown> = {}): Node<EditorNodeData> {
  return {
    id: "claude-model",
    type: "workflowNode",
    position: { x: 0, y: 0 },
    data: {
      label: "Anthropic Chat Model",
      nodeType: "anthropic_chat_model",
      config: { model: "claude-sonnet-5-5", maxTokens: 1024, ...config }
    }
  };
}

const anthropicSecrets = [
  { id: "secret-anthropic", name: "Team key", provider: "anthropic", createdAt: "2026-01-01T00:00:00.000Z" }
];

function makeProps(overrides: Partial<Parameters<typeof NodeInspector>[0]> = {}): Parameters<typeof NodeInspector>[0] {
  return {
    node: makeAnthropicNode(),
    inputOptions: [],
    executionResult: null,
    workflowContext: { id: "wf-1", name: "Workflow 1", vars: {} },
    pinnedData: {},
    showRuntimeInspection: false,
    secrets: anthropicSecrets,
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

async function pickSecret(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(screen.getByLabelText("Anthropic API Key"), "secret-anthropic");
}

describe("NodeInspector unsaved changes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.fetchProviderModels).mockResolvedValue({ models: [] });
    try {
      window.localStorage.clear();
    } catch {
      // jsdom storage may be unavailable in some environments
    }
  });

  it("asks before Escape drops unsaved edits, and Save persists the selected secret", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSave = vi.fn();
    render(<NodeInspector {...makeProps({ onClose, onSave })} />);

    await pickSecret(user);
    await user.keyboard("{Escape}");

    expect(screen.getByRole("alertdialog", { name: "Unsaved changes" })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]?.[0].config.secretRef).toEqual({ secretId: "secret-anthropic" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("discards unsaved edits from the × button only when asked to", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSave = vi.fn();
    render(<NodeInspector {...makeProps({ onClose, onSave })} />);

    await pickSecret(user);
    await user.click(screen.getByRole("button", { name: "Close inspector" }));
    await user.click(screen.getByRole("button", { name: "Discard" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("keeps editing from Cancel without closing or saving", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSave = vi.fn();
    render(<NodeInspector {...makeProps({ onClose, onSave })} />);

    await pickSecret(user);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Keep editing" }));

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Anthropic API Key")).toHaveValue("secret-anthropic");
  });

  it("Escape inside the prompt keeps editing", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<NodeInspector {...makeProps({ onClose })} />);

    await pickSecret(user);
    await user.keyboard("{Escape}");
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes straight away when nothing changed", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<NodeInspector {...makeProps({ onClose })} />);

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("lets the host guard a switch to another node through the control handle", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const next = vi.fn();
    const controlRef: { current: NodeInspectorHandle | null } = { current: null };
    render(<NodeInspector {...makeProps({ onClose, controlRef })} />);

    expect(controlRef.current?.isDirty()).toBe(false);
    await pickSecret(user);
    expect(controlRef.current?.isDirty()).toBe(true);

    controlRef.current?.requestClose(next);
    await user.click(await screen.findByRole("button", { name: "Discard" }));
    expect(next).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("leaves Anthropic temperature blank by default and does not store one", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<NodeInspector {...makeProps({ onSave })} />);

    expect(screen.getByLabelText(/Temperature/)).toHaveValue(null);
    await pickSecret(user);
    await user.click(screen.getByRole("button", { name: /Save changes/ }));
    expect(onSave.mock.calls[0]?.[0].config).not.toHaveProperty("temperature");
  });
});
