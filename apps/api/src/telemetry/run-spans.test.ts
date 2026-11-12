/**
 * The engine and the agent runtime traced through the RunInstrumentation seam, collected with the real OpenTelemetry
 * SDK in memory: the span tree of a DAG run, an agent with tool calls, a Supervisor with a worker, failures, attachment
 * nodes (no node span) and the off path (nothing recorded). Model spans, MCP spans and queue spans belong to later
 * lanes and do not appear here.
 */
import { afterEach, describe, expect, it } from "vitest";
import { DefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { MCPRegistry, MockMCPServerAdapter } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry, type LLMProviderAdapter, type ProviderCallRequest } from "@ai-orchestrator/provider-sdk";
import {
  createOtelRuntime,
  DEFAULT_BATCH_OPTIONS,
  InMemorySpanExporter,
  type OtelRuntime,
  type OtelRuntimeOptions,
  type ReadableSpan,
  type SpanProcessor
} from "@ai-orchestrator/otel";
import {
  NOOP_RUN_INSTRUMENTATION,
  type LLMCallResponse,
  type MCPServerConfig,
  type RunInstrumentation,
  type Workflow,
  type WorkflowEdge,
  type WorkflowNode
} from "@ai-orchestrator/shared";
import { describeRunResult, executeWorkflow, type WorkflowExecutionDependencies } from "@ai-orchestrator/workflow-engine";

const SPAN_STATUS_ERROR = 2;
const SPAN_STATUS_UNSET = 0;

type Answer = (request: ProviderCallRequest) => LLMCallResponse;

/** A model that answers from a function of the request (no network). */
class ScriptedProvider implements LLMProviderAdapter {
  readonly definition = { id: "scripted", label: "Scripted", supportsTools: true, configSchema: {} };
  constructor(private readonly answer: Answer) {}
  async generate(request: ProviderCallRequest): Promise<LLMCallResponse> {
    return this.answer(request);
  }
}

const REGISTRY_ID = "mcp_mock";
const registryConfig: MCPServerConfig = { serverId: "mock-mcp", registryServerId: REGISTRY_ID, label: "Mock", connection: {} };

function deps(answer: Answer, instrument?: RunInstrumentation): WorkflowExecutionDependencies {
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(new ScriptedProvider(answer));
  const mcpRegistry = new MCPRegistry();
  mcpRegistry.register(new MockMCPServerAdapter());
  return {
    providerRegistry,
    mcpRegistry,
    connectorRegistry: createDefaultConnectorRegistry(),
    agentRuntime: new DefaultAgentRuntime(),
    resolveSecret: async () => undefined,
    resolveRegisteredMcpServer: (id) => {
      if (id !== REGISTRY_ID) throw new Error(`unknown server ${id}`);
      return registryConfig;
    },
    ...(instrument ? { instrument } : {})
  };
}

function node(id: string, type: string, config: Record<string, unknown> = {}, name = id): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], name, position: { x: 0, y: 0 }, config };
}

function edge(source: string, target: string, sourceHandle?: string): WorkflowEdge {
  return { id: `${source}-${sourceHandle ?? "main"}-${target}`, source, target, ...(sourceHandle ? { sourceHandle } : {}) };
}

function workflow(id: string, nodes: WorkflowNode[], edges: WorkflowEdge[]): Workflow {
  return { id, name: `Flow ${id}`, schemaVersion: "1.0.0", workflowVersion: 1, nodes, edges };
}

const MODEL = { provider: { providerId: "scripted", model: "m" } };

/** Hands each ended span to the exporter at once. */
function exportingAtOnce(exporter: InMemorySpanExporter): SpanProcessor {
  return {
    onStart: () => undefined,
    onEnd: (span) => exporter.export([span], () => undefined),
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve()
  };
}

let runtimes: OtelRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.map((runtime) => runtime.shutdown()));
  runtimes = [];
});

