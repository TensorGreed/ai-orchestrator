import {
  ErrorCategory,
  NOOP_INSTRUMENTATION_SPAN,
  SPAN_OUTCOME_ATTRIBUTES as ATTR,
  effectiveModelName,
  type InstrumentationSpan,
  type LLMCallResponse,
  type LLMFinishReason,
  type LLMProviderConfig,
  type LLMUsage,
  type ModelCallObservation,
  type ModelCallSpanInfo,
  type ProviderDefinition,
  type RunInstrumentation,
  type TraceCarrier
} from "@ai-orchestrator/shared";
import { StreamedAnswer, captureModelAnswer, captureModelRequest, genAiOutputMessages } from "./content-capture";
import { providerServerEndpoint } from "./default-base-urls";
import { EmbeddingProviderRegistry, type EmbeddingProviderAdapter, type EmbeddingResponse } from "./embeddings";
import { ProviderRegistry } from "./registry";
import type { LLMProviderAdapter, LLMStreamChunk, ProviderCallRequest, ProviderExecutionContext } from "./types";

/**
 * Model-call spans and metrics: one seam in front of every model call, like `gated-registry.ts`.
 *
 * An instrumented registry hands out adapters whose `generate`, `generateStream` and (for embeddings) `embed` run
 * inside a `chat {model}` / `embeddings {model}` CLIENT span of the given `RunInstrumentation`, and report each call to
 * `observe` when it ends (the GenAI duration and token metrics). Only ids, parameters and counts are set on the span:
 * never the provider's error text (an error is its low-cardinality type). The messages, tool definitions and answer are
 * handed to the span only while it captures content (off by default), and its implementation masks them before export.
 *
 * Registries can be layered (an instrumented allowlist view over an instrumented base); the outermost layer records the
 * call and marks the context it passes on, so the layers below pass it through and each call is recorded once. The
 * outermost layer also sees calls the allowlist refuses (`error.type=model_not_allowed`), which never reach a provider.
 *
 * A stream's span stays open until the stream ends: read to the end, failed, or closed early by its reader. Callers must
 * read a stream to its end or close it (`for await` does; a manual reader calls `return()`), as with any provider stream.
 *
 * A call the model allowlist refuses gets its span but is not reported to the metrics: nothing was sent, and a refusal
 * would read as a very fast provider call in the duration histogram.
 */

export interface ModelCallInstrumentationOptions {
  instrument: RunInstrumentation;
  /** Called once per call when it ends; absent: no metrics. */
  observe?: (observation: ModelCallObservation) => void;
  /** Clock in milliseconds (tests). */
  now?: () => number;
}

/** The error type of a call the model allowlist refused (nothing reached the provider). */
const MODEL_NOT_ALLOWED: string = ErrorCategory.MODEL_NOT_ALLOWED;

const INSTRUMENTED = Symbol.for("l2m.provider-sdk.model-call-instrumented");

type MarkedContext = ProviderExecutionContext & { [INSTRUMENTED]?: true };

function alreadyInstrumented(context: ProviderExecutionContext | undefined): boolean {
  return Boolean(context && (context as MarkedContext)[INSTRUMENTED]);
}

/** A failed call's type: its L2M error category, else its class name. Never its message. */
export function modelCallErrorType(error: unknown): string {
  if (error && typeof error === "object") {
    for (const key of ["category", "errorCategory"] as const) {
      const value = (error as Record<string, unknown>)[key];
      if (typeof value === "string" && value) return value;
    }
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && name && name !== "Error") return name;
  }
  return "_OTHER";
}

const MAX_ID_LENGTH = 256;

function idString(value: unknown): string | undefined {
  return typeof value === "string" && value && value.length <= MAX_ID_LENGTH ? value : undefined;
}

/**
 * The response model and id the provider reported in its raw answer (OpenAI and Anthropic: `model`, `id`; Gemini:
 * `modelVersion`, `responseId`). Ids only: nothing else of the raw answer is read.
 */
