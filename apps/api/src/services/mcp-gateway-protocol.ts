/**
 * Phase 10.4 — the JSON-RPC 2.0 and MCP pieces of the gateway endpoint:
 * protocol versions, message classification, error codes, list cursors and
 * how tool outcomes become `tools/call` results.
 */

/** Newest first. The first entry is offered when a client asks for a version we do not speak. */
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export type McpProtocolVersion = (typeof MCP_SUPPORTED_PROTOCOL_VERSIONS)[number];
export const MCP_LATEST_PROTOCOL_VERSION: McpProtocolVersion = MCP_SUPPORTED_PROTOCOL_VERSIONS[0];
/** What the transport assumes when a client sends no MCP-Protocol-Version header and none was negotiated. */
export const MCP_DEFAULT_TRANSPORT_VERSION: McpProtocolVersion = "2025-03-26";

/** JSON-RPC batches exist only in the 2025-03-26 revision; later revisions removed them. */
export function versionAllowsBatches(version: McpProtocolVersion): boolean {
  return version === "2025-03-26";
}

export function isSupportedProtocolVersion(value: unknown): value is McpProtocolVersion {
  return typeof value === "string" && (MCP_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(value);
}

/** The client's version when we support it, otherwise our latest (the client then decides). */
export function negotiateProtocolVersion(requested: unknown): McpProtocolVersion {
  return isSupportedProtocolVersion(requested) ? requested : MCP_LATEST_PROTOCOL_VERSION;
}

export const JSON_RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** Implementation-defined server error used for "request cancelled". */
  requestCancelled: -32800,
  /**
   * Phase 10.7 — implementation-defined server error: the call was refused
   * before it reached the upstream server (rate limit, concurrency cap or an
   * open circuit breaker). `data.retryAfterMs` says when to try again.
   */
  retryLater: -32029,
  /**
   * Phase 12.4 — implementation-defined server error: a tool policy rule requires a person to approve this call.
   * `data.approvalRequestId` names the request; once it is approved the identical call (same tool, same arguments)
   * can be retried once within the approval window.
   */
  approvalPending: -32030
} as const;

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: Record<string, unknown>;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export type ClassifiedMessage =
  | { kind: "request"; message: JsonRpcRequest }
  | { kind: "notification"; message: JsonRpcNotification }
  /** A client's answer to a server request; this server sends none, so they are ignored. */
  | { kind: "response" }
  | { kind: "invalid"; id: JsonRpcId | null; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isValidId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

export function classifyMessage(raw: unknown): ClassifiedMessage {
  if (!isRecord(raw) || raw.jsonrpc !== "2.0") {
    const id = isRecord(raw) && isValidId(raw.id) ? raw.id : null;
    return { kind: "invalid", id, reason: "Not a JSON-RPC 2.0 message" };
  }
  const hasId = "id" in raw && raw.id !== undefined;
  if (typeof raw.method === "string") {
    if (raw.params !== undefined && !isRecord(raw.params)) {
      return { kind: "invalid", id: hasId && isValidId(raw.id) ? raw.id : null, reason: "params must be an object" };
    }
    const params = raw.params as Record<string, unknown> | undefined;
    if (!hasId) {
      return { kind: "notification", message: { jsonrpc: "2.0", method: raw.method, ...(params ? { params } : {}) } };
    }
    if (!isValidId(raw.id)) {
      return { kind: "invalid", id: null, reason: "id must be a string or a number" };
    }
    return { kind: "request", message: { jsonrpc: "2.0", id: raw.id, method: raw.method, ...(params ? { params } : {}) } };
  }
  if (hasId && ("result" in raw || "error" in raw)) {
    return { kind: "response" };
  }
  return { kind: "invalid", id: hasId && isValidId(raw.id) ? raw.id : null, reason: "Missing method" };
}

export function rpcResult(id: JsonRpcId, result: Record<string, unknown>): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

export function rpcError(id: JsonRpcId | null, code: number, message: string, data?: unknown): JsonRpcFailure {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

/** Key for in-flight bookkeeping; `1` and `"1"` are different JSON-RPC ids. */
export function requestKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

export const TOOLS_PAGE_SIZE = 100;

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), "utf8").toString("base64url");
}

/** Offset from a cursor this server issued; null when the cursor is not one. */
export function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== "string" || !cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: unknown };
    return typeof parsed.o === "number" && Number.isInteger(parsed.o) && parsed.o >= 0 ? parsed.o : null;
  } catch {
    return null;
  }
}

export interface McpCallToolResult extends Record<string, unknown> {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function stringifyOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === undefined || output === null) return "";
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

/** A successful tool outcome: text content always, structured content when the output is an object. */
export function toolSuccess(output: unknown, meta?: Record<string, unknown>): McpCallToolResult {
  return {
    content: [{ type: "text", text: stringifyOutput(output) }],
    ...(isRecord(output) ? { structuredContent: output } : {}),
    ...(meta ? { _meta: meta } : {})
  };
}

/** A tool-level failure: reported to the model as a result, not a protocol error. */
export function toolError(message: string, meta?: Record<string, unknown>): McpCallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    ...(meta ? { _meta: meta } : {})
  };
}

/** `Accept` must allow JSON (or SSE); absent and wildcard headers are accepted. */
export function acceptAllows(acceptHeader: string | undefined, type: "application/json" | "text/event-stream"): boolean {
  if (!acceptHeader) return type === "application/json";
  const entries = acceptHeader.split(",").map((entry) => entry.split(";")[0]!.trim().toLowerCase());
  return entries.some((entry) => entry === type || entry === "*/*" || entry === `${type.split("/")[0]}/*`);
}
