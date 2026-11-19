import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReactFlowProvider, type Node, type NodeProps } from "reactflow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getNodeDefinition } from "@ai-orchestrator/shared";
import type { EditorNodeData } from "../lib/workflow";
import * as api from "../lib/api";
import { showsErrorOutput } from "../lib/error-output";
import { NodeInspector } from "./NodeConfigModal";
import { WorkflowCanvasNode } from "./WorkflowCanvasNode";
import { CanvasInsertContext } from "./canvas-insert-context";
import { draftIssueShown } from "../lib/draft-validation";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, fetchProviderModels: vi.fn(), previewExpression: vi.fn(), fetchGuardProfiles: vi.fn(), fetchGuardWorkflowBinding: vi.fn() };
});

function renderCanvasNode(data: Partial<EditorNodeData> & Pick<EditorNodeData, "nodeType" | "config">) {
  const props = {
    id: "n1",
    type: "workflowNode",
    selected: false,
    zIndex: 0,
    isConnectable: true,
    xPos: 0,
    yPos: 0,
    dragging: false,
    data: { label: "Node", ...data } as EditorNodeData
  } as NodeProps<EditorNodeData>;
  return render(
    <ReactFlowProvider>
      <WorkflowCanvasNode {...props} />
    </ReactFlowProvider>
  );
}

const errorHandle = (container: HTMLElement) => container.querySelector('[data-handleid="error"]');

describe("Error output on the canvas", () => {
  it("appears on a node whose On Error is the fallback branch", () => {
    const { container } = renderCanvasNode({ nodeType: "http_request", config: { urlTemplate: "https://x.test", onError: "branch" } });
    expect(errorHandle(container)).not.toBeNull();
    expect(screen.getByTestId("node-error-output")).toHaveTextContent("Error");
  });

  it("is absent otherwise", () => {
    for (const onError of [undefined, "stop", "continue"]) {
      const { container, unmount } = renderCanvasNode({ nodeType: "http_request", config: { urlTemplate: "https://x.test", onError } });
      expect(errorHandle(container)).toBeNull();
      unmount();
    }
  });

  it("stays while an edge still leaves it", () => {
    const { container } = renderCanvasNode({ nodeType: "set_node", config: { onError: "stop" }, errorOutputConnected: true });
    expect(errorHandle(container)).not.toBeNull();
  });

  it("appears on agents and on nodes with several outputs", () => {
    for (const nodeType of ["agent_orchestrator", "if_node", "switch_node", "approval_gate"]) {
      const { container, unmount } = renderCanvasNode({ nodeType: nodeType as EditorNodeData["nodeType"], config: { onError: "branch" } });
      expect(container.querySelectorAll('[data-handleid="error"]')).toHaveLength(1);
      unmount();
    }
  });

  it("is not added to a Switch with a case named error, which owns that handle", () => {
    const { container } = renderCanvasNode({ nodeType: "switch_node", config: { onError: "branch", cases: [{ label: "error", value: "x" }] } });
    expect(container.querySelectorAll('[data-handleid="error"]')).toHaveLength(1);
    expect(screen.queryByTestId("node-error-output")).toBeNull();
  });

  it("is not added to Try/Catch, which has its own Catch output", () => {
    const { container } = renderCanvasNode({ nodeType: "try_catch", config: { onError: "branch" } });
    expect(container.querySelectorAll('[data-handleid="error"]')).toHaveLength(1);
    expect(screen.queryByTestId("node-error-output")).toBeNull();
    expect(showsErrorOutput("try_catch", { onError: "branch" })).toBe(false);
  });
});

function inspectorNode(config: Record<string, unknown>): Node<EditorNodeData> {
  return { id: "fetch", type: "workflowNode", position: { x: 0, y: 0 }, data: { label: "Fetch", nodeType: "http_request", config } } as Node<EditorNodeData>;
}

