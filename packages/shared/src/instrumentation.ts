/**
 * Run instrumentation: the seam the engine, the agent runtime and the SDK packages call to describe their work as
 * trace spans. It has no OpenTelemetry dependency. `packages/otel` implements it over the OpenTelemetry SDK, and the
 * API passes that implementation in only when tracing is configured; everywhere else the no-op below is used, which
 * calls the wrapped function and allocates nothing.
 *
 * Callers pass ids and low-cardinality facts only (never headers or secrets, and prompts, tool arguments and results only
 * through `addContent`, which the implementation masks and accepts only while content capture is on). Each
 * wrapper runs `fn` with the new span as the active one, so spans started inside it (a model call inside an agent
 * turn, an MCP request inside a tool call) become its children.
 */

export type InstrumentationAttributeValue = string | number | boolean | readonly string[] | readonly number[] | readonly boolean[];

/** Attributes to set; `null` and `undefined` values are skipped, so optional facts can be passed as they are. */
export type InstrumentationAttributes = Record<string, InstrumentationAttributeValue | null | undefined>;

/**
 * W3C trace-context carrier: `traceparent` and, when present, `tracestate`. It is what goes into outbound HTTP
 * headers, MCP `params._meta`, queue payloads and persisted run state.
 */
export type TraceCarrier = Record<string, string>;

/** The ids of a span, as written into log lines and carriers. */
export interface TraceIds {
  traceId: string;
  spanId: string;
  /** W3C trace flags as two hex digits (`01` = sampled). */
  traceFlags: string;
  /** `00-<traceId>-<spanId>-<flags>`. */
  traceparent: string;
}

export interface InstrumentationSpan {
  /** False for the no-op span and for spans the sampler dropped: attribute work can be skipped. */
  readonly recording: boolean;
  /** Empty strings for the no-op span. */
  readonly traceId: string;
  readonly spanId: string;
  setAttributes(attributes: InstrumentationAttributes): void;
  /**
   * Marks the span as failed: status ERROR and `error.type` (the given low-cardinality type, else the error's class
   * name). The message is scrubbed before it is recorded; stack traces never are.
   */
  recordError(error: unknown, options?: { type?: string }): void;
  /**
   * Keeps the span open after the wrapped function returns, for work that outlives it (a stream that is still
   * being read). The caller must then call `end()`.
   */
  keepOpen(): void;
  /** Ends the span. Idempotent. Wrapped calls end their span when `fn` settles unless `keepOpen()` was called. */
  end(): void;
  /**
   * True only while the deployment captures content (OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT) and this span records.
   * Callers build content for `addContent` only then, so nothing is built while capture is off. Absent means false.
   */
  readonly capturesContent?: boolean;
  /**
   * Hands the implementation content for this span (messages, tool arguments, a tool result). It is never set as it
   * is: the implementation drops it for sensitive work, and otherwise removes secrets, masks it with content rules and
   * truncates it before the span is exported, dropping it on any failure. A no-op unless `capturesContent`.
   */
  addContent?(kind: InstrumentationContentKind, value: unknown): void;
}

/** What content a span can carry when capture is on (the GenAI conventions' opt-in content attributes). */
export type InstrumentationContentKind =
  | "system_instructions"
  | "input_messages"
  | "output_messages"
  | "tool_definitions"
  | "tool_call_arguments"
  | "tool_call_result";

/** The attribute each kind of content is exported under (semantic conventions v1.41.0). */
export const CONTENT_ATTRIBUTES: Readonly<Record<InstrumentationContentKind, string>> = Object.freeze({
  system_instructions: "gen_ai.system_instructions",
  input_messages: "gen_ai.input.messages",
  output_messages: "gen_ai.output.messages",
  tool_definitions: "gen_ai.tool.definitions",
  tool_call_arguments: "gen_ai.tool.call.arguments",
  tool_call_result: "gen_ai.tool.call.result"
});

/**
 * Set instead of content when content was withheld: `sensitive`, `sensitive_memory`, `masking_failed`, `timeout`,
 * `backpressure`, ...
 */
export const CONTENT_DROPPED_ATTRIBUTE = "l2m.content.dropped";

/**
 * The drop reason of a run that read session memory, a session tool cache record or a session artifact written by
 * sensitive work (v73 `sensitive` column): the rest of that run exports no content.
 */
