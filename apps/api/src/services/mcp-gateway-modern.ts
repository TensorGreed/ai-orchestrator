/**
 * MCP 2026-07-28 at the gateway: the pieces `/mcp/:toolset` needs to serve
 * modern clients next to legacy ones on the same endpoint (a "dual-era
 * server"), kept out of the routes file.
 *
 * A request is modern exactly when it is a single JSON-RPC message (not a
 * batch, not `initialize`) whose `params._meta` carries
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
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse
} from "./mcp-gateway-protocol.js";

export type GatewayModernMode = "off" | "on";

/** `ttlMs` on modern `tools/list` and `server/discover` results when MCP_GATEWAY_LIST_TTL_MS is unset. */
export const DEFAULT_MCP_GATEWAY_LIST_TTL_MS = 60_000;

/** The methods a modern caller can use on a toolset. Anything else is 404 with -32601. */
export const MODERN_GATEWAY_METHODS: ReadonlySet<string> = new Set(["server/discover", "tools/list", "tools/call"]);

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

/**
 * Whether a parsed body is a modern request: one message with a method other than `initialize` whose `_meta` has the
 * protocol version key (even a malformed value: that is answered with -32602, not with the legacy session error).
 */
export function isModernGatewayMessage(parsed: unknown): boolean {
  if (!isRecord(parsed) || typeof parsed.method !== "string" || parsed.method === "initialize") return false;
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
 * version in `_meta` (else -32602); a version the gateway serves statelessly (else -32022 listing every version it
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
    // Callers check `isModernGatewayMessage` first; this keeps the function total.
    return { ok: false, status: 400, response: rpcErrorFrom(message.id, missingRequestMetaError([MCP_META_PROTOCOL_VERSION])) };
  }
  if (meta.missing.includes(MCP_META_PROTOCOL_VERSION) || meta.protocolVersion === undefined) {
    return { ok: false, status: 400, response: rpcErrorFrom(message.id, missingRequestMetaError(meta.missing)) };
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
