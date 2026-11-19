import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ReactFlowProvider, type NodeProps } from "reactflow";
import type { EditorNodeData } from "../lib/workflow";
import { NodeRunInput, NodeRunOutput, previewNestedValue, RUN_DATA_JSON_LIMIT, RUN_DATA_ROW_PAGE, RunDataView, RunStatusLine, RunStepBar, type RunNodeResult } from "./NodeRunData";
import { WorkflowCanvasNode } from "./WorkflowCanvasNode";

const T0 = "2026-01-01T00:00:00.000Z";
const labels: Record<string, string> = { start: "Orders in", agent: "Support agent" };
const labelFor = (id: string) => labels[id] ?? id;

const sortResult: RunNodeResult = {
  nodeId: "sort",
  status: "success",
  startedAt: T0,
  durationMs: 12,
  input: {
    user_prompt: "What time is it in America/Toronto?",
    vars: {},
    start: { orders: [{ id: 1 }] },
    orders: [{ id: 1 }],
    parent_outputs: { start: { orders: [{ id: 1 }] } }
  },
  output: { items: [{ id: 1, sku: "A" }, { id: 2, sku: "B" }], count: 2 }
};

describe("RunDataView", () => {
  it("hides only the runtime's own keys; other keys that start with _ are data", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<RunDataView value={{ _id: "a1", _score: 2, name: "Ada", _telemetry: { ms: 3 } }} label="Output" />);
    const rowNames = () => within(screen.getByRole("table")).getAllByRole("rowheader").map((cell) => cell.textContent);
    expect(rowNames()).toEqual(["_id", "_score", "name"]);
    await user.click(screen.getByRole("button", { name: "Show 1 internal field" }));
    expect(rowNames()).toContain("_telemetry");
    unmount();

    render(<RunDataView value={[{ _id: 1, sku: "A", _branchHandle: "x" }]} label="Rows" />);
    const headers = () => within(screen.getByRole("table")).getAllByRole("columnheader").map((cell) => cell.textContent);
    expect(headers()).toEqual(["#", "_id", "sku"]);
    await user.click(screen.getByRole("button", { name: "Show 1 internal field" }));
    expect(headers()).toEqual(["#", "_id", "sku", "_branchHandle"]);
  });

  it("shows arrays of records as a table and switches to JSON and schema", async () => {
    const user = userEvent.setup();
    render(<RunDataView value={[{ id: 1, sku: "A" }, { id: 2, sku: "B" }]} label="Output" />);
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["#", "id", "sku"]);
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: "JSON" }));
    expect(screen.getByText(/"sku": "B"/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Schema" }));
    expect(screen.getByText(/"sku": "string"/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Schema" })).toHaveAttribute("aria-pressed", "true");
  });

  it("pages long tables and truncates long JSON until asked", async () => {
    const user = userEvent.setup();
    const rows = Array.from({ length: RUN_DATA_ROW_PAGE + 5 }, (_, index) => ({ n: index }));
    const { unmount } = render(<RunDataView value={rows} label="Rows" />);
    expect(screen.getAllByRole("row")).toHaveLength(RUN_DATA_ROW_PAGE + 1);
    await user.click(screen.getByRole("button", { name: `Show 5 more of ${rows.length} items` }));
    expect(screen.getAllByRole("row")).toHaveLength(rows.length + 1);
    unmount();

    const big = { text: "x".repeat(RUN_DATA_JSON_LIMIT + 100) };
    render(<RunDataView value={big} label="Big" />);
    await user.click(screen.getByRole("button", { name: "JSON" }));
    const block = document.querySelector(".run-data-json")!;
    expect(block.textContent!.length).toBeLessThan(RUN_DATA_JSON_LIMIT + 10);
    await user.click(screen.getByRole("button", { name: /Show all/ }));
    expect(document.querySelector(".run-data-json")!.textContent).toContain("x".repeat(RUN_DATA_JSON_LIMIT + 100));
  });

  it("cuts a long text output until asked, then shows all of it", async () => {
    const user = userEvent.setup();
    const text = "y".repeat(RUN_DATA_JSON_LIMIT + 50);
    render(<RunDataView value={text} label="Answer" />);
    expect(document.querySelector(".run-data-text")!.textContent!.length).toBeLessThan(text.length);
    await user.click(screen.getByRole("button", { name: /Show all/ }));
    expect(document.querySelector(".run-data-text")!.textContent).toBe(text);
  });

  it("gives an items list its own table", () => {
    render(<RunDataView value={sortResult.output} label="Output" />);
    expect(screen.getByText("items (2)")).toBeInTheDocument();
    expect(screen.getAllByRole("table")).toHaveLength(2);
  });

  it("shows a big nested value as one line that expands to its JSON", async () => {
    const user = userEvent.setup();
    const body = { customer: { id: "c-1", name: "Ada Lovelace", email: "ada@example.com" }, lines: [{ sku: "A", qty: 2 }, { sku: "B", qty: 1 }], note: "x".repeat(60) };
    render(<RunDataView value={{ status: 200, body, small: { ok: true } }} label="Output" />);
    const table = screen.getByRole("table");
    // A small nested value stays inline JSON.
    expect(within(table).getByText('{"ok":true}')).toBeInTheDocument();
    // The big one is a one-line preview of its first keys, closed.
    const summary = within(table).getByText(/^\{ customer: \{…\}, lines: \[2\], note: "x+…"/);
    const details = summary.closest("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(within(table).queryByText(/"email": "ada@example.com"/)).not.toBeInTheDocument();
    await user.click(summary);
    expect(details).toHaveAttribute("open");
    expect(within(table).getByText(/"email": "ada@example.com"/)).toBeInTheDocument();
    await user.click(summary);
    expect(within(table).queryByText(/"email": "ada@example.com"/)).not.toBeInTheDocument();
  });

  it("previews a long list in a table row by its length and first items", () => {
    const rows = [{ id: 1, tags: Array.from({ length: 40 }, (_, index) => `tag-${index}`) }];
    render(<RunDataView value={rows} label="Rows" />);
    expect(screen.getByText(/^40 items \[ "tag-0", "tag-1", .*, … \]$/)).toBeInTheDocument();
  });

  it("previewNestedValue summarises children without expanding them", () => {
    expect(previewNestedValue({ a: 1, b: "two", c: { d: 1 }, e: [], f: {} , g: null })).toBe('{ a: 1, b: "two", c: {…}, e: [], f: {}, g: null }');
    expect(previewNestedValue([{ a: 1 }])).toBe("1 item [ {…} ]");
  });
});

describe("NodeRunInput", () => {
  it("shows what each upstream node sent, with the run's prompt fields only in the collapsed run context", async () => {
    const onOpenNode = vi.fn();
    render(<NodeRunInput result={sortResult} labelFor={labelFor} isTrigger={false} onOpenNode={onOpenNode} />);
    expect(screen.getByRole("region", { name: "From Orders in" })).toBeInTheDocument();
    const context = screen.getByText("Run context (prompt fields, variables, trigger)").closest("details")!;
    expect(context).not.toHaveAttribute("open");
    expect(within(context).getByText("What time is it in America/Toronto?")).not.toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Orders in" }));
    expect(onOpenNode).toHaveBeenCalledWith("start");
  });

  it("names an upstream node that no longer exists without a link to it", () => {
    render(<NodeRunInput result={sortResult} labelFor={labelFor} isTrigger={false} onOpenNode={vi.fn()} nodeExists={() => false} />);
    expect(screen.getByRole("region", { name: "From Orders in" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Orders in" })).toBeNull();
  });

  it("says when there is no run, and explains a trigger", () => {
    const { unmount } = render(<NodeRunInput result={undefined} labelFor={labelFor} isTrigger={false} />);
    expect(screen.getByText(/No run data for this node yet/)).toBeInTheDocument();
    unmount();
    render(
      <NodeRunInput
        result={{ nodeId: "start", status: "success", startedAt: T0, input: { user_prompt: "hi", parent_outputs: {} } }}
        labelFor={labelFor}
        isTrigger
      />
    );
    expect(screen.getByText(/This trigger starts the run/)).toBeInTheDocument();
  });

  it("shows which agent used an attachment node instead of placeholder data", async () => {
    const onOpenNode = vi.fn();
    const consumed: RunNodeResult = {
      nodeId: "model",
      status: "success",
      startedAt: T0,
      input: null,
      output: { reason: "attachment_consumed_by_agent", message: "Node was consumed by an attached agent during execution.", handle: "chat_model", usedByNodeId: "agent" }
    };
    render(<NodeRunOutput result={consumed} labelFor={labelFor} onOpenNode={onOpenNode} />);
    expect(screen.getByTestId("run-data-attachment")).toHaveTextContent("Used by Support agent as its chat model");
    expect(screen.queryByText(/consumed by an attached agent/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Open Support agent" }));
    expect(onOpenNode).toHaveBeenCalledWith("agent");
  });
});

describe("NodeRunOutput", () => {
  it("shows the real output, and leaves the status to the inspector header", () => {
    render(<NodeRunOutput result={sortResult} labelFor={labelFor} />);
    expect(screen.getByText("items (2)")).toBeInTheDocument();
    expect(screen.queryByTestId("run-data-status")).toBeNull();
  });

  it("sums up status, item count and duration in one line", () => {
    render(<RunStatusLine result={sortResult} title="Run success" />);
    expect(screen.getByTestId("run-data-status")).toHaveTextContent("success · 2 items · 12 ms");
    expect(screen.getByTestId("run-data-status")).toHaveAttribute("title", "Run success");
  });

  it("shows an error with the input it failed on", () => {
    const failed: RunNodeResult = { ...sortResult, status: "error", output: undefined, error: "Order too large", errorRemediation: "Lower the quantity." };
    render(<NodeRunOutput result={failed} labelFor={labelFor} failingInput={<span>the failing input</span>} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Order too large");
    expect(screen.getByRole("alert")).toHaveTextContent("Lower the quantity.");
    expect(screen.getByText("Input it failed on").closest("details")).toHaveAttribute("open");
    expect(screen.getByText("the failing input")).toBeInTheDocument();
  });

  it("labels pinned data and code tests as not from a run, and says when there is nothing", () => {
    const { unmount } = render(<NodeRunOutput result={undefined} labelFor={labelFor} pinnedOutput={{ value: { a: 1 } }} />);
    expect(screen.getByTestId("run-data-pinned")).toHaveTextContent("Pinned data, not from a run");
    unmount();
    const second = render(<NodeRunOutput result={undefined} labelFor={labelFor} notFromRun={{ label: "Code test result, not from a workflow run.", content: <span>42</span> }} />);
    expect(screen.getByTestId("run-data-not-from-run")).toBeInTheDocument();
    second.unmount();
    render(<NodeRunOutput result={undefined} labelFor={labelFor} />);
    expect(screen.getByText(/No run yet for this node/)).toBeInTheDocument();
  });

  it("shows a code test result labelled, above the run's own output", () => {
    render(<NodeRunOutput result={sortResult} labelFor={labelFor} notFromRun={{ label: "Code test result, not from a workflow run.", content: <span>test value</span> }} />);
    expect(screen.getByTestId("run-data-not-from-run")).toBeInTheDocument();
    expect(screen.getByText("test value")).toBeInTheDocument();
    expect(screen.getByText("items (2)")).toBeInTheDocument();
  });

  it("says when the run reused pinned data", () => {
    render(<NodeRunOutput result={{ ...sortResult, warnings: ["Used pinned data; node executor was not called."] }} labelFor={labelFor} />);
    expect(screen.getByTestId("run-data-pinned")).toHaveTextContent("reused the node's pinned data");
  });

  it("streams live text while the node runs", () => {
    render(<NodeRunOutput result={{ nodeId: "llm", status: "running", startedAt: T0, liveText: "partial answer" }} labelFor={labelFor} />);
    expect(screen.getByRole("region", { name: "Streaming output" })).toHaveTextContent("partial answer");
  });
});

describe("RunStepBar", () => {
  it("steps to the previous and next node of the run by button and Alt+[ / Alt+]", async () => {
    const onStep = vi.fn();
    render(<RunStepBar steps={["start", "sort", "fail"]} currentId="sort" labelFor={labelFor} onStep={onStep} />);
    expect(screen.getByRole("navigation", { name: "Run steps" })).toHaveTextContent("Step 2 of 3");
    await userEvent.click(screen.getByRole("button", { name: "Previous step: Orders in" }));
    expect(onStep).toHaveBeenLastCalledWith("start");
    await userEvent.click(screen.getByRole("button", { name: "Next step: fail" }));
    expect(onStep).toHaveBeenLastCalledWith("fail");
    fireEvent.keyDown(window, { code: "BracketRight", altKey: true });
    expect(onStep).toHaveBeenLastCalledWith("fail");
    fireEvent.keyDown(window, { code: "BracketLeft", altKey: true });
    expect(onStep).toHaveBeenLastCalledWith("start");
    expect(onStep).toHaveBeenCalledTimes(4);
  });

  it("ignores the step keys while they are turned off", () => {
    const onStep = vi.fn();
    render(<RunStepBar steps={["a", "b"]} currentId="a" labelFor={labelFor} onStep={onStep} keysEnabled={false} />);
    fireEvent.keyDown(window, { code: "BracketRight", altKey: true });
    expect(onStep).not.toHaveBeenCalled();
  });

  it("does not step while typing in a field", () => {
    const onStep = vi.fn();
    render(
      <>
        <input aria-label="field" />
        <RunStepBar steps={["a", "b"]} currentId="a" labelFor={labelFor} onStep={onStep} />
      </>
    );
    fireEvent.keyDown(screen.getByLabelText("field"), { code: "BracketRight", altKey: true });
    expect(onStep).not.toHaveBeenCalled();
  });
});

describe("canvas run preview", () => {
  function renderNode(data: Partial<EditorNodeData>) {
    const props = {
      id: "n",
      type: "workflowNode",
      selected: false,
      zIndex: 0,
      isConnectable: true,
      xPos: 0,
      yPos: 0,
      dragging: false,
      data: { label: "Node", nodeType: "set_node", config: {}, ...data } as EditorNodeData
    } as NodeProps<EditorNodeData>;
    return render(
      <ReactFlowProvider>
        <WorkflowCanvasNode {...props} />
      </ReactFlowProvider>
    );
  }

  it("shows run state, item count, duration and output values without an In line", () => {
    renderNode({ executionStatus: "success", executionPreview: { meta: "success · 2 items · 12 ms", output: "count: 2 · items: [2]" } });
    const preview = screen.getByTestId("node-run-preview");
    expect(preview).toHaveTextContent("success · 2 items · 12 ms");
    expect(preview).toHaveTextContent("Out count: 2 · items: [2]");
    expect(preview).not.toHaveTextContent(/^In /);
  });

  it("shows 'used by' on an attached satellite", () => {
    renderNode({ nodeType: "openai_chat_model", attachedTo: "agent", attachedAs: "chat_model", executionPreview: { usedBy: "used by Support agent as its chat model" } });
    expect(screen.getByTestId("node-used-by")).toHaveTextContent("used by Support agent as its chat model");
  });
});

describe("RunStatusLine for a Loop body node", () => {
  it("says the data is the last of several passes", () => {
    render(<RunStatusLine result={{ nodeId: "body", status: "success", startedAt: "2026-01-01T00:00:00.000Z", durationMs: 5, output: { a: 1 } }} passCount={3} />);
    expect(screen.getByTestId("run-data-status")).toHaveTextContent("success · last of 3 passes · 1 item · 5 ms");
  });
});
