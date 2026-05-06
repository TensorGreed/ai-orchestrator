import { spawn, type ChildProcess } from "node:child_process";
import type { MCPServerConfig, MCPToolDefinition, MCPToolResult } from "@ai-orchestrator/shared";
import type { MCPExecutionContext, MCPServerAdapter } from "../types";

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: string | number | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface PendingRequest {
  resolve: (response: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface StdioSession {
  proc: ChildProcess;
  pending: Map<number, PendingRequest>;
  buffer: string;
  rpcCounter: number;
  stderrBuffer: string[];
  closed: boolean;
  closeError?: Error;
  createdAt: number;
}

const SESSION_TTL_MS = 30 * 60 * 1000;
const STDERR_LOG_BUFFER_LINES = 100;
const DEFAULT_TIMEOUT_MS = 120_000;

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
      inputSchema: toRecord(item.inputSchema ?? item.input_schema)
    }));
}

function normalizeToolCallOutput(result: unknown): unknown {
  const asObj = toRecord(result);
  const structured = asObj.structuredContent ?? asObj.structured_content;
  if (structured !== undefined) {
    return structured;
  }
  const content = asObj.content;
  if (Array.isArray(content)) {
    const normalized = content.map((entry) => {
      const row = toRecord(entry);
      if (typeof row.text === "string") return row.text;
      if (row.json !== undefined) return row.json;
      return row;
    });
    return normalized.length === 1 ? normalized[0] : normalized;
  }
  return result;
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

    const proc = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false
    });

    const session: StdioSession = {
      proc,
      pending: new Map(),
      buffer: "",
      rpcCounter: 0,
      stderrBuffer: [],
      closed: false,
      createdAt: Date.now()
    };

    proc.stdout?.setEncoding("utf-8");
    proc.stdout?.on("data", (chunk: string) => this.handleStdout(session, chunk));
    proc.stderr?.setEncoding("utf-8");
    proc.stderr?.on("data", (chunk: string) => this.handleStderr(session, chunk));
    proc.on("exit", () => this.handleClose(session));
    proc.on("error", (error) => this.handleProcError(session, error));

    try {
      await this.sendRpc(session, "initialize", {
        protocolVersion: "2024-11-05",
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

    if (parsed.id === undefined || parsed.id === null) {
      // Server-initiated notification — silently dropped for now.
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
    session.closeError = error;
    this.handleClose(session);
  }

  private killSession(session: StdioSession): void {
    if (!session.closed) {
      try {
        session.proc.kill();
      } catch {
        // ignore
      }
    }
    session.closed = true;
  }

  private sendRpc(
    session: StdioSession,
    method: string,
    params: unknown,
    timeoutMs: number
  ): Promise<JsonRpcResponse> {
    if (session.closed) {
      return Promise.reject(session.closeError ?? new Error("MCP stdio session is closed."));
    }
    session.rpcCounter += 1;
    const id = session.rpcCounter;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (session.pending.has(id)) {
          session.pending.delete(id);
          reject(new Error(`MCP stdio request '${method}' timed out after ${timeoutMs}ms.`));
        }
      }, timeoutMs);
      session.pending.set(id, { resolve, reject, timer });

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
    }).then((response) => {
      if (response.error) {
        throw new Error(response.error.message || "MCP JSON-RPC error");
      }
      return response;
    });
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

  async discoverTools(config: MCPServerConfig, context: MCPExecutionContext): Promise<MCPToolDefinition[]> {
    const session = await this.getOrCreateSession(config, context);
    const response = await this.sendRpc(session, "tools/list", {}, normalizeTimeoutMs(config));
    return normalizeDiscoveredTools(
      config.serverId,
      config.label ?? this.definition.label,
      toRecord(response.result).tools
    );
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
        response = await this.sendRpc(session, "tools/call", { name: toolName, arguments: args }, timeoutMs);
      } catch (firstError) {
        if (!session.closed) {
          throw firstError;
        }
        session = await this.getOrCreateSession(config, context, { forceNew: true });
        response = await this.sendRpc(session, "tools/call", { name: toolName, arguments: args }, timeoutMs);
      }
      return { ok: true, output: normalizeToolCallOutput(response.result) };
    } catch (error) {
      return {
        ok: false,
        output: null,
        error: error instanceof Error ? error.message : "Stdio MCP tool invocation failed"
      };
    }
  }
}
