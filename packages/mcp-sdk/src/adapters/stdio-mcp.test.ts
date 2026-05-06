import { describe, expect, it } from "vitest";
import type { MCPServerConfig } from "@ai-orchestrator/shared";
import { StdioMCPServerAdapter } from "./stdio-mcp";

const ECHO_SERVER_SCRIPT = `
process.stdin.setEncoding('utf-8');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl = buf.indexOf('\\n');
  while (nl >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    nl = buf.indexOf('\\n');
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    if (req.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: req.id,
        result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'echo-test', version: '1.0' } }
      }) + '\\n');
    } else if (req.method === 'notifications/initialized') {
      // no response
    } else if (req.method === 'tools/list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          tools: [
            { name: 'echo', description: 'echoes the msg argument', inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] } },
            { name: 'add', description: 'returns a + b as structured content', inputSchema: { type: 'object' } }
          ]
        }
      }) + '\\n');
    } else if (req.method === 'tools/call') {
      const name = req.params && req.params.name;
      const args = (req.params && req.params.arguments) || {};
      if (name === 'echo') {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: req.id,
          result: { content: [{ type: 'text', text: 'echo: ' + (args.msg || '') }] }
        }) + '\\n');
      } else if (name === 'add') {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: req.id,
          result: { structuredContent: { sum: (Number(args.a) || 0) + (Number(args.b) || 0) } }
        }) + '\\n');
      } else if (name === 'envcheck') {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: req.id,
          result: { content: [{ type: 'text', text: 'TEST_TOKEN=' + (process.env.TEST_TOKEN || '') }] }
        }) + '\\n');
      } else {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: req.id,
          error: { code: -32601, message: 'Unknown tool: ' + name }
        }) + '\\n');
      }
    } else {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -32601, message: 'Unknown method: ' + req.method }
      }) + '\\n');
    }
  }
});
`;

function makeContext(secret?: string) {
  return {
    resolveSecret: async () => secret,
    runtimeState: new Map<string, unknown>()
  };
}

function makeConfig(extras: Partial<MCPServerConfig["connection"]> = {}, secretRef?: { secretId: string }): MCPServerConfig {
  return {
    serverId: "stdio_mcp",
    label: "echo test",
    connection: {
      command: process.execPath,
      args: ["-e", ECHO_SERVER_SCRIPT],
      timeoutMs: 5000,
      ...extras
    },
    secretRef
  };
}

describe("StdioMCPServerAdapter", () => {
  it("discovers tools advertised by a stdio JSON-RPC server", async () => {
    const adapter = new StdioMCPServerAdapter();
    const tools = await adapter.discoverTools(makeConfig(), makeContext());

    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe("echo");
    expect(tools[0].serverId).toBe("stdio_mcp");
    expect(tools[0].serverLabel).toBe("echo test");
    expect(tools[0].inputSchema).toMatchObject({ type: "object" });
  });

  it("invokes a tool and normalizes text content output", async () => {
    const adapter = new StdioMCPServerAdapter();
    const result = await adapter.invokeTool(
      "echo",
      { msg: "hello" },
      makeConfig(),
      makeContext()
    );

    expect(result.ok).toBe(true);
    expect(result.output).toBe("echo: hello");
  });

  it("returns structuredContent verbatim when the server provides it", async () => {
    const adapter = new StdioMCPServerAdapter();
    const result = await adapter.invokeTool(
      "add",
      { a: 2, b: 3 },
      makeConfig(),
      makeContext()
    );

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ sum: 5 });
  });

  it("surfaces JSON-RPC tool errors as ok=false with error message", async () => {
    const adapter = new StdioMCPServerAdapter();
    const result = await adapter.invokeTool(
      "no_such_tool",
      {},
      makeConfig(),
      makeContext()
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unknown tool");
  });

  it("injects a resolved secret into the child process env via secretEnvVar", async () => {
    const adapter = new StdioMCPServerAdapter();
    const result = await adapter.invokeTool(
      "envcheck",
      {},
      makeConfig({ secretEnvVar: "TEST_TOKEN" }, { secretId: "sec_test" }),
      makeContext("super-secret-value")
    );

    expect(result.ok).toBe(true);
    expect(result.output).toBe("TEST_TOKEN=super-secret-value");
  });

  it("reuses the cached process across discoverTools and invokeTool in the same runtimeState", async () => {
    const adapter = new StdioMCPServerAdapter();
    const ctx = makeContext();

    await adapter.discoverTools(makeConfig(), ctx);
    await adapter.invokeTool("echo", { msg: "first" }, makeConfig(), ctx);
    const result = await adapter.invokeTool("echo", { msg: "second" }, makeConfig(), ctx);

    expect(result.ok).toBe(true);
    expect(result.output).toBe("echo: second");
    // runtimeState should hold exactly one cached session keyed by config hash
    expect(ctx.runtimeState.size).toBe(1);
  });

  it("rejects with a helpful error when the command cannot be spawned", async () => {
    const adapter = new StdioMCPServerAdapter();
    const config: MCPServerConfig = {
      serverId: "stdio_mcp",
      connection: {
        command: "definitely-not-a-real-binary-xyzzy",
        args: [],
        timeoutMs: 2000
      }
    };

    await expect(adapter.discoverTools(config, makeContext())).rejects.toThrow(
      /could not start|was not found/i
    );
  });

  it("rejects when the connection config is missing the command field", async () => {
    const adapter = new StdioMCPServerAdapter();
    const config: MCPServerConfig = {
      serverId: "stdio_mcp",
      connection: { timeoutMs: 1000 }
    };

    await expect(adapter.discoverTools(config, makeContext())).rejects.toThrow(/command/i);
  });
});
