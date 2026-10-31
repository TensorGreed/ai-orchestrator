/**
 * Phase 12.2 — provenance policies in the engine: the "untrusted content ⇒ write tools need approval" rule, open-world
 * resolution from the server's destination tier and an admin override, automatic label tracking for rules with a
 * `sensitive` or data class condition, and the labels recorded with every call's decision.
 */
import { describe, expect, it } from "vitest";
import { DefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry, type MCPServerAdapter } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry, type LLMProviderAdapter, type ProviderCallRequest } from "@ai-orchestrator/provider-sdk";
import {
  mcpSafetyPresetRule,
  untrustedWriteSwitchRule,
  type ChatMessage,
  type DataDestinationRow,
  type DataLabels,
  type McpToolOpenWorldOverride,
  type McpToolPolicyRule,
  type McpToolPolicyTrace,
  type Workflow,
  type WorkflowEdge,
  type WorkflowExecutionState,
  type WorkflowNode
} from "@ai-orchestrator/shared";
import { executeWorkflow, resumeWorkflowExecution, type WorkflowExecutionDependencies } from "./executor";

function node(id: string, type: string, config: Record<string, unknown> = {}, name = id): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], name, position: { x: 0, y: 0 }, config };
}

function workflow(id: string, nodes: WorkflowNode[], edges: Array<Omit<WorkflowEdge, "id">>): Workflow {
  return { id, name: `Workflow ${id}`, schemaVersion: "1.0.0", workflowVersion: 1, projectId: "default", nodes, edges: edges.map((edge, index) => ({ id: `e${index}`, ...edge })) };
}

class ToolThenAnswerProvider implements LLMProviderAdapter {
  readonly definition = { id: "scripted", label: "Scripted", supportsTools: true, configSchema: {} };
  constructor(private readonly toolName: string) {}
  async generate(request: ProviderCallRequest) {
    const sawTool = request.messages.some((message: ChatMessage) => message.role === "tool");
    if (!sawTool && request.tools?.some((tool) => tool.name === this.toolName)) {
      return { content: "Calling a tool.", toolCalls: [{ id: "call-1", name: this.toolName, arguments: { repo: "acme/app" } }] };
    }
    return { content: "All done.", toolCalls: [] };
  }
}

/** A write tool (no read-only annotation) and, optionally, an explicit openWorldHint. */
function repoAdapter(invoked: string[], annotations?: Record<string, unknown>): MCPServerAdapter {
  return {
    definition: { id: "repo-mcp", label: "Repo", description: "Test repo server", configSchema: {}, authSchema: {} },
    async discoverTools() {
      return [{ serverId: "repo-mcp", serverLabel: "Repo", name: "push", description: "Push", inputSchema: { type: "object" }, ...(annotations ? { annotations } : {}) }];
    },
    async invokeTool(toolName: string) {
      invoked.push(toolName);
      return { ok: true, output: { pushed: true } };
    }
  } as unknown as MCPServerAdapter;
}

function deps(input: {
  rules: McpToolPolicyRule[];
  invoked?: string[];
  annotations?: Record<string, unknown>;
  destinations?: DataDestinationRow[];
  openWorldOverrides?: McpToolOpenWorldOverride[];
  paused?: WorkflowExecutionState[];
}): WorkflowExecutionDependencies {
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(new ToolThenAnswerProvider("repo-mcp__push"));
  const mcpRegistry = createDefaultMCPRegistry();
  mcpRegistry.register(repoAdapter(input.invoked ?? [], input.annotations));
  return {
    providerRegistry,
    connectorRegistry: createDefaultConnectorRegistry(),
    mcpRegistry,
    agentRuntime: new DefaultAgentRuntime(),
    resolveSecret: async () => undefined,
    persistPausedExecution: async (paused) => {
      input.paused?.push(paused.state);
    },
    loadMcpToolPolicy: () => ({
      rules: input.rules,
      classifications: [],
      ...(input.openWorldOverrides ? { openWorldOverrides: input.openWorldOverrides } : {}),
      ...(input.destinations ? { destinations: input.destinations } : {})
    })
  };
}

