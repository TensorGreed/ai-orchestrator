import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { McpClientProtocolMode, MCPServerConfig } from "@ai-orchestrator/shared";
import type { MCPExecutionContext } from "../types";
import { StdioMCPServerAdapter } from "./stdio-mcp";

/**
 * MCP 2026-07-28 — the official TypeScript SDK v2 stdio server
 * (`serveStdio`) as an independent peer for the stdio client: dual-era by
 * default, modern-only with SDK_V2_LEGACY=reject.
 */
const FIXTURE = fileURLToPath(new URL("./fixtures/sdk-v2-stdio-server.mjs", import.meta.url));

const open: Array<{ adapter: StdioMCPServerAdapter; context: MCPExecutionContext }> = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map(({ adapter, context }) => adapter.closeSessions(context)));
});

function configFor(legacy: "serve" | "reject", protocolMode?: McpClientProtocolMode): MCPServerConfig {
  return {
    serverId: "stdio_mcp",
    label: "sdk v2",
    connection: {
      command: process.execPath,
      args: [FIXTURE],
      timeoutMs: 10_000,
      env: { SDK_V2_LEGACY: legacy },
      ...(protocolMode ? { protocolMode } : {})
    }
  };
}

function contextFor(adapter: StdioMCPServerAdapter, extra: Partial<MCPExecutionContext> = {}): MCPExecutionContext {
  const context: MCPExecutionContext = { resolveSecret: async () => undefined, runtimeState: new Map<string, unknown>(), ...extra };
  open.push({ adapter, context });
  return context;
}

describe("stdio client against the SDK v2 server", () => {
  it("auto: talks 2026-07-28 to a dual-era server and answers an input round", async () => {
    const adapter = new StdioMCPServerAdapter();
    const config = configFor("serve", "auto");
    const context = contextFor(adapter, { onElicitation: async () => ({ action: "accept", content: { ok: true } }) });
    expect(await adapter.describeServer(config, context)).toMatchObject({ tools: { listChanged: true } });
    const tools = await adapter.discoverTools(config, context);
    expect(tools.map((tool) => tool.name).sort()).toEqual(["deploy", "sum"]);
    expect(await adapter.invokeTool("sum", { a: 2, b: 3 }, config, context)).toMatchObject({ ok: true, output: "5" });
    expect(await adapter.invokeTool("deploy", { env: "prod" }, config, context)).toMatchObject({ ok: true, output: "deployed to prod" });
    expect(adapter.observedProtocol(config)).toEqual({ era: "modern", version: "2026-07-28" });
  }, 20_000);

  it("legacy: opens a dual-era server with initialize, as before", async () => {
    const adapter = new StdioMCPServerAdapter();
    const config = configFor("serve");
    const context = contextFor(adapter);
    expect(await adapter.invokeTool("sum", { a: 1, b: 1 }, config, context)).toMatchObject({ ok: true, output: "2" });
    expect(adapter.observedProtocol(config)).toEqual({ era: "legacy" });
  }, 20_000);

  it("legacy: reaches a modern-only server by falling forward", async () => {
    const adapter = new StdioMCPServerAdapter();
    const config = configFor("reject");
    const context = contextFor(adapter, { onElicitation: async () => ({ action: "decline" }) });
    expect(await adapter.invokeTool("deploy", { env: "staging" }, config, context)).toMatchObject({ ok: true, output: "not deployed" });
    expect(adapter.observedProtocol(config)).toEqual({ era: "modern", version: "2026-07-28" });
  }, 20_000);

  it("modern: works against a modern-only server", async () => {
    const adapter = new StdioMCPServerAdapter();
    const config = configFor("reject", "modern");
    expect(await adapter.invokeTool("sum", { a: 4, b: 5 }, config, contextFor(adapter))).toMatchObject({ ok: true, output: "9" });
  }, 20_000);
});
