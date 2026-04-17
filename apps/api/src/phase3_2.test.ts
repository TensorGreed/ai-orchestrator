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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-phase3-2-"));
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
  return cookie.split(";")[0];
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

afterEach(async () => {
  while (contexts.length > 0) {
    const ctx = contexts.pop();
    if (!ctx) continue;
    await ctx.app.close();
    fs.rmSync(ctx.tempDir, { recursive: true, force: true });
  }
});

describe("Phase 3.2 — /api/integrations exposes Tier 2 integrations", () => {
  it("returns Tier 1 + Tier 2 integrations with logos", async () => {
    const ctx = await createTestContext();
    const cookie = await loginAdmin(ctx);
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/integrations",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(200);
    const { integrations } = response.json() as {
      integrations: Array<{ id: string; label: string; category: string; logoPath: string; nodeTypes: string[] }>;
    };
    const expectedIds = [
      "slack", // tier 1 sanity check
      "microsoft-teams",
      "notion",
      "airtable",
      "jira",
      "salesforce",
      "hubspot",
      "stripe",
      "aws-s3",
      "telegram",
      "discord",
      "google-drive",
      "google-calendar",
      "twilio"
    ];
    for (const id of expectedIds) {
      const entry = integrations.find((i) => i.id === id);
      expect(entry, `expected ${id}`).toBeDefined();
      expect(entry!.logoPath).toMatch(/\.svg$/);
      expect(entry!.nodeTypes.length).toBeGreaterThan(0);
    }
  });
});

describe("Phase 3.2 — /api/definitions exposes Tier 2 node types", () => {
  it("returns all Tier 2 node schemas", async () => {
    const ctx = await createTestContext();
    const cookie = await loginAdmin(ctx);
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/definitions",
      headers: { cookie }
    });
    const { nodes } = response.json() as { nodes: Array<{ type: string; label: string }> };
    const tier2Types = [
      "teams_send_message",
      "notion_create_page",
      "notion_query_database",
      "airtable_create_record",
      "airtable_list_records",
      "airtable_update_record",
      "jira_create_issue",
      "jira_search_issues",
      "salesforce_create_record",
      "salesforce_query",
      "hubspot_create_contact",
      "hubspot_get_contact",
      "stripe_create_customer",
      "stripe_create_charge",
      "stripe_webhook_trigger",
      "aws_s3_put_object",
      "aws_s3_get_object",
      "aws_s3_list_objects",
      "telegram_send_message",
      "telegram_trigger",
      "discord_send_message",
      "discord_trigger",
      "google_drive_trigger",
      "google_calendar_create_event",
      "google_calendar_list_events",
      "twilio_send_sms"
    ];
    for (const type of tier2Types) {
      expect(nodes.find((n) => n.type === type), `missing ${type}`).toBeDefined();
    }
  });
});

describe("Phase 3.2 — Stripe webhook signature validation", () => {
  it("accepts a correctly signed webhook and rejects a bad one", async () => {
    const ctx = await createTestContext();
    const cookie = await loginAdmin(ctx);
    const signingValue = "whsec_test_signing_secret_12345";
    const secret = ctx.secretService.createSecret({
      name: "stripe-signing",
      provider: "stripe",
      value: signingValue
    });

    // Workflow with a stripe_webhook_trigger node pointing at that secret.
    await ctx.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: { cookie },
      payload: {
        id: "wf-stripe",
        name: "Stripe webhook",
        schemaVersion: "1.0.0",
        workflowVersion: 1,
        nodes: [
          {
            id: "trigger",
            type: "stripe_webhook_trigger",
            name: "Stripe Events",
            position: { x: 0, y: 0 },
            config: {
              path: "stripe-events",
              signingSecretRef: { secretId: secret.secretId },
              replayToleranceSeconds: 300
            }
          },
          {
            id: "out",
            type: "output",
            name: "out",
            position: { x: 200, y: 0 },
            config: { outputKey: "result" }
          }
        ],
        edges: [{ id: "e1", source: "trigger", target: "out" }]
      }
    });

    const body = JSON.stringify({ id: "evt_1", type: "payment_intent.succeeded" });
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac("sha256", signingValue).update(`${t}.${body}`).digest("hex");

    const good = await ctx.app.inject({
      method: "POST",
      url: "/api/webhooks/stripe/wf-stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": `t=${t},v1=${sig}`
      },
      payload: body
    });
    expect(good.statusCode).toBe(200);
    expect((good.json() as { ok: boolean }).ok).toBe(true);

    const bad = await ctx.app.inject({
      method: "POST",
      url: "/api/webhooks/stripe/wf-stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": `t=${t},v1=deadbeef`
      },
      payload: body
    });
    expect(bad.statusCode).toBe(401);

    const outsideWindow = Math.floor(Date.now() / 1000) - 10_000;
    const staleSig = crypto
      .createHmac("sha256", signingValue)
      .update(`${outsideWindow}.${body}`)
      .digest("hex");
    const stale = await ctx.app.inject({
      method: "POST",
      url: "/api/webhooks/stripe/wf-stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": `t=${outsideWindow},v1=${staleSig}`
      },
      payload: body
    });
    expect(stale.statusCode).toBe(401);
  });
});

