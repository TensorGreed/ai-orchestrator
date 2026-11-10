/**
 * Each model call's usage is counted once: a node's output keeps only the `_telemetry` it made itself (pass-through
 * nodes do not repeat their parents' usage), and a streamed LLM Call that fails, is cancelled or times out reports an
 * estimate through `onUnrecordedModelUsage`.
 */
import { describe, expect, it } from "vitest";
import { DefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry, type LLMProviderAdapter, type LLMStreamChunk, type ProviderCallRequest, type ProviderExecutionContext } from "@ai-orchestrator/provider-sdk";
import type { Workflow, WorkflowEdge, WorkflowExecutionResult, WorkflowExecutionState, WorkflowNode } from "@ai-orchestrator/shared";
import { IN_PROCESS_CODE_SANDBOX } from "./code-sandbox";
import { executeWorkflow, resumeWorkflowExecution, type WorkflowExecutionDependencies } from "./executor";

function node(id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], name: id, position: { x: 0, y: 0 }, config };
}

function chain(nodes: WorkflowNode[], extraEdges: Array<Omit<WorkflowEdge, "id">> = []): Workflow {
  const edges = [...nodes.slice(1).map((entry, index) => ({ source: nodes[index]!.id, target: entry.id })), ...extraEdges];
  return { id: "wf-usage", name: "Usage", schemaVersion: "1.0.0", workflowVersion: 1, nodes, edges: edges.map((edge, index) => ({ id: `e${index}`, ...edge })) };
}

/** Answers with fixed usage, so two calls make identical blobs. */
class MeteredModel implements LLMProviderAdapter {
  readonly definition = { id: "metered", label: "Metered", supportsTools: false, configSchema: {} };
  async generate(_request: ProviderCallRequest) {
    return { content: "ok", toolCalls: [], usage: { inputTokens: 70, outputTokens: 30, totalTokens: 100 }, latencyMs: 5 };
  }
}

type StreamPlan = "fail_midway" | "refused" | "usage_then_fail" | "hang" | "complete";

/** A streaming model whose stream behaves as `plan` says. */
class StreamingModel implements LLMProviderAdapter {
  readonly definition = { id: "streaming", label: "Streaming", supportsTools: false, configSchema: {} };
  constructor(private readonly plan: StreamPlan, private readonly onHang?: () => void) {}
  async generate() {
    return { content: "unused", toolCalls: [] };
  }
  async *generateStream(_request: ProviderCallRequest, context: ProviderExecutionContext): AsyncGenerator<LLMStreamChunk> {
    if (this.plan === "refused") {
      throw Object.assign(new Error("Provider streaming request failed (429): rate limited"), { statusCode: 429 });
    }
    yield { type: "text_delta", textDelta: "The first part of a long answer " };
    if (this.plan === "complete") {
      yield { type: "text_delta", textDelta: "ends here." };
      return;
    }
    if (this.plan === "usage_then_fail") {
      yield { type: "usage", usage: { inputTokens: 40, outputTokens: 12, totalTokens: 52 } };
      throw new Error("The connection was reset.");
    }
    if (this.plan === "hang") {
      this.onHang?.();
      await new Promise<void>((_, reject) => {
        const fail = () => reject(context?.signal?.reason ?? new Error("aborted"));
        if (context?.signal?.aborted) fail();
        context?.signal?.addEventListener("abort", fail, { once: true });
      });
    }
    throw new Error("The stream broke off.");
  }
}

function deps(extra: Partial<WorkflowExecutionDependencies> = {}, ...adapters: LLMProviderAdapter[]): WorkflowExecutionDependencies {
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(new MeteredModel());
  for (const adapter of adapters) providerRegistry.register(adapter);
  return {
    providerRegistry,
    connectorRegistry: createDefaultConnectorRegistry(),
    mcpRegistry: createDefaultMCPRegistry(),
    agentRuntime: new DefaultAgentRuntime(),
    resolveSecret: async () => undefined,
    ...extra
  };
}

const model = (id: string, providerId = "metered") =>
  node(id, "llm_call", { provider: { providerId, model: `${providerId}-model` }, userPromptTemplate: "Write a short note about usage.", retry: { enabled: false, maxAttempts: 1, delayMs: 1 } });

