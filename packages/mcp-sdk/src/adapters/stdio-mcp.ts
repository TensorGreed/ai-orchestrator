import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import type {
  McpClientProtocolMode,
  McpPrompt,
  McpPromptGetResult,
  McpProtocolEra,
  McpResource,
  McpResourceReadResult,
  McpResourceTemplate,
  McpServerCapabilities,
  MCPServerConfig,
  McpToolAnnotations,
  MCPToolDefinition,
  MCPToolResult,
  RunInstrumentation,
  TraceCarrier
} from "@ai-orchestrator/shared";
import { MCP_OUTCOME_ATTRIBUTES } from "@ai-orchestrator/shared";
import type { MCPExecutionContext, MCPServerAdapter, McpReadResourceOptions, McpServerRequestOrigin, McpToolReadOnlyOverride } from "../types";
import {
  McpJsonRpcError,
  McpMissingClientCapabilityError,
  McpOutcomeUnknownError,
  McpTimeoutError,
  classifyMcpError
} from "../errors";
import { annotateMcpError, annotateMcpRequest, mcpTraceCarrier, traceMcpRound, withTraceContext } from "../tracing";
import type { StdioLaunchPlan, StdioLauncher } from "../sandbox";
import {
  DEFAULT_RESOURCE_MAX_BYTES,
  JSON_RPC_INVALID_PARAMS,
  MAX_LIST_PAGES,
  answerServerRequest,
  buildClientCapabilities,
  isServerRequest,
  normalizePromptGetResult,
  normalizePrompts,
  normalizeResourceReadResult,
  normalizeResourceTemplates,
  normalizeResources,
  normalizeServerCapabilities,
  parseListChangedNotification
} from "../client-features";
import { withToolAnnotations } from "../tool-annotations";
import { buildToolCallResult, withOutputSchema } from "../structured-output";
import {
  MCP_CLIENT_PROTOCOL_VERSION,
  buildCancelledNotification,
  cancelReason,
  parseProgressNotification,
  toProgressEvent,
  type ParsedProgress
} from "../progress";
import { readOnlyOverrideFor, toolReissueSafe } from "../tool-policy";
import {
  DEFAULT_MRTR_MAX_ROUNDS,
  MCP_CLIENT_MODERN_PROTOCOL_VERSION,
  MCP_ERROR_LEGACY_RESOURCE_NOT_FOUND,
  MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION,
  MCP_MODERN_PROTOCOL_VERSIONS,
  McpEraCache,
  chooseMcpProtocolVersion,
  classifyMcpResult,
  classifyStdioEraProbe,
  initializeRejectionIsModern,
  isMrtrMethod,
  modernRequestMetaFor,
  parseDiscoverResult,
  parseMcpModernError,
  resolveMcpClientProtocolMode,
  runMrtrRequest,
  stdioEraCacheKey,
  withRequestMeta,
  type McpMrtrMethod,
  type McpStdioProbeOutcome
} from "../protocol";

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface PendingRequest {
  method: string;
  /** The tool a `tools/call` request is for, so server requests can name their origin. */
  toolName?: string;
  resolve: (response: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  timeoutMs: number;
  /** Set once `notifications/cancelled` went out for this request. */
  cancelled?: boolean;
  /**
   * The `server/discover` era probe sent before any `initialize`: it is
   * never cancelled with a notification, because a legacy server expects
   * nothing but `initialize` first.
   */
  probe?: boolean;
}

/** Thrown when the run's abort signal stopped a request; never retried. */
class McpRequestCanceledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpRequestCanceledError";
  }
}

/**
 * The server process ended after this request was written to it and before
 * it answered, so the server may or may not have acted on it. Callers decide
 * whether sending it again is safe (decision D13).
 */
class McpStdioConnectionLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpStdioConnectionLostError";
  }
}

/**
 * MCP 2026-07-28 — the server is not in the era the session assumed (a
 * modern request was refused with -32022 listing only `initialize`-based
 * versions). The request was not acted on; it goes out again on a new
 * process in `era`.
 */
class StdioEraMismatchError extends Error {
  constructor(
    readonly era: McpProtocolEra,
    readonly detail: string
  ) {
    super(`MCP stdio server needs an ${era === "legacy" ? "initialize-based" : "MCP 2026-07-28"} connection: ${detail}`);
    this.name = "StdioEraMismatchError";
  }
}

/** The server process ended on the `server/discover` probe: start a new one and open it with `initialize`. */
class StdioProbeEndedProcessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StdioProbeEndedProcessError";
  }
}

interface RpcOptions {
  signal?: AbortSignal;
  /** Progress token sent in `_meta`; notifications carrying it reach `onProgress`. */
  progressToken?: string;
  onProgress?: (progress: ParsedProgress) => void;
  toolName?: string;
  /** The call's context, for the request `_meta`; defaults to the session's. */
  context?: MCPExecutionContext;
  /** Marks the `server/discover` era probe (see `PendingRequest.probe`). */
  probe?: boolean;
}

/** Protocol settings of the stdio client (MCP 2026-07-28). Every field is optional; the defaults keep earlier behaviour. */
export interface StdioMcpProtocolOptions {
  /** `protocolMode` for servers whose connection sets none. Default `legacy` (decision D1). */
  defaultMode?: McpClientProtocolMode;
  /** Most `input_required` rounds one modern request may take. Default `DEFAULT_MRTR_MAX_ROUNDS`. */
  mrtrMaxRounds?: number;
  /**
   * D13 for `initialize`-based servers: true (the default) starts a fresh
   * process and sends a tool call again after the server process died
   * mid-call only when the tool is marked read-only or idempotent; other
   * calls fail as `outcome_unknown`. False sends every call again, as
   * earlier releases did. Modern servers always follow the safe rule.
   */
  legacySafeReissue?: boolean;
  /**
   * How long an `auto` connection waits for the `server/discover` probe
   * before treating the server as `initialize`-based. Default
   * `DEFAULT_STDIO_ERA_PROBE_TIMEOUT_MS`; never longer than the server's
   * request timeout. `modern` connections wait the full request timeout.
   */
  probeTimeoutMs?: number;
  /**
   * An admin's read-only mark per registry tool (tool policy). It decides the safe re-issue rule before the
   * server's annotations do. Unset: annotations only.
   */
  toolReadOnlyOverride?: McpToolReadOnlyOverride;
  /** Observed eras by launch plan, shared across runs. Defaults to one cache per adapter. */
  eraCache?: McpEraCache;
}

export interface StdioMcpServerAdapterOptions {
  launcher?: StdioLauncher;
  protocol?: StdioMcpProtocolOptions;
  /** Tracing (only while it is on): requests carry the active span's trace context in `params._meta`. */
  trace?: RunInstrumentation;
}

/** What the adapter has observed about a stdio server's protocol, for display. */
export interface StdioMcpObservedProtocol {
  era: McpProtocolEra;
  version?: string;
}

/** Default wait for the `server/discover` probe of an `auto` connection. */
export const DEFAULT_STDIO_ERA_PROBE_TIMEOUT_MS = 5_000;

interface StdioSession {
  proc: ChildProcess;
  pending: Map<number, PendingRequest>;
  buffer: string;
  rpcCounter: number;
  stderrBuffer: string[];
  closed: boolean;
  /** True when this side ended the session; such a session is not retried. */
  closedByClient: boolean;
  closeError?: Error;
  createdAt: number;
  /** Phase 10.5 — progress listeners by progress token. */
  progressListeners: Map<string | number, (progress: ParsedProgress) => void>;
  /** `notifications/cancelled` messages written; a session with any is closed gracefully. */
  cancelsSent: number;
  /** Tool output schemas from tools/list, once listed in this session. */
  outputSchemas?: Map<string, Record<string, unknown> | undefined>;
  /** Tool annotations from tools/list, for the safe re-issue rule (D13). */
  toolAnnotations?: Map<string, McpToolAnnotations | undefined>;
  /** Phase 10.5 — what the server declared in `initialize` (legacy) or `server/discover` (modern). */
  capabilities: McpServerCapabilities;
  /** False for a modern session whose capabilities have not been asked for yet. */
  capabilitiesKnown: boolean;
  /**
   * MCP 2026-07-28 — `legacy` sessions opened with `initialize`; `modern`
   * sessions carry version and capabilities in every request's `_meta`.
   */
  era: McpProtocolEra;
  /** The modern version in use (modern sessions only). */
  protocolVersion?: string;
  /** The version `initialize` agreed on (legacy sessions only), recorded on MCP spans. */
  legacyProtocolVersion?: string;
  mode: McpClientProtocolMode;
  /** Era cache key: a hash of the launch plan. */
  eraKey: string;
  /** Session cache key of the config. */
  sessionKey: string;
  /** The spawn itself failed (the command was not found, say). */
  spawnFailed?: boolean;
  /** The context the session was created for; server-initiated requests are answered through it. */
  context: MCPExecutionContext;
  config: MCPServerConfig;
  /** Answers to server requests still being written. */
  serverRequests: Set<Promise<void>>;
  /** Phase 10.7 — removes what a sandboxed launch left behind; runs once the process is gone. */
  cleanup?: () => Promise<void>;
}

