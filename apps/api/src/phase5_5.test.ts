import crypto from "node:crypto";
import dgram from "node:dgram";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config";
import { createApp } from "./app";
import { SqliteStore } from "./db/database";
import { AuthService } from "./services/auth-service";
import { SecretService } from "./services/secret-service";
import { LogStreamingService } from "./services/log-streaming-service";

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
    LOG_STREAM_RETRY_MAX_ATTEMPTS: 2,
    LOG_STREAM_EVENT_RETENTION_DAYS: 14,
    LOG_STREAM_EVENT_PRUNE_INTERVAL_MS: 3600000,
    ...overrides
  };
}

async function createTestContext(overrides: Partial<AppConfig> = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-phase5-5-"));
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
  ctx.authService.register({
    email: "admin@example.com",
    password: "admin-password",
    role: "admin"
  });
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "admin@example.com", password: "admin-password" }
  });
  return extractCookie(response.headers["set-cookie"], ctx.config.SESSION_COOKIE_NAME);
}

async function loginOperator(ctx: TestContext): Promise<string> {
  ctx.authService.register({
    email: "operator@example.com",
    password: "operator-password",
    role: "operator"
  });
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "operator@example.com", password: "operator-password" }
  });
  return extractCookie(response.headers["set-cookie"], ctx.config.SESSION_COOKIE_NAME);
}

afterEach(async () => {
  while (contexts.length > 0) {
    const ctx = contexts.pop();
    if (!ctx) continue;
    await ctx.app.close();
    fs.rmSync(ctx.tempDir, { recursive: true, force: true });
  }
});

