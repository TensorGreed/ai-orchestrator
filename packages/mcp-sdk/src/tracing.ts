import {
  MCP_OUTCOME_ATTRIBUTES,
  type InstrumentationSpan,
  type McpRequestSpanInfo,
  type MCPServerConfig,
  type MCPToolResult,
  type RunInstrumentation,
  type TraceCarrier
} from "@ai-orchestrator/shared";
import { McpJsonRpcError, classifyMcpError } from "./errors";
import { isL2mOwnToolAdapter } from "./adapters/own-adapters";
import { MCP_META_TRACE_CONTEXT_KEYS } from "./protocol/constants";
import { withRequestMeta } from "./protocol/meta";
import { MCPRegistry } from "./registry";
import type { MCPServerAdapter } from "./types";

/**
 * Trace context for MCP requests, and CLIENT spans around every MCP operation.
 *
 * The adapters stay free of OpenTelemetry: they are given the shared `RunInstrumentation` (the API passes it only
 * while tracing is on) and call the helpers below at the point a request is written. The registry wrapper opens one
 * CLIENT span per operation (`tools/call search`, `tools/list`, ...), so the trace context a request carries names
 * that span.
 *
 * Trace context goes into the request's `params._meta` (`traceparent`, `tracestate`, and `baggage` when that
 * propagator is on) for every era and transport, and, over HTTP, into the request headers as well. A server can turn
 * it off with `propagateTraceContext: false` in its connection settings; the deployment can with
 * L2M_OTEL_PROPAGATE_TO_MCP=false.
 */

/** The connection setting that turns trace context off for one server. */
export const MCP_TRACE_CONTEXT_CONNECTION_KEY = "propagateTraceContext";

/** False when the server's connection settings turn trace context off. */
export function mcpTraceContextAllowed(config: Pick<MCPServerConfig, "connection"> | undefined): boolean {
  return config?.connection?.[MCP_TRACE_CONTEXT_CONNECTION_KEY] !== false;
}

/**
 * The trace context for one request to `config`'s server, from the active span; undefined while tracing is off, when
 * propagation to MCP servers is off, or when the server opted out.
 */
export function mcpTraceCarrier(
  instrument: RunInstrumentation | undefined,
  config: Pick<MCPServerConfig, "connection"> | undefined
): TraceCarrier | undefined {
  if (!instrument?.enabled || !mcpTraceContextAllowed(config)) return undefined;
  const carrier: TraceCarrier = {};
  return instrument.inject(carrier, "mcp") ? carrier : undefined;
}

/**
 * Request params with the trace context merged into `_meta` through `withRequestMeta`, so the progress token, the
 * 2026-07-28 protocol keys and vendor keys stay. A trace context key the carrier does not hold (a `tracestate` or
 * `baggage` from elsewhere) is dropped, so it never travels with a `traceparent` it does not belong to. Without a
 * carrier the params are returned as they are.
 */
export function withTraceContext<T extends Record<string, unknown>>(params: T | undefined, carrier: TraceCarrier | undefined): T {
  if (!carrier || typeof carrier.traceparent !== "string") return (params ?? {}) as T;
  const entries: Record<string, unknown> = {};
  for (const key of MCP_META_TRACE_CONTEXT_KEYS) {
    if (typeof carrier[key] === "string" && carrier[key]) entries[key] = carrier[key];
  }
  const merged = withRequestMeta(params, entries);
  for (const key of MCP_META_TRACE_CONTEXT_KEYS) {
    if (!(key in entries)) delete merged._meta[key];
  }
  return merged as T;
}

/** The trace context as HTTP request headers (empty without a carrier). */
export function traceContextHeaders(carrier: TraceCarrier | undefined): Record<string, string> {
  if (!carrier || typeof carrier.traceparent !== "string") return {};
  const headers: Record<string, string> = {};
  for (const key of MCP_META_TRACE_CONTEXT_KEYS) {
    if (typeof carrier[key] === "string" && carrier[key]) headers[key] = carrier[key];
  }
  return headers;
}

