import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config";
import { createApp } from "./app";
import { SqliteStore } from "./db/database";
import { AuthService } from "./services/auth-service";
import { SecretService } from "./services/secret-service";
import { generateTotpCode } from "./services/mfa-service";

interface TestContext {
  app: FastifyInstance;
  store: SqliteStore;
  authService: AuthService;
  secretService: SecretService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    API_PORT: 0,
    API_HOST: "127.0.0.1",
    WEB_ORIGIN: "http://localhost:5173",
    WORKFLOW_EXECUTION_TIMEOUT_MS: 300000,
    EXECUTION_HISTORY_RETENTION_DAYS: 30,
    EXECUTION_HISTORY_PRUNE_INTERVAL_MS: 3600000,
    SEED_SAMPLE_WORKFLOWS: false,
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    SESSION_COOKIE_NAME: "ao_session",
    SESSION_TTL_HOURS: 24,
    COOKIE_SECURE: false,
    AUTH_ALLOW_PUBLIC_REGISTER: false,
    BOOTSTRAP_ADMIN_EMAIL: undefined,
    BOOTSTRAP_ADMIN_PASSWORD: undefined,
    OPENAI_API_KEY: undefined,
    GEMINI_API_KEY: undefined,
    OLLAMA_BASE_URL: undefined,
    API_KEY_DEFAULT_EXPIRY_DAYS: 0,
    MFA_ENABLED: true,
    MFA_ENFORCE: false,
    MFA_ISSUER: "ai-orchestrator-test",
    SAML_ENABLED: false,
    SAML_ENTRY_POINT: undefined,
    SAML_ISSUER: undefined,
    SAML_CALLBACK_URL: undefined,
    SAML_IDP_CERT: undefined,
    SAML_GROUPS_ATTRIBUTE: "groups",
    LDAP_ENABLED: false,
    LDAP_URL: undefined,
    LDAP_BIND_DN: undefined,
    LDAP_BIND_PASSWORD: undefined,
    LDAP_BASE_DN: undefined,
    LDAP_USER_FILTER: "(mail={{email}})",
    LDAP_GROUPS_ATTRIBUTE: "memberOf",
    EXTERNAL_SECRETS_CACHE_TTL_MS: 300000,
    AUDIT_LOG_ENABLED: true,
    AUDIT_LOG_RETENTION_DAYS: 365,
    AUDIT_LOG_PRUNE_INTERVAL_MS: 3600000,
    LOG_STREAM_ENABLED: true,
    LOG_STREAM_FLUSH_INTERVAL_MS: 2000,
    LOG_STREAM_BUFFER_SIZE: 1000,
    LOG_STREAM_RETRY_MAX_ATTEMPTS: 3,
    LOG_STREAM_EVENT_RETENTION_DAYS: 14,
    LOG_STREAM_EVENT_PRUNE_INTERVAL_MS: 3600000,
    ...overrides
  };
}

async function createTestContext(overrides: Partial<AppConfig> = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-phase5-"));
  const dbPath = path.join(tempDir, "orchestrator.db");
  const store = await SqliteStore.create(dbPath);
  const config = makeConfig(overrides);
  store.ensureDefaultProject();
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = createApp(config, store, secretService, authService);
  await app.ready();
  const ctx: TestContext = { app, store, authService, secretService, config, tempDir };
  contexts.push(ctx);
  return ctx;
}

function extractCookie(header: string | string[] | undefined, name: string): string {
  const values = Array.isArray(header) ? header : [header ?? ""];
  const cookie = values.find((value) => value.startsWith(`${name}=`));
  if (!cookie) throw new Error(`Cookie '${name}' was not set`);
  const first = cookie.split(";")[0];
  if (!first) throw new Error(`Cookie '${name}' malformed`);
  return first;
}

async function loginUser(
  ctx: TestContext,
  input: { email: string; password: string; role: "admin" | "builder" | "operator" | "viewer" }
): Promise<{ cookie: string; userId: string }> {
  const registered = ctx.authService.register(input);
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: input.email, password: input.password }
  });
  if (response.statusCode !== 200) {
    throw new Error(`login failed: ${response.body}`);
  }
  const cookie = extractCookie(response.headers["set-cookie"], ctx.config.SESSION_COOKIE_NAME);
  return { cookie, userId: registered.id };
}

