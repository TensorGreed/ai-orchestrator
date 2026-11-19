import { describe, expect, it } from "vitest";
import type { Workflow } from "@ai-orchestrator/shared";
import { MAX_TEMPLATE_COMPANIONS, templateCompanions, withRemappedWorkflowReferences } from "./template-companions";

function exportOf(id: string, nodes: Array<{ id: string; type: string; config?: Record<string, unknown> }> = [{ id: "out", type: "output" }]) {
  return {
    schemaVersion: "1.0.0",
    workflow: {
      id,
      name: id,
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: nodes.map((node) => ({ ...node, name: node.id, position: { x: 0, y: 0 }, config: node.config ?? {} })),
      edges: []
    }
  };
}

describe("templateCompanions", () => {
  it("is empty for a plain workflow, an export without companions and text that is not JSON", () => {
    expect(templateCompanions(JSON.stringify(exportOf("parent").workflow))).toEqual([]);
    expect(templateCompanions(JSON.stringify(exportOf("parent")))).toEqual([]);
    expect(templateCompanions("not json")).toEqual([]);
  });

  it("imports each companion export", () => {
    const companions = templateCompanions(JSON.stringify({ ...exportOf("parent"), companions: [exportOf("child-a"), exportOf("child-b")] }));
    expect(companions.map((companion) => companion.id)).toEqual(["child-a", "child-b"]);
  });

  it("refuses an invalid companion and too many companions", () => {
    expect(() => templateCompanions(JSON.stringify({ ...exportOf("parent"), companions: [{ workflow: { id: "x" } }] }))).toThrow();
    const many = Array.from({ length: MAX_TEMPLATE_COMPANIONS + 1 }, (_, index) => exportOf(`c${index}`));
    expect(() => templateCompanions(JSON.stringify({ ...exportOf("parent"), companions: many }))).toThrow(/at most/);
  });
});

describe("withRemappedWorkflowReferences", () => {
  it("points Execute Workflow and Workflow Tool nodes at the new ids and leaves the rest alone", () => {
    const workflow = exportOf("parent", [
      { id: "call", type: "execute_workflow", config: { workflowId: "child", mode: "sync" } },
      { id: "tool", type: "workflow_tool", config: { workflowId: " child " } },
      { id: "other", type: "execute_workflow", config: { workflowId: "elsewhere" } },
      { id: "set", type: "set_node", config: { workflowId: "child" } }
    ]).workflow as unknown as Workflow;
    const remapped = withRemappedWorkflowReferences(workflow, new Map([["child", "new-child"]]));
    expect(remapped.nodes.map((node) => node.config.workflowId)).toEqual(["new-child", "new-child", "elsewhere", "child"]);
    expect(remapped.nodes[0]!.config.mode).toBe("sync");
    expect(workflow.nodes[0]!.config.workflowId).toBe("child");
  });
});
