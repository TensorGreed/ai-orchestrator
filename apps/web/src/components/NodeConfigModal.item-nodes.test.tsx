import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Node } from "reactflow";
import type { EditorNodeData } from "../lib/workflow";
import * as api from "../lib/api";
import { NodeInspector } from "./NodeConfigModal";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, fetchProviderModels: vi.fn(), previewExpression: vi.fn() };
});

function props(nodeType: string, config: Record<string, unknown>, onSave = vi.fn()): Parameters<typeof NodeInspector>[0] {
  return {
    node: { id: "n1", type: "workflowNode", position: { x: 0, y: 0 }, data: { label: "Node", nodeType, config } } as Node<EditorNodeData>,
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

async function save(user: ReturnType<typeof userEvent.setup>, onSave: ReturnType<typeof vi.fn>): Promise<Record<string, unknown>> {
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(onSave).toHaveBeenCalled();
  return (onSave.mock.calls[0]![0] as { config: Record<string, unknown> }).config;
}

describe("item node forms", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.previewExpression).mockResolvedValue({ ok: true, result: "" });
  });

  it("Set: a field saved without a type shows 'Text (as before)'; a new field starts on Auto; the type is saved", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<NodeInspector {...props("set_node", { assignments: [{ key: "old", valueTemplate: "{{ a > 1 }}" }] }, onSave)} />);
    const [legacy] = screen.getAllByLabelText(/^Type/) as HTMLSelectElement[];
    expect(legacy!.value).toBe("");
    expect(legacy!.selectedOptions[0]!.textContent).toBe("Text (as before)");
    await user.click(screen.getByRole("button", { name: "Add Assignment" }));
    // The new field is on Auto: its type is under More, not in its row.
    expect(screen.getAllByLabelText(/^Type(?! of)/)).toHaveLength(1);
    expect((screen.getByLabelText(/^Type of field 2/) as HTMLSelectElement).value).toBe("auto");
    await user.selectOptions(screen.getAllByLabelText(/^Type(?! of)/)[0]!, "boolean");
    const config = await save(user, onSave);
    expect(config.assignments).toEqual([
      { key: "old", valueTemplate: "{{ a > 1 }}", type: "boolean" },
      { key: "", valueTemplate: "", type: "auto" }
    ]);
  });

  it("Set: a field on Auto has its type under More; a typed field shows it in its row; choosing a type moves it there", async () => {
    const user = userEvent.setup();
    render(
      <NodeInspector
        {...props("set_node", {
          assignments: [
            { key: "a", valueTemplate: "{{count}}", type: "auto" },
            { key: "b", valueTemplate: "1", type: "number" }
          ]
        })}
      />
    );
    const inline = screen.getAllByLabelText(/^Type(?! of)/) as HTMLSelectElement[];
    expect(inline.map((select) => select.value)).toEqual(["number"]);
    const more = screen.getByTestId("advanced-fields");
    const autoType = within(more).getByLabelText(/^Type of a/) as HTMLSelectElement;
    expect(autoType.value).toBe("auto");
    expect([...autoType.options].map((option) => option.value)).toEqual(["auto", "string", "number", "boolean", "json"]);
    await user.selectOptions(autoType, "json");
    expect((screen.getAllByLabelText(/^Type(?! of)/) as HTMLSelectElement[]).map((select) => select.value)).toEqual(["json", "number"]);
    expect(screen.queryByLabelText(/^Type of/)).toBeNull();
  });

  it("Set: the legacy option is not offered on a typed field", () => {
    render(<NodeInspector {...props("set_node", { assignments: [{ key: "k", valueTemplate: "1", type: "number" }] })} />);
    const select = screen.getByLabelText(/^Type/) as HTMLSelectElement;
    expect(select.value).toBe("number");
    expect([...select.options].map((option) => option.value)).toEqual(["auto", "string", "number", "boolean", "json"]);
  });

  it("Filter: a Filter saved without a mode is 'Pass or stop'; Items mode shows Items from and saves it", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<NodeInspector {...props("filter_node", { conditions: [{ field: "status", operator: "eq", value: "active" }] }, onSave)} />);
    expect((screen.getByLabelText(/^Mode/) as HTMLSelectElement).value).toBe("gate");
    expect(screen.queryByLabelText(/^Items from/)).toBeNull();
    await user.selectOptions(screen.getByLabelText(/^Mode/), "items");
    await user.type(screen.getByLabelText(/^Items from/), "body.items");
    const config = await save(user, onSave);
    expect(config).toMatchObject({ mode: "items", itemsFrom: "body.items" });
  });

  it("Loop: Collect results is off for a Loop saved without it and saves when turned on", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<NodeInspector {...props("loop_node", { inputKey: "items", itemVariable: "item" }, onSave)} />);
    const toggle = screen.getByRole("button", { name: /Collect results/ });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await user.click(toggle);
    const config = await save(user, onSave);
    expect(config.collectResults).toBe(true);
  });

  it("Loop: branch routing is off for a Loop saved without it and saves when turned on", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<NodeInspector {...props("loop_node", { inputKey: "items", itemVariable: "item" }, onSave)} />);
    const toggle = screen.getByRole("button", { name: /Branches route in the loop/ });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await user.click(toggle);
    const config = await save(user, onSave);
    expect(config.routeBranches).toBe(true);
  });

  it("Merge: offers Collect loop passes", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<NodeInspector {...props("merge_node", { mode: "append" }, onSave)} />);
    await user.selectOptions(screen.getByLabelText("Merge Mode"), "collect_loop_passes");
    expect(screen.getByTestId("merge-collect-tip")).toHaveTextContent(/every pass/);
    const config = await save(user, onSave);
    expect(config.mode).toBe("collect_loop_passes");
  });
});
