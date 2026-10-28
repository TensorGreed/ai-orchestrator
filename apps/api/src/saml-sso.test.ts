/**
 * Phase 13.2 — SAML parity with OIDC, end to end through the API against an in-process IdP (no network, no
 * @node-saml/node-saml): audits (`user.login`, `user.sso_linked`, refusals), the optional allow-lists, IdP-scoped
 * identities with the one-time legacy upgrade, the browser form-post binding, and no SAMLResponse in any answer, log
 * line or audit. Runs on SQLite, or on Postgres with TEST_STORE=postgres.
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
import { MockSamlIdp, type MockSamlUser } from "./test-support/mock-saml-idp.js";
import { AuthService } from "./services/auth-service.js";
import { MfaService, generateTotpCode } from "./services/mfa-service.js";
import { samlIdentitySubject } from "./services/saml-service.js";
import { SecretService } from "./services/secret-service.js";

const WEB = "http://localhost:5173";
const IDP = "https://idp.example.test/saml/metadata";

interface TestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  tempDir: string;
  idp: MockSamlIdp;
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

async function createContext(options: { enabled?: boolean; env?: Record<string, string>; captureLogs?: boolean } = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-saml-sso-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const idp = new MockSamlIdp(IDP);
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
          SAML_ENABLED: "true",
          SAML_ENTRY_POINT: "https://idp.example.test/saml/sso",
          SAML_ISSUER: "l2m-sp",
          SAML_CALLBACK_URL: "http://localhost:4000/api/auth/saml/callback",
          SAML_IDP_CERT: "MIIC-test"
        }),
    ...(options.env ?? {})
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = await createApp(config, store, secretService, authService, undefined, undefined, undefined, {
    samlClientFactory: idp.factory,
    ...(options.captureLogs ? { logStream: { write: (line: string) => void logs.push(line) } } : {})
  });
  await app.ready();
  const context = { app, store, authService, tempDir, idp, masterKey, logs };
  contexts.push(context);
  return context;
}

function setCookies(header: string | string[] | number | undefined): string[] {
  if (Array.isArray(header)) return header;
  return typeof header === "string" ? [header] : [];
}

function cookieValue(cookies: string[], name: string): string | undefined {
  const found = cookies.find((cookie) => cookie.startsWith(`${name}=`));
  return found ? found.split(";")[0]!.slice(name.length + 1) || undefined : undefined;
}

/** The IdP's auto-submitting form posting the SAMLResponse to the callback (HTTP-POST binding). */
async function formLogin(context: TestContext, user: MockSamlUser, cookies: Record<string, string> = {}) {
  const samlResponse = context.idp.issue(user);
  const response = await context.app.inject({
    method: "POST",
    url: "/api/auth/saml/callback",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ SAMLResponse: samlResponse, RelayState: "" }).toString(),
    cookies
  });
  const set = setCookies(response.headers["set-cookie"]);
  return { samlResponse, response, cookies: set, session: cookieValue(set, "ao_session") };
}

/** The JSON callback (API clients), unchanged from before. */
async function jsonLogin(context: TestContext, user: MockSamlUser) {
  const samlResponse = context.idp.issue(user);
  const response = await context.app.inject({ method: "POST", url: "/api/auth/saml/callback", payload: { SAMLResponse: samlResponse } });
  const set = setCookies(response.headers["set-cookie"]);
  return { samlResponse, response, session: cookieValue(set, "ao_session") };
}

async function adminCookie(context: TestContext): Promise<string> {
  await context.authService.register({ email: "admin@example.com", password: "AdminPassword123!", role: "admin" });
  const login = await context.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "admin@example.com", password: "AdminPassword123!" }
  });
  return cookieValue(setCookies(login.headers["set-cookie"]), "ao_session")!;
}

async function me(context: TestContext, session: string) {
  const response = await context.app.inject({ method: "GET", url: "/api/auth/me", cookies: { ao_session: session } });
  expect(response.statusCode).toBe(200);
  return (response.json() as { user: { id: string; email: string; role: string } }).user;
}

