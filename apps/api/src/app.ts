import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import fastifyRawBody from "fastify-raw-body";
import Fastify, { type FastifyReply } from "fastify";
import { z } from "zod";
import { createDefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { createDefaultProviderRegistry } from "@ai-orchestrator/provider-sdk";
import {
  agentWebhookPayloadSchema,
  nodeDefinitions,
  workflowExecuteRequestSchema,
  workflowSchema,
  type LLMProviderConfig,
  type MCPServerConfig,
  type SecretReference,
  type Workflow,
  type WorkflowExecutionState,
  type WorkflowNode
} from "@ai-orchestrator/shared";
import {
  executeCodeNodeSandbox,
  executeWorkflow,
  evaluateExpression,
  exportWorkflowToJson,
  importWorkflowFromJson,
  renderExpressionTemplate,
  validateWorkflowGraph
} from "@ai-orchestrator/workflow-engine";
import { SqliteStore } from "./db/database";
import type { AppConfig } from "./config";
import { SecretService } from "./services/secret-service";
import { AuthService, type SafeUser, type UserRole } from "./services/auth-service";
import { SchedulerService } from "./services/scheduler-service";
import { QueueService } from "./services/queue-service";
import { TriggerService } from "./services/trigger-service";
import { ApiKeyService } from "./services/api-key-service";
import { MfaService } from "./services/mfa-service";
import { SamlService, type SamlAssertionProfile } from "./services/saml-service";
import { LdapService } from "./services/ldap-service";
import {
  ALL_PERMISSIONS,
  RbacService,
  isProjectRole,
  type Permission,
  type ProjectRole
} from "./services/rbac-service";
import { ExternalSecretsService } from "./services/external-secrets-service";
import { GitSyncService } from "./services/git-sync-service";
import { LeaderElectionService } from "./services/leader-election-service";
import { MetricsService } from "./services/metrics-service";
import { TracingService } from "./services/tracing-service";
import { VariablesService } from "./services/variables-service";
import { WorkflowVersionService } from "./services/workflow-version-service";
import { AuditService, type AuditActor, type AuditCategory, type AuditEventInput } from "./services/audit-service";
import { LogStreamingService } from "./services/log-streaming-service";
import { openApiSpec } from "./openapi.js";

interface Tier1IntegrationSpec {
  id: string;
  label: string;
  category: string;
  logoPath: string;
  nodeTypes: string[];
}

const TIER1_INTEGRATIONS: Tier1IntegrationSpec[] = [
  { id: "http", label: "HTTP Request", category: "Protocol", logoPath: "/logos/http.svg", nodeTypes: ["http_request", "webhook_input", "webhook_response"] },
  { id: "slack", label: "Slack", category: "Communication", logoPath: "/logos/slack.svg", nodeTypes: ["slack_send_message", "slack_trigger"] },
  { id: "smtp", label: "Email (SMTP)", category: "Communication", logoPath: "/logos/smtp.svg", nodeTypes: ["smtp_send_email"] },
  { id: "imap", label: "Email (IMAP)", category: "Communication", logoPath: "/logos/imap.svg", nodeTypes: ["imap_email_trigger"] },
  { id: "gmail", label: "Gmail", category: "Communication", logoPath: "/logos/gmail.svg", nodeTypes: ["smtp_send_email", "imap_email_trigger"] },
  { id: "google-sheets", label: "Google Sheets", category: "Productivity", logoPath: "/logos/google-sheets.svg", nodeTypes: ["google_sheets_read", "google_sheets_append", "google_sheets_update", "google_sheets_trigger"] },
  { id: "postgresql", label: "PostgreSQL", category: "Database", logoPath: "/logos/postgresql.svg", nodeTypes: ["postgres_query", "postgres_trigger"] },
  { id: "mysql", label: "MySQL", category: "Database", logoPath: "/logos/mysql.svg", nodeTypes: ["mysql_query"] },
  { id: "mongodb", label: "MongoDB", category: "Database", logoPath: "/logos/mongodb.svg", nodeTypes: ["mongo_operation"] },
  { id: "redis", label: "Redis", category: "Database", logoPath: "/logos/redis.svg", nodeTypes: ["redis_command", "redis_trigger"] },
  { id: "github", label: "GitHub", category: "DevTools", logoPath: "/logos/github.svg", nodeTypes: ["github_action", "github_webhook_trigger"] }
];

const TIER2_INTEGRATIONS: Tier1IntegrationSpec[] = [
  { id: "microsoft-teams", label: "Microsoft Teams", category: "Communication", logoPath: "/logos/microsoft-teams.svg", nodeTypes: ["teams_send_message"] },
  { id: "notion", label: "Notion", category: "Productivity", logoPath: "/logos/notion.svg", nodeTypes: ["notion_create_page", "notion_query_database"] },
  { id: "airtable", label: "Airtable", category: "Productivity", logoPath: "/logos/airtable.svg", nodeTypes: ["airtable_create_record", "airtable_list_records", "airtable_update_record"] },
  { id: "jira", label: "Jira", category: "Project Management", logoPath: "/logos/jira.svg", nodeTypes: ["jira_create_issue", "jira_search_issues"] },
  { id: "salesforce", label: "Salesforce", category: "CRM", logoPath: "/logos/salesforce.svg", nodeTypes: ["salesforce_create_record", "salesforce_query"] },
  { id: "hubspot", label: "HubSpot", category: "CRM", logoPath: "/logos/hubspot.svg", nodeTypes: ["hubspot_create_contact", "hubspot_get_contact"] },
  { id: "stripe", label: "Stripe", category: "Payments", logoPath: "/logos/stripe.svg", nodeTypes: ["stripe_create_customer", "stripe_create_charge", "stripe_webhook_trigger"] },
  { id: "aws-s3", label: "AWS S3", category: "Cloud Storage", logoPath: "/logos/aws-s3.svg", nodeTypes: ["aws_s3_put_object", "aws_s3_get_object", "aws_s3_list_objects"] },
  { id: "telegram", label: "Telegram", category: "Communication", logoPath: "/logos/telegram.svg", nodeTypes: ["telegram_send_message", "telegram_trigger"] },
  { id: "discord", label: "Discord", category: "Communication", logoPath: "/logos/discord.svg", nodeTypes: ["discord_send_message", "discord_trigger"] },
  { id: "google-drive", label: "Google Drive", category: "Cloud Storage", logoPath: "/logos/google-drive.svg", nodeTypes: ["google_drive_trigger"] },
  { id: "google-calendar", label: "Google Calendar", category: "Productivity", logoPath: "/logos/google-calendar.svg", nodeTypes: ["google_calendar_create_event", "google_calendar_list_events"] },
  { id: "twilio", label: "Twilio", category: "Communication", logoPath: "/logos/twilio.svg", nodeTypes: ["twilio_send_sms"] }
];

const secretCreateSchema = z
  .object({
    name: z.string().min(1),
    provider: z.string().min(1),
    value: z.string().min(1).optional(),
    projectId: z.string().min(1).max(120).optional(),
    externalProviderId: z.string().min(1).max(120).optional(),
    externalKey: z.string().min(1).max(512).optional()
  })
  .superRefine((data, ctx) => {
    if (data.externalProviderId || data.externalKey) {
      if (!data.externalProviderId || !data.externalKey) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["externalProviderId"],
          message: "externalProviderId and externalKey are both required when creating an external secret"
        });
      }
      if (data.value !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["value"],
          message: "External secrets must not include a value — it is resolved from the provider"
        });
      }
    } else if (!data.value) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: "value is required for local secrets"
      });
    }
  });

const userRoleSchema = z.enum(["admin", "builder", "operator", "viewer"]);

const authRegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role: userRoleSchema.optional(),
  admin: z.boolean().optional()
});

const authLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

const workflowImportSchema = z.object({
  json: z.string().optional(),
  workflow: z.unknown().optional()
});

const workflowDuplicateSchema = z.object({
  name: z.string().min(1).max(120),
  id: z.string().min(1).max(120).optional()
});

const mcpDiscoverSchema = z.object({
  serverId: z.string().min(1),
  label: z.string().optional(),
  connection: z.record(z.string(), z.unknown()).optional(),
  secretRef: z
    .object({
      secretId: z.string().min(1)
    })
    .optional(),
  allowedTools: z.array(z.string()).optional()
});

const approvalDecisionSchema = z.object({
  reason: z.string().optional()
});

const codeNodeTestSchema = z.object({
  code: z.string().min(1),
  timeout: z.number().int().positive().max(60_000).optional(),
  input: z.record(z.string(), z.unknown()).optional()
});

const connectorTestSchema = z.object({
  connectorId: z.string().min(1),
  connectorConfig: z.record(z.string(), z.unknown()).optional()
});

const providerTestSchema = z.object({
  provider: z.object({
    providerId: z.string().min(1),
    model: z.string().min(1),
    baseUrl: z.string().optional(),
    secretRef: z
      .object({
        secretId: z.string().min(1)
      })
      .optional(),
    temperature: z.number().optional(),
    maxTokens: z.number().int().positive().optional(),
    extra: z.record(z.string(), z.unknown()).optional()
  }),
  prompt: z.string().optional(),
  systemPrompt: z.string().optional()
});

const pinDataSchema = z
  .object({
    data: z.unknown()
  })
  .superRefine((value, context) => {
    if (!Object.prototype.hasOwnProperty.call(value, "data")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["data"],
        message: "Required"
      });
    }
  });

const expressionPreviewSchema = z.object({
  expression: z.string(),
  mode: z.enum(["expression", "template"]).optional(),
  context: z
    .object({
      input: z.unknown().optional(),
      vars: z.record(z.string(), z.unknown()).optional(),
      nodeOutputs: z.record(z.string(), z.unknown()).optional(),
      workflow: z
        .object({
          id: z.string().optional(),
          name: z.string().optional()
        })
        .optional(),
      executionId: z.string().optional(),
      customData: z.record(z.string(), z.unknown()).optional()
    })
    .optional()
});

const workflowVariablesSchema = z.object({
  variables: z.record(z.string(), z.string())
});

type WebhookAuthMode = "none" | "bearer_token" | "hmac_sha256";

interface NormalizedWebhookSecurityConfig {
  authMode: WebhookAuthMode;
  authHeaderName: string;
  signatureHeaderName: string;
  timestampHeaderName: string;
  secretRef?: SecretReference;
  idempotencyEnabled: boolean;
  idempotencyHeaderName: string;
  replayToleranceSeconds: number;
}

interface WebhookEndpoint {
  nodeId: string;
  path: string;
  method: string;
  config: Record<string, unknown>;
}

interface ParsedWebhookResponseOverride {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
}

const DEFAULT_WEBHOOK_AUTH_HEADER = "authorization";
const DEFAULT_WEBHOOK_SIGNATURE_HEADER = "x-webhook-signature";
const DEFAULT_WEBHOOK_TIMESTAMP_HEADER = "x-webhook-timestamp";
const DEFAULT_IDEMPOTENCY_HEADER = "idempotency-key";
const DEFAULT_REPLAY_TOLERANCE_SECONDS = 300;
const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

function normalizeHeaderName(value: unknown, fallback: string): string {
  const input = typeof value === "string" ? value.trim() : "";
  return (input || fallback).toLowerCase();
}

function normalizeWebhookAuthMode(value: unknown): WebhookAuthMode {
  if (value === "bearer_token" || value === "hmac_sha256" || value === "none") {
    return value;
  }
  return "none";
}

function normalizeWebhookSecurityConfig(config: Record<string, unknown>): NormalizedWebhookSecurityConfig {
  const authMode = normalizeWebhookAuthMode(config.authMode);
  const secretRefCandidate = asRecord(config.secretRef);
  const secretRef =
    typeof secretRefCandidate.secretId === "string" && secretRefCandidate.secretId.trim()
      ? ({ secretId: secretRefCandidate.secretId.trim() } satisfies SecretReference)
      : undefined;

  const replayToleranceInput = Number(config.replayToleranceSeconds);
  const replayToleranceSeconds =
    Number.isFinite(replayToleranceInput) && replayToleranceInput > 0
      ? Math.floor(replayToleranceInput)
      : DEFAULT_REPLAY_TOLERANCE_SECONDS;

  return {
    authMode,
    authHeaderName: normalizeHeaderName(config.authHeaderName, DEFAULT_WEBHOOK_AUTH_HEADER),
    signatureHeaderName: normalizeHeaderName(config.signatureHeaderName, DEFAULT_WEBHOOK_SIGNATURE_HEADER),
    timestampHeaderName: normalizeHeaderName(config.timestampHeaderName, DEFAULT_WEBHOOK_TIMESTAMP_HEADER),
    secretRef,
    idempotencyEnabled: config.idempotencyEnabled === true,
    idempotencyHeaderName: normalizeHeaderName(config.idempotencyHeaderName, DEFAULT_IDEMPOTENCY_HEADER),
    replayToleranceSeconds
  };
}

function getHeaderValue(headers: Record<string, unknown>, headerName: string): string {
  const direct = headers[headerName];
  if (typeof direct === "string") {
    return direct.trim();
  }
  if (Array.isArray(direct)) {
    const first = direct[0];
    return typeof first === "string" ? first.trim() : "";
  }
  return "";
}

function normalizeTimestampToMs(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return null;
    }
    return numeric > 1e12 ? numeric : numeric * 1000;
  }

  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function stripSignaturePrefix(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const equalsIndex = trimmed.indexOf("=");
  if (equalsIndex > 0) {
    return trimmed.slice(equalsIndex + 1).trim();
  }
  return trimmed;
}

function normalizeExecutionTimeoutMs(
  primary: unknown,
  secondary: unknown,
  fallbackMs: number
): number {
  const candidate =
    typeof primary === "number" && Number.isFinite(primary) && primary > 0
      ? primary
      : typeof secondary === "number" && Number.isFinite(secondary) && secondary > 0
        ? secondary
        : fallbackMs;
  const bounded = Math.floor(candidate);
  return Math.max(1_000, Math.min(86_400_000, bounded));
}

function normalizeIsoDateFilter(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const timestamp = Date.parse(value.trim());
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }
  return new Date(timestamp).toISOString();
}

function normalizeWorkflowIdCandidate(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || "workflow-copy";
}

function makeUniqueWorkflowId(store: SqliteStore, preferredId: string): string {
  const base = normalizeWorkflowIdCandidate(preferredId);
  if (!store.getWorkflow(base)) {
    return base;
  }

  for (let index = 2; index <= 10_000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!store.getWorkflow(candidate)) {
      return candidate;
    }
  }

  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

function normalizeProviderConfigForTest(
  input: z.infer<typeof providerTestSchema>["provider"]
): LLMProviderConfig {
  const normalizedBaseUrl = typeof input.baseUrl === "string" && input.baseUrl.trim() ? input.baseUrl.trim() : undefined;
  const normalizedSecretId =
    typeof input.secretRef?.secretId === "string" && input.secretRef.secretId.trim()
      ? input.secretRef.secretId.trim()
      : undefined;
  const normalizedExtra = input.extra && Object.keys(input.extra).length > 0 ? input.extra : undefined;

  return {
    providerId: input.providerId.trim(),
    model: input.model.trim(),
    ...(normalizedBaseUrl ? { baseUrl: normalizedBaseUrl } : {}),
    ...(normalizedSecretId ? { secretRef: { secretId: normalizedSecretId } } : {}),
    ...(typeof input.temperature === "number" && Number.isFinite(input.temperature)
      ? { temperature: input.temperature }
      : {}),
    ...(typeof input.maxTokens === "number" && Number.isFinite(input.maxTokens) ? { maxTokens: input.maxTokens } : {}),
    ...(normalizedExtra ? { extra: normalizedExtra } : {})
  };
}

function toSecretReference(value: unknown): SecretReference | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const rec = value as Record<string, unknown>;
    if (typeof rec.secretId === "string" && rec.secretId.trim()) {
      return { secretId: rec.secretId.trim() };
    }
  }
  return undefined;
}

function safeEqualSecret(expected: string, provided: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

function computeSha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function redactSensitiveInput(value: unknown): unknown {
  const sensitiveKeyPattern = /(api[-_]?key|token|password|secret|authorization)/i;

  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveInput(entry));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  const redacted: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(record)) {
    if (key === "secretId") {
      redacted[key] = nestedValue;
      continue;
    }
    if (sensitiveKeyPattern.test(key)) {
      redacted[key] = typeof nestedValue === "string" && nestedValue.length > 0 ? "***redacted***" : nestedValue;
      continue;
    }
    redacted[key] = redactSensitiveInput(nestedValue);
  }

  return redacted;
}

function toDurationMs(startedAt: string, completedAt: string): number | undefined {
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed)) {
    return undefined;
  }
  return Math.max(0, Math.floor(completed - started));
}

function summarizeNodeStatuses(nodeResults: Array<{ status?: unknown }> | undefined): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const nodeResult of nodeResults ?? []) {
    const status = typeof nodeResult.status === "string" && nodeResult.status.trim() ? nodeResult.status.trim() : "unknown";
    summary[status] = (summary[status] ?? 0) + 1;
  }
  return summary;
}

function normalizeSessionId(sessionId?: string, sessionIdSnakeCase?: string): string | undefined {
  const camel = typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : undefined;
  const snake = typeof sessionIdSnakeCase === "string" && sessionIdSnakeCase.trim() ? sessionIdSnakeCase.trim() : undefined;
  return camel ?? snake;
}

function resolveWidgetBundlePath(): string {
  const appFilePath = fileURLToPath(import.meta.url);
  const appDirectory = path.dirname(appFilePath);
  return path.resolve(appDirectory, "../../web/dist-widget/widget.js");
}

function resolveHelperChatPagePath(): string {
  const appFilePath = fileURLToPath(import.meta.url);
  const appDirectory = path.dirname(appFilePath);
  return path.resolve(appDirectory, "../public/helper-chat.html");
}

function parseConfiguredOrigins(configuredOrigin: string): Set<string> {
  const parsed = configuredOrigin
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  return new Set(parsed);
}

function isLocalDevOrigin(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

async function selectWebhookWorkflow(store: SqliteStore, workflowId?: string): Promise<Workflow | null> {
  if (workflowId) {
    return store.getWorkflow(workflowId);
  }

  const workflows = store.listWorkflows();
  for (const workflowSummary of workflows) {
    const workflow = store.getWorkflow(workflowSummary.id);
    if (!workflow) {
      continue;
    }

    if (workflow.nodes.some((node) => node.type === "webhook_input")) {
      return workflow;
    }
  }

  return workflows.length ? store.getWorkflow(workflows[0].id) : null;
}

const allowedWebhookMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function hasOwnRecordKey(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function extractNodeOutputsFromResults(nodeResults: unknown): Record<string, unknown> {
  const outputs: Record<string, unknown> = {};
  if (!Array.isArray(nodeResults)) {
    return outputs;
  }

  for (const entry of nodeResults) {
    const result = asRecord(entry);
    const nodeId = typeof result.nodeId === "string" ? result.nodeId : "";
    if (!nodeId || !hasOwnRecordKey(result, "output")) {
      continue;
    }
    outputs[nodeId] = result.output;
  }
  return outputs;
}

function normalizeWebhookPath(value: unknown, fallback: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const withFallback = raw || fallback;
  return withFallback.replace(/^\/+/, "").replace(/\/+$/, "");
}

function normalizeWebhookMethod(value: unknown): string {
  const method = typeof value === "string" ? value.trim().toUpperCase() : "POST";
  return allowedWebhookMethods.has(method) ? method : "POST";
}

function parseWebhookResponseOverride(output: unknown): ParsedWebhookResponseOverride | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return null;
  }

  const outputRecord = output as Record<string, unknown>;
  const raw = outputRecord.__webhookResponse;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const responseRecord = raw as Record<string, unknown>;
  const statusCode =
    typeof responseRecord.statusCode === "number" && Number.isFinite(responseRecord.statusCode)
      ? Math.max(100, Math.min(599, Math.floor(responseRecord.statusCode)))
      : 200;

  const normalizedHeaders: Record<string, string> = {};
  if (responseRecord.headers && typeof responseRecord.headers === "object" && !Array.isArray(responseRecord.headers)) {
    for (const [key, value] of Object.entries(responseRecord.headers as Record<string, unknown>)) {
      normalizedHeaders[key] = String(value);
    }
  }

  return {
    statusCode,
    headers: normalizedHeaders,
    body: responseRecord.body
  };
}

function listWebhookEndpoints(workflow: Workflow): WebhookEndpoint[] {
  return workflow.nodes
    .filter((node) => node.type === "webhook_input")
    .map((node) => {
      const config = asRecord(node.config);
      const path = normalizeWebhookPath(config.path, node.id);
      const method = normalizeWebhookMethod(config.method);
      return {
        nodeId: node.id,
        path,
        method,
        config
      };
    });
}

async function listWebhookEndpointMatchesByPath(
  store: SqliteStore,
  path: string
): Promise<Array<{ workflowId: string; workflowName: string; nodeId: string; path: string; method: string }>> {
  const normalizedPath = normalizeWebhookPath(path, "").toLowerCase();
  const matches: Array<{ workflowId: string; workflowName: string; nodeId: string; path: string; method: string }> = [];

  const workflows = store.listWorkflows();
  for (const workflowSummary of workflows) {
    const workflow = store.getWorkflow(workflowSummary.id);
    if (!workflow) {
      continue;
    }

    for (const endpoint of listWebhookEndpoints(workflow)) {
      if (endpoint.path.toLowerCase() !== normalizedPath) {
        continue;
      }

      matches.push({
        workflowId: workflow.id,
        workflowName: workflow.name,
        nodeId: endpoint.nodeId,
        path: endpoint.path,
        method: endpoint.method
      });
    }
  }

  return matches;
}

async function listAllWebhookEndpoints(
  store: SqliteStore
): Promise<Array<{ workflowId: string; workflowName: string; nodeId: string; path: string; method: string }>> {
  const endpoints: Array<{ workflowId: string; workflowName: string; nodeId: string; path: string; method: string }> = [];
  const workflows = store.listWorkflows();

  for (const workflowSummary of workflows) {
    const workflow = store.getWorkflow(workflowSummary.id);
    if (!workflow) {
      continue;
    }

    for (const endpoint of listWebhookEndpoints(workflow)) {
      endpoints.push({
        workflowId: workflow.id,
        workflowName: workflow.name,
        nodeId: endpoint.nodeId,
        path: endpoint.path,
        method: endpoint.method
      });
    }
  }

  return endpoints;
}

async function selectWebhookByPath(
  store: SqliteStore,
  path: string,
  method: string
): Promise<{ workflow: Workflow; endpoint: WebhookEndpoint } | null> {
  const normalizedPath = normalizeWebhookPath(path, "").toLowerCase();
  const normalizedMethod = normalizeWebhookMethod(method);

  const workflows = store.listWorkflows();
  for (const workflowSummary of workflows) {
    const workflow = store.getWorkflow(workflowSummary.id);
    if (!workflow) {
      continue;
    }

    const endpoints = listWebhookEndpoints(workflow);
    const endpoint = endpoints.find(
      (entry) => entry.path.toLowerCase() === normalizedPath && entry.method === normalizedMethod
    );
    if (endpoint) {
      return { workflow, endpoint };
    }
  }

  return null;
}

function getRawRequestBody(request: { rawBody?: unknown; body: unknown }): string {
  if (typeof request.rawBody === "string") {
    return request.rawBody;
  }
  if (Buffer.isBuffer(request.rawBody)) {
    return request.rawBody.toString("utf8");
  }

  if (typeof request.body === "string") {
    return request.body;
  }

  if (request.body === undefined || request.body === null) {
    return "";
  }

  try {
    return JSON.stringify(request.body);
  } catch {
    return String(request.body);
  }
}

function decodeBufferLikePayload(payload: unknown): string | null {
  if (Buffer.isBuffer(payload)) {
    return payload.toString("utf8");
  }

  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    if (record.type === "Buffer" && Array.isArray(record.data)) {
      const bytes = record.data.filter((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255) as number[];
      if (bytes.length === record.data.length) {
        return Buffer.from(bytes).toString("utf8");
      }
    }
  }

  return null;
}

