/**
 * Phase 13.2 — MFA on SSO (SSO_MFA) end to end for OIDC and SAML against in-process IdPs: `off` (unchanged), `idp`
 * (the IdP must assert MFA), `idp_or_local` (IdP MFA, else the existing local TOTP step, else MFA_ENFORCE enrolment,
 * else refusal). No session (and no provisioning) before MFA passes; audits say which path satisfied MFA and never
 * carry a token, assertion or code. Runs on SQLite, or on Postgres with TEST_STORE=postgres.
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
import { MockSamlIdp, type MockSamlUser } from "./test-support/mock-saml-idp.js";
import { AuthService } from "./services/auth-service.js";
import { MfaService, generateTotpCode } from "./services/mfa-service.js";
import { oidcIdentitySubject } from "./services/oidc-service.js";
import { samlIdentitySubject } from "./services/saml-service.js";
import { SecretService } from "./services/secret-service.js";

const WEB = "http://localhost:5173";
const SAML_IDP = "https://idp.example.test/saml/metadata";
const ENTRA_MFA = "http://schemas.microsoft.com/claims/multipleauthn";
const PASSWORD_ONLY = "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport";

interface TestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  tempDir: string;
  oidc: MockOidcProvider;
  saml: MockSamlIdp;
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

async function createContext(env: Record<string, string> = {}, options: { captureLogs?: boolean } = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-sso-mfa-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const oidc = await MockOidcProvider.create({ clientSecret: "oidc-secret-not-for-logs" });
  const saml = new MockSamlIdp(SAML_IDP);
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
    OIDC_ENABLED: "true",
    OIDC_ISSUER: oidc.issuer,
    OIDC_CLIENT_ID: oidc.clientId,
    OIDC_CLIENT_SECRET: oidc.clientSecret!,
    SAML_ENABLED: "true",
    SAML_ENTRY_POINT: "https://idp.example.test/saml/sso",
    SAML_ISSUER: "l2m-sp",
    SAML_CALLBACK_URL: "http://localhost:4000/api/auth/saml/callback",
    SAML_IDP_CERT: "MIIC-test",
    ...env
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = await createApp(config, store, secretService, authService, undefined, undefined, undefined, {
    oidcFetch: oidc.fetch,
    samlClientFactory: saml.factory,
    ...(options.captureLogs ? { logStream: { write: (line: string) => void logs.push(line) } } : {})
  });
  await app.ready();
  const context = { app, store, authService, tempDir, oidc, saml, masterKey, logs };
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

async function oidcLogin(context: TestContext, cookies: Record<string, string> = {}) {
  const start = await context.app.inject({ method: "GET", url: "/api/auth/oidc/login" });
  const flow = cookieValue(setCookies(start.headers["set-cookie"]), "l2m_oidc_flow")!;
  const authorizeUrl = String(start.headers.location);
  const callback = new URL(context.oidc.authorize(authorizeUrl));
  const finish = await context.app.inject({
    method: "GET",
    url: `${callback.pathname}${callback.search}`,
    cookies: { ...cookies, l2m_oidc_flow: flow }
  });
  const set = setCookies(finish.headers["set-cookie"]);
  return {
    authorizeUrl,
    code: callback.searchParams.get("code")!,
    finish,
    setCookies: set,
    session: cookieValue(set, "ao_session"),
    challengeCookie: cookieValue(set, "l2m_sso_mfa")
  };
}

async function samlFormLogin(context: TestContext, user: MockSamlUser) {
  const samlResponse = context.saml.issue(user);
  const finish = await context.app.inject({
    method: "POST",
    url: "/api/auth/saml/callback",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ SAMLResponse: samlResponse }).toString()
  });
  const set = setCookies(finish.headers["set-cookie"]);
  return { samlResponse, finish, setCookies: set, session: cookieValue(set, "ao_session"), challengeCookie: cookieValue(set, "l2m_sso_mfa") };
}

async function withTotp(context: TestContext, email: string, role: "admin" | "builder" | "operator" | "viewer" = "builder") {
  const user = await context.authService.register({ email, password: "LocalPassword123!", role });
  const mfa = new MfaService(context.store, context.masterKey);
  const enrollment = await mfa.enroll(user.id, user.email);
  expect(await mfa.activate(user.id, generateTotpCode(enrollment.secret))).toBe(true);
  return { user, secret: enrollment.secret };
}

async function completeTotp(context: TestContext, options: { cookie?: string; challenge?: string; code: string }) {
  return await context.app.inject({
    method: "POST",
    url: "/api/auth/login/mfa",
    payload: { code: options.code, ...(options.challenge ? { challenge: options.challenge } : {}) },
    cookies: options.cookie ? { l2m_sso_mfa: options.cookie } : {}
  });
}

async function loginAudits(context: TestContext, outcome?: "success" | "failure") {
  return (await context.store.listAuditLogs({ eventType: "user.login", ...(outcome ? { outcome } : {}) })).items;
}

describe("SSO_MFA=off keeps SSO sign-in as it was", () => {
  it("signs OIDC and SAML users in without MFA, even with local TOTP, and adds no MFA audit fields", async () => {
    const context = await createContext();
    await withTotp(context, "tess@example.com");
    context.oidc.user = { sub: "tess", email: "tess@example.com", email_verified: true, amr: ["pwd"] };
    const oidc = await oidcLogin(context);
    expect(oidc.finish.headers.location).toBe(`${WEB}/`);
    expect(oidc.session).toBeTruthy();
    expect(new URL(oidc.authorizeUrl).searchParams.has("acr_values")).toBe(false);

    const saml = await samlFormLogin(context, { nameID: "tess-saml", email: "tess@example.com", authnContexts: [PASSWORD_ONLY] });
    expect(saml.finish.headers.location).toBe(`${WEB}/`);
    expect(saml.session).toBeTruthy();
    expect(context.saml.clientOptions[0]).not.toHaveProperty("disableRequestedAuthnContext");

    for (const audit of await loginAudits(context, "success")) {
      expect(Object.keys(audit.metadata as Record<string, unknown>).sort()).toEqual(["method", "provisioned"]);
    }
  });
});

describe("SSO_MFA=idp", () => {
  it("OIDC: accepts amr MFA and records the claim; refuses a password-only login without provisioning or a session", async () => {
    const context = await createContext({ SSO_MFA: "idp" });
    context.oidc.user = { sub: "amy", email: "amy@example.com", email_verified: true, amr: ["pwd", "mfa"] };
    const ok = await oidcLogin(context);
    expect(ok.finish.headers.location).toBe(`${WEB}/`);
    expect(ok.session).toBeTruthy();
    const success = (await loginAudits(context, "success"))[0]!;
    expect(success.metadata).toMatchObject({ method: "oidc", mfa: "idp", mfaClaim: "amr", mfaValue: "mfa" });

    // A lone one-time code (a passwordless email code) is one factor: not MFA by default.
    context.oidc.user = { sub: "otp-only", email: "otp-only@example.com", email_verified: true, amr: ["otp"] };
    expect((await oidcLogin(context)).finish.headers.location).toBe(`${WEB}/?sso_error=sso_mfa_required`);

    // A TOTP-enrolled user does not get the local step in `idp` mode: the IdP must assert MFA.
    await withTotp(context, "ben@example.com");
    context.oidc.user = { sub: "ben", email: "ben@example.com", email_verified: true, amr: ["pwd"] };
    const refused = await oidcLogin(context);
    expect(refused.finish.headers.location).toBe(`${WEB}/?sso_error=sso_mfa_required`);
    expect(refused.session).toBeUndefined();
    expect(refused.challengeCookie).toBeUndefined();
    expect(await context.store.findSsoIdentity("oidc", oidcIdentitySubject(context.oidc.issuer, "ben"))).toBeNull();

    context.oidc.user = { sub: "newbie", email: "newbie@example.com", email_verified: true };
    const jit = await oidcLogin(context);
    expect(jit.finish.headers.location).toBe(`${WEB}/?sso_error=sso_mfa_required`);
    expect(await context.store.getUserByEmail("newbie@example.com")).toBeNull();

    const failures = await loginAudits(context, "failure");
    expect(failures).toHaveLength(3);
    expect(failures.map((item) => item.metadata)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "oidc", reason: "mfa_required", ssoMfa: "idp", amr: "pwd", identityKey: oidcIdentitySubject(context.oidc.issuer, "ben") }),
        expect.objectContaining({ method: "oidc", reason: "mfa_required", amr: "" })
      ])
    );
    expect(JSON.stringify(failures)).not.toContain(refused.code);
  });

  it("OIDC: asks for SSO_MFA_OIDC_ACR with acr_values and accepts a matching acr", async () => {
    const context = await createContext({ SSO_MFA: "idp", SSO_MFA_OIDC_ACR: "gold, https://refeds.org/profile/mfa" });
    context.oidc.user = { sub: "cat", email: "cat@example.com", email_verified: true, acr: "gold", amr: ["pwd"] };
    const ok = await oidcLogin(context);
    expect(new URL(ok.authorizeUrl).searchParams.get("acr_values")).toBe("gold https://refeds.org/profile/mfa");
    expect(ok.session).toBeTruthy();
    expect((await loginAudits(context, "success"))[0]!.metadata).toMatchObject({ mfa: "idp", mfaClaim: "acr", mfaValue: "gold" });

    context.oidc.user = { sub: "dan", email: "dan@example.com", email_verified: true, acr: "silver" };
    const refused = await oidcLogin(context);
    expect(refused.finish.headers.location).toBe(`${WEB}/?sso_error=sso_mfa_required`);
    expect((await loginAudits(context, "failure"))[0]!.metadata).toMatchObject({ reason: "mfa_required", acr: "silver" });
  });

  it("OIDC: reads amr from the signed ID token only, never from userinfo", async () => {
    const context = await createContext({ SSO_MFA: "idp" });
    context.oidc.user = { sub: "eve", email: "eve@example.com", email_verified: true, groups: [] };
    context.oidc.omitFromIdToken = ["groups"];
    context.oidc.userinfoExtra = { amr: ["mfa"] };
    const refused = await oidcLogin(context);
    expect(context.oidc.userinfoCalls).toBeGreaterThan(0);
    expect(refused.finish.headers.location).toBe(`${WEB}/?sso_error=sso_mfa_required`);
  });

  it("SAML: accepts an MFA AuthnContextClassRef, refuses password-only (form redirect and JSON code)", async () => {
    const context = await createContext({ SSO_MFA: "idp" });
    expect(context.saml.clientOptions[0]).toMatchObject({ disableRequestedAuthnContext: true });
    const ok = await samlFormLogin(context, { nameID: "fay", email: "fay@example.com", authnContexts: [PASSWORD_ONLY, ENTRA_MFA] });
    expect(ok.finish.headers.location).toBe(`${WEB}/`);
    expect(ok.session).toBeTruthy();
    expect((await loginAudits(context, "success"))[0]!.metadata).toMatchObject({
      method: "saml",
      mfa: "idp",
      mfaClaim: "authn_context",
      mfaValue: ENTRA_MFA
    });

    const refused = await samlFormLogin(context, { nameID: "gus", email: "gus@example.com", authnContexts: [PASSWORD_ONLY] });
    expect(refused.finish.headers.location).toBe(`${WEB}/?sso_error=sso_mfa_required`);
    expect(refused.session).toBeUndefined();
    expect(await context.store.getUserByEmail("gus@example.com")).toBeNull();

    const json = await context.app.inject({
      method: "POST",
      url: "/api/auth/saml/callback",
      payload: { SAMLResponse: context.saml.issue({ nameID: "gus", email: "gus@example.com", authnContexts: [PASSWORD_ONLY] }) }
    });
    expect(json.statusCode).toBe(401);
    expect(json.json()).toMatchObject({ code: "sso_mfa_required" });
    expect(setCookies(json.headers["set-cookie"])).toEqual([]);

    const failures = await loginAudits(context, "failure");
    expect(failures).toHaveLength(2);
    expect(failures[0]!.metadata).toMatchObject({
      method: "saml",
      reason: "mfa_required",
      authnContext: PASSWORD_ONLY,
      identityKey: samlIdentitySubject(SAML_IDP, "gus")
    });
  });
});

describe("SSO_MFA=idp_or_local", () => {
  it("OIDC: a TOTP user without IdP MFA gets the local challenge; nothing is linked or opened until the code passes", async () => {
    const context = await createContext({ SSO_MFA: "idp_or_local" }, { captureLogs: true });
    const { user, secret } = await withTotp(context, "hana@example.com", "operator");
    context.oidc.user = { sub: "hana", email: "hana@example.com", email_verified: true, amr: ["pwd"] };

    const pending = await oidcLogin(context);
    expect(pending.finish.statusCode).toBe(302);
    expect(pending.finish.headers.location).toBe(`${WEB}/?sso_mfa=totp`);
    expect(pending.session).toBeUndefined();
    expect(pending.challengeCookie).toMatch(/^mfa_/);
    const challengeHeader = pending.setCookies.find((cookie) => cookie.startsWith("l2m_sso_mfa="))!;
    expect(challengeHeader).toMatch(/HttpOnly/i);
    expect(challengeHeader).toMatch(/SameSite=Lax/i);
    expect(challengeHeader).toMatch(/Path=\/api\/auth\/login\/mfa/);
    expect(String(pending.finish.headers.location)).not.toContain(pending.challengeCookie!);
    // Not linked yet: the identity appears only after the TOTP step.
    expect(await context.store.findSsoIdentity("oidc", oidcIdentitySubject(context.oidc.issuer, "hana"))).toBeNull();
    expect((await context.store.listAuditLogs({ eventType: "user.login.mfa_challenge" })).items[0]?.metadata).toMatchObject({
      method: "oidc",
      mfaChallengeIssued: true
    });

    const done = await completeTotp(context, { cookie: pending.challengeCookie, code: generateTotpCode(secret) });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ user: { id: user.id, email: "hana@example.com" } });
    const doneCookies = setCookies(done.headers["set-cookie"]);
    expect(cookieValue(doneCookies, "ao_session")).toBeTruthy();
    expect(doneCookies.find((cookie) => cookie.startsWith("l2m_sso_mfa="))).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);
    expect(await context.store.findSsoIdentity("oidc", oidcIdentitySubject(context.oidc.issuer, "hana"))).toMatchObject({ userId: user.id });

    const login = (await loginAudits(context, "success")).find((item) => (item.metadata as { method?: string }).method === "oidc")!;
    expect(login.metadata).toMatchObject({ method: "oidc", mfa: "local_totp", provisioned: false });
    expect((await context.store.listAuditLogs({ eventType: "user.sso_linked" })).items[0]?.metadata).toMatchObject({
      provider: "oidc",
      mfaEnrolled: true
    });

    // The challenge is single-use.
    const again = await completeTotp(context, { cookie: pending.challengeCookie, code: generateTotpCode(secret) });
    expect(again.statusCode).toBe(401);
    // Neither the code nor the challenge reaches a log line or audit.
    const written = context.logs.join("\n") + JSON.stringify((await context.store.listAuditLogs({})).items);
    expect(written).not.toContain(pending.challengeCookie!);
    expect(written).not.toContain(pending.code);
  });

  it("OIDC: a wrong code opens no session and is audited", async () => {
    const context = await createContext({ SSO_MFA: "idp_or_local" });
    await withTotp(context, "ian@example.com");
    context.oidc.user = { sub: "ian", email: "ian@example.com", email_verified: true };
    const pending = await oidcLogin(context);
    const wrong = await completeTotp(context, { cookie: pending.challengeCookie, code: "000000" });
    expect(wrong.statusCode).toBe(401);
    expect(cookieValue(setCookies(wrong.headers["set-cookie"]), "ao_session")).toBeUndefined();
    expect((await loginAudits(context, "failure"))[0]!.metadata).toMatchObject({ method: "oidc", reason: "mfa_invalid" });
    expect(await context.store.findSsoIdentity("oidc", oidcIdentitySubject(context.oidc.issuer, "ian"))).toBeNull();
  });

  it("OIDC: IdP MFA still signs in directly; a user without TOTP is refused; MFA_ENFORCE admins get the enrolment session", async () => {
    const context = await createContext({ SSO_MFA: "idp_or_local", MFA_ENFORCE: "true" });
    await withTotp(context, "jay@example.com");
    context.oidc.user = { sub: "jay", email: "jay@example.com", email_verified: true, amr: ["mfa"] };
    const direct = await oidcLogin(context);
    expect(direct.session).toBeTruthy();
    expect(direct.challengeCookie).toBeUndefined();

    await context.authService.register({ email: "kim@example.com", password: "KimPassword123!", role: "builder" });
    context.oidc.user = { sub: "kim", email: "kim@example.com", email_verified: true };
    const refused = await oidcLogin(context);
    expect(refused.finish.headers.location).toBe(`${WEB}/?sso_error=sso_mfa_required`);
    expect(refused.session).toBeUndefined();

    const admin = await context.authService.register({ email: "lee@example.com", password: "LeePassword123!", role: "admin" });
    context.oidc.user = { sub: "lee", email: "lee@example.com", email_verified: true };
    const enrol = await oidcLogin(context);
    expect(enrol.finish.headers.location).toBe(`${WEB}/`);
    expect(enrol.session).toBeTruthy();
    const enrolAudit = (await context.store.listAuditLogs({ eventType: "user.login", actorUserId: admin.id })).items[0]!;
    expect(enrolAudit.metadata).toMatchObject({ method: "oidc", mfaEnrollmentRequired: true });
  });

  it("OIDC: MFA_ENFORCE uses the role the login ends with (a group mapping to admin)", async () => {
    const context = await createContext({ SSO_MFA: "idp_or_local", MFA_ENFORCE: "true" });
    await context.store.upsertSsoGroupMapping({ id: "m1", provider: "oidc", groupName: "l2m-admins", role: "admin" });
    context.oidc.user = { sub: "mo", email: "mo@example.com", email_verified: true, groups: ["l2m-admins"] };
    const admin = await oidcLogin(context);
    expect(admin.session).toBeTruthy();
    expect((await loginAudits(context, "success"))[0]!.metadata).toMatchObject({ mfaEnrollmentRequired: true, provisioned: true });

    context.oidc.user = { sub: "ned", email: "ned@example.com", email_verified: true, groups: [] };
    const viewer = await oidcLogin(context);
    expect(viewer.finish.headers.location).toBe(`${WEB}/?sso_error=sso_mfa_required`);
    expect(await context.store.getUserByEmail("ned@example.com")).toBeNull();
  });

  it("SAML: form post hands the challenge over in a cookie; JSON returns it like the password login", async () => {
    const context = await createContext({ SSO_MFA: "idp_or_local" });
    const { user, secret } = await withTotp(context, "olga@example.com");

    const pending = await samlFormLogin(context, { nameID: "olga", email: "olga@example.com", authnContexts: [PASSWORD_ONLY] });
    expect(pending.finish.headers.location).toBe(`${WEB}/?sso_mfa=totp`);
    expect(pending.session).toBeUndefined();
    expect(pending.challengeCookie).toBeTruthy();
    expect(await context.store.findSsoIdentity("saml", samlIdentitySubject(SAML_IDP, "olga"))).toBeNull();
    const done = await completeTotp(context, { cookie: pending.challengeCookie, code: generateTotpCode(secret) });
    expect(done.statusCode).toBe(200);
    expect(cookieValue(setCookies(done.headers["set-cookie"]), "ao_session")).toBeTruthy();
    expect(await context.store.findSsoIdentity("saml", samlIdentitySubject(SAML_IDP, "olga"))).toMatchObject({ userId: user.id });
    expect((await loginAudits(context, "success"))[0]!.metadata).toMatchObject({ method: "saml", mfa: "local_totp" });
    expect((await context.store.listAuditLogs({ eventType: "user.sso_linked" })).items[0]?.metadata).toMatchObject({
      provider: "saml",
      mfaEnrolled: true
    });

    const json = await context.app.inject({
      method: "POST",
      url: "/api/auth/saml/callback",
      payload: { SAMLResponse: context.saml.issue({ nameID: "olga", email: "olga@example.com", authnContexts: [PASSWORD_ONLY] }) }
    });
    expect(json.statusCode).toBe(200);
    const body = json.json() as { mfaChallenge: string; expiresInSeconds: number };
    expect(body.mfaChallenge).toMatch(/^mfa_/);
    expect(body.expiresInSeconds).toBe(300);
    expect(setCookies(json.headers["set-cookie"])).toEqual([]);
    const viaBody = await completeTotp(context, { challenge: body.mfaChallenge, code: generateTotpCode(secret) });
    expect(viaBody.statusCode).toBe(200);
    // Linked now, so no second link audit.
    expect((await context.store.listAuditLogs({ eventType: "user.sso_linked" })).items).toHaveLength(1);
  });

  it("SAML: JSON tells an MFA_ENFORCE admin without TOTP that enrolment is required, like the password login", async () => {
    const context = await createContext({ SSO_MFA: "idp_or_local", MFA_ENFORCE: "true" });
    await context.authService.register({ email: "rae@example.com", password: "RaePassword123!", role: "admin" });
    const json = await context.app.inject({
      method: "POST",
      url: "/api/auth/saml/callback",
      payload: { SAMLResponse: context.saml.issue({ nameID: "rae", email: "rae@example.com", authnContexts: [PASSWORD_ONLY] }) }
    });
    expect(json.statusCode).toBe(200);
    expect(json.json()).toMatchObject({ user: { email: "rae@example.com", role: "admin" }, mfaEnrollmentRequired: true });
    // Signed in with IdP MFA: no flag.
    const withMfa = await context.app.inject({
      method: "POST",
      url: "/api/auth/saml/callback",
      payload: { SAMLResponse: context.saml.issue({ nameID: "rae", email: "rae@example.com", authnContexts: [ENTRA_MFA] }) }
    });
    expect(withMfa.json()).not.toHaveProperty("mfaEnrollmentRequired");
  });

  it("SAML: a legacy identity is re-keyed only once the TOTP step passes", async () => {
    const context = await createContext({ SSO_MFA: "idp_or_local" });
    const { user, secret } = await withTotp(context, "sid@example.com");
    await context.store.upsertSsoIdentity({ id: "sso_sid", userId: user.id, provider: "saml", subject: "sid-id", email: "sid@example.com" });
    const pending = await samlFormLogin(context, { nameID: "sid-id", email: "sid@example.com", authnContexts: [PASSWORD_ONLY] });
    expect(pending.finish.headers.location).toBe(`${WEB}/?sso_mfa=totp`);
    expect(await context.store.findSsoIdentity("saml", "sid-id")).toMatchObject({ id: "sso_sid" });
    expect(await context.store.findSsoIdentity("saml", samlIdentitySubject(SAML_IDP, "sid-id"))).toBeNull();
    const done = await completeTotp(context, { cookie: pending.challengeCookie, code: generateTotpCode(secret) });
    expect(done.statusCode).toBe(200);
    expect(await context.store.findSsoIdentity("saml", "sid-id")).toBeNull();
    expect(await context.store.findSsoIdentity("saml", samlIdentitySubject(SAML_IDP, "sid-id"))).toMatchObject({ id: "sso_sid", userId: user.id });
    expect((await loginAudits(context, "success"))[0]!.metadata).toMatchObject({ method: "saml", mfa: "local_totp", identityUpgraded: true });
  });

  it("refuses the TOTP step of an SSO sign-in whose account was deleted meanwhile, without creating a new one", async () => {
    const context = await createContext({ SSO_MFA: "idp_or_local" });
    const { user, secret } = await withTotp(context, "tess@example.com");
    const pending = await samlFormLogin(context, { nameID: "tess", email: "tess@example.com", authnContexts: [PASSWORD_ONLY] });
    expect(pending.challengeCookie).toBeTruthy();
    const code = generateTotpCode(secret);
    expect(await context.store.deleteUser(user.id)).toBe(true);
    const done = await completeTotp(context, { cookie: pending.challengeCookie, code });
    expect(done.statusCode).toBe(401);
    expect(cookieValue(setCookies(done.headers["set-cookie"]), "ao_session")).toBeUndefined();
    expect(await context.store.getUserByEmail("tess@example.com")).toBeNull();
    expect(await context.store.findSsoIdentity("saml", samlIdentitySubject(SAML_IDP, "tess"))).toBeNull();
  });

  it("SAML: IdP MFA signs in directly and a user without TOTP is refused", async () => {
    const context = await createContext({ SSO_MFA: "idp_or_local" });
    await withTotp(context, "pat@example.com");
    const direct = await samlFormLogin(context, { nameID: "pat", email: "pat@example.com", authnContexts: ["https://refeds.org/profile/mfa"] });
    expect(direct.session).toBeTruthy();
    expect(direct.challengeCookie).toBeUndefined();
    const refused = await samlFormLogin(context, { nameID: "quinn", email: "quinn@example.com", authnContexts: [PASSWORD_ONLY] });
    expect(refused.finish.headers.location).toBe(`${WEB}/?sso_error=sso_mfa_required`);
    expect(await context.store.getUserByEmail("quinn@example.com")).toBeNull();
  });

  it("keeps a password-login challenge and an SSO challenge apart, each usable once", async () => {
    const context = await createContext({ SSO_MFA: "idp_or_local" });
    const { secret } = await withTotp(context, "rae@example.com");
    const password = await context.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "rae@example.com", password: "LocalPassword123!" }
    });
    const localChallenge = (password.json() as { mfaChallenge: string }).mfaChallenge;
    expect(localChallenge).toMatch(/^mfa_/);
    // The body challenge wins over an SSO cookie sent along, and that cookie is left alone.
    context.oidc.user = { sub: "rae", email: "rae@example.com", email_verified: true };
    const sso = await oidcLogin(context);
    expect(sso.challengeCookie).toBeTruthy();
    const local = await completeTotp(context, { challenge: localChallenge, cookie: sso.challengeCookie, code: generateTotpCode(secret) });
    expect(local.statusCode).toBe(200);
    expect(setCookies(local.headers["set-cookie"]).some((cookie) => cookie.startsWith("l2m_sso_mfa="))).toBe(false);
    const ssoDone = await completeTotp(context, { cookie: sso.challengeCookie, code: generateTotpCode(secret) });
    expect(ssoDone.statusCode).toBe(200);
    expect((await completeTotp(context, { challenge: localChallenge, code: generateTotpCode(secret) })).statusCode).toBe(401);
  });
});
