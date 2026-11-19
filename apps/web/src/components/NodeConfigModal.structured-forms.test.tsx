import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
    previewExpression: vi.fn(),
    fetchWorkflows: vi.fn(async () => []),
    fetchKnowledgeBases: vi.fn(async () => ({ knowledgeBases: [] }))
  };
});

function propsFor(nodeType: string, config: Record<string, unknown>, onSave = vi.fn()): Parameters<typeof NodeInspector>[0] {
  return {
    node: { id: "n1", type: "workflowNode", position: { x: 0, y: 0 }, data: { label: nodeType, nodeType, config } } as Node<EditorNodeData>,
    inputOptions: [],
    executionResult: null,
    nodeLabels: new Map(),
    onNavigateNode: vi.fn(),
    workflowContext: { id: "wf-1", name: "Workflow 1", vars: {} },
    pinnedData: {},
    showRuntimeInspection: true,
    secrets: [],
    onRefreshSecrets: vi.fn(),
    mcpServerDefinitions: [],
    onClose: vi.fn(),
    onSave,
    onExecuteStep: vi.fn(),
    onPinNodeOutput: vi.fn(),
    onUnpinNodeOutput: vi.fn()
  };
}

async function savedConfig(onSave: ReturnType<typeof vi.fn>) {
  await userEvent.setup().click(screen.getByRole("button", { name: "Save changes" }));
  const call = onSave.mock.calls.at(-1)?.[0] as { config: Record<string, unknown> };
  return call.config;
}

beforeEach(() => {
  vi.mocked(api.previewExpression).mockResolvedValue({ ok: true, result: "" });
});

describe("Switch cases form", () => {
  it("shows each case as a row and saves added, edited and removed cases", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<NodeInspector {...propsFor("switch_node", { switchValue: "{{status}}", cases: [{ value: "open", label: "open" }, { value: "done", label: "Finished" }] }, onSave)} />);
    expect(screen.queryByLabelText("Cases array (JSON)")).toBeNull();
    expect(screen.getByLabelText("Case 1 value")).toHaveValue("open");
    expect(screen.getByLabelText("Case 2 output")).toHaveValue("Finished");

    // The output named after its value follows the value; a hand-written one stays.
    fireEvent.change(screen.getByLabelText("Case 1 value"), { target: { value: "opened" } });
    fireEvent.change(screen.getByLabelText("Case 2 value"), { target: { value: "closed" } });
    await user.click(screen.getByRole("button", { name: "+ Add case" }));
    fireEvent.change(screen.getByLabelText("Case 3 value"), { target: { value: "stuck" } });
    expect(await savedConfig(onSave)).toMatchObject({
      cases: [
        { value: "opened", label: "opened" },
        { value: "closed", label: "Finished" },
        { value: "stuck", label: "stuck" }
      ]
    });

    await user.click(screen.getByRole("button", { name: "Remove case 1" }));
    expect(((await savedConfig(onSave)).cases as unknown[]).length).toBe(2);
  });

  it("warns when two cases share an output", () => {
    render(<NodeInspector {...propsFor("switch_node", { switchValue: "{{x}}", cases: [{ value: "a", label: "same" }, { value: "b", label: "same" }] })} />);
    expect(screen.getByRole("alert")).toHaveTextContent('More than one case uses the output "same"');
  });
});

describe("Form Trigger fields form", () => {
  it("edits fields as rows: the name follows the label, choices only for a choice field", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<NodeInspector {...propsFor("form_trigger", { path: "contact", fields: [{ name: "email", label: "Email", type: "email", required: true }] }, onSave)} />);
    expect(screen.queryByLabelText("Fields (JSON array)")).toBeNull();
    expect(screen.getByLabelText("Field 1 name")).toHaveValue("email");

    await user.click(screen.getByRole("button", { name: "+ Add field" }));
    fireEvent.change(screen.getByLabelText("Field 2 label"), { target: { value: "Pick a topic" } });
    expect(screen.getByLabelText("Field 2 name")).toHaveValue("pick_a_topic");
    expect(screen.queryByLabelText("Field 2 choices")).toBeNull();
    await user.selectOptions(screen.getByLabelText("Field 2 type"), "select");
    await user.type(screen.getByLabelText("Field 2 choices"), "Sales, Support,");
    // A trailing comma stays while typing.
    expect(screen.getByLabelText("Field 2 choices")).toHaveValue("Sales, Support,");
    expect(await savedConfig(onSave)).toMatchObject({
      fields: [
        { name: "email", label: "Email", type: "email", required: true },
        { name: "pick_a_topic", label: "Pick a topic", type: "select", options: ["Sales", "Support"] }
      ]
    });
  });

  it("reads fields saved as JSON text", () => {
    render(<NodeInspector {...propsFor("form_trigger", { path: "contact", fields: '[{"name":"msg","type":"textarea"}]' })} />);
    expect(screen.getByLabelText("Field 1 name")).toHaveValue("msg");
  });
});

describe("Execute Workflow mappings form", () => {
  it("edits the input mapping as rows", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<NodeInspector {...propsFor("execute_workflow", { workflowId: "wf-child", inputMapping: { "customer.name": "name" } }, onSave)} />);
    expect(screen.queryByLabelText("Input Mapping (JSON object)")).toBeNull();
    expect(screen.getByLabelText("From this workflow 1")).toHaveValue("customer.name");

    await user.click(screen.getAllByRole("button", { name: "+ Add row" })[0]!);
    // A row without a source is not saved yet, but stays on screen.
    expect(screen.getByLabelText("From this workflow 2")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("From this workflow 2"), { target: { value: "order.id" } });
    fireEvent.change(screen.getByLabelText("Sub-workflow input 2"), { target: { value: "orderId" } });
    expect(await savedConfig(onSave)).toMatchObject({ inputMapping: { "customer.name": "name", "order.id": "orderId" } });
  });
});

describe("RAG vector store settings form", () => {
  it("shows the fields the embedder and the store read, and keeps other settings as JSON", async () => {
    const onSave = vi.fn();
    render(
      <NodeInspector
        {...propsFor(
          "rag_retrieve",
          { embedderId: "openai-embedder", vectorStoreId: "pinecone-vector-store", vectorStoreConfig: { indexName: "docs", namespace: "prod" } },
          onSave
        )}
      />
    );
    expect(screen.queryByLabelText("Vector Store Extra Config (JSON)")).toBeNull();
    expect(screen.getByLabelText("Index name")).toHaveValue("docs");
    expect(screen.getByLabelText("Other vector store settings (JSON)")).toHaveValue(JSON.stringify({ namespace: "prod" }, null, 2));

    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "text-embedding-3-large" } });
    fireEvent.change(screen.getByLabelText("Index name"), { target: { value: "" } });
    expect((await savedConfig(onSave)).vectorStoreConfig).toEqual({ namespace: "prod", model: "text-embedding-3-large" });
  });

  it("has no fields for the built-in embedder and store", () => {
    render(<NodeInspector {...propsFor("rag_retrieve", {})} />);
    expect(screen.queryByLabelText("Model")).toBeNull();
    expect(screen.getByLabelText("Other vector store settings (JSON)")).toHaveValue("");
  });
});
