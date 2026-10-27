/**
 * Phase 13.1 — store contract: list limits are clamped the same way on both stores. A limit is floored, a missing,
 * zero or non-numeric one takes the method's default, and the result is kept within 1..max. Before, a negative limit
 * meant "no limit" on SQLite (LIMIT -1) and an error on Postgres (2201W), and a NaN failed on both.
 */
import { expect, it } from "vitest";
import type { Store } from "../store.js";
import { describeStoreContract } from "../../test-support/test-store.js";
import { clampLimit } from "../store-limits.js";

function iso(offsetMs: number): string {
  return new Date(Date.parse("2026-10-26T07:00:00.000Z") + offsetMs).toISOString();
}

async function addProbes(store: Store, count: number): Promise<void> {
  await store.createMcpServer({ id: "srv", name: "Server", adapterId: "http-mcp", connection: { url: "http://srv" } });
  for (let i = 0; i < count; i += 1) {
    await store.recordMcpServerProbe({
      probe: { id: `p${i}`, serverId: "srv", startedAt: iso(i * 1000), ok: true, latencyMs: 1, toolCount: 0, error: null, snapshotId: `s${i}` },
      status: "healthy",
      snapshot: { id: `s${i}`, serverId: "srv", hash: `h${i}`, tools: [], toolCount: 0, previousSnapshotId: null, changes: [], breaking: false, createdAt: iso(i * 1000) },
      keepProbes: 100
    });
  }
}

it("clampLimit floors, defaults and bounds", () => {
  const options = { fallback: 50, max: 500 };
  expect(clampLimit(undefined, options)).toBe(50);
  expect(clampLimit(Number.NaN, options)).toBe(50);
  expect(clampLimit(0, options)).toBe(50);
  expect(clampLimit(-1, options)).toBe(1);
  expect(clampLimit(-0.5, options)).toBe(1);
  expect(clampLimit(2.9, options)).toBe(2);
  expect(clampLimit(10_000, options)).toBe(500);
  expect(clampLimit(Number.POSITIVE_INFINITY, options)).toBe(500);
  expect(clampLimit(7, options)).toBe(7);
});

describeStoreContract("store contract: list limits", (ctx) => {
  it("knowledge base chunk previews: negative -> 1, NaN -> 50, huge -> 500, a valid limit as given", async () => {
    const store = ctx.store();
    await store.createKnowledgeBase({ id: "kb", name: "KB", embedderId: "hash" });
    await store.addKnowledgeBaseChunks({
      knowledgeBaseId: "kb",
      chunks: Array.from({ length: 520 }, (_, i) => ({ chunkIndex: i, content: `c${i}`, vector: [1] }))
    });
    const count = async (limit: number | undefined) => (await store.listKnowledgeBaseChunkPreviews({ knowledgeBaseId: "kb", limit })).length;
    expect(await count(-1)).toBe(1);
    expect(await count(Number.NaN)).toBe(50);
    expect(await count(undefined)).toBe(50);
    expect(await count(10_000)).toBe(500);
    expect(await count(3)).toBe(3);
    expect(await count(2.5)).toBe(2);
  }, 60_000);

  it("dequeueNext: negative or NaN claims one job, a valid limit claims that many", async () => {
    const store = ctx.store();
    const due = new Date(Date.now() - 1000).toISOString();
    for (let i = 0; i < 6; i += 1) await store.enqueueExecution({ id: `job-${i}`, workflowId: "wf", payload: {}, scheduledAt: due });
    expect(await store.dequeueNext(-1)).toHaveLength(1);
    expect(await store.dequeueNext(Number.NaN)).toHaveLength(1);
    expect(await store.dequeueNext(3)).toHaveLength(3);
  });

  it("MCP probes and snapshots: negative -> 1, NaN -> the default, a valid limit as given", async () => {
    const store = ctx.store();
    await addProbes(store, 4);
    expect((await store.listMcpServerProbes("srv", -1)).map((p) => p.id)).toEqual(["p3"]);
    expect(await store.listMcpServerProbes("srv", Number.NaN)).toHaveLength(4);
    expect(await store.listMcpServerProbes("srv", 2)).toHaveLength(2);
    expect((await store.listMcpToolSnapshots("srv", -5)).map((s) => s.id)).toEqual(["s3"]);
    expect(await store.listMcpToolSnapshots("srv", Number.NaN)).toHaveLength(4);
    expect(await store.listMcpToolSnapshots("srv", 3)).toHaveLength(3);
  });
});