export const CONTENT_DROPPED_SENSITIVE_MEMORY = "sensitive_memory";

/**
 * v74 — the drop reason of a run that started from content of an earlier run that was sensitive work: an error
 * workflow's input from such a run, pinned data copied from such a run, or node outputs copied from it (a retry, a
 * single-node run). The rest of that run exports no content.
 */
export const CONTENT_DROPPED_SENSITIVE_RUN_DATA = "sensitive_run_data";

/**
 * v74 — the drop reason of a run that retrieved a knowledge base chunk written by sensitive work: the rest of that run
 * exports no content.
 */
export const CONTENT_DROPPED_SENSITIVE_KNOWLEDGE = "sensitive_knowledge";

/**
 * What a content exclusion check answers: false (not sensitive), true (sensitive, dropped as `sensitive`), or the drop
 * reason to record (lower-case letters and underscores, at most 40; anything else is recorded as `sensitive`).
 */
export type ContentSensitivity = boolean | string;

export interface RunSpanInfo {
  /** The run's execution id; a sub-workflow's child run has none of its own (its span is a child of the caller's). */
  executionId?: string;
  workflowId: string;
  workflowName?: string;
  projectId?: string;
  /** manual, webhook, schedule, trigger, queue, chat, dispatch, replay, ... */
  triggerType?: string;
  runMode?: string;
  replay?: boolean;
  /** Earlier traces this run continues without being their child (an approval resume). */
  links?: readonly TraceCarrier[];
}

export interface NodeSpanInfo {
  nodeId: string;
  nodeType: string;
  nodeName?: string;
  attempt?: number;
}

export interface AgentSpanInfo {
  /** The Agent or Supervisor node's id (`gen_ai.agent.id`). */
  agentId: string;
  agentName?: string;
  /** The memory session id (`gen_ai.conversation.id`); scrubbed by the implementation. */
  sessionId?: string;
  supervisor?: boolean;
}

export interface AgentIterationSpanInfo {
  iteration: number;
}

export interface ModelCallSpanInfo {
  /** L2M provider id: openai, openai-compatible, azure-openai, anthropic, gemini, ollama, ... */
  providerId: string;
  model: string;
  operation?: "chat" | "embeddings" | "text_completion";
  stream?: boolean;
  temperature?: number;
  maxTokens?: number;
  /** Host only, never a URL with a path, query or credentials. */
  serverAddress?: string;
  serverPort?: number;
}

export interface ToolCallSpanInfo {
  toolName: string;
  toolCallId?: string;
  /** `function` for local and internal tools, `extension` for MCP tools. */
  toolType?: "function" | "extension" | "datastore";
  internal?: boolean;
}

export interface McpRequestSpanInfo {
  /** JSON-RPC method: tools/call, tools/list, resources/read, ... */
  method: string;
  /** The tool (tools/call) or prompt (prompts/get) the method targets: it goes into the span name. */
  target?: string;
  /** resources/read: the resource URI (`mcp.resource.uri`); the implementation drops its query, fragment and credentials. */
  resourceUri?: string;
  /** `client` for L2M calling a server, `server` for the MCP gateway answering a client. */
  side?: "client" | "server";
  /** The registry id of the MCP server (never its URL). */
  serverId?: string;
  sessionId?: string;
  protocolVersion?: string;
  requestId?: string | number;
  transport?: "tcp" | "pipe";
  /** `http` for Streamable HTTP (`network.protocol.name`). */
  networkProtocol?: string;
  serverAddress?: string;
  serverPort?: number;
  /** Server side: the caller's address (`client.address`). */
  clientAddress?: string;
  /** Gateway (server side): the toolset and the MCP client the request came through. */
  toolsetId?: string;
  gatewayClientId?: string;
  /**
   * Client side: a later round of a multi round-trip request (2026-07-28), numbered from 2. Round 1 is the request's
   * own span; each later round is a child span of it.
   */
  round?: number;
  /**
   * Server side: the trace context the request carried in `params._meta`. `parent` makes it the span's parent (and
   * links the transport's span); `link` keeps the transport's span as parent and only links it (an untrusted caller).
   */
  remoteParent?: { carrier: TraceCarrier; use: "parent" | "link" };
}

