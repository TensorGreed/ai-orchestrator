import { createHash } from "node:crypto";
import type { McpClientProtocolMode, McpProtocolEra, McpServerCapabilities } from "@ai-orchestrator/shared";
import { JSON_RPC_METHOD_NOT_FOUND, normalizeServerCapabilities } from "../client-features";
import {
  MCP_ERROR_HEADER_MISMATCH,
  MCP_ERROR_MISSING_REQUIRED_CLIENT_CAPABILITY,
  MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION,
  MCP_FIRST_MODERN_PROTOCOL_VERSION,
  MCP_LEGACY_PROTOCOL_VERSIONS,
  MCP_META_SERVER_INFO,
  MCP_MODERN_PROTOCOL_VERSIONS
} from "./constants";
import type { McpImplementationInfo } from "./meta";

/**
 * MCP 2026-07-28 — telling modern servers from legacy ones.
 *
 * HTTP: send a modern request first. A 2xx, or a 4xx whose body is a
 * recognised modern JSON-RPC error, means modern; any other 4xx (including
 * an empty body) means legacy, so fall back to `initialize`.
 * stdio: probe with `server/discover`. A discover result or a recognised
 * modern error means modern; any other error, or no answer in time, means
 * legacy. The fallback is never keyed to one specific error code.
 *
 * The era is a property of the server: cache it per HTTP endpoint or per
 * stdio launch plan, and probe again when a cached assumption fails.
 */

export const MCP_CLIENT_PROTOCOL_MODES: readonly McpClientProtocolMode[] = ["auto", "legacy", "modern"];

/** A connection's `protocolMode`, or undefined when it has none or an unknown one. */
export function parseMcpClientProtocolMode(value: unknown): McpClientProtocolMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return (MCP_CLIENT_PROTOCOL_MODES as readonly string[]).includes(normalized) ? (normalized as McpClientProtocolMode) : undefined;
}

/** The mode for a server: its connection's `protocolMode`, else the deployment default, else `legacy`. */
export function resolveMcpClientProtocolMode(connection: unknown, deploymentDefault?: McpClientProtocolMode): McpClientProtocolMode {
  const own = connection && typeof connection === "object" ? parseMcpClientProtocolMode((connection as Record<string, unknown>).protocolMode) : undefined;
  return own ?? deploymentDefault ?? "legacy";
}

const DATED_VERSION = /^\d{4}-\d{2}-\d{2}$/;

/** The era of a dated protocol version: 2026-07-28 and later are modern. Undefined for anything else. */
export function protocolEraOf(version: unknown): McpProtocolEra | undefined {
  if (typeof version !== "string" || !DATED_VERSION.test(version)) return undefined;
  return version >= MCP_FIRST_MODERN_PROTOCOL_VERSION ? "modern" : "legacy";
}

/** True for a modern version L2M speaks. */
export function isSupportedModernVersion(version: unknown): boolean {
  return typeof version === "string" && (MCP_MODERN_PROTOCOL_VERSIONS as readonly string[]).includes(version);
}

export type McpVersionChoice = { era: "modern"; version: string } | { era: "legacy" } | { era: "none" };

/**
 * Pick a version from a server's supported list (`data.supported` of
 * -32022, or `supportedVersions` of `server/discover`): the newest modern
 * version both sides speak; else, when `allowLegacy` and the server lists a
 * legacy version L2M speaks, legacy (open with `initialize`); else none.
 */
export function chooseMcpProtocolVersion(supported: readonly unknown[], options?: { allowLegacy?: boolean }): McpVersionChoice {
  const offered = new Set(supported.filter((entry): entry is string => typeof entry === "string"));
  const modern = MCP_MODERN_PROTOCOL_VERSIONS.find((version) => offered.has(version));
  if (modern) return { era: "modern", version: modern };
  if (options?.allowLegacy && MCP_LEGACY_PROTOCOL_VERSIONS.some((version) => offered.has(version))) return { era: "legacy" };
  return { era: "none" };
}

// Modern errors -----------------------------------------------------------------

