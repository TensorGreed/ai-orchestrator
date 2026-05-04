import { describe, expect, it } from "vitest";
import { ContextBudget } from "../src/contextBudget";
import {
  buildSessionMemorySnapshot,
  compactSessionMemory,
  EMPTY_SESSION_MEMORY,
  mergeContextUpdate
} from "../src/sessionMemory";
import type { ChatMessage } from "../src/protocol";

describe("ContextBudget", () => {
  it("truncates individual items at per-item limits", () => {
    const budget = new ContextBudget(100);
    const result = budget.take("activeFile.nearby", "a".repeat(50), 12);

    expect(result.truncated).toBe(true);
    expect(result.originalChars).toBe(50);
    expect(result.includedChars).toBe(12);
    expect(result.text).toHaveLength(12);
    expect(budget.toJSON()).toMatchObject({
      usedChars: 12,
      truncated: true,
      truncatedItems: ["activeFile.nearby"]
    });
  });

  it("enforces total context limits across multiple items", () => {
    const budget = new ContextBudget(20);

    expect(budget.take("first", "1234567890", 20)).toMatchObject({
      truncated: false,
      includedChars: 10
    });
    expect(budget.take("second", "abcdefghijklmnopqrstuvwxyz", 20)).toMatchObject({
      truncated: true,
      includedChars: 10
    });
    expect(budget.toJSON()).toMatchObject({
      maxChars: 20,
      usedChars: 20,
      remainingChars: 0,
      truncated: true
    });
  });
});

describe("session memory compaction", () => {
  it("summarizes messages older than the recent-turn window", () => {
    const messages = makeMessages(["one", "two", "three", "four"]);
    const result = compactSessionMemory(messages, EMPTY_SESSION_MEMORY, {
      recentTurnCount: 2,
      maxCompactedMemoryChars: 5000
    });

    expect(result.compactedCount).toBe(2);
    expect(result.state.compactedMemory).toContain("one");
    expect(result.state.compactedMemory).toContain("two");
    expect(result.state.compactedThroughMessageId).toBe("m2");

    const snapshot = buildSessionMemorySnapshot(messages, result.state, {
      recentTurnCount: 2,
      maxCompactedMemoryChars: 5000
    });
    expect(snapshot.recentTurns.map((turn) => turn.text)).toEqual(["three", "four"]);
  });

  it("does not compact the same messages twice", () => {
    const messages = makeMessages(["one", "two", "three", "four"]);
    const first = compactSessionMemory(messages, EMPTY_SESSION_MEMORY, {
      recentTurnCount: 2,
      maxCompactedMemoryChars: 5000
    });
    const second = compactSessionMemory(messages, first.state, {
      recentTurnCount: 2,
      maxCompactedMemoryChars: 5000
    });

    expect(second.compactedCount).toBe(0);
    expect(second.state.compactedMemory).toBe(first.state.compactedMemory);
  });

  it("merges L2M context updates without duplicating repeated updates", () => {
    const first = mergeContextUpdate(EMPTY_SESSION_MEMORY, "Keep the nightly report contract stable.", 5000);
    const second = mergeContextUpdate(first, "Keep the nightly report contract stable.", 5000);

    expect(first.compactedMemory).toContain("Keep the nightly report contract stable.");
    expect(second.compactedMemory).toBe(first.compactedMemory);
  });
});

function makeMessages(texts: string[]): ChatMessage[] {
  return texts.map((text, index) => ({
    id: `m${index + 1}`,
    role: index % 2 === 0 ? "user" : "assistant",
    text,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    variant: "normal"
  }));
}
