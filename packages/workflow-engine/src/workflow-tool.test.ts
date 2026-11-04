/**
 * Phase 6.4 — Workflow Tool: an agent calls another workflow as a tool. The child runs in this process through the
 * l2m-workflow adapter, governed under the policy key `workflow:<id>`: schema derivation, depth and cycle limits,
 * project scope, labels in and out, tool rules, the write gate, a child that stops for approval, replay from the
 * cassette, and the child's model spend in the agent's usage.
 */
import { describe, expect, it } from "vitest";
import { DefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { McpCassetteRecorder, createDefaultMCPRegistry, createRecordingRegistry, createReplayRegistry, type MCPRegistry, type MCPServerAdapter } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry, type LLMProviderAdapter, type ProviderCallRequest } from "@ai-orchestrator/provider-sdk";
import {
  mcpSafetyPresetRule,
  type ChatMessage,
  type DataLabels,
  type McpToolPolicyRule,
  type Workflow,
  type WorkflowEdge,
  type WorkflowExecutionState,
  type WorkflowNode
} from "@ai-orchestrator/shared";
import { executeWorkflow, resumeWorkflowExecution, type WorkflowExecutionDependencies } from "./executor";
import { validateWorkflowGraph } from "./validation";

function node(id: string, type: string, config: Record<string, unknown> = {}, name = id): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], name, position: { x: 0, y: 0 }, config };
}

