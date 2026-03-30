import type { ProviderDefinition } from "@ai-orchestrator/shared";
import type { LLMProviderAdapter, ProviderCallRequest, ProviderExecutionContext } from "../types";
import { callOpenAICompatible } from "./openai-compatible-base";

export class OpenAICloudProviderAdapter implements LLMProviderAdapter {
  readonly definition: ProviderDefinition = {
    id: "openai",
    label: "OpenAI Cloud",
    supportsTools: true,
    configSchema: {
      type: "object",
      properties: {
        model: { type: "string" },
        secretRef: { type: "object", properties: { secretId: { type: "string" } } }
      },
      required: ["model"]
    }
  };

  generate(request: ProviderCallRequest, context: ProviderExecutionContext) {
    return callOpenAICompatible(request, context, {
      id: this.definition.id,
      label: this.definition.label,
      supportsTools: true,
      defaultBaseUrl: "https://api.openai.com/v1",
      defaultApiKeyEnv: "OPENAI_API_KEY",
      requiresApiKey: true
    });
  }
}