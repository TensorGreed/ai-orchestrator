import { describe, expect, it } from "vitest";
import type { MCPServerConfig, MCPToolResult } from "@ai-orchestrator/shared";
import type { MCPExecutionContext, MCPServerAdapter } from "./types";
import { expandSecretBundle, parseSecretBundle, secretValuesForScrub, withSecretBundle } from "./secret-bundle";
import { createDefaultMCPRegistry } from "./index";

function context(secret: string | undefined): MCPExecutionContext {
  return { resolveSecret: async () => secret, runtimeState: new Map() };
}

class RecordingAdapter implements MCPServerAdapter {
  readonly definition = { id: "rec", label: "Recording", description: "", configSchema: {}, authSchema: {} };
  seen: MCPServerConfig[] = [];
  closed = 0;
  async discoverTools(config: MCPServerConfig, _context: MCPExecutionContext) {
    this.seen.push(config);
    return [];
  }
  async invokeTool(
    _name: string,
    _args: Record<string, unknown>,
    config: MCPServerConfig,
    _context: MCPExecutionContext
  ): Promise<MCPToolResult> {
    this.seen.push(config);
    return { ok: true, output: null };
  }
  closeSessions(_context: MCPExecutionContext) {
    this.closed += 1;
  }
}

describe("secret bundle", () => {
  it("parses only JSON objects of strings", () => {
    expect(parseSecretBundle('{"A":"1","B":2}')).toEqual({ A: "1" });
    expect(parseSecretBundle("plain-token")).toBeNull();
    expect(parseSecretBundle("[1]")).toBeNull();
    expect(parseSecretBundle(undefined)).toBeNull();
  });

  it("lists every bundle value for scrubbing", () => {
    expect(secretValuesForScrub('{"A":"alpha-1","B":"beta-22"}')).toEqual(["alpha-1", "beta-22"]);
    expect(secretValuesForScrub("single-token")).toEqual(["single-token"]);
    expect(secretValuesForScrub("abc")).toEqual([]);
  });

  it("merges env vars and headers and drops the secret ref", async () => {
    const config: MCPServerConfig = {
      serverId: "stdio_mcp",
      connection: { command: "node", env: { MODE: "x" }, secretEnvVars: ["API_KEY", "API_SECRET"], secretEnvVar: "IGNORED" },
      secretRef: { secretId: "sec_1" }
    };
    const expanded = await expandSecretBundle(config, context('{"API_KEY":"k-1","API_SECRET":"s-2","OTHER":"o"}'));
    expect(expanded.secretRef).toBeUndefined();
    expect(expanded.connection).toEqual({ command: "node", env: { MODE: "x", API_KEY: "k-1", API_SECRET: "s-2" } });
    // The stored config is untouched.
    expect(config.connection?.env).toEqual({ MODE: "x" });

    const http = await expandSecretBundle(
      { serverId: "http_mcp", connection: { endpoint: "https://x", secretHeaders: ["X-Api-Key"] }, secretRef: { secretId: "s" } },
      context('{"X-Api-Key":"hk"}')
    );
    expect(http.connection?.headers).toEqual({ "X-Api-Key": "hk" });
  });

  it("fails clearly when the secret is not a bundle", async () => {
    await expect(
      expandSecretBundle(
        { serverId: "stdio_mcp", connection: { command: "x", secretEnvVars: ["A"] }, secretRef: { secretId: "s" } },
        context("not-json")
      )
    ).rejects.toThrow(/not a JSON object/);
  });

  it("wraps adapter methods that take a config and passes others through", async () => {
    const inner = new RecordingAdapter();
    const adapter = withSecretBundle(inner);
    const ctx = context('{"A":"one1"}');
    await adapter.invokeTool("t", {}, { serverId: "rec", connection: { secretEnvVars: ["A"] }, secretRef: { secretId: "s" } }, ctx);
    await adapter.discoverTools({ serverId: "rec", connection: { command: "plain" } }, ctx);
    adapter.closeSessions?.(ctx);
    expect(inner.seen[0]!.connection).toEqual({ env: { A: "one1" } });
    expect(inner.seen[1]!.connection).toEqual({ command: "plain" });
    expect(inner.closed).toBe(1);
    expect(adapter.definition.id).toBe("rec");
  });

  it("is applied to the stdio and http adapters of the default registry", () => {
    const registry = createDefaultMCPRegistry();
    expect(registry.get("stdio_mcp").definition.id).toBe("stdio_mcp");
    expect(registry.get("http_mcp").definition.id).toBe("http_mcp");
  });
});
