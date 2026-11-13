import { ValueType, type AttributeValue, type Histogram, type Meter } from "@opentelemetry/api";
import type { InstrumentationAttributes, McpRequestSpanInfo } from "@ai-orchestrator/shared";
import {
  ATTR_CLIENT_ADDRESS,
  ATTR_ERROR_TYPE,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  GEN_AI,
  GEN_AI_OPERATION,
  L2M,
  MCP,
  MCP_DURATION_BUCKETS_SECONDS,
  MCP_METRICS
} from "./semconv.js";

/** Longest tool or prompt name used in a span name; longer names (a gateway caller can send anything) are cut. */
const MAX_TARGET_CHARS = 128;
/** Longest resource URI recorded. */
const MAX_URI_CHARS = 256;

/**
 * A resource URI fit for `mcp.resource.uri`: credentials, query and fragment removed, scrubbed and cut. A value that
 * does not parse as a URI is scrubbed and cut only.
 */
export function sanitizeResourceUri(uri: string, scrub: (text: string) => string): string {
  let text = uri;
  try {
    const url = new URL(uri);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    text = url.toString();
  } catch {
    text = uri.split(/[?#]/, 1)[0] ?? "";
  }
  return scrub(text).slice(0, MAX_URI_CHARS);
}

/** The span name and attributes of an MCP request (MCP semantic conventions, v1.41.0). */
export function mcpSpanSpec(info: McpRequestSpanInfo, scrub: (text: string) => string): { name: string; attributes: InstrumentationAttributes } {
  const server = info.side === "server";
  const target = info.target ? scrub(info.target).slice(0, MAX_TARGET_CHARS) : undefined;
  const tool = info.method === "tools/call" ? target : undefined;
  return {
    name: target && (info.method === "tools/call" || info.method === "prompts/get") ? `${info.method} ${target}` : info.method,
    attributes: {
      [MCP.METHOD_NAME]: info.method,
      [GEN_AI.OPERATION_NAME]: tool ? GEN_AI_OPERATION.EXECUTE_TOOL : undefined,
      [GEN_AI.TOOL_NAME]: tool,
      [GEN_AI.PROMPT_NAME]: info.method === "prompts/get" ? target : undefined,
      [MCP.RESOURCE_URI]: info.resourceUri ? sanitizeResourceUri(info.resourceUri, scrub) : undefined,
      [MCP.SESSION_ID]: info.sessionId,
      [MCP.PROTOCOL_VERSION]: info.protocolVersion,
      [MCP.JSONRPC_REQUEST_ID]: info.requestId === undefined ? undefined : String(info.requestId),
      [MCP.NETWORK_TRANSPORT]: info.transport,
      [MCP.NETWORK_PROTOCOL_NAME]: info.networkProtocol,
      [ATTR_SERVER_ADDRESS]: server ? undefined : info.serverAddress,
      [ATTR_SERVER_PORT]: server || !info.serverAddress ? undefined : info.serverPort,
      [ATTR_CLIENT_ADDRESS]: server ? info.clientAddress : undefined,
      [L2M.MCP_SERVER_ID]: info.serverId,
      [L2M.TOOLSET_ID]: info.toolsetId,
      [L2M.GATEWAY_CLIENT_ID]: info.gatewayClientId,
      [L2M.MCP_ROUND]: info.round
    }
  };
}

/**
 * Attributes copied onto the operation duration metric. Ids never are (cardinality). Tool and prompt names are on
 * the client metric only: the gateway's callers can send any name.
 */
export const MCP_CLIENT_METRIC_KEYS: readonly string[] = [
  MCP.METHOD_NAME,
  GEN_AI.OPERATION_NAME,
  GEN_AI.TOOL_NAME,
  GEN_AI.PROMPT_NAME,
  MCP.PROTOCOL_VERSION,
  MCP.NETWORK_TRANSPORT,
  MCP.NETWORK_PROTOCOL_NAME,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  MCP.RPC_RESPONSE_STATUS_CODE,
  ATTR_ERROR_TYPE
];
export const MCP_SERVER_METRIC_KEYS: readonly string[] = [
  MCP.METHOD_NAME,
  GEN_AI.OPERATION_NAME,
  MCP.PROTOCOL_VERSION,
  MCP.NETWORK_TRANSPORT,
  MCP.NETWORK_PROTOCOL_NAME,
  MCP.RPC_RESPONSE_STATUS_CODE,
  ATTR_ERROR_TYPE
];

/** Attributes MCP clients report about their request through `annotate`; they are set on MCP spans only. */
export const MCP_REQUEST_KEYS: ReadonlySet<string> = new Set([
  MCP.SESSION_ID,
  MCP.PROTOCOL_VERSION,
  MCP.JSONRPC_REQUEST_ID,
  MCP.RPC_RESPONSE_STATUS_CODE,
  L2M.MCP_ROUNDS
]);

/**
 * A metric attribute value. A JSON-RPC code comes from the server, so outside the range JSON-RPC reserves
 * (-32768 to -32000, which holds every MCP code) it is recorded as `_OTHER` to keep series bounded.
 */
export function metricValue(key: string, value: AttributeValue): AttributeValue {
  if (key !== MCP.RPC_RESPONSE_STATUS_CODE && key !== ATTR_ERROR_TYPE) return value;
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return value;
  const code = Number(value);
  return code >= -32768 && code <= -32000 ? value : "_OTHER";
}

/** The MCP operation duration histograms. */
export class McpMetrics {
  readonly client: Histogram;
  readonly server: Histogram;

  constructor(meter: Meter) {
    const advice = { explicitBucketBoundaries: [...MCP_DURATION_BUCKETS_SECONDS] };
    this.client = meter.createHistogram(MCP_METRICS.CLIENT_OPERATION_DURATION, {
      description: "Duration of MCP requests L2M sends to MCP servers",
      unit: "s",
      valueType: ValueType.DOUBLE,
      advice
    });
    this.server = meter.createHistogram(MCP_METRICS.SERVER_OPERATION_DURATION, {
      description: "Duration of MCP requests the MCP gateway answers",
      unit: "s",
      valueType: ValueType.DOUBLE,
      advice
    });
  }
}
