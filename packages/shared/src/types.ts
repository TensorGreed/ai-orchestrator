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
  | "embeddings_azure_openai"
  | "azure_ai_search_vector_store"
  | "qdrant_vector_store"
  | "document_chunker"
  | "output_parser"
  | "human_approval"
  | "input_validator"
  | "output_guardrail"
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
  | "github_webhook_trigger";

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
}

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
}

export interface WorkflowListItem {
  id: string;
  name: string;
  schemaVersion: string;
  workflowVersion: number;
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

export type NodeExecutionStatus = "pending" | "running" | "success" | "error" | "skipped" | "waiting_approval";

export type WorkflowExecutionStatus = "success" | "error" | "partial" | "waiting_approval";

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
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
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
  sessionId?: string;
  memory?: AgentMemoryConfig;
  toolOutputLimits?: AgentToolOutputLimits;
  bypassToolFiltering?: boolean;
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
  sessionId?: string;
  session_id?: string;
  executionTimeoutMs?: number;
  execution_timeout_ms?: number;
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
  system_prompt?: string;
  user_prompt?: string;
  variables?: Record<string, unknown>;
}
