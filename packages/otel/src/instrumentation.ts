import crypto from "node:crypto";
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  defaultTextMapGetter,
  defaultTextMapSetter,
  isSpanContextValid,
  trace,
  type Attributes,
  type AttributeValue,
  type Context,
  type ContextManager,
  type Link,
  type Meter,
  type Span,
  type TextMapPropagator,
  type Tracer
} from "@opentelemetry/api";
import type {
  AgentIterationSpanInfo,
  InstrumentationContentKind,
  AgentSpanInfo,
  GenericSpanInfo,
  InstrumentationAttributes,
  InstrumentationSpan,
  InstrumentationSpanKind,
  McpRequestSpanInfo,
  ModelCallSpanInfo,
  NodeSpanInfo,
  RunInstrumentation,
  RunSpanInfo,
  ScopedInstrumentationSpan,
  ToolCallSpanInfo,
  TraceCarrier,
  TraceIds,
  TraceInjectTarget
} from "@ai-orchestrator/shared";
import { NOOP_INSTRUMENTATION_SPAN, NOOP_SCOPED_INSTRUMENTATION_SPAN } from "@ai-orchestrator/shared";
import type { OtelRuntimeOptions } from "./options.js";
import { CONTENT_EXCLUSION_KEY, ContentPipeline, composeExclusion, exclusionIn, type SpanContentBinding } from "./content.js";
import { MCP_CLIENT_METRIC_KEYS, MCP_REQUEST_KEYS, MCP_SERVER_METRIC_KEYS, McpMetrics, mcpSpanSpec, metricValue } from "./mcp.js";
import { ATTR_ERROR_TYPE, ATTR_EXCEPTION_MESSAGE, ATTR_EXCEPTION_TYPE, ATTR_SERVER_ADDRESS, ATTR_SERVER_PORT, GEN_AI, GEN_AI_OPERATION, L2M, MCP, genAiProviderName } from "./semconv.js";

const KINDS: Record<InstrumentationSpanKind, SpanKind> = {
  internal: SpanKind.INTERNAL,
  server: SpanKind.SERVER,
  client: SpanKind.CLIENT,
  producer: SpanKind.PRODUCER,
  consumer: SpanKind.CONSUMER
};

/** Longest error message recorded on a span (after scrubbing). */
const MAX_ERROR_MESSAGE = 1024;

/** Attributes without null/undefined values, arrays copied (OpenTelemetry wants plain arrays). */
export function cleanAttributes(attributes: InstrumentationAttributes | undefined): Attributes {
  const out: Attributes = {};
  if (!attributes) return out;
  for (const [key, value] of Object.entries(attributes)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    out[key] = (Array.isArray(value) ? [...value] : value) as AttributeValue;
  }
  return out;
}

/** A low-cardinality error type: the given one, an L2M `errorCategory`/`code`, else the error's class name. */
export function errorTypeOf(error: unknown, explicit?: string): string {
  if (explicit) return explicit;
  if (error && typeof error === "object") {
    const category = (error as { errorCategory?: unknown }).errorCategory;
    if (typeof category === "string" && category) return category;
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && name && name !== "Error") return name;
    const ctor = (error as { constructor?: { name?: unknown } }).constructor?.name;
    if (typeof ctor === "string" && ctor && ctor !== "Object") return ctor;
  }
  return "_OTHER";
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "";
}

const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE_LIKE = /^\+?[\d\s().-]{7,}$/;

/**
 * A session id as `gen_ai.conversation.id`: scrubbed, and replaced by a short hash when it looks like an email
 * address or a phone number (session ids can be user-supplied).
 */
export function conversationIdFor(sessionId: string, scrub: (text: string) => string): string {
  const scrubbed = scrub(sessionId);
  if (EMAIL_LIKE.test(scrubbed) || PHONE_LIKE.test(scrubbed.trim())) {
    return `sha256:${crypto.createHash("sha256").update(scrubbed).digest("hex").slice(0, 16)}`;
  }
  return scrubbed;
}

export class OtelSpanHandle implements InstrumentationSpan {
  private ended = false;
  private kept = false;

  constructor(
    readonly span: Span,
    private readonly scrub: (text: string) => string,
    /** Set only while content capture is on and this span may carry content. */
    readonly contentBinding?: SpanContentBinding
  ) {}

  get capturesContent(): boolean {
    return this.contentBinding !== undefined && !this.ended && this.span.isRecording();
  }