/** The usage blobs a host counts: each node result's top-level `_telemetry`. */
function usageBlobs(result: WorkflowExecutionResult): Array<{ nodeId: string; telemetry: unknown }> {
  return result.nodeResults
    .map((entry) => ({ nodeId: entry.nodeId, telemetry: (entry.output as Record<string, unknown> | undefined)?._telemetry }))
    .filter((entry) => entry.telemetry !== undefined);
}

describe("model usage is counted on the node that made the call", () => {
  it("does not repeat a model call's usage on the If, Filter and No-op nodes after it", async () => {
    const result = await executeWorkflow(
      {
        workflow: chain([
          node("start", "manual_trigger"),
          model("model"),
          node("check", "if_node", { condition: "true" }),
          node("pass", "noop_node"),
          node("keep", "filter_node", {}),
          node("out", "output")
        ])
      },
      deps()
    );
    expect(result.error ?? result.status).toBe("success");
    expect(usageBlobs(result).map((entry) => entry.nodeId)).toEqual(["model"]);
    // The pass-through nodes still pass the rest of their input on.
    expect((result.nodeResults.find((entry) => entry.nodeId === "pass")?.output as Record<string, unknown>).answer).toBe("ok");
  });

  it("does not repeat it on a disabled node", async () => {
    const disabled = { ...node("skip", "set_node", { assignments: [{ key: "draft", valueTemplate: "{{answer}}" }] }), disabled: true };
    const result = await executeWorkflow({ workflow: chain([node("start", "manual_trigger"), model("model"), disabled, node("out", "output")]) }, deps());
    expect(result.error ?? result.status).toBe("success");
    expect(usageBlobs(result).map((entry) => entry.nodeId)).toEqual(["model"]);
  });

  it("does not repeat it on an Approval Gate after the approval resumes the run", async () => {
    const paused: WorkflowExecutionState[] = [];
    const dependencies = deps({ persistPausedExecution: async (state) => void paused.push(state.state) });
    const workflow = chain([node("start", "manual_trigger"), model("model"), node("gate", "approval_gate", { message: "Check" })]);
    workflow.nodes.push(node("out", "output"));
    workflow.edges.push({ id: "e9", source: "gate", sourceHandle: "approved", target: "out" });
    const first = await executeWorkflow({ workflow, executionId: "exec-gate" }, dependencies);
    expect(first.status).toBe("waiting_approval");
    const resumed = await resumeWorkflowExecution({ executionId: "exec-gate", state: paused[0]!, decision: "approve", actedBy: "lead" }, dependencies);
    expect(resumed.status).toBe("success");
    expect(usageBlobs(resumed).map((entry) => entry.nodeId)).toEqual(["model"]);
    // The gate still passes its input on.
    expect((resumed.nodeResults.find((entry) => entry.nodeId === "gate")?.output as Record<string, unknown>).answer).toBe("ok");
  });

  it("does not repeat it on a Code node that returns its input", async () => {
    const result = await executeWorkflow(
      { workflow: chain([node("start", "manual_trigger"), model("model"), node("code", "code_node", { code: "return input;" }), node("out", "output")]) },
      deps({ codeSandbox: IN_PROCESS_CODE_SANDBOX })
    );
    expect(result.error ?? result.status).toBe("success");
    const output = result.nodeResults.find((entry) => entry.nodeId === "code")?.output as Record<string, unknown>;
    expect(JSON.stringify(output)).toContain('"answer":"ok"');
    expect(output).not.toHaveProperty("_telemetry");
    expect(usageBlobs(result).map((entry) => entry.nodeId)).toEqual(["model"]);
  });

  it("keeps two model calls that made identical usage", async () => {
    const result = await executeWorkflow({ workflow: chain([node("start", "manual_trigger"), model("first"), model("second"), node("out", "output")]) }, deps());
    expect(result.status).toBe("success");
    const blobs = usageBlobs(result);
    expect(blobs.map((entry) => entry.nodeId)).toEqual(["first", "second"]);
    expect(blobs[0]!.telemetry).toEqual(blobs[1]!.telemetry);
  });

  it("does not count pinned data's usage (no model call was made)", async () => {
    const pinned = { answer: "pinned", _telemetry: { providerId: "metered", model: "metered-model", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } } };
    const result = await executeWorkflow(
      { workflow: chain([node("start", "manual_trigger"), model("model"), node("out", "output")]), usePinnedData: true, pinnedData: { model: pinned } },
      deps()
    );
    expect(result.status).toBe("success");
    expect(usageBlobs(result)).toEqual([]);
    expect((result.nodeResults.find((entry) => entry.nodeId === "model")?.output as Record<string, unknown>).answer).toBe("pinned");
  });
});