function responseIds(raw: unknown): { model?: string; id?: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const body = raw as Record<string, unknown>;
  const model = idString(body.model) ?? idString(body.modelVersion);
  const id = idString(body.id) ?? idString(body.responseId);
  return { ...(model ? { model } : {}), ...(id ? { id } : {}) };
}

function reportedUsage(usage: LLMUsage | undefined): ModelCallObservation["usage"] {
  if (!usage) return undefined;
  const counts: NonNullable<ModelCallObservation["usage"]> = {};
  if (typeof usage.inputTokens === "number" && usage.inputTokens >= 0) counts.inputTokens = usage.inputTokens;
  if (typeof usage.outputTokens === "number" && usage.outputTokens >= 0) counts.outputTokens = usage.outputTokens;
  if (typeof usage.cachedInputTokens === "number" && usage.cachedInputTokens >= 0) counts.cachedInputTokens = usage.cachedInputTokens;
  return Object.keys(counts).length > 0 ? counts : undefined;
}

interface CallDescription {
  info: ModelCallSpanInfo;
  providerId: string;
  model: string;
  server?: { address: string; port: number };
}

function describeCall(provider: LLMProviderConfig, operation: "chat" | "embeddings", stream: boolean): CallDescription {
  const providerId = String(provider.providerId);
  const model = effectiveModelName(provider);
  const server = providerServerEndpoint(providerId, provider);
  const info: ModelCallSpanInfo = {
    providerId,
    model,
    operation,
    ...(operation === "chat" ? { stream } : {}),
    ...(typeof provider.temperature === "number" ? { temperature: provider.temperature } : {}),
    ...(typeof provider.maxTokens === "number" ? { maxTokens: provider.maxTokens } : {}),
    ...(server ? { serverAddress: server.address, serverPort: server.port } : {})
  };
  return { info, providerId, model, ...(server ? { server } : {}) };
}

/** The context handed to the layers below: marked as recorded, retries counted, trace headers when propagation is on. */
class CallContext {
  retries = 0;
  readonly context: ProviderExecutionContext;

  constructor(base: ProviderExecutionContext, span: InstrumentationSpan, instrument: RunInstrumentation) {
    const next: MarkedContext = { ...base, [INSTRUMENTED]: true };
    if (span.recording) {
      const onRetry = base.onRetry;
      next.onRetry = (info) => {
        this.retries += 1;
        onRetry?.(info);
      };
    }
    const carrier: TraceCarrier = {};
    if (instrument.inject(carrier, "provider")) next.traceHeaders = { ...carrier };
    this.context = next;
  }
}

function sharedEnd(span: InstrumentationSpan, call: CallContext | null, usage: ModelCallObservation["usage"], ids: { model?: string; id?: string }): void {
  if (!span.recording) return;
  span.setAttributes({
    [ATTR.RESPONSE_MODEL]: ids.model,
    [ATTR.RESPONSE_ID]: ids.id,
    [ATTR.USAGE_INPUT_TOKENS]: usage?.inputTokens,
    [ATTR.USAGE_OUTPUT_TOKENS]: usage?.outputTokens,
    [ATTR.USAGE_CACHE_READ_INPUT_TOKENS]: usage?.cachedInputTokens,
    [ATTR.RETRY_COUNT]: call && call.retries > 0 ? call.retries : undefined
  });
}

class ModelCallRecorder {
  private readonly now: () => number;

  constructor(private readonly options: ModelCallInstrumentationOptions) {
    this.now = options.now ?? Date.now;
  }

  private observe(description: CallDescription, observation: Omit<ModelCallObservation, "providerId" | "requestModel" | "serverAddress" | "serverPort">): void {
    const observe = this.options.observe;
    if (!observe || observation.errorType === MODEL_NOT_ALLOWED) return;
    try {
      observe({
        ...observation,
        providerId: description.providerId,
        requestModel: description.model,
        ...(description.server ? { serverAddress: description.server.address, serverPort: description.server.port } : {})
      });
    } catch {
      // Metrics never fail a model call.
    }
  }

