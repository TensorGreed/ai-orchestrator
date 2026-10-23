import { describe, expect, it } from "vitest";
import type { LLMCallResponse } from "@ai-orchestrator/shared";
import {
  createModelTapeRecordingRegistry,
  createModelTapeReplayRegistry,
  hashModelRequest,
  modelTapeRequest,
  ModelTapeMissError,
  ModelTapeRecorder
} from "./model-tape";
import { ProviderRegistry } from "./registry";
import type { LLMProviderAdapter, ProviderCallRequest, ProviderExecutionContext } from "./types";

const SECRET = "sk-live-TAPE-secret-0123456789abcdef";

/** A fake provider that answers with a counter and counts its calls. */
function fakeProvider(id = "openai") {
  const calls: ProviderCallRequest[] = [];
  const adapter: LLMProviderAdapter = {
    definition: { id, label: id, supportsTools: true, configSchema: {} },
    async generate(request) {
      calls.push(request);
      const last = request.messages[request.messages.length - 1]?.content ?? "";
      return { content: `answer ${calls.length} to ${last}`, toolCalls: [], usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }, latencyMs: 5 } satisfies LLMCallResponse;
    },
    async *generateStream(request) {
      calls.push(request);
      yield { type: "text_delta", textDelta: "streamed " };
      yield { type: "text_delta", textDelta: "answer" };
      yield { type: "tool_call_delta", toolCallId: "t1", name: "lookup", argumentsDelta: '{"q":' };
      yield { type: "tool_call_delta", toolCallId: "t1", argumentsDelta: '"x"}' };
    }
  };
  const registry = new ProviderRegistry();
  registry.register(adapter);
  return { registry, calls };
}

const request = (content: string, overrides: Partial<ProviderCallRequest["provider"]> = {}): ProviderCallRequest => ({
  provider: { providerId: "openai", model: "gpt-4o-mini", secretRef: { secretId: "key" }, baseUrl: "https://api.example.com", temperature: 0, ...overrides },
  messages: [
    { role: "system", content: "Be brief." },
    { role: "user", content }
  ]
});

const context = (nodeId: string, iteration?: number): ProviderExecutionContext => ({
  resolveSecret: async () => SECRET,
  callSite: { nodeId, ...(iteration !== undefined ? { iteration } : {}) }
});

async function record(run: (registry: ProviderRegistry) => Promise<void>) {
  const live = fakeProvider();
  const recorder = new ModelTapeRecorder();
  await run(createModelTapeRecordingRegistry(live.registry, recorder));
  return { tape: recorder.toTape(), live };
}

