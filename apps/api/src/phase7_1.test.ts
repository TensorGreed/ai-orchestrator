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
import { LeaderElectionService } from "./services/leader-election-service";

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
    LOG_LEVEL: "warn",
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
    LOG_STREAM_ENABLED: false,
    LOG_STREAM_FLUSH_INTERVAL_MS: 2000,
    LOG_STREAM_BUFFER_SIZE: 1000,
    LOG_STREAM_RETRY_MAX_ATTEMPTS: 2,
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
    TRACING_SERVICE_NAME: "ai-orchestrator-test",
    WORKER_MODE: "all",
    HA_ENABLED: false,
    HA_INSTANCE_ID: undefined,
    HA_LEASE_TTL_MS: 30000,
    HA_RENEW_INTERVAL_MS: 10000,
    NOTIFICATIONS_ENABLED: false,
    NOTIFICATION_SMTP_PORT: 587,
    NOTIFICATION_SMTP_SECURE: false,
    ...overrides
  };
}

async function createTestContext(overrides: Partial<AppConfig> = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-phase7-1-"));
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
  return cookie.split(";")[0]!;
}

async function loginAdmin(ctx: TestContext): Promise<string> {
  ctx.authService.register({ email: "admin@example.com", password: "admin-password", role: "admin" });
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "admin@example.com", password: "admin-password" }
  });
  return extractCookie(response.headers["set-cookie"], ctx.config.SESSION_COOKIE_NAME);
}

afterEach(async () => {
  while (contexts.length > 0) {
    const ctx = contexts.pop();
    if (!ctx) continue;
    await ctx.app.close();
    try {
      fs.rmSync(ctx.tempDir, { recursive: true, force: true });
    } catch {
      // best effort on Windows
    }
  }
});

