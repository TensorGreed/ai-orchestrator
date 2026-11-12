import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { NOOP_RUN_INSTRUMENTATION, type MCPServerConfig, type MCPToolResult } from "@ai-orchestrator/shared";
import { afterEach, describe, expect, it } from "vitest";
import { HttpMCPServerAdapter } from "./adapters/http-mcp";
import { StdioMCPServerAdapter } from "./adapters/stdio-mcp";
import { BuiltInToolsMCPServerAdapter } from "./adapters/built-in-tools";
import { isL2mOwnToolAdapter } from "./adapters/own-adapters";
import { McpJsonRpcError } from "./errors";
import { createDefaultMCPRegistry } from "./index";
import { MCP_META_CLIENT_CAPABILITIES, MCP_META_PROTOCOL_VERSION, inspectRequestMeta } from "./protocol";
import { MCPRegistry } from "./registry";
import {
  InstrumentedMCPRegistry,
  createInstrumentedMCPRegistry,
  instrumentMcpAdapter,
  mcpTraceCarrier,
  traceContextHeaders,
  withTraceContext
} from "./tracing";
import { RecordingInstrumentation, TEST_TRACE_ID, traceparentOf } from "./tracing.test-helper";
import type { MCPExecutionContext, MCPServerAdapter } from "./types";

const TRACEPARENT = `00-${TEST_TRACE_ID}-00f067aa0ba902b7-01`;

describe("the _meta merge", () => {
  it("keeps the progress token, the 2026-07-28 protocol keys and vendor keys when trace context is added", () => {
    const params = {
      name: "lookup",
      _meta: {
        progressToken: "p-1",
        [MCP_META_PROTOCOL_VERSION]: "2026-07-28",
        [MCP_META_CLIENT_CAPABILITIES]: { elicitation: {} },
        "com.example/tenant": "t1"
      }
    };
    const merged = withTraceContext(params, { traceparent: TRACEPARENT, tracestate: "l2m=1" });
    expect(merged).toEqual({
      name: "lookup",
      _meta: {
        progressToken: "p-1",
        [MCP_META_PROTOCOL_VERSION]: "2026-07-28",
        [MCP_META_CLIENT_CAPABILITIES]: { elicitation: {} },
        "com.example/tenant": "t1",
        traceparent: TRACEPARENT,
        tracestate: "l2m=1"
      }
    });
    // The input is not modified.
    expect(params._meta).not.toHaveProperty("traceparent");
    // Trace context alone never makes a request modern.
    expect(inspectRequestMeta(withTraceContext({ name: "x" }, { traceparent: TRACEPARENT }))).toEqual({ era: "legacy" });
  });

  it("replaces an older trace context and drops trace keys the new one does not carry", () => {
    const merged = withTraceContext(
      { _meta: { progressToken: 3, traceparent: "00-11111111111111111111111111111111-2222222222222222-01", tracestate: "old=1", baggage: "k=v" } },
      { traceparent: TRACEPARENT }
    );
    expect(merged._meta).toEqual({ progressToken: 3, traceparent: TRACEPARENT });
  });

  it("returns params unchanged without a carrier", () => {
    const params = { _meta: { progressToken: "p" } };
    expect(withTraceContext(params, undefined)).toBe(params);
    expect(traceContextHeaders(undefined)).toEqual({});
  });

  it("gives no carrier while tracing is off, with propagation off, or when the server opted out", async () => {
    expect(mcpTraceCarrier(undefined, { connection: {} })).toBeUndefined();
    expect(mcpTraceCarrier(NOOP_RUN_INSTRUMENTATION, { connection: {} })).toBeUndefined();
    const trace = new RecordingInstrumentation();
    await trace.mcpRequest({ method: "tools/list" }, async (span) => {
      expect(mcpTraceCarrier(trace, { connection: {} })).toEqual({ traceparent: traceparentOf(span) });
      expect(mcpTraceCarrier(trace, { connection: { propagateTraceContext: false } })).toBeUndefined();
      trace.propagate = false;
      expect(mcpTraceCarrier(trace, { connection: {} })).toBeUndefined();
    });
  });
});

const contextOf = (extra: Partial<MCPExecutionContext> = {}): MCPExecutionContext => ({
  resolveSecret: async () => undefined,
  runtimeState: new Map(),
  ...extra
});