function tracing(overrides: Partial<OtelRuntimeOptions> = {}) {
  const exporter = new InMemorySpanExporter();
  const runtime = createOtelRuntime({
    resourceAttributes: { "service.name": "l2m-test" },
    export: null,
    sampler: { name: "parentbased_always_on" },
    propagators: ["tracecontext"],
    batch: DEFAULT_BATCH_OPTIONS,
    attributeValueLengthLimit: 8192,
    spanDetail: "standard",
    naming: "names",
    propagateToProviders: false,
    propagateToMcp: true,
    semconvOptIn: [],
    recentSpanLimit: 100,
    spanProcessors: [exportingAtOnce(exporter)],
    registerGlobals: false,
    ...overrides
  });
  runtimes.push(runtime);
  const inst = runtime.instrumentation;
  const spans = () => exporter.getFinishedSpans();
  const named = (name: string): ReadableSpan[] => spans().filter((span) => span.name === name);
  const one = (name: string): ReadableSpan => {
    const found = named(name);
    if (found.length !== 1) throw new Error(`expected one ${name}, found ${found.length}; have ${spans().map((s) => s.name).join(", ")}`);
    return found[0]!;
  };
  const parentOf = (span: ReadableSpan) => span.parentSpanContext?.spanId;
  /** Runs a workflow the way the API does: the host's run span around the engine. */
  const run = (wf: Workflow, answer: Answer, request: Partial<Parameters<typeof executeWorkflow>[0]> = {}) =>
    inst.run({ executionId: `exec-${wf.id}`, workflowId: wf.id, workflowName: wf.name, triggerType: "manual" }, async (span) => {
      const result = await executeWorkflow({ workflow: wf, executionId: `exec-${wf.id}`, ...request }, deps(answer, inst));
      describeRunResult(span, result);
      return result;
    });
  return { inst, spans, named, one, parentOf, run };
}

const finalAnswer = (content: string): LLMCallResponse => ({ content, toolCalls: [] });