  async generate(adapter: LLMProviderAdapter, request: ProviderCallRequest, context: ProviderExecutionContext): Promise<LLMCallResponse> {
    const description = describeCall(request.provider, "chat", false);
    const startedAt = this.now();
    const instrument = this.options.instrument;
    // Errors are caught inside the span so only their type is recorded (the wrapper would record the message).
    const outcome = await instrument.modelCall(description.info, async (span): Promise<{ response: LLMCallResponse } | { error: unknown; type: string }> => {
      const call = new CallContext(context, span, instrument);
      try {
        captureModelRequest(span, request);
        const response = await adapter.generate(request, call.context);
        if (span.recording) {
          sharedEnd(span, call, reportedUsage(response.usage), responseIds(response.raw));
          if (response.finishReason) span.setAttributes({ [ATTR.RESPONSE_FINISH_REASONS]: [response.finishReason] });
        }
        captureModelAnswer(span, () => genAiOutputMessages(response));
        return { response };
      } catch (error) {
        const type = modelCallErrorType(error);
        sharedEnd(span, call, undefined, {});
        span.recordError("", { type });
        return { error, type };
      }
    });
    const durationMs = Math.max(0, this.now() - startedAt);
    if ("error" in outcome) {
      this.observe(description, { operation: "chat", stream: false, durationMs, errorType: outcome.type });
      throw outcome.error;
    }
    const usage = reportedUsage(outcome.response.usage);
    const responseModel = responseIds(outcome.response.raw).model;
    this.observe(description, { operation: "chat", stream: false, durationMs, ...(usage ? { usage } : {}), ...(responseModel ? { responseModel } : {}) });
    return outcome.response;
  }

  async *generateStream(
    stream: (request: ProviderCallRequest, context: ProviderExecutionContext) => AsyncGenerator<LLMStreamChunk>,
    request: ProviderCallRequest,
    context: ProviderExecutionContext
  ): AsyncGenerator<LLMStreamChunk> {
    const description = describeCall(request.provider, "chat", true);
    const startedAt = this.now();
    const instrument = this.options.instrument;
    // Filled in by the span callback below (a holder, so the reads after it are not narrowed away).
    const open: { span: InstrumentationSpan; call: CallContext | null; iterator: AsyncIterator<LLMStreamChunk> | null } = {
      span: NOOP_INSTRUMENTATION_SPAN,
      call: null,
      iterator: null
    };
    // The span is opened, and the first chunk read, with the span active: the request is sent inside it. It is then
    // kept open while the reader reads the rest, and ended below when the stream ends however it ends.
    const opened = await instrument.modelCall(description.info, async (active): Promise<{ first: IteratorResult<LLMStreamChunk> } | { error: unknown }> => {
      active.keepOpen();
      open.span = active;
      open.call = new CallContext(context, active, instrument);
      try {
        captureModelRequest(active, request);
        open.iterator = stream(request, open.call.context)[Symbol.asyncIterator]();
        return { first: await open.iterator.next() };
      } catch (error) {
        return { error };
      }
    });
    const { span, call, iterator } = open;
    let usage: LLMUsage | undefined;
    let finishReason: LLMFinishReason | undefined;
    let innerDone = false;
    let failure: { error: unknown } | null = null;
    const answer = span.capturesContent === true ? new StreamedAnswer() : null;
    try {
      if ("error" in opened) {
        innerDone = true;
        failure = { error: opened.error };
        throw opened.error;
      }
      let result = opened.first;
      while (!result.done) {
        const chunk = result.value;
        if (chunk.type === "usage") usage = chunk.usage;
        else if (chunk.type === "finish") finishReason = chunk.reason;
        else if (answer && chunk.type === "text_delta") answer.addText(chunk.textDelta);
        else if (answer && chunk.type === "tool_call_delta") answer.addToolCall(chunk);
        try {
          yield chunk;
        } catch (error) {
          // The reader threw into the stream (`throw()`): pass it on to the provider stream, as `yield*` would.
          failure = { error };
          innerDone = true;
          try {
            await iterator!.throw?.(error);
          } catch {
            // The provider stream rethrew it (or failed to close); the reader's error is the one that goes on.
          }
          throw error;
        }
        try {
          result = await iterator!.next();
        } catch (error) {
          innerDone = true;
          failure = { error };
          throw error;
        }
      }
      innerDone = true;
    } finally {
      const closedEarly = !innerDone;
      if (closedEarly && iterator) {
        // The reader stopped (a break, a closed connection): close the provider stream too, as `yield*` would. An error
        // while closing it is not passed on: the reader already chose to stop, and what it read stands.
        try {
          await iterator.return?.();
        } catch {
          // Abandoned on purpose; see above.
        }
      }
      const counts = reportedUsage(usage);
      const errorType = failure ? modelCallErrorType(failure.error) : undefined;
      try {
        sharedEnd(span, call, counts, {});
        if (span.recording) {
          span.setAttributes({
            [ATTR.RESPONSE_FINISH_REASONS]: finishReason ? [finishReason] : undefined,
            [ATTR.STREAM_CLOSED_EARLY]: closedEarly ? true : undefined
          });
        }
        if (errorType) span.recordError("", { type: errorType });
        // What the reader was given, also when it stopped early; a failed stream records no answer.
        else if (answer) captureModelAnswer(span, () => answer.output(finishReason));
      } finally {
        span.end();
      }
      this.observe(description, {
        operation: "chat",
        stream: true,
        durationMs: Math.max(0, this.now() - startedAt),
        ...(counts ? { usage: counts } : {}),
        ...(errorType ? { errorType } : {})
      });
    }
  }

