/**
 * Phase 10.5 — the engine side of MCP resources, server prompts,
 * elicitation and sampling, against the mock MCP server (registered through
 * the registry so sampling settings apply).
 */
import { describe, expect, it } from "vitest";

// Failed runs back off before giving up, so tests with several failing runs need headroom.
const SLOW = 30_000;
import type { AgentRuntimeAdapter, AgentToolRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry, type LLMProviderAdapter, type ProviderCallRequest } from "@ai-orchestrator/provider-sdk";
import type {
  AgentRunRequest,
  AgentRunState,
  MCPServerConfig,
  McpElicitationTraceEntry,
  McpSamplingSettings,
  McpSamplingTraceEntry,
  McpToolPolicyRule,
  Workflow,
  WorkflowEdge,
  WorkflowNode
} from "@ai-orchestrator/shared";
import { executeWorkflow, type WorkflowExecutionDependencies } from "./executor";
import { chooseSamplingModel } from "./mcp-client-features";

class FakeProvider implements LLMProviderAdapter {
  readonly definition = { id: "fake", label: "Fake", supportsTools: true, configSchema: {} };
  calls: ProviderCallRequest[] = [];
  async generate(request: ProviderCallRequest) {
    this.calls.push(request);
    const last = request.messages.at(-1)?.content ?? "";
    return { content: `summary(${request.provider.model}): ${last.slice(0, 30)}`, toolCalls: [], usage: { inputTokens: 11, outputTokens: 7 } };
  }
}

type AgentScript = (request: AgentRunRequest, tools: AgentToolRuntime) => Promise<Partial<AgentRunState> | void>;

class ScriptedAgentRuntime implements AgentRuntimeAdapter {
  readonly id = "scripted-agent";
  constructor(private readonly script: AgentScript) {}
  async run(request: AgentRunRequest, tools: AgentToolRuntime): Promise<AgentRunState> {
    const overrides = (await this.script(request, tools)) ?? {};
    return { finalAnswer: "done", stopReason: "final_answer", iterations: 1, messages: [], steps: [], usage: { inputTokens: 100, outputTokens: 50 }, ...overrides };
  }
}

const REGISTRY_ID = "mcp_mock";

function registryConfig(sampling?: Partial<McpSamplingSettings>): MCPServerConfig {
  return {
    serverId: "mock-mcp",
    registryServerId: REGISTRY_ID,
    label: "Mock",
    connection: {},
    ...(sampling ? { sampling: { allow: false, maxTokens: 1024, allowedModels: [], maxRequestsPerCall: 3, defaultModel: null, ...sampling } } : {})
  };
}

function makeDeps(
  agentRuntime: AgentRuntimeAdapter,
  options: { sampling?: Partial<McpSamplingSettings>; rules?: McpToolPolicyRule[]; extra?: Partial<WorkflowExecutionDependencies> } = {}
): WorkflowExecutionDependencies & { provider: FakeProvider } {
  const providerRegistry = new ProviderRegistry();
  const provider = new FakeProvider();
  providerRegistry.register(provider);
  return {
    provider,
    providerRegistry,
    mcpRegistry: createDefaultMCPRegistry(),
    connectorRegistry: createDefaultConnectorRegistry(),
    agentRuntime,
    resolveSecret: async () => undefined,
    resolveRegisteredMcpServer: (id) => {
      if (id !== REGISTRY_ID) throw new Error(`unknown server ${id}`);
      return registryConfig(options.sampling);
    },
    ...(options.rules ? { loadMcpToolPolicy: () => ({ rules: options.rules ?? [], classifications: [] }) } : {}),
    ...options.extra
  };
}

function node(id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], name: id, position: { x: 0, y: 0 }, config };
}

function edge(source: string, target: string, sourceHandle?: string): WorkflowEdge {
  return { id: `${source}-${sourceHandle ?? "main"}-${target}`, source, target, ...(sourceHandle ? { sourceHandle } : {}) };
}

function workflowOf(nodes: WorkflowNode[], edges: WorkflowEdge[], id = "wf"): Workflow {
  return { id, name: id, schemaVersion: "1.0.0", workflowVersion: 1, nodes, edges };
}

function directWorkflow(config: Record<string, unknown>): Workflow {
  return workflowOf(
    [node("trigger", "webhook_input"), node("tool", "mcp_tool", { serverId: "mock-mcp", registryServerId: REGISTRY_ID, ...config }), node("output", "output")],
    [edge("trigger", "tool"), edge("tool", "output")]
  );
}

