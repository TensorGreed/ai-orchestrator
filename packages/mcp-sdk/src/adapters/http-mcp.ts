import type {
  McpPrompt,
  McpPromptGetResult,
  McpResource,
  McpResourceReadResult,
  McpResourceTemplate,
  McpServerCapabilities,
  MCPServerConfig,
  MCPToolDefinition,
  MCPToolResult
} from "@ai-orchestrator/shared";
import type {
  MCPExecutionContext,
  MCPServerAdapter,
  McpOAuthTokenProvider,
  McpReadResourceOptions,
  McpServerRequestOrigin
} from "../types";
import { McpDelegatedCredentialError, McpJsonRpcError, McpTimeoutError, classifyMcpError } from "../errors";
import {
  DEFAULT_RESOURCE_MAX_BYTES,
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
  CANCEL_NOTIFICATION_TIMEOUT_MS,
  MCP_CLIENT_PROTOCOL_VERSION,
  buildCancelledNotification,
  cancelReason,
  parseProgressNotification,
  readSseStream,
  toProgressEvent
} from "../progress";

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

interface InFlightRequest {
  id: string;
  method: string;
  controller: AbortController;
  /** Set once `notifications/cancelled` went out, so it is sent at most once. */
  cancelled: boolean;
}

interface PreparedSession {
  endpoint: string;
  headers: Record<string, string>;
  timeoutMs: number;
  createdAt: number;
  /** Requests waiting for a response, by JSON-RPC id. */
  inFlight: Map<string, InFlightRequest>;
  /** Tool output schemas from tools/list, once listed in this session. */
  outputSchemas?: Map<string, Record<string, unknown> | undefined>;
  /** Phase 10.5 — what the server declared in `initialize`. */
  capabilities: McpServerCapabilities;
  /** Answers to server-initiated requests still being posted. */
  serverRequests: Set<Promise<void>>;
}

/** Controls the timeout of a request while its response stream is open. */
interface RequestTimer {
  /** Stop the clock, for example while a person answers an elicitation. */
  pause: () => void;
  /** Start the clock again from zero. */
  resume: () => void;
}

const SESSION_TTL_MS = 5 * 60 * 1000;
const SESSION_CACHE_PREFIX = "http_mcp_session:";
const MAX_TOOL_LIST_PAGES = 20;

let rpcCounter = 0;
function nextRequestId(prefix: string): string {
  rpcCounter = (rpcCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}-${Date.now().toString(36)}-${rpcCounter}`;
}

/** Thrown when the run's abort signal stopped a request; never retried. */
class McpRequestCanceledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpRequestCanceledError";
  }
}

/** HTTP status error from the MCP endpoint, with the headers the 401 handling needs. */
class McpHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly wwwAuthenticate: string | null
  ) {
    super(message);
    this.name = "McpHttpError";
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function buildSessionCacheKey(config: MCPServerConfig): string {
  // Phase 10.7 — a delegated server's session carries one user's token, so the user is part of the key.
  return `${config.serverId}::${config.registryServerId ?? ""}::${config.secretRef?.secretId ?? ""}::${config.delegatedUser?.userId ?? ""}::${JSON.stringify(config.connection ?? {})}`;
}

/**
 * Phase 10.7 — token options for a server: a delegated server asks for the
 * run subject's own token and fails when there is no subject.
 */
function tokenOptionsFor(config: MCPServerConfig, options?: { forceRefresh?: boolean }): { forceRefresh?: boolean; userId?: string } {
  if (config.credentialMode !== "delegated") return { ...(options?.forceRefresh ? { forceRefresh: true } : {}) };
  const userId = config.delegatedUser?.userId;
  if (!userId) {
    throw new McpDelegatedCredentialError(
      `MCP server '${config.label ?? config.registryServerId ?? config.serverId}' uses each user's own account, and this call has no user to act for.`
    );
  }
  return { ...(options?.forceRefresh ? { forceRefresh: true } : {}), userId };
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

