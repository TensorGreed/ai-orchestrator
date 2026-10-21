import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_MCP_SANDBOX_LIMITS,
  isImagePinned,
  isImagePinnedByDigest,
  isNonRootNumericUser,
  isSafeContainerTarget,
  isValidContainerImage,
  normalizeMcpSandboxSettings,
  type McpContainerRuntime,
  type McpSandboxMode,
  type McpSandboxSettings,
  type McpSandboxStatus,
  type MCPServerConfig
} from "@ai-orchestrator/shared";
import { McpSandboxPolicyError } from "./errors";

/**
 * Phase 10.7 — sandboxed stdio servers.
 *
 * A registry stdio server with `sandbox.mode: "container"` runs its command
 * inside a throwaway container instead of on the API host:
 *
 *   <runtime> run -i --rm --name l2m-mcp-… --label l2m.mcp.sandbox=<instance>
 *     --network none --read-only --tmpfs /tmp:… --cpus … --memory …
 *     --pids-limit … --user 65534:65534 --cap-drop ALL
 *     --security-opt no-new-privileges --mount type=bind,…,readonly
 *     --env NAME … <image> <command> <args…>
 *
 * The existing stdio adapter still owns the session: it spawns the container
 * CLI instead of the command and talks JSON-RPC over the CLI's stdin/stdout,
 * so cancellation, timeouts and cleanup keep working. Environment values
 * (secrets included) never appear in the argument list: the CLI is given
 * `--env NAME` and reads the value from its own environment, which is built
 * in memory for that one process.
 *
 * Cleanup: `--rm` removes the container when it exits; once the CLI process
 * is gone the launcher also runs `<runtime> rm -f <name>`, which catches a
 * CLI killed with SIGKILL; API shutdown removes every container still known;
 * and `sweepSandboxContainers` removes leftovers of this deployment (by label)
 * at startup.
 */

export const MCP_SANDBOX_LABEL = "l2m.mcp.sandbox";
export const MCP_SANDBOX_SERVER_LABEL = "l2m.mcp.server";
/** `<host>:<pid>` of the API process that started the container; the sweep only removes containers whose process is gone. */
export const MCP_SANDBOX_OWNER_LABEL = "l2m.mcp.owner";

function sanitizeHost(host: string): string {
  return host.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120) || "host";
}