describe("SAML SSO when off", () => {
  it("answers the callback as before and audits nothing", async () => {
    const context = await createContext({ enabled: false });
    const json = await context.app.inject({ method: "POST", url: "/api/auth/saml/callback", payload: { SAMLResponse: "abc" } });
    expect(json.statusCode).toBe(401);
    expect(json.json()).toEqual({ error: expect.stringMatching(/SAML not initialised/) });
    const missing = await context.app.inject({ method: "POST", url: "/api/auth/saml/callback", payload: {} });
    expect(missing.statusCode).toBe(400);
    const form = await context.app.inject({
      method: "POST",
      url: "/api/auth/saml/callback",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "SAMLResponse=abc"
    });
    expect(form.statusCode).toBe(302);
    expect(form.headers.location).toBe(`${WEB}/?sso_error=saml_unavailable`);
    expect((await context.store.listAuditLogs({ eventType: "user.login" })).items).toHaveLength(0);
    expect(context.idp.clientOptions).toHaveLength(0);
  });
});

describe("SAML SSO login", () => {
  it("creates a user over JSON with mapped roles, binds the identity to the IdP and audits the login", async () => {
    const context = await createContext();
    const admin = await adminCookie(context);
    const mapping = await context.app.inject({
      method: "POST",
      url: "/api/auth/sso/mappings",
      cookies: { ao_session: admin },
      payload: { provider: "saml", groupName: "eng", role: "builder" }
    });
    expect(mapping.statusCode).toBe(200);

    const { samlResponse, response, session } = await jsonLogin(context, { nameID: "dana", email: "Dana@Example.com", groups: ["eng"] });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ user: { email: "dana@example.com", role: "builder" }, provisioned: true });
    expect(response.body).not.toContain(samlResponse);
    expect(session).toBeTruthy();
    const user = await me(context, session!);

    expect(await context.store.findSsoIdentity("saml", samlIdentitySubject(IDP, "dana"))).toMatchObject({
      userId: user.id,
      attributes: { issuer: IDP, nameId: "dana", groups: ["eng"] }
    });
    expect(await context.store.findSsoIdentity("saml", "dana")).toBeNull();

    const logins = await context.store.listAuditLogs({ eventType: "user.login", actorUserId: user.id });
    expect(logins.items).toHaveLength(1);
    expect(logins.items[0]).toMatchObject({ outcome: "success", metadata: { method: "saml", provisioned: true } });
    // A JIT-created user is not "linked" to an existing account.
    expect((await context.store.listAuditLogs({ eventType: "user.sso_linked" })).items).toHaveLength(0);
  });

  it("signs a browser in from the IdP's form post and redirects to the web app", async () => {
    const context = await createContext();
    const { response, session } = await formLogin(context, { nameID: "erin", email: "erin@example.com" });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`${WEB}/`);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect((await me(context, session!)).email).toBe("erin@example.com");
  });

  it("links an existing account by the asserted email once, audits user.sso_linked with mfaEnrolled, and keeps the link by identity", async () => {
    const context = await createContext();
    const existing = await context.authService.register({ email: "frank@example.com", password: "FrankPassword123!", role: "operator" });
    const mfa = new MfaService(context.store, context.masterKey);
    const enrollment = await mfa.enroll(existing.id, existing.email);
    expect(await mfa.activate(existing.id, generateTotpCode(enrollment.secret))).toBe(true);

    const first = await formLogin(context, { nameID: "frank-id", email: "frank@example.com" });
    expect(first.response.headers.location).toBe(`${WEB}/`);
    expect((await me(context, first.session!)).id).toBe(existing.id);
    const linked = await context.store.listAuditLogs({ eventType: "user.sso_linked" });
    expect(linked.items).toHaveLength(1);
    expect(linked.items[0]).toMatchObject({
      resourceId: existing.id,
      metadata: { provider: "saml", email: "frank@example.com", role: "operator", mfaEnrolled: true }
    });

    // The IdP changes the email: the identity still points at the same account, no new link, no new user.
    const second = await formLogin(context, { nameID: "frank-id", email: "frank.new@example.com" });
    expect((await me(context, second.session!)).id).toBe(existing.id);
    expect(await context.store.getUserByEmail("frank.new@example.com")).toBeNull();
    expect((await context.store.listAuditLogs({ eventType: "user.sso_linked" })).items).toHaveLength(1);
    expect((await context.store.listAuditLogs({ eventType: "user.login", actorUserId: existing.id, outcome: "success" })).items).toHaveLength(2);
  });

  it("upgrades a legacy bare-NameID identity on its first login and audits the upgrade", async () => {
    const context = await createContext();
    const existing = await context.authService.register({ email: "gina@example.com", password: "GinaPassword123!", role: "builder" });
    await context.store.upsertSsoIdentity({ id: "sso_legacy", userId: existing.id, provider: "saml", subject: "gina-id", email: "gina@example.com" });

    // Even with a new email the legacy row identifies the user.
    const { session } = await formLogin(context, { nameID: "gina-id", email: "gina.renamed@example.com" });
    expect((await me(context, session!)).id).toBe(existing.id);
    expect(await context.store.findSsoIdentity("saml", "gina-id")).toBeNull();
    expect(await context.store.findSsoIdentity("saml", samlIdentitySubject(IDP, "gina-id"))).toMatchObject({ id: "sso_legacy", userId: existing.id });
    const login = (await context.store.listAuditLogs({ eventType: "user.login", actorUserId: existing.id })).items[0];
    expect(login?.metadata).toMatchObject({ method: "saml", identityUpgraded: true });
    expect((await context.store.listAuditLogs({ eventType: "user.sso_linked" })).items).toHaveLength(0);
  });

  it("does not match a scoped identity when the same NameID comes from another IdP", async () => {
    const context = await createContext();
    const owner = await context.authService.register({ email: "owner@example.com", password: "OwnerPassword123!", role: "admin" });
    await context.store.upsertSsoIdentity({ id: "sso_owner", userId: owner.id, provider: "saml", subject: samlIdentitySubject(IDP, "shared-id") });

    const { session } = await formLogin(context, { nameID: "shared-id", email: "stranger@example.com", issuer: "https://other-idp.example/metadata" });
    const user = await me(context, session!);
    expect(user.id).not.toBe(owner.id);
    expect(user).toMatchObject({ email: "stranger@example.com", role: "viewer" });
    expect(await context.store.findSsoIdentity("saml", "https://other-idp.example/metadata#shared-id")).toMatchObject({ userId: user.id });
  });

  it("refuses an assertion from an issuer other than SAML_IDP_ISSUER, and one without an Issuer", async () => {
    const context = await createContext({ env: { SAML_IDP_ISSUER: IDP } });
    expect(context.idp.clientOptions[0]).toMatchObject({ idpIssuer: IDP });
    const wrong = await formLogin(context, { nameID: "x", email: "x@example.com", issuer: "https://evil.example/idp" });
    expect(wrong.response.headers.location).toBe(`${WEB}/?sso_error=saml_failed`);
    expect(wrong.session).toBeUndefined();
    const none = await jsonLogin(context, { nameID: "y", email: "y@example.com", issuer: null });
    expect(none.response.statusCode).toBe(401);
    expect(none.session).toBeUndefined();
    expect(await context.store.getUserByEmail("x@example.com")).toBeNull();
    const failures = await context.store.listAuditLogs({ eventType: "user.login", outcome: "failure" });
    expect(failures.items.map((item) => (item.metadata as { reason?: string }).reason).sort()).toEqual(["issuer_mismatch", "missing_issuer"]);
  });

  it("refuses a forged or replayed response without a session, and audits it", async () => {
    const context = await createContext();
    const first = await formLogin(context, { nameID: "hal", email: "hal@example.com" });
    expect(first.session).toBeTruthy();
    const replay = await context.app.inject({
      method: "POST",
      url: "/api/auth/saml/callback",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ SAMLResponse: first.samlResponse }).toString()
    });
    expect(replay.headers.location).toBe(`${WEB}/?sso_error=saml_failed`);
    expect(cookieValue(setCookies(replay.headers["set-cookie"]), "ao_session")).toBeUndefined();
    const forged = await context.app.inject({ method: "POST", url: "/api/auth/saml/callback", payload: { SAMLResponse: "forged" } });
    expect(forged.statusCode).toBe(401);
    const failures = await context.store.listAuditLogs({ eventType: "user.login", outcome: "failure" });
    expect(failures.items).toHaveLength(2);
    expect(failures.items.every((item) => (item.metadata as { method?: string }).method === "saml")).toBe(true);
  });

  it("replaces a session the browser already holds", async () => {
    const context = await createContext();
    const first = await formLogin(context, { nameID: "ivy", email: "ivy@example.com" });
    const second = await formLogin(context, { nameID: "ivy", email: "ivy@example.com" }, { ao_session: first.session! });
    expect(second.session).toBeTruthy();
    const old = await context.app.inject({ method: "GET", url: "/api/auth/me", cookies: { ao_session: first.session! } });
    expect(old.statusCode).toBe(401);
  });
});