function authTypeOf(config: MCPServerConfig): string {
  return String(toRecord(config.connection).authType ?? "none").trim().toLowerCase();
}

async function buildAuthHeaders(
  config: MCPServerConfig,
  context: MCPExecutionContext,
  oauth: McpOAuthTokenProvider | undefined,
  options?: { forceRefresh?: boolean }
): Promise<Record<string, string>> {
  const connection = toRecord(config.connection);
  const authType = authTypeOf(config);

  // Phase 10.7 — delegated servers only ever use the user's own OAuth token, never a shared credential.
  if (config.credentialMode === "delegated" && authType !== "oauth") {
    throw new McpDelegatedCredentialError(
      `MCP server '${config.label ?? config.registryServerId ?? config.serverId}' is set to use each user's own account, which needs OAuth authentication.`
    );
  }

  if (authType === "none") {
    return {};
  }

  if (authType === "oauth") {
    if (!config.registryServerId) {
      throw new Error(
        "OAuth authentication is only available for servers in the MCP server registry. Register the server and connect it there."
      );
    }
    if (!oauth) {
      throw new Error("OAuth authentication is not available in this runtime.");
    }
    const token = await oauth.getAccessToken(config.registryServerId, tokenOptionsFor(config, options));
    return { Authorization: `Bearer ${token}` };
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

function describeHttpError(status: number, bodyText: string, statusText: string, wwwAuthenticate: string | null): string {
  const base = `MCP HTTP ${status}: ${bodyText || statusText}`;
  if (status === 401 && wwwAuthenticate && /bearer/i.test(wwwAuthenticate)) {
    return `${base} The server asks for OAuth authorization: set the registry server's auth type to OAuth and connect it on the MCP servers page.`;
  }
  return base;
}

interface PostRpcOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  /** Run abort signal; stops the request (after the caller's cancel notice) and disables retries. */
  signal?: AbortSignal;
  /** Messages other than the response that arrive on an SSE response (notifications and server requests). */
  onMessage?: (message: JsonRpcResponse, timer: RequestTimer) => void;
  /** Registers the request so cancellation can find it while it is in flight. */
  track?: (controller: AbortController) => () => void;
}

/**
 * Read one JSON-RPC response. JSON bodies are parsed whole; SSE bodies are
 * read as a stream so notifications that precede the response reach
 * `onMessage` while the tool is still running.
 */
async function readRpcResponse(
  response: Response,
  requestId: string | number | undefined,
  onMessage?: (message: JsonRpcResponse) => void
): Promise<JsonRpcResponse | null> {
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("text/event-stream") && response.body) {
    let final: JsonRpcResponse | null = null;
    await readSseStream(response.body, (data) => {
      const candidate = data.trim();
      if (!candidate || candidate === "[DONE]") return false;
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(candidate) as JsonRpcResponse;
      } catch {
        return false;
      }
      const isResponse = message.method === undefined && ("result" in message || "error" in message);
      if (isResponse && (requestId === undefined || message.id === requestId)) {
        final = message;
        return true;
      }
      if (!isResponse) onMessage?.(message);
      return false;
    });
    return final;
  }
  const bodyText = await response.text();
  if (!bodyText.trim()) {
    // 202 Accepted for notifications carries no body.
    return null;
  }
  return parseJsonRpcBody(bodyText);
}

