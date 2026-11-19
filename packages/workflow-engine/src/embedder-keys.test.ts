/**
 * The validation's B12: the RAG with Citations template, run without an OpenAI key, sent the embedding request with an
 * empty key and failed with OpenAI's raw 401 body. An embedder that needs a key now refuses before it calls anything
 * and names the key; a key the provider refuses is reported in one plain sentence, without the provider's raw body.
 */
import { describe, expect, it } from "vitest";
import { createDefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { createDefaultProviderRegistry } from "@ai-orchestrator/provider-sdk";
import { ErrorCategory, type Workflow } from "@ai-orchestrator/shared";
import { executeWorkflow } from "./executor";
import { AzureOpenAIEmbeddingAdapter, CohereEmbeddingAdapter, OpenAIEmbeddingAdapter } from "./rag-adapters";

const RAW_401 = JSON.stringify({ error: { message: "You didn't provide an API key. You need to provide your API key in an Authorization header", type: "invalid_request_error" } });

describe("embedders that need a key", () => {
  it("refuse before calling anything when there is no key, naming it", async () => {
    let called = 0;
    const fetcher = async () => {
      called += 1;
      return new Response(RAW_401, { status: 401, statusText: "Unauthorized" });
    };
    const openai = new OpenAIEmbeddingAdapter({ apiKey: "", fetcher });
    await expect(openai.embed("hello")).rejects.toThrow(/No OpenAI API key for the embedder.*OPENAI_API_KEY/);
    await expect(openai.embed("hello")).rejects.toMatchObject({ category: ErrorCategory.PROVIDER_AUTH });
    const azure = new AzureOpenAIEmbeddingAdapter({ apiKey: "", endpoint: "https://r.openai.azure.com", deployment: "emb", fetcher });
    await expect(azure.embed("hello")).rejects.toThrow(/No Azure OpenAI API key for the embedder/);
    await expect(new CohereEmbeddingAdapter({ apiKey: "" }).embed("hello")).rejects.toThrow(/No Cohere API key for the embedder.*COHERE_API_KEY/);
    expect(called).toBe(0);
  });

  it("report a refused key in a plain sentence, without the provider's raw body", async () => {
    const openai = new OpenAIEmbeddingAdapter({ apiKey: "sk-wrong", fetcher: async () => new Response(RAW_401, { status: 401, statusText: "Unauthorized" }) });
    const error = (await openai.embed("hello").catch((caught: unknown) => caught)) as Error;
    expect(error.message).toMatch(/OpenAI did not accept the embedder's API key \(401\)/);
    expect(error.message).not.toMatch(/You didn't provide/);
  });

  it("fail the RAG with Citations template's retrieval with that message when no OpenAI key is set", async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const originalFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched += 1;
      return new Response(RAW_401, { status: 401, statusText: "Unauthorized" });
    }) as typeof fetch;
    try {
      const workflow: Workflow = {
        id: "rag-citations",
        name: "RAG with Citations",
        schemaVersion: "1.0.0",
        workflowVersion: 1,
        nodes: [
          { id: "text_1", type: "text_input", name: "Question", position: { x: 0, y: 0 }, config: { text: "How do I reset my password?" } },
          {
            id: "rag_1",
            type: "rag_retrieve",
            name: "Retrieve",
            position: { x: 0, y: 0 },
            config: { queryTemplate: "{{user_prompt}}", topK: 4, embedderId: "openai-embedder", vectorStoreId: "in-memory-vector-store", searchMode: "vector" }
          }
        ],
        edges: [{ id: "e1", source: "text_1", target: "rag_1" }]
      };
      const result = await executeWorkflow(
        { workflow, userPrompt: "How do I reset my password?" },
        {
          providerRegistry: createDefaultProviderRegistry(),
          connectorRegistry: createDefaultConnectorRegistry(),
          mcpRegistry: createDefaultMCPRegistry(),
          agentRuntime: createDefaultAgentRuntime(),
          resolveSecret: async () => undefined
        }
      );
      const rag = result.nodeResults.find((entry) => entry.nodeId === "rag_1");
      expect(rag?.status).toBe("error");
      expect(rag?.error).toMatch(/No OpenAI API key for the embedder/);
      expect(rag?.error).not.toMatch(/You didn't provide/);
      expect(fetched).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      if (saved === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved;
    }
  });
});
