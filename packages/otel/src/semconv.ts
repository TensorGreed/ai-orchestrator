/**
 * Every attribute and span name L2M emits, in one place, so a move to newer semantic conventions is one small diff.
 *
 * Pinned to semantic-conventions v1.41.0, the last release that carries the GenAI and MCP text (both still in
 * Development status). Stable names (HTTP, URL, service, deployment, error) come from the package; GenAI, MCP and
 * L2M names are string literals because they are not in its stable entry point.
 */
import {
  GATEWAY_SPAN_ATTRIBUTES as GATEWAY_ATTRS,
  MCP_OUTCOME_ATTRIBUTES as MCP_OUTCOME,
  SPAN_OUTCOME_ATTRIBUTES as OUTCOME
} from "@ai-orchestrator/shared";

export {
  ATTR_CLIENT_ADDRESS,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_ERROR_TYPE,
  ATTR_EXCEPTION_MESSAGE,
  ATTR_EXCEPTION_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_REQUEST_METHOD_ORIGINAL,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_URL_PATH,
  ATTR_URL_SCHEME
} from "@opentelemetry/semantic-conventions";

export const SEMCONV_VERSION = "1.41.0";
export const SEMCONV_SCHEMA_URL = `https://opentelemetry.io/schemas/${SEMCONV_VERSION}`;
/** The instrumentation scope every L2M span and metric is recorded under. */
export const INSTRUMENTATION_SCOPE = "l2m";

/** Incubating resource attributes (literal: not in the stable entry point). */
export const ATTR_HOST_NAME = "host.name";
export const ATTR_PROCESS_PID = "process.pid";

/** GenAI conventions (Development, v1.41.0). */
export const GEN_AI = {
  OPERATION_NAME: "gen_ai.operation.name",
  PROVIDER_NAME: "gen_ai.provider.name",
  REQUEST_MODEL: "gen_ai.request.model",
  REQUEST_STREAM: "gen_ai.request.stream",
  REQUEST_TEMPERATURE: "gen_ai.request.temperature",
  REQUEST_MAX_TOKENS: "gen_ai.request.max_tokens",
  RESPONSE_MODEL: OUTCOME.RESPONSE_MODEL,
  RESPONSE_ID: OUTCOME.RESPONSE_ID,
  RESPONSE_FINISH_REASONS: OUTCOME.RESPONSE_FINISH_REASONS,
  EMBEDDINGS_DIMENSION_COUNT: OUTCOME.EMBEDDINGS_DIMENSION_COUNT,
  TOKEN_TYPE: "gen_ai.token.type",
  TOKEN_MODALITY: "gen_ai.token.modality",
  USAGE_INPUT_TOKENS: OUTCOME.USAGE_INPUT_TOKENS,
  USAGE_OUTPUT_TOKENS: OUTCOME.USAGE_OUTPUT_TOKENS,
  USAGE_CACHE_READ_INPUT_TOKENS: OUTCOME.USAGE_CACHE_READ_INPUT_TOKENS,
  CONVERSATION_ID: "gen_ai.conversation.id",
  AGENT_ID: "gen_ai.agent.id",
  AGENT_NAME: "gen_ai.agent.name",
  TOOL_NAME: "gen_ai.tool.name",
  TOOL_CALL_ID: "gen_ai.tool.call.id",
  TOOL_TYPE: "gen_ai.tool.type",
  PROMPT_NAME: "gen_ai.prompt.name"
} as const;

/** `gen_ai.operation.name` values. */
export const GEN_AI_OPERATION = {
  CHAT: "chat",
  EMBEDDINGS: "embeddings",
  TEXT_COMPLETION: "text_completion",
  EXECUTE_TOOL: "execute_tool",
  INVOKE_AGENT: "invoke_agent",
  INVOKE_WORKFLOW: "invoke_workflow"
} as const;

/** MCP conventions (Development, v1.41.0). The outcome names come from the shared module the adapters use. */
export const MCP = {
  METHOD_NAME: "mcp.method.name",
  SESSION_ID: MCP_OUTCOME.SESSION_ID,
  PROTOCOL_VERSION: MCP_OUTCOME.PROTOCOL_VERSION,
  JSONRPC_REQUEST_ID: MCP_OUTCOME.JSONRPC_REQUEST_ID,
  RESOURCE_URI: "mcp.resource.uri",
  RPC_RESPONSE_STATUS_CODE: MCP_OUTCOME.RPC_RESPONSE_STATUS_CODE,
  NETWORK_TRANSPORT: "network.transport",
  NETWORK_PROTOCOL_NAME: "network.protocol.name"
} as const;

/** MCP metrics (Development, v1.41.0): histograms in seconds. */
export const MCP_METRICS = {
  CLIENT_OPERATION_DURATION: "mcp.client.operation.duration",
  SERVER_OPERATION_DURATION: "mcp.server.operation.duration"
} as const;

/** The bucket boundaries the MCP conventions advise for the operation duration histograms. */
export const MCP_DURATION_BUCKETS_SECONDS: readonly number[] = Object.freeze([0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300]);

