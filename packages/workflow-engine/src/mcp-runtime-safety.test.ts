/**
 * Phase 10.7 — MCP runtime safety through the engine: rate-limited and
 * breaker-rejected calls reach agents as tool errors they can reason about
 * and fail direct MCP Tool nodes; delegated servers get the run subject's
 * user (or the owner, when the server allows it for unattended runs), and a
 * missing connection fails the node instead of silently dropping the server.
 */
import { describe, expect, it } from "vitest";
import { DefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import {
  MCPRegistry,
  McpDelegatedCredentialError,
  McpRuntimeGuard,
  MockMCPServerAdapter,
  withRuntimeLimits,
  type MCPServerAdapter
} from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry, type LLMProviderAdapter } from "@ai-orchestrator/provider-sdk";
import type { AgentRunState, LLMCallResponse, McpRuntimeLimits, McpToolPolicySubject, MCPServerConfig, Workflow } from "@ai-orchestrator/shared";
import { executeWorkflow, type WorkflowExecutionDependencies } from "./executor";

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

const REGISTRY_ID = "mcp_mock";

function deps(input: { registry: MCPRegistry; server: MCPServerConfig; script?: LLMCallResponse[] }): WorkflowExecutionDependencies {
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(
    new ScriptedProvider(
      input.script ?? [
        { content: "", toolCalls: [{ id: "c1", name: "mock-mcp__get_current_time", arguments: { tz: "UTC" } }] },
        { content: "done", toolCalls: [] }
      ]
    )
  );
  return {
    providerRegistry,
    mcpRegistry: input.registry,
    connectorRegistry: createDefaultConnectorRegistry(),
    agentRuntime: new DefaultAgentRuntime(),
    resolveSecret: async () => undefined,
    resolveRegisteredMcpServer: (id) => {
      if (id !== REGISTRY_ID) throw new Error(`unknown server ${id}`);
      return input.server;
    }
  };
}

function agentWorkflow(): Workflow {
  return {
    id: "wf-agent",
    name: "Agent",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      { id: "hook", type: "webhook_input", name: "Webhook", position: { x: 0, y: 0 }, config: {} },
      { id: "agent", type: "agent_orchestrator", name: "Agent", position: { x: 200, y: 0 }, config: { systemPromptTemplate: "Use tools.", userPromptTemplate: "{{user_prompt}}", maxIterations: 4, retry: { enabled: false } } },
      { id: "model", type: "llm_call", name: "Model", position: { x: 200, y: 160 }, config: { provider: { providerId: "scripted", model: "m" } } },
      { id: "tools", type: "mcp_tool", name: "Tools", position: { x: 320, y: 160 }, config: { registryServerId: REGISTRY_ID, toolName: "__all__" } },
      { id: "out", type: "output", name: "Output", position: { x: 600, y: 0 }, config: {} }
    ],
    edges: [
      { id: "e1", source: "hook", target: "agent" },
      { id: "e2", source: "agent", target: "out" },
      { id: "e4", source: "agent", sourceHandle: "chat_model", target: "model" },
      { id: "e5", source: "agent", sourceHandle: "tool", target: "tools" }
    ]
  };
}

function toolWorkflow(): Workflow {
  return {
    id: "wf-tool",
    name: "Tool",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      { id: "hook", type: "webhook_input", name: "Webhook", position: { x: 0, y: 0 }, config: {} },
      { id: "tool", type: "mcp_tool", name: "Clock", position: { x: 200, y: 0 }, config: { registryServerId: REGISTRY_ID, toolName: "get_current_time", argsTemplate: "{}", retry: { enabled: false } } },
      { id: "out", type: "output", name: "Output", position: { x: 400, y: 0 }, config: {} }
    ],
    edges: [
      { id: "e1", source: "hook", target: "tool" },
      { id: "e2", source: "tool", target: "out" }
    ]
  };
}

function limitedRegistry(guard: McpRuntimeGuard): MCPRegistry {
  const registry = new MCPRegistry();
  registry.register(withRuntimeLimits(new MockMCPServerAdapter(), guard));
  return registry;
}

const limitedServer = (limits: Partial<McpRuntimeLimits>): MCPServerConfig => ({
  serverId: "mock-mcp",
  registryServerId: REGISTRY_ID,
  label: "Mock",
  connection: {},
  limits: limits as McpRuntimeLimits
});

