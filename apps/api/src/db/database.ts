import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import Database, { type Database as BetterSqlite3Database } from "better-sqlite3";
import type {
  ChatMessage,
  Folder,
  McpPolicyRole,
  McpClient,
  McpCassette,
  McpCassetteBadge,
  McpCassetteRecord,
  McpCassetteSource,
  McpCassetteSummary,
  McpElicitationSchema,
  McpElicitationStatus,
  McpElicitationView,
  McpOAuthConnectionState,
  McpPolicyKind,
  McpPrompt,
  McpResource,
  McpResourceTemplate,
  McpSamplingSettings,
  McpServerCapabilities,
  McpServerCatalog,
  McpToolAnnotations,
  McpToolClassificationOverride,
  McpToolHintCondition,
  McpToolPolicyRule,
  McpToolset,
  McpToolsetMember,
  McpToolsetMemberSpec,
  Project,
  Workflow,
  WorkflowListItem,
  ReplayRecordingSummary,
  ReplayRecordedNode,
  RunFacts,
  ReplayRecordingCapabilities,
  ReplayGoldenBadge
} from "@ai-orchestrator/shared";
import { DEFAULT_MCP_SAMPLING_SETTINGS, DEFAULT_PROJECT_ID, MCP_POLICY_KINDS, MCP_POLICY_ROLES, MCP_TOOL_HINT_CONDITIONS } from "@ai-orchestrator/shared";
import {
  normalizeMcpRuntimeLimits,
  normalizeMcpSandboxSettings,
  type McpCredentialMode,
  type McpDelegatedFallback,
  type McpRuntimeLimits,
  type McpRuntimeRejection,
  type McpSandboxSettings,
  type McpSandboxStatus
} from "@ai-orchestrator/shared";
import { queuedRunTimeoutMs, STUCK_JOB_MARGIN_MS } from "./queue-timeouts.js";

type BindParams = unknown[];

interface WorkflowRow {
  id: string;
  name: string;
  schema_version: string;
  workflow_version: number;
  workflow_json: string;
  created_at: string;
  updated_at: string;
  tags_json?: string | null;
  project_id?: string | null;
  folder_id?: string | null;
}

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface FolderRow {
  id: string;
  name: string;
  parent_id: string | null;
  project_id: string;
  created_at: string;
  updated_at: string;
}

interface SecretRow {
  id: string;
  name: string;
  provider: string;
  iv: string;
  auth_tag: string;
  ciphertext: string;
  created_at: string;
  project_id?: string | null;
  source?: string | null;
  external_provider_id?: string | null;
  external_key?: string | null;
}

interface SessionMemoryRow {
  namespace: string;
  session_id: string;
  messages_json: string;
  created_at: string;
  updated_at: string;
}

interface SessionToolCacheRow {
  id: string;
  namespace: string;
  session_id: string;
  tool_name: string;
  tool_call_id: string | null;
  args_json: string;
  output_json: string;
  error: string | null;
  summary_json: string | null;
  created_at: string;
}

interface SessionArtifactRow {
  namespace: string;
  session_id: string;
  artifact_key: string;
  value_json: string;
  created_at: string;
  updated_at: string;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: string;
  created_at: string;
  updated_at: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  expires_at: string;
  created_at: string;
  last_seen_at: string;
  revoked_at: string | null;
}

interface WebhookReplayRow {
  replay_key: string;
  endpoint_key: string;
  created_at: string;
  expires_at: string;
}

interface WebhookIdempotencyRow {
  endpoint_key: string;
  idempotency_key: string;
  request_hash: string;
  status: string;
  result_json: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

interface ExecutionQueueRow {
  id: string;
  workflow_id: string;
  workflow_name: string | null;
  payload_json: string;
  status: string;
  priority: number;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  scheduled_at: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ExecutionQueueDlqRow {
  id: string;
  original_id: string;
  workflow_id: string;
  workflow_name: string | null;
  payload_json: string;
  attempts: number;
  final_error: string;
  failed_at: string;
  created_at: string;
}

interface ExecutionHistoryRow {
  id: string;
  workflow_id: string;
  workflow_name: string | null;
  status: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  trigger_type: string | null;
  triggered_by: string | null;
  input_json: string | null;
  output_json: string | null;
  node_results_json: string | null;
  custom_data_json: string | null;
  error: string | null;
  created_at: string;
}

interface WorkflowExecutionRow {
  id: string;
  workflow_id: string;
  workflow_name: string | null;
  status: string;
  waiting_node_id: string;
  approval_message: string | null;
  timeout_minutes: number | null;
  trigger_type: string | null;
  triggered_by: string | null;
  started_at: string;
  state_json: string;
  created_at: string;
  updated_at: string;
}

interface WorkflowTemplateRow {
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string;
  author: string;
  workflow_json: string;
  node_count: number;
  created_at: string;
  updated_at: string;
}

export interface LogStreamDestinationRecord {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  categories: string[];
  minLevel: string;
  configIv: string | null;
  configAuthTag: string | null;
  configCiphertext: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  dispatchedCount: number;
  failedCount: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface LogStreamDestinationRow {
  id: string;
  name: string;
  type: string;
  enabled: number;
  categories_json: string;
  min_level: string;
  config_iv: string | null;
  config_auth_tag: string | null;
  config_ciphertext: string | null;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  dispatched_count: number;
  failed_count: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// Phase 8.3 — budgets
export interface BudgetRecord {
  id: string;
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
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface BudgetRow {
  id: string;
  name: string;
  scope_type: string;
  scope_id: string | null;
  period: string;
  limit_type: string;
  limit_value: number;
  warn_threshold_pct: number;
  action: string;
  notify_channel: string | null;
  enabled: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// Phase 9.1 — knowledge bases
export interface KnowledgeBaseRecord {
  id: string;
  name: string;
  description: string | null;
  projectId: string | null;
  embedderId: string;
  embedderConfig: Record<string, unknown>;
  dimensions: number;
  chunkCount: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeBaseChunkRecord {
  id: string;
  knowledgeBaseId: string;
  sourceId: string | null;
  chunkIndex: number;
  content: string;
  metadata: Record<string, unknown> | null;
  vector: number[];
  createdAt: string;
}

interface KnowledgeBaseRow {
  id: string;
  name: string;
  description: string | null;
  project_id: string | null;
  embedder_id: string;
  embedder_config_json: string | null;
  dimensions: number;
  chunk_count: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface KnowledgeBaseChunkRow {
  id: string;
  knowledge_base_id: string;
  source_id: string | null;
  chunk_index: number;
  content: string;
  metadata_json: string | null;
  vector_json: string;
  created_at: string;
}

function mapKnowledgeBase(row: KnowledgeBaseRow): KnowledgeBaseRecord {
  return {
    id: toString(row.id),
    name: toString(row.name),
    description: row.description ? toString(row.description) : null,
    projectId: row.project_id ? toString(row.project_id) : null,
    embedderId: toString(row.embedder_id),
    embedderConfig: row.embedder_config_json
      ? (safeJsonParse(toString(row.embedder_config_json)) as Record<string, unknown>) ?? {}
      : {},
    dimensions: toNumber(row.dimensions),
    chunkCount: toNumber(row.chunk_count),
    createdBy: row.created_by ? toString(row.created_by) : null,
    createdAt: toString(row.created_at),
    updatedAt: toString(row.updated_at)
  };
}

function mapKnowledgeBaseChunk(row: KnowledgeBaseChunkRow): KnowledgeBaseChunkRecord {
  return {
    id: toString(row.id),
    knowledgeBaseId: toString(row.knowledge_base_id),
    sourceId: row.source_id ? toString(row.source_id) : null,
    chunkIndex: toNumber(row.chunk_index),
    content: toString(row.content),
    metadata: row.metadata_json
      ? (safeJsonParse(toString(row.metadata_json)) as Record<string, unknown>)
      : null,
    vector: safeJsonParse(toString(row.vector_json)) as number[],
    createdAt: toString(row.created_at)
  };
}

function mapBudget(row: BudgetRow): BudgetRecord {
  return {
    id: toString(row.id),
    name: toString(row.name),
    scopeType: toString(row.scope_type) as BudgetRecord["scopeType"],
    scopeId: row.scope_id ? toString(row.scope_id) : null,
    period: toString(row.period) as BudgetRecord["period"],
    limitType: toString(row.limit_type) as BudgetRecord["limitType"],
    limitValue: Number(row.limit_value),
    warnThresholdPct: Number(row.warn_threshold_pct),
    action: toString(row.action) as BudgetRecord["action"],
    notifyChannel: row.notify_channel ? toString(row.notify_channel) : null,
    enabled: toNumber(row.enabled) === 1,
    createdBy: row.created_by ? toString(row.created_by) : null,
    createdAt: toString(row.created_at),
    updatedAt: toString(row.updated_at)
  };
}

function mapLogStreamDestinationRow(row: LogStreamDestinationRow): LogStreamDestinationRecord {
  return {
    id: toString(row.id),
    name: toString(row.name),
    type: toString(row.type),
    enabled: toNumber(row.enabled) === 1,
    categories: parseJsonArray(row.categories_json),
    minLevel: toString(row.min_level),
    configIv: row.config_iv ? toString(row.config_iv) : null,
    configAuthTag: row.config_auth_tag ? toString(row.config_auth_tag) : null,
    configCiphertext: row.config_ciphertext ? toString(row.config_ciphertext) : null,
    lastSuccessAt: row.last_success_at ? toString(row.last_success_at) : null,
    lastErrorAt: row.last_error_at ? toString(row.last_error_at) : null,
    lastError: row.last_error ? toString(row.last_error) : null,
    dispatchedCount: toNumber(row.dispatched_count),
    failedCount: toNumber(row.failed_count),
    createdBy: row.created_by ? toString(row.created_by) : null,
    createdAt: toString(row.created_at),
    updatedAt: toString(row.updated_at)
  };
}

// Phase 10.1 — MCP server registry
export type McpServerStatus = "unknown" | "healthy" | "degraded" | "down";

export interface McpServerRecord {
  id: string;
  name: string;
  description: string | null;
  adapterId: string;
  connection: Record<string, unknown>;
  secretId: string | null;
  owner: string | null;
  projectId: string | null;
  probeEnabled: boolean;
  /** null means the deployment default (MCP_PROBE_INTERVAL_MS). */
  probeIntervalMs: number | null;
  blockOnBreakingChange: boolean;
  status: McpServerStatus;
  lastProbeAt: string | null;
  lastProbeOk: boolean | null;
  lastProbeLatencyMs: number | null;
  lastProbeError: string | null;
  toolCount: number;
  currentSnapshotId: string | null;
  /** Set while a breaking schema change is waiting to be accepted. */
  pendingBreakingSnapshotId: string | null;
  /** Phase 10.5 — whether and how the server may ask the client to sample a model. */
  sampling: McpSamplingSettings;
  /** Phase 10.7 — the stdio sandbox; null means the deployment default (MCP_SANDBOX_DEFAULT). */
  sandbox: McpSandboxSettings | null;
  /** Phase 10.7 — what the last probe found out about the sandbox. */
  sandboxStatus: McpSandboxStatus | null;
  /** Phase 10.7 — rate limits, concurrency caps, timeouts and breaker settings (defaults filled in). */
  limits: McpRuntimeLimits;
  /** Phase 10.7 — `delegated`: each user connects their own OAuth account. */
  credentialMode: McpCredentialMode;
  /** Phase 10.7 — what unattended runs of a delegated server use. */
  delegatedFallback: McpDelegatedFallback;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Phase 10.7 — one user's OAuth connection to a delegated MCP server (no tokens). */
export interface McpUserOAuthConnectionRecord {
  serverId: string;
  userId: string;
  /** SecretService secret holding this user's tokens; never returned by the API. */
  secretId: string | null;
  state: McpOAuthConnectionState;
  subject: string | null;
  scope: string | null;
  authorizationServer: string | null;
  clientRegistration: "dynamic" | "pre_registered" | null;
  clientId: string | null;
  expiresAt: string | null;
  hasRefreshToken: boolean;
  lastRefreshAt: string | null;
  connectedAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

/** Phase 10.5 — what a server advertises beyond tools, captured by the last probe. */
export interface McpServerCatalogRecord extends McpServerCatalog {
  serverId: string;
}

/** Phase 10.5 — one `elicitation/create` request a tool call made during a run. */
export interface McpElicitationRecord extends McpElicitationView {
  /** User the run belongs to; only they (and operators) may answer. */
  createdBy: string | null;
  triggerType: string | null;
}

export interface McpServerProbeRecord {
  id: string;
  serverId: string;
  startedAt: string;
  ok: boolean;
  latencyMs: number;
  toolCount: number;
  error: string | null;
  snapshotId: string | null;
}

export interface McpToolSnapshotRecord {
  id: string;
  serverId: string;
  hash: string;
  tools: Array<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
    annotations?: McpToolAnnotations;
    /** Phase 10.5 — present only when the server declared one. */
    outputSchema?: Record<string, unknown>;
  }>;
  toolCount: number;
  previousSnapshotId: string | null;
  changes: Array<{ tool: string; kind: string; path?: string; schema?: "output"; breaking: boolean; detail: string }>;
  breaking: boolean;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  createdAt: string;
}

/** Phase 10.1 — one MCP tool call extracted from an execution's node results. */
export interface McpToolCallRecord {
  id: string;
  executionId: string;
  workflowId: string;
  nodeId: string;
  /** null for servers configured inline on a node rather than in the registry. */
  registryServerId: string | null;
  adapterId: string;
  toolName: string;
  startedAt: string;
  durationMs: number | null;
  ok: boolean;
  error: string | null;
  /** Share of the requesting agent turn's tokens; null when not attributable. */
  turnInputTokens: number | null;
  turnOutputTokens: number | null;
  /** null when no model price is known (or no model turn was involved). */
  estimatedCostUsd: number | null;
  /** Phase 10.5 — `sampling/createMessage` requests the server made during this call, and the tokens they used. */
  samplingRequests: number | null;
  samplingInputTokens: number | null;
  samplingOutputTokens: number | null;
  /**
   * Phase 10.4 — `workflow`: a call made by a node during a run.
   * `gateway`: a `tools/call` an MCP client sent to `/mcp/<toolset>`.
   * Phase 10.6 — `playground`: a call a builder made from the MCP playground.
   */
  source: McpToolCallSource;
  /** MCP client credential that made a gateway call. */
  clientId: string | null;
  /** Phase 10.7 — set when the call was refused before reaching the server (rate limit, concurrency cap, open breaker). */
  rejection?: McpRuntimeRejection | null;
  createdAt: string;
}

export type McpToolCallSource = "workflow" | "gateway" | "playground";

/** What callers write; `source` defaults to `workflow`. */
export type McpToolCallWrite = Omit<
  McpToolCallRecord,
  "createdAt" | "source" | "clientId" | "samplingRequests" | "samplingInputTokens" | "samplingOutputTokens" | "rejection"
> & {
  rejection?: McpRuntimeRejection | null;
  source?: McpToolCallSource;
  clientId?: string | null;
  samplingRequests?: number | null;
  samplingInputTokens?: number | null;
  samplingOutputTokens?: number | null;
};

/** Phase 10.4 — per-client usage rolled up from gateway telemetry rows. */
export interface McpClientUsageRow {
  clientId: string;
  calls: number;
  errors: number;
  lastCalledAt: string | null;
}

// Phase 10.4 — MCP gateway toolsets and client credentials.
interface McpToolsetRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  project_id: string | null;
  enabled: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface McpToolsetMemberRow {
  id: string;
  toolset_id: string;
  kind: string;
  workflow_id: string | null;
  server_id: string | null;
  tool_glob: string | null;
  position: number;
}

interface McpClientRow {
  id: string;
  name: string;
  token_prefix: string;
  token_hash: string;
  toolset_ids_json: string | null;
  role: string;
  created_by: string | null;
  created_by_email: string | null;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

/** A client row including the token hash; only the credential check reads the hash. */
export interface McpClientSecretRecord extends McpClient {
  tokenHash: string;
}

function mapMcpToolsetMember(row: McpToolsetMemberRow): McpToolsetMember | null {
  if (toString(row.kind) === "workflow" && row.workflow_id) {
    return { id: toString(row.id), kind: "workflow", workflowId: toString(row.workflow_id) };
  }
  if (toString(row.kind) === "server" && row.server_id) {
    return {
      id: toString(row.id),
      kind: "server",
      serverId: toString(row.server_id),
      toolGlob: row.tool_glob ? toString(row.tool_glob) : null
    };
  }
  return null;
}

function mapMcpToolset(row: McpToolsetRow, members: McpToolsetMember[]): McpToolset {
  return {
    id: toString(row.id),
    slug: toString(row.slug),
    name: toString(row.name),
    description: row.description ? toString(row.description) : null,
    projectId: row.project_id ? toString(row.project_id) : null,
    enabled: toNumber(row.enabled) === 1,
    members,
    createdBy: row.created_by ? toString(row.created_by) : null,
    createdAt: toString(row.created_at),
    updatedAt: toString(row.updated_at)
  };
}

function mapMcpClient(row: McpClientRow): McpClientSecretRecord {
  const toolsetIds = row.toolset_ids_json ? safeJsonParse(toString(row.toolset_ids_json)) : [];
  const role = toString(row.role) as McpPolicyRole;
  return {
    id: toString(row.id),
    name: toString(row.name),
    tokenPrefix: toString(row.token_prefix),
    tokenHash: toString(row.token_hash),
    toolsetIds: Array.isArray(toolsetIds) ? toolsetIds.filter((id): id is string => typeof id === "string") : [],
    role: MCP_POLICY_ROLES.includes(role) ? role : "viewer",
    createdBy: row.created_by ? toString(row.created_by) : null,
    createdByEmail: row.created_by_email ? toString(row.created_by_email) : null,
    expiresAt: row.expires_at ? toString(row.expires_at) : null,
    lastUsedAt: row.last_used_at ? toString(row.last_used_at) : null,
    revokedAt: row.revoked_at ? toString(row.revoked_at) : null,
    createdAt: toString(row.created_at)
  };
}

interface McpToolCallRow {
  id: string;
  execution_id: string;
  workflow_id: string;
  node_id: string;
  registry_server_id: string | null;
  adapter_id: string;
  tool_name: string;
  started_at: string;
  duration_ms: number | null;
  ok: number;
  error: string | null;
  turn_input_tokens: number | null;
  turn_output_tokens: number | null;
  estimated_cost_usd: number | null;
  sampling_requests?: number | null;
  sampling_input_tokens?: number | null;
  sampling_output_tokens?: number | null;
  source: string | null;
  client_id: string | null;
  rejection?: string | null;
  created_at: string;
}

// Phase 10.2 — MCP tool policy rows.
interface McpToolPolicyRow {
  id: string;
  name: string | null;
  description: string | null;
  effect: string;
  project_id: string | null;
  roles_json: string | null;
  server_id: string | null;
  tool_pattern: string;
  annotation_hint?: string | null;
  kind?: string | null;
  enabled: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function mapMcpToolPolicy(row: McpToolPolicyRow): McpToolPolicyRule {
  const hint = row.annotation_hint ? toString(row.annotation_hint) : null;
  const kind = row.kind ? toString(row.kind) : "tool";
  const roles = row.roles_json ? safeJsonParse(toString(row.roles_json)) : [];
  return {
    id: toString(row.id),
    name: row.name ? toString(row.name) : null,
    description: row.description ? toString(row.description) : null,
    effect: toString(row.effect) === "allow" ? "allow" : "deny",
    projectId: row.project_id ? toString(row.project_id) : null,
    roles: Array.isArray(roles)
      ? roles.filter((role): role is McpPolicyRole => MCP_POLICY_ROLES.includes(role as McpPolicyRole))
      : [],
    serverId: row.server_id ? toString(row.server_id) : null,
    toolPattern: toString(row.tool_pattern) || "*",
    annotationHint:
      hint && MCP_TOOL_HINT_CONDITIONS.includes(hint as McpToolHintCondition) ? (hint as McpToolHintCondition) : null,
    kind: MCP_POLICY_KINDS.includes(kind as McpPolicyKind) ? (kind as McpPolicyKind) : "tool",
    enabled: toNumber(row.enabled) === 1,
    createdBy: row.created_by ? toString(row.created_by) : null,
    createdAt: toString(row.created_at),
    updatedAt: toString(row.updated_at)
  };
}

export interface McpOAuthConnectionRecord {
  serverId: string;
  /** SecretService secret holding tokens and the client registration; never returned by the API. */
  secretId: string | null;
  state: McpOAuthConnectionState;
  subject: string | null;
  scope: string | null;
  authorizationServer: string | null;
  clientRegistration: "dynamic" | "pre_registered" | null;
  clientId: string | null;
  expiresAt: string | null;
  hasRefreshToken: boolean;
  lastRefreshAt: string | null;
  connectedAt: string | null;
  connectedBy: string | null;
  lastError: string | null;
  updatedAt: string;
}

interface McpOAuthConnectionRow {
  server_id: string;
  secret_id: string | null;
  state: string;
  subject: string | null;
  scope: string | null;
  authorization_server: string | null;
  client_registration: string | null;
  client_id: string | null;
  expires_at: string | null;
  has_refresh_token: number;
  last_refresh_at: string | null;
  connected_at: string | null;
  connected_by: string | null;
  last_error: string | null;
  updated_at: string;
}

const MCP_OAUTH_STATES: readonly McpOAuthConnectionState[] = ["not_connected", "connected", "expired", "error"];

/**
 * Phase 10.7 — a stored sandbox block. One that no longer validates is kept
 * as a container sandbox with what it had, so the launcher refuses it rather
 * than running the server unsandboxed.
 */
function readStoredSandbox(raw: string | null | undefined): McpSandboxSettings | null {
  if (!raw) return null;
  const parsed = safeJsonParse(toString(raw));
  if (!parsed || typeof parsed !== "object") return null;
  const normalized = normalizeMcpSandboxSettings(parsed);
  if (normalized) return normalized;
  const record = parsed as Record<string, unknown>;
  return record.mode === "none" ? { mode: "none" } : ({ ...record, mode: "container" } as McpSandboxSettings);
}

function mapMcpUserOAuthConnection(row: McpUserOAuthConnectionRow): McpUserOAuthConnectionRecord {
  const state = toString(row.state) as McpOAuthConnectionState;
  const registration = row.client_registration ? toString(row.client_registration) : null;
  const optional = (value: unknown) => (value === null || value === undefined || value === "" ? null : toString(value));
  return {
    serverId: toString(row.server_id),
    userId: toString(row.user_id),
    secretId: optional(row.secret_id),
    state: MCP_OAUTH_STATES.includes(state) ? state : "not_connected",
    subject: optional(row.subject),
    scope: optional(row.scope),
    authorizationServer: optional(row.authorization_server),
    clientRegistration: registration === "dynamic" || registration === "pre_registered" ? registration : null,
    clientId: optional(row.client_id),
    expiresAt: optional(row.expires_at),
    hasRefreshToken: toNumber(row.has_refresh_token) === 1,
    lastRefreshAt: optional(row.last_refresh_at),
    connectedAt: optional(row.connected_at),
    lastError: optional(row.last_error),
    updatedAt: toString(row.updated_at)
  };
}

function mapMcpOAuthConnection(row: McpOAuthConnectionRow): McpOAuthConnectionRecord {
  const state = toString(row.state) as McpOAuthConnectionState;
  const registration = row.client_registration ? toString(row.client_registration) : null;
  const optional = (value: unknown) => (value === null || value === undefined || value === "" ? null : toString(value));
  return {
    serverId: toString(row.server_id),
    secretId: optional(row.secret_id),
    state: MCP_OAUTH_STATES.includes(state) ? state : "not_connected",
    subject: optional(row.subject),
    scope: optional(row.scope),
    authorizationServer: optional(row.authorization_server),
    clientRegistration: registration === "dynamic" || registration === "pre_registered" ? registration : null,
    clientId: optional(row.client_id),
    expiresAt: optional(row.expires_at),
    hasRefreshToken: toNumber(row.has_refresh_token) === 1,
    lastRefreshAt: optional(row.last_refresh_at),
    connectedAt: optional(row.connected_at),
    connectedBy: optional(row.connected_by),
    lastError: optional(row.last_error),
    updatedAt: toString(row.updated_at)
  };
}

interface McpToolClassificationRow {
  server_id: string;
  tool_name: string;
  read_only: number;
  set_by: string | null;
  set_at: string;
}

function mapMcpToolClassification(row: McpToolClassificationRow): McpToolClassificationOverride {
  return {
    registryServerId: toString(row.server_id),
    toolName: toString(row.tool_name),
    readOnly: toNumber(row.read_only) === 1,
    setBy: row.set_by ? toString(row.set_by) : null,
    setAt: toString(row.set_at)
  };
}

function mapMcpToolCall(row: McpToolCallRow): McpToolCallRecord {
  return {
    id: toString(row.id),
    executionId: toString(row.execution_id),
    workflowId: toString(row.workflow_id),
    nodeId: toString(row.node_id),
    registryServerId: row.registry_server_id ? toString(row.registry_server_id) : null,
    adapterId: toString(row.adapter_id),
    toolName: toString(row.tool_name),
    startedAt: toString(row.started_at),
    durationMs: row.duration_ms === null ? null : toNumber(row.duration_ms),
    ok: toNumber(row.ok) === 1,
    error: row.error ? toString(row.error) : null,
    turnInputTokens: row.turn_input_tokens === null ? null : toNumber(row.turn_input_tokens),
    turnOutputTokens: row.turn_output_tokens === null ? null : toNumber(row.turn_output_tokens),
    estimatedCostUsd: row.estimated_cost_usd === null ? null : Number(row.estimated_cost_usd),
    samplingRequests: row.sampling_requests === null || row.sampling_requests === undefined ? null : toNumber(row.sampling_requests),
    samplingInputTokens:
      row.sampling_input_tokens === null || row.sampling_input_tokens === undefined ? null : toNumber(row.sampling_input_tokens),
    samplingOutputTokens:
      row.sampling_output_tokens === null || row.sampling_output_tokens === undefined ? null : toNumber(row.sampling_output_tokens),
    source: row.source === "gateway" || row.source === "playground" ? row.source : "workflow",
    clientId: row.client_id ? toString(row.client_id) : null,
    rejection:
      row.rejection === "rate_limited" || row.rejection === "concurrency_limited" || row.rejection === "circuit_open" ? row.rejection : null,
    createdAt: toString(row.created_at)
  };
}

interface McpServerRow {
  id: string;
  name: string;
  description: string | null;
  adapter_id: string;
  connection_json: string | null;
  secret_id: string | null;
  owner: string | null;
  project_id: string | null;
  probe_enabled: number;
  probe_interval_ms: number | null;
  block_on_breaking_change: number;
  status: string;
  last_probe_at: string | null;
  last_probe_ok: number | null;
  last_probe_latency_ms: number | null;
  last_probe_error: string | null;
  tool_count: number;
  current_snapshot_id: string | null;
  pending_breaking_snapshot_id: string | null;
  sampling_json?: string | null;
  sandbox_json?: string | null;
  sandbox_status_json?: string | null;
  limits_json?: string | null;
  credential_mode?: string | null;
  delegated_fallback?: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface McpUserOAuthConnectionRow {
  server_id: string;
  user_id: string;
  secret_id: string | null;
  state: string;
  subject: string | null;
  scope: string | null;
  authorization_server: string | null;
  client_registration: string | null;
  client_id: string | null;
  expires_at: string | null;
  has_refresh_token: number;
  last_refresh_at: string | null;
  connected_at: string | null;
  last_error: string | null;
  updated_at: string;
}

interface McpServerCatalogRow {
  server_id: string;
  capabilities_json: string | null;
  resources_json: string | null;
  resource_templates_json: string | null;
  prompts_json: string | null;
  updated_at: string;
}

interface McpElicitationRow {
  id: string;
  execution_id: string;
  workflow_id: string;
  workflow_name: string | null;
  node_id: string;
  server_id: string;
  registry_server_id: string | null;
  server_name: string | null;
  tool_name: string;
  message: string;
  schema_json: string;
  status: string;
  created_at: string;
  expires_at: string;
  answered_at: string | null;
  answered_by: string | null;
  reason: string | null;
  created_by: string | null;
  trigger_type: string | null;
}

const MCP_ELICITATION_STATUSES = new Set<McpElicitationStatus>(["pending", "accepted", "declined", "cancelled", "expired", "auto_declined"]);

/** Phase 10.5 — sampling settings as stored; unknown or partial JSON falls back to the defaults (off). */
export function normalizeMcpSamplingSettings(value: unknown): McpSamplingSettings {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const defaultModel =
    raw.defaultModel && typeof raw.defaultModel === "object" && !Array.isArray(raw.defaultModel)
      ? (raw.defaultModel as Record<string, unknown>)
      : null;
  const providerId = typeof defaultModel?.providerId === "string" ? defaultModel.providerId.trim() : "";
  const model = typeof defaultModel?.model === "string" ? defaultModel.model.trim() : "";
  const maxTokens = Number(raw.maxTokens);
  const maxRequests = Number(raw.maxRequestsPerCall);
  return {
    allow: raw.allow === true,
    maxTokens: Number.isFinite(maxTokens) && maxTokens >= 1 ? Math.floor(maxTokens) : DEFAULT_MCP_SAMPLING_SETTINGS.maxTokens,
    allowedModels: Array.isArray(raw.allowedModels)
      ? raw.allowedModels.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim())
      : [],
    maxRequestsPerCall:
      Number.isFinite(maxRequests) && maxRequests >= 0 ? Math.floor(maxRequests) : DEFAULT_MCP_SAMPLING_SETTINGS.maxRequestsPerCall,
    defaultModel: providerId && model ? { providerId, model } : null
  };
}

function mapMcpServerCatalog(row: McpServerCatalogRow): McpServerCatalogRecord {
  const parse = <T>(value: string | null, fallback: T): T => {
    if (!value) return fallback;
    const parsed = safeJsonParse(toString(value));
    return (parsed ?? fallback) as T;
  };
  return {
    serverId: toString(row.server_id),
    capabilities: parse<McpServerCapabilities>(row.capabilities_json, {}),
    resources: parse<McpResource[]>(row.resources_json, []),
    resourceTemplates: parse<McpResourceTemplate[]>(row.resource_templates_json, []),
    prompts: parse<McpPrompt[]>(row.prompts_json, []),
    updatedAt: toString(row.updated_at)
  };
}

function mapMcpElicitation(row: McpElicitationRow): McpElicitationRecord {
  const status = toString(row.status) as McpElicitationStatus;
  const schema = safeJsonParse(toString(row.schema_json)) as McpElicitationSchema | null;
  return {
    id: toString(row.id),
    executionId: toString(row.execution_id),
    workflowId: toString(row.workflow_id),
    ...(row.workflow_name ? { workflowName: toString(row.workflow_name) } : {}),
    nodeId: toString(row.node_id),
    serverId: toString(row.server_id),
    ...(row.registry_server_id ? { registryServerId: toString(row.registry_server_id) } : {}),
    ...(row.server_name ? { serverName: toString(row.server_name) } : {}),
    toolName: toString(row.tool_name),
    message: toString(row.message),
    requestedSchema: schema ?? { type: "object", properties: {} },
    status: MCP_ELICITATION_STATUSES.has(status) ? status : "pending",
    createdAt: toString(row.created_at),
    expiresAt: toString(row.expires_at),
    ...(row.answered_at ? { answeredAt: toString(row.answered_at) } : {}),
    ...(row.answered_by ? { answeredBy: toString(row.answered_by) } : {}),
    ...(row.reason ? { reason: toString(row.reason) } : {}),
    createdBy: row.created_by ? toString(row.created_by) : null,
    triggerType: row.trigger_type ? toString(row.trigger_type) : null
  };
}

interface McpServerProbeRow {
  id: string;
  server_id: string;
  started_at: string;
  ok: number;
  latency_ms: number;
  tool_count: number;
  error: string | null;
  snapshot_id: string | null;
}

interface McpToolSnapshotRow {
  id: string;
  server_id: string;
  hash: string;
  tools_json: string;
  tool_count: number;
  previous_snapshot_id: string | null;
  changes_json: string | null;
  breaking: number;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  created_at: string;
}

const MCP_SERVER_STATUSES = new Set<McpServerStatus>(["unknown", "healthy", "degraded", "down"]);

function mapMcpServer(row: McpServerRow): McpServerRecord {
  const status = toString(row.status) as McpServerStatus;
  return {
    id: toString(row.id),
    name: toString(row.name),
    description: row.description ? toString(row.description) : null,
    adapterId: toString(row.adapter_id),
    connection: row.connection_json
      ? (safeJsonParse(toString(row.connection_json)) as Record<string, unknown>) ?? {}
      : {},
    secretId: row.secret_id ? toString(row.secret_id) : null,
    owner: row.owner ? toString(row.owner) : null,
    projectId: row.project_id ? toString(row.project_id) : null,
    probeEnabled: toNumber(row.probe_enabled) === 1,
    probeIntervalMs: row.probe_interval_ms === null ? null : toNumber(row.probe_interval_ms),
    blockOnBreakingChange: toNumber(row.block_on_breaking_change) === 1,
    status: MCP_SERVER_STATUSES.has(status) ? status : "unknown",
    lastProbeAt: row.last_probe_at ? toString(row.last_probe_at) : null,
    lastProbeOk: row.last_probe_ok === null ? null : toNumber(row.last_probe_ok) === 1,
    lastProbeLatencyMs: row.last_probe_latency_ms === null ? null : toNumber(row.last_probe_latency_ms),
    lastProbeError: row.last_probe_error ? toString(row.last_probe_error) : null,
    toolCount: toNumber(row.tool_count),
    currentSnapshotId: row.current_snapshot_id ? toString(row.current_snapshot_id) : null,
    pendingBreakingSnapshotId: row.pending_breaking_snapshot_id ? toString(row.pending_breaking_snapshot_id) : null,
    sampling: normalizeMcpSamplingSettings(row.sampling_json ? safeJsonParse(toString(row.sampling_json)) : null),
    sandbox: readStoredSandbox(row.sandbox_json),
    sandboxStatus: row.sandbox_status_json ? ((safeJsonParse(toString(row.sandbox_status_json)) as McpSandboxStatus | null) ?? null) : null,
    limits: normalizeMcpRuntimeLimits(row.limits_json ? safeJsonParse(toString(row.limits_json)) : null),
    credentialMode: row.credential_mode === "delegated" ? "delegated" : "service",
    delegatedFallback: row.delegated_fallback === "owner" ? "owner" : "none",
    createdBy: row.created_by ? toString(row.created_by) : null,
    createdAt: toString(row.created_at),
    updatedAt: toString(row.updated_at)
  };
}

function mapMcpServerProbe(row: McpServerProbeRow): McpServerProbeRecord {
  return {
    id: toString(row.id),
    serverId: toString(row.server_id),
    startedAt: toString(row.started_at),
    ok: toNumber(row.ok) === 1,
    latencyMs: toNumber(row.latency_ms),
    toolCount: toNumber(row.tool_count),
    error: row.error ? toString(row.error) : null,
    snapshotId: row.snapshot_id ? toString(row.snapshot_id) : null
  };
}

function mapMcpToolSnapshot(row: McpToolSnapshotRow): McpToolSnapshotRecord {
  const tools = safeJsonParse(toString(row.tools_json));
  const changes = row.changes_json ? safeJsonParse(toString(row.changes_json)) : [];
  return {
    id: toString(row.id),
    serverId: toString(row.server_id),
    hash: toString(row.hash),
    tools: Array.isArray(tools) ? (tools as McpToolSnapshotRecord["tools"]) : [],
    toolCount: toNumber(row.tool_count),
    previousSnapshotId: row.previous_snapshot_id ? toString(row.previous_snapshot_id) : null,
    changes: Array.isArray(changes) ? (changes as McpToolSnapshotRecord["changes"]) : [],
    breaking: toNumber(row.breaking) === 1,
    acknowledgedAt: row.acknowledged_at ? toString(row.acknowledged_at) : null,
    acknowledgedBy: row.acknowledged_by ? toString(row.acknowledged_by) : null,
    createdAt: toString(row.created_at)
  };
}

// Phase 12.1 — Guard store records.
export type GuardBindingScope = "project" | "workflow";

export interface GuardProfileRecord {
  id: string;
  name: string;
  description: string | null;
  builtIn: boolean;
  latestVersion: number;
  latestHash: string;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

export interface GuardProfileVersionRecord {
  profileId: string;
  version: number;
  hash: string;
  document: Record<string, unknown>;
  note: string | null;
  createdAt: string;
  createdBy: string | null;
}

export interface GuardBindingRecord {
  scope: GuardBindingScope;
  scopeId: string;
  mode: string;
  profileId: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

export interface GuardEvidenceRecord {
  evidence: string;
  spans: Array<{ start: number; end: number }>;
  message: string;
}

export interface GuardEventInsert {
  id: string;
  verdictId: string;
  executionId: string;
  workflowId: string | null;
  projectId: string | null;
  nodeId: string;
  placement: string;
  iteration: number | null;
  toolName: string | null;
  channel: string;
  detectorId: string | null;
  category: string | null;
  dataClass: string | null;
  score: number | null;
  requestedAction: string;
  effectiveAction: string;
  verdictAction: string;
  shadow: boolean;
  evidence: GuardEvidenceRecord[];
  profileId: string;
  profileVersion: number;
  profileHash: string;
  latencyMs: number;
  budgetExceeded: boolean;
  skippedDetectors: string[];
  createdAt: string;
}

export type GuardEventRecord = GuardEventInsert;

export interface GuardEventFilters {
  executionId?: string;
  projectId?: string;
  workflowId?: string;
  /** Limits events to these workflows (the ones a non-admin can read); empty matches nothing. */
  workflowIds?: string[];
  profileId?: string;
  channel?: string;
  action?: string;
  since?: string;
  onlyFindings?: boolean;
}

export interface GuardEventStats {
  verdicts: Array<{ key: string; count: number }>;
  actions: Array<{ key: string; count: number }>;
  categories: Array<{ key: string; count: number }>;
  channels: Array<{ key: string; count: number }>;
  detectors: Array<{ key: string; count: number }>;
  shadowWouldBlock: number;
  shadowFindings: number;
  budgetExceeded: number;
  daily: Array<{ day: string; action: string; count: number }>;
}

/** Phase 11.1 — the cached run manifest of one execution (and the run context captured when it finished). */
/** Phase 15.1 — a stored golden run (JSON columns parsed). Values are already scrubbed. */
export interface ReplayRecordingRecord extends ReplayRecordingSummary {
  capturedWorkflow: Record<string, unknown>;
  input: unknown;
  nodes: Record<string, ReplayRecordedNode>;
  facts: RunFacts;
  mcpCassette: McpCassette | null;
}

export interface ReplayRecordingInsert {
  id: string;
  workflowId: string;
  projectId: string | null;
  name: string;
  notes: string | null;
  sourceExecutionId: string | null;
  sourceTriggerType: string | null;
  sourceStatus: string;
  workflowHash: string;
  workflowSavedVersion: number | null;
  capturedWorkflowJson: string;
  inputJson: string | null;
  nodeOutputsJson: string;
  factsJson: string;
  mcpCassetteJson: string | null;
  capabilities: ReplayRecordingCapabilities;
  bytes: number;
  truncated: boolean;
  createdAt: string;
  createdBy: string | null;
}

const REPLAY_RECORDING_SUMMARY_COLUMNS =
  "id, workflow_id, project_id, name, notes, source_execution_id, source_trigger_type, source_status, workflow_hash, workflow_saved_version, capabilities_json, bytes, truncated, created_at, created_by";

function mapReplayRecordingSummary(row: Record<string, unknown>): ReplayRecordingSummary {
  const capabilities = safeJsonParse(toString(row.capabilities_json)) as Partial<ReplayRecordingCapabilities> | null;
  return {
    id: toString(row.id),
    workflowId: toString(row.workflow_id),
    projectId: typeof row.project_id === "string" ? row.project_id : null,
    name: toString(row.name),
    notes: typeof row.notes === "string" ? row.notes : null,
    sourceExecutionId: typeof row.source_execution_id === "string" ? row.source_execution_id : null,
    sourceTriggerType: typeof row.source_trigger_type === "string" ? row.source_trigger_type : null,
    sourceStatus: toString(row.source_status),
    workflowHash: toString(row.workflow_hash),
    workflowSavedVersion: row.workflow_saved_version === null || row.workflow_saved_version === undefined ? null : toNumber(row.workflow_saved_version),
    capabilities: {
      mcp: capabilities?.mcp === "cassette" ? "cassette" : "none",
      models: "live",
      memory: "empty",
      workflowSource: capabilities?.workflowSource === "captured" ? "captured" : "current",
      ...(capabilities?.scrubbed && typeof capabilities.scrubbed === "object"
        ? {
            scrubbed: {
              input: capabilities.scrubbed.input === true,
              output: capabilities.scrubbed.output === true,
              nodes: Array.isArray(capabilities.scrubbed.nodes) ? capabilities.scrubbed.nodes.filter((id): id is string => typeof id === "string") : []
            }
          }
        : {})
    },
    bytes: toNumber(row.bytes),
    truncated: toNumber(row.truncated) === 1,
    createdAt: toString(row.created_at),
    createdBy: typeof row.created_by === "string" ? row.created_by : null
  };
}

export interface ExecutionManifestRecord {
  executionId: string;
  /** Captured when the run finished: the workflow as it ran and the MCP servers' identities. */
  runContext: unknown;
  /** Canonical manifest JSON; null until the manifest is first generated. */
  manifestJson: string | null;
  manifestDigest: string | null;
  keyId: string | null;
  signature: string | null;
  signedAt: string | null;
  createdAt: string;
}

/** Phase 11.1 — one deployment signing key. Only public material is stored here. */
export interface AuditSigningKeyRecord {
  keyId: string;
  algorithm: string;
  /** Base64 of the raw 32-byte Ed25519 public key. */
  publicKey: string;
  source: "env" | "generated";
  /** SecretService secret holding a generated private key; null for the env key and after rotation. */
  secretId: string | null;
  status: "active" | "retired";
  createdAt: string;
  retiredAt: string | null;
}

export interface GuardVaultRow {
  token: string;
  data_class: string;
  value_hash: string | null;
  value_sealed: string;
  created_at: string;
}

interface GuardProfileRow {
  id: unknown;
  name: unknown;
  description: unknown;
  built_in: unknown;
  latest_version: unknown;
  latest_hash: unknown;
  created_at: unknown;
  created_by: unknown;
  updated_at: unknown;
  updated_by: unknown;
}

interface GuardProfileVersionRow {
  profile_id: unknown;
  version: unknown;
  hash: unknown;
  document_json: unknown;
  note: unknown;
  created_at: unknown;
  created_by: unknown;
}

interface GuardBindingRow {
  scope: unknown;
  scope_id: unknown;
  mode: unknown;
  profile_id: unknown;
  updated_at: unknown;
  updated_by: unknown;
}

interface GuardEventRow {
  [column: string]: unknown;
}

const nullableText = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

function mapGuardProfileRow(row: GuardProfileRow): GuardProfileRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    description: nullableText(row.description),
    builtIn: Number(row.built_in) === 1,
    latestVersion: Number(row.latest_version),
    latestHash: String(row.latest_hash ?? ""),
    createdAt: String(row.created_at),
    createdBy: nullableText(row.created_by),
    updatedAt: String(row.updated_at),
    updatedBy: nullableText(row.updated_by)
  };
}

function mapGuardProfileVersionRow(row: GuardProfileVersionRow): GuardProfileVersionRecord {
  let document: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(row.document_json));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) document = parsed as Record<string, unknown>;
  } catch {
    document = {};
  }
  return {
    profileId: String(row.profile_id),
    version: Number(row.version),
    hash: String(row.hash),
    document,
    note: nullableText(row.note),
    createdAt: String(row.created_at),
    createdBy: nullableText(row.created_by)
  };
}

function mapGuardBindingRow(row: GuardBindingRow): GuardBindingRecord {
  return {
    scope: String(row.scope) === "workflow" ? "workflow" : "project",
    scopeId: String(row.scope_id),
    mode: String(row.mode),
    profileId: nullableText(row.profile_id),
    updatedAt: String(row.updated_at),
    updatedBy: nullableText(row.updated_by)
  };
}

function parseJsonList<T>(raw: unknown): T[] {
  try {
    const parsed = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function mapGuardEventRow(row: GuardEventRow): GuardEventRecord {
  return {
    id: String(row.id),
    verdictId: String(row.verdict_id),
    executionId: String(row.execution_id),
    workflowId: nullableText(row.workflow_id),
    projectId: nullableText(row.project_id),
    nodeId: String(row.node_id),
    placement: String(row.placement),
    iteration: row.iteration === null || row.iteration === undefined ? null : Number(row.iteration),
    toolName: nullableText(row.tool_name),
    channel: String(row.channel),
    detectorId: nullableText(row.detector_id),
    category: nullableText(row.category),
    dataClass: nullableText(row.data_class),
    score: row.score === null || row.score === undefined ? null : Number(row.score),
    requestedAction: String(row.requested_action),
    effectiveAction: String(row.effective_action),
    verdictAction: String(row.verdict_action),
    shadow: Number(row.shadow) === 1,
    evidence: parseJsonList<GuardEvidenceRecord>(row.evidence_json),
    profileId: String(row.profile_id),
    profileVersion: Number(row.profile_version),
    profileHash: String(row.profile_hash),
    latencyMs: Number(row.latency_ms ?? 0),
    budgetExceeded: Number(row.budget_exceeded) === 1,
    skippedDetectors: parseJsonList<string>(row.skipped_detectors_json),
    createdAt: String(row.created_at)
  };
}

function toString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function toNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

// Phase 8.4 — audit-log hash chain helpers.
// canonicalAuditPayload: stable, key-ordered JSON serialization. Same input
// must yield byte-identical output across processes and Node versions.
function canonicalAuditPayload(input: {
  id: string;
  createdAt: string;
  eventType: string;
  category: string;
  action: string;
  outcome: string;
  actorUserId: string | null;
  actorEmail: string | null;
  actorType: string;
  resourceType: string | null;
  resourceId: string | null;
  projectId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadataJson: string | null;
  message: string | null;
}): string {
  // Explicit field ordering — do NOT sort, so adding fields in future
  // versions doesn't silently break the chain. New fields go at the end.
  return JSON.stringify([
    input.id,
    input.createdAt,
    input.eventType,
    input.category,
    input.action,
    input.outcome,
    input.actorUserId,
    input.actorEmail,
    input.actorType,
    input.resourceType,
    input.resourceId,
    input.projectId,
    input.ipAddress,
    input.userAgent,
    input.metadataJson,
    input.message
  ]);
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Phase 9.3 — Build a defensive FTS5 MATCH expression from a user query.
 *
 * FTS5 has its own query syntax (AND/OR/NOT, NEAR, prefix `*`, phrase `"..."`)
 * which trips up on user input containing colons, parens, or quotes. We
 * tokenize on non-alphanumerics, drop noise tokens (length <2), and wrap
 * each surviving token as a quoted phrase so FTS5 treats user content as
 * literal text — never operators. Tokens are OR'd so any one match returns
 * the row (BM25 then ranks within that set).
 */
function buildFts5Query(userQuery: string): string {
  const tokens = userQuery
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

function parseJsonArray(raw: unknown): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(typeof raw === "string" ? raw : String(raw));
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === "string");
    }
  } catch {
    // fall through
  }
  return [];
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(typeof raw === "string" ? raw : String(raw));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}

function toDurationMsForStore(startedAt: string, completedAt: string): number | null {
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed)) {
    return null;
  }
  return Math.max(0, Math.floor(completed - started));
}

function parseJsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(toString(value));
  } catch {
    return null;
  }
}

function parseTagsJson(value: unknown): string[] | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = parseJsonSafe(value);
  if (!Array.isArray(parsed)) return undefined;
  const tags = parsed.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0);
  return tags.length > 0 ? tags : [];
}

const MAX_SESSION_TOOL_CACHE_RECORDS = 400;

// Phase 10.8 — MCP cassettes
interface McpCassetteRow {
  id: string;
  execution_id: string | null;
  workflow_id: string | null;
  workflow_name: string | null;
  project_id: string | null;
  source: string;
  eval_run_id: string | null;
  fixture_id: string | null;
  call_count: number;
  server_count: number;
  bytes: number;
  truncated: number;
  cassette_json?: string;
  created_at: string;
  created_by: string | null;
}

const MCP_CASSETTE_SOURCES: readonly McpCassetteSource[] = ["manual", "eval", "replay", "import"];

function mapMcpCassetteSummary(row: McpCassetteRow): McpCassetteSummary {
  const source = MCP_CASSETTE_SOURCES.includes(row.source as McpCassetteSource) ? (row.source as McpCassetteSource) : "manual";
  return {
    id: toString(row.id),
    executionId: row.execution_id ? toString(row.execution_id) : null,
    workflowId: row.workflow_id ? toString(row.workflow_id) : null,
    workflowName: row.workflow_name ? toString(row.workflow_name) : null,
    projectId: row.project_id ? toString(row.project_id) : null,
    source,
    evalRunId: row.eval_run_id ? toString(row.eval_run_id) : null,
    fixtureId: row.fixture_id ? toString(row.fixture_id) : null,
    callCount: toNumber(row.call_count),
    serverCount: toNumber(row.server_count),
    bytes: toNumber(row.bytes),
    truncated: toNumber(row.truncated) === 1,
    createdAt: toString(row.created_at),
    createdBy: row.created_by ? toString(row.created_by) : null
  };
}

const MCP_CASSETTE_SUMMARY_COLUMNS =
  "id, execution_id, workflow_id, workflow_name, project_id, source, eval_run_id, fixture_id, call_count, server_count, bytes, truncated, created_at, created_by";

export class SqliteStore {
  private closed = false;

  private constructor(private readonly db: BetterSqlite3Database) {
    // Pragmas tuned for typical web-app workloads: WAL gives concurrent reads
    // during writes, NORMAL synchronous is durable across app crashes (only
    // OS-level crashes can lose the last commit), and foreign_keys is on by
    // default in our schema design.
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  /** Phase 10.7 — where the database lives (a file path, or ":memory:"); names this deployment's sandbox containers. */
  storageLocation(): string {
    return this.db.name;
  }

  static async create(dbFilePath: string): Promise<SqliteStore> {
    const absolutePath = path.resolve(dbFilePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    const db = new Database(absolutePath);
    return new SqliteStore(db);
  }

  private migrate(): void {
    this.exec(`
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        workflow_version INTEGER NOT NULL,
        workflow_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS secrets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_memory (
        namespace TEXT NOT NULL,
        session_id TEXT NOT NULL,
        messages_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (namespace, session_id)
      );

      CREATE TABLE IF NOT EXISTS session_tool_cache (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        session_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        tool_call_id TEXT,
        args_json TEXT NOT NULL,
        output_json TEXT NOT NULL,
        error TEXT,
        summary_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_tool_cache_namespace_session_created_at
      ON session_tool_cache(namespace, session_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_session_tool_cache_tool_name
      ON session_tool_cache(tool_name);

      CREATE TABLE IF NOT EXISTS session_artifacts (
        namespace TEXT NOT NULL,
        session_id TEXT NOT NULL,
        artifact_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (namespace, session_id, artifact_key)
      );

      CREATE INDEX IF NOT EXISTS idx_session_artifacts_namespace_session_updated_at
      ON session_artifacts(namespace, session_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        revoked_at TEXT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS webhook_replay_keys (
        replay_key TEXT PRIMARY KEY,
        endpoint_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_webhook_replay_expires_at
      ON webhook_replay_keys(expires_at);

      CREATE TABLE IF NOT EXISTS webhook_idempotency (
        endpoint_key TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (endpoint_key, idempotency_key)
      );

      CREATE INDEX IF NOT EXISTS idx_webhook_idempotency_expires_at
      ON webhook_idempotency(expires_at);

      CREATE TABLE IF NOT EXISTS execution_history (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        workflow_name TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        duration_ms INTEGER,
        trigger_type TEXT,
        triggered_by TEXT,
        input_json TEXT,
        output_json TEXT,
        node_results_json TEXT,
        custom_data_json TEXT,
        error TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_execution_history_started_at
      ON execution_history(started_at DESC);

      CREATE TABLE IF NOT EXISTS workflow_executions (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        workflow_name TEXT,
        status TEXT NOT NULL,
        waiting_node_id TEXT NOT NULL,
        approval_message TEXT,
        timeout_minutes INTEGER,
        trigger_type TEXT,
        triggered_by TEXT,
        started_at TEXT NOT NULL,
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_workflow_executions_status
      ON workflow_executions(status);

      CREATE TABLE IF NOT EXISTS execution_queue (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        workflow_name TEXT,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        priority INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        last_error TEXT,
        scheduled_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_execution_queue_status_scheduled
      ON execution_queue(status, scheduled_at);

      CREATE TABLE IF NOT EXISTS execution_queue_dlq (
        id TEXT PRIMARY KEY,
        original_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        workflow_name TEXT,
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        final_error TEXT NOT NULL,
        failed_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      -- Phase 3.5 trigger state
      CREATE TABLE IF NOT EXISTS trigger_state (
        workflow_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        trigger_type TEXT NOT NULL,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workflow_id, node_id)
      );

      -- Phase 4.2 organization tables
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS folders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        parent_id TEXT,
        project_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_folders_project_id ON folders(project_id);
      CREATE INDEX IF NOT EXISTS idx_folders_parent_id ON folders(parent_id);

      -- Phase 5.1/5.2 enterprise auth + RBAC tables
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        scopes_json TEXT NOT NULL DEFAULT '[]',
        last_used_at TEXT,
        expires_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
      CREATE INDEX IF NOT EXISTS idx_api_keys_key_prefix ON api_keys(key_prefix);

      CREATE TABLE IF NOT EXISTS mfa_secrets (
        user_id TEXT PRIMARY KEY,
        secret_iv TEXT NOT NULL,
        secret_auth_tag TEXT NOT NULL,
        secret_ciphertext TEXT NOT NULL,
        backup_codes_json TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 0,
        activated_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sso_identities (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        subject TEXT NOT NULL,
        email TEXT,
        attributes_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(provider, subject)
      );

      CREATE INDEX IF NOT EXISTS idx_sso_identities_user_id ON sso_identities(user_id);

      CREATE TABLE IF NOT EXISTS user_project_roles (
        user_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        role TEXT NOT NULL,
        custom_role_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, project_id)
      );

      CREATE INDEX IF NOT EXISTS idx_user_project_roles_project_id ON user_project_roles(project_id);

      CREATE TABLE IF NOT EXISTS custom_roles (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        name TEXT NOT NULL,
        description TEXT,
        permissions_json TEXT NOT NULL DEFAULT '[]',
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_custom_roles_project_id ON custom_roles(project_id);

      CREATE TABLE IF NOT EXISTS workflow_shares (
        workflow_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        access_level TEXT NOT NULL DEFAULT 'read',
        shared_by TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workflow_id, project_id)
      );

      CREATE INDEX IF NOT EXISTS idx_workflow_shares_project_id ON workflow_shares(project_id);

      CREATE TABLE IF NOT EXISTS secret_shares (
        secret_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        shared_by TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (secret_id, project_id)
      );

      CREATE INDEX IF NOT EXISTS idx_secret_shares_project_id ON secret_shares(project_id);

      CREATE TABLE IF NOT EXISTS sso_group_mappings (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        group_name TEXT NOT NULL,
        project_id TEXT,
        role TEXT NOT NULL,
        custom_role_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sso_group_mappings_provider_group ON sso_group_mappings(provider, group_name);

      -- Phase 5.3/5.4 external secrets + audit log tables
      CREATE TABLE IF NOT EXISTS external_secret_providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        config_json TEXT NOT NULL DEFAULT '{}',
        credentials_secret_id TEXT,
        cache_ttl_ms INTEGER NOT NULL DEFAULT 300000,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_external_secret_providers_type ON external_secret_providers(type);

      CREATE TABLE IF NOT EXISTS external_secret_cache (
        secret_id TEXT PRIMARY KEY,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_external_secret_cache_expires_at ON external_secret_cache(expires_at);

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        category TEXT NOT NULL,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL,
        actor_user_id TEXT,
        actor_email TEXT,
        actor_type TEXT NOT NULL DEFAULT 'user',
        resource_type TEXT,
        resource_id TEXT,
        project_id TEXT,
        ip_address TEXT,
        user_agent TEXT,
        metadata_json TEXT,
        message TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_category ON audit_logs(category);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_user_id ON audit_logs(actor_user_id);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_resource_type ON audit_logs(resource_type);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_outcome ON audit_logs(outcome);

      -- Phase 5.5 log streaming tables
      CREATE TABLE IF NOT EXISTS log_stream_destinations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        categories_json TEXT NOT NULL DEFAULT '[]',
        min_level TEXT NOT NULL DEFAULT 'info',
        config_iv TEXT,
        config_auth_tag TEXT,
        config_ciphertext TEXT,
        last_success_at TEXT,
        last_error_at TEXT,
        last_error TEXT,
        dispatched_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_log_stream_destinations_type ON log_stream_destinations(type);
      CREATE INDEX IF NOT EXISTS idx_log_stream_destinations_enabled ON log_stream_destinations(enabled);

      CREATE TABLE IF NOT EXISTS log_stream_events (
        id TEXT PRIMARY KEY,
        destination_id TEXT NOT NULL,
        category TEXT NOT NULL,
        event_type TEXT NOT NULL,
        level TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        payload_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_log_stream_events_destination_created
        ON log_stream_events(destination_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_log_stream_events_status ON log_stream_events(status);
      CREATE INDEX IF NOT EXISTS idx_log_stream_events_created_at ON log_stream_events(created_at);

      -- Phase 5.6 version control & environments
      CREATE TABLE IF NOT EXISTS variables (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, key)
      );

      CREATE INDEX IF NOT EXISTS idx_variables_project_id ON variables(project_id);

      CREATE TABLE IF NOT EXISTS workflow_versions (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        workflow_json TEXT NOT NULL,
        created_by TEXT,
        change_note TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(workflow_id, version)
      );

      CREATE INDEX IF NOT EXISTS idx_workflow_versions_workflow_created
        ON workflow_versions(workflow_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS git_configs (
        id TEXT PRIMARY KEY,
        repo_url TEXT NOT NULL,
        default_branch TEXT NOT NULL DEFAULT 'main',
        auth_secret_id TEXT,
        workflows_dir TEXT NOT NULL DEFAULT 'workflows',
        variables_file TEXT NOT NULL DEFAULT 'variables.json',
        user_name TEXT NOT NULL DEFAULT 'ai-orchestrator',
        user_email TEXT NOT NULL DEFAULT 'sync@ai-orchestrator.local',
        enabled INTEGER NOT NULL DEFAULT 1,
        last_push_at TEXT,
        last_pull_at TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );

      -- Phase 7.1 multi-main HA leader leases
      CREATE TABLE IF NOT EXISTS leader_leases (
        lease_name TEXT PRIMARY KEY,
        holder_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        renewed_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_leader_leases_expires_at ON leader_leases(expires_at);

      CREATE TABLE IF NOT EXISTS workflow_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT 'General',
        tags TEXT NOT NULL DEFAULT '[]',
        author TEXT NOT NULL DEFAULT 'ai-orchestrator',
        workflow_json TEXT NOT NULL,
        node_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_workflow_templates_category ON workflow_templates(category);

      CREATE TABLE IF NOT EXISTS notification_configs (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        config_json TEXT NOT NULL DEFAULT '{}',
        events TEXT NOT NULL DEFAULT '["execution.failure"]',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Phase 7.3 — Agent eval framework
      CREATE TABLE IF NOT EXISTS eval_datasets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        project_id TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_eval_datasets_project ON eval_datasets(project_id);

      CREATE TABLE IF NOT EXISTS eval_fixtures (
        id TEXT PRIMARY KEY,
        dataset_id TEXT NOT NULL,
        name TEXT NOT NULL,
        input_json TEXT NOT NULL,
        expected_json TEXT,
        scorers_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_eval_fixtures_dataset ON eval_fixtures(dataset_id);

      CREATE TABLE IF NOT EXISTS eval_runs (
        id TEXT PRIMARY KEY,
        dataset_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        workflow_name TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        triggered_by TEXT,
        scorers_json TEXT,
        summary_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_eval_runs_dataset ON eval_runs(dataset_id);
      CREATE INDEX IF NOT EXISTS idx_eval_runs_workflow ON eval_runs(workflow_id);
      CREATE INDEX IF NOT EXISTS idx_eval_runs_started_at ON eval_runs(started_at DESC);

      CREATE TABLE IF NOT EXISTS eval_results (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        fixture_id TEXT NOT NULL,
        fixture_name TEXT,
        status TEXT NOT NULL,
        execution_id TEXT,
        score_json TEXT,
        output_json TEXT,
        error TEXT,
        duration_ms INTEGER,
        token_input INTEGER,
        token_output INTEGER,
        token_total INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_eval_results_run ON eval_results(run_id);
      CREATE INDEX IF NOT EXISTS idx_eval_results_fixture ON eval_results(fixture_id);

      -- Phase 8.2 — usage_events (FinOps cost rollups)
      CREATE TABLE IF NOT EXISTS usage_events (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        workflow_name TEXT,
        user_id TEXT,
        user_email TEXT,
        project_id TEXT,
        trigger_type TEXT,
        status TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        llm_call_count INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        providers_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_usage_events_created_at ON usage_events(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_usage_events_workflow_created ON usage_events(workflow_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_usage_events_user_created ON usage_events(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_usage_events_project_created ON usage_events(project_id, created_at DESC);

      -- Phase 8.3 — budgets + budget_alerts
      CREATE TABLE IF NOT EXISTS budgets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        scope_type TEXT NOT NULL,
        scope_id TEXT,
        period TEXT NOT NULL,
        limit_type TEXT NOT NULL,
        limit_value REAL NOT NULL,
        warn_threshold_pct REAL NOT NULL DEFAULT 0.8,
        action TEXT NOT NULL,
        notify_channel TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_by TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_budgets_scope ON budgets(scope_type, scope_id);
      CREATE INDEX IF NOT EXISTS idx_budgets_enabled ON budgets(enabled);

      CREATE TABLE IF NOT EXISTS budget_alerts (
        id TEXT PRIMARY KEY,
        budget_id TEXT NOT NULL,
        period_start TEXT NOT NULL,
        severity TEXT NOT NULL,
        usage_value REAL NOT NULL,
        limit_value REAL NOT NULL,
        workflow_id TEXT,
        execution_id TEXT,
        message TEXT,
        fired_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_budget_alerts_budget ON budget_alerts(budget_id);
      CREATE INDEX IF NOT EXISTS idx_budget_alerts_fired_at ON budget_alerts(fired_at DESC);

      -- Phase 8.4 — audit export destinations
      CREATE TABLE IF NOT EXISTS audit_export_destinations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        config_json TEXT NOT NULL,
        interval_seconds INTEGER NOT NULL DEFAULT 3600,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_export_id TEXT,
        last_export_at TEXT,
        last_status TEXT,
        last_error TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_audit_export_destinations_enabled ON audit_export_destinations(enabled);

      CREATE TABLE IF NOT EXISTS audit_export_runs (
        id TEXT PRIMARY KEY,
        destination_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT NOT NULL,
        rows_exported INTEGER NOT NULL DEFAULT 0,
        first_id TEXT,
        last_id TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_export_runs_dest ON audit_export_runs(destination_id, started_at DESC);
    `);

    // Phase 8.4 — audit chain columns (idempotent ADD COLUMN)
    this.ensureColumn("audit_logs", "prev_hash", "TEXT");
    this.ensureColumn("audit_logs", "entry_hash", "TEXT");

    // Phase 9.1 — built-in persistent vector store
    this.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_bases (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        project_id TEXT,
        embedder_id TEXT NOT NULL,
        embedder_config_json TEXT,
        dimensions INTEGER NOT NULL DEFAULT 0,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        created_by TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_bases_project ON knowledge_bases(project_id);

      CREATE TABLE IF NOT EXISTS knowledge_base_chunks (
        id TEXT PRIMARY KEY,
        knowledge_base_id TEXT NOT NULL,
        source_id TEXT,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        metadata_json TEXT,
        vector_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_kb_chunks_kb_id ON knowledge_base_chunks(knowledge_base_id);
      CREATE INDEX IF NOT EXISTS idx_kb_chunks_source ON knowledge_base_chunks(knowledge_base_id, source_id);

      -- Phase 9.3 — FTS5 BM25 index over knowledge_base_chunks for hybrid search
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_base_chunks_fts USING fts5(
        content,
        kb_id UNINDEXED,
        content='knowledge_base_chunks',
        content_rowid='rowid',
        tokenize='porter unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS kb_chunks_fts_ai AFTER INSERT ON knowledge_base_chunks BEGIN
        INSERT INTO knowledge_base_chunks_fts(rowid, content, kb_id)
        VALUES (new.rowid, new.content, new.knowledge_base_id);
      END;

      CREATE TRIGGER IF NOT EXISTS kb_chunks_fts_ad AFTER DELETE ON knowledge_base_chunks BEGIN
        INSERT INTO knowledge_base_chunks_fts(knowledge_base_chunks_fts, rowid, content, kb_id)
        VALUES('delete', old.rowid, old.content, old.knowledge_base_id);
      END;

      CREATE TRIGGER IF NOT EXISTS kb_chunks_fts_au AFTER UPDATE ON knowledge_base_chunks BEGIN
        INSERT INTO knowledge_base_chunks_fts(knowledge_base_chunks_fts, rowid, content, kb_id)
        VALUES('delete', old.rowid, old.content, old.knowledge_base_id);
        INSERT INTO knowledge_base_chunks_fts(rowid, content, kb_id)
        VALUES (new.rowid, new.content, new.knowledge_base_id);
      END;
    `);

    // Phase 10.1 — MCP server registry
    this.exec(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        adapter_id TEXT NOT NULL,
        connection_json TEXT,
        secret_id TEXT,
        owner TEXT,
        project_id TEXT,
        probe_enabled INTEGER NOT NULL DEFAULT 1,
        probe_interval_ms INTEGER,
        block_on_breaking_change INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'unknown',
        last_probe_at TEXT,
        last_probe_ok INTEGER,
        last_probe_latency_ms INTEGER,
        last_probe_error TEXT,
        tool_count INTEGER NOT NULL DEFAULT 0,
        current_snapshot_id TEXT,
        pending_breaking_snapshot_id TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_servers_project ON mcp_servers(project_id);

      CREATE TABLE IF NOT EXISTS mcp_server_probes (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ok INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        tool_count INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        snapshot_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_server_probes_server ON mcp_server_probes(server_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS mcp_tool_snapshots (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        hash TEXT NOT NULL,
        tools_json TEXT NOT NULL,
        tool_count INTEGER NOT NULL DEFAULT 0,
        previous_snapshot_id TEXT,
        changes_json TEXT,
        breaking INTEGER NOT NULL DEFAULT 0,
        acknowledged_at TEXT,
        acknowledged_by TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_tool_snapshots_server ON mcp_tool_snapshots(server_id, created_at DESC);
    `);

    // Phase 10.1 — per-tool-call telemetry extracted from execution traces.
    this.ensureMcpToolCallsTable();

    // Phase 10.2 — MCP tool policy rules and admin read-only overrides.
    this.exec(`
      CREATE TABLE IF NOT EXISTS mcp_tool_policies (
        id TEXT PRIMARY KEY,
        name TEXT,
        description TEXT,
        effect TEXT NOT NULL,
        project_id TEXT,
        roles_json TEXT NOT NULL DEFAULT '[]',
        server_id TEXT,
        tool_pattern TEXT NOT NULL DEFAULT '*',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mcp_tool_classifications (
        server_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        read_only INTEGER NOT NULL,
        set_by TEXT,
        set_at TEXT NOT NULL,
        PRIMARY KEY (server_id, tool_name)
      );
    `);
    this.ensureWorkflowCreatedByColumn();
    // Phase 10.5 — rules can require an annotation hint (destructive, read-only, ...).
    this.ensureColumn("mcp_tool_policies", "annotation_hint", "TEXT");
    // Phase 10.5 — rules target tools, resources, prompts or sampling.
    this.ensureColumn("mcp_tool_policies", "kind", "TEXT NOT NULL", "'tool'");
    // Phase 10.5 — per-server sampling settings (off unless an admin turns it on).
    this.ensureColumn("mcp_servers", "sampling_json", "TEXT");
    // Phase 10.7 — runtime safety: sandbox, limits, credential mode.
    this.ensureColumn("mcp_servers", "sandbox_json", "TEXT");
    this.ensureColumn("mcp_servers", "sandbox_status_json", "TEXT");
    this.ensureColumn("mcp_servers", "limits_json", "TEXT");
    this.ensureColumn("mcp_servers", "credential_mode", "TEXT NOT NULL", "'service'");
    this.ensureColumn("mcp_servers", "delegated_fallback", "TEXT NOT NULL", "'none'");

    // Phase 10.5 — resources, resource templates and prompts a server
    // advertises (captured by probes, informational: not part of the tool hash),
    // and elicitation requests waiting for a person.
    this.exec(`
      CREATE TABLE IF NOT EXISTS mcp_server_catalogs (
        server_id TEXT PRIMARY KEY,
        capabilities_json TEXT,
        resources_json TEXT,
        resource_templates_json TEXT,
        prompts_json TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mcp_elicitations (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        workflow_name TEXT,
        node_id TEXT NOT NULL,
        server_id TEXT NOT NULL,
        registry_server_id TEXT,
        server_name TEXT,
        tool_name TEXT NOT NULL,
        message TEXT NOT NULL,
        schema_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        answered_at TEXT,
        answered_by TEXT,
        reason TEXT,
        created_by TEXT,
        trigger_type TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_elicitations_status ON mcp_elicitations(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mcp_elicitations_execution ON mcp_elicitations(execution_id);
    `);

    // Phase 10.5 — OAuth connections to remote MCP servers. Tokens and client
    // secrets live only in the SecretService secret `secret_id` names; this
    // row holds what the UI may show.
    this.exec(`
      CREATE TABLE IF NOT EXISTS mcp_oauth_connections (
        server_id TEXT PRIMARY KEY,
        secret_id TEXT,
        state TEXT NOT NULL DEFAULT 'not_connected',
        subject TEXT,
        scope TEXT,
        authorization_server TEXT,
        client_registration TEXT,
        client_id TEXT,
        expires_at TEXT,
        has_refresh_token INTEGER NOT NULL DEFAULT 0,
        last_refresh_at TEXT,
        connected_at TEXT,
        connected_by TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );
    `);

    // Phase 10.4 — MCP gateway: toolsets, their members, client credentials,
    // and the source / client of each telemetry row.
    this.exec(`
      CREATE TABLE IF NOT EXISTS mcp_toolsets (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT,
        project_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mcp_toolset_members (
        id TEXT PRIMARY KEY,
        toolset_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        workflow_id TEXT,
        server_id TEXT,
        tool_glob TEXT,
        position INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_toolset_members_toolset ON mcp_toolset_members(toolset_id, position);

      CREATE TABLE IF NOT EXISTS mcp_clients (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_prefix TEXT NOT NULL UNIQUE,
        token_hash TEXT NOT NULL,
        toolset_ids_json TEXT NOT NULL DEFAULT '[]',
        role TEXT NOT NULL,
        created_by TEXT,
        created_by_email TEXT,
        expires_at TEXT,
        last_used_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );
    `);
    this.ensureColumn("mcp_tool_calls", "source", "TEXT NOT NULL", "'workflow'");
    this.ensureColumn("mcp_tool_calls", "client_id", "TEXT");
    // Phase 10.5 — sampling requests a tool call triggered, and their tokens.
    this.ensureColumn("mcp_tool_calls", "sampling_requests", "INTEGER");
    this.ensureColumn("mcp_tool_calls", "sampling_input_tokens", "INTEGER");
    this.ensureColumn("mcp_tool_calls", "sampling_output_tokens", "INTEGER");
    this.exec(`CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_client ON mcp_tool_calls(client_id, started_at)`);
    // Phase 10.7 — calls refused before reaching the server, and per-user OAuth connections
    // to delegated servers (tokens only in the SecretService secret `secret_id` names).
    this.ensureColumn("mcp_tool_calls", "rejection", "TEXT");
    this.exec(`
      CREATE TABLE IF NOT EXISTS mcp_user_oauth_connections (
        server_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        secret_id TEXT,
        state TEXT NOT NULL DEFAULT 'not_connected',
        subject TEXT,
        scope TEXT,
        authorization_server TEXT,
        client_registration TEXT,
        client_id TEXT,
        expires_at TEXT,
        has_refresh_token INTEGER NOT NULL DEFAULT 0,
        last_refresh_at TEXT,
        connected_at TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (server_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_user_oauth_user ON mcp_user_oauth_connections(user_id);
    `);

    // Phase 10.8 — MCP cassettes: every MCP call of a recorded run, scrubbed
    // of secrets before it is written, linked to the execution.
    this.exec(`
      CREATE TABLE IF NOT EXISTS mcp_cassettes (
        id TEXT PRIMARY KEY,
        execution_id TEXT,
        workflow_id TEXT,
        workflow_name TEXT,
        project_id TEXT,
        source TEXT NOT NULL DEFAULT 'manual',
        eval_run_id TEXT,
        fixture_id TEXT,
        call_count INTEGER NOT NULL DEFAULT 0,
        server_count INTEGER NOT NULL DEFAULT 0,
        bytes INTEGER NOT NULL DEFAULT 0,
        truncated INTEGER NOT NULL DEFAULT 0,
        cassette_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_cassettes_execution ON mcp_cassettes(execution_id);
      CREATE INDEX IF NOT EXISTS idx_mcp_cassettes_eval ON mcp_cassettes(eval_run_id, fixture_id);
      CREATE INDEX IF NOT EXISTS idx_mcp_cassettes_created ON mcp_cassettes(created_at DESC);
    `);

    // Phase 12.1 — Guard wiring: versioned profiles, project and workflow
    // bindings, verdict events (masked evidence only) and the token vault
    // (values sealed with the master key).
    this.exec(`
      CREATE TABLE IF NOT EXISTS guard_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        built_in INTEGER NOT NULL DEFAULT 0,
        latest_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        created_by TEXT,
        updated_at TEXT NOT NULL,
        updated_by TEXT
      );
      CREATE TABLE IF NOT EXISTS guard_profile_versions (
        profile_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        hash TEXT NOT NULL,
        document_json TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL,
        created_by TEXT,
        PRIMARY KEY (profile_id, version)
      );
      CREATE TABLE IF NOT EXISTS guard_bindings (
        scope TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'inherit',
        profile_id TEXT,
        updated_at TEXT NOT NULL,
        updated_by TEXT,
        PRIMARY KEY (scope, scope_id)
      );
      CREATE INDEX IF NOT EXISTS idx_guard_bindings_profile ON guard_bindings(profile_id);
      CREATE TABLE IF NOT EXISTS guard_events (
        id TEXT PRIMARY KEY,
        verdict_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        workflow_id TEXT,
        project_id TEXT,
        node_id TEXT NOT NULL,
        placement TEXT NOT NULL,
        iteration INTEGER,
        tool_name TEXT,
        channel TEXT NOT NULL,
        detector_id TEXT,
        category TEXT,
        data_class TEXT,
        score REAL,
        requested_action TEXT NOT NULL,
        effective_action TEXT NOT NULL,
        verdict_action TEXT NOT NULL,
        shadow INTEGER NOT NULL DEFAULT 0,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        profile_id TEXT NOT NULL,
        profile_version INTEGER NOT NULL,
        profile_hash TEXT NOT NULL,
        latency_ms REAL NOT NULL DEFAULT 0,
        budget_exceeded INTEGER NOT NULL DEFAULT 0,
        skipped_detectors_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_guard_events_execution ON guard_events(execution_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_guard_events_created ON guard_events(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_guard_events_scope ON guard_events(project_id, workflow_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_guard_events_profile ON guard_events(profile_id, created_at);
      CREATE TABLE IF NOT EXISTS guard_token_vault (
        token TEXT PRIMARY KEY,
        data_class TEXT NOT NULL,
        value_hash TEXT,
        value_sealed TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_guard_token_vault_hash ON guard_token_vault(value_hash);
    `);

    // Phase 11.1 — signed run manifests: the run context captured when a run
    // finishes, the manifest generated (once) from it, and the deployment's
    // signing keys (public keys only; private keys live in SecretService).
    this.exec(`
      CREATE TABLE IF NOT EXISTS execution_manifests (
        execution_id TEXT PRIMARY KEY,
        run_context_json TEXT,
        manifest_json TEXT,
        manifest_digest TEXT,
        key_id TEXT,
        signature TEXT,
        signed_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_execution_manifests_created ON execution_manifests(created_at);
      CREATE TABLE IF NOT EXISTS audit_signing_keys (
        key_id TEXT PRIMARY KEY,
        algorithm TEXT NOT NULL,
        public_key TEXT NOT NULL,
        source TEXT NOT NULL,
        secret_id TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        retired_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_signing_keys_active ON audit_signing_keys(status) WHERE status = 'active';
    `);

    // Phase 15.1 — golden runs: scrubbed, self-contained copies of executions,
    // kept apart from execution history so its retention never removes them.
    this.exec(`
      CREATE TABLE IF NOT EXISTS replay_recordings (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        project_id TEXT,
        name TEXT NOT NULL,
        notes TEXT,
        source_execution_id TEXT,
        source_trigger_type TEXT,
        source_status TEXT NOT NULL,
        workflow_hash TEXT NOT NULL,
        workflow_saved_version INTEGER,
        captured_workflow_json TEXT NOT NULL,
        input_json TEXT,
        node_outputs_json TEXT NOT NULL,
        facts_json TEXT NOT NULL,
        mcp_cassette_json TEXT,
        model_tape_json TEXT,
        memory_seed_json TEXT,
        capabilities_json TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        truncated INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        created_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_replay_recordings_workflow ON replay_recordings(workflow_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_replay_recordings_source ON replay_recordings(source_execution_id);
    `);

    // Idempotent column additions for Phase 4.2 (SQLite has no ADD COLUMN IF NOT EXISTS).
    this.ensureColumn("workflows", "tags_json", "TEXT", "'[]'");
    this.ensureColumn("workflows", "project_id", "TEXT", `'${DEFAULT_PROJECT_ID}'`);
    this.ensureColumn("workflows", "folder_id", "TEXT");
    this.ensureColumn("secrets", "project_id", "TEXT", `'${DEFAULT_PROJECT_ID}'`);
    this.ensureColumn("secrets", "source", "TEXT", "'local'");
    this.ensureColumn("secrets", "external_provider_id", "TEXT");
    this.ensureColumn("secrets", "external_key", "TEXT");
    this.ensureColumn("execution_history", "custom_data_json", "TEXT");

    this.exec(`CREATE INDEX IF NOT EXISTS idx_workflows_project_id ON workflows(project_id)`);
    this.exec(`CREATE INDEX IF NOT EXISTS idx_workflows_folder_id ON workflows(folder_id)`);
    this.exec(`CREATE INDEX IF NOT EXISTS idx_secrets_project_id ON secrets(project_id)`);
    this.exec(`CREATE INDEX IF NOT EXISTS idx_execution_history_status ON execution_history(status)`);
    this.exec(`CREATE INDEX IF NOT EXISTS idx_execution_history_workflow_id ON execution_history(workflow_id)`);
    this.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_revoked_expires ON sessions(revoked_at, expires_at)`);

    this.persist();
  }

  private ensureMcpToolCallsTable(): void {
    this.exec(`
      CREATE TABLE IF NOT EXISTS mcp_tool_calls (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        registry_server_id TEXT,
        adapter_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        started_at TEXT NOT NULL,
        duration_ms INTEGER,
        ok INTEGER NOT NULL,
        error TEXT,
        turn_input_tokens INTEGER,
        turn_output_tokens INTEGER,
        estimated_cost_usd REAL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_registry ON mcp_tool_calls(registry_server_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_adapter_tool ON mcp_tool_calls(adapter_id, tool_name, started_at);
      CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_execution ON mcp_tool_calls(execution_id);
    `);
  }

  /**
   * Phase 10.2 — workflows.created_by (user id) decides whose role counts for
   * unattended runs. Added once; existing rows take the author of their
   * earliest version snapshot, when one was recorded, and stay NULL otherwise.
   */
  private ensureWorkflowCreatedByColumn(): void {
    if (this.columnExists("workflows", "created_by")) return;
    this.exec(`ALTER TABLE workflows ADD COLUMN created_by TEXT`);
    this.exec(
      `UPDATE workflows SET created_by = (
         SELECT wv.created_by FROM workflow_versions wv
         WHERE wv.workflow_id = workflows.id AND wv.created_by IS NOT NULL
         ORDER BY wv.created_at ASC, wv.version ASC
         LIMIT 1
       )
       WHERE created_by IS NULL`
    );
  }

  private columnExists(table: string, column: string): boolean {
    const rows = this.queryAll<{ name: string }>(`PRAGMA table_info(${table})`);
    return rows.some((row) => toString(row.name) === column);
  }

  private ensureColumn(table: string, column: string, type: string, defaultExpr?: string): void {
    if (this.columnExists(table, column)) return;
    const def = defaultExpr ? ` DEFAULT ${defaultExpr}` : "";
    this.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}${def}`);
  }

  // better-sqlite3 commits each statement to disk synchronously; persist() is
  // kept as a no-op so legacy callsites compile without a churn-heavy diff.
  private persist(): void {
    // intentional no-op
  }

  // Mimics sql.js's db.run(sql, params?) so the existing call sites stay
  // unchanged after the better-sqlite3 migration. With no params we run a
  // multi-statement script via exec(); with params we use a prepared statement.
  private exec(sql: string, params?: BindParams): void {
    if (!params || params.length === 0) {
      this.db.exec(sql);
      return;
    }
    this.db.prepare(sql).run(...params);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.db.close();
    this.closed = true;
  }

  private queryAll<T extends object>(sql: string, params?: BindParams): T[] {
    const stmt = this.db.prepare(sql);
    const args = params ?? [];
    return stmt.all(...args) as T[];
  }

  private queryOne<T extends object>(sql: string, params?: BindParams): T | null {
    const rows = this.queryAll<T>(sql, params);
    return rows[0] ?? null;
  }

  listWorkflows(options: {
    projectId?: string;
    folderId?: string | null;
    tag?: string;
    search?: string;
  } = {}): WorkflowListItem[] {
    const clauses: string[] = [];
    const params: BindParams = [];
    if (options.projectId) {
      clauses.push(`COALESCE(project_id, ?) = ?`);
      params.push(DEFAULT_PROJECT_ID, options.projectId);
    }
    if (options.folderId === null) {
      clauses.push(`(folder_id IS NULL OR folder_id = '')`);
    } else if (typeof options.folderId === "string") {
      clauses.push(`folder_id = ?`);
      params.push(options.folderId);
    }
    if (options.search && options.search.trim()) {
      clauses.push(`LOWER(name) LIKE ?`);
      params.push(`%${options.search.trim().toLowerCase()}%`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.queryAll<Omit<WorkflowRow, "workflow_json">>(
      `SELECT id, name, schema_version, workflow_version, created_at, updated_at, tags_json, project_id, folder_id
       FROM workflows
       ${where}
       ORDER BY updated_at DESC`,
      params
    );

    const mapped = rows.map((row) => ({
      id: toString(row.id),
      name: toString(row.name),
      schemaVersion: toString(row.schema_version),
      workflowVersion: toNumber(row.workflow_version),
      createdAt: toString(row.created_at),
      updatedAt: toString(row.updated_at),
      tags: parseTagsJson(row.tags_json),
      projectId: row.project_id ? toString(row.project_id) : DEFAULT_PROJECT_ID,
      folderId: row.folder_id ? toString(row.folder_id) : undefined
    }));

    if (options.tag && options.tag.trim()) {
      const needle = options.tag.trim().toLowerCase();
      return mapped.filter((item) =>
        (item.tags ?? []).some((tag) => tag.toLowerCase() === needle)
      );
    }
    return mapped;
  }

  getWorkflow(id: string): Workflow | null {
    const row = this.queryOne<WorkflowRow>(
      `SELECT id, name, schema_version, workflow_version, workflow_json, created_at, updated_at, tags_json, project_id, folder_id
       FROM workflows
       WHERE id = ?`,
      [id]
    );

    if (!row) {
      return null;
    }

    const parsed = JSON.parse(toString(row.workflow_json)) as Workflow;
    parsed.createdAt = toString(row.created_at);
    parsed.updatedAt = toString(row.updated_at);
    // Columns are authoritative (including NULL) — stale JSON is a fallback only if columns absent.
    const tagsFromCol = parseTagsJson(row.tags_json);
    if (tagsFromCol !== undefined) parsed.tags = tagsFromCol;
    parsed.projectId = row.project_id ? toString(row.project_id) : (parsed.projectId ?? DEFAULT_PROJECT_ID);
    parsed.folderId = row.folder_id ? toString(row.folder_id) : undefined;
    return parsed;
  }

  /**
   * `options.createdBy` (a user id) is stored only when the row is first
   * inserted; later saves never change who created a workflow.
   */
  upsertWorkflow(workflow: Workflow, options: { createdBy?: string | null } = {}): Workflow {
    const now = new Date().toISOString();
    const existing = this.getWorkflow(workflow.id);
    const createdAt = existing?.createdAt ?? now;
    const updatedAt = now;

    const payload: Workflow = {
      ...workflow,
      projectId: workflow.projectId ?? existing?.projectId ?? DEFAULT_PROJECT_ID,
      folderId: workflow.folderId ?? existing?.folderId,
      tags: Array.isArray(workflow.tags) ? workflow.tags.filter((t) => typeof t === "string") : existing?.tags,
      createdAt,
      updatedAt
    };

    this.exec(
      `INSERT INTO workflows (id, name, schema_version, workflow_version, workflow_json, created_at, updated_at, tags_json, project_id, folder_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         schema_version = excluded.schema_version,
         workflow_version = excluded.workflow_version,
         workflow_json = excluded.workflow_json,
         updated_at = excluded.updated_at,
         tags_json = excluded.tags_json,
         project_id = excluded.project_id,
         folder_id = excluded.folder_id`,
      [
        payload.id,
        payload.name,
        payload.schemaVersion,
        payload.workflowVersion,
        JSON.stringify(payload),
        createdAt,
        updatedAt,
        JSON.stringify(payload.tags ?? []),
        payload.projectId ?? DEFAULT_PROJECT_ID,
        payload.folderId ?? null,
        options.createdBy ?? null
      ]
    );

    this.persist();
    return payload;
  }

  /** Phase 10.2 — user id of the workflow's creator, or null when unknown. */
  getWorkflowCreatedBy(id: string): string | null {
    const row = this.queryOne<{ created_by: string | null }>(`SELECT created_by FROM workflows WHERE id = ?`, [id]);
    return row?.created_by ? toString(row.created_by) : null;
  }

  deleteWorkflow(id: string): boolean {
    const hasTable = (tableName: string): boolean => {
      const row = this.queryOne<{ count: number }>(
        `SELECT COUNT(*) as count FROM sqlite_master WHERE type = 'table' AND name = ?`,
        [tableName]
      );
      return (row ? toNumber(row.count) : 0) > 0;
    };

    const hadForeignKeysEnabled = this.queryOne<{ enabled: number }>("PRAGMA foreign_keys")?.enabled;
    const foreignKeysWereOn = Number(hadForeignKeysEnabled) === 1;

    try {
      // Defensive mode for older / migrated DBs where constraints can block deletes.
      if (foreignKeysWereOn) {
        this.exec("PRAGMA foreign_keys = OFF");
      }

      if (hasTable("execution_history")) {
        this.exec("DELETE FROM execution_history WHERE workflow_id = ?", [id]);
      }

      if (hasTable("workflow_executions")) {
        this.exec("DELETE FROM workflow_executions WHERE workflow_id = ?", [id]);
      }

      if (hasTable("mcp_cassettes")) {
        this.exec("DELETE FROM mcp_cassettes WHERE workflow_id = ?", [id]);
      }

      if (hasTable("replay_recordings")) {
        this.exec("DELETE FROM replay_recordings WHERE workflow_id = ?", [id]);
      }

      if (hasTable("guard_events")) {
        this.exec("DELETE FROM guard_events WHERE workflow_id = ?", [id]);
        this.exec("DELETE FROM guard_bindings WHERE scope = 'workflow' AND scope_id = ?", [id]);
      }

      this.exec("DELETE FROM workflows WHERE id = ?", [id]);

      const changesRow = this.queryOne<{ count: number }>("SELECT changes() as count");
      const changed = (changesRow ? toNumber(changesRow.count) : 0) > 0;
      this.persist();
      return changed;
    } finally {
      if (foreignKeysWereOn) {
        this.exec("PRAGMA foreign_keys = ON");
      }
    }
  }

  countWorkflows(): number {
    const row = this.queryOne<{ count: number }>("SELECT COUNT(*) as count FROM workflows");
    return row ? toNumber(row.count) : 0;
  }

  listSecrets(
    options: { projectId?: string } = {}
  ): Array<
    Pick<SecretRow, "id" | "name" | "provider" | "created_at"> & {
      projectId: string;
      source: "local" | "external";
      externalProviderId: string | null;
      externalKey: string | null;
    }
  > {
    const clauses: string[] = [];
    const params: BindParams = [];
    if (options.projectId) {
      clauses.push(`COALESCE(project_id, ?) = ?`);
      params.push(DEFAULT_PROJECT_ID, options.projectId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.queryAll<SecretRow>(
      `SELECT id, name, provider, iv, auth_tag, ciphertext, created_at, project_id,
              source, external_provider_id, external_key
       FROM secrets ${where}
       ORDER BY created_at DESC`,
      params
    );

    return rows.map((row) => ({
      id: toString(row.id),
      name: toString(row.name),
      provider: toString(row.provider),
      created_at: toString(row.created_at),
      projectId: row.project_id ? toString(row.project_id) : DEFAULT_PROJECT_ID,
      source: row.source === "external" ? "external" : "local",
      externalProviderId: row.external_provider_id ? toString(row.external_provider_id) : null,
      externalKey: row.external_key ? toString(row.external_key) : null
    }));
  }

  getSecret(id: string): (SecretRow & {
    projectId: string;
    source: "local" | "external";
    externalProviderId: string | null;
    externalKey: string | null;
  }) | null {
    const row = this.queryOne<SecretRow>(
      `SELECT id, name, provider, iv, auth_tag, ciphertext, created_at, project_id,
              source, external_provider_id, external_key
       FROM secrets WHERE id = ?`,
      [id]
    );

    if (!row) {
      return null;
    }

    return {
      id: toString(row.id),
      name: toString(row.name),
      provider: toString(row.provider),
      iv: toString(row.iv),
      auth_tag: toString(row.auth_tag),
      ciphertext: toString(row.ciphertext),
      created_at: toString(row.created_at),
      project_id: row.project_id ? toString(row.project_id) : DEFAULT_PROJECT_ID,
      projectId: row.project_id ? toString(row.project_id) : DEFAULT_PROJECT_ID,
      source: row.source === "external" ? "external" : "local",
      externalProviderId: row.external_provider_id ? toString(row.external_provider_id) : null,
      externalKey: row.external_key ? toString(row.external_key) : null
    };
  }

  saveSecret(input: {
    id: string;
    name: string;
    provider: string;
    iv: string;
    authTag: string;
    ciphertext: string;
    projectId?: string;
    source?: "local" | "external";
    externalProviderId?: string | null;
    externalKey?: string | null;
  }): void {
    this.exec(
      `INSERT INTO secrets (id, name, provider, iv, auth_tag, ciphertext, created_at, project_id,
                            source, external_provider_id, external_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         provider = excluded.provider,
         iv = excluded.iv,
         auth_tag = excluded.auth_tag,
         ciphertext = excluded.ciphertext,
         project_id = excluded.project_id,
         source = excluded.source,
         external_provider_id = excluded.external_provider_id,
         external_key = excluded.external_key`,
      [
        input.id,
        input.name,
        input.provider,
        input.iv,
        input.authTag,
        input.ciphertext,
        new Date().toISOString(),
        input.projectId ?? DEFAULT_PROJECT_ID,
        input.source ?? "local",
        input.externalProviderId ?? null,
        input.externalKey ?? null
      ]
    );

    this.persist();
  }

  deleteSecret(id: string): boolean {
    const existing = this.queryOne<{ id: string }>(`SELECT id FROM secrets WHERE id = ?`, [id]);
    if (!existing) return false;
    this.exec(`DELETE FROM secrets WHERE id = ?`, [id]);
    this.exec(`DELETE FROM secret_shares WHERE secret_id = ?`, [id]);
    this.exec(`DELETE FROM external_secret_cache WHERE secret_id = ?`, [id]);
    this.persist();
    return true;
  }

  countUsers(): number {
    const row = this.queryOne<{ count: number }>("SELECT COUNT(*) as count FROM users");
    return row ? toNumber(row.count) : 0;
  }

  getUserByEmail(email: string): {
    id: string;
    email: string;
    passwordHash: string;
    role: string;
    createdAt: string;
    updatedAt: string;
  } | null {
    const row = this.queryOne<UserRow>(
      `SELECT id, email, password_hash, role, created_at, updated_at
       FROM users
       WHERE lower(email) = lower(?)`,
      [email]
    );

    if (!row) {
      return null;
    }

    return {
      id: toString(row.id),
      email: toString(row.email),
      passwordHash: toString(row.password_hash),
      role: toString(row.role),
      createdAt: toString(row.created_at),
      updatedAt: toString(row.updated_at)
    };
  }

  getUserById(id: string): {
    id: string;
    email: string;
    passwordHash: string;
    role: string;
    createdAt: string;
    updatedAt: string;
  } | null {
    const row = this.queryOne<UserRow>(
      `SELECT id, email, password_hash, role, created_at, updated_at
       FROM users
       WHERE id = ?`,
      [id]
    );

    if (!row) {
      return null;
    }

    return {
      id: toString(row.id),
      email: toString(row.email),
      passwordHash: toString(row.password_hash),
      role: toString(row.role),
      createdAt: toString(row.created_at),
      updatedAt: toString(row.updated_at)
    };
  }

  saveUser(input: {
    id: string;
    email: string;
    passwordHash: string;
    role: string;
  }): {
    id: string;
    email: string;
    role: string;
    createdAt: string;
    updatedAt: string;
  } {
    const now = new Date().toISOString();
    const existing = this.getUserById(input.id);
    const createdAt = existing?.createdAt ?? now;

    this.exec(
      `INSERT INTO users (id, email, password_hash, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         email = excluded.email,
         password_hash = excluded.password_hash,
         role = excluded.role,
         updated_at = excluded.updated_at`,
      [input.id, input.email.toLowerCase(), input.passwordHash, input.role, createdAt, now]
    );

    this.persist();
    return {
      id: input.id,
      email: input.email.toLowerCase(),
      role: input.role,
      createdAt,
      updatedAt: now
    };
  }

  listUsers(): Array<{
    id: string;
    email: string;
    role: string;
    createdAt: string;
    updatedAt: string;
  }> {
    const rows = this.queryAll<UserRow>(
      `SELECT id, email, password_hash, role, created_at, updated_at FROM users ORDER BY created_at DESC`
    );
    return rows.map((row) => ({
      id: toString(row.id),
      email: toString(row.email),
      role: toString(row.role),
      createdAt: toString(row.created_at),
      updatedAt: toString(row.updated_at)
    }));
  }

  updateUserRole(id: string, role: string): boolean {
    const existing = this.getUserById(id);
    if (!existing) return false;
    const now = new Date().toISOString();
    this.exec(
      `UPDATE users SET role = ?, updated_at = ? WHERE id = ?`,
      [role, now, id]
    );
    this.persist();
    return true;
  }

  deleteUser(id: string): boolean {
    this.exec(`DELETE FROM sessions WHERE user_id = ?`, [id]);
    this.exec(`DELETE FROM users WHERE id = ?`, [id]);
    const changesRow = this.queryOne<{ count: number }>("SELECT changes() as count");
    const changed = (changesRow ? toNumber(changesRow.count) : 0) > 0;
    this.persist();
    return changed;
  }

  getSession(sessionId: string): {
    id: string;
    userId: string;
    expiresAt: string;
    createdAt: string;
    lastSeenAt: string;
    revokedAt: string | null;
  } | null {
    const row = this.queryOne<SessionRow>(
      `SELECT id, user_id, expires_at, created_at, last_seen_at, revoked_at
       FROM sessions
       WHERE id = ?`,
      [sessionId]
    );
    if (!row) {
      return null;
    }

    return {
      id: toString(row.id),
      userId: toString(row.user_id),
      expiresAt: toString(row.expires_at),
      createdAt: toString(row.created_at),
      lastSeenAt: toString(row.last_seen_at),
      revokedAt: row.revoked_at ? toString(row.revoked_at) : null
    };
  }

  saveSession(input: {
    id: string;
    userId: string;
    expiresAt: string;
  }): {
    id: string;
    userId: string;
    expiresAt: string;
    createdAt: string;
    lastSeenAt: string;
  } {
    const now = new Date().toISOString();

    this.exec(
      `INSERT INTO sessions (id, user_id, expires_at, created_at, last_seen_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
      [input.id, input.userId, input.expiresAt, now, now]
    );

    this.persist();
    return {
      id: input.id,
      userId: input.userId,
      expiresAt: input.expiresAt,
      createdAt: now,
      lastSeenAt: now
    };
  }

  touchSession(sessionId: string): void {
    this.exec(
      `UPDATE sessions
       SET last_seen_at = ?
       WHERE id = ? AND revoked_at IS NULL`,
      [new Date().toISOString(), sessionId]
    );
    this.persist();
  }

  revokeSession(sessionId: string): void {
    this.exec(
      `UPDATE sessions
       SET revoked_at = ?
       WHERE id = ? AND revoked_at IS NULL`,
      [new Date().toISOString(), sessionId]
    );
    this.persist();
  }

  revokeExpiredSessions(): void {
    this.exec(
      `UPDATE sessions
       SET revoked_at = ?
       WHERE revoked_at IS NULL AND expires_at <= ?`,
      [new Date().toISOString(), new Date().toISOString()]
    );
    this.persist();
  }

  loadSessionMemory(namespace: string, sessionId: string): ChatMessage[] {
    const row = this.queryOne<SessionMemoryRow>(
      `SELECT namespace, session_id, messages_json, created_at, updated_at
       FROM session_memory
       WHERE namespace = ? AND session_id = ?`,
      [namespace, sessionId]
    );

    if (!row) {
      return [];
    }

    try {
      const parsed = JSON.parse(toString(row.messages_json));
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed as ChatMessage[];
    } catch {
      return [];
    }
  }

  saveSessionMemory(namespace: string, sessionId: string, messages: ChatMessage[]): void {
    const existing = this.queryOne<SessionMemoryRow>(
      `SELECT namespace, session_id, messages_json, created_at, updated_at
       FROM session_memory
       WHERE namespace = ? AND session_id = ?`,
      [namespace, sessionId]
    );
    const now = new Date().toISOString();
    const createdAt = existing ? toString(existing.created_at) : now;

    this.exec(
      `INSERT INTO session_memory (namespace, session_id, messages_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(namespace, session_id) DO UPDATE SET
         messages_json = excluded.messages_json,
         updated_at = excluded.updated_at`,
      [namespace, sessionId, JSON.stringify(messages), createdAt, now]
    );

    this.persist();
  }

  saveSessionToolCall(input: {
    namespace: string;
    sessionId: string;
    toolName: string;
    toolCallId?: string;
    args: Record<string, unknown>;
    output: unknown;
    error?: string;
    summary?: unknown;
  }): {
    id: string;
    namespace: string;
    sessionId: string;
    toolName: string;
    toolCallId?: string;
    args: Record<string, unknown>;
    output: unknown;
    error?: string;
    summary?: unknown;
    createdAt: string;
  } {
    const now = new Date().toISOString();
    const id = randomUUID();

    this.exec(
      `INSERT INTO session_tool_cache (
          id,
          namespace,
          session_id,
          tool_name,
          tool_call_id,
          args_json,
          output_json,
          error,
          summary_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.namespace,
        input.sessionId,
        input.toolName,
        input.toolCallId ?? null,
        JSON.stringify(input.args ?? {}),
        JSON.stringify(input.output ?? null),
        input.error ?? null,
        input.summary === undefined ? null : JSON.stringify(input.summary),
        now
      ]
    );

    this.exec(
      `DELETE FROM session_tool_cache
       WHERE id IN (
         SELECT id
         FROM session_tool_cache
         WHERE namespace = ? AND session_id = ?
         ORDER BY created_at DESC
         LIMIT -1 OFFSET ?
       )`,
      [input.namespace, input.sessionId, MAX_SESSION_TOOL_CACHE_RECORDS]
    );

    this.persist();

    return {
      id,
      namespace: input.namespace,
      sessionId: input.sessionId,
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      args: input.args ?? {},
      output: input.output ?? null,
      error: input.error,
      summary: input.summary,
      createdAt: now
    };
  }

  listSessionToolCalls(input: {
    namespace: string;
    sessionId: string;
    toolName?: string;
    limit?: number;
  }): Array<{
    id: string;
    namespace: string;
    sessionId: string;
    toolName: string;
    toolCallId?: string;
    args: Record<string, unknown>;
    error?: string;
    summary?: unknown;
    createdAt: string;
  }> {
    const limit =
      typeof input.limit === "number" && Number.isFinite(input.limit) && input.limit > 0
        ? Math.min(Math.floor(input.limit), 200)
        : 20;

    const toolName =
      typeof input.toolName === "string" && input.toolName.trim().length > 0 ? input.toolName.trim() : undefined;
    let rows: SessionToolCacheRow[];
    if (toolName) {
      rows = this.queryAll<SessionToolCacheRow>(
        `SELECT id, namespace, session_id, tool_name, tool_call_id, args_json, output_json, error, summary_json, created_at
         FROM session_tool_cache
         WHERE namespace = ? AND session_id = ? AND tool_name = ?
         ORDER BY created_at DESC
         LIMIT ?`,
        [input.namespace, input.sessionId, toolName, limit]
      );
    } else {
      rows = this.queryAll<SessionToolCacheRow>(
        `SELECT id, namespace, session_id, tool_name, tool_call_id, args_json, output_json, error, summary_json, created_at
         FROM session_tool_cache
         WHERE namespace = ? AND session_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
        [input.namespace, input.sessionId, limit]
      );
    }

    return rows.map((row) => {
      const argsParsed = parseJsonSafe(row.args_json);
      const args = argsParsed && typeof argsParsed === "object" && !Array.isArray(argsParsed)
        ? (argsParsed as Record<string, unknown>)
        : {};

      return {
        id: toString(row.id),
        namespace: toString(row.namespace),
        sessionId: toString(row.session_id),
        toolName: toString(row.tool_name),
        toolCallId: row.tool_call_id ? toString(row.tool_call_id) : undefined,
        args,
        error: row.error ? toString(row.error) : undefined,
        summary: row.summary_json ? parseJsonSafe(row.summary_json) : undefined,
        createdAt: toString(row.created_at)
      };
    });
  }

  getSessionToolCall(input: {
    namespace: string;
    sessionId: string;
    id: string;
  }): {
    id: string;
    namespace: string;
    sessionId: string;
    toolName: string;
    toolCallId?: string;
    args: Record<string, unknown>;
    output: unknown;
    error?: string;
    summary?: unknown;
    createdAt: string;
  } | null {
    const row = this.queryOne<SessionToolCacheRow>(
      `SELECT id, namespace, session_id, tool_name, tool_call_id, args_json, output_json, error, summary_json, created_at
       FROM session_tool_cache
       WHERE namespace = ? AND session_id = ? AND id = ?`,
      [input.namespace, input.sessionId, input.id]
    );

    if (!row) {
      return null;
    }

    const argsParsed = parseJsonSafe(row.args_json);
    const args = argsParsed && typeof argsParsed === "object" && !Array.isArray(argsParsed)
      ? (argsParsed as Record<string, unknown>)
      : {};

    return {
      id: toString(row.id),
      namespace: toString(row.namespace),
      sessionId: toString(row.session_id),
      toolName: toString(row.tool_name),
      toolCallId: row.tool_call_id ? toString(row.tool_call_id) : undefined,
      args,
      output: parseJsonSafe(row.output_json),
      error: row.error ? toString(row.error) : undefined,
      summary: row.summary_json ? parseJsonSafe(row.summary_json) : undefined,
      createdAt: toString(row.created_at)
    };
  }

  saveSessionArtifact(input: {
    namespace: string;
    sessionId: string;
    artifactKey: string;
    value: unknown;
  }): {
    namespace: string;
    sessionId: string;
    artifactKey: string;
    value: unknown;
    createdAt: string;
    updatedAt: string;
  } {
    const existing = this.queryOne<SessionArtifactRow>(
      `SELECT namespace, session_id, artifact_key, value_json, created_at, updated_at
       FROM session_artifacts
       WHERE namespace = ? AND session_id = ? AND artifact_key = ?`,
      [input.namespace, input.sessionId, input.artifactKey]
    );
    const now = new Date().toISOString();
    const createdAt = existing ? toString(existing.created_at) : now;

    this.exec(
      `INSERT INTO session_artifacts (namespace, session_id, artifact_key, value_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(namespace, session_id, artifact_key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
      [
        input.namespace,
        input.sessionId,
        input.artifactKey,
        JSON.stringify(input.value ?? null),
        createdAt,
        now
      ]
    );

    this.persist();

    return {
      namespace: input.namespace,
      sessionId: input.sessionId,
      artifactKey: input.artifactKey,
      value: input.value ?? null,
      createdAt,
      updatedAt: now
    };
  }

  loadSessionArtifact(input: {
    namespace: string;
    sessionId: string;
    artifactKey: string;
  }): {
    namespace: string;
    sessionId: string;
    artifactKey: string;
    value: unknown;
    createdAt: string;
    updatedAt: string;
  } | null {
    const row = this.queryOne<SessionArtifactRow>(
      `SELECT namespace, session_id, artifact_key, value_json, created_at, updated_at
       FROM session_artifacts
       WHERE namespace = ? AND session_id = ? AND artifact_key = ?`,
      [input.namespace, input.sessionId, input.artifactKey]
    );

    if (!row) {
      return null;
    }

    return {
      namespace: toString(row.namespace),
      sessionId: toString(row.session_id),
      artifactKey: toString(row.artifact_key),
      value: parseJsonSafe(row.value_json),
      createdAt: toString(row.created_at),
      updatedAt: toString(row.updated_at)
    };
  }

  clearExpiredWebhookSecurityState(nowIso = new Date().toISOString()): void {
    this.exec(`DELETE FROM webhook_replay_keys WHERE expires_at <= ?`, [nowIso]);
    this.exec(`DELETE FROM webhook_idempotency WHERE expires_at <= ?`, [nowIso]);
    this.persist();
  }

  hasWebhookReplayKey(replayKey: string): boolean {
    const row = this.queryOne<WebhookReplayRow>(
      `SELECT replay_key, endpoint_key, created_at, expires_at
       FROM webhook_replay_keys
       WHERE replay_key = ?`,
      [replayKey]
    );
    return Boolean(row);
  }

  saveWebhookReplayKey(input: { replayKey: string; endpointKey: string; expiresAt: string }): void {
    this.exec(
      `INSERT INTO webhook_replay_keys (replay_key, endpoint_key, created_at, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(replay_key) DO NOTHING`,
      [input.replayKey, input.endpointKey, new Date().toISOString(), input.expiresAt]
    );
    this.persist();
  }

  getWebhookIdempotency(input: { endpointKey: string; idempotencyKey: string }): {
    endpointKey: string;
    idempotencyKey: string;
    requestHash: string;
    status: string;
    result: unknown;
    createdAt: string;
    updatedAt: string;
    expiresAt: string;
  } | null {
    const row = this.queryOne<WebhookIdempotencyRow>(
      `SELECT endpoint_key, idempotency_key, request_hash, status, result_json, created_at, updated_at, expires_at
       FROM webhook_idempotency
       WHERE endpoint_key = ? AND idempotency_key = ?`,
      [input.endpointKey, input.idempotencyKey]
    );

    if (!row) {
      return null;
    }

    let parsedResult: unknown = null;
    if (row.result_json) {
      try {
        parsedResult = JSON.parse(toString(row.result_json));
      } catch {
        parsedResult = null;
      }
    }

    return {
      endpointKey: toString(row.endpoint_key),
      idempotencyKey: toString(row.idempotency_key),
      requestHash: toString(row.request_hash),
      status: toString(row.status),
      result: parsedResult,
      createdAt: toString(row.created_at),
      updatedAt: toString(row.updated_at),
      expiresAt: toString(row.expires_at)
    };
  }

  saveWebhookIdempotencyPending(input: {
    endpointKey: string;
    idempotencyKey: string;
    requestHash: string;
    expiresAt: string;
  }): void {
    const now = new Date().toISOString();
    this.exec(
      `INSERT INTO webhook_idempotency (
          endpoint_key,
          idempotency_key,
          request_hash,
          status,
          result_json,
          created_at,
          updated_at,
          expires_at
        )
       VALUES (?, ?, ?, 'pending', NULL, ?, ?, ?)`,
      [input.endpointKey, input.idempotencyKey, input.requestHash, now, now, input.expiresAt]
    );
    this.persist();
  }

  saveWebhookIdempotencyResult(input: {
    endpointKey: string;
    idempotencyKey: string;
    status: "success" | "error" | "partial" | "waiting_approval" | "canceled";
    result: unknown;
  }): void {
    const now = new Date().toISOString();
    this.exec(
      `UPDATE webhook_idempotency
       SET status = ?, result_json = ?, updated_at = ?
       WHERE endpoint_key = ? AND idempotency_key = ?`,
      [input.status, JSON.stringify(input.result ?? null), now, input.endpointKey, input.idempotencyKey]
    );
    this.persist();
  }

  saveExecutionHistory(input: {
    id: string;
    workflowId: string;
    workflowName?: string;
    status: string;
    startedAt: string;
    completedAt?: string;
    durationMs?: number;
    triggerType?: string;
    triggeredBy?: string;
    inputJson?: unknown;
    outputJson?: unknown;
    nodeResultsJson?: unknown;
    customData?: unknown;
    error?: string;
  }): void {
    this.exec(
      `INSERT INTO execution_history (
          id,
          workflow_id,
          workflow_name,
          status,
          started_at,
          completed_at,
          duration_ms,
          trigger_type,
          triggered_by,
          input_json,
          output_json,
          node_results_json,
          custom_data_json,
          error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          workflow_id = excluded.workflow_id,
          workflow_name = excluded.workflow_name,
          status = excluded.status,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          duration_ms = excluded.duration_ms,
          trigger_type = excluded.trigger_type,
          triggered_by = excluded.triggered_by,
          input_json = excluded.input_json,
          output_json = excluded.output_json,
          node_results_json = excluded.node_results_json,
          custom_data_json = excluded.custom_data_json,
          error = excluded.error`,
      [
        input.id,
        input.workflowId,
        input.workflowName ?? null,
        input.status,
        input.startedAt,
        input.completedAt ?? null,
        typeof input.durationMs === "number" ? Math.floor(input.durationMs) : null,
        input.triggerType ?? null,
        input.triggeredBy ?? null,
        input.inputJson === undefined ? null : JSON.stringify(input.inputJson),
        input.outputJson === undefined ? null : JSON.stringify(input.outputJson),
        input.nodeResultsJson === undefined ? null : JSON.stringify(input.nodeResultsJson),
        input.customData === undefined ? null : JSON.stringify(input.customData),
        input.error ?? null
      ]
    );
    this.persist();
  }

  listExecutionHistory(input: {
    page?: number;
    pageSize?: number;
    status?: string;
    workflowId?: string;
    /** Only runs of these workflows; an empty list matches nothing. */
    workflowIds?: string[];
    triggerType?: string;
    startedFrom?: string;
    startedTo?: string;
  }): {
    total: number;
    page: number;
    pageSize: number;
    items: Array<{
      id: string;
      workflowId: string;
      workflowName: string | null;
      status: string;
      startedAt: string;
      completedAt: string | null;
      durationMs: number | null;
      triggerType: string | null;
      triggeredBy: string | null;
      customData: unknown;
      error: string | null;
      createdAt: string;
    }>;
  } {
    const page = Math.max(1, Math.floor(input.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(input.pageSize ?? 20)));
    const offset = (page - 1) * pageSize;

    const whereParts: string[] = [];
    const whereParams: Array<string> = [];

    if (input.status) {
      whereParts.push("status = ?");
      whereParams.push(input.status);
    }
    if (input.workflowId) {
      whereParts.push("workflow_id = ?");
      whereParams.push(input.workflowId);
    }
    if (input.workflowIds) {
      if (input.workflowIds.length === 0) {
        whereParts.push("1 = 0");
      } else {
        whereParts.push(`workflow_id IN (${input.workflowIds.map(() => "?").join(", ")})`);
        whereParams.push(...input.workflowIds);
      }
    }
    if (input.triggerType) {
      whereParts.push("trigger_type = ?");
      whereParams.push(input.triggerType);
    }
    if (input.startedFrom) {
      whereParts.push("started_at >= ?");
      whereParams.push(input.startedFrom);
    }
    if (input.startedTo) {
      whereParts.push("started_at <= ?");
      whereParams.push(input.startedTo);
    }

    const whereClause = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";
    const countRow = this.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM execution_history ${whereClause}`,
      whereParams
    );
    const total = countRow ? toNumber(countRow.count) : 0;

    const rows = this.queryAll<ExecutionHistoryRow>(
      `SELECT
         id,
         workflow_id,
         workflow_name,
         status,
         started_at,
         completed_at,
         duration_ms,
         trigger_type,
         triggered_by,
         input_json,
         output_json,
         node_results_json,
         custom_data_json,
         error,
         created_at
       FROM execution_history
       ${whereClause}
       ORDER BY started_at DESC
       LIMIT ? OFFSET ?`,
      [...whereParams, pageSize, offset]
    );

    return {
      total,
      page,
      pageSize,
      items: rows.map((row) => ({
        id: toString(row.id),
        workflowId: toString(row.workflow_id),
        workflowName: row.workflow_name ? toString(row.workflow_name) : null,
        status: toString(row.status),
        startedAt: toString(row.started_at),
        completedAt: row.completed_at ? toString(row.completed_at) : null,
        durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : toNumber(row.duration_ms),
        triggerType: row.trigger_type ? toString(row.trigger_type) : null,
        triggeredBy: row.triggered_by ? toString(row.triggered_by) : null,
        customData: row.custom_data_json ? parseJsonSafe(row.custom_data_json) : null,
        error: row.error ? toString(row.error) : null,
        createdAt: toString(row.created_at)
      }))
    };
  }

  getExecutionHistory(id: string): {
    id: string;
    workflowId: string;
    workflowName: string | null;
    status: string;
    startedAt: string;
    completedAt: string | null;
    durationMs: number | null;
    triggerType: string | null;
    triggeredBy: string | null;
    input: unknown;
    output: unknown;
    nodeResults: unknown;
    customData: unknown;
    error: string | null;
    createdAt: string;
  } | null {
    const row = this.queryOne<ExecutionHistoryRow>(
      `SELECT
         id,
         workflow_id,
         workflow_name,
         status,
         started_at,
         completed_at,
         duration_ms,
         trigger_type,
         triggered_by,
         input_json,
         output_json,
         node_results_json,
         custom_data_json,
         error,
         created_at
       FROM execution_history
       WHERE id = ?`,
      [id]
    );

    if (!row) {
      return null;
    }

    const parseJson = (value: string | null) => {
      if (!value) {
        return null;
      }
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    };

    return {
      id: toString(row.id),
      workflowId: toString(row.workflow_id),
      workflowName: row.workflow_name ? toString(row.workflow_name) : null,
      status: toString(row.status),
      startedAt: toString(row.started_at),
      completedAt: row.completed_at ? toString(row.completed_at) : null,
      durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : toNumber(row.duration_ms),
      triggerType: row.trigger_type ? toString(row.trigger_type) : null,
      triggeredBy: row.triggered_by ? toString(row.triggered_by) : null,
      input: parseJson(row.input_json),
      output: parseJson(row.output_json),
      nodeResults: parseJson(row.node_results_json),
      customData: parseJson(row.custom_data_json),
      error: row.error ? toString(row.error) : null,
      createdAt: toString(row.created_at)
    };
  }

  cancelExecutionHistory(input: {
    id: string;
    completedAt?: string;
    error?: string;
  }): boolean {
    const existing = this.getExecutionHistory(input.id);
    if (!existing) {
      return false;
    }
    const completedAt = input.completedAt ?? new Date().toISOString();
    this.exec(
      `UPDATE execution_history
       SET status = 'canceled',
           completed_at = ?,
           duration_ms = ?,
           error = ?
       WHERE id = ?`,
      [
        completedAt,
        toDurationMsForStore(existing.startedAt, completedAt),
        input.error ?? "Execution canceled",
        input.id
      ]
    );
    this.persist();
    return true;
  }

  pruneExecutionHistory(input: { before: string }): number {
    const before = this.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM execution_history WHERE started_at < ?`,
      [input.before]
    );
    this.exec(`DELETE FROM execution_history WHERE started_at < ?`, [input.before]);
    // Phase 10.1 — tool-call telemetry follows the execution-history retention.
    this.exec(`DELETE FROM mcp_tool_calls WHERE started_at < ?`, [input.before]);
    // Phase 10.8 — so do cassettes recorded from those runs.
    this.exec(`DELETE FROM mcp_cassettes WHERE created_at < ?`, [input.before]);
    // Phase 12.1 — and so do guard events.
    this.exec(`DELETE FROM guard_events WHERE created_at < ?`, [input.before]);
    const deleted = before ? toNumber(before.count) : 0;
    if (deleted > 0) {
      this.persist();
    }
    return deleted;
  }

  saveWorkflowExecutionState(input: {
    id: string;
    workflowId: string;
    workflowName?: string;
    status: string;
    waitingNodeId: string;
    approvalMessage?: string;
    timeoutMinutes?: number;
    triggerType?: string;
    triggeredBy?: string;
    startedAt: string;
    state: unknown;
  }): void {
    const now = new Date().toISOString();
    this.exec(
      `INSERT INTO workflow_executions (
          id,
          workflow_id,
          workflow_name,
          status,
          waiting_node_id,
          approval_message,
          timeout_minutes,
          trigger_type,
          triggered_by,
          started_at,
          state_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          workflow_id = excluded.workflow_id,
          workflow_name = excluded.workflow_name,
          status = excluded.status,
          waiting_node_id = excluded.waiting_node_id,
          approval_message = excluded.approval_message,
          timeout_minutes = excluded.timeout_minutes,
          trigger_type = excluded.trigger_type,
          triggered_by = excluded.triggered_by,
          started_at = excluded.started_at,
          state_json = excluded.state_json,
          updated_at = excluded.updated_at`,
      [
        input.id,
        input.workflowId,
        input.workflowName ?? null,
        input.status,
        input.waitingNodeId,
        input.approvalMessage ?? null,
        typeof input.timeoutMinutes === "number" ? Math.floor(input.timeoutMinutes) : null,
        input.triggerType ?? null,
        input.triggeredBy ?? null,
        input.startedAt,
        JSON.stringify(input.state),
        now,
        now
      ]
    );
    this.persist();
  }

  getWorkflowExecutionState(id: string): {
    id: string;
    workflowId: string;
    workflowName: string | null;
    status: string;
    waitingNodeId: string;
    approvalMessage: string | null;
    timeoutMinutes: number | null;
    triggerType: string | null;
    triggeredBy: string | null;
    startedAt: string;
    state: unknown;
    createdAt: string;
    updatedAt: string;
  } | null {
    const row = this.queryOne<WorkflowExecutionRow>(
      `SELECT
         id,
         workflow_id,
         workflow_name,
         status,
         waiting_node_id,
         approval_message,
         timeout_minutes,
         trigger_type,
         triggered_by,
         started_at,
         state_json,
         created_at,
         updated_at
       FROM workflow_executions
       WHERE id = ?`,
      [id]
    );

    if (!row) {
      return null;
    }

    let state: unknown = null;
    try {
      state = JSON.parse(toString(row.state_json));
    } catch {
      state = null;
    }

    return {
      id: toString(row.id),
      workflowId: toString(row.workflow_id),
      workflowName: row.workflow_name ? toString(row.workflow_name) : null,
      status: toString(row.status),
      waitingNodeId: toString(row.waiting_node_id),
      approvalMessage: row.approval_message ? toString(row.approval_message) : null,
      timeoutMinutes:
        row.timeout_minutes === null || row.timeout_minutes === undefined ? null : toNumber(row.timeout_minutes),
      triggerType: row.trigger_type ? toString(row.trigger_type) : null,
      triggeredBy: row.triggered_by ? toString(row.triggered_by) : null,
      startedAt: toString(row.started_at),
      state,
      createdAt: toString(row.created_at),
      updatedAt: toString(row.updated_at)
    };
  }

  listPendingApprovals(): Array<{
    id: string;
    workflowId: string;
    workflowName: string | null;
    waitingNodeId: string;
    approvalMessage: string | null;
    timeoutMinutes: number | null;
    triggerType: string | null;
    triggeredBy: string | null;
    startedAt: string;
    createdAt: string;
    updatedAt: string;
  }> {
    const rows = this.queryAll<WorkflowExecutionRow>(
      `SELECT
         id,
         workflow_id,
         workflow_name,
         status,
         waiting_node_id,
         approval_message,
         timeout_minutes,
         trigger_type,
         triggered_by,
         started_at,
         state_json,
         created_at,
         updated_at
       FROM workflow_executions
       WHERE status = 'waiting_approval'
       ORDER BY created_at DESC`
    );

    return rows.map((row) => ({
      id: toString(row.id),
      workflowId: toString(row.workflow_id),
      workflowName: row.workflow_name ? toString(row.workflow_name) : null,
      waitingNodeId: toString(row.waiting_node_id),
      approvalMessage: row.approval_message ? toString(row.approval_message) : null,
      timeoutMinutes:
        row.timeout_minutes === null || row.timeout_minutes === undefined ? null : toNumber(row.timeout_minutes),
      triggerType: row.trigger_type ? toString(row.trigger_type) : null,
      triggeredBy: row.triggered_by ? toString(row.triggered_by) : null,
      startedAt: toString(row.started_at),
      createdAt: toString(row.created_at),
      updatedAt: toString(row.updated_at)
    }));
  }

  deleteWorkflowExecution(id: string): boolean {
    const before = this.queryOne<{ count: number }>("SELECT COUNT(*) as count FROM workflow_executions WHERE id = ?", [id]);
    this.exec("DELETE FROM workflow_executions WHERE id = ?", [id]);
    const after = this.queryOne<{ count: number }>("SELECT COUNT(*) as count FROM workflow_executions WHERE id = ?", [id]);
    const deleted = (before ? toNumber(before.count) : 0) > (after ? toNumber(after.count) : 0);
    if (deleted) {
      this.persist();
    }
    return deleted;
  }

  // -------------------------------------------------------------------------
  // Execution Queue methods
  // -------------------------------------------------------------------------

  enqueueExecution(input: {
    id: string;
    workflowId: string;
    workflowName?: string;
    payload: Record<string, unknown>;
    priority?: number;
    maxAttempts?: number;
    scheduledAt?: string;
  }): void {
    const now = new Date().toISOString();
    this.exec(
      `INSERT INTO execution_queue (id, workflow_id, workflow_name, payload_json, status, priority, attempts, max_attempts, last_error, scheduled_at, started_at, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, 0, ?, NULL, ?, NULL, NULL, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      [
        input.id,
        input.workflowId,
        input.workflowName ?? null,
        JSON.stringify(input.payload),
        input.priority ?? 0,
        input.maxAttempts ?? 3,
        input.scheduledAt ?? now,
        now,
        now
      ]
    );
    this.persist();
  }

  dequeueNext(limit = 1): Array<{
    id: string;
    workflowId: string;
    workflowName: string | null;
    payload: Record<string, unknown>;
    attempts: number;
    maxAttempts: number;
    scheduledAt: string;
  }> {
    const now = new Date().toISOString();
    const rows = this.queryAll<ExecutionQueueRow>(
      `SELECT id, workflow_id, workflow_name, payload_json, attempts, max_attempts, scheduled_at
       FROM execution_queue
       WHERE status = 'pending' AND scheduled_at <= ?
       ORDER BY priority DESC, scheduled_at ASC
       LIMIT ?`,
      [now, limit]
    );

    if (rows.length === 0) {
      return [];
    }

    const ids = rows.map((row) => toString(row.id));
    for (const rowId of ids) {
      this.exec(
        `UPDATE execution_queue SET status = 'running', started_at = ?, updated_at = ? WHERE id = ?`,
        [now, now, rowId]
      );
    }
    this.persist();

    return rows.map((row) => {
      let payload: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(toString(row.payload_json));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          payload = parsed as Record<string, unknown>;
        }
      } catch {
        // ignore
      }
      return {
        id: toString(row.id),
        workflowId: toString(row.workflow_id),
        workflowName: row.workflow_name ? toString(row.workflow_name) : null,
        payload,
        attempts: toNumber(row.attempts),
        maxAttempts: toNumber(row.max_attempts),
        scheduledAt: toString(row.scheduled_at)
      };
    });
  }

  markQueueItemRunning(id: string): void {
    const now = new Date().toISOString();
    this.exec(
      `UPDATE execution_queue SET status = 'running', started_at = ?, updated_at = ? WHERE id = ?`,
      [now, now, id]
    );
    this.persist();
  }

  markQueueItemCompleted(id: string): void {
    const now = new Date().toISOString();
    this.exec(
      `UPDATE execution_queue SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?`,
      [now, now, id]
    );
    this.persist();
  }

  markQueueItemFailed(id: string, error: string): void {
    const now = new Date().toISOString();
    const row = this.queryOne<ExecutionQueueRow>(
      `SELECT id, workflow_id, workflow_name, payload_json, attempts, max_attempts FROM execution_queue WHERE id = ?`,
      [id]
    );
    if (!row) {
      return;
    }

    const attempts = toNumber(row.attempts) + 1;
    const maxAttempts = toNumber(row.max_attempts);

    if (attempts >= maxAttempts) {
      // Move to DLQ
      const dlqId = randomUUID();
      this.exec(
        `INSERT INTO execution_queue_dlq (id, original_id, workflow_id, workflow_name, payload_json, attempts, final_error, failed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          dlqId,
          toString(row.id),
          toString(row.workflow_id),
          row.workflow_name ? toString(row.workflow_name) : null,
          toString(row.payload_json),
          attempts,
          error,
          now,
          now
        ]
      );
      this.exec(`UPDATE execution_queue SET status = 'dead', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?`, [
        attempts,
        error,
        now,
        id
      ]);
    } else {
      // Exponential backoff: 1000 * 2^(attempts-1) ms
      const backoffMs = 1000 * Math.pow(2, attempts - 1);
      const retryAt = new Date(Date.now() + backoffMs).toISOString();
      this.exec(
        `UPDATE execution_queue SET status = 'pending', attempts = ?, last_error = ?, scheduled_at = ?, updated_at = ? WHERE id = ?`,
        [attempts, error, retryAt, now, id]
      );
    }
    this.persist();
  }

  requeueStuckItems(stuckAfterMs = 600_000, excludeIds: string[] = [], marginMs = STUCK_JOB_MARGIN_MS): number {
    const nowMs = Date.now();
    const stuckBefore = new Date(nowMs - stuckAfterMs).toISOString();
    const now = new Date(nowMs).toISOString();
    const skip = new Set(excludeIds);
    const stuck = this.queryAll<ExecutionQueueRow & { started_at: unknown; payload_json: unknown }>(
      `SELECT id, started_at, payload_json FROM execution_queue WHERE status = 'running' AND started_at <= ?`,
      [stuckBefore]
    ).filter((row) => {
      if (skip.has(toString(row.id))) return false;
      // A job may carry its own, longer run time limit; it is not stuck before that limit and the margin have passed.
      const runTimeout = queuedRunTimeoutMs(row.payload_json);
      if (runTimeout === null) return true;
      return Date.parse(toString(row.started_at)) <= nowMs - Math.max(stuckAfterMs, runTimeout + marginMs);
    });

    for (const row of stuck) {
      this.exec(
        `UPDATE execution_queue SET status = 'pending', started_at = NULL, updated_at = ? WHERE id = ?`,
        [now, toString(row.id)]
      );
    }

    if (stuck.length > 0) {
      this.persist();
    }
    return stuck.length;
  }

  /**
   * Marks runs still recorded as running that no live process owns as errors. Runs the queue still
   * owns (pending/running queue rows) and runs paused for approval are left alone.
   */
  reconcileOrphanedExecutions(input: { error: string; startedBefore?: string }): Array<{ id: string; workflowId: string }> {
    const rows = this.queryAll<{ id: unknown; workflow_id: unknown; started_at: unknown }>(
      `SELECT id, workflow_id, started_at FROM execution_history
       WHERE status = 'running'
         AND (? IS NULL OR started_at < ?)
         AND id NOT IN (SELECT id FROM execution_queue WHERE status IN ('pending', 'running'))`,
      [input.startedBefore ?? null, input.startedBefore ?? null]
    );
    const completedAt = new Date().toISOString();
    for (const row of rows) {
      this.exec(
        `UPDATE execution_history SET status = 'error', completed_at = ?, duration_ms = ?, error = ? WHERE id = ?`,
        [completedAt, toDurationMsForStore(toString(row.started_at), completedAt), input.error, toString(row.id)]
      );
    }
    if (rows.length > 0) {
      this.persist();
    }
    return rows.map((row) => ({ id: toString(row.id), workflowId: toString(row.workflow_id) }));
  }

  getQueueDepth(): { pending: number; running: number; dlq: number } {
    const pendingRow = this.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM execution_queue WHERE status = 'pending'`
    );
    const runningRow = this.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM execution_queue WHERE status = 'running'`
    );
    const dlqRow = this.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM execution_queue_dlq`
    );
    return {
      pending: pendingRow ? toNumber(pendingRow.count) : 0,
      running: runningRow ? toNumber(runningRow.count) : 0,
      dlq: dlqRow ? toNumber(dlqRow.count) : 0
    };
  }

  listDlqItems(limit = 50, workflowIds?: string[]): Array<{
    id: string;
    originalId: string;
    workflowId: string;
    workflowName: string | null;
    attempts: number;
    finalError: string;
    failedAt: string;
  }> {
    if (workflowIds && workflowIds.length === 0) return [];
    const scope = workflowIds ? `WHERE workflow_id IN (${workflowIds.map(() => "?").join(", ")})` : "";
    const rows = this.queryAll<ExecutionQueueDlqRow>(
      `SELECT id, original_id, workflow_id, workflow_name, attempts, final_error, failed_at
       FROM execution_queue_dlq
       ${scope}
       ORDER BY failed_at DESC
       LIMIT ?`,
      [...(workflowIds ?? []), limit]
    );

    return rows.map((row) => ({
      id: toString(row.id),
      originalId: toString(row.original_id),
      workflowId: toString(row.workflow_id),
      workflowName: row.workflow_name ? toString(row.workflow_name) : null,
      attempts: toNumber(row.attempts),
      finalError: toString(row.final_error),
      failedAt: toString(row.failed_at)
    }));
  }

  getTriggerState(workflowId: string, nodeId: string): Record<string, unknown> | null {
    const row = this.queryOne<{ state_json: string }>(
      `SELECT state_json FROM trigger_state WHERE workflow_id = ? AND node_id = ?`,
      [workflowId, nodeId]
    );
    if (!row) return null;
    try {
      return JSON.parse(toString(row.state_json)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  saveTriggerState(input: {
    workflowId: string;
    nodeId: string;
    triggerType: string;
    state: Record<string, unknown>;
  }): void {
    this.exec(
      `INSERT INTO trigger_state (workflow_id, node_id, trigger_type, state_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(workflow_id, node_id) DO UPDATE SET
         state_json = excluded.state_json,
         trigger_type = excluded.trigger_type,
         updated_at = excluded.updated_at`,
      [input.workflowId, input.nodeId, input.triggerType, JSON.stringify(input.state), new Date().toISOString()]
    );
    this.persist();
  }

  deleteTriggerStatesForWorkflow(workflowId: string): void {
    this.exec(`DELETE FROM trigger_state WHERE workflow_id = ?`, [workflowId]);
    this.persist();
  }

  // ---------------------------------------------------------------------------
  // Phase 4.2 — projects & folders
  // ---------------------------------------------------------------------------

  listProjects(): Project[] {
    const rows = this.queryAll<ProjectRow>(
      `SELECT id, name, description, created_by, created_at, updated_at
       FROM projects
       ORDER BY name ASC`
    );
    return rows.map((row) => ({
      id: toString(row.id),
      name: toString(row.name),
      description: row.description ? toString(row.description) : undefined,
      createdBy: row.created_by ? toString(row.created_by) : undefined,
      createdAt: toString(row.created_at),
      updatedAt: toString(row.updated_at)
    }));
  }

  getProject(id: string): Project | null {
    const row = this.queryOne<ProjectRow>(
      `SELECT id, name, description, created_by, created_at, updated_at FROM projects WHERE id = ?`,
      [id]
    );
    if (!row) return null;
    return {
      id: toString(row.id),
      name: toString(row.name),
      description: row.description ? toString(row.description) : undefined,
      createdBy: row.created_by ? toString(row.created_by) : undefined,
      createdAt: toString(row.created_at),
      updatedAt: toString(row.updated_at)
    };
  }

  upsertProject(input: {
    id: string;
    name: string;
    description?: string;
    createdBy?: string;
  }): Project {
    const now = new Date().toISOString();
    const existing = this.getProject(input.id);
    const createdAt = existing?.createdAt ?? now;
    this.exec(
      `INSERT INTO projects (id, name, description, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         description = excluded.description,
         updated_at = excluded.updated_at`,
      [
        input.id,
        input.name,
        input.description ?? null,
        input.createdBy ?? existing?.createdBy ?? null,
        createdAt,
        now
      ]
    );
    this.persist();
    return {
      id: input.id,
      name: input.name,
      description: input.description,
      createdBy: input.createdBy ?? existing?.createdBy,
      createdAt,
      updatedAt: now
    };
  }

  deleteProject(id: string): boolean {
    if (id === DEFAULT_PROJECT_ID) {
      throw new Error("Cannot delete the default project.");
    }
    const existing = this.getProject(id);
    if (!existing) return false;
    // Move anything belonging to this project back to the default before delete.
    this.exec(`UPDATE workflows SET project_id = ?, folder_id = NULL WHERE project_id = ?`, [
      DEFAULT_PROJECT_ID,
      id
    ]);
    this.exec(`UPDATE secrets SET project_id = ? WHERE project_id = ?`, [DEFAULT_PROJECT_ID, id]);
    this.exec(`DELETE FROM folders WHERE project_id = ?`, [id]);
    this.exec(`DELETE FROM guard_bindings WHERE scope = 'project' AND scope_id = ?`, [id]);
    this.exec(`DELETE FROM projects WHERE id = ?`, [id]);
    this.persist();
    return true;
  }

  listFolders(projectId?: string): Folder[] {
    const rows = projectId
      ? this.queryAll<FolderRow>(
          `SELECT id, name, parent_id, project_id, created_at, updated_at FROM folders WHERE project_id = ? ORDER BY name ASC`,
          [projectId]
        )
      : this.queryAll<FolderRow>(
          `SELECT id, name, parent_id, project_id, created_at, updated_at FROM folders ORDER BY project_id, name`
        );
    return rows.map((row) => ({
      id: toString(row.id),
      name: toString(row.name),
      parentId: row.parent_id ? toString(row.parent_id) : undefined,
      projectId: toString(row.project_id),
      createdAt: toString(row.created_at),
      updatedAt: toString(row.updated_at)
    }));
  }

  getFolder(id: string): Folder | null {
    const row = this.queryOne<FolderRow>(
      `SELECT id, name, parent_id, project_id, created_at, updated_at FROM folders WHERE id = ?`,
      [id]
    );
    if (!row) return null;
    return {
      id: toString(row.id),
      name: toString(row.name),
      parentId: row.parent_id ? toString(row.parent_id) : undefined,
      projectId: toString(row.project_id),
      createdAt: toString(row.created_at),
      updatedAt: toString(row.updated_at)
    };
  }

  upsertFolder(input: {
    id: string;
    name: string;
    parentId?: string;
    projectId: string;
  }): Folder {
    const now = new Date().toISOString();
    const existing = this.getFolder(input.id);
    const createdAt = existing?.createdAt ?? now;
    this.exec(
      `INSERT INTO folders (id, name, parent_id, project_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         parent_id = excluded.parent_id,
         project_id = excluded.project_id,
         updated_at = excluded.updated_at`,
      [
        input.id,
        input.name,
        input.parentId ?? null,
        input.projectId,
        createdAt,
        now
      ]
    );
    this.persist();
    return {
      id: input.id,
      name: input.name,
      parentId: input.parentId,
      projectId: input.projectId,
      createdAt,
      updatedAt: now
    };
  }

  deleteFolder(id: string): boolean {
    const existing = this.getFolder(id);
    if (!existing) return false;
    // Orphan workflows in this folder (keep them in the project, drop the folder_id).
    this.exec(`UPDATE workflows SET folder_id = NULL WHERE folder_id = ?`, [id]);
    // Also re-parent child folders up one level.
    this.exec(`UPDATE folders SET parent_id = ? WHERE parent_id = ?`, [
      existing.parentId ?? null,
      id
    ]);
    this.exec(`DELETE FROM folders WHERE id = ?`, [id]);
    this.persist();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Phase 5.1 — API keys
  // ---------------------------------------------------------------------------

  saveApiKey(input: {
    id: string;
    userId: string;
    name: string;
    keyPrefix: string;
    keyHash: string;
    scopes?: string[];
    expiresAt?: string | null;
  }): void {
    const now = new Date().toISOString();
    this.exec(
      `INSERT INTO api_keys (id, user_id, name, key_prefix, key_hash, scopes_json, last_used_at, expires_at, revoked_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)`,
      [
        input.id,
        input.userId,
        input.name,
        input.keyPrefix,
        input.keyHash,
        JSON.stringify(input.scopes ?? []),
        input.expiresAt ?? null,
        now
      ]
    );
    this.persist();
  }

  listApiKeys(userId?: string): Array<{
    id: string;
    userId: string;
    name: string;
    keyPrefix: string;
    scopes: string[];
    lastUsedAt: string | null;
    expiresAt: string | null;
    revokedAt: string | null;
    createdAt: string;
  }> {
    const rows = userId
      ? this.queryAll<{
          id: string;
          user_id: string;
          name: string;
          key_prefix: string;
          scopes_json: string;
          last_used_at: string | null;
          expires_at: string | null;
          revoked_at: string | null;
          created_at: string;
        }>(
          `SELECT id, user_id, name, key_prefix, scopes_json, last_used_at, expires_at, revoked_at, created_at
           FROM api_keys WHERE user_id = ? ORDER BY created_at DESC`,
          [userId]
        )
      : this.queryAll<{
          id: string;
          user_id: string;
          name: string;
          key_prefix: string;
          scopes_json: string;
          last_used_at: string | null;
          expires_at: string | null;
          revoked_at: string | null;
          created_at: string;
        }>(
          `SELECT id, user_id, name, key_prefix, scopes_json, last_used_at, expires_at, revoked_at, created_at
           FROM api_keys ORDER BY created_at DESC`
        );

    return rows.map((row) => ({
      id: toString(row.id),
      userId: toString(row.user_id),
      name: toString(row.name),
      keyPrefix: toString(row.key_prefix),
      scopes: parseJsonArray(row.scopes_json),
      lastUsedAt: row.last_used_at ? toString(row.last_used_at) : null,
      expiresAt: row.expires_at ? toString(row.expires_at) : null,
      revokedAt: row.revoked_at ? toString(row.revoked_at) : null,
      createdAt: toString(row.created_at)
    }));
  }

  findApiKeyByPrefix(prefix: string): {
    id: string;
    userId: string;
    name: string;
    keyPrefix: string;
    keyHash: string;
    scopes: string[];
    lastUsedAt: string | null;
    expiresAt: string | null;
    revokedAt: string | null;
    createdAt: string;
  } | null {
    const row = this.queryOne<{
      id: string;
      user_id: string;
      name: string;
      key_prefix: string;
      key_hash: string;
      scopes_json: string;
      last_used_at: string | null;
      expires_at: string | null;
      revoked_at: string | null;
      created_at: string;
    }>(
      `SELECT id, user_id, name, key_prefix, key_hash, scopes_json, last_used_at, expires_at, revoked_at, created_at
       FROM api_keys WHERE key_prefix = ? AND revoked_at IS NULL`,
      [prefix]
    );
    if (!row) return null;
    return {
      id: toString(row.id),
      userId: toString(row.user_id),
      name: toString(row.name),
      keyPrefix: toString(row.key_prefix),
      keyHash: toString(row.key_hash),
      scopes: parseJsonArray(row.scopes_json),
      lastUsedAt: row.last_used_at ? toString(row.last_used_at) : null,
      expiresAt: row.expires_at ? toString(row.expires_at) : null,
      revokedAt: row.revoked_at ? toString(row.revoked_at) : null,
      createdAt: toString(row.created_at)
    };
  }

  touchApiKey(id: string): void {
    this.exec(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
    this.persist();
  }

  revokeApiKey(id: string, userId?: string): boolean {
    const existing = userId
      ? this.queryOne<{ id: string }>(`SELECT id FROM api_keys WHERE id = ? AND user_id = ?`, [id, userId])
      : this.queryOne<{ id: string }>(`SELECT id FROM api_keys WHERE id = ?`, [id]);
    if (!existing) return false;
    this.exec(`UPDATE api_keys SET revoked_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
    this.persist();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Phase 5.1 — MFA
  // ---------------------------------------------------------------------------

  getMfaSecret(userId: string): {
    userId: string;
    secretIv: string;
    secretAuthTag: string;
    secretCiphertext: string;
    backupCodes: string[];
    enabled: boolean;
    activatedAt: string | null;
    createdAt: string;
    updatedAt: string;
  } | null {
    const row = this.queryOne<{
      user_id: string;
      secret_iv: string;
      secret_auth_tag: string;
      secret_ciphertext: string;
      backup_codes_json: string;
      enabled: number;
      activated_at: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT user_id, secret_iv, secret_auth_tag, secret_ciphertext, backup_codes_json, enabled, activated_at, created_at, updated_at
       FROM mfa_secrets WHERE user_id = ?`,
      [userId]
    );
    if (!row) return null;
    return {
      userId: toString(row.user_id),
      secretIv: toString(row.secret_iv),
      secretAuthTag: toString(row.secret_auth_tag),
      secretCiphertext: toString(row.secret_ciphertext),
      backupCodes: parseJsonArray(row.backup_codes_json),
      enabled: toNumber(row.enabled) === 1,
      activatedAt: row.activated_at ? toString(row.activated_at) : null,
      createdAt: toString(row.created_at),
      updatedAt: toString(row.updated_at)
    };
  }

  upsertMfaSecret(input: {
    userId: string;
    secretIv: string;
    secretAuthTag: string;
    secretCiphertext: string;
    backupCodes: string[];
    enabled: boolean;
    activatedAt: string | null;
  }): void {
    const now = new Date().toISOString();
    const existing = this.getMfaSecret(input.userId);
    const createdAt = existing?.createdAt ?? now;
    this.exec(
      `INSERT INTO mfa_secrets (user_id, secret_iv, secret_auth_tag, secret_ciphertext, backup_codes_json, enabled, activated_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         secret_iv = excluded.secret_iv,
         secret_auth_tag = excluded.secret_auth_tag,
         secret_ciphertext = excluded.secret_ciphertext,
         backup_codes_json = excluded.backup_codes_json,
         enabled = excluded.enabled,
         activated_at = excluded.activated_at,
         updated_at = excluded.updated_at`,
      [
        input.userId,
        input.secretIv,
        input.secretAuthTag,
        input.secretCiphertext,
        JSON.stringify(input.backupCodes),
        input.enabled ? 1 : 0,
        input.activatedAt,
        createdAt,
        now
      ]
    );
    this.persist();
  }

  deleteMfaSecret(userId: string): boolean {
    const existing = this.getMfaSecret(userId);
    if (!existing) return false;
    this.exec(`DELETE FROM mfa_secrets WHERE user_id = ?`, [userId]);
    this.persist();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Phase 5.1 — SSO identities
  // ---------------------------------------------------------------------------

  findSsoIdentity(provider: string, subject: string): {
    id: string;
    userId: string;
    provider: string;
    subject: string;
    email: string | null;
    attributes: unknown;
    createdAt: string;
    updatedAt: string;
  } | null {
    const row = this.queryOne<{
      id: string;
      user_id: string;
      provider: string;
      subject: string;
      email: string | null;
      attributes_json: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, user_id, provider, subject, email, attributes_json, created_at, updated_at
       FROM sso_identities WHERE provider = ? AND subject = ?`,
      [provider, subject]
    );
    if (!row) return null;
    let attributes: unknown = null;
    if (row.attributes_json) {
      try {
        attributes = JSON.parse(toString(row.attributes_json));
      } catch {
        attributes = null;
      }
    }
    return {
      id: toString(row.id),
      userId: toString(row.user_id),
      provider: toString(row.provider),
      subject: toString(row.subject),
      email: row.email ? toString(row.email) : null,
      attributes,
      createdAt: toString(row.created_at),
      updatedAt: toString(row.updated_at)
    };
  }

  upsertSsoIdentity(input: {
    id: string;
    userId: string;
    provider: string;
    subject: string;
    email?: string | null;
    attributes?: unknown;
  }): void {
    const now = new Date().toISOString();
    const existing = this.findSsoIdentity(input.provider, input.subject);
    const createdAt = existing?.createdAt ?? now;
    this.exec(
      `INSERT INTO sso_identities (id, user_id, provider, subject, email, attributes_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, subject) DO UPDATE SET
         user_id = excluded.user_id,
         email = excluded.email,
         attributes_json = excluded.attributes_json,
         updated_at = excluded.updated_at`,
      [
        existing?.id ?? input.id,
        input.userId,
        input.provider,
        input.subject,
        input.email ?? null,
        input.attributes === undefined ? null : JSON.stringify(input.attributes),
        createdAt,
        now
      ]
    );
    this.persist();
  }

  // ---------------------------------------------------------------------------
  // Phase 5.2 — Project-level roles
  // ---------------------------------------------------------------------------

  listProjectMembers(projectId: string): Array<{
    userId: string;
    projectId: string;
    role: string;
    customRoleId: string | null;
    createdAt: string;
    updatedAt: string;
  }> {
    const rows = this.queryAll<{
      user_id: string;
      project_id: string;
      role: string;
      custom_role_id: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT user_id, project_id, role, custom_role_id, created_at, updated_at
       FROM user_project_roles WHERE project_id = ? ORDER BY created_at ASC`,
      [projectId]
    );
    return rows.map((row) => ({
      userId: toString(row.user_id),
      projectId: toString(row.project_id),
      role: toString(row.role),
      customRoleId: row.custom_role_id ? toString(row.custom_role_id) : null,
      createdAt: toString(row.created_at),
      updatedAt: toString(row.updated_at)
    }));
  }

  listUserProjectRoles(userId: string): Array<{
    userId: string;
    projectId: string;
    role: string;
    customRoleId: string | null;
  }> {
    const rows = this.queryAll<{
      user_id: string;
      project_id: string;
      role: string;
      custom_role_id: string | null;
    }>(
      `SELECT user_id, project_id, role, custom_role_id
       FROM user_project_roles WHERE user_id = ?`,
      [userId]
    );
    return rows.map((row) => ({
      userId: toString(row.user_id),
      projectId: toString(row.project_id),
      role: toString(row.role),
      customRoleId: row.custom_role_id ? toString(row.custom_role_id) : null
    }));
  }

  getProjectRole(userId: string, projectId: string): {
    userId: string;
    projectId: string;
    role: string;
    customRoleId: string | null;
  } | null {
    const row = this.queryOne<{
      user_id: string;
      project_id: string;
      role: string;
      custom_role_id: string | null;
    }>(
      `SELECT user_id, project_id, role, custom_role_id
       FROM user_project_roles WHERE user_id = ? AND project_id = ?`,
      [userId, projectId]
    );
    if (!row) return null;
    return {
      userId: toString(row.user_id),
      projectId: toString(row.project_id),
      role: toString(row.role),
      customRoleId: row.custom_role_id ? toString(row.custom_role_id) : null
    };
  }

  upsertProjectRole(input: {
    userId: string;
    projectId: string;
    role: string;
    customRoleId?: string | null;
  }): void {
    const now = new Date().toISOString();
    const existing = this.getProjectRole(input.userId, input.projectId);
    if (existing) {
      this.exec(
        `UPDATE user_project_roles SET role = ?, custom_role_id = ?, updated_at = ?
         WHERE user_id = ? AND project_id = ?`,
        [input.role, input.customRoleId ?? null, now, input.userId, input.projectId]
      );
    } else {
      this.exec(
        `INSERT INTO user_project_roles (user_id, project_id, role, custom_role_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [input.userId, input.projectId, input.role, input.customRoleId ?? null, now, now]
      );
    }
    this.persist();
  }

  removeProjectRole(userId: string, projectId: string): boolean {
    const existing = this.getProjectRole(userId, projectId);
    if (!existing) return false;
    this.exec(`DELETE FROM user_project_roles WHERE user_id = ? AND project_id = ?`, [userId, projectId]);
    this.persist();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Phase 5.2 — Custom roles
  // ---------------------------------------------------------------------------

  listCustomRoles(projectId?: string | null): Array<{
    id: string;
    projectId: string | null;
    name: string;
    description: string | null;
    permissions: string[];
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
  }> {
    const rows = projectId === undefined
      ? this.queryAll<{
          id: string;
          project_id: string | null;
          name: string;
          description: string | null;
          permissions_json: string;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        }>(
          `SELECT id, project_id, name, description, permissions_json, created_by, created_at, updated_at
           FROM custom_roles ORDER BY name ASC`
        )
      : projectId === null
        ? this.queryAll<{
            id: string;
            project_id: string | null;
            name: string;
            description: string | null;
            permissions_json: string;
            created_by: string | null;
            created_at: string;
            updated_at: string;
          }>(
            `SELECT id, project_id, name, description, permissions_json, created_by, created_at, updated_at
             FROM custom_roles WHERE project_id IS NULL ORDER BY name ASC`
          )
        : this.queryAll<{
            id: string;
            project_id: string | null;
            name: string;
            description: string | null;
            permissions_json: string;
            created_by: string | null;
            created_at: string;
            updated_at: string;
          }>(
            `SELECT id, project_id, name, description, permissions_json, created_by, created_at, updated_at
             FROM custom_roles WHERE project_id = ? OR project_id IS NULL ORDER BY name ASC`,
            [projectId]
          );
    return rows.map((row) => ({
      id: toString(row.id),
      projectId: row.project_id ? toString(row.project_id) : null,
      name: toString(row.name),
      description: row.description ? toString(row.description) : null,
      permissions: parseJsonArray(row.permissions_json),
      createdBy: row.created_by ? toString(row.created_by) : null,
      createdAt: toString(row.created_at),
      updatedAt: toString(row.updated_at)
    }));
  }

  getCustomRole(id: string): {
    id: string;
    projectId: string | null;
    name: string;
    description: string | null;
    permissions: string[];
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
  } | null {
    const row = this.queryOne<{
      id: string;
      project_id: string | null;
      name: string;
      description: string | null;
      permissions_json: string;
      created_by: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, project_id, name, description, permissions_json, created_by, created_at, updated_at
       FROM custom_roles WHERE id = ?`,
      [id]
    );
    if (!row) return null;
    return {
      id: toString(row.id),
      projectId: row.project_id ? toString(row.project_id) : null,
      name: toString(row.name),
      description: row.description ? toString(row.description) : null,
      permissions: parseJsonArray(row.permissions_json),
      createdBy: row.created_by ? toString(row.created_by) : null,
      createdAt: toString(row.created_at),
      updatedAt: toString(row.updated_at)
    };
  }

  upsertCustomRole(input: {
    id: string;
    projectId?: string | null;
    name: string;
    description?: string | null;
    permissions: string[];
    createdBy?: string | null;
  }): void {
    const now = new Date().toISOString();
    const existing = this.getCustomRole(input.id);
    const createdAt = existing?.createdAt ?? now;
    this.exec(
      `INSERT INTO custom_roles (id, project_id, name, description, permissions_json, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         project_id = excluded.project_id,
         name = excluded.name,
         description = excluded.description,
         permissions_json = excluded.permissions_json,
         updated_at = excluded.updated_at`,
      [
        input.id,
        input.projectId ?? null,
        input.name,
        input.description ?? null,
        JSON.stringify(input.permissions),
        input.createdBy ?? existing?.createdBy ?? null,
        createdAt,
        now
      ]
    );
    this.persist();
  }

  deleteCustomRole(id: string): boolean {
    const existing = this.getCustomRole(id);
    if (!existing) return false;
    this.exec(`DELETE FROM custom_roles WHERE id = ?`, [id]);
    this.exec(`UPDATE user_project_roles SET custom_role_id = NULL WHERE custom_role_id = ?`, [id]);
    this.persist();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Phase 5.2 — Workflow shares
  // ---------------------------------------------------------------------------

  listWorkflowShares(workflowId: string): Array<{
    workflowId: string;
    projectId: string;
    accessLevel: string;
    sharedBy: string | null;
    createdAt: string;
  }> {
    const rows = this.queryAll<{
      workflow_id: string;
      project_id: string;
      access_level: string;
      shared_by: string | null;
      created_at: string;
    }>(
      `SELECT workflow_id, project_id, access_level, shared_by, created_at
       FROM workflow_shares WHERE workflow_id = ?`,
      [workflowId]
    );
    return rows.map((row) => ({
      workflowId: toString(row.workflow_id),
      projectId: toString(row.project_id),
      accessLevel: toString(row.access_level),
      sharedBy: row.shared_by ? toString(row.shared_by) : null,
      createdAt: toString(row.created_at)
    }));
  }

  listWorkflowsSharedToProject(projectId: string): Array<{
    workflowId: string;
    projectId: string;
    accessLevel: string;
  }> {
    const rows = this.queryAll<{
      workflow_id: string;
      project_id: string;
      access_level: string;
    }>(
      `SELECT workflow_id, project_id, access_level FROM workflow_shares WHERE project_id = ?`,
      [projectId]
    );
    return rows.map((row) => ({
      workflowId: toString(row.workflow_id),
      projectId: toString(row.project_id),
      accessLevel: toString(row.access_level)
    }));
  }

  upsertWorkflowShare(input: {
    workflowId: string;
    projectId: string;
    accessLevel: "read" | "execute";
    sharedBy?: string | null;
  }): void {
    this.exec(
      `INSERT INTO workflow_shares (workflow_id, project_id, access_level, shared_by, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(workflow_id, project_id) DO UPDATE SET
         access_level = excluded.access_level`,
      [input.workflowId, input.projectId, input.accessLevel, input.sharedBy ?? null, new Date().toISOString()]
    );
    this.persist();
  }

  removeWorkflowShare(workflowId: string, projectId: string): boolean {
    const existing = this.queryOne<{ workflow_id: string }>(
      `SELECT workflow_id FROM workflow_shares WHERE workflow_id = ? AND project_id = ?`,
      [workflowId, projectId]
    );
    if (!existing) return false;
    this.exec(`DELETE FROM workflow_shares WHERE workflow_id = ? AND project_id = ?`, [workflowId, projectId]);
    this.persist();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Phase 5.2 — Secret shares
  // ---------------------------------------------------------------------------

  listSecretShares(secretId: string): Array<{
    secretId: string;
    projectId: string;
    sharedBy: string | null;
    createdAt: string;
  }> {
    const rows = this.queryAll<{
      secret_id: string;
      project_id: string;
      shared_by: string | null;
      created_at: string;
    }>(
      `SELECT secret_id, project_id, shared_by, created_at
       FROM secret_shares WHERE secret_id = ?`,
      [secretId]
    );
    return rows.map((row) => ({
      secretId: toString(row.secret_id),
      projectId: toString(row.project_id),
      sharedBy: row.shared_by ? toString(row.shared_by) : null,
      createdAt: toString(row.created_at)
    }));
  }

  listSecretsSharedToProject(projectId: string): string[] {
    const rows = this.queryAll<{ secret_id: string }>(
      `SELECT secret_id FROM secret_shares WHERE project_id = ?`,
      [projectId]
    );
    return rows.map((row) => toString(row.secret_id));
  }

  upsertSecretShare(input: { secretId: string; projectId: string; sharedBy?: string | null }): void {
    this.exec(
      `INSERT INTO secret_shares (secret_id, project_id, shared_by, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(secret_id, project_id) DO NOTHING`,
      [input.secretId, input.projectId, input.sharedBy ?? null, new Date().toISOString()]
    );
    this.persist();
  }

  removeSecretShare(secretId: string, projectId: string): boolean {
    const existing = this.queryOne<{ secret_id: string }>(
      `SELECT secret_id FROM secret_shares WHERE secret_id = ? AND project_id = ?`,
      [secretId, projectId]
    );
    if (!existing) return false;
    this.exec(`DELETE FROM secret_shares WHERE secret_id = ? AND project_id = ?`, [secretId, projectId]);
    this.persist();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Phase 5.1 — SSO group-to-role mappings
  // ---------------------------------------------------------------------------

  listSsoGroupMappings(provider?: string): Array<{
    id: string;
    provider: string;
    groupName: string;
    projectId: string | null;
    role: string;
    customRoleId: string | null;
    createdAt: string;
    updatedAt: string;
  }> {
    const rows = provider
      ? this.queryAll<{
          id: string;
          provider: string;
          group_name: string;
          project_id: string | null;
          role: string;
          custom_role_id: string | null;
          created_at: string;
          updated_at: string;
        }>(
          `SELECT id, provider, group_name, project_id, role, custom_role_id, created_at, updated_at
           FROM sso_group_mappings WHERE provider = ? ORDER BY group_name ASC`,
          [provider]
        )
      : this.queryAll<{
          id: string;
          provider: string;
          group_name: string;
          project_id: string | null;
          role: string;
          custom_role_id: string | null;
          created_at: string;
          updated_at: string;
        }>(
          `SELECT id, provider, group_name, project_id, role, custom_role_id, created_at, updated_at
           FROM sso_group_mappings ORDER BY provider, group_name ASC`
        );
    return rows.map((row) => ({
      id: toString(row.id),
      provider: toString(row.provider),
      groupName: toString(row.group_name),
      projectId: row.project_id ? toString(row.project_id) : null,
      role: toString(row.role),
      customRoleId: row.custom_role_id ? toString(row.custom_role_id) : null,
      createdAt: toString(row.created_at),
      updatedAt: toString(row.updated_at)
    }));
  }

  upsertSsoGroupMapping(input: {
    id: string;
    provider: string;
    groupName: string;
    projectId?: string | null;
    role: string;
    customRoleId?: string | null;
  }): void {
    const now = new Date().toISOString();
    const existing = this.queryOne<{ created_at: string }>(
      `SELECT created_at FROM sso_group_mappings WHERE id = ?`,
      [input.id]
    );
    const createdAt = existing ? toString(existing.created_at) : now;
    this.exec(
      `INSERT INTO sso_group_mappings (id, provider, group_name, project_id, role, custom_role_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         provider = excluded.provider,
         group_name = excluded.group_name,
         project_id = excluded.project_id,
         role = excluded.role,
         custom_role_id = excluded.custom_role_id,
         updated_at = excluded.updated_at`,
      [
        input.id,
        input.provider,
        input.groupName,
        input.projectId ?? null,
        input.role,
        input.customRoleId ?? null,
        createdAt,
        now
      ]
    );
    this.persist();
  }

  deleteSsoGroupMapping(id: string): boolean {
    const existing = this.queryOne<{ id: string }>(`SELECT id FROM sso_group_mappings WHERE id = ?`, [id]);
    if (!existing) return false;
    this.exec(`DELETE FROM sso_group_mappings WHERE id = ?`, [id]);
    this.persist();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Phase 5.3 — External secret providers + rotation cache
  // ---------------------------------------------------------------------------

  listExternalSecretProviders(): Array<{
    id: string;
    name: string;
    type: string;
    config: Record<string, unknown>;
    credentialsSecretId: string | null;
    cacheTtlMs: number;
    enabled: boolean;
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
  }> {
    const rows = this.queryAll<{
      id: string;
      name: string;
      type: string;
      config_json: string;
      credentials_secret_id: string | null;
      cache_ttl_ms: number;
      enabled: number;
      created_by: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, name, type, config_json, credentials_secret_id, cache_ttl_ms, enabled, created_by, created_at, updated_at
       FROM external_secret_providers ORDER BY created_at DESC`
    );
    return rows.map((row) => ({
      id: toString(row.id),
      name: toString(row.name),
      type: toString(row.type),
      config: parseJsonObject(row.config_json),
      credentialsSecretId: row.credentials_secret_id ? toString(row.credentials_secret_id) : null,
      cacheTtlMs: toNumber(row.cache_ttl_ms),
      enabled: toNumber(row.enabled) === 1,
      createdBy: row.created_by ? toString(row.created_by) : null,
      createdAt: toString(row.created_at),
      updatedAt: toString(row.updated_at)
    }));
  }

  getExternalSecretProvider(id: string): {
    id: string;
    name: string;
    type: string;
    config: Record<string, unknown>;
    credentialsSecretId: string | null;
    cacheTtlMs: number;
    enabled: boolean;
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
  } | null {
    const row = this.queryOne<{
      id: string;
      name: string;
      type: string;
      config_json: string;
      credentials_secret_id: string | null;
      cache_ttl_ms: number;
      enabled: number;
      created_by: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, name, type, config_json, credentials_secret_id, cache_ttl_ms, enabled, created_by, created_at, updated_at
       FROM external_secret_providers WHERE id = ?`,
      [id]
    );
    if (!row) return null;
    return {
      id: toString(row.id),
      name: toString(row.name),
      type: toString(row.type),
      config: parseJsonObject(row.config_json),
      credentialsSecretId: row.credentials_secret_id ? toString(row.credentials_secret_id) : null,
      cacheTtlMs: toNumber(row.cache_ttl_ms),
      enabled: toNumber(row.enabled) === 1,
      createdBy: row.created_by ? toString(row.created_by) : null,
      createdAt: toString(row.created_at),
      updatedAt: toString(row.updated_at)
    };
  }

  upsertExternalSecretProvider(input: {
    id: string;
    name: string;
    type: string;
    config: Record<string, unknown>;
    credentialsSecretId?: string | null;
    cacheTtlMs?: number;
    enabled?: boolean;
    createdBy?: string | null;
  }): void {
    const now = new Date().toISOString();
    const existing = this.getExternalSecretProvider(input.id);
    const createdAt = existing?.createdAt ?? now;
    this.exec(
      `INSERT INTO external_secret_providers
         (id, name, type, config_json, credentials_secret_id, cache_ttl_ms, enabled, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         type = excluded.type,
         config_json = excluded.config_json,
         credentials_secret_id = excluded.credentials_secret_id,
         cache_ttl_ms = excluded.cache_ttl_ms,
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
      [
        input.id,
        input.name,
        input.type,
        JSON.stringify(input.config ?? {}),
        input.credentialsSecretId ?? null,
        input.cacheTtlMs ?? 300000,
        input.enabled === false ? 0 : 1,
        input.createdBy ?? existing?.createdBy ?? null,
        createdAt,
        now
      ]
    );
    this.persist();
  }

  deleteExternalSecretProvider(id: string): boolean {
    const existing = this.getExternalSecretProvider(id);
    if (!existing) return false;
    this.exec(`DELETE FROM external_secret_providers WHERE id = ?`, [id]);
    this.persist();
    return true;
  }

  countSecretsUsingExternalProvider(providerId: string): number {
    const row = this.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM secrets WHERE external_provider_id = ?`,
      [providerId]
    );
    return row ? toNumber(row.count) : 0;
  }

  getExternalSecretCacheEntry(secretId: string): {
    secretId: string;
    iv: string;
    authTag: string;
    ciphertext: string;
    fetchedAt: string;
    expiresAt: string;
  } | null {
    const row = this.queryOne<{
      secret_id: string;
      iv: string;
      auth_tag: string;
      ciphertext: string;
      fetched_at: string;
      expires_at: string;
    }>(
      `SELECT secret_id, iv, auth_tag, ciphertext, fetched_at, expires_at
       FROM external_secret_cache WHERE secret_id = ?`,
      [secretId]
    );
    if (!row) return null;
    return {
      secretId: toString(row.secret_id),
      iv: toString(row.iv),
      authTag: toString(row.auth_tag),
      ciphertext: toString(row.ciphertext),
      fetchedAt: toString(row.fetched_at),
      expiresAt: toString(row.expires_at)
    };
  }

  upsertExternalSecretCacheEntry(input: {
    secretId: string;
    iv: string;
    authTag: string;
    ciphertext: string;
    expiresAt: string;
  }): void {
    const now = new Date().toISOString();
    this.exec(
      `INSERT INTO external_secret_cache (secret_id, iv, auth_tag, ciphertext, fetched_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(secret_id) DO UPDATE SET
         iv = excluded.iv,
         auth_tag = excluded.auth_tag,
         ciphertext = excluded.ciphertext,
         fetched_at = excluded.fetched_at,
         expires_at = excluded.expires_at`,
      [input.secretId, input.iv, input.authTag, input.ciphertext, now, input.expiresAt]
    );
    this.persist();
  }

  deleteExternalSecretCacheEntry(secretId: string): void {
    this.exec(`DELETE FROM external_secret_cache WHERE secret_id = ?`, [secretId]);
    this.persist();
  }

  // ---------------------------------------------------------------------------
  // Phase 5.4 — Audit log
  // ---------------------------------------------------------------------------

  writeAuditLog(entry: {
    id: string;
    eventType: string;
    category: string;
    action: string;
    outcome: "success" | "failure" | "denied";
    actorUserId?: string | null;
    actorEmail?: string | null;
    actorType?: "user" | "api_key" | "system";
    resourceType?: string | null;
    resourceId?: string | null;
    projectId?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
    metadata?: unknown;
    message?: string | null;
    createdAt?: string;
  }): void {
    const createdAt = entry.createdAt ?? new Date().toISOString();
    // Phase 8.4 — hash chain. prev_hash = the last row's entry_hash; for the
    // very first row it's 64 zeros. entry_hash = SHA-256(prev_hash || canonical
    // JSON of this row). Tampering with any historical row breaks every link
    // after it, which `verifyAuditChain()` surfaces.
    const prevHash = this.getLastAuditEntryHash() ?? "0".repeat(64);
    const canonical = canonicalAuditPayload({
      id: entry.id,
      createdAt,
      eventType: entry.eventType,
      category: entry.category,
      action: entry.action,
      outcome: entry.outcome,
      actorUserId: entry.actorUserId ?? null,
      actorEmail: entry.actorEmail ?? null,
      actorType: entry.actorType ?? "user",
      resourceType: entry.resourceType ?? null,
      resourceId: entry.resourceId ?? null,
      projectId: entry.projectId ?? null,
      ipAddress: entry.ipAddress ?? null,
      userAgent: entry.userAgent ?? null,
      metadataJson: entry.metadata === undefined ? null : JSON.stringify(entry.metadata),
      message: entry.message ?? null
    });
    const entryHash = sha256Hex(prevHash + canonical);
    this.exec(
      `INSERT INTO audit_logs
         (id, event_type, category, action, outcome, actor_user_id, actor_email, actor_type,
          resource_type, resource_id, project_id, ip_address, user_agent, metadata_json, message, created_at,
          prev_hash, entry_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.eventType,
        entry.category,
        entry.action,
        entry.outcome,
        entry.actorUserId ?? null,
        entry.actorEmail ?? null,
        entry.actorType ?? "user",
        entry.resourceType ?? null,
        entry.resourceId ?? null,
        entry.projectId ?? null,
        entry.ipAddress ?? null,
        entry.userAgent ?? null,
        entry.metadata === undefined ? null : JSON.stringify(entry.metadata),
        entry.message ?? null,
        createdAt,
        prevHash,
        entryHash
      ]
    );
    this.persist();
  }

  private getLastAuditEntryHash(): string | null {
    const row = this.queryOne<{ entry_hash: string | null }>(
      `SELECT entry_hash FROM audit_logs WHERE entry_hash IS NOT NULL ORDER BY rowid DESC LIMIT 1`
    );
    return row?.entry_hash ? toString(row.entry_hash) : null;
  }

  /**
   * Walk the chain in insertion order and verify every recomputed entry_hash
   * matches what's stored. Returns details of the first broken link, or
   * `{ ok: true }` when the chain is intact.
   *
   * Rows persisted before Phase 8.4 (where entry_hash IS NULL) are skipped —
   * we can only attest the chain from the first hash onwards.
   */
  verifyAuditChain(): {
    ok: boolean;
    rowsChecked: number;
    firstBrokenAt?: { id: string; createdAt: string; expected: string; stored: string };
  } {
    const rows = this.queryAll<{
      id: string;
      event_type: string;
      category: string;
      action: string;
      outcome: string;
      actor_user_id: string | null;
      actor_email: string | null;
      actor_type: string;
      resource_type: string | null;
      resource_id: string | null;
      project_id: string | null;
      ip_address: string | null;
      user_agent: string | null;
      metadata_json: string | null;
      message: string | null;
      created_at: string;
      prev_hash: string | null;
      entry_hash: string | null;
    }>(
      `SELECT id, event_type, category, action, outcome, actor_user_id, actor_email, actor_type,
              resource_type, resource_id, project_id, ip_address, user_agent, metadata_json, message,
              created_at, prev_hash, entry_hash
       FROM audit_logs WHERE entry_hash IS NOT NULL
       ORDER BY rowid ASC`
    );
    let prev = "0".repeat(64);
    let checked = 0;
    for (const row of rows) {
      const stored = toString(row.entry_hash ?? "");
      const storedPrev = toString(row.prev_hash ?? "");
      if (storedPrev !== prev) {
        return {
          ok: false,
          rowsChecked: checked,
          firstBrokenAt: {
            id: toString(row.id),
            createdAt: toString(row.created_at),
            expected: prev,
            stored: storedPrev
          }
        };
      }
      const canonical = canonicalAuditPayload({
        id: toString(row.id),
        createdAt: toString(row.created_at),
        eventType: toString(row.event_type),
        category: toString(row.category),
        action: toString(row.action),
        outcome: toString(row.outcome),
        actorUserId: row.actor_user_id ? toString(row.actor_user_id) : null,
        actorEmail: row.actor_email ? toString(row.actor_email) : null,
        actorType: toString(row.actor_type),
        resourceType: row.resource_type ? toString(row.resource_type) : null,
        resourceId: row.resource_id ? toString(row.resource_id) : null,
        projectId: row.project_id ? toString(row.project_id) : null,
        ipAddress: row.ip_address ? toString(row.ip_address) : null,
        userAgent: row.user_agent ? toString(row.user_agent) : null,
        metadataJson: row.metadata_json ? toString(row.metadata_json) : null,
        message: row.message ? toString(row.message) : null
      });
      const expected = sha256Hex(prev + canonical);
      if (expected !== stored) {
        return {
          ok: false,
          rowsChecked: checked,
          firstBrokenAt: { id: toString(row.id), createdAt: toString(row.created_at), expected, stored }
        };
      }
      prev = expected;
      checked += 1;
    }
    return { ok: true, rowsChecked: checked };
  }

  listAuditLogs(filter: {
    category?: string;
    eventType?: string;
    outcome?: string;
    actorUserId?: string;
    resourceType?: string;
    resourceId?: string;
    projectId?: string;
    from?: string;
    to?: string;
    page?: number;
    pageSize?: number;
  } = {}): {
    items: Array<{
      id: string;
      eventType: string;
      category: string;
      action: string;
      outcome: string;
      actorUserId: string | null;
      actorEmail: string | null;
      actorType: string;
      resourceType: string | null;
      resourceId: string | null;
      projectId: string | null;
      ipAddress: string | null;
      userAgent: string | null;
      metadata: unknown;
      message: string | null;
      createdAt: string;
    }>;
    total: number;
    page: number;
    pageSize: number;
  } {
    const clauses: string[] = [];
    const params: BindParams = [];
    if (filter.category) {
      clauses.push(`category = ?`);
      params.push(filter.category);
    }
    if (filter.eventType) {
      clauses.push(`event_type = ?`);
      params.push(filter.eventType);
    }
    if (filter.outcome) {
      clauses.push(`outcome = ?`);
      params.push(filter.outcome);
    }
    if (filter.actorUserId) {
      clauses.push(`actor_user_id = ?`);
      params.push(filter.actorUserId);
    }
    if (filter.resourceType) {
      clauses.push(`resource_type = ?`);
      params.push(filter.resourceType);
    }
    if (filter.resourceId) {
      clauses.push(`resource_id = ?`);
      params.push(filter.resourceId);
    }
    if (filter.projectId) {
      clauses.push(`project_id = ?`);
      params.push(filter.projectId);
    }
    if (filter.from) {
      clauses.push(`created_at >= ?`);
      params.push(filter.from);
    }
    if (filter.to) {
      clauses.push(`created_at <= ?`);
      params.push(filter.to);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const totalRow = this.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM audit_logs ${where}`,
      params
    );
    const total = totalRow ? toNumber(totalRow.count) : 0;

    const pageSize = Math.max(1, Math.min(500, filter.pageSize ?? 50));
    const page = Math.max(1, filter.page ?? 1);
    const offset = (page - 1) * pageSize;

    const rows = this.queryAll<{
      id: string;
      event_type: string;
      category: string;
      action: string;
      outcome: string;
      actor_user_id: string | null;
      actor_email: string | null;
      actor_type: string;
      resource_type: string | null;
      resource_id: string | null;
      project_id: string | null;
      ip_address: string | null;
      user_agent: string | null;
      metadata_json: string | null;
      message: string | null;
      created_at: string;
    }>(
      `SELECT id, event_type, category, action, outcome, actor_user_id, actor_email, actor_type,
              resource_type, resource_id, project_id, ip_address, user_agent, metadata_json, message, created_at
       FROM audit_logs ${where}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    return {
      items: rows.map((row) => {
        let metadata: unknown = null;
        if (row.metadata_json) {
          try {
            metadata = JSON.parse(toString(row.metadata_json));
          } catch {
            metadata = null;
          }
        }
        return {
          id: toString(row.id),
          eventType: toString(row.event_type),
          category: toString(row.category),
          action: toString(row.action),
          outcome: toString(row.outcome),
          actorUserId: row.actor_user_id ? toString(row.actor_user_id) : null,
          actorEmail: row.actor_email ? toString(row.actor_email) : null,
          actorType: toString(row.actor_type),
          resourceType: row.resource_type ? toString(row.resource_type) : null,
          resourceId: row.resource_id ? toString(row.resource_id) : null,
          projectId: row.project_id ? toString(row.project_id) : null,
          ipAddress: row.ip_address ? toString(row.ip_address) : null,
          userAgent: row.user_agent ? toString(row.user_agent) : null,
          metadata,
          message: row.message ? toString(row.message) : null,
          createdAt: toString(row.created_at)
        };
      }),
      total,
      page,
      pageSize
    };
  }

  pruneAuditLogs(options: { before: string }): number {
    // Phase 11.1 — cached run manifests older than the audit-log retention whose execution history is gone.
    this.pruneExecutionManifests(options);
    const existing = this.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM audit_logs WHERE created_at < ?`,
      [options.before]
    );
    const count = existing ? toNumber(existing.count) : 0;
    if (count === 0) return 0;
    this.exec(`DELETE FROM audit_logs WHERE created_at < ?`, [options.before]);
    this.persist();
    return count;
  }

  // ---------------------------------------------------------------------------
  // Phase 5.5 — Log streaming destinations + delivery history
  // ---------------------------------------------------------------------------

  listLogStreamDestinations(): LogStreamDestinationRecord[] {
    const rows = this.queryAll<LogStreamDestinationRow>(
      `SELECT id, name, type, enabled, categories_json, min_level, config_iv, config_auth_tag,
              config_ciphertext, last_success_at, last_error_at, last_error, dispatched_count,
              failed_count, created_by, created_at, updated_at
       FROM log_stream_destinations ORDER BY created_at DESC`
    );
    return rows.map(mapLogStreamDestinationRow);
  }

  getLogStreamDestination(id: string): LogStreamDestinationRecord | null {
    const row = this.queryOne<LogStreamDestinationRow>(
      `SELECT id, name, type, enabled, categories_json, min_level, config_iv, config_auth_tag,
              config_ciphertext, last_success_at, last_error_at, last_error, dispatched_count,
              failed_count, created_by, created_at, updated_at
       FROM log_stream_destinations WHERE id = ?`,
      [id]
    );
    return row ? mapLogStreamDestinationRow(row) : null;
  }

  upsertLogStreamDestination(input: {
    id: string;
    name: string;
    type: string;
    enabled?: boolean;
    categories?: string[];
    minLevel?: string;
    configIv?: string | null;
    configAuthTag?: string | null;
    configCiphertext?: string | null;
    createdBy?: string | null;
  }): void {
    const now = new Date().toISOString();
    const existing = this.getLogStreamDestination(input.id);
    const createdAt = existing?.createdAt ?? now;
    this.exec(
      `INSERT INTO log_stream_destinations
         (id, name, type, enabled, categories_json, min_level, config_iv, config_auth_tag,
          config_ciphertext, last_success_at, last_error_at, last_error, dispatched_count,
          failed_count, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         type = excluded.type,
         enabled = excluded.enabled,
         categories_json = excluded.categories_json,
         min_level = excluded.min_level,
         config_iv = excluded.config_iv,
         config_auth_tag = excluded.config_auth_tag,
         config_ciphertext = excluded.config_ciphertext,
         updated_at = excluded.updated_at`,
      [
        input.id,
        input.name,
        input.type,
        input.enabled === false ? 0 : 1,
        JSON.stringify(input.categories ?? []),
        input.minLevel ?? "info",
        input.configIv ?? null,
        input.configAuthTag ?? null,
        input.configCiphertext ?? null,
        existing?.lastSuccessAt ?? null,
        existing?.lastErrorAt ?? null,
        existing?.lastError ?? null,
        existing?.dispatchedCount ?? 0,
        existing?.failedCount ?? 0,
        input.createdBy ?? existing?.createdBy ?? null,
        createdAt,
        now
      ]
    );
    this.persist();
  }

  deleteLogStreamDestination(id: string): boolean {
    const existing = this.getLogStreamDestination(id);
    if (!existing) return false;
    this.exec(`DELETE FROM log_stream_destinations WHERE id = ?`, [id]);
    this.exec(`DELETE FROM log_stream_events WHERE destination_id = ?`, [id]);
    this.persist();
    return true;
  }

  recordLogStreamDispatch(input: {
    destinationId: string;
    success: boolean;
    error?: string | null;
    at?: string;
  }): void {
    const now = input.at ?? new Date().toISOString();
    if (input.success) {
      this.exec(
        `UPDATE log_stream_destinations
         SET last_success_at = ?, dispatched_count = dispatched_count + 1, updated_at = ?
         WHERE id = ?`,
        [now, now, input.destinationId]
      );
    } else {
      this.exec(
        `UPDATE log_stream_destinations
         SET last_error_at = ?, last_error = ?, failed_count = failed_count + 1, updated_at = ?
         WHERE id = ?`,
        [now, input.error ?? "unknown error", now, input.destinationId]
      );
    }
    this.persist();
  }

  writeLogStreamEvent(entry: {
    id: string;
    destinationId: string;
    category: string;
    eventType: string;
    level: string;
    status: "sent" | "failed" | "pending";
    attempts?: number;
    error?: string | null;
    payload?: unknown;
    createdAt?: string;
  }): void {
    const createdAt = entry.createdAt ?? new Date().toISOString();
    this.exec(
      `INSERT INTO log_stream_events
         (id, destination_id, category, event_type, level, status, attempts, error, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.destinationId,
        entry.category,
        entry.eventType,
        entry.level,
        entry.status,
        entry.attempts ?? 0,
        entry.error ?? null,
        entry.payload === undefined ? null : JSON.stringify(entry.payload),
        createdAt
      ]
    );
    this.persist();
  }

  listLogStreamEvents(filter: {
    destinationId?: string;
    status?: string;
    limit?: number;
  } = {}): Array<{
    id: string;
    destinationId: string;
    category: string;
    eventType: string;
    level: string;
    status: string;
    attempts: number;
    error: string | null;
    payload: unknown;
    createdAt: string;
  }> {
    const clauses: string[] = [];
    const params: BindParams = [];
    if (filter.destinationId) {
      clauses.push(`destination_id = ?`);
      params.push(filter.destinationId);
    }
    if (filter.status) {
      clauses.push(`status = ?`);
      params.push(filter.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(500, filter.limit ?? 100));
    const rows = this.queryAll<{
      id: string;
      destination_id: string;
      category: string;
      event_type: string;
      level: string;
      status: string;
      attempts: number;
      error: string | null;
      payload_json: string | null;
      created_at: string;
    }>(
      `SELECT id, destination_id, category, event_type, level, status, attempts, error, payload_json, created_at
       FROM log_stream_events ${where}
       ORDER BY created_at DESC
       LIMIT ?`,
      [...params, limit]
    );
    return rows.map((row) => {
      let payload: unknown = null;
      if (row.payload_json) {
        try {
          payload = JSON.parse(toString(row.payload_json));
        } catch {
          payload = null;
        }
      }
      return {
        id: toString(row.id),
        destinationId: toString(row.destination_id),
        category: toString(row.category),
        eventType: toString(row.event_type),
        level: toString(row.level),
        status: toString(row.status),
        attempts: toNumber(row.attempts),
        error: row.error ? toString(row.error) : null,
        payload,
        createdAt: toString(row.created_at)
      };
    });
  }

  pruneLogStreamEvents(options: { before: string }): number {
    const existing = this.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM log_stream_events WHERE created_at < ?`,
      [options.before]
    );
    const count = existing ? toNumber(existing.count) : 0;
    if (count === 0) return 0;
    this.exec(`DELETE FROM log_stream_events WHERE created_at < ?`, [options.before]);
    this.persist();
    return count;
  }

  // ---------------------------------------------------------------------------
  // Phase 5.6 — Variables, workflow version history, git config
  // ---------------------------------------------------------------------------

  listVariables(projectId?: string): Array<{
    id: string;
    projectId: string;
    key: string;
    value: string;
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
  }> {
    const rows = projectId
      ? this.queryAll<{
          id: string;
          project_id: string;
          key: string;
          value: string;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        }>(
          `SELECT id, project_id, key, value, created_by, created_at, updated_at
           FROM variables WHERE project_id = ? ORDER BY key`,
          [projectId]
        )
      : this.queryAll<{
          id: string;
          project_id: string;
          key: string;
          value: string;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        }>(
          `SELECT id, project_id, key, value, created_by, created_at, updated_at FROM variables ORDER BY project_id, key`
        );
    return rows.map((row) => ({
      id: toString(row.id),
      projectId: toString(row.project_id),
      key: toString(row.key),
      value: toString(row.value),
      createdBy: row.created_by ? toString(row.created_by) : null,
      createdAt: toString(row.created_at),
      updatedAt: toString(row.updated_at)
    }));
  }

  getVariable(id: string): {
    id: string;
    projectId: string;
    key: string;
    value: string;
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
  } | null {
    const row = this.queryOne<{
      id: string;
      project_id: string;
      key: string;
      value: string;
      created_by: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, project_id, key, value, created_by, created_at, updated_at FROM variables WHERE id = ?`,
      [id]
    );
    if (!row) return null;
    return {
      id: toString(row.id),
      projectId: toString(row.project_id),
      key: toString(row.key),
      value: toString(row.value),
      createdBy: row.created_by ? toString(row.created_by) : null,
      createdAt: toString(row.created_at),
      updatedAt: toString(row.updated_at)
    };
  }

  upsertVariable(input: {
    id: string;
    projectId: string;
    key: string;
    value: string;
    createdBy?: string | null;
  }): void {
    const now = new Date().toISOString();
    const existing = this.getVariable(input.id);
    const createdAt = existing?.createdAt ?? now;
    this.exec(
      `INSERT INTO variables (id, project_id, key, value, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         key = excluded.key,
         value = excluded.value,
         updated_at = excluded.updated_at`,
      [
        input.id,
        input.projectId,
        input.key,
        input.value,
        input.createdBy ?? existing?.createdBy ?? null,
        createdAt,
        now
      ]
    );
    this.persist();
  }

  deleteVariable(id: string): boolean {
    const existing = this.getVariable(id);
    if (!existing) return false;
    this.exec(`DELETE FROM variables WHERE id = ?`, [id]);
    this.persist();
    return true;
  }

  findVariableByKey(projectId: string, key: string): { id: string; key: string; value: string } | null {
    const row = this.queryOne<{ id: string; key: string; value: string }>(
      `SELECT id, key, value FROM variables WHERE project_id = ? AND key = ?`,
      [projectId, key]
    );
    if (!row) return null;
    return { id: toString(row.id), key: toString(row.key), value: toString(row.value) };
  }

  // Workflow version history

  listWorkflowVersions(workflowId: string, limit = 100): Array<{
    id: string;
    workflowId: string;
    version: number;
    createdBy: string | null;
    changeNote: string | null;
    createdAt: string;
  }> {
    const rows = this.queryAll<{
      id: string;
      workflow_id: string;
      version: number;
      created_by: string | null;
      change_note: string | null;
      created_at: string;
    }>(
      `SELECT id, workflow_id, version, created_by, change_note, created_at
       FROM workflow_versions WHERE workflow_id = ? ORDER BY version DESC LIMIT ?`,
      [workflowId, Math.max(1, Math.min(500, limit))]
    );
    return rows.map((row) => ({
      id: toString(row.id),
      workflowId: toString(row.workflow_id),
      version: toNumber(row.version),
      createdBy: row.created_by ? toString(row.created_by) : null,
      changeNote: row.change_note ? toString(row.change_note) : null,
      createdAt: toString(row.created_at)
    }));
  }

  getWorkflowVersion(workflowId: string, version: number): {
    id: string;
    workflowId: string;
    version: number;
    workflowJson: string;
    createdBy: string | null;
    changeNote: string | null;
    createdAt: string;
  } | null {
    const row = this.queryOne<{
      id: string;
      workflow_id: string;
      version: number;
      workflow_json: string;
      created_by: string | null;
      change_note: string | null;
      created_at: string;
    }>(
      `SELECT id, workflow_id, version, workflow_json, created_by, change_note, created_at
       FROM workflow_versions WHERE workflow_id = ? AND version = ?`,
      [workflowId, version]
    );
    if (!row) return null;
    return {
      id: toString(row.id),
      workflowId: toString(row.workflow_id),
      version: toNumber(row.version),
      workflowJson: toString(row.workflow_json),
      createdBy: row.created_by ? toString(row.created_by) : null,
      changeNote: row.change_note ? toString(row.change_note) : null,
      createdAt: toString(row.created_at)
    };
  }

  writeWorkflowVersion(entry: {
    id: string;
    workflowId: string;
    version: number;
    workflowJson: string;
    createdBy?: string | null;
    changeNote?: string | null;
  }): void {
    const now = new Date().toISOString();
    this.exec(
      `INSERT INTO workflow_versions (id, workflow_id, version, workflow_json, created_by, change_note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workflow_id, version) DO UPDATE SET
         workflow_json = excluded.workflow_json,
         change_note = excluded.change_note,
         created_by = excluded.created_by`,
      [
        entry.id,
        entry.workflowId,
        entry.version,
        entry.workflowJson,
        entry.createdBy ?? null,
        entry.changeNote ?? null,
        now
      ]
    );
    this.persist();
  }

  pruneWorkflowVersions(workflowId: string, keep: number): number {
    if (keep <= 0) return 0;
    const toDelete = this.queryAll<{ id: string }>(
      `SELECT id FROM workflow_versions WHERE workflow_id = ? ORDER BY version DESC LIMIT -1 OFFSET ?`,
      [workflowId, keep]
    );
    if (toDelete.length === 0) return 0;
    for (const row of toDelete) {
      this.exec(`DELETE FROM workflow_versions WHERE id = ?`, [toString(row.id)]);
    }
    this.persist();
    return toDelete.length;
  }

  maxWorkflowVersionNumber(workflowId: string): number {
    const row = this.queryOne<{ max_version: number | null }>(
      `SELECT MAX(version) as max_version FROM workflow_versions WHERE workflow_id = ?`,
      [workflowId]
    );
    return row && row.max_version !== null ? toNumber(row.max_version) : 0;
  }

  // Git config (singleton row keyed by literal 'default')

  getGitConfig(): {
    id: string;
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
  } | null {
    const row = this.queryOne<{
      id: string;
      repo_url: string;
      default_branch: string;
      auth_secret_id: string | null;
      workflows_dir: string;
      variables_file: string;
      user_name: string;
      user_email: string;
      enabled: number;
      last_push_at: string | null;
      last_pull_at: string | null;
      last_error: string | null;
      updated_at: string;
    }>(`SELECT id, repo_url, default_branch, auth_secret_id, workflows_dir, variables_file,
        user_name, user_email, enabled, last_push_at, last_pull_at, last_error, updated_at
        FROM git_configs WHERE id = 'default'`);
    if (!row) return null;
    return {
      id: toString(row.id),
      repoUrl: toString(row.repo_url),
      defaultBranch: toString(row.default_branch),
      authSecretId: row.auth_secret_id ? toString(row.auth_secret_id) : null,
      workflowsDir: toString(row.workflows_dir),
      variablesFile: toString(row.variables_file),
      userName: toString(row.user_name),
      userEmail: toString(row.user_email),
      enabled: toNumber(row.enabled) === 1,
      lastPushAt: row.last_push_at ? toString(row.last_push_at) : null,
      lastPullAt: row.last_pull_at ? toString(row.last_pull_at) : null,
      lastError: row.last_error ? toString(row.last_error) : null,
      updatedAt: toString(row.updated_at)
    };
  }

  upsertGitConfig(input: {
    repoUrl: string;
    defaultBranch?: string;
    authSecretId?: string | null;
    workflowsDir?: string;
    variablesFile?: string;
    userName?: string;
    userEmail?: string;
    enabled?: boolean;
  }): void {
    const now = new Date().toISOString();
    this.exec(
      `INSERT INTO git_configs (id, repo_url, default_branch, auth_secret_id, workflows_dir, variables_file,
          user_name, user_email, enabled, updated_at)
       VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         repo_url = excluded.repo_url,
         default_branch = excluded.default_branch,
         auth_secret_id = excluded.auth_secret_id,
         workflows_dir = excluded.workflows_dir,
         variables_file = excluded.variables_file,
         user_name = excluded.user_name,
         user_email = excluded.user_email,
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
      [
        input.repoUrl,
        input.defaultBranch ?? "main",
        input.authSecretId ?? null,
        input.workflowsDir ?? "workflows",
        input.variablesFile ?? "variables.json",
        input.userName ?? "ai-orchestrator",
        input.userEmail ?? "sync@ai-orchestrator.local",
        input.enabled === false ? 0 : 1,
        now
      ]
    );
    this.persist();
  }

  deleteGitConfig(): boolean {
    const existing = this.getGitConfig();
    if (!existing) return false;
    this.exec(`DELETE FROM git_configs WHERE id = 'default'`);
    this.persist();
    return true;
  }

  recordGitSync(input: { kind: "push" | "pull"; error?: string | null }): void {
    const now = new Date().toISOString();
    const column = input.kind === "push" ? "last_push_at" : "last_pull_at";
    this.exec(
      `UPDATE git_configs SET ${column} = ?, last_error = ?, updated_at = ? WHERE id = 'default'`,
      [now, input.error ?? null, now]
    );
    this.persist();
  }

  // ---------------------------------------------------------------------------
  // Phase 7.1 — Multi-main HA leader leases
  // ---------------------------------------------------------------------------

  getLease(leaseName: string): {
    leaseName: string;
    holderId: string;
    expiresAt: string;
    acquiredAt: string;
    renewedAt: string;
  } | null {
    const row = this.queryOne<{
      lease_name: string;
      holder_id: string;
      expires_at: string;
      acquired_at: string;
      renewed_at: string;
    }>(
      `SELECT lease_name, holder_id, expires_at, acquired_at, renewed_at
       FROM leader_leases WHERE lease_name = ?`,
      [leaseName]
    );
    if (!row) return null;
    return {
      leaseName: toString(row.lease_name),
      holderId: toString(row.holder_id),
      expiresAt: toString(row.expires_at),
      acquiredAt: toString(row.acquired_at),
      renewedAt: toString(row.renewed_at)
    };
  }

  /**
   * Atomic compare-and-set lease acquisition. Returns true if this holder
   * now owns the lease, false if another non-expired holder owns it.
   */
  tryAcquireLease(input: { leaseName: string; holderId: string; ttlMs: number }): boolean {
    const now = Date.now();
    const existing = this.getLease(input.leaseName);
    const expiresAt = new Date(now + input.ttlMs).toISOString();
    const nowIso = new Date(now).toISOString();

    if (!existing) {
      this.exec(
        `INSERT INTO leader_leases (lease_name, holder_id, expires_at, acquired_at, renewed_at)
         VALUES (?, ?, ?, ?, ?)`,
        [input.leaseName, input.holderId, expiresAt, nowIso, nowIso]
      );
      this.persist();
      return true;
    }

    const existingExpiresMs = Date.parse(existing.expiresAt);
    if (existing.holderId === input.holderId) {
      // We already hold it — renew.
      this.exec(
        `UPDATE leader_leases SET expires_at = ?, renewed_at = ? WHERE lease_name = ?`,
        [expiresAt, nowIso, input.leaseName]
      );
      this.persist();
      return true;
    }
    if (!Number.isFinite(existingExpiresMs) || existingExpiresMs <= now) {
      // Expired — steal it.
      this.exec(
        `UPDATE leader_leases
         SET holder_id = ?, expires_at = ?, acquired_at = ?, renewed_at = ?
         WHERE lease_name = ?`,
        [input.holderId, expiresAt, nowIso, nowIso, input.leaseName]
      );
      this.persist();
      return true;
    }
    return false;
  }

  releaseLease(leaseName: string, holderId: string): boolean {
    const existing = this.getLease(leaseName);
    if (!existing || existing.holderId !== holderId) return false;
    this.exec(`DELETE FROM leader_leases WHERE lease_name = ?`, [leaseName]);
    this.persist();
    return true;
  }

  listLeases(): Array<{
    leaseName: string;
    holderId: string;
    expiresAt: string;
    acquiredAt: string;
    renewedAt: string;
  }> {
    const rows = this.queryAll<{
      lease_name: string;
      holder_id: string;
      expires_at: string;
      acquired_at: string;
      renewed_at: string;
    }>(
      `SELECT lease_name, holder_id, expires_at, acquired_at, renewed_at FROM leader_leases
       ORDER BY lease_name`
    );
    return rows.map((row) => ({
      leaseName: toString(row.lease_name),
      holderId: toString(row.holder_id),
      expiresAt: toString(row.expires_at),
      acquiredAt: toString(row.acquired_at),
      renewedAt: toString(row.renewed_at)
    }));
  }

  // ---------------------------------------------------------------------------
  // Workflow Templates (Phase 7.4)
  // ---------------------------------------------------------------------------

  listTemplates(filters?: { category?: string; search?: string }): Array<{
    id: string; name: string; description: string; category: string;
    tags: string[]; author: string; nodeCount: number;
    createdAt: string; updatedAt: string;
  }> {
    const clauses: string[] = [];
    const params: BindParams = [];
    if (filters?.category) {
      clauses.push(`category = ?`);
      params.push(filters.category);
    }
    if (filters?.search && filters.search.trim()) {
      clauses.push(`(LOWER(name) LIKE ? OR LOWER(description) LIKE ?)`);
      const needle = `%${filters.search.trim().toLowerCase()}%`;
      params.push(needle, needle);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.queryAll<WorkflowTemplateRow>(
      `SELECT id, name, description, category, tags, author, node_count, created_at, updated_at
       FROM workflow_templates
       ${where}
       ORDER BY category, name`,
      params
    );
    return rows.map((row) => ({
      id: toString(row.id),
      name: toString(row.name),
      description: toString(row.description),
      category: toString(row.category),
      tags: parseJsonArray(row.tags),
      author: toString(row.author),
      nodeCount: toNumber(row.node_count),
      createdAt: toString(row.created_at),
      updatedAt: toString(row.updated_at)
    }));
  }

  getTemplate(id: string): {
    id: string; name: string; description: string; category: string;
    tags: string[]; author: string; workflowJson: string; nodeCount: number;
    createdAt: string; updatedAt: string;
  } | undefined {
    const row = this.queryOne<WorkflowTemplateRow>(
      `SELECT id, name, description, category, tags, author, workflow_json, node_count, created_at, updated_at
       FROM workflow_templates WHERE id = ?`,
      [id]
    );
    if (!row) return undefined;
    return {
      id: toString(row.id),
      name: toString(row.name),
      description: toString(row.description),
      category: toString(row.category),
      tags: parseJsonArray(row.tags),
      author: toString(row.author),
      workflowJson: toString(row.workflow_json),
      nodeCount: toNumber(row.node_count),
      createdAt: toString(row.created_at),
      updatedAt: toString(row.updated_at)
    };
  }

  upsertTemplate(input: {
    id: string; name: string; description: string; category: string;
    tags: string[]; author: string; workflowJson: string; nodeCount: number;
  }): void {
    const now = new Date().toISOString();
    this.exec(
      `INSERT INTO workflow_templates (id, name, description, category, tags, author, workflow_json, node_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         description = excluded.description,
         category = excluded.category,
         tags = excluded.tags,
         author = excluded.author,
         workflow_json = excluded.workflow_json,
         node_count = excluded.node_count,
         updated_at = excluded.updated_at`,
      [
        input.id,
        input.name,
        input.description,
        input.category,
        JSON.stringify(input.tags),
        input.author,
        input.workflowJson,
        input.nodeCount,
        now,
        now
      ]
    );
    this.persist();
  }

  deleteTemplate(id: string): boolean {
    this.exec(`DELETE FROM workflow_templates WHERE id = ?`, [id]);
    const changesRow = this.queryOne<{ count: number }>("SELECT changes() as count");
    const changed = (changesRow ? toNumber(changesRow.count) : 0) > 0;
    if (changed) this.persist();
    return changed;
  }

  countTemplates(): number {
    const row = this.queryOne<{ count: number }>("SELECT COUNT(*) as count FROM workflow_templates");
    return row ? toNumber(row.count) : 0;
  }

  // ---------------------------------------------------------------------------
  // Notification Configs (Phase 7.5)
  // ---------------------------------------------------------------------------

  listNotificationConfigs(): Array<{
    id: string; channel: string; enabled: boolean;
    config: Record<string, unknown>; events: string[];
    createdAt: string; updatedAt: string;
  }> {
    const rows = this.queryAll<{
      id: string; channel: string; enabled: number;
      config_json: string; events: string;
      created_at: string; updated_at: string;
    }>(`SELECT id, channel, enabled, config_json, events, created_at, updated_at FROM notification_configs ORDER BY created_at`);
    return rows.map(r => ({
      id: toString(r.id),
      channel: toString(r.channel),
      enabled: toNumber(r.enabled) === 1,
      config: JSON.parse(toString(r.config_json) || "{}"),
      events: JSON.parse(toString(r.events) || '["execution.failure"]'),
      createdAt: toString(r.created_at),
      updatedAt: toString(r.updated_at)
    }));
  }

  upsertNotificationConfig(input: {
    id: string; channel: string; enabled: boolean;
    config: Record<string, unknown>; events: string[];
  }): void {
    const now = new Date().toISOString();
    this.exec(
      `INSERT INTO notification_configs (id, channel, enabled, config_json, events, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET channel=excluded.channel, enabled=excluded.enabled,
         config_json=excluded.config_json, events=excluded.events, updated_at=excluded.updated_at`,
      [input.id, input.channel, input.enabled ? 1 : 0,
       JSON.stringify(input.config), JSON.stringify(input.events), now, now]
    );
    this.persist();
  }

  deleteNotificationConfig(id: string): boolean {
    this.exec(`DELETE FROM notification_configs WHERE id = ?`, [id]);
    const changesRow = this.queryOne<{ count: number }>("SELECT changes() as count");
    const changed = (changesRow ? toNumber(changesRow.count) : 0) > 0;
    if (changed) this.persist();
    return changed;
  }

  // ---------------------------------------------------------------------------
  // Phase 7.3 — Agent eval framework
  //
  // SQLite-only at the moment. PostgresStore parity is a follow-up — see
  // the eval-framework docs for the interim story for prod-Postgres users.
  // ---------------------------------------------------------------------------

  createEvalDataset(input: {
    id: string;
    name: string;
    description?: string;
    projectId?: string;
    createdBy?: string;
  }): void {
    const now = new Date().toISOString();
    this.exec(
      `INSERT INTO eval_datasets (id, name, description, project_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [input.id, input.name, input.description ?? null, input.projectId ?? null, input.createdBy ?? null, now, now]
    );
    this.persist();
  }

  listEvalDatasets(options: { projectId?: string } = {}): Array<{
    id: string; name: string; description: string | null; projectId: string | null;
    createdBy: string | null; createdAt: string; updatedAt: string;
    fixtureCount: number;
  }> {
    const where = options.projectId ? `WHERE project_id = ?` : "";
    const params = options.projectId ? [options.projectId] : [];
    const rows = this.queryAll<{
      id: string; name: string; description: string | null; project_id: string | null;
      created_by: string | null; created_at: string; updated_at: string; fixture_count: number;
    }>(
      `SELECT d.id, d.name, d.description, d.project_id, d.created_by, d.created_at, d.updated_at,
              (SELECT COUNT(*) FROM eval_fixtures WHERE dataset_id = d.id) AS fixture_count
       FROM eval_datasets d
       ${where}
       ORDER BY d.created_at DESC`,
      params
    );
    return rows.map((r) => ({
      id: toString(r.id),
      name: toString(r.name),
      description: r.description ? toString(r.description) : null,
      projectId: r.project_id ? toString(r.project_id) : null,
      createdBy: r.created_by ? toString(r.created_by) : null,
      createdAt: toString(r.created_at),
      updatedAt: toString(r.updated_at),
      fixtureCount: toNumber(r.fixture_count)
    }));
  }

  getEvalDataset(id: string) {
    const list = this.listEvalDatasets();
    return list.find((d) => d.id === id) ?? null;
  }

  deleteEvalDataset(id: string): boolean {
    this.exec(`DELETE FROM eval_results WHERE run_id IN (SELECT id FROM eval_runs WHERE dataset_id = ?)`, [id]);
    this.exec(`DELETE FROM eval_runs WHERE dataset_id = ?`, [id]);
    this.exec(`DELETE FROM eval_fixtures WHERE dataset_id = ?`, [id]);
    this.exec(`DELETE FROM eval_datasets WHERE id = ?`, [id]);
    const row = this.queryOne<{ count: number }>("SELECT changes() as count");
    const changed = (row ? toNumber(row.count) : 0) > 0;
    if (changed) this.persist();
    return changed;
  }

  createEvalFixture(input: {
    id: string; datasetId: string; name: string;
    input: unknown; expected?: unknown;
    scorers?: Array<Record<string, unknown>>;
  }): void {
    const now = new Date().toISOString();
    this.exec(
      `INSERT INTO eval_fixtures (id, dataset_id, name, input_json, expected_json, scorers_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id, input.datasetId, input.name,
        JSON.stringify(input.input ?? null),
        input.expected !== undefined ? JSON.stringify(input.expected) : null,
        input.scorers && input.scorers.length > 0 ? JSON.stringify(input.scorers) : null,
        now, now
      ]
    );
    this.persist();
  }

  listEvalFixtures(datasetId: string): Array<{
    id: string; datasetId: string; name: string;
    input: unknown; expected: unknown | null;
    scorers: Array<Record<string, unknown>> | null;
    createdAt: string; updatedAt: string;
  }> {
    const rows = this.queryAll<{
      id: string; dataset_id: string; name: string;
      input_json: string; expected_json: string | null; scorers_json: string | null;
      created_at: string; updated_at: string;
    }>(
      `SELECT id, dataset_id, name, input_json, expected_json, scorers_json, created_at, updated_at
       FROM eval_fixtures WHERE dataset_id = ? ORDER BY created_at`,
      [datasetId]
    );
    return rows.map((r) => ({
      id: toString(r.id),
      datasetId: toString(r.dataset_id),
      name: toString(r.name),
      input: JSON.parse(toString(r.input_json) || "null"),
      expected: r.expected_json ? JSON.parse(toString(r.expected_json)) : null,
      scorers: r.scorers_json ? (JSON.parse(toString(r.scorers_json)) as Array<Record<string, unknown>>) : null,
      createdAt: toString(r.created_at),
      updatedAt: toString(r.updated_at)
    }));
  }

  deleteEvalFixture(id: string): boolean {
    this.exec(`DELETE FROM eval_fixtures WHERE id = ?`, [id]);
    const row = this.queryOne<{ count: number }>("SELECT changes() as count");
    const changed = (row ? toNumber(row.count) : 0) > 0;
    if (changed) this.persist();
    return changed;
  }

  createEvalRun(input: {
    id: string; datasetId: string; workflowId: string; workflowName?: string;
    triggeredBy?: string; scorers?: Array<Record<string, unknown>>;
  }): void {
    const now = new Date().toISOString();
    this.exec(
      `INSERT INTO eval_runs (id, dataset_id, workflow_id, workflow_name, status, started_at,
                               triggered_by, scorers_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id, input.datasetId, input.workflowId, input.workflowName ?? null,
        "running", now, input.triggeredBy ?? null,
        input.scorers && input.scorers.length > 0 ? JSON.stringify(input.scorers) : null,
        now
      ]
    );
    this.persist();
  }

  finalizeEvalRun(input: {
    id: string;
    status: "completed" | "errored";
    summary?: Record<string, unknown>;
    error?: string;
  }): void {
    const now = new Date().toISOString();
    this.exec(
      `UPDATE eval_runs SET status = ?, completed_at = ?, summary_json = ?, error = ? WHERE id = ?`,
      [
        input.status,
        now,
        input.summary ? JSON.stringify(input.summary) : null,
        input.error ?? null,
        input.id
      ]
    );
    this.persist();
  }

  listEvalRuns(options: { datasetId?: string; workflowId?: string; limit?: number } = {}): Array<{
    id: string; datasetId: string; workflowId: string; workflowName: string | null;
    status: string; startedAt: string; completedAt: string | null;
    triggeredBy: string | null; summary: Record<string, unknown> | null; error: string | null;
  }> {
    const clauses: string[] = [];
    const params: BindParams = [];
    if (options.datasetId) { clauses.push("dataset_id = ?"); params.push(options.datasetId); }
    if (options.workflowId) { clauses.push("workflow_id = ?"); params.push(options.workflowId); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(500, options.limit ?? 100));
    const rows = this.queryAll<{
      id: string; dataset_id: string; workflow_id: string; workflow_name: string | null;
      status: string; started_at: string; completed_at: string | null;
      triggered_by: string | null; summary_json: string | null; error: string | null;
    }>(
      `SELECT id, dataset_id, workflow_id, workflow_name, status, started_at, completed_at,
              triggered_by, summary_json, error
       FROM eval_runs ${where} ORDER BY started_at DESC LIMIT ?`,
      [...params, limit]
    );
    return rows.map((r) => ({
      id: toString(r.id),
      datasetId: toString(r.dataset_id),
      workflowId: toString(r.workflow_id),
      workflowName: r.workflow_name ? toString(r.workflow_name) : null,
      status: toString(r.status),
      startedAt: toString(r.started_at),
      completedAt: r.completed_at ? toString(r.completed_at) : null,
      triggeredBy: r.triggered_by ? toString(r.triggered_by) : null,
      summary: r.summary_json ? (JSON.parse(toString(r.summary_json)) as Record<string, unknown>) : null,
      error: r.error ? toString(r.error) : null
    }));
  }

  getEvalRun(id: string) {
    const list = this.listEvalRuns({ limit: 500 });
    return list.find((r) => r.id === id) ?? null;
  }

  recordEvalResult(input: {
    id: string; runId: string; fixtureId: string; fixtureName?: string;
    status: "pass" | "fail" | "error";
    executionId?: string;
    score?: Record<string, unknown>;
    output?: unknown;
    error?: string;
    durationMs?: number;
    tokenInput?: number;
    tokenOutput?: number;
    tokenTotal?: number;
  }): void {
    const now = new Date().toISOString();
    this.exec(
      `INSERT INTO eval_results (id, run_id, fixture_id, fixture_name, status, execution_id,
                                  score_json, output_json, error, duration_ms,
                                  token_input, token_output, token_total, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id, input.runId, input.fixtureId, input.fixtureName ?? null,
        input.status, input.executionId ?? null,
        input.score ? JSON.stringify(input.score) : null,
        input.output !== undefined ? JSON.stringify(input.output) : null,
        input.error ?? null,
        typeof input.durationMs === "number" ? Math.floor(input.durationMs) : null,
        typeof input.tokenInput === "number" ? Math.floor(input.tokenInput) : null,
        typeof input.tokenOutput === "number" ? Math.floor(input.tokenOutput) : null,
        typeof input.tokenTotal === "number" ? Math.floor(input.tokenTotal) : null,
        now
      ]
    );
    this.persist();
  }

  listEvalResults(runId: string): Array<{
    id: string; runId: string; fixtureId: string; fixtureName: string | null;
    status: string; executionId: string | null;
    score: Record<string, unknown> | null; output: unknown;
    error: string | null; durationMs: number | null;
    tokenInput: number | null; tokenOutput: number | null; tokenTotal: number | null;
  }> {
    const rows = this.queryAll<{
      id: string; run_id: string; fixture_id: string; fixture_name: string | null;
      status: string; execution_id: string | null;
      score_json: string | null; output_json: string | null; error: string | null;
      duration_ms: number | null;
      token_input: number | null; token_output: number | null; token_total: number | null;
    }>(
      `SELECT id, run_id, fixture_id, fixture_name, status, execution_id,
              score_json, output_json, error, duration_ms, token_input, token_output, token_total
       FROM eval_results WHERE run_id = ? ORDER BY created_at`,
      [runId]
    );
    return rows.map((r) => ({
      id: toString(r.id),
      runId: toString(r.run_id),
      fixtureId: toString(r.fixture_id),
      fixtureName: r.fixture_name ? toString(r.fixture_name) : null,
      status: toString(r.status),
      executionId: r.execution_id ? toString(r.execution_id) : null,
      score: r.score_json ? (JSON.parse(toString(r.score_json)) as Record<string, unknown>) : null,
      output: r.output_json ? JSON.parse(toString(r.output_json)) : null,
      error: r.error ? toString(r.error) : null,
      durationMs: r.duration_ms !== null && r.duration_ms !== undefined ? toNumber(r.duration_ms) : null,
      tokenInput: r.token_input !== null && r.token_input !== undefined ? toNumber(r.token_input) : null,
      tokenOutput: r.token_output !== null && r.token_output !== undefined ? toNumber(r.token_output) : null,
      tokenTotal: r.token_total !== null && r.token_total !== undefined ? toNumber(r.token_total) : null
    }));
  }

  // ---------------------------------------------------------------------------
  // Phase 8.2 — usage_events (FinOps cost rollups)
  // ---------------------------------------------------------------------------

  writeUsageEvent(input: {
    id: string;
    executionId: string;
    workflowId: string;
    workflowName?: string | null;
    userId?: string | null;
    userEmail?: string | null;
    projectId?: string | null;
    triggerType?: string | null;
    status: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    totalTokens: number;
    costUsd: number;
    llmCallCount: number;
    durationMs: number;
    providers: Array<{ providerId: string; model: string; calls: number }>;
    createdAt?: string;
  }): void {
    this.exec(
      `INSERT INTO usage_events (
         id, execution_id, workflow_id, workflow_name, user_id, user_email,
         project_id, trigger_type, status, input_tokens, output_tokens,
         cached_input_tokens, total_tokens, cost_usd, llm_call_count,
         duration_ms, providers_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.executionId,
        input.workflowId,
        input.workflowName ?? null,
        input.userId ?? null,
        input.userEmail ?? null,
        input.projectId ?? null,
        input.triggerType ?? null,
        input.status,
        input.inputTokens,
        input.outputTokens,
        input.cachedInputTokens,
        input.totalTokens,
        input.costUsd,
        input.llmCallCount,
        input.durationMs,
        JSON.stringify(input.providers),
        input.createdAt ?? new Date().toISOString()
      ]
    );
    this.persist();
  }

  /**
   * Aggregate usage over a time window. `groupBy` switches between time-series
   * buckets (`day` / `hour`) and dimensional rollups (`workflow` / `user` /
   * `project` / `provider`). Returns rows with summed tokens + cost.
   */
  queryUsageRollup(input: {
    from: string;
    to: string;
    groupBy: "day" | "hour" | "workflow" | "user" | "project" | "provider";
    workflowId?: string;
    userId?: string;
    projectId?: string;
    limit?: number;
  }): Array<{
    bucket: string;
    workflowId?: string | null;
    workflowName?: string | null;
    userId?: string | null;
    userEmail?: string | null;
    projectId?: string | null;
    providerId?: string | null;
    model?: string | null;
    executions: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    totalTokens: number;
    costUsd: number;
    llmCallCount: number;
    avgDurationMs: number;
  }> {
    const filters: string[] = ["created_at >= ?", "created_at < ?"];
    const params: Array<string | number> = [input.from, input.to];
    if (input.workflowId) {
      filters.push("workflow_id = ?");
      params.push(input.workflowId);
    }
    if (input.userId) {
      filters.push("user_id = ?");
      params.push(input.userId);
    }
    if (input.projectId) {
      filters.push("project_id = ?");
      params.push(input.projectId);
    }
    const where = `WHERE ${filters.join(" AND ")}`;
    const limit = Math.min(input.limit ?? 100, 500);

    if (input.groupBy === "day" || input.groupBy === "hour") {
      const fmt = input.groupBy === "day" ? "%Y-%m-%d" : "%Y-%m-%dT%H:00:00";
      const rows = this.queryAll<{
        bucket: string;
        execs: number;
        ti: number; to: number; ci: number; tt: number;
        cost: number; calls: number; avgd: number;
      }>(
        `SELECT strftime('${fmt}', created_at) AS bucket,
                COUNT(*) AS execs,
                SUM(input_tokens) AS ti, SUM(output_tokens) AS "to",
                SUM(cached_input_tokens) AS ci, SUM(total_tokens) AS tt,
                SUM(cost_usd) AS cost, SUM(llm_call_count) AS calls,
                AVG(duration_ms) AS avgd
         FROM usage_events ${where}
         GROUP BY bucket
         ORDER BY bucket ASC
         LIMIT ${limit}`,
        params
      );
      return rows.map((r) => ({
        bucket: toString(r.bucket),
        executions: toNumber(r.execs),
        inputTokens: toNumber(r.ti ?? 0),
        outputTokens: toNumber(r.to ?? 0),
        cachedInputTokens: toNumber(r.ci ?? 0),
        totalTokens: toNumber(r.tt ?? 0),
        costUsd: Number(r.cost ?? 0),
        llmCallCount: toNumber(r.calls ?? 0),
        avgDurationMs: Math.round(Number(r.avgd ?? 0))
      }));
    }

    if (input.groupBy === "workflow") {
      const rows = this.queryAll<{
        workflow_id: string; workflow_name: string | null;
        execs: number; ti: number; to: number; ci: number; tt: number;
        cost: number; calls: number; avgd: number;
      }>(
        `SELECT workflow_id, MAX(workflow_name) AS workflow_name,
                COUNT(*) AS execs,
                SUM(input_tokens) AS ti, SUM(output_tokens) AS "to",
                SUM(cached_input_tokens) AS ci, SUM(total_tokens) AS tt,
                SUM(cost_usd) AS cost, SUM(llm_call_count) AS calls,
                AVG(duration_ms) AS avgd
         FROM usage_events ${where}
         GROUP BY workflow_id
         ORDER BY cost DESC, tt DESC
         LIMIT ${limit}`,
        params
      );
      return rows.map((r) => ({
        bucket: toString(r.workflow_id),
        workflowId: toString(r.workflow_id),
        workflowName: r.workflow_name ? toString(r.workflow_name) : null,
        executions: toNumber(r.execs),
        inputTokens: toNumber(r.ti ?? 0),
        outputTokens: toNumber(r.to ?? 0),
        cachedInputTokens: toNumber(r.ci ?? 0),
        totalTokens: toNumber(r.tt ?? 0),
        costUsd: Number(r.cost ?? 0),
        llmCallCount: toNumber(r.calls ?? 0),
        avgDurationMs: Math.round(Number(r.avgd ?? 0))
      }));
    }

    if (input.groupBy === "user") {
      const rows = this.queryAll<{
        user_id: string | null; user_email: string | null;
        execs: number; ti: number; to: number; ci: number; tt: number;
        cost: number; calls: number; avgd: number;
      }>(
        `SELECT user_id, MAX(user_email) AS user_email,
                COUNT(*) AS execs,
                SUM(input_tokens) AS ti, SUM(output_tokens) AS "to",
                SUM(cached_input_tokens) AS ci, SUM(total_tokens) AS tt,
                SUM(cost_usd) AS cost, SUM(llm_call_count) AS calls,
                AVG(duration_ms) AS avgd
         FROM usage_events ${where}
         GROUP BY user_id
         ORDER BY cost DESC, tt DESC
         LIMIT ${limit}`,
        params
      );
      return rows.map((r) => ({
        bucket: r.user_id ? toString(r.user_id) : "(anonymous)",
        userId: r.user_id ? toString(r.user_id) : null,
        userEmail: r.user_email ? toString(r.user_email) : null,
        executions: toNumber(r.execs),
        inputTokens: toNumber(r.ti ?? 0),
        outputTokens: toNumber(r.to ?? 0),
        cachedInputTokens: toNumber(r.ci ?? 0),
        totalTokens: toNumber(r.tt ?? 0),
        costUsd: Number(r.cost ?? 0),
        llmCallCount: toNumber(r.calls ?? 0),
        avgDurationMs: Math.round(Number(r.avgd ?? 0))
      }));
    }

    if (input.groupBy === "project") {
      const rows = this.queryAll<{
        project_id: string | null;
        execs: number; ti: number; to: number; ci: number; tt: number;
        cost: number; calls: number; avgd: number;
      }>(
        `SELECT project_id,
                COUNT(*) AS execs,
                SUM(input_tokens) AS ti, SUM(output_tokens) AS "to",
                SUM(cached_input_tokens) AS ci, SUM(total_tokens) AS tt,
                SUM(cost_usd) AS cost, SUM(llm_call_count) AS calls,
                AVG(duration_ms) AS avgd
         FROM usage_events ${where}
         GROUP BY project_id
         ORDER BY cost DESC, tt DESC
         LIMIT ${limit}`,
        params
      );
      return rows.map((r) => ({
        bucket: r.project_id ? toString(r.project_id) : "(none)",
        projectId: r.project_id ? toString(r.project_id) : null,
        executions: toNumber(r.execs),
        inputTokens: toNumber(r.ti ?? 0),
        outputTokens: toNumber(r.to ?? 0),
        cachedInputTokens: toNumber(r.ci ?? 0),
        totalTokens: toNumber(r.tt ?? 0),
        costUsd: Number(r.cost ?? 0),
        llmCallCount: toNumber(r.calls ?? 0),
        avgDurationMs: Math.round(Number(r.avgd ?? 0))
      }));
    }

    // groupBy === "provider": providers_json is per-execution, so we need to
    // unfold it client-side. For typical fleet sizes (<10k events / window)
    // this is fine; for large fleets a denormalized usage_event_providers
    // table is the obvious follow-up.
    const rows = this.queryAll<{
      providers_json: string | null;
      ti: number; to: number; ci: number; tt: number;
      cost: number; calls: number; duration: number;
    }>(
      `SELECT providers_json, input_tokens AS ti, output_tokens AS "to",
              cached_input_tokens AS ci, total_tokens AS tt,
              cost_usd AS cost, llm_call_count AS calls, duration_ms AS duration
       FROM usage_events ${where}`,
      params
    );
    type Agg = {
      providerId: string; model: string;
      executions: number; inputTokens: number; outputTokens: number;
      cachedInputTokens: number; totalTokens: number; costUsd: number;
      llmCallCount: number; totalDurationMs: number;
    };
    const agg = new Map<string, Agg>();
    for (const r of rows) {
      const providers = r.providers_json
        ? (JSON.parse(toString(r.providers_json)) as Array<{ providerId: string; model: string; calls: number }>)
        : [];
      if (providers.length === 0) continue;
      const totalCalls = providers.reduce((s, p) => s + (p.calls || 0), 0) || 1;
      for (const p of providers) {
        const key = `${p.providerId}::${p.model}`;
        const share = (p.calls || 0) / totalCalls;
        const cur = agg.get(key) ?? {
          providerId: p.providerId, model: p.model,
          executions: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0,
          totalTokens: 0, costUsd: 0, llmCallCount: 0, totalDurationMs: 0
        };
        cur.executions += 1;
        cur.inputTokens += Math.round(toNumber(r.ti ?? 0) * share);
        cur.outputTokens += Math.round(toNumber(r.to ?? 0) * share);
        cur.cachedInputTokens += Math.round(toNumber(r.ci ?? 0) * share);
        cur.totalTokens += Math.round(toNumber(r.tt ?? 0) * share);
        cur.costUsd += Number(r.cost ?? 0) * share;
        cur.llmCallCount += p.calls || 0;
        cur.totalDurationMs += Math.round(toNumber(r.duration ?? 0) * share);
        agg.set(key, cur);
      }
    }
    return Array.from(agg.values())
      .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens)
      .slice(0, limit)
      .map((a) => ({
        bucket: `${a.providerId} / ${a.model}`,
        providerId: a.providerId,
        model: a.model,
        executions: a.executions,
        inputTokens: a.inputTokens,
        outputTokens: a.outputTokens,
        cachedInputTokens: a.cachedInputTokens,
        totalTokens: a.totalTokens,
        costUsd: a.costUsd,
        llmCallCount: a.llmCallCount,
        avgDurationMs: a.executions > 0 ? Math.round(a.totalDurationMs / a.executions) : 0
      }));
  }

  /**
   * Single-row totals for the dashboard KPI cards.
   * `userKey` matches either `user_id` OR `user_email` so user-scope budgets
   * can be expressed by either identifier (Phase 8.3).
   */
  queryUsageTotals(input: {
    from: string;
    to: string;
    workflowId?: string;
    userId?: string;
    userKey?: string;
    projectId?: string;
  }): {
    executions: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    totalTokens: number;
    costUsd: number;
    llmCallCount: number;
    avgDurationMs: number;
  } {
    const filters: string[] = ["created_at >= ?", "created_at < ?"];
    const params: Array<string | number> = [input.from, input.to];
    if (input.workflowId) { filters.push("workflow_id = ?"); params.push(input.workflowId); }
    if (input.userId) { filters.push("user_id = ?"); params.push(input.userId); }
    if (input.userKey) {
      filters.push("(user_id = ? OR user_email = ?)");
      params.push(input.userKey, input.userKey);
    }
    if (input.projectId) { filters.push("project_id = ?"); params.push(input.projectId); }
    const row = this.queryOne<{
      execs: number; ti: number; to: number; ci: number; tt: number;
      cost: number; calls: number; avgd: number;
    }>(
      `SELECT COUNT(*) AS execs,
              SUM(input_tokens) AS ti, SUM(output_tokens) AS "to",
              SUM(cached_input_tokens) AS ci, SUM(total_tokens) AS tt,
              SUM(cost_usd) AS cost, SUM(llm_call_count) AS calls,
              AVG(duration_ms) AS avgd
       FROM usage_events WHERE ${filters.join(" AND ")}`,
      params
    );
    return {
      executions: toNumber(row?.execs ?? 0),
      inputTokens: toNumber(row?.ti ?? 0),
      outputTokens: toNumber(row?.to ?? 0),
      cachedInputTokens: toNumber(row?.ci ?? 0),
      totalTokens: toNumber(row?.tt ?? 0),
      costUsd: Number(row?.cost ?? 0),
      llmCallCount: toNumber(row?.calls ?? 0),
      avgDurationMs: Math.round(Number(row?.avgd ?? 0))
    };
  }

  /**
   * Recent usage events (with cost), most-recent first. Powers the FinOps
   * "recent runs" panel.
   */
  listUsageEvents(input: { limit?: number; workflowId?: string; userId?: string; projectId?: string } = {}): Array<{
    id: string; executionId: string; workflowId: string; workflowName: string | null;
    userId: string | null; userEmail: string | null; projectId: string | null;
    triggerType: string | null; status: string;
    inputTokens: number; outputTokens: number; cachedInputTokens: number;
    totalTokens: number; costUsd: number; llmCallCount: number; durationMs: number;
    providers: Array<{ providerId: string; model: string; calls: number }>;
    createdAt: string;
  }> {
    const filters: string[] = [];
    const params: Array<string | number> = [];
    if (input.workflowId) { filters.push("workflow_id = ?"); params.push(input.workflowId); }
    if (input.userId) { filters.push("user_id = ?"); params.push(input.userId); }
    if (input.projectId) { filters.push("project_id = ?"); params.push(input.projectId); }
    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    const limit = Math.min(input.limit ?? 50, 500);
    const rows = this.queryAll<{
      id: string; execution_id: string; workflow_id: string; workflow_name: string | null;
      user_id: string | null; user_email: string | null; project_id: string | null;
      trigger_type: string | null; status: string;
      input_tokens: number; output_tokens: number; cached_input_tokens: number;
      total_tokens: number; cost_usd: number; llm_call_count: number; duration_ms: number;
      providers_json: string | null; created_at: string;
    }>(
      `SELECT * FROM usage_events ${where} ORDER BY created_at DESC LIMIT ${limit}`,
      params
    );
    return rows.map((r) => ({
      id: toString(r.id),
      executionId: toString(r.execution_id),
      workflowId: toString(r.workflow_id),
      workflowName: r.workflow_name ? toString(r.workflow_name) : null,
      userId: r.user_id ? toString(r.user_id) : null,
      userEmail: r.user_email ? toString(r.user_email) : null,
      projectId: r.project_id ? toString(r.project_id) : null,
      triggerType: r.trigger_type ? toString(r.trigger_type) : null,
      status: toString(r.status),
      inputTokens: toNumber(r.input_tokens),
      outputTokens: toNumber(r.output_tokens),
      cachedInputTokens: toNumber(r.cached_input_tokens),
      totalTokens: toNumber(r.total_tokens),
      costUsd: Number(r.cost_usd),
      llmCallCount: toNumber(r.llm_call_count),
      durationMs: toNumber(r.duration_ms),
      providers: r.providers_json
        ? (JSON.parse(toString(r.providers_json)) as Array<{ providerId: string; model: string; calls: number }>)
        : [],
      createdAt: toString(r.created_at)
    }));
  }

  // ---------------------------------------------------------------------------
  // Phase 8.3 — budgets + budget_alerts
  // ---------------------------------------------------------------------------

  createBudget(input: {
    id: string;
    name: string;
    scopeType: "global" | "project" | "workflow" | "user";
    scopeId?: string | null;
    period: "day" | "week" | "month";
    limitType: "usd" | "tokens";
    limitValue: number;
    warnThresholdPct?: number;
    action: "warn" | "block";
    notifyChannel?: string | null;
    enabled?: boolean;
    createdBy?: string | null;
  }): void {
    const now = new Date().toISOString();
    this.exec(
      `INSERT INTO budgets (
         id, name, scope_type, scope_id, period, limit_type, limit_value,
         warn_threshold_pct, action, notify_channel, enabled, created_by,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.name,
        input.scopeType,
        input.scopeId ?? null,
        input.period,
        input.limitType,
        input.limitValue,
        input.warnThresholdPct ?? 0.8,
        input.action,
        input.notifyChannel ?? null,
        input.enabled === false ? 0 : 1,
        input.createdBy ?? null,
        now,
        now
      ]
    );
    this.persist();
  }

  updateBudget(id: string, patch: {
    name?: string;
    limitValue?: number;
    warnThresholdPct?: number;
    action?: "warn" | "block";
    notifyChannel?: string | null;
    enabled?: boolean;
  }): boolean {
    const fields: string[] = [];
    const params: Array<string | number | null> = [];
    if (patch.name !== undefined) { fields.push("name = ?"); params.push(patch.name); }
    if (patch.limitValue !== undefined) { fields.push("limit_value = ?"); params.push(patch.limitValue); }
    if (patch.warnThresholdPct !== undefined) { fields.push("warn_threshold_pct = ?"); params.push(patch.warnThresholdPct); }
    if (patch.action !== undefined) { fields.push("action = ?"); params.push(patch.action); }
    if (patch.notifyChannel !== undefined) { fields.push("notify_channel = ?"); params.push(patch.notifyChannel); }
    if (patch.enabled !== undefined) { fields.push("enabled = ?"); params.push(patch.enabled ? 1 : 0); }
    if (fields.length === 0) return false;
    fields.push("updated_at = ?");
    params.push(new Date().toISOString());
    params.push(id);
    this.exec(`UPDATE budgets SET ${fields.join(", ")} WHERE id = ?`, params);
    this.persist();
    return true;
  }

  deleteBudget(id: string): boolean {
    this.exec(`DELETE FROM budget_alerts WHERE budget_id = ?`, [id]);
    this.exec(`DELETE FROM budgets WHERE id = ?`, [id]);
    this.persist();
    return true;
  }

  getBudget(id: string): BudgetRecord | null {
    const row = this.queryOne<BudgetRow>(`SELECT * FROM budgets WHERE id = ?`, [id]);
    return row ? mapBudget(row) : null;
  }

  listBudgets(filter: { enabledOnly?: boolean; scopeType?: string; scopeId?: string } = {}): BudgetRecord[] {
    const filters: string[] = [];
    const params: Array<string | number> = [];
    if (filter.enabledOnly) { filters.push("enabled = 1"); }
    if (filter.scopeType) { filters.push("scope_type = ?"); params.push(filter.scopeType); }
    if (filter.scopeId !== undefined) {
      if (filter.scopeId === "") {
        filters.push("(scope_id IS NULL OR scope_id = '')");
      } else {
        filters.push("scope_id = ?");
        params.push(filter.scopeId);
      }
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    const rows = this.queryAll<BudgetRow>(
      `SELECT * FROM budgets ${where} ORDER BY scope_type, name`,
      params
    );
    return rows.map(mapBudget);
  }

  recordBudgetAlert(input: {
    id: string;
    budgetId: string;
    periodStart: string;
    severity: "warn" | "block";
    usageValue: number;
    limitValue: number;
    workflowId?: string | null;
    executionId?: string | null;
    message?: string;
  }): void {
    this.exec(
      `INSERT INTO budget_alerts (
         id, budget_id, period_start, severity, usage_value, limit_value,
         workflow_id, execution_id, message, fired_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.budgetId,
        input.periodStart,
        input.severity,
        input.usageValue,
        input.limitValue,
        input.workflowId ?? null,
        input.executionId ?? null,
        input.message ?? null,
        new Date().toISOString()
      ]
    );
    this.persist();
  }

  /**
   * Most recent alert for a (budget, period) pair. Used to debounce — we
   * only fire one warn / one block per period+budget combination so users
   * don't get spammed across every execution after a threshold is crossed.
   */
  getLatestBudgetAlert(budgetId: string, periodStart: string, severity: "warn" | "block"): { id: string; firedAt: string } | null {
    const row = this.queryOne<{ id: string; fired_at: string }>(
      `SELECT id, fired_at FROM budget_alerts
       WHERE budget_id = ? AND period_start = ? AND severity = ?
       ORDER BY fired_at DESC LIMIT 1`,
      [budgetId, periodStart, severity]
    );
    return row ? { id: toString(row.id), firedAt: toString(row.fired_at) } : null;
  }

  listBudgetAlerts(filter: { budgetId?: string; limit?: number } = {}): Array<{
    id: string; budgetId: string; periodStart: string;
    severity: string; usageValue: number; limitValue: number;
    workflowId: string | null; executionId: string | null;
    message: string | null; firedAt: string;
  }> {
    const filters: string[] = [];
    const params: Array<string | number> = [];
    if (filter.budgetId) { filters.push("budget_id = ?"); params.push(filter.budgetId); }
    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    const limit = Math.min(filter.limit ?? 100, 500);
    const rows = this.queryAll<{
      id: string; budget_id: string; period_start: string;
      severity: string; usage_value: number; limit_value: number;
      workflow_id: string | null; execution_id: string | null;
      message: string | null; fired_at: string;
    }>(
      `SELECT * FROM budget_alerts ${where} ORDER BY fired_at DESC LIMIT ${limit}`,
      params
    );
    return rows.map((r) => ({
      id: toString(r.id),
      budgetId: toString(r.budget_id),
      periodStart: toString(r.period_start),
      severity: toString(r.severity),
      usageValue: Number(r.usage_value),
      limitValue: Number(r.limit_value),
      workflowId: r.workflow_id ? toString(r.workflow_id) : null,
      executionId: r.execution_id ? toString(r.execution_id) : null,
      message: r.message ? toString(r.message) : null,
      firedAt: toString(r.fired_at)
    }));
  }

  // ---------------------------------------------------------------------------
  // Phase 8.4 — audit export destinations
  // ---------------------------------------------------------------------------

  createAuditExportDestination(input: {
    id: string;
    name: string;
    kind: "http" | "file";
    config: Record<string, unknown>;
    intervalSeconds?: number;
    enabled?: boolean;
    createdBy?: string | null;
  }): void {
    const now = new Date().toISOString();
    this.exec(
      `INSERT INTO audit_export_destinations
         (id, name, kind, config_json, interval_seconds, enabled, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.name,
        input.kind,
        JSON.stringify(input.config),
        input.intervalSeconds ?? 3600,
        input.enabled === false ? 0 : 1,
        input.createdBy ?? null,
        now,
        now
      ]
    );
    this.persist();
  }

  updateAuditExportDestination(id: string, patch: {
    name?: string;
    config?: Record<string, unknown>;
    intervalSeconds?: number;
    enabled?: boolean;
  }): boolean {
    const fields: string[] = [];
    const params: Array<string | number | null> = [];
    if (patch.name !== undefined) { fields.push("name = ?"); params.push(patch.name); }
    if (patch.config !== undefined) { fields.push("config_json = ?"); params.push(JSON.stringify(patch.config)); }
    if (patch.intervalSeconds !== undefined) { fields.push("interval_seconds = ?"); params.push(patch.intervalSeconds); }
    if (patch.enabled !== undefined) { fields.push("enabled = ?"); params.push(patch.enabled ? 1 : 0); }
    if (fields.length === 0) return false;
    fields.push("updated_at = ?");
    params.push(new Date().toISOString());
    params.push(id);
    this.exec(`UPDATE audit_export_destinations SET ${fields.join(", ")} WHERE id = ?`, params);
    this.persist();
    return true;
  }

  deleteAuditExportDestination(id: string): boolean {
    this.exec(`DELETE FROM audit_export_runs WHERE destination_id = ?`, [id]);
    this.exec(`DELETE FROM audit_export_destinations WHERE id = ?`, [id]);
    this.persist();
    return true;
  }

  listAuditExportDestinations(): Array<{
    id: string; name: string; kind: string; config: Record<string, unknown>;
    intervalSeconds: number; enabled: boolean;
    lastExportId: string | null; lastExportAt: string | null;
    lastStatus: string | null; lastError: string | null;
    createdBy: string | null; createdAt: string; updatedAt: string;
  }> {
    const rows = this.queryAll<{
      id: string; name: string; kind: string; config_json: string;
      interval_seconds: number; enabled: number;
      last_export_id: string | null; last_export_at: string | null;
      last_status: string | null; last_error: string | null;
      created_by: string | null; created_at: string; updated_at: string;
    }>(
      `SELECT * FROM audit_export_destinations ORDER BY name`
    );
    return rows.map((r) => ({
      id: toString(r.id),
      name: toString(r.name),
      kind: toString(r.kind),
      config: r.config_json ? (JSON.parse(toString(r.config_json)) as Record<string, unknown>) : {},
      intervalSeconds: toNumber(r.interval_seconds),
      enabled: toNumber(r.enabled) === 1,
      lastExportId: r.last_export_id ? toString(r.last_export_id) : null,
      lastExportAt: r.last_export_at ? toString(r.last_export_at) : null,
      lastStatus: r.last_status ? toString(r.last_status) : null,
      lastError: r.last_error ? toString(r.last_error) : null,
      createdBy: r.created_by ? toString(r.created_by) : null,
      createdAt: toString(r.created_at),
      updatedAt: toString(r.updated_at)
    }));
  }

  getAuditExportDestination(id: string) {
    return this.listAuditExportDestinations().find((d) => d.id === id) ?? null;
  }

  /**
   * Pull audit_logs strictly newer than `cursor.id` (or all rows when cursor
   * is null). Used by AuditExportService to ship batches incrementally.
   * Ordered by (created_at, id) ASC so cursor-based pagination is stable
   * across concurrent inserts.
   */
  listAuditLogsAfter(input: { afterId: string | null; limit: number }): Array<{
    id: string; eventType: string; category: string; action: string; outcome: string;
    actorUserId: string | null; actorEmail: string | null; actorType: string;
    resourceType: string | null; resourceId: string | null; projectId: string | null;
    ipAddress: string | null; userAgent: string | null; metadata: unknown;
    message: string | null; createdAt: string; entryHash: string | null;
  }> {
    const limit = Math.min(Math.max(input.limit, 1), 5000);
    // SQLite's rowid is the canonical insertion-order key. We CANNOT use the
    // text id for ordering because it's a nanoid (random — not lexicographic
    // monotonic) and we CANNOT use created_at alone because rapid inserts
    // share the same millisecond. rowid resolves both.
    let where = "";
    const params: Array<string | number> = [];
    if (input.afterId) {
      const cursorRow = this.queryOne<{ rid: number }>(
        `SELECT rowid AS rid FROM audit_logs WHERE id = ?`,
        [input.afterId]
      );
      if (cursorRow) {
        where = `WHERE rowid > ?`;
        params.push(toNumber(cursorRow.rid));
      }
    }
    const rows = this.queryAll<{
      id: string; event_type: string; category: string; action: string; outcome: string;
      actor_user_id: string | null; actor_email: string | null; actor_type: string;
      resource_type: string | null; resource_id: string | null; project_id: string | null;
      ip_address: string | null; user_agent: string | null; metadata_json: string | null;
      message: string | null; created_at: string; entry_hash: string | null;
    }>(
      `SELECT id, event_type, category, action, outcome, actor_user_id, actor_email, actor_type,
              resource_type, resource_id, project_id, ip_address, user_agent, metadata_json, message,
              created_at, entry_hash
       FROM audit_logs ${where}
       ORDER BY rowid ASC LIMIT ?`,
      [...params, limit]
    );
    return rows.map((r) => ({
      id: toString(r.id),
      eventType: toString(r.event_type),
      category: toString(r.category),
      action: toString(r.action),
      outcome: toString(r.outcome),
      actorUserId: r.actor_user_id ? toString(r.actor_user_id) : null,
      actorEmail: r.actor_email ? toString(r.actor_email) : null,
      actorType: toString(r.actor_type),
      resourceType: r.resource_type ? toString(r.resource_type) : null,
      resourceId: r.resource_id ? toString(r.resource_id) : null,
      projectId: r.project_id ? toString(r.project_id) : null,
      ipAddress: r.ip_address ? toString(r.ip_address) : null,
      userAgent: r.user_agent ? toString(r.user_agent) : null,
      metadata: r.metadata_json ? safeJsonParse(toString(r.metadata_json)) : null,
      message: r.message ? toString(r.message) : null,
      createdAt: toString(r.created_at),
      entryHash: r.entry_hash ? toString(r.entry_hash) : null
    }));
  }

  recordAuditExportRun(input: {
    id: string;
    destinationId: string;
    startedAt: string;
    completedAt: string;
    status: "success" | "failure" | "partial";
    rowsExported: number;
    firstId?: string | null;
    lastId?: string | null;
    error?: string | null;
  }): void {
    this.exec(
      `INSERT INTO audit_export_runs
         (id, destination_id, started_at, completed_at, status, rows_exported, first_id, last_id, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.destinationId,
        input.startedAt,
        input.completedAt,
        input.status,
        input.rowsExported,
        input.firstId ?? null,
        input.lastId ?? null,
        input.error ?? null
      ]
    );
    if (input.status === "success" && input.lastId) {
      this.exec(
        `UPDATE audit_export_destinations
         SET last_export_id = ?, last_export_at = ?, last_status = ?, last_error = NULL, updated_at = ?
         WHERE id = ?`,
        [input.lastId, input.completedAt, input.status, new Date().toISOString(), input.destinationId]
      );
    } else if (input.status === "failure") {
      this.exec(
        `UPDATE audit_export_destinations
         SET last_status = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
        [input.status, input.error ?? "unknown", new Date().toISOString(), input.destinationId]
      );
    }
    this.persist();
  }

  listAuditExportRuns(destinationId: string, limit = 25): Array<{
    id: string; destinationId: string; startedAt: string; completedAt: string | null;
    status: string; rowsExported: number; firstId: string | null; lastId: string | null;
    error: string | null;
  }> {
    const rows = this.queryAll<{
      id: string; destination_id: string; started_at: string; completed_at: string | null;
      status: string; rows_exported: number; first_id: string | null; last_id: string | null;
      error: string | null;
    }>(
      `SELECT * FROM audit_export_runs WHERE destination_id = ? ORDER BY started_at DESC LIMIT ?`,
      [destinationId, Math.min(Math.max(limit, 1), 200)]
    );
    return rows.map((r) => ({
      id: toString(r.id),
      destinationId: toString(r.destination_id),
      startedAt: toString(r.started_at),
      completedAt: r.completed_at ? toString(r.completed_at) : null,
      status: toString(r.status),
      rowsExported: toNumber(r.rows_exported),
      firstId: r.first_id ? toString(r.first_id) : null,
      lastId: r.last_id ? toString(r.last_id) : null,
      error: r.error ? toString(r.error) : null
    }));
  }

  // ---------------------------------------------------------------------------
  // Phase 9.1 — knowledge_bases (built-in persistent vector store)
  // ---------------------------------------------------------------------------

  createKnowledgeBase(input: {
    id: string;
    name: string;
    description?: string | null;
    projectId?: string | null;
    embedderId: string;
    embedderConfig?: Record<string, unknown>;
    dimensions?: number;
    createdBy?: string | null;
  }): void {
    const now = new Date().toISOString();
    this.exec(
      `INSERT INTO knowledge_bases (
         id, name, description, project_id, embedder_id, embedder_config_json,
         dimensions, chunk_count, created_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      [
        input.id,
        input.name,
        input.description ?? null,
        input.projectId ?? null,
        input.embedderId,
        input.embedderConfig ? JSON.stringify(input.embedderConfig) : null,
        input.dimensions ?? 0,
        input.createdBy ?? null,
        now,
        now
      ]
    );
    this.persist();
  }

  updateKnowledgeBase(id: string, patch: {
    name?: string;
    description?: string | null;
    embedderConfig?: Record<string, unknown>;
    dimensions?: number;
  }): boolean {
    const fields: string[] = [];
    const params: Array<string | number | null> = [];
    if (patch.name !== undefined) { fields.push("name = ?"); params.push(patch.name); }
    if (patch.description !== undefined) { fields.push("description = ?"); params.push(patch.description); }
    if (patch.embedderConfig !== undefined) {
      fields.push("embedder_config_json = ?");
      params.push(JSON.stringify(patch.embedderConfig));
    }
    if (patch.dimensions !== undefined) { fields.push("dimensions = ?"); params.push(patch.dimensions); }
    if (fields.length === 0) return false;
    fields.push("updated_at = ?");
    params.push(new Date().toISOString());
    params.push(id);
    this.exec(`UPDATE knowledge_bases SET ${fields.join(", ")} WHERE id = ?`, params);
    this.persist();
    return true;
  }

  deleteKnowledgeBase(id: string): boolean {
    this.exec(`DELETE FROM knowledge_base_chunks WHERE knowledge_base_id = ?`, [id]);
    this.exec(`DELETE FROM knowledge_bases WHERE id = ?`, [id]);
    this.persist();
    return true;
  }

  getKnowledgeBase(id: string): KnowledgeBaseRecord | null {
    const row = this.queryOne<KnowledgeBaseRow>(`SELECT * FROM knowledge_bases WHERE id = ?`, [id]);
    return row ? mapKnowledgeBase(row) : null;
  }

  listKnowledgeBases(filter: { projectId?: string } = {}): KnowledgeBaseRecord[] {
    const filters: string[] = [];
    const params: Array<string | number> = [];
    if (filter.projectId) { filters.push("project_id = ?"); params.push(filter.projectId); }
    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    const rows = this.queryAll<KnowledgeBaseRow>(
      `SELECT * FROM knowledge_bases ${where} ORDER BY name`,
      params
    );
    return rows.map(mapKnowledgeBase);
  }

  /**
   * Bulk insert chunks. Caller pre-embeds; we store the vector as JSON.
   * dimensions is locked on the first insert if it's still 0 — subsequent
   * inserts must match.
   */
  addKnowledgeBaseChunks(input: {
    knowledgeBaseId: string;
    chunks: Array<{
      id?: string;
      sourceId?: string | null;
      chunkIndex: number;
      content: string;
      metadata?: Record<string, unknown> | null;
      vector: number[];
    }>;
  }): { inserted: number; dimensions: number } {
    const kb = this.getKnowledgeBase(input.knowledgeBaseId);
    if (!kb) throw new Error(`Knowledge base not found: ${input.knowledgeBaseId}`);
    if (input.chunks.length === 0) return { inserted: 0, dimensions: kb.dimensions };

    const expectedDims = kb.dimensions > 0 ? kb.dimensions : input.chunks[0]!.vector.length;
    for (const c of input.chunks) {
      if (c.vector.length !== expectedDims) {
        throw new Error(
          `Vector dimension mismatch: expected ${expectedDims}, got ${c.vector.length} (chunk ${c.chunkIndex})`
        );
      }
    }

    const now = new Date().toISOString();
    for (const c of input.chunks) {
      this.exec(
        `INSERT INTO knowledge_base_chunks (
           id, knowledge_base_id, source_id, chunk_index, content, metadata_json, vector_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          c.id ?? `kbc_${randomUUID()}`,
          input.knowledgeBaseId,
          c.sourceId ?? null,
          c.chunkIndex,
          c.content,
          c.metadata ? JSON.stringify(c.metadata) : null,
          JSON.stringify(c.vector),
          now
        ]
      );
    }

    if (kb.dimensions === 0) {
      this.exec(
        `UPDATE knowledge_bases SET dimensions = ?, updated_at = ? WHERE id = ?`,
        [expectedDims, now, input.knowledgeBaseId]
      );
    }
    this.exec(
      `UPDATE knowledge_bases SET chunk_count = (SELECT COUNT(*) FROM knowledge_base_chunks WHERE knowledge_base_id = ?), updated_at = ? WHERE id = ?`,
      [input.knowledgeBaseId, now, input.knowledgeBaseId]
    );
    this.persist();
    return { inserted: input.chunks.length, dimensions: expectedDims };
  }

  /**
   * Pull every chunk for a KB. For Phase 9.1's hand-rolled cosine search
   * we score in JS — fine up to ~10k chunks per KB. Larger fleets should
   * push to pgvector or sqlite-vec (follow-up).
   */
  listKnowledgeBaseChunks(knowledgeBaseId: string): KnowledgeBaseChunkRecord[] {
    const rows = this.queryAll<KnowledgeBaseChunkRow>(
      `SELECT * FROM knowledge_base_chunks WHERE knowledge_base_id = ? ORDER BY rowid`,
      [knowledgeBaseId]
    );
    return rows.map(mapKnowledgeBaseChunk);
  }

  /**
   * Phase 9.3 — BM25 search via the FTS5 virtual table. Returns chunks with
   * a normalized score (higher = better, 0..1 after normalization). FTS5's
   * native bm25() returns negative values where 0 is best — we flip the sign
   * and rank-normalize so the result composes with cosine similarity in RRF.
   *
   * The user query is tokenized + each token wrapped as a phrase to escape
   * FTS5 special characters. Words shorter than 2 chars are dropped (FTS5's
   * default tokenizer indexes single characters but they hurt recall).
   */
  bm25SearchKnowledgeBase(input: {
    knowledgeBaseId: string;
    query: string;
    topK: number;
  }): Array<{
    id: string;
    sourceId: string | null;
    chunkIndex: number;
    content: string;
    metadata: Record<string, unknown> | null;
    score: number;
  }> {
    const ftsQuery = buildFts5Query(input.query);
    if (!ftsQuery) return [];
    const limit = Math.min(Math.max(input.topK, 1), 200);

    type Row = {
      id: string;
      source_id: string | null;
      chunk_index: number;
      content: string;
      metadata_json: string | null;
      raw_score: number;
    };
    let rows: Row[];
    try {
      rows = this.queryAll<Row>(
        `SELECT
           c.id AS id,
           c.source_id AS source_id,
           c.chunk_index AS chunk_index,
           c.content AS content,
           c.metadata_json AS metadata_json,
           bm25(knowledge_base_chunks_fts) AS raw_score
         FROM knowledge_base_chunks_fts
         JOIN knowledge_base_chunks c ON c.rowid = knowledge_base_chunks_fts.rowid
         WHERE knowledge_base_chunks_fts MATCH ?
           AND c.knowledge_base_id = ?
         ORDER BY raw_score
         LIMIT ?`,
        [ftsQuery, input.knowledgeBaseId, limit]
      );
    } catch {
      // Malformed query (rare with our escaping) — return empty rather than throw
      return [];
    }
    if (rows.length === 0) return [];

    // FTS5 bm25() yields negative scores in [-inf, 0] where lower is better.
    // Negate and min-max-normalize to [0, 1] for clean composition with
    // cosine similarity in RRF.
    const negated = rows.map((r) => -toNumber(r.raw_score));
    const min = Math.min(...negated);
    const max = Math.max(...negated);
    const range = max - min || 1;
    return rows.map((r, idx) => ({
      id: toString(r.id),
      sourceId: r.source_id ? toString(r.source_id) : null,
      chunkIndex: toNumber(r.chunk_index),
      content: toString(r.content),
      metadata: r.metadata_json
        ? (safeJsonParse(toString(r.metadata_json)) as Record<string, unknown>)
        : null,
      score: (negated[idx]! - min) / range
    }));
  }

  /** Preview chunks for the UI — content + metadata, no vectors. */
  listKnowledgeBaseChunkPreviews(input: { knowledgeBaseId: string; limit?: number; sourceId?: string }): Array<{
    id: string; sourceId: string | null; chunkIndex: number; content: string;
    metadata: Record<string, unknown> | null; createdAt: string;
  }> {
    const limit = Math.min(input.limit ?? 50, 500);
    const filters = ["knowledge_base_id = ?"];
    const params: Array<string | number> = [input.knowledgeBaseId];
    if (input.sourceId) { filters.push("source_id = ?"); params.push(input.sourceId); }
    const rows = this.queryAll<{
      id: string; source_id: string | null; chunk_index: number; content: string;
      metadata_json: string | null; created_at: string;
    }>(
      `SELECT id, source_id, chunk_index, content, metadata_json, created_at
       FROM knowledge_base_chunks WHERE ${filters.join(" AND ")} ORDER BY chunk_index LIMIT ?`,
      [...params, limit]
    );
    return rows.map((r) => ({
      id: toString(r.id),
      sourceId: r.source_id ? toString(r.source_id) : null,
      chunkIndex: toNumber(r.chunk_index),
      content: toString(r.content),
      metadata: r.metadata_json
        ? (safeJsonParse(toString(r.metadata_json)) as Record<string, unknown>)
        : null,
      createdAt: toString(r.created_at)
    }));
  }

  deleteKnowledgeBaseChunksBySource(input: { knowledgeBaseId: string; sourceId: string }): number {
    const before = this.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM knowledge_base_chunks WHERE knowledge_base_id = ? AND source_id = ?`,
      [input.knowledgeBaseId, input.sourceId]
    );
    const beforeCount = before ? toNumber(before.count) : 0;
    this.exec(
      `DELETE FROM knowledge_base_chunks WHERE knowledge_base_id = ? AND source_id = ?`,
      [input.knowledgeBaseId, input.sourceId]
    );
    const now = new Date().toISOString();
    this.exec(
      `UPDATE knowledge_bases SET chunk_count = (SELECT COUNT(*) FROM knowledge_base_chunks WHERE knowledge_base_id = ?), updated_at = ? WHERE id = ?`,
      [input.knowledgeBaseId, now, input.knowledgeBaseId]
    );
    this.persist();
    return beforeCount;
  }

  /**
   * Distinct source IDs in a KB with chunk counts. Powers the "Sources"
   * panel in the ingestion UI (Phase 9.2).
   */
  listKnowledgeBaseSources(knowledgeBaseId: string): Array<{ sourceId: string; chunkCount: number }> {
    const rows = this.queryAll<{ source_id: string | null; cnt: number }>(
      `SELECT source_id, COUNT(*) AS cnt FROM knowledge_base_chunks
       WHERE knowledge_base_id = ? AND source_id IS NOT NULL
       GROUP BY source_id ORDER BY source_id`,
      [knowledgeBaseId]
    );
    return rows.map((r) => ({
      sourceId: r.source_id ? toString(r.source_id) : "(unsourced)",
      chunkCount: toNumber(r.cnt)
    }));
  }

  // ---------------------------------------------------------------------------
  // Phase 10.1 — MCP server registry
  // ---------------------------------------------------------------------------

  createMcpServer(input: {
    id: string;
    name: string;
    description?: string | null;
    adapterId: string;
    connection?: Record<string, unknown>;
    secretId?: string | null;
    owner?: string | null;
    projectId?: string | null;
    probeEnabled?: boolean;
    probeIntervalMs?: number | null;
    blockOnBreakingChange?: boolean;
    sampling?: Partial<McpSamplingSettings> | null;
    sandbox?: McpSandboxSettings | null;
    /** Normalized (defaults filled in) before it is stored. */
    limits?: object | null;
    credentialMode?: McpCredentialMode;
    delegatedFallback?: McpDelegatedFallback;
    createdBy?: string | null;
  }): void {
    const now = new Date().toISOString();
    this.exec(
      `INSERT INTO mcp_servers (
         id, name, description, adapter_id, connection_json, secret_id, owner, project_id,
         probe_enabled, probe_interval_ms, block_on_breaking_change, status, tool_count,
         sampling_json, sandbox_json, limits_json, credential_mode, delegated_fallback,
         created_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.name,
        input.description ?? null,
        input.adapterId,
        JSON.stringify(input.connection ?? {}),
        input.secretId ?? null,
        input.owner ?? null,
        input.projectId ?? null,
        input.probeEnabled === false ? 0 : 1,
        input.probeIntervalMs ?? null,
        input.blockOnBreakingChange ? 1 : 0,
        input.sampling ? JSON.stringify(normalizeMcpSamplingSettings(input.sampling)) : null,
        input.sandbox ? JSON.stringify(input.sandbox) : null,
        input.limits ? JSON.stringify(normalizeMcpRuntimeLimits(input.limits)) : null,
        input.credentialMode ?? "service",
        input.delegatedFallback ?? "none",
        input.createdBy ?? null,
        now,
        now
      ]
    );
  }

  updateMcpServer(id: string, patch: {
    name?: string;
    description?: string | null;
    adapterId?: string;
    connection?: Record<string, unknown>;
    secretId?: string | null;
    owner?: string | null;
    projectId?: string | null;
    probeEnabled?: boolean;
    probeIntervalMs?: number | null;
    blockOnBreakingChange?: boolean;
    sampling?: Partial<McpSamplingSettings> | null;
    sandbox?: McpSandboxSettings | null;
    /** Normalized (defaults filled in) before it is stored. */
    limits?: object | null;
    credentialMode?: McpCredentialMode;
    delegatedFallback?: McpDelegatedFallback;
  }): boolean {
    const fields: string[] = [];
    const params: Array<string | number | null> = [];
    if (patch.sandbox !== undefined) {
      fields.push("sandbox_json = ?");
      params.push(patch.sandbox ? JSON.stringify(patch.sandbox) : null);
    }
    if (patch.limits !== undefined) {
      fields.push("limits_json = ?");
      params.push(patch.limits ? JSON.stringify(normalizeMcpRuntimeLimits(patch.limits)) : null);
    }
    if (patch.credentialMode !== undefined) { fields.push("credential_mode = ?"); params.push(patch.credentialMode); }
    if (patch.delegatedFallback !== undefined) { fields.push("delegated_fallback = ?"); params.push(patch.delegatedFallback); }
    if (patch.sampling !== undefined) {
      fields.push("sampling_json = ?");
      params.push(patch.sampling ? JSON.stringify(normalizeMcpSamplingSettings(patch.sampling)) : null);
    }
    if (patch.name !== undefined) { fields.push("name = ?"); params.push(patch.name); }
    if (patch.description !== undefined) { fields.push("description = ?"); params.push(patch.description); }
    if (patch.adapterId !== undefined) { fields.push("adapter_id = ?"); params.push(patch.adapterId); }
    if (patch.connection !== undefined) { fields.push("connection_json = ?"); params.push(JSON.stringify(patch.connection)); }
    if (patch.secretId !== undefined) { fields.push("secret_id = ?"); params.push(patch.secretId); }
    if (patch.owner !== undefined) { fields.push("owner = ?"); params.push(patch.owner); }
    if (patch.projectId !== undefined) { fields.push("project_id = ?"); params.push(patch.projectId); }
    if (patch.probeEnabled !== undefined) { fields.push("probe_enabled = ?"); params.push(patch.probeEnabled ? 1 : 0); }
    if (patch.probeIntervalMs !== undefined) { fields.push("probe_interval_ms = ?"); params.push(patch.probeIntervalMs); }
    if (patch.blockOnBreakingChange !== undefined) {
      fields.push("block_on_breaking_change = ?");
      params.push(patch.blockOnBreakingChange ? 1 : 0);
    }
    if (fields.length === 0) return false;
    fields.push("updated_at = ?");
    params.push(new Date().toISOString());
    params.push(id);
    this.exec(`UPDATE mcp_servers SET ${fields.join(", ")} WHERE id = ?`, params);
    return true;
  }

  deleteMcpServer(id: string): boolean {
    const existing = this.getMcpServer(id);
    if (!existing) return false;
    this.db.transaction(() => {
      this.exec(`DELETE FROM mcp_server_probes WHERE server_id = ?`, [id]);
      this.exec(`DELETE FROM mcp_tool_snapshots WHERE server_id = ?`, [id]);
      this.exec(`DELETE FROM mcp_tool_calls WHERE registry_server_id = ?`, [id]);
      this.exec(`DELETE FROM mcp_tool_classifications WHERE server_id = ?`, [id]);
      this.exec(`DELETE FROM mcp_toolset_members WHERE kind = 'server' AND server_id = ?`, [id]);
      this.exec(`DELETE FROM mcp_oauth_connections WHERE server_id = ?`, [id]);
      this.exec(`DELETE FROM mcp_user_oauth_connections WHERE server_id = ?`, [id]);
      this.exec(`DELETE FROM mcp_server_catalogs WHERE server_id = ?`, [id]);
      this.exec(`DELETE FROM mcp_servers WHERE id = ?`, [id]);
    })();
    return true;
  }

  /** Phase 10.7 — what the last probe found out about the server's sandbox. */
  setMcpServerSandboxStatus(id: string, status: McpSandboxStatus | null): void {
    this.exec(`UPDATE mcp_servers SET sandbox_status_json = ? WHERE id = ?`, [status ? JSON.stringify(status) : null, id]);
  }

  getMcpServer(id: string): McpServerRecord | null {
    const row = this.queryOne<McpServerRow>(`SELECT * FROM mcp_servers WHERE id = ?`, [id]);
    return row ? mapMcpServer(row) : null;
  }

  /** With a projectId: that project's servers plus deployment-wide ones (no project). */
  listMcpServers(filter: { projectId?: string } = {}): McpServerRecord[] {
    const rows = filter.projectId
      ? this.queryAll<McpServerRow>(
          `SELECT * FROM mcp_servers WHERE project_id = ? OR project_id IS NULL ORDER BY name`,
          [filter.projectId]
        )
      : this.queryAll<McpServerRow>(`SELECT * FROM mcp_servers ORDER BY name`);
    return rows.map(mapMcpServer);
  }

  /**
   * Record one probe and fold it into the server row. When the probe saw a new
   * tool schema, `snapshot` is stored and becomes the current one; a breaking
   * snapshot also becomes the pending one until someone accepts it.
   * `keepProbes` bounds the history kept per server.
   */
  recordMcpServerProbe(input: {
    probe: McpServerProbeRecord;
    status: McpServerStatus;
    snapshot?: Omit<McpToolSnapshotRecord, "acknowledgedAt" | "acknowledgedBy">;
    keepProbes: number;
  }): void {
    const { probe, snapshot } = input;
    this.db.transaction(() => {
      if (snapshot) {
        this.exec(
          `INSERT INTO mcp_tool_snapshots (
             id, server_id, hash, tools_json, tool_count, previous_snapshot_id, changes_json, breaking, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            snapshot.id,
            snapshot.serverId,
            snapshot.hash,
            JSON.stringify(snapshot.tools),
            snapshot.toolCount,
            snapshot.previousSnapshotId,
            JSON.stringify(snapshot.changes),
            snapshot.breaking ? 1 : 0,
            snapshot.createdAt
          ]
        );
      }
      this.exec(
        `INSERT INTO mcp_server_probes (id, server_id, started_at, ok, latency_ms, tool_count, error, snapshot_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          probe.id,
          probe.serverId,
          probe.startedAt,
          probe.ok ? 1 : 0,
          probe.latencyMs,
          probe.toolCount,
          probe.error,
          probe.snapshotId
        ]
      );
      const fields = [
        "status = ?",
        "last_probe_at = ?",
        "last_probe_ok = ?",
        "last_probe_latency_ms = ?",
        "last_probe_error = ?"
      ];
      const params: Array<string | number | null> = [
        input.status,
        probe.startedAt,
        probe.ok ? 1 : 0,
        probe.latencyMs,
        probe.error
      ];
      if (probe.ok) {
        fields.push("tool_count = ?");
        params.push(probe.toolCount);
      }
      if (snapshot) {
        fields.push("current_snapshot_id = ?");
        params.push(snapshot.id);
        if (snapshot.breaking) {
          fields.push("pending_breaking_snapshot_id = ?");
          params.push(snapshot.id);
        }
      }
      params.push(probe.serverId);
      this.exec(`UPDATE mcp_servers SET ${fields.join(", ")} WHERE id = ?`, params);
      this.exec(
        `DELETE FROM mcp_server_probes WHERE server_id = ? AND id NOT IN (
           SELECT id FROM mcp_server_probes WHERE server_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?
         )`,
        [probe.serverId, probe.serverId, input.keepProbes]
      );
    })();
  }

  listMcpServerProbes(serverId: string, limit = 100): McpServerProbeRecord[] {
    return this.queryAll<McpServerProbeRow>(
      `SELECT * FROM mcp_server_probes WHERE server_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?`,
      [serverId, limit]
    ).map(mapMcpServerProbe);
  }

  getMcpToolSnapshot(id: string): McpToolSnapshotRecord | null {
    const row = this.queryOne<McpToolSnapshotRow>(`SELECT * FROM mcp_tool_snapshots WHERE id = ?`, [id]);
    return row ? mapMcpToolSnapshot(row) : null;
  }

  listMcpToolSnapshots(serverId: string, limit = 50): McpToolSnapshotRecord[] {
    return this.queryAll<McpToolSnapshotRow>(
      `SELECT * FROM mcp_tool_snapshots WHERE server_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      [serverId, limit]
    ).map(mapMcpToolSnapshot);
  }

  /** Accept the pending breaking change: unblocks runs until the next breaking diff. */
  acknowledgeMcpBreakingChange(serverId: string, acknowledgedBy: string): McpToolSnapshotRecord | null {
    const server = this.getMcpServer(serverId);
    if (!server?.pendingBreakingSnapshotId) return null;
    const snapshotId = server.pendingBreakingSnapshotId;
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.exec(
        `UPDATE mcp_tool_snapshots SET acknowledged_at = ?, acknowledged_by = ? WHERE id = ?`,
        [now, acknowledgedBy, snapshotId]
      );
      this.exec(
        `UPDATE mcp_servers SET pending_breaking_snapshot_id = NULL, updated_at = ? WHERE id = ?`,
        [now, serverId]
      );
    })();
    return this.getMcpToolSnapshot(snapshotId);
  }

  /**
   * Replace the tool-call rows of one execution. Idempotent, so persisting the
   * same execution twice (for example after an approval resume) never
   * double-counts its calls.
   */
  replaceMcpToolCallsForExecution(executionId: string, calls: McpToolCallWrite[]): void {
    this.db.transaction(() => {
      // The gateway's own row for a workflow tool shares the execution id and is kept.
      this.exec(`DELETE FROM mcp_tool_calls WHERE execution_id = ? AND source = 'workflow'`, [executionId]);
      for (const call of calls) {
        this.insertMcpToolCallRow({ ...call, executionId });
      }
    })();
  }

  /** Phase 10.4 — one gateway call, recorded as it finishes. */
  insertMcpToolCall(call: McpToolCallWrite): void {
    this.insertMcpToolCallRow(call);
  }

  private insertMcpToolCallRow(call: McpToolCallWrite): void {
    this.exec(
      `INSERT INTO mcp_tool_calls (
         id, execution_id, workflow_id, node_id, registry_server_id, adapter_id, tool_name,
         started_at, duration_ms, ok, error, turn_input_tokens, turn_output_tokens,
         estimated_cost_usd, sampling_requests, sampling_input_tokens, sampling_output_tokens,
         source, client_id, rejection, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        call.id,
        call.executionId,
        call.workflowId,
        call.nodeId,
        call.registryServerId,
        call.adapterId,
        call.toolName,
        call.startedAt,
        call.durationMs,
        call.ok ? 1 : 0,
        call.error,
        call.turnInputTokens,
        call.turnOutputTokens,
        call.estimatedCostUsd,
        call.samplingRequests ?? null,
        call.samplingInputTokens ?? null,
        call.samplingOutputTokens ?? null,
        call.source ?? "workflow",
        call.clientId ?? null,
        call.rejection ?? null,
        new Date().toISOString()
      ]
    );
  }

  /** Phase 10.4 — gateway calls one client made since `since`. */
  listMcpToolCallsForClient(clientId: string, since: string): McpToolCallRecord[] {
    return this.queryAll<McpToolCallRow>(
      `SELECT * FROM mcp_tool_calls WHERE client_id = ? AND started_at >= ? ORDER BY started_at`,
      [clientId, since]
    ).map(mapMcpToolCall);
  }

  /** Phase 10.4 — calls, errors and last call per client since `since`. */
  summarizeMcpClientUsage(since: string): McpClientUsageRow[] {
    return this.queryAll<{ client_id: string; calls: number; errors: number; last_called_at: string | null }>(
      `SELECT client_id, COUNT(*) AS calls, SUM(CASE WHEN ok = 1 THEN 0 ELSE 1 END) AS errors,
              MAX(started_at) AS last_called_at
         FROM mcp_tool_calls
        WHERE client_id IS NOT NULL AND started_at >= ?
        GROUP BY client_id`,
      [since]
    ).map((row) => ({
      clientId: toString(row.client_id),
      calls: toNumber(row.calls),
      errors: toNumber(row.errors),
      lastCalledAt: row.last_called_at ? toString(row.last_called_at) : null
    }));
  }

  /**
   * Tool calls started at or after `since`. `registryServerId: null` selects
   * calls to inline-configured servers; a string selects one registry entry.
   */
  listMcpToolCalls(filter: { registryServerId: string | null; since: string }): McpToolCallRecord[] {
    const rows = filter.registryServerId === null
      ? this.queryAll<McpToolCallRow>(
          // Gateway rows without a registry server are workflow tools, not inline servers.
          `SELECT * FROM mcp_tool_calls WHERE registry_server_id IS NULL AND source = 'workflow' AND started_at >= ? ORDER BY started_at`,
          [filter.since]
        )
      : this.queryAll<McpToolCallRow>(
          `SELECT * FROM mcp_tool_calls WHERE registry_server_id = ? AND started_at >= ? ORDER BY started_at`,
          [filter.registryServerId, filter.since]
        );
    return rows.map(mapMcpToolCall);
  }

  // ---------------------------------------------------------------------------
  // Phase 10.2 — MCP tool policy
  // ---------------------------------------------------------------------------

  // Phase 10.5 — OAuth connection status rows (no tokens).

  getMcpOAuthConnection(serverId: string): McpOAuthConnectionRecord | null {
    const row = this.queryOne<McpOAuthConnectionRow>(`SELECT * FROM mcp_oauth_connections WHERE server_id = ?`, [serverId]);
    return row ? mapMcpOAuthConnection(row) : null;
  }

  upsertMcpOAuthConnection(record: Omit<McpOAuthConnectionRecord, "updatedAt">): McpOAuthConnectionRecord {
    const now = new Date().toISOString();
    this.exec(
      `INSERT INTO mcp_oauth_connections (
         server_id, secret_id, state, subject, scope, authorization_server, client_registration, client_id,
         expires_at, has_refresh_token, last_refresh_at, connected_at, connected_by, last_error, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(server_id) DO UPDATE SET
         secret_id = excluded.secret_id,
         state = excluded.state,
         subject = excluded.subject,
         scope = excluded.scope,
         authorization_server = excluded.authorization_server,
         client_registration = excluded.client_registration,
         client_id = excluded.client_id,
         expires_at = excluded.expires_at,
         has_refresh_token = excluded.has_refresh_token,
         last_refresh_at = excluded.last_refresh_at,
         connected_at = excluded.connected_at,
         connected_by = excluded.connected_by,
         last_error = excluded.last_error,
         updated_at = excluded.updated_at`,
      [
        record.serverId,
        record.secretId,
        record.state,
        record.subject,
        record.scope,
        record.authorizationServer,
        record.clientRegistration,
        record.clientId,
        record.expiresAt,
        record.hasRefreshToken ? 1 : 0,
        record.lastRefreshAt,
        record.connectedAt,
        record.connectedBy,
        record.lastError,
        now
      ]
    );
    return this.getMcpOAuthConnection(record.serverId)!;
  }

  // Phase 10.7 — per-user OAuth connections to delegated servers (no tokens).

  getMcpUserOAuthConnection(serverId: string, userId: string): McpUserOAuthConnectionRecord | null {
    const row = this.queryOne<McpUserOAuthConnectionRow>(
      `SELECT * FROM mcp_user_oauth_connections WHERE server_id = ? AND user_id = ?`,
      [serverId, userId]
    );
    return row ? mapMcpUserOAuthConnection(row) : null;
  }

  listMcpUserOAuthConnections(filter: { serverId?: string; userId?: string } = {}): McpUserOAuthConnectionRecord[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.serverId) {
      clauses.push("server_id = ?");
      params.push(filter.serverId);
    }
    if (filter.userId) {
      clauses.push("user_id = ?");
      params.push(filter.userId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.queryAll<McpUserOAuthConnectionRow>(
      `SELECT * FROM mcp_user_oauth_connections ${where} ORDER BY server_id, user_id`,
      params
    ).map(mapMcpUserOAuthConnection);
  }

  upsertMcpUserOAuthConnection(record: Omit<McpUserOAuthConnectionRecord, "updatedAt">): McpUserOAuthConnectionRecord {
    const now = new Date().toISOString();
    this.exec(
      `INSERT INTO mcp_user_oauth_connections (
         server_id, user_id, secret_id, state, subject, scope, authorization_server, client_registration,
         client_id, expires_at, has_refresh_token, last_refresh_at, connected_at, last_error, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(server_id, user_id) DO UPDATE SET
         secret_id = excluded.secret_id,
         state = excluded.state,
         subject = excluded.subject,
         scope = excluded.scope,
         authorization_server = excluded.authorization_server,
         client_registration = excluded.client_registration,
         client_id = excluded.client_id,
         expires_at = excluded.expires_at,
         has_refresh_token = excluded.has_refresh_token,
         last_refresh_at = excluded.last_refresh_at,
         connected_at = excluded.connected_at,
         last_error = excluded.last_error,
         updated_at = excluded.updated_at`,
      [
        record.serverId,
        record.userId,
        record.secretId,
        record.state,
        record.subject,
        record.scope,
        record.authorizationServer,
        record.clientRegistration,
        record.clientId,
        record.expiresAt,
        record.hasRefreshToken ? 1 : 0,
        record.lastRefreshAt,
        record.connectedAt,
        record.lastError,
        now
      ]
    );
    return this.getMcpUserOAuthConnection(record.serverId, record.userId)!;
  }

  deleteMcpUserOAuthConnection(serverId: string, userId: string): boolean {
    if (!this.getMcpUserOAuthConnection(serverId, userId)) return false;
    this.exec(`DELETE FROM mcp_user_oauth_connections WHERE server_id = ? AND user_id = ?`, [serverId, userId]);
    return true;
  }

  deleteMcpOAuthConnection(serverId: string): boolean {
    if (!this.getMcpOAuthConnection(serverId)) return false;
    this.exec(`DELETE FROM mcp_oauth_connections WHERE server_id = ?`, [serverId]);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Phase 10.5 — server catalogs (resources, templates, prompts) and elicitations
  // ---------------------------------------------------------------------------

  getMcpServerCatalog(serverId: string): McpServerCatalogRecord | null {
    const row = this.queryOne<McpServerCatalogRow>(`SELECT * FROM mcp_server_catalogs WHERE server_id = ?`, [serverId]);
    return row ? mapMcpServerCatalog(row) : null;
  }

  upsertMcpServerCatalog(serverId: string, catalog: Omit<McpServerCatalog, "updatedAt">): McpServerCatalogRecord {
    const now = new Date().toISOString();
    this.exec(
      `INSERT INTO mcp_server_catalogs (server_id, capabilities_json, resources_json, resource_templates_json, prompts_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(server_id) DO UPDATE SET
         capabilities_json = excluded.capabilities_json,
         resources_json = excluded.resources_json,
         resource_templates_json = excluded.resource_templates_json,
         prompts_json = excluded.prompts_json,
         updated_at = excluded.updated_at`,
      [
        serverId,
        JSON.stringify(catalog.capabilities ?? {}),
        JSON.stringify(catalog.resources ?? []),
        JSON.stringify(catalog.resourceTemplates ?? []),
        JSON.stringify(catalog.prompts ?? []),
        now
      ]
    );
    return this.getMcpServerCatalog(serverId)!;
  }

  createMcpElicitation(input: Omit<McpElicitationRecord, "status" | "createdAt" | "answeredAt" | "answeredBy" | "reason">): McpElicitationRecord {
    this.exec(
      `INSERT INTO mcp_elicitations (
         id, execution_id, workflow_id, workflow_name, node_id, server_id, registry_server_id, server_name,
         tool_name, message, schema_json, status, created_at, expires_at, created_by, trigger_type
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      [
        input.id,
        input.executionId,
        input.workflowId,
        input.workflowName ?? null,
        input.nodeId,
        input.serverId,
        input.registryServerId ?? null,
        input.serverName ?? null,
        input.toolName,
        input.message,
        JSON.stringify(input.requestedSchema),
        new Date().toISOString(),
        input.expiresAt,
        input.createdBy ?? null,
        input.triggerType ?? null
      ]
    );
    return this.getMcpElicitation(input.id)!;
  }

  getMcpElicitation(id: string): McpElicitationRecord | null {
    const row = this.queryOne<McpElicitationRow>(`SELECT * FROM mcp_elicitations WHERE id = ?`, [id]);
    return row ? mapMcpElicitation(row) : null;
  }

  listMcpElicitations(filter: { status?: McpElicitationStatus; executionId?: string; limit?: number } = {}): McpElicitationRecord[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filter.status) { where.push("status = ?"); params.push(filter.status); }
    if (filter.executionId) { where.push("execution_id = ?"); params.push(filter.executionId); }
    const limit = Math.max(1, Math.min(500, Math.floor(filter.limit ?? 100)));
    params.push(limit);
    return this.queryAll<McpElicitationRow>(
      `SELECT * FROM mcp_elicitations ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`,
      params
    ).map(mapMcpElicitation);
  }

  /** Settle an elicitation; returns false when it was already settled (first answer wins). */
  settleMcpElicitation(
    id: string,
    outcome: { status: Exclude<McpElicitationStatus, "pending">; answeredBy?: string | null; reason?: string | null }
  ): boolean {
    const current = this.getMcpElicitation(id);
    if (!current || current.status !== "pending") return false;
    this.exec(
      `UPDATE mcp_elicitations SET status = ?, answered_at = ?, answered_by = ?, reason = ? WHERE id = ? AND status = 'pending'`,
      [outcome.status, new Date().toISOString(), outcome.answeredBy ?? null, outcome.reason ?? null, id]
    );
    return true;
  }

  /** Mark every pending elicitation of an execution as expired (the run ended or the API restarted). */
  expireMcpElicitationsForExecution(executionId: string, reason: string): number {
    const pending = this.listMcpElicitations({ status: "pending", executionId, limit: 500 });
    for (const entry of pending) {
      this.settleMcpElicitation(entry.id, { status: "expired", reason });
    }
    return pending.length;
  }

  /** Pending elicitations whose deadline passed; the elicitation service expires them. */
  listExpiredMcpElicitations(now: string): McpElicitationRecord[] {
    return this.queryAll<McpElicitationRow>(`SELECT * FROM mcp_elicitations WHERE status = 'pending' AND expires_at <= ?`, [now]).map(
      mapMcpElicitation
    );
  }

  /** Rules in evaluation order: oldest first. */
  listMcpToolPolicies(): McpToolPolicyRule[] {
    return this.queryAll<McpToolPolicyRow>(`SELECT * FROM mcp_tool_policies ORDER BY created_at ASC, rowid ASC`).map(
      mapMcpToolPolicy
    );
  }

  getMcpToolPolicy(id: string): McpToolPolicyRule | null {
    const row = this.queryOne<McpToolPolicyRow>(`SELECT * FROM mcp_tool_policies WHERE id = ?`, [id]);
    return row ? mapMcpToolPolicy(row) : null;
  }

  createMcpToolPolicy(input: Omit<McpToolPolicyRule, "createdAt" | "updatedAt">): McpToolPolicyRule {
    const now = new Date().toISOString();
    this.exec(
      `INSERT INTO mcp_tool_policies (
         id, name, description, effect, project_id, roles_json, server_id, tool_pattern, annotation_hint, kind, enabled,
         created_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.name,
        input.description,
        input.effect,
        input.projectId,
        JSON.stringify(input.roles),
        input.serverId,
        input.toolPattern,
        input.annotationHint ?? null,
        input.kind ?? "tool",
        input.enabled ? 1 : 0,
        input.createdBy ?? null,
        now,
        now
      ]
    );
    return this.getMcpToolPolicy(input.id)!;
  }

  updateMcpToolPolicy(
    id: string,
    patch: Partial<
      Pick<McpToolPolicyRule, "name" | "description" | "effect" | "projectId" | "roles" | "serverId" | "toolPattern" | "annotationHint" | "kind" | "enabled">
    >
  ): McpToolPolicyRule | null {
    const fields: string[] = [];
    const params: Array<string | number | null> = [];
    if (patch.name !== undefined) { fields.push("name = ?"); params.push(patch.name); }
    if (patch.description !== undefined) { fields.push("description = ?"); params.push(patch.description); }
    if (patch.effect !== undefined) { fields.push("effect = ?"); params.push(patch.effect); }
    if (patch.projectId !== undefined) { fields.push("project_id = ?"); params.push(patch.projectId); }
    if (patch.roles !== undefined) { fields.push("roles_json = ?"); params.push(JSON.stringify(patch.roles)); }
    if (patch.serverId !== undefined) { fields.push("server_id = ?"); params.push(patch.serverId); }
    if (patch.toolPattern !== undefined) { fields.push("tool_pattern = ?"); params.push(patch.toolPattern); }
    if (patch.annotationHint !== undefined) { fields.push("annotation_hint = ?"); params.push(patch.annotationHint ?? null); }
    if (patch.kind !== undefined) { fields.push("kind = ?"); params.push(patch.kind ?? "tool"); }
    if (patch.enabled !== undefined) { fields.push("enabled = ?"); params.push(patch.enabled ? 1 : 0); }
    if (fields.length > 0) {
      fields.push("updated_at = ?");
      params.push(new Date().toISOString());
      params.push(id);
      this.exec(`UPDATE mcp_tool_policies SET ${fields.join(", ")} WHERE id = ?`, params);
    }
    return this.getMcpToolPolicy(id);
  }

  deleteMcpToolPolicy(id: string): boolean {
    if (!this.getMcpToolPolicy(id)) return false;
    this.exec(`DELETE FROM mcp_tool_policies WHERE id = ?`, [id]);
    return true;
  }

  /** Admin read-only overrides; all of them, or one registry server's. */
  listMcpToolClassifications(registryServerId?: string): McpToolClassificationOverride[] {
    const rows = registryServerId
      ? this.queryAll<McpToolClassificationRow>(
          `SELECT * FROM mcp_tool_classifications WHERE server_id = ? ORDER BY tool_name`,
          [registryServerId]
        )
      : this.queryAll<McpToolClassificationRow>(`SELECT * FROM mcp_tool_classifications ORDER BY server_id, tool_name`);
    return rows.map(mapMcpToolClassification);
  }

  /** `readOnly: null` removes the override, so annotations decide again. */
  setMcpToolClassification(input: {
    registryServerId: string;
    toolName: string;
    readOnly: boolean | null;
    setBy: string | null;
  }): McpToolClassificationOverride | null {
    if (input.readOnly === null) {
      this.exec(`DELETE FROM mcp_tool_classifications WHERE server_id = ? AND tool_name = ?`, [
        input.registryServerId,
        input.toolName
      ]);
      return null;
    }
    const now = new Date().toISOString();
    this.exec(
      `INSERT INTO mcp_tool_classifications (server_id, tool_name, read_only, set_by, set_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(server_id, tool_name) DO UPDATE SET
         read_only = excluded.read_only,
         set_by = excluded.set_by,
         set_at = excluded.set_at`,
      [input.registryServerId, input.toolName, input.readOnly ? 1 : 0, input.setBy, now]
    );
    return {
      registryServerId: input.registryServerId,
      toolName: input.toolName,
      readOnly: input.readOnly,
      setBy: input.setBy,
      setAt: now
    };
  }

  // ---------------------------------------------------------------------------
  // Phase 10.4 — MCP gateway toolsets and client credentials
  // ---------------------------------------------------------------------------

  private listMcpToolsetMembers(toolsetId: string): McpToolsetMember[] {
    return this.queryAll<McpToolsetMemberRow>(
      `SELECT * FROM mcp_toolset_members WHERE toolset_id = ? ORDER BY position ASC, rowid ASC`,
      [toolsetId]
    )
      .map(mapMcpToolsetMember)
      .filter((member): member is McpToolsetMember => member !== null);
  }

  private writeMcpToolsetMembers(toolsetId: string, members: Array<McpToolsetMemberSpec & { id?: string }>): void {
    this.exec(`DELETE FROM mcp_toolset_members WHERE toolset_id = ?`, [toolsetId]);
    members.forEach((member, index) => {
      this.exec(
        `INSERT INTO mcp_toolset_members (id, toolset_id, kind, workflow_id, server_id, tool_glob, position)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          member.id ?? `mtm_${randomUUID()}`,
          toolsetId,
          member.kind,
          member.kind === "workflow" ? member.workflowId : null,
          member.kind === "server" ? member.serverId : null,
          member.kind === "server" ? member.toolGlob ?? null : null,
          index
        ]
      );
    });
  }

  listMcpToolsets(): McpToolset[] {
    return this.queryAll<McpToolsetRow>(`SELECT * FROM mcp_toolsets ORDER BY name COLLATE NOCASE, slug`).map((row) =>
      mapMcpToolset(row, this.listMcpToolsetMembers(toString(row.id)))
    );
  }

  getMcpToolset(id: string): McpToolset | null {
    const row = this.queryOne<McpToolsetRow>(`SELECT * FROM mcp_toolsets WHERE id = ?`, [id]);
    return row ? mapMcpToolset(row, this.listMcpToolsetMembers(toString(row.id))) : null;
  }

  getMcpToolsetBySlug(slug: string): McpToolset | null {
    const row = this.queryOne<McpToolsetRow>(`SELECT * FROM mcp_toolsets WHERE slug = ?`, [slug]);
    return row ? mapMcpToolset(row, this.listMcpToolsetMembers(toString(row.id))) : null;
  }

  createMcpToolset(input: {
    id: string;
    slug: string;
    name: string;
    description: string | null;
    projectId: string | null;
    enabled: boolean;
    createdBy: string | null;
    members: McpToolsetMemberSpec[];
  }): McpToolset {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.exec(
        `INSERT INTO mcp_toolsets (id, slug, name, description, project_id, enabled, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.id, input.slug, input.name, input.description, input.projectId, input.enabled ? 1 : 0, input.createdBy, now, now]
      );
      this.writeMcpToolsetMembers(input.id, input.members);
    })();
    return this.getMcpToolset(input.id)!;
  }

  updateMcpToolset(
    id: string,
    patch: {
      slug?: string;
      name?: string;
      description?: string | null;
      projectId?: string | null;
      enabled?: boolean;
      members?: Array<McpToolsetMemberSpec & { id?: string }>;
    }
  ): McpToolset | null {
    if (!this.getMcpToolset(id)) return null;
    const fields: string[] = [];
    const params: Array<string | number | null> = [];
    if (patch.slug !== undefined) { fields.push("slug = ?"); params.push(patch.slug); }
    if (patch.name !== undefined) { fields.push("name = ?"); params.push(patch.name); }
    if (patch.description !== undefined) { fields.push("description = ?"); params.push(patch.description); }
    if (patch.projectId !== undefined) { fields.push("project_id = ?"); params.push(patch.projectId); }
    if (patch.enabled !== undefined) { fields.push("enabled = ?"); params.push(patch.enabled ? 1 : 0); }
    fields.push("updated_at = ?");
    params.push(new Date().toISOString());
    params.push(id);
    this.db.transaction(() => {
      this.exec(`UPDATE mcp_toolsets SET ${fields.join(", ")} WHERE id = ?`, params);
      if (patch.members !== undefined) {
        this.writeMcpToolsetMembers(id, patch.members);
      }
    })();
    return this.getMcpToolset(id);
  }

  /** Deletes the toolset and its members, and drops it from every client's scope. */
  deleteMcpToolset(id: string): boolean {
    if (!this.getMcpToolset(id)) return false;
    this.db.transaction(() => {
      this.exec(`DELETE FROM mcp_toolset_members WHERE toolset_id = ?`, [id]);
      this.exec(`DELETE FROM mcp_toolsets WHERE id = ?`, [id]);
      for (const client of this.listMcpClients()) {
        if (!client.toolsetIds.includes(id)) continue;
        this.exec(`UPDATE mcp_clients SET toolset_ids_json = ? WHERE id = ?`, [
          JSON.stringify(client.toolsetIds.filter((entry) => entry !== id)),
          client.id
        ]);
      }
    })();
    return true;
  }

  createMcpClient(input: {
    id: string;
    name: string;
    tokenPrefix: string;
    tokenHash: string;
    toolsetIds: string[];
    role: McpPolicyRole;
    createdBy: string | null;
    createdByEmail: string | null;
    expiresAt: string | null;
  }): McpClient {
    this.exec(
      `INSERT INTO mcp_clients (
         id, name, token_prefix, token_hash, toolset_ids_json, role, created_by, created_by_email, expires_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.name,
        input.tokenPrefix,
        input.tokenHash,
        JSON.stringify(input.toolsetIds),
        input.role,
        input.createdBy,
        input.createdByEmail,
        input.expiresAt,
        new Date().toISOString()
      ]
    );
    return this.getMcpClient(input.id)!;
  }

  /** Without the token hash. */
  getMcpClient(id: string): McpClient | null {
    const row = this.queryOne<McpClientRow>(`SELECT * FROM mcp_clients WHERE id = ?`, [id]);
    if (!row) return null;
    const { tokenHash: _hash, ...client } = mapMcpClient(row);
    return client;
  }

  /** With the token hash; for the credential check only. */
  findMcpClientByTokenPrefix(prefix: string): McpClientSecretRecord | null {
    const row = this.queryOne<McpClientRow>(`SELECT * FROM mcp_clients WHERE token_prefix = ?`, [prefix]);
    return row ? mapMcpClient(row) : null;
  }

  listMcpClients(): McpClient[] {
    return this.queryAll<McpClientRow>(`SELECT * FROM mcp_clients ORDER BY created_at DESC, rowid DESC`).map((row) => {
      const { tokenHash: _hash, ...client } = mapMcpClient(row);
      return client;
    });
  }

  revokeMcpClient(id: string): McpClient | null {
    const existing = this.getMcpClient(id);
    if (!existing) return null;
    if (!existing.revokedAt) {
      this.exec(`UPDATE mcp_clients SET revoked_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
    }
    return this.getMcpClient(id);
  }

  touchMcpClient(id: string, at: string): void {
    this.exec(`UPDATE mcp_clients SET last_used_at = ? WHERE id = ?`, [at, id]);
  }

  // ---------------------------------------------------------------------------
  // Phase 10.8 — MCP cassettes
  // ---------------------------------------------------------------------------

  saveMcpCassette(input: {
    id: string;
    executionId: string | null;
    workflowId: string | null;
    workflowName: string | null;
    projectId: string | null;
    source: McpCassetteSource;
    evalRunId?: string | null;
    fixtureId?: string | null;
    cassette: McpCassette;
    createdBy: string | null;
  }): McpCassetteSummary {
    const createdAt = new Date().toISOString();
    this.exec(
      `INSERT INTO mcp_cassettes (
         id, execution_id, workflow_id, workflow_name, project_id, source, eval_run_id, fixture_id,
         call_count, server_count, bytes, truncated, cassette_json, created_at, created_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.executionId,
        input.workflowId,
        input.workflowName,
        input.projectId,
        input.source,
        input.evalRunId ?? null,
        input.fixtureId ?? null,
        input.cassette.entries.length,
        input.cassette.servers.length,
        input.cassette.bytes,
        input.cassette.truncated ? 1 : 0,
        JSON.stringify(input.cassette),
        createdAt,
        input.createdBy
      ]
    );
    return this.getMcpCassetteSummary(input.id)!;
  }

  getMcpCassetteSummary(id: string): McpCassetteSummary | null {
    const row = this.queryOne<McpCassetteRow>(`SELECT ${MCP_CASSETTE_SUMMARY_COLUMNS} FROM mcp_cassettes WHERE id = ?`, [id]);
    return row ? mapMcpCassetteSummary(row) : null;
  }

  getMcpCassette(id: string): McpCassetteRecord | null {
    const row = this.queryOne<McpCassetteRow>(`SELECT * FROM mcp_cassettes WHERE id = ?`, [id]);
    if (!row) return null;
    return { ...mapMcpCassetteSummary(row), cassette: safeJsonParse(toString(row.cassette_json)) as McpCassette };
  }

  /** The newest cassette recorded for an execution. */
  getMcpCassetteForExecution(executionId: string): McpCassetteRecord | null {
    const row = this.queryOne<{ id: string }>(
      `SELECT id FROM mcp_cassettes WHERE execution_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      [executionId]
    );
    return row ? this.getMcpCassette(toString(row.id)) : null;
  }

  /** Cassettes an eval run recorded, keyed by fixture id. */
  listMcpCassettesForEvalRun(evalRunId: string): McpCassetteSummary[] {
    return this.queryAll<McpCassetteRow>(
      `SELECT ${MCP_CASSETTE_SUMMARY_COLUMNS} FROM mcp_cassettes WHERE eval_run_id = ? ORDER BY created_at ASC, rowid ASC`,
      [evalRunId]
    ).map(mapMcpCassetteSummary);
  }

  listMcpCassettes(options: { workflowId?: string; projectId?: string; evalRunId?: string; workflowIds?: string[]; limit?: number; offset?: number } = {}): {
    items: McpCassetteSummary[];
    total: number;
  } {
    const where: string[] = [];
    const params: Array<string | number> = [];
    // Project scope: only cassettes of these workflows (an empty list matches nothing).
    if (options.workflowIds) {
      where.push(options.workflowIds.length > 0 ? `workflow_id IN (${options.workflowIds.map(() => "?").join(", ")})` : "1 = 0");
      params.push(...options.workflowIds);
    }
    if (options.workflowId) {
      where.push("workflow_id = ?");
      params.push(options.workflowId);
    }
    if (options.projectId) {
      where.push("project_id = ?");
      params.push(options.projectId);
    }
    if (options.evalRunId) {
      where.push("eval_run_id = ?");
      params.push(options.evalRunId);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const total = this.queryOne<{ count: number }>(`SELECT COUNT(*) as count FROM mcp_cassettes ${clause}`, params);
    const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 50)));
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const items = this.queryAll<McpCassetteRow>(
      `SELECT ${MCP_CASSETTE_SUMMARY_COLUMNS} FROM mcp_cassettes ${clause} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    ).map(mapMcpCassetteSummary);
    return { items, total: total ? toNumber(total.count) : 0 };
  }

  /** Runs-page badges: the newest cassette per execution id. */
  mcpCassetteBadgesForExecutions(executionIds: string[]): Map<string, McpCassetteBadge> {
    const out = new Map<string, McpCassetteBadge>();
    const ids = [...new Set(executionIds.filter(Boolean))].slice(0, 500);
    if (ids.length === 0) return out;
    const rows = this.queryAll<{ id: string; execution_id: string; call_count: number; truncated: number }>(
      `SELECT id, execution_id, call_count, truncated FROM mcp_cassettes
       WHERE execution_id IN (${ids.map(() => "?").join(", ")})
       ORDER BY created_at ASC, rowid ASC`,
      ids
    );
    for (const row of rows) {
      out.set(toString(row.execution_id), { id: toString(row.id), callCount: toNumber(row.call_count), truncated: toNumber(row.truncated) === 1 });
    }
    return out;
  }

  deleteMcpCassette(id: string): boolean {
    const existing = this.getMcpCassetteSummary(id);
    if (!existing) return false;
    this.exec(`DELETE FROM mcp_cassettes WHERE id = ?`, [id]);
    return true;
  }

  // -------------------------------------------------------------------------
  // Phase 12.1 — Guard profiles, bindings, events and the token vault.
  // -------------------------------------------------------------------------

  listGuardProfiles(): GuardProfileRecord[] {
    return this.queryAll<GuardProfileRow>(
      `SELECT p.*, v.hash AS latest_hash FROM guard_profiles p
         LEFT JOIN guard_profile_versions v ON v.profile_id = p.id AND v.version = p.latest_version
       ORDER BY p.built_in DESC, p.name COLLATE NOCASE ASC`
    ).map(mapGuardProfileRow);
  }

  getGuardProfile(id: string): GuardProfileRecord | null {
    const row = this.queryOne<GuardProfileRow>(
      `SELECT p.*, v.hash AS latest_hash FROM guard_profiles p
         LEFT JOIN guard_profile_versions v ON v.profile_id = p.id AND v.version = p.latest_version
       WHERE p.id = ?`,
      [id]
    );
    return row ? mapGuardProfileRow(row) : null;
  }

  /** One version of a profile; the latest when `version` is omitted. */
  getGuardProfileVersion(profileId: string, version?: number): GuardProfileVersionRecord | null {
    const row =
      version === undefined
        ? this.queryOne<GuardProfileVersionRow>(
            `SELECT v.* FROM guard_profile_versions v JOIN guard_profiles p ON p.id = v.profile_id AND p.latest_version = v.version WHERE v.profile_id = ?`,
            [profileId]
          )
        : this.queryOne<GuardProfileVersionRow>(`SELECT * FROM guard_profile_versions WHERE profile_id = ? AND version = ?`, [profileId, version]);
    return row ? mapGuardProfileVersionRow(row) : null;
  }

  listGuardProfileVersions(profileId: string): GuardProfileVersionRecord[] {
    return this.queryAll<GuardProfileVersionRow>(`SELECT * FROM guard_profile_versions WHERE profile_id = ? ORDER BY version DESC`, [profileId]).map(
      mapGuardProfileVersionRow
    );
  }

  /** Creates a profile with its first version. */
  insertGuardProfile(input: {
    id: string;
    name: string;
    description?: string | null;
    builtIn?: boolean;
    document: Record<string, unknown>;
    hash: string;
    note?: string | null;
    createdBy: string | null;
  }): GuardProfileRecord {
    const now = new Date().toISOString();
    this.exec(
      `INSERT INTO guard_profiles (id, name, description, built_in, latest_version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      [input.id, input.name, input.description ?? null, input.builtIn ? 1 : 0, now, input.createdBy, now, input.createdBy]
    );
    this.exec(
      `INSERT INTO guard_profile_versions (profile_id, version, hash, document_json, note, created_at, created_by) VALUES (?, 1, ?, ?, ?, ?, ?)`,
      [input.id, input.hash, JSON.stringify(input.document), input.note ?? null, now, input.createdBy]
    );
    this.persist();
    return this.getGuardProfile(input.id)!;
  }

  /** Appends an immutable version and makes it the latest. */
  addGuardProfileVersion(input: {
    profileId: string;
    name: string;
    description?: string | null;
    document: Record<string, unknown>;
    hash: string;
    note?: string | null;
    createdBy: string | null;
  }): GuardProfileVersionRecord {
    const current = this.getGuardProfile(input.profileId);
    if (!current) throw new Error(`Guard profile '${input.profileId}' not found`);
    const version = current.latestVersion + 1;
    const now = new Date().toISOString();
    this.exec(
      `INSERT INTO guard_profile_versions (profile_id, version, hash, document_json, note, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [input.profileId, version, input.hash, JSON.stringify(input.document), input.note ?? null, now, input.createdBy]
    );
    this.exec(`UPDATE guard_profiles SET name = ?, description = ?, latest_version = ?, updated_at = ?, updated_by = ? WHERE id = ?`, [
      input.name,
      input.description ?? null,
      version,
      now,
      input.createdBy,
      input.profileId
    ]);
    this.persist();
    return this.getGuardProfileVersion(input.profileId, version)!;
  }

  deleteGuardProfile(id: string): boolean {
    if (!this.getGuardProfile(id)) return false;
    this.exec(`DELETE FROM guard_profile_versions WHERE profile_id = ?`, [id]);
    this.exec(`DELETE FROM guard_profiles WHERE id = ?`, [id]);
    this.persist();
    return true;
  }

  getGuardBinding(scope: GuardBindingScope, scopeId: string): GuardBindingRecord | null {
    const row = this.queryOne<GuardBindingRow>(`SELECT * FROM guard_bindings WHERE scope = ? AND scope_id = ?`, [scope, scopeId]);
    return row ? mapGuardBindingRow(row) : null;
  }

  listGuardBindingsForProfile(profileId: string): GuardBindingRecord[] {
    return this.queryAll<GuardBindingRow>(`SELECT * FROM guard_bindings WHERE profile_id = ? ORDER BY scope, scope_id`, [profileId]).map(mapGuardBindingRow);
  }

  setGuardBinding(input: { scope: GuardBindingScope; scopeId: string; mode: string; profileId: string | null; updatedBy: string | null }): GuardBindingRecord {
    const now = new Date().toISOString();
    this.exec(
      `INSERT INTO guard_bindings (scope, scope_id, mode, profile_id, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope, scope_id) DO UPDATE SET mode = excluded.mode, profile_id = excluded.profile_id, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      [input.scope, input.scopeId, input.mode, input.profileId, now, input.updatedBy]
    );
    this.persist();
    return this.getGuardBinding(input.scope, input.scopeId)!;
  }

  insertGuardEvents(rows: GuardEventInsert[]): void {
    for (const row of rows) {
      this.exec(
        `INSERT INTO guard_events (
           id, verdict_id, execution_id, workflow_id, project_id, node_id, placement, iteration, tool_name, channel,
           detector_id, category, data_class, score, requested_action, effective_action, verdict_action, shadow,
           evidence_json, profile_id, profile_version, profile_hash, latency_ms, budget_exceeded, skipped_detectors_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.verdictId,
          row.executionId,
          row.workflowId,
          row.projectId,
          row.nodeId,
          row.placement,
          row.iteration,
          row.toolName,
          row.channel,
          row.detectorId,
          row.category,
          row.dataClass,
          row.score,
          row.requestedAction,
          row.effectiveAction,
          row.verdictAction,
          row.shadow ? 1 : 0,
          JSON.stringify(row.evidence),
          row.profileId,
          row.profileVersion,
          row.profileHash,
          row.latencyMs,
          row.budgetExceeded ? 1 : 0,
          JSON.stringify(row.skippedDetectors),
          row.createdAt
        ]
      );
    }
    if (rows.length > 0) this.persist();
  }

  private guardEventWhere(filters: GuardEventFilters): { where: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      clauses.push(sql);
      params.push(value);
    };
    if (filters.executionId) add("execution_id = ?", filters.executionId);
    if (filters.projectId) add("project_id = ?", filters.projectId);
    if (filters.workflowId) add("workflow_id = ?", filters.workflowId);
    if (filters.workflowIds) {
      if (filters.workflowIds.length === 0) clauses.push("1 = 0");
      else {
        clauses.push(`workflow_id IN (${filters.workflowIds.map(() => "?").join(", ")})`);
        params.push(...filters.workflowIds);
      }
    }
    if (filters.profileId) add("profile_id = ?", filters.profileId);
    if (filters.channel) add("channel = ?", filters.channel);
    if (filters.action) add("effective_action = ?", filters.action);
    if (filters.since) add("created_at >= ?", filters.since);
    if (filters.onlyFindings) clauses.push("detector_id IS NOT NULL");
    return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
  }

  listGuardEvents(filters: GuardEventFilters & { limit?: number; offset?: number } = {}): { events: GuardEventRecord[]; total: number } {
    const { where, params } = this.guardEventWhere(filters);
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 500);
    const offset = Math.max(filters.offset ?? 0, 0);
    const total = this.queryOne<{ count: number }>(`SELECT COUNT(*) AS count FROM guard_events ${where}`, params);
    const rows = this.queryAll<GuardEventRow>(`SELECT * FROM guard_events ${where} ORDER BY created_at DESC, id ASC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    return { events: rows.map(mapGuardEventRow), total: total ? toNumber(total.count) : 0 };
  }

  /** Events of one execution in the order they were recorded. */
  listGuardEventsForExecution(executionId: string): GuardEventRecord[] {
    return this.queryAll<GuardEventRow>(`SELECT * FROM guard_events WHERE execution_id = ? ORDER BY created_at ASC, id ASC`, [executionId]).map(mapGuardEventRow);
  }

  /** Grouped counts for the Security page. */
  guardEventStats(filters: GuardEventFilters = {}): GuardEventStats {
    const { where, params } = this.guardEventWhere(filters);
    const and = (extra: string) => (where ? `${where} AND ${extra}` : `WHERE ${extra}`);
    const group = (column: string, extraWhere?: string) =>
      this.queryAll<{ key: unknown; count: number }>(
        `SELECT ${column} AS key, COUNT(*) AS count FROM guard_events ${extraWhere ? and(extraWhere) : where} GROUP BY ${column} ORDER BY count DESC`,
        params
      ).map((row) => ({ key: row.key === null || row.key === undefined ? "" : toString(row.key), count: toNumber(row.count) }));
    const verdicts = this.queryAll<{ key: unknown; count: number }>(
      `SELECT verdict_action AS key, COUNT(DISTINCT verdict_id) AS count FROM guard_events ${where} GROUP BY verdict_action ORDER BY count DESC`,
      params
    ).map((row) => ({ key: toString(row.key), count: toNumber(row.count) }));
    const shadowBlocks = this.queryOne<{ count: number }>(
      `SELECT COUNT(DISTINCT verdict_id) AS count FROM guard_events ${and("shadow = 1 AND effective_action = 'block'")}`,
      params
    );
    const shadowFindings = this.queryOne<{ count: number }>(`SELECT COUNT(*) AS count FROM guard_events ${and("shadow = 1")}`, params);
    const budget = this.queryOne<{ count: number }>(`SELECT COUNT(DISTINCT verdict_id) AS count FROM guard_events ${and("budget_exceeded = 1")}`, params);
    const daily = this.queryAll<{ day: unknown; action: unknown; count: number }>(
      `SELECT substr(created_at, 1, 10) AS day, verdict_action AS action, COUNT(DISTINCT verdict_id) AS count FROM guard_events ${where}
       GROUP BY day, verdict_action ORDER BY day ASC`,
      params
    ).map((row) => ({ day: toString(row.day), action: toString(row.action), count: toNumber(row.count) }));
    return {
      verdicts,
      actions: group("effective_action", "detector_id IS NOT NULL"),
      categories: group("category", "detector_id IS NOT NULL"),
      channels: this.queryAll<{ key: unknown; count: number }>(
        `SELECT channel AS key, COUNT(DISTINCT verdict_id) AS count FROM guard_events ${where} GROUP BY channel ORDER BY count DESC`,
        params
      ).map((row) => ({ key: toString(row.key), count: toNumber(row.count) })),
      detectors: group("detector_id", "detector_id IS NOT NULL").slice(0, 10),
      shadowWouldBlock: shadowBlocks ? toNumber(shadowBlocks.count) : 0,
      shadowFindings: shadowFindings ? toNumber(shadowFindings.count) : 0,
      budgetExceeded: budget ? toNumber(budget.count) : 0,
      daily
    };
  }

  getGuardVaultByToken(token: string): GuardVaultRow | null {
    return this.queryOne<GuardVaultRow>(`SELECT * FROM guard_token_vault WHERE token = ?`, [token]);
  }

  getGuardVaultByHash(valueHash: string): GuardVaultRow | null {
    return this.queryOne<GuardVaultRow>(`SELECT * FROM guard_token_vault WHERE value_hash = ?`, [valueHash]);
  }

  /** Stores a token; a concurrent deterministic insert for the same value keeps the first one. */
  putGuardVault(input: { token: string; dataClass: string; valueHash: string | null; valueSealed: string; createdAt: string }): void {
    this.exec(`INSERT OR IGNORE INTO guard_token_vault (token, data_class, value_hash, value_sealed, created_at) VALUES (?, ?, ?, ?, ?)`, [
      input.token,
      input.dataClass,
      input.valueHash,
      input.valueSealed,
      input.createdAt
    ]);
    this.persist();
  }

  // ---------------------------------------------------------------------------
  // Phase 11.1 — signed run manifests and signing keys
  // ---------------------------------------------------------------------------

  private mapExecutionManifest(row: Record<string, unknown>): ExecutionManifestRecord {
    let runContext: unknown = null;
    if (typeof row.run_context_json === "string" && row.run_context_json) {
      try {
        runContext = JSON.parse(row.run_context_json);
      } catch {
        runContext = null;
      }
    }
    return {
      executionId: toString(row.execution_id),
      runContext,
      manifestJson: typeof row.manifest_json === "string" ? row.manifest_json : null,
      manifestDigest: typeof row.manifest_digest === "string" ? row.manifest_digest : null,
      keyId: typeof row.key_id === "string" ? row.key_id : null,
      signature: typeof row.signature === "string" ? row.signature : null,
      signedAt: typeof row.signed_at === "string" ? row.signed_at : null,
      createdAt: toString(row.created_at)
    };
  }

  getExecutionManifest(executionId: string): ExecutionManifestRecord | null {
    const row = this.queryOne<Record<string, unknown>>(`SELECT * FROM execution_manifests WHERE execution_id = ?`, [executionId]);
    return row ? this.mapExecutionManifest(row) : null;
  }

  /**
   * Records what a finished run used. A later write (an approval resume
   * finishing the same execution) replaces the context, but never once the
   * manifest has been generated: a manifest is immutable.
   */
  saveExecutionRunContext(executionId: string, runContext: unknown, createdAt: string): void {
    this.exec(
      `INSERT INTO execution_manifests (execution_id, run_context_json, created_at) VALUES (?, ?, ?)
       ON CONFLICT(execution_id) DO UPDATE SET run_context_json = excluded.run_context_json, created_at = excluded.created_at
       WHERE execution_manifests.manifest_json IS NULL`,
      [executionId, JSON.stringify(runContext), createdAt]
    );
  }

  /**
   * Stores a generated manifest once. Returns the stored record, which is
   * the first one written if two requests raced to generate it.
   */
  saveExecutionManifest(input: {
    executionId: string;
    manifestJson: string;
    manifestDigest: string;
    keyId: string;
    signature: string;
    signedAt: string;
  }): ExecutionManifestRecord {
    this.exec(
      `INSERT INTO execution_manifests (execution_id, manifest_json, manifest_digest, key_id, signature, signed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(execution_id) DO UPDATE SET
         manifest_json = excluded.manifest_json,
         manifest_digest = excluded.manifest_digest,
         key_id = excluded.key_id,
         signature = excluded.signature,
         signed_at = excluded.signed_at
       WHERE execution_manifests.manifest_json IS NULL`,
      [input.executionId, input.manifestJson, input.manifestDigest, input.keyId, input.signature, input.signedAt, input.signedAt]
    );
    return this.getExecutionManifest(input.executionId)!;
  }

  // ---------------------------------------------------------------------------
  // Phase 15.1 — golden runs. Never pruned by retention; removed by a person
  // or with their workflow.
  // ---------------------------------------------------------------------------

  saveReplayRecording(input: ReplayRecordingInsert): ReplayRecordingSummary {
    this.exec(
      `INSERT INTO replay_recordings (
         id, workflow_id, project_id, name, notes, source_execution_id, source_trigger_type, source_status,
         workflow_hash, workflow_saved_version, captured_workflow_json, input_json, node_outputs_json, facts_json,
         mcp_cassette_json, capabilities_json, bytes, truncated, created_at, created_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.workflowId,
        input.projectId,
        input.name,
        input.notes,
        input.sourceExecutionId,
        input.sourceTriggerType,
        input.sourceStatus,
        input.workflowHash,
        input.workflowSavedVersion,
        input.capturedWorkflowJson,
        input.inputJson,
        input.nodeOutputsJson,
        input.factsJson,
        input.mcpCassetteJson,
        JSON.stringify(input.capabilities),
        input.bytes,
        input.truncated ? 1 : 0,
        input.createdAt,
        input.createdBy
      ]
    );
    return this.getReplayRecordingSummary(input.id)!;
  }

  getReplayRecordingSummary(id: string): ReplayRecordingSummary | null {
    const row = this.queryOne<Record<string, unknown>>(`SELECT ${REPLAY_RECORDING_SUMMARY_COLUMNS} FROM replay_recordings WHERE id = ?`, [id]);
    return row ? mapReplayRecordingSummary(row) : null;
  }

  getReplayRecording(id: string): ReplayRecordingRecord | null {
    const row = this.queryOne<Record<string, unknown>>(`SELECT * FROM replay_recordings WHERE id = ?`, [id]);
    if (!row) return null;
    const parse = (value: unknown) => (typeof value === "string" && value ? safeJsonParse(value) : null);
    return {
      ...mapReplayRecordingSummary(row),
      capturedWorkflow: (parse(row.captured_workflow_json) ?? {}) as Record<string, unknown>,
      input: parse(row.input_json),
      nodes: (parse(row.node_outputs_json) ?? {}) as Record<string, ReplayRecordedNode>,
      facts: parse(row.facts_json) as RunFacts,
      mcpCassette: parse(row.mcp_cassette_json) as McpCassette | null
    };
  }

  listReplayRecordings(options: { workflowId?: string; workflowIds?: string[]; limit?: number; offset?: number } = {}): { items: ReplayRecordingSummary[]; total: number } {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (options.workflowId) {
      where.push("workflow_id = ?");
      params.push(options.workflowId);
    }
    if (options.workflowIds) {
      if (options.workflowIds.length === 0) return { items: [], total: 0 };
      where.push(`workflow_id IN (${options.workflowIds.map(() => "?").join(", ")})`);
      params.push(...options.workflowIds);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const total = this.queryOne<{ count: number }>(`SELECT COUNT(*) AS count FROM replay_recordings ${clause}`, params);
    const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 50)));
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const items = this.queryAll<Record<string, unknown>>(
      `SELECT ${REPLAY_RECORDING_SUMMARY_COLUMNS} FROM replay_recordings ${clause} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    ).map(mapReplayRecordingSummary);
    return { items, total: total ? toNumber(total.count) : 0 };
  }

  /** Bytes one workflow's golden runs use (each row's `bytes`, cassette included). */
  sumReplayRecordingBytesForWorkflow(workflowId: string): number {
    const row = this.queryOne<{ total: number | null }>(`SELECT COALESCE(SUM(bytes), 0) AS total FROM replay_recordings WHERE workflow_id = ?`, [workflowId]);
    return row ? toNumber(row.total ?? 0) : 0;
  }

  /** Bytes every golden run in the deployment uses, cassettes included. */
  sumReplayRecordingBytes(): number {
    const row = this.queryOne<{ total: number | null }>(`SELECT COALESCE(SUM(bytes), 0) AS total FROM replay_recordings`, []);
    return row ? toNumber(row.total ?? 0) : 0;
  }

  /** The golden run already saved from an execution, if any. */
  findReplayRecordingIdForExecution(executionId: string): string | null {
    const row = this.queryOne<{ id: string }>(`SELECT id FROM replay_recordings WHERE source_execution_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 1`, [executionId]);
    return row ? toString(row.id) : null;
  }

  countReplayRecordingsForWorkflow(workflowId: string): number {
    const row = this.queryOne<{ count: number }>(`SELECT COUNT(*) AS count FROM replay_recordings WHERE workflow_id = ?`, [workflowId]);
    return row ? toNumber(row.count) : 0;
  }

  /** Runs-page badges: how many golden runs were saved from each execution. */
  replayGoldenBadgesForExecutions(executionIds: string[]): Map<string, ReplayGoldenBadge> {
    const out = new Map<string, ReplayGoldenBadge>();
    const ids = [...new Set(executionIds.filter(Boolean))].slice(0, 500);
    if (ids.length === 0) return out;
    const rows = this.queryAll<{ id: string; source_execution_id: string }>(
      `SELECT id, source_execution_id FROM replay_recordings
       WHERE source_execution_id IN (${ids.map(() => "?").join(", ")})
       ORDER BY created_at ASC, rowid ASC`,
      ids
    );
    for (const row of rows) {
      const executionId = toString(row.source_execution_id);
      out.set(executionId, { count: (out.get(executionId)?.count ?? 0) + 1, latestId: toString(row.id) });
    }
    return out;
  }

  deleteReplayRecording(id: string): boolean {
    if (!this.getReplayRecordingSummary(id)) return false;
    this.exec(`DELETE FROM replay_recordings WHERE id = ?`, [id]);
    return true;
  }

  /** MCP tool-call telemetry rows of one execution, oldest first. */
  listMcpToolCallsForExecution(executionId: string): McpToolCallRecord[] {
    return this.queryAll<McpToolCallRow>(`SELECT * FROM mcp_tool_calls WHERE execution_id = ? ORDER BY started_at, id`, [executionId]).map(mapMcpToolCall);
  }

  /**
   * Audit-log entries about this execution: rows whose metadata `executionId`
   * is this execution, or whose resource is this execution. No IP address or
   * user agent; the actor's current role comes from the users table.
   */
  listAuditLogsForExecution(executionId: string): Array<{
    eventType: string;
    action: string;
    outcome: string;
    actorUserId: string | null;
    actorRole: string | null;
    actorEmail: string | null;
    actorType: string;
    message: string | null;
    createdAt: string;
  }> {
    return this.queryAll<Record<string, unknown>>(
      `SELECT a.event_type, a.action, a.outcome, a.actor_user_id, a.actor_email, a.actor_type, a.message, a.created_at,
              a.resource_type, a.resource_id, a.metadata_json, u.role AS actor_role
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
       WHERE (a.resource_type = 'execution' AND a.resource_id = ?) OR instr(a.metadata_json, ?) > 0
       ORDER BY a.created_at, a.id`,
      [executionId, JSON.stringify(executionId)]
    )
      .filter((row) => {
        if (row.resource_type === "execution" && row.resource_id === executionId) return true;
        try {
          const metadata = JSON.parse(String(row.metadata_json ?? "null")) as unknown;
          return Boolean(metadata) && typeof metadata === "object" && (metadata as Record<string, unknown>).executionId === executionId;
        } catch {
          return false;
        }
      })
      .map((row) => ({
        eventType: toString(row.event_type),
        action: toString(row.action),
        outcome: toString(row.outcome),
        actorUserId: typeof row.actor_user_id === "string" ? row.actor_user_id : null,
        actorRole: typeof row.actor_role === "string" ? row.actor_role : null,
        actorEmail: typeof row.actor_email === "string" ? row.actor_email : null,
        actorType: toString(row.actor_type),
        message: typeof row.message === "string" ? row.message : null,
        createdAt: toString(row.created_at)
      }));
  }

  /**
   * Cached manifests are pruned only once both are true: older than the
   * audit-log retention (AUDIT_LOG_RETENTION_DAYS) and their execution's
   * history row is gone. While a run's history is kept its manifest is kept,
   * so it is never regenerated with a new signing time, key or workflow.
   */
  pruneExecutionManifests(options: { before: string }): number {
    const where = `created_at < ? AND NOT EXISTS (SELECT 1 FROM execution_history h WHERE h.id = execution_manifests.execution_id)`;
    const row = this.queryOne<{ count: number }>(`SELECT COUNT(*) AS count FROM execution_manifests WHERE ${where}`, [options.before]);
    const count = row ? toNumber(row.count) : 0;
    if (count > 0) {
      this.exec(`DELETE FROM execution_manifests WHERE ${where}`, [options.before]);
      this.persist();
    }
    return count;
  }

  private mapAuditSigningKey(row: Record<string, unknown>): AuditSigningKeyRecord {
    return {
      keyId: toString(row.key_id),
      algorithm: toString(row.algorithm),
      publicKey: toString(row.public_key),
      source: row.source === "env" ? "env" : "generated",
      secretId: typeof row.secret_id === "string" && row.secret_id ? row.secret_id : null,
      status: row.status === "active" ? "active" : "retired",
      createdAt: toString(row.created_at),
      retiredAt: typeof row.retired_at === "string" ? row.retired_at : null
    };
  }

  listAuditSigningKeys(): AuditSigningKeyRecord[] {
    return this.queryAll<Record<string, unknown>>(`SELECT * FROM audit_signing_keys ORDER BY created_at DESC, key_id ASC`).map((row) =>
      this.mapAuditSigningKey(row)
    );
  }

  getAuditSigningKey(keyId: string): AuditSigningKeyRecord | null {
    const row = this.queryOne<Record<string, unknown>>(`SELECT * FROM audit_signing_keys WHERE key_id = ?`, [keyId]);
    return row ? this.mapAuditSigningKey(row) : null;
  }

  getActiveAuditSigningKey(): AuditSigningKeyRecord | null {
    const row = this.queryOne<Record<string, unknown>>(`SELECT * FROM audit_signing_keys WHERE status = 'active'`);
    return row ? this.mapAuditSigningKey(row) : null;
  }

  /**
   * Makes `key` the active key and retires the previous one in one
   * transaction. A key id seen before (an env key put back) is re-activated.
   * Returns false when another writer activated a different key first.
   */
  activateAuditSigningKey(key: Omit<AuditSigningKeyRecord, "status" | "retiredAt">, expectedActiveKeyId: string | null): boolean {
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      const current = this.getActiveAuditSigningKey();
      if ((current?.keyId ?? null) !== expectedActiveKeyId) return false;
      if (current && current.keyId !== key.keyId) {
        this.exec(`UPDATE audit_signing_keys SET status = 'retired', retired_at = ?, secret_id = NULL WHERE key_id = ?`, [now, current.keyId]);
      }
      this.exec(
        `INSERT INTO audit_signing_keys (key_id, algorithm, public_key, source, secret_id, status, created_at, retired_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, NULL)
         ON CONFLICT(key_id) DO UPDATE SET status = 'active', retired_at = NULL, source = excluded.source, secret_id = excluded.secret_id`,
        [key.keyId, key.algorithm, key.publicKey, key.source, key.secretId, key.createdAt]
      );
      return true;
    })();
  }

  /**
   * Backfill helper invoked at startup. Idempotent.
   * Creates the default project if missing, and moves any rows with
   * NULL project_id (shouldn't exist post-migration, but safe) back to default.
   */
  ensureDefaultProject(): Project {
    const existing = this.getProject(DEFAULT_PROJECT_ID);
    if (existing) {
      this.exec(`UPDATE workflows SET project_id = ? WHERE project_id IS NULL`, [DEFAULT_PROJECT_ID]);
      this.exec(`UPDATE secrets SET project_id = ? WHERE project_id IS NULL`, [DEFAULT_PROJECT_ID]);
      return existing;
    }
    const project = this.upsertProject({
      id: DEFAULT_PROJECT_ID,
      name: "Default Project",
      description: "Personal workspace."
    });
    this.exec(`UPDATE workflows SET project_id = ? WHERE project_id IS NULL`, [DEFAULT_PROJECT_ID]);
    this.exec(`UPDATE secrets SET project_id = ? WHERE project_id IS NULL`, [DEFAULT_PROJECT_ID]);
    this.persist();
    return project;
  }
}
