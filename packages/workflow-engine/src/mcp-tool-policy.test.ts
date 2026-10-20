/**
 * Phase 10.2 — MCP tool policy enforcement in the engine: discovery filter,
 * call-time check, direct MCP Tool nodes, the "no write tools" switch and the
 * `_toolPolicy` trace on agent outputs.
 */
import { describe, expect, it } from "vitest";
import { DefaultAgentRuntime, type AgentRuntimeAdapter } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry, type LLMProviderAdapter } from "@ai-orchestrator/provider-sdk";
import type {
  AgentRunRequest,
  AgentRunState,
  LLMCallResponse,
  MCPServerConfig,
  McpToolClassificationOverride,
  McpToolPolicyRule,
  McpToolPolicySubject,
  McpToolPolicyTrace,
  Workflow,
  WorkflowNode
} from "@ai-orchestrator/shared";
import { executeWorkflow, type WorkflowExecutionDependencies } from "./executor";

class FakeProvider implements LLMProviderAdapter {
  readonly definition = { id: "fake", label: "Fake", supportsTools: true, configSchema: {} };
  async generate() {
    return { content: "ok", toolCalls: [] };
  }
}

class ScriptedProvider implements LLMProviderAdapter {
  readonly definition = { id: "scripted", label: "Scripted", supportsTools: true, configSchema: {} };
  private index = 0;
  constructor(private readonly script: LLMCallResponse[]) {}
  async generate(): Promise<LLMCallResponse> {
    const response = this.script[Math.min(this.index, this.script.length - 1)];
    this.index += 1;
    return response;
  }
}

/** Records every request, so worker runs are visible too. */
class CapturingAgentRuntime implements AgentRuntimeAdapter {
  readonly id = "capturing-agent";
  requests: AgentRunRequest[] = [];
  invokeTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;

  async run(
    request: AgentRunRequest,
    tools: { invokeTool: (name: string, args: Record<string, unknown>) => Promise<unknown> }
  ): Promise<AgentRunState> {
    this.requests.push(request);
    this.invokeTool = tools.invokeTool;
    return { finalAnswer: "done", stopReason: "final_answer", iterations: 1, messages: [], steps: [] };
  }
}

const registered: Record<string, MCPServerConfig> = {
  mcp_mock: { serverId: "mock-mcp", label: "Mock", connection: {} }
};

function rule(partial: Partial<McpToolPolicyRule> & Pick<McpToolPolicyRule, "id" | "effect">): McpToolPolicyRule {
  return {
    name: null,
    description: null,
    projectId: null,
    roles: [],
    serverId: null,
    toolPattern: "*",
    enabled: true,
    ...partial
  };
}

function deps(options: {
  runtime?: AgentRuntimeAdapter;
  providers?: LLMProviderAdapter[];
  rules?: McpToolPolicyRule[];
  classifications?: McpToolClassificationOverride[];
  withPolicyStore?: boolean;
}): WorkflowExecutionDependencies {
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(new FakeProvider());
  for (const provider of options.providers ?? []) providerRegistry.register(provider);
  return {
    providerRegistry,
    connectorRegistry: createDefaultConnectorRegistry(),
    mcpRegistry: createDefaultMCPRegistry(),
    agentRuntime: options.runtime ?? new CapturingAgentRuntime(),
    resolveSecret: async () => undefined,
    resolveRegisteredMcpServer: (id: string) => {
      const server = registered[id];
      if (!server) throw new Error(`unknown registry server ${id}`);
      return server;
    },
    ...(options.withPolicyStore === false
      ? {}
      : {
          loadMcpToolPolicy: () => ({ rules: options.rules ?? [], classifications: options.classifications ?? [] })
        })
  };
}

const viewer: McpToolPolicySubject = { role: "viewer", source: "user", userId: "u-1", email: "val@example.com" };
const builder: McpToolPolicySubject = { role: "builder", source: "user", userId: "u-2", email: "bo@example.com" };

