import { buildClientCapabilities } from "../client-features";
import type { MCPExecutionContext } from "../types";
import {
  MCP_CLIENT_INFO,
  MCP_META_CLIENT_CAPABILITIES,
  MCP_META_CLIENT_INFO,
  MCP_META_LOG_LEVEL,
  MCP_META_PROTOCOL_VERSION,
  MCP_META_TRACE_CONTEXT_KEYS
} from "./constants";

/**
 * MCP 2026-07-28 — the request `_meta` object. Modern requests carry their
 * protocol version, client capabilities and client info here instead of in
 * an `initialize` handshake.
 *
 * Several parts of L2M write into the same `_meta` (the progress token, the
 * modern protocol keys, trace context), so every writer goes through
 * `withRequestMeta`, which merges and never drops keys it was not asked to
 * set.
 */

export type McpMeta = Record<string, unknown>;

/** `Implementation` in the schema: `name` and `version` are required, other fields optional. */
export interface McpImplementationInfo {
  name: string;
  version: string;
  title?: string;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export interface ModernRequestMetaInput {
  protocolVersion: string;
  /** What the client supports for this request; `{}` declares nothing optional. */
  clientCapabilities: Record<string, unknown>;
  /** Defaults to L2M's own client info; `false` leaves it out. */
  clientInfo?: McpImplementationInfo | false;
}

/** The `io.modelcontextprotocol/*` keys every modern request carries. */
export function buildModernRequestMeta(input: ModernRequestMetaInput): McpMeta {
  const clientInfo = input.clientInfo === undefined ? { ...MCP_CLIENT_INFO } : input.clientInfo;
  return {
    [MCP_META_PROTOCOL_VERSION]: input.protocolVersion,
    [MCP_META_CLIENT_CAPABILITIES]: input.clientCapabilities,
    ...(clientInfo ? { [MCP_META_CLIENT_INFO]: clientInfo } : {})
  };
}

/** The modern `_meta` keys for a call made with `context`: capabilities follow the handlers it has. */
export function modernRequestMetaFor(
  context: Partial<Pick<MCPExecutionContext, "onSampling">>,
  protocolVersion: string
): McpMeta {
  return buildModernRequestMeta({ protocolVersion, clientCapabilities: buildClientCapabilities(context) });
}

/**
 * Request params with `entries` merged into their `_meta`. Keys already in
 * `_meta` that `entries` does not name (a progress token, trace context, a
 * vendor key) are kept; keys `entries` names are replaced; entries whose
 * value is `undefined` are ignored. Neither argument is modified. A `_meta`
 * that is not an object is replaced.
 */
export function withRequestMeta<T extends Record<string, unknown>>(
  params: T | undefined,
  entries: McpMeta
): T & { _meta: McpMeta } {
  const base = (params ?? {}) as T;
  const meta: McpMeta = isRecord(base._meta) ? { ...base._meta } : {};
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) meta[key] = value;
  }
  return { ...base, _meta: meta };
}

const META_PREFIX_LABEL = /^[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const META_NAME = /^(?:[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)?$/;

/**
 * Whether `key` follows the `_meta` key format: an optional prefix (dot
 * separated labels ending in `/`) and a name. The trace context keys are
 * valid by the specification's own exception.
 */
export function isValidMetaKey(key: string): boolean {
  const slash = key.lastIndexOf("/");
  const name = slash === -1 ? key : key.slice(slash + 1);
  if (!META_NAME.test(name)) return false;
  if (slash === -1) return true;
  const labels = key.slice(0, slash).split(".");
  return labels.every((label) => META_PREFIX_LABEL.test(label));
}

/** True for keys under a prefix the specification reserves (second label `modelcontextprotocol` or `mcp`). */
export function isReservedMetaKey(key: string): boolean {
  if ((MCP_META_TRACE_CONTEXT_KEYS as readonly string[]).includes(key) || key === "progressToken") return true;
  const slash = key.lastIndexOf("/");
  if (slash === -1) return false;
  const second = key.slice(0, slash).split(".")[1];
  return second === "modelcontextprotocol" || second === "mcp";
}

/** What a server reads from a request's `_meta`. */
export type InspectedRequestMeta =
  | {
      /** No `io.modelcontextprotocol/protocolVersion` key: an `initialize`-era request. */
      era: "legacy";
    }
  | {
      era: "modern";
      /** Present whenever `missing` does not name it. */
      protocolVersion?: string;
      clientCapabilities?: Record<string, unknown>;
      clientInfo?: McpImplementationInfo;
      logLevel?: string;
      /**
       * Required keys that are absent or of the wrong type. A request with
       * any is malformed: -32602, and HTTP 400.
       */
      missing: string[];
    };

/**
 * Classify a request by its `_meta`. A request is modern exactly when its
 * `_meta` has the protocol version key; trace context and other keys never
 * make a request modern. `clientInfo` and `logLevel` are optional and are
 * returned only when well formed.
 */
export function inspectRequestMeta(params: unknown): InspectedRequestMeta {
  const meta = isRecord(params) && isRecord(params._meta) ? params._meta : undefined;
  if (!meta || !(MCP_META_PROTOCOL_VERSION in meta)) return { era: "legacy" };
  const missing: string[] = [];
  const version = meta[MCP_META_PROTOCOL_VERSION];
  const protocolVersion = typeof version === "string" && version.trim() ? version : undefined;
  if (!protocolVersion) missing.push(MCP_META_PROTOCOL_VERSION);
  const capabilities = meta[MCP_META_CLIENT_CAPABILITIES];
  const clientCapabilities = isRecord(capabilities) ? capabilities : undefined;
  if (!clientCapabilities) missing.push(MCP_META_CLIENT_CAPABILITIES);
  const info = meta[MCP_META_CLIENT_INFO];
  const clientInfo =
    isRecord(info) && typeof info.name === "string" && typeof info.version === "string" ? (info as McpImplementationInfo) : undefined;
  const level = meta[MCP_META_LOG_LEVEL];
  return {
    era: "modern",
    ...(protocolVersion ? { protocolVersion } : {}),
    ...(clientCapabilities ? { clientCapabilities } : {}),
    ...(clientInfo ? { clientInfo } : {}),
    ...(typeof level === "string" ? { logLevel: level } : {}),
    missing
  };
}
