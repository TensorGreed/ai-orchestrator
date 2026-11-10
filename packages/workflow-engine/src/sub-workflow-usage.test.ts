/**
 * The model usage of sub-workflows: an Execute Workflow node reports each finished child's model usage through
 * `onSubWorkflowUsage` (sync, async, failed, nested, paused and resumed), and asks `admitSubWorkflow` before it starts
 * one, as a Workflow Tool does. Each child's usage is reported once.
 */
import { describe, expect, it } from "vitest";
import { DefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry, type LLMProviderAdapter, type ProviderCallRequest } from "@ai-orchestrator/provider-sdk";
import type { ChatMessage, Workflow, WorkflowEdge, WorkflowExecutionState, WorkflowNode } from "@ai-orchestrator/shared";
import { executeWorkflow, resumeWorkflowExecution, type SubWorkflowUsage, type WorkflowExecutionDependencies } from "./executor";

function node(id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], name: id, position: { x: 0, y: 0 }, config };
}

function chainWorkflow(id: string, nodes: WorkflowNode[], extraEdges: Array<Omit<WorkflowEdge, "id">> = []): Workflow {
  const edges = [...nodes.slice(1).map((entry, index) => ({ source: nodes[index]!.id, target: entry.id })), ...extraEdges];
  return { id, name: `Workflow ${id}`, schemaVersion: "1.0.0", workflowVersion: 1, nodes, edges: edges.map((edge, index) => ({ id: `e${index}`, ...edge })) };
}

/** Answers with fixed usage; the model name tells which workflow called it. */
class MeteredModel implements LLMProviderAdapter {
  readonly definition = { id: "metered", label: "Metered", supportsTools: false, configSchema: {} };
  calls = 0;
  async generate(_request: ProviderCallRequest) {
    this.calls += 1;
    return { content: "ok", toolCalls: [], usage: { inputTokens: 70, outputTokens: 30, totalTokens: 100 } };
  }
}

