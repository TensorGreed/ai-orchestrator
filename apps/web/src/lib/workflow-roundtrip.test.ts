import { describe, expect, it } from "vitest";
import type { Workflow } from "@ai-orchestrator/shared";
import { editorToWorkflow, workflowToEditor } from "./workflow";

describe("editor round trip", () => {
  it("keeps a node's errorConfig and fields the editor does not show", () => {
    const workflow = {
      id: "wf",
      name: "wf",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        {
          id: "call",
          type: "http_request",
          name: "Call",
          position: { x: 10, y: 20 },
          config: { method: "GET", urlTemplate: "https://x.test" },
          errorConfig: { retryOnFail: true, maxRetries: 3, retryIntervalMs: 250 },
          notes: "kept"
        },
        { id: "out", type: "output", name: "Out", position: { x: 300, y: 20 }, config: {} }
      ],
      edges: [{ id: "e1", source: "call", target: "out" }]
    } as unknown as Workflow;
    const { nodes, edges } = workflowToEditor(workflow);
    const edited = nodes.map((node) => (node.id === "call" ? { ...node, data: { ...node.data, label: "Call API", config: { ...node.data.config, timeoutMs: 5000 } } } : node));
    const saved = editorToWorkflow(workflow, edited, edges);
    const call = saved.nodes.find((node) => node.id === "call")! as Workflow["nodes"][number] & { notes?: string };
    expect(call.errorConfig).toEqual({ retryOnFail: true, maxRetries: 3, retryIntervalMs: 250 });
    expect(call.notes).toBe("kept");
    expect(call.name).toBe("Call API");
    expect(call.config.timeoutMs).toBe(5000);
    expect(saved.nodes.find((node) => node.id === "out")).not.toHaveProperty("errorConfig");
  });
});