function agentWorkflow(connection?: Record<string, unknown>, id = "wf-taint"): Workflow {
  return workflow(
    id,
    [
      node("in", "webhook_input"),
      node("agent", "agent_orchestrator", { maxIterations: 4, toolCallingEnabled: true, userPromptTemplate: "{{user_prompt}}" }),
      node("model", "llm_call", { provider: { providerId: "scripted", model: "m" } }),
      node("tool", "mcp_tool", { serverId: "repo-mcp", toolName: "push", ...(connection ? { connection } : {}) }),
      node("out", "output")
    ],
    [
      { source: "in", target: "agent" },
      { source: "agent", target: "out" },
      { source: "agent", sourceHandle: "chat_model", target: "model" },
      { source: "agent", sourceHandle: "tool", target: "tool" }
    ]
  );
}

const labels = (provenance: DataLabels["provenance"]): DataLabels => ({ provenance, dataClasses: [], source: "propagated" });

const agentOutput = (result: Awaited<ReturnType<typeof executeWorkflow>>) =>
  result.nodeResults.filter((entry) => entry.nodeId === "agent").at(-1)?.output as { _toolPolicy?: McpToolPolicyTrace } | undefined;

const enforced = (rule: McpToolPolicyRule): McpToolPolicyRule => ({ ...rule, mode: "enforce" });

describe("untrusted content ⇒ write tools need approval", () => {
  const rule = enforced(mcpSafetyPresetRule("untrusted_write_approval"));

  it("pauses a write call after untrusted content and records the labels it was decided with", async () => {
    const invoked: string[] = [];
    const paused: WorkflowExecutionState[] = [];
    const first = await executeWorkflow(
      { workflow: agentWorkflow(), executionId: "exec-taint", webhookPayload: { user_prompt: "Push" }, inputLabels: labels(["untrusted_external"]) },
      deps({ rules: [rule], invoked, paused })
    );
    expect(first.status).toBe("waiting_approval");
    expect(invoked).toEqual([]);
    expect(first.output).toMatchObject({ approvalMessage: expect.stringContaining("Untrusted content: write tools need approval") });
    const approved = await resumeWorkflowExecution({ executionId: "exec-taint", state: paused[0]!, decision: "approve" }, deps({ rules: [rule], invoked }));
    expect(approved.status).toBe("success");
    expect(invoked).toEqual(["push"]);
    const trace = agentOutput(approved)?._toolPolicy;
    expect(trace?.decisions?.[0]).toMatchObject({
      effect: "require_approval",
      ruleId: rule.id,
      approval: "approved",
      labels: { provenance: ["untrusted_external"], tracked: false }
    });
    // Untracked runs record no data class names at all.
    expect(trace?.decisions?.[0]?.labels).not.toHaveProperty("dataClasses");
  });

  it("lets the same call through when the content came from a user", async () => {
    const invoked: string[] = [];
    const result = await executeWorkflow(
      { workflow: agentWorkflow(), webhookPayload: { user_prompt: "Push" }, inputLabels: labels(["user"]) },
      deps({ rules: [rule], invoked })
    );
    expect(result.status).toBe("success");
    expect(invoked).toEqual(["push"]);
    // No rule matched, so no decision; the labels are still recorded for the call's telemetry row.
    const trace = agentOutput(result)?._toolPolicy;
    expect(trace?.decisions).toBeUndefined();
    expect(trace?.callLabels).toEqual([{ tool: "push", server: "repo-mcp", toolCallId: "call-1", labels: { provenance: ["user"], tracked: false } }]);
  });

  it("scopes the workflow switch's rule to its own workflow", async () => {
    const switchRule = untrustedWriteSwitchRule("wf-other");
    const invoked: string[] = [];
    const result = await executeWorkflow(
      { workflow: agentWorkflow(), webhookPayload: { user_prompt: "Push" }, inputLabels: labels(["untrusted_external"]) },
      deps({ rules: [switchRule], invoked })
    );
    expect(result.status).toBe("success");
    expect(invoked).toEqual(["push"]);
    const own = await executeWorkflow(
      { workflow: agentWorkflow(undefined, "wf-other"), webhookPayload: { user_prompt: "Push" }, inputLabels: labels(["untrusted_external"]) },
      deps({ rules: [switchRule] })
    );
    expect(own.status).toBe("waiting_approval");
  });

  it("changes nothing while the preset is in shadow", async () => {
    const invoked: string[] = [];
    const result = await executeWorkflow(
      { workflow: agentWorkflow(), webhookPayload: { user_prompt: "Push" }, inputLabels: labels(["untrusted_external"]) },
      deps({ rules: [mcpSafetyPresetRule("untrusted_write_approval")], invoked })
    );
    expect(result.status).toBe("success");
    expect(invoked).toEqual(["push"]);
    expect(agentOutput(result)?._toolPolicy?.decisions?.[0]).toMatchObject({ effect: "allow", shadow: { effect: "require_approval", changed: true } });
  });
});

