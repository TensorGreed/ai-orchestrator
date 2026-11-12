import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { MCPServerConfig } from "@ai-orchestrator/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createRecordingRegistry, createReplayRegistry, McpCassetteRecorder } from "../cassette";
import { MCPRegistry } from "../registry";
import {
  MCP_META_CLIENT_CAPABILITIES,
  MCP_META_CLIENT_INFO,
  MCP_META_PROTOCOL_VERSION,
  headerLookupFrom,
  inspectRequestMeta,
  verifyMcpRequestHeaders,
  analyzeMcpHeaderAnnotations
} from "../protocol";
import type { MCPExecutionContext } from "../types";
import { HttpMCPServerAdapter } from "./http-mcp";

/**
 * MCP 2026-07-28 — the HTTP client against in-process legacy, modern-only and
 * dual-era servers: era detection per protocol mode, the era cache, request
 * `_meta` and headers, `x-mcp-header`, multi round-trip requests, the error
 * answers of modern servers, cancellation, the safe re-issue rule (D13), and
 * cassettes in both eras.
 */

interface Rpc {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

interface Seen {
  rpc: Rpc;
  headers: IncomingHttpHeaders;
}

type Reply =
  | { status?: number; json: unknown; headers?: Record<string, string> }
  | { status?: number; sse: unknown[]; headers?: Record<string, string> }
  | { status: number; text: string }
  | { destroy: true }
  | { hang: true };

type Handler = (rpc: Rpc, headers: IncomingHttpHeaders, seen: Seen[]) => Reply | Promise<Reply>;

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function startServer(handler: Handler): Promise<{ endpoint: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      const rpc = JSON.parse(body || "{}") as Rpc;
      seen.push({ rpc, headers: request.headers });
      const reply = await handler(rpc, request.headers, seen);
      send(response, reply);
    });
  });
  server.keepAliveTimeout = 1;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, seen };
}

function send(response: ServerResponse, reply: Reply): void {
  if ("destroy" in reply) {
    response.socket?.destroy();
    return;
  }
  if ("hang" in reply) return;
  if ("text" in reply) {
    response.statusCode = reply.status;
    response.end(reply.text);
    return;
  }
  response.statusCode = reply.status ?? 200;
  for (const [key, value] of Object.entries(reply.headers ?? {})) response.setHeader(key, value);
  if ("sse" in reply) {
    response.setHeader("content-type", "text/event-stream");
    response.end(reply.sse.map((message) => `data: ${JSON.stringify(message)}\n\n`).join(""));
    return;
  }
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(reply.json));
}

const ok = (rpc: Rpc, result: unknown): Reply => ({ json: { jsonrpc: "2.0", id: rpc.id, result } });
const rpcError = (rpc: Rpc, code: number, message: string, data?: unknown, status = 200): Reply => ({
  status,
  json: { jsonrpc: "2.0", id: rpc.id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } }
});

const TOOLS = [
  { name: "lookup", description: "Read-only lookup", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  { name: "write_row", description: "Writes a row", inputSchema: { type: "object" } },
  {
    name: "regional",
    description: "Runs in a region",
    inputSchema: { type: "object", properties: { region: { type: "string", "x-mcp-header": "Region" }, count: { type: "integer", "x-mcp-header": "Count" } } }
  },
  { name: "bad_header", description: "Invalid annotation", inputSchema: { type: "object", properties: { n: { type: "number", "x-mcp-header": "N" } } } }
];

/** What a modern-only server does with every request: verify `_meta` and headers, then call `answer`. */
function modernServer(answer: (rpc: Rpc, seen: Seen[]) => Reply | Promise<Reply>, options: { tools?: unknown[] } = {}): Handler {
  const tools = options.tools ?? TOOLS;
  return (rpc, headers, seen) => {
    const meta = inspectRequestMeta(rpc.params);
    if (meta.era !== "modern") {
      // A legacy request (initialize) misses the required headers.
      return rpcError(rpc, -32020, "Header mismatch: MCP-Protocol-Version header is required", undefined, 400);
    }
    if (meta.protocolVersion !== "2026-07-28") {
      return rpcError(rpc, -32022, "Unsupported protocol version", { supported: ["2026-07-28"], requested: meta.protocolVersion }, 400);
    }
    const tool = rpc.method === "tools/call" ? (tools as Array<{ name: string; inputSchema?: unknown }>).find((entry) => entry.name === rpc.params?.name) : undefined;
    const analysis = tool ? analyzeMcpHeaderAnnotations(tool.inputSchema) : undefined;
    const mismatch = verifyMcpRequestHeaders(
      headerLookupFrom(headers),
      { method: rpc.method ?? "", params: rpc.params ?? {} },
      analysis?.ok ? analysis.headers : undefined
    );
    if (mismatch) return rpcError(rpc, mismatch.code, mismatch.message, undefined, 400);
    if (rpc.method === "tools/list") return ok(rpc, { resultType: "complete", tools, ttlMs: 0, cacheScope: "private" });
    if (rpc.method === "server/discover") {
      return ok(rpc, {
        resultType: "complete",
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {}, resources: {}, prompts: {} },
        _meta: { "io.modelcontextprotocol/serverInfo": { name: "fake", version: "1" } }
      });
    }
    return answer(rpc, seen);
  };
}

