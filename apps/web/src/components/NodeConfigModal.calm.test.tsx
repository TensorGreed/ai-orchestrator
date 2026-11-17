import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Node } from "reactflow";
import { nodeDefinitions, type WorkflowExecutionResult } from "@ai-orchestrator/shared";
import type { EditorNodeData } from "../lib/workflow";
import * as api from "../lib/api";
import { NodeInspector, type NodeInspectorHandle } from "./NodeConfigModal";
import { countSet } from "./InspectorDisclosure";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchProviderModels: vi.fn(),
    previewExpression: vi.fn(),
    fetchGuardProfiles: vi.fn(),
    fetchGuardWorkflowBinding: vi.fn()
  };
});

function node(id: string, nodeType: string, config: Record<string, unknown>, label = id): Node<EditorNodeData> {
  return { id, type: "workflowNode", position: { x: 0, y: 0 }, data: { label, nodeType, config } } as Node<EditorNodeData>;
}

const T0 = "2026-01-01T00:00:00.000Z";
const run: WorkflowExecutionResult = {
  workflowId: "wf-1",
  executionId: "exec-1",
  status: "success",
  startedAt: T0,
  completedAt: T0,
  nodeResults: [
    { nodeId: "start", status: "success", startedAt: T0, durationMs: 1, input: { parent_outputs: {} }, output: { region: "east" } },
    {
      nodeId: "fetch",
      status: "success",
      startedAt: "2026-01-01T00:00:01.000Z",
      durationMs: 8,
      input: { region: "east", start: { region: "east" }, parent_outputs: { start: { region: "east" } } },
      output: { status: 200, body: { ok: true }, _telemetry: { latencyMs: 8 } }
    }
  ]
} as WorkflowExecutionResult;
const nodeLabels = new Map([
  ["start", "Start"],
  ["fetch", "Fetch orders"]
]);

function props(overrides: Partial<Parameters<typeof NodeInspector>[0]> = {}): Parameters<typeof NodeInspector>[0] {
  return {
    node: node("fetch", "http_request", { method: "GET", urlTemplate: "https://api.example.com/orders" }, "Fetch orders"),
    inputOptions: [],
    executionResult: run,
    nodeLabels,
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
    onUnpinNodeOutput: vi.fn(),
    ...overrides
  };
}

const originalWidth = window.innerWidth;
function setWindowWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
}