function agentNodes(id: string, providerId = "fake"): WorkflowNode[] {
  return [
    {
      id,
      type: "agent_orchestrator",
      name: id,
      position: { x: 200, y: 0 },
      config: { userPromptTemplate: "{{user_prompt}}", maxIterations: 3, toolCallingEnabled: true }
    },
    {
      id: `${id}-model`,
      type: "llm_call",
      name: `${id} model`,
      position: { x: 200, y: 160 },
      config: { provider: { providerId, model: "m" } }
    }
  ];
}

function agentWorkflow(options: {
  toolConfig?: Record<string, unknown>;
  noWriteTools?: boolean;
  providerId?: string;
  projectId?: string;
}): Workflow {
  const nodes: WorkflowNode[] = [
    { id: "webhook", type: "webhook_input", name: "Webhook", position: { x: 0, y: 0 }, config: {} },
    ...agentNodes("agent", options.providerId),
    { id: "output", type: "output", name: "Output", position: { x: 400, y: 0 }, config: {} },
    {
      id: "tool",
      type: "mcp_tool",
      name: "Tool",
      position: { x: 340, y: 160 },
      config: options.toolConfig ?? { registryServerId: "mcp_mock", toolName: "__all__" }
    }
  ];
  return {
    id: "wf-policy-agent",
    name: "Policy agent",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: options.projectId ?? "default",
    ...(options.noWriteTools ? { settings: { noWriteTools: true } } : {}),
    nodes,
    edges: [
      { id: "e1", source: "webhook", target: "agent" },
      { id: "e2", source: "agent", target: "output" },
      { id: "e3", source: "agent", sourceHandle: "chat_model", target: "agent-model" },
      { id: "e4", source: "agent", sourceHandle: "tool", target: "tool" }
    ]
  };
}