describe("open world: the server's destination tier, with the hint as fallback", () => {
  const noOpenWorld: McpToolPolicyRule = { ...enforced(mcpSafetyPresetRule("sensitive_no_open_world")), conditions: null, id: "no-open-world" };
  const run = (input: Parameters<typeof deps>[0] & { connection?: Record<string, unknown> }) => {
    const invoked: string[] = [];
    return executeWorkflow({ workflow: agentWorkflow(input.connection), webhookPayload: { user_prompt: "Push" } }, deps({ ...input, invoked })).then(() => invoked);
  };

  it("treats a server on an unclassified host as open world, whatever the tool's hint says", async () => {
    expect(await run({ rules: [noOpenWorld], connection: { endpoint: "https://tools.example.com/mcp" }, annotations: { openWorldHint: false } })).toEqual([]);
    // With no endpoint at all the destination is unknown: open world.
    expect(await run({ rules: [noOpenWorld], annotations: { openWorldHint: false } })).toEqual([]);
  });

  it("lets the tool's hint decide on a local or private server", async () => {
    const local = { endpoint: "http://127.0.0.1:9000/mcp" };
    expect(await run({ rules: [noOpenWorld], connection: local, annotations: { openWorldHint: false } })).toEqual(["push"]);
    // A missing hint is open world (the MCP default): a local server can still reach out.
    expect(await run({ rules: [noOpenWorld], connection: local })).toEqual([]);
  });

  it("reads the admin's destination rows", async () => {
    const row: DataDestinationRow = {
      id: "dd-1",
      name: "Corp tools",
      kind: "mcp_server",
      targetId: null,
      host: "tools.corp.example",
      tier: "private",
      region: "eu",
      holdsDataClasses: [],
      note: null,
      builtIn: false,
      createdAt: null,
      updatedAt: null,
      createdBy: null,
      updatedBy: null
    };
    const connection = { endpoint: "https://tools.corp.example/mcp" };
    expect(await run({ rules: [noOpenWorld], connection, annotations: { openWorldHint: false }, destinations: [row] })).toEqual(["push"]);
    expect(await run({ rules: [noOpenWorld], connection, annotations: { openWorldHint: false } })).toEqual([]);
  });
});

