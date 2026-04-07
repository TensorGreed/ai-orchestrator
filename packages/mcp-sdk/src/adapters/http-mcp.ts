import type { MCPServerConfig, MCPToolDefinition, MCPToolResult } from "@ai-orchestrator/shared";
import type { MCPExecutionContext, MCPServerAdapter } from "../types";

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: string | number | null;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

interface PreparedSession {
  endpoint: string;
  headers: Record<string, string>;
  timeoutMs: number;
  createdAt: number;
}

const SESSION_TTL_MS = 5 * 60 * 1000;

function toRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function buildSessionCacheKey(config: MCPServerConfig): string {
  return `${config.serverId}::${config.secretRef?.secretId ?? ""}::${JSON.stringify(config.connection ?? {})}`;
}

function normalizeEndpoint(config: MCPServerConfig): string {
  const endpoint = String(config.connection?.endpoint ?? "").trim();
  if (!endpoint) {
    throw new Error("MCP endpoint is required for http_mcp adapter.");
  }
  return endpoint;
}

function normalizeTimeoutMs(config: MCPServerConfig): number {
  const raw = Number(config.connection?.timeoutMs ?? 120000);
  if (!Number.isFinite(raw) || raw < 1000) {
    return 120000;
  }
  return Math.floor(raw);
}

async function buildAuthHeaders(config: MCPServerConfig, context: MCPExecutionContext): Promise<Record<string, string>> {
  const connection = toRecord(config.connection);
  const authType = String(connection.authType ?? "none").trim().toLowerCase();

  if (authType === "none") {
    return {};
  }

  const secretValue = await context.resolveSecret(config.secretRef);

  if (authType === "bearer") {
    const token =
      (typeof connection.bearerToken === "string" ? connection.bearerToken : undefined) ??
      (typeof secretValue === "string" ? secretValue : undefined);
    if (!token) {
      throw new Error("Bearer authentication selected but no token is configured.");
    }
    return {
      Authorization: `Bearer ${token}`
    };
  }

  if (authType === "basic") {
    const username = typeof connection.username === "string" ? connection.username : "";
    const password =
      (typeof connection.password === "string" ? connection.password : undefined) ??
      (typeof secretValue === "string" ? secretValue : undefined) ??
      "";

    if (!username || !password) {
      throw new Error("Basic authentication selected but username/password are missing.");
    }

    const encoded = Buffer.from(`${username}:${password}`, "utf-8").toString("base64");
    return {
      Authorization: `Basic ${encoded}`
    };
  }

  throw new Error(`Unsupported MCP authType '${authType}' for http_mcp adapter.`);
}

function parseJsonRpcBody(rawBody: string): JsonRpcResponse {
  const text = rawBody.trim();
  if (!text) {
    throw new Error("Empty MCP response");
  }

  try {
    return JSON.parse(text) as JsonRpcResponse;
  } catch {
    // Streamable/SSE fallback parsing: look for "data: <json>" lines.
    const lines = text.split(/\r?\n/);
    const dataLines = lines.filter((line) => line.trimStart().startsWith("data:"));
    for (let index = dataLines.length - 1; index >= 0; index -= 1) {
      const line = dataLines[index];
      const candidate = line.slice(line.indexOf("data:") + 5).trim();
      if (!candidate || candidate === "[DONE]") {
        continue;
      }
      try {
        return JSON.parse(candidate) as JsonRpcResponse;
      } catch {
        // Continue scanning older chunks.
      }
    }
    throw new Error("MCP server returned non-JSON response.");
  }
}