describe("run and node spans", () => {
  it("gives every executed DAG node a span under the run span, with its outcome", async () => {
    const t = tracing();
    const wf = workflow(
      "dag",
      [
        node("in", "webhook_input"),
        node("loop", "loop_node", { inputKey: "items", itemVariable: "item" }),
        node("each", "set_node", { assignments: [{ key: "line", valueTemplate: "{{item}}" }] }),
        node("llm", "llm_call", { ...MODEL, promptKey: "user_prompt" }, "Summarise"),
        node("out", "output"),
        node("stray", "set_node", { assignments: [{ key: "x", valueTemplate: "1" }] })
      ],
      [edge("in", "loop"), edge("loop", "each"), edge("in", "llm"), edge("llm", "out")]
    );
    const result = await t.run(wf, () => finalAnswer("short summary"), { webhookPayload: { items: ["a", "b"], user_prompt: "hi" }, input: { items: ["a", "b"] } });
    expect(result.status).toBe("success");

    const runSpan = t.one("invoke_workflow Flow dag");
    expect(runSpan.attributes).toMatchObject({ "l2m.execution.id": "exec-dag", "l2m.run.status": "success" });
    const nodeSpans = t.spans().filter((span) => span.name.startsWith("l2m.node "));
    // The disconnected node is skipped: no span.
    expect(nodeSpans.map((span) => span.attributes["l2m.node.id"]).sort()).toEqual(["each", "each", "in", "llm", "loop", "out"]);
    for (const id of ["in", "loop", "llm", "out"]) {
      const span = nodeSpans.find((candidate) => candidate.attributes["l2m.node.id"] === id)!;
      expect(t.parentOf(span)).toBe(runSpan.spanContext().spanId);
      expect(span.attributes["l2m.node.status"]).toBe("success");
      expect(span.status.code).toBe(SPAN_STATUS_UNSET);
    }
    expect(t.one("l2m.node llm_call").attributes).toMatchObject({ "l2m.node.type": "llm_call", "l2m.node.name": "Summarise" });
    // A loop body's passes are children of the Loop node's span.
    const loopSpan = t.one("l2m.node loop_node");
    const passes = nodeSpans.filter((span) => span.attributes["l2m.node.id"] === "each");
    expect(passes.map((span) => t.parentOf(span))).toEqual([loopSpan.spanContext().spanId, loopSpan.spanContext().spanId]);
    expect(passes.map((span) => span.attributes["l2m.node.loop_index"])).toEqual([0, 1]);
    expect(t.spans().every((span) => span.spanContext().traceId === runSpan.spanContext().traceId)).toBe(true);
  });

  it("marks a failed node and its run ERROR with the error category, and the skipped rest gets no span", async () => {
    const t = tracing();
    const wf = workflow(
      "fail",
      [node("in", "webhook_input"), node("llm", "llm_call", { ...MODEL, promptKey: "user_prompt" }), node("out", "output")],
      [edge("in", "llm"), edge("llm", "out")]
    );
    const result = await t.run(
      wf,
      () => {
        throw Object.assign(new Error("401 invalid api key sk-test-123"), { status: 401 });
      },
      { webhookPayload: { user_prompt: "hi" } }
    );
    expect(result.status).toBe("error");
    const llm = t.one("l2m.node llm_call");
    expect(llm.status.code).toBe(SPAN_STATUS_ERROR);
    expect(llm.attributes["l2m.node.status"]).toBe("error");
    expect(llm.attributes["error.type"]).toBe(result.errorCategory);
    const runSpan = t.one("invoke_workflow Flow fail");
    expect(runSpan.status.code).toBe(SPAN_STATUS_ERROR);
    expect(runSpan.attributes).toMatchObject({ "l2m.run.status": "error", "error.type": result.errorCategory });
    expect(t.named("l2m.node output")).toHaveLength(0);
    // Error types only: the error text (here quoting a key) stays in the run's history.
    const recorded = JSON.stringify(t.spans().map((span) => [span.attributes, span.events, span.status]));
    expect(recorded).not.toContain("sk-test-123");
    expect(recorded).not.toContain("invalid api key");
  });

  it("gives a node answered from pinned data a span with no children", async () => {
    const t = tracing();
    const wf = workflow(
      "pinned",
      [node("in", "webhook_input"), node("llm", "llm_call", { ...MODEL, promptKey: "user_prompt" }), node("out", "output")],
      [edge("in", "llm"), edge("llm", "out")]
    );
    const result = await t.run(wf, () => {
      throw new Error("the model must not be called");
    }, { pinnedData: { llm: { answer: "pinned" } }, usePinnedData: true });
    expect(result.status).toBe("success");
    const llm = t.one("l2m.node llm_call");
    expect(llm.attributes["l2m.node.status"]).toBe("success");
    expect(t.spans().filter((span) => t.parentOf(span) === llm.spanContext().spanId)).toHaveLength(0);
  });

  it("records a node that continues on error as ERROR while the run is partial", async () => {
    const t = tracing();
    const wf = workflow(
      "cont",
      [node("in", "webhook_input"), node("stop", "stop_and_error", { errorMessage: "nope", onError: "continue" }), node("out", "output")],
      [edge("in", "stop"), edge("stop", "out")]
    );
    const result = await t.run(wf, () => finalAnswer("x"));
    expect(result.status).toBe("partial");
    expect(t.one("l2m.node stop_and_error").status.code).toBe(SPAN_STATUS_ERROR);
    expect(t.one("l2m.node output").attributes["l2m.node.status"]).toBe("success");
    expect(t.one("invoke_workflow Flow cont").status.code).toBe(SPAN_STATUS_UNSET);
  });

  it("shows an approval pause as an outcome, not an error", async () => {
    const t = tracing();
    const wf = workflow(
      "pause",
      [node("in", "webhook_input"), node("approve", "human_approval", { approvalMessage: "OK?", timeoutMinutes: 5 }), node("out", "output")],
      [edge("in", "approve"), edge("approve", "out")]
    );
    const result = await t.run(wf, () => finalAnswer("x"));
    expect(result.status).toBe("waiting_approval");
    const approve = t.one("l2m.node human_approval");
    expect(approve.attributes["l2m.node.status"]).toBe("waiting_approval");
    expect(approve.status.code).toBe(SPAN_STATUS_UNSET);
    expect(t.one("invoke_workflow Flow pause").attributes["l2m.run.status"]).toBe("waiting_approval");
  });

  it("uses ids instead of names when naming is ids", async () => {
    const t = tracing({ naming: "ids" });
    const wf = workflow("ids", [node("in", "webhook_input", {}, "Customer ACME intake"), node("out", "output")], [edge("in", "out")]);
    await t.run(wf, () => finalAnswer("x"));
    expect(t.one("invoke_workflow ids").attributes["l2m.workflow.name"]).toBeUndefined();
    expect(t.one("l2m.node webhook_input").attributes["l2m.node.name"]).toBeUndefined();
  });
});