  addContent(kind: InstrumentationContentKind, value: unknown): void {
    if (!this.contentBinding || this.ended || !this.span.isRecording()) return;
    this.contentBinding.pipeline.add(this.span, this.contentBinding, kind, value);
  }

  get recording(): boolean {
    return this.span.isRecording();
  }

  get traceId(): string {
    return this.span.spanContext().traceId;
  }

  get spanId(): string {
    return this.span.spanContext().spanId;
  }

  get isKeptOpen(): boolean {
    return this.kept;
  }

  setAttributes(attributes: InstrumentationAttributes): void {
    if (this.ended || !this.span.isRecording()) return;
    this.span.setAttributes(cleanAttributes(attributes));
  }

  recordError(error: unknown, options: { type?: string } = {}): void {
    if (this.ended || !this.span.isRecording()) return;
    const type = errorTypeOf(error, options.type);
    const message = this.scrub(errorMessageOf(error)).slice(0, MAX_ERROR_MESSAGE);
    this.span.setAttribute(ATTR_ERROR_TYPE, type);
    this.span.addEvent("exception", {
      [ATTR_EXCEPTION_TYPE]: type,
      ...(message ? { [ATTR_EXCEPTION_MESSAGE]: message } : {})
    });
    this.span.setStatus({ code: SpanStatusCode.ERROR, ...(message ? { message } : {}) });
  }

  keepOpen(): void {
    this.kept = true;
  }

  /** Sets status OK (for callers that report success explicitly; most spans leave it UNSET). */
  markOk(): void {
    if (this.ended || !this.span.isRecording()) return;
    this.span.setStatus({ code: SpanStatusCode.OK });
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.span.end();
  }
}

/**
 * The span of one MCP request. Besides the span it keeps the attributes its duration metric needs (also for a span
 * the sampler dropped, which records nothing) and records the metric when it ends. A later round of a multi
 * round-trip request is not measured on its own: the request's span covers it.
 */
export class McpSpanHandle extends OtelSpanHandle {
  private readonly startedAt = performance.now();
  private readonly metricAttributes: Attributes = {};
  private measured = false;
  private errored = false;
  /** The JSON-RPC error code the server answered with, once seen: it is the request's `error.type`. */
  private rpcCode: string | undefined;

  constructor(
    span: Span,
    scrub: (text: string) => string,
    initial: InstrumentationAttributes,
    private readonly side: "client" | "server",
    private readonly metrics: McpMetrics | undefined,
    contentBinding?: SpanContentBinding
  ) {
    super(span, scrub, contentBinding);
    this.capture(initial);
  }

  private capture(attributes: InstrumentationAttributes): void {
    const code = attributes[MCP.RPC_RESPONSE_STATUS_CODE];
    if (code !== undefined && code !== null) this.rpcCode = String(code);
    if (!this.metrics) return;
    const clean = cleanAttributes(attributes);
    for (const key of this.side === "server" ? MCP_SERVER_METRIC_KEYS : MCP_CLIENT_METRIC_KEYS) {
      if (clean[key] !== undefined) this.metricAttributes[key] = metricValue(key, clean[key]);
    }
  }

  override setAttributes(attributes: InstrumentationAttributes): void {
    this.capture(attributes);
    super.setAttributes(attributes);
  }

  /**
   * The first outcome recorded wins: the MCP wrappers record the JSON-RPC code or failure kind (type only, no text),
   * and the generic recording of the error they then rethrow must not replace it or add the server's message.
   */
  override recordError(error: unknown, options: { type?: string } = {}): void {
    if (this.errored) return;
    this.errored = true;
    // A JSON-RPC error code seen during the request is its error type (MCP conventions), however the failure surfaced.
    const type = this.rpcCode ?? errorTypeOf(error, options.type);
    this.capture({ [ATTR_ERROR_TYPE]: type });
    super.recordError(error, { type });
  }

  override end(): void {
    if (!this.measured && this.metrics) {
      this.measured = true;
      const seconds = (performance.now() - this.startedAt) / 1000;
      (this.side === "server" ? this.metrics.server : this.metrics.client).record(seconds, this.metricAttributes);
    }
    super.end();
  }
}

/** A span the caller opened and enters for parts of its work (see `ScopedInstrumentationSpan`). */
export class OtelScopedSpan extends OtelSpanHandle implements ScopedInstrumentationSpan {
  constructor(
    span: Span,
    scrub: (text: string) => string,
    private readonly contextManager: ContextManager,
    contentBinding?: SpanContentBinding
  ) {
    super(span, scrub, contentBinding);
  }

