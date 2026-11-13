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
import type {
  MCPExecutionContext,
  MCPServerAdapter,
  McpOAuthTokenProvider,
  McpReadResourceOptions,
  McpServerRequestOrigin
} from "../types";
import {
  McpDelegatedCredentialError,
  McpJsonRpcError,
  McpMissingClientCapabilityError,
  McpOutcomeUnknownError,
  McpTimeoutError,
  classifyMcpError
} from "../errors";
import {
  DEFAULT_RESOURCE_MAX_BYTES,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_METHOD_NOT_FOUND,
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
import { annotateMcpError, annotateMcpRequest, mcpTraceCarrier, traceContextHeaders, traceMcpRound, withTraceContext } from "../tracing";
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
import { effectiveToolHints } from "../tool-policy";
import {
  DEFAULT_MRTR_MAX_ROUNDS,
  MCP_CLIENT_MODERN_PROTOCOL_VERSION,
  MCP_ERROR_HEADER_MISMATCH,
  MCP_ERROR_LEGACY_RESOURCE_NOT_FOUND,
  MCP_MODERN_PROTOCOL_VERSIONS,
  McpEraCache,
  buildMcpParamHeaders,
  buildMcpStandardHeaders,
  chooseMcpProtocolVersion,
  classifyHttpEraResponse,
  classifyMcpResult,
  httpEraCacheKey,
  initializeRejectionIsModern,
  isMrtrMethod,
  modernRequestMetaFor,
  parseDiscoverResult,
  parseMcpModernError,
  partitionToolsByHeaderAnnotations,
  resolveMcpClientProtocolMode,
  runMrtrRequest,
  withRequestMeta,
  type McpModernProtocolError,
  type McpMrtrMethod,
  type McpParamHeaderSpec
} from "../protocol";

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

/**
 * One server connection as a run uses it. A legacy connection is an MCP
 * session opened with `initialize`; a modern (2026-07-28) connection has no
 * session: every request carries its protocol version, capabilities and
 * client info in `_meta` and in the standard headers.
 */
interface PreparedSession {
  /** How this connection talks to the server. */
  era: McpProtocolEra;
  /** The connection's `protocolMode` (or the deployment default) when it was opened. */
  mode: McpClientProtocolMode;
  /** Modern only: the version every request declares. */
  protocolVersion?: string;
  endpoint: string;
  /** Auth and custom headers; legacy also the session id and negotiated version. */
  headers: Record<string, string>;
  /** Rebuild the auth headers with a refreshed OAuth token (modern connections, which have no handshake to redo). */
  refreshAuth: () => Promise<void>;
  timeoutMs: number;
  createdAt: number;
  /** Requests waiting for a response, by JSON-RPC id. */
  inFlight: Map<string, InFlightRequest>;
  /** Tool output schemas from tools/list, once listed in this session. */
  outputSchemas?: Map<string, Record<string, unknown> | undefined>;
  /** Tool annotations from the last tools/list: whether a call may be sent again after a broken connection. */
  toolAnnotations?: Map<string, McpToolAnnotations | undefined>;
  /** Modern only: the `Mcp-Param-*` headers each tool asks for, from the last tools/list. */
  paramHeaders?: Map<string, McpParamHeaderSpec[]>;
  /** Modern only: tools left out of tools/list for invalid `x-mcp-header` annotations, with the reason. */
  rejectedTools?: Map<string, string>;
  /**
   * Phase 10.5 — what the server declared: in `initialize` (legacy) or in
   * `server/discover` (modern, fetched when first needed).
   */
  capabilities: McpServerCapabilities;
  /** False for a modern connection whose capabilities have not been fetched yet. */
  capabilitiesKnown: boolean;
  /** Modern only: a request on this connection succeeded, so its era is proven. */
  modernConfirmed?: boolean;
  /** The session cache key (server, credentials, connection), for tool annotations remembered across sessions. */
  cacheKey: string;
  /** Answers to server-initiated requests still being posted (legacy only). */
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
/** Longest an `auto` connection waits for its `server/discover` probe before going on with `initialize`. */
const ERA_PROBE_TIMEOUT_MS = 10_000;
/** Servers whose tool annotations the adapter remembers across sessions, for the safe re-issue rule. */
const MAX_REMEMBERED_TOOL_LISTS = 500;
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

/** Cancellation from this adapter or from the MRTR engine (which uses the same name). */
function isCanceledError(error: unknown): boolean {
  return error instanceof Error && error.name === "McpRequestCanceledError";
}

/** HTTP status error from the MCP endpoint, with the headers the 401 handling needs. */
class McpHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly wwwAuthenticate: string | null,
    /** The response body, for the era checks of MCP 2026-07-28 (bounded by the server's answer). */
    readonly bodyText: string = ""
  ) {
    super(message);
    this.name = "McpHttpError";
  }
}

/** The response stream ended before the response arrived. */
class McpStreamClosedError extends Error {
  constructor() {
    super("MCP server closed the response stream before answering.");
    this.name = "McpStreamClosedError";
  }
}

/**
 * A connection's cached era turned out wrong (a "modern" server answered
 * like a legacy one, or asked for a legacy version). The operation is run
 * again on a new connection of `era`; the server did not act on the
 * rejected request.
 */
class McpEraMismatchError extends Error {
  constructor(
    readonly era: McpProtocolEra,
    message: string,
    /** What the server answered, for the error shown when the other era fails too. */
    readonly detail: string = message
  ) {
    super(message);
    this.name = "McpEraMismatchError";
  }
}

/** Server-supplied text in messages and logs: control characters removed, length capped. */
function safeText(value: string, max = 200): string {
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ");
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
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

function serverNameOf(config: MCPServerConfig): string {
  return config.label ?? config.registryServerId ?? config.serverId;
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

/**
 * MCP 2026-07-28 (decision D13) — what to do when a request was sent and no
 * answer arrived (a network error after connecting, a timeout, a response
 * stream that ended early):
 * - `retry`: send it again, as earlier releases did for every request
 *   (legacy servers with the safe re-issue rule turned off, and requests
 *   that are safe to repeat on legacy servers);
 * - `retry_broken_stream`: also send it again after a broken response
 *   stream, which modern servers require of clients (safe requests only);
 * - `fail`: do not send it again; the call fails with
 *   `McpOutcomeUnknownError` (a timeout stays a timeout).
 * Errors before anything was sent (connection refused, unknown host) are
 * retried in every mode.
 */
type ReissueMode = "retry" | "retry_broken_stream" | "fail";

/** Network error codes that mean the request never reached the server. */
const NOT_SENT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT"
]);

