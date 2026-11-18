import {
  ErrorCategory,
  MODEL_NOT_ALLOWED_CODE,
  WorkflowError,
  effectiveModelName,
  type LLMProviderConfig,
  type ProviderDefinition
} from "@ai-orchestrator/shared";
import { ProviderRegistry } from "./registry";
import { EmbeddingProviderRegistry, type EmbeddingProviderAdapter, type EmbeddingRequest, type EmbeddingResponse } from "./embeddings";
import type { LLMProviderAdapter, ProviderExecutionContext } from "./types";

/**
 * 12.6 (D7) — one seam in front of every model call.
 *
 * A gated registry hands out adapters whose `generate`, `generateStream` and
 * `testConnection` first ask a gate whether the call may go to the provider.
 * The gate throws (normally a `ModelNotAllowedError`) to refuse; the call
 * then never reaches the adapter. Adapters are looked up in the base
 * registry on every `get`, so providers registered later (community
 * packages) are gated too, and `register` adds to the base registry.
 */

export interface GatedModelCall {
  providerId: string;
  /** The model name the provider is sent (see `effectiveModelName`). */
  model: string;
  provider: LLMProviderConfig;
  operation: "generate" | "stream" | "test";
}

/**
 * Refuses a call by throwing. It may also return the context the adapter is then called with (for example one whose
 * `fetch` is pinned to vetted addresses); returning nothing keeps the caller's context.
 */
export type ModelCallGate = (
  call: GatedModelCall,
  context: ProviderExecutionContext | undefined
) => void | ProviderExecutionContext | Promise<void | ProviderExecutionContext>;

/** A model call the deployment's or the project's model allowlist refuses. Never retried. */
export class ModelNotAllowedError extends WorkflowError {
  readonly code = MODEL_NOT_ALLOWED_CODE;
  readonly providerId: string;
  readonly model: string;
  readonly refusedBy: "deployment" | "project";
  readonly projectId: string | null;

  constructor(message: string, input: { providerId: string; model: string; refusedBy: "deployment" | "project"; projectId?: string | null }) {
    super(message, ErrorCategory.MODEL_NOT_ALLOWED, false, {
      providerId: input.providerId,
      model: input.model,
      refusedBy: input.refusedBy,
      ...(input.projectId ? { projectId: input.projectId } : {})
    });
    this.name = "ModelNotAllowedError";
    this.providerId = input.providerId;
    this.model = input.model;
    this.refusedBy = input.refusedBy;
    this.projectId = input.projectId ?? null;
  }
}

export function isModelNotAllowedError(error: unknown): error is Error & { code: typeof MODEL_NOT_ALLOWED_CODE } {
  return error instanceof Error && (error as Error & { code?: unknown }).code === MODEL_NOT_ALLOWED_CODE;
}

function callOf(provider: LLMProviderConfig, operation: GatedModelCall["operation"]): GatedModelCall {
  return { providerId: String(provider.providerId), model: effectiveModelName(provider), provider, operation };
}

/** `adapter` with every call asking `gate` first. */
export function gatedProviderAdapter(adapter: LLMProviderAdapter, gate: ModelCallGate): LLMProviderAdapter {
  const wrapped: LLMProviderAdapter = {
    definition: adapter.definition,
    generate: async (request, context) => {
      const gated = (await gate(callOf(request.provider, "generate"), context)) ?? context;
      return await adapter.generate(request, gated);
    }
  };
  if (adapter.generateStream) {
    const stream = adapter.generateStream.bind(adapter);
    wrapped.generateStream = async function* (request, context) {
      const gated = (await gate(callOf(request.provider, "stream"), context)) ?? context;
      yield* stream(request, gated);
    };
  }
  if (adapter.testConnection) {
    const test = adapter.testConnection.bind(adapter);
    wrapped.testConnection = async (provider, context) => {
      const gated = (await gate(callOf(provider, "test"), context)) ?? context;
      return await test(provider, gated);
    };
  }
  return wrapped;
}

export class GatedProviderRegistry extends ProviderRegistry {
  private readonly wrapped = new WeakMap<LLMProviderAdapter, LLMProviderAdapter>();

  constructor(
    private readonly base: ProviderRegistry,
    private readonly gate: ModelCallGate
  ) {
    super();
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
    const gated = gatedProviderAdapter(adapter, this.gate);
    this.wrapped.set(adapter, gated);
    return gated;
  }
}

/** A registry whose adapters are `base`'s, each call checked by `gate` first. `base` is left untouched. */
export function createGatedProviderRegistry(base: ProviderRegistry, gate: ModelCallGate): ProviderRegistry {
  return new GatedProviderRegistry(base, gate);
}

/** An embedding call a gate is asked about: the same shape as a chat call, with operation "embed". */
export interface GatedEmbeddingCall {
  providerId: string;
  model: string;
  provider: LLMProviderConfig;
  operation: "embed";
}

/** Refuses an embedding call by throwing, or returns the context the adapter is called with (nothing keeps the caller's). */
export type EmbeddingCallGate = (
  call: GatedEmbeddingCall,
  context: ProviderExecutionContext
) => void | ProviderExecutionContext | Promise<void | ProviderExecutionContext>;

/**
 * An embedding registry whose adapters ask `gate` before each call. Embedders that are not this registry's adapters
 * (`embedWith`: knowledge base and RAG embedders with their own transport) are run as they are; their transport does
 * its own checks.
 */
export class GatedEmbeddingRegistry extends EmbeddingProviderRegistry {
  private readonly wrapped = new WeakMap<EmbeddingProviderAdapter, EmbeddingProviderAdapter>();

  constructor(
    private readonly base: EmbeddingProviderRegistry,
    private readonly gate: EmbeddingCallGate
  ) {
    super();
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

  override async embedWith(adapter: EmbeddingProviderAdapter, request: EmbeddingRequest, context: ProviderExecutionContext): Promise<EmbeddingResponse> {
    return await this.base.embedWith(adapter, request, context);
  }

  private wrap(adapter: EmbeddingProviderAdapter): EmbeddingProviderAdapter {
    const known = this.wrapped.get(adapter);
    if (known) return known;
    const gate = this.gate;
    const gated: EmbeddingProviderAdapter = {
      id: adapter.id,
      embed: async (request, context) => {
        const call: GatedEmbeddingCall = { providerId: adapter.id, model: String(request.provider.model ?? ""), provider: request.provider, operation: "embed" };
        return await adapter.embed(request, (await gate(call, context)) ?? context);
      }
    };
    this.wrapped.set(adapter, gated);
    return gated;
  }
}

/** An embedding registry whose adapters are `base`'s, each call checked by `gate` first. `base` is left untouched. */
export function createGatedEmbeddingRegistry(base: EmbeddingProviderRegistry, gate: EmbeddingCallGate): EmbeddingProviderRegistry {
  return new GatedEmbeddingRegistry(base, gate);
}