  async embed(adapter: EmbeddingProviderAdapter, request: Parameters<EmbeddingProviderAdapter["embed"]>[0], context: ProviderExecutionContext): Promise<EmbeddingResponse> {
    const description = describeCall(request.provider, "embeddings", false);
    const startedAt = this.now();
    const instrument = this.options.instrument;
    const outcome = await instrument.modelCall(description.info, async (span): Promise<{ response: EmbeddingResponse } | { error: unknown; type: string }> => {
      const call = new CallContext(context, span, instrument);
      try {
        const response = await adapter.embed(request, call.context);
        if (span.recording) {
          sharedEnd(span, call, response.usage?.inputTokens !== undefined ? { inputTokens: response.usage.inputTokens } : undefined, {
            ...(idString(response.model) ? { model: response.model } : {})
          });
          span.setAttributes({ [ATTR.EMBEDDINGS_DIMENSION_COUNT]: response.embeddings[0]?.length });
        }
        return { response };
      } catch (error) {
        const type = modelCallErrorType(error);
        sharedEnd(span, call, undefined, {});
        span.recordError("", { type });
        return { error, type };
      }
    });
    const durationMs = Math.max(0, this.now() - startedAt);
    if ("error" in outcome) {
      this.observe(description, { operation: "embeddings", stream: false, durationMs, errorType: outcome.type });
      throw outcome.error;
    }
    const inputTokens = outcome.response.usage?.inputTokens;
    const responseModel = idString(outcome.response.model);
    this.observe(description, {
      operation: "embeddings",
      stream: false,
      durationMs,
      ...(typeof inputTokens === "number" && inputTokens >= 0 ? { usage: { inputTokens } } : {}),
      ...(responseModel ? { responseModel } : {})
    });
    return outcome.response;
  }
}

/** `adapter` with every model call recorded (see the module comment). */
export function instrumentedProviderAdapter(adapter: LLMProviderAdapter, options: ModelCallInstrumentationOptions): LLMProviderAdapter {
  return instrumentWith(adapter, new ModelCallRecorder(options));
}

function instrumentWith(adapter: LLMProviderAdapter, recorder: ModelCallRecorder): LLMProviderAdapter {
  const wrapped: LLMProviderAdapter = {
    definition: adapter.definition,
    generate: async (request, context) =>
      alreadyInstrumented(context) ? await adapter.generate(request, context) : await recorder.generate(adapter, request, context)
  };
  if (adapter.generateStream) {
    const stream = adapter.generateStream.bind(adapter);
    wrapped.generateStream = (request, context) => (alreadyInstrumented(context) ? stream(request, context) : recorder.generateStream(stream, request, context));
  }
  if (adapter.testConnection) wrapped.testConnection = adapter.testConnection.bind(adapter);
  return wrapped;
}

