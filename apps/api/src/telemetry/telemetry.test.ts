import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemorySpanExporter, type ReadableSpan, type SpanProcessor } from "@ai-orchestrator/otel";
import { createApp } from "../app.js";
import { parseConfig } from "../config.js";
import type { Store } from "../db/store.js";
import { AuthService } from "../services/auth-service.js";
import { SecretService } from "../services/secret-service.js";
import { openTestStore } from "../test-support/test-store.js";

const INBOUND_TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const INBOUND_SPAN = "00f067aa0ba902b7";
const INBOUND = `00-${INBOUND_TRACE}-${INBOUND_SPAN}-01`;
const ADMIN = { email: "otel-admin@example.com", password: "otel-admin-password" };

interface Context {
  app: FastifyInstance;
  store: Store;
  tempDir: string;
  exporter: InMemorySpanExporter;
  logs: Array<Record<string, unknown>>;
}

const contexts: Context[] = [];

/** Hands each ended span to the in-memory exporter at once. */
function collectInto(exporter: InMemorySpanExporter): SpanProcessor {
  return {
    onStart: () => undefined,
    onEnd: (span) => exporter.export([span], () => undefined),
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve()
  };
}

async function start(env: Record<string, string> = {}, setup?: (app: FastifyInstance) => void): Promise<Context> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-otel-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  const config = parseConfig({
    LOG_LEVEL: "info",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "sync"),
    ...env
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  await authService.bootstrapAdmin(ADMIN.email, ADMIN.password);
  const exporter = new InMemorySpanExporter();
  const logs: Array<Record<string, unknown>> = [];
  const app = await createApp(config, store, secretService, authService, undefined, undefined, undefined, {
    telemetrySpanProcessors: [collectInto(exporter)],
    telemetryRegisterGlobals: false,
    logStream: {
      write(line: string) {
        try {
          logs.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // not JSON
        }
      }
    }
  });
  setup?.(app);
  await app.ready();
  const context = { app, store, tempDir, exporter, logs };
  contexts.push(context);
  return context;
}

afterEach(async () => {
  while (contexts.length > 0) {
    const context = contexts.pop()!;
    await context.app.close();
    await context.store.close();
    fs.rmSync(context.tempDir, { recursive: true, force: true });
  }
});

async function signIn(context: Context): Promise<string> {
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: ADMIN });
  expect(response.statusCode).toBe(200);
  const cookie = [response.headers["set-cookie"]].flat().find((value) => typeof value === "string" && value.startsWith("ao_session="));
  return String(cookie).split(";")[0]!;
}

function serverSpans(context: Context, route: string): ReadableSpan[] {
  return context.exporter.getFinishedSpans().filter((span) => span.attributes["http.route"] === route);
}

function onlyServerSpan(context: Context, route: string): ReadableSpan {
  const spans = serverSpans(context, route);
  expect(spans).toHaveLength(1);
  return spans[0]!;
}

const TRACING = { TRACING_ENABLED: "true" };

