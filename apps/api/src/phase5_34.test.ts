import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config";
import { createApp } from "./app";
import { SqliteStore } from "./db/database";
import { AuthService } from "./services/auth-service";
import { SecretService } from "./services/secret-service";
import {
  clearMockProvider,
  setMockSecretValue
} from "./services/external-secrets-service";

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
    MFA_ENABLED: false,
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
    GIT_SYNC_ENABLED: true,
    GIT_SYNC_WORKDIR: "apps/api/data/git",
    GIT_BIN: "git",
    GIT_COMMAND_TIMEOUT_MS: 60000,
    WORKFLOW_VERSION_RETENTION: 100,
    METRICS_ENABLED: true,
    METRICS_PREFIX: "ao",
    METRICS_INCLUDE_PROCESS: true,
    METRICS_SLO_SUCCESS_TARGET: 0.99,
    METRICS_SLO_P95_LATENCY_MS: 30000,
    TRACING_ENABLED: false,
    TRACING_ENDPOINT: undefined,
    TRACING_SERVICE_NAME: "ai-orchestrator",
    ...overrides
  };
}

async function createTestContext(overrides: Partial<AppConfig> = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-phase5-34-"));
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
  if (response.statusCode !== 200) throw new Error(`login failed: ${response.body}`);
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

// ---------------------------------------------------------------------------
// Phase 5.3 — External secret providers
// ---------------------------------------------------------------------------

describe("Phase 5.3 — External secret providers CRUD + resolve + rotation", () => {
  it("only admins can register providers; builders can list", async () => {
    const ctx = await createTestContext();
    const admin = await loginUser(ctx, {
      email: "admin@example.com",
      password: "admin-password",
      role: "admin"
    });
    const builder = await loginUser(ctx, {
      email: "builder@example.com",
      password: "builder-password",
      role: "builder"
    });

    const builderCreate = await ctx.app.inject({
      method: "POST",
      url: "/api/external-providers",
      headers: { cookie: builder.cookie },
      payload: { name: "vault-prod", type: "mock", config: {} }
    });
    expect(builderCreate.statusCode).toBe(403);

    const adminCreate = await ctx.app.inject({
      method: "POST",
      url: "/api/external-providers",
      headers: { cookie: admin.cookie },
      payload: { name: "vault-prod", type: "mock", config: {} }
    });
    expect(adminCreate.statusCode).toBe(200);

    const builderList = await ctx.app.inject({
      method: "GET",
      url: "/api/external-providers",
      headers: { cookie: builder.cookie }
    });
    expect(builderList.statusCode).toBe(200);
    const { providers } = builderList.json() as { providers: Array<{ name: string }> };
    expect(providers.map((p) => p.name)).toContain("vault-prod");
  });

  it("rejects unknown provider types", async () => {
    const ctx = await createTestContext();
    const admin = await loginUser(ctx, {
      email: "admin@example.com",
      password: "admin-password",
      role: "admin"
    });
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/external-providers",
      headers: { cookie: admin.cookie },
      payload: { name: "bogus", type: "unknown-cloud", config: {} }
    });
    expect(response.statusCode).toBe(400);
  });

  it("creates an external secret that resolves through the mock provider", async () => {
    const ctx = await createTestContext();
    const { cookie } = await loginUser(ctx, {
      email: "admin@example.com",
      password: "admin-password",
      role: "admin"
    });

    const createProvider = await ctx.app.inject({
      method: "POST",
      url: "/api/external-providers",
      headers: { cookie },
      payload: { name: "mock", type: "mock", config: {}, cacheTtlMs: 60000 }
    });
    expect(createProvider.statusCode).toBe(200);
    const { id: providerId } = createProvider.json() as { id: string };

    setMockSecretValue(providerId, "prod/openai/api-key", "sk-real-openai-key");

    const createSecret = await ctx.app.inject({
      method: "POST",
      url: "/api/secrets",
      headers: { cookie },
      payload: {
        name: "openai-key",
        provider: "openai",
        externalProviderId: providerId,
        externalKey: "prod/openai/api-key"
      }
    });
    expect(createSecret.statusCode).toBe(200);
    const { id: secretId, source } = createSecret.json() as { id: string; source: string };
    expect(source).toBe("external");

    const resolved = await ctx.secretService.resolveSecret({ secretId });
    expect(resolved).toBe("sk-real-openai-key");

    // Listing secrets should include the external marker.
    const list = await ctx.app.inject({
      method: "GET",
      url: "/api/secrets",
      headers: { cookie }
    });
    const payload = list.json() as Array<{ id: string; source: string; externalProviderId: string | null }>;
    const entry = payload.find((s) => s.id === secretId);
    expect(entry?.source).toBe("external");
    expect(entry?.externalProviderId).toBe(providerId);

    clearMockProvider(providerId);
  });

  it("rejects value+external hybrid payload", async () => {
    const ctx = await createTestContext();
    const { cookie } = await loginUser(ctx, {
      email: "admin@example.com",
      password: "admin-password",
      role: "admin"
    });
    const provider = await ctx.app.inject({
      method: "POST",
      url: "/api/external-providers",
      headers: { cookie },
      payload: { name: "mock", type: "mock", config: {} }
    });
    const { id: providerId } = provider.json() as { id: string };
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/secrets",
      headers: { cookie },
      payload: {
        name: "bad",
        provider: "openai",
        value: "oops",
        externalProviderId: providerId,
        externalKey: "some-key"
      }
    });
    expect(response.statusCode).toBe(400);
  });

  it("caches resolved values within the provider TTL and refreshes after invalidation", async () => {
    const ctx = await createTestContext();
    const { cookie } = await loginUser(ctx, {
      email: "admin@example.com",
      password: "admin-password",
      role: "admin"
    });
    const createProvider = await ctx.app.inject({
      method: "POST",
      url: "/api/external-providers",
      headers: { cookie },
      payload: { name: "mock", type: "mock", config: {}, cacheTtlMs: 60000 }
    });
    const { id: providerId } = createProvider.json() as { id: string };
    setMockSecretValue(providerId, "rotate/key", "initial-value");

    const createSecret = await ctx.app.inject({
      method: "POST",
      url: "/api/secrets",
      headers: { cookie },
      payload: {
        name: "rotating",
        provider: "custom",
        externalProviderId: providerId,
        externalKey: "rotate/key"
      }
    });
    const { id: secretId } = createSecret.json() as { id: string };

    const first = await ctx.secretService.resolveSecret({ secretId });
    expect(first).toBe("initial-value");

    // Change the source of truth — the cache should still serve the old value.
    setMockSecretValue(providerId, "rotate/key", "rotated-value");
    const cached = await ctx.secretService.resolveSecret({ secretId });
    expect(cached).toBe("initial-value");

    // Invalidate the cache and the next resolve sees the rotated value.
    ctx.secretService.invalidateExternalCache(secretId);
    const refreshed = await ctx.secretService.resolveSecret({ secretId });
    expect(refreshed).toBe("rotated-value");

    clearMockProvider(providerId);
  });

  it("rejects deleting a provider that still has secrets pointing at it", async () => {
    const ctx = await createTestContext();
    const { cookie } = await loginUser(ctx, {
      email: "admin@example.com",
      password: "admin-password",
      role: "admin"
    });
    const createProvider = await ctx.app.inject({
      method: "POST",
      url: "/api/external-providers",
      headers: { cookie },
      payload: { name: "mock", type: "mock", config: {} }
    });
    const { id: providerId } = createProvider.json() as { id: string };
    setMockSecretValue(providerId, "k", "v");
    await ctx.app.inject({
      method: "POST",
      url: "/api/secrets",
      headers: { cookie },
      payload: {
        name: "ref",
        provider: "custom",
        externalProviderId: providerId,
        externalKey: "k"
      }
    });

    const deleteBlocked = await ctx.app.inject({
      method: "DELETE",
      url: `/api/external-providers/${providerId}`,
      headers: { cookie }
    });
    expect(deleteBlocked.statusCode).toBe(409);
    clearMockProvider(providerId);
  });

  it("tests a provider end-to-end via /test", async () => {
    const ctx = await createTestContext();
    const { cookie } = await loginUser(ctx, {
      email: "admin@example.com",
      password: "admin-password",
      role: "admin"
    });
    const createProvider = await ctx.app.inject({
      method: "POST",
      url: "/api/external-providers",
      headers: { cookie },
      payload: { name: "mock", type: "mock", config: {} }
    });
    const { id: providerId } = createProvider.json() as { id: string };
    setMockSecretValue(providerId, "hello", "world");

    const test = await ctx.app.inject({
      method: "POST",
      url: `/api/external-providers/${providerId}/test`,
      headers: { cookie },
      payload: { key: "hello" }
    });
    expect(test.statusCode).toBe(200);
    expect((test.json() as { length: number }).length).toBe("world".length);

    const badTest = await ctx.app.inject({
      method: "POST",
      url: `/api/external-providers/${providerId}/test`,
      headers: { cookie },
      payload: { key: "missing" }
    });
    expect(badTest.statusCode).toBe(400);

    clearMockProvider(providerId);
  });
});

