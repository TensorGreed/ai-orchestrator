/**
 * LDAP sign-ins are audited as `user.login` like the other sign-in methods, success and refusal, the TOTP step
 * included. A refused sign-in answers the same whatever the reason (unknown user, wrong password, a directory error,
 * an account that cannot sign in), so the route cannot tell a caller who has an account; the reason is kept in the
 * audit entry and the server log only.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { AuthService, SERVICE_ACCOUNT_EMAIL_DOMAIN } from "./services/auth-service.js";
import { LdapAuthError, LdapService, type LdapProfile } from "./services/ldap-service.js";
import { MfaService, generateTotpCode } from "./services/mfa-service.js";
import { SecretService } from "./services/secret-service.js";
import { openTestStore } from "./test-support/test-store.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function boot(env: Record<string, string> = {}): Promise<{ app: FastifyInstance; store: Store; authService: AuthService; mfa: MfaService }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-ldap-audit-"));
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
    LDAP_ENABLED: "true",
    LDAP_URL: "ldaps://directory.internal.example:636",
    LDAP_BASE_DN: "dc=example,dc=test",
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

const profile = (email: string): LdapProfile => ({ dn: `uid=${email.split("@")[0]},dc=example,dc=test`, email, groups: [], attributes: {} });

async function ldapLogin(app: FastifyInstance, email: string, password = "pw") {
  return await app.inject({ method: "POST", url: "/api/auth/ldap/login", payload: { email, password } });
}

async function loginEntries(store: Store) {
  return (await store.listAuditLogs({ eventType: "user.login", pageSize: 100 })).items.reverse();
}

describe("LDAP sign-in", () => {
  it("answers the same for an unknown user, a wrong password and a directory error, and audits each refusal with its reason", async () => {
    const { app, store } = await boot();
    const authenticate = vi.spyOn(LdapService.prototype, "authenticate");
    authenticate.mockRejectedValueOnce(new LdapAuthError("user_not_found", "User not found in LDAP directory"));
    const unknown = await ldapLogin(app, "nobody@example.com");
    authenticate.mockRejectedValueOnce(new LdapAuthError("invalid_credentials", "The directory refused the password"));
    const wrong = await ldapLogin(app, "lia@example.com");
    authenticate.mockRejectedValueOnce(new Error("connect ECONNREFUSED directory.internal.example:636"));
    const down = await ldapLogin(app, "lia@example.com");

    for (const response of [unknown, wrong, down]) {
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "Invalid credentials" });
    }
    expect(down.body).not.toContain("directory.internal");

    const entries = await loginEntries(store);
    expect(entries.map((entry) => [entry.outcome, entry.metadata])).toEqual([
      ["failure", { method: "ldap", email: "nobody@example.com", reason: "user_not_found", error: "User not found in LDAP directory" }],
      ["failure", { method: "ldap", email: "lia@example.com", reason: "invalid_credentials", error: "The directory refused the password" }],
      ["failure", { method: "ldap", email: "lia@example.com", reason: "directory_error", error: "connect ECONNREFUSED directory.internal.example:636" }]
    ]);
  });

  it("LDAP not set up: 503 with a fixed message, the detail only in the audit entry", async () => {
    const { app, store } = await boot({ LDAP_ENABLED: "false" });
    const response = await ldapLogin(app, "lia@example.com");
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "LDAP sign-in is not available." });
    expect((await loginEntries(store))[0]).toMatchObject({
      outcome: "failure",
      metadata: { method: "ldap", reason: "ldap_unavailable", error: "LDAP not configured: LDAP_ENABLED is false" }
    });
  });

  it("audits a successful sign-in as user.login, and a service account's as a refusal with the same answer", async () => {
    const { app, store } = await boot();
    vi.spyOn(LdapService.prototype, "authenticate").mockImplementation(async (email: string) => profile(email));
    const ok = await ldapLogin(app, "new@example.com");
    expect(ok.statusCode).toBe(200);
    const user = ok.json<{ user: { id: string } }>().user;
    expect((await loginEntries(store))[0]).toMatchObject({
      outcome: "success",
      actorUserId: user.id,
      resourceType: "user",
      resourceId: user.id,
      metadata: { method: "ldap", provisioned: true }
    });

    // An address in the service-account domain never signs in.
    const refused = await ldapLogin(app, `bot@${SERVICE_ACCOUNT_EMAIL_DOMAIN}`);
    expect(refused.statusCode).toBe(401);
    expect(refused.json()).toEqual({ error: "Invalid credentials" });
    expect((await loginEntries(store)).at(-1)).toMatchObject({ outcome: "failure", metadata: { method: "ldap", reason: "account_refused" } });
  });

  it("the TOTP step: a wrong code and the completed sign-in are audited", async () => {
    const { app, store, authService, mfa } = await boot();
    const user = await authService.register({ email: "lia@example.com", password: "Pass-word-123!", role: "builder" });
    const enrollment = await mfa.enroll(user.id, user.email);
    expect(await mfa.activate(user.id, generateTotpCode(enrollment.secret))).toBe(true);
    vi.spyOn(LdapService.prototype, "authenticate").mockImplementation(async (email: string) => profile(email));

    const step = await ldapLogin(app, "lia@example.com");
    const { mfaChallenge } = step.json<{ mfaChallenge: string }>();
    const bad = await app.inject({ method: "POST", url: "/api/auth/login/mfa", payload: { challenge: mfaChallenge, code: "000000" } });
    expect(bad.statusCode).toBe(401);
    const second = (await ldapLogin(app, "lia@example.com")).json<{ mfaChallenge: string }>().mfaChallenge;
    const done = await app.inject({ method: "POST", url: "/api/auth/login/mfa", payload: { challenge: second, code: generateTotpCode(enrollment.secret) } });
    expect(done.statusCode).toBe(200);

    const entries = await loginEntries(store);
    expect(entries.map((entry) => [entry.outcome, entry.metadata])).toEqual([
      ["failure", { method: "ldap", reason: "mfa_invalid", identityKey: "uid=lia,dc=example,dc=test" }],
      ["success", { method: "ldap", provisioned: false, mfa: "local_totp" }]
    ]);
    expect(entries[1]).toMatchObject({ actorUserId: user.id, resourceId: user.id });
  });
});
