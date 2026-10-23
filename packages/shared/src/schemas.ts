import { z } from "zod";
import { WORKFLOW_SCHEMA_VERSION } from "./types";
import { writeToolApprovalSettingsSchema } from "./approval-gate";

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
    "openai_chat_model",
    "anthropic_chat_model",
    "ollama_chat_model",
    "openai_compatible_chat_model",
    "ai_gateway_chat_model",
    "azure_openai_chat_model",
    "google_gemini_chat_model",
    "agent_orchestrator",
    "supervisor_node",
    "local_memory",
    "session_artifact_save",
    "session_artifact_load",
    "chat_intent_router",
    "helper_chat_response",
    "mcp_tool",
    "rag_retrieve",
    "rerank",
    "extract_citations",
    "chart",
    "web_browse",
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
    "approval_gate",
    "input_validator",
    "output_guardrail",
    "guard",
    "guard_protection",
    "basic_llm_chain",
    "qa_chain",
    "summarization_chain",
    "information_extractor",
    "text_classifier",
    "sentiment_analysis",
    "ai_transform",
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
    "teams_send_message",
    "notion_create_page",
    "notion_query_database",
    "airtable_create_record",
    "airtable_list_records",
    "airtable_update_record",
    "jira_create_issue",
    "jira_search_issues",
    "salesforce_create_record",
    "salesforce_query",
    "hubspot_create_contact",
    "hubspot_get_contact",
    "stripe_create_customer",
    "stripe_create_charge",
    "stripe_webhook_trigger",
    "aws_s3_put_object",
    "aws_s3_get_object",
    "aws_s3_list_objects",
    "telegram_send_message",
    "telegram_trigger",
    "discord_send_message",
    "discord_trigger",
    "google_drive_trigger",
    "google_calendar_create_event",
    "google_calendar_list_events",
    "twilio_send_sms",
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

export const workflowSettingsSchema = z
  .object({
    errorWorkflowId: z.string().min(1).optional(),
    executionTimeoutMs: z.number().int().positive().optional(),
    saveDataSuccessExecution: z.enum(["all", "none"]).optional(),
    saveDataErrorExecution: z.enum(["all", "none"]).optional(),
    active: z.boolean().optional(),
    /** Phase 10.2 — block every MCP write tool for agents and MCP Tool nodes in this workflow. */
    noWriteTools: z.boolean().optional(),
    /** Phase 11.2 — agents pause for approval before calling an MCP write tool. */
    writeToolApproval: writeToolApprovalSettingsSchema.optional()
  })
  .passthrough();

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
  updatedAt: z.string().datetime().optional(),
  pinnedData: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string().min(1).max(64)).optional(),
  projectId: z.string().min(1).optional(),
  folderId: z.string().min(1).optional(),
  settings: workflowSettingsSchema.optional()
});

export const projectSchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional()
});

export const folderSchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(120),
  parentId: z.string().min(1).max(120).optional(),
  projectId: z.string().min(1).max(120)
});

export const workflowExecuteRequestSchema = z.object({
  workflowId: z.string().optional(),
  startNodeId: z.string().optional(),
  runMode: z.enum(["workflow", "single_node"]).optional(),
  usePinnedData: z.boolean().optional(),
  pinnedData: z.record(z.string(), z.unknown()).optional(),
  nodeOutputs: z.record(z.string(), z.unknown()).optional(),
  sourceExecutionId: z.string().optional(),
  sessionId: z.string().optional(),
  session_id: z.string().optional(),
  executionTimeoutMs: z.number().int().positive().optional(),
  execution_timeout_ms: z.number().int().positive().optional(),
  customData: z.record(z.string(), z.unknown()).optional(),
  system_prompt: z.string().optional(),
  user_prompt: z.string().optional(),
  variables: z.record(z.string(), z.unknown()).optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  /** Phase 10.8 — record every MCP call of this run into a cassette. */
  record: z.boolean().optional()
});

export const agentWebhookPayloadSchema = z.object({
  workflow_id: z.string().optional(),
  webhook_path: z.string().optional(),
  webhookPath: z.string().optional(),
  session_id: z.string().optional(),
  executionTimeoutMs: z.number().int().positive().optional(),
  execution_timeout_ms: z.number().int().positive().optional(),
  customData: z.record(z.string(), z.unknown()).optional(),
  system_prompt: z.string().optional(),
  user_prompt: z.string().optional(),
  variables: z.record(z.string(), z.unknown()).optional()
});

export type WorkflowSchemaInput = z.input<typeof workflowSchema>;

// Phase 10.2 — MCP tool policy rules.
export const mcpPolicyRoleSchema = z.enum(["admin", "builder", "operator", "viewer"]);

