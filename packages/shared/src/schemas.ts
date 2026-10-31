import { z } from "zod";
import { MCP_POLICY_TEXT_OPS, WORKFLOW_SCHEMA_VERSION } from "./types";
import { writeToolApprovalSettingsSchema } from "./approval-gate";
import { MCP_POLICY_PATH_MAX_LENGTH, parseMcpPolicyPath } from "./mcp-tool-policy";

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

/** Phase 13.1 — a queue worker pool name: a letter or digit, then letters, digits, `_` or `-` (at most 63). */
export const QUEUE_POOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;

export const workflowSettingsSchema = z
  .object({
    errorWorkflowId: z.string().min(1).optional(),
    executionTimeoutMs: z.number().int().positive().optional(),
    /** Phase 13.1 — the worker pool that runs this workflow's queued jobs (cluster mode); unset is `default`. */
    executionPool: z
      .string()
      .regex(QUEUE_POOL_NAME_PATTERN, "executionPool must be letters, digits, _ or - (at most 63, starting with a letter or digit)")
      .optional(),
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

// Phase 12.4 — rule conditions, effects, modes and the workflow / client principals.
export const MCP_POLICY_MAX_CONDITIONS = 20;
export const MCP_POLICY_MAX_LIST_VALUES = 100;
export const MCP_POLICY_MAX_VALUE_LENGTH = 500;
export const MCP_POLICY_MAX_PRINCIPALS = 100;
/** At most this many `*` in a `matches` glob. */
export const MCP_POLICY_MAX_GLOB_STARS = 16;

export const mcpToolPolicyEffectSchema = z.enum(["allow", "deny", "require_approval"]);
export const mcpToolPolicyModeSchema = z.enum(["enforce", "shadow"]);
export const mcpPolicyConditionOpSchema = z.enum([
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
]);

const policyScalarSchema = z.union([
  z.string().max(MCP_POLICY_MAX_VALUE_LENGTH, `Values are at most ${MCP_POLICY_MAX_VALUE_LENGTH} characters`),
  z.number().finite(),
  z.boolean(),
  z.null()
]);

export const mcpPolicyConditionSchema = z
  .object({
    path: z.string().trim().max(MCP_POLICY_PATH_MAX_LENGTH).optional(),
    op: mcpPolicyConditionOpSchema,
    value: z.union([policyScalarSchema, z.array(policyScalarSchema).max(MCP_POLICY_MAX_LIST_VALUES)]).optional(),
    ignoreCase: z.boolean().optional()
  })
  .superRefine((condition, ctx) => {
    const issue = (path: "path" | "value", message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    const { op, value } = condition;
    const labelOp = op === "label_present" || op === "label_absent";
    if (condition.ignoreCase && !MCP_POLICY_TEXT_OPS.includes(op)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ignoreCase"], message: "Ignore case applies to text comparisons only" });
    }
    if (labelOp) {
      if (condition.path) issue("path", "Label conditions take no argument path");
      if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(value)) {
        issue("value", "Name a data label: a provenance label (trusted, user, untrusted_external, sensitive) or a data class");
      }
      return;
    }
    if (!condition.path) {
      issue("path", "An argument path is required, for example repo or items[*].id");
    } else if (!parseMcpPolicyPath(condition.path)) {
      issue("path", "Use dot-separated keys, each optionally followed by [n] or [*], for example owner.login or items[*].id");
    }
    const isList = Array.isArray(value);
    switch (op) {
      case "equals":
        if (value === undefined || isList) issue("value", "Equals compares with one value");
        break;
      case "one_of":
      case "not_one_of":
        if (!isList || value.length === 0) issue("value", "List at least one value");
        break;
      case "starts_with":
      case "ends_with":
      case "matches":
        if (typeof value !== "string" || value.length === 0) issue("value", "Give a non-empty text value");
        else if (op === "matches" && value.split("*").length - 1 > MCP_POLICY_MAX_GLOB_STARS) {
          issue("value", `A pattern has at most ${MCP_POLICY_MAX_GLOB_STARS} * wildcards`);
        }
        break;
      case "lt":
      case "lte":
      case "gt":
      case "gte":
        if (typeof value !== "number") issue("value", "Give a number");
        break;
      case "between":
        if (!isList || value.length !== 2 || typeof value[0] !== "number" || typeof value[1] !== "number") {
          issue("value", "Give two numbers: [min, max]");
        } else if ((value[0] as number) > (value[1] as number)) {
          issue("value", "The minimum must not be greater than the maximum");
        }
        break;
      case "exists":
        if (value !== undefined && typeof value !== "boolean") issue("value", "Exists takes true (the default) or false");
        break;
    }
  });

const conditionListSchema = z
  .array(mcpPolicyConditionSchema)
  .min(1, "Add at least one condition, or leave conditions out")
  .max(MCP_POLICY_MAX_CONDITIONS, `A rule has at most ${MCP_POLICY_MAX_CONDITIONS} conditions`);

export const mcpToolPolicyConditionsSchema = z.union([
  z.object({ all: conditionListSchema }).strict(),
  z.object({ any: conditionListSchema }).strict()
]);

const policyPrincipalIdsSchema = z
  .array(z.string().trim().min(1).max(200))
  .max(MCP_POLICY_MAX_PRINCIPALS, `At most ${MCP_POLICY_MAX_PRINCIPALS} entries`);

const mcpToolPolicyRuleFieldsSchema = z.object({
  name: z.string().trim().max(120).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  effect: mcpToolPolicyEffectSchema,
  projectId: z.string().trim().min(1).nullable().optional(),
  roles: z.array(mcpPolicyRoleSchema).max(4).optional(),
  /** Phase 12.4 — only runs of these workflows; empty = every workflow. */
  workflowIds: policyPrincipalIdsSchema.optional(),
  /** Phase 12.4 — only calls made by these MCP gateway clients; empty = every caller. */
  clientIds: policyPrincipalIdsSchema.optional(),
  serverId: z.string().trim().min(1).nullable().optional(),
  /** Defaults to "*" (every tool) when a rule is created without one. */
  toolPattern: mcpToolPatternSchema.optional(),
  /** Phase 10.5 — only tools with this effective annotation hint; null = any tool. */
  annotationHint: mcpToolHintConditionSchema.nullable().optional(),
  /** Phase 10.5 — what the rule governs; defaults to `tool`. */
  kind: mcpPolicyKindSchema.optional(),
  /** Phase 12.4 — conditions on the call's arguments and data labels; null = every call. */
  conditions: mcpToolPolicyConditionsSchema.nullable().optional(),
  /** Phase 12.4 — defaults to `enforce`; `shadow` only logs what the rule would decide. */
  mode: mcpToolPolicyModeSchema.optional(),
  enabled: z.boolean().optional()
});

/**
 * Phase 12.4 — checks that need several fields of a whole rule (a new one, or
 * an existing one with an update applied): approval and conditions apply to
 * tool calls only.
 */
export function mcpToolPolicyRuleIssues(rule: {
  effect?: string;
  kind?: string | null;
  conditions?: unknown;
}): Array<{ path: string[]; message: string }> {
  const issues: Array<{ path: string[]; message: string }> = [];
  const kind = rule.kind ?? "tool";
  if (kind !== "tool" && rule.effect === "require_approval") {
    issues.push({ path: ["effect"], message: "Require approval applies to tool calls only" });
  }
  if (kind !== "tool" && rule.conditions) {
    issues.push({ path: ["conditions"], message: "Conditions apply to tool calls only" });
  }
  return issues;
}

export const mcpToolPolicyRuleInputSchema = mcpToolPolicyRuleFieldsSchema.superRefine((rule, ctx) => {
  for (const issue of mcpToolPolicyRuleIssues(rule)) ctx.addIssue({ code: z.ZodIssueCode.custom, ...issue });
});

export const mcpToolPolicyRuleUpdateSchema = mcpToolPolicyRuleFieldsSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "Empty update payload" });

export const mcpToolPolicyEvaluateSchema = z.object({
  projectId: z.string().trim().min(1).nullable().optional(),
  role: mcpPolicyRoleSchema,
  serverId: z.string().trim().min(1),
  /** The tool name, resource URI, prompt name or model name, depending on `kind`. */
  toolName: z.string().trim().min(1).max(2000),
  kind: mcpPolicyKindSchema.optional(),
  noWriteTools: z.boolean().optional(),
  /** Phase 12.4 — the call's arguments; absent evaluates the tool as discovery does (conditions cannot decide). */
  arguments: z.record(z.string(), z.unknown()).optional(),
  /** Phase 12.4 — the run's data labels: provenance labels and data class names. */
  labels: z.array(z.string().trim().min(1).max(64)).max(100).optional(),
  workflowId: z.string().trim().min(1).max(200).nullable().optional(),
  clientId: z.string().trim().min(1).max(200).nullable().optional(),
  /**
   * Phase 12.2 — an inline server's connection settings (`serverId` is an adapter id), as a node would configure
   * them. Only the endpoint's host is read, for the server's destination tier (open world); never echoed.
   */
  connection: z.record(z.string(), z.unknown()).optional()
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
