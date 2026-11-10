/**
 * 13.2 — MFA required per role (MFA_REQUIRED_ROLES, MFA_ENFORCE as its alias), step-up before security-admin actions
 * (STEP_UP_MAX_AGE_MINUTES), the admin MFA reset, the LDAP code step and the last-admin check, through the app.
 * Runs on SQLite, or on Postgres with TEST_STORE=postgres.
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
import { AuthService, type SafeUser } from "./services/auth-service.js";
import { LdapService, type LdapProfile } from "./services/ldap-service.js";
import { MfaService, generateTotpCode } from "./services/mfa-service.js";
import { STEP_UP_ACTIONS } from "./services/mfa-policy.js";
import { SecretService } from "./services/secret-service.js";
import { openTestStore } from "./test-support/test-store.js";
import { testSql } from "./test-support/test-sql.js";

interface Booted {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  mfa: MfaService;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function boot(env: Record<string, string> = {}): Promise<Booted> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-mfa-stepup-"));
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

async function register(booted: Booted, email: string, role: SafeUser["role"]) {
  return await booted.authService.register({ email, password: "Pass-word-123!", role });
}

/** Enrols and activates TOTP for a user; returns the secret and backup codes. */
async function enrolTotp(booted: Booted, user: SafeUser) {
  const enrollment = await booted.mfa.enroll(user.id, user.email);
  expect(await booted.mfa.activate(user.id, generateTotpCode(enrollment.secret))).toBe(true);
  return enrollment;
}

/** Password sign-in, through the code step when the user has TOTP. Returns the session cookie value. */
async function signIn(booted: Booted, email: string, secret?: string): Promise<string> {
  const login = await booted.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "Pass-word-123!" } });
  expect(login.statusCode).toBe(200);
  const body = login.json() as { mfaChallenge?: string };
  if (!body.mfaChallenge) return sessionCookie(login.headers["set-cookie"])!;
  const done = await booted.app.inject({
    method: "POST",
    url: "/api/auth/login/mfa",
    payload: { challenge: body.mfaChallenge, code: generateTotpCode(secret!) }
  });
  expect(done.statusCode).toBe(200);
  return sessionCookie(done.headers["set-cookie"])!;
}

const as = (session: string) => ({ cookies: { ao_session: session } });

async function setMfaVerifiedAt(booted: Booted, sessionId: string, at: string | null) {
  await testSql(booted.store).run(`UPDATE sessions SET mfa_verified_at = ? WHERE id = ?`, at, sessionId);
}