function directWorkflow(config: Record<string, unknown>, noWriteTools = false): Workflow {
  return {
    id: "wf-policy-direct",
    name: "Policy direct",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    ...(noWriteTools ? { settings: { noWriteTools: true } } : {}),
    nodes: [
      { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
      { id: "tool", type: "mcp_tool", name: "Tool", position: { x: 200, y: 0 }, config },
      { id: "output", type: "output", name: "Output", position: { x: 400, y: 0 }, config: {} }
    ],
    edges: [
      { id: "e1", source: "start", target: "tool" },
      { id: "e2", source: "tool", target: "output" }
    ]
  };
}

function nodeOutput(result: Awaited<ReturnType<typeof executeWorkflow>>, nodeId: string) {
  return result.nodeResults.find((entry) => entry.nodeId === nodeId)?.output as Record<string, unknown> | undefined;
}

const toolNames = (request: AgentRunRequest | undefined) => (request?.tools ?? []).map((tool) => tool.name).sort();

describe("MCP tool policy — discovery filter", () => {
  it("hides denied tools from the agent and records why on the output", async () => {
    const runtime = new CapturingAgentRuntime();
    const result = await executeWorkflow(
      { workflow: agentWorkflow({}), webhookPayload: { user_prompt: "go" }, toolPolicySubject: viewer },
      deps({
        runtime,
        rules: [rule({ id: "r-calc", name: "No calculator for viewers", effect: "deny", roles: ["viewer"], toolPattern: "calc*" })]
      })
    );

    expect(result.status).toBe("success");
    expect(toolNames(runtime.requests[0])).toEqual(["mock-mcp__get_current_time", "mock-mcp__lookup_kb"]);
    const trace = nodeOutput(result, "agent")?._toolPolicy as McpToolPolicyTrace;
    expect(trace.subject).toEqual(viewer);
    expect(trace.projectId).toBe("default");
    expect(trace.noWriteTools).toBe(false);
    expect(trace.hidden).toEqual([
      {
        tool: "calculator",
        server: "mock-mcp",
        registryServerId: "mcp_mock",
        reason: "policy",
        ruleId: "r-calc",
        ruleName: "No calculator for viewers"
      }
    ]);
  });

  it("leaves the tool set alone for roles the rule does not cover", async () => {
    const runtime = new CapturingAgentRuntime();
    await executeWorkflow(
      { workflow: agentWorkflow({}), webhookPayload: { user_prompt: "go" }, toolPolicySubject: builder },
      deps({ runtime, rules: [rule({ id: "r-calc", effect: "deny", roles: ["viewer"], toolPattern: "calculator" })] })
    );
    expect(toolNames(runtime.requests[0])).toHaveLength(3);
  });

  it("evaluates a run without a subject as viewer and says so", async () => {
    const runtime = new CapturingAgentRuntime();
    const result = await executeWorkflow(
      { workflow: agentWorkflow({}), webhookPayload: { user_prompt: "go" } },
      deps({ runtime, rules: [rule({ id: "r-all", effect: "deny", roles: ["viewer"], serverId: "mcp_mock" })] })
    );
    expect(toolNames(runtime.requests[0])).toEqual([]);
    const trace = nodeOutput(result, "agent")?._toolPolicy as McpToolPolicyTrace;
    expect(trace.subject.role).toBe("viewer");
    expect(trace.subject.source).toBe("fallback");
    expect(trace.hidden).toHaveLength(3);
  });

  it("applies the policy to a supervisor and to each worker it delegates to", async () => {
    const runtime = new CapturingAgentRuntime();
    const workflow: Workflow = {
      id: "wf-policy-supervisor",
      name: "Supervisor",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "default",
      nodes: [
        { id: "webhook", type: "webhook_input", name: "Webhook", position: { x: 0, y: 0 }, config: {} },
        {
          id: "boss",
          type: "supervisor_node",
          name: "Boss",
          position: { x: 200, y: 0 },
          config: { userPromptTemplate: "{{user_prompt}}", maxIterations: 3 }
        },
        { id: "boss-model", type: "llm_call", name: "Boss model", position: { x: 200, y: 160 }, config: { provider: { providerId: "fake", model: "m" } } },
        { id: "boss-tool", type: "mcp_tool", name: "Boss tool", position: { x: 300, y: 160 }, config: { registryServerId: "mcp_mock", toolName: "__all__" } },
        {
          id: "worker",
          type: "agent_orchestrator",
          name: "Researcher",
          position: { x: 400, y: 160 },
          config: { userPromptTemplate: "{{user_prompt}}", maxIterations: 2 }
        },
        { id: "worker-model", type: "llm_call", name: "Worker model", position: { x: 400, y: 320 }, config: { provider: { providerId: "fake", model: "m" } } },
        { id: "worker-tool", type: "mcp_tool", name: "Worker tool", position: { x: 500, y: 320 }, config: { serverId: "mock-mcp", toolName: "__all__" } },
        { id: "output", type: "output", name: "Output", position: { x: 600, y: 0 }, config: {} }
      ],
      edges: [
        { id: "e1", source: "webhook", target: "boss" },
        { id: "e2", source: "boss", target: "output" },
        { id: "e3", source: "boss", sourceHandle: "chat_model", target: "boss-model" },
        { id: "e4", source: "boss", sourceHandle: "tool", target: "boss-tool" },
        { id: "e5", source: "boss", sourceHandle: "worker", target: "worker" },
        { id: "e6", source: "worker", sourceHandle: "chat_model", target: "worker-model" },
        { id: "e7", source: "worker", sourceHandle: "tool", target: "worker-tool" }
      ]
    };

    const result = await executeWorkflow(
      { workflow, webhookPayload: { user_prompt: "go" }, toolPolicySubject: viewer },
      deps({ runtime, rules: [rule({ id: "r-calc", effect: "deny", roles: ["viewer"], toolPattern: "calculator" })] })
    );
    expect(result.status).toBe("success");
    const supervisorTools = toolNames(runtime.requests[0]);
    expect(supervisorTools).not.toContain("mock-mcp__calculator");
    expect(supervisorTools).toContain("delegate_to_Researcher");

    // Delegate through the supervisor's tool bridge: the worker resolves its own tools under the same policy.
    const workerOutput = (await runtime.invokeTool!("delegate_to_Researcher", { task_prompt: "look it up" })) as Record<string, unknown>;
    expect(toolNames(runtime.requests[1])).toEqual(["mock-mcp__get_current_time", "mock-mcp__lookup_kb"]);
    const workerTrace = workerOutput._toolPolicy as McpToolPolicyTrace;
    expect(workerTrace.subject).toEqual(viewer);
    expect(workerTrace.hidden).toEqual([expect.objectContaining({ tool: "calculator", server: "mock-mcp", reason: "policy", ruleId: "r-calc" })]);
    expect(workerTrace.hidden[0].registryServerId).toBeUndefined();
  });

  it("uses the adapter id to match inline servers, never registry servers", async () => {
    const inlineRuntime = new CapturingAgentRuntime();
    await executeWorkflow(
      { workflow: agentWorkflow({ toolConfig: { serverId: "mock-mcp", toolName: "__all__" } }), webhookPayload: { user_prompt: "go" }, toolPolicySubject: viewer },
      deps({ runtime: inlineRuntime, rules: [rule({ id: "r-adapter", effect: "deny", serverId: "mock-mcp" })] })
    );
    expect(toolNames(inlineRuntime.requests[0])).toEqual([]);

    const registryRuntime = new CapturingAgentRuntime();
    await executeWorkflow(
      { workflow: agentWorkflow({}), webhookPayload: { user_prompt: "go" }, toolPolicySubject: viewer },
      deps({ runtime: registryRuntime, rules: [rule({ id: "r-adapter", effect: "deny", serverId: "mock-mcp" })] })
    );
    expect(toolNames(registryRuntime.requests[0])).toHaveLength(3);
  });
});

describe("MCP tool policy — call-time check", () => {
  it("answers a call to a hidden tool with a policy error the telemetry records as failed", async () => {
    const provider = new ScriptedProvider([
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "mock-mcp__calculator", arguments: { expression: "1+1" } }]
      },
      { content: "gave up", toolCalls: [] }
    ]);
    const result = await executeWorkflow(
      { workflow: agentWorkflow({ providerId: "scripted" }), webhookPayload: { user_prompt: "add" }, toolPolicySubject: viewer },
      deps({
        runtime: new DefaultAgentRuntime(),
        providers: [provider],
        rules: [rule({ id: "r-calc", name: "No calculator", effect: "deny", roles: ["viewer"], toolPattern: "calculator" })]
      })
    );

    expect(result.status).toBe("success");
    const agent = nodeOutput(result, "agent")!;
    const steps = agent.steps as AgentRunState["steps"];
    const toolResult = steps[0].toolResults[0];
    expect(toolResult.toolName).toBe("mock-mcp__calculator");
    expect(toolResult.error).toContain("blocked by policy 'No calculator' (r-calc)");
    expect(toolResult.output).toBeNull();
  });
});

