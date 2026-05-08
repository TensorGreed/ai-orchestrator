import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteStore } from "./db/database.js";
import {
  KnowledgeBaseVectorStoreAdapter,
  TokenEmbeddingAdapter
} from "@ai-orchestrator/workflow-engine";

describe("Phase 9.1 — built-in persistent vector store", () => {
  let tempDir: string;
  let store: SqliteStore;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-phase9-1-"));
    store = await SqliteStore.create(path.join(tempDir, "orchestrator.db"));
    store.ensureDefaultProject();
  });

  afterEach(() => {
    try { store.close(); } catch { /* may already be closed */ }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("CRUD", () => {
    it("creates, reads, updates, and deletes a KB", () => {
      store.createKnowledgeBase({
        id: "kb_1",
        name: "Helpdesk corpus",
        description: "Q1 support transcripts",
        projectId: "proj_default",
        embedderId: "token-embedder",
        embedderConfig: {},
        createdBy: "alice@example.com"
      });
      const fetched = store.getKnowledgeBase("kb_1")!;
      expect(fetched.name).toBe("Helpdesk corpus");
      expect(fetched.embedderId).toBe("token-embedder");
      expect(fetched.chunkCount).toBe(0);
      expect(fetched.dimensions).toBe(0);

      store.updateKnowledgeBase("kb_1", { name: "Renamed", description: null });
      const after = store.getKnowledgeBase("kb_1")!;
      expect(after.name).toBe("Renamed");
      expect(after.description).toBeNull();

      store.deleteKnowledgeBase("kb_1");
      expect(store.getKnowledgeBase("kb_1")).toBeNull();
    });

    it("lists KBs scoped to a project", () => {
      store.createKnowledgeBase({ id: "kb_a", name: "A", projectId: "p1", embedderId: "token-embedder" });
      store.createKnowledgeBase({ id: "kb_b", name: "B", projectId: "p2", embedderId: "token-embedder" });
      const p1 = store.listKnowledgeBases({ projectId: "p1" });
      expect(p1.map((k) => k.id)).toEqual(["kb_a"]);
    });
  });

  describe("addKnowledgeBaseChunks", () => {
    it("locks dimensions on first insert and rejects mismatches afterwards", () => {
      store.createKnowledgeBase({ id: "kb_dim", name: "dims", embedderId: "token-embedder" });
      store.addKnowledgeBaseChunks({
        knowledgeBaseId: "kb_dim",
        chunks: [{ chunkIndex: 0, content: "hello", vector: new Array(64).fill(0).map((_, i) => i) }]
      });
      const kb = store.getKnowledgeBase("kb_dim")!;
      expect(kb.dimensions).toBe(64);
      expect(kb.chunkCount).toBe(1);

      expect(() => store.addKnowledgeBaseChunks({
        knowledgeBaseId: "kb_dim",
        chunks: [{ chunkIndex: 1, content: "wrong", vector: [1, 2, 3] }]
      })).toThrow(/dimension mismatch/i);
    });

    it("appends chunks and updates chunk_count", () => {
      store.createKnowledgeBase({ id: "kb_app", name: "append", embedderId: "token-embedder" });
      const v = new Array(64).fill(1);
      store.addKnowledgeBaseChunks({
        knowledgeBaseId: "kb_app",
        chunks: [
          { chunkIndex: 0, content: "first", vector: v, sourceId: "doc1" },
          { chunkIndex: 1, content: "second", vector: v, sourceId: "doc1" }
        ]
      });
      store.addKnowledgeBaseChunks({
        knowledgeBaseId: "kb_app",
        chunks: [{ chunkIndex: 2, content: "third", vector: v, sourceId: "doc2" }]
      });
      const kb = store.getKnowledgeBase("kb_app")!;
      expect(kb.chunkCount).toBe(3);
      const sources = store.listKnowledgeBaseSources("kb_app");
      expect(sources.map((s) => s.sourceId).sort()).toEqual(["doc1", "doc2"]);
      expect(sources.find((s) => s.sourceId === "doc1")!.chunkCount).toBe(2);
    });

    it("deleteKnowledgeBaseChunksBySource removes only that source", () => {
      store.createKnowledgeBase({ id: "kb_src", name: "by-source", embedderId: "token-embedder" });
      const v = new Array(64).fill(1);
      store.addKnowledgeBaseChunks({
        knowledgeBaseId: "kb_src",
        chunks: [
          { chunkIndex: 0, content: "a1", vector: v, sourceId: "alpha" },
          { chunkIndex: 1, content: "a2", vector: v, sourceId: "alpha" },
          { chunkIndex: 2, content: "b1", vector: v, sourceId: "beta" }
        ]
      });
      const removed = store.deleteKnowledgeBaseChunksBySource({
        knowledgeBaseId: "kb_src",
        sourceId: "alpha"
      });
      expect(removed).toBe(2);
      const kb = store.getKnowledgeBase("kb_src")!;
      expect(kb.chunkCount).toBe(1);
      const remaining = store.listKnowledgeBaseChunkPreviews({ knowledgeBaseId: "kb_src" });
      expect(remaining[0]!.sourceId).toBe("beta");
    });

    it("cascade-deletes chunks when the KB itself is deleted", () => {
      store.createKnowledgeBase({ id: "kb_del", name: "cascade", embedderId: "token-embedder" });
      const v = new Array(64).fill(1);
      store.addKnowledgeBaseChunks({
        knowledgeBaseId: "kb_del",
        chunks: [{ chunkIndex: 0, content: "x", vector: v }]
      });
      store.deleteKnowledgeBase("kb_del");
      // Re-create with the same id; chunk_count should be 0, no orphans
      store.createKnowledgeBase({ id: "kb_del", name: "fresh", embedderId: "token-embedder" });
      expect(store.getKnowledgeBase("kb_del")!.chunkCount).toBe(0);
    });
  });

  describe("KnowledgeBaseVectorStoreAdapter", () => {
    function adapter(kbId: string): KnowledgeBaseVectorStoreAdapter {
      return new KnowledgeBaseVectorStoreAdapter(
        {
          addKnowledgeBaseChunks: (i) => store.addKnowledgeBaseChunks(i),
          listKnowledgeBaseChunks: (id) => store.listKnowledgeBaseChunks(id),
          getKnowledgeBase: (id) => {
            const kb = store.getKnowledgeBase(id);
            return kb ? { id: kb.id, embedderId: kb.embedderId, dimensions: kb.dimensions } : null;
          }
        },
        kbId
      );
    }

    it("upsert + similaritySearch returns top-K by cosine similarity", async () => {
      store.createKnowledgeBase({ id: "kb_sim", name: "sim", embedderId: "token-embedder" });
      const a = adapter("kb_sim");
      const embedder = new TokenEmbeddingAdapter();
      await a.upsert(
        [
          { id: "d1", text: "the quick brown fox jumps over the lazy dog", metadata: {} },
          { id: "d2", text: "machine learning models are getting better", metadata: {} },
          { id: "d3", text: "the lazy dog sleeps under the tree", metadata: {} }
        ],
        embedder
      );
      const results = await a.similaritySearch("lazy dog", 2, embedder);
      expect(results).toHaveLength(2);
      // Both top-2 must mention "lazy dog"
      expect(results.every((r) => r.text.includes("lazy dog"))).toBe(true);
      // Each result includes provenance metadata
      expect(results[0]!.metadata).toMatchObject({
        knowledgeBaseId: "kb_sim",
        chunkIndex: expect.any(Number)
      });
      expect(results[0]!.metadata).toHaveProperty("similarityScore");
    });

    it("upsert([]) is a no-op (lets callers query without re-ingesting)", async () => {
      store.createKnowledgeBase({ id: "kb_noop", name: "noop", embedderId: "token-embedder" });
      const a = adapter("kb_noop");
      await a.upsert([], new TokenEmbeddingAdapter());
      expect(store.getKnowledgeBase("kb_noop")!.chunkCount).toBe(0);
    });

    it("upsert is APPEND, not replace (in contrast to in-memory store)", async () => {
      store.createKnowledgeBase({ id: "kb_app2", name: "app2", embedderId: "token-embedder" });
      const a = adapter("kb_app2");
      const embedder = new TokenEmbeddingAdapter();
      await a.upsert([{ id: "x", text: "first batch", metadata: {} }], embedder);
      await a.upsert([{ id: "y", text: "second batch", metadata: {} }], embedder);
      expect(store.getKnowledgeBase("kb_app2")!.chunkCount).toBe(2);
    });

    it("similaritySearch on an empty KB returns []", async () => {
      store.createKnowledgeBase({ id: "kb_empty", name: "empty", embedderId: "token-embedder" });
      const a = adapter("kb_empty");
      const r = await a.similaritySearch("anything", 5, new TokenEmbeddingAdapter());
      expect(r).toEqual([]);
    });
  });
});