const SESSION_TTL_MS = 30 * 60 * 1000;
const STDERR_LOG_BUFFER_LINES = 100;
const DEFAULT_TIMEOUT_MS = 120_000;
const CLOSE_GRACE_MS = 2_000;
/** After the server process exits, how long its stdout gets to deliver what it already wrote. */
const EXIT_DRAIN_MS = 200;
/** After cancelling in-flight requests, how long a server gets to exit on stdin EOF before SIGTERM. */
const STDIN_CLOSE_GRACE_MS = 500;

interface ResolvedSpawn {
  command: string;
  args: string[];
  shell: boolean;
}

/**
 * Quote a single token for inclusion in a Windows cmd.exe command line.
 *
 * cmd.exe tokenises by whitespace, so any token containing spaces or shell
 * meta-characters must be wrapped in double quotes (with embedded quotes
 * backslash-escaped).
 */
function quoteForWindowsShell(value: string): string {
  if (!/[\s"&<>|^()]/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '\\"')}"`;
}

/**
 * Resolve a command + args pair for the current platform.
 *
 * On Windows, common executables like `npx`, `npm`, `node`, and `python` ship
 * as `.cmd` shims, not `.exe`s. Node's `spawn` with `shell: false` cannot
 * execute `.cmd`/`.bat` files directly, so a config that says
 * `command: "npx"` fails with `ENOENT` even though `npx` is on PATH.
 *
 * Strategy on Windows:
 *
 * - Bare command name (no path separator, no extension) → `shell: true`. Node
 *   forwards through `cmd.exe /d /s /c "<bare> <args>"`, and cmd.exe resolves
 *   the bare name through `PATH` × `PATHEXT` correctly. Args with spaces are
 *   pre-quoted because Node does not quote them when `shell: true`.
 * - Explicit `.cmd`/`.bat` path → same pattern, but pre-quote the command path
 *   too so cmd.exe doesn't tokenise on the embedded space (variant E from the
 *   smoke test in `scripts/smoke-stdio-spawn.mjs`).
 * - Explicit `.exe`/`.com` (or any other path) → `shell: false`. CreateProcess
 *   handles paths with spaces in `lpApplicationName` natively, no quoting.
 *
 * On non-Windows everything passes through with `shell: false`.
 *
 * Note: an earlier attempt walked PATH × PATHEXT manually and routed through
 * `cmd.exe /d /s /c <resolvedPath>` with `windowsVerbatimArguments: true`. The
 * smoke test (`scripts/smoke-stdio-spawn.mjs` variants A–C) showed that
 * approach loses the inner quotes by the time cmd.exe parses its command
 * line, regardless of how we escape. Letting Node + cmd.exe do their normal
 * thing is the only pattern that empirically works for every shape.
 */
function resolveSpawnCommand(command: string, args: string[]): ResolvedSpawn {
  if (process.platform !== "win32") {
    return { command, args, shell: false };
  }

  const ext = path.extname(command).toLowerCase();

  // Explicit native binary (e.g. an absolute path to node.exe or python.exe):
  // CreateProcess handles paths with spaces, no shell wrapping needed.
  if (ext === ".exe" || ext === ".com") {
    return { command, args, shell: false };
  }

  // Explicit batch shim path (e.g. C:\path\to\foo.cmd): must go through
  // cmd.exe; pre-quote to survive cmd.exe's `/s` parsing.
  if (ext === ".cmd" || ext === ".bat") {
    return {
      command: quoteForWindowsShell(command),
      args: args.map(quoteForWindowsShell),
      shell: true
    };
  }

  // Bare command name (npx, node, python, etc.) — cmd.exe resolves PATH/PATHEXT.
  // Args with spaces still need quoting because Node doesn't quote them in shell mode.
  if (!command.includes("/") && !command.includes("\\")) {
    return { command, args: args.map(quoteForWindowsShell), shell: true };
  }

  // Some other path (e.g. relative path to an executable without extension):
  // try a direct spawn and let CreateProcess decide.
  return { command, args, shell: false };
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function buildSessionKey(config: MCPServerConfig): string {
  // Phase 10.7 — the sandbox is part of the identity: a changed sandbox starts a new process.
  return `stdio_mcp:${config.serverId}::${config.secretRef?.secretId ?? ""}::${JSON.stringify(config.connection ?? {})}::${JSON.stringify(config.sandbox ?? null)}`;
}

function normalizeCommand(config: MCPServerConfig): string {
  const command = String(config.connection?.command ?? "").trim();
  if (!command) {
    throw new Error("MCP stdio adapter requires a 'command' in connection config.");
  }
  return command;
}

function normalizeArgs(config: MCPServerConfig): string[] {
  const raw = config.connection?.args;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((value): value is string => typeof value === "string");
}

function normalizeTimeoutMs(config: MCPServerConfig): number {
  const raw = Number(config.connection?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw < 1000) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.floor(raw);
}

/**
 * The variables the server's config defines: custom env plus the resolved
 * secret. A sandbox gets only these; a host process gets them on top of the
 * API's environment.
 */
async function buildServerEnv(config: MCPServerConfig, context: MCPExecutionContext): Promise<Record<string, string>> {
  const baseEnv: Record<string, string> = {};
  const customEnv = toRecord(config.connection?.env);
  for (const [key, value] of Object.entries(customEnv)) {
    if (typeof value === "string" && key.trim()) {
      baseEnv[key] = value;
    }
  }

  const secretEnvVar =
    typeof config.connection?.secretEnvVar === "string" && config.connection.secretEnvVar.trim()
      ? config.connection.secretEnvVar.trim()
      : undefined;
  if (secretEnvVar && config.secretRef) {
    const secretValue = await context.resolveSecret(config.secretRef);
    if (typeof secretValue === "string") {
      baseEnv[secretEnvVar] = secretValue;
    }
  }

  return baseEnv;
}

function callTimeoutFor(config: MCPServerConfig, context: MCPExecutionContext): number {
  const override = context.callTimeoutMs;
  return typeof override === "number" && Number.isFinite(override) && override >= 1 ? Math.floor(override) : normalizeTimeoutMs(config);
}

function normalizeDiscoveredTools(serverId: string, serverLabel: string, rawTools: unknown): MCPToolDefinition[] {
  if (!Array.isArray(rawTools)) {
    return [];
  }
  return rawTools
    .map((item) => toRecord(item))
    .filter((item) => typeof item.name === "string" && item.name.trim())
    .map((item) => ({
      serverId,
      serverLabel,
      name: String(item.name),
      description: typeof item.description === "string" ? item.description : "MCP tool",
      inputSchema: toRecord(item.inputSchema ?? item.input_schema),
      ...withToolAnnotations(item.annotations),
      ...withOutputSchema(item.outputSchema ?? item.output_schema)
    }));
}

const MAX_TOOL_LIST_PAGES = 20;
/** Servers whose last tool annotations are remembered for the safe re-issue rule. */
const MAX_REMEMBERED_TOOL_LISTS = 500;
/** Servers whose observed protocol is remembered for display. */
const MAX_OBSERVED_PROTOCOLS = 500;

/** Server-supplied text for messages: control characters removed, length capped. */
function safeText(value: string, max = 200): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

function serverNameOf(config: MCPServerConfig): string {
  return safeText(config.label ?? config.registryServerId ?? config.serverId, 120);
}

/** The JSON-RPC error object an adapter error carries, for the era helpers. */
function jsonRpcErrorObject(error: McpJsonRpcError): { code: number | undefined; message: string; data?: unknown } {
  return { code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) };
}

function toProgressEventFor(progress: ParsedProgress, toolName: string, config: MCPServerConfig) {
  return toProgressEvent(progress, {
    toolName,
    serverId: config.serverId,
    ...(config.registryServerId ? { registryServerId: config.registryServerId } : {})
  });
}

export class StdioMCPServerAdapter implements MCPServerAdapter {
  private readonly fallbackSessionCache = new Map<string, StdioSession>();
  /** Phase 10.7 — decides how the command starts (on the host, or in a container sandbox). */
  private launcher?: StdioLauncher;
  private readonly protocol: StdioMcpProtocolOptions;
  /** Eras seen by `server/discover` probes, by launch plan. */
  private readonly eraCache: McpEraCache;
  /**
   * Launch plans whose server rejected `initialize` as a modern-only server,
   * kept apart from `eraCache` so a dual-era server that an `auto`
   * connection found modern stays legacy for `legacy` connections.
   */
  private readonly modernOnlyCache: McpEraCache;
  /** Tool annotations from the last tools/list of each server (by session key), for the safe re-issue rule. */
  private readonly rememberedAnnotations = new Map<string, Map<string, McpToolAnnotations | undefined>>();
  /** The protocol last seen per server (by session key), for display. */
  private readonly observed = new Map<string, StdioMcpObservedProtocol>();
  /** Tracing (only while it is on): requests carry the active span's trace context in `params._meta`. */
  private readonly trace?: RunInstrumentation;

  constructor(options?: StdioMcpServerAdapterOptions) {
    this.launcher = options?.launcher;
    this.protocol = options?.protocol ?? {};
    this.eraCache = this.protocol.eraCache ?? new McpEraCache();
    this.modernOnlyCache = new McpEraCache();
    this.trace = options?.trace?.enabled ? options.trace : undefined;
  }

  /**
   * The era (and modern version) of the server's last process started by
   * this adapter, or undefined when none was started yet.
   */
  observedProtocol(config: MCPServerConfig): StdioMcpObservedProtocol | undefined {
    const entry = this.observed.get(buildSessionKey(config));
    return entry ? { ...entry } : undefined;
  }

  /** Phase 10.7 — the launcher sandboxed servers start through. */
  setLauncher(launcher: StdioLauncher | undefined): void {
    this.launcher = launcher;
  }

  readonly definition = {
    id: "stdio_mcp",
    label: "Stdio MCP Server",
    description: "Connect to a local MCP server over stdio (spawns a child process and speaks JSON-RPC over stdin/stdout).",
    configSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Executable command (e.g. 'npx', 'node', 'python3', or an absolute path)."
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Arguments passed to the command, e.g. ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']."
        },
        env: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Extra environment variables for the child process. Merged on top of the parent process env."
        },
        cwd: {
          type: "string",
          description: "Working directory for the child process. Defaults to the parent process cwd."
        },
        secretEnvVar: {
          type: "string",
          description:
            "Optional. If set together with an auth secretRef, the resolved secret is injected into the child env under this name (e.g. 'GITHUB_TOKEN')."
        },
        timeoutMs: {
          type: "number",
          description: "Per-RPC request timeout in milliseconds. Defaults to 120000."
        },
        protocolMode: {
          type: "string",
          enum: ["auto", "legacy", "modern"],
          description: "MCP protocol era: legacy (initialize handshake), modern (2026-07-28) or auto. Default: the deployment's setting."
        }
      },
      required: ["command"]
    },
    authSchema: {
      type: "object",
      properties: {
        secretRef: {
          type: "object",
          description: "Optional. Combine with secretEnvVar to inject the resolved secret into the child process environment."
        }
      }
    }
  };

  private getCache(context: MCPExecutionContext): Map<string, StdioSession> {
    const runtime = context.runtimeState as Map<string, unknown> | undefined;
    if (!runtime) {
      return this.fallbackSessionCache;
    }
    return runtime as unknown as Map<string, StdioSession>;
  }

  private readSession(cache: Map<string, StdioSession>, key: string): StdioSession | undefined {
    const session = cache.get(key);
    if (!session) {
      return undefined;
    }
    if (session.closed || Date.now() - session.createdAt > SESSION_TTL_MS) {
      this.killSession(session);
      cache.delete(key);
      return undefined;
    }
    return session;
  }

  private async createSession(
    config: MCPServerConfig,
    context: MCPExecutionContext,
    options?: { forceLegacy?: boolean }
  ): Promise<StdioSession> {
    const session = await this.spawnSession(config, context);
    try {
      await this.openSession(session, config, context, options?.forceLegacy === true);
    } catch (error) {
      this.killSession(session);
      if (error instanceof StdioProbeEndedProcessError) {
        // Some initialize-based servers exit on a request they do not know; start again and open with initialize.
        return this.createSession(config, context, { forceLegacy: true });
      }
      throw error;
    }
    this.noteObserved(session);
    return session;
  }

  /** Start the server process and wire its streams; nothing is sent yet. */
  private async spawnSession(config: MCPServerConfig, context: MCPExecutionContext): Promise<StdioSession> {
    const command = normalizeCommand(config);
    const args = normalizeArgs(config);
    const cwd = typeof config.connection?.cwd === "string" && config.connection.cwd.trim()
      ? config.connection.cwd
      : undefined;
    const serverEnv = await buildServerEnv(config, context);
    const plan: StdioLaunchPlan | null = this.launcher
      ? await this.launcher.prepare({ command, args, env: serverEnv, ...(cwd ? { cwd } : {}), config })
      : null;

    let proc: ChildProcess;
    if (plan) {
      // A sandbox: the container CLI runs on the host, the command runs inside the container.
      proc = spawn(plan.command, plan.args, {
        ...(plan.cwd ? { cwd: plan.cwd } : {}),
        env: plan.env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true
      });
    } else {
      const resolved = resolveSpawnCommand(command, args);
      proc = spawn(resolved.command, resolved.args, {
        cwd,
        env: { ...process.env, ...serverEnv },
        stdio: ["pipe", "pipe", "pipe"],
        shell: resolved.shell
      });
    }

    const session: StdioSession = {
      proc,
      pending: new Map(),
      buffer: "",
      rpcCounter: 0,
      stderrBuffer: [],
      closed: false,
      closedByClient: false,
      createdAt: Date.now(),
      progressListeners: new Map(),
      cancelsSent: 0,
      capabilities: {},
      capabilitiesKnown: false,
      era: "legacy",
      mode: resolveMcpClientProtocolMode(config.connection, this.protocol.defaultMode),
      // The era is a property of what is launched: command, arguments, folder, environment and sandbox.
      eraKey: stdioEraCacheKey({ command, args, cwd: cwd ?? null, env: serverEnv, sandbox: config.sandbox ?? null }),
      sessionKey: buildSessionKey(config),
      context,
      config,
      serverRequests: new Set(),
      ...(plan?.cleanup ? { cleanup: plan.cleanup } : {})
    };

    proc.stdout?.setEncoding("utf-8");
    proc.stdout?.on("data", (chunk: string) => this.handleStdout(session, chunk));
    proc.stderr?.setEncoding("utf-8");
    proc.stderr?.on("data", (chunk: string) => this.handleStderr(session, chunk));
    proc.on("exit", () => {
      const finish = () => {
        this.handleClose(session);
        this.runCleanup(session);
      };
      // A server may write its last answer and exit at once: read stdout to its end (briefly) before failing what is
      // still in flight, so an answered request is not reported as lost.
      const stdout = proc.stdout;
      if (!stdout || stdout.readableEnded || stdout.destroyed) {
        finish();
        return;
      }
      const timer = setTimeout(finish, EXIT_DRAIN_MS);
      stdout.once("end", () => {
        clearTimeout(timer);
        finish();
      });
    });
    proc.on("error", (error) => {
      this.handleProcError(session, error);
      this.runCleanup(session);
    });
    return session;
  }

  /**
   * MCP 2026-07-28 — open the session in the era its `protocolMode` asks
   * for. `legacy` (the default) sends `initialize` exactly as earlier
   * releases did, and switches to modern when a modern-only server rejects
   * it (fall-forward, decision D1). `auto` probes with `server/discover`
   * first, as the stdio binding recommends, unless the launch plan is known
   * to be `initialize`-based. `modern` probes too, so an `initialize`-based
   * server fails clearly instead of running requests it cannot understand.
   */
  private async openSession(
    session: StdioSession,
    config: MCPServerConfig,
    context: MCPExecutionContext,
    forceLegacy: boolean
  ): Promise<void> {
    if (forceLegacy) return this.openLegacy(session, config, context, { fallForward: false });
    if (session.mode === "legacy") {
      // A server that rejected initialize as modern-only before: check it is still modern before using it so.
      if (this.modernOnlyCache.get(session.eraKey)) {
        if ((await this.probe(session, config, context, this.probeTimeoutMs(config))) === "modern") return;
        this.modernOnlyCache.invalidate(session.eraKey);
      }
      return this.openLegacy(session, config, context, { fallForward: true });
    }
    if (session.mode === "auto") {
      if (this.eraCache.get(session.eraKey)?.era === "legacy") {
        return this.openLegacy(session, config, context, { fallForward: true, probeOnFailure: true });
      }
      if ((await this.probe(session, config, context, this.probeTimeoutMs(config))) === "modern") return;
      return this.openLegacy(session, config, context, { fallForward: true });
    }
    if ((await this.probe(session, config, context, normalizeTimeoutMs(config))) === "modern") return;
    throw new Error(
      `MCP server '${serverNameOf(config)}' does not speak MCP ${MCP_MODERN_PROTOCOL_VERSIONS.join(", ")}: it did not answer server/discover like a ${MCP_MODERN_PROTOCOL_VERSIONS.join(", ")} server. Set its protocol to Legacy or Auto.`
    );
  }

  private probeTimeoutMs(config: MCPServerConfig): number {
    const configured = this.protocol.probeTimeoutMs;
    const probe =
      typeof configured === "number" && Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : DEFAULT_STDIO_ERA_PROBE_TIMEOUT_MS;
    return Math.min(probe, normalizeTimeoutMs(config));
  }

  /**
   * Send the `server/discover` probe with modern `_meta`. A discover result
   * or a recognised modern error means modern (a version is picked from the
   * server's list); any other error, or no answer in time, means legacy.
   * The verdict is cached per launch plan. On a modern verdict the session
   * is modern when this returns.
   */
  private async probe(
    session: StdioSession,
    config: MCPServerConfig,
    context: MCPExecutionContext,
    timeoutMs: number
  ): Promise<"modern" | "legacy"> {
    const allowLegacy = session.mode !== "modern";
    this.useModern(session, MCP_CLIENT_MODERN_PROTOCOL_VERSION);
    let outcome: McpStdioProbeOutcome;
    try {
      const response = await this.sendRpc(session, "server/discover", {}, timeoutMs, {
        probe: true,
        context,
        ...(context.signal ? { signal: context.signal } : {})
      });
      outcome = { result: response.result };
    } catch (error) {
      if (error instanceof McpRequestCanceledError) throw error;
      if (error instanceof McpJsonRpcError) {
        outcome = { error: jsonRpcErrorObject(error) };
      } else if (error instanceof McpTimeoutError) {
        outcome = { timedOut: true };
      } else {
        // The process never started or ended on the probe.
        this.useLegacy(session);
        if (session.spawnFailed) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        if (!allowLegacy) {
          throw new Error(
            `MCP server '${serverNameOf(config)}' does not speak MCP ${MCP_MODERN_PROTOCOL_VERSIONS.join(", ")}: its process ended on server/discover. Set its protocol to Legacy or Auto. ${detail}`
          );
        }
        // Remember it, so the next process opens with initialize straight away instead of dying on the probe again.
        this.eraCache.set(session.eraKey, "legacy");
        this.modernOnlyCache.invalidate(session.eraKey);
        throw new StdioProbeEndedProcessError(detail);
      }
    }
    const verdict = classifyStdioEraProbe(outcome);
    if (verdict.era === "modern") {
      const supported =
        verdict.discover?.supportedVersions ?? (verdict.error?.kind === "unsupported_version" ? verdict.error.supported : undefined);
      let version: string = MCP_CLIENT_MODERN_PROTOCOL_VERSION;
      if (supported !== undefined) {
        const choice = chooseMcpProtocolVersion(supported, { allowLegacy });
        if (choice.era === "none") throw this.noMutualVersionError(config, supported);
        if (choice.era === "legacy") {
          this.useLegacy(session);
          this.eraCache.set(session.eraKey, "legacy");
          return "legacy";
        }
        version = choice.version;
      }
      this.useModern(session, version, verdict.discover?.capabilities);
      this.eraCache.set(session.eraKey, "modern", version);
      return "modern";
    }
    this.useLegacy(session);
    this.eraCache.set(session.eraKey, "legacy");
    return "legacy";
  }

  /**
   * The `initialize` handshake, unchanged from earlier releases. With
   * `fallForward`, a rejection from a modern-only server (a JSON-RPC error
   * whose `data.supported` lists a modern version) makes the session modern
   * on the same process instead. With `probeOnFailure` (an `auto`
   * connection that skipped the probe because the launch plan was cached
   * as `initialize`-based), any other JSON-RPC error forgets that and
   * probes before giving up.
   */
  private async openLegacy(
    session: StdioSession,
    config: MCPServerConfig,
    context: MCPExecutionContext,
    options: { fallForward: boolean; probeOnFailure?: boolean }
  ): Promise<void> {
    let initialized: JsonRpcResponse;
    try {
      initialized = await this.sendRpc(session, "initialize", {
        protocolVersion: MCP_CLIENT_PROTOCOL_VERSION,
        capabilities: buildClientCapabilities(context),
        clientInfo: { name: "ai-orchestrator", version: "0.1.0" }
      }, normalizeTimeoutMs(config));
    } catch (error) {
      if (options.fallForward && error instanceof McpJsonRpcError && initializeRejectionIsModern({ transport: "stdio", error: jsonRpcErrorObject(error) })) {
        const supported = ((error.data as { supported: unknown[] }).supported ?? []).filter((entry): entry is string => typeof entry === "string");
        const choice = chooseMcpProtocolVersion(supported);
        if (choice.era !== "modern") throw this.noMutualVersionError(config, supported);
        this.modernOnlyCache.set(session.eraKey, "modern", choice.version);
        if (session.mode === "auto") this.eraCache.set(session.eraKey, "modern", choice.version);
        this.useModern(session, choice.version);
        return;
      }
      if (options.probeOnFailure && error instanceof McpJsonRpcError && !session.closed) {
        this.eraCache.invalidate(session.eraKey);
        if ((await this.probe(session, config, context, this.probeTimeoutMs(config))) === "modern") return;
      }
      annotateMcpError(this.trace, error);
      throw error;
    }
    const agreed = toRecord(initialized.result).protocolVersion;
    if (typeof agreed === "string" && agreed) session.legacyProtocolVersion = agreed.slice(0, 64);
    session.capabilities = normalizeServerCapabilities(toRecord(initialized.result).capabilities);
    session.capabilitiesKnown = true;
    this.sendNotification(session, "notifications/initialized", {});
  }

  private useModern(session: StdioSession, version: string, capabilities?: McpServerCapabilities): void {
    session.era = "modern";
    session.protocolVersion = version;
    delete session.legacyProtocolVersion;
    session.capabilities = capabilities ?? {};
    session.capabilitiesKnown = capabilities !== undefined;
  }

  private useLegacy(session: StdioSession): void {
    session.era = "legacy";
    delete session.protocolVersion;
    session.capabilities = {};
    session.capabilitiesKnown = false;
  }

  private noteObserved(session: StdioSession): void {
    this.observed.delete(session.sessionKey);
    this.observed.set(session.sessionKey, {
      era: session.era,
      ...(session.era === "modern" && session.protocolVersion ? { version: session.protocolVersion } : {})
    });
    while (this.observed.size > MAX_OBSERVED_PROTOCOLS) {
      const oldest = this.observed.keys().next().value;
      if (oldest === undefined) break;
      this.observed.delete(oldest);
    }
  }

  private noMutualVersionError(config: MCPServerConfig, supported: readonly string[]): McpJsonRpcError {
    return new McpJsonRpcError(
      `MCP server '${serverNameOf(config)}' supports protocol versions ${supported.slice(0, 10).map((version) => safeText(version, 40)).join(", ") || "(none listed)"}, and this client speaks ${MCP_MODERN_PROTOCOL_VERSIONS.join(", ")} or the initialize-based versions.`,
      MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION,
      { supported: supported.slice(0, 50) }
    );
  }

  /**
   * The params a request goes out with: the one place request `_meta` is
   * written, for every request with an id in both eras (`sendRpc` calls
   * it). Modern requests get their protocol keys here, merged with
   * `withRequestMeta` so a progress token and any other key are kept;
   * legacy params get no protocol keys. Trace context (`traceparent`,
   * `tracestate`) is merged the same way for either era, when tracing gave
   * a carrier for the request; array or scalar params are left as they are.
   */
  private outgoingParams(session: StdioSession, params: unknown, context: MCPExecutionContext, carrier?: TraceCarrier): unknown {
    const withProtocol =
      session.era === "modern"
        ? withRequestMeta(toRecord(params), modernRequestMetaFor(context, session.protocolVersion ?? MCP_CLIENT_MODERN_PROTOCOL_VERSION))
        : params;
    if (!carrier) return withProtocol;
    if (withProtocol === undefined) return withTraceContext(undefined, carrier);
    if (!withProtocol || typeof withProtocol !== "object" || Array.isArray(withProtocol)) return withProtocol;
    return withTraceContext(withProtocol as Record<string, unknown>, carrier);
  }

  private handleStdout(session: StdioSession, chunk: string): void {
    session.buffer += chunk;
    let nl = session.buffer.indexOf("\n");
    while (nl >= 0) {
      const line = session.buffer.slice(0, nl).trim();
      session.buffer = session.buffer.slice(nl + 1);
      if (line) {
        this.dispatchLine(session, line);
      }
      nl = session.buffer.indexOf("\n");
    }
  }

  private dispatchLine(session: StdioSession, line: string): void {
    let parsed: JsonRpcResponse;
    try {
      parsed = JSON.parse(line) as JsonRpcResponse;
    } catch {
      this.appendStderr(session, `[stdout-non-json] ${line.slice(0, 200)}`);
      return;
    }

    if (typeof parsed.method === "string") {
      this.handleServerMessage(session, parsed);
      return;
    }
    if (parsed.id === undefined || parsed.id === null) {
      return;
    }
    const id = typeof parsed.id === "number" ? parsed.id : Number(parsed.id);
    if (!Number.isFinite(id)) {
      return;
    }
    const pending = session.pending.get(id);
    if (!pending) {
      return;
    }
    session.pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(parsed);
  }

  /**
   * Messages the server starts: `notifications/progress` goes to the
   * listener for its token; `list_changed` notifications reach
   * `onListChanged`; `ping`, `elicitation/create` and
   * `sampling/createMessage` are answered through the context handlers;
   * other requests get "method not found"; other notifications are ignored.
   */
  private handleServerMessage(session: StdioSession, message: JsonRpcResponse): void {
    const progress = parseProgressNotification(message);
    if (progress) {
      const listener = session.progressListeners.get(progress.progressToken);
      if (listener) {
        try {
          listener(progress);
        } catch {
          // A failing progress sink never fails the tool call.
        }
      }
      return;
    }
    const listChanged = parseListChangedNotification(message);
    if (listChanged) {
      try {
        session.context.onListChanged?.({
          kind: listChanged,
          serverId: session.config.serverId,
          ...(session.config.registryServerId ? { registryServerId: session.config.registryServerId } : {}),
          at: new Date().toISOString()
        });
      } catch {
        // A failing listener never breaks the session.
      }
      return;
    }
    if (!isServerRequest(message)) return;
    // MCP 2026-07-28 — modern servers ask through input_required results, never with requests of their own, and a
    // modern client must not write responses: such a request is ignored.
    if (session.era === "modern") return;
    const origin = this.requestOrigin(session);
    // A person may take a while to answer an elicitation: the in-flight
    // request's timeout is suspended until the answer has been written.
    const resumeTimers = this.suspendTimers(session);
    const answer = answerServerRequest(message, session.context, origin)
      .then((reply) => this.writeMessage(session, reply))
      .catch(() => undefined)
      .finally(() => {
        resumeTimers();
        session.serverRequests.delete(answer);
      });
    session.serverRequests.add(answer);
  }

  /** Stop the timeout of every pending request; returns a function that starts them again from zero. */
  private suspendTimers(session: StdioSession): () => void {
    const suspended: Array<{ id: number; pending: PendingRequest; timeoutMs: number }> = [];
    for (const [id, pending] of session.pending) {
      if (!pending.timeoutMs) continue;
      clearTimeout(pending.timer);
      suspended.push({ id, pending, timeoutMs: pending.timeoutMs });
    }
    return () => {
      for (const entry of suspended) {
        if (session.pending.get(entry.id) !== entry.pending) continue;
        entry.pending.timer = setTimeout(() => this.expirePending(session, entry.id, entry.pending.method, entry.timeoutMs), entry.timeoutMs);
      }
    };
  }

  private expirePending(session: StdioSession, id: number, method: string, timeoutMs: number): void {
    const pending = session.pending.get(id);
    if (!pending) return;
    // Phase 10.5 — a timed-out request is cancelled on the server too (not the era probe: see PendingRequest.probe).
    if (method !== "initialize" && !pending.probe) {
      this.writeMessage(session, buildCancelledNotification(id, `Timed out after ${timeoutMs}ms`));
      session.cancelsSent += 1;
    }
    session.pending.delete(id);
    pending.reject(new McpTimeoutError(`MCP stdio request '${method}' timed out after ${timeoutMs}ms.`));
  }

  /** The tool call in flight (the latest one), for server requests made during it. */
  private requestOrigin(session: StdioSession): McpServerRequestOrigin {
    let toolName: string | undefined;
    for (const pending of session.pending.values()) {
      if (pending.method === "tools/call" && pending.toolName) toolName = pending.toolName;
    }
    return {
      serverId: session.config.serverId,
      ...(session.config.registryServerId ? { registryServerId: session.config.registryServerId } : {}),
      ...(toolName ? { toolName } : {})
    };
  }

  private writeMessage(session: StdioSession, message: unknown): void {
    if (session.closed) return;
    try {
      session.proc.stdin?.write(JSON.stringify(message) + "\n");
    } catch {
      // Best-effort.
    }
  }

  /**
   * Phase 10.5 — send `notifications/cancelled` for an in-flight request
   * (never for initialize, which the spec forbids) and fail it locally.
   */
  private cancelPending(session: StdioSession, id: number, reason: string): void {
    const pending = session.pending.get(id);
    if (!pending || pending.cancelled) return;
    pending.cancelled = true;
    if (pending.method !== "initialize" && !pending.probe) {
      this.writeMessage(session, buildCancelledNotification(id, reason));
      session.cancelsSent += 1;
    }
    session.pending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(new McpRequestCanceledError(`MCP request canceled: ${reason}`));
  }

  private handleStderr(session: StdioSession, chunk: string): void {
    const lines = chunk.split(/\r?\n/).filter((l) => l.length > 0);
    for (const line of lines) {
      this.appendStderr(session, line);
    }
  }

  private appendStderr(session: StdioSession, line: string): void {
    session.stderrBuffer.push(line.slice(0, 500));
    if (session.stderrBuffer.length > STDERR_LOG_BUFFER_LINES) {
      session.stderrBuffer.shift();
    }
  }

  private handleClose(session: StdioSession): void {
    if (session.closed) {
      return;
    }
    session.closed = true;
    const tail = session.stderrBuffer.slice(-5).join(" | ") || "(empty)";
    const error =
      session.closeError ??
      new Error(`MCP stdio process exited unexpectedly. Last stderr: ${tail}`);
    session.closeError = error;
    for (const [, pending] of session.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    session.pending.clear();
  }

  /** Phase 10.7 — remove what a sandboxed launch left behind (idempotent, never throws). */
  private runCleanup(session: StdioSession): Promise<void> {
    if (!session.cleanup) return Promise.resolve();
    return session.cleanup().catch(() => undefined);
  }

  private handleProcError(session: StdioSession, error: Error): void {
    const code = (error as NodeJS.ErrnoException).code;
    const path = (error as NodeJS.ErrnoException).path;
    if (code === "ENOENT") {
      const target = path ?? "the configured command";
      const hint =
        process.platform === "win32"
          ? " On Windows, executables like 'npx' and 'npm' are .cmd shims — make sure Node.js is installed and on PATH."
          : " Verify the command exists on PATH or pass an absolute path.";
      session.closeError = new Error(
        `MCP stdio process could not start: '${target}' was not found.${hint}`
      );
    } else {
      session.closeError = error;
    }
    // Only a process that never got a pid failed to start; other process errors are a lost connection.
    if (session.proc.pid === undefined) session.spawnFailed = true;
    this.handleClose(session);
  }

  /**
   * Terminate every child process cached in this context and wait for each to
   * exit. A child that ignores SIGTERM is sent SIGKILL after a grace period, so
   * the caller can rely on the processes being gone once this resolves.
   */
  async closeSessions(context: MCPExecutionContext): Promise<void> {
    const cache = this.getCache(context);
    const starts = [...(this.starting.get(cache)?.values() ?? [])];
    // The cached sessions are told to stop right away (before anything is awaited).
    const closing = this.closeCachedSessions(context, cache);
    if (starts.length === 0) return await closing;
    // A session still starting is closed once it has started, not left cached after the others are gone.
    await Promise.all(starts.map((start) => start.catch(() => undefined)));
    await Promise.all([closing, this.closeCachedSessions(context, cache)]);
  }

  private async closeCachedSessions(context: MCPExecutionContext, cache: Map<string, StdioSession>): Promise<void> {
    const exits: Array<Promise<void>> = [];
    const closing: StdioSession[] = [];
    const reason = context.signal?.aborted ? cancelReason(context.signal) : "MCP session closed.";
    for (const [key, value] of cache) {
      if (value && typeof value === "object" && "proc" in value) {
        closing.push(value);
        // Phase 10.5 — tell the server about every in-flight request before the process goes away.
        for (const id of [...value.pending.keys()]) {
          this.cancelPending(value, id, reason);
        }
        if (value.cancelsSent > 0 && !value.closed) {
          exits.push(this.closeGracefully(value));
        } else {
          exits.push(this.terminateProcess(value.proc));
          this.killSession(value);
        }
        cache.delete(key);
      }
    }
    await Promise.all(exits);
    // Phase 10.7 — sandbox containers are removed before this resolves.
    await Promise.all(closing.map((session) => this.runCleanup(session)));
  }

  /**
   * Shutdown the MCP spec describes for stdio: close the server's stdin, let
   * it exit on its own for a moment (so it reads the cancellations just
   * written), then SIGTERM, then SIGKILL.
   */
  private async closeGracefully(session: StdioSession): Promise<void> {
    const proc = session.proc;
    session.closedByClient = true;
    session.closeError ??= new Error("MCP stdio session was closed.");
    this.handleClose(session);
    if (proc.pid === undefined || proc.exitCode !== null || proc.signalCode !== null) return;
    const exited = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), STDIN_CLOSE_GRACE_MS);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    try {
      proc.stdin?.end();
    } catch {
      // Already closed.
    }
    if (await exited) return;
    const termination = this.terminateProcess(proc);
    try {
      proc.kill();
    } catch {
      // Already gone.
    }
    await termination;
  }

  private terminateProcess(proc: ChildProcess): Promise<void> {
    // No pid means the spawn itself failed, so there is nothing to wait for.
    if (proc.pid === undefined || proc.exitCode !== null || proc.signalCode !== null) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const forceTimer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }, CLOSE_GRACE_MS);
      const giveUpTimer = setTimeout(done, CLOSE_GRACE_MS * 2);
      function done() {
        clearTimeout(forceTimer);
        clearTimeout(giveUpTimer);
        resolve();
      }
      proc.once("exit", done);
      if (proc.exitCode !== null || proc.signalCode !== null) {
        done();
      }
    });
  }

  private killSession(session: StdioSession): void {
    if (session.closed) {
      return;
    }
    try {
      session.proc.kill();
    } catch {
      // ignore
    }
    session.closedByClient = true;
    // Fail any in-flight requests now instead of leaving them to their timeout.
    session.closeError ??= new Error("MCP stdio session was closed.");
    this.handleClose(session);
  }

  private sendRpc(
    session: StdioSession,
    method: string,
    params: unknown,
    timeoutMs: number,
    options: RpcOptions = {}
  ): Promise<JsonRpcResponse> {
    if (session.closed) {
      return Promise.reject(session.closeError ?? new Error("MCP stdio session is closed."));
    }
    const signal = options.signal;
    if (signal?.aborted) {
      return Promise.reject(new McpRequestCanceledError(`MCP request canceled: ${cancelReason(signal)}`));
    }
    session.rpcCounter += 1;
    const id = session.rpcCounter;
    const withProgress =
      options.progressToken && params && typeof params === "object"
        ? withRequestMeta(params as Record<string, unknown>, { progressToken: options.progressToken })
        : params;
    // initialize carries no trace context (as over HTTP, where it goes in headers only).
    const carrier = method === "initialize" ? undefined : mcpTraceCarrier(this.trace, session.config);
    const outgoing = this.outgoingParams(session, withProgress, options.context ?? session.context, carrier);
    // The handshake and the era probe run inside the first operation's span but are not that operation: their ids,
    // versions and error codes stay off it (as over HTTP). openLegacy records a handshake error it gives up on.
    const annotate = method !== "initialize" && !options.probe;
    if (annotate) {
      const version = session.era === "modern" ? session.protocolVersion : session.legacyProtocolVersion;
      annotateMcpRequest(this.trace, { ...(version ? { protocolVersion: version } : {}), requestId: id });
    }
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params: outgoing }) + "\n";
    let written = false;
    if (options.progressToken && options.onProgress) {
      session.progressListeners.set(options.progressToken, options.onProgress);
    }
    const onAbort = () => this.cancelPending(session, id, cancelReason(signal));
    signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      if (options.progressToken) session.progressListeners.delete(options.progressToken);
    };

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => this.expirePending(session, id, method, timeoutMs), timeoutMs);
      session.pending.set(id, {
        method,
        resolve,
        reject,
        timer,
        timeoutMs,
        ...(options.toolName ? { toolName: options.toolName } : {}),
        ...(options.probe ? { probe: true } : {})
      });

      if (session.closed) {
        session.pending.delete(id);
        clearTimeout(timer);
        reject(session.closeError ?? new Error("MCP stdio session closed before request was sent."));
        return;
      }

      try {
        session.proc.stdin?.write(payload);
        written = true;
      } catch (writeError) {
        session.pending.delete(id);
        clearTimeout(timer);
        reject(writeError instanceof Error ? writeError : new Error("Failed to write to MCP stdio process."));
      }
    }).then(
      (response) => {
        cleanup();
        if (response.error) {
          const failure = new McpJsonRpcError(response.error.message || "MCP JSON-RPC error", response.error.code, response.error.data);
          if (annotate) annotateMcpError(this.trace, failure);
          throw failure;
        }
        return response;
      },
      (error: unknown) => {
        cleanup();
        if (annotate) annotateMcpError(this.trace, error);
        // The process ended after the request went out: the server may have acted on it (D13).
        if (written && error === session.closeError && !session.closedByClient && !session.spawnFailed && error instanceof Error) {
          throw new McpStdioConnectionLostError(error.message);
        }
        throw error;
      }
    );
  }

  private sendNotification(session: StdioSession, method: string, params: unknown): void {
    if (session.closed) return;
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    try {
      session.proc.stdin?.write(payload);
    } catch {
      // Best-effort.
    }
  }

  /** Session starts under way, per session cache and key, so concurrent first calls share one process. */
  private readonly starting = new WeakMap<Map<string, StdioSession>, Map<string, Promise<StdioSession>>>();

  private startingFor(cache: Map<string, StdioSession>): Map<string, Promise<StdioSession>> {
    let starting = this.starting.get(cache);
    if (!starting) {
      starting = new Map();
      this.starting.set(cache, starting);
    }
    return starting;
  }

  /**
   * The server's session in this context. Concurrent callers share one start: a caller that finds a start under
   * way waits for it instead of spawning a second process (whose session would replace the first in the cache and
   * leave the first process running). `forceNew` waits for a start under way, then replaces whatever is cached.
   */
  private async getOrCreateSession(
    config: MCPServerConfig,
    context: MCPExecutionContext,
    options?: { forceNew?: boolean; forceLegacy?: boolean }
  ): Promise<StdioSession> {
    const cache = this.getCache(context);
    const key = buildSessionKey(config);
    const starting = this.startingFor(cache);

    for (;;) {
      const underWay = starting.get(key);
      if (!underWay) break;
      if (!options?.forceNew) {
        const session = await underWay;
        session.context = context;
        return session;
      }
      await underWay.catch(() => undefined);
    }

    if (options?.forceNew) {
      const existing = cache.get(key);
      if (existing) {
        this.killSession(existing);
        cache.delete(key);
      }
    } else {
      const existing = this.readSession(cache, key);
      if (existing) {
        existing.context = context;
        return existing;
      }
    }

    const start = this.createSession(config, context, options?.forceLegacy ? { forceLegacy: true } : undefined).then((session) => {
      cache.set(key, session);
      return session;
    });
    starting.set(key, start);
    try {
      return await start;
    } finally {
      if (starting.get(key) === start) starting.delete(key);
    }
  }

  /**
   * Run `operation` on the server's session. When a modern session turns
   * out to need `initialize` (-32022 listing only such versions), the
   * operation runs once more on a new process opened with `initialize`.
   * With `safe`, a modern operation whose process died after the request
   * went out runs once more on a new process: modern servers keep no state
   * between requests, and the operation only reads.
   */
  private async withSession<T>(
    config: MCPServerConfig,
    context: MCPExecutionContext,
    operation: (session: StdioSession) => Promise<T>,
    options?: { safe?: boolean }
  ): Promise<T> {
    const session = await this.getOrCreateSession(config, context);
    try {
      return await operation(session);
    } catch (error) {
      if (error instanceof StdioEraMismatchError) {
        try {
          return await operation(await this.getOrCreateSession(config, context, { forceNew: true, forceLegacy: true }));
        } catch (retryError) {
          throw this.settledEraError(config, retryError);
        }
      }
      if (options?.safe && session.era === "modern" && error instanceof McpStdioConnectionLostError) {
        return operation(await this.getOrCreateSession(config, context, { forceNew: true }));
      }
      throw error;
    }
  }

  /** A second era change in one operation: the server's answers disagree, so report what it said. */
  private settledEraError(config: MCPServerConfig, error: unknown): unknown {
    if (!(error instanceof StdioEraMismatchError)) return error;
    return new Error(
      `MCP server '${serverNameOf(config)}' answered neither like an MCP ${MCP_MODERN_PROTOCOL_VERSIONS.join(", ")} server nor like an initialize-based one: ${error.detail}`
    );
  }

  /**
   * One request on a modern session (`_meta` is added by `sendRpc`).
   * Handles what a modern server may answer at the protocol level: -32022
   * (pick a mutual version and send again once, or hand over to an
   * `initialize`-based connection), and -32021 (missing client capability).
   * Returns the JSON-RPC result.
   */
  private async modernSend(
    session: StdioSession,
    method: string,
    params: Record<string, unknown>,
    config: MCPServerConfig,
    context: MCPExecutionContext,
    timeoutMs: number,
    options: RpcOptions = {}
  ): Promise<unknown> {
    let renegotiated = false;
    for (;;) {
      const version = session.protocolVersion ?? MCP_CLIENT_MODERN_PROTOCOL_VERSION;
      try {
        const response = await this.sendRpc(session, method, params, timeoutMs, {
          ...options,
          context,
          ...(context.signal ? { signal: context.signal } : {})
        });
        return response.result;
      } catch (error) {
        if (!(error instanceof McpJsonRpcError)) throw error;
        const recognised = parseMcpModernError(jsonRpcErrorObject(error));
        if (recognised?.kind === "unsupported_version") {
          const choice = chooseMcpProtocolVersion(recognised.supported, { allowLegacy: session.mode !== "modern" });
          if (!renegotiated && choice.era === "modern" && choice.version !== version) {
            renegotiated = true;
            session.protocolVersion = choice.version;
            this.eraCache.set(session.eraKey, "modern", choice.version);
            this.noteObserved(session);
            continue;
          }
          if (choice.era === "legacy") {
            this.eraCache.invalidate(session.eraKey);
            this.modernOnlyCache.invalidate(session.eraKey);
            throw new StdioEraMismatchError("legacy", safeText(recognised.message, 500) || "The server asked for an initialize-based protocol version.");
          }
          if (choice.era === "none" && chooseMcpProtocolVersion(recognised.supported, { allowLegacy: true }).era === "legacy") {
            throw new McpJsonRpcError(
              `MCP server '${serverNameOf(config)}' only speaks initialize-based protocol versions (${recognised.supported.slice(0, 10).map((version) => safeText(version, 40)).join(", ")}). Set its protocol to Legacy or Auto.`,
              MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION,
              { supported: recognised.supported.slice(0, 50) }
            );
          }
          throw this.noMutualVersionError(config, recognised.supported);
        }
        if (recognised?.kind === "missing_client_capability") {
          const needed = Object.keys(recognised.requiredCapabilities);
          throw new McpMissingClientCapabilityError(
            `MCP server '${serverNameOf(config)}' needs the client capability ${needed.length > 0 ? needed.join(", ") : "it named"} for ${method}${
              needed.includes("sampling") ? "; attach a model to the call and allow sampling for the server" : ""
            }. ${safeText(recognised.message, 500)}`.trim(),
            recognised.code,
            { requiredCapabilities: recognised.requiredCapabilities }
          );
        }
        throw error;
      }
    }
  }

  /**
   * A modern request and its result: for `tools/call`, `resources/read` and
   * `prompts/get` through the multi round-trip engine (the server's input
   * requests are answered with the same handlers legacy servers get, and
   * each round is a new request with a new id); for other methods the
   * result's `resultType` is checked.
   */
  private async modernCall(
    session: StdioSession,
    method: string,
    params: Record<string, unknown>,
    config: MCPServerConfig,
    context: MCPExecutionContext,
    timeoutMs: number,
    options: RpcOptions = {}
  ): Promise<Record<string, unknown>> {
    const target = options.toolName ?? (typeof params.name === "string" ? params.name : undefined);
    let rounds = 0;
    // Round 1 runs in the operation's own span; each later input round gets a child CLIENT span (as over HTTP).
    const send = async (roundParams: Record<string, unknown>) => {
      rounds += 1;
      return await traceMcpRound(
        this.trace,
        { method, ...(target ? { target } : {}), round: rounds, serverId: config.registryServerId ?? config.serverId },
        () => this.modernSend(session, method, roundParams, config, context, timeoutMs, options)
      );
    };
    if (isMrtrMethod(method)) {
      const origin: McpServerRequestOrigin = {
        serverId: config.serverId,
        ...(config.registryServerId ? { registryServerId: config.registryServerId } : {}),
        ...(options.toolName ? { toolName: options.toolName } : {})
      };
      try {
        return await runMrtrRequest(method as McpMrtrMethod, params, send, {
          context,
          origin,
          clientCapabilities: buildClientCapabilities(context),
          maxRounds: this.protocol.mrtrMaxRounds ?? DEFAULT_MRTR_MAX_ROUNDS
        });
      } finally {
        if (rounds > 1) this.trace?.annotate({ [MCP_OUTCOME_ATTRIBUTES.ROUNDS]: rounds });
      }
    }
    const classified = classifyMcpResult(method, await send(params));
    if (classified.resultType !== "complete") {
      // classifyMcpResult only returns input_required for the three methods above.
      throw new McpJsonRpcError(`The server answered ${method} with input_required.`, undefined);
    }
    return classified.result;
  }

  /** The JSON-RPC result of a request in the session's era. */
  private async request(
    session: StdioSession,
    method: string,
    params: Record<string, unknown>,
    config: MCPServerConfig,
    context: MCPExecutionContext,
    timeoutMs: number = normalizeTimeoutMs(config),
    options: RpcOptions = {}
  ): Promise<unknown> {
    if (session.era === "modern") return this.modernCall(session, method, params, config, context, timeoutMs, options);
    const response = await this.sendRpc(session, method, params, timeoutMs, {
      ...options,
      ...(context.signal ? { signal: context.signal } : {})
    });
    return response.result;
  }

  /** Follow a paginated list method to the end, collecting `key` of each page. */
  private async listAllPages(
    session: StdioSession,
    method: string,
    key: string,
    config: MCPServerConfig,
    context: MCPExecutionContext
  ): Promise<unknown[]> {
    const items: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const result = toRecord(await this.request(session, method, cursor ? { cursor } : {}, config, context));
      if (Array.isArray(result[key])) items.push(...(result[key] as unknown[]));
      cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return items;
  }

  /**
   * The server's capabilities: from `initialize` (legacy), or from
   * `server/discover` (modern: from the probe, or asked once per session).
   * A modern server that cannot answer `server/discover` counts as
   * declaring nothing optional.
   */
  private async capabilitiesOf(session: StdioSession, config: MCPServerConfig, context: MCPExecutionContext): Promise<McpServerCapabilities> {
    if (session.capabilitiesKnown || session.era !== "modern") return session.capabilities;
    try {
      const discover = parseDiscoverResult(await this.modernCall(session, "server/discover", {}, config, context, normalizeTimeoutMs(config)));
      session.capabilities = discover?.capabilities ?? {};
    } catch (error) {
      // Only "cannot answer discover" counts as declaring nothing; version and capability problems are real errors.
      if (
        !(error instanceof McpJsonRpcError) ||
        error instanceof McpMissingClientCapabilityError ||
        error.code === MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION
      ) {
        throw error;
      }
      session.capabilities = {};
    }
    session.capabilitiesKnown = true;
    return session.capabilities;
  }

  async describeServer(config: MCPServerConfig, context: MCPExecutionContext): Promise<McpServerCapabilities> {
    return this.withSession(config, context, (session) => this.capabilitiesOf(session, config, context), { safe: true });
  }

  async listResources(config: MCPServerConfig, context: MCPExecutionContext): Promise<McpResource[]> {
    return this.withSession(
      config,
      context,
      async (session) => {
        if (!(await this.capabilitiesOf(session, config, context)).resources) return [];
        return normalizeResources(await this.listAllPages(session, "resources/list", "resources", config, context));
      },
      { safe: true }
    );
  }

  async listResourceTemplates(config: MCPServerConfig, context: MCPExecutionContext): Promise<McpResourceTemplate[]> {
    return this.withSession(
      config,
      context,
      async (session) => {
        if (!(await this.capabilitiesOf(session, config, context)).resources) return [];
        return normalizeResourceTemplates(
          await this.listAllPages(session, "resources/templates/list", "resourceTemplates", config, context)
        );
      },
      { safe: true }
    );
  }

  async readResource(
    uri: string,
    config: MCPServerConfig,
    context: MCPExecutionContext,
    options: McpReadResourceOptions = {}
  ): Promise<McpResourceReadResult> {
    return this.withSession(
      config,
      context,
      async (session) => {
        let result: unknown;
        try {
          result = await this.request(session, "resources/read", { uri }, config, context);
        } catch (error) {
          // 2026-07-28 answers "resource not found" with -32602; earlier servers used -32002, which clients still accept.
          if (
            session.era === "modern" &&
            error instanceof McpJsonRpcError &&
            !(error instanceof McpMissingClientCapabilityError) &&
            (error.code === JSON_RPC_INVALID_PARAMS || error.code === MCP_ERROR_LEGACY_RESOURCE_NOT_FOUND)
          ) {
            throw new McpJsonRpcError(`MCP resource not found: ${uri.slice(0, 500)} (${safeText(error.message, 500)})`, error.code, error.data);
          }
          throw error;
        }
        return normalizeResourceReadResult(uri, result, options.maxBytes ?? DEFAULT_RESOURCE_MAX_BYTES);
      },
      { safe: true }
    );
  }

  async listPrompts(config: MCPServerConfig, context: MCPExecutionContext): Promise<McpPrompt[]> {
    return this.withSession(
      config,
      context,
      async (session) => {
        if (!(await this.capabilitiesOf(session, config, context)).prompts) return [];
        return normalizePrompts(await this.listAllPages(session, "prompts/list", "prompts", config, context));
      },
      { safe: true }
    );
  }

  async getPrompt(
    name: string,
    args: Record<string, string>,
    config: MCPServerConfig,
    context: MCPExecutionContext
  ): Promise<McpPromptGetResult> {
    return this.withSession(
      config,
      context,
      async (session) => {
        const params = { name, ...(Object.keys(args).length > 0 ? { arguments: args } : {}) };
        return normalizePromptGetResult(name, await this.request(session, "prompts/get", params, config, context));
      },
      { safe: true }
    );
  }

  private async listAllTools(
    session: StdioSession,
    config: MCPServerConfig,
    context: MCPExecutionContext
  ): Promise<MCPToolDefinition[]> {
    const tools: MCPToolDefinition[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_LIST_PAGES; page += 1) {
      const result = toRecord(await this.request(session, "tools/list", cursor ? { cursor } : {}, config, context));
      tools.push(...normalizeDiscoveredTools(config.serverId, config.label ?? this.definition.label, result.tools));
      cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    session.outputSchemas = new Map(tools.map((tool) => [tool.name, tool.outputSchema]));
    session.toolAnnotations = new Map(tools.map((tool) => [tool.name, tool.annotations]));
    this.rememberedAnnotations.delete(session.sessionKey);
    this.rememberedAnnotations.set(session.sessionKey, session.toolAnnotations);
    while (this.rememberedAnnotations.size > MAX_REMEMBERED_TOOL_LISTS) {
      const oldest = this.rememberedAnnotations.keys().next().value;
      if (oldest === undefined) break;
      this.rememberedAnnotations.delete(oldest);
    }
    return tools;
  }

  async discoverTools(config: MCPServerConfig, context: MCPExecutionContext): Promise<MCPToolDefinition[]> {
    return this.withSession(config, context, (session) => this.listAllTools(session, config, context), { safe: true });
  }

  /** The tool's outputSchema, listing the tools once per session when needed. Unknown → undefined. */
  private async outputSchemaFor(
    session: StdioSession,
    toolName: string,
    config: MCPServerConfig,
    context: MCPExecutionContext
  ): Promise<Record<string, unknown> | undefined> {
    if (!session.outputSchemas) {
      try {
        await this.listAllTools(session, config, context);
      } catch (error) {
        if (error instanceof McpRequestCanceledError) throw error;
        session.outputSchemas = new Map();
      }
    }
    return session.outputSchemas?.get(toolName);
  }

  private callTool(
    session: StdioSession,
    toolName: string,
    args: Record<string, unknown>,
    config: MCPServerConfig,
    context: MCPExecutionContext,
    timeoutMs: number
  ): Promise<JsonRpcResponse> {
    const onProgress = context.onProgress;
    const progressToken = onProgress ? `l2m-progress-${session.rpcCounter + 1}-${Date.now().toString(36)}` : undefined;
    const rpcOptions: RpcOptions = {
      toolName,
      ...(progressToken && onProgress
        ? {
            progressToken,
            onProgress: (progress: ParsedProgress) =>
              onProgress(
                toProgressEventFor(progress, toolName, config)
              )
          }
        : {})
    };
    if (session.era === "modern") {
      return this.modernCall(session, "tools/call", { name: toolName, arguments: args }, config, context, timeoutMs, rpcOptions).then(
        (result) => ({ result })
      );
    }
    return this.sendRpc(session, "tools/call", { name: toolName, arguments: args }, timeoutMs, {
      ...rpcOptions,
      ...(context.signal ? { signal: context.signal } : {})
    });
  }

  /** D13 — whether a tool call may be sent again after the process died: read-only or idempotent tools only. */
  private async toolReissueSafe(session: StdioSession, toolName: string, config: MCPServerConfig): Promise<boolean> {
    const annotations =
      (session.toolAnnotations ?? this.rememberedAnnotations.get(session.sessionKey))?.get(toolName) ??
      config.manualTools?.find((tool) => tool.name === toolName)?.annotations;
    return toolReissueSafe(annotations, await readOnlyOverrideFor(this.protocol.toolReadOnlyOverride, config.registryServerId, toolName));
  }

  /** Whether the safe re-issue rule applies to this session (always for modern; legacy unless turned off). */
  private safeReissueApplies(session: StdioSession): boolean {
    return session.era === "modern" || this.protocol.legacySafeReissue !== false;
  }

  async invokeTool(
    toolName: string,
    args: Record<string, unknown>,
    config: MCPServerConfig,
    context: MCPExecutionContext
  ): Promise<MCPToolResult> {
    const timeoutMs = callTimeoutFor(config, context);
    try {
      let session = await this.getOrCreateSession(config, context);
      let response: JsonRpcResponse;
      try {
        response = await this.callTool(session, toolName, args, config, context, timeoutMs);
      } catch (firstError) {
        if (firstError instanceof StdioEraMismatchError) {
          // The server did not act on the refused request; it goes out again on an initialize-based connection.
          session = await this.getOrCreateSession(config, context, { forceNew: true, forceLegacy: true });
          try {
            response = await this.callTool(session, toolName, args, config, context, timeoutMs);
          } catch (retryError) {
            throw this.settledEraError(config, retryError);
          }
        } else {
          if (!session.closed || session.closedByClient || firstError instanceof McpRequestCanceledError) {
            throw firstError;
          }
          // The process died after the call went out: send it again only when that is known to be safe.
          if (
            firstError instanceof McpStdioConnectionLostError &&
            this.safeReissueApplies(session) &&
            !(await this.toolReissueSafe(session, toolName, config))
          ) {
            throw new McpOutcomeUnknownError(
              `MCP stdio tool '${toolName}' got no answer: ${firstError.message} It was not sent again because the tool is not marked read-only or idempotent, so it may or may not have run.`
            );
          }
          session = await this.getOrCreateSession(config, context, { forceNew: true });
          response = await this.callTool(session, toolName, args, config, context, timeoutMs);
        }
      }
      const outputSchema = await this.outputSchemaFor(session, toolName, config, context);
      return buildToolCallResult(toolName, response.result, outputSchema);
    } catch (error) {
      return {
        ok: false,
        output: null,
        error: error instanceof Error ? error.message : "Stdio MCP tool invocation failed",
        errorKind: classifyMcpError(error, context.signal)
      };
    }
  }
}
