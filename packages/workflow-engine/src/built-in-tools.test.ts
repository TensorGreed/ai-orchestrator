/**
 * Phase 6.4 — built-in tools (the `l2m-tools` adapter) on an agent's tool port: calls go through the outbound URL
 * guard, results carry the untrusted_external label, and a taint rule asks for approval before a write that follows a
 * search.
 */
import { describe, expect, it } from "vitest";
import { DefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry, type MCPServerAdapter } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry, type LLMProviderAdapter, type ProviderCallRequest } from "@ai-orchestrator/provider-sdk";
import {
  BUILT_IN_TOOLS_ADAPTER_ID,
  mcpSafetyPresetRule,
  type ChatMessage,
  type McpToolPolicyRule,
  type Workflow,
  type WorkflowEdge,
  type WorkflowExecutionState,
  type WorkflowNode
} from "@ai-orchestrator/shared";
import { executeWorkflow, resumeWorkflowExecution, type WorkflowExecutionDependencies } from "./executor";
import { guardedFetch } from "./outbound-url-guard";

function node(id: string, type: string, config: Record<string, unknown> = {}, name = id): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], name, position: { x: 0, y: 0 }, config };
}

function workflow(id: string, nodes: WorkflowNode[], edges: Array<Omit<WorkflowEdge, "id">>): Workflow {
  return { id, name: `Workflow ${id}`, schemaVersion: "1.0.0", workflowVersion: 1, projectId: "default", nodes, edges: edges.map((edge, index) => ({ id: `e${index}`, ...edge })) };
}

/** Calls the scripted tools in order, one per turn, then answers. */
class ScriptedProvider implements LLMProviderAdapter {
  readonly definition = { id: "scripted", label: "Scripted", supportsTools: true, configSchema: {} };
  constructor(private readonly calls: Array<{ name: string; arguments: Record<string, unknown> }>) {}
  async generate(request: ProviderCallRequest) {
    const done = request.messages.filter((message: ChatMessage) => message.role === "tool").length;
    const next = this.calls[done];
    if (next) return { content: "Calling a tool.", toolCalls: [{ id: `call-${done + 1}`, ...next }] };
    return { content: "All done.", toolCalls: [] };
  }
}

function repoAdapter(invoked: string[]): MCPServerAdapter {
  return {
    definition: { id: "repo-mcp", label: "Repo", description: "Test repo server", configSchema: {}, authSchema: {} },
    async discoverTools() {
      return [{ serverId: "repo-mcp", serverLabel: "Repo", name: "push", description: "Push", inputSchema: { type: "object" } }];
    },
    async invokeTool(toolName: string) {
      invoked.push(toolName);
      return { ok: true, output: { pushed: true } };
    }
  } as unknown as MCPServerAdapter;
}

function deps(input: {
  calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  fetched: string[];
  denyPrivate?: boolean;
  invoked?: string[];
  rules?: McpToolPolicyRule[];
  paused?: WorkflowExecutionState[];
}): WorkflowExecutionDependencies {
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(new ScriptedProvider(input.calls));
  const mcpRegistry = createDefaultMCPRegistry({
    builtInTools: {
      fetch: (url, init) =>
        guardedFetch(url, init, {
          config: { denyPrivate: input.denyPrivate === true, allowlist: [] },
          resolver: async () => ["93.184.216.34"],
          fetchImpl: async (target) => {
            input.fetched.push(String(target));
            return new Response(JSON.stringify({ query: { search: [{ title: "Rust (programming language)", snippet: "A language" }] }, results: [{ title: "Hit", url: "https://x.example", content: "c" }] }), {
              status: 200,
              headers: { "content-type": "application/json" }
            });
          }
        })
    }
  });
  mcpRegistry.register(repoAdapter(input.invoked ?? []));
  return {
    providerRegistry,
    connectorRegistry: createDefaultConnectorRegistry(),
    mcpRegistry,
    agentRuntime: new DefaultAgentRuntime(),
    resolveSecret: async () => undefined,
    persistPausedExecution: async (paused) => {
      input.paused?.push(paused.state);
    },
    ...(input.rules ? { loadMcpToolPolicy: () => ({ rules: input.rules!, classifications: [] }) } : {})
  };
}

function agentWorkflow(toolConnection: Record<string, unknown>, withRepo = false, agentConfig: Record<string, unknown> = {}): Workflow {
  return workflow(
    "wf-built-in",
    [
      node("in", "webhook_input"),
      node("agent", "agent_orchestrator", { maxIterations: 5, toolCallingEnabled: true, userPromptTemplate: "{{user_prompt}}", ...agentConfig }),
      node("model", "llm_call", { provider: { providerId: "scripted", model: "m" } }),
      node("search", "mcp_tool", { serverId: BUILT_IN_TOOLS_ADAPTER_ID, toolName: "__all__", connection: toolConnection }),
      ...(withRepo ? [node("repo", "mcp_tool", { serverId: "repo-mcp", toolName: "push" })] : []),
      node("out", "output")
    ],
    [
      { source: "in", target: "agent" },
      { source: "agent", target: "out" },
      { source: "agent", sourceHandle: "chat_model", target: "model" },
      { source: "agent", sourceHandle: "tool", target: "search" },
      ...(withRepo ? [{ source: "agent", sourceHandle: "tool", target: "repo" }] : [])
    ]
  );
}

type AgentOutput = { steps?: Array<{ toolResults: Array<{ toolName: string; output: unknown; error?: string; thought?: string }> }>; _mcpTools?: Record<string, unknown> };
const agentOutput = (result: Awaited<ReturnType<typeof executeWorkflow>>) =>
  result.nodeResults.filter((entry) => entry.nodeId === "agent").at(-1)?.output as AgentOutput | undefined;