/** This process as an owner label value. */
export function currentSandboxOwner(): string {
  return `${sanitizeHost(os.hostname())}:${process.pid}`;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
const CONTAINER_NAME_PREFIX = "l2m-mcp-";
const CLI_TIMEOUT_MS = 20_000;

/** Deployment-level sandbox policy (MCP_SANDBOX_* env vars). */
export interface McpSandboxPolicy {
  /** Mode for servers that do not set one. */
  defaultMode: McpSandboxMode;
  /** When true, stdio servers cannot run without a container. */
  required: boolean;
  /** Runtime for servers that do not pick one; `auto` prefers docker, then podman. */
  runtime: McpContainerRuntime | "auto";
  /** Host directories mounts must resolve into (after symlinks). Empty: no mounts allowed. */
  allowedMountRoots: string[];
  /** Label value shared by this deployment's containers; the startup sweep removes leftovers with it. */
  instanceLabel: string;
}

export const DEFAULT_MCP_SANDBOX_POLICY: McpSandboxPolicy = {
  defaultMode: "none",
  required: false,
  runtime: "auto",
  allowedMountRoots: [],
  instanceLabel: "default"
};

/** What the stdio adapter runs for one session. */
export interface StdioLaunchPlan {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  /** Called once after the process is gone, to remove what the launch left behind. */
  cleanup?: () => Promise<void>;
  /** Shown in errors instead of the raw command line. */
  description?: string;
}

export interface StdioLaunchRequest {
  command: string;
  args: string[];
  /** Only the variables the server's config defines (custom env plus resolved secrets), never the API's own env. */
  env: Record<string, string>;
  cwd?: string;
  config: MCPServerConfig;
}

/** Decides how a stdio server is started. Returning null runs the command directly on the host. */
export interface StdioLauncher {
  prepare(request: StdioLaunchRequest): Promise<StdioLaunchPlan | null>;
}

export interface ResolvedSandboxMount {
  /** Host path after resolving symlinks. */
  source: string;
  target: string;
  writable: boolean;
}

export interface EffectiveSandbox {
  mode: McpSandboxMode;
  source: "server" | "default";
  /** Normalized container settings (defaults filled in); null for mode none. */
  settings: McpSandboxSettings | null;
}

/**
 * The sandbox a config runs with. Only registry servers carry their own
 * setting (the API resolves it from the registry); inline servers from node
 * configs always get the deployment default, so a node cannot opt out.
 */
export function resolveEffectiveSandbox(config: MCPServerConfig, policy: McpSandboxPolicy): EffectiveSandbox {
  const own = config.registryServerId && config.sandbox && typeof config.sandbox === "object" ? config.sandbox : null;
  if (own && own.mode === "none") {
    return { mode: "none", source: "server", settings: null };
  }
  if (own && own.mode !== undefined) {
    // Anything but an explicit "none" is a container. Settings that do not
    // validate stay as they are, so the checks refuse them instead of the
    // server quietly running on the host.
    return { mode: "container", source: "server", settings: { ...own, mode: "container" } };
  }
  if (policy.defaultMode === "container") {
    // A default container needs an image, which only a server's own setting can give.
    return { mode: "container", source: "default", settings: own ? { ...own, mode: "container" } : null };
  }
  return { mode: "none", source: "default", settings: null };
}

// Environment ------------------------------------------------------------------

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/**
 * Names the container CLI reads for itself. Setting one of them for a server
 * would change how docker or podman behaves (where it connects, which
 * binary or config it loads), so they cannot be passed into a sandbox.
 */
const RESERVED_ENV_PREFIXES = ["DOCKER_", "CONTAINERS_", "CONTAINER_", "PODMAN_", "BUILDAH_", "XDG_", "LD_", "DYLD_", "REGISTRY_", "STORAGE_"];
const RESERVED_ENV_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "NODE_OPTIONS"
]);

/** Why an env var name cannot be passed into a sandbox, or null when it can. */
export function sandboxEnvNameProblem(name: string): string | null {
  if (!ENV_NAME.test(name)) return `Environment variable name '${name.slice(0, 60)}' is not a plain identifier.`;
  const upper = name.toUpperCase();
  if (RESERVED_ENV_NAMES.has(upper) || RESERVED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))) {
    return `Environment variable '${name}' is reserved for the container runtime and cannot be passed into a sandbox.`;
  }
  return null;
}

// Runtime detection ---------------------------------------------------------------