afterEach(async () => {
  while (contexts.length > 0) {
    const ctx = contexts.pop();
    if (!ctx) continue;
    await ctx.app.close();
    fs.rmSync(ctx.tempDir, { recursive: true, force: true });
  }
});

describe("Phase 5.1 — API keys", () => {
  it("issues a bearer API key that authenticates subsequent requests", async () => {
    const ctx = await createTestContext();
    const { cookie } = await loginUser(ctx, {
      email: "builder@example.com",
      password: "builder-password",
      role: "builder"
    });

    const createResponse = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/api-keys",
      headers: { cookie },
      payload: { name: "ci-key", scopes: ["workflow:read"] }
    });
    expect(createResponse.statusCode).toBe(200);
    const created = createResponse.json() as { key: string; record: { id: string; keyPrefix: string } };
    expect(created.key).toMatch(/^ao_[^.]+\.[^.]+$/);

    const viaApiKey = await ctx.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${created.key}` }
    });
    expect(viaApiKey.statusCode).toBe(200);
    const me = viaApiKey.json() as { user: { email: string } };
    expect(me.user.email).toBe("builder@example.com");

    const listResponse = await ctx.app.inject({
      method: "GET",
      url: "/api/auth/api-keys",
      headers: { cookie }
    });
    expect(listResponse.statusCode).toBe(200);
    const { keys } = listResponse.json() as { keys: Array<{ id: string; keyPrefix: string }> };
    expect(keys.length).toBe(1);

    const revoke = await ctx.app.inject({
      method: "DELETE",
      url: `/api/auth/api-keys/${created.record.id}`,
      headers: { cookie }
    });
    expect(revoke.statusCode).toBe(200);

    const afterRevoke = await ctx.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${created.key}` }
    });
    expect(afterRevoke.statusCode).toBe(401);
  });

  it("rejects expired API keys", async () => {
    const ctx = await createTestContext();
    const { userId } = await loginUser(ctx, {
      email: "expired@example.com",
      password: "expired-password",
      role: "admin"
    });
    const { ApiKeyService } = await import("./services/api-key-service");
    const apiKeyService = new ApiKeyService(ctx.store, 0);
    const { plaintext, record } = apiKeyService.create({ userId, name: "tmp" });

    // Poke the store to set the key as already expired.
    const past = new Date(Date.now() - 60_000).toISOString();
    ctx.store["db"].run(`UPDATE api_keys SET expires_at = ? WHERE id = ?`, [past, record.id]);

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${plaintext}` }
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("Phase 5.1 — MFA (TOTP)", () => {
  it("enrols, activates, and gates login behind MFA", async () => {
    const ctx = await createTestContext();
    const { cookie } = await loginUser(ctx, {
      email: "mfa@example.com",
      password: "mfa-password",
      role: "admin"
    });

    const enroll = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/mfa/enroll",
      headers: { cookie }
    });
    expect(enroll.statusCode).toBe(200);
    const { secret, backupCodes } = enroll.json() as { secret: string; backupCodes: string[] };
    expect(backupCodes.length).toBeGreaterThan(0);

    const activate = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/mfa/activate",
      headers: { cookie },
      payload: { code: generateTotpCode(secret) }
    });
    expect(activate.statusCode).toBe(200);

    // Subsequent login now returns an MFA challenge instead of a session.
    const loginAgain = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "mfa@example.com", password: "mfa-password" }
    });
    expect(loginAgain.statusCode).toBe(200);
    const challenge = loginAgain.json() as { mfaChallenge?: string };
    expect(challenge.mfaChallenge).toBeDefined();

    const complete = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/login/mfa",
      payload: { challenge: challenge.mfaChallenge, code: generateTotpCode(secret) }
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.headers["set-cookie"]).toBeDefined();

    // Backup codes also work and are single-use.
    const loginBackup = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "mfa@example.com", password: "mfa-password" }
    });
    const backupChallenge = loginBackup.json() as { mfaChallenge?: string };
    const useBackup = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/login/mfa",
      payload: { challenge: backupChallenge.mfaChallenge, code: backupCodes[0] }
    });
    expect(useBackup.statusCode).toBe(200);

    // The same backup code cannot be reused.
    const loginBackup2 = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "mfa@example.com", password: "mfa-password" }
    });
    const backupChallenge2 = loginBackup2.json() as { mfaChallenge?: string };
    const reuse = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/login/mfa",
      payload: { challenge: backupChallenge2.mfaChallenge, code: backupCodes[0] }
    });
    expect(reuse.statusCode).toBe(401);
  });
});

describe("Phase 5.1 — SAML + LDAP", () => {
  it("returns 503 when SAML is disabled", async () => {
    const ctx = await createTestContext({ SAML_ENABLED: false });
    const response = await ctx.app.inject({ method: "GET", url: "/api/auth/saml/login" });
    expect(response.statusCode).toBe(503);
  });

  it("returns 503 when LDAP is disabled", async () => {
    const ctx = await createTestContext({ LDAP_ENABLED: false });
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/ldap/login",
      payload: { email: "user@example.com", password: "pw" }
    });
    expect(response.statusCode).toBe(503);
  });
});

describe("Phase 5.1 — SSO group mappings", () => {
  it("allows admins to create and list group-to-role mappings", async () => {
    const ctx = await createTestContext();
    const { cookie } = await loginUser(ctx, {
      email: "admin@example.com",
      password: "admin-password",
      role: "admin"
    });

    const create = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/sso/mappings",
      headers: { cookie },
      payload: { provider: "saml", groupName: "engineering", role: "builder" }
    });
    expect(create.statusCode).toBe(200);

    const list = await ctx.app.inject({
      method: "GET",
      url: "/api/auth/sso/mappings?provider=saml",
      headers: { cookie }
    });
    expect(list.statusCode).toBe(200);
    const { mappings } = list.json() as { mappings: Array<{ groupName: string; role: string }> };
    expect(mappings.find((m) => m.groupName === "engineering" && m.role === "builder")).toBeDefined();
  });

  it("rejects non-admin callers", async () => {
    const ctx = await createTestContext();
    const { cookie } = await loginUser(ctx, {
      email: "builder@example.com",
      password: "builder-password",
      role: "builder"
    });
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/sso/mappings",
      headers: { cookie },
      payload: { provider: "saml", groupName: "engineering", role: "builder" }
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("Phase 5.2 — Project memberships and custom roles", () => {
  it("adds and removes project members with built-in roles", async () => {
    const ctx = await createTestContext();
    const admin = await loginUser(ctx, {
      email: "admin@example.com",
      password: "admin-password",
      role: "admin"
    });
    const viewer = await loginUser(ctx, {
      email: "viewer@example.com",
      password: "viewer-password",
      role: "viewer"
    });

    const create = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: admin.cookie },
      payload: { name: "Team Alpha" }
    });
    expect(create.statusCode).toBe(200);
    const project = create.json() as { id: string };

    const addMember = await ctx.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/members`,
      headers: { cookie: admin.cookie },
      payload: { userId: viewer.userId, role: "editor" }
    });
    expect(addMember.statusCode).toBe(200);

    const members = await ctx.app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/members`,
      headers: { cookie: admin.cookie }
    });
    expect(members.statusCode).toBe(200);
    const payload = members.json() as {
      members: Array<{ userId: string; role: string; permissions: string[] }>;
    };
    expect(payload.members.length).toBe(1);
    expect(payload.members[0].role).toBe("editor");
    expect(payload.members[0].permissions).toContain("workflow:write");

    const remove = await ctx.app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}/members/${viewer.userId}`,
      headers: { cookie: admin.cookie }
    });
    expect(remove.statusCode).toBe(200);
  });

  it("creates a custom role with granular permissions and assigns it", async () => {
    const ctx = await createTestContext();
    const admin = await loginUser(ctx, {
      email: "admin@example.com",
      password: "admin-password",
      role: "admin"
    });
    const worker = await loginUser(ctx, {
      email: "worker@example.com",
      password: "worker-password",
      role: "viewer"
    });

    const proj = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: admin.cookie },
      payload: { name: "Ops" }
    });
    const project = proj.json() as { id: string };

    const roleResponse = await ctx.app.inject({
      method: "POST",
      url: "/api/custom-roles",
      headers: { cookie: admin.cookie },
      payload: {
        name: "Runner",
        projectId: project.id,
        permissions: ["workflow:read", "workflow:execute"]
      }
    });
    expect(roleResponse.statusCode).toBe(200);
    const role = roleResponse.json() as { id: string };

    const assign = await ctx.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/members`,
      headers: { cookie: admin.cookie },
      payload: { userId: worker.userId, role: "custom", customRoleId: role.id }
    });
    expect(assign.statusCode).toBe(200);
    const membership = assign.json() as { membership: { permissions: string[] } };
    expect(membership.membership.permissions).toEqual(
      expect.arrayContaining(["workflow:read", "workflow:execute"])
    );
    expect(membership.membership.permissions).not.toContain("workflow:delete");
  });
});

describe("Phase 5.2 — Workflow and secret sharing", () => {
  it("shares a workflow to another project and enforces owner write-only sharing", async () => {
    const ctx = await createTestContext();
    const admin = await loginUser(ctx, {
      email: "admin@example.com",
      password: "admin-password",
      role: "admin"
    });

    // Create two projects.
    const projA = (await ctx.app
      .inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie: admin.cookie },
        payload: { name: "A" }
      })
      .then((r) => r.json())) as { id: string };
    const projB = (await ctx.app
      .inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie: admin.cookie },
        payload: { name: "B" }
      })
      .then((r) => r.json())) as { id: string };

    // Create a workflow in project A via the store directly.
    ctx.store.upsertWorkflow({
      id: "wf-share-1",
      name: "Shared WF",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [],
      edges: [],
      projectId: projA.id
    });

    const share = await ctx.app.inject({
      method: "POST",
      url: "/api/workflows/wf-share-1/shares",
      headers: { cookie: admin.cookie },
      payload: { projectId: projB.id, accessLevel: "execute" }
    });
    expect(share.statusCode).toBe(200);

    const list = await ctx.app.inject({
      method: "GET",
      url: "/api/workflows/wf-share-1/shares",
      headers: { cookie: admin.cookie }
    });
    expect(list.statusCode).toBe(200);
    const { shares } = list.json() as { shares: Array<{ projectId: string; accessLevel: string }> };
    expect(shares[0]).toMatchObject({ projectId: projB.id, accessLevel: "execute" });

    // Cannot share to the same project it already lives in.
    const dup = await ctx.app.inject({
      method: "POST",
      url: "/api/workflows/wf-share-1/shares",
      headers: { cookie: admin.cookie },
      payload: { projectId: projA.id }
    });
    expect(dup.statusCode).toBe(400);

    const unshare = await ctx.app.inject({
      method: "DELETE",
      url: `/api/workflows/wf-share-1/shares/${projB.id}`,
      headers: { cookie: admin.cookie }
    });
    expect(unshare.statusCode).toBe(200);
  });

  it("shares secrets across projects", async () => {
    const ctx = await createTestContext();
    const { cookie } = await loginUser(ctx, {
      email: "admin@example.com",
      password: "admin-password",
      role: "admin"
    });

    const projB = (await ctx.app
      .inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie },
        payload: { name: "B" }
      })
      .then((r) => r.json())) as { id: string };

    const secret = (await ctx.app
      .inject({
        method: "POST",
        url: "/api/secrets",
        headers: { cookie },
        payload: { name: "shared", provider: "openai", value: "sk-xxxxxxxxxxxxxxxxxxx" }
      })
      .then((r) => r.json())) as { id: string };

    const share = await ctx.app.inject({
      method: "POST",
      url: `/api/secrets/${secret.id}/shares`,
      headers: { cookie },
      payload: { projectId: projB.id }
    });
    expect(share.statusCode).toBe(200);

    const list = await ctx.app.inject({
      method: "GET",
      url: `/api/secrets/${secret.id}/shares`,
      headers: { cookie }
    });
    expect(list.statusCode).toBe(200);
    const { shares } = list.json() as { shares: Array<{ projectId: string }> };
    expect(shares.find((s) => s.projectId === projB.id)).toBeDefined();

    const unshare = await ctx.app.inject({
      method: "DELETE",
      url: `/api/secrets/${secret.id}/shares/${projB.id}`,
      headers: { cookie }
    });
    expect(unshare.statusCode).toBe(200);
  });
});
