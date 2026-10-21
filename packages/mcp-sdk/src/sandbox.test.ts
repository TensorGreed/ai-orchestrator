import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MCPServerConfig } from "@ai-orchestrator/shared";
import { StdioMCPServerAdapter } from "./adapters/stdio-mcp";
import { McpSandboxPolicyError } from "./errors";
import {
  ContainerSandboxLauncher,
  DEFAULT_MCP_SANDBOX_POLICY,
  buildContainerRunArgs,
  checkSandbox,
  resolveEffectiveSandbox,
  sandboxEnvNameProblem,
  sweepSandboxContainers,
  validateSandboxMounts,
  type McpSandboxPolicy,
  type RuntimeLocator
} from "./sandbox";
import type { MCPExecutionContext } from "./types";

const PINNED = "node:22-alpine@sha256:" + "a".repeat(64);

let workDir: string;
let allowedRoot: string;
let outsideRoot: string;

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-sandbox-"));
  allowedRoot = path.join(workDir, "allowed");
  outsideRoot = path.join(workDir, "outside");
  fs.mkdirSync(path.join(allowedRoot, "data"), { recursive: true });
  fs.mkdirSync(path.join(outsideRoot, "secrets"), { recursive: true });
  // A symlink inside the allowed root that points outside it.
  fs.symlinkSync(path.join(outsideRoot, "secrets"), path.join(allowedRoot, "escape"));
  // A root given as a symlink resolves to where it really points.
  fs.symlinkSync(allowedRoot, path.join(workDir, "root-link"));
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function containerSettings(overrides: Record<string, unknown> = {}) {
  return { mode: "container" as const, image: PINNED, ...overrides };
}

describe("container command line", () => {
  it("applies limits, read-only root, tmpfs, user, dropped capabilities and no-new-privileges", () => {
    const args = buildContainerRunArgs({
      settings: { ...containerSettings(), cpus: 0.5, memoryMb: 256, pidsLimit: 64, tmpfsMb: 32, user: "1000:1000" },
      command: "node",
      args: ["server.js", "--port", "0"],
      envNames: [],
      containerName: "l2m-mcp-test",
      instanceLabel: "inst",
      registryServerId: "mcp_1",
      mounts: []
    });
    const joined = args.join(" ");
    expect(args.slice(0, 4)).toEqual(["run", "-i", "--rm", "--init"]);
    expect(joined).toContain("--name l2m-mcp-test");
    expect(joined).toContain("--label l2m.mcp.sandbox=inst");
    expect(joined).toContain("--label l2m.mcp.server=mcp_1");
    expect(joined).toContain("--network none");
    expect(args).toContain("--read-only");
    expect(joined).toContain("--tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m");
    expect(joined).toContain("--cpus 0.5");
    expect(joined).toContain("--memory 256m");
    expect(joined).toContain("--memory-swap 256m");
    expect(joined).toContain("--pids-limit 64");
    expect(joined).toContain("--user 1000:1000");
    expect(joined).toContain("--cap-drop ALL");
    expect(joined).toContain("--security-opt no-new-privileges");
    // The image comes after every option, then the command and its args verbatim.
    expect(args.slice(-5)).toEqual([PINNED, "node", "server.js", "--port", "0"]);
  });

  it("defaults to no network, the nobody user and conservative limits", () => {
    const args = buildContainerRunArgs({
      settings: containerSettings(),
      command: "cmd",
      args: [],
      envNames: [],
      containerName: "n",
      instanceLabel: "i",
      mounts: []
    }).join(" ");
    expect(args).toContain("--network none");
    expect(args).toContain("--user 65534:65534");
    expect(args).toContain("--cpus 1");
    expect(args).toContain("--memory 512m");
    expect(args).toContain("--pids-limit 256");
  });

  it("turns networking on only when asked", () => {
    const args = buildContainerRunArgs({
      settings: containerSettings({ network: "bridge" }),
      command: "cmd",
      args: [],
      envNames: [],
      containerName: "n",
      instanceLabel: "i",
      mounts: []
    });
    expect(args.join(" ")).toContain("--network bridge");
  });

  it("mounts read-only unless a mount is explicitly writable", () => {
    const args = buildContainerRunArgs({
      settings: containerSettings(),
      command: "cmd",
      args: [],
      envNames: [],
      containerName: "n",
      instanceLabel: "i",
      mounts: [
        { source: "/srv/docs", target: "/data/docs", writable: false },
        { source: "/srv/out", target: "/data/out", writable: true }
      ]
    });
    expect(args).toContain("type=bind,source=/srv/docs,target=/data/docs,readonly");
    expect(args).toContain("type=bind,source=/srv/out,target=/data/out");
  });

  it("passes env vars by name only, never their values", () => {
    const args = buildContainerRunArgs({
      settings: containerSettings(),
      command: "cmd",
      args: [],
      envNames: ["API_TOKEN", "REGION"],
      containerName: "n",
      instanceLabel: "i",
      mounts: []
    });
    const envFlags = args.flatMap((arg, index) => (arg === "--env" ? [args[index + 1]] : []));
    expect(envFlags).toEqual(["API_TOKEN", "REGION"]);
    expect(args.filter((arg, index) => args[index - 1] === "--env").every((arg) => !arg.includes("="))).toBe(true);
  });

  it("refuses env names that would smuggle a value or steer the runtime", () => {
    expect(sandboxEnvNameProblem("API_TOKEN")).toBeNull();
    expect(sandboxEnvNameProblem("A=b")).toMatch(/plain identifier/);
    expect(sandboxEnvNameProblem("--privileged")).toMatch(/plain identifier/);
    expect(sandboxEnvNameProblem("DOCKER_HOST")).toMatch(/reserved/);
    expect(sandboxEnvNameProblem("PATH")).toMatch(/reserved/);
    expect(sandboxEnvNameProblem("LD_PRELOAD")).toMatch(/reserved/);
    expect(() =>
      buildContainerRunArgs({
        settings: containerSettings(),
        command: "cmd",
        args: [],
        envNames: ["X=1"],
        containerName: "n",
        instanceLabel: "i",
        mounts: []
      })
    ).toThrow(McpSandboxPolicyError);
  });

  it("refuses root, and images that look like flags", () => {
    const base = { command: "cmd", args: [], envNames: [], containerName: "n", instanceLabel: "i", mounts: [] };
    expect(() => buildContainerRunArgs({ ...base, settings: containerSettings({ user: "0" }) })).toThrow(/root/);
    expect(() => buildContainerRunArgs({ ...base, settings: containerSettings({ user: "0:0" }) })).toThrow(/root/);
    expect(() => buildContainerRunArgs({ ...base, settings: containerSettings({ image: "--privileged" }) })).toThrow(/image/);
  });
});

