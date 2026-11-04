import {
  ErrorCategory,
  MODEL_NOT_ALLOWED_CODE,
  WorkflowError,
  effectiveModelName,
  type LLMProviderConfig,
  type ProviderDefinition
} from "@ai-orchestrator/shared";
import { ProviderRegistry } from "./registry";
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

export type ModelCallGate = (call: GatedModelCall, context: ProviderExecutionContext | undefined) => void | Promise<void>;

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
      await gate(callOf(request.provider, "generate"), context);
      return await adapter.generate(request, context);
    }
  };
  if (adapter.generateStream) {
    const stream = adapter.generateStream.bind(adapter);
    wrapped.generateStream = async function* (request, context) {
      await gate(callOf(request.provider, "stream"), context);
      yield* stream(request, context);
    };
  }
  if (adapter.testConnection) {
    const test = adapter.testConnection.bind(adapter);
    wrapped.testConnection = async (provider, context) => {
      await gate(callOf(provider, "test"), context);
      return await test(provider, context);
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
