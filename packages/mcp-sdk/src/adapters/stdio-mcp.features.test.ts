import { describe, expect, it } from "vitest";
import type { MCPServerConfig, McpElicitationRequest, McpListChangedEvent, McpSamplingRequest } from "@ai-orchestrator/shared";
import type { MCPExecutionContext } from "../types";
import { StdioMCPServerAdapter } from "./stdio-mcp";

/**
 * Fake stdio server with resources, prompts, list_changed notifications and
 * tools that make elicitation and sampling requests of the client.
 */
const FEATURE_SERVER_SCRIPT = `
process.stdin.setEncoding('utf-8');
let buf = '';
let nextId = 1000;
const pendingClientResponses = new Map();
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const askClient = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  pendingClientResponses.set(id, resolve);
  send({ jsonrpc: '2.0', id, method, params });
});
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl = buf.indexOf('\\n');
  while (nl >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    nl = buf.indexOf('\\n');
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === undefined && msg.id !== undefined) {
      const resolve = pendingClientResponses.get(msg.id);
      if (resolve) { pendingClientResponses.delete(msg.id); resolve(msg); }
      continue;
    }
    if (msg.method === 'initialize') {
      globalThis.clientCapabilities = msg.params.capabilities;
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: {} }, serverInfo: { name: 'features', version: '1' } } });
    } else if (msg.method === 'notifications/initialized') {
      // nothing
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: [
        { name: 'ask', description: 'elicits', inputSchema: { type: 'object' } },
        { name: 'sample', description: 'samples', inputSchema: { type: 'object' } },
        { name: 'caps', description: 'echoes client capabilities', inputSchema: { type: 'object' } },
        { name: 'notify', description: 'sends list_changed', inputSchema: { type: 'object' } }
      ] } });
    } else if (msg.method === 'resources/list') {
      if (!msg.params || !msg.params.cursor) {
        send({ jsonrpc: '2.0', id: msg.id, result: { resources: [{ uri: 'mem://a', name: 'a', mimeType: 'text/plain' }], nextCursor: 'p2' } });
      } else {
        send({ jsonrpc: '2.0', id: msg.id, result: { resources: [{ uri: 'mem://b', name: 'b', mimeType: 'image/png' }] } });
      }
    } else if (msg.method === 'resources/templates/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { resourceTemplates: [{ uriTemplate: 'mem://{id}', name: 'any' }] } });
    } else if (msg.method === 'resources/read') {
      const uri = msg.params.uri;
      if (uri === 'mem://a') send({ jsonrpc: '2.0', id: msg.id, result: { contents: [{ uri, mimeType: 'text/plain', text: 'alpha' }] } });
      else if (uri === 'mem://b') send({ jsonrpc: '2.0', id: msg.id, result: { contents: [{ uri, mimeType: 'image/png', blob: 'aGVsbG8gd29ybGQ=' }] } });
      else if (uri === 'mem://big') send({ jsonrpc: '2.0', id: msg.id, result: { contents: [{ uri, text: 'x'.repeat(5000) }] } });
      else send({ jsonrpc: '2.0', id: msg.id, error: { code: -32002, message: 'Resource not found: ' + uri } });
    } else if (msg.method === 'prompts/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { prompts: [{ name: 'greet', description: 'Greets', arguments: [{ name: 'who', required: true }] }] } });
    } else if (msg.method === 'prompts/get') {
      const who = (msg.params.arguments || {}).who || 'nobody';
      send({ jsonrpc: '2.0', id: msg.id, result: { description: 'Greets', messages: [{ role: 'user', content: { type: 'text', text: 'Hello ' + who } }] } });
    } else if (msg.method === 'tools/call') {
      const name = msg.params.name;
      if (name === 'ask') {
        askClient('elicitation/create', { message: 'Your name?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } })
          .then((reply) => send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(reply.result || reply.error) }] } }));
      } else if (name === 'sample') {
        askClient('sampling/createMessage', { messages: [{ role: 'user', content: { type: 'text', text: 'Say hi' } }], maxTokens: 20, modelPreferences: { hints: [{ name: 'tiny' }] } })
          .then((reply) => send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(reply.result || reply.error) }] } }));
      } else if (name === 'caps') {
        send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(globalThis.clientCapabilities) }] } });
      } else if (name === 'notify') {
        send({ jsonrpc: '2.0', method: 'notifications/resources/list_changed' });
        send({ jsonrpc: '2.0', method: 'notifications/prompts/list_changed' });
        send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'sent' }] } });
      } else {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Unknown tool' } });
      }
    } else {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Unknown method: ' + msg.method } });
    }
  }
});
`;

function makeConfig(extras: Partial<MCPServerConfig["connection"]> = {}): MCPServerConfig {
  return {
    serverId: "stdio_mcp",
    registryServerId: "mcp_feat",
    label: "features",
    connection: { command: process.execPath, args: ["-e", FEATURE_SERVER_SCRIPT], timeoutMs: 5000, ...extras }
  };
}

function makeContext(extra: Partial<MCPExecutionContext> = {}): MCPExecutionContext {
  return { resolveSecret: async () => undefined, runtimeState: new Map<string, unknown>(), ...extra };
}

