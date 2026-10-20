import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpMCPServerAdapter } from "./http-mcp";

/** Minimal streamable-HTTP MCP server: initialize, notifications, tools/list. */
let server: Server;
let endpoint = "";

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const rpc = JSON.parse(body || "{}") as { id?: string; method?: string };
      response.setHeader("content-type", "application/json");
      if (rpc.method === "initialize") {
        response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2024-11-05", capabilities: {} } }));
        return;
      }
      if (rpc.method === "tools/list") {
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              tools: [
                {
                  name: "list_issues",
                  description: "List issues",
                  inputSchema: { type: "object" },
                  annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: "yes" }
                },
                { name: "delete_issue", description: "Delete an issue", inputSchema: { type: "object" }, annotations: { destructiveHint: true } },
                { name: "plain", description: "No annotations", inputSchema: { type: "object" }, annotations: "not-an-object" }
              ]
            }
          })
        );
        return;
      }
      response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result: {} }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("HttpMCPServerAdapter tool annotations", () => {
  it("keeps well-typed annotation hints from tools/list and drops the rest", async () => {
    const adapter = new HttpMCPServerAdapter();
    const tools = await adapter.discoverTools(
      { serverId: "http_mcp", connection: { endpoint } },
      { resolveSecret: async () => undefined, runtimeState: new Map() }
    );

    expect(tools.map((tool) => tool.name)).toEqual(["list_issues", "delete_issue", "plain"]);
    expect(tools[0].annotations).toEqual({ readOnlyHint: true, openWorldHint: true });
    expect(tools[1].annotations).toEqual({ destructiveHint: true });
    expect(tools[2]).not.toHaveProperty("annotations");
  });
});
