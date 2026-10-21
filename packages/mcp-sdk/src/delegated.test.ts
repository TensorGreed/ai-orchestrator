import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { McpToolPolicySubject, MCPServerConfig } from "@ai-orchestrator/shared";
import { HttpMCPServerAdapter } from "./adapters/http-mcp";
import { McpDelegatedCredentialError } from "./errors";
import { isDelegatedCredentialError, resolveDelegatedUser, withDelegatedUser } from "./delegated";
import type { McpAccessTokenOptions, MCPExecutionContext } from "./types";

const delegated = (fallback: "none" | "owner" = "none"): MCPServerConfig => ({
  serverId: "http_mcp",
  registryServerId: "mcp_tracker",
  label: "Tracker",
  credentialMode: "delegated",
  delegatedFallback: fallback,
  connection: { endpoint: "http://127.0.0.1:9/mcp", authType: "oauth" }
});

const subject = (source: McpToolPolicySubject["source"], userId?: string): McpToolPolicySubject => ({
  role: "builder",
  source,
  ...(userId ? { userId } : {})
});

describe("resolveDelegatedUser", () => {
  it("uses the person who started the run, and the gateway client's owner", () => {
    expect(resolveDelegatedUser(delegated(), subject("user", "u_alice"))).toEqual({ userId: "u_alice", source: "user" });
    expect(resolveDelegatedUser(delegated(), subject("client", "u_bob"))).toEqual({ userId: "u_bob", source: "client" });
  });

  it("uses the workflow owner for unattended runs only when the server allows it", () => {
    expect(resolveDelegatedUser(delegated("owner"), subject("owner", "u_owner"))).toEqual({ userId: "u_owner", source: "owner" });
    expect(() => resolveDelegatedUser(delegated("none"), subject("owner", "u_owner"))).toThrow(/no signed-in user/);
  });

  it("fails without any subject, and leaves service servers alone", () => {
    expect(() => resolveDelegatedUser(delegated("owner"), subject("fallback"))).toThrow(McpDelegatedCredentialError);
    expect(() => resolveDelegatedUser(delegated("owner"), undefined)).toThrow(McpDelegatedCredentialError);
    expect(resolveDelegatedUser({ ...delegated(), credentialMode: "service" }, subject("user", "u"))).toBeUndefined();
  });

  it("withDelegatedUser strips a delegatedUser smuggled onto a service server", () => {
    const service: MCPServerConfig = { ...delegated(), credentialMode: "service", delegatedUser: { userId: "u_x", source: "user" } };
    expect(withDelegatedUser(service, subject("user", "u_alice")).delegatedUser).toBeUndefined();
    expect(withDelegatedUser(delegated(), subject("user", "u_alice")).delegatedUser).toEqual({ userId: "u_alice", source: "user" });
    expect(isDelegatedCredentialError(new McpDelegatedCredentialError("x"))).toBe(true);
  });
});

describe("http adapter with delegated credentials", () => {
  let server: Server;
  let endpoint = "";
  const seen: Array<{ method: string; auth: string | undefined; session: string | undefined }> = [];

  beforeAll(async () => {
    let sessions = 0;
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const rpc = JSON.parse(body || "{}") as { id?: string; method?: string };
        seen.push({ method: rpc.method ?? "", auth: request.headers.authorization, session: request.headers["mcp-session-id"] as string | undefined });
        response.setHeader("content-type", "application/json");
        if (rpc.method === "initialize") {
          sessions += 1;
          response.setHeader("mcp-session-id", `session-${sessions}`);
          response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2024-11-05", capabilities: {} } }));
          return;
        }
        if (rpc.method === "tools/call") {
          response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: `as ${request.headers.authorization}` }] } }));
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

  it("asks for each user's own token and never shares a session between users", async () => {
    const requests: Array<{ serverId: string; options?: McpAccessTokenOptions }> = [];
    const adapter = new HttpMCPServerAdapter({
      oauth: {
        getAccessToken: async (serverId, options) => {
          requests.push({ serverId, ...(options ? { options } : {}) });
          if (!options?.userId) throw new Error("no user");
          return `token-of-${options.userId}`;
        }
      }
    });
    const base = { ...delegated(), connection: { endpoint, authType: "oauth" } };
    // One shared runtime state, as a gateway session or a long run would have.
    const context: MCPExecutionContext = { resolveSecret: async () => undefined, runtimeState: new Map() };
    const alice = await adapter.invokeTool("whoami", {}, { ...base, delegatedUser: { userId: "u_alice", source: "user" } }, context);
    const bob = await adapter.invokeTool("whoami", {}, { ...base, delegatedUser: { userId: "u_bob", source: "client" } }, context);
    expect(alice.output).toBe("as Bearer token-of-u_alice");
    expect(bob.output).toBe("as Bearer token-of-u_bob");
    expect(requests.map((entry) => entry.options?.userId)).toEqual(["u_alice", "u_bob"]);
    const calls = seen.filter((entry) => entry.method === "tools/call");
    expect(new Set(calls.map((entry) => entry.session)).size).toBe(2);
    await adapter.closeSessions(context);
  });

  it("fails a delegated call without a user as a credentials error, and never uses a shared secret", async () => {
    const adapter = new HttpMCPServerAdapter({ oauth: { getAccessToken: async () => "service-token" } });
    const context: MCPExecutionContext = { resolveSecret: async () => "shared-secret", runtimeState: new Map() };
    const noUser = await adapter.invokeTool("whoami", {}, { ...delegated(), connection: { endpoint, authType: "oauth" } }, context);
    expect(noUser).toMatchObject({ ok: false, errorKind: "credentials" });
    const bearer = await adapter.invokeTool(
      "whoami",
      {},
      { ...delegated(), secretRef: { secretId: "s" }, connection: { endpoint, authType: "bearer" }, delegatedUser: { userId: "u", source: "user" } },
      context
    );
    expect(bearer).toMatchObject({ ok: false, errorKind: "credentials" });
    expect(bearer.error).toMatch(/needs OAuth/);
  });
});
