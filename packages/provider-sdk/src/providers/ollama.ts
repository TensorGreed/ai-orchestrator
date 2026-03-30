import type { ProviderDefinition } from "@ai-orchestrator/shared";
import type { LLMProviderAdapter, ProviderCallRequest, ProviderExecutionContext } from "../types";
import { callOpenAICompatible } from "./openai-compatible-base";

export class OllamaProviderAdapter implements LLMProviderAdapter {
  readonly definition: ProviderDefinition = {
    id: "ollama",
    label: "Ollama",
    supportsTools: true,
    configSchema: {
      type: "object",
      properties: {
        baseUrl: { type: "string", format: "uri", default: "http://localhost:11434/v1" },
        model: { type: "string" }
      },
      required: ["model"]
    }
  };

  generate(request: ProviderCallRequest, context: ProviderExecutionContext) {
    return callOpenAICompatible(request, context, {
      id: this.definition.id,
      label: this.definition.label,
      supportsTools: true,
      defaultBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1",
      requiresApiKey: false
    });
  }
}