describe("SAML allow-lists", () => {
  it("refuse new and returning users outside SAML_ALLOWED_EMAIL_DOMAINS / SAML_ALLOWED_GROUPS", async () => {
    const context = await createContext({ env: { SAML_ALLOWED_EMAIL_DOMAINS: "example.com", SAML_ALLOWED_GROUPS: "l2m-users" } });

    const outsider = await formLogin(context, { nameID: "out", email: "out@gmail.test", groups: ["l2m-users"] });
    expect(outsider.response.headers.location).toBe(`${WEB}/?sso_error=saml_not_allowed`);
    expect(outsider.session).toBeUndefined();
    expect(await context.store.getUserByEmail("out@gmail.test")).toBeNull();

    const json = await jsonLogin(context, { nameID: "nogroup", email: "nogroup@example.com", groups: [] });
    expect(json.response.statusCode).toBe(403);
    expect(json.response.json()).toMatchObject({ code: "saml_not_allowed" });

    const member = await formLogin(context, { nameID: "member", email: "member@example.com", groups: ["l2m-users"] });
    expect(member.session).toBeTruthy();
    // Removed from the group at the IdP: refused on the next login.
    const removed = await formLogin(context, { nameID: "member", email: "member@example.com", groups: [] });
    expect(removed.response.headers.location).toBe(`${WEB}/?sso_error=saml_not_allowed`);
    expect(removed.session).toBeUndefined();

    const failures = await context.store.listAuditLogs({ eventType: "user.login", outcome: "failure" });
    expect(failures.items).toHaveLength(3);
    expect(failures.items.map((item) => item.metadata)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "saml", reason: "not_allowed", list: "SAML_ALLOWED_EMAIL_DOMAINS", emailDomain: "gmail.test", identityKey: `${IDP}#out` }),
        expect.objectContaining({ method: "saml", reason: "not_allowed", list: "SAML_ALLOWED_GROUPS", identityKey: `${IDP}#member` })
      ])
    );
    expect(JSON.stringify(failures.items)).not.toContain("out@gmail.test");
  });
});

describe("SAML secrets stay out of logs and audits", () => {
  it("never writes the SAMLResponse to a log line, response or audit", async () => {
    const context = await createContext({ captureLogs: true });
    const ok = await formLogin(context, { nameID: "jo", email: "jo@example.com" });
    const bad = await formLogin(context, { nameID: "jo", email: "jo@example.com", issuer: "https://x.example/#bad" });
    expect(bad.session).toBeUndefined();
    const audits = await context.store.listAuditLogs({});
    const everything = [context.logs.join("\n"), JSON.stringify(audits.items), ok.response.body, bad.response.body].join("\n");
    expect(context.logs.join("\n")).toContain("/api/auth/saml/callback");
    for (const secret of [ok.samlResponse, bad.samlResponse]) {
      expect(everything).not.toContain(secret);
      expect(everything).not.toContain(encodeURIComponent(secret));
    }
  });
});