function fakeAdapter(id: string, behaviour: Partial<MCPServerAdapter> = {}): MCPServerAdapter {
  return {
    definition: { id, label: id, description: "", configSchema: {}, authSchema: {} },
    discoverTools: async () => [],
    invokeTool: async (): Promise<MCPToolResult> => ({ ok: true, output: "ok" }),
    ...behaviour
  };
}

describe("the instrumented registry", () => {
  it("opens a CLIENT span per operation with the method, target, server id and transport", async () => {
    const trace = new RecordingInstrumentation();
    const adapter = instrumentMcpAdapter(fakeAdapter("http_mcp", { readResource: async (uri) => ({ uri, contents: [] }) as never, getPrompt: async () => ({ messages: [] }) as never }), trace);
    const config: MCPServerConfig = { serverId: "http_mcp", registryServerId: "srv_9", connection: { endpoint: "https://mcp.example.com:8443/mcp?key=secret" } };
    await adapter.discoverTools(config, contextOf());
    await adapter.invokeTool("lookup", {}, config, contextOf());
    await adapter.readResource!("file:///a.txt", config, contextOf());
    await adapter.getPrompt!("greet", {}, config, contextOf());
    expect(trace.spans.map((span) => span.info)).toEqual([
      { method: "tools/list", side: "client", transport: "tcp", networkProtocol: "http", serverAddress: "mcp.example.com", serverPort: 8443, serverId: "srv_9" },
      { method: "tools/call", side: "client", target: "lookup", transport: "tcp", networkProtocol: "http", serverAddress: "mcp.example.com", serverPort: 8443, serverId: "srv_9" },
      { method: "resources/read", side: "client", resourceUri: "file:///a.txt", transport: "tcp", networkProtocol: "http", serverAddress: "mcp.example.com", serverPort: 8443, serverId: "srv_9" },
      { method: "prompts/get", side: "client", target: "greet", transport: "tcp", networkProtocol: "http", serverAddress: "mcp.example.com", serverPort: 8443, serverId: "srv_9" }
    ]);
    expect(trace.spans.every((span) => span.ended)).toBe(true);
  });

  it("records tool errors as tool_error, adapter failures by kind and JSON-RPC errors by code", async () => {
    const trace = new RecordingInstrumentation();
    const failing = instrumentMcpAdapter(
      fakeAdapter("stdio_mcp", {
        invokeTool: async (name) =>
          name === "own" ? { ok: false, output: null, error: "bad input", errorKind: "tool" } : { ok: false, output: null, error: "down", errorKind: "transport" },
        discoverTools: async () => {
          throw new McpJsonRpcError("nope", -32601);
        }
      }),
      trace
    );
    const config: MCPServerConfig = { serverId: "stdio_mcp" };
    await failing.invokeTool("own", {}, config, contextOf());
    await failing.invokeTool("other", {}, config, contextOf());
    await expect(failing.discoverTools(config, contextOf())).rejects.toThrow("nope");
    expect(trace.spans.map((span) => [span.info.transport, span.errorType, span.attributes["rpc.response.status_code"]])).toEqual([
      ["pipe", "tool_error", undefined],
      ["pipe", "transport", undefined],
      ["pipe", "-32601", "-32601"]
    ]);
  });

  it("leaves L2M's own tools alone, keeps the definition object and other methods, and wraps later registrations", async () => {
    const trace = new RecordingInstrumentation();
    const builtIn = new BuiltInToolsMCPServerAdapter();
    expect(instrumentMcpAdapter(builtIn, trace)).toBe(builtIn);
    let closed = 0;
    const plain = fakeAdapter("community_x", { closeSessions: () => void (closed += 1) });
    const registry = new InstrumentedMCPRegistry(trace);
    registry.register(plain);
    const wrapped = registry.get("community_x");
    expect(wrapped).not.toBe(plain);
    expect(wrapped.definition).toBe(plain.definition);
    await registry.closeSessions(contextOf());
    expect(closed).toBe(1);
    // Wrapping twice does not nest spans.
    expect(instrumentMcpAdapter(wrapped, trace)).toBe(wrapped);
    await wrapped.invokeTool("t", {}, { serverId: "community_x" }, contextOf());
    expect(trace.spans).toHaveLength(1);
  });

  it("is the plain registry while tracing is off", () => {
    const base = new MCPRegistry();
    expect(createInstrumentedMCPRegistry(base, NOOP_RUN_INSTRUMENTATION)).toBe(base);
    const off = createDefaultMCPRegistry({ instrument: NOOP_RUN_INSTRUMENTATION });
    expect(off).not.toBeInstanceOf(InstrumentedMCPRegistry);
    const on = createDefaultMCPRegistry({ instrument: new RecordingInstrumentation() });
    expect(on).toBeInstanceOf(InstrumentedMCPRegistry);
    expect(isL2mOwnToolAdapter(on.get(new BuiltInToolsMCPServerAdapter().definition.id))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The HTTP client against in-process servers, both eras
// ---------------------------------------------------------------------------

interface Seen {
  rpc: { id?: string | number; method?: string; params?: Record<string, unknown> };
  headers: IncomingHttpHeaders;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

type Answer = (rpc: Seen["rpc"], headers: IncomingHttpHeaders) => { status?: number; body?: unknown; headers?: Record<string, string> };

async function startServer(answer: Answer): Promise<{ endpoint: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const rpc = JSON.parse(body || "{}") as Seen["rpc"];
      seen.push({ rpc, headers: request.headers });
      const reply = answer(rpc, request.headers);
      response.statusCode = reply.status ?? 200;
      for (const [key, value] of Object.entries(reply.headers ?? {})) response.setHeader(key, value);
      if (reply.body === undefined) {
        response.end();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(reply.body));
    });
  });
  server.keepAliveTimeout = 1;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, seen };
}

const TOOLS = [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }];
const result = (rpc: Seen["rpc"], value: unknown) => ({ body: { jsonrpc: "2.0", id: rpc.id, result: value } });

