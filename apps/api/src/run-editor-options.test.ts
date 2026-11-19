import { describe, expect, it } from "vitest";
import { editorRunOptionsRefused, personalSessionOwner, roleMayEdit, savedRunLimits } from "./run-editor-options.js";

describe("editor run options", () => {
  it("are for someone who may edit the workflow, which takes a builder role or higher", () => {
    expect(roleMayEdit("admin")).toBe(true);
    expect(roleMayEdit("builder")).toBe(true);
    expect(roleMayEdit("operator")).toBe(false);
    expect(roleMayEdit("viewer")).toBe(false);
    expect(editorRunOptionsRefused(true, { startNodeId: "x", pinnedData: {}, workflow: {} })).toEqual([]);
  });

  it("names what someone who may not edit may not set, ignoring the harmless values", () => {
    expect(editorRunOptionsRefused(false, { input: { a: 1 }, sessionId: "s", runMode: "workflow", usePinnedData: false, record: false })).toEqual([]);
    expect(
      editorRunOptionsRefused(false, {
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
    expect(editorRunOptionsRefused(false, null)).toEqual([]);
    expect(editorRunOptionsRefused(false, "text")).toEqual([]);
  });

  it("runs the request of someone who may not edit without pinned data and within the deployment's timeout", () => {
    expect(savedRunLimits(true, 900_000, 300_000)).toEqual({ executionTimeoutMs: 900_000 });
    expect(savedRunLimits(false, 900_000, 300_000)).toEqual({ usePinnedData: false, pinnedData: undefined, executionTimeoutMs: 300_000 });
    expect(savedRunLimits(false, 60_000, 300_000).executionTimeoutMs).toBe(60_000);
  });
});

describe("whose sessions a run uses", () => {
  const editor = { shareOnly: false, mayEdit: true };
  const runner = { shareOnly: false, mayEdit: false };
  const shareOnly = { shareOnly: true, mayEdit: false };
  it("their own for a signed-in person who may not edit, the workflow's for one who may and for API keys", () => {
    expect(personalSessionOwner({ id: "o" }, runner)).toBe("o");
    expect(personalSessionOwner({ id: "b" }, editor)).toBeUndefined();
    expect(personalSessionOwner({ id: "o", apiKeyId: "k" }, runner)).toBeUndefined();
    expect(personalSessionOwner({ id: "b", apiKeyId: "k" }, editor)).toBeUndefined();
  });

  it("their own for every share-only runner, with a key of their own too; never for a service account", () => {
    expect(personalSessionOwner({ id: "s" }, shareOnly)).toBe("s");
    expect(personalSessionOwner({ id: "s", apiKeyId: "k" }, shareOnly)).toBe("s");
    expect(personalSessionOwner({ id: "svc", serviceAccount: true }, shareOnly)).toBeUndefined();
    expect(personalSessionOwner({ id: "svc", serviceAccount: true }, runner)).toBeUndefined();
  });
});
