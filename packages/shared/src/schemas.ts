import { z } from "zod";
import { WORKFLOW_SCHEMA_VERSION } from "./types";

export const secretReferenceSchema = z.object({
  secretId: z.string().min(1)
});

export const llmProviderConfigSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
  baseUrl: z.string().url().optional(),
  secretRef: secretReferenceSchema.optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  extra: z.record(z.string(), z.unknown()).optional()
});

export const workflowNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum([
    "schedule_trigger",
    "webhook_input",
    "http_request",
    "text_input",
    "system_prompt",
    "user_prompt",
    "loop_node",
    "merge_node",
    "execute_workflow",
    "wait_node",
    "set_node",
    "code_node",
    "prompt_template",
    "llm_call",
    "azure_openai_chat_model",
    "agent_orchestrator",
    "supervisor_node",
    "local_memory",
    "mcp_tool",
    "rag_retrieve",
    "connector_source",
    "google_drive_source",
    "azure_storage",
    "azure_cosmos_db",
    "azure_monitor_http",
    "embeddings_azure_openai",
    "azure_ai_search_vector_store",
    "qdrant_vector_store",
    "document_chunker",
    "output_parser",
    "human_approval",
    "input_validator",
    "output_guardrail",
    "if_node",
    "switch_node",
    "try_catch",
    "webhook_response",
    "pdf_output",
    "output",
    "sub_workflow_trigger",
    "error_trigger",
    "filter_node",
    "stop_and_error",
    "noop_node",
    "aggregate_node",
    "split_out_node",
    "sort_node",
    "limit_node",
    "remove_duplicates_node",
    "summarize_node",
    "compare_datasets_node",
    "rename_keys_node",
    "edit_fields_node",
    "date_time_node",
    "crypto_node",
    "jwt_node",
    "xml_node",
    "html_node",
    "convert_to_file_node",
    "extract_from_file_node",
    "compression_node",
    "edit_image_node",
    "slack_send_message",
    "slack_trigger",
    "smtp_send_email",
    "imap_email_trigger",
    "google_sheets_read",
    "google_sheets_append",
    "google_sheets_update",
    "google_sheets_trigger",
    "postgres_query",
    "postgres_trigger",
    "mysql_query",
    "mongo_operation",
    "redis_command",
    "redis_trigger",
    "github_action",
    "github_webhook_trigger",
    "manual_trigger",
    "form_trigger",
    "chat_trigger",
    "file_trigger",
    "rss_trigger",
    "sse_trigger",
    "mcp_server_trigger",
    "kafka_trigger",
    "rabbitmq_trigger",
    "mqtt_trigger",
    "sticky_note"
  ]),
  name: z.string().min(1),
  position: z.object({ x: z.number(), y: z.number() }),
  config: z.record(z.string(), z.unknown()),
  disabled: z.boolean().optional(),
  color: z.string().optional()
});

export const workflowEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  sourceHandle: z.string().optional(),
  targetHandle: z.string().optional(),
  label: z.string().optional()
});

export const workflowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  schemaVersion: z.string().default(WORKFLOW_SCHEMA_VERSION),
  workflowVersion: z.number().int().positive().default(1),
  variables: z.record(z.string(), z.string()).optional(),
  nodes: z.array(workflowNodeSchema),
  edges: z.array(workflowEdgeSchema),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional()
});

export const workflowExecuteRequestSchema = z.object({
  workflowId: z.string().optional(),
  startNodeId: z.string().optional(),
  sessionId: z.string().optional(),
  session_id: z.string().optional(),
  executionTimeoutMs: z.number().int().positive().optional(),
  execution_timeout_ms: z.number().int().positive().optional(),
  system_prompt: z.string().optional(),
  user_prompt: z.string().optional(),
  variables: z.record(z.string(), z.unknown()).optional(),
  input: z.record(z.string(), z.unknown()).optional()
});

export const agentWebhookPayloadSchema = z.object({
  workflow_id: z.string().optional(),
  session_id: z.string().optional(),
  executionTimeoutMs: z.number().int().positive().optional(),
  execution_timeout_ms: z.number().int().positive().optional(),
  system_prompt: z.string().optional(),
  user_prompt: z.string().optional(),
  variables: z.record(z.string(), z.unknown()).optional()
});

export type WorkflowSchemaInput = z.input<typeof workflowSchema>;