async function postRpc(
  endpoint: string,
  payload: Record<string, unknown>,
  headers: Record<string, string>,
  timeoutMs: number,
  retryOptions?: PostRpcOptions
): Promise<{ response: JsonRpcResponse; sessionId?: string }> {
  const maxRetries = retryOptions?.maxRetries ?? 2;
  const baseDelayMs = retryOptions?.baseDelayMs ?? 1000;
  const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
  const requestId = payload.id as string | number | undefined;
  const isNotification = requestId === undefined;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (retryOptions?.signal?.aborted) {
      throw new McpRequestCanceledError(`MCP request canceled: ${cancelReason(retryOptions.signal)}`);
    }
    const abortController = new AbortController();
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    const startClock = () => {
      timeout = setTimeout(() => {
        timedOut = true;
        abortController.abort();
      }, timeoutMs);
    };
    const timer: RequestTimer = {
      pause: () => {
        if (timeout) clearTimeout(timeout);
        timeout = undefined;
      },
      resume: () => {
        timer.pause();
        startClock();
      }
    };
    startClock();
    const untrack = retryOptions?.track?.(abortController);
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

      if (!response.ok) {
        const bodyText = await response.text();
        const wwwAuthenticate = response.headers.get("www-authenticate");
        // Check if retryable
        if (attempt < maxRetries && RETRYABLE_STATUSES.has(response.status)) {
          lastError = new Error(`MCP HTTP ${response.status}: ${bodyText || response.statusText}`);
          // Parse Retry-After header on 429
          let delay = baseDelayMs * Math.pow(2, attempt);
          if (response.status === 429) {
            const retryAfter = response.headers.get("retry-after");
            if (retryAfter) {
              const retryAfterMs = Number(retryAfter) * 1000;
              if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
                delay = Math.min(retryAfterMs, 120_000);
              }
            }
          }
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw new McpHttpError(
          describeHttpError(response.status, bodyText, response.statusText, wwwAuthenticate),
          response.status,
          wwwAuthenticate
        );
      }

      const sessionId = response.headers.get("mcp-session-id") ?? response.headers.get("Mcp-Session-Id") ?? undefined;
      const onMessage = retryOptions?.onMessage;
      const parsed = await readRpcResponse(response, requestId, onMessage ? (message) => onMessage(message, timer) : undefined);
      if (!parsed) {
        if (isNotification) {
          return { response: {}, sessionId };
        }
        throw new Error("MCP server closed the response stream before answering.");
      }
      if (parsed.error) {
        throw new McpJsonRpcError(parsed.error.message || "MCP JSON-RPC error", parsed.error.code);
      }

      return { response: parsed, sessionId };
    } catch (error) {
      if (retryOptions?.signal?.aborted) {
        throw new McpRequestCanceledError(`MCP request canceled: ${cancelReason(retryOptions.signal)}`);
      }
      if (error instanceof Error && error.name === "AbortError") {
        lastError = new McpTimeoutError(`MCP request timed out after ${timeoutMs}ms.`);
        if (!timedOut) {
          throw new McpRequestCanceledError("MCP request canceled.");
        }
        if (attempt < maxRetries) {
          const delay = baseDelayMs * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw lastError;
      }
      // Network errors are retryable
      if (attempt < maxRetries && error instanceof TypeError) {
        lastError = error;
        const delay = baseDelayMs * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    } finally {
      timer.pause();
      untrack?.();
    }
  }

  throw lastError ?? new Error("MCP request failed after retries");
}

