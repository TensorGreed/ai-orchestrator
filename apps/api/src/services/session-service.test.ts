/**
 * 13.2 — the session service: issueSession records how a session was issued, the request context round-trips, and
 * nothing outside it saves a session.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createTestStore, type TestStore } from "../test-support/test-store.js";
import {
  SESSION_ID_FORMAT,
  SESSION_IP_MAX,
  SESSION_TOUCH_MAP_MAX,
  SESSION_USER_AGENT_MAX,
  SessionService,
  isPolicyExempt,
  newSessionId,
  sessionRequestFields
} from "./session-service.js";
import { AuthService } from "./auth-service.js";
import type { Store } from "../db/store.js";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const stores: TestStore[] = [];

afterEach(async () => {
  for (const test of stores.splice(0)) await test.cleanup();
});

async function setup() {
  const test = await createTestStore({ kind: "sqlite" });
  stores.push(test);
  await test.store.saveUser({ id: "u1", email: "u1@example.com", passwordHash: "x", role: "admin" });
  return test.store;
}

describe("SessionService.issueSession", () => {
  it("records the method, address, user agent, MFA time and break-glass flag, with the TTL as expiry", async () => {
    const store = await setup();
    const now = Date.parse("2026-11-09T10:00:00.000Z");
    const sessions = new SessionService(store, { ttlHours: 24, now: () => now });
    const issued = await sessions.issueSession({
      user: { id: "u1" },
      method: "oidc",
      request: { ip: "203.0.113.7", headers: { "user-agent": "Mozilla/5.0 test" } },
      mfaVerified: true
    });
    expect(issued.sessionId).toMatch(SESSION_ID_FORMAT);
    expect(issued.expiresAt).toBe("2026-11-10T10:00:00.000Z");
    expect(await store.getSession(issued.sessionId)).toEqual({
      id: issued.sessionId,
      userId: "u1",
      expiresAt: "2026-11-10T10:00:00.000Z",
      createdAt: expect.stringMatching(ISO),
      lastSeenAt: expect.stringMatching(ISO),
      revokedAt: null,
      authMethod: "oidc",
      ipAddress: "203.0.113.7",
      userAgent: "Mozilla/5.0 test",
      mfaVerifiedAt: "2026-11-09T10:00:00.000Z",
      breakGlass: false,
      endedReason: null
    });
  });

  it("defaults: no request, no MFA, not break-glass; a TTL override and a break-glass flag are kept", async () => {
    const store = await setup();
    const sessions = new SessionService(store, { ttlHours: 168 });
    const bare = await sessions.issueSession({ user: { id: "u1" }, method: "password" });
    expect(await store.getSession(bare.sessionId)).toMatchObject({ authMethod: "password", ipAddress: null, userAgent: null, mfaVerifiedAt: null, breakGlass: false });
    const hours = (Date.parse(bare.expiresAt) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(167.9);
    expect(hours).toBeLessThanOrEqual(168);

    // The flag follows the method only, and a break-glass session is capped at one hour whatever TTL is asked for.
    const glass = await sessions.issueSession({ user: { id: "u1" }, method: "break_glass", ttlHours: 24 });
    const stored = await store.getSession(glass.sessionId);
    expect(stored).toMatchObject({ authMethod: "break_glass", breakGlass: true });
    expect(isPolicyExempt(stored)).toBe(true);
    expect(isPolicyExempt(await store.getSession(bare.sessionId))).toBe(false);
    expect(isPolicyExempt(null)).toBe(false);
    expect((Date.parse(glass.expiresAt) - Date.now()) / 3_600_000).toBeLessThanOrEqual(1);
  });

  it("ends expired sessions on the way (reason expired) and endSession records its reason", async () => {
    const store = await setup();
    await store.saveSession({ id: "sess_old_old_old_old_old_old_old", userId: "u1", expiresAt: "2000-01-01T00:00:00.000Z" });
    const sessions = new SessionService(store, { ttlHours: 1 });
    const issued = await sessions.issueSession({ user: { id: "u1" }, method: "ldap" });
    expect(await store.getSession("sess_old_old_old_old_old_old_old")).toMatchObject({ revokedAt: expect.stringMatching(ISO), endedReason: "expired" });
    expect(await sessions.endSession(issued.sessionId, "admin")).toBe(true);
    expect(await sessions.endSession(issued.sessionId, "logout")).toBe(false);
    expect(await sessions.endSession("", "logout")).toBe(false);
    expect((await store.getSession(issued.sessionId))?.endedReason).toBe("admin");
  });

  it("only the break_glass method sets the break-glass flag", async () => {
    const store = await setup();
    const sessions = new SessionService(store, { ttlHours: 24 });
    for (const method of ["password", "oidc", "saml", "ldap"] as const) {
      const issued = await sessions.issueSession({ user: { id: "u1" }, method, ttlHours: 24 });
      expect(issued.session.breakGlass).toBe(false);
      expect((Date.parse(issued.expiresAt) - Date.now()) / 3_600_000).toBeGreaterThan(23);
    }
  });

  it("a failing expired-session sweep is logged and the sign-in goes ahead", async () => {
    const store = await setup();
    const failing = new Proxy(store, {
      get(target, property, receiver) {
        if (property === "revokeExpiredSessions") return async () => { throw new Error("database busy"); };
        return Reflect.get(target, property, receiver);
      }
    });
    const warnings: Array<{ details: Record<string, unknown>; message: string }> = [];
    const sessions = new SessionService(failing, { ttlHours: 1 });
    sessions.setLogger({ warn: (details, message) => warnings.push({ details, message }) });
    const issued = await sessions.issueSession({ user: { id: "u1" }, method: "password" });
    expect(await store.getSession(issued.sessionId)).toMatchObject({ userId: "u1" });
    expect(warnings).toEqual([{ details: { reason: "database busy" }, message: "Expired-session sweep failed; signing in anyway" }]);
    // Without a logger it still signs in.
    await expect(new SessionService(failing, { ttlHours: 1 }).issueSession({ user: { id: "u1" }, method: "password" })).resolves.toBeTruthy();
  });

  it("refuses a session for a user that does not exist", async () => {
    const store = await setup();
    const sessions = new SessionService(store, { ttlHours: 1 });
    await expect(sessions.issueSession({ user: { id: "nobody" }, method: "password" })).rejects.toThrow();
  });
});

describe("request fields and IDs", () => {
  it("takes the address and a trimmed, cut user agent; absent values are null", () => {
    expect(sessionRequestFields(undefined)).toEqual({ ipAddress: null, userAgent: null });
    expect(sessionRequestFields({ ip: "", headers: {} })).toEqual({ ipAddress: null, userAgent: null });
    expect(sessionRequestFields({ ip: "::1", headers: { "user-agent": ["  agent  "] } })).toEqual({ ipAddress: "::1", userAgent: "agent" });
    expect(sessionRequestFields({ headers: { "user-agent": "x".repeat(2000) } }).userAgent).toHaveLength(SESSION_USER_AGENT_MAX);
    // Only a valid IPv4 or IPv6 address of at most 45 characters is kept (X-Forwarded-For is client-supplied).
    expect(sessionRequestFields({ ip: "203.0.113.7" }).ipAddress).toBe("203.0.113.7");
    expect(sessionRequestFields({ ip: "::ffff:203.0.113.7" }).ipAddress).toBe("::ffff:203.0.113.7");
    expect(sessionRequestFields({ ip: "0000:0000:0000:0000:0000:ffff:203.000.113.007" }).ipAddress).toBeNull();
    expect(sessionRequestFields({ ip: "not-an-ip" }).ipAddress).toBeNull();
    expect(sessionRequestFields({ ip: "1.2.3.4, 5.6.7.8" }).ipAddress).toBeNull();
    expect(sessionRequestFields({ ip: "x".repeat(16_000) }).ipAddress).toBeNull();
    expect(SESSION_IP_MAX).toBe(45);
  });

  it("new IDs match the session ID format and differ", () => {
    const a = newSessionId();
    expect(a).toMatch(SESSION_ID_FORMAT);
    expect(newSessionId()).not.toBe(a);
  });
});

describe("request context", () => {
  it("looks a request's session up once, skips malformed IDs, and keeps the auth context per request", async () => {
    const store = await setup();
    const sessions = new SessionService(store, { ttlHours: 1 });
    const issued = await sessions.issueSession({ user: { id: "u1" }, method: "password" });
    let lookups = 0;
    const counting = new Proxy(store, {
      get(target, property, receiver) {
        if (property === "getSession") return (id: string) => { lookups += 1; return target.getSession(id); };
        return Reflect.get(target, property, receiver);
      }
    });
    const service = new SessionService(counting, { ttlHours: 1 });
    const request = {};
    expect((await service.getRequestSession(request, issued.sessionId))?.id).toBe(issued.sessionId);
    expect((await service.getRequestSession(request, issued.sessionId))?.id).toBe(issued.sessionId);
    expect(lookups).toBe(1);
    expect(await service.getRequestSession({}, "not-a-session")).toBeNull();
    expect(lookups).toBe(1);

    const user = { id: "u1", email: "u1@example.com", role: "admin" as const };
    expect(service.getRequestAuth(request)).toBeUndefined();
    const session = (await store.getSession(issued.sessionId))!;
    service.setRequestAuth(request, { credential: "session", user, session });
    expect(service.getRequestAuth(request)).toEqual({ credential: "session", user, session });
    expect(service.getRequestAuth({})).toBeUndefined();
  });
});

describe("AuthService on the session service", () => {
  it("login issues a password session; getSessionAuth returns the row; an expired one ends with reason expired; logout records logout", async () => {
    const test = await createTestStore({ kind: "sqlite" });
    stores.push(test);
    const auth = new AuthService(test.store, 24);
    await auth.register({ email: "ana@example.com", password: "Ana-Pass-123!", role: "builder" });
    await expect(auth.verifyCredentials("ana@example.com", "wrong")).rejects.toThrow("Invalid email or password");
    expect(await auth.verifyCredentials(" ANA@example.com ", "Ana-Pass-123!")).toMatchObject({ email: "ana@example.com", role: "builder" });

    const { sessionId } = await auth.login("ana@example.com", "Ana-Pass-123!", { ip: "198.51.100.2", headers: { "user-agent": "cli" } });
    const resolved = await auth.getSessionAuth(sessionId);
    expect(resolved?.user.email).toBe("ana@example.com");
    expect(resolved?.session).toMatchObject({ id: sessionId, authMethod: "password", ipAddress: "198.51.100.2", userAgent: "cli" });
    expect(await auth.getSessionUser(sessionId)).toMatchObject({ email: "ana@example.com" });

    const expired = { ...resolved!.session, expiresAt: "2000-01-01T00:00:00.000Z" };
    expect(await auth.getSessionAuth(sessionId, expired)).toBeNull();
    expect((await test.store.getSession(sessionId))?.endedReason).toBe("expired");

    const second = await auth.login("ana@example.com", "Ana-Pass-123!");
    await auth.logout(second.sessionId);
    expect(await test.store.getSession(second.sessionId)).toMatchObject({ revokedAt: expect.stringMatching(ISO), endedReason: "logout" });
    expect(await auth.getSessionAuth(second.sessionId)).toBeNull();
  });
});

describe("one session-issuing path", () => {
  it("nothing outside the stores and session-service.ts calls saveSession", () => {
    const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const allowed = new Set(["services/session-service.ts", "db/database.ts", "db/postgres/sessions.ts", "db/postgres-store.ts", "db/store.ts"]);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules") walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts") || /\.test(-helper)?\.ts$/.test(entry.name) || entry.name.endsWith(".test-helper.ts")) continue;
        const relative = path.relative(src, full).split(path.sep).join("/");
        if (allowed.has(relative)) continue;
        if (/\bsaveSession\s*\(/.test(fs.readFileSync(full, "utf8"))) offenders.push(relative);
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});

describe("touch throttle map", () => {
  it("never holds more than SESSION_TOUCH_MAP_MAX sessions, even when all are active within one minute", async () => {
    const touched: string[] = [];
    const store = { touchSession: async (id: string) => void touched.push(id) } as unknown as Store;
    const service = new SessionService(store, { ttlHours: 1, now: () => 1_000_000 });
    for (let i = 0; i < SESSION_TOUCH_MAP_MAX + 50; i += 1) await service.recordActivity(`sess_${i}`);
    expect(service.touchedSessionCount).toBe(SESSION_TOUCH_MAP_MAX);
    expect(touched).toHaveLength(SESSION_TOUCH_MAP_MAX + 50);
    // A remembered session is still throttled; background requests never write.
    await service.recordActivity(`sess_${SESSION_TOUCH_MAP_MAX + 49}`);
    await service.recordActivity("sess_new", { background: true });
    expect(touched).toHaveLength(SESSION_TOUCH_MAP_MAX + 50);
  });
});
