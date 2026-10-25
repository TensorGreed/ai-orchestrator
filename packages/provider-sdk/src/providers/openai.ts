import type { ProviderDefinition } from "@ai-orchestrator/shared";
import type { LLMProviderAdapter, ProviderCallRequest, ProviderExecutionContext } from "../types";
import { PROVIDER_DEFAULT_BASE_URLS } from "../default-base-urls";
import { callOpenAICompatible, callOpenAICompatibleStream } from "./openai-compatible-base";

export class OpenAICloudProviderAdapter implements LLMProviderAdapter {
  readonly definition: ProviderDefinition = {
    id: "openai",
    label: "OpenAI Cloud",
    supportsTools: true,
    configSchema: {
      type: "object",
      properties: {
        baseUrl: { type: "string", format: "uri" },
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
      defaultBaseUrl: PROVIDER_DEFAULT_BASE_URLS.openai,
      defaultApiKeyEnv: "OPENAI_API_KEY",
      requiresApiKey: true
    });
  }

  generateStream(request: ProviderCallRequest, context: ProviderExecutionContext) {
    return callOpenAICompatibleStream(request, context, {
      id: this.definition.id,
      label: this.definition.label,
      supportsTools: true,
      defaultBaseUrl: PROVIDER_DEFAULT_BASE_URLS.openai,
      defaultApiKeyEnv: "OPENAI_API_KEY",
      requiresApiKey: true
    });
  }
}
