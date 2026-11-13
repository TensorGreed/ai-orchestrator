import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Node } from "reactflow";
import type { EditorNodeData } from "../lib/workflow";
import * as api from "../lib/api";
import { NodeInspector } from "./NodeConfigModal";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchProviderModels: vi.fn(),
    previewExpression: vi.fn()
  };
});

function node(id: string, nodeType: string, config: Record<string, unknown>): Node<EditorNodeData> {
  return { id, type: "workflowNode", position: { x: 0, y: 0 }, data: { label: id, nodeType, config } } as Node<EditorNodeData>;
}

function props(overrides: Partial<Parameters<typeof NodeInspector>[0]> = {}): Parameters<typeof NodeInspector>[0] {
  return {
    node: node("http", "http_request", { method: "GET", urlTemplate: "https://api.example.com/{{results.fetch.id}}" }),
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

describe("template fields: reading earlier steps", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.previewExpression).mockResolvedValue({ ok: true, result: "" });
  });

  it("shows a tip under the template field being edited that points to {{results.<nodeId>.field}} for earlier steps", () => {
    render(<NodeInspector {...props()} />);
    expect(screen.queryByTestId("template-scope-tip")).toBeNull();
    const url = screen.getByLabelText("URL Template");
    fireEvent.focus(url);
    const tips = screen.getAllByTestId("template-scope-tip");
    // One tip, under the field being edited, not under every template field of the node.
    expect(tips).toHaveLength(1);
    expect(url.parentElement!.contains(tips[0]!)).toBe(true);
    expect(tips[0]!.textContent).toContain("{{field}} reads the steps connected straight into this one");
    expect(tips[0]!.textContent).toContain("{{results.<nodeId>.field}}");
    fireEvent.blur(url);
    expect(screen.queryByTestId("template-scope-tip")).toBeNull();
  });

  it("shows no tip on a node without template fields", () => {
    render(<NodeInspector {...props({ node: node("ask", "user_prompt", { text: "Hi" }) })} />);
    for (const field of screen.queryAllByRole("textbox")) fireEvent.focus(field);
    expect(screen.queryByTestId("template-scope-tip")).toBeNull();
  });

  it("previews a template field in template mode with the last run's node outputs, which the server renders as `results`", async () => {
    const executionResult = {
      executionId: "ex-1",
      status: "success",
      nodeResults: [
        { nodeId: "fetch", status: "success", output: { id: "42" } },
        { nodeId: "mid", status: "success", output: { note: "between" } },
        { nodeId: "http", status: "success", input: { mid: { note: "between" }, note: "between" }, output: { status: 200 } }
      ]
    } as unknown as Parameters<typeof NodeInspector>[0]["executionResult"];
    render(<NodeInspector {...props({ executionResult })} />);
    await waitFor(() => expect(api.previewExpression).toHaveBeenCalled());
    const call = vi.mocked(api.previewExpression).mock.calls.find(([payload]) => payload.expression.includes("results.fetch.id"))![0];
    expect(call.mode).toBe("template");
    const context = call.context as { input: Record<string, unknown>; nodeOutputs: Record<string, unknown> };
    expect(context.input.note).toBe("between");
    expect(context.nodeOutputs).toEqual({ fetch: { id: "42" }, mid: { note: "between" }, http: { status: 200 } });
  });
});
