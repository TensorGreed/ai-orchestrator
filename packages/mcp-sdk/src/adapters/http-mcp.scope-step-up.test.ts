import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { MCPServerConfig } from "@ai-orchestrator/shared";
import { afterEach, describe, expect, it } from "vitest";
import { McpInsufficientScopeError } from "../errors";
import type { McpAccessTokenOptions, McpOAuthTokenProvider, MCPExecutionContext } from "../types";
import { HttpMCPServerAdapter } from "./http-mcp";

/**
 * MCP step-up authorization in the HTTP client: a 403 with an `insufficient_scope` Bearer challenge is reported as a
 * credentials failure naming the scope, is never sent again, and is passed to the OAuth token provider so the next
 * authorization asks for the scope.
 */

interface Seen {
  method: string;
  headers: IncomingHttpHeaders;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

const CHALLENGE = 'Bearer error="insufficient_scope", scope="mcp:basic mcp:write", resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"';

/** A server that answers initialize and tools/list, and refuses `refuse` with `status` and `wwwAuthenticate`. */
async function startServer(refuse: string, status: number, wwwAuthenticate?: string): Promise<{ endpoint: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const rpc = JSON.parse(body || "{}") as { id?: string | number; method?: string };
      seen.push({ method: String(rpc.method), headers: request.headers });
      if (rpc.id === undefined) {
        response.statusCode = 202;
        response.end();
        return;
      }
      if (rpc.method === refuse) {
        response.statusCode = status;
        if (wwwAuthenticate) response.setHeader("www-authenticate", wwwAuthenticate);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ error: "insufficient_scope", error_description: "Token has insufficient scope" }));
        return;
      }
      const result =
        rpc.method === "initialize"
          ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "s", version: "1" } }
          : rpc.method === "tools/list"
            ? { tools: [{ name: "write_row", inputSchema: { type: "object" } }] }
            : { content: [{ type: "text", text: "ok" }] };
      response.setHeader("content-type", "application/json");
      if (rpc.method === "initialize") response.setHeader("mcp-session-id", "s-1");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    });
  });
  server.keepAliveTimeout = 1;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, seen };
}

function provider(): McpOAuthTokenProvider & { notes: Array<{ serverId: string; scope?: string; options?: McpAccessTokenOptions }> } {
  const notes: Array<{ serverId: string; scope?: string; options?: McpAccessTokenOptions }> = [];
  return {
    notes,
    getAccessToken: async () => "token-1",
    noteInsufficientScope: async (serverId, scope, options) => {
      notes.push({ serverId, ...(scope ? { scope } : {}), ...(options ? { options } : {}) });
    }
  };
}

function configFor(endpoint: string, protocolMode: "legacy" | "modern", authType = "oauth"): MCPServerConfig {
  return { serverId: "srv", registryServerId: "srv", label: "Server", connection: { endpoint, authType, protocolMode, timeoutMs: 5000 } } as MCPServerConfig;
}

const context = (): MCPExecutionContext => ({ resolveSecret: async () => undefined, runtimeState: new Map() });

describe("HTTP client: 403 insufficient_scope (step-up)", () => {
  for (const mode of ["legacy", "modern"] as const) {
    it(`${mode}: a refused tool call is a credentials failure naming the scope, sent once, and noted for the next authorization`, async () => {
      const { endpoint, seen } = await startServer("tools/call", 403, CHALLENGE);
      const oauth = provider();
      const adapter = new HttpMCPServerAdapter({ oauth, protocol: { defaultMode: mode } });
      const ctx = context();
      const result = await adapter.invokeTool("write_row", {}, configFor(endpoint, mode), ctx);
      expect(result.ok).toBe(false);
      expect(result.errorKind).toBe("credentials");
      expect(result.error).toContain("mcp:basic mcp:write");
      expect(seen.filter((entry) => entry.method === "tools/call")).toHaveLength(1);
      expect(seen.every((entry) => entry.headers.authorization === "Bearer token-1")).toBe(true);
      expect(oauth.notes).toEqual([{ serverId: "srv", scope: "mcp:basic mcp:write", options: {} }]);
      await adapter.closeSessions?.(ctx);
    });
  }

  it("a refused tool listing throws the scope error and notes it", async () => {
    const { endpoint } = await startServer("tools/list", 403, CHALLENGE);
    const oauth = provider();
    const adapter = new HttpMCPServerAdapter({ oauth, protocol: { defaultMode: "modern" } });
    const error = await adapter.discoverTools(configFor(endpoint, "modern"), context()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McpInsufficientScopeError);
    expect((error as McpInsufficientScopeError).requiredScope).toBe("mcp:basic mcp:write");
    expect(oauth.notes).toHaveLength(1);
  });

  it("does not note a challenge for servers that do not use OAuth, and a 403 without insufficient_scope is unchanged", async () => {
    const bearer = await startServer("tools/call", 403, CHALLENGE);
    const oauth = provider();
    const adapter = new HttpMCPServerAdapter({ oauth, protocol: { defaultMode: "modern" } });
    const config = configFor(bearer.endpoint, "modern", "bearer");
    (config.connection as Record<string, unknown>).bearerToken = "static";
    const refused = await adapter.invokeTool("write_row", {}, config, context());
    expect(refused.errorKind).toBe("credentials");
    expect(oauth.notes).toEqual([]);

    const plain = await startServer("tools/call", 403, 'Bearer error="invalid_token"');
    const other = await adapter.invokeTool("write_row", {}, configFor(plain.endpoint, "modern"), context());
    expect(other.ok).toBe(false);
    expect(other.errorKind).not.toBe("credentials");
    expect(other.error).toContain("MCP HTTP 403");
    expect(oauth.notes).toEqual([]);
  });
});