function agentWorkflow(agentConfig: Record<string, unknown> = {}): Workflow {
  return workflowOf(
    [
      node("trigger", "webhook_input"),
      node("agent", "agent_orchestrator", { systemPromptTemplate: "S", userPromptTemplate: "{{user_prompt}}", maxIterations: 4, ...agentConfig }),
      node("model", "llm_call", { provider: { providerId: "fake", model: "fake-model" } }),
      node("tool", "mcp_tool", { serverId: "mock-mcp", registryServerId: REGISTRY_ID, toolName: "__all__" }),
      node("output", "output")
    ],
    [edge("trigger", "agent"), edge("agent", "output"), edge("agent", "model", "chat_model"), edge("agent", "tool", "tool")]
  );
}

const rule = (overrides: Partial<McpToolPolicyRule>): McpToolPolicyRule => ({
  id: "r",
  name: "test rule",
  description: null,
  effect: "deny",
  projectId: null,
  roles: [],
  serverId: null,
  toolPattern: "*",
  enabled: true,
  ...overrides
});

const noop = new ScriptedAgentRuntime(async () => undefined);
const output = (result: Awaited<ReturnType<typeof executeWorkflow>>, nodeId: string) =>
  result.nodeResults.find((entry) => entry.nodeId === nodeId)?.output as Record<string, unknown>;

describe("MCP Tool node: read resource", () => {
  it("reads a text resource into the workflow with text, contents and the invocation request", async () => {
    const workflow = directWorkflow({ operation: "read_resource", resourceUri: "mock://docs/{{doc}}" });
    const result = await executeWorkflow({ workflow, webhookPayload: { doc: "readme" } }, makeDeps(noop));
    expect(result.status).toBe("success");
    const out = output(result, "tool");
    expect(out.uri).toBe("mock://docs/readme");
    expect(String(out.text)).toContain("# Mock MCP server");
    expect(out.resource).toMatchObject({ uri: "mock://docs/readme", mimeType: "text/markdown" });
    expect(out.invocation_request).toEqual({ server_id: "mock-mcp", registry_server_id: REGISTRY_ID, operation: "read_resource", uri: "mock://docs/readme" });
  }, SLOW);

  it("returns blobs as base64 and fails on unknown resources", async () => {
    const blob = await executeWorkflow({ workflow: directWorkflow({ operation: "read_resource", resourceUri: "mock://images/dot.png" }), webhookPayload: {} }, makeDeps(noop));
    expect((output(blob, "tool").resource as Record<string, unknown>).blob).toMatch(/^iVBOR/);
    const missing = await executeWorkflow({ workflow: directWorkflow({ operation: "read_resource", resourceUri: "mock://nope" }), webhookPayload: {} }, makeDeps(noop));
    expect(missing.status).toBe("error");
    expect(missing.error).toContain("Resource not found");
  }, SLOW);

  it("is governed by resource policy rules and ignores tool rules", async () => {
    const workflow = directWorkflow({ operation: "read_resource", resourceUri: "mock://kb/index.json" });
    const toolRuleOnly = await executeWorkflow({ workflow, webhookPayload: {} }, makeDeps(noop, { rules: [rule({ id: "deny-tools" })] }));
    expect(toolRuleOnly.status).toBe("success");
    const denied = await executeWorkflow(
      { workflow, webhookPayload: {} },
      makeDeps(noop, { rules: [rule({ id: "deny-kb", kind: "resource", toolPattern: "mock://kb/*" })] })
    );
    expect(denied.status).toBe("error");
    expect(denied.error).toContain("MCP resource 'mock://kb/index.json'");
    expect(denied.error).toContain("test rule");
  }, SLOW);
});

