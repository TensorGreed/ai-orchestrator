import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "./registry";
import { createMeteredProviderRegistry, type MeteredModelCall } from "./metered-registry";
import type { LLMProviderAdapter, LLMStreamChunk } from "./types";

function fakeAdapter(fail = false): LLMProviderAdapter {
  return {
    definition: { id: "fake", label: "Fake", supportsTools: true, configSchema: {} } as never,
    generate: async () => {
      if (fail) throw new Error("401 bad key");
      return { content: "hi", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } as never;
    },
    generateStream: async function* (): AsyncGenerator<LLMStreamChunk> {
      yield { type: "text_delta", textDelta: "h" };
      yield { type: "usage", usage: { inputTokens: 3, outputTokens: 2 } };
    }
  };
}

describe("metered provider registry", () => {
  it("reports each answered call's usage with the model it was sent, and nothing for a failed call", async () => {
    const base = new ProviderRegistry();
    base.register(fakeAdapter());
    const calls: MeteredModelCall[] = [];
    const metered = createMeteredProviderRegistry(base, (call) => calls.push(call));
    const adapter = metered.get("fake");
    expect(metered.get("fake")).toBe(adapter);
    const answer = await adapter.generate({ provider: { providerId: "fake", model: "m-1" }, messages: [] } as never, {} as never);
    expect(answer.content).toBe("hi");
    const chunks: LLMStreamChunk[] = [];
    for await (const chunk of adapter.generateStream!({ provider: { providerId: "fake", model: "m-2" }, messages: [] } as never, {} as never)) chunks.push(chunk);
    expect(chunks).toHaveLength(2);
    expect(calls).toEqual([
      { providerId: "fake", model: "m-1", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, estimated: false },
      { providerId: "fake", model: "m-2", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 }, estimated: false }
    ]);

    const failing = new ProviderRegistry();
    failing.register(fakeAdapter(true));
    const none: MeteredModelCall[] = [];
    await expect(
      createMeteredProviderRegistry(failing, (call) => none.push(call)).get("fake").generate({ provider: { providerId: "fake", model: "m" }, messages: [] } as never, {} as never)
    ).rejects.toThrow("401");
    expect(none).toEqual([]);
    expect(metered.tryGet("missing")).toBeUndefined();
  });

  it("estimates the usage of a call whose provider reports none, as runs are charged", async () => {
    const base = new ProviderRegistry();
    base.register({
      definition: { id: "quiet", label: "Quiet", supportsTools: true, configSchema: {} } as never,
      generate: async () => ({ content: "a fairly long answer with no usage at all", toolCalls: [] }) as never,
      generateStream: async function* (): AsyncGenerator<LLMStreamChunk> {
        yield { type: "text_delta", textDelta: "streamed words without usage" };
      }
    });
    const calls: MeteredModelCall[] = [];
    const adapter = createMeteredProviderRegistry(base, (call) => calls.push(call)).get("quiet");
    const request = { provider: { providerId: "quiet", model: "q" }, messages: [{ role: "user", content: "describe a workflow" }] } as never;
    await adapter.generate(request, {} as never);
    for await (const _chunk of adapter.generateStream!(request, {} as never)) void _chunk;
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.estimated).toBe(true);
      expect(call.usage.inputTokens).toBeGreaterThan(0);
      expect(call.usage.outputTokens).toBeGreaterThan(0);
    }
  });
});
