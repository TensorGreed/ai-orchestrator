import { describe, expect, it } from "vitest";
import { editorRunOptionsRefused, roleMayUseEditorRunOptions } from "./run-editor-options.js";

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
        variables: {},
        record: true,
        workflow: {},
        nodes: [],
        edges: []
      })
    ).toEqual(["startNodeId", "runMode", "usePinnedData", "pinnedData", "nodeOutputs", "sourceExecutionId", "nodeOutputsExecutionId", "variables", "record", "workflow", "nodes", "edges"]);
    expect(editorRunOptionsRefused("operator", null)).toEqual([]);
    expect(editorRunOptionsRefused("operator", "text")).toEqual([]);
  });
});
