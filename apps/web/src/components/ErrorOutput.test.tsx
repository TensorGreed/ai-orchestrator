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

  it("shows an older node as off, unless it asks for retries", () => {
    const { unmount } = render(<NodeInspector {...inspectorProps({ method: "GET", urlTemplate: "https://x.test" })} />);
    expect(failToggle()).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByLabelText(/Retry on status/)).toBeNull();
    unmount();
    render(<NodeInspector {...inspectorProps({ method: "GET", urlTemplate: "https://x.test", retryCount: 2 })} />);
    expect(failToggle()).toHaveAttribute("aria-pressed", "true");
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