describe("MFA_REQUIRED_ROLES", () => {
  it("restricts an unenrolled user in a listed role to MFA setup until a code is activated; other roles are untouched", async () => {
    const booted = await boot({ MFA_REQUIRED_ROLES: "admin,builder" });
    const builder = await register(booted, "bea@example.com", "builder");
    await register(booted, "otto@example.com", "operator");

    const login = await booted.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "bea@example.com", password: "Pass-word-123!" } });
    expect(login.json()).toMatchObject({ user: { id: builder.id }, mfaEnrollmentRequired: true });
    const session = sessionCookie(login.headers["set-cookie"])!;

    const refused = await booted.app.inject({ method: "GET", url: "/api/workflows", ...as(session) });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: "mfa_enrollment_required" });
    const me = await booted.app.inject({ method: "GET", url: "/api/auth/me", ...as(session) });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ user: { id: builder.id }, mfaEnrollmentRequired: true });
    const status = await booted.app.inject({ method: "GET", url: "/api/auth/mfa/status", ...as(session) });
    expect(status.json()).toMatchObject({ enabled: false, requiredForRole: true, stepUpMaxAgeMinutes: 0 });

    const enrol = await booted.app.inject({ method: "POST", url: "/api/auth/mfa/enroll", ...as(session) });
    expect(enrol.statusCode).toBe(200);
    const { secret } = enrol.json() as { secret: string };
    const activate = await booted.app.inject({
      method: "POST",
      url: "/api/auth/mfa/activate",
      payload: { code: generateTotpCode(secret) },
      ...as(session)
    });
    expect(activate.statusCode).toBe(200);
    expect((await booted.store.getSession(session))?.mfaVerifiedAt).toBeTruthy();
    expect((await booted.app.inject({ method: "GET", url: "/api/workflows", ...as(session) })).statusCode).toBe(200);
    const meAfter = (await booted.app.inject({ method: "GET", url: "/api/auth/me", ...as(session) })).json() as Record<string, unknown>;
    expect(meAfter).not.toHaveProperty("mfaEnrollmentRequired");

    const operatorLogin = await booted.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "otto@example.com", password: "Pass-word-123!" } });
    expect(operatorLogin.json()).not.toHaveProperty("mfaEnrollmentRequired");
    const operator = sessionCookie(operatorLogin.headers["set-cookie"])!;
    expect((await booted.app.inject({ method: "GET", url: "/api/workflows", ...as(operator) })).statusCode).toBe(200);
  });

  it("MFA_ENFORCE=true restricts admins exactly as MFA_REQUIRED_ROLES=admin does, and nobody else", async () => {
    const envs: Array<Record<string, string>> = [{ MFA_ENFORCE: "true" }, { MFA_REQUIRED_ROLES: "admin" }];
    for (const env of envs) {
      const booted = await boot(env);
      await register(booted, "root@example.com", "admin");
      await register(booted, "bob@example.com", "builder");
      const admin = await signIn(booted, "root@example.com");
      const builder = await signIn(booted, "bob@example.com");
      expect((await booted.app.inject({ method: "GET", url: "/api/users", ...as(admin) })).json()).toMatchObject({ code: "mfa_enrollment_required" });
      expect((await booted.app.inject({ method: "GET", url: "/api/workflows", ...as(builder) })).statusCode).toBe(200);
    }
  });

  it("an enrolled user's session without an MFA check (pre-upgrade, or promoted into a listed role) must verify a code", async () => {
    const booted = await boot({ MFA_REQUIRED_ROLES: "admin" });
    const admin = await register(booted, "ada@example.com", "admin");
    const { secret, backupCodes } = await enrolTotp(booted, admin);
    const session = await signIn(booted, "ada@example.com", secret);
    await setMfaVerifiedAt(booted, session, null);

    const refused = await booted.app.inject({ method: "GET", url: "/api/workflows", ...as(session) });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: "mfa_verification_required" });
    expect((await booted.app.inject({ method: "GET", url: "/api/auth/me", ...as(session) })).json()).toMatchObject({ mfaVerificationRequired: true });
    // Enrolment is not what this session needs.
    expect((await booted.app.inject({ method: "POST", url: "/api/auth/mfa/enroll", ...as(session) })).statusCode).toBe(403);

    const wrong = await booted.app.inject({ method: "POST", url: "/api/auth/step-up", payload: { code: "000000" }, ...as(session) });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json()).toMatchObject({ code: "mfa_code_invalid" });
    const ok = await booted.app.inject({ method: "POST", url: "/api/auth/step-up", payload: { code: backupCodes[0] }, ...as(session) });
    expect(ok.statusCode).toBe(200);
    expect((await booted.app.inject({ method: "GET", url: "/api/workflows", ...as(session) })).statusCode).toBe(200);
    const audits = (await booted.store.listAuditLogs({ eventType: "mfa.step_up" })).items.map((entry) => entry.outcome);
    expect(audits).toEqual(["success"]);
    const failures = (await booted.store.listAuditLogs({ eventType: "mfa.code_failed" })).items;
    expect(failures.map((entry) => [entry.outcome, entry.resourceId, entry.metadata])).toEqual([["failure", admin.id, { via: "step_up" }]]);
  });

  it("a break-glass session is not restricted; restricted sessions cannot register users through public registration as admins", async () => {
    const booted = await boot({ MFA_REQUIRED_ROLES: "admin", AUTH_ALLOW_PUBLIC_REGISTER: "true" });
    const admin = await register(booted, "root@example.com", "admin");
    const breakGlass = await booted.authService.sessions.issueSession({ user: admin, method: "break_glass" });
    expect((await booted.app.inject({ method: "GET", url: "/api/users", ...as(breakGlass.sessionId) })).statusCode).toBe(200);

    const restricted = await signIn(booted, "root@example.com");
    const created = await booted.app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "new-admin@example.com", password: "Pass-word-123!", role: "admin" },
      ...as(restricted)
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ user: { role: "viewer" } });
  });

  it("LDAP: an enrolled user gets the code step (session recorded as ldap); an unenrolled listed role gets the enrolment-only session", async () => {
    const booted = await boot({ MFA_REQUIRED_ROLES: "admin", LDAP_ENABLED: "true" });
    const admin = await register(booted, "lia@example.com", "admin");
    await register(booted, "len@example.com", "admin");
    const { secret } = await enrolTotp(booted, admin);
    vi.spyOn(LdapService.prototype, "authenticate").mockImplementation(async (email: string): Promise<LdapProfile> => ({
      dn: `uid=${email.split("@")[0]},dc=example,dc=test`,
      email,
      groups: [],
      attributes: {}
    }));

    const step = await booted.app.inject({ method: "POST", url: "/api/auth/ldap/login", payload: { email: "lia@example.com", password: "x" } });
    expect(step.statusCode).toBe(200);
    const { mfaChallenge } = step.json() as { mfaChallenge: string };
    expect(mfaChallenge).toMatch(/^mfa_/);
    expect(sessionCookie(step.headers["set-cookie"])).toBeUndefined();
    const done = await booted.app.inject({ method: "POST", url: "/api/auth/login/mfa", payload: { challenge: mfaChallenge, code: generateTotpCode(secret) } });
    expect(done.statusCode).toBe(200);
    const session = sessionCookie(done.headers["set-cookie"])!;
    expect(await booted.store.getSession(session)).toMatchObject({ authMethod: "ldap", mfaVerifiedAt: expect.any(String) });
    expect((await booted.app.inject({ method: "GET", url: "/api/users", ...as(session) })).statusCode).toBe(200);

    const unenrolled = await booted.app.inject({ method: "POST", url: "/api/auth/ldap/login", payload: { email: "len@example.com", password: "x" } });
    expect(unenrolled.json()).toMatchObject({ mfaEnrollmentRequired: true });
    const restricted = sessionCookie(unenrolled.headers["set-cookie"])!;
    expect((await booted.app.inject({ method: "GET", url: "/api/users", ...as(restricted) })).json()).toMatchObject({ code: "mfa_enrollment_required" });
  });
});