/** Calls the workflow tool once; on its next turn the run is stopped (as a person's Stop or the run's timeout would). */
class StopsAfterToolModel implements LLMProviderAdapter {
  readonly definition = { id: "stopping", label: "Stopping", supportsTools: true, configSchema: {} };
  constructor(private readonly stop: AbortController) {}
  async generate(request: ProviderCallRequest) {
    if (request.messages.some((message: ChatMessage) => message.role === "tool")) {
      this.stop.abort(new Error("Stopped by a person."));
      throw new Error("aborted");
    }
    const tool = request.tools?.find((entry) => entry.name.startsWith("l2m-workflow__"));
    return { content: "Calling.", toolCalls: tool ? [{ id: "call-1", name: tool.name, arguments: { input: "x" } }] : [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }
}

/** The parent agent's model: calls the one tool it is offered once, then answers. */
class ToolCallingModel implements LLMProviderAdapter {
  readonly definition = { id: "caller", label: "Caller", supportsTools: true, configSchema: {} };
  async generate(request: ProviderCallRequest) {
    const done = request.messages.some((message: ChatMessage) => message.role === "tool");
    const tool = request.tools?.find((entry) => entry.name.startsWith("l2m-workflow__"));
    if (!done && tool) return { content: "Calling.", toolCalls: [{ id: "call-1", name: tool.name, arguments: { input: "x" } }], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    return { content: "Done.", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }
}

const model = (id: string, name: string) => node(id, "llm_call", { provider: { providerId: "metered", model: name }, userPromptTemplate: "hi" });

function child(id: string, extra: WorkflowNode[] = []): Workflow {
  return chainWorkflow(id, [node("start", "sub_workflow_trigger"), model("model", id), ...extra, node("out", "output")]);
}

function caller(id: string, steps: Array<{ id: string; workflowId: string; mode?: "sync" | "async" }>, trigger = "manual_trigger"): Workflow {
  return chainWorkflow(id, [
    node("start", trigger),
    ...steps.map((step) => node(step.id, "execute_workflow", { workflowId: step.workflowId, mode: step.mode ?? "sync" })),
    node("out", "output")
  ]);
}

function harness(workflows: Workflow[], extra: Partial<WorkflowExecutionDependencies> = {}) {
  const providerRegistry = new ProviderRegistry();
  const metered = new MeteredModel();
  providerRegistry.register(metered);
  providerRegistry.register(new ToolCallingModel());
  const byId = new Map(workflows.map((entry) => [entry.id, entry]));
  const reports: SubWorkflowUsage[] = [];
  const paused: WorkflowExecutionState[] = [];
  const dependencies: WorkflowExecutionDependencies = {
    providerRegistry,
    connectorRegistry: createDefaultConnectorRegistry(),
    mcpRegistry: createDefaultMCPRegistry(),
    agentRuntime: new DefaultAgentRuntime(),
    resolveSecret: async () => undefined,
    loadWorkflow: async (id) => byId.get(id),
    onSubWorkflowUsage: (usage) => {
      reports.push(usage);
    },
    persistPausedExecution: async (state) => {
      paused.push(state.state);
    },
    ...extra
  };
  return { dependencies, reports, paused, metered, providerRegistry };
}

/** The models the reported blobs came from, by model name (the workflow that called it). */
const modelsIn = (usage: SubWorkflowUsage) => usage.telemetry.map((blob) => (blob as { model?: string }).model);

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("sub-workflow usage reports", () => {
  it("reports a synchronous child's model usage once it finishes", async () => {
    const h = harness([child("wf-child")]);
    const result = await executeWorkflow({ workflow: caller("wf-parent", [{ id: "call", workflowId: "wf-child" }]) }, h.dependencies);
    expect(result.status).toBe("success");
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]).toMatchObject({ workflowId: "wf-child", status: "success", mode: "sync" });
    expect(h.reports[0]!.telemetry).toEqual([expect.objectContaining({ providerId: "metered", model: "wf-child", usage: expect.objectContaining({ totalTokens: 100 }) })]);
    // The node's output stays the child's output: no usage is added to it.
    expect(JSON.stringify(result.nodeResults.find((entry) => entry.nodeId === "call")?.output)).not.toContain("_telemetry");
  });

  it("reports nothing for a child that made no model call", async () => {
    const quiet = chainWorkflow("wf-quiet", [node("start", "sub_workflow_trigger"), node("out", "output")]);
    const h = harness([quiet]);
    await executeWorkflow({ workflow: caller("wf-parent", [{ id: "call", workflowId: "wf-quiet" }]) }, h.dependencies);
    expect(h.reports).toEqual([]);
  });

  it("reports a failed child's usage before the node fails", async () => {
    // The child fails after its model call: it calls a workflow that does not exist.
    const failing = child("wf-failing", [node("boom", "execute_workflow", { workflowId: "wf-missing" })]);
    const h = harness([failing]);
    const result = await executeWorkflow({ workflow: caller("wf-parent", [{ id: "call", workflowId: "wf-failing" }]) }, h.dependencies);
    expect(result.status).toBe("error");
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]).toMatchObject({ workflowId: "wf-failing", status: "error" });
    expect(modelsIn(h.reports[0]!)).toEqual(["wf-failing"]);
  });

  it("reports each nested child once: a grandchild itself, not again inside its caller", async () => {
    const middle = chainWorkflow("wf-middle", [node("start", "sub_workflow_trigger"), model("model", "wf-middle"), node("call", "execute_workflow", { workflowId: "wf-leaf" }), node("out", "output")]);
    const h = harness([child("wf-leaf"), middle]);
    await executeWorkflow({ workflow: caller("wf-top", [{ id: "call", workflowId: "wf-middle" }]) }, h.dependencies);
    expect(h.reports.map((usage) => [usage.workflowId, modelsIn(usage)])).toEqual([
      ["wf-leaf", ["wf-leaf"]],
      ["wf-middle", ["wf-middle"]]
    ]);
  });

  it("reports an asynchronous child's usage when it ends, after the parent returned", async () => {
    const h = harness([child("wf-child")]);
    const result = await executeWorkflow({ workflow: caller("wf-parent", [{ id: "call", workflowId: "wf-child", mode: "async" }]) }, h.dependencies);
    expect(result.status).toBe("success");
    await waitFor(() => h.reports.length === 1);
    expect(h.reports[0]).toMatchObject({ workflowId: "wf-child", mode: "async" });
  });

  it("reports a paused child after the resume, with what it spent before the pause", async () => {
    // The gate follows a Set node: an approved gate passes on its input, which would repeat the model's usage blob.
    const gated = chainWorkflow("wf-gated", [
      node("start", "sub_workflow_trigger"),
      model("model", "wf-gated"),
      node("note", "set_node", { assignments: [{ key: "draft", valueTemplate: "{{result}}" }] }),
      node("gate", "approval_gate", { message: "Check" })
    ]);
    gated.nodes.push(node("out", "output"));
    gated.edges.push({ id: "e9", source: "gate", sourceHandle: "approved", target: "out" });
    const h = harness([gated]);
    const first = await executeWorkflow({ workflow: caller("wf-parent", [{ id: "call", workflowId: "wf-gated" }]), executionId: "exec-1" }, h.dependencies);
    expect(first.status).toBe("waiting_approval");
    expect(h.reports).toEqual([]);

    const resumed = await resumeWorkflowExecution({ executionId: "exec-1", state: h.paused[0]!, decision: "approve", actedBy: "lead" }, h.dependencies);
    expect(resumed.status).toBe("success");
    expect(h.reports).toHaveLength(1);
    expect(modelsIn(h.reports[0]!)).toEqual(["wf-gated"]);
  });

  it("refuses a new child when admitSubWorkflow throws, sync and async, and does not ask again on resume", async () => {
    const asked: string[] = [];
    const h = harness([child("wf-child")], {
      admitSubWorkflow: async (workflow) => {
        asked.push(workflow.id);
        throw new Error("Budget \"Cap\" exceeded for the current month.");
      }
    });
    const sync = await executeWorkflow({ workflow: caller("wf-parent", [{ id: "call", workflowId: "wf-child" }]) }, h.dependencies);
    expect(sync.status).toBe("error");
    expect(sync.nodeResults.find((entry) => entry.nodeId === "call")?.error).toContain('Budget "Cap" exceeded');
    const async = await executeWorkflow({ workflow: caller("wf-parent", [{ id: "call", workflowId: "wf-child", mode: "async" }]) }, h.dependencies);
    expect(async.nodeResults.find((entry) => entry.nodeId === "call")?.status).toBe("error");
    expect(asked).toEqual(["wf-child", "wf-child"]);
    expect(h.reports).toEqual([]);
  });

  it("does not ask admitSubWorkflow when a paused child resumes", async () => {
    const gated = chainWorkflow("wf-gated", [node("start", "sub_workflow_trigger"), node("gate", "approval_gate", { message: "Check" })]);
    gated.nodes.push(node("out", "output"));
    gated.edges.push({ id: "e9", source: "gate", sourceHandle: "approved", target: "out" });
    const asked: string[] = [];
    const h = harness([gated], { admitSubWorkflow: async (workflow) => void asked.push(workflow.id) });
    await executeWorkflow({ workflow: caller("wf-parent", [{ id: "call", workflowId: "wf-gated" }]), executionId: "exec-2" }, h.dependencies);
    expect(asked).toEqual(["wf-gated"]);
    const resumed = await resumeWorkflowExecution({ executionId: "exec-2", state: h.paused[0]!, decision: "approve", actedBy: "lead" }, h.dependencies);
    expect(resumed.status).toBe("success");
    expect(asked).toEqual(["wf-gated"]);
  });

  function agentParent(chatProvider = "caller"): Workflow {
    const parent = chainWorkflow(
      "wf-agent",
      [node("start", "webhook_input"), node("agent", "agent_orchestrator", { maxIterations: 3, toolCallingEnabled: true, userPromptTemplate: "go" }), node("out", "output")],
      [
        { source: "agent", sourceHandle: "chat_model", target: "chat" },
        { source: "agent", sourceHandle: "tool", target: "wtool" }
      ]
    );
    parent.nodes.push(node("chat", "llm_call", { provider: { providerId: chatProvider, model: "c" } }), node("wtool", "workflow_tool", { workflowId: "wf-tool-child" }));
    return parent;
  }
  const agentOutput = (result: Awaited<ReturnType<typeof executeWorkflow>>) =>
    result.nodeResults.find((entry) => entry.nodeId === "agent")?.output as
      | { steps?: Array<{ toolResults: Array<{ error?: string }> }>; _childTelemetry?: Array<{ model?: string }> }
      | undefined;

  it("refuses a Workflow Tool's child with a tool error", async () => {
    const refused = harness([child("wf-tool-child")], { admitSubWorkflow: async () => { throw new Error("Budget \"Cap\" exceeded for the current month."); } });
    const blocked = await executeWorkflow({ workflow: agentParent() }, refused.dependencies);
    const steps = agentOutput(blocked)?.steps ?? [];
    expect(steps.flatMap((step) => step.toolResults).map((entry) => entry.error).join(" ")).toContain('Budget "Cap" exceeded');
  });

  it("reports a Workflow Tool's child through the hook, and not again in the agent's _childTelemetry", async () => {
    const asked: string[] = [];
    const h = harness([child("wf-tool-child")], {
      admitSubWorkflow: async (workflow, request) => {
        asked.push(`${workflow.id}:${request.mode}`);
      }
    });
    const ran = await executeWorkflow({ workflow: agentParent() }, h.dependencies);
    expect(ran.status).toBe("success");
    expect(asked).toEqual(["wf-tool-child:tool"]);
    expect(h.reports.map((usage) => [usage.workflowId, usage.mode, modelsIn(usage)])).toEqual([["wf-tool-child", "tool", ["wf-tool-child"]]]);
    expect(agentOutput(ran)?._childTelemetry).toBeUndefined();
  });

  it("keeps counting a Workflow Tool's child in the agent's _childTelemetry for a host without the hook", async () => {
    const h = harness([child("wf-tool-child")], { onSubWorkflowUsage: undefined });
    const ran = await executeWorkflow({ workflow: agentParent() }, h.dependencies);
    expect(agentOutput(ran)?._childTelemetry?.map((blob) => blob.model)).toEqual(["wf-tool-child"]);
  });

  it("reports a Workflow Tool's child even when the agent node then stops without an output", async () => {
    const stop = new AbortController();
    const h = harness([child("wf-tool-child")], { abortSignal: stop.signal });
    h.providerRegistry.register(new StopsAfterToolModel(stop));
    const ran = await executeWorkflow({ workflow: agentParent("stopping") }, h.dependencies);
    expect(ran.status).toBe("canceled");
    expect(agentOutput(ran)).toBeUndefined();
    expect(h.reports.map((usage) => usage.workflowId)).toEqual(["wf-tool-child"]);
  });

  it("settles each admission after its usage is reported, and passes the caller's admission to a grandchild", async () => {
    const events: string[] = [];
    let next = 0;
    const admissions = new Map<object, string>();
    const middle = chainWorkflow("wf-middle", [node("start", "sub_workflow_trigger"), node("call", "execute_workflow", { workflowId: "wf-leaf" }), node("out", "output")]);
    const h = harness([child("wf-leaf"), middle], {
      admitSubWorkflow: async (workflow, request) => {
        const id = `${workflow.id}#${(next += 1)}`;
        events.push(`admit ${id} ${request.mode} parent=${request.parent ? admissions.get(request.parent) : "none"}`);
        const admission = { settle: () => void events.push(`settle ${id}`) };
        admissions.set(admission, id);
        return admission;
      },
      onSubWorkflowUsage: (usage) => void events.push(`report ${usage.workflowId}`)
    });
    await executeWorkflow({ workflow: caller("wf-top", [{ id: "call", workflowId: "wf-middle" }]) }, h.dependencies);
    expect(events).toEqual([
      "admit wf-middle#1 sync parent=none",
      "admit wf-leaf#2 sync parent=wf-middle#1",
      "report wf-leaf",
      "settle wf-leaf#2",
      "settle wf-middle#1"
    ]);
  });

  it("settles an async child's admission when the child ends", async () => {
    const events: string[] = [];
    const h = harness([child("wf-child")], {
      admitSubWorkflow: async (_workflow, request) => {
        events.push(`admit ${request.mode}`);
        return { settle: () => void events.push("settle") };
      },
      onSubWorkflowUsage: (usage) => void events.push(`report ${usage.mode}`)
    });
    await executeWorkflow({ workflow: caller("wf-parent", [{ id: "call", workflowId: "wf-child", mode: "async" }]) }, h.dependencies);
    await waitFor(() => events.includes("settle"));
    expect(events).toEqual(["admit async", "report async", "settle"]);
  });
});