  enter<T>(fn: () => Promise<T>): Promise<T> {
    // Only OpenTelemetry's own context changes: other async-local state of the caller stays as it is at the call.
    return this.contextManager.with(trace.setSpan(this.contextManager.active(), this.span), fn);
  }
}

export interface InstrumentationDeps {
  tracer: Tracer;
  contextManager: ContextManager;
  /** The deployment's OTEL_PROPAGATORS: used for HTTP, MCP and provider carriers and inbound requests. */
  propagator: TextMapPropagator;
  /**
   * W3C trace context, whatever OTEL_PROPAGATORS says: used for L2M's own hand-offs (queue payloads, persisted run
   * state, links, withParent), which must never lose their context.
   */
  internalPropagator: TextMapPropagator;
  options: Pick<OtelRuntimeOptions, "spanDetail" | "naming" | "propagateToProviders" | "propagateToMcp">;
  scrub: (text: string) => string;
  /** Where the MCP operation duration histograms are recorded; without one no MCP metric is recorded. */
  meter?: Meter;
  /** Content capture; absent while it is off (then no span accepts content). */
  content?: ContentPipeline;
}

export interface StartSpanSpec {
  name: string;
  kind?: InstrumentationSpanKind;
  attributes?: InstrumentationAttributes;
  links?: readonly TraceCarrier[];
  /** Parent context; default: the active one. */
  parent?: Context;
  /** The span may carry content (when capture is on); `inference` for a model call. */
  content?: "inference" | "tool";
}

/** Implements the shared `RunInstrumentation` seam over an OpenTelemetry tracer. */
export class OtelRunInstrumentation implements RunInstrumentation {
  readonly enabled = true;
  private readonly mcpMetrics: McpMetrics | undefined;
  /** Open MCP spans by their OpenTelemetry span, so `annotate` reaches their handle (and their metric). */
  private readonly mcpHandles = new WeakMap<Span, McpSpanHandle>();
  /** `execute_tool` spans that capture content: an MCP request made under one records none of its own. */
  private readonly toolContentSpans = new WeakSet<Span>();

  constructor(private readonly deps: InstrumentationDeps) {
    this.mcpMetrics = deps.meter ? new McpMetrics(deps.meter) : undefined;
  }

  /** Starts a span (not made active). */
  startSpan(spec: StartSpanSpec): OtelSpanHandle {
    const parent = spec.parent ?? this.deps.contextManager.active();
    const links = this.linksFrom(spec.links);
    const span = this.deps.tracer.startSpan(
      spec.name,
      {
        kind: KINDS[spec.kind ?? "internal"],
        attributes: cleanAttributes(spec.attributes),
        ...(links.length > 0 ? { links } : {})
      },
      parent
    );
    return new OtelSpanHandle(span, this.deps.scrub, this.contentBinding(spec.content, parent));
  }

  /** True while content capture is on. */
  get capturesContent(): boolean {
    return this.deps.content !== undefined;
  }

  /**
   * How a span started under `parent` queues content: with the sensitivity checks in force there. None while capture
   * is off, for spans that carry no content, for tool spans when only the inference event is recorded, outside any
   * `withContentExclusion` scope (work that did not declare how to tell it is sensitive captures nothing), and for an
   * MCP request made by an agent's tool call, whose `execute_tool` span already carries the result as the agent
   * kept it (after its labels and content rules).
   */
  private contentBinding(kind: "inference" | "tool" | undefined, parent: Context, mcpClient = false): SpanContentBinding | undefined {
    const pipeline = this.deps.content;
    if (!pipeline || !kind) return undefined;
    if (kind === "tool" && pipeline.mode === "EVENT_ONLY") return undefined;
    const exclusion = exclusionIn(parent);
    if (!exclusion) return undefined;
    if (mcpClient) {
      const parentSpan = trace.getSpan(parent);
      if (parentSpan && this.toolContentSpans.has(parentSpan)) return undefined;
    }
    return { pipeline, exclusion, inference: kind === "inference" };
  }

  withContentExclusion<T>(isSensitive: () => boolean, fn: () => T): T {
    if (!this.deps.content) return fn();
    const active = this.deps.contextManager.active();
    return this.deps.contextManager.with(active.setValue(CONTENT_EXCLUSION_KEY, composeExclusion(isSensitive, exclusionIn(active))), fn);
  }