export class InstrumentedProviderRegistry extends ProviderRegistry {
  private readonly wrapped = new WeakMap<LLMProviderAdapter, LLMProviderAdapter>();
  private readonly recorder: ModelCallRecorder;

  constructor(
    private readonly base: ProviderRegistry,
    options: ModelCallInstrumentationOptions
  ) {
    super();
    this.recorder = new ModelCallRecorder(options);
  }

  override register(provider: LLMProviderAdapter): void {
    this.base.register(provider);
  }

  override get(providerId: string): LLMProviderAdapter {
    return this.wrap(this.base.get(providerId));
  }

  override tryGet(providerId: string): LLMProviderAdapter | undefined {
    const adapter = this.base.tryGet(providerId);
    return adapter ? this.wrap(adapter) : undefined;
  }

  override listDefinitions(): ProviderDefinition[] {
    return this.base.listDefinitions();
  }

  private wrap(adapter: LLMProviderAdapter): LLMProviderAdapter {
    const known = this.wrapped.get(adapter);
    if (known) return known;
    const instrumented = instrumentWith(adapter, this.recorder);
    this.wrapped.set(adapter, instrumented);
    return instrumented;
  }
}

/** A registry whose adapters are `base`'s, each model call recorded. `base` is left untouched. */
export function createInstrumentedProviderRegistry(base: ProviderRegistry, options: ModelCallInstrumentationOptions): ProviderRegistry {
  return new InstrumentedProviderRegistry(base, options);
}

export class InstrumentedEmbeddingRegistry extends EmbeddingProviderRegistry {
  private readonly wrapped = new WeakMap<EmbeddingProviderAdapter, EmbeddingProviderAdapter>();
  private readonly recorder: ModelCallRecorder;

  constructor(
    private readonly base: EmbeddingProviderRegistry,
    options: ModelCallInstrumentationOptions
  ) {
    super();
    this.recorder = new ModelCallRecorder(options);
  }

  override register(adapter: EmbeddingProviderAdapter): void {
    this.base.register(adapter);
  }

  override get(providerId: string): EmbeddingProviderAdapter {
    return this.wrap(this.base.get(providerId));
  }

  override tryGet(providerId: string): EmbeddingProviderAdapter | undefined {
    const adapter = this.base.tryGet(providerId);
    return adapter ? this.wrap(adapter) : undefined;
  }

  override ids(): string[] {
    return this.base.ids();
  }

  /** `adapter` recorded once, then run the way `base` runs outside embedders (another layer may wrap it too). */
  override async embedWith(
    adapter: EmbeddingProviderAdapter,
    request: Parameters<EmbeddingProviderAdapter["embed"]>[0],
    context: ProviderExecutionContext
  ): Promise<EmbeddingResponse> {
    const inner: EmbeddingProviderAdapter = { id: adapter.id, embed: async (next, nextContext) => await this.base.embedWith(adapter, next, nextContext) };
    return alreadyInstrumented(context) ? await inner.embed(request, context) : await this.recorder.embed(inner, request, context);
  }

  private wrap(adapter: EmbeddingProviderAdapter): EmbeddingProviderAdapter {
    const known = this.wrapped.get(adapter);
    if (known) return known;
    const recorder = this.recorder;
    const instrumented: EmbeddingProviderAdapter = {
      id: adapter.id,
      embed: async (request, context) =>
        alreadyInstrumented(context) ? await adapter.embed(request, context) : await recorder.embed(adapter, request, context)
    };
    this.wrapped.set(adapter, instrumented);
    return instrumented;
  }
}

/** An embedding registry whose adapters are `base`'s, each call recorded. `base` is left untouched. */
export function createInstrumentedEmbeddingRegistry(base: EmbeddingProviderRegistry, options: ModelCallInstrumentationOptions): EmbeddingProviderRegistry {
  return new InstrumentedEmbeddingRegistry(base, options);
}