describe("step-up (STEP_UP_MAX_AGE_MINUTES)", () => {
  it("off by default: guarded actions behave as before, keys included", async () => {
    const booted = await boot();
    await register(booted, "root@example.com", "admin");
    const target = await register(booted, "tia@example.com", "viewer");
    const session = await signIn(booted, "root@example.com");
    const key = (await booted.app.inject({ method: "POST", url: "/api/auth/api-keys", payload: { name: "ci" }, ...as(session) })).json() as { key: string };
    const viaKey = await booted.app.inject({
      method: "PUT",
      url: `/api/users/${target.id}`,
      payload: { role: "operator" },
      headers: { authorization: `Bearer ${key.key}` }
    });
    expect(viaKey.statusCode).toBe(200);
  });

  it("asks a stale session for a code, accepts it, and then lets the action through", async () => {
    const booted = await boot({ STEP_UP_MAX_AGE_MINUTES: "10" });
    const admin = await register(booted, "root@example.com", "admin");
    const target = await register(booted, "tia@example.com", "viewer");
    const { secret, backupCodes } = await enrolTotp(booted, admin);
    const session = await signIn(booted, "root@example.com", secret);

    // Fresh from the sign-in code step.
    expect((await booted.app.inject({ method: "PUT", url: `/api/users/${target.id}`, payload: { role: "operator" }, ...as(session) })).statusCode).toBe(200);

    await setMfaVerifiedAt(booted, session, new Date(Date.now() - 11 * 60_000).toISOString());
    const stale = await booted.app.inject({ method: "PUT", url: `/api/users/${target.id}`, payload: { role: "builder" }, ...as(session) });
    expect(stale.statusCode).toBe(403);
    expect(stale.json()).toMatchObject({
      code: "step_up_required",
      stepUp: { required: true, action: "user.role_change", method: "totp", enrolled: true, maxAgeMinutes: 10 }
    });
    expect((await booted.store.getUserById(target.id))?.role).toBe("operator");
    // Unguarded routes are unaffected.
    expect((await booted.app.inject({ method: "GET", url: "/api/users", ...as(session) })).statusCode).toBe(200);

    expect((await booted.app.inject({ method: "POST", url: "/api/auth/step-up", payload: { code: backupCodes[1] }, ...as(session) })).statusCode).toBe(200);
    expect((await booted.app.inject({ method: "PUT", url: `/api/users/${target.id}`, payload: { role: "builder" }, ...as(session) })).statusCode).toBe(200);
  });

  it("tells a user without TOTP to set it up first; the step-up route answers 409", async () => {
    const booted = await boot({ STEP_UP_MAX_AGE_MINUTES: "10" });
    await register(booted, "bob@example.com", "builder");
    const session = await signIn(booted, "bob@example.com");
    const refused = await booted.app.inject({ method: "POST", url: "/api/auth/api-keys", payload: { name: "ci" }, ...as(session) });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: "step_up_required", stepUp: { enrolled: false } });
    const stepUp = await booted.app.inject({ method: "POST", url: "/api/auth/step-up", payload: { code: "123456" }, ...as(session) });
    expect(stepUp.statusCode).toBe(409);
  });

  it("D9: a personal API key is refused on guarded actions, but still works elsewhere", async () => {
    const booted = await boot({ STEP_UP_MAX_AGE_MINUTES: "10" });
    const admin = await register(booted, "root@example.com", "admin");
    const target = await register(booted, "tia@example.com", "viewer");
    const { secret } = await enrolTotp(booted, admin);
    const session = await signIn(booted, "root@example.com", secret);
    const created = await booted.app.inject({ method: "POST", url: "/api/auth/api-keys", payload: { name: "ci" }, ...as(session) });
    expect(created.statusCode).toBe(200);
    const bearer = { authorization: `Bearer ${(created.json() as { key: string }).key}` };

    const refused = await booted.app.inject({ method: "PUT", url: `/api/users/${target.id}`, payload: { role: "admin" }, headers: bearer });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: "step_up_required", stepUp: { credential: "api_key" } });
    expect((await booted.app.inject({ method: "GET", url: "/api/users", headers: bearer })).statusCode).toBe(200);
    // The key cannot step up either.
    expect((await booted.app.inject({ method: "POST", url: "/api/auth/step-up", payload: { code: generateTotpCode(secret) }, headers: bearer })).statusCode).toBe(400);
  });

  it("public registration: anyone still registers as a viewer; a signed-in admin granting a role needs step-up", async () => {
    const booted = await boot({ STEP_UP_MAX_AGE_MINUTES: "10", AUTH_ALLOW_PUBLIC_REGISTER: "true" });
    await register(booted, "root@example.com", "admin");
    const anonymous = await booted.app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "anon@example.com", password: "Pass-word-123!" } });
    expect(anonymous.json()).toMatchObject({ user: { role: "viewer" } });
    const session = await signIn(booted, "root@example.com");
    const granted = await booted.app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "bld@example.com", password: "Pass-word-123!", role: "builder" },
      ...as(session)
    });
    expect(granted.statusCode).toBe(403);
    expect(granted.json()).toMatchObject({ code: "step_up_required", stepUp: { action: "user.create" } });
  });

  it("guards every listed action on its route", async () => {
    const booted = await boot({ STEP_UP_MAX_AGE_MINUTES: "10" });
    const admin = await register(booted, "root@example.com", "admin");
    const other = await register(booted, "tia@example.com", "viewer");
    const session = await signIn(booted, "root@example.com");
    const project = (await booted.store.listProjects())[0]!;
    const account = (await booted.store.createServiceAccount({ id: "svc_ci", email: "ci+0@service.invalid", role: "viewer", description: null, createdBy: admin.id }))!;
    const routes: Array<{ method: "POST" | "PUT" | "PATCH" | "DELETE"; url: string; payload?: Record<string, unknown> }> = [
      { method: "POST", url: "/api/auth/register", payload: { email: "n@example.com", password: "Pass-word-123!" } },
      { method: "POST", url: "/api/users/invite", payload: { email: "i@example.com" } },
      { method: "PUT", url: `/api/users/${other.id}`, payload: { role: "operator" } },
      { method: "DELETE", url: `/api/users/${other.id}` },
      { method: "POST", url: `/api/users/${other.id}/mfa/reset` },
      { method: "POST", url: "/api/auth/mfa/disable", payload: {} },
      { method: "POST", url: "/api/auth/api-keys", payload: { name: "ci" } },
      { method: "POST", url: "/api/mcp/clients", payload: {} },
      { method: "POST", url: "/api/secrets", payload: {} },
      { method: "PUT", url: "/api/secrets/sec_x/sensitive-output", payload: { sensitiveOutput: true } },
      { method: "POST", url: "/api/secrets/sec_x/shares", payload: {} },
      { method: "DELETE", url: "/api/secrets/sec_x/shares/proj_x" },
      { method: "DELETE", url: "/api/secrets/sec_x" },
      { method: "POST", url: "/api/auth/sso/mappings", payload: {} },
      { method: "DELETE", url: "/api/auth/sso/mappings/map_x" },
      { method: "POST", url: "/api/notifications", payload: {} },
      { method: "DELETE", url: "/api/notifications/ntf_x" },
      { method: "POST", url: "/api/audit-export/destinations", payload: {} },
      { method: "PUT", url: "/api/audit-export/destinations/dst_x", payload: {} },
      { method: "DELETE", url: "/api/audit-export/destinations/dst_x" },
      { method: "POST", url: "/api/log-streams", payload: {} },
      { method: "PUT", url: "/api/log-streams/ls_x", payload: {} },
      { method: "DELETE", url: "/api/log-streams/ls_x" },
      { method: "POST", url: `/api/projects/${project.id}/members`, payload: { userId: other.id, role: "project_admin" } },
      { method: "DELETE", url: `/api/projects/${project.id}/members/${other.id}` },
      { method: "POST", url: "/api/custom-roles", payload: {} },
      { method: "PUT", url: "/api/custom-roles/role_x", payload: {} },
      { method: "DELETE", url: "/api/custom-roles/role_x" },
      { method: "POST", url: "/api/mcp/servers/import", payload: {} },
      { method: "POST", url: `/api/users/${other.id}/sessions/revoke`, payload: {} },
      { method: "POST", url: `/api/service-accounts/${account.id}/keys`, payload: { name: "ci" } },
      { method: "PATCH", url: `/api/service-accounts/${account.id}`, payload: { role: "operator" } },
      { method: "DELETE", url: `/api/service-accounts/${account.id}` },
      { method: "POST", url: "/api/legal-holds", payload: { name: "Matter", reason: "r", scopeType: "project", scopeId: project.id } },
      { method: "POST", url: "/api/legal-holds/lh_x/release", payload: { reason: "r" } }
    ];
    const seen = new Set<string>();
    for (const route of routes) {
      const response = await booted.app.inject({ method: route.method, url: route.url, ...(route.payload ? { payload: route.payload } : {}), ...as(session) });
      expect({ route: `${route.method} ${route.url}`, status: response.statusCode, code: (response.json() as { code?: string }).code }).toEqual({
        route: `${route.method} ${route.url}`,
        status: 403,
        code: "step_up_required"
      });
      seen.add((response.json() as { stepUp: { action: string } }).stepUp.action);
    }
    expect([...seen].sort()).toEqual(Object.keys(STEP_UP_ACTIONS).sort());
    expect(admin.role).toBe("admin");
  });
});

