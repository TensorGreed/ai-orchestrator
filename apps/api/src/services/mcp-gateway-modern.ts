/**
 * MCP 2026-07-28 at the gateway: the pieces `/mcp/:toolset` needs to serve
 * modern clients next to legacy ones on the same endpoint (a "dual-era
 * server"), kept out of the routes file.
 *
 * A request is modern when it is a single JSON-RPC message sent with a
 * modern `MCP-Protocol-Version` header, or a single message (not
 * `initialize`) whose `params._meta` carries
 * `io.modelcontextprotocol/protocolVersion`. Everything else follows the
 * legacy session path unchanged. Modern requests are only served when
 * MCP_GATEWAY_MODERN_PROTOCOL is `on`; with it `off` (the default) they get
 * the legacy answer for a request without a session, which dual-era clients
 * read as "legacy server" and fall back to `initialize`.
 *
 * Trace context keys in `_meta` (`traceparent`, `tracestate`, `baggage`) are
 * left alone here: not validated, not stripped, never part of era detection.
 */
import {
  MCP_LEGACY_PROTOCOL_VERSIONS,
  MCP_MODERN_PROTOCOL_VERSIONS,
  McpSchemaTooDeepError,
  inspectRequestMeta,
  isMcpSpecReservedErrorCode,
  missingRequestMetaError,
  headerMismatchError,
  MCP_HEADER_PROTOCOL_VERSION,
  stripMcpHeaderAnnotations,
  unsupportedProtocolVersionError,
  verifyMcpRequestHeaders,
  withModernResultFields,
  MCP_MODERN_ERROR_CODES,
  MCP_META_CLIENT_CAPABILITIES,
  MCP_META_PROTOCOL_VERSION,
  type McpHeaderLookup,
  type McpImplementationInfo
} from "@ai-orchestrator/mcp-sdk";
import {
  JSON_RPC_ERRORS,
  classifyMessage,
  rpcError,
  rpcResult,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse
} from "./mcp-gateway-protocol.js";

export type GatewayModernMode = "off" | "on";

/** `ttlMs` on modern `tools/list` and `server/discover` results when MCP_GATEWAY_LIST_TTL_MS is unset. */
export const DEFAULT_MCP_GATEWAY_LIST_TTL_MS = 60_000;

/** The methods a modern caller can use on a toolset. Anything else is 404 with -32601. */
export const MODERN_GATEWAY_METHODS: ReadonlySet<string> = new Set(["server/discover", "tools/list", "tools/call", "subscriptions/listen"]);

/**
 * The versions the gateway speaks, newest first: the modern ones (served per request) followed by the legacy ones
 * (served after `initialize`) when modern mode is on, else the legacy ones only.
 */
