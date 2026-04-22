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
  | "mcp_tool"
  | "rag_retrieve"
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
  | "input_validator"
  | "output_guardrail"
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
  saveDataSuccessExecution?: "all" | "none";
  saveDataErrorExecution?: "all" | "none";
  /** Phase 7.3 — workflow activation state. */
  active?: boolean;
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

export interface NodeDefinition {
  type: WorkflowNodeType;
  label: string;
  category: NodeCategory;
  description: string;
  configSchema: Record<string, unknown>;
  sampleConfig: Record<string, unknown>;
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
  retryable?: boolean;
  attempts?: number;
}

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
  warnings?: string[];
  retriedNodes?: Array<{ nodeId: string; attempts: number; nodeType: string }>;
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
}

export interface WorkflowValidationIssue {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
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

export interface LLMCallResponse {
  content: string;
  toolCalls: ToolCall[];
  raw?: unknown;
}

export interface MCPToolDefinition extends ToolDefinition {
  serverId: string;
  serverLabel?: string;
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
  label?: string;
  connection?: Record<string, unknown>;
  secretRef?: SecretReference;
  allowedTools?: string[];
  manualTools?: MCPToolDefinition[];
}

export interface MCPToolInvocation {
  serverId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface MCPToolResult {
  ok: boolean;
  output: unknown;
  error?: string;
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

export interface AgentRunStep {
  iteration: number;
  modelOutput: string;
  requestedTools: ToolCall[];
  toolResults: Array<{
    toolCallId: string;
    toolName: string;
    output: unknown;
    error?: string;
  }>;
}

export interface AgentRunState {
  finalAnswer: string;
  stopReason: "final_answer" | "max_iterations" | "error";
  iterations: number;
  messages: ChatMessage[];
  steps: AgentRunStep[];
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
