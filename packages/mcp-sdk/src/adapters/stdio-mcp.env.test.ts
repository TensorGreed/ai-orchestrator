import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MCPServerConfig } from "@ai-orchestrator/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultMCPRegistry } from "../index";
import type { MCPExecutionContext } from "../types";
import { StdioMCPServerAdapter } from "./stdio-mcp";

/**
 * A server started on the host gets only an allowlisted part of the API's environment plus its own variables, so
 * the master key and database URL never reach it unless the operator asks for the whole environment.
 */

/** A legacy server whose `env` tool answers with the names and values of its whole environment. */
const ENV_REPORTING_SERVER = `
let buf = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const req = JSON.parse(line);
    const answer = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\\n');
    if (req.method === 'initialize') {
      answer({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'env', version: '1' } });
    } else if (req.method === 'tools/list') {
      answer({ tools: [{ name: 'env', inputSchema: { type: 'object' } }] });
    } else if (req.method === 'tools/call') {
      answer({ content: [{ type: 'text', text: JSON.stringify(process.env) }] });
    } else if (req.id !== undefined) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'unknown' } }) + '\\n');
    }
  }
});
`;

const FAKE_SECRETS = {
  SECRET_MASTER_KEY_BASE64: "ZW52Zml4LXRlc3QtbWFzdGVyLWtleS0zMi1ieXRlcyE=",
  DATABASE_URL: "postgres://l2m:hunter2@db.internal:5432/l2m",
  L2M_ENVFIX_PASSTHROUGH_ONE: "passed"
};
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const [name, value] of Object.entries(FAKE_SECRETS)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const contextOf = (): MCPExecutionContext => ({ resolveSecret: async () => "from-secret-store", runtimeState: new Map() });

function serverConfig(extra?: Record<string, unknown>): MCPServerConfig {
  return {
    serverId: "env-report",
    label: "env report",
    secretRef: { secretId: "s1" },
    connection: {
      command: process.execPath,
      args: ["-e", ENV_REPORTING_SERVER],
      env: { SERVER_OWN: "own" },
      secretEnvVar: "SERVER_TOKEN",
      timeoutMs: 10_000,
      ...extra
    }
  } as unknown as MCPServerConfig;
}

/** The environment the `env` tool reported, from a plain text result or a content list. */
function envOf(output: unknown): Record<string, string> {
  const content = output as { content?: Array<{ text?: string }> } | string;
  const text = typeof content === "string" ? content : content.content?.[0]?.text ?? "{}";
  return JSON.parse(text) as Record<string, string>;
}

async function reportedEnv(adapter: StdioMCPServerAdapter, config = serverConfig()): Promise<Record<string, string>> {
  const context = contextOf();
  try {
    const result = await adapter.invokeTool("env", {}, config, context);
    expect(result.ok).toBe(true);
    return envOf(result.output);
  } finally {
    await adapter.closeSessions(context);
  }
}

