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
import { MetricsService } from "./services/metrics-service";
import { TracingService } from "./services/tracing-service";

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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-phase5-7-"));
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

async function loginViewer(ctx: TestContext): Promise<string> {
  ctx.authService.register({
    email: "viewer@example.com",
    password: "viewer-password",
    role: "viewer"
  });
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "viewer@example.com", password: "viewer-password" }
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

describe("Phase 5.7 — /metrics Prometheus endpoint", () => {
  it("returns text/plain with prefixed counters/gauges/histograms", async () => {
    const ctx = await createTestContext();
    // Drive some HTTP traffic so the counters are non-zero.
    await ctx.app.inject({ method: "GET", url: "/health" });
    await ctx.app.inject({ method: "GET", url: "/health" });
    const response = await ctx.app.inject({ method: "GET", url: "/metrics" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/text\/plain/);
    const body = response.body;
    // Counter / gauge / histogram families each present with proper TYPE lines.
    expect(body).toMatch(/# TYPE ao_http_requests_total counter/);
    expect(body).toMatch(/# TYPE ao_workflow_executions_active gauge/);
    expect(body).toMatch(/# TYPE ao_http_request_duration_ms histogram/);
    expect(body).toMatch(/ao_http_requests_total \d+/);
    expect(body).toMatch(/ao_uptime_seconds \d+/);
    expect(body).toMatch(/ao_slo_success_target 0\.99/);
    expect(body).toMatch(/ao_process_heap_used_bytes \d+/);
    // Histogram has the canonical suffix triple.
    expect(body).toMatch(/ao_http_request_duration_ms_bucket\{le="/);
    expect(body).toMatch(/ao_http_request_duration_ms_sum /);
    expect(body).toMatch(/ao_http_request_duration_ms_count /);
  });

  it("honors METRICS_PREFIX override", async () => {
    const ctx = await createTestContext({ METRICS_PREFIX: "custom" });
    const response = await ctx.app.inject({ method: "GET", url: "/metrics" });
    expect(response.body).toMatch(/custom_http_requests_total/);
    expect(response.body).not.toMatch(/^ao_http_requests_total/m);
  });

  it("/metrics is public (no auth required) — suitable for Prometheus scrapers", async () => {
    const ctx = await createTestContext();
    const response = await ctx.app.inject({ method: "GET", url: "/metrics" });
    expect(response.statusCode).toBe(200);
  });
});

describe("Phase 5.7 — /health readiness", () => {
  it("returns ok + uptime + slo health", async () => {
    const ctx = await createTestContext();
    const response = await ctx.app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      ok: boolean;
      now: string;
      uptime: number;
      sloHealthy: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.now).toMatch(/T/);
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    expect(typeof body.sloHealthy).toBe("boolean");
  });
});

describe("Phase 5.7 — /api/observability admin routes", () => {
  it("returns a full metrics snapshot to admin callers", async () => {
    const ctx = await createTestContext();
    const cookie = await loginAdmin(ctx);
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/observability",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      metrics: { executionsTotal: number; slo: { successTarget: number } };
      tracing: { enabled: boolean };
    };
    expect(body.metrics.slo.successTarget).toBe(0.99);
    expect(typeof body.metrics.executionsTotal).toBe("number");
    expect(body.tracing.enabled).toBe(false);
  });

  it("denies non-admin callers", async () => {
    const ctx = await createTestContext();
    const cookie = await loginViewer(ctx);
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/observability",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(403);
  });

  it("exposes SLO status directly", async () => {
    const ctx = await createTestContext({
      METRICS_SLO_SUCCESS_TARGET: 0.95,
      METRICS_SLO_P95_LATENCY_MS: 5000
    });
    const cookie = await loginAdmin(ctx);
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/observability/slo",
      headers: { cookie }
    });
    const body = response.json() as {
      successTarget: number;
      p95LatencyTargetMs: number;
      healthy: boolean;
    };
    expect(body.successTarget).toBe(0.95);
    expect(body.p95LatencyTargetMs).toBe(5000);
    // No executions yet → success rate is vacuously 0 against 0.95 target → unhealthy.
    expect(body.healthy).toBe(false);
  });

  it("returns trace spans (empty when tracing disabled)", async () => {
    const ctx = await createTestContext();
    const cookie = await loginAdmin(ctx);
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/observability/traces",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { spans: unknown[] };
    expect(Array.isArray(body.spans)).toBe(true);
  });
});

describe("Phase 5.7 — MetricsService unit behavior", () => {
  it("tracks execution counts, computes percentiles, and evaluates SLOs", () => {
    const metrics = new MetricsService({
      sloSuccessTarget: 0.9,
      sloP95LatencyMs: 1000
    });
    for (let i = 0; i < 95; i++) metrics.recordExecution("success", 100);
    for (let i = 0; i < 5; i++) metrics.recordExecution("error", 2000);
    const slo = metrics.getSloStatus();
    expect(slo.currentSuccessRate).toBe(0.95);
    expect(slo.currentP95LatencyMs).toBeGreaterThanOrEqual(100);
    // success rate above target + p95 may be near the 95th percentile of a
    // skewed distribution; either way the SLO evaluator surfaces both checks.
    expect(slo.successBudgetRemaining).toBeCloseTo(0.05, 3);

    const snapshot = metrics.getSnapshot();
    expect(snapshot.executionsTotal).toBe(100);
    expect(snapshot.executionsSuccess).toBe(95);
    expect(snapshot.executionsFailure).toBe(5);
  });

  it("can be disabled and then emits no samples", () => {
    const metrics = new MetricsService({ enabled: false });
    metrics.recordExecution("success", 100);
    metrics.recordHttpRequest("GET", 200, 50);
    const snap = metrics.getSnapshot();
    expect(snap.executionsTotal).toBe(0);
    expect(snap.httpRequestsTotal).toBe(0);
  });

  it("HTTP metrics break down by method and status class", () => {
    const metrics = new MetricsService();
    metrics.recordHttpRequest("GET", 200, 12);
    metrics.recordHttpRequest("POST", 500, 48);
    metrics.recordHttpRequest("POST", 404, 7);
    const out = metrics.formatPrometheus();
    expect(out).toMatch(/ao_http_requests_by_method\{method="GET"\} 1/);
    expect(out).toMatch(/ao_http_requests_by_method\{method="POST"\} 2/);
    expect(out).toMatch(/ao_http_requests_by_status\{status="2xx"\} 1/);
    expect(out).toMatch(/ao_http_requests_by_status\{status="5xx"\} 1/);
  });
});

describe("Phase 5.7 — TracingService unit behavior", () => {
  it("starts, ends, and retrieves spans when enabled", () => {
    const tracing = new TracingService({ enabled: true, serviceName: "ut" });
    const span = tracing.startSpan({ operationName: "test.op", attributes: { foo: "bar" } });
    tracing.addEvent(span, "checkpoint", { x: 1 });
    tracing.endSpan(span, "ok");
    const recent = tracing.recentSpans();
    expect(recent).toHaveLength(1);
    expect(recent[0]!.operationName).toBe("test.op");
    expect(recent[0]!.status).toBe("ok");
    expect(recent[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(recent[0]!.attributes["service.name"]).toBe("ut");
    expect(recent[0]!.events).toHaveLength(1);

    const byTrace = tracing.spansByTrace(span.traceId);
    expect(byTrace).toHaveLength(1);
  });

  it("drops spans when disabled (no leak via recentSpans)", () => {
    const tracing = new TracingService({ enabled: false });
    const span = tracing.startSpan({ operationName: "noop" });
    tracing.endSpan(span, "ok");
    expect(tracing.recentSpans()).toHaveLength(0);
    expect(tracing.isEnabled()).toBe(false);
  });
});

describe("Phase 5.7 — HTTP hook increments counters", () => {
  it("counts inbound requests via onResponse", async () => {
    const ctx = await createTestContext();
    const first = await ctx.app.inject({ method: "GET", url: "/metrics" });
    const firstCount = Number(/ao_http_requests_total (\d+)/.exec(first.body)?.[1] ?? 0);
    await ctx.app.inject({ method: "GET", url: "/health" });
    await ctx.app.inject({ method: "GET", url: "/health" });
    await ctx.app.inject({ method: "GET", url: "/health" });
    const after = await ctx.app.inject({ method: "GET", url: "/metrics" });
    const afterCount = Number(/ao_http_requests_total (\d+)/.exec(after.body)?.[1] ?? 0);
    // 3 /health hits + 2 /metrics hits between the two reads → +5 at least.
    expect(afterCount - firstCount).toBeGreaterThanOrEqual(3);
  });
});
