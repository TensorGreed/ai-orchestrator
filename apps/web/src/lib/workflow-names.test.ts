import { describe, expect, it } from "vitest";
import { copyWorkflowName, nextNewWorkflowName, shortWorkflowId, workflowPickerLabel, workflowPickerLabels } from "./workflow-names";

describe("workflow names", () => {
  it("offers a new workflow a Workflow N no other workflow has", () => {
    expect(nextNewWorkflowName([])).toBe("Workflow 1");
    expect(nextNewWorkflowName(["A", "B"])).toBe("Workflow 3");
    // An earlier New workflow already took the next number: skip it.
    expect(nextNewWorkflowName(["Workflow 2", "workflow 3 "])).toBe("Workflow 4");
  });

  it("offers a copy a name no other workflow has", () => {
    expect(copyWorkflowName("Orders", ["Orders"])).toBe("Orders Copy");
    expect(copyWorkflowName("Orders", ["Orders", "Orders Copy"])).toBe("Orders Copy 2");
    expect(copyWorkflowName("Orders", ["Orders", "orders copy", "Orders Copy 2"])).toBe("Orders Copy 3");
  });

  it("adds a short id only to workflows that share a name", () => {
    const labels = workflowPickerLabels([
      { id: "3ad64781-c8f4-499e", name: "VAL Error handler" },
      { id: "wf-9b1c22aa", name: "VAL Error handler" },
      { id: "x", name: "Orders" }
    ]);
    expect(labels.get("3ad64781-c8f4-499e")).toBe("VAL Error handler · 3ad647");
    expect(labels.get("wf-9b1c22aa")).toBe("VAL Error handler · 9b1c22");
    expect(labels.get("x")).toBe("Orders");
    expect(shortWorkflowId("builtin-starter-approval")).toBe("builti");
    const list = [{ id: "a1b2c3d4", name: "Orders" }, { id: "e5f6a7b8", name: "orders" }, { id: "c", name: "Other" }];
    expect(workflowPickerLabel(list, list[0]!)).toBe("Orders · a1b2c3");
    expect(workflowPickerLabel(list, list[2]!)).toBe("Other");
  });
});
