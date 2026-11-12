/**
 * Model-call spans and metrics (the instrumented provider and embedding registries), collected with the real
 * OpenTelemetry SDK in memory: `chat` spans inside an agent loop and an LLM Call node, /v1 chat (streaming and not) and
 * embeddings under the gateway's HTTP span, failures by type only, a budget refusal (no model call), the GenAI and
 * cost metrics, and the off path (nothing wrapped). The upstream is an in-process OpenAI-compatible server on
 * 127.0.0.1; no model server is called.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { DefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { MCPRegistry, MockMCPServerAdapter } from "@ai-orchestrator/mcp-sdk";
import {
  AggregationTemporality,
  createOtelRuntime,
  DEFAULT_BATCH_OPTIONS,
  InMemoryMetricExporter,
  InMemorySpanExporter,
  PeriodicExportingMetricReader,
  type OtelRuntime,
  type OtelRuntimeOptions,
  type ReadableSpan,
  type ResourceMetrics,
  type SpanProcessor
} from "@ai-orchestrator/otel";
import {
  createDefaultEmbeddingRegistry,
  createDefaultProviderRegistry,
  createInstrumentedProviderRegistry,
  ProviderRegistry,
  type LLMProviderAdapter,
  type ProviderCallRequest
} from "@ai-orchestrator/provider-sdk";
import { NOOP_RUN_INSTRUMENTATION, type LLMCallResponse, type MCPServerConfig, type Workflow, type WorkflowEdge, type WorkflowNode } from "@ai-orchestrator/shared";
import { describeRunResult, executeWorkflow, type WorkflowExecutionDependencies } from "@ai-orchestrator/workflow-engine";
import { createApp } from "../app.js";
import { parseConfig } from "../config.js";
import type { Store } from "../db/store.js";
import { AuthService } from "../services/auth-service.js";
import { SecretService } from "../services/secret-service.js";
import { openTestStore } from "../test-support/test-store.js";
import { createModelTelemetry } from "./model-telemetry.js";
import { loadTelemetry } from "./load.js";
import { resolveTelemetrySettings } from "./settings.js";

const SPAN_STATUS_ERROR = 2;
const SPAN_KIND_CLIENT = 2;
/** Planted in every prompt: it must never reach a span or a metric. */
const MARKER = "PLANTED-PROMPT-7f3a";
const UPSTREAM_KEY = "sk-upstream-otel-91c2";

function exportingAtOnce(exporter: InMemorySpanExporter): SpanProcessor {
  return {
    onStart: () => undefined,
    onEnd: (span) => exporter.export([span], () => undefined),
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve()
  };
}

function metricReader() {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
  return { exporter, reader };
}

function metricsOf(exporter: InMemoryMetricExporter) {
  const metrics = exporter.getMetrics().flatMap((resourceMetrics: ResourceMetrics) => resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics));
  const byName = new Map<string, Array<{ attributes: Record<string, unknown>; value: unknown }>>();
  for (const metric of metrics) byName.set(metric.descriptor.name, metric.dataPoints as Array<{ attributes: Record<string, unknown>; value: unknown }>);
  return byName;
}

const parentOf = (span: ReadableSpan) => span.parentSpanContext?.spanId;
const noContent = (spans: ReadableSpan[]) => {
  const recorded = JSON.stringify(spans.map((span) => [span.name, span.attributes, span.events, span.status]));
  expect(recorded).not.toContain(MARKER);
  expect(recorded).not.toContain(UPSTREAM_KEY);
};

// ---------------------------------------------------------------------------
// Engine runs: the agent loop and the LLM Call node through an instrumented registry
// ---------------------------------------------------------------------------

type Answer = (request: ProviderCallRequest) => LLMCallResponse;

class ScriptedProvider implements LLMProviderAdapter {
  readonly definition = { id: "scripted", label: "Scripted", supportsTools: true, configSchema: {} };
  constructor(private readonly answer: Answer) {}
  async generate(request: ProviderCallRequest): Promise<LLMCallResponse> {
    return this.answer(request);
  }
}

const REGISTRY_ID = "mcp_mock";
const registryConfig: MCPServerConfig = { serverId: "mock-mcp", registryServerId: REGISTRY_ID, label: "Mock", connection: {} };