// ---------------------------------------------------------------------------
// Phase 5.4 — Audit logging
// ---------------------------------------------------------------------------

describe("Phase 5.4 — Audit logging", () => {
  beforeEach(() => {
    /* each test gets its own context via createTestContext() */
  });

  it("records login and logout events", async () => {
    const ctx = await createTestContext();
    const { cookie } = await loginUser(ctx, {
      email: "admin@example.com",
      password: "admin-password",
      role: "admin"
    });
    await ctx.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie }
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/audit?category=auth",
      headers: { cookie }
    });
    // After logout the session is revoked, so the request should be 401 — log in again.
    expect([200, 401]).toContain(response.statusCode);
    const second = await loginUser(ctx, {
      email: "second@example.com",
      password: "second-password",
      role: "admin"
    });
    const list = await ctx.app.inject({
      method: "GET",
      url: "/api/audit?category=auth",
      headers: { cookie: second.cookie }
    });
    expect(list.statusCode).toBe(200);
    const payload = list.json() as {
      items: Array<{ eventType: string; outcome: string }>;
      total: number;
    };
    expect(payload.items.some((item) => item.eventType === "user.login")).toBe(true);
    expect(payload.items.some((item) => item.eventType === "user.logout")).toBe(true);
  });

  it("captures failed login attempts with outcome=failure", async () => {
    const ctx = await createTestContext();
    const admin = await loginUser(ctx, {
      email: "admin@example.com",
      password: "admin-password",
      role: "admin"
    });
    await ctx.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "wrong-password" }
    });
    const list = await ctx.app.inject({
      method: "GET",
      url: "/api/audit?category=auth&outcome=failure",
      headers: { cookie: admin.cookie }
    });
    expect(list.statusCode).toBe(200);
    const payload = list.json() as { items: Array<{ eventType: string; outcome: string }> };
    expect(payload.items.some((item) => item.eventType === "user.login" && item.outcome === "failure")).toBe(true);
  });

  it("records workflow create/delete events and filters by resourceType", async () => {
    const ctx = await createTestContext();
    const { cookie } = await loginUser(ctx, {
      email: "admin@example.com",
      password: "admin-password",
      role: "admin"
    });

    const createWf = await ctx.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: { cookie },
      payload: {
        id: "audit-wf",
        name: "Audit Test",
        schemaVersion: "1.0.0",
        workflowVersion: 1,
        nodes: [{ id: "n1", type: "output", name: "Out", position: { x: 10, y: 10 }, config: {} }],
        edges: []
      }
    });
    expect(createWf.statusCode).toBe(200);

    const del = await ctx.app.inject({
      method: "DELETE",
      url: "/api/workflows/audit-wf",
      headers: { cookie }
    });
    expect(del.statusCode).toBe(200);

    const list = await ctx.app.inject({
      method: "GET",
      url: "/api/audit?resourceType=workflow",
      headers: { cookie }
    });
    expect(list.statusCode).toBe(200);
    const payload = list.json() as { items: Array<{ eventType: string; resourceId: string | null }> };
    const events = payload.items
      .filter((item) => item.resourceId === "audit-wf")
      .map((item) => item.eventType);
    expect(events).toContain("workflow.create");
    expect(events).toContain("workflow.delete");
  });

  it("records secret create/delete events (local + external)", async () => {
    const ctx = await createTestContext();
    const { cookie } = await loginUser(ctx, {
      email: "admin@example.com",
      password: "admin-password",
      role: "admin"
    });
    await ctx.app.inject({
      method: "POST",
      url: "/api/secrets",
      headers: { cookie },
      payload: { name: "test-secret", provider: "openai", value: "sk-test-value-1234" }
    });

    const createProvider = await ctx.app.inject({
      method: "POST",
      url: "/api/external-providers",
      headers: { cookie },
      payload: { name: "mock", type: "mock", config: {} }
    });
    const { id: providerId } = createProvider.json() as { id: string };
    setMockSecretValue(providerId, "k", "v");
    await ctx.app.inject({
      method: "POST",
      url: "/api/secrets",
      headers: { cookie },
      payload: {
        name: "ext-secret",
        provider: "custom",
        externalProviderId: providerId,
        externalKey: "k"
      }
    });

    const list = await ctx.app.inject({
      method: "GET",
      url: "/api/audit?category=secret",
      headers: { cookie }
    });
    const payload = list.json() as { items: Array<{ eventType: string }> };
    expect(payload.items.some((item) => item.eventType === "secret.create")).toBe(true);
    expect(payload.items.some((item) => item.eventType === "secret.create.external")).toBe(true);
    clearMockProvider(providerId);
  });

  it("rejects non-admins from reading audit logs", async () => {
    const ctx = await createTestContext();
    await loginUser(ctx, {
      email: "admin@example.com",
      password: "admin-password",
      role: "admin"
    });
    const builder = await loginUser(ctx, {
      email: "builder@example.com",
      password: "builder-password",
      role: "builder"
    });
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/audit",
      headers: { cookie: builder.cookie }
    });
    expect(response.statusCode).toBe(403);
  });

  it("exports audit log as CSV", async () => {
    const ctx = await createTestContext();
    const { cookie } = await loginUser(ctx, {
      email: "admin@example.com",
      password: "admin-password",
      role: "admin"
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/audit/export?category=auth",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    const body = response.body;
    expect(body.split("\n")[0]).toContain("id,created_at,category,event_type");
    // Includes at least one row (the login that gave us the cookie).
    expect(body.split("\n").length).toBeGreaterThan(1);
  });

  it("purges old entries based on retention cutoff", async () => {
    const ctx = await createTestContext();
    const { cookie } = await loginUser(ctx, {
      email: "admin@example.com",
      password: "admin-password",
      role: "admin"
    });
    // Directly insert an ancient entry via the store.
    ctx.store.writeAuditLog({
      id: "aud_ancient",
      eventType: "system.test",
      category: "system",
      action: "test",
      outcome: "success",
      createdAt: "2001-01-01T00:00:00.000Z"
    });
    const cutoff = new Date("2010-01-01T00:00:00.000Z").toISOString();
    const pruned = ctx.store.pruneAuditLogs({ before: cutoff });
    expect(pruned).toBeGreaterThanOrEqual(1);

    const list = await ctx.app.inject({
      method: "GET",
      url: "/api/audit?eventType=system.test",
      headers: { cookie }
    });
    const payload = list.json() as { items: Array<{ id: string }> };
    expect(payload.items.find((item) => item.id === "aud_ancient")).toBeUndefined();
  });

  it("respects AUDIT_LOG_ENABLED=false and does not write entries", async () => {
    const ctx = await createTestContext({ AUDIT_LOG_ENABLED: false });
    await loginUser(ctx, {
      email: "admin@example.com",
      password: "admin-password",
      role: "admin"
    });
    const second = await loginUser(ctx, {
      email: "second@example.com",
      password: "second-password",
      role: "admin"
    });
    const list = await ctx.app.inject({
      method: "GET",
      url: "/api/audit",
      headers: { cookie: second.cookie }
    });
    expect(list.statusCode).toBe(200);
    const payload = list.json() as { total: number };
    expect(payload.total).toBe(0);
  });

  it("paginates results", async () => {
    const ctx = await createTestContext();
    const { cookie } = await loginUser(ctx, {
      email: "admin@example.com",
      password: "admin-password",
      role: "admin"
    });
    // Generate enough events to need pagination.
    for (let i = 0; i < 6; i += 1) {
      ctx.store.writeAuditLog({
        id: `aud_p${i}`,
        eventType: "system.test",
        category: "system",
        action: "noop",
        outcome: "success"
      });
    }
    const page1 = await ctx.app.inject({
      method: "GET",
      url: "/api/audit?category=system&pageSize=3&page=1",
      headers: { cookie }
    });
    const page2 = await ctx.app.inject({
      method: "GET",
      url: "/api/audit?category=system&pageSize=3&page=2",
      headers: { cookie }
    });
    const p1 = page1.json() as { items: unknown[]; total: number };
    const p2 = page2.json() as { items: unknown[]; total: number };
    expect(p1.items.length).toBe(3);
    expect(p2.items.length).toBeGreaterThan(0);
    expect(p1.total).toBe(p2.total);
  });
});
