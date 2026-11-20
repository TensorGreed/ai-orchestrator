/**
 * Changing your own password and an admin's temporary password for someone else, through the app: sessions end,
 * audit entries carry no password, MFA sign-in still applies, SSO accounts and API keys are refused.
 * Runs on SQLite, or on Postgres with TEST_STORE=postgres.
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
import { AuthService, type SafeUser } from "./services/auth-service.js";
import { MfaService, generateTotpCode } from "./services/mfa-service.js";
import { SecretService } from "./services/secret-service.js";
import { openTestStore } from "./test-support/test-store.js";

interface Booted {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  mfa: MfaService;
}

const PASSWORD = "Pass-word-123!";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function boot(env: Record<string, string> = {}): Promise<Booted> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-password-"));
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
  return { app, store, authService, mfa: new MfaService(store, masterKey) };
}

function sessionCookie(header: string | string[] | number | undefined): string | undefined {
  const all = Array.isArray(header) ? header : typeof header === "string" ? [header] : [];
  const found = all.find((value) => value.startsWith("ao_session="));
  return found ? found.split(";")[0]!.slice("ao_session=".length) || undefined : undefined;
}

const as = (session: string) => ({ cookies: { ao_session: session } });

async function register(booted: Booted, email: string, role: SafeUser["role"]) {
  return await booted.authService.register({ email, password: PASSWORD, role });
}

/** Password sign-in (through the code step when `secret` is given); the session cookie, or the status on refusal. */
async function signIn(booted: Booted, email: string, password = PASSWORD, secret?: string): Promise<string | number> {
  const login = await booted.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  if (login.statusCode !== 200) return login.statusCode;
  const body = login.json() as { mfaChallenge?: string };
  if (!body.mfaChallenge) return sessionCookie(login.headers["set-cookie"])!;
  const done = await booted.app.inject({ method: "POST", url: "/api/auth/login/mfa", payload: { challenge: body.mfaChallenge, code: generateTotpCode(secret!) } });
  return done.statusCode === 200 ? sessionCookie(done.headers["set-cookie"])! : done.statusCode;
}

async function session(booted: Booted, email: string, password = PASSWORD, secret?: string): Promise<string> {
  const value = await signIn(booted, email, password, secret);
  expect(typeof value).toBe("string");
  return value as string;
}

const change = (booted: Booted, cookie: string, payload: Record<string, unknown>) =>
  booted.app.inject({ method: "POST", url: "/api/auth/password", payload, ...as(cookie) });

