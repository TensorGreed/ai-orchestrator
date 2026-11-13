import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { McpClientProtocolMode, MCPServerConfig } from "@ai-orchestrator/shared";
import { createRecordingRegistry, createReplayRegistry, McpCassetteRecorder } from "../cassette";
import { McpJsonRpcError } from "../errors";
import { MCPRegistry } from "../registry";
import type { MCPExecutionContext } from "../types";
import { StdioMCPServerAdapter, type StdioMcpProtocolOptions } from "./stdio-mcp";

/**
 * MCP 2026-07-28 — the stdio client in both eras, against a scripted server
 * that plays an initialize-based server, a modern-only server or a dual-era
 * one (SCENARIO). Every message the server reads is appended to LOG_FILE,
 * across processes, so the tests can check the exact wire traffic.
 */
const SERVER_SCRIPT = `
const fs = require('fs');
const scenarioFile = process.env.SCENARIO_FILE;
const scenario = scenarioFile && fs.existsSync(scenarioFile) ? fs.readFileSync(scenarioFile, 'utf-8').trim() : process.env.SCENARIO;
const MODERN = '2026-07-28';
const LEGACY_ONLY = ['legacy', 'legacy-silent', 'legacy-exit'];
let initialized = false;
let buf = '';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const ok = (msg, result) => send({ jsonrpc: '2.0', id: msg.id, result });
const err = (msg, code, message, data) => send({ jsonrpc: '2.0', id: msg.id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
const metaOf = (msg) => (msg.params && msg.params._meta) || {};
const TOOLS = [
  { name: 'echo', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  { name: 'write', inputSchema: { type: 'object' } },
  { name: 'confirm', inputSchema: { type: 'object' } },
  { name: 'sample', inputSchema: { type: 'object' } },
  { name: 'needs_sampling', inputSchema: { type: 'object' } },
  { name: 'crash', inputSchema: { type: 'object' } },
  { name: 'crash_ro', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  { name: 'weird', inputSchema: { type: 'object' } },
  { name: 'ping_me', inputSchema: { type: 'object' } },
  { name: 'meta', inputSchema: { type: 'object' } },
  { name: 'hang', inputSchema: { type: 'object' } }
];
function crashOnce() {
  const marker = process.env.CRASH_MARKER;
  if (!fs.existsSync(marker)) { fs.writeFileSync(marker, '1'); process.exit(1); }
}
function handle(msg, modern) {
  const complete = (result) => modern ? { resultType: 'complete', ...result } : result;
  const meta = metaOf(msg);
  switch (msg.method) {
    case 'server/discover':
      if (scenario === 'nomutual') return ok(msg, { resultType: 'complete', supportedVersions: ['2099-01-01'], capabilities: {} });
      return ok(msg, {
        resultType: 'complete',
        supportedVersions: scenario === 'modern' ? [MODERN] : [MODERN, '2025-11-25'],
        capabilities: { tools: {}, prompts: {}, resources: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'fake', version: '1' } }
      });
    case 'tools/list':
      if (scenario === 'crash-list') crashOnce();
      return ok(msg, complete({ tools: TOOLS }));
    case 'prompts/get':
      if (msg.params.name === 'bad') return err(msg, -32602, 'Bad prompt', { reason: 'unknown prompt' });
      return ok(msg, complete({ messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }] }));
    case 'resources/read':
      if (msg.params.uri === 'mem://missing') return err(msg, -32602, 'Resource not found', { uri: msg.params.uri });
      return ok(msg, complete({ contents: [{ uri: msg.params.uri, text: 'alpha' }] }));
    case 'tools/call': {
      const name = msg.params.name;
      const args = msg.params.arguments || {};
      if (modern && scenario === 'downgrade') return err(msg, -32022, 'Unsupported protocol version', { supported: ['2025-11-25'], requested: MODERN });
      if (name === 'echo') return ok(msg, complete({ content: [{ type: 'text', text: 'echo: ' + JSON.stringify(args) }] }));
      if (name === 'write') return ok(msg, complete({ content: [{ type: 'text', text: 'written' }] }));
      if (name === 'meta') return ok(msg, complete({ content: [{ type: 'text', text: JSON.stringify(msg.params._meta === undefined ? null : msg.params._meta) }] }));
      if (name === 'crash' || name === 'crash_ro') { crashOnce(); return ok(msg, complete({ content: [{ type: 'text', text: 'survived' }] })); }
      if (name === 'hang') return;
      if (name === 'answer_exit') { ok(msg, complete({ content: [{ type: 'text', text: 'answered' }] })); process.exit(0); }
      if (name === 'weird') return ok(msg, { resultType: 'task', task: {} });
      if (name === 'ping_me') { send({ jsonrpc: '2.0', id: 'srv-1', method: 'ping' }); return ok(msg, complete({ content: [{ type: 'text', text: 'pinged' }] })); }
      if (name === 'needs_sampling') {
        if (!meta['io.modelcontextprotocol/clientCapabilities'].sampling) return err(msg, -32021, 'Missing required client capability', { requiredCapabilities: { sampling: {} } });
        return ok(msg, complete({ content: [{ type: 'text', text: 'ok' }] }));
      }
      if (name === 'confirm' || name === 'sample') {
        const answers = msg.params.inputResponses;
        if (answers) return ok(msg, complete({ content: [{ type: 'text', text: JSON.stringify({ answers, state: msg.params.requestState === undefined ? null : msg.params.requestState }) }] }));
        const request = name === 'confirm'
          ? { method: 'elicitation/create', params: { message: 'Sure?', requestedSchema: { type: 'object', properties: { yes: { type: 'boolean' } } } } }
          : { method: 'sampling/createMessage', params: { messages: [{ role: 'user', content: { type: 'text', text: 'Say hi' } }], maxTokens: 20 } };
        return ok(msg, { resultType: 'input_required', inputRequests: { q: request }, requestState: 'opaque-state-1' });
      }
      return err(msg, -32601, 'Unknown tool');
    }
    default:
      return err(msg, -32601, 'Method not found: ' + msg.method);
  }
}
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    fs.appendFileSync(process.env.LOG_FILE, JSON.stringify(msg) + '\\n');
    if (msg.id === undefined) continue;
    if (msg.method === undefined) continue;
    if (msg.method === 'initialize') {
      if (scenario === 'modern-plain') { err(msg, -32601, 'Method not found: initialize'); continue; }
      if (scenario === 'modern' || scenario === 'nomutual') {
        err(msg, -32022, 'Unsupported protocol version', { supported: [MODERN], requested: msg.params.protocolVersion });
        continue;
      }
      initialized = true;
      ok(msg, { protocolVersion: '2025-06-18', capabilities: { tools: {}, prompts: {} }, serverInfo: { name: 'fake', version: '1' } });
      continue;
    }
    const modernRequest = 'io.modelcontextprotocol/protocolVersion' in metaOf(msg);
    if (!initialized && !(modernRequest && !LEGACY_ONLY.includes(scenario))) {
      if (scenario === 'legacy-silent') continue;
      if (scenario === 'legacy-exit') process.exit(2);
      err(msg, -32601, 'Method not found: ' + msg.method);
      continue;
    }
    if (modernRequest && !initialized) {
      const meta = metaOf(msg);
      if (meta['io.modelcontextprotocol/protocolVersion'] !== MODERN) { err(msg, -32022, 'Unsupported protocol version', { supported: [MODERN], requested: meta['io.modelcontextprotocol/protocolVersion'] }); continue; }
      if (typeof meta['io.modelcontextprotocol/clientCapabilities'] !== 'object') { err(msg, -32602, 'Missing _meta'); continue; }
    }
    handle(msg, modernRequest && !initialized);
  }
});
`;