describe("mount validation", () => {
  it("accepts a path inside an allowed root and resolves it", () => {
    const result = validateSandboxMounts([{ source: path.join(allowedRoot, "data"), target: "/data" }], [allowedRoot]);
    expect(result.problems).toEqual([]);
    expect(result.mounts).toEqual([{ source: fs.realpathSync(path.join(allowedRoot, "data")), target: "/data", writable: false }]);
  });

  it("refuses a path outside every allowed root", () => {
    const result = validateSandboxMounts([{ source: path.join(outsideRoot, "secrets"), target: "/data" }], [allowedRoot]);
    expect(result.mounts).toEqual([]);
    expect(result.problems[0]).toMatch(/outside the allowed mount roots/);
  });

  it("refuses a symlink inside an allowed root that escapes it", () => {
    const result = validateSandboxMounts([{ source: path.join(allowedRoot, "escape"), target: "/data" }], [allowedRoot]);
    expect(result.mounts).toEqual([]);
    expect(result.problems[0]).toMatch(/resolves to .* outside the allowed mount roots/);
  });

  it("follows a root given as a symlink to its real location", () => {
    const viaLink = validateSandboxMounts([{ source: path.join(workDir, "root-link", "data"), target: "/data" }], [path.join(workDir, "root-link")]);
    expect(viaLink.problems).toEqual([]);
    expect(viaLink.mounts[0]?.source).toBe(fs.realpathSync(path.join(allowedRoot, "data")));
    // The link's escape inside the real root is still refused.
    const escape = validateSandboxMounts([{ source: path.join(workDir, "root-link", "escape"), target: "/data" }], [path.join(workDir, "root-link")]);
    expect(escape.mounts).toEqual([]);
  });

  it("refuses dot-dot paths, missing paths, unsafe targets and mounts without any allowed root", () => {
    expect(validateSandboxMounts([{ source: `${allowedRoot}/../outside`, target: "/data" }], [allowedRoot]).problems[0]).toMatch(/without '\.\.'/);
    expect(validateSandboxMounts([{ source: path.join(allowedRoot, "missing"), target: "/data" }], [allowedRoot]).problems[0]).toMatch(/does not exist/);
    expect(validateSandboxMounts([{ source: path.join(allowedRoot, "data"), target: "/proc/x" }], [allowedRoot]).problems[0]).toMatch(/target/);
    expect(validateSandboxMounts([{ source: path.join(allowedRoot, "data"), target: "/" }], [allowedRoot]).problems[0]).toMatch(/target/);
    expect(validateSandboxMounts([{ source: path.join(allowedRoot, "data"), target: "/data" }], []).problems[0]).toMatch(/No mount roots/);
  });
});

