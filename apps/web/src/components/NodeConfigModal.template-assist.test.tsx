import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Node } from "reactflow";
import type { EditorNodeData } from "../lib/workflow";
import * as api from "../lib/api";
import { NodeInspector } from "./NodeConfigModal";
import { NodeRunInput, type RunNodeResult } from "./NodeRunData";

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

const executionResult = {
  executionId: "ex-1",
  status: "success",
  nodeResults: [
    { nodeId: "fetch_items", status: "success", output: { status: 200, body: { items: [{ title: "First" }] } } },
    {
      nodeId: "post_order",
      status: "success",
      input: { parent_outputs: { fetch_items: {} }, status: 200, body: { items: [{ title: "First" }] }, webhook: { customer: "Ada" } },
      output: { ok: true }
    }
  ]
} as unknown as Parameters<typeof NodeInspector>[0]["executionResult"];

function props(overrides: Partial<Parameters<typeof NodeInspector>[0]> = {}): Parameters<typeof NodeInspector>[0] {
  return {
    node: node("post_order", "http_request", { method: "GET", urlTemplate: "" }),
    inputOptions: [{ id: "fetch_items", label: "Fetch items (fetch_items)" }],
    nodeLabels: new Map([
      ["fetch_items", "Fetch items"],
      ["post_order", "Post order"]
    ]),
    executionResult,
    workflowContext: { id: "wf-1", name: "Workflow 1", vars: { region: "eu" } },
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

/** Renders the inspector on its Parameters tab (a node with run data opens on Output). */
function renderInspector(element: React.ReactElement) {
  const view = render(element);
  const tab = screen.queryByRole("tab", { name: "Parameters" });
  if (tab && tab.getAttribute("aria-selected") !== "true") fireEvent.click(tab);
  return view;
}

function type(field: HTMLTextAreaElement | HTMLInputElement, text: string) {
  fireEvent.change(field, { target: { value: text, selectionStart: text.length, selectionEnd: text.length } });
}

describe("template field autocomplete", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.previewExpression).mockResolvedValue({ ok: true, result: "" });
  });

  it("lists the last run's fields after {{ and inserts the chosen path with the closing braces", async () => {
    const onClose = vi.fn();
    renderInspector(<NodeInspector {...props({ onClose })} />);
    const url = screen.getByLabelText("URL Template") as HTMLTextAreaElement;
    fireEvent.focus(url);
    type(url, "https://api.example.com/{{");
    const list = screen.getByTestId("template-suggest");
    const options = within(list).getAllByRole("option");
    // The connected step's fields first, labelled with the step.
    expect(options[0]!.textContent).toContain("status");
    expect(options[0]!.textContent).toContain("Fetch items");
    expect(within(list).getByText("vars.region")).toBeInTheDocument();
    expect(url).toHaveAttribute("aria-controls", list.id);

    type(url, "https://api.example.com/{{ti");
    expect(within(screen.getByTestId("template-suggest")).getAllByRole("option")[0]!.textContent).toContain("body.items.0.title");
    fireEvent.keyDown(url, { key: "Enter" });
    expect(url.value).toBe("https://api.example.com/{{body.items.0.title}}");
    expect(screen.queryByTestId("template-suggest")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("moves through the list with the arrow keys, and Escape closes the list but not the inspector", () => {
    const onClose = vi.fn();
    renderInspector(<NodeInspector {...props({ onClose })} />);
    const url = screen.getByLabelText("URL Template") as HTMLTextAreaElement;
    fireEvent.focus(url);
    type(url, "{{");
    const first = within(screen.getByTestId("template-suggest")).getAllByRole("option");
    expect(first[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(url, { key: "ArrowDown" });
    const options = within(screen.getByTestId("template-suggest")).getAllByRole("option");
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    expect(url).toHaveAttribute("aria-activedescendant", options[1]!.id);
    fireEvent.keyDown(url, { key: "Escape" });
    expect(screen.queryByTestId("template-suggest")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("offers every step under results with its label, even without run data", () => {
    renderInspector(<NodeInspector {...props({ executionResult: null })} />);
    const url = screen.getByLabelText("URL Template") as HTMLTextAreaElement;
    fireEvent.focus(url);
    type(url, "{{results.");
    const option = within(screen.getByTestId("template-suggest")).getByRole("option");
    expect(option.textContent).toContain("results.fetch_items");
    expect(option.textContent).toContain("Fetch items");
  });

  it("works in plain text fields too, such as a Set node's Value Template and a Key field", () => {
    renderInspector(
      <NodeInspector {...props({ node: node("post_order", "set_node", { assignments: [{ key: "line", valueTemplate: "" }] }) })} />
    );
    const valueField = screen.getByLabelText("Value Template") as HTMLTextAreaElement;
    fireEvent.focus(valueField);
    type(valueField, "Total: {{bo");
    expect(screen.getByTestId("template-suggest")).toBeInTheDocument();
    type(valueField, "Total: {{stat");
    fireEvent.keyDown(valueField, { key: "Tab" });
    expect(valueField.value).toBe("Total: {{status}}");
    // A plain field without {{ shows no list.
    const keyField = screen.getByLabelText("Key") as HTMLInputElement;
    fireEvent.focus(keyField);
    type(keyField, "line{{");
    expect(screen.getByTestId("template-suggest")).toBeInTheDocument();
    type(keyField, "line");
    expect(screen.queryByTestId("template-suggest")).toBeNull();
  });

  it("shows no list outside {{ }}", () => {
    renderInspector(<NodeInspector {...props()} />);
    const url = screen.getByLabelText("URL Template") as HTMLTextAreaElement;
    fireEvent.focus(url);
    type(url, "https://api.example.com/");
    expect(screen.queryByTestId("template-suggest")).toBeNull();
  });
});

describe("missing-value warning in the preview", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("names the {{ }} the last run had no value for, and says it renders empty", async () => {
    vi.mocked(api.previewExpression).mockImplementation(async ({ expression }) =>
      expression.includes("customer.id")
        ? {
            ok: true,
            result: "https://api.example.com/",
            missing: [
              { body: "customer.id", reason: "missing" },
              { body: "system_prompt", reason: "missing" }
            ]
          }
        : { ok: true, result: expression, missing: [] }
    );
    renderInspector(<NodeInspector {...props({ node: node("post_order", "http_request", { method: "GET", urlTemplate: "https://api.example.com/{{customer.id}}" }) })} />);
    const warning = await screen.findByTestId("template-missing-warning");
    expect(warning.textContent).toContain("{{customer.id}}");
    expect(warning.textContent).toMatch(/renders empty/);
    // The run's optional prompt fields render empty by design: no warning for them.
    expect(warning.textContent).not.toContain("system_prompt");
  });

  it("says the node fails when the workflow uses strict templates", async () => {
    vi.mocked(api.previewExpression).mockImplementation(async ({ expression }) =>
      expression.includes("customer.id") ? { ok: true, result: "", missing: [{ body: "customer.id", reason: "missing" }] } : { ok: true, result: expression, missing: [] }
    );
    renderInspector(
      <NodeInspector
        {...props({
          node: node("post_order", "http_request", { method: "GET", urlTemplate: "{{customer.id}}" }),
          workflowContext: { id: "wf-1", name: "Workflow 1", vars: {}, strictTemplates: true }
        })}
      />
    );
    const warning = await screen.findByTestId("template-missing-warning");
    expect(warning.textContent).toMatch(/Strict templates is on, so this node fails/);
  });

  it("shows nothing when the node has no input from a run (it cannot tell what is missing)", async () => {
    vi.mocked(api.previewExpression).mockResolvedValue({ ok: true, result: "", missing: [{ body: "customer.id", reason: "missing" }] });
    renderInspector(<NodeInspector {...props({ executionResult: null, node: node("post_order", "http_request", { method: "GET", urlTemplate: "{{customer.id}}" }) })} />);
    await waitFor(() => expect(api.previewExpression).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId("template-missing-warning")).toBeNull();
  });
});

describe("dragging run data fields into a template field", () => {
  const input: RunNodeResult = {
    nodeId: "post_order",
    status: "success",
    startedAt: "2026-01-01T00:00:00.000Z",
    input: {
      parent_outputs: { fetch_items: { status: 200, body: { items: [{ title: "First" }] } } },
      status: 200,
      body: { items: [{ title: "First" }] },
      "odd key": 1
    }
  };

  function dragText(element: Element): string {
    let text = "";
    fireEvent.dragStart(element, { dataTransfer: { setData: (_type: string, value: string) => (text = value), effectAllowed: "" } });
    return text;
  }

  it("inserts {{field}} for a step connected straight in, nested fields included", () => {
    render(<NodeRunInput result={input} labelFor={(id) => id} isTrigger={false} draggableFields />);
    const status = screen.getByRole("rowheader", { name: "status" });
    expect(status).toHaveAttribute("draggable", "true");
    expect(dragText(status)).toBe("{{status}}");
  });

  it("inserts {{results.<id>.field}} when several steps send data", () => {
    const two: RunNodeResult = {
      ...input,
      input: { parent_outputs: { fetch_items: { status: 200 }, other_step: { note: "x" } }, status: 200, note: "x" }
    };
    render(<NodeRunInput result={two} labelFor={(id) => id} isTrigger={false} draggableFields />);
    expect(dragText(screen.getByRole("rowheader", { name: "status" }))).toBe("{{results.fetch_items.status}}");
    expect(dragText(screen.getByRole("rowheader", { name: "note" }))).toBe("{{results.other_step.note}}");
  });

  it("does not make fields draggable outside the inspector's Input pane", () => {
    render(<NodeRunInput result={input} labelFor={(id) => id} isTrigger={false} />);
    expect(screen.getByRole("rowheader", { name: "status" })).not.toHaveAttribute("draggable");
  });
});
