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

const secretCreateSchema = z.object({
  name: z.string().min(1),
  provider: z.string().min(1),
  value: z.string().min(1),
  projectId: z.string().min(1).max(120).optional()
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
      executionId: z.string().optional()
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
  const app = Fastify({ logger: true });
  const providerRegistry = createDefaultProviderRegistry();
  const connectorRegistry = createDefaultConnectorRegistry();
  const mcpRegistry = createDefaultMCPRegistry();
  const agentRuntime = createDefaultAgentRuntime();

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
    try {
      store.saveExecutionHistory(record);
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
    resumeState?: WorkflowExecutionState;
    approvalDecision?: {
      decision: "approve" | "reject";
      actedBy?: string;
      reason?: string;
    };
    hooks?: WorkflowExecutionEventHooks;
  }) => {
    return executeWorkflow(
      {
        workflow: input.workflow,
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
        onLLMDelta: input.hooks?.onLLMDelta
      }
    );
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

  const getSessionIdFromRequest = (request: { cookies: Record<string, string | undefined> }) => {
    return request.cookies[config.SESSION_COOKIE_NAME] ?? "";
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
    request: { cookies: Record<string, string | undefined> },
    reply: FastifyReply,
    allowedRoles: UserRole[]
  ): Promise<SafeUser | null> => {
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

  app.get("/health", async () => {
    return {
      ok: true,
      now: new Date().toISOString()
    };
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
      return { user };
    } catch (error) {
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
      setSessionCookie(reply, result.sessionId);
      return {
        user: result.user,
        expiresAt: result.expiresAt
      };
    } catch (error) {
      reply.code(401);
      return {
        error: error instanceof Error ? error.message : "Invalid credentials"
      };
    }
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const sessionId = getSessionIdFromRequest(request);
    if (sessionId) {
      authService.logout(sessionId);
    }
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get("/api/auth/me", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) {
      return;
    }
    return { user };
  });

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
    return { integrations: TIER1_INTEGRATIONS };
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
    schedulerService?.reloadWorkflow(savedWorkflow.id);
    triggerService?.reloadWorkflow(savedWorkflow.id);
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
    schedulerService?.reloadWorkflow(savedWorkflow.id);
    triggerService?.reloadWorkflow(savedWorkflow.id);
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
      requestInput: prepared.requestInput
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
      requestInput: prepared.requestInput
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
        requestInput: prepared.requestInput
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
        {
          resolveSecret: (secretRef) => secretService.resolveSecret(secretRef)
        }
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
      $execution: { id: context.executionId ?? "" },
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
        typeof query.triggerType === "string" && query.triggerType.trim() ? query.triggerType.trim() : undefined
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
      requestInput: parsed.data
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
      requestInput: parsed.data
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

    const secretRef = secretService.createSecret(parsed.data);
    return {
      id: secretRef.secretId,
      name: parsed.data.name,
      provider: parsed.data.provider,
      projectId: parsed.data.projectId ?? "default"
    };
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
        executionTimeoutMs: payload.executionTimeoutMs
      });
      persistExecutionHistory({
        executionId: payload.executionId,
        workflow,
        result,
        triggerType: payload.triggerType ?? "queue",
        triggeredBy: payload.triggeredBy,
        requestInput: payload.input
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
          priority: typeof body.priority === "number" ? body.priority : 0
        });

        const depth = queueService.getDepth();
        return { queued: true, executionId, queueDepth: depth };
      }
    );
  }

  app.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    app.log.error({ err: secretService.redact(message) }, "Unhandled API error");
    reply.code(500).send({
      error: "Internal server error"
    });
  });

  return app;
}
