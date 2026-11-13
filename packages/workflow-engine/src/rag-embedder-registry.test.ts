import { describe, expect, it } from "vitest";
import { EmbeddingProviderRegistry, type EmbeddingProviderAdapter, type EmbeddingRequest, type EmbeddingResponse, type ProviderExecutionContext } from "@ai-orchestrator/provider-sdk";
import { AzureOpenAIEmbeddingAdapter, OpenAIEmbeddingAdapter, TokenEmbeddingAdapter, registryEmbeddingAdapter, type EmbeddingAdapter } from "./rag-adapters";

/** A registry that records what goes through `embedWith`, then runs it as a plain registry does. */
class RecordingRegistry extends EmbeddingProviderRegistry {
  readonly calls: Array<{ adapterId: string; request: EmbeddingRequest; context: ProviderExecutionContext }> = [];
  readonly responses: EmbeddingResponse[] = [];
  override async embedWith(adapter: EmbeddingProviderAdapter, request: EmbeddingRequest, context: ProviderExecutionContext) {
    this.calls.push({ adapterId: adapter.id, request, context });
    const response = await super.embedWith(adapter, request, context);
    this.responses.push(response);
    return response;
  }
}

const context: ProviderExecutionContext = { resolveSecret: async () => undefined, callSite: { nodeId: "rag" } };

function openAiAnswer(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("RAG and knowledge-base embedders through the embedding registry", () => {
  it("sends each call through registry.embedWith with the embedder's provider, model and endpoint, and keeps its transport", async () => {
    const sent: Array<{ url: string; init: RequestInit }> = [];
    const embedder = new OpenAIEmbeddingAdapter({
      apiKey: "k-1",
      baseUrl: "https://embed.example/v1",
      model: "emb-1",
      fetcher: async (url, init) => {
        sent.push({ url, init });
        return openAiAnswer({ data: [{ embedding: [1, 2] }], model: "emb-1-2026", usage: { prompt_tokens: 5, total_tokens: 5 } });
      }
    });
    const registry = new RecordingRegistry();
    const routed = registryEmbeddingAdapter(embedder, { registry, context: () => context });
    expect(routed.modelTarget).toEqual({ providerId: "openai", model: "emb-1" });
    expect(await routed.embed("hello")).toEqual([1, 2]);
    expect(registry.calls).toHaveLength(1);
    expect(registry.calls[0]).toMatchObject({ adapterId: "openai", request: { provider: { providerId: "openai", model: "emb-1", baseUrl: "https://embed.example/v1" }, input: ["hello"] }, context });
    // The embedder's own request: its URL, its key, the body it always sent.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://embed.example/v1/embeddings");
    expect((sent[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer k-1");
    expect(JSON.parse(String(sent[0]!.init.body))).toEqual({ model: "emb-1", input: "hello" });
  });

  it("reports the provider's usage and model to the registry, and the same vector from embed() as before", async () => {
    const embedder = new AzureOpenAIEmbeddingAdapter({
      endpoint: "https://azure.example/",
      deployment: "dep-1",
      apiKey: "k",
      fetcher: async () => openAiAnswer({ data: [{ embedding: [0.5] }], model: "text-embedding-3-small", usage: { prompt_tokens: 3, total_tokens: 3 } })
    });
    expect(await embedder.embedDetailed("x")).toEqual({ vector: [0.5], usage: { inputTokens: 3, totalTokens: 3 }, model: "text-embedding-3-small" });
    expect(await embedder.embed("x")).toEqual([0.5]);
    const registry = new RecordingRegistry();
    await registryEmbeddingAdapter(embedder, { registry, context: () => context }).embed("x");
    expect(registry.responses[0]).toMatchObject({ embeddings: [[0.5]], usage: { inputTokens: 3, totalTokens: 3 }, model: "text-embedding-3-small" });
  });

  it("runs the model allowlist check inside the call: a refusal sends nothing", async () => {
    let fetched = 0;
    const embedder = new OpenAIEmbeddingAdapter({ apiKey: "k", model: "emb-1", fetcher: async () => ((fetched += 1), openAiAnswer({ data: [{ embedding: [1] }] })) });
    const registry = new RecordingRegistry();
    const refusal = Object.assign(new Error("Model not allowed"), { name: "ModelNotAllowedError" });
    const routed = registryEmbeddingAdapter(embedder, {
      registry,
      context: () => context,
      check: async (target) => {
        if (target.model === "emb-1") throw refusal;
      }
    });
    await expect(routed.embed("hello")).rejects.toBe(refusal);
    expect(registry.calls).toHaveLength(1);
    expect(fetched).toBe(0);
  });

  it("leaves a local embedder (no model call) as it is, and uses embed() for an embedder that reports no usage", async () => {
    const registry = new RecordingRegistry();
    const local = new TokenEmbeddingAdapter();
    expect(registryEmbeddingAdapter(local, { registry, context: () => context })).toBe(local);
    const custom: EmbeddingAdapter = { id: "custom", modelTarget: { providerId: "acme", model: "m" }, embed: async () => [9] };
    expect(await registryEmbeddingAdapter(custom, { registry, context: () => context }).embed("t")).toEqual([9]);
    expect(registry.calls[0]!.request.provider).toEqual({ providerId: "acme", model: "m" });
  });
});