/** L2M's own attributes. Ids only: they link a span to L2M's execution history, never copy it. */
export const L2M = {
  REQUEST_ID: "l2m.request.id",
  EXECUTION_ID: "l2m.execution.id",
  WORKFLOW_ID: "l2m.workflow.id",
  WORKFLOW_NAME: "l2m.workflow.name",
  PROJECT_ID: "l2m.project.id",
  TRIGGER_TYPE: "l2m.trigger.type",
  RUN_MODE: "l2m.run.mode",
  REPLAY: "l2m.replay",
  NODE_ID: "l2m.node.id",
  NODE_TYPE: "l2m.node.type",
  NODE_NAME: "l2m.node.name",
  NODE_ATTEMPTS: OUTCOME.NODE_ATTEMPTS,
  NODE_STATUS: OUTCOME.NODE_STATUS,
  NODE_LOOP_INDEX: OUTCOME.NODE_LOOP_INDEX,
  RUN_STATUS: OUTCOME.RUN_STATUS,
  AGENT_ITERATION: "l2m.agent.iteration",
  AGENT_ITERATIONS: OUTCOME.AGENT_ITERATIONS,
  AGENT_STOP_REASON: OUTCOME.AGENT_STOP_REASON,
  AGENT_FINAL: OUTCOME.AGENT_FINAL,
  TOOL_OUTCOME: OUTCOME.TOOL_OUTCOME,
  CONTENT_RULES_OUTCOME: OUTCOME.CONTENT_RULES_OUTCOME,
  AGENT_SUPERVISOR: "l2m.agent.supervisor",
  PROVIDER_ID: "l2m.provider.id",
  TOOL_INTERNAL: "l2m.tool.internal",
  MCP_SERVER_ID: "l2m.mcp.server.id",
  LINK_REASON: "l2m.link.reason",
  RETRY_COUNT: OUTCOME.RETRY_COUNT,
  STREAM_CLOSED_EARLY: OUTCOME.STREAM_CLOSED_EARLY,
  USAGE_SOURCE: "l2m.usage.source",
  GATEWAY_REQUEST_ID: GATEWAY_ATTRS.REQUEST_ID,
  GATEWAY_ROUTE_SET_ID: GATEWAY_ATTRS.ROUTE_SET_ID,
  GATEWAY_ROUTE_ALIAS: GATEWAY_ATTRS.ROUTE_ALIAS,
  /** The calling client of the /v1 AI gateway or of the MCP gateway (same attribute on both). */
  GATEWAY_CLIENT_ID: GATEWAY_ATTRS.CLIENT_ID,
  GATEWAY_STATUS: GATEWAY_ATTRS.STATUS,
  MCP_ROUND: "l2m.mcp.round",
  MCP_ROUNDS: MCP_OUTCOME.ROUNDS,
  TOOLSET_ID: "l2m.toolset.id"
} as const;

/**
 * GenAI client metric names. `V1_41` is the pinned release (the default); `LATEST` is the genai conventions repository's
 * main branch (no release yet, checked 2026-11-12), used when OTEL_SEMCONV_STABILITY_OPT_IN has `gen_ai_latest_experimental`.
 */
export const GEN_AI_METRICS = {
  V1_41: {
    TOKEN_USAGE: "gen_ai.client.token.usage",
    OPERATION_DURATION: "gen_ai.client.operation.duration"
  },
  LATEST: {
    INFERENCE_DURATION: "gen_ai.client.inference.duration",
    INFERENCE_USAGE_INPUT_TOKENS: "gen_ai.client.inference.usage.input_tokens",
    INFERENCE_USAGE_OUTPUT_TOKENS: "gen_ai.client.inference.usage.output_tokens",
    INFERENCE_USAGE_CACHE_READ_INPUT_TOKENS: "gen_ai.client.inference.usage.cache_read.input_tokens",
    INFERENCE_OPERATION_INPUT_TOKENS: "gen_ai.client.inference.operation.input_tokens",
    INFERENCE_OPERATION_OUTPUT_TOKENS: "gen_ai.client.inference.operation.output_tokens",
    EMBEDDINGS_DURATION: "gen_ai.client.embeddings.duration",
    EMBEDDINGS_OPERATION_INPUT_TOKENS: "gen_ai.client.embeddings.operation.input_tokens"
  }
} as const;

/** L2M's spend counter, recorded where pricing is already applied (usage events and /v1 usage rows). */
export const L2M_COST_METRIC = "l2m.gen_ai.cost";

/**
 * L2M provider ids mapped to well-known `gen_ai.provider.name` values. An id with no entry is passed through as it
 * is; `openai_compatible` reports `openai` (the wire protocol) and keeps the id in `l2m.provider.id`.
 */
export const PROVIDER_NAME_BY_ID: Readonly<Record<string, string>> = Object.freeze({
  openai: "openai",
  openai_compatible: "openai",
  "openai-compatible": "openai",
  azure_openai: "azure.ai.openai",
  "azure-openai": "azure.ai.openai",
  anthropic: "anthropic",
  gemini: "gcp.gemini",
  ollama: "ollama"
});

export function genAiProviderName(providerId: string): string {
  return PROVIDER_NAME_BY_ID[providerId] ?? providerId;
}

/** HTTP methods kept as they are in `http.request.method`; anything else is `_OTHER`. */
export const KNOWN_HTTP_METHODS: ReadonlySet<string> = new Set(["CONNECT", "DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT", "QUERY", "TRACE"]);
