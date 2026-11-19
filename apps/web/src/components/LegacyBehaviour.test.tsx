import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Node } from "reactflow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getNodeDefinition } from "@ai-orchestrator/shared";
import type { EditorNodeData } from "../lib/workflow";
import * as api from "../lib/api";
import { NodeInspector } from "./NodeConfigModal";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, fetchProviderModels: vi.fn(), previewExpression: vi.fn(), fetchGuardProfiles: vi.fn(), fetchGuardWorkflowBinding: vi.fn() };
});

/**
 * Switches that only choose between an older and a newer behaviour are shown on a node saved with the older one,
 * next to a one-click upgrade; new nodes start on the newer behaviour and show neither. Rarely used fields sit under More.
 */

function props(nodeType: string, config: Record<string, unknown>): Parameters<typeof NodeInspector>[0] {
  return {
    node: { id: "n1", type: "workflowNode", position: { x: 0, y: 0 }, data: { label: "Node", nodeType, config } } as Node<EditorNodeData>,
    inputOptions: [],
    executionResult: null,
    nodeLabels: new Map([["n1", "Node"]]),
    onNavigateNode: vi.fn(),
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
    onUnpinNodeOutput: vi.fn()
  } as Parameters<typeof NodeInspector>[0];
}

const sample = (type: string) => structuredClone(getNodeDefinition(type as never)!.sampleConfig as Record<string, unknown>);
const toggle = (name: string) => screen.queryByRole("button", { name: new RegExp(`^${name}`) });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.previewExpression).mockResolvedValue({ ok: true, result: "" });
});

describe("Loop", () => {
  it("a new Loop shows its list and nothing else; Item Variable and Max Iterations sit under More", () => {
    render(<NodeInspector {...props("loop_node", sample("loop_node"))} />);
    expect(screen.getByLabelText("Input Key")).toBeVisible();
    expect(toggle("Collect results")).toBeNull();
    expect(toggle("Branches route in the loop")).toBeNull();
    expect(screen.queryByTestId("legacy-behaviour")).toBeNull();
    expect(screen.getByLabelText("Item Variable")).not.toBeVisible();
    expect(screen.getByLabelText("Max Iterations")).not.toBeVisible();
    expect(within(screen.getByTestId("advanced-fields")).queryByText(/set$/)).toBeNull();
  });

  it("a saved Loop without them shows both switches and upgrades in one click", async () => {
    const user = userEvent.setup();
    const view = props("loop_node", { inputKey: "rows", itemVariable: "row", maxIterations: 100 });
    render(<NodeInspector {...view} />);
    expect(toggle("Collect results")).toHaveAttribute("aria-pressed", "false");
    expect(toggle("Branches route in the loop")).toHaveAttribute("aria-pressed", "false");
    const notice = screen.getByTestId("legacy-behaviour");
    expect(notice).toHaveTextContent("it does not collect each pass's results and IF, Switch and Filter in its body do not route on each pass");
    // A changed Item Variable is counted on More.
    expect(within(screen.getByTestId("advanced-fields")).getByText("1 set")).toBeInTheDocument();
    await user.click(within(notice).getByRole("button", { name: "Upgrade to the new behaviour" }));
    // The switches stay in place until the node is saved, now on.
    expect(toggle("Collect results")).toHaveAttribute("aria-pressed", "true");
    expect(toggle("Branches route in the loop")).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(view.onSave).toHaveBeenCalledWith(
      expect.objectContaining({ config: { inputKey: "rows", itemVariable: "row", maxIterations: 100, collectResults: true, routeBranches: true } })
    );
  });

  it("opens More on a Loop stored without an item variable, which cannot run", () => {
    render(<NodeInspector {...props("loop_node", { inputKey: "items", collectResults: true, routeBranches: true })} />);
    expect(screen.getByTestId("advanced-fields")).toHaveAttribute("open");
    expect(screen.getByLabelText("Item Variable")).toBeVisible();
  });

  it("a saved Loop that collects but does not route shows only the routing switch", () => {
    render(<NodeInspector {...props("loop_node", { inputKey: "items", itemVariable: "item", collectResults: true })} />);
    expect(toggle("Collect results")).toBeNull();
    expect(toggle("Branches route in the loop")).toHaveAttribute("aria-pressed", "false");
  });
});

describe("Filter", () => {
  it("a new Filter has no Mode; Items from and Pass Mode sit under More, and Combine With shows from the second condition", async () => {
    const user = userEvent.setup();
    render(<NodeInspector {...props("filter_node", sample("filter_node"))} />);
    expect(screen.queryByLabelText(/^Mode/)).toBeNull();
    expect(screen.queryByTestId("legacy-behaviour")).toBeNull();
    expect(screen.getByLabelText(/^Items from/)).not.toBeVisible();
    expect(screen.getByLabelText("Pass Mode")).not.toBeVisible();
    expect(screen.queryByLabelText("Combine With")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Add Condition" }));
    expect(screen.getByLabelText("Combine With")).toBeVisible();
  });

  it("a Filter saved as pass or stop keeps its Mode, with the upgrade", async () => {
    const user = userEvent.setup();
    render(<NodeInspector {...props("filter_node", { conditions: [{ field: "status", operator: "eq", value: "ok" }], combineWith: "AND", passMode: "pass" })} />);
    expect(screen.getByLabelText(/^Mode/)).toHaveValue("gate");
    const notice = screen.getByTestId("legacy-behaviour");
    expect(notice).toHaveTextContent("passes or stops the whole input");
    await user.click(within(notice).getByRole("button", { name: "Upgrade to the new behaviour" }));
    expect(screen.getByLabelText(/^Mode/)).toHaveValue("items");
    expect(screen.getByTestId("legacy-behaviour")).toHaveTextContent("Its conditions then read each item's fields.");
  });
});

describe("Set", () => {
  it("a Set with fields saved without a type offers Text (as before) and the upgrade to Auto", async () => {
    const user = userEvent.setup();
    const view = props("set_node", { assignments: [{ key: "a", valueTemplate: "{{count}}" }, { key: "b", valueTemplate: "x", type: "string" }] });
    render(<NodeInspector {...view} />);
    expect(screen.getAllByLabelText(/^Type/)[0]).toHaveValue("");
    const notice = screen.getByTestId("legacy-behaviour");
    expect(notice).toHaveTextContent("fields saved without a type turn their values into text");
    await user.click(within(notice).getByRole("button", { name: "Upgrade to the new behaviour" }));
    expect(screen.getAllByLabelText(/^Type/)[0]).toHaveValue("auto");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(view.onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        config: { assignments: [{ key: "a", valueTemplate: "{{count}}", type: "auto" }, { key: "b", valueTemplate: "x", type: "string" }] }
      })
    );
  });

  it("a new Set has no notice and no Text (as before)", () => {
    render(<NodeInspector {...props("set_node", sample("set_node"))} />);
    expect(screen.queryByTestId("legacy-behaviour")).toBeNull();
    expect(screen.queryByRole("option", { name: "Text (as before)" })).toBeNull();
  });
});

describe("Schedule Trigger", () => {
  it("keeps Active under More while the schedule is on, and in sight when it is off", () => {
    const { unmount } = render(<NodeInspector {...props("schedule_trigger", sample("schedule_trigger"))} />);
    expect(screen.getByLabelText(/^Active/)).not.toBeVisible();
    unmount();
    render(<NodeInspector {...props("schedule_trigger", { ...sample("schedule_trigger"), active: false })} />);
    expect(screen.getByLabelText(/^Active/)).toBeVisible();
  });
});
