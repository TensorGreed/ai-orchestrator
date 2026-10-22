import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeAdapter, AgentRuntimeContext, AgentToolRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry, type LLMProviderAdapter } from "@ai-orchestrator/provider-sdk";
import {
  NODE_ACTIVITY_LIMIT,
  type AgentRunRequest,
  type AgentRunState,
  type NodeActivityEvent,
  type Workflow,
  type WorkflowEdge,
  type WorkflowNode
} from "@ai-orchestrator/shared";
import { executeWorkflow, type WorkflowExecutionDependencies } from "./executor";

class FakeProvider implements LLMProviderAdapter {
  readonly definition = { id: "fake", label: "Fake", supportsTools: true, configSchema: {} };

  async generate() {
    return { content: "hello back", toolCalls: [], latencyMs: 12 };
  }
}

type AgentScript = (request: AgentRunRequest, tools: AgentToolRuntime, context: AgentRuntimeContext) => Promise<void>;

class ScriptedAgentRuntime implements AgentRuntimeAdapter {
  readonly id = "scripted-agent";
  constructor(private readonly script: AgentScript) {}

  async run(request: AgentRunRequest, tools: AgentToolRuntime, context: AgentRuntimeContext): Promise<AgentRunState> {
    await this.script(request, tools, context);
    return { finalAnswer: "done", stopReason: "final_answer", iterations: 1, messages: [], steps: [] };
  }
}

function makeDeps(extra: Partial<WorkflowExecutionDependencies> = {}, agentRuntime?: AgentRuntimeAdapter): WorkflowExecutionDependencies {
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(new FakeProvider());
  return {
    providerRegistry,
    mcpRegistry: createDefaultMCPRegistry(),
    connectorRegistry: createDefaultConnectorRegistry(),
    agentRuntime: agentRuntime ?? new ScriptedAgentRuntime(async () => undefined),
    resolveSecret: async () => undefined,
    ...extra
  };
}

function node(id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], name: id, position: { x: 0, y: 0 }, config };
}

function edge(source: string, target: string, sourceHandle?: string): WorkflowEdge {
  return { id: `${source}-${sourceHandle ?? "main"}-${target}`, source, target, ...(sourceHandle ? { sourceHandle } : {}) };
}

function workflow(nodes: WorkflowNode[], edges: WorkflowEdge[]): Workflow {
  return { id: "wf-activity", name: "Activity", schemaVersion: "1.0.0", workflowVersion: 1, nodes, edges };
}

const llmWorkflow = () =>
  workflow(
    [
      node("input", "text_input", { text: "hi there" }),
      node("llm", "llm_call", { provider: { providerId: "fake", model: "m1" }, promptKey: "text" }),
      node("output", "output", { responseTemplate: "{{answer}}" })
    ],
    [edge("input", "llm"), edge("llm", "output")]
  );

afterEach(() => vi.unstubAllGlobals());

