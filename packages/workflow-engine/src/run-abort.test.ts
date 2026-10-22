import { describe, expect, it } from "vitest";
import { createDefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import {
  ProviderRegistry,
  type LLMProviderAdapter,
  type ProviderCallRequest,
  type ProviderExecutionContext
} from "@ai-orchestrator/provider-sdk";
import { ErrorCategory, WorkflowError, type LLMCallResponse, type Workflow } from "@ai-orchestrator/shared";
import { executeWorkflow, type WorkflowExecutionDependencies } from "./executor";

/** A model call that never answers on its own: it ends only when the run's signal aborts. */
class HangingProvider implements LLMProviderAdapter {
  readonly definition = { id: "hanging", label: "Hanging", supportsTools: true, configSchema: {} };
  started = 0;

  generate(_request: ProviderCallRequest, context: ProviderExecutionContext): Promise<LLMCallResponse> {
    this.started += 1;
    return new Promise((_, reject) => {
      if (!context.signal) return;
      context.signal.addEventListener("abort", () => reject(new Error("provider request aborted")), { once: true });
    });
  }
}

/** Answers after a delay, ignoring the signal (like a node that cannot be interrupted). */
class SlowProvider implements LLMProviderAdapter {
  readonly definition = { id: "slow", label: "Slow", supportsTools: false, configSchema: {} };

  async generate(): Promise<LLMCallResponse> {
    await new Promise((resolve) => setTimeout(resolve, 40));
    return { content: "done", toolCalls: [] };
  }
}

function llmWorkflow(providerId: string): Workflow {
  return {
    id: "wf-llm-abort",
    name: "LLM abort",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      { id: "input", type: "text_input", name: "Input", position: { x: 0, y: 0 }, config: { text: "hello" } },
      { id: "llm", type: "llm_call", name: "LLM", position: { x: 200, y: 0 }, config: { provider: { providerId, model: "m" } } },
      { id: "output", type: "output", name: "Output", position: { x: 400, y: 0 }, config: { responseTemplate: "{{answer}}" } }
    ],
    edges: [
      { id: "e1", source: "input", target: "llm" },
      { id: "e2", source: "llm", target: "output" }
    ]
  };
}

function agentWorkflow(): Workflow {
  return {
    id: "wf-agent-abort",
    name: "Agent abort",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      { id: "webhook", type: "webhook_input", name: "Webhook", position: { x: 0, y: 0 }, config: {} },
      {
        id: "agent",
        type: "agent_orchestrator",
        name: "Agent",
        position: { x: 220, y: 0 },
        config: { systemPromptTemplate: "{{system_prompt}}", userPromptTemplate: "{{user_prompt}}", maxIterations: 3 }
      },
      { id: "model", type: "llm_call", name: "Model", position: { x: 220, y: 180 }, config: { provider: { providerId: "hanging", model: "m" } } },
      { id: "output", type: "output", name: "Output", position: { x: 430, y: 0 }, config: { responseTemplate: "{{answer}}" } }
    ],
    edges: [
      { id: "e1", source: "webhook", target: "agent" },
      { id: "e2", source: "agent", target: "output" },
      { id: "e3", source: "agent", sourceHandle: "chat_model", target: "model" }
    ]
  };
}

function dependencies(signal: AbortSignal, completions: Array<{ nodeId: string; status: string; errorCategory?: string }>): WorkflowExecutionDependencies {
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(new HangingProvider());
  providerRegistry.register(new SlowProvider());
  return {
    providerRegistry,
    connectorRegistry: createDefaultConnectorRegistry(),
    mcpRegistry: createDefaultMCPRegistry(),
    agentRuntime: createDefaultAgentRuntime(),
    resolveSecret: async () => undefined,
    abortSignal: signal,
    onNodeComplete: (event) => {
      completions.push({ nodeId: event.nodeId, status: event.status, ...(event.errorCategory ? { errorCategory: event.errorCategory } : {}) });
    }
  };
}

const timeoutReason = (timeoutMs: number) =>
  WorkflowError.timeout(`Workflow exceeded the ${timeoutMs}ms execution timeout.`, { timeoutMs });

