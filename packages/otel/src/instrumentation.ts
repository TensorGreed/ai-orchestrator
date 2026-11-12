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
  type Span,
  type TextMapPropagator,
  type Tracer
} from "@opentelemetry/api";
import type {
  AgentIterationSpanInfo,
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
    private readonly scrub: (text: string) => string
  ) {}

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

/** A span the caller opened and enters for parts of its work (see `ScopedInstrumentationSpan`). */
export class OtelScopedSpan extends OtelSpanHandle implements ScopedInstrumentationSpan {
  constructor(
    span: Span,
    scrub: (text: string) => string,
    private readonly contextManager: ContextManager
  ) {
    super(span, scrub);
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
}

export interface StartSpanSpec {
  name: string;
  kind?: InstrumentationSpanKind;
  attributes?: InstrumentationAttributes;
  links?: readonly TraceCarrier[];
  /** Parent context; default: the active one. */
  parent?: Context;
}

/** Implements the shared `RunInstrumentation` seam over an OpenTelemetry tracer. */
export class OtelRunInstrumentation implements RunInstrumentation {
  readonly enabled = true;

  constructor(private readonly deps: InstrumentationDeps) {}

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
    return new OtelSpanHandle(span, this.deps.scrub);
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
    return new OtelScopedSpan(handle.span, this.deps.scrub, this.deps.contextManager);
  }

  startNode(info: NodeSpanInfo, parent?: InstrumentationSpan): ScopedInstrumentationSpan {
    return this.open(this.nodeSpec(info), parent);
  }

  startIteration(info: AgentIterationSpanInfo, parent?: InstrumentationSpan): ScopedInstrumentationSpan {
    if (this.deps.options.spanDetail !== "verbose") return NOOP_SCOPED_INSTRUMENTATION_SPAN;
    return this.open(this.iterationSpec(info), parent);
  }

  startToolCall(info: ToolCallSpanInfo, parent?: InstrumentationSpan): ScopedInstrumentationSpan {
    return this.open(this.toolSpec(info), parent);
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

  mcpRequest<T>(info: McpRequestSpanInfo, fn: (span: InstrumentationSpan) => Promise<T>): Promise<T> {
    return this.wrap(
      {
        name: info.target ? `${info.method} ${info.target}` : info.method,
        kind: info.side === "server" ? "server" : "client",
        attributes: {
          [MCP.METHOD_NAME]: info.method,
          [GEN_AI.TOOL_NAME]: info.method === "tools/call" ? info.target : undefined,
          [MCP.SESSION_ID]: info.sessionId,
          [MCP.PROTOCOL_VERSION]: info.protocolVersion,
          [MCP.JSONRPC_REQUEST_ID]: info.requestId === undefined ? undefined : String(info.requestId),
          [MCP.NETWORK_TRANSPORT]: info.transport,
          [ATTR_SERVER_ADDRESS]: info.serverAddress,
          [ATTR_SERVER_PORT]: info.serverPort,
          [L2M.MCP_SERVER_ID]: info.serverId
        }
      },
      fn
    );
  }

  span<T>(info: GenericSpanInfo, fn: (span: InstrumentationSpan) => Promise<T>): Promise<T> {
    return this.wrap({ name: info.name, kind: info.kind, attributes: info.attributes, ...(info.links ? { links: info.links } : {}) }, fn);
  }

  annotate(attributes: InstrumentationAttributes): void {
    const span = trace.getSpan(this.deps.contextManager.active());
    if (span?.isRecording()) span.setAttributes(cleanAttributes(attributes));
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
