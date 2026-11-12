import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MCPServerConfig } from "@ai-orchestrator/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { MCPExecutionContext } from "../types";
import { StdioMCPServerAdapter } from "./stdio-mcp";

/**
 * Concurrent first calls to one stdio server in one context share a single process: the second caller waits for the
 * start under way instead of spawning another (which used to replace the first in the session cache and leave the
 * first process running until it exited on its own).
 */

/** A legacy server that notes its start in a file and answers initialize after `delayMs`. */
const SLOW_START_SERVER = `
const fs = require('node:fs');
fs.appendFileSync(process.env.START_LOG, process.pid + '\\n');
const delayMs = Number(process.env.INIT_DELAY_MS || 0);
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
      setTimeout(() => answer({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'slow', version: '1' } }), delayMs);
    } else if (req.method === 'tools/list') {
      answer({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] });
    } else if (req.method === 'tools/call') {
      answer({ content: [{ type: 'text', text: 'pid ' + process.pid }] });
    } else if (req.method === 'server/discover') {
      setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'unknown' } }) + '\\n'), delayMs);
    } else if (req.id !== undefined) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'unknown' } }) + '\\n');
    }
  }
});
`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup(delayMs: number, protocolMode?: "auto"): { config: MCPServerConfig; startLog: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-stdio-start-"));
  dirs.push(dir);
  const startLog = path.join(dir, "starts.log");
  fs.writeFileSync(startLog, "");
  const config = {
    serverId: "slow",
    label: "slow start",
    connection: { command: process.execPath, args: ["-e", SLOW_START_SERVER], env: { START_LOG: startLog, INIT_DELAY_MS: String(delayMs) }, timeoutMs: 10_000, ...(protocolMode ? { protocolMode } : {}) }
  } as unknown as MCPServerConfig;
  return { config, startLog };
}

const starts = (startLog: string) => fs.readFileSync(startLog, "utf8").split("\n").filter(Boolean);
const contextOf = (): MCPExecutionContext => ({ resolveSecret: async () => undefined, runtimeState: new Map() });

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("stdio: concurrent first calls", () => {
  it("start one process for concurrent first calls in one context, and close it with the context", async () => {
    const { config, startLog } = setup(300);
    const adapter = new StdioMCPServerAdapter();
    const context = contextOf();
    const results = await Promise.all([
      adapter.invokeTool("echo", {}, config, context),
      adapter.invokeTool("echo", {}, config, context),
      adapter.discoverTools(config, context)
    ]);
    expect(results[0]).toMatchObject({ ok: true });
    expect(results[1]).toMatchObject({ ok: true });
    expect(results[0].output).toBe(results[1].output);
    const pids = starts(startLog);
    expect(pids).toHaveLength(1);
    await adapter.closeSessions(context);
    expect(alive(Number(pids[0]))).toBe(false);
  });

  it("closes a session that is still starting together with the others", async () => {
    const { config, startLog } = setup(300);
    const adapter = new StdioMCPServerAdapter();
    const context = contextOf();
    const call = adapter.invokeTool("echo", {}, config, context);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await adapter.closeSessions(context);
    await call;
    const pids = starts(startLog);
    expect(pids).toHaveLength(1);
    expect(alive(Number(pids[0]))).toBe(false);
  });

  it("starts the server again for a waiting caller when the start it joined was cancelled by another caller", async () => {
    // Auto mode: the start's server/discover probe follows the first caller's signal.
    const { config, startLog } = setup(300, "auto");
    const adapter = new StdioMCPServerAdapter();
    const runtimeState = new Map<string, unknown>();
    const cancelled = new AbortController();
    const first: MCPExecutionContext = { resolveSecret: async () => undefined, runtimeState, signal: cancelled.signal };
    const second: MCPExecutionContext = { resolveSecret: async () => undefined, runtimeState };
    const firstCall = adapter.invokeTool("echo", {}, config, first);
    const secondCall = adapter.invokeTool("echo", {}, config, second);
    await new Promise((resolve) => setTimeout(resolve, 100));
    cancelled.abort();
    expect(await firstCall).toMatchObject({ ok: false });
    expect(await secondCall).toMatchObject({ ok: true });
    expect(starts(startLog)).toHaveLength(2);
    await adapter.closeSessions(second);
  });

  it("keeps separate contexts on separate processes", async () => {
    const { config, startLog } = setup(100);
    const adapter = new StdioMCPServerAdapter();
    const [first, second] = [contextOf(), contextOf()];
    await Promise.all([adapter.invokeTool("echo", {}, config, first), adapter.invokeTool("echo", {}, config, second)]);
    expect(starts(startLog)).toHaveLength(2);
    await Promise.all([adapter.closeSessions(first), adapter.closeSessions(second)]);
  });
});
