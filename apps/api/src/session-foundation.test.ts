/**
 * 13.2 — sign-in sessions through the app: the password login, the MFA step and logout record how each session was
 * issued and why it ended; a password step that still owes an MFA code creates no session; requireRole records the
 * request's sign-in context.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { AuthService } from "./services/auth-service.js";
import { MfaService, generateTotpCode } from "./services/mfa-service.js";
import { SecretService } from "./services/secret-service.js";
import type { RequestAuthContext } from "./services/session-service.js";
import { openTestStore } from "./test-support/test-store.js";
import { testSql } from "./test-support/test-sql.js";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

interface Booted {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  masterKey: string;
  contexts: Array<{ url: string; context: RequestAuthContext | undefined }>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function boot(env: Record<string, string> = {}): Promise<Booted> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-session-foundation-"));
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
  const contexts: Booted["contexts"] = [];
  app.addHook("onResponse", async (request) => {
    contexts.push({ url: request.url, context: authService.sessions.getRequestAuth(request) });
  });
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
  return { app, store, authService, masterKey, contexts };
}

function sessionCookie(header: string | string[] | number | undefined): string | undefined {
  const all = Array.isArray(header) ? header : typeof header === "string" ? [header] : [];
  const found = all.find((value) => value.startsWith("ao_session="));
  return found ? found.split(";")[0]!.slice("ao_session=".length) || undefined : undefined;
}

async function passwordLogin(booted: Booted, email: string, password: string) {
  return await booted.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password },
    headers: { "user-agent": "Studio/1.0 (test)" }
  });
}

describe("password sign-in sessions", () => {
  it("records method, address and user agent; logout ends the session with reason logout", async () => {
    const booted = await boot();
    const user = await booted.authService.register({ email: "ana@example.com", password: "Ana-Pass-123!", role: "builder" });
    const login = await passwordLogin(booted, "ana@example.com", "Ana-Pass-123!");
    expect(login.statusCode).toBe(200);
    const sessionId = sessionCookie(login.headers["set-cookie"])!;
    expect(sessionId).toMatch(/^sess_[A-Za-z0-9_-]{43}$/);
    expect(login.json()).toEqual({ user: { id: user.id, email: "ana@example.com", role: "builder" }, expiresAt: expect.stringMatching(ISO) });
    expect(await booted.store.getSession(sessionId)).toMatchObject({
      userId: user.id,
      authMethod: "password",
      ipAddress: "127.0.0.1",
      userAgent: "Studio/1.0 (test)",
      mfaVerifiedAt: null,
      breakGlass: false,
      endedReason: null
    });

    const me = await booted.app.inject({ method: "GET", url: "/api/workflows", cookies: { ao_session: sessionId } });
    expect(me.statusCode).toBe(200);
    const recorded = booted.contexts.find((entry) => entry.url === "/api/workflows")?.context;
    expect(recorded).toMatchObject({ credential: "session", user: { id: user.id, role: "builder" }, session: { id: sessionId, authMethod: "password" } });

    const logout = await booted.app.inject({ method: "POST", url: "/api/auth/logout", cookies: { ao_session: sessionId } });
    expect(logout.statusCode).toBe(200);
    expect(await booted.store.getSession(sessionId)).toMatchObject({ revokedAt: expect.stringMatching(ISO), endedReason: "logout" });
    expect((await booted.app.inject({ method: "GET", url: "/api/workflows", cookies: { ao_session: sessionId } })).statusCode).toBe(401);
  });

  it("a wrong password issues nothing; an expired session is refused and ended with reason expired", async () => {
    const booted = await boot();
    const user = await booted.authService.register({ email: "ana@example.com", password: "Ana-Pass-123!", role: "viewer" });
    expect((await passwordLogin(booted, "ana@example.com", "wrong")).statusCode).toBe(401);
    expect(await booted.store.listUserSessions(user.id)).toEqual([]);

    const sessionId = sessionCookie((await passwordLogin(booted, "ana@example.com", "Ana-Pass-123!")).headers["set-cookie"])!;
    await testSql(booted.store).run(`UPDATE sessions SET expires_at = ? WHERE id = ?`, "2000-01-01T00:00:00.000Z", sessionId);
    expect((await booted.app.inject({ method: "GET", url: "/api/workflows", cookies: { ao_session: sessionId } })).statusCode).toBe(401);
    expect(await booted.store.getSession(sessionId)).toMatchObject({ revokedAt: expect.stringMatching(ISO), endedReason: "expired" });
  });

  it("an enrolled user's password step creates no session; the MFA step issues one marked MFA-verified", async () => {
    const booted = await boot();
    const user = await booted.authService.register({ email: "mo@example.com", password: "Mo-Pass-123!", role: "admin" });
    const mfa = new MfaService(booted.store, booted.masterKey);
    const enrollment = await mfa.enroll(user.id, user.email);
    expect(await mfa.activate(user.id, generateTotpCode(enrollment.secret))).toBe(true);

    const step = await passwordLogin(booted, "mo@example.com", "Mo-Pass-123!");
    expect(step.statusCode).toBe(200);
    const { mfaChallenge } = step.json() as { mfaChallenge: string };
    expect(mfaChallenge).toMatch(/^mfa_/);
    expect(sessionCookie(step.headers["set-cookie"])).toBeUndefined();
    expect(await booted.store.listUserSessions(user.id)).toEqual([]);

    const done = await booted.app.inject({
      method: "POST",
      url: "/api/auth/login/mfa",
      payload: { challenge: mfaChallenge, code: generateTotpCode(enrollment.secret) },
      headers: { "user-agent": "Studio/1.0 (test)" }
    });
    expect(done.statusCode).toBe(200);
    const sessionId = sessionCookie(done.headers["set-cookie"])!;
    expect(await booted.store.getSession(sessionId)).toMatchObject({
      authMethod: "password",
      mfaVerifiedAt: expect.stringMatching(ISO),
      userAgent: "Studio/1.0 (test)"
    });
    expect(await booted.store.listUserSessions(user.id)).toHaveLength(1);
  });

  it("MFA_ENFORCE: an unenrolled admin still gets a session (not MFA-verified) flagged for enrolment, as before", async () => {
    const booted = await boot({ MFA_ENFORCE: "true" });
    const user = await booted.authService.register({ email: "root@example.com", password: "Root-Pass-123!", role: "admin" });
    const login = await passwordLogin(booted, "root@example.com", "Root-Pass-123!");
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ user: { id: user.id }, mfaEnrollmentRequired: true });
    const sessionId = sessionCookie(login.headers["set-cookie"])!;
    expect(await booted.store.getSession(sessionId)).toMatchObject({ authMethod: "password", mfaVerifiedAt: null });
    expect((await booted.app.inject({ method: "GET", url: "/api/workflows", cookies: { ao_session: sessionId } })).statusCode).toBe(200);
  });
});

describe("API key requests", () => {
  it("requireRole records the key's id and scopes as the request's sign-in context", async () => {
    const booted = await boot();
    const user = await booted.authService.register({ email: "bot@example.com", password: "Bot-Pass-123!", role: "builder" });
    const sessionId = sessionCookie((await passwordLogin(booted, "bot@example.com", "Bot-Pass-123!")).headers["set-cookie"])!;
    const created = await booted.app.inject({
      method: "POST",
      url: "/api/auth/api-keys",
      cookies: { ao_session: sessionId },
      payload: { name: "ci", scopes: ["legacy-scope"] }
    });
    expect(created.statusCode).toBeLessThan(300);
    const { key, record } = created.json() as { key: string; record: { id: string } };
    const listed = await booted.app.inject({ method: "GET", url: "/api/workflows", headers: { authorization: `Bearer ${key}` } });
    expect(listed.statusCode).toBe(200);
    const recorded = booted.contexts.filter((entry) => entry.url === "/api/workflows").at(-1)?.context;
    expect(recorded).toEqual({
      credential: "api_key",
      user: { id: user.id, email: "bot@example.com", role: "builder", apiKeyId: record.id },
      apiKeyId: record.id,
      keyScopes: ["legacy-scope"],
      // 13.2 (L3a) — the parsed scope: a legacy string enforces nothing.
      keyScope: { roleCeiling: null, projects: null, legacy: ["legacy-scope"] },
      serviceAccount: false
    });
  });
});
