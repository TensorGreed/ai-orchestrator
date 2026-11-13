/**
 * MCP spans through the whole API: a gateway request (both eras) becomes a SERVER span, parented on the trace context
 * in its `_meta` under the inbound trust rule; the gateway's call to the upstream server is a CLIENT span under it; and
 * the upstream server receives that CLIENT span's context in `_meta`. With tracing off nothing of this exists.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemorySpanExporter, type ReadableSpan, type SpanProcessor } from "@ai-orchestrator/otel";
import type { McpClient, McpToolset } from "@ai-orchestrator/shared";
import { gatewayToolName, slugifyServerName } from "@ai-orchestrator/mcp-sdk";
import { createApp } from "../app.js";
import { gatewayMethodName, traceCarrierFromMeta, traceGatewayRequest } from "./mcp-gateway-tracing.js";
import type { InstrumentationSpan, RunInstrumentation } from "@ai-orchestrator/shared";
import { parseConfig } from "../config.js";
import type { Store } from "../db/store.js";
import { AuthService } from "../services/auth-service.js";
import { SecretService } from "../services/secret-service.js";
import { openTestStore } from "../test-support/test-store.js";

const ADMIN = { email: "admin@example.com", password: "admin-Pass-123!" };
const CALLER_TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const CALLER_SPAN = "00f067aa0ba902b7";
const CALLER_TRACEPARENT = `00-${CALLER_TRACE}-${CALLER_SPAN}-01`;
/** The name the gateway exposes the upstream `echo_meta` tool under. */
const TOOL = gatewayToolName(slugifyServerName("Meta server"), "echo_meta");
const SPAN_KIND_SERVER = 1;
const SPAN_KIND_CLIENT = 2;

/** An upstream stdio server whose `echo_meta` tool answers with the `_meta` its request carried. */
const META_SERVER = `
process.stdin.setEncoding('utf-8');
let buf = '';
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl = buf.indexOf('\\n');
  while (nl >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    nl = buf.indexOf('\\n');
    if (!line) continue;
    const req = JSON.parse(line);
    if (req.id === undefined) continue;
    if (req.method === 'initialize') reply(req.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'meta', version: '1' } });
    else if (req.method === 'tools/list') reply(req.id, { tools: [{ name: 'echo_meta', description: 'Echoes _meta', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] });
    else if (req.method === 'tools/call') reply(req.id, { content: [{ type: 'text', text: JSON.stringify((req.params && req.params._meta) || null) }] });
    else reply(req.id, {});
  }
});
`;

interface Fixture {
  app: FastifyInstance;
  store: Store;
  tempDir: string;
  exporter: InMemorySpanExporter;
  toolset: McpToolset;
  client: McpClient;
  token: string;
}

const fixtures: Fixture[] = [];
afterEach(async () => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop()!;
    await fixture.app.close();
    try {
      await fixture.store.close();
    } catch {
      // Closed by the app already.
    }
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

function collectInto(exporter: InMemorySpanExporter): SpanProcessor {
  return {
    onStart: () => undefined,
    onEnd: (span) => exporter.export([span], () => undefined),
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve()
  };
}

async function setup(env: Record<string, string>): Promise<Fixture> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-otel-mcp-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "sync"),
    MCP_GATEWAY_MODERN_PROTOCOL: "on",
    ...env
  });
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  await authService.bootstrapAdmin(ADMIN.email, ADMIN.password);
  const exporter = new InMemorySpanExporter();
  const app = await createApp(config, store, new SecretService(store, config.SECRET_MASTER_KEY_BASE64), authService, undefined, undefined, undefined, {
    telemetrySpanProcessors: [collectInto(exporter)],
    telemetryRegisterGlobals: false
  });
  await app.ready();
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: ADMIN });
  const cookie = String([login.headers["set-cookie"]].flat().find((value) => String(value).startsWith("ao_session="))).split(";")[0]!;
  const post = async <T>(url: string, payload: Record<string, unknown>) => {
    const response = await app.inject({ method: "POST", url, headers: { cookie }, payload });
    expect(response.statusCode, response.body).toBeLessThan(300);
    return response.json() as T;
  };
  const server = await post<{ server: { id: string } }>("/api/mcp/servers", {
    name: "Meta server",
    adapterId: "stdio_mcp",
    probeEnabled: false,
    connection: { command: process.execPath, args: ["-e", META_SERVER], timeoutMs: 20000 }
  });
  const probe = await post<{ probe: { ok: boolean } }>(`/api/mcp/servers/${server.server.id}/probe`, {});
  expect(probe.probe.ok).toBe(true);
  const toolset = await post<{ toolset: McpToolset }>("/api/mcp/toolsets", {
    name: "Traced tools",
    projectId: "default",
    members: [{ kind: "server", serverId: server.server.id, toolGlob: "*" }]
  });
  const client = await post<{ client: McpClient; token: string }>("/api/mcp/clients", { name: "Traced IDE", toolsetIds: [toolset.toolset.id], role: "builder" });
  exporter.reset();
  const fixture = { app, store, tempDir, exporter, toolset: toolset.toolset, client: client.client, token: client.token };
  fixtures.push(fixture);
  return fixture;
}

