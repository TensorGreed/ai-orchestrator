import { describe, expect, it } from "vitest";
import type { AgentRuntimeAdapter } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry, type LLMProviderAdapter } from "@ai-orchestrator/provider-sdk";
import type { AgentRunRequest, AgentRunState, MCPServerConfig, Workflow, WorkflowNode } from "@ai-orchestrator/shared";
import { executeWorkflow } from "./executor";
import { validateWorkflowGraph } from "./validation";

class FakeProvider implements LLMProviderAdapter {
  readonly definition = { id: "fake", label: "Fake", supportsTools: true, configSchema: {} };

  async generate() {
    return { content: "ok", toolCalls: [] };
  }
}

class CapturingAgentRuntime implements AgentRuntimeAdapter {
  readonly id = "capturing-agent";
  lastRequest: AgentRunRequest | null = null;

  async run(request: AgentRunRequest): Promise<AgentRunState> {
    this.lastRequest = request;
    return { finalAnswer: "done", stopReason: "final_answer", iterations: 1, messages: [], steps: [] };
  }
}

const registered: Record<string, MCPServerConfig> = {
  mcp_calc: { serverId: "mock-mcp", label: "Calculator", connection: {} }
};

function dependencies(
  overrides: {
    runtime?: AgentRuntimeAdapter;
    resolve?: ((id: string) => MCPServerConfig | Promise<MCPServerConfig>) | null;
  } = {}
) {
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(new FakeProvider());
  const resolveRegisteredMcpServer =
    overrides.resolve === null
      ? undefined
      : overrides.resolve ??
        ((id: string) => {
          const server = registered[id];
          if (!server) throw new Error(`MCP server not found in registry: ${id}`);
          return server;
        });
  return {
    providerRegistry,
    connectorRegistry: createDefaultConnectorRegistry(),
    mcpRegistry: createDefaultMCPRegistry(),
    agentRuntime: overrides.runtime ?? new CapturingAgentRuntime(),
    resolveSecret: async () => undefined,
    resolveRegisteredMcpServer
  };
}

function directToolWorkflow(config: Record<string, unknown>): Workflow {
  return {
    id: "wf-registry-direct",
    name: "Registry direct tool",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
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

function agentWorkflow(toolConfig: Record<string, unknown>, agentExtra: Record<string, unknown> = {}): Workflow {
  const nodes: WorkflowNode[] = [
    { id: "webhook", type: "webhook_input", name: "Webhook", position: { x: 0, y: 0 }, config: {} },
    {
      id: "agent",
      type: "agent_orchestrator",
      name: "Agent",
      position: { x: 200, y: 0 },
      config: { userPromptTemplate: "{{user_prompt}}", maxIterations: 3, toolCallingEnabled: true, ...agentExtra }
    },
    {
      id: "model",
      type: "llm_call",
      name: "Model",
      position: { x: 200, y: 160 },
      config: { provider: { providerId: "fake", model: "fake-model" } }
    },
    { id: "output", type: "output", name: "Output", position: { x: 400, y: 0 }, config: {} }
  ];
  const edges = [
    { id: "e1", source: "webhook", target: "agent" },
    { id: "e2", source: "agent", target: "output" },
    { id: "e3", source: "agent", sourceHandle: "chat_model", target: "model" }
  ];
  if (Object.keys(toolConfig).length) {
    nodes.push({ id: "tool", type: "mcp_tool", name: "Tool", position: { x: 340, y: 160 }, config: toolConfig });
    edges.push({ id: "e4", source: "agent", sourceHandle: "tool", target: "tool" });
  }
  return { id: "wf-registry-agent", name: "Registry agent", schemaVersion: "1.0.0", workflowVersion: 1, nodes, edges };
}

describe("MCP server registry references", () => {
  it("runs a direct MCP Tool node through the registered server, ignoring inline connection", async () => {
    const result = await executeWorkflow(
      {
        workflow: directToolWorkflow({
          registryServerId: "mcp_calc",
          serverId: "http_mcp",
          connection: { endpoint: "http://stale.invalid/mcp" },
          toolName: "calculator",
          argsTemplate: "{\"expression\":\"6*7\"}"
        })
      },
      dependencies()
    );

    expect(result.status).toBe("success");
    const output = result.nodeResults.find((entry) => entry.nodeId === "tool")?.output as Record<string, unknown>;
    expect(output.invocation_request).toMatchObject({ server_id: "mock-mcp", registry_server_id: "mcp_calc" });
    expect(JSON.stringify(output.tool_output)).toContain("42");
  });

  it("resolves attached tool nodes for the agent and keeps the node's tool allow-list", async () => {
    const runtime = new CapturingAgentRuntime();
    const result = await executeWorkflow(
      {
        workflow: agentWorkflow({ registryServerId: "mcp_calc", toolName: "calculator" }),
        webhookPayload: { user_prompt: "add" }
      },
      dependencies({ runtime })
    );

    expect(result.status).toBe("success");
    expect(runtime.lastRequest?.tools.map((tool) => tool.name)).toEqual(["mock-mcp__calculator"]);
  });

  it("resolves registry entries in the agent's inline mcpServers list", async () => {
    const runtime = new CapturingAgentRuntime();
    const result = await executeWorkflow(
      {
        workflow: agentWorkflow({}, { mcpServers: [{ registryServerId: "mcp_calc", allowedTools: ["calculator"] }] }),
        webhookPayload: { user_prompt: "add" }
      },
      dependencies({ runtime })
    );

    expect(result.status).toBe("success");
    expect(runtime.lastRequest?.tools.map((tool) => tool.name)).toEqual(["mock-mcp__calculator"]);
  });

  it("fails the node when the registry refuses the server", async () => {
    const result = await executeWorkflow(
      {
        workflow: directToolWorkflow({ registryServerId: "mcp_calc", toolName: "calculator", argsTemplate: "{}" })
      },
      dependencies({
        resolve: () => {
          throw new Error("MCP server 'Calculator' has an unaccepted breaking tool schema change");
        }
      })
    );

    expect(result.status).toBe("error");
    expect(result.nodeResults.find((entry) => entry.nodeId === "tool")?.error).toContain("unaccepted breaking");
  });

  it("explains when the runtime has no registry", async () => {
    const result = await executeWorkflow(
      {
        workflow: directToolWorkflow({ registryServerId: "mcp_calc", toolName: "calculator", argsTemplate: "{}" })
      },
      dependencies({ resolve: null })
    );

    expect(result.status).toBe("error");
    expect(result.nodeResults.find((entry) => entry.nodeId === "tool")?.error).toContain("server registry");
  });

  it("validates MCP Tool nodes with a registry reference and no serverId", () => {
    const codes = (config: Record<string, unknown>) =>
      validateWorkflowGraph(directToolWorkflow(config)).issues.map((issue) => issue.code);

    expect(codes({ registryServerId: "mcp_calc", toolName: "calculator" })).not.toContain("missing_mcp_tool_config");
    expect(codes({ serverId: "mock-mcp", toolName: "calculator" })).not.toContain("missing_mcp_tool_config");
    expect(codes({ registryServerId: " ", toolName: "calculator" })).toContain("missing_mcp_tool_config");
  });
});
