/**
 * Structured error taxonomy for the AI Orchestrator.
 * Provides categorized error types for better observability,
 * automated recovery decisions, and debugging.
 */

export enum ErrorCategory {
  /** Transient provider errors: 429, 500, 502, 503, 504, network timeout */
  PROVIDER_TRANSIENT = "provider_transient",
  /** Provider authentication failure: 401, 403 */
  PROVIDER_AUTH = "provider_auth",
  /** Provider configuration error: missing endpoint, model, API key */
  PROVIDER_CONFIG = "provider_config",
  /** Provider quota/rate-limit exhaustion */
  PROVIDER_QUOTA = "provider_quota",
  /** MCP server transient failure: timeout, 5xx */
  MCP_TRANSIENT = "mcp_transient",
  /** MCP tool name not found */
  MCP_TOOL_NOT_FOUND = "mcp_tool_not_found",
  /** MCP tool argument validation failure */
  MCP_TOOL_ARGS = "mcp_tool_args",
  /** MCP server authentication failure */
  MCP_AUTH = "mcp_auth",
  /** Output parser: invalid JSON / parsing failure */
  PARSER_INVALID_JSON = "parser_invalid_json",
  /** Template: unresolved variable key */
  TEMPLATE_UNRESOLVED = "template_unresolved",
  /** External connector transient failure */
  CONNECTOR_TRANSIENT = "connector_transient",
  /** Workflow-level execution timeout */
  WORKFLOW_TIMEOUT = "workflow_timeout",
  /** Circular workflow execution detected */
  WORKFLOW_CIRCULAR = "workflow_circular",
  /** Missing required node configuration */
  NODE_CONFIG = "node_config",
  /** Uncategorized error */
  UNKNOWN = "unknown",
  /** Workflow intentionally stopped by a stop_and_error node */
  WORKFLOW_STOPPED = "workflow_stopped",
  /** Feature/operation is not implemented in this build */
  NOT_IMPLEMENTED = "not_implemented",
  /** Configuration error (missing dependency, runtime not installed, etc.) */
  CONFIGURATION = "configuration"
}

/**
 * Structured workflow error with category, retryability, and metadata.
 * Can be used throughout the orchestrator for consistent error handling.
 */
export class WorkflowError extends Error {
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly metadata?: Record<string, unknown>;

  constructor(
    message: string,
    category: ErrorCategory,
    retryable: boolean,
    metadata?: Record<string, unknown>
  ) {
    super(message);
    this.name = "WorkflowError";
    this.category = category;
    this.retryable = retryable;
    this.metadata = metadata;
  }

  /** Convenience factory for transient provider errors */
  static providerTransient(message: string, meta?: Record<string, unknown>): WorkflowError {
    return new WorkflowError(message, ErrorCategory.PROVIDER_TRANSIENT, true, meta);
  }

  /** Convenience factory for provider auth errors */
  static providerAuth(message: string, meta?: Record<string, unknown>): WorkflowError {
    return new WorkflowError(message, ErrorCategory.PROVIDER_AUTH, false, meta);
  }

  /** Convenience factory for MCP transient errors */
  static mcpTransient(message: string, meta?: Record<string, unknown>): WorkflowError {
    return new WorkflowError(message, ErrorCategory.MCP_TRANSIENT, true, meta);
  }

  /** Convenience factory for node config errors */
  static nodeConfig(message: string, meta?: Record<string, unknown>): WorkflowError {
    return new WorkflowError(message, ErrorCategory.NODE_CONFIG, false, meta);
  }

  /** Convenience factory for parser errors */
  static parserError(message: string, meta?: Record<string, unknown>): WorkflowError {
    return new WorkflowError(message, ErrorCategory.PARSER_INVALID_JSON, false, meta);
  }

  /** Convenience factory for timeout errors */
  static timeout(message: string, meta?: Record<string, unknown>): WorkflowError {
    return new WorkflowError(message, ErrorCategory.WORKFLOW_TIMEOUT, false, meta);
  }
}