describe("admin MFA reset", () => {
  it("deletes the user's authenticator, ends their sessions and is audited; their next sign-in sets MFA up again", async () => {
    const booted = await boot({ MFA_REQUIRED_ROLES: "admin" });
    const root = await register(booted, "root@example.com", "admin");
    const ada = await register(booted, "ada@example.com", "admin");
    const rootTotp = await enrolTotp(booted, root);
    const adaTotp = await enrolTotp(booted, ada);
    const rootSession = await signIn(booted, "root@example.com", rootTotp.secret);
    const adaSession = await signIn(booted, "ada@example.com", adaTotp.secret);

    const reset = await booted.app.inject({ method: "POST", url: `/api/users/${ada.id}/mfa/reset`, ...as(rootSession) });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual({ ok: true, userId: ada.id, hadMfa: true, sessionsEnded: 1 });
    expect(await booted.mfa.isEnabled(ada.id)).toBe(false);
    expect(await booted.store.getSession(adaSession)).toMatchObject({ endedReason: "admin" });
    expect((await booted.app.inject({ method: "GET", url: "/api/workflows", ...as(adaSession) })).statusCode).toBe(401);
    const audit = (await booted.store.listAuditLogs({ eventType: "mfa.reset" })).items[0]!;
    expect(audit).toMatchObject({ resourceId: ada.id, outcome: "success" });
    expect(audit.metadata).toMatchObject({ email: "ada@example.com", hadMfa: true, sessionsEnded: 1 });

    const again = await booted.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "ada@example.com", password: "Pass-word-123!" } });
    expect(again.json()).toMatchObject({ mfaEnrollmentRequired: true });
  });

  it("refuses your own account, except from a break-glass session; refuses non-admins", async () => {
    const booted = await boot();
    const root = await register(booted, "root@example.com", "admin");
    await register(booted, "bob@example.com", "builder");
    await enrolTotp(booted, root);
    const bob = await signIn(booted, "bob@example.com");
    expect((await booted.app.inject({ method: "POST", url: `/api/users/${root.id}/mfa/reset`, ...as(bob) })).statusCode).toBe(403);

    const breakGlass = await booted.authService.sessions.issueSession({ user: root, method: "break_glass" });
    const ownBreakGlass = await booted.app.inject({ method: "POST", url: `/api/users/${root.id}/mfa/reset`, ...as(breakGlass.sessionId) });
    expect(ownBreakGlass.statusCode).toBe(200);
    // The break-glass session doing the reset stays signed in.
    expect((await booted.store.getSession(breakGlass.sessionId))?.revokedAt).toBeNull();
    expect(await booted.mfa.isEnabled(root.id)).toBe(false);

    const normal = await signIn(booted, "root@example.com");
    const own = await booted.app.inject({ method: "POST", url: `/api/users/${root.id}/mfa/reset`, ...as(normal) });
    expect(own.statusCode).toBe(400);
    expect((await booted.app.inject({ method: "POST", url: "/api/users/usr_missing/mfa/reset", ...as(normal) })).statusCode).toBe(404);
  });
});

describe("last admin", () => {
  it("refuses to demote the only admin (an unaccepted invite does not count); a second admin makes it possible", async () => {
    const booted = await boot();
    const root = await register(booted, "root@example.com", "admin");
    const session = await signIn(booted, "root@example.com");
    expect(
      (await booted.app.inject({ method: "POST", url: "/api/users/invite", payload: { email: "pending@example.com", role: "admin" }, ...as(session) })).statusCode
    ).toBe(201);
    const refused = await booted.app.inject({ method: "PUT", url: `/api/users/${root.id}`, payload: { role: "builder" }, ...as(session) });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: "last_admin" });

    await register(booted, "second@example.com", "admin");
    expect((await booted.app.inject({ method: "PUT", url: `/api/users/${root.id}`, payload: { role: "builder" }, ...as(session) })).statusCode).toBe(200);
  });
});

describe("no lockout", () => {
  it("a sole admin with every MFA policy on can sign in, set up MFA and reach Settings actions", async () => {
    const booted = await boot({ MFA_REQUIRED_ROLES: "admin,builder,operator,viewer", STEP_UP_MAX_AGE_MINUTES: "1" });
    await register(booted, "root@example.com", "admin");
    const session = await signIn(booted, "root@example.com");
    const enrol = await booted.app.inject({ method: "POST", url: "/api/auth/mfa/enroll", ...as(session) });
    const { secret } = enrol.json() as { secret: string };
    expect(
      (await booted.app.inject({ method: "POST", url: "/api/auth/mfa/activate", payload: { code: generateTotpCode(secret) }, ...as(session) })).statusCode
    ).toBe(200);
    expect((await booted.app.inject({ method: "GET", url: "/api/users", ...as(session) })).statusCode).toBe(200);
    // Activation counts as a fresh MFA check, so a guarded action passes at once.
    expect((await booted.app.inject({ method: "POST", url: "/api/auth/api-keys", payload: { name: "ci" }, ...as(session) })).statusCode).toBe(200);
  });
});

