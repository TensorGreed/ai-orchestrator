import { effectiveModelName, type LLMUsage, type ProviderDefinition } from "@ai-orchestrator/shared";
import { ProviderRegistry } from "./registry";
import type { LLMProviderAdapter } from "./types";
import { chargedUsage, estimateAnswerTokens, estimateRequestTokens } from "./usage-estimate";

/**
 * Model usage outside a workflow run: a registry whose adapters report each call's token usage once it answers, so a
 * caller that is not a run (the Describe it builder) can record and charge it like a run's model calls. A call that
 * fails reports nothing (no answer, no usage). Usage the provider did not report is estimated from the request and the
 * answer, as runs charge it (`chargedUsage`), so a server that sends no usage is never free. Calls are passed through
 * unchanged.
 */
export interface MeteredModelCall {
  providerId: string;
  /** The model name the provider was sent (see `effectiveModelName`). */
  model: string;
  usage: LLMUsage;
  /** Some of `usage` is an estimate (the provider did not report it). */
  estimated: boolean;
}

/** `adapter` with each answered call's usage reported to `onCall`. */
export function meteredProviderAdapter(adapter: LLMProviderAdapter, onCall: (call: MeteredModelCall) => void): LLMProviderAdapter {
  const wrapped: LLMProviderAdapter = {
    definition: adapter.definition,
    generate: async (request, context) => {
      const response = await adapter.generate(request, context);
      const charged = chargedUsage(response.usage, () => ({
        input: estimateRequestTokens(request),
        output: estimateAnswerTokens(
          response.content ?? "",
          (response.toolCalls ?? []).map((call) => ({ name: call.name, arguments: JSON.stringify(call.arguments ?? {}) }))
        )
      }));
      onCall({ providerId: String(request.provider.providerId), model: effectiveModelName(request.provider), ...charged });
      return response;
    }
  };
  if (adapter.generateStream) {
    const stream = adapter.generateStream.bind(adapter);
    wrapped.generateStream = async function* (request, context) {
      let usage: LLMUsage | undefined;
      let answer = "";
      let received = false;
      try {
        for await (const chunk of stream(request, context)) {
          received = true;
          if (chunk.type === "usage") usage = chunk.usage;
          else if (chunk.type === "text_delta") answer += chunk.textDelta;
          else if (chunk.type === "tool_call_delta") answer += (chunk.name ?? "") + (chunk.argumentsDelta ?? "");
          yield chunk;
        }
      } finally {
        // Anything the provider sent, also when the reader closed the stream early or it broke off midway.
        if (received) {
          const charged = chargedUsage(usage, () => ({ input: estimateRequestTokens(request), output: estimateAnswerTokens(answer, []) }));
          onCall({ providerId: String(request.provider.providerId), model: effectiveModelName(request.provider), ...charged });
        }
      }
    };
  }
  if (adapter.testConnection) wrapped.testConnection = adapter.testConnection.bind(adapter);
  return wrapped;
}

export class MeteredProviderRegistry extends ProviderRegistry {
  private readonly wrapped = new WeakMap<LLMProviderAdapter, LLMProviderAdapter>();

  constructor(
    private readonly base: ProviderRegistry,
    private readonly onCall: (call: MeteredModelCall) => void
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
    const metered = meteredProviderAdapter(adapter, this.onCall);
    this.wrapped.set(adapter, metered);
    return metered;
  }
}

/** A registry whose adapters are `base`'s, each answered call reported to `onCall`. `base` is left untouched. */
export function createMeteredProviderRegistry(base: ProviderRegistry, onCall: (call: MeteredModelCall) => void): ProviderRegistry {
  return new MeteredProviderRegistry(base, onCall);
}
