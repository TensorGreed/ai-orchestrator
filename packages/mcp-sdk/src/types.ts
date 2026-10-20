import type {
  McpToolAnnotations,
  McpToolProgressEvent,
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
  /**
   * Phase 10.5 — the run's abort signal. When it fires, adapters send
   * `notifications/cancelled` for every in-flight request before they stop
   * waiting (HTTP: and abort the fetch).
   */
  signal?: AbortSignal;
  /**
   * Phase 10.5 — receives `notifications/progress` for `tools/call` requests.
   * Setting it makes adapters send a `progressToken` with each call.
   */
  onProgress?: (event: McpToolProgressEvent) => void;
}

/**
 * Phase 10.5 — hands the http adapter an OAuth access token for a registry
 * server whose connection uses `authType: "oauth"`. The API implements it on
 * top of SecretService; tokens never pass through node configs.
 */
export interface McpOAuthTokenProvider {
  /**
   * A valid access token, refreshed first when it is close to expiry or when
   * `forceRefresh` is set (the server answered 401). Throws with an
   * actionable message when the server is not connected.
   */
  getAccessToken(registryServerId: string, options?: { forceRefresh?: boolean }): Promise<string>;
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
  /** Phase 10.5 — the tool's outputSchema, when declared. */
  outputSchema?: Record<string, unknown>;
  definition: ToolDefinition;
}
