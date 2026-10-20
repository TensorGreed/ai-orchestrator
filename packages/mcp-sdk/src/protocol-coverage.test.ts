/**
 * Phase 10.5 — protocol coverage on the client side: annotations and
 * outputSchema from tools/list, structuredContent validation, progress
 * notifications and cancellation, for both the http and the stdio adapter.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { McpToolPolicyRule, McpToolProgressEvent, MCPServerConfig } from "@ai-orchestrator/shared";
import { HttpMCPServerAdapter } from "./adapters/http-mcp";
import { StdioMCPServerAdapter } from "./adapters/stdio-mcp";
import { diffToolSnapshots, hashToolSnapshot, normalizeToolSnapshot, type McpToolSnapshotEntry } from "./schema-diff";
import { buildToolCallResult, checkStructuredContent, toAgentToolOutput } from "./structured-output";
import { parseProgressNotification } from "./progress";
import { effectiveToolHints, evaluateMcpToolAccess, evaluateMcpToolPolicy, isStrictlyNarrower } from "./tool-policy";
import type { MCPExecutionContext } from "./types";

const OUTPUT_SCHEMA = {
  type: "object",
  properties: { temperature: { type: "number" }, unit: { type: "string", enum: ["C", "F"] } },
  required: ["temperature", "unit"]
};

const TOOLS = [
  {
    name: "weather",
    description: "Current weather",
    inputSchema: { type: "object", properties: { city: { type: "string" } } },
    outputSchema: OUTPUT_SCHEMA,
    annotations: { title: "Weather", readOnlyHint: true, openWorldHint: true }
  },
  {
    name: "drop_table",
    description: "Drops a table",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  },
  { name: "plain", description: "No extras", inputSchema: { type: "object" } }
];

/** Results by tool name, shared by the http and stdio fakes. */
const CALL_RESULTS: Record<string, unknown> = {
  weather: {
    content: [{ type: "text", text: '{"temperature":21.5,"unit":"C"}' }],
    structuredContent: { temperature: 21.5, unit: "C" }
  },
  weather_bad: { content: [{ type: "text", text: "{}" }], structuredContent: { temperature: "hot" } },
  plain: { content: [{ type: "text", text: "plain text" }] }
};

// ---------------------------------------------------------------------------
// HTTP fake: JSON for most calls, SSE with progress for `slow`, never answers `hang`.
// ---------------------------------------------------------------------------

interface ReceivedMessage {
  method?: string;
  id?: unknown;
  params?: Record<string, unknown>;
}

let httpServer: Server;
let endpoint = "";
const received: ReceivedMessage[] = [];
const openResponses = new Set<ServerResponse>();

