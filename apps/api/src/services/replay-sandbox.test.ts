import { describe, expect, it } from "vitest";
import type { KnowledgeBaseStore } from "@ai-orchestrator/workflow-engine";
import { MemorySeedCapture } from "./mcp-cassette-service.js";
import { createReplaySandbox, REPLAY_KB_WRITE_REFUSED } from "./replay-sandbox.js";

describe("replay sandbox", () => {
  it("keeps session memory, tool cache and artifacts in memory for one replay", async () => {
    const sandbox = createReplaySandbox();
    expect(await sandbox.memoryStore.loadMessages("ns", "s1")).toEqual([]);
    await sandbox.memoryStore.saveMessages("ns", "s1", [{ role: "user", content: "hi" }]);
    expect(await sandbox.memoryStore.loadMessages("ns", "s1")).toEqual([{ role: "user", content: "hi" }]);
    expect(await sandbox.memoryStore.loadMessages("ns", "other")).toEqual([]);

    const saved = await sandbox.toolDataStore.saveToolCall({ namespace: "ns", sessionId: "s1", toolName: "lookup", toolCallId: "c1", args: { q: 1 }, output: { a: 2 } } as never);
    const listed = await sandbox.toolDataStore.listToolCalls({ namespace: "ns", sessionId: "s1" } as never);
    expect(listed.map((entry) => entry.id)).toEqual([saved.id]);
    expect(await sandbox.toolDataStore.getToolCall({ namespace: "ns", sessionId: "s1", id: saved.id } as never)).toMatchObject({ output: { a: 2 } });

    await sandbox.sessionArtifactStore.saveArtifact({ namespace: "ns", sessionId: "s1", artifactKey: "latest", value: { x: 1 } } as never);
    expect(await sandbox.sessionArtifactStore.loadArtifact({ namespace: "ns", sessionId: "s1", artifactKey: "latest" } as never)).toMatchObject({ value: { x: 1 } });
    expect(sandbox.stats()).toEqual({ memoryWrites: 1, toolCacheWrites: 1, artifactWrites: 1 });

    // A fresh sandbox starts empty: nothing leaks between replays.
    expect(await createReplaySandbox().memoryStore.loadMessages("ns", "s1")).toEqual([]);
  });

  it("refuses knowledge-base writes, passes reads through and declines elicitations", async () => {
    const reads: string[] = [];
    const inner: KnowledgeBaseStore = {
      addKnowledgeBaseChunks: () => {
        throw new Error("the real store must not be written");
      },
      listKnowledgeBaseChunks: (id) => {
        reads.push(id);
        return [];
      },
      getKnowledgeBase: (id) => ({ id, embedderId: "token-embedder", dimensions: 8 })
    } as KnowledgeBaseStore;
    const wrapped = createReplaySandbox().wrapKnowledgeBaseStore(inner);
    expect(() => wrapped.addKnowledgeBaseChunks({} as never)).toThrow(REPLAY_KB_WRITE_REFUSED);
    expect(await wrapped.listKnowledgeBaseChunks("kb1")).toEqual([]);
    expect(reads).toEqual(["kb1"]);
    expect(await wrapped.getKnowledgeBase("kb1")).toMatchObject({ id: "kb1" });
    expect(await createReplaySandbox().onMcpElicitation()).toEqual({ action: "decline" });
  });

  it("starts session memory from a golden run's memory seed, and never writes back to it", async () => {
    const seed = { sessions: [{ namespace: "ns", sessionId: "s1", messages: [{ role: "user" as const, content: "earlier" }] }], truncated: false };
    const sandbox = createReplaySandbox(seed);
    expect(await sandbox.memoryStore.loadMessages("ns", "s1")).toEqual([{ role: "user", content: "earlier" }]);
    await sandbox.memoryStore.saveMessages("ns", "s1", [{ role: "user", content: "earlier" }, { role: "assistant", content: "now" }]);
    expect(seed.sessions[0]!.messages).toHaveLength(1);
    expect(await sandbox.memoryStore.loadMessages("ns", "s2")).toEqual([]);
  });

  it("v73: the seed keeps the mark of memory a run read without looking the mark up (content capture off), failing closed", async () => {
    const capture = new MemorySeedCapture({ maxBytes: 100_000, scrub: (value) => value });
    let markReads = 0;
    const recorded = capture.wrap({
      loadMessages: async () => [{ role: "user", content: "card 4242" }],
      saveMessages: async () => undefined,
      loadSensitive: async (_namespace, sessionId) => {
        markReads += 1;
        if (sessionId === "broken") throw new Error("db down");
        return sessionId === "marked";
      }
    });
    // Only loadMessages, as a run with capture off calls it; a second read of a session asks nothing more.
    await recorded.loadMessages("ns", "marked");
    await recorded.loadMessages("ns", "marked");
    await recorded.loadMessages("ns", "plain");
    await recorded.loadMessages("ns", "broken");
    expect(markReads).toBe(3);
    expect(capture.toSeed()!.sessions.map((session) => [session.sessionId, session.sensitive === true])).toEqual([
      ["marked", true],
      ["plain", false],
      ["broken", true]
    ]);
  });

  it("v73: keeps the sensitive mark of seeded memory and of what the replay writes", async () => {
    // The recorded run read marked memory: the seed says so, and the replay's memory reads as sensitive.
    const capture = new MemorySeedCapture({ maxBytes: 100_000, scrub: (value) => value });
    const recorded = capture.wrap({
      loadMessages: async () => [{ role: "user", content: "card 4242" }],
      saveMessages: async () => undefined,
      loadSensitive: async (_namespace, sessionId) => sessionId === "marked"
    });
    await recorded.loadMessages("ns", "marked");
    expect(await recorded.loadSensitive!("ns", "marked")).toBe(true);
    await recorded.loadMessages("ns", "plain");
    expect(await recorded.loadSensitive!("ns", "plain")).toBe(false);
    const seed = capture.toSeed()!;
    expect(seed.sessions.map((session) => [session.sessionId, session.sensitive === true])).toEqual([["marked", true], ["plain", false]]);

    const sandbox = createReplaySandbox(seed);
    expect(await sandbox.memoryStore.loadSensitive!("ns", "marked")).toBe(true);
    expect(await sandbox.memoryStore.loadSensitive!("ns", "plain")).toBe(false);
    // A marked save stays marked in the sandbox; a later unmarked one does not clear it (as in the store).
    await sandbox.memoryStore.saveMessages("ns", "plain", [{ role: "user", content: "x" }], { sensitive: true });
    await sandbox.memoryStore.saveMessages("ns", "plain", [{ role: "user", content: "y" }]);
    expect(await sandbox.memoryStore.loadSensitive!("ns", "plain")).toBe(true);
    // Sensitive labels count as a mark too.
    await sandbox.memoryStore.saveMessages("ns", "labelled", [{ role: "user", content: "z" }], { labels: { provenance: ["sensitive"], dataClasses: [], source: "propagated" } });
    expect(await sandbox.memoryStore.loadSensitive!("ns", "labelled")).toBe(true);

    const tool = await sandbox.toolDataStore.saveToolCall({ namespace: "ns", sessionId: "s1", toolName: "t", args: {}, output: 1, sensitive: true });
    expect((await sandbox.toolDataStore.listToolCalls({ namespace: "ns", sessionId: "s1" }))[0]?.sensitive).toBe(true);
    expect((await sandbox.toolDataStore.getToolCall({ namespace: "ns", sessionId: "s1", id: tool.id }))?.sensitive).toBe(true);
    await sandbox.sessionArtifactStore.saveArtifact({ namespace: "ns", sessionId: "s1", artifactKey: "a", value: 1, sensitive: true });
    await sandbox.sessionArtifactStore.saveArtifact({ namespace: "ns", sessionId: "s1", artifactKey: "a", value: 2 });
    expect((await sandbox.sessionArtifactStore.loadArtifact({ namespace: "ns", sessionId: "s1", artifactKey: "a" }))?.sensitive).toBe(true);
  });
});