const noRuntime: RuntimeLocator = { locate: () => null };

describe("sandbox policy", () => {
  const registryConfig = (sandbox: unknown): MCPServerConfig => ({
    serverId: "stdio_mcp",
    registryServerId: "mcp_1",
    label: "Files",
    connection: { command: "node" },
    sandbox: sandbox as MCPServerConfig["sandbox"]
  });

  it("ignores a sandbox block on inline (non-registry) configs", () => {
    const inline: MCPServerConfig = { serverId: "stdio_mcp", connection: { command: "node" }, sandbox: { mode: "none" } };
    expect(resolveEffectiveSandbox(inline, { ...DEFAULT_MCP_SANDBOX_POLICY, defaultMode: "container" })).toMatchObject({ mode: "container", source: "default" });
  });

  it("refuses an unsandboxed server when a sandbox is required", () => {
    const status = checkSandbox(registryConfig({ mode: "none" }), { ...DEFAULT_MCP_SANDBOX_POLICY, required: true }, noRuntime);
    expect(status.ok).toBe(false);
    expect(status.problems[0]).toMatch(/MCP_SANDBOX_REQUIRED/);
  });

  it("explains a default container sandbox without an image", () => {
    const status = checkSandbox(registryConfig(null), { ...DEFAULT_MCP_SANDBOX_POLICY, defaultMode: "container" }, noRuntime);
    expect(status.mode).toBe("container");
    expect(status.source).toBe("default");
    expect(status.problems.join(" ")).toMatch(/set a sandbox image/);
  });

  it("refuses unpinned images, warns on tag-only pins and reports a missing runtime", () => {
    const unpinned = checkSandbox(registryConfig({ mode: "container", image: "node:latest" }), DEFAULT_MCP_SANDBOX_POLICY, noRuntime);
    expect(unpinned.problems.join(" ")).toMatch(/not pinned/);
    const tagOnly = checkSandbox(registryConfig({ mode: "container", image: "node:22-alpine" }), DEFAULT_MCP_SANDBOX_POLICY, noRuntime);
    expect(tagOnly.warnings.join(" ")).toMatch(/digest/);
    expect(tagOnly.pinnedByDigest).toBe(false);
    expect(tagOnly.problems.join(" ")).toMatch(/not installed/);
    const digest = checkSandbox(registryConfig({ mode: "container", image: PINNED }), DEFAULT_MCP_SANDBOX_POLICY, { locate: () => "/usr/bin/docker" });
    expect(digest).toMatchObject({ ok: true, pinnedByDigest: true, runtime: "docker", network: "none" });
  });

  it("prepare refuses before spawning anything", async () => {
    const launcher = new ContainerSandboxLauncher({ ...DEFAULT_MCP_SANDBOX_POLICY, required: true }, { locator: noRuntime });
    await expect(launcher.prepare({ command: "node", args: [], env: {}, config: registryConfig({ mode: "none" }) })).rejects.toThrow(McpSandboxPolicyError);
    const inline: MCPServerConfig = { serverId: "stdio_mcp", connection: { command: "node" } };
    await expect(launcher.prepare({ command: "node", args: [], env: {}, config: inline })).rejects.toThrow(/requires stdio servers to run in a container/);
    const open = new ContainerSandboxLauncher(DEFAULT_MCP_SANDBOX_POLICY, { locator: noRuntime });
    await expect(open.prepare({ command: "node", args: [], env: {}, config: inline })).resolves.toBeNull();
  });
});

// --- A fake container runtime: logs its argv and runs the command on the host. ---

