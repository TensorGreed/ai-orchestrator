/**
 * The inbound-trace trust check asks "is this caller signed in?" before the route runs. It must be a check only: no
 * recorded key or token use, no session activity, and no session ended (the route's own sign-in check does those).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestStore, type TestStore } from "../test-support/test-store.js";
import { ApiKeyService } from "../services/api-key-service.js";
import { AuthService } from "../services/auth-service.js";
import { McpClientService } from "../services/mcp-client-service.js";
import { SessionService } from "../services/session-service.js";

const stores: TestStore[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const test of stores.splice(0)) await test.cleanup();
});

async function setup() {
  const test = await createTestStore({ kind: "sqlite" });
  stores.push(test);
  await test.store.saveUser({ id: "u1", email: "u1@example.com", passwordHash: "x", role: "admin" });
  return test.store;
}

describe("side-effect-free credential checks", () => {
  it("ApiKeyService.check accepts a live key without recording its use", async () => {
    const store = await setup();
    const keys = new ApiKeyService(store);
    const { plaintext, record } = await keys.create({ userId: "u1", name: "otel" });
    const touch = vi.spyOn(store, "touchApiKey");
    expect(await keys.check(plaintext)).toBe(true);
    expect(await keys.check(`${plaintext}x`)).toBe(false);
    expect(await keys.check("not-a-key")).toBe(false);
    expect(touch).not.toHaveBeenCalled();
    await keys.revoke(record.id);
    expect(await keys.check(plaintext)).toBe(false);
    expect(await keys.verify(`${plaintext}x`)).toBeNull();
  });

  it("McpClientService.check accepts a live token without recording its use", async () => {
    const store = await setup();
    const clients = new McpClientService(store);
    const { token } = await clients.create({
      name: "otel",
      toolsetIds: [],
      role: "viewer",
      createdBy: "u1",
      createdByEmail: "u1@example.com",
      expiresAt: null
    });
    const touch = vi.spyOn(store, "touchMcpClient");
    expect(await clients.check(token)).toBe(true);
    expect(await clients.check(`${token}x`)).toBe(false);
    expect(touch).not.toHaveBeenCalled();
    expect((await clients.verify(token)).ok).toBe(true);
    expect(touch).toHaveBeenCalledTimes(1);
  });

  it("AuthService.checkSession neither records activity nor ends a session that has run out", async () => {
    const store = await setup();
    let now = Date.parse("2026-11-12T10:00:00.000Z");
    const sessions = new SessionService(store, { ttlHours: 24, now: () => now });
    const auth = new AuthService(store, 24, sessions);
    const issued = await sessions.issueSession({ user: { id: "u1" }, method: "password" });
    const before = await store.getSession(issued.sessionId);
    const activity = vi.spyOn(sessions, "recordActivity");
    const end = vi.spyOn(sessions, "endSession");

    now += 60_000;
    expect(await auth.checkSession(issued.sessionId)).toBe(true);
    expect(await auth.checkSession("")).toBe(false);
    expect(await auth.checkSession("missing")).toBe(false);

    now += 48 * 3_600_000;
    expect(await auth.checkSession(issued.sessionId)).toBe(false);
    expect(activity).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
    expect(await store.getSession(issued.sessionId)).toEqual(before);
  });
});
