import type {
  ChatMessage,
  LLMCallResponse,
  LLMFinishReason,
  LLMUsage,
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
  /**
   * 12.6b — request parameters beyond the model config. All optional: without them every adapter sends exactly what
   * it sent before. Adapters that cannot honour one ignore it; `providerCallOptionSupport` says which ones each
   * provider honours, so a caller that must not drop a parameter can refuse the request instead.
   */
  options?: ProviderCallOptions;
}

/** 12.6b — how the model may use the tools it was given. A `{ name }` forces that one tool. */
export type ProviderToolChoice = "auto" | "none" | "required" | { name: string };

/** 12.6b — the shape the answer must take: plain text, any JSON object, or JSON matching a schema. */
export type ProviderResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; jsonSchema: { name: string; description?: string; schema?: Record<string, unknown>; strict?: boolean } };

export interface ProviderCallOptions {
  topP?: number;
  /** Up to four stop sequences. */
  stop?: string[];
  seed?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  responseFormat?: ProviderResponseFormat;
  toolChoice?: ProviderToolChoice;
  parallelToolCalls?: boolean;
  /** An end-user id for the provider's abuse monitoring (OpenAI family). */
  user?: string;
  /**
   * Leave the adapter's own defaults out (temperature 0.2, Gemini's 1024 output tokens): a parameter the request does
   * not set is not sent, so the provider's default applies. Runs keep the adapter defaults (this is unset there).
   */
  providerDefaults?: boolean;
  /** Streaming (OpenAI family): ask for a final usage chunk (`stream_options.include_usage`). */
  streamUsage?: boolean;
  /**
   * Streaming (OpenAI family): throw on a failure the provider reports inside the stream (an error frame) and on a body
   * that ends with no finish reason, `[DONE]` or usage frame. Runs leave this unset: both read as a normal end.
   */
  strictStream?: boolean;
  /**
   * Azure OpenAI: send the images of user messages. Workflow runs leave this unset and Azure's body stays text only, as
   * it always was (a text-only deployment would refuse the image, and the data would newly leave for Azure).
   */
  images?: boolean;
  /**
   * OpenAI only: send the output limit as `max_completion_tokens`, the name newer models require, because the caller
   * used that name. Other providers keep `max_tokens`: OpenAI-compatible servers do not all know the new name.
   */
  maxCompletionTokens?: boolean;
}

export type LLMStreamChunk =
  | {
      type: "text_delta";
      textDelta: string;
    }
  | {
      type: "tool_call_delta";
      /** 12.6b — which tool call of the answer the delta belongs to (OpenAI family; absent elsewhere). */
      index?: number;
      toolCallId?: string;
      name?: string;
      argumentsDelta?: string;
    }
  /** 12.6b — why the model stopped (OpenAI family, when the provider says). */
  | {
      type: "finish";
      reason: LLMFinishReason;
    }
  /** 12.6b — the call's token usage (OpenAI family with `options.streamUsage`, when the provider sends it). */
  | {
      type: "usage";
      usage: LLMUsage;
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
