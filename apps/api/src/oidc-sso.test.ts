/**
 * Phase 13.2 — OIDC single sign-on end to end through the API, against an in-process IdP (no network): login
 * redirect, flow cookie, callback, JIT provisioning, verified-email linking, group mapping, session and audit.
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
import { openTestStore } from "./test-support/test-store.js";
import { MockOidcProvider } from "./test-support/mock-oidc-provider.js";
import { AuthService } from "./services/auth-service.js";
import { MfaService, generateTotpCode } from "./services/mfa-service.js";
import { oidcIdentitySubject } from "./services/oidc-service.js";
import { SecretService } from "./services/secret-service.js";

const CLIENT_SECRET = "oidc-client-secret-do-not-echo";
const WEB = "http://localhost:5173";

interface TestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  tempDir: string;
  provider: MockOidcProvider;
  masterKey: string;
  logs: string[];
}

const contexts: TestContext[] = [];

afterEach(async () => {
  while (contexts.length > 0) {
    const context = contexts.pop()!;
    await context.app.close();
    try {
      await context.store.close();
    } catch {
      // Already closed by the app shutdown hooks.
    }
    fs.rmSync(context.tempDir, { recursive: true, force: true });
  }
});

async function createContext(
  options: { enabled?: boolean; env?: Record<string, string>; provider?: MockOidcProvider; captureLogs?: boolean } = {}
): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-oidc-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const provider = options.provider ?? (await MockOidcProvider.create({ clientSecret: CLIENT_SECRET }));
  const masterKey = crypto.randomBytes(32).toString("base64");
  const logs: string[] = [];
  const config = parseConfig({
    LOG_LEVEL: options.captureLogs ? "info" : "fatal",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: masterKey,
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "sync"),
    WEB_ORIGIN: WEB,
    ...(options.enabled === false
      ? {}
      : {
          OIDC_ENABLED: "true",
          OIDC_ISSUER: provider.issuer,
          OIDC_CLIENT_ID: provider.clientId,
          ...(provider.clientSecret ? { OIDC_CLIENT_SECRET: provider.clientSecret } : {})
        }),
    ...(options.env ?? {})
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = await createApp(config, store, secretService, authService, undefined, undefined, undefined, {
    oidcFetch: provider.fetch,
    ...(options.captureLogs ? { logStream: { write: (line: string) => void logs.push(line) } } : {})
  });
  await app.ready();
  const context = { app, store, authService, tempDir, provider, masterKey, logs };
  contexts.push(context);
  return context;
}

function setCookies(header: string | string[] | number | undefined): string[] {
  if (Array.isArray(header)) return header;
  return typeof header === "string" ? [header] : [];
}

function cookieValue(cookies: string[], name: string): string | undefined {
  const found = cookies.find((cookie) => cookie.startsWith(`${name}=`));
  return found ? found.split(";")[0]!.slice(name.length + 1) : undefined;
}

/** Browser walk-through: start login, approve at the IdP, follow the redirect back. */
async function runLogin(context: TestContext, tamper?: (callback: URL) => void, extraCookies: Record<string, string> = {}) {
  const start = await context.app.inject({ method: "GET", url: "/api/auth/oidc/login" });
  expect(start.statusCode).toBe(302);
  const flowCookies = setCookies(start.headers["set-cookie"]);
  const flow = cookieValue(flowCookies, "l2m_oidc_flow");
  expect(flow).toBeTruthy();
  const callback = new URL(context.provider.authorize(String(start.headers.location)));
  tamper?.(callback);
  const finish = await context.app.inject({
    method: "GET",
    url: `${callback.pathname}${callback.search}`,
    cookies: { ...extraCookies, ...(flow ? { l2m_oidc_flow: flow } : {}) }
  });
  const finishCookies = setCookies(finish.headers["set-cookie"]);
  return {
    start,
    flow,
    callback,
    flowCookies,
    finish,
    finishCookies,
    session: cookieValue(finishCookies, "ao_session") || undefined
  };
}

async function adminCookie(context: TestContext): Promise<string> {
  await context.authService.register({ email: "admin@example.com", password: "AdminPassword123!", role: "admin" });
  const login = await context.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "admin@example.com", password: "AdminPassword123!" }
  });
  expect(login.statusCode).toBe(200);
  return cookieValue(setCookies(login.headers["set-cookie"]), "ao_session")!;
}