async function ageSession(booted: Booted, sessionId: string, minutes: number) {
  await testSql(booted.store).run(`UPDATE sessions SET created_at = ? WHERE id = ?`, new Date(Date.now() - minutes * 60_000).toISOString(), sessionId);
}

const nextStepCode = (secret: string, steps = 1) => generateTotpCode(secret, Date.now() + steps * 30_000);

describe("wrong-code lockout", () => {
  it("five wrong codes lock step-up and the sign-in code step for that user for 15 minutes; the session that guessed ends", async () => {
    const booted = await boot({ STEP_UP_MAX_AGE_MINUTES: "10" });
    const admin = await register(booted, "root@example.com", "admin");
    const { secret } = await enrolTotp(booted, admin);
    const session = await signIn(booted, "root@example.com", secret);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const wrong = await booted.app.inject({ method: "POST", url: "/api/auth/step-up", payload: { code: "000000" }, ...as(session) });
      expect(wrong.json()).toMatchObject({ code: "mfa_code_invalid" });
    }
    const fifth = await booted.app.inject({ method: "POST", url: "/api/auth/step-up", payload: { code: "000000" }, ...as(session) });
    expect(fifth.statusCode).toBe(429);
    expect(fifth.json()).toMatchObject({ code: "mfa_locked", lockedUntil: expect.any(String) });
    expect(Number(fifth.headers["retry-after"])).toBeGreaterThan(800);
    expect(await booted.store.getSession(session)).toMatchObject({ endedReason: "policy" });
    const locked = (await booted.store.listAuditLogs({ eventType: "mfa.locked" })).items;
    expect(locked).toHaveLength(1);
    expect(locked[0]).toMatchObject({ resourceId: admin.id, metadata: { via: "step_up", failures: 5, minutes: 15 } });

    // The right code does not help while locked: not on the sign-in code step, not on step-up.
    const login = await booted.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "root@example.com", password: "Pass-word-123!" } });
    const { mfaChallenge } = login.json() as { mfaChallenge: string };
    const blocked = await booted.app.inject({ method: "POST", url: "/api/auth/login/mfa", payload: { challenge: mfaChallenge, code: nextStepCode(secret) } });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ code: "mfa_locked" });

    // Once the failures are older than the window, the code works again.
    await testSql(booted.store).run(
      `UPDATE audit_logs SET created_at = ? WHERE event_type = 'mfa.code_failed'`,
      new Date(Date.now() - 16 * 60_000).toISOString()
    );
    const again = await booted.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "root@example.com", password: "Pass-word-123!" } });
    const unlocked = await booted.app.inject({
      method: "POST",
      url: "/api/auth/login/mfa",
      payload: { challenge: (again.json() as { mfaChallenge: string }).mfaChallenge, code: nextStepCode(secret) }
    });
    expect(unlocked.statusCode).toBe(200);
  });

  it("wrong sign-in codes count too, per user and across challenges", async () => {
    const booted = await boot();
    const admin = await register(booted, "root@example.com", "admin");
    const { secret } = await enrolTotp(booted, admin);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const login = await booted.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "root@example.com", password: "Pass-word-123!" } });
      const { mfaChallenge } = login.json() as { mfaChallenge: string };
      const wrong = await booted.app.inject({ method: "POST", url: "/api/auth/login/mfa", payload: { challenge: mfaChallenge, code: "000000" } });
      expect(wrong.statusCode).toBe(401);
    }
    const login = await booted.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "root@example.com", password: "Pass-word-123!" } });
    const { mfaChallenge } = login.json() as { mfaChallenge: string };
    const blocked = await booted.app.inject({ method: "POST", url: "/api/auth/login/mfa", payload: { challenge: mfaChallenge, code: generateTotpCode(secret) } });
    expect(blocked.statusCode).toBe(429);
    expect((await booted.store.listAuditLogs({ eventType: "mfa.locked" })).items[0]).toMatchObject({ metadata: { via: "sign_in" } });
  });
});

describe("a TOTP code is accepted once", () => {
  it("the code used to sign in cannot be used again for step-up; the next one can", async () => {
    const booted = await boot({ STEP_UP_MAX_AGE_MINUTES: "10" });
    const admin = await register(booted, "root@example.com", "admin");
    const { secret } = await enrolTotp(booted, admin);
    const code = generateTotpCode(secret);
    const login = await booted.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "root@example.com", password: "Pass-word-123!" } });
    const done = await booted.app.inject({ method: "POST", url: "/api/auth/login/mfa", payload: { challenge: (login.json() as { mfaChallenge: string }).mfaChallenge, code } });
    const session = sessionCookie(done.headers["set-cookie"])!;
    const replay = await booted.app.inject({ method: "POST", url: "/api/auth/step-up", payload: { code }, ...as(session) });
    expect(replay.json()).toMatchObject({ code: "mfa_code_invalid" });
    expect((await booted.app.inject({ method: "POST", url: "/api/auth/step-up", payload: { code: nextStepCode(secret) }, ...as(session) })).statusCode).toBe(200);
  });
});

describe("setting up an authenticator", () => {
  it("needs a sign-in within 10 minutes, or the password again", async () => {
    const booted = await boot({ STEP_UP_MAX_AGE_MINUTES: "10" });
    await register(booted, "root@example.com", "admin");
    const fresh = await signIn(booted, "root@example.com");
    expect((await booted.app.inject({ method: "POST", url: "/api/auth/mfa/enroll", ...as(fresh) })).statusCode).toBe(200);
    await booted.mfa.disable((await booted.store.getUserByEmail("root@example.com"))!.id);

    // A stolen, older cookie cannot bind the attacker's authenticator (and so cannot pass step-up).
    const old = await signIn(booted, "root@example.com");
    await ageSession(booted, old, 11);
    const refused = await booted.app.inject({ method: "POST", url: "/api/auth/mfa/enroll", ...as(old) });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: "mfa_reauth_required", sso: false });
    const wrong = await booted.app.inject({ method: "POST", url: "/api/auth/mfa/enroll", payload: { password: "nope" }, ...as(old) });
    expect(wrong.json()).toMatchObject({ code: "mfa_reauth_required" });
    const ok = await booted.app.inject({ method: "POST", url: "/api/auth/mfa/enroll", payload: { password: "Pass-word-123!" }, ...as(old) });
    expect(ok.statusCode).toBe(200);
    const failures = (await booted.store.listAuditLogs({ eventType: "mfa.enroll", outcome: "failure" })).items.map((entry) => entry.metadata);
    expect(failures).toEqual(expect.arrayContaining([{ reason: "reauth_required" }, { reason: "password_invalid" }]));
  });

  it("an SSO session past the window is told to sign in again through its identity provider", async () => {
    const booted = await boot();
    const user = await register(booted, "sso@example.com", "builder");
    const issued = await booted.authService.sessions.issueSession({ user, method: "oidc" });
    await ageSession(booted, issued.sessionId, 30);
    const refused = await booted.app.inject({ method: "POST", url: "/api/auth/mfa/enroll", ...as(issued.sessionId) });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: "mfa_reauth_required", sso: true });
  });
});