const user: McpToolPolicySubject = { role: "builder", source: "user", userId: "u_alice", email: "alice@example.com" };
const owner: McpToolPolicySubject = { role: "builder", source: "owner", userId: "u_owner", email: "owner@example.com" };

const toolResultsOf = (result: Awaited<ReturnType<typeof executeWorkflow>>) => {
  const output = result.nodeResults.find((entry) => entry.nodeId === "agent")?.output as Record<string, unknown> | undefined;
  return ((output?.steps ?? []) as AgentRunState["steps"]).flatMap((step) => step.toolResults);
};

describe("runtime limits through the engine", () => {
  it("hands a rate-limited call to the agent as a tool error with a retry hint", async () => {
    const guard = new McpRuntimeGuard();
    const server = limitedServer({ requestsPerMinute: 1, maxQueueWaitMs: 0 });
    const result = await executeWorkflow(
      { workflow: agentWorkflow(), webhookPayload: { user_prompt: "time twice" }, toolPolicySubject: user },
      deps({
        registry: limitedRegistry(guard),
        server,
        script: [
          {
            content: "",
            toolCalls: [
              { id: "c1", name: "mock-mcp__get_current_time", arguments: { tz: "UTC" } },
              { id: "c2", name: "mock-mcp__get_current_time", arguments: { tz: "Asia/Tokyo" } }
            ]
          },
          { content: "One worked, the other was rate limited.", toolCalls: [] }
        ]
      })
    );
    expect(result.status).toBe("success");
    const [first, second] = toolResultsOf(result);
    expect(first?.error).toBeUndefined();
    expect(second?.error).toMatch(/^Rate limited: MCP server 'Mock' allows 1 calls per minute\. Retry in \d+ s\.$/);
    expect(guard.snapshot(REGISTRY_ID).rejected.rate_limited).toBe(1);
  });

  it("hands an open breaker to the agent as a tool error and fails a direct MCP Tool node", async () => {
    const guard = new McpRuntimeGuard();
    const server = limitedServer({ breaker: { enabled: true, failureThreshold: 1, errorRatePercent: 100, windowMs: 60_000, minimumCalls: 100, cooldownMs: 60_000 } });
    // Trip the breaker with one transport failure.
    const failing: MCPServerAdapter = {
      definition: new MockMCPServerAdapter().definition,
      discoverTools: async () => [],
      invokeTool: async () => ({ ok: false, output: null, error: "connection refused", errorKind: "transport" })
    };
    await withRuntimeLimits(failing, guard).invokeTool("get_current_time", {}, server, { resolveSecret: async () => undefined });
    expect(guard.snapshot(REGISTRY_ID).breaker.state).toBe("open");

    const agentRun = await executeWorkflow(
      { workflow: agentWorkflow(), webhookPayload: { user_prompt: "time" }, toolPolicySubject: user },
      deps({ registry: limitedRegistry(guard), server })
    );
    expect(agentRun.status).toBe("success");
    expect(toolResultsOf(agentRun)[0]?.error).toMatch(/^Circuit open: MCP server 'Mock' is paused after repeated failures\. Retry in \d+ s/);

    const direct = await executeWorkflow({ workflow: toolWorkflow(), webhookPayload: {}, toolPolicySubject: user }, deps({ registry: limitedRegistry(guard), server }));
    expect(direct.status).toBe("error");
    expect(direct.nodeResults.find((entry) => entry.nodeId === "tool")?.error).toMatch(/^Circuit open: MCP server 'Mock'/);
  });
});