describe("node activity", () => {
  it("records resolved input and model call events for an LLM node and attaches them to the result", async () => {
    const events: NodeActivityEvent[] = [];
    const result = await executeWorkflow({ workflow: llmWorkflow() }, makeDeps({ onNodeActivity: (event) => void events.push(event) }));
    expect(result.status).toBe("success");
    const llm = result.nodeResults.find((entry) => entry.nodeId === "llm")!;
    expect(llm.activity?.map((entry) => entry.kind)).toEqual(["resolved_input", "llm_call", "llm_call"]);
    expect(llm.activity?.map((entry) => entry.seq)).toEqual([0, 1, 2]);
    expect(llm.activity?.[0]).toMatchObject({ kind: "resolved_input", fields: { providerId: "fake", model: "m1", userPrompt: "hi there" } });
    expect(llm.activity?.[2]).toMatchObject({ kind: "llm_call", phase: "end", latencyMs: 12 });
    expect(events.filter((entry) => entry.nodeId === "llm")).toHaveLength(3);
    expect(result.nodeResults.find((entry) => entry.nodeId === "input")?.activity).toBeUndefined();
  });

  it("does not fail the run when the consumer throws or rejects", async () => {
    const throwing = await executeWorkflow({ workflow: llmWorkflow() }, makeDeps({ onNodeActivity: () => { throw new Error("boom"); } }));
    expect(throwing.status).toBe("success");
    const rejecting = await executeWorkflow({ workflow: llmWorkflow() }, makeDeps({ onNodeActivity: async () => { throw new Error("boom"); } }));
    expect(rejecting.status).toBe("success");
    expect(rejecting.nodeResults.find((entry) => entry.nodeId === "llm")?.activity).toHaveLength(3);
  });

  it("shows an HTTP request without query, fragment, userinfo, headers or body", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await executeWorkflow(
      {
        workflow: workflow(
          [
            node("input", "text_input", { text: "x" }),
            node("http", "http_request", {
              method: "post",
              urlTemplate: "https://user:pw@api.example.com:8443/v1/items?token=abc123#frag",
              headersTemplate: '{"X-Api-Key":"super-secret"}',
              bodyTemplate: '{"password":"hunter2"}'
            }),
            node("output", "output")
          ],
          [edge("input", "http"), edge("http", "output")]
        )
      },
      makeDeps()
    );
    expect(result.error).toBeUndefined();
    const http = result.nodeResults.find((entry) => entry.nodeId === "http")!;
    expect(http.activity).toHaveLength(1);
    const first = http.activity![0]!;
    expect(first).toMatchObject({ kind: "resolved_input", fields: { method: "POST", url: "https://api.example.com:8443/v1/items" } });
    const serialized = JSON.stringify(http.activity);
    for (const secret of ["abc123", "frag", "user:pw", "super-secret", "hunter2"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(Object.keys((first as { fields: object }).fields).sort()).toEqual(["method", "url"]);
  });

  it("masks credential-like path segments in an HTTP request URL", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await executeWorkflow(
      {
        workflow: workflow(
          [
            node("input", "text_input", { text: "x" }),
            node("http", "http_request", { method: "post", urlTemplate: "https://hooks.example.com/services/T0001/B0002/abcdefghijklmnopqrstuvwx" }),
            node("tg", "http_request", { method: "get", urlTemplate: "https://api.telegram.org/bot123456:ABC-def/getMe" }),
            node("output", "output")
          ],
          [edge("input", "http"), edge("http", "tg"), edge("tg", "output")]
        )
      },
      makeDeps()
    );
    const urlOf = (id: string) => (result.nodeResults.find((entry) => entry.nodeId === id)!.activity![0] as unknown as { fields: { url: string } }).fields.url;
    expect(urlOf("http")).toBe("https://hooks.example.com/services/T0001/B0002/•••");
    expect(urlOf("tg")).toBe("https://api.telegram.org/•••/getMe");
  });

  it("saves the activity recorded before an approval pause with the paused state", async () => {
    let saved: { nodeResults: Array<{ nodeId: string; activity?: NodeActivityEvent[] }> } | undefined;
    const paused = workflow(
      [node("input", "text_input", { text: "hi there" }), node("llm", "llm_call", { provider: { providerId: "fake", model: "m1" } }), node("approve", "human_approval", { approvalMessage: "Approve?", timeoutMinutes: 5 }), node("output", "output")],
      [edge("input", "llm"), edge("llm", "approve"), edge("approve", "output")]
    );
    const result = await executeWorkflow(
      { workflow: paused },
      makeDeps({
        persistPausedExecution: async (input) => {
          saved = input.state as unknown as typeof saved;
        }
      })
    );
    expect(result.status).toBe("waiting_approval");
    const llm = saved?.nodeResults.find((entry) => entry.nodeId === "llm");
    expect(llm?.activity?.map((entry) => entry.kind)).toEqual(["resolved_input", "llm_call", "llm_call"]);
  });

  it("keeps only the last NODE_ACTIVITY_LIMIT entries per node and numbers them in order", async () => {
    const runtime = new ScriptedAgentRuntime(async (_request, _tools, context) => {
      for (let index = 0; index < NODE_ACTIVITY_LIMIT + 30; index += 1) {
        context.onEvent?.({ kind: "agent_step", phase: "start", iteration: index + 1, maxIterations: 200 });
      }
    });
    const streamed: NodeActivityEvent[] = [];
    const result = await executeWorkflow(
      {
        workflow: workflow(
          [
            node("trigger", "webhook_input"),
            node("agent", "agent_orchestrator", { systemPromptTemplate: "S", userPromptTemplate: "go", maxIterations: 200 }),
            node("model", "llm_call", { provider: { providerId: "fake", model: "m" } }),
            node("output", "output")
          ],
          [edge("trigger", "agent"), edge("agent", "output"), edge("agent", "model", "chat_model")]
        )
      },
      makeDeps({ onNodeActivity: (event) => void streamed.push(event) }, runtime)
    );
    const activity = result.nodeResults.find((entry) => entry.nodeId === "agent")!.activity!;
    expect(activity).toHaveLength(NODE_ACTIVITY_LIMIT);
    const total = 1 + NODE_ACTIVITY_LIMIT + 30;
    expect(activity.at(-1)!.seq).toBe(total - 1);
    expect(activity[0]!.seq).toBe(total - NODE_ACTIVITY_LIMIT);
    expect(streamed.filter((event) => event.nodeId === "agent")).toHaveLength(total);
    expect(activity[0]).toMatchObject({ kind: "agent_step" });
  });

  it("reports an agent's resolved input and sends a worker's events to the Supervisor with workerNodeId", async () => {
    const runtime = new ScriptedAgentRuntime(async (request, tools, context) => {
      context.onEvent?.({ kind: "agent_step", phase: "start", iteration: 1, maxIterations: request.maxIterations });
      const delegate = tools.tools.find((tool) => tool.name.startsWith("delegate_to_"));
      if (delegate) await tools.invokeTool(delegate.name, { task_prompt: "do it" });
    });
    const result = await executeWorkflow(
      {
        workflow: workflow(
          [
            node("trigger", "webhook_input"),
            node("sup", "supervisor_node", { systemPromptTemplate: "S", userPromptTemplate: "go", maxIterations: 4, toolCallingEnabled: true }),
            node("worker", "agent_orchestrator", { systemPromptTemplate: "W", userPromptTemplate: "{{user_prompt}}", maxIterations: 3 }),
            node("model", "llm_call", { provider: { providerId: "fake", model: "m" } }),
            node("output", "output")
          ],
          [
            edge("trigger", "sup"),
            edge("sup", "output"),
            edge("sup", "model", "chat_model"),
            edge("sup", "worker", "worker"),
            edge("worker", "model", "chat_model")
          ]
        )
      },
      makeDeps({}, runtime)
    );
    expect(result.status).toBe("success");
    const sup = result.nodeResults.find((entry) => entry.nodeId === "sup")!.activity!;
    expect(sup[0]).toMatchObject({ kind: "resolved_input", fields: { providerId: "fake", model: "m", maxIterations: 4, workers: ["worker"] } });
    const own = sup.filter((entry) => !entry.workerNodeId);
    const fromWorker = sup.filter((entry) => entry.workerNodeId === "worker");
    expect(own.some((entry) => entry.kind === "agent_step")).toBe(true);
    expect(fromWorker.map((entry) => entry.kind)).toEqual(["resolved_input", "agent_step"]);
    expect(new Set(sup.map((entry) => entry.nodeId))).toEqual(new Set(["sup"]));
    expect(sup.map((entry) => entry.seq)).toEqual(sup.map((_, index) => index));
    expect(result.nodeResults.find((entry) => entry.nodeId === "worker")?.activity).toBeUndefined();
  });
});