const legacyAnswer: Answer = (rpc) => {
  if (rpc.method === "initialize") {
    return { ...result(rpc, { protocolVersion: "2025-06-18", capabilities: { tools: {} } }), headers: { "mcp-session-id": "sess-1" } };
  }
  if (rpc.method?.startsWith("notifications/")) return { status: 202 };
  if (rpc.method === "tools/list") return result(rpc, { tools: TOOLS });
  if (rpc.method === "tools/call" && rpc.params?.name === "missing") {
    return { body: { jsonrpc: "2.0", id: rpc.id, error: { code: -32602, message: "Unknown tool" } } };
  }
  return result(rpc, { content: [{ type: "text", text: "legacy" }] });
};

/** A modern-only server: every request must carry the 2026-07-28 `_meta`; one tool asks for input once. */
const modernAnswer: Answer = (rpc) => {
  if (inspectRequestMeta(rpc.params).era !== "modern") {
    return { status: 400, body: { jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32020, message: "Header mismatch" } } };
  }
  if (rpc.method === "server/discover") return result(rpc, { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} } });
  if (rpc.method === "tools/list") return result(rpc, { resultType: "complete", tools: [...TOOLS, { name: "confirm", inputSchema: { type: "object" } }] });
  if (rpc.method === "tools/call" && rpc.params?.name === "confirm" && !rpc.params.inputResponses) {
    return result(rpc, {
      resultType: "input_required",
      inputRequests: { ok: { method: "elicitation/create", params: { message: "Sure?", requestedSchema: { type: "object", properties: { yes: { type: "boolean" } } } } } },
      requestState: "s1"
    });
  }
  return result(rpc, { resultType: "complete", content: [{ type: "text", text: "modern" }] });
};

const metaOf = (entry: Seen) => (entry.rpc.params?._meta ?? {}) as Record<string, unknown>;