/** A legacy server with sessions: requests without a session id get the classic 400. */
function legacyServer(answer: (rpc: Rpc, seen: Seen[]) => Reply | Promise<Reply> = (rpc) => ok(rpc, { content: [{ type: "text", text: "legacy" }] })): Handler {
  return (rpc, headers, seen) => {
    if (rpc.method === "initialize") {
      return { json: { jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {}, resources: {} } } }, headers: { "mcp-session-id": "sess-1" } };
    }
    if (headers["mcp-session-id"] !== "sess-1") {
      return rpcError(rpc, -32000, "Bad Request: Mcp-Session-Id header is required", undefined, 400);
    }
    if (rpc.method === "notifications/initialized" || rpc.method === "notifications/cancelled") return { status: 202, text: "" };
    if (rpc.method === "tools/list") return ok(rpc, { tools: TOOLS.slice(0, 2) });
    return answer(rpc, seen);
  };
}

/** A dual-era server: modern requests are served statelessly, initialize opens a legacy session. */
function dualEraServer(): Handler {
  const modern = modernServer((rpc) => ok(rpc, { resultType: "complete", content: [{ type: "text", text: "modern" }] }));
  const legacy = legacyServer();
  return (rpc, headers, seen) => (inspectRequestMeta(rpc.params).era === "modern" ? modern(rpc, headers, seen) : legacy(rpc, headers, seen));
}

const contextOf = (extra: Partial<MCPExecutionContext> = {}): MCPExecutionContext => ({
  resolveSecret: async () => undefined,
  runtimeState: new Map(),
  ...extra
});

const configFor = (endpoint: string, connection: Record<string, unknown> = {}): MCPServerConfig => ({
  serverId: "http_mcp",
  connection: { endpoint, ...connection }
});

const methods = (seen: Seen[]) => seen.map((entry) => entry.rpc.method);

describe("legacy mode (the default) with legacy servers: nothing changes on the wire", () => {
  it("opens with initialize and sends no 2026-07-28 metadata or headers", async () => {
    const { endpoint, seen } = await startServer(legacyServer());
    const adapter = new HttpMCPServerAdapter();
    const config = configFor(endpoint);
    const context = contextOf({ onProgress: () => undefined });
    await adapter.discoverTools(config, context);
    expect(await adapter.invokeTool("lookup", { q: 1 }, config, context)).toMatchObject({ ok: true, output: "legacy" });

    expect(methods(seen)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
    expect(seen[0].rpc.params).toEqual({
      protocolVersion: "2025-06-18",
      capabilities: { elicitation: {} },
      clientInfo: { name: "ai-orchestrator", version: "0.1.0" }
    });
    for (const entry of seen) {
      expect(entry.headers["mcp-method"]).toBeUndefined();
      expect(entry.headers["mcp-name"]).toBeUndefined();
      expect(JSON.stringify(entry.rpc.params ?? {})).not.toContain("io.modelcontextprotocol");
    }
    expect(seen[3].headers["mcp-session-id"]).toBe("sess-1");
    expect(seen[3].headers["mcp-protocol-version"]).toBe("2025-06-18");
    expect(Object.keys((seen[3].rpc.params?._meta as Record<string, unknown>) ?? {})).toEqual(["progressToken"]);
    expect(adapter.observedProtocol(config)).toBeUndefined();
  });

  it("uses initialize with a dual-era server and never probes", async () => {
    const { endpoint, seen } = await startServer(dualEraServer());
    const adapter = new HttpMCPServerAdapter();
    expect(await adapter.invokeTool("lookup", {}, configFor(endpoint), contextOf())).toMatchObject({ ok: true, output: "legacy" });
    expect(methods(seen)[0]).toBe("initialize");
    expect(methods(seen)).not.toContain("server/discover");
  });

  it("answers a server's elicitation on a legacy stream exactly as before", async () => {
    const { endpoint, seen } = await startServer(
      legacyServer((rpc) => {
        if (rpc.method === "tools/call") {
          return {
            sse: [
              { jsonrpc: "2.0", id: "elicit-1", method: "elicitation/create", params: { message: "Colour?", requestedSchema: { type: "object", properties: { c: { type: "string" } } } } },
              { jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: "done" }] } }
            ]
          };
        }
        return { status: 202, text: "" };
      })
    );
    const adapter = new HttpMCPServerAdapter();
    const result = await adapter.invokeTool("lookup", {}, configFor(endpoint), contextOf({ onElicitation: async () => ({ action: "accept", content: { c: "blue" } }) }));
    expect(result).toMatchObject({ ok: true, output: "done" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen.find((entry) => entry.rpc.id === "elicit-1")?.rpc.result).toEqual({ action: "accept", content: { c: "blue" } });
  });
});