function handleRpc(request: IncomingMessage, response: ServerResponse) {
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    const rpc = JSON.parse(body || "{}") as ReceivedMessage;
    received.push(rpc);
    const reply = (result: unknown) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    };
    if (rpc.id === undefined) {
      response.statusCode = 202;
      response.end();
      return;
    }
    if (rpc.method === "initialize") {
      response.setHeader("mcp-session-id", "sess-1");
      reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} } });
      return;
    }
    if (rpc.method === "tools/list") {
      reply({ tools: TOOLS.concat([{ name: "weather_bad", description: "Broken", inputSchema: { type: "object" }, outputSchema: OUTPUT_SCHEMA } as never]) });
      return;
    }
    if (rpc.method === "tools/call") {
      const name = String(rpc.params?.name ?? "");
      const token = (rpc.params?._meta as { progressToken?: string } | undefined)?.progressToken;
      if (name === "slow") {
        response.setHeader("content-type", "text/event-stream");
        response.write(
          `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: 2, total: 5, message: "indexing" } })}\n\n`
        );
        // A progress message for another request must be ignored.
        response.write(
          `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "someone-else", progress: 9 } })}\n\n`
        );
        setTimeout(() => {
          response.write(
            `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: 5, total: 5 } })}\n\n`
          );
          response.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: "done" }] } })}\n\n`);
        }, 30);
        return;
      }
      if (name === "hang") {
        response.setHeader("content-type", "text/event-stream");
        response.write(": waiting\n\n");
        openResponses.add(response);
        response.on("close", () => openResponses.delete(response));
        return;
      }
      reply(CALL_RESULTS[name] ?? { content: [{ type: "text", text: "ok" }] });
      return;
    }
    reply({});
  });
}

beforeAll(async () => {
  httpServer = createServer(handleRpc);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  for (const response of openResponses) response.destroy();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

afterEach(() => {
  received.length = 0;
});

function httpConfig(): MCPServerConfig {
  return { serverId: "http_mcp", connection: { endpoint } };
}

function makeContext(extra: Partial<MCPExecutionContext> = {}): MCPExecutionContext {
  return { resolveSecret: async () => undefined, runtimeState: new Map<string, unknown>(), ...extra };
}

// ---------------------------------------------------------------------------
// stdio fake
// ---------------------------------------------------------------------------

const STDIO_SCRIPT = `
const TOOLS = ${JSON.stringify(TOOLS.concat([{ name: "weather_bad", description: "Broken", inputSchema: { type: "object" }, outputSchema: OUTPUT_SCHEMA } as never]))};
const RESULTS = ${JSON.stringify(CALL_RESULTS)};
process.stdin.setEncoding('utf-8');
let buf = '';
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl = buf.indexOf('\\n');
  while (nl >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    nl = buf.indexOf('\\n');
    if (!line) continue;
    const req = JSON.parse(line);
    if (req.method === 'notifications/cancelled') {
      process.stderr.write('CANCELLED ' + JSON.stringify(req.params) + '\\n');
      require('fs').appendFileSync(process.env.CANCEL_LOG, JSON.stringify(req.params) + '\\n');
      continue;
    }
    if (req.id === undefined) continue;
    if (req.method === 'initialize') send({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2025-06-18', capabilities: {} } });
    else if (req.method === 'tools/list') send({ jsonrpc: '2.0', id: req.id, result: { tools: TOOLS } });
    else if (req.method === 'tools/call') {
      const name = req.params.name;
      const token = req.params._meta && req.params._meta.progressToken;
      if (name === 'slow') {
        // A ping from the server must be answered and must not be mistaken for a response.
        send({ jsonrpc: '2.0', id: req.id, method: 'ping' });
        send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: 1, total: 4, message: 'step one' } });
        setTimeout(() => {
          send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: 4, total: 4 } });
          send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: 'done' }] } });
        }, 30);
      } else if (name === 'hang') {
        // never answers
      } else {
        send({ jsonrpc: '2.0', id: req.id, result: RESULTS[name] || { content: [{ type: 'text', text: 'ok' }] } });
      }
    }
  }
});
`;

function stdioConfig(cancelLog: string): MCPServerConfig {
  return {
    serverId: "stdio_mcp",
    connection: { command: process.execPath, args: ["-e", STDIO_SCRIPT], env: { CANCEL_LOG: cancelLog }, timeoutMs: 10_000 }
  };
}

function tempLog(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-mcp-cancel-"));
  const file = path.join(dir, "cancel.log");
  fs.writeFileSync(file, "");
  return file;
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ---------------------------------------------------------------------------

describe("tools/list annotations and outputSchema", () => {
  it("http adapter keeps every hint, the title and the outputSchema", async () => {
    const tools = await new HttpMCPServerAdapter().discoverTools(httpConfig(), makeContext());
    const weather = tools.find((tool) => tool.name === "weather")!;
    expect(weather.annotations).toEqual({ title: "Weather", readOnlyHint: true, openWorldHint: true });
    expect(weather.outputSchema).toEqual(OUTPUT_SCHEMA);
    expect(tools.find((tool) => tool.name === "drop_table")!.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false
    });
    const plain = tools.find((tool) => tool.name === "plain")!;
    expect(plain).not.toHaveProperty("annotations");
    expect(plain).not.toHaveProperty("outputSchema");
  });

  it("http adapter sends the 2025-06-18 protocol version and echoes the negotiated one", async () => {
    await new HttpMCPServerAdapter().discoverTools(httpConfig(), makeContext());
    expect(received[0]).toMatchObject({ method: "initialize", params: { protocolVersion: "2025-06-18" } });
  });

  it("stdio adapter keeps every hint, the title and the outputSchema", async () => {
    const adapter = new StdioMCPServerAdapter();
    const context = makeContext();
    try {
      const tools = await adapter.discoverTools(stdioConfig(tempLog()), context);
      const weather = tools.find((tool) => tool.name === "weather")!;
      expect(weather.annotations).toEqual({ title: "Weather", readOnlyHint: true, openWorldHint: true });
      expect(weather.outputSchema).toEqual(OUTPUT_SCHEMA);
      expect(tools.find((tool) => tool.name === "drop_table")!.annotations?.destructiveHint).toBe(true);
      expect(tools.find((tool) => tool.name === "plain")).not.toHaveProperty("outputSchema");
    } finally {
      await adapter.closeSessions(context);
    }
  });
});

describe("snapshot hashing and outputSchema diffs", () => {
  const base: McpToolSnapshotEntry = { name: "weather", description: "d", inputSchema: { type: "object" } };

  it("keeps the hash of a tool without outputSchema unchanged", () => {
    const legacy = hashToolSnapshot([base]);
    expect(hashToolSnapshot([{ ...base, outputSchema: undefined }])).toBe(legacy);
    expect(normalizeToolSnapshot([{ ...base, outputSchema: "nope" }])[0]).not.toHaveProperty("outputSchema");
    expect(hashToolSnapshot([{ ...base, outputSchema: OUTPUT_SCHEMA }])).not.toBe(legacy);
  });

  const withOutput = (outputSchema?: Record<string, unknown>): McpToolSnapshotEntry[] => [
    { ...base, ...(outputSchema ? { outputSchema } : {}) }
  ];
  const kinds = (before?: Record<string, unknown>, after?: Record<string, unknown>) =>
    diffToolSnapshots(withOutput(before), withOutput(after)).changes.map((change) => ({
      kind: change.kind,
      path: change.path,
      breaking: change.breaking,
      schema: change.schema
    }));

  it("treats adding an output schema as safe and removing it as breaking", () => {
    expect(kinds(undefined, OUTPUT_SCHEMA)).toEqual([{ kind: "output_schema_added", path: undefined, breaking: false, schema: "output" }]);
    expect(kinds(OUTPUT_SCHEMA, undefined)).toEqual([{ kind: "output_schema_removed", path: undefined, breaking: true, schema: "output" }]);
  });

  it("applies the input rules in reverse to output properties", () => {
    const removed = { ...OUTPUT_SCHEMA, properties: { temperature: { type: "number" } }, required: ["temperature"] };
    expect(kinds(OUTPUT_SCHEMA, removed)).toContainEqual({ kind: "property_removed", path: "unit", breaking: true, schema: "output" });

    const optional = { ...OUTPUT_SCHEMA, required: ["temperature"] };
    expect(kinds(OUTPUT_SCHEMA, optional)).toEqual([
      { kind: "property_no_longer_required", path: "unit", breaking: true, schema: "output" }
    ]);
    expect(kinds(optional, OUTPUT_SCHEMA)).toEqual([{ kind: "property_now_required", path: "unit", breaking: false, schema: "output" }]);

    const added = { ...OUTPUT_SCHEMA, properties: { ...OUTPUT_SCHEMA.properties, humidity: { type: "number" } }, required: ["temperature", "unit", "humidity"] };
    expect(kinds(OUTPUT_SCHEMA, added)).toEqual([{ kind: "property_added", path: "humidity", breaking: false, schema: "output" }]);

    const widened = { ...OUTPUT_SCHEMA, properties: { ...OUTPUT_SCHEMA.properties, temperature: { type: ["number", "string"] } } };
    expect(kinds(OUTPUT_SCHEMA, widened)).toEqual([{ kind: "property_type_widened", path: "temperature", breaking: true, schema: "output" }]);
    expect(kinds(widened, OUTPUT_SCHEMA)).toEqual([{ kind: "property_type_narrowed", path: "temperature", breaking: false, schema: "output" }]);

    const moreUnits = { ...OUTPUT_SCHEMA, properties: { ...OUTPUT_SCHEMA.properties, unit: { type: "string", enum: ["C", "F", "K"] } } };
    expect(kinds(OUTPUT_SCHEMA, moreUnits)).toEqual([{ kind: "enum_value_added", path: "unit", breaking: true, schema: "output" }]);
    expect(kinds(moreUnits, OUTPUT_SCHEMA)).toEqual([{ kind: "enum_value_removed", path: "unit", breaking: false, schema: "output" }]);
  });

  it("leaves the input rules as they were", () => {
    const before: McpToolSnapshotEntry[] = [{ ...base, inputSchema: { type: "object", properties: { a: { type: "string" } } } }];
    const after: McpToolSnapshotEntry[] = [{ ...base, inputSchema: { type: "object", properties: { a: { type: ["string", "number"] } } } }];
    expect(diffToolSnapshots(before, after).changes).toEqual([
      expect.objectContaining({ kind: "property_type_widened", breaking: false })
    ]);
    expect(diffToolSnapshots(before, after).changes[0]).not.toHaveProperty("schema");
  });
});

describe("structuredContent validation", () => {
  it("accepts conforming structured content", () => {
    expect(checkStructuredContent("weather", OUTPUT_SCHEMA, { temperature: 3, unit: "F" })).toEqual({
      ok: true,
      structured: { temperature: 3, unit: "F" }
    });
  });

  it("rejects content that does not match the schema with a clear message", () => {
    const check = checkStructuredContent("weather", OUTPUT_SCHEMA, { temperature: "hot" });
    expect(check.ok).toBe(false);
    expect(!check.ok && check.error).toMatch(/weather.*does not match its outputSchema.*temperature must be number/);
  });

  it("rejects a missing structuredContent when the tool declares an outputSchema", () => {
    const result = buildToolCallResult("weather", { content: [{ type: "text", text: "21" }] }, OUTPUT_SCHEMA);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("MCP tool 'weather' declares an outputSchema but returned no structuredContent.");
  });

  it("accepts any object without a schema and does not validate error results", () => {
    expect(buildToolCallResult("x", { structuredContent: { a: 1 }, content: [{ type: "text", text: "A" }] })).toEqual({
      ok: true,
      output: { a: 1 },
      structured: { a: 1 },
      content: "A"
    });
    const failed = buildToolCallResult("weather", { isError: true, content: [{ type: "text", text: "boom" }] }, OUTPUT_SCHEMA);
    expect(failed).toMatchObject({ ok: false, error: "boom" });
  });

  it("gives agents the JSON once, or text plus structured content when the text says more", () => {
    const same = buildToolCallResult("weather", CALL_RESULTS.weather, OUTPUT_SCHEMA);
    expect(toAgentToolOutput(same)).toEqual({ temperature: 21.5, unit: "C" });
    const extra = buildToolCallResult("weather", {
      content: [{ type: "text", text: "It is mild." }],
      structuredContent: { temperature: 21.5, unit: "C" }
    });
    expect(toAgentToolOutput(extra)).toEqual({ content: "It is mild.", structuredContent: { temperature: 21.5, unit: "C" } });
    expect(toAgentToolOutput(buildToolCallResult("plain", CALL_RESULTS.plain))).toBe("plain text");
  });

  it("validates tools/call results in both adapters", async () => {
    const http = new HttpMCPServerAdapter();
    const httpContext = makeContext();
    const good = await http.invokeTool("weather", { city: "Oslo" }, httpConfig(), httpContext);
    expect(good).toMatchObject({ ok: true, structured: { temperature: 21.5, unit: "C" }, content: '{"temperature":21.5,"unit":"C"}' });
    const bad = await http.invokeTool("weather_bad", {}, httpConfig(), httpContext);
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/weather_bad.*does not match its outputSchema/);

    const stdio = new StdioMCPServerAdapter();
    const stdioContext = makeContext();
    try {
      const config = stdioConfig(tempLog());
      expect(await stdio.invokeTool("weather", {}, config, stdioContext)).toMatchObject({ ok: true, structured: { temperature: 21.5 } });
      const stdioBad = await stdio.invokeTool("weather_bad", {}, config, stdioContext);
      expect(stdioBad.ok).toBe(false);
      expect(stdioBad.error).toMatch(/does not match its outputSchema/);
    } finally {
      await stdio.closeSessions(stdioContext);
    }
  });
});

describe("progress notifications", () => {
  it("parses only well-formed progress notifications", () => {
    expect(parseProgressNotification({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "t", progress: 1, total: 2, message: "m" } })).toEqual({
      progressToken: "t",
      progress: 1,
      total: 2,
      message: "m"
    });
    expect(parseProgressNotification({ jsonrpc: "2.0", id: 1, method: "notifications/progress", params: { progressToken: "t", progress: 1 } })).toBeNull();
    expect(parseProgressNotification({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })).toBeNull();
  });

  it("http adapter sends a progressToken and streams progress from the SSE response", async () => {
    const events: McpToolProgressEvent[] = [];
    const result = await new HttpMCPServerAdapter().invokeTool(
      "slow",
      {},
      { ...httpConfig(), registryServerId: "mcp_reg" },
      makeContext({ onProgress: (event) => events.push(event) })
    );
    expect(result).toMatchObject({ ok: true, output: "done" });
    const call = received.find((message) => message.method === "tools/call")!;
    expect((call.params?._meta as { progressToken?: string }).progressToken).toMatch(/^l2m-progress-/);
    expect(events.map(({ at: _at, ...rest }) => rest)).toEqual([
      { toolName: "slow", serverId: "http_mcp", registryServerId: "mcp_reg", progress: 2, total: 5, message: "indexing" },
      { toolName: "slow", serverId: "http_mcp", registryServerId: "mcp_reg", progress: 5, total: 5 }
    ]);
  });

  it("http adapter sends no progressToken when nobody listens", async () => {
    await new HttpMCPServerAdapter().invokeTool("plain", {}, httpConfig(), makeContext());
    const call = received.find((message) => message.method === "tools/call")!;
    expect(call.params).not.toHaveProperty("_meta");
  });

  it("stdio adapter routes interleaved progress notifications and answers pings", async () => {
    const adapter = new StdioMCPServerAdapter();
    const events: McpToolProgressEvent[] = [];
    const context = makeContext({ onProgress: (event) => events.push(event) });
    try {
      const result = await adapter.invokeTool("slow", {}, stdioConfig(tempLog()), context);
      expect(result).toMatchObject({ ok: true, output: "done" });
      expect(events.map((event) => [event.progress, event.total, event.message])).toEqual([
        [1, 4, "step one"],
        [4, 4, undefined]
      ]);
    } finally {
      await adapter.closeSessions(context);
    }
  });
});

describe("cancellation", () => {
  it("http adapter sends notifications/cancelled with the request id, then aborts", async () => {
    const adapter = new HttpMCPServerAdapter();
    const controller = new AbortController();
    const pending = adapter.invokeTool("hang", {}, httpConfig(), makeContext({ signal: controller.signal }));
    await waitFor(() => received.some((message) => message.method === "tools/call"));
    controller.abort(new Error("Run canceled by user"));
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/canceled/i);
    const call = received.find((message) => message.method === "tools/call")!;
    const cancel = received.find((message) => message.method === "notifications/cancelled");
    expect(cancel?.params).toEqual({ requestId: call.id, reason: "Run canceled by user" });
    await waitFor(() => openResponses.size === 0);
  });

  it("http closeSessions cancels in-flight calls before forgetting the session", async () => {
    const adapter = new HttpMCPServerAdapter();
    const context = makeContext();
    const pending = adapter.invokeTool("hang", {}, httpConfig(), context);
    await waitFor(() => received.some((message) => message.method === "tools/call"));
    await adapter.closeSessions(context);
    const call = received.find((message) => message.method === "tools/call")!;
    expect(received.find((message) => message.method === "notifications/cancelled")?.params).toMatchObject({ requestId: call.id });
    expect((await pending).ok).toBe(false);
  });

  it("stdio adapter sends notifications/cancelled with the request id on abort, then closes", async () => {
    const adapter = new StdioMCPServerAdapter();
    const controller = new AbortController();
    const context = makeContext({ signal: controller.signal });
    const log = tempLog();
    const pending = adapter.invokeTool("hang", {}, stdioConfig(log), context);
    // initialize is id 1, tools/call is id 2.
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort("Workflow execution timed out");
    const result = await pending;
    expect(result.ok).toBe(false);
    await adapter.closeSessions(context);
    await waitFor(() => fs.readFileSync(log, "utf8").trim().length > 0);
    const entries = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(entries).toEqual([{ requestId: 2, reason: "Workflow execution timed out" }]);
  });

  it("stdio closeSessions cancels in-flight calls before killing the process", async () => {
    const adapter = new StdioMCPServerAdapter();
    const context = makeContext();
    const log = tempLog();
    const pending = adapter.invokeTool("hang", {}, stdioConfig(log), context);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await adapter.closeSessions(context);
    expect((await pending).ok).toBe(false);
    const entries = fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(entries).toEqual([{ requestId: 2, reason: "MCP session closed." }]);
  });
});

describe("tool policy annotation conditions", () => {
  const rule = (overrides: Partial<McpToolPolicyRule>): McpToolPolicyRule => ({
    id: "r",
    name: null,
    description: null,
    effect: "deny",
    projectId: null,
    roles: [],
    serverId: null,
    toolPattern: "*",
    enabled: true,
    ...overrides
  });

  it("fills in the spec defaults for missing hints", () => {
    expect(effectiveToolHints(undefined)).toEqual({ readOnly: false, destructive: true, idempotent: false, openWorld: true });
    expect(effectiveToolHints({ readOnlyHint: true, destructiveHint: true })).toMatchObject({ readOnly: true, destructive: false });
    expect(effectiveToolHints({ destructiveHint: false })).toMatchObject({ destructive: false });
    expect(effectiveToolHints({ destructiveHint: true }, true)).toMatchObject({ readOnly: true, destructive: false });
  });

  it("denies destructive tools for operators and leaves other roles and safe tools alone", () => {
    const rules = [rule({ id: "no-destructive", name: "No destructive tools for operators", roles: ["operator"], annotationHint: "destructive" })];
    const request = { role: "operator" as const, adapterId: "http_mcp", registryServerId: "mcp_db", toolName: "drop_table" };
    const denied = evaluateMcpToolAccess({ ...request, rules, annotations: { destructiveHint: true } });
    expect(denied.allowed).toBe(false);
    expect(denied.message).toMatch(/blocked by policy 'No destructive tools for operators'.*destructive tools/);
    expect(evaluateMcpToolAccess({ ...request, rules, annotations: { readOnlyHint: true } }).allowed).toBe(true);
    expect(evaluateMcpToolAccess({ ...request, rules, annotations: { destructiveHint: false } }).allowed).toBe(true);
    // No annotations: the spec default makes the tool destructive.
    expect(evaluateMcpToolAccess({ ...request, rules }).allowed).toBe(false);
    // An admin's read-only override wins over the annotation.
    expect(evaluateMcpToolAccess({ ...request, rules, annotations: { destructiveHint: true }, manualReadOnly: true }).allowed).toBe(true);
    expect(evaluateMcpToolAccess({ ...request, role: "builder", rules, annotations: { destructiveHint: true } }).allowed).toBe(true);
  });

  it("supports negated conditions and lets a narrower allow carve out of a hint deny", () => {
    const openWorld = [rule({ annotationHint: "not_open_world", effect: "deny" })];
    expect(evaluateMcpToolPolicy(openWorld, { role: "viewer", adapterId: "m", toolName: "t", annotations: { openWorldHint: false } }).allowed).toBe(false);
    expect(evaluateMcpToolPolicy(openWorld, { role: "viewer", adapterId: "m", toolName: "t" }).allowed).toBe(true);

    const deny = rule({ id: "deny", annotationHint: "destructive" });
    const allow = rule({ id: "allow", effect: "allow", annotationHint: "destructive", toolPattern: "archive_*" });
    expect(isStrictlyNarrower(allow, deny)).toBe(true);
    expect(isStrictlyNarrower(rule({ id: "plain" }), deny)).toBe(false);
    expect(isStrictlyNarrower(deny, rule({ id: "plain" }))).toBe(true);
    const decision = evaluateMcpToolPolicy([deny, allow], { role: "operator", adapterId: "m", toolName: "archive_logs" });
    expect(decision.allowed).toBe(true);
  });
});