/** First executable called `name` on PATH, as an absolute path. */
export function findExecutable(name: string, searchPath: string | undefined = process.env.PATH): string | null {
  if (!searchPath) return null;
  const extensions = process.platform === "win32" ? ["", ".exe", ".cmd"] : [""];
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, `${name}${extension}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Not here.
      }
    }
  }
  return null;
}

export interface RuntimeLocator {
  /** Absolute path of the runtime CLI, or null when it is not installed. */
  locate(runtime: McpContainerRuntime): string | null;
}

export const PATH_RUNTIME_LOCATOR: RuntimeLocator = {
  locate: (runtime) => findExecutable(runtime)
};

/** The runtime to use and where its CLI is; null when none of the candidates is installed. */
export function detectContainerRuntime(
  preferred: McpContainerRuntime | "auto" | null | undefined,
  locator: RuntimeLocator = PATH_RUNTIME_LOCATOR
): { runtime: McpContainerRuntime; path: string } | null {
  const candidates: McpContainerRuntime[] = preferred && preferred !== "auto" ? [preferred] : ["docker", "podman"];
  for (const runtime of candidates) {
    const found = locator.locate(runtime);
    if (found) return { runtime, path: found };
  }
  return null;
}

// Mounts -----------------------------------------------------------------------------

function isInside(child: string, root: string): boolean {
  const relative = path.relative(root, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Check mounts against the allowed roots. Both the roots and each source are
 * resolved with realpath first, so a symlink inside an allowed root that
 * points outside it is refused, as is a root that is itself a symlink to
 * somewhere broader than it looks.
 */
export function validateSandboxMounts(
  mounts: ReadonlyArray<{ source: string; target: string; writable?: boolean }>,
  allowedRoots: readonly string[]
): { mounts: ResolvedSandboxMount[]; problems: string[] } {
  const problems: string[] = [];
  const resolved: ResolvedSandboxMount[] = [];
  if (mounts.length === 0) return { mounts: resolved, problems };
  const roots: string[] = [];
  for (const root of allowedRoots) {
    if (!path.isAbsolute(root)) continue;
    try {
      roots.push(fs.realpathSync(root));
    } catch {
      // A root that does not exist allows nothing.
    }
  }
  if (roots.length === 0) {
    return { mounts: resolved, problems: ["No mount roots are allowed on this deployment (MCP_SANDBOX_ALLOWED_MOUNT_ROOTS), so the sandbox cannot mount host paths."] };
  }
  for (const mount of mounts) {
    if (!path.isAbsolute(mount.source) || mount.source.split(/[\\/]/).includes("..")) {
      problems.push(`Mount source '${mount.source}' must be an absolute path without '..'.`);
      continue;
    }
    if (!isSafeContainerTarget(mount.target)) {
      problems.push(`Mount target '${mount.target}' is not allowed.`);
      continue;
    }
    let real: string;
    try {
      real = fs.realpathSync(mount.source);
    } catch {
      problems.push(`Mount source '${mount.source}' does not exist.`);
      continue;
    }
    if (/[,"\n\r\0]/.test(real)) {
      problems.push(`Mount source '${mount.source}' resolves to a path with characters the runtime cannot mount.`);
      continue;
    }
    if (!roots.some((root) => isInside(real, root))) {
      problems.push(
        real === path.resolve(mount.source)
          ? `Mount source '${mount.source}' is outside the allowed mount roots.`
          : `Mount source '${mount.source}' resolves to '${real}', which is outside the allowed mount roots.`
      );
      continue;
    }
    resolved.push({ source: real, target: mount.target, writable: mount.writable === true });
  }
  return { mounts: resolved, problems };
}

// Command line --------------------------------------------------------------------------

export interface ContainerRunInput {
  settings: McpSandboxSettings;
  command: string;
  args: string[];
  envNames: string[];
  containerName: string;
  instanceLabel: string;
  /** Owner label value (`<host>:<pid>`). */
  owner?: string;
  registryServerId?: string;
  mounts: ResolvedSandboxMount[];
}

/** The argument list for `<runtime> …` (without the runtime itself). Holds env names, never values. */
export function buildContainerRunArgs(input: ContainerRunInput): string[] {
  const settings = input.settings;
  const image = settings.image ?? "";
  if (!isValidContainerImage(image)) {
    throw new McpSandboxPolicyError(`Sandbox image '${image.slice(0, 120)}' is not a valid image reference.`);
  }
  const user = settings.user ?? DEFAULT_MCP_SANDBOX_LIMITS.user;
  if (!isNonRootNumericUser(user)) {
    throw new McpSandboxPolicyError("The sandbox user must be a numeric uid (or uid:gid) other than root.");
  }
  const memoryMb = settings.memoryMb ?? DEFAULT_MCP_SANDBOX_LIMITS.memoryMb;
  const tmpfsMb = settings.tmpfsMb ?? DEFAULT_MCP_SANDBOX_LIMITS.tmpfsMb;
  const network = settings.network === "bridge" ? "bridge" : "none";
  const args = [
    "run",
    "-i",
    "--rm",
    "--init",
    "--name",
    input.containerName,
    "--label",
    `${MCP_SANDBOX_LABEL}=${input.instanceLabel}`,
    ...(input.owner ? ["--label", `${MCP_SANDBOX_OWNER_LABEL}=${input.owner}`] : []),
    ...(input.registryServerId ? ["--label", `${MCP_SANDBOX_SERVER_LABEL}=${input.registryServerId}`] : []),
    "--network",
    network,
    "--read-only",
    "--tmpfs",
    `/tmp:rw,noexec,nosuid,nodev,size=${tmpfsMb}m`,
    "--cpus",
    String(settings.cpus ?? DEFAULT_MCP_SANDBOX_LIMITS.cpus),
    "--memory",
    `${memoryMb}m`,
    "--memory-swap",
    `${memoryMb}m`,
    "--pids-limit",
    String(settings.pidsLimit ?? DEFAULT_MCP_SANDBOX_LIMITS.pidsLimit),
    "--user",
    user,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges"
  ];
  if (settings.workdir) {
    args.push("--workdir", settings.workdir);
  }
  for (const mount of input.mounts) {
    args.push("--mount", `type=bind,source=${mount.source},target=${mount.target}${mount.writable ? "" : ",readonly"}`);
  }
  for (const name of input.envNames) {
    const problem = sandboxEnvNameProblem(name);
    if (problem) throw new McpSandboxPolicyError(problem);
    // Name only: the CLI takes the value from its own environment.
    args.push("--env", name);
  }
  args.push(image, input.command, ...input.args);
  return args;
}

// Launcher ---------------------------------------------------------------------------------

type ExecFileLike = (file: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string }>;

const defaultExecFile: ExecFileLike = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: options.timeout, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve({ stdout: String(stdout) });
    });
  });

export interface ContainerSandboxLauncherOptions {
  locator?: RuntimeLocator;
  execFile?: ExecFileLike;
  /** Warnings about cleanup failures; never receives env values. */
  onWarning?: (message: string, fields?: Record<string, unknown>) => void;
  /** Owner label value; defaults to this process (`<host>:<pid>`). */
  owner?: string;
}

/** Problems that keep a sandbox from starting, plus warnings, without starting anything. */
export function checkSandbox(
  config: MCPServerConfig,
  policy: McpSandboxPolicy,
  locator: RuntimeLocator = PATH_RUNTIME_LOCATOR
): McpSandboxStatus & { runtimePath: string | null; mounts: ResolvedSandboxMount[]; settings: McpSandboxSettings | null } {
  const effective = resolveEffectiveSandbox(config, policy);
  const checkedAt = new Date().toISOString();
  const base = {
    mode: effective.mode,
    source: effective.source,
    checkedAt
  } as const;
  if (effective.mode === "none") {
    const problems = policy.required ? ["This deployment requires stdio servers to run in a container sandbox (MCP_SANDBOX_REQUIRED)."] : [];
    return {
      ...base,
      runtime: null,
      runtimePath: null,
      image: null,
      pinnedByDigest: false,
      network: null,
      ok: problems.length === 0,
      problems,
      warnings: [],
      mounts: [],
      settings: null
    };
  }
  const problems: string[] = [];
  const warnings: string[] = [];
  const settings = effective.settings ? normalizeMcpSandboxSettings({ ...effective.settings, mode: "container" }) : null;
  const image = typeof effective.settings?.image === "string" ? effective.settings.image : "";
  if (!image) {
    problems.push(
      effective.source === "default"
        ? "This deployment runs stdio servers in a container by default; register the server and set a sandbox image."
        : "The sandbox has no image."
    );
  } else if (!isValidContainerImage(image)) {
    problems.push(`Sandbox image '${image.slice(0, 120)}' is not a valid image reference.`);
  } else if (!isImagePinned(image)) {
    problems.push(`Sandbox image '${image}' is not pinned. Use a tag other than latest, or a digest.`);
  } else if (!isImagePinnedByDigest(image)) {
    warnings.push("The image is pinned by tag only; a digest (@sha256:…) guarantees the same image every time.");
  }
  if (image && !settings && problems.length === 0) {
    problems.push("The sandbox settings are not valid.");
  }
  const detected = detectContainerRuntime(settings?.runtime ?? policy.runtime, locator);
  if (!detected) {
    const wanted = settings?.runtime ?? (policy.runtime === "auto" ? "docker or podman" : policy.runtime);
    problems.push(`The container runtime (${wanted}) is not installed on the API host.`);
  }
  const mountCheck = validateSandboxMounts(settings?.mounts ?? [], policy.allowedMountRoots);
  problems.push(...mountCheck.problems);
  if (settings?.network === "bridge") warnings.push("Networking is on for this sandbox.");
  if (mountCheck.mounts.some((mount) => mount.writable)) warnings.push("At least one mount is writable.");
  return {
    ...base,
    runtime: detected?.runtime ?? settings?.runtime ?? null,
    runtimePath: detected?.path ?? null,
    image: image || null,
    pinnedByDigest: image ? isImagePinnedByDigest(image) : false,
    network: settings?.network ?? null,
    ok: problems.length === 0,
    problems,
    warnings,
    mounts: mountCheck.mounts,
    settings
  };
}

/** Public status without host paths of the runtime. */
export function sandboxStatusView(status: ReturnType<typeof checkSandbox>): McpSandboxStatus {
  const { runtimePath: _runtimePath, mounts: _mounts, settings: _settings, ...view } = status;
  return view;
}

/**
 * Starts sandboxed stdio servers in containers and refuses unsandboxed ones
 * when the policy requires a sandbox.
 */
export class ContainerSandboxLauncher implements StdioLauncher {
  private readonly live = new Map<string, string>();
  private readonly locator: RuntimeLocator;
  private readonly exec: ExecFileLike;

  constructor(
    readonly policy: McpSandboxPolicy,
    private readonly options: ContainerSandboxLauncherOptions = {}
  ) {
    this.locator = options.locator ?? PATH_RUNTIME_LOCATOR;
    this.exec = options.execFile ?? defaultExecFile;
  }

  /** Containers this launcher started that have not been cleaned up yet (name → runtime path). */
  liveContainers(): string[] {
    return [...this.live.keys()];
  }

  check(config: MCPServerConfig): McpSandboxStatus {
    return sandboxStatusView(checkSandbox(config, this.policy, this.locator));
  }

  async prepare(request: StdioLaunchRequest): Promise<StdioLaunchPlan | null> {
    const status = checkSandbox(request.config, this.policy, this.locator);
    const label = request.config.label ?? request.config.registryServerId ?? request.config.serverId;
    if (status.mode === "none") {
      if (!status.ok) throw new McpSandboxPolicyError(`MCP server '${label}' cannot start: ${status.problems.join(" ")}`);
      return null;
    }
    if (!status.ok || !status.runtimePath) {
      throw new McpSandboxPolicyError(`MCP server '${label}' cannot start its sandbox: ${status.problems.join(" ")}`);
    }
    const settings = status.settings;
    if (!settings) {
      throw new McpSandboxPolicyError(`MCP server '${label}' has invalid sandbox settings.`);
    }
    const envNames = Object.keys(request.env).sort();
    for (const name of envNames) {
      const problem = sandboxEnvNameProblem(name);
      if (problem) throw new McpSandboxPolicyError(`MCP server '${label}': ${problem}`);
    }
    const containerName = `${CONTAINER_NAME_PREFIX}${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const args = buildContainerRunArgs({
      settings,
      command: request.command,
      args: request.args,
      envNames,
      containerName,
      instanceLabel: this.policy.instanceLabel,
      owner: this.options.owner ?? currentSandboxOwner(),
      ...(request.config.registryServerId ? { registryServerId: request.config.registryServerId } : {}),
      mounts: status.mounts
    });
    // The CLI's own environment plus the server's variables, which `--env NAME` forwards.
    const env: NodeJS.ProcessEnv = { ...process.env, ...request.env };
    const runtimePath = status.runtimePath;
    this.live.set(containerName, runtimePath);
    let cleaned: Promise<void> | null = null;
    const cleanup = () => {
      cleaned ??= this.remove(runtimePath, containerName);
      return cleaned;
    };
    return {
      command: runtimePath,
      args,
      env,
      cleanup,
      description: `${status.runtime ?? "container"} sandbox ${containerName} (${settings.image})`
    };
  }

  private async remove(runtimePath: string, containerName: string): Promise<void> {
    try {
      await this.exec(runtimePath, ["rm", "-f", containerName], { timeout: CLI_TIMEOUT_MS });
    } catch (error) {
      // `rm -f` of a container `--rm` already removed reports "no such container"; anything else is worth a warning.
      const message = error instanceof Error ? error.message : String(error);
      if (!/no such container|no container with name/i.test(message)) {
        this.options.onWarning?.("Failed to remove MCP sandbox container", { container: containerName, error: message.slice(0, 300) });
      }
    } finally {
      this.live.delete(containerName);
    }
  }

  /** Remove every container this launcher started and has not cleaned up (API shutdown). */
  async shutdown(): Promise<void> {
    await Promise.all([...this.live.entries()].map(([name, runtimePath]) => this.remove(runtimePath, name)));
  }
}

