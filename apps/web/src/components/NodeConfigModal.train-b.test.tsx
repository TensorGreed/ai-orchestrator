import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Node } from "reactflow";
import type { EditorNodeData } from "../lib/workflow";
import * as api from "../lib/api";
import { NodeInspector } from "./NodeConfigModal";

// Template assist across the item nodes (Filter Rejected, Loop collected, typed Set) and a view-only inspector.

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, fetchProviderModels: vi.fn(), previewExpression: vi.fn() };
});

function node(id: string, nodeType: string, config: Record<string, unknown>): Node<EditorNodeData> {
  return { id, type: "workflowNode", position: { x: 0, y: 0 }, data: { label: id, nodeType, config } } as Node<EditorNodeData>;
}

const filterOutput = {
  items: [{ name: "kept", price: 40 }],
  count: 1,
  rejected: [{ name: "cheap", price: 5 }],
  rejected_count: 1,
  total: 2,
  items_from: "products"
};
const loopOutput = { items: [{ index: 0, outputs: { body_1: { total: 3 } } }], collected: [{ total: 3 }] };

const executionResult = {
  executionId: "ex-1",
  status: "success",
  nodeResults: [
    { nodeId: "filter_items", status: "success", output: filterOutput },
    { nodeId: "loop_items", status: "success", output: loopOutput },
    {
      nodeId: "after",
      status: "success",
      input: { parent_outputs: { filter_items: {} }, items: filterOutput.rejected, count: 1, total: 2, items_from: "products" },
      output: { ok: true }
    }
  ]
} as unknown as Parameters<typeof NodeInspector>[0]["executionResult"];

function props(overrides: Partial<Parameters<typeof NodeInspector>[0]> = {}): Parameters<typeof NodeInspector>[0] {
  return {
    node: node("after", "http_request", { method: "GET", urlTemplate: "" }),
    inputOptions: [{ id: "filter_items", label: "Filter items (filter_items)", rejectedItems: true }],
    nodeLabels: new Map([
      ["filter_items", "Filter items"],
      ["loop_items", "Loop items"],
      ["after", "After"]
    ]),
    executionResult,
    workflowContext: { id: "wf-1", name: "Workflow 1", vars: {} },
    pinnedData: {},
    showRuntimeInspection: true,
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

function renderInspector(element: React.ReactElement) {
  const view = render(element);
  const tab = screen.queryByRole("tab", { name: "Parameters" });
  if (tab && tab.getAttribute("aria-selected") !== "true") fireEvent.click(tab);
  return view;
}

function type(field: HTMLTextAreaElement | HTMLInputElement, text: string) {
  fireEvent.change(field, { target: { value: text, selectionStart: text.length, selectionEnd: text.length } });
}

function optionTexts(): string[] {
  return within(screen.getByTestId("template-suggest"))
    .getAllByRole("option")
    .map((option) => option.textContent ?? "");
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.previewExpression).mockResolvedValue({ ok: true, result: "", missing: [] });
});

describe("suggestions for the item nodes' outputs", () => {
  it("a node on a Filter's Rejected output is offered the rejected items as items, not the kept ones", () => {
    renderInspector(<NodeInspector {...props()} />);
    const url = screen.getByLabelText("URL Template") as HTMLTextAreaElement;
    fireEvent.focus(url);
    type(url, "{{items.0.na");
    const first = optionTexts()[0]!;
    expect(first).toContain("items.0.name");
    expect(first).toContain('"cheap"');
    type(url, "{{");
    const paths = optionTexts().join("\n");
    expect(paths).toContain("count");
    expect(paths).toContain("total");
    expect(paths).toContain("items_from");
    // The Rejected output passes no `rejected` field.
    expect(optionTexts().some((text) => text.startsWith("rejected"))).toBe(false);
    // The Filter's full output stays under results.
    type(url, "{{results.filter_items.rej");
    expect(optionTexts().some((text) => text.includes("results.filter_items.rejected"))).toBe(true);
  });

  it("a node on the Kept output (or without a handle) is offered the whole Filter output", () => {
    renderInspector(<NodeInspector {...props({ inputOptions: [{ id: "filter_items", label: "Filter items" }] })} />);
    const url = screen.getByLabelText("URL Template") as HTMLTextAreaElement;
    fireEvent.focus(url);
    type(url, "{{items.0.na");
    expect(optionTexts()[0]).toContain('"kept"');
    type(url, "{{rejected_c");
    expect(optionTexts()[0]).toContain("rejected_count");
  });

  it("offers a Loop's collected passes under results", () => {
    renderInspector(<NodeInspector {...props()} />);
    const url = screen.getByLabelText("URL Template") as HTMLTextAreaElement;
    fireEvent.focus(url);
    type(url, "{{results.loop_items.coll");
    const texts = optionTexts();
    expect(texts[0]).toContain("results.loop_items.collected");
    expect(texts.join("\n")).toContain("results.loop_items.collected.0.total");
  });
});

describe("a Set node's typed value field", () => {
  it("has autocomplete and the missing-value note", async () => {
    vi.mocked(api.previewExpression).mockImplementation(async ({ expression }) =>
      expression.includes("nope") ? { ok: true, result: "", missing: [{ body: "nope", reason: "missing" }] } : { ok: true, result: expression, missing: [] }
    );
    renderInspector(
      <NodeInspector {...props({ node: node("after", "set_node", { assignments: [{ key: "x", valueTemplate: "{{nope}}", type: "auto" }] }) })} />
    );
    const warning = await screen.findByTestId("template-missing-warning");
    expect(warning.textContent).toContain("{{nope}}");
    const valueField = screen.getByLabelText("Value Template") as HTMLTextAreaElement;
    fireEvent.focus(valueField);
    type(valueField, "{{cou");
    expect(optionTexts()[0]).toContain("count");
  });
});

describe("a view-only inspector", () => {
  it("offers no autocomplete inserts and makes no Input field draggable", async () => {
    renderInspector(<NodeInspector {...props({ readOnlyReason: "You can view this workflow but not change it." })} />);
    const url = screen.getByLabelText("URL Template") as HTMLTextAreaElement;
    fireEvent.focus(url);
    type(url, "{{");
    expect(screen.queryByTestId("template-suggest")).toBeNull();
    expect(url).not.toHaveAttribute("aria-autocomplete");
    const inputTab = screen.queryByRole("tab", { name: "Input" });
    if (inputTab) fireEvent.click(inputTab);
    await waitFor(() => expect(document.querySelectorAll("[draggable='true']").length).toBe(0));
  });

  it("makes Input fields draggable for someone who may edit", async () => {
    renderInspector(<NodeInspector {...props()} />);
    const inputTab = screen.queryByRole("tab", { name: "Input" });
    if (inputTab) fireEvent.click(inputTab);
    await waitFor(() => expect(document.querySelectorAll("[draggable='true']").length).toBeGreaterThan(0));
  });
});
