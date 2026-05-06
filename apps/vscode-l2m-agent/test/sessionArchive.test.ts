import { describe, expect, it } from "vitest";
import {
  applyMessageToSession,
  cloneSessionAsBranch,
  createChatSession,
  inferSessionTitle,
  limitSessionsKeepingActive,
  normalizeSessions,
  summarizeSessions
} from "../src/sessionArchive";
import type { ChatMessage } from "../src/protocol";

describe("session archive", () => {
  it("infers the session title from the first user message", () => {
    const messages = [
      makeMessage("system", "Started new session"),
      makeMessage("user", "Please review the VS Code agent session memory behavior")
    ];

    expect(inferSessionTitle(messages)).toBe("Please review the VS Code agent session memory behavior");
  });

  it("updates title and message count when a first user message is appended", () => {
    const session = createChatSession("s1", "2026-01-01T00:00:00.000Z");
    const updated = applyMessageToSession(
      session,
      makeMessage("user", "Add persistent session history to the agent"),
      100
    );

    expect(updated.title).toBe("Add persistent session history to the agent");
    expect(updated.messages).toHaveLength(1);
    expect(summarizeSessions([updated])[0]).toMatchObject({
      id: "s1",
      messageCount: 1,
      lastMessageText: "Add persistent session history to the agent"
    });
  });

  it("keeps the active session when limiting archived sessions", () => {
    const sessions = [
      createChatSession("old-active", "2026-01-01T00:00:00.000Z", { updatedAt: "2026-01-01T00:00:00.000Z" }),
      createChatSession("newer-1", "2026-01-02T00:00:00.000Z", { updatedAt: "2026-01-02T00:00:00.000Z" }),
      createChatSession("newer-2", "2026-01-03T00:00:00.000Z", { updatedAt: "2026-01-03T00:00:00.000Z" })
    ];

    expect(limitSessionsKeepingActive(sessions, "old-active", 2).map((session) => session.id)).toEqual([
      "old-active",
      "newer-2"
    ]);
  });

  it("branches a session with a fresh id while copying local memory", () => {
    const source = createChatSession("s1", "2026-01-01T00:00:00.000Z", {
      title: "Original",
      messages: [makeMessage("user", "remember this")],
      memory: {
        compactedMemory: "durable fact",
        compactedThroughMessageId: "m1",
        compactedThroughCreatedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    });

    const branch = cloneSessionAsBranch(source, "s2", "2026-01-02T00:00:00.000Z");

    expect(branch.id).toBe("s2");
    expect(branch.title).toBe("Original branch");
    expect(branch.messages).toEqual(source.messages);
    expect(branch.messages).not.toBe(source.messages);
    expect(branch.memory.compactedMemory).toBe("durable fact");
  });

  it("normalizes stored sessions and drops malformed records", () => {
    const sessions = normalizeSessions([
      { id: "s1", title: "Stored", messages: [makeMessage("user", "hello")] },
      { title: "missing id" }
    ]);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: "s1",
      title: "Stored",
      messages: [{ text: "hello" }]
    });
  });
});

function makeMessage(role: ChatMessage["role"], text: string): ChatMessage {
  return {
    id: `m-${role}-${text.length}`,
    role,
    text,
    createdAt: "2026-01-01T00:00:00.000Z",
    variant: "normal"
  };
}
