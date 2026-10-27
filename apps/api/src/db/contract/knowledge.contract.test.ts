/**
 * Phase 13.1 — store contract: knowledge bases, chunks and keyword search, on both stores. Keyword search ranks with
 * FTS5 bm25 on SQLite and ts_rank_cd over content_tsv on Postgres, so the tests assert the ranking shape (which
 * chunks match, best first, scores normalised to 0..1), not exact scores.
 */
import { expect, it } from "vitest";
import { describeStoreContract } from "../../test-support/test-store.js";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describeStoreContract("store contract: knowledge bases", (ctx) => {
  it("creates, reads, updates, lists and deletes knowledge bases", async () => {
    const store = ctx.store();
    await store.createKnowledgeBase({ id: "kb-1", name: "beta", embedderId: "hash", embedderConfig: { size: 8 }, projectId: "p1", createdBy: "u1" });
    await store.createKnowledgeBase({ id: "kb-2", name: "Alpha", description: "docs", embedderId: "hash" });
    const kb = await store.getKnowledgeBase("kb-1");
    expect(kb).toEqual({
      id: "kb-1", name: "beta", description: null, projectId: "p1", embedderId: "hash", embedderConfig: { size: 8 },
      dimensions: 0, chunkCount: 0, createdBy: "u1", createdAt: expect.stringMatching(ISO), updatedAt: expect.stringMatching(ISO)
    });
    expect((await store.getKnowledgeBase("kb-2"))?.embedderConfig).toEqual({});
    expect((await store.listKnowledgeBases()).map((k) => k.id)).toEqual(["kb-2", "kb-1"]);
    expect((await store.listKnowledgeBases({ projectId: "p1" })).map((k) => k.id)).toEqual(["kb-1"]);
    expect(await store.updateKnowledgeBase("kb-1", {})).toBe(false);
    expect(await store.updateKnowledgeBase("kb-1", { name: "Beta 2", description: "d", embedderConfig: { size: 4 }, dimensions: 4 })).toBe(true);
    expect(await store.getKnowledgeBase("kb-1")).toMatchObject({ name: "Beta 2", description: "d", embedderConfig: { size: 4 }, dimensions: 4 });
    expect(await store.deleteKnowledgeBase("kb-1")).toBe(true);
    expect(await store.getKnowledgeBase("kb-1")).toBeNull();
    expect(await store.getKnowledgeBase("missing")).toBeNull();
  });

  it("adds chunks, locks the dimensions on the first insert, keeps insertion order and counts", async () => {
    const store = ctx.store();
    await store.createKnowledgeBase({ id: "kb", name: "KB", embedderId: "hash" });
    await expect(store.addKnowledgeBaseChunks({ knowledgeBaseId: "missing", chunks: [] })).rejects.toThrow("Knowledge base not found: missing");
    expect(await store.addKnowledgeBaseChunks({ knowledgeBaseId: "kb", chunks: [] })).toEqual({ inserted: 0, dimensions: 0 });
    const chunks = [
      { id: "c-z", sourceId: "s2", chunkIndex: 0, content: "zeta", vector: [1, 0, 0] },
      { id: "c-a", sourceId: "s1", chunkIndex: 1, content: "alpha", metadata: { page: 2 }, vector: [0, 1, 0] },
      { sourceId: "s1", chunkIndex: 0, content: "first", vector: [0, 0, 1] }
    ];
    expect(await store.addKnowledgeBaseChunks({ knowledgeBaseId: "kb", chunks })).toEqual({ inserted: 3, dimensions: 3 });
    await expect(store.addKnowledgeBaseChunks({ knowledgeBaseId: "kb", chunks: [{ chunkIndex: 9, content: "x", vector: [1] }] }))
      .rejects.toThrow("Vector dimension mismatch: expected 3, got 1 (chunk 9)");
    await store.addKnowledgeBaseChunks({ knowledgeBaseId: "kb", chunks: [{ id: "c-last", chunkIndex: 2, content: "last", vector: [1, 1, 1] }] });
    expect(await store.getKnowledgeBase("kb")).toMatchObject({ dimensions: 3, chunkCount: 4 });

    const listed = await store.listKnowledgeBaseChunks("kb");
    expect(listed.map((c) => c.content)).toEqual(["zeta", "alpha", "first", "last"]);
    expect(listed[1]).toEqual({ id: "c-a", knowledgeBaseId: "kb", sourceId: "s1", chunkIndex: 1, content: "alpha", metadata: { page: 2 }, vector: [0, 1, 0], createdAt: expect.stringMatching(ISO) });
    expect(listed[2]?.id).toMatch(/^kbc_/);
    expect(listed[3]?.sourceId).toBeNull();
    // One batch reads back with one creation time.
    expect(new Set(listed.slice(0, 3).map((c) => c.createdAt)).size).toBe(1);

    const previews = await store.listKnowledgeBaseChunkPreviews({ knowledgeBaseId: "kb" });
    expect(previews.map((c) => c.content)).toEqual(["zeta", "first", "alpha", "last"]);
    expect(previews[0]).not.toHaveProperty("vector");
    expect((await store.listKnowledgeBaseChunkPreviews({ knowledgeBaseId: "kb", sourceId: "s1", limit: 1 })).map((c) => c.content)).toEqual(["first"]);

    expect(await store.listKnowledgeBaseSources("kb")).toEqual([{ sourceId: "s1", chunkCount: 2 }, { sourceId: "s2", chunkCount: 1 }]);
    expect(await store.deleteKnowledgeBaseChunksBySource({ knowledgeBaseId: "kb", sourceId: "s1" })).toBe(2);
    expect(await store.deleteKnowledgeBaseChunksBySource({ knowledgeBaseId: "kb", sourceId: "s1" })).toBe(0);
    expect((await store.getKnowledgeBase("kb"))?.chunkCount).toBe(2);
    await store.deleteKnowledgeBase("kb");
    expect(await store.listKnowledgeBaseChunks("kb")).toEqual([]);
  });

  it("keeps insertion order across many back-to-back batches, also when ids sort the other way (no ties by id)", async () => {
    const store = ctx.store();
    await store.createKnowledgeBase({ id: "kb", name: "KB", embedderId: "hash" });
    // 60 one-chunk batches in a row land several per millisecond; ids sort opposite to insertion.
    const ids = Array.from({ length: 60 }, (_, i) => `c-${String(999 - i).padStart(3, "0")}`);
    for (const id of ids) {
      await store.addKnowledgeBaseChunks({ knowledgeBaseId: "kb", chunks: [{ id, chunkIndex: 0, content: id, vector: [1, 0] }] });
    }
    expect((await store.listKnowledgeBaseChunks("kb")).map((c) => c.id)).toEqual(ids);
  }, 60_000);

  it("concurrent batches stay whole and in their own order", async () => {
    const store = ctx.store();
    await store.createKnowledgeBase({ id: "kb", name: "KB", embedderId: "hash" });
    for (let round = 0; round < 10; round += 1) {
      await Promise.all(["x", "y", "z"].map((batch) =>
        store.addKnowledgeBaseChunks({
          knowledgeBaseId: "kb",
          chunks: [
            { id: `${round}-${batch}-2`, chunkIndex: 0, content: "second id, first chunk", vector: [1, 0] },
            { id: `${round}-${batch}-1`, chunkIndex: 1, content: "first id, second chunk", vector: [0, 1] }
          ]
        })
      ));
    }
    const listed = (await store.listKnowledgeBaseChunks("kb")).map((c) => c.id);
    expect(listed).toHaveLength(60);
    for (let i = 0; i < listed.length; i += 2) {
      const [first, second] = [listed[i]!, listed[i + 1]!];
      expect(first.endsWith("-2")).toBe(true);
      expect(second).toBe(first.replace(/-2$/, "-1"));
    }
  }, 60_000);

  it("a batch of 5000 chunks reads back with one creation time, not in the future", async () => {
    const store = ctx.store();
    await store.createKnowledgeBase({ id: "kb", name: "KB", embedderId: "hash" });
    const before = Date.now();
    const chunks = Array.from({ length: 5000 }, (_, i) => ({ id: `big-${String(i).padStart(4, "0")}`, chunkIndex: i, content: "c", vector: [1] }));
    await store.addKnowledgeBaseChunks({ knowledgeBaseId: "kb", chunks });
    const after = Date.now();
    const listed = await store.listKnowledgeBaseChunks("kb");
    expect(listed.map((c) => c.id)).toEqual(chunks.map((c) => c.id));
    const times = new Set(listed.map((c) => c.createdAt));
    expect(times.size).toBe(1);
    const at = Date.parse([...times][0]!);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
  }, 60_000);

  it("keyword search: matching chunks only, best first, scores normalised to 0..1, scoped to the knowledge base", async () => {
    const store = ctx.store();
    await store.createKnowledgeBase({ id: "kb", name: "KB", embedderId: "hash" });
    await store.createKnowledgeBase({ id: "kb-other", name: "Other", embedderId: "hash" });
    const v = [1, 0];
    await store.addKnowledgeBaseChunks({
      knowledgeBaseId: "kb",
      chunks: [
        { id: "refund-strong", chunkIndex: 0, content: "Refund policy: a refund is issued within 14 days. Refund requests need a receipt.", metadata: { s: 1 }, vector: v },
        { id: "refund-weak", chunkIndex: 1, content: "Shipping takes five days; see the refund page for returns.", vector: v },
        { id: "unrelated", chunkIndex: 2, content: "Our office opens at nine.", vector: v }
      ]
    });
    await store.addKnowledgeBaseChunks({ knowledgeBaseId: "kb-other", chunks: [{ id: "other-refund", chunkIndex: 0, content: "refund refund refund", vector: v }] });

    const results = await store.bm25SearchKnowledgeBase({ knowledgeBaseId: "kb", query: "Refund?", topK: 10 });
    expect(results.map((r) => r.id)).toEqual(["refund-strong", "refund-weak"]);
    expect(results[0]).toMatchObject({ sourceId: null, chunkIndex: 0, metadata: { s: 1 }, score: 1 });
    expect(results[1]?.score).toBe(0);
    expect(results[1]?.metadata).toBeNull();
    for (const r of results) expect(r.score).toBeGreaterThanOrEqual(0);

    // Any token may match (OR), and topK limits.
    const either = await store.bm25SearchKnowledgeBase({ knowledgeBaseId: "kb", query: "office receipt", topK: 10 });
    expect(either.map((r) => r.id).sort()).toEqual(["refund-strong", "unrelated"]);
    expect(await store.bm25SearchKnowledgeBase({ knowledgeBaseId: "kb", query: "refund", topK: 1 })).toHaveLength(1);

    // Nothing to search for, or nothing matches.
    expect(await store.bm25SearchKnowledgeBase({ knowledgeBaseId: "kb", query: "a ? !", topK: 5 })).toEqual([]);
    expect(await store.bm25SearchKnowledgeBase({ knowledgeBaseId: "kb", query: "zebra", topK: 5 })).toEqual([]);
    // Characters with meaning in a search syntax are only separators.
    expect((await store.bm25SearchKnowledgeBase({ knowledgeBaseId: "kb", query: "\"refund\" OR -office (receipt", topK: 5 })).length).toBeGreaterThan(0);
  });
});
