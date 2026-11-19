import { describe, expect, it } from "vitest";
import type { NodeExecutionResult, WorkflowExecutionResult } from "@ai-orchestrator/shared";
import {
  attachmentUse,
  nodeCardResults,
  canvasRunPreview,
  compactOutputPreview,
  formatRunDuration,
  hasTestData,
  loopPassResults,
  outputItemCount,
  runPromptInput,
  runStepOrder,
  splitNodeInput,
  usedPinnedData
} from "./run-data";

const T0 = "2026-01-01T00:00:00.000Z";

// The shape the engine stores for a node with one parent: run context, the parent's fields spread in, the parent
// keyed by its id, and parent_outputs.
const rulesOutput = { triggered: true, text: "Contact [EMAIL_1.AB12CD]", guard: { action: "redact" } };
const storedInput = {
  vars: {},
  webhook: {},
  system_prompt: "You are a precise tool-using AI assistant.",
  user_prompt: "What time is it in America/Toronto? Use tools when needed.",
  session_id: "editor-wf",
  trigger_type: "manual",
  execution_id: "exec-1",
  execution_custom_data: {},
  rules: rulesOutput,
  triggered: true,
  text: "Contact [EMAIL_1.AB12CD]",
  guard: { action: "redact" },
  mapped_name: "Jane",
  parent_outputs: { rules: rulesOutput }
};

describe("splitNodeInput", () => {
  it("separates what upstream nodes sent from the run's prompt fields and other fields", () => {
    const split = splitNodeInput(storedInput, (id) => (id === "rules" ? "Content Rules" : id));
    expect(split.receivedFrom).toEqual([{ nodeId: "rules", label: "Content Rules", value: rulesOutput }]);
    // The editor's chat prompt is run context, never presented as what the node received.
    expect(split.runContext).toMatchObject({ user_prompt: storedInput.user_prompt, system_prompt: storedInput.system_prompt });
    expect(split.otherFields).toEqual({ mapped_name: "Jane" });
  });

  it("treats a run input field a parent also has as the parent's copy", () => {
    const split = splitNodeInput({ ...storedInput, text: "run input of the same name" });
    expect(split.otherFields).toEqual({ mapped_name: "Jane" });
  });

  it("treats a trigger's input as run input and run context only", () => {
    const split = splitNodeInput({ user_prompt: "hi", orders: [1, 2], parent_outputs: {} });
    expect(split.receivedFrom).toEqual([]);
    expect(split.otherFields).toEqual({ orders: [1, 2] });
    expect(split.runContext).toEqual({ user_prompt: "hi" });
  });

  it("counts the run's prompt as a first node's input only when the node has no test data of its own", () => {
    const first = { user_prompt: "A customer on the Team plan asks…", vars: {}, parent_outputs: {} };
    expect(runPromptInput(first, false)).toBe("A customer on the Team plan asks…");
    expect(runPromptInput(first, true)).toBeUndefined();
    expect(runPromptInput(storedInput, false)).toBeUndefined();
    expect(runPromptInput({ user_prompt: " ", parent_outputs: {} }, false)).toBeUndefined();
    expect(splitNodeInput(first, undefined, { promptIsInput: true }).otherFields).toEqual({ user_prompt: first.user_prompt });
    expect(hasTestData({ testData: { text: "x" } })).toBe(true);
    expect(hasTestData({ testData: {} })).toBe(false);
    expect(hasTestData({ label: "Run" })).toBe(false);
    expect(canvasRunPreview({ nodeId: "t", status: "success", startedAt: T0, input: first, output: { triggered: true } }, (id) => id).input).toBe(
      first.user_prompt
    );
    expect(
      canvasRunPreview({ nodeId: "t", status: "success", startedAt: T0, input: first, output: { triggered: true } }, (id) => id, { hasOwnTestData: true }).input
    ).toBeUndefined();
  });

  it("handles missing and non-object input", () => {
    expect(splitNodeInput(undefined)).toEqual({ receivedFrom: [], otherFields: {}, runContext: {} });
    expect(splitNodeInput("raw").otherFields).toEqual({ value: "raw" });
  });
});

describe("output summaries", () => {
  it("counts items of arrays and item lists", () => {
    expect(outputItemCount(undefined)).toBe(0);
    expect(outputItemCount(null)).toBe(0);
    expect(outputItemCount([1, 2, 3])).toBe(3);
    expect(outputItemCount({ items: [{}, {}], count: 2 })).toBe(2);
    expect(outputItemCount({ text: "x" })).toBe(1);
  });

  it("previews values, not key names, preferring result and text and skipping internal keys", () => {
    const preview = compactOutputPreview({ triggered: true, label: "Run", text: "Hello world", _branchHandle: "pass", nested: { a: 1 } });
    expect(preview.startsWith("text: Hello world")).toBe(true);
    expect(preview).toContain("triggered: true");
    expect(preview).not.toContain("_branchHandle");
    expect(compactOutputPreview({ redacted: "same", result: "same" })).toBe("result: same");
    expect(compactOutputPreview([{ id: 1 }, { id: 2 }])).toBe("[2] id: 1");
    expect(compactOutputPreview("x".repeat(500), 20)).toHaveLength(20);
  });

  it("formats durations", () => {
    expect(formatRunDuration(28)).toBe("28 ms");
    expect(formatRunDuration(1500)).toBe("1.50 s");
    expect(formatRunDuration(125_000)).toBe("2 m 5 s");
    expect(formatRunDuration(undefined)).toBeUndefined();
  });
});

