import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createMcpHandler, fromJsonSchema, inputRequired, inputResponse, McpServer } from "@modelcontextprotocol/server";
import type { MCPServerConfig } from "@ai-orchestrator/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MCPExecutionContext } from "../types";
import { HttpMCPServerAdapter } from "./http-mcp";

/**
 * MCP 2026-07-28 — the official TypeScript SDK v2 server as an independent
 * modern (and dual-era) peer for the HTTP client.
 */

interface SeenRequest {
  method?: string;
  protocolVersionHeader?: string;
  hasSessionHeader: boolean;
}

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "sdk-v2-fixture", version: "1.0.0" });
  server.registerTool(
    "sum",
    {
      description: "Add two numbers",
      inputSchema: fromJsonSchema<{ a: number; b: number }>({
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"]
      }),
      annotations: { readOnlyHint: true }
    },
    async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] })
  );
  server.registerTool(
    "deploy",
    {
      description: "Deploy after a confirmation",
      inputSchema: fromJsonSchema<{ env: string }>({ type: "object", properties: { env: { type: "string" } }, required: ["env"] })
    },
    async ({ env }, ctx) => {
      const answer = inputResponse(ctx.mcpReq.inputResponses, "confirm");
      if (answer.kind !== "elicit") {
        return inputRequired({
          inputRequests: {
            confirm: inputRequired.elicit({
              message: `Deploy to ${env}?`,
              requestedSchema: fromJsonSchema({ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] })
            })
          },
          requestState: "state-1"
        });
      }
      return { content: [{ type: "text", text: answer.action === "accept" && answer.content?.ok === true ? `deployed to ${env}` : "not deployed" }] };
    }
  );
  return server;
}

async function startSdkServer(legacy: "stateless" | "reject"): Promise<{ server: Server; endpoint: string; seen: SeenRequest[] }> {
  const handler = createMcpHandler(() => buildMcpServer(), { legacy });
  const seen: SeenRequest[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf-8");
    try {
      seen.push({
        method: (JSON.parse(body || "{}") as { method?: string }).method,
        protocolVersionHeader: req.headers["mcp-protocol-version"] as string | undefined,
        hasSessionHeader: req.headers["mcp-session-id"] !== undefined
      });
    } catch {
      seen.push({ hasSessionHeader: false });
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(key, value);
    }
    const response = await handler.fetch(
      new Request(`http://127.0.0.1${req.url ?? "/"}`, { method: req.method, headers, ...(req.method === "POST" ? { body } : {}) })
    );
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, seen };
}

const contextOf = (extra: Partial<MCPExecutionContext> = {}): MCPExecutionContext => ({
  resolveSecret: async () => undefined,
  runtimeState: new Map(),
  ...extra
});

let modernOnly: Awaited<ReturnType<typeof startSdkServer>>;
let dualEra: Awaited<ReturnType<typeof startSdkServer>>;

beforeAll(async () => {
  modernOnly = await startSdkServer("reject");
  dualEra = await startSdkServer("stateless");
});

afterAll(async () => {
  await Promise.all([modernOnly, dualEra].map(({ server }) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("HTTP client against the official SDK v2 server", () => {
  it("talks 2026-07-28 to a modern-only server in modern mode, including a multi round-trip elicitation", async () => {
    const adapter = new HttpMCPServerAdapter();
    const config: MCPServerConfig = { serverId: "http_mcp", connection: { endpoint: modernOnly.endpoint, protocolMode: "modern" } };
    const asked: string[] = [];
    const context = contextOf({
      onElicitation: async (request) => {
        asked.push(request.message);
        return { action: "accept", content: { ok: true } };
      }
    });
    const tools = await adapter.discoverTools(config, context);
    expect(tools.map((tool) => tool.name).sort()).toEqual(["deploy", "sum"]);
    expect(await adapter.invokeTool("sum", { a: 2, b: 3 }, config, context)).toMatchObject({ ok: true, output: "5" });
    expect(await adapter.invokeTool("deploy", { env: "prod" }, config, context)).toMatchObject({ ok: true, output: "deployed to prod" });
    expect(asked).toEqual(["Deploy to prod?"]);
    expect(modernOnly.seen.every((request) => request.method !== "initialize" && request.protocolVersionHeader === "2026-07-28")).toBe(true);
    expect(modernOnly.seen.some((request) => request.hasSessionHeader)).toBe(false);
    expect(await adapter.describeServer(config, context)).toMatchObject({ tools: {} });
  });

  it("reaches a modern-only server from the default legacy mode by falling forward after initialize is rejected", async () => {
    modernOnly.seen.length = 0;
    const adapter = new HttpMCPServerAdapter();
    const config: MCPServerConfig = { serverId: "http_mcp", connection: { endpoint: modernOnly.endpoint } };
    const context = contextOf();
    expect((await adapter.discoverTools(config, context)).length).toBe(2);
    expect(await adapter.invokeTool("sum", { a: 1, b: 1 }, config, context)).toMatchObject({ ok: true, output: "2" });
    expect(modernOnly.seen.map((request) => request.method)).toEqual(["initialize", "tools/list", "tools/call"]);
    expect(adapter.observedProtocol(config)).toEqual({ era: "modern", version: "2026-07-28" });
  });

  it("keeps using initialize with a dual-era server in legacy mode and switches to 2026-07-28 in auto mode", async () => {
    dualEra.seen.length = 0;
    const legacyAdapter = new HttpMCPServerAdapter();
    const legacyConfig: MCPServerConfig = { serverId: "http_mcp", connection: { endpoint: dualEra.endpoint } };
    expect(await legacyAdapter.invokeTool("sum", { a: 4, b: 4 }, legacyConfig, contextOf())).toMatchObject({ ok: true, output: "8" });
    expect(dualEra.seen[0]).toMatchObject({ method: "initialize" });
    expect(dualEra.seen.some((request) => request.protocolVersionHeader === "2026-07-28")).toBe(false);

    dualEra.seen.length = 0;
    const autoAdapter = new HttpMCPServerAdapter();
    const autoConfig: MCPServerConfig = { serverId: "http_mcp", connection: { endpoint: dualEra.endpoint, protocolMode: "auto" } };
    expect(await autoAdapter.invokeTool("sum", { a: 5, b: 5 }, autoConfig, contextOf())).toMatchObject({ ok: true, output: "10" });
    expect(dualEra.seen[0]).toMatchObject({ method: "server/discover", protocolVersionHeader: "2026-07-28" });
    expect(dualEra.seen.some((request) => request.method === "initialize")).toBe(false);
  });
});