export function gatewaySupportedVersions(mode: GatewayModernMode): string[] {
  return mode === "on" ? [...MCP_MODERN_PROTOCOL_VERSIONS, ...MCP_LEGACY_PROTOCOL_VERSIONS] : [...MCP_LEGACY_PROTOCOL_VERSIONS];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Whether an `MCP-Protocol-Version` header value names a modern (per-request metadata) version. */
export function isModernProtocolVersionHeader(value: string | undefined): boolean {
  return value !== undefined && (MCP_MODERN_PROTOCOL_VERSIONS as readonly string[]).includes(value.trim());
}

/**
 * Whether a parsed body is a modern request: one message sent with a modern `MCP-Protocol-Version` header, or one
 * message with a method other than `initialize` whose `_meta` has the protocol version key (even a malformed value:
 * that is answered with -32602, not with the legacy session error). A header-modern message without the `_meta` keys
 * is a malformed modern request (-32602 with its id), not a request without a session, and a header-modern
 * `initialize` asks for a method 2026-07-28 removed (404 with -32601): legacy clients never send a modern version in
 * that header. An `initialize` without it opens a legacy session, whatever its `_meta` holds.
 */
export function isModernGatewayMessage(parsed: unknown, versionHeader?: string): boolean {
  if (!isRecord(parsed) || typeof parsed.method !== "string") return false;
  if (isModernProtocolVersionHeader(versionHeader)) return true;
  if (parsed.method === "initialize") return false;
  return inspectRequestMeta(parsed.params).era === "modern";
}

export type ModernGatewayMessage =
  | {
      ok: true;
      kind: "request";
      message: JsonRpcRequest;
      protocolVersion: string;
      clientInfo: { name?: string; version?: string };
    }
  | { ok: true; kind: "notification"; message: JsonRpcNotification }
  | { ok: false; status: number; response: JsonRpcResponse };

/** Display-only client info from `_meta`, truncated as `initialize` truncates it. */
function clientInfoOf(info: McpImplementationInfo | undefined): { name?: string; version?: string } {
  if (!info) return {};
  return { name: info.name.slice(0, 200), version: info.version.slice(0, 50) };
}

/**
 * Validate a modern message in the order the specification implies: a well-formed JSON-RPC message; a protocol
 * version in `_meta` (else -32602); an `MCP-Protocol-Version` header, when sent, equal to it (else -32020); a version
 * the gateway serves statelessly (else -32022 listing every version it
 * speaks, so a client can pick a legacy one and `initialize`); `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name`
 * headers present and equal to the body (else -32020); the other required `_meta` keys (else -32602). Each failure is
 * HTTP 400. Notifications need none of this: the specification defines no client notification over HTTP for modern
 * versions, so they are accepted and ignored.
 */
export function validateModernGatewayMessage(parsed: unknown, headers: McpHeaderLookup, mode: GatewayModernMode): ModernGatewayMessage {
  const classified = classifyMessage(parsed);
  if (classified.kind === "invalid") {
    return { ok: false, status: 400, response: rpcError(classified.id, JSON_RPC_ERRORS.invalidRequest, `Invalid request: ${classified.reason}.`) };
  }
  if (classified.kind === "response") {
    return { ok: false, status: 400, response: rpcError(null, JSON_RPC_ERRORS.invalidRequest, "Invalid request: clients do not send responses.") };
  }
  if (classified.kind === "notification") return { ok: true, kind: "notification", message: classified.message };
  const message = classified.message;
  const meta = inspectRequestMeta(message.params);
  if (meta.era !== "modern") {
    // `initialize` with a modern header and legacy params: 2026-07-28 removed the method, whatever `_meta` holds.
    if (message.method === "initialize") {
      return { ok: false, status: 404, response: rpcError(message.id, JSON_RPC_ERRORS.methodNotFound, "Method not found: initialize") };
    }
    // A modern version in the header but no protocol version in `_meta`: a malformed modern request (-32602).
    const present = isRecord(message.params) && isRecord(message.params._meta) ? message.params._meta : {};
    const missing = isRecord(present[MCP_META_CLIENT_CAPABILITIES])
      ? [MCP_META_PROTOCOL_VERSION]
      : [MCP_META_PROTOCOL_VERSION, MCP_META_CLIENT_CAPABILITIES];
    return { ok: false, status: 400, response: rpcErrorFrom(message.id, missingRequestMetaError(missing)) };
  }
  if (meta.missing.includes(MCP_META_PROTOCOL_VERSION) || meta.protocolVersion === undefined) {
    return { ok: false, status: 400, response: rpcErrorFrom(message.id, missingRequestMetaError(meta.missing)) };
  }
  // The header must name the version `_meta` names: a mismatch is -32020, whatever either version is (checked before
  // -32022, so a supported header over an unknown body version is a mismatch, not an unsupported version).
  const versionHeader = headers(MCP_HEADER_PROTOCOL_VERSION);
  if (versionHeader !== undefined && versionHeader.trim() !== meta.protocolVersion) {
    return { ok: false, status: 400, response: rpcErrorFrom(message.id, headerMismatchError(`${MCP_HEADER_PROTOCOL_VERSION} header does not match the protocol version in _meta`)) };
  }
  if (!(MCP_MODERN_PROTOCOL_VERSIONS as readonly string[]).includes(meta.protocolVersion)) {
    return { ok: false, status: 400, response: rpcErrorFrom(message.id, unsupportedProtocolVersionError(meta.protocolVersion, gatewaySupportedVersions(mode))) };
  }
  const mismatch = verifyMcpRequestHeaders(headers, message);
  if (mismatch) return { ok: false, status: 400, response: rpcError(message.id, mismatch.code, mismatch.message) };
  if (meta.missing.includes(MCP_META_CLIENT_CAPABILITIES)) {
    return { ok: false, status: 400, response: rpcErrorFrom(message.id, missingRequestMetaError(meta.missing)) };
  }
  return { ok: true, kind: "request", message, protocolVersion: meta.protocolVersion, clientInfo: clientInfoOf(meta.clientInfo) };
}

function rpcErrorFrom(id: JsonRpcRequest["id"] | null, error: { code: number; message: string; data?: unknown }): JsonRpcResponse {
  return rpcError(id, error.code, error.message, error.data);
}

/**
 * D7 — the code a modern response carries for one of the gateway's own error codes. 2026-07-28 reserves
 * -32099..-32020 for codes the specification defines, so the gateway's -32029..-32032 (retry later, approval pending,
 * approval rejected, budget exceeded) move outside the JSON-RPC reserved range, keeping their last digits:
 * -31029..-31032. Codes the specification defines (-32020..-32022) and every other code are unchanged. Legacy
 * sessions keep the old codes.
 */
export function modernGatewayErrorCode(code: number): number {
  if (isMcpSpecReservedErrorCode(code) && !MCP_MODERN_ERROR_CODES.has(code)) return code + 1000;
  return code;
}

/** The gateway's identity in modern results (`_meta["io.modelcontextprotocol/serverInfo"]`) and `server/discover`. */
export function gatewayServerInfo(toolset: { slug: string; name: string }, version: string): { name: string; title: string; version: string } {
  return { name: `l2m-${toolset.slug}`, title: toolset.name, version };
}

/**
 * A response as a modern caller receives it: results get `resultType: "complete"` (unless they name one) and the
 * server info in `_meta`; errors get their D7 code, with the same message and data.
 */
export function modernizeGatewayResponse(response: JsonRpcResponse, serverInfo: { name: string; version: string; title?: string }): JsonRpcResponse {
  if ("error" in response) {
    const code = modernGatewayErrorCode(response.error.code);
    return code === response.error.code ? response : { ...response, error: { ...response.error, code } };
  }
  return { ...response, result: withModernResultFields(response.result, serverInfo) };
}

/** The cache hints of a modern list or discover result: lists depend on the caller's role and policy, so private. */
export function gatewayCacheHints(ttlMs: number): { ttlMs: number; cacheScope: "private" } {
  return { ttlMs: Math.max(0, Math.floor(ttlMs)), cacheScope: "private" };
}

/** `server/discover` for a toolset. */
export function gatewayDiscoverResult(input: {
  toolset: { slug: string; name: string; description?: string | null };
  mode: GatewayModernMode;
  ttlMs: number;
}): Record<string, unknown> {
  return {
    supportedVersions: gatewaySupportedVersions(input.mode),
    capabilities: { tools: { listChanged: false } },
    ...(input.toolset.description ? { instructions: input.toolset.description } : {}),
    ...gatewayCacheHints(input.ttlMs)
  };
}

/** `_meta` key that ties every message of a subscription stream to its `subscriptions/listen` request id. */
export const MCP_META_SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";

/** `MCP_GATEWAY_LISTEN_MAX_MS` default: a listen stream ends gracefully after this long (clients reconnect). */
export const DEFAULT_MCP_GATEWAY_LISTEN_MAX_MS = 600_000;
/** `MCP_GATEWAY_LISTEN_MAX_PER_CLIENT` default: open listen streams per client on one instance. */
export const DEFAULT_MCP_GATEWAY_LISTEN_MAX_PER_CLIENT = 4;

const LISTEN_BOOLEAN_FILTERS = ["toolsListChanged", "promptsListChanged", "resourcesListChanged"] as const;

/**
 * The `notifications` filter of a `subscriptions/listen` request, checked for shape only: an object (or absent)
 * whose known fields have the types the specification gives. Unknown fields are ignored. The gateway honours none of
 * it today (it serves tools only and its tool list does not announce changes), so the acknowledgment is empty.
 * Returns an error message, or null when the filter is well formed.
 */
export function listenFilterError(params: unknown): string | null {
  const filter = isRecord(params) ? params.notifications : undefined;
  if (filter === undefined) return null;
  if (!isRecord(filter)) return "notifications must be an object.";
  for (const field of LISTEN_BOOLEAN_FILTERS) {
    if (filter[field] !== undefined && typeof filter[field] !== "boolean") return `notifications.${field} must be a boolean.`;
  }
  const uris = filter.resourceSubscriptions;
  if (uris !== undefined && (!Array.isArray(uris) || uris.some((uri) => typeof uri !== "string"))) {
    return "notifications.resourceSubscriptions must be an array of strings.";
  }
  return null;
}

/** First message of a listen stream: the subset the gateway honours (none: it declares `tools.listChanged: false`). */
export function subscriptionsAcknowledged(subscriptionId: JsonRpcRequest["id"]): JsonRpcNotification {
  return {
    jsonrpc: "2.0",
    method: "notifications/subscriptions/acknowledged",
    params: { _meta: { [MCP_META_SUBSCRIPTION_ID]: subscriptionId }, notifications: {} }
  };
}

/** Graceful end of a listen stream: the successful response to the `subscriptions/listen` request. */
export function subscriptionsComplete(
  subscriptionId: JsonRpcRequest["id"],
  serverInfo: { name: string; version: string; title?: string }
): JsonRpcResponse {
  return modernizeGatewayResponse(rpcResult(subscriptionId, { _meta: { [MCP_META_SUBSCRIPTION_ID]: subscriptionId } }), serverInfo);
}

/** Tools in a deterministic order for modern callers (by exposed name), as the specification asks of list results. */
export function sortToolsByName<T extends { name: string }>(tools: readonly T[]): T[] {
  return [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * D12 — a tool descriptor without `x-mcp-header` annotations: the gateway defines its own tool contracts and does
 * not ask its callers for `Mcp-Param-*` headers. Null when the schema is too deep to be sure none is left (the tool
 * is then left out of the modern list).
 */
export function stripDescriptorHeaderAnnotations(descriptor: Record<string, unknown>): Record<string, unknown> | null {
  if (descriptor.inputSchema === undefined) return descriptor;
  try {
    return { ...descriptor, inputSchema: stripMcpHeaderAnnotations(descriptor.inputSchema) };
  } catch (error) {
    if (error instanceof McpSchemaTooDeepError) return null;
    throw error;
  }
}

/** Header names a browser may send to the gateway, besides the fixed list: `Mcp-Param-*` headers. */
const MCP_PARAM_HEADER = /^mcp-param-[!#$%&'*+.^_`|~0-9a-z-]+$/;
/** At most this many `Mcp-Param-*` names are reflected in one preflight. */
const MAX_REFLECTED_PARAM_HEADERS = 32;

/** The legacy CORS request headers of the gateway. */
export const GATEWAY_CORS_LEGACY_HEADERS = ["Authorization", "Content-Type", "Accept", "Mcp-Session-Id", "MCP-Protocol-Version", "Last-Event-ID"] as const;
/** What modern callers add: the standard request metadata headers. */
export const GATEWAY_CORS_MODERN_HEADERS = ["Mcp-Method", "Mcp-Name"] as const;

/**
 * The `Access-Control-Allow-Headers` list for a preflight: the legacy list, plus (modern mode on) `Mcp-Method`,
 * `Mcp-Name` and each requested header that is a well-formed `Mcp-Param-*` name (at most 32). Nothing else is reflected.
 */
export function gatewayCorsAllowedHeaders(mode: GatewayModernMode, requested: string | string[] | undefined): string[] {
  const base: string[] = [...GATEWAY_CORS_LEGACY_HEADERS];
  if (mode !== "on") return base;
  const params = (Array.isArray(requested) ? requested.join(",") : (requested ?? ""))
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length <= 128 && MCP_PARAM_HEADER.test(entry));
  return [...base, ...GATEWAY_CORS_MODERN_HEADERS, ...[...new Set(params)].slice(0, MAX_REFLECTED_PARAM_HEADERS)];
}