describe("delegated credentials through the engine", () => {
  /** A mock whose calls report the user they were made for. */
  function capturingRegistry(seen: Array<string | undefined>, options: { missingFor?: string } = {}): MCPRegistry {
    const mock = new MockMCPServerAdapter();
    const adapter: MCPServerAdapter = {
      definition: mock.definition,
      discoverTools: async (config, context) => {
        if (options.missingFor && config.delegatedUser?.userId === options.missingFor) {
          throw new McpDelegatedCredentialError(`Connect your account to 'Mock' first: http://studio.local/#mcp-connections`);
        }
        return mock.discoverTools(config, context);
      },
      invokeTool: async (name, args, config, context) => {
        seen.push(config.delegatedUser?.userId);
        if (options.missingFor && config.delegatedUser?.userId === options.missingFor) {
          return { ok: false, output: null, error: "Connect your account to 'Mock' first: http://studio.local/#mcp-connections", errorKind: "credentials" };
        }
        return mock.invokeTool(name, args, config, context);
      }
    };
    const registry = new MCPRegistry();
    registry.register(adapter);
    return registry;
  }

  const delegatedServer = (fallback: "none" | "owner"): MCPServerConfig => ({
    serverId: "mock-mcp",
    registryServerId: REGISTRY_ID,
    label: "Mock",
    connection: {},
    credentialMode: "delegated",
    delegatedFallback: fallback
  });

  it("calls with the token of the person who started the run", async () => {
    const seen: Array<string | undefined> = [];
    const result = await executeWorkflow(
      { workflow: toolWorkflow(), webhookPayload: {}, toolPolicySubject: user },
      deps({ registry: capturingRegistry(seen), server: delegatedServer("owner") })
    );
    expect(result.status).toBe("success");
    expect(seen).toEqual(["u_alice"]);
  });

  it("uses the workflow owner for unattended runs only when the server allows it", async () => {
    const allowedSeen: Array<string | undefined> = [];
    const allowed = await executeWorkflow(
      { workflow: toolWorkflow(), webhookPayload: {}, toolPolicySubject: owner },
      deps({ registry: capturingRegistry(allowedSeen), server: delegatedServer("owner") })
    );
    expect(allowed.status).toBe("success");
    expect(allowedSeen).toEqual(["u_owner"]);

    const refusedSeen: Array<string | undefined> = [];
    const refused = await executeWorkflow(
      { workflow: toolWorkflow(), webhookPayload: {}, toolPolicySubject: owner },
      deps({ registry: capturingRegistry(refusedSeen), server: delegatedServer("none") })
    );
    expect(refused.status).toBe("error");
    expect(refused.nodeResults.find((entry) => entry.nodeId === "tool")?.error).toMatch(/no signed-in user \(webhook, schedule or queue\)/);
    expect(refusedSeen).toEqual([]);

    const noSubject = await executeWorkflow(
      { workflow: toolWorkflow(), webhookPayload: {}, toolPolicySubject: { role: "viewer", source: "fallback" } },
      deps({ registry: capturingRegistry([]), server: delegatedServer("owner") })
    );
    expect(noSubject.status).toBe("error");
  });

  it("fails the node with the connect link when the user has no connection, for agents and direct nodes", async () => {
    const direct = await executeWorkflow(
      { workflow: toolWorkflow(), webhookPayload: {}, toolPolicySubject: user },
      deps({ registry: capturingRegistry([], { missingFor: "u_alice" }), server: delegatedServer("none") })
    );
    expect(direct.status).toBe("error");
    expect(direct.nodeResults.find((entry) => entry.nodeId === "tool")?.error).toContain("http://studio.local/#mcp-connections");

    const agent = await executeWorkflow(
      { workflow: agentWorkflow(), webhookPayload: { user_prompt: "time" }, toolPolicySubject: user },
      deps({ registry: capturingRegistry([], { missingFor: "u_alice" }), server: delegatedServer("none") })
    );
    expect(agent.status).toBe("error");
    expect(agent.nodeResults.find((entry) => entry.nodeId === "agent")?.error).toContain("Connect your account to 'Mock' first");
  });

  it("ignores runtime safety fields on inline (non-registry) server configs", async () => {
    const seen: Array<string | undefined> = [];
    const workflow = toolWorkflow();
    workflow.nodes[1]!.config = { serverId: "mock-mcp", toolName: "get_current_time", argsTemplate: "{}", retry: { enabled: false } };
    const result = await executeWorkflow({ workflow, webhookPayload: {}, toolPolicySubject: user }, deps({ registry: capturingRegistry(seen), server: delegatedServer("none") }));
    expect(result.nodeResults.find((entry) => entry.nodeId === "tool")?.error).toBeUndefined();
    expect(result.status).toBe("success");
    expect(seen).toEqual([undefined]);
  });
});