const node = (id: string, type: string, config: Record<string, unknown> = {}, name = id): WorkflowNode => ({
  id,
  type: type as WorkflowNode["type"],
  name,
  position: { x: 0, y: 0 },
  config
});
const edge = (source: string, target: string, sourceHandle?: string): WorkflowEdge => ({
  id: `${source}-${sourceHandle ?? "main"}-${target}`,
  source,
  target,
  ...(sourceHandle ? { sourceHandle } : {})
});
const MODEL = { provider: { providerId: "scripted", model: "m-7", temperature: 0.1 } };

const runtimes: OtelRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
});

function tracing(overrides: Partial<OtelRuntimeOptions> = {}) {
  const exporter = new InMemorySpanExporter();
  const runtime = createOtelRuntime({
    resourceAttributes: { "service.name": "l2m-test" },
    export: null,
    sampler: { name: "parentbased_always_on" },
    propagators: ["tracecontext"],
    batch: DEFAULT_BATCH_OPTIONS,
    attributeValueLengthLimit: 8192,
    spanDetail: "standard",
    naming: "names",
    propagateToProviders: false,
    propagateToMcp: true,
    semconvOptIn: [],
    recentSpanLimit: 100,
    spanProcessors: [exportingAtOnce(exporter)],
    registerGlobals: false,
    ...overrides
  });
  runtimes.push(runtime);
  const inst = runtime.instrumentation;
  const spans = () => exporter.getFinishedSpans();
  const named = (name: string) => spans().filter((span) => span.name === name);
  const one = (name: string) => {
    const found = named(name);
    if (found.length !== 1) throw new Error(`expected one ${name}, found ${found.length}; have ${spans().map((s) => s.name).join(", ")}`);
    return found[0]!;
  };
  const run = (wf: Workflow, answer: Answer, request: Partial<Parameters<typeof executeWorkflow>[0]> = {}) => {
    const base = new ProviderRegistry();
    base.register(new ScriptedProvider(answer));
    const mcpRegistry = new MCPRegistry();
    mcpRegistry.register(new MockMCPServerAdapter());
    const deps: WorkflowExecutionDependencies = {
      providerRegistry: createInstrumentedProviderRegistry(base, { instrument: inst }),
      mcpRegistry,
      connectorRegistry: createDefaultConnectorRegistry(),
      agentRuntime: new DefaultAgentRuntime(),
      resolveSecret: async () => undefined,
      resolveRegisteredMcpServer: () => registryConfig,
      instrument: inst
    };
    return inst.run({ executionId: `exec-${wf.id}`, workflowId: wf.id, workflowName: wf.name }, async (span) => {
      const result = await executeWorkflow({ workflow: wf, executionId: `exec-${wf.id}`, ...request }, deps);
      describeRunResult(span, result);
      return result;
    });
  };
  return { spans, named, one, run };
}

const workflowOf = (id: string, nodes: WorkflowNode[], edges: WorkflowEdge[]): Workflow => ({ id, name: `Flow ${id}`, schemaVersion: "1.0.0", workflowVersion: 1, nodes, edges });