async function prepareSession(
  config: MCPServerConfig,
  context: MCPExecutionContext,
  oauth: McpOAuthTokenProvider | undefined
): Promise<PreparedSession> {
  const transport = String(config.connection?.transport ?? "http_streamable")
    .trim()
    .toLowerCase();
  if (transport !== "http_streamable") {
    throw new Error("http_mcp adapter currently supports only 'HTTP Streamable' transport.");
  }

  const endpoint = normalizeEndpoint(config);
  const timeoutMs = normalizeTimeoutMs(config);
  const customHeaders = toRecord(config.connection?.headers);

  const buildHeaders = async (forceRefresh?: boolean) => {
    const headers: Record<string, string> = {
      ...(await buildAuthHeaders(config, context, oauth, forceRefresh ? { forceRefresh } : undefined))
    };
    for (const [key, value] of Object.entries(customHeaders)) {
      if (typeof value === "string" && key.trim()) {
        headers[key] = value;
      }
    }
    return headers;
  };

  let headers = await buildHeaders();
  const initializePayload = {
    jsonrpc: "2.0",
    id: "init-1",
    method: "initialize",
    params: {
      protocolVersion: MCP_CLIENT_PROTOCOL_VERSION,
      capabilities: buildClientCapabilities(context),
      clientInfo: {
        name: "ai-orchestrator",
        version: "0.1.0"
      }
    }
  };

  let initialize: Awaited<ReturnType<typeof postRpc>>;
  try {
    initialize = await postRpc(endpoint, initializePayload, headers, timeoutMs, { signal: context.signal });
  } catch (error) {
    // An OAuth access token the server rejects is refreshed once before giving up.
    if (error instanceof McpHttpError && error.status === 401 && authTypeOf(config) === "oauth") {
      headers = await buildHeaders(true);
      initialize = await postRpc(endpoint, initializePayload, headers, timeoutMs, { signal: context.signal });
    } else {
      throw error;
    }
  }

  const sessionId = initialize.sessionId;
  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
  }
  const initializeResult = toRecord(initialize.response.result);
  const capabilities = normalizeServerCapabilities(initializeResult.capabilities);
  const negotiated = initializeResult.protocolVersion;
  if (typeof negotiated === "string" && negotiated.trim()) {
    headers["mcp-protocol-version"] = negotiated.trim();
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
      timeoutMs,
      { maxRetries: 0 }
    );
  } catch {
    // Intentionally ignored.
  }

  return { endpoint, headers, timeoutMs, createdAt: Date.now(), inFlight: new Map(), capabilities, serverRequests: new Set() };
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

function isPreparedSession(value: unknown): value is PreparedSession {
  return Boolean(value) && typeof value === "object" && "endpoint" in (value as object) && "inFlight" in (value as object);
}

export class HttpMCPServerAdapter implements MCPServerAdapter {
  private readonly fallbackSessionCache = new Map<string, PreparedSession>();
  private oauth?: McpOAuthTokenProvider;

  constructor(options?: { oauth?: McpOAuthTokenProvider }) {
    this.oauth = options?.oauth;
  }

