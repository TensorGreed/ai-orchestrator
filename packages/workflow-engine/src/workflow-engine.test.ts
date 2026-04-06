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

class ParserFixProvider implements LLMProviderAdapter {
  readonly definition = {
    id: "parser-fix",
    label: "Parser Fix",
    supportsTools: false,
    configSchema: {}
  };

  async generate() {
    return {
      content: "{\"status\":\"complete\"}",
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

class CollectingAgentRuntime implements AgentRuntimeAdapter {
  readonly id = "collecting-agent";
  requests: AgentRunRequest[] = [];

  async run(request: AgentRunRequest): Promise<AgentRunState> {
    this.requests.push(request);
    return {
      finalAnswer: `collect:${request.userPrompt}`,
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
            toolCallingEnabled: true,
            toolMessageMaxChars: 90000,
            toolPayloadMaxDepth: 8,
            toolPayloadMaxObjectKeys: 256,
            toolPayloadMaxArrayItems: 256,
            toolPayloadMaxStringChars: 4096
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
    expect(runtime.lastRequest?.toolOutputLimits).toEqual({
      messageMaxChars: 90000,
      payloadMaxDepth: 8,
      payloadMaxObjectKeys: 256,
      payloadMaxArrayItems: 256,
      payloadMaxStringChars: 4096
    });
    expect(result.nodeResults.find((entry) => entry.nodeId === "model")?.status).toBe("success");
    expect(
      (result.nodeResults.find((entry) => entry.nodeId === "model")?.output as Record<string, unknown>)?.reason
    ).toBe("attachment_consumed_by_agent");
    expect(
      ((result.nodeResults.find((entry) => entry.nodeId === "model")?.output as Record<string, unknown>)
        ?.details as Record<string, unknown>)?.answer
    ).toBe("captured:U");
    expect(result.nodeResults.find((entry) => entry.nodeId === "memory")?.status).toBe("success");
    expect(
      (result.nodeResults.find((entry) => entry.nodeId === "memory")?.output as Record<string, unknown>)?.reason
    ).toBe("attachment_consumed_by_agent");
    expect(result.nodeResults.find((entry) => entry.nodeId === "tool")?.status).toBe("success");
    expect(
      (result.nodeResults.find((entry) => entry.nodeId === "tool")?.output as Record<string, unknown>)?.reason
    ).toBe("attachment_consumed_by_agent");
  });

  it("executes each agent with its own attached chat model", async () => {
    const runtime = new CollectingAgentRuntime();
    const workflow: Workflow = {
      id: "wf-two-agents-two-models",
      name: "Two agents two models",
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
          id: "agent-1",
          type: "agent_orchestrator",
          name: "Agent 1",
          position: { x: 220, y: 0 },
          config: {
            systemPromptTemplate: "{{system_prompt}}",
            userPromptTemplate: "{{user_prompt}}",
            maxIterations: 2,
            toolCallingEnabled: true
          }
        },
        {
          id: "agent-2",
          type: "agent_orchestrator",
          name: "Agent 2",
          position: { x: 460, y: 0 },
          config: {
            systemPromptTemplate: "{{system_prompt}}",
            userPromptTemplate: "{{answer}}",
            maxIterations: 2,
            toolCallingEnabled: true
          }
        },
        {
          id: "model-1",
          type: "llm_call",
          name: "Model 1",
          position: { x: 220, y: 180 },
          config: {
            provider: { providerId: "fake", model: "model-one" }
          }
        },
        {
          id: "model-2",
          type: "llm_call",
          name: "Model 2",
          position: { x: 460, y: 180 },
          config: {
            provider: { providerId: "fake", model: "model-two" }
          }
        },
        {
          id: "output",
          type: "output",
          name: "Output",
          position: { x: 700, y: 0 },
          config: {
            responseTemplate: "{{answer}}"
          }
        }
      ],
      edges: [
        { id: "e-main-1", source: "webhook", target: "agent-1" },
        { id: "e-main-2", source: "agent-1", target: "agent-2" },
        { id: "e-main-3", source: "agent-2", target: "output" },
        { id: "e-attach-1", source: "agent-1", sourceHandle: "chat_model", target: "model-1" },
        { id: "e-attach-2", source: "agent-2", sourceHandle: "chat_model", target: "model-2" }
      ]
    };

    const result = await executeWorkflow(
      {
        workflow,
        webhookPayload: {
          user_prompt: "hello"
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
    expect(runtime.requests.length).toBe(2);
    expect(runtime.requests[0]?.provider.model).toBe("model-one");
    expect(runtime.requests[1]?.provider.model).toBe("model-two");
    expect(result.nodeResults.find((entry) => entry.nodeId === "model-1")?.status).toBe("success");
    expect(result.nodeResults.find((entry) => entry.nodeId === "model-2")?.status).toBe("success");
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

  it("output_parser: retries using attached agent provider context when agent returns non-JSON", async () => {
    const providerRegistry = createProviderRegistry();
    providerRegistry.register(new ParserFixProvider());

    const workflow: Workflow = {
      id: "wf-parser-agent-retry",
      name: "Parser retries from agent provider",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        { id: "w1", type: "webhook_input", name: "Webhook", position: { x: 0, y: 0 }, config: {} },
        {
          id: "a1",
          type: "agent_orchestrator",
          name: "Agent",
          position: { x: 220, y: 0 },
          config: {
            systemPromptTemplate: "{{system_prompt}}",
            userPromptTemplate: "{{user_prompt}}",
            maxIterations: 3,
            toolCallingEnabled: false
          }
        },
        {
          id: "m1",
          type: "llm_call",
          name: "Model",
          position: { x: 220, y: 180 },
          config: {
            provider: { providerId: "parser-fix", model: "parser-fix-model" }
          }
        },
        {
          id: "p1",
          type: "output_parser",
          name: "Parser",
          position: { x: 440, y: 0 },
          config: {
            mode: "json_schema",
            inputKey: "answer",
            maxRetries: 2,
            jsonSchema:
              "{\"type\":\"object\",\"properties\":{\"status\":{\"type\":\"string\",\"enum\":[\"complete\",\"needs_more_info\"]}},\"required\":[\"status\"]}"
          }
        },
        { id: "o1", type: "output", name: "Output", position: { x: 660, y: 0 }, config: { responseTemplate: "{{parsed.status}}" } }
      ],
      edges: [
        { id: "e1", source: "w1", target: "a1" },
        { id: "e2", source: "a1", target: "p1" },
        { id: "e3", source: "p1", target: "o1" },
        { id: "e4", source: "a1", sourceHandle: "chat_model", target: "m1" }
      ]
    };

    const result = await executeWorkflow(
      {
        workflow,
        webhookPayload: {
          system_prompt: "You are helpful",
          user_prompt: "Get status"
        }
      },
      {
        providerRegistry,
        connectorRegistry: createDefaultConnectorRegistry(),
        mcpRegistry: createDefaultMCPRegistry(),
        agentRuntime: new FakeAgentRuntime(),
        resolveSecret: async () => undefined
      }
    );

    expect(result.status).toBe("success");
    const parserOutput = result.nodeResults.find((entry) => entry.nodeId === "p1")?.output as Record<string, unknown>;
    expect((parserOutput.parsed as Record<string, unknown>).status).toBe("complete");
    expect(parserOutput.retries).toBeGreaterThan(0);
  });

  it("pdf_output: generates downloadable PDF data URL", async () => {
    const workflow: Workflow = {
      id: "wf-pdf-output",
      name: "PDF output flow",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        { id: "n1", type: "text_input", name: "Input", position: { x: 0, y: 0 }, config: { text: "Generate me as PDF." } },
        {
          id: "n2",
          type: "pdf_output",
          name: "PDF Output",
          position: { x: 200, y: 0 },
          config: {
            inputKey: "text",
            filenameTemplate: "summary-{{session_id}}.pdf",
            outputKey: "pdf"
          }
        },
        { id: "n3", type: "output", name: "Output", position: { x: 420, y: 0 }, config: { responseTemplate: "{{pdf.downloadUrl}}" } }
      ],
      edges: [
        { id: "e1", source: "n1", target: "n2" },
        { id: "e2", source: "n2", target: "n3" }
      ]
    };

    const result = await executeWorkflow(
      {
        workflow,
        sessionId: "session-77"
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
    const pdfOutput = result.nodeResults.find((entry) => entry.nodeId === "n2")?.output as Record<string, unknown>;
    const pdfPayload = (pdfOutput.pdf ?? null) as Record<string, unknown> | null;
    expect(pdfPayload).toBeTruthy();
    expect(typeof pdfPayload?.downloadUrl).toBe("string");
    expect(String(pdfPayload?.downloadUrl ?? "")).toMatch(/^data:application\/pdf;base64,/);
    expect(String(pdfPayload?.filename ?? "")).toBe("summary-session-77.pdf");
    expect(Number(pdfPayload?.sizeBytes ?? 0)).toBeGreaterThan(100);
    expect(typeof result.output).toBe("object");
    expect(
      String(((result.output as Record<string, unknown>).result as string) ?? "")
    ).toMatch(/^data:application\/pdf;base64,/);
  });

  it("pdf_output: decodes buffer-like upstream values into readable PDF text", async () => {
    const workflow: Workflow = {
      id: "wf-pdf-buffer-input",
      name: "PDF buffer input flow",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        {
          id: "n1",
          type: "pdf_output",
          name: "PDF Output",
          position: { x: 0, y: 0 },
          config: {
            inputKey: "blob",
            filenameTemplate: "buffer-test.pdf",
            outputKey: "pdf"
          }
        },
        { id: "n2", type: "output", name: "Output", position: { x: 200, y: 0 }, config: { responseTemplate: "{{pdf.downloadUrl}}" } }
      ],
      edges: [{ id: "e1", source: "n1", target: "n2" }]
    };

    const result = await executeWorkflow(
      {
        workflow,
        input: {
          blob: {
            type: "Buffer",
            data: Array.from(Buffer.from("buffer text for pdf", "utf8"))
          }
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
    const pdfOutput = result.nodeResults.find((entry) => entry.nodeId === "n1")?.output as Record<string, unknown>;
    const pdfPayload = (pdfOutput.pdf ?? null) as Record<string, unknown> | null;
    expect(pdfPayload).toBeTruthy();
    const encoded = String(pdfPayload?.base64 ?? "");
    expect(encoded.length).toBeGreaterThan(0);
    const pdfRaw = Buffer.from(encoded, "base64").toString("latin1");
    expect(pdfRaw).toContain("buffer text for pdf");
    expect(pdfRaw).not.toContain(`"type":"Buffer"`);
  });

  it("pdf_output: normalizes smart punctuation instead of rendering question marks", async () => {
    const workflow: Workflow = {
      id: "wf-pdf-smart-punctuation",
      name: "PDF punctuation flow",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        { id: "n1", type: "text_input", name: "Input", position: { x: 0, y: 0 }, config: { text: "I can’t wait — really…" } },
        { id: "n2", type: "pdf_output", name: "PDF", position: { x: 220, y: 0 }, config: { inputKey: "text", outputKey: "pdf" } },
        { id: "n3", type: "output", name: "Output", position: { x: 420, y: 0 }, config: { responseTemplate: "{{pdf.downloadUrl}}" } }
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
    const pdfOutput = result.nodeResults.find((entry) => entry.nodeId === "n2")?.output as Record<string, unknown>;
    const pdfPayload = (pdfOutput.pdf ?? null) as Record<string, unknown> | null;
    const encoded = String(pdfPayload?.base64 ?? "");
    expect(encoded.length).toBeGreaterThan(0);
    const pdfRaw = Buffer.from(encoded, "base64").toString("latin1");
    expect(pdfRaw).toContain("I can't wait - really...");
    expect(pdfRaw).not.toContain("I can?t wait ? really?");
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

  it("switch_node: routes correctly when edges use case index handles (legacy canvas ids)", async () => {
    const workflow: Workflow = {
      id: "wf-switch-case-index",
      name: "Switch routing case index handles",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        { id: "n1", type: "text_input", name: "Input", position: { x: 0, y: 0 }, config: { text: "needs_more_info" } },
        {
          id: "n2",
          type: "switch_node",
          name: "Switch",
          position: { x: 200, y: 0 },
          config: {
            switchValue: "{{text}}",
            cases: [
              { value: "complete", label: "complete" },
              { value: "needs_more_info", label: "needs_more_info" }
            ],
            defaultLabel: "default"
          }
        },
        { id: "n3", type: "output", name: "Complete", position: { x: 420, y: -50 }, config: { responseTemplate: "pdf" } },
        { id: "n4", type: "output", name: "Follow Up", position: { x: 420, y: 0 }, config: { responseTemplate: "ask_more" } },
        { id: "n5", type: "output", name: "Default", position: { x: 420, y: 50 }, config: { responseTemplate: "default" } }
      ],
      edges: [
        { id: "e1", source: "n1", target: "n2" },
        { id: "e2", source: "n2", sourceHandle: "case_0", target: "n3" },
        { id: "e3", source: "n2", sourceHandle: "case_1", target: "n4" },
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

  it("switch_node: passes upstream parsed payload to taken branch outputs", async () => {
    const workflow: Workflow = {
      id: "wf-switch-pass-through",
      name: "Switch payload pass-through",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        {
          id: "n1",
          type: "text_input",
          name: "Input",
          position: { x: 0, y: 0 },
          config: { text: "{\"status\":\"needs_more_info\",\"follow_up_question\":\"Please share project id.\"}" }
        },
        {
          id: "n2",
          type: "output_parser",
          name: "Parser",
          position: { x: 180, y: 0 },
          config: {
            mode: "json_schema",
            inputKey: "text",
            jsonSchema:
              "{\"type\":\"object\",\"properties\":{\"status\":{\"type\":\"string\"},\"follow_up_question\":{\"type\":\"string\"}},\"required\":[\"status\",\"follow_up_question\"]}"
          }
        },
        {
          id: "n3",
          type: "switch_node",
          name: "Switch",
          position: { x: 360, y: 0 },
          config: {
            switchValue: "{{parsed.status}}",
            cases: [
              { value: "complete", label: "complete" },
              { value: "needs_more_info", label: "needs_more_info" }
            ],
            defaultLabel: "default"
          }
        },
        {
          id: "n4",
          type: "output",
          name: "Complete Output",
          position: { x: 560, y: -50 },
          config: { responseTemplate: "{{parsed.final_markdown}}", outputKey: "result" }
        },
        {
          id: "n5",
          type: "output",
          name: "Follow-up Output",
          position: { x: 560, y: 50 },
          config: { responseTemplate: "{{parsed.follow_up_question}}", outputKey: "result" }
        }
      ],
      edges: [
        { id: "e1", source: "n1", target: "n2" },
        { id: "e2", source: "n2", target: "n3" },
        { id: "e3", source: "n3", sourceHandle: "complete", target: "n4" },
        { id: "e4", source: "n3", sourceHandle: "needs_more_info", target: "n5" }
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
    expect(result.nodeResults.find((entry) => entry.nodeId === "n4")?.status).toBe("skipped");
    expect(result.nodeResults.find((entry) => entry.nodeId === "n5")?.status).toBe("success");

    const followupOutput = result.nodeResults.find((entry) => entry.nodeId === "n5")?.output as Record<string, unknown>;
    expect(followupOutput.result).toBe("Please share project id.");
  });

  it("switch_node: does not skip shared targets when taken and non-taken handles point to same node", async () => {
    const workflow: Workflow = {
      id: "wf-switch-shared-target",
      name: "Switch shared target safety",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        { id: "n1", type: "text_input", name: "Input", position: { x: 0, y: 0 }, config: { text: "complete" } },
        {
          id: "n2",
          type: "switch_node",
          name: "Switch",
          position: { x: 200, y: 0 },
          config: {
            switchValue: "{{text}}",
            cases: [
              { value: "complete", label: "complete" },
              { value: "needs_more_info", label: "needs_more_info" }
            ],
            defaultLabel: "needs_more_info"
          }
        },
        { id: "n3", type: "output", name: "Complete", position: { x: 420, y: -40 }, config: { responseTemplate: "pdf" } },
        { id: "n4", type: "output", name: "NeedsMoreInfo", position: { x: 420, y: 40 }, config: { responseTemplate: "follow-up" } }
      ],
      edges: [
        { id: "e1", source: "n1", target: "n2" },
        { id: "e2", source: "n2", sourceHandle: "case_0", target: "n3" },
        { id: "e3", source: "n2", sourceHandle: "complete", target: "n3" },
        { id: "e4", source: "n2", sourceHandle: "default", target: "n3" },
        { id: "e5", source: "n2", sourceHandle: "case_1", target: "n4" },
        { id: "e6", source: "n2", sourceHandle: "needs_more_info", target: "n4" }
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

  it("skips isolated disconnected nodes instead of executing them", async () => {
    const workflow: Workflow = {
      id: "wf-disconnected-node",
      name: "Disconnected node handling",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        { id: "n1", type: "text_input", name: "Input", position: { x: 0, y: 0 }, config: { text: "hello" } },
        { id: "n2", type: "prompt_template", name: "Prompt", position: { x: 180, y: 0 }, config: { template: "{{text}}" } },
        { id: "n3", type: "output", name: "Output", position: { x: 360, y: 0 }, config: { responseTemplate: "{{text}}" } },
        { id: "n4", type: "text_input", name: "Isolated", position: { x: 0, y: 180 }, config: { text: "unused" } }
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
    expect(result.nodeResults.find((entry) => entry.nodeId === "n3")?.status).toBe("success");
    const isolated = result.nodeResults.find((entry) => entry.nodeId === "n4");
    expect(isolated?.status).toBe("skipped");
    expect((isolated?.output as Record<string, unknown>)?.reason).toBe("disconnected_node");
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