describe("personal API keys of roles that require MFA", () => {
  it("work only while the owner has MFA set up, and creating one needs a recent MFA check even with step-up off", async () => {
    const booted = await boot({ MFA_REQUIRED_ROLES: "builder" });
    const builder = await register(booted, "bea@example.com", "builder");
    const { secret } = await enrolTotp(booted, builder);
    const session = await signIn(booted, "bea@example.com", secret);
    const created = await booted.app.inject({ method: "POST", url: "/api/auth/api-keys", payload: { name: "ci" }, ...as(session) });
    expect(created.statusCode).toBe(200);
    const bearer = { authorization: `Bearer ${(created.json() as { key: string }).key}` };
    expect((await booted.app.inject({ method: "GET", url: "/api/workflows", headers: bearer })).statusCode).toBe(200);

    await setMfaVerifiedAt(booted, session, new Date(Date.now() - 20 * 60_000).toISOString());
    const stale = await booted.app.inject({ method: "POST", url: "/api/auth/api-keys", payload: { name: "ci2" }, ...as(session) });
    expect(stale.statusCode).toBe(403);
    expect(stale.json()).toMatchObject({ code: "step_up_required", stepUp: { action: "api_key.create", maxAgeMinutes: 15 } });

    await booted.store.deleteMfaSecret(builder.id);
    const refused = await booted.app.inject({ method: "GET", url: "/api/workflows", headers: bearer });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: "mfa_enrollment_required" });
  });

  it("a key capped below a listed owner still needs that owner's recent MFA check to create keys", async () => {
    const booted = await boot({ MFA_REQUIRED_ROLES: "admin" });
    const admin = await register(booted, "root@example.com", "admin");
    const { secret } = await enrolTotp(booted, admin);
    const session = await signIn(booted, "root@example.com", secret);
    const capped = await booted.app.inject({ method: "POST", url: "/api/auth/api-keys", payload: { name: "ci", role: "builder" }, ...as(session) });
    expect(capped.statusCode).toBe(200);
    const bearer = { authorization: `Bearer ${(capped.json() as { key: string }).key}` };
    // The owner (admin) is listed, so creating a key needs an MFA check, which a key cannot give.
    const refused = await booted.app.inject({ method: "POST", url: "/api/auth/api-keys", payload: { name: "child" }, headers: bearer });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: "step_up_required", stepUp: { action: "api_key.create", credential: "api_key" } });
  });

  it("other roles' keys are untouched", async () => {
    const booted = await boot({ MFA_REQUIRED_ROLES: "admin" });
    await register(booted, "bob@example.com", "builder");
    const session = await signIn(booted, "bob@example.com");
    const created = await booted.app.inject({ method: "POST", url: "/api/auth/api-keys", payload: { name: "ci" }, ...as(session) });
    expect(created.statusCode).toBe(200);
    const bearer = { authorization: `Bearer ${(created.json() as { key: string }).key}` };
    expect((await booted.app.inject({ method: "GET", url: "/api/workflows", headers: bearer })).statusCode).toBe(200);
  });
});

describe("turning MFA off", () => {
  it("a role that requires MFA cannot (409), except from a break-glass session", async () => {
    const booted = await boot({ MFA_REQUIRED_ROLES: "admin" });
    const admin = await register(booted, "root@example.com", "admin");
    const { secret } = await enrolTotp(booted, admin);
    const session = await signIn(booted, "root@example.com", secret);
    const refused = await booted.app.inject({ method: "POST", url: "/api/auth/mfa/disable", payload: { code: nextStepCode(secret) }, ...as(session) });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: "mfa_required_for_role" });
    expect(await booted.mfa.isEnabled(admin.id)).toBe(true);

    const breakGlass = await booted.authService.sessions.issueSession({ user: admin, method: "break_glass" });
    const allowed = await booted.app.inject({ method: "POST", url: "/api/auth/mfa/disable", payload: { code: nextStepCode(secret) }, ...as(breakGlass.sessionId) });
    expect(allowed.statusCode).toBe(200);
    expect(await booted.mfa.isEnabled(admin.id)).toBe(false);
  });

  it("drops the current session's MFA check at once and ends the user's other sessions", async () => {
    const booted = await boot({ STEP_UP_MAX_AGE_MINUTES: "10" });
    const builder = await register(booted, "bob@example.com", "builder");
    const { secret } = await enrolTotp(booted, builder);
    const current = await signIn(booted, "bob@example.com", secret);
    const other = await booted.authService.sessions.issueSession({ user: builder, method: "password" });
    const off = await booted.app.inject({ method: "POST", url: "/api/auth/mfa/disable", payload: { code: nextStepCode(secret) }, ...as(current) });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({ ok: true, sessionsEnded: 1 });
    expect((await booted.store.getSession(current))?.mfaVerifiedAt).toBeNull();
    expect(await booted.store.getSession(other.sessionId)).toMatchObject({ endedReason: "policy" });
    const keyCreate = await booted.app.inject({ method: "POST", url: "/api/auth/api-keys", payload: { name: "ci" }, ...as(current) });
    expect(keyCreate.json()).toMatchObject({ code: "step_up_required" });
  });
});

