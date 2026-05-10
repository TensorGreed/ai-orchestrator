/**
 * Chart node — REST integration test.
 *
 * Drives a workflow that renders a Vega-Lite chart from upstream data and
 * verifies the SVG flows through to the workflow output. Doesn't exercise
 * pdf_output (that needs Chromium installed which is gated on
 * PDF_CHROMIUM_EXECUTABLE_PATH); the chart.test.ts unit tests cover the
 * rendering path itself.
 */

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { WORKFLOW_SCHEMA_VERSION, type Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { SqliteStore } from "./db/database.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import type { AppConfig } from "./config.js";

interface Ctx {
  app: FastifyInstance;
  store: SqliteStore;
  tempDir: string;
}

const ctxs: Ctx[] = [];

afterEach(async () => {
  while (ctxs.length > 0) {
    const c = ctxs.pop()!;
    try { await c.app.close(); } catch { /* */ }
    try { c.store.close(); } catch { /* */ }
    fs.rmSync(c.tempDir, { recursive: true, force: true });
  }
});

async function makeCtx(): Promise<Ctx> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-chart-"));
  const dbPath = path.join(tempDir, "orchestrator.db");
  const store = await SqliteStore.create(dbPath);
  store.ensureDefaultProject();
  const config = makeTestConfig({ SECRET_MASTER_KEY_BASE64: Buffer.alloc(32, 9).toString("base64") });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = createApp(config, store, secretService, authService);
  await app.ready();
  authService.register({ email: "chart@example.com", password: "chart-pass-123", role: "admin" });
  const ctx = { app, store, tempDir };
  ctxs.push(ctx);
  return ctx;
}

async function adminCookie(ctx: Ctx): Promise<string> {
  const r = await ctx.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "chart@example.com", password: "chart-pass-123" }
  });
  expect(r.statusCode).toBe(200);
  const setCookie = r.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie.join("; ") : (setCookie ?? "");
  const m = raw.match(/(ao_session=[^;]+)/);
  if (!m) throw new Error("no session cookie");
  return m[1]!;
}

describe("chart node — REST integration", () => {
  it("renders a Vega-Lite spec to SVG and exposes svg + dataUrl on node output", async () => {
    const ctx = await makeCtx();
    const cookie = await adminCookie(ctx);

    // Workflow: set_node injects sample data → chart renders SVG → output passes it through
    const workflow: Workflow = {
      id: "wf-chart",
      name: "Chart",
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      workflowVersion: 1,
      nodes: [
        {
          id: "data",
          type: "set_node",
          name: "Data",
          position: { x: 0, y: 0 },
          config: {
            assignments: [
              {
                key: "rows",
                valueTemplate: '[{"category":"AWS","count":12},{"category":"Azure","count":8},{"category":"GCP","count":5}]'
              }
            ]
          }
        },
        {
          id: "chart",
          type: "chart",
          name: "Bar chart",
          position: { x: 200, y: 0 },
          config: {
            spec: {
              mark: "bar",
              encoding: {
                x: { field: "category", type: "nominal" },
                y: { field: "count", type: "quantitative" }
              }
            },
            dataPath: "rows",
            width: 320,
            height: 200,
            outputKey: "keysByCloud"
          }
        },
        {
          id: "out",
          type: "output",
          name: "Out",
          position: { x: 400, y: 0 },
          config: { outputKey: "keysByCloud" }
        }
      ],
      edges: [
        { id: "e1", source: "data", target: "chart" },
        { id: "e2", source: "chart", target: "out" }
      ]
    };

    const upsert = await ctx.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: { cookie },
      payload: workflow
    });
    expect(upsert.statusCode).toBe(200);

    const exec = await ctx.app.inject({
      method: "POST",
      url: `/api/workflows/${workflow.id}/execute`,
      headers: { cookie },
      payload: {}
    });
    expect(exec.statusCode).toBe(200);

    const body = exec.json() as {
      status: string;
      nodeResults: Array<{ nodeId: string; output?: { svg?: string; dataUrl?: string; keysByCloud?: { svg?: string } } }>;
    };
    expect(body.status).toBe("success");

    const chartNode = body.nodeResults.find((n) => n.nodeId === "chart");
    expect(chartNode).toBeDefined();
    expect(typeof chartNode!.output!.svg).toBe("string");
    expect(chartNode!.output!.svg!.startsWith("<svg")).toBe(true);
    expect(chartNode!.output!.dataUrl!.startsWith("data:image/svg+xml;base64,")).toBe(true);
    // Custom outputKey should also be set
    expect(typeof chartNode!.output!.keysByCloud!.svg).toBe("string");
    // Data made it into the chart
    expect(chartNode!.output!.svg).toMatch(/AWS/);
    expect(chartNode!.output!.svg).toMatch(/Azure/);
  });

  it("chart node fails with a clear error when given a malformed spec", async () => {
    const ctx = await makeCtx();
    const cookie = await adminCookie(ctx);
    const workflow: Workflow = {
      id: "wf-chart-bad",
      name: "BadChart",
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      workflowVersion: 1,
      nodes: [
        {
          id: "chart",
          type: "chart",
          name: "Bad",
          position: { x: 0, y: 0 },
          config: { spec: { mark: "definitely-not-a-mark-type" } }
        },
        { id: "out", type: "output", name: "Out", position: { x: 200, y: 0 }, config: { outputKey: "result" } }
      ],
      edges: [{ id: "e1", source: "chart", target: "out" }]
    };
    const upsert = await ctx.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: { cookie },
      payload: workflow
    });
    expect(upsert.statusCode).toBe(200);

    const exec = await ctx.app.inject({
      method: "POST",
      url: `/api/workflows/${workflow.id}/execute`,
      headers: { cookie },
      payload: {}
    });
    // Either 400 status from execute, or the chart node itself is marked error
    const body = exec.json() as {
      status: string;
      nodeResults: Array<{ nodeId: string; status?: string; error?: string }>;
    };
    const chartNode = body.nodeResults.find((n) => n.nodeId === "chart");
    expect(chartNode).toBeDefined();
    expect(chartNode!.status).toBe("error");
  });
});

function makeTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    LOG_LEVEL: "error",
    API_PORT: 0,
    API_HOST: "127.0.0.1",
    WEB_ORIGIN: "http://localhost:5173",
    API_BODY_LIMIT_BYTES: 10 * 1024 * 1024,
    WORKFLOW_EXECUTION_TIMEOUT_MS: 30_000,
    EXECUTION_HISTORY_RETENTION_DAYS: 30,
    EXECUTION_HISTORY_PRUNE_INTERVAL_MS: 3600_000,
    SEED_SAMPLE_WORKFLOWS: false,
    SECRET_MASTER_KEY_BASE64: undefined,
    SESSION_COOKIE_NAME: "ao_session",
    SESSION_TTL_HOURS: 168,
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
    MFA_ISSUER: "ai-orchestrator",
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
    EXTERNAL_SECRETS_CACHE_TTL_MS: 300_000,
    AUDIT_LOG_ENABLED: true,
    AUDIT_LOG_RETENTION_DAYS: 365,
    AUDIT_LOG_PRUNE_INTERVAL_MS: 3600_000,
    AUDIT_EXPORT_ENABLED: false,
    AUDIT_EXPORT_CHECK_INTERVAL_MS: 60000,
    AUDIT_EXPORT_BATCH_SIZE: 500,
    AUDIT_EXPORT_FILE_ROOT: "apps/api/data",
    LOG_STREAM_ENABLED: false,
    LOG_STREAM_FLUSH_INTERVAL_MS: 2000,
    LOG_STREAM_BUFFER_SIZE: 1000,
    LOG_STREAM_RETRY_MAX_ATTEMPTS: 3,
    LOG_STREAM_EVENT_RETENTION_DAYS: 14,
    LOG_STREAM_EVENT_PRUNE_INTERVAL_MS: 3600_000,
    GIT_SYNC_ENABLED: false,
    GIT_SYNC_WORKDIR: "data/git",
    GIT_BIN: "git",
    GIT_COMMAND_TIMEOUT_MS: 60_000,
    WORKFLOW_VERSION_RETENTION: 100,
    METRICS_ENABLED: true,
    METRICS_PREFIX: "ao",
    METRICS_INCLUDE_PROCESS: true,
    METRICS_SLO_SUCCESS_TARGET: 0.99,
    METRICS_SLO_P95_LATENCY_MS: 30000,
    TRACING_ENABLED: false,
    TRACING_ENDPOINT: undefined,
    TRACING_SERVICE_NAME: "ai-orchestrator",
    OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: undefined,
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: undefined,
    OTEL_EXPORTER_OTLP_HEADERS: "",
    OTEL_SERVICE_NAME: undefined,
    OTEL_SERVICE_VERSION: undefined,
    OTEL_DEPLOYMENT_ENVIRONMENT: undefined,
    OTEL_RESOURCE_ATTRIBUTES: "",
    OTEL_METRICS_ENABLED: false,
    OTEL_METRICS_PUSH_INTERVAL_MS: 60000,
    OTEL_HTTP_SERVER_SPANS: false,
    LLM_PRICING_OVERRIDES_JSON: "",
    USAGE_EVENTS_RETENTION_DAYS: 365,
    EVAL_JUDGE_ENABLED: false,
    EVAL_JUDGE_PROVIDER_ID: "openai",
    EVAL_JUDGE_MODEL: "gpt-4o-mini",
    EVAL_JUDGE_TEMPERATURE: 0,
    EVAL_JUDGE_MAX_TOKENS: 512,
    WORKER_MODE: "all",
    HA_ENABLED: false,
    HA_INSTANCE_ID: undefined,
    HA_LEASE_TTL_MS: 30_000,
    HA_RENEW_INTERVAL_MS: 10_000,
    NOTIFICATIONS_ENABLED: false,
    NOTIFICATION_SMTP_HOST: undefined,
    NOTIFICATION_SMTP_PORT: 587,
    NOTIFICATION_SMTP_SECURE: false,
    NOTIFICATION_SMTP_USER: undefined,
    NOTIFICATION_SMTP_PASS: undefined,
    NOTIFICATION_EMAIL_FROM: undefined,
    NOTIFICATION_EMAIL_TO: undefined,
    NOTIFICATION_SLACK_WEBHOOK_URL: undefined,
    NOTIFICATION_TEAMS_WEBHOOK_URL: undefined,
    RATE_LIMIT_ENABLED: false,
    RATE_LIMIT_GLOBAL_MAX: 600,
    RATE_LIMIT_GLOBAL_WINDOW_MS: 60000,
    RATE_LIMIT_AUTH_MAX: 10,
    RATE_LIMIT_AUTH_WINDOW_MS: 60000,
    RATE_LIMIT_WEBHOOK_MAX: 120,
    RATE_LIMIT_WEBHOOK_WINDOW_MS: 60000,
    HELMET_ENABLED: true,
    HELMET_HSTS_ENABLED: false,
    HELMET_CSP_ENABLED: false,
    COMMUNITY_NODES_ENABLED: false,
    COMMUNITY_NODES_DIR: "./data/plugins",
    COMMUNITY_NODES_ALLOWLIST: "",
    ...overrides
  } as AppConfig;
}