describe("Phase 5.5 — Log streaming destination CRUD (API)", () => {
  it("creates, updates, lists and deletes destinations (admin only, secrets masked)", async () => {
    const ctx = await createTestContext();
    const cookie = await loginAdmin(ctx);

    const create = await ctx.app.inject({
      method: "POST",
      url: "/api/log-streams",
      headers: { cookie },
      payload: {
        name: "prod-webhook",
        type: "webhook",
        minLevel: "warn",
        categories: ["workflow", "execution"],
        config: {
          url: "https://example.com/ingest",
          headers: { "x-team": "platform" },
          hmacSecret: "very-secret-token"
        }
      }
    });
    expect(create.statusCode).toBe(200);
    const created = create.json() as { destination: { id: string; config: Record<string, unknown> } };
    expect(created.destination.id).toMatch(/^lsd_/);
    // Secret fields must be masked in responses.
    expect(created.destination.config.hmacSecret).toBe("__secret__");
    expect(created.destination.config.url).toBe("https://example.com/ingest");

    const list = await ctx.app.inject({ method: "GET", url: "/api/log-streams", headers: { cookie } });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { destinations: unknown[] }).destinations).toHaveLength(1);

    // Update: toggle enabled + patch name without touching the secret.
    const update = await ctx.app.inject({
      method: "PUT",
      url: `/api/log-streams/${created.destination.id}`,
      headers: { cookie },
      payload: { enabled: false, name: "prod-webhook-renamed" }
    });
    expect(update.statusCode).toBe(200);
    const updated = (update.json() as { destination: { enabled: boolean; name: string } }).destination;
    expect(updated.enabled).toBe(false);
    expect(updated.name).toBe("prod-webhook-renamed");

    // Delete.
    const del = await ctx.app.inject({
      method: "DELETE",
      url: `/api/log-streams/${created.destination.id}`,
      headers: { cookie }
    });
    expect(del.statusCode).toBe(200);
  });

  it("denies non-admin access to destination routes", async () => {
    const ctx = await createTestContext();
    const cookie = await loginOperator(ctx);
    const list = await ctx.app.inject({
      method: "GET",
      url: "/api/log-streams",
      headers: { cookie }
    });
    expect(list.statusCode).toBe(403);
  });

  it("rejects invalid destination config", async () => {
    const ctx = await createTestContext();
    const cookie = await loginAdmin(ctx);
    const bad = await ctx.app.inject({
      method: "POST",
      url: "/api/log-streams",
      headers: { cookie },
      payload: {
        name: "bad-webhook",
        type: "webhook",
        config: { url: "not-a-url" }
      }
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe("Phase 5.5 — webhook destination delivery + HMAC signing", () => {
  it("POSTs JSON to the configured URL with an HMAC signature on test()", async () => {
    const received: Array<{ body: string; headers: http.IncomingHttpHeaders }> = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk as Buffer));
      req.on("end", () => {
        received.push({ body: Buffer.concat(chunks).toString("utf8"), headers: req.headers });
        res.statusCode = 200;
        res.end("ok");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const ctx = await createTestContext();
      const cookie = await loginAdmin(ctx);
      const hmacSecret = "sh4red-signing-secret";
      const create = await ctx.app.inject({
        method: "POST",
        url: "/api/log-streams",
        headers: { cookie },
        payload: {
          name: "local-webhook",
          type: "webhook",
          config: {
            url: `http://127.0.0.1:${port}/ingest`,
            hmacSecret,
            hmacHeader: "x-ao-signature"
          }
        }
      });
      expect(create.statusCode).toBe(200);
      const id = (create.json() as { destination: { id: string } }).destination.id;

      const test = await ctx.app.inject({
        method: "POST",
        url: `/api/log-streams/${id}/test`,
        headers: { cookie }
      });
      expect(test.statusCode).toBe(200);
      expect((test.json() as { ok: boolean }).ok).toBe(true);

      expect(received).toHaveLength(1);
      const delivered = received[0]!;
      const expectedSig = crypto.createHmac("sha256", hmacSecret).update(delivered.body).digest("hex");
      expect(delivered.headers["x-ao-signature"]).toBe(`sha256=${expectedSig}`);
      const payload = JSON.parse(delivered.body) as { category: string; eventType: string };
      expect(payload.category).toBe("system");
      expect(payload.eventType).toBe("log_stream.test");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports failure when the webhook returns a non-2xx response", async () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 500;
      res.end("boom");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const ctx = await createTestContext();
      const cookie = await loginAdmin(ctx);
      const create = await ctx.app.inject({
        method: "POST",
        url: "/api/log-streams",
        headers: { cookie },
        payload: {
          name: "broken-webhook",
          type: "webhook",
          config: { url: `http://127.0.0.1:${port}/ingest` }
        }
      });
      const id = (create.json() as { destination: { id: string } }).destination.id;

      const test = await ctx.app.inject({
        method: "POST",
        url: `/api/log-streams/${id}/test`,
        headers: { cookie }
      });
      expect(test.statusCode).toBe(400);
      const body = test.json() as { ok: boolean; error?: string };
      expect(body.ok).toBe(false);
      expect(body.error ?? "").toMatch(/500/);

      const after = await ctx.app.inject({
        method: "GET",
        url: "/api/log-streams",
        headers: { cookie }
      });
      const destinations = (after.json() as {
        destinations: Array<{ failedCount: number; lastError: string | null }>;
      }).destinations;
      expect(destinations[0]!.failedCount).toBeGreaterThanOrEqual(1);
      expect(destinations[0]!.lastError ?? "").toMatch(/500/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("Phase 5.5 — syslog UDP delivery", () => {
  it("emits an RFC 5424 framed message to the configured UDP collector", async () => {
    const received: string[] = [];
    const socket = dgram.createSocket("udp4");
    await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
    const port = (socket.address() as { port: number }).port;
    socket.on("message", (msg) => {
      received.push(msg.toString("utf8"));
    });

    try {
      const ctx = await createTestContext();
      const cookie = await loginAdmin(ctx);
      const create = await ctx.app.inject({
        method: "POST",
        url: "/api/log-streams",
        headers: { cookie },
        payload: {
          name: "local-syslog",
          type: "syslog",
          config: { host: "127.0.0.1", port, transport: "udp", facility: 16, appName: "ao-test" }
        }
      });
      const id = (create.json() as { destination: { id: string } }).destination.id;

      const test = await ctx.app.inject({
        method: "POST",
        url: `/api/log-streams/${id}/test`,
        headers: { cookie }
      });
      expect(test.statusCode).toBe(200);

      for (let i = 0; i < 20 && received.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(received.length).toBeGreaterThanOrEqual(1);
      const message = received[0]!;
      // <134> = facility 16 * 8 + severity 6 (info).
      expect(message).toMatch(/^<134>1 /);
      expect(message).toContain("ao-test");
      expect(message).toContain("log_stream.test");
    } finally {
      await new Promise<void>((resolve) => socket.close(() => resolve()));
    }
  });
});

describe("Phase 5.5 — audit events fan out to matching destinations", () => {
  it("dispatches recorded audit events to the destination and records delivery history", async () => {
    const received: Array<{ body: string }> = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk as Buffer));
      req.on("end", () => {
        received.push({ body: Buffer.concat(chunks).toString("utf8") });
        res.statusCode = 200;
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const ctx = await createTestContext();
      const cookie = await loginAdmin(ctx);
      const create = await ctx.app.inject({
        method: "POST",
        url: "/api/log-streams",
        headers: { cookie },
        payload: {
          name: "audit-sink",
          type: "webhook",
          categories: ["secret"],
          config: { url: `http://127.0.0.1:${port}/ingest` }
        }
      });
      expect(create.statusCode).toBe(200);
      const id = (create.json() as { destination: { id: string } }).destination.id;

      // Creating a secret triggers an audit event in category 'secret'.
      const createSecret = await ctx.app.inject({
        method: "POST",
        url: "/api/secrets",
        headers: { cookie },
        payload: { name: "hello", provider: "openai", value: "sk-test" }
      });
      expect(createSecret.statusCode).toBe(200);

      // Give the async queue up to 1s to drain.
      const start = Date.now();
      while (received.length === 0 && Date.now() - start < 2000) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(received.length).toBeGreaterThanOrEqual(1);
      const parsed = JSON.parse(received[0]!.body) as { category: string };
      expect(parsed.category).toBe("secret");

      const events = await ctx.app.inject({
        method: "GET",
        url: `/api/log-streams/${id}/events`,
        headers: { cookie }
      });
      expect(events.statusCode).toBe(200);
      const eventPayload = events.json() as { events: Array<{ status: string }> };
      expect(eventPayload.events.length).toBeGreaterThanOrEqual(1);
      expect(eventPayload.events[0]!.status).toBe("sent");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("respects category filters — ignores events that do not match", async () => {
    const received: string[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk as Buffer));
      req.on("end", () => {
        received.push(Buffer.concat(chunks).toString("utf8"));
        res.statusCode = 200;
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const ctx = await createTestContext();
      const cookie = await loginAdmin(ctx);
      await ctx.app.inject({
        method: "POST",
        url: "/api/log-streams",
        headers: { cookie },
        payload: {
          name: "rbac-only",
          type: "webhook",
          categories: ["rbac"],
          config: { url: `http://127.0.0.1:${port}/ingest` }
        }
      });

      // Creating a secret is category 'secret' — must NOT be delivered.
      await ctx.app.inject({
        method: "POST",
        url: "/api/secrets",
        headers: { cookie },
        payload: { name: "x", provider: "openai", value: "v" }
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(received).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("Phase 5.5 — LogStreamingService unit behavior", () => {
  it("validates destination type and config shape", async () => {
    const ctx = await createTestContext();
    const service = new LogStreamingService(ctx.store, ctx.config.SECRET_MASTER_KEY_BASE64, {
      enabled: true,
      flushIntervalMs: 500
    });
    expect(() =>
      service.createDestination({
        name: "bad",
        type: "unknown" as unknown as "webhook",
        config: {}
      })
    ).toThrow(/unsupported/);
    expect(() =>
      service.createDestination({ name: "bad", type: "webhook", config: { url: "ftp://x" } })
    ).toThrow(/url/);
  });

  it("keeps secrets encrypted at rest on the SqliteStore row", async () => {
    const ctx = await createTestContext();
    const service = new LogStreamingService(ctx.store, ctx.config.SECRET_MASTER_KEY_BASE64);
    const created = service.createDestination({
      name: "sentry",
      type: "sentry",
      config: { dsn: "https://abc123@sentry.example.com/42" }
    });
    const row = ctx.store.getLogStreamDestination(created.id);
    expect(row).toBeTruthy();
    // The ciphertext column must not contain the raw DSN.
    expect(row!.configCiphertext).not.toContain("sentry.example.com");
    expect(row!.configCiphertext).not.toContain("abc123");
    // Public view masks the dsn field.
    const pub = service.getDestination(created.id);
    expect(pub!.config.dsn).toBe("__secret__");
  });
});
