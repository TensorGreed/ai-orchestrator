/**
 * Phase 6.4 — two MCP servers on one agent serving the same tool name: both are renamed after their server, each call
 * runs on its own server, and the tool policy judges the server and tool the call runs (rules keyed on the original
 * name still match).
 */
import { describe, expect, it } from "vitest";
import { DefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { MCPRegistry, disambiguatedToolName, serverIdentityHash, type MCPServerAdapter } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry, type LLMProviderAdapter, type ProviderCallRequest } from "@ai-orchestrator/provider-sdk";
import type { ChatMessage, MCPServerConfig, McpToolPolicyRule, Workflow, WorkflowExecutionState, WorkflowNode } from "@ai-orchestrator/shared";
import { executeWorkflow, type WorkflowExecutionDependencies } from "./executor";
import { validateWorkflowGraph } from "./validation";

function node(id: string, type: string, config: Record<string, unknown> = {}, name = id): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], name, position: { x: 0, y: 0 }, config };
}

class ScriptedProvider implements LLMProviderAdapter {
  readonly definition = { id: "scripted", label: "Scripted", supportsTools: true, configSchema: {} };
  readonly requests: ProviderCallRequest[] = [];
  constructor(private readonly calls: Array<{ name: string; arguments: Record<string, unknown> }>) {}
  async generate(request: ProviderCallRequest) {
    this.requests.push(request);
    const done = request.messages.filter((message: ChatMessage) => message.role === "tool").length;
    const next = this.calls[done];
    if (next) return { content: "Calling.", toolCalls: [{ id: `call-${done + 1}`, ...next }] };
    return { content: "Done.", toolCalls: [] };
  }
}

const endpointOf = (config: MCPServerConfig) => String(config.registryServerId ?? (config.connection as { endpoint?: string } | undefined)?.endpoint);

function searchAdapter(invoked: string[]): MCPServerAdapter {
  return {
    definition: { id: "search-mcp", label: "Search", description: "", configSchema: {}, authSchema: {} },
    async discoverTools(config: MCPServerConfig) {
      return [{ serverId: "search-mcp", serverLabel: "Search", name: "search", description: `Search ${endpointOf(config)}`, inputSchema: { type: "object" } }];
    },
    async invokeTool(toolName: string, _args: unknown, config: MCPServerConfig) {
      invoked.push(`${endpointOf(config)}:${toolName}`);
      return { ok: true, output: { from: endpointOf(config) } };
    }
  } as unknown as MCPServerAdapter;
}

function agentWorkflow(toolNodes: WorkflowNode[]): Workflow {
  return {
    id: "wf-rename",
    name: "Rename",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      node("in", "webhook_input"),
      node("agent", "agent_orchestrator", { maxIterations: 5, toolCallingEnabled: true, userPromptTemplate: "{{user_prompt}}" }, "Agent"),
      node("model", "llm_call", { provider: { providerId: "scripted", model: "m" } }),
      ...toolNodes,
      node("out", "output")
    ],
    edges: [
      { id: "e1", source: "in", target: "agent" },
      { id: "e2", source: "agent", target: "out" },
      { id: "e3", source: "agent", sourceHandle: "chat_model", target: "model" },
      ...toolNodes.map((tool, index) => ({ id: `t${index}`, source: "agent", sourceHandle: "tool", target: tool.id }))
    ]
  };
}

function harness(calls: Array<{ name: string; arguments: Record<string, unknown> }>, rules: McpToolPolicyRule[] = []) {
  const provider = new ScriptedProvider(calls);
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(provider);
  const invoked: string[] = [];
  const mcpRegistry = new MCPRegistry();
  mcpRegistry.register(searchAdapter(invoked));
  const paused: WorkflowExecutionState[] = [];
  const dependencies: WorkflowExecutionDependencies = {
    providerRegistry,
    connectorRegistry: createDefaultConnectorRegistry(),
    mcpRegistry,
    agentRuntime: new DefaultAgentRuntime(),
    resolveSecret: async () => undefined,
    resolveRegisteredMcpServer: async (id: string) => ({ serverId: "search-mcp", registryServerId: id, label: `Server ${id}`, connection: {} }),
    persistPausedExecution: async (state) => {
      paused.push(state.state);
    },
    loadMcpToolPolicy: () => ({ rules, classifications: [] })
  };
  return { dependencies, provider, invoked, paused };
}