async function postRpc(
  endpoint: string,
  payload: Record<string, unknown>,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<{ response: JsonRpcResponse; sessionId?: string }> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers
      },
      body: JSON.stringify(payload),
      signal: abortController.signal
    });

    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(`MCP HTTP ${response.status}: ${bodyText || response.statusText}`);
    }

    const parsed = parseJsonRpcBody(bodyText);
    if (parsed.error) {
      throw new Error(parsed.error.message || "MCP JSON-RPC error");
    }

    return {
      response: parsed,
      sessionId: response.headers.get("mcp-session-id") ?? response.headers.get("Mcp-Session-Id") ?? undefined
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`MCP request timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function prepareSession(
  config: MCPServerConfig,
  context: MCPExecutionContext
): Promise<PreparedSession> {
  const transport = String(config.connection?.transport ?? "http_streamable")
    .trim()
    .toLowerCase();
  if (transport !== "http_streamable") {
    throw new Error("http_mcp adapter currently supports only 'HTTP Streamable' transport.");
  }

  const endpoint = normalizeEndpoint(config);
  const timeoutMs = normalizeTimeoutMs(config);
  const authHeaders = await buildAuthHeaders(config, context);
  const customHeaders = toRecord(config.connection?.headers);

  const headers: Record<string, string> = {
    ...authHeaders
  };
  for (const [key, value] of Object.entries(customHeaders)) {
    if (typeof value === "string" && key.trim()) {
      headers[key] = value;
    }
  }

  const initialize = await postRpc(
    endpoint,
    {
      jsonrpc: "2.0",
      id: "init-1",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "ai-orchestrator",
          version: "0.1.0"
        }
      }
    },
    headers,
    timeoutMs
  );

  const sessionId = initialize.sessionId;
  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
  }

  // Best-effort notification. Some servers require it, others ignore it.
  try {
    await postRpc(
      endpoint,
      {
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {}
      },
      headers,
      timeoutMs
    );
  } catch {
    // Intentionally ignored.
  }

  return { endpoint, headers, timeoutMs, createdAt: Date.now() };
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
      if (typeof row.text === "string") {
        return row.text;
      }
      if (row.json !== undefined) {
        return row.json;
      }
      return row;
    });
    return normalized.length === 1 ? normalized[0] : normalized;
  }

  return result;
}

export class HttpMCPServerAdapter implements MCPServerAdapter {
  private readonly fallbackSessionCache = new Map<string, PreparedSession>();

  readonly definition = {
    id: "http_mcp",
    label: "HTTP MCP Server",
    description: "Connect to a remote MCP endpoint over HTTP streamable transport.",
    configSchema: {
      type: "object",
      properties: {
        endpoint: { type: "string", description: "MCP server HTTP endpoint URL" },
        transport: { type: "string", enum: ["http_streamable"] },
        timeoutMs: { type: "number" },
        headers: { type: "object", additionalProperties: { type: "string" } }
      },
      required: ["endpoint"]
    },
    authSchema: {
      type: "object",
      properties: {
        authType: { type: "string", enum: ["none", "bearer", "basic"] },
        secretRef: { type: "object" }
      }
    }
  };

  private getCache(context: MCPExecutionContext): Map<string, unknown> | Map<string, PreparedSession> {
    return context.runtimeState ?? this.fallbackSessionCache;
  }

  private readSession(cache: Map<string, unknown> | Map<string, PreparedSession>, key: string): PreparedSession | undefined {
    const cacheKey = `http_mcp_session:${key}`;
    const raw = cache.get(cacheKey) as PreparedSession | undefined;
    if (!raw) {
      return undefined;
    }

    if (Date.now() - raw.createdAt > SESSION_TTL_MS) {
      cache.delete(cacheKey);
      return undefined;
    }

    return raw;
  }

  private writeSession(cache: Map<string, unknown> | Map<string, PreparedSession>, key: string, session: PreparedSession): void {
    const cacheKey = `http_mcp_session:${key}`;
    cache.set(cacheKey, session);
  }

  private async getOrCreateSession(
    config: MCPServerConfig,
    context: MCPExecutionContext,
    options?: { forceNew?: boolean }
  ): Promise<PreparedSession> {
    const key = buildSessionCacheKey(config);
    const cache = this.getCache(context);

    if (!options?.forceNew) {
      const cached = this.readSession(cache, key);
      if (cached) {
        return cached;
      }
    }

    const session = await prepareSession(config, context);
    this.writeSession(cache, key, session);
    return session;
  }

  async discoverTools(config: MCPServerConfig, context: MCPExecutionContext): Promise<MCPToolDefinition[]> {
    const session = await this.getOrCreateSession(config, context, { forceNew: true });
    const list = await postRpc(
      session.endpoint,
      {
        jsonrpc: "2.0",
        id: "tools-list-1",
        method: "tools/list",
        params: {}
      },
      session.headers,
      session.timeoutMs
    );

    const tools = normalizeDiscoveredTools(
      config.serverId,
      config.label ?? this.definition.label,
      toRecord(list.response.result).tools
    );

    if (!tools.length) {
      throw new Error("No MCP tools discovered from remote server.");
    }

    return tools;
  }

  async invokeTool(
    toolName: string,
    args: Record<string, unknown>,
    config: MCPServerConfig,
    context: MCPExecutionContext
  ): Promise<MCPToolResult> {
    try {
      let session = await this.getOrCreateSession(config, context);
      let result: Awaited<ReturnType<typeof postRpc>>;
      try {
        result = await postRpc(
          session.endpoint,
          {
            jsonrpc: "2.0",
            id: "tool-call-1",
            method: "tools/call",
            params: {
              name: toolName,
              arguments: args
            }
          },
          session.headers,
          session.timeoutMs
        );
      } catch {
        // Retry once with a fresh session if cached session is no longer valid.
        session = await this.getOrCreateSession(config, context, { forceNew: true });
        result = await postRpc(
          session.endpoint,
          {
            jsonrpc: "2.0",
            id: "tool-call-2",
            method: "tools/call",
            params: {
              name: toolName,
              arguments: args
            }
          },
          session.headers,
          session.timeoutMs
        );
      }

      return {
        ok: true,
        output: normalizeToolCallOutput(result.response.result)
      };
    } catch (error) {
      return {
        ok: false,
        output: null,
        error: error instanceof Error ? error.message : "Remote MCP tool invocation failed"
      };
    }
  }
}
