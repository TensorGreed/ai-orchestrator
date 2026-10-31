import type {
  McpCredentialMode,
  McpDelegatedFallback,
  McpDelegatedUser,
  McpRuntimeLimits,
  McpRuntimeRejection,
  McpSandboxSettings
} from "./mcp-runtime-safety";
import type { DataLabels, NodeLabelMap } from "./data-labels";
import type { McpToolCallLabels } from "./taint-policy";

export const WORKFLOW_SCHEMA_VERSION = "1.0.0";
export const MAX_SUB_WORKFLOW_DEPTH = 10;

export type NodeCategory =
  | "Input"
  | "LLM"
  | "Agent"
  | "MCP"
  | "RAG"
  | "Connector"
  | "Utility"
  | "Output";

export type WorkflowNodeType =
  | "schedule_trigger"
  | "webhook_input"
  | "http_request"
  | "text_input"
  | "system_prompt"
  | "user_prompt"
  | "loop_node"
  | "merge_node"
  | "execute_workflow"
  | "wait_node"
  | "set_node"
  | "code_node"
  | "prompt_template"
  | "llm_call"
  | "openai_chat_model"
  | "anthropic_chat_model"
  | "ollama_chat_model"
  | "openai_compatible_chat_model"
  | "ai_gateway_chat_model"
  | "agent_orchestrator"
  | "supervisor_node"
  | "local_memory"
  | "session_artifact_save"
  | "session_artifact_load"
  | "chat_intent_router"
  | "helper_chat_response"
  | "mcp_tool"
  | "rag_retrieve"
  | "rerank"
  | "extract_citations"
  | "chart"
  | "web_browse"
  | "connector_source"
  | "google_drive_source"
  | "azure_storage"
  | "azure_cosmos_db"
  | "azure_monitor_http"
  | "azure_openai_chat_model"
  | "google_gemini_chat_model"
  | "embeddings_azure_openai"
  | "azure_ai_search_vector_store"
  | "qdrant_vector_store"
  | "document_chunker"
  | "output_parser"
  | "human_approval"
  | "approval_gate"
  | "input_validator"
  | "output_guardrail"
  | "guard"
  | "guard_protection"
  | "basic_llm_chain"
  | "qa_chain"
  | "summarization_chain"
  | "information_extractor"
  | "text_classifier"
  | "sentiment_analysis"
  | "ai_transform"
  | "if_node"
  | "switch_node"
  | "try_catch"
  | "webhook_response"
  | "pdf_output"
  | "output"
  | "sub_workflow_trigger"
  | "error_trigger"
  | "filter_node"
  | "stop_and_error"
  | "noop_node"
  | "aggregate_node"
  | "split_out_node"
  | "sort_node"
  | "limit_node"
  | "remove_duplicates_node"
  | "summarize_node"
  | "compare_datasets_node"
  | "rename_keys_node"
  | "edit_fields_node"
  | "date_time_node"
  | "crypto_node"
  | "jwt_node"
  | "xml_node"
  | "html_node"
  | "convert_to_file_node"
  | "extract_from_file_node"
  | "compression_node"
  | "edit_image_node"
  | "slack_send_message"
  | "slack_trigger"
  | "smtp_send_email"
  | "imap_email_trigger"
  | "google_sheets_read"
  | "google_sheets_append"
  | "google_sheets_update"
  | "google_sheets_trigger"
  | "postgres_query"
  | "postgres_trigger"
  | "mysql_query"
  | "mongo_operation"
  | "redis_command"
  | "redis_trigger"
  | "github_action"
  | "github_webhook_trigger"
  | "teams_send_message"
  | "notion_create_page"
  | "notion_query_database"
  | "airtable_create_record"
  | "airtable_list_records"
  | "airtable_update_record"
  | "jira_create_issue"
  | "jira_search_issues"
  | "salesforce_create_record"
  | "salesforce_query"
  | "hubspot_create_contact"
  | "hubspot_get_contact"
  | "stripe_create_customer"
  | "stripe_create_charge"
  | "stripe_webhook_trigger"
  | "aws_s3_put_object"
  | "aws_s3_get_object"
  | "aws_s3_list_objects"
  | "telegram_send_message"
  | "telegram_trigger"
  | "discord_send_message"
  | "discord_trigger"
  | "google_drive_trigger"
  | "google_calendar_create_event"
  | "google_calendar_list_events"
  | "twilio_send_sms"
  | "manual_trigger"
  | "form_trigger"
  | "chat_trigger"
  | "file_trigger"
  | "rss_trigger"
  | "sse_trigger"
  | "mcp_server_trigger"
  | "kafka_trigger"
  | "rabbitmq_trigger"
  | "mqtt_trigger"
  | "sticky_note";

export interface WorkflowNodePosition {
  x: number;
  y: number;
}

export interface NodeErrorConfig {
  continueOnFail?: boolean;
  retryOnFail?: boolean;
  maxRetries?: number;
  retryIntervalMs?: number;
  alwaysOutputData?: boolean;
}

export interface WorkflowNode<TConfig = Record<string, unknown>> {
  id: string;
  type: WorkflowNodeType;
  name: string;
  position: WorkflowNodePosition;
  config: TConfig;
  errorConfig?: NodeErrorConfig;
  /** UI-only: when true, the executor skips this node and passes its parent outputs downstream. */
  disabled?: boolean;
  /** UI-only: accent color key for visual grouping ("gray" | "red" | "orange" | "yellow" | "green" | "blue" | "purple" | "pink"). */
  color?: string;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  label?: string;
}

export interface WorkflowSettings {
  errorWorkflowId?: string;
  executionTimeoutMs?: number;
  /**
   * Phase 13.1 — the worker pool that runs this workflow's queued jobs (cluster mode; workers list their pools in
   * QUEUE_POOLS). Unset is `default`. Letters, digits, `_` or `-`, at most 63.
   */
  executionPool?: string;
  saveDataSuccessExecution?: "all" | "none";
  saveDataErrorExecution?: "all" | "none";
  /** Phase 7.3 — workflow activation state. */
  active?: boolean;
  /**
   * Phase 10.2 — when true, agents and MCP Tool nodes in this workflow can
   * only use read-only MCP tools. A tool is read-only when an admin marked it
   * so on the MCP servers page, or when its server annotates it with
   * `readOnlyHint: true`; every other tool counts as a write tool.
   */
  noWriteTools?: boolean;
  /**
   * Phase 11.2 — agents in this workflow pause for a person's approval
   * before they call an MCP write tool. Server annotations are not trusted
   * here: a tool is read-only for this gate only when an admin marked it
   * read-only in the tool policy; every other tool counts as a write tool.
   */
  writeToolApproval?: WriteToolApprovalSettings;
}

export interface WriteToolApprovalSettings {
  enabled: boolean;
  approverRoles?: Array<"admin" | "builder" | "operator" | "viewer">;
  approverUsers?: string[];
  allowSelfApproval?: boolean;
  timeoutMinutes?: number;
}