  /** Runs `fn` with `handle`'s span active, ending it when `fn` settles unless it was kept open. */
  async within<T>(handle: OtelSpanHandle, fn: (span: InstrumentationSpan) => Promise<T>): Promise<T> {
    const context = trace.setSpan(this.deps.contextManager.active(), handle.span);
    try {
      return await this.deps.contextManager.with(context, () => fn(handle));
    } catch (error) {
      // A span kept open for work that outlives `fn` still ends when `fn` fails: nobody owns it then.
      handle.recordError(error);
      handle.end();
      throw error;
    } finally {
      if (!handle.isKeptOpen) handle.end();
    }
  }

  private wrap<T>(spec: StartSpanSpec, fn: (span: InstrumentationSpan) => Promise<T>): Promise<T> {
    return this.within(this.startSpan(spec), fn);
  }

  private named(name: string | undefined, id: string): string {
    return this.deps.options.naming === "names" && name ? name : id;
  }

  run<T>(info: RunSpanInfo, fn: (span: InstrumentationSpan) => Promise<T>): Promise<T> {
    const names = this.deps.options.naming === "names";
    return this.wrap(
      {
        name: `${GEN_AI_OPERATION.INVOKE_WORKFLOW} ${this.named(info.workflowName, info.workflowId)}`,
        attributes: {
          [GEN_AI.OPERATION_NAME]: GEN_AI_OPERATION.INVOKE_WORKFLOW,
          [L2M.EXECUTION_ID]: info.executionId,
          [L2M.WORKFLOW_ID]: info.workflowId,
          [L2M.WORKFLOW_NAME]: names ? info.workflowName : undefined,
          [L2M.PROJECT_ID]: info.projectId,
          [L2M.TRIGGER_TYPE]: info.triggerType,
          [L2M.RUN_MODE]: info.runMode,
          [L2M.REPLAY]: info.replay
        },
        ...(info.links ? { links: info.links } : {})
      },
      fn
    );
  }

  private nodeSpec(info: NodeSpanInfo): StartSpanSpec {
    return {
      name: `l2m.node ${info.nodeType}`,
      attributes: {
        [L2M.NODE_ID]: info.nodeId,
        [L2M.NODE_TYPE]: info.nodeType,
        [L2M.NODE_NAME]: this.deps.options.naming === "names" ? info.nodeName : undefined,
        [L2M.NODE_ATTEMPTS]: info.attempt
      }
    };
  }

  node<T>(info: NodeSpanInfo, fn: (span: InstrumentationSpan) => Promise<T>): Promise<T> {
    return this.wrap(this.nodeSpec(info), fn);
  }

  /** Opens a span that is not made active; `parent` (an L2M span) wins over the active context. */
  private open(spec: StartSpanSpec, parent: InstrumentationSpan | undefined): OtelScopedSpan {
    const active = this.deps.contextManager.active();
    const parentContext = parent instanceof OtelSpanHandle ? trace.setSpan(active, parent.span) : active;
    const handle = this.startSpan({ ...spec, parent: parentContext });
    return new OtelScopedSpan(handle.span, this.deps.scrub, this.deps.contextManager, handle.contentBinding);
  }

  startNode(info: NodeSpanInfo, parent?: InstrumentationSpan): ScopedInstrumentationSpan {
    return this.open(this.nodeSpec(info), parent);
  }

  startIteration(info: AgentIterationSpanInfo, parent?: InstrumentationSpan): ScopedInstrumentationSpan {
    if (this.deps.options.spanDetail !== "verbose") return NOOP_SCOPED_INSTRUMENTATION_SPAN;
    return this.open(this.iterationSpec(info), parent);
  }

  startToolCall(info: ToolCallSpanInfo, parent?: InstrumentationSpan): ScopedInstrumentationSpan {
    const scoped = this.open(this.toolSpec(info), parent);
    if (scoped.capturesContent) this.toolContentSpans.add(scoped.span);
    return scoped;
  }

  agent<T>(info: AgentSpanInfo, fn: (span: InstrumentationSpan) => Promise<T>): Promise<T> {
    const names = this.deps.options.naming === "names";
    return this.wrap(
      {
        name: `${GEN_AI_OPERATION.INVOKE_AGENT} ${this.named(info.agentName, info.agentId)}`,
        attributes: {
          [GEN_AI.OPERATION_NAME]: GEN_AI_OPERATION.INVOKE_AGENT,
          [GEN_AI.AGENT_ID]: info.agentId,
          [GEN_AI.AGENT_NAME]: names ? info.agentName : undefined,
          [GEN_AI.CONVERSATION_ID]: info.sessionId ? conversationIdFor(info.sessionId, this.deps.scrub) : undefined,
          [L2M.AGENT_SUPERVISOR]: info.supervisor
        }
      },
      fn
    );
  }

