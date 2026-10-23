import { describe, expect, it } from "vitest";
import type { KnowledgeBaseStore } from "@ai-orchestrator/workflow-engine";
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
    expect(wrapped.listKnowledgeBaseChunks("kb1")).toEqual([]);
    expect(reads).toEqual(["kb1"]);
    expect(wrapped.getKnowledgeBase("kb1")).toMatchObject({ id: "kb1" });
    expect(await createReplaySandbox().onMcpElicitation()).toEqual({ action: "decline" });
  });
});