export const DEFAULT_PROJECT_ID = "default";

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  schemaVersion: string;
  workflowVersion: number;
  variables?: Record<string, string>;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  createdAt?: string;
  updatedAt?: string;
  settings?: WorkflowSettings;
  /** Phase 4.3 debug tooling: saved node outputs keyed by node id. */
  pinnedData?: Record<string, unknown>;
  /** Phase 4.2 — tags/organization. All optional for backwards-compat. */
  tags?: string[];
  projectId?: string;
  folderId?: string;
}

export interface WorkflowListItem {
  id: string;
  name: string;
  schemaVersion: string;
  workflowVersion: number;
  createdAt: string;
  updatedAt: string;
  tags?: string[];
  projectId?: string;
  folderId?: string;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Folder {
  id: string;
  name: string;
  parentId?: string;
  projectId: string;
  createdAt: string;
  updatedAt: string;
}

/** A secret a node's runtime handler reads, resolved from `config[key].secretId`. */
export interface NodeCredentialSpec {
  /** Config property holding `{ secretId }`, e.g. `secretRef`. */
  key: string;
  /** Preferred secret provider when creating a credential inline. */
  provider: string;
  label: string;
  /** What the stored secret value must contain, shown beside the picker. */
  hint: string;
  required: boolean;
}

export interface NodeDefinition {
  type: WorkflowNodeType;
  label: string;
  category: NodeCategory;
  description: string;
  configSchema: Record<string, unknown>;
  sampleConfig: Record<string, unknown>;
  /** Optional, additive: credentials the handler needs. Does not change the workflow JSON contract. */
  credentials?: NodeCredentialSpec[];
  /**
   * Optional: an entry node (Input category) whose executor only passes the run's input through, so running it has no
   * effect outside the run. Unset means the node may read or consume from an external system.
   */
  effectFreeEntry?: boolean;
}

export type NodeExecutionStatus =
  | "pending"
  | "running"
  | "success"
  | "error"
  | "skipped"
  | "waiting_approval"
  | "canceled";

export type WorkflowExecutionStatus = "success" | "error" | "partial" | "waiting_approval" | "canceled";

export interface NodeExecutionResult {
  nodeId: string;
  status: NodeExecutionStatus;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  error?: string;
  warnings?: string[];
  retriedNodes?: Array<{ nodeId: string; attempts: number; nodeType: string }>;
  errorCategory?: string;
  /** One-sentence human-readable hint on how to recover from this error.
   *  Auto-derived from errorCategory by the executor; surfaced in the UI
   *  below the raw error message so users don't have to read source. */
  errorRemediation?: string;
  retryable?: boolean;
  attempts?: number;
  /** Phase 10.5 — latest MCP tool progress reported while the node ran. */
  progress?: NodeProgressSnapshot;
  /** What the node did while it ran, oldest first, capped at NODE_ACTIVITY_LIMIT entries. */
  activity?: NodeActivityEvent[];
  /**
   * Phase 16 — where the node's output came from and the data classes it
   * holds (source `propagated`). Only on runs whose guard profiles track
   * labels, and only when not empty.
   */
  labels?: DataLabels;
}

/** Most activity entries kept per node; older ones are dropped. */
export const NODE_ACTIVITY_LIMIT = 50;
/** Longest preview text (prompt, URL, tool arguments) an activity entry carries. */
export const NODE_ACTIVITY_PREVIEW_CHARS = 400;

/**
 * One step a node took while it ran, streamed as the `node_activity` SSE event
 * and kept on the node result. Previews are short, truncated text; they never
 * carry headers, secret values or URL query strings.
 */
export type NodeActivity =
  /** The values the node actually used this run, once its templates resolved. */
  | { kind: "resolved_input"; fields: Record<string, string | number | boolean | string[]> }
  | {
      kind: "llm_call";
      phase: "start" | "end";
      providerId: string;
      model: string;
      /** Agent loop iteration this call belongs to. */
      iteration?: number;
      latencyMs?: number;
      error?: string;
    }
  | {
      kind: "retry";
      /** provider: HTTP retry inside the provider SDK; agent_llm: the agent loop retrying a failed model call; node: the node's retry policy. */
      scope: "provider" | "agent_llm" | "node";
      /** 1-based number of the attempt that just failed. */
      attempt: number;
      maxAttempts?: number;
      delayMs: number;
      reason: string;
    }
  | {
      kind: "agent_step";
      phase: "start" | "end";
      iteration: number;
      maxIterations: number;
      /** Tools the model asked for in this step (end only). */
      toolCalls?: string[];
      /** Set on the step that produced the final answer. */
      final?: boolean;
    }
  | {
      kind: "tool_call";
      phase: "start" | "end";
      toolName: string;
      toolCallId?: string;
      iteration?: number;
      /** Arguments after the guard ran, as truncated JSON (start only). */
      argsPreview?: string;
      durationMs?: number;
      outcome?: "ok" | "error" | "blocked";
      error?: string;
    };

export type NodeActivityEvent = NodeActivity & {
  nodeId: string;
  at: string;
  /** Increases per node within a run, so a client can order and de-duplicate entries. */
  seq: number;
  /** For a Supervisor's worker: the worker node whose loop produced the entry. */
  workerNodeId?: string;
};

export interface WorkflowExecutionResult {
  workflowId: string;
  status: WorkflowExecutionStatus;
  startedAt: string;
  completedAt: string;
  executionId?: string;
  customData?: Record<string, unknown>;
  nodeResults: NodeExecutionResult[];
  output?: unknown;
  error?: string;
  /** Same shape as NodeExecutionResult.errorCategory, attached to the
   *  workflow when execution stopped on a node error. */
  errorCategory?: string;
  /** Same shape as NodeExecutionResult.errorRemediation, attached to the
   *  workflow when execution stopped on a node error. */
  errorRemediation?: string;
  warnings?: string[];
  retriedNodes?: Array<{ nodeId: string; attempts: number; nodeType: string }>;
  /**
   * Populated when an `agent_orchestrator` node paused mid-iteration by
   * calling the built-in `agent_clarify` tool. Lets the chat UI render
   * the question with distinct styling and lets non-chat callers (webhook
   * / schedule / API consumers) decide how to surface the question to a
   * human and re-invoke the workflow with the reply. The workflow's
   * top-level `status` stays "success" — the agent did successfully
   * complete its turn by asking — but `clarification` tells consumers
   * the answer is not the final one.
   */
  clarification?: {
    question: string;
    reason?: string;
    /** The agent's tool-call id; used by the runtime on resume. */
    toolCallId: string;
    /** Which node raised the clarification. */
    nodeId: string;
  };
}

export interface WorkflowExecutionState {
  workflow: Workflow;
  nodeOrder: string[];
  nextNodeIndex: number;
  waitingNodeId: string;
  startedAt: string;
  globals: Record<string, unknown>;
  nodeOutputs: Record<string, unknown>;
  nodeResults: NodeExecutionResult[];
  skippedByBranch: string[];
  tryCatchScopes: Array<{
    nodeId: string;
    errorTargets: string[];
    successDescendants: string[];
  }>;
  hadContinuedErrors: boolean;
  finalOutput?: unknown;
  /** Phase 10.2 — the tool policy subject of the paused run, reused on resume. */
  toolPolicySubject?: McpToolPolicySubject;
  /**
   * Phase 12.1 — set when the run paused through an approval hand-off (a
   * guard verdict asked for approval) instead of a Human Approval node; it
   * says what approving or rejecting does when the run resumes.
   */
  approvalHandoff?: ApprovalHandoffState;
  /**
   * Phase 12.1 — guard approval keys granted by `rerun` hand-offs, written
   * only by the resume path. Kept out of `globals` so run input can never
   * carry an approval.
   */
  approvedHandoffKeys?: string[];
  /**
   * Phase 11.2 — results of write-tool calls a person approved, keyed by the
   * call's approval key, in call order. A re-run of the agent answers those
   * calls from here instead of calling the tool again, so an approved call
   * runs once. Written only by the engine; cleared when the node succeeds.
   */
  approvedToolResults?: Record<string, unknown[]>;
  /**
   * `approvedToolResults` sealed with the master key for storage: the API
   * stores a paused run with this in place of the plaintext field and opens it
   * again on resume. Written and read only by the API.
   */
  approvedToolResultsSealed?: string;
  /**
   * Phase 15.4 — the release channel the run started on. A resumed
   * production run keeps calling the published versions of its
   * sub-workflows. Written and read only by the API; absent means draft.
   */
  releaseChannel?: "production" | "draft";
  /** Phase 15.4 — the published version a production run started on (null: none was published), for its history. */
  releaseVersion?: number | null;
  /**
   * Phase 16 — the run's data labels, beside `nodeOutputs`: the input's
   * labels, every completed node's labels, and whether labels are tracked
   * (stored and scanned). A resumed run carries on with them.
   */
  dataLabels?: { input: DataLabels; nodes: NodeLabelMap; tracked: boolean };
}

/**
 * Phase 12.1 — approval hand-off. A node other than Human Approval can pause
 * the run for a person's decision:
 * - `route`: the node has its approve and reject outputs ready; resuming
 *   records the matching one and routes from it (the guard node).
 * - `rerun`: the node runs again after approval with the decision key
 *   accepted (an agent whose guard asked for approval mid-loop); rejecting
 *   fails the node.
 */
export type ApprovalHandoffState =
  | { kind: "route"; source: string; onApprove: unknown; onReject: unknown }
  | { kind: "rerun"; source: string; approvalKey: string; request?: ApprovalRequestSpec }
  /** Phase 11.2 — an Approval Gate node: it runs again on resume and turns the decision into its output. */
  | { kind: "gate"; source: "approval_gate"; request: ApprovalRequestSpec }
  /**
   * Phase 11.2 — a sub-workflow (sync Execute Workflow node) paused: the
   * parent pauses at that node with the child's paused state, and on resume
   * the node resumes the child with the decision instead of starting it.
   */
  | { kind: "sub_workflow"; source: "execute_workflow"; workflowId: string; workflowName?: string; childState: WorkflowExecutionState };

/** Phase 11.2 — what a person decided about a paused run. `timeout` is the sweeper's decision. */
export type ApprovalDecisionValue = "approve" | "reject" | "timeout";

export type ApprovalRequestKind = "approval_gate" | "human_approval" | "guard" | "agent_tool";

/** Phase 11.2 — one field an approver may edit before approving (approve-with-edits). */
export interface ApprovalEditableField {
  key: string;
  label?: string;
  type: "string" | "text" | "number" | "boolean" | "json";
  required?: boolean;
  maxLength?: number;
  /** The value the run proposed, rendered when the gate paused. */
  value?: unknown;
}

/**
 * Phase 11.2 — who may decide a paused run and what happens when nobody
 * does. Stored on the hand-off of the paused state. Empty `approverRoles`
 * and `approverUsers` mean any operator, builder or admin with execute
 * access to the workflow's project.
 */
export interface ApprovalRequestSpec {
  kind: ApprovalRequestKind;
  approverRoles: Array<"admin" | "builder" | "operator" | "viewer">;
  /** User ids or emails. */
  approverUsers: string[];
  /** The person who started the run may decide it. */
  allowSelfApproval: boolean;
  /** `fallback`: the gate's `timed_out` output; `reject`: handled as a rejection. */
  timeoutOutcome: "fallback" | "reject";
  /** A reason is required to reject. */
  requireRejectReason: boolean;
  editableFields: ApprovalEditableField[];
}

export interface WorkflowValidationIssue {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
  /** A "warning" does not make the workflow invalid. Absent means "error". */
  severity?: "error" | "warning";
}

export interface WorkflowValidationResult {
  valid: boolean;
  issues: WorkflowValidationIssue[];
  orderedNodeIds?: string[];
}

export interface SecretReference {
  secretId: string;
}

/**
 * Export-time representation of a secret reference used when a workflow is
 * serialised for version control. Contains the human-readable name + provider
 * so the target instance can resolve to a local `secretId` on import.
 */
export interface SecretReferenceStub {
  secretName: string;
  secretProvider?: string;
}

export interface VariableRecord {
  id: string;
  projectId: string;
  key: string;
  value: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowVersionRecord {
  id: string;
  workflowId: string;
  version: number;
  workflowJson: string;
  createdBy: string | null;
  changeNote: string | null;
  createdAt: string;
}

export interface GitSyncConfig {
  repoUrl: string;
  defaultBranch: string;
  authSecretId: string | null;
  workflowsDir: string;
  variablesFile: string;
  userName: string;
  userEmail: string;
  enabled: boolean;
  lastPushAt: string | null;
  lastPullAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

export interface GitSyncStatus {
  configured: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
  lastPushAt: string | null;
  lastPullAt: string | null;
  lastError: string | null;
}

export type LLMProviderId = "ollama" | "openai_compatible" | "openai" | "azure_openai" | "gemini" | (string & {});

export interface ProviderDefinition {
  id: string;
  label: string;
  supportsTools: boolean;
  configSchema: Record<string, unknown>;
}

export interface LLMProviderConfig {
  providerId: LLMProviderId;
  model: string;
  baseUrl?: string;
  secretRef?: SecretReference;
  temperature?: number;
  maxTokens?: number;
  extra?: Record<string, unknown>;
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

export interface ChatMessageImage {
  data: string;      // base64-encoded image data (no data URL prefix)
  mimeType: string;  // "image/png" | "image/jpeg" | "image/gif" | "image/webp"
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  images?: ChatMessageImage[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LLMCallRequest {
  provider: LLMProviderConfig;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
}

export interface LLMUsage {
  /** Tokens consumed by the prompt + tool messages. */
  inputTokens?: number;
  /** Tokens generated in the response. */
  outputTokens?: number;
  /** Sum where the provider reports it; otherwise undefined (caller should not infer it). */
  totalTokens?: number;
  /** Tokens served from the provider's prompt cache, when reported (Anthropic, OpenAI). */
  cachedInputTokens?: number;
}

export interface LLMCallResponse {
  content: string;
  toolCalls: ToolCall[];
  raw?: unknown;
  /**
   * Token-usage telemetry from the provider's response, when supplied.
   * Optional because not every provider reports it (e.g. local Ollama
   * doesn't always; the bundled `echo` provider never does).
   */
  usage?: LLMUsage;
  /** Wall-clock latency of the provider call in ms. Populated by the adapter. */
  latencyMs?: number;
}

export interface MCPToolDefinition extends ToolDefinition {
  serverId: string;
  serverLabel?: string;
  /** Phase 10.2 — behaviour hints the server sent with `tools/list`, when it sent any. */
  annotations?: McpToolAnnotations;
  /**
   * Phase 10.5 — JSON Schema the tool's `structuredContent` conforms to, when
   * the server declared one in `tools/list`.
   */
  outputSchema?: Record<string, unknown>;
}

/**
 * Phase 10.2 — MCP tool annotations (`tools/list` → `tools[].annotations`).
 * They are hints from the server, not guarantees; L2M uses `readOnlyHint`
 * to classify tools as read-only unless an admin overrides it.
 */
export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface MCPServerDefinition {
  id: string;
  label: string;
  description: string;
  configSchema: Record<string, unknown>;
  authSchema: Record<string, unknown>;
}

export interface MCPServerConfig {
  serverId: string;
  /**
   * Phase 10.1 — id of an entry in the MCP server registry (`mcp_servers`).
   * When set, the runtime takes the adapter, connection and secretRef from the
   * registry entry; any inline values on the node are ignored.
   */
  registryServerId?: string;
  label?: string;
  connection?: Record<string, unknown>;
  secretRef?: SecretReference;
  allowedTools?: string[];
  manualTools?: MCPToolDefinition[];
  /**
   * Phase 10.5 — the registry server's sampling settings, resolved from the
   * registry at run time. Absent (inline servers) means sampling is off.
   */
  sampling?: McpSamplingSettings;
  /**
   * Phase 10.7 — how a registry stdio server runs (resolved from the
   * registry; inline servers never carry one). Absent means the deployment
   * default applies.
   */
  sandbox?: McpSandboxSettings | null;
  /** Phase 10.7 — rate limits, concurrency caps, timeouts and breaker settings of a registry server. */
  limits?: McpRuntimeLimits;
  /** Phase 10.7 — `delegated` servers call with the run subject's own OAuth token. */
  credentialMode?: McpCredentialMode;
  /** Phase 10.7 — what unattended runs of a delegated server use. */
  delegatedFallback?: McpDelegatedFallback;
  /** Phase 10.7 — whose token a delegated call uses; set by the engine or the API, never by node configs. */
  delegatedUser?: McpDelegatedUser;
}

export interface MCPToolInvocation {
  serverId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface MCPToolResult {
  ok: boolean;
  /**
   * The tool's result as L2M has always shaped it: `structuredContent` when
   * the server sent it, otherwise the text of the content blocks.
   */
  output: unknown;
  error?: string;
  /** Phase 10.5 — the `structuredContent` object, validated against the tool's `outputSchema` when it has one. */
  structured?: Record<string, unknown>;
  /** Phase 10.5 — the content blocks normalized to text (one string, or an array for several blocks). */
  content?: unknown;
  /**
   * Phase 10.7 — what kind of failure an `ok: false` result is. The circuit
   * breaker counts only `transport`, `protocol` and `timeout` as server
   * failures.
   */
  errorKind?: McpToolErrorKind;
  /** Phase 10.7 — for rate-limited, queued-out and breaker-rejected calls: when retrying makes sense. */
  retryAfterMs?: number;
}

/** Phase 10.7 — failure classes of an MCP tool call. */
export type McpToolErrorKind =
  /** The server could not be reached, crashed, or the session broke. */
  | "transport"
  /** The server answered with a JSON-RPC error other than invalid params. */
  | "protocol"
  /** The call ran past its timeout. */
  | "timeout"
  /** The tool ran and reported an error (`isError`). */
  | "tool"
  /** The server rejected the arguments (JSON-RPC invalid params). */
  | "invalid_arguments"
  /** The structured output did not match the tool's outputSchema. */
  | "output_validation"
  /** The run was cancelled. */
  | "canceled"
  /** No usable credential (for example a delegated server the user has not connected). */
  | "credentials"
  /** Refused by the sandbox policy before anything started. */
  | "sandbox"
  | McpRuntimeRejection;

/**
 * Phase 10.5 — one `notifications/progress` message an upstream MCP server
 * sent for an in-flight `tools/call`.
 */
export interface McpToolProgressEvent {
  toolName: string;
  /** Adapter id of the server (`http_mcp`, `stdio_mcp`, ...). */
  serverId: string;
  registryServerId?: string;
  progress: number;
  total?: number;
  message?: string;
  /** ISO 8601 time L2M received the notification. */
  at: string;
}

/** Latest MCP tool progress of a running node, as the run tape shows it. */
export interface NodeProgressSnapshot extends McpToolProgressEvent {
  /** 0..100 when the server sent a total. */
  percent?: number;
}

export interface ConnectorDocument {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface ConnectorFetchResult {
  documents: ConnectorDocument[];
  raw?: unknown;
}

export interface ConnectorDefinition {
  id: string;
  label: string;
  category:
    | "google_drive"
    | "sql"
    | "nosql"
    | "azure_storage"
    | "azure_cosmos_db"
    | "azure_monitor"
    | "azure_search"
    | "qdrant"
    | "custom";
  description: string;
  configSchema: Record<string, unknown>;
  authSchema: Record<string, unknown>;
}

export interface AgentMemoryConfig {
  namespace?: string;
  maxMessages?: number;
  persistToolMessages?: boolean;
}

export interface AgentToolOutputLimits {
  messageMaxChars?: number;
  payloadMaxDepth?: number;
  payloadMaxObjectKeys?: number;
  payloadMaxArrayItems?: number;
  payloadMaxStringChars?: number;
}

export interface AgentRunRequest {
  provider: LLMProviderConfig;
  systemPrompt: string;
  userPrompt: string;
  tools: MCPToolDefinition[];
  maxIterations: number;
  toolCallingEnabled: boolean;
  agentType?: "tools" | "react" | "plan-and-execute" | "sql";
  sessionId?: string;
  memory?: AgentMemoryConfig;
  toolOutputLimits?: AgentToolOutputLimits;
  bypassToolFiltering?: boolean;
  images?: ChatMessageImage[];
}

export interface AgentRunStepToolResult {
  toolCallId: string;
  toolName: string;
  output: unknown;
  error?: string;
  /** Phase 10.1 — when the runtime started executing this tool call (ISO 8601). */
  startedAt?: string;
  /** Phase 10.1 — wall-clock time spent executing this tool call, in ms. */
  durationMs?: number;
}

export interface AgentRunStep {
  iteration: number;
  modelOutput: string;
  requestedTools: ToolCall[];
  toolResults: AgentRunStepToolResult[];
  /**
   * Phase 10.1 — token usage reported by the provider for this iteration's
   * model call, so tokens can be attributed to the tool calls it requested.
   */
  usage?: LLMUsage;
  /** Phase 10.1 — latency of this iteration's model call in ms, when reported. */
  latencyMs?: number;
}

/**
 * Phase 10.1 — maps the name an agent sees for an MCP tool
 * (`<adapterId>__<tool>`) back to the server and tool it came from.
 * Agent node outputs carry these under `_mcpTools`, keyed by exposed name.
 */
export interface McpToolAttribution {
  adapterId: string;
  toolName: string;
  registryServerId?: string;
}

// ---------------------------------------------------------------------------
// Phase 10.2 — MCP tool policy
// ---------------------------------------------------------------------------

export type McpPolicyRole = "admin" | "builder" | "operator" | "viewer";

/** Phase 10.5 — annotation conditions a tool policy rule can require. */
export type McpToolHintCondition =
  | "destructive"
  | "not_destructive"
  | "read_only"
  | "not_read_only"
  | "idempotent"
  | "not_idempotent"
  | "open_world"
  | "not_open_world";
export const MCP_TOOL_HINT_CONDITIONS: readonly McpToolHintCondition[] = [
  "destructive",
  "not_destructive",
  "read_only",
  "not_read_only",
  "idempotent",
  "not_idempotent",
  "open_world",
  "not_open_world"
];
export const MCP_POLICY_ROLES: readonly McpPolicyRole[] = ["admin", "builder", "operator", "viewer"];

/** Phase 10.5 — the kinds of MCP request a policy rule can govern. */
export type McpPolicyKind = "tool" | "resource" | "prompt" | "sampling";
export const MCP_POLICY_KINDS: readonly McpPolicyKind[] = ["tool", "resource", "prompt", "sampling"];

/**
 * Phase 12.4 — what a matching rule does. `require_approval` (tool rules
 * only): a person approves the exact call first (in a run, through the
 * write-tool approval hand-off; through the MCP gateway, an approval request
 * and a retry of the same call).
 */
export type McpToolPolicyEffect = "allow" | "deny" | "require_approval";
export const MCP_TOOL_POLICY_EFFECTS: readonly McpToolPolicyEffect[] = ["allow", "deny", "require_approval"];

/** Phase 12.4 — `shadow`: the rule is evaluated and its would-be decision logged, but it never changes a call's outcome. */
export type McpToolPolicyMode = "enforce" | "shadow";
export const MCP_TOOL_POLICY_MODES: readonly McpToolPolicyMode[] = ["enforce", "shadow"];

/**
 * Phase 12.4 — condition operators. Argument operators read the value at
 * `path` in the call's arguments; label operators read the run's data labels
 * (`value` is a provenance label or a data class name) and take no path.
 */
export type McpPolicyConditionOp =
  | "equals"
  | "one_of"
  | "not_one_of"
  | "starts_with"
  | "ends_with"
  | "matches"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "between"
  | "exists"
  | "label_present"
  | "label_absent";
export const MCP_POLICY_CONDITION_OPS: readonly McpPolicyConditionOp[] = [
  "equals",
  "one_of",
  "not_one_of",
  "starts_with",
  "ends_with",
  "matches",
  "lt",
  "lte",
  "gt",
  "gte",
  "between",
  "exists",
  "label_present",
  "label_absent"
];
export const MCP_POLICY_LABEL_OPS: readonly McpPolicyConditionOp[] = ["label_present", "label_absent"];

export type McpPolicyScalar = string | number | boolean | null;

/**
 * Phase 12.4 — one condition on a tool call. `path` addresses an argument:
 * dot-separated keys (`repo`, `owner.login`), where a key may end with `[n]`
 * (that element) or `[*]` (every element). A path that ends on an array
 * reads its elements, as if it ended with `[*]`. `value` by operator:
 * `equals` a scalar; `one_of` / `not_one_of` a list of scalars;
 * `starts_with` / `ends_with` / `matches` a string (`matches` is a glob: `*`
 * any run of characters, `?` one character); `lt` / `lte` / `gt` / `gte` a
 * number; `between` `[min, max]` inclusive; `exists` optional boolean
 * (default true); label operators a label name.
 *
 * Evaluation fails closed (see `evaluatePolicyCondition` in the MCP SDK):
 * when the path reads several values, a deny or require_approval rule's
 * condition holds if ANY value satisfies it, an allow rule's only if EVERY
 * value does (and there is at least one). Scalars compare as trimmed text
 * (`5000` equals `"5000"`) and number operators read numeric strings. A
 * missing argument satisfies `exists: false` for every rule, and the negated
 * operators (`not_one_of`, `label_absent`) only for deny and require_approval
 * rules; no other operator. A value the operator cannot read (an object, text
 * for a number operator) and a reading cut short by a cap (over 1,000 values,
 * past the call's 1 MB of argument text, the glob budget) match a deny or
 * require_approval rule and never an allow.
 */
export interface McpPolicyCondition {
  path?: string;
  op: McpPolicyConditionOp;
  value?: McpPolicyScalar | McpPolicyScalar[];
  /** Text operators (equals, one_of, not_one_of, starts_with, ends_with, matches) compare without case. */
  ignoreCase?: boolean;
}

/** Phase 12.4 — operators `ignoreCase` applies to. */
export const MCP_POLICY_TEXT_OPS: readonly McpPolicyConditionOp[] = ["equals", "one_of", "not_one_of", "starts_with", "ends_with", "matches"];

/** Phase 12.4 — a rule's conditions: every one must hold (`all`) or at least one (`any`). */
export type McpToolPolicyConditions = { all: McpPolicyCondition[] } | { any: McpPolicyCondition[] };

/**
 * One tool policy rule. A rule matches a tool call when every scope field
 * matches: project (`projectId` null = every project), role (`roles` empty =
 * every role), server (`serverId` null = any server; otherwise a registry
 * server id, or an adapter id for servers configured inline on a node) and
 * tool name (`toolPattern`, exact or a glob where `*` matches any run of
 * characters). Phase 12.4 adds workflows (`workflowIds` empty = every
 * workflow), gateway clients (`clientIds` empty = every caller) and
 * `conditions` on the call's arguments and data labels.
 */
export interface McpToolPolicyRule {
  id: string;
  name: string | null;
  description: string | null;
  effect: McpToolPolicyEffect;
  projectId: string | null;
  roles: McpPolicyRole[];
  serverId: string | null;
  toolPattern: string;
  /**
   * Phase 10.5 — limits the rule to tools whose effective annotation hint is
   * true (`destructive`, `read_only`, `idempotent`, `open_world`), or false
   * for the `not_` forms. Null = any tool. See `effectiveToolHints`.
   */
  annotationHint?: McpToolHintCondition | null;
  /**
   * Phase 10.5 — what the rule governs: tool calls (default), resource reads
   * (`toolPattern` matches the resource URI), prompt fetches (`toolPattern`
   * matches the prompt name) or sampling requests (`toolPattern` matches the
   * model name the request resolves to). Rules without a kind keep their
   * meaning: they only govern tool calls.
   */
  kind?: McpPolicyKind;
  /** Phase 12.4 — only runs of these workflows; empty or absent = every workflow (and gateway calls). */
  workflowIds?: string[];
  /**
   * Phase 12.4 — only calls made by these MCP gateway clients (directly, or
   * by a workflow run a client started); empty or absent = every caller.
   */
  clientIds?: string[];
  /** Phase 12.4 — conditions on the call's arguments and data labels; null or absent = every call. */
  conditions?: McpToolPolicyConditions | null;
  /** Phase 12.4 — absent means `enforce`. */
  mode?: McpToolPolicyMode;
  /**
   * Phase 12.2 — set on the rules safety presets and the workflow's untrusted-write switch create: the rule only
   * adds (an approval, a deny), it never carves an exception out of another rule, so no deny added later can be set
   * aside by it. Stored with the rule; the generic rule editor cannot change it.
   */
  additive?: boolean;
  enabled: boolean;
  createdBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
  /** Phase 12.4 — stable hash of what the rule governs and does (API responses only); see `hashMcpToolPolicyRule`. */
  hash?: string;
  /**
   * Phase 12.4 — the stored conditions no longer validate. The rule fails
   * closed: an allow never matches, a deny or require_approval applies to
   * every call in its scope. Fix or delete it.
   */
  invalid?: boolean;
}

/**
 * Whose role a run's tool policy is evaluated with. `user`: the signed-in
 * user who started the run. `owner`: the workflow's creator, for unattended
 * runs (webhooks, schedules, queue). `fallback`: no usable user, so the
 * lowest role (`viewer`) applies.
 */
export interface McpToolPolicySubject {
  role: McpPolicyRole;
  /**
   * `client`: a call through the MCP gateway (Phase 10.4); the role is the
   * client credential's role, capped at its creator's current role.
   */
  source: "user" | "owner" | "fallback" | "client";
  userId?: string;
  email?: string;
  /** Why the subject fell back to `viewer`, when it did. */
  fallbackReason?: string;
  /** MCP client credential id and name, for `source: "client"`. */
  clientId?: string;
  clientName?: string;
}

/** Admin override of a registry tool's read-only classification. */
export interface McpToolClassificationOverride {
  registryServerId: string;
  toolName: string;
  readOnly: boolean;
  setBy?: string | null;
  setAt?: string;
}

export type McpToolClassificationSource = "manual" | "annotation" | "unknown";

export interface McpToolClassification {
  readOnly: boolean;
  source: McpToolClassificationSource;
}

/** One tool removed from an agent's tool set (or refused at call time). */
export interface McpHiddenTool {
  tool: string;
  /** Adapter id of the server the tool came from. */
  server: string;
  registryServerId?: string;
  reason: "policy" | "no_write_tools";
  ruleId?: string;
  ruleName?: string;
}

/**
 * Phase 12.4 — what the tool policy decided for one call, as recorded on the
 * run trace and on the call's telemetry row (`policy_decision_json`). Only
 * written when some rule matched. `effect` is the enforced outcome; `shadow`
 * is what the outcome would have been with the matching shadow rules
 * enforced too.
 */
export interface McpToolPolicyDecisionRecord {
  effect: McpToolPolicyEffect;
  decidedBy: "default" | "rule";
  ruleId?: string;
  ruleName?: string;
  ruleHash?: string;
  /** For `require_approval`: whether the call waited for a person, or ran on an approval. */
  approval?: "pending" | "approved";
  /** Every matching rule: the enforced ones, then the shadow ones, each in evaluation order. */
  matched: Array<{ ruleId: string; mode: McpToolPolicyMode; effect: McpToolPolicyEffect }>;
  shadow?: {
    effect: McpToolPolicyEffect;
    ruleId?: string;
    ruleName?: string;
    ruleHash?: string;
    /** True when the shadow rules would have changed the outcome. */
    changed: boolean;
  };
  /**
   * Phase 12.2 — the labels the call was decided with (label names only; data class names only when the run tracked
   * labels). Absent on gateway calls and on records written before.
   */
  labels?: McpToolCallLabels;
}

/** Phase 12.4 — one call's decision on the `_toolPolicy` trace. */
export interface McpToolPolicyCallTrace extends McpToolPolicyDecisionRecord {
  tool: string;
  server: string;
  registryServerId?: string;
  /** The agent's tool call id, to match the decision with the call in `steps`. */
  toolCallId?: string;
}

/** Policy decisions attached to agent / supervisor node outputs as `_toolPolicy`. */
export interface McpToolPolicyTrace {
  subject: McpToolPolicySubject;
  projectId?: string;
  noWriteTools: boolean;
  hidden: McpHiddenTool[];
  /** Phase 12.4 — decisions for calls some rule matched (shadow rules included), in call order. */
  decisions?: McpToolPolicyCallTrace[];
  /**
   * Phase 12.2 — the labels of every call the policy decided, matched by a rule or not, in call order; the call's
   * telemetry row keeps them so simulation can evaluate label conditions.
   */
  callLabels?: McpToolPolicyCallLabels[];
}

/** Phase 12.2 — one call's labels on the `_toolPolicy` trace. */
export interface McpToolPolicyCallLabels {
  tool: string;
  server: string;
  registryServerId?: string;
  toolCallId?: string;
  labels: McpToolCallLabels;
}

/**
 * Phase 12.4 — a gateway `tools/call` a require_approval rule held back.
 * `pending` until an admin decides (or `expiresAt` passes: `expired`);
 * `approved` lets the same client make the identical call (same server, tool
 * and canonical arguments hash) once before `expiresAt`, after which it is
 * `used`; `rejected` refuses it.
 */
export type McpGatewayApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "used";

export interface McpGatewayApproval {
  id: string;
  clientId: string;
  clientName: string | null;
  toolsetId: string;
  projectId: string | null;
  serverId: string;
  serverName: string | null;
  /** The upstream tool name on the server. */
  toolName: string;
  /** The name the client called (`<server-slug>__<tool>`). */
  gatewayToolName: string;
  argsHash: string;
  /** Canonical JSON of the arguments, secrets scrubbed and bounded; redacted again when shown. */
  argsPreview: string | null;
  ruleId: string | null;
  ruleName: string | null;
  message: string | null;
  status: McpGatewayApprovalStatus;
  requestedAt: string;
  expiresAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  usedAt: string | null;
}

export interface AgentRunState {
  finalAnswer: string;
  stopReason: "final_answer" | "max_iterations" | "error" | "clarification_requested";
  iterations: number;
  messages: ChatMessage[];
  steps: AgentRunStep[];
  /**
   * Populated when `stopReason === "clarification_requested"` — the agent
   * called the built-in `agent_clarify` tool to pause and ask the user a
   * question. The orphaned tool-call message stays in `messages`; on the
   * next `run()` call with the same `sessionId`, the runtime injects the
   * new `userPrompt` as the tool result for `toolCallId` rather than
   * appending it as a fresh user message — so the LLM sees a normal
   * tool-call → tool-result protocol exchange.
   */
  clarification?: {
    question: string;
    reason?: string;
    toolCallId: string;
  };
  /**
   * Phase 16 — what the agent's model context held by the end: its input,
   * memory it read and every tool result it saw. The answer carries these
   * labels. Set only when the caller passed input labels.
   */
  labels?: DataLabels;
  /**
   * Phase 16 — data classes a `final_output` rewrite removed from the answer
   * (already left out of `labels`). The caller applies them to any labels it
   * adds to the answer's afterwards.
   */
  labelsDeclassified?: string[];
  /**
   * Cumulative LLM usage across every model call the agent made (one per
   * iteration plus retries). Aggregated from each `LLMCallResponse.usage`.
   * Unset if the provider didn't report token usage on any iteration.
   */
  usage?: LLMUsage;
  /**
   * Sum of every provider call's `latencyMs`. Approximates time spent
   * waiting on the LLM; excludes tool execution and runtime overhead.
   */
  llmLatencyMs?: number;
  /** How many provider calls were made (iterations + retries that succeeded). */
  llmCallCount?: number;
}

export interface WorkflowExecuteRequest {
  workflowId?: string;
  startNodeId?: string;
  runMode?: "workflow" | "single_node";
  usePinnedData?: boolean;
  pinnedData?: Record<string, unknown>;
  nodeOutputs?: Record<string, unknown>;
  sourceExecutionId?: string;
  sessionId?: string;
  session_id?: string;
  executionTimeoutMs?: number;
  execution_timeout_ms?: number;
  customData?: Record<string, unknown>;
  system_prompt?: string;
  user_prompt?: string;
  variables?: Record<string, unknown>;
  input?: Record<string, unknown>;
}

export interface AgentWebhookPayload {
  workflow_id?: string;
  webhook_path?: string;
  webhookPath?: string;
  session_id?: string;
  executionTimeoutMs?: number;
  execution_timeout_ms?: number;
  customData?: Record<string, unknown>;
  system_prompt?: string;
  user_prompt?: string;
  variables?: Record<string, unknown>;
}

export interface BinaryDataReference {
  __binaryRef: true;
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  storagePath: string;
}

export function isBinaryDataReference(value: unknown): value is BinaryDataReference {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).__binaryRef === true &&
    typeof (value as Record<string, unknown>).id === "string"
  );
}

export interface BinaryDataStore {
  write(id: string, data: Uint8Array, meta: { fileName: string; mimeType: string }): Promise<BinaryDataReference>;
  read(ref: BinaryDataReference): Promise<Uint8Array>;
  delete(ref: BinaryDataReference): Promise<void>;
  cleanup(executionId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// External workflow import report (returned by POST /api/workflows/import/external)
// ---------------------------------------------------------------------------

export type ImportNodeStatus = "mapped" | "approximated" | "unsupported";

export interface ImportReportNodeEntry {
  sourceName: string;
  sourceType: string;
  sourceId?: string;
  targetNodeId: string;
  targetType: WorkflowNodeType;
  status: ImportNodeStatus;
  reason: string;
}

export interface ImportReportExpression {
  nodeId: string;
  sourceName: string;
  /** Config path the expression lives at, e.g. `urlTemplate` or `assignments[1].valueTemplate`. */
  path: string;
  /** Original expression body, exactly as it appeared in the export. */
  expression: string;
  reason: string;
}

export interface ImportReportSecret {
  secretId: string;
  credentialType: string;
  credentialName: string;
  nodeIds: string[];
}

export interface ImportReport {
  sourceName: string;
  nodes: ImportReportNodeEntry[];
  unresolvedExpressions: ImportReportExpression[];
  secretsToResolve: ImportReportSecret[];
  /** Workflow variables created as placeholders for `$env` / `$vars` references. */
  variablesToSet: string[];
  warnings: string[];
  summary: {
    total: number;
    mapped: number;
    approximated: number;
    unsupported: number;
  };
}

// ---------------------------------------------------------------------------
// Phase 10.5 — MCP resources, prompts, elicitation and sampling
// ---------------------------------------------------------------------------

/** The capabilities an MCP server declared in its `initialize` result. */
export interface McpServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  prompts?: { listChanged?: boolean };
  logging?: Record<string, never>;
  completions?: Record<string, never>;
}

export interface McpResourceAnnotations {
  audience?: Array<"user" | "assistant">;
  priority?: number;
  lastModified?: string;
}

/** One entry of `resources/list`. */
export interface McpResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  /** Size in bytes, when the server reports it. */
  size?: number;
  annotations?: McpResourceAnnotations;
}

/** One entry of `resources/templates/list`. */
export interface McpResourceTemplate {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  annotations?: McpResourceAnnotations;
}

/** One item of a `resources/read` result: text, or a base64 blob. */
export type McpResourceContent =
  | { uri: string; mimeType?: string; text: string }
  | { uri: string; mimeType?: string; blob: string };

export interface McpResourceReadResult {
  uri: string;
  contents: McpResourceContent[];
  /** Total decoded size of every content item, in bytes. */
  bytes: number;
}

export interface McpPromptArgument {
  name: string;
  title?: string;
  description?: string;
  required?: boolean;
}

/** One entry of `prompts/list`. */
export interface McpPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: McpPromptArgument[];
}

export type McpPromptContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "resource"; resource: McpResourceContent }
  | { type: "resource_link"; uri: string; name?: string; mimeType?: string };

export interface McpPromptMessage {
  role: "user" | "assistant";
  content: McpPromptContent;
}

export interface McpPromptGetResult {
  name: string;
  description?: string;
  messages: McpPromptMessage[];
}

/**
 * What a probe captured besides the tool snapshot: the server's declared
 * capabilities and, when it advertises them, its resources, resource
 * templates and prompts. Informational; changes here are never breaking.
 */
export interface McpServerCatalog {
  capabilities: McpServerCapabilities;
  resources: McpResource[];
  resourceTemplates: McpResourceTemplate[];
  prompts: McpPrompt[];
  updatedAt: string;
}

/**
 * The kind of `notifications/<kind>/list_changed` an upstream server sent on
 * a session. Any kind triggers a (debounced) re-probe of the registry server.
 */
export type McpListChangedKind = "tools" | "resources" | "prompts";

export interface McpListChangedEvent {
  kind: McpListChangedKind;
  serverId: string;
  registryServerId?: string;
  at: string;
}

/**
 * Where a server prompt is used on an LLM or agent node: it is fetched with
 * `prompts/get` at run time (arguments are templates rendered like the
 * node's own prompt) and its text replaces the system or the user prompt.
 */
export interface McpServerPromptBinding {
  registryServerId: string;
  name: string;
  arguments?: Record<string, string>;
  target?: "system" | "user";
}

// Elicitation ---------------------------------------------------------------

/** The flat primitive schemas the elicitation spec allows per property. */
export interface McpElicitationPropertySchema {
  type: "string" | "number" | "integer" | "boolean";
  title?: string;
  description?: string;
  format?: "email" | "uri" | "date" | "date-time";
  enum?: string[];
  enumNames?: string[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  default?: string | number | boolean;
}

export interface McpElicitationSchema {
  type: "object";
  properties: Record<string, McpElicitationPropertySchema>;
  required?: string[];
}

export type McpElicitationAction = "accept" | "decline" | "cancel";

/** `elicitation/create` params, after validation against the flat schema the spec allows. */
export interface McpElicitationRequest {
  message: string;
  requestedSchema: McpElicitationSchema;
}

/** The `elicitation/create` result sent back to the server. */
export interface McpElicitationResult {
  action: McpElicitationAction;
  content?: Record<string, string | number | boolean>;
}

export type McpElicitationStatus = "pending" | "accepted" | "declined" | "cancelled" | "expired" | "auto_declined";

/** A pending or answered elicitation, as the Runs page and the Chat UI see it. */
export interface McpElicitationView {
  id: string;
  executionId: string;
  workflowId: string;
  workflowName?: string | null;
  nodeId: string;
  /** Adapter id of the server that asked. */
  serverId: string;
  registryServerId?: string | null;
  serverName?: string | null;
  toolName: string;
  message: string;
  requestedSchema: McpElicitationSchema;
  status: McpElicitationStatus;
  createdAt: string;
  expiresAt: string;
  answeredAt?: string | null;
  answeredBy?: string | null;
  /** Why the run did not wait for a person (unattended runs, refused schemas). */
  reason?: string | null;
}

/** How an elicitation was settled, as recorded on the node output (`_mcpElicitations`). */
export type McpElicitationOutcomeSource = "user" | "unattended" | "refused" | "timeout" | "unavailable";

export interface McpElicitationTraceEntry {
  id?: string;
  toolName: string;
  serverId: string;
  registryServerId?: string;
  message: string;
  requestedSchema: McpElicitationSchema;
  action: McpElicitationAction;
  source: McpElicitationOutcomeSource;
  note?: string;
  at: string;
  settledAt: string;
}

// Sampling ------------------------------------------------------------------

/** Per registry server limits for `sampling/createMessage`. */
export interface McpSamplingSettings {
  /** Off by default: a server can steer the model through sampling. */
  allow: boolean;
  /** Upper bound for `maxTokens`; larger requests are clamped. */
  maxTokens: number;
  /** Model names the server may ask for; empty = only the attached model. */
  allowedModels: string[];
  /** Requests one tool call may make; more are refused. */
  maxRequestsPerCall: number;
  /** Model for direct MCP Tool nodes and gateway calls, which have no attached chat model. */
  defaultModel?: { providerId: string; model: string } | null;
}

export const DEFAULT_MCP_SAMPLING_SETTINGS: McpSamplingSettings = {
  allow: false,
  maxTokens: 1024,
  allowedModels: [],
  maxRequestsPerCall: 3,
  defaultModel: null
};

export type McpSamplingContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string };

export interface McpSamplingMessage {
  role: "user" | "assistant";
  content: McpSamplingContent;
}

export interface McpSamplingModelPreferences {
  hints?: Array<{ name?: string }>;
  costPriority?: number;
  speedPriority?: number;
  intelligencePriority?: number;
}

/** `sampling/createMessage` params as received from a server. */
export interface McpSamplingRequest {
  messages: McpSamplingMessage[];
  modelPreferences?: McpSamplingModelPreferences;
  systemPrompt?: string;
  maxTokens: number;
  temperature?: number;
  stopSequences?: string[];
  includeContext?: "none" | "thisServer" | "allServers";
  metadata?: Record<string, unknown>;
}

/** The `sampling/createMessage` result sent back to the server. */
export interface McpSamplingResult {
  role: "assistant";
  content: { type: "text"; text: string };
  model: string;
  stopReason?: "endTurn" | "stopSequence" | "maxTokens" | string;
}

/** One sampling request and its outcome, as recorded on the node output (`_mcpSampling`). */
export interface McpSamplingTraceEntry {
  toolName: string;
  /** 1-based number of the `toolName` call within the node that this request belongs to. */
  call: number;
  serverId: string;
  registryServerId?: string;
  /** Model names the server asked for through `modelPreferences.hints`. */
  requestedModels: string[];
  /** Model that answered, or null when the request was refused. */
  model: string | null;
  providerId?: string;
  ok: boolean;
  /** Why the request was refused. */
  error?: string;
  /** Prompt the server sent, truncated. */
  prompt: string;
  /** Answer the model gave, truncated. */
  response?: string;
  maxTokens: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
  at: string;
}

// ---------------------------------------------------------------------------
// Phase 10.5 — OAuth 2.1 connections to remote MCP servers
// ---------------------------------------------------------------------------

export type McpOAuthConnectionState = "not_connected" | "connected" | "expired" | "error";

/**
 * What the API shows about a registry server's OAuth connection. Tokens and
 * client secrets never appear here; they live in a SecretService secret.
 */
export interface McpOAuthConnectionStatus {
  serverId: string;
  state: McpOAuthConnectionState;
  /** Who the access token acts as, when the authorization server said. */
  subject: string | null;
  scope: string | null;
  /** Issuer URL of the authorization server the server's metadata named. */
  authorizationServer: string | null;
  /** How L2M got its client id: RFC 7591 registration, or an id an admin entered. */
  clientRegistration: "dynamic" | "pre_registered" | null;
  clientId: string | null;
  expiresAt: string | null;
  hasRefreshToken: boolean;
  lastRefreshAt: string | null;
  connectedAt: string | null;
  connectedBy: string | null;
  lastError: string | null;
  updatedAt: string | null;
  /** The redirect URL to allow on the authorization server for this L2M instance. */
  redirectUri: string;
}

// ---------------------------------------------------------------------------
// Phase 10.4 — L2M as an MCP server and gateway
// ---------------------------------------------------------------------------

/** One entry of a toolset: a workflow exposing `mcp_server_trigger` tools, or a registry server. */
export type McpToolsetMemberSpec =
  | { kind: "workflow"; workflowId: string }
  | { kind: "server"; serverId: string; toolGlob: string | null };

export type McpToolsetMember = McpToolsetMemberSpec & { id: string };

/** A named group of tools served at `/mcp/<slug>`. */
export interface McpToolset {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  /** Project the gateway evaluates tool policy in; null = no project. */
  projectId: string | null;
  enabled: boolean;
  members: McpToolsetMember[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A client credential for the MCP gateway. The token itself is never stored or returned again. */
export interface McpClient {
  id: string;
  name: string;
  /** First characters of the token, safe to display. */
  tokenPrefix: string;
  toolsetIds: string[];
  role: McpPolicyRole;
  /** User id of the admin who created the credential. */
  createdBy: string | null;
  createdByEmail: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** One tool a toolset exposes, as an MCP client would list it. */
export interface McpGatewayToolView {
  name: string;
  kind: "workflow" | "server";
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
  workflowId?: string;
  workflowName?: string;
  serverId?: string;
  serverName?: string;
  /** Upstream tool name on the registry server. */
  toolName?: string;
  readOnly: boolean;
}

/** A tool the policy keeps away from the role a preview or client uses. */
export interface McpGatewayHiddenToolView {
  name: string;
  serverId: string;
  serverName: string;
  toolName: string;
  ruleId?: string;
  ruleName?: string;
  message: string;
}