describe("run records", () => {
  const consumed: NodeExecutionResult = {
    nodeId: "protect",
    status: "success",
    startedAt: T0,
    output: { reason: "attachment_consumed_by_agent", handle: "protection", usedByNodeId: "rules" }
  };

  it("reads which agent used an attachment node", () => {
    expect(attachmentUse(consumed)).toEqual({ usedByNodeId: "rules", handle: "protection" });
    expect(attachmentUse({ output: { text: "x" } })).toBeUndefined();
    expect(canvasRunPreview(consumed, () => "Content Rules")).toEqual({ usedBy: "used by Content Rules as its protection provider" });
  });

  it("marks outputs that came from pinned data", () => {
    expect(usedPinnedData({ warnings: ["Used pinned data; node executor was not called."] })).toBe(true);
    expect(usedPinnedData({ warnings: [] })).toBe(false);
  });

  it("orders the run's steps by start time and leaves attachments out", () => {
    const result: WorkflowExecutionResult = {
      workflowId: "wf",
      status: "success",
      startedAt: T0,
      completedAt: T0,
      nodeResults: [
        { nodeId: "b", status: "success", startedAt: "2026-01-01T00:00:02.000Z" },
        consumed,
        { nodeId: "a", status: "success", startedAt: "2026-01-01T00:00:01.000Z" },
        { nodeId: "c", status: "skipped", startedAt: "" }
      ]
    };
    expect(runStepOrder(result)).toEqual(["a", "b", "c"]);
    expect(runStepOrder(null)).toEqual([]);
  });

  it("summarises a node for its canvas card", () => {
    const result: NodeExecutionResult = { nodeId: "s", status: "success", startedAt: T0, durationMs: 28, output: { items: [1, 2, 3], count: 3 } };
    expect(canvasRunPreview(result, (id) => id)).toEqual({ meta: "success · 3 items · 28 ms", output: "count: 3 · items: [3]" });
    expect(canvasRunPreview({ nodeId: "k", status: "skipped", startedAt: T0, durationMs: 0 }, (id) => id)).toEqual({ meta: "skipped" });
    expect(canvasRunPreview({ nodeId: "r", status: "running", startedAt: T0 }, (id) => id)).toEqual({ meta: "running" });
  });
});

describe("a Loop body node's passes on the canvas", () => {
  const pass = (n: number, output: unknown, status: "success" | "error" = "success") => ({
    nodeId: "body",
    status,
    startedAt: T0,
    durationMs: 10,
    input: { _loop_index: n - 1 },
    output
  });

  it("counts as passes only results recorded inside a loop", () => {
    const passes = [pass(1, {}), pass(2, {})];
    const other = { nodeId: "body", status: "success" as const, startedAt: T0, input: {}, output: {} };
    expect(loopPassResults([...passes, other, { ...passes[0]!, nodeId: "x" }], "body")).toEqual(passes);
  });

  it("counts every pass and the items of all of them, not only the last pass", () => {
    const passes = [pass(1, { a: 1 }), pass(2, { a: 2 }), pass(3, [1, 2])];
    expect(canvasRunPreview(passes[2]!, (id) => id, { passes }).meta).toBe("success · 3 passes · 4 items · 30 ms");
    expect(canvasRunPreview(passes[2]!, (id) => id, { passes }).output).toBe(compactOutputPreview([1, 2]));
  });

  it("keeps the one-pass summary for a node that ran once", () => {
    const only = pass(1, { a: 1 });
    expect(canvasRunPreview(only, (id) => id, { passes: [only] }).meta).toBe("success · 1 item · 10 ms");
  });
});

describe("the result a node's card shows", () => {
  const at = "2026-01-01T00:00:00.000Z";
  it("a Loop body node that failed a pass shows failed, though the run walk marked it skipped after the Loop failed", () => {
    const shown = nodeCardResults([
      { nodeId: "loop", status: "error", startedAt: at, error: "Loop node 'loop' failed at iteration 0 on child 'line_total'" },
      { nodeId: "line_total", status: "error", startedAt: at, input: { _loop_index: 0 }, error: "Template {{item.nope}} has no value" },
      { nodeId: "line_total", status: "skipped", startedAt: at },
      { nodeId: "after", status: "skipped", startedAt: at }
    ]);
    expect(shown.get("line_total")).toMatchObject({ status: "error", error: "Template {{item.nope}} has no value" });
    expect(shown.get("after")?.status).toBe("skipped");
    expect(shown.get("loop")?.status).toBe("error");
  });

  it("keeps the last pass otherwise, and a handled failure over a later success", () => {
    const shown = nodeCardResults([
      { nodeId: "body", status: "success", startedAt: at, output: { n: 1 } },
      { nodeId: "body", status: "success", startedAt: at, output: { n: 2 } },
      { nodeId: "guarded", status: "error", handled: true, startedAt: at },
      { nodeId: "guarded", status: "success", startedAt: at }
    ]);
    expect(shown.get("body")?.output).toEqual({ n: 2 });
    expect(shown.get("guarded")).toMatchObject({ status: "error", handled: true });
  });
});