describe("model spans in runs", () => {
  it("puts an LLM Call node's chat span under its node span, with no prompt or answer on it", async () => {
    const t = tracing();
    const wf = workflowOf(
      "llm",
      [node("in", "webhook_input"), node("llm", "llm_call", { ...MODEL, promptKey: "user_prompt" }), node("out", "output")],
      [edge("in", "llm"), edge("llm", "out")]
    );
    const result = await t.run(wf, () => ({ content: `answer ${MARKER}`, toolCalls: [], finishReason: "stop", usage: { inputTokens: 11, outputTokens: 4 } }), {
      webhookPayload: { user_prompt: `question ${MARKER}` }
    });
    expect(result.status).toBe("success");
    const chat = t.one("chat m-7");
    expect(chat.kind).toBe(SPAN_KIND_CLIENT);
    expect(parentOf(chat)).toBe(t.one("l2m.node llm_call").spanContext().spanId);
    expect(chat.attributes).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "scripted",
      "l2m.provider.id": "scripted",
      "gen_ai.request.model": "m-7",
      "gen_ai.request.temperature": 0.1,
      "gen_ai.usage.input_tokens": 11,
      "gen_ai.usage.output_tokens": 4,
      "gen_ai.response.finish_reasons": ["stop"]
    });
    noContent(t.spans());
  });

  it("puts each agent-loop call under invoke_agent (standard detail) and under its turn (verbose)", async () => {
    const answer: Answer = (request) =>
      request.messages.some((message) => message.role === "tool")
        ? { content: "done", toolCalls: [] }
        : { content: "", toolCalls: [{ id: "call-1", name: "mock-mcp__get_current_time", arguments: { tz: "UTC" } }] };
    const wf = workflowOf(
      "agent",
      [
        node("hook", "webhook_input"),
        node("agent", "agent_orchestrator", { systemPromptTemplate: "Use tools.", userPromptTemplate: "{{user_prompt}}", maxIterations: 4 }, "Helper"),
        node("model", "llm_call", MODEL),
        node("tools", "mcp_tool", { registryServerId: REGISTRY_ID, toolName: "__all__" }),
        node("out", "output")
      ],
      [edge("hook", "agent"), edge("agent", "out"), edge("agent", "model", "chat_model"), edge("agent", "tools", "tool")]
    );
    const standard = tracing();
    expect((await standard.run(wf, answer, { webhookPayload: { user_prompt: MARKER } })).status).toBe("success");
    const agent = standard.one("invoke_agent Helper");
    const chats = standard.named("chat m-7");
    expect(chats).toHaveLength(2);
    expect(chats.every((span) => parentOf(span) === agent.spanContext().spanId)).toBe(true);
    noContent(standard.spans());

    const verbose = tracing({ spanDetail: "verbose" });
    expect((await verbose.run(wf, answer, { webhookPayload: { user_prompt: MARKER } })).status).toBe("success");
    const turns = verbose.named("l2m.agent.iteration");
    expect(turns).toHaveLength(2);
    const verboseChats = verbose.named("chat m-7");
    expect(verboseChats.map((span) => parentOf(span)).sort()).toEqual(turns.map((turn) => turn.spanContext().spanId).sort());
  });

  it("marks a failed model call ERROR with its type and no message", async () => {
    const t = tracing();
    const wf = workflowOf(
      "fail",
      [node("in", "webhook_input"), node("llm", "llm_call", { ...MODEL, promptKey: "user_prompt" }), node("out", "output")],
      [edge("in", "llm"), edge("llm", "out")]
    );
    const result = await t.run(
      wf,
      () => {
        throw Object.assign(new Error(`upstream echoed ${MARKER} with ${UPSTREAM_KEY}`), { category: "llm_provider_error" });
      },
      { webhookPayload: { user_prompt: "hi" } }
    );
    expect(result.status).toBe("error");
    const chats = t.named("chat m-7");
    expect(chats.length).toBeGreaterThanOrEqual(1);
    for (const chat of chats) {
      expect(chat.status.code).toBe(SPAN_STATUS_ERROR);
      expect(chat.status.message).toBeUndefined();
      expect(chat.attributes["error.type"]).toBe("llm_provider_error");
    }
    noContent(chats);
  });
});

// ---------------------------------------------------------------------------
// The API: /v1 and a workflow run, with tracing and metrics on
// ---------------------------------------------------------------------------

/** One token costs one dollar, so the second request is over a five-dollar budget. */
const PRICING = JSON.stringify({
  openai_compatible: { "up-model": { inputUsdPer1M: 1_000_000, outputUsdPer1M: 1_000_000 }, "up-embed": { inputUsdPer1M: 1_000_000, outputUsdPer1M: 0 } }
});

interface Upstream {
  baseUrl: string;
  requests: Array<{ path: string; headers: http.IncomingHttpHeaders }>;
  /** The next chat answer fails with a 400 (not retried). */
  failNext: boolean;
  close: () => Promise<void>;
}

