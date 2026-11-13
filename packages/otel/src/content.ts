import { createContextKey, type Attributes, type Context, type Counter } from "@opentelemetry/api";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace";
import { CONTENT_ATTRIBUTES, CONTENT_DROPPED_ATTRIBUTE, type ContentSensitivity, type InstrumentationContentKind } from "@ai-orchestrator/shared";

/**
 * Optional content capture (OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT).
 *
 * Spans never carry content as it was handed over. `addContent` only queues a copy beside the span; when the span
 * ends, `ContentCaptureProcessor` holds it back from every other processor (the exporter and the recent-spans buffer)
 * while the deployment's masker runs off the request path:
 *
 *   1. secret values are removed and content rules mask what they detect (the masker, supplied by the API);
 *   2. each part is cut to `maxChars` with its JSON structure kept;
 *   3. the result is checked once more for secret values.
 *
 * Only then is the span passed on, with the content as attributes, a `gen_ai.client.inference.operation.details`
 * event, or both. Any failure (a sensitive span, a masking error, a timeout, too much pending work, content that
 * cannot be copied or scanned) drops all of that span's content and sets `l2m.content.dropped` to the reason: content
 * is never exported unmasked.
 */

export type ContentCaptureMode = "SPAN_ONLY" | "EVENT_ONLY" | "SPAN_AND_EVENT";

export interface ContentMaskPart {
  id: string;
  value: unknown;
}

export interface ContentMaskResult {
  /** The masked parts, same ids as given. */
  parts: ContentMaskPart[];
  /** True when the text still holds a secret value the masker knows (the final check after truncation). */
  containsSecret(text: string): boolean;
}

/** Removes secrets and masks content; throws to drop it. Must finish by `deadline` (epoch ms) or throw. */
export type ContentMasker = (parts: readonly ContentMaskPart[], options: { deadline: number }) => Promise<ContentMaskResult>;

/** A failure with the reason recorded in `l2m.content.dropped`. */
export class ContentDroppedError extends Error {
  constructor(readonly reason: string, message = `Content dropped: ${reason}`) {
    super(message);
    this.name = "ContentDroppedError";
  }
}

export interface ContentCaptureOptions {
  mode: ContentCaptureMode;
  /** Longest content attribute value, in characters (L2M_OTEL_CONTENT_MAX_CHARS). */
  maxChars: number;
  masker: ContentMasker;
  /** Spans whose content is being masked at once; more are exported without content (`backpressure`). Default 256. */
  maxPending?: number;
  /** How long masking one span's content may take. Default 10 s. */
  timeoutMs?: number;
  /** The most content characters (strings and keys) one span may queue; more drops it (`too_large`). Default 1 MiB. */
  maxInputChars?: number;
}

export const DEFAULT_CONTENT_MAX_PENDING = 256;
export const DEFAULT_CONTENT_TIMEOUT_MS = 10_000;
export const DEFAULT_CONTENT_MAX_INPUT_CHARS = 1024 * 1024;
const MAX_DEPTH = 64;

/** The event that carries a model call's content (semantic conventions v1.41.0). */
export const INFERENCE_DETAILS_EVENT = "gen_ai.client.inference.operation.details";

/** Context key of the sensitivity check spans started below `withContentExclusion` inherit. */
export const CONTENT_EXCLUSION_KEY = createContextKey("l2m.content.exclusion");

export type ContentExclusion = () => ContentSensitivity;

const SENSITIVE_REASON = "sensitive";
const REASON_PATTERN = /^[a-z_]{1,40}$/;

/** The drop reason an exclusion answer stands for, or undefined when it says not sensitive. */
function reasonFromAnswer(answer: ContentSensitivity): string | undefined {
  if (answer === false || answer === "") return undefined;
  if (typeof answer === "string" && REASON_PATTERN.test(answer)) return answer;
  return SENSITIVE_REASON;
}

/**
 * The exclusion check in force in `context`. None means no caller opened a content scope there, and spans started
 * there capture nothing: content is recorded only for work that declared its sensitivity check.
 */
export function exclusionIn(context: Context): ContentExclusion | undefined {
  const value = context.getValue(CONTENT_EXCLUSION_KEY);
  return typeof value === "function" ? (value as ContentExclusion) : undefined;
}