describe("server prompts as node templates", () => {
  it("uses a registry server prompt as the agent's system prompt, with rendered arguments", async () => {
    let seen: AgentRunRequest | undefined;
    const runtime = new ScriptedAgentRuntime(async (request) => {
      seen = request;
    });
    const workflow = agentWorkflow({ serverPrompt: { registryServerId: REGISTRY_ID, name: "explain_topic", arguments: { topic: "{{topic}}", audience: "ops" } } });
    const result = await executeWorkflow({ workflow, webhookPayload: { topic: "rag", user_prompt: "go" } }, makeDeps(runtime));
    expect(result.status).toBe("success");
    expect(seen?.systemPrompt).toContain("Explain rag to ops");
    expect(seen?.userPrompt).toBe("go");
    expect(output(result, "agent")._serverPrompt).toEqual({
      registryServerId: REGISTRY_ID,
      name: "explain_topic",
      target: "system",
      arguments: { topic: "rag", audience: "ops" },
      chars: expect.any(Number),
      messageCount: 1
    });
  }, SLOW);

  it("can replace the user prompt instead, and fails clearly when the prompt or an argument is missing", async () => {
    let seen: AgentRunRequest | undefined;
    const runtime = new ScriptedAgentRuntime(async (request) => {
      seen = request;
    });
    const asUser = agentWorkflow({ serverPrompt: { registryServerId: REGISTRY_ID, name: "explain_topic", arguments: { topic: "mcp" }, target: "user" } });
    const result = await executeWorkflow({ workflow: asUser, webhookPayload: {} }, makeDeps(runtime));
    expect(result.status).toBe("success");
    expect(seen?.userPrompt).toContain("Explain mcp to a new team member");
    const missingArg = await executeWorkflow(
      { workflow: agentWorkflow({ serverPrompt: { registryServerId: REGISTRY_ID, name: "explain_topic" } }), webhookPayload: { user_prompt: "x" } },
      makeDeps(runtime)
    );
    expect(missingArg.status).toBe("error");
    expect(missingArg.error).toContain("requires the 'topic' argument");
    const unknown = await executeWorkflow(
      { workflow: agentWorkflow({ serverPrompt: { registryServerId: REGISTRY_ID, name: "nope" } }), webhookPayload: { user_prompt: "x" } },
      makeDeps(runtime)
    );
    expect(unknown.status).toBe("error");
    expect(unknown.error).toContain("Prompt not found");
  }, SLOW);

  it("applies to LLM Call nodes and is governed by prompt policy rules", async () => {
    const deps = makeDeps(noop);
    const workflow = workflowOf(
      [
        node("trigger", "webhook_input"),
        node("llm", "llm_call", { provider: { providerId: "fake", model: "fake-model" }, serverPrompt: { registryServerId: REGISTRY_ID, name: "explain_topic", arguments: { topic: "ollama" } } }),
        node("output", "output")
      ],
      [edge("trigger", "llm"), edge("llm", "output")]
    );
    const result = await executeWorkflow({ workflow, webhookPayload: { prompt: "hello" } }, deps);
    expect(result.status).toBe("success");
    expect(deps.provider.calls[0].messages[0]).toMatchObject({ role: "system", content: expect.stringContaining("Explain ollama") });
    expect(output(result, "llm")._serverPrompt).toMatchObject({ name: "explain_topic", target: "system" });
    const denied = await executeWorkflow(
      { workflow, webhookPayload: { prompt: "hello" } },
      makeDeps(noop, { rules: [rule({ id: "deny-prompt", kind: "prompt", toolPattern: "explain_*" })] })
    );
    expect(denied.status).toBe("error");
    expect(denied.error).toContain("MCP prompt 'explain_topic'");
  }, SLOW);
});

describe("elicitation", () => {
  const askingAgent = new ScriptedAgentRuntime(async (_request, tools) => {
    const answer = await tools.invokeTool("mock-mcp__ask_user", { question: "Which region?", choices: ["eu", "us"] });
    return { finalAnswer: JSON.stringify(answer) };
  });

  it("pauses through the run's elicitation sink and resumes with the accepted answer", async () => {
    const requests: Array<Parameters<NonNullable<WorkflowExecutionDependencies["onMcpElicitation"]>>[0]> = [];
    const deps = makeDeps(askingAgent, {
      extra: {
        onMcpElicitation: async (request) => {
          requests.push(request);
          return { action: "accept", content: { answer: "eu" }, id: "elc_1" };
        }
      }
    });
    const result = await executeWorkflow({ workflow: agentWorkflow(), webhookPayload: { user_prompt: "go" } }, deps);
    expect(result.status).toBe("success");
    expect(JSON.parse(String(output(result, "agent").answer))).toEqual({ question: "Which region?", action: "accept", answer: "eu" });
    expect(requests[0]).toMatchObject({ nodeId: "agent", serverId: "mock-mcp", registryServerId: REGISTRY_ID, toolName: "ask_user", message: "Which region?" });
    expect(requests[0].requestedSchema.properties).toEqual({ answer: { type: "string", title: "Answer", enum: ["eu", "us"] } });
    const trace = output(result, "agent")._mcpElicitations as McpElicitationTraceEntry[];
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({ id: "elc_1", toolName: "ask_user", action: "accept", source: "user", message: "Which region?" });
  }, SLOW);

  it("relays decline and cancel, and declines with a trace entry when nobody can answer", async () => {
    for (const action of ["decline", "cancel"] as const) {
      const deps = makeDeps(askingAgent, { extra: { onMcpElicitation: async () => ({ action, source: "user" }) } });
      const result = await executeWorkflow({ workflow: agentWorkflow(), webhookPayload: { user_prompt: "go" } }, deps);
      expect(JSON.parse(String(output(result, "agent").answer))).toEqual({ question: "Which region?", action });
    }
    const unattended = makeDeps(askingAgent, {
      extra: { onMcpElicitation: async () => ({ action: "decline", source: "unattended", note: "Unattended run (webhook): declined automatically." }) }
    });
    const auto = await executeWorkflow({ workflow: agentWorkflow(), triggerType: "webhook", webhookPayload: { user_prompt: "go" } }, unattended);
    const autoTrace = output(auto, "agent")._mcpElicitations as McpElicitationTraceEntry[];
    expect(autoTrace[0]).toMatchObject({ action: "decline", source: "unattended", note: expect.stringContaining("Unattended run") });

    const nobody = await executeWorkflow({ workflow: agentWorkflow(), webhookPayload: { user_prompt: "go" } }, makeDeps(askingAgent));
    expect(JSON.parse(String(output(nobody, "agent").answer))).toEqual({ question: "Which region?", action: "decline" });
    expect((output(nobody, "agent")._mcpElicitations as McpElicitationTraceEntry[])[0]).toMatchObject({ action: "decline", source: "unavailable" });
  }, SLOW);
});

