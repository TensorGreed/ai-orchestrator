import type { AgentRunRequest, AgentRunState, ChatMessage, ToolCall, ToolDefinition } from "@ai-orchestrator/shared";
import type { ProviderRegistry } from "@ai-orchestrator/provider-sdk";

export interface AgentToolRuntime {
  tools: ToolDefinition[];
  invokeTool: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
}

export interface AgentRuntimeContext {
  providerRegistry: ProviderRegistry;
  resolveSecret: (secretRef?: { secretId: string }) => Promise<string | undefined>;
  memoryStore?: AgentSessionMemoryStore;
}

export interface AgentRuntimeAdapter {
  id: string;
  run(request: AgentRunRequest, tools: AgentToolRuntime, context: AgentRuntimeContext): Promise<AgentRunState>;
}

export interface InternalToolResult {
  toolCallId: string;
  toolName: string;
  output: unknown;
  error?: string;
}

export interface AgentSessionMemoryStore {
  loadMessages(namespace: string, sessionId: string): Promise<ChatMessage[]>;
  saveMessages(namespace: string, sessionId: string, messages: ChatMessage[]): Promise<void>;
}

export function createToolErrorResult(call: ToolCall, error: unknown): InternalToolResult {
  return {
    toolCallId: call.id,
    toolName: call.name,
    output: null,
    error: error instanceof Error ? error.message : "Tool call failed"
  };
}
