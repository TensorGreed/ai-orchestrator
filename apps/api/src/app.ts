import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyRawBody from "fastify-raw-body";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { nanoid } from "nanoid";
import { z } from "zod";
import { createDefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import {
  ContainerSandboxLauncher,
  McpRuntimeGuard,
  createDefaultMCPRegistry,
  detectContainerRuntime,
  invokeDirectMCPTool,
  sweepSandboxContainers,
  validateSandboxMounts,
  withDelegatedUser,
  type MCPExecutionContext,
  type McpSandboxPolicy
} from "@ai-orchestrator/mcp-sdk";
import { createDefaultProviderRegistry } from "@ai-orchestrator/provider-sdk";
import {
  agentWebhookPayloadSchema,
  MCP_POLICY_ROLES,
  mcpOAuthConnectSchema,
  DEFAULT_PROJECT_ID,
  mcpRuntimeLimitsSchema,
  mcpSandboxSettingsSchema,
  type McpBreakerTransition,
  type McpMyConnection,
  type McpRuntimeStateView,
  type McpSandboxPolicyView,
  type McpSandboxSettings,
  mcpToolClassificationSchema,
  mcpSamplingSettingsPatchSchema,
  mcpToolPolicyEvaluateSchema,
  mcpToolPolicyRuleInputSchema,
  mcpToolPolicyRuleUpdateSchema,
  NODE_ACTIVITY_LIMIT,
  nodeDefinitions,
  workflowExecuteRequestSchema,
  workflowSchema,
  type LLMProviderConfig,
  type McpPolicyRole,
  type McpToolAnnotations,
  type McpToolPolicyRule,
  type McpToolPolicySubject,
  type McpToolProgressEvent,
  type McpElicitationView,
  type MCPServerConfig,
  type NodeActivityEvent,
  type NodeProgressSnapshot,
  type SecretReference,
  type Workflow,
  type WorkflowExecutionState,
  type WorkflowNode,
  ErrorCategory,
  WorkflowError
} from "@ai-orchestrator/shared";
import {
  executeCodeNodeSandbox,
  executeWorkflow,
  evaluateExpression,
  exportWorkflowToJson,
  importWorkflowFromJson,
  renderExpressionTemplate,
  runWithSandboxOwner,
  validateWorkflowGraph,
  KnowledgeBaseVectorStoreAdapter,
  TokenEmbeddingAdapter,
  OpenAIEmbeddingAdapter,
  AzureOpenAIEmbeddingAdapter,
  CohereEmbeddingAdapter,
  MistralEmbeddingAdapter,
  GoogleVertexEmbeddingAdapter,
  HuggingFaceEmbeddingAdapter,
  chunkDocuments,
  convertExternalWorkflow,
  ExternalWorkflowImportError,
  type ChunkOptions,
  type EmbeddingAdapter,
  type KnowledgeBaseStore,
  type ReplayNodeHook
} from "@ai-orchestrator/workflow-engine";
import { loadDocuments, inferDocumentKind, type DocumentKind } from "./services/document-loader-service";
import { SqliteStore, type McpServerRecord } from "./db/database";
import { PostgresStore } from "./db/postgres-store.js";
import type { AppConfig } from "./config";
import { SecretService } from "./services/secret-service";
import { McpCatalogService } from "./services/mcp-catalog.js";
import { computeTemplateDependencies } from "./services/template-dependencies";
import { buildTemplateThumbnail } from "./services/template-thumbnail";
import { FEATURED_TEMPLATE_IDS } from "./services/seed-service";
import { CommunityPackageLoader } from "./services/community-package-loader";
import { EVAL_RUN_STALE_MS, EvalService, type EvalLlmJudge, type EvalWorkflowExecutor } from "./services/eval-service";
import { JUDGE_PROMPT_MAX_CHARS } from "./services/eval-scorers";
import { AuthService, type SafeUser, type UserRole } from "./services/auth-service";
import { SchedulerService } from "./services/scheduler-service";
import { NonRetryableQueueError, QueueService } from "./services/queue-service";
import { TriggerService } from "./services/trigger-service";
import { ApiKeyService } from "./services/api-key-service";
import { MfaService } from "./services/mfa-service";
import { SamlService, type SamlAssertionProfile } from "./services/saml-service";
import { LdapService } from "./services/ldap-service";
import {
  ALL_PERMISSIONS,
  RbacService,
  isProjectRole,
  strictIsolationStartupWarning,
  type Permission,
  type ProjectRole
} from "./services/rbac-service";
import { ExternalSecretsService } from "./services/external-secrets-service";
import { GitSyncService } from "./services/git-sync-service";
import { LeaderElectionService } from "./services/leader-election-service";
import { reconcileInterruptedRuns } from "./services/run-reconcile-service.js";
import { MetricsService } from "./services/metrics-service";
import { TracingService, parseKeyValueList, parseTraceparent } from "./services/tracing-service";
import { OtlpMetricsExporter } from "./services/otlp-metrics-exporter";
import { UsageService } from "./services/usage-service";
import { BudgetService } from "./services/budget-service";
import { AuditExportService } from "./services/audit-export-service";
import { McpProbeService, McpProbeSkippedError, serverConfigFromRecord } from "./services/mcp-probe-service";
import { McpElicitationService } from "./services/mcp-elicitation-service.js";
import { registerMcpClientFeatureRoutes } from "./mcp-client-features-routes.js";
import { registerMcpControlPlaneRoutes } from "./mcp-control-plane-routes.js";
import { registerMcpTestingRoutes } from "./mcp-testing-routes.js";
import { registerGuardRoutes } from "./guard-routes.js";
import { registerAuditBundleRoutes } from "./audit-bundle-routes.js";
import { registerReplayRoutes } from "./replay-routes.js";
import { registerEvalRoutes } from "./eval-routes.js";
import { ReplayRecordingService } from "./services/replay-recording-service.js";
import { ReplayRunError, ReplayService } from "./services/replay-service.js";
import { buildRunFacts } from "./services/run-facts.js";
import { createReplaySandbox, type ReplaySandbox } from "./services/replay-sandbox.js";
import { AuditBundleService } from "./services/audit-bundle-service.js";
import { environmentSecretValues, scrubExemptionWarnings } from "./services/audit-scrub.js";
import { AuditSigningService } from "./services/audit-signing-service.js";
import { GuardService } from "./services/guard-service.js";
import { startSseHeartbeat } from "./sse-heartbeat.js";
import { createRunAccess, type RunAccessDenial } from "./run-access.js";
import { ProjectNotEmptyError } from "./db/store-errors.js";
import { createRunScope } from "./run-scope.js";
import {
  CODE_SANDBOX_INITIALISING,
  resolveCodeSandboxPlan,
  describeCodeSandboxPlan,
  configureExpressionSandbox,
  expressionSandboxLimits,
  nodeDnsResolver,
  type CodeSandboxPlan,
  type OutboundGuardConfig
} from "@ai-orchestrator/workflow-engine";
import {
  McpCassetteService,
  applyReplayOutcome,
  buildSnapshotFile,
  type McpCassetteRunPlan
} from "./services/mcp-cassette-service.js";
import type { McpCassetteRecord, McpCassetteSource, McpReplayMode } from "@ai-orchestrator/shared";
import {
  evaluateToolForContext,
  manualReadOnlyFor,
  markMcpTools,
  resolveMcpToolPolicySubject
} from "./services/mcp-tool-policy";
import {
  extractMcpToolCalls,
  MCP_TELEMETRY_WINDOWS,
  parseMcpTelemetryWindow,
  rollupMcpToolCalls
} from "./services/mcp-tool-telemetry";
import { VariablesService } from "./services/variables-service";
import { WorkflowVersionService } from "./services/workflow-version-service";
import { AuditService, type AuditActor, type AuditCategory, type AuditEventInput } from "./services/audit-service";
import { LogStreamingService } from "./services/log-streaming-service";
import { NotificationService } from "./services/notification-service";
import { openApiSpec } from "./openapi.js";
import { gatewayAllowedOrigins, isGatewayOriginAllowed, registerMcpGatewayRoutes } from "./mcp-gateway-routes.js";
import { registerMcpOnboardingRoutes } from "./mcp-onboarding-routes.js";
import {
  McpOAuthService,
  McpOAuthUserError,
  renderOAuthCallbackPage,
  resolveMcpConnectionsUrl,
  resolveMcpOAuthRedirectUri
} from "./services/mcp-oauth-service.js";
import { isInternalSecretProvider } from "./services/secret-service.js";

interface Tier1IntegrationSpec {
  id: string;
  label: string;
  category: string;
  logoPath: string;
  nodeTypes: string[];
}

/** Phase 15.1 — the trigger type of a golden-run replay. */
const REPLAY_TRIGGER_TYPE = "replay";

/** Phase 15.1 — the knowledge-base store a run uses: in a replay, writes are refused. */
function replayKnowledgeBaseStore(sandbox: ReplaySandbox | undefined, store: KnowledgeBaseStore): KnowledgeBaseStore {
  return sandbox ? sandbox.wrapKnowledgeBaseStore(store) : store;
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

const externalWorkflowImportSchema = z.object({
  source: z.unknown().optional(),
  sourceText: z.string().optional(),
  projectId: z.string().min(1).max(120).optional(),
  folderId: z.string().min(1).max(120).optional(),
  name: z.string().min(1).max(120).optional(),
  dryRun: z.boolean().optional()
});

const workflowDuplicateSchema = z.object({
  name: z.string().min(1).max(120),
  id: z.string().min(1).max(120).optional()
});

const mcpDiscoverSchema = z.object({
  serverId: z.string().min(1),
  /** Phase 10.2 — project whose tool policy marks the discovered tools; defaults to "default". */
  projectId: z.string().min(1).optional(),
  label: z.string().optional(),
  connection: z.record(z.string(), z.unknown()).optional(),
  secretRef: z
    .object({
      secretId: z.string().min(1)
    })
    .optional(),
  allowedTools: z.array(z.string()).optional()
});

const mcpTestToolSchema = z.object({
  serverId: z.string().min(1),
  label: z.string().optional(),
  connection: z.record(z.string(), z.unknown()).optional(),
  secretRef: z
    .object({
      secretId: z.string().min(1)
    })
    .optional(),
  toolName: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional()
});

const mcpSecretRefSchema = z.object({ secretId: z.string().min(1) });
// Probes faster than every 10 s would hammer stdio servers that spawn a process per probe.
const mcpProbeIntervalSchema = z.number().int().min(10_000).nullable();

const mcpServerCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  adapterId: z.string().min(1),
  connection: z.record(z.string(), z.unknown()).optional(),
  secretRef: mcpSecretRefSchema.nullable().optional(),
  owner: z.string().max(200).nullable().optional(),
  projectId: z.string().nullable().optional(),
  probeEnabled: z.boolean().optional(),
  probeIntervalMs: mcpProbeIntervalSchema.optional(),
  blockOnBreakingChange: z.boolean().optional(),
  // Phase 10.5 — whether and how the server may sample a model through the client.
  sampling: mcpSamplingSettingsPatchSchema.nullable().optional(),
  // Phase 10.7 — runtime safety. A null sandbox follows MCP_SANDBOX_DEFAULT.
  sandbox: mcpSandboxSettingsSchema.nullable().optional(),
  limits: mcpRuntimeLimitsSchema.nullable().optional(),
  credentialMode: z.enum(["service", "delegated"]).optional(),
  delegatedFallback: z.enum(["none", "owner"]).optional()
});

