import { describe, expect, it } from "vitest";
import type { AgentRuntimeAdapter } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry, type LLMProviderAdapter } from "@ai-orchestrator/provider-sdk";
import type { AgentRunRequest, AgentRunState, Workflow } from "@ai-orchestrator/shared";
import { executeWorkflow } from "./executor";
import { exportWorkflowToJson, importWorkflowFromJson } from "./serialization";
import { validateWorkflowGraph } from "./validation";

class FakeProvider implements LLMProviderAdapter {
  readonly definition = {
    id: "fake",
    label: "Fake",
    supportsTools: true,
    configSchema: {}
  };

  async generate() {
    return {
      content: "mock-response",
      toolCalls: []
    };
  }
}

class FakeAgentRuntime implements AgentRuntimeAdapter {
  readonly id = "fake-agent";

  async run(request: AgentRunRequest): Promise<AgentRunState> {
    return {
      finalAnswer: `agent:${request.userPrompt}`,
      stopReason: "final_answer",
      iterations: 1,
      messages: [],
      steps: []
    };
  }
}

class CapturingAgentRuntime implements AgentRuntimeAdapter {
  readonly id = "capturing-agent";
  lastRequest: AgentRunRequest | null = null;

  async run(request: AgentRunRequest): Promise<AgentRunState> {
    this.lastRequest = request;
    return {
      finalAnswer: `captured:${request.userPrompt}`,
      stopReason: "final_answer",
      iterations: 1,
      messages: [],
      steps: []
    };
  }
}

function createProviderRegistry() {
  const registry = new ProviderRegistry();
  registry.register(new FakeProvider());
  return registry;
}

function basicWorkflow(): Workflow {
  return {
    id: "wf-basic",
    name: "Basic flow",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      {
        id: "n1",
        type: "text_input",
        name: "Text Input",
        position: { x: 0, y: 0 },
        config: { text: "hello" }
      },
      {
        id: "n2",
        type: "prompt_template",
        name: "Prompt Template",
        position: { x: 200, y: 0 },
        config: { template: "Say {{text}}" }
      },
      {
        id: "n3",
        type: "llm_call",
        name: "LLM",
        position: { x: 400, y: 0 },
        config: { provider: { providerId: "fake", model: "fake-model" } }
      },
      {
        id: "n4",
        type: "output",
        name: "Output",
        position: { x: 600, y: 0 },
        config: { responseTemplate: "{{answer}}" }
      }
    ],
    edges: [
      { id: "e1", source: "n1", target: "n2" },
      { id: "e2", source: "n2", target: "n3" },
      { id: "e3", source: "n3", target: "n4" }
    ]
  };
}