  iteration<T>(info: AgentIterationSpanInfo, fn: (span: InstrumentationSpan) => Promise<T>): Promise<T> {
    if (this.deps.options.spanDetail !== "verbose") return fn(NOOP_INSTRUMENTATION_SPAN);
    return this.wrap(this.iterationSpec(info), fn);
  }

  private iterationSpec(info: AgentIterationSpanInfo): StartSpanSpec {
    return { name: "l2m.agent.iteration", attributes: { [L2M.AGENT_ITERATION]: info.iteration } };
  }

  modelCall<T>(info: ModelCallSpanInfo, fn: (span: InstrumentationSpan) => Promise<T>): Promise<T> {
    const operation = info.operation ?? GEN_AI_OPERATION.CHAT;
    return this.wrap(
      {
        name: `${operation} ${info.model}`,
        kind: "client",
        // Embedding inputs (retrieval queries, documents) are not captured.
        ...(operation === GEN_AI_OPERATION.CHAT || operation === "text_completion" ? { content: "inference" as const } : {}),
        attributes: {
          [GEN_AI.OPERATION_NAME]: operation,
          [GEN_AI.PROVIDER_NAME]: genAiProviderName(info.providerId),
          [L2M.PROVIDER_ID]: info.providerId,
          [GEN_AI.REQUEST_MODEL]: info.model,
          [GEN_AI.REQUEST_STREAM]: info.stream,
          [GEN_AI.REQUEST_TEMPERATURE]: info.temperature,
          [GEN_AI.REQUEST_MAX_TOKENS]: info.maxTokens,
          [ATTR_SERVER_ADDRESS]: info.serverAddress,
          [ATTR_SERVER_PORT]: info.serverPort
        }
      },
      fn
    );
  }

  private toolSpec(info: ToolCallSpanInfo): StartSpanSpec {
    return {
      name: `${GEN_AI_OPERATION.EXECUTE_TOOL} ${info.toolName}`,
      content: "tool",
      attributes: {
        [GEN_AI.OPERATION_NAME]: GEN_AI_OPERATION.EXECUTE_TOOL,
        [GEN_AI.TOOL_NAME]: info.toolName,
        [GEN_AI.TOOL_CALL_ID]: info.toolCallId,
        [GEN_AI.TOOL_TYPE]: info.toolType ?? "function",
        [L2M.TOOL_INTERNAL]: info.internal
      }
    };
  }

  toolCall<T>(info: ToolCallSpanInfo, fn: (span: InstrumentationSpan) => Promise<T>): Promise<T> {
    return this.wrap(this.toolSpec(info), fn);
  }

  /**
   * An MCP request: CLIENT for L2M calling a server, SERVER for the gateway answering one. A server span whose
   * request carried trace context in `_meta` takes it as parent and links the transport's (HTTP) span, as the MCP
   * conventions ask; an untrusted caller's context is only linked. A later round of a multi round-trip request is a
   * child of the request's span and is not measured separately.
   */
  mcpRequest<T>(info: McpRequestSpanInfo, fn: (span: InstrumentationSpan) => Promise<T>): Promise<T> {
    const side = info.side === "server" ? "server" : "client";
    const spec = mcpSpanSpec(info, this.deps.scrub);
    const active = this.deps.contextManager.active();
    let parent = active;
    const links: Link[] = [];
    if (side === "server" && info.remoteParent) {
      const remote = this.extract(info.remoteParent.carrier, ROOT_CONTEXT, "inbound");
      const remoteContext = remote ? trace.getSpanContext(remote) : undefined;
      if (remote && remoteContext) {
        if (info.remoteParent.use === "parent") {
          parent = remote;
          const transport = trace.getSpanContext(active);
          if (transport && isSpanContextValid(transport)) links.push({ context: transport, attributes: { [L2M.LINK_REASON]: "transport" } });
        } else {
          links.push({ context: remoteContext, attributes: { [L2M.LINK_REASON]: "untrusted_inbound" } });
        }
      }
    }
    const span = this.deps.tracer.startSpan(
      spec.name,
      { kind: side === "server" ? SpanKind.SERVER : SpanKind.CLIENT, attributes: cleanAttributes(spec.attributes), ...(links.length > 0 ? { links } : {}) },
      parent
    );
    // Content (tool arguments and results) only on the client side: the gateway's server spans carry none.
    const content = side === "client" ? this.contentBinding("tool", parent, true) : undefined;
    const handle = new McpSpanHandle(span, this.deps.scrub, spec.attributes, side, info.round && info.round > 1 ? undefined : this.mcpMetrics, content);
    this.mcpHandles.set(span, handle);
    return this.within(handle, fn);
  }