describe("model tape", () => {
  it("records calls with their call site and answers them in order without calling the model", async () => {
    const { tape } = await record(async (registry) => {
      await registry.get("openai").generate(request("hi"), context("agent_1", 0));
      await registry.get("openai").generate(request("hi"), context("agent_1", 0));
      await registry.get("openai").generate(request("next"), context("agent_1", 1));
    });
    expect(tape.entries.map((entry) => [entry.nodeId, entry.iteration, entry.providerId, entry.model])).toEqual([
      ["agent_1", 0, "openai", "gpt-4o-mini"],
      ["agent_1", 0, "openai", "gpt-4o-mini"],
      ["agent_1", 1, "openai", "gpt-4o-mini"]
    ]);

    const live = fakeProvider();
    const { registry, player } = createModelTapeReplayRegistry(tape, { mode: "strict", live: live.registry });
    expect((await registry.get("openai").generate(request("next"), context("agent_1", 1))).content).toBe("answer 3 to next");
    expect((await registry.get("openai").generate(request("hi"), context("agent_1", 0))).content).toBe("answer 1 to hi");
    expect((await registry.get("openai").generate(request("hi"), context("agent_1", 0))).content).toBe("answer 2 to hi");
    expect(live.calls).toHaveLength(0);
    expect(player.report()).toMatchObject({ matched: 3, reused: 0, live: 0, unmatched: [] });
  });

  it("never keeps or hashes the credential, and ignores the endpoint", async () => {
    const { tape } = await record(async (registry) => {
      await registry.get("openai").generate(request(`my key is ${SECRET}`), context("llm"));
    });
    expect(JSON.stringify(tape)).not.toContain(SECRET);
    expect(JSON.stringify(tape)).not.toContain("api.example.com");
    // The same request at another endpoint matches.
    const { registry } = createModelTapeReplayRegistry(tape);
    await expect(registry.get("openai").generate(request(`my key is ${SECRET}`, { baseUrl: "https://other.example.com" }), context("llm"))).resolves.toMatchObject({ content: expect.stringContaining("answer 1") });
  });

  it("keeps the key stable across key order and shifts it on any upstream change", () => {
    const a = hashModelRequest(modelTapeRequest(request("hi")));
    const reordered = hashModelRequest(modelTapeRequest({ ...request("hi"), provider: { temperature: 0, model: "gpt-4o-mini", providerId: "openai" } }));
    expect(reordered).toBe(a);
    expect(hashModelRequest(modelTapeRequest(request("hi!")))).not.toBe(a);
    expect(hashModelRequest(modelTapeRequest(request("hi", { temperature: 0.5 })))).not.toBe(a);
    expect(hashModelRequest(modelTapeRequest({ ...request("hi"), tools: [{ name: "lookup", description: "x", inputSchema: {} }] }))).not.toBe(a);
  });

  it("fails a strict miss with the reason, and does not call the model", async () => {
    const { tape } = await record(async (registry) => {
      await registry.get("openai").generate(request("hi"), context("agent_1", 0));
    });
    const live = fakeProvider();
    const { registry, player } = createModelTapeReplayRegistry(tape, { mode: "strict", live: live.registry });
    await expect(registry.get("openai").generate(request("changed prompt"), context("agent_1", 0))).rejects.toThrow(ModelTapeMissError);
    await expect(registry.get("openai").generate(request("hi", { model: "gpt-5" }), context("agent_1", 0))).rejects.toThrow(/called openai\/gpt-4o-mini/);
    await registry.get("openai").generate(request("hi"), context("agent_1", 0));
    await expect(registry.get("openai").generate(request("hi"), context("agent_1", 0))).rejects.toThrow(/more often than the golden run recorded/);
    await expect(registry.get("openai").generate(request("hi"), context("agent_9", 0))).rejects.toThrow(/no model call at node agent_9/);
    expect(live.calls).toHaveLength(0);
    expect(player.report().unmatched).toHaveLength(4);
  });

  it("falls back to the live model in lenient mode, and reuses an exhausted answer", async () => {
    const { tape } = await record(async (registry) => {
      await registry.get("openai").generate(request("hi"), context("agent_1", 0));
    });
    const live = fakeProvider();
    const { registry, player } = createModelTapeReplayRegistry(tape, { mode: "lenient", live: live.registry });
    expect((await registry.get("openai").generate(request("hi"), context("agent_1", 0))).content).toBe("answer 1 to hi");
    expect((await registry.get("openai").generate(request("hi"), context("agent_1", 0))).content).toBe("answer 1 to hi");
    expect((await registry.get("openai").generate(request("new"), context("agent_1", 0))).content).toBe("answer 1 to new");
    expect(live.calls).toHaveLength(1);
    expect(player.report()).toMatchObject({ matched: 1, reused: 1, live: 1, unmatched: [] });
    // Only the live call is reported with its usage, so only it is priced.
    expect(player.report().liveCalls).toEqual([{ nodeId: "agent_1", iteration: 0, providerId: "openai", model: expect.any(String), inputTokens: 10, outputTokens: 2, cachedInputTokens: null }]);
  });

  it("records a stream as its answer, and replays it for both kinds of call", async () => {
    const { tape } = await record(async (registry) => {
      const chunks = [];
      for await (const chunk of registry.get("openai").generateStream!(request("hi"), context("llm"))) chunks.push(chunk);
      expect(chunks).toHaveLength(4);
    });
    expect(tape.entries[0]).toMatchObject({ streamed: true, response: { content: "streamed answer", toolCalls: [{ id: "t1", name: "lookup", arguments: { q: "x" } }] } });
    const { registry } = createModelTapeReplayRegistry(tape, { mode: "lenient" });
    expect((await registry.get("openai").generate(request("hi"), context("llm"))).toolCalls[0]?.arguments).toEqual({ q: "x" });
    const replayed = [];
    for await (const chunk of registry.get("openai").generateStream!(request("hi"), context("llm"))) replayed.push(chunk);
    expect(replayed[0]).toEqual({ type: "text_delta", textDelta: "streamed answer" });
  });

  it("replays a recorded error, and stops recording at the size limit", async () => {
    const failing = new ProviderRegistry();
    failing.register({
      definition: { id: "openai", label: "x", supportsTools: false, configSchema: {} },
      async generate() {
        throw new Error(`upstream 500 for ${SECRET}`);
      }
    });
    const recorder = new ModelTapeRecorder();
    await expect(createModelTapeRecordingRegistry(failing, recorder).get("openai").generate(request("hi"), context("llm"))).rejects.toThrow();
    const tape = recorder.toTape();
    expect(tape.entries[0]!.error).toBe("upstream 500 for [REDACTED]");
    await expect(createModelTapeReplayRegistry(tape).registry.get("openai").generate(request("hi"), context("llm"))).rejects.toThrow("upstream 500 for [REDACTED]");

    const small = new ModelTapeRecorder({ maxBytes: 600 });
    const registry = createModelTapeRecordingRegistry(fakeProvider().registry, small);
    for (let index = 0; index < 5; index += 1) await registry.get("openai").generate(request(`call ${index}`), context("llm"));
    expect(small.toTape().truncated).toBe(true);
    expect(small.callCount).toBeLessThan(5);
  });
});