/**
 * Remove leftover containers of this deployment (for example after the API
 * process was killed). Only containers carrying this deployment's sandbox
 * label are looked at, and of those only the ones whose owner process ran on
 * this host and is gone: a second API or worker process sharing the database
 * keeps its live containers. Returns how many were removed.
 */
export async function sweepSandboxContainers(input: {
  policy: McpSandboxPolicy;
  locator?: RuntimeLocator;
  execFile?: ExecFileLike;
  /** This host's name as owner labels spell it; defaults to the OS host name. */
  host?: string;
  isAlive?: (pid: number) => boolean;
}): Promise<{ runtime: McpContainerRuntime | null; removed: number }> {
  const host = sanitizeHost(input.host ?? os.hostname());
  const isAlive = input.isAlive ?? processIsAlive;
  const exec = input.execFile ?? defaultExecFile;
  const runtimes: McpContainerRuntime[] = input.policy.runtime === "auto" ? ["docker", "podman"] : [input.policy.runtime];
  let removed = 0;
  let used: McpContainerRuntime | null = null;
  for (const runtime of runtimes) {
    const runtimePath = (input.locator ?? PATH_RUNTIME_LOCATOR).locate(runtime);
    if (!runtimePath) continue;
    used ??= runtime;
    let ids: string[] = [];
    try {
      const listed = await exec(runtimePath, ["ps", "-aq", "--filter", `label=${MCP_SANDBOX_LABEL}=${input.policy.instanceLabel}`], {
        timeout: CLI_TIMEOUT_MS
      });
      ids = listed.stdout.split(/\s+/).map((id) => id.trim()).filter((id) => /^[a-zA-Z0-9_.-]+$/.test(id));
    } catch {
      // The daemon is not reachable; nothing to sweep.
      continue;
    }
    const orphaned: string[] = [];
    for (const id of ids) {
      let owner = "";
      try {
        const inspected = await exec(runtimePath, ["inspect", "--format", `{{index .Config.Labels "${MCP_SANDBOX_OWNER_LABEL}"}}`, id], {
          timeout: CLI_TIMEOUT_MS
        });
        owner = inspected.stdout.trim();
      } catch {
        continue;
      }
      const match = /^(.+):(\d+)$/.exec(owner);
      if (!match || match[1] !== host) continue;
      const pid = Number(match[2]);
      if (pid === process.pid || isAlive(pid)) continue;
      orphaned.push(id);
    }
    ids = orphaned;
    if (ids.length === 0) continue;
    try {
      await exec(runtimePath, ["rm", "-f", ...ids], { timeout: CLI_TIMEOUT_MS });
      removed += ids.length;
    } catch {
      // Best effort.
    }
  }
  return { runtime: used, removed };
}