async function rpc(fixture: Fixture, body: unknown, headers: Record<string, string> = {}) {
  return await fixture.app.inject({
    method: "POST",
    url: `/mcp/${fixture.toolset.slug}`,
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${fixture.token}`, ...headers },
    payload: JSON.stringify(body)
  });
}

async function openSession(fixture: Fixture, protocolVersion = "2025-06-18"): Promise<string> {
  const response = await rpc(fixture, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion, capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  expect(response.statusCode).toBe(200);
  return String(response.headers["mcp-session-id"]);
}

const MODERN = "2026-07-28";
const modernMeta = (extra: Record<string, unknown> = {}) => ({
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientCapabilities": {},
  ...extra
});
const modernHeaders = (method: string, name?: string) => ({ "mcp-protocol-version": MODERN, "mcp-method": method, ...(name ? { "mcp-name": name } : {}) });

/** The upstream server's view of the call: the `_meta` its request carried. */
function upstreamMeta(body: unknown): Record<string, unknown> | null {
  const result = (body as { result?: { content?: Array<{ text?: string }> } }).result;
  return JSON.parse(result?.content?.[0]?.text ?? "null") as Record<string, unknown> | null;
}

function spansNamed(fixture: Fixture, name: string, kind: number): ReadableSpan[] {
  return fixture.exporter.getFinishedSpans().filter((span) => span.name === name && span.kind === kind);
}

function httpSpan(fixture: Fixture): ReadableSpan {
  const spans = fixture.exporter.getFinishedSpans().filter((span) => span.attributes["http.route"] === "/mcp/:toolset");
  return spans[spans.length - 1]!;
}

describe("MCP gateway SERVER spans and upstream CLIENT spans", () => {
  it("legacy: continues the caller's _meta trace, links the HTTP span, and passes its own context upstream", async () => {
    const fixture = await setup({ TRACING_ENABLED: "true" });
    const sessionId = await openSession(fixture);
    expect(spansNamed(fixture, "initialize", SPAN_KIND_SERVER)).toHaveLength(1);
    const response = await rpc(
      fixture,
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: TOOL, arguments: {}, _meta: { traceparent: CALLER_TRACEPARENT } } },
      { "mcp-session-id": sessionId }
    );
    expect(response.statusCode).toBe(200);

    const [server] = spansNamed(fixture, `tools/call ${TOOL}`, SPAN_KIND_SERVER);
    expect(server!.spanContext().traceId).toBe(CALLER_TRACE);
    expect(server!.parentSpanContext?.spanId).toBe(CALLER_SPAN);
    const http = httpSpan(fixture);
    expect(server!.links.map((link) => [link.context.spanId, link.attributes?.["l2m.link.reason"]])).toEqual([[http.spanContext().spanId, "transport"]]);
    expect(server!.attributes).toMatchObject({
      "mcp.method.name": "tools/call",
      "gen_ai.tool.name": TOOL,
      "mcp.session.id": sessionId,
      "mcp.protocol.version": "2025-06-18",
      "jsonrpc.request.id": "7",
      "l2m.toolset.id": fixture.toolset.id,
      "l2m.gateway.client.id": fixture.client.id
    });

    const client = spansNamed(fixture, "tools/call echo_meta", SPAN_KIND_CLIENT).find((span) => span.spanContext().traceId === CALLER_TRACE)!;
    expect(client.parentSpanContext?.spanId).toBe(server!.spanContext().spanId);
    expect(client.attributes).toMatchObject({ "network.transport": "pipe", "mcp.method.name": "tools/call" });
    // The upstream server got the CLIENT span's context, and nothing of the caller's _meta.
    const meta = upstreamMeta(response.json());
    expect(meta).toEqual({ traceparent: `00-${CALLER_TRACE}-${client.spanContext().spanId}-01` });
  });

  it("modern: the same for a 2026-07-28 request, with no session and the request's version", async () => {
    const fixture = await setup({ TRACING_ENABLED: "true" });
    const response = await rpc(
      fixture,
      { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: TOOL, arguments: {}, _meta: modernMeta({ traceparent: CALLER_TRACEPARENT, tracestate: "vendor=1" }) } },
      modernHeaders("tools/call", TOOL)
    );
    expect(response.statusCode).toBe(200);
    const [server] = spansNamed(fixture, `tools/call ${TOOL}`, SPAN_KIND_SERVER);
    expect(server!.parentSpanContext?.spanId).toBe(CALLER_SPAN);
    expect(server!.attributes["mcp.protocol.version"]).toBe(MODERN);
    expect(server!.attributes["mcp.session.id"]).toBeUndefined();
    const client = spansNamed(fixture, "tools/call echo_meta", SPAN_KIND_CLIENT).find((span) => span.parentSpanContext?.spanId === server!.spanContext().spanId)!;
    expect(upstreamMeta(response.json())).toMatchObject({ traceparent: `00-${CALLER_TRACE}-${client.spanContext().spanId}-01`, tracestate: "vendor=1" });
  });

  it("with L2M_OTEL_TRUST_INBOUND=none, only links the caller's _meta context", async () => {
    const fixture = await setup({ TRACING_ENABLED: "true", L2M_OTEL_TRUST_INBOUND: "none" });
    const response = await rpc(
      fixture,
      { jsonrpc: "2.0", id: 9, method: "tools/list", params: { _meta: modernMeta({ traceparent: CALLER_TRACEPARENT }) } },
      modernHeaders("tools/list")
    );
    expect(response.statusCode).toBe(200);
    const [server] = spansNamed(fixture, "tools/list", SPAN_KIND_SERVER);
    const http = httpSpan(fixture);
    expect(server!.spanContext().traceId).toBe(http.spanContext().traceId);
    expect(server!.parentSpanContext?.spanId).toBe(http.spanContext().spanId);
    expect(server!.links.map((link) => [link.context.traceId, link.attributes?.["l2m.link.reason"]])).toEqual([[CALLER_TRACE, "untrusted_inbound"]]);
  });

  it("without _meta context, a request is a child of its HTTP span; a batch gets one span per request", async () => {
    const fixture = await setup({ TRACING_ENABLED: "true" });
    const sessionId = await openSession(fixture, "2025-03-26");
    const response = await rpc(
      fixture,
      [
        { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
        { jsonrpc: "2.0", id: 2, method: "ping" }
      ],
      { "mcp-session-id": sessionId }
    );
    expect(response.statusCode).toBe(200);
    const http = httpSpan(fixture);
    const list = spansNamed(fixture, "tools/list", SPAN_KIND_SERVER)[0]!;
    const ping = spansNamed(fixture, "ping", SPAN_KIND_SERVER)[0]!;
    for (const span of [list, ping]) {
      expect(span.parentSpanContext?.spanId).toBe(http.spanContext().spanId);
      expect(span.links).toEqual([]);
    }
    expect([list.attributes["jsonrpc.request.id"], ping.attributes["jsonrpc.request.id"]]).toEqual(["1", "2"]);
  });

  it("records a JSON-RPC error answer by its code, and an unknown method as _OTHER (the caller picks the method)", async () => {
    const fixture = await setup({ TRACING_ENABLED: "true" });
    const sessionId = await openSession(fixture);
    const response = await rpc(fixture, { jsonrpc: "2.0", id: 3, method: "no/such-0123456789" }, { "mcp-session-id": sessionId });
    expect(response.json()).toMatchObject({ error: { code: -32601 } });
    expect(spansNamed(fixture, "no/such-0123456789", SPAN_KIND_SERVER)).toEqual([]);
    const [span] = spansNamed(fixture, "_OTHER", SPAN_KIND_SERVER);
    expect(span!.attributes).toMatchObject({ "mcp.method.name": "_OTHER", "error.type": "-32601", "rpc.response.status_code": "-32601" });
    expect(span!.status.code).toBe(2);
  });

  it("modern: server/discover gets a SERVER span with the request's version and trusted parent", async () => {
    const fixture = await setup({ TRACING_ENABLED: "true" });
    const response = await rpc(fixture, { jsonrpc: "2.0", id: 9, method: "server/discover", params: { _meta: modernMeta({ traceparent: CALLER_TRACEPARENT }) } }, modernHeaders("server/discover"));
    expect(response.statusCode).toBe(200);
    const [server] = spansNamed(fixture, "server/discover", SPAN_KIND_SERVER);
    expect(server!.parentSpanContext?.spanId).toBe(CALLER_SPAN);
    expect(server!.attributes).toMatchObject({ "mcp.method.name": "server/discover", "mcp.protocol.version": MODERN, "jsonrpc.request.id": "9" });
  });

  it("modern: subscriptions/listen gets a SERVER span that ends with the acknowledgment, and a refusal records its code", async () => {
    const fixture = await setup({ TRACING_ENABLED: "true", MCP_GATEWAY_LISTEN_MAX_MS: "1000" });
    const listen = (id: number, accept: string) =>
      rpc(fixture, { jsonrpc: "2.0", id, method: "subscriptions/listen", params: { _meta: modernMeta({ traceparent: CALLER_TRACEPARENT }) } }, { ...modernHeaders("subscriptions/listen"), accept });
    const startedAt = Date.now();
    const streamed = await listen(11, "application/json, text/event-stream");
    expect(streamed.statusCode).toBe(200);
    expect(streamed.body).toContain("notifications/subscriptions/acknowledged");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
    const [span] = spansNamed(fixture, "subscriptions/listen", SPAN_KIND_SERVER);
    expect(span!.parentSpanContext?.spanId).toBe(CALLER_SPAN);
    expect(span!.attributes).toMatchObject({ "mcp.method.name": "subscriptions/listen", "mcp.protocol.version": MODERN, "jsonrpc.request.id": "11" });
    expect(span!.status.code).not.toBe(2);
    // Ended when the stream was acknowledged, not when it closed a second later.
    const durationMs = span!.duration[0] * 1000 + span!.duration[1] / 1e6;
    expect(durationMs).toBeLessThan(900);

    fixture.exporter.reset();
    const refused = await listen(12, "application/json");
    expect(refused.statusCode).toBe(406);
    const [refusal] = spansNamed(fixture, "subscriptions/listen", SPAN_KIND_SERVER);
    expect(refusal!.attributes).toMatchObject({ "jsonrpc.request.id": "12", "error.type": String(refused.json().error.code) });
    expect(refusal!.status.code).toBe(2);
  });

  it("does not send trace context to a server that opted out", async () => {
    const fixture = await setup({ TRACING_ENABLED: "true" });
    const servers = await fixture.store.listMcpServers();
    const target = servers.find((server) => server.name === "Meta server")!;
    await fixture.store.updateMcpServer(target.id, { connection: { ...target.connection, propagateTraceContext: false } });
    const sessionId = await openSession(fixture);
    const response = await rpc(fixture, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: TOOL, arguments: {} } }, { "mcp-session-id": sessionId });
    expect(upstreamMeta(response.json())).toBeNull();
    expect(spansNamed(fixture, "tools/call echo_meta", SPAN_KIND_CLIENT)).toHaveLength(1);
  });
});

describe("tracing off", () => {
  it("records nothing and sends no trace context upstream, whatever the caller sent", async () => {
    const fixture = await setup({});
    const sessionId = await openSession(fixture);
    const response = await rpc(
      fixture,
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: TOOL, arguments: {}, _meta: { traceparent: CALLER_TRACEPARENT } } },
      { "mcp-session-id": sessionId, traceparent: CALLER_TRACEPARENT }
    );
    expect(response.statusCode).toBe(200);
    expect(upstreamMeta(response.json())).toBeNull();
    expect(fixture.exporter.getFinishedSpans()).toEqual([]);
  });
});

describe("gateway span helpers", () => {
  it("names only the methods MCP defines; anything else is _OTHER", () => {
    expect(gatewayMethodName("tools/call")).toBe("tools/call");
    expect(gatewayMethodName("server/discover")).toBe("server/discover");
    expect(gatewayMethodName("subscriptions/listen")).toBe("subscriptions/listen");
    expect(gatewayMethodName("x".repeat(500))).toBe("_OTHER");
  });

  it("reads traceparent and tracestate up to 512 characters and baggage up to 8192", () => {
    const long = "a".repeat(513);
    expect(traceCarrierFromMeta({ _meta: { traceparent: long } })).toBeUndefined();
    expect(traceCarrierFromMeta({ _meta: { traceparent: CALLER_TRACEPARENT, tracestate: long, baggage: "k=" + "v".repeat(8000) } })).toEqual({
      traceparent: CALLER_TRACEPARENT,
      baggage: "k=" + "v".repeat(8000)
    });
  });

  it("records a thrown error by its type only and rethrows it", async () => {
    const recorded: Array<{ error: unknown; type?: string }> = [];
    const span = { recordError: (error: unknown, options?: { type?: string }) => recorded.push({ error, type: options?.type }) } as unknown as InstrumentationSpan;
    const instrumentation = { enabled: true, mcpRequest: async (_info: unknown, fn: (s: InstrumentationSpan) => Promise<unknown>) => await fn(span) } as unknown as RunInstrumentation;
    const facts = { method: "initialize", params: {}, era: "legacy" as const, toolsetId: "t", clientId: "c" };
    await expect(traceGatewayRequest({ instrumentation, trustInbound: "all" }, facts, async () => { throw new Error("secret request text"); })).rejects.toThrow("secret request text");
    await expect(traceGatewayRequest({ instrumentation, trustInbound: "all" }, facts, async () => { throw new TypeError("more text"); })).rejects.toThrow();
    expect(recorded).toEqual([{ error: null, type: "_OTHER" }, { error: null, type: "TypeError" }]);
  });
});
