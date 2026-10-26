/**
 * Phase 13.1 — store contract: login sessions, session memory, the session tool cache and artifacts, webhook security
 * state and trigger state, on both stores.
 */
import { expect, it } from "vitest";
import { describeStoreContract } from "../../test-support/test-store.js";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describeStoreContract("store contract: sessions, webhooks and triggers", (ctx) => {
  it("login sessions: save, touch, revoke, expire", async () => {
    const store = ctx.store();
    await store.saveUser({ id: "u1", email: "u1@example.com", passwordHash: "x", role: "admin" });
    const saved = await store.saveSession({ id: "s1", userId: "u1", expiresAt: "2099-01-01T00:00:00.000Z" });
    expect(saved).toEqual({ id: "s1", userId: "u1", expiresAt: "2099-01-01T00:00:00.000Z", createdAt: expect.stringMatching(ISO), lastSeenAt: expect.stringMatching(ISO) });
    expect(await store.getSession("s1")).toMatchObject({ id: "s1", userId: "u1", revokedAt: null });
    await store.touchSession("s1");
    await store.saveSession({ id: "s2", userId: "u1", expiresAt: "2000-01-01T00:00:00.000Z" });
    await store.revokeExpiredSessions();
    expect((await store.getSession("s2"))?.revokedAt).toMatch(ISO);
    expect((await store.getSession("s1"))?.revokedAt).toBeNull();
    await store.revokeSession("s1");
    expect((await store.getSession("s1"))?.revokedAt).toMatch(ISO);
    expect(await store.getSession("missing")).toBeNull();
    expect(await store.deleteUser("u1")).toBe(true);
    expect(await store.getSession("s1")).toBeNull();
  });

  it("session memory round-trips and keeps its creation time", async () => {
    const store = ctx.store();
    expect(await store.loadSessionMemory("ns", "s")).toEqual([]);
    await store.saveSessionMemory("ns", "s", [{ role: "user", content: "hi" }]);
    await store.saveSessionMemory("ns", "s", [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }]);
    expect((await store.loadSessionMemory("ns", "s")).map((m) => m.content)).toEqual(["hi", "hello"]);
    expect(await store.loadSessionMemory("ns", "other")).toEqual([]);
  });

  it("the tool cache lists newest first, filters by tool, reads one call, and keeps the newest 400 per session", async () => {
    const store = ctx.store();
    const first = await store.saveSessionToolCall({ namespace: "ns", sessionId: "s", toolName: "search", toolCallId: "tc1", args: { q: 1 }, output: { hits: 2 }, summary: "two" });
    expect(first).toMatchObject({ namespace: "ns", sessionId: "s", toolName: "search", toolCallId: "tc1", args: { q: 1 }, output: { hits: 2 }, summary: "two" });
    expect(first.createdAt).toMatch(ISO);
    await new Promise((resolve) => setTimeout(resolve, 3));
    await store.saveSessionToolCall({ namespace: "ns", sessionId: "s", toolName: "fetch", args: {}, output: null, error: "timeout" });
    const listed = await store.listSessionToolCalls({ namespace: "ns", sessionId: "s" });
    expect(listed.map((c) => c.toolName)).toEqual(["fetch", "search"]);
    expect(listed[0]).toMatchObject({ error: "timeout", toolCallId: undefined });
    expect(listed[0]).not.toHaveProperty("output");
    expect((await store.listSessionToolCalls({ namespace: "ns", sessionId: "s", toolName: "search" })).map((c) => c.id)).toEqual([first.id]);
    expect(await store.getSessionToolCall({ namespace: "ns", sessionId: "s", id: first.id })).toMatchObject({ output: { hits: 2 }, createdAt: first.createdAt });
    expect(await store.getSessionToolCall({ namespace: "ns", sessionId: "other", id: first.id })).toBeNull();

    // One call per millisecond: SQLite orders calls saved in the same millisecond by rowid within its index, so only
    // distinct times have one defined order on both stores.
    for (let i = 0; i < 405; i += 1) {
      const before = Date.now();
      while (Date.now() === before) await new Promise((resolve) => setImmediate(resolve));
      await store.saveSessionToolCall({ namespace: "ns", sessionId: "cap", toolName: `t${i}`, args: {}, output: i });
    }
    const kept = await store.listSessionToolCalls({ namespace: "ns", sessionId: "cap", limit: 200 });
    expect(kept).toHaveLength(200);
    expect(kept[0]?.toolName).toBe("t404");
    const oldestKept = await store.listSessionToolCalls({ namespace: "ns", sessionId: "cap", toolName: "t5" });
    expect(oldestKept).toHaveLength(1);
    expect(await store.listSessionToolCalls({ namespace: "ns", sessionId: "cap", toolName: "t4" })).toEqual([]);
    expect(await store.listSessionToolCalls({ namespace: "ns", sessionId: "s", limit: 0 })).toHaveLength(2);
  });

  it("session artifacts upsert and keep their creation time", async () => {
    const store = ctx.store();
    const saved = await store.saveSessionArtifact({ namespace: "ns", sessionId: "s", artifactKey: "report", value: { v: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 3));
    const again = await store.saveSessionArtifact({ namespace: "ns", sessionId: "s", artifactKey: "report", value: { v: 2 } });
    expect(again.createdAt).toBe(saved.createdAt);
    expect(await store.loadSessionArtifact({ namespace: "ns", sessionId: "s", artifactKey: "report" })).toMatchObject({ value: { v: 2 }, createdAt: saved.createdAt });
    expect(await store.loadSessionArtifact({ namespace: "ns", sessionId: "s", artifactKey: "missing" })).toBeNull();
  });

  it("webhook replay keys and idempotency records; expired ones are cleared", async () => {
    const store = ctx.store();
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(await store.saveWebhookReplayKey({ replayKey: "fp", endpointKey: "ep", expiresAt: future })).toBe(true);
    expect(await store.saveWebhookReplayKey({ replayKey: "fp", endpointKey: "ep", expiresAt: future })).toBe(false);
    expect(await store.hasWebhookReplayKey("fp")).toBe(true);
    await store.saveWebhookIdempotencyPending({ endpointKey: "ep", idempotencyKey: "k1", requestHash: "h", expiresAt: future });
    await expect(store.saveWebhookIdempotencyPending({ endpointKey: "ep", idempotencyKey: "k1", requestHash: "h", expiresAt: future })).rejects.toThrow();
    expect(await store.getWebhookIdempotency({ endpointKey: "ep", idempotencyKey: "k1" })).toMatchObject({ status: "pending", result: null, requestHash: "h" });
    await store.saveWebhookIdempotencyResult({ endpointKey: "ep", idempotencyKey: "k1", status: "success", result: { ok: true } });
    expect(await store.getWebhookIdempotency({ endpointKey: "ep", idempotencyKey: "k1" })).toMatchObject({ status: "success", result: { ok: true } });
    await store.saveWebhookReplayKey({ replayKey: "old", endpointKey: "ep", expiresAt: "2000-01-01T00:00:00.000Z" });
    await store.clearExpiredWebhookSecurityState();
    expect(await store.hasWebhookReplayKey("old")).toBe(false);
    expect(await store.hasWebhookReplayKey("fp")).toBe(true);
    expect(await store.getWebhookIdempotency({ endpointKey: "ep", idempotencyKey: "missing" })).toBeNull();
  });

  it("trigger state saves, replaces and deletes per workflow", async () => {
    const store = ctx.store();
    expect(await store.getTriggerState("wf", "n1")).toBeNull();
    await store.saveTriggerState({ workflowId: "wf", nodeId: "n1", triggerType: "rss", state: { last: 1 } });
    await store.saveTriggerState({ workflowId: "wf", nodeId: "n1", triggerType: "rss", state: { last: 2 } });
    expect(await store.getTriggerState("wf", "n1")).toEqual({ last: 2 });
    await store.deleteTriggerStatesForWorkflow("wf");
    expect(await store.getTriggerState("wf", "n1")).toBeNull();
  });
});