export type McpModernProtocolError =
  | { kind: "header_mismatch"; code: typeof MCP_ERROR_HEADER_MISMATCH; message: string }
  | {
      kind: "missing_client_capability";
      code: typeof MCP_ERROR_MISSING_REQUIRED_CLIENT_CAPABILITY;
      message: string;
      requiredCapabilities: Record<string, unknown>;
    }
  | {
      kind: "unsupported_version";
      code: typeof MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION;
      message: string;
      supported: string[];
      requested?: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * A JSON-RPC error object recognised as one of the errors 2026-07-28 defines
 * (-32020, -32021, -32022), or null. -32022 is recognised only with a
 * `data.supported` list of strings, so a legacy server's stray use of the
 * code does not pass for a modern answer.
 */
export function parseMcpModernError(error: unknown): McpModernProtocolError | null {
  if (!isRecord(error) || typeof error.code !== "number") return null;
  const message = typeof error.message === "string" ? error.message : "";
  const data = isRecord(error.data) ? error.data : {};
  switch (error.code) {
    case MCP_ERROR_HEADER_MISMATCH:
      return { kind: "header_mismatch", code: MCP_ERROR_HEADER_MISMATCH, message };
    case MCP_ERROR_MISSING_REQUIRED_CLIENT_CAPABILITY:
      return {
        kind: "missing_client_capability",
        code: MCP_ERROR_MISSING_REQUIRED_CLIENT_CAPABILITY,
        message,
        requiredCapabilities: isRecord(data.requiredCapabilities) ? data.requiredCapabilities : {}
      };
    case MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION: {
      if (!Array.isArray(data.supported) || !data.supported.every((entry) => typeof entry === "string")) return null;
      return {
        kind: "unsupported_version",
        code: MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION,
        message,
        supported: [...(data.supported as string[])],
        ...(typeof data.requested === "string" ? { requested: data.requested } : {})
      };
    }
    default:
      return null;
  }
}

/** The `error` member of a JSON-RPC response body, or null when the body is not one. */
function jsonRpcErrorOf(bodyText: string): Record<string, unknown> | null {
  if (!bodyText.trim()) return null;
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    return isRecord(parsed) && parsed.jsonrpc === "2.0" && isRecord(parsed.error) ? parsed.error : null;
  } catch {
    return null;
  }
}

/** What an HTTP answer to a modern request says about the server's era. */
export type McpHttpEraVerdict =
  /** A modern server; `error` is set when it answered with a recognised modern error. */
  | { era: "modern"; error?: McpModernProtocolError; methodNotFound?: boolean }
  /** A legacy server: fall back to `initialize`. */
  | { era: "legacy" }
  /** The answer says nothing about the era (authorization, rate limits, server errors): do not cache. */
  | { era: "unknown" };

/** HTTP statuses that are about the request's credentials or the server's load, not its protocol. */
const ERA_NEUTRAL_STATUSES = new Set([401, 403, 407, 408, 429]);

/**
 * Classify the HTTP answer to a modern request. 2xx is modern. 400 with a
 * recognised modern error, or 404 with a JSON-RPC -32601 body (a modern
 * server that does not implement the method), is modern. Other 4xx answers
 * are legacy, except those about credentials, timeouts and rate limits;
 * those and 5xx are unknown.
 */
export function classifyHttpEraResponse(status: number, bodyText: string): McpHttpEraVerdict {
  if (status >= 200 && status < 300) return { era: "modern" };
  if (status >= 500 || ERA_NEUTRAL_STATUSES.has(status)) return { era: "unknown" };
  if (status < 400) return { era: "unknown" };
  const error = jsonRpcErrorOf(bodyText);
  if (status === 400) {
    const modern = parseMcpModernError(error);
    return modern ? { era: "modern", error: modern } : { era: "legacy" };
  }
  if (status === 404 && error && error.code === JSON_RPC_METHOD_NOT_FOUND) return { era: "modern", methodNotFound: true };
  return { era: "legacy" };
}

/** How a stdio `server/discover` probe ended. */
export type McpStdioProbeOutcome = { result: unknown } | { error: unknown } | { timedOut: true };

export type McpStdioEraVerdict =
  | { era: "modern"; discover?: McpDiscoverResult; error?: McpModernProtocolError }
  | { era: "legacy" };

/**
 * Classify a stdio `server/discover` probe: a discover result or a
 * recognised modern error is modern; any other error, an answer that is not
 * a discover result, or no answer is legacy.
 */
export function classifyStdioEraProbe(outcome: McpStdioProbeOutcome): McpStdioEraVerdict {
  if ("result" in outcome) {
    const discover = parseDiscoverResult(outcome.result);
    return discover ? { era: "modern", discover } : { era: "legacy" };
  }
  if ("error" in outcome) {
    const modern = parseMcpModernError(outcome.error);
    return modern ? { era: "modern", error: modern } : { era: "legacy" };
  }
  return { era: "legacy" };
}

