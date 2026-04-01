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
    "webhook_input",
    "text_input",
    "system_prompt",
    "user_prompt",
    "prompt_template",
    "llm_call",
    "agent_orchestrator",
    "local_memory",
    "mcp_tool",
    "rag_retrieve",
    "connector_source",
    "document_chunker",
    "output_parser",
    "human_approval",
    "input_validator",
    "output_guardrail",
    "if_node",
    "switch_node",
    "try_catch",
    "output"
  ]),
  name: z.string().min(1),
  position: z.object({ x: z.number(), y: z.number() }),
  config: z.record(z.string(), z.unknown())
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
  nodes: z.array(workflowNodeSchema),
  edges: z.array(workflowEdgeSchema),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional()
});

export const workflowExecuteRequestSchema = z.object({
  workflowId: z.string().optional(),
  sessionId: z.string().optional(),
  system_prompt: z.string().optional(),
  user_prompt: z.string().optional(),
  variables: z.record(z.string(), z.unknown()).optional(),
  input: z.record(z.string(), z.unknown()).optional()
});

export const agentWebhookPayloadSchema = z.object({
  workflow_id: z.string().optional(),
  session_id: z.string().optional(),
  system_prompt: z.string().min(1),
  user_prompt: z.string().min(1),
  variables: z.record(z.string(), z.unknown()).optional()
});

export type WorkflowSchemaInput = z.input<typeof workflowSchema>;