describe("StdioMCPServerAdapter resources, prompts, elicitation and sampling", () => {
  it("reads capabilities, pages through resources, lists templates and reads text and blobs", async () => {
    const adapter = new StdioMCPServerAdapter();
    const context = makeContext();
    try {
      expect(await adapter.describeServer(makeConfig(), context)).toEqual({
        tools: { listChanged: true },
        resources: { listChanged: true },
        prompts: {}
      });
      const resources = await adapter.listResources(makeConfig(), context);
      expect(resources.map((resource) => resource.uri)).toEqual(["mem://a", "mem://b"]);
      expect(await adapter.listResourceTemplates(makeConfig(), context)).toEqual([{ uriTemplate: "mem://{id}", name: "any" }]);
      const text = await adapter.readResource("mem://a", makeConfig(), context);
      expect(text).toEqual({ uri: "mem://a", contents: [{ uri: "mem://a", mimeType: "text/plain", text: "alpha" }], bytes: 5 });
      const blob = await adapter.readResource("mem://b", makeConfig(), context);
      expect(blob.contents[0]).toMatchObject({ blob: "aGVsbG8gd29ybGQ=" });
      expect(blob.bytes).toBe(11);
      await expect(adapter.readResource("mem://big", makeConfig(), context, { maxBytes: 1000 })).rejects.toThrow(/read limit/);
      await expect(adapter.readResource("mem://missing", makeConfig(), context)).rejects.toThrow(/Resource not found/);
    } finally {
      await adapter.closeSessions(context);
    }
  });

  it("lists prompts and gets one with arguments", async () => {
    const adapter = new StdioMCPServerAdapter();
    const context = makeContext();
    try {
      expect(await adapter.listPrompts(makeConfig(), context)).toEqual([
        { name: "greet", description: "Greets", arguments: [{ name: "who", required: true }] }
      ]);
      const prompt = await adapter.getPrompt("greet", { who: "Ada" }, makeConfig(), context);
      expect(prompt).toEqual({ name: "greet", description: "Greets", messages: [{ role: "user", content: { type: "text", text: "Hello Ada" } }] });
    } finally {
      await adapter.closeSessions(context);
    }
  });

  it("advertises elicitation always and sampling only with a handler", async () => {
    const adapter = new StdioMCPServerAdapter();
    const plain = makeContext();
    const sampling = makeContext({ onSampling: async () => ({ role: "assistant", content: { type: "text", text: "" }, model: "m" }) });
    try {
      const withoutSampling = await adapter.invokeTool("caps", {}, makeConfig(), plain);
      expect(JSON.parse(String(withoutSampling.output))).toEqual({ elicitation: {} });
      const withSampling = await adapter.invokeTool("caps", {}, makeConfig(), sampling);
      expect(JSON.parse(String(withSampling.output))).toEqual({ elicitation: {}, sampling: {} });
    } finally {
      await adapter.closeSessions(plain);
      await adapter.closeSessions(sampling);
    }
  });

  it("answers elicitation/create through the handler, declines without one, and keeps the call alive while a person answers", async () => {
    const adapter = new StdioMCPServerAdapter();
    const seen: Array<{ request: McpElicitationRequest; toolName?: string }> = [];
    const answering = makeContext({
      onElicitation: async (request, origin) => {
        seen.push({ request, toolName: origin.toolName });
        // Longer than the per-request timeout below: the timeout is suspended while the person answers.
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return { action: "accept", content: { name: "Ada" } };
      }
    });
    const declining = makeContext();
    try {
      const accepted = await adapter.invokeTool("ask", {}, makeConfig({ timeoutMs: 1000 }), answering);
      expect(accepted.ok).toBe(true);
      expect(JSON.parse(String(accepted.output))).toEqual({ action: "accept", content: { name: "Ada" } });
      expect(seen).toHaveLength(1);
      expect(seen[0].request.message).toBe("Your name?");
      expect(seen[0].toolName).toBe("ask");

      const declined = await adapter.invokeTool("ask", {}, makeConfig(), declining);
      expect(JSON.parse(String(declined.output))).toEqual({ action: "decline" });
    } finally {
      await adapter.closeSessions(answering);
      await adapter.closeSessions(declining);
    }
  });

  it("answers sampling/createMessage through the handler and refuses without one", async () => {
    const adapter = new StdioMCPServerAdapter();
    const requests: McpSamplingRequest[] = [];
    const sampling = makeContext({
      onSampling: async (request) => {
        requests.push(request);
        return { role: "assistant", content: { type: "text", text: "hi there" }, model: "tiny-1", stopReason: "endTurn" };
      }
    });
    const plain = makeContext();
    try {
      const answered = await adapter.invokeTool("sample", {}, makeConfig(), sampling);
      expect(JSON.parse(String(answered.output))).toEqual({ role: "assistant", content: { type: "text", text: "hi there" }, model: "tiny-1", stopReason: "endTurn" });
      expect(requests[0].maxTokens).toBe(20);
      expect(requests[0].modelPreferences?.hints).toEqual([{ name: "tiny" }]);

      const refused = await adapter.invokeTool("sample", {}, makeConfig(), plain);
      expect(JSON.parse(String(refused.output))).toMatchObject({ code: -32001, message: expect.stringContaining("Sampling is not available") });
    } finally {
      await adapter.closeSessions(sampling);
      await adapter.closeSessions(plain);
    }
  });

  it("forwards list_changed notifications with the registry server id", async () => {
    const adapter = new StdioMCPServerAdapter();
    const events: McpListChangedEvent[] = [];
    const context = makeContext({ onListChanged: (event) => events.push(event) });
    try {
      const result = await adapter.invokeTool("notify", {}, makeConfig(), context);
      expect(result.output).toBe("sent");
      expect(events.map((event) => event.kind)).toEqual(["resources", "prompts"]);
      expect(events[0]).toMatchObject({ serverId: "stdio_mcp", registryServerId: "mcp_feat" });
    } finally {
      await adapter.closeSessions(context);
    }
  });
});