async function startUpstream(): Promise<Upstream> {
  const upstream: Upstream = { baseUrl: "", requests: [], failNext: false, close: async () => undefined };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (part) => (raw += String(part)));
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      upstream.requests.push({ path: req.url ?? "", headers: req.headers });
      if ((req.url ?? "").endsWith("/embeddings")) {
        const inputs = body.input as string[];
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({ object: "list", data: inputs.map((_, index) => ({ index, embedding: [0.1, 0.2, 0.3, 0.4] })), model: "up-embed", usage: { prompt_tokens: 2, total_tokens: 2 } })
        );
        return;
      }
      if (upstream.failNext) {
        upstream.failNext = false;
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: `upstream refused ${MARKER}` } }));
        return;
      }
      if (body.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const frame = (delta: Record<string, unknown>, finish: string | null = null) => ({ id: "up-s", model: "up-model", choices: [{ index: 0, delta, finish_reason: finish }] });
        for (const data of [frame({ role: "assistant", content: "Hel" }), frame({ content: "lo" }), frame({}, "stop"), { id: "up-s", choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }]) {
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        }
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          id: "up-1",
          object: "chat.completion",
          model: "up-model",
          choices: [{ index: 0, message: { role: "assistant", content: "Hello." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  upstream.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  upstream.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return upstream;
}

interface Fixture {
  app: FastifyInstance;
  store: Store;
  base: string;
  admin: string;
  upstream: Upstream;
  secretId: string;
  spans: InMemorySpanExporter;
  metrics: () => Promise<ReturnType<typeof metricsOf>>;
  tempDir: string;
}

const fixtures: Fixture[] = [];
afterEach(async () => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop()!;
    await fixture.app.close();
    await fixture.upstream.close();
    try {
      await fixture.store.close();
    } catch {
      // Closed by the app's shutdown hooks.
    }
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

async function setup(env: Record<string, string> = { TRACING_ENABLED: "true" }): Promise<Fixture> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-otel-model-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "error",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "sync"),
    LLM_PRICING_OVERRIDES_JSON: PRICING,
    ...env
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const spans = new InMemorySpanExporter();
  const metricExport = metricReader();
  const app = await createApp(config, store, secretService, authService, undefined, undefined, undefined, {
    telemetrySpanProcessors: [exportingAtOnce(spans)],
    telemetryRegisterGlobals: false,
    telemetryMetricReaders: [metricExport.reader],
    logStream: { write: () => undefined }
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  await authService.register({ email: "admin@example.com", password: "Admin-Pass-123!", role: "admin" });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password: "Admin-Pass-123!" } });
  const admin = String([login.headers["set-cookie"]].flat().find((value) => String(value).startsWith(`${config.SESSION_COOKIE_NAME}=`))).split(";")[0]!;
  const upstream = await startUpstream();
  const { secretId } = await secretService.createSecret({ name: "upstream", provider: "openai_compatible", value: UPSTREAM_KEY, projectId: "default" });
  const metrics = async () => {
    await metricExport.reader.forceFlush();
    return metricsOf(metricExport.exporter);
  };
  const fixture: Fixture = { app, store, base, admin, upstream, secretId, spans, metrics, tempDir };
  fixtures.push(fixture);
  return fixture;
}

async function api<T = Record<string, unknown>>(fixture: Fixture, method: string, url: string, payload?: unknown) {
  const response = await fixture.app.inject({ method: method as "GET", url, headers: { cookie: fixture.admin }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { status: response.statusCode, body: (response.body ? response.json() : null) as T, raw: response.body };
}

/** A route set with chat route `gpt-test` and embedding route `embed-test`, granted to a new client. */
async function gateway(fixture: Fixture) {
  const set = await api<{ id: string }>(fixture, "POST", "/api/ai-gateway/route-sets", { name: "Apps", projectId: "default" });
  expect(set.status, set.raw).toBe(201);
  for (const route of [
    { alias: "gpt-test", providerId: "openai_compatible", model: "up-model" },
    { alias: "embed-test", kind: "embedding", providerId: "openai_compatible", model: "up-embed" }
  ]) {
    const created = await api(fixture, "POST", `/api/ai-gateway/route-sets/${set.body.id}/routes`, { ...route, baseUrl: fixture.upstream.baseUrl, secretRef: { secretId: fixture.secretId } });
    expect(created.status, created.raw).toBe(201);
  }
  const client = await api<{ client: { id: string }; token: string }>(fixture, "POST", "/api/mcp/clients", { name: "App", toolsetIds: [], role: "builder" });
  expect(client.status, client.raw).toBe(201);
  expect((await api(fixture, "PUT", `/api/ai-gateway/clients/${client.body.client.id}/grants`, { routeSetIds: [set.body.id] })).status).toBe(200);
  return { setId: set.body.id, clientId: client.body.client.id, token: client.body.token };
}

function v1(fixture: Fixture, token: string, pathName: string, body: unknown) {
  return fetch(`${fixture.base}${pathName}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function until<T>(read: () => T | Promise<T>, what: string, timeoutMs = 10_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const serverSpanOf = (fixture: Fixture, route: string) => until(() => fixture.spans.getFinishedSpans().find((span) => span.attributes["http.route"] === route), `the ${route} span`);
const chatSpans = (fixture: Fixture) => fixture.spans.getFinishedSpans().filter((span) => span.name === "chat up-model");

describe("/v1 model spans and metrics", () => {
  it("records a non-streaming chat as a chat span under the request's span, with the gateway's ids and the metrics", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    const response = await v1(fixture, gw.token, "/v1/chat/completions", { model: "gpt-test", temperature: 0.4, messages: [{ role: "user", content: MARKER }] });
    expect(response.status).toBe(200);
    const server = await serverSpanOf(fixture, "/v1/chat/completions");
    const [requestRow] = await fixture.store.listAiGatewayRequests({ from: "1970-01-01T00:00:00.000Z", limit: 10 });
    expect(server.attributes).toMatchObject({
      "l2m.gateway.request.id": requestRow!.id,
      "l2m.gateway.route_set.id": gw.setId,
      "l2m.gateway.route.alias": "gpt-test",
      "l2m.gateway.client.id": gw.clientId,
      "l2m.gateway.status": "ok"
    });
    const [chat] = chatSpans(fixture);
    expect(chat).toBeDefined();
    expect(parentOf(chat!)).toBe(server.spanContext().spanId);
    expect(chat!.kind).toBe(SPAN_KIND_CLIENT);
    expect(chat!.attributes).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "openai",
      "l2m.provider.id": "openai_compatible",
      "gen_ai.request.model": "up-model",
      "gen_ai.request.stream": false,
      "gen_ai.request.temperature": 0.4,
      "gen_ai.response.model": "up-model",
      "gen_ai.response.id": "up-1",
      "gen_ai.usage.input_tokens": 3,
      "gen_ai.usage.output_tokens": 4,
      "server.address": "127.0.0.1"
    });
    // Recorded once: the gateway's allowlist view and the base registry are both instrumented.
    expect(chatSpans(fixture)).toHaveLength(1);
    // Propagation to providers is off by default.
    expect(fixture.upstream.requests[0]!.headers.traceparent).toBeUndefined();
    noContent(fixture.spans.getFinishedSpans());

    const metrics = await until(async () => {
      const byName = await fixture.metrics();
      return byName.get("l2m.gen_ai.cost")?.length ? byName : null;
    }, "the cost metric");
    const tokens = metrics.get("gen_ai.client.token.usage")!;
    expect(tokens.find((point) => point.attributes["gen_ai.token.type"] === "input")?.attributes).toMatchObject({ "gen_ai.provider.name": "openai", "gen_ai.request.model": "up-model" });
    expect(metrics.get("gen_ai.client.operation.duration")).toHaveLength(1);
    // Priced where the usage row is written: 7 tokens at a dollar each.
    expect(metrics.get("l2m.gen_ai.cost")![0]).toMatchObject({ attributes: { "l2m.usage.source": "ai_gateway", "l2m.project.id": "default" }, value: requestRow!.costUsd });
    expect(requestRow!.costUsd).toBe(7);
    expect(JSON.stringify([...metrics.entries()])).not.toContain(MARKER);
  });

  it("keeps a streamed chat's span open until the stream ends and records its usage", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    const response = await v1(fixture, gw.token, "/v1/chat/completions", { model: "gpt-test", stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: MARKER }] });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("[DONE]");
    const server = await serverSpanOf(fixture, "/v1/chat/completions");
    const [chat] = chatSpans(fixture);
    expect(parentOf(chat!)).toBe(server.spanContext().spanId);
    expect(chat!.attributes).toMatchObject({
      "gen_ai.request.stream": true,
      "gen_ai.usage.input_tokens": 3,
      "gen_ai.usage.output_tokens": 2,
      "gen_ai.response.finish_reasons": ["stop"]
    });
    expect(chat!.attributes["l2m.stream.closed_early"]).toBeUndefined();
    // The span covers the stream: it ends after the last chunk, inside the request.
    const endOf = (span: ReadableSpan) => span.endTime[0] * 1e9 + span.endTime[1];
    expect(endOf(chat!)).toBeLessThanOrEqual(endOf(server));
    expect(server.attributes["l2m.gateway.status"]).toBe("ok");
    noContent(fixture.spans.getFinishedSpans());
  });

  it("records an embeddings call as an embeddings span", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    const response = await v1(fixture, gw.token, "/v1/embeddings", { model: "embed-test", input: [MARKER] });
    expect(response.status).toBe(200);
    const server = await serverSpanOf(fixture, "/v1/embeddings");
    const embeddings = fixture.spans.getFinishedSpans().filter((span) => span.name === "embeddings up-embed");
    expect(embeddings).toHaveLength(1);
    expect(parentOf(embeddings[0]!)).toBe(server.spanContext().spanId);
    expect(embeddings[0]!.attributes).toMatchObject({ "gen_ai.operation.name": "embeddings", "gen_ai.usage.input_tokens": 2, "gen_ai.embeddings.dimension.count": 4 });
    noContent(fixture.spans.getFinishedSpans());
  });

  it("records an upstream failure by type on the chat span and the status on the request's span", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    fixture.upstream.failNext = true;
    const response = await v1(fixture, gw.token, "/v1/chat/completions", { model: "gpt-test", messages: [{ role: "user", content: MARKER }], max_tokens: 5 });
    expect(response.status).toBeGreaterThanOrEqual(400);
    const server = await serverSpanOf(fixture, "/v1/chat/completions");
    expect(server.attributes["l2m.gateway.status"]).toBe("upstream_error");
    const chats = chatSpans(fixture);
    expect(chats.length).toBeGreaterThanOrEqual(1);
    expect(chats[0]!.status.code).toBe(SPAN_STATUS_ERROR);
    expect(chats[0]!.status.message).toBeUndefined();
    expect(typeof chats[0]!.attributes["error.type"]).toBe("string");
    noContent(fixture.spans.getFinishedSpans());
    const duration = (await fixture.metrics()).get("gen_ai.client.operation.duration")!;
    expect(duration.some((point) => typeof point.attributes["error.type"] === "string")).toBe(true);
  });

  it("marks a budget refusal on the request's span, with no model call", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    const budget = await api(fixture, "POST", "/api/budgets", { name: "Client", scopeType: "mcp_client", scopeId: gw.clientId, period: "day", limitType: "usd", limitValue: 5, action: "block" });
    expect(budget.status, budget.raw).toBe(200);
    expect((await v1(fixture, gw.token, "/v1/chat/completions", { model: "gpt-test", messages: [{ role: "user", content: "one" }] })).status).toBe(200);
    await serverSpanOf(fixture, "/v1/chat/completions");
    const refused = await until(async () => {
      const response = await v1(fixture, gw.token, "/v1/chat/completions", { model: "gpt-test", messages: [{ role: "user", content: "two" }] });
      return response.status === 429 ? response : null;
    }, "the budget refusal");
    expect(refused.status).toBe(429);
    const blocked = await until(
      () => fixture.spans.getFinishedSpans().find((span) => span.attributes["http.route"] === "/v1/chat/completions" && span.attributes["l2m.gateway.status"] === "budget_blocked"),
      "the refused request's span"
    );
    expect(blocked.attributes["l2m.gateway.client.id"]).toBe(gw.clientId);
    expect(fixture.spans.getFinishedSpans().filter((span) => parentOf(span) === blocked.spanContext().spanId && span.name.startsWith("chat "))).toHaveLength(0);
    expect(chatSpans(fixture)).toHaveLength(1);
  });
});

describe("workflow runs through the API", () => {
  it("nests the LLM Call node's chat span in the run and adds the run's priced spend to the cost metric", async () => {
    const fixture = await setup();
    const workflow: Workflow = workflowOf(
      "wf-otel-llm",
      [
        node("text", "text_input", { text: MARKER }),
        node("prompt", "prompt_template", { template: "{{user_prompt}}", outputKey: "prompt" }),
        node(
          "llm",
          "llm_call",
          { provider: { providerId: "openai_compatible", model: "up-model", baseUrl: fixture.upstream.baseUrl, secretRef: { secretId: fixture.secretId } }, promptKey: "prompt" },
          "Ask"
        ),
        node("out", "output", { responseTemplate: "{{answer}}", outputKey: "result" })
      ],
      [edge("text", "prompt"), edge("prompt", "llm"), edge("llm", "out")]
    );
    await fixture.store.upsertWorkflow({ ...workflow, projectId: "default" });
    const run = await api<{ status: string }>(fixture, "POST", `/api/workflows/${workflow.id}/execute`, {});
    expect(run.status, run.raw).toBe(200);
    expect(run.body.status).toBe("success");
    const chat = await until(() => chatSpans(fixture)[0], "the run's chat span");
    const nodeSpan = fixture.spans.getFinishedSpans().find((span) => span.name === "l2m.node llm_call")!;
    expect(parentOf(chat)).toBe(nodeSpan.spanContext().spanId);
    expect(chatSpans(fixture)).toHaveLength(1);
    noContent(fixture.spans.getFinishedSpans());
    const cost = await until(async () => (await fixture.metrics()).get("l2m.gen_ai.cost")?.find((point) => point.attributes["l2m.usage.source"] === "run"), "the run's cost");
    // A dollar a token: the usage the chat span reports, priced once where the usage event is written.
    const tokens = Number(chat.attributes["gen_ai.usage.input_tokens"]) + Number(chat.attributes["gen_ai.usage.output_tokens"]);
    expect(tokens).toBeGreaterThan(0);
    expect(cost).toMatchObject({ attributes: { "gen_ai.provider.name": "openai", "gen_ai.request.model": "up-model", "l2m.project.id": "default" }, value: tokens });
  });
});

describe("tracing off", () => {
  it("wraps nothing: the registries are returned as they are", async () => {
    const telemetry = await loadTelemetry(resolveTelemetrySettings(parseConfig({ SECRET_MASTER_KEY_BASE64: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" })));
    const model = await createModelTelemetry(telemetry, { metrics: false });
    expect(model.active).toBe(false);
    expect(model.instrumentation).toBe(NOOP_RUN_INSTRUMENTATION);
    const providers = createDefaultProviderRegistry();
    const embeddings = createDefaultEmbeddingRegistry();
    expect(model.providers(providers)).toBe(providers);
    expect(model.embeddings(embeddings)).toBe(embeddings);
    expect(() => model.recordCost({ providerId: "openai", model: "m", costUsd: 1, source: "run" })).not.toThrow();
  });

  it("serves /v1 with no spans and no traceparent sent upstream", async () => {
    const fixture = await setup({});
    const gw = await gateway(fixture);
    const response = await v1(fixture, gw.token, "/v1/chat/completions", { model: "gpt-test", messages: [{ role: "user", content: "hi" }] });
    expect(response.status).toBe(200);
    expect(fixture.spans.getFinishedSpans()).toHaveLength(0);
    expect(fixture.upstream.requests[0]!.headers.traceparent).toBeUndefined();
  });

  it("records the GenAI metrics with a metrics endpoint alone (no spans)", async () => {
    const fixture = await setup({ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://127.0.0.1:9/v1/metrics", OTEL_METRICS_ENABLED: "true" });
    const gw = await gateway(fixture);
    expect((await v1(fixture, gw.token, "/v1/chat/completions", { model: "gpt-test", messages: [{ role: "user", content: MARKER }] })).status).toBe(200);
    const metrics = await until(async () => {
      const byName = await fixture.metrics();
      return byName.get("l2m.gen_ai.cost")?.length ? byName : null;
    }, "the metrics");
    expect(metrics.get("gen_ai.client.token.usage")?.length).toBe(2);
    expect(metrics.get("gen_ai.client.operation.duration")?.length).toBe(1);
    expect(fixture.spans.getFinishedSpans()).toHaveLength(0);
  });

  it("sends traceparent to the provider only when L2M_OTEL_PROPAGATE_TO_PROVIDERS is on", async () => {
    const fixture = await setup({ TRACING_ENABLED: "true", L2M_OTEL_PROPAGATE_TO_PROVIDERS: "true" });
    const gw = await gateway(fixture);
    expect((await v1(fixture, gw.token, "/v1/chat/completions", { model: "gpt-test", messages: [{ role: "user", content: "hi" }] })).status).toBe(200);
    const [chat] = await until(() => (chatSpans(fixture).length ? chatSpans(fixture) : null), "the chat span");
    expect(fixture.upstream.requests[0]!.headers.traceparent).toBe(`00-${chat!.spanContext().traceId}-${chat!.spanContext().spanId}-01`);
  });
});
