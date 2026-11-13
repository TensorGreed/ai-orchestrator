/**
 * v73 — store contract: the `sensitive` mark on session memory, tool cache and artifact rows, on both stores. A mark is
 * written only when asked, stays once set (an unmarked save never clears it), is reported on reads, and a memory row
 * whose stored labels say sensitive reads as sensitive too. Marked rows go with retention purges and erasure like any
 * other row.
 */
import { expect, it } from "vitest";
import type { DataLabels } from "@ai-orchestrator/shared";
import { describeStoreContract } from "../../test-support/test-store.js";
import { testSql } from "../../test-support/test-sql.js";
import { memorySessionRowId } from "../subject-store.js";

const NS = "proj:wf:agent";
const SENSITIVE_LABELS: DataLabels = { provenance: ["sensitive"], dataClasses: [], source: "propagated" };
const USER_LABELS: DataLabels = { provenance: ["user"], dataClasses: [], source: "propagated" };

describeStoreContract("store contract: v73 sensitive session rows", (ctx) => {
  it("memory: unmarked by default, marked when asked, and stays marked through unmarked saves", async () => {
    const store = ctx.store();
    expect(await store.loadSessionMemorySensitive(NS, "none")).toBe(false);
    await store.saveSessionMemory(NS, "plain", [{ role: "user", content: "hello" }]);
    expect(await store.loadSessionMemorySensitive(NS, "plain")).toBe(false);

    await store.saveSessionMemory(NS, "s1", [{ role: "user", content: "card 4242" }], undefined, { sensitive: true });
    expect(await store.loadSessionMemorySensitive(NS, "s1")).toBe(true);
    // A later save without the mark (tracked or not) keeps it; the messages are replaced as before.
    await store.saveSessionMemory(NS, "s1", [{ role: "user", content: "next" }]);
    await store.saveSessionMemory(NS, "s1", [{ role: "user", content: "again" }], USER_LABELS);
    await store.saveSessionMemory(NS, "s1", [{ role: "user", content: "and again" }], USER_LABELS, { sensitive: false });
    expect(await store.loadSessionMemorySensitive(NS, "s1")).toBe(true);
    expect(await store.loadSessionMemory(NS, "s1")).toEqual([{ role: "user", content: "and again" }]);
    // A row first saved unmarked becomes marked by a marked save.
    await store.saveSessionMemory(NS, "plain", [{ role: "user", content: "hello" }], USER_LABELS, { sensitive: true });
    expect(await store.loadSessionMemorySensitive(NS, "plain")).toBe(true);
  });

  it("memory: a row whose stored labels say sensitive reads as sensitive without a mark", async () => {
    const store = ctx.store();
    await store.saveSessionMemory(NS, "labelled", [{ role: "user", content: "x" }], SENSITIVE_LABELS);
    expect(await store.loadSessionMemorySensitive(NS, "labelled")).toBe(true);
    const rows = await testSql(store).all<{ sensitive: number | string }>("SELECT sensitive FROM session_memory WHERE session_id = 'labelled'");
    expect(Number(rows[0]!.sensitive)).toBe(0);
  });

  it("tool cache: the mark is stored and reported on save, list and get; unmarked rows report none", async () => {
    const store = ctx.store();
    const marked = await store.saveSessionToolCall({ namespace: NS, sessionId: "s", toolName: "lookup", args: { q: "card" }, output: { last4: "4242" }, sensitive: true });
    const plain = await store.saveSessionToolCall({ namespace: NS, sessionId: "s", toolName: "weather", args: {}, output: { sunny: true } });
    expect(marked.sensitive).toBe(true);
    expect(plain).not.toHaveProperty("sensitive");
    const listed = await store.listSessionToolCalls({ namespace: NS, sessionId: "s" });
    expect(Object.fromEntries(listed.map((row) => [row.toolName, row.sensitive === true]))).toEqual({ lookup: true, weather: false });
    expect(listed.find((row) => row.toolName === "weather")).not.toHaveProperty("sensitive");
    expect((await store.getSessionToolCall({ namespace: NS, sessionId: "s", id: marked.id }))?.sensitive).toBe(true);
    expect(await store.getSessionToolCall({ namespace: NS, sessionId: "s", id: plain.id })).not.toHaveProperty("sensitive");
  });

  it("artifacts: the mark is stored, reported, and kept when the value is replaced without it", async () => {
    const store = ctx.store();
    const key = { namespace: NS, sessionId: "s", artifactKey: "note" };
    const first = await store.saveSessionArtifact({ ...key, value: { text: "card 4242" }, sensitive: true });
    expect(first.sensitive).toBe(true);
    const replaced = await store.saveSessionArtifact({ ...key, value: { text: "other" } });
    expect(replaced.sensitive).toBe(true);
    expect((await store.loadSessionArtifact(key))?.sensitive).toBe(true);
    const plain = await store.saveSessionArtifact({ ...key, artifactKey: "plain", value: 1 });
    expect(plain).not.toHaveProperty("sensitive");
    expect(await store.loadSessionArtifact({ ...key, artifactKey: "plain" })).not.toHaveProperty("sensitive");
  });

  it("marked rows are purged by retention and erased with their memory session like any other row", async () => {
    const store = ctx.store();
    const sql = testSql(store);
    await store.saveSessionMemory(NS, "old", [{ role: "user", content: "x" }], undefined, { sensitive: true });
    await store.saveSessionToolCall({ namespace: NS, sessionId: "old", toolName: "t", args: {}, output: 1, sensitive: true });
    await store.saveSessionArtifact({ namespace: NS, sessionId: "old", artifactKey: "a", value: 1, sensitive: true });
    await sql.run("UPDATE session_memory SET updated_at = '2001-01-01T00:00:00.000Z'");
    await sql.run("UPDATE session_tool_cache SET created_at = '2001-01-01T00:00:00.000Z'");
    await sql.run("UPDATE session_artifacts SET updated_at = '2001-01-01T00:00:00.000Z'");
    for (const table of ["session_memory", "session_tool_cache", "session_artifacts"] as const) {
      expect(await store.pruneRetentionTable(table, { before: "2020-01-01T00:00:00.000Z", limit: 100 }), table).toBe(1);
    }

    await store.saveSessionMemory(NS, "erase", [{ role: "user", content: "x" }], undefined, { sensitive: true });
    await store.saveSessionToolCall({ namespace: NS, sessionId: "erase", toolName: "t", args: {}, output: 1, sensitive: true });
    await store.saveSessionArtifact({ namespace: NS, sessionId: "erase", artifactKey: "a", value: 1, sensitive: true });
    expect((await store.deleteSubjectRow("memory_session", memorySessionRowId(NS, "erase"))).deleted).toBe(true);
    for (const table of ["session_memory", "session_tool_cache", "session_artifacts"]) {
      expect(await sql.all(`SELECT 1 AS one FROM ${table}`), table).toEqual([]);
    }
  });
});