  span<T>(info: GenericSpanInfo, fn: (span: InstrumentationSpan) => Promise<T>): Promise<T> {
    return this.wrap({ name: info.name, kind: info.kind, attributes: info.attributes, ...(info.links ? { links: info.links } : {}) }, fn);
  }

  annotate(attributes: InstrumentationAttributes): void {
    const span = trace.getSpan(this.deps.contextManager.active());
    if (!span) return;
    // An MCP span's handle also keeps what its duration metric needs, sampled or not.
    const mcp = this.mcpHandles.get(span);
    if (mcp) mcp.setAttributes(attributes);
    // What an MCP client reports about its request belongs on an MCP span only (a call made outside one, such as a
    // capability lookup, must not put MCP attributes on the HTTP or tool span around it).
    else if (span.isRecording() && !Object.keys(attributes).every((key) => MCP_REQUEST_KEYS.has(key))) span.setAttributes(cleanAttributes(attributes));
  }

  inject(carrier: TraceCarrier, target: TraceInjectTarget): boolean {
    if (target === "provider" && !this.deps.options.propagateToProviders) return false;
    if (target === "mcp" && !this.deps.options.propagateToMcp) return false;
    const active = this.deps.contextManager.active();
    const spanContext = trace.getSpanContext(active);
    if (!spanContext || !isSpanContextValid(spanContext)) return false;
    // A stale value already in the carrier must not count as injected.
    delete carrier.traceparent;
    delete carrier.tracestate;
    this.propagatorFor(target).inject(active, carrier, defaultTextMapSetter);
    return typeof carrier.traceparent === "string";
  }

  private propagatorFor(target: TraceInjectTarget | "internal"): TextMapPropagator {
    return target === "queue" || target === "state" || target === "internal" ? this.deps.internalPropagator : this.deps.propagator;
  }

  /**
   * The context a carrier names as parent (on `base`), or null when it holds no valid span context. `inbound` reads
   * it with the deployment's propagators (a request from outside); otherwise with W3C trace context (L2M's own).
   */
  extract(carrier: TraceCarrier | null | undefined, base: Context = ROOT_CONTEXT, source: "inbound" | "internal" = "internal"): Context | null {
    if (!carrier || typeof carrier.traceparent !== "string") return null;
    const propagator = source === "inbound" ? this.deps.propagator : this.deps.internalPropagator;
    const extracted = propagator.extract(base, carrier, defaultTextMapGetter);
    const spanContext = trace.getSpanContext(extracted);
    return spanContext && isSpanContextValid(spanContext) ? extracted : null;
  }

  withParent<T>(carrier: TraceCarrier | null | undefined, fn: () => T): T {
    const context = this.extract(carrier, this.deps.contextManager.active());
    return context ? this.deps.contextManager.with(context, fn) : fn();
  }

  withNewTrace<T>(fn: () => T): T {
    return this.deps.contextManager.with(ROOT_CONTEXT, fn);
  }

  activeTraceIds(): TraceIds | null {
    const spanContext = trace.getSpanContext(this.deps.contextManager.active());
    if (!spanContext || !isSpanContextValid(spanContext)) return null;
    const traceFlags = (spanContext.traceFlags & 0xff).toString(16).padStart(2, "0");
    return {
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
      traceFlags,
      traceparent: `00-${spanContext.traceId}-${spanContext.spanId}-${traceFlags}`
    };
  }

  private linksFrom(carriers: readonly TraceCarrier[] | undefined): Link[] {
    if (!carriers) return [];
    const links: Link[] = [];
    for (const carrier of carriers) {
      const context = this.extract(carrier);
      const spanContext = context ? trace.getSpanContext(context) : undefined;
      if (spanContext) links.push({ context: spanContext });
    }
    return links;
  }
}