type Scenario = "modern-plain" | "legacy" | "legacy-silent" | "legacy-exit" | "modern" | "dual" | "downgrade" | "nomutual" | "crash-list";

interface LoggedMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown> & { _meta?: Record<string, unknown>; name?: string };
  result?: unknown;
}

const dirs: string[] = [];
const contexts: Array<{ adapter: StdioMCPServerAdapter; context: MCPExecutionContext }> = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ adapter, context }) => adapter.closeSessions(context)));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(scenario: Scenario, protocolMode?: McpClientProtocolMode) {
  const dir = mkdtempSync(path.join(tmpdir(), "l2m-stdio-protocol-"));
  dirs.push(dir);
  const logFile = path.join(dir, "log.jsonl");
  const config: MCPServerConfig = {
    serverId: "stdio_mcp",
    registryServerId: "mcp_fake",
    label: "fake",
    connection: {
      command: process.execPath,
      args: ["-e", SERVER_SCRIPT],
      timeoutMs: 5000,
      env: { SCENARIO: scenario, SCENARIO_FILE: path.join(dir, "scenario"), LOG_FILE: logFile, CRASH_MARKER: path.join(dir, "crashed") },
      ...(protocolMode ? { protocolMode } : {})
    }
  };
  const log = (): LoggedMessage[] => {
    try {
      return readFileSync(logFile, "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as LoggedMessage);
    } catch {
      return [];
    }
  };
  const become = (next: Scenario) => writeFileSync(path.join(dir, "scenario"), next);
  return { config, log, become, methods: () => log().map((message) => message.method ?? "(response)") };
}

function adapterWith(protocol?: StdioMcpProtocolOptions): StdioMCPServerAdapter {
  return new StdioMCPServerAdapter(protocol ? { protocol } : undefined);
}

function run(adapter: StdioMCPServerAdapter, extra: Partial<MCPExecutionContext> = {}): MCPExecutionContext {
  const context: MCPExecutionContext = { resolveSecret: async () => undefined, runtimeState: new Map<string, unknown>(), ...extra };
  contexts.push({ adapter, context });
  return context;
}

const MODERN_KEYS = ["io.modelcontextprotocol/protocolVersion", "io.modelcontextprotocol/clientCapabilities", "io.modelcontextprotocol/clientInfo"];

function textOf(result: { output: unknown }): string {
  return String(result.output);
}

describe("legacy mode (the default)", () => {
  it("sends exactly the earlier traffic to an initialize-based server: no probe, no modern _meta", async () => {
    const { config, log, methods } = fixture("legacy");
    const adapter = adapterWith();
    const context = run(adapter, { onProgress: () => undefined });
    await adapter.discoverTools(config, context);
    const result = await adapter.invokeTool("meta", { a: 1 }, config, context);
    expect(result.ok).toBe(true);
    expect(methods()).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
    const [initialize] = log();
    expect(initialize).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: { elicitation: {} }, clientInfo: { name: "ai-orchestrator", version: "0.1.0" } }
    });
    expect(log()[2]?.params).toEqual({});
    // Only the progress token, exactly as before.
    expect(Object.keys(JSON.parse(textOf(result)) as Record<string, unknown>)).toEqual(["progressToken"]);
    expect(adapter.observedProtocol(config)).toEqual({ era: "legacy" });
  });

  it("keeps a dual-era server on initialize", async () => {
    const { config, methods } = fixture("dual");
    const adapter = adapterWith();
    expect((await adapter.invokeTool("echo", {}, config, run(adapter))).ok).toBe(true);
    expect(methods()).toEqual(["initialize", "notifications/initialized", "tools/call", "tools/list"]);
  });

  it("opens with initialize again when a server that had rejected it no longer does", async () => {
    const { config, log, methods, become } = fixture("modern");
    const adapter = adapterWith();
    expect((await adapter.invokeTool("write", {}, config, run(adapter))).ok).toBe(true);
    become("legacy");
    const before = log().length;
    expect((await adapter.invokeTool("write", {}, config, run(adapter))).ok).toBe(true);
    expect(methods().slice(before)).toEqual(["server/discover", "initialize", "notifications/initialized", "tools/call", "tools/list"]);
    expect(adapter.observedProtocol(config)).toEqual({ era: "legacy" });
  });

  it("falls forward to 2026-07-28 on the same process when a modern-only server rejects initialize", async () => {
    const { config, log, methods } = fixture("modern");
    const adapter = adapterWith();
    const first = await adapter.invokeTool("meta", {}, config, run(adapter));
    expect(first.ok).toBe(true);
    expect(methods()).toEqual(["initialize", "tools/call", "tools/list"]);
    const meta = JSON.parse(textOf(first)) as Record<string, unknown>;
    expect(Object.keys(meta).sort()).toEqual([...MODERN_KEYS].sort());
    expect(meta["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
    expect(adapter.observedProtocol(config)).toEqual({ era: "modern", version: "2026-07-28" });

    // A new process of the same server: a short probe instead of initialize.
    const before = log().length;
    expect((await adapter.invokeTool("echo", {}, config, run(adapter))).ok).toBe(true);
    expect(methods().slice(before)).toEqual(["server/discover", "tools/call", "tools/list"]);
  });

  it("fills McpJsonRpcError.data from the server's error", async () => {
    const { config } = fixture("legacy");
    const adapter = adapterWith();
    const error = await adapter.getPrompt("bad", {}, config, run(adapter)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McpJsonRpcError);
    expect(error).toMatchObject({ code: -32602, data: { reason: "unknown prompt" } });
  });

  it("answers a legacy server's ping as before", async () => {
    const { config, log } = fixture("legacy");
    const adapter = adapterWith();
    expect((await adapter.invokeTool("ping_me", {}, config, run(adapter))).ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(log().some((message) => message.id === "srv-1" && message.result !== undefined)).toBe(true);
  });
});

describe("auto mode", () => {
  it("probes with server/discover, stays modern and takes the capabilities from the probe", async () => {
    const { config, log, methods } = fixture("dual", "auto");
    const adapter = adapterWith();
    const context = run(adapter);
    expect(await adapter.describeServer(config, context)).toEqual({ tools: {}, prompts: {}, resources: {} });
    const result = await adapter.invokeTool("echo", { x: 1 }, config, context);
    expect(result).toMatchObject({ ok: true, output: 'echo: {"x":1}' });
    expect(methods()).toEqual(["server/discover", "tools/call", "tools/list"]);
    const probe = log()[0];
    expect(Object.keys(probe?.params?._meta ?? {}).sort()).toEqual([...MODERN_KEYS].sort());
    expect(probe?.params?._meta?.["io.modelcontextprotocol/clientCapabilities"]).toEqual({ elicitation: {} });
  });

  it("falls back to initialize on the same process after a non-modern error, and skips the probe next time", async () => {
    const { config, log, methods } = fixture("legacy", "auto");
    const adapter = adapterWith();
    expect((await adapter.invokeTool("write", {}, config, run(adapter))).ok).toBe(true);
    expect(methods()).toEqual(["server/discover", "initialize", "notifications/initialized", "tools/call", "tools/list"]);
    expect(log()[1]?.params?._meta).toBeUndefined();
    const before = log().length;
    expect((await adapter.invokeTool("write", {}, config, run(adapter))).ok).toBe(true);
    expect(methods().slice(before)).toEqual(["initialize", "notifications/initialized", "tools/call", "tools/list"]);
  });

  it("treats a server that does not answer the probe in time as initialize-based, without cancelling the probe", async () => {
    const { config, methods } = fixture("legacy-silent", "auto");
    const adapter = adapterWith({ probeTimeoutMs: 300 });
    const started = Date.now();
    expect((await adapter.invokeTool("write", {}, config, run(adapter))).ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(methods()).toEqual(["server/discover", "initialize", "notifications/initialized", "tools/call", "tools/list"]);
  });

  it("starts a new process with initialize when the server exits on the probe, and does not probe it again", async () => {
    const { config, log, methods } = fixture("legacy-exit", "auto");
    const adapter = adapterWith();
    expect((await adapter.invokeTool("write", {}, config, run(adapter))).ok).toBe(true);
    expect(methods()).toEqual(["server/discover", "initialize", "notifications/initialized", "tools/call", "tools/list"]);
    const before = log().length;
    expect((await adapter.invokeTool("write", {}, config, run(adapter))).ok).toBe(true);
    expect(methods().slice(before)).toEqual(["initialize", "notifications/initialized", "tools/call", "tools/list"]);
  });

  it("probes again when a server cached as initialize-based now rejects initialize", async () => {
    const { config, log, methods, become } = fixture("legacy", "auto");
    const adapter = adapterWith();
    expect((await adapter.invokeTool("write", {}, config, run(adapter))).ok).toBe(true);
    become("modern-plain");
    const before = log().length;
    expect(await adapter.invokeTool("write", {}, config, run(adapter))).toMatchObject({ ok: true, output: "written" });
    expect(methods().slice(before)).toEqual(["initialize", "server/discover", "tools/call", "tools/list"]);
    expect(adapter.observedProtocol(config)).toEqual({ era: "modern", version: "2026-07-28" });
  });

  it("sends no notifications/cancelled when the run is cancelled during the probe", async () => {
    const { config, methods } = fixture("legacy-silent", "auto");
    const adapter = adapterWith({ probeTimeoutMs: 4000 });
    const controller = new AbortController();
    const pending = adapter.invokeTool("write", {}, config, run(adapter, { signal: controller.signal }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort("stop");
    expect(await pending).toMatchObject({ ok: false, errorKind: "canceled" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(methods()).toEqual(["server/discover"]);
  });

  it("reports a server that shares no version with the client", async () => {
    const { config } = fixture("nomutual", "auto");
    const adapter = adapterWith();
    const error = await adapter.describeServer(config, run(adapter)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McpJsonRpcError);
    expect(error).toMatchObject({ code: -32022, data: { supported: ["2099-01-01"] } });
    expect((error as Error).message).toMatch(/supports protocol versions 2099-01-01/);
  });

  it("moves to an initialize-based process when a modern request is refused with -32022 listing only older versions", async () => {
    const { config, methods } = fixture("downgrade", "auto");
    const adapter = adapterWith();
    const result = await adapter.invokeTool("write", {}, config, run(adapter));
    expect(result).toMatchObject({ ok: true, output: "written" });
    expect(methods()).toEqual(["server/discover", "tools/call", "initialize", "notifications/initialized", "tools/call", "tools/list"]);
  });
});

describe("modern mode", () => {
  it("fails clearly against an initialize-based server", async () => {
    const { config, methods } = fixture("legacy", "modern");
    const adapter = adapterWith();
    const result = await adapter.invokeTool("write", {}, config, run(adapter));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/does not speak MCP 2026-07-28.*Set its protocol to Legacy or Auto/);
    expect(methods()).toEqual(["server/discover"]);
  });

  it("fails clearly when an initialize-based server exits on the probe", async () => {
    const { config } = fixture("legacy-exit", "modern");
    const adapter = adapterWith();
    const result = await adapter.invokeTool("write", {}, config, run(adapter));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/does not speak MCP 2026-07-28: its process ended on server\/discover\. Set its protocol to Legacy or Auto/);
  });

  it("keeps the progress token beside the modern keys and sends no notifications/initialized", async () => {
    const { config, methods } = fixture("modern", "modern");
    const adapter = adapterWith();
    const result = await adapter.invokeTool("meta", {}, config, run(adapter, { onProgress: () => undefined }));
    const meta = JSON.parse(textOf(result)) as Record<string, unknown>;
    expect(Object.keys(meta).sort()).toEqual(["progressToken", ...MODERN_KEYS].sort());
    expect(methods()).not.toContain("initialize");
    expect(methods()).not.toContain("notifications/initialized");
  });

  it("answers an input_required elicitation and retries with a new id, the answers and the exact requestState", async () => {
    const { config, log } = fixture("modern", "modern");
    const adapter = adapterWith();
    const asked: unknown[] = [];
    const context = run(adapter, {
      onElicitation: async (request, origin) => {
        asked.push({ message: request.message, origin });
        return { action: "accept", content: { yes: true } };
      }
    });
    const result = await adapter.invokeTool("confirm", {}, config, context);
    expect(JSON.parse(textOf(result))).toEqual({ answers: { q: { action: "accept", content: { yes: true } } }, state: "opaque-state-1" });
    expect(asked).toEqual([{ message: "Sure?", origin: { serverId: "stdio_mcp", registryServerId: "mcp_fake", toolName: "confirm" } }]);
    const calls = log().filter((message) => message.method === "tools/call");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.id).not.toBe(calls[1]?.id);
    expect(calls[0]?.params).not.toHaveProperty("inputResponses");
    expect(calls[1]?.params?._meta?.["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
  });

  it("answers sampling through the handler and declares sampling only when there is one", async () => {
    const { config } = fixture("modern", "modern");
    const adapter = adapterWith();
    const context = run(adapter, {
      onSampling: async () => ({ role: "assistant", content: { type: "text", text: "hi" }, model: "scripted" })
    });
    const result = await adapter.invokeTool("sample", {}, config, context);
    expect(JSON.parse(textOf(result)).answers.q).toMatchObject({ role: "assistant", model: "scripted" });

    const without = await adapter.invokeTool("needs_sampling", {}, config, run(adapter));
    expect(without).toMatchObject({ ok: false, errorKind: "tool" });
    expect(without.error).toMatch(/needs the client capability sampling/);
    expect((await adapter.invokeTool("needs_sampling", {}, config, context)).ok).toBe(true);
  });

  it("stops after the round limit", async () => {
    const { config } = fixture("modern", "modern");
    const adapter = adapterWith({ mrtrMaxRounds: 0 });
    const result = await adapter.invokeTool("confirm", {}, config, run(adapter, { onElicitation: async () => ({ action: "decline" }) }));
    expect(result).toMatchObject({ ok: false, errorKind: "protocol" });
    expect(result.error).toMatch(/kept asking for more input/);
  });

  it("rejects an unknown resultType", async () => {
    const { config } = fixture("modern", "modern");
    const adapter = adapterWith();
    const result = await adapter.invokeTool("weird", {}, config, run(adapter));
    expect(result).toMatchObject({ ok: false, errorKind: "protocol" });
    expect(result.error).toMatch(/resultType 'task'/);
  });

  it("ignores a request a modern server should not send, and writes no response", async () => {
    const { config, log } = fixture("modern", "modern");
    const adapter = adapterWith();
    expect((await adapter.invokeTool("ping_me", {}, config, run(adapter))).ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(log().some((message) => message.id === "srv-1")).toBe(false);
  });

  it("reports a missing resource with the server's data", async () => {
    const { config } = fixture("modern", "modern");
    const adapter = adapterWith();
    const error = await adapter.readResource("mem://missing", config, run(adapter)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McpJsonRpcError);
    expect(error).toMatchObject({ code: -32602, data: { uri: "mem://missing" } });
    expect((error as Error).message).toMatch(/MCP resource not found: mem:\/\/missing/);
  });

  it("cancels with notifications/cancelled on stdio, as the binding requires", async () => {
    const { config, log } = fixture("modern", "modern");
    const adapter = adapterWith();
    const controller = new AbortController();
    const context = run(adapter, { signal: controller.signal });
    const pending = adapter.invokeTool("hang", {}, config, context);
    await new Promise((resolve) => setTimeout(resolve, 400));
    controller.abort("stop");
    expect(await pending).toMatchObject({ ok: false, errorKind: "canceled" });
    await adapter.closeSessions(context);
    const call = log().find((message) => message.method === "tools/call");
    const cancel = log().find((message) => message.method === "notifications/cancelled");
    expect(cancel?.params).toMatchObject({ requestId: call?.id });
    expect(cancel?.params?._meta).toBeUndefined();
  });

  it("lists the tools again on a new process when the process died during a listing", async () => {
    const { config, methods } = fixture("crash-list", "modern");
    const adapter = adapterWith();
    const tools = await adapter.discoverTools(config, run(adapter));
    expect(tools.map((tool) => tool.name)).toContain("echo");
    expect(methods()).toEqual(["server/discover", "tools/list", "server/discover", "tools/list"]);
  });
});

describe("re-issue after the server process died (D13)", () => {
  const callsOf = (log: () => LoggedMessage[], name: string) =>
    log().filter((message) => message.method === "tools/call" && message.params?.name === name).length;

  it("does not send an unmarked tool call again to an initialize-based server: outcome unknown", async () => {
    const { config, log } = fixture("legacy");
    const adapter = adapterWith();
    const result = await adapter.invokeTool("crash", {}, config, run(adapter));
    expect(result).toMatchObject({ ok: false, errorKind: "outcome_unknown" });
    expect(result.error).toMatch(/not sent again because the tool is not marked read-only or idempotent/);
    expect(callsOf(log, "crash")).toBe(1);
  });

  it("reads an answer the server wrote just before it exited instead of reporting it lost", async () => {
    const { config, log } = fixture("legacy");
    const adapter = adapterWith();
    expect(await adapter.invokeTool("answer_exit", {}, config, run(adapter))).toMatchObject({ ok: true, output: "answered" });
    expect(callsOf(log, "answer_exit")).toBe(1);
  });

  it("sends a tool call the listing marks read-only again on a new process", async () => {
    const { config, log } = fixture("legacy");
    const adapter = adapterWith();
    const context = run(adapter);
    await adapter.discoverTools(config, context);
    const result = await adapter.invokeTool("crash_ro", {}, config, context);
    expect(result).toMatchObject({ ok: true, output: "survived" });
    expect(callsOf(log, "crash_ro")).toBe(2);
  });

  it("counts a tool as unsafe before any listing, unless the server's manual tools mark it", async () => {
    const { config, log } = fixture("legacy");
    const adapter = adapterWith();
    expect(await adapter.invokeTool("crash_ro", {}, config, run(adapter))).toMatchObject({ ok: false, errorKind: "outcome_unknown" });
    const manual = fixture("legacy");
    const marked: MCPServerConfig = {
      ...manual.config,
      manualTools: [{ serverId: "stdio_mcp", name: "crash_ro", description: "", inputSchema: { type: "object" }, annotations: { idempotentHint: true } }]
    };
    expect(await adapter.invokeTool("crash_ro", {}, marked, run(adapter))).toMatchObject({ ok: true, output: "survived" });
    expect(callsOf(log, "crash_ro")).toBe(1);
  });

  it("uses annotations from an earlier run's listing", async () => {
    const { config, log } = fixture("legacy");
    const adapter = adapterWith();
    await adapter.discoverTools(config, run(adapter));
    const result = await adapter.invokeTool("crash_ro", {}, config, run(adapter));
    expect(result.ok).toBe(true);
    expect(callsOf(log, "crash_ro")).toBe(2);
  });

  it("sends every call again when the legacy flag is off, as earlier releases did", async () => {
    const { config, log } = fixture("legacy");
    const adapter = adapterWith({ legacySafeReissue: false });
    const result = await adapter.invokeTool("crash", {}, config, run(adapter));
    expect(result).toMatchObject({ ok: true, output: "survived" });
    expect(callsOf(log, "crash")).toBe(2);
  });

  it("lets an admin's read-only mark in tool policy decide before the server's annotations", async () => {
    const marks: Record<string, boolean> = { crash: true, crash_ro: false };
    const asked: string[] = [];
    const toolReadOnlyOverride = (serverId: string, toolName: string) => {
      asked.push(`${serverId}/${toolName}`);
      return marks[toolName] ?? null;
    };
    for (const era of ["legacy", "modern"] as const) {
      const marked = fixture(era, era);
      const adapter = adapterWith({ toolReadOnlyOverride });
      const config = { ...marked.config, registryServerId: "reg-1" };
      // Unannotated, but marked read-only by an admin: sent again on a new process.
      expect(await adapter.invokeTool("crash", {}, config, run(adapter)), era).toMatchObject({ ok: true, output: "survived" });
      expect(callsOf(marked.log, "crash")).toBe(2);
      // Annotated read-only by the server, marked not read-only by an admin: not sent again (a fresh server crashes once).
      const unmarked = fixture(era, era);
      const roConfig = { ...unmarked.config, registryServerId: "reg-1" };
      const context = run(adapter);
      await adapter.discoverTools(roConfig, context);
      expect(await adapter.invokeTool("crash_ro", {}, roConfig, context), era).toMatchObject({ ok: false, errorKind: "outcome_unknown" });
      expect(callsOf(unmarked.log, "crash_ro")).toBe(1);
    }
    expect(asked).toContain("reg-1/crash");
  });

  it("always follows the safe rule for 2026-07-28 servers", async () => {
    const { config, log } = fixture("modern", "modern");
    const adapter = adapterWith({ legacySafeReissue: false });
    expect(await adapter.invokeTool("crash", {}, config, run(adapter))).toMatchObject({ ok: false, errorKind: "outcome_unknown" });
    expect(callsOf(log, "crash")).toBe(1);
  });
});

describe("cassettes in both eras", () => {
  it("records a modern run with an input round and replays it offline", async () => {
    const { config } = fixture("modern", "modern");
    const live = new MCPRegistry();
    const adapter = adapterWith();
    live.register(adapter);
    const recorder = new McpCassetteRecorder();
    const recording = createRecordingRegistry(live, recorder);
    const context = run(adapter, { onElicitation: async () => ({ action: "accept", content: { yes: true } }) });
    await recording.get("stdio_mcp").discoverTools(config, context);
    const recorded = await recording.get("stdio_mcp").invokeTool("confirm", {}, config, context);
    expect(recorded.ok).toBe(true);
    const cassette = recorder.toCassette();
    expect(cassette.entries.map((entry) => entry.method)).toEqual(["tools/list", "tools/call"]);
    expect(cassette.entries[1]?.exchanges?.[0]).toMatchObject({ kind: "elicitation", response: { action: "accept", content: { yes: true } } });

    const { registry } = createReplayRegistry(cassette, { mode: "strict" });
    expect(await registry.get("stdio_mcp").invokeTool("confirm", {}, config, run(adapter))).toEqual(recorded);
  });

  it("records and replays a legacy run unchanged", async () => {
    const { config } = fixture("legacy");
    const live = new MCPRegistry();
    const adapter = adapterWith();
    live.register(adapter);
    const recorder = new McpCassetteRecorder();
    const recording = createRecordingRegistry(live, recorder);
    const recorded = await recording.get("stdio_mcp").invokeTool("write", {}, config, run(adapter));
    const { registry } = createReplayRegistry(recorder.toCassette(), { mode: "strict" });
    expect(await registry.get("stdio_mcp").invokeTool("write", {}, config, run(adapter))).toEqual(recorded);
  });
});
