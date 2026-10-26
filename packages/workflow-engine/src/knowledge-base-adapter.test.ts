import { describe, expect, it } from "vitest";
import { KnowledgeBaseVectorStoreAdapter } from "./rag-adapters.js";
import type { ConnectorDocument } from "@ai-orchestrator/shared";
import type { EmbeddingAdapter } from "./rag-adapters.js";

const doc = { id: "d1", text: "a private document" } as ConnectorDocument;

function countingEmbedder() {
  const embedder = {
    id: "counting",
    calls: 0,
    async embed() {
      embedder.calls += 1;
      return [0.1, 0.2];
    }
  };
  return embedder;
}

describe("KnowledgeBaseVectorStoreAdapter.upsert with an async store", () => {
  it("refuses a missing knowledge base before any embedder call", async () => {
    const embedder = countingEmbedder();
    let added = 0;
    const store = {
      getKnowledgeBase: async () => null,
      addKnowledgeBaseChunks: async () => {
        added += 1;
      },
      listKnowledgeBaseChunks: async () => []
    };
    const adapter = new KnowledgeBaseVectorStoreAdapter(store as never, "kb_missing");
    await expect(adapter.upsert([doc], embedder as unknown as EmbeddingAdapter)).rejects.toThrow(
      "Knowledge base not found: kb_missing"
    );
    expect(embedder.calls).toBe(0);
    expect(added).toBe(0);
  });

  it("surfaces a rejecting store lookup as the upsert's error, never as an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const embedder = countingEmbedder();
      const store = {
        getKnowledgeBase: async () => {
          throw new Error("getKnowledgeBase is not available on this store in this release.");
        },
        addKnowledgeBaseChunks: async () => undefined,
        listKnowledgeBaseChunks: async () => []
      };
      const adapter = new KnowledgeBaseVectorStoreAdapter(store as never, "kb_x");
      await expect(adapter.upsert([doc], embedder as unknown as EmbeddingAdapter)).rejects.toThrow(
        "getKnowledgeBase is not available"
      );
      expect(embedder.calls).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("still embeds and stores when the knowledge base exists", async () => {
    const embedder = countingEmbedder();
    const stored: unknown[] = [];
    const store = {
      getKnowledgeBase: async () => ({ id: "kb_1" }),
      addKnowledgeBaseChunks: async (input: { chunks: unknown[] }) => {
        stored.push(...input.chunks);
      },
      listKnowledgeBaseChunks: async () => []
    };
    const adapter = new KnowledgeBaseVectorStoreAdapter(store as never, "kb_1");
    await adapter.upsert([doc], embedder as unknown as EmbeddingAdapter);
    expect(embedder.calls).toBe(1);
    expect(stored).toHaveLength(1);
  });
});