describe("run abort while a model call is in flight", () => {
  it("a user stop marks the running LLM node canceled", async () => {
    const controller = new AbortController();
    const completions: Array<{ nodeId: string; status: string }> = [];
    setTimeout(() => controller.abort("Execution canceled by builder@example.com"), 30);

    const result = await executeWorkflow({ workflow: llmWorkflow("hanging") }, dependencies(controller.signal, completions));

    expect(result.status).toBe("canceled");
    expect(result.error).toBe("Execution canceled by builder@example.com");
    const llm = result.nodeResults.find((entry) => entry.nodeId === "llm");
    expect(llm).toMatchObject({ status: "canceled", error: "Execution canceled by builder@example.com" });
    expect(llm?.errorCategory).toBeUndefined();
    expect(completions).toContainEqual({ nodeId: "llm", status: "canceled" });
  });

  it("the execution timeout fails the running LLM node with WORKFLOW_TIMEOUT and a remediation", async () => {
    const controller = new AbortController();
    const completions: Array<{ nodeId: string; status: string; errorCategory?: string }> = [];
    setTimeout(() => controller.abort(timeoutReason(1000)), 30);

    const result = await executeWorkflow(
      { workflow: llmWorkflow("hanging"), executionTimeoutMs: 1000 },
      dependencies(controller.signal, completions)
    );

    expect(result.status).toBe("error");
    expect(result.errorCategory).toBe(ErrorCategory.WORKFLOW_TIMEOUT);
    expect(result.errorRemediation).toContain("1000ms execution timeout");
    const llm = result.nodeResults.find((entry) => entry.nodeId === "llm");
    expect(llm).toMatchObject({
      status: "error",
      error: "Workflow exceeded the 1000ms execution timeout.",
      errorCategory: ErrorCategory.WORKFLOW_TIMEOUT,
      retryable: false
    });
    expect(llm?.errorRemediation).toContain("WORKFLOW_EXECUTION_TIMEOUT_MS");
    expect(result.nodeResults.find((entry) => entry.nodeId === "output")).toMatchObject({
      status: "skipped",
      output: { reason: "execution_timeout" }
    });
    expect(completions).toContainEqual({ nodeId: "llm", status: "error", errorCategory: ErrorCategory.WORKFLOW_TIMEOUT });
  });

  it("the execution timeout interrupts an agent's model call and fails the agent node", async () => {
    const controller = new AbortController();
    const completions: Array<{ nodeId: string; status: string; errorCategory?: string }> = [];
    setTimeout(() => controller.abort(timeoutReason(2000)), 30);

    const startedAt = Date.now();
    const result = await executeWorkflow(
      { workflow: agentWorkflow(), executionTimeoutMs: 2000, webhookPayload: { user_prompt: "hi", system_prompt: "be brief" } },
      dependencies(controller.signal, completions)
    );

    // Neither the agent's model retries nor its graceful fallback kept it running.
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(result.status).toBe("error");
    const agent = result.nodeResults.find((entry) => entry.nodeId === "agent");
    expect(agent).toMatchObject({ status: "error", errorCategory: ErrorCategory.WORKFLOW_TIMEOUT });
    expect(agent?.errorRemediation).toContain("2000ms execution timeout");
  });

  it("the between-node timeout check also reports WORKFLOW_TIMEOUT with a remediation", async () => {
    const completions: Array<{ nodeId: string; status: string }> = [];
    const workflow = llmWorkflow("slow");
    const result = await executeWorkflow(
      { workflow, executionTimeoutMs: 10 },
      dependencies(new AbortController().signal, completions)
    );

    expect(result.status).toBe("error");
    expect(result.error).toMatch(/Workflow execution timed out after \d+ms \(limit: 10ms\)/);
    expect(result.errorCategory).toBe(ErrorCategory.WORKFLOW_TIMEOUT);
    expect(result.errorRemediation).toContain("10ms execution timeout");
    expect(result.nodeResults.find((entry) => entry.nodeId === "output")).toMatchObject({
      status: "skipped",
      output: { reason: "execution_timeout" }
    });
  });
});
