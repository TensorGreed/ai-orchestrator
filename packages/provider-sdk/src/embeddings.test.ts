import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultEmbeddingRegistry, parseOpenAIEmbeddings } from "./embeddings";

const ctx = { resolveSecret: async () => "test-key" };

function stubFetch(...responses: Response[]) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      const next = responses.shift();
      if (!next) throw new Error("unexpected extra request");
      return next;
    })
  );
  return calls;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("embedding adapters", () => {
  it("covers the four OpenAI-shaped providers", () => {
    expect(createDefaultEmbeddingRegistry().ids().sort()).toEqual(["azure_openai", "ollama", "openai", "openai_compatible"]);
  });

  it("embeds a batch in input order with usage", async () => {
    const calls = stubFetch(
      json(200, {
        model: "text-embedding-3-small",
        data: [
          { index: 1, embedding: [0.3, 0.4] },
          { index: 0, embedding: [0.1, 0.2] }
        ],
        usage: { prompt_tokens: 6, total_tokens: 6 }
      })
    );
    const answer = await createDefaultEmbeddingRegistry()
      .get("openai")
      .embed({ provider: { providerId: "openai", model: "text-embedding-3-small" }, input: ["a", "b"], dimensions: 2, user: "u" }, ctx);
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/embeddings");
    expect(calls[0]!.headers.authorization).toBe("Bearer test-key");
    expect(calls[0]!.body).toEqual({ model: "text-embedding-3-small", input: ["a", "b"], encoding_format: "float", dimensions: 2, user: "u" });
    expect(answer.embeddings).toEqual([
      [0.1, 0.2],
      [0.3, 0.4]
    ]);
    expect(answer.usage).toEqual({ inputTokens: 6, totalTokens: 6 });
    expect(answer.model).toBe("text-embedding-3-small");
  });

  it("calls Azure's deployment path with the api-key header", async () => {
    const calls = stubFetch(json(200, { data: [{ index: 0, embedding: [1] }] }));
    await createDefaultEmbeddingRegistry()
      .get("azure_openai")
      .embed({ provider: { providerId: "azure_openai", model: "emb", baseUrl: "https://r.openai.azure.com/", extra: { apiVersion: "2024-10-21" } }, input: ["x"] }, ctx);
    expect(calls[0]!.url).toBe("https://r.openai.azure.com/openai/deployments/emb/embeddings?api-version=2024-10-21");
    expect(calls[0]!.headers["api-key"]).toBe("test-key");
    expect(calls[0]!.body.model).toBeUndefined();
  });

  it("ollama needs no key and openai_compatible needs a base URL", async () => {
    const calls = stubFetch(json(200, { data: [{ embedding: [2] }] }));
    await createDefaultEmbeddingRegistry()
      .get("ollama")
      .embed({ provider: { providerId: "ollama", model: "nomic-embed-text", baseUrl: "http://ollama.test/v1" }, input: ["x"] }, { resolveSecret: async () => undefined });
    expect(calls[0]!.url).toBe("http://ollama.test/v1/embeddings");
    await expect(
      createDefaultEmbeddingRegistry().get("openai_compatible").embed({ provider: { providerId: "openai_compatible", model: "m" }, input: ["x"] }, ctx)
    ).rejects.toThrow(/requires baseUrl/);
  });

  it("throws a provider error on a failed request and on a short answer", async () => {
    stubFetch(json(400, { error: { message: "bad" } }));
    await expect(
      createDefaultEmbeddingRegistry().get("openai").embed({ provider: { providerId: "openai", model: "m", extra: { maxRetries: 0 } }, input: ["x"] }, ctx)
    ).rejects.toMatchObject({ name: "LLMProviderError", statusCode: 400 });
    expect(() => parseOpenAIEmbeddings({ data: [{ index: 0, embedding: [1] }] }, 2, "openai")).toThrow(/1 embeddings for 2 inputs/);
  });
});
