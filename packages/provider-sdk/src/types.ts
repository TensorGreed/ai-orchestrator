import type {
  ChatMessage,
  LLMCallResponse,
  LLMProviderConfig,
  ProviderDefinition,
  SecretReference,
  ToolDefinition
} from "@ai-orchestrator/shared";

export interface ProviderExecutionContext {
  resolveSecret: (secretRef?: SecretReference) => Promise<string | undefined>;
}

export interface ProviderCallRequest {
  provider: LLMProviderConfig;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
}

export interface LLMProviderAdapter {
  definition: ProviderDefinition;
  generate(request: ProviderCallRequest, context: ProviderExecutionContext): Promise<LLMCallResponse>;
}