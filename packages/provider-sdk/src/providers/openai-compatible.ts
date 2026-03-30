import type { ProviderDefinition } from "@ai-orchestrator/shared";
import type { LLMProviderAdapter, ProviderCallRequest, ProviderExecutionContext } from "../types";
import { callOpenAICompatible } from "./openai-compatible-base";

export class OpenAICompatibleProviderAdapter implements LLMProviderAdapter {
  readonly definition: ProviderDefinition = {
    id: "openai_compatible",
    label: "OpenAI-Compatible",
    supportsTools: true,
    configSchema: {
      type: "object",
      properties: {
        baseUrl: { type: "string", format: "uri" },
        model: { type: "string" },
        secretRef: { type: "object", properties: { secretId: { type: "string" } } }
      },
      required: ["baseUrl", "model"]
    }
  };

  generate(request: ProviderCallRequest, context: ProviderExecutionContext) {
    return callOpenAICompatible(request, context, {
      id: this.definition.id,
      label: this.definition.label,
      supportsTools: true,
      requiresApiKey: false
    });
  }
}