async function verifyWebhookRequestAuth(input: {
  security: NormalizedWebhookSecurityConfig;
  headers: Record<string, unknown>;
  rawBody: string;
  endpointKey: string;
  store: SqliteStore;
  secretService: SecretService;
}): Promise<{ ok: true } | { ok: false; statusCode: 401 | 403; message: string }> {
  const { security } = input;

  if (security.authMode === "none") {
    return { ok: true };
  }

  const secret = await input.secretService.resolveSecret(security.secretRef);
  if (!secret) {
    return {
      ok: false,
      statusCode: 401,
      message: "Webhook authentication is not configured correctly"
    };
  }

  const headers = input.headers;

  if (security.authMode === "bearer_token") {
    const headerValue = getHeaderValue(headers, security.authHeaderName);
    if (!headerValue) {
      return {
        ok: false,
        statusCode: 401,
        message: "Unauthorized webhook request"
      };
    }

    const token =
      security.authHeaderName === "authorization" && headerValue.toLowerCase().startsWith("bearer ")
        ? headerValue.slice(7).trim()
        : headerValue;

    if (!token || !safeEqualSecret(secret, token)) {
      return {
        ok: false,
        statusCode: 401,
        message: "Unauthorized webhook request"
      };
    }

    return { ok: true };
  }

  const signatureHeaderValue = getHeaderValue(headers, security.signatureHeaderName);
  const timestampHeaderValue = getHeaderValue(headers, security.timestampHeaderName);
  if (!signatureHeaderValue || !timestampHeaderValue) {
    return {
      ok: false,
      statusCode: 403,
      message: "Invalid webhook signature"
    };
  }

  const timestampMs = normalizeTimestampToMs(timestampHeaderValue);
  if (!timestampMs) {
    return {
      ok: false,
      statusCode: 403,
      message: "Invalid webhook signature timestamp"
    };
  }

  const nowMs = Date.now();
  const toleranceMs = security.replayToleranceSeconds * 1000;
  if (Math.abs(nowMs - timestampMs) > toleranceMs) {
    return {
      ok: false,
      statusCode: 403,
      message: "Webhook signature is outside the allowed time window"
    };
  }

  const rawSignature = stripSignaturePrefix(signatureHeaderValue).toLowerCase();
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(`${timestampHeaderValue}.${input.rawBody}`)
    .digest("hex");

  if (!rawSignature || !safeEqualSecret(expectedSignature, rawSignature)) {
    return {
      ok: false,
      statusCode: 403,
      message: "Invalid webhook signature"
    };
  }

  input.store.clearExpiredWebhookSecurityState(new Date(nowMs).toISOString());
  const replayFingerprint = computeSha256Hex(`${input.endpointKey}|${timestampHeaderValue}|${rawSignature}`);
  if (input.store.hasWebhookReplayKey(replayFingerprint)) {
    return {
      ok: false,
      statusCode: 403,
      message: "Webhook replay detected"
    };
  }

  const replayExpiry = new Date(nowMs + toleranceMs).toISOString();
  input.store.saveWebhookReplayKey({
    replayKey: replayFingerprint,
    endpointKey: input.endpointKey,
    expiresAt: replayExpiry
  });

  return { ok: true };
}