describe("agent and tool spans", () => {
  const agentWorkflow = () =>
    workflow(
      "agent",
      [
        node("hook", "webhook_input"),
        node("agent", "agent_orchestrator", { systemPromptTemplate: "Use tools.", userPromptTemplate: "{{user_prompt}}", maxIterations: 4, sessionIdTemplate: "sess-7" }, "Helper"),
        node("model", "llm_call", MODEL),
        node("tools", "mcp_tool", { registryServerId: REGISTRY_ID, toolName: "__all__" }),
        node("out", "output")
      ],
      [edge("hook", "agent"), edge("agent", "out"), edge("agent", "model", "chat_model"), edge("agent", "tools", "tool")]
    );
  const toolThenAnswer: Answer = (request) =>
    request.messages.some((message) => message.role === "tool")
      ? finalAnswer("It is late.")
      : {
          content: "",
          toolCalls: [
            { id: "call-1", name: "mock-mcp__get_current_time", arguments: { tz: "UTC" } },
            { id: "call-2", name: "no_such_tool", arguments: {} }
          ]
        };

  it("nests invoke_agent under the agent's node span and each tool call under the agent", async () => {
    const t = tracing();
    const result = await t.run(agentWorkflow(), toolThenAnswer, { webhookPayload: { user_prompt: "what time is it?" } });
    expect(result.status).toBe("success");

    const nodeSpan = t.one("l2m.node agent_orchestrator");
    const agent = t.one("invoke_agent Helper");
    expect(t.parentOf(agent)).toBe(nodeSpan.spanContext().spanId);
    expect(agent.attributes).toMatchObject({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.id": "agent",
      "gen_ai.agent.name": "Helper",
      "gen_ai.conversation.id": "sess-7",
      "l2m.agent.supervisor": false,
      "l2m.agent.iterations": 2,
      "l2m.agent.stop_reason": "final_answer"
    });

    const time = t.one("execute_tool mock-mcp__get_current_time");
    expect(t.parentOf(time)).toBe(agent.spanContext().spanId);
    expect(time.attributes).toMatchObject({
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "mock-mcp__get_current_time",
      "gen_ai.tool.call.id": "call-1",
      "gen_ai.tool.type": "extension",
      "l2m.tool.outcome": "ok"
    });
    const missing = t.one("execute_tool no_such_tool");
    expect(missing.status.code).toBe(SPAN_STATUS_ERROR);
    expect(missing.attributes).toMatchObject({ "l2m.tool.outcome": "error", "error.type": "tool_not_found" });
    // A tool's error text is external content: only its type is recorded.
    expect(missing.events.every((event) => event.attributes?.["exception.message"] === undefined)).toBe(true);

    // Attachment-port nodes are not DAG steps: no node span for the model or the tools node.
    const nodeIds = t.spans().map((span) => span.attributes["l2m.node.id"]).filter(Boolean);
    expect(nodeIds).not.toContain("model");
    expect(nodeIds).not.toContain("tools");
    expect(result.nodeResults.find((entry) => entry.nodeId === "model")?.status).not.toBe("error");
    expect(t.named("l2m.agent.iteration")).toHaveLength(0);
  });

  it("keeps the model's last answer off the agent span when the loop stops on a model failure", async () => {
    const t = tracing();
    const answer: Answer = (request) => {
      if (request.messages.some((message) => message.role === "tool")) {
        throw Object.assign(new Error("tape miss"), { code: "MODEL_TAPE_MISS" });
      }
      return { content: "PLANTED-ANSWER-7731", toolCalls: [{ id: "call-1", name: "mock-mcp__get_current_time", arguments: {} }] };
    };
    const result = await t.run(agentWorkflow(), answer, { webhookPayload: { user_prompt: "time?" } });
    expect(result.status).toBe("success");
    const agent = t.one("invoke_agent Helper");
    expect(agent.attributes).toMatchObject({ "l2m.agent.stop_reason": "error", "error.type": "agent_error" });
    expect(agent.status.code).toBe(SPAN_STATUS_ERROR);
    expect(JSON.stringify(t.spans().map((span) => [span.attributes, span.events, span.status]))).not.toContain("PLANTED-ANSWER-7731");
  });

  it("adds one span per agent turn at the verbose span detail, with the tool calls inside their turn", async () => {
    const t = tracing({ spanDetail: "verbose" });
    await t.run(agentWorkflow(), toolThenAnswer, { webhookPayload: { user_prompt: "what time is it?" } });
    const agent = t.one("invoke_agent Helper");
    const turns = t.named("l2m.agent.iteration").sort((a, b) => Number(a.attributes["l2m.agent.iteration"]) - Number(b.attributes["l2m.agent.iteration"]));
    expect(turns.map((span) => span.attributes["l2m.agent.iteration"])).toEqual([1, 2]);
    expect(turns.every((span) => t.parentOf(span) === agent.spanContext().spanId)).toBe(true);
    expect(turns[1]!.attributes["l2m.agent.final"]).toBe(true);
    expect(turns[0]!.attributes["l2m.agent.final"]).toBeUndefined();
    for (const name of ["execute_tool mock-mcp__get_current_time", "execute_tool no_such_tool"]) {
      expect(t.parentOf(t.one(name))).toBe(turns[0]!.spanContext().spanId);
    }
  });

  it("puts a Supervisor's worker under the execute_tool span that delegated to it", async () => {
    const t = tracing();
    const wf = workflow(
      "sup",
      [
        node("hook", "webhook_input"),
        node("sup", "supervisor_node", { systemPromptTemplate: "S", userPromptTemplate: "go", maxIterations: 4, toolCallingEnabled: true }, "Lead"),
        node("worker", "agent_orchestrator", { systemPromptTemplate: "W", userPromptTemplate: "{{user_prompt}}", maxIterations: 3 }, "Researcher"),
        node("model", "llm_call", MODEL),
        node("out", "output")
      ],
      [edge("hook", "sup"), edge("sup", "out"), edge("sup", "model", "chat_model"), edge("sup", "worker", "worker"), edge("worker", "model", "chat_model")]
    );
    const answer: Answer = (request) => {
      const delegate = request.tools?.find((tool) => tool.name.startsWith("delegate_to_"));
      if (!delegate) return finalAnswer("worker result");
      if (request.messages.some((message) => message.role === "tool")) return finalAnswer("all done");
      return { content: "", toolCalls: [{ id: "call-w", name: delegate.name, arguments: { task_prompt: "find it" } }] };
    };
    const result = await t.run(wf, answer);
    expect(result.status).toBe("success");

    const lead = t.one("invoke_agent Lead");
    expect(lead.attributes["l2m.agent.supervisor"]).toBe(true);
    const delegation = t.spans().find((span) => span.name.startsWith("execute_tool delegate_to_"))!;
    expect(delegation.attributes["gen_ai.tool.type"]).toBe("function");
    expect(t.parentOf(delegation)).toBe(lead.spanContext().spanId);
    const worker = t.one("invoke_agent Researcher");
    expect(t.parentOf(worker)).toBe(delegation.spanContext().spanId);
    expect(worker.attributes).toMatchObject({ "gen_ai.agent.id": "worker", "l2m.agent.supervisor": false });
    // The worker is an attachment: it runs as its Supervisor's tool, never as a DAG node.
    expect(t.spans().filter((span) => span.attributes["l2m.node.id"] === "worker")).toHaveLength(0);
  });

  it("gives a sub-workflow's child run its own invoke_workflow span under the calling node", async () => {
    const t = tracing();
    const child = workflow("child", [node("cin", "webhook_input"), node("cout", "output")], [edge("cin", "cout")]);
    const parent = workflow(
      "parent",
      [node("in", "webhook_input"), node("call", "execute_workflow", { workflowId: "child" }), node("out", "output")],
      [edge("in", "call"), edge("call", "out")]
    );
    const exec = await t.inst.run({ executionId: "exec-p", workflowId: "parent" }, async () =>
      executeWorkflow({ workflow: parent, executionId: "exec-p" }, { ...deps(() => finalAnswer("x"), t.inst), loadWorkflow: (id) => (id === "child" ? child : undefined) })
    );
    expect(exec.status).toBe("success");
    const call = t.one("l2m.node execute_workflow");
    const childRun = t.one("invoke_workflow Flow child");
    expect(t.parentOf(childRun)).toBe(call.spanContext().spanId);
    expect(childRun.attributes).toMatchObject({ "l2m.workflow.id": "child", "l2m.trigger.type": "sub_workflow", "l2m.run.status": "success" });
    const childNodes = t.spans().filter((span) => span.attributes["l2m.node.id"] === "cout");
    expect(childNodes.map((span) => t.parentOf(span))).toEqual([childRun.spanContext().spanId]);
  });
});