describe("workflow engine", () => {
  it("validates DAG and detects cycles", () => {
    const workflow = basicWorkflow();
    const valid = validateWorkflowGraph(workflow);
    expect(valid.valid).toBe(true);

    workflow.edges.push({ id: "e4", source: "n4", target: "n2" });
    const invalid = validateWorkflowGraph(workflow);
    expect(invalid.valid).toBe(false);
    expect(invalid.issues.some((issue) => issue.code === "cycle_detected")).toBe(true);
  });

  it("executes basic flow", async () => {
    const workflow = basicWorkflow();
    const result = await executeWorkflow(
      { workflow },
      {
        providerRegistry: createProviderRegistry(),
        connectorRegistry: createDefaultConnectorRegistry(),
        mcpRegistry: createDefaultMCPRegistry(),
        agentRuntime: new FakeAgentRuntime(),
        resolveSecret: async () => undefined
      }
    );

    expect(result.status).toBe("success");
    expect(result.nodeResults.length).toBe(4);
  });

  it("requires chat_model attachment for agent orchestrator nodes", () => {
    const workflow: Workflow = {
      id: "wf-agent-no-model",
      name: "Agent missing chat model",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        {
          id: "webhook",
          type: "webhook_input",
          name: "Webhook",
          position: { x: 0, y: 0 },
          config: {}
        },
        {
          id: "agent",
          type: "agent_orchestrator",
          name: "Agent",
          position: { x: 240, y: 0 },
          config: {
            systemPromptTemplate: "{{system_prompt}}",
            userPromptTemplate: "{{user_prompt}}",
            maxIterations: 4,
            toolCallingEnabled: true
          }
        },
        {
          id: "output",
          type: "output",
          name: "Output",
          position: { x: 480, y: 0 },
          config: { responseTemplate: "{{answer}}" }
        }
      ],
      edges: [
        { id: "e-main-1", source: "webhook", target: "agent" },
        { id: "e-main-2", source: "agent", target: "output" }
      ]
    };

    const validation = validateWorkflowGraph(workflow);
    expect(validation.valid).toBe(false);
    expect(validation.issues.some((issue) => issue.code === "missing_agent_chat_model")).toBe(true);
  });

  it("round-trips import/export", () => {
    const workflow = basicWorkflow();
    const json = exportWorkflowToJson(workflow);
    const imported = importWorkflowFromJson(json);

    expect(imported.id).toBe(workflow.id);
    expect(imported.nodes[0]?.position.x).toBe(0);
    expect(imported.schemaVersion).toBe("1.0.0");
  });

  it("uses auxiliary agent attachments for chat model, memory, and tools", async () => {
    const runtime = new CapturingAgentRuntime();
    const workflow: Workflow = {
      id: "wf-agent-attachments",
      name: "Agent attachments",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        {
          id: "webhook",
          type: "webhook_input",
          name: "Webhook",
          position: { x: 0, y: 0 },
          config: {}
        },
        {
          id: "agent",
          type: "agent_orchestrator",
          name: "Agent",
          position: { x: 240, y: 0 },
          config: {
            systemPromptTemplate: "{{system_prompt}}",
            userPromptTemplate: "{{user_prompt}}",
            sessionIdTemplate: "{{session_id}}",
            maxIterations: 4,
            toolCallingEnabled: true
          }
        },
        {
          id: "model",
          type: "llm_call",
          name: "Model",
          position: { x: 260, y: 180 },
          config: {
            provider: { providerId: "fake", model: "fake-model" }
          }
        },
        {
          id: "memory",
          type: "local_memory",
          name: "Memory",
          position: { x: 380, y: 180 },
          config: {
            namespace: "default",
            sessionIdTemplate: "{{session_id}}",
            maxMessages: 12,
            persistToolMessages: false
          }
        },
        {
          id: "tool",
          type: "mcp_tool",
          name: "Tool",
          position: { x: 500, y: 180 },
          config: {
            serverId: "mock-mcp",
            toolName: "calculator",
            argsTemplate: "{\"expression\":\"2+2\"}"
          }
        },
        {
          id: "output",
          type: "output",
          name: "Output",
          position: { x: 520, y: 0 },
          config: {}
        }
      ],
      edges: [
        { id: "e-main-1", source: "webhook", target: "agent" },
        { id: "e-main-2", source: "agent", target: "output" },
        { id: "e-attach-model", source: "agent", sourceHandle: "chat_model", target: "model" },
        { id: "e-attach-memory", source: "agent", sourceHandle: "memory", target: "memory" },
        { id: "e-attach-tool", source: "agent", sourceHandle: "tool", target: "tool" }
      ]
    };

    const result = await executeWorkflow(
      {
        workflow,
        webhookPayload: {
          system_prompt: "S",
          user_prompt: "U",
          session_id: "session-abc"
        }
      },
      {
        providerRegistry: createProviderRegistry(),
        connectorRegistry: createDefaultConnectorRegistry(),
        mcpRegistry: createDefaultMCPRegistry(),
        agentRuntime: runtime,
        resolveSecret: async () => undefined
      }
    );

    expect(result.status).toBe("success");
    expect(runtime.lastRequest?.provider.providerId).toBe("fake");
    expect(runtime.lastRequest?.tools.length).toBeGreaterThan(0);
    expect(runtime.lastRequest?.memory?.namespace).toBe("default");
    expect(runtime.lastRequest?.sessionId).toBe("session-abc");
    expect(result.nodeResults.find((entry) => entry.nodeId === "model")?.status).toBe("skipped");
    expect(result.nodeResults.find((entry) => entry.nodeId === "memory")?.status).toBe("skipped");
    expect(result.nodeResults.find((entry) => entry.nodeId === "tool")?.status).toBe("skipped");
  });
});