describe("POST /api/auth/password", () => {
  it("changes the password with the current one, ends the other sessions, keeps this one, and is audited without the password", async () => {
    const booted = await boot();
    const ana = await register(booted, "ana@example.com", "builder");
    const here = await session(booted, "ana@example.com");
    const elsewhere = await session(booted, "ana@example.com");

    const changed = await change(booted, here, { currentPassword: PASSWORD, newPassword: "New-pass-word-456" });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toEqual({ ok: true, sessionsEnded: 1 });

    expect((await booted.app.inject({ method: "GET", url: "/api/auth/me", ...as(here) })).statusCode).toBe(200);
    expect((await booted.app.inject({ method: "GET", url: "/api/auth/me", ...as(elsewhere) })).statusCode).toBe(401);
    expect(await signIn(booted, "ana@example.com")).toBe(401);
    expect(typeof (await signIn(booted, "ana@example.com", "New-pass-word-456"))).toBe("string");

    const entry = (await booted.store.listAuditLogs({ eventType: "user.password.change" })).items[0]!;
    expect(entry).toMatchObject({ resourceId: ana.id, outcome: "success" });
    expect(entry.metadata).toEqual({ sessionsEnded: 1 });
    expect(JSON.stringify(entry)).not.toContain("New-pass-word-456");
  });

  it("refuses a wrong current password (audited as a failure), a short or unchanged new one, and an API key", async () => {
    const booted = await boot();
    await register(booted, "ben@example.com", "builder");
    const cookie = await session(booted, "ben@example.com");

    const wrong = await change(booted, cookie, { currentPassword: "not-it-at-all", newPassword: "New-pass-word-456" });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json()).toMatchObject({ code: "current_password_invalid" });
    expect((await booted.store.listAuditLogs({ eventType: "user.password.change" })).items[0]).toMatchObject({ outcome: "failure" });

    const short = await change(booted, cookie, { currentPassword: PASSWORD, newPassword: "short" });
    expect(short.statusCode).toBe(400);
    expect((short.json() as { error: string }).error).toContain("at least 8");
    const same = await change(booted, cookie, { currentPassword: PASSWORD, newPassword: PASSWORD });
    expect(same.json()).toMatchObject({ code: "password_unchanged" });
    expect(typeof (await signIn(booted, "ben@example.com"))).toBe("string");

    const key = await booted.app.inject({ method: "POST", url: "/api/auth/api-keys", payload: { name: "ci" }, ...as(cookie) });
    expect(key.statusCode).toBe(200);
    const byKey = await booted.app.inject({
      method: "POST",
      url: "/api/auth/password",
      payload: { currentPassword: PASSWORD, newPassword: "New-pass-word-456" },
      headers: { authorization: `Bearer ${(key.json() as { key: string }).key}` }
    });
    expect(byKey.statusCode).toBe(400);
    expect(byKey.json()).toMatchObject({ code: "session_required" });
    expect(typeof (await signIn(booted, "ben@example.com"))).toBe("string");
  });

  it("keeps the MFA code step after a change", async () => {
    const booted = await boot();
    const cy = await register(booted, "cy@example.com", "viewer");
    const enrollment = await booted.mfa.enroll(cy.id, cy.email);
    expect(await booted.mfa.activate(cy.id, generateTotpCode(enrollment.secret))).toBe(true);
    const cookie = await session(booted, "cy@example.com", PASSWORD, enrollment.secret);
    expect((await change(booted, cookie, { currentPassword: PASSWORD, newPassword: "New-pass-word-456" })).statusCode).toBe(200);
    const login = await booted.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "cy@example.com", password: "New-pass-word-456" } });
    expect(login.json()).toHaveProperty("mfaChallenge");
  });

  it("needs no MFA check with step-up on (the current password re-authenticates), so a user without an authenticator can change it", async () => {
    const booted = await boot({ STEP_UP_MAX_AGE_MINUTES: "10" });
    await register(booted, "di@example.com", "viewer");
    const cookie = await session(booted, "di@example.com");
    expect((await change(booted, cookie, { currentPassword: PASSWORD, newPassword: "New-pass-word-456" })).statusCode).toBe(200);
  });

  it("lets a local account later linked to SSO change the local password it still holds", async () => {
    const booted = await boot();
    const eve = await register(booted, "eve@example.com", "viewer");
    const cookie = await session(booted, "eve@example.com");
    await booted.store.upsertSsoIdentity({ id: "sso_eve", userId: eve.id, provider: "oidc", subject: "eve", email: eve.email });
    expect((await change(booted, cookie, { currentPassword: PASSWORD, newPassword: "New-pass-word-456" })).statusCode).toBe(200);
    expect(await signIn(booted, "eve@example.com")).toBe(401);
  });

  it("locks the change after five wrong current passwords in 15 minutes", async () => {
    const booted = await boot();
    await register(booted, "lou@example.com", "viewer");
    const cookie = await session(booted, "lou@example.com");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await change(booted, cookie, { currentPassword: `wrong-${attempt}-pass`, newPassword: "New-pass-word-456" })).statusCode).toBe(403);
    }
    const locked = await change(booted, cookie, { currentPassword: PASSWORD, newPassword: "New-pass-word-456" });
    expect(locked.statusCode).toBe(429);
    expect(locked.json()).toMatchObject({ code: "password_change_locked" });
    expect(typeof (await signIn(booted, "lou@example.com"))).toBe("string");
  });

  it("refuses a call from another site's page", async () => {
    const booted = await boot();
    await register(booted, "mo@example.com", "viewer");
    const cookie = await session(booted, "mo@example.com");
    const refused = await booted.app.inject({
      method: "POST",
      url: "/api/auth/password",
      payload: { currentPassword: PASSWORD, newPassword: "New-pass-word-456" },
      headers: { origin: "https://evil.example" },
      ...as(cookie)
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: "cross_site_refused" });
  });
});

