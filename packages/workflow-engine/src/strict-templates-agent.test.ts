/**
 * Strict templates around agents and MCP tools: templates the builder wrote (an MCP Tool node's arguments, a server
 * prompt's arguments on an agent) fail the node like any other template; arguments the model generates are not
 * templates, so `{{ }}` in them is sent as it is and a tool failure goes back to the model as a tool error.
 */
import { describe, expect, it } from "vitest";
import { createDefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry, type LLMProviderAdapter, type ProviderCallRequest } from "@ai-orchestrator/provider-sdk";
import type { MCPServerConfig, Workflow, WorkflowEdge, WorkflowNode } from "@ai-orchestrator/shared";
import { executeWorkflow, type WorkflowExecutionDependencies } from "./executor";
import { TEMPLATE_VALUE_MISSING_CODE } from "./template";

const SLOW = 30_000;
const REGISTRY_ID = "mcp_mock";

/** First call: one tool call whose arguments hold `{{nope}}`; then a final answer that quotes the tool message. */
class ToolCallingProvider implements LLMProviderAdapter {
  readonly definition = { id: "fake", label: "Fake", supportsTools: true, configSchema: {} };
  calls: ProviderCallRequest[] = [];
  async generate(request: ProviderCallRequest) {
    this.calls.push(request);
    const toolMessage = request.messages.find((message) => message.role === "tool");
    if (!toolMessage) {
      const tool = (request.tools ?? []).find((entry) => entry.name.includes("calculator"));
      return { content: "", toolCalls: [{ id: "call-1", name: tool?.name ?? "calculator", arguments: { expression: "{{nope}}" } }], usage: { inputTokens: 1, outputTokens: 1 } };
    }
    return { content: `tool said: ${String(toolMessage.content).slice(0, 200)}`, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

/** A supervisor's model: delegates once to the worker, then answers. */
class DelegatingProvider implements LLMProviderAdapter {
  readonly definition = { id: "boss", label: "Boss", supportsTools: true, configSchema: {} };
  async generate(request: ProviderCallRequest) {
    if (!request.messages.some((message) => message.role === "tool")) {
      return { content: "", toolCalls: [{ id: "call-w", name: "delegate_to_Clerk", arguments: { task_prompt: "Do it" } }], usage: { inputTokens: 1, outputTokens: 1 } };
    }
    return { content: "done", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

function deps(provider: LLMProviderAdapter, ...more: LLMProviderAdapter[]): WorkflowExecutionDependencies {
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(provider);
  for (const extra of more) providerRegistry.register(extra);
  return {
    providerRegistry,
    mcpRegistry: createDefaultMCPRegistry(),
    connectorRegistry: createDefaultConnectorRegistry(),
    agentRuntime: createDefaultAgentRuntime(),
    resolveSecret: async () => undefined,
    resolveRegisteredMcpServer: (id): MCPServerConfig => {
      if (id !== REGISTRY_ID) throw new Error(`unknown server ${id}`);
      return { serverId: "mock-mcp", registryServerId: REGISTRY_ID, label: "Mock", connection: {} };
    }
  };
}

const node = (id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode => ({
  id,
  type: type as WorkflowNode["type"],
  name: id,
  position: { x: 0, y: 0 },
  config
});
const edge = (source: string, target: string, sourceHandle?: string): WorkflowEdge => ({
  id: `${source}-${sourceHandle ?? "main"}-${target}`,
  source,
  target,
  ...(sourceHandle ? { sourceHandle } : {})
});
const strictWorkflow = (nodes: WorkflowNode[], edges: WorkflowEdge[]): Workflow => ({
  id: "wf-strict-agent",
  name: "Strict agent",
  schemaVersion: "1.0.0",
  workflowVersion: 1,
  settings: { strictTemplates: true },
  nodes,
  edges
});

function agentWorkflow(agentConfig: Record<string, unknown> = {}): Workflow {
  return strictWorkflow(
    [
      node("trigger", "webhook_input"),
      node("agent", "agent_orchestrator", { systemPromptTemplate: "S", userPromptTemplate: "{{user_prompt}}", maxIterations: 4, ...agentConfig }),
      node("model", "llm_call", { provider: { providerId: "fake", model: "fake-model" } }),
      node("tool", "mcp_tool", { serverId: "mock-mcp", registryServerId: REGISTRY_ID, toolName: "__all__" })
    ],
    [edge("trigger", "agent"), edge("agent", "model", "chat_model"), edge("agent", "tool", "tool")]
  );
}

describe("strict templates and tools", () => {
  it("fail an MCP Tool node whose configured arguments read a missing value", async () => {
    const workflow = strictWorkflow(
      [
        node("trigger", "webhook_input"),
        node("tool", "mcp_tool", { serverId: "mock-mcp", registryServerId: REGISTRY_ID, toolName: "calculator", argsTemplate: '{"expression":"{{nope}}"}' })
      ],
      [edge("trigger", "tool")]
    );
    const result = await executeWorkflow({ workflow, webhookPayload: {} }, deps(new ToolCallingProvider()));
    const tool = result.nodeResults.find((entry) => entry.nodeId === "tool");
    expect(tool?.status).toBe("error");
    expect(tool?.errorCode).toBe(TEMPLATE_VALUE_MISSING_CODE);
  }, SLOW);

  it("fail an agent whose server prompt arguments read a missing value", async () => {
    const workflow = agentWorkflow({ serverPrompt: { registryServerId: REGISTRY_ID, name: "explain_topic", arguments: { topic: "{{nope}}" } } });
    const result = await executeWorkflow({ workflow, webhookPayload: { user_prompt: "go" } }, deps(new ToolCallingProvider()));
    const agent = result.nodeResults.find((entry) => entry.nodeId === "agent");
    expect(agent?.status).toBe("error");
    expect(agent?.errorCode).toBe(TEMPLATE_VALUE_MISSING_CODE);
  }, SLOW);

  it("leave a model's tool arguments alone: {{ }} in them is sent as it is, and the tool's answer goes back to the model", async () => {
    const provider = new ToolCallingProvider();
    const result = await executeWorkflow({ workflow: agentWorkflow(), webhookPayload: { user_prompt: "go" } }, deps(provider));
    const agent = result.nodeResults.find((entry) => entry.nodeId === "agent");
    expect(agent?.status).toBe("success");
    expect(agent?.errorCode).toBeUndefined();
    // The model got a tool message back and answered.
    expect(provider.calls.length).toBeGreaterThanOrEqual(2);
    const toolMessage = provider.calls.at(-1)!.messages.find((message) => message.role === "tool");
    expect(toolMessage).toBeDefined();
    // The calculator got the literal text and refused it: a tool error the model reads, not a node failure.
    expect(String(toolMessage!.content)).toContain("unsupported characters");
    expect(String(toolMessage!.content)).not.toContain("strict templates");
    // What the tool was called with is the text as the model wrote it, not a rendering of it.
    const output = agent?.output as { toolCalls?: Array<{ arguments?: Record<string, unknown> }>; steps?: unknown };
    expect(JSON.stringify(output)).toContain('"expression":"{{nope}}"');
  }, SLOW);

  it("fail the supervisor when a worker's own prompt reads a missing value, instead of telling the model", async () => {
    const workflow = strictWorkflow(
      [
        node("trigger", "webhook_input"),
        node("sup", "supervisor_node", { maxIterations: 3, userPromptTemplate: "{{user_prompt}}" }),
        node("sup_model", "llm_call", { provider: { providerId: "boss", model: "m" } }),
        { ...node("worker", "agent_orchestrator", { maxIterations: 2, userPromptTemplate: "{{nope}}" }), name: "Clerk" },
        node("worker_model", "llm_call", { provider: { providerId: "fake", model: "m" } })
      ],
      [edge("trigger", "sup"), edge("sup", "sup_model", "chat_model"), edge("sup", "worker", "worker"), edge("worker", "worker_model", "chat_model")]
    );
    const result = await executeWorkflow({ workflow, webhookPayload: { user_prompt: "go" } }, deps(new DelegatingProvider(), new ToolCallingProvider()));
    const sup = result.nodeResults.find((entry) => entry.nodeId === "sup");
    expect(sup?.status).toBe("error");
    expect(sup?.errorCode).toBe(TEMPLATE_VALUE_MISSING_CODE);
  }, SLOW);
});
