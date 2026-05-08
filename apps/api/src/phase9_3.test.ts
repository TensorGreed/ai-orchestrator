import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteStore } from "./db/database.js";
import {
  KnowledgeBaseVectorStoreAdapter,
  TokenEmbeddingAdapter,
  reciprocalRankFusion
} from "@ai-orchestrator/workflow-engine";

describe("Phase 9.3 — hybrid search + rerank", () => {
  let tempDir: string;
  let store: SqliteStore;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-phase9-3-"));
    store = await SqliteStore.create(path.join(tempDir, "orchestrator.db"));
    store.ensureDefaultProject();
  });

  afterEach(() => {
    try { store.close(); } catch { /* may already be closed */ }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function adapter(kbId: string): KnowledgeBaseVectorStoreAdapter {
    return new KnowledgeBaseVectorStoreAdapter(
      {
        addKnowledgeBaseChunks: (i) => store.addKnowledgeBaseChunks(i),
        listKnowledgeBaseChunks: (id) => store.listKnowledgeBaseChunks(id),
        bm25SearchKnowledgeBase: (i) => store.bm25SearchKnowledgeBase(i),
        getKnowledgeBase: (id) => {
          const kb = store.getKnowledgeBase(id);
          return kb ? { id: kb.id, embedderId: kb.embedderId, dimensions: kb.dimensions } : null;
        }
      },
      kbId
    );
  }

  // -------------------------------------------------------------------------
  // Reciprocal Rank Fusion
  // -------------------------------------------------------------------------

  describe("reciprocalRankFusion", () => {
    it("ranks docs that appear in both lists above docs in only one", () => {
      const lists = [
        { items: [{ id: "a" }, { id: "b" }, { id: "c" }] },
        { items: [{ id: "b" }, { id: "d" }, { id: "a" }] }
      ];
      const fused = reciprocalRankFusion(lists, (d) => d.id);
      // a (1+3) and b (2+1) appear in both lists — they should be on top.
      const ids = fused.map((f) => f.id);
      expect(ids[0]).toMatch(/^[ab]$/);
      expect(ids[1]).toMatch(/^[ab]$/);
      // c and d are unique to one list each
      expect(ids.slice(2).sort()).toEqual(["c", "d"]);
    });

    it("respects per-list weights", () => {
      // Same id at rank 1 in list A vs rank 1 in list B; if A has weight 10
      // and B has weight 1, A's top doc dominates over a tie-breaker
      const fused = reciprocalRankFusion(
        [
          { items: [{ id: "from-a" }], weight: 10 },
          { items: [{ id: "from-b" }], weight: 1 }
        ],
        (d) => d.id
      );
      expect(fused[0]!.id).toBe("from-a");
    });

    it("empty input lists yield empty output", () => {
      const fused = reciprocalRankFusion<{ id: string }>([{ items: [] }, { items: [] }], (d) => d.id);
      expect(fused).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // FTS5 / BM25 search
  // -------------------------------------------------------------------------

  describe("BM25 search via FTS5", () => {
    function setupKb(): string {
      store.createKnowledgeBase({ id: "kb_bm25", name: "bm25", embedderId: "token-embedder" });
      const v = (n: number) => new Array(64).fill(n);
      store.addKnowledgeBaseChunks({
        knowledgeBaseId: "kb_bm25",
        chunks: [
          { chunkIndex: 0, content: "Reset your password using the recovery email link", vector: v(1), sourceId: "doc-auth" },
          { chunkIndex: 1, content: "We accept Visa Mastercard and ACH bank transfers", vector: v(2), sourceId: "doc-billing" },
          { chunkIndex: 2, content: "Office is open weekdays from 9am to 5pm Pacific", vector: v(3), sourceId: "doc-info" },
          { chunkIndex: 3, content: "Forgotten password recovery requires email verification", vector: v(4), sourceId: "doc-auth" }
        ]
      });
      return "kb_bm25";
    }

    it("returns BM25-ranked chunks for an exact-keyword query", () => {
      const kbId = setupKb();
      const results = store.bm25SearchKnowledgeBase({
        knowledgeBaseId: kbId,
        query: "password",
        topK: 5
      });
      expect(results.length).toBeGreaterThan(0);
      // Both auth chunks should rank ahead of the others
      expect(results[0]!.content.toLowerCase()).toContain("password");
      expect(results.some((r) => r.sourceId === "doc-billing")).toBe(false);
    });

    it("escapes FTS5 special characters in user queries", () => {
      const kbId = setupKb();
      // Query contains FTS5-meaningful chars (parens, colon, NOT)
      const results = store.bm25SearchKnowledgeBase({
        knowledgeBaseId: kbId,
        query: "what (does NOT) :reset password? mean!",
        topK: 5
      });
      // Should not throw, and should still find password chunks
      expect(results.length).toBeGreaterThan(0);
    });

    it("returns empty for queries with no indexable tokens", () => {
      const kbId = setupKb();
      const results = store.bm25SearchKnowledgeBase({
        knowledgeBaseId: kbId,
        query: "?? ! - +",
        topK: 5
      });
      expect(results).toEqual([]);
    });

    it("normalizes scores to [0, 1] with the best result at 1", () => {
      const kbId = setupKb();
      const results = store.bm25SearchKnowledgeBase({
        knowledgeBaseId: kbId,
        query: "password recovery",
        topK: 5
      });
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.score).toBeGreaterThanOrEqual(0);
        expect(r.score).toBeLessThanOrEqual(1);
      }
      const top = Math.max(...results.map((r) => r.score));
      expect(top).toBeCloseTo(1, 6);
    });

    it("scopes to a single KB (FTS rows from another KB don't leak)", () => {
      store.createKnowledgeBase({ id: "kb_other", name: "other", embedderId: "token-embedder" });
      store.addKnowledgeBaseChunks({
        knowledgeBaseId: "kb_other",
        chunks: [
          { chunkIndex: 0, content: "different KB password content", vector: new Array(64).fill(1), sourceId: "x" }
        ]
      });
      const kbId = setupKb();

      const results = store.bm25SearchKnowledgeBase({
        knowledgeBaseId: kbId,
        query: "password",
        topK: 10
      });
      expect(results.every((r) => !r.content.includes("different KB"))).toBe(true);
    });

    it("FTS index stays in sync after deletes", () => {
      const kbId = setupKb();
      // Drop one source — FTS triggers should remove the rows
      store.deleteKnowledgeBaseChunksBySource({ knowledgeBaseId: kbId, sourceId: "doc-auth" });

      const results = store.bm25SearchKnowledgeBase({
        knowledgeBaseId: kbId,
        query: "password",
        topK: 5
      });
      // Both password chunks were under doc-auth; nothing should match now
      expect(results).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Hybrid search
  // -------------------------------------------------------------------------

  describe("KnowledgeBaseVectorStoreAdapter.hybridSearch", () => {
    it("hybrid returns results when BM25 finds matches the dense path misses", async () => {
      // The token embedder is bag-of-tokens hashed into 64 buckets — easy
      // to defeat with an out-of-vocabulary keyword. BM25 picks it up.
      store.createKnowledgeBase({ id: "kb_hybrid", name: "hybrid", embedderId: "token-embedder" });
      const a = adapter("kb_hybrid");
      const embedder = new TokenEmbeddingAdapter();
      await a.upsert(
        [
          { id: "d1", text: "the cat sat on the mat", metadata: {} },
          { id: "d2", text: "the dog barked at the moon", metadata: {} },
          { id: "d3", text: "DocumentX0042 is the canonical reference manual", metadata: {} }
        ],
        embedder
      );

      const results = await a.hybridSearch("DocumentX0042", 3, embedder);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.text).toContain("DocumentX0042");
      // Result metadata identifies it as hybrid mode
      expect((results[0]!.metadata as { retrieval: { mode: string } }).retrieval.mode).toBe("hybrid");
    });

    it("falls back to vector-only when BM25 returns nothing", async () => {
      store.createKnowledgeBase({ id: "kb_fb", name: "fb", embedderId: "token-embedder" });
      const a = adapter("kb_fb");
      const embedder = new TokenEmbeddingAdapter();
      await a.upsert(
        [
          { id: "d1", text: "the lazy dog jumps high", metadata: {} },
          { id: "d2", text: "machine learning models", metadata: {} }
        ],
        embedder
      );
      // Garbage query that BM25 can't index (all tokens <2 chars after split)
      const results = await a.hybridSearch("? ! -", 2, embedder);
      // Vector-only fallback still returns docs (cosine of empty query)
      expect(results.length).toBeGreaterThan(0);
    });

    it("hybrid result count is bounded by topK", async () => {
      store.createKnowledgeBase({ id: "kb_topk", name: "topk", embedderId: "token-embedder" });
      const a = adapter("kb_topk");
      const embedder = new TokenEmbeddingAdapter();
      const docs = Array.from({ length: 20 }, (_, i) => ({
        id: `d${i}`,
        text: `password recovery email document number ${i}`,
        metadata: {}
      }));
      await a.upsert(docs, embedder);
      const results = await a.hybridSearch("password recovery", 5, embedder);
      expect(results.length).toBeLessThanOrEqual(5);
    });
  });

  // -------------------------------------------------------------------------
  // rag_retrieve searchMode integration via REST + execute
  // -------------------------------------------------------------------------
  // (See app.test.ts for the end-to-end execute test. The above unit tests
  // cover the adapter mechanics in isolation.)
});
