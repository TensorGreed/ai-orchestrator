import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import type { MCPServerConfig, MCPToolDefinition, MCPToolResult } from "@ai-orchestrator/shared";
import type { MCPExecutionContext, MCPServerAdapter } from "../types";
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
  resolve: (response: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  /** Set once `notifications/cancelled` went out for this request. */
  cancelled?: boolean;
}

/** Thrown when the run's abort signal stopped a request; never retried. */
class McpRequestCanceledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpRequestCanceledError";
  }
}

interface RpcOptions {
  signal?: AbortSignal;
  /** Progress token sent in `_meta`; notifications carrying it reach `onProgress`. */
  progressToken?: string;
  onProgress?: (progress: ParsedProgress) => void;
}

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
}

const SESSION_TTL_MS = 30 * 60 * 1000;
const STDERR_LOG_BUFFER_LINES = 100;
const DEFAULT_TIMEOUT_MS = 120_000;
const CLOSE_GRACE_MS = 2_000;
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
  return `stdio_mcp:${config.serverId}::${config.secretRef?.secretId ?? ""}::${JSON.stringify(config.connection ?? {})}`;
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

async function buildEnv(config: MCPServerConfig, context: MCPExecutionContext): Promise<NodeJS.ProcessEnv> {
  const baseEnv: NodeJS.ProcessEnv = { ...process.env };
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

function toProgressEventFor(progress: ParsedProgress, toolName: string, config: MCPServerConfig) {
  return toProgressEvent(progress, {
    toolName,
    serverId: config.serverId,
    ...(config.registryServerId ? { registryServerId: config.registryServerId } : {})
  });
}

export class StdioMCPServerAdapter implements MCPServerAdapter {
  private readonly fallbackSessionCache = new Map<string, StdioSession>();

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

  private async createSession(config: MCPServerConfig, context: MCPExecutionContext): Promise<StdioSession> {
    const command = normalizeCommand(config);
    const args = normalizeArgs(config);
    const cwd = typeof config.connection?.cwd === "string" && config.connection.cwd.trim()
      ? config.connection.cwd
      : undefined;
    const env = await buildEnv(config, context);

    const resolved = resolveSpawnCommand(command, args);
    const proc = spawn(resolved.command, resolved.args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: resolved.shell
    });

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
      cancelsSent: 0
    };

    proc.stdout?.setEncoding("utf-8");
    proc.stdout?.on("data", (chunk: string) => this.handleStdout(session, chunk));
    proc.stderr?.setEncoding("utf-8");
    proc.stderr?.on("data", (chunk: string) => this.handleStderr(session, chunk));
    proc.on("exit", () => this.handleClose(session));
    proc.on("error", (error) => this.handleProcError(session, error));

    try {
      await this.sendRpc(session, "initialize", {
        protocolVersion: MCP_CLIENT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "ai-orchestrator", version: "0.1.0" }
      }, normalizeTimeoutMs(config));
    } catch (error) {
      this.killSession(session);
      throw error;
    }

    this.sendNotification(session, "notifications/initialized", {});
    return session;
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
   * listener for its token; a `ping` request is answered; other requests get
   * "method not found" (L2M offers no client capabilities yet); other
   * notifications are ignored.
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
    if (message.id === undefined || message.id === null) return;
    const reply =
      message.method === "ping"
        ? { jsonrpc: "2.0", id: message.id, result: {} }
        : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not supported by this client: ${message.method}` } };
    this.writeMessage(session, reply);
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
    if (pending.method !== "initialize") {
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
    this.handleClose(session);
  }

  /**
   * Terminate every child process cached in this context and wait for each to
   * exit. A child that ignores SIGTERM is sent SIGKILL after a grace period, so
   * the caller can rely on the processes being gone once this resolves.
   */
  async closeSessions(context: MCPExecutionContext): Promise<void> {
    const cache = this.getCache(context);
    const exits: Array<Promise<void>> = [];
    const reason = context.signal?.aborted ? cancelReason(context.signal) : "MCP session closed.";
    for (const [key, value] of cache) {
      if (value && typeof value === "object" && "proc" in value) {
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
    const withMeta =
      options.progressToken && params && typeof params === "object"
        ? { ...(params as Record<string, unknown>), _meta: { progressToken: options.progressToken } }
        : params;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params: withMeta }) + "\n";
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
      const timer = setTimeout(() => {
        if (session.pending.has(id)) {
          // Phase 10.5 — a timed-out request is cancelled on the server too.
          if (method !== "initialize") {
            this.writeMessage(session, buildCancelledNotification(id, `Timed out after ${timeoutMs}ms`));
            session.cancelsSent += 1;
          }
          session.pending.delete(id);
          reject(new Error(`MCP stdio request '${method}' timed out after ${timeoutMs}ms.`));
        }
      }, timeoutMs);
      session.pending.set(id, { method, resolve, reject, timer });

      if (session.closed) {
        session.pending.delete(id);
        clearTimeout(timer);
        reject(session.closeError ?? new Error("MCP stdio session closed before request was sent."));
        return;
      }

      try {
        session.proc.stdin?.write(payload);
      } catch (writeError) {
        session.pending.delete(id);
        clearTimeout(timer);
        reject(writeError instanceof Error ? writeError : new Error("Failed to write to MCP stdio process."));
      }
    }).then(
      (response) => {
        cleanup();
        if (response.error) {
          throw new Error(response.error.message || "MCP JSON-RPC error");
        }
        return response;
      },
      (error: unknown) => {
        cleanup();
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

  private async getOrCreateSession(
    config: MCPServerConfig,
    context: MCPExecutionContext,
    options?: { forceNew?: boolean }
  ): Promise<StdioSession> {
    const cache = this.getCache(context);
    const key = buildSessionKey(config);

    if (options?.forceNew) {
      const existing = cache.get(key);
      if (existing) {
        this.killSession(existing);
        cache.delete(key);
      }
    } else {
      const existing = this.readSession(cache, key);
      if (existing) {
        return existing;
      }
    }

    const session = await this.createSession(config, context);
    cache.set(key, session);
    return session;
  }

  private async listAllTools(
    session: StdioSession,
    config: MCPServerConfig,
    context: MCPExecutionContext
  ): Promise<MCPToolDefinition[]> {
    const tools: MCPToolDefinition[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_LIST_PAGES; page += 1) {
      const response = await this.sendRpc(session, "tools/list", cursor ? { cursor } : {}, normalizeTimeoutMs(config), {
        ...(context.signal ? { signal: context.signal } : {})
      });
      const result = toRecord(response.result);
      tools.push(...normalizeDiscoveredTools(config.serverId, config.label ?? this.definition.label, result.tools));
      cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    session.outputSchemas = new Map(tools.map((tool) => [tool.name, tool.outputSchema]));
    return tools;
  }

  async discoverTools(config: MCPServerConfig, context: MCPExecutionContext): Promise<MCPToolDefinition[]> {
    const session = await this.getOrCreateSession(config, context);
    return this.listAllTools(session, config, context);
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
    return this.sendRpc(session, "tools/call", { name: toolName, arguments: args }, timeoutMs, {
      ...(context.signal ? { signal: context.signal } : {}),
      ...(progressToken && onProgress
        ? {
            progressToken,
            onProgress: (progress: ParsedProgress) =>
              onProgress(
                toProgressEventFor(progress, toolName, config)
              )
          }
        : {})
    });
  }

  async invokeTool(
    toolName: string,
    args: Record<string, unknown>,
    config: MCPServerConfig,
    context: MCPExecutionContext
  ): Promise<MCPToolResult> {
    const timeoutMs = normalizeTimeoutMs(config);
    try {
      let session = await this.getOrCreateSession(config, context);
      let response: JsonRpcResponse;
      try {
        response = await this.callTool(session, toolName, args, config, context, timeoutMs);
      } catch (firstError) {
        if (!session.closed || session.closedByClient || firstError instanceof McpRequestCanceledError) {
          throw firstError;
        }
        session = await this.getOrCreateSession(config, context, { forceNew: true });
        response = await this.callTool(session, toolName, args, config, context, timeoutMs);
      }
      const outputSchema = await this.outputSchemaFor(session, toolName, config, context);
      return buildToolCallResult(toolName, response.result, outputSchema);
    } catch (error) {
      return {
        ok: false,
        output: null,
        error: error instanceof Error ? error.message : "Stdio MCP tool invocation failed"
      };
    }
  }
}
