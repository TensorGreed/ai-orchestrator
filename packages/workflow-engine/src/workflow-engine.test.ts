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

  it("captures node input snapshots for runtime inspection", async () => {
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

    const promptNode = result.nodeResults.find((entry) => entry.nodeId === "n2");
    const promptInput = (promptNode?.input ?? null) as Record<string, unknown> | null;
    const promptParentOutputs = promptInput?.parent_outputs as Record<string, unknown> | undefined;
    const textInputOutput = promptParentOutputs?.n1 as Record<string, unknown> | undefined;

    expect(promptNode?.status).toBe("success");
    expect(promptInput).toBeTruthy();
    expect(textInputOutput?.text).toBe("hello");
    expect(promptNode?.output).toBeTruthy();
  });

  it("uses webhook prompt for text_input nodes during webhook-triggered runs", async () => {
    const workflow: Workflow = {
      id: "wf-webhook-overrides-text-input",
      name: "Webhook overrides Text Input",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        {
          id: "text",
          type: "text_input",
          name: "Text Input",
          position: { x: 0, y: 0 },
          config: { text: "node-default-text" }
        },
        {
          id: "output",
          type: "output",
          name: "Output",
          position: { x: 220, y: 0 },
          config: { responseTemplate: "{{user_prompt}}" }
        }
      ],
      edges: [{ id: "e1", source: "text", target: "output" }]
    };

    const result = await executeWorkflow(
      {
        workflow,
        triggerType: "webhook",
        webhookPayload: {
          user_prompt: "prompt-from-webhook"
        }
      },
      {
        providerRegistry: createProviderRegistry(),
        connectorRegistry: createDefaultConnectorRegistry(),
        mcpRegistry: createDefaultMCPRegistry(),
        agentRuntime: new FakeAgentRuntime(),
        resolveSecret: async () => undefined
      }
    );

    expect(result.status).toBe("success");
    const textNodeOutput = result.nodeResults.find((entry) => entry.nodeId === "text")?.output as Record<string, unknown>;
    expect(textNodeOutput.user_prompt).toBe("prompt-from-webhook");
    expect(textNodeOutput.text).toBe("prompt-from-webhook");
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

  it("rejects mixing multiple primary input types directly into one agent", () => {
    const workflow: Workflow = {
      id: "wf-agent-mixed-primary-inputs",
      name: "Agent with mixed primary inputs",
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
          id: "text",
          type: "text_input",
          name: "Text Input",
          position: { x: 0, y: 120 },
          config: { text: "hello" }
        },
        {
          id: "agent",
          type: "agent_orchestrator",
          name: "Agent",
          position: { x: 240, y: 60 },
          config: {
            systemPromptTemplate: "{{system_prompt}}",
            userPromptTemplate: "{{user_prompt}}",
            maxIterations: 2,
            toolCallingEnabled: true
          }
        },
        {
          id: "model",
          type: "llm_call",
          name: "Model",
          position: { x: 260, y: 220 },
          config: {
            provider: { providerId: "fake", model: "fake-model" }
          }
        },
        {
          id: "output",
          type: "output",
          name: "Output",
          position: { x: 500, y: 60 },
          config: { responseTemplate: "{{answer}}" }
        }
      ],
      edges: [
        { id: "e-webhook-agent", source: "webhook", target: "agent" },
        { id: "e-text-agent", source: "text", target: "agent" },
        { id: "e-agent-output", source: "agent", target: "output" },
        { id: "e-agent-model", source: "agent", sourceHandle: "chat_model", target: "model" }
      ]
    };

    const validation = validateWorkflowGraph(workflow);
    expect(validation.valid).toBe(false);
    expect(validation.issues.some((issue) => issue.code === "mixed_agent_primary_inputs")).toBe(true);
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

  it("output_parser: item_list mode splits text into items", async () => {
    const workflow: Workflow = {
      id: "wf-parser-list",
      name: "Parser item list",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        { id: "n1", type: "text_input", name: "Input", position: { x: 0, y: 0 }, config: { text: "apple\nbanana\ncherry" } },
        { id: "n2", type: "output_parser", name: "Parser", position: { x: 200, y: 0 }, config: { mode: "item_list", inputKey: "text", itemSeparator: "\n" } },
        { id: "n3", type: "output", name: "Output", position: { x: 400, y: 0 }, config: {} }
      ],
      edges: [
        { id: "e1", source: "n1", target: "n2" },
        { id: "e2", source: "n2", target: "n3" }
      ]
    };

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
    const parserOutput = result.nodeResults.find((entry) => entry.nodeId === "n2")?.output as Record<string, unknown>;
    expect(parserOutput.items).toEqual(["apple", "banana", "cherry"]);
    expect(parserOutput.count).toBe(3);
  });

  it("output_parser: json_schema mode validates valid JSON", async () => {
    const workflow: Workflow = {
      id: "wf-parser-schema",
      name: "Parser schema",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        { id: "n1", type: "text_input", name: "Input", position: { x: 0, y: 0 }, config: { text: '{"name":"Alice","sentiment":"positive"}' } },
        {
          id: "n2",
          type: "output_parser",
          name: "Parser",
          position: { x: 200, y: 0 },
          config: {
            mode: "json_schema",
            inputKey: "text",
            jsonSchema: '{"type":"object","properties":{"name":{"type":"string"},"sentiment":{"type":"string","enum":["positive","negative","neutral"]}},"required":["name","sentiment"]}'
          }
        },
        { id: "n3", type: "output", name: "Output", position: { x: 400, y: 0 }, config: {} }
      ],
      edges: [
        { id: "e1", source: "n1", target: "n2" },
        { id: "e2", source: "n2", target: "n3" }
      ]
    };

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
    const parserOutput = result.nodeResults.find((entry) => entry.nodeId === "n2")?.output as Record<string, unknown>;
    expect((parserOutput.parsed as Record<string, unknown>).name).toBe("Alice");
    expect(parserOutput.retries).toBe(0);
  });

  it("if_node: routes to true branch when condition is truthy", async () => {
    const workflow: Workflow = {
      id: "wf-if-true",
      name: "IF true branch",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        { id: "n1", type: "text_input", name: "Input", position: { x: 0, y: 0 }, config: { text: "hello" } },
        { id: "n2", type: "if_node", name: "IF", position: { x: 200, y: 0 }, config: { condition: "{{text}}" } },
        { id: "n3", type: "output", name: "True Output", position: { x: 400, y: -50 }, config: { responseTemplate: "was true" } },
        { id: "n4", type: "output", name: "False Output", position: { x: 400, y: 50 }, config: { responseTemplate: "was false" } }
      ],
      edges: [
        { id: "e1", source: "n1", target: "n2" },
        { id: "e2", source: "n2", sourceHandle: "true", target: "n3" },
        { id: "e3", source: "n2", sourceHandle: "false", target: "n4" }
      ]
    };

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
    expect(result.nodeResults.find((entry) => entry.nodeId === "n3")?.status).toBe("success");
    expect(result.nodeResults.find((entry) => entry.nodeId === "n4")?.status).toBe("skipped");
  });

  it("if_node: routes to false branch when condition is falsy", async () => {
    const workflow: Workflow = {
      id: "wf-if-false",
      name: "IF false branch",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        { id: "n1", type: "text_input", name: "Input", position: { x: 0, y: 0 }, config: { text: "" } },
        { id: "n2", type: "if_node", name: "IF", position: { x: 200, y: 0 }, config: { condition: "{{text}}" } },
        { id: "n3", type: "output", name: "True Output", position: { x: 400, y: -50 }, config: { responseTemplate: "was true" } },
        { id: "n4", type: "output", name: "False Output", position: { x: 400, y: 50 }, config: { responseTemplate: "was false" } }
      ],
      edges: [
        { id: "e1", source: "n1", target: "n2" },
        { id: "e2", source: "n2", sourceHandle: "true", target: "n3" },
        { id: "e3", source: "n2", sourceHandle: "false", target: "n4" }
      ]
    };

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
    expect(result.nodeResults.find((entry) => entry.nodeId === "n3")?.status).toBe("skipped");
    expect(result.nodeResults.find((entry) => entry.nodeId === "n4")?.status).toBe("success");
  });

  it("switch_node: routes to matching case", async () => {
    const workflow: Workflow = {
      id: "wf-switch",
      name: "Switch routing",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        { id: "n1", type: "text_input", name: "Input", position: { x: 0, y: 0 }, config: { text: "negative" } },
        {
          id: "n2",
          type: "switch_node",
          name: "Switch",
          position: { x: 200, y: 0 },
          config: {
            switchValue: "{{text}}",
            cases: [
              { value: "positive", label: "positive" },
              { value: "negative", label: "negative" }
            ],
            defaultLabel: "default"
          }
        },
        { id: "n3", type: "output", name: "Positive", position: { x: 400, y: -50 }, config: { responseTemplate: "pos" } },
        { id: "n4", type: "output", name: "Negative", position: { x: 400, y: 0 }, config: { responseTemplate: "neg" } },
        { id: "n5", type: "output", name: "Default", position: { x: 400, y: 50 }, config: { responseTemplate: "def" } }
      ],
      edges: [
        { id: "e1", source: "n1", target: "n2" },
        { id: "e2", source: "n2", sourceHandle: "positive", target: "n3" },
        { id: "e3", source: "n2", sourceHandle: "negative", target: "n4" },
        { id: "e4", source: "n2", sourceHandle: "default", target: "n5" }
      ]
    };

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
    expect(result.nodeResults.find((entry) => entry.nodeId === "n3")?.status).toBe("skipped");
    expect(result.nodeResults.find((entry) => entry.nodeId === "n4")?.status).toBe("success");
    expect(result.nodeResults.find((entry) => entry.nodeId === "n5")?.status).toBe("skipped");
  });

  it("onError continue: failing node does not halt execution", async () => {
    const workflow: Workflow = {
      id: "wf-continue",
      name: "Continue on error",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        { id: "n1", type: "text_input", name: "Input", position: { x: 0, y: 0 }, config: { text: "hello" } },
        { id: "n2", type: "connector_source", name: "Bad Source", position: { x: 200, y: 0 }, config: { connectorId: "nonexistent", onError: "continue" } },
        { id: "n3", type: "output", name: "Output", position: { x: 400, y: 0 }, config: {} }
      ],
      edges: [
        { id: "e1", source: "n1", target: "n2" },
        { id: "e2", source: "n2", target: "n3" }
      ]
    };

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

    expect(result.status).toBe("partial");
    expect(result.nodeResults.find((entry) => entry.nodeId === "n2")?.status).toBe("error");
    expect(result.nodeResults.find((entry) => entry.nodeId === "n3")?.status).toBe("success");
  });

  it("retry: succeeds after re-attempts", async () => {
    let callCount = 0;

    class FlakeyProvider implements LLMProviderAdapter {
      readonly definition = {
        id: "flakey",
        label: "Flakey",
        supportsTools: false,
        configSchema: {}
      };

      async generate() {
        callCount += 1;
        if (callCount < 3) {
          throw new Error("temporary failure");
        }
        return { content: "success-after-retry", toolCalls: [] };
      }
    }

    const registry = new ProviderRegistry();
    registry.register(new FlakeyProvider());

    const workflow: Workflow = {
      id: "wf-retry",
      name: "Retry flow",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        { id: "n1", type: "text_input", name: "Input", position: { x: 0, y: 0 }, config: { text: "hello" } },
        {
          id: "n2",
          type: "llm_call",
          name: "LLM",
          position: { x: 200, y: 0 },
          config: {
            provider: { providerId: "flakey", model: "test" },
            retry: { enabled: true, maxAttempts: 3, delayMs: 0, backoffMultiplier: 1 }
          }
        },
        { id: "n3", type: "output", name: "Output", position: { x: 400, y: 0 }, config: { responseTemplate: "{{answer}}" } }
      ],
      edges: [
        { id: "e1", source: "n1", target: "n2" },
        { id: "e2", source: "n2", target: "n3" }
      ]
    };

    const result = await executeWorkflow(
      { workflow },
      {
        providerRegistry: registry,
        connectorRegistry: createDefaultConnectorRegistry(),
        mcpRegistry: createDefaultMCPRegistry(),
        agentRuntime: new FakeAgentRuntime(),
        resolveSecret: async () => undefined
      }
    );

    expect(result.status).toBe("success");
    expect(result.nodeResults.find((entry) => entry.nodeId === "n2")?.attempts).toBe(3);
    const output = result.nodeResults.find((entry) => entry.nodeId === "n2")?.output as Record<string, unknown>;
    expect(output.answer).toBe("success-after-retry");
  });
});
