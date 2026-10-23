import { createHash } from "node:crypto";
import {
  MODEL_TAPE_FORMAT,
  MODEL_TAPE_VERSION,
  type LLMCallResponse,
  type ModelTape,
  type ModelTapeCallSite,
  type ModelTapeEntry,
  type ModelTapeMode,
  type ModelTapeReport,
  type ProviderDefinition,
  type SecretReference
} from "@ai-orchestrator/shared";
import { ProviderRegistry } from "./registry";
import type { LLMProviderAdapter, LLMStreamChunk, ProviderCallRequest, ProviderExecutionContext } from "./types";

/**
 * Phase 15.3 — record and replay of model calls (the model tape).
 *
 * The recorder wraps every adapter of a provider registry so each call a
 * run makes lands on the tape, scrubbed, with its call site (node and agent
 * iteration from `ProviderExecutionContext.callSite`). The player builds a
 * registry whose adapters answer from a tape instead of the model.
 *
 * Calls are matched by node id + iteration + provider + model + the SHA-256
 * of the canonical scrubbed request: the messages, the tools and the
 * sampling parameters (temperature, max tokens, `extra`), never the base URL
 * or the credential. Repeated identical calls get their answers in recorded
 * order. Scrubbing runs before hashing, so a key never depends on a secret
 * value, and the same scrub runs on both sides.
 *
 * Misses (see `ModelTapeMode`): strict throws `ModelTapeMissError`, which
 * fails the node; lenient reuses the last answer of an exhausted call and
 * sends a call the tape never saw to the live registry, counting it.
 */

export const MODEL_TAPE_REDACTED = "[REDACTED]";
export const DEFAULT_MODEL_TAPE_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MODEL_TAPE_MAX_ENTRIES = 5_000;

/** Removes secrets from a value before it is kept or hashed: `secrets` are the call's own credential values. */
export type ModelTapeScrub = (value: unknown, secrets: string[]) => unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Replaces each secret value wherever it appears in a string; the default scrub. */
export function scrubSecretValues(value: unknown, secrets: string[], depth = 0): unknown {
  if (depth > 40) return MODEL_TAPE_REDACTED;
  if (typeof value === "string") {
    let out = value;
    for (const secret of secrets) if (secret && out.includes(secret)) out = out.split(secret).join(MODEL_TAPE_REDACTED);
    return out;
  }
  if (Array.isArray(value)) return value.map((entry) => scrubSecretValues(entry, secrets, depth + 1));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) if (nested !== undefined) out[key] = scrubSecretValues(nested, secrets, depth + 1);
    return out;
  }
  return value;
}

/** Sorted keys, `undefined` dropped: equal requests serialize the same. */
export function canonicalTapeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalTapeJson);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) if (value[key] !== undefined) out[key] = canonicalTapeJson(value[key]);
    return out;
  }
  return value;
}

/** The part of a request that decides the answer: messages, tools and sampling parameters. */
export function modelTapeRequest(request: ProviderCallRequest): ModelTapeEntry["request"] {
  const provider = request.provider;
  return {
    messages: request.messages ?? [],
    tools: request.tools ?? [],
    params: {
      ...(provider.temperature !== undefined ? { temperature: provider.temperature } : {}),
      ...(provider.maxTokens !== undefined ? { maxTokens: provider.maxTokens } : {}),
      ...(provider.extra !== undefined ? { extra: provider.extra } : {})
    }
  };
}

export function hashModelRequest(scrubbedRequest: ModelTapeEntry["request"]): string {
  return createHash("sha256").update(JSON.stringify(canonicalTapeJson(scrubbedRequest))).digest("hex");
}

/** The call site a context names; nulls when it names none. */
export function callSiteOf(context: ProviderExecutionContext): ModelTapeCallSite {
  const site = context.callSite;
  return {
    nodeId: typeof site?.nodeId === "string" && site.nodeId ? site.nodeId : null,
    iteration: typeof site?.iteration === "number" && Number.isInteger(site.iteration) && site.iteration >= 0 ? site.iteration : null
  };
}

async function secretsFor(secretRef: SecretReference | undefined, context: ProviderExecutionContext): Promise<string[]> {
  if (!secretRef) return [];
  try {
    const value = await context.resolveSecret(secretRef);
    if (!value) return [];
    // A JSON secret (a key bundle) is scrubbed field by field as well as whole.
    const out = new Set<string>([value]);
    try {
      const parsed = JSON.parse(value) as unknown;
      if (isRecord(parsed)) for (const field of Object.values(parsed)) if (typeof field === "string" && field.length >= 4) out.add(field);
    } catch {
      // Not JSON.
    }
    return [...out].filter((entry) => entry.length >= 4).sort((a, b) => b.length - a.length);
  } catch {
    // A secret that cannot be resolved cannot leak either.
    return [];
  }
}

