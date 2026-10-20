import type {
  McpToolAnnotations,
  MCPServerConfig,
  MCPServerDefinition,
  MCPToolDefinition,
  MCPToolResult,
  SecretReference,
  ToolDefinition
} from "@ai-orchestrator/shared";

export interface MCPExecutionContext {
  resolveSecret: (secretRef?: SecretReference) => Promise<string | undefined>;
  runtimeState?: Map<string, unknown>;
}

export interface MCPServerAdapter {
  definition: MCPServerDefinition;
  discoverTools(config: MCPServerConfig, context: MCPExecutionContext): Promise<MCPToolDefinition[]>;
  invokeTool(
    toolName: string,
    args: Record<string, unknown>,
    config: MCPServerConfig,
    context: MCPExecutionContext
  ): Promise<MCPToolResult>;
  /**
   * Release anything the adapter cached in `context.runtimeState` (child
   * processes, sessions). Callers that create a short-lived context, such as
   * the registry health probe, call this when they are done with it.
   */
  closeSessions?(context: MCPExecutionContext): Promise<void> | void;
}

export interface ResolvedMCPTool {
  exposedName: string;
  originalName: string;
  serverId: string;
  /** Registry entry the tool came from, when the server config referenced one. */
  registryServerId?: string;
  /** Phase 10.2 — annotations the server sent for this tool. */
  annotations?: McpToolAnnotations;
  definition: ToolDefinition;
}
