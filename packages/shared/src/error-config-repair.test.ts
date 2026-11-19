import { describe, expect, it } from "vitest";
import { repairNodeErrorConfig, repairWorkflowErrorConfigs, workflowSchema } from "./schemas";

describe("repairNodeErrorConfig", () => {
  it("keeps a valid errorConfig whole", () => {
    expect(repairNodeErrorConfig({ retryOnFail: true, maxRetries: 3, retryIntervalMs: 500 })).toEqual({
      errorConfig: { retryOnFail: true, maxRetries: 3, retryIntervalMs: 500 },
      invalidFields: []
    });
    expect(repairNodeErrorConfig(undefined)).toEqual({ invalidFields: [] });
  });

  it("drops only the invalid fields, and names them", () => {
    expect(repairNodeErrorConfig({ continueOnFail: true, maxRetries: -1, retryIntervalMs: "soon", maxRetriesExtra: 1 })).toEqual({
      errorConfig: { continueOnFail: true },
      invalidFields: ["maxRetries", "retryIntervalMs"]
    });
    expect(repairNodeErrorConfig({ maxRetries: 1.5 })).toEqual({ invalidFields: ["maxRetries"] });
  });

  it("treats a non-object errorConfig as invalid as a whole", () => {
    expect(repairNodeErrorConfig("retry")).toEqual({ invalidFields: ["errorConfig"] });
    expect(repairNodeErrorConfig([1])).toEqual({ invalidFields: ["errorConfig"] });
    expect(repairNodeErrorConfig(null)).toEqual({ invalidFields: ["errorConfig"] });
  });
});

describe("repairWorkflowErrorConfigs", () => {
  const base = {
    id: "wf",
    name: "wf",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    edges: []
  };

  it("returns the same object when nothing needs repair", () => {
    const workflow = { ...base, nodes: [{ id: "a", type: "text_input", name: "A", position: { x: 0, y: 0 }, config: {}, errorConfig: { continueOnFail: true } }] };
    const repaired = repairWorkflowErrorConfigs(workflow);
    expect(repaired.workflow).toBe(workflow);
    expect(repaired.repaired).toEqual([]);
  });

  it("makes a stored workflow with an invalid errorConfig parse, without changing the input", () => {
    const workflow = {
      ...base,
      nodes: [
        { id: "a", type: "text_input", name: "A", position: { x: 0, y: 0 }, config: {}, errorConfig: { maxRetries: -1 } },
        { id: "b", type: "text_input", name: "B", position: { x: 0, y: 0 }, config: {}, errorConfig: { maxRetries: "x", continueOnFail: true } }
      ]
    };
    expect(workflowSchema.safeParse(workflow).success).toBe(false);
    const { workflow: repaired, repaired: notes } = repairWorkflowErrorConfigs(workflow);
    expect(notes).toEqual([
      { nodeId: "a", invalidFields: ["maxRetries"] },
      { nodeId: "b", invalidFields: ["maxRetries"] }
    ]);
    const parsed = workflowSchema.parse(repaired);
    expect(parsed.nodes[0]!.errorConfig).toBeUndefined();
    expect(parsed.nodes[1]!.errorConfig).toEqual({ continueOnFail: true });
    expect(workflow.nodes[0]!.errorConfig).toEqual({ maxRetries: -1 });
  });

  it("leaves non-workflow input alone", () => {
    expect(repairWorkflowErrorConfigs("x").workflow).toBe("x");
    expect(repairWorkflowErrorConfigs({ nodes: "no" }).repaired).toEqual([]);
  });
});
