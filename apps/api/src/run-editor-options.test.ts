import { describe, expect, it } from "vitest";
import { editorRunOptionsRefused, roleMayUseEditorRunOptions, savedRunLimits } from "./run-editor-options.js";

describe("editor run options", () => {
  it("are a builder's and an admin's", () => {
    expect(roleMayUseEditorRunOptions("admin")).toBe(true);
    expect(roleMayUseEditorRunOptions("builder")).toBe(true);
    expect(roleMayUseEditorRunOptions("operator")).toBe(false);
    expect(editorRunOptionsRefused("builder", { startNodeId: "x", pinnedData: {}, workflow: {} })).toEqual([]);
  });

  it("names what an operator may not set, ignoring the harmless values", () => {
    expect(editorRunOptionsRefused("operator", { input: { a: 1 }, sessionId: "s", runMode: "workflow", usePinnedData: false, record: false })).toEqual([]);
    expect(
      editorRunOptionsRefused("operator", {
        startNodeId: "n",
        runMode: "single_node",
        usePinnedData: true,
        pinnedData: {},
        nodeOutputs: {},
        sourceExecutionId: "e",
        nodeOutputsExecutionId: "e",
        variables: { counted: "as input" },
        record: true,
        workflow: {},
        nodes: [],
        edges: []
      })
    ).toEqual(["startNodeId", "runMode", "usePinnedData", "pinnedData", "nodeOutputs", "sourceExecutionId", "nodeOutputsExecutionId", "record", "workflow", "nodes", "edges"]);
    expect(editorRunOptionsRefused("operator", null)).toEqual([]);
    expect(editorRunOptionsRefused("operator", "text")).toEqual([]);
  });

  it("runs an operator's request without pinned data and within the deployment's timeout", () => {
    expect(savedRunLimits("builder", 900_000, 300_000)).toEqual({ executionTimeoutMs: 900_000 });
    expect(savedRunLimits("operator", 900_000, 300_000)).toEqual({ usePinnedData: false, pinnedData: undefined, executionTimeoutMs: 300_000 });
    expect(savedRunLimits("operator", 60_000, 300_000).executionTimeoutMs).toBe(60_000);
  });
});