/**
 * Whether a failed `initialize` came from a modern-only server, so a client
 * in `legacy` mode can switch that server to modern. HTTP: a 400 whose body
 * is a recognised modern error. stdio: a JSON-RPC error whose
 * `data.supported` lists a modern version.
 */
export function initializeRejectionIsModern(
  rejection: { transport: "http"; status: number; bodyText: string } | { transport: "stdio"; error: unknown }
): boolean {
  if (rejection.transport === "http") {
    return rejection.status === 400 && parseMcpModernError(jsonRpcErrorOf(rejection.bodyText)) !== null;
  }
  const error = rejection.error;
  if (!isRecord(error) || !isRecord(error.data) || !Array.isArray(error.data.supported)) return false;
  return error.data.supported.some((version) => protocolEraOf(version) === "modern");
}

// server/discover -----------------------------------------------------------------

export interface McpDiscoverResult {
  supportedVersions: string[];
  capabilities: McpServerCapabilities;
  instructions?: string;
  serverInfo?: McpImplementationInfo;
  ttlMs?: number;
  cacheScope?: "public" | "private";
}

/** A `server/discover` result, or null when `raw` is not one (no `supportedVersions` list). */
export function parseDiscoverResult(raw: unknown): McpDiscoverResult | null {
  if (!isRecord(raw) || !Array.isArray(raw.supportedVersions)) return null;
  if (raw.resultType !== undefined && raw.resultType !== "complete") return null;
  const supportedVersions = raw.supportedVersions.filter((entry): entry is string => typeof entry === "string");
  const meta = isRecord(raw._meta) ? raw._meta : {};
  const info = meta[MCP_META_SERVER_INFO];
  const serverInfo =
    isRecord(info) && typeof info.name === "string" && typeof info.version === "string" ? (info as McpImplementationInfo) : undefined;
  const ttlMs = typeof raw.ttlMs === "number" && Number.isFinite(raw.ttlMs) && raw.ttlMs >= 0 ? raw.ttlMs : undefined;
  const cacheScope = raw.cacheScope === "public" || raw.cacheScope === "private" ? raw.cacheScope : undefined;
  return {
    supportedVersions,
    capabilities: normalizeServerCapabilities(raw.capabilities),
    ...(typeof raw.instructions === "string" && raw.instructions.trim() ? { instructions: raw.instructions.slice(0, 20_000) } : {}),
    ...(serverInfo ? { serverInfo } : {}),
    ...(ttlMs !== undefined ? { ttlMs } : {}),
    ...(cacheScope ? { cacheScope } : {})
  };
}

// Era cache -------------------------------------------------------------------------

export interface McpEraCacheEntry {
  era: McpProtocolEra;
  /** The version in use for a modern server. */
  version?: string;
  observedAt: number;
}

/** Default time an observed era is trusted before the next probe. */
export const DEFAULT_MCP_ERA_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Observed eras by server key, with a TTL and a size bound (oldest entries
 * go first). Callers invalidate an entry when the server stops behaving like
 * its cached era, and probe again.
 */
export class McpEraCache {
  private readonly entries = new Map<string, McpEraCacheEntry>();

  constructor(
    private readonly options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}
  ) {}

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  get(key: string): McpEraCacheEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.observedAt >= (this.options.ttlMs ?? DEFAULT_MCP_ERA_CACHE_TTL_MS)) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  set(key: string, era: McpProtocolEra, version?: string): McpEraCacheEntry {
    const entry: McpEraCacheEntry = { era, ...(version ? { version } : {}), observedAt: this.now() };
    this.entries.delete(key);
    this.entries.set(key, entry);
    const max = this.options.maxEntries ?? 1000;
    while (this.entries.size > max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return entry;
  }

  invalidate(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Era cache key of an HTTP server: the endpoint's origin and path (query and fragment ignored). */
export function httpEraCacheKey(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `http:${url.origin}${url.pathname}`;
  } catch {
    return `http:${endpoint}`;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Era cache key of a stdio server: a SHA-256 of its launch plan (command,
 * arguments, environment, working directory), so the key never holds the
 * values themselves.
 */
export function stdioEraCacheKey(launchPlan: unknown): string {
  return `stdio:${createHash("sha256").update(canonicalJson(launchPlan), "utf-8").digest("hex")}`;
}