describe("MCP tool policy — direct MCP Tool nodes", () => {
  it("fails a denied direct call with a message naming the rule", async () => {
    const result = await executeWorkflow(
      {
        workflow: directWorkflow({ registryServerId: "mcp_mock", toolName: "calculator", argsTemplate: "{\"expression\":\"2+2\"}" }),
        toolPolicySubject: viewer
      },
      deps({ rules: [rule({ id: "r-calc", name: "Viewers cannot calculate", effect: "deny", roles: ["viewer"], toolPattern: "calculator" })] })
    );
    expect(result.status).toBe("error");
    const error = result.nodeResults.find((entry) => entry.nodeId === "tool")?.error;
    expect(error).toContain("blocked by policy 'Viewers cannot calculate' (r-calc)");
    expect(error).toContain("role viewer");
  });

  it("runs the direct call when an allow rule carves an exception out of a broader deny", async () => {
    const result = await executeWorkflow(
      {
        workflow: directWorkflow({ registryServerId: "mcp_mock", toolName: "calculator", argsTemplate: "{\"expression\":\"2+2\"}" }),
        toolPolicySubject: viewer
      },
      deps({
        rules: [
          rule({ id: "r-deny", effect: "deny", roles: ["viewer"], serverId: "mcp_mock" }),
          rule({ id: "r-allow", effect: "allow", roles: ["viewer"], serverId: "mcp_mock", toolPattern: "calculator" })
        ]
      })
    );
    expect(result.status).toBe("success");
    expect(JSON.stringify(nodeOutput(result, "tool")?.tool_output)).toContain("4");
  });
});

