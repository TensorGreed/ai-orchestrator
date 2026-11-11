/**
 * Phase 13.1 — store contract: login sessions, session memory, the session tool cache and artifacts, webhook security
 * state and trigger state, on both stores.
 */
import { afterEach, expect, it, vi } from "vitest";
import { describeStoreContract } from "../../test-support/test-store.js";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

afterEach(() => {
  vi.useRealTimers();
});

describeStoreContract("store contract: sessions, webhooks and triggers", (ctx) => {
  it("login sessions: save, touch, revoke, expire", async () => {
    const store = ctx.store();
    await store.saveUser({ id: "u1", email: "u1@example.com", passwordHash: "x", role: "admin" });
    const saved = await store.saveSession({ id: "s1", userId: "u1", expiresAt: "2099-01-01T00:00:00.000Z" });
    expect(saved).toEqual({
      id: "s1",
      userId: "u1",
      expiresAt: "2099-01-01T00:00:00.000Z",
      createdAt: expect.stringMatching(ISO),
      lastSeenAt: expect.stringMatching(ISO),
      revokedAt: null,
      authMethod: null,
      ipAddress: null,
      userAgent: null,
      mfaVerifiedAt: null,
      breakGlass: false,
      endedReason: null
    });
    expect(await store.getSession("s1")).toEqual(saved);
    await store.touchSession("s1");
    await store.saveSession({ id: "s2", userId: "u1", expiresAt: "2000-01-01T00:00:00.000Z" });
    await store.revokeExpiredSessions();
    expect((await store.getSession("s2"))?.revokedAt).toMatch(ISO);
    expect((await store.getSession("s2"))?.endedReason).toBe("expired");
    expect((await store.getSession("s1"))?.revokedAt).toBeNull();
    expect(await store.revokeSession("s1")).toBe(true);
    expect(await store.revokeSession("s1", "logout")).toBe(false);
    expect((await store.getSession("s1"))?.revokedAt).toMatch(ISO);
    // Revoked without a reason (as before v61): the reason stays empty, and a second revoke does not overwrite it.
    expect((await store.getSession("s1"))?.endedReason).toBeNull();
    expect(await store.revokeSession("missing", "logout")).toBe(false);
    expect(await store.getSession("missing")).toBeNull();
    expect(await store.deleteUser("u1")).toBe(true);
    expect(await store.getSession("s1")).toBeNull();
  });

  it("v61 fields: saved and read back, MFA time marked on live sessions only", async () => {
    const store = ctx.store();
    await store.saveUser({ id: "u1", email: "u1@example.com", passwordHash: "x", role: "admin" });
    const saved = await store.saveSession({
      id: "s1",
      userId: "u1",
      expiresAt: "2099-01-01T00:00:00.000Z",
      authMethod: "saml",
      ipAddress: "2001:db8::1",
      userAgent: "agent/1.0",
      mfaVerifiedAt: "2026-11-09T10:00:00.000Z",
      breakGlass: true
    });
    expect(saved).toMatchObject({ authMethod: "saml", ipAddress: "2001:db8::1", userAgent: "agent/1.0", mfaVerifiedAt: "2026-11-09T10:00:00.000Z", breakGlass: true, endedReason: null });
    expect(await store.getSession("s1")).toEqual(saved);

    const mark = (id: string, userId: string, at: string) => store.markSessionMfaVerified(id, { userId, at });
    // Only the session's own user, and only while it is live.
    expect(await mark("s1", "u2", "2026-11-09T11:00:00.000Z")).toBe(false);
    expect(await mark("s1", "u1", "2026-11-09T11:30:00.000Z")).toBe(true);
    expect((await store.getSession("s1"))?.mfaVerifiedAt).toBe("2026-11-09T11:30:00.000Z");
    expect(await store.clearSessionMfaVerified("s1")).toBe(true);
    expect((await store.getSession("s1"))?.mfaVerifiedAt).toBeNull();
    expect(await store.clearSessionMfaVerified("missing")).toBe(false);
    expect(await mark("s1", "u1", "2026-11-09T11:30:00.000Z")).toBe(true);
    await store.saveSession({ id: "s-expired", userId: "u1", expiresAt: "2000-01-01T00:00:00.000Z" });
    expect(await mark("s-expired", "u1", "2026-11-09T11:30:00.000Z")).toBe(false);
    expect((await store.getSession("s-expired"))?.mfaVerifiedAt).toBeNull();

    // Ending a session clears its address and user agent; the reason and times stay.
    expect(await store.revokeSession("s1", "policy")).toBe(true);
    expect(await store.getSession("s1")).toMatchObject({ endedReason: "policy", ipAddress: null, userAgent: null, authMethod: "saml" });
    expect(await mark("s1", "u1", "2026-11-09T12:00:00.000Z")).toBe(false);
    expect((await store.getSession("s1"))?.mfaVerifiedAt).toBe("2026-11-09T11:30:00.000Z");
    expect(await mark("missing", "u1", "2026-11-09T12:00:00.000Z")).toBe(false);
  });

  it("every way a session ends clears its address and user agent", async () => {
    const store = ctx.store();
    await store.saveUser({ id: "u1", email: "u1@example.com", passwordHash: "x", role: "admin" });
    const personal = { ipAddress: "203.0.113.9", userAgent: "agent" };
    const future = "2099-01-01T00:00:00.000Z";
    await store.saveSession({ id: "expired", userId: "u1", expiresAt: "2000-01-01T00:00:00.000Z", ...personal });
    await store.saveSession({ id: "logout", userId: "u1", expiresAt: future, ...personal });
    await store.saveSession({ id: "all-1", userId: "u1", expiresAt: future, ...personal });
    await new Promise((resolve) => setTimeout(resolve, 3));
    await store.saveSession({ id: "evict", userId: "u1", expiresAt: future, ...personal });
    await new Promise((resolve) => setTimeout(resolve, 3));
    await store.saveSession({ id: "keep", userId: "u1", expiresAt: future, ...personal });

    await store.revokeExpiredSessions();
    await store.revokeSession("logout", "logout");
    expect(await store.revokeOldestUserSessions("u1", 2, "evicted", { protectId: "keep" })).toEqual(["all-1"]);
    expect(await store.revokeUserSessions("u1", { exceptId: "keep", reason: "admin" })).toBe(1);
    const rows = Object.fromEntries((await store.listUserSessions("u1")).map((row) => [row.id, row]));
    for (const id of ["expired", "logout", "all-1", "evict"]) {
      expect(rows[id]).toMatchObject({ ipAddress: null, userAgent: null, revokedAt: expect.stringMatching(ISO) });
    }
    expect(rows.evict?.endedReason).toBe("admin");
    expect(rows.keep).toMatchObject({ ...personal, revokedAt: null });
  });

  it("purgeEndedSessions deletes sessions that ended before the cutoff and keeps the rest", async () => {
    const store = ctx.store();
    await store.saveUser({ id: "u1", email: "u1@example.com", passwordHash: "x", role: "admin" });
    await store.saveSession({ id: "live", userId: "u1", expiresAt: "2099-01-01T00:00:00.000Z" });
    await store.saveSession({ id: "revoked-now", userId: "u1", expiresAt: "2099-01-01T00:00:00.000Z" });
    await store.saveSession({ id: "expired-long-ago", userId: "u1", expiresAt: "2001-01-01T00:00:00.000Z" });
    await store.saveSession({ id: "expired-recently", userId: "u1", expiresAt: new Date(Date.now() - 1_000).toISOString() });
    await store.revokeSession("revoked-now", "logout");

    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    expect(await store.purgeEndedSessions(cutoff)).toBe(1);
    expect((await store.listUserSessions("u1")).map((row) => row.id).sort()).toEqual(["expired-recently", "live", "revoked-now"]);
    // Everything that has ended by now goes with a cutoff in the future; the live session stays.
    expect(await store.purgeEndedSessions("2050-01-01T00:00:00.000Z")).toBe(2);
    expect((await store.listUserSessions("u1")).map((row) => row.id)).toEqual(["live"]);
    expect(await store.purgeEndedSessions("2050-01-01T00:00:00.000Z")).toBe(0);
  });

  it("lists a user's sessions newest first, live only on request, and revokes all but one", async () => {
    const store = ctx.store();
    await store.saveUser({ id: "u1", email: "u1@example.com", passwordHash: "x", role: "admin" });
    await store.saveUser({ id: "u2", email: "u2@example.com", passwordHash: "x", role: "viewer" });
    const future = "2099-01-01T00:00:00.000Z";
    for (const id of ["a", "b", "c"]) {
      await store.saveSession({ id, userId: "u1", expiresAt: future });
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
    await store.saveSession({ id: "old", userId: "u1", expiresAt: "2000-01-01T00:00:00.000Z" });
    await store.saveSession({ id: "other", userId: "u2", expiresAt: future });
    await store.revokeSession("b", "logout");

    expect((await store.listUserSessions("u1")).map((s) => s.id)).toEqual(["old", "c", "b", "a"]);
    expect((await store.listUserSessions("u1", { liveOnly: true })).map((s) => s.id)).toEqual(["c", "a"]);
    // `now` decides what is live: in 1999 "old" had not expired yet.
    expect((await store.listUserSessions("u1", { liveOnly: true, now: "1999-01-01T00:00:00.000Z" })).map((s) => s.id)).toEqual(["old", "c", "a"]);
    expect(await store.listUserSessions("nobody")).toEqual([]);

    expect(await store.revokeUserSessions("u1", { exceptId: "c", reason: "admin" })).toBe(2);
    const after = Object.fromEntries((await store.listUserSessions("u1")).map((s) => [s.id, s.endedReason]));
    expect(after).toEqual({ old: "admin", c: null, b: "logout", a: "admin" });
    expect((await store.getSession("other"))?.revokedAt).toBeNull();
    expect(await store.revokeUserSessions("u1", { reason: "policy" })).toBe(1);
    expect((await store.getSession("c"))?.endedReason).toBe("policy");
    expect(await store.revokeUserSessions("u1", { reason: "policy" })).toBe(0);
  });

  it("revokeOldestUserSessions keeps the newest live sessions and ends the rest, oldest first", async () => {
    const store = ctx.store();
    await store.saveUser({ id: "u1", email: "u1@example.com", passwordHash: "x", role: "admin" });
    await store.saveUser({ id: "u2", email: "u2@example.com", passwordHash: "x", role: "viewer" });
    const future = "2099-01-01T00:00:00.000Z";
    for (const id of ["s1", "s2", "s3", "s4"]) {
      await store.saveSession({ id, userId: "u1", expiresAt: future });
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
    await store.saveSession({ id: "expired", userId: "u1", expiresAt: "2000-01-01T00:00:00.000Z" });
    await store.saveSession({ id: "theirs", userId: "u2", expiresAt: future });
    await store.revokeSession("s2", "logout");

    expect(await store.revokeOldestUserSessions("u1", 5, "evicted")).toEqual([]);
    expect(await store.revokeOldestUserSessions("u1", 2, "evicted")).toEqual(["s1"]);
    expect((await store.listUserSessions("u1", { liveOnly: true })).map((s) => s.id)).toEqual(["s4", "s3"]);
    expect((await store.getSession("s1"))?.endedReason).toBe("evicted");
    expect((await store.getSession("s2"))?.endedReason).toBe("logout");
    // Expired rows are not counted and not touched.
    expect((await store.getSession("expired"))?.revokedAt).toBeNull();
    expect(await store.revokeOldestUserSessions("u1", 0, "policy")).toEqual(["s3", "s4"]);
    expect(await store.listUserSessions("u1", { liveOnly: true })).toEqual([]);
    expect((await store.getSession("theirs"))?.revokedAt).toBeNull();
    expect(await store.revokeOldestUserSessions("nobody", 1, "evicted")).toEqual([]);
  });

  it("revokeOldestUserSessions never counts or ends a break-glass session", async () => {
    const store = ctx.store();
    await store.saveUser({ id: "u1", email: "u1@example.com", passwordHash: "x", role: "admin" });
    const future = "2099-01-01T00:00:00.000Z";
    await store.saveSession({ id: "old", userId: "u1", expiresAt: future });
    await store.saveSession({ id: "glass", userId: "u1", expiresAt: future, authMethod: "break_glass", breakGlass: true });
    await store.saveSession({ id: "new", userId: "u1", expiresAt: future });
    expect(await store.revokeOldestUserSessions("u1", 1, "evicted", { protectId: "new" })).toEqual(["old"]);
    expect(await store.revokeOldestUserSessions("u1", 0, "evicted")).toEqual(["new"]);
    expect((await store.getSession("glass"))?.revokedAt).toBeNull();
  });

  it("revokeOldestUserSessions never ends the protected session, also when it ties on created_at and loses the id tiebreak", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-09T12:00:00.000Z"));
    const store = ctx.store();
    await store.saveUser({ id: "u1", email: "u1@example.com", passwordHash: "x", role: "admin" });
    // Same millisecond: newest-first ranking by id puts "zz" first, so "aa" (the new one) would lose without protection.
    await store.saveSession({ id: "zz", userId: "u1", expiresAt: "2099-01-01T00:00:00.000Z" });
    await store.saveSession({ id: "aa", userId: "u1", expiresAt: "2099-01-01T00:00:00.000Z" });
    expect((await store.listUserSessions("u1")).map((s) => s.id)).toEqual(["zz", "aa"]);
    expect(await store.revokeOldestUserSessions("u1", 1, "evicted", { protectId: "aa" })).toEqual(["zz"]);
    expect((await store.listUserSessions("u1", { liveOnly: true })).map((s) => s.id)).toEqual(["aa"]);
    // keep 0 still spares the protected session; an unknown or ended protectId changes nothing.
    await store.saveSession({ id: "mm", userId: "u1", expiresAt: "2099-01-01T00:00:00.000Z" });
    expect(await store.revokeOldestUserSessions("u1", 0, "policy", { protectId: "aa" })).toEqual(["mm"]);
    expect(await store.revokeOldestUserSessions("u1", 0, "policy", { protectId: "zz" })).toEqual(["aa"]);
    expect(await store.listUserSessions("u1", { liveOnly: true })).toEqual([]);
  });

  it("concurrent revokeOldestUserSessions calls on one store leave exactly `keep` live sessions", async () => {
    const store = ctx.store();
    await store.saveUser({ id: "u1", email: "u1@example.com", passwordHash: "x", role: "admin" });
    for (let i = 0; i < 6; i += 1) await store.saveSession({ id: `r${i}`, userId: "u1", expiresAt: "2099-01-01T00:00:00.000Z" });
    const ended = await Promise.all(Array.from({ length: 4 }, () => store.revokeOldestUserSessions("u1", 2, "evicted")));
    expect(ended.flat().sort()).toHaveLength(4);
    expect(new Set(ended.flat()).size).toBe(4);
    expect(await store.listUserSessions("u1", { liveOnly: true })).toHaveLength(2);
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

  // Postgres only: SQLite has no tie-breaker after created_at here, so its order within one millisecond is the
  // index's (oldest first); recorded as a later SQLite change (q3a STATUS, "For later").
  it.runIf(ctx.kind === "postgres")("tool-cache calls saved within one millisecond are listed newest first and the cap keeps the newest", async () => {
    const store = ctx.store();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-26T12:00:00.000Z"));
    for (let i = 0; i < 405; i += 1) {
      await store.saveSessionToolCall({ namespace: "ns", sessionId: "tie", toolName: `t${i}`, args: {}, output: i });
    }
    const kept = await store.listSessionToolCalls({ namespace: "ns", sessionId: "tie", limit: 200 });
    expect(kept.slice(0, 3).map((c) => c.toolName)).toEqual(["t404", "t403", "t402"]);
    expect(new Set(kept.map((c) => c.createdAt))).toEqual(new Set(["2026-10-26T12:00:00.000Z"]));
    expect(await store.listSessionToolCalls({ namespace: "ns", sessionId: "tie", toolName: "t5" })).toHaveLength(1);
    expect(await store.listSessionToolCalls({ namespace: "ns", sessionId: "tie", toolName: "t4" })).toEqual([]);
  }, 60_000);

  it("concurrent tool-cache saves in one session: all kept, one stable newest-first order", async () => {
    const store = ctx.store();
    const saved = await Promise.all(
      Array.from({ length: 8 }, (_, i) => store.saveSessionToolCall({ namespace: "ns", sessionId: "race", toolName: `r${i}`, args: {}, output: i }))
    );
    const listed = await store.listSessionToolCalls({ namespace: "ns", sessionId: "race" });
    expect(new Set(listed.map((c) => c.id))).toEqual(new Set(saved.map((c) => c.id)));
    const times = listed.map((c) => Date.parse(c.createdAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(await store.listSessionToolCalls({ namespace: "ns", sessionId: "race" })).toEqual(listed);
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
