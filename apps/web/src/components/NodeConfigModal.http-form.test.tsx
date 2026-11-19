import { act, fireEvent, render, screen, within } from "@testing-library/react";
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

function httpNode(config: Record<string, unknown>): Node<EditorNodeData> {
  return { id: "http", type: "workflowNode", position: { x: 0, y: 0 }, data: { label: "Call API", nodeType: "http_request", config } } as Node<EditorNodeData>;
}

function props(config: Record<string, unknown>): Parameters<typeof NodeInspector>[0] {
  return {
    node: httpNode(config),
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
    onSave: vi.fn(),
    onExecuteStep: vi.fn(),
    onPinNodeOutput: vi.fn(),
    onUnpinNodeOutput: vi.fn()
  };
}

describe("HTTP Request form", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.previewExpression).mockResolvedValue({ ok: true, result: "" });
  });

  it.each(["POST", "PUT", "PATCH"])("shows Headers and Body outside Advanced for %s", (method) => {
    render(<NodeInspector {...props({ method, urlTemplate: "https://api.example.com/items" })} />);
    const advanced = screen.getByTestId("advanced-fields");
    expect(advanced).not.toHaveAttribute("open");
    expect(screen.getByLabelText("Body Template")).toBeVisible();
    expect(screen.getByLabelText("Headers Template (JSON)")).toBeVisible();
    expect(advanced).not.toContainElement(screen.getByLabelText("Body Template"));
    expect(screen.getByLabelText("Body Template").closest(".expression-field")).toHaveTextContent(/is sent as application\/json unless the headers set a Content-Type/);
    // Response type and timeout stay under Advanced.
    expect(screen.getByLabelText("Timeout (ms)")).not.toBeVisible();
  });

  it("keeps Headers and Body under Advanced for GET and DELETE, and moves them out when the method changes", async () => {
    const user = userEvent.setup();
    render(<NodeInspector {...props({ method: "GET", urlTemplate: "https://api.example.com/items" })} />);
    expect(screen.getByLabelText("Body Template")).not.toBeVisible();
    expect(screen.getByLabelText("Headers Template (JSON)")).not.toBeVisible();
    await user.selectOptions(screen.getByLabelText("Method"), "POST");
    expect(screen.getByLabelText("Body Template")).toBeVisible();
    expect(screen.getByLabelText("Headers Template (JSON)")).toBeVisible();
  });

  it("does not count Headers and Body on the Advanced title once they are out of it", () => {
    render(<NodeInspector {...props({ method: "POST", urlTemplate: "https://x.test", bodyTemplate: "{\"a\":1}" })} />);
    expect(within(screen.getByTestId("advanced-fields")).queryByText(/set$/)).toBeNull();
  });

  it("keeps a field's helpers in place until the press that blurred it is released", async () => {
    render(<NodeInspector {...props({ method: "GET", urlTemplate: "" })} />);
    const url = screen.getByLabelText("URL Template");
    act(() => url.focus());
    fireEvent.change(url, { target: { value: "https://api.example.com/items" } });
    expect(screen.getByLabelText("URL Template suggestions")).toBeInTheDocument();
    const summary = within(screen.getByTestId("advanced-fields")).getByText("More");

    // Press on the Advanced title: the field blurs while the button is still down.
    act(() => {
      summary.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      url.blur();
    });
    // Nothing above the title moved yet, so the release still lands on it.
    expect(screen.getByLabelText("URL Template suggestions")).toBeInTheDocument();
    await act(async () => {
      summary.dispatchEvent(new Event("pointerup", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(screen.queryByLabelText("URL Template suggestions")).toBeNull();
  });
});
