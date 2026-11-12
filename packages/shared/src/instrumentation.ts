/**
 * Run instrumentation: the seam the engine, the agent runtime and the SDK packages call to describe their work as
 * trace spans. It has no OpenTelemetry dependency. `packages/otel` implements it over the OpenTelemetry SDK, and the
 * API passes that implementation in only when tracing is configured; everywhere else the no-op below is used, which
 * calls the wrapped function and allocates nothing.
 *
 * Callers pass ids and low-cardinality facts only (never prompts, tool arguments, results, headers or secrets). Each
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
}

export interface RunSpanInfo {
  executionId: string;
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
  /** The tool, prompt or resource the method targets. */
  target?: string;
  /** `client` for L2M calling a server, `server` for the MCP gateway answering a client. */
  side?: "client" | "server";
  /** The registry id of the MCP server (never its URL). */
  serverId?: string;
  sessionId?: string;
  protocolVersion?: string;
  requestId?: string | number;
  transport?: "tcp" | "pipe";
  serverAddress?: string;
  serverPort?: number;
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
  /** Sets attributes on the active span (for example the HTTP server span of a gateway request). */
  annotate(attributes: InstrumentationAttributes): void;
  /**
   * Writes the active span's `traceparent` (and `tracestate`) into `carrier` when propagation to `target` is on.
   * Returns true when something was written.
   */
  inject(carrier: TraceCarrier, target: TraceInjectTarget): boolean;
  /** Runs `fn` with the remote span in `carrier` as the parent; a missing or malformed carrier leaves the context as it is. */
  withParent<T>(carrier: TraceCarrier | null | undefined, fn: () => T): T;
  /** The active span's ids, or null when there is none (or tracing is off). */
  activeTraceIds(): TraceIds | null;
}

const NOOP_SPAN: InstrumentationSpan = Object.freeze({
  recording: false,
  traceId: "",
  spanId: "",
  setAttributes: () => undefined,
  recordError: () => undefined,
  keepOpen: () => undefined,
  end: () => undefined
});

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
  annotate: () => undefined,
  inject: () => false,
  withParent: <T>(_carrier: TraceCarrier | null | undefined, fn: () => T): T => fn(),
  activeTraceIds: () => null
});

/** The no-op span, for callers that need one outside a wrapper. */
export const NOOP_INSTRUMENTATION_SPAN: InstrumentationSpan = NOOP_SPAN;

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