interface ScrubbedCall {
  site: ModelTapeCallSite;
  providerId: string;
  model: string;
  request: ModelTapeEntry["request"];
  requestHash: string;
  scrub: (value: unknown) => unknown;
}

async function prepareCall(request: ProviderCallRequest, context: ProviderExecutionContext, scrub: ModelTapeScrub): Promise<ScrubbedCall> {
  const secrets = await secretsFor(request.provider.secretRef, context);
  const scrubOne = (value: unknown) => scrub(value, secrets);
  const scrubbedRequest = canonicalTapeJson(scrubOne(modelTapeRequest(request))) as ModelTapeEntry["request"];
  return {
    site: callSiteOf(context),
    providerId: String(request.provider.providerId),
    model: String(request.provider.model ?? ""),
    request: scrubbedRequest,
    requestHash: hashModelRequest(scrubbedRequest),
    scrub: scrubOne
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

export interface ModelTapeRecorderOptions {
  /** Size budget for the serialized entries; later entries are dropped and the tape marked truncated. */
  maxBytes?: number;
  maxEntries?: number;
  /** Scrubs what is kept and hashed. Default: the call's own credential values only. */
  scrub?: ModelTapeScrub;
  now?: () => number;
}

export class ModelTapeRecorder {
  private readonly entries: ModelTapeEntry[] = [];
  private readonly startedAt: number;
  private readonly recordedAt: string;
  private bytes = 0;
  private truncated = false;
  private seq = 0;

  constructor(private readonly options: ModelTapeRecorderOptions = {}) {
    this.startedAt = this.now();
    this.recordedAt = new Date().toISOString();
  }

  private now(): number {
    return this.options.now ? this.options.now() : performance.now();
  }

  get scrub(): ModelTapeScrub {
    return this.options.scrub ?? scrubSecretValues;
  }

  elapsed(): number {
    return Math.max(0, Math.round(this.now() - this.startedAt));
  }

  /** Adds an entry unless the size budget is spent. Returns false when it was dropped. */
  push(entry: Omit<ModelTapeEntry, "seq">): boolean {
    const maxEntries = this.options.maxEntries ?? DEFAULT_MODEL_TAPE_MAX_ENTRIES;
    const maxBytes = this.options.maxBytes ?? DEFAULT_MODEL_TAPE_MAX_BYTES;
    if (this.truncated) return false;
    const full: ModelTapeEntry = { seq: this.seq + 1, ...entry };
    const size = Buffer.byteLength(JSON.stringify(full), "utf8");
    if (this.entries.length >= maxEntries || this.bytes + size > maxBytes) {
      this.truncated = true;
      return false;
    }
    this.seq += 1;
    this.bytes += size;
    this.entries.push(full);
    return true;
  }

  get callCount(): number {
    return this.entries.length;
  }

  toTape(): ModelTape {
    return {
      format: MODEL_TAPE_FORMAT,
      version: MODEL_TAPE_VERSION,
      recordedAt: this.recordedAt,
      entries: this.entries.map((entry) => ({ ...entry })),
      truncated: this.truncated,
      bytes: this.bytes
    };
  }
}

/** The answer a stream added up to. */
function responseFromChunks(chunks: LLMStreamChunk[]): LLMCallResponse {
  let content = "";
  const calls = new Map<string, { id: string; name: string; argumentsText: string }>();
  for (const chunk of chunks) {
    if (chunk.type === "text_delta") content += chunk.textDelta;
    else {
      const id = chunk.toolCallId ?? `toolcall_${calls.size}`;
      const entry = calls.get(id) ?? { id, name: chunk.name ?? `tool_${calls.size}`, argumentsText: "" };
      if (chunk.name) entry.name = chunk.name;
      if (chunk.argumentsDelta) entry.argumentsText += chunk.argumentsDelta;
      calls.set(id, entry);
    }
  }
  return {
    content,
    toolCalls: [...calls.values()].map((call) => {
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(call.argumentsText || "{}") as unknown;
        if (isRecord(parsed)) args = parsed;
      } catch {
        args = {};
      }
      return { id: call.id, name: call.name, arguments: args };
    })
  };
}

/** Wrap one adapter so every call it serves is written to `recorder`. */
export function recordingProviderAdapter(adapter: LLMProviderAdapter, recorder: ModelTapeRecorder): LLMProviderAdapter {
  const wrapped: LLMProviderAdapter = {
    definition: adapter.definition,
    generate: async (request, context) => {
      const call = await prepareCall(request, context, recorder.scrub);
      const at = recorder.elapsed();
      const started = performance.now();
      const base = { ...call.site, providerId: call.providerId, model: call.model, requestHash: call.requestHash, request: call.request, at };
      try {
        const response = await adapter.generate(request, context);
        recorder.push({ ...base, response: call.scrub(response), durationMs: Math.round(performance.now() - started) });
        return response;
      } catch (error) {
        recorder.push({ ...base, error: String(call.scrub(errorMessage(error))), durationMs: Math.round(performance.now() - started) });
        throw error;
      }
    }
  };
  if (adapter.generateStream) {
    const stream = adapter.generateStream.bind(adapter);
    wrapped.generateStream = async function* (request, context) {
      const call = await prepareCall(request, context, recorder.scrub);
      const at = recorder.elapsed();
      const started = performance.now();
      const base = { ...call.site, providerId: call.providerId, model: call.model, requestHash: call.requestHash, request: call.request, at, streamed: true };
      const chunks: LLMStreamChunk[] = [];
      try {
        for await (const chunk of stream(request, context)) {
          chunks.push(chunk);
          yield chunk;
        }
        recorder.push({ ...base, response: call.scrub(responseFromChunks(chunks)), durationMs: Math.round(performance.now() - started) });
      } catch (error) {
        recorder.push({ ...base, error: String(call.scrub(errorMessage(error))), durationMs: Math.round(performance.now() - started) });
        throw error;
      }
    };
  }
  if (adapter.testConnection) wrapped.testConnection = adapter.testConnection.bind(adapter);
  return wrapped;
}

/** A registry with every adapter of `base` wrapped for recording. `base` is left untouched. */
export function createModelTapeRecordingRegistry(base: ProviderRegistry, recorder: ModelTapeRecorder): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const definition of base.listDefinitions()) {
    const adapter = base.tryGet(definition.id);
    if (adapter) registry.register(recordingProviderAdapter(adapter, recorder));
  }
  return registry;
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/** Thrown for a model call the tape cannot answer in strict mode. */
export class ModelTapeMissError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelTapeMissError";
  }
}

