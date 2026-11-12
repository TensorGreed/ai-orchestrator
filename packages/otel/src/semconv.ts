/**
 * Every attribute and span name L2M emits, in one place, so a move to newer semantic conventions is one small diff.
 *
 * Pinned to semantic-conventions v1.41.0, the last release that carries the GenAI and MCP text (both still in
 * Development status). Stable names (HTTP, URL, service, deployment, error) come from the package; GenAI, MCP and
 * L2M names are string literals because they are not in its stable entry point.
 */
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
  RESPONSE_MODEL: "gen_ai.response.model",
  RESPONSE_ID: "gen_ai.response.id",
  RESPONSE_FINISH_REASONS: "gen_ai.response.finish_reasons",
  USAGE_INPUT_TOKENS: "gen_ai.usage.input_tokens",
  USAGE_OUTPUT_TOKENS: "gen_ai.usage.output_tokens",
  USAGE_CACHE_READ_INPUT_TOKENS: "gen_ai.usage.cache_read.input_tokens",
  CONVERSATION_ID: "gen_ai.conversation.id",
  AGENT_ID: "gen_ai.agent.id",
  AGENT_NAME: "gen_ai.agent.name",
  TOOL_NAME: "gen_ai.tool.name",
  TOOL_CALL_ID: "gen_ai.tool.call.id",
  TOOL_TYPE: "gen_ai.tool.type"
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

/** MCP conventions (Development, v1.41.0). */
export const MCP = {
  METHOD_NAME: "mcp.method.name",
  SESSION_ID: "mcp.session.id",
  PROTOCOL_VERSION: "mcp.protocol.version",
  JSONRPC_REQUEST_ID: "jsonrpc.request.id",
  NETWORK_TRANSPORT: "network.transport"
} as const;

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
  NODE_ATTEMPTS: "l2m.node.attempts",
  AGENT_ITERATION: "l2m.agent.iteration",
  AGENT_SUPERVISOR: "l2m.agent.supervisor",
  PROVIDER_ID: "l2m.provider.id",
  TOOL_INTERNAL: "l2m.tool.internal",
  MCP_SERVER_ID: "l2m.mcp.server.id",
  LINK_REASON: "l2m.link.reason"
} as const;

/**
 * L2M provider ids mapped to well-known `gen_ai.provider.name` values. An id with no entry is passed through as it
 * is; `openai-compatible` reports `openai` (the wire protocol) and keeps the id in `l2m.provider.id`.
 */
export const PROVIDER_NAME_BY_ID: Readonly<Record<string, string>> = Object.freeze({
  openai: "openai",
  "openai-compatible": "openai",
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