describe("built-in tools on an agent", () => {
  it("searches Wikipedia through the outbound guard and attributes the call to the built-in adapter", async () => {
    const fetched: string[] = [];
    const result = await executeWorkflow(
      { workflow: agentWorkflow({ provider: "wikipedia" }), webhookPayload: { user_prompt: "What is Rust?" } },
      deps({ calls: [{ name: "l2m-tools__wikipedia_search", arguments: { query: "rust" } }], fetched })
    );
    expect(result.status).toBe("success");
    expect(fetched).toHaveLength(1);
    expect(new URL(fetched[0]!).host).toBe("en.wikipedia.org");
    const output = agentOutput(result);
    expect(output?.steps?.[0]?.toolResults[0]).toMatchObject({ toolName: "l2m-tools__wikipedia_search", output: { results: [{ title: "Rust (programming language)" }] } });
    expect(output?._mcpTools?.["l2m-tools__wikipedia_search"]).toEqual({ adapterId: BUILT_IN_TOOLS_ADAPTER_ID, toolName: "wikipedia_search" });
  });

  it("refuses a SearXNG instance on a private host when private destinations are denied", async () => {
    const fetched: string[] = [];
    const run = (denyPrivate: boolean) =>
      executeWorkflow(
        { workflow: agentWorkflow({ provider: "searxng", endpoint: "http://10.1.2.3:8080" }), webhookPayload: { user_prompt: "Search" } },
        deps({ calls: [{ name: "l2m-tools__searxng_search", arguments: { query: "l2m" } }], fetched, denyPrivate })
      );
    const denied = await run(true);
    expect(denied.status).toBe("success");
    expect(fetched).toEqual([]);
    expect(agentOutput(denied)?.steps?.[0]?.toolResults[0]?.error).toMatch(/SearXNG web search: .*(private|blocked|not allowed)/i);

    const allowed = await run(false);
    expect(allowed.status).toBe("success");
    expect(fetched.map((url) => new URL(url).host)).toEqual(["10.1.2.3:8080"]);
  });

  it("labels search results untrusted, so a write tool that follows a search needs approval", async () => {
    const fetched: string[] = [];
    const invoked: string[] = [];
    const paused: WorkflowExecutionState[] = [];
    const rule = { ...mcpSafetyPresetRule("untrusted_write_approval"), mode: "enforce" } as McpToolPolicyRule;
    const calls = [
      { name: "l2m-tools__wikipedia_search", arguments: { query: "release notes" } },
      { name: "repo-mcp__push", arguments: { repo: "acme/app" } }
    ];
    const first = await executeWorkflow(
      { workflow: agentWorkflow({ provider: "wikipedia" }, true), executionId: "exec-search-write", webhookPayload: { user_prompt: "Push the notes" } },
      deps({ calls, fetched, invoked, rules: [rule], paused })
    );
    expect(first.status).toBe("waiting_approval");
    // The search ran (it is read-only, so the rule does not ask for it); the write waits.
    expect(fetched).toHaveLength(1);
    expect(invoked).toEqual([]);
    expect(first.output).toMatchObject({ approvalMessage: expect.stringContaining("Untrusted content: write tools need approval") });

    const resumed = await resumeWorkflowExecution(
      { executionId: "exec-search-write", state: paused[0]!, decision: "approve" },
      deps({ calls, fetched, invoked, rules: [rule] })
    );
    expect(resumed.status).toBe("success");
    expect(invoked).toEqual(["push"]);
  });

  it("lets the same write through when no search came first", async () => {
    const invoked: string[] = [];
    const rule = { ...mcpSafetyPresetRule("untrusted_write_approval"), mode: "enforce" } as McpToolPolicyRule;
    const result = await executeWorkflow(
      { workflow: agentWorkflow({ provider: "wikipedia" }, true), webhookPayload: { user_prompt: "Push" }, inputLabels: { provenance: ["user"], dataClasses: [], source: "propagated" } },
      deps({ calls: [{ name: "repo-mcp__push", arguments: { repo: "acme/app" } }], fetched: [], invoked, rules: [rule] })
    );
    expect(result.status).toBe("success");
    expect(invoked).toEqual(["push"]);
  });

  it("traces the agent's Think calls as thoughts beside the tool calls, never as an MCP tool", async () => {
    const fetched: string[] = [];
    const activity: Array<{ nodeId: string; kind: string; text?: string }> = [];
    const dependencies = deps({
      calls: [
        { name: "think", arguments: { thought: "Search first, then answer." } },
        { name: "l2m-tools__wikipedia_search", arguments: { query: "rust" } }
      ],
      fetched
    });
    const result = await executeWorkflow(
      { workflow: agentWorkflow({ provider: "wikipedia" }, false, { thinkTool: true }), webhookPayload: { user_prompt: "What is Rust?" } },
      {
        ...dependencies,
        onNodeActivity: (event) => {
          activity.push(event as unknown as { nodeId: string; kind: string; text?: string });
        }
      }
    );
    expect(result.status).toBe("success");
    const output = agentOutput(result);
    expect(output?.steps?.[0]?.toolResults[0]).toMatchObject({ toolName: "think", thought: "Search first, then answer." });
    expect(output?.steps?.[1]?.toolResults[0]).toMatchObject({ toolName: "l2m-tools__wikipedia_search" });
    expect(Object.keys(output?._mcpTools ?? {})).not.toContain("think");
    expect(activity.filter((entry) => entry.kind === "thought")).toEqual([expect.objectContaining({ nodeId: "agent", text: "Search first, then answer." })]);
    expect(fetched).toHaveLength(1);
  });
});
