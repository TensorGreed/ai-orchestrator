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
 * Map an error category (and optional metadata) to a one-sentence remediation
 * hint that a human user can act on without reading source. Pure function so it
 * can be called from any error site or directly from the UI when re-rendering
 * legacy execution history rows that lack a stored remediation.
 *
 * Metadata keys we look at when refining the message:
 *   - providerId  (e.g. "openai", "anthropic") for PROVIDER_AUTH / PROVIDER_CONFIG
 *   - serverId    (e.g. "http_mcp", "stdio_mcp") for MCP_AUTH / MCP_TOOL_NOT_FOUND
 *   - nodeType    for NODE_CONFIG to mention the affected node kind
 *   - secretRef   for PROVIDER_AUTH to hint at the named secret
 *   - timeoutMs   for WORKFLOW_TIMEOUT to repeat the configured value
 */
export function remediationForCategory(
  category: ErrorCategory,
  metadata?: Record<string, unknown>
): string {
  const meta = metadata ?? {};
  const provider = typeof meta.providerId === "string" ? meta.providerId : undefined;
  const serverId = typeof meta.serverId === "string" ? meta.serverId : undefined;
  const nodeType = typeof meta.nodeType === "string" ? meta.nodeType : undefined;

  switch (category) {
    case ErrorCategory.PROVIDER_TRANSIENT:
      return "The LLM provider returned a transient error (rate-limit or 5xx). The runtime already retried with backoff — try running the workflow again, or check the provider's status page.";
    case ErrorCategory.PROVIDER_AUTH:
      return provider
        ? `The ${provider} provider rejected the API credentials. Open Settings → Secrets and verify the secret value, or set the matching env var (e.g. OPENAI_API_KEY for openai, ANTHROPIC_API_KEY for anthropic).`
        : "The LLM provider rejected the credentials. Verify the API key in Settings → Secrets, or set the matching environment variable.";
    case ErrorCategory.PROVIDER_CONFIG:
      return provider
        ? `The ${provider} provider config is missing a required field (commonly endpoint, model, or API key). Open the LLM Call node config and fill the missing field.`
        : "The provider config on this node is missing a required field — open the node and fill in endpoint, model, and credential references.";
    case ErrorCategory.PROVIDER_QUOTA:
      return "The LLM provider quota or rate limit is exhausted. Wait, switch to a different provider, or upgrade your plan.";
    case ErrorCategory.MCP_TRANSIENT:
      return "The MCP server returned a timeout or 5xx. Check that the server is reachable, or increase the request timeout in the MCP Tool node config.";
    case ErrorCategory.MCP_TOOL_NOT_FOUND:
      return "The agent tried to call a tool that the MCP server doesn't expose. Click Discover Tools on the MCP Tool node to refresh the tool list, or check the server's tool catalogue.";
    case ErrorCategory.MCP_TOOL_ARGS:
      return "The agent supplied arguments that don't match the tool's input schema. Open the MCP Tool node, click Probe Tool, and dry-run with sample args to see what the schema expects.";
    case ErrorCategory.MCP_AUTH:
      return serverId
        ? `The MCP server (${serverId}) rejected authentication. Open the MCP Tool node, verify the auth mode (none / bearer / basic) and the linked Auth Secret.`
        : "The MCP server rejected authentication. Verify the auth mode and the linked Auth Secret on the MCP Tool node.";
    case ErrorCategory.PARSER_INVALID_JSON:
      return "The Output Parser couldn't parse the LLM response as JSON. Try a more lenient parser strictness ('lenient' or 'anything_goes'), tighten the prompt, or attach an Output Guardrail with `must_contain_json`.";
    case ErrorCategory.TEMPLATE_UNRESOLVED:
      return "A template variable in this node references a key that wasn't produced by an upstream node. Open the node and check that every {{...}} reference matches an upstream output key.";
    case ErrorCategory.CONNECTOR_TRANSIENT:
      return "An external connector (database, API, etc.) returned a transient error. Retry the workflow, or check the connector's reachability and credentials.";
    case ErrorCategory.WORKFLOW_TIMEOUT: {
      const timeout = typeof meta.timeoutMs === "number" ? meta.timeoutMs : undefined;
      return timeout
        ? `Workflow exceeded the ${timeout}ms execution timeout. Increase WORKFLOW_EXECUTION_TIMEOUT_MS or pass executionTimeoutMs in the webhook payload for long-running agent flows.`
        : "Workflow exceeded the execution timeout. Increase WORKFLOW_EXECUTION_TIMEOUT_MS or pass executionTimeoutMs in the webhook payload.";
    }
    case ErrorCategory.WORKFLOW_CIRCULAR:
      return "A cycle was detected in the workflow graph. Open the editor and remove the loop — every execution edge must form a DAG.";
    case ErrorCategory.NODE_CONFIG:
      return nodeType
        ? `The ${nodeType} node has a missing or invalid required field. Double-click the node to open its config and fill the highlighted fields.`
        : "A node has a missing or invalid required config field. Open the node config and fill the required fields.";
    case ErrorCategory.WORKFLOW_STOPPED:
      return "A stop_and_error node halted the workflow on purpose. The condition before the stop node defines when this triggers.";
    case ErrorCategory.NOT_IMPLEMENTED:
      return "This integration is registered but its runtime dependency isn't installed. Install the required optional npm package (the message usually names it) and restart the API.";
    case ErrorCategory.CONFIGURATION:
      return "A runtime dependency is missing or misconfigured. Check the message for the specific binary or env var, install it, and restart the API.";
    case ErrorCategory.UNKNOWN:
    default:
      return "Open the execution log for the full error and stack trace. If the message looks like a bug, please file an issue at github.com/TensorGreed/ai-orchestrator/issues with the workflow JSON and the failing node ID.";
  }
}

/**
 * Structured workflow error with category, retryability, metadata, and a
 * human-readable remediation hint. Can be used throughout the orchestrator
 * for consistent error handling and surfacing in the UI.
 *
 * `remediation` is auto-derived from the category (and metadata) by default,
 * so most call sites only need to pick the right category. Pass an explicit
 * `remediation` argument when the default text would be misleading.
 */
export class WorkflowError extends Error {
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly metadata?: Record<string, unknown>;
  readonly remediation: string;

  constructor(
    message: string,
    category: ErrorCategory,
    retryable: boolean,
    metadata?: Record<string, unknown>,
    remediation?: string
  ) {
    super(message);
    this.name = "WorkflowError";
    this.category = category;
    this.retryable = retryable;
    this.metadata = metadata;
    this.remediation = remediation ?? remediationForCategory(category, metadata);
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
