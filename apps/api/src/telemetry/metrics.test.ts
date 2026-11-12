import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { LEGACY_METRIC_NAMES } from "@ai-orchestrator/otel";
import { createApp } from "../app.js";
import { parseConfig } from "../config.js";
import type { Store } from "../db/store.js";
import { AuthService } from "../services/auth-service.js";
import { MetricsService } from "../services/metrics-service.js";
import { SecretService } from "../services/secret-service.js";
import { openTestStore } from "../test-support/test-store.js";
import { loadTelemetry } from "./load.js";
import { resolveTelemetrySettings } from "./settings.js";

const BASE = { SECRET_MASTER_KEY_BASE64: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" };
const settings = (env: Record<string, string>) => resolveTelemetrySettings(parseConfig({ ...BASE, ...env }));

interface Received {
  path: string;
  body: string;
}

async function sink() {
  const received: Received[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({ path: request.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { received, base, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close();
});

describe("metrics-only endpoint (tracing off)", () => {
  it("resolves the metrics export without turning tracing on", () => {
    const resolved = settings({ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://collector:4318/v1/metrics", OTEL_METRICS_ENABLED: "true", OTEL_METRICS_PUSH_INTERVAL_MS: "15000" });
    expect(resolved).toMatchObject({ enabled: false, tracesEndpoint: null, metricsEndpoint: "http://collector:4318/v1/metrics", metricsIntervalMs: 15_000 });
  });

  it("still needs OTEL_METRICS_ENABLED (an endpoint alone exports nothing)", () => {
    expect(settings({ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://collector:4318/v1/metrics" }).metricsEndpoint).toBeNull();
  });

  it("rejects grpc and a malformed endpoint for the metrics it is about to export", () => {
    const on = { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://collector:4318/v1/metrics", OTEL_METRICS_ENABLED: "true" };
    expect(() => settings({ ...on, OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" })).toThrow(/grpc is not shipped/);
    expect(() => settings({ ...on, OTEL_EXPORTER_OTLP_PROTOCOL: "grpc", OTEL_SDK_DISABLED: "true" })).not.toThrow();
    expect(() => settings({ OTEL_METRICS_ENABLED: "true", OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" })).not.toThrow();
  });

  it("loads a metrics pipeline and no tracing runtime", async () => {
    const telemetry = await loadTelemetry(
      settings({ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://127.0.0.1:9/v1/metrics", OTEL_METRICS_ENABLED: "true" }),
      { registerGlobals: false }
    );
    expect(telemetry.enabled).toBe(false);
    expect(telemetry.runtime).toBeNull();
    expect(telemetry.metrics).not.toBeNull();
    await telemetry.metrics?.shutdown();
  });

  it("loads nothing when metrics are not exported", async () => {
    const telemetry = await loadTelemetry(settings({}));
    expect(telemetry.metrics).toBeNull();
    expect(telemetry.runtime).toBeNull();
  });
});

describe("API with only a metrics endpoint", () => {
  it("pushes the ao.* metrics (and the histograms) on close, and sends no spans", async () => {
    const collector = await sink();
    open.push(collector.close);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-otel-metrics-"));
    const store: Store = await openTestStore(path.join(tempDir, "orchestrator.db"));
    const config = parseConfig({
      ...BASE,
      LOG_LEVEL: "error",
      SEED_SAMPLE_WORKFLOWS: "false",
      COOKIE_SECURE: "false",
      RATE_LIMIT_ENABLED: "false",
      MCP_PROBE_INTERVAL_MS: "0",
      GIT_SYNC_WORKDIR: path.join(tempDir, "sync"),
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${collector.base}/v1/metrics`,
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
      OTEL_METRICS_ENABLED: "true",
      OTEL_METRICS_PUSH_INTERVAL_MS: "3600000"
    });
    const app: FastifyInstance = await createApp(
      config,
      store,
      new SecretService(store, config.SECRET_MASTER_KEY_BASE64),
      new AuthService(store, config.SESSION_TTL_HOURS),
      undefined,
      undefined,
      undefined,
      { logStream: { write() {} }, telemetryRegisterGlobals: false }
    );
    open.push(async () => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });
    await app.ready();
    for (let i = 0; i < 3; i += 1) await app.inject({ method: "GET", url: "/health" });
    await app.close();
    await store.close();

    expect(collector.received.every((entry) => entry.path === "/v1/metrics")).toBe(true);
    const text = collector.received.map((entry) => entry.body).join("\n");
    for (const name of LEGACY_METRIC_NAMES) expect(text).toContain(name);
    expect(text).toContain('"ao.http.request.duration"');
    expect(text).toContain("http.response.status_class");
  }, 30_000);
});

describe("MetricsService histograms hook", () => {
  it("forwards executions and HTTP requests to an attached recorder, and only then", () => {
    const calls: string[] = [];
    const service = new MetricsService();
    service.recordExecution("success", 10);
    service.attachOtelRecorder({
      recordExecution: (status, ms) => calls.push(`exec:${status}:${ms}`),
      recordHttpRequest: (method, status, ms) => calls.push(`http:${method}:${status}:${ms}`)
    });
    service.recordExecution("error", 20);
    service.recordHttpRequest("GET", 200, 5);
    expect(calls).toEqual(["exec:error:20", "http:GET:200:5"]);
    expect(service.getSnapshot().executionsTotal).toBe(2);
  });

  it("does not forward while metrics are disabled", () => {
    const calls: string[] = [];
    const service = new MetricsService({ enabled: false });
    service.attachOtelRecorder({ recordExecution: () => calls.push("x"), recordHttpRequest: () => calls.push("y") });
    service.recordExecution("success", 1);
    service.recordHttpRequest("GET", 200, 1);
    expect(calls).toEqual([]);
  });
});
