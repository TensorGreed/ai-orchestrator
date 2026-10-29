// Mock MCP server (streamable HTTP, JSON responses) for the scale harness. Dependency-free: `node mock-mcp.mjs`.
//
// POST /mcp   JSON-RPC: initialize, notifications/*, ping, tools/list, tools/call (after a configurable delay)
// DELETE /mcp ends a session (always 200)
// GET  /stats tool-call counters;  POST /stats/reset clears them
// GET  /health liveness
//
// Tools: lookup_order(order_id), get_weather(city), add_numbers(a, b).
// Settings (environment): PORT (8081), MCP_LATENCY_MS (50), MCP_JITTER_MS (20).

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const intFromEnv = (name, fallback) => {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

const PORT = intFromEnv("PORT", 8081);
const LATENCY_MS = intFromEnv("MCP_LATENCY_MS", 50);
const JITTER_MS = intFromEnv("MCP_JITTER_MS", 20);
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const TOOLS = [
  {
    name: "lookup_order",
    description: "Look up an order by id and return its status.",
    inputSchema: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
    annotations: { readOnlyHint: true }
  },
  {
    name: "get_weather",
    description: "Current weather for a city.",
    inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    annotations: { readOnlyHint: true }
  },
  {
    name: "add_numbers",
    description: "Add two numbers.",
    inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
    annotations: { readOnlyHint: true }
  }
];

const stats = { initialize: 0, toolsList: 0, toolCalls: 0, byTool: {}, errors: 0 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jittered = () => Math.max(0, LATENCY_MS + Math.round((Math.random() * 2 - 1) * JITTER_MS));

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(response, status, body, headers = {}) {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers });
  response.end(text);
}

function toolResult(name, args) {
  switch (name) {
    case "lookup_order":
      return `order ${String(args.order_id ?? "unknown")}: shipped`;
    case "get_weather":
      return `weather in ${String(args.city ?? "somewhere")}: 18C, clear`;
    case "add_numbers":
      return String(Number(args.a ?? 0) + Number(args.b ?? 0));
    default:
      return null;
  }
}

async function handleRpc(rpc) {
  const id = rpc?.id ?? null;
  const method = typeof rpc?.method === "string" ? rpc.method : "";
  if (method.startsWith("notifications/")) return undefined;
  switch (method) {
    case "initialize":
      stats.initialize += 1;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: typeof rpc.params?.protocolVersion === "string" ? rpc.params.protocolVersion : "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "l2m-loadtest-mock-mcp", version: "1.0.0" }
        }
      };
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      stats.toolsList += 1;
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    case "tools/call": {
      const name = String(rpc.params?.name ?? "");
      const args = rpc.params?.arguments && typeof rpc.params.arguments === "object" ? rpc.params.arguments : {};
      await sleep(jittered());
      const text = toolResult(name, args);
      if (text === null) {
        stats.errors += 1;
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true } };
      }
      stats.toolCalls += 1;
      stats.byTool[name] = (stats.byTool[name] ?? 0) + 1;
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } };
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://mock-mcp");
  try {
    if (url.pathname === "/mcp") {
      if (request.method === "DELETE") {
        sendJson(response, 200, {});
        return;
      }
      if (request.method !== "POST") {
        sendJson(response, 405, { error: "POST only" }, { allow: "POST, DELETE" });
        return;
      }
      let rpc;
      try {
        rpc = JSON.parse((await readBody(request)) || "{}");
      } catch {
        stats.errors += 1;
        sendJson(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        return;
      }
      const sessionHeader = rpc?.method === "initialize"
        ? { "mcp-session-id": randomUUID() }
        : {};
      if (Array.isArray(rpc)) {
        const results = (await Promise.all(rpc.map((entry) => handleRpc(entry)))).filter((entry) => entry !== undefined);
        if (results.length === 0) {
          response.writeHead(202).end();
          return;
        }
        sendJson(response, 200, results, sessionHeader);
        return;
      }
      const result = await handleRpc(rpc);
      if (result === undefined) {
        response.writeHead(202).end();
        return;
      }
      sendJson(response, 200, result, sessionHeader);
      return;
    }
    if (url.pathname === "/stats/reset" && request.method === "POST") {
      stats.initialize = 0;
      stats.toolsList = 0;
      stats.toolCalls = 0;
      stats.byTool = {};
      stats.errors = 0;
      sendJson(response, 200, { ok: true });
      return;
    }
    if (url.pathname === "/stats" && request.method === "GET") {
      sendJson(response, 200, { ...stats, settings: { LATENCY_MS, JITTER_MS } });
      return;
    }
    if (url.pathname === "/health") {
      sendJson(response, 200, { ok: true });
      return;
    }
    sendJson(response, 404, { error: `no route for ${request.method} ${url.pathname}` });
  } catch (error) {
    stats.errors += 1;
    if (!response.headersSent) sendJson(response, 500, { error: String(error?.message ?? error) });
    else response.end();
  }
});

server.keepAliveTimeout = 65_000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`mock-mcp listening on :${PORT} (latency ${LATENCY_MS}±${JITTER_MS} ms, ${TOOLS.length} tools)`);
});

const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