/** The reason `check` gives for dropping content, or undefined when it says not sensitive; a throw is `sensitive`. */
export function sensitiveReason(check: ContentExclusion): string | undefined {
  try {
    return reasonFromAnswer(check());
  } catch {
    return SENSITIVE_REASON;
  }
}

/**
 * `check` and every outer check: the first that says sensitive gives the reason (the inner one first); a check that
 * throws counts as sensitive.
 */
export function composeExclusion(check: () => ContentSensitivity, outer: ContentExclusion | undefined): ContentExclusion {
  return () => {
    const own = sensitiveReason(check);
    if (own !== undefined) return own;
    return outer ? (sensitiveReason(outer) ?? false) : false;
  };
}

/** What a span knows to queue content: the pipeline, its inherited sensitivity check, and whether it is a model call. */
export interface SpanContentBinding {
  pipeline: ContentPipeline;
  exclusion: ContentExclusion;
  /** A model call: its content also goes into the inference details event. */
  inference: boolean;
}

interface PendingContent {
  parts: Map<InstrumentationContentKind, unknown>;
  dropped?: string;
  inference: boolean;
  /** Checked again when the span ends, so content added before the work turned sensitive is dropped too. */
  exclusion: ContentExclusion;
}

/** A plain copy of `value` (JSON data only), bounded in depth and size; throws `ContentDroppedError` past either. */
export function snapshotContent(value: unknown, maxChars: number): unknown {
  let chars = 0;
  const count = (text: string) => {
    chars += text.length;
    if (chars > maxChars) throw new ContentDroppedError("too_large");
  };
  const path = new Set<object>();
  const copy = (entry: unknown, depth: number): unknown => {
    if (entry === null) return null;
    switch (typeof entry) {
      case "string":
        count(entry);
        return entry;
      case "number":
        return Number.isFinite(entry) ? entry : null;
      case "boolean":
        return entry;
      case "bigint": {
        const text = entry.toString();
        count(text);
        return text;
      }
      case "object":
        break;
      default:
        return null;
    }
    if (depth >= MAX_DEPTH) throw new ContentDroppedError("unscannable");
    const object = entry as object;
    if (object instanceof Date) return Number.isNaN(object.getTime()) ? null : object.toISOString();
    if (path.has(object)) throw new ContentDroppedError("unscannable");
    path.add(object);
    try {
      if (Array.isArray(object)) return object.map((item) => copy(item, depth + 1));
      if (ArrayBuffer.isView(object) || object instanceof ArrayBuffer) return null;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(object)) {
        const item = (object as Record<string, unknown>)[key];
        if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
        count(key);
        Object.defineProperty(out, key, { value: copy(item, depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return out;
    } finally {
      path.delete(object);
    }
  };
  return copy(value, 0);
}

const TRUNCATION_MARK = "…[truncated]";

function cutString(text: string, cap: number): string {
  if (text.length <= cap) return text;
  let end = cap;
  // Never split a surrogate pair.
  const code = text.charCodeAt(end - 1);
  if (end > 0 && code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}${TRUNCATION_MARK}`;
}

function longestString(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (!value || typeof value !== "object") return 0;
  let longest = 0;
  for (const entry of Array.isArray(value) ? value : Object.values(value)) longest = Math.max(longest, longestString(entry));
  return longest;
}

function longestArray(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  let longest = Array.isArray(value) ? value.length : 0;
  for (const entry of Array.isArray(value) ? value : Object.values(value)) longest = Math.max(longest, longestArray(entry));
  return longest;
}

function shaped(value: unknown, stringCap: number, arrayCap: number): unknown {
  if (typeof value === "string") return cutString(value, stringCap);
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const kept = value.slice(0, arrayCap).map((entry) => shaped(entry, stringCap, arrayCap));
    if (value.length > arrayCap) kept.push(TRUNCATION_MARK);
    return kept;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    Object.defineProperty(out, key, { value: shaped(entry, stringCap, arrayCap), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** The largest `n` in [0, high] for which `fits(n)` holds, assuming `fits` is monotone; -1 when even 0 does not fit. */
function largestFitting(high: number, fits: (n: number) => boolean): number {
  if (!fits(0)) return -1;
  let low = 0;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * `value` as JSON text of at most `maxChars` characters, keeping its structure: long strings are cut first (all to the
 * same length, marked), then long arrays lose their tail (marked). Content that still does not fit becomes a marker.
 */
export function truncateContent(value: unknown, maxChars: number): string {
  const whole = JSON.stringify(value) ?? "null";
  if (whole.length <= maxChars) return whole;
  const render = (stringCap: number, arrayCap: number) => JSON.stringify(shaped(value, stringCap, arrayCap)) ?? "null";
  const arrays = longestArray(value);
  const stringCap = largestFitting(longestString(value), (cap) => render(cap, arrays).length <= maxChars);
  if (stringCap >= 0) return render(stringCap, arrays);
  const arrayCap = largestFitting(arrays, (cap) => render(0, cap).length <= maxChars);
  if (arrayCap >= 0) {
    const tighter = largestFitting(longestString(value), (cap) => render(cap, arrayCap).length <= maxChars);
    return render(Math.max(0, tighter), arrayCap);
  }
  const marker = JSON.stringify(TRUNCATION_MARK);
  return marker.length <= maxChars ? marker : "";
}

function reasonOf(error: unknown): string {
  if (error instanceof ContentDroppedError) return error.reason;
  const name = error && typeof error === "object" ? (error as { name?: unknown }).name : undefined;
  // The same error from the masker's own module (it must not import this package while tracing is off).
  const reason = error && typeof error === "object" ? (error as { reason?: unknown }).reason : undefined;
  if (name === "ContentDroppedError" && typeof reason === "string" && /^[a-z_]{1,40}$/.test(reason)) return reason;
  if (name === "MaskUnscannableError") return "unscannable";
  if (name === "MaskIncompleteError" || name === "MaskIdentifierError") return "masking_incomplete";
  return "masking_failed";
}

/** Queued content per span, and the masking of it. Shared by every span handle of one runtime. */
export class ContentPipeline {
  readonly mode: ContentCaptureMode;
  readonly maxChars: number;
  private readonly pending = new WeakMap<object, PendingContent>();
  private readonly maxInputChars: number;

  constructor(
    readonly options: ContentCaptureOptions,
    private readonly scrub: (text: string) => string,
    private readonly droppedCounter?: Counter
  ) {
    this.mode = options.mode;
    this.maxChars = options.maxChars;
    this.maxInputChars = options.maxInputChars ?? DEFAULT_CONTENT_MAX_INPUT_CHARS;
  }

  private entry(span: object, binding: SpanContentBinding): PendingContent {
    let entry = this.pending.get(span);
    if (!entry) {
      entry = { parts: new Map(), inference: binding.inference, exclusion: binding.exclusion };
      this.pending.set(span, entry);
    }
    return entry;
  }

  private drop(entry: PendingContent, reason: string): void {
    entry.parts.clear();
    entry.dropped ??= reason;
  }

  /** Queues `value` as `kind` for `span`. Never throws: a failure only drops the span's content. */
  add(span: object, binding: SpanContentBinding, kind: InstrumentationContentKind, value: unknown): void {
    const entry = this.entry(span, binding);
    if (entry.dropped) return;
    const sensitive = sensitiveReason(binding.exclusion);
    if (sensitive !== undefined) {
      this.drop(entry, sensitive);
      return;
    }
    try {
      entry.parts.set(kind, snapshotContent(value, this.maxInputChars));
      let total = 0;
      for (const part of entry.parts.values()) total += JSON.stringify(part)?.length ?? 0;
      if (total > this.maxInputChars) throw new ContentDroppedError("too_large");
    } catch (error) {
      this.drop(entry, reasonOf(error));
    }
  }

  /** The content queued for `span`, removed from the queue. */
  take(span: object): PendingContent | undefined {
    const entry = this.pending.get(span);
    if (!entry) return undefined;
    this.pending.delete(span);
    if (!entry.dropped && entry.parts.size > 0) {
      const sensitive = sensitiveReason(entry.exclusion);
      if (sensitive !== undefined) this.drop(entry, sensitive);
    }
    return entry;
  }

  countDropped(reason: string): void {
    try {
      this.droppedCounter?.add(1, { reason });
    } catch {
      // A metric never affects export.
    }
  }

  /** The attributes and event attributes for `entry`, masked and truncated; throws to drop. */
  async render(entry: PendingContent): Promise<{ attributes: Attributes; event: Attributes | null }> {
    const parts: ContentMaskPart[] = [...entry.parts].map(([kind, value]) => ({ id: kind, value }));
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_CONTENT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ContentDroppedError("timeout")), timeoutMs);
      timer.unref?.();
    });
    let result: ContentMaskResult;
    try {
      result = await Promise.race([this.options.masker(parts, { deadline }), timeout]);
    } finally {
      clearTimeout(timer);
    }
    const byId = new Map(result.parts.map((part) => [part.id, part.value]));
    const content: Attributes = {};
    for (const part of parts) {
      if (!byId.has(part.id)) throw new ContentDroppedError("masking_failed");
      const text = truncateContent(byId.get(part.id), this.maxChars);
      if (result.containsSecret(text) || this.scrub(text) !== text) throw new ContentDroppedError("secret_detected");
      content[CONTENT_ATTRIBUTES[part.id as InstrumentationContentKind]] = text;
    }
    const spanAttributes = this.mode === "EVENT_ONLY" ? {} : content;
    const event = this.mode !== "SPAN_ONLY" && entry.inference ? content : null;
    return { attributes: spanAttributes, event };
  }
}

/** `span` with extra attributes and, optionally, one more event at its end time. Everything else is the span's own. */
function withContent(span: ReadableSpan, attributes: Attributes, event: { name: string; attributes: Attributes } | null): ReadableSpan {
  const extended: ReadableSpan = {
    name: span.name,
    kind: span.kind,
    spanContext: () => span.spanContext(),
    ...(span.parentSpanContext ? { parentSpanContext: span.parentSpanContext } : {}),
    startTime: span.startTime,
    endTime: span.endTime,
    status: span.status,
    attributes: { ...span.attributes, ...attributes },
    links: span.links,
    events: event ? [...span.events, { name: event.name, attributes: event.attributes, time: span.endTime }] : span.events,
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount
  };
  return extended;
}

/**
 * Sits in front of every other span processor while content capture is on. A span without queued content passes
 * straight through; one with content is passed on only after its content was masked, or without it (with
 * `l2m.content.dropped`) when that failed.
 */
export class ContentCaptureProcessor implements SpanProcessor {
  private readonly inflight = new Set<Promise<void>>();
  private readonly maxPending: number;

  constructor(
    private readonly pipeline: ContentPipeline,
    private readonly downstream: readonly SpanProcessor[]
  ) {
    this.maxPending = pipeline.options.maxPending ?? DEFAULT_CONTENT_MAX_PENDING;
  }

  onStart(span: Parameters<SpanProcessor["onStart"]>[0], parentContext: Context): void {
    for (const processor of this.downstream) processor.onStart(span, parentContext);
  }

  private forward(span: ReadableSpan): void {
    for (const processor of this.downstream) {
      try {
        processor.onEnd(span);
      } catch {
        // One processor's failure must not keep the span from the others.
      }
    }
  }

  private dropped(span: ReadableSpan, reason: string): void {
    this.pipeline.countDropped(reason);
    this.forward(withContent(span, { [CONTENT_DROPPED_ATTRIBUTE]: reason }, null));
  }

  onEnd(span: ReadableSpan): void {
    const entry = this.pipeline.take(span);
    if (!entry) {
      this.forward(span);
      return;
    }
    if (entry.dropped) {
      this.dropped(span, entry.dropped);
      return;
    }
    if (entry.parts.size === 0) {
      this.forward(span);
      return;
    }
    if (this.inflight.size >= this.maxPending) {
      this.dropped(span, "backpressure");
      return;
    }
    const job = this.pipeline
      .render(entry)
      .then(
        ({ attributes, event }) => this.forward(withContent(span, attributes, event ? { name: INFERENCE_DETAILS_EVENT, attributes: event } : null)),
        (error: unknown) => this.dropped(span, reasonOf(error))
      )
      .catch(() => undefined)
      .finally(() => {
        this.inflight.delete(job);
      });
    this.inflight.add(job);
  }

  /** Waits for the content being masked, then flushes the processors behind. */
  async forceFlush(): Promise<void> {
    await Promise.allSettled([...this.inflight]);
    await Promise.all(this.downstream.map((processor) => processor.forceFlush()));
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.inflight]);
    await Promise.all(this.downstream.map((processor) => processor.shutdown()));
  }
}