describe("Phase 7.1 — Leader lease primitive (store-level)", () => {
  it("first acquirer wins, second sees it held, and holder can renew", async () => {
    const ctx = await createTestContext();
    const a = ctx.store.tryAcquireLease({ leaseName: "primary", holderId: "node-a", ttlMs: 60000 });
    const b = ctx.store.tryAcquireLease({ leaseName: "primary", holderId: "node-b", ttlMs: 60000 });
    expect(a).toBe(true);
    expect(b).toBe(false);

    const renewed = ctx.store.tryAcquireLease({ leaseName: "primary", holderId: "node-a", ttlMs: 60000 });
    expect(renewed).toBe(true);
    const lease = ctx.store.getLease("primary");
    expect(lease?.holderId).toBe("node-a");
  });

  it("expired leases can be stolen by any other holder", async () => {
    const ctx = await createTestContext();
    // Acquire with a 1ms TTL so it's immediately expired.
    ctx.store.tryAcquireLease({ leaseName: "primary", holderId: "dead-node", ttlMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const stolen = ctx.store.tryAcquireLease({ leaseName: "primary", holderId: "new-node", ttlMs: 60000 });
    expect(stolen).toBe(true);
    const lease = ctx.store.getLease("primary");
    expect(lease?.holderId).toBe("new-node");
  });

  it("releaseLease only removes the row if the caller matches the holder", async () => {
    const ctx = await createTestContext();
    ctx.store.tryAcquireLease({ leaseName: "primary", holderId: "node-a", ttlMs: 60000 });
    expect(ctx.store.releaseLease("primary", "node-b")).toBe(false);
    expect(ctx.store.getLease("primary")?.holderId).toBe("node-a");
    expect(ctx.store.releaseLease("primary", "node-a")).toBe(true);
    expect(ctx.store.getLease("primary")).toBeNull();
  });
});

describe("Phase 7.1 — LeaderElectionService", () => {
  it("short-circuits to always-leader when HA_ENABLED is false", async () => {
    const ctx = await createTestContext();
    let becameLeader = 0;
    const service = new LeaderElectionService(
      ctx.store,
      {
        enabled: false,
        onBecomeLeader: () => {
          becameLeader += 1;
        }
      },
      "test-disabled"
    );
    await service.start();
    expect(service.isLeader()).toBe(true);
    expect(becameLeader).toBe(1);
    const status = service.getStatus();
    expect(status.enabled).toBe(false);
    expect(status.isLeader).toBe(true);
    await service.stop();
  });

  it("fires onBecomeLeader exactly once when the lease is acquired", async () => {
    const ctx = await createTestContext();
    let becameLeader = 0;
    const service = new LeaderElectionService(
      ctx.store,
      {
        enabled: true,
        instanceId: "winner",
        leaseTtlMs: 30000,
        renewIntervalMs: 60000,
        onBecomeLeader: () => {
          becameLeader += 1;
        }
      },
      "test-fires-once"
    );
    await service.start();
    expect(service.isLeader()).toBe(true);
    expect(becameLeader).toBe(1);
    // Second start-like tick shouldn't re-fire.
    await (service as unknown as { tick: () => Promise<void> }).tick();
    expect(becameLeader).toBe(1);
    await service.stop();
  });

  it("only one instance of two competing services wins the lease", async () => {
    const ctx = await createTestContext();
    let aLeader = false;
    let bLeader = false;
    const a = new LeaderElectionService(
      ctx.store,
      {
        enabled: true,
        instanceId: "a",
        leaseTtlMs: 60000,
        onBecomeLeader: () => {
          aLeader = true;
        }
      },
      "contested"
    );
    const b = new LeaderElectionService(
      ctx.store,
      {
        enabled: true,
        instanceId: "b",
        leaseTtlMs: 60000,
        onBecomeLeader: () => {
          bLeader = true;
        }
      },
      "contested"
    );
    await a.start();
    await b.start();
    expect(a.isLeader()).toBe(true);
    expect(b.isLeader()).toBe(false);
    expect(aLeader).toBe(true);
    expect(bLeader).toBe(false);
    await a.stop();
    await b.stop();
  });

  it("after leader resigns, the other instance can take over on next tick", async () => {
    const ctx = await createTestContext();
    const a = new LeaderElectionService(
      ctx.store,
      { enabled: true, instanceId: "a", leaseTtlMs: 60000 },
      "handoff"
    );
    const b = new LeaderElectionService(
      ctx.store,
      { enabled: true, instanceId: "b", leaseTtlMs: 60000 },
      "handoff"
    );
    await a.start();
    expect(a.isLeader()).toBe(true);
    await a.stop();
    await b.start();
    expect(b.isLeader()).toBe(true);
    await b.stop();
  });
});

describe("Phase 7.1 — /api/ha/status route", () => {
  it("returns HA status to admin callers", async () => {
    const ctx = await createTestContext({ HA_ENABLED: false, WORKER_MODE: "all" });
    const cookie = await loginAdmin(ctx);
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/ha/status",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      workerMode: string;
      leader: { enabled: boolean; isLeader: boolean; instanceId: string };
      leases: unknown[];
    };
    expect(body.workerMode).toBe("all");
    expect(body.leader.enabled).toBe(false);
    expect(body.leader.isLeader).toBe(true);
    expect(Array.isArray(body.leases)).toBe(true);
  });

  it("reports the HA leader lease holder when HA is enabled", async () => {
    const ctx = await createTestContext({
      HA_ENABLED: true,
      HA_INSTANCE_ID: "test-replica-1",
      HA_LEASE_TTL_MS: 60000,
      HA_RENEW_INTERVAL_MS: 60000
    });
    const cookie = await loginAdmin(ctx);
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/ha/status",
      headers: { cookie }
    });
    const body = response.json() as {
      leader: { enabled: boolean; isLeader: boolean; instanceId: string; leaseHolder: string };
    };
    expect(body.leader.enabled).toBe(true);
    expect(body.leader.instanceId).toBe("test-replica-1");
    expect(body.leader.isLeader).toBe(true);
    expect(body.leader.leaseHolder).toBe("test-replica-1");
  });

  it("reports WORKER_MODE=webhook correctly", async () => {
    const ctx = await createTestContext({ WORKER_MODE: "webhook" });
    const cookie = await loginAdmin(ctx);
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/ha/status",
      headers: { cookie }
    });
    const body = response.json() as { workerMode: string };
    expect(body.workerMode).toBe("webhook");
  });

  it("denies non-admin callers", async () => {
    const ctx = await createTestContext();
    ctx.authService.register({ email: "v@example.com", password: "viewer-password", role: "viewer" });
    const loginResp = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "v@example.com", password: "viewer-password" }
    });
    const cookie = extractCookie(loginResp.headers["set-cookie"], ctx.config.SESSION_COOKIE_NAME);
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/ha/status",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(403);
  });
});