/** Attribute names an MCP span's outcome is recorded under (the response's JSON-RPC error code, round count). */
export const MCP_OUTCOME_ATTRIBUTES = Object.freeze({
  RPC_RESPONSE_STATUS_CODE: "rpc.response.status_code",
  ERROR_TYPE: "error.type",
  SESSION_ID: "mcp.session.id",
  PROTOCOL_VERSION: "mcp.protocol.version",
  JSONRPC_REQUEST_ID: "jsonrpc.request.id",
  ROUNDS: "l2m.mcp.rounds",
  /** A gateway `subscriptions/listen` request that did not become a stream: `caller_gone` (it hung up during admission). */
  LISTEN_OUTCOME: "l2m.mcp.listen.outcome"
} as const);

/**
 * A span opened without running anything in it, for work that is not one function: a workflow node or an agent turn
 * with many exits. `enter(fn)` runs `fn` with this span active, so spans started inside become its children; it does
 * not end the span or record errors. The caller owns the end (in a `finally`) and sets the outcome itself.
 */
export interface ScopedInstrumentationSpan extends InstrumentationSpan {
  enter<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Attribute names the engine and the agent runtime set themselves, for outcomes known only when the work ends.
 * `packages/otel`'s semconv module takes them from here, so each name still has one source.
 */
export const SPAN_OUTCOME_ATTRIBUTES = Object.freeze({
  RUN_STATUS: "l2m.run.status",
  NODE_STATUS: "l2m.node.status",
  NODE_ATTEMPTS: "l2m.node.attempts",
  NODE_LOOP_INDEX: "l2m.node.loop_index",
  AGENT_ITERATIONS: "l2m.agent.iterations",
  AGENT_STOP_REASON: "l2m.agent.stop_reason",
  AGENT_FINAL: "l2m.agent.final",
  USAGE_INPUT_TOKENS: "gen_ai.usage.input_tokens",
  USAGE_OUTPUT_TOKENS: "gen_ai.usage.output_tokens",
  USAGE_CACHE_READ_INPUT_TOKENS: "gen_ai.usage.cache_read.input_tokens",
  TOOL_OUTCOME: "l2m.tool.outcome",
  CONTENT_RULES_OUTCOME: "l2m.content_rules.outcome",
  RESPONSE_MODEL: "gen_ai.response.model",
  RESPONSE_ID: "gen_ai.response.id",
  RESPONSE_FINISH_REASONS: "gen_ai.response.finish_reasons",
  EMBEDDINGS_DIMENSION_COUNT: "gen_ai.embeddings.dimension.count",
  RETRY_COUNT: "l2m.retry.count",
  /** A streamed answer its reader stopped reading before the provider finished it. */
  STREAM_CLOSED_EARLY: "l2m.stream.closed_early",
  /** A queue job attempt this worker stopped (a drain, or a lost lease): `requeued`, recorded as an outcome, not an error. */
  QUEUE_OUTCOME: "l2m.queue.outcome"
} as const);

/**
 * Attributes the /v1 AI gateway sets on its request's HTTP server span: ids that link the span to the gateway's usage
 * row (`ai_gateway_requests`) and the outcome, never the prompt or the answer.
 */
export const GATEWAY_SPAN_ATTRIBUTES = Object.freeze({
  REQUEST_ID: "l2m.gateway.request.id",
  ROUTE_SET_ID: "l2m.gateway.route_set.id",
  ROUTE_ALIAS: "l2m.gateway.route.alias",
  CLIENT_ID: "l2m.gateway.client.id",
  /** The usage row's status (`ok`, `upstream_error`, `blocked_prompt`, ...) or the refusal (`rate_limited`, `budget_blocked`, ...). */
  STATUS: "l2m.gateway.status"
} as const);

/**
 * One model call as the metrics see it, reported by the instrumented provider registries when the call ends. Ids and
 * counts only; `packages/otel` turns it into the GenAI duration and token metrics.
 */
export interface ModelCallObservation {
  operation: "chat" | "embeddings";
  /** L2M provider id. */
  providerId: string;
  /** The model the provider was sent. */
  requestModel: string;
  /** The model the provider said answered, when it said. */
  responseModel?: string;
  serverAddress?: string;
  serverPort?: number;
  stream: boolean;
  durationMs: number;
  /** Token counts the provider reported (none when it reported none). */
  usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number };
  /** Set when the call failed: a low-cardinality type, never the error's text. */
  errorType?: string;
}