describe("legacy mode with a modern-only server: fall-forward", () => {
  it("switches to 2026-07-28 when initialize is rejected with a modern error, and remembers it", async () => {
    const { endpoint, seen } = await startServer(modernServer((rpc) => ok(rpc, { resultType: "complete", content: [{ type: "text", text: "hi" }] })));
    const adapter = new HttpMCPServerAdapter();
    const config = configFor(endpoint);
    expect(await adapter.invokeTool("lookup", {}, config, contextOf())).toMatchObject({ ok: true, output: "hi" });
    expect(methods(seen)).toEqual(["initialize", "tools/list", "tools/call"]);

    seen.length = 0;
    expect(await adapter.invokeTool("lookup", {}, config, contextOf())).toMatchObject({ ok: true, output: "hi" });
    expect(methods(seen)).toEqual(["tools/list", "tools/call"]);
    expect(adapter.observedProtocol(config)).toEqual({ era: "modern", version: "2026-07-28" });
  });

  it("does not fall forward on a legacy server's own 400", async () => {
    const { endpoint } = await startServer((rpc) => rpcError(rpc, -32600, "nope", undefined, 400));
    const adapter = new HttpMCPServerAdapter();
    const result = await adapter.invokeTool("lookup", {}, configFor(endpoint), contextOf());
    expect(result).toMatchObject({ ok: false, errorKind: "transport" });
    expect(result.error).toMatch(/MCP HTTP 400/);
  });
});

describe("auto mode", () => {
  it("probes with server/discover, uses 2026-07-28 with a dual-era server and caches the era", async () => {
    const { endpoint, seen } = await startServer(dualEraServer());
    const adapter = new HttpMCPServerAdapter();
    const config = configFor(endpoint, { protocolMode: "auto" });
    const context = contextOf();
    expect(await adapter.describeServer(config, context)).toEqual({ tools: {}, resources: {}, prompts: {} });
    expect(await adapter.invokeTool("lookup", {}, config, context)).toMatchObject({ ok: true, output: "modern" });
    expect(methods(seen)).toEqual(["server/discover", "tools/list", "tools/call"]);

    seen.length = 0;
    await adapter.invokeTool("lookup", {}, config, contextOf());
    expect(methods(seen)).toEqual(["tools/list", "tools/call"]);
  });

  it("falls back to initialize with a legacy server and caches that too", async () => {
    const { endpoint, seen } = await startServer(legacyServer());
    const adapter = new HttpMCPServerAdapter();
    const config = configFor(endpoint, { protocolMode: "auto" });
    expect(await adapter.invokeTool("lookup", {}, config, contextOf())).toMatchObject({ ok: true, output: "legacy" });
    expect(methods(seen)).toEqual(["server/discover", "initialize", "notifications/initialized", "tools/call", "tools/list"]);
    expect(adapter.observedProtocol(config)).toEqual({ era: "legacy" });

    seen.length = 0;
    await adapter.invokeTool("lookup", {}, config, contextOf());
    expect(methods(seen)[0]).toBe("initialize");
  });

  it("treats a stateless legacy server that answers anything with {} as legacy", async () => {
    const { endpoint, seen } = await startServer((rpc) =>
      rpc.method === "initialize" ? ok(rpc, { protocolVersion: "2025-06-18", capabilities: {} }) : ok(rpc, rpc.method === "tools/call" ? { content: [{ type: "text", text: "s" }] } : {})
    );
    const adapter = new HttpMCPServerAdapter();
    expect(await adapter.invokeTool("x", {}, configFor(endpoint, { protocolMode: "auto" }), contextOf())).toMatchObject({ ok: true, output: "s" });
    expect(methods(seen).slice(0, 2)).toEqual(["server/discover", "initialize"]);
  });

  it("does not cache an era from a server error, and still reports the server's own error", async () => {
    const { endpoint, seen } = await startServer((rpc) => (rpc.method === "server/discover" || rpc.method === "initialize" ? { status: 403, text: "forbidden here" } : ok(rpc, {})));
    const adapter = new HttpMCPServerAdapter();
    const config = configFor(endpoint, { protocolMode: "auto" });
    const result = await adapter.invokeTool("lookup", {}, config, contextOf());
    expect(result).toMatchObject({ ok: false, errorKind: "transport" });
    expect(result.error).toBe("MCP HTTP 403: forbidden here");
    expect(adapter.observedProtocol(config)).toBeUndefined();
    expect(methods(seen).slice(0, 2)).toEqual(["server/discover", "initialize"]);
  });

  it("goes on with initialize when the probe gets no answer in time or an empty one, without caching", async () => {
    for (const probeReply of [{ hang: true } as Reply, { status: 202, text: "" } as Reply]) {
      const legacyHandler = legacyServer();
      const { endpoint, seen } = await startServer((rpc, headers, all) => (rpc.method === "server/discover" ? probeReply : legacyHandler(rpc, headers, all)));
      const adapter = new HttpMCPServerAdapter();
      const config = configFor(endpoint, { protocolMode: "auto", timeoutMs: 1000 });
      expect(await adapter.invokeTool("lookup", {}, config, contextOf())).toMatchObject({ ok: true, output: "legacy" });
      expect(methods(seen).slice(0, 2)).toEqual(["server/discover", "initialize"]);
      expect(adapter.observedProtocol(config)).toBeUndefined();
    }
  });

  it("caches legacy when server/discover is answered with method not found at HTTP 200", async () => {
    const legacyHandler = legacyServer();
    const { endpoint, seen } = await startServer((rpc, headers, all) =>
      rpc.method === "server/discover" ? rpcError(rpc, -32601, "Method not found") : legacyHandler(rpc, headers, all)
    );
    const adapter = new HttpMCPServerAdapter();
    const config = configFor(endpoint, { protocolMode: "auto" });
    await adapter.invokeTool("lookup", {}, config, contextOf());
    seen.length = 0;
    await adapter.invokeTool("lookup", {}, config, contextOf());
    expect(methods(seen)).not.toContain("server/discover");
  });

  it("falls back to initialize when a cached modern server starts answering like a legacy one", async () => {
    let modern = true;
    const modernHandler = modernServer((rpc) => ok(rpc, { resultType: "complete", content: [{ type: "text", text: "modern" }] }));
    const legacyHandler = legacyServer();
    const { endpoint, seen } = await startServer((rpc, headers, all) => (modern ? modernHandler(rpc, headers, all) : legacyHandler(rpc, headers, all)));
    const adapter = new HttpMCPServerAdapter();
    const config = configFor(endpoint, { protocolMode: "auto" });
    expect(await adapter.invokeTool("lookup", {}, config, contextOf())).toMatchObject({ output: "modern" });
    modern = false;
    seen.length = 0;
    expect(await adapter.invokeTool("lookup", {}, config, contextOf())).toMatchObject({ ok: true, output: "legacy" });
    expect(methods(seen)).toEqual(["tools/list", "initialize", "notifications/initialized", "tools/call", "tools/list"]);
    expect(adapter.observedProtocol(config)).toBeUndefined();
  });

  it("goes legacy when a modern answer lists only initialize-based versions", async () => {
    const legacyHandler = legacyServer();
    const { endpoint, seen } = await startServer((rpc, headers, all) =>
      inspectRequestMeta(rpc.params).era === "modern"
        ? rpcError(rpc, -32022, "Unsupported protocol version", { supported: ["2025-11-25"], requested: "2026-07-28" }, 400)
        : legacyHandler(rpc, headers, all)
    );
    const adapter = new HttpMCPServerAdapter();
    expect(await adapter.invokeTool("lookup", {}, configFor(endpoint, { protocolMode: "auto" }), contextOf())).toMatchObject({ ok: true, output: "legacy" });
    expect(methods(seen).slice(0, 2)).toEqual(["server/discover", "initialize"]);
  });
});