export interface ModelTapePlayerOptions {
  mode?: ModelTapeMode;
  /** Registry for calls the tape never saw; used in lenient mode only. Omit it to keep the replay offline. */
  live?: ProviderRegistry;
  scrub?: ModelTapeScrub;
}

function matchKey(site: ModelTapeCallSite, providerId: string, model: string, requestHash: string): string {
  return JSON.stringify([site.nodeId, site.iteration, providerId, model, requestHash]);
}

export class ModelTapePlayer {
  readonly mode: ModelTapeMode;
  private readonly byKey = new Map<string, ModelTapeEntry[]>();
  private readonly cursor = new Map<string, number>();
  private matched = 0;
  private reused = 0;
  private live = 0;
  private readonly unmatched: ModelTapeReport["unmatched"] = [];
  private readonly unmatchedKeys = new Set<string>();

  constructor(
    readonly tape: ModelTape,
    private readonly options: ModelTapePlayerOptions = {}
  ) {
    this.mode = options.mode ?? "strict";
    for (const entry of [...tape.entries].sort((a, b) => a.seq - b.seq)) {
      const key = matchKey(entry, entry.providerId, entry.model, entry.requestHash);
      const list = this.byKey.get(key) ?? [];
      list.push(entry);
      this.byKey.set(key, list);
    }
  }

  /** The live registry lenient replays fall through to; never set in strict mode. */
  get liveRegistry(): ProviderRegistry | undefined {
    return this.mode === "lenient" ? this.options.live : undefined;
  }

