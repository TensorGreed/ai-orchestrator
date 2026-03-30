import { ProviderRegistry } from "./registry";
import { GeminiProviderAdapter } from "./providers/gemini";
import { OllamaProviderAdapter } from "./providers/ollama";
import { OpenAICompatibleProviderAdapter } from "./providers/openai-compatible";
import { OpenAICloudProviderAdapter } from "./providers/openai";

export * from "./types";
export * from "./registry";
export * from "./providers/openai-compatible";
export * from "./providers/openai";
export * from "./providers/ollama";
export * from "./providers/gemini";

export function createDefaultProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(new OllamaProviderAdapter());
  registry.register(new OpenAICompatibleProviderAdapter());
  registry.register(new OpenAICloudProviderAdapter());
  registry.register(new GeminiProviderAdapter());
  return registry;
}