/** A priced model spend, reported after its usage row was written (the row stays the record). */
export interface ModelCostObservation {
  providerId: string;
  model: string;
  projectId?: string | null;
  costUsd: number;
  /** `run` (a workflow run's usage event) or `ai_gateway` (a /v1 request). */
  source: "run" | "ai_gateway";
}

export type InstrumentationSpanKind = "internal" | "server" | "client" | "producer" | "consumer";

/** A span the typed wrappers do not cover (queue messages, gateway requests). */
export interface GenericSpanInfo {
  name: string;
  kind?: InstrumentationSpanKind;
  attributes?: InstrumentationAttributes;
  links?: readonly TraceCarrier[];
}

/** Where a carrier is going: the implementation decides from the deployment's settings whether to fill it. */
export type TraceInjectTarget = "mcp" | "provider" | "queue" | "state" | "http";

export interface RunInstrumentation {
  /** False for the no-op. */
  readonly enabled: boolean;
  run<T>(info: RunSpanInfo, fn: (span: InstrumentationSpan) => Promise<T>): Promise<T>;
  node<T>(info: NodeSpanInfo, fn: (span: InstrumentationSpan) => Promise<T>): Promise<T>;
  agent<T>(info: AgentSpanInfo, fn: (span: InstrumentationSpan) => Promise<T>): Promise<T>;
  /** One agent loop turn. Only recorded at the verbose span detail; otherwise `fn` runs with a no-op span. */
  iteration<T>(info: AgentIterationSpanInfo, fn: (span: InstrumentationSpan) => Promise<T>): Promise<T>;
  modelCall<T>(info: ModelCallSpanInfo, fn: (span: InstrumentationSpan) => Promise<T>): Promise<T>;
  toolCall<T>(info: ToolCallSpanInfo, fn: (span: InstrumentationSpan) => Promise<T>): Promise<T>;
  mcpRequest<T>(info: McpRequestSpanInfo, fn: (span: InstrumentationSpan) => Promise<T>): Promise<T>;
  span<T>(info: GenericSpanInfo, fn: (span: InstrumentationSpan) => Promise<T>): Promise<T>;
  /**
   * Opens a node span (see `ScopedInstrumentationSpan`) under `parent`, or under the active span when `parent` is
   * absent or the no-op. The caller must end it.
   */
  startNode(info: NodeSpanInfo, parent?: InstrumentationSpan): ScopedInstrumentationSpan;
  /** Opens an agent-turn span; the no-op unless the span detail is verbose. The caller must end it. */
  startIteration(info: AgentIterationSpanInfo, parent?: InstrumentationSpan): ScopedInstrumentationSpan;
  /** Opens an `execute_tool` span. The caller must end it. */
  startToolCall(info: ToolCallSpanInfo, parent?: InstrumentationSpan): ScopedInstrumentationSpan;
  /** Sets attributes on the active span (for example the HTTP server span of a gateway request). */
  annotate(attributes: InstrumentationAttributes): void;
  /**
   * Writes the active span's `traceparent` (and `tracestate`) into `carrier` when propagation to `target` is on.
   * Returns true when something was written.
   */
  inject(carrier: TraceCarrier, target: TraceInjectTarget): boolean;
  /** Runs `fn` with the remote span in `carrier` as the parent; a missing or malformed carrier leaves the context as it is. */
  withParent<T>(carrier: TraceCarrier | null | undefined, fn: () => T): T;
  /**
   * Runs `fn` with no active span, so what it starts is a new trace root. Timers and queue polls inherit the context of
   * whatever created them (a request that saved a schedule); a schedule fire, a trigger event or a queue job starts here
   * instead of inside that request's trace.
   */
  withNewTrace<T>(fn: () => T): T;
  /** The active span's ids, or null when there is none (or tracing is off). */
  activeTraceIds(): TraceIds | null;
  /** True while content capture is on (see `InstrumentationSpan.capturesContent`). Absent means false. */
  readonly capturesContent?: boolean;
  /**
   * Runs `fn` with `isSensitive` checked for every span started inside it (and their children): while it returns true
   * or a drop reason, or if it throws, those spans export no content. Callers whose work can hold sensitive data (a run
   * with a sensitive-labelled node, an agent loop that read a sensitive result) wrap it in this. Checks nest: an outer
   * one still applies inside an inner one.
   */
  withContentExclusion?<T>(isSensitive: () => ContentSensitivity, fn: () => T): T;
}