describe("fix-round odds and ends", () => {
  it("demoting an invited admin who never accepted works while one active admin remains", async () => {
    const booted = await boot();
    const root = await register(booted, "root@example.com", "admin");
    const now = new Date();
    await booted.store.createUserInvite({
      inviteId: "inv_1",
      userId: "usr_invited",
      email: "pending@example.com",
      role: "admin",
      tokenHash: "hash-inv_1",
      createdBy: root.id,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString()
    });
    const session = await signIn(booted, "root@example.com");
    const demoted = await booted.app.inject({ method: "PUT", url: "/api/users/usr_invited", payload: { role: "viewer" }, ...as(session) });
    expect(demoted.statusCode).toBe(200);
    const self = await booted.app.inject({ method: "PUT", url: `/api/users/${root.id}`, payload: { role: "viewer" }, ...as(session) });
    expect(self.json()).toMatchObject({ code: "last_admin" });
  });

  it("LDAP: nothing about the account changes until the code step passes", async () => {
    const booted = await boot({ LDAP_ENABLED: "true" });
    const admin = await register(booted, "lia@example.com", "admin");
    const { secret } = await enrolTotp(booted, admin);
    const dn = "uid=lia,dc=example,dc=test";
    vi.spyOn(LdapService.prototype, "authenticate").mockResolvedValue({ dn, email: "lia@example.com", groups: [], attributes: {} });
    const first = await booted.app.inject({ method: "POST", url: "/api/auth/ldap/login", payload: { email: "lia@example.com", password: "x" } });
    const wrong = await booted.app.inject({ method: "POST", url: "/api/auth/login/mfa", payload: { challenge: (first.json() as { mfaChallenge: string }).mfaChallenge, code: "000000" } });
    expect(wrong.statusCode).toBe(401);
    expect(await booted.store.findSsoIdentity("ldap", dn)).toBeNull();
    const second = await booted.app.inject({ method: "POST", url: "/api/auth/ldap/login", payload: { email: "lia@example.com", password: "x" } });
    const done = await booted.app.inject({ method: "POST", url: "/api/auth/login/mfa", payload: { challenge: (second.json() as { mfaChallenge: string }).mfaChallenge, code: generateTotpCode(secret) } });
    expect(done.statusCode).toBe(200);
    expect(await booted.store.findSsoIdentity("ldap", dn)).toMatchObject({ userId: admin.id });
  });

  it("public registration ignores an API key: only a browser session can act as the registering admin", async () => {
    const booted = await boot({ AUTH_ALLOW_PUBLIC_REGISTER: "true" });
    await register(booted, "root@example.com", "admin");
    const session = await signIn(booted, "root@example.com");
    const key = (await booted.app.inject({ method: "POST", url: "/api/auth/api-keys", payload: { name: "ci" }, ...as(session) })).json() as { key: string };
    const viaKey = await booted.app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "k@example.com", password: "Pass-word-123!", role: "builder" },
      headers: { authorization: `Bearer ${key.key}` }
    });
    expect(viaKey.json()).toMatchObject({ user: { role: "viewer" } });
  });
});