/** What an adapter knows about the request on the wire, set on the active MCP span. */
export interface McpWireFacts {
  sessionId?: string;
  protocolVersion?: string;
  requestId?: string | number;
}

/** Sets the request's session, version and JSON-RPC id on the active MCP span (no-op while tracing is off). */
export function annotateMcpRequest(instrument: RunInstrumentation | undefined, facts: McpWireFacts): void {
  if (!instrument?.enabled) return;
  instrument.annotate({
    [MCP_OUTCOME_ATTRIBUTES.SESSION_ID]: facts.sessionId,
    [MCP_OUTCOME_ATTRIBUTES.PROTOCOL_VERSION]: facts.protocolVersion,
    [MCP_OUTCOME_ATTRIBUTES.JSONRPC_REQUEST_ID]: facts.requestId === undefined ? undefined : String(facts.requestId)
  });
}

/** Records a JSON-RPC error code an MCP server answered with on the active MCP span. */
export function annotateMcpError(instrument: RunInstrumentation | undefined, error: unknown): void {
  if (!instrument?.enabled || !(error instanceof McpJsonRpcError) || typeof error.code !== "number") return;
  instrument.annotate({ [MCP_OUTCOME_ATTRIBUTES.RPC_RESPONSE_STATUS_CODE]: String(error.code) });
}

/**
 * Runs one round of a multi round-trip request. Round 1 runs in the request's own span; each later round gets a
 * child CLIENT span (`l2m.mcp.round`), so the trace context of that round's request names it.
 */
export async function traceMcpRound<T>(
  instrument: RunInstrumentation | undefined,
  info: { method: string; target?: string; round: number; serverId?: string },
  fn: () => Promise<T>
): Promise<T> {
  if (!instrument?.enabled || info.round <= 1) return await fn();
  return await instrument.mcpRequest(
    {
      method: info.method,
      ...(info.target ? { target: info.target } : {}),
      side: "client",
      round: info.round,
      ...(info.serverId ? { serverId: info.serverId } : {})
    },
    async (span) => {
      try {
        return await fn();
      } catch (error) {
        recordMcpFailure(span, error);
        throw error;
      }
    }
  );
}

/**
 * `error.type` for a thrown failure: the JSON-RPC code when the server sent one, else the L2M failure kind. Only the
 * type is recorded, never the message: a server's error text can carry tool output.
 */
function recordMcpFailure(span: InstrumentationSpan, error: unknown): void {
  if (error instanceof McpJsonRpcError && typeof error.code === "number") {
    span.setAttributes({ [MCP_OUTCOME_ATTRIBUTES.RPC_RESPONSE_STATUS_CODE]: String(error.code) });
    span.recordError(null, { type: String(error.code) });
    return;
  }
  span.recordError(null, { type: classifyMcpError(error) });
}

/** A failed tool result: `tool_error` for the tool's own error (`isError`), else the adapter's failure kind (type only). */
function recordToolResult(span: InstrumentationSpan, result: MCPToolResult): void {
  if (result.ok) return;
  const kind = result.errorKind ?? "tool";
  span.recordError(null, { type: kind === "tool" ? "tool_error" : kind });
}

const INSTRUMENTED = Symbol.for("l2m.mcpInstrumentedAdapter");

/** Transport facts for the span, by adapter id: HTTP servers are `tcp`/`http` with their host, stdio is `pipe`. */
function transportFacts(adapterId: string, config: MCPServerConfig): Partial<McpRequestSpanInfo> {
  if (adapterId === "stdio_mcp") return { transport: "pipe" };
  if (adapterId !== "http_mcp") return {};
  const endpoint = config.connection?.endpoint;
  if (typeof endpoint !== "string") return { transport: "tcp", networkProtocol: "http" };
  try {
    const url = new URL(endpoint);
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : url.protocol === "http:" ? 80 : undefined;
    return { transport: "tcp", networkProtocol: "http", serverAddress: url.hostname, ...(port ? { serverPort: port } : {}) };
  } catch {
    return { transport: "tcp", networkProtocol: "http" };
  }
}