describe("OIDC SSO is off by default", () => {
  it("reports itself off, answers 404 on the login routes and changes nothing else", async () => {
    const context = await createContext({ enabled: false });
    const metadata = await context.app.inject({ method: "GET", url: "/api/auth/oidc/metadata" });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json()).toEqual({ enabled: false });
    for (const url of ["/api/auth/oidc/login", "/api/auth/oidc/callback?code=x&state=y"]) {
      const response = await context.app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(404);
      expect(response.headers["set-cookie"]).toBeUndefined();
    }
    expect(context.provider.jwksFetches).toBe(0);
    expect(context.provider.tokenRequests).toHaveLength(0);
  });
});

describe("OIDC SSO login", () => {
  it("advertises itself without the client secret", async () => {
    const context = await createContext();
    const response = await context.app.inject({ method: "GET", url: "/api/auth/oidc/metadata" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      enabled: true,
      issuer: context.provider.issuer,
      clientId: context.provider.clientId,
      loginPath: "/api/auth/oidc/login",
      redirectUrl: `${WEB}/api/auth/oidc/callback`
    });
    expect(response.body).not.toContain(CLIENT_SECRET);
  });

  it("logs a new user in with PKCE, provisions them with mapped roles, and audits it", async () => {
    const context = await createContext();
    const admin = await adminCookie(context);
    for (const payload of [
      { provider: "oidc", groupName: "l2m-builders", role: "builder" },
      { provider: "oidc", groupName: "l2m-builders", role: "editor", projectId: "default" }
    ]) {
      const created = await context.app.inject({ method: "POST", url: "/api/auth/sso/mappings", cookies: { ao_session: admin }, payload });
      expect(created.statusCode).toBe(200);
    }
    context.provider.user = { sub: "kc-001", email: "Dana@Example.com", email_verified: true, name: "Dana", groups: ["l2m-builders"] };

    const { start, flowCookies, finish, finishCookies, session } = await runLogin(context);
    const authorize = new URL(String(start.headers.location));
    expect(authorize.origin + authorize.pathname).toBe(context.provider.discovery.authorization_endpoint);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${WEB}/api/auth/oidc/callback`);
    expect(String(start.headers.location)).not.toContain(CLIENT_SECRET);
    const flowCookie = flowCookies.find((cookie) => cookie.startsWith("l2m_oidc_flow="))!;
    expect(flowCookie).toMatch(/HttpOnly/i);
    expect(flowCookie).toMatch(/SameSite=Lax/i);
    expect(flowCookie).toMatch(/Path=\/api\/auth\/oidc/);

    expect(finish.statusCode).toBe(302);
    expect(finish.headers.location).toBe(`${WEB}/`);
    expect(session).toBeTruthy();
    // The flow cookie is cleared after use.
    expect(finishCookies.find((cookie) => cookie.startsWith("l2m_oidc_flow="))).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);

    const me = await context.app.inject({ method: "GET", url: "/api/auth/me", cookies: { ao_session: session! } });
    expect(me.statusCode).toBe(200);
    const meBody = me.json() as { user: { id: string; email: string; role: string } };
    expect(meBody.user).toMatchObject({ email: "dana@example.com", role: "builder" });

    const identity = await context.store.findSsoIdentity("oidc", oidcIdentitySubject(context.provider.issuer, "kc-001"));
    expect(identity).toMatchObject({ userId: meBody.user.id, email: "dana@example.com" });
    const members = await context.store.listProjectMembers("default");
    expect(members.find((member) => member.userId === meBody.user.id)?.role).toBe("editor");

    const audits = await context.store.listAuditLogs({ eventType: "user.login", actorUserId: meBody.user.id });
    expect(audits.items[0]).toMatchObject({ outcome: "success" });
    expect(JSON.stringify(audits.items)).not.toContain(CLIENT_SECRET);

    // The token request carried the PKCE verifier and authenticated with the secret, never sent to the browser.
    expect(context.provider.tokenRequests[0]!.body.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(finish.body).not.toContain(CLIENT_SECRET);
  });

  it("links an existing user by verified email, and keeps the link when the IdP email changes", async () => {
    const context = await createContext();
    const existing = await context.authService.register({ email: "erin@example.com", password: "ErinPassword123!", role: "operator" });
    context.provider.user = { sub: "kc-erin", email: "erin@example.com", email_verified: true };
    const first = await runLogin(context);
    expect(first.finish.headers.location).toBe(`${WEB}/`);
    expect((await context.store.findSsoIdentity("oidc", oidcIdentitySubject(context.provider.issuer, "kc-erin")))?.userId).toBe(existing.id);
    const user = await context.store.getUserById(existing.id);
    expect(user?.role).toBe("operator");

    // Same sub, new email (even unverified): still the same local user, matched by sub.
    context.provider.user = { sub: "kc-erin", email: "erin.new@example.com", email_verified: false };
    const second = await runLogin(context);
    expect(second.finish.headers.location).toBe(`${WEB}/`);
    const me = await context.app.inject({ method: "GET", url: "/api/auth/me", cookies: { ao_session: second.session! } });
    expect((me.json() as { user: { id: string } }).user.id).toBe(existing.id);
    expect(await context.store.getUserByEmail("erin.new@example.com")).toBeNull();
  });

  it("never links or creates a user from an unverified email", async () => {
    const context = await createContext();
    const victim = await context.authService.register({ email: "frank@example.com", password: "FrankPassword123!", role: "admin" });
    for (const verified of [false, "false", undefined] as const) {
      context.provider.user = { sub: `kc-attacker-${String(verified)}`, email: "frank@example.com", email_verified: verified };
      const { finish, session } = await runLogin(context);
      expect(finish.statusCode).toBe(302);
      expect(finish.headers.location).toBe(`${WEB}/?sso_error=oidc_email`);
      expect(session).toBeUndefined();
      expect(await context.store.findSsoIdentity("oidc", oidcIdentitySubject(context.provider.issuer, `kc-attacker-${String(verified)}`))).toBeNull();
    }
    context.provider.user = { sub: "kc-new", email: "newbie@example.com", email_verified: false };
    const { finish } = await runLogin(context);
    expect(finish.headers.location).toBe(`${WEB}/?sso_error=oidc_email`);
    expect(await context.store.getUserByEmail("newbie@example.com")).toBeNull();
    expect((await context.store.getUserById(victim.id))?.role).toBe("admin");

    const failures = await context.store.listAuditLogs({ eventType: "user.login", outcome: "failure" });
    expect(failures.items.length).toBeGreaterThanOrEqual(4);
  });

  it("trusts unverified emails only when OIDC_REQUIRE_EMAIL_VERIFIED=false", async () => {
    const context = await createContext({ env: { OIDC_REQUIRE_EMAIL_VERIFIED: "false" } });
    context.provider.user = { sub: "entra-1", email: "gina@example.com" };
    const { finish, session } = await runLogin(context);
    expect(finish.headers.location).toBe(`${WEB}/`);
    expect(session).toBeTruthy();
  });

  it("redirects to the login page with a generic code on a state mismatch, a missing flow cookie or an IdP error", async () => {
    const context = await createContext();
    const forged = await runLogin(context, (callback) => callback.searchParams.set("state", "forged"));
    expect(forged.finish.headers.location).toBe(`${WEB}/?sso_error=oidc_state`);
    expect(forged.session).toBeUndefined();

    const start = await context.app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    const callback = new URL(context.provider.authorize(String(start.headers.location)));
    const noCookie = await context.app.inject({ method: "GET", url: `${callback.pathname}${callback.search}` });
    expect(noCookie.headers.location).toBe(`${WEB}/?sso_error=oidc_state`);

    const denied = await runLogin(context, (cb) => {
      cb.searchParams.delete("code");
      cb.searchParams.set("error", "access_denied");
    });
    expect(denied.finish.headers.location).toBe(`${WEB}/?sso_error=oidc_denied`);
    // The token endpoint was never called for any of these.
    expect(context.provider.tokenRequests).toHaveLength(0);
  });

  it("rejects an ID token for another client and one signed with an unknown key", async () => {
    const context = await createContext();
    context.provider.idTokenOverrides = { aud: "someone-else" };
    const wrongAud = await runLogin(context);
    expect(wrongAud.finish.headers.location).toBe(`${WEB}/?sso_error=oidc_failed`);
    expect(wrongAud.session).toBeUndefined();

    context.provider.idTokenOverrides = {};
    await context.provider.useUnpublishedKey();
    const unknownKey = await runLogin(context);
    expect(unknownKey.finish.headers.location).toBe(`${WEB}/?sso_error=oidc_failed`);
  });

  it("reports an unreachable IdP on the login page instead of an error body", async () => {
    const provider = await MockOidcProvider.create({ clientSecret: CLIENT_SECRET });
    const context = await createContext({ provider, env: { OIDC_ISSUER: "https://down.example.test" } });
    const start = await context.app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    expect(start.statusCode).toBe(302);
    expect(start.headers.location).toBe(`${WEB}/?sso_error=oidc_unavailable`);
  });

  it("accepts oidc in SSO group mappings", async () => {
    const context = await createContext({ enabled: false });
    const admin = await adminCookie(context);
    const created = await context.app.inject({
      method: "POST",
      url: "/api/auth/sso/mappings",
      cookies: { ao_session: admin },
      payload: { provider: "oidc", groupName: "admins", role: "admin" }
    });
    expect(created.statusCode).toBe(200);
    const list = await context.app.inject({ method: "GET", url: "/api/auth/sso/mappings?provider=oidc", cookies: { ao_session: admin } });
    expect((list.json() as { mappings: Array<{ groupName: string }> }).mappings.map((m) => m.groupName)).toEqual(["admins"]);
  });
});

describe("OIDC identities are bound to the issuer", () => {
  it("does not sign in a user linked under another issuer with the same sub", async () => {
    const context = await createContext();
    const victim = await context.authService.register({ email: "owner@example.com", password: "OwnerPassword123!", role: "admin" });
    // Linked while OIDC_ISSUER pointed at another IdP, whose subjects happen to collide with the new one's.
    await context.store.upsertSsoIdentity({
      id: "sso_old_issuer",
      userId: victim.id,
      provider: "oidc",
      subject: oidcIdentitySubject("https://old-idp.example.test/realms/l2m", "1"),
      email: "owner@example.com",
      attributes: {}
    });

    // Same sub at the new issuer, no verified email: refused, not signed in as the old link's user.
    context.provider.user = { sub: "1", email: "intruder@example.com", email_verified: false };
    const refused = await runLogin(context);
    expect(refused.finish.headers.location).toBe(`${WEB}/?sso_error=oidc_email`);
    expect(refused.session).toBeUndefined();

    // Same sub with a verified email of their own: a new viewer, not the old link's admin.
    context.provider.user = { sub: "1", email: "intruder@example.com", email_verified: true };
    const fresh = await runLogin(context);
    const me = await context.app.inject({ method: "GET", url: "/api/auth/me", cookies: { ao_session: fresh.session! } });
    expect((me.json() as { user: { id: string; email: string; role: string } }).user).toMatchObject({
      email: "intruder@example.com",
      role: "viewer"
    });
    expect((me.json() as { user: { id: string } }).user.id).not.toBe(victim.id);
    const identity = await context.store.findSsoIdentity("oidc", oidcIdentitySubject(context.provider.issuer, "1"));
    expect(identity?.attributes).toMatchObject({ iss: context.provider.issuer, sub: "1" });
  });
});

describe("OIDC allow-lists", () => {
  it("refuses new and returning users outside OIDC_ALLOWED_EMAIL_DOMAINS", async () => {
    const context = await createContext({ env: { OIDC_ALLOWED_EMAIL_DOMAINS: "example.com" } });
    context.provider.user = { sub: "g-1", email: "outsider@gmail.test", email_verified: true };
    const outsider = await runLogin(context);
    expect(outsider.finish.headers.location).toBe(`${WEB}/?sso_error=oidc_not_allowed`);
    expect(outsider.session).toBeUndefined();
    expect(await context.store.getUserByEmail("outsider@gmail.test")).toBeNull();

    context.provider.user = { sub: "g-2", email: "member@example.com", email_verified: true };
    const member = await runLogin(context);
    expect(member.finish.headers.location).toBe(`${WEB}/`);
    // A returning user whose IdP email moved out of the allowed domain is refused too.
    context.provider.user = { sub: "g-2", email: "member@elsewhere.test", email_verified: true };
    const moved = await runLogin(context);
    expect(moved.finish.headers.location).toBe(`${WEB}/?sso_error=oidc_not_allowed`);
    expect(moved.session).toBeUndefined();

    const failures = await context.store.listAuditLogs({ eventType: "user.login", outcome: "failure" });
    expect(failures.items.map((item) => (item.metadata as { reason?: string }).reason)).toEqual(["not_allowed", "not_allowed"]);
    expect(JSON.stringify(failures.items)).not.toContain(CLIENT_SECRET);
  });

  it("refuses users holding none of OIDC_ALLOWED_GROUPS", async () => {
    const context = await createContext({ env: { OIDC_ALLOWED_GROUPS: "l2m-users,l2m-admins" } });
    context.provider.user = { sub: "u-1", email: "nogroup@example.com", email_verified: true, groups: ["sales"] };
    const refused = await runLogin(context);
    expect(refused.finish.headers.location).toBe(`${WEB}/?sso_error=oidc_not_allowed`);
    expect(await context.store.getUserByEmail("nogroup@example.com")).toBeNull();

    context.provider.user = { sub: "u-2", email: "member@example.com", email_verified: true, groups: ["sales", "l2m-users"] };
    const allowed = await runLogin(context);
    expect(allowed.finish.headers.location).toBe(`${WEB}/`);
    // Removed from the group at the IdP: the next login is refused.
    context.provider.user = { sub: "u-2", email: "member@example.com", email_verified: true, groups: ["sales"] };
    expect((await runLogin(context)).finish.headers.location).toBe(`${WEB}/?sso_error=oidc_not_allowed`);
  });
});

describe("OIDC linking, sessions and failure paths", () => {
  it("audits the first link to an existing account (with TOTP enrolled) as user.sso_linked, once", async () => {
    const context = await createContext();
    const existing = await context.authService.register({ email: "totp@example.com", password: "TotpPassword123!", role: "admin" });
    const mfa = new MfaService(context.store, context.masterKey);
    const enrollment = await mfa.enroll(existing.id, existing.email);
    expect(await mfa.activate(existing.id, generateTotpCode(enrollment.secret))).toBe(true);

    context.provider.user = { sub: "kc-totp", email: "totp@example.com", email_verified: true };
    const first = await runLogin(context);
    // Parity with SAML: the IdP's MFA applies; L2M does not ask for the local TOTP code.
    expect(first.finish.headers.location).toBe(`${WEB}/`);
    expect(first.session).toBeTruthy();
    await runLogin(context);

    const linked = await context.store.listAuditLogs({ eventType: "user.sso_linked" });
    expect(linked.items).toHaveLength(1);
    expect(linked.items[0]).toMatchObject({
      outcome: "success",
      resourceId: existing.id,
      metadata: { provider: "oidc", email: "totp@example.com", mfaEnrolled: true }
    });
    expect(JSON.stringify(linked.items)).not.toMatch(/at_kc-totp|eyJ/);

    // A JIT-created user is not a link to an existing account.
    context.provider.user = { sub: "kc-new", email: "brand-new@example.com", email_verified: true };
    await runLogin(context);
    expect((await context.store.listAuditLogs({ eventType: "user.sso_linked" })).items).toHaveLength(1);
  });

  it("refuses a replayed callback (same code and flow cookie) without creating a session", async () => {
    const context = await createContext();
    const first = await runLogin(context);
    expect(first.session).toBeTruthy();
    const replay = await context.app.inject({
      method: "GET",
      url: `${first.callback.pathname}${first.callback.search}`,
      cookies: { l2m_oidc_flow: first.flow! }
    });
    expect(replay.headers.location).toBe(`${WEB}/?sso_error=oidc_failed`);
    expect(cookieValue(setCookies(replay.headers["set-cookie"]), "ao_session")).toBeFalsy();
  });

  it("revokes a session the browser already holds when a new one is issued", async () => {
    const context = await createContext();
    const admin = await adminCookie(context);
    const login = await runLogin(context, undefined, { ao_session: admin });
    expect(login.session).toBeTruthy();
    const old = await context.app.inject({ method: "GET", url: "/api/auth/me", cookies: { ao_session: admin } });
    expect(old.statusCode).toBe(401);
  });

  it("logs a public client in end to end (PKCE only, no client secret)", async () => {
    const provider = await MockOidcProvider.create();
    const context = await createContext({ provider });
    provider.user = { sub: "pub-1", email: "public@example.com", email_verified: true };
    const { finish, session } = await runLogin(context);
    expect(finish.headers.location).toBe(`${WEB}/`);
    expect(session).toBeTruthy();
    expect(provider.tokenRequests[0]!.authorization).toBeNull();
    expect(provider.tokenRequests[0]!.body.get("client_secret")).toBeNull();
    expect(provider.tokenRequests[0]!.body.get("client_id")).toBe(provider.clientId);
  });

  it("keeps the code, state, tokens and client secret out of request logs and server spans", async () => {
    const context = await createContext({ captureLogs: true, env: { TRACING_ENABLED: "true" } });
    const admin = await adminCookie(context);
    const { callback, finish } = await runLogin(context);
    expect(finish.headers.location).toBe(`${WEB}/`);
    const code = callback.searchParams.get("code")!;
    const state = callback.searchParams.get("state")!;
    expect(code.length).toBeGreaterThan(8);

    const logText = context.logs.join("");
    expect(logText).toContain("/api/auth/oidc/callback?code=REDACTED&state=REDACTED");
    for (const secret of [code, state, CLIENT_SECRET, "at_user-1", "eyJ"]) {
      expect(logText).not.toContain(secret);
    }

    const traces = await context.app.inject({ method: "GET", url: "/api/observability/traces?limit=200", cookies: { ao_session: admin } });
    expect(traces.statusCode).toBe(200);
    expect(traces.body).toContain("/api/auth/oidc/callback");
    for (const secret of [code, state, CLIENT_SECRET]) {
      expect(traces.body).not.toContain(secret);
    }
  });
});