describe("with service accounts and signed-in sessions", () => {
  /** An admin with TOTP, signed in through the code step (a fresh MFA check), and an admin service account. */
  async function adminWithServiceAccount(booted: Booted) {
    const admin = await register(booted, "root@example.com", "admin");
    const { secret } = await enrolTotp(booted, admin);
    const session = await signIn(booted, "root@example.com", secret);
    const account = (await booted.store.createServiceAccount({ id: "svc_deploy", email: "deploy+0@service.invalid", role: "admin", description: null, createdBy: admin.id }))!;
    const mintKey = async (body: Record<string, unknown>) => {
      const created = await booted.app.inject({ method: "POST", url: `/api/service-accounts/${account.id}/keys`, payload: { name: "ci", ...body }, ...as(session) });
      expect(created.statusCode).toBe(201);
      return { authorization: `Bearer ${(created.json() as { key: string }).key}` };
    };
    return { admin, session, account, mintKey };
  }

  it("D9: a service account's role:admin key passes step-up actions; its other keys and personal keys do not", async () => {
    const booted = await boot({ STEP_UP_MAX_AGE_MINUTES: "10" });
    const { session, account, mintKey } = await adminWithServiceAccount(booted);
    // The target is another service account: actions on a person's account need a person (tested below).
    const target = (await booted.store.createServiceAccount({ id: "svc_other", email: "other+0@service.invalid", role: "viewer", description: null, createdBy: null }))!;
    const adminCeiling = await mintKey({ role: "admin" });
    const noCeiling = await mintKey({});

    const passed = await booted.app.inject({ method: "PUT", url: `/api/users/${target.id}`, payload: { role: "operator" }, headers: adminCeiling });
    expect(passed.statusCode).toBe(200);
    const refused = await booted.app.inject({ method: "PUT", url: `/api/users/${target.id}`, payload: { role: "builder" }, headers: noCeiling });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: "step_up_required", stepUp: { credential: "api_key" } });

    // Demoting the account lowers its keys: the role:admin key no longer acts as admin, so it is refused.
    const demoted = await booted.app.inject({ method: "PATCH", url: `/api/service-accounts/${account.id}`, payload: { role: "builder" }, ...as(session) });
    expect(demoted.statusCode).toBe(200);
    expect((await booted.app.inject({ method: "PUT", url: `/api/users/${target.id}`, payload: { role: "viewer" }, headers: adminCeiling })).statusCode).toBe(403);
  });

  it("MFA_REQUIRED_ROLES: a service account's keys are not personal keys; a person's capped key still needs the owner's MFA", async () => {
    const booted = await boot({ MFA_REQUIRED_ROLES: "admin" });
    const { admin, session, mintKey } = await adminWithServiceAccount(booted);
    const serviceKey = await mintKey({ role: "admin" });
    expect((await booted.app.inject({ method: "GET", url: "/api/users", headers: serviceKey })).statusCode).toBe(200);

    // A personal key capped at viewer: the owner's own role (admin) decides, not the key's ceiling.
    const personal = await booted.app.inject({ method: "POST", url: "/api/auth/api-keys", payload: { name: "dash", role: "viewer" }, ...as(session) });
    expect(personal.statusCode).toBe(200);
    const viewerKey = { authorization: `Bearer ${(personal.json() as { key: string }).key}` };
    expect((await booted.app.inject({ method: "GET", url: "/api/workflows", headers: viewerKey })).statusCode).toBe(200);
    await booted.store.deleteMfaSecret(admin.id);
    const refused = await booted.app.inject({ method: "GET", url: "/api/workflows", headers: viewerKey });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: "mfa_enrollment_required" });
    expect((await booted.app.inject({ method: "GET", url: "/api/users", headers: serviceKey })).statusCode).toBe(200);
  });

  it("M2: with step-up on, a service account's admin key is refused on actions that target a person; a person's session passes", async () => {
    const booted = await boot({ STEP_UP_MAX_AGE_MINUTES: "10" });
    const { session, mintKey } = await adminWithServiceAccount(booted);
    const tia = await register(booted, "tia@example.com", "builder");
    await register(booted, "ops@example.com", "admin");
    const key = await mintKey({ role: "admin" });
    const personRoutes: Array<{ method: "POST" | "PUT" | "DELETE"; url: string; payload?: Record<string, unknown>; action: string }> = [
      { method: "PUT", url: `/api/users/${tia.id}`, payload: { role: "operator" }, action: "user.role_change" },
      { method: "POST", url: `/api/users/${tia.id}/mfa/reset`, action: "user.mfa_reset" },
      { method: "POST", url: `/api/users/${tia.id}/sessions/revoke`, payload: {}, action: "user.sessions_revoke" },
      { method: "DELETE", url: `/api/users/${tia.id}`, action: "user.delete" }
    ];
    for (const route of personRoutes) {
      const response = await booted.app.inject({ method: route.method, url: route.url, ...(route.payload ? { payload: route.payload } : {}), headers: key });
      expect({ route: route.url, status: response.statusCode }).toEqual({ route: route.url, status: 403 });
      expect(response.json()).toMatchObject({ code: "step_up_required", stepUp: { action: route.action, credential: "api_key", target: "person" } });
    }
    expect(await booted.store.getUserById(tia.id)).toMatchObject({ role: "builder" });
    // Automation on non-person actions still works with the key.
    expect((await booted.app.inject({ method: "POST", url: "/api/notifications", payload: {}, headers: key })).json()).not.toMatchObject({ code: "step_up_required" });
    // The admin's fresh session does the same actions.
    expect((await booted.app.inject({ method: "PUT", url: `/api/users/${tia.id}`, payload: { role: "operator" }, ...as(session) })).statusCode).toBe(200);
    expect((await booted.app.inject({ method: "DELETE", url: `/api/users/${tia.id}`, ...as(session) })).statusCode).toBe(200);
  });

  it("M2 is a step-up rule: with step-up off, keys behave as before on those routes", async () => {
    const booted = await boot();
    const { mintKey } = await adminWithServiceAccount(booted);
    const tia = await register(booted, "tia@example.com", "builder");
    const key = await mintKey({ role: "admin" });
    expect((await booted.app.inject({ method: "PUT", url: `/api/users/${tia.id}`, payload: { role: "operator" }, headers: key })).statusCode).toBe(200);
  });

  it("H1: no one, an admin service-account key included, deletes the last person who is an admin", async () => {
    for (const stepUp of ["0", "10"]) {
      const booted = await boot({ STEP_UP_MAX_AGE_MINUTES: stepUp });
      const { admin, session, mintKey } = await adminWithServiceAccount(booted);
      const key = await mintKey({});
      const second = await register(booted, "ops@example.com", "admin");
      if (stepUp === "0") {
        // Step-up off: the key passes requireRole(["admin"]); it may delete one of two admins, never the last one.
        expect((await booted.app.inject({ method: "DELETE", url: `/api/users/${second.id}`, headers: key })).statusCode).toBe(200);
        const last = await booted.app.inject({ method: "DELETE", url: `/api/users/${admin.id}`, headers: key });
        expect(last.statusCode).toBe(409);
        expect(last.json()).toMatchObject({ code: "last_admin" });
      } else {
        // Step-up on: the key is refused before that (an action on a person), and the admin's session meets the 409.
        expect((await booted.app.inject({ method: "DELETE", url: `/api/users/${admin.id}`, headers: key })).statusCode).toBe(403);
        expect((await booted.app.inject({ method: "DELETE", url: `/api/users/${second.id}`, ...as(session) })).statusCode).toBe(200);
      }
      expect(await booted.store.getUserById(admin.id)).toMatchObject({ role: "admin", kind: "human" });
      // A service account is not protected by the rule: the admin's session deletes it.
      expect((await booted.app.inject({ method: "DELETE", url: "/api/users/svc_deploy", ...as(session) })).statusCode).toBe(200);
      // Break-glass always has an admin to mint for.
      expect((await booted.store.listUsers({ kind: "human" })).filter((u) => u.role === "admin").map((u) => u.id)).toEqual([admin.id]);
    }
  });

  it("an admin service account does not count as the last admin", async () => {
    const booted = await boot();
    const { admin, session } = await adminWithServiceAccount(booted);
    const demote = await booted.app.inject({ method: "PUT", url: `/api/users/${admin.id}`, payload: { role: "builder" }, ...as(session) });
    expect(demote.statusCode).toBe(409);
    expect(demote.json()).toMatchObject({ code: "last_admin" });
  });

  it("signing another user out needs step-up; ending your own other sessions does not", async () => {
    const booted = await boot({ STEP_UP_MAX_AGE_MINUTES: "10" });
    const admin = await register(booted, "root@example.com", "admin");
    const tia = await register(booted, "tia@example.com", "viewer");
    // Two browsers signed in before TOTP was set up: neither session carries an MFA check.
    const session = await signIn(booted, "root@example.com");
    const otherDevice = await signIn(booted, "root@example.com");
    await signIn(booted, "tia@example.com");
    await enrolTotp(booted, admin);

    const other = await booted.app.inject({ method: "POST", url: `/api/users/${tia.id}/sessions/revoke`, payload: {}, ...as(session) });
    expect(other.statusCode).toBe(403);
    expect(other.json()).toMatchObject({ code: "step_up_required", stepUp: { action: "user.sessions_revoke" } });
    expect((await booted.store.listUserSessions(tia.id, { liveOnly: true, now: new Date().toISOString() })).length).toBe(1);

    const own = await booted.app.inject({ method: "POST", url: `/api/users/${admin.id}/sessions/revoke`, payload: {}, ...as(session) });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toEqual({ revoked: 1 });
    expect((await booted.store.getSession(otherDevice))?.revokedAt).toBeTruthy();
  });
});