describe("HTTP client: trace context on the wire", () => {
  it("legacy: sends traceparent in headers and _meta on every request, initialize in headers only, and records the session", async () => {
    const { endpoint, seen } = await startServer(legacyAnswer);
    const trace = new RecordingInstrumentation();
    trace.extra = { tracestate: "l2m=1" };
    const registry = createDefaultMCPRegistry({ instrument: trace });
    const config: MCPServerConfig = { serverId: "http_mcp", connection: { endpoint } };
    const context = contextOf({ onProgress: () => undefined });
    await registry.get("http_mcp").discoverTools(config, context);
    const called = await registry.get("http_mcp").invokeTool("lookup", { q: 1 }, config, context);
    expect(called).toMatchObject({ ok: true });

    expect(seen.map((entry) => entry.rpc.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
    const [list, call] = trace.spans;
    const [initialize, initialized, listRequest, callRequest] = seen;
    // initialize: headers only (its params are exactly as before); the notification carries nothing.
    expect(initialize!.headers.traceparent).toBe(traceparentOf(list!));
    expect(initialize!.rpc.params).not.toHaveProperty("_meta");
    expect(initialized!.headers.traceparent).toBeUndefined();
    expect(listRequest!.headers.traceparent).toBe(traceparentOf(list!));
    expect(metaOf(listRequest!)).toEqual({ traceparent: traceparentOf(list!), tracestate: "l2m=1" });
    // Each operation's requests name its own span; the session's headers never keep an old traceparent.
    expect(callRequest!.headers.traceparent).toBe(traceparentOf(call!));
    expect(callRequest!.headers.tracestate).toBe("l2m=1");
    expect(metaOf(callRequest!)).toEqual({ progressToken: expect.any(String), traceparent: traceparentOf(call!), tracestate: "l2m=1" });
    // A legacy request whose _meta carries trace context is still a legacy request.
    expect(inspectRequestMeta(listRequest!.rpc.params).era).toBe("legacy");
    expect(call!.attributes).toEqual({ "mcp.session.id": "sess-1", "mcp.protocol.version": "2025-06-18", "jsonrpc.request.id": String(callRequest!.rpc.id) });
  });

  it("legacy: records the JSON-RPC error code the server answered with", async () => {
    const { endpoint } = await startServer(legacyAnswer);
    const trace = new RecordingInstrumentation();
    const registry = createDefaultMCPRegistry({ instrument: trace });
    const out = await registry.get("http_mcp").invokeTool("missing", {}, { serverId: "http_mcp", connection: { endpoint } }, contextOf());
    expect(out).toMatchObject({ ok: false, errorKind: "invalid_arguments" });
    expect(trace.named("tools/call missing")[0]!.attributes["rpc.response.status_code"]).toBe("-32602");
    // The adapter answers with a failed result (invalid_arguments); the span's error type is still the server's code.
    expect(trace.named("tools/call missing")[0]!.errorType).toBe("-32602");
  });

  it("modern: merges the protocol keys, the progress token and trace context into one _meta and adds the headers", async () => {
    const { endpoint, seen } = await startServer(modernAnswer);
    const trace = new RecordingInstrumentation();
    const registry = createDefaultMCPRegistry({ instrument: trace });
    const config: MCPServerConfig = { serverId: "http_mcp", connection: { endpoint, protocolMode: "modern" } };
    const out = await registry.get("http_mcp").invokeTool("lookup", { q: 1 }, config, contextOf({ onProgress: () => undefined }));
    expect(out).toMatchObject({ ok: true, output: "modern" });
    const span = trace.named("tools/call lookup")[0]!;
    const call = seen.find((entry) => entry.rpc.method === "tools/call")!;
    expect(Object.keys(metaOf(call)).sort()).toEqual(
      ["io.modelcontextprotocol/clientCapabilities", "io.modelcontextprotocol/clientInfo", MCP_META_PROTOCOL_VERSION, "progressToken", "traceparent"].sort()
    );
    expect(metaOf(call).traceparent).toBe(traceparentOf(span));
    expect(call.headers.traceparent).toBe(traceparentOf(span));
    expect(span.attributes["mcp.protocol.version"]).toBe("2026-07-28");
    expect(span.attributes["mcp.session.id"]).toBeUndefined();
  });

  it("modern: each later input round is a child span, and its request carries that span's context", async () => {
    const { endpoint, seen } = await startServer(modernAnswer);
    const trace = new RecordingInstrumentation();
    const registry = createDefaultMCPRegistry({ instrument: trace });
    const config: MCPServerConfig = { serverId: "http_mcp", registryServerId: "srv_1", connection: { endpoint, protocolMode: "modern" } };
    const out = await registry
      .get("http_mcp")
      .invokeTool("confirm", {}, config, contextOf({ onElicitation: async () => ({ action: "accept", content: { yes: true } }) }));
    expect(out).toMatchObject({ ok: true });
    const [outer, round2] = trace.named("tools/call confirm");
    expect(round2!.parent).toBe(outer);
    expect(round2!.info).toMatchObject({ method: "tools/call", target: "confirm", side: "client", round: 2, serverId: "srv_1" });
    expect(outer!.attributes["l2m.mcp.rounds"]).toBe(2);
    const calls = seen.filter((entry) => entry.rpc.method === "tools/call");
    expect(calls.map((entry) => metaOf(entry).traceparent)).toEqual([traceparentOf(outer!), traceparentOf(round2!)]);
    expect(calls.map((entry) => entry.headers.traceparent)).toEqual([traceparentOf(outer!), traceparentOf(round2!)]);
    expect(round2!.attributes["jsonrpc.request.id"]).toBe(String(calls[1]!.rpc.id));
  });

  it("auto: the server/discover probe carries trace context too", async () => {
    const { endpoint, seen } = await startServer(modernAnswer);
    const trace = new RecordingInstrumentation();
    const registry = createDefaultMCPRegistry({ instrument: trace });
    await registry.get("http_mcp").discoverTools({ serverId: "http_mcp", connection: { endpoint, protocolMode: "auto" } }, contextOf());
    const probe = seen.find((entry) => entry.rpc.method === "server/discover")!;
    expect(metaOf(probe).traceparent).toBe(traceparentOf(trace.spans[0]!));
    expect(probe.headers.traceparent).toBe(traceparentOf(trace.spans[0]!));
  });

  it("sends nothing to a server that opted out, and nothing at all while tracing is off", async () => {
    for (const setup of [
      { instrument: new RecordingInstrumentation(), connection: { propagateTraceContext: false } },
      { instrument: NOOP_RUN_INSTRUMENTATION, connection: {} }
    ]) {
      for (const answer of [legacyAnswer, modernAnswer]) {
        const { endpoint, seen } = await startServer(answer);
        const registry = createDefaultMCPRegistry({ instrument: setup.instrument });
        const config: MCPServerConfig = {
          serverId: "http_mcp",
          connection: { endpoint, ...setup.connection, ...(answer === modernAnswer ? { protocolMode: "modern" } : {}) }
        };
        expect(await registry.get("http_mcp").invokeTool("lookup", {}, config, contextOf())).toMatchObject({ ok: true });
        for (const entry of seen) {
          expect(entry.headers.traceparent).toBeUndefined();
          expect(metaOf(entry)).not.toHaveProperty("traceparent");
        }
      }
    }
  });

  it("an adapter built without tracing sends exactly what it always did", async () => {
    const { endpoint, seen } = await startServer(legacyAnswer);
    const adapter = new HttpMCPServerAdapter();
    await adapter.invokeTool("lookup", {}, { serverId: "http_mcp", connection: { endpoint } }, contextOf());
    expect(seen.find((entry) => entry.rpc.method === "tools/call")!.rpc.params).toEqual({ name: "lookup", arguments: {} });
  });
});

// ---------------------------------------------------------------------------
// stdio: `_meta` is the only carrier
// ---------------------------------------------------------------------------

const META_ECHO_SERVER = `
process.stdin.setEncoding('utf-8');
let buf = '';
const seen = [];
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl = buf.indexOf('\\n');
  while (nl >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    nl = buf.indexOf('\\n');
    if (!line) continue;
    const req = JSON.parse(line);
    seen.push({ method: req.method, meta: (req.params && req.params._meta) || null });
    if (req.id === undefined) continue;
    let result;
    if (req.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'meta', version: '1' } };
    else if (req.method === 'tools/list') result = { tools: [{ name: 'seen', inputSchema: { type: 'object' } }] };
    else result = { structuredContent: { seen } };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\\n');
  }
});
`;

describe("stdio client: trace context in _meta", () => {
  it("adds traceparent to every request but initialize, next to the progress token", async () => {
    const trace = new RecordingInstrumentation();
    const adapter = instrumentMcpAdapter(new StdioMCPServerAdapter({ trace }), trace);
    const config: MCPServerConfig = { serverId: "stdio_mcp", connection: { command: process.execPath, args: ["-e", META_ECHO_SERVER], timeoutMs: 5000 } };
    const context = contextOf({ onProgress: () => undefined });
    try {
      await adapter.discoverTools(config, context);
      const out = await adapter.invokeTool("seen", {}, config, context);
      const seen = (out.structured as { seen: Array<{ method: string; meta: Record<string, unknown> | null }> }).seen;
      const [list, call] = trace.spans;
      expect(seen.map((entry) => entry.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
      expect(seen[0]!.meta).toBeNull();
      expect(seen[1]!.meta).toBeNull();
      expect(seen[2]!.meta).toEqual({ traceparent: traceparentOf(list!) });
      expect(seen[3]!.meta).toEqual({ progressToken: expect.any(String), traceparent: traceparentOf(call!) });
      expect(call!.info.transport).toBe("pipe");
      expect(call!.attributes["jsonrpc.request.id"]).toBe("3");
    } finally {
      await adapter.closeSessions?.(context);
    }
  });

  it("sends no trace context when the server opted out", async () => {
    const trace = new RecordingInstrumentation();
    const adapter = instrumentMcpAdapter(new StdioMCPServerAdapter({ trace }), trace);
    const config: MCPServerConfig = {
      serverId: "stdio_mcp",
      connection: { command: process.execPath, args: ["-e", META_ECHO_SERVER], timeoutMs: 5000, propagateTraceContext: false }
    };
    const context = contextOf();
    try {
      const out = await adapter.invokeTool("seen", {}, config, context);
      const seen = (out.structured as { seen: Array<{ meta: unknown }> }).seen;
      expect(seen.every((entry) => entry.meta === null)).toBe(true);
    } finally {
      await adapter.closeSessions?.(context);
    }
  });
});

// ---------------------------------------------------------------------------
// stdio, MCP 2026-07-28: trace context goes through the same `_meta` merge as the protocol keys
// ---------------------------------------------------------------------------

/** A modern-only stdio server: answers server/discover and asks for one elicitation round on `confirm`. */
const MODERN_META_SERVER = `
process.stdin.setEncoding('utf-8');
let buf = '';
const seen = [];
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const req = JSON.parse(line);
    if (req.id === undefined || req.method === undefined) continue;
    seen.push({ id: req.id, method: req.method, meta: (req.params && req.params._meta) || null });
    if (req.method === 'initialize') { send({ jsonrpc: '2.0', id: req.id, error: { code: -32022, message: 'Unsupported protocol version', data: { supported: ['2026-07-28'] } } }); continue; }
    if (req.method === 'server/discover') { send({ jsonrpc: '2.0', id: req.id, result: { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {} } } }); continue; }
    if (req.method === 'tools/list') { send({ jsonrpc: '2.0', id: req.id, result: { resultType: 'complete', tools: [{ name: 'confirm', inputSchema: { type: 'object' } }] } }); continue; }
    if (req.method === 'tools/call' && !req.params.inputResponses) {
      send({ jsonrpc: '2.0', id: req.id, result: { resultType: 'input_required', requestState: 's1', inputRequests: { q: { method: 'elicitation/create', params: { message: 'Sure?', requestedSchema: { type: 'object', properties: { yes: { type: 'boolean' } } } } } } } });
      continue;
    }
    send({ jsonrpc: '2.0', id: req.id, result: { resultType: 'complete', structuredContent: { seen }, content: [] } });
  }
});
`;

describe("stdio client, MCP 2026-07-28: trace context in _meta", () => {
  const modernConfig = (mode: "auto" | "modern"): MCPServerConfig => ({
    serverId: "stdio_mcp",
    registryServerId: "srv_stdio",
    connection: { command: process.execPath, args: ["-e", MODERN_META_SERVER], timeoutMs: 5000, protocolMode: mode }
  });
  type Seen = { id: number; method: string; meta: Record<string, unknown> | null };

  it("merges the protocol keys and trace context into one _meta, and each later input round is a child span", async () => {
    const trace = new RecordingInstrumentation();
    const registry = createDefaultMCPRegistry({ instrument: trace });
    const config = modernConfig("modern");
    const context = contextOf({ onElicitation: async () => ({ action: "accept", content: { yes: true } }) });
    const adapter = registry.get("stdio_mcp");
    try {
      const out = await adapter.invokeTool("confirm", {}, config, context);
      expect(out).toMatchObject({ ok: true });
      const seen = (out.structured as { seen: Seen[] }).seen;
      const [outer, round2] = trace.named("tools/call confirm");
      expect(round2!.parent).toBe(outer);
      expect(round2!.info).toMatchObject({ method: "tools/call", target: "confirm", side: "client", round: 2, serverId: "srv_stdio" });
      expect(outer!.attributes["l2m.mcp.rounds"]).toBe(2);
      expect(outer!.attributes["mcp.protocol.version"]).toBe("2026-07-28");
      const calls = seen.filter((entry) => entry.method === "tools/call");
      expect(calls).toHaveLength(2);
      expect(calls.map((entry) => entry.meta!.traceparent)).toEqual([traceparentOf(outer!), traceparentOf(round2!)]);
      for (const call of calls) {
        expect(inspectRequestMeta({ _meta: call.meta })).toMatchObject({ era: "modern", protocolVersion: "2026-07-28" });
        expect(call.meta![MCP_META_CLIENT_CAPABILITIES]).toBeDefined();
      }
      expect(round2!.attributes["jsonrpc.request.id"]).toBe(String(calls[1]!.id));
      expect(seen.some((entry) => entry.method === "initialize")).toBe(false);
    } finally {
      await adapter.closeSessions?.(context);
    }
  });

  it("auto: the server/discover probe carries trace context too, and an opted-out server gets none", async () => {
    const trace = new RecordingInstrumentation();
    const registry = createDefaultMCPRegistry({ instrument: trace });
    const adapter = registry.get("stdio_mcp");
    const context = contextOf({ onElicitation: async () => ({ action: "accept", content: { yes: true } }) });
    try {
      const out = await adapter.invokeTool("confirm", {}, modernConfig("auto"), context);
      const seen = (out.structured as { seen: Seen[] }).seen;
      const probe = seen.find((entry) => entry.method === "server/discover")!;
      expect(probe.meta!.traceparent).toBe(traceparentOf(trace.named("tools/call confirm")[0]!));
      expect(probe.meta![MCP_META_PROTOCOL_VERSION]).toBe("2026-07-28");

      const optedOut = modernConfig("auto");
      optedOut.connection = { ...optedOut.connection, propagateTraceContext: false, cwd: process.cwd() };
      const quiet = await adapter.invokeTool("confirm", {}, optedOut, context);
      const quietSeen = (quiet.structured as { seen: Seen[] }).seen;
      expect(quietSeen.length).toBeGreaterThan(0);
      for (const entry of quietSeen) {
        expect(entry.meta).not.toBeNull();
        expect(entry.meta).not.toHaveProperty("traceparent");
      }
    } finally {
      await adapter.closeSessions?.(context);
    }
  });
});

/** An initialize-based stdio server that rejects anything before the handshake (so an `auto` probe fails). */
const LEGACY_ONLY_SERVER = `
process.stdin.setEncoding('utf-8');
let buf = '';
let ready = false;
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const req = JSON.parse(line);
    if (req.id === undefined) continue;
    if (req.method === 'initialize') { ready = true; send({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'old', version: '1' } } }); continue; }
    if (!ready) { send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } }); continue; }
    send({ jsonrpc: '2.0', id: req.id, result: { tools: [{ name: 'x', inputSchema: { type: 'object' } }] } });
  }
});
`;

describe("stdio client: the era probe and the handshake stay off the operation's span", () => {
  it("auto on an initialize-based server: no probe error code, and the handshake's version", async () => {
    const trace = new RecordingInstrumentation();
    const registry = createDefaultMCPRegistry({ instrument: trace });
    const adapter = registry.get("stdio_mcp");
    const config: MCPServerConfig = {
      serverId: "stdio_mcp",
      connection: { command: process.execPath, args: ["-e", LEGACY_ONLY_SERVER], timeoutMs: 5000, protocolMode: "auto" }
    };
    const context = contextOf();
    try {
      await adapter.discoverTools(config, context);
      const [list] = trace.named("tools/list");
      expect(list!.errorType).toBeUndefined();
      expect(list!.attributes["rpc.response.status_code"]).toBeUndefined();
      expect(list!.attributes["mcp.protocol.version"]).toBe("2025-06-18");
      // initialize is request 2 (the probe was 1), so tools/list is 3.
      expect(list!.attributes["jsonrpc.request.id"]).toBe("3");
    } finally {
      await adapter.closeSessions?.(context);
    }
  });
});
