import type {
  MCPServerConfig,
  MCPServerDefinition,
  MCPToolDefinition,
  MCPToolResult,
  SecretReference,
  ToolDefinition
} from "@ai-orchestrator/shared";

export interface MCPExecutionContext {
  resolveSecret: (secretRef?: SecretReference) => Promise<string | undefined>;
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
}

export interface ResolvedMCPTool {
  exposedName: string;
  originalName: string;
  serverId: string;
  definition: ToolDefinition;
}