const FAKE_RUNTIME = `#!/usr/bin/env node
const fs = require('fs');
const { spawn } = require('child_process');
const argv = process.argv.slice(2);
const log = (entry) => fs.appendFileSync(process.env.FAKE_RUNTIME_LOG, JSON.stringify(entry) + '\\n');
if (argv[0] === 'run') {
  const imageIndex = argv.indexOf(process.env.FAKE_RUNTIME_IMAGE);
  const names = [];
  for (let i = 0; i < imageIndex; i += 1) if (argv[i] === '--env') names.push(argv[i + 1]);
  log({ op: 'run', argv, name: argv[argv.indexOf('--name') + 1] });
  const env = { PATH: process.env.PATH };
  for (const name of names) if (process.env[name] !== undefined) env[name] = process.env[name];
  const child = spawn(argv[imageIndex + 1], argv.slice(imageIndex + 2), { stdio: 'inherit', env });
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  child.on('exit', (code) => process.exit(code === null ? 0 : code));
} else if (argv[0] === 'rm') {
  log({ op: 'rm', argv });
} else if (argv[0] === 'ps') {
  log({ op: 'ps', argv });
  process.stdout.write(process.env.FAKE_RUNTIME_PS || '');
}
`;

const SERVER = `
process.stdin.setEncoding('utf-8');
let buf = '';
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const req = JSON.parse(line);
    if (req.method === 'initialize') send({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 't', version: '1' } } });
    else if (req.method === 'tools/list') send({ jsonrpc: '2.0', id: req.id, result: { tools: [{ name: 'env', inputSchema: { type: 'object' } }, { name: 'hang', inputSchema: { type: 'object' } }] } });
    else if (req.method === 'tools/call' && req.params.name === 'env') send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: JSON.stringify({ token: process.env.API_TOKEN || null, host: process.env.L2M_HOST_ONLY || null }) }] } });
    else if (req.method === 'tools/call' && req.params.name === 'hang') { /* never answers */ }
  }
});
`;

