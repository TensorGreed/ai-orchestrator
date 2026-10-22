import { describe, expect, it } from "vitest";
import {
  ProviderRegistry,
  type LLMProviderAdapter,
  type ProviderCallRequest,
  type ProviderExecutionContext
} from "@ai-orchestrator/provider-sdk";
import type { LLMCallResponse } from "@ai-orchestrator/shared";
import { DefaultAgentRuntime } from "./default-agent-runtime";

/** A model call that never answers: it only ends when the run's signal aborts. */
class HangingProvider implements LLMProviderAdapter {
  readonly definition = { id: "hanging", label: "Hanging", supportsTools: true, configSchema: {} };
  calls = 0;
  receivedSignal: AbortSignal | undefined;

  generate(_request: ProviderCallRequest, context: ProviderExecutionContext): Promise<LLMCallResponse> {
    this.calls += 1;
    this.receivedSignal = context.signal;
    return new Promise((_, reject) => {
      context.signal?.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
    });
  }
}

/** A model call that always fails with a transient error. */
class FailingProvider implements LLMProviderAdapter {
  readonly definition = { id: "failing", label: "Failing", supportsTools: true, configSchema: {} };
  calls = 0;

  async generate(): Promise<LLMCallResponse> {
    this.calls += 1;
    throw new Error("upstream 503");
  }
}

function runAgent(providerId: string, registry: ProviderRegistry, signal: AbortSignal) {
  return new DefaultAgentRuntime().run(
    {
      provider: { providerId, model: "m" },
      systemPrompt: "You are helpful",
      userPrompt: "hi",
      tools: [],
      maxIterations: 5,
      toolCallingEnabled: false
    },
    { tools: [], invokeTool: async () => ({}) },
    { providerRegistry: registry, resolveSecret: async () => undefined, signal }
  );
}

describe("DefaultAgentRuntime abort", () => {
  it("passes the signal to the model call and throws the abort reason instead of returning an error answer", async () => {
    const registry = new ProviderRegistry();
    const provider = new HangingProvider();
    registry.register(provider);
    const controller = new AbortController();
    const reason = new Error("Workflow exceeded the 1000ms execution timeout.");
    setTimeout(() => controller.abort(reason), 20);

    await expect(runAgent("hanging", registry, controller.signal)).rejects.toBe(reason);
    expect(provider.receivedSignal).toBe(controller.signal);
    // No retry of the aborted call.
    expect(provider.calls).toBe(1);
  });

  it("ends the retry backoff early when the run is stopped", async () => {
    const registry = new ProviderRegistry();
    const provider = new FailingProvider();
    registry.register(provider);
    const controller = new AbortController();
    // The first retry waits 2s; the stop lands during that wait.
    setTimeout(() => controller.abort("Execution canceled by builder@example.com"), 50);

    const startedAt = Date.now();
    await expect(runAgent("failing", registry, controller.signal)).rejects.toThrow("Execution canceled by builder@example.com");
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(provider.calls).toBe(1);
  });

  it("does not start when the signal is already aborted", async () => {
    const registry = new ProviderRegistry();
    const provider = new HangingProvider();
    registry.register(provider);
    const controller = new AbortController();
    controller.abort("stopped");
    await expect(runAgent("hanging", registry, controller.signal)).rejects.toThrow("stopped");
    expect(provider.calls).toBe(0);
  });
});
