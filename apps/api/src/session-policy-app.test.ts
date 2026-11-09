/**
 * 13.2 L1 — session policy through the app: idle and absolute timeouts per role (the current role applies), background
 * requests that never count as activity, the per-user session limit that ends the oldest session, the signed-in
 * sessions API, and SSE streams that close when their session ends.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Workflow, WorkflowNode } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { AuthService, type UserRole } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import { sessionHandle } from "./services/session-service.js";
import { openTestStore } from "./test-support/test-store.js";

interface Booted {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function boot(env: Record<string, string> = {}): Promise<Booted> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-session-policy-"));
  const store = await openTestStore(path.join(dir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const masterKey = crypto.randomBytes(32).toString("base64");
  const config = parseConfig({
    LOG_LEVEL: "fatal",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: masterKey,
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(dir, "sync"),
    ...env
  });
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = await createApp(config, store, new SecretService(store, masterKey), authService);
  await app.ready();
  cleanups.push(async () => {
    await app.close();
    try {
      await store.close();
    } catch {
      // Already closed by the app.
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { app, store, authService };
}

function setCookies(header: string | string[] | number | undefined): string[] {
  return Array.isArray(header) ? header : typeof header === "string" ? [header] : [];
}

function sessionCookie(header: string | string[] | number | undefined): string {
  const found = setCookies(header).find((value) => value.startsWith("ao_session="));
  if (!found) throw new Error("no session cookie");
  return found.split(";")[0]!.slice("ao_session=".length);
}

async function addUser(booted: Booted, email: string, role: UserRole) {
  return await booted.authService.register({ email, password: "Pass-word-123!", role });
}

async function login(booted: Booted, email: string, cookie?: string): Promise<string> {
  const response = await booted.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password: "Pass-word-123!" },
    headers: { "user-agent": "Studio/1.0 (test)" },
    ...(cookie ? { cookies: { ao_session: cookie } } : {})
  });
  expect(response.statusCode).toBe(200);
  return sessionCookie(response.headers["set-cookie"]);
}

async function get(booted: Booted, url: string, cookie: string, headers: Record<string, string> = {}) {
  return await booted.app.inject({ method: "GET", url, cookies: { ao_session: cookie }, headers });
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function useClock(start = Date.parse("2026-11-09T09:00:00.000Z")) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(start);
  return {
    advance: (ms: number) => vi.setSystemTime(Date.now() + ms)
  };
}

describe("idle timeout", () => {
  it("is off when unset: a session idle for days still works until it expires", async () => {
    const booted = await boot();
    await addUser(booted, "ana@example.com", "admin");
    const clock = useClock();
    const cookie = await login(booted, "ana@example.com");
    clock.advance(100 * HOUR);
    expect((await get(booted, "/api/auth/me", cookie)).statusCode).toBe(200);
    clock.advance(68 * HOUR);
    const expired = await get(booted, "/api/auth/me", cookie);
    expect(expired.statusCode).toBe(401);
    expect(expired.json()).toEqual({ error: "Session expired or invalid", reason: "expired" });
  });

  it("applies the role's value and ends the session with reason idle", async () => {
    const booted = await boot({ SESSION_IDLE_TIMEOUT_MINUTES: "60,admin:15" });
    await addUser(booted, "admin@example.com", "admin");
    await addUser(booted, "builder@example.com", "builder");
    const clock = useClock();
    const admin = await login(booted, "admin@example.com");
    const builder = await login(booted, "builder@example.com");
    clock.advance(16 * MINUTE);
    const refused = await get(booted, "/api/workflows", admin);
    expect(refused.statusCode).toBe(401);
    expect(refused.json()).toEqual({ error: "Session expired or invalid", reason: "idle" });
    expect(await booted.store.getSession(admin)).toMatchObject({ endedReason: "idle", revokedAt: expect.any(String) });
    expect(setCookies(refused.headers["set-cookie"]).some((value) => value.startsWith("ao_session=;"))).toBe(true);
    // The cookie keeps saying why after the session ended.
    expect((await get(booted, "/api/workflows", admin)).json()).toMatchObject({ reason: "idle" });
    expect((await get(booted, "/api/workflows", builder)).statusCode).toBe(200);
  });

  it("does not count background requests as activity, and foreground ones do", async () => {
    const booted = await boot({ SESSION_IDLE_TIMEOUT_MINUTES: "15" });
    await addUser(booted, "bg@example.com", "builder");
    await addUser(booted, "fg@example.com", "builder");
    const clock = useClock();
    const background = await login(booted, "bg@example.com");
    const foreground = await login(booted, "fg@example.com");
    clock.advance(10 * MINUTE);
    expect((await get(booted, "/api/workflows", background, { "x-l2m-background": "1" })).statusCode).toBe(200);
    expect((await get(booted, "/api/workflows", foreground)).statusCode).toBe(200);
    clock.advance(6 * MINUTE);
    expect((await get(booted, "/api/workflows", background, { "x-l2m-background": "1" })).json()).toMatchObject({ reason: "idle" });
    expect((await get(booted, "/api/workflows", foreground)).statusCode).toBe(200);
  });

  it("never signs out an active user early: 1-minute idle timeout, a click every 50 s for 5 minutes", async () => {
    const booted = await boot({ SESSION_IDLE_TIMEOUT_MINUTES: "1" });
    await addUser(booted, "ana@example.com", "builder");
    const clock = useClock();
    const cookie = await login(booted, "ana@example.com");
    for (let elapsed = 50_000; elapsed <= 5 * MINUTE; elapsed += 50_000) {
      clock.advance(50_000);
      expect((await get(booted, "/api/workflows", cookie)).statusCode).toBe(200);
    }
    // Then idle: still signed in just under a minute after the last click, signed out within two.
    clock.advance(59_000);
    expect((await get(booted, "/api/workflows", cookie, { "x-l2m-background": "1" })).statusCode).toBe(200);
    clock.advance(61_000);
    expect((await get(booted, "/api/workflows", cookie, { "x-l2m-background": "1" })).json()).toMatchObject({ reason: "idle" });
  });

  it("throttles activity writes to one a minute per session", async () => {
    const booted = await boot({ SESSION_IDLE_TIMEOUT_MINUTES: "15" });
    await addUser(booted, "ana@example.com", "builder");
    const clock = useClock();
    const cookie = await login(booted, "ana@example.com");
    clock.advance(5 * MINUTE);
    await get(booted, "/api/workflows", cookie);
    const first = (await booted.store.getSession(cookie))!.lastSeenAt;
    clock.advance(30_000);
    await get(booted, "/api/workflows", cookie);
    expect((await booted.store.getSession(cookie))!.lastSeenAt).toBe(first);
    clock.advance(31_000);
    await get(booted, "/api/workflows", cookie);
    expect(Date.parse((await booted.store.getSession(cookie))!.lastSeenAt)).toBe(Date.parse(first) + 61_000);
  });

  it("tells the studio the idle deadline in /api/auth/me", async () => {
    const booted = await boot({ SESSION_IDLE_TIMEOUT_MINUTES: "60,admin:15" });
    await addUser(booted, "ana@example.com", "admin");
    const clock = useClock();
    const cookie = await login(booted, "ana@example.com");
    clock.advance(2 * MINUTE);
    const me = await get(booted, "/api/auth/me", cookie);
    expect(me.json().session).toEqual({
      handle: sessionHandle(cookie),
      createdAt: new Date(Date.now() - 2 * MINUTE).toISOString(),
      expiresAt: expect.any(String),
      idleTimeoutMinutes: 15,
      // The server's own deadline: the configured idle time plus the one-minute touch allowance.
      idleExpiresAt: new Date(Date.now() + 16 * MINUTE).toISOString(),
      breakGlass: false
    });
    // Without a policy there is no idle deadline.
    const plain = await boot();
    await addUser(plain, "bo@example.com", "admin");
    const other = await login(plain, "bo@example.com");
    expect((await get(plain, "/api/auth/me", other)).json().session).toMatchObject({ idleTimeoutMinutes: null, idleExpiresAt: null });
  });
});

describe("break-glass sessions", () => {
  it("skip the idle timeout but always end at their 1-hour expiry, however active, and are never renewed", async () => {
    const booted = await boot({ SESSION_IDLE_TIMEOUT_MINUTES: "15", SESSION_ABSOLUTE_TIMEOUT_HOURS: "168" });
    const user = await addUser(booted, "ana@example.com", "admin");
    const clock = useClock();
    const issued = await booted.authService.sessions.issueSession({ user, method: "break_glass", ttlHours: 24 });
    expect(issued.expiresAt).toBe(new Date(Date.now() + HOUR).toISOString());
    // Idle for 30 minutes: exempt from the idle timeout.
    clock.advance(30 * MINUTE);
    expect((await get(booted, "/api/workflows", issued.sessionId)).statusCode).toBe(200);
    // Active every 10 minutes: the expiry never moves.
    for (let i = 0; i < 2; i += 1) {
      clock.advance(10 * MINUTE);
      expect((await get(booted, "/api/workflows", issued.sessionId)).statusCode).toBe(200);
    }
    expect((await booted.store.getSession(issued.sessionId))?.expiresAt).toBe(issued.expiresAt);
    clock.advance(10 * MINUTE);
    const refused = await get(booted, "/api/workflows", issued.sessionId);
    expect(refused.json()).toEqual({ error: "Session expired or invalid", reason: "expired" });
    expect(await booted.store.getSession(issued.sessionId)).toMatchObject({ endedReason: "expired" });
  });
});

describe("absolute timeout", () => {
  it("sets the session and cookie lifetime from the role and applies the current role to live sessions", async () => {
    const booted = await boot({ SESSION_ABSOLUTE_TIMEOUT_HOURS: "168,admin:12" });
    const admin = await addUser(booted, "admin@example.com", "admin");
    const builder = await addUser(booted, "builder@example.com", "builder");
    const clock = useClock();
    const response = await booted.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password: "Pass-word-123!" } });
    expect(response.json().expiresAt).toBe(new Date(Date.now() + 12 * HOUR).toISOString());
    expect(setCookies(response.headers["set-cookie"]).find((value) => value.startsWith("ao_session="))).toMatch(/Max-Age=43200/);
    const builderCookie = await login(booted, "builder@example.com");
    expect((await booted.store.getSession(builderCookie))!.expiresAt).toBe(new Date(Date.now() + 168 * HOUR).toISOString());
    clock.advance(13 * HOUR);
    expect((await get(booted, "/api/workflows", builderCookie)).statusCode).toBe(200);
    // Promoted to admin: the stricter admin lifetime now applies to the live session.
    await booted.store.updateUserRole(builder.id, "admin");
    const refused = await get(booted, "/api/workflows", builderCookie);
    expect(refused.json()).toEqual({ error: "Session expired or invalid", reason: "expired" });
    expect(admin.role).toBe("admin");
  });
});

describe("session limit", () => {
  it("ends the oldest session, never refuses the sign-in, and audits session.evicted", async () => {
    const booted = await boot({ SESSION_MAX_PER_USER: "2" });
    const user = await addUser(booted, "ana@example.com", "builder");
    const clock = useClock();
    const first = await login(booted, "ana@example.com");
    clock.advance(1000);
    const second = await login(booted, "ana@example.com");
    clock.advance(1000);
    const third = await login(booted, "ana@example.com");
    const refused = await get(booted, "/api/workflows", first);
    expect(refused.statusCode).toBe(401);
    expect(refused.json()).toEqual({ error: "Session expired or invalid", reason: "evicted" });
    expect((await get(booted, "/api/workflows", second)).statusCode).toBe(200);
    expect((await get(booted, "/api/workflows", third)).statusCode).toBe(200);
    const audit = await booted.store.listAuditLogs({ eventType: "session.evicted" });
    const items = "items" in audit ? audit.items : audit;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ resourceId: user.id, metadata: { sessions: [sessionHandle(first)], limit: 2 } });
  });

  it("signing in again in the same browser replaces that browser's session instead of evicting another device", async () => {
    const booted = await boot({ SESSION_MAX_PER_USER: "2" });
    await addUser(booted, "ana@example.com", "builder");
    const clock = useClock();
    const laptop = await login(booted, "ana@example.com");
    clock.advance(1000);
    const phone = await login(booted, "ana@example.com");
    clock.advance(1000);
    const phoneAgain = await login(booted, "ana@example.com", phone);
    expect(await booted.store.getSession(phone)).toMatchObject({ endedReason: "logout" });
    expect((await get(booted, "/api/workflows", laptop)).statusCode).toBe(200);
    expect((await get(booted, "/api/workflows", phoneAgain)).statusCode).toBe(200);
  });

  it("ends idle sessions instead of counting them, so the active one is kept", async () => {
    const booted = await boot({ SESSION_MAX_PER_USER: "2", SESSION_IDLE_TIMEOUT_MINUTES: "30" });
    await addUser(booted, "ana@example.com", "builder");
    const clock = useClock();
    const phone = await login(booted, "ana@example.com");
    clock.advance(1000);
    const laptop = await login(booted, "ana@example.com");
    // The laptop goes idle; the phone stays in use.
    for (let i = 0; i < 4; i += 1) {
      clock.advance(10 * MINUTE);
      expect((await get(booted, "/api/workflows", phone)).statusCode).toBe(200);
    }
    // The idle laptop row is still unrevoked; the sign-in ends it as idle instead of evicting the phone.
    expect((await booted.store.getSession(laptop))?.revokedAt).toBeNull();
    const desktop = await login(booted, "ana@example.com");
    expect(await booted.store.getSession(laptop)).toMatchObject({ endedReason: "idle" });
    expect((await get(booted, "/api/workflows", phone)).statusCode).toBe(200);
    expect((await get(booted, "/api/workflows", desktop)).statusCode).toBe(200);
    expect(await booted.store.listAuditLogs({ eventType: "session.evicted" }).then((page) => ("items" in page ? page.items : page).length)).toBe(0);
    // The sessions list leaves out (and ends) idle rows as well.
    clock.advance(20 * MINUTE);
    expect((await get(booted, "/api/workflows", phone)).statusCode).toBe(200);
    clock.advance(12 * MINUTE);
    const list = (await get(booted, "/api/auth/sessions", phone)).json();
    expect(list.sessions.map((row: { handle: string }) => row.handle)).toEqual([sessionHandle(phone)]);
    expect(await booted.store.getSession(desktop)).toMatchObject({ endedReason: "idle" });
  });

  it("a normal sign-in never ends a live break-glass session", async () => {
    const booted = await boot({ SESSION_MAX_PER_USER: "1" });
    const user = await addUser(booted, "ana@example.com", "admin");
    const glass = await booted.authService.sessions.issueSession({ user, method: "break_glass" });
    const normal = await login(booted, "ana@example.com");
    expect((await get(booted, "/api/workflows", glass.sessionId)).statusCode).toBe(200);
    expect((await get(booted, "/api/workflows", normal)).statusCode).toBe(200);
  });

  it("is unlimited when unset or 0 for the role", async () => {
    const booted = await boot({ SESSION_MAX_PER_USER: "1,admin:0" });
    await addUser(booted, "admin@example.com", "admin");
    const cookies = [await login(booted, "admin@example.com"), await login(booted, "admin@example.com"), await login(booted, "admin@example.com")];
    for (const cookie of cookies) expect((await get(booted, "/api/workflows", cookie)).statusCode).toBe(200);
  });

  it("a break-glass session evicts nothing", async () => {
    const booted = await boot({ SESSION_MAX_PER_USER: "1" });
    const user = await addUser(booted, "ana@example.com", "admin");
    const normal = await login(booted, "ana@example.com");
    const issued = await booted.authService.sessions.issueSession({ user, method: "break_glass" });
    expect(issued.evictedSessionIds).toEqual([]);
    expect((await get(booted, "/api/workflows", normal)).statusCode).toBe(200);
  });
});

describe("signed-in sessions API", () => {
  it("lists my live sessions by handle, ends one, and signs out the others", async () => {
    const booted = await boot({ SESSION_IDLE_TIMEOUT_MINUTES: "30" });
    await addUser(booted, "ana@example.com", "builder");
    const a = await login(booted, "ana@example.com");
    const b = await login(booted, "ana@example.com");
    const c = await login(booted, "ana@example.com");
    const list = await get(booted, "/api/auth/sessions", a);
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.policy).toEqual({ idleTimeoutMinutes: 30, absoluteTimeoutHours: 168, absoluteTimeoutConfigured: false, maxPerUser: null });
    expect(body.sessions).toHaveLength(3);
    expect(JSON.stringify(body)).not.toContain(a);
    expect(body.sessions.find((row: { current: boolean }) => row.current)).toMatchObject({
      handle: sessionHandle(a),
      authMethod: "password",
      userAgent: "Studio/1.0 (test)",
      mfaVerified: false,
      breakGlass: false
    });

    const ended = await booted.app.inject({ method: "DELETE", url: `/api/auth/sessions/${sessionHandle(b)}`, cookies: { ao_session: a } });
    expect(ended.json()).toEqual({ ok: true, current: false });
    expect((await get(booted, "/api/workflows", b)).json()).toMatchObject({ reason: "logout" });
    expect((await booted.app.inject({ method: "DELETE", url: `/api/auth/sessions/${sessionHandle(b)}`, cookies: { ao_session: a } })).statusCode).toBe(404);

    const others = await booted.app.inject({ method: "POST", url: "/api/auth/sessions/revoke-others", cookies: { ao_session: a } });
    expect(others.json()).toEqual({ revoked: 1 });
    expect((await get(booted, "/api/workflows", c)).statusCode).toBe(401);
    expect((await get(booted, "/api/workflows", a)).statusCode).toBe(200);

    const self = await booted.app.inject({ method: "DELETE", url: `/api/auth/sessions/${sessionHandle(a)}`, cookies: { ao_session: a } });
    expect(self.json()).toEqual({ ok: true, current: true });
    expect(setCookies(self.headers["set-cookie"]).some((value) => value.startsWith("ao_session=;"))).toBe(true);
    expect((await get(booted, "/api/workflows", a)).statusCode).toBe(401);
  });

  it("refuses to end sessions over an API key (no browser session), and ends nothing", async () => {
    const booted = await boot();
    await addUser(booted, "ana@example.com", "builder");
    const cookie = await login(booted, "ana@example.com");
    const other = await login(booted, "ana@example.com");
    const created = await booted.app.inject({ method: "POST", url: "/api/auth/api-keys", cookies: { ao_session: cookie }, payload: { name: "ci" } });
    expect(created.statusCode).toBe(200);
    const key = created.json().key as string;
    const headers = { authorization: `Bearer ${key}` };
    const others = await booted.app.inject({ method: "POST", url: "/api/auth/sessions/revoke-others", headers });
    expect(others.statusCode).toBe(403);
    const one = await booted.app.inject({ method: "DELETE", url: `/api/auth/sessions/${sessionHandle(other)}`, headers });
    expect(one.statusCode).toBe(403);
    expect((await booted.app.inject({ method: "GET", url: "/api/auth/sessions", headers })).json().sessions).toHaveLength(2);
    expect((await get(booted, "/api/workflows", cookie)).statusCode).toBe(200);
    expect((await get(booted, "/api/workflows", other)).statusCode).toBe(200);
  });

  it("cannot end another user's session", async () => {
    const booted = await boot();
    await addUser(booted, "ana@example.com", "builder");
    await addUser(booted, "bo@example.com", "builder");
    const ana = await login(booted, "ana@example.com");
    const bo = await login(booted, "bo@example.com");
    expect((await booted.app.inject({ method: "DELETE", url: `/api/auth/sessions/${sessionHandle(bo)}`, cookies: { ao_session: ana } })).statusCode).toBe(404);
    expect((await get(booted, "/api/workflows", bo)).statusCode).toBe(200);
  });

  it("lets an admin list and end a user's sessions, keeping the admin's own current one", async () => {
    const booted = await boot();
    const admin = await addUser(booted, "admin@example.com", "admin");
    const user = await addUser(booted, "ana@example.com", "builder");
    const adminCookie = await login(booted, "admin@example.com");
    const otherAdminCookie = await login(booted, "admin@example.com");
    const one = await login(booted, "ana@example.com");
    const two = await login(booted, "ana@example.com");

    expect((await get(booted, `/api/users/${user.id}/sessions`, one)).statusCode).toBe(403);
    expect((await booted.app.inject({ method: "POST", url: `/api/users/${user.id}/sessions/revoke`, cookies: { ao_session: one } })).statusCode).toBe(403);
    expect((await get(booted, "/api/users/usr_missing/sessions", adminCookie)).statusCode).toBe(404);

    const listed = await get(booted, `/api/users/${user.id}/sessions`, adminCookie);
    expect(listed.json().sessions.map((row: { handle: string }) => row.handle).sort()).toEqual([sessionHandle(one), sessionHandle(two)].sort());

    const single = await booted.app.inject({
      method: "POST",
      url: `/api/users/${user.id}/sessions/revoke`,
      cookies: { ao_session: adminCookie },
      payload: { handle: sessionHandle(one) }
    });
    expect(single.json()).toEqual({ revoked: 1 });
    expect((await get(booted, "/api/workflows", one)).json()).toMatchObject({ reason: "admin" });

    const all = await booted.app.inject({ method: "POST", url: `/api/users/${user.id}/sessions/revoke`, cookies: { ao_session: adminCookie } });
    expect(all.json()).toEqual({ revoked: 1 });
    expect((await get(booted, "/api/workflows", two)).json()).toMatchObject({ reason: "admin" });

    const own = await booted.app.inject({ method: "POST", url: `/api/users/${admin.id}/sessions/revoke`, cookies: { ao_session: adminCookie } });
    expect(own.json()).toEqual({ revoked: 1 });
    expect((await get(booted, "/api/workflows", adminCookie)).statusCode).toBe(200);
    expect((await get(booted, "/api/workflows", otherAdminCookie)).statusCode).toBe(401);

    const audits = await booted.store.listAuditLogs({ eventType: "session.revoked" });
    expect(("items" in audits ? audits.items : audits).length).toBe(3);
  });
});

function node(id: string, type: string, config: Record<string, unknown>): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], name: id, position: { x: 0, y: 0 }, config };
}

async function until<T>(read: () => Promise<T>, what: string, timeoutMs = 10_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("live-update streams", () => {
  it("closes a run's event stream with session_ended when its session is revoked; the run goes on", async () => {
    const booted = await boot({ SSE_HEARTBEAT_INTERVAL_MS: "40" });
    await addUser(booted, "ana@example.com", "builder");
    const cookie = await login(booted, "ana@example.com");
    const workflow: Workflow = {
      id: "wf-slow",
      name: "wf-slow",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [node("input", "text_input", { text: "hi" }), node("wait", "wait_node", { delayMs: 1500, maxDelayMs: 1500 }), node("out", "output", { responseTemplate: "done" })],
      edges: [
        { id: "e1", source: "input", target: "wait" },
        { id: "e2", source: "wait", target: "out" }
      ]
    };
    await booted.app.inject({ method: "POST", url: "/api/workflows", cookies: { ao_session: cookie }, payload: workflow as unknown as Record<string, unknown> });
    const execution = booted.app.inject({ method: "POST", url: "/api/workflows/wf-slow/execute", cookies: { ao_session: cookie }, payload: {} });
    const executionId = await until(async () => {
      const page = await booted.store.listExecutionHistory({ page: 1, pageSize: 5 });
      return page.items.find((item) => item.status === "running")?.id ?? null;
    }, "the run to start");

    const started = Date.now();
    const stream = booted.app.inject({ method: "GET", url: `/api/executions/${executionId}/events`, cookies: { ao_session: cookie } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await booted.store.revokeSession(cookie, "admin");
    const body = (await stream).body;
    expect(Date.now() - started).toBeLessThan(1400);
    expect(body).toContain('event: session_ended\ndata: {"reason":"admin"}');
    expect(body).not.toContain("event: result");
    await execution;
    expect((await booted.store.getExecutionHistory(executionId))?.status).toBe("success");
  });
});