/** Tool name or glob: letters, digits and the characters MCP servers use in tool names, plus `*`. */
export const mcpToolPatternSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_.:\/*-]+$/, "Use a tool name, or a glob where * matches any characters");

export const mcpPolicyKindSchema = z.enum(["tool", "resource", "prompt", "sampling"]);

export const mcpToolHintConditionSchema = z.enum([
  "destructive",
  "not_destructive",
  "read_only",
  "not_read_only",
  "idempotent",
  "not_idempotent",
  "open_world",
  "not_open_world"
]);

export const mcpToolPolicyRuleInputSchema = z.object({
  name: z.string().trim().max(120).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  effect: z.enum(["allow", "deny"]),
  projectId: z.string().trim().min(1).nullable().optional(),
  roles: z.array(mcpPolicyRoleSchema).max(4).optional(),
  serverId: z.string().trim().min(1).nullable().optional(),
  /** Defaults to "*" (every tool) when a rule is created without one. */
  toolPattern: mcpToolPatternSchema.optional(),
  /** Phase 10.5 — only tools with this effective annotation hint; null = any tool. */
  annotationHint: mcpToolHintConditionSchema.nullable().optional(),
  /** Phase 10.5 — what the rule governs; defaults to `tool`. */
  kind: mcpPolicyKindSchema.optional(),
  enabled: z.boolean().optional()
});

export const mcpToolPolicyRuleUpdateSchema = mcpToolPolicyRuleInputSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "Empty update payload" });

export const mcpToolPolicyEvaluateSchema = z.object({
  projectId: z.string().trim().min(1).nullable().optional(),
  role: mcpPolicyRoleSchema,
  serverId: z.string().trim().min(1),
  /** The tool name, resource URI, prompt name or model name, depending on `kind`. */
  toolName: z.string().trim().min(1).max(2000),
  kind: mcpPolicyKindSchema.optional(),
  noWriteTools: z.boolean().optional()
});

// Phase 10.5 — resources, prompts, elicitation and sampling.
export const mcpSamplingSettingsSchema = z.object({
  allow: z.boolean().default(false),
  maxTokens: z.number().int().min(1).max(200_000).default(1024),
  allowedModels: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  maxRequestsPerCall: z.number().int().min(1).max(100).default(3),
  defaultModel: z
    .object({ providerId: z.string().trim().min(1).max(100), model: z.string().trim().min(1).max(200) })
    .nullable()
    .optional()
});

/** A partial update of a server's sampling settings; fields left out keep their value. */
export const mcpSamplingSettingsPatchSchema = z.object({
  allow: z.boolean().optional(),
  maxTokens: z.number().int().min(1).max(200_000).optional(),
  allowedModels: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  maxRequestsPerCall: z.number().int().min(1).max(100).optional(),
  defaultModel: z
    .object({ providerId: z.string().trim().min(1).max(100), model: z.string().trim().min(1).max(200) })
    .nullable()
    .optional()
});

export const mcpResourceReadSchema = z.object({
  uri: z.string().trim().min(1).max(4000),
  projectId: z.string().trim().min(1).nullable().optional()
});

export const mcpPromptGetSchema = z.object({
  name: z.string().trim().min(1).max(200),
  arguments: z.record(z.string(), z.string().max(20_000)).default({}),
  projectId: z.string().trim().min(1).nullable().optional()
});

export const mcpElicitationAnswerSchema = z.object({
  action: z.enum(["accept", "decline", "cancel"]),
  content: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
});

/** A server prompt bound to an LLM or agent node (`config.serverPrompt`). */
export const mcpServerPromptBindingSchema = z.object({
  registryServerId: z.string().trim().min(1),
  name: z.string().trim().min(1).max(200),
  arguments: z.record(z.string(), z.string()).optional(),
  target: z.enum(["system", "user"]).optional()
});

// Phase 10.5 — OAuth connect for remote MCP servers.
export const mcpOAuthConnectSchema = z
  .object({
    /** Space-separated scopes to request; defaults to the server's `scopes_supported`. */
    scope: z.string().trim().max(1000).optional()
  })
  .strict();

export const mcpToolClassificationSchema = z.object({
  /** true / false sets the manual override; null clears it. */
  readOnly: z.boolean().nullable()
});

// Phase 10.4 — L2M as an MCP server and gateway: toolsets and client credentials.

/** URL segment of a toolset endpoint (`/mcp/<slug>`). */
export const mcpToolsetSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "Use lowercase letters, digits and dashes, starting and ending with a letter or digit");

export const mcpToolsetMemberInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("workflow"),
    workflowId: z.string().trim().min(1)
  }),
  z.object({
    kind: z.literal("server"),
    serverId: z.string().trim().min(1),
    /** Tool name or glob; null or absent exposes every tool of the server. */
    toolGlob: mcpToolPatternSchema.nullable().optional()
  })
]);

export const mcpToolsetInputSchema = z.object({
  slug: mcpToolsetSlugSchema.optional(),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  projectId: z.string().trim().min(1).nullable().optional(),
  enabled: z.boolean().optional(),
  members: z.array(mcpToolsetMemberInputSchema).max(200).optional()
});

export const mcpToolsetUpdateSchema = mcpToolsetInputSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "Empty update payload" });

export const mcpClientCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  toolsetIds: z.array(z.string().trim().min(1)).min(1).max(50),
  role: mcpPolicyRoleSchema,
  /** ISO timestamp in the future; null or absent = never expires. */
  expiresAt: z.string().datetime({ offset: true }).nullable().optional()
});