describe("tracing off", () => {
  it("never calls an instrumentation that is off, and the run is unchanged", async () => {
    const calls: string[] = [];
    const off = new Proxy({ ...NOOP_RUN_INSTRUMENTATION }, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (typeof value === "function") {
          return (...args: unknown[]) => {
            calls.push(String(key));
            return (value as (...a: unknown[]) => unknown)(...args);
          };
        }
        return value;
      }
    });
    const wf = workflow(
      "off",
      [
        node("hook", "webhook_input"),
        node("agent", "agent_orchestrator", { systemPromptTemplate: "S", userPromptTemplate: "{{user_prompt}}", maxIterations: 3 }),
        node("model", "llm_call", MODEL),
        node("tools", "mcp_tool", { registryServerId: REGISTRY_ID, toolName: "__all__" }),
        node("out", "output")
      ],
      [edge("hook", "agent"), edge("agent", "out"), edge("agent", "model", "chat_model"), edge("agent", "tools", "tool")]
    );
    const answer: Answer = (request) =>
      request.messages.some((message) => message.role === "tool")
        ? finalAnswer("done")
        : { content: "", toolCalls: [{ id: "c1", name: "mock-mcp__get_current_time", arguments: {} }] };
    const traced = await executeWorkflow({ workflow: wf, webhookPayload: { user_prompt: "t" } }, deps(answer, off));
    const plain = await executeWorkflow({ workflow: wf, webhookPayload: { user_prompt: "t" } }, deps(answer));
    expect(traced.status).toBe("success");
    expect(calls).toEqual([]);
    const shape = (result: typeof plain) => result.nodeResults.map((entry) => [entry.nodeId, entry.status]);
    expect(shape(traced)).toEqual(shape(plain));
  });
});