function inspectorProps(config: Record<string, unknown>): Parameters<typeof NodeInspector>[0] {
  return {
    node: inspectorNode(config),
    inputOptions: [],
    executionResult: null,
    nodeLabels: new Map([["fetch", "Fetch"]]),
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

const failToggle = () => screen.getByRole("button", { name: /Fail on HTTP error status/ });

describe("HTTP Request: fail on HTTP error status", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.previewExpression).mockResolvedValue({ ok: true, result: "" });
  });

  it("is on for a new node", () => {
    expect(getNodeDefinition("http_request")?.sampleConfig.failOnHttpError).toBe(true);
    render(<NodeInspector {...inspectorProps({ ...getNodeDefinition("http_request")!.sampleConfig })} />);
    expect(failToggle()).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText(/Retry on status/)).toHaveAttribute("placeholder", "429, 5xx");
  });

  it("shows an older node without retries as off", () => {
    render(<NodeInspector {...inspectorProps({ method: "GET", urlTemplate: "https://x.test" })} />);
    expect(failToggle()).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByLabelText(/Retry on status/)).toBeNull();
  });

  it("flags entries that are not status codes", async () => {
    const user = userEvent.setup();
    render(<NodeInspector {...inspectorProps({ method: "GET", urlTemplate: "https://x.test", failOnHttpError: true })} />);
    await user.type(screen.getByLabelText(/Retry on status/), "429, teapot");
    expect(screen.getByRole("alert")).toHaveTextContent("Not a status code: teapot");
  });

  it("explains the Error output once the fallback branch is chosen", async () => {
    const user = userEvent.setup();
    render(<NodeInspector {...inspectorProps({ method: "GET", urlTemplate: "https://x.test", failOnHttpError: true })} />);
    await user.click(screen.getByRole("tab", { name: /Settings/ }));
    const group = screen.getByRole("region", { name: "Error handling" });
    expect(within(group).getByLabelText(/Max delay between Retries/)).toHaveValue(30000);
    await user.selectOptions(within(group).getByLabelText("On Error Behavior"), "branch");
    expect(screen.getByTestId("error-output-tip")).toHaveTextContent(/red Error output/);
  });
});

describe("HTTP Request saved before the option", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.previewExpression).mockResolvedValue({ ok: true, result: "" });
  });

  it("explains that a node with retries fails only on its retried statuses", () => {
    render(<NodeInspector {...inspectorProps({ method: "GET", urlTemplate: "https://x.test", retryCount: 2 })} />);
    expect(failToggle()).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("http-retry-list-only-tip")).toBeInTheDocument();
    expect(screen.getByLabelText(/Retry on status/)).toBeInTheDocument();
  });

  it("reads retries from the node's errorConfig and shows them in Settings", async () => {
    const user = userEvent.setup();
    const props = inspectorProps({ method: "GET", urlTemplate: "https://x.test" });
    props.node = { ...props.node, data: { ...props.node.data, nodeExtras: { errorConfig: { retryOnFail: true, maxRetries: 3, retryIntervalMs: 250 } } } };
    render(<NodeInspector {...props} />);
    expect(screen.getByTestId("http-retry-list-only-tip")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: /Settings/ }));
    expect(screen.getByTestId("node-error-config-tip")).toHaveTextContent("3 retries, first wait 250 ms");
  });
});

