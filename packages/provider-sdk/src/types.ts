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

export type LLMStreamChunk =
  | {
      type: "text_delta";
      textDelta: string;
    }
  | {
      type: "tool_call_delta";
      toolCallId?: string;
      name?: string;
      argumentsDelta?: string;
    };

export interface ProviderTestResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
}

export interface LLMProviderAdapter {
  definition: ProviderDefinition;
  generate(request: ProviderCallRequest, context: ProviderExecutionContext): Promise<LLMCallResponse>;
  generateStream?(
    request: ProviderCallRequest,
    context: ProviderExecutionContext
  ): AsyncGenerator<LLMStreamChunk>;
  testConnection?(
    provider: LLMProviderConfig,
    context: ProviderExecutionContext
  ): Promise<ProviderTestResult>;
}
