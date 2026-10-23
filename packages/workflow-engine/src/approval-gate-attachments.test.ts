import { describe, expect, it, vi } from "vitest";
import { DefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry } from "@ai-orchestrator/provider-sdk";
import type { Workflow, WorkflowEdge, WorkflowNode } from "@ai-orchestrator/shared";

/**
 * Defence in depth for the attachment-bypass validation rule: a stored
 * workflow saved before the rule can still hold a node below a gate that is
 * also attached to an agent outside it. With validation out of the way, the
 * start-node check alone must refuse a single-node run at that agent.
 */
vi.mock("./validation", async (importOriginal) => {
  const original = await importOriginal<typeof import("./validation")>();
  return {
    ...original,
    validateWorkflowGraph: (workflow: Workflow) => ({ valid: true, issues: [], orderedNodeIds: original.sortWorkflowNodes(workflow) })
  };
});

const { executeWorkflow } = await import("./executor");

function node(id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], name: id, position: { x: 0, y: 0 }, config };
}

describe("approval gate attachment closure", () => {
  it("refuses a single-node run at an agent whose worker is below a gate", async () => {
    const edges: Array<Omit<WorkflowEdge, "id">> = [
      { source: "in", target: "sup" },
      { source: "in", target: "gate" },
      { source: "gate", sourceHandle: "approved", target: "w" },
      { source: "w", target: "out" },
      { source: "sup", sourceHandle: "chat_model", target: "supm" },
      { source: "sup", sourceHandle: "worker", target: "w" },
      { source: "w", sourceHandle: "chat_model", target: "wm" },
      { source: "sup", target: "out2" }
    ];
    const wf: Workflow = {
      id: "dual-old",
      name: "dual-old",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        node("in", "manual_trigger"),
        node("sup", "supervisor_node", { maxIterations: 2, userPromptTemplate: "go" }),
        node("gate", "approval_gate", { message: "ok?" }),
        node("supm", "llm_call", { provider: { providerId: "scripted", model: "m" } }),
        node("w", "agent_orchestrator", { userPromptTemplate: "x", maxIterations: 2 }),
        node("wm", "llm_call", { provider: { providerId: "scripted", model: "m" } }),
        node("out", "output"),
        node("out2", "output")
      ],
      edges: edges.map((edge, index) => ({ id: `e${index}`, ...edge }))
    };
    const result = await executeWorkflow(
      { workflow: wf, executionId: "exec-old", startNodeId: "sup", runMode: "single_node" },
      {
        providerRegistry: new ProviderRegistry(),
        connectorRegistry: createDefaultConnectorRegistry(),
        mcpRegistry: createDefaultMCPRegistry(),
        agentRuntime: new DefaultAgentRuntime(),
        resolveSecret: async () => undefined,
        persistPausedExecution: async () => {}
      } as never
    );
    expect(result.status).toBe("error");
    expect(result.error).toBe("This run would start after Approval Gate 'gate'. Start at or before the gate.");
    expect(result.nodeResults).toHaveLength(0);
  });
});