describe("the Error output's +", () => {
  function renderWithInsert(data: Partial<EditorNodeData> & Pick<EditorNodeData, "nodeType" | "config">, connected: string[] = []) {
    const onAddAfter = vi.fn();
    const props = {
      id: "n1",
      type: "workflowNode",
      selected: false,
      zIndex: 0,
      isConnectable: true,
      xPos: 0,
      yPos: 0,
      dragging: false,
      data: { label: "Node", ...data } as EditorNodeData
    } as NodeProps<EditorNodeData>;
    const view = render(
      <ReactFlowProvider>
        <CanvasInsertContext.Provider value={{ onAddAfter, isConnected: (_node, handle) => connected.includes(handle ?? "") }}>
          <WorkflowCanvasNode {...props} />
        </CanvasInsertContext.Provider>
      </ReactFlowProvider>
    );
    return { ...view, onAddAfter };
  }

  it("opens the palette connected after the error output, on cards and hubs", async () => {
    const user = userEvent.setup();
    for (const nodeType of ["http_request", "agent_orchestrator"] as const) {
      const { onAddAfter, unmount } = renderWithInsert({ nodeType, config: { onError: "branch" } });
      const output = screen.getByTestId("node-error-output");
      await user.click(within(output).getByRole("button", { name: "Add a node after the error output" }));
      expect(onAddAfter).toHaveBeenCalledWith("n1", "error");
      unmount();
    }
  });

  it("is hidden once the error output is connected, like any other output's", () => {
    renderWithInsert({ nodeType: "http_request", config: { onError: "branch" }, errorOutputConnected: true }, ["error"]);
    expect(within(screen.getByTestId("node-error-output")).getByRole("button", { name: "Add a node after the error output" })).toHaveClass("wf-handle-add-connected");
  });

  it("is not drawn for a hub on a Supervisor's worker port", () => {
    renderWithInsert({ nodeType: "agent_orchestrator", config: { onError: "branch" }, attachedAs: "worker" } as never);
    expect(within(screen.getByTestId("node-error-output")).queryByRole("button")).toBeNull();
  });
});

describe("an errorConfig stored with invalid values", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.previewExpression).mockResolvedValue({ ok: true, result: "" });
  });

  it("is named in Settings, and Remove invalid values saves the node without them", async () => {
    const user = userEvent.setup();
    const props = inspectorProps({ method: "GET", urlTemplate: "https://x.test" });
    props.node = {
      ...props.node,
      data: { ...props.node.data, nodeExtras: { errorConfig: { continueOnFail: true, maxRetries: -1, retryIntervalMs: "soon" }, notes: "kept" } }
    };
    render(<NodeInspector {...props} />);
    await user.click(screen.getByRole("tab", { name: /Settings/ }));
    const warning = screen.getByTestId("node-error-config-invalid");
    expect(warning).toHaveTextContent("invalid values (maxRetries, retryIntervalMs)");
    // The valid part still shows as the node's error handling.
    expect(screen.getByTestId("node-error-config-tip")).toHaveTextContent("a failure continues the run");
    await user.click(within(warning).getByRole("button", { name: "Remove invalid values" }));
    expect(screen.getByTestId("node-error-config-invalid")).toHaveTextContent("removed when you save");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({ nodeExtras: { errorConfig: { continueOnFail: true }, notes: "kept" } }));
  });

  it("does not change the node's extras when nothing is removed", async () => {
    const user = userEvent.setup();
    const props = inspectorProps({ method: "GET", urlTemplate: "https://x.test" });
    props.node = { ...props.node, data: { ...props.node.data, label: "Fetch", nodeExtras: { errorConfig: { maxRetries: -1 } } } };
    render(<NodeInspector {...props} />);
    await user.selectOptions(screen.getByLabelText("Method"), "POST");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(vi.mocked(props.onSave).mock.calls[0]![0]).not.toHaveProperty("nodeExtras");
  });

  it("is listed when the workflow is opened, unlike other notes", () => {
    const invalid = { code: "invalid_error_config", message: "x", severity: "warning" as const };
    const note = { code: "missing_output_node", message: "y", severity: "warning" as const };
    const unconnected = { code: "error_output_not_connected", message: "z", severity: "warning" as const };
    expect(draftIssueShown(invalid, false)).toBe(true);
    expect(draftIssueShown(note, false)).toBe(false);
    expect(draftIssueShown(unconnected, false)).toBe(false);
    expect(draftIssueShown(unconnected, true)).toBe(true);
    expect(draftIssueShown({ code: "missing_http_request_url_template", message: "w" }, false)).toBe(true);
  });
});