  /** Phase 10.5 — the token source for servers with `authType: "oauth"`. */
  setOAuthTokenProvider(provider: McpOAuthTokenProvider | undefined): void {
    this.oauth = provider;
  }

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
        authType: { type: "string", enum: ["none", "bearer", "basic", "oauth"] },
        secretRef: { type: "object" }
      }
    }
  };

  private getCache(context: MCPExecutionContext): Map<string, unknown> | Map<string, PreparedSession> {
    return context.runtimeState ?? this.fallbackSessionCache;
  }

  private readSession(cache: Map<string, unknown> | Map<string, PreparedSession>, key: string): PreparedSession | undefined {
    const cacheKey = `${SESSION_CACHE_PREFIX}${key}`;
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
    const cacheKey = `${SESSION_CACHE_PREFIX}${key}`;
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

    const session = await prepareSession(config, context, this.oauth);
    this.writeSession(cache, key, session);
    return session;
  }

  /**
   * Send `notifications/cancelled` for one in-flight request (at most once),
   * then abort its fetch. The notice is best-effort and short: a server that
   * does not answer it does not hold up cancellation.
   */
  private async cancelRequest(session: PreparedSession, request: InFlightRequest, reason: string): Promise<void> {
    if (request.cancelled) return;
    request.cancelled = true;
    // The spec forbids cancelling initialize.
    if (request.method !== "initialize") {
      try {
        await postRpc(session.endpoint, buildCancelledNotification(request.id, reason), session.headers, CANCEL_NOTIFICATION_TIMEOUT_MS, {
          maxRetries: 0
        });
      } catch {
        // Best-effort: the fetch abort below still stops waiting for the response.
      }
    }
    request.controller.abort();
  }

  /** Requests with a JSON-RPC id that may be cancelled while they are in flight. */
  private async trackedRpc(
    session: PreparedSession,
    payload: { id: string; method: string; params: Record<string, unknown> },
    context: MCPExecutionContext,
    config: MCPServerConfig,
    options: { toolName?: string; onMessage?: (message: JsonRpcResponse) => void; timeoutMs?: number } = {}
  ): Promise<{ response: JsonRpcResponse; sessionId?: string }> {
    const onMessage = this.serverMessageHandler(session, context, config, options);
    const signal = context.signal;
    if (signal?.aborted) {
      throw new McpRequestCanceledError(`MCP request canceled: ${cancelReason(signal)}`);
    }
    let entry: InFlightRequest | undefined;
    let cancelPromise: Promise<void> | undefined;
    const onAbort = () => {
      if (entry) cancelPromise = this.cancelRequest(session, entry, cancelReason(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await postRpc(session.endpoint, { jsonrpc: "2.0", ...payload }, session.headers, options.timeoutMs ?? session.timeoutMs, {
        ...(signal ? { signal } : {}),
        onMessage,
        track: (controller) => {
          entry = { id: payload.id, method: payload.method, controller, cancelled: false };
          session.inFlight.set(payload.id, entry);
          return () => {
            session.inFlight.delete(payload.id);
          };
        }
      });
    } catch (error) {
      if (cancelPromise) await cancelPromise;
      // A timed-out tools/call is cancelled too, so the server can stop working on it.
      if (entry && !entry.cancelled && error instanceof Error && /timed out/.test(error.message)) {
        await this.cancelRequest(session, entry, error.message);
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Phase 10.5 — messages other than the awaited response on a response
   * stream: progress and `list_changed` notifications, and the requests a
   * server makes of the client (`ping`, `elicitation/create`,
   * `sampling/createMessage`), whose answers are posted back on the session.
   * The request's timeout is paused while an answer is being produced, so a
   * person can take their time with an elicitation.
   */
  private serverMessageHandler(
    session: PreparedSession,
    context: MCPExecutionContext,
    config: MCPServerConfig,
    options: { toolName?: string; onMessage?: (message: JsonRpcResponse) => void }
  ): (message: JsonRpcResponse, timer: RequestTimer) => void {
    const origin: McpServerRequestOrigin = {
      serverId: config.serverId,
      ...(config.registryServerId ? { registryServerId: config.registryServerId } : {}),
      ...(options.toolName ? { toolName: options.toolName } : {})
    };
    return (message, timer) => {
      const listChanged = parseListChangedNotification(message);
      if (listChanged) {
        try {
          context.onListChanged?.({ kind: listChanged, serverId: origin.serverId, ...(origin.registryServerId ? { registryServerId: origin.registryServerId } : {}), at: new Date().toISOString() });
        } catch {
          // A failing listener never breaks the call.
        }
        return;
      }
      if (isServerRequest(message)) {
        timer.pause();
        const answer = answerServerRequest(message, context, origin)
          .then((reply) => this.postClientResponse(session, reply))
          .catch(() => undefined)
          .finally(() => {
            timer.resume();
            session.serverRequests.delete(answer);
          });
        session.serverRequests.add(answer);
        return;
      }
      options.onMessage?.(message);
    };
  }

  /** Post a JSON-RPC response (to a server request) on the session; the server answers 202. */
  private async postClientResponse(session: PreparedSession, payload: Record<string, unknown>): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), session.timeoutMs);
    try {
      const response = await fetch(session.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...session.headers },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      // The body of a 202 is empty; anything else is drained so the socket is released.
      await response.text().catch(() => undefined);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Phase 10.5 — cancel whatever is still in flight in this context's
   * sessions (sending `notifications/cancelled` first) and forget the
   * sessions. Called when an agent or MCP Tool node ends or is aborted.
   */
  async closeSessions(context: MCPExecutionContext): Promise<void> {
    const cache = this.getCache(context) as Map<string, unknown>;
    const reason = context.signal?.aborted ? cancelReason(context.signal) : "MCP session closed.";
    const pending: Array<Promise<void>> = [];
    for (const [key, value] of [...cache.entries()]) {
      if (!key.startsWith(SESSION_CACHE_PREFIX) || !isPreparedSession(value)) continue;
      for (const request of value.inFlight.values()) {
        pending.push(this.cancelRequest(value, request, reason));
      }
      cache.delete(key);
    }
    await Promise.all(pending);
  }

  private async listAllTools(
    session: PreparedSession,
    config: MCPServerConfig,
    context: MCPExecutionContext
  ): Promise<MCPToolDefinition[]> {
    const tools: MCPToolDefinition[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_LIST_PAGES; page += 1) {
      const list = await this.trackedRpc(
        session,
        { id: nextRequestId("tools-list"), method: "tools/list", params: cursor ? { cursor } : {} },
        context,
        config
      );
      const result = toRecord(list.response.result);
      tools.push(...normalizeDiscoveredTools(config.serverId, config.label ?? this.definition.label, result.tools));
      cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    session.outputSchemas = new Map(tools.map((tool) => [tool.name, tool.outputSchema]));
    return tools;
  }

  async discoverTools(config: MCPServerConfig, context: MCPExecutionContext): Promise<MCPToolDefinition[]> {
    const session = await this.getOrCreateSession(config, context, { forceNew: true });
    // Return empty array instead of throwing — let the workflow continue
    // with whatever tools were discovered from other servers
    return this.listAllTools(session, config, context);
  }

  /** The tool's outputSchema, listing the tools once per session when needed. Unknown → undefined. */
  private async outputSchemaFor(
    session: PreparedSession,
    toolName: string,
    config: MCPServerConfig,
    context: MCPExecutionContext
  ): Promise<Record<string, unknown> | undefined> {
    if (!session.outputSchemas) {
      try {
        await this.listAllTools(session, config, context);
      } catch (error) {
        if (error instanceof McpRequestCanceledError) throw error;
        // Servers that cannot list tools still get their calls; results are just not validated.
        session.outputSchemas = new Map();
      }
    }
    return session.outputSchemas?.get(toolName);
  }

  private async callTool(
    session: PreparedSession,
    toolName: string,
    args: Record<string, unknown>,
    config: MCPServerConfig,
    context: MCPExecutionContext
  ): Promise<JsonRpcResponse> {
    const id = nextRequestId("tool-call");
    const progressToken = context.onProgress ? `l2m-progress-${id}` : undefined;
    const onMessage = progressToken
      ? (message: JsonRpcResponse) => {
          const parsed = parseProgressNotification(message);
          if (!parsed || parsed.progressToken !== progressToken) return;
          try {
            context.onProgress?.(
              toProgressEvent(parsed, {
                toolName,
                serverId: config.serverId,
                ...(config.registryServerId ? { registryServerId: config.registryServerId } : {})
              })
            );
          } catch {
            // A failing progress sink never fails the tool call.
          }
        }
      : undefined;
    const result = await this.trackedRpc(
      session,
      {
        id,
        method: "tools/call",
        params: {
          name: toolName,
          arguments: args,
          ...(progressToken ? { _meta: { progressToken } } : {})
        }
      },
      context,
      config,
      {
        toolName,
        ...(onMessage ? { onMessage } : {}),
        // Phase 10.7 — a per-call timeout from the server's runtime limits.
        ...(typeof context.callTimeoutMs === "number" && context.callTimeoutMs >= 1 ? { timeoutMs: Math.floor(context.callTimeoutMs) } : {})
      }
    );
    return result.response;
  }

  /** Follow a paginated list method to the end, collecting `key` of each page. */
  private async listAllPages(
    session: PreparedSession,
    method: string,
    key: string,
    config: MCPServerConfig,
    context: MCPExecutionContext
  ): Promise<unknown[]> {
    const items: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const list = await this.trackedRpc(
        session,
        { id: nextRequestId(method.replace(/\//g, "-")), method, params: cursor ? { cursor } : {} },
        context,
        config
      );
      const result = toRecord(list.response.result);
      if (Array.isArray(result[key])) items.push(...(result[key] as unknown[]));
      cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return items;
  }

  async describeServer(config: MCPServerConfig, context: MCPExecutionContext): Promise<McpServerCapabilities> {
    const session = await this.getOrCreateSession(config, context);
    return session.capabilities;
  }

  async listResources(config: MCPServerConfig, context: MCPExecutionContext): Promise<McpResource[]> {
    const session = await this.getOrCreateSession(config, context);
    if (!session.capabilities.resources) return [];
    return normalizeResources(await this.listAllPages(session, "resources/list", "resources", config, context));
  }

  async listResourceTemplates(config: MCPServerConfig, context: MCPExecutionContext): Promise<McpResourceTemplate[]> {
    const session = await this.getOrCreateSession(config, context);
    if (!session.capabilities.resources) return [];
    return normalizeResourceTemplates(
      await this.listAllPages(session, "resources/templates/list", "resourceTemplates", config, context)
    );
  }

  async readResource(
    uri: string,
    config: MCPServerConfig,
    context: MCPExecutionContext,
    options: McpReadResourceOptions = {}
  ): Promise<McpResourceReadResult> {
    const session = await this.getOrCreateSession(config, context);
    const read = await this.trackedRpc(
      session,
      { id: nextRequestId("resources-read"), method: "resources/read", params: { uri } },
      context,
      config
    );
    return normalizeResourceReadResult(uri, read.response.result, options.maxBytes ?? DEFAULT_RESOURCE_MAX_BYTES);
  }

  async listPrompts(config: MCPServerConfig, context: MCPExecutionContext): Promise<McpPrompt[]> {
    const session = await this.getOrCreateSession(config, context);
    if (!session.capabilities.prompts) return [];
    return normalizePrompts(await this.listAllPages(session, "prompts/list", "prompts", config, context));
  }

  async getPrompt(
    name: string,
    args: Record<string, string>,
    config: MCPServerConfig,
    context: MCPExecutionContext
  ): Promise<McpPromptGetResult> {
    const session = await this.getOrCreateSession(config, context);
    const got = await this.trackedRpc(
      session,
      {
        id: nextRequestId("prompts-get"),
        method: "prompts/get",
        params: { name, ...(Object.keys(args).length > 0 ? { arguments: args } : {}) }
      },
      context,
      config
    );
    return normalizePromptGetResult(name, got.response.result);
  }

  async invokeTool(
    toolName: string,
    args: Record<string, unknown>,
    config: MCPServerConfig,
    context: MCPExecutionContext
  ): Promise<MCPToolResult> {
    try {
      let session = await this.getOrCreateSession(config, context);
      let response: JsonRpcResponse;
      try {
        response = await this.callTool(session, toolName, args, config, context);
      } catch (error) {
        if (error instanceof McpRequestCanceledError) throw error;
        // Retry once with a fresh session if the cached session is no longer
        // valid; an OAuth server answering 401 gets a refreshed token first.
        const unauthorized = error instanceof McpHttpError && error.status === 401 && authTypeOf(config) === "oauth";
        if (unauthorized && config.registryServerId && this.oauth) {
          await this.oauth.getAccessToken(config.registryServerId, tokenOptionsFor(config, { forceRefresh: true }));
        }
        session = await this.getOrCreateSession(config, context, { forceNew: true });
        response = await this.callTool(session, toolName, args, config, context);
      }
      const outputSchema = await this.outputSchemaFor(session, toolName, config, context);
      return buildToolCallResult(toolName, response.result, outputSchema);
    } catch (error) {
      return {
        ok: false,
        output: null,
        error: error instanceof Error ? error.message : "Remote MCP tool invocation failed",
        errorKind: classifyMcpError(error, context.signal)
      };
    }
  }
}