describe("stdio: host environment", () => {
  it("keeps the master key and database URL out of a host-launched server by default", async () => {
    const env = await reportedEnv(new StdioMCPServerAdapter());
    expect(env).not.toHaveProperty("SECRET_MASTER_KEY_BASE64");
    expect(env).not.toHaveProperty("DATABASE_URL");
    expect(env).not.toHaveProperty("L2M_ENVFIX_PASSTHROUGH_ONE");
    // The server's own variables and secret still arrive, and so does PATH.
    expect(env.SERVER_OWN).toBe("own");
    expect(env.SERVER_TOKEN).toBe("from-secret-store");
    // PATH comes from the allowlist (the config does not set it).
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("passes the whole environment with inherit", async () => {
    const env = await reportedEnv(new StdioMCPServerAdapter({ env: { inherit: true } }));
    expect(env.SECRET_MASTER_KEY_BASE64).toBe(FAKE_SECRETS.SECRET_MASTER_KEY_BASE64);
    expect(env.DATABASE_URL).toBe(FAKE_SECRETS.DATABASE_URL);
    expect(env.SERVER_OWN).toBe("own");
  });

  it("passes listed names and prefixes", async () => {
    const env = await reportedEnv(new StdioMCPServerAdapter({ env: { passthrough: ["L2M_ENVFIX_PASSTHROUGH_*"] } }));
    expect(env.L2M_ENVFIX_PASSTHROUGH_ONE).toBe("passed");
    expect(env).not.toHaveProperty("SECRET_MASTER_KEY_BASE64");
  });

  it("applies the registry's stdioEnv setting", async () => {
    for (const [stdioEnv, present] of [[undefined, false], [{ inherit: true }, true]] as const) {
      const registry = createDefaultMCPRegistry(stdioEnv ? { stdioEnv } : {});
      const context = contextOf();
      try {
        const result = await registry.get("stdio_mcp").invokeTool("env", {}, { ...serverConfig(), serverId: "env-reg" } as MCPServerConfig, context);
        expect(result.ok).toBe(true);
        const env = envOf(result.output);
        expect("SECRET_MASTER_KEY_BASE64" in env).toBe(present);
      } finally {
        await registry.get("stdio_mcp").closeSessions?.(context);
      }
    }
  });
});

describe("stdio: start failures", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("names a missing working directory instead of the command", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-envfix-"));
    dirs.push(dir);
    const missing = path.join(dir, "does-not-exist");
    const adapter = new StdioMCPServerAdapter();
    const context = contextOf();
    try {
      await expect(adapter.discoverTools(serverConfig({ cwd: missing }), context)).rejects.toThrow(
        new RegExp(`working directory '${missing.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}' was not found`)
      );
    } finally {
      await adapter.closeSessions(context);
    }
  });

  it("says when the working directory is a file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-envfix-"));
    dirs.push(dir);
    const file = path.join(dir, "a-file");
    fs.writeFileSync(file, "");
    const adapter = new StdioMCPServerAdapter();
    const context = contextOf();
    try {
      await expect(adapter.discoverTools(serverConfig({ cwd: file }), context)).rejects.toThrow(/working directory .* is not a folder/);
    } finally {
      await adapter.closeSessions(context);
    }
  });

  it("does not blame the environment when the command is missing", async () => {
    const adapter = new StdioMCPServerAdapter();
    const context = contextOf();
    try {
      const failure = adapter.discoverTools(serverConfig({ command: "l2m-envfix-no-such-command" }), context);
      await expect(failure).rejects.toThrow(/'l2m-envfix-no-such-command' was not found/);
      await expect(adapter.discoverTools(serverConfig({ command: "l2m-envfix-no-such-command" }), context)).rejects.not.toThrow(/MCP_STDIO_ENV_PASSTHROUGH/);
    } finally {
      await adapter.closeSessions(context);
    }
  });

  it("says how to pass variables when a host-launched server exits early", async () => {
    const config = serverConfig({ args: ["-e", "process.stderr.write('MISSING_VAR is not set\\n'); process.exit(3)"] });
    const adapter = new StdioMCPServerAdapter();
    const context = contextOf();
    try {
      await expect(adapter.discoverTools(config, context)).rejects.toThrow(/MCP_STDIO_ENV_PASSTHROUGH/);
    } finally {
      await adapter.closeSessions(context);
    }
  });

  it("leaves the hint out when the whole environment is inherited", async () => {
    const config = serverConfig({ args: ["-e", "process.exit(3)"] });
    const adapter = new StdioMCPServerAdapter({ env: { inherit: true } });
    const context = contextOf();
    try {
      await expect(adapter.discoverTools(config, context)).rejects.toThrow(/exited unexpectedly/);
      await expect(adapter.discoverTools(config, context)).rejects.not.toThrow(/MCP_STDIO_ENV_PASSTHROUGH/);
    } finally {
      await adapter.closeSessions(context);
    }
  });
});
