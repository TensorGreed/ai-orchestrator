import { ProviderRegistry } from "./registry";
import { GeminiProviderAdapter } from "./providers/gemini";
import { OllamaProviderAdapter } from "./providers/ollama";
import { OpenAICompatibleProviderAdapter } from "./providers/openai-compatible";
import { OpenAICloudProviderAdapter } from "./providers/openai";
import { AnthropicProviderAdapter } from "./providers/anthropic";
import { AzureOpenAIProviderAdapter } from "./providers/azure-openai";

export * from "./types";
export * from "./registry";
export * from "./providers/openai-compatible";
export * from "./providers/openai";
export * from "./providers/ollama";
export * from "./providers/gemini";
export * from "./providers/anthropic";
export * from "./providers/azure-openai";

export function createDefaultProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(new OllamaProviderAdapter());
  registry.register(new OpenAICompatibleProviderAdapter());
  registry.register(new OpenAICloudProviderAdapter());
  registry.register(new AzureOpenAIProviderAdapter());
  registry.register(new GeminiProviderAdapter());
  registry.register(new AnthropicProviderAdapter());
  return registry;
}
