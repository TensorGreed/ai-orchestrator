/**
 * SERVER spans for the MCP gateway (`/mcp/:toolset`), one per JSON-RPC request, in both protocol eras.
 *
 * Trace context a caller puts in `params._meta` (`traceparent`, `tracestate`, `baggage`) wins over the HTTP header,
 * as the MCP conventions ask: under the inbound trust rule (L2M_OTEL_TRUST_INBOUND) it becomes the span's parent and
 * the HTTP server span is linked; with `none` it is only linked. Every request that reaches a span has passed the
 * gateway's admission (a valid client token), so `authenticated` and `all` both continue the caller's trace.
 *
 * Only ids and low-cardinality facts are recorded: the method, the tool name, the session, version and request id,
 * the toolset and client ids, and the outcome's JSON-RPC error code. Arguments and results never are.
 */
import { MCP_OUTCOME_ATTRIBUTES, type InstrumentationSpan, type McpRequestSpanInfo, type RunInstrumentation, type TraceCarrier } from "@ai-orchestrator/shared";
import type { InboundTrust } from "./settings.js";

export interface McpGatewayTracing {
  instrumentation: RunInstrumentation;
  trustInbound: InboundTrust;
}

/** Longest trace context value read from `_meta` (W3C allows 512 for tracestate; baggage up to 8192). */
const MAX_CARRIER_VALUE = 8192;
const TRACE_KEYS = ["traceparent", "tracestate", "baggage"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The trace context in a request's `params._meta`, or undefined when it carries no `traceparent`. */
export function traceCarrierFromMeta(params: unknown): TraceCarrier | undefined {
  const meta = isRecord(params) && isRecord(params._meta) ? params._meta : undefined;
  if (!meta || typeof meta.traceparent !== "string" || meta.traceparent.length > MAX_CARRIER_VALUE) return undefined;
  const carrier: TraceCarrier = {};
  for (const key of TRACE_KEYS) {
    const value = meta[key];
    if (typeof value === "string" && value.length <= MAX_CARRIER_VALUE) carrier[key] = value;
  }
  return carrier;
}

/** What the gateway knows about one request when its span starts. */
export interface GatewayRequestFacts {
  method: string;
  params: unknown;
  requestId?: string | number | null;
  era: "legacy" | "modern";
  /** Legacy only: the gateway session's id. */
  sessionId?: string;
  protocolVersion?: string;
  toolsetId: string;
  clientId: string;
}

export function gatewaySpanInfo(facts: GatewayRequestFacts, trustInbound: InboundTrust): McpRequestSpanInfo {
  const params = isRecord(facts.params) ? facts.params : {};
  const name = typeof params.name === "string" && (facts.method === "tools/call" || facts.method === "prompts/get") ? params.name : undefined;
  const carrier = traceCarrierFromMeta(facts.params);
  return {
    method: facts.method,
    side: "server",
    ...(name ? { target: name } : {}),
    ...(facts.era === "legacy" && facts.sessionId ? { sessionId: facts.sessionId } : {}),
    ...(facts.protocolVersion ? { protocolVersion: facts.protocolVersion } : {}),
    ...(facts.requestId !== undefined && facts.requestId !== null ? { requestId: facts.requestId } : {}),
    transport: "tcp",
    networkProtocol: "http",
    toolsetId: facts.toolsetId,
    gatewayClientId: facts.clientId,
    ...(carrier ? { remoteParent: { carrier, use: trustInbound === "none" ? "link" : "parent" } } : {})
  };
}

/**
 * The outcome of a JSON-RPC response on its span: a JSON-RPC error's code (`error.type` and `rpc.response.status_code`),
 * or `tool_error` for a tool result with `isError`. Never the message or the content.
 */
export function recordGatewayOutcome(span: InstrumentationSpan, response: unknown): void {
  if (!isRecord(response)) return;
  if (isRecord(response.error) && typeof response.error.code === "number") {
    const code = String(response.error.code);
    span.setAttributes({ [MCP_OUTCOME_ATTRIBUTES.RPC_RESPONSE_STATUS_CODE]: code });
    span.recordError(null, { type: code });
    return;
  }
  if (isRecord(response.result) && response.result.isError === true) span.recordError(null, { type: "tool_error" });
}

/** Runs `fn` (the request's dispatch) in its SERVER span; without tracing it runs `fn` as it is. */
export async function traceGatewayRequest<T>(tracing: McpGatewayTracing | undefined, facts: GatewayRequestFacts, fn: () => Promise<T>): Promise<T> {
  if (!tracing?.instrumentation.enabled) return await fn();
  return await tracing.instrumentation.mcpRequest(gatewaySpanInfo(facts, tracing.trustInbound), async (span) => {
    const response = await fn();
    recordGatewayOutcome(span, response);
    return response;
  });
}