/** undici's own header and body timeouts: the request was sent and no (complete) answer came in time. */
const FETCH_TIMEOUT_ERROR_CODES = new Set(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

function causeCodeIn(error: unknown, codes: ReadonlySet<string>): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && codes.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** True when a fetch failure happened before the request could be sent (the cause chain names a connect error). */
function failedBeforeSending(error: unknown): boolean {
  return causeCodeIn(error, NOT_SENT_ERROR_CODES);
}

/** Statuses retried for every request, as in earlier releases. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
/** D13 — statuses retried for a request that is not safe to repeat: the server says it did not act on it. */
const NOT_ACTED_ON_STATUSES = new Set([429, 503]);
/** D13 — gateway errors after which the upstream may have acted on the request. */
const OUTCOME_UNKNOWN_STATUSES = new Set([502, 504]);

function outcomeUnknown(method: string, detail: string): McpOutcomeUnknownError {
  const what = method === "tools/call" ? "The tool may or may not have run" : "The server may or may not have acted on it";
  return new McpOutcomeUnknownError(
    `MCP ${method} was sent, but ${detail}. ${what}; it was not sent again because it is not marked read-only or idempotent.`
  );
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
  /** D13 — see `ReissueMode`. Default `retry` (earlier releases' behaviour). */
  reissue?: ReissueMode;
  /** Modern connections: every attempt after the first is a new request with a new id. */
  newIdPerAttempt?: boolean;
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
  const reissue = retryOptions?.reissue ?? "retry";
  const requestId = payload.id as string | number | undefined;
  const isNotification = requestId === undefined;
  const method = typeof payload.method === "string" ? payload.method : "request";

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
    // A modern request sent again is a new request: it gets a new id (2026-07-28 has no stream resumption).
    const attemptId = attempt > 0 && retryOptions?.newIdPerAttempt && requestId !== undefined ? `${String(requestId)}-r${attempt}` : requestId;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers
        },
        body: JSON.stringify(attemptId === requestId ? payload : { ...payload, id: attemptId }),
        signal: abortController.signal
      });

      if (!response.ok) {
        const bodyText = await response.text();
        const wwwAuthenticate = response.headers.get("www-authenticate");
        // D13 — a gateway error can come after the upstream acted on a request that is not safe to repeat.
        if (reissue === "fail" && !isNotification && OUTCOME_UNKNOWN_STATUSES.has(response.status)) {
          throw outcomeUnknown(method, `the answer was HTTP ${response.status} from a gateway in front of the server`);
        }
        // Check if retryable
        const retryable = reissue === "fail" ? NOT_ACTED_ON_STATUSES : RETRYABLE_STATUSES;
        if (attempt < maxRetries && retryable.has(response.status)) {
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
          wwwAuthenticate,
          bodyText
        );
      }

      const sessionId = response.headers.get("mcp-session-id") ?? response.headers.get("Mcp-Session-Id") ?? undefined;
      const onMessage = retryOptions?.onMessage;
      const parsed = await readRpcResponse(response, attemptId, onMessage ? (message) => onMessage(message, timer) : undefined);
      if (!parsed) {
        if (isNotification) {
          return { response: {}, sessionId };
        }
        throw new McpStreamClosedError();
      }
      if (parsed.error) {
        throw new McpJsonRpcError(parsed.error.message || "MCP JSON-RPC error", parsed.error.code, parsed.error.data);
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
        // D13 — a request that timed out may have been acted on; only safe ones are sent again.
        if (attempt < maxRetries && reissue !== "fail") {
          const delay = baseDelayMs * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw lastError;
      }
      if (error instanceof McpStreamClosedError) {
        // Modern servers cannot resume a stream: a safe request is sent again with a new id (the caller's),
        // others fail with an unknown outcome. Legacy behaviour (no retry) is kept for `retry`.
        if (reissue === "fail" && !isNotification) throw outcomeUnknown(method, "the response stream ended before the answer");
        if (reissue === "retry_broken_stream" && attempt < maxRetries) {
          lastError = error;
          continue;
        }
        throw new Error(error.message);
      }
      // Network errors are retryable
      if (error instanceof TypeError) {
        if (reissue === "fail" && !isNotification && causeCodeIn(error, FETCH_TIMEOUT_ERROR_CODES)) {
          throw new McpTimeoutError(`MCP request timed out waiting for the server (${error.message}).`);
        }
        if (reissue === "fail" && !isNotification && !failedBeforeSending(error)) {
          throw outcomeUnknown(method, `the connection failed before the answer (${error.message})`);
        }
        if (attempt < maxRetries) {
          lastError = error;
          const delay = baseDelayMs * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
      }
      throw error;
    } finally {
      timer.pause();
      untrack?.();
    }
  }

  throw lastError ?? new Error("MCP request failed after retries");
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

/** `base` with `extra` on top; a header in `base` that `extra` names in another letter case is dropped, not doubled. */
function mergeHeaders(base: Record<string, string>, extra: Record<string, string>): Record<string, string> {
  const names = new Set(Object.keys(extra).map((name) => name.toLowerCase()));
  const merged: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (!names.has(name.toLowerCase())) merged[name] = value;
  }
  return { ...merged, ...extra };
}