describe("modern mode", () => {
  it("sends _meta, the standard headers and Mcp-Param headers on every request, with no session", async () => {
    const { endpoint, seen } = await startServer(modernServer((rpc) => ok(rpc, { resultType: "complete", content: [{ type: "text", text: "ran" }] })));
    const adapter = new HttpMCPServerAdapter();
    const config = configFor(endpoint, { protocolMode: "modern", headers: { "x-custom": "1" } });
    const context = contextOf({ onProgress: () => undefined, onSampling: async () => ({ role: "assistant", content: { type: "text", text: "" }, model: "m" }) });
    expect(await adapter.invokeTool("regional", { region: "eu-west", count: 3, other: "x" }, config, context)).toMatchObject({ ok: true, output: "ran" });

    expect(methods(seen)).toEqual(["tools/list", "tools/call"]);
    const call = seen[1];
    expect(call.headers).toMatchObject({
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": "regional",
      "mcp-param-region": "eu-west",
      "mcp-param-count": "3",
      "x-custom": "1"
    });
    expect(call.headers["mcp-session-id"]).toBeUndefined();
    const meta = call.rpc.params?._meta as Record<string, unknown>;
    expect(meta[MCP_META_PROTOCOL_VERSION]).toBe("2026-07-28");
    expect(meta[MCP_META_CLIENT_CAPABILITIES]).toEqual({ elicitation: {}, sampling: {} });
    expect(meta[MCP_META_CLIENT_INFO]).toEqual({ name: "ai-orchestrator", version: "0.1.0" });
    expect(typeof meta.progressToken).toBe("string");
    expect(seen[0].headers["mcp-method"]).toBe("tools/list");
    expect(seen[0].headers["mcp-name"]).toBeUndefined();
  });

  it("encodes a non-ASCII tool name in Mcp-Name", async () => {
    const tools = [{ name: "café", description: "x", inputSchema: { type: "object" } }];
    const { seen, endpoint } = await startServer(modernServer((rpc) => ok(rpc, { content: [{ type: "text", text: "ok" }] }), { tools }));
    const adapter = new HttpMCPServerAdapter();
    expect(await adapter.invokeTool("café", {}, configFor(endpoint, { protocolMode: "modern" }), contextOf())).toMatchObject({ ok: true });
    expect(seen[1].headers["mcp-name"]).toBe(`=?base64?${Buffer.from("café").toString("base64")}?=`);
  });

  it("leaves out tools with invalid x-mcp-header annotations, warns, and refuses to call them", async () => {
    const { endpoint } = await startServer(modernServer((rpc) => ok(rpc, { content: [] })));
    const warnings: string[] = [];
    const adapter = new HttpMCPServerAdapter({ protocol: { warn: (message) => warnings.push(message) } });
    const config = configFor(endpoint, { protocolMode: "modern" });
    const context = contextOf();
    const tools = await adapter.discoverTools(config, context);
    expect(tools.map((tool) => tool.name)).toEqual(["lookup", "write_row", "regional"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/'bad_header' left out/);
    const call = await adapter.invokeTool("bad_header", { n: 1 }, config, context);
    expect(call).toMatchObject({ ok: false, errorKind: "protocol" });
    expect(call.error).toMatch(/x-mcp-header/);
  });

  it("lists the tools again and retries once after a HeaderMismatch", async () => {
    let annotated = false;
    const tools = () => [
      { name: "regional", description: "x", inputSchema: { type: "object", properties: { region: annotated ? { type: "string", "x-mcp-header": "Region" } : { type: "string" } } } }
    ];
    const { endpoint, seen } = await startServer((rpc, headers, all) => {
      const handler = modernServer((inner) => ok(inner, { content: [{ type: "text", text: "done" }] }), { tools: tools() });
      const reply = handler(rpc, headers, all);
      if (rpc.method === "tools/list" && !annotated && all.filter((entry) => entry.rpc.method === "tools/list").length === 1) annotated = true;
      return reply;
    });
    const adapter = new HttpMCPServerAdapter();
    const result = await adapter.invokeTool("regional", { region: "us" }, configFor(endpoint, { protocolMode: "modern" }), contextOf());
    expect(result).toMatchObject({ ok: true, output: "done" });
    expect(methods(seen)).toEqual(["tools/list", "tools/call", "tools/list", "tools/call"]);
    expect(seen[1].headers["mcp-param-region"]).toBeUndefined();
    expect(seen[3].headers["mcp-param-region"]).toBe("us");
    expect(seen[3].rpc.id).not.toBe(seen[1].rpc.id);
  });

  it("reports a 4xx JSON-RPC error on a proven modern connection as the server's error, without switching era", async () => {
    let calls = 0;
    const { endpoint, seen } = await startServer(
      modernServer((rpc) => {
        calls += 1;
        return calls === 1 ? rpcError(rpc, -32603, "Internal hiccup", undefined, 400) : rpcError(rpc, -32602, "Invalid arguments: q", undefined, 400);
      })
    );
    const adapter = new HttpMCPServerAdapter();
    const config = configFor(endpoint, { protocolMode: "auto" });
    const context = contextOf();
    const first = await adapter.invokeTool("lookup", {}, config, context);
    expect(first).toMatchObject({ ok: false, errorKind: "protocol", error: "Internal hiccup" });
    const second = await adapter.invokeTool("lookup", {}, config, context);
    expect(second).toMatchObject({ ok: false, errorKind: "invalid_arguments", error: "Invalid arguments: q" });
    expect(methods(seen)).not.toContain("initialize");
  });

  it("fails with an actionable error against a legacy server", async () => {
    const { endpoint, seen } = await startServer(legacyServer());
    const adapter = new HttpMCPServerAdapter();
    const result = await adapter.invokeTool("lookup", {}, configFor(endpoint, { protocolMode: "modern" }), contextOf());
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/does not speak MCP 2026-07-28.*Legacy or Auto/);
    expect(methods(seen)).not.toContain("initialize");
  });

  it("names the versions when no version is shared, keeping the error data", async () => {
    const { endpoint } = await startServer((rpc) => rpcError(rpc, -32022, "Unsupported protocol version", { supported: ["2099-01-01"], requested: "2026-07-28" }, 400));
    const adapter = new HttpMCPServerAdapter();
    const result = await adapter.invokeTool("lookup", {}, configFor(endpoint, { protocolMode: "modern" }), contextOf());
    expect(result).toMatchObject({ ok: false, errorKind: "protocol" });
    expect(result.error).toMatch(/supports protocol versions 2099-01-01/);
  });

  it("reports a missing client capability (-32021) as a setup problem naming it", async () => {
    const { endpoint } = await startServer(
      modernServer((rpc) => rpcError(rpc, -32021, "Missing required client capability", { requiredCapabilities: { sampling: {} } }, 400))
    );
    const adapter = new HttpMCPServerAdapter();
    const result = await adapter.invokeTool("lookup", {}, configFor(endpoint, { protocolMode: "modern" }), contextOf());
    expect(result).toMatchObject({ ok: false, errorKind: "tool" });
    expect(result.error).toMatch(/needs the client capability sampling/);
  });

  it("rejects a result with an unknown resultType", async () => {
    const { endpoint } = await startServer(modernServer((rpc) => ok(rpc, { resultType: "task", task: {} })));
    const adapter = new HttpMCPServerAdapter();
    const result = await adapter.invokeTool("lookup", {}, configFor(endpoint, { protocolMode: "modern" }), contextOf());
    expect(result).toMatchObject({ ok: false, errorKind: "protocol" });
    expect(result.error).toMatch(/resultType 'task'/);
  });

  it("ignores a server request on a modern response stream instead of answering it", async () => {
    const { endpoint, seen } = await startServer(
      modernServer((rpc) => ({
        sse: [
          { jsonrpc: "2.0", id: "srv-1", method: "ping" },
          { jsonrpc: "2.0", id: rpc.id, result: { resultType: "complete", content: [{ type: "text", text: "fine" }] } }
        ]
      }))
    );
    const adapter = new HttpMCPServerAdapter();
    expect(await adapter.invokeTool("lookup", {}, configFor(endpoint, { protocolMode: "modern" }), contextOf())).toMatchObject({ ok: true, output: "fine" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen.some((entry) => entry.rpc.id === "srv-1")).toBe(false);
  });

  it("gets capabilities from server/discover, lists resources and maps resource not found (-32602)", async () => {
    const { endpoint, seen } = await startServer(
      modernServer((rpc) => {
        if (rpc.method === "resources/list") return ok(rpc, { resultType: "complete", resources: [{ uri: "doc://a", name: "a" }], ttlMs: 0, cacheScope: "private" });
        if (rpc.method === "resources/read") return rpcError(rpc, -32602, "Resource not found", { uri: rpc.params?.uri });
        return ok(rpc, {});
      })
    );
    const adapter = new HttpMCPServerAdapter();
    const config = configFor(endpoint, { protocolMode: "modern" });
    const context = contextOf();
    expect(await adapter.listResources!(config, context)).toEqual([{ uri: "doc://a", name: "a" }]);
    expect(methods(seen)).toEqual(["server/discover", "resources/list"]);
    expect(seen[1].headers["mcp-name"]).toBeUndefined();
    await expect(adapter.readResource!("doc://missing", config, context)).rejects.toThrow(/MCP resource not found: doc:\/\/missing/);
    expect(seen[2].headers["mcp-name"]).toBe("doc://missing");
  });
});

describe("multi round-trip requests", () => {
  it("answers an elicitation and a sampling request, echoing requestState exactly with a new id", async () => {
    const { endpoint, seen } = await startServer(
      modernServer((rpc) => {
        if (rpc.method !== "tools/call") return ok(rpc, {});
        const responses = rpc.params?.inputResponses as Record<string, unknown> | undefined;
        if (!responses) {
          return ok(rpc, {
            resultType: "input_required",
            inputRequests: {
              who: { method: "elicitation/create", params: { message: "Your name?", requestedSchema: { type: "object", properties: { name: { type: "string" } } } } },
              summary: { method: "sampling/createMessage", params: { messages: [{ role: "user", content: { type: "text", text: "Summarise" } }], maxTokens: 20 } }
            },
            requestState: "opaque+/= state"
          });
        }
        return ok(rpc, { resultType: "complete", content: [{ type: "text", text: JSON.stringify(responses) }] });
      })
    );
    const adapter = new HttpMCPServerAdapter();
    const context = contextOf({
      onElicitation: async () => ({ action: "accept", content: { name: "Ada" } }),
      onSampling: async () => ({ role: "assistant", content: { type: "text", text: "short" }, model: "m1" })
    });
    const result = await adapter.invokeTool("lookup", { q: 1 }, configFor(endpoint, { protocolMode: "modern" }), context);
    expect(result.ok).toBe(true);
    expect(JSON.parse(String(result.output))).toEqual({
      who: { action: "accept", content: { name: "Ada" } },
      summary: { role: "assistant", content: { type: "text", text: "short" }, model: "m1" }
    });
    const calls = seen.filter((entry) => entry.rpc.method === "tools/call");
    expect(calls).toHaveLength(2);
    expect(calls[1].rpc.id).not.toBe(calls[0].rpc.id);
    expect(calls[1].rpc.params?.requestState).toBe("opaque+/= state");
    expect(calls[0].rpc.params).not.toHaveProperty("requestState");
    expect(calls[1].rpc.params?.arguments).toEqual({ q: 1 });
    expect(calls[1].headers["mcp-name"]).toBe("lookup");
  });

  it("stops after the round limit", async () => {
    const { endpoint } = await startServer(modernServer((rpc) => ok(rpc, { resultType: "input_required", requestState: "again" })));
    const adapter = new HttpMCPServerAdapter({ protocol: { mrtrMaxRounds: 2 } });
    const result = await adapter.invokeTool("lookup", {}, configFor(endpoint, { protocolMode: "modern" }), contextOf());
    expect(result).toMatchObject({ ok: false, errorKind: "protocol" });
    expect(result.error).toMatch(/stopped after 2 rounds/);
  });

  it("runs prompts/get through input rounds too", async () => {
    const { endpoint } = await startServer(
      modernServer((rpc) =>
        rpc.params?.requestState === "p1"
          ? ok(rpc, { resultType: "complete", messages: [{ role: "user", content: { type: "text", text: "prompt body" } }] })
          : ok(rpc, { resultType: "input_required", requestState: "p1" })
      )
    );
    const adapter = new HttpMCPServerAdapter();
    const prompt = await adapter.getPrompt!("p", {}, configFor(endpoint, { protocolMode: "modern" }), contextOf());
    expect(prompt.messages).toHaveLength(1);
  });
});

describe("cancellation", () => {
  it("only closes the stream on a modern server, and still sends notifications/cancelled to a legacy one", async () => {
    for (const era of ["modern", "legacy"] as const) {
      const handler = era === "modern" ? modernServer(() => ({ hang: true })) : legacyServer((rpc) => (rpc.method === "tools/call" ? { hang: true } : { status: 202, text: "" }));
      const { endpoint, seen } = await startServer(handler);
      const adapter = new HttpMCPServerAdapter();
      const controller = new AbortController();
      const pending = adapter.invokeTool("lookup", {}, configFor(endpoint, { protocolMode: era }), contextOf({ signal: controller.signal }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      controller.abort(new Error("stop"));
      expect(await pending).toMatchObject({ ok: false, errorKind: "canceled" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(methods(seen).includes("notifications/cancelled")).toBe(era === "legacy");
    }
  });
});

describe("re-issuing after a broken connection (D13)", () => {
  function brokenOnce(era: "modern" | "legacy", breakWith: Reply) {
    let broken = false;
    const answer = (rpc: Rpc): Reply => {
      if (rpc.method === "tools/call" && !broken) {
        broken = true;
        return breakWith;
      }
      return ok(rpc, { content: [{ type: "text", text: "ran" }] });
    };
    return era === "modern" ? modernServer(answer) : legacyServer((rpc) => (rpc.method === "tools/call" ? answer(rpc) : { status: 202, text: "" }));
  }

  const toolCalls = (seen: Seen[]) => seen.filter((entry) => entry.rpc.method === "tools/call");

  it("modern: sends a read-only tool call again with a new id after the stream broke", async () => {
    const { endpoint, seen } = await startServer(brokenOnce("modern", { sse: [] }));
    const adapter = new HttpMCPServerAdapter();
    expect(await adapter.invokeTool("lookup", {}, configFor(endpoint, { protocolMode: "modern" }), contextOf())).toMatchObject({ ok: true, output: "ran" });
    const calls = toolCalls(seen);
    expect(calls).toHaveLength(2);
    expect(calls[1].rpc.id).not.toBe(calls[0].rpc.id);
  });

  it("modern: a tool without read-only or idempotent hints fails as outcome_unknown and is sent once", async () => {
    const { endpoint, seen } = await startServer(brokenOnce("modern", { sse: [] }));
    const adapter = new HttpMCPServerAdapter();
    const result = await adapter.invokeTool("write_row", {}, configFor(endpoint, { protocolMode: "modern" }), contextOf());
    expect(result).toMatchObject({ ok: false, errorKind: "outcome_unknown" });
    expect(result.error).toMatch(/may or may not have run/);
    expect(toolCalls(seen)).toHaveLength(1);
  });

  it("modern: a gateway error (502) on a write is an unknown outcome; a busy answer (503) on a read is retried with a new id", async () => {
    const write = await startServer(brokenOnce("modern", { status: 502, text: "bad gateway" }));
    const adapter = new HttpMCPServerAdapter();
    const writeResult = await adapter.invokeTool("write_row", {}, configFor(write.endpoint, { protocolMode: "modern" }), contextOf());
    expect(writeResult).toMatchObject({ ok: false, errorKind: "outcome_unknown" });
    expect(toolCalls(write.seen)).toHaveLength(1);

    const read = await startServer(brokenOnce("modern", { status: 503, text: "busy" }));
    expect(await adapter.invokeTool("lookup", {}, configFor(read.endpoint, { protocolMode: "modern" }), contextOf())).toMatchObject({ ok: true });
    const calls = toolCalls(read.seen);
    expect(calls).toHaveLength(2);
    expect(calls[1].rpc.id).not.toBe(calls[0].rpc.id);
  });

  it("legacy: remembers which tools are read-only across sessions, so a new run's call is still sent again", async () => {
    const { endpoint, seen } = await startServer(brokenOnce("legacy", { destroy: true }));
    const adapter = new HttpMCPServerAdapter();
    const config = configFor(endpoint);
    await adapter.discoverTools(config, contextOf());
    expect(await adapter.invokeTool("lookup", {}, config, contextOf())).toMatchObject({ ok: true, output: "ran" });
    expect(toolCalls(seen)).toHaveLength(2);
  });

  it("legacy: with the rule off, a timed-out write is sent again exactly as before", async () => {
    const { endpoint, seen } = await startServer(legacyServer((rpc) => (rpc.method === "tools/call" ? { hang: true } : { status: 202, text: "" })));
    const adapter = new HttpMCPServerAdapter({ protocol: { legacySafeReissue: false } });
    const result = await adapter.invokeTool("write_row", {}, configFor(endpoint), contextOf({ callTimeoutMs: 100 }));
    expect(result).toMatchObject({ ok: false, errorKind: "timeout" });
    // Three attempts, then three more on a fresh session.
    expect(toolCalls(seen)).toHaveLength(6);
  }, 20_000);

  it("legacy: a write is not sent again after the connection drops (safe re-issue on by default)", async () => {
    const { endpoint, seen } = await startServer(brokenOnce("legacy", { destroy: true }));
    const adapter = new HttpMCPServerAdapter();
    const config = configFor(endpoint);
    const context = contextOf();
    await adapter.discoverTools(config, context);
    const result = await adapter.invokeTool("write_row", {}, config, context);
    expect(result).toMatchObject({ ok: false, errorKind: "outcome_unknown" });
    expect(toolCalls(seen)).toHaveLength(1);
  });

  it("legacy: a read-only tool is still sent again", async () => {
    const { endpoint, seen } = await startServer(brokenOnce("legacy", { destroy: true }));
    const adapter = new HttpMCPServerAdapter();
    const config = configFor(endpoint);
    const context = contextOf();
    await adapter.discoverTools(config, context);
    expect(await adapter.invokeTool("lookup", {}, config, context)).toMatchObject({ ok: true, output: "ran" });
    expect(toolCalls(seen)).toHaveLength(2);
  });

  it("legacy: turning the rule off restores sending every call again", async () => {
    const { endpoint, seen } = await startServer(brokenOnce("legacy", { destroy: true }));
    const adapter = new HttpMCPServerAdapter({ protocol: { legacySafeReissue: false } });
    const config = configFor(endpoint);
    const context = contextOf();
    await adapter.discoverTools(config, context);
    expect(await adapter.invokeTool("write_row", {}, config, context)).toMatchObject({ ok: true, output: "ran" });
    expect(toolCalls(seen)).toHaveLength(2);
  });

  it("legacy: a timed-out write is not sent again, and the server is told to stop", async () => {
    const { endpoint, seen } = await startServer(legacyServer((rpc) => (rpc.method === "tools/call" ? { hang: true } : { status: 202, text: "" })));
    const adapter = new HttpMCPServerAdapter();
    const result = await adapter.invokeTool("write_row", {}, configFor(endpoint), contextOf({ callTimeoutMs: 150 }));
    expect(result).toMatchObject({ ok: false, errorKind: "timeout" });
    expect(toolCalls(seen)).toHaveLength(1);
    expect(methods(seen)).toContain("notifications/cancelled");
  });
});

describe("cassettes in both eras", () => {
  it("records a modern run with an input round and replays it offline", async () => {
    const { endpoint } = await startServer(
      modernServer((rpc) =>
        rpc.params?.inputResponses
          ? ok(rpc, { resultType: "complete", content: [{ type: "text", text: "confirmed" }] })
          : ok(rpc, {
              resultType: "input_required",
              inputRequests: { ok: { method: "elicitation/create", params: { message: "Sure?", requestedSchema: { type: "object", properties: { yes: { type: "boolean" } } } } } }
            })
      )
    );
    const live = new MCPRegistry();
    live.register(new HttpMCPServerAdapter());
    const recorder = new McpCassetteRecorder();
    const recording = createRecordingRegistry(live, recorder);
    const config = configFor(endpoint, { protocolMode: "modern" });
    const context = contextOf({ onElicitation: async () => ({ action: "accept", content: { yes: true } }) });
    await recording.get("http_mcp").discoverTools(config, context);
    const recorded = await recording.get("http_mcp").invokeTool("write_row", {}, config, context);
    expect(recorded).toMatchObject({ ok: true, output: "confirmed" });
    const cassette = recorder.toCassette();
    expect(cassette.entries.map((entry) => entry.method)).toEqual(["tools/list", "tools/call"]);
    expect(cassette.entries[1].exchanges?.[0]).toMatchObject({ kind: "elicitation", response: { action: "accept", content: { yes: true } } });

    const { registry } = createReplayRegistry(cassette, { mode: "strict" });
    expect(await registry.get("http_mcp").invokeTool("write_row", {}, config, contextOf())).toEqual(recorded);
  });

  it("records and replays a legacy run unchanged", async () => {
    const { endpoint } = await startServer(legacyServer());
    const live = new MCPRegistry();
    live.register(new HttpMCPServerAdapter());
    const recorder = new McpCassetteRecorder();
    const recording = createRecordingRegistry(live, recorder);
    const config = configFor(endpoint);
    const recorded = await recording.get("http_mcp").invokeTool("lookup", {}, config, contextOf());
    const { registry } = createReplayRegistry(recorder.toCassette(), { mode: "strict" });
    expect(await registry.get("http_mcp").invokeTool("lookup", {}, config, contextOf())).toEqual(recorded);
  });
});