describe("open world of two inline servers on one adapter", () => {
  /** Lists `read_a` at the internal endpoint and `post_note` anywhere else; both declare openWorldHint:false. */
  function byEndpointAdapter(invoked: string[]): MCPServerAdapter {
    return {
      definition: { id: "notes-mcp", label: "Notes", description: "Test notes server", configSchema: {}, authSchema: {} },
      async discoverTools(config: { connection?: Record<string, unknown> }) {
        const internal = String(config.connection?.endpoint ?? "").includes("127.0.0.1");
        return [
          {
            serverId: "notes-mcp",
            serverLabel: "Notes",
            name: internal ? "read_a" : "post_note",
            description: "Notes",
            inputSchema: { type: "object" },
            annotations: { openWorldHint: false }
          }
        ];
      },
      async invokeTool(_config: unknown, toolName: string) {
        invoked.push(toolName);
        return { ok: true, output: { done: true } };
      }
    } as unknown as MCPServerAdapter;
  }

  it("resolves each tool with its own server's connection", async () => {
    const invoked: string[] = [];
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(new ToolThenAnswerProvider("notes-mcp__post_note"));
    const mcpRegistry = createDefaultMCPRegistry();
    mcpRegistry.register(byEndpointAdapter(invoked));
    const approveOpenWorld: McpToolPolicyRule = {
      id: "approve-open-world",
      name: "Open-world tools need approval",
      description: null,
      effect: "require_approval",
      projectId: null,
      roles: [],
      serverId: null,
      toolPattern: "*",
      annotationHint: "open_world",
      enabled: true
    };
    const wf = workflow(
      "wf-two-inline",
      [
        node("in", "webhook_input"),
        node("agent", "agent_orchestrator", { maxIterations: 4, toolCallingEnabled: true, userPromptTemplate: "{{user_prompt}}" }),
        node("model", "llm_call", { provider: { providerId: "scripted", model: "m" } }),
        // A: internal (local), listed first. B: a public host no row classifies.
        node("toolA", "mcp_tool", { serverId: "notes-mcp", toolName: "read_a", connection: { endpoint: "http://127.0.0.1:9000/mcp" } }),
        node("toolB", "mcp_tool", { serverId: "notes-mcp", toolName: "post_note", connection: { endpoint: "https://notes.example.com/mcp" } }),
        node("out", "output")
      ],
      [
        { source: "in", target: "agent" },
        { source: "agent", target: "out" },
        { source: "agent", sourceHandle: "chat_model", target: "model" },
        { source: "agent", sourceHandle: "tool", target: "toolA" },
        { source: "agent", sourceHandle: "tool", target: "toolB" }
      ]
    );
    const result = await executeWorkflow(
      { workflow: wf, webhookPayload: { user_prompt: "Post a note" } },
      {
        providerRegistry,
        connectorRegistry: createDefaultConnectorRegistry(),
        mcpRegistry,
        agentRuntime: new DefaultAgentRuntime(),
        resolveSecret: async () => undefined,
        persistPausedExecution: async () => undefined,
        loadMcpToolPolicy: () => ({ rules: [approveOpenWorld], classifications: [] })
      }
    );
    // B's public host makes post_note open world, so it waits for approval (A's local host would not have).
    expect(result.status).toBe("waiting_approval");
    expect(invoked).toEqual([]);
  });
});

describe("automatic label tracking", () => {
  it("tracks labels when a rule has a data class condition, and records the classes found", async () => {
    const watch: McpToolPolicyRule = {
      id: "watch-email",
      name: null,
      description: null,
      effect: "deny",
      projectId: null,
      roles: [],
      serverId: null,
      toolPattern: "*",
      enabled: true,
      mode: "shadow",
      conditions: { all: [{ op: "label_present", value: "email" }] }
    };
    const result = await executeWorkflow(
      { workflow: agentWorkflow(), webhookPayload: { user_prompt: "Push for alice@example.com" }, inputLabels: labels(["user"]) },
      deps({ rules: [watch] })
    );
    expect(result.status).toBe("success");
    const decision = agentOutput(result)?._toolPolicy?.decisions?.[0];
    expect(decision?.labels).toMatchObject({ tracked: true, provenance: ["user"] });
    expect(decision?.labels?.dataClasses).toContain("email");
    expect(decision).toMatchObject({ shadow: { effect: "deny", changed: true } });
    // The recorded labels hold class names, never the address.
    expect(JSON.stringify(agentOutput(result)?._toolPolicy)).not.toContain("alice@example.com");
  });

  it("does not track labels for a rule scoped to other workflows", async () => {
    const elsewhere: McpToolPolicyRule = {
      id: "watch-email-elsewhere",
      name: null,
      description: null,
      effect: "deny",
      projectId: null,
      roles: [],
      serverId: null,
      toolPattern: "*",
      enabled: true,
      mode: "shadow",
      workflowIds: ["wf-other"],
      conditions: { all: [{ op: "label_present", value: "email" }] }
    };
    const result = await executeWorkflow(
      { workflow: agentWorkflow(), webhookPayload: { user_prompt: "Push for alice@example.com" }, inputLabels: labels(["user"]) },
      deps({ rules: [elsewhere] })
    );
    expect(agentOutput(result)?._toolPolicy?.callLabels?.[0]?.labels).toEqual({ provenance: ["user"], tracked: false });
  });

  it("does not track labels for provenance-only rules", async () => {
    const result = await executeWorkflow(
      { workflow: agentWorkflow(), webhookPayload: { user_prompt: "Push for alice@example.com" }, inputLabels: labels(["user"]) },
      deps({ rules: [mcpSafetyPresetRule("untrusted_write_approval")] })
    );
    expect(agentOutput(result)?._toolPolicy?.callLabels?.[0]?.labels).toEqual({ provenance: ["user"], tracked: false });
  });
});
