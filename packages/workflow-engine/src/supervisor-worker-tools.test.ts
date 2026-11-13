import { describe, expect, it } from "vitest";
import { DefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry, type LLMProviderAdapter, type ProviderCallRequest } from "@ai-orchestrator/provider-sdk";
import type { Workflow, WorkflowEdge, WorkflowNode } from "@ai-orchestrator/shared";
import { executeWorkflow } from "./executor";

/** Scripted model: records the tools each call is offered and answers at once, so no worker runs. */
class RecordingProvider implements LLMProviderAdapter {
  readonly definition = { id: "scripted", label: "Scripted", supportsTools: true, configSchema: {} };
  readonly calls: ProviderCallRequest[] = [];

  async generate(request: ProviderCallRequest) {
    this.calls.push(request);
    return { content: "final answer", toolCalls: [] };
  }
}

function node(id: string, type: string, name: string, config: Record<string, unknown> = {}): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], name, position: { x: 0, y: 0 }, config };
}

function edge(source: string, target: string, sourceHandle?: string): WorkflowEdge {
  return { id: `${source}-${sourceHandle ?? "main"}-${target}`, source, target, ...(sourceHandle ? { sourceHandle } : {}) };
}

async function offeredTools(extraNodes: WorkflowNode[], extraEdges: WorkflowEdge[]) {
  const provider = new RecordingProvider();
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(provider);
  const workflow: Workflow = {
    id: "wf-supervisor-worker-tools",
    name: "Supervisor worker tools",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      node("trigger", "webhook_input", "Trigger"),
      // The prompt matches the Researcher's name and hint strongly, and the other workers not at all.
      node("sup", "supervisor_node", "Lead", {
        systemPromptTemplate: "You coordinate a team.",
        userPromptTemplate: "Research the quantum computing market",
        maxIterations: 2,
        toolCallingEnabled: true
      }),
      node("researcher", "agent_orchestrator", "Researcher", { systemPromptTemplate: "You research markets.", userPromptTemplate: "{{user_prompt}}", maxIterations: 2 }),
      node("writer", "agent_orchestrator", "Writer", { systemPromptTemplate: "You draft prose.", userPromptTemplate: "{{user_prompt}}", maxIterations: 2 }),
      node("critic", "agent_orchestrator", "Critic", { systemPromptTemplate: "You review drafts.", userPromptTemplate: "{{user_prompt}}", maxIterations: 2 }),
      node("model", "llm_call", "Model", { provider: { providerId: "scripted", model: "m" } }),
      node("output", "output", "Output"),
      ...extraNodes
    ],
    edges: [
      edge("trigger", "sup"),
      edge("sup", "output"),
      edge("sup", "model", "chat_model"),
      edge("sup", "researcher", "worker"),
      edge("sup", "writer", "worker"),
      edge("sup", "critic", "worker"),
      edge("researcher", "model", "chat_model"),
      edge("writer", "model", "chat_model"),
      edge("critic", "model", "chat_model"),
      ...extraEdges
    ]
  };
  const result = await executeWorkflow(
    { workflow },
    {
      providerRegistry,
      mcpRegistry: createDefaultMCPRegistry(),
      connectorRegistry: createDefaultConnectorRegistry(),
      agentRuntime: new DefaultAgentRuntime(),
      resolveSecret: async () => undefined
    }
  );
  expect(result.status, result.error).toBe("success");
  return (provider.calls[0]?.tools ?? []).map((tool) => tool.name);
}

describe("Supervisor worker tools", () => {
  it("offers every worker when the Supervisor has no tool nodes, however the prompt reads", async () => {
    const names = await offeredTools([], []);
    expect(names).toEqual(expect.arrayContaining(["delegate_to_Researcher", "delegate_to_Writer", "delegate_to_Critic"]));
  });

  it("offers every worker next to the tools of an attached MCP Tool node", async () => {
    const names = await offeredTools(
      [node("tool", "mcp_tool", "Calculator", { serverId: "mock-mcp", toolName: "calculator", allowedTools: ["calculator"] })],
      [edge("sup", "tool", "tool")]
    );
    expect(names).toEqual(expect.arrayContaining(["mock-mcp__calculator", "delegate_to_Researcher", "delegate_to_Writer", "delegate_to_Critic"]));
  });
});