const NOOP_SPAN: InstrumentationSpan = Object.freeze({
  recording: false,
  traceId: "",
  spanId: "",
  setAttributes: () => undefined,
  recordError: () => undefined,
  keepOpen: () => undefined,
  end: () => undefined,
  capturesContent: false,
  addContent: () => undefined
});

const NOOP_SCOPED_SPAN: ScopedInstrumentationSpan = Object.freeze({
  ...NOOP_SPAN,
  enter: <T>(fn: () => Promise<T>): Promise<T> => fn()
});

const openNothing = (): ScopedInstrumentationSpan => NOOP_SCOPED_SPAN;

const passThrough = <T>(_info: unknown, fn: (span: InstrumentationSpan) => Promise<T>): Promise<T> => fn(NOOP_SPAN);

/** The no-op instrumentation: every wrapper calls `fn` with a frozen no-op span; nothing is recorded or allocated. */
export const NOOP_RUN_INSTRUMENTATION: RunInstrumentation = Object.freeze({
  enabled: false,
  run: passThrough,
  node: passThrough,
  agent: passThrough,
  iteration: passThrough,
  modelCall: passThrough,
  toolCall: passThrough,
  mcpRequest: passThrough,
  span: passThrough,
  startNode: openNothing,
  startIteration: openNothing,
  startToolCall: openNothing,
  annotate: () => undefined,
  inject: () => false,
  withParent: <T>(_carrier: TraceCarrier | null | undefined, fn: () => T): T => fn(),
  withNewTrace: <T>(fn: () => T): T => fn(),
  activeTraceIds: () => null,
  capturesContent: false,
  withContentExclusion: <T>(_isSensitive: () => ContentSensitivity, fn: () => T): T => fn()
});

/** The no-op span, for callers that need one outside a wrapper. */
export const NOOP_INSTRUMENTATION_SPAN: InstrumentationSpan = NOOP_SPAN;

/** The no-op scoped span: `enter` calls `fn`, nothing else happens. */
export const NOOP_SCOPED_INSTRUMENTATION_SPAN: ScopedInstrumentationSpan = NOOP_SCOPED_SPAN;

const TRACEPARENT_PATTERN = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(?:-.*)?$/;

/**
 * Parses a W3C `traceparent` value. Version `ff`, all-zero ids and malformed values give null; a future version is
 * read by its first four fields, as the spec asks, but version `00` must have exactly four.
 */
export function parseTraceparentHeader(value: string | null | undefined): { traceId: string; spanId: string; sampled: boolean; traceFlags: string } | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const match = TRACEPARENT_PATTERN.exec(text);
  if (!match) return null;
  const [, version, traceId, spanId, flags] = match as unknown as [string, string, string, string, string];
  if (version === "ff") return null;
  if (version === "00" && text.length !== 55) return null;
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
  return { traceId, spanId, sampled: (parseInt(flags, 16) & 0x01) === 1, traceFlags: flags };
}

/** The longest `tracestate` kept from stored or queued data (the W3C limit is 512 characters). */
const MAX_TRACESTATE_LENGTH = 512;

/**
 * Reads a trace carrier out of stored JSON (a queue payload, a paused run's state): only a valid `traceparent` and a
 * bounded `tracestate` are kept, so a hand-edited row can never put anything else on a span link or a parent.
 */
export function readTraceCarrier(value: unknown): TraceCarrier | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { traceparent, tracestate } = value as { traceparent?: unknown; tracestate?: unknown };
  if (typeof traceparent !== "string" || !parseTraceparentHeader(traceparent)) return undefined;
  return {
    traceparent,
    ...(typeof tracestate === "string" && tracestate.length > 0 && tracestate.length <= MAX_TRACESTATE_LENGTH ? { tracestate } : {})
  };
}