describe("HTTP server spans", () => {
  it("records one SERVER span per request with the stable HTTP attribute names, and none for /health and /metrics", async () => {
    const context = await start(TRACING);
    const response = await context.app.inject({ method: "GET", url: "/api/workflows?code=sensitive-oauth-code" });
    expect(response.statusCode).toBe(401);
    await context.app.inject({ method: "GET", url: "/health" });
    await context.app.inject({ method: "GET", url: "/metrics" });
    await context.app.inject({ method: "GET", url: "/no/such/route" });

    const span = onlyServerSpan(context, "/api/workflows");
    expect(span.name).toBe("GET /api/workflows");
    expect(span.attributes).toMatchObject({
      "http.request.method": "GET",
      "http.route": "/api/workflows",
      "url.path": "/api/workflows",
      "url.scheme": "http",
      "http.response.status_code": 401
    });
    expect(typeof span.attributes["client.address"]).toBe("string");
    expect(typeof span.attributes["l2m.request.id"]).toBe("string");
    // The old names are gone, and the query (which may hold an auth code) is never recorded.
    for (const old of ["http.method", "http.status_code", "http.target", "net.peer.ip"]) expect(span.attributes[old]).toBeUndefined();
    expect(JSON.stringify(context.exporter.getFinishedSpans().map((s) => s.attributes))).not.toContain("sensitive-oauth-code");

    const names = context.exporter.getFinishedSpans().map((s) => s.name);
    expect(names).toEqual(["GET /api/workflows", "GET"]);
  });

  it("makes the server span the active context of the handler, and puts trace ids on log lines", async () => {
    const context = await start(TRACING, (app) => {
      app.get("/api/otel-probe", async (request) => {
        request.log.info("from the request logger");
        app.log.info("from the app logger");
        return { ok: true };
      });
    });
    await context.app.inject({ method: "GET", url: "/api/otel-probe" });
    const span = onlyServerSpan(context, "/api/otel-probe");
    const traceId = span.spanContext().traceId;
    const spanId = span.spanContext().spanId;

    const requestLine = context.logs.find((line) => line.msg === "from the request logger");
    expect(requestLine).toMatchObject({ trace_id: traceId, span_id: spanId });
    // The mixin adds the active span's ids to lines of loggers that carry none: proof the handler ran in the span.
    const appLine = context.logs.find((line) => line.msg === "from the app logger");
    expect(appLine).toMatchObject({ trace_id: traceId, span_id: spanId, trace_flags: "01" });
    // Fastify's own completion line goes through the request logger too.
    const completed = context.logs.find((line) => line.msg === "request completed" && line.trace_id === traceId);
    expect(completed).toBeDefined();
  });

  it("marks a 5xx response as an error", async () => {
    const context = await start(TRACING, (app) => {
      app.get("/api/otel-fail", async () => {
        throw new Error("handler failed");
      });
    });
    const response = await context.app.inject({ method: "GET", url: "/api/otel-fail" });
    expect(response.statusCode).toBe(500);
    const span = onlyServerSpan(context, "/api/otel-fail");
    expect(span.status.code).toBe(2);
    expect(span.attributes["error.type"]).toBe("500");
  });

  it("installs no hooks with OTEL_HTTP_SERVER_SPANS=false", async () => {
    const context = await start({ ...TRACING, OTEL_HTTP_SERVER_SPANS: "false" });
    await context.app.inject({ method: "GET", url: "/api/workflows" });
    expect(context.exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("records nothing and adds no trace ids while tracing is off", async () => {
    const context = await start({}, (app) => {
      app.get("/api/otel-probe", async (request) => {
        request.log.info("off probe");
        return { ok: true };
      });
    });
    await context.app.inject({ method: "GET", url: "/api/otel-probe", headers: { traceparent: INBOUND } });
    expect(context.exporter.getFinishedSpans()).toHaveLength(0);
    expect(context.logs.some((line) => "trace_id" in line)).toBe(false);
    const cookie = await signIn(context);
    const observability = (await context.app.inject({ method: "GET", url: "/api/observability", headers: { cookie } })).json() as {
      tracing: { enabled: boolean; tracesEndpoint: string | null; httpServerSpans: boolean };
    };
    expect(observability.tracing).toMatchObject({ enabled: false, tracesEndpoint: null, httpServerSpans: false });
  });
});

describe("inbound traceparent trust (L2M_OTEL_TRUST_INBOUND)", () => {
  it("starts a new, linked trace for an anonymous caller (the default)", async () => {
    const context = await start(TRACING);
    await context.app.inject({ method: "GET", url: "/api/workflows", headers: { traceparent: INBOUND } });
    const span = onlyServerSpan(context, "/api/workflows");
    expect(span.spanContext().traceId).not.toBe(INBOUND_TRACE);
    expect(span.parentSpanContext).toBeUndefined();
    expect(span.links.map((link) => link.context.spanId)).toEqual([INBOUND_SPAN]);
  });

  it("does not let an anonymous caller switch sampling off", async () => {
    const context = await start(TRACING);
    await context.app.inject({ method: "GET", url: "/api/workflows", headers: { traceparent: `00-${INBOUND_TRACE}-${INBOUND_SPAN}-00` } });
    expect(serverSpans(context, "/api/workflows")).toHaveLength(1);
  });

  it("treats an invalid bearer token as anonymous", async () => {
    const context = await start(TRACING);
    await context.app.inject({ method: "GET", url: "/api/workflows", headers: { traceparent: INBOUND, authorization: "Bearer ao_live_nope.nope" } });
    expect(onlyServerSpan(context, "/api/workflows").spanContext().traceId).not.toBe(INBOUND_TRACE);
  });

  it("continues the trace of a signed-in session without recording the check as the request's sign-in", async () => {
    const context = await start(TRACING);
    const cookie = await signIn(context);
    const response = await context.app.inject({ method: "GET", url: "/api/workflows", headers: { traceparent: INBOUND, cookie } });
    expect(response.statusCode).toBe(200);
    const span = onlyServerSpan(context, "/api/workflows");
    expect(span.spanContext().traceId).toBe(INBOUND_TRACE);
    expect(span.parentSpanContext?.spanId).toBe(INBOUND_SPAN);
    expect(span.links).toHaveLength(0);
  });

  it("continues the trace of an API-key caller", async () => {
    const context = await start(TRACING);
    const cookie = await signIn(context);
    const created = await context.app.inject({ method: "POST", url: "/api/auth/api-keys", headers: { cookie }, payload: { name: "otel" } });
    expect(created.statusCode).toBeLessThan(300);
    const body = created.json() as { key?: string; apiKey?: string; token?: string };
    const key = body.key ?? body.apiKey ?? body.token;
    expect(typeof key).toBe("string");
    await context.app.inject({ method: "GET", url: "/api/workflows", headers: { traceparent: INBOUND, authorization: `Bearer ${key}` } });
    expect(onlyServerSpan(context, "/api/workflows").spanContext().traceId).toBe(INBOUND_TRACE);
  });

  it("continues the trace of a connection from L2M_OTEL_TRUSTED_PROXIES", async () => {
    const context = await start({ ...TRACING, L2M_OTEL_TRUSTED_PROXIES: "127.0.0.0/8" });
    await context.app.inject({ method: "GET", url: "/api/workflows", headers: { traceparent: INBOUND } });
    expect(onlyServerSpan(context, "/api/workflows").spanContext().traceId).toBe(INBOUND_TRACE);
  });

  it("continues every caller's trace with `all`", async () => {
    const context = await start({ ...TRACING, L2M_OTEL_TRUST_INBOUND: "all" });
    await context.app.inject({ method: "GET", url: "/api/workflows", headers: { traceparent: INBOUND } });
    expect(onlyServerSpan(context, "/api/workflows").spanContext().traceId).toBe(INBOUND_TRACE);
  });

  it("links even a signed-in caller's trace with `none`", async () => {
    const context = await start({ ...TRACING, L2M_OTEL_TRUST_INBOUND: "none" });
    const cookie = await signIn(context);
    await context.app.inject({ method: "GET", url: "/api/workflows", headers: { traceparent: INBOUND, cookie } });
    const span = onlyServerSpan(context, "/api/workflows");
    expect(span.spanContext().traceId).not.toBe(INBOUND_TRACE);
    expect(span.links).toHaveLength(1);
  });

  it("ignores a malformed traceparent", async () => {
    const context = await start({ ...TRACING, L2M_OTEL_TRUST_INBOUND: "all" });
    await context.app.inject({ method: "GET", url: "/api/workflows", headers: { traceparent: "00-not-a-trace-01" } });
    const span = onlyServerSpan(context, "/api/workflows");
    expect(span.parentSpanContext).toBeUndefined();
    expect(span.links).toHaveLength(0);
  });
});

describe("/api/observability", () => {
  it("reports the tracing settings without header values", async () => {
    const context = await start({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9/",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20very-secret-collector-token",
      OTEL_SERVICE_NAME: "l2m-otel-test",
      OTEL_RESOURCE_ATTRIBUTES: "deployment.environment.name=staging"
    });
    const cookie = await signIn(context);
    const response = await context.app.inject({ method: "GET", url: "/api/observability", headers: { cookie } });
    expect(response.body).not.toContain("very-secret-collector-token");
    const body = response.json() as { tracing: Record<string, unknown> };
    expect(body.tracing).toMatchObject({
      enabled: true,
      tracesEndpoint: "http://127.0.0.1:9/v1/traces",
      protocol: "http/protobuf",
      exportHeaderNames: ["authorization"],
      sampler: "parentbased_always_on",
      httpServerSpans: true,
      trustInbound: "authenticated",
      spanDetail: "standard"
    });
    expect(body.tracing.resourceAttributes).toMatchObject({ "service.name": "l2m-otel-test", "deployment.environment.name": "staging", "telemetry.sdk.name": "opentelemetry" });
    const traces = (await context.app.inject({ method: "GET", url: "/api/observability/traces", headers: { cookie } })).json() as { spans: Array<{ operationName: string; kind: string }> };
    expect(traces.spans.some((span) => span.operationName === "GET /api/observability" && span.kind === "server")).toBe(true);
  });
});

describe("run spans and node metrics through the API", () => {
  const runnable = {
    id: "wf-otel-run",
    name: "Traced run",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      { id: "in", type: "webhook_input", name: "In", position: { x: 0, y: 0 }, config: {} },
      { id: "set", type: "set_node", name: "Set", position: { x: 200, y: 0 }, config: { assignments: [{ key: "a", valueTemplate: "1" }] } },
      { id: "out", type: "output", name: "Out", position: { x: 400, y: 0 }, config: {} },
      { id: "stray", type: "set_node", name: "Stray", position: { x: 0, y: 200 }, config: { assignments: [{ key: "b", valueTemplate: "2" }] } }
    ],
    edges: [
      { id: "e1", source: "in", target: "set" },
      { id: "e2", source: "set", target: "out" }
    ]
  };

  const nodeCount = async (context: Context): Promise<number> => {
    const metrics = (await context.app.inject({ method: "GET", url: "/metrics" })).body;
    const match = /^ao_node_execution_duration_ms_count (\d+)$/m.exec(metrics);
    return match ? Number(match[1]) : NaN;
  };

  it("puts the run span under the request's server span and the node spans under the run", async () => {
    const context = await start(TRACING);
    await context.store.upsertWorkflow(runnable as never);
    const cookie = await signIn(context);
    const response = await context.app.inject({ method: "POST", url: "/api/workflows/wf-otel-run/execute", headers: { cookie }, payload: {} });
    expect(response.statusCode, response.body).toBe(200);
    const executionId = response.json<{ executionId: string }>().executionId;

    const server = onlyServerSpan(context, "/api/workflows/:id/execute");
    const runSpan = context.exporter.getFinishedSpans().find((span) => span.name === "invoke_workflow Traced run")!;
    expect(runSpan.parentSpanContext?.spanId).toBe(server.spanContext().spanId);
    expect(runSpan.attributes).toMatchObject({
      "gen_ai.operation.name": "invoke_workflow",
      "l2m.execution.id": executionId,
      "l2m.workflow.id": "wf-otel-run",
      "l2m.project.id": "default",
      "l2m.trigger.type": "manual",
      "l2m.run.mode": "workflow",
      "l2m.replay": false,
      "l2m.run.status": "success"
    });
    const nodeSpans = context.exporter.getFinishedSpans().filter((span) => span.name.startsWith("l2m.node "));
    expect(nodeSpans.map((span) => span.attributes["l2m.node.id"]).sort()).toEqual(["in", "out", "set"]);
    expect(nodeSpans.every((span) => span.parentSpanContext?.spanId === runSpan.spanContext().spanId)).toBe(true);
    // Executed nodes are counted in ao_node_execution_duration_ms; the disconnected one is not.
    expect(await nodeCount(context)).toBe(3);
  });

  it("records node metrics and no spans while tracing is off", async () => {
    const context = await start();
    await context.store.upsertWorkflow(runnable as never);
    const cookie = await signIn(context);
    const response = await context.app.inject({ method: "POST", url: "/api/workflows/wf-otel-run/execute", headers: { cookie }, payload: {} });
    expect(response.statusCode, response.body).toBe(200);
    expect(context.exporter.getFinishedSpans()).toHaveLength(0);
    expect(await nodeCount(context)).toBe(3);
  });
});

describe("trace id on runs (v70)", () => {
  const runnable = {
    id: "wf-otel-trace-id",
    name: "Trace id run",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      { id: "in", type: "webhook_input", name: "In", position: { x: 0, y: 0 }, config: {} },
      { id: "out", type: "output", name: "Out", position: { x: 200, y: 0 }, config: {} }
    ],
    edges: [{ id: "e1", source: "in", target: "out" }]
  };
  const TEMPLATE = "https://traces.example.com/trace/{traceId}";

  async function runAndRead(env: Record<string, string>) {
    const context = await start(env);
    await context.store.upsertWorkflow(runnable as never);
    const cookie = await signIn(context);
    const response = await context.app.inject({ method: "POST", url: "/api/workflows/wf-otel-trace-id/execute", headers: { cookie }, payload: {} });
    expect(response.statusCode, response.body).toBe(200);
    const executionId = response.json<{ executionId: string }>().executionId;
    const detail = await context.app.inject({ method: "GET", url: `/api/executions/${executionId}`, headers: { cookie } });
    expect(detail.statusCode, detail.body).toBe(200);
    return { context, executionId, detail: detail.json<Record<string, unknown>>() };
  }

  it("stores the run span's trace id and returns it on run detail, with no link by default", async () => {
    const { context, detail } = await runAndRead(TRACING);
    const runSpan = context.exporter.getFinishedSpans().find((span) => span.name === "invoke_workflow Trace id run")!;
    expect(detail.traceId).toBe(runSpan.spanContext().traceId);
    expect(detail.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(detail).not.toHaveProperty("traceUrl");
  });

  it("adds a trace link when L2M_OTEL_TRACE_URL_TEMPLATE is set", async () => {
    const { detail } = await runAndRead({ ...TRACING, L2M_OTEL_TRACE_URL_TEMPLATE: TEMPLATE });
    expect(detail.traceUrl).toBe(`https://traces.example.com/trace/${String(detail.traceId)}`);
  });

  it("stores no trace id while tracing is off, and shows no link even with a template", async () => {
    const { detail } = await runAndRead({ L2M_OTEL_TRACE_URL_TEMPLATE: TEMPLATE });
    expect(detail.traceId).toBeNull();
    expect(detail).not.toHaveProperty("traceUrl");
  });

  it("a run resumed after an approval keeps the latest trace id (the resume's span)", async () => {
    const context = await start(TRACING);
    const gated = {
      id: "wf-otel-gated",
      name: "Gated trace run",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        { id: "in", type: "webhook_input", name: "In", position: { x: 0, y: 0 }, config: {} },
        { id: "gate", type: "approval_gate", name: "Gate", position: { x: 200, y: 0 }, config: { message: "Go?", approverRoles: ["admin"] } },
        { id: "out", type: "output", name: "Out", position: { x: 400, y: 0 }, config: {} },
        { id: "no", type: "output", name: "No", position: { x: 400, y: 200 }, config: {} }
      ],
      edges: [
        { id: "e1", source: "in", target: "gate" },
        { id: "e2", source: "gate", sourceHandle: "approved", target: "out" },
        { id: "e3", source: "gate", sourceHandle: "rejected", target: "no" }
      ]
    };
    await context.store.upsertWorkflow(gated as never);
    const cookie = await signIn(context);
    const first = await context.app.inject({ method: "POST", url: "/api/workflows/wf-otel-gated/execute", headers: { cookie }, payload: {} });
    expect(first.statusCode, first.body).toBe(200);
    const executionId = first.json<{ executionId: string; status: string }>().executionId;
    expect(first.json<{ status: string }>().status).toBe("waiting_approval");
    const paused = (await context.store.getExecutionHistory(executionId))?.traceId;
    expect(paused).toMatch(/^[0-9a-f]{32}$/);

    // The gate refuses the person who started the run, so a second admin decides.
    await new AuthService(context.store, 24).register({ email: "otel-approver@example.com", password: "otel-approver-password", role: "admin" });
    const login = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "otel-approver@example.com", password: "otel-approver-password" } });
    const approverCookie = String([login.headers["set-cookie"]].flat().find((value) => typeof value === "string" && value.startsWith("ao_session=")) ?? "").split(";")[0]!;
    const approved = await context.app.inject({ method: "POST", url: `/api/approvals/${executionId}/approve`, headers: { cookie: approverCookie }, payload: {} });
    expect(approved.statusCode, approved.body).toBe(200);
    const resumed = (await context.store.getExecutionHistory(executionId))?.traceId;
    expect(resumed).toMatch(/^[0-9a-f]{32}$/);
    expect(resumed).not.toBe(paused);
    const runSpans = context.exporter.getFinishedSpans().filter((span) => span.name === "invoke_workflow Gated trace run");
    expect(runSpans.map((span) => span.spanContext().traceId)).toContain(resumed);
  });

  it("a run canceled before any progress write has no trace id and the cancel still works", async () => {
    const context = await start(TRACING);
    await context.store.upsertWorkflow(runnable as never);
    const cookie = await signIn(context);
    await context.store.saveExecutionHistory({ id: "run-early-cancel", workflowId: "wf-otel-trace-id", status: "running", startedAt: new Date().toISOString() });
    const canceled = await context.app.inject({ method: "POST", url: "/api/executions/run-early-cancel/cancel", headers: { cookie }, payload: {} });
    expect(canceled.statusCode, canceled.body).toBe(200);
    const detail = await context.app.inject({ method: "GET", url: "/api/executions/run-early-cancel", headers: { cookie } });
    expect(detail.json()).toMatchObject({ status: "canceled", traceId: null });
  });

  it("refuses a template without {traceId} or a non-http URL", () => {
    expect(() => parseConfig({ SECRET_MASTER_KEY_BASE64: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=", L2M_OTEL_TRACE_URL_TEMPLATE: "https://t.example.com/" })).toThrow(/L2M_OTEL_TRACE_URL_TEMPLATE/);
    expect(() => parseConfig({ SECRET_MASTER_KEY_BASE64: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=", L2M_OTEL_TRACE_URL_TEMPLATE: "javascript:alert('{traceId}')" })).toThrow(/L2M_OTEL_TRACE_URL_TEMPLATE/);
  });
});