describe("sampling", () => {
  const samplingAgent = new ScriptedAgentRuntime(async (_request, tools) => {
    const first = await tools.invokeTool("mock-mcp__summarize_with_model", { text: "The quick brown fox jumps over the lazy dog." });
    return { finalAnswer: JSON.stringify(first) };
  });

  it("fulfils sampling/createMessage with the attached chat model and counts the tokens", async () => {
    const deps = makeDeps(samplingAgent, { sampling: { allow: true } });
    const result = await executeWorkflow({ workflow: agentWorkflow(), webhookPayload: { user_prompt: "go" } }, deps);
    expect(result.status).toBe("success");
    const answer = JSON.parse(String(output(result, "agent").answer));
    expect(answer).toEqual({ summary: "summary(fake-model): Summarize in one sentence:\n\nTh", model: "fake-model" });
    expect(deps.provider.calls[0].provider).toMatchObject({ providerId: "fake", model: "fake-model", maxTokens: 200 });
    const trace = output(result, "agent")._mcpSampling as McpSamplingTraceEntry[];
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({ toolName: "summarize_with_model", model: "fake-model", ok: true, inputTokens: 11, outputTokens: 7, maxTokens: 200, requestedModels: [] });
    const telemetry = output(result, "agent")._telemetry as Record<string, unknown>;
    expect(telemetry.usage).toMatchObject({ inputTokens: 111, outputTokens: 57 });
    expect(telemetry.samplingRequests).toBe(1);
    expect(telemetry.samplingUsage).toMatchObject({ inputTokens: 11, outputTokens: 7 });
  }, SLOW);

  it("is off unless the server allows it, and sampling policy rules can deny the model", async () => {
    const off = await executeWorkflow({ workflow: agentWorkflow(), webhookPayload: { user_prompt: "go" } }, makeDeps(samplingAgent, { sampling: { allow: false } }));
    expect(off.status).toBe("error");
    expect(off.error).toContain("Sampling is off for MCP server 'Mock'");
    expect((output(off, "agent") ?? {})._mcpSampling).toBeUndefined();

    const denied = await executeWorkflow(
      { workflow: agentWorkflow(), webhookPayload: { user_prompt: "go" } },
      makeDeps(samplingAgent, { sampling: { allow: true }, rules: [rule({ id: "no-sampling", kind: "sampling" })] })
    );
    expect(denied.status).toBe("error");
    expect(denied.error).toContain("Sampling with model 'fake-model'");
    expect(denied.error).toContain("test rule");

    const inline = workflowOf(
      [
        node("trigger", "webhook_input"),
        node("agent", "agent_orchestrator", { systemPromptTemplate: "S", userPromptTemplate: "{{user_prompt}}", maxIterations: 2 }),
        node("model", "llm_call", { provider: { providerId: "fake", model: "fake-model" } }),
        node("tool", "mcp_tool", { serverId: "mock-mcp", toolName: "__all__" }),
        node("output", "output")
      ],
      [edge("trigger", "agent"), edge("agent", "output"), edge("agent", "model", "chat_model"), edge("agent", "tool", "tool")]
    );
    const inlineResult = await executeWorkflow({ workflow: inline, webhookPayload: { user_prompt: "go" } }, makeDeps(samplingAgent));
    expect(inlineResult.status).toBe("error");
    expect(inlineResult.error).toContain("only available for servers in the MCP server registry");
  }, SLOW);

  it("honours model hints only within the allowed list and enforces the per-call budget", async () => {
    expect(chooseSamplingModel({ providerId: "fake", model: "base" }, { allow: true, maxTokens: 10, allowedModels: ["small", "big"], maxRequestsPerCall: 1 }, ["big"])).toEqual({ model: "big", honouredHint: true });
    expect(chooseSamplingModel({ providerId: "fake", model: "base" }, { allow: true, maxTokens: 10, allowedModels: ["small"], maxRequestsPerCall: 1 }, ["evil"])).toEqual({ model: "base", honouredHint: false });

    const hinting = new ScriptedAgentRuntime(async (_request, tools) => {
      const first = await tools.invokeTool("mock-mcp__summarize_with_model", { text: "one", model: "fake-small" });
      const second = await tools.invokeTool("mock-mcp__summarize_with_model", { text: "two", model: "not-allowed" });
      return { finalAnswer: JSON.stringify([first, second]) };
    });
    const deps = makeDeps(hinting, { sampling: { allow: true, allowedModels: ["fake-small"], maxTokens: 50 } });
    const result = await executeWorkflow({ workflow: agentWorkflow(), webhookPayload: { user_prompt: "go" } }, deps);
    expect(result.status).toBe("success");
    const [first, second] = JSON.parse(String(output(result, "agent").answer)) as Array<{ model: string }>;
    expect(first.model).toBe("fake-small");
    expect(second.model).toBe("fake-model");
    expect(deps.provider.calls.map((call) => call.provider.maxTokens)).toEqual([50, 50]);

    const greedy = new ScriptedAgentRuntime(async (_request, tools) => {
      await tools.invokeTool("mock-mcp__summarize_with_model", { text: "one" });
      return undefined;
    });
    const greedyRegistry = createDefaultMCPRegistry();
    const greedyDeps = makeDeps(greedy, { sampling: { allow: true, maxRequestsPerCall: 1 }, extra: { mcpRegistry: greedyRegistry } });
    // Two sampling requests inside one tool call: the second exceeds the budget.
    const mock = greedyRegistry.get("mock-mcp");
    const originalInvoke = mock.invokeTool.bind(mock);
    mock.invokeTool = async (toolName, args, config, context) => {
      if (toolName === "summarize_with_model" && context.onSampling) {
        await context.onSampling({ messages: [{ role: "user", content: { type: "text", text: "a" } }], maxTokens: 5 }, { serverId: config.serverId, registryServerId: config.registryServerId, toolName });
        try {
          await context.onSampling({ messages: [{ role: "user", content: { type: "text", text: "b" } }], maxTokens: 5 }, { serverId: config.serverId, registryServerId: config.registryServerId, toolName });
          return { ok: true, output: "second allowed" };
        } catch (error) {
          return { ok: true, output: error instanceof Error ? error.message : String(error) };
        }
      }
      return originalInvoke(toolName, args, config, context);
    };
    const over = await executeWorkflow({ workflow: agentWorkflow(), webhookPayload: { user_prompt: "go" } }, greedyDeps);
    const trace = output(over, "agent")._mcpSampling as McpSamplingTraceEntry[];
    expect(trace.map((entry) => entry.ok)).toEqual([true, false]);
    expect(trace[1].error).toContain("Sampling budget exhausted");
  }, SLOW);

  it("direct MCP Tool nodes sample only through a configured default model", async () => {
    const workflow = directWorkflow({ toolName: "summarize_with_model", argsTemplate: JSON.stringify({ text: "some text" }) });
    const refused = await executeWorkflow({ workflow, webhookPayload: {} }, makeDeps(noop, { sampling: { allow: true } }));
    expect(refused.status).toBe("error");
    expect(refused.error).toContain("no chat model is attached");

    const deps = makeDeps(noop, { sampling: { allow: true, defaultModel: { providerId: "fake", model: "fake-default" } } });
    const result = await executeWorkflow({ workflow, webhookPayload: {} }, deps);
    expect(result.status).toBe("success");
    const out = output(result, "tool");
    expect(out.tool_output).toMatchObject({ model: "fake-default" });
    expect((out._mcpSampling as McpSamplingTraceEntry[])[0]).toMatchObject({ model: "fake-default", ok: true });
    expect(out._telemetry).toMatchObject({ providerId: "fake", model: "fake-default", llmCallCount: 1, usage: { inputTokens: 11, outputTokens: 7 } });
  }, SLOW);
});
