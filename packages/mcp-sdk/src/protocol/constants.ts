import { MCP_CLIENT_PROTOCOL_VERSION } from "../progress";

/**
 * MCP 2026-07-28 — protocol constants shared by the L2M client adapters and
 * the gateway: version sets, reserved `_meta` keys, HTTP header names and
 * the error codes the specification defines.
 *
 * Terms follow the specification's versioning page: "modern" versions carry
 * version, identity and capabilities in every request's `_meta`
 * (2026-07-28 and later); "legacy" versions open with an `initialize`
 * handshake (2025-11-25 and earlier).
 */

/** Modern protocol versions L2M speaks, newest first. */
export const MCP_MODERN_PROTOCOL_VERSIONS = ["2026-07-28"] as const;

/** Legacy protocol versions L2M speaks (the gateway's set), newest first. */
export const MCP_LEGACY_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;

/** The modern version L2M sends first when it talks to a modern server. */
export const MCP_CLIENT_MODERN_PROTOCOL_VERSION: (typeof MCP_MODERN_PROTOCOL_VERSIONS)[number] = MCP_MODERN_PROTOCOL_VERSIONS[0];

/** The version L2M offers in `initialize` to legacy servers. Unchanged from earlier releases. */
export const MCP_CLIENT_LEGACY_PROTOCOL_VERSION = MCP_CLIENT_PROTOCOL_VERSION;

/** The first modern revision. Any later dated revision is modern too. */
export const MCP_FIRST_MODERN_PROTOCOL_VERSION = "2026-07-28";

/** What L2M calls itself in `clientInfo`, in `initialize` and in modern `_meta`. */
export const MCP_CLIENT_INFO = Object.freeze({ name: "ai-orchestrator", version: "0.1.0" });

// `_meta` keys ---------------------------------------------------------------

/** Required on every modern request. */
export const MCP_META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
/** Required on every modern request (an empty object declares no optional capabilities). */
export const MCP_META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
/** Optional; clients should send it on every modern request. */
export const MCP_META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
/** Optional and deprecated in 2026-07-28; L2M never sets it. */
export const MCP_META_LOG_LEVEL = "io.modelcontextprotocol/logLevel";
/** Servers should put their name and version in every result's `_meta` under this key. */
export const MCP_META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
/** On notifications delivered through a `subscriptions/listen` stream. */
export const MCP_META_SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";
/** Opts a request into `notifications/progress`. */
export const MCP_META_PROGRESS_TOKEN = "progressToken";

/**
 * W3C trace context keys the specification reserves in `_meta`. The
 * OpenTelemetry work owns them: nothing here sets, validates or strips them,
 * and they never decide the era of a request.
 */
export const MCP_META_TRACE_CONTEXT_KEYS = ["traceparent", "tracestate", "baggage"] as const;

// HTTP headers ---------------------------------------------------------------

export const MCP_HEADER_PROTOCOL_VERSION = "MCP-Protocol-Version";
export const MCP_HEADER_METHOD = "Mcp-Method";
export const MCP_HEADER_NAME = "Mcp-Name";
/** Prefix of the headers a tool's `x-mcp-header` annotations ask for. */
export const MCP_HEADER_PARAM_PREFIX = "Mcp-Param-";
/** The `inputSchema` property annotation that names an `Mcp-Param-*` header. */
export const MCP_HEADER_ANNOTATION = "x-mcp-header";

// Error codes ----------------------------------------------------------------

/** HTTP headers do not match the body, or a required header is missing or malformed. HTTP 400. */
export const MCP_ERROR_HEADER_MISMATCH = -32020;
/** The request needs a client capability that `clientCapabilities` did not declare. HTTP 400. */
export const MCP_ERROR_MISSING_REQUIRED_CLIENT_CAPABILITY = -32021;
/** The server does not speak the requested version; `data.supported` lists what it does. HTTP 400. */
export const MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION = -32022;
/** "Resource not found" from servers on 2025-11-25 and earlier; modern servers use -32602. */
export const MCP_ERROR_LEGACY_RESOURCE_NOT_FOUND = -32002;

/** The error codes 2026-07-28 defines in its reserved sub-range. */
export const MCP_MODERN_ERROR_CODES: ReadonlySet<number> = new Set([
  MCP_ERROR_HEADER_MISMATCH,
  MCP_ERROR_MISSING_REQUIRED_CLIENT_CAPABILITY,
  MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION
]);

/**
 * True for codes in `-32099..-32020`, the sub-range 2026-07-28 reserves for
 * the specification. Implementations must not emit codes from it that the
 * specification does not define.
 */
export function isMcpSpecReservedErrorCode(code: number): boolean {
  return Number.isInteger(code) && code >= -32099 && code <= -32020;
}

/**
 * True for codes in `-32019..-32000`: allocated by implementations before
 * 2026-07-28, grandfathered, and not to be used by new implementations.
 * Apart from -32002 a receiver must not assume a meaning for them.
 */
export function isMcpLegacyImplementationErrorCode(code: number): boolean {
  return Number.isInteger(code) && code >= -32019 && code <= -32000;
}

/** The three client requests a server may answer with `input_required`. */
export const MCP_MRTR_METHODS = ["tools/call", "resources/read", "prompts/get"] as const;
export type McpMrtrMethod = (typeof MCP_MRTR_METHODS)[number];

export function isMrtrMethod(method: string): method is McpMrtrMethod {
  return (MCP_MRTR_METHODS as readonly string[]).includes(method);
}
