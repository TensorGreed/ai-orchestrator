import type {
  McpElicitationRequest,
  McpElicitationResult,
  McpListChangedEvent,
  McpPrompt,
  McpPromptGetResult,
  McpResource,
  McpResourceReadResult,
  McpResourceTemplate,
  McpSamplingRequest,
  McpSamplingResult,
  McpServerCapabilities,
  McpToolAnnotations,
  McpToolProgressEvent,
  MCPServerConfig,
  MCPServerDefinition,
  MCPToolDefinition,
  MCPToolResult,
  SecretReference,
  ToolDefinition
} from "@ai-orchestrator/shared";

/** Where a server-initiated request came from, for the handlers in `MCPExecutionContext`. */
export interface McpServerRequestOrigin {
  serverId: string;
  registryServerId?: string;
  /** The tool whose `tools/call` was in flight, when the request arrived during one. */
  toolName?: string;
}

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
  /**
   * Phase 10.5 — answers `elicitation/create`. Without a handler every
   * request is declined, which is what unattended runs, probes and gateway
   * calls want. The handler may take as long as a person needs; adapters do
   * not time it out (the run's own timeout and abort signal still apply).
   */
  onElicitation?: (request: McpElicitationRequest, origin: McpServerRequestOrigin) => Promise<McpElicitationResult>;
  /**
   * Phase 10.5 — answers `sampling/createMessage`. Without a handler the
   * request fails with a JSON-RPC error telling the server that sampling is
   * not available for this call. The `sampling` client capability is only
   * advertised when a handler is set.
   */
  onSampling?: (request: McpSamplingRequest, origin: McpServerRequestOrigin) => Promise<McpSamplingResult>;
  /** Phase 10.5 — receives `notifications/{tools,resources,prompts}/list_changed`. */
  onListChanged?: (event: McpListChangedEvent) => void;
  /**
   * Phase 10.7 — timeout for `tools/call` requests made with this context,
   * overriding the connection's `timeoutMs` (the runtime limits wrapper sets
   * it from the server's or the tool's limit).
   */
  callTimeoutMs?: number;
  /**
   * Phase 10.7 — set by health probes: the call skips rate limits and
   * concurrency caps and is not counted by the circuit breaker.
   */
  bypassRuntimeLimits?: boolean;
}

/** Options for `readResource`. */
export interface McpReadResourceOptions {
  /** Decoded size limit across every content item; larger reads fail. */
  maxBytes?: number;
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
  getAccessToken(registryServerId: string, options?: McpAccessTokenOptions): Promise<string>;
}

export interface McpAccessTokenOptions {
  forceRefresh?: boolean;
  /**
   * Phase 10.7 — for servers with `credentialMode: "delegated"`: the user
   * whose own connection to use. A delegated server without one fails; the
   * provider never falls back to the service connection.
   */
  userId?: string;
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
  /** Phase 10.5 — the capabilities the server declared in `initialize`. */
  describeServer?(config: MCPServerConfig, context: MCPExecutionContext): Promise<McpServerCapabilities>;
  /** Phase 10.5 — `resources/list`, every page. Empty when the server has no resources capability. */
  listResources?(config: MCPServerConfig, context: MCPExecutionContext): Promise<McpResource[]>;
  /** Phase 10.5 — `resources/templates/list`, every page. */
  listResourceTemplates?(config: MCPServerConfig, context: MCPExecutionContext): Promise<McpResourceTemplate[]>;
  /** Phase 10.5 — `resources/read` for one URI, with a size limit. */
  readResource?(
    uri: string,
    config: MCPServerConfig,
    context: MCPExecutionContext,
    options?: McpReadResourceOptions
  ): Promise<McpResourceReadResult>;
  /** Phase 10.5 — `prompts/list`, every page. Empty when the server has no prompts capability. */
  listPrompts?(config: MCPServerConfig, context: MCPExecutionContext): Promise<McpPrompt[]>;
  /** Phase 10.5 — `prompts/get` with arguments. */
  getPrompt?(
    name: string,
    args: Record<string, string>,
    config: MCPServerConfig,
    context: MCPExecutionContext
  ): Promise<McpPromptGetResult>;
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