describe("a streamed LLM Call that does not finish", () => {
  async function runStream(plan: StreamPlan, extra: Partial<WorkflowExecutionDependencies> = {}, onHang?: () => void) {
    const reported: Array<Record<string, unknown>> = [];
    const result = await executeWorkflow(
      { workflow: chain([node("start", "manual_trigger"), model("model", "streaming"), node("out", "output")]) },
      deps(
        {
          onLLMDelta: async () => undefined,
          onUnrecordedModelUsage: (telemetry) => void reported.push(telemetry),
          ...extra
        },
        new StreamingModel(plan, onHang)
      )
    );
    return { result, reported };
  }

  it("reports an estimate of the prompt and the partial answer when the stream fails midway", async () => {
    const { result, reported } = await runStream("fail_midway");
    expect(result.status).toBe("error");
    expect(reported).toHaveLength(1);
    const blob = reported[0] as { providerId: string; model: string; usage: { inputTokens: number; outputTokens: number; totalTokens: number }; usageEstimated?: boolean; callFailed?: boolean; llmCallCount?: number };
    expect(blob).toMatchObject({ providerId: "streaming", model: "streaming-model", usageEstimated: true, callFailed: true, llmCallCount: 1 });
    expect(blob.usage.inputTokens).toBeGreaterThan(0);
    expect(blob.usage.outputTokens).toBeGreaterThan(0);
    expect(blob.usage.totalTokens).toBe(blob.usage.inputTokens + blob.usage.outputTokens);
    // The failed node's result carries no usage (it is reported once, through the hook).
    expect(usageBlobs(result)).toEqual([]);
  });

  it("uses the usage frame the provider sent before the stream failed", async () => {
    const { reported } = await runStream("usage_then_fail");
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ usage: { inputTokens: 40, outputTokens: 12, totalTokens: 52 } });
    expect(reported[0]!.usageEstimated).toBeUndefined();
  });

  it("reports an estimate when the run is cancelled or times out while the model answers", async () => {
    const controller = new AbortController();
    const { result, reported } = await runStream("hang", { abortSignal: controller.signal }, () => controller.abort(new Error("Workflow exceeded the 50ms execution timeout.")));
    expect(result.status).not.toBe("success");
    expect(reported).toHaveLength(1);
    expect((reported[0] as { usage: { inputTokens: number } }).usage.inputTokens).toBeGreaterThan(0);
  });

  it("reports nothing for a request the provider refused before answering", async () => {
    const { result, reported } = await runStream("refused");
    expect(result.status).toBe("error");
    expect(reported).toEqual([]);
  });

  it("reports nothing for a stream that finishes (its node output carries the usage)", async () => {
    const { result, reported } = await runStream("complete");
    expect(result.status).toBe("success");
    expect(reported).toEqual([]);
    expect(usageBlobs(result).map((entry) => entry.nodeId)).toEqual(["model"]);
  });

  it("a host that throws from the hook does not change the node's error", async () => {
    const { result } = await runStream("fail_midway", {
      onUnrecordedModelUsage: () => {
        throw new Error("store down");
      }
    });
    expect(result.status).toBe("error");
    expect(JSON.stringify(result.error ?? result.nodeResults)).toContain("The stream broke off.");
  });

  it("counts each attempt of a retried node", async () => {
    const reported: Array<Record<string, unknown>> = [];
    const retried = { ...model("model", "streaming"), config: { ...model("model", "streaming").config, retry: { enabled: true, maxAttempts: 2, delayMs: 1 } } };
    const result = await executeWorkflow(
      { workflow: chain([node("start", "manual_trigger"), retried, node("out", "output")]) },
      deps({ onLLMDelta: async () => undefined, onUnrecordedModelUsage: (telemetry) => void reported.push(telemetry) }, new StreamingModel("fail_midway"))
    );
    expect(result.status).toBe("error");
    expect(reported).toHaveLength(2);
  });
});