function workflow(id: string, nodes: WorkflowNode[], edges: Array<Omit<WorkflowEdge, "id">>, extra: Partial<Workflow> = {}): Workflow {
  return {
    id,
    name: `Workflow ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes,
    edges: edges.map((edge, index) => ({ id: `e${index}`, ...edge })),
    ...extra
  };
}

/** The parent agent's model: calls the scripted tools in order, one per turn, then answers. */
class ScriptedProvider implements LLMProviderAdapter {
  readonly definition = { id: "scripted", label: "Scripted", supportsTools: true, configSchema: {} };
  readonly requests: ProviderCallRequest[] = [];
  constructor(private readonly calls: Array<{ name: string; arguments: Record<string, unknown> }>) {}
  async generate(request: ProviderCallRequest) {
    this.requests.push(request);
    const done = request.messages.filter((message: ChatMessage) => message.role === "tool").length;
    const next = this.calls[done];
    if (next) return { content: "Calling a tool.", toolCalls: [{ id: `call-${done + 1}`, ...next }], usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } };
    return { content: "All done.", toolCalls: [], usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } };
  }
}

/** The child's model: answers once with usage. */
class ChildModel implements LLMProviderAdapter {
  readonly definition = { id: "child-model", label: "Child", supportsTools: false, configSchema: {} };
  calls = 0;
  async generate(request: ProviderCallRequest) {
    this.calls += 1;
    const prompt = request.messages.find((message: ChatMessage) => message.role === "user")?.content ?? "";
    return { content: `Order status for ${prompt}: shipped`, toolCalls: [], usage: { inputTokens: 700, outputTokens: 300, totalTokens: 1000 } };
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

const LOOKUP_SCHEMA = { type: "object", properties: { order_id: { type: "string", description: "The order number." } }, required: ["order_id"] };

/** A child that answers with a model call: Sub-Workflow Trigger → LLM → Output. */
function lookupChild(id = "wf-lookup", extraNodes: WorkflowNode[] = [], extraEdges: Array<Omit<WorkflowEdge, "id">> = []): Workflow {
  return workflow(
    id,
    [
      node("start", "sub_workflow_trigger", { description: "Look up an order's status by its number.", inputSchema: LOOKUP_SCHEMA }),
      node("llm", "llm_call", { provider: { providerId: "child-model", model: "c" }, promptKey: "order_id" }),
      node("out", "output"),
      ...extraNodes
    ],
    [{ source: "start", target: "llm" }, { source: "llm", target: "out" }, ...extraEdges],
    { name: "Order lookup" }
  );
}

function parentWorkflow(toolConfig: Record<string, unknown>, options: { withRepo?: boolean; settings?: Workflow["settings"]; id?: string } = {}): Workflow {
  return workflow(
    options.id ?? "wf-parent",
    [
      node("in", "webhook_input"),
      node("agent", "agent_orchestrator", { maxIterations: 5, toolCallingEnabled: true, userPromptTemplate: "{{user_prompt}}" }),
      node("model", "llm_call", { provider: { providerId: "scripted", model: "m" } }),
      node("wtool", "workflow_tool", toolConfig, "Order lookup tool"),
      ...(options.withRepo ? [node("repo", "mcp_tool", { serverId: "repo-mcp", toolName: "push" })] : []),
      node("out", "output")
    ],
    [
      { source: "in", target: "agent" },
      { source: "agent", target: "out" },
      { source: "agent", sourceHandle: "chat_model", target: "model" },
      { source: "agent", sourceHandle: "tool", target: "wtool" },
      ...(options.withRepo ? [{ source: "agent", sourceHandle: "tool", target: "repo" }] : [])
    ],
    options.settings ? { settings: options.settings } : {}
  );
}

interface Harness {
  dependencies: WorkflowExecutionDependencies;
  provider: ScriptedProvider;
  child: ChildModel;
  loaded: string[];
  invoked: string[];
  paused: WorkflowExecutionState[];
}

function harness(input: {
  calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  workflows: Workflow[];
  rules?: McpToolPolicyRule[];
  mcpRegistry?: MCPRegistry;
  loadWorkflow?: WorkflowExecutionDependencies["loadWorkflow"] | null;
}): Harness {
  const provider = new ScriptedProvider(input.calls);
  const child = new ChildModel();
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(provider);
  providerRegistry.register(child);
  const invoked: string[] = [];
  const mcpRegistry = input.mcpRegistry ?? createDefaultMCPRegistry();
  if (!mcpRegistry.tryGet("repo-mcp")) mcpRegistry.register(repoAdapter(invoked));
  const loaded: string[] = [];
  const paused: WorkflowExecutionState[] = [];
  const byId = new Map(input.workflows.map((entry) => [entry.id, entry]));
  const loadWorkflow =
    input.loadWorkflow === null
      ? undefined
      : input.loadWorkflow ??
        (async (id: string) => {
          loaded.push(id);
          return byId.get(id);
        });
  return {
    provider,
    child,
    loaded,
    invoked,
    paused,
    dependencies: {
      providerRegistry,
      connectorRegistry: createDefaultConnectorRegistry(),
      mcpRegistry,
      agentRuntime: new DefaultAgentRuntime(),
      resolveSecret: async () => undefined,
      ...(loadWorkflow ? { loadWorkflow } : {}),
      persistPausedExecution: async (state) => {
        paused.push(state.state);
      },
      ...(input.rules ? { loadMcpToolPolicy: () => ({ rules: input.rules!, classifications: [] }) } : {})
    }
  };
}

type ToolResult = { toolName: string; output: unknown; error?: string };
type AgentOutput = {
  steps?: Array<{ toolResults: ToolResult[] }>;
  _mcpTools?: Record<string, { adapterId: string; toolName: string; registryServerId?: string }>;
  _childTelemetry?: Array<{ providerId?: string; model?: string; usage?: { totalTokens?: number } }>;
  _toolPolicy?: { hidden?: Array<{ tool: string; server: string }> };
};
const agentOutput = (result: Awaited<ReturnType<typeof executeWorkflow>>) =>
  result.nodeResults.filter((entry) => entry.nodeId === "agent").at(-1)?.output as AgentOutput | undefined;
const toolResults = (result: Awaited<ReturnType<typeof executeWorkflow>>) => (agentOutput(result)?.steps ?? []).flatMap((step) => step.toolResults);

const callLookup = { name: "l2m-workflow__order_lookup", arguments: { order_id: "A-17" } };

describe("Workflow Tool", () => {
  it("offers the child as a tool with the schema and description of its entry trigger, and returns its output", async () => {
    const h = harness({ calls: [callLookup], workflows: [lookupChild()] });
    const result = await executeWorkflow({ workflow: parentWorkflow({ workflowId: "wf-lookup" }), webhookPayload: { user_prompt: "Where is A-17?" } }, h.dependencies);
    expect(result.status).toBe("success");
    const offered = h.provider.requests[0]!.tools?.find((tool) => tool.name === "l2m-workflow__order_lookup");
    expect(offered).toMatchObject({ description: expect.stringContaining("Look up an order's status by its number."), inputSchema: LOOKUP_SCHEMA });
    expect(toolResults(result)[0]).toMatchObject({ toolName: "l2m-workflow__order_lookup" });
    expect(JSON.stringify(toolResults(result)[0]!.output)).toContain("Order status for A-17: shipped");
    expect(agentOutput(result)?._mcpTools?.["l2m-workflow__order_lookup"]).toEqual({ adapterId: "l2m-workflow", toolName: "order_lookup", registryServerId: "workflow:wf-lookup" });
  });

  it("counts the child's model spend in the agent's usage", async () => {
    const h = harness({ calls: [callLookup], workflows: [lookupChild()] });
    const result = await executeWorkflow({ workflow: parentWorkflow({ workflowId: "wf-lookup" }), webhookPayload: { user_prompt: "Where is A-17?" } }, h.dependencies);
    expect(h.child.calls).toBe(1);
    expect(agentOutput(result)?._childTelemetry).toEqual([expect.objectContaining({ providerId: "child-model", model: "c", usage: expect.objectContaining({ totalTokens: 1000 }) })]);
  });

  it("takes the node's own name and description over the derived ones, and the Expose as MCP Tool trigger over the Sub-Workflow Trigger", async () => {
    const exposed = workflow(
      "wf-exposed",
      [node("mcp", "mcp_server_trigger", { path: "x", toolName: "Find Order", toolDescription: "Finds an order.", inputSchema: LOOKUP_SCHEMA }), node("out", "output")],
      [{ source: "mcp", target: "out" }]
    );
    const h = harness({ calls: [], workflows: [exposed] });
    await executeWorkflow({ workflow: parentWorkflow({ workflowId: "wf-exposed" }), webhookPayload: { user_prompt: "hi" } }, h.dependencies);
    expect(h.provider.requests[0]!.tools?.map((tool) => tool.name)).toContain("l2m-workflow__find_order");

    const renamed = harness({ calls: [], workflows: [exposed] });
    await executeWorkflow(
      { workflow: parentWorkflow({ workflowId: "wf-exposed", toolName: "orders", toolDescription: "Order facts." }), webhookPayload: { user_prompt: "hi" } },
      renamed.dependencies
    );
    expect(renamed.provider.requests[0]!.tools?.find((tool) => tool.name === "l2m-workflow__orders")?.description).toContain("Order facts.");
  });

  it("falls back to one free-text input that reaches a child's {{user_prompt}}", async () => {
    const plain = workflow(
      "wf-plain",
      [node("start", "manual_trigger"), node("llm", "llm_call", { provider: { providerId: "child-model", model: "c" } }), node("out", "output")],
      [{ source: "start", target: "llm" }, { source: "llm", target: "out" }],
      { name: "Plain helper" }
    );
    const h = harness({ calls: [{ name: "l2m-workflow__plain_helper", arguments: { input: "B-2" } }], workflows: [plain] });
    const result = await executeWorkflow({ workflow: parentWorkflow({ workflowId: "wf-plain" }), webhookPayload: { user_prompt: "hi" } }, h.dependencies);
    expect(h.provider.requests[0]!.tools?.find((tool) => tool.name === "l2m-workflow__plain_helper")?.inputSchema).toMatchObject({ required: ["input"] });
    expect(JSON.stringify(toolResults(result)[0]!.output)).toContain("Order status for B-2");
  });

  it("refuses a child already on the call stack, and one past the depth limit, as tool errors", async () => {
    const cycle = harness({ calls: [callLookup], workflows: [lookupChild()] });
    const looped = await executeWorkflow(
      { workflow: parentWorkflow({ workflowId: "wf-lookup" }), webhookPayload: { user_prompt: "x" }, callStack: ["wf-lookup"] },
      cycle.dependencies
    );
    expect(looped.status).toBe("success");
    expect(toolResults(looped)[0]!.error).toMatch(/Circular sub-workflow reference detected: wf-lookup -> wf-parent -> wf-lookup/);
    expect(cycle.child.calls).toBe(0);

    const deep = harness({ calls: [callLookup], workflows: [lookupChild()] });
    const tooDeep = await executeWorkflow(
      { workflow: parentWorkflow({ workflowId: "wf-lookup" }), webhookPayload: { user_prompt: "x" }, callStack: Array.from({ length: 9 }, (_, index) => `wf-${index}`) },
      deep.dependencies
    );
    expect(toolResults(tooDeep)[0]!.error).toMatch(/Maximum sub-workflow depth of 10 exceeded/);
    expect(deep.child.calls).toBe(0);
  });

  it("fails the agent with the loader's message when the child is outside the run's project scope", async () => {
    const h = harness({
      calls: [callLookup],
      workflows: [],
      loadWorkflow: async () => {
        throw new Error("Sub-workflow 'wf-lookup' belongs to a project this workflow cannot run.");
      }
    });
    const result = await executeWorkflow({ workflow: parentWorkflow({ workflowId: "wf-lookup" }), webhookPayload: { user_prompt: "x" } }, h.dependencies);
    expect(result.status).toBe("error");
    expect(result.error).toContain("Workflow Tool 'Order lookup tool': Sub-workflow 'wf-lookup' belongs to a project this workflow cannot run.");
  });

  it("is governed under workflow:<id>: a tool rule naming that server hides it from the model", async () => {
    const rule: McpToolPolicyRule = {
      id: "deny-lookup",
      name: "No order lookups",
      enabled: true,
      effect: "deny",
      serverId: "workflow:wf-lookup",
      toolPattern: "*",
      roles: [],
      projectId: null,
      mode: "enforce",
      createdAt: "2026-11-04T00:00:00.000Z",
      updatedAt: "2026-11-04T00:00:00.000Z"
    } as unknown as McpToolPolicyRule;
    const h = harness({ calls: [callLookup], workflows: [lookupChild()], rules: [rule] });
    const result = await executeWorkflow({ workflow: parentWorkflow({ workflowId: "wf-lookup" }), webhookPayload: { user_prompt: "x" } }, h.dependencies);
    expect(h.provider.requests[0]!.tools?.map((tool) => tool.name) ?? []).not.toContain("l2m-workflow__order_lookup");
    expect(agentOutput(result)?._toolPolicy?.hidden).toEqual([expect.objectContaining({ tool: "order_lookup", registryServerId: "workflow:wf-lookup", ruleId: "deny-lookup" })]);
    expect(h.child.calls).toBe(0);
  });

  it("asks the write-tool gate before a call, unless the node marks the workflow read-only", async () => {
    const settings: Workflow["settings"] = { writeToolApproval: { enabled: true } };
    const gated = harness({ calls: [callLookup], workflows: [lookupChild()] });
    const first = await executeWorkflow(
      { workflow: parentWorkflow({ workflowId: "wf-lookup" }, { settings }), executionId: "exec-gate", webhookPayload: { user_prompt: "x" } },
      gated.dependencies
    );
    expect(first.status).toBe("waiting_approval");
    expect(gated.child.calls).toBe(0);
    const approved = await resumeWorkflowExecution({ executionId: "exec-gate", state: gated.paused[0]!, decision: "approve" }, gated.dependencies);
    expect(approved.status).toBe("success");
    expect(gated.child.calls).toBe(1);

    const readOnly = harness({ calls: [callLookup], workflows: [lookupChild()] });
    const direct = await executeWorkflow(
      { workflow: parentWorkflow({ workflowId: "wf-lookup", readOnly: true }, { settings }), webhookPayload: { user_prompt: "x" } },
      readOnly.dependencies
    );
    expect(direct.status).toBe("success");
    expect(readOnly.child.calls).toBe(1);
  });

  it("turns a child that stops for an approval into a tool error the agent can act on", async () => {
    const withApproval = workflow(
      "wf-approve",
      [node("start", "sub_workflow_trigger"), node("ask", "human_approval", { approvalMessage: "OK?", timeoutMinutes: 60 }), node("out", "output")],
      [{ source: "start", target: "ask" }, { source: "ask", target: "out" }],
      { name: "Needs sign-off" }
    );
    const h = harness({ calls: [{ name: "l2m-workflow__needs_sign-off", arguments: { input: "go" } }], workflows: [withApproval] });
    const result = await executeWorkflow({ workflow: parentWorkflow({ workflowId: "wf-approve" }), webhookPayload: { user_prompt: "x" } }, h.dependencies);
    expect(result.status).toBe("success");
    expect(toolResults(result)[0]!.error).toMatch(/stopped to wait for an approval/);
    expect(h.paused).toEqual([]);
  });

  it("hands the call's labels to the child and takes the child's output labels for the result", async () => {
    const rule = { ...mcpSafetyPresetRule("untrusted_write_approval"), mode: "enforce" } as McpToolPolicyRule;
    const user: DataLabels = { provenance: ["user"], dataClasses: [], source: "propagated" };
    const calls = [callLookup, { name: "repo-mcp__push", arguments: { repo: "acme/app" } }];

    // A child that only computes from its input: its result is as trusted as the call, so the write goes through.
    const clean = harness({ calls, workflows: [lookupChild()], rules: [rule] });
    const passed = await executeWorkflow(
      { workflow: parentWorkflow({ workflowId: "wf-lookup" }, { withRepo: true }), webhookPayload: { user_prompt: "x" }, inputLabels: user },
      clean.dependencies
    );
    expect(passed.status).toBe("success");
    expect(clean.invoked).toEqual(["push"]);

    // A child that reads an MCP tool: its output is outside content, so the write after it needs approval.
    const reading = lookupChild("wf-lookup", [node("clock", "mcp_tool", { serverId: "mock-mcp", toolName: "get_current_time", argsTemplate: "{}" })], [{ source: "start", target: "clock" }, { source: "clock", target: "out" }]);
    const tainted = harness({ calls, workflows: [reading], rules: [rule] });
    const paused = await executeWorkflow(
      { workflow: parentWorkflow({ workflowId: "wf-lookup" }, { withRepo: true }), executionId: "exec-taint", webhookPayload: { user_prompt: "x" }, inputLabels: user },
      tainted.dependencies
    );
    expect(paused.status).toBe("waiting_approval");
    expect(tainted.invoked).toEqual([]);

    // Untrusted content in the call reaches the child: its own write needs approval there, which the call reports.
    const childWrites = workflow(
      "wf-writer",
      [
        node("start", "sub_workflow_trigger"),
        node("agent", "agent_orchestrator", { maxIterations: 3, toolCallingEnabled: true, userPromptTemplate: "{{user_prompt}}" }),
        node("model", "llm_call", { provider: { providerId: "scripted", model: "m" } }),
        node("repo", "mcp_tool", { serverId: "repo-mcp", toolName: "push" }),
        node("out", "output")
      ],
      [
        { source: "start", target: "agent" },
        { source: "agent", target: "out" },
        { source: "agent", sourceHandle: "chat_model", target: "model" },
        { source: "agent", sourceHandle: "tool", target: "repo" }
      ],
      { name: "Writer" }
    );
    const untrusted: DataLabels = { provenance: ["untrusted_external"], dataClasses: [], source: "propagated" };
    const writerCalls = [{ name: "l2m-workflow__writer", arguments: { input: "push it" } }, { name: "repo-mcp__push", arguments: {} }];
    // A workflow tool not marked read-only is a write: the rule asks before the parent calls it.
    const asWrite = harness({ calls: writerCalls, workflows: [childWrites], rules: [rule] });
    const gated = await executeWorkflow(
      { workflow: parentWorkflow({ workflowId: "wf-writer" }), executionId: "exec-writer", webhookPayload: { user_prompt: "x" }, inputLabels: untrusted },
      asWrite.dependencies
    );
    expect(gated.status).toBe("waiting_approval");
    expect(JSON.stringify(gated.output)).toContain("workflow:wf-writer");
    // Marked read-only, the call goes through, and the untrusted label reaches the child: its own write needs approval there.
    const inbound = harness({ calls: writerCalls, workflows: [childWrites], rules: [rule] });
    const result = await executeWorkflow(
      { workflow: parentWorkflow({ workflowId: "wf-writer", readOnly: true }), webhookPayload: { user_prompt: "x" }, inputLabels: untrusted },
      inbound.dependencies
    );
    expect(result.status).toBe("success");
    expect(toolResults(result)[0]!.error).toMatch(/stopped to wait for an approval/);
    expect(inbound.invoked).toEqual([]);
  });

  it("replays a call from the recording without running the child", async () => {
    const recorder = new McpCassetteRecorder();
    const live = harness({ calls: [callLookup], workflows: [lookupChild()], mcpRegistry: createRecordingRegistry(createDefaultMCPRegistry(), recorder) });
    const recorded = await executeWorkflow({ workflow: parentWorkflow({ workflowId: "wf-lookup" }), webhookPayload: { user_prompt: "x" } }, live.dependencies);
    expect(recorded.status).toBe("success");
    const cassette = recorder.toCassette();
    expect(cassette.servers).toEqual([expect.objectContaining({ key: "registry:workflow:wf-lookup", adapterId: "l2m-workflow" })]);

    const { registry } = createReplayRegistry(cassette, { mode: "strict" });
    const replay = harness({ calls: [callLookup], workflows: [lookupChild()], mcpRegistry: registry, loadWorkflow: null });
    const replayed = await executeWorkflow(
      { workflow: parentWorkflow({ workflowId: "wf-lookup" }), webhookPayload: { user_prompt: "x" } },
      { ...replay.dependencies, replayNodeHook: () => null }
    );
    expect(replayed.status).toBe("success");
    expect(replay.child.calls).toBe(0);
    expect(toolResults(replayed)[0]!.output).toEqual(toolResults(recorded)[0]!.output);
  });

  it("is valid only on a tool port, and never on the workflow it belongs to", () => {
    const attached = validateWorkflowGraph(parentWorkflow({ workflowId: "wf-lookup" }));
    expect(attached.issues.filter((issue) => issue.code.startsWith("workflow_tool") || issue.code === "invalid_tool_attachment")).toEqual([]);
    const self = validateWorkflowGraph(parentWorkflow({ workflowId: "wf-parent" }));
    expect(self.issues.map((issue) => issue.code)).toContain("workflow_tool_self_reference");
    const loose = validateWorkflowGraph(
      workflow("wf-loose", [node("in", "webhook_input"), node("wtool", "workflow_tool", { workflowId: "wf-lookup" }), node("out", "output")], [
        { source: "in", target: "wtool" },
        { source: "wtool", target: "out" }
      ])
    );
    expect(loose.issues.map((issue) => issue.code)).toContain("workflow_tool_not_attached");
    const missing = validateWorkflowGraph(parentWorkflow({}));
    expect(missing.issues.map((issue) => issue.code)).toContain("missing_workflow_tool_id");
  });
});
