import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Node } from "reactflow";
import type { EditorNodeData } from "../lib/workflow";
import * as api from "../lib/api";
import { NodeInspector, withPreviewResults } from "./NodeConfigModal";

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

  it("shows a tip under template fields that points to {{results.<nodeId>.field}} for earlier steps", () => {
    render(<NodeInspector {...props()} />);
    const tips = screen.getAllByTestId("template-scope-tip");
    expect(tips.length).toBeGreaterThan(0);
    expect(tips[0]!.textContent).toContain("{{field}} reads the steps connected straight into this one");
    expect(tips[0]!.textContent).toContain("{{results.<nodeId>.field}}");
  });

  it("shows no tip on a node without template fields", () => {
    render(<NodeInspector {...props({ node: node("ask", "user_prompt", { text: "Hi" }) })} />);
    expect(screen.queryByTestId("template-scope-tip")).toBeNull();
  });

  it("previews {{results.<nodeId>.field}} with the last run's node outputs, as the run renders it", async () => {
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
    const context = vi.mocked(api.previewExpression).mock.calls[0]![0].context as { input: Record<string, unknown> };
    expect(context.input.note).toBe("between");
    expect(context.input.results).toEqual({ fetch: { id: "42" }, mid: { note: "between" }, http: { status: 200 } });
  });

  it("sets `results` over a parent field of that name, as the run does, and leaves inputs that are not objects alone", () => {
    expect(withPreviewResults({ results: "a parent's field" }, { a: 1 })).toEqual({ results: { a: 1 } });
    expect(withPreviewResults("text", { a: 1 })).toBe("text");
    expect(withPreviewResults({ x: 1 }, {})).toEqual({ x: 1 });
    expect(withPreviewResults({ x: 1 }, { a: { y: 2 } })).toEqual({ x: 1, results: { a: { y: 2 } } });
  });
});
