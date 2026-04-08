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
  toolDataStore?: AgentSessionToolDataStore;
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

export interface AgentSessionToolRecord {
  id: string;
  namespace: string;
  sessionId: string;
  toolName: string;
  toolCallId?: string;
  args: Record<string, unknown>;
  output: unknown;
  error?: string;
  summary?: unknown;
  createdAt: string;
}

export interface AgentSessionToolDataStore {
  saveToolCall(input: {
    namespace: string;
    sessionId: string;
    toolName: string;
    toolCallId?: string;
    args: Record<string, unknown>;
    output: unknown;
    error?: string;
    summary?: unknown;
  }): Promise<AgentSessionToolRecord>;
  listToolCalls(input: {
    namespace: string;
    sessionId: string;
    toolName?: string;
    limit?: number;
  }): Promise<Array<Omit<AgentSessionToolRecord, "output">>>;
  getToolCall(input: {
    namespace: string;
    sessionId: string;
    id: string;
  }): Promise<AgentSessionToolRecord | null>;
}

export function createToolErrorResult(call: ToolCall, error: unknown): InternalToolResult {
  return {
    toolCallId: call.id,
    toolName: call.name,
    output: null,
    error: error instanceof Error ? error.message : "Tool call failed"
  };
}