describe("MCP tool policy — no write tools", () => {
  it("hides unannotated tools from agents and keeps readOnlyHint tools", async () => {
    const runtime = new CapturingAgentRuntime();
    const result = await executeWorkflow(
      { workflow: agentWorkflow({ noWriteTools: true }), webhookPayload: { user_prompt: "go" }, toolPolicySubject: builder },
      deps({ runtime })
    );
    expect(toolNames(runtime.requests[0])).toEqual(["mock-mcp__get_current_time", "mock-mcp__lookup_kb"]);
    const trace = nodeOutput(result, "agent")?._toolPolicy as McpToolPolicyTrace;
    expect(trace.noWriteTools).toBe(true);
    expect(trace.hidden).toEqual([{ tool: "calculator", server: "mock-mcp", registryServerId: "mcp_mock", reason: "no_write_tools" }]);
  });

  it("is enforced even without a policy store", async () => {
    const runtime = new CapturingAgentRuntime();
    await executeWorkflow(
      { workflow: agentWorkflow({ noWriteTools: true, toolConfig: { serverId: "mock-mcp", toolName: "__all__" } }), webhookPayload: { user_prompt: "go" } },
      deps({ runtime, withPolicyStore: false })
    );
    expect(toolNames(runtime.requests[0])).toEqual(["mock-mcp__get_current_time", "mock-mcp__lookup_kb"]);
  });

  it("lets an admin's manual classification win over annotations, both ways", async () => {
    const runtime = new CapturingAgentRuntime();
    await executeWorkflow(
      { workflow: agentWorkflow({ noWriteTools: true }), webhookPayload: { user_prompt: "go" }, toolPolicySubject: builder },
      deps({
        runtime,
        classifications: [
          { registryServerId: "mcp_mock", toolName: "calculator", readOnly: true },
          { registryServerId: "mcp_mock", toolName: "lookup_kb", readOnly: false }
        ]
      })
    );
    expect(toolNames(runtime.requests[0])).toEqual(["mock-mcp__calculator", "mock-mcp__get_current_time"]);
  });

  it("blocks a direct call to an unannotated tool and allows an annotated read-only one", async () => {
    const blocked = await executeWorkflow(
      { workflow: directWorkflow({ serverId: "mock-mcp", toolName: "calculator", argsTemplate: "{\"expression\":\"1+1\"}" }, true), toolPolicySubject: builder },
      deps({})
    );
    expect(blocked.status).toBe("error");
    expect(blocked.nodeResults.find((entry) => entry.nodeId === "tool")?.error).toContain("allows no write tools");

    const allowed = await executeWorkflow(
      { workflow: directWorkflow({ serverId: "mock-mcp", toolName: "lookup_kb", argsTemplate: "{\"topic\":\"mcp\"}" }, true), toolPolicySubject: builder },
      deps({})
    );
    expect(allowed.status).toBe("success");
  });

  it("does not attach a policy trace when nothing is enforced", async () => {
    const result = await executeWorkflow(
      { workflow: agentWorkflow({}), webhookPayload: { user_prompt: "go" } },
      deps({ withPolicyStore: false })
    );
    expect(nodeOutput(result, "agent")?._toolPolicy).toBeUndefined();
  });
});