const mcpServerUpdateSchema = mcpServerCreateSchema.partial().refine((value) => Object.keys(value).length > 0, {
  message: "Empty update payload"
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

/**
 * True when a run's abort signal fired because the execution timeout ran
 * out, not because a person stopped it. A timed-out run ends as an error
 * on the node that was running; a stopped run ends as canceled.
 */
function isExecutionTimeoutAbort(signal: AbortSignal | undefined): boolean {
  const reason: unknown = signal?.aborted ? signal.reason : undefined;
  return reason instanceof WorkflowError && reason.category === ErrorCategory.WORKFLOW_TIMEOUT;
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

// Phase 9.1 — instantiate a workflow-engine EmbeddingAdapter from a KB's
// stored embedderId + embedderConfig. Mirrors the dispatch on the
// `rag_retrieve` node so REST callers get the same embedder semantics.
// Returns null if the embedderId is unknown or required config is missing.
async function buildEmbedderFromKbConfig(
  kb: { embedderId: string; embedderConfig: Record<string, unknown> },
  secretService: SecretService
): Promise<EmbeddingAdapter | null> {
  const cfg = kb.embedderConfig ?? {};
  const secretRef = (cfg.secretRef ?? cfg.embeddingSecretRef) as SecretReference | undefined;
  const apiKey = secretRef ? await secretService.resolveSecret(secretRef) : undefined;
  switch (kb.embedderId) {
    case "token-embedder":
      return new TokenEmbeddingAdapter();
    case "openai-embedder":
      return new OpenAIEmbeddingAdapter({
        apiKey: apiKey ?? process.env.OPENAI_API_KEY ?? "",
        baseUrl: typeof cfg.baseUrl === "string" ? cfg.baseUrl : undefined,
        model: typeof cfg.model === "string" ? cfg.model : undefined
      });
    case "azure-openai-embedder":
      return new AzureOpenAIEmbeddingAdapter({
        endpoint: typeof cfg.endpoint === "string" ? cfg.endpoint : process.env.AZURE_OPENAI_ENDPOINT ?? "",
        deployment:
          typeof cfg.deployment === "string" && cfg.deployment.trim()
            ? cfg.deployment
            : typeof cfg.model === "string"
              ? cfg.model
              : "text-embedding-3-small",
        apiVersion: typeof cfg.apiVersion === "string" ? cfg.apiVersion : process.env.AZURE_OPENAI_API_VERSION,
        apiKey: apiKey ?? process.env.AZURE_OPENAI_API_KEY ?? ""
      });
    case "cohere-embedder":
      return new CohereEmbeddingAdapter({
        apiKey: apiKey ?? process.env.COHERE_API_KEY ?? "",
        model: typeof cfg.model === "string" ? cfg.model : undefined
      });
    case "mistral-embedder":
      return new MistralEmbeddingAdapter({
        apiKey: apiKey ?? process.env.MISTRAL_API_KEY ?? "",
        model: typeof cfg.model === "string" ? cfg.model : undefined
      });
    case "google-vertex-embedder":
      return new GoogleVertexEmbeddingAdapter({
        apiKey: apiKey ?? process.env.GEMINI_API_KEY ?? "",
        model: typeof cfg.model === "string" ? cfg.model : undefined
      });
    case "huggingface-embedder":
      return new HuggingFaceEmbeddingAdapter({
        apiKey: apiKey ?? process.env.HUGGINGFACE_API_KEY ?? "",
        model: typeof cfg.model === "string" ? cfg.model : undefined
      });
    default:
      return null;
  }
}

// Phase 8.3 — surface a Retry-After hint when a budget block rejects.
// Returns seconds until the start of the next budget period.
function retryAfterSeconds(period: "day" | "week" | "month"): number {
  const now = new Date();
  let next: Date;
  if (period === "day") {
    next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  } else if (period === "week") {
    const day = now.getUTCDay();
    const daysFromMonday = (day + 6) % 7;
    next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysFromMonday + 7));
  } else {
    next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  }
  return Math.max(60, Math.floor((next.getTime() - now.getTime()) / 1000));
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

/**
 * Picks the workflow for the signed-in compat webhook routes. `canUse` hides
 * workflows the caller may not read: an explicit id, a path match and the
 * fallback pick all skip them, so they read as absent.
 */
async function selectWebhookWorkflow(
  store: SqliteStore,
  workflowId?: string,
  webhookPath?: string,
  webhookMethod = "POST",
  canUse: (workflow: Workflow) => boolean = () => true
): Promise<Workflow | null> {
  if (workflowId) {
    const workflow = store.getWorkflow(workflowId);
    return workflow && canUse(workflow) ? workflow : null;
  }

  if (webhookPath) {
    const match = await selectWebhookByPath(store, webhookPath, webhookMethod, canUse);
    return match?.workflow ?? null;
  }

  const workflows = store.listWorkflows();
  let firstUsable: Workflow | null = null;
  for (const workflowSummary of workflows) {
    const workflow = store.getWorkflow(workflowSummary.id);
    if (!workflow || !canUse(workflow)) {
      continue;
    }
    firstUsable ??= workflow;

    if (workflow.nodes.some((node) => node.type === "webhook_input")) {
      return workflow;
    }
  }

  return firstUsable;
}

function inferAgentWebhookPath(payload: {
  webhook_path?: string;
  webhookPath?: string;
  variables?: Record<string, unknown>;
}): string | undefined {
  const explicit = firstNonEmptyString(payload.webhook_path, payload.webhookPath);
  if (explicit) {
    return explicit;
  }

  const variables = asRecord(payload.variables);
  const client = firstNonEmptyString(variables.client);
  return client === "vscode-l2m-agent" ? "vscode-l2m-agent" : undefined;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
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

/** Phase 10.1 — every node that points at a registry server, for the detail page and delete guard. */
function listMcpServerUsages(
  store: SqliteStore,
  registryServerId: string
): Array<{ workflowId: string; workflowName: string; nodeId: string; nodeName: string; nodeType: string }> {
  const usages: Array<{ workflowId: string; workflowName: string; nodeId: string; nodeName: string; nodeType: string }> = [];
  for (const summary of store.listWorkflows()) {
    const workflow = store.getWorkflow(summary.id);
    if (!workflow) continue;
    for (const node of workflow.nodes) {
      const config = (node.config ?? {}) as Record<string, unknown>;
      const inline = Array.isArray(config.mcpServers) ? config.mcpServers : [];
      const referenced =
        config.registryServerId === registryServerId ||
        inline.some(
          (entry) =>
            entry !== null &&
            typeof entry === "object" &&
            (entry as Record<string, unknown>).registryServerId === registryServerId
        );
      if (referenced) {
        usages.push({
          workflowId: workflow.id,
          workflowName: workflow.name,
          nodeId: node.id,
          nodeName: node.name,
          nodeType: node.type
        });
      }
    }
  }
  return usages;
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
  method: string,
  canUse: (workflow: Workflow) => boolean = () => true
): Promise<{ workflow: Workflow; endpoint: WebhookEndpoint } | null> {
  const normalizedPath = normalizeWebhookPath(path, "").toLowerCase();
  const normalizedMethod = normalizeWebhookMethod(method);

  const workflows = store.listWorkflows();
  for (const workflowSummary of workflows) {
    const workflow = store.getWorkflow(workflowSummary.id);
    if (!workflow || !canUse(workflow)) {
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

export interface CreateAppOptions {
  /** Runtime/image detection seams for the code sandbox plan (tests). */
  codeSandboxDeps?: Parameters<typeof resolveCodeSandboxPlan>[1];
}

export function createApp(
  config: AppConfig,
  store: SqliteStore,
  secretService: SecretService,
  authService: AuthService,
  schedulerService?: SchedulerService,
  queueService?: QueueService,
  triggerService?: TriggerService,
  options: CreateAppOptions = {}
) {
  // Phase 4.4 — Request-ID propagation.
  // - `requestIdHeader: "x-request-id"` makes Fastify honor an incoming
  //   X-Request-ID header from upstream proxies (nginx, ALB, Cloudflare) so
  //   a single trace ID can span multiple hops.
  // - `genReqId` falls back to nanoid for fresh requests; nanoid is already
  //   a transitive dep here and produces shorter URL-safe IDs than crypto
  //   randomUUID without collision risk in the lifetime of an instance.
  // - `requestIdLogLabel: "reqId"` keys the ID under `reqId` in every log
  //   line that Pino emits via request.log, so `grep reqId=<id>` works.
  // The X-Request-ID response header is set in the onSend hook below so
  // clients (and curl --include) see the same ID their request carried.
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    bodyLimit: config.API_BODY_LIMIT_BYTES,
    requestIdHeader: "x-request-id",
    requestIdLogLabel: "reqId",
    genReqId: () => nanoid()
  });
  const providerRegistry = createDefaultProviderRegistry();
  // Phase 12.1 — guard profiles, bindings, events and the token vault.
  const guardService = new GuardService(store, secretService, {
    autoApply: config.GUARD_AUTO_APPLY,
    logger: (message, metadata) => app.log.warn(metadata ?? {}, message)
  });
  guardService.ensureBuiltIns();
  const connectorRegistry = createDefaultConnectorRegistry();
  // Phase 10.7 — stdio sandboxes. The instance label is derived from the
  // database location so the startup sweep only ever sees this deployment's
  // containers (and of those only the ones whose API process is gone).
  const mcpSandboxPolicy: McpSandboxPolicy = {
    defaultMode: config.MCP_SANDBOX_DEFAULT,
    required: config.MCP_SANDBOX_REQUIRED,
    runtime: config.MCP_SANDBOX_RUNTIME,
    allowedMountRoots: config.MCP_SANDBOX_ALLOWED_MOUNT_ROOTS.split(",").map((entry) => entry.trim()).filter(Boolean),
    instanceLabel: crypto.createHash("sha256").update(`l2m-sandbox:${store.storageLocation()}`).digest("hex").slice(0, 16)
  };
  const mcpSandboxLauncher = new ContainerSandboxLauncher(mcpSandboxPolicy, {
    onWarning: (message, fields) => app.log.warn(fields ?? {}, message)
  });

  // Code nodes: pick a sandbox plan at startup. Until it settles (one async
  // runtime/image check) code nodes are refused, and the server does not
  // accept requests (the onReady hook below waits for it), so nothing runs
  // under a plan the admin did not choose.
  configureExpressionSandbox({
    timeoutMs: config.EXPRESSION_TIMEOUT_MS,
    memoryMb: config.EXPRESSION_MEMORY_MB,
    maxResultMb: config.EXPRESSION_MAX_RESULT_MB,
    templateBudgetMs: config.EXPRESSION_TEMPLATE_BUDGET_MS
  });
  // Outbound URL policy for nodes that fetch a user-supplied URL.
  const outboundGuard: OutboundGuardConfig = { denyPrivate: config.OUTBOUND_DENY_PRIVATE, allowlist: config.OUTBOUND_ALLOWLIST };
  let codeSandboxPlan: CodeSandboxPlan = CODE_SANDBOX_INITIALISING;
  const codeSandboxSettled = resolveCodeSandboxPlan(
    {
      enabled: config.CODE_NODES_ENABLED,
      mode: config.CODE_SANDBOX_MODE,
      runtime: config.CODE_SANDBOX_RUNTIME,
      jsImage: config.CODE_SANDBOX_JS_IMAGE,
      pythonImage: config.CODE_SANDBOX_PYTHON_IMAGE,
      memoryMb: config.CODE_SANDBOX_MEMORY_MB,
      cpus: config.CODE_SANDBOX_CPUS,
      pidsLimit: config.CODE_SANDBOX_PIDS_LIMIT,
      startupMs: config.CODE_SANDBOX_STARTUP_MS,
      instanceLabel: crypto.createHash("sha256").update(`l2m-code:${store.storageLocation()}`).digest("hex").slice(0, 16),
      pythonInProcess: config.CODE_SANDBOX_PYTHON_IN_PROCESS,
      pythonUid: config.CODE_SANDBOX_PYTHON_UID,
      pythonGid: config.CODE_SANDBOX_PYTHON_GID,
      maxTimeoutMs: config.CODE_SANDBOX_MAX_TIMEOUT_MS,
      maxResultMb: config.CODE_SANDBOX_MAX_RESULT_MB
    },
    options.codeSandboxDeps
  )
    .then(({ plan, warning }) => {
      codeSandboxPlan = plan;
      const described = describeCodeSandboxPlan(plan);
      if (warning) app.log.warn({ codeSandboxMode: described.mode }, warning);
      else app.log.info({ codeSandbox: described.mode, detail: described.detail, expressions: expressionSandboxLimits() }, "Code node sandbox ready");
    })
    .catch((error) => {
      // Fail closed: an unknown environment never falls back to running code on the host.
      codeSandboxPlan = { kind: "disabled", reason: "Code nodes are unavailable: the code sandbox could not be set up at startup. Check the API logs." };
      app.log.error({ err: error instanceof Error ? error.message : String(error) }, "Could not resolve the code sandbox plan; code nodes are disabled");
    });
  app.addHook("onReady", async () => {
    await codeSandboxSettled;
  });
  // Phase 10.7 — rate limits, concurrency caps and circuit breakers. State is
  // in memory, per API instance, keyed by registry server id; it is shared by
  // workflow runs, the gateway and the playground of this process.
  const recordBreakerTransition = (transition: McpBreakerTransition) => {
    const server = store.getMcpServer(transition.serverId);
    const eventType =
      transition.to === "open" ? "mcp_server.breaker_opened" : transition.to === "half_open" ? "mcp_server.breaker_half_open" : "mcp_server.breaker_closed";
    auditService.record({
      category: "system",
      eventType,
      action: "update",
      outcome: transition.to === "open" ? "failure" : "success",
      actor: { type: "system" },
      resourceType: "mcp_server",
      resourceId: transition.serverId,
      projectId: server?.projectId ?? null,
      // The last error stays out of the audit log; admins see it on the server page.
      metadata: {
        name: server?.name ?? null,
        from: transition.from,
        to: transition.to,
        reason: transition.reason,
        consecutiveFailures: transition.consecutiveFailures,
        retryAt: transition.retryAt
      }
    });
    app.log.warn({ serverId: transition.serverId, from: transition.from, to: transition.to }, "MCP circuit breaker changed state");
  };
  const mcpRuntimeGuard = new McpRuntimeGuard({ onBreakerTransition: recordBreakerTransition });
  const runtimeStateView = (serverId: string, user?: SafeUser | null): McpRuntimeStateView => {
    const view = mcpRuntimeGuard.snapshot(serverId);
    const lastError =
      user?.role === "admin" && view.breaker.lastError ? String(secretService.redact(view.breaker.lastError)) : null;
    return { ...view, breaker: { ...view.breaker, lastError } };
  };
  const sandboxPolicyView = (): McpSandboxPolicyView => ({
    defaultMode: mcpSandboxPolicy.defaultMode,
    required: mcpSandboxPolicy.required,
    runtime: mcpSandboxPolicy.runtime,
    detectedRuntime: detectContainerRuntime(mcpSandboxPolicy.runtime)?.runtime ?? null,
    allowedMountRoots: mcpSandboxPolicy.allowedMountRoots
  });
  /** Why a server with this adapter and sandbox may not be saved, or null. */
  const sandboxSaveProblem = (adapterId: string, sandbox: McpSandboxSettings | null | undefined): string | null => {
    if (adapterId !== "stdio_mcp") {
      return sandbox && sandbox.mode === "container" ? "Container sandboxes apply to stdio MCP servers only." : null;
    }
    const mode = sandbox?.mode ?? mcpSandboxPolicy.defaultMode;
    if (mode === "none" && mcpSandboxPolicy.required) {
      return "MCP_SANDBOX_REQUIRED is on: stdio MCP servers must run in a container sandbox.";
    }
    if (sandbox?.mode === "container" && sandbox.mounts?.length) {
      const checked = validateSandboxMounts(sandbox.mounts, mcpSandboxPolicy.allowedMountRoots);
      if (checked.problems.length > 0) return checked.problems.join(" ");
    }
    return null;
  };
  const sandboxInUse = () =>
    mcpSandboxPolicy.defaultMode === "container" ||
    store.listMcpServers().some((server) => server.adapterId === "stdio_mcp" && server.sandbox?.mode === "container");
  if (sandboxInUse()) {
    void sweepSandboxContainers({ policy: mcpSandboxPolicy })
      .then((swept) => {
        if (swept.removed > 0) app.log.info({ removed: swept.removed, runtime: swept.runtime }, "Removed leftover MCP sandbox containers");
      })
      .catch((error) => {
        app.log.warn({ err: error instanceof Error ? error.message : String(error) }, "MCP sandbox sweep failed");
      });
  }
  app.addHook("onClose", async () => {
    await mcpSandboxLauncher.shutdown();
  });

  // Phase 10.5 — OAuth connections for remote MCP servers. The http adapter
  // asks this service for access tokens; tokens stay in SecretService.
  const mcpOAuthService = new McpOAuthService(store, secretService, {
    connectionsUrl: resolveMcpConnectionsUrl(config),
    redirectUri: resolveMcpOAuthRedirectUri(config),
    stateTtlMs: config.MCP_OAUTH_STATE_TTL_MS,
    refreshSkewMs: config.MCP_OAUTH_REFRESH_SKEW_MS,
    onAudit: (event) => {
      auditService.record({
        category: "system",
        eventType: event.eventType,
        action: "update",
        outcome: event.outcome,
        actor: { type: "system" },
        resourceType: "mcp_server",
        resourceId: event.serverId,
        metadata: event.metadata
      });
    }
  });
  const mcpRegistry = createDefaultMCPRegistry({
    oauth: mcpOAuthService,
    sandbox: mcpSandboxLauncher,
    runtimeGuard: mcpRuntimeGuard,
    // Phase 10.8 — snapshot mock servers read accepted snapshots and cassettes from the store.
    snapshots: {
      loadSnapshot: (sourceServerId) => {
        const server = store.getMcpServer(sourceServerId);
        const file = server ? buildSnapshotFile(store, server) : null;
        if (!file) {
          throw new Error(`MCP server '${sourceServerId}' has no accepted schema snapshot yet. Probe it first.`);
        }
        return file;
      },
      loadCassette: (cassetteId) => store.getMcpCassette(cassetteId)?.cassette ?? null
    }
  });
  // Phase 10.8 — record and replay of MCP calls.
  const mcpCassetteService = new McpCassetteService(store, {
    maxBytes: config.MCP_CASSETTE_MAX_BYTES,
    maxCalls: config.MCP_CASSETTE_MAX_CALLS,
    redact: (value) => {
      const redacted = secretService.redact(value);
      return typeof redacted === "string" ? redacted : value;
    }
  });
  const agentRuntime = createDefaultAgentRuntime();

  // Phase 6 — community-package loader. Constructed eagerly so admin routes
  // below can drive install/uninstall, but loadAll() only runs when
  // COMMUNITY_NODES_ENABLED. When the feature is disabled the loader is a
  // no-op shell that surfaces an explicit "disabled" error from any route
  // that tries to use it.
  const communityLoader = config.COMMUNITY_NODES_ENABLED
    ? new CommunityPackageLoader(
        {
          pluginsDir: path.resolve(config.COMMUNITY_NODES_DIR),
          allowlist: config.COMMUNITY_NODES_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean),
          logger: {
            info: (msg, fields) => app.log.info(fields ?? {}, msg),
            warn: (msg, fields) => app.log.warn(fields ?? {}, msg),
            error: (msg, fields) => app.log.error(fields ?? {}, msg)
          }
        },
        { providerRegistry, mcpRegistry, connectorRegistry }
      )
    : null;
  // Phase 10.1 — nodes that reference the MCP server registry resolve here at
  // run time, so a registry edit applies to every workflow using the server.
  const resolveRegisteredMcpServer = (registryServerId: string, actor?: SafeUser | null): MCPServerConfig => {
    const server = store.getMcpServer(registryServerId);
    if (!server) {
      throw new Error(`MCP server '${registryServerId}' is not in the server registry. Pick a registered server on the node.`);
    }
    if (server.blockOnBreakingChange && server.pendingBreakingSnapshotId) {
      throw new Error(
        `MCP server '${server.name}' changed its tool schemas in a breaking way and is set to block runs. Review and accept the change on the MCP servers page.`
      );
    }
    const serverConfig = serverConfigFromRecord(server);
    // Phase 10.7 — calls made from the API on a user's behalf (playground, resources, prompts) use their own account.
    return actor ? withDelegatedUser(serverConfig, { role: actor.role, source: "user", userId: actor.id, email: actor.email }) : serverConfig;
  };
  // Phase 10.2 — MCP tool policy. Rules and overrides are read when an agent
  // or MCP Tool node starts, so an admin's change applies to the next node.
  const loadMcpToolPolicy = () => ({
    rules: store.listMcpToolPolicies(),
    classifications: store.listMcpToolClassifications()
  });
  const resolveToolPolicySubject = (workflowId: string, actor?: SafeUser | null): McpToolPolicySubject =>
    resolveMcpToolPolicySubject(store, workflowId, actor);
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

  // Phase 15.2 — finished eval runs and replay jobs, on the same timer. The
  // newest run of every set is kept; a store without eval storage skips it.
  const pruneEvalRuns = (reason: "startup" | "interval") => {
    const retentionDays = config.EVAL_RUN_RETENTION_DAYS;
    const evalStore = store as unknown as { pruneEvalRuns?: (input: { before: string }) => number };
    if (retentionDays <= 0 || typeof evalStore.pruneEvalRuns !== "function") return 0;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    try {
      const deleted = evalStore.pruneEvalRuns({ before: cutoff });
      if (deleted > 0) app.log.info({ deleted, cutoff, retentionDays, reason }, "Pruned eval runs and replay jobs");
      return deleted;
    } catch (error) {
      app.log.warn(
        { cutoff, retentionDays, reason, error: secretService.redact(error instanceof Error ? error.message : String(error)) },
        "Failed to prune eval runs and replay jobs"
      );
      return 0;
    }
  };

  pruneExecutionHistory("startup");
  pruneEvalRuns("startup");
  const retentionTimer = config.EXECUTION_HISTORY_RETENTION_DAYS > 0 || config.EVAL_RUN_RETENTION_DAYS > 0
    ? setInterval(() => {
        pruneExecutionHistory("interval");
        pruneEvalRuns("interval");
      }, config.EXECUTION_HISTORY_PRUNE_INTERVAL_MS)
    : null;
  if (retentionTimer) {
    const timerWithUnref = retentionTimer as { unref?: () => void };
    timerWithUnref.unref?.();
    app.addHook("onClose", async () => {
      clearInterval(retentionTimer);
    });
  }

  authService.startSessionCleanup();
  app.addHook("onClose", async () => {
    authService.stopSessionCleanup();
    if (typeof (store as { close?: () => void }).close === "function") {
      (store as { close: () => void }).close();
    }
  });

  type WorkflowExecutionEventHooks = {
    onNodeStart?: (event: { nodeId: string; nodeType: string; startedAt: string; input?: unknown }) => Promise<void> | void;
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
    /** Phase 10.5 — `notifications/progress` from an MCP server during an MCP Tool node or agent tool call. */
    onMcpProgress?: (event: McpToolProgressEvent & { nodeId: string }) => Promise<void> | void;
    /** Step-by-step node activity: resolved inputs, model calls, retries, agent steps and tool calls. */
    onNodeActivity?: (event: NodeActivityEvent) => Promise<void> | void;
    /** Phase 10.5 — an `elicitation/create` request started waiting for a person, or was settled. */
    onMcpElicitation?: (event: { phase: "created" | "settled"; elicitation: McpElicitationView }) => Promise<void> | void;
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
    // A stopped run keeps the canceled record the cancel route wrote. A
    // timed-out run is still saved: it ends as an error with its node results.
    if (
      active?.controller.signal.aborted &&
      record.status !== "canceled" &&
      !(isExecutionTimeoutAbort(active.controller.signal) && meta.phase === "final")
    ) {
      return false;
    }
    try {
      store.saveExecutionHistory(record);
      if (meta.phase === "final") {
        pruneExecutionHistory("write");
        // Phase 15.1 — replays are experiments, not traffic: they stay out of execution metrics and SLOs.
        if (meta.triggerType !== REPLAY_TRIGGER_TYPE) {
          const status = meta.status === "success" ? "success" : meta.status === "canceled" ? "canceled" : "error";
          metricsService.recordExecution(status, record.durationMs ?? 0);
        }
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
    /**
     * Phase 10.2 — the signed-in user who started this run. Set only by
     * routes that authenticate a user; never derived from a request body.
     * Without it the tool policy uses the workflow owner's role.
     */
    policyActor?: SafeUser | null;
    /**
     * Phase 10.4 — an explicit policy subject (an MCP gateway client). Wins
     * over `policyActor` and the owner fallback.
     */
    policySubject?: McpToolPolicySubject;
    /**
     * MCP elicitations from this run belong to the workflow, not to
     * `policyActor`: anyone with workflow:execute on it may answer them.
     * Set for queued jobs, whose enqueuer is usually not watching.
     */
    elicitationsForWorkflow?: boolean;
    executionTimeoutMs?: number;
    customData?: Record<string, unknown>;
    resumeState?: WorkflowExecutionState;
    approvalDecision?: {
      decision: "approve" | "reject";
      actedBy?: string;
      reason?: string;
    };
    hooks?: WorkflowExecutionEventHooks;
    /** Phase 10.8 — record this run's MCP calls, or answer them from a cassette. */
    mcpPlan?: McpCassetteRunPlan;
    /**
     * Phase 15.1 — a golden-run replay: stubbed nodes answered by the plan's
     * hook, session state in the sandbox's own stores, no error workflow,
     * no notifications, no paused state, no elicitation prompts.
     */
    replay?: { hook: ReplayNodeHook; sandbox: ReplaySandbox };
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
    const executionTimeoutMs = normalizeExecutionTimeoutMs(input.executionTimeoutMs, undefined, config.WORKFLOW_EXECUTION_TIMEOUT_MS);
    const scoped = runScope.dependenciesFor(mergedWorkflow, {
      actor: input.policyActor,
      resolveRegisteredMcpServer: input.mcpPlan?.resolveRegisteredMcpServer
    });
    // The execution timeout aborts the run's signal, so it interrupts a
    // model call, MCP call or retry wait that is in flight instead of only
    // being checked between nodes. The reason marks it as a timeout, which
    // the engine reports on the running node, unlike a person's Stop.
    const runController = controller ?? new AbortController();
    const executionTimeoutHandle = setTimeout(() => {
      if (!runController.signal.aborted) {
        runController.abort(
          WorkflowError.timeout(`Workflow exceeded the ${executionTimeoutMs}ms execution timeout.`, { timeoutMs: executionTimeoutMs })
        );
      }
    }, executionTimeoutMs);
    executionTimeoutHandle.unref?.();
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
          executionTimeoutMs,
          triggerType: input.triggerType,
          triggeredBy: input.triggeredBy,
          toolPolicySubject: input.policySubject ?? resolveToolPolicySubject(input.workflow.id, input.policyActor),
          resumeState: input.resumeState,
          approvalDecision: input.approvalDecision
        },
        {
          providerRegistry,
          connectorRegistry,
          mcpRegistry: input.mcpPlan?.registry ?? mcpRegistry,
          agentRuntime,
          // Session state, secrets, knowledge bases and sub-workflows are
          // scoped to the workflow's project (run-scope.ts); a sub-workflow
          // gets its own project's scope through scopeSubWorkflow.
          ...scoped,
          memoryStore: input.replay?.sandbox.memoryStore ?? scoped.memoryStore,
          toolDataStore: input.replay?.sandbox.toolDataStore ?? scoped.toolDataStore,
          sessionArtifactStore: input.replay?.sandbox.sessionArtifactStore ?? scoped.sessionArtifactStore,
          // A replay never starts a sub-workflow (Execute Workflow nodes are stubbed).
          loadWorkflow: input.replay ? undefined : scoped.loadWorkflow,
          scopeSubWorkflow: input.replay ? undefined : scoped.scopeSubWorkflow,
          // Phase 9.1 — built-in persistent vector store, limited to the
          // workflow's project and the shared knowledge bases.
          knowledgeBaseStore: replayKnowledgeBaseStore(input.replay?.sandbox, scoped.knowledgeBaseStore),
          guard: guardService.runtimeFor({ executionId: input.executionId, workflowId: mergedWorkflow.id, projectId: mergedWorkflow.projectId ?? "default" }),
          replayNodeHook: input.replay?.hook,
          loadMcpToolPolicy,
          // Phase 10.5 — resources, elicitation and list_changed notifications.
          mcpResourceMaxBytes: config.MCP_RESOURCE_MAX_BYTES,
          // Where code nodes run (container, in-process isolate, or disabled).
          codeSandbox: codeSandboxPlan,
          // SSRF/egress policy for HTTP Request, Web Browse, Chart data.url and HTML PDF.
          outboundGuard,
          outboundDnsResolver: nodeDnsResolver,
          onMcpListChanged: input.replay ? undefined : (event) => mcpProbeService.onListChanged(event),
          onMcpElicitation: input.replay
            ? input.replay.sandbox.onMcpElicitation
            : input.executionId
            ? (elicitation) =>
                mcpElicitationService.ask({
                  request: { message: elicitation.message, requestedSchema: elicitation.requestedSchema },
                  executionId: input.executionId!,
                  workflowId: mergedWorkflow.id,
                  workflowName: mergedWorkflow.name,
                  nodeId: elicitation.nodeId,
                  serverId: elicitation.serverId,
                  registryServerId: elicitation.registryServerId,
                  serverName: elicitation.registryServerId ? store.getMcpServer(elicitation.registryServerId)?.name : undefined,
                  toolName: elicitation.toolName,
                  triggerType: input.triggerType,
                  createdBy: input.elicitationsForWorkflow ? null : input.policyActor?.id ?? null,
                  timeoutMs: executionTimeoutMs,
                  signal: runController.signal
                })
            : undefined,
          persistPausedExecution: input.replay ? undefined : async (paused) => {
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
          // Phase 15.1 — a replay never fires the error workflow or its notifications.
          triggerErrorWorkflow: input.replay ? undefined : async (payload) => {
            // Fire-and-forget: execute the error workflow + send notifications
            notificationService.notify({
              type: "execution.failure",
              workflowId: payload.sourceWorkflowId,
              workflowName: payload.sourceWorkflowName,
              executionId: payload.executionId,
              error: payload.error,
              errorStack: payload.errorStack,
              timestamp: payload.timestamp
            }).catch(err => {
              app.log.warn({ err: err instanceof Error ? err.message : String(err) }, "Notification send failed");
            });
            // Execute the designated error handler workflow: one in the same
            // project or one shared to it with execute.
            const failingWorkflow = payload.sourceWorkflowId === mergedWorkflow.id ? mergedWorkflow : store.getWorkflow(payload.sourceWorkflowId) ?? mergedWorkflow;
            const errorTarget = runScope.errorWorkflowFor(failingWorkflow, payload.errorWorkflowId);
            if ("error" in errorTarget) {
              app.log.warn({ errorWorkflowId: payload.errorWorkflowId, sourceWorkflowId: payload.sourceWorkflowId, reason: errorTarget.error }, "Error workflow not run");
              return;
            }
            const errorWf = errorTarget.workflow;
            // Like a sub-workflow: the run's user carries over only within the same project.
            const sameProject = (errorWf.projectId ?? DEFAULT_PROJECT_ID) === (failingWorkflow.projectId ?? DEFAULT_PROJECT_ID);
            const errorScoped = runScope.dependenciesFor(errorWf, { actor: sameProject ? input.policyActor : null });
            try {
              await executeWorkflow(
                {
                  workflow: errorWf,
                  input: {
                    error: payload.error,
                    errorStack: payload.errorStack,
                    sourceWorkflowId: payload.sourceWorkflowId,
                    sourceWorkflowName: payload.sourceWorkflowName,
                    executionId: payload.executionId,
                    timestamp: payload.timestamp
                  },
                  triggerType: "error",
                  toolPolicySubject: resolveToolPolicySubject(errorWf.id),
                  executionTimeoutMs: config.WORKFLOW_EXECUTION_TIMEOUT_MS
                },
                {
                  providerRegistry,
                  connectorRegistry,
                  mcpRegistry,
                  agentRuntime,
                  ...errorScoped,
                  // The error handler is guarded under its own bindings, like any other run.
                  guard: guardService.runtimeFor({ workflowId: errorWf.id, projectId: errorWf.projectId ?? "default" }),
                  loadMcpToolPolicy,
                  codeSandbox: codeSandboxPlan,
                  outboundGuard,
                  outboundDnsResolver: nodeDnsResolver
                }
              );
            } catch (err) {
              app.log.warn({ err: err instanceof Error ? err.message : String(err), errorWorkflowId: payload.errorWorkflowId }, "Error workflow execution failed");
            }
          },
          onNodeStart: input.hooks?.onNodeStart,
          onNodeComplete: input.hooks?.onNodeComplete,
          onLLMDelta: input.hooks?.onLLMDelta,
          onMcpProgress: input.hooks?.onMcpProgress,
          onNodeActivity: input.hooks?.onNodeActivity,
          abortSignal: runController.signal
        }
      );

      // A person's Stop always ends as canceled. A timeout keeps the engine's
      // result: the error on the node that was running, with its remediation.
      if (runController.signal.aborted && !isExecutionTimeoutAbort(runController.signal) && result.status !== "canceled") {
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
      clearTimeout(executionTimeoutHandle);
      if (input.executionId) {
        mcpElicitationService.releaseExecution(input.executionId, "The run ended before the request was answered.");
      }
      releaseActiveExecution(input.executionId, controller);
    }
  };

  /**
   * Phase 10.8 — after a recorded run, store its cassette; after a replay,
   * attach the replay report and fail a strict replay that diverged.
   */
  const finishMcpCassettePlan = <T extends Awaited<ReturnType<typeof runWorkflowExecution>>>(
    plan: McpCassetteRunPlan | undefined,
    result: T,
    meta: {
      executionId: string;
      workflow: Workflow;
      source: McpCassetteSource;
      createdBy: string | null;
      evalRunId?: string | null;
      fixtureId?: string | null;
    }
  ): T => {
    if (!plan) return result;
    let next: T = result;
    if (plan.recorder) {
      try {
        const summary = mcpCassetteService.persist({
          plan,
          executionId: meta.executionId,
          workflow: meta.workflow,
          source: meta.source,
          evalRunId: meta.evalRunId ?? null,
          fixtureId: meta.fixtureId ?? null,
          createdBy: meta.createdBy
        });
        if (summary) next = { ...next, mcpCassette: summary };
      } catch (error) {
        app.log.warn(
          { executionId: meta.executionId, error: secretService.redact(error instanceof Error ? error.message : String(error)) },
          "Failed to store the MCP cassette"
        );
      }
    }
    const report = mcpCassetteService.report(plan);
    if (report) next = applyReplayOutcome({ ...next, mcpReplay: report }, report);
    return next;
  };

  /** Phase 10.8 — what a replay feeds the workflow, rebuilt from the source run's stored request input. */
  const replayRunInputFor = (
    triggerType: string | null,
    stored: Record<string, unknown>
  ): Pick<
    Parameters<typeof runWorkflowExecution>[0],
    "directInput" | "webhookPayload" | "variables" | "systemPrompt" | "userPrompt" | "sessionId" | "usePinnedData"
  > => {
    if (triggerType === "eval") {
      return { directInput: { trigger_type: "eval", ...stored } };
    }
    if (triggerType && ["manual", "manual_stream", "manual_retry", "mcp_replay"].includes(triggerType)) {
      const directInput = asRecord(stored.input);
      const variables = asRecord(stored.variables);
      return {
        ...(Object.keys(directInput).length > 0 ? { directInput } : {}),
        ...(Object.keys(variables).length > 0 ? { variables } : {}),
        ...(typeof stored.system_prompt === "string" ? { systemPrompt: stored.system_prompt } : {}),
        ...(typeof stored.user_prompt === "string" ? { userPrompt: stored.user_prompt } : {}),
        sessionId: normalizeSessionId(
          typeof stored.sessionId === "string" ? stored.sessionId : undefined,
          typeof stored.session_id === "string" ? stored.session_id : undefined
        ),
        usePinnedData: stored.usePinnedData !== false
      };
    }
    const parsed = parseWebhookRunInput(stored);
    return {
      webhookPayload: parsed.body,
      ...(parsed.variables ? { variables: parsed.variables } : {}),
      ...(parsed.systemPrompt ? { systemPrompt: parsed.systemPrompt } : {}),
      ...(parsed.userPrompt ? { userPrompt: parsed.userPrompt } : {}),
      sessionId: parsed.sessionId
    };
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

  const recordMcpToolCalls = (executionId: string, workflow: Workflow, nodeResults: unknown) => {
    try {
      const calls = extractMcpToolCalls({
        executionId,
        workflow,
        nodeResults,
        priceTurn: (providerId, model, inputTokens, outputTokens, cachedInputTokens) =>
          usageService.estimateCostUsd(providerId, model, inputTokens, outputTokens, cachedInputTokens),
        registryAdapterId: (registryServerId) => store.getMcpServer(registryServerId)?.adapterId,
        redact: (value) => String(secretService.redact(value))
      });
      store.replaceMcpToolCallsForExecution(executionId, calls);
    } catch (err) {
      app.log.warn(
        { error: secretService.redact(err instanceof Error ? err.message : String(err)), executionId },
        "Failed to record MCP tool call telemetry"
      );
    }
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
      // Phase 11.1 — what the run's signed manifest describes: the workflow as it ran and its MCP servers.
      try {
        auditBundleService.captureRunContext(input.executionId, input.workflow);
      } catch (error) {
        app.log.warn(
          { executionId: input.executionId, error: secretService.redact(error instanceof Error ? error.message : String(error)) },
          "Failed to capture the run context for the run manifest"
        );
      }
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

    // Phase 8.2 — record FinOps usage event. nodeResults from runWorkflowExecution
    // is an Array<NodeExecutionResult>; flatten to Record<nodeId, output> so
    // UsageService can scan per-node `_telemetry` blobs without re-implementing
    // the array shape.
    try {
      const nodeOutputs: Record<string, unknown> = {};
      for (const r of input.result.nodeResults as Array<{ nodeId?: string; output?: unknown }>) {
        if (r && typeof r === "object" && typeof r.nodeId === "string") {
          nodeOutputs[r.nodeId] = r.output;
        }
      }
      const usageResult = usageService.recordExecution({
        executionId: input.executionId,
        workflowId: input.workflow.id,
        workflowName: input.workflow.name,
        userEmail:
          typeof input.triggeredBy === "string" && input.triggeredBy.includes("@")
            ? input.triggeredBy
            : null,
        userId:
          typeof input.triggeredBy === "string" && !input.triggeredBy.includes("@")
            ? input.triggeredBy
            : null,
        projectId: input.workflow.projectId ?? null,
        triggerType: input.triggerType ?? null,
        status: input.result.status,
        durationMs: toDurationMs(input.result.startedAt, input.result.completedAt) ?? 0,
        nodeResults: nodeOutputs
      });

      // Phase 8.3 — fire budget alerts on threshold crossings. Debounced per
      // (budget, period, severity) so users don't get spammed. Phase 15.1 — a
      // replay's spend is recorded above, but a replay sends no notifications:
      // the next real run that is over the threshold fires the alert.
      try {
        if (input.triggerType !== REPLAY_TRIGGER_TYPE) budgetService.recordExecution({
          executionId: input.executionId,
          workflowId: input.workflow.id,
          projectId: input.workflow.projectId ?? null,
          userEmail:
            typeof input.triggeredBy === "string" && input.triggeredBy.includes("@")
              ? input.triggeredBy
              : null,
          userId:
            typeof input.triggeredBy === "string" && !input.triggeredBy.includes("@")
              ? input.triggeredBy
              : null,
          spentUsd: usageResult.costUsd,
          spentTokens: usageResult.totalTokens
        });
      } catch (err) {
        app.log.warn(
          { error: err instanceof Error ? err.message : String(err), executionId: input.executionId },
          "Budget alert evaluation failed"
        );
      }
    } catch (err) {
      app.log.warn(
        { error: err instanceof Error ? err.message : String(err), executionId: input.executionId },
        "Failed to record usage event"
      );
    }

    // Phase 10.1 — one mcp_tool_calls row per MCP tool call in this run. A
    // replay's calls were answered from a recording, not by the servers.
    if (input.triggerType !== REPLAY_TRIGGER_TYPE) {
      recordMcpToolCalls(input.executionId, input.workflow, input.result.nodeResults);
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
        progress?: NodeProgressSnapshot;
      }
    >();
    let startedAt: string | null = null;
    let currentStatus: "running" | "waiting_approval" = "running";
    let startLogged = false;
    // Progress notifications can be frequent; history writes for them are throttled.
    let lastProgressPersistMs = 0;

    // The last NODE_ACTIVITY_LIMIT activity entries per node, so polls of a running execution carry them.
    const activityByNodeId = new Map<string, NodeActivityEvent[]>();
    const snapshotNodeResults = () =>
      [...nodeResultsById.values()].map((entry) => {
        const activity = activityByNodeId.get(entry.nodeId);
        return activity?.length ? { ...entry, activity: [...activity] } : entry;
      });
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
          input: event.input ?? existing?.input,
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
          error: event.error,
          ...(existing?.progress ? { progress: existing.progress } : {})
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
      onMcpProgress: async (event) => {
        const { nodeId, ...progressEvent } = event;
        const snapshot: NodeProgressSnapshot = {
          ...progressEvent,
          ...(typeof event.total === "number" && event.total > 0
            ? { percent: Math.max(0, Math.min(100, Math.round((event.progress / event.total) * 100))) }
            : {})
        };
        const existing = nodeResultsById.get(nodeId);
        if (existing) {
          nodeResultsById.set(nodeId, { ...existing, progress: snapshot });
          const nowMs = Date.now();
          if (nowMs - lastProgressPersistMs >= 1000) {
            lastProgressPersistMs = nowMs;
            persistProgress();
          }
        }
        try {
          await input.passthroughHooks?.onMcpProgress?.({ nodeId, ...snapshot });
        } catch (error) {
          app.log.warn(
            {
              executionId: input.executionId,
              workflowId: input.workflow.id,
              nodeId,
              error: secretService.redact(error instanceof Error ? error.message : String(error))
            },
            "Execution MCP-progress hook failed"
          );
        }
      },
      onNodeActivity: async (event) => {
        const buffer = activityByNodeId.get(event.nodeId) ?? [];
        buffer.push(event);
        if (buffer.length > NODE_ACTIVITY_LIMIT) buffer.shift();
        activityByNodeId.set(event.nodeId, buffer);
        if (nodeResultsById.has(event.nodeId)) {
          const nowMs = Date.now();
          if (nowMs - lastProgressPersistMs >= 1000) {
            lastProgressPersistMs = nowMs;
            persistProgress();
          }
        }
        try {
          await input.passthroughHooks?.onNodeActivity?.(event);
        } catch (error) {
          app.log.warn(
            {
              executionId: input.executionId,
              workflowId: input.workflow.id,
              nodeId: event.nodeId,
              error: secretService.redact(error instanceof Error ? error.message : String(error))
            },
            "Execution node-activity hook failed"
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
    reply: FastifyReply,
    user: SafeUser
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
      // A run the user cannot read is answered like a missing one.
      if (!sourceExecution || !runAccess.run(user, sourceExecution, "workflow:read").ok) {
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
    triggerService.setOutboundGuard(outboundGuard, nodeDnsResolver);
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
  const rbacService = new RbacService(store, config.PROJECT_ISOLATION);
  const isolationWarning = strictIsolationStartupWarning(config.PROJECT_ISOLATION, store.countProjectMemberships());
  if (isolationWarning) app.log.warn(isolationWarning);
  const runAccess = createRunAccess({
    getWorkflow: (id) => store.getWorkflow(id),
    listWorkflows: () => store.listWorkflows(),
    listProjectIds: () => store.listProjects().map((project) => project.id),
    canAccessWorkflow: (user, workflow, permission) => rbacService.canAccessWorkflow(user, workflow, permission),
    canInProject: (user, projectId, permission) => rbacService.can(user, projectId, permission),
    listWorkflowIdsSharedToProject: (projectId) => store.listWorkflowsSharedToProject(projectId).map((share) => share.workflowId),
    projectExists: (projectId) => Boolean(store.getProject(projectId))
  });
  // Phase 9.1 — built-in persistent vector store. A run sees the knowledge
  // bases of its own project and the shared ones without a project; any other
  // id reads as missing, for every method the engine calls.
  const knowledgeBaseStoreForRun = (workflowProjectId: string | null | undefined): KnowledgeBaseStore => {
    const projectId = workflowProjectId ?? DEFAULT_PROJECT_ID;
    const visible = (id: string) => {
      const kb = store.getKnowledgeBase(id);
      return kb && (!kb.projectId || kb.projectId === projectId) ? kb : null;
    };
    const missing = (id: string) => new Error(`Knowledge base not found: ${id}`);
    return {
      addKnowledgeBaseChunks: (input) => {
        if (!visible(input.knowledgeBaseId)) throw missing(input.knowledgeBaseId);
        return store.addKnowledgeBaseChunks({ knowledgeBaseId: input.knowledgeBaseId, chunks: input.chunks });
      },
      listKnowledgeBaseChunks: (kbId) => (visible(kbId) ? store.listKnowledgeBaseChunks(kbId) : []),
      bm25SearchKnowledgeBase: (input) => (visible(input.knowledgeBaseId) ? store.bm25SearchKnowledgeBase(input) : []),
      getKnowledgeBase: (id) => {
        const kb = visible(id);
        return kb ? { id: kb.id, embedderId: kb.embedderId, dimensions: kb.dimensions } : null;
      }
    };
  };
  // Saving a workflow needs write access to the one it replaces (same id) and
  // to the project it lands in (its own projectId, else the replaced one's).
  // Test and discovery routes resolve a secretRef the caller typed in. They
  // may only use a secret the caller could use in a run: `secret:use` in the
  // secret's project or in a project it is shared to.
  const resolveSecretForUser = (user: SafeUser) => async (secretRef?: SecretReference): Promise<string | undefined> => {
    if (!secretRef?.secretId) return undefined;
    const row = store.getSecret(secretRef.secretId);
    if (!row) return undefined;
    const usable =
      rbacService.can(user, row.projectId ?? DEFAULT_PROJECT_ID, "secret:use") ||
      rbacService.listSecretShares(row.id).some((share) => rbacService.can(user, share.projectId, "secret:use"));
    if (!usable) throw new Error(`Secret '${secretRef.secretId}' is not available to you.`);
    return secretService.resolveSecret(secretRef);
  };
  // Which projects claim a pre-scoping session namespace: each workflow's
  // default `<workflowId>:<nodeId>` and its literal custom namespaces. Only
  // read when a run falls back to an unprefixed row; rebuilt when any
  // workflow changes.
  let legacyNamespaceIndex: { fingerprint: string; owners: Map<string, string[]> } | null = null;
  const legacyNamespaceOwners = (): Map<string, string[]> => {
    const items = store.listWorkflows();
    const fingerprint = items.map((item) => `${item.id}|${item.updatedAt}|${item.workflowVersion}|${item.projectId ?? DEFAULT_PROJECT_ID}`).join("\n");
    if (legacyNamespaceIndex?.fingerprint === fingerprint) return legacyNamespaceIndex.owners;
    const owners = new Map<string, string[]>();
    const claim = (namespace: string, projectId: string) => {
      const list = owners.get(namespace) ?? [];
      if (!list.includes(projectId)) list.push(projectId);
      owners.set(namespace, list);
    };
    for (const item of items) {
      const workflow = store.getWorkflow(item.id);
      if (!workflow) continue;
      const projectId = workflow.projectId ?? DEFAULT_PROJECT_ID;
      for (const node of workflow.nodes) {
        claim(`${workflow.id}:${node.id}`, projectId);
        const custom = (node.config as Record<string, unknown> | undefined)?.namespace;
        if (typeof custom === "string" && custom.trim() && !custom.includes("{{")) claim(custom.trim(), projectId);
      }
    }
    legacyNamespaceIndex = { fingerprint, owners };
    return owners;
  };
  // What a run can reach once it is going: sub-workflows, secrets, knowledge
  // bases and session state of its own project (see run-scope.ts).
  const runScope = createRunScope({
    getWorkflow: (id) => store.getWorkflow(id),
    listWorkflowShares: (workflowId) => store.listWorkflowShares(workflowId),
    getSecretProjectId: (secretId) => store.getSecret(secretId)?.projectId ?? null,
    listSecretIdsSharedToProject: (projectId) => store.listSecretsSharedToProject(projectId),
    canUseSecretsInProject: (user, projectId) => rbacService.can(user, projectId, "secret:use"),
    defaultSecretsShared: config.PROJECT_ISOLATION === "role",
    getMcpServerProjectId: (serverId) => {
      const server = store.getMcpServer(serverId);
      return server ? server.projectId : undefined;
    },
    resolveRegisteredMcpServer: (registryServerId) => resolveRegisteredMcpServer(registryServerId),
    legacyNamespaceOwnerProjects: (namespace) => legacyNamespaceOwners().get(namespace) ?? [],
    resolveSecret: (secretRef) => secretService.resolveSecret(secretRef),
    knowledgeBaseStoreFor: (projectId) => knowledgeBaseStoreForRun(projectId),
    sessions: {
      loadMemory: (namespace, sessionId) => store.loadSessionMemory(namespace, sessionId),
      saveMemory: (namespace, sessionId, messages) => store.saveSessionMemory(namespace, sessionId, messages),
      saveToolCall: (input) => store.saveSessionToolCall(input),
      listToolCalls: (input) => store.listSessionToolCalls(input),
      getToolCall: (input) => store.getSessionToolCall(input),
      saveArtifact: (input) => store.saveSessionArtifact(input),
      loadArtifact: (input) => store.loadSessionArtifact(input)
    }
  });
  // A changed placement must name a project that exists and, with a folder,
  // a folder of that same project. Unchanged placements are left alone.
  const workflowPlacementError = (
    workflow: { projectId?: string | null; folderId?: string | null },
    existing?: { projectId?: string | null; folderId?: string | null } | null
  ): string | null => {
    const projectId = workflow.projectId ?? existing?.projectId ?? DEFAULT_PROJECT_ID;
    const folderId = workflow.folderId ?? null;
    if (existing && projectId === (existing.projectId ?? DEFAULT_PROJECT_ID) && folderId === (existing.folderId ?? null)) return null;
    if (projectId !== DEFAULT_PROJECT_ID && !store.getProject(projectId)) return "Target project does not exist";
    if (folderId) {
      const folder = store.getFolder(folderId);
      if (!folder) return "Target folder does not exist";
      if (folder.projectId !== projectId) return "Target folder belongs to a different project";
    }
    return null;
  };
  // Saving a workflow needs write access to the one it replaces (same id) and
  // to the project it lands in (its own projectId, else the replaced one's),
  // and a placement that exists (400 otherwise).
  const workflowSaveDenial = (
    user: SafeUser,
    workflow: { id: string; projectId?: string | null; folderId?: string | null }
  ): { ok: false; status: 400 | 403 | 404; error: string } | null => {
    const existing = store.getWorkflow(workflow.id);
    if (existing) {
      const access = runAccess.workflow(user, existing.id, "workflow:write");
      if (!access.ok) return access;
    }
    const target = runAccess.project(user, workflow.projectId ?? existing?.projectId, "workflow:write");
    if (!target.ok) return target;
    const placement = workflowPlacementError(workflow, existing);
    return placement ? { ok: false, status: 400, error: placement } : null;
  };
  const denyRunAccess = (reply: FastifyReply, denial: { status: number; error: string }) => {
    reply.code(denial.status);
    return { error: denial.error };
  };
  const externalSecretsService = new ExternalSecretsService(store);
  const variablesService = new VariablesService(store);
  const workflowVersionService = new WorkflowVersionService(store, config.WORKFLOW_VERSION_RETENTION);
  const gitSyncService = new GitSyncService(store, secretService, variablesService, {
    workdirRoot: config.GIT_SYNC_WORKDIR,
    gitBin: config.GIT_BIN,
    commandTimeoutMs: config.GIT_COMMAND_TIMEOUT_MS,
    enabled: config.GIT_SYNC_ENABLED
  });

  // Phase 7.3 — Eval framework. Wires the existing runWorkflowExecution path
  // as the per-fixture executor so eval runs share routing, telemetry, and
  // history with regular runs. SQLite-only — see /docs/extensions/eval-framework
  // for the Postgres-parity follow-up note.
  /**
   * Phase 15.2 — whether `user` may hand this secret to a judge running for a
   * workflow in `projectId`: a non-internal secret the project's runs can
   * reach (the same rule as run-scope.ts: owned by the project, shared to it,
   * or a default-project secret in `role` isolation), and `secret:use` there.
   * Admins skip the `secret:use` check, never the project one. Checked when a
   * run starts and again for every judge call.
   */
  const canUseJudgeSecret = (user: SafeUser, secretId: string, projectId: string): boolean => {
    const row = store.getSecret(secretId);
    if (!row || isInternalSecretProvider(row.provider)) return false;
    const owningProject = row.projectId ?? DEFAULT_PROJECT_ID;
    const reachable =
      owningProject === projectId ||
      (config.PROJECT_ISOLATION === "role" && owningProject === DEFAULT_PROJECT_ID) ||
      store.listSecretsSharedToProject(projectId).includes(secretId);
    if (!reachable) return false;
    return user.role === "admin" || rbacService.can(user, projectId, "secret:use");
  };

  // Phase 9.5 / 15.2 — the LLM judge for judge scorers (faithfulness,
  // answer_relevance, llm_judge). EVAL_JUDGE_ENABLED=false turns every judge
  // call off. A judge authenticates with its scorer's secretRef, which must
  // still be usable by the run's user in the workflow's project when the
  // call is made; without one it may use the provider's environment keys
  // only when the operator set EVAL_JUDGE_ALLOW_ENV_CREDENTIALS. Judge calls
  // are priced with the deployment's price table (null when the model has no
  // price), counted into the run's cost and recorded as usage events of the
  // workflow's project.
  const evalLlmJudge: EvalLlmJudge = async (judgeInput) => {
    if (!config.EVAL_JUDGE_ENABLED) {
      throw new Error("LLM judges are turned off on this server (EVAL_JUDGE_ENABLED=false)");
    }
    const context = judgeInput.context;
    const workflow = context ? store.getWorkflow(context.workflowId) : null;
    const projectId = workflow?.projectId ?? DEFAULT_PROJECT_ID;
    const actor = context?.actorEmail ? evalPolicyActor(context.actorEmail) : null;
    if (judgeInput.secretRef) {
      if (!workflow || !actor || !canUseJudgeSecret(actor, judgeInput.secretRef.secretId, projectId)) {
        throw new Error(`the judge's secret ${judgeInput.secretRef.secretId} cannot be used by the user who started this run in this workflow's project`);
      }
    } else if (!config.EVAL_JUDGE_ALLOW_ENV_CREDENTIALS) {
      throw new Error("the judge has no secretRef: give the scorer one, or the operator can set EVAL_JUDGE_ALLOW_ENV_CREDENTIALS=true to use this server's provider keys");
    }
    const providerId = judgeInput.providerId ?? config.EVAL_JUDGE_PROVIDER_ID;
    const adapter = providerRegistry.tryGet(providerId);
    if (!adapter) {
      throw new Error(`eval judge provider "${providerId}" is not registered`);
    }
    const model = judgeInput.model ?? config.EVAL_JUDGE_MODEL;
    const startedAt = Date.now();
    const response = await adapter.generate(
      {
        provider: {
          providerId,
          model,
          temperature: judgeInput.temperature ?? config.EVAL_JUDGE_TEMPERATURE,
          maxTokens: config.EVAL_JUDGE_MAX_TOKENS,
          ...(judgeInput.secretRef ? { secretRef: judgeInput.secretRef } : {}),
          ...(config.EVAL_JUDGE_BASE_URL && providerId === config.EVAL_JUDGE_PROVIDER_ID ? { baseUrl: config.EVAL_JUDGE_BASE_URL } : {})
        },
        messages: [{ role: "user", content: judgeInput.prompt }]
      },
      // Secrets resolve in the workflow's project with the starting user's
      // rights, like the run's own nodes; without a workflow nothing resolves.
      { resolveSecret: workflow ? runScope.dependenciesFor(workflow, { actor }).resolveSecret : async () => undefined }
    );
    const usage = response.usage;
    const costUsd = usage
      ? usageService.estimateCostUsd(providerId, model, usage.inputTokens ?? 0, usage.outputTokens ?? 0, usage.cachedInputTokens ?? 0)
      : null;
    if (context) {
      try {
        usageService.recordExecution({
          executionId: context.executionId ?? context.runId,
          workflowId: context.workflowId,
          workflowName: workflow?.name ?? null,
          userEmail: context.actorEmail,
          projectId,
          triggerType: "eval_judge",
          status: "success",
          durationMs: Date.now() - startedAt,
          nodeResults: { judge: { _telemetry: { providerId, model, usage: usage ?? {}, llmCallCount: 1 } } }
        });
      } catch (error) {
        app.log.warn({ runId: context.runId, error: secretService.redact(error instanceof Error ? error.message : String(error)) }, "Failed to record judge usage");
      }
    }
    return { content: response.content ?? "", costUsd };
  };

  /** The most one judge call can cost: the longest judge prompt (at ~2 characters a token) plus a full reply, priced. */
  const judgeCallCeilingUsd = (scorer: { providerId?: string; model?: string }): number | null =>
    usageService.estimateCostUsd(
      scorer.providerId ?? config.EVAL_JUDGE_PROVIDER_ID,
      scorer.model ?? config.EVAL_JUDGE_MODEL,
      Math.ceil(JUDGE_PROMPT_MAX_CHARS / 2),
      config.EVAL_JUDGE_MAX_TOKENS,
      0
    );

  const evalPolicyActor = (email: string | undefined): SafeUser | null => {
    const found = email ? store.getUserByEmail(email) : null;
    if (!found || !MCP_POLICY_ROLES.includes(found.role as McpPolicyRole)) return null;
    return { id: found.id, email: found.email, role: found.role as UserRole };
  };

  /**
   * Phase 10.8 — the MCP plan for one eval fixture: record, replay one
   * cassette, or replay the cassette a past eval run recorded for the same fixture.
   */
  const planEvalMcp = (input: Parameters<EvalWorkflowExecutor>[0]): McpCassetteRunPlan | undefined => {
    const replay = input.mcp?.replay;
    if (replay) {
      let record: McpCassetteRecord | null = null;
      if (replay.cassetteId) {
        record = store.getMcpCassette(replay.cassetteId);
        if (!record) throw new Error(`Cassette not found: ${replay.cassetteId}`);
      } else if (replay.evalRunId) {
        const match = store
          .listMcpCassettesForEvalRun(replay.evalRunId)
          .filter((entry) => entry.fixtureId === input.fixtureId)
          .at(-1);
        record = match ? store.getMcpCassette(match.id) : null;
        if (!record) throw new Error(`Eval run ${replay.evalRunId} recorded no cassette for fixture '${input.fixtureName}'.`);
      }
      if (!record) throw new Error("Replay needs a cassetteId or an evalRunId.");
      return mcpCassetteService.planReplay(record, replay.mode ?? "strict", mcpRegistry, resolveRegisteredMcpServer);
    }
    return input.mcp?.record ? mcpCassetteService.planRecording(mcpRegistry) : undefined;
  };

  /**
   * The user a background eval run or replay job runs as: the one who
   * started it, looked up again for every case, as long as they may still run
   * the workflow (the same rule as queued runs). The run then executes with
   * their policy and project scope (run-scope.ts).
   */
  const evalRunActor = (email: string, workflowId: string): SafeUser | null => {
    const actor = evalPolicyActor(email);
    return actor && runAccess.workflow(actor, workflowId, "workflow:execute").ok ? actor : null;
  };

  const evalService = new EvalService(store, async (input) => {
    const workflow = store.getWorkflow(input.workflowId);
    if (!workflow) {
      return { output: null, error: `Workflow not found: ${input.workflowId}` };
    }
    const policyActor = input.triggeredBy ? evalRunActor(input.triggeredBy, workflow.id) : null;
    if (input.triggeredBy && !policyActor) {
      return { output: null, error: `The user who started this run (${input.triggeredBy}) can no longer run this workflow.` };
    }
    const executionId = input.executionId ?? crypto.randomUUID();
    const fixtureRecord =
      input.fixtureInput && typeof input.fixtureInput === "object" && !Array.isArray(input.fixtureInput)
        ? (input.fixtureInput as Record<string, unknown>)
        : { input: input.fixtureInput };
    const startedAt = Date.now();
    // Phase 10.8 — record this fixture's MCP calls, or answer them from a cassette.
    let mcpPlan: McpCassetteRunPlan | undefined;
    try {
      mcpPlan = planEvalMcp(input);
    } catch (err) {
      return { output: null, error: err instanceof Error ? err.message : String(err) };
    }
    try {
      const executed = await runWorkflowExecution({
        workflow,
        executionId,
        directInput: { trigger_type: "eval", eval_run_id: input.runId, eval_fixture_name: input.fixtureName, ...fixtureRecord },
        triggerType: "eval",
        triggeredBy: input.triggeredBy,
        // Eval runs are started by a signed-in builder; their email is recorded server-side.
        policyActor,
        mcpPlan
      });
      const result = finishMcpCassettePlan(mcpPlan, executed, {
        executionId,
        workflow,
        source: "eval",
        createdBy: input.triggeredBy ?? null,
        evalRunId: input.runId,
        fixtureId: input.fixtureId
      });
      persistExecutionHistory({
        executionId,
        workflow,
        result,
        triggerType: "eval",
        triggeredBy: input.triggeredBy,
        requestInput: fixtureRecord
      });
      // Aggregate token usage from each node's _telemetry blob (Phase 7.1).
      let tokenInput = 0;
      let tokenOutput = 0;
      let tokenTotal = 0;
      let sawTokens = false;
      for (const nr of result.nodeResults) {
        const out = nr.output;
        if (!out || typeof out !== "object" || Array.isArray(out)) continue;
        const tel = (out as Record<string, unknown>)._telemetry;
        if (!tel || typeof tel !== "object") continue;
        const usage = (((tel as Record<string, unknown>).usage ?? {}) as Record<string, unknown>);
        if (typeof usage.inputTokens === "number") { tokenInput += usage.inputTokens; sawTokens = true; }
        if (typeof usage.outputTokens === "number") { tokenOutput += usage.outputTokens; sawTokens = true; }
        if (typeof usage.totalTokens === "number") { tokenTotal += usage.totalTokens; sawTokens = true; }
      }
      const durationMs = Date.now() - startedAt;
      // Phase 15.2 — what the run did, for the status, tool, guard and budget scorers (used for scoring only, not stored).
      const facts = buildRunFacts({
        status: result.status,
        error: result.error ?? null,
        output: result.output,
        durationMs,
        nodeResults: result.nodeResults,
        nodes: workflow.nodes,
        guardEvents: store.listGuardEventsForExecution(executionId),
        priceTurn: (providerId, model, inputTokens, outputTokens, cachedInputTokens) => usageService.estimateCostUsd(providerId, model, inputTokens, outputTokens, cachedInputTokens)
      });
      return {
        executionId,
        output: result.output,
        error: result.status !== "success" ? (result.error ?? `execution status: ${result.status}`) : undefined,
        durationMs,
        tokens: sawTokens ? { input: tokenInput, output: tokenOutput, total: tokenTotal } : undefined,
        facts
      };
    } catch (err) {
      return {
        executionId,
        output: null,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt
      };
    }
  }, evalLlmJudge, {
    concurrency: config.REPLAY_CONCURRENCY,
    maxCases: config.REPLAY_JOB_MAX_CASES,
    defaultMaxCostUsd: config.REPLAY_JOB_DEFAULT_MAX_COST_USD,
    evalRunMaxCostUsd: config.EVAL_RUN_MAX_COST_USD,
    judgeCallCeilingUsd,
    maxResultBytes: config.EVAL_RESULT_MAX_BYTES,
    // Provider error bodies and reasons are stored and shown to viewers: no secret value goes with them.
    scrub: (text) => String(secretService.redact(replayRecordingService.scrubber().text(text))),
    abortExecution: (executionId, reason) => activeExecutions.get(executionId)?.controller.abort(reason),
    // Phase 15.2 — replay jobs use the 15.1 replay machinery, built further down.
    replay: {
      resolveCandidate: (workflowId, request) => {
        const candidate = replayService.resolveWorkflowCandidate(workflowId, request);
        return { ...candidate, workflowHash: ReplayService.candidateHash(candidate.workflow) };
      },
      getRecording: (id) => store.getReplayRecording(id),
      // The candidate was resolved when the job started; it runs in the workflow's current project.
      replayCase: ({ recording, candidate, request, actor, executionId }) => {
        const current = store.getWorkflow(candidate.workflow.id);
        if (!current) throw new ReplayRunError("The workflow this golden run belongs to no longer exists.", "not_found");
        const scoped = { ...candidate, workflow: { ...candidate.workflow, projectId: current.projectId, folderId: current.folderId } };
        return replayService.replay(recording, request, actor, { candidate: scoped, executionId });
      },
      actorFor: (email, workflowId) => evalRunActor(email, workflowId)
    },
    logger: { warn: (message, fields) => app.log.warn(fields ?? {}, message) }
  });
  app.addHook("onClose", async () => {
    evalService.shutdown();
  });

  const workerMode = config.WORKER_MODE;
  const runsBackgroundWorkers = workerMode === "all" || workerMode === "worker";
  // SQLite cannot be shared between processes; on Postgres another instance may own a live run.
  const sharedDatabase = config.HA_ENABLED || (store as object) instanceof PostgresStore;

  // Phase 15.2 — eval runs and replay jobs a stopped server left queued or
  // running. The same rules as the execution reconcile below: webhook
  // replicas never touch other instances' runs, and on a shared database only
  // runs no live instance has touched lately are interrupted. Eval storage is
  // SQLite-only, so a store without it skips this.
  const evalStoreReady = typeof (store as unknown as { listEvalRuns?: unknown }).listEvalRuns === "function";
  const recoverEvalRuns = (reason: "startup" | "interval") => {
    try {
      const interrupted = evalService.recoverInterrupted({ onlyStale: sharedDatabase });
      if (interrupted > 0) app.log.warn({ count: interrupted, reason }, "Marked eval runs and replay jobs interrupted by a restart");
    } catch (err) {
      app.log.warn({ err: err instanceof Error ? err.message : String(err), reason }, "Failed to mark interrupted eval runs");
    }
  };
  if (!evalStoreReady) {
    app.log.info("This database has no eval storage; skipping the interrupted eval run check");
  } else if (workerMode !== "webhook") {
    recoverEvalRuns("startup");
    if (sharedDatabase) {
      // An instance that died is noticed by the others, not only by the next one to boot.
      const evalRecoveryTimer = setInterval(() => recoverEvalRuns("interval"), EVAL_RUN_STALE_MS);
      (evalRecoveryTimer as { unref?: () => void }).unref?.();
      app.addHook("onClose", async () => {
        clearInterval(evalRecoveryTimer);
      });
    }
  }
  const leaderElection = new LeaderElectionService(
    store,
    {
      enabled: config.HA_ENABLED,
      instanceId: config.HA_INSTANCE_ID,
      leaseTtlMs: config.HA_LEASE_TTL_MS,
      renewIntervalMs: config.HA_RENEW_INTERVAL_MS,
      onBecomeLeader: async () => {
        // Webhook replicas run beside the main instances with HA off; they never own other instances' runs.
        if (workerMode !== "webhook") {
          try {
            const interrupted = await reconcileInterruptedRuns(store, { sharedDatabase });
            if (interrupted.length > 0) {
              app.log.warn(
                { count: interrupted.length, executionIds: interrupted.slice(0, 50).map((run) => run.id) },
                "Marked interrupted runs as errors after a restart"
              );
            }
          } catch (err) {
            app.log.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to reconcile interrupted runs");
          }
        }
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
  // Phase 8.1 — OpenTelemetry-grade observability.
  // Endpoint resolution, in priority order:
  //   1. OTEL_EXPORTER_OTLP_TRACES_ENDPOINT (per-signal override, OTel spec)
  //   2. OTEL_EXPORTER_OTLP_ENDPOINT + "/v1/traces" (combined endpoint)
  //   3. legacy TRACING_ENDPOINT (kept for back-compat with existing deploys)
  // Tracing is enabled if any of those is set OR TRACING_ENABLED=true.
  const otlpHeaders = parseKeyValueList(config.OTEL_EXPORTER_OTLP_HEADERS);
  const otelTracesEndpoint =
    config.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
    (config.OTEL_EXPORTER_OTLP_ENDPOINT
      ? config.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/+$/, "") + "/v1/traces"
      : undefined) ||
    config.TRACING_ENDPOINT;
  const otelMetricsEndpoint =
    config.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ||
    (config.OTEL_EXPORTER_OTLP_ENDPOINT
      ? config.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/+$/, "") + "/v1/metrics"
      : undefined);
  const otelServiceName = config.OTEL_SERVICE_NAME || config.TRACING_SERVICE_NAME;
  const baseResourceAttributes: Record<string, string> = {
    "service.name": otelServiceName,
    ...(config.OTEL_SERVICE_VERSION ? { "service.version": config.OTEL_SERVICE_VERSION } : {}),
    ...(config.OTEL_DEPLOYMENT_ENVIRONMENT
      ? { "deployment.environment": config.OTEL_DEPLOYMENT_ENVIRONMENT }
      : {}),
    ...parseKeyValueList(config.OTEL_RESOURCE_ATTRIBUTES)
  };
  const tracingService = new TracingService({
    enabled: config.TRACING_ENABLED || Boolean(otelTracesEndpoint),
    endpoint: otelTracesEndpoint,
    serviceName: otelServiceName,
    resourceAttributes: baseResourceAttributes,
    otlpHeaders
  });

  let otlpMetricsExporter: OtlpMetricsExporter | null = null;
  if (config.OTEL_METRICS_ENABLED && otelMetricsEndpoint) {
    otlpMetricsExporter = new OtlpMetricsExporter(metricsService, {
      endpoint: otelMetricsEndpoint,
      resourceAttributes: baseResourceAttributes,
      headers: otlpHeaders,
      intervalMs: config.OTEL_METRICS_PUSH_INTERVAL_MS,
      serviceName: otelServiceName
    });
    otlpMetricsExporter.setLogger({
      warn: (msg, fields) => app.log.warn(fields ?? {}, msg)
    });
    otlpMetricsExporter.start();
    app.addHook("onClose", async () => {
      await otlpMetricsExporter?.stop();
    });
  }
  secretService.attachExternalSecrets(externalSecretsService);
  const auditService = new AuditService(store, { enabled: config.AUDIT_LOG_ENABLED });
  const usageService = new UsageService(store, { pricingOverridesJson: config.LLM_PRICING_OVERRIDES_JSON });
  usageService.setLogger({
    info: (msg, fields) => app.log.info(fields ?? {}, msg),
    warn: (msg, fields) => app.log.warn(fields ?? {}, msg)
  });
  const budgetService = new BudgetService(store);
  budgetService.setLogger({
    info: (msg, fields) => app.log.info(fields ?? {}, msg),
    warn: (msg, fields) => app.log.warn(fields ?? {}, msg)
  });
  const auditExportService = new AuditExportService(store, {
    checkIntervalMs: config.AUDIT_EXPORT_CHECK_INTERVAL_MS,
    batchSize: config.AUDIT_EXPORT_BATCH_SIZE,
    safeFsRoot: config.AUDIT_EXPORT_FILE_ROOT
  });
  auditExportService.setLogger({
    info: (msg, fields) => app.log.info(fields ?? {}, msg),
    warn: (msg, fields) => app.log.warn(fields ?? {}, msg)
  });
  if (config.AUDIT_EXPORT_ENABLED) {
    auditExportService.start();
    app.addHook("onClose", async () => {
      await auditExportService.stop();
    });
  }
  const mcpProbeService = new McpProbeService(
    store,
    mcpRegistry,
    {
      resolveSecret: (secretRef) => secretService.resolveSecret(secretRef),
      isLeader: () => leaderElection.isLeader(),
      checkSandbox: (serverConfig) => mcpSandboxLauncher.check(serverConfig),
      // Phase 10.7 — delegated servers are probed with one user's own connection.
      delegatedProbeUser: (server, requestedBy) => {
        const connected = (userId: string | null | undefined) =>
          userId && store.getMcpUserOAuthConnection(server.id, userId)?.secretId ? userId : null;
        if (requestedBy) return connected(requestedBy);
        const creator = server.createdBy ? store.getUserByEmail(server.createdBy) : null;
        return connected(creator?.id);
      }
    },
    {
      defaultIntervalMs: config.MCP_PROBE_INTERVAL_MS,
      probeTimeoutMs: config.MCP_PROBE_TIMEOUT_MS,
      keepProbes: config.MCP_PROBE_HISTORY_LIMIT
    }
  );
  mcpProbeService.setLogger({
    info: (msg, fields) => app.log.info(fields ?? {}, msg),
    warn: (msg, fields) => app.log.warn(fields ?? {}, msg)
  });
  if (runsBackgroundWorkers) {
    mcpProbeService.start();
  }
  app.addHook("onClose", async () => {
    mcpProbeService.stop();
  });
  // Phase 10.5 — questions MCP servers ask the person running a workflow.
  const mcpElicitationService = new McpElicitationService(store, {
    timeoutMs: config.MCP_ELICITATION_TIMEOUT_MS,
    audit: (event) => {
      auditService.record(event);
      logStreamingService.dispatchAudit(event);
    },
    logger: {
      info: (msg, fields) => app.log.info(fields ?? {}, msg),
      warn: (msg, fields) => app.log.warn(fields ?? {}, msg)
    }
  });
  mcpElicitationService.expireStale();
  app.addHook("onClose", async () => {
    mcpElicitationService.stop();
  });
  // Phase 10.6 — deployment-local MCP catalog. Every instance reads and
  // watches the file itself (presets and enforcement are served everywhere).
  const mcpCatalogService = new McpCatalogService({
    filePath: config.MCP_CATALOG_FILE,
    mode: config.MCP_CATALOG_MODE,
    enforce: config.MCP_CATALOG_ENFORCE,
    logger: {
      info: (msg, fields) => app.log.info(fields ?? {}, msg),
      warn: (msg, fields) => app.log.warn(fields ?? {}, msg)
    }
  });
  mcpCatalogService.start();
  app.addHook("onClose", async () => {
    mcpCatalogService.stop();
  });
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

  const notificationService = new NotificationService(config, () =>
    store.listNotificationConfigs().map(c => ({
      channel: c.channel,
      enabled: c.enabled,
      config: c.config,
      events: c.events
    }))
  );

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
  // User-initiated run actions (not webhook/schedule runs). Cancel passes the run's workflow id.
  const auditRunAction = (
    request: { ip?: string; headers: Record<string, unknown> },
    user: SafeUser,
    eventType: "execution.started" | "execution.retried" | "execution.replayed" | "execution.cancel_requested",
    run: { executionId: string; workflowId: string; projectId?: string | null },
    metadata: Record<string, unknown> = {}
  ) => {
    audit(request, user, {
      category: "execution",
      eventType,
      action: eventType === "execution.cancel_requested" ? "cancel" : "execute",
      outcome: "success",
      resourceType: "workflow",
      resourceId: run.workflowId,
      projectId: run.projectId ?? null,
      metadata: { executionId: run.executionId, ...metadata }
    });
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

  const studioCorsOptions = {
    origin: (origin: string | undefined, callback: (error: Error | null, allow: boolean) => void) => {
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
  };
  // Phase 10.4 — the MCP endpoint authenticates with bearer tokens, never
  // cookies, and accepts only its own allowed origins.
  const mcpGatewayOrigins = gatewayAllowedOrigins(config);
  const mcpCorsOptions = {
    origin: (origin: string | undefined, callback: (error: Error | null, allow: boolean) => void) => {
      callback(null, !origin || isGatewayOriginAllowed(mcpGatewayOrigins, origin));
    },
    credentials: false,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "Accept", "Mcp-Session-Id", "MCP-Protocol-Version", "Last-Event-ID"],
    exposedHeaders: ["Mcp-Session-Id", "WWW-Authenticate"]
  };
  app.register(cors, {
    delegator: (request, callback) => {
      const isMcpEndpoint = (request.url ?? "").startsWith("/mcp/");
      callback(null, isMcpEndpoint ? mcpCorsOptions : studioCorsOptions);
    }
  });

  // Phase 4.2 — Security headers via @fastify/helmet
  // HSTS and CSP default OFF because both routinely break local dev (HSTS
  // requires HTTPS; CSP requires inline-script audits). Enable per-deployment
  // via HELMET_HSTS_ENABLED and HELMET_CSP_ENABLED. Always-on protections:
  // X-Frame-Options DENY (clickjacking), X-Content-Type-Options nosniff,
  // Referrer-Policy no-referrer, Cross-Origin-Resource-Policy same-origin.
  if (config.HELMET_ENABLED) {
    app.register(helmet, {
      contentSecurityPolicy: config.HELMET_CSP_ENABLED ? undefined : false,
      strictTransportSecurity: config.HELMET_HSTS_ENABLED
        ? { maxAge: 15_552_000, includeSubDomains: true, preload: false }
        : false,
      frameguard: { action: "deny" },
      noSniff: true,
      referrerPolicy: { policy: "no-referrer" },
      crossOriginResourcePolicy: { policy: "same-origin" },
      // Disable HTTPS-only headers Helmet adds by default that would break
      // the local-dev HTTP setup. Self-hosters running behind a proxy can
      // turn these on individually via the env flags above.
      crossOriginOpenerPolicy: false,
      crossOriginEmbedderPolicy: false,
      originAgentCluster: false
    });
  }

  // Phase 4.1 — Rate limiting via @fastify/rate-limit
  // Global default: RATE_LIMIT_GLOBAL_MAX requests per RATE_LIMIT_GLOBAL_WINDOW_MS
  // per IP. Stricter per-route limits for auth (brute-force protection) and
  // public webhook routes (flood protection) are applied via the onRoute hook
  // below — that way we don't have to touch ~15 route definitions individually.
  // Disable entirely with RATE_LIMIT_ENABLED=false (default true; tests opt out).
  if (config.RATE_LIMIT_ENABLED) {
    // IMPORTANT: this onRoute hook MUST be added before app.register(rateLimit)
    // below. Fastify hooks fire in registration order, and @fastify/rate-limit
    // installs its own onRoute hook that snapshots routeOptions.config.rateLimit
    // at registration time. If our hook ran second, the plugin would already
    // have read the default and our per-route limits would never apply.
    const AUTH_BURST_PREFIXES = [
      "/api/auth/login",
      "/api/auth/register",
      "/api/auth/saml/callback",
      "/api/auth/ldap/login"
    ];
    const WEBHOOK_PREFIXES = ["/webhook/", "/webhook-test/", "/api/webhooks/"];
    const PROBE_URLS = new Set(["/health", "/metrics"]);
    app.addHook("onRoute", (routeOptions) => {
      const url = String(routeOptions.url ?? "");
      const isProbe = PROBE_URLS.has(url);
      const matchesAuth = AUTH_BURST_PREFIXES.some((prefix) => url.startsWith(prefix));
      const matchesWebhook = WEBHOOK_PREFIXES.some((prefix) => url.startsWith(prefix));
      if (!isProbe && !matchesAuth && !matchesWebhook) {
        return;
      }
      const existingConfig = (routeOptions.config ?? {}) as Record<string, unknown>;
      // Don't overwrite a per-route limit that's already been set explicitly.
      if (existingConfig.rateLimit !== undefined) {
        return;
      }
      let perRouteLimit: false | { max: number; timeWindow: number };
      if (isProbe) {
        perRouteLimit = false;
      } else if (matchesAuth) {
        perRouteLimit = {
          max: config.RATE_LIMIT_AUTH_MAX,
          timeWindow: config.RATE_LIMIT_AUTH_WINDOW_MS
        };
      } else {
        perRouteLimit = {
          max: config.RATE_LIMIT_WEBHOOK_MAX,
          timeWindow: config.RATE_LIMIT_WEBHOOK_WINDOW_MS
        };
      }
      routeOptions.config = {
        ...existingConfig,
        rateLimit: perRouteLimit
      };
    });

    app.register(rateLimit, {
      global: true,
      max: config.RATE_LIMIT_GLOBAL_MAX,
      timeWindow: config.RATE_LIMIT_GLOBAL_WINDOW_MS,
      addHeadersOnExceeding: {
        "x-ratelimit-limit": true,
        "x-ratelimit-remaining": true,
        "x-ratelimit-reset": true
      },
      addHeaders: {
        "x-ratelimit-limit": true,
        "x-ratelimit-remaining": true,
        "x-ratelimit-reset": true,
        "retry-after": true
      }
    });
  }

  app.register(cookie);
  app.register(fastifyRawBody, {
    field: "rawBody",
    global: false,
    encoding: "utf8",
    runFirst: true
  });

  // Phase 4.4 — Echo the request ID back as x-request-id so clients can
  // correlate their requests with server logs. Honors an incoming
  // X-Request-ID header (handled by Fastify's requestIdHeader option above);
  // otherwise sets the freshly-generated nanoid. onSend fires before the
  // body is flushed so the header lands on every response, including 4xx/5xx.
  app.addHook("onSend", async (request, reply) => {
    if (!reply.getHeader("x-request-id")) {
      reply.header("x-request-id", request.id);
    }
  });

  // Phase 5.7 — HTTP metrics hook
  app.addHook("onResponse", async (request, reply) => {
    const elapsed = reply.elapsedTime ?? 0;
    metricsService.recordHttpRequest(request.method, reply.statusCode, elapsed);
  });

  // Phase 8.1 — HTTP server spans + W3C trace-context propagation.
  // We open an OTel SERVER span at onRequest time and end it onResponse so
  // every request shows up in the trace UI alongside per-execution/per-node
  // spans. If the client passes a `traceparent` header we adopt its trace ID
  // to keep the trace continuous across our boundary; otherwise we mint a
  // fresh one. Skipped for /health and /metrics so they don't drown out
  // useful spans.
  if (config.OTEL_HTTP_SERVER_SPANS) {
    const spanByReqId = new Map<string, ReturnType<typeof tracingService.startSpan>>();
    const skipPaths = new Set(["/health", "/metrics"]);
    app.addHook("onRequest", async (request) => {
      if (skipPaths.has(request.url.split("?")[0] ?? "")) return;
      const headers = request.headers;
      const incoming = parseTraceparent(
        typeof headers["traceparent"] === "string" ? (headers["traceparent"] as string) : undefined
      );
      const span = tracingService.startSpan({
        operationName: `${request.method} ${request.routeOptions?.url ?? request.url}`,
        kind: "server",
        traceId: incoming?.traceId,
        parentSpanId: incoming?.parentSpanId,
        attributes: {
          "http.method": request.method,
          "http.target": request.url,
          "http.route": request.routeOptions?.url ?? request.url,
          "http.scheme": request.protocol,
          "net.peer.ip": request.ip ?? "",
          "request.id": request.id ?? ""
        }
      });
      spanByReqId.set(request.id, span);
      // Make the span discoverable to downstream code (e.g. workflow execution)
      // via request.requestContext-like accessor — Fastify has request.diagnosticsChannel
      // but for simplicity we attach to request directly.
      (request as unknown as { otelSpan?: typeof span }).otelSpan = span;
    });
    app.addHook("onResponse", async (request, reply) => {
      const span = spanByReqId.get(request.id);
      if (!span) return;
      spanByReqId.delete(request.id);
      tracingService.setAttribute(span, "http.status_code", reply.statusCode);
      tracingService.endSpan(span, reply.statusCode >= 500 ? "error" : "ok");
    });
  }

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
      tracing: {
        enabled: tracingService.isEnabled(),
        tracesEndpoint: otelTracesEndpoint ?? null,
        resourceAttributes: tracingService.getResourceAttributes()
      },
      otlpMetrics: {
        enabled: otlpMetricsExporter !== null,
        endpoint: otelMetricsEndpoint ?? null,
        intervalMs: otlpMetricsExporter ? config.OTEL_METRICS_PUSH_INTERVAL_MS : null
      }
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

  // Phase 8.2 — FinOps endpoints. Admin-only; the dashboard reads through
  // these for KPI cards, time-series charts, and dimensional rollups.
  // Default window is the last 30 days. The query layer caps result rows
  // at 500 to keep responses bounded.
  const parseUsageWindow = (query: { from?: string; to?: string } | undefined): { from: string; to: string } => {
    const now = new Date();
    const defaultTo = now.toISOString();
    const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const from = query?.from && !isNaN(Date.parse(query.from)) ? new Date(query.from).toISOString() : defaultFrom;
    const to = query?.to && !isNaN(Date.parse(query.to)) ? new Date(query.to).toISOString() : defaultTo;
    return { from, to };
  };

  app.get("/api/usage/totals", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const query = request.query as { from?: string; to?: string; workflowId?: string; userId?: string; projectId?: string } | undefined;
    const window = parseUsageWindow(query);
    return {
      window,
      totals: store.queryUsageTotals({
        ...window,
        workflowId: query?.workflowId,
        userId: query?.userId,
        projectId: query?.projectId
      })
    };
  });

  app.get("/api/usage/rollup", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const query = request.query as {
      from?: string; to?: string;
      groupBy?: "day" | "hour" | "workflow" | "user" | "project" | "provider";
      workflowId?: string; userId?: string; projectId?: string;
      limit?: string;
    } | undefined;
    const window = parseUsageWindow(query);
    const groupBy = query?.groupBy ?? "day";
    if (!["day", "hour", "workflow", "user", "project", "provider"].includes(groupBy)) {
      reply.code(400);
      return { error: `invalid groupBy: ${groupBy}` };
    }
    return {
      window,
      groupBy,
      rows: store.queryUsageRollup({
        ...window,
        groupBy,
        workflowId: query?.workflowId,
        userId: query?.userId,
        projectId: query?.projectId,
        limit: query?.limit ? Number(query.limit) : undefined
      })
    };
  });

  app.get("/api/usage/recent", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const query = request.query as { limit?: string; workflowId?: string; userId?: string; projectId?: string } | undefined;
    return {
      events: store.listUsageEvents({
        limit: query?.limit ? Number(query.limit) : 50,
        workflowId: query?.workflowId,
        userId: query?.userId,
        projectId: query?.projectId
      })
    };
  });

  app.get("/api/usage/pricing", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    return { pricing: usageService.getPricing() };
  });

  // Phase 8.3 — budgets CRUD (admin-only).
  app.get("/api/budgets", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const query = request.query as { scopeType?: string; enabledOnly?: string } | undefined;
    return {
      budgets: store.listBudgets({
        scopeType: query?.scopeType,
        enabledOnly: query?.enabledOnly === "true"
      })
    };
  });

  app.post<{ Body: unknown }>("/api/budgets", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const body = request.body as Partial<{
      name: string;
      scopeType: "global" | "project" | "workflow" | "user";
      scopeId: string | null;
      period: "day" | "week" | "month";
      limitType: "usd" | "tokens";
      limitValue: number;
      warnThresholdPct: number;
      action: "warn" | "block";
      notifyChannel: string | null;
      enabled: boolean;
    }> | undefined;
    if (!body || typeof body.name !== "string" || !body.name.trim()) {
      reply.code(400);
      return { error: "name is required" };
    }
    if (!body.scopeType || !["global", "project", "workflow", "user"].includes(body.scopeType)) {
      reply.code(400);
      return { error: "scopeType must be one of global|project|workflow|user" };
    }
    if (!body.period || !["day", "week", "month"].includes(body.period)) {
      reply.code(400);
      return { error: "period must be one of day|week|month" };
    }
    if (!body.limitType || !["usd", "tokens"].includes(body.limitType)) {
      reply.code(400);
      return { error: "limitType must be one of usd|tokens" };
    }
    if (typeof body.limitValue !== "number" || body.limitValue <= 0) {
      reply.code(400);
      return { error: "limitValue must be a positive number" };
    }
    if (!body.action || !["warn", "block"].includes(body.action)) {
      reply.code(400);
      return { error: "action must be one of warn|block" };
    }
    if (body.scopeType !== "global" && !body.scopeId) {
      reply.code(400);
      return { error: "scopeId required for non-global budgets" };
    }
    const id = `bgt_${crypto.randomUUID()}`;
    store.createBudget({
      id,
      name: body.name.trim(),
      scopeType: body.scopeType,
      scopeId: body.scopeId ?? null,
      period: body.period,
      limitType: body.limitType,
      limitValue: body.limitValue,
      warnThresholdPct: body.warnThresholdPct ?? 0.8,
      action: body.action,
      notifyChannel: body.notifyChannel ?? null,
      enabled: body.enabled !== false,
      createdBy: user.email
    });
    auditService.record({
      category: "system",
      eventType: "budget.created",
      action: "create",
      outcome: "success",
      actor: { email: user.email, type: "user" },
      resourceType: "budget",
      resourceId: id,
      metadata: { scopeType: body.scopeType, limitType: body.limitType, limitValue: body.limitValue, action: body.action }
    });
    return { budget: store.getBudget(id) };
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/api/budgets/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const existing = store.getBudget(request.params.id);
    if (!existing) {
      reply.code(404);
      return { error: "Budget not found" };
    }
    const patch = request.body as Partial<{
      name: string;
      limitValue: number;
      warnThresholdPct: number;
      action: "warn" | "block";
      notifyChannel: string | null;
      enabled: boolean;
    }> | undefined;
    if (!patch || typeof patch !== "object") {
      reply.code(400);
      return { error: "Empty update payload" };
    }
    store.updateBudget(request.params.id, patch);
    auditService.record({
      category: "system",
      eventType: "budget.updated",
      action: "update",
      outcome: "success",
      actor: { email: user.email, type: "user" },
      resourceType: "budget",
      resourceId: request.params.id,
      metadata: { ...patch }
    });
    return { budget: store.getBudget(request.params.id) };
  });

  app.delete<{ Params: { id: string } }>("/api/budgets/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const existing = store.getBudget(request.params.id);
    if (!existing) {
      reply.code(404);
      return { error: "Budget not found" };
    }
    store.deleteBudget(request.params.id);
    auditService.record({
      category: "system",
      eventType: "budget.deleted",
      action: "delete",
      outcome: "success",
      actor: { email: user.email, type: "user" },
      resourceType: "budget",
      resourceId: request.params.id
    });
    return { ok: true };
  });

  app.get("/api/budget-alerts", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const query = request.query as { budgetId?: string; limit?: string } | undefined;
    return {
      alerts: store.listBudgetAlerts({
        budgetId: query?.budgetId,
        limit: query?.limit ? Number(query.limit) : 100
      })
    };
  });

  // Phase 8.4 — audit chain integrity + export destinations.

  app.get("/api/audit-log/verify-chain", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    return store.verifyAuditChain();
  });

  app.get("/api/audit-export/destinations", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    return { destinations: store.listAuditExportDestinations() };
  });

  app.post<{ Body: unknown }>("/api/audit-export/destinations", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const body = request.body as Partial<{
      name: string;
      kind: "http" | "file";
      config: Record<string, unknown>;
      intervalSeconds: number;
      enabled: boolean;
    }> | undefined;
    if (!body || typeof body.name !== "string" || !body.name.trim()) {
      reply.code(400);
      return { error: "name is required" };
    }
    if (!body.kind || !["http", "file"].includes(body.kind)) {
      reply.code(400);
      return { error: "kind must be one of http|file" };
    }
    if (!body.config || typeof body.config !== "object") {
      reply.code(400);
      return { error: "config object is required" };
    }
    if (body.kind === "http" && typeof (body.config as { url?: unknown }).url !== "string") {
      reply.code(400);
      return { error: "http destination requires config.url" };
    }
    if (body.kind === "file" && typeof (body.config as { path?: unknown }).path !== "string") {
      reply.code(400);
      return { error: "file destination requires config.path" };
    }
    const id = `axdest_${crypto.randomUUID()}`;
    store.createAuditExportDestination({
      id,
      name: body.name.trim(),
      kind: body.kind,
      config: body.config,
      intervalSeconds: body.intervalSeconds ?? 3600,
      enabled: body.enabled !== false,
      createdBy: user.email
    });
    auditService.record({
      category: "system",
      eventType: "audit_export.destination.created",
      action: "create",
      outcome: "success",
      actor: { email: user.email, type: "user" },
      resourceType: "audit_export_destination",
      resourceId: id,
      metadata: { kind: body.kind, intervalSeconds: body.intervalSeconds ?? 3600 }
    });
    return { destination: store.getAuditExportDestination(id) };
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/api/audit-export/destinations/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const existing = store.getAuditExportDestination(request.params.id);
    if (!existing) {
      reply.code(404);
      return { error: "Destination not found" };
    }
    const patch = request.body as Partial<{
      name: string;
      config: Record<string, unknown>;
      intervalSeconds: number;
      enabled: boolean;
    }> | undefined;
    if (!patch || typeof patch !== "object") {
      reply.code(400);
      return { error: "Empty update payload" };
    }
    store.updateAuditExportDestination(request.params.id, patch);
    auditService.record({
      category: "system",
      eventType: "audit_export.destination.updated",
      action: "update",
      outcome: "success",
      actor: { email: user.email, type: "user" },
      resourceType: "audit_export_destination",
      resourceId: request.params.id,
      metadata: { ...patch }
    });
    return { destination: store.getAuditExportDestination(request.params.id) };
  });

  app.delete<{ Params: { id: string } }>("/api/audit-export/destinations/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const existing = store.getAuditExportDestination(request.params.id);
    if (!existing) {
      reply.code(404);
      return { error: "Destination not found" };
    }
    store.deleteAuditExportDestination(request.params.id);
    auditService.record({
      category: "system",
      eventType: "audit_export.destination.deleted",
      action: "delete",
      outcome: "success",
      actor: { email: user.email, type: "user" },
      resourceType: "audit_export_destination",
      resourceId: request.params.id
    });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/audit-export/destinations/:id/run", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const existing = store.getAuditExportDestination(request.params.id);
    if (!existing) {
      reply.code(404);
      return { error: "Destination not found" };
    }
    try {
      const outcome = await auditExportService.runDestination(request.params.id);
      return { outcome };
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Phase 9.1 — Knowledge bases (built-in persistent vector store).
  // builder role for read; admin for create/update/delete to keep the data
  // tier governed (these are persistent corpora; non-admins shouldn't
  // wipe them).
  // A knowledge base with a project belongs to it: reading needs `workflow:read`
  // there and adding content needs `workflow:write`, and other users get 404.
  // One without a project is shared across the deployment (admins create these):
  // everyone can read it, but only an admin may add content, since every
  // project's runs retrieve from it.
  const knowledgeBaseAccess = (user: SafeUser, id: string, permission: "workflow:read" | "workflow:write") => {
    const kb = store.getKnowledgeBase(id);
    if (!kb) return { ok: false as const, status: 404 as const, error: "Knowledge base not found" };
    if (!kb.projectId) {
      if (permission === "workflow:write" && user.role !== "admin") {
        return { ok: false as const, status: 403 as const, error: "Only an admin can add content to a shared knowledge base" };
      }
      return { ok: true as const, kb };
    }
    const access = runAccess.project(user, kb.projectId, permission, "Knowledge base");
    return access.ok ? { ok: true as const, kb } : access;
  };

  app.get("/api/knowledge-bases", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const query = request.query as { projectId?: string } | undefined;
    const readable = runAccess.readableProjectIds(user);
    const knowledgeBases = store
      .listKnowledgeBases({ projectId: query?.projectId })
      .filter((kb) => readable === null || !kb.projectId || readable.includes(kb.projectId));
    return { knowledgeBases };
  });

  app.get<{ Params: { id: string } }>("/api/knowledge-bases/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const access = knowledgeBaseAccess(user, request.params.id, "workflow:read");
    if (!access.ok) return denyRunAccess(reply, access);
    const kb = access.kb;
    const sources = store.listKnowledgeBaseSources(request.params.id);
    return { knowledgeBase: kb, sources };
  });

  app.post<{ Body: unknown }>("/api/knowledge-bases", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const body = request.body as Partial<{
      name: string;
      description: string | null;
      projectId: string | null;
      embedderId: string;
      embedderConfig: Record<string, unknown>;
    }> | undefined;
    if (!body || typeof body.name !== "string" || !body.name.trim()) {
      reply.code(400);
      return { error: "name is required" };
    }
    if (!body.embedderId || typeof body.embedderId !== "string") {
      reply.code(400);
      return { error: "embedderId is required (e.g. token-embedder, openai-embedder, azure-openai-embedder)" };
    }
    const id = `kb_${crypto.randomUUID()}`;
    store.createKnowledgeBase({
      id,
      name: body.name.trim(),
      description: body.description ?? null,
      projectId: body.projectId ?? null,
      embedderId: body.embedderId,
      embedderConfig: body.embedderConfig ?? {},
      createdBy: user.email
    });
    auditService.record({
      category: "system",
      eventType: "knowledge_base.created",
      action: "create",
      outcome: "success",
      actor: { email: user.email, type: "user" },
      resourceType: "knowledge_base",
      resourceId: id,
      projectId: body.projectId ?? null,
      metadata: { embedderId: body.embedderId }
    });
    return { knowledgeBase: store.getKnowledgeBase(id) };
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/api/knowledge-bases/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const existing = store.getKnowledgeBase(request.params.id);
    if (!existing) {
      reply.code(404);
      return { error: "Knowledge base not found" };
    }
    const patch = request.body as Partial<{
      name: string;
      description: string | null;
      embedderConfig: Record<string, unknown>;
    }> | undefined;
    if (!patch || typeof patch !== "object") {
      reply.code(400);
      return { error: "Empty update payload" };
    }
    store.updateKnowledgeBase(request.params.id, patch);
    auditService.record({
      category: "system",
      eventType: "knowledge_base.updated",
      action: "update",
      outcome: "success",
      actor: { email: user.email, type: "user" },
      resourceType: "knowledge_base",
      resourceId: request.params.id,
      metadata: { ...patch }
    });
    return { knowledgeBase: store.getKnowledgeBase(request.params.id) };
  });

  app.delete<{ Params: { id: string } }>("/api/knowledge-bases/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const existing = store.getKnowledgeBase(request.params.id);
    if (!existing) {
      reply.code(404);
      return { error: "Knowledge base not found" };
    }
    store.deleteKnowledgeBase(request.params.id);
    auditService.record({
      category: "system",
      eventType: "knowledge_base.deleted",
      action: "delete",
      outcome: "success",
      actor: { email: user.email, type: "user" },
      resourceType: "knowledge_base",
      resourceId: request.params.id
    });
    return { ok: true };
  });

  /**
   * Ingest pre-chunked text into a KB. Either:
   *   - body.chunks: pre-embedded chunks (vector + content). For programmatic
   *     ingestion when the caller already has embeddings.
   *   - body.documents: plain text documents. The server runs the KB's
   *     configured embedder on each chunk's content. Phase 9.2 layers
   *     chunking on top.
   */
  app.post<{ Params: { id: string }; Body: unknown }>("/api/knowledge-bases/:id/ingest", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const access = knowledgeBaseAccess(user, request.params.id, "workflow:write");
    if (!access.ok) return denyRunAccess(reply, access);
    const kb = access.kb;
    const body = request.body as Partial<{
      sourceId: string;
      documents: Array<{ content: string; metadata?: Record<string, unknown> }>;
      chunks: Array<{
        sourceId?: string | null;
        chunkIndex: number;
        content: string;
        metadata?: Record<string, unknown>;
        vector: number[];
      }>;
    }> | undefined;
    if (!body) {
      reply.code(400);
      return { error: "Empty payload" };
    }

    // Path 1: pre-embedded chunks
    if (Array.isArray(body.chunks) && body.chunks.length > 0) {
      try {
        const result = store.addKnowledgeBaseChunks({
          knowledgeBaseId: request.params.id,
          chunks: body.chunks
        });
        return { inserted: result.inserted, dimensions: result.dimensions };
      } catch (err) {
        reply.code(400);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }

    // Path 2: server-side embedding of plain documents
    if (Array.isArray(body.documents) && body.documents.length > 0) {
      const embedder = await buildEmbedderFromKbConfig(kb, secretService);
      if (!embedder) {
        reply.code(400);
        return { error: `Cannot instantiate embedder ${kb.embedderId} — check embedderConfig` };
      }
      const sourceId = body.sourceId ?? `src_${crypto.randomUUID().slice(0, 8)}`;
      const chunks = await Promise.all(
        body.documents.map(async (doc, idx) => ({
          sourceId,
          chunkIndex: idx,
          content: doc.content,
          metadata: doc.metadata ?? null,
          vector: await embedder.embed(doc.content)
        }))
      );
      try {
        const result = store.addKnowledgeBaseChunks({
          knowledgeBaseId: request.params.id,
          chunks
        });
        return { inserted: result.inserted, dimensions: result.dimensions, sourceId };
      } catch (err) {
        reply.code(400);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }

    reply.code(400);
    return { error: "Provide either body.chunks or body.documents" };
  });

  /**
   * Phase 9.2 — full upload pipeline (load -> chunk -> embed -> ingest).
   * Body shape:
   *   {
   *     filename: "support-faq.md",       // optional; drives kind inference
   *     kind: "markdown",                 // optional explicit override
   *     content: "...",                   // raw text
   *     sourceId: "support-faq-v1",       // groups chunks; defaults to filename
   *     chunking: { strategy: "recursive", chunkSize: 800, chunkOverlap: 80 }
   *     csv: { textColumn: "body", metadataColumns: ["topic"] }   // optional
   *   }
   * Returns:
   *   { sourceId, documentsLoaded, chunksInserted, dimensions }
   */
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/knowledge-bases/:id/upload",
    async (request, reply) => {
      const user = await requireRole(request, reply, ["builder"]);
      if (!user) return;
      const access = knowledgeBaseAccess(user, request.params.id, "workflow:write");
      if (!access.ok) return denyRunAccess(reply, access);
      const kb = access.kb;
      const body = request.body as Partial<{
        filename: string;
        kind: DocumentKind;
        content: string;
        sourceId: string;
        chunking: ChunkOptions;
        csv: { textColumn?: string; metadataColumns?: string[] };
        metadata: Record<string, unknown>;
      }> | undefined;
      if (!body || typeof body.content !== "string" || !body.content.length) {
        reply.code(400);
        return { error: "content (string) is required" };
      }
      const kind: DocumentKind = body.kind ?? (body.filename ? inferDocumentKind(body.filename) : "text");
      const sourceId = body.sourceId ?? body.filename ?? `src_${crypto.randomUUID().slice(0, 8)}`;

      // 1. Load
      let loaded;
      try {
        loaded = loadDocuments(kind, body.content, {
          sourceId,
          metadata: body.metadata ?? {},
          csv: body.csv
        });
      } catch (err) {
        reply.code(400);
        return { error: `Loader failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (loaded.length === 0) {
        reply.code(400);
        return { error: "Loader produced zero documents — content may be empty after parsing" };
      }

      // 2. Chunk. Use chunker defaults if no chunking options provided.
      const chunked = chunkDocuments(
        loaded.map((d, idx) => ({
          id: `${sourceId}-${idx}`,
          text: d.text,
          metadata: d.metadata
        })),
        body.chunking ?? {}
      );

      if (chunked.length === 0) {
        reply.code(400);
        return { error: "Chunker produced zero chunks — try a smaller chunkSize or different strategy" };
      }

      // 3. Embed using the KB's configured embedder
      const embedder = await buildEmbedderFromKbConfig(kb, secretService);
      if (!embedder) {
        reply.code(400);
        return { error: `Cannot instantiate embedder ${kb.embedderId} — check embedderConfig` };
      }
      const chunksToInsert = await Promise.all(
        chunked.map(async (c, idx) => ({
          sourceId,
          chunkIndex: idx,
          content: c.text,
          metadata: c.metadata as Record<string, unknown>,
          vector: await embedder.embed(c.text)
        }))
      );

      // 4. Persist
      try {
        const result = store.addKnowledgeBaseChunks({
          knowledgeBaseId: request.params.id,
          chunks: chunksToInsert
        });
        auditService.record({
          category: "system",
          eventType: "knowledge_base.upload",
          action: "ingest",
          outcome: "success",
          actor: { email: user.email, type: "user" },
          resourceType: "knowledge_base",
          resourceId: request.params.id,
          metadata: {
            sourceId,
            kind,
            documentsLoaded: loaded.length,
            chunksInserted: result.inserted
          }
        });
        return {
          sourceId,
          documentsLoaded: loaded.length,
          chunksInserted: result.inserted,
          dimensions: result.dimensions
        };
      } catch (err) {
        reply.code(400);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  app.get<{ Params: { id: string } }>("/api/knowledge-bases/:id/chunks", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const access = knowledgeBaseAccess(user, request.params.id, "workflow:read");
    if (!access.ok) return denyRunAccess(reply, access);
    const kb = access.kb;
    const query = request.query as { limit?: string; sourceId?: string } | undefined;
    return {
      chunks: store.listKnowledgeBaseChunkPreviews({
        knowledgeBaseId: request.params.id,
        limit: query?.limit ? Number(query.limit) : 50,
        sourceId: query?.sourceId
      })
    };
  });

  app.delete<{ Params: { id: string; sourceId: string } }>(
    "/api/knowledge-bases/:id/sources/:sourceId",
    async (request, reply) => {
      const user = await requireRole(request, reply, ["admin"]);
      if (!user) return;
      const kb = store.getKnowledgeBase(request.params.id);
      if (!kb) {
        reply.code(404);
        return { error: "Knowledge base not found" };
      }
      const removed = store.deleteKnowledgeBaseChunksBySource({
        knowledgeBaseId: request.params.id,
        sourceId: request.params.sourceId
      });
      auditService.record({
        category: "system",
        eventType: "knowledge_base.source.deleted",
        action: "delete",
        outcome: "success",
        actor: { email: user.email, type: "user" },
        resourceType: "knowledge_base",
        resourceId: request.params.id,
        metadata: { sourceId: request.params.sourceId, chunksRemoved: removed }
      });
      return { removed };
    }
  );

  /**
   * Standalone similarity search — useful for testing a KB without wrapping
   * it in a workflow, and for the Studio "search" preview.
   */
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/knowledge-bases/:id/search",
    async (request, reply) => {
      const user = await requireRole(request, reply, ["builder"]);
      if (!user) return;
      const access = knowledgeBaseAccess(user, request.params.id, "workflow:read");
      if (!access.ok) return denyRunAccess(reply, access);
      const kb = access.kb;
      const body = request.body as Partial<{ query: string; topK: number }> | undefined;
      if (!body?.query || typeof body.query !== "string") {
        reply.code(400);
        return { error: "query is required" };
      }
      const embedder = await buildEmbedderFromKbConfig(kb, secretService);
      if (!embedder) {
        reply.code(400);
        return { error: `Cannot instantiate embedder ${kb.embedderId} — check embedderConfig` };
      }
      const adapter = new KnowledgeBaseVectorStoreAdapter(
        {
          addKnowledgeBaseChunks: (i) => store.addKnowledgeBaseChunks(i),
          listKnowledgeBaseChunks: (kbId) => store.listKnowledgeBaseChunks(kbId),
          bm25SearchKnowledgeBase: (i) => store.bm25SearchKnowledgeBase(i),
          getKnowledgeBase: (kbId) => {
            const k = store.getKnowledgeBase(kbId);
            return k ? { id: k.id, embedderId: k.embedderId, dimensions: k.dimensions } : null;
          }
        },
        request.params.id
      );
      const topK = body.topK && body.topK > 0 ? Math.floor(body.topK) : 5;
      const results = await adapter.similaritySearch(body.query, topK, embedder);
      return { query: body.query, results };
    }
  );

  app.get<{ Params: { id: string } }>("/api/audit-export/destinations/:id/runs", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const existing = store.getAuditExportDestination(request.params.id);
    if (!existing) {
      reply.code(404);
      return { error: "Destination not found" };
    }
    const query = request.query as { limit?: string } | undefined;
    return {
      runs: store.listAuditExportRuns(request.params.id, query?.limit ? Number(query.limit) : 25)
    };
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
    if (communityLoader) {
      try {
        await communityLoader.loadAll();
      } catch (err) {
        app.log.error({ err: err instanceof Error ? err.message : String(err) }, "Initial community-package load failed");
      }
    }
  });
  app.addHook("onClose", async () => {
    await leaderElection.stop();
  });

  // ---------------------------------------------------------------------------
  // Phase 6 — Community node SDK admin routes (admin-only).
  //
  // 503 when COMMUNITY_NODES_ENABLED is false. Install/uninstall shells out
  // to npm with --ignore-scripts; the loader validates each package's
  // manifest before importing it. See /docs/extensions/community-nodes for
  // the threat model.
  // ---------------------------------------------------------------------------
  const requireCommunityLoader = (reply: FastifyReply): CommunityPackageLoader | null => {
    if (!communityLoader) {
      reply.code(503);
      reply.send({ error: "Community node SDK is disabled. Set COMMUNITY_NODES_ENABLED=true to enable." });
      return null;
    }
    return communityLoader;
  };

  app.get("/api/community-nodes", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const loader = requireCommunityLoader(reply);
    if (!loader) return;
    return {
      enabled: true,
      pluginsDir: path.resolve(config.COMMUNITY_NODES_DIR),
      allowlist: config.COMMUNITY_NODES_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean),
      packages: loader.list()
    };
  });

  app.post<{ Body: { packageSpec?: string } }>("/api/community-nodes/install", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const loader = requireCommunityLoader(reply);
    if (!loader) return;
    const spec = String(request.body?.packageSpec ?? "").trim();
    if (!spec) {
      reply.code(400);
      return { error: "packageSpec is required (e.g. 'l2m-nodes-cohere' or 'l2m-nodes-cohere@1.2.3')" };
    }
    try {
      const result = await loader.install(spec);
      return { ok: true, package: result };
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.post("/api/community-nodes/reload", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const loader = requireCommunityLoader(reply);
    if (!loader) return;
    const packages = await loader.loadAll();
    return { ok: true, packages };
  });

  app.delete<{ Params: { packageName: string } }>("/api/community-nodes/:packageName", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const loader = requireCommunityLoader(reply);
    if (!loader) return;
    try {
      await loader.uninstall(request.params.packageName);
      return { ok: true };
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Phase 7.3 / 15.2 — evals, golden sets and replay jobs (routes in eval-routes.ts).
  registerEvalRoutes({
    app,
    store,
    evals: evalService,
    requireRole: (request, reply, roles) => requireRole(request, reply, roles),
    runAccess,
    denyRunAccess,
    canUseSecret: canUseJudgeSecret,
    audit: (request, user, event) => audit(request, user, event),
    sseHeartbeatMs: config.SSE_HEARTBEAT_INTERVAL_MS
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

  app.get("/api/webhook-endpoints", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) {
      return;
    }

    const endpoints: Array<{
      workflowId: string;
      workflowName: string;
      nodeId: string;
      path: string;
      method: string;
      testUrl: string;
      prodUrl: string;
    }> = [];

    // A webhook path is a capability (for unauthenticated webhooks it is the
    // only secret), so only workflows the user can read are listed.
    const readable = runAccess.readableWorkflowIds(user);
    const readableIds = readable && new Set(readable);
    const workflows = store.listWorkflows();
    for (const summary of workflows) {
      if (readableIds && !readableIds.has(summary.id)) continue;
      const workflow = store.getWorkflow(summary.id);
      if (!workflow) continue;
      for (const endpoint of listWebhookEndpoints(workflow)) {
        endpoints.push({
          workflowId: workflow.id,
          workflowName: workflow.name,
          nodeId: endpoint.nodeId,
          path: endpoint.path,
          method: endpoint.method,
          testUrl: `/webhook-test/${endpoint.path}`,
          prodUrl: `/webhook/${endpoint.path}`
        });
      }
    }

    return { endpoints };
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
    const access = runAccess.workflow(user, request.params.id, "workflow:read");
    if (!access.ok) return denyRunAccess(reply, access);
    const workflow = access.workflow;
    return { versions: workflowVersionService.list(request.params.id) };
  });

  app.get<{ Params: { id: string; version: string } }>(
    "/api/workflows/:id/versions/:version",
    async (request, reply) => {
      const user = await requireRole(request, reply, ["viewer"]);
      if (!user) return;
      const access = runAccess.workflow(user, request.params.id, "workflow:read");
      if (!access.ok) return denyRunAccess(reply, access);
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
      const access = runAccess.workflow(user, request.params.id, "workflow:write");
      if (!access.ok) return denyRunAccess(reply, access);
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
      const saveDenial = workflowSaveDenial(user, restoredWorkflow);
      if (saveDenial) return denyRunAccess(reply, saveDenial);
      const saved = store.upsertWorkflow(restoredWorkflow, { createdBy: user.id });
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
    const access = runAccess.workflow(user, request.params.id, "workflow:read");
    if (!access.ok) return denyRunAccess(reply, access);
    return { shares: rbacService.listWorkflowShares(access.workflow.id) };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/workflows/:id/shares", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    // Unreadable reads as missing; sharing needs write on the owning project.
    const access = runAccess.workflow(user, request.params.id, "workflow:read");
    if (!access.ok) return denyRunAccess(reply, access);
    const workflow = access.workflow;
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
      const access = runAccess.workflow(user, request.params.id, "workflow:read");
      if (!access.ok) return denyRunAccess(reply, access);
      const workflow = access.workflow;
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

  /** Secrets L2M manages for itself answer exactly like a secret that does not exist. */
  const shareableSecret = (id: string) => {
    const row = store.getSecret(id);
    return row && !isInternalSecretProvider(row.provider) ? row : null;
  };
  // Secrets follow their project. Seeing one needs `secret:read` in its
  // project or in a project it is shared to (else it reads as missing);
  // sharing, unsharing or deleting it needs `secret:write` in its project.
  const canSeeSecret = (user: SafeUser, secret: { id: string; projectId?: string | null }) =>
    rbacService.can(user, secret.projectId ?? DEFAULT_PROJECT_ID, "secret:read") ||
    rbacService.listSecretShares(secret.id).some((share) => rbacService.can(user, share.projectId, "secret:read"));
  const secretManageDenial = (
    user: SafeUser,
    secret: { id: string; projectId?: string | null },
    permission: "secret:read" | "secret:write",
    what = "Secret"
  ): { status: 403 | 404; error: string } | null => {
    if (!canSeeSecret(user, secret)) return { status: 404, error: `${what} not found` };
    if (permission === "secret:write" && !rbacService.can(user, secret.projectId ?? DEFAULT_PROJECT_ID, "secret:write")) {
      return { status: 403, error: "Permission 'secret:write' required in the secret's project" };
    }
    return null;
  };

  app.get<{ Params: { id: string } }>("/api/secrets/:id/shares", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const secret = shareableSecret(request.params.id);
    if (!secret) {
      reply.code(404);
      return { error: "Secret not found" };
    }
    const denial = secretManageDenial(user, secret, "secret:read");
    if (denial) return denyRunAccess(reply, denial);
    return { shares: rbacService.listSecretShares(request.params.id) };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/secrets/:id/shares", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const secret = shareableSecret(request.params.id);
    if (!secret) {
      reply.code(404);
      return { error: "Secret not found" };
    }
    const denial = secretManageDenial(user, secret, "secret:write");
    if (denial) return denyRunAccess(reply, denial);
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
      const secret = shareableSecret(request.params.id);
      if (!secret) {
        reply.code(404);
        return { error: "Share not found" };
      }
      const denial = secretManageDenial(user, secret, "secret:write", "Share");
      if (denial) return denyRunAccess(reply, denial);
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
      const workflows = store.listWorkflows({
        projectId: typeof query.projectId === "string" && query.projectId.trim() ? query.projectId : undefined,
        folderId: folderFilter,
        tag: typeof query.tag === "string" ? query.tag : undefined,
        search: typeof query.search === "string" ? query.search : undefined
      });
      const readable = runAccess.readableWorkflowIds(user);
      if (readable === null) return workflows;
      const ids = new Set(readable);
      return workflows.filter((workflow) => ids.has(workflow.id));
    }
  );

  app.get<{ Params: { id: string } }>("/api/workflows/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) {
      return;
    }

    const access = runAccess.workflow(user, request.params.id, "workflow:read");
    if (!access.ok) return denyRunAccess(reply, access);

    return access.workflow;
  });

  app.get<{ Params: { id: string } }>("/api/workflows/:id/variables", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) {
      return;
    }

    const access = runAccess.workflow(user, request.params.id, "workflow:read");
    if (!access.ok) return denyRunAccess(reply, access);
    const workflow = access.workflow;

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

    const access = runAccess.workflow(user, request.params.id, "workflow:write");
    if (!access.ok) return denyRunAccess(reply, access);
    const workflow = access.workflow;

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

    const saveDenial = workflowSaveDenial(user, parsed.data);
    if (saveDenial) return denyRunAccess(reply, saveDenial);

    const savedWorkflow = store.upsertWorkflow(parsed.data, { createdBy: user.id });
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

    const saveDenial = workflowSaveDenial(user, parsed.data);
    if (saveDenial) return denyRunAccess(reply, saveDenial);

    const savedWorkflow = store.upsertWorkflow(parsed.data, { createdBy: user.id });
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

    const access = runAccess.workflow(user, request.params.id, "workflow:delete");
    if (!access.ok) return denyRunAccess(reply, access);

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

    const sourceWorkflowAccess = runAccess.workflow(user, request.params.id, "workflow:write");
    if (!sourceWorkflowAccess.ok) return denyRunAccess(reply, sourceWorkflowAccess);
    const sourceWorkflow = sourceWorkflowAccess.workflow;

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

    const savedWorkflow = store.upsertWorkflow(duplicatedWorkflow, { createdBy: user.id });
    schedulerService?.reloadWorkflow(savedWorkflow.id);
    triggerService?.reloadWorkflow(savedWorkflow.id);
    return savedWorkflow;
  });

  // ── Phase 7.3: Workflow activate / deactivate ────────────────────────

  app.post<{ Params: { id: string } }>("/api/workflows/:id/activate", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const access = runAccess.workflow(user, request.params.id, "workflow:write");
    if (!access.ok) return denyRunAccess(reply, access);
    const workflow = access.workflow;
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
    const access = runAccess.workflow(user, request.params.id, "workflow:write");
    if (!access.ok) return denyRunAccess(reply, access);
    const workflow = access.workflow;
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

      const saveDenial = workflowSaveDenial(user, workflow);
      if (saveDenial) return denyRunAccess(reply, saveDenial);

      const savedWorkflow = store.upsertWorkflow(workflow, { createdBy: user.id });
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

  // External workflow import: convert an export from another builder into an
  // L2M workflow, optionally persisting it. Credential values never reach this
  // route's response; the report only lists secrets to resolve by name.
  app.post<{ Body: unknown }>("/api/workflows/import/external", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) {
      return;
    }

    const parsed = externalWorkflowImportSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid external import payload", details: parsed.error.issues };
    }

    let source: unknown = parsed.data.source;
    if (source === undefined && typeof parsed.data.sourceText === "string") {
      try {
        source = JSON.parse(parsed.data.sourceText);
      } catch (error) {
        reply.code(400);
        return {
          error: `sourceText is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
        };
      }
    }
    if (source === undefined) {
      reply.code(400);
      return { error: "Provide the export as 'source' (JSON object) or 'sourceText' (JSON string)." };
    }

    const folder = parsed.data.folderId ? store.getFolder(parsed.data.folderId) : null;
    if (parsed.data.folderId && !folder) {
      reply.code(400);
      return { error: "Target folder does not exist" };
    }
    const projectId = parsed.data.projectId ?? folder?.projectId ?? "default";
    if (!store.getProject(projectId)) {
      reply.code(400);
      return { error: "Target project does not exist" };
    }
    if (folder && folder.projectId !== projectId) {
      reply.code(400);
      return { error: `Folder '${folder.id}' belongs to project '${folder.projectId}', not '${projectId}'` };
    }
    if (!rbacService.can(user, projectId, "workflow:write")) {
      deny(reply, 403, `Permission 'workflow:write' required in project '${projectId}'`);
      return;
    }

    let conversion: ReturnType<typeof convertExternalWorkflow>;
    try {
      conversion = convertExternalWorkflow(source);
    } catch (error) {
      reply.code(400);
      if (error instanceof ExternalWorkflowImportError) {
        return { error: error.message };
      }
      return { error: error instanceof Error ? error.message : "Failed to convert the external workflow export" };
    }

    const name = parsed.data.name?.trim();
    const workflow: Workflow = {
      ...conversion.workflow,
      id: makeUniqueWorkflowId(store, conversion.workflow.id),
      name: name || conversion.workflow.name,
      projectId,
      folderId: folder?.id
    };

    const validation = validateWorkflowGraph(workflow);
    if (!validation.valid) {
      reply.code(400);
      return {
        error: `Converted workflow failed validation: ${validation.issues.map((issue) => issue.message).join("; ")}`,
        validation,
        report: conversion.report
      };
    }

    if (parsed.data.dryRun === true) {
      return { workflow, report: conversion.report, dryRun: true };
    }

    const savedWorkflow = store.upsertWorkflow(workflow, { createdBy: user.id });
    workflowVersionService.snapshot({ workflow: savedWorkflow, createdBy: user.id, changeNote: "imported from another builder" });
    schedulerService?.reloadWorkflow(savedWorkflow.id);
    triggerService?.reloadWorkflow(savedWorkflow.id);
    audit(request, user, {
      category: "workflow",
      eventType: "workflow.import_external",
      action: "create",
      resourceType: "workflow",
      resourceId: savedWorkflow.id,
      projectId: savedWorkflow.projectId,
      metadata: {
        name: savedWorkflow.name,
        sourceName: conversion.report.sourceName,
        summary: conversion.report.summary,
        unresolvedExpressions: conversion.report.unresolvedExpressions.length,
        secretsToResolve: conversion.report.secretsToResolve.map((secret) => secret.secretId)
      }
    });
    return { workflow: savedWorkflow, report: conversion.report };
  });

  app.get<{ Params: { id: string } }>("/api/workflows/:id/export", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) {
      return;
    }

    const access = runAccess.workflow(user, request.params.id, "workflow:read");
    if (!access.ok) return denyRunAccess(reply, access);
    const workflow = access.workflow;

    return {
      json: exportWorkflowToJson(workflow)
    };
  });

  app.post<{ Params: { id: string } }>("/api/workflows/:id/validate", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) {
      return;
    }

    const access = runAccess.workflow(user, request.params.id, "workflow:read");
    if (!access.ok) return denyRunAccess(reply, access);
    const workflow = access.workflow;

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

  // Renaming or deleting a project needs `project:manage` in it (admins
  // pass). In role isolation a builder without a membership in the project
  // keeps the management their global role always gave them. Unreadable
  // projects answer 404.
  const projectManageDenial = (user: SafeUser, projectId: string): RunAccessDenial | null => {
    if (user.role === "admin") return null;
    const access = runAccess.project(user, projectId, "workflow:read");
    if (!access.ok) return access;
    if (rbacService.can(user, projectId, "project:manage")) return null;
    if (config.PROJECT_ISOLATION === "role" && user.role === "builder" && !rbacService.getMembership(user.id, projectId)) return null;
    return { ok: false, status: 403, error: "Permission 'project:manage' required in this project" };
  };

  app.get("/api/projects", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    const readable = runAccess.readableProjectIds(user);
    const ids = readable && new Set(readable);
    return { projects: store.listProjects().filter((project) => !ids || ids.has(project.id)) };
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
    // Reusing an existing id is an update of that project.
    if (store.getProject(id)) {
      const denial = projectManageDenial(user, id);
      if (denial) return denyRunAccess(reply, denial);
    }
    const project = store.upsertProject({
      id,
      name: parsed.data.name.trim(),
      description: parsed.data.description?.trim() || undefined,
      createdBy: user.email
    });
    // Under strict isolation only members see a project, so its creator joins it.
    if (config.PROJECT_ISOLATION === "strict" && user.role !== "admin" && !rbacService.getMembership(user.id, id)) {
      rbacService.addMember({ userId: user.id, projectId: id, role: "project_admin" });
    }
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
    const denial = projectManageDenial(user, existing.id);
    if (denial) return denyRunAccess(reply, denial);
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
    const denial = projectManageDenial(user, request.params.id);
    if (denial) return denyRunAccess(reply, denial);
    try {
      const ok = store.deleteProject(request.params.id);
      if (!ok) {
        reply.code(404);
        return { error: "Project not found" };
      }
      audit(request, user, {
        category: "project",
        eventType: "project.delete",
        action: "delete",
        resourceType: "project",
        resourceId: request.params.id,
        projectId: request.params.id
      });
      return { ok: true };
    } catch (error) {
      if (error instanceof ProjectNotEmptyError) {
        reply.code(409);
        return { error: error.message, ...error.counts };
      }
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
    const readable = runAccess.readableProjectIds(user);
    const ids = readable && new Set(readable);
    return { folders: store.listFolders(projectId).filter((folder) => !ids || ids.has(folder.projectId)) };
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
    const projectAccess = runAccess.project(user, parsed.data.projectId, "workflow:write");
    if (!projectAccess.ok) return denyRunAccess(reply, projectAccess);
    const parentFolder = parsed.data.parentId ? store.getFolder(parsed.data.parentId) : null;
    if (parsed.data.parentId && (!parentFolder || parentFolder.projectId !== parsed.data.projectId)) {
      reply.code(400);
      return { error: "Parent folder does not exist in this project" };
    }
    const id = parsed.data.id?.trim() || `fld-${crypto.randomUUID()}`;
    const replaced = store.getFolder(id);
    if (replaced) {
      const replacedAccess = runAccess.project(user, replaced.projectId, "workflow:write");
      if (!replacedAccess.ok) return denyRunAccess(reply, replacedAccess);
    }
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
    const existingAccess = runAccess.project(user, existing.projectId, "workflow:write", "Folder");
    if (!existingAccess.ok) return denyRunAccess(reply, existingAccess);
    const parsed = folderPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid folder payload", details: parsed.error.issues };
    }
    const targetAccess = runAccess.project(user, parsed.data.projectId, "workflow:write");
    if (!targetAccess.ok) return denyRunAccess(reply, targetAccess);
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
    const folder = store.getFolder(request.params.id);
    if (folder) {
      const access = runAccess.project(user, folder.projectId, "workflow:write", "Folder");
      if (!access.ok) return denyRunAccess(reply, access);
    }
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
      const access = runAccess.workflow(user, request.params.id, "workflow:write");
      if (!access.ok) return denyRunAccess(reply, access);
      const workflow = access.workflow;
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
      const nextProjectId = parsed.data.projectId ?? workflow.projectId;
      const projectChanged = (nextProjectId ?? DEFAULT_PROJECT_ID) !== (workflow.projectId ?? DEFAULT_PROJECT_ID);
      const nextWorkflow: Workflow = {
        ...workflow,
        projectId: nextProjectId,
        // A move to another project leaves the old project's folder behind.
        folderId:
          parsed.data.folderId === null
            ? undefined
            : parsed.data.folderId ?? (projectChanged ? undefined : workflow.folderId),
        tags: parsed.data.tags ?? workflow.tags
      };
      const moveDenial = workflowSaveDenial(user, nextWorkflow);
      if (moveDenial) return denyRunAccess(reply, moveDenial);
      const saved = store.upsertWorkflow(nextWorkflow);
      schedulerService?.reloadWorkflow(saved.id);
      triggerService?.reloadWorkflow(saved.id);
      return saved;
    }
  );

  app.get<{ Params: { id: string } }>("/api/workflows/:id/pins", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    const access = runAccess.workflow(user, request.params.id, "workflow:read");
    if (!access.ok) return denyRunAccess(reply, access);
    const workflow = access.workflow;
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
      const access = runAccess.workflow(user, request.params.id, "workflow:write");
      if (!access.ok) return denyRunAccess(reply, access);
      const workflow = access.workflow;
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
      const access = runAccess.workflow(user, request.params.id, "workflow:write");
      if (!access.ok) return denyRunAccess(reply, access);
      const workflow = access.workflow;
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

    const access = runAccess.workflow(user, request.params.id, "workflow:execute");
    if (!access.ok) return denyRunAccess(reply, access);
    const workflow = access.workflow;

    // Phase 8.3 — pre-execution budget check. Block-action budgets reject
    // here (HTTP 402); warn-action budgets only fire post-execution.
    const budgetCheck = budgetService.checkExecution({
      workflowId: workflow.id,
      projectId: workflow.projectId ?? null,
      userEmail: user.email,
      userId: user.id
    });
    if (!budgetCheck.allowed && budgetCheck.blocked) {
      reply.code(402);
      reply.header("retry-after", retryAfterSeconds(budgetCheck.blocked.budget.period));
      return {
        error: "budget_exceeded",
        message: `Budget "${budgetCheck.blocked.budget.name}" exceeded for the current ${budgetCheck.blocked.budget.period}.`,
        budgetId: budgetCheck.blocked.budget.id,
        currentUsage: budgetCheck.blocked.current,
        limit: budgetCheck.blocked.limit,
        periodStart: budgetCheck.blocked.periodStart
      };
    }
    if (budgetCheck.approachingLimit.length > 0) {
      reply.header(
        "x-budget-warning",
        budgetCheck.approachingLimit
          .map((a) => `${a.budget.name}=${Math.round(a.pct * 100)}%`)
          .join(",")
      );
    }

    const parsed = workflowExecuteRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid execution payload",
        details: parsed.error.issues
      };
    }
    const prepared = prepareWorkflowExecutionPayload(parsed.data, reply, user);
    if (!prepared) {
      return { error: "Source execution not found" };
    }
    const executionPayload = prepared.payload;

    const executionId = crypto.randomUUID();
    auditRunAction(request, user, "execution.started", { executionId, workflowId: workflow.id, projectId: workflow.projectId }, { triggerType: "manual" });
    const progressHooks = createProgressTrackingHooks({
      executionId,
      workflow,
      triggerType: "manual",
      triggeredBy: user.email,
      requestInput: prepared.requestInput,
      customData: executionPayload.customData
    });
    // Phase 10.8 — "Record MCP calls": every MCP call of the run goes into a cassette.
    const mcpPlan = parsed.data.record ? mcpCassetteService.planRecording(mcpRegistry) : undefined;
    const executed = await runWorkflowExecution({
      mcpPlan,
      policyActor: user,
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
    const result = finishMcpCassettePlan(mcpPlan, executed, { executionId, workflow, source: "manual", createdBy: user.email });

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

    const access = runAccess.workflow(user, request.params.id, "workflow:execute");
    if (!access.ok) return denyRunAccess(reply, access);
    const workflow = access.workflow;

    const parsed = workflowExecuteRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid execution payload",
        details: parsed.error.issues
      };
    }
    const prepared = prepareWorkflowExecutionPayload(parsed.data, reply, user);
    if (!prepared) {
      return { error: "Source execution not found" };
    }
    const executionPayload = prepared.payload;

    const executionId = crypto.randomUUID();
    auditRunAction(request, user, "execution.started", { executionId, workflowId: workflow.id, projectId: workflow.projectId }, { triggerType: "manual_stream" });
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
    const stopHeartbeat = startSseHeartbeat(reply.raw, config.SSE_HEARTBEAT_INTERVAL_MS, () => streamClosed);

    sendSseEvent("execution_started", {
      executionId,
      workflowId: workflow.id,
      triggerType: "manual_stream",
      startedAt: new Date().toISOString()
    });

    // Phase 10.5 — questions a server asks during the run reach the chat as they happen.
    const unsubscribeElicitations = mcpElicitationService.subscribe(executionId, (event) => {
      sendSseEvent("mcp_elicitation", event);
    });
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
          },
          onMcpProgress: (event) => {
            sendSseEvent("node_progress", event);
          },
          onNodeActivity: (event) => {
            sendSseEvent("node_activity", event);
          }
        }
      });
      const mcpPlan = parsed.data.record ? mcpCassetteService.planRecording(mcpRegistry) : undefined;
      const executed = await runWorkflowExecution({
        mcpPlan,
        policyActor: user,
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
      const result = finishMcpCassettePlan(mcpPlan, executed, { executionId, workflow, source: "manual", createdBy: user.email });

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
      stopHeartbeat();
      unsubscribeElicitations();
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

    if (codeSandboxPlan.kind === "disabled") {
      reply.code(403);
      return { error: codeSandboxPlan.reason };
    }
    try {
      const result = await runWithSandboxOwner(`user:${user.id}`, () =>
        executeCodeNodeSandbox({
          code: parsed.data.code,
          timeoutMs: parsed.data.timeout,
          input: parsed.data.input ?? {}
        }, codeSandboxPlan)
      );
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
        resolveSecret: resolveSecretForUser(user)
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
      const resolveCtx = { resolveSecret: resolveSecretForUser(user) };

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
            // Anthropic's current models reject sampling parameters, so the probe
            // only sends a temperature there when the node sets one.
            temperature:
              typeof testProvider.temperature === "number" && Number.isFinite(testProvider.temperature)
                ? testProvider.temperature
                : testProvider.providerId === "anthropic"
                  ? undefined
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
        const apiKey = (await resolveSecretForUser(user)(secretRef)) || process.env.GEMINI_API_KEY;
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
        const apiKey = (await resolveSecretForUser(user)(secretRef)) || process.env.OPENAI_API_KEY;
        if (!apiKey) return { models: [] };
        const modelBaseUrl = (baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
        const modelEndpoint = modelBaseUrl.endsWith("/models") ? modelBaseUrl : `${modelBaseUrl}/models`;
        const res = await fetch(modelEndpoint, {
          headers: { "Authorization": `Bearer ${apiKey}` }
        });
        if (!res.ok) return { models: [] };
        const json = await res.json() as { data?: Array<{ id: string; owned_by?: string }> };
        const listedModels = json.data ?? [];
        const chatModels = (baseUrl ? listedModels : listedModels
          .filter(m => /^(gpt-|o[1-9]|chatgpt-)/.test(m.id) && !m.id.includes("instruct") && !m.id.includes("realtime") && !m.id.includes("audio") && !m.id.includes("transcribe")))
          .sort((a, b) => a.id.localeCompare(b.id));
        return { models: chatModels.map(m => ({ id: m.id, label: m.id })) };
      }

      if (providerId === "anthropic") {
        const apiKey = (await resolveSecretForUser(user)(secretRef)) || process.env.ANTHROPIC_API_KEY;
        if (!apiKey) return { models: [] };
        const modelBaseUrl = (baseUrl || "https://api.anthropic.com/v1").replace(/\/+$/, "");
        const modelEndpoint = modelBaseUrl.endsWith("/models") ? modelBaseUrl : `${modelBaseUrl}/models`;
        const res = await fetch(modelEndpoint, {
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
        const apiKey = await resolveSecretForUser(user)(secretRef);
        const headers: Record<string, string> = {};
        if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
        const modelBaseUrl = baseUrl.replace(/\/+$/, "");
        const modelEndpoint = modelBaseUrl.endsWith("/models") ? modelBaseUrl : `${modelBaseUrl}/models`;
        const res = await fetch(modelEndpoint, { headers });
        if (!res.ok) return { models: [] };
        const json = await res.json() as { data?: Array<{ id: string }> };
        return { models: (json.data ?? []).map(m => ({ id: m.id, label: m.id })) };
      }

      if (providerId === "azure_openai") {
        const endpoint = (baseUrl ?? process.env.AZURE_OPENAI_ENDPOINT ?? "").replace(/\/+$/, "");
        const apiKey = (await resolveSecretForUser(user)(secretRef)) || process.env.AZURE_OPENAI_API_KEY;
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
      // Previews count against the user's own sandbox circuit breaker, not a workflow's.
      const result = runWithSandboxOwner(`user:${user.id}`, () =>
        parsed.data.mode === "template" || parsed.data.expression.includes("{{")
          ? renderExpressionTemplate(parsed.data.expression, expressionContext)
          : evaluateExpression(parsed.data.expression, expressionContext)
      );
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

    const history = store.listExecutionHistory({
      page: Number.isFinite(page) ? page : 1,
      pageSize: Number.isFinite(pageSize) ? pageSize : 20,
      status: typeof query.status === "string" && query.status.trim() ? query.status.trim() : undefined,
      workflowId: typeof query.workflowId === "string" && query.workflowId.trim() ? query.workflowId.trim() : undefined,
      // Only runs of workflows the user can read, filtered before paging so totals match.
      workflowIds: runAccess.readableWorkflowIds(user) ?? undefined,
      triggerType:
        typeof query.triggerType === "string" && query.triggerType.trim() ? query.triggerType.trim() : undefined,
      startedFrom: normalizeIsoDateFilter(query.startedFrom),
      startedTo: normalizeIsoDateFilter(query.startedTo)
    });
    // Phase 10.8 — runs recorded with "Record MCP calls" carry a cassette badge.
    const badges = store.mcpCassetteBadgesForExecutions(history.items.map((item) => item.id));
    // Phase 15.1 — runs saved as golden runs carry a golden badge.
    const golden = store.replayGoldenBadgesForExecutions(history.items.map((item) => item.id));
    return {
      ...history,
      items: history.items.map((item) => {
        const badge = badges.get(item.id);
        const goldenBadge = golden.get(item.id);
        return { ...item, ...(badge ? { mcpCassette: badge } : {}), ...(goldenBadge ? { goldenRuns: goldenBadge } : {}) };
      })
    };
  });

  app.get<{ Params: { id: string } }>("/api/executions/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) {
      return;
    }

    const access = runAccess.run(user, store.getExecutionHistory(request.params.id), "workflow:read");
    if (!access.ok) return denyRunAccess(reply, access);

    return access.run;
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/executions/:id/retry", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) {
      return;
    }

    const sourceAccess = runAccess.run(user, store.getExecutionHistory(request.params.id), "workflow:execute");
    if (!sourceAccess.ok) return denyRunAccess(reply, sourceAccess);
    const sourceExecution = sourceAccess.run;

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
    }, reply, user);
    if (!prepared) {
      return { error: "Source execution not found" };
    }

    const executionPayload = prepared.payload;
    const executionId = crypto.randomUUID();
    auditRunAction(request, user, "execution.retried", { executionId, workflowId: workflow.id, projectId: workflow.projectId }, { sourceExecutionId: sourceExecution.id });
    const progressHooks = createProgressTrackingHooks({
      executionId,
      workflow,
      triggerType: "manual_retry",
      triggeredBy: user.email,
      requestInput: prepared.requestInput,
      customData: executionPayload.customData
    });

    const result = await runWorkflowExecution({
      policyActor: user,
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

  // Phase 10.8 — run a past execution again with its MCP calls answered from its cassette.
  const executionReplaySchema = z.object({
    mode: z.enum(["strict", "lenient"]).optional(),
    cassetteId: z.string().trim().min(1).optional()
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/executions/:id/replay", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) {
      return;
    }
    const parsed = executionReplaySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid replay payload", details: parsed.error.issues };
    }
    const sourceAccess = runAccess.run(user, store.getExecutionHistory(request.params.id), "workflow:execute");
    if (!sourceAccess.ok) return denyRunAccess(reply, sourceAccess);
    const source = sourceAccess.run;
    const cassette = parsed.data.cassetteId ? store.getMcpCassette(parsed.data.cassetteId) : store.getMcpCassetteForExecution(source.id);
    if (!cassette) {
      reply.code(404);
      return { error: "No cassette was recorded for this execution. Run it with Record MCP calls turned on first." };
    }
    // An unreadable cassette reads as missing; a readable one must belong to
    // this workflow (a cassette with no workflow never does).
    if (parsed.data.cassetteId) {
      const cassetteAccess = runAccess.run(user, { id: cassette.id, workflowId: cassette.workflowId ?? "" }, "workflow:read", "Cassette");
      if (!cassetteAccess.ok) return denyRunAccess(reply, cassetteAccess);
    }
    if (cassette.workflowId !== source.workflowId) {
      reply.code(409);
      return { error: "That cassette was recorded for a different workflow." };
    }
    const workflow = store.getWorkflow(source.workflowId);
    if (!workflow) {
      reply.code(404);
      return { error: "Workflow not found" };
    }
    const mode: McpReplayMode = parsed.data.mode ?? "strict";
    const mcpPlan = mcpCassetteService.planReplay(cassette, mode, mcpRegistry, resolveRegisteredMcpServer);
    const executionId = crypto.randomUUID();
    auditRunAction(request, user, "execution.replayed", { executionId, workflowId: workflow.id, projectId: workflow.projectId }, { sourceExecutionId: source.id, cassetteId: cassette.id, mode });
    const storedInput = asRecord(source.input);
    const customData = {
      ...asRecord(source.customData),
      mcpReplay: { sourceExecutionId: source.id, cassetteId: cassette.id, mode }
    };
    const executed = await runWorkflowExecution({
      ...replayRunInputFor(source.triggerType, storedInput),
      mcpPlan,
      policyActor: user,
      workflow,
      customData,
      executionId,
      triggerType: "mcp_replay",
      triggeredBy: user.email,
      hooks: createProgressTrackingHooks({
        executionId,
        workflow,
        triggerType: "mcp_replay",
        triggeredBy: user.email,
        requestInput: storedInput,
        customData
      })
    });
    const result = finishMcpCassettePlan(mcpPlan, executed, { executionId, workflow, source: "replay", createdBy: user.email });
    persistExecutionHistory({
      executionId,
      workflow,
      result,
      triggerType: "mcp_replay",
      triggeredBy: user.email,
      requestInput: storedInput,
      customData
    });
    return { ...result, executionId };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/executions/:id/cancel", async (request, reply) => {
    const user = await requireRole(request, reply, ["operator", "builder", "admin"]);
    if (!user) {
      return;
    }

    const access = runAccess.run(user, store.getExecutionHistory(request.params.id), "workflow:execute");
    if (!access.ok) return denyRunAccess(reply, access);
    const execution = access.run;

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
    // The run already hit its time limit and is ending; it is saved as a timeout error, not a cancel.
    if (active && isExecutionTimeoutAbort(active.controller.signal)) {
      reply.code(409);
      return { error: "Execution already timed out and is stopping" };
    }
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

    auditRunAction(
      request,
      user,
      "execution.cancel_requested",
      { executionId: execution.id, workflowId: execution.workflowId, projectId: store.getWorkflow(execution.workflowId)?.projectId },
      { abortedActiveRun: Boolean(active), previousStatus: execution.status }
    );
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
      items: runAccess.filterRuns(user, store.listPendingApprovals())
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
    const approvalAccess = runAccess.run(user, pending, "workflow:execute", "Pending approval");
    if (!approvalAccess.ok) return denyRunAccess(reply, approvalAccess);

    const state = pending.state as WorkflowExecutionState | null;
    if (!state || typeof state !== "object" || !state.workflow) {
      reply.code(400);
      return { error: "Stored execution state is invalid and cannot be resumed" };
    }

    const result = await runWorkflowExecution({
      policyActor: user,
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
    const approvalAccess = runAccess.run(user, pending, "workflow:execute", "Pending approval");
    if (!approvalAccess.ok) return denyRunAccess(reply, approvalAccess);

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
      policyActor: user,
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

    const workflow = await selectWebhookWorkflow(
      store,
      parsed.data.workflow_id,
      inferAgentWebhookPath(parsed.data),
      "POST",
      (candidate) => runAccess.workflow(user, candidate.id, "workflow:read").ok
    );
    if (!workflow) {
      reply.code(404);
      return { error: "No workflows available" };
    }
    const executeAccess = runAccess.workflow(user, workflow.id, "workflow:execute");
    if (!executeAccess.ok) return denyRunAccess(reply, executeAccess);

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
      policyActor: user,
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
      const access = runAccess.workflow(user, request.params.workflowId, "workflow:execute");
      if (!access.ok) return denyRunAccess(reply, access);
      const workflow = access.workflow;
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
        policyActor: user,
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
        // Session forms are for people who can see the workflow's project.
        const access = runAccess.workflow(user, found.workflow.id, "workflow:read", "Form");
        if (!access.ok) return denyRunAccess(reply, access);
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
        // Session forms are for people who can see the workflow's project.
        const access = runAccess.workflow(user, found.workflow.id, "workflow:read", "Form");
        if (!access.ok) return denyRunAccess(reply, access);
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
        // Session chats are for people who can see the workflow's project.
        const access = runAccess.workflow(user, workflow.id, "workflow:read");
        if (!access.ok) return denyRunAccess(reply, access);
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

  // Phase 10.4 — spec-compliant MCP endpoint (/mcp/:toolset), the gateway in
  // front of the registry, and the toolset / client admin API.
  registerMcpGatewayRoutes({
    app,
    runAccess,
    config,
    store,
    mcpRegistry,
    providerRegistry,
    resolveSecret: (secretRef) => secretService.resolveSecret(secretRef),
    redact: (value) => String(secretService.redact(value)),
    resolveRegisteredMcpServer,
    requireRole: (request, reply, roles) => requireRole(request, reply, roles),
    auditUser: (request, user, event) => audit(request, user, event),
    auditRaw: (event) => {
      auditService.record(event);
      logStreamingService.dispatchAudit(event);
    },
    runWorkflowTool: async (input) => {
      const triggerType = "mcp_gateway";
      const triggeredBy = `mcp-client:${input.client.name}`;
      const requestInput = { tool: input.toolName, arguments: input.args, clientId: input.client.id };
      const hooks = createProgressTrackingHooks({
        executionId: input.executionId,
        workflow: input.workflow,
        triggerType,
        triggeredBy,
        requestInput,
        passthroughHooks: {
          onNodeComplete: (event) => input.onNodeComplete({ nodeId: event.nodeId, status: event.status })
        }
      });
      const result = await runWorkflowExecution({
        workflow: input.workflow,
        directInput: {
          trigger_type: triggerType,
          trigger_node_id: input.nodeId,
          arguments: input.args,
          ...input.args
        },
        executionId: input.executionId,
        triggerType,
        triggeredBy,
        policySubject: input.subject,
        hooks
      });
      persistExecutionHistory({
        executionId: input.executionId,
        workflow: input.workflow,
        result,
        triggerType,
        triggeredBy,
        requestInput
      });
      return { status: result.status, output: result.output, error: result.error };
    },
    cancelExecution: (executionId, reason) => {
      activeExecutions.get(executionId)?.controller.abort(reason);
    }
  });

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

    const workflow = await selectWebhookWorkflow(
      store,
      parsed.data.workflow_id,
      inferAgentWebhookPath(parsed.data),
      "POST",
      (candidate) => runAccess.workflow(user, candidate.id, "workflow:read").ok
    );
    if (!workflow) {
      reply.code(404);
      return { error: "No workflows available" };
    }
    const executeAccess = runAccess.workflow(user, workflow.id, "workflow:execute");
    if (!executeAccess.ok) return denyRunAccess(reply, executeAccess);

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
    const stopHeartbeat = startSseHeartbeat(reply.raw, config.SSE_HEARTBEAT_INTERVAL_MS, () => streamClosed);

    sendSseEvent("execution_started", {
      executionId,
      workflowId: workflow.id,
      triggerType: "webhook_api_stream",
      startedAt: new Date().toISOString()
    });

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
          },
          onMcpProgress: (event) => {
            sendSseEvent("node_progress", event);
          },
          onNodeActivity: (event) => {
            sendSseEvent("node_activity", event);
          }
        }
      });
      const result = await runWorkflowExecution({
        policyActor: user,
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
      stopHeartbeat();
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
    if (isInternalSecretProvider(parsed.data.provider)) {
      // Providers L2M uses for its own secrets cannot be created through the API.
      reply.code(400);
      return { error: "Invalid secret payload", details: [{ path: ["provider"], message: "Unsupported provider" }] };
    }
    const targetProject = parsed.data.projectId ?? DEFAULT_PROJECT_ID;
    // Editors may create secrets for their project (workflow:write + secret:use);
    // changing, deleting and sharing stay on secret:write.
    const mayCreate =
      rbacService.can(user, targetProject, "secret:write") ||
      (rbacService.can(user, targetProject, "workflow:write") && rbacService.can(user, targetProject, "secret:use"));
    if (!mayCreate) {
      reply.code(403);
      return { error: "Permission 'secret:write' required in the target project" };
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
    const warnings = source === "local" ? scrubExemptionWarnings(parsed.data.value as string) : [];
    if (!parsed.data.projectId) {
      warnings.push(
        config.PROJECT_ISOLATION === "role"
          ? "Saved to the default project, which every project can use in role isolation. Pick a project to keep it to one team."
          : "Saved to the default project. Only default-project workflows can use it until it is shared to other projects."
      );
    }
    return {
      id: secretRef.secretId,
      name: parsed.data.name,
      provider: parsed.data.provider,
      projectId: parsed.data.projectId ?? "default",
      source,
      // Non-blocking: the secret is saved; the warning never carries the value.
      warnings
    };
  });

  app.delete<{ Params: { id: string } }>("/api/secrets/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const row = store.getSecret(request.params.id);
    if (!row || isInternalSecretProvider(row.provider)) {
      // Phase 10.5 — MCP OAuth secrets are managed from the MCP servers page only.
      reply.code(404);
      return { error: "Secret not found" };
    }
    const deleteDenial = secretManageDenial(user, row, "secret:write");
    if (deleteDenial) return denyRunAccess(reply, deleteDenial);
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

    return secretService.listSecrets({ projectId }).filter((secret) => canSeeSecret(user, secret));
  });

  // Discover/test requests get their own MCP context, closed when the request
  // is done, so a stdio server they spawn does not outlive the request in the
  // adapter's process-wide fallback cache.
  // With a user, secretRefs from the request body go through resolveSecretForUser.
  const withScopedMcpContext = async <T>(run: (mcpContext: MCPExecutionContext) => Promise<T>, user?: SafeUser): Promise<T> => {
    const mcpContext: MCPExecutionContext = {
      resolveSecret: user ? resolveSecretForUser(user) : (secretRef) => secretService.resolveSecret(secretRef),
      runtimeState: new Map<string, unknown>()
    };
    try {
      return await run(mcpContext);
    } finally {
      const closeErrors = await mcpRegistry.closeSessions(mcpContext);
      for (const closeError of closeErrors) {
        app.log.warn({ err: closeError }, "Failed to close MCP sessions after request");
      }
    }
  };

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

      const tools = await withScopedMcpContext(
        (mcpContext) => mcpRegistry.get(parsed.data.serverId).discoverTools(serverConfig, mcpContext),
        user
      );
      const projectId = parsed.data.projectId ?? "default";

      return {
        serverId: parsed.data.serverId,
        // Phase 10.2 — marked, never hidden, so builders see why an agent will not get a tool.
        policy: { role: user.role, projectId },
        tools: markMcpTools(tools, {
          rules: store.listMcpToolPolicies(),
          classifications: [],
          role: user.role,
          projectId,
          adapterId: parsed.data.serverId
        })
      };
    } catch (error) {
      reply.code(400);
      return {
        error: error instanceof Error ? error.message : "Failed to discover MCP tools"
      };
    }
  });

  app.post<{ Body: unknown }>("/api/mcp/test-tool", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) {
      return;
    }

    const parsed = mcpTestToolSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid MCP test-tool payload",
        details: parsed.error.issues
      };
    }

    const serverConfig: MCPServerConfig = {
      serverId: parsed.data.serverId,
      label: parsed.data.label,
      connection: parsed.data.connection,
      secretRef: parsed.data.secretRef
    };

    const startedAt = Date.now();
    try {
      const result = await withScopedMcpContext(
        (mcpContext) => invokeDirectMCPTool(serverConfig, parsed.data.toolName, parsed.data.args ?? {}, mcpRegistry, mcpContext),
        user
      );

      return {
        ok: result.ok,
        output: result.output ?? null,
        error: result.ok ? undefined : result.error,
        durationMs: Date.now() - startedAt
      };
    } catch (error) {
      reply.code(400);
      return {
        ok: false,
        output: null,
        error: error instanceof Error ? error.message : "Failed to invoke MCP tool",
        durationMs: Date.now() - startedAt
      };
    }
  });

  // Phase 10.1 — MCP server registry. Reads are open to builders (they pick
  // servers on nodes); changing the registry is admin-only because every
  // workflow that references a server follows the change.
  const mcpServerSummary = (server: McpServerRecord, user?: SafeUser | null) => ({
    ...server,
    latency: mcpProbeService.latency(server.id),
    // Phase 10.7 — breaker and limit state on this API instance (the last error only for admins).
    runtime: runtimeStateView(server.id, user)
  });

  app.get("/api/mcp/servers", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const query = request.query as { projectId?: string } | undefined;
    return {
      servers: store.listMcpServers({ projectId: query?.projectId }).map((server) => mcpServerSummary(server, user)),
      adapters: mcpRegistry.listDefinitions().map((definition) => ({ id: definition.id, label: definition.label })),
      defaultProbeIntervalMs: mcpProbeService.defaultIntervalMs,
      sandboxPolicy: sandboxPolicyView()
    };
  });

  app.get<{ Params: { id: string } }>("/api/mcp/servers/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const server = store.getMcpServer(request.params.id);
    if (!server) {
      reply.code(404);
      return { error: "MCP server not found" };
    }
    return {
      server: mcpServerSummary(server, user),
      sandboxPolicy: sandboxPolicyView(),
      probes: store.listMcpServerProbes(server.id, 50),
      // Snapshot list without the tool bodies; fetch one snapshot for those.
      snapshots: store.listMcpToolSnapshots(server.id, 20).map(({ tools: _tools, ...snapshot }) => snapshot),
      usages: listMcpServerUsages(store, server.id)
    };
  });

  app.get<{ Params: { id: string } }>("/api/mcp/servers/:id/tools", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const server = store.getMcpServer(request.params.id);
    if (!server) {
      reply.code(404);
      return { error: "MCP server not found" };
    }
    const snapshot = server.currentSnapshotId ? store.getMcpToolSnapshot(server.currentSnapshotId) : null;
    const query = request.query as { projectId?: unknown } | undefined;
    const projectId =
      typeof query?.projectId === "string" && query.projectId.trim() ? query.projectId.trim() : server.projectId ?? "default";
    return {
      serverId: server.id,
      snapshotId: snapshot?.id ?? null,
      probedAt: server.lastProbeAt,
      // Phase 10.2 — read-only classification and what the caller's role may use in this project.
      policy: { role: user.role, projectId },
      tools: markMcpTools(snapshot?.tools ?? [], {
        rules: store.listMcpToolPolicies(),
        classifications: store.listMcpToolClassifications(server.id),
        role: user.role,
        projectId,
        adapterId: server.adapterId,
        registryServerId: server.id,
        serverLabel: server.name
      })
    };
  });

  app.get<{ Params: { id: string; snapshotId: string } }>(
    "/api/mcp/servers/:id/snapshots/:snapshotId",
    async (request, reply) => {
      const user = await requireRole(request, reply, ["builder"]);
      if (!user) return;
      const snapshot = store.getMcpToolSnapshot(request.params.snapshotId);
      if (!snapshot || snapshot.serverId !== request.params.id) {
        reply.code(404);
        return { error: "Snapshot not found" };
      }
      return { snapshot };
    }
  );

  // Phase 10.1 — per-tool telemetry rolled up from mcp_tool_calls.
  const resolveTelemetryWindow = (request: FastifyRequest, reply: FastifyReply) => {
    const window = parseMcpTelemetryWindow((request.query as { window?: unknown } | undefined)?.window);
    if (!window) {
      reply.code(400);
      return null;
    }
    const since = new Date(Date.now() - MCP_TELEMETRY_WINDOWS[window]).toISOString();
    return { window, since };
  };
  const telemetryWindowError = { error: `window must be one of ${Object.keys(MCP_TELEMETRY_WINDOWS).join(", ")}` };

  app.get<{ Params: { id: string } }>("/api/mcp/servers/:id/telemetry", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const range = resolveTelemetryWindow(request, reply);
    if (!range) return telemetryWindowError;
    const server = store.getMcpServer(request.params.id);
    if (!server) {
      reply.code(404);
      return { error: "MCP server not found" };
    }
    const rollup = rollupMcpToolCalls(store.listMcpToolCalls({ registryServerId: server.id, since: range.since }));
    return { serverId: server.id, window: range.window, since: range.since, ...rollup };
  });

  app.get("/api/mcp/telemetry", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const range = resolveTelemetryWindow(request, reply);
    if (!range) return telemetryWindowError;
    const rollup = rollupMcpToolCalls(store.listMcpToolCalls({ registryServerId: null, since: range.since }), {
      byAdapter: true
    });
    return { scope: "inline", window: range.window, since: range.since, ...rollup };
  });

  const validateMcpServerInput = (
    input: { adapterId?: string; secretRef?: { secretId: string } | null },
    reply: FastifyReply
  ): { error: string } | null => {
    if (input.adapterId !== undefined && !mcpRegistry.tryGet(input.adapterId)) {
      reply.code(400);
      return { error: `Unknown MCP adapter '${input.adapterId}'` };
    }
    if (input.secretRef && !store.getSecret(input.secretRef.secretId)) {
      reply.code(400);
      return { error: `Secret '${input.secretRef.secretId}' does not exist` };
    }
    return null;
  };

  /** Phase 10.6 — with MCP_CATALOG_ENFORCE, stdio servers must run an approved, pinned catalog package. */
  const enforceMcpCatalog = (
    adapterId: string,
    connection: Record<string, unknown> | undefined,
    reply: FastifyReply
  ): { error: string } | null => {
    if (adapterId !== "stdio_mcp") return null;
    const command = typeof connection?.command === "string" ? connection.command : "";
    const args = Array.isArray(connection?.args) ? connection.args.map(String) : [];
    const reason = mcpCatalogService.checkStdioCommand(command, args);
    if (!reason) return null;
    reply.code(403);
    return { error: reason };
  };

  /** Phase 10.7 — sandbox and credential-mode rules for a server as it will be saved. */
  const validateMcpRuntimeSafety = (
    next: {
      adapterId: string;
      connection: Record<string, unknown>;
      sandbox: McpSandboxSettings | null | undefined;
      credentialMode: "service" | "delegated";
    },
    reply: FastifyReply
  ): { error: string } | null => {
    const sandboxProblem = sandboxSaveProblem(next.adapterId, next.sandbox);
    if (sandboxProblem) {
      reply.code(400);
      return { error: sandboxProblem };
    }
    if (next.credentialMode === "delegated" && !McpOAuthService.usesOAuth({ adapterId: next.adapterId, connection: next.connection })) {
      reply.code(400);
      return { error: "Delegated credentials need a remote (http) MCP server whose auth type is OAuth." };
    }
    return null;
  };

  const probeInBackground = (serverId: string) => {
    void mcpProbeService.probe(serverId).catch((err) => {
      app.log.warn({ serverId, err: err instanceof Error ? err.message : String(err) }, "Initial MCP probe failed");
    });
  };

  app.post<{ Body: unknown }>("/api/mcp/servers", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const parsed = mcpServerCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid MCP server payload", details: parsed.error.issues };
    }
    const invalid = validateMcpServerInput(parsed.data, reply);
    if (invalid) return invalid;
    const blocked = enforceMcpCatalog(parsed.data.adapterId, parsed.data.connection, reply);
    if (blocked) return blocked;
    const unsafe = validateMcpRuntimeSafety(
      {
        adapterId: parsed.data.adapterId,
        connection: parsed.data.connection ?? {},
        sandbox: parsed.data.sandbox,
        credentialMode: parsed.data.credentialMode ?? "service"
      },
      reply
    );
    if (unsafe) return unsafe;

    const id = `mcp_${crypto.randomUUID()}`;
    store.createMcpServer({
      id,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      adapterId: parsed.data.adapterId,
      connection: parsed.data.connection ?? {},
      secretId: parsed.data.secretRef?.secretId ?? null,
      owner: parsed.data.owner ?? user.email,
      projectId: parsed.data.projectId ?? null,
      probeEnabled: parsed.data.probeEnabled,
      probeIntervalMs: parsed.data.probeIntervalMs ?? null,
      blockOnBreakingChange: parsed.data.blockOnBreakingChange,
      sampling: parsed.data.sampling ?? null,
      sandbox: parsed.data.adapterId === "stdio_mcp" ? parsed.data.sandbox ?? null : null,
      limits: parsed.data.limits ?? null,
      credentialMode: parsed.data.credentialMode ?? "service",
      delegatedFallback: parsed.data.delegatedFallback ?? "none",
      createdBy: user.email
    });
    auditService.record({
      category: "system",
      eventType: "mcp_server.created",
      action: "create",
      outcome: "success",
      actor: { email: user.email, type: "user" },
      resourceType: "mcp_server",
      resourceId: id,
      projectId: parsed.data.projectId ?? null,
      metadata: {
        name: parsed.data.name,
        adapterId: parsed.data.adapterId,
        sandbox: parsed.data.sandbox?.mode ?? null,
        credentialMode: parsed.data.credentialMode ?? "service"
      }
    });
    if (parsed.data.probeEnabled !== false) {
      probeInBackground(id);
    }
    reply.code(201);
    return { server: mcpServerSummary(store.getMcpServer(id)!, user) };
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/api/mcp/servers/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const existing = store.getMcpServer(request.params.id);
    if (!existing) {
      reply.code(404);
      return { error: "MCP server not found" };
    }
    const parsed = mcpServerUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid MCP server payload", details: parsed.error.issues };
    }
    const invalid = validateMcpServerInput(parsed.data, reply);
    if (invalid) return invalid;
    if (parsed.data.adapterId !== undefined || parsed.data.connection !== undefined) {
      const blocked = enforceMcpCatalog(
        parsed.data.adapterId ?? existing.adapterId,
        parsed.data.connection ?? existing.connection,
        reply
      );
      if (blocked) return blocked;
    }
    const nextAdapterId = parsed.data.adapterId ?? existing.adapterId;
    const nextCredentialMode = parsed.data.credentialMode ?? existing.credentialMode;
    const unsafe = validateMcpRuntimeSafety(
      {
        adapterId: nextAdapterId,
        connection: parsed.data.connection ?? existing.connection,
        sandbox: parsed.data.sandbox !== undefined ? parsed.data.sandbox : existing.sandbox,
        credentialMode: nextCredentialMode
      },
      reply
    );
    if (unsafe) return unsafe;

    const { secretRef, sampling, sandbox, ...rest } = parsed.data;
    // Switching how credentials work drops the connections of the other mode.
    if (nextCredentialMode !== existing.credentialMode) {
      if (nextCredentialMode === "delegated") mcpOAuthService.disconnect(existing.id);
      else mcpOAuthService.disconnectAllUsers(existing.id);
    }
    store.updateMcpServer(existing.id, {
      ...rest,
      ...(sandbox !== undefined ? { sandbox: nextAdapterId === "stdio_mcp" ? sandbox : null } : {}),
      ...(nextAdapterId !== "stdio_mcp" && existing.sandbox ? { sandbox: null } : {}),
      ...(secretRef !== undefined ? { secretId: secretRef?.secretId ?? null } : {}),
      // A partial sampling patch keeps what it does not mention.
      ...(sampling !== undefined ? { sampling: sampling ? { ...existing.sampling, ...sampling } : null } : {})
    });
    auditService.record({
      category: "system",
      eventType: "mcp_server.updated",
      action: "update",
      outcome: "success",
      actor: { email: user.email, type: "user" },
      resourceType: "mcp_server",
      resourceId: existing.id,
      metadata: { fields: Object.keys(parsed.data) }
    });
    const connectionChanged =
      parsed.data.adapterId !== undefined ||
      parsed.data.connection !== undefined ||
      secretRef !== undefined ||
      sandbox !== undefined ||
      parsed.data.credentialMode !== undefined;
    if (connectionChanged && store.getMcpServer(existing.id)?.probeEnabled) {
      probeInBackground(existing.id);
    }
    return { server: mcpServerSummary(store.getMcpServer(existing.id)!, user) };
  });

  app.delete<{ Params: { id: string }; Querystring: { force?: string } }>(
    "/api/mcp/servers/:id",
    async (request, reply) => {
      const user = await requireRole(request, reply, ["admin"]);
      if (!user) return;
      const existing = store.getMcpServer(request.params.id);
      if (!existing) {
        reply.code(404);
        return { error: "MCP server not found" };
      }
      const usages = listMcpServerUsages(store, existing.id);
      if (usages.length > 0 && request.query.force !== "true") {
        reply.code(409);
        return {
          error: `MCP server '${existing.name}' is used by ${usages.length} node(s). Repoint them first or delete with force=true.`,
          usages
        };
      }
      // Phase 10.5 — the OAuth tokens and client registration go with the server.
      mcpOAuthService.disconnect(existing.id);
      // Phase 10.7 — and every user's own tokens, and its breaker state.
      mcpOAuthService.disconnectAllUsers(existing.id);
      mcpRuntimeGuard.forget(existing.id);
      store.deleteMcpServer(existing.id);
      auditService.record({
        category: "system",
        eventType: "mcp_server.deleted",
        action: "delete",
        outcome: "success",
        actor: { email: user.email, type: "user" },
        resourceType: "mcp_server",
        resourceId: existing.id,
        metadata: { name: existing.name, orphanedNodes: usages.length }
      });
      return { ok: true };
    }
  );

  app.post<{ Params: { id: string } }>("/api/mcp/servers/:id/probe", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    if (!store.getMcpServer(request.params.id)) {
      reply.code(404);
      return { error: "MCP server not found" };
    }
    let outcome: Awaited<ReturnType<typeof mcpProbeService.probe>>;
    try {
      outcome = await mcpProbeService.probe(request.params.id, user.id);
    } catch (error) {
      if (error instanceof McpProbeSkippedError) {
        reply.code(error.statusCode);
        return { error: error.message };
      }
      throw error;
    }
    return {
      server: mcpServerSummary(outcome.server, user),
      probe: outcome.probe,
      snapshot: outcome.snapshot ? (({ tools: _tools, ...snapshot }) => snapshot)(outcome.snapshot) : null
    };
  });

  app.post<{ Params: { id: string } }>("/api/mcp/servers/:id/accept-change", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const existing = store.getMcpServer(request.params.id);
    if (!existing) {
      reply.code(404);
      return { error: "MCP server not found" };
    }
    const snapshot = store.acknowledgeMcpBreakingChange(existing.id, user.email);
    if (!snapshot) {
      reply.code(409);
      return { error: "There is no pending breaking change to accept" };
    }
    auditService.record({
      category: "system",
      eventType: "mcp_server.breaking_change_accepted",
      action: "update",
      outcome: "success",
      actor: { email: user.email, type: "user" },
      resourceType: "mcp_server",
      resourceId: existing.id,
      metadata: { snapshotId: snapshot.id, breakingChanges: snapshot.changes.filter((change) => change.breaking).length }
    });
    return { server: mcpServerSummary(store.getMcpServer(existing.id)!, user) };
  });

  // -------------------------------------------------------------------------
  // Phase 10.7 — runtime state (breaker, limits) and the breaker reset.
  // -------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>("/api/mcp/servers/:id/runtime", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const server = store.getMcpServer(request.params.id);
    if (!server) {
      reply.code(404);
      return { error: "MCP server not found" };
    }
    return { runtime: runtimeStateView(server.id, user), limits: server.limits, sandboxStatus: server.sandboxStatus };
  });

  app.post<{ Params: { id: string } }>("/api/mcp/servers/:id/breaker/reset", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const server = store.getMcpServer(request.params.id);
    if (!server) {
      reply.code(404);
      return { error: "MCP server not found" };
    }
    const wasOpen = mcpRuntimeGuard.resetBreaker(server.id, `Reset by ${user.email}.`);
    audit(request, user, {
      category: "system",
      eventType: "mcp_server.breaker_reset",
      action: "update",
      outcome: "success",
      resourceType: "mcp_server",
      resourceId: server.id,
      projectId: server.projectId,
      metadata: { name: server.name, wasOpen }
    });
    return { runtime: runtimeStateView(server.id, user) };
  });

  // -------------------------------------------------------------------------
  // Phase 10.2 — MCP tool policy. Builders can read rules and dry-run them
  // (they need to know why an agent will not see a tool); only admins change
  // rules or tool classifications.
  // -------------------------------------------------------------------------

  /** A rule's server is a registry entry or, for inline servers, an adapter id. */
  const validatePolicyScope = (
    input: { projectId?: string | null; serverId?: string | null },
    reply: FastifyReply
  ): { error: string } | null => {
    if (input.projectId && !store.getProject(input.projectId)) {
      reply.code(400);
      return { error: `Project '${input.projectId}' does not exist` };
    }
    if (input.serverId && !store.getMcpServer(input.serverId) && !mcpRegistry.tryGet(input.serverId)) {
      reply.code(400);
      return { error: `'${input.serverId}' is neither a registered MCP server nor an MCP adapter id` };
    }
    return null;
  };

  const recordPolicyAudit = (
    user: SafeUser,
    eventType: string,
    action: "create" | "update" | "delete",
    resourceId: string,
    metadata: Record<string, unknown>,
    projectId: string | null = null
  ) => {
    auditService.record({
      category: "system",
      eventType,
      action,
      outcome: "success",
      actor: { email: user.email, type: "user" },
      resourceType: "mcp_policy",
      resourceId,
      projectId,
      metadata
    });
  };

  const policyAuditMetadata = (rule: McpToolPolicyRule) => ({
    name: rule.name,
    effect: rule.effect,
    projectId: rule.projectId,
    roles: rule.roles,
    serverId: rule.serverId,
    toolPattern: rule.toolPattern,
    annotationHint: rule.annotationHint ?? null,
    kind: rule.kind ?? "tool",
    enabled: rule.enabled
  });

  // Phase 10.5 — OAuth 2.1 connections for remote MCP servers. Status is
  // readable by builders; connecting, refreshing and disconnecting are
  // admin-only. No route ever returns a token.
  const findOAuthServer = (serverId: string, reply: FastifyReply) => {
    const server = store.getMcpServer(serverId);
    if (!server) {
      reply.code(404);
      return null;
    }
    return server;
  };

  app.get<{ Params: { id: string } }>("/api/mcp/servers/:id/oauth", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const server = findOAuthServer(request.params.id, reply);
    if (!server) return { error: "MCP server not found" };
    return { status: mcpOAuthService.status(server.id), usesOAuth: McpOAuthService.usesOAuth(server) };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/mcp/servers/:id/oauth/connect", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const server = findOAuthServer(request.params.id, reply);
    if (!server) return { error: "MCP server not found" };
    const parsed = mcpOAuthConnectSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid OAuth connect payload", details: parsed.error.issues };
    }
    const sessionId = getSessionIdFromRequest(request);
    if (!sessionId) {
      // The callback is bound to a browser session; API keys cannot complete it.
      reply.code(400);
      return { error: "Connecting a server needs a signed-in browser session." };
    }
    try {
      const started = await mcpOAuthService.startAuthorization({
        server,
        sessionId,
        userEmail: user.email,
        ...(parsed.data.scope ? { scope: parsed.data.scope } : {})
      });
      audit(request, user, {
        category: "system",
        eventType: "mcp_server.oauth_connect_started",
        action: "update",
        outcome: "success",
        resourceType: "mcp_server",
        resourceId: server.id,
        projectId: server.projectId,
        metadata: { name: server.name }
      });
      return started;
    } catch (error) {
      const message = error instanceof Error ? error.message : "OAuth connect failed";
      audit(request, user, {
        category: "system",
        eventType: "mcp_server.oauth_connect_started",
        action: "update",
        outcome: "failure",
        resourceType: "mcp_server",
        resourceId: server.id,
        projectId: server.projectId,
        metadata: { name: server.name, error: message.slice(0, 300) }
      });
      reply.code(error instanceof McpOAuthUserError ? error.statusCode : 500);
      return { error: message };
    }
  });

  app.get<{ Querystring: Record<string, string | undefined> }>("/api/mcp/oauth/callback", async (request, reply) => {
    const query = request.query ?? {};
    const sessionId = getSessionIdFromRequest(request);
    const sessionUser = sessionId ? authService.getSessionUser(sessionId) : null;
    // Phase 10.7 — a user's own connection completes for that user; the shared one only for an admin.
    const outcome = sessionUser
      ? await mcpOAuthService.completeAuthorization({
          state: query.state,
          code: query.code,
          ...(query.error ? { error: query.error } : {}),
          ...(query.error_description ? { errorDescription: query.error_description } : {}),
          sessionId,
          actor: { userId: sessionUser.id, isAdmin: sessionUser.role === "admin" }
        })
      : {
          serverId: null,
          ok: false,
          error: "Sign in to L2M in this browser, then connect again."
        };
    if (outcome.serverId) {
      audit(request, sessionUser ?? null, {
        category: "system",
        eventType: outcome.userId ? "mcp_server.user_oauth_connected" : "mcp_server.oauth_connected",
        action: "update",
        outcome: outcome.ok ? "success" : "failure",
        resourceType: "mcp_server",
        resourceId: outcome.serverId,
        metadata: {
          ...(outcome.userId ? { userId: outcome.userId } : {}),
          ...(outcome.ok ? {} : { error: (outcome.error ?? "").slice(0, 300) })
        }
      });
    }
    const webOrigin = config.WEB_ORIGIN.split(",").map((entry) => entry.trim()).find(Boolean) ?? "/";
    const page = renderOAuthCallbackPage(outcome, webOrigin);
    reply
      .code(outcome.ok ? 200 : 400)
      .header("content-type", "text/html; charset=utf-8")
      .header("cache-control", "no-store")
      .header(
        "content-security-policy",
        `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${page.nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
      );
    return page.html;
  });

  app.post<{ Params: { id: string } }>("/api/mcp/servers/:id/oauth/refresh", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const server = findOAuthServer(request.params.id, reply);
    if (!server) return { error: "MCP server not found" };
    try {
      const status = await mcpOAuthService.refreshNow(server.id);
      audit(request, user, {
        category: "system",
        eventType: "mcp_server.oauth_refreshed",
        action: "update",
        outcome: "success",
        resourceType: "mcp_server",
        resourceId: server.id,
        projectId: server.projectId,
        metadata: {}
      });
      return { status };
    } catch (error) {
      reply.code(409);
      return { error: error instanceof Error ? error.message : "Token refresh failed", status: mcpOAuthService.status(server.id) };
    }
  });

  app.delete<{ Params: { id: string } }>("/api/mcp/servers/:id/oauth", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const server = findOAuthServer(request.params.id, reply);
    if (!server) return { error: "MCP server not found" };
    const status = mcpOAuthService.disconnect(server.id);
    audit(request, user, {
      category: "system",
      eventType: "mcp_server.oauth_disconnected",
      action: "update",
      outcome: "success",
      resourceType: "mcp_server",
      resourceId: server.id,
      projectId: server.projectId,
      metadata: { name: server.name }
    });
    return { status };
  });

  // Phase 10.7 — delegated credentials. Every user who can run workflows
  // connects their own account to delegated servers under My connections;
  // admins see who is connected (never a token) and can revoke.
  const canUseServer = (user: SafeUser, server: McpServerRecord) =>
    rbacService.can(user, server.projectId ?? DEFAULT_PROJECT_ID, "workflow:execute");
  const myConnection = (server: McpServerRecord, user: SafeUser): McpMyConnection => {
    const row = store.getMcpUserOAuthConnection(server.id, user.id);
    return {
      serverId: server.id,
      serverName: server.name,
      description: server.description,
      delegatedFallback: server.delegatedFallback,
      connection: row ? mcpOAuthService.userStatus(server, user.id, user.email) : null
    };
  };
  const findDelegatedServer = (serverId: string, reply: FastifyReply) => {
    const server = store.getMcpServer(serverId);
    if (!server || !McpOAuthService.isDelegated(server)) {
      reply.code(404);
      return null;
    }
    return server;
  };

  app.get("/api/mcp/connections", async (request, reply) => {
    const user = await requireRole(request, reply, ["operator"]);
    if (!user) return;
    const servers = store
      .listMcpServers()
      .filter((server) => McpOAuthService.isDelegated(server) && canUseServer(user, server));
    return { connections: servers.map((server) => myConnection(server, user)) };
  });

  app.post<{ Params: { serverId: string }; Body: unknown }>("/api/mcp/connections/:serverId/connect", async (request, reply) => {
    const user = await requireRole(request, reply, ["operator"]);
    if (!user) return;
    const server = findDelegatedServer(request.params.serverId, reply);
    if (!server || !canUseServer(user, server)) {
      reply.code(404);
      return { error: "No MCP server with your own account by that id." };
    }
    const parsed = mcpOAuthConnectSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid OAuth connect payload", details: parsed.error.issues };
    }
    const sessionId = getSessionIdFromRequest(request);
    if (!sessionId) {
      reply.code(400);
      return { error: "Connecting an account needs a signed-in browser session." };
    }
    try {
      const started = await mcpOAuthService.startAuthorization({
        server,
        sessionId,
        userEmail: user.email,
        userId: user.id,
        ...(parsed.data.scope ? { scope: parsed.data.scope } : {})
      });
      audit(request, user, {
        category: "system",
        eventType: "mcp_server.user_oauth_connect_started",
        action: "update",
        outcome: "success",
        resourceType: "mcp_server",
        resourceId: server.id,
        projectId: server.projectId,
        metadata: { name: server.name, userId: user.id }
      });
      return started;
    } catch (error) {
      const message = error instanceof Error ? error.message : "OAuth connect failed";
      audit(request, user, {
        category: "system",
        eventType: "mcp_server.user_oauth_connect_started",
        action: "update",
        outcome: "failure",
        resourceType: "mcp_server",
        resourceId: server.id,
        projectId: server.projectId,
        metadata: { name: server.name, userId: user.id, error: message.slice(0, 300) }
      });
      reply.code(error instanceof McpOAuthUserError ? error.statusCode : 500);
      return { error: message };
    }
  });

  app.delete<{ Params: { serverId: string } }>("/api/mcp/connections/:serverId", async (request, reply) => {
    const user = await requireRole(request, reply, ["operator"]);
    if (!user) return;
    const server = store.getMcpServer(request.params.serverId);
    if (!server) {
      reply.code(404);
      return { error: "MCP server not found" };
    }
    const removed = mcpOAuthService.disconnectUser(server.id, user.id);
    if (removed) {
      audit(request, user, {
        category: "system",
        eventType: "mcp_server.user_oauth_disconnected",
        action: "update",
        outcome: "success",
        resourceType: "mcp_server",
        resourceId: server.id,
        projectId: server.projectId,
        metadata: { name: server.name, userId: user.id }
      });
    }
    return { connection: myConnection(server, user) };
  });

  app.get<{ Params: { id: string } }>("/api/mcp/servers/:id/connections", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const server = store.getMcpServer(request.params.id);
    if (!server) {
      reply.code(404);
      return { error: "MCP server not found" };
    }
    const connections = store.listMcpUserOAuthConnections({ serverId: server.id }).map((row) => {
      const owner = store.getUserById(row.userId);
      return mcpOAuthService.userStatus(server, row.userId, owner?.email ?? null);
    });
    return { credentialMode: server.credentialMode, delegatedFallback: server.delegatedFallback, connections };
  });

  app.delete<{ Params: { id: string; userId: string } }>("/api/mcp/servers/:id/connections/:userId", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const server = store.getMcpServer(request.params.id);
    if (!server) {
      reply.code(404);
      return { error: "MCP server not found" };
    }
    if (!mcpOAuthService.disconnectUser(server.id, request.params.userId)) {
      reply.code(404);
      return { error: "That user has no connection to this server." };
    }
    audit(request, user, {
      category: "system",
      eventType: "mcp_server.user_oauth_revoked",
      action: "update",
      outcome: "success",
      resourceType: "mcp_server",
      resourceId: server.id,
      projectId: server.projectId,
      metadata: { name: server.name, userId: request.params.userId }
    });
    return { ok: true };
  });

  app.get("/api/mcp/policies", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    return { rules: store.listMcpToolPolicies(), roles: MCP_POLICY_ROLES };
  });

  app.post<{ Body: unknown }>("/api/mcp/policies", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const parsed = mcpToolPolicyRuleInputSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid MCP tool policy rule", details: parsed.error.issues };
    }
    const invalid = validatePolicyScope(parsed.data, reply);
    if (invalid) return invalid;
    const rule = store.createMcpToolPolicy({
      id: `mtp_${crypto.randomUUID()}`,
      name: parsed.data.name?.trim() || null,
      description: parsed.data.description?.trim() || null,
      effect: parsed.data.effect,
      projectId: parsed.data.projectId ?? null,
      roles: [...new Set(parsed.data.roles ?? [])],
      serverId: parsed.data.serverId ?? null,
      toolPattern: parsed.data.toolPattern ?? "*",
      annotationHint: parsed.data.annotationHint ?? null,
      kind: parsed.data.kind ?? "tool",
      enabled: parsed.data.enabled !== false,
      createdBy: user.email
    });
    recordPolicyAudit(user, "mcp_policy.created", "create", rule.id, policyAuditMetadata(rule), rule.projectId);
    reply.code(201);
    return { rule };
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/api/mcp/policies/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const existing = store.getMcpToolPolicy(request.params.id);
    if (!existing) {
      reply.code(404);
      return { error: "MCP tool policy rule not found" };
    }
    const parsed = mcpToolPolicyRuleUpdateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid MCP tool policy rule", details: parsed.error.issues };
    }
    const invalid = validatePolicyScope(parsed.data, reply);
    if (invalid) return invalid;
    const { name, description, roles, ...rest } = parsed.data;
    const rule = store.updateMcpToolPolicy(existing.id, {
      ...rest,
      ...(name !== undefined ? { name: name?.trim() || null } : {}),
      ...(description !== undefined ? { description: description?.trim() || null } : {}),
      ...(roles !== undefined ? { roles: [...new Set(roles)] } : {})
    })!;
    recordPolicyAudit(
      user,
      "mcp_policy.updated",
      "update",
      rule.id,
      { ...policyAuditMetadata(rule), fields: Object.keys(parsed.data) },
      rule.projectId
    );
    return { rule };
  });

  app.delete<{ Params: { id: string } }>("/api/mcp/policies/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const existing = store.getMcpToolPolicy(request.params.id);
    if (!existing) {
      reply.code(404);
      return { error: "MCP tool policy rule not found" };
    }
    store.deleteMcpToolPolicy(existing.id);
    recordPolicyAudit(user, "mcp_policy.deleted", "delete", existing.id, policyAuditMetadata(existing), existing.projectId);
    return { ok: true };
  });

  app.post<{ Body: unknown }>("/api/mcp/policies/evaluate", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const parsed = mcpToolPolicyEvaluateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid evaluate payload", details: parsed.error.issues };
    }
    const { role, serverId, toolName } = parsed.data;
    const projectId = parsed.data.projectId ?? null;
    const registered = store.getMcpServer(serverId);
    if (!registered && !mcpRegistry.tryGet(serverId)) {
      reply.code(404);
      return { error: `'${serverId}' is neither a registered MCP server nor an MCP adapter id` };
    }
    let annotations: McpToolAnnotations | undefined;
    if (registered?.currentSnapshotId) {
      annotations = store
        .getMcpToolSnapshot(registered.currentSnapshotId)
        ?.tools.find((tool) => tool.name === toolName)?.annotations;
    }
    const classifications = registered ? store.listMcpToolClassifications(registered.id) : [];
    const decision = evaluateToolForContext(
      {
        rules: store.listMcpToolPolicies(),
        classifications,
        role: role as McpPolicyRole,
        projectId,
        adapterId: registered ? registered.adapterId : serverId,
        ...(registered ? { registryServerId: registered.id, serverLabel: registered.name } : {}),
        noWriteTools: parsed.data.noWriteTools === true
      },
      { name: toolName, ...(annotations ? { annotations } : {}) },
      parsed.data.kind ?? "tool"
    );
    return {
      allowed: decision.allowed,
      reason: decision.reason ?? null,
      ruleId: decision.ruleId ?? null,
      ruleName: decision.ruleName ?? null,
      message: decision.message ?? null,
      decidedBy: decision.policy.decidedBy,
      decidingRuleId: decision.policy.rule?.id ?? null,
      matchedRules: decision.policy.matchedRules,
      overriddenDenies: decision.policy.overriddenDenies.map((entry) => ({ denyId: entry.deny.id, byId: entry.by.id })),
      classification: decision.classification,
      manualReadOnly: manualReadOnlyFor(classifications, registered?.id, toolName),
      server: registered
        ? { kind: "registry" as const, id: registered.id, name: registered.name, adapterId: registered.adapterId }
        : { kind: "inline" as const, adapterId: serverId },
      request: { projectId, role, serverId, toolName, kind: parsed.data.kind ?? "tool", noWriteTools: parsed.data.noWriteTools === true }
    };
  });

  app.put<{ Params: { id: string; toolName: string }; Body: unknown }>(
    "/api/mcp/servers/:id/tools/:toolName/classification",
    async (request, reply) => {
      const user = await requireRole(request, reply, ["admin"]);
      if (!user) return;
      const server = store.getMcpServer(request.params.id);
      if (!server) {
        reply.code(404);
        return { error: "MCP server not found" };
      }
      const toolName = request.params.toolName.trim();
      if (!toolName || toolName.length > 200) {
        reply.code(400);
        return { error: "Tool name is required" };
      }
      const parsed = mcpToolClassificationSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        reply.code(400);
        return { error: "Invalid classification payload", details: parsed.error.issues };
      }
      const override = store.setMcpToolClassification({
        registryServerId: server.id,
        toolName,
        readOnly: parsed.data.readOnly,
        setBy: user.email
      });
      recordPolicyAudit(
        user,
        parsed.data.readOnly === null ? "mcp_policy.classification_cleared" : "mcp_policy.classification_set",
        "update",
        `${server.id}:${toolName}`,
        { serverId: server.id, serverName: server.name, toolName, readOnly: parsed.data.readOnly },
        server.projectId
      );
      const snapshot = server.currentSnapshotId ? store.getMcpToolSnapshot(server.currentSnapshotId) : null;
      const annotations = snapshot?.tools.find((tool) => tool.name === toolName)?.annotations;
      const [marked] = markMcpTools([{ name: toolName, ...(annotations ? { annotations } : {}) }], {
        rules: [],
        classifications: store.listMcpToolClassifications(server.id),
        role: user.role,
        projectId: server.projectId ?? "default",
        adapterId: server.adapterId,
        registryServerId: server.id
      });
      return {
        serverId: server.id,
        toolName,
        override,
        classification: marked.classification,
        manualReadOnly: marked.manualReadOnly
      };
    }
  );

  app.get("/api/mcp/presets", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) {
      return;
    }
    return { presets: mcpCatalogService.presets(), catalog: mcpCatalogService.status() };
  });

  // Phase 10.6 — config import, catalog status and the playground.
  registerMcpOnboardingRoutes({
    app,
    store,
    mcpRegistry,
    catalog: mcpCatalogService,
    createSecret: (input) => secretService.createSecret(input),
    resolveSecret: (secretRef) => secretService.resolveSecret(secretRef),
    redact: (value) => String(secretService.redact(value)),
    resolveRegisteredMcpServer,
    withScopedMcpContext,
    requireRole: (request, reply, roles) => requireRole(request, reply, roles),
    canExecuteInProject: (user, projectId) => rbacService.can(user, projectId, "workflow:execute"),
    auditUser: (request, user, event) => audit(request, user, event),
    probeInBackground,
    sandboxSaveProblem,
    serverSummary: (server) => mcpServerSummary(server)
  });

  // Phase 10.5 — resources, prompts and elicitation requests.
  registerMcpClientFeatureRoutes({
    app,
    store,
    runAccess,
    mcpRegistry,
    elicitations: mcpElicitationService,
    resourceMaxBytes: config.MCP_RESOURCE_MAX_BYTES,
    resolveSecret: (secretRef) => secretService.resolveSecret(secretRef),
    redact: (value) => String(secretService.redact(value)),
    resolveRegisteredMcpServer,
    withScopedMcpContext,
    requireRole: (request, reply, roles) => requireRole(request, reply, roles),
    canExecuteInProject: (user, projectId) => rbacService.can(user, projectId, "workflow:execute"),
    auditUser: (request, user, event) => audit(request, user, event)
  });

  // Phase 10.3 — read-only routes behind the MCP control plane pages.
  registerMcpControlPlaneRoutes({
    app,
    runAccess,
    store,
    oauth: mcpOAuthService,
    usesOAuth: (server) => McpOAuthService.usesOAuth(server),
    latency: (serverId) => mcpProbeService.latency(serverId),
    runtime: (serverId, user) => runtimeStateView(serverId, user),
    requireRole: (request, reply, roles) => requireRole(request, reply, roles)
  });

  // Phase 11.1 — signed run manifests, audit bundles and the signing key.
  const auditSigningService = new AuditSigningService(store, secretService, {
    envKeyBase64: config.AUDIT_SIGNING_KEY_BASE64,
    logger: { info: (message, fields) => app.log.info(fields ?? {}, message), warn: (message, fields) => app.log.warn(fields ?? {}, message) }
  });
  const auditBundleService = new AuditBundleService({
    store,
    signing: auditSigningService,
    secrets: secretService,
    priceTurn: (providerId, model, inputTokens, outputTokens, cachedInputTokens) => usageService.estimateCostUsd(providerId, model, inputTokens, outputTokens, cachedInputTokens),
    catalogEntries: () => mcpCatalogService.listEntries(),
    maxBundleBytes: config.AUDIT_BUNDLE_MAX_BYTES,
    environmentSecretValues: () => environmentSecretValues(config as unknown as Record<string, unknown>, process.env),
    logger: { warn: (message, fields) => app.log.warn(fields ?? {}, message) }
  });
  registerAuditBundleRoutes({ app, store, bundles: auditBundleService, signing: auditSigningService, requireRole: (request, reply, roles) => requireRole(request, reply, roles), runAccess, audit: (request, user, event) => audit(request, user, event) });

  // Phase 15.1 — golden runs and replay.
  const replayRecordingService = new ReplayRecordingService({
    store,
    secrets: secretService,
    environmentSecretValues: () => environmentSecretValues(config as unknown as Record<string, unknown>, process.env),
    redact: (value) => {
      const redacted = secretService.redact(value);
      return typeof redacted === "string" ? redacted : value;
    },
    priceTurn: (providerId, model, inputTokens, outputTokens, cachedInputTokens) => usageService.estimateCostUsd(providerId, model, inputTokens, outputTokens, cachedInputTokens),
    maxBytes: config.REPLAY_RECORDING_MAX_BYTES,
    maxPerWorkflow: config.REPLAY_RECORDINGS_MAX_PER_WORKFLOW,
    maxBytesPerWorkflow: config.REPLAY_RECORDINGS_MAX_BYTES_PER_WORKFLOW,
    maxTotalBytes: config.REPLAY_RECORDINGS_MAX_TOTAL_BYTES
  });
  const replayService = new ReplayService({
    store,
    recordings: replayRecordingService,
    cassettes: mcpCassetteService,
    priceTurn: (providerId, model, inputTokens, outputTokens, cachedInputTokens) => usageService.estimateCostUsd(providerId, model, inputTokens, outputTokens, cachedInputTokens),
    execute: async (replay, actor) => {
      const storedInput = asRecord(replay.recording.input);
      const executed = await runWorkflowExecution({
        ...replayRunInputFor(replay.recording.sourceTriggerType, storedInput),
        // The workflow's pinned outputs are not part of the candidate under test.
        usePinnedData: false,
        mcpPlan: replay.mcpPlan,
        replay: { hook: replay.plan.hook, sandbox: createReplaySandbox() },
        policyActor: actor,
        workflow: replay.workflow,
        customData: replay.customData,
        executionId: replay.executionId,
        triggerType: REPLAY_TRIGGER_TYPE,
        triggeredBy: actor.email,
        hooks: createProgressTrackingHooks({
          executionId: replay.executionId,
          workflow: replay.workflow,
          triggerType: REPLAY_TRIGGER_TYPE,
          triggeredBy: actor.email,
          requestInput: storedInput,
          customData: replay.customData
        })
      });
      const result = finishMcpCassettePlan(replay.mcpPlan, executed, { executionId: replay.executionId, workflow: replay.workflow, source: "replay", createdBy: actor.email });
      persistExecutionHistory({
        executionId: replay.executionId,
        workflow: replay.workflow,
        result,
        triggerType: REPLAY_TRIGGER_TYPE,
        triggeredBy: actor.email,
        requestInput: storedInput,
        customData: replay.customData
      });
      return result;
    }
  });
  registerReplayRoutes({
    app,
    store,
    recordings: replayRecordingService,
    replays: replayService,
    requireRole: (request, reply, roles) => requireRole(request, reply, roles),
    runAccess,
    audit: (request, user, event) => audit(request, user, event)
  });

  registerGuardRoutes({ app, store, guard: guardService, requireRole: (request, reply, roles) => requireRole(request, reply, roles), runAccess, canAccessWorkflow: (user, workflow, permission) => rbacService.canAccessWorkflow(user, workflow, permission), canInProject: (user, projectId, permission) => rbacService.can(user, projectId, permission), audit: (request, user, event) => audit(request, user, event) });

  registerMcpTestingRoutes({
    app,
    store,
    runAccess,
    mcpRegistry,
    resolveSecret: (secretRef) => secretService.resolveSecret(secretRef),
    probeTimeoutMs: config.MCP_PROBE_TIMEOUT_MS,
    loadMcpToolPolicy,
    resolveToolPolicySubject: (workflowId) => resolveToolPolicySubject(workflowId),
    requireRole: (request, reply, roles) => requireRole(request, reply, roles),
    audit: (event) => auditService.record(event),
    redact: (value) => {
      const redacted = secretService.redact(value);
      return typeof redacted === "string" ? redacted : value;
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
      // A job a user enqueued runs only if that user may still run the
      // workflow: a revoked membership or a deleted account stops it.
      // Retrying cannot fix that, so the job goes straight to the DLQ.
      let enqueuedBy: SafeUser | null = null;
      if (payload.enqueuedByUserId) {
        const found = store.getUserById(payload.enqueuedByUserId);
        enqueuedBy = found ? { id: found.id, email: found.email, role: found.role as UserRole } : null;
        if (!enqueuedBy || !runAccess.workflow(enqueuedBy, workflow.id, "workflow:execute").ok) {
          const reason = enqueuedBy ? "no_execute_permission" : "user_not_found";
          auditService.record({
            category: "workflow",
            eventType: "queue.job_refused",
            action: "execute",
            outcome: "denied",
            actor: enqueuedBy ? { userId: enqueuedBy.id, email: enqueuedBy.email, type: "user" } : { userId: payload.enqueuedByUserId, type: "user" },
            resourceType: "workflow",
            resourceId: workflow.id,
            projectId: workflow.projectId ?? DEFAULT_PROJECT_ID,
            metadata: { executionId: payload.executionId, reason },
            message: "Queued run refused: the user who queued it may no longer run this workflow."
          });
          throw new NonRetryableQueueError(
            `The user who queued this run can no longer run workflow ${payload.workflowId} (workflow:execute is required).`
          );
        }
      }
      const startedAt = new Date().toISOString();
      const result = await runWorkflowExecution({
        policyActor: enqueuedBy,
        elicitationsForWorkflow: true,
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
      return queueService.listDlq(limit, runAccess.readableWorkflowIds(user) ?? undefined);
    });

    app.post<{ Params: { id: string }; Body: unknown }>(
      "/api/workflows/:id/enqueue",
      async (request, reply) => {
        const user = await requireRole(request, reply, ["operator", "builder", "admin"]);
        if (!user) return;

        const access = runAccess.workflow(user, request.params.id, "workflow:execute");
        if (!access.ok) return denyRunAccess(reply, access);
        const workflow = access.workflow;

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
          // Who queued it comes from the session, never from the body.
          triggeredBy: user.email,
          enqueuedByUserId: user.id,
          executionTimeoutMs: typeof body.executionTimeoutMs === "number" ? body.executionTimeoutMs : undefined,
          customData: (() => {
            const custom = body.customData && typeof body.customData === "object" && !Array.isArray(body.customData)
              ? { ...(body.customData as Record<string, unknown>) }
              : undefined;
            // A caller-supplied triggeredBy is kept as data, not as the audit actor.
            if (typeof body.triggeredBy === "string" && body.triggeredBy !== user.email) {
              return { ...(custom ?? {}), requestedBy: body.triggeredBy };
            }
            return custom;
          })(),
          priority: typeof body.priority === "number" ? body.priority : 0
        });

        auditRunAction(request, user, "execution.started", { executionId, workflowId: workflow.id, projectId: workflow.projectId }, { triggerType: "queue" });

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
    // Phase 10.7 — a deleted user's own MCP connections (and their tokens) go with them.
    mcpOAuthService.disconnectUserEverywhere(request.params.id);
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

  // ── Phase 7.4: Workflow Templates & Sharing ───────────────────────────

  // List templates (any authenticated user)
  app.get("/api/templates", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin", "builder", "operator", "viewer"]);
    if (!user) return;
    const query = request.query as Record<string, string>;
    const category = query.category || undefined;
    const search = query.search || undefined;
    const templates = store.listTemplates({ category, search });
    // Enrich each template with detected external dependencies (OpenAI key,
    // Pinecone, etc.) so the gallery can show "Requires: …" pills before the
    // user clicks Use Template. listTemplates returns metadata only, so we
    // fetch the full row per template to get the workflowJson. Template count
    // is small (~10s) and this read path is cold, so the extra cost is fine.
    const enriched = templates.map((tpl) => {
      const full = store.getTemplate(tpl.id);
      let dependencies: ReturnType<typeof computeTemplateDependencies> = [];
      let thumbnailSvg = "";
      if (full?.workflowJson) {
        try {
          const parsed = JSON.parse(full.workflowJson);
          dependencies = computeTemplateDependencies(parsed);
          thumbnailSvg = buildTemplateThumbnail(parsed);
        } catch {
          // Malformed JSON shouldn't break the gallery — skip badges + thumbnail silently.
        }
      }
      const featured = FEATURED_TEMPLATE_IDS.has(tpl.id);
      return { ...tpl, dependencies, thumbnailSvg, featured };
    });
    // Featured templates float to the top of the gallery; everything else
    // keeps the store's category+name order from listTemplates.
    enriched.sort((a, b) => Number(b.featured) - Number(a.featured));
    return { templates: enriched };
  });

  // Get single template
  app.get<{ Params: { id: string } }>("/api/templates/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin", "builder", "operator", "viewer"]);
    if (!user) return;
    const template = store.getTemplate(request.params.id);
    if (!template) { reply.code(404); return { error: "Template not found" }; }
    return template;
  });

  // Create template from workflow (admin/builder)
  app.post("/api/templates", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin", "builder"]);
    if (!user) return;
    const schema = z.object({
      name: z.string().min(1),
      description: z.string().default(""),
      category: z.string().default("General"),
      tags: z.array(z.string()).default([]),
      author: z.string().default(""),
      workflowId: z.string().optional(),
      workflowJson: z.string().optional()
    });
    const parsed = schema.safeParse(request.body ?? {});
    if (!parsed.success) { reply.code(400); return { error: "Invalid payload", details: parsed.error.issues }; }

    let wfData: Record<string, unknown>;
    if (parsed.data.workflowId) {
      // Publishing a template shows the workflow's configuration to every
      // user, so it takes write access to the source, not only read.
      const access = runAccess.workflow(user, parsed.data.workflowId, "workflow:write");
      if (!access.ok) return denyRunAccess(reply, access);
      wfData = { ...access.workflow };
    } else if (parsed.data.workflowJson) {
      try {
        const candidate: unknown = JSON.parse(parsed.data.workflowJson);
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("not an object");
        wfData = { ...(candidate as Record<string, unknown>) };
      } catch {
        reply.code(400);
        return { error: "workflowJson must be a JSON object" };
      }
    } else {
      reply.code(400);
      return { error: "Either workflowId or workflowJson is required" };
    }
    // Templates are readable by every user, so they never carry where the
    // source lived or what its runs produced: no project, folder or pinned data.
    delete wfData.projectId;
    delete wfData.folderId;
    delete wfData.pinnedData;
    const workflowJson = JSON.stringify(wfData);
    const id = crypto.randomUUID();
    store.upsertTemplate({
      id,
      name: parsed.data.name,
      description: parsed.data.description,
      category: parsed.data.category,
      tags: parsed.data.tags,
      author: parsed.data.author || user.email,
      workflowJson,
      nodeCount: Array.isArray(wfData.nodes) ? wfData.nodes.length : 0
    });

    audit(request, user, {
      category: "workflow",
      eventType: "template.create",
      action: "create",
      resourceType: "template",
      resourceId: id
    });
    return { id, name: parsed.data.name };
  });

  // Import template as new workflow (admin/builder)
  app.post<{ Params: { id: string } }>("/api/templates/:id/use", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin", "builder"]);
    if (!user) return;
    const template = store.getTemplate(request.params.id);
    if (!template) { reply.code(404); return { error: "Template not found" }; }

    const target = z
      .object({ projectId: z.string().trim().min(1).optional(), folderId: z.string().trim().min(1).optional() })
      .safeParse(request.body ?? {});
    if (!target.success) { reply.code(400); return { error: "Invalid payload", details: target.error.issues }; }

    const imported = importWorkflowFromJson(template.workflowJson);
    imported.id = crypto.randomUUID();
    imported.name = `${template.name} (from template)`;
    // The new workflow lands where the caller asks (default project), never
    // in whatever project the template's JSON names.
    imported.projectId = target.data.projectId ?? DEFAULT_PROJECT_ID;
    imported.folderId = target.data.folderId;
    delete imported.pinnedData;
    const saveDenial = workflowSaveDenial(user, imported);
    if (saveDenial) return denyRunAccess(reply, saveDenial);
    store.upsertWorkflow(imported, { createdBy: user.id });

    audit(request, user, {
      category: "workflow",
      eventType: "template.use",
      action: "use",
      resourceType: "template",
      resourceId: template.id,
      metadata: { newWorkflowId: imported.id }
    });
    return { workflowId: imported.id, name: imported.name };
  });

  // Delete template (admin)
  app.delete<{ Params: { id: string } }>("/api/templates/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const deleted = store.deleteTemplate(request.params.id);
    if (!deleted) { reply.code(404); return { error: "Template not found" }; }
    audit(request, user, {
      category: "workflow",
      eventType: "template.delete",
      action: "delete",
      resourceType: "template",
      resourceId: request.params.id
    });
    return { ok: true };
  });

  // Share workflow via URL (generate a shareable export link)
  app.get<{ Params: { id: string } }>("/api/workflows/:id/share-link", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin", "builder"]);
    if (!user) return;
    const access = runAccess.workflow(user, request.params.id, "workflow:read");
    if (!access.ok) return denyRunAccess(reply, access);
    const exported = exportWorkflowToJson(access.workflow);
    const encoded = Buffer.from(exported).toString("base64url");
    return { shareUrl: `/api/workflows/import-shared?data=${encoded}`, expiresIn: "permanent" };
  });

  // Import shared workflow from URL
  app.get("/api/workflows/import-shared", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin", "builder"]);
    if (!user) return;
    const query = request.query as Record<string, string>;
    const data = query.data;
    if (!data) { reply.code(400); return { error: "Missing data parameter" }; }
    try {
      const json = Buffer.from(data, "base64url").toString("utf-8");
      const imported = importWorkflowFromJson(json);
      imported.id = crypto.randomUUID();
      imported.name = `${imported.name} (imported)`;
      const saveDenial = workflowSaveDenial(user, imported);
      if (saveDenial) return denyRunAccess(reply, saveDenial);
      store.upsertWorkflow(imported, { createdBy: user.id });
      return { workflowId: imported.id, name: imported.name };
    } catch {
      reply.code(400);
      return { error: "Invalid shared workflow data" };
    }
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

  // ── Phase 7.5: Notifications ───────────────────────────────────────────

  app.get("/api/notifications", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const configs = store.listNotificationConfigs();
    return { configs };
  });

  app.post("/api/notifications", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const body = request.body as Record<string, unknown> | null;
    if (!body) { reply.code(400); return { error: "Missing body" }; }
    const id = typeof body.id === "string" && body.id ? body.id : crypto.randomUUID();
    const channel = typeof body.channel === "string" ? body.channel : "";
    if (!channel || !["email", "slack", "teams"].includes(channel)) {
      reply.code(400);
      return { error: "Invalid channel. Must be email, slack, or teams." };
    }
    const enabled = body.enabled !== false;
    const configObj = (body.config && typeof body.config === "object" && !Array.isArray(body.config))
      ? body.config as Record<string, unknown>
      : {};
    const events = Array.isArray(body.events) ? body.events.filter((e): e is string => typeof e === "string") : ["execution.failure"];
    store.upsertNotificationConfig({ id, channel, enabled, config: configObj, events });
    notificationService.reload();
    audit(request, user, {
      category: "system",
      eventType: "notification.upsert",
      action: "upsert",
      resourceType: "notification_config",
      resourceId: id
    });
    return { id, channel, enabled, events };
  });

  app.delete<{ Params: { id: string } }>("/api/notifications/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const deleted = store.deleteNotificationConfig(request.params.id);
    if (!deleted) { reply.code(404); return { error: "Notification config not found" }; }
    notificationService.reload();
    audit(request, user, {
      category: "system",
      eventType: "notification.delete",
      action: "delete",
      resourceType: "notification_config",
      resourceId: request.params.id
    });
    return { ok: true };
  });

  app.post("/api/notifications/test", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const body = request.body as Record<string, unknown> | null;
    if (!body) { reply.code(400); return { error: "Missing body" }; }
    const channel = typeof body.channel === "string" ? body.channel : "";
    if (!channel || !["email", "slack", "teams"].includes(channel)) {
      reply.code(400);
      return { error: "Invalid channel" };
    }
    const configObj = (body.config && typeof body.config === "object" && !Array.isArray(body.config))
      ? body.config as Record<string, unknown>
      : {};
    try {
      const svc = new NotificationService(config, () => [{
        channel,
        enabled: true,
        config: configObj,
        events: ["execution.failure"]
      }]);
      await svc.notify({
        type: "execution.failure",
        workflowId: "test-workflow-id",
        workflowName: "Test Notification Workflow",
        executionId: "test-execution-id",
        error: "This is a test notification from AI Orchestrator.",
        timestamp: new Date().toISOString()
      });
      return { ok: true, message: "Test notification sent" };
    } catch (err) {
      reply.code(500);
      return { error: "Failed to send test notification", details: err instanceof Error ? err.message : String(err) };
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === "number"
      ? Number((error as { statusCode?: unknown }).statusCode)
      : 500;
    const errorCode = typeof (error as { code?: unknown }).code === "string"
      ? String((error as { code?: unknown }).code)
      : "";
    const isPayloadTooLarge =
      errorCode === "FST_ERR_CTP_BODY_TOO_LARGE" ||
      statusCode === 413 ||
      message.toLowerCase().includes("request body is too large");

    if (isPayloadTooLarge) {
      app.log.warn(
        { limitBytes: config.API_BODY_LIMIT_BYTES, err: secretService.redact(message) },
        "Rejected request: body exceeds configured limit"
      );
      reply.code(413).send({
        error: "Request body is too large",
        limitBytes: config.API_BODY_LIMIT_BYTES
      });
      return;
    }

    app.log.error({ err: secretService.redact(message) }, "Unhandled API error");
    reply.code(500).send({
      error: "Internal server error"
    });
  });

  return app;
}
