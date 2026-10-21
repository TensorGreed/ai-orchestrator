import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MCPServerConfig } from "@ai-orchestrator/shared";
import { StdioMCPServerAdapter } from "./adapters/stdio-mcp";
import { ContainerSandboxLauncher, DEFAULT_MCP_SANDBOX_POLICY, findExecutable, sweepSandboxContainers, type McpSandboxPolicy } from "./sandbox";
import type { MCPExecutionContext } from "./types";

/**
 * Phase 10.7 — one real container run, when docker is installed and a small
 * Node image for this CPU is already present locally (nothing is pulled;
 * `docker pull node:22.11.0-alpine3.20` enables it). Set
 * L2M_SANDBOX_TEST_IMAGE to pick another local image with `node` on PATH.
 */

const IMAGE = process.env.L2M_SANDBOX_TEST_IMAGE || "node:22.11.0-alpine3.20";
const HOST_ARCH: Record<string, string> = { x64: "amd64", arm64: "arm64" };

/** Docker is installed, the daemon answers, and the image is local and built for this CPU. */
function dockerReady(): boolean {
  const docker = findExecutable("docker");
  if (!docker) return false;
  try {
    const arch = execFileSync(docker, ["image", "inspect", "--format", "{{.Architecture}}", IMAGE], { encoding: "utf8", timeout: 10_000 }).trim();
    return arch === (HOST_ARCH[process.arch] ?? process.arch);
  } catch {
    return false;
  }
}

const READY = dockerReady();

const SERVER = `
const fs = require('fs');
const os = require('os');
process.stdin.setEncoding('utf-8');
let buf = '';
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
const canWrite = (file) => { try { fs.writeFileSync(file, 'x'); return true; } catch { return false; } };
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const req = JSON.parse(line);
    if (req.method === 'initialize') send({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'sandboxed', version: '1' } } });
    else if (req.method === 'tools/list') send({ jsonrpc: '2.0', id: req.id, result: { tools: [{ name: 'inspect', description: 'where am I', inputSchema: { type: 'object' } }] } });
    else if (req.method === 'tools/call') send({ jsonrpc: '2.0', id: req.id, result: { structuredContent: {
      uid: process.getuid(),
      token: process.env.API_TOKEN || null,
      interfaces: Object.keys(os.networkInterfaces()),
      rootWritable: canWrite('/etc/l2m-probe'),
      mountWritable: canWrite('/srv/l2m-probe'),
      tmpWritable: canWrite('/tmp/l2m-probe')
    } } });
  }
});
`;

describe.skipIf(!READY)("container sandbox with a real runtime", () => {
  const label = `l2m-test-${randomUUID().slice(0, 8)}`;
  let dir = "";
  let policy: McpSandboxPolicy = DEFAULT_MCP_SANDBOX_POLICY;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-sandbox-docker-"));
    // The container runs as nobody, so the mounted directory must be world-readable.
    fs.chmodSync(dir, 0o755);
    fs.writeFileSync(path.join(dir, "server.cjs"), SERVER, { mode: 0o644 });
    policy = { ...DEFAULT_MCP_SANDBOX_POLICY, runtime: "docker", allowedMountRoots: [dir], instanceLabel: label };
  });

  afterAll(async () => {
    await sweepSandboxContainers({ policy });
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("runs a stdio MCP server in a locked-down container and removes it afterwards", async () => {
    const launcher = new ContainerSandboxLauncher(policy);
    const adapter = new StdioMCPServerAdapter({ launcher });
    const config: MCPServerConfig = {
      serverId: "stdio_mcp",
      registryServerId: "mcp_docker_test",
      label: "Docker test",
      connection: { command: "node", args: ["/srv/server.cjs"], secretEnvVar: "API_TOKEN", timeoutMs: 60_000 },
      secretRef: { secretId: "sec" },
      sandbox: { mode: "container", image: IMAGE, memoryMb: 128, pidsLimit: 64, mounts: [{ source: dir, target: "/srv" }] }
    };
    const context: MCPExecutionContext = { resolveSecret: async () => "container-secret", runtimeState: new Map() };
    try {
      const tools = await adapter.discoverTools(config, context);
      expect(tools.map((tool) => tool.name)).toEqual(["inspect"]);
      const result = await adapter.invokeTool("inspect", {}, config, context);
      expect(result.ok).toBe(true);
      expect(result.structured).toMatchObject({
        uid: 65534,
        token: "container-secret",
        rootWritable: false,
        mountWritable: false,
        tmpWritable: true
      });
      // Networking off: only the loopback interface.
      expect((result.structured as { interfaces: string[] }).interfaces).toEqual(["lo"]);
    } finally {
      await adapter.closeSessions(context);
    }
    const docker = findExecutable("docker")!;
    const left = execFileSync(docker, ["ps", "-aq", "--filter", `label=l2m.mcp.sandbox=${label}`], { encoding: "utf8" }).trim();
    expect(left).toBe("");
    expect(launcher.liveContainers()).toEqual([]);
  }, 90_000);
});