describe("POST /api/users/:id/password/reset", () => {
  it("sets a temporary password shown once, ends all of the user's sessions, and is audited without it", async () => {
    const booted = await boot();
    await register(booted, "root@example.com", "admin");
    const fay = await register(booted, "fay@example.com", "operator");
    const admin = await session(booted, "root@example.com");
    const faySession = await session(booted, "fay@example.com");

    const reset = await booted.app.inject({ method: "POST", url: `/api/users/${fay.id}/password/reset`, ...as(admin) });
    expect(reset.statusCode).toBe(200);
    expect(reset.headers["cache-control"]).toBe("no-store");
    const body = reset.json() as { ok: boolean; userId: string; temporaryPassword: string; sessionsEnded: number };
    expect(body).toMatchObject({ ok: true, userId: fay.id, sessionsEnded: 1 });
    expect(body.temporaryPassword).toMatch(/^[A-Za-z0-9_-]{24}$/);

    expect((await booted.app.inject({ method: "GET", url: "/api/auth/me", ...as(faySession) })).statusCode).toBe(401);
    expect(await booted.store.getSession(faySession)).toMatchObject({ endedReason: "admin" });
    expect(await signIn(booted, "fay@example.com")).toBe(401);
    const signedIn = await session(booted, "fay@example.com", body.temporaryPassword);
    // The user then picks their own.
    expect((await change(booted, signedIn, { currentPassword: body.temporaryPassword, newPassword: "Fay-own-pass-1" })).statusCode).toBe(200);

    const entry = (await booted.store.listAuditLogs({ eventType: "user.password.reset" })).items[0]!;
    expect(entry).toMatchObject({ resourceId: fay.id, outcome: "success" });
    expect(entry.metadata).toEqual({ email: "fay@example.com", sessionsEnded: 1 });
    expect(JSON.stringify(entry)).not.toContain(body.temporaryPassword);
  });

  it("is for admins, not on yourself, a pending invite, a service account or an SSO account; step-up when on", async () => {
    const booted = await boot();
    const root = await register(booted, "root@example.com", "admin");
    const gil = await register(booted, "gil@example.com", "builder");
    const sso = await register(booted, "sso@example.com", "viewer");
    await booted.store.upsertSsoIdentity({ id: "sso_1", userId: sso.id, provider: "saml", subject: "sso", email: sso.email });
    const admin = await session(booted, "root@example.com");
    const builder = await session(booted, "gil@example.com");
    const reset = (cookie: string, id: string) => booted.app.inject({ method: "POST", url: `/api/users/${id}/password/reset`, ...as(cookie) });

    expect((await reset(builder, root.id)).statusCode).toBe(403);
    expect((await reset(admin, root.id)).json()).toMatchObject({ code: "own_account" });
    expect((await reset(admin, "usr_missing")).statusCode).toBe(404);
    expect((await reset(admin, sso.id)).json()).toMatchObject({ code: "sso_account" });

    const invited = await booted.app.inject({ method: "POST", url: "/api/users/invite", payload: { email: "new@example.com", role: "viewer" }, ...as(admin) });
    expect(invited.statusCode).toBe(201);
    const pending = await booted.store.getUserByEmail("new@example.com");
    expect((await reset(admin, pending!.id)).json()).toMatchObject({ code: "invite_pending" });

    // An admin's API key cannot do it (the answer would hand a working password to whoever holds the key).
    const key = await booted.app.inject({ method: "POST", url: "/api/auth/api-keys", payload: { name: "ops" }, ...as(admin) });
    const byKey = await booted.app.inject({
      method: "POST",
      url: `/api/users/${gil.id}/password/reset`,
      headers: { authorization: `Bearer ${(key.json() as { key: string }).key}` }
    });
    expect(byKey.statusCode).toBe(400);
    expect(byKey.json()).toMatchObject({ code: "session_required" });
    // Nor a page on another site with the admin's cookie.
    const crossSite = await booted.app.inject({
      method: "POST",
      url: `/api/users/${gil.id}/password/reset`,
      headers: { origin: "https://evil.example", "content-type": "text/plain" },
      payload: "x",
      ...as(admin)
    });
    expect(crossSite.json()).toMatchObject({ code: "cross_site_refused" });

    const account = (await booted.store.createServiceAccount({ id: "svc_ci", email: "ci@service.invalid", role: "viewer", description: null, createdBy: root.id }))!;
    expect((await reset(admin, account.id)).statusCode).toBe(404);
    expect(typeof (await signIn(booted, "gil@example.com"))).toBe("string");

    const strict = await boot({ STEP_UP_MAX_AGE_MINUTES: "10" });
    await register(strict, "root@example.com", "admin");
    const hal = await register(strict, "hal@example.com", "viewer");
    const strictAdmin = await session(strict, "root@example.com");
    const refused = await strict.app.inject({ method: "POST", url: `/api/users/${hal.id}/password/reset`, ...as(strictAdmin) });
    expect(refused.json()).toMatchObject({ code: "step_up_required", stepUp: { action: "user.password_reset" } });
  });
});