describe("sandboxed stdio sessions (fake runtime)", () => {
  let runtimePath: string;
  let logPath: string;
  let serverPath: string;

  beforeAll(() => {
    const bin = path.join(workDir, "bin");
    fs.mkdirSync(bin, { recursive: true });
    runtimePath = path.join(bin, "docker");
    fs.writeFileSync(runtimePath, FAKE_RUNTIME, { mode: 0o755 });
    serverPath = path.join(workDir, "server.cjs");
    fs.writeFileSync(serverPath, SERVER);
    logPath = path.join(workDir, "runtime.log");
    process.env.FAKE_RUNTIME_LOG = logPath;
    process.env.FAKE_RUNTIME_IMAGE = PINNED;
    process.env.L2M_HOST_ONLY = "api-process-secret";
  });

  afterAll(() => {
    delete process.env.FAKE_RUNTIME_LOG;
    delete process.env.FAKE_RUNTIME_IMAGE;
    delete process.env.L2M_HOST_ONLY;
  });

  const readLog = () =>
    fs.existsSync(logPath)
      ? fs
          .readFileSync(logPath, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { op: string; argv: string[]; name?: string })
      : [];

  const policy = (): McpSandboxPolicy => ({ ...DEFAULT_MCP_SANDBOX_POLICY, instanceLabel: "test-instance" });

  function setup() {
    fs.rmSync(logPath, { force: true });
    const launcher = new ContainerSandboxLauncher(policy(), { locator: { locate: (runtime) => (runtime === "docker" ? runtimePath : null) } });
    const adapter = new StdioMCPServerAdapter({ launcher });
    const config: MCPServerConfig = {
      serverId: "stdio_mcp",
      registryServerId: "mcp_sandboxed",
      label: "Sandboxed",
      connection: { command: process.execPath, args: [serverPath], env: { REGION: "eu" }, secretEnvVar: "API_TOKEN" },
      secretRef: { secretId: "sec_1" },
      sandbox: { mode: "container", image: PINNED }
    };
    return { launcher, adapter, config };
  }

  it("runs the server through the runtime with only its own env, the secret by name only", async () => {
    const { launcher, adapter, config } = setup();
    const context: MCPExecutionContext = { resolveSecret: async () => "s3cr3t-token-value", runtimeState: new Map() };
    const result = await adapter.invokeTool("env", {}, config, context);
    expect(result.ok).toBe(true);
    expect(JSON.parse(String(result.output))).toEqual({ token: "s3cr3t-token-value", host: null });
    const run = readLog().find((entry) => entry.op === "run")!;
    expect(run.argv).toContain("--network");
    expect(run.argv.join(" ")).not.toContain("s3cr3t-token-value");
    expect(run.argv.filter((arg, index) => run.argv[index - 1] === "--env")).toEqual(["API_TOKEN", "REGION"]);
    expect(launcher.liveContainers()).toEqual([run.name]);
    await adapter.closeSessions(context);
    expect(readLog().some((entry) => entry.op === "rm" && entry.argv.join(" ") === `rm -f ${run.name}`)).toBe(true);
    expect(launcher.liveContainers()).toEqual([]);
  });

  it("removes the container when the run is aborted mid-call", async () => {
    const { launcher, adapter, config } = setup();
    const controller = new AbortController();
    const context: MCPExecutionContext = { resolveSecret: async () => "tok", runtimeState: new Map(), signal: controller.signal };
    const pending = adapter.invokeTool("hang", {}, config, context);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(launcher.liveContainers()).toHaveLength(1);
    controller.abort(new Error("run canceled"));
    const result = await pending;
    expect(result).toMatchObject({ ok: false, errorKind: "canceled" });
    await adapter.closeSessions(context);
    const name = readLog().find((entry) => entry.op === "run")!.name;
    expect(readLog().some((entry) => entry.op === "rm" && entry.argv.includes(name!))).toBe(true);
    expect(launcher.liveContainers()).toEqual([]);
  });

  it("shutdown removes containers that are still running", async () => {
    const { launcher, adapter, config } = setup();
    const context: MCPExecutionContext = { resolveSecret: async () => "tok", runtimeState: new Map() };
    await adapter.discoverTools(config, context);
    expect(launcher.liveContainers()).toHaveLength(1);
    await launcher.shutdown();
    expect(launcher.liveContainers()).toEqual([]);
    expect(readLog().filter((entry) => entry.op === "rm")).toHaveLength(1);
    await adapter.closeSessions(context);
  });

  it("reports a sandbox policy failure as a sandbox error without spawning", async () => {
    const { adapter, config } = setup();
    const context: MCPExecutionContext = { resolveSecret: async () => "tok", runtimeState: new Map() };
    const result = await adapter.invokeTool("env", {}, { ...config, connection: { ...config.connection, env: { DOCKER_HOST: "tcp://evil:2375" } } }, context);
    expect(result).toMatchObject({ ok: false, errorKind: "sandbox" });
    expect(result.error).toMatch(/reserved/);
    expect(readLog()).toEqual([]);
  });

  it("sweeps only this deployment's containers whose owner process on this host is gone", async () => {
    const calls: string[][] = [];
    const owners: Record<string, string> = {
      abc123: "host-a:111", // this host, process gone: removed
      def456: "host-a:222", // this host, process alive (another API or worker): kept
      ghi789: "host-b:111", // another host sharing the daemon: kept
      jkl000: "" // no owner label: kept
    };
    const execFile = async (_file: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "ps") return { stdout: "abc123\ndef456\nghi789\njkl000\n" };
      if (args[0] === "inspect") return { stdout: `${owners[args[3] ?? ""] ?? ""}\n` };
      return { stdout: "" };
    };
    const swept = await sweepSandboxContainers({
      policy: { ...policy(), runtime: "docker" },
      locator: { locate: () => runtimePath },
      execFile,
      host: "host-a",
      isAlive: (pid) => pid === 222
    });
    expect(swept).toEqual({ runtime: "docker", removed: 1 });
    expect(calls[0]).toEqual(["ps", "-aq", "--filter", "label=l2m.mcp.sandbox=test-instance"]);
    expect(calls.filter((args) => args[0] === "inspect").map((args) => args[2])).toEqual(
      Array(4).fill('{{index .Config.Labels "l2m.mcp.owner"}}')
    );
    expect(calls.at(-1)).toEqual(["rm", "-f", "abc123"]);
  });

  it("labels each container with its owner process", () => {
    const args = buildContainerRunArgs({
      settings: containerSettings(),
      command: "node",
      args: [],
      envNames: [],
      containerName: "l2m-mcp-x",
      instanceLabel: "i",
      owner: "host-a:42",
      mounts: []
    });
    expect(args.join(" ")).toContain("--label l2m.mcp.owner=host-a:42");
  });
});
