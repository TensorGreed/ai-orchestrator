import type { ProviderDefinition } from "@ai-orchestrator/shared";
import type { LLMProviderAdapter } from "./types";

export class ProviderRegistry {
  private readonly providers = new Map<string, LLMProviderAdapter>();

  register(provider: LLMProviderAdapter): void {
    this.providers.set(provider.definition.id, provider);
  }

  get(providerId: string): LLMProviderAdapter {
    const adapter = this.providers.get(providerId);
    if (!adapter) {
      throw new Error(`Unknown provider adapter: ${providerId}`);
    }
    return adapter;
  }

  tryGet(providerId: string): LLMProviderAdapter | undefined {
    return this.providers.get(providerId);
  }

  listDefinitions(): ProviderDefinition[] {
    return [...this.providers.values()].map((provider) => provider.definition);
  }
}