const approveBSearch = {
  id: "approve-b-search",
  name: "Approve B's search",
  enabled: true,
  effect: "require_approval",
  serverId: "srv_b",
  toolPattern: "search",
  roles: [],
  projectId: null,
  mode: "enforce",
  createdAt: "2026-11-04T00:00:00.000Z",
  updatedAt: "2026-11-04T00:00:00.000Z"
} as unknown as McpToolPolicyRule;

const nameFor = (registryServerId: string) => disambiguatedToolName("search-mcp", serverIdentityHash({ registryServerId }), "search");
const registeredNode = (id: string, registryServerId: string) => node(id, "mcp_tool", { serverId: "search-mcp", registryServerId, toolName: "__all__" }, `Node ${id}`);

describe("two MCP servers serving one tool name", () => {
  it("renames both registered servers' tools; each runs on its own server and a require_approval rule on B's search still fires", async () => {
    const h = harness([{ name: nameFor("srv_a"), arguments: {} }, { name: nameFor("srv_b"), arguments: {} }], [approveBSearch]);
    const result = await executeWorkflow({ workflow: agentWorkflow([registeredNode("a", "srv_a"), registeredNode("b", "srv_b")]), executionId: "exec-rename", webhookPayload: { user_prompt: "find" } }, h.dependencies);
    const offered = (h.provider.requests[0]?.tools ?? []).map((tool) => tool.name);
    expect(offered).toEqual(expect.arrayContaining([nameFor("srv_a"), nameFor("srv_b")]));
    expect(offered).not.toContain("search-mcp__search");
    expect(h.provider.requests[0]?.tools?.find((tool) => tool.name === nameFor("srv_b"))?.description).toBe("[search-mcp: Server srv_b] Search srv_b");
    // A's search ran; B's waits for an approval instead of running.
    expect(h.invoked).toEqual(["srv_a:search"]);
    expect(result.status).toBe("waiting_approval");
    expect(h.paused).toHaveLength(1);
  });

  it("renames two inline servers in all-tools mode, names the nodes in the description, and adds a third later without changing the first two", async () => {
    const inline = (id: string, endpoint: string) => node(id, "mcp_tool", { serverId: "search-mcp", toolName: "__all__", connection: { endpoint } }, `Node ${id}`);
    const nameOf = (endpoint: string) => disambiguatedToolName("search-mcp", serverIdentityHash({ connection: { endpoint } }), "search");
    const two = [inline("a", "https://one.example"), inline("b", "https://two.example")];
    expect(validateWorkflowGraph(agentWorkflow(two)).issues.map((issue) => issue.code)).not.toContain("duplicate_agent_tool_name");
    const h = harness([{ name: nameOf("https://two.example"), arguments: {} }]);
    const result = await executeWorkflow({ workflow: agentWorkflow(two), webhookPayload: { user_prompt: "find" } }, h.dependencies);
    expect(result.status).toBe("success");
    expect(h.invoked).toEqual(["https://two.example:search"]);
    const firstTools = (h.provider.requests[0]?.tools ?? []).map((tool) => `${tool.name} ${tool.description}`);
    expect(firstTools).toEqual(
      expect.arrayContaining([`${nameOf("https://one.example")} [search-mcp: Node a] Search https://one.example`, `${nameOf("https://two.example")} [search-mcp: Node b] Search https://two.example`])
    );

    const three = harness([]);
    await executeWorkflow({ workflow: agentWorkflow([...two, inline("c", "https://three.example")]), webhookPayload: { user_prompt: "find" } }, three.dependencies);
    expect((three.provider.requests[0]?.tools ?? []).map((tool) => tool.name)).toEqual(
      expect.arrayContaining([nameOf("https://one.example"), nameOf("https://two.example"), nameOf("https://three.example")])
    );

    // One server alone keeps the plain name.
    const alone = harness([]);
    await executeWorkflow({ workflow: agentWorkflow([two[0]!]), webhookPayload: { user_prompt: "find" } }, alone.dependencies);
    expect((alone.provider.requests[0]?.tools ?? []).map((tool) => tool.name)).toContain("search-mcp__search");
  });
});