describe("node inspector: calm by default", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.previewExpression).mockResolvedValue({ ok: true, result: "" });
    vi.mocked(api.fetchGuardProfiles).mockResolvedValue({ profiles: [] } as unknown as Awaited<ReturnType<typeof api.fetchGuardProfiles>>);
    vi.mocked(api.fetchGuardWorkflowBinding).mockRejectedValue(new Error("none"));
    try {
      window.localStorage.clear();
    } catch {
      // jsdom storage may be unavailable in some environments
    }
    setWindowWidth(1440);
  });

  afterEach(() => setWindowWidth(originalWidth));

  it("opens side by side on a wide window: one header, Input | Parameters | Output, the status shown once", () => {
    render(<NodeInspector {...props()} />);
    const dialog = screen.getByRole("dialog", { name: "Inspect Fetch orders" });
    expect(dialog).toHaveClass("insp-split");
    expect(screen.getByRole("region", { name: "Input" })).toHaveTextContent("From Start");
    expect(screen.getByRole("region", { name: "Output" })).toHaveTextContent("200");
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Parameters", "Settings", "Trace"]);
    expect(screen.getByRole("tab", { name: "Parameters" })).toHaveAttribute("aria-selected", "true");
    // The run status is in the header only.
    const status = screen.getAllByTestId("run-data-status");
    expect(status).toHaveLength(1);
    expect(status[0]).toHaveTextContent("success · 1 item · 8 ms");
    expect(dialog.querySelector(".insp-head")!.contains(status[0]!)).toBe(true);
    expect(screen.getByRole("navigation", { name: "Run steps" })).toHaveTextContent("Step 2 of 2");
    // One view switch per pane, not per block.
    expect(screen.getAllByRole("group", { name: /: view as$/ }).map((group) => group.getAttribute("aria-label"))).toEqual([
      "Input: view as",
      "Output: view as"
    ]);
    // The type and node id are one quiet line; pinning moved to the Output menu.
    expect(dialog.querySelector(".insp-sub")).toHaveTextContent(/^http_requestNode id fetch$/);
    expect(screen.queryByRole("button", { name: "Pin output" })).toBeNull();
  });

  it("keeps the side-by-side layout for a node without run data, with the empty panes as rails", async () => {
    const user = userEvent.setup();
    render(<NodeInspector {...props({ executionResult: null })} />);
    expect(screen.getByRole("dialog", { name: "Inspect Fetch orders" })).toHaveClass("insp-split");
    expect(screen.queryByTestId("run-data-status")).toBeNull();
    expect(screen.getByRole("button", { name: "Show input" })).toHaveAttribute("aria-expanded", "false");
    await user.click(screen.getByRole("button", { name: "Show output" }));
    expect(screen.getByRole("region", { name: "Output" })).toHaveTextContent(/No run yet for this node/);
    // Focus moves to the button that replaced the one clicked.
    expect(screen.getByRole("button", { name: "Hide output" })).toHaveFocus();
    // Opening an empty pane is not stored.
    expect(window.localStorage.getItem("l2m:inspector-panes") ?? "").not.toContain('"outputCollapsed":true');
  });

  it("returns focus to the rail after hiding a pane", async () => {
    const user = userEvent.setup();
    render(<NodeInspector {...props()} />);
    await user.click(screen.getByRole("button", { name: "Hide input" }));
    expect(screen.getByRole("button", { name: "Show input" })).toHaveFocus();
  });

  it("puts node settings on a Settings tab, out of the parameter form", async () => {
    const user = userEvent.setup();
    render(<NodeInspector {...props()} />);
    expect(screen.queryByLabelText("On Error Behavior")).toBeNull();
    expect(screen.queryByText("Accent color")).toBeNull();
    expect(screen.queryByTestId("sensitive-output-field")).toBeNull();
    expect(screen.queryByText("Add Mapping")).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    expect(screen.getByLabelText("On Error Behavior")).toBeVisible();
    expect(screen.getByText("Accent color")).toBeVisible();
    expect(screen.getByTestId("sensitive-output-field")).toBeVisible();
    expect(screen.getByRole("button", { name: "Add Mapping" })).toBeVisible();
    // The keys of the last run are listed on demand.
    expect(screen.getByText(/Keys available from the last run/).closest("details")).not.toHaveAttribute("open");
    expect(screen.queryByLabelText("URL Template")).toBeNull();
  });

  it("marks the Settings tab when a setting differs from the default", () => {
    const { unmount } = render(<NodeInspector {...props()} />);
    expect(screen.getByRole("tab", { name: "Settings" })).toHaveTextContent(/^Settings$/);
    unmount();
    render(<NodeInspector {...props({ node: node("fetch", "http_request", { urlTemplate: "https://x.test", retryCount: 2 }, "Fetch orders") })} />);
    expect(screen.getByRole("tab", { name: /Settings/ }).querySelector(".insp-tab-dot")).not.toBeNull();
  });

  it("shows only the HTTP node's essential fields; the rest sit under a closed Advanced section that counts changes", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<NodeInspector {...props()} />);
    expect(screen.getByLabelText("Method")).toBeVisible();
    expect(screen.getByLabelText("URL Template")).toBeVisible();
    const advanced = screen.getByTestId("advanced-fields");
    expect(advanced).not.toHaveAttribute("open");
    expect(screen.getByLabelText("Headers Template (JSON)")).not.toBeVisible();
    expect(screen.getByLabelText("Timeout (ms)")).not.toBeVisible();
    expect(within(advanced).queryByText(/set$/)).toBeNull();
    await user.click(within(advanced).getByText("Advanced"));
    expect(screen.getByLabelText("Timeout (ms)")).toBeVisible();
    unmount();
    render(<NodeInspector {...props({ node: node("fetch", "http_request", { urlTemplate: "https://x.test", timeoutMs: 30000 }, "Fetch orders") })} />);
    expect(within(screen.getByTestId("advanced-fields")).getByText("1 set")).toBeInTheDocument();
  });

  it("keeps a Content Rules node's approval and override fields under Advanced", async () => {
    render(<NodeInspector {...props({ node: node("rules", "guard", { profileId: "effective" }, "Content Rules") })} />);
    await waitFor(() => expect(api.fetchGuardProfiles).toHaveBeenCalled());
    expect(screen.getByLabelText("Rule set")).toBeVisible();
    expect(screen.getByLabelText("Channel")).toBeVisible();
    expect(screen.getByLabelText("Input field")).toBeVisible();
    expect(screen.getByLabelText("Approval message")).not.toBeVisible();
    expect(screen.getByLabelText(/Approval timeout/)).not.toBeVisible();
    expect(screen.getByLabelText(/Rule set override/)).not.toBeVisible();
    // Help text is behind a "?" next to the label, not printed under the field.
    expect(screen.getByText("The field of the incoming item to check. Empty checks the whole item.")).not.toBeVisible();
  });

  it("keeps an agent's tuning fields under Advanced and its prompts in view", () => {
    render(
      <NodeInspector
        {...props({
          node: node("agent", "agent_orchestrator", { userPromptTemplate: "{{question}}", systemPromptTemplate: "Be brief.", maxIterations: 4 }, "Assistant"),
          slots: { chat_model: ["Echo model"] }
        })}
      />
    );
    expect(screen.getByLabelText("Prompt (User Message)")).toBeVisible();
    expect(screen.getByLabelText("System Message")).toBeVisible();
    expect(screen.getByRole("region", { name: "Slots" })).toBeVisible();
    expect(screen.getByRole("spinbutton", { name: /Max Iterations/ })).not.toBeVisible();
    expect(screen.getByRole("combobox", { name: /Agent Type/ })).not.toBeVisible();
  });

  it("shows expression helpers only while the field has focus, and no preview that repeats the text", async () => {
    vi.mocked(api.previewExpression).mockResolvedValue({ ok: true, result: "https://api.example.com/orders" });
    render(<NodeInspector {...props()} />);
    expect(screen.queryByLabelText("URL Template suggestions")).toBeNull();
    const url = screen.getByLabelText("URL Template");
    fireEvent.focus(url);
    expect(screen.getByLabelText("URL Template suggestions")).toBeInTheDocument();
    fireEvent.blur(url);
    expect(screen.queryByLabelText("URL Template suggestions")).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(api.previewExpression).toHaveBeenCalled();
    // The URL resolves to itself, so its field shows no preview box.
    expect(within(url.closest(".expression-field") as HTMLElement).queryByText("Preview")).toBeNull();
  });

  it("hides internal fields in tables until asked, and keeps schema and pinning in the pane menu", async () => {
    const user = userEvent.setup();
    render(<NodeInspector {...props()} />);
    const output = screen.getByRole("region", { name: "Output" });
    expect(within(output).queryByText("_telemetry")).toBeNull();
    await user.click(within(output).getByRole("button", { name: "Show 1 internal field" }));
    expect(within(output).getByText("_telemetry")).toBeInTheDocument();

    await user.click(within(output).getByRole("button", { name: "JSON" }));
    expect(within(output).getByText(/"status": 200/)).toBeInTheDocument();

    await user.click(within(output).getByRole("button", { name: "Output options" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Schema view" }));
    expect(within(output).getByText(/"status": "number"/)).toBeInTheDocument();
  });

  it("pins the output from the pane menu", async () => {
    const user = userEvent.setup();
    const onPinNodeOutput = vi.fn();
    render(<NodeInspector {...props({ onPinNodeOutput })} />);
    await user.click(screen.getByRole("button", { name: "Output options" }));
    await user.click(screen.getByRole("menuitem", { name: "Pin output" }));
    expect(onPinNodeOutput).toHaveBeenCalledWith("fetch");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes the pane menu with Escape without closing the inspector", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<NodeInspector {...props({ onClose })} />);
    await user.click(screen.getByRole("button", { name: "Input options" }));
    expect(screen.getByRole("menu", { name: "Input options" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Input options" })).toHaveFocus();
  });

  it("collapses a data pane to a rail and remembers it", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<NodeInspector {...props()} />);
    await user.click(screen.getByRole("button", { name: "Hide input" }));
    const input = screen.getByRole("region", { name: "Input" });
    expect(within(input).queryByText("From Start")).toBeNull();
    expect(within(input).getByRole("button", { name: "Show input" })).toHaveAttribute("aria-expanded", "false");
    unmount();
    render(<NodeInspector {...props()} />);
    const again = screen.getByRole("region", { name: "Input" });
    await user.click(within(again).getByRole("button", { name: "Show input" }));
    expect(screen.getByRole("region", { name: "Input" })).toHaveTextContent("From Start");
  });

  it("resizes a data pane with the arrow keys", async () => {
    const user = userEvent.setup();
    render(<NodeInspector {...props()} />);
    const separator = screen.getByRole("separator", { name: "Resize input" });
    const before = Number(separator.getAttribute("aria-valuenow"));
    separator.focus();
    await user.keyboard("{ArrowRight}");
    expect(Number(separator.getAttribute("aria-valuenow"))).toBe(before + 16);
    expect(JSON.parse(window.localStorage.getItem("l2m:inspector-panes") ?? "{}")).toMatchObject({ inputWidth: before + 16 });
    const output = screen.getByRole("separator", { name: "Resize output" });
    const outputBefore = Number(output.getAttribute("aria-valuenow"));
    output.focus();
    await user.keyboard("{ArrowLeft}");
    expect(Number(output.getAttribute("aria-valuenow"))).toBe(outputBefore + 16);
  });

  it("uses tabs on a narrow window: Input, Parameters, Output, Settings, Trace, opening on the output", () => {
    setWindowWidth(900);
    render(<NodeInspector {...props()} />);
    expect(screen.getByRole("dialog", { name: "Inspect Fetch orders" })).not.toHaveClass("insp-split");
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Input", "Parameters", "Output", "Settings", "Trace"]);
    expect(screen.getByRole("tab", { name: "Output" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("region", { name: "Output" })).toHaveTextContent("200");
    expect(screen.queryByRole("button", { name: "Hide output" })).toBeNull();
  });

  it("a new node of any type shows no count on its Advanced sections", () => {
    setWindowWidth(1600);
    vi.mocked(api.fetchProviderModels).mockResolvedValue({ models: [] } as unknown as Awaited<ReturnType<typeof api.fetchProviderModels>>);
    const counted: string[] = [];
    for (const definition of nodeDefinitions) {
      const { container, unmount } = render(
        <NodeInspector {...props({ node: node("n", definition.type, structuredClone(definition.sampleConfig ?? {})), executionResult: null })} />
      );
      const counts = Array.from(container.querySelectorAll(".cfg-advanced-count")).map((element) => element.textContent);
      if (counts.length > 0) counted.push(`${definition.type}: ${counts.join(", ")}`);
      unmount();
    }
    expect(counted).toEqual([]);
  });

  it("opening an MCP Tool node does not count as an edit", () => {
    setWindowWidth(1600);
    const handle: { current: NodeInspectorHandle | null } = { current: null };
    render(
      <NodeInspector
        {...props({
          node: node("wiki", "mcp_tool", { serverId: "l2m-tools", toolName: "__all__", connection: { provider: "wikipedia" } }, "Wikipedia"),
          executionResult: null,
          controlRef: handle
        })}
      />
    );
    expect(handle.current?.isDirty()).toBe(false);
    expect(screen.getByRole("button", { name: /Save changes/ })).not.toHaveAttribute("data-dirty");
  });
});

describe("countSet", () => {
  it("ignores empty values, defaults and the node's sample values", () => {
    expect(countSet([[undefined, 1], [null, 1], ["  ", "x"], [[], ["a"]], [{}, { a: 1 }]])).toBe(0);
    expect(countSet([["json ", "json"], [15000, 15000], [6, 4, 6]])).toBe(0);
    expect(countSet([["xml", "json"], [7, 4, 6], [["a"], []]])).toBe(3);
  });
});

describe("node inspector: fitting and reachable controls", () => {
  afterEach(() => {
    window.localStorage.clear();
    setWindowWidth(originalWidth);
  });

  it("shrinks stored pane widths to fit, so the Output pane stays in view", () => {
    setWindowWidth(1600);
    window.localStorage.setItem(
      "l2m:inspector-panes",
      JSON.stringify({ inputWidth: 720, outputWidth: 720, inputCollapsed: false, outputCollapsed: false })
    );
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
    try {
      render(<NodeInspector {...props()} />);
      // 1000 wide: 320 for Parameters and two 5 px separators leave 670 for the panes.
      const input = screen.getByRole("separator", { name: "Resize input" });
      const output = screen.getByRole("separator", { name: "Resize output" });
      const total = Number(input.getAttribute("aria-valuenow")) + Number(output.getAttribute("aria-valuenow"));
      expect(total).toBeLessThanOrEqual(670);
      expect(Number(input.getAttribute("aria-valuemax"))).toBeLessThanOrEqual(670 - Number(output.getAttribute("aria-valuenow")));
    } finally {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, "clientWidth", descriptor);
    }
  });

  it("keeps a Code node's Test Run in view, with the test input folded", () => {
    setWindowWidth(1600);
    render(<NodeInspector {...props({ node: node("code", "code_node", { code: "return input;" }, "Code"), executionResult: null })} />);
    expect(screen.getByRole("button", { name: "Test Run" })).toBeVisible();
    expect(screen.getByTestId("code-test-input")).not.toHaveAttribute("open");
    expect(screen.getByLabelText("Timeout (ms)")).not.toBeVisible();
  });
});