describe("Phase 3.2 — Telegram webhook secret-token validation", () => {
  it("accepts matching X-Telegram-Bot-Api-Secret-Token and rejects mismatches", async () => {
    const ctx = await createTestContext();
    const cookie = await loginAdmin(ctx);
    const tgSecret = ctx.secretService.createSecret({
      name: "tg-secret",
      provider: "telegram",
      value: "shared-secret-token-1234"
    });

    await ctx.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: { cookie },
      payload: {
        id: "wf-tg",
        name: "Telegram webhook",
        schemaVersion: "1.0.0",
        workflowVersion: 1,
        nodes: [
          {
            id: "trigger",
            type: "telegram_trigger",
            name: "TG",
            position: { x: 0, y: 0 },
            config: { path: "telegram-events", signingSecretRef: { secretId: tgSecret.secretId } }
          },
          {
            id: "out",
            type: "output",
            name: "out",
            position: { x: 200, y: 0 },
            config: { outputKey: "result" }
          }
        ],
        edges: [{ id: "e1", source: "trigger", target: "out" }]
      }
    });

    const good = await ctx.app.inject({
      method: "POST",
      url: "/api/webhooks/telegram/wf-tg",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "shared-secret-token-1234"
      },
      payload: { update_id: 1, message: { text: "hi" } }
    });
    expect(good.statusCode).toBe(200);

    const bad = await ctx.app.inject({
      method: "POST",
      url: "/api/webhooks/telegram/wf-tg",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "wrong"
      },
      payload: { update_id: 1 }
    });
    expect(bad.statusCode).toBe(401);
  });
});

describe("Phase 3.2 — Discord Ed25519 signature validation", () => {
  it("accepts a valid Ed25519-signed interaction and replies to PING", async () => {
    const ctx = await createTestContext();
    const cookie = await loginAdmin(ctx);

    // Generate a brand-new Ed25519 keypair for the test.
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const publicDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    // The last 32 bytes of the SPKI DER are the raw public key.
    const rawPublicKey = publicDer.slice(publicDer.length - 32).toString("hex");

    await ctx.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: { cookie },
      payload: {
        id: "wf-dc",
        name: "Discord interactions",
        schemaVersion: "1.0.0",
        workflowVersion: 1,
        nodes: [
          {
            id: "trigger",
            type: "discord_trigger",
            name: "Discord",
            position: { x: 0, y: 0 },
            config: { path: "discord-interactions", publicKey: rawPublicKey }
          },
          {
            id: "out",
            type: "output",
            name: "out",
            position: { x: 200, y: 0 },
            config: { outputKey: "result" }
          }
        ],
        edges: [{ id: "e1", source: "trigger", target: "out" }]
      }
    });

    const body = JSON.stringify({ type: 1 });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = crypto
      .sign(null, Buffer.concat([Buffer.from(timestamp, "utf8"), Buffer.from(body, "utf8")]), privateKey)
      .toString("hex");

    const good = await ctx.app.inject({
      method: "POST",
      url: "/api/webhooks/discord/wf-dc",
      headers: {
        "content-type": "application/json",
        "x-signature-ed25519": signature,
        "x-signature-timestamp": timestamp
      },
      payload: body
    });
    expect(good.statusCode).toBe(200);
    // Ping must get {type: 1} back so Discord registers the endpoint.
    expect((good.json() as { type: number }).type).toBe(1);

    const tampered = await ctx.app.inject({
      method: "POST",
      url: "/api/webhooks/discord/wf-dc",
      headers: {
        "content-type": "application/json",
        "x-signature-ed25519": signature,
        "x-signature-timestamp": timestamp
      },
      payload: JSON.stringify({ type: 1, extra: "tampered" })
    });
    expect(tampered.statusCode).toBe(401);
  });
});

describe("Phase 3.2 — logo files exist for every Tier 2 integration", () => {
  it("every logoPath in the integrations list corresponds to a real file", async () => {
    const ctx = await createTestContext();
    const cookie = await loginAdmin(ctx);
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/integrations",
      headers: { cookie }
    });
    const { integrations } = response.json() as {
      integrations: Array<{ id: string; logoPath: string }>;
    };
    const webPublicDir = path.resolve(__dirname, "../../web/public");
    for (const integration of integrations) {
      const filePath = path.join(webPublicDir, integration.logoPath);
      expect(
        fs.existsSync(filePath),
        `missing logo file ${filePath} (integration=${integration.id})`
      ).toBe(true);
    }
  });
});