  /** The recorded answer for a call, a live answer in lenient mode, or a `ModelTapeMissError`. */
  async answer(request: ProviderCallRequest, context: ProviderExecutionContext): Promise<{ response: LLMCallResponse; streamed: boolean }> {
    const call = await prepareCall(request, context, this.options.scrub ?? scrubSecretValues);
    const key = matchKey(call.site, call.providerId, call.model, call.requestHash);
    const candidates = this.byKey.get(key) ?? [];
    const position = this.cursor.get(key) ?? 0;
    let entry: ModelTapeEntry | undefined;
    if (position < candidates.length) {
      entry = candidates[position];
      this.cursor.set(key, position + 1);
      this.matched += 1;
    } else if (candidates.length > 0 && this.mode === "lenient") {
      entry = candidates[candidates.length - 1];
      this.reused += 1;
    }
    if (entry) {
      if (entry.error !== undefined) throw new Error(entry.error);
      const response = structuredClone(entry.response ?? { content: "", toolCalls: [] }) as LLMCallResponse;
      return { response: { ...response, content: typeof response.content === "string" ? response.content : "", toolCalls: Array.isArray(response.toolCalls) ? response.toolCalls : [] }, streamed: entry.streamed === true };
    }
    const reason = this.describeMiss(call, candidates.length);
    const liveAdapter = this.liveRegistry?.tryGet(call.providerId);
    if (liveAdapter) {
      this.live += 1;
      return { response: await liveAdapter.generate(request, context), streamed: false };
    }
    if (!this.unmatchedKeys.has(key)) {
      this.unmatchedKeys.add(key);
      this.unmatched.push({ ...call.site, providerId: call.providerId, model: call.model, reason });
    }
    throw new ModelTapeMissError(`Model tape replay (${this.mode}): ${reason}`);
  }

  private describeMiss(call: ScrubbedCall, exhausted: number): string {
    const where = call.site.nodeId ? `node ${call.site.nodeId}${call.site.iteration !== null ? ` (iteration ${call.site.iteration})` : ""}` : "a model call outside a node";
    const target = `${call.providerId}/${call.model} at ${where}`;
    if (exhausted > 0) return `${target} was called more often than the golden run recorded (${exhausted} recorded).`;
    const sameSite = this.tape.entries.filter((entry) => entry.nodeId === call.site.nodeId && entry.iteration === call.site.iteration);
    if (sameSite.length === 0) return `the golden run made no model call at ${where}.`;
    if (!sameSite.some((entry) => entry.providerId === call.providerId && entry.model === call.model)) {
      const recorded = [...new Set(sameSite.map((entry) => `${entry.providerId}/${entry.model}`))].join(", ");
      return `the golden run called ${recorded} at ${where}, not ${call.providerId}/${call.model}.`;
    }
    return `the request to ${target} differs from what the golden run sent (a prompt, an earlier result or a parameter changed).`;
  }

  report(): ModelTapeReport {
    return { mode: this.mode, matched: this.matched, reused: this.reused, live: this.live, unmatched: [...this.unmatched] };
  }
}

function replayDefinition(providerId: string, base?: ProviderDefinition): ProviderDefinition {
  return base ?? { id: providerId as ProviderDefinition["id"], label: `Replay of ${providerId}`, supportsTools: true, configSchema: { type: "object", properties: {} } };
}

function replayProviderAdapter(definition: ProviderDefinition, player: ModelTapePlayer): LLMProviderAdapter {
  return {
    definition,
    generate: async (request, context) => (await player.answer(request, context)).response,
    generateStream: async function* (request, context) {
      const { response } = await player.answer(request, context);
      if (response.content) yield { type: "text_delta", textDelta: response.content };
      for (const call of response.toolCalls ?? []) {
        yield { type: "tool_call_delta", toolCallId: call.id, name: call.name, argumentsDelta: JSON.stringify(call.arguments ?? {}) };
      }
    }
  };
}

/**
 * A registry that answers every model call from `tape`. Provider ids come
 * from the live registry (when given) and from the tape, so a replay works
 * even where the original adapter is not installed.
 */
export function createModelTapeReplayRegistry(tape: ModelTape, options: ModelTapePlayerOptions = {}): { registry: ProviderRegistry; player: ModelTapePlayer } {
  const player = new ModelTapePlayer(tape, options);
  const registry = new ProviderRegistry();
  const ids = new Set<string>([...(options.live?.listDefinitions().map((definition) => definition.id) ?? []), ...tape.entries.map((entry) => entry.providerId)]);
  for (const id of ids) registry.register(replayProviderAdapter(replayDefinition(id, options.live?.tryGet(id)?.definition), player));
  return { registry, player };
}

/** An empty tape, for replays of golden runs that have none. */
export function emptyModelTape(): ModelTape {
  return { format: MODEL_TAPE_FORMAT, version: MODEL_TAPE_VERSION, recordedAt: new Date(0).toISOString(), entries: [], truncated: false, bytes: 0 };
}
