import { describe, expect, it } from "vitest";
import { diffWorkflows, type DiffableWorkflow } from "./workflow-diff";

function base(): DiffableWorkflow {
  return {
    id: "wf",
    name: "Flow",
    schemaVersion: "1.0.0",
    workflowVersion: 3,
    updatedAt: "2026-01-01T00:00:00.000Z",
    nodes: [
      { id: "in", type: "text_input", name: "Input", position: { x: 0, y: 0 }, config: { text: "hi" } },
      { id: "llm", type: "llm_call", name: "Model", position: { x: 200, y: 0 }, config: { model: "a", temperature: 0.2 } },
      { id: "out", type: "output", name: "Output", position: { x: 400, y: 0 }, config: {} }
    ],
    edges: [
      { id: "e1", source: "in", target: "llm" },
      { id: "e2", source: "llm", target: "out" }
    ]
  };
}

describe("diffWorkflows", () => {
  it("reports identical workflows, ignoring positions, timestamps and versions", () => {
    const after = base();
    after.nodes![0]!.position = { x: 50, y: 50 };
    after.updatedAt = "2026-02-02T00:00:00.000Z";
    after.workflowVersion = 9;
    const diff = diffWorkflows(base(), after);
    expect(diff.identical).toBe(true);
    expect(diff.nodes.moved).toBe(1);
  });

  it("lists added, removed and changed nodes with the fields that changed", () => {
    const after = base();
    after.nodes = [
      after.nodes![0]!,
      { ...after.nodes![1]!, name: "Model 2", config: { model: "b", temperature: 0.2 } },
      { id: "set", type: "set_node", name: "Set", position: { x: 0, y: 0 }, config: {} }
    ];
    const diff = diffWorkflows(base(), after);
    expect(diff.identical).toBe(false);
    expect(diff.nodes.added).toEqual([{ id: "set", name: "Set", type: "set_node" }]);
    expect(diff.nodes.removed).toEqual([{ id: "out", name: "Output", type: "output" }]);
    expect(diff.nodes.changed).toEqual([{ id: "llm", name: "Model 2", type: "llm_call", fields: ["config.model", "name"] }]);
  });

  it("matches edges by id, then by their ends", () => {
    const after = base();
    after.edges = [
      { id: "renamed", source: "in", target: "llm" },
      { id: "e2", source: "in", target: "out" },
      { id: "e3", source: "llm", target: "out", sourceHandle: "error" }
    ];
    const diff = diffWorkflows(base(), after);
    expect(diff.edges.added.map((edge) => edge.id)).toEqual(["e3"]);
    expect(diff.edges.changed.map((edge) => edge.id)).toEqual(["e2"]);
    expect(diff.edges.removed).toEqual([]);
    const fewer = base();
    fewer.edges = [fewer.edges![0]!];
    expect(diffWorkflows(base(), fewer).edges.removed.map((edge) => edge.id)).toEqual(["e2"]);
  });

  it("lists workflow-level fields that differ", () => {
    const after = { ...base(), name: "Other", settings: { strict: true } };
    expect(diffWorkflows(base(), after).fields).toEqual(["name", "settings"]);
    // Unset and empty are the same; no project is the default project.
    expect(diffWorkflows({ ...base(), tags: [], projectId: "default" }, { ...base(), settings: {} }, { defaultProjectId: "default" }).identical).toBe(true);
    expect(diffWorkflows({ ...base(), projectId: "p2" }, base(), { defaultProjectId: "default" }).fields).toEqual(["projectId"]);
  });
});
