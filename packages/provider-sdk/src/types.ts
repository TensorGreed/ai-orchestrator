import type {
  ChatMessage,
  LLMCallResponse,
  LLMProviderConfig,
  ProviderDefinition,
  SecretReference,
  ToolDefinition
} from "@ai-orchestrator/shared";
import type { ResilientFetchRetryInfo } from "./resilient-fetch";

export interface ProviderExecutionContext {
  resolveSecret: (secretRef?: SecretReference) => Promise<string | undefined>;
  /**
   * The run's abort signal. Adapters pass it to every request, so a canceled
   * or timed-out run stops the in-flight call, its backoff waits and any
   * body or stream read.
   */
  signal?: AbortSignal;
  /** Called before each retry backoff wait (no request data is included). */
  onRetry?: (info: ResilientFetchRetryInfo) => void;
  /**
   * Phase 15.3 — where the call comes from: the node and, in an agent loop,
   * the iteration. Adapters ignore it; the model tape keys calls by it.
   */
  callSite?: ProviderCallSite;
}

export interface ProviderCallSite {
  nodeId?: string;
  iteration?: number;
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