export function createApp(
  config: AppConfig,
  store: SqliteStore,
  secretService: SecretService,
  authService: AuthService,
  schedulerService?: SchedulerService,
  queueService?: QueueService,
  triggerService?: TriggerService
) {
  const app = Fastify({ logger: { level: config.LOG_LEVEL } });
  const providerRegistry = createDefaultProviderRegistry();
  const connectorRegistry = createDefaultConnectorRegistry();
  const mcpRegistry = createDefaultMCPRegistry();
  const agentRuntime = createDefaultAgentRuntime();
  const activeExecutions = new Map<
    string,
    {
      controller: AbortController;
      workflowId: string;
      startedAt: string;
      triggerType?: string;
      triggeredBy?: string;
    }
  >();

  const pruneExecutionHistory = (reason: "startup" | "interval" | "write") => {
    const retentionDays = config.EXECUTION_HISTORY_RETENTION_DAYS;
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
      return 0;
    }
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    try {
      const deleted = store.pruneExecutionHistory({ before: cutoff });
      if (deleted > 0) {
        app.log.info({ deleted, cutoff, retentionDays, reason }, "Pruned execution history");
      }
      return deleted;
    } catch (error) {
      app.log.warn(
        {
          cutoff,
          retentionDays,
          reason,
          error: secretService.redact(error instanceof Error ? error.message : String(error))
        },
        "Failed to prune execution history"
      );
      return 0;
    }
  };

  pruneExecutionHistory("startup");
  const retentionTimer = config.EXECUTION_HISTORY_RETENTION_DAYS > 0
    ? setInterval(() => {
        pruneExecutionHistory("interval");
      }, config.EXECUTION_HISTORY_PRUNE_INTERVAL_MS)
    : null;
  if (retentionTimer) {
    const timerWithUnref = retentionTimer as { unref?: () => void };
    timerWithUnref.unref?.();
    app.addHook("onClose", async () => {
      clearInterval(retentionTimer);
    });
  }

  type WorkflowExecutionEventHooks = {
    onNodeStart?: (event: { nodeId: string; nodeType: string; startedAt: string }) => Promise<void> | void;
    onNodeComplete?: (event: {
      nodeId: string;
      nodeType: string;
      status: string;
      completedAt: string;
      durationMs: number;
      input?: unknown;
      output?: unknown;
      error?: string;
    }) => Promise<void> | void;
    onLLMDelta?: (event: { nodeId: string; delta: string; index: number }) => Promise<void> | void;
  };
  type ExecutionHistoryRecord = Parameters<SqliteStore["saveExecutionHistory"]>[0];

  const registerActiveExecution = (input: {
    executionId: string;
    workflowId: string;
    triggerType?: string;
    triggeredBy?: string;
  }): AbortController => {
    const existing = activeExecutions.get(input.executionId);
    if (existing) {
      return existing.controller;
    }
    const controller = new AbortController();
    activeExecutions.set(input.executionId, {
      controller,
      workflowId: input.workflowId,
      startedAt: new Date().toISOString(),
      triggerType: input.triggerType,
      triggeredBy: input.triggeredBy
    });
    return controller;
  };

  const releaseActiveExecution = (executionId: string | undefined, controller: AbortController | undefined) => {
    if (!executionId || !controller) {
      return;
    }
    const current = activeExecutions.get(executionId);
    if (current?.controller === controller) {
      activeExecutions.delete(executionId);
      metricsService.setActiveExecutions(activeExecutions.size);
    }
  };

  const persistExecutionHistoryRecord = (
    record: ExecutionHistoryRecord,
    meta: {
      phase: "progress" | "final";
      executionId: string;
      workflowId: string;
      triggerType?: string;
      status: string;
    }
  ): boolean => {
    const active = activeExecutions.get(meta.executionId);
    if (active?.controller.signal.aborted && record.status !== "canceled") {
      return false;
    }
    try {
      store.saveExecutionHistory(record);
      if (meta.phase === "final") {
        pruneExecutionHistory("write");
        const status = meta.status === "success" ? "success" : meta.status === "canceled" ? "canceled" : "error";
        metricsService.recordExecution(status, record.durationMs ?? 0);
        metricsService.setActiveExecutions(activeExecutions.size);
      }
      return true;
    } catch (error) {
      app.log.error(
        {
          executionId: meta.executionId,
          workflowId: meta.workflowId,
          triggerType: meta.triggerType,
          status: meta.status,
          phase: meta.phase,
          error: secretService.redact(error instanceof Error ? error.message : String(error))
        },
        "Failed to persist execution history"
      );
      return false;
    }
  };

  const deleteWorkflowExecutionSafely = (executionId: string, workflowId: string) => {
    try {
      store.deleteWorkflowExecution(executionId);
    } catch (error) {
      app.log.warn(
        {
          executionId,
          workflowId,
          error: secretService.redact(error instanceof Error ? error.message : String(error))
        },
        "Failed to clear paused workflow execution state"
      );
    }
  };

  const runWorkflowExecution = async (input: {
    workflow: Workflow;
    startNodeId?: string;
    runMode?: "workflow" | "single_node";
    usePinnedData?: boolean;
    pinnedData?: Record<string, unknown>;
    nodeOutputs?: Record<string, unknown>;
    webhookPayload?: Record<string, unknown>;
    variables?: Record<string, unknown>;
    systemPrompt?: string;
    userPrompt?: string;
    sessionId?: string;
    directInput?: Record<string, unknown>;
    executionId?: string;
    triggerType?: string;
    triggeredBy?: string;
    executionTimeoutMs?: number;
    customData?: Record<string, unknown>;
    resumeState?: WorkflowExecutionState;
    approvalDecision?: {
      decision: "approve" | "reject";
      actedBy?: string;
      reason?: string;
    };
    hooks?: WorkflowExecutionEventHooks;
  }) => {
    const controller = input.executionId
      ? registerActiveExecution({
          executionId: input.executionId,
          workflowId: input.workflow.id,
          triggerType: input.triggerType,
          triggeredBy: input.triggeredBy
        })
      : undefined;
    const projectVars = variablesService.resolveForProject(input.workflow.projectId ?? "default");
    const mergedWorkflow: Workflow = {
      ...input.workflow,
      variables: { ...projectVars, ...(input.workflow.variables ?? {}) }
    };
    try {
      const result = await executeWorkflow(
        {
          workflow: mergedWorkflow,
          startNodeId: input.startNodeId,
          runMode: input.runMode,
          usePinnedData: input.usePinnedData,
          pinnedData: input.pinnedData,
          nodeOutputs: input.nodeOutputs,
          input: input.directInput,
          webhookPayload: input.webhookPayload,
          variables: input.variables,
          systemPrompt: input.systemPrompt,
          userPrompt: input.userPrompt,
          sessionId: input.sessionId,
          executionId: input.executionId,
          customData: input.customData,
          executionTimeoutMs: normalizeExecutionTimeoutMs(
            input.executionTimeoutMs,
            undefined,
            config.WORKFLOW_EXECUTION_TIMEOUT_MS
          ),
          triggerType: input.triggerType,
          triggeredBy: input.triggeredBy,
          resumeState: input.resumeState,
          approvalDecision: input.approvalDecision
        },
        {
          providerRegistry,
          connectorRegistry,
          mcpRegistry,
          agentRuntime,
          memoryStore: {
            loadMessages: async (namespace, sessionId) => store.loadSessionMemory(namespace, sessionId),
            saveMessages: async (namespace, sessionId, messages) => {
              store.saveSessionMemory(namespace, sessionId, messages);
            }
          },
          toolDataStore: {
            saveToolCall: async (payload) =>
              store.saveSessionToolCall({
                namespace: payload.namespace,
                sessionId: payload.sessionId,
                toolName: payload.toolName,
                toolCallId: payload.toolCallId,
                args: payload.args,
                output: payload.output,
                error: payload.error,
                summary: payload.summary
              }),
            listToolCalls: async (payload) =>
              store.listSessionToolCalls({
                namespace: payload.namespace,
                sessionId: payload.sessionId,
                toolName: payload.toolName,
                limit: payload.limit
              }),
            getToolCall: async (payload) =>
              store.getSessionToolCall({
                namespace: payload.namespace,
                sessionId: payload.sessionId,
                id: payload.id
              })
          },
          loadWorkflow: (workflowId) => store.getWorkflow(workflowId) ?? undefined,
          resolveSecret: (secretRef) => secretService.resolveSecret(secretRef),
          persistPausedExecution: async (paused) => {
            store.saveWorkflowExecutionState({
              id: paused.executionId,
              workflowId: paused.workflowId,
              workflowName: paused.workflowName,
              status: "waiting_approval",
              waitingNodeId: paused.waitingNodeId,
              approvalMessage: paused.approvalMessage,
              timeoutMinutes: paused.timeoutMinutes,
              triggerType: paused.triggerType,
              triggeredBy: paused.triggeredBy,
              startedAt: paused.startedAt,
              state: paused.state
            });
          },
          onNodeStart: input.hooks?.onNodeStart,
          onNodeComplete: input.hooks?.onNodeComplete,
          onLLMDelta: input.hooks?.onLLMDelta,
          abortSignal: controller?.signal
        }
      );

      if (controller?.signal.aborted && result.status !== "canceled") {
        const completedAt = new Date().toISOString();
        return {
          ...result,
          status: "canceled" as const,
          completedAt,
          customData: input.customData ?? result.customData,
          error: "Workflow execution canceled."
        };
      }

      return result;
    } finally {
      releaseActiveExecution(input.executionId, controller);
    }
  };

  const parseWebhookRunInput = (payload: unknown) => {
    let body = asRecord(payload);
    const bufferTextPayload = decodeBufferLikePayload(payload);
    const maybeTextPayload = typeof payload === "string" ? payload : bufferTextPayload ?? "";
    if (maybeTextPayload.trim()) {
      try {
        const parsed = JSON.parse(maybeTextPayload);
        body = asRecord(parsed);
      } catch {
        if (typeof payload === "string" || bufferTextPayload !== null) {
          body = {};
        }
      }
    }
    const userPromptRaw =
      typeof body.user_prompt === "string"
        ? body.user_prompt
        : typeof body.prompt === "string"
          ? body.prompt
          : "";
    const userPrompt = userPromptRaw.trim();
    const systemPrompt = typeof body.system_prompt === "string" ? body.system_prompt.trim() : "";
    const sessionId = normalizeSessionId(
      typeof body.sessionId === "string" ? body.sessionId : undefined,
      typeof body.session_id === "string" ? body.session_id : undefined
    );
    const variables = body.variables && typeof body.variables === "object" && !Array.isArray(body.variables)
      ? (body.variables as Record<string, unknown>)
      : undefined;
    const executionTimeoutMs = normalizeExecutionTimeoutMs(
      body.executionTimeoutMs,
      body.execution_timeout_ms,
      config.WORKFLOW_EXECUTION_TIMEOUT_MS
    );

    return {
      body,
      userPrompt: userPrompt || undefined,
      systemPrompt: systemPrompt || undefined,
      sessionId,
      variables,
      executionTimeoutMs
    };
  };

  const persistExecutionHistory = (input: {
    executionId: string;
    workflow: Workflow;
    result: Awaited<ReturnType<typeof runWorkflowExecution>>;
    triggerType?: string;
    triggeredBy?: string;
    requestInput?: unknown;
    customData?: Record<string, unknown>;
  }) => {
    if (input.result.status === "waiting_approval") {
      app.log.info(
        {
          executionId: input.executionId,
          workflowId: input.workflow.id,
          triggerType: input.triggerType,
          triggeredBy: input.triggeredBy,
          status: input.result.status
        },
        "Workflow execution is waiting for approval"
      );
      return;
    }

    const persisted = persistExecutionHistoryRecord({
      id: input.executionId,
      workflowId: input.workflow.id,
      workflowName: input.workflow.name,
      status: input.result.status,
      startedAt: input.result.startedAt,
      completedAt: input.result.completedAt,
      durationMs: toDurationMs(input.result.startedAt, input.result.completedAt),
      triggerType: input.triggerType,
      triggeredBy: input.triggeredBy,
      inputJson: redactSensitiveInput(input.requestInput),
      outputJson: input.result.output,
      nodeResultsJson: input.result.nodeResults,
      customData: input.customData ?? input.result.customData,
      error: input.result.error
    }, {
      phase: "final",
      executionId: input.executionId,
      workflowId: input.workflow.id,
      triggerType: input.triggerType,
      status: input.result.status
    });

    if (persisted) {
      deleteWorkflowExecutionSafely(input.executionId, input.workflow.id);
    }

    auditService.record({
      category: "execution",
      eventType: `execution.${input.result.status}`,
      action: "execute",
      outcome: input.result.status === "error" ? "failure" : "success",
      actor: {
        email: typeof input.triggeredBy === "string" ? input.triggeredBy : null,
        type: "system"
      },
      resourceType: "workflow",
      resourceId: input.workflow.id,
      projectId: input.workflow.projectId ?? null,
      metadata: {
        executionId: input.executionId,
        triggerType: input.triggerType,
        durationMs: toDurationMs(input.result.startedAt, input.result.completedAt),
        status: input.result.status,
        error: input.result.error ?? null
      }
    });

    app.log.info(
      {
        executionId: input.executionId,
        workflowId: input.workflow.id,
        triggerType: input.triggerType,
        triggeredBy: input.triggeredBy,
        status: input.result.status,
        durationMs: toDurationMs(input.result.startedAt, input.result.completedAt),
        nodeStatusSummary: summarizeNodeStatuses(input.result.nodeResults as Array<{ status?: unknown }>),
        persistedHistory: persisted
      },
      "Workflow execution completed"
    );
  };

  const createProgressTrackingHooks = (input: {
    executionId: string;
    workflow: Workflow;
    triggerType?: string;
    triggeredBy?: string;
    requestInput?: unknown;
    customData?: Record<string, unknown>;
    passthroughHooks?: WorkflowExecutionEventHooks;
  }): WorkflowExecutionEventHooks => {
    const nodeResultsById = new Map<
      string,
      {
        nodeId: string;
        status: string;
        startedAt: string;
        completedAt?: string;
        durationMs?: number;
        input?: unknown;
        output?: unknown;
        error?: string;
      }
    >();
    let startedAt: string | null = null;
    let currentStatus: "running" | "waiting_approval" = "running";
    let startLogged = false;

    const snapshotNodeResults = () => [...nodeResultsById.values()];
    const persistProgress = (completedAt?: string) => {
      const effectiveStartedAt = startedAt ?? new Date().toISOString();
      persistExecutionHistoryRecord({
        id: input.executionId,
        workflowId: input.workflow.id,
        workflowName: input.workflow.name,
        status: currentStatus,
        startedAt: effectiveStartedAt,
        completedAt: currentStatus === "waiting_approval" ? completedAt ?? effectiveStartedAt : undefined,
        durationMs:
          completedAt && currentStatus === "waiting_approval"
            ? toDurationMs(effectiveStartedAt, completedAt)
            : undefined,
        triggerType: input.triggerType,
        triggeredBy: input.triggeredBy,
        inputJson: redactSensitiveInput(input.requestInput),
        customData: input.customData,
        nodeResultsJson: snapshotNodeResults()
      }, {
        phase: "progress",
        executionId: input.executionId,
        workflowId: input.workflow.id,
        triggerType: input.triggerType,
        status: currentStatus
      });
    };

    return {
      onNodeStart: async (event) => {
        if (!startLogged) {
          startLogged = true;
          app.log.info(
            {
              executionId: input.executionId,
              workflowId: input.workflow.id,
              triggerType: input.triggerType,
              triggeredBy: input.triggeredBy,
              firstNodeId: event.nodeId,
              firstNodeType: event.nodeType
            },
            "Workflow execution started"
          );
        }
        if (!startedAt) {
          startedAt = event.startedAt;
        }
        const existing = nodeResultsById.get(event.nodeId);
        nodeResultsById.set(event.nodeId, {
          nodeId: event.nodeId,
          status: "running",
          startedAt: existing?.startedAt ?? event.startedAt,
          input: existing?.input,
          output: existing?.output,
          error: existing?.error
        });
        persistProgress();
        try {
          await input.passthroughHooks?.onNodeStart?.(event);
        } catch (error) {
          app.log.warn(
            {
              executionId: input.executionId,
              workflowId: input.workflow.id,
              nodeId: event.nodeId,
              nodeType: event.nodeType,
              error: secretService.redact(error instanceof Error ? error.message : String(error))
            },
            "Execution node-start hook failed"
          );
        }
      },
      onNodeComplete: async (event) => {
        const existing = nodeResultsById.get(event.nodeId);
        if (!startedAt) {
          startedAt = existing?.startedAt ?? event.completedAt;
        }
        nodeResultsById.set(event.nodeId, {
          nodeId: event.nodeId,
          status: event.status,
          startedAt: existing?.startedAt ?? event.completedAt,
          completedAt: event.completedAt,
          durationMs: event.durationMs,
          input: event.input ?? existing?.input,
          output: event.output ?? existing?.output,
          error: event.error
        });
        if (event.status === "waiting_approval") {
          currentStatus = "waiting_approval";
        }
        persistProgress(event.completedAt);
        app.log.debug(
          {
            executionId: input.executionId,
            workflowId: input.workflow.id,
            nodeId: event.nodeId,
            nodeType: event.nodeType,
            status: event.status,
            durationMs: event.durationMs
          },
          "Workflow node completed"
        );
        try {
          await input.passthroughHooks?.onNodeComplete?.(event);
        } catch (error) {
          app.log.warn(
            {
              executionId: input.executionId,
              workflowId: input.workflow.id,
              nodeId: event.nodeId,
              nodeType: event.nodeType,
              status: event.status,
              error: secretService.redact(error instanceof Error ? error.message : String(error))
            },
            "Execution node-complete hook failed"
          );
        }
      },
      onLLMDelta: async (event) => {
        try {
          await input.passthroughHooks?.onLLMDelta?.(event);
        } catch (error) {
          app.log.warn(
            {
              executionId: input.executionId,
              workflowId: input.workflow.id,
              nodeId: event.nodeId,
              index: event.index,
              error: secretService.redact(error instanceof Error ? error.message : String(error))
            },
            "Execution LLM-delta hook failed"
          );
        }
      }
    };
  };

  type ParsedWorkflowExecutePayload = z.infer<typeof workflowExecuteRequestSchema>;
  const prepareWorkflowExecutionPayload = (
    payload: ParsedWorkflowExecutePayload,
    reply: FastifyReply
  ):
    | {
        payload: ParsedWorkflowExecutePayload;
        nodeOutputs: Record<string, unknown>;
        requestInput: Record<string, unknown>;
      }
    | null => {
    const sourceExecutionId = typeof payload.sourceExecutionId === "string" && payload.sourceExecutionId.trim()
      ? payload.sourceExecutionId.trim()
      : undefined;
    let replayInput: Record<string, unknown> = {};
    let replayNodeOutputs: Record<string, unknown> = {};

    if (sourceExecutionId) {
      const sourceExecution = store.getExecutionHistory(sourceExecutionId);
      if (!sourceExecution) {
        reply.code(404);
        return null;
      }
      replayInput = asRecord(sourceExecution.input);
      replayNodeOutputs = extractNodeOutputsFromResults(sourceExecution.nodeResults);
    }

    const mergedPayload: ParsedWorkflowExecutePayload = {
      ...replayInput,
      ...payload,
      input: payload.input ?? asRecord(replayInput.input),
      variables: payload.variables ?? asRecord(replayInput.variables),
      system_prompt:
        payload.system_prompt ??
        (typeof replayInput.system_prompt === "string" ? replayInput.system_prompt : undefined),
      user_prompt:
        payload.user_prompt ??
        (typeof replayInput.user_prompt === "string" ? replayInput.user_prompt : undefined),
      sessionId:
        payload.sessionId ??
        (typeof replayInput.sessionId === "string" ? replayInput.sessionId : undefined),
      session_id:
        payload.session_id ??
        (typeof replayInput.session_id === "string" ? replayInput.session_id : undefined),
      executionTimeoutMs:
        payload.executionTimeoutMs ??
        (typeof replayInput.executionTimeoutMs === "number" ? replayInput.executionTimeoutMs : undefined),
      execution_timeout_ms:
        payload.execution_timeout_ms ??
        (typeof replayInput.execution_timeout_ms === "number" ? replayInput.execution_timeout_ms : undefined),
      customData: payload.customData ?? asRecord(replayInput.customData),
      nodeOutputs: {
        ...replayNodeOutputs,
        ...asRecord(payload.nodeOutputs)
      }
    };

    return {
      payload: mergedPayload,
      nodeOutputs: asRecord(mergedPayload.nodeOutputs),
      requestInput: {
        ...mergedPayload,
        replayedFromExecutionId: sourceExecutionId
      }
    };
  };

  const executeScheduledWorkflow = async (input: {
    workflowId: string;
    workflowName: string;
    scheduleNodeId: string;
    cronExpression: string;
    timezone: string;
    firedAt: string;
  }) => {
    const workflow = store.getWorkflow(input.workflowId);
    if (!workflow) {
      app.log.warn(
        {
          workflowId: input.workflowId,
          scheduleNodeId: input.scheduleNodeId
        },
        "Skipped scheduled execution because workflow was not found"
      );
      return;
    }

    const executionId = crypto.randomUUID();
    const requestInput = {
      triggerType: "cron",
      scheduleNodeId: input.scheduleNodeId,
      cronExpression: input.cronExpression,
      timezone: input.timezone,
      firedAt: input.firedAt
    } as const;

    const result = await runWorkflowExecution({
      workflow,
      directInput: {
        trigger_type: "cron",
        scheduled_at: input.firedAt,
        schedule_node_id: input.scheduleNodeId,
        cron_expression: input.cronExpression,
        timezone: input.timezone
      },
      executionId,
      triggerType: "cron",
      triggeredBy: "scheduler"
    });

    persistExecutionHistory({
      executionId,
      workflow,
      result,
      triggerType: "cron",
      triggeredBy: "scheduler",
      requestInput
    });

    if (result.status === "error") {
      app.log.warn(
        {
          workflowId: workflow.id,
          executionId,
          error: result.error
        },
        "Scheduled execution completed with error"
      );
    }
  };

  if (schedulerService) {
    schedulerService.setExecutionHandler((input) => executeScheduledWorkflow(input));
    app.addHook("onClose", async () => {
      schedulerService.stop();
    });
  }

  const executeTriggeredWorkflow = async (input: {
    workflow: Workflow;
    node: { id: string; type: string };
    triggerType: string;
    input: Record<string, unknown>;
  }) => {
    const executionId = crypto.randomUUID();
    const progressHooks = createProgressTrackingHooks({
      executionId,
      workflow: input.workflow,
      triggerType: input.triggerType,
      triggeredBy: "trigger-service",
      requestInput: input.input
    });
    const result = await runWorkflowExecution({
      workflow: input.workflow,
      directInput: {
        trigger_type: input.triggerType,
        trigger_node_id: input.node.id,
        ...input.input
      },
      executionId,
      triggerType: input.triggerType,
      triggeredBy: "trigger-service",
      hooks: progressHooks
    });
    persistExecutionHistory({
      executionId,
      workflow: input.workflow,
      result,
      triggerType: input.triggerType,
      triggeredBy: "trigger-service",
      requestInput: input.input
    });
  };

  if (triggerService) {
    triggerService.setExecutionHandler(async (payload) => executeTriggeredWorkflow(payload));
    triggerService.setSecretResolver((ref) => secretService.resolveSecret(ref));
    app.addHook("onClose", async () => {
      await triggerService.stop();
    });
  }

  const rolePriority: Record<UserRole, number> = {
    viewer: 1,
    operator: 2,
    builder: 3,
    admin: 4
  };

  const hasRequiredRole = (user: SafeUser, allowedRoles: UserRole[]) => {
    return allowedRoles.some((role) => rolePriority[user.role] >= rolePriority[role]);
  };

  const apiKeyService = new ApiKeyService(store, config.API_KEY_DEFAULT_EXPIRY_DAYS);
  const mfaService = new MfaService(store, config.SECRET_MASTER_KEY_BASE64, config.MFA_ISSUER);
  const rbacService = new RbacService(store);
  const externalSecretsService = new ExternalSecretsService(store);
  const variablesService = new VariablesService(store);
  const workflowVersionService = new WorkflowVersionService(store, config.WORKFLOW_VERSION_RETENTION);
  const gitSyncService = new GitSyncService(store, secretService, variablesService, {
    workdirRoot: config.GIT_SYNC_WORKDIR,
    gitBin: config.GIT_BIN,
    commandTimeoutMs: config.GIT_COMMAND_TIMEOUT_MS,
    enabled: config.GIT_SYNC_ENABLED
  });
  const workerMode = config.WORKER_MODE;
  const runsBackgroundWorkers = workerMode === "all" || workerMode === "worker";
  const leaderElection = new LeaderElectionService(
    store,
    {
      enabled: config.HA_ENABLED,
      instanceId: config.HA_INSTANCE_ID,
      leaseTtlMs: config.HA_LEASE_TTL_MS,
      renewIntervalMs: config.HA_RENEW_INTERVAL_MS,
      onBecomeLeader: () => {
        if (!runsBackgroundWorkers) return;
        try {
          schedulerService?.initialize();
          triggerService?.initialize();
          app.log.info({ instanceId: leaderElection.getInstanceId() }, "Acquired leader lease — scheduler + trigger services started");
        } catch (err) {
          app.log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "Failed to start leader-gated services"
          );
        }
      },
      onResignLeader: () => {
        if (!runsBackgroundWorkers) return;
        try {
          schedulerService?.stop();
          void triggerService?.stop();
          app.log.info({ instanceId: leaderElection.getInstanceId() }, "Resigned leader lease — scheduler + trigger services stopped");
        } catch {
          // ignore
        }
      }
    },
    "primary"
  );
  const metricsService = new MetricsService({
    enabled: config.METRICS_ENABLED,
    prefix: config.METRICS_PREFIX,
    includeProcess: config.METRICS_INCLUDE_PROCESS,
    sloSuccessTarget: config.METRICS_SLO_SUCCESS_TARGET,
    sloP95LatencyMs: config.METRICS_SLO_P95_LATENCY_MS
  });
  const tracingService = new TracingService({
    enabled: config.TRACING_ENABLED,
    endpoint: config.TRACING_ENDPOINT,
    serviceName: config.TRACING_SERVICE_NAME
  });
  secretService.attachExternalSecrets(externalSecretsService);
  const auditService = new AuditService(store, { enabled: config.AUDIT_LOG_ENABLED });
  const logStreamingService = new LogStreamingService(store, config.SECRET_MASTER_KEY_BASE64, {
    enabled: config.LOG_STREAM_ENABLED,
    flushIntervalMs: config.LOG_STREAM_FLUSH_INTERVAL_MS,
    bufferSize: config.LOG_STREAM_BUFFER_SIZE,
    retryMaxAttempts: config.LOG_STREAM_RETRY_MAX_ATTEMPTS,
    eventRetentionDays: config.LOG_STREAM_EVENT_RETENTION_DAYS,
    eventPruneIntervalMs: config.LOG_STREAM_EVENT_PRUNE_INTERVAL_MS
  });
  logStreamingService.start();
  app.addHook("onClose", async () => {
    await logStreamingService.stop();
  });

  const pruneAuditLogs = (reason: "startup" | "interval") => {
    const retentionDays = config.AUDIT_LOG_RETENTION_DAYS;
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    try {
      const deleted = auditService.purge({ before: cutoff });
      if (deleted > 0) {
        app.log.info({ deleted, cutoff, retentionDays, reason }, "Pruned audit logs");
      }
      return deleted;
    } catch (err) {
      app.log.warn(
        { err: err instanceof Error ? err.message : String(err), reason },
        "Failed to prune audit logs"
      );
      return 0;
    }
  };
  pruneAuditLogs("startup");
  const auditRetentionTimer = config.AUDIT_LOG_RETENTION_DAYS > 0
    ? setInterval(() => pruneAuditLogs("interval"), config.AUDIT_LOG_PRUNE_INTERVAL_MS)
    : null;
  if (auditRetentionTimer) {
    const t = auditRetentionTimer as { unref?: () => void };
    t.unref?.();
    app.addHook("onClose", async () => {
      clearInterval(auditRetentionTimer);
    });
  }

  const extractIpAndUa = (request: { ip?: string; headers: Record<string, unknown> }) => {
    const forwarded = request.headers["x-forwarded-for"];
    const ipAddress =
      (typeof forwarded === "string" && forwarded.split(",")[0]?.trim()) ||
      (Array.isArray(forwarded) && typeof forwarded[0] === "string" ? forwarded[0] : "") ||
      request.ip ||
      null;
    const uaHeader = request.headers["user-agent"];
    const userAgent =
      typeof uaHeader === "string"
        ? uaHeader
        : Array.isArray(uaHeader) && typeof uaHeader[0] === "string"
          ? uaHeader[0]
          : null;
    return { ipAddress: ipAddress || null, userAgent };
  };

  const buildActor = (
    request: { ip?: string; headers: Record<string, unknown> },
    user?: SafeUser | null,
    overrides?: Partial<AuditActor>
  ): AuditActor => {
    const { ipAddress, userAgent } = extractIpAndUa(request);
    return {
      userId: user?.id ?? null,
      email: user?.email ?? null,
      type: request.headers["authorization"] ? "api_key" : "user",
      ipAddress,
      userAgent,
      ...overrides
    };
  };

  const audit = (
    request: { ip?: string; headers: Record<string, unknown> },
    user: SafeUser | null,
    event: Omit<AuditEventInput, "actor"> & { actor?: Partial<AuditActor> }
  ) => {
    const actor = buildActor(request, user, event.actor);
    const full = { ...event, actor };
    auditService.record(full);
    logStreamingService.dispatchAudit(full);
  };
  const samlService = new SamlService(store, {
    enabled: config.SAML_ENABLED,
    entryPoint: config.SAML_ENTRY_POINT,
    issuer: config.SAML_ISSUER,
    callbackUrl: config.SAML_CALLBACK_URL,
    idpCert: config.SAML_IDP_CERT,
    groupsAttribute: config.SAML_GROUPS_ATTRIBUTE
  });
  const ldapService = new LdapService(store, {
    enabled: config.LDAP_ENABLED,
    url: config.LDAP_URL,
    bindDn: config.LDAP_BIND_DN,
    bindPassword: config.LDAP_BIND_PASSWORD,
    baseDn: config.LDAP_BASE_DN,
    userFilter: config.LDAP_USER_FILTER,
    groupsAttribute: config.LDAP_GROUPS_ATTRIBUTE
  });

  const pendingMfaChallenges = new Map<string, { userId: string; createdAt: number }>();
  const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;

  const issueMfaChallenge = (userId: string): string => {
    for (const [key, entry] of pendingMfaChallenges.entries()) {
      if (Date.now() - entry.createdAt > MFA_CHALLENGE_TTL_MS) {
        pendingMfaChallenges.delete(key);
      }
    }
    const challengeId = `mfa_${crypto.randomUUID()}`;
    pendingMfaChallenges.set(challengeId, { userId, createdAt: Date.now() });
    return challengeId;
  };

  const consumeMfaChallenge = (challengeId: string): string | null => {
    const entry = pendingMfaChallenges.get(challengeId);
    if (!entry) return null;
    pendingMfaChallenges.delete(challengeId);
    if (Date.now() - entry.createdAt > MFA_CHALLENGE_TTL_MS) return null;
    return entry.userId;
  };

  const getSessionIdFromRequest = (request: { cookies: Record<string, string | undefined> }) => {
    return request.cookies[config.SESSION_COOKIE_NAME] ?? "";
  };

  const extractBearerToken = (headers: Record<string, unknown>): string | null => {
    const raw = headers["authorization"];
    const value = typeof raw === "string" ? raw : Array.isArray(raw) ? String(raw[0]) : "";
    if (!value) return null;
    const match = value.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : null;
  };

  const authenticateApiKey = (headers: Record<string, unknown>): SafeUser | null => {
    const token = extractBearerToken(headers);
    if (!token) return null;
    const verified = apiKeyService.verify(token);
    if (!verified) return null;
    const user = store.getUserById(verified.userId);
    if (!user) return null;
    return {
      id: user.id,
      email: user.email,
      role:
        user.role === "admin" || user.role === "builder" || user.role === "operator" || user.role === "viewer"
          ? user.role
          : "viewer"
    };
  };

  const setSessionCookie = (reply: FastifyReply, sessionId: string) => {
    reply.setCookie(config.SESSION_COOKIE_NAME, sessionId, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: config.COOKIE_SECURE,
      maxAge: config.SESSION_TTL_HOURS * 60 * 60
    });
  };

  const clearSessionCookie = (reply: FastifyReply) => {
    reply.clearCookie(config.SESSION_COOKIE_NAME, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: config.COOKIE_SECURE
    });
  };

  const deny = (reply: FastifyReply, code: 401 | 403, message: string) => {
    reply.code(code).send({ error: message });
  };

  const requireRole = async (
    request: { cookies: Record<string, string | undefined>; headers: Record<string, unknown> },
    reply: FastifyReply,
    allowedRoles: UserRole[]
  ): Promise<SafeUser | null> => {
    // Allow API key authentication (Phase 5.1) as a first-class alternative to session cookies.
    const apiKeyUser = authenticateApiKey(request.headers as Record<string, unknown>);
    if (apiKeyUser) {
      if (!hasRequiredRole(apiKeyUser, allowedRoles)) {
        deny(reply, 403, "Insufficient permissions");
        return null;
      }
      return apiKeyUser;
    }

    const sessionId = getSessionIdFromRequest(request);
    if (!sessionId) {
      deny(reply, 401, "Authentication required");
      return null;
    }

    const user = authService.getSessionUser(sessionId);
    if (!user) {
      clearSessionCookie(reply);
      deny(reply, 401, "Session expired or invalid");
      return null;
    }

    if (!hasRequiredRole(user, allowedRoles)) {
      deny(reply, 403, "Insufficient permissions");
      return null;
    }

    return user;
  };

  const requirePermission = async (
    request: { cookies: Record<string, string | undefined>; headers: Record<string, unknown> },
    reply: FastifyReply,
    projectId: string,
    permission: Permission
  ): Promise<SafeUser | null> => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return null;
    if (!rbacService.can(user, projectId, permission)) {
      deny(reply, 403, `Permission '${permission}' required in project '${projectId}'`);
      return null;
    }
    return user;
  };

  const provisionSsoUser = (input: {
    provider: "saml" | "ldap";
    subject: string;
    email: string;
    groups: string[];
  }): { user: SafeUser; created: boolean } => {
    const normalizedEmail = input.email.trim().toLowerCase();
    let storeUser = store.getUserByEmail(normalizedEmail);
    let created = false;

    // Determine global role: group-mapped role > default viewer.
    const mappedGlobalRole =
      input.provider === "saml"
        ? samlService.resolveGlobalRole(input.groups)
        : ldapService.resolveGlobalRole(input.groups);
    const desiredRole: UserRole = mappedGlobalRole ?? "viewer";

    if (!storeUser) {
      const id = `usr_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const randomPassword = crypto.randomBytes(24).toString("base64url");
      // Register with the normal register flow so password hashing is consistent.
      const registered = authService.register({
        email: normalizedEmail,
        password: randomPassword,
        role: desiredRole
      });
      storeUser = store.getUserById(registered.id);
      created = true;
    } else if (mappedGlobalRole && storeUser.role !== mappedGlobalRole) {
      // Update role when SSO group mapping indicates a change (do NOT downgrade admins unless explicitly mapped).
      const currentPriority = rolePriority[(storeUser.role as UserRole) ?? "viewer"] ?? 1;
      const targetPriority = rolePriority[mappedGlobalRole];
      if (targetPriority >= currentPriority) {
        store.saveUser({
          id: storeUser.id,
          email: storeUser.email,
          passwordHash: storeUser.passwordHash,
          role: mappedGlobalRole
        });
        storeUser = store.getUserById(storeUser.id);
      }
    }

    if (!storeUser) {
      throw new Error("Failed to provision SSO user");
    }

    // Apply project-level role assignments from group mappings.
    const projectAssignments =
      input.provider === "saml"
        ? samlService.listProjectRoleAssignments(input.groups)
        : ldapService.listProjectRoleAssignments(input.groups);
    for (const assignment of projectAssignments) {
      const project = store.getProject(assignment.projectId);
      if (!project) continue;
      try {
        rbacService.addMember({
          userId: storeUser.id,
          projectId: assignment.projectId,
          role: isProjectRole(assignment.role) ? assignment.role : "custom",
          customRoleId: assignment.customRoleId
        });
      } catch {
        // Ignore mapping errors (e.g., unknown custom role); continue provisioning others.
      }
    }

    // Persist SSO identity linkage.
    if (input.provider === "saml") {
      samlService.recordIdentity(storeUser.id, {
        nameId: input.subject,
        email: normalizedEmail,
        groups: input.groups,
        attributes: {}
      });
    } else {
      store.upsertSsoIdentity({
        id: `sso_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
        userId: storeUser.id,
        provider: "ldap",
        subject: input.subject,
        email: normalizedEmail
      });
    }

    const user: SafeUser = {
      id: storeUser.id,
      email: storeUser.email,
      role:
        storeUser.role === "admin" ||
        storeUser.role === "builder" ||
        storeUser.role === "operator" ||
        storeUser.role === "viewer"
          ? storeUser.role
          : "viewer"
    };
    return { user, created };
  };

  const issueSessionForUser = (user: SafeUser, reply: FastifyReply): { expiresAt: string } => {
    const expiresAtDate = new Date();
    expiresAtDate.setHours(expiresAtDate.getHours() + config.SESSION_TTL_HOURS);
    const expiresAt = expiresAtDate.toISOString();
    const sessionId = `sess_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomBytes(6).toString("hex")}`;
    store.saveSession({ id: sessionId, userId: user.id, expiresAt });
    setSessionCookie(reply, sessionId);
    return { expiresAt };
  };

  const allowedOrigins = parseConfiguredOrigins(config.WEB_ORIGIN);

  app.register(cors, {
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }

      if (allowedOrigins.has(origin) || isLocalDevOrigin(origin) || origin === "null") {
        callback(null, true);
        return;
      }

      app.log.warn({ origin }, "CORS origin rejected");
      callback(null, false);
    },
    credentials: true
  });

  app.register(cookie);
  app.register(fastifyRawBody, {
    field: "rawBody",
    global: false,
    encoding: "utf8",
    runFirst: true
  });

  // Phase 5.7 — HTTP metrics hook
  app.addHook("onResponse", async (request, reply) => {
    const elapsed = reply.elapsedTime ?? 0;
    metricsService.recordHttpRequest(request.method, reply.statusCode, elapsed);
  });

  app.get("/health", async () => {
    const slo = metricsService.getSloStatus();
    return {
      ok: true,
      now: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      sloHealthy: slo.healthy
    };
  });

  app.get("/metrics", async (_request, reply) => {
    reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8");
    return metricsService.formatPrometheus();
  });

  app.get("/api/observability", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    return {
      metrics: metricsService.getSnapshot(),
      tracing: { enabled: tracingService.isEnabled() }
    };
  });

  app.get("/api/observability/slo", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    return metricsService.getSloStatus();
  });

  app.get("/api/observability/traces", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const query = request.query as { traceId?: string; limit?: string } | undefined;
    if (query?.traceId) {
      return { spans: tracingService.spansByTrace(query.traceId) };
    }
    const limit = Math.min(200, Math.max(1, Number(query?.limit ?? 50)));
    return { spans: tracingService.recentSpans(limit) };
  });

  // Phase 7.1 — HA status
  app.get("/api/ha/status", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    return {
      workerMode,
      leader: leaderElection.getStatus(),
      leases: store.listLeases()
    };
  });

  app.addHook("onReady", async () => {
    await leaderElection.start();
  });
  app.addHook("onClose", async () => {
    await leaderElection.stop();
  });

  app.get("/widget.js", async (_request, reply) => {
    const widgetBundlePath = resolveWidgetBundlePath();
    if (!fs.existsSync(widgetBundlePath)) {
      reply.code(404);
      return {
        error: "widget.js is not available. Build apps/web in widget mode first."
      };
    }

    const bundle = fs.readFileSync(widgetBundlePath, "utf8");
    reply.header("content-type", "application/javascript; charset=utf-8");
    reply.header("cache-control", "public, max-age=300");
    reply.header("Access-Control-Allow-Origin", "*");
    return reply.send(bundle);
  });

  app.get("/helper-chat", async (_request, reply) => {
    const helperChatPagePath = resolveHelperChatPagePath();
    if (!fs.existsSync(helperChatPagePath)) {
      reply.code(404);
      return {
        error: "helper-chat page is not available."
      };
    }

    const html = fs.readFileSync(helperChatPagePath, "utf8");
    reply.header("content-type", "text/html; charset=utf-8");
    reply.header("cache-control", "no-store");
    return reply.send(html);
  });

  app.post<{ Body: unknown }>("/api/auth/register", async (request, reply) => {
    const parsed = authRegisterSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid registration payload",
        details: parsed.error.issues
      };
    }

    const existingUsers = authService.countUsers();
    let actor: SafeUser | null = null;

    if (existingUsers > 0 && !config.AUTH_ALLOW_PUBLIC_REGISTER) {
      actor = await requireRole(request, reply, ["admin"]);
      if (!actor) {
        return;
      }
    } else if (existingUsers > 0 && config.AUTH_ALLOW_PUBLIC_REGISTER) {
      actor = authService.getSessionUser(getSessionIdFromRequest(request));
    }

    const requestedRole: UserRole = parsed.data.role ?? (parsed.data.admin ? "admin" : "viewer");
    let role: UserRole = requestedRole;
    if (existingUsers === 0) {
      role = parsed.data.role ?? "admin";
    } else if (!actor) {
      role = "viewer";
    } else if (role === "admin" && actor.role !== "admin") {
      reply.code(403);
      return { error: "Only admins can create admin users" };
    }

    try {
      const user = authService.register({
        email: parsed.data.email,
        password: parsed.data.password,
        role
      });
      audit(request, actor ?? null, {
        category: "auth",
        eventType: "user.register",
        action: "register",
        resourceType: "user",
        resourceId: user.id,
        metadata: { email: user.email, role: user.role, actorEmail: actor?.email }
      });
      return { user };
    } catch (error) {
      audit(request, actor ?? null, {
        category: "auth",
        eventType: "user.register",
        action: "register",
        outcome: "failure",
        metadata: { email: parsed.data.email, error: error instanceof Error ? error.message : String(error) }
      });
      reply.code(400);
      return {
        error: error instanceof Error ? error.message : "Registration failed"
      };
    }
  });

  app.post<{ Body: unknown }>("/api/auth/login", async (request, reply) => {
    const parsed = authLoginSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid login payload",
        details: parsed.error.issues
      };
    }

    try {
      const result = authService.login(parsed.data.email, parsed.data.password);
      // MFA gate: if the user has MFA enabled (or MFA_ENFORCE is on for admin), require a challenge step.
      const mfaStatus = mfaService.status(result.user.id);
      const mustProvideMfa = mfaStatus.enabled || (config.MFA_ENFORCE && result.user.role === "admin");
      if (mustProvideMfa) {
        if (!mfaStatus.enabled) {
          // MFA enforced but not enrolled — still issue the session so user can enrol immediately,
          // but flag it so the UI can redirect to the MFA enrolment flow.
          setSessionCookie(reply, result.sessionId);
          audit(request, result.user, {
            category: "auth",
            eventType: "user.login",
            action: "login",
            resourceType: "user",
            resourceId: result.user.id,
            metadata: { mfaEnrollmentRequired: true }
          });
          return {
            user: result.user,
            expiresAt: result.expiresAt,
            mfaEnrollmentRequired: true
          };
        }
        // Revoke the freshly-created session and exchange it for a short-lived MFA challenge token.
        store.revokeSession(result.sessionId);
        const challengeId = issueMfaChallenge(result.user.id);
        audit(request, result.user, {
          category: "auth",
          eventType: "user.login.mfa_challenge",
          action: "login",
          resourceType: "user",
          resourceId: result.user.id,
          metadata: { mfaChallengeIssued: true }
        });
        reply.code(200);
        return {
          mfaChallenge: challengeId,
          expiresInSeconds: Math.floor(MFA_CHALLENGE_TTL_MS / 1000)
        };
      }
      setSessionCookie(reply, result.sessionId);
      audit(request, result.user, {
        category: "auth",
        eventType: "user.login",
        action: "login",
        resourceType: "user",
        resourceId: result.user.id
      });
      return {
        user: result.user,
        expiresAt: result.expiresAt
      };
    } catch (error) {
      audit(request, null, {
        category: "auth",
        eventType: "user.login",
        action: "login",
        outcome: "failure",
        metadata: { email: parsed.data.email, error: error instanceof Error ? error.message : String(error) }
      });
      reply.code(401);
      return {
        error: error instanceof Error ? error.message : "Invalid credentials"
      };
    }
  });

  app.post<{ Body: unknown }>("/api/auth/login/mfa", async (request, reply) => {
    const body = asRecord(request.body);
    const challengeId = typeof body.challenge === "string" ? body.challenge : "";
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!challengeId || !code) {
      reply.code(400);
      return { error: "challenge and code are required" };
    }
    const userId = consumeMfaChallenge(challengeId);
    if (!userId) {
      reply.code(401);
      return { error: "MFA challenge expired or invalid" };
    }
    if (!mfaService.verify(userId, code)) {
      reply.code(401);
      return { error: "Invalid MFA code" };
    }
    const storeUser = store.getUserById(userId);
    if (!storeUser) {
      reply.code(401);
      return { error: "User not found" };
    }
    const safeUser: SafeUser = {
      id: storeUser.id,
      email: storeUser.email,
      role:
        storeUser.role === "admin" ||
        storeUser.role === "builder" ||
        storeUser.role === "operator" ||
        storeUser.role === "viewer"
          ? storeUser.role
          : "viewer"
    };
    const { expiresAt } = issueSessionForUser(safeUser, reply);
    return { user: safeUser, expiresAt };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const sessionId = getSessionIdFromRequest(request);
    const sessionUser = sessionId ? authService.getSessionUser(sessionId) : null;
    if (sessionId) {
      authService.logout(sessionId);
    }
    clearSessionCookie(reply);
    if (sessionUser) {
      audit(request, sessionUser, {
        category: "auth",
        eventType: "user.logout",
        action: "logout",
        resourceType: "user",
        resourceId: sessionUser.id
      });
    }
    return { ok: true };
  });

  app.get("/api/auth/me", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) {
      return;
    }
    const mfa = mfaService.status(user.id);
    const memberships = rbacService.listUserProjects(user.id);
    return { user, mfa, memberships };
  });

  // ---------------------------------------------------------------------------
  // Phase 5.1 — MFA (TOTP)
  // ---------------------------------------------------------------------------

  app.get("/api/auth/mfa/status", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    return mfaService.status(user.id);
  });

  app.post("/api/auth/mfa/enroll", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    const existing = mfaService.status(user.id);
    if (existing.enabled) {
      reply.code(409);
      return { error: "MFA is already enabled for this account. Disable it first to re-enrol." };
    }
    const enrollment = mfaService.enroll(user.id, user.email);
    audit(request, user, {
      category: "mfa",
      eventType: "mfa.enroll",
      action: "enroll",
      resourceType: "user",
      resourceId: user.id
    });
    return {
      secret: enrollment.secret,
      otpauthUrl: enrollment.otpauthUrl,
      backupCodes: enrollment.backupCodes
    };
  });

  app.post<{ Body: unknown }>("/api/auth/mfa/activate", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    const body = asRecord(request.body);
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!code) {
      reply.code(400);
      return { error: "code is required" };
    }
    const ok = mfaService.activate(user.id, code);
    if (!ok) {
      audit(request, user, {
        category: "mfa",
        eventType: "mfa.activate",
        action: "activate",
        outcome: "failure",
        resourceType: "user",
        resourceId: user.id
      });
      reply.code(401);
      return { error: "Invalid activation code" };
    }
    audit(request, user, {
      category: "mfa",
      eventType: "mfa.activate",
      action: "activate",
      resourceType: "user",
      resourceId: user.id
    });
    return { enabled: true };
  });

  app.post<{ Body: unknown }>("/api/auth/mfa/disable", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    const body = asRecord(request.body);
    const code = typeof body.code === "string" ? body.code.trim() : "";
    const status = mfaService.status(user.id);
    if (status.enabled) {
      if (!code || !mfaService.verify(user.id, code)) {
        reply.code(401);
        return { error: "A valid MFA code is required to disable MFA" };
      }
    }
    mfaService.disable(user.id);
    audit(request, user, {
      category: "mfa",
      eventType: "mfa.disable",
      action: "disable",
      resourceType: "user",
      resourceId: user.id
    });
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // Phase 5.1 — API keys
  // ---------------------------------------------------------------------------

  const apiKeyCreateSchema = z.object({
    name: z.string().min(1).max(120),
    scopes: z.array(z.string().min(1).max(64)).optional(),
    expiresInDays: z.number().int().nonnegative().optional()
  });

  app.get("/api/auth/api-keys", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    const keys = user.role === "admin" ? apiKeyService.list() : apiKeyService.list(user.id);
    return { keys };
  });

  app.post<{ Body: unknown }>("/api/auth/api-keys", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const parsed = apiKeyCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid API key payload", details: parsed.error.issues };
    }
    const { plaintext, record } = apiKeyService.create({
      userId: user.id,
      name: parsed.data.name,
      scopes: parsed.data.scopes,
      expiresInDays: parsed.data.expiresInDays ?? null
    });
    audit(request, user, {
      category: "api_key",
      eventType: "api_key.create",
      action: "create",
      resourceType: "api_key",
      resourceId: record.id,
      metadata: { name: record.name, scopes: record.scopes, keyPrefix: record.keyPrefix }
    });
    return {
      key: plaintext,
      record
    };
  });

  app.delete<{ Params: { id: string } }>("/api/auth/api-keys/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    const ok = apiKeyService.revoke(request.params.id, user.role === "admin" ? undefined : user.id);
    if (!ok) {
      reply.code(404);
      return { error: "API key not found" };
    }
    audit(request, user, {
      category: "api_key",
      eventType: "api_key.revoke",
      action: "revoke",
      resourceType: "api_key",
      resourceId: request.params.id
    });
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // Phase 5.1 — SAML SSO
  // ---------------------------------------------------------------------------

  app.get("/api/auth/saml/metadata", async (_request, reply) => {
    if (!config.SAML_ENABLED) {
      reply.code(404);
      return { error: "SAML is not enabled" };
    }
    return {
      enabled: config.SAML_ENABLED,
      ready: samlService.isReady(),
      entryPoint: config.SAML_ENTRY_POINT,
      issuer: config.SAML_ISSUER,
      callbackUrl: config.SAML_CALLBACK_URL,
      groupsAttribute: config.SAML_GROUPS_ATTRIBUTE
    };
  });

  app.get("/api/auth/saml/login", async (_request, reply) => {
    try {
      const redirectUrl = await samlService.buildLoginUrl();
      reply.redirect(redirectUrl);
    } catch (error) {
      reply.code(503);
      return {
        error: error instanceof Error ? error.message : "SAML login is not available"
      };
    }
  });

  app.post<{ Body: unknown }>("/api/auth/saml/callback", async (request, reply) => {
    const body = asRecord(request.body);
    const samlResponse = typeof body.SAMLResponse === "string" ? body.SAMLResponse : "";
    if (!samlResponse) {
      reply.code(400);
      return { error: "SAMLResponse is required" };
    }
    try {
      const profile: SamlAssertionProfile = await samlService.consumeAssertion(samlResponse);
      const email = profile.email ?? profile.nameId;
      if (!email) {
        reply.code(400);
        return { error: "SAML assertion did not include an email or nameId" };
      }
      const { user, created } = provisionSsoUser({
        provider: "saml",
        subject: profile.nameId,
        email,
        groups: profile.groups
      });
      const { expiresAt } = issueSessionForUser(user, reply);
      return { user, expiresAt, provisioned: created };
    } catch (error) {
      reply.code(401);
      return {
        error: error instanceof Error ? error.message : "SAML assertion failed"
      };
    }
  });

  // ---------------------------------------------------------------------------
  // Phase 5.1 — LDAP login
  // ---------------------------------------------------------------------------

  app.post<{ Body: unknown }>("/api/auth/ldap/login", async (request, reply) => {
    const body = asRecord(request.body);
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!email || !password) {
      reply.code(400);
      return { error: "email and password are required" };
    }
    try {
      const profile = await ldapService.authenticate(email, password);
      const { user, created } = provisionSsoUser({
        provider: "ldap",
        subject: profile.dn || profile.email,
        email: profile.email,
        groups: profile.groups
      });
      const { expiresAt } = issueSessionForUser(user, reply);
      return { user, expiresAt, provisioned: created };
    } catch (error) {
      const err = error as Error & { code?: string };
      reply.code(err.code === "CONFIGURATION_ERROR" ? 503 : 401);
      return { error: err.message };
    }
  });

  // ---------------------------------------------------------------------------
  // Phase 5.1 — SSO group-to-role mappings
  // ---------------------------------------------------------------------------

  const ssoMappingSchema = z.object({
    provider: z.enum(["saml", "ldap"]),
    groupName: z.string().min(1).max(200),
    projectId: z.string().min(1).max(120).nullable().optional(),
    role: z.string().min(1).max(60),
    customRoleId: z.string().min(1).max(120).nullable().optional()
  });

  app.get<{ Querystring: { provider?: string } }>("/api/auth/sso/mappings", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const provider = typeof request.query?.provider === "string" ? request.query.provider : undefined;
    return { mappings: rbacService.listSsoGroupMappings(provider) };
  });

  app.post<{ Body: unknown }>("/api/auth/sso/mappings", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const parsed = ssoMappingSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid SSO mapping payload", details: parsed.error.issues };
    }
    const id = rbacService.upsertSsoGroupMapping({
      provider: parsed.data.provider,
      groupName: parsed.data.groupName,
      projectId: parsed.data.projectId ?? null,
      role: parsed.data.role,
      customRoleId: parsed.data.customRoleId ?? null
    });
    return { id };
  });

  app.delete<{ Params: { id: string } }>("/api/auth/sso/mappings/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const ok = rbacService.deleteSsoGroupMapping(request.params.id);
    if (!ok) {
      reply.code(404);
      return { error: "SSO mapping not found" };
    }
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // Phase 5.3 — External secret providers
  // ---------------------------------------------------------------------------

  const externalProviderTypeSchema = z.enum([
    "aws-secrets-manager",
    "hashicorp-vault",
    "google-secret-manager",
    "azure-key-vault",
    "mock"
  ]);

  const externalProviderCreateSchema = z.object({
    name: z.string().min(1).max(120),
    type: externalProviderTypeSchema,
    config: z.record(z.string(), z.unknown()).default({}),
    credentialsSecretId: z.string().min(1).max(120).nullable().optional(),
    cacheTtlMs: z.number().int().nonnegative().max(86_400_000).optional()
  });

  const externalProviderUpdateSchema = externalProviderCreateSchema
    .partial()
    .extend({ enabled: z.boolean().optional() });

  app.get("/api/external-providers", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    return { providers: externalSecretsService.listProviders() };
  });

  app.post<{ Body: unknown }>("/api/external-providers", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const parsed = externalProviderCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid external provider payload", details: parsed.error.issues };
    }
    if (parsed.data.credentialsSecretId) {
      const credRow = store.getSecret(parsed.data.credentialsSecretId);
      if (!credRow) {
        reply.code(400);
        return { error: "credentialsSecretId does not exist" };
      }
      if (credRow.source === "external") {
        reply.code(400);
        return { error: "credentialsSecretId must reference a local secret, not another external secret" };
      }
    }
    try {
      const id = externalSecretsService.createProvider({
        name: parsed.data.name,
        type: parsed.data.type,
        config: parsed.data.config ?? {},
        credentialsSecretId: parsed.data.credentialsSecretId ?? null,
        cacheTtlMs: parsed.data.cacheTtlMs ?? config.EXTERNAL_SECRETS_CACHE_TTL_MS,
        createdBy: user.email
      });
      audit(request, user, {
        category: "external_secret",
        eventType: "external_provider.create",
        action: "create",
        resourceType: "external_provider",
        resourceId: id,
        metadata: { name: parsed.data.name, type: parsed.data.type }
      });
      return { id, provider: externalSecretsService.getProvider(id) };
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : "Failed to create external provider" };
    }
  });

  app.put<{ Params: { id: string }; Body: unknown }>(
    "/api/external-providers/:id",
    async (request, reply) => {
      const user = await requireRole(request, reply, ["admin"]);
      if (!user) return;
      const parsed = externalProviderUpdateSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "Invalid provider payload", details: parsed.error.issues };
      }
      const ok = externalSecretsService.updateProvider(request.params.id, {
        name: parsed.data.name,
        config: parsed.data.config,
        credentialsSecretId: parsed.data.credentialsSecretId ?? null,
        cacheTtlMs: parsed.data.cacheTtlMs,
        enabled: parsed.data.enabled
      });
      if (!ok) {
        reply.code(404);
        return { error: "External provider not found" };
      }
      audit(request, user, {
        category: "external_secret",
        eventType: "external_provider.update",
        action: "update",
        resourceType: "external_provider",
        resourceId: request.params.id
      });
      return { provider: externalSecretsService.getProvider(request.params.id) };
    }
  );

  app.delete<{ Params: { id: string } }>("/api/external-providers/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const result = externalSecretsService.deleteProvider(request.params.id);
    if (!result.ok) {
      reply.code(result.reason ? 409 : 404);
      return { error: result.reason ?? "External provider not found" };
    }
    audit(request, user, {
      category: "external_secret",
      eventType: "external_provider.delete",
      action: "delete",
      resourceType: "external_provider",
      resourceId: request.params.id
    });
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/external-providers/:id/test",
    async (request, reply) => {
      const user = await requireRole(request, reply, ["admin"]);
      if (!user) return;
      const provider = externalSecretsService.getProvider(request.params.id);
      if (!provider) {
        reply.code(404);
        return { error: "External provider not found" };
      }
      const body = asRecord(request.body);
      const key = typeof body.key === "string" ? body.key.trim() : "";
      if (!key) {
        reply.code(400);
        return { error: "key is required" };
      }
      let credentialValue: string | undefined;
      if (provider.credentialsSecretId) {
        credentialValue = await secretService.resolveSecret({ secretId: provider.credentialsSecretId });
      }
      try {
        const value = await externalSecretsService.resolveExternalSecret({
          provider,
          credentials: credentialValue,
          key
        });
        audit(request, user, {
          category: "external_secret",
          eventType: "external_provider.test",
          action: "test",
          resourceType: "external_provider",
          resourceId: provider.id,
          metadata: { key, length: value.length }
        });
        return { ok: true, length: value.length };
      } catch (err) {
        const e = err as Error & { code?: string };
        audit(request, user, {
          category: "external_secret",
          eventType: "external_provider.test",
          action: "test",
          outcome: "failure",
          resourceType: "external_provider",
          resourceId: provider.id,
          metadata: { key, error: e.message }
        });
        reply.code(e.code === "CONFIGURATION_ERROR" ? 503 : 400);
        return { error: e.message };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Phase 5.4 — Audit log
  // ---------------------------------------------------------------------------

  const auditFilterSchema = z.object({
    category: z.string().optional(),
    eventType: z.string().optional(),
    outcome: z.string().optional(),
    actorUserId: z.string().optional(),
    resourceType: z.string().optional(),
    resourceId: z.string().optional(),
    projectId: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    page: z.coerce.number().int().positive().optional(),
    pageSize: z.coerce.number().int().positive().max(500).optional()
  });

  app.get("/api/audit", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const parsed = auditFilterSchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid audit filter", details: parsed.error.issues };
    }
    return auditService.list(parsed.data);
  });

  app.get("/api/audit/export", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const parsed = auditFilterSchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid audit filter", details: parsed.error.issues };
    }
    const csv = auditService.exportCsv(parsed.data);
    audit(request, user, {
      category: "system",
      eventType: "audit.export",
      action: "export"
    });
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header(
      "content-disposition",
      `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`
    );
    return reply.send(csv);
  });

  // ---------------------------------------------------------------------------
  // Phase 5.5 — Log streaming
  // ---------------------------------------------------------------------------

  const logStreamTypeSchema = z.enum(["syslog", "webhook", "sentry"]);
  const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);
  const logStreamCreateSchema = z.object({
    name: z.string().min(1).max(120),
    type: logStreamTypeSchema,
    enabled: z.boolean().optional(),
    categories: z.array(z.string().min(1).max(60)).optional(),
    minLevel: logLevelSchema.optional(),
    config: z.record(z.string(), z.unknown())
  });
  const logStreamUpdateSchema = z.object({
    name: z.string().min(1).max(120).optional(),
    enabled: z.boolean().optional(),
    categories: z.array(z.string().min(1).max(60)).optional(),
    minLevel: logLevelSchema.optional(),
    config: z.record(z.string(), z.unknown()).optional()
  });

  app.get("/api/log-streams", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    return { destinations: logStreamingService.listDestinations() };
  });

  app.post("/api/log-streams", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const parsed = logStreamCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid log stream destination payload", details: parsed.error.issues };
    }
    try {
      const destination = logStreamingService.createDestination({
        ...parsed.data,
        createdBy: user.id
      });
      audit(request, user, {
        category: "system",
        eventType: "log_stream.destination.create",
        action: "create",
        resourceType: "log_stream_destination",
        resourceId: destination.id,
        metadata: { type: destination.type, name: destination.name }
      });
      return { destination };
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/api/log-streams/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const parsed = logStreamUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid log stream destination payload", details: parsed.error.issues };
    }
    try {
      const destination = logStreamingService.updateDestination(request.params.id, parsed.data);
      if (!destination) {
        reply.code(404);
        return { error: "Log stream destination not found" };
      }
      audit(request, user, {
        category: "system",
        eventType: "log_stream.destination.update",
        action: "update",
        resourceType: "log_stream_destination",
        resourceId: destination.id,
        metadata: { keys: Object.keys(parsed.data) }
      });
      return { destination };
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.delete<{ Params: { id: string } }>("/api/log-streams/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const existing = logStreamingService.getDestination(request.params.id);
    if (!existing) {
      reply.code(404);
      return { error: "Log stream destination not found" };
    }
    logStreamingService.deleteDestination(request.params.id);
    audit(request, user, {
      category: "system",
      eventType: "log_stream.destination.delete",
      action: "delete",
      resourceType: "log_stream_destination",
      resourceId: request.params.id,
      metadata: { type: existing.type, name: existing.name }
    });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/log-streams/:id/test", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const result = await logStreamingService.test(request.params.id);
    audit(request, user, {
      category: "system",
      eventType: "log_stream.destination.test",
      action: "test",
      outcome: result.ok ? "success" : "failure",
      resourceType: "log_stream_destination",
      resourceId: request.params.id,
      metadata: result.ok ? null : { error: result.error }
    });
    if (!result.ok) reply.code(400);
    return result;
  });

  app.get<{ Params: { id: string } }>("/api/log-streams/:id/events", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const existing = logStreamingService.getDestination(request.params.id);
    if (!existing) {
      reply.code(404);
      return { error: "Log stream destination not found" };
    }
    return { events: logStreamingService.listDeliveryEvents(request.params.id, 100) };
  });

  // ---------------------------------------------------------------------------
  // Phase 5.6 — Variables
  // ---------------------------------------------------------------------------

  const variableCreateSchema = z.object({
    projectId: z.string().min(1).max(120),
    key: z.string().min(1).max(120),
    value: z.string().max(65536)
  });
  const variableUpdateSchema = z.object({
    key: z.string().min(1).max(120).optional(),
    value: z.string().max(65536).optional()
  });

  app.get("/api/variables", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    const query = request.query as { projectId?: string } | undefined;
    const projectId = query?.projectId;
    if (projectId) {
      if (user.role !== "admin" && !rbacService.can(user, projectId, "workflow:read")) {
        reply.code(403);
        return { error: "Insufficient permissions for project" };
      }
      return { variables: variablesService.list(projectId) };
    }
    if (user.role !== "admin") {
      reply.code(403);
      return { error: "projectId query parameter required" };
    }
    return { variables: variablesService.list() };
  });

  app.post<{ Body: unknown }>("/api/variables", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const parsed = variableCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid variable payload", details: parsed.error.issues };
    }
    if (user.role !== "admin" && !rbacService.can(user, parsed.data.projectId, "workflow:write")) {
      reply.code(403);
      return { error: "Insufficient permissions to manage variables" };
    }
    try {
      const record = variablesService.create({ ...parsed.data, createdBy: user.id });
      audit(request, user, {
        category: "project",
        eventType: "variable.create",
        action: "create",
        resourceType: "variable",
        resourceId: record.id,
        projectId: record.projectId,
        metadata: { key: record.key }
      });
      return { variable: record };
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/api/variables/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const existing = variablesService.get(request.params.id);
    if (!existing) {
      reply.code(404);
      return { error: "Variable not found" };
    }
    if (user.role !== "admin" && !rbacService.can(user, existing.projectId, "workflow:write")) {
      reply.code(403);
      return { error: "Insufficient permissions to manage variables" };
    }
    const parsed = variableUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid variable payload", details: parsed.error.issues };
    }
    try {
      const record = variablesService.update(request.params.id, parsed.data);
      if (!record) {
        reply.code(404);
        return { error: "Variable not found" };
      }
      audit(request, user, {
        category: "project",
        eventType: "variable.update",
        action: "update",
        resourceType: "variable",
        resourceId: record.id,
        projectId: record.projectId,
        metadata: { key: record.key }
      });
      return { variable: record };
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.delete<{ Params: { id: string } }>("/api/variables/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const existing = variablesService.get(request.params.id);
    if (!existing) {
      reply.code(404);
      return { error: "Variable not found" };
    }
    if (user.role !== "admin" && !rbacService.can(user, existing.projectId, "workflow:write")) {
      reply.code(403);
      return { error: "Insufficient permissions to manage variables" };
    }
    variablesService.delete(request.params.id);
    audit(request, user, {
      category: "project",
      eventType: "variable.delete",
      action: "delete",
      resourceType: "variable",
      resourceId: existing.id,
      projectId: existing.projectId,
      metadata: { key: existing.key }
    });
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // Phase 5.6 — Workflow version history
  // ---------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>("/api/workflows/:id/versions", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    const workflow = store.getWorkflow(request.params.id);
    if (!workflow) {
      reply.code(404);
      return { error: "Workflow not found" };
    }
    return { versions: workflowVersionService.list(request.params.id) };
  });

  app.get<{ Params: { id: string; version: string } }>(
    "/api/workflows/:id/versions/:version",
    async (request, reply) => {
      const user = await requireRole(request, reply, ["viewer"]);
      if (!user) return;
      const version = Number.parseInt(request.params.version, 10);
      if (!Number.isFinite(version) || version <= 0) {
        reply.code(400);
        return { error: "Invalid version number" };
      }
      const entry = workflowVersionService.get(request.params.id, version);
      if (!entry) {
        reply.code(404);
        return { error: "Version not found" };
      }
      return entry;
    }
  );

  app.post<{ Params: { id: string; version: string } }>(
    "/api/workflows/:id/versions/:version/restore",
    async (request, reply) => {
      const user = await requireRole(request, reply, ["builder"]);
      if (!user) return;
      const version = Number.parseInt(request.params.version, 10);
      if (!Number.isFinite(version) || version <= 0) {
        reply.code(400);
        return { error: "Invalid version number" };
      }
      const entry = workflowVersionService.get(request.params.id, version);
      if (!entry) {
        reply.code(404);
        return { error: "Version not found" };
      }
      const restoredWorkflow: Workflow = {
        ...entry.workflow,
        workflowVersion: (entry.workflow.workflowVersion ?? 1) + 1
      };
      const saved = store.upsertWorkflow(restoredWorkflow);
      workflowVersionService.snapshot({
        workflow: saved,
        createdBy: user.id,
        changeNote: `restored from v${version}`
      });
      schedulerService?.reloadWorkflow(saved.id);
      triggerService?.reloadWorkflow(saved.id);
      audit(request, user, {
        category: "workflow",
        eventType: "workflow.restore",
        action: "restore",
        resourceType: "workflow",
        resourceId: saved.id,
        projectId: saved.projectId,
        metadata: { restoredFrom: version }
      });
      return saved;
    }
  );

  // ---------------------------------------------------------------------------
  // Phase 5.6 — Git source control
  // ---------------------------------------------------------------------------

  const gitConfigSchema = z.object({
    repoUrl: z.string().min(1).max(1024),
    defaultBranch: z.string().min(1).max(120).optional(),
    authSecretId: z.string().min(1).max(120).nullable().optional(),
    workflowsDir: z.string().min(1).max(512).optional(),
    variablesFile: z.string().min(1).max(512).optional(),
    userName: z.string().min(1).max(120).optional(),
    userEmail: z.string().min(1).max(240).optional(),
    enabled: z.boolean().optional()
  });
  const gitSyncSchema = z.object({
    branch: z.string().min(1).max(120).optional(),
    message: z.string().max(2000).optional()
  });

  app.get("/api/git", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    return { config: gitSyncService.getConfig(), status: gitSyncService.status() };
  });

  app.put<{ Body: unknown }>("/api/git", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const parsed = gitConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid git config", details: parsed.error.issues };
    }
    try {
      const config = gitSyncService.configure(parsed.data);
      audit(request, user, {
        category: "system",
        eventType: "git.configure",
        action: "update",
        resourceType: "git_config",
        resourceId: "default",
        metadata: { repoUrl: parsed.data.repoUrl, defaultBranch: config.defaultBranch }
      });
      return { config, status: gitSyncService.status() };
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.delete("/api/git", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const existed = gitSyncService.disconnect();
    if (!existed) {
      reply.code(404);
      return { error: "Git is not configured" };
    }
    audit(request, user, {
      category: "system",
      eventType: "git.disconnect",
      action: "delete",
      resourceType: "git_config",
      resourceId: "default"
    });
    return { ok: true };
  });

  app.get("/api/git/status", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    return gitSyncService.status();
  });

  app.post<{ Body: unknown }>("/api/git/push", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const parsed = gitSyncSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid push payload", details: parsed.error.issues };
    }
    try {
      const result = await gitSyncService.push({ ...parsed.data, createdBy: user.id });
      audit(request, user, {
        category: "system",
        eventType: "git.push",
        action: "push",
        outcome: result.ok ? "success" : "failure",
        resourceType: "git_config",
        resourceId: "default",
        metadata: {
          branch: result.branch,
          commit: result.commit,
          workflowsExported: result.workflowsExported,
          variablesSynced: result.variablesSynced,
          error: result.error
        }
      });
      if (!result.ok) reply.code(400);
      return result;
    } catch (err) {
      reply.code(400);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.post<{ Body: unknown }>("/api/git/pull", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const parsed = gitSyncSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid pull payload", details: parsed.error.issues };
    }
    try {
      const result = await gitSyncService.pull({ ...parsed.data, createdBy: user.id });
      audit(request, user, {
        category: "system",
        eventType: "git.pull",
        action: "pull",
        outcome: result.ok ? "success" : "failure",
        resourceType: "git_config",
        resourceId: "default",
        metadata: {
          branch: result.branch,
          commit: result.commit,
          workflowsImported: result.workflowsImported,
          variablesSynced: result.variablesSynced,
          error: result.error
        }
      });
      if (!result.ok) reply.code(400);
      return result;
    } catch (err) {
      reply.code(400);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ---------------------------------------------------------------------------
  // Phase 5.2 — Project memberships
  // ---------------------------------------------------------------------------

  const projectMemberSchema = z.object({
    userId: z.string().min(1).max(120),
    role: z.string().min(1).max(60),
    customRoleId: z.string().min(1).max(120).nullable().optional()
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/members", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    const project = store.getProject(request.params.id);
    if (!project) {
      reply.code(404);
      return { error: "Project not found" };
    }
    if (!rbacService.can(user, project.id, "project:invite") && user.role !== "admin") {
      reply.code(403);
      return { error: "Insufficient permissions to view project members" };
    }
    return { members: rbacService.listMembers(project.id) };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/projects/:id/members", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    const project = store.getProject(request.params.id);
    if (!project) {
      reply.code(404);
      return { error: "Project not found" };
    }
    if (!rbacService.can(user, project.id, "project:invite") && user.role !== "admin") {
      reply.code(403);
      return { error: "Insufficient permissions to manage members" };
    }
    const parsed = projectMemberSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid member payload", details: parsed.error.issues };
    }
    const targetUser = store.getUserById(parsed.data.userId);
    if (!targetUser) {
      reply.code(400);
      return { error: "Target user does not exist" };
    }
    const role = parsed.data.role;
    if (!isProjectRole(role) && role !== "custom") {
      reply.code(400);
      return { error: "role must be project_admin, editor, viewer, or custom" };
    }
    try {
      rbacService.addMember({
        userId: parsed.data.userId,
        projectId: project.id,
        role: role as ProjectRole | "custom",
        customRoleId: parsed.data.customRoleId ?? null
      });
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : "Failed to add member" };
    }
    audit(request, user, {
      category: "rbac",
      eventType: "project.member.add",
      action: "add_member",
      resourceType: "project_member",
      resourceId: `${project.id}:${parsed.data.userId}`,
      projectId: project.id,
      metadata: { userId: parsed.data.userId, role, customRoleId: parsed.data.customRoleId ?? null }
    });
    return { ok: true, membership: rbacService.getMembership(parsed.data.userId, project.id) };
  });

  app.delete<{ Params: { id: string; userId: string } }>(
    "/api/projects/:id/members/:userId",
    async (request, reply) => {
      const user = await requireRole(request, reply, ["viewer"]);
      if (!user) return;
      const project = store.getProject(request.params.id);
      if (!project) {
        reply.code(404);
        return { error: "Project not found" };
      }
      if (!rbacService.can(user, project.id, "project:invite") && user.role !== "admin") {
        reply.code(403);
        return { error: "Insufficient permissions to remove members" };
      }
      const ok = rbacService.removeMember(request.params.userId, project.id);
      if (!ok) {
        reply.code(404);
        return { error: "Membership not found" };
      }
      audit(request, user, {
        category: "rbac",
        eventType: "project.member.remove",
        action: "remove_member",
        resourceType: "project_member",
        resourceId: `${project.id}:${request.params.userId}`,
        projectId: project.id
      });
      return { ok: true };
    }
  );

  // ---------------------------------------------------------------------------
  // Phase 5.2 — Custom roles
  // ---------------------------------------------------------------------------

  const customRoleSchema = z.object({
    name: z.string().min(1).max(120),
    description: z.string().max(1000).nullable().optional(),
    projectId: z.string().min(1).max(120).nullable().optional(),
    permissions: z.array(z.string().min(1).max(60))
  });

  app.get<{ Querystring: { projectId?: string } }>("/api/custom-roles", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    const projectId =
      typeof request.query?.projectId === "string" && request.query.projectId.trim()
        ? request.query.projectId
        : undefined;
    return {
      roles: rbacService.listCustomRoles(projectId),
      availablePermissions: ALL_PERMISSIONS
    };
  });

  app.post<{ Body: unknown }>("/api/custom-roles", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const parsed = customRoleSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid custom role payload", details: parsed.error.issues };
    }
    const { id } = rbacService.createCustomRole({
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      projectId: parsed.data.projectId ?? null,
      permissions: parsed.data.permissions as Permission[],
      createdBy: user.email
    });
    audit(request, user, {
      category: "rbac",
      eventType: "custom_role.create",
      action: "create",
      resourceType: "custom_role",
      resourceId: id,
      projectId: parsed.data.projectId ?? null,
      metadata: { name: parsed.data.name, permissions: parsed.data.permissions }
    });
    return { id, role: rbacService.getCustomRole(id) };
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/api/custom-roles/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const parsed = customRoleSchema.partial().safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid custom role payload", details: parsed.error.issues };
    }
    const ok = rbacService.updateCustomRole(request.params.id, {
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      projectId: parsed.data.projectId === undefined ? undefined : parsed.data.projectId,
      permissions: parsed.data.permissions as Permission[] | undefined
    });
    if (!ok) {
      reply.code(404);
      return { error: "Custom role not found" };
    }
    return { role: rbacService.getCustomRole(request.params.id) };
  });

  app.delete<{ Params: { id: string } }>("/api/custom-roles/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const ok = rbacService.deleteCustomRole(request.params.id);
    if (!ok) {
      reply.code(404);
      return { error: "Custom role not found" };
    }
    audit(request, user, {
      category: "rbac",
      eventType: "custom_role.delete",
      action: "delete",
      resourceType: "custom_role",
      resourceId: request.params.id
    });
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // Phase 5.2 — Workflow sharing
  // ---------------------------------------------------------------------------

  const workflowShareSchema = z.object({
    projectId: z.string().min(1).max(120),
    accessLevel: z.enum(["read", "execute"]).default("read")
  });

  app.get<{ Params: { id: string } }>("/api/workflows/:id/shares", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    const workflow = store.getWorkflow(request.params.id);
    if (!workflow) {
      reply.code(404);
      return { error: "Workflow not found" };
    }
    if (!rbacService.canAccessWorkflow(user, workflow, "workflow:read")) {
      reply.code(403);
      return { error: "Insufficient permissions" };
    }
    return { shares: rbacService.listWorkflowShares(workflow.id) };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/workflows/:id/shares", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    const workflow = store.getWorkflow(request.params.id);
    if (!workflow) {
      reply.code(404);
      return { error: "Workflow not found" };
    }
    const owningProject = workflow.projectId ?? "default";
    if (!rbacService.can(user, owningProject, "workflow:write") && user.role !== "admin") {
      reply.code(403);
      return { error: "Only users with workflow:write on the owning project can share the workflow" };
    }
    const parsed = workflowShareSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid share payload", details: parsed.error.issues };
    }
    if (!store.getProject(parsed.data.projectId)) {
      reply.code(400);
      return { error: "Target project does not exist" };
    }
    if (parsed.data.projectId === owningProject) {
      reply.code(400);
      return { error: "Cannot share a workflow to its owning project" };
    }
    rbacService.shareWorkflow({
      workflowId: workflow.id,
      projectId: parsed.data.projectId,
      accessLevel: parsed.data.accessLevel,
      sharedBy: user.email
    });
    audit(request, user, {
      category: "sharing",
      eventType: "workflow.share",
      action: "share",
      resourceType: "workflow",
      resourceId: workflow.id,
      projectId: workflow.projectId ?? null,
      metadata: { targetProjectId: parsed.data.projectId, accessLevel: parsed.data.accessLevel }
    });
    return { ok: true };
  });

  app.delete<{ Params: { id: string; projectId: string } }>(
    "/api/workflows/:id/shares/:projectId",
    async (request, reply) => {
      const user = await requireRole(request, reply, ["viewer"]);
      if (!user) return;
      const workflow = store.getWorkflow(request.params.id);
      if (!workflow) {
        reply.code(404);
        return { error: "Workflow not found" };
      }
      const owningProject = workflow.projectId ?? "default";
      if (!rbacService.can(user, owningProject, "workflow:write") && user.role !== "admin") {
        reply.code(403);
        return { error: "Insufficient permissions" };
      }
      const ok = rbacService.unshareWorkflow(workflow.id, request.params.projectId);
      if (!ok) {
        reply.code(404);
        return { error: "Share not found" };
      }
      audit(request, user, {
        category: "sharing",
        eventType: "workflow.unshare",
        action: "unshare",
        resourceType: "workflow",
        resourceId: workflow.id,
        projectId: workflow.projectId ?? null,
        metadata: { targetProjectId: request.params.projectId }
      });
      return { ok: true };
    }
  );

  // ---------------------------------------------------------------------------
  // Phase 5.2 — Secret sharing
  // ---------------------------------------------------------------------------

  const secretShareSchema = z.object({
    projectId: z.string().min(1).max(120)
  });

  app.get<{ Params: { id: string } }>("/api/secrets/:id/shares", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    return { shares: rbacService.listSecretShares(request.params.id) };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/secrets/:id/shares", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const parsed = secretShareSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid share payload", details: parsed.error.issues };
    }
    if (!store.getProject(parsed.data.projectId)) {
      reply.code(400);
      return { error: "Target project does not exist" };
    }
    audit(request, user, {
      category: "sharing",
      eventType: "secret.share",
      action: "share",
      resourceType: "secret",
      resourceId: request.params.id,
      metadata: { targetProjectId: parsed.data.projectId }
    });
    rbacService.shareSecret({
      secretId: request.params.id,
      projectId: parsed.data.projectId,
      sharedBy: user.email
    });
    return { ok: true };
  });

  app.delete<{ Params: { id: string; projectId: string } }>(
    "/api/secrets/:id/shares/:projectId",
    async (request, reply) => {
      const user = await requireRole(request, reply, ["builder"]);
      if (!user) return;
      const ok = rbacService.unshareSecret(request.params.id, request.params.projectId);
      if (!ok) {
        reply.code(404);
        return { error: "Share not found" };
      }
      return { ok: true };
    }
  );

  app.get("/api/definitions", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) {
      return;
    }

    return {
      nodes: nodeDefinitions,
      providers: providerRegistry.listDefinitions(),
      connectors: connectorRegistry.listDefinitions(),
      mcpServers: mcpRegistry.listDefinitions()
    };
  });

  app.get("/api/integrations", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) {
      return;
    }
    return { integrations: [...TIER1_INTEGRATIONS, ...TIER2_INTEGRATIONS] };
  });

  app.get<{ Querystring: { projectId?: string; folderId?: string; tag?: string; search?: string } }>(
    "/api/workflows",
    async (request, reply) => {
      const user = await requireRole(request, reply, ["viewer"]);
      if (!user) {
        return;
      }
      const query = request.query ?? {};
      const folderFilter: string | null | undefined =
        typeof query.folderId === "string" && query.folderId.trim()
          ? query.folderId === "__none__"
            ? null
            : query.folderId
          : undefined;
      return store.listWorkflows({
        projectId: typeof query.projectId === "string" && query.projectId.trim() ? query.projectId : undefined,
        folderId: folderFilter,
        tag: typeof query.tag === "string" ? query.tag : undefined,
        search: typeof query.search === "string" ? query.search : undefined
      });
    }
  );

  app.get<{ Params: { id: string } }>("/api/workflows/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) {
      return;
    }

    const workflow = store.getWorkflow(request.params.id);
    if (!workflow) {
      reply.code(404);
      return { error: "Workflow not found" };
    }

    return workflow;
  });

  app.get<{ Params: { id: string } }>("/api/workflows/:id/variables", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) {
      return;
    }

    const workflow = store.getWorkflow(request.params.id);
    if (!workflow) {
      reply.code(404);
      return { error: "Workflow not found" };
    }

    return {
      workflowId: workflow.id,
      variables: workflow.variables ?? {}
    };
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/api/workflows/:id/variables", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) {
      return;
    }

    const workflow = store.getWorkflow(request.params.id);
    if (!workflow) {
      reply.code(404);
      return { error: "Workflow not found" };
    }

    const parsed = workflowVariablesSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid workflow variables payload",
        details: parsed.error.issues
      };
    }

    const nextWorkflow: Workflow = {
      ...workflow,
      variables: parsed.data.variables
    };
    const saved = store.upsertWorkflow(nextWorkflow);
    schedulerService?.reloadWorkflow(saved.id);
    triggerService?.reloadWorkflow(saved.id);

    return {
      workflowId: saved.id,
      variables: saved.variables ?? {}
    };
  });

  app.post<{ Body: unknown }>("/api/workflows", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) {
      return;
    }

    const parsed = workflowSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid workflow payload",
        details: parsed.error.issues
      };
    }

    const validation = validateWorkflowGraph(parsed.data);
    if (!validation.valid) {
      reply.code(400);
      return {
        error: `Workflow validation failed: ${validation.issues.map((issue) => issue.message).join("; ")}`,
        validation
      };
    }

    const savedWorkflow = store.upsertWorkflow(parsed.data);
    workflowVersionService.snapshot({ workflow: savedWorkflow, createdBy: user.id, changeNote: "created" });
    schedulerService?.reloadWorkflow(savedWorkflow.id);
    triggerService?.reloadWorkflow(savedWorkflow.id);
    audit(request, user, {
      category: "workflow",
      eventType: "workflow.create",
      action: "create",
      resourceType: "workflow",
      resourceId: savedWorkflow.id,
      projectId: savedWorkflow.projectId,
      metadata: { name: savedWorkflow.name, version: savedWorkflow.workflowVersion }
    });
    return savedWorkflow;
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/api/workflows/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) {
      return;
    }

    const parsed = workflowSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid workflow payload",
        details: parsed.error.issues
      };
    }

    if (parsed.data.id !== request.params.id) {
      reply.code(400);
      return { error: "Workflow ID mismatch between path and payload" };
    }

    const validation = validateWorkflowGraph(parsed.data);
    if (!validation.valid) {
      reply.code(400);
      return {
        error: `Workflow validation failed: ${validation.issues.map((issue) => issue.message).join("; ")}`,
        validation
      };
    }

    const savedWorkflow = store.upsertWorkflow(parsed.data);
    workflowVersionService.snapshot({ workflow: savedWorkflow, createdBy: user.id, changeNote: "updated" });
    schedulerService?.reloadWorkflow(savedWorkflow.id);
    triggerService?.reloadWorkflow(savedWorkflow.id);
    audit(request, user, {
      category: "workflow",
      eventType: "workflow.update",
      action: "update",
      resourceType: "workflow",
      resourceId: savedWorkflow.id,
      projectId: savedWorkflow.projectId,
      metadata: { name: savedWorkflow.name, version: savedWorkflow.workflowVersion }
    });
    return savedWorkflow;
  });

  app.delete<{ Params: { id: string } }>("/api/workflows/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) {
      return;
    }

    try {
      const deleted = store.deleteWorkflow(request.params.id);
      if (!deleted) {
        reply.code(404);
        return { error: "Workflow not found" };
      }

      schedulerService?.removeWorkflow(request.params.id);
      triggerService?.removeWorkflow(request.params.id);
      audit(request, user, {
        category: "workflow",
        eventType: "workflow.delete",
        action: "delete",
        resourceType: "workflow",
        resourceId: request.params.id
      });
      return { ok: true };
    } catch (error) {
      reply.code(400);
      return {
        error: error instanceof Error ? error.message : "Failed to delete workflow"
      };
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/workflows/:id/duplicate", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) {
      return;
    }

    const sourceWorkflow = store.getWorkflow(request.params.id);
    if (!sourceWorkflow) {
      reply.code(404);
      return { error: "Workflow not found" };
    }

    const parsed = workflowDuplicateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid workflow duplication payload",
        details: parsed.error.issues
      };
    }

    const requestedId = parsed.data.id?.trim();
    const duplicateId = makeUniqueWorkflowId(store, requestedId || `${sourceWorkflow.id}-copy`);
    const duplicateName = parsed.data.name.trim();
    const duplicatedWorkflow = JSON.parse(JSON.stringify(sourceWorkflow)) as Workflow;
    delete duplicatedWorkflow.createdAt;
    delete duplicatedWorkflow.updatedAt;
    duplicatedWorkflow.id = duplicateId;
    duplicatedWorkflow.name = duplicateName;
    duplicatedWorkflow.workflowVersion = 1;

    const savedWorkflow = store.upsertWorkflow(duplicatedWorkflow);
    schedulerService?.reloadWorkflow(savedWorkflow.id);
    triggerService?.reloadWorkflow(savedWorkflow.id);
    return savedWorkflow;
  });

  // ── Phase 7.3: Workflow activate / deactivate ────────────────────────

  app.post<{ Params: { id: string } }>("/api/workflows/:id/activate", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const workflow = store.getWorkflow(request.params.id);
    if (!workflow) {
      reply.code(404);
      return { error: "Workflow not found" };
    }
    const settings = typeof workflow.settings === "object" && workflow.settings ? { ...workflow.settings } : {};
    settings.active = true;
    workflow.settings = settings;
    store.upsertWorkflow(workflow);
    schedulerService?.reloadWorkflow(workflow.id);
    triggerService?.reloadWorkflow(workflow.id);
    audit(request, user, {
      category: "workflow",
      eventType: "workflow.activate",
      action: "update",
      resourceType: "workflow",
      resourceId: request.params.id
    });
    return { ok: true, workflowId: request.params.id, active: true };
  });

  app.post<{ Params: { id: string } }>("/api/workflows/:id/deactivate", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const workflow = store.getWorkflow(request.params.id);
    if (!workflow) {
      reply.code(404);
      return { error: "Workflow not found" };
    }
    const settings = typeof workflow.settings === "object" && workflow.settings ? { ...workflow.settings } : {};
    settings.active = false;
    workflow.settings = settings;
    store.upsertWorkflow(workflow);
    schedulerService?.removeWorkflow(workflow.id);
    triggerService?.removeWorkflow(workflow.id);
    audit(request, user, {
      category: "workflow",
      eventType: "workflow.deactivate",
      action: "update",
      resourceType: "workflow",
      resourceId: request.params.id
    });
    return { ok: true, workflowId: request.params.id, active: false };
  });

  // ── Phase 7.3: Workflow transfer between projects ────────────────────

  app.post<{ Params: { id: string }; Body: unknown }>("/api/workflows/:id/transfer", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const workflow = store.getWorkflow(request.params.id);
    if (!workflow) {
      reply.code(404);
      return { error: "Workflow not found" };
    }
    const schema = z.object({ targetProjectId: z.string().min(1) });
    const parsed = schema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid payload", details: parsed.error.issues };
    }
    const targetProject = store.getProject(parsed.data.targetProjectId);
    if (!targetProject) {
      reply.code(404);
      return { error: "Target project not found" };
    }
    const previousProjectId = workflow.projectId;
    workflow.projectId = parsed.data.targetProjectId;
    workflow.folderId = undefined;
    store.upsertWorkflow(workflow);
    audit(request, user, {
      category: "workflow",
      eventType: "workflow.transfer",
      action: "update",
      resourceType: "workflow",
      resourceId: request.params.id,
      metadata: { previousProjectId, targetProjectId: parsed.data.targetProjectId }
    });
    return { ok: true, workflowId: request.params.id, projectId: parsed.data.targetProjectId };
  });

  app.post<{ Body: unknown }>("/api/workflows/import", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) {
      return;
    }

    const parsed = workflowImportSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid import payload", details: parsed.error.issues };
    }

    try {
      const workflow = parsed.data.json
        ? importWorkflowFromJson(parsed.data.json)
        : workflowSchema.parse(parsed.data.workflow);

      const validation = validateWorkflowGraph(workflow);
      if (!validation.valid) {
        reply.code(400);
        return {
          error: `Workflow validation failed: ${validation.issues.map((issue) => issue.message).join("; ")}`,
          validation
        };
      }

      const savedWorkflow = store.upsertWorkflow(workflow);
      schedulerService?.reloadWorkflow(savedWorkflow.id);
      triggerService?.reloadWorkflow(savedWorkflow.id);
      return savedWorkflow;
    } catch (error) {
      reply.code(400);
      return {
        error: error instanceof Error ? error.message : "Failed to import workflow"
      };
    }
  });

  app.get<{ Params: { id: string } }>("/api/workflows/:id/export", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) {
      return;
    }

    const workflow = store.getWorkflow(request.params.id);
    if (!workflow) {
      reply.code(404);
      return { error: "Workflow not found" };
    }

    return {
      json: exportWorkflowToJson(workflow)
    };
  });

  app.post<{ Params: { id: string } }>("/api/workflows/:id/validate", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) {
      return;
    }

    const workflow = store.getWorkflow(request.params.id);
    if (!workflow) {
      reply.code(404);
      return { error: "Workflow not found" };
    }

    return validateWorkflowGraph(workflow);
  });

  // ---------------------------------------------------------------------------
  // Phase 4.2 — Projects, Folders, tags, workflow moves
  // ---------------------------------------------------------------------------

  const projectPayloadSchema = z.object({
    id: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-zA-Z0-9_-]+$/, "Project id must only contain letters, digits, dashes or underscores")
      .optional(),
    name: z.string().min(1).max(120),
    description: z.string().max(1000).optional()
  });

  const folderPayloadSchema = z.object({
    id: z.string().min(1).max(120).optional(),
    name: z.string().min(1).max(120),
    parentId: z.string().min(1).max(120).optional(),
    projectId: z.string().min(1).max(120)
  });

  const workflowMoveSchema = z.object({
    projectId: z.string().min(1).max(120).optional(),
    folderId: z.string().min(1).max(120).nullable().optional(),
    tags: z.array(z.string().min(1).max(64)).optional()
  });

  app.get("/api/projects", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    return { projects: store.listProjects() };
  });

  app.post<{ Body: unknown }>("/api/projects", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const parsed = projectPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid project payload", details: parsed.error.issues };
    }
    const id = parsed.data.id?.trim() || `proj-${crypto.randomUUID()}`;
    const project = store.upsertProject({
      id,
      name: parsed.data.name.trim(),
      description: parsed.data.description?.trim() || undefined,
      createdBy: user.email
    });
    return project;
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/api/projects/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const existing = store.getProject(request.params.id);
    if (!existing) {
      reply.code(404);
      return { error: "Project not found" };
    }
    const parsed = projectPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid project payload", details: parsed.error.issues };
    }
    const project = store.upsertProject({
      id: existing.id,
      name: parsed.data.name.trim(),
      description: parsed.data.description?.trim() || undefined,
      createdBy: existing.createdBy
    });
    return project;
  });

  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    try {
      const ok = store.deleteProject(request.params.id);
      if (!ok) {
        reply.code(404);
        return { error: "Project not found" };
      }
      return { ok: true };
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : "Failed to delete project" };
    }
  });

  app.get<{ Querystring: { projectId?: string } }>("/api/folders", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    const projectId =
      typeof request.query?.projectId === "string" && request.query.projectId.trim()
        ? request.query.projectId
        : undefined;
    return { folders: store.listFolders(projectId) };
  });

  app.post<{ Body: unknown }>("/api/folders", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const parsed = folderPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid folder payload", details: parsed.error.issues };
    }
    if (!store.getProject(parsed.data.projectId)) {
      reply.code(400);
      return { error: "Target project does not exist" };
    }
    if (parsed.data.parentId && !store.getFolder(parsed.data.parentId)) {
      reply.code(400);
      return { error: "Parent folder does not exist" };
    }
    const id = parsed.data.id?.trim() || `fld-${crypto.randomUUID()}`;
    const folder = store.upsertFolder({
      id,
      name: parsed.data.name.trim(),
      parentId: parsed.data.parentId,
      projectId: parsed.data.projectId
    });
    return folder;
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/api/folders/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const existing = store.getFolder(request.params.id);
    if (!existing) {
      reply.code(404);
      return { error: "Folder not found" };
    }
    const parsed = folderPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid folder payload", details: parsed.error.issues };
    }
    if (parsed.data.parentId === existing.id) {
      reply.code(400);
      return { error: "A folder cannot be its own parent" };
    }
    const folder = store.upsertFolder({
      id: existing.id,
      name: parsed.data.name.trim(),
      parentId: parsed.data.parentId,
      projectId: parsed.data.projectId
    });
    return folder;
  });

  app.delete<{ Params: { id: string } }>("/api/folders/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const ok = store.deleteFolder(request.params.id);
    if (!ok) {
      reply.code(404);
      return { error: "Folder not found" };
    }
    return { ok: true };
  });

  // Move a workflow between projects/folders and/or update its tags.
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/workflows/:id/move",
    async (request, reply) => {
      const user = await requireRole(request, reply, ["builder"]);
      if (!user) return;
      const workflow = store.getWorkflow(request.params.id);
      if (!workflow) {
        reply.code(404);
        return { error: "Workflow not found" };
      }
      const parsed = workflowMoveSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        reply.code(400);
        return { error: "Invalid move payload", details: parsed.error.issues };
      }
      if (parsed.data.projectId && !store.getProject(parsed.data.projectId)) {
        reply.code(400);
        return { error: "Target project does not exist" };
      }
      if (
        parsed.data.folderId &&
        parsed.data.folderId !== null &&
        !store.getFolder(parsed.data.folderId)
      ) {
        reply.code(400);
        return { error: "Target folder does not exist" };
      }
      const nextWorkflow: Workflow = {
        ...workflow,
        projectId: parsed.data.projectId ?? workflow.projectId,
        folderId:
          parsed.data.folderId === null
            ? undefined
            : parsed.data.folderId ?? workflow.folderId,
        tags: parsed.data.tags ?? workflow.tags
      };
      const saved = store.upsertWorkflow(nextWorkflow);
      schedulerService?.reloadWorkflow(saved.id);
      triggerService?.reloadWorkflow(saved.id);
      return saved;
    }
  );

  app.get<{ Params: { id: string } }>("/api/workflows/:id/pins", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    const workflow = store.getWorkflow(request.params.id);
    if (!workflow) {
      reply.code(404);
      return { error: "Workflow not found" };
    }
    return {
      workflowId: workflow.id,
      pinnedData: asRecord(workflow.pinnedData)
    };
  });

  app.put<{ Params: { id: string; nodeId: string }; Body: unknown }>(
    "/api/workflows/:id/pins/:nodeId",
    async (request, reply) => {
      const user = await requireRole(request, reply, ["builder"]);
      if (!user) return;
      const workflow = store.getWorkflow(request.params.id);
      if (!workflow) {
        reply.code(404);
        return { error: "Workflow not found" };
      }
      if (!workflow.nodes.some((node) => node.id === request.params.nodeId)) {
        reply.code(404);
        return { error: "Node not found" };
      }
      const parsed = pinDataSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        reply.code(400);
        return { error: "Invalid pin payload", details: parsed.error.issues };
      }
      const nextWorkflow: Workflow = {
        ...workflow,
        pinnedData: {
          ...asRecord(workflow.pinnedData),
          [request.params.nodeId]: parsed.data.data
        }
      };
      const saved = store.upsertWorkflow(nextWorkflow);
      schedulerService?.reloadWorkflow(saved.id);
      triggerService?.reloadWorkflow(saved.id);
      return {
        workflowId: saved.id,
        nodeId: request.params.nodeId,
        data: asRecord(saved.pinnedData)[request.params.nodeId],
        pinnedData: asRecord(saved.pinnedData)
      };
    }
  );

  app.delete<{ Params: { id: string; nodeId: string } }>(
    "/api/workflows/:id/pins/:nodeId",
    async (request, reply) => {
      const user = await requireRole(request, reply, ["builder"]);
      if (!user) return;
      const workflow = store.getWorkflow(request.params.id);
      if (!workflow) {
        reply.code(404);
        return { error: "Workflow not found" };
      }
      const pinnedData = { ...asRecord(workflow.pinnedData) };
      delete pinnedData[request.params.nodeId];
      const nextWorkflow: Workflow = {
        ...workflow,
        pinnedData: Object.keys(pinnedData).length > 0 ? pinnedData : undefined
      };
      const saved = store.upsertWorkflow(nextWorkflow);
      schedulerService?.reloadWorkflow(saved.id);
      triggerService?.reloadWorkflow(saved.id);
      return {
        ok: true,
        workflowId: saved.id,
        nodeId: request.params.nodeId,
        pinnedData: asRecord(saved.pinnedData)
      };
    }
  );

  app.post<{ Params: { id: string }; Body: unknown }>("/api/workflows/:id/execute", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) {
      return;
    }

    const workflow = store.getWorkflow(request.params.id);
    if (!workflow) {
      reply.code(404);
      return { error: "Workflow not found" };
    }

    const parsed = workflowExecuteRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid execution payload",
        details: parsed.error.issues
      };
    }
    const prepared = prepareWorkflowExecutionPayload(parsed.data, reply);
    if (!prepared) {
      return { error: "Source execution not found" };
    }
    const executionPayload = prepared.payload;

    const executionId = crypto.randomUUID();
    const progressHooks = createProgressTrackingHooks({
      executionId,
      workflow,
      triggerType: "manual",
      triggeredBy: user.email,
      requestInput: prepared.requestInput,
      customData: executionPayload.customData
    });
    const result = await runWorkflowExecution({
      workflow,
      startNodeId: executionPayload.startNodeId,
      runMode: executionPayload.runMode,
      usePinnedData: executionPayload.usePinnedData,
      pinnedData: executionPayload.pinnedData,
      nodeOutputs: prepared.nodeOutputs,
      directInput: executionPayload.input,
      variables: executionPayload.variables,
      systemPrompt: executionPayload.system_prompt,
      userPrompt: executionPayload.user_prompt,
      sessionId: normalizeSessionId(executionPayload.sessionId, executionPayload.session_id),
      executionTimeoutMs: normalizeExecutionTimeoutMs(
        executionPayload.executionTimeoutMs,
        executionPayload.execution_timeout_ms,
        config.WORKFLOW_EXECUTION_TIMEOUT_MS
      ),
      customData: executionPayload.customData,
      executionId,
      triggerType: "manual",
      triggeredBy: user.email,
      hooks: progressHooks
    });

    persistExecutionHistory({
      executionId,
      workflow,
      result,
      triggerType: "manual",
      triggeredBy: user.email,
      requestInput: prepared.requestInput,
      customData: executionPayload.customData
    });

    if (result.status === "error") {
      reply.code(400);
    }

    return result;
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/workflows/:id/execute/stream", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) {
      return;
    }

    const workflow = store.getWorkflow(request.params.id);
    if (!workflow) {
      reply.code(404);
      return { error: "Workflow not found" };
    }

    const parsed = workflowExecuteRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid execution payload",
        details: parsed.error.issues
      };
    }
    const prepared = prepareWorkflowExecutionPayload(parsed.data, reply);
    if (!prepared) {
      return { error: "Source execution not found" };
    }
    const executionPayload = prepared.payload;

    const executionId = crypto.randomUUID();
    let streamClosed = false;
    request.raw.on("close", () => {
      streamClosed = true;
    });

    const sendSseEvent = (event: string, payload: unknown) => {
      if (streamClosed) {
        return;
      }
      reply.raw.write(`event: ${event}\n`);
      const serialized = JSON.stringify(payload ?? null);
      for (const line of serialized.split("\n")) {
        reply.raw.write(`data: ${line}\n`);
      }
      reply.raw.write("\n");
    };

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });
    if (typeof reply.raw.flushHeaders === "function") {
      reply.raw.flushHeaders();
    }

    try {
      const progressHooks = createProgressTrackingHooks({
        executionId,
        workflow,
        triggerType: "manual_stream",
        triggeredBy: user.email,
        requestInput: prepared.requestInput,
        customData: executionPayload.customData,
        passthroughHooks: {
          onNodeStart: (event) => {
            sendSseEvent("node_start", event);
          },
          onNodeComplete: (event) => {
            sendSseEvent("node_complete", event);
          },
          onLLMDelta: (event) => {
            sendSseEvent("llm_delta", event);
          }
        }
      });
      const result = await runWorkflowExecution({
        workflow,
        startNodeId: executionPayload.startNodeId,
        runMode: executionPayload.runMode,
        usePinnedData: executionPayload.usePinnedData,
        pinnedData: executionPayload.pinnedData,
        nodeOutputs: prepared.nodeOutputs,
        directInput: executionPayload.input,
        variables: executionPayload.variables,
        systemPrompt: executionPayload.system_prompt,
        userPrompt: executionPayload.user_prompt,
        sessionId: normalizeSessionId(executionPayload.sessionId, executionPayload.session_id),
        executionTimeoutMs: normalizeExecutionTimeoutMs(
          executionPayload.executionTimeoutMs,
          executionPayload.execution_timeout_ms,
          config.WORKFLOW_EXECUTION_TIMEOUT_MS
        ),
        customData: executionPayload.customData,
        executionId,
        triggerType: "manual_stream",
        triggeredBy: user.email,
        hooks: progressHooks
      });

      persistExecutionHistory({
        executionId,
        workflow,
        result,
        triggerType: "manual_stream",
        triggeredBy: user.email,
        requestInput: prepared.requestInput,
        customData: executionPayload.customData
      });

      sendSseEvent("result", result);
      if (result.status === "error") {
        sendSseEvent("error", { message: result.error ?? "Execution failed" });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Execution failed";
      sendSseEvent("error", { message });
    } finally {
      if (!streamClosed) {
        reply.raw.end();
      }
    }
  });

  app.post<{ Body: unknown }>("/api/code-node/test", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) {
      return;
    }

    const parsed = codeNodeTestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid Code Node test payload",
        details: parsed.error.issues
      };
    }

    try {
      const result = await executeCodeNodeSandbox({
        code: parsed.data.code,
        timeoutMs: parsed.data.timeout,
        input: parsed.data.input ?? {}
      });
      return result;
    } catch (error) {
      reply.code(400);
      return {
        error: error instanceof Error ? error.message : "Code node test failed"
      };
    }
  });

  app.post<{ Body: unknown }>("/api/connectors/test", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) {
      return;
    }

    const parsed = connectorTestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid connector test payload",
        details: parsed.error.issues
      };
    }

    try {
      const connector = connectorRegistry.get(parsed.data.connectorId);
      const result = await connector.testConnection(parsed.data.connectorConfig ?? {}, {
        resolveSecret: (secretRef) => secretService.resolveSecret(secretRef)
      });
      return result;
    } catch (error) {
      reply.code(400);
      return {
        error: error instanceof Error ? error.message : "Connector test failed"
      };
    }
  });

  app.post<{ Body: unknown }>("/api/providers/test", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) {
      return;
    }

    const parsed = providerTestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid provider test payload",
        details: parsed.error.issues
      };
    }

    const testProvider = normalizeProviderConfigForTest(parsed.data.provider);
    const probePrompt = parsed.data.prompt?.trim() || "Reply with: connection_ok";
    const systemPrompt = parsed.data.systemPrompt?.trim() || "You are a connection test assistant. Keep responses short.";

    try {
      const providerAdapter = providerRegistry.get(testProvider.providerId);
      const resolveCtx = { resolveSecret: (secretRef: Parameters<typeof secretService.resolveSecret>[0]) => secretService.resolveSecret(secretRef) };

      if (providerAdapter.testConnection) {
        const result = await providerAdapter.testConnection(testProvider, resolveCtx);
        if (!result.ok) {
          reply.code(400);
        }
        return {
          ...result,
          providerId: testProvider.providerId,
          model: testProvider.model
        };
      }

      const startedAt = Date.now();
      const response = await providerAdapter.generate(
        {
          provider: {
            ...testProvider,
            temperature:
              typeof testProvider.temperature === "number" && Number.isFinite(testProvider.temperature)
                ? testProvider.temperature
                : 0,
            maxTokens:
              typeof testProvider.maxTokens === "number" && Number.isFinite(testProvider.maxTokens)
                ? Math.max(1, Math.floor(testProvider.maxTokens))
                : 64
          },
          messages: [
            ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
            { role: "user" as const, content: probePrompt }
          ]
        },
        resolveCtx
      );

      return {
        ok: true,
        message: "Connection successful",
        providerId: testProvider.providerId,
        model: testProvider.model,
        latencyMs: Math.max(1, Date.now() - startedAt),
        preview: response.content.trim().slice(0, 240)
      };
    } catch (error) {
      reply.code(400);
      return {
        ok: false,
        message: secretService.redact(error instanceof Error ? error.message : "Provider connection test failed")
      };
    }
  });

  app.post<{ Body: unknown }>("/api/providers/models", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;

    const modelsPayloadSchema = z.object({
      providerId: z.string().min(1),
      secretRef: z.object({ secretId: z.string().min(1) }).optional(),
      baseUrl: z.string().optional(),
      extra: z.record(z.string(), z.unknown()).optional()
    });
    const parsed = modelsPayloadSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid payload", details: parsed.error.issues };
    }

    const { providerId, secretRef, baseUrl, extra } = parsed.data;

    try {
      if (providerId === "gemini") {
        const apiKey = (await secretService.resolveSecret(secretRef)) || process.env.GEMINI_API_KEY;
        if (!apiKey) return { models: [] };
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        if (!res.ok) return { models: [] };
        const json = await res.json() as { models?: Array<{ name?: string; displayName?: string; supportedGenerationMethods?: string[] }> };
        return {
          models: (json.models ?? [])
            .filter(m => m.supportedGenerationMethods?.includes("generateContent"))
            .map(m => ({ id: (m.name ?? "").replace(/^models\//, ""), label: m.displayName ?? m.name ?? "" }))
            .filter(m => m.id)
        };
      }

      if (providerId === "openai") {
        const apiKey = (await secretService.resolveSecret(secretRef)) || process.env.OPENAI_API_KEY;
        if (!apiKey) return { models: [] };
        const res = await fetch("https://api.openai.com/v1/models", {
          headers: { "Authorization": `Bearer ${apiKey}` }
        });
        if (!res.ok) return { models: [] };
        const json = await res.json() as { data?: Array<{ id: string; owned_by?: string }> };
        const chatModels = (json.data ?? [])
          .filter(m => /^(gpt-|o[1-9]|chatgpt-)/.test(m.id) && !m.id.includes("instruct") && !m.id.includes("realtime") && !m.id.includes("audio") && !m.id.includes("transcribe"))
          .sort((a, b) => a.id.localeCompare(b.id));
        return { models: chatModels.map(m => ({ id: m.id, label: m.id })) };
      }

      if (providerId === "anthropic") {
        const apiKey = (await secretService.resolveSecret(secretRef)) || process.env.ANTHROPIC_API_KEY;
        if (!apiKey) return { models: [] };
        const res = await fetch("https://api.anthropic.com/v1/models", {
          headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
        });
        if (!res.ok) return { models: [] };
        const json = await res.json() as { data?: Array<{ id: string; display_name?: string }> };
        return {
          models: (json.data ?? []).map(m => ({ id: m.id, label: m.display_name ?? m.id }))
        };
      }

      if (providerId === "ollama") {
        const ollamaBase = (baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1").replace(/\/v1\/?$/, "");
        const res = await fetch(`${ollamaBase}/api/tags`);
        if (!res.ok) return { models: [] };
        const json = await res.json() as { models?: Array<{ name: string; modified_at?: string }> };
        return {
          models: (json.models ?? []).map(m => ({ id: m.name, label: m.name }))
        };
      }

      if (providerId === "openai_compatible") {
        if (!baseUrl) return { models: [] };
        const apiKey = await secretService.resolveSecret(secretRef);
        const headers: Record<string, string> = {};
        if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
        const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, { headers });
        if (!res.ok) return { models: [] };
        const json = await res.json() as { data?: Array<{ id: string }> };
        return { models: (json.data ?? []).map(m => ({ id: m.id, label: m.id })) };
      }

      if (providerId === "azure_openai") {
        const endpoint = (baseUrl ?? process.env.AZURE_OPENAI_ENDPOINT ?? "").replace(/\/+$/, "");
        const apiKey = (await secretService.resolveSecret(secretRef)) || process.env.AZURE_OPENAI_API_KEY;
        if (!endpoint || !apiKey) return { models: [] };
        const apiVersion = (typeof extra?.apiVersion === "string" && extra.apiVersion.trim()) ? extra.apiVersion.trim() : "2024-10-21";
        const res = await fetch(`${endpoint}/openai/models?api-version=${apiVersion}`, {
          headers: { "api-key": apiKey }
        });
        if (!res.ok) return { models: [] };
        const json = await res.json() as { data?: Array<{ id: string }> };
        return { models: (json.data ?? []).map(m => ({ id: m.id, label: m.id })) };
      }
    } catch {
      return { models: [] };
    }

    return { models: [] };
  });

  app.post<{ Body: unknown }>("/api/expressions/preview", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) {
      return;
    }

    const parsed = expressionPreviewSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid expression preview payload",
        details: parsed.error.issues
      };
    }

    const context = parsed.data.context ?? {};
    const expressionContext = {
      $input: context.input,
      $json: context.input,
      $workflow: context.workflow,
      $execution: { id: context.executionId ?? "", customData: asRecord(context.customData) },
      $vars: context.vars,
      $nodeOutputs: context.nodeOutputs,
      extras: {
        ...asRecord(context.input),
        vars: context.vars ?? {}
      }
    };

    try {
      const result =
        parsed.data.mode === "template" || parsed.data.expression.includes("{{")
          ? renderExpressionTemplate(parsed.data.expression, expressionContext)
          : evaluateExpression(parsed.data.expression, expressionContext);
      return {
        ok: true,
        result
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Expression preview failed"
      };
    }
  });

  app.get<{ Querystring: Record<string, unknown> }>("/api/executions", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) {
      return;
    }

    const query = asRecord(request.query);
    const page = Number(query.page);
    const pageSize = Number(query.pageSize);

    return store.listExecutionHistory({
      page: Number.isFinite(page) ? page : 1,
      pageSize: Number.isFinite(pageSize) ? pageSize : 20,
      status: typeof query.status === "string" && query.status.trim() ? query.status.trim() : undefined,
      workflowId: typeof query.workflowId === "string" && query.workflowId.trim() ? query.workflowId.trim() : undefined,
      triggerType:
        typeof query.triggerType === "string" && query.triggerType.trim() ? query.triggerType.trim() : undefined,
      startedFrom: normalizeIsoDateFilter(query.startedFrom),
      startedTo: normalizeIsoDateFilter(query.startedTo)
    });
  });

  app.get<{ Params: { id: string } }>("/api/executions/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) {
      return;
    }

    const execution = store.getExecutionHistory(request.params.id);
    if (!execution) {
      reply.code(404);
      return { error: "Execution not found" };
    }

    return execution;
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/executions/:id/retry", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) {
      return;
    }

    const sourceExecution = store.getExecutionHistory(request.params.id);
    if (!sourceExecution) {
      reply.code(404);
      return { error: "Execution not found" };
    }

    if (!["error", "partial", "canceled"].includes(sourceExecution.status)) {
      reply.code(409);
      return { error: "Only failed or canceled executions can be retried from history" };
    }

    const workflow = store.getWorkflow(sourceExecution.workflowId);
    if (!workflow) {
      reply.code(404);
      return { error: "Workflow not found" };
    }

    const parsed = workflowExecuteRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid retry payload",
        details: parsed.error.issues
      };
    }

    const prepared = prepareWorkflowExecutionPayload({
      ...parsed.data,
      sourceExecutionId: sourceExecution.id,
      usePinnedData: parsed.data.usePinnedData ?? true
    }, reply);
    if (!prepared) {
      return { error: "Source execution not found" };
    }

    const executionPayload = prepared.payload;
    const executionId = crypto.randomUUID();
    const progressHooks = createProgressTrackingHooks({
      executionId,
      workflow,
      triggerType: "manual_retry",
      triggeredBy: user.email,
      requestInput: prepared.requestInput,
      customData: executionPayload.customData
    });

    const result = await runWorkflowExecution({
      workflow,
      startNodeId: executionPayload.startNodeId,
      runMode: executionPayload.runMode,
      usePinnedData: executionPayload.usePinnedData,
      pinnedData: executionPayload.pinnedData,
      nodeOutputs: prepared.nodeOutputs,
      directInput: executionPayload.input,
      variables: executionPayload.variables,
      systemPrompt: executionPayload.system_prompt,
      userPrompt: executionPayload.user_prompt,
      sessionId: normalizeSessionId(executionPayload.sessionId, executionPayload.session_id),
      executionTimeoutMs: normalizeExecutionTimeoutMs(
        executionPayload.executionTimeoutMs,
        executionPayload.execution_timeout_ms,
        config.WORKFLOW_EXECUTION_TIMEOUT_MS
      ),
      customData: executionPayload.customData,
      executionId,
      triggerType: "manual_retry",
      triggeredBy: user.email,
      hooks: progressHooks
    });

    persistExecutionHistory({
      executionId,
      workflow,
      result,
      triggerType: "manual_retry",
      triggeredBy: user.email,
      requestInput: prepared.requestInput,
      customData: executionPayload.customData
    });

    if (result.status === "error") {
      reply.code(400);
    }

    return result;
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/executions/:id/cancel", async (request, reply) => {
    const user = await requireRole(request, reply, ["operator", "builder", "admin"]);
    if (!user) {
      return;
    }

    const execution = store.getExecutionHistory(request.params.id);
    if (!execution) {
      reply.code(404);
      return { error: "Execution not found" };
    }

    const cancelable =
      execution.status === "running" ||
      execution.status === "waiting_approval" ||
      (execution.status === "partial" && !execution.completedAt);
    if (!cancelable) {
      reply.code(409);
      return { error: "Only running or waiting executions can be canceled" };
    }

    const reasonRecord = asRecord(request.body);
    const reason =
      typeof reasonRecord.reason === "string" && reasonRecord.reason.trim()
        ? reasonRecord.reason.trim()
        : `Execution canceled by ${user.email}`;
    const active = activeExecutions.get(request.params.id);
    active?.controller.abort(reason);
    if (execution.status === "waiting_approval") {
      deleteWorkflowExecutionSafely(execution.id, execution.workflowId);
    }

    const completedAt = new Date().toISOString();
    const canceled = store.cancelExecutionHistory({
      id: request.params.id,
      completedAt,
      error: reason
    });
    if (!canceled) {
      reply.code(404);
      return { error: "Execution not found" };
    }

    return {
      ok: true,
      id: request.params.id,
      status: "canceled",
      abortedActiveRun: Boolean(active),
      completedAt
    };
  });

  app.get("/api/approvals", async (request, reply) => {
    const user = await requireRole(request, reply, ["operator"]);
    if (!user) {
      return;
    }

    return {
      items: store.listPendingApprovals()
    };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/approvals/:id/approve", async (request, reply) => {
    const user = await requireRole(request, reply, ["operator"]);
    if (!user) {
      return;
    }

    const pending = store.getWorkflowExecutionState(request.params.id);
    if (!pending || pending.status !== "waiting_approval") {
      reply.code(404);
      return { error: "Pending approval not found" };
    }

    const state = pending.state as WorkflowExecutionState | null;
    if (!state || typeof state !== "object" || !state.workflow) {
      reply.code(400);
      return { error: "Stored execution state is invalid and cannot be resumed" };
    }

    const result = await runWorkflowExecution({
      workflow: state.workflow,
      executionId: pending.id,
      triggerType: "approval_resume",
      triggeredBy: user.email,
      resumeState: state,
      approvalDecision: {
        decision: "approve",
        actedBy: user.email
      }
    });

    persistExecutionHistory({
      executionId: pending.id,
      workflow: state.workflow,
      result,
      triggerType: "approval_resume",
      triggeredBy: user.email,
      requestInput: { decision: "approve", approvalId: pending.id }
    });

    if (result.status === "error") {
      reply.code(400);
    }

    return result;
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/approvals/:id/reject", async (request, reply) => {
    const user = await requireRole(request, reply, ["operator"]);
    if (!user) {
      return;
    }

    const pending = store.getWorkflowExecutionState(request.params.id);
    if (!pending || pending.status !== "waiting_approval") {
      reply.code(404);
      return { error: "Pending approval not found" };
    }

    const parsed = approvalDecisionSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid rejection payload",
        details: parsed.error.issues
      };
    }

    const state = pending.state as WorkflowExecutionState | null;
    if (!state || typeof state !== "object" || !state.workflow) {
      reply.code(400);
      return { error: "Stored execution state is invalid and cannot be resumed" };
    }

    const result = await runWorkflowExecution({
      workflow: state.workflow,
      executionId: pending.id,
      triggerType: "approval_resume",
      triggeredBy: user.email,
      resumeState: state,
      approvalDecision: {
        decision: "reject",
        actedBy: user.email,
        reason: parsed.data.reason
      }
    });

    persistExecutionHistory({
      executionId: pending.id,
      workflow: state.workflow,
      result,
      triggerType: "approval_resume",
      triggeredBy: user.email,
      requestInput: { decision: "reject", approvalId: pending.id, reason: parsed.data.reason }
    });

    if (result.status === "error") {
      reply.code(400);
    }

    return result;
  });

  app.post<{ Body: unknown }>("/api/webhooks/execute", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) {
      return;
    }

    const parsed = agentWebhookPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid webhook payload",
        details: parsed.error.issues
      };
    }

    const workflow = await selectWebhookWorkflow(store, parsed.data.workflow_id);
    if (!workflow) {
      reply.code(404);
      return { error: "No workflows available" };
    }

    const executionId = crypto.randomUUID();
    const progressHooks = createProgressTrackingHooks({
      executionId,
      workflow,
      triggerType: "webhook_api",
      triggeredBy: user.email,
      requestInput: parsed.data,
      customData: parsed.data.customData
    });
    const result = await runWorkflowExecution({
      workflow,
      webhookPayload: {
        system_prompt: parsed.data.system_prompt,
        user_prompt: parsed.data.user_prompt,
        session_id: parsed.data.session_id,
        variables: parsed.data.variables
      },
      variables: parsed.data.variables,
      systemPrompt: parsed.data.system_prompt,
      userPrompt: parsed.data.user_prompt,
      sessionId: parsed.data.session_id,
      executionTimeoutMs: normalizeExecutionTimeoutMs(
        parsed.data.executionTimeoutMs,
        parsed.data.execution_timeout_ms,
        config.WORKFLOW_EXECUTION_TIMEOUT_MS
      ),
      customData: parsed.data.customData,
      executionId,
      triggerType: "webhook_api",
      triggeredBy: user.email,
      hooks: progressHooks
    });

    persistExecutionHistory({
      executionId,
      workflow,
      result,
      triggerType: "webhook_api",
      triggeredBy: user.email,
      requestInput: parsed.data,
      customData: parsed.data.customData
    });

    if (result.status === "error") {
      reply.code(400);
    }

    return {
      ...result,
      selectedWorkflowId: workflow.id
    };
  });

  // Slack Events API webhook — validates Slack signing secret.
  // Endpoint: POST /api/webhooks/slack/:workflowId
  app.post<{
    Params: { workflowId: string };
    Body: unknown;
  }>(
    "/api/webhooks/slack/:workflowId",
    { config: { rawBody: true } },
    async (request, reply) => {
      const workflow = store.getWorkflow(request.params.workflowId);
      if (!workflow) {
        reply.code(404);
        return { error: "Workflow not found" };
      }
      const slackNode = workflow.nodes.find((n) => n.type === "slack_trigger");
      if (!slackNode) {
        reply.code(400);
        return { error: "Workflow has no slack_trigger node" };
      }
      const rawBody = typeof request.rawBody === "string" ? request.rawBody : "";

      const secretRef = toSecretReference((slackNode.config as Record<string, unknown>).signingSecretRef);
      const signingSecret = await secretService.resolveSecret(secretRef);
      if (!signingSecret) {
        reply.code(500);
        return { error: "Slack signing secret not configured" };
      }
      const ts = getHeaderValue(request.headers, "x-slack-request-timestamp");
      const sig = getHeaderValue(request.headers, "x-slack-signature");
      if (!ts || !sig) {
        reply.code(401);
        return { error: "Missing Slack signature headers" };
      }
      const tsMs = Number(ts) * 1000;
      const tolerance = Number((slackNode.config as Record<string, unknown>).replayToleranceSeconds ?? 300) * 1000;
      if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > tolerance) {
        reply.code(401);
        return { error: "Slack timestamp outside tolerance" };
      }
      const basestring = `v0:${ts}:${rawBody}`;
      const expected = `v0=${crypto.createHmac("sha256", signingSecret).update(basestring).digest("hex")}`;
      if (!safeEqualSecret(expected, sig)) {
        reply.code(401);
        return { error: "Slack signature mismatch" };
      }

      // URL verification challenge handshake.
      const body = request.body as Record<string, unknown> | undefined;
      if (body && body.type === "url_verification" && typeof body.challenge === "string") {
        reply.type("text/plain");
        return body.challenge;
      }

      const executionId = crypto.randomUUID();
      const progressHooks = createProgressTrackingHooks({
        executionId,
        workflow,
        triggerType: "slack_webhook",
        triggeredBy: "slack",
        requestInput: body ?? {}
      });
      const result = await runWorkflowExecution({
        workflow,
        webhookPayload: (body as Record<string, unknown>) ?? {},
        executionId,
        triggerType: "slack_webhook",
        triggeredBy: "slack",
        hooks: progressHooks
      });
      persistExecutionHistory({
        executionId,
        workflow,
        result,
        triggerType: "slack_webhook",
        triggeredBy: "slack",
        requestInput: body ?? {}
      });
      return { ok: true, status: result.status };
    }
  );

  // GitHub webhook — validates X-Hub-Signature-256.
  app.post<{
    Params: { workflowId: string };
    Body: unknown;
  }>(
    "/api/webhooks/github/:workflowId",
    { config: { rawBody: true } },
    async (request, reply) => {
      const workflow = store.getWorkflow(request.params.workflowId);
      if (!workflow) {
        reply.code(404);
        return { error: "Workflow not found" };
      }
      const ghNode = workflow.nodes.find((n) => n.type === "github_webhook_trigger");
      if (!ghNode) {
        reply.code(400);
        return { error: "Workflow has no github_webhook_trigger node" };
      }
      const rawBody = typeof request.rawBody === "string" ? request.rawBody : "";
      const secretRef = toSecretReference((ghNode.config as Record<string, unknown>).secretRef);
      const secret = await secretService.resolveSecret(secretRef);
      if (!secret) {
        reply.code(500);
        return { error: "GitHub webhook secret not configured" };
      }
      const sig = getHeaderValue(request.headers, "x-hub-signature-256");
      if (!sig) {
        reply.code(401);
        return { error: "Missing X-Hub-Signature-256 header" };
      }
      const expected = `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
      if (!safeEqualSecret(expected, sig)) {
        reply.code(401);
        return { error: "GitHub signature mismatch" };
      }
      const body = request.body as Record<string, unknown> | undefined;
      const executionId = crypto.randomUUID();
      const progressHooks = createProgressTrackingHooks({
        executionId,
        workflow,
        triggerType: "github_webhook",
        triggeredBy: "github",
        requestInput: body ?? {}
      });
      const result = await runWorkflowExecution({
        workflow,
        webhookPayload: (body as Record<string, unknown>) ?? {},
        executionId,
        triggerType: "github_webhook",
        triggeredBy: "github",
        hooks: progressHooks
      });
      persistExecutionHistory({
        executionId,
        workflow,
        result,
        triggerType: "github_webhook",
        triggeredBy: "github",
        requestInput: body ?? {}
      });
      return { ok: true, status: result.status };
    }
  );

  // Phase 3.2 — Stripe webhook. Signature: t=<unix_seconds>,v1=<hex hmac-sha256(t.payload, secret)>
  app.post<{ Params: { workflowId: string }; Body: unknown }>(
    "/api/webhooks/stripe/:workflowId",
    { config: { rawBody: true } },
    async (request, reply) => {
      const workflow = store.getWorkflow(request.params.workflowId);
      if (!workflow) {
        reply.code(404);
        return { error: "Workflow not found" };
      }
      const stripeNode = workflow.nodes.find((n) => n.type === "stripe_webhook_trigger");
      if (!stripeNode) {
        reply.code(400);
        return { error: "Workflow has no stripe_webhook_trigger node" };
      }
      const rawBody = getRawRequestBody(request);
      const secretRef = toSecretReference((stripeNode.config as Record<string, unknown>).signingSecretRef);
      const signingSecret = await secretService.resolveSecret(secretRef);
      if (!signingSecret) {
        reply.code(500);
        return { error: "Stripe signing secret not configured" };
      }
      const sigHeader = getHeaderValue(request.headers, "stripe-signature");
      if (!sigHeader) {
        reply.code(401);
        return { error: "Missing Stripe-Signature header" };
      }
      const parts = sigHeader.split(",").map((p) => p.trim());
      const ts = parts.find((p) => p.startsWith("t="))?.slice(2) ?? "";
      const v1Signatures = parts.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
      if (!ts || v1Signatures.length === 0) {
        reply.code(401);
        return { error: "Malformed Stripe-Signature header" };
      }
      const tsMs = Number(ts) * 1000;
      const tolerance = Number((stripeNode.config as Record<string, unknown>).replayToleranceSeconds ?? 300) * 1000;
      if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > tolerance) {
        reply.code(401);
        return { error: "Stripe timestamp outside tolerance" };
      }
      const expected = crypto.createHmac("sha256", signingSecret).update(`${ts}.${rawBody}`).digest("hex");
      const matches = v1Signatures.some((sig) => safeEqualSecret(expected, sig));
      if (!matches) {
        reply.code(401);
        return { error: "Stripe signature mismatch" };
      }

      const body = request.body as Record<string, unknown> | undefined;
      const executionId = crypto.randomUUID();
      const progressHooks = createProgressTrackingHooks({
        executionId,
        workflow,
        triggerType: "stripe_webhook",
        triggeredBy: "stripe",
        requestInput: body ?? {}
      });
      const result = await runWorkflowExecution({
        workflow,
        webhookPayload: body ?? {},
        executionId,
        triggerType: "stripe_webhook",
        triggeredBy: "stripe",
        hooks: progressHooks
      });
      persistExecutionHistory({
        executionId,
        workflow,
        result,
        triggerType: "stripe_webhook",
        triggeredBy: "stripe",
        requestInput: body ?? {}
      });
      return { ok: true, status: result.status };
    }
  );

  // Phase 3.2 — Telegram webhook. Bot API sends X-Telegram-Bot-Api-Secret-Token if configured on setWebhook.
  app.post<{ Params: { workflowId: string }; Body: unknown }>(
    "/api/webhooks/telegram/:workflowId",
    { config: { rawBody: true } },
    async (request, reply) => {
      const workflow = store.getWorkflow(request.params.workflowId);
      if (!workflow) {
        reply.code(404);
        return { error: "Workflow not found" };
      }
      const tgNode = workflow.nodes.find((n) => n.type === "telegram_trigger");
      if (!tgNode) {
        reply.code(400);
        return { error: "Workflow has no telegram_trigger node" };
      }
      const secretRef = toSecretReference((tgNode.config as Record<string, unknown>).signingSecretRef);
      const configuredSecret = await secretService.resolveSecret(secretRef);
      if (configuredSecret) {
        const headerValue = getHeaderValue(request.headers, "x-telegram-bot-api-secret-token");
        if (!headerValue || !safeEqualSecret(configuredSecret, headerValue)) {
          reply.code(401);
          return { error: "Telegram secret token mismatch" };
        }
      }

      const body = request.body as Record<string, unknown> | undefined;
      const executionId = crypto.randomUUID();
      const progressHooks = createProgressTrackingHooks({
        executionId,
        workflow,
        triggerType: "telegram_webhook",
        triggeredBy: "telegram",
        requestInput: body ?? {}
      });
      const result = await runWorkflowExecution({
        workflow,
        webhookPayload: body ?? {},
        executionId,
        triggerType: "telegram_webhook",
        triggeredBy: "telegram",
        hooks: progressHooks
      });
      persistExecutionHistory({
        executionId,
        workflow,
        result,
        triggerType: "telegram_webhook",
        triggeredBy: "telegram",
        requestInput: body ?? {}
      });
      return { ok: true, status: result.status };
    }
  );

  // Phase 3.2 — Discord interactions webhook. Validates Ed25519 signature with the app's public key.
  app.post<{ Params: { workflowId: string }; Body: unknown }>(
    "/api/webhooks/discord/:workflowId",
    { config: { rawBody: true } },
    async (request, reply) => {
      const workflow = store.getWorkflow(request.params.workflowId);
      if (!workflow) {
        reply.code(404);
        return { error: "Workflow not found" };
      }
      const dcNode = workflow.nodes.find((n) => n.type === "discord_trigger");
      if (!dcNode) {
        reply.code(400);
        return { error: "Workflow has no discord_trigger node" };
      }
      const rawBody = getRawRequestBody(request);
      const nodeConfig = dcNode.config as Record<string, unknown>;
      const publicKeyHex = typeof nodeConfig.publicKey === "string" ? nodeConfig.publicKey.trim() : "";
      if (!publicKeyHex) {
        reply.code(500);
        return { error: "Discord publicKey not configured" };
      }
      const signature = getHeaderValue(request.headers, "x-signature-ed25519");
      const timestamp = getHeaderValue(request.headers, "x-signature-timestamp");
      if (!signature || !timestamp) {
        reply.code(401);
        return { error: "Missing Discord signature headers" };
      }
      try {
        const publicKey = Buffer.from(publicKeyHex, "hex");
        const sig = Buffer.from(signature, "hex");
        const message = Buffer.concat([Buffer.from(timestamp, "utf8"), Buffer.from(rawBody, "utf8")]);
        const keyObject = crypto.createPublicKey({
          key: Buffer.concat([
            Buffer.from("302a300506032b6570032100", "hex"), // SubjectPublicKeyInfo prefix for Ed25519
            publicKey
          ]),
          format: "der",
          type: "spki"
        });
        const verified = crypto.verify(null, message, keyObject, sig);
        if (!verified) {
          reply.code(401);
          return { error: "Discord signature mismatch" };
        }
      } catch (err) {
        reply.code(401);
        return { error: `Discord signature verification failed: ${err instanceof Error ? err.message : String(err)}` };
      }

      const body = request.body as Record<string, unknown> | undefined;
      // Discord interactions ping — must reply with type=1 immediately.
      if (body && body.type === 1) {
        return { type: 1 };
      }
      const executionId = crypto.randomUUID();
      const progressHooks = createProgressTrackingHooks({
        executionId,
        workflow,
        triggerType: "discord_webhook",
        triggeredBy: "discord",
        requestInput: body ?? {}
      });
      const result = await runWorkflowExecution({
        workflow,
        webhookPayload: body ?? {},
        executionId,
        triggerType: "discord_webhook",
        triggeredBy: "discord",
        hooks: progressHooks
      });
      persistExecutionHistory({
        executionId,
        workflow,
        result,
        triggerType: "discord_webhook",
        triggeredBy: "discord",
        requestInput: body ?? {}
      });
      return { ok: true, status: result.status };
    }
  );

  // ---------------------------------------------------------------------------
  // Phase 3.5 — Trigger endpoints
  // ---------------------------------------------------------------------------

  // Manual trigger — builder role, starts a workflow with payload merged as input.
  app.post<{ Params: { workflowId: string }; Body: unknown }>(
    "/api/triggers/manual/:workflowId",
    async (request, reply) => {
      const user = await requireRole(request, reply, ["builder"]);
      if (!user) return;
      const workflow = store.getWorkflow(request.params.workflowId);
      if (!workflow) {
        reply.code(404);
        return { error: "Workflow not found" };
      }
      const manualNode = workflow.nodes.find((n) => n.type === "manual_trigger");
      if (!manualNode) {
        reply.code(400);
        return { error: "Workflow has no manual_trigger node" };
      }
      const body = asRecord(request.body);
      const executionId = crypto.randomUUID();
      const progressHooks = createProgressTrackingHooks({
        executionId,
        workflow,
        triggerType: "manual",
        triggeredBy: user.email,
        requestInput: body
      });
      const result = await runWorkflowExecution({
        workflow,
        directInput: { trigger_type: "manual", trigger_node_id: manualNode.id, ...body },
        executionId,
        triggerType: "manual",
        triggeredBy: user.email,
        hooks: progressHooks
      });
      persistExecutionHistory({
        executionId,
        workflow,
        result,
        triggerType: "manual",
        triggeredBy: user.email,
        requestInput: body
      });
      return { ok: true, executionId, status: result.status, output: result.output };
    }
  );

  // Form trigger — GET renders an HTML form, POST processes submission.
  const findFormWorkflow = (formPath: string): { workflow: Workflow; node: WorkflowNode } | null => {
    for (const summary of store.listWorkflows()) {
      const wf = store.getWorkflow(summary.id);
      if (!wf) continue;
      for (const node of wf.nodes) {
        if (node.type !== "form_trigger") continue;
        const cfg = asRecord(node.config);
        if (typeof cfg.path === "string" && cfg.path.trim() === formPath) {
          return { workflow: wf, node };
        }
      }
    }
    return null;
  };

  const escapeHtml = (value: string): string =>
    value.replace(/[&<>"']/g, (c) =>
      c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"
    );

  const renderFormHtml = (node: WorkflowNode, formPath: string, successMsg?: string): string => {
    const cfg = asRecord(node.config);
    const title = escapeHtml(typeof cfg.title === "string" ? cfg.title : "Submit");
    const description = escapeHtml(typeof cfg.description === "string" ? cfg.description : "");
    const submitLabel = escapeHtml(typeof cfg.submitLabel === "string" ? cfg.submitLabel : "Submit");
    const fields = Array.isArray(cfg.fields) ? (cfg.fields as Array<Record<string, unknown>>) : [];
    const body = fields
      .map((f) => {
        const name = escapeHtml(String(f.name ?? ""));
        const label = escapeHtml(String(f.label ?? f.name ?? ""));
        const type = String(f.type ?? "text");
        const required = f.required === true ? " required" : "";
        const placeholder = escapeHtml(String(f.placeholder ?? ""));
        if (type === "textarea") {
          return `<label>${label}<textarea name="${name}" placeholder="${placeholder}"${required}></textarea></label>`;
        }
        if (type === "select") {
          const opts = Array.isArray(f.options) ? (f.options as string[]) : [];
          const optionsHtml = opts
            .map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`)
            .join("");
          return `<label>${label}<select name="${name}"${required}>${optionsHtml}</select></label>`;
        }
        if (type === "checkbox") {
          return `<label><input type="checkbox" name="${name}" value="true" /> ${label}</label>`;
        }
        const inputType = ["email", "number"].includes(type) ? type : "text";
        return `<label>${label}<input type="${inputType}" name="${name}" placeholder="${placeholder}"${required} /></label>`;
      })
      .join("");
    const success = successMsg
      ? `<div class="form-success">${escapeHtml(successMsg)}</div>`
      : "";
    return `<!doctype html>
<html><head><meta charset="utf-8" /><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 20px;}
form{display:flex;flex-direction:column;gap:12px;}
label{display:flex;flex-direction:column;gap:4px;font-size:14px;}
input,textarea,select{padding:8px;border:1px solid #ccc;border-radius:4px;font:inherit;}
textarea{min-height:120px;}
button{padding:10px 16px;background:#2b6cb0;color:#fff;border:none;border-radius:4px;cursor:pointer;}
.form-success{background:#def7ec;color:#0e542f;padding:12px;border-radius:4px;margin-bottom:16px;}</style>
</head><body><h1>${title}</h1>${description ? `<p>${description}</p>` : ""}${success}
<form method="POST" action="/api/forms/${escapeHtml(formPath)}">${body}<button type="submit">${submitLabel}</button></form>
</body></html>`;
  };

  app.get<{ Params: { path: string }; Querystring: Record<string, string> }>(
    "/api/forms/:path",
    async (request, reply) => {
      const found = findFormWorkflow(request.params.path);
      if (!found) {
        reply.code(404);
        reply.type("text/html");
        return "<h1>Form not found</h1>";
      }
      const cfg = asRecord(found.node.config);
      if (cfg.authMode === "session") {
        const user = await requireRole(request, reply, ["viewer"]);
        if (!user) return;
      }
      const successMsg =
        request.query?.submitted === "1" && typeof cfg.successMessage === "string"
          ? cfg.successMessage
          : undefined;
      reply.type("text/html");
      return renderFormHtml(found.node, request.params.path, successMsg);
    }
  );

  app.post<{ Params: { path: string }; Body: unknown }>(
    "/api/forms/:path",
    async (request, reply) => {
      const found = findFormWorkflow(request.params.path);
      if (!found) {
        reply.code(404);
        return { error: "Form not found" };
      }
      const cfg = asRecord(found.node.config);
      if (cfg.authMode === "session") {
        const user = await requireRole(request, reply, ["viewer"]);
        if (!user) return;
      }
      const submission = asRecord(request.body);
      const executionId = crypto.randomUUID();
      const progressHooks = createProgressTrackingHooks({
        executionId,
        workflow: found.workflow,
        triggerType: "form",
        triggeredBy: "form-submitter",
        requestInput: submission
      });
      const result = await runWorkflowExecution({
        workflow: found.workflow,
        directInput: {
          trigger_type: "form",
          trigger_node_id: found.node.id,
          form_path: request.params.path,
          form_submission: submission,
          submitted_at: new Date().toISOString(),
          ...submission
        },
        executionId,
        triggerType: "form",
        triggeredBy: "form-submitter",
        hooks: progressHooks
      });
      persistExecutionHistory({
        executionId,
        workflow: found.workflow,
        result,
        triggerType: "form",
        triggeredBy: "form-submitter",
        requestInput: submission
      });
      const accept = getHeaderValue(request.headers, "accept");
      if (accept.includes("text/html")) {
        reply.redirect(`/api/forms/${encodeURIComponent(request.params.path)}?submitted=1`, 303);
        return;
      }
      return { ok: true, executionId, status: result.status };
    }
  );

  // Chat trigger — accepts chat messages, optionally persists to session memory.
  app.post<{ Params: { workflowId: string }; Body: unknown }>(
    "/api/chat/:workflowId",
    async (request, reply) => {
      const workflow = store.getWorkflow(request.params.workflowId);
      if (!workflow) {
        reply.code(404);
        return { error: "Workflow not found" };
      }
      const chatNode = workflow.nodes.find((n) => n.type === "chat_trigger");
      if (!chatNode) {
        reply.code(400);
        return { error: "Workflow has no chat_trigger node" };
      }
      const cfg = asRecord(chatNode.config);
      const authMode = typeof cfg.authMode === "string" ? cfg.authMode : "public";
      if (authMode === "session") {
        const user = await requireRole(request, reply, ["viewer"]);
        if (!user) return;
      } else if (authMode === "bearer") {
        const secretRef = toSecretReference(cfg.secretRef);
        const secret = await secretService.resolveSecret(secretRef);
        if (!secret) {
          reply.code(500);
          return { error: "Chat bearer secret not configured" };
        }
        const header = getHeaderValue(request.headers, "authorization");
        const token = header.startsWith("Bearer ") ? header.slice(7) : "";
        if (!token || !safeEqualSecret(secret, token)) {
          reply.code(401);
          return { error: "Invalid bearer token" };
        }
      }
      const body = asRecord(request.body);
      const message =
        typeof body.message === "string"
          ? body.message
          : typeof body.text === "string"
            ? body.text
            : typeof body.user_prompt === "string"
              ? body.user_prompt
              : "";
      const sessionId =
        typeof body.session_id === "string" && body.session_id.trim()
          ? body.session_id.trim()
          : typeof body.sessionId === "string" && body.sessionId.trim()
            ? body.sessionId.trim()
            : crypto.randomUUID();
      const executionId = crypto.randomUUID();
      const progressHooks = createProgressTrackingHooks({
        executionId,
        workflow,
        triggerType: "chat",
        triggeredBy: "chat-client",
        requestInput: body
      });
      const result = await runWorkflowExecution({
        workflow,
        directInput: {
          trigger_type: "chat",
          trigger_node_id: chatNode.id,
          message,
          user_prompt: message,
          ...body
        },
        sessionId,
        userPrompt: message || undefined,
        executionId,
        triggerType: "chat",
        triggeredBy: "chat-client",
        hooks: progressHooks
      });
      persistExecutionHistory({
        executionId,
        workflow,
        result,
        triggerType: "chat",
        triggeredBy: "chat-client",
        requestInput: body
      });
      return {
        ok: true,
        executionId,
        status: result.status,
        session_id: sessionId,
        output: result.output
      };
    }
  );

  // MCP server trigger — expose workflow as a tool callable via HTTP.
  const findMcpServerWorkflow = (p: string): { workflow: Workflow; node: WorkflowNode } | null => {
    for (const summary of store.listWorkflows()) {
      const wf = store.getWorkflow(summary.id);
      if (!wf) continue;
      for (const node of wf.nodes) {
        if (node.type !== "mcp_server_trigger") continue;
        const cfg = asRecord(node.config);
        if (typeof cfg.path === "string" && cfg.path.trim() === p) {
          return { workflow: wf, node };
        }
      }
    }
    return null;
  };

  app.get<{ Params: { path: string } }>("/api/mcp-server/:path/manifest", async (request, reply) => {
    const found = findMcpServerWorkflow(request.params.path);
    if (!found) {
      reply.code(404);
      return { error: "MCP server not found" };
    }
    const cfg = asRecord(found.node.config);
    return {
      name: cfg.toolName ?? "",
      description: cfg.toolDescription ?? "",
      inputSchema: cfg.inputSchema ?? { type: "object" }
    };
  });

  app.post<{ Params: { path: string }; Body: unknown }>(
    "/api/mcp-server/:path/invoke",
    async (request, reply) => {
      const found = findMcpServerWorkflow(request.params.path);
      if (!found) {
        reply.code(404);
        return { error: "MCP server not found" };
      }
      const cfg = asRecord(found.node.config);
      if (cfg.authMode === "bearer") {
        const secret = await secretService.resolveSecret(toSecretReference(cfg.secretRef));
        if (!secret) {
          reply.code(500);
          return { error: "MCP bearer secret not configured" };
        }
        const header = getHeaderValue(request.headers, "authorization");
        const token = header.startsWith("Bearer ") ? header.slice(7) : "";
        if (!token || !safeEqualSecret(secret, token)) {
          reply.code(401);
          return { error: "Invalid bearer token" };
        }
      }
      const body = asRecord(request.body);
      const args = asRecord(body.arguments ?? body.args ?? body);
      const executionId = crypto.randomUUID();
      const progressHooks = createProgressTrackingHooks({
        executionId,
        workflow: found.workflow,
        triggerType: "mcp_server",
        triggeredBy: "mcp-client",
        requestInput: body
      });
      const result = await runWorkflowExecution({
        workflow: found.workflow,
        directInput: {
          trigger_type: "mcp_server",
          trigger_node_id: found.node.id,
          arguments: args,
          call_id: typeof body.call_id === "string" ? body.call_id : undefined,
          ...args
        },
        executionId,
        triggerType: "mcp_server",
        triggeredBy: "mcp-client",
        hooks: progressHooks
      });
      persistExecutionHistory({
        executionId,
        workflow: found.workflow,
        result,
        triggerType: "mcp_server",
        triggeredBy: "mcp-client",
        requestInput: body
      });
      if (result.status === "error") {
        reply.code(500);
        return { error: result.error ?? "mcp_server trigger execution failed" };
      }
      return {
        ok: true,
        executionId,
        result: result.output ?? null
      };
    }
  );

  app.post<{ Body: unknown }>("/api/webhooks/execute/stream", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) {
      return;
    }

    const parsed = agentWebhookPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid webhook payload",
        details: parsed.error.issues
      };
    }

    const workflow = await selectWebhookWorkflow(store, parsed.data.workflow_id);
    if (!workflow) {
      reply.code(404);
      return { error: "No workflows available" };
    }

    const executionId = crypto.randomUUID();
    let streamClosed = false;
    request.raw.on("close", () => {
      streamClosed = true;
    });

    const sendSseEvent = (event: string, payload: unknown) => {
      if (streamClosed) {
        return;
      }
      reply.raw.write(`event: ${event}\n`);
      const serialized = JSON.stringify(payload ?? null);
      for (const line of serialized.split("\n")) {
        reply.raw.write(`data: ${line}\n`);
      }
      reply.raw.write("\n");
    };

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });
    if (typeof reply.raw.flushHeaders === "function") {
      reply.raw.flushHeaders();
    }

    try {
      const progressHooks = createProgressTrackingHooks({
        executionId,
        workflow,
        triggerType: "webhook_api_stream",
        triggeredBy: user.email,
        requestInput: parsed.data,
        passthroughHooks: {
          onNodeStart: (event) => {
            sendSseEvent("node_start", event);
          },
          onNodeComplete: (event) => {
            sendSseEvent("node_complete", event);
          },
          onLLMDelta: (event) => {
            sendSseEvent("llm_delta", event);
          }
        }
      });
      const result = await runWorkflowExecution({
        workflow,
        webhookPayload: {
          system_prompt: parsed.data.system_prompt,
          user_prompt: parsed.data.user_prompt,
          session_id: parsed.data.session_id,
          variables: parsed.data.variables
        },
        variables: parsed.data.variables,
        systemPrompt: parsed.data.system_prompt,
        userPrompt: parsed.data.user_prompt,
        sessionId: parsed.data.session_id,
        executionTimeoutMs: normalizeExecutionTimeoutMs(
          parsed.data.executionTimeoutMs,
          parsed.data.execution_timeout_ms,
          config.WORKFLOW_EXECUTION_TIMEOUT_MS
        ),
        executionId,
        triggerType: "webhook_api_stream",
        triggeredBy: user.email,
        hooks: progressHooks
      });

      persistExecutionHistory({
        executionId,
        workflow,
        result,
        triggerType: "webhook_api_stream",
        triggeredBy: user.email,
        requestInput: parsed.data
      });

      sendSseEvent("result", result);
      if (result.status === "error") {
        sendSseEvent("error", { message: result.error ?? "Execution failed" });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Execution failed";
      sendSseEvent("error", { message });
    } finally {
      if (!streamClosed) {
        reply.raw.end();
      }
    }
  });

  const registerConfiguredWebhookRoute = (routePath: "/webhook/:path" | "/webhook-test/:path") => {
    const isTestRoute = routePath.startsWith("/webhook-test");
    app.route<{ Params: { path: string }; Body: unknown }>({
      method: ["DELETE", "GET", "OPTIONS", "PATCH", "POST", "PUT"],
      url: routePath,
      config: {
        rawBody: true
      },
      handler: async (request, reply) => {
        reply.header("Access-Control-Allow-Origin", "*");
        reply.header("Access-Control-Allow-Methods", "DELETE, GET, OPTIONS, PATCH, POST, PUT");
        reply.header(
          "Access-Control-Allow-Headers",
          "content-type,authorization,x-webhook-signature,x-webhook-timestamp,idempotency-key"
        );

        if (request.method === "OPTIONS") {
          reply.code(204);
          return null;
        }

        const match = await selectWebhookByPath(store, request.params.path, request.method);
        if (!match) {
          const pathMatches = await listWebhookEndpointMatchesByPath(store, request.params.path);
          if (pathMatches.length > 0) {
            const allowedMethods = [...new Set(pathMatches.map((entry) => entry.method))];
            reply.code(405);
            reply.header("Allow", allowedMethods.join(", "));
            return {
              error: "Webhook endpoint exists but method does not match.",
              path: request.params.path,
              method: request.method,
              allowedMethods,
              matches: pathMatches
            };
          }
          const allEndpoints = await listAllWebhookEndpoints(store);
          const methodMatches = allEndpoints.filter((entry) => entry.method === request.method).slice(0, 20);
          reply.code(404);
          return {
            error: "No webhook endpoint matches this path and method",
            path: request.params.path,
            method: request.method,
            hint: "Ensure workflow is saved and webhook node path/method match this request.",
            availableEndpoints: methodMatches
          };
        }

        const security = normalizeWebhookSecurityConfig(match.endpoint.config);
        const endpointKey = `${isTestRoute ? "test" : "prod"}:${match.workflow.id}:${match.endpoint.nodeId}:${match.endpoint.method}:${match.endpoint.path.toLowerCase()}`;
        const rawBody = getRawRequestBody(request as unknown as { rawBody?: unknown; body: unknown });

        const authResult = await verifyWebhookRequestAuth({
          security,
          headers: request.headers as Record<string, unknown>,
          rawBody,
          endpointKey,
          store,
          secretService
        });

        if (!authResult.ok) {
          reply.code(authResult.statusCode);
          return { error: authResult.message };
        }

        const parsedInput = parseWebhookRunInput(request.body);

        let idempotencyKey: string | undefined;
        let replayingExistingResult = false;
        if (security.idempotencyEnabled) {
          store.clearExpiredWebhookSecurityState();
          idempotencyKey = getHeaderValue(request.headers as Record<string, unknown>, security.idempotencyHeaderName);
          if (!idempotencyKey) {
            reply.code(400);
            return {
              error: `Missing required idempotency header '${security.idempotencyHeaderName}'.`
            };
          }

          const now = Date.now();
          const requestHash = computeSha256Hex(rawBody);
          const existing = store.getWebhookIdempotency({
            endpointKey,
            idempotencyKey
          });

          if (existing) {
            if (existing.requestHash !== requestHash) {
              reply.code(409);
              return {
                error: "Idempotency key already used with a different request payload."
              };
            }

            if (existing.status === "pending") {
              reply.code(409);
              return {
                error: "Request with this idempotency key is already in progress."
              };
            }

            if (existing.result !== undefined && existing.result !== null) {
              const existingResultRecord =
                existing.result && typeof existing.result === "object"
                  ? (existing.result as Record<string, unknown>)
                  : null;
              const cachedWebhookResponse = (() => {
                const raw = existingResultRecord?.__webhookHttpResponse;
                if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
                  return null;
                }
                const asRecord = raw as Record<string, unknown>;
                const statusCode =
                  typeof asRecord.statusCode === "number" && Number.isFinite(asRecord.statusCode)
                    ? Math.max(100, Math.min(599, Math.floor(asRecord.statusCode)))
                    : 200;
                const headers: Record<string, string> = {};
                if (asRecord.headers && typeof asRecord.headers === "object" && !Array.isArray(asRecord.headers)) {
                  for (const [key, value] of Object.entries(asRecord.headers as Record<string, unknown>)) {
                    headers[key] = String(value);
                  }
                }
                return {
                  statusCode,
                  headers,
                  body: asRecord.body
                };
              })();

              replayingExistingResult = true;
              if (cachedWebhookResponse) {
                reply.code(cachedWebhookResponse.statusCode);
                for (const [headerName, headerValue] of Object.entries(cachedWebhookResponse.headers)) {
                  reply.header(headerName, headerValue);
                }
                return cachedWebhookResponse.body;
              }

              if (existingResultRecord) {
                return {
                  ...existingResultRecord,
                  idempotency: {
                    key: idempotencyKey,
                    reused: true
                  }
                };
              }
              return {
                output: existing.result,
                idempotency: {
                  key: idempotencyKey,
                  reused: true
                }
              };
            }
          }

          const idempotencyExpiry = new Date(now + DEFAULT_IDEMPOTENCY_TTL_SECONDS * 1000).toISOString();
          try {
            store.saveWebhookIdempotencyPending({
              endpointKey,
              idempotencyKey,
              requestHash,
              expiresAt: idempotencyExpiry
            });
          } catch {
            const latest = store.getWebhookIdempotency({
              endpointKey,
              idempotencyKey
            });
            if (latest && latest.requestHash !== requestHash) {
              reply.code(409);
              return {
                error: "Idempotency key already used with a different request payload."
              };
            }
            if (latest && latest.status === "pending") {
              reply.code(409);
              return {
                error: "Request with this idempotency key is already in progress."
              };
            }
            if (latest?.result !== undefined && latest.result !== null) {
              const latestRecord =
                latest.result && typeof latest.result === "object"
                  ? (latest.result as Record<string, unknown>)
                  : null;
              const cachedWebhookResponse = (() => {
                const raw = latestRecord?.__webhookHttpResponse;
                if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
                  return null;
                }
                const asRecord = raw as Record<string, unknown>;
                const statusCode =
                  typeof asRecord.statusCode === "number" && Number.isFinite(asRecord.statusCode)
                    ? Math.max(100, Math.min(599, Math.floor(asRecord.statusCode)))
                    : 200;
                const headers: Record<string, string> = {};
                if (asRecord.headers && typeof asRecord.headers === "object" && !Array.isArray(asRecord.headers)) {
                  for (const [key, value] of Object.entries(asRecord.headers as Record<string, unknown>)) {
                    headers[key] = String(value);
                  }
                }
                return {
                  statusCode,
                  headers,
                  body: asRecord.body
                };
              })();

              if (cachedWebhookResponse) {
                reply.code(cachedWebhookResponse.statusCode);
                for (const [headerName, headerValue] of Object.entries(cachedWebhookResponse.headers)) {
                  reply.header(headerName, headerValue);
                }
                return cachedWebhookResponse.body;
              }

              if (latestRecord) {
                return {
                  ...latestRecord,
                  idempotency: {
                    key: idempotencyKey,
                    reused: true
                  }
                };
              }
              return {
                output: latest.result,
                idempotency: {
                  key: idempotencyKey,
                  reused: true
                }
              };
            }
          }
        }

        const executionId = crypto.randomUUID();
        const triggerType = isTestRoute ? "webhook_test" : "webhook";
        const progressHooks = createProgressTrackingHooks({
          executionId,
          workflow: match.workflow,
          triggerType,
          triggeredBy: "webhook",
          requestInput: parsedInput.body
        });
        const result = await runWorkflowExecution({
          workflow: match.workflow,
          webhookPayload: {
            ...parsedInput.body,
            ...(parsedInput.systemPrompt ? { system_prompt: parsedInput.systemPrompt } : {}),
            ...(parsedInput.userPrompt ? { user_prompt: parsedInput.userPrompt } : {}),
            session_id: parsedInput.sessionId,
            variables: parsedInput.variables
          },
          variables: parsedInput.variables,
          systemPrompt: parsedInput.systemPrompt,
          userPrompt: parsedInput.userPrompt,
          sessionId: parsedInput.sessionId,
          executionTimeoutMs: parsedInput.executionTimeoutMs,
          executionId,
          triggerType,
          triggeredBy: "webhook",
          hooks: progressHooks
        });

        persistExecutionHistory({
          executionId,
          workflow: match.workflow,
          result,
          triggerType,
          triggeredBy: "webhook",
          requestInput: parsedInput.body
        });

        const defaultResponsePayload = {
          output: result.output ?? null,
          error: result.status === "error" ? (result.error ?? "Workflow execution failed") : undefined,
          idempotency: security.idempotencyEnabled
            ? {
                key: idempotencyKey ?? null,
                reused: replayingExistingResult
              }
            : undefined
        };

        const webhookOverride = parseWebhookResponseOverride(result.output);
        const responsePayload = webhookOverride
          ? webhookOverride.body
          : defaultResponsePayload;

        if (webhookOverride) {
          reply.code(webhookOverride.statusCode);
          for (const [headerName, headerValue] of Object.entries(webhookOverride.headers)) {
            reply.header(headerName, headerValue);
          }
        } else if (result.status === "error") {
          reply.code(400);
        }

        if (security.idempotencyEnabled && idempotencyKey) {
          store.saveWebhookIdempotencyResult({
            endpointKey,
            idempotencyKey,
            status: result.status,
            result: webhookOverride
              ? {
                  __webhookHttpResponse: {
                    statusCode: webhookOverride.statusCode,
                    headers: webhookOverride.headers,
                    body: webhookOverride.body
                  }
                }
              : responsePayload
          });
        }

        return responsePayload;
      }
    });
  };

  registerConfiguredWebhookRoute("/webhook/:path");
  registerConfiguredWebhookRoute("/webhook-test/:path");

  // ── Phase 7.3: Credential schema ────────────────────────────────────

  app.get("/api/secrets/schema", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const dynamicProviders = providerRegistry.listDefinitions().map((p) => ({
      id: p.id,
      label: p.label ?? p.id,
      fields: [{ name: "value", type: "password" as const, label: "API Key" }]
    }));
    const staticProviders = [
      { id: "slack", label: "Slack", fields: [{ name: "value", type: "password" as const, label: "Bot Token / Signing Secret" }] },
      { id: "github", label: "GitHub", fields: [{ name: "value", type: "password" as const, label: "Personal Access Token" }] },
      { id: "custom", label: "Custom", fields: [{ name: "value", type: "password" as const, label: "Secret Value" }] }
    ];
    const seenIds = new Set(dynamicProviders.map((p) => p.id));
    const combined = [...dynamicProviders];
    for (const sp of staticProviders) {
      if (!seenIds.has(sp.id)) combined.push(sp);
    }
    return { providers: combined };
  });

  app.post<{ Body: unknown }>("/api/secrets", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) {
      return;
    }

    const parsed = secretCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid secret payload",
        details: parsed.error.issues
      };
    }

    let secretRef;
    let source: "local" | "external" = "local";
    if (parsed.data.externalProviderId && parsed.data.externalKey) {
      const provider = externalSecretsService.getProvider(parsed.data.externalProviderId);
      if (!provider) {
        reply.code(400);
        return { error: "Unknown externalProviderId" };
      }
      secretRef = secretService.createExternalSecret({
        name: parsed.data.name,
        provider: parsed.data.provider,
        externalProviderId: parsed.data.externalProviderId,
        externalKey: parsed.data.externalKey,
        projectId: parsed.data.projectId
      });
      source = "external";
    } else {
      secretRef = secretService.createSecret({
        name: parsed.data.name,
        provider: parsed.data.provider,
        value: parsed.data.value as string,
        projectId: parsed.data.projectId
      });
    }
    audit(request, user, {
      category: "secret",
      eventType: source === "external" ? "secret.create.external" : "secret.create",
      action: "create",
      resourceType: "secret",
      resourceId: secretRef.secretId,
      projectId: parsed.data.projectId ?? "default",
      metadata: {
        name: parsed.data.name,
        provider: parsed.data.provider,
        source,
        externalProviderId: parsed.data.externalProviderId ?? undefined
      }
    });
    return {
      id: secretRef.secretId,
      name: parsed.data.name,
      provider: parsed.data.provider,
      projectId: parsed.data.projectId ?? "default",
      source
    };
  });

  app.delete<{ Params: { id: string } }>("/api/secrets/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const row = store.getSecret(request.params.id);
    if (!row) {
      reply.code(404);
      return { error: "Secret not found" };
    }
    secretService.deleteSecret(request.params.id);
    audit(request, user, {
      category: "secret",
      eventType: "secret.delete",
      action: "delete",
      resourceType: "secret",
      resourceId: request.params.id,
      projectId: row.projectId,
      metadata: { name: row.name, provider: row.provider, source: row.source }
    });
    return { ok: true };
  });

  app.get<{ Querystring: { projectId?: string } }>("/api/secrets", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) {
      return;
    }
    const projectId =
      typeof request.query?.projectId === "string" && request.query.projectId.trim()
        ? request.query.projectId
        : undefined;

    return secretService.listSecrets({ projectId });
  });

  app.post<{ Body: unknown }>("/api/mcp/discover-tools", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) {
      return;
    }

    const parsed = mcpDiscoverSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid MCP discover payload",
        details: parsed.error.issues
      };
    }

    try {
      const serverConfig: MCPServerConfig = {
        serverId: parsed.data.serverId,
        label: parsed.data.label,
        connection: parsed.data.connection,
        secretRef: parsed.data.secretRef,
        allowedTools: parsed.data.allowedTools
      };

      const tools = await mcpRegistry.get(parsed.data.serverId).discoverTools(serverConfig, {
        resolveSecret: (secretRef) => secretService.resolveSecret(secretRef)
      });

      return {
        serverId: parsed.data.serverId,
        tools
      };
    } catch (error) {
      reply.code(400);
      return {
        error: error instanceof Error ? error.message : "Failed to discover MCP tools"
      };
    }
  });

  // -------------------------------------------------------------------------
  // Queue endpoints
  // -------------------------------------------------------------------------

  if (queueService) {
    queueService.setHandler(async (payload) => {
      const workflow = store.getWorkflow(payload.workflowId);
      if (!workflow) {
        throw new Error(`Workflow not found: ${payload.workflowId}`);
      }
      const startedAt = new Date().toISOString();
      const result = await runWorkflowExecution({
        workflow,
        executionId: payload.executionId,
        directInput: payload.input,
        variables: payload.variables,
        systemPrompt: payload.systemPrompt,
        userPrompt: payload.userPrompt,
        sessionId: payload.sessionId,
        triggerType: payload.triggerType ?? "queue",
        triggeredBy: payload.triggeredBy,
        executionTimeoutMs: payload.executionTimeoutMs,
        customData: payload.customData
      });
      persistExecutionHistory({
        executionId: payload.executionId,
        workflow,
        result,
        triggerType: payload.triggerType ?? "queue",
        triggeredBy: payload.triggeredBy,
        requestInput: payload.input,
        customData: payload.customData
      });
      app.log.info(
        { executionId: payload.executionId, workflowId: payload.workflowId, status: result.status },
        "Queued workflow execution completed"
      );
    });

    queueService.start();

    app.addHook("onClose", async () => {
      queueService.stop();
    });

    app.get("/api/queue/depth", async (request, reply) => {
      const user = await requireRole(request, reply, ["operator", "builder", "admin"]);
      if (!user) return;
      return queueService.getDepth();
    });

    app.get("/api/queue/dlq", async (request, reply) => {
      const user = await requireRole(request, reply, ["operator", "builder", "admin"]);
      if (!user) return;
      const limit = typeof (request.query as Record<string, unknown>).limit === "string"
        ? Math.min(200, Math.max(1, Number((request.query as Record<string, unknown>).limit)))
        : 50;
      return queueService.listDlq(limit);
    });

    app.post<{ Params: { id: string }; Body: unknown }>(
      "/api/workflows/:id/enqueue",
      async (request, reply) => {
        const user = await requireRole(request, reply, ["operator", "builder", "admin"]);
        if (!user) return;

        const workflow = store.getWorkflow(request.params.id);
        if (!workflow) {
          reply.code(404);
          return { error: "Workflow not found" };
        }

        const body = asRecord(request.body);
        const executionId = await queueService.enqueue({
          workflowId: workflow.id,
          input: body.input && typeof body.input === "object" && !Array.isArray(body.input)
            ? (body.input as Record<string, unknown>)
            : undefined,
          variables: body.variables && typeof body.variables === "object" && !Array.isArray(body.variables)
            ? (body.variables as Record<string, unknown>)
            : undefined,
          systemPrompt: typeof body.systemPrompt === "string" ? body.systemPrompt : undefined,
          userPrompt: typeof body.userPrompt === "string" ? body.userPrompt : undefined,
          sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
          triggerType: typeof body.triggerType === "string" ? body.triggerType : "api_queue",
          triggeredBy: typeof body.triggeredBy === "string" ? body.triggeredBy : user.email,
          executionTimeoutMs: typeof body.executionTimeoutMs === "number" ? body.executionTimeoutMs : undefined,
          customData: body.customData && typeof body.customData === "object" && !Array.isArray(body.customData)
            ? (body.customData as Record<string, unknown>)
            : undefined,
          priority: typeof body.priority === "number" ? body.priority : 0
        });

        const depth = queueService.getDepth();
        return { queued: true, executionId, queueDepth: depth };
      }
    );
  }

  // ── Phase 7.3: Tag management ─────────────────────────────────────────

  app.get("/api/tags", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder", "operator", "viewer"]);
    if (!user) return;
    const workflows = store.listWorkflows();
    const tagSet = new Set<string>();
    for (const w of workflows) {
      if (Array.isArray(w.tags)) {
        for (const t of w.tags) {
          if (typeof t === "string") tagSet.add(t);
        }
      }
    }
    return { tags: [...tagSet].sort() };
  });

  app.post<{ Body: unknown }>("/api/tags", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const schema = z.object({ name: z.string().min(1).max(100) });
    const parsed = schema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid tag name", details: parsed.error.issues };
    }
    audit(request, user, {
      category: "workflow",
      eventType: "tag.create",
      action: "create",
      resourceType: "tag",
      resourceId: parsed.data.name
    });
    return { ok: true, tag: parsed.data.name };
  });

  app.delete<{ Params: { tag: string } }>("/api/tags/:tag", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const tagToRemove = decodeURIComponent(request.params.tag);
    const workflows = store.listWorkflows();
    let removedCount = 0;
    for (const w of workflows) {
      if (Array.isArray(w.tags) && w.tags.includes(tagToRemove)) {
        const full = store.getWorkflow(w.id);
        if (full) {
          full.tags = (full.tags ?? []).filter((t) => t !== tagToRemove);
          store.upsertWorkflow(full);
          removedCount++;
        }
      }
    }
    audit(request, user, {
      category: "workflow",
      eventType: "tag.delete",
      action: "delete",
      resourceType: "tag",
      resourceId: tagToRemove,
      metadata: { removedFromWorkflows: removedCount }
    });
    return { ok: true, tag: tagToRemove, removedFromWorkflows: removedCount };
  });

  // ── Phase 7.3: User management (admin only) ─────────────────────────

  app.get("/api/users", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const users = store.listUsers();
    return {
      users: users.map((u) => ({
        id: u.id,
        email: u.email,
        role: u.role,
        createdAt: u.createdAt
      }))
    };
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/api/users/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const schema = z.object({ role: z.enum(["admin", "builder", "operator", "viewer"]) });
    const parsed = schema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid payload", details: parsed.error.issues };
    }
    const targetUser = store.getUserById(request.params.id);
    if (!targetUser) {
      reply.code(404);
      return { error: "User not found" };
    }
    const updated = store.updateUserRole(request.params.id, parsed.data.role);
    if (!updated) {
      reply.code(500);
      return { error: "Failed to update user" };
    }
    audit(request, user, {
      category: "auth",
      eventType: "user.update.role",
      action: "update",
      resourceType: "user",
      resourceId: request.params.id,
      metadata: { previousRole: targetUser.role, newRole: parsed.data.role }
    });
    return { ok: true, userId: request.params.id, role: parsed.data.role };
  });

  app.delete<{ Params: { id: string } }>("/api/users/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    if (user.id === request.params.id) {
      reply.code(400);
      return { error: "Cannot delete your own account" };
    }
    const targetUser = store.getUserById(request.params.id);
    if (!targetUser) {
      reply.code(404);
      return { error: "User not found" };
    }
    const deleted = store.deleteUser(request.params.id);
    if (!deleted) {
      reply.code(500);
      return { error: "Failed to delete user" };
    }
    audit(request, user, {
      category: "auth",
      eventType: "user.delete",
      action: "delete",
      resourceType: "user",
      resourceId: request.params.id,
      metadata: { email: targetUser.email }
    });
    return { ok: true, userId: request.params.id };
  });

  // ── Phase 7.3: OpenAPI spec & Swagger UI ──────────────────────────────
  app.get("/api/openapi.json", async () => openApiSpec);

  app.get("/api/docs", async (_request, reply) => {
    reply.type("text/html");
    return `<!DOCTYPE html>
<html><head><title>AI Orchestrator API</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css">
</head><body>
<div id="swagger-ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({ url: "/api/openapi.json", dom_id: "#swagger-ui" })</script>
</body></html>`;
  });

  app.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    app.log.error({ err: secretService.redact(message) }, "Unhandled API error");
    reply.code(500).send({
      error: "Internal server error"
    });
  });

  return app;
}
