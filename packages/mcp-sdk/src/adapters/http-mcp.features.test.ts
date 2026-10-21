import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MCPServerConfig, McpListChangedEvent } from "@ai-orchestrator/shared";
import type { MCPExecutionContext } from "../types";
import { HttpMCPServerAdapter } from "./http-mcp";

/**
 * Fake streamable-HTTP server: JSON answers for lists and reads; `tools/call`
 * answers over SSE and, for the `ask` and `sample` tools, first sends a
 * server request on the stream and waits for the client to POST its response.
 */
let server: Server;
let endpoint = "";
const clientResponses = new Map<string, (message: Record<string, unknown>) => void>();
let clientCapabilities: unknown = null;
let posted: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const rpc = JSON.parse(body || "{}") as Record<string, unknown>;
      posted.push(rpc);
      const id = rpc.id as string | number | undefined;
      const params = (rpc.params ?? {}) as Record<string, unknown>;
      // A response from the client to a request the server made.
      if (rpc.method === undefined && typeof id === "string" && clientResponses.has(id)) {
        clientResponses.get(id)?.(rpc);
        clientResponses.delete(id);
        response.statusCode = 202;
        response.end();
        return;
      }
      if (rpc.method === undefined && rpc.method !== "initialize" && id === undefined) {
        response.statusCode = 202;
        response.end();
        return;
      }
      const json = (result: unknown) => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      };
      switch (rpc.method) {
        case "initialize":
          clientCapabilities = params.capabilities;
          response.setHeader("mcp-session-id", "sess-1");
          json({ protocolVersion: "2025-06-18", capabilities: { resources: { listChanged: true }, prompts: {} } });
          return;
        case "notifications/initialized":
          response.statusCode = 202;
          response.end();
          return;
        case "tools/list":
          json({ tools: [{ name: "ask", inputSchema: { type: "object" } }, { name: "sample", inputSchema: { type: "object" } }, { name: "notify", inputSchema: { type: "object" } }] });
          return;
        case "resources/list":
          json(params.cursor ? { resources: [{ uri: "http://x/b", name: "b" }] } : { resources: [{ uri: "http://x/a", name: "a" }], nextCursor: "2" });
          return;
        case "resources/templates/list":
          json({ resourceTemplates: [{ uriTemplate: "http://x/{id}", name: "t" }] });
          return;
        case "resources/read":
          json({ contents: [{ uri: params.uri, mimeType: "text/plain", text: `content of ${String(params.uri)}` }] });
          return;
        case "prompts/list":
          json({ prompts: [{ name: "greet", arguments: [{ name: "who" }] }] });
          return;
        case "prompts/get":
          json({ messages: [{ role: "user", content: { type: "text", text: `Hello ${String((params.arguments as Record<string, string> | undefined)?.who ?? "")}` } }] });
          return;
        case "tools/call": {
          response.setHeader("content-type", "text/event-stream");
          const write = (message: unknown) => response.write(`data: ${JSON.stringify(message)}\n\n`);
          const finish = (text: string) => {
            write({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
            response.end();
          };
          const name = params.name;
          if (name === "notify") {
            write({ jsonrpc: "2.0", method: "notifications/resources/list_changed" });
            finish("sent");
            return;
          }
          const requestId = `srv-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          clientResponses.set(requestId, (reply) => finish(JSON.stringify(reply.result ?? reply.error)));
          if (name === "ask") {
            write({
              jsonrpc: "2.0",
              id: requestId,
              method: "elicitation/create",
              params: { message: "Region?", requestedSchema: { type: "object", properties: { region: { type: "string", enum: ["eu", "us"] } }, required: ["region"] } }
            });
          } else {
            write({
              jsonrpc: "2.0",
              id: requestId,
              method: "sampling/createMessage",
              params: { messages: [{ role: "user", content: { type: "text", text: "Say hi" } }], maxTokens: 10 }
            });
          }
          return;
        }
        default:
          json({});
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeConfig(): MCPServerConfig {
  return { serverId: "http_mcp", registryServerId: "mcp_http", connection: { endpoint, transport: "http_streamable", timeoutMs: 2000 } };
}

function makeContext(extra: Partial<MCPExecutionContext> = {}): MCPExecutionContext {
  return { resolveSecret: async () => undefined, runtimeState: new Map<string, unknown>(), ...extra };
}

describe("HttpMCPServerAdapter resources, prompts, elicitation and sampling", () => {
  it("captures capabilities, lists resources across pages, reads one and gets prompts", async () => {
    const adapter = new HttpMCPServerAdapter();
    const context = makeContext();
    expect(await adapter.describeServer(makeConfig(), context)).toEqual({ resources: { listChanged: true }, prompts: {} });
    expect(clientCapabilities).toEqual({ elicitation: {} });
    expect((await adapter.listResources(makeConfig(), context)).map((resource) => resource.uri)).toEqual(["http://x/a", "http://x/b"]);
    expect(await adapter.listResourceTemplates(makeConfig(), context)).toEqual([{ uriTemplate: "http://x/{id}", name: "t" }]);
    const read = await adapter.readResource("http://x/a", makeConfig(), context);
    expect(read.contents).toEqual([{ uri: "http://x/a", mimeType: "text/plain", text: "content of http://x/a" }]);
    expect(await adapter.listPrompts(makeConfig(), context)).toEqual([{ name: "greet", arguments: [{ name: "who" }] }]);
    const prompt = await adapter.getPrompt("greet", { who: "Bob" }, makeConfig(), context);
    expect(prompt.messages[0].content).toEqual({ type: "text", text: "Hello Bob" });
    await adapter.closeSessions(context);
  });

  it("answers an elicitation request received on the SSE stream, pausing the request timeout while a person answers", async () => {
    const adapter = new HttpMCPServerAdapter();
    const context = makeContext({
      onElicitation: async (request, origin) => {
        expect(request.message).toBe("Region?");
        expect(origin).toEqual({ serverId: "http_mcp", registryServerId: "mcp_http", toolName: "ask" });
        await new Promise((resolve) => setTimeout(resolve, 2500));
        return { action: "accept", content: { region: "eu" } };
      }
    });
    posted = [];
    const result = await adapter.invokeTool("ask", {}, makeConfig(), context);
    expect(result.ok).toBe(true);
    expect(JSON.parse(String(result.output))).toEqual({ action: "accept", content: { region: "eu" } });
    const reply = posted.find((message) => message.method === undefined && typeof message.id === "string" && String(message.id).startsWith("srv-"));
    expect(reply?.result).toEqual({ action: "accept", content: { region: "eu" } });
    await adapter.closeSessions(context);
  });

  it("declines elicitation without a handler and answers sampling with the model handler", async () => {
    const adapter = new HttpMCPServerAdapter();
    const plain = makeContext();
    const declined = await adapter.invokeTool("ask", {}, makeConfig(), plain);
    expect(JSON.parse(String(declined.output))).toEqual({ action: "decline" });
    const refused = await adapter.invokeTool("sample", {}, makeConfig(), plain);
    expect(JSON.parse(String(refused.output))).toMatchObject({ code: -32001 });
    await adapter.closeSessions(plain);

    const sampling = makeContext({ onSampling: async () => ({ role: "assistant", content: { type: "text", text: "hi" }, model: "m1" }) });
    const answered = await adapter.invokeTool("sample", {}, makeConfig(), sampling);
    expect(JSON.parse(String(answered.output))).toEqual({ role: "assistant", content: { type: "text", text: "hi" }, model: "m1" });
    expect(clientCapabilities).toEqual({ elicitation: {}, sampling: {} });
    await adapter.closeSessions(sampling);
  });

  it("forwards list_changed notifications from the stream", async () => {
    const adapter = new HttpMCPServerAdapter();
    const events: McpListChangedEvent[] = [];
    const context = makeContext({ onListChanged: (event) => events.push(event) });
    const result = await adapter.invokeTool("notify", {}, makeConfig(), context);
    expect(result.output).toBe("sent");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "resources", serverId: "http_mcp", registryServerId: "mcp_http" });
    await adapter.closeSessions(context);
  });
});