/** The JSON-RPC error object in an HTTP error body, or null. */
function jsonRpcErrorInBody(bodyText: string): { code?: unknown; message?: unknown; data?: unknown } | null {
  if (!bodyText.trim()) return null;
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    const error = toRecord(parsed).error;
    return error && typeof error === "object" && !Array.isArray(error) ? (error as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The modern protocol error (-32020/-32021/-32022) an error carries, from a JSON-RPC error or a 400 body. */
function modernErrorOf(error: unknown): McpModernProtocolError | null {
  if (error instanceof McpJsonRpcError) {
    return parseMcpModernError({ code: error.code, message: error.message, data: error.data });
  }
  if (error instanceof McpHttpError) return parseMcpModernError(jsonRpcErrorInBody(error.bodyText));
  return null;
}

/** Protocol settings of the HTTP client (MCP 2026-07-28). Every field is optional; the defaults keep earlier behaviour. */
export interface HttpMcpProtocolOptions {
  /** `protocolMode` for servers whose connection sets none. Default `legacy` (decision D1). */
  defaultMode?: McpClientProtocolMode;
  /** Most `input_required` rounds one modern request may take. Default `DEFAULT_MRTR_MAX_ROUNDS`. */
  mrtrMaxRounds?: number;
  /**
   * D13 for legacy servers: true (the default) sends a request again after a
   * broken connection or a timeout only when it is safe (any method but
   * `tools/call`, and tools marked read-only or idempotent); false restores
   * earlier releases' behaviour of sending every request again. Modern
   * servers always follow the safe rule.
   */
  legacySafeReissue?: boolean;
  /** Observed eras by endpoint, shared across runs. Defaults to one cache per adapter. */
  eraCache?: McpEraCache;
  /** Where warnings go (tools left out for invalid `x-mcp-header` annotations). Default `console.warn`. */
  warn?: (message: string) => void;
}

export interface HttpMcpServerAdapterOptions {
  oauth?: McpOAuthTokenProvider;
  protocol?: HttpMcpProtocolOptions;
  /**
   * Tracing (only while it is on): each request carries the active span's trace context in its headers and
   * `params._meta`, and its session, version and id are recorded on the active MCP span.
   */
  trace?: RunInstrumentation;
}

/** What the adapter has observed about a server's protocol, for display. */
export interface HttpMcpObservedProtocol {
  era: McpProtocolEra;
  version?: string;
}

export class HttpMCPServerAdapter implements MCPServerAdapter {
  private readonly fallbackSessionCache = new Map<string, PreparedSession>();
  private oauth?: McpOAuthTokenProvider;
  private readonly protocol: HttpMcpProtocolOptions;
  /** Eras seen by `auto` probes and modern requests, by endpoint. */
  private readonly eraCache: McpEraCache;
  /**
   * Endpoints that rejected `initialize` with a modern error (modern-only
   * servers), kept apart from `eraCache` so a dual-era server that an `auto`
   * connection found modern stays legacy for `legacy` connections.
   */
  private readonly modernOnlyCache: McpEraCache;
  /**
   * Tool annotations from the last tools/list of each server (by session
   * cache key), so a new session (another run, an expired session, a call
   * without a listing first) still knows which tools are safe to send again.
   */
  private readonly rememberedAnnotations = new Map<string, Map<string, McpToolAnnotations | undefined>>();
  private readonly trace?: RunInstrumentation;

  constructor(options?: HttpMcpServerAdapterOptions) {
    this.oauth = options?.oauth;
    this.trace = options?.trace?.enabled ? options.trace : undefined;
    this.protocol = options?.protocol ?? {};
    this.eraCache = this.protocol.eraCache ?? new McpEraCache();
    this.modernOnlyCache = new McpEraCache();
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
        headers: { type: "object", additionalProperties: { type: "string" } },
        protocolMode: {
          type: "string",
          enum: ["auto", "legacy", "modern"],
          description: "MCP protocol era: legacy (initialize handshake), modern (2026-07-28) or auto. Default: the deployment's setting."
        }
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

  /**
   * The era (and modern version) this adapter last observed for the server's
   * endpoint, or undefined when it has not talked to it in a way that tells.
   */
  observedProtocol(config: MCPServerConfig): HttpMcpObservedProtocol | undefined {
    let key: string;
    try {
      key = httpEraCacheKey(normalizeEndpoint(config));
    } catch {
      return undefined;
    }
    const entry = this.modernOnlyCache.get(key) ?? this.eraCache.get(key);
    return entry ? { era: entry.era, ...(entry.version ? { version: entry.version } : {}) } : undefined;
  }

  private warn(message: string): void {
    try {
      (this.protocol.warn ?? ((text: string) => console.warn(text)))(message);
    } catch {
      // A failing log sink never breaks a call.
    }
  }

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
    options?: { forceNew?: boolean; forceEra?: McpProtocolEra }
  ): Promise<PreparedSession> {
    const key = buildSessionCacheKey(config);
    const cache = this.getCache(context);

    if (!options?.forceNew) {
      const cached = this.readSession(cache, key);
      if (cached) {
        return cached;
      }
    }

    const session = await this.prepareSession(config, context, options?.forceEra);
    this.writeSession(cache, key, session);
    return session;
  }

  /**
   * Run `operation` on the server's connection. When the connection's era
   * turns out wrong, it runs once more on a new connection of the right era.
   */
  private async withSession<T>(
    config: MCPServerConfig,
    context: MCPExecutionContext,
    operation: (session: PreparedSession) => Promise<T>,
    options?: { forceNew?: boolean }
  ): Promise<T> {
    const session = await this.getOrCreateSession(config, context, options);
    try {
      return await operation(session);
    } catch (error) {
      if (!(error instanceof McpEraMismatchError)) throw error;
      try {
        return await operation(await this.getOrCreateSession(config, context, { forceNew: true, forceEra: error.era }));
      } catch (retryError) {
        throw this.settledEraError(config, retryError);
      }
    }
  }

  /** A second era change in one operation: the server's answers disagree, so report what it said. */
  private settledEraError(config: MCPServerConfig, error: unknown): unknown {
    if (!(error instanceof McpEraMismatchError)) return error;
    return new Error(
      `MCP server '${serverNameOf(config)}' answered neither like an MCP ${MCP_MODERN_PROTOCOL_VERSIONS.join(", ")} server nor like an initialize-based one: ${error.detail}`
    );
  }

  /**
   * Open a connection. The era follows the connection's `protocolMode`:
   * `legacy` sends `initialize` (and switches to modern when a modern-only
   * server rejects it), `modern` sends modern requests only, and `auto` asks
   * `server/discover` first unless the endpoint's era is cached.
   */
  private async prepareSession(
    config: MCPServerConfig,
    context: MCPExecutionContext,
    forceEra?: McpProtocolEra
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
    const mode = resolveMcpClientProtocolMode(config.connection, this.protocol.defaultMode);
    const eraKey = httpEraCacheKey(endpoint);
    const cacheKey = buildSessionCacheKey(config);

    const buildHeaders = async (forceRefresh?: boolean) => {
      const headers: Record<string, string> = {
        ...(await buildAuthHeaders(config, context, this.oauth, forceRefresh ? { forceRefresh } : undefined))
      };
      for (const [key, value] of Object.entries(customHeaders)) {
        if (typeof value === "string" && key.trim()) {
          headers[key] = value;
        }
      }
      return headers;
    };

    // Shared by the probe and the connection opened after it, so a token refreshed during the probe is reused.
    let headers = await buildHeaders();
    const base = (era: McpProtocolEra, protocolVersion?: string): PreparedSession => {
      const session: PreparedSession = {
        era,
        mode,
        ...(protocolVersion ? { protocolVersion } : {}),
        endpoint,
        headers,
        refreshAuth: async () => {
          headers = await buildHeaders(true);
          session.headers = headers;
        },
        timeoutMs,
        createdAt: Date.now(),
        inFlight: new Map(),
        capabilities: {},
        capabilitiesKnown: era === "legacy",
        cacheKey,
        serverRequests: new Set()
      };
      return session;
    };

    const modernOnly = this.modernOnlyCache.get(eraKey);
    let era: McpProtocolEra;
    let version: string | undefined;
    if (forceEra) {
      era = forceEra;
      version = modernOnly?.version ?? this.eraCache.get(eraKey)?.version;
    } else if (mode === "modern") {
      era = "modern";
      version = this.eraCache.get(eraKey)?.version ?? modernOnly?.version;
    } else if (modernOnly) {
      era = "modern";
      version = modernOnly.version;
    } else if (mode === "auto") {
      const cached = this.eraCache.get(eraKey);
      if (cached) {
        era = cached.era;
        version = cached.version;
      } else {
        const probed = await this.probeEra(base("modern", MCP_CLIENT_MODERN_PROTOCOL_VERSION), config, context, eraKey);
        if (probed.era === "modern") return probed.session;
        era = "legacy";
      }
    } else {
      era = "legacy";
    }

    if (era === "modern") {
      return base("modern", version ?? MCP_CLIENT_MODERN_PROTOCOL_VERSION);
    }
    return this.openLegacySession(base("legacy"), config, context, buildHeaders, eraKey);
  }

  /**
   * `auto` mode: ask the server with a modern `server/discover`. A discover
   * result or a recognised modern error means modern (and the capabilities
   * come for free); any other answer about the protocol means legacy.
   * Answers about credentials, load or server errors decide nothing: the
   * connection goes on as legacy without caching, and `initialize` reports
   * the problem as it always has.
   */
  private async probeEra(
    session: PreparedSession,
    config: MCPServerConfig,
    context: MCPExecutionContext,
    eraKey: string
  ): Promise<{ era: "modern"; session: PreparedSession } | { era: "legacy" }> {
    const legacy = (cache: boolean): { era: "legacy" } => {
      if (cache) this.eraCache.set(eraKey, "legacy");
      return { era: "legacy" };
    };
    const modern = (version: string, discover?: ReturnType<typeof parseDiscoverResult>) => {
      session.protocolVersion = version;
      if (discover) {
        session.capabilities = discover.capabilities;
        session.capabilitiesKnown = true;
      }
      this.eraCache.set(eraKey, "modern", version);
      return { era: "modern" as const, session };
    };
    let supported: string[] | undefined;
    for (let attempt = 0; attempt < 2 && supported === undefined; attempt += 1) {
      const carrier = mcpTraceCarrier(this.trace, config);
      const params = this.outgoingParams(session, {}, context, carrier);
      try {
        // A short probe without retries: a legacy server that ignores the method must not hold up initialize.
        const { response } = await postRpc(
          session.endpoint,
          { jsonrpc: "2.0", id: nextRequestId("server-discover"), method: "server/discover", params },
          mergeHeaders(session.headers, {
            ...buildMcpStandardHeaders(session.protocolVersion as string, "server/discover", params),
            ...traceContextHeaders(carrier)
          }),
          Math.min(session.timeoutMs, ERA_PROBE_TIMEOUT_MS),
          { ...(context.signal ? { signal: context.signal } : {}), maxRetries: 0 }
        );
        const discover = parseDiscoverResult(response.result);
        if (!discover) return legacy(true);
        const choice = chooseMcpProtocolVersion(discover.supportedVersions, { allowLegacy: true });
        if (choice.era === "modern") return modern(choice.version, discover);
        if (choice.era === "legacy") return legacy(true);
        supported = discover.supportedVersions;
      } catch (error) {
        if (isCanceledError(error)) throw error;
        if (error instanceof McpHttpError) {
          if (error.status === 401 && authTypeOf(config) === "oauth" && attempt === 0) {
            await session.refreshAuth();
            continue;
          }
          const verdict = classifyHttpEraResponse(error.status, error.bodyText);
          if (verdict.era === "legacy") return legacy(true);
          if (verdict.era === "unknown") return legacy(false);
          if (verdict.error?.kind === "unsupported_version" && chooseMcpProtocolVersion(verdict.error.supported, { allowLegacy: true }).era === "none") {
            supported = verdict.error.supported;
            continue;
          }
          return this.modernFromError(verdict.error, modern, legacy);
        }
        if (error instanceof McpJsonRpcError) {
          const recognised = modernErrorOf(error);
          // Servers on 2026-07-28 must implement server/discover: "method not found" at HTTP 200 is a legacy server.
          if (!recognised) return legacy(error.code === JSON_RPC_METHOD_NOT_FOUND);
          if (recognised.kind === "unsupported_version" && chooseMcpProtocolVersion(recognised.supported, { allowLegacy: true }).era === "none") {
            supported = recognised.supported;
            continue;
          }
          return this.modernFromError(recognised, modern, legacy);
        }
        // Connection refused and the like: initialize would fail the same way, with the error users know.
        if (error instanceof TypeError && failedBeforeSending(error)) throw error;
        // No answer in time, an empty or closed stream, a body that is not JSON-RPC: nothing is learnt.
        return legacy(false);
      }
    }
    if (supported !== undefined) throw this.noMutualVersionError(config, supported);
    return legacy(false);
  }

  /** The outcome of a probe answered with a modern error: modern (renegotiated when -32022 names a version). */
  private modernFromError<M, L>(
    error: McpModernProtocolError | undefined,
    modern: (version: string) => M,
    legacy: (cache: boolean) => L
  ): M | L {
    if (error?.kind !== "unsupported_version") return modern(MCP_CLIENT_MODERN_PROTOCOL_VERSION);
    const choice = chooseMcpProtocolVersion(error.supported, { allowLegacy: true });
    // The caller handles "no shared version" before calling.
    return choice.era === "modern" ? modern(choice.version) : legacy(true);
  }

  private noMutualVersionError(config: MCPServerConfig, supported: readonly string[]): McpJsonRpcError {
    return new McpJsonRpcError(
      `MCP server '${serverNameOf(config)}' supports protocol versions ${supported.slice(0, 10).map((version) => safeText(version, 40)).join(", ") || "(none listed)"}, and this client speaks ${MCP_MODERN_PROTOCOL_VERSIONS.join(", ")} or the initialize-based versions.`,
      -32022,
      { supported: supported.slice(0, 50) }
    );
  }

  /**
   * The legacy handshake, unchanged from earlier releases: `initialize`
   * (refreshing an OAuth token once on 401), then `notifications/initialized`.
   * A server that rejects `initialize` with a modern error is modern-only:
   * the connection becomes modern instead (fall-forward, decision D1).
   */
  private async openLegacySession(
    session: PreparedSession,
    config: MCPServerConfig,
    context: MCPExecutionContext,
    buildHeaders: (forceRefresh?: boolean) => Promise<Record<string, string>>,
    eraKey: string
  ): Promise<PreparedSession> {
    const { endpoint, timeoutMs } = session;
    let headers = session.headers;
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

    const fallForward = (error: unknown): PreparedSession | null => {
      if (!(error instanceof McpHttpError)) return null;
      if (session.mode === "modern" || !initializeRejectionIsModern({ transport: "http", status: error.status, bodyText: error.bodyText })) {
        return null;
      }
      const recognised = parseMcpModernError(jsonRpcErrorInBody(error.bodyText));
      let version: string = MCP_CLIENT_MODERN_PROTOCOL_VERSION;
      if (recognised?.kind === "unsupported_version") {
        const choice = chooseMcpProtocolVersion(recognised.supported);
        if (choice.era !== "modern") throw this.noMutualVersionError(config, recognised.supported);
        version = choice.version;
      }
      this.modernOnlyCache.set(eraKey, "modern", version);
      session.era = "modern";
      session.protocolVersion = version;
      session.headers = headers;
      session.capabilities = {};
      session.capabilitiesKnown = false;
      return session;
    };

    // initialize carries trace context in its headers only (for this request; the session's headers never keep it).
    const traceHeaders = traceContextHeaders(mcpTraceCarrier(this.trace, config));
    let initialize: Awaited<ReturnType<typeof postRpc>>;
    try {
      initialize = await postRpc(endpoint, initializePayload, mergeHeaders(headers, traceHeaders), timeoutMs, { signal: context.signal });
    } catch (error) {
      // An OAuth access token the server rejects is refreshed once before giving up.
      if (error instanceof McpHttpError && error.status === 401 && authTypeOf(config) === "oauth") {
        headers = await buildHeaders(true);
        try {
          initialize = await postRpc(endpoint, initializePayload, mergeHeaders(headers, traceHeaders), timeoutMs, { signal: context.signal });
        } catch (retryError) {
          const modern = fallForward(retryError);
          if (modern) return modern;
          throw retryError;
        }
      } else {
        const modern = fallForward(error);
        if (modern) return modern;
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

    session.headers = headers;
    session.capabilities = capabilities;
    session.capabilitiesKnown = true;
    return session;
  }

  /**
   * The params a request goes out with: the one place request `_meta` is
   * written, for every request with an id in both eras (`trackedRpc` and the
   * `auto` probe call it; `initialize` and notifications do not carry
   * `_meta`). Modern requests get their protocol keys here, merged with
   * `withRequestMeta` so a progress token and any other key are kept; legacy
   * params get no protocol keys. Trace context (`traceparent`, `tracestate`,
   * `baggage`) is merged the same way for either era, when tracing gave a
   * carrier for the request.
   */
  private outgoingParams(
    session: PreparedSession,
    params: Record<string, unknown>,
    context: MCPExecutionContext,
    carrier?: TraceCarrier
  ): Record<string, unknown> {
    const withProtocol =
      session.era === "modern"
        ? withRequestMeta(params, modernRequestMetaFor(context, session.protocolVersion ?? MCP_CLIENT_MODERN_PROTOCOL_VERSION))
        : params;
    return withTraceContext(withProtocol, carrier);
  }

  /** D13 — whether a tool call may be sent again after a broken connection: read-only or idempotent tools only. */
  private toolReissueSafe(session: PreparedSession, toolName: string, config: MCPServerConfig): boolean {
    const annotations =
      (session.toolAnnotations ?? this.rememberedAnnotations.get(session.cacheKey))?.get(toolName) ??
      config.manualTools?.find((tool) => tool.name === toolName)?.annotations;
    if (!annotations) return false;
    const hints = effectiveToolHints(annotations);
    return hints.readOnly || hints.idempotent;
  }

  /** Whether the safe re-issue rule applies to this connection (always for modern; legacy unless turned off). */
  private safeReissueApplies(session: PreparedSession): boolean {
    return session.era === "modern" || this.protocol.legacySafeReissue !== false;
  }

  private reissueMode(session: PreparedSession, safe: boolean): ReissueMode {
    if (session.era === "modern") return safe ? "retry_broken_stream" : "fail";
    if (!this.safeReissueApplies(session)) return "retry";
    return safe ? "retry" : "fail";
  }

  /**
   * Send `notifications/cancelled` for one in-flight request (at most once),
   * then abort its fetch. The notice is best-effort and short: a server that
   * does not answer it does not hold up cancellation. On modern servers
   * closing the response stream is the cancellation, so no notice is sent.
   */
  private async cancelRequest(session: PreparedSession, request: InFlightRequest, reason: string): Promise<void> {
    if (request.cancelled) return;
    request.cancelled = true;
    // The spec forbids cancelling initialize.
    if (session.era === "legacy" && request.method !== "initialize") {
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
    options: {
      toolName?: string;
      onMessage?: (message: JsonRpcResponse) => void;
      timeoutMs?: number;
      /** Headers added to the session's for this request (modern standard and `Mcp-Param-*` headers). */
      headers?: Record<string, string>;
      reissue?: ReissueMode;
    } = {}
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
    const carrier = mcpTraceCarrier(this.trace, config);
    const traceHeaders = traceContextHeaders(carrier);
    const extraHeaders = options.headers ? { ...options.headers, ...traceHeaders } : traceHeaders;
    annotateMcpRequest(this.trace, {
      ...(session.era === "modern" ? {} : { sessionId: session.headers["mcp-session-id"] }),
      protocolVersion: session.era === "modern" ? session.protocolVersion : session.headers["mcp-protocol-version"],
      requestId: payload.id
    });
    try {
      return await postRpc(
        session.endpoint,
        { jsonrpc: "2.0", ...payload, params: this.outgoingParams(session, payload.params, context, carrier) },
        Object.keys(extraHeaders).length > 0 ? mergeHeaders(session.headers, extraHeaders) : session.headers,
        options.timeoutMs ?? session.timeoutMs,
        {
          ...(signal ? { signal } : {}),
          ...(options.reissue ? { reissue: options.reissue } : {}),
          ...(session.era === "modern" ? { newIdPerAttempt: true } : {}),
          onMessage,
          track: (controller) => {
            entry = { id: payload.id, method: payload.method, controller, cancelled: false };
            session.inFlight.set(payload.id, entry);
            return () => {
              session.inFlight.delete(payload.id);
            };
          }
        }
      );
    } catch (error) {
      annotateMcpError(this.trace, error);
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
   * One request on a modern connection: `_meta`, the standard headers and
   * any `Mcp-Param-*` headers, a new JSON-RPC id per attempt. Handles what a
   * modern server may answer at the protocol level: -32022 (pick a mutual
   * version and send again, once), an OAuth 401 (refresh once), -32021
   * (missing client capability), -32601 on 404, and answers that show the
   * server is not modern after all (`McpEraMismatchError`). Returns the
   * JSON-RPC result.
   */
  private async modernSend(
    session: PreparedSession,
    method: string,
    params: Record<string, unknown>,
    context: MCPExecutionContext,
    config: MCPServerConfig,
    options: {
      safe: boolean;
      toolName?: string;
      onMessage?: (message: JsonRpcResponse) => void;
      timeoutMs?: number;
      paramHeaders?: Record<string, string>;
    }
  ): Promise<unknown> {
    let renegotiated = false;
    let refreshed = false;
    for (;;) {
      const version = session.protocolVersion ?? MCP_CLIENT_MODERN_PROTOCOL_VERSION;
      try {
        const { response } = await this.trackedRpc(
          session,
          { id: nextRequestId(method.replace(/\//g, "-")), method, params },
          context,
          config,
          {
            ...(options.toolName ? { toolName: options.toolName } : {}),
            ...(options.onMessage ? { onMessage: options.onMessage } : {}),
            ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
            // Mcp-Name mirrors params.name or params.uri, which the _meta merge in trackedRpc leaves alone.
            headers: { ...buildMcpStandardHeaders(version, method, params), ...(options.paramHeaders ?? {}) },
            reissue: this.reissueMode(session, options.safe)
          }
        );
        this.eraCache.set(httpEraCacheKey(session.endpoint), "modern", version);
        session.modernConfirmed = true;
        return response.result;
      } catch (error) {
        if (isCanceledError(error)) throw error;
        const recognised = modernErrorOf(error);
        if (recognised?.kind === "unsupported_version") {
          const choice = chooseMcpProtocolVersion(recognised.supported, { allowLegacy: session.mode !== "modern" });
          if (!renegotiated && choice.era === "modern" && choice.version !== version) {
            renegotiated = true;
            session.protocolVersion = choice.version;
            continue;
          }
          if (choice.era === "legacy") {
            this.forgetEra(session);
            throw new McpEraMismatchError("legacy", "The server asked for an initialize-based protocol version.", recognised.message);
          }
          throw this.noMutualVersionError(config, recognised.supported);
        }
        if (recognised?.kind === "missing_client_capability") {
          const needed = Object.keys(recognised.requiredCapabilities);
          throw new McpMissingClientCapabilityError(
            `MCP server '${serverNameOf(config)}' needs the client capability ${needed.length > 0 ? needed.join(", ") : "it named"} for ${method}${
              needed.includes("sampling") ? "; attach a model to the call and allow sampling for the server" : ""
            }. ${recognised.message}`.trim(),
            recognised.code,
            { requiredCapabilities: recognised.requiredCapabilities }
          );
        }
        if (recognised?.kind === "header_mismatch") {
          throw new McpJsonRpcError(recognised.message || "Header mismatch", recognised.code);
        }
        if (error instanceof McpHttpError) {
          if (error.status === 401 && authTypeOf(config) === "oauth" && !refreshed) {
            refreshed = true;
            await session.refreshAuth();
            continue;
          }
          const verdict = classifyHttpEraResponse(error.status, error.bodyText);
          if (verdict.era === "modern" && verdict.methodNotFound) {
            const body = jsonRpcErrorInBody(error.bodyText);
            throw new McpJsonRpcError(
              typeof body?.message === "string" && body.message ? body.message : `Method not found: ${method}`,
              JSON_RPC_METHOD_NOT_FOUND,
              body?.data
            );
          }
          // Era detection reads 4xx answers only while the connection's era is unproven. Once a modern request
          // succeeded, and whenever the body is a JSON-RPC invalid-params error (what 2026-07-28 servers answer for
          // a bad request), the server's error is reported as it is.
          const body = jsonRpcErrorInBody(error.bodyText);
          const plainError = session.modernConfirmed || (body !== null && body.code === JSON_RPC_INVALID_PARAMS);
          if (verdict.era === "legacy" && plainError && body && typeof body.code === "number") {
            throw new McpJsonRpcError(
              typeof body.message === "string" && body.message ? safeText(body.message, 500) : `MCP HTTP ${error.status}`,
              body.code,
              body.data
            );
          }
          if (verdict.era === "legacy" && !plainError) {
            this.forgetEra(session);
            if (session.mode !== "modern") {
              throw new McpEraMismatchError("legacy", "The server answered like an initialize-based server.", error.message);
            }
            throw new Error(
              `MCP server '${serverNameOf(config)}' does not speak MCP ${MCP_MODERN_PROTOCOL_VERSIONS.join(", ")} (it answered HTTP ${error.status}). Set its protocol to Legacy or Auto. ${error.message}`
            );
          }
        }
        throw error;
      }
    }
  }

  /** Forget what the caches say about the connection's endpoint, so the next connection checks again. */
  private forgetEra(session: PreparedSession): void {
    const key = httpEraCacheKey(session.endpoint);
    this.eraCache.invalidate(key);
    this.modernOnlyCache.invalidate(key);
  }

  /**
   * A modern request and its result: for `tools/call`, `resources/read` and
   * `prompts/get` through the multi round-trip engine (answering the
   * server's input requests with the same handlers legacy servers get, and
   * sending the request again with a new id each round); for other methods
   * the result's `resultType` is checked.
   */
  private async modernCall(
    session: PreparedSession,
    method: string,
    params: Record<string, unknown>,
    context: MCPExecutionContext,
    config: MCPServerConfig,
    options: {
      safe: boolean;
      toolName?: string;
      onMessage?: (message: JsonRpcResponse) => void;
      timeoutMs?: number;
      paramHeadersFor?: (params: Record<string, unknown>) => Record<string, string>;
      /** Called when the server answers -32020 (HeaderMismatch); return true to send the request again once. */
      onHeaderMismatch?: () => Promise<boolean>;
    }
  ): Promise<Record<string, unknown>> {
    const target = options.toolName ?? (typeof params.name === "string" ? params.name : undefined);
    let rounds = 0;
    const send = async (roundParams: Record<string, unknown>): Promise<unknown> => {
      rounds += 1;
      return await traceMcpRound(
        this.trace,
        { method, ...(target ? { target } : {}), round: rounds, serverId: config.registryServerId ?? config.serverId },
        () => sendRound(roundParams)
      );
    };
    const sendRound = async (roundParams: Record<string, unknown>): Promise<unknown> => {
      let retried = false;
      for (;;) {
        try {
          return await this.modernSend(session, method, roundParams, context, config, {
            safe: options.safe,
            ...(options.toolName ? { toolName: options.toolName } : {}),
            ...(options.onMessage ? { onMessage: options.onMessage } : {}),
            ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
            ...(options.paramHeadersFor ? { paramHeaders: options.paramHeadersFor(roundParams) } : {})
          });
        } catch (error) {
          // The server rejected the headers before acting on the request, so sending it again is safe.
          if (!retried && error instanceof McpJsonRpcError && error.code === MCP_ERROR_HEADER_MISMATCH && options.onHeaderMismatch) {
            retried = true;
            if (await options.onHeaderMismatch()) continue;
          }
          throw error;
        }
      }
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

  /**
   * Phase 10.5 — messages other than the awaited response on a response
   * stream: progress and `list_changed` notifications, and the requests a
   * server makes of the client (`ping`, `elicitation/create`,
   * `sampling/createMessage`), whose answers are posted back on the session.
   * The request's timeout is paused while an answer is being produced, so a
   * person can take their time with an elicitation. Modern servers never
   * send requests on a response stream (they ask through `input_required`),
   * so a request there is ignored.
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
        if (session.era === "modern") return;
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
   * sessions (sending `notifications/cancelled` first on legacy sessions)
   * and forget the sessions. Called when an agent or MCP Tool node ends or
   * is aborted.
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
    let tools: MCPToolDefinition[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_LIST_PAGES; page += 1) {
      const params = cursor ? { cursor } : {};
      const result =
        session.era === "modern"
          ? await this.modernCall(session, "tools/list", params, context, config, { safe: true })
          : toRecord(
              (await this.trackedRpc(session, { id: nextRequestId("tools-list"), method: "tools/list", params }, context, config)).response
                .result
            );
      tools.push(...normalizeDiscoveredTools(config.serverId, config.label ?? this.definition.label, result.tools));
      cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    if (session.era === "modern") {
      // Streamable HTTP clients must leave out tools whose x-mcp-header annotations break the rules.
      const partition = partitionToolsByHeaderAnnotations(tools);
      tools = partition.kept;
      session.paramHeaders = partition.headersByTool;
      session.rejectedTools = new Map(partition.rejected.map((rejection) => [rejection.name, rejection.reason]));
      for (const rejection of partition.rejected) {
        this.warn(
          `MCP server '${safeText(serverNameOf(config))}': tool '${safeText(rejection.name)}' left out of the tool list: its x-mcp-header annotation ${safeText(rejection.reason, 300)}.`
        );
      }
    }
    session.outputSchemas = new Map(tools.map((tool) => [tool.name, tool.outputSchema]));
    session.toolAnnotations = new Map(tools.map((tool) => [tool.name, tool.annotations]));
    this.rememberedAnnotations.delete(session.cacheKey);
    this.rememberedAnnotations.set(session.cacheKey, session.toolAnnotations);
    while (this.rememberedAnnotations.size > MAX_REMEMBERED_TOOL_LISTS) {
      const oldest = this.rememberedAnnotations.keys().next().value;
      if (oldest === undefined) break;
      this.rememberedAnnotations.delete(oldest);
    }
    return tools;
  }

  async discoverTools(config: MCPServerConfig, context: MCPExecutionContext): Promise<MCPToolDefinition[]> {
    return this.withSession(config, context, (session) => this.listAllTools(session, config, context), { forceNew: true });
  }

  /** The tool's outputSchema, listing the tools once per session when needed. Unknown → undefined. */
  private async outputSchemaFor(
    session: PreparedSession,
    toolName: string,
    config: MCPServerConfig,
    context: MCPExecutionContext
  ): Promise<Record<string, unknown> | undefined> {
    await this.ensureToolList(session, config, context);
    return session.outputSchemas?.get(toolName);
  }

  /** List the tools once per session; a server that cannot list them still gets its calls. */
  private async ensureToolList(session: PreparedSession, config: MCPServerConfig, context: MCPExecutionContext): Promise<void> {
    if (session.outputSchemas) return;
    try {
      await this.listAllTools(session, config, context);
    } catch (error) {
      if (isCanceledError(error) || error instanceof McpEraMismatchError) throw error;
      // Servers that cannot list tools still get their calls; results are just not validated.
      session.outputSchemas = new Map();
    }
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
    const params = {
      name: toolName,
      arguments: args,
      ...(progressToken ? { _meta: { progressToken } } : {})
    };
    // Phase 10.7 — a per-call timeout from the server's runtime limits.
    const timeoutMs =
      typeof context.callTimeoutMs === "number" && context.callTimeoutMs >= 1 ? Math.floor(context.callTimeoutMs) : undefined;

    if (session.era === "modern") {
      // x-mcp-header: the tool's annotations decide which arguments travel in headers, so the tools are listed first.
      await this.ensureToolList(session, config, context);
      const rejected = session.rejectedTools?.get(toolName);
      if (rejected) {
        throw new McpJsonRpcError(
          `MCP tool '${toolName}' cannot be called: its x-mcp-header annotation ${rejected}, so it is left out of the server's tool list.`,
          undefined
        );
      }
      const result = await this.modernCall(session, "tools/call", params, context, config, {
        safe: this.toolReissueSafe(session, toolName, config),
        toolName,
        ...(onMessage ? { onMessage } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        paramHeadersFor: (roundParams) => buildMcpParamHeaders(session.paramHeaders?.get(toolName) ?? [], roundParams.arguments),
        // The tool's inputSchema may have changed: list the tools again and rebuild the headers.
        onHeaderMismatch: async () => {
          await this.listAllTools(session, config, context);
          return !session.rejectedTools?.has(toolName);
        }
      });
      return { result };
    }

    const result = await this.trackedRpc(session, { id, method: "tools/call", params }, context, config, {
      toolName,
      ...(onMessage ? { onMessage } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      reissue: this.reissueMode(session, this.toolReissueSafe(session, toolName, config))
    });
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
      const params = cursor ? { cursor } : {};
      const result =
        session.era === "modern"
          ? await this.modernCall(session, method, params, context, config, { safe: true })
          : toRecord(
              (await this.trackedRpc(session, { id: nextRequestId(method.replace(/\//g, "-")), method, params }, context, config)).response
                .result
            );
      if (Array.isArray(result[key])) items.push(...(result[key] as unknown[]));
      cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return items;
  }

  /**
   * The server's capabilities: from `initialize` (legacy) or `server/discover`
   * (modern, asked once per connection). A modern server that cannot answer
   * `server/discover` counts as declaring nothing optional.
   */
  private async capabilitiesOf(session: PreparedSession, config: MCPServerConfig, context: MCPExecutionContext): Promise<McpServerCapabilities> {
    if (session.capabilitiesKnown) return session.capabilities;
    try {
      const discover = parseDiscoverResult(await this.modernCall(session, "server/discover", {}, context, config, { safe: true }));
      session.capabilities = discover?.capabilities ?? {};
    } catch (error) {
      // Only "cannot answer discover" counts as declaring nothing; version and capability problems are real errors.
      if (!(error instanceof McpJsonRpcError) || error instanceof McpMissingClientCapabilityError || error.code === -32022) throw error;
      session.capabilities = {};
    }
    session.capabilitiesKnown = true;
    return session.capabilities;
  }

  async describeServer(config: MCPServerConfig, context: MCPExecutionContext): Promise<McpServerCapabilities> {
    return this.withSession(config, context, (session) => this.capabilitiesOf(session, config, context));
  }

  async listResources(config: MCPServerConfig, context: MCPExecutionContext): Promise<McpResource[]> {
    return this.withSession(config, context, async (session) => {
      if (!(await this.capabilitiesOf(session, config, context)).resources) return [];
      return normalizeResources(await this.listAllPages(session, "resources/list", "resources", config, context));
    });
  }

  async listResourceTemplates(config: MCPServerConfig, context: MCPExecutionContext): Promise<McpResourceTemplate[]> {
    return this.withSession(config, context, async (session) => {
      if (!(await this.capabilitiesOf(session, config, context)).resources) return [];
      return normalizeResourceTemplates(
        await this.listAllPages(session, "resources/templates/list", "resourceTemplates", config, context)
      );
    });
  }

  async readResource(
    uri: string,
    config: MCPServerConfig,
    context: MCPExecutionContext,
    options: McpReadResourceOptions = {}
  ): Promise<McpResourceReadResult> {
    return this.withSession(config, context, async (session) => {
      let result: unknown;
      if (session.era === "modern") {
        try {
          result = await this.modernCall(session, "resources/read", { uri }, context, config, { safe: true });
        } catch (error) {
          // 2026-07-28 answers "resource not found" with -32602; earlier servers used -32002, which clients still accept.
          if (
            error instanceof McpJsonRpcError &&
            !(error instanceof McpMissingClientCapabilityError) &&
            (error.code === JSON_RPC_INVALID_PARAMS || error.code === MCP_ERROR_LEGACY_RESOURCE_NOT_FOUND)
          ) {
            throw new McpJsonRpcError(`MCP resource not found: ${uri.slice(0, 500)} (${error.message})`, error.code, error.data);
          }
          throw error;
        }
      } else {
        const read = await this.trackedRpc(
          session,
          { id: nextRequestId("resources-read"), method: "resources/read", params: { uri } },
          context,
          config
        );
        result = read.response.result;
      }
      return normalizeResourceReadResult(uri, result, options.maxBytes ?? DEFAULT_RESOURCE_MAX_BYTES);
    });
  }

  async listPrompts(config: MCPServerConfig, context: MCPExecutionContext): Promise<McpPrompt[]> {
    return this.withSession(config, context, async (session) => {
      if (!(await this.capabilitiesOf(session, config, context)).prompts) return [];
      return normalizePrompts(await this.listAllPages(session, "prompts/list", "prompts", config, context));
    });
  }

  async getPrompt(
    name: string,
    args: Record<string, string>,
    config: MCPServerConfig,
    context: MCPExecutionContext
  ): Promise<McpPromptGetResult> {
    return this.withSession(config, context, async (session) => {
      const params = { name, ...(Object.keys(args).length > 0 ? { arguments: args } : {}) };
      if (session.era === "modern") {
        return normalizePromptGetResult(name, await this.modernCall(session, "prompts/get", params, context, config, { safe: true }));
      }
      const got = await this.trackedRpc(session, { id: nextRequestId("prompts-get"), method: "prompts/get", params }, context, config);
      return normalizePromptGetResult(name, got.response.result);
    });
  }

  /**
   * Whether a failed call may be sent again on a new connection. Legacy
   * sessions: yes, as before (the session may have expired), except, under
   * the safe re-issue rule, a call to a tool not marked read-only or
   * idempotent whose outcome is unknown (no answer arrived). Modern
   * connections have no session to renew, so only an era change sends a
   * call again (handled before this).
   */
  private mayRetryCall(error: unknown, session: PreparedSession, toolName: string, config: MCPServerConfig): boolean {
    if (isCanceledError(error) || error instanceof McpOutcomeUnknownError) return false;
    if (session.era === "modern") return false;
    if (this.safeReissueApplies(session) && error instanceof McpTimeoutError && !this.toolReissueSafe(session, toolName, config)) {
      return false;
    }
    return true;
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
        if (error instanceof McpEraMismatchError) {
          // The server did not act on the rejected request; it goes out again in the server's era.
          session = await this.getOrCreateSession(config, context, { forceNew: true, forceEra: error.era });
          try {
            response = await this.callTool(session, toolName, args, config, context);
          } catch (retryError) {
            throw this.settledEraError(config, retryError);
          }
        } else {
          if (!this.mayRetryCall(error, session, toolName, config)) throw error;
          // Retry once with a fresh session if the cached session is no longer
          // valid; an OAuth server answering 401 gets a refreshed token first.
          const unauthorized = error instanceof McpHttpError && error.status === 401 && authTypeOf(config) === "oauth";
          if (unauthorized && config.registryServerId && this.oauth) {
            await this.oauth.getAccessToken(config.registryServerId, tokenOptionsFor(config, { forceRefresh: true }));
          }
          session = await this.getOrCreateSession(config, context, { forceNew: true });
          response = await this.callTool(session, toolName, args, config, context);
        }
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