type AdapterMethod = "discoverTools" | "invokeTool" | "listResources" | "listResourceTemplates" | "readResource" | "listPrompts" | "getPrompt";

/** The MCP method each adapter operation sends, and where its config and target are in the arguments. */
const OPERATIONS: Record<AdapterMethod, { method: string; configAt: number; target?: (args: unknown[]) => Partial<McpRequestSpanInfo> }> = {
  discoverTools: { method: "tools/list", configAt: 0 },
  invokeTool: { method: "tools/call", configAt: 2, target: (args) => (typeof args[0] === "string" ? { target: args[0] } : {}) },
  listResources: { method: "resources/list", configAt: 0 },
  listResourceTemplates: { method: "resources/templates/list", configAt: 0 },
  readResource: { method: "resources/read", configAt: 1, target: (args) => (typeof args[0] === "string" ? { resourceUri: args[0] } : {}) },
  listPrompts: { method: "prompts/list", configAt: 0 },
  getPrompt: { method: "prompts/get", configAt: 2, target: (args) => (typeof args[0] === "string" ? { target: args[0] } : {}) }
};

/**
 * The adapter with a CLIENT span around each MCP operation. L2M's own in-process tools (built-in and workflow tools)
 * are not MCP traffic and are returned as they are, as is an adapter that is already instrumented. Other properties
 * (the definition object, `closeSessions`, adapter-specific methods) pass through untouched.
 */
export function instrumentMcpAdapter<T extends MCPServerAdapter>(adapter: T, instrument: RunInstrumentation): T {
  if (!instrument.enabled || isL2mOwnToolAdapter(adapter) || (adapter as unknown as Record<symbol, unknown>)[INSTRUMENTED]) return adapter;
  const adapterId = adapter.definition.id;
  return new Proxy(adapter, {
    get(target, property, receiver) {
      if (property === INSTRUMENTED) return true;
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || property === "constructor") return value;
      const operation = typeof property === "string" ? OPERATIONS[property as AdapterMethod] : undefined;
      if (!operation) return value.bind(target);
      return (...args: unknown[]) => {
        const config = args[operation.configAt] as MCPServerConfig | undefined;
        const info: McpRequestSpanInfo = {
          method: operation.method,
          side: "client",
          ...(operation.target ? operation.target(args) : {}),
          ...(config ? transportFacts(adapterId, config) : {}),
          ...(config ? { serverId: config.registryServerId ?? config.serverId } : {})
        };
        return instrument.mcpRequest(info, async (span) => {
          try {
            const result: unknown = await (value as (...callArgs: unknown[]) => Promise<unknown>).apply(target, args);
            if (property === "invokeTool" && result && typeof result === "object") recordToolResult(span, result as MCPToolResult);
            return result;
          } catch (error) {
            recordMcpFailure(span, error);
            throw error;
          }
        });
      };
    }
  });
}

/**
 * A registry whose adapters are instrumented, including adapters registered later (community packages). Built by
 * `createInstrumentedMCPRegistry` or by `createDefaultMCPRegistry({ instrument })`.
 */
export class InstrumentedMCPRegistry extends MCPRegistry {
  constructor(readonly instrument: RunInstrumentation) {
    super();
  }

  override register(adapter: MCPServerAdapter): void {
    super.register(instrumentMcpAdapter(adapter, this.instrument));
  }
}

/**
 * `base`'s adapters behind CLIENT spans (`{mcp.method.name} {target}`). With the no-op instrumentation `base` itself
 * is returned, so nothing changes while tracing is off.
 */
export function createInstrumentedMCPRegistry(base: MCPRegistry, instrument: RunInstrumentation): MCPRegistry {
  if (!instrument.enabled || base instanceof InstrumentedMCPRegistry) return base;
  const registry = new InstrumentedMCPRegistry(instrument);
  for (const adapter of base.list()) registry.register(adapter);
  return registry;
}
