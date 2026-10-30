import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database, { type Database as BetterSqlite3Database } from "better-sqlite3";
import type {
  ApprovalRequestKind,
  ApprovalRequestSpec,
  ApprovalStatus,
  PendingApprovalInfo,
  ChatMessage,
  Folder,
  McpPolicyRole,
  McpPolicySuggestion,
  McpPolicySuggestionStatus,
  McpClient,
  McpCassette,
  ModelMemorySeed,
  ModelTape,
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
  McpToolPolicyDecisionRecord,
  McpToolPolicyRule,
  McpGatewayApproval,
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
  ReplayCaptureInfo,
  ReplayCaptureStatus,
  ReplayGoldenBadge
} from "@ai-orchestrator/shared";
import { DESTINATION_KINDS, DESTINATION_TIERS, type DataDestinationRow, DEFAULT_PROJECT_ID, GUARD_SIMULATION_JOB_DATASET_PREFIX, MCP_POLICY_KINDS, MCP_POLICY_ROLES, MCP_TOOL_HINT_CONDITIONS, REPLAY_CAPTURE_API_KEY_FILTER, REPLAY_CAPTURE_STATUSES } from "@ai-orchestrator/shared";
import {
  mapMcpGatewayApproval,
  mapMcpPolicySuggestion,
  mapMcpToolCallContext,
  mcpToolCallScanWhere,
  mcpToolCallContextValues,
  mapMcpToolPolicyExtras,
  normalizeMcpSamplingSettings,
  parseMcpPolicyDecision,
  SUBJECT_CASSETTE_SOURCES,
  SUBJECT_EXECUTION_TRIGGERS,
  toMcpToolPolicyEffect
} from "./store-shared.js";
import { GATEWAY_APPROVAL_ONE_PENDING_INDEX, ONE_PENDING_APPROVAL_INDEX, POLICY_SUGGESTION_ONE_OPEN_INDEX, QUEUE_ACTIVE_EXECUTION_INDEX, QUEUE_CLAIM_INDEX, QUEUE_FINISHED_INDEX, QUEUE_RUNNING_HEARTBEAT_INDEX } from "./migrations.js";
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
import { isEmptyDataLabels, labelsForUntrackedSave, mergeDataLabels, parseStoredDataLabels, releaseGateRestrictsToAdmins, type DataLabels } from "@ai-orchestrator/shared";
import type { McpToolPolicySubject, ToolArgumentSummary } from "@ai-orchestrator/shared";
import { queuedRunTimeoutMs, STUCK_JOB_MARGIN_MS } from "./queue-timeouts.js";
import { AuditExportCursorMovedError, isForeignKeyViolation, ProjectNotEmptyError, StoreReferenceMissingError, ReleaseGateEnforcedError } from "./store-errors.js";
import { clampLimit, LIMIT_MAX } from "./store-limits.js";
import { mcpGatewayApprovalRetentionCutoff } from "./store.js";
import {
  auditEntryHash,
  type AuditChainResult,
  GENESIS_HASH,
  verifySqliteAuditChain,
  wellFormedAuditEntry,
  wellFormedAuditText
} from "./audit-chain.js";
import type {
  ApprovalDecisionInput,
  CancelExecutionResult,
  ClusterInstanceHeartbeat,
  ClusterInstanceRecord,
  ConsumedPendingChallenge,
  PendingChallengeInput,
  ReleaseApprovalDecisionInput,
  ReleaseGateCasesChange,
  ReplayRecordingLimits,
  QueueClaimedItem,
  QueueClaimFence,
  QueueItemOutcome,
  ReplayRecordingRefusal,
  McpGatewayApprovalCallKey,
  McpGatewayApprovalCreate,
  McpGatewayApprovalCreateResult,
  McpPolicySuggestionWrite,
  McpToolCallScanFilter,
  McpToolPolicyPatch,
  Store
} from "./store.js";
import {
  decideLostJob,
  lostJobEffects,
  DEFAULT_QUEUE_POOL,
  fairClaimWindow,
  payloadExecutionId,
  payloadIsResume,
  WORKER_LOST_REASONS,
  WORKER_SHUTDOWN_REASONS,
  QueueClaimLostError,
  type LostJobOutcome,
  type LostJobReasons
} from "./queue-leases.js";

type BindParams = unknown[];

/** Phase 7.3 / 15.2 — eval tables. */
export interface EvalDatasetRecord {
  id: string;
  name: string;
  description: string | null;
  projectId: string | null;
  /** Phase 15.2 — set on a golden set: the workflow its golden runs belong to. */
  workflowId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  fixtureCount: number;
  goldenRunCount: number;
}

export interface EvalFixtureRecord {
  id: string;
  datasetId: string;
  name: string;
  input: unknown;
  expected: unknown | null;
  scorers: Array<Record<string, unknown>> | null;
  /** Phase 15.2 — the golden run this case replays. */
  recordingId: string | null;
  /** Migration 36 — on an enforced release gate this case must pass whatever the pass rate (admins set it). */
  required: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface EvalRunRecord {
  id: string;
  kind: "eval" | "replay";
  datasetId: string;
  datasetIds: string[];
  workflowId: string;
  workflowName: string | null;
  status: string;
  startedAt: string;
  completedAt: string | null;
  triggeredBy: string | null;
  scorers: Array<Record<string, unknown>> | null;
  summary: Record<string, unknown> | null;
  error: string | null;
  candidate: Record<string, unknown> | null;
  workflowHash: string | null;
  workflowVersion: number | null;
  options: Record<string, unknown> | null;
  progress: Record<string, unknown> | null;
}

interface EvalFixtureRow {
  id: string; dataset_id: string; name: string;
  input_json: string; expected_json: string | null; scorers_json: string | null; recording_id: string | null; required?: number | null;
  created_at: string; updated_at: string;
}

interface EvalResultRow {
  id: string; run_id: string; fixture_id: string; fixture_name: string | null;
  status: string; execution_id: string | null;
  score_json: string | null; output_json: string | null; error: string | null;
  duration_ms: number | null;
  token_input: number | null; token_output: number | null; token_total: number | null;
  recording_id: string | null; verdict: string | null; diff_json: string | null; cost_usd: number | null;
}

export interface EvalResultRecord {
  id: string;
  runId: string;
  fixtureId: string;
  fixtureName: string | null;
  recordingId: string | null;
  status: string;
  executionId: string | null;
  score: Record<string, unknown> | null;
  output: unknown;
  error: string | null;
  durationMs: number | null;
  tokenInput: number | null;
  tokenOutput: number | null;
  tokenTotal: number | null;
  costUsd: number | null;
  verdict: string | null;
  /** Only on `getEvalResult`. */
  diff?: unknown;
}

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

export interface SecretRow {
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
  /** Migration 37 — the memory's data labels; null on rows written while labels were not tracked. */
  labels_json?: string | null;
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
  /** Migration 37 — the cached result's data labels; null when not tracked. */
  labels_json?: string | null;
  created_at: string;
}

interface SessionArtifactRow {
  namespace: string;
  session_id: string;
  artifact_key: string;
  value_json: string;
  /** Migration 37 — labels of what the saving run put in the artifact; null when it did not track labels. */
  labels_json?: string | null;
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
  /** Phase 13.1 — cluster mode: the instance whose run waits on the request (absent outside cluster mode). */
  holderId?: string | null;
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
  /** Phase 12.4 — what the tool policy decided for the call (enforced and shadow); null when no rule matched. */
  policyDecision?: McpToolPolicyDecisionRecord | null;
  /**
   * Phase 12.4 — a safe summary of the call's arguments (no free text; personal data by class only), and the role,
   * subject source and project the call ran under. All null when MCP_TOOL_ARGUMENT_SUMMARIES=false or not known.
   */
  argsSummary?: ToolArgumentSummary | null;
  subjectRole?: McpPolicyRole | null;
  subjectSource?: McpToolPolicySubject["source"] | null;
  projectId?: string | null;
  createdAt: string;
}

export type McpToolCallSource = "workflow" | "gateway" | "playground";

/** What callers write; `source` defaults to `workflow`. */
export type McpToolCallWrite = Omit<
  McpToolCallRecord,
  "createdAt" | "source" | "clientId" | "samplingRequests" | "samplingInputTokens" | "samplingOutputTokens" | "rejection" | "policyDecision"
> & {
  rejection?: McpRuntimeRejection | null;
  policyDecision?: McpToolPolicyDecisionRecord | null;
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
  policy_decision_json?: string | null;
  args_summary_json?: string | null;
  subject_role?: string | null;
  subject_source?: string | null;
  project_id?: string | null;
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
  conditions_json?: string | null;
  mode?: string | null;
  workflow_ids_json?: string | null;
  client_ids_json?: string | null;
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
    effect: toMcpToolPolicyEffect(toString(row.effect)),
    projectId: row.project_id ? toString(row.project_id) : null,
    roles: Array.isArray(roles)
      ? roles.filter((role): role is McpPolicyRole => MCP_POLICY_ROLES.includes(role as McpPolicyRole))
      : [],
    serverId: row.server_id ? toString(row.server_id) : null,
    toolPattern: toString(row.tool_pattern) || "*",
    annotationHint:
      hint && MCP_TOOL_HINT_CONDITIONS.includes(hint as McpToolHintCondition) ? (hint as McpToolHintCondition) : null,
    kind: MCP_POLICY_KINDS.includes(kind as McpPolicyKind) ? (kind as McpPolicyKind) : "tool",
    ...mapMcpToolPolicyExtras(row),
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
    ...mapMcpToolCallContext(row),
    policyDecision: parseMcpPolicyDecision(row.policy_decision_json),
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
  holder_id?: string | null;
}

const MCP_ELICITATION_STATUSES = new Set<McpElicitationStatus>(["pending", "accepted", "declined", "cancelled", "expired", "auto_declined"]);

/** Phase 10.5 — sampling settings as stored; unknown or partial JSON falls back to the defaults (off). */
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
    triggerType: row.trigger_type ? toString(row.trigger_type) : null,
    ...(row.holder_id ? { holderId: toString(row.holder_id) } : {})
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
/** Phase 15.6 — a stored guard policy simulation (JSON columns parsed). */
export interface GuardSimulationRecord {
  id: string;
  profileId: string;
  sourceKind: "inline" | "version";
  sourceVersion: number | null;
  simulatedHash: string;
  baseVersion: number | null;
  jobIds: string[];
  /** The per-workflow detail (`GuardSimulationWorkflow[]` and the empty-state reason). */
  detail: Record<string, unknown> | null;
  status: string;
  error: string | null;
  createdAt: string;
  createdBy: string | null;
  createdByUserId: string | null;
  finishedAt: string | null;
}

export interface ReplayRecordingRecord extends ReplayRecordingSummary {
  capturedWorkflow: Record<string, unknown>;
  input: unknown;
  nodes: Record<string, ReplayRecordedNode>;
  facts: RunFacts;
  mcpCassette: McpCassette | null;
  /** Phase 15.3 — the source run's model calls, when it recorded them. */
  modelTape: ModelTape | null;
  /** Phase 15.3 — session memory as the source run first read it. */
  memorySeed: ModelMemorySeed | null;
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
  /** Phase 15.3 */
  modelTapeJson?: string | null;
  memorySeedJson?: string | null;
  capabilities: ReplayRecordingCapabilities;
  bytes: number;
  truncated: boolean;
  createdAt: string;
  createdBy: string | null;
  /** Phase 15.6 — default `golden`; captures land as `candidate`. */
  status?: "candidate" | "golden";
  capturedAt?: string | null;
}

const REPLAY_RECORDING_SUMMARY_COLUMNS =
  "id, workflow_id, project_id, name, notes, source_execution_id, source_trigger_type, source_status, workflow_hash, workflow_saved_version, capabilities_json, bytes, truncated, created_at, created_by, status, captured_at";

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
      models: capabilities?.models === "tape" ? "tape" : "live",
      memory: capabilities?.memory === "seeded" ? "seeded" : "empty",
      workflowSource: capabilities?.workflowSource === "captured" ? "captured" : "current",
      ...(capabilities?.scrubbed && typeof capabilities.scrubbed === "object"
        ? {
            scrubbed: {
              input: capabilities.scrubbed.input === true,
              output: capabilities.scrubbed.output === true,
              nodes: Array.isArray(capabilities.scrubbed.nodes) ? capabilities.scrubbed.nodes.filter((id): id is string => typeof id === "string") : []
            }
          }
        : {}),
      ...(capabilities?.origin === "imported"
        ? {
            origin: "imported" as const,
            ...(typeof capabilities.recordedAt === "string" ? { recordedAt: capabilities.recordedAt } : {}),
            ...(typeof capabilities.importedAt === "string" ? { importedAt: capabilities.importedAt } : {}),
            sourceWorkflowId: typeof capabilities.sourceWorkflowId === "string" ? capabilities.sourceWorkflowId : null
          }
        : {}),
      ...(capabilities?.capture && typeof capabilities.capture === "object" ? { capture: mapReplayCaptureInfo(capabilities.capture) } : {})
    },
    bytes: toNumber(row.bytes),
    truncated: toNumber(row.truncated) === 1,
    createdAt: toString(row.created_at),
    createdBy: typeof row.created_by === "string" ? row.created_by : null,
    status: row.status === "candidate" ? "candidate" : "golden",
    capturedAt: typeof row.captured_at === "string" && row.captured_at ? row.captured_at : null
  };
}

function mapReplayCaptureInfo(raw: Partial<ReplayCaptureInfo>): ReplayCaptureInfo {
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
  const counts: Record<string, number> = {};
  if (raw.values && typeof raw.values === "object") {
    for (const [name, count] of Object.entries(raw.values)) if (typeof count === "number") counts[name] = count;
  }
  return {
    rate: typeof raw.rate === "number" ? raw.rate : 0,
    masked: raw.masked === true,
    // An imported run keeps `maskingVerified: false`; a run captured here has no such field.
    ...(raw.maskingVerified === false ? { maskingVerified: false } : {}),
    dataClasses: strings(raw.dataClasses),
    values: counts,
    notDetectableAfterMasking: strings(raw.notDetectableAfterMasking),
    keptFromWorkflow: typeof raw.keptFromWorkflow === "number" ? raw.keptFromWorkflow : 0,
    publishedVersion: typeof raw.publishedVersion === "number" ? raw.publishedVersion : null,
    ...(raw.source === "api_key" ? { source: "api_key" as const } : {})
  };
}

/** Phase 15.6 — a workflow's capture settings row. */
export interface ReplayCaptureSettingsRecord {
  workflowId: string;
  enabled: boolean;
  rate: number;
  maxPerDay: number;
  onlyStatuses: ReplayCaptureStatus[];
  dlp: boolean;
  dlpOffReason: string | null;
  targetDatasetId: string | null;
  updatedAt: string;
  updatedBy: string | null;
  /** The last sampled run capture dropped (`REPLAY_CAPTURE_DROP_OUTCOMES`), and when; never written by `saveReplayCaptureSettings`. */
  lastDropOutcome?: string | null;
  lastDropAt?: string | null;
}

function mapReplayCaptureSettings(row: Record<string, unknown>): ReplayCaptureSettingsRecord {
  const statuses = safeJsonParse(toString(row.only_statuses_json));
  return {
    workflowId: toString(row.workflow_id),
    enabled: toNumber(row.enabled) === 1,
    rate: toNumber(row.rate),
    maxPerDay: toNumber(row.max_per_day),
    onlyStatuses: Array.isArray(statuses)
      ? statuses.filter((entry): entry is ReplayCaptureStatus => (REPLAY_CAPTURE_STATUSES as readonly string[]).includes(String(entry)))
      : [...REPLAY_CAPTURE_STATUSES],
    dlp: toNumber(row.dlp) !== 0,
    dlpOffReason: typeof row.dlp_off_reason === "string" ? row.dlp_off_reason : null,
    targetDatasetId: typeof row.target_dataset_id === "string" && row.target_dataset_id ? row.target_dataset_id : null,
    updatedAt: toString(row.updated_at),
    updatedBy: typeof row.updated_by === "string" ? row.updated_by : null,
    lastDropOutcome: typeof row.last_drop_outcome === "string" && row.last_drop_outcome ? row.last_drop_outcome : null,
    lastDropAt: typeof row.last_drop_at === "string" && row.last_drop_at ? row.last_drop_at : null
  };
}

/** Phase 15.6 — the stores the data-subject lookup searches (and can delete from). */
export type SubjectStoreKind = "recording" | "fixture" | "eval_result" | "execution" | "cassette";

/** The stored text columns of one row the data-subject lookup searches. */
export interface SubjectTextRow {
  kind: SubjectStoreKind;
  id: string;
  workflowId: string | null;
  projectId: string | null;
  name: string;
  /** A recording's status (`candidate` | `golden`), or a result's or run's status. */
  status: string | null;
  texts: Record<string, string | null>;
}


const SUBJECT_QUERIES: Record<SubjectStoreKind, { select: string; rowid: string; idColumn: string }> = {
  recording: {
    select: `SELECT r.rowid AS rid, r.id, r.workflow_id, r.project_id, r.name, r.status, r.notes, r.input_json, r.node_outputs_json, r.facts_json,
                    r.mcp_cassette_json, r.model_tape_json, r.memory_seed_json, r.captured_workflow_json
             FROM replay_recordings r WHERE 1 = 1`,
    rowid: "r.rowid",
    idColumn: "r.id"
  },
  fixture: {
    select: `SELECT f.rowid AS rid, f.id, d.workflow_id, d.project_id, f.name, NULL AS status, f.input_json, f.expected_json
             FROM eval_fixtures f LEFT JOIN eval_datasets d ON d.id = f.dataset_id WHERE 1 = 1`,
    rowid: "f.rowid",
    idColumn: "f.id"
  },
  eval_result: {
    select: `SELECT x.rowid AS rid, x.id, run.workflow_id, w.project_id, COALESCE(x.fixture_name, x.id) AS name, x.status, x.output_json, x.error, x.diff_json
             FROM eval_results x LEFT JOIN eval_runs run ON run.id = x.run_id LEFT JOIN workflows w ON w.id = run.workflow_id WHERE 1 = 1`,
    rowid: "x.rowid",
    idColumn: "x.id"
  },
  execution: {
    select: `SELECT h.rowid AS rid, h.id, h.workflow_id, w.project_id, COALESCE(h.workflow_name, h.id) AS name, h.status, h.input_json, h.output_json,
                    h.node_results_json, h.custom_data_json, h.error
             FROM execution_history h LEFT JOIN workflows w ON w.id = h.workflow_id
             WHERE h.trigger_type IN (${SUBJECT_EXECUTION_TRIGGERS.map((trigger) => `'${trigger}'`).join(", ")})`,
    rowid: "h.rowid",
    idColumn: "h.id"
  },
  cassette: {
    select: `SELECT c.rowid AS rid, c.id, c.workflow_id, c.project_id, COALESCE(c.workflow_name, c.id) AS name, NULL AS status, c.cassette_json
             FROM mcp_cassettes c WHERE c.source IN (${SUBJECT_CASSETTE_SOURCES.map((source) => `'${source}'`).join(", ")})`,
    rowid: "c.rowid",
    idColumn: "c.id"
  }
};

const SUBJECT_TEXT_COLUMNS: Record<SubjectStoreKind, Record<string, string>> = {
  recording: {
    input: "input_json",
    nodes: "node_outputs_json",
    facts: "facts_json",
    cassette: "mcp_cassette_json",
    modelTape: "model_tape_json",
    memorySeed: "memory_seed_json",
    workflow: "captured_workflow_json",
    notes: "notes"
  },
  fixture: { input: "input_json", expected: "expected_json" },
  eval_result: { output: "output_json", error: "error", diff: "diff_json" },
  execution: { input: "input_json", output: "output_json", nodes: "node_results_json", customData: "custom_data_json", error: "error" },
  cassette: { cassette: "cassette_json" }
};

function mapSubjectTextRow(kind: SubjectStoreKind, row: Record<string, unknown>): SubjectTextRow {
  const texts: Record<string, string | null> = {};
  for (const [field, column] of Object.entries(SUBJECT_TEXT_COLUMNS[kind])) texts[field] = typeof row[column] === "string" ? (row[column] as string) : null;
  return {
    kind,
    id: toString(row.id),
    workflowId: typeof row.workflow_id === "string" ? row.workflow_id : null,
    projectId: typeof row.project_id === "string" ? row.project_id : null,
    name: toString(row.name),
    status: typeof row.status === "string" ? row.status : null,
    texts
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

/** Phase 11.2 — one approval request row. */
export interface ApprovalRequestRecord {
  id: string;
  executionId: string;
  workflowId: string;
  workflowName: string | null;
  projectId: string;
  nodeId: string;
  nodeType: string | null;
  kind: ApprovalRequestKind;
  status: ApprovalStatus;
  message: string | null;
  spec: ApprovalRequestSpec;
  path: PendingApprovalInfo["path"];
  details: Record<string, unknown> | null;
  requestedByUserId: string | null;
  requestedBy: string | null;
  timeoutMinutes: number | null;
  expiresAt: string | null;
  decidedByUserId: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  reason: string | null;
  edits: Record<string, unknown> | null;
  editedFields: string[];
  /** The workflow whose node asked (the innermost one for a sub-workflow pause). */
  askingWorkflowId: string | null;
  /** Per-request salt of the edits digest. */
  editsSalt: string | null;
  /** Set when the workflow was deleted: the request is then admin-only, even if a new workflow reuses the id. */
  workflowDeletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalRequestInsert {
  id: string;
  executionId: string;
  workflowId: string;
  workflowName?: string | null;
  projectId: string;
  nodeId: string;
  nodeType?: string | null;
  kind: ApprovalRequestKind;
  message?: string | null;
  spec: ApprovalRequestSpec;
  path?: PendingApprovalInfo["path"];
  details?: Record<string, unknown> | null;
  requestedByUserId?: string | null;
  requestedBy?: string | null;
  timeoutMinutes?: number | null;
  expiresAt?: string | null;
  askingWorkflowId?: string | null;
  editsSalt?: string | null;
  createdAt?: string;
}

/** Phase 11.2 — which approval requests a user may see: everything, or these projects plus workflows shared to them. */
/** Which requests a user may list: every one (admins) or those of the workflows they can read now. */
export type ApprovalReadScope = { all: true } | { all?: false; workflowIds: string[] };

/** Phase 15.4 — a workflow's release gate settings. */
export interface ReleaseGateRecord {
  workflowId: string;
  enabled: boolean;
  enforced: boolean;
  datasetIds: string[];
  candidateOptions: Record<string, unknown>;
  policy: Record<string, unknown>;
  requireApproval: boolean;
  approvers: Record<string, unknown> | null;
  updatedAt: string;
  updatedBy: string | null;
  /**
   * Migration 36 — the cases an enforced gate counts; null when the gate was
   * never enforced (kept while enforcement is lifted, and ignored then).
   * Saved by `setReleaseGateAdmission`, never by `upsertReleaseGate`.
   */
  admittedFixtureIds?: string[] | null;
  admissionUpdatedAt?: string | null;
  admissionUpdatedBy?: string | null;
}

/** Phase 15.4 / migration 36 — what a replay job holds of one golden set: the hash over all its cases and each case's fingerprint (null in jobs queued before gate admission). */
export interface GoldenSetSnapshot {
  hash: string;
  cases: Record<string, string> | null;
}

/** Migration 36 — a request to admit cases to an enforced gate, or to remove admitted ones, decided in the approvals inbox. */
export interface GateCaseRequestRecord {
  id: string;
  workflowId: string;
  workflowName: string | null;
  projectId: string;
  action: "admit" | "remove";
  /** The cases asked about, with their names and sets when asked. */
  fixtures: Array<{ fixtureId: string; name: string; datasetId: string | null }>;
  /** The approvers when asked, for display; the decision checks the gate's current approvers. */
  spec: Record<string, unknown>;
  /**
   * Who decided the gate when asked: a fingerprint of its approvers,
   * self-approval and enforcement (admin-only on an enforced gate). Any
   * change to those makes the request stale; other saves of the gate do not.
   */
  gateAuthority: string | null;
  status: string;
  requestReason: string | null;
  requestedByUserId: string | null;
  requestedBy: string | null;
  expiresAt: string | null;
  decidedByUserId: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Phase 15.4 — one release: the published version moved to `version`. */
export interface WorkflowReleaseRecord {
  id: string;
  workflowId: string;
  version: number;
  workflowHash: string;
  previousVersion: number | null;
  replayRunId: string | null;
  verdict: string;
  reason: string | null;
  gateReasons: string[];
  approval: Record<string, unknown> | null;
  publishedAt: string;
  publishedBy: string | null;
  publishedByUserId: string | null;
}

/** Phase 15.4 — a request to publish a version, decided in the approvals inbox. */
export interface ReleaseApprovalRequestRecord {
  id: string;
  workflowId: string;
  workflowName: string | null;
  projectId: string;
  version: number;
  workflowHash: string;
  replayRunId: string | null;
  /** `policy`: the gate sends every publish to approvers; `blocked`: the publish was blocked and sent with a reason. */
  origin: "policy" | "blocked";
  gateReasons: string[];
  /** The gate's `updated_at` when asked: a gate changed since makes the request stale. */
  gateUpdatedAt: string | null;
  /**
   * Migration 36 — the gate's reasons as stable codes and measures when
   * asked (`ReleaseGateJudgement.checks`), so a re-judge at decision time
   * cancels only for a new kind of reason or a worse measure. Null on
   * requests made before.
   */
  gateChecks?: Array<{ code: string; measure: number | null }> | null;
  /**
   * Migration 36 — who decides on the gate when asked (approvers,
   * self-approval, enforcement; see gate-authority.ts). The request goes
   * stale only when it changes. Null on requests made before: they keep the
   * `gateUpdatedAt` rule.
   */
  gateAuthority?: string | null;
  publishedVersionAtRequest: number | null;
  spec: Record<string, unknown>;
  status: string;
  requestReason: string | null;
  requestedByUserId: string | null;
  requestedBy: string | null;
  expiresAt: string | null;
  decidedByUserId: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  releaseId: string | null;
  createdAt: string;
  updatedAt: string;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapReleaseGateRow(row: Record<string, unknown>): ReleaseGateRecord {
  const approvers = row.approvers_json ? parseJsonObject(row.approvers_json) : null;
  return {
    workflowId: String(row.workflow_id),
    enabled: Number(row.enabled) === 1,
    enforced: Number(row.enforced) === 1,
    datasetIds: parseJsonArray(row.dataset_ids_json),
    candidateOptions: parseJsonObject(row.candidate_options_json),
    policy: parseJsonObject(row.policy_json),
    requireApproval: Number(row.require_approval) === 1,
    approvers,
    updatedAt: String(row.updated_at),
    updatedBy: nullableText(row.updated_by),
    admittedFixtureIds: row.admitted_fixture_ids_json === null || row.admitted_fixture_ids_json === undefined ? null : parseJsonArray(row.admitted_fixture_ids_json),
    admissionUpdatedAt: nullableText(row.admission_updated_at),
    admissionUpdatedBy: nullableText(row.admission_updated_by)
  };
}

function parseGateChecks(value: unknown): Array<{ code: string; measure: number | null }> | null {
  if (value === null || value === undefined) return null;
  const parsed = parseJsonSafe(value);
  if (!Array.isArray(parsed)) return null;
  return parsed
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && typeof (entry as Record<string, unknown>).code === "string")
    .map((entry) => ({ code: String(entry.code), measure: typeof entry.measure === "number" && Number.isFinite(entry.measure) ? entry.measure : null }));
}

function mapGateCaseRequestRow(row: Record<string, unknown>): GateCaseRequestRecord {
  const fixtures = parseJsonSafe(row.fixtures_json);
  return {
    id: String(row.id),
    workflowId: String(row.workflow_id),
    workflowName: nullableText(row.workflow_name),
    projectId: String(row.project_id),
    action: row.action === "remove" ? "remove" : "admit",
    fixtures: Array.isArray(fixtures)
      ? fixtures
          .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
          .map((entry) => ({
            fixtureId: String(entry.fixtureId ?? ""),
            name: String(entry.name ?? entry.fixtureId ?? ""),
            datasetId: typeof entry.datasetId === "string" ? entry.datasetId : null
          }))
          .filter((entry) => entry.fixtureId)
      : [],
    spec: parseJsonObject(row.spec_json),
    gateAuthority: nullableText(row.gate_authority),
    status: String(row.status),
    requestReason: nullableText(row.request_reason),
    requestedByUserId: nullableText(row.requested_by_user_id),
    requestedBy: nullableText(row.requested_by),
    expiresAt: nullableText(row.expires_at),
    decidedByUserId: nullableText(row.decided_by_user_id),
    decidedBy: nullableText(row.decided_by),
    decidedAt: nullableText(row.decided_at),
    decisionReason: nullableText(row.decision_reason),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapWorkflowReleaseRow(row: Record<string, unknown>): WorkflowReleaseRecord {
  return {
    id: String(row.id),
    workflowId: String(row.workflow_id),
    version: Number(row.version),
    workflowHash: String(row.workflow_hash),
    previousVersion: nullableNumber(row.previous_version),
    replayRunId: nullableText(row.replay_run_id),
    verdict: String(row.verdict),
    reason: nullableText(row.reason),
    gateReasons: parseJsonArray(row.gate_reasons_json),
    approval: row.approval_json ? parseJsonObject(row.approval_json) : null,
    publishedAt: String(row.published_at),
    publishedBy: nullableText(row.published_by),
    publishedByUserId: nullableText(row.published_by_user_id)
  };
}

function mapReleaseApprovalRequestRow(row: Record<string, unknown>): ReleaseApprovalRequestRecord {
  return {
    id: String(row.id),
    workflowId: String(row.workflow_id),
    workflowName: nullableText(row.workflow_name),
    projectId: String(row.project_id),
    version: Number(row.version),
    workflowHash: String(row.workflow_hash),
    replayRunId: nullableText(row.replay_run_id),
    origin: row.origin === "policy" ? "policy" : "blocked",
    gateReasons: parseJsonArray(row.gate_reasons_json),
    gateUpdatedAt: nullableText(row.gate_updated_at),
    gateChecks: parseGateChecks(row.gate_checks_json),
    gateAuthority: nullableText(row.gate_authority),
    publishedVersionAtRequest: nullableNumber(row.published_version_at_request),
    spec: parseJsonObject(row.spec_json),
    status: String(row.status),
    requestReason: nullableText(row.request_reason),
    requestedByUserId: nullableText(row.requested_by_user_id),
    requestedBy: nullableText(row.requested_by),
    expiresAt: nullableText(row.expires_at),
    decidedByUserId: nullableText(row.decided_by_user_id),
    decidedBy: nullableText(row.decided_by),
    decidedAt: nullableText(row.decided_at),
    decisionReason: nullableText(row.decision_reason),
    releaseId: nullableText(row.release_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

type ApprovalRequestRow = Record<string, unknown>;

function mapApprovalRequestRow(row: ApprovalRequestRow): ApprovalRequestRecord {
  const spec = parseJsonSafe(row.spec_json);
  const path = parseJsonSafe(row.path_json);
  const details = row.details_json ? parseJsonSafe(row.details_json) : null;
  const edits = row.edits_json ? parseJsonSafe(row.edits_json) : null;
  return {
    id: toString(row.id),
    executionId: toString(row.execution_id),
    workflowId: toString(row.workflow_id),
    workflowName: nullableText(row.workflow_name),
    projectId: toString(row.project_id),
    nodeId: toString(row.node_id),
    nodeType: nullableText(row.node_type),
    kind: toString(row.kind) as ApprovalRequestKind,
    status: toString(row.status) as ApprovalStatus,
    message: nullableText(row.message),
    spec: (spec && typeof spec === "object" ? spec : {}) as ApprovalRequestSpec,
    path: Array.isArray(path) ? (path as PendingApprovalInfo["path"]) : [],
    details: details && typeof details === "object" && !Array.isArray(details) ? (details as Record<string, unknown>) : null,
    requestedByUserId: nullableText(row.requested_by_user_id),
    requestedBy: nullableText(row.requested_by),
    timeoutMinutes: row.timeout_minutes === null || row.timeout_minutes === undefined ? null : toNumber(row.timeout_minutes),
    expiresAt: nullableText(row.expires_at),
    decidedByUserId: nullableText(row.decided_by_user_id),
    decidedBy: nullableText(row.decided_by),
    decidedAt: nullableText(row.decided_at),
    reason: nullableText(row.reason),
    edits: edits && typeof edits === "object" && !Array.isArray(edits) ? (edits as Record<string, unknown>) : null,
    editedFields: parseJsonArray(row.edited_fields_json),
    askingWorkflowId: nullableText(row.asking_workflow_id),
    editsSalt: nullableText(row.edits_salt),
    workflowDeletedAt: nullableText(row.workflow_deleted_at),
    createdAt: toString(row.created_at),
    updatedAt: toString(row.updated_at)
  };
}

function toString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function toNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
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

/** 1 when a run's history record is finished (a progress write must not replace it), else 0. */
const FINISHED_HISTORY_SQL = (table: string) =>
  `(CASE WHEN ${table}.status IN ('success', 'error', 'canceled') OR (${table}.status = 'partial' AND ${table}.completed_at IS NOT NULL AND ${table}.completed_at <> '') THEN 1 ELSE 0 END)`;

function toDurationMsForStore(startedAt: string, completedAt: string): number | null {
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed)) {
    return null;
  }
  return Math.max(0, Math.floor(completed - started));
}

/** Phase 16 — `{ labels }` from a stored labels column, parsed once; nothing when none were recorded. */
function labelsField(value: string | null | undefined): { labels?: DataLabels } {
  const labels = parseStoredDataLabels(value ?? null);
  return labels ? { labels } : {};
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

/** Migration 37 — the triggers that bump `guard_profile_revision` (name, event, table). */
export const GUARD_PROFILE_REVISION_TRIGGERS: ReadonlyArray<readonly [string, "INSERT" | "UPDATE" | "DELETE", string]> = [
  ["guard_profiles_revision_ai", "INSERT", "guard_profiles"],
  ["guard_profiles_revision_au", "UPDATE", "guard_profiles"],
  ["guard_profiles_revision_ad", "DELETE", "guard_profiles"],
  ["guard_profile_versions_revision_ai", "INSERT", "guard_profile_versions"],
  ["guard_profile_versions_revision_au", "UPDATE", "guard_profile_versions"],
  ["guard_profile_versions_revision_ad", "DELETE", "guard_profile_versions"]
];

export { normalizeMcpSamplingSettings, SUBJECT_CASSETTE_SOURCES, SUBJECT_EXECUTION_TRIGGERS };

export class SqliteStore implements Store {
  private closed = false;

  /** Phase 13.1 — one-line notes from this open's migrations (e.g. simulations an upgrade interrupted), for the log. */
  readonly upgradeNotes: string[] = [];

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
  async storageLocation(): Promise<string> {
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
    // Phase 12.4 — a safe summary of each call's arguments, and the role, subject source and project it ran under.
    this.ensureColumn("mcp_tool_calls", "args_summary_json", "TEXT");
    this.ensureColumn("mcp_tool_calls", "subject_role", "TEXT");
    this.ensureColumn("mcp_tool_calls", "subject_source", "TEXT");
    this.ensureColumn("mcp_tool_calls", "project_id", "TEXT");
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

    // Phase 11.2 — approval requests: who may decide a paused run, and what
    // was decided. The paused state itself stays in workflow_executions.
    this.exec(`
      CREATE TABLE IF NOT EXISTS approval_requests (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        workflow_name TEXT,
        project_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        node_type TEXT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT,
        spec_json TEXT NOT NULL,
        path_json TEXT,
        details_json TEXT,
        requested_by_user_id TEXT,
        requested_by TEXT,
        timeout_minutes INTEGER,
        expires_at TEXT,
        decided_by_user_id TEXT,
        decided_by TEXT,
        decided_at TEXT,
        reason TEXT,
        edits_json TEXT,
        edited_fields_json TEXT,
        asking_workflow_id TEXT,
        edits_salt TEXT,
        workflow_deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS schema_markers (
        name TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_approval_requests_status_expires ON approval_requests(status, expires_at);
      CREATE INDEX IF NOT EXISTS idx_approval_requests_execution ON approval_requests(execution_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_approval_requests_project ON approval_requests(project_id, status, created_at DESC);
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
    // Phase 11.2 — columns added to approval_requests after it first shipped on this branch.
    this.ensureColumn("approval_requests", "asking_workflow_id", "TEXT");
    this.ensureColumn("approval_requests", "edits_salt", "TEXT");
    this.ensureColumn("approval_requests", "workflow_deleted_at", "TEXT");
    // When approval requests (migration 32) first came up: runs paused before it get one full timeout from here.
    this.exec(`INSERT OR IGNORE INTO schema_markers (name, created_at) VALUES ('approval_requests', ?)`, [new Date().toISOString()]);

    // Phase 15.2 — golden sets (datasets tied to a workflow) and background replay jobs on the eval tables.
    this.ensureColumn("eval_datasets", "workflow_id", "TEXT");
    this.ensureColumn("eval_fixtures", "recording_id", "TEXT");
    this.ensureColumn("eval_runs", "kind", "TEXT NOT NULL", "'eval'");
    this.ensureColumn("eval_runs", "triggered_by_user_id", "TEXT");
    this.ensureColumn("eval_runs", "dataset_ids_json", "TEXT");
    this.ensureColumn("eval_runs", "candidate_json", "TEXT");
    this.ensureColumn("eval_runs", "workflow_hash", "TEXT");
    this.ensureColumn("eval_runs", "workflow_version", "INTEGER");
    this.ensureColumn("eval_runs", "options_json", "TEXT");
    this.ensureColumn("eval_runs", "progress_json", "TEXT");
    this.ensureColumn("eval_results", "recording_id", "TEXT");
    this.ensureColumn("eval_results", "verdict", "TEXT");
    this.ensureColumn("eval_results", "diff_json", "TEXT");
    this.ensureColumn("eval_results", "cost_usd", "REAL");
    this.exec(`CREATE INDEX IF NOT EXISTS idx_eval_datasets_workflow ON eval_datasets(workflow_id)`);
    this.exec(`CREATE INDEX IF NOT EXISTS idx_eval_fixtures_recording ON eval_fixtures(recording_id)`);
    this.exec(`CREATE INDEX IF NOT EXISTS idx_eval_runs_kind ON eval_runs(kind, workflow_id, started_at DESC)`);
    this.exec(`CREATE INDEX IF NOT EXISTS idx_eval_runs_status ON eval_runs(status)`);

    // Phase 15.4 (migration 33) — release gate and publish. NULL published_version: the draft runs everywhere.
    this.ensureColumn("workflows", "published_version", "INTEGER");
    this.ensureColumn("workflow_versions", "pinned", "INTEGER NOT NULL", "0");
    // What a replay job's golden sets held when it was queued, and which published version a production run ran.
    this.ensureColumn("eval_runs", "set_snapshot_json", "TEXT");
    this.ensureColumn("execution_history", "release_channel", "TEXT");
    this.ensureColumn("execution_history", "release_version", "INTEGER");
    this.exec(`
      CREATE TABLE IF NOT EXISTS release_gates (
        workflow_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        enforced INTEGER NOT NULL DEFAULT 0,
        dataset_ids_json TEXT NOT NULL,
        candidate_options_json TEXT,
        policy_json TEXT NOT NULL,
        require_approval INTEGER NOT NULL DEFAULT 0,
        approvers_json TEXT,
        updated_at TEXT NOT NULL,
        updated_by TEXT
      );
      CREATE TABLE IF NOT EXISTS workflow_releases (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        workflow_hash TEXT NOT NULL,
        previous_version INTEGER,
        replay_run_id TEXT,
        verdict TEXT NOT NULL,
        reason TEXT,
        gate_reasons_json TEXT,
        approval_json TEXT,
        published_at TEXT NOT NULL,
        published_by TEXT,
        published_by_user_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_workflow_releases_workflow ON workflow_releases(workflow_id, published_at DESC);
      CREATE TABLE IF NOT EXISTS release_approval_requests (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        workflow_name TEXT,
        project_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        workflow_hash TEXT NOT NULL,
        replay_run_id TEXT,
        origin TEXT NOT NULL,
        gate_reasons_json TEXT,
        gate_updated_at TEXT,
        published_version_at_request INTEGER,
        spec_json TEXT NOT NULL,
        status TEXT NOT NULL,
        request_reason TEXT,
        requested_by_user_id TEXT,
        requested_by TEXT,
        expires_at TEXT,
        decided_by_user_id TEXT,
        decided_by TEXT,
        decided_at TEXT,
        decision_reason TEXT,
        release_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_release_approval_requests_workflow ON release_approval_requests(workflow_id, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_release_approval_requests_status ON release_approval_requests(status, created_at DESC);
    `);

    // Phase 15.6 (migration 34) — production capture: per-workflow capture settings, and candidate recordings
    // (captured runs waiting in the inbox) next to golden ones. Existing rows are golden.
    this.ensureColumn("replay_recordings", "status", "TEXT NOT NULL CHECK (status IN ('candidate', 'golden'))", "'golden'");
    this.ensureColumn("replay_recordings", "captured_at", "TEXT");
    this.exec(`
      CREATE INDEX IF NOT EXISTS idx_replay_recordings_status ON replay_recordings(workflow_id, status, captured_at DESC);
      CREATE TABLE IF NOT EXISTS replay_capture_settings (
        workflow_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        rate REAL NOT NULL DEFAULT 0.1,
        max_per_day INTEGER NOT NULL DEFAULT 20,
        only_statuses_json TEXT NOT NULL,
        dlp INTEGER NOT NULL DEFAULT 1,
        dlp_off_reason TEXT,
        target_dataset_id TEXT,
        updated_at TEXT NOT NULL,
        updated_by TEXT
      );
    `);
    this.ensureColumn("replay_capture_settings", "last_drop_outcome", "TEXT");
    this.ensureColumn("replay_capture_settings", "last_drop_at", "TEXT");

    // Phase 15.6 (migration 35) — guard policy simulations: one row per simulation, grouping its replay jobs.
    this.exec(`
      CREATE TABLE IF NOT EXISTS guard_simulations (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_version INTEGER,
        simulated_hash TEXT NOT NULL,
        base_version INTEGER,
        job_ids_json TEXT NOT NULL,
        summary_json TEXT,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        created_by TEXT,
        created_by_user_id TEXT,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_guard_simulations_profile ON guard_simulations(profile_id, created_at DESC);
    `);

    // Migration 36 — release gate admission: required cases, the admitted cases of enforced gates, gate case requests.
    this.ensureColumn("eval_fixtures", "required", "INTEGER NOT NULL", "0");
    this.ensureColumn("release_gates", "admitted_fixture_ids_json", "TEXT");
    this.ensureColumn("release_gates", "admission_updated_at", "TEXT");
    this.ensureColumn("release_gates", "admission_updated_by", "TEXT");
    this.exec(`
      CREATE TABLE IF NOT EXISTS gate_case_requests (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        workflow_name TEXT,
        project_id TEXT NOT NULL,
        action TEXT NOT NULL,
        fixtures_json TEXT NOT NULL,
        spec_json TEXT NOT NULL,
        gate_authority TEXT,
        status TEXT NOT NULL,
        request_reason TEXT,
        requested_by_user_id TEXT,
        requested_by TEXT,
        expires_at TEXT,
        decided_by_user_id TEXT,
        decided_by TEXT,
        decided_at TEXT,
        decision_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_gate_case_requests_workflow ON gate_case_requests(workflow_id, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_gate_case_requests_status ON gate_case_requests(status, created_at DESC);
    `);
    this.ensureColumn("gate_case_requests", "gate_authority", "TEXT");
    this.ensureColumn("release_approval_requests", "gate_checks_json", "TEXT");
    this.ensureColumn("release_approval_requests", "gate_authority", "TEXT");

    // Migration 37 — Phase 16 data labels on session memory, the session tool cache and session artifacts (null: none recorded).
    this.ensureColumn("session_memory", "labels_json", "TEXT");
    this.ensureColumn("session_tool_cache", "labels_json", "TEXT");
    this.ensureColumn("session_artifacts", "labels_json", "TEXT");
    // Migration 37 — one row counting guard profile writes, bumped by triggers on every insert, update and delete of a
    // profile or version made by any connection (another instance, a worker, a script): cached profile facts key on it.
    this.exec(`
      CREATE TABLE IF NOT EXISTS guard_profile_revision (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO guard_profile_revision (id, revision) VALUES (1, 0);
      ${GUARD_PROFILE_REVISION_TRIGGERS.map(
        ([name, event, table]) =>
          `CREATE TRIGGER IF NOT EXISTS ${name} AFTER ${event} ON ${table} BEGIN UPDATE guard_profile_revision SET revision = revision + 1 WHERE id = 1; END;`
      ).join("\n      ")}
    `);
    // Gates enforced before admission existed admit every case their sets hold now, so they judge as before. Once only:
    // afterwards an enforced gate without a stored admission fails closed (counts nothing until an admin admits its cases).
    this.transaction(() => {
      if (this.queryOne<{ name: string }>(`SELECT name FROM schema_markers WHERE name = 'gate_admission_backfill'`)) return;
      for (const row of this.queryAll<{ workflow_id: string; dataset_ids_json: string }>(
        `SELECT workflow_id, dataset_ids_json FROM release_gates WHERE enforced = 1 AND admitted_fixture_ids_json IS NULL`
      )) {
        const datasetIds = parseJsonArray(row.dataset_ids_json);
        const ids = datasetIds.flatMap((datasetId) =>
          this.queryAll<{ id: string }>(`SELECT id FROM eval_fixtures WHERE dataset_id = ?`, [datasetId]).map((fixture) => toString(fixture.id))
        );
        this.exec(`UPDATE release_gates SET admitted_fixture_ids_json = ?, admission_updated_at = ?, admission_updated_by = ? WHERE workflow_id = ?`, [
          JSON.stringify([...new Set(ids)].sort()),
          new Date().toISOString(),
          "migration 36",
          toString(row.workflow_id)
        ]);
      }
      this.exec(`INSERT OR IGNORE INTO schema_markers (name, created_at) VALUES ('gate_admission_backfill', ?)`, [new Date().toISOString()]);
    });

    // Migration 38 — data destinations: admin rows classifying where outgoing data goes (Phase 16).
    this.exec(`
      CREATE TABLE IF NOT EXISTS data_destinations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        target_id TEXT,
        host TEXT,
        tier TEXT NOT NULL,
        region TEXT NOT NULL DEFAULT 'unknown',
        holds_data_classes_json TEXT NOT NULL DEFAULT '[]',
        note TEXT,
        created_at TEXT NOT NULL,
        created_by TEXT,
        updated_at TEXT NOT NULL,
        updated_by TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_data_destinations_match ON data_destinations(kind, COALESCE(target_id, ''), COALESCE(host, ''));
    `);

    // Migration 39 — schema parity with the Postgres chain, and at most one running guard simulation per deployment
    // (a partial unique index). Several running rows left by an older build: the newest keeps running, the others are
    // `interrupted` (as a restart would finish them), so the index can be built.
    this.exec(`CREATE INDEX IF NOT EXISTS idx_secrets_external_provider_id ON secrets(external_provider_id)`);
    this.transaction(() => {
      if (this.queryOne<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_guard_simulations_one_running'`)) return;
      const { changes } = this.db
        .prepare(
          `UPDATE guard_simulations
              SET status = 'interrupted',
                  error = COALESCE(error, 'Stopped by an upgrade: only one simulation can run at a time.'),
                  finished_at = COALESCE(finished_at, ?)
            WHERE status = 'running'
              AND id <> (SELECT id FROM guard_simulations WHERE status = 'running' ORDER BY created_at DESC, id DESC LIMIT 1)`
        )
        .run(new Date().toISOString());
      this.exec(`CREATE UNIQUE INDEX idx_guard_simulations_one_running ON guard_simulations(status) WHERE status = 'running'`);
      if (changes > 0) {
        this.upgradeNotes.push(
          `v39 upgrade: ${changes} running guard simulation${changes === 1 ? " was" : "s were"} interrupted (only one can run at a time).`
        );
      }
    });

    // Migration 41 — at most one pending approval request per run (a partial unique index), so two API instances
    // backfilling the same paused run cannot both add one. Several pending requests for one run left by an older
    // build: the newest stays pending, the others are canceled as superseded (as recording a new pause does).
    this.transaction(() => {
      if (this.queryOne<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`, [ONE_PENDING_APPROVAL_INDEX])) return;
      const now = new Date().toISOString();
      const { changes } = this.db
        .prepare(
          `UPDATE approval_requests
              SET status = 'canceled',
                  reason = 'Superseded by a newer request of the same run',
                  decided_at = COALESCE(decided_at, ?),
                  updated_at = ?
            WHERE status = 'pending'
              AND id <> (
                SELECT newest.id FROM approval_requests newest
                 WHERE newest.execution_id = approval_requests.execution_id AND newest.status = 'pending'
                 ORDER BY newest.created_at DESC, newest.id DESC LIMIT 1
              )`
        )
        .run(now, now);
      this.exec(`CREATE UNIQUE INDEX ${ONE_PENDING_APPROVAL_INDEX} ON approval_requests(execution_id) WHERE status = 'pending'`);
      if (changes > 0) {
        this.upgradeNotes.push(
          `v41 upgrade: ${changes} duplicate pending approval request${changes === 1 ? " was" : "s were"} canceled (a run has one open request).`
        );
      }
    });

    // Migration 42 — when the published version was taken down (unpublish): production runs the draft, gated or not.
    this.ensureColumn("workflows", "unpublished_at", "TEXT");

    // Migration 43 — queue leases (claim owner, fencing token, heartbeat, pool, lost count, a resume's progress).
    // Written only by consumers in cluster mode (Postgres); on SQLite they keep their defaults and the queue runs as before.
    this.ensureColumn("execution_queue", "execution_id", "TEXT");
    this.exec(
      `UPDATE execution_queue SET execution_id = CASE WHEN instr(id, ':') > 0 THEN substr(id, 1, instr(id, ':') - 1) ELSE id END
       WHERE execution_id IS NULL AND status IN ('pending', 'running')`
    );
    this.exec(`CREATE INDEX IF NOT EXISTS ${QUEUE_ACTIVE_EXECUTION_INDEX} ON execution_queue (execution_id) WHERE status = 'pending' OR status = 'running'`);
    this.ensureColumn("execution_queue", "claimed_by", "TEXT");
    this.ensureColumn("execution_queue", "claim_token", "TEXT");
    this.ensureColumn("execution_queue", "heartbeat_at", "TEXT");
    this.ensureColumn("execution_queue", "pool", "TEXT NOT NULL", "'default'");
    this.ensureColumn("execution_queue", "lost_count", "INTEGER NOT NULL", "0");
    this.ensureColumn("execution_queue", "nodes_completed", "INTEGER NOT NULL", "0");
    this.ensureColumn("execution_queue", "effects_token", "TEXT");
    this.ensureColumn("execution_queue", "effects_started", "INTEGER NOT NULL", "0");
    // Phase 13.1 — queue dispatch: the result a worker stored for the instance waiting on a dispatched run.
    this.ensureColumn("execution_queue", "result_json", "TEXT");
    this.exec(
      `CREATE INDEX IF NOT EXISTS ${QUEUE_CLAIM_INDEX} ON execution_queue (pool, priority DESC, scheduled_at, created_at, id) WHERE status = 'pending'`
    );
    this.exec(`CREATE INDEX IF NOT EXISTS ${QUEUE_RUNNING_HEARTBEAT_INDEX} ON execution_queue (heartbeat_at) WHERE status = 'running'`);
    this.exec(`CREATE INDEX IF NOT EXISTS ${QUEUE_FINISHED_INDEX} ON execution_queue (updated_at) WHERE status = 'completed' OR status = 'dead'`);

    // Phase 13.1 cluster signalling migration — the cluster instance registry and inline-run owners. Postgres writes
    // them; on SQLite (one process) they exist for schema parity and stay empty.
    this.exec(`
      CREATE TABLE IF NOT EXISTS cluster_instances (
        id TEXT PRIMARY KEY,
        worker_mode TEXT NOT NULL,
        ha_enabled INTEGER NOT NULL DEFAULT 0,
        is_leader INTEGER NOT NULL DEFAULT 0,
        pools_json TEXT,
        concurrency INTEGER,
        running INTEGER NOT NULL DEFAULT 0,
        app_version TEXT,
        schema_version INTEGER,
        capabilities_json TEXT,
        hostname TEXT,
        bus_connected INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL
      )
    `);
    this.exec(`CREATE INDEX IF NOT EXISTS idx_cluster_instances_heartbeat_at ON cluster_instances(heartbeat_at)`);
    this.exec(`
      CREATE TABLE IF NOT EXISTS cluster_run_owners (
        execution_id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        started_at TEXT NOT NULL
      )
    `);
    this.exec(`CREATE INDEX IF NOT EXISTS idx_cluster_run_owners_instance_id ON cluster_run_owners(instance_id)`);

    // Phase 13.1 shared auth and per-user flow state migration — written in cluster mode only (Postgres); on SQLite
    // (one process) the app keeps its in-memory maps and these exist for schema parity.
    this.exec(`
      CREATE TABLE IF NOT EXISTS pending_challenges (
        id_hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        user_id TEXT,
        scope TEXT,
        payload_sealed TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )
    `);
    this.exec(`CREATE INDEX IF NOT EXISTS idx_pending_challenges_expires_at ON pending_challenges(expires_at)`);
    this.exec(`CREATE INDEX IF NOT EXISTS idx_pending_challenges_scope ON pending_challenges(kind, scope)`);
    this.ensureColumn("mcp_elicitations", "holder_id", "TEXT");
    this.exec(`
      CREATE TABLE IF NOT EXISTS rate_limit_buckets (
        key TEXT PRIMARY KEY,
        window_start TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        count INTEGER NOT NULL
      )
    `);
    this.exec(`CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_expires_at ON rate_limit_buckets(expires_at)`);
    this.exec(`
      CREATE TABLE IF NOT EXISTS capture_reservations (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )
    `);
    this.exec(`CREATE INDEX IF NOT EXISTS idx_capture_reservations_workflow ON capture_reservations(workflow_id, expires_at)`);

    // Phase 12.4 — argument-aware MCP tool rules (v47): rule conditions, mode and principals; per-call policy
    // decisions; gateway calls a require_approval rule held back.
    this.ensureColumn("mcp_tool_policies", "conditions_json", "TEXT");
    this.ensureColumn("mcp_tool_policies", "mode", "TEXT NOT NULL", "'enforce'");
    this.ensureColumn("mcp_tool_policies", "workflow_ids_json", "TEXT NOT NULL", "'[]'");
    this.ensureColumn("mcp_tool_policies", "client_ids_json", "TEXT NOT NULL", "'[]'");
    this.ensureColumn("mcp_tool_calls", "policy_decision_json", "TEXT");
    this.exec(`
      CREATE TABLE IF NOT EXISTS mcp_gateway_approvals (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        client_name TEXT,
        toolset_id TEXT NOT NULL,
        project_id TEXT,
        server_id TEXT NOT NULL,
        server_name TEXT,
        tool_name TEXT NOT NULL,
        gateway_tool_name TEXT NOT NULL,
        args_hash TEXT NOT NULL,
        args_preview TEXT,
        rule_id TEXT,
        rule_name TEXT,
        message TEXT,
        status TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        decided_by TEXT,
        decided_at TEXT,
        decision_reason TEXT,
        used_at TEXT
      )
    `);
    this.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${GATEWAY_APPROVAL_ONE_PENDING_INDEX} ON mcp_gateway_approvals (client_id, server_id, tool_name, args_hash) WHERE status = 'pending'`
    );
    this.exec(`CREATE INDEX IF NOT EXISTS idx_mcp_gateway_approvals_call ON mcp_gateway_approvals (client_id, server_id, tool_name, args_hash, status)`);
    this.exec(`CREATE INDEX IF NOT EXISTS idx_mcp_gateway_approvals_status ON mcp_gateway_approvals (status, requested_at)`);

    // Phase 12.4 — policies learned from real runs (v49): suggested least-privilege rules per workflow / gateway
    // client and server (one open suggestion each), and the index the window scans of tool calls read.
    this.exec(`
      CREATE TABLE IF NOT EXISTS mcp_policy_suggestions (
        id TEXT PRIMARY KEY,
        scope_kind TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        scope_name TEXT,
        server_id TEXT NOT NULL,
        server_name TEXT,
        status TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        rules_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        window_days INTEGER NOT NULL,
        window_start TEXT NOT NULL,
        window_end TEXT NOT NULL,
        call_count INTEGER NOT NULL,
        accepted_rule_ids_json TEXT NOT NULL DEFAULT '[]',
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        decided_by TEXT,
        decided_at TEXT
      )
    `);
    this.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${POLICY_SUGGESTION_ONE_OPEN_INDEX} ON mcp_policy_suggestions (scope_kind, scope_id, server_id) WHERE status = 'open'`
    );
    this.exec(`CREATE INDEX IF NOT EXISTS idx_mcp_policy_suggestions_status ON mcp_policy_suggestions (status, created_at)`);
    this.exec(`CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_started ON mcp_tool_calls (started_at)`);

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

  async close(): Promise<void> {
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

  async listWorkflows(options: {
    projectId?: string;
    folderId?: string | null;
    tag?: string;
    search?: string;
  } = {}): Promise<WorkflowListItem[]> {
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

  async getWorkflow(id: string): Promise<Workflow | null> {
    return this.getWorkflowSync(id);
  }

  private getWorkflowSync(id: string): Workflow | null {
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
  async upsertWorkflow(workflow: Workflow, options: { createdBy?: string | null } = {}): Promise<Workflow> {
    const now = new Date().toISOString();
    const existing = this.getWorkflowSync(workflow.id);
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
  async getWorkflowCreatedBy(id: string): Promise<string | null> {
    const row = this.queryOne<{ created_by: string | null }>(`SELECT created_by FROM workflows WHERE id = ?`, [id]);
    return row?.created_by ? toString(row.created_by) : null;
  }

  async deleteWorkflow(id: string, options: { refuseIfGateEnforced?: boolean } = {}): Promise<boolean> {
    // The whole delete runs synchronously, so nothing can change the gate between this read and the last delete. A
    // workflow that is already gone is not refused: the delete finds nothing and the caller answers 404.
    if (options.refuseIfGateEnforced && this.queryOne(`SELECT id FROM workflows WHERE id = ?`, [id])) this.gateStateForWriteSync(id, true);
    const hasTable = (tableName: string): boolean => {
      const row = this.queryOne<{ count: number }>(
        `SELECT COUNT(*) as count FROM sqlite_master WHERE type = 'table' AND name = ?`,
        [tableName]
      );
      return (row ? toNumber(row.count) : 0) > 0;
    };

    // Read before the row goes: its nodes name its legacy session namespaces.
    const legacyNamespaces = (this.getWorkflowSync(id)?.nodes ?? []).map((node) => `${id}:${node.id}`);
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

      // Phase 11.2 — decided requests stay as the audit trail (admin-only from here on, even if a new
      // workflow reuses the id); pending ones end with their paused run.
      if (hasTable("approval_requests")) {
        const now = new Date().toISOString();
        this.exec(
          "UPDATE approval_requests SET status = 'canceled', reason = 'The workflow was deleted', decided_at = ?, updated_at = ? WHERE workflow_id = ? AND status = 'pending'",
          [now, now, id]
        );
        this.exec("UPDATE approval_requests SET workflow_deleted_at = ? WHERE workflow_id = ? AND workflow_deleted_at IS NULL", [now, id]);
      }

      if (hasTable("mcp_cassettes")) {
        this.exec("DELETE FROM mcp_cassettes WHERE workflow_id = ?", [id]);
      }

      if (hasTable("replay_recordings")) {
        this.exec("DELETE FROM replay_recordings WHERE workflow_id = ?", [id]);
      }
      if (hasTable("replay_capture_settings")) {
        this.exec("DELETE FROM replay_capture_settings WHERE workflow_id = ?", [id]);
      }

      if (hasTable("guard_events")) {
        this.exec("DELETE FROM guard_events WHERE workflow_id = ?", [id]);
        this.exec("DELETE FROM guard_bindings WHERE scope = 'workflow' AND scope_id = ?", [id]);
      }

      // Workflow ids are chosen by the client, so a new workflow can reuse a
      // deleted one's id. Nothing keyed by the old id may carry over to it:
      // versions, shares, queue and dead-letter rows, eval runs, elicitations,
      // and session state under the old workflow's legacy default namespaces
      // (exactly `<workflowId>:<nodeId>` for its nodes, written before keys
      // were project-scoped; a prefix match would also hit `<workflowId>:x`).
      if (hasTable("workflow_versions")) this.exec("DELETE FROM workflow_versions WHERE workflow_id = ?", [id]);
      if (hasTable("workflow_shares")) this.exec("DELETE FROM workflow_shares WHERE workflow_id = ?", [id]);
      if (hasTable("execution_queue")) this.exec("DELETE FROM execution_queue WHERE workflow_id = ?", [id]);
      if (hasTable("execution_queue_dlq")) this.exec("DELETE FROM execution_queue_dlq WHERE workflow_id = ?", [id]);
      if (hasTable("eval_runs")) {
        if (hasTable("eval_results")) this.exec("DELETE FROM eval_results WHERE run_id IN (SELECT id FROM eval_runs WHERE workflow_id = ?)", [id]);
        this.exec("DELETE FROM eval_runs WHERE workflow_id = ?", [id]);
      }
      if (hasTable("mcp_elicitations")) this.exec("DELETE FROM mcp_elicitations WHERE workflow_id = ?", [id]);
      // Phase 15.4 — the release gate and the release history outlive the
      // workflow: a workflow created again with this id inherits the gate
      // (and, with it on, production refuses runs until a version is
      // published through it). Pending release requests are canceled; their
      // versions were deleted above.
      if (hasTable("release_approval_requests")) {
        const now = new Date().toISOString();
        this.exec(
          `UPDATE release_approval_requests SET status = 'canceled', decided_by = 'system', decided_at = ?, decision_reason = 'The workflow was deleted', updated_at = ?
           WHERE workflow_id = ? AND status = 'pending'`,
          [now, now, id]
        );
      }
      // Migration 36 — pending gate case requests end too: a workflow created again with this id must not inherit them.
      if (hasTable("gate_case_requests")) {
        const now = new Date().toISOString();
        this.exec(
          `UPDATE gate_case_requests SET status = 'canceled', decided_by = 'system', decided_at = ?, decision_reason = 'The workflow was deleted', updated_at = ?
           WHERE workflow_id = ? AND status = 'pending'`,
          [now, now, id]
        );
      }
      if (legacyNamespaces.length > 0) {
        const placeholders = legacyNamespaces.map(() => "?").join(", ");
        for (const table of ["session_memory", "session_tool_cache", "session_artifacts"]) {
          if (hasTable(table)) this.exec(`DELETE FROM ${table} WHERE namespace IN (${placeholders})`, legacyNamespaces);
        }
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

  async countWorkflows(): Promise<number> {
    const row = this.queryOne<{ count: number }>("SELECT COUNT(*) as count FROM workflows");
    return row ? toNumber(row.count) : 0;
  }

  async listSecrets(
    options: { projectId?: string } = {}
  ): Promise<Array<
    Pick<SecretRow, "id" | "name" | "provider" | "created_at"> & {
      projectId: string;
      source: "local" | "external";
      externalProviderId: string | null;
      externalKey: string | null;
    }
  >> {
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

  async getSecret(id: string): Promise<(SecretRow & {
    projectId: string;
    source: "local" | "external";
    externalProviderId: string | null;
    externalKey: string | null;
  }) | null> {
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

  async saveSecret(input: {
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
  }): Promise<void> {
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

  async deleteSecret(id: string): Promise<boolean> {
    const existing = this.queryOne<{ id: string }>(`SELECT id FROM secrets WHERE id = ?`, [id]);
    if (!existing) return false;
    this.exec(`DELETE FROM secrets WHERE id = ?`, [id]);
    this.exec(`DELETE FROM secret_shares WHERE secret_id = ?`, [id]);
    this.exec(`DELETE FROM external_secret_cache WHERE secret_id = ?`, [id]);
    this.persist();
    return true;
  }

  async countUsers(): Promise<number> {
    const row = this.queryOne<{ count: number }>("SELECT COUNT(*) as count FROM users");
    return row ? toNumber(row.count) : 0;
  }

  async getUserByEmail(email: string): Promise<{
    id: string;
    email: string;
    passwordHash: string;
    role: string;
    createdAt: string;
    updatedAt: string;
  } | null> {
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

  async getUserById(id: string): Promise<{
    id: string;
    email: string;
    passwordHash: string;
    role: string;
    createdAt: string;
    updatedAt: string;
  } | null> {
    return this.getUserByIdSync(id);
  }

  private getUserByIdSync(id: string): {
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

  async saveUser(input: {
    id: string;
    email: string;
    passwordHash: string;
    role: string;
  }): Promise<{
    id: string;
    email: string;
    role: string;
    createdAt: string;
    updatedAt: string;
  }> {
    const now = new Date().toISOString();
    const existing = this.getUserByIdSync(input.id);
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

  async listUsers(): Promise<Array<{
    id: string;
    email: string;
    role: string;
    createdAt: string;
    updatedAt: string;
  }>> {
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

  async updateUserRole(id: string, role: string): Promise<boolean> {
    const existing = this.getUserByIdSync(id);
    if (!existing) return false;
    const now = new Date().toISOString();
    this.exec(
      `UPDATE users SET role = ?, updated_at = ? WHERE id = ?`,
      [role, now, id]
    );
    this.persist();
    return true;
  }

  /**
   * Phase 13.1 — removes the user with its sessions, API keys, MFA secret, SSO identities and project roles in one
   * transaction (Postgres keeps foreign keys on those rows, so both stores remove them explicitly).
   */
  async deleteUser(id: string): Promise<boolean> {
    const changed = this.db.transaction(() => {
      this.exec(`DELETE FROM sessions WHERE user_id = ?`, [id]);
      this.exec(`DELETE FROM api_keys WHERE user_id = ?`, [id]);
      this.exec(`DELETE FROM mfa_secrets WHERE user_id = ?`, [id]);
      this.exec(`DELETE FROM sso_identities WHERE user_id = ?`, [id]);
      this.exec(`DELETE FROM user_project_roles WHERE user_id = ?`, [id]);
      return this.db.prepare(`DELETE FROM users WHERE id = ?`).run(id).changes > 0;
    })();
    this.persist();
    return changed;
  }

  async getSession(sessionId: string): Promise<{
    id: string;
    userId: string;
    expiresAt: string;
    createdAt: string;
    lastSeenAt: string;
    revokedAt: string | null;
  } | null> {
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

  async saveSession(input: {
    id: string;
    userId: string;
    expiresAt: string;
  }): Promise<{
    id: string;
    userId: string;
    expiresAt: string;
    createdAt: string;
    lastSeenAt: string;
  }> {
    const now = new Date().toISOString();

    try {
      this.exec(
        `INSERT INTO sessions (id, user_id, expires_at, created_at, last_seen_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
        [input.id, input.userId, input.expiresAt, now, now]
      );
    } catch (error) {
      // The sessions table declares its user key, so SQLite refuses a session for a user deleted meanwhile.
      if (isForeignKeyViolation(error)) throw new StoreReferenceMissingError();
      throw error;
    }

    this.persist();
    return {
      id: input.id,
      userId: input.userId,
      expiresAt: input.expiresAt,
      createdAt: now,
      lastSeenAt: now
    };
  }

  async touchSession(sessionId: string): Promise<void> {
    this.exec(
      `UPDATE sessions
       SET last_seen_at = ?
       WHERE id = ? AND revoked_at IS NULL`,
      [new Date().toISOString(), sessionId]
    );
    this.persist();
  }

  async revokeSession(sessionId: string): Promise<void> {
    this.exec(
      `UPDATE sessions
       SET revoked_at = ?
       WHERE id = ? AND revoked_at IS NULL`,
      [new Date().toISOString(), sessionId]
    );
    this.persist();
  }

  async revokeExpiredSessions(): Promise<void> {
    this.exec(
      `UPDATE sessions
       SET revoked_at = ?
       WHERE revoked_at IS NULL AND expires_at <= ?`,
      [new Date().toISOString(), new Date().toISOString()]
    );
    this.persist();
  }

  async loadSessionMemory(namespace: string, sessionId: string): Promise<ChatMessage[]> {
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

  /** Migration 37 — the labels stored with a session's memory; null when none were recorded. */
  async loadSessionMemoryLabels(namespace: string, sessionId: string): Promise<DataLabels | null> {
    const row = this.queryOne<{ labels_json: string | null }>(
      `SELECT labels_json FROM session_memory WHERE namespace = ? AND session_id = ?`,
      [namespace, sessionId]
    );
    return row ? parseStoredDataLabels(row.labels_json) : null;
  }

  /**
   * Saves a session's memory. `labels` (Phase 16) are given only while the
   * run tracks labels and are merged with the labels already stored; a save
   * without them (an untracked run) keeps the stored labels and adds
   * `untrusted_external` (it re-saves the old messages with a turn of unknown
   * origin); a row with no labels stays without.
   */
  async saveSessionMemory(namespace: string, sessionId: string, messages: ChatMessage[], labels?: DataLabels): Promise<void> {
    const existing = this.queryOne<SessionMemoryRow>(
      `SELECT namespace, session_id, messages_json, labels_json, created_at, updated_at
       FROM session_memory
       WHERE namespace = ? AND session_id = ?`,
      [namespace, sessionId]
    );
    const now = new Date().toISOString();
    const createdAt = existing ? toString(existing.created_at) : now;

    if (labels) {
      const merged = mergeDataLabels([parseStoredDataLabels(existing?.labels_json ?? null), labels].filter((entry): entry is DataLabels => Boolean(entry)));
      const labelsJson = merged && !isEmptyDataLabels(merged) ? JSON.stringify({ ...merged, source: "propagated" }) : existing?.labels_json ?? null;
      this.exec(
        `INSERT INTO session_memory (namespace, session_id, messages_json, labels_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(namespace, session_id) DO UPDATE SET
           messages_json = excluded.messages_json,
           labels_json = excluded.labels_json,
           updated_at = excluded.updated_at`,
        [namespace, sessionId, JSON.stringify(messages), labelsJson, createdAt, now]
      );
    } else {
      // An untracked run loads the stored messages and saves them again with its turn: the labels stay, plus
      // `untrusted_external` for the unknown new turn. Nothing stored means nothing written (zero-config).
      const kept = labelsForUntrackedSave(parseStoredDataLabels(existing?.labels_json ?? null));
      this.exec(
        `INSERT INTO session_memory (namespace, session_id, messages_json, labels_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(namespace, session_id) DO UPDATE SET
           messages_json = excluded.messages_json,
           labels_json = excluded.labels_json,
           updated_at = excluded.updated_at`,
        [namespace, sessionId, JSON.stringify(messages), kept ? JSON.stringify(kept) : null, createdAt, now]
      );
    }

    this.persist();
  }

  async saveSessionToolCall(input: {
    namespace: string;
    sessionId: string;
    toolName: string;
    toolCallId?: string;
    args: Record<string, unknown>;
    output: unknown;
    error?: string;
    summary?: unknown;
    /** Phase 16 — given only while the run tracks labels. */
    labels?: DataLabels;
  }): Promise<{
    id: string;
    namespace: string;
    sessionId: string;
    toolName: string;
    toolCallId?: string;
    args: Record<string, unknown>;
    output: unknown;
    error?: string;
    summary?: unknown;
    labels?: DataLabels | null;
    createdAt: string;
  }> {
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
          labels_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.labels && !isEmptyDataLabels(input.labels) ? JSON.stringify(input.labels) : null,
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
      ...(input.labels && !isEmptyDataLabels(input.labels) ? { labels: input.labels } : {}),
      createdAt: now
    };
  }

  async listSessionToolCalls(input: {
    namespace: string;
    sessionId: string;
    toolName?: string;
    limit?: number;
  }): Promise<Array<{
    id: string;
    namespace: string;
    sessionId: string;
    toolName: string;
    toolCallId?: string;
    args: Record<string, unknown>;
    error?: string;
    summary?: unknown;
    labels?: DataLabels | null;
    createdAt: string;
  }>> {
    const limit =
      typeof input.limit === "number" && Number.isFinite(input.limit) && input.limit > 0
        ? Math.min(Math.floor(input.limit), 200)
        : 20;

    const toolName =
      typeof input.toolName === "string" && input.toolName.trim().length > 0 ? input.toolName.trim() : undefined;
    let rows: SessionToolCacheRow[];
    if (toolName) {
      rows = this.queryAll<SessionToolCacheRow>(
        `SELECT id, namespace, session_id, tool_name, tool_call_id, args_json, output_json, error, summary_json, labels_json, created_at
         FROM session_tool_cache
         WHERE namespace = ? AND session_id = ? AND tool_name = ?
         ORDER BY created_at DESC
         LIMIT ?`,
        [input.namespace, input.sessionId, toolName, limit]
      );
    } else {
      rows = this.queryAll<SessionToolCacheRow>(
        `SELECT id, namespace, session_id, tool_name, tool_call_id, args_json, output_json, error, summary_json, labels_json, created_at
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
        ...labelsField(row.labels_json),
        createdAt: toString(row.created_at)
      };
    });
  }

  async getSessionToolCall(input: {
    namespace: string;
    sessionId: string;
    id: string;
  }): Promise<{
    id: string;
    namespace: string;
    sessionId: string;
    toolName: string;
    toolCallId?: string;
    args: Record<string, unknown>;
    output: unknown;
    error?: string;
    summary?: unknown;
    labels?: DataLabels | null;
    createdAt: string;
  } | null> {
    const row = this.queryOne<SessionToolCacheRow>(
      `SELECT id, namespace, session_id, tool_name, tool_call_id, args_json, output_json, error, summary_json, labels_json, created_at
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
      ...labelsField(row.labels_json),
      createdAt: toString(row.created_at)
    };
  }

  /**
   * Saves a session artifact. `labels` (Phase 16) are given only while the
   * run tracks labels and replace the stored ones with the value; a save
   * without them (an untracked run) keeps the stored labels and adds
   * `untrusted_external` (the value may carry the old one forward); a row
   * with no labels stays without.
   */
  async saveSessionArtifact(input: {
    namespace: string;
    sessionId: string;
    artifactKey: string;
    value: unknown;
    labels?: DataLabels;
  }): Promise<{
    namespace: string;
    sessionId: string;
    artifactKey: string;
    value: unknown;
    labels?: DataLabels | null;
    createdAt: string;
    updatedAt: string;
  }> {
    const existing = this.queryOne<SessionArtifactRow>(
      `SELECT namespace, session_id, artifact_key, value_json, labels_json, created_at, updated_at
       FROM session_artifacts
       WHERE namespace = ? AND session_id = ? AND artifact_key = ?`,
      [input.namespace, input.sessionId, input.artifactKey]
    );
    const now = new Date().toISOString();
    const createdAt = existing ? toString(existing.created_at) : now;
    // Phase 16 — a tracked save replaces the labels (its load put the old ones into the labels it saves). An untracked
    // save (no labels given) may carry the old value forward: the stored labels stay, plus `untrusted_external`.
    const labels = input.labels === undefined ? labelsForUntrackedSave(parseStoredDataLabels(existing?.labels_json ?? null)) ?? undefined : !isEmptyDataLabels(input.labels) ? input.labels : undefined;
    this.exec(
      `INSERT INTO session_artifacts (namespace, session_id, artifact_key, value_json, labels_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(namespace, session_id, artifact_key) DO UPDATE SET
         value_json = excluded.value_json,
         labels_json = excluded.labels_json,
         updated_at = excluded.updated_at`,
      [
        input.namespace,
        input.sessionId,
        input.artifactKey,
        JSON.stringify(input.value ?? null),
        labels ? JSON.stringify({ ...labels, source: "propagated" }) : null,
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
      ...(labels ? { labels } : {}),
      createdAt,
      updatedAt: now
    };
  }

  async loadSessionArtifact(input: {
    namespace: string;
    sessionId: string;
    artifactKey: string;
  }): Promise<{
    namespace: string;
    sessionId: string;
    artifactKey: string;
    value: unknown;
    labels?: DataLabels | null;
    createdAt: string;
    updatedAt: string;
  } | null> {
    const row = this.queryOne<SessionArtifactRow>(
      `SELECT namespace, session_id, artifact_key, value_json, labels_json, created_at, updated_at
       FROM session_artifacts
       WHERE namespace = ? AND session_id = ? AND artifact_key = ?`,
      [input.namespace, input.sessionId, input.artifactKey]
    );

    if (!row) {
      return null;
    }

    const labels = parseStoredDataLabels(row.labels_json ?? null);
    return {
      namespace: toString(row.namespace),
      sessionId: toString(row.session_id),
      artifactKey: toString(row.artifact_key),
      value: parseJsonSafe(row.value_json),
      ...(labels ? { labels } : {}),
      createdAt: toString(row.created_at),
      updatedAt: toString(row.updated_at)
    };
  }

  async clearExpiredWebhookSecurityState(nowIso = new Date().toISOString()): Promise<void> {
    this.exec(`DELETE FROM webhook_replay_keys WHERE expires_at <= ?`, [nowIso]);
    this.exec(`DELETE FROM webhook_idempotency WHERE expires_at <= ?`, [nowIso]);
    this.persist();
  }

  async hasWebhookReplayKey(replayKey: string): Promise<boolean> {
    const row = this.queryOne<WebhookReplayRow>(
      `SELECT replay_key, endpoint_key, created_at, expires_at
       FROM webhook_replay_keys
       WHERE replay_key = ?`,
      [replayKey]
    );
    return Boolean(row);
  }

  async saveWebhookReplayKey(input: { replayKey: string; endpointKey: string; expiresAt: string }): Promise<boolean> {
    const result = this.db
      .prepare(
        `INSERT INTO webhook_replay_keys (replay_key, endpoint_key, created_at, expires_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(replay_key) DO NOTHING`
      )
      .run(input.replayKey, input.endpointKey, new Date().toISOString(), input.expiresAt);
    this.persist();
    return result.changes > 0;
  }

  async getWebhookIdempotency(input: { endpointKey: string; idempotencyKey: string }): Promise<{
    endpointKey: string;
    idempotencyKey: string;
    requestHash: string;
    status: string;
    result: unknown;
    createdAt: string;
    updatedAt: string;
    expiresAt: string;
  } | null> {
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

  async saveWebhookIdempotencyPending(input: {
    endpointKey: string;
    idempotencyKey: string;
    requestHash: string;
    expiresAt: string;
  }): Promise<void> {
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

  async saveWebhookIdempotencyResult(input: {
    endpointKey: string;
    idempotencyKey: string;
    status: "success" | "error" | "partial" | "waiting_approval" | "canceled";
    result: unknown;
  }): Promise<void> {
    const now = new Date().toISOString();
    this.exec(
      `UPDATE webhook_idempotency
       SET status = ?, result_json = ?, updated_at = ?
       WHERE endpoint_key = ? AND idempotency_key = ?`,
      [input.status, JSON.stringify(input.result ?? null), now, input.endpointKey, input.idempotencyKey]
    );
    this.persist();
  }

  async saveExecutionHistory(input: {
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
  }, options?: { unlessFinished?: boolean; unlessCanceled?: boolean; unlessInterruptedWith?: string; fence?: QueueClaimFence }): Promise<boolean> {
    const fence = options?.fence;
    if (fence) {
      // Phase 13.1 — a queued run in cluster mode writes only while its claim still holds the queue item (one
      // transaction: nothing can take the item back in between on this single-process store).
      return this.db.transaction(() => this.queueClaimHeldSync(fence) && this.writeExecutionHistory(input, options))();
    }
    return this.writeExecutionHistory(input, options);
  }

  private writeExecutionHistory(
    input: Parameters<Store["saveExecutionHistory"]>[0],
    options?: { unlessFinished?: boolean; unlessCanceled?: boolean; unlessInterruptedWith?: string }
  ): boolean {
    const condition = options?.unlessFinished
      ? `${FINISHED_HISTORY_SQL("execution_history")} = 0`
      : options?.unlessCanceled
        ? `execution_history.status <> 'canceled' OR excluded.status = 'canceled'`
        : "";
    // Phase 13.1 — a run the dead-executor reconcile already failed keeps that record (see Store.saveExecutionHistory).
    const interrupted = options?.unlessInterruptedWith !== undefined;
    const fence = `NOT (execution_history.status = 'error' AND (execution_history.error IS NULL OR execution_history.error = ?))`;
    const guard = interrupted
      ? `
        WHERE ${condition ? `(${condition}) AND ` : ""}${fence}`
      : condition
        ? `
        WHERE ${condition}`
        : "";
    const result = this.db.prepare(
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
          error = excluded.error${guard}`
    ).run(
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
        input.error ?? null,
        ...(interrupted ? [options.unlessInterruptedWith] : [])
    );
    this.persist();
    return result.changes > 0;
  }

  async listExecutionHistory(input: {
    page?: number;
    pageSize?: number;
    status?: string;
    workflowId?: string;
    /** Only runs of these workflows; an empty list matches nothing. */
    workflowIds?: string[];
    triggerType?: string;
    startedFrom?: string;
    startedTo?: string;
  }): Promise<{
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
  }> {
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

  async getExecutionHistory(id: string): Promise<{
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
  } | null> {
    return this.getExecutionHistorySync(id);
  }

  private getExecutionHistorySync(id: string): {
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

  async cancelExecution(input: {
    id: string;
    onlyFrom: readonly string[];
    completedAt?: string;
    error?: string;
    deletePausedState?: boolean;
    cancelClaimed?: boolean;
  }): Promise<CancelExecutionResult> {
    const result = this.transaction((): CancelExecutionResult => {
      const refuse = (outcome: CancelExecutionResult["outcome"]): CancelExecutionResult => ({ outcome, canceledRequestIds: [] });
      const existing = this.getExecutionHistorySync(input.id);
      if (!existing) return refuse("missing");
      const open = existing.status !== "partial" || !existing.completedAt;
      if (!input.onlyFrom.includes(existing.status) || !open) return refuse("not_cancelable");
      if (input.deletePausedState) {
        const paused = this.queryOne<{ status: string }>(`SELECT status FROM workflow_executions WHERE id = ?`, [input.id]);
        if (paused && toString(paused.status) !== "waiting_approval" && !input.cancelClaimed) return refuse("decided");
        if (paused) this.exec(`DELETE FROM workflow_executions WHERE id = ?`, [input.id]);
      }
      const completedAt = input.completedAt ?? new Date().toISOString();
      const canceledRequestIds: string[] = [];
      if (input.deletePausedState) {
        for (const row of this.queryAll<{ id: string }>(
          `SELECT id FROM approval_requests WHERE execution_id = ? AND status = 'pending' ORDER BY created_at, id`,
          [input.id]
        )) {
          canceledRequestIds.push(toString(row.id));
        }
        this.exec(
          `UPDATE approval_requests SET status = 'canceled', reason = ?, decided_at = ?, updated_at = ? WHERE execution_id = ? AND status = 'pending'`,
          [input.error ?? "Execution canceled", completedAt, completedAt, input.id]
        );
      }
      this.exec(
        `UPDATE execution_history
         SET status = 'canceled',
             completed_at = ?,
             duration_ms = ?,
             error = ?
         WHERE id = ?`,
        [completedAt, toDurationMsForStore(existing.startedAt, completedAt), input.error ?? "Execution canceled", input.id]
      );
      return { outcome: "canceled", canceledRequestIds };
    });
    if (result.outcome === "canceled") this.persist();
    return result;
  }

  async pruneExecutionHistory(input: { before: string }): Promise<number> {
    const before = this.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM execution_history WHERE started_at < ?`,
      [input.before]
    );
    this.exec(`DELETE FROM execution_history WHERE started_at < ?`, [input.before]);
    // Phase 10.1 — tool-call telemetry follows the execution-history retention.
    this.exec(`DELETE FROM mcp_tool_calls WHERE started_at < ?`, [input.before]);
    // Phase 12.4 — and gateway approval requests (their argument previews).
    this.exec(`DELETE FROM mcp_gateway_approvals WHERE requested_at < ?`, [input.before]);
    // Phase 10.8 — so do cassettes recorded from those runs.
    this.exec(`DELETE FROM mcp_cassettes WHERE created_at < ?`, [input.before]);
    // Phase 12.1 — and so do guard events.
    this.exec(`DELETE FROM guard_events WHERE created_at < ?`, [input.before]);
    // Phase 11.2 — and decided approval requests; pending ones stay with their paused run.
    this.exec(`DELETE FROM approval_requests WHERE status <> 'pending' AND created_at < ?`, [input.before]);
    // Phase 13.1 — and finished queue jobs and dead-letter entries: their payloads (a dispatched run's spec, with its
    // input) and stored results never outlive the history.
    this.exec(`DELETE FROM execution_queue WHERE (status = 'completed' OR status = 'dead') AND updated_at < ?`, [input.before]);
    this.exec(`DELETE FROM execution_queue_dlq WHERE failed_at < ?`, [input.before]);
    const deleted = before ? toNumber(before.count) : 0;
    if (deleted > 0) {
      this.persist();
    }
    return deleted;
  }

  async saveWorkflowExecutionState(input: {
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
  }, options: { fence?: QueueClaimFence } = {}): Promise<boolean> {
    const now = new Date().toISOString();
    const write = () => this.exec(
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
    const fence = options.fence;
    if (fence) {
      // Phase 13.1 — a queued run in cluster mode pauses only while its claim still holds the queue item.
      const written = this.db.transaction(() => {
        if (!this.queueClaimHeldSync(fence)) return false;
        write();
        return true;
      })();
      if (written) this.persist();
      return written;
    }
    write();
    this.persist();
    return true;
  }

  async getWorkflowExecutionState(id: string): Promise<{
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
  } | null> {
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

  async listPendingApprovals(): Promise<Array<{
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
  }>> {
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

  async deleteWorkflowExecution(id: string): Promise<boolean> {
    const before = this.queryOne<{ count: number }>("SELECT COUNT(*) as count FROM workflow_executions WHERE id = ?", [id]);
    this.exec("DELETE FROM workflow_executions WHERE id = ?", [id]);
    const after = this.queryOne<{ count: number }>("SELECT COUNT(*) as count FROM workflow_executions WHERE id = ?", [id]);
    const deleted = (before ? toNumber(before.count) : 0) > (after ? toNumber(after.count) : 0);
    if (deleted) {
      this.persist();
    }
    return deleted;
  }

  /**
   * Phase 11.2 — move a paused run to `resuming` once, so two decisions (two
   * approvers, or an approver and the timeout sweeper) cannot both resume it.
   */
  async claimWorkflowExecutionForResume(id: string): Promise<boolean> {
    return this.claimWorkflowExecutionForResumeSync(id);
  }

  private claimWorkflowExecutionForResumeSync(id: string): boolean {
    const result = this.db
      .prepare(`UPDATE workflow_executions SET status = 'resuming', updated_at = ? WHERE id = ? AND status = 'waiting_approval'`)
      .run(new Date().toISOString(), id);
    if (result.changes > 0) this.persist();
    return result.changes > 0;
  }

  /** Phase 11.2 — paused runs a decision was taken for but whose resume did not finish (the process stopped). */
  async listResumingWorkflowExecutionIds(): Promise<string[]> {
    return this.queryAll<{ id: string }>(`SELECT id FROM workflow_executions WHERE status = 'resuming' ORDER BY updated_at ASC`).map((row) => toString(row.id));
  }

  /** Phase 11.2 — paused runs in `resuming` whose claim is older than `before`, with the claim time. */
  async listResumingWorkflowExecutions(before?: string): Promise<Array<{ id: string; claimedAt: string }>> {
    const rows = before
      ? this.queryAll<{ id: string; updated_at: string }>(`SELECT id, updated_at FROM workflow_executions WHERE status = 'resuming' AND updated_at < ? ORDER BY updated_at ASC`, [before])
      : this.queryAll<{ id: string; updated_at: string }>(`SELECT id, updated_at FROM workflow_executions WHERE status = 'resuming' ORDER BY updated_at ASC`);
    return rows.map((row) => ({ id: toString(row.id), claimedAt: toString(row.updated_at) }));
  }

  /** Phase 11.2 — hand a claimed run back to the waiting state (the resume could not start). False when it was not claimed. */
  async releaseWorkflowExecutionClaim(id: string): Promise<boolean> {
    return this.releaseWorkflowExecutionClaimSync(id);
  }

  private releaseWorkflowExecutionClaimSync(id: string): boolean {
    const result = this.db
      .prepare(`UPDATE workflow_executions SET status = 'waiting_approval', updated_at = ? WHERE id = ? AND status = 'resuming'`)
      .run(new Date().toISOString(), id);
    if (result.changes > 0) this.persist();
    return result.changes > 0;
  }

  /** Runs `fn` in one SQLite transaction: every statement commits together, or none does when it throws. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** Phase 11.2 — when a schema marker was first written (see `schema_markers`). */
  async getSchemaMarker(name: string): Promise<string | null> {
    const row = this.queryOne<{ created_at: string }>(`SELECT created_at FROM schema_markers WHERE name = ?`, [name]);
    return row ? toString(row.created_at) : null;
  }

  /** Phase 13.1 — of these execution ids, the ones a pending or running queue job drives (see Store). */
  async listExecutionIdsWithActiveQueueJob(executionIds: string[]): Promise<string[]> {
    const ids = [...new Set(executionIds.filter((id) => typeof id === "string" && id.length > 0))];
    const found: string[] = [];
    for (let start = 0; start < ids.length; start += 200) {
      const chunk = ids.slice(start, start + 200);
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.queryAll<{ id: string; execution_id: string | null }>(
        `SELECT id, execution_id FROM execution_queue
          WHERE status IN ('pending', 'running')
            AND (execution_id IN (${placeholders}) OR execution_id IS NULL)`,
        chunk
      );
      for (const id of chunk) {
        if (rows.some((row) => (row.execution_id !== null ? row.execution_id === id : row.id === id || row.id.startsWith(`${id}:`)))) {
          found.push(id);
        }
      }
    }
    return found.sort();
  }

  /** Phase 11.2 — whether a queue item with this id, or one that extends it (`<id>:…`), is still waiting or running. */
  async hasActiveQueueItem(id: string): Promise<boolean> {
    const row = this.queryOne<{ id: string }>(
      `SELECT id FROM execution_queue WHERE (id = ? OR id LIKE ? ESCAPE '\\') AND status IN ('pending', 'running') LIMIT 1`,
      [id, `${id.replace(/[\\%_]/g, "\\$&")}:%`]
    );
    return Boolean(row);
  }

  // -------------------------------------------------------------------------
  // Phase 11.2 — approval requests
  // -------------------------------------------------------------------------

  async insertApprovalRequest(input: ApprovalRequestInsert, options: { fence?: QueueClaimFence; supersedeReason?: string } = {}): Promise<ApprovalRequestRecord> {
    const now = input.createdAt ?? new Date().toISOString();
    const insertRow = () => this.exec(
      `INSERT INTO approval_requests (
         id, execution_id, workflow_id, workflow_name, project_id, node_id, node_type, kind, status, message,
         spec_json, path_json, details_json, requested_by_user_id, requested_by, timeout_minutes, expires_at,
         asking_workflow_id, edits_salt, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.executionId,
        input.workflowId,
        input.workflowName ?? null,
        input.projectId,
        input.nodeId,
        input.nodeType ?? null,
        input.kind,
        input.message ?? null,
        JSON.stringify(input.spec),
        JSON.stringify(input.path ?? []),
        input.details ? JSON.stringify(input.details) : null,
        input.requestedByUserId ?? null,
        input.requestedBy ?? null,
        typeof input.timeoutMinutes === "number" ? Math.floor(input.timeoutMinutes) : null,
        input.expiresAt ?? null,
        input.askingWorkflowId ?? null,
        input.editsSalt ?? null,
        now,
        now
      ]
    );
    // The run's earlier pending request is superseded in the same transaction as the insert.
    const supersedeReason = options.supersedeReason;
    const insert = () => {
      if (supersedeReason !== undefined) this.cancelPendingApprovalRequestsSync({ executionId: input.executionId }, supersedeReason);
      insertRow();
    };
    const fence = options.fence;
    if (fence) {
      // Phase 13.1 — a queued run in cluster mode asks for approval (and supersedes its earlier request) only while its
      // claim still holds the queue item.
      const inserted = this.db.transaction(() => {
        if (!this.queueClaimHeldSync(fence)) return false;
        insert();
        return true;
      })();
      if (!inserted) throw new QueueClaimLostError("an approval request");
    } else {
      this.db.transaction(insert)();
    }
    this.persist();
    return this.getApprovalRequestSync(input.id)!;
  }

  async getApprovalRequest(id: string): Promise<ApprovalRequestRecord | null> {
    return this.getApprovalRequestSync(id);
  }

  private getApprovalRequestSync(id: string): ApprovalRequestRecord | null {
    const row = this.queryOne<ApprovalRequestRow>(`SELECT * FROM approval_requests WHERE id = ?`, [id]);
    return row ? mapApprovalRequestRow(row) : null;
  }

  /** The newest pending request of a paused run. */
  async getPendingApprovalRequestForExecution(executionId: string): Promise<ApprovalRequestRecord | null> {
    const row = this.queryOne<ApprovalRequestRow>(
      `SELECT * FROM approval_requests WHERE execution_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
      [executionId]
    );
    return row ? mapApprovalRequestRow(row) : null;
  }

  async listApprovalRequestsForExecution(executionId: string): Promise<ApprovalRequestRecord[]> {
    return this.queryAll<ApprovalRequestRow>(`SELECT * FROM approval_requests WHERE execution_id = ? ORDER BY created_at ASC, id ASC`, [executionId]).map(mapApprovalRequestRow);
  }

  async listApprovalRequests(filter: { status: "pending" | "decided" | "all"; workflowId?: string; executionId?: string; limit?: number; scope?: ApprovalReadScope }): Promise<ApprovalRequestRecord[]> {
    const clauses: string[] = [];
    const params: BindParams = [];
    // Filtered before the limit, so other projects' requests never crowd out the user's own.
    if (filter.scope && !filter.scope.all) {
      // By workflow, not the stored project_id: a workflow moved to another
      // project takes its requests with it.
      const { workflowIds } = filter.scope;
      if (workflowIds.length === 0) return [];
      clauses.push(`workflow_id IN (${workflowIds.map(() => "?").join(", ")})`);
      params.push(...workflowIds);
      // A deleted workflow's requests stay admin-only, also when a new workflow reuses its id.
      clauses.push(`workflow_deleted_at IS NULL`);
    }
    if (filter.status === "pending") clauses.push(`status = 'pending'`);
    if (filter.status === "decided") clauses.push(`status <> 'pending'`);
    if (filter.workflowId) {
      clauses.push(`workflow_id = ?`);
      params.push(filter.workflowId);
    }
    if (filter.executionId) {
      clauses.push(`execution_id = ?`);
      params.push(filter.executionId);
    }
    const limit = Math.max(1, Math.min(1_000, Math.floor(filter.limit ?? 200)));
    const order = filter.status === "decided" ? "COALESCE(decided_at, updated_at) DESC" : "created_at DESC";
    return this.queryAll<ApprovalRequestRow>(
      `SELECT * FROM approval_requests ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY ${order}, id DESC LIMIT ${limit}`,
      params
    ).map(mapApprovalRequestRow);
  }

  /** Pending requests past their expiry, oldest first. */
  async listExpiredApprovalRequests(now: string, limit = 100): Promise<ApprovalRequestRecord[]> {
    return this.queryAll<ApprovalRequestRow>(
      `SELECT * FROM approval_requests WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at ASC LIMIT ?`,
      [now, Math.max(1, Math.floor(limit))]
    ).map(mapApprovalRequestRow);
  }

  /** Records a decision once: false when the request was no longer pending. */
  async decideApprovalRequest(input: {
    id: string;
    status: "approved" | "rejected" | "timed_out" | "canceled";
    decidedByUserId?: string | null;
    decidedBy?: string | null;
    reason?: string | null;
    edits?: Record<string, unknown> | null;
    editedFields?: string[];
    decidedAt?: string;
  }): Promise<boolean> {
    return this.decideApprovalRequestSync(input);
  }

  private decideApprovalRequestSync(input: {
    id: string;
    status: "approved" | "rejected" | "timed_out" | "canceled";
    decidedByUserId?: string | null;
    decidedBy?: string | null;
    reason?: string | null;
    edits?: Record<string, unknown> | null;
    editedFields?: string[];
    decidedAt?: string;
  }): boolean {
    const decidedAt = input.decidedAt ?? new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE approval_requests
            SET status = ?, decided_by_user_id = ?, decided_by = ?, decided_at = ?, reason = ?, edits_json = ?, edited_fields_json = ?, updated_at = ?
          WHERE id = ? AND status = 'pending'`
      )
      .run(
        input.status,
        input.decidedByUserId ?? null,
        input.decidedBy ?? null,
        decidedAt,
        input.reason ?? null,
        input.edits ? JSON.stringify(input.edits) : null,
        JSON.stringify(input.editedFields ?? []),
        decidedAt,
        input.id
      );
    if (result.changes > 0) this.persist();
    return result.changes > 0;
  }

  /**
   * Phase 11.2 — puts a decided request back to pending (its resume could not
   * run), clearing the decision. Its expiry is unchanged. False when it was
   * not in a decided state.
   */
  async reopenApprovalRequest(id: string): Promise<boolean> {
    return this.reopenApprovalRequestSync(id);
  }

  private reopenApprovalRequestSync(id: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE approval_requests
            SET status = 'pending', decided_by_user_id = NULL, decided_by = NULL, decided_at = NULL, reason = NULL,
                edits_json = NULL, edited_fields_json = NULL, updated_at = ?
          WHERE id = ? AND status IN ('approved', 'rejected', 'timed_out')`
      )
      .run(new Date().toISOString(), id);
    if (result.changes > 0) this.persist();
    return result.changes > 0;
  }

  /** Cancels every pending request of a run (the run was canceled or its workflow deleted). */
  async cancelPendingApprovalRequests(filter: { executionId?: string; workflowId?: string }, reason: string): Promise<number> {
    const changes = this.cancelPendingApprovalRequestsSync(filter, reason);
    if (changes > 0) this.persist();
    return changes;
  }

  private cancelPendingApprovalRequestsSync(filter: { executionId?: string; workflowId?: string }, reason: string): number {
    const column = filter.executionId ? "execution_id" : "workflow_id";
    const value = filter.executionId ?? filter.workflowId;
    if (!value) return 0;
    const now = new Date().toISOString();
    return this.db
      .prepare(`UPDATE approval_requests SET status = 'canceled', reason = ?, decided_at = ?, updated_at = ? WHERE ${column} = ? AND status = 'pending'`)
      .run(reason, now, now, value).changes;
  }

  // -------------------------------------------------------------------------
  // Execution Queue methods
  // -------------------------------------------------------------------------

  async enqueueExecution(input: {
    id: string;
    workflowId: string;
    workflowName?: string;
    payload: Record<string, unknown>;
    priority?: number;
    maxAttempts?: number;
    scheduledAt?: string;
    pool?: string;
    replaceFinishedBefore?: string;
  }): Promise<boolean> {
    const now = new Date().toISOString();
    // A finished item past the window is replaced by the new job: every column back to a fresh pending item.
    const onConflict = input.replaceFinishedBefore
      ? `ON CONFLICT(id) DO UPDATE SET
           workflow_id = excluded.workflow_id, workflow_name = excluded.workflow_name, payload_json = excluded.payload_json,
           status = 'pending', priority = excluded.priority, attempts = 0, max_attempts = excluded.max_attempts, last_error = NULL,
           scheduled_at = excluded.scheduled_at, started_at = NULL, completed_at = NULL, created_at = excluded.created_at,
           updated_at = excluded.updated_at, pool = excluded.pool, execution_id = excluded.execution_id, claimed_by = NULL,
           claim_token = NULL, heartbeat_at = NULL, lost_count = 0, nodes_completed = 0, result_json = NULL,
           effects_token = NULL, effects_started = 0
         WHERE execution_queue.status IN ('completed', 'dead') AND execution_queue.created_at < ?`
      : `ON CONFLICT(id) DO NOTHING`;
    const result = this.db.prepare(
      `INSERT INTO execution_queue (id, workflow_id, workflow_name, payload_json, status, priority, attempts, max_attempts, last_error, scheduled_at, started_at, completed_at, created_at, updated_at, pool, execution_id)
       VALUES (?, ?, ?, ?, 'pending', ?, 0, ?, NULL, ?, NULL, NULL, ?, ?, ?, ?)
       ${onConflict}`
    ).run(
      ...[
        input.id,
        input.workflowId,
        input.workflowName ?? null,
        JSON.stringify(input.payload),
        input.priority ?? 0,
        input.maxAttempts ?? 3,
        input.scheduledAt ?? now,
        now,
        now,
        input.pool ?? DEFAULT_QUEUE_POOL,
        payloadExecutionId(input.payload, input.id),
        ...(input.replaceFinishedBefore ? [input.replaceFinishedBefore] : [])
      ]
    );
    this.persist();
    return result.changes > 0;
  }

  async dequeueNext(limit = 1): Promise<Array<{
    id: string;
    workflowId: string;
    workflowName: string | null;
    payload: Record<string, unknown>;
    attempts: number;
    maxAttempts: number;
    scheduledAt: string;
  }>> {
    const now = new Date().toISOString();
    const rows = this.queryAll<ExecutionQueueRow>(
      `SELECT id, workflow_id, workflow_name, payload_json, attempts, max_attempts, scheduled_at
       FROM execution_queue
       WHERE status = 'pending' AND scheduled_at <= ?
       ORDER BY priority DESC, scheduled_at ASC
       LIMIT ?`,
      [now, clampLimit(limit, { fallback: 1, max: LIMIT_MAX.dequeueNext })]
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

  async markQueueItemRunning(id: string): Promise<void> {
    const now = new Date().toISOString();
    this.exec(
      `UPDATE execution_queue SET status = 'running', started_at = ?, updated_at = ? WHERE id = ?`,
      [now, now, id]
    );
    this.persist();
  }

  async markQueueItemCompleted(id: string, options: { claimToken?: string } = {}): Promise<boolean> {
    const now = new Date().toISOString();
    const result =
      options.claimToken !== undefined
        ? this.db
            .prepare(
              `UPDATE execution_queue SET status = 'completed', completed_at = ?, updated_at = ?, heartbeat_at = NULL
               WHERE id = ? AND claim_token = ? AND status = 'running'`
            )
            .run(now, now, id, options.claimToken)
        : this.db.prepare(`UPDATE execution_queue SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?`).run(now, now, id);
    this.persist();
    return result.changes > 0;
  }

  async saveQueueItemResult(input: { id: string; claimToken: string | null; result: unknown }): Promise<boolean> {
    const json = JSON.stringify(input.result ?? null);
    const now = new Date().toISOString();
    const result =
      input.claimToken !== null
        ? this.db
            .prepare(`UPDATE execution_queue SET result_json = ?, updated_at = ? WHERE id = ? AND claim_token = ? AND status = 'running'`)
            .run(json, now, input.id, input.claimToken)
        : this.db.prepare(`UPDATE execution_queue SET result_json = ?, updated_at = ? WHERE id = ?`).run(json, now, input.id);
    this.persist();
    return result.changes > 0;
  }

  /** See the Postgres store: a completed item, or a running one whose holder already stored its result. */
  async releaseQueueItemResult(id: string): Promise<void> {
    const result = this.db
      .prepare(
        `UPDATE execution_queue SET result_json = NULL, payload_json = json_object('executionId', execution_id)
          WHERE id = ?
            AND ((status = 'completed' AND (result_json IS NOT NULL OR payload_json LIKE '%"dispatch"%'))
              OR (status = 'running' AND result_json IS NOT NULL))`
      )
      .run(id);
    if (result.changes > 0) this.persist();
  }

  async getQueueItemOutcome(id: string): Promise<QueueItemOutcome | null> {
    const row = this.queryOne<{ status: unknown; result_json: unknown; last_error: unknown; attempts: unknown }>(
      `SELECT status, result_json, last_error, attempts FROM execution_queue WHERE id = ?`,
      [id]
    );
    if (!row) return null;
    let result: unknown = null;
    if (row.result_json !== null && row.result_json !== undefined) {
      try {
        result = JSON.parse(toString(row.result_json));
      } catch {
        result = null;
      }
    }
    return {
      status: toString(row.status),
      result,
      lastError: row.last_error === null || row.last_error === undefined ? null : toString(row.last_error),
      attempts: Number(row.attempts ?? 0)
    };
  }

  /** Retries with backoff until max attempts; `retryable: false` moves the job to the DLQ now. */
  async markQueueItemFailed(id: string, error: string, options: { retryable?: boolean; claimToken?: string } = {}): Promise<boolean> {
    const now = new Date().toISOString();
    const row = this.queryOne<ExecutionQueueRow & { status: unknown; claim_token: unknown }>(
      `SELECT id, workflow_id, workflow_name, payload_json, attempts, max_attempts, status, claim_token FROM execution_queue WHERE id = ?`,
      [id]
    );
    if (!row) {
      return false;
    }
    if (options.claimToken !== undefined && (toString(row.status) !== "running" || row.claim_token !== options.claimToken)) {
      return false;
    }

    const attempts = toNumber(row.attempts) + 1;
    const maxAttempts = toNumber(row.max_attempts);

    if (attempts >= maxAttempts || options.retryable === false) {
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
      this.exec(`UPDATE execution_queue SET status = 'dead', attempts = ?, last_error = ?, updated_at = ?, heartbeat_at = NULL WHERE id = ?`, [
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
        options.claimToken !== undefined
          ? `UPDATE execution_queue SET status = 'pending', attempts = ?, last_error = ?, scheduled_at = ?, updated_at = ?,
               claimed_by = NULL, claim_token = NULL, heartbeat_at = NULL, started_at = NULL WHERE id = ?`
          : `UPDATE execution_queue SET status = 'pending', attempts = ?, last_error = ?, scheduled_at = ?, updated_at = ? WHERE id = ?`,
        [attempts, error, retryAt, now, id]
      );
    }
    this.persist();
    return true;
  }

  async requeueStuckItems(stuckAfterMs = 600_000, excludeIds: string[] = [], marginMs = STUCK_JOB_MARGIN_MS): Promise<number> {
    const nowMs = Date.now();
    const stuckBefore = new Date(nowMs - stuckAfterMs).toISOString();
    const now = new Date(nowMs).toISOString();
    const skip = new Set(excludeIds);
    const stuck = this.queryAll<ExecutionQueueRow & { started_at: unknown; payload_json: unknown }>(
      `SELECT id, started_at, payload_json FROM execution_queue
       WHERE status = 'running' AND started_at <= ? AND heartbeat_at IS NULL`,
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
        `UPDATE execution_queue SET status = 'pending', started_at = NULL, updated_at = ?, claimed_by = NULL, claim_token = NULL, heartbeat_at = NULL
         WHERE id = ?`,
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
  async reconcileOrphanedExecutions(input: { error: string; startedBefore?: string }): Promise<Array<{ id: string; workflowId: string }>> {
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

  async getQueueDepth(): Promise<{ pending: number; running: number; dlq: number }> {
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

  async listDlqItems(limit = 50, workflowIds?: string[]): Promise<Array<{
    id: string;
    originalId: string;
    workflowId: string;
    workflowName: string | null;
    attempts: number;
    finalError: string;
    failedAt: string;
  }>> {
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

  // Phase 13.1 — leased claims. Used by consumers in cluster mode (Postgres); implemented here too so both stores keep
  // one contract. One process owns a SQLite file, so its clock is the only one and each method runs as one transaction.

  async claimQueueItems(input: { limit: number; owner: string; pools: string[] }): Promise<QueueClaimedItem[]> {
    const limit = clampLimit(input.limit, { fallback: 1, max: LIMIT_MAX.dequeueNext });
    if (input.pools.length === 0) return [];
    return this.db.transaction((): QueueClaimedItem[] => {
      const nowMs = Date.now();
      const now = new Date(nowMs).toISOString();
      const window = this.queryAll<ExecutionQueueRow & { priority: unknown; created_at: unknown; pool: unknown }>(
        `SELECT id, workflow_id, workflow_name, payload_json, attempts, max_attempts, scheduled_at, priority, created_at, pool
         FROM execution_queue
         WHERE status = 'pending' AND pool IN (${input.pools.map(() => "?").join(", ")}) AND scheduled_at <= ?
         ORDER BY priority DESC, scheduled_at, created_at, id
         LIMIT ?`,
        [...input.pools, now, fairClaimWindow(limit)]
      );
      // One per workflow before a second of any; priority then due time decide within a rank.
      const seen = new Map<string, number>();
      const ranked = window.map((row, index) => {
        const workflowId = toString(row.workflow_id);
        const rank = (seen.get(workflowId) ?? 0) + 1;
        seen.set(workflowId, rank);
        return { row, rank, index };
      });
      ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
      const picked = ranked.slice(0, limit);
      const claim = this.db.prepare(
        `UPDATE execution_queue SET status = 'running', started_at = ?, heartbeat_at = ?, claimed_by = ?, claim_token = ?, updated_at = ?,
                effects_token = ?, effects_started = 0
         WHERE id = ? AND status = 'pending'`
      );
      return picked.map(({ row }) => {
        const claimToken = randomUUID();
        // The claim tracks side effects (the worker-loss policy): none started yet.
        claim.run(now, now, input.owner, claimToken, now, claimToken, toString(row.id));
        let payload: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(toString(row.payload_json));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
        } catch {
          // a malformed payload runs with none
        }
        return {
          id: toString(row.id),
          workflowId: toString(row.workflow_id),
          workflowName: row.workflow_name ? toString(row.workflow_name) : null,
          payload,
          attempts: toNumber(row.attempts),
          maxAttempts: toNumber(row.max_attempts),
          scheduledAt: toString(row.scheduled_at),
          pool: toString(row.pool),
          claimToken,
          waitMs: Math.max(0, nowMs - (Date.parse(toString(row.scheduled_at)) || nowMs))
        };
      });
    })();
  }

  async renewQueueLeases(input: { owner: string; claimTokens: string[] }): Promise<string[]> {
    if (input.claimTokens.length === 0) return [];
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      const held = this.queryAll<{ claim_token: unknown }>(
        `SELECT claim_token FROM execution_queue
         WHERE status = 'running' AND claimed_by = ? AND claim_token IN (${input.claimTokens.map(() => "?").join(", ")})`,
        [input.owner, ...input.claimTokens]
      ).map((row) => toString(row.claim_token));
      const renew = this.db.prepare(`UPDATE execution_queue SET heartbeat_at = ? WHERE claim_token = ? AND status = 'running'`);
      for (const token of held) renew.run(now, token);
      return held;
    })();
  }

  private queueClaimHeldSync(fence: QueueClaimFence): boolean {
    return Boolean(
      this.queryOne<{ id: unknown }>(`SELECT id FROM execution_queue WHERE id = ? AND claim_token = ? AND status = 'running'`, [
        fence.queueItemId,
        fence.claimToken
      ])
    );
  }

  async isQueueClaimHeld(fence: QueueClaimFence): Promise<boolean> {
    return this.queueClaimHeldSync(fence);
  }

  async recordQueueJobProgress(fence: QueueClaimFence): Promise<boolean> {
    const result = this.db
      .prepare(`UPDATE execution_queue SET nodes_completed = nodes_completed + 1 WHERE id = ? AND claim_token = ? AND status = 'running'`)
      .run(fence.queueItemId, fence.claimToken);
    if (result.changes > 0) this.persist();
    return result.changes > 0;
  }

  async markQueueEffectsStarted(fence: QueueClaimFence): Promise<boolean> {
    const held = this.queueClaimHeldSync(fence);
    if (!held) return false;
    const result = this.db
      .prepare(`UPDATE execution_queue SET effects_started = 1 WHERE id = ? AND claim_token = ? AND status = 'running' AND effects_started = 0`)
      .run(fence.queueItemId, fence.claimToken);
    if (result.changes > 0) this.persist();
    return true;
  }

  async listCanceledExecutionIds(executionIds: readonly string[]): Promise<string[]> {
    if (executionIds.length === 0) return [];
    return this.queryAll<{ id: unknown }>(
      `SELECT id FROM execution_history WHERE status = 'canceled' AND id IN (${executionIds.map(() => "?").join(", ")})`,
      [...executionIds]
    ).map((row) => toString(row.id));
  }

  /** Settles one running item by the worker-loss policy (queue-leases.ts); the caller runs it in a transaction. */
  private settleLostQueueItem(
    row: ExecutionQueueRow & { nodes_completed?: unknown; claim_token?: unknown; effects_token?: unknown; effects_started?: unknown },
    countsAttempt: boolean,
    reasons: LostJobReasons
  ): LostJobOutcome {
    const id = toString(row.id);
    const now = new Date().toISOString();
    const executionId = payloadExecutionId(row.payload_json, id);
    const attempts = toNumber(row.attempts) + (countsAttempt ? 1 : 0);
    const lost = countsAttempt ? 1 : 0;
    const history = this.queryOne<{ status: unknown; completed_at: unknown; node_results_json: unknown; started_at: unknown }>(
      `SELECT status, completed_at, node_results_json, started_at FROM execution_history WHERE id = ?`,
      [executionId]
    );
    const resume = payloadIsResume(row.payload_json);
    const pausedState = resume ? this.queryOne<{ status: unknown }>(`SELECT status FROM workflow_executions WHERE id = ?`, [executionId]) : null;
    const decision = decideLostJob({
      attempts,
      maxAttempts: toNumber(row.max_attempts),
      countsAttempt,
      resume,
      resumeStateStatus: pausedState ? toString(pausedState.status) : null,
      resumeNodesCompleted: toNumber(row.nodes_completed ?? 0),
      history: history ? { status: toString(history.status), completedAt: history.completed_at, nodeResultsJson: history.node_results_json } : null,
      effects: lostJobEffects(row)
    });
    if (decision === "finished") {
      this.exec(
        `UPDATE execution_queue SET status = 'completed', completed_at = ?, updated_at = ?, heartbeat_at = NULL, attempts = ?, lost_count = lost_count + ?
         WHERE id = ?`,
        [now, now, attempts, lost, id]
      );
    } else if (decision === "requeue") {
      this.exec(
        `UPDATE execution_queue SET status = 'pending', claimed_by = NULL, claim_token = NULL, started_at = NULL, heartbeat_at = NULL,
           attempts = ?, lost_count = lost_count + ?, scheduled_at = ?, updated_at = ?
         WHERE id = ?`,
        [attempts, lost, now, now, id]
      );
    } else {
      const reason = decision === "interrupt" ? reasons.interrupted : reasons.exhausted;
      // Only a record still running (or, for a resume, still reading as the pause) is changed.
      const open = resume ? ["running", "waiting_approval"] : ["running"];
      if (history && open.includes(toString(history.status))) {
        this.exec(`UPDATE execution_history SET status = 'error', error = ?, completed_at = ?, duration_ms = ? WHERE id = ?`, [
          reason,
          now,
          toDurationMsForStore(toString(history.started_at), now),
          executionId
        ]);
      }
      // The record is final now, so approval recovery never drives the run on again. An interrupted resume also loses
      // its paused state, for a lost worker and a shutdown release alike.
      if (resume) this.exec(`DELETE FROM workflow_executions WHERE id = ? AND status = 'resuming'`, [executionId]);
      this.exec(
        `INSERT INTO execution_queue_dlq (id, original_id, workflow_id, workflow_name, payload_json, attempts, final_error, failed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [randomUUID(), id, toString(row.workflow_id), row.workflow_name ? toString(row.workflow_name) : null, toString(row.payload_json), attempts, reason, now, now]
      );
      this.exec(
        `UPDATE execution_queue SET status = 'dead', last_error = ?, attempts = ?, lost_count = lost_count + ?, heartbeat_at = NULL, updated_at = ?
         WHERE id = ?`,
        [reason, attempts, lost, now, id]
      );
    }
    return { id, workflowId: toString(row.workflow_id), executionId, decision, attempts };
  }

  async reapExpiredQueueLeases(input: { leaseMs: number; limit?: number }): Promise<LostJobOutcome[]> {
    const expiredBefore = new Date(Date.now() - input.leaseMs).toISOString();
    return this.db.transaction(() =>
      this.queryAll<ExecutionQueueRow>(
        `SELECT id, workflow_id, workflow_name, payload_json, attempts, max_attempts, nodes_completed, claim_token, effects_token, effects_started FROM execution_queue
         WHERE status = 'running' AND heartbeat_at IS NOT NULL AND heartbeat_at < ?
         ORDER BY heartbeat_at, id
         LIMIT ?`,
        [expiredBefore, Math.max(1, Math.min(1_000, input.limit ?? 100))]
      ).map((row) => this.settleLostQueueItem(row, true, WORKER_LOST_REASONS))
    )();
  }

  async releaseQueueItem(input: { id: string; claimToken: string | null }): Promise<LostJobOutcome | null> {
    return this.db.transaction(() => {
      const row = this.queryOne<ExecutionQueueRow>(
        `SELECT id, workflow_id, workflow_name, payload_json, attempts, max_attempts, nodes_completed, claim_token, effects_token, effects_started FROM execution_queue
         WHERE id = ? AND status = 'running' AND (? IS NULL OR claim_token = ?)`,
        [input.id, input.claimToken, input.claimToken]
      );
      if (!row) return null;
      return this.settleLostQueueItem(row, false, WORKER_SHUTDOWN_REASONS);
    })();
  }

  async getQueueDepthByPool(): Promise<Array<{ pool: string; pending: number; running: number }>> {
    const rows = this.queryAll<{ pool: unknown; status: unknown; count: unknown }>(
      `SELECT pool, status, COUNT(*) AS count FROM execution_queue WHERE status IN ('pending', 'running') GROUP BY pool, status`
    );
    const byPool = new Map<string, { pool: string; pending: number; running: number }>();
    for (const row of rows) {
      const pool = toString(row.pool);
      const entry = byPool.get(pool) ?? { pool, pending: 0, running: 0 };
      if (toString(row.status) === "pending") entry.pending = toNumber(row.count);
      else entry.running = toNumber(row.count);
      byPool.set(pool, entry);
    }
    return [...byPool.values()].sort((a, b) => (a.pool < b.pool ? -1 : a.pool > b.pool ? 1 : 0));
  }

  async countPendingQueueItems(pool: string): Promise<number> {
    const row = this.queryOne<{ count: unknown }>(`SELECT COUNT(*) AS count FROM execution_queue WHERE status = 'pending' AND pool = ?`, [pool]);
    return row ? toNumber(row.count) : 0;
  }

  async getTriggerState(workflowId: string, nodeId: string): Promise<Record<string, unknown> | null> {
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

  async saveTriggerState(input: {
    workflowId: string;
    nodeId: string;
    triggerType: string;
    state: Record<string, unknown>;
  }): Promise<void> {
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

  async deleteTriggerStatesForWorkflow(workflowId: string): Promise<void> {
    this.exec(`DELETE FROM trigger_state WHERE workflow_id = ?`, [workflowId]);
    this.persist();
  }

  // ---------------------------------------------------------------------------
  // Phase 4.2 — projects & folders
  // ---------------------------------------------------------------------------

  async listProjects(): Promise<Project[]> {
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

  async getProject(id: string): Promise<Project | null> {
    return this.getProjectSync(id);
  }

  private getProjectSync(id: string): Project | null {
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

  async upsertProject(input: {
    id: string;
    name: string;
    description?: string;
    createdBy?: string;
  }): Promise<Project> {
    return this.upsertProjectSync(input);
  }

  private upsertProjectSync(input: {
    id: string;
    name: string;
    description?: string;
    createdBy?: string;
  }): Project {
    const now = new Date().toISOString();
    const existing = this.getProjectSync(input.id);
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

  async deleteProject(id: string): Promise<boolean> {
    if (id === DEFAULT_PROJECT_ID) {
      throw new Error("Cannot delete the default project.");
    }
    const existing = this.getProjectSync(id);
    if (!existing) return false;
    // Never move a project's workflows or secrets into the default project:
    // that would hand them to everyone who can use the default project.
    const count = (table: string) => toNumber(this.queryOne<{ count: number }>(`SELECT COUNT(*) as count FROM ${table} WHERE project_id = ?`, [id])?.count ?? 0);
    const counts = { workflows: count("workflows"), secrets: count("secrets"),
      knowledgeBases: count("knowledge_bases"),
      mcpServers: count("mcp_servers"),
      evalDatasets: count("eval_datasets")
    };
    if (Object.values(counts).some((value) => value > 0)) throw new ProjectNotEmptyError(counts);
    this.exec(`DELETE FROM folders WHERE project_id = ?`, [id]);
    // Variables are project configuration; they must not revive with a re-created id.
    this.exec(`DELETE FROM variables WHERE project_id = ?`, [id]);
    this.exec(`DELETE FROM guard_bindings WHERE scope = 'project' AND scope_id = ?`, [id]);
    // Memberships, roles and shares of a deleted project must not come back
    // to life if a project with the same id is created later.
    this.exec(`DELETE FROM user_project_roles WHERE project_id = ?`, [id]);
    this.exec(`DELETE FROM custom_roles WHERE project_id = ?`, [id]);
    this.exec(`DELETE FROM workflow_shares WHERE project_id = ?`, [id]);
    this.exec(`DELETE FROM secret_shares WHERE project_id = ?`, [id]);
    this.exec(`DELETE FROM projects WHERE id = ?`, [id]);
    this.persist();
    return true;
  }

  async listFolders(projectId?: string): Promise<Folder[]> {
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

  async getFolder(id: string): Promise<Folder | null> {
    return this.getFolderSync(id);
  }

  private getFolderSync(id: string): Folder | null {
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

  async upsertFolder(input: {
    id: string;
    name: string;
    parentId?: string;
    projectId: string;
  }): Promise<Folder> {
    const now = new Date().toISOString();
    const existing = this.getFolderSync(input.id);
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

  async deleteFolder(id: string): Promise<boolean> {
    const existing = this.getFolderSync(id);
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

  async saveApiKey(input: {
    id: string;
    userId: string;
    name: string;
    keyPrefix: string;
    keyHash: string;
    scopes?: string[];
    expiresAt?: string | null;
  }): Promise<void> {
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

  async listApiKeys(userId?: string): Promise<Array<{
    id: string;
    userId: string;
    name: string;
    keyPrefix: string;
    scopes: string[];
    lastUsedAt: string | null;
    expiresAt: string | null;
    revokedAt: string | null;
    createdAt: string;
  }>> {
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

  async findApiKeyByPrefix(prefix: string): Promise<{
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
  } | null> {
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

  async touchApiKey(id: string): Promise<void> {
    this.exec(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
    this.persist();
  }

  async revokeApiKey(id: string, userId?: string): Promise<boolean> {
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

  async getMfaSecret(userId: string): Promise<{
    userId: string;
    secretIv: string;
    secretAuthTag: string;
    secretCiphertext: string;
    backupCodes: string[];
    enabled: boolean;
    activatedAt: string | null;
    createdAt: string;
    updatedAt: string;
  } | null> {
    return this.getMfaSecretSync(userId);
  }

  private getMfaSecretSync(userId: string): {
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

  async upsertMfaSecret(input: {
    userId: string;
    secretIv: string;
    secretAuthTag: string;
    secretCiphertext: string;
    backupCodes: string[];
    enabled: boolean;
    activatedAt: string | null;
  }): Promise<void> {
    const now = new Date().toISOString();
    const existing = this.getMfaSecretSync(input.userId);
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

  async replaceMfaBackupCodes(input: { userId: string; expected: readonly string[]; next: readonly string[] }): Promise<boolean> {
    const result = this.db
      .prepare(`UPDATE mfa_secrets SET backup_codes_json = ?, updated_at = ? WHERE user_id = ? AND backup_codes_json = ?`)
      .run(JSON.stringify(input.next), new Date().toISOString(), input.userId, JSON.stringify(input.expected));
    this.persist();
    return result.changes > 0;
  }

  async deleteMfaSecret(userId: string): Promise<boolean> {
    const existing = this.getMfaSecretSync(userId);
    if (!existing) return false;
    this.exec(`DELETE FROM mfa_secrets WHERE user_id = ?`, [userId]);
    this.persist();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Phase 5.1 — SSO identities
  // ---------------------------------------------------------------------------

  async findSsoIdentity(provider: string, subject: string): Promise<{
    id: string;
    userId: string;
    provider: string;
    subject: string;
    email: string | null;
    attributes: unknown;
    createdAt: string;
    updatedAt: string;
  } | null> {
    return this.findSsoIdentitySync(provider, subject);
  }

  private findSsoIdentitySync(provider: string, subject: string): {
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

  async upsertSsoIdentity(input: {
    id: string;
    userId: string;
    provider: string;
    subject: string;
    email?: string | null;
    attributes?: unknown;
  }): Promise<void> {
    const now = new Date().toISOString();
    const existing = this.findSsoIdentitySync(input.provider, input.subject);
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

  async renameSsoIdentitySubject(input: { provider: string; from: string; to: string }): Promise<boolean> {
    const result = this.db
      .prepare(
        `UPDATE sso_identities SET subject = ?, updated_at = ?
         WHERE provider = ? AND subject = ?
           AND NOT EXISTS (SELECT 1 FROM sso_identities WHERE provider = ? AND subject = ?)`
      )
      .run(input.to, new Date().toISOString(), input.provider, input.from, input.provider, input.to);
    this.persist();
    return result.changes > 0;
  }

  // ---------------------------------------------------------------------------
  // Phase 5.2 — Project-level roles
  // ---------------------------------------------------------------------------

  async countProjectMemberships(): Promise<number> {
    const row = this.queryOne<{ count: number }>(`SELECT COUNT(*) as count FROM user_project_roles`);
    return row ? toNumber(row.count) : 0;
  }

  async listProjectMembers(projectId: string): Promise<Array<{
    userId: string;
    projectId: string;
    role: string;
    customRoleId: string | null;
    createdAt: string;
    updatedAt: string;
  }>> {
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

  async listUserProjectRoles(userId: string): Promise<Array<{
    userId: string;
    projectId: string;
    role: string;
    customRoleId: string | null;
  }>> {
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

  async getProjectRole(userId: string, projectId: string): Promise<{
    userId: string;
    projectId: string;
    role: string;
    customRoleId: string | null;
  } | null> {
    return this.getProjectRoleSync(userId, projectId);
  }

  private getProjectRoleSync(userId: string, projectId: string): {
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

  async upsertProjectRole(input: {
    userId: string;
    projectId: string;
    role: string;
    customRoleId?: string | null;
  }): Promise<void> {
    const now = new Date().toISOString();
    const existing = this.getProjectRoleSync(input.userId, input.projectId);
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

  async removeProjectRole(userId: string, projectId: string): Promise<boolean> {
    const existing = this.getProjectRoleSync(userId, projectId);
    if (!existing) return false;
    this.exec(`DELETE FROM user_project_roles WHERE user_id = ? AND project_id = ?`, [userId, projectId]);
    this.persist();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Phase 5.2 — Custom roles
  // ---------------------------------------------------------------------------

  async listCustomRoles(projectId?: string | null): Promise<Array<{
    id: string;
    projectId: string | null;
    name: string;
    description: string | null;
    permissions: string[];
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
  }>> {
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

  async getCustomRole(id: string): Promise<{
    id: string;
    projectId: string | null;
    name: string;
    description: string | null;
    permissions: string[];
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
  } | null> {
    return this.getCustomRoleSync(id);
  }

  private getCustomRoleSync(id: string): {
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

  async upsertCustomRole(input: {
    id: string;
    projectId?: string | null;
    name: string;
    description?: string | null;
    permissions: string[];
    createdBy?: string | null;
  }): Promise<void> {
    const now = new Date().toISOString();
    const existing = this.getCustomRoleSync(input.id);
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

  async deleteCustomRole(id: string): Promise<boolean> {
    const existing = this.getCustomRoleSync(id);
    if (!existing) return false;
    this.exec(`DELETE FROM custom_roles WHERE id = ?`, [id]);
    this.exec(`UPDATE user_project_roles SET custom_role_id = NULL WHERE custom_role_id = ?`, [id]);
    this.persist();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Phase 5.2 — Workflow shares
  // ---------------------------------------------------------------------------

  async listWorkflowShares(workflowId: string): Promise<Array<{
    workflowId: string;
    projectId: string;
    accessLevel: string;
    sharedBy: string | null;
    createdAt: string;
  }>> {
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

  async listWorkflowsSharedToProject(projectId: string): Promise<Array<{
    workflowId: string;
    projectId: string;
    accessLevel: string;
  }>> {
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

  async upsertWorkflowShare(input: {
    workflowId: string;
    projectId: string;
    accessLevel: "read" | "execute";
    sharedBy?: string | null;
  }): Promise<void> {
    this.exec(
      `INSERT INTO workflow_shares (workflow_id, project_id, access_level, shared_by, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(workflow_id, project_id) DO UPDATE SET
         access_level = excluded.access_level`,
      [input.workflowId, input.projectId, input.accessLevel, input.sharedBy ?? null, new Date().toISOString()]
    );
    this.persist();
  }

  async removeWorkflowShare(workflowId: string, projectId: string): Promise<boolean> {
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

  async listSecretShares(secretId: string): Promise<Array<{
    secretId: string;
    projectId: string;
    sharedBy: string | null;
    createdAt: string;
  }>> {
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

  async listSecretsSharedToProject(projectId: string): Promise<string[]> {
    const rows = this.queryAll<{ secret_id: string }>(
      `SELECT secret_id FROM secret_shares WHERE project_id = ?`,
      [projectId]
    );
    return rows.map((row) => toString(row.secret_id));
  }

  async upsertSecretShare(input: { secretId: string; projectId: string; sharedBy?: string | null }): Promise<void> {
    this.exec(
      `INSERT INTO secret_shares (secret_id, project_id, shared_by, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(secret_id, project_id) DO NOTHING`,
      [input.secretId, input.projectId, input.sharedBy ?? null, new Date().toISOString()]
    );
    this.persist();
  }

  async removeSecretShare(secretId: string, projectId: string): Promise<boolean> {
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

  async listSsoGroupMappings(provider?: string): Promise<Array<{
    id: string;
    provider: string;
    groupName: string;
    projectId: string | null;
    role: string;
    customRoleId: string | null;
    createdAt: string;
    updatedAt: string;
  }>> {
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

  async upsertSsoGroupMapping(input: {
    id: string;
    provider: string;
    groupName: string;
    projectId?: string | null;
    role: string;
    customRoleId?: string | null;
  }): Promise<void> {
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

  async deleteSsoGroupMapping(id: string): Promise<boolean> {
    const existing = this.queryOne<{ id: string }>(`SELECT id FROM sso_group_mappings WHERE id = ?`, [id]);
    if (!existing) return false;
    this.exec(`DELETE FROM sso_group_mappings WHERE id = ?`, [id]);
    this.persist();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Phase 5.3 — External secret providers + rotation cache
  // ---------------------------------------------------------------------------

  async listExternalSecretProviders(): Promise<Array<{
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
  }>> {
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

  async getExternalSecretProvider(id: string): Promise<{
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
  } | null> {
    return this.getExternalSecretProviderSync(id);
  }

  private getExternalSecretProviderSync(id: string): {
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

  async upsertExternalSecretProvider(input: {
    id: string;
    name: string;
    type: string;
    config: Record<string, unknown>;
    credentialsSecretId?: string | null;
    cacheTtlMs?: number;
    enabled?: boolean;
    createdBy?: string | null;
  }): Promise<void> {
    const now = new Date().toISOString();
    const existing = this.getExternalSecretProviderSync(input.id);
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

  async deleteExternalSecretProvider(id: string): Promise<boolean> {
    const existing = this.getExternalSecretProviderSync(id);
    if (!existing) return false;
    this.exec(`DELETE FROM external_secret_providers WHERE id = ?`, [id]);
    this.persist();
    return true;
  }

  async countSecretsUsingExternalProvider(providerId: string): Promise<number> {
    const row = this.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM secrets WHERE external_provider_id = ?`,
      [providerId]
    );
    return row ? toNumber(row.count) : 0;
  }

  async getExternalSecretCacheEntry(secretId: string): Promise<{
    secretId: string;
    iv: string;
    authTag: string;
    ciphertext: string;
    fetchedAt: string;
    expiresAt: string;
  } | null> {
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

  async upsertExternalSecretCacheEntry(input: {
    secretId: string;
    iv: string;
    authTag: string;
    ciphertext: string;
    expiresAt: string;
  }): Promise<void> {
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

  async deleteExternalSecretCacheEntry(secretId: string): Promise<void> {
    this.exec(`DELETE FROM external_secret_cache WHERE secret_id = ?`, [secretId]);
    this.persist();
  }

  // ---------------------------------------------------------------------------
  // Phase 5.4 — Audit log
  // ---------------------------------------------------------------------------

  async writeAuditLog(input: {
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
  }): Promise<void> {
    // Text as the database stores it (lone surrogates and U+0000 → U+FFFD), so the hash covers exactly what is stored.
    const entry = wellFormedAuditEntry(input);
    const createdAt = entry.createdAt ?? new Date().toISOString();
    const metadataJson = wellFormedAuditText(entry.metadata === undefined ? null : JSON.stringify(entry.metadata));
    // Phase 8.4 — hash chain. prev_hash = the last row's entry_hash; for the
    // very first row it's 64 zeros. entry_hash = SHA-256(prev_hash || canonical
    // JSON of this row). Tampering with any historical row breaks every link
    // after it, which `verifyAuditChain()` surfaces.
    const prevHash = this.getLastAuditEntryHash() ?? GENESIS_HASH;
    const entryHash = auditEntryHash(prevHash, {
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
      metadataJson,
      message: entry.message ?? null
    });
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
        metadataJson,
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
  async verifyAuditChain(): Promise<AuditChainResult> {
    // Text is read exactly as stored (audit-chain.ts verifySqliteAuditChain: the driver's text, and the stored bytes
    // decoded by storedSqliteAuditText for any row whose text reads with a U+FFFD), the same on every Node version:
    // better-sqlite3 on Node 20 stored a lone surrogate as generalized UTF-8, which the driver reads as three U+FFFD.
    // An optional field keeps NULL as null and "" as "" (the writer hashes `value ?? null`; reading by truthiness would
    // turn "" into null and break the chain at that row).
    return verifySqliteAuditChain(this.db);
  }

  async listAuditLogs(filter: {
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
  } = {}): Promise<{
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
  }> {
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

  async pruneAuditLogs(options: { before: string }): Promise<number> {
    // Phase 11.1 — cached run manifests older than the audit-log retention whose execution history is gone.
    this.pruneExecutionManifestsSync(options);
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

  async listLogStreamDestinations(): Promise<LogStreamDestinationRecord[]> {
    const rows = this.queryAll<LogStreamDestinationRow>(
      `SELECT id, name, type, enabled, categories_json, min_level, config_iv, config_auth_tag,
              config_ciphertext, last_success_at, last_error_at, last_error, dispatched_count,
              failed_count, created_by, created_at, updated_at
       FROM log_stream_destinations ORDER BY created_at DESC`
    );
    return rows.map(mapLogStreamDestinationRow);
  }

  async getLogStreamDestination(id: string): Promise<LogStreamDestinationRecord | null> {
    return this.getLogStreamDestinationSync(id);
  }

  private getLogStreamDestinationSync(id: string): LogStreamDestinationRecord | null {
    const row = this.queryOne<LogStreamDestinationRow>(
      `SELECT id, name, type, enabled, categories_json, min_level, config_iv, config_auth_tag,
              config_ciphertext, last_success_at, last_error_at, last_error, dispatched_count,
              failed_count, created_by, created_at, updated_at
       FROM log_stream_destinations WHERE id = ?`,
      [id]
    );
    return row ? mapLogStreamDestinationRow(row) : null;
  }

  async upsertLogStreamDestination(input: {
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
  }): Promise<void> {
    const now = new Date().toISOString();
    const existing = this.getLogStreamDestinationSync(input.id);
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

  async deleteLogStreamDestination(id: string): Promise<boolean> {
    const existing = this.getLogStreamDestinationSync(id);
    if (!existing) return false;
    this.exec(`DELETE FROM log_stream_destinations WHERE id = ?`, [id]);
    this.exec(`DELETE FROM log_stream_events WHERE destination_id = ?`, [id]);
    this.persist();
    return true;
  }

  async recordLogStreamDispatch(input: {
    destinationId: string;
    success: boolean;
    error?: string | null;
    at?: string;
  }): Promise<void> {
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

  async writeLogStreamEvent(entry: {
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
  }): Promise<void> {
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

  async listLogStreamEvents(filter: {
    destinationId?: string;
    status?: string;
    limit?: number;
  } = {}): Promise<Array<{
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
  }>> {
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

  async pruneLogStreamEvents(options: { before: string }): Promise<number> {
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

  async listVariables(projectId?: string): Promise<Array<{
    id: string;
    projectId: string;
    key: string;
    value: string;
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
  }>> {
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

  async getVariable(id: string): Promise<{
    id: string;
    projectId: string;
    key: string;
    value: string;
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
  } | null> {
    return this.getVariableSync(id);
  }

  private getVariableSync(id: string): {
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

  async upsertVariable(input: {
    id: string;
    projectId: string;
    key: string;
    value: string;
    createdBy?: string | null;
  }): Promise<void> {
    const now = new Date().toISOString();
    const existing = this.getVariableSync(input.id);
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

  async deleteVariable(id: string): Promise<boolean> {
    const existing = this.getVariableSync(id);
    if (!existing) return false;
    this.exec(`DELETE FROM variables WHERE id = ?`, [id]);
    this.persist();
    return true;
  }

  async findVariableByKey(projectId: string, key: string): Promise<{ id: string; key: string; value: string } | null> {
    const row = this.queryOne<{ id: string; key: string; value: string }>(
      `SELECT id, key, value FROM variables WHERE project_id = ? AND key = ?`,
      [projectId, key]
    );
    if (!row) return null;
    return { id: toString(row.id), key: toString(row.key), value: toString(row.value) };
  }

  // Workflow version history

  async listWorkflowVersions(workflowId: string, limit = 100): Promise<Array<{
    id: string;
    workflowId: string;
    version: number;
    createdBy: string | null;
    changeNote: string | null;
    createdAt: string;
  }>> {
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

  async getWorkflowVersion(workflowId: string, version: number): Promise<{
    id: string;
    workflowId: string;
    version: number;
    workflowJson: string;
    createdBy: string | null;
    changeNote: string | null;
    createdAt: string;
  } | null> {
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

  async writeWorkflowVersion(entry: {
    id: string;
    workflowId: string;
    version: number;
    workflowJson: string;
    createdBy?: string | null;
    changeNote?: string | null;
  }): Promise<void> {
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

  /**
   * Keeps the newest `keep` versions. Phase 15.4: pinned versions (published
   * now or released before) are never pruned and do not count against `keep`.
   */
  async pruneWorkflowVersions(workflowId: string, keep: number): Promise<number> {
    const pruned = this.pruneWorkflowVersionsSync(workflowId, keep);
    if (pruned > 0) this.persist();
    return pruned;
  }

  private pruneWorkflowVersionsSync(workflowId: string, keep: number): number {
    if (keep <= 0) return 0;
    const toDelete = this.queryAll<{ id: string }>(
      `SELECT id FROM workflow_versions WHERE workflow_id = ? AND pinned = 0 ORDER BY version DESC LIMIT -1 OFFSET ?`,
      [workflowId, keep]
    );
    if (toDelete.length === 0) return 0;
    for (const row of toDelete) {
      this.exec(`DELETE FROM workflow_versions WHERE id = ?`, [toString(row.id)]);
    }
    return toDelete.length;
  }

  async appendWorkflowVersion(input: {
    id: string;
    workflowId: string;
    workflowJson: string;
    createdBy?: string | null;
    changeNote?: string | null;
    retention: number;
  }): Promise<{ id: string; version: number; createdAt: string }> {
    const createdAt = new Date().toISOString();
    const version = this.transaction(() => {
      const row = this.queryOne<{ max_version: number | null }>(
        `SELECT MAX(version) as max_version FROM workflow_versions WHERE workflow_id = ?`,
        [input.workflowId]
      );
      const next = (row && row.max_version !== null ? toNumber(row.max_version) : 0) + 1;
      this.exec(
        `INSERT INTO workflow_versions (id, workflow_id, version, workflow_json, created_by, change_note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [input.id, input.workflowId, next, input.workflowJson, input.createdBy ?? null, input.changeNote ?? null, createdAt]
      );
      if (input.retention > 0) this.pruneWorkflowVersionsSync(input.workflowId, input.retention);
      return next;
    });
    this.persist();
    return { id: input.id, version, createdAt };
  }

  async maxWorkflowVersionNumber(workflowId: string): Promise<number> {
    const row = this.queryOne<{ max_version: number | null }>(
      `SELECT MAX(version) as max_version FROM workflow_versions WHERE workflow_id = ?`,
      [workflowId]
    );
    return row && row.max_version !== null ? toNumber(row.max_version) : 0;
  }

  // Phase 15.4 — release gate and publish.

  /** The version production traffic runs, or null when nothing is published (the draft runs everywhere). */
  async getPublishedVersion(workflowId: string): Promise<number | null> {
    return this.getPublishedVersionSync(workflowId);
  }

  private getPublishedVersionSync(workflowId: string): number | null {
    const row = this.queryOne<{ published_version: number | null }>(`SELECT published_version FROM workflows WHERE id = ?`, [workflowId]);
    return row ? nullableNumber(row.published_version) : null;
  }

  async isWorkflowVersionPinned(workflowId: string, version: number): Promise<boolean> {
    const row = this.queryOne<{ pinned: number }>(`SELECT pinned FROM workflow_versions WHERE workflow_id = ? AND version = ?`, [workflowId, version]);
    return Number(row?.pinned ?? 0) === 1;
  }

  async getReleaseGate(workflowId: string): Promise<ReleaseGateRecord | null> {
    return this.getReleaseGateSync(workflowId);
  }

  private getReleaseGateSync(workflowId: string): ReleaseGateRecord | null {
    const row = this.queryOne<Record<string, unknown>>(`SELECT * FROM release_gates WHERE workflow_id = ?`, [workflowId]);
    return row ? mapReleaseGateRow(row) : null;
  }

  /**
   * The gate state a write sees (on = enabled; enforced = enabled and enforced). Called inside the write's
   * transaction; with `refuseIfGateEnforced` an enforced gate throws `ReleaseGateEnforcedError` before anything is written.
   */
  private gateStateForWriteSync(workflowId: string, refuseIfGateEnforced: boolean | undefined): { gateEnabled: boolean; gateEnforced: boolean } {
    const gate = this.getReleaseGateSync(workflowId);
    const gateEnforced = releaseGateRestrictsToAdmins(gate);
    if (refuseIfGateEnforced && gateEnforced) throw new ReleaseGateEnforcedError();
    return { gateEnabled: Boolean(gate?.enabled), gateEnforced };
  }

  async upsertReleaseGate(record: ReleaseGateRecord): Promise<ReleaseGateRecord> {
    return this.upsertReleaseGateSync(record);
  }

  private upsertReleaseGateSync(record: ReleaseGateRecord): ReleaseGateRecord {
    this.exec(
      `INSERT INTO release_gates (workflow_id, enabled, enforced, dataset_ids_json, candidate_options_json, policy_json, require_approval, approvers_json, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workflow_id) DO UPDATE SET
         enabled = excluded.enabled,
         enforced = excluded.enforced,
         dataset_ids_json = excluded.dataset_ids_json,
         candidate_options_json = excluded.candidate_options_json,
         policy_json = excluded.policy_json,
         require_approval = excluded.require_approval,
         approvers_json = excluded.approvers_json,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
      [
        record.workflowId,
        record.enabled ? 1 : 0,
        record.enforced ? 1 : 0,
        JSON.stringify(record.datasetIds),
        JSON.stringify(record.candidateOptions),
        JSON.stringify(record.policy),
        record.requireApproval ? 1 : 0,
        record.approvers ? JSON.stringify(record.approvers) : null,
        record.updatedAt,
        record.updatedBy
      ]
    );
    return this.getReleaseGateSync(record.workflowId)!;
  }

  async listWorkflowReleases(workflowId: string, limit = 100): Promise<WorkflowReleaseRecord[]> {
    return this.queryAll<Record<string, unknown>>(
      `SELECT * FROM workflow_releases WHERE workflow_id = ? ORDER BY published_at DESC, rowid DESC LIMIT ?`,
      [workflowId, Math.max(1, Math.min(500, limit))]
    ).map(mapWorkflowReleaseRow);
  }

  /** Whether `version` was published before (by any release, a rollback included). */
  async hasReleasedVersion(workflowId: string, version: number): Promise<boolean> {
    return Boolean(this.queryOne<{ id: string }>(`SELECT id FROM workflow_releases WHERE workflow_id = ? AND version = ? LIMIT 1`, [workflowId, version]));
  }

  /**
   * Moves the published version and records the release, in one transaction:
   * the version is pinned (exempt from retention). Refused (null) when the
   * published version is no longer `expectedPrevious` (another publish got
   * there first) or the version row is gone.
   */
  async publishWorkflowVersion(
    release: Omit<WorkflowReleaseRecord, "previousVersion">,
    expectedPrevious: number | null,
    options: { refuseIfGateEnforced?: boolean } = {}
  ): Promise<WorkflowReleaseRecord | null> {
    return this.publishWorkflowVersionSync(release, expectedPrevious, options);
  }

  private publishWorkflowVersionSync(
    release: Omit<WorkflowReleaseRecord, "previousVersion">,
    expectedPrevious: number | null,
    options: { refuseIfGateEnforced?: boolean } = {}
  ): WorkflowReleaseRecord | null {
    return this.transaction(() => {
      if (options.refuseIfGateEnforced) this.gateStateForWriteSync(release.workflowId, true);
      const current = this.getPublishedVersionSync(release.workflowId);
      if (current !== expectedPrevious) return null;
      const pinned = this.db.prepare(`UPDATE workflow_versions SET pinned = 1 WHERE workflow_id = ? AND version = ?`).run(release.workflowId, release.version);
      if (pinned.changes === 0) return null;
      this.db.prepare(`UPDATE workflows SET published_version = ?, unpublished_at = NULL WHERE id = ?`).run(release.version, release.workflowId);
      const publishedAt = this.historyTimeSync(release.workflowId, release.publishedAt);
      this.db
        .prepare(
          `INSERT INTO workflow_releases (id, workflow_id, version, workflow_hash, previous_version, replay_run_id, verdict, reason, gate_reasons_json, approval_json, published_at, published_by, published_by_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          release.id,
          release.workflowId,
          release.version,
          release.workflowHash,
          current,
          release.replayRunId,
          release.verdict,
          release.reason,
          JSON.stringify(release.gateReasons),
          release.approval ? JSON.stringify(release.approval) : null,
          publishedAt,
          release.publishedBy,
          release.publishedByUserId
        );
      return { ...release, publishedAt, previousVersion: current };
    });
  }

  /** Every completed replay job that tested exactly this workflow hash, newest first. */
  async listReplayRunIdsForHash(workflowId: string, workflowHash: string): Promise<string[]> {
    return this.queryAll<{ id: string }>(
      // Phase 15.6 — a guard policy simulation's jobs are never release proof, so the judge never falls back to one.
      `SELECT id FROM eval_runs WHERE kind = 'replay' AND workflow_id = ? AND workflow_hash = ? AND status = 'completed' AND dataset_id NOT LIKE ? ORDER BY started_at DESC, id DESC`,
      [workflowId, workflowHash, `${GUARD_SIMULATION_JOB_DATASET_PREFIX}%`]
    ).map((row) => toString(row.id));
  }

  /** Phase 15.4 — the per-set snapshot a replay job was queued against (set id -> hash). */
  async setEvalRunSetSnapshot(runId: string, snapshot: Record<string, GoldenSetSnapshot>): Promise<void> {
    this.exec(`UPDATE eval_runs SET set_snapshot_json = ? WHERE id = ?`, [JSON.stringify(snapshot), runId]);
    this.persist();
  }

  /** Each set's hash and, for jobs queued since gate admission, its cases' fingerprints (older jobs stored the hash alone). */
  async getEvalRunSetSnapshot(runId: string): Promise<Record<string, GoldenSetSnapshot> | null> {
    const row = this.queryOne<{ set_snapshot_json: string | null }>(`SELECT set_snapshot_json FROM eval_runs WHERE id = ?`, [runId]);
    if (!row?.set_snapshot_json) return null;
    try {
      const parsed = JSON.parse(toString(row.set_snapshot_json)) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const out: Record<string, GoldenSetSnapshot> = {};
      for (const [datasetId, entry] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof entry === "string") {
          out[datasetId] = { hash: entry, cases: null };
          continue;
        }
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const { hash, cases } = entry as { hash?: unknown; cases?: unknown };
        if (typeof hash !== "string") continue;
        const fingerprints =
          cases && typeof cases === "object" && !Array.isArray(cases)
            ? Object.fromEntries(Object.entries(cases as Record<string, unknown>).filter((pair): pair is [string, string] => typeof pair[1] === "string"))
            : null;
        out[datasetId] = { hash, cases: fingerprints };
      }
      return out;
    } catch {
      return null;
    }
  }

  /** Phase 15.4 — the channel and published version a finished run ran on (null version: the draft). */
  async setExecutionRelease(executionId: string, channel: "production" | "draft", version: number | null): Promise<void> {
    this.exec(`UPDATE execution_history SET release_channel = ?, release_version = ? WHERE id = ?`, [channel, version, executionId]);
    this.persist();
  }

  async getExecutionRelease(executionId: string): Promise<{ channel: "production" | "draft"; version: number | null } | null> {
    const row = this.queryOne<{ release_channel: string | null; release_version: number | null }>(`SELECT release_channel, release_version FROM execution_history WHERE id = ?`, [executionId]);
    if (!row || !row.release_channel) return null;
    return { channel: row.release_channel === "production" ? "production" : "draft", version: nullableNumber(row.release_version) };
  }

  /** Unpublish in one transaction (see `Store.unpublishWorkflowVersion`). */
  async unpublishWorkflowVersion(entry: Parameters<Store["unpublishWorkflowVersion"]>[0]): ReturnType<Store["unpublishWorkflowVersion"]> {
    return this.transaction(() => {
      const { gateEnabled, gateEnforced } = this.gateStateForWriteSync(entry.workflowId, entry.refuseIfGateEnforced);
      const current = this.getPublishedVersionSync(entry.workflowId);
      if (current === null) return null;
      if (entry.expectedVersion !== undefined && entry.expectedVersion !== null && entry.expectedVersion !== current) return null;
      const released = this.queryOne<{ workflow_hash: string }>(
        `SELECT workflow_hash FROM workflow_releases WHERE workflow_id = ? AND version = ? AND verdict <> 'unpublished' ORDER BY published_at DESC, rowid DESC LIMIT 1`,
        [entry.workflowId, current]
      );
      const at = this.historyTimeSync(entry.workflowId, entry.unpublishedAt);
      const changed = this.db
        .prepare(`UPDATE workflows SET published_version = NULL, unpublished_at = ? WHERE id = ? AND published_version = ?`)
        .run(at, entry.workflowId, current);
      if (changed.changes === 0) return null;
      const record: WorkflowReleaseRecord = {
        id: entry.id,
        workflowId: entry.workflowId,
        version: current,
        workflowHash: released ? toString(released.workflow_hash) : "",
        previousVersion: current,
        replayRunId: null,
        verdict: "unpublished",
        reason: entry.reason,
        gateReasons: [],
        approval: null,
        publishedAt: at,
        publishedBy: entry.unpublishedBy,
        publishedByUserId: entry.unpublishedByUserId
      };
      this.db
        .prepare(
          `INSERT INTO workflow_releases (id, workflow_id, version, workflow_hash, previous_version, replay_run_id, verdict, reason, gate_reasons_json, approval_json, published_at, published_by, published_by_user_id)
           VALUES (?, ?, ?, ?, ?, NULL, 'unpublished', ?, '[]', NULL, ?, ?, ?)`
        )
        .run(record.id, record.workflowId, record.version, record.workflowHash, record.previousVersion, record.reason, record.publishedAt, record.publishedBy, record.publishedByUserId);
      return { record, gateEnabled, gateEnforced };
    });
  }

  /** Inside a transaction: `at`, or the workflow's newest history time when that is later, so time order never disagrees with write order. */
  private historyTimeSync(workflowId: string, at: string): string {
    const newest = this.queryOne<{ newest: string | null }>(`SELECT MAX(published_at) AS newest FROM workflow_releases WHERE workflow_id = ?`, [workflowId]);
    const latest = newest?.newest ? toString(newest.newest) : null;
    return latest !== null && latest > at ? latest : at;
  }

  async getPublishState(workflowId: string): Promise<{ publishedVersion: number | null; unpublishedAt: string | null }> {
    const row = this.queryOne<{ published_version: number | null; unpublished_at: string | null }>(`SELECT published_version, unpublished_at FROM workflows WHERE id = ?`, [workflowId]);
    if (!row) return { publishedVersion: null, unpublishedAt: null };
    return { publishedVersion: nullableNumber(row.published_version), unpublishedAt: row.unpublished_at ? toString(row.unpublished_at) : null };
  }

  /** The hashes `version` had when it was released (any release, rollbacks included). */
  async listReleasedVersionHashes(workflowId: string, version: number): Promise<string[]> {
    return this.queryAll<{ workflow_hash: string }>(`SELECT DISTINCT workflow_hash FROM workflow_releases WHERE workflow_id = ? AND version = ?`, [workflowId, version]).map((row) =>
      toString(row.workflow_hash)
    );
  }

  /** The release gates that are switched on. */
  async listEnabledReleaseGateWorkflowIds(): Promise<string[]> {
    return this.queryAll<{ workflow_id: string }>(`SELECT workflow_id FROM release_gates WHERE enabled = 1`).map((row) => toString(row.workflow_id));
  }

  /**
   * Closes every pending release request whose time ran out, so the inbox's
   * pending and decided filters (and their limits) agree with the clock.
   * Returns the requests it closed.
   */
  async timeOutExpiredReleaseApprovalRequests(nowIso: string): Promise<ReleaseApprovalRequestRecord[]> {
    const expired = this.queryAll<Record<string, unknown>>(
      `SELECT * FROM release_approval_requests WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?`,
      [nowIso]
    ).map(mapReleaseApprovalRequestRow);
    if (expired.length === 0) return [];
    this.exec(
      `UPDATE release_approval_requests SET status = 'timed_out', decided_by = 'system', decided_at = ?, decision_reason = 'Nobody decided before the release request expired', updated_at = ?
       WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?`,
      [nowIso, nowIso, nowIso]
    );
    return expired;
  }

  /** Pending requests for this version and hash, newest first. */
  async listPendingReleaseApprovalRequests(workflowId: string, version: number, workflowHash: string): Promise<ReleaseApprovalRequestRecord[]> {
    return this.queryAll<Record<string, unknown>>(
      `SELECT * FROM release_approval_requests WHERE workflow_id = ? AND version = ? AND workflow_hash = ? AND status = 'pending' ORDER BY created_at DESC`,
      [workflowId, version, workflowHash]
    ).map(mapReleaseApprovalRequestRow);
  }

  async insertReleaseApprovalRequest(record: ReleaseApprovalRequestRecord): Promise<ReleaseApprovalRequestRecord> {
    this.exec(
      `INSERT INTO release_approval_requests (
         id, workflow_id, workflow_name, project_id, version, workflow_hash, replay_run_id, origin, gate_reasons_json, gate_updated_at, gate_checks_json, gate_authority,
         published_version_at_request, spec_json, status, request_reason, requested_by_user_id, requested_by, expires_at,
         decided_by_user_id, decided_by, decided_at, decision_reason, release_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.workflowId,
        record.workflowName,
        record.projectId,
        record.version,
        record.workflowHash,
        record.replayRunId,
        record.origin,
        JSON.stringify(record.gateReasons),
        record.gateUpdatedAt,
        record.gateChecks ? JSON.stringify(record.gateChecks) : null,
        record.gateAuthority ?? null,
        record.publishedVersionAtRequest,
        JSON.stringify(record.spec),
        record.status,
        record.requestReason,
        record.requestedByUserId,
        record.requestedBy,
        record.expiresAt,
        record.decidedByUserId,
        record.decidedBy,
        record.decidedAt,
        record.decisionReason,
        record.releaseId,
        record.createdAt,
        record.updatedAt
      ]
    );
    return this.getReleaseApprovalRequestSync(record.id)!;
  }

  async getReleaseApprovalRequest(id: string): Promise<ReleaseApprovalRequestRecord | null> {
    return this.getReleaseApprovalRequestSync(id);
  }

  private getReleaseApprovalRequestSync(id: string): ReleaseApprovalRequestRecord | null {
    const row = this.queryOne<Record<string, unknown>>(`SELECT * FROM release_approval_requests WHERE id = ?`, [id]);
    return row ? mapReleaseApprovalRequestRow(row) : null;
  }

  async listReleaseApprovalRequests(filter: { status: "pending" | "decided" | "all"; workflowId?: string; limit?: number; scope?: ApprovalReadScope; now?: string }): Promise<ReleaseApprovalRequestRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    // Expiry applies in SQL too, so an expired request is never pending (and counts against the decided limit, not the pending one).
    const now = filter.now ?? new Date().toISOString();
    if (filter.status === "pending") {
      clauses.push(`status = 'pending' AND (expires_at IS NULL OR expires_at > ?)`);
      params.push(now);
    }
    if (filter.status === "decided") {
      clauses.push(`(status <> 'pending' OR (expires_at IS NOT NULL AND expires_at <= ?))`);
      params.push(now);
    }
    if (filter.workflowId) {
      clauses.push(`workflow_id = ?`);
      params.push(filter.workflowId);
    }
    if (filter.scope && !filter.scope.all) {
      const ids = filter.scope.workflowIds;
      if (ids.length === 0) return [];
      clauses.push(`workflow_id IN (${ids.map(() => "?").join(", ")})`);
      params.push(...ids);
    }
    const limit = Math.max(1, Math.min(500, filter.limit ?? 200));
    const order = filter.status === "decided" ? "COALESCE(decided_at, updated_at) DESC" : "created_at DESC";
    return this.queryAll<Record<string, unknown>>(
      `SELECT * FROM release_approval_requests ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY ${order}, id DESC LIMIT ${limit}`,
      params
    ).map(mapReleaseApprovalRequestRow);
  }

  /** Records a decision on a pending request; false when it was no longer pending. */
  async decideReleaseApprovalRequest(input: {
    id: string;
    status: "approved" | "rejected" | "canceled" | "timed_out";
    decidedByUserId?: string | null;
    decidedBy?: string | null;
    decisionReason?: string | null;
    releaseId?: string | null;
  }): Promise<boolean> {
    return this.decideReleaseApprovalRequestSync(input);
  }

  private decideReleaseApprovalRequestSync(input: {
    id: string;
    status: "approved" | "rejected" | "canceled" | "timed_out";
    decidedByUserId?: string | null;
    decidedBy?: string | null;
    decisionReason?: string | null;
    releaseId?: string | null;
  }): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE release_approval_requests
         SET status = ?, decided_by_user_id = ?, decided_by = ?, decided_at = ?, decision_reason = ?, release_id = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`
      )
      .run(input.status, input.decidedByUserId ?? null, input.decidedBy ?? null, now, input.decisionReason ?? null, input.releaseId ?? null, now, input.id);
    return result.changes > 0;
  }

  /** Migration 36 — the cases an enforced gate counts (null: not enforced). Leaves the gate's `updated_at` alone. */
  async setReleaseGateAdmission(workflowId: string, admittedFixtureIds: string[] | null, updatedAt: string, updatedBy: string | null): Promise<void> {
    return this.setReleaseGateAdmissionSync(workflowId, admittedFixtureIds, updatedAt, updatedBy);
  }

  private setReleaseGateAdmissionSync(workflowId: string, admittedFixtureIds: string[] | null, updatedAt: string, updatedBy: string | null): void {
    this.exec(`UPDATE release_gates SET admitted_fixture_ids_json = ?, admission_updated_at = ?, admission_updated_by = ? WHERE workflow_id = ?`, [
      admittedFixtureIds === null ? null : JSON.stringify([...new Set(admittedFixtureIds)].sort()),
      updatedAt,
      updatedBy,
      workflowId
    ]);
    this.persist();
  }

  async insertGateCaseRequest(record: GateCaseRequestRecord): Promise<GateCaseRequestRecord> {
    this.exec(
      `INSERT INTO gate_case_requests (
         id, workflow_id, workflow_name, project_id, action, fixtures_json, spec_json, gate_authority, status, request_reason, requested_by_user_id,
         requested_by, expires_at, decided_by_user_id, decided_by, decided_at, decision_reason, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.workflowId,
        record.workflowName,
        record.projectId,
        record.action,
        JSON.stringify(record.fixtures),
        JSON.stringify(record.spec),
        record.gateAuthority,
        record.status,
        record.requestReason,
        record.requestedByUserId,
        record.requestedBy,
        record.expiresAt,
        record.decidedByUserId,
        record.decidedBy,
        record.decidedAt,
        record.decisionReason,
        record.createdAt,
        record.updatedAt
      ]
    );
    return this.getGateCaseRequestSync(record.id)!;
  }

  async getGateCaseRequest(id: string): Promise<GateCaseRequestRecord | null> {
    return this.getGateCaseRequestSync(id);
  }

  private getGateCaseRequestSync(id: string): GateCaseRequestRecord | null {
    const row = this.queryOne<Record<string, unknown>>(`SELECT * FROM gate_case_requests WHERE id = ?`, [id]);
    return row ? mapGateCaseRequestRow(row) : null;
  }

  /** Pending gate case requests of one workflow, newest first. */
  async listPendingGateCaseRequests(workflowId: string): Promise<GateCaseRequestRecord[]> {
    return this.queryAll<Record<string, unknown>>(`SELECT * FROM gate_case_requests WHERE workflow_id = ? AND status = 'pending' ORDER BY created_at DESC, id DESC`, [workflowId]).map(
      mapGateCaseRequestRow
    );
  }

  async listGateCaseRequests(filter: { status: "pending" | "decided" | "all"; workflowId?: string; limit?: number; scope?: ApprovalReadScope; now?: string }): Promise<GateCaseRequestRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const now = filter.now ?? new Date().toISOString();
    if (filter.status === "pending") {
      clauses.push(`status = 'pending' AND (expires_at IS NULL OR expires_at > ?)`);
      params.push(now);
    }
    if (filter.status === "decided") {
      clauses.push(`(status <> 'pending' OR (expires_at IS NOT NULL AND expires_at <= ?))`);
      params.push(now);
    }
    if (filter.workflowId) {
      clauses.push(`workflow_id = ?`);
      params.push(filter.workflowId);
    }
    if (filter.scope && !filter.scope.all) {
      const ids = filter.scope.workflowIds;
      if (ids.length === 0) return [];
      clauses.push(`workflow_id IN (${ids.map(() => "?").join(", ")})`);
      params.push(...ids);
    }
    const limit = Math.max(1, Math.min(500, filter.limit ?? 200));
    const order = filter.status === "decided" ? "COALESCE(decided_at, updated_at) DESC" : "created_at DESC";
    return this.queryAll<Record<string, unknown>>(
      `SELECT * FROM gate_case_requests ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY ${order}, id DESC LIMIT ${limit}`,
      params
    ).map(mapGateCaseRequestRow);
  }

  /** Closes every pending gate case request whose time ran out; returns those it closed. */
  async timeOutExpiredGateCaseRequests(nowIso: string): Promise<GateCaseRequestRecord[]> {
    const expired = this.queryAll<Record<string, unknown>>(
      `SELECT * FROM gate_case_requests WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?`,
      [nowIso]
    ).map(mapGateCaseRequestRow);
    if (expired.length === 0) return [];
    this.exec(
      `UPDATE gate_case_requests SET status = 'timed_out', decided_by = 'system', decided_at = ?, decision_reason = 'Nobody decided before the request expired', updated_at = ?
       WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?`,
      [nowIso, nowIso, nowIso]
    );
    return expired;
  }

  /** Records a decision on a pending gate case request; false when it was no longer pending. */
  async decideGateCaseRequest(input: {
    id: string;
    status: "approved" | "rejected" | "canceled" | "timed_out";
    decidedByUserId?: string | null;
    decidedBy?: string | null;
    decisionReason?: string | null;
  }): Promise<boolean> {
    return this.decideGateCaseRequestSync(input);
  }

  private decideGateCaseRequestSync(input: {
    id: string;
    status: "approved" | "rejected" | "canceled" | "timed_out";
    decidedByUserId?: string | null;
    decidedBy?: string | null;
    decisionReason?: string | null;
  }): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE gate_case_requests
         SET status = ?, decided_by_user_id = ?, decided_by = ?, decided_at = ?, decision_reason = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`
      )
      .run(input.status, input.decidedByUserId ?? null, input.decidedBy ?? null, now, input.decisionReason ?? null, now, input.id);
    if (result.changes > 0) this.persist();
    return result.changes > 0;
  }

  // Git config (singleton row keyed by literal 'default')

  async getGitConfig(): Promise<{
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
  } | null> {
    return this.getGitConfigSync();
  }

  private getGitConfigSync(): {
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

  async upsertGitConfig(input: {
    repoUrl: string;
    defaultBranch?: string;
    authSecretId?: string | null;
    workflowsDir?: string;
    variablesFile?: string;
    userName?: string;
    userEmail?: string;
    enabled?: boolean;
  }): Promise<void> {
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

  async deleteGitConfig(): Promise<boolean> {
    const existing = this.getGitConfigSync();
    if (!existing) return false;
    this.exec(`DELETE FROM git_configs WHERE id = 'default'`);
    this.persist();
    return true;
  }

  async recordGitSync(input: { kind: "push" | "pull"; error?: string | null }): Promise<void> {
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

  async getLease(leaseName: string): Promise<{
    leaseName: string;
    holderId: string;
    expiresAt: string;
    acquiredAt: string;
    renewedAt: string;
  } | null> {
    return this.getLeaseSync(leaseName);
  }

  private getLeaseSync(leaseName: string): {
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
  async tryAcquireLease(input: { leaseName: string; holderId: string; ttlMs: number }): Promise<boolean> {
    const now = Date.now();
    const existing = this.getLeaseSync(input.leaseName);
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

  async releaseLease(leaseName: string, holderId: string): Promise<boolean> {
    const existing = this.getLeaseSync(leaseName);
    if (!existing || existing.holderId !== holderId) return false;
    this.exec(`DELETE FROM leader_leases WHERE lease_name = ?`, [leaseName]);
    this.persist();
    return true;
  }

  async listLeases(): Promise<Array<{
    leaseName: string;
    holderId: string;
    expiresAt: string;
    acquiredAt: string;
    renewedAt: string;
  }>> {
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
  // Phase 13.1 — cluster registry. The app writes it on Postgres only (one SQLite process is the whole cluster);
  // these keep the Store contract, on the process clock.
  // ---------------------------------------------------------------------------

  async heartbeatClusterInstance(input: ClusterInstanceHeartbeat): Promise<void> {
    this.exec(
      `INSERT INTO cluster_instances
         (id, worker_mode, ha_enabled, is_leader, pools_json, concurrency, running, app_version, schema_version,
          capabilities_json, hostname, bus_connected, started_at, heartbeat_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         worker_mode = excluded.worker_mode, ha_enabled = excluded.ha_enabled, is_leader = excluded.is_leader,
         pools_json = excluded.pools_json, concurrency = excluded.concurrency, running = excluded.running,
         app_version = excluded.app_version, schema_version = excluded.schema_version,
         capabilities_json = excluded.capabilities_json, hostname = excluded.hostname,
         bus_connected = excluded.bus_connected, started_at = excluded.started_at, heartbeat_at = excluded.heartbeat_at`,
      [
        input.id,
        input.workerMode,
        input.haEnabled ? 1 : 0,
        input.isLeader ? 1 : 0,
        JSON.stringify(input.pools),
        input.concurrency,
        input.running,
        input.appVersion,
        input.schemaVersion,
        JSON.stringify(input.capabilities),
        input.hostname,
        input.busConnected ? 1 : 0,
        input.startedAt,
        new Date().toISOString()
      ]
    );
    this.persist();
  }

  async listClusterInstances(input: { liveWithinMs: number }): Promise<ClusterInstanceRecord[]> {
    const liveSince = new Date(Date.now() - input.liveWithinMs).toISOString();
    const rows = this.queryAll<Record<string, unknown>>(`SELECT * FROM cluster_instances ORDER BY heartbeat_at DESC, id`);
    const list = (value: unknown): string[] => {
      const parsed = parseJsonSafe(value);
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    };
    return rows.map((row) => ({
      id: toString(row.id),
      workerMode: toString(row.worker_mode),
      haEnabled: Number(row.ha_enabled) === 1,
      isLeader: Number(row.is_leader) === 1,
      pools: list(row.pools_json),
      concurrency: row.concurrency === null || row.concurrency === undefined ? null : Number(row.concurrency),
      running: Number(row.running ?? 0),
      appVersion: row.app_version === null || row.app_version === undefined ? null : toString(row.app_version),
      schemaVersion: row.schema_version === null || row.schema_version === undefined ? null : Number(row.schema_version),
      capabilities: list(row.capabilities_json),
      hostname: toString(row.hostname ?? ""),
      busConnected: Number(row.bus_connected) === 1,
      startedAt: toString(row.started_at),
      heartbeatAt: toString(row.heartbeat_at),
      live: toString(row.heartbeat_at) >= liveSince
    }));
  }

  async deleteClusterInstance(id: string): Promise<void> {
    this.exec(`DELETE FROM cluster_instances WHERE id = ?`, [id]);
    this.persist();
  }

  async pruneClusterInstances(input: { olderThanMs: number }): Promise<number> {
    const cutoff = new Date(Date.now() - input.olderThanMs).toISOString();
    const { changes } = this.db.prepare(`DELETE FROM cluster_instances WHERE heartbeat_at < ?`).run(cutoff);
    if (changes > 0) this.persist();
    return changes;
  }

  async claimClusterRunOwner(input: { executionId: string; instanceId: string }): Promise<void> {
    this.exec(
      `INSERT INTO cluster_run_owners (execution_id, instance_id, started_at) VALUES (?, ?, ?)
       ON CONFLICT (execution_id) DO UPDATE SET instance_id = excluded.instance_id, started_at = excluded.started_at`,
      [input.executionId, input.instanceId, new Date().toISOString()]
    );
    this.persist();
  }

  async releaseClusterRunOwner(input: { executionId: string; instanceId: string }): Promise<void> {
    this.exec(`DELETE FROM cluster_run_owners WHERE execution_id = ? AND instance_id = ?`, [input.executionId, input.instanceId]);
    this.persist();
  }

  async reconcileDeadExecutorRuns(input: { error: string; deadAfterMs: number; selfId: string }): Promise<Array<{ id: string; workflowId: string; instanceId: string }>> {
    const cutoff = new Date(Date.now() - input.deadAfterMs).toISOString();
    // Runs a live queue job drives belong to the queue's lease and reaper. Read before the (synchronous) transaction;
    // the failing UPDATE re-checks `status = 'running'`, so a job that finishes in between changes nothing.
    const candidates = this.queryAll<{ execution_id: unknown }>(`SELECT execution_id FROM cluster_run_owners WHERE instance_id <> ?`, [input.selfId]);
    const checked = new Set(candidates.map((owner) => toString(owner.execution_id)));
    const queueHeld = new Set(await this.listExecutionIdsWithActiveQueueJob(candidates.map((owner) => toString(owner.execution_id))));
    return this.transaction(() => {
      const dead = this.queryAll<{ execution_id: unknown; instance_id: unknown }>(
        `SELECT o.execution_id, o.instance_id
           FROM cluster_run_owners o
           LEFT JOIN cluster_instances i ON i.id = o.instance_id
          WHERE o.instance_id <> ?
            AND ((i.id IS NULL AND o.started_at < ?) OR i.heartbeat_at < ?)
          ORDER BY o.execution_id`,
        [input.selfId, cutoff, cutoff]
      );
      const completedAt = new Date().toISOString();
      const failed: Array<{ id: string; workflowId: string; instanceId: string }> = [];
      let changed = false;
      for (const owner of dead) {
        const executionId = toString(owner.execution_id);
        // An owner claimed after the queue read waits for the next pass, so no run is failed without its queue check.
        if (!checked.has(executionId)) continue;
        changed = true;
        const run = queueHeld.has(executionId)
          ? undefined
          : this.queryOne<{ workflow_id: unknown; started_at: unknown }>(`SELECT workflow_id, started_at FROM execution_history WHERE id = ? AND status = 'running'`, [
              executionId
            ]);
        if (run) {
          this.exec(`UPDATE execution_history SET status = 'error', completed_at = ?, duration_ms = ?, error = ? WHERE id = ?`, [
            completedAt,
            toDurationMsForStore(toString(run.started_at), completedAt),
            input.error,
            executionId
          ]);
          failed.push({ id: executionId, workflowId: toString(run.workflow_id), instanceId: toString(owner.instance_id) });
        }
        this.exec(`DELETE FROM cluster_run_owners WHERE execution_id = ?`, [executionId]);
      }
      if (changed) this.persist();
      return failed;
    });
  }

  async failRunsOwnedBy(input: { instanceId: string; error: string }): Promise<Array<{ id: string; workflowId: string; instanceId: string }>> {
    // As in reconcileDeadExecutorRuns: the queue's runs are read first, and the UPDATE re-checks the status.
    const candidates = this.queryAll<{ execution_id: unknown }>(`SELECT execution_id FROM cluster_run_owners WHERE instance_id = ?`, [input.instanceId]);
    const checked = new Set(candidates.map((owner) => toString(owner.execution_id)));
    const queueHeld = new Set(await this.listExecutionIdsWithActiveQueueJob([...checked]));
    return this.transaction(() => {
      // Only the owners whose queue state was read above; one claimed in between is left for the next call.
      const owned = this.queryAll<{ execution_id: unknown }>(`SELECT execution_id FROM cluster_run_owners WHERE instance_id = ? ORDER BY execution_id`, [
        input.instanceId
      ]).filter((owner) => checked.has(toString(owner.execution_id)));
      const completedAt = new Date().toISOString();
      const failed: Array<{ id: string; workflowId: string; instanceId: string }> = [];
      for (const owner of owned) {
        const executionId = toString(owner.execution_id);
        const run = queueHeld.has(executionId)
          ? undefined
          : this.queryOne<{ workflow_id: unknown; started_at: unknown }>(`SELECT workflow_id, started_at FROM execution_history WHERE id = ? AND status = 'running'`, [
              executionId
            ]);
        if (run) {
          this.exec(`UPDATE execution_history SET status = 'error', completed_at = ?, duration_ms = ?, error = ? WHERE id = ?`, [
            completedAt,
            toDurationMsForStore(toString(run.started_at), completedAt),
            input.error,
            executionId
          ]);
          failed.push({ id: executionId, workflowId: toString(run.workflow_id), instanceId: input.instanceId });
        }
      }
      for (const owner of owned) {
        this.exec(`DELETE FROM cluster_run_owners WHERE execution_id = ? AND instance_id = ?`, [toString(owner.execution_id), input.instanceId]);
      }
      if (owned.length > 0) this.persist();
      return failed;
    });
  }

  // ---------------------------------------------------------------------------
  // Phase 13.1 shared auth and per-user flow state. The app uses these in cluster mode only (Postgres); here they keep
  // the same contract for the contract tests. One process, synchronous statements: each method is atomic as written.
  // ---------------------------------------------------------------------------

  async createPendingChallenge(input: PendingChallengeInput): Promise<void> {
    const now = Date.now();
    this.exec(
      `INSERT INTO pending_challenges (id_hash, kind, user_id, scope, payload_sealed, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id_hash) DO NOTHING`,
      [
        input.idHash,
        input.kind,
        input.userId,
        input.scope,
        input.payloadSealed,
        new Date(now).toISOString(),
        new Date(now + Math.max(0, input.ttlMs)).toISOString()
      ]
    );
    const changesRow = this.queryOne<{ count: number }>("SELECT changes() as count");
    if ((changesRow ? toNumber(changesRow.count) : 0) === 0) throw new Error("A pending challenge is already stored under this id hash.");
  }

  async consumePendingChallenge(input: { idHash: string; kind: string }): Promise<ConsumedPendingChallenge | null> {
    return this.transaction(() => {
      const row = this.queryOne<{ user_id: unknown; scope: unknown; payload_sealed: unknown; expires_at: unknown }>(
        `SELECT user_id, scope, payload_sealed, expires_at FROM pending_challenges WHERE id_hash = ? AND kind = ?`,
        [input.idHash, input.kind]
      );
      if (!row) return null;
      this.exec(`DELETE FROM pending_challenges WHERE id_hash = ?`, [input.idHash]);
      return {
        userId: row.user_id === null || row.user_id === undefined ? null : toString(row.user_id),
        scope: row.scope === null || row.scope === undefined ? null : toString(row.scope),
        payloadSealed: toString(row.payload_sealed),
        expired: toString(row.expires_at) <= new Date().toISOString()
      };
    });
  }

  async deletePendingChallenges(input: { kind: string; scope: string; userId: string | null }): Promise<number> {
    const { changes } = this.db
      .prepare(`DELETE FROM pending_challenges WHERE kind = ? AND scope = ? AND user_id IS ?`)
      .run(input.kind, input.scope, input.userId);
    return changes;
  }

  async prunePendingChallenges(): Promise<number> {
    const { changes } = this.db.prepare(`DELETE FROM pending_challenges WHERE expires_at <= ?`).run(new Date().toISOString());
    return changes;
  }

  async hitRateLimitBucket(input: { key: string; windowMs: number }): Promise<{ count: number; ttlMs: number }> {
    const windowMs = Math.max(1, Math.floor(input.windowMs));
    return this.transaction(() => {
      const nowMs = Date.now();
      const now = new Date(nowMs).toISOString();
      const row = this.queryOne<{ count: unknown; expires_at: unknown }>(`SELECT count, expires_at FROM rate_limit_buckets WHERE key = ?`, [input.key]);
      if (!row || toString(row.expires_at) <= now) {
        const expiresAt = new Date(nowMs + windowMs).toISOString();
        this.exec(
          `INSERT INTO rate_limit_buckets (key, window_start, expires_at, count) VALUES (?, ?, ?, 1)
           ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, expires_at = excluded.expires_at, count = 1`,
          [input.key, now, expiresAt]
        );
        return { count: 1, ttlMs: windowMs };
      }
      const count = toNumber(row.count) + 1;
      this.exec(`UPDATE rate_limit_buckets SET count = ? WHERE key = ?`, [count, input.key]);
      return { count, ttlMs: Math.max(0, Date.parse(toString(row.expires_at)) - nowMs) };
    });
  }

  async pruneRateLimitBuckets(): Promise<number> {
    const { changes } = this.db.prepare(`DELETE FROM rate_limit_buckets WHERE expires_at <= ?`).run(new Date().toISOString());
    return changes;
  }

  async reserveReplayCapture(input: { id: string; workflowId: string; since: string; maxPerDay: number; ttlMs: number }): Promise<boolean> {
    return this.transaction(() => {
      const nowMs = Date.now();
      const now = new Date(nowMs).toISOString();
      const captured = this.queryOne<{ count: unknown }>(`SELECT COUNT(*) AS count FROM replay_recordings WHERE workflow_id = ? AND captured_at >= ?`, [
        input.workflowId,
        input.since
      ]);
      const reserved = this.queryOne<{ count: unknown }>(`SELECT COUNT(*) AS count FROM capture_reservations WHERE workflow_id = ? AND expires_at > ?`, [
        input.workflowId,
        now
      ]);
      if (toNumber(captured?.count ?? 0) + toNumber(reserved?.count ?? 0) >= input.maxPerDay) return false;
      this.exec(`INSERT INTO capture_reservations (id, workflow_id, created_at, expires_at) VALUES (?, ?, ?, ?)`, [
        input.id,
        input.workflowId,
        now,
        new Date(nowMs + Math.max(0, input.ttlMs)).toISOString()
      ]);
      return true;
    });
  }

  async releaseReplayCaptureReservation(id: string): Promise<void> {
    this.exec(`DELETE FROM capture_reservations WHERE id = ?`, [id]);
  }

  async countReplayCaptureReservations(workflowId: string): Promise<number> {
    const row = this.queryOne<{ count: unknown }>(`SELECT COUNT(*) AS count FROM capture_reservations WHERE workflow_id = ? AND expires_at > ?`, [
      workflowId,
      new Date().toISOString()
    ]);
    return toNumber(row?.count ?? 0);
  }

  async pruneReplayCaptureReservations(): Promise<number> {
    const { changes } = this.db.prepare(`DELETE FROM capture_reservations WHERE expires_at <= ?`).run(new Date().toISOString());
    return changes;
  }

  // ---------------------------------------------------------------------------
  // Workflow Templates (Phase 7.4)
  // ---------------------------------------------------------------------------

  async listTemplates(filters?: { category?: string; search?: string }): Promise<Array<{
    id: string; name: string; description: string; category: string;
    tags: string[]; author: string; nodeCount: number;
    createdAt: string; updatedAt: string;
  }>> {
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

  async getTemplate(id: string): Promise<{
    id: string; name: string; description: string; category: string;
    tags: string[]; author: string; workflowJson: string; nodeCount: number;
    createdAt: string; updatedAt: string;
  } | undefined> {
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

  async upsertTemplate(input: {
    id: string; name: string; description: string; category: string;
    tags: string[]; author: string; workflowJson: string; nodeCount: number;
  }): Promise<void> {
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

  async deleteTemplate(id: string): Promise<boolean> {
    this.exec(`DELETE FROM workflow_templates WHERE id = ?`, [id]);
    const changesRow = this.queryOne<{ count: number }>("SELECT changes() as count");
    const changed = (changesRow ? toNumber(changesRow.count) : 0) > 0;
    if (changed) this.persist();
    return changed;
  }

  async countTemplates(): Promise<number> {
    const row = this.queryOne<{ count: number }>("SELECT COUNT(*) as count FROM workflow_templates");
    return row ? toNumber(row.count) : 0;
  }

  // ---------------------------------------------------------------------------
  // Notification Configs (Phase 7.5)
  // ---------------------------------------------------------------------------

  async listNotificationConfigs(): Promise<Array<{
    id: string; channel: string; enabled: boolean;
    config: Record<string, unknown>; events: string[];
    createdAt: string; updatedAt: string;
  }>> {
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

  async upsertNotificationConfig(input: {
    id: string; channel: string; enabled: boolean;
    config: Record<string, unknown>; events: string[];
  }): Promise<void> {
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

  async deleteNotificationConfig(id: string): Promise<boolean> {
    this.exec(`DELETE FROM notification_configs WHERE id = ?`, [id]);
    const changesRow = this.queryOne<{ count: number }>("SELECT changes() as count");
    const changed = (changesRow ? toNumber(changesRow.count) : 0) > 0;
    if (changed) this.persist();
    return changed;
  }

  // ---------------------------------------------------------------------------
  // Phase 7.3 — Agent eval framework
  // ---------------------------------------------------------------------------

  async createEvalDataset(input: {
    id: string;
    name: string;
    description?: string;
    projectId?: string;
    workflowId?: string;
    createdBy?: string;
  }): Promise<void> {
    return this.createEvalDatasetSync(input);
  }

  private createEvalDatasetSync(input: {
    id: string;
    name: string;
    description?: string;
    projectId?: string;
    workflowId?: string;
    createdBy?: string;
  }): void {
    const now = new Date().toISOString();
    this.exec(
      `INSERT INTO eval_datasets (id, name, description, project_id, workflow_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [input.id, input.name, input.description ?? null, input.projectId ?? null, input.workflowId ?? null, input.createdBy ?? null, now, now]
    );
    this.persist();
  }

  async listEvalDatasets(options: { projectId?: string; workflowId?: string; id?: string } = {}): Promise<EvalDatasetRecord[]> {
    return this.listEvalDatasetsSync(options);
  }

  private listEvalDatasetsSync(options: { projectId?: string; workflowId?: string; id?: string } = {}): EvalDatasetRecord[] {
    const clauses: string[] = [];
    const params: BindParams = [];
    if (options.projectId) { clauses.push("d.project_id = ?"); params.push(options.projectId); }
    if (options.workflowId) { clauses.push("d.workflow_id = ?"); params.push(options.workflowId); }
    if (options.id) { clauses.push("d.id = ?"); params.push(options.id); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.queryAll<{
      id: string; name: string; description: string | null; project_id: string | null; workflow_id: string | null;
      created_by: string | null; created_at: string; updated_at: string; fixture_count: number; golden_count: number;
    }>(
      `SELECT d.id, d.name, d.description, d.project_id, d.workflow_id, d.created_by, d.created_at, d.updated_at,
              (SELECT COUNT(*) FROM eval_fixtures WHERE dataset_id = d.id) AS fixture_count,
              (SELECT COUNT(*) FROM eval_fixtures WHERE dataset_id = d.id AND recording_id IS NOT NULL) AS golden_count
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
      workflowId: r.workflow_id ? toString(r.workflow_id) : null,
      createdBy: r.created_by ? toString(r.created_by) : null,
      createdAt: toString(r.created_at),
      updatedAt: toString(r.updated_at),
      fixtureCount: toNumber(r.fixture_count),
      goldenRunCount: toNumber(r.golden_count)
    }));
  }

  async getEvalDataset(id: string): Promise<EvalDatasetRecord | null> {
    return this.getEvalDatasetSync(id);
  }

  private getEvalDatasetSync(id: string): EvalDatasetRecord | null {
    return this.listEvalDatasetsSync({ id })[0] ?? null;
  }

  async deleteEvalDataset(id: string): Promise<boolean> {
    this.exec(`DELETE FROM eval_results WHERE run_id IN (SELECT id FROM eval_runs WHERE dataset_id = ?)`, [id]);
    this.exec(`DELETE FROM eval_runs WHERE dataset_id = ?`, [id]);
    this.exec(`DELETE FROM eval_fixtures WHERE dataset_id = ?`, [id]);
    this.exec(`DELETE FROM eval_datasets WHERE id = ?`, [id]);
    const row = this.queryOne<{ count: number }>("SELECT changes() as count");
    const changed = (row ? toNumber(row.count) : 0) > 0;
    if (changed) this.persist();
    return changed;
  }

  async createEvalFixture(input: {
    id: string; datasetId: string; name: string;
    input: unknown; expected?: unknown;
    scorers?: Array<Record<string, unknown>>;
    recordingId?: string;
  }): Promise<void> {
    return this.createEvalFixtureSync(input);
  }

  private createEvalFixtureSync(input: {
    id: string; datasetId: string; name: string;
    input: unknown; expected?: unknown;
    scorers?: Array<Record<string, unknown>>;
    recordingId?: string;
  }): void {
    const now = new Date().toISOString();
    this.exec(
      `INSERT INTO eval_fixtures (id, dataset_id, name, input_json, expected_json, scorers_json, recording_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id, input.datasetId, input.name,
        JSON.stringify(input.input ?? null),
        input.expected !== undefined ? JSON.stringify(input.expected) : null,
        input.scorers && input.scorers.length > 0 ? JSON.stringify(input.scorers) : null,
        input.recordingId ?? null,
        now, now
      ]
    );
    this.persist();
  }

  private mapEvalFixture(r: EvalFixtureRow): EvalFixtureRecord {
    return {
      id: toString(r.id),
      datasetId: toString(r.dataset_id),
      name: toString(r.name),
      input: JSON.parse(toString(r.input_json) || "null"),
      expected: r.expected_json ? JSON.parse(toString(r.expected_json)) : null,
      scorers: r.scorers_json ? (JSON.parse(toString(r.scorers_json)) as Array<Record<string, unknown>>) : null,
      recordingId: r.recording_id ? toString(r.recording_id) : null,
      required: Number(r.required ?? 0) === 1,
      createdAt: toString(r.created_at),
      updatedAt: toString(r.updated_at)
    };
  }

  async listEvalFixtures(datasetId: string): Promise<EvalFixtureRecord[]> {
    const rows = this.queryAll<EvalFixtureRow>(
      `SELECT id, dataset_id, name, input_json, expected_json, scorers_json, recording_id, required, created_at, updated_at
       FROM eval_fixtures WHERE dataset_id = ? ORDER BY created_at, rowid`,
      [datasetId]
    );
    return rows.map((r) => this.mapEvalFixture(r));
  }

  async getEvalFixture(id: string): Promise<EvalFixtureRecord | null> {
    return this.getEvalFixtureSync(id);
  }

  private getEvalFixtureSync(id: string): EvalFixtureRecord | null {
    const row = this.queryOne<EvalFixtureRow>(
      `SELECT id, dataset_id, name, input_json, expected_json, scorers_json, recording_id, required, created_at, updated_at
       FROM eval_fixtures WHERE id = ?`,
      [id]
    );
    return row ? this.mapEvalFixture(row) : null;
  }

  /** Phase 15.2 — whether a golden set already holds this golden run. */
  async findEvalFixtureByRecording(datasetId: string, recordingId: string): Promise<EvalFixtureRecord | null> {
    const row = this.queryOne<EvalFixtureRow>(
      `SELECT id, dataset_id, name, input_json, expected_json, scorers_json, recording_id, required, created_at, updated_at
       FROM eval_fixtures WHERE dataset_id = ? AND recording_id = ? LIMIT 1`,
      [datasetId, recordingId]
    );
    return row ? this.mapEvalFixture(row) : null;
  }

  async getEvalFixtureDatasetId(id: string): Promise<string | null> {
    const row = this.queryOne<{ dataset_id: string }>(`SELECT dataset_id FROM eval_fixtures WHERE id = ?`, [id]);
    return row ? toString(row.dataset_id) : null;
  }

  async deleteEvalFixture(id: string): Promise<boolean> {
    return this.deleteEvalFixtureSync(id);
  }

  private deleteEvalFixtureSync(id: string): boolean {
    this.exec(`DELETE FROM eval_fixtures WHERE id = ?`, [id]);
    const row = this.queryOne<{ count: number }>("SELECT changes() as count");
    const changed = (row ? toNumber(row.count) : 0) > 0;
    if (changed) this.persist();
    return changed;
  }

  /** Migration 36 — marks a case required (or not); false when it does not exist. */
  async setEvalFixtureRequired(id: string, required: boolean): Promise<boolean> {
    return this.setEvalFixtureRequiredSync(id, required);
  }

  private setEvalFixtureRequiredSync(id: string, required: boolean): boolean {
    const result = this.db.prepare(`UPDATE eval_fixtures SET required = ?, updated_at = ? WHERE id = ?`).run(required ? 1 : 0, new Date().toISOString(), id);
    if (result.changes > 0) this.persist();
    return result.changes > 0;
  }

  async createEvalRun(input: {
    id: string; datasetId: string; workflowId: string; workflowName?: string;
    triggeredBy?: string; triggeredByUserId?: string; scorers?: Array<Record<string, unknown>>;
    /** Phase 15.2 */
    kind?: "eval" | "replay";
    status?: string;
    datasetIds?: string[];
    candidate?: Record<string, unknown>;
    workflowHash?: string;
    workflowVersion?: number | null;
    options?: Record<string, unknown>;
    progress?: Record<string, unknown>;
  }): Promise<void> {
    const now = new Date().toISOString();
    this.exec(
      `INSERT INTO eval_runs (id, dataset_id, workflow_id, workflow_name, status, started_at,
                               triggered_by, triggered_by_user_id, scorers_json, kind, dataset_ids_json, candidate_json,
                               workflow_hash, workflow_version, options_json, progress_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id, input.datasetId, input.workflowId, input.workflowName ?? null,
        input.status ?? "running", now, input.triggeredBy ?? null, input.triggeredByUserId ?? null,
        input.scorers && input.scorers.length > 0 ? JSON.stringify(input.scorers) : null,
        input.kind ?? "eval",
        input.datasetIds ? JSON.stringify(input.datasetIds) : null,
        input.candidate ? JSON.stringify(input.candidate) : null,
        input.workflowHash ?? null,
        typeof input.workflowVersion === "number" ? input.workflowVersion : null,
        input.options ? JSON.stringify(input.options) : null,
        input.progress ? JSON.stringify(input.progress) : null,
        now
      ]
    );
    this.persist();
  }

  /**
   * Phase 15.2 — a queued run starts, or a running run reports progress.
   * Only a run still queued or running is touched, so a late heartbeat never
   * revives a run another process finished, canceled or interrupted.
   */
  async updateEvalRunProgress(input: { id: string; status?: string; progress: Record<string, unknown> }): Promise<void> {
    if (input.status) {
      this.exec(`UPDATE eval_runs SET status = ?, progress_json = ? WHERE id = ? AND status IN ('queued', 'running')`, [input.status, JSON.stringify(input.progress), input.id]);
    } else {
      this.exec(`UPDATE eval_runs SET progress_json = ? WHERE id = ? AND status IN ('queued', 'running')`, [JSON.stringify(input.progress), input.id]);
    }
    this.persist();
  }

  /**
   * Phase 15.2 — deletes finished eval runs and replay jobs (with their case
   * results) that started before `before`. The newest run of every dataset
   * or golden set, and its newest finished one, are always kept, so a set
   * never loses its last verdict. Returns how many runs were deleted.
   */
  async pruneEvalRuns(input: { before: string }): Promise<number> {
    const rows = this.queryAll<{ id: string; dataset_id: string; dataset_ids_json: string | null; status: string; started_at: string }>(
      `SELECT id, dataset_id, dataset_ids_json, status, started_at FROM eval_runs ORDER BY started_at DESC, rowid DESC`
    );
    const newest = new Set<string>();
    const newestFinished = new Set<string>();
    const keep = new Set<string>();
    const doomed: string[] = [];
    for (const row of rows) {
      const id = toString(row.id);
      const status = toString(row.status);
      const finished = status !== "queued" && status !== "running";
      let sets: string[] = [toString(row.dataset_id)];
      try {
        const parsed = row.dataset_ids_json ? (JSON.parse(toString(row.dataset_ids_json)) as unknown) : null;
        if (Array.isArray(parsed)) sets = [...new Set([...sets, ...parsed.map((entry) => String(entry))])];
      } catch {
        // A malformed list: the first set still counts.
      }
      for (const set of sets) {
        if (!newest.has(set)) {
          newest.add(set);
          keep.add(id);
        }
        if (finished && !newestFinished.has(set)) {
          newestFinished.add(set);
          keep.add(id);
        }
      }
      if (finished && !keep.has(id) && toString(row.started_at) < input.before) doomed.push(id);
    }
    for (let index = 0; index < doomed.length; index += 200) {
      const chunk = doomed.slice(index, index + 200);
      const marks = chunk.map(() => "?").join(", ");
      this.exec(`DELETE FROM eval_results WHERE run_id IN (${marks})`, chunk);
      this.exec(`DELETE FROM eval_runs WHERE id IN (${marks})`, chunk);
    }
    if (doomed.length > 0) this.persist();
    return doomed.length;
  }

  async finalizeEvalRun(input: {
    id: string;
    status: "completed" | "errored" | "failed" | "canceled" | "interrupted";
    summary?: Record<string, unknown>;
    progress?: Record<string, unknown>;
    error?: string;
    /** Only finish a run that is still in one of these statuses (a canceled run stays canceled). */
    onlyFrom?: string[];
  }): Promise<boolean> {
    const now = new Date().toISOString();
    const guard = input.onlyFrom && input.onlyFrom.length > 0 ? ` AND status IN (${input.onlyFrom.map(() => "?").join(", ")})` : "";
    this.exec(
      `UPDATE eval_runs SET status = ?, completed_at = ?, summary_json = COALESCE(?, summary_json), progress_json = COALESCE(?, progress_json), error = ? WHERE id = ?${guard}`,
      [
        input.status,
        now,
        input.summary ? JSON.stringify(input.summary) : null,
        input.progress ? JSON.stringify(input.progress) : null,
        input.error ?? null,
        input.id,
        ...(input.onlyFrom ?? [])
      ]
    );
    const row = this.queryOne<{ count: number }>("SELECT changes() as count");
    this.persist();
    return (row ? toNumber(row.count) : 0) > 0;
  }

  /** Phase 15.2 — the summary of a run that already finished (a canceled run's last cases). */
  async updateEvalRunSummary(id: string, summary: Record<string, unknown>, progress: Record<string, unknown>): Promise<void> {
    this.exec(`UPDATE eval_runs SET summary_json = ?, progress_json = ? WHERE id = ?`, [JSON.stringify(summary), JSON.stringify(progress), id]);
    this.persist();
  }

  async listEvalRuns(options: { datasetId?: string; workflowId?: string; workflowIds?: string[]; kind?: "eval" | "replay"; statuses?: string[]; id?: string; limit?: number; offset?: number; excludeSimulations?: boolean } = {}): Promise<EvalRunRecord[]> {
    return this.listEvalRunsSync(options);
  }

  private listEvalRunsSync(options: { datasetId?: string; workflowId?: string; workflowIds?: string[]; kind?: "eval" | "replay"; statuses?: string[]; id?: string; limit?: number; offset?: number; excludeSimulations?: boolean } = {}): EvalRunRecord[] {
    const clauses: string[] = [];
    const params: BindParams = [];
    if (options.id) { clauses.push("id = ?"); params.push(options.id); }
    // Phase 15.6 — a guard policy simulation's replay jobs are listed with their simulation, not with the workflow's jobs.
    if (options.excludeSimulations) { clauses.push("dataset_id NOT LIKE ?"); params.push(`${GUARD_SIMULATION_JOB_DATASET_PREFIX}%`); }
    if (options.datasetId) {
      // The id is matched as a JSON string inside the list; `%`, `_` and `\` in it are literal.
      const needle = JSON.stringify(options.datasetId).replace(/[\\%_]/g, (char) => `\\${char}`);
      clauses.push("(dataset_id = ? OR dataset_ids_json LIKE ? ESCAPE '\\')");
      params.push(options.datasetId, `%${needle}%`);
    }
    if (options.workflowId) { clauses.push("workflow_id = ?"); params.push(options.workflowId); }
    // Project scope: only runs of these workflows (an empty list matches nothing).
    if (options.workflowIds) {
      clauses.push(options.workflowIds.length > 0 ? `workflow_id IN (${options.workflowIds.map(() => "?").join(", ")})` : "1 = 0");
      params.push(...options.workflowIds);
    }
    if (options.kind) { clauses.push("kind = ?"); params.push(options.kind); }
    if (options.statuses && options.statuses.length > 0) {
      clauses.push(`status IN (${options.statuses.map(() => "?").join(", ")})`);
      params.push(...options.statuses);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(500, options.limit ?? 100));
    const rows = this.queryAll<{
      id: string; dataset_id: string; workflow_id: string; workflow_name: string | null;
      status: string; started_at: string; completed_at: string | null;
      triggered_by: string | null; scorers_json: string | null; summary_json: string | null; error: string | null;
      kind: string | null; dataset_ids_json: string | null; candidate_json: string | null;
      workflow_hash: string | null; workflow_version: number | null; options_json: string | null; progress_json: string | null;
    }>(
      `SELECT id, dataset_id, workflow_id, workflow_name, status, started_at, completed_at,
              triggered_by, scorers_json, summary_json, error, kind, dataset_ids_json, candidate_json,
              workflow_hash, workflow_version, options_json, progress_json
       FROM eval_runs ${where} ORDER BY started_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      [...params, limit, Math.max(0, Math.floor(options.offset ?? 0))]
    );
    const parse = <T>(value: string | null): T | null => (value ? (JSON.parse(toString(value)) as T) : null);
    return rows.map((r) => ({
      id: toString(r.id),
      kind: r.kind === "replay" ? "replay" : "eval",
      datasetId: toString(r.dataset_id),
      datasetIds: parse<string[]>(r.dataset_ids_json) ?? [toString(r.dataset_id)],
      workflowId: toString(r.workflow_id),
      workflowName: r.workflow_name ? toString(r.workflow_name) : null,
      status: toString(r.status),
      startedAt: toString(r.started_at),
      completedAt: r.completed_at ? toString(r.completed_at) : null,
      triggeredBy: r.triggered_by ? toString(r.triggered_by) : null,
      scorers: parse<Array<Record<string, unknown>>>(r.scorers_json),
      summary: parse<Record<string, unknown>>(r.summary_json),
      error: r.error ? toString(r.error) : null,
      candidate: parse<Record<string, unknown>>(r.candidate_json),
      workflowHash: r.workflow_hash ? toString(r.workflow_hash) : null,
      workflowVersion: r.workflow_version !== null && r.workflow_version !== undefined ? toNumber(r.workflow_version) : null,
      options: parse<Record<string, unknown>>(r.options_json),
      progress: parse<Record<string, unknown>>(r.progress_json)
    }));
  }

  async getEvalRun(id: string): Promise<EvalRunRecord | null> {
    return this.listEvalRunsSync({ id, limit: 1 })[0] ?? null;
  }

  async recordEvalResult(input: {
    id: string; runId: string; fixtureId: string; fixtureName?: string;
    status: "pass" | "fail" | "error" | "skipped";
    executionId?: string;
    score?: Record<string, unknown>;
    output?: unknown;
    error?: string;
    durationMs?: number;
    tokenInput?: number;
    tokenOutput?: number;
    tokenTotal?: number;
    /** Phase 15.2 */
    recordingId?: string;
    verdict?: string;
    diff?: unknown;
    costUsd?: number | null;
  }): Promise<void> {
    const now = new Date().toISOString();
    this.exec(
      `INSERT INTO eval_results (id, run_id, fixture_id, fixture_name, status, execution_id,
                                  score_json, output_json, error, duration_ms,
                                  token_input, token_output, token_total, recording_id, verdict, diff_json, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.recordingId ?? null,
        input.verdict ?? null,
        input.diff !== undefined ? JSON.stringify(input.diff) : null,
        typeof input.costUsd === "number" && Number.isFinite(input.costUsd) ? input.costUsd : null,
        now
      ]
    );
    this.persist();
  }

  private mapEvalResult(r: EvalResultRow, withDetail: boolean): EvalResultRecord {
    const num = (value: number | null) => (value !== null && value !== undefined ? toNumber(value) : null);
    return {
      id: toString(r.id),
      runId: toString(r.run_id),
      fixtureId: toString(r.fixture_id),
      fixtureName: r.fixture_name ? toString(r.fixture_name) : null,
      recordingId: r.recording_id ? toString(r.recording_id) : null,
      status: toString(r.status),
      executionId: r.execution_id ? toString(r.execution_id) : null,
      score: r.score_json ? (JSON.parse(toString(r.score_json)) as Record<string, unknown>) : null,
      output: r.output_json ? JSON.parse(toString(r.output_json)) : null,
      error: r.error ? toString(r.error) : null,
      durationMs: num(r.duration_ms),
      tokenInput: num(r.token_input),
      tokenOutput: num(r.token_output),
      tokenTotal: num(r.token_total),
      costUsd: num(r.cost_usd),
      verdict: r.verdict ? toString(r.verdict) : null,
      ...(withDetail ? { diff: r.diff_json ? (JSON.parse(toString(r.diff_json)) as unknown) : null } : {})
    };
  }

  async listEvalResults(runId: string): Promise<EvalResultRecord[]> {
    const rows = this.queryAll<EvalResultRow>(
      `SELECT id, run_id, fixture_id, fixture_name, status, execution_id,
              score_json, output_json, error, duration_ms, token_input, token_output, token_total,
              recording_id, verdict, NULL AS diff_json, cost_usd
       FROM eval_results WHERE run_id = ? ORDER BY created_at, rowid`,
      [runId]
    );
    return rows.map((r) => this.mapEvalResult(r, false));
  }

  /** Phase 15.2 — one case with its run diff. */
  async getEvalResult(runId: string, resultId: string): Promise<EvalResultRecord | null> {
    const row = this.queryOne<EvalResultRow>(
      `SELECT id, run_id, fixture_id, fixture_name, status, execution_id,
              score_json, output_json, error, duration_ms, token_input, token_output, token_total,
              recording_id, verdict, diff_json, cost_usd
       FROM eval_results WHERE run_id = ? AND id = ?`,
      [runId, resultId]
    );
    return row ? this.mapEvalResult(row, true) : null;
  }

  // ---------------------------------------------------------------------------
  // Phase 8.2 — usage_events (FinOps cost rollups)
  // ---------------------------------------------------------------------------

  async writeUsageEvent(input: {
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
  }): Promise<void> {
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
  async queryUsageRollup(input: {
    from: string;
    to: string;
    groupBy: "day" | "hour" | "workflow" | "user" | "project" | "provider";
    workflowId?: string;
    userId?: string;
    projectId?: string;
    limit?: number;
  }): Promise<Array<{
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
  }>> {
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
    const limit = clampLimit(input.limit, { fallback: 100, max: LIMIT_MAX.usageRollup });

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
  async queryUsageTotals(input: {
    from: string;
    to: string;
    workflowId?: string;
    userId?: string;
    userKey?: string;
    projectId?: string;
  }): Promise<{
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
  async listUsageEvents(input: { limit?: number; workflowId?: string; userId?: string; projectId?: string } = {}): Promise<Array<{
    id: string; executionId: string; workflowId: string; workflowName: string | null;
    userId: string | null; userEmail: string | null; projectId: string | null;
    triggerType: string | null; status: string;
    inputTokens: number; outputTokens: number; cachedInputTokens: number;
    totalTokens: number; costUsd: number; llmCallCount: number; durationMs: number;
    providers: Array<{ providerId: string; model: string; calls: number }>;
    createdAt: string;
  }>> {
    const filters: string[] = [];
    const params: Array<string | number> = [];
    if (input.workflowId) { filters.push("workflow_id = ?"); params.push(input.workflowId); }
    if (input.userId) { filters.push("user_id = ?"); params.push(input.userId); }
    if (input.projectId) { filters.push("project_id = ?"); params.push(input.projectId); }
    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    const limit = clampLimit(input.limit, { fallback: 50, max: LIMIT_MAX.usageEvents });
    const rows = this.queryAll<{
      id: string; execution_id: string; workflow_id: string; workflow_name: string | null;
      user_id: string | null; user_email: string | null; project_id: string | null;
      trigger_type: string | null; status: string;
      input_tokens: number; output_tokens: number; cached_input_tokens: number;
      total_tokens: number; cost_usd: number; llm_call_count: number; duration_ms: number;
      providers_json: string | null; created_at: string;
    }>(
      `SELECT * FROM usage_events ${where} ORDER BY created_at DESC, id DESC LIMIT ${limit}`,
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

  async createBudget(input: {
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
  }): Promise<void> {
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

  async updateBudget(id: string, patch: {
    name?: string;
    limitValue?: number;
    warnThresholdPct?: number;
    action?: "warn" | "block";
    notifyChannel?: string | null;
    enabled?: boolean;
  }): Promise<boolean> {
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

  async deleteBudget(id: string): Promise<boolean> {
    this.exec(`DELETE FROM budget_alerts WHERE budget_id = ?`, [id]);
    this.exec(`DELETE FROM budgets WHERE id = ?`, [id]);
    this.persist();
    return true;
  }

  async getBudget(id: string): Promise<BudgetRecord | null> {
    const row = this.queryOne<BudgetRow>(`SELECT * FROM budgets WHERE id = ?`, [id]);
    return row ? mapBudget(row) : null;
  }

  async listBudgets(filter: { enabledOnly?: boolean; scopeType?: string; scopeId?: string } = {}): Promise<BudgetRecord[]> {
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

  async recordBudgetAlert(input: {
    id: string;
    budgetId: string;
    periodStart: string;
    severity: "warn" | "block";
    usageValue: number;
    limitValue: number;
    workflowId?: string | null;
    executionId?: string | null;
    message?: string;
  }): Promise<boolean> {
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
    return true;
  }

  /**
   * Most recent alert for a (budget, period) pair. Used to debounce — we
   * only fire one warn / one block per period+budget combination so users
   * don't get spammed across every execution after a threshold is crossed.
   */
  async getLatestBudgetAlert(budgetId: string, periodStart: string, severity: "warn" | "block"): Promise<{ id: string; firedAt: string } | null> {
    const row = this.queryOne<{ id: string; fired_at: string }>(
      `SELECT id, fired_at FROM budget_alerts
       WHERE budget_id = ? AND period_start = ? AND severity = ?
       ORDER BY fired_at DESC, id DESC LIMIT 1`,
      [budgetId, periodStart, severity]
    );
    return row ? { id: toString(row.id), firedAt: toString(row.fired_at) } : null;
  }

  async listBudgetAlerts(filter: { budgetId?: string; limit?: number } = {}): Promise<Array<{
    id: string; budgetId: string; periodStart: string;
    severity: string; usageValue: number; limitValue: number;
    workflowId: string | null; executionId: string | null;
    message: string | null; firedAt: string;
  }>> {
    const filters: string[] = [];
    const params: Array<string | number> = [];
    if (filter.budgetId) { filters.push("budget_id = ?"); params.push(filter.budgetId); }
    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    const limit = clampLimit(filter.limit, { fallback: 100, max: LIMIT_MAX.budgetAlerts });
    const rows = this.queryAll<{
      id: string; budget_id: string; period_start: string;
      severity: string; usage_value: number; limit_value: number;
      workflow_id: string | null; execution_id: string | null;
      message: string | null; fired_at: string;
    }>(
      `SELECT * FROM budget_alerts ${where} ORDER BY fired_at DESC, id DESC LIMIT ${limit}`,
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

  async createAuditExportDestination(input: {
    id: string;
    name: string;
    kind: "http" | "file";
    config: Record<string, unknown>;
    intervalSeconds?: number;
    enabled?: boolean;
    createdBy?: string | null;
  }): Promise<void> {
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

  async updateAuditExportDestination(id: string, patch: {
    name?: string;
    config?: Record<string, unknown>;
    intervalSeconds?: number;
    enabled?: boolean;
  }): Promise<boolean> {
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

  async deleteAuditExportDestination(id: string): Promise<boolean> {
    this.exec(`DELETE FROM audit_export_runs WHERE destination_id = ?`, [id]);
    this.exec(`DELETE FROM audit_export_destinations WHERE id = ?`, [id]);
    this.persist();
    return true;
  }

  async listAuditExportDestinations(): Promise<Array<{
    id: string; name: string; kind: string; config: Record<string, unknown>;
    intervalSeconds: number; enabled: boolean;
    lastExportId: string | null; lastExportAt: string | null;
    lastStatus: string | null; lastError: string | null;
    createdBy: string | null; createdAt: string; updatedAt: string;
  }>> {
    return this.listAuditExportDestinationsSync();
  }

  private listAuditExportDestinationsSync(): Array<{
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

  async getAuditExportDestination(id: string) {
    return this.listAuditExportDestinationsSync().find((d) => d.id === id) ?? null;
  }

  /**
   * Pull audit_logs strictly newer than `cursor.id` (or all rows when cursor
   * is null). Used by AuditExportService to ship batches incrementally.
   * Ordered by (created_at, id) ASC so cursor-based pagination is stable
   * across concurrent inserts.
   */
  async listAuditLogsAfter(input: { afterId: string | null; limit: number }): Promise<Array<{
    id: string; eventType: string; category: string; action: string; outcome: string;
    actorUserId: string | null; actorEmail: string | null; actorType: string;
    resourceType: string | null; resourceId: string | null; projectId: string | null;
    ipAddress: string | null; userAgent: string | null; metadata: unknown;
    message: string | null; createdAt: string; entryHash: string | null;
  }>> {
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

  async recordAuditExportRun(input: {
    id: string;
    destinationId: string;
    startedAt: string;
    completedAt: string;
    status: "success" | "failure" | "partial";
    rowsExported: number;
    firstId?: string | null;
    lastId?: string | null;
    error?: string | null;
    cursorFrom?: string | null;
  }): Promise<void> {
    if (input.status === "success" && input.lastId && input.cursorFrom !== undefined) {
      const current = this.queryOne<{ last_export_id: unknown }>(`SELECT last_export_id FROM audit_export_destinations WHERE id = ?`, [input.destinationId]);
      const cursor = current?.last_export_id === null || current?.last_export_id === undefined ? null : toString(current.last_export_id);
      if (current && cursor !== input.cursorFrom) throw new AuditExportCursorMovedError(input.destinationId, input.cursorFrom);
    }
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

  async listAuditExportRuns(destinationId: string, limit = 25): Promise<Array<{
    id: string; destinationId: string; startedAt: string; completedAt: string | null;
    status: string; rowsExported: number; firstId: string | null; lastId: string | null;
    error: string | null;
  }>> {
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

  async createKnowledgeBase(input: {
    id: string;
    name: string;
    description?: string | null;
    projectId?: string | null;
    embedderId: string;
    embedderConfig?: Record<string, unknown>;
    dimensions?: number;
    createdBy?: string | null;
  }): Promise<void> {
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

  async updateKnowledgeBase(id: string, patch: {
    name?: string;
    description?: string | null;
    embedderConfig?: Record<string, unknown>;
    dimensions?: number;
  }): Promise<boolean> {
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

  async deleteKnowledgeBase(id: string): Promise<boolean> {
    this.exec(`DELETE FROM knowledge_base_chunks WHERE knowledge_base_id = ?`, [id]);
    this.exec(`DELETE FROM knowledge_bases WHERE id = ?`, [id]);
    this.persist();
    return true;
  }

  async getKnowledgeBase(id: string): Promise<KnowledgeBaseRecord | null> {
    return this.getKnowledgeBaseSync(id);
  }

  private getKnowledgeBaseSync(id: string): KnowledgeBaseRecord | null {
    const row = this.queryOne<KnowledgeBaseRow>(`SELECT * FROM knowledge_bases WHERE id = ?`, [id]);
    return row ? mapKnowledgeBase(row) : null;
  }

  async listKnowledgeBases(filter: { projectId?: string } = {}): Promise<KnowledgeBaseRecord[]> {
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
  async addKnowledgeBaseChunks(input: {
    knowledgeBaseId: string;
    chunks: Array<{
      id?: string;
      sourceId?: string | null;
      chunkIndex: number;
      content: string;
      metadata?: Record<string, unknown> | null;
      vector: number[];
    }>;
  }): Promise<{ inserted: number; dimensions: number }> {
    const kb = this.getKnowledgeBaseSync(input.knowledgeBaseId);
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
  async listKnowledgeBaseChunks(knowledgeBaseId: string): Promise<KnowledgeBaseChunkRecord[]> {
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
  async bm25SearchKnowledgeBase(input: {
    knowledgeBaseId: string;
    query: string;
    topK: number;
  }): Promise<Array<{
    id: string;
    sourceId: string | null;
    chunkIndex: number;
    content: string;
    metadata: Record<string, unknown> | null;
    score: number;
  }>> {
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
  async listKnowledgeBaseChunkPreviews(input: { knowledgeBaseId: string; limit?: number; sourceId?: string }): Promise<Array<{
    id: string; sourceId: string | null; chunkIndex: number; content: string;
    metadata: Record<string, unknown> | null; createdAt: string;
  }>> {
    const limit = clampLimit(input.limit, { fallback: 50, max: LIMIT_MAX.knowledgeBaseChunkPreviews });
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

  async deleteKnowledgeBaseChunksBySource(input: { knowledgeBaseId: string; sourceId: string }): Promise<number> {
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
  async listKnowledgeBaseSources(knowledgeBaseId: string): Promise<Array<{ sourceId: string; chunkCount: number }>> {
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

  async createMcpServer(input: {
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
  }): Promise<void> {
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

  async updateMcpServer(id: string, patch: {
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
  }): Promise<boolean> {
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

  async deleteMcpServer(id: string): Promise<boolean> {
    const existing = this.getMcpServerSync(id);
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
  async setMcpServerSandboxStatus(id: string, status: McpSandboxStatus | null): Promise<void> {
    this.exec(`UPDATE mcp_servers SET sandbox_status_json = ? WHERE id = ?`, [status ? JSON.stringify(status) : null, id]);
  }

  async getMcpServer(id: string): Promise<McpServerRecord | null> {
    return this.getMcpServerSync(id);
  }

  private getMcpServerSync(id: string): McpServerRecord | null {
    const row = this.queryOne<McpServerRow>(`SELECT * FROM mcp_servers WHERE id = ?`, [id]);
    return row ? mapMcpServer(row) : null;
  }

  /** With a projectId: that project's servers plus deployment-wide ones (no project). */
  async listMcpServers(filter: { projectId?: string } = {}): Promise<McpServerRecord[]> {
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
  async recordMcpServerProbe(input: {
    probe: McpServerProbeRecord;
    status: McpServerStatus;
    snapshot?: Omit<McpToolSnapshotRecord, "acknowledgedAt" | "acknowledgedBy">;
    keepProbes: number;
  }): Promise<void> {
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

  async listMcpServerProbes(serverId: string, limit = 100): Promise<McpServerProbeRecord[]> {
    return this.queryAll<McpServerProbeRow>(
      `SELECT * FROM mcp_server_probes WHERE server_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?`,
      [serverId, clampLimit(limit, { fallback: 100, max: LIMIT_MAX.mcpServerProbes })]
    ).map(mapMcpServerProbe);
  }

  async getMcpToolSnapshot(id: string): Promise<McpToolSnapshotRecord | null> {
    return this.getMcpToolSnapshotSync(id);
  }

  private getMcpToolSnapshotSync(id: string): McpToolSnapshotRecord | null {
    const row = this.queryOne<McpToolSnapshotRow>(`SELECT * FROM mcp_tool_snapshots WHERE id = ?`, [id]);
    return row ? mapMcpToolSnapshot(row) : null;
  }

  async listMcpToolSnapshots(serverId: string, limit = 50): Promise<McpToolSnapshotRecord[]> {
    return this.queryAll<McpToolSnapshotRow>(
      `SELECT * FROM mcp_tool_snapshots WHERE server_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      [serverId, clampLimit(limit, { fallback: 50, max: LIMIT_MAX.mcpToolSnapshots })]
    ).map(mapMcpToolSnapshot);
  }

  /** Accept the pending breaking change: unblocks runs until the next breaking diff. */
  async acknowledgeMcpBreakingChange(serverId: string, acknowledgedBy: string): Promise<McpToolSnapshotRecord | null> {
    const server = this.getMcpServerSync(serverId);
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
    return this.getMcpToolSnapshotSync(snapshotId);
  }

  /**
   * Replace the tool-call rows of one execution. Idempotent, so persisting the
   * same execution twice (for example after an approval resume) never
   * double-counts its calls.
   */
  async replaceMcpToolCallsForExecution(executionId: string, calls: McpToolCallWrite[]): Promise<void> {
    this.db.transaction(() => {
      // The gateway's own row for a workflow tool shares the execution id and is kept.
      this.exec(`DELETE FROM mcp_tool_calls WHERE execution_id = ? AND source = 'workflow'`, [executionId]);
      for (const call of calls) {
        this.insertMcpToolCallRow({ ...call, executionId });
      }
    })();
  }

  /** Phase 10.4 — one gateway call, recorded as it finishes. */
  async insertMcpToolCall(call: McpToolCallWrite): Promise<void> {
    this.insertMcpToolCallRow(call);
  }

  private insertMcpToolCallRow(call: McpToolCallWrite): void {
    this.exec(
      `INSERT INTO mcp_tool_calls (
         id, execution_id, workflow_id, node_id, registry_server_id, adapter_id, tool_name,
         started_at, duration_ms, ok, error, turn_input_tokens, turn_output_tokens,
         estimated_cost_usd, sampling_requests, sampling_input_tokens, sampling_output_tokens,
         source, client_id, rejection, policy_decision_json, args_summary_json, subject_role, subject_source, project_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        call.policyDecision ? JSON.stringify(call.policyDecision) : null,
        ...mcpToolCallContextValues(call),
        new Date().toISOString()
      ]
    );
  }

  /** Phase 10.4 — gateway calls one client made since `since`. */
  async listMcpToolCallsForClient(clientId: string, since: string): Promise<McpToolCallRecord[]> {
    return this.queryAll<McpToolCallRow>(
      `SELECT * FROM mcp_tool_calls WHERE client_id = ? AND started_at >= ? ORDER BY started_at`,
      [clientId, since]
    ).map(mapMcpToolCall);
  }

  /** Phase 10.4 — calls, errors and last call per client since `since`. */
  async summarizeMcpClientUsage(since: string): Promise<McpClientUsageRow[]> {
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
  async listMcpToolCalls(filter: { registryServerId: string | null; since: string }): Promise<McpToolCallRecord[]> {
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

  /** Phase 12.4 — one page of a tool-call window scan, newest first. */
  async scanMcpToolCalls(filter: McpToolCallScanFilter): Promise<McpToolCallRecord[]> {
    const { where, params } = mcpToolCallScanWhere(filter, () => "?", "id");
    const limit = clampLimit(filter.limit, { fallback: 1000, max: LIMIT_MAX.mcpToolCallScan });
    return this.queryAll<McpToolCallRow>(`SELECT * FROM mcp_tool_calls WHERE ${where} ORDER BY started_at DESC, id DESC LIMIT ${limit}`, params as BindParams).map(
      mapMcpToolCall
    );
  }

  async upsertOpenMcpPolicySuggestion(
    input: McpPolicySuggestionWrite
  ): Promise<{ suggestion: McpPolicySuggestion; outcome: "created" | "updated" | "unchanged" }> {
    return this.db.transaction(() => {
      const existing = this.queryOne<Record<string, unknown>>(
        `SELECT * FROM mcp_policy_suggestions WHERE scope_kind = ? AND scope_id = ? AND server_id = ? AND status = 'open'`,
        [input.scopeKind, input.scopeId, input.serverId]
      );
      const values = [
        input.scopeName,
        input.serverName,
        input.fingerprint,
        JSON.stringify(input.rules),
        JSON.stringify(input.evidence),
        input.windowDays,
        input.windowStart,
        input.windowEnd,
        input.callCount,
        input.now
      ];
      if (existing) {
        this.exec(
          `UPDATE mcp_policy_suggestions
              SET scope_name = ?, server_name = ?, fingerprint = ?, rules_json = ?, evidence_json = ?, window_days = ?,
                  window_start = ?, window_end = ?, call_count = ?, updated_at = ?
            WHERE id = ?`,
          [...values, String(existing.id)]
        );
        const row = this.queryOne<Record<string, unknown>>(`SELECT * FROM mcp_policy_suggestions WHERE id = ?`, [String(existing.id)])!;
        return { suggestion: mapMcpPolicySuggestion(row), outcome: existing.fingerprint === input.fingerprint ? ("unchanged" as const) : ("updated" as const) };
      }
      this.exec(
        `INSERT INTO mcp_policy_suggestions (
           id, scope_kind, scope_id, server_id, status, created_by, created_at,
           scope_name, server_name, fingerprint, rules_json, evidence_json, window_days, window_start, window_end, call_count, updated_at
         ) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.id, input.scopeKind, input.scopeId, input.serverId, input.createdBy, input.now, ...values]
      );
      const row = this.queryOne<Record<string, unknown>>(`SELECT * FROM mcp_policy_suggestions WHERE id = ?`, [input.id])!;
      return { suggestion: mapMcpPolicySuggestion(row), outcome: "created" as const };
    })();
  }

  async listDecidedMcpPolicySuggestions(filter: {
    scopeKind: "workflow" | "client";
    scopeId: string;
    serverId: string;
    fingerprint: string;
  }): Promise<McpPolicySuggestion[]> {
    return this.queryAll<Record<string, unknown>>(
      `SELECT * FROM mcp_policy_suggestions
        WHERE scope_kind = ? AND scope_id = ? AND server_id = ? AND fingerprint = ? AND status <> 'open'
        ORDER BY created_at DESC, id DESC`,
      [filter.scopeKind, filter.scopeId, filter.serverId, filter.fingerprint]
    ).map(mapMcpPolicySuggestion);
  }

  async listMcpPolicySuggestions(filter: { status?: McpPolicySuggestionStatus; limit?: number } = {}): Promise<McpPolicySuggestion[]> {
    const limit = clampLimit(filter.limit, { fallback: 200, max: LIMIT_MAX.mcpPolicySuggestions });
    const rows = filter.status
      ? this.queryAll<Record<string, unknown>>(`SELECT * FROM mcp_policy_suggestions WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ${limit}`, [filter.status])
      : this.queryAll<Record<string, unknown>>(`SELECT * FROM mcp_policy_suggestions ORDER BY created_at DESC, id DESC LIMIT ${limit}`);
    return rows.map(mapMcpPolicySuggestion);
  }

  async getMcpPolicySuggestion(id: string): Promise<McpPolicySuggestion | null> {
    const row = this.queryOne<Record<string, unknown>>(`SELECT * FROM mcp_policy_suggestions WHERE id = ?`, [id]);
    return row ? mapMcpPolicySuggestion(row) : null;
  }

  async transitionMcpPolicySuggestion(
    id: string,
    input: { from: McpPolicySuggestionStatus; to: McpPolicySuggestionStatus; decidedBy: string | null; decidedAt: string | null; acceptedRuleIds?: string[] }
  ): Promise<McpPolicySuggestion | null> {
    return this.db.transaction(() => {
      const accepted = input.acceptedRuleIds === undefined ? null : JSON.stringify(input.acceptedRuleIds);
      const result = this.db
        .prepare(
          `UPDATE mcp_policy_suggestions
              SET status = ?, decided_by = ?, decided_at = ?, updated_at = ?,
                  accepted_rule_ids_json = COALESCE(?, accepted_rule_ids_json)
            WHERE id = ? AND status = ?`
        )
        .run(input.to, input.decidedBy, input.decidedAt, input.decidedAt ?? new Date().toISOString(), accepted, id, input.from);
      if (result.changes === 0) return null;
      const row = this.queryOne<Record<string, unknown>>(`SELECT * FROM mcp_policy_suggestions WHERE id = ?`, [id]);
      return row ? mapMcpPolicySuggestion(row) : null;
    })();
  }

  // ---------------------------------------------------------------------------
  // Phase 10.2 — MCP tool policy
  // ---------------------------------------------------------------------------

  // Phase 10.5 — OAuth connection status rows (no tokens).

  async getMcpOAuthConnection(serverId: string): Promise<McpOAuthConnectionRecord | null> {
    return this.getMcpOAuthConnectionSync(serverId);
  }

  private getMcpOAuthConnectionSync(serverId: string): McpOAuthConnectionRecord | null {
    const row = this.queryOne<McpOAuthConnectionRow>(`SELECT * FROM mcp_oauth_connections WHERE server_id = ?`, [serverId]);
    return row ? mapMcpOAuthConnection(row) : null;
  }

  async upsertMcpOAuthConnection(record: Omit<McpOAuthConnectionRecord, "updatedAt">): Promise<McpOAuthConnectionRecord> {
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
    return this.getMcpOAuthConnectionSync(record.serverId)!;
  }

  // Phase 10.7 — per-user OAuth connections to delegated servers (no tokens).

  async getMcpUserOAuthConnection(serverId: string, userId: string): Promise<McpUserOAuthConnectionRecord | null> {
    return this.getMcpUserOAuthConnectionSync(serverId, userId);
  }

  private getMcpUserOAuthConnectionSync(serverId: string, userId: string): McpUserOAuthConnectionRecord | null {
    const row = this.queryOne<McpUserOAuthConnectionRow>(
      `SELECT * FROM mcp_user_oauth_connections WHERE server_id = ? AND user_id = ?`,
      [serverId, userId]
    );
    return row ? mapMcpUserOAuthConnection(row) : null;
  }

  async listMcpUserOAuthConnections(filter: { serverId?: string; userId?: string } = {}): Promise<McpUserOAuthConnectionRecord[]> {
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

  async upsertMcpUserOAuthConnection(record: Omit<McpUserOAuthConnectionRecord, "updatedAt">): Promise<McpUserOAuthConnectionRecord> {
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
    return this.getMcpUserOAuthConnectionSync(record.serverId, record.userId)!;
  }

  async deleteMcpUserOAuthConnection(serverId: string, userId: string): Promise<boolean> {
    if (!this.getMcpUserOAuthConnectionSync(serverId, userId)) return false;
    this.exec(`DELETE FROM mcp_user_oauth_connections WHERE server_id = ? AND user_id = ?`, [serverId, userId]);
    return true;
  }

  async deleteMcpOAuthConnection(serverId: string): Promise<boolean> {
    if (!this.getMcpOAuthConnectionSync(serverId)) return false;
    this.exec(`DELETE FROM mcp_oauth_connections WHERE server_id = ?`, [serverId]);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Phase 10.5 — server catalogs (resources, templates, prompts) and elicitations
  // ---------------------------------------------------------------------------

  async getMcpServerCatalog(serverId: string): Promise<McpServerCatalogRecord | null> {
    return this.getMcpServerCatalogSync(serverId);
  }

  private getMcpServerCatalogSync(serverId: string): McpServerCatalogRecord | null {
    const row = this.queryOne<McpServerCatalogRow>(`SELECT * FROM mcp_server_catalogs WHERE server_id = ?`, [serverId]);
    return row ? mapMcpServerCatalog(row) : null;
  }

  async upsertMcpServerCatalog(serverId: string, catalog: Omit<McpServerCatalog, "updatedAt">): Promise<McpServerCatalogRecord> {
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
    return this.getMcpServerCatalogSync(serverId)!;
  }

  async createMcpElicitation(input: Omit<McpElicitationRecord, "status" | "createdAt" | "answeredAt" | "answeredBy" | "reason">): Promise<McpElicitationRecord> {
    this.exec(
      `INSERT INTO mcp_elicitations (
         id, execution_id, workflow_id, workflow_name, node_id, server_id, registry_server_id, server_name,
         tool_name, message, schema_json, status, created_at, expires_at, created_by, trigger_type, holder_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
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
        input.triggerType ?? null,
        input.holderId ?? null
      ]
    );
    return this.getMcpElicitationSync(input.id)!;
  }

  async getMcpElicitation(id: string): Promise<McpElicitationRecord | null> {
    return this.getMcpElicitationSync(id);
  }

  private getMcpElicitationSync(id: string): McpElicitationRecord | null {
    const row = this.queryOne<McpElicitationRow>(`SELECT * FROM mcp_elicitations WHERE id = ?`, [id]);
    return row ? mapMcpElicitation(row) : null;
  }

  async listMcpElicitations(filter: { status?: McpElicitationStatus; executionId?: string; limit?: number } = {}): Promise<McpElicitationRecord[]> {
    return this.listMcpElicitationsSync(filter);
  }

  private listMcpElicitationsSync(filter: { status?: McpElicitationStatus; executionId?: string; limit?: number } = {}): McpElicitationRecord[] {
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
  async settleMcpElicitation(id: string, outcome: { status: Exclude<McpElicitationStatus, "pending">; answeredBy?: string | null; reason?: string | null }): Promise<boolean> {
    return this.settleMcpElicitationSync(id, outcome);
  }

  private settleMcpElicitationSync(
    id: string,
    outcome: { status: Exclude<McpElicitationStatus, "pending">; answeredBy?: string | null; reason?: string | null }
  ): boolean {
    const current = this.getMcpElicitationSync(id);
    if (!current || current.status !== "pending") return false;
    this.exec(
      `UPDATE mcp_elicitations SET status = ?, answered_at = ?, answered_by = ?, reason = ? WHERE id = ? AND status = 'pending'`,
      [outcome.status, new Date().toISOString(), outcome.answeredBy ?? null, outcome.reason ?? null, id]
    );
    return true;
  }

  /** Mark every pending elicitation of an execution as expired (the run ended or the API restarted). */
  async expireMcpElicitationsForExecution(executionId: string, reason: string): Promise<number> {
    const pending = this.listMcpElicitationsSync({ status: "pending", executionId, limit: 500 });
    for (const entry of pending) {
      this.settleMcpElicitationSync(entry.id, { status: "expired", reason });
    }
    return pending.length;
  }

  /** Pending elicitations whose deadline passed; the elicitation service expires them. */
  async listExpiredMcpElicitations(now: string): Promise<McpElicitationRecord[]> {
    return this.queryAll<McpElicitationRow>(`SELECT * FROM mcp_elicitations WHERE status = 'pending' AND expires_at <= ?`, [now]).map(
      mapMcpElicitation
    );
  }

  /** Rules in evaluation order: oldest first. */
  async listMcpToolPolicies(): Promise<McpToolPolicyRule[]> {
    return this.queryAll<McpToolPolicyRow>(`SELECT * FROM mcp_tool_policies ORDER BY created_at ASC, rowid ASC`).map(
      mapMcpToolPolicy
    );
  }

  async getMcpToolPolicy(id: string): Promise<McpToolPolicyRule | null> {
    return this.getMcpToolPolicySync(id);
  }

  private getMcpToolPolicySync(id: string): McpToolPolicyRule | null {
    const row = this.queryOne<McpToolPolicyRow>(`SELECT * FROM mcp_tool_policies WHERE id = ?`, [id]);
    return row ? mapMcpToolPolicy(row) : null;
  }

  async createMcpToolPolicy(input: Omit<McpToolPolicyRule, "createdAt" | "updatedAt">): Promise<McpToolPolicyRule> {
    const now = new Date().toISOString();
    this.exec(
      `INSERT INTO mcp_tool_policies (
         id, name, description, effect, project_id, roles_json, server_id, tool_pattern, annotation_hint, kind, enabled,
         conditions_json, mode, workflow_ids_json, client_ids_json, created_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.conditions ? JSON.stringify(input.conditions) : null,
        input.mode ?? "enforce",
        JSON.stringify(input.workflowIds ?? []),
        JSON.stringify(input.clientIds ?? []),
        input.createdBy ?? null,
        now,
        now
      ]
    );
    return this.getMcpToolPolicySync(input.id)!;
  }

  async updateMcpToolPolicy(id: string, patch: McpToolPolicyPatch): Promise<McpToolPolicyRule | null> {
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
    if (patch.conditions !== undefined) { fields.push("conditions_json = ?"); params.push(patch.conditions ? JSON.stringify(patch.conditions) : null); }
    if (patch.mode !== undefined) { fields.push("mode = ?"); params.push(patch.mode ?? "enforce"); }
    if (patch.workflowIds !== undefined) { fields.push("workflow_ids_json = ?"); params.push(JSON.stringify(patch.workflowIds ?? [])); }
    if (patch.clientIds !== undefined) { fields.push("client_ids_json = ?"); params.push(JSON.stringify(patch.clientIds ?? [])); }
    if (fields.length > 0) {
      fields.push("updated_at = ?");
      params.push(new Date().toISOString());
      params.push(id);
      this.exec(`UPDATE mcp_tool_policies SET ${fields.join(", ")} WHERE id = ?`, params);
    }
    return this.getMcpToolPolicySync(id);
  }

  async deleteMcpToolPolicy(id: string): Promise<boolean> {
    if (!this.getMcpToolPolicySync(id)) return false;
    this.exec(`DELETE FROM mcp_tool_policies WHERE id = ?`, [id]);
    return true;
  }

  // Phase 12.4 — gateway approvals.

  async createMcpGatewayApproval(
    input: McpGatewayApprovalCreate,
    now: string,
    options: { maxPendingPerClient?: number } = {}
  ): Promise<McpGatewayApprovalCreateResult> {
    return this.db.transaction((): McpGatewayApprovalCreateResult => {
      this.sweepMcpGatewayApprovals(now);
      const existing = this.queryOne<Record<string, unknown>>(
        `SELECT * FROM mcp_gateway_approvals WHERE client_id = ? AND server_id = ? AND tool_name = ? AND args_hash = ? AND status = 'pending'`,
        [input.clientId, input.serverId, input.toolName, input.argsHash]
      );
      if (existing) return { approval: mapMcpGatewayApproval(existing), created: false };
      if (options.maxPendingPerClient !== undefined) {
        const pending = this.queryOne<{ count: number }>(
          `SELECT COUNT(*) AS count FROM mcp_gateway_approvals WHERE client_id = ? AND status = 'pending'`,
          [input.clientId]
        );
        if (Number(pending?.count ?? 0) >= options.maxPendingPerClient) return { approval: null, created: false, capped: true };
      }
      this.exec(
        `INSERT INTO mcp_gateway_approvals (
           id, client_id, client_name, toolset_id, project_id, server_id, server_name, tool_name, gateway_tool_name,
           args_hash, args_preview, rule_id, rule_name, message, status, requested_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        [
          input.id,
          input.clientId,
          input.clientName,
          input.toolsetId,
          input.projectId,
          input.serverId,
          input.serverName,
          input.toolName,
          input.gatewayToolName,
          input.argsHash,
          input.argsPreview,
          input.ruleId,
          input.ruleName,
          input.message,
          input.requestedAt,
          input.expiresAt
        ]
      );
      return { approval: this.getMcpGatewayApprovalSync(input.id)!, created: true };
    })();
  }

  /** Phase 12.4 — expires pending requests past their expiry and deletes decided ones past the retention. */
  private sweepMcpGatewayApprovals(now: string): void {
    this.exec(`UPDATE mcp_gateway_approvals SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?`, [now]);
    const cutoff = mcpGatewayApprovalRetentionCutoff(now);
    this.exec(`DELETE FROM mcp_gateway_approvals WHERE status <> 'pending' AND requested_at < ? AND expires_at < ?`, [cutoff, cutoff]);
  }

  private getMcpGatewayApprovalSync(id: string): McpGatewayApproval | null {
    const row = this.queryOne<Record<string, unknown>>(`SELECT * FROM mcp_gateway_approvals WHERE id = ?`, [id]);
    return row ? mapMcpGatewayApproval(row) : null;
  }

  async getMcpGatewayApproval(id: string): Promise<McpGatewayApproval | null> {
    return this.getMcpGatewayApprovalSync(id);
  }

  async listMcpGatewayApprovals(filter: { status?: McpGatewayApproval["status"]; limit?: number }, now: string): Promise<McpGatewayApproval[]> {
    this.sweepMcpGatewayApprovals(now);
    const limit = Math.max(1, Math.min(500, filter.limit ?? 200));
    const rows = filter.status
      ? this.queryAll<Record<string, unknown>>(
          `SELECT * FROM mcp_gateway_approvals WHERE status = ? ORDER BY requested_at DESC, id DESC LIMIT ?`,
          [filter.status, limit]
        )
      : this.queryAll<Record<string, unknown>>(`SELECT * FROM mcp_gateway_approvals ORDER BY requested_at DESC, id DESC LIMIT ?`, [limit]);
    return rows.map(mapMcpGatewayApproval);
  }

  async findUsableMcpGatewayApproval(call: McpGatewayApprovalCallKey, now: string): Promise<McpGatewayApproval | null> {
    const row = this.queryOne<Record<string, unknown>>(
      `SELECT * FROM mcp_gateway_approvals
        WHERE client_id = ? AND server_id = ? AND tool_name = ? AND args_hash = ? AND status = 'approved' AND expires_at > ?
        ORDER BY decided_at ASC, id ASC LIMIT 1`,
      [call.clientId, call.serverId, call.toolName, call.argsHash, now]
    );
    return row ? mapMcpGatewayApproval(row) : null;
  }

  async consumeMcpGatewayApproval(id: string, now: string): Promise<boolean> {
    const result = this.db
      .prepare(`UPDATE mcp_gateway_approvals SET status = 'used', used_at = ? WHERE id = ? AND status = 'approved' AND expires_at > ?`)
      .run(now, id, now);
    return result.changes > 0;
  }

  async restoreMcpGatewayApproval(id: string): Promise<boolean> {
    const result = this.db.prepare(`UPDATE mcp_gateway_approvals SET status = 'approved', used_at = NULL WHERE id = ? AND status = 'used'`).run(id);
    return result.changes > 0;
  }

  async findBlockingMcpGatewayRejection(
    call: McpGatewayApprovalCallKey,
    now: string
  ): Promise<{ approval: McpGatewayApproval; firstRefusal: boolean } | null> {
    return this.db.transaction(() => {
      const row = this.queryOne<Record<string, unknown>>(
        `SELECT * FROM mcp_gateway_approvals
          WHERE client_id = ? AND server_id = ? AND tool_name = ? AND args_hash = ? AND status = 'rejected' AND expires_at > ?
          ORDER BY decided_at DESC, id DESC LIMIT 1`,
        [call.clientId, call.serverId, call.toolName, call.argsHash, now]
      );
      if (!row) return null;
      const marked = this.db.prepare(`UPDATE mcp_gateway_approvals SET used_at = ? WHERE id = ? AND used_at IS NULL`).run(now, String(row.id));
      return { approval: this.getMcpGatewayApprovalSync(String(row.id))!, firstRefusal: marked.changes > 0 };
    })();
  }

  async decideMcpGatewayApproval(
    id: string,
    decision: { status: "approved" | "rejected"; decidedBy: string; decidedAt: string; reason: string | null; expiresAt: string },
    now: string
  ): Promise<boolean> {
    const result = this.db
      .prepare(
        `UPDATE mcp_gateway_approvals SET status = ?, decided_by = ?, decided_at = ?, decision_reason = ?, expires_at = ?
          WHERE id = ? AND status = 'pending' AND expires_at > ?`
      )
      .run(decision.status, decision.decidedBy, decision.decidedAt, decision.reason, decision.expiresAt, id, now);
    return result.changes > 0;
  }

  /** Admin read-only overrides; all of them, or one registry server's. */
  async listMcpToolClassifications(registryServerId?: string): Promise<McpToolClassificationOverride[]> {
    const rows = registryServerId
      ? this.queryAll<McpToolClassificationRow>(
          `SELECT * FROM mcp_tool_classifications WHERE server_id = ? ORDER BY tool_name`,
          [registryServerId]
        )
      : this.queryAll<McpToolClassificationRow>(`SELECT * FROM mcp_tool_classifications ORDER BY server_id, tool_name`);
    return rows.map(mapMcpToolClassification);
  }

  /** `readOnly: null` removes the override, so annotations decide again. */
  async setMcpToolClassification(input: {
    registryServerId: string;
    toolName: string;
    readOnly: boolean | null;
    setBy: string | null;
  }): Promise<McpToolClassificationOverride | null> {
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

  async listMcpToolsets(): Promise<McpToolset[]> {
    return this.queryAll<McpToolsetRow>(`SELECT * FROM mcp_toolsets ORDER BY name COLLATE NOCASE, slug`).map((row) =>
      mapMcpToolset(row, this.listMcpToolsetMembers(toString(row.id)))
    );
  }

  async getMcpToolset(id: string): Promise<McpToolset | null> {
    return this.getMcpToolsetSync(id);
  }

  private getMcpToolsetSync(id: string): McpToolset | null {
    const row = this.queryOne<McpToolsetRow>(`SELECT * FROM mcp_toolsets WHERE id = ?`, [id]);
    return row ? mapMcpToolset(row, this.listMcpToolsetMembers(toString(row.id))) : null;
  }

  async getMcpToolsetBySlug(slug: string): Promise<McpToolset | null> {
    const row = this.queryOne<McpToolsetRow>(`SELECT * FROM mcp_toolsets WHERE slug = ?`, [slug]);
    return row ? mapMcpToolset(row, this.listMcpToolsetMembers(toString(row.id))) : null;
  }

  async createMcpToolset(input: {
    id: string;
    slug: string;
    name: string;
    description: string | null;
    projectId: string | null;
    enabled: boolean;
    createdBy: string | null;
    members: McpToolsetMemberSpec[];
  }): Promise<McpToolset> {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.exec(
        `INSERT INTO mcp_toolsets (id, slug, name, description, project_id, enabled, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.id, input.slug, input.name, input.description, input.projectId, input.enabled ? 1 : 0, input.createdBy, now, now]
      );
      this.writeMcpToolsetMembers(input.id, input.members);
    })();
    return this.getMcpToolsetSync(input.id)!;
  }

  async updateMcpToolset(
    id: string,
    patch: {
      slug?: string;
      name?: string;
      description?: string | null;
      projectId?: string | null;
      enabled?: boolean;
      members?: Array<McpToolsetMemberSpec & { id?: string }>;
    }
  ): Promise<McpToolset | null> {
    if (!this.getMcpToolsetSync(id)) return null;
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
    return this.getMcpToolsetSync(id);
  }

  /** Deletes the toolset and its members, and drops it from every client's scope. */
  async deleteMcpToolset(id: string): Promise<boolean> {
    if (!this.getMcpToolsetSync(id)) return false;
    this.db.transaction(() => {
      this.exec(`DELETE FROM mcp_toolset_members WHERE toolset_id = ?`, [id]);
      this.exec(`DELETE FROM mcp_toolsets WHERE id = ?`, [id]);
      for (const client of this.listMcpClientsSync()) {
        if (!client.toolsetIds.includes(id)) continue;
        this.exec(`UPDATE mcp_clients SET toolset_ids_json = ? WHERE id = ?`, [
          JSON.stringify(client.toolsetIds.filter((entry) => entry !== id)),
          client.id
        ]);
      }
    })();
    return true;
  }

  async createMcpClient(input: {
    id: string;
    name: string;
    tokenPrefix: string;
    tokenHash: string;
    toolsetIds: string[];
    role: McpPolicyRole;
    createdBy: string | null;
    createdByEmail: string | null;
    expiresAt: string | null;
  }): Promise<McpClient> {
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
    return this.getMcpClientSync(input.id)!;
  }

  /** Without the token hash. */
  async getMcpClient(id: string): Promise<McpClient | null> {
    return this.getMcpClientSync(id);
  }

  private getMcpClientSync(id: string): McpClient | null {
    const row = this.queryOne<McpClientRow>(`SELECT * FROM mcp_clients WHERE id = ?`, [id]);
    if (!row) return null;
    const { tokenHash: _hash, ...client } = mapMcpClient(row);
    return client;
  }

  /** With the token hash; for the credential check only. */
  async findMcpClientByTokenPrefix(prefix: string): Promise<McpClientSecretRecord | null> {
    const row = this.queryOne<McpClientRow>(`SELECT * FROM mcp_clients WHERE token_prefix = ?`, [prefix]);
    return row ? mapMcpClient(row) : null;
  }

  async listMcpClients(): Promise<McpClient[]> {
    return this.listMcpClientsSync();
  }

  private listMcpClientsSync(): McpClient[] {
    return this.queryAll<McpClientRow>(`SELECT * FROM mcp_clients ORDER BY created_at DESC, rowid DESC`).map((row) => {
      const { tokenHash: _hash, ...client } = mapMcpClient(row);
      return client;
    });
  }

  async revokeMcpClient(id: string): Promise<McpClient | null> {
    const existing = this.getMcpClientSync(id);
    if (!existing) return null;
    if (!existing.revokedAt) {
      this.exec(`UPDATE mcp_clients SET revoked_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
    }
    return this.getMcpClientSync(id);
  }

  async touchMcpClient(id: string, at: string): Promise<void> {
    this.exec(`UPDATE mcp_clients SET last_used_at = ? WHERE id = ?`, [at, id]);
  }

  // ---------------------------------------------------------------------------
  // Phase 10.8 — MCP cassettes
  // ---------------------------------------------------------------------------

  async saveMcpCassette(input: {
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
  }): Promise<McpCassetteSummary> {
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
    return this.getMcpCassetteSummarySync(input.id)!;
  }

  async getMcpCassetteSummary(id: string): Promise<McpCassetteSummary | null> {
    return this.getMcpCassetteSummarySync(id);
  }

  private getMcpCassetteSummarySync(id: string): McpCassetteSummary | null {
    const row = this.queryOne<McpCassetteRow>(`SELECT ${MCP_CASSETTE_SUMMARY_COLUMNS} FROM mcp_cassettes WHERE id = ?`, [id]);
    return row ? mapMcpCassetteSummary(row) : null;
  }

  async getMcpCassette(id: string): Promise<McpCassetteRecord | null> {
    return this.getMcpCassetteSync(id);
  }

  private getMcpCassetteSync(id: string): McpCassetteRecord | null {
    const row = this.queryOne<McpCassetteRow>(`SELECT * FROM mcp_cassettes WHERE id = ?`, [id]);
    if (!row) return null;
    return { ...mapMcpCassetteSummary(row), cassette: safeJsonParse(toString(row.cassette_json)) as McpCassette };
  }

  /** The newest cassette recorded for an execution. */
  async getMcpCassetteForExecution(executionId: string): Promise<McpCassetteRecord | null> {
    const row = this.queryOne<{ id: string }>(
      `SELECT id FROM mcp_cassettes WHERE execution_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      [executionId]
    );
    return row ? this.getMcpCassetteSync(toString(row.id)) : null;
  }

  /** Cassettes an eval run recorded, keyed by fixture id. */
  async listMcpCassettesForEvalRun(evalRunId: string): Promise<McpCassetteSummary[]> {
    return this.queryAll<McpCassetteRow>(
      `SELECT ${MCP_CASSETTE_SUMMARY_COLUMNS} FROM mcp_cassettes WHERE eval_run_id = ? ORDER BY created_at ASC, rowid ASC`,
      [evalRunId]
    ).map(mapMcpCassetteSummary);
  }

  async listMcpCassettes(options: { workflowId?: string; projectId?: string; evalRunId?: string; workflowIds?: string[]; limit?: number; offset?: number } = {}): Promise<{
    items: McpCassetteSummary[];
    total: number;
  }> {
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
  async mcpCassetteBadgesForExecutions(executionIds: string[]): Promise<Map<string, McpCassetteBadge>> {
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

  async deleteMcpCassette(id: string): Promise<boolean> {
    return this.deleteMcpCassetteSync(id);
  }

  private deleteMcpCassetteSync(id: string): boolean {
    const existing = this.getMcpCassetteSummarySync(id);
    if (!existing) return false;
    this.exec(`DELETE FROM mcp_cassettes WHERE id = ?`, [id]);
    return true;
  }

  // -------------------------------------------------------------------------
  // Phase 12.1 — Guard profiles, bindings, events and the token vault.
  // -------------------------------------------------------------------------

  async listGuardProfiles(): Promise<GuardProfileRecord[]> {
    return this.queryAll<GuardProfileRow>(
      `SELECT p.*, v.hash AS latest_hash FROM guard_profiles p
         LEFT JOIN guard_profile_versions v ON v.profile_id = p.id AND v.version = p.latest_version
       ORDER BY p.built_in DESC, p.name COLLATE NOCASE ASC`
    ).map(mapGuardProfileRow);
  }

  async getGuardProfile(id: string): Promise<GuardProfileRecord | null> {
    return this.getGuardProfileSync(id);
  }

  private getGuardProfileSync(id: string): GuardProfileRecord | null {
    const row = this.queryOne<GuardProfileRow>(
      `SELECT p.*, v.hash AS latest_hash FROM guard_profiles p
         LEFT JOIN guard_profile_versions v ON v.profile_id = p.id AND v.version = p.latest_version
       WHERE p.id = ?`,
      [id]
    );
    return row ? mapGuardProfileRow(row) : null;
  }

  private guardProfileRevisionStatement: { pluck(): { get(): unknown } } | null = null;
  private guardProfileLabelsCache: { revision: number; value: boolean } | null = null;

  /**
   * Phase 16 — the guard profile revision: a counter in the database that
   * triggers bump on every write to `guard_profiles` or
   * `guard_profile_versions`, whichever connection or process made it. Caches
   * of profile contents key on it, read once per use (one primary-key read),
   * so a profile saved by another instance is seen by the next run here.
   */
  async guardProfileRevision(): Promise<number | undefined> {
    return this.guardProfileRevisionSync();
  }

  private guardProfileRevisionSync(): number | undefined {
    // No revision (the row is missing) or a transaction open on this connection (it may hold uncommitted profile
    // writes that a rollback would undo): undefined, and callers read the database instead of their caches.
    if ((this.db as unknown as { inTransaction?: boolean }).inTransaction) return undefined;
    this.guardProfileRevisionStatement ??= this.db.prepare(`SELECT revision FROM guard_profile_revision WHERE id = 1`) as unknown as {
      pluck(): { get(): unknown };
    };
    const value = this.guardProfileRevisionStatement.pluck().get();
    return value === undefined || value === null ? undefined : Number(value);
  }

  /**
   * Phase 16 — whether any stored version of any guard profile asks for
   * propagated labels, has destination rules or an egress channel (all of
   * which make a run track labels), read from the stored JSON with SQLite's
   * JSON functions (key order and formatting do not matter). Cached per guard
   * profile revision (read from the database each call), so a run checks it
   * with one primary-key read and a profile written by any instance is seen
   * at once.
   */
  async anyGuardProfileUsesLabels(): Promise<boolean> {
    const revision = this.guardProfileRevisionSync();
    if (revision !== undefined && this.guardProfileLabelsCache?.revision === revision) return this.guardProfileLabelsCache.value;
    // Read as JSON (not as text), so key order and formatting never matter: labels propagated, at least one
    // destination rule, or an egress channel.
    const row = this.queryOne<{ found: number }>(
      `SELECT 1 AS found FROM guard_profile_versions
        WHERE json_valid(document_json) AND (
          json_extract(document_json, '$.labels') = 'propagated'
          OR COALESCE(json_array_length(document_json, '$.destinations.rules'), 0) > 0
          OR json_type(document_json, '$.channels.egress') = 'object'
        )
        LIMIT 1`
    );
    const value = Boolean(row);
    if (revision !== undefined) this.guardProfileLabelsCache = { revision, value };
    return value;
  }

  /**
   * Phase 16 — observed destination verdicts that would have stopped content:
   * verdicts since `since` with a shadow destination-rule finding of this
   * profile whose action blocks, waits for review or for approval. One per
   * verdict (a verdict with several such findings counts once). Replays,
   * release-gate cases and eval runs are not traffic: they are left out.
   */
  async countObservedDestinationBlocks(profileId: string, since: string): Promise<number> {
    const row = this.queryOne<{ total: number }>(
      `SELECT COUNT(DISTINCT verdict_id) AS total FROM guard_events
        WHERE profile_id = ? AND detector_id = '<destinations>' AND shadow = 1
          AND effective_action IN ('block', 'review', 'require_approval') AND created_at >= ?
          AND execution_id NOT IN (SELECT id FROM execution_history WHERE trigger_type IN (${SUBJECT_EXECUTION_TRIGGERS.map(() => "?").join(", ")}))`,
      [profileId, since, ...SUBJECT_EXECUTION_TRIGGERS]
    );
    return Number(row?.total ?? 0);
  }

  /** One version of a profile; the latest when `version` is omitted. */
  async getGuardProfileVersion(profileId: string, version?: number): Promise<GuardProfileVersionRecord | null> {
    return this.getGuardProfileVersionSync(profileId, version);
  }

  private getGuardProfileVersionSync(profileId: string, version?: number): GuardProfileVersionRecord | null {
    const row =
      version === undefined
        ? this.queryOne<GuardProfileVersionRow>(
            `SELECT v.* FROM guard_profile_versions v JOIN guard_profiles p ON p.id = v.profile_id AND p.latest_version = v.version WHERE v.profile_id = ?`,
            [profileId]
          )
        : this.queryOne<GuardProfileVersionRow>(`SELECT * FROM guard_profile_versions WHERE profile_id = ? AND version = ?`, [profileId, version]);
    return row ? mapGuardProfileVersionRow(row) : null;
  }

  async listGuardProfileVersions(profileId: string): Promise<GuardProfileVersionRecord[]> {
    return this.queryAll<GuardProfileVersionRow>(`SELECT * FROM guard_profile_versions WHERE profile_id = ? ORDER BY version DESC`, [profileId]).map(
      mapGuardProfileVersionRow
    );
  }

  /** Creates a profile with its first version. */
  async insertGuardProfile(input: {
    id: string;
    name: string;
    description?: string | null;
    builtIn?: boolean;
    document: Record<string, unknown>;
    hash: string;
    note?: string | null;
    createdBy: string | null;
  }, options: { ifAbsent?: boolean } = {}): Promise<GuardProfileRecord> {
    // One process owns the file, so a check and the insert cannot interleave with another seed.
    const existing = options.ifAbsent ? this.getGuardProfileSync(input.id) : null;
    if (existing) return existing;
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
    return this.getGuardProfileSync(input.id)!;
  }

  /** Appends an immutable version and makes it the latest. */
  async addGuardProfileVersion(input: {
    profileId: string;
    name: string;
    description?: string | null;
    document: Record<string, unknown>;
    hash: string;
    note?: string | null;
    createdBy: string | null;
  }, options: { unlessLatestHash?: boolean } = {}): Promise<GuardProfileVersionRecord> {
    const current = this.getGuardProfileSync(input.profileId);
    if (!current) throw new Error(`Guard profile '${input.profileId}' not found`);
    if (options.unlessLatestHash) {
      const latest = this.getGuardProfileVersionSync(input.profileId, current.latestVersion);
      if (latest && latest.hash === input.hash) return latest;
    }
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
    return this.getGuardProfileVersionSync(input.profileId, version)!;
  }

  async deleteGuardProfile(id: string): Promise<boolean> {
    if (!this.getGuardProfileSync(id)) return false;
    this.exec(`DELETE FROM guard_profile_versions WHERE profile_id = ?`, [id]);
    this.exec(`DELETE FROM guard_profiles WHERE id = ?`, [id]);
    this.persist();
    return true;
  }

  async getGuardBinding(scope: GuardBindingScope, scopeId: string): Promise<GuardBindingRecord | null> {
    return this.getGuardBindingSync(scope, scopeId);
  }

  private getGuardBindingSync(scope: GuardBindingScope, scopeId: string): GuardBindingRecord | null {
    const row = this.queryOne<GuardBindingRow>(`SELECT * FROM guard_bindings WHERE scope = ? AND scope_id = ?`, [scope, scopeId]);
    return row ? mapGuardBindingRow(row) : null;
  }

  async listGuardBindingsForProfile(profileId: string): Promise<GuardBindingRecord[]> {
    return this.queryAll<GuardBindingRow>(`SELECT * FROM guard_bindings WHERE profile_id = ? ORDER BY scope, scope_id`, [profileId]).map(mapGuardBindingRow);
  }

  async setGuardBinding(input: { scope: GuardBindingScope; scopeId: string; mode: string; profileId: string | null; updatedBy: string | null }): Promise<GuardBindingRecord> {
    const now = new Date().toISOString();
    this.exec(
      `INSERT INTO guard_bindings (scope, scope_id, mode, profile_id, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope, scope_id) DO UPDATE SET mode = excluded.mode, profile_id = excluded.profile_id, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      [input.scope, input.scopeId, input.mode, input.profileId, now, input.updatedBy]
    );
    this.persist();
    return this.getGuardBindingSync(input.scope, input.scopeId)!;
  }

  async insertGuardEvents(rows: GuardEventInsert[]): Promise<void> {
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

  async listGuardEvents(filters: GuardEventFilters & { limit?: number; offset?: number } = {}): Promise<{ events: GuardEventRecord[]; total: number }> {
    const { where, params } = this.guardEventWhere(filters);
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 500);
    const offset = Math.max(filters.offset ?? 0, 0);
    const total = this.queryOne<{ count: number }>(`SELECT COUNT(*) AS count FROM guard_events ${where}`, params);
    const rows = this.queryAll<GuardEventRow>(`SELECT * FROM guard_events ${where} ORDER BY created_at DESC, id ASC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    return { events: rows.map(mapGuardEventRow), total: total ? toNumber(total.count) : 0 };
  }

  /** Events of one execution in the order they were recorded. */
  async listGuardEventsForExecution(executionId: string): Promise<GuardEventRecord[]> {
    return this.queryAll<GuardEventRow>(`SELECT * FROM guard_events WHERE execution_id = ? ORDER BY created_at ASC, id ASC`, [executionId]).map(mapGuardEventRow);
  }

  /** Grouped counts for the Security page. */
  async guardEventStats(filters: GuardEventFilters = {}): Promise<GuardEventStats> {
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

  async getGuardVaultByToken(token: string): Promise<GuardVaultRow | null> {
    return this.queryOne<GuardVaultRow>(`SELECT * FROM guard_token_vault WHERE token = ?`, [token]);
  }

  async getGuardVaultByHash(valueHash: string): Promise<GuardVaultRow | null> {
    return this.queryOne<GuardVaultRow>(`SELECT * FROM guard_token_vault WHERE value_hash = ?`, [valueHash]);
  }

  /** Stores a token; a concurrent deterministic insert for the same value keeps the first one. */
  async putGuardVault(input: { token: string; dataClass: string; valueHash: string | null; valueSealed: string; createdAt: string }): Promise<void> {
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

  async getExecutionManifest(executionId: string): Promise<ExecutionManifestRecord | null> {
    return this.getExecutionManifestSync(executionId);
  }

  private getExecutionManifestSync(executionId: string): ExecutionManifestRecord | null {
    const row = this.queryOne<Record<string, unknown>>(`SELECT * FROM execution_manifests WHERE execution_id = ?`, [executionId]);
    return row ? this.mapExecutionManifest(row) : null;
  }

  /**
   * Records what a finished run used. A later write (an approval resume
   * finishing the same execution) replaces the context, but never once the
   * manifest has been generated: a manifest is immutable.
   */
  async saveExecutionRunContext(executionId: string, runContext: unknown, createdAt: string): Promise<void> {
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
  async saveExecutionManifest(input: {
    executionId: string;
    manifestJson: string;
    manifestDigest: string;
    keyId: string;
    signature: string;
    signedAt: string;
  }): Promise<ExecutionManifestRecord> {
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
    return this.getExecutionManifestSync(input.executionId)!;
  }

  // ---------------------------------------------------------------------------
  // Phase 15.1 — golden runs. Never pruned by retention; removed by a person
  // or with their workflow.
  // ---------------------------------------------------------------------------

  async saveReplayRecording(input: ReplayRecordingInsert): Promise<ReplayRecordingSummary> {
    return this.saveReplayRecordingSync(input);
  }

  private saveReplayRecordingSync(input: ReplayRecordingInsert): ReplayRecordingSummary {
    this.exec(
      `INSERT INTO replay_recordings (
         id, workflow_id, project_id, name, notes, source_execution_id, source_trigger_type, source_status,
         workflow_hash, workflow_saved_version, captured_workflow_json, input_json, node_outputs_json, facts_json,
         mcp_cassette_json, model_tape_json, memory_seed_json, capabilities_json, bytes, truncated, created_at, created_by,
         status, captured_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.modelTapeJson ?? null,
        input.memorySeedJson ?? null,
        JSON.stringify(input.capabilities),
        input.bytes,
        input.truncated ? 1 : 0,
        input.createdAt,
        input.createdBy,
        input.status ?? "golden",
        input.capturedAt ?? null
      ]
    );
    return this.getReplayRecordingSummarySync(input.id)!;
  }

  async getReplayRecordingSummary(id: string): Promise<ReplayRecordingSummary | null> {
    return this.getReplayRecordingSummarySync(id);
  }

  private getReplayRecordingSummarySync(id: string): ReplayRecordingSummary | null {
    const row = this.queryOne<Record<string, unknown>>(`SELECT ${REPLAY_RECORDING_SUMMARY_COLUMNS} FROM replay_recordings WHERE id = ?`, [id]);
    return row ? mapReplayRecordingSummary(row) : null;
  }

  async getReplayRecording(id: string): Promise<ReplayRecordingRecord | null> {
    return this.getReplayRecordingSync(id);
  }

  private getReplayRecordingSync(id: string): ReplayRecordingRecord | null {
    const row = this.queryOne<Record<string, unknown>>(`SELECT * FROM replay_recordings WHERE id = ?`, [id]);
    if (!row) return null;
    const parse = (value: unknown) => (typeof value === "string" && value ? safeJsonParse(value) : null);
    return {
      ...mapReplayRecordingSummary(row),
      capturedWorkflow: (parse(row.captured_workflow_json) ?? {}) as Record<string, unknown>,
      input: parse(row.input_json),
      nodes: (parse(row.node_outputs_json) ?? {}) as Record<string, ReplayRecordedNode>,
      facts: parse(row.facts_json) as RunFacts,
      mcpCassette: parse(row.mcp_cassette_json) as McpCassette | null,
      modelTape: parse(row.model_tape_json) as ModelTape | null,
      memorySeed: parse(row.memory_seed_json) as ModelMemorySeed | null
    };
  }

  async listReplayRecordings(options: { workflowId?: string; workflowIds?: string[]; status?: "candidate" | "golden"; limit?: number; offset?: number } = {}): Promise<{ items: ReplayRecordingSummary[]; total: number }> {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (options.status) {
      where.push("status = ?");
      params.push(options.status);
    }
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

  /** Bytes one workflow's golden runs use (each row's `bytes`, cassette included). Candidates have their own count cap. */
  async sumReplayRecordingBytesForWorkflow(workflowId: string): Promise<number> {
    return this.sumReplayRecordingBytesForWorkflowSync(workflowId);
  }

  private sumReplayRecordingBytesForWorkflowSync(workflowId: string): number {
    const row = this.queryOne<{ total: number | null }>(`SELECT COALESCE(SUM(bytes), 0) AS total FROM replay_recordings WHERE workflow_id = ? AND status = 'golden'`, [workflowId]);
    return row ? toNumber(row.total ?? 0) : 0;
  }

  /** Bytes every golden run in the deployment uses, cassettes included. */
  async sumReplayRecordingBytes(): Promise<number> {
    return this.sumReplayRecordingBytesSync();
  }

  private sumReplayRecordingBytesSync(): number {
    const row = this.queryOne<{ total: number | null }>(`SELECT COALESCE(SUM(bytes), 0) AS total FROM replay_recordings WHERE status = 'golden'`, []);
    return row ? toNumber(row.total ?? 0) : 0;
  }

  /** The golden run already saved from an execution, if any (captured candidates do not count). */
  async findReplayRecordingIdForExecution(executionId: string, status: "candidate" | "golden" = "golden"): Promise<string | null> {
    return this.findReplayRecordingIdForExecutionSync(executionId, status);
  }

  private findReplayRecordingIdForExecutionSync(executionId: string, status: "candidate" | "golden" = "golden"): string | null {
    const row = this.queryOne<{ id: string }>(
      `SELECT id FROM replay_recordings WHERE source_execution_id = ? AND status = ? ORDER BY created_at ASC, rowid ASC LIMIT 1`,
      [executionId, status]
    );
    return row ? toString(row.id) : null;
  }

  /** Recordings of a workflow with this status (golden by default: the golden cap counts golden runs only). */
  async countReplayRecordingsForWorkflow(workflowId: string, status: "candidate" | "golden" = "golden"): Promise<number> {
    return this.countReplayRecordingsForWorkflowSync(workflowId, status);
  }

  private countReplayRecordingsForWorkflowSync(workflowId: string, status: "candidate" | "golden" = "golden"): number {
    const row = this.queryOne<{ count: number }>(`SELECT COUNT(*) AS count FROM replay_recordings WHERE workflow_id = ? AND status = ?`, [workflowId, status]);
    return row ? toNumber(row.count) : 0;
  }

  // Phase 15.6 — production capture ------------------------------------------

  /** Captured runs in a workflow's inbox (candidates), newest first. */
  async listReplayCaptures(options: {
    workflowId: string;
    runStatus?: string;
    trigger?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ items: ReplayRecordingSummary[]; total: number }> {
    const where = ["workflow_id = ?", "status = 'candidate'"];
    const params: Array<string | number> = [options.workflowId];
    if (options.runStatus) {
      where.push("source_status = ?");
      params.push(options.runStatus);
    }
    if (options.trigger === REPLAY_CAPTURE_API_KEY_FILTER) {
      // Runs an API key started keep the trigger `manual`; the capture info records the source.
      where.push("json_extract(capabilities_json, '$.capture.source') = 'api_key'");
    } else if (options.trigger) {
      where.push("source_trigger_type = ?");
      params.push(options.trigger);
    }
    if (options.from) {
      where.push("captured_at >= ?");
      params.push(options.from);
    }
    if (options.to) {
      where.push("captured_at <= ?");
      params.push(options.to);
    }
    const clause = `WHERE ${where.join(" AND ")}`;
    const total = this.queryOne<{ count: number }>(`SELECT COUNT(*) AS count FROM replay_recordings ${clause}`, params);
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 50)));
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const items = this.queryAll<Record<string, unknown>>(
      `SELECT ${REPLAY_RECORDING_SUMMARY_COLUMNS} FROM replay_recordings ${clause} ORDER BY captured_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    ).map(mapReplayRecordingSummary);
    return { items, total: total ? toNumber(total.count) : 0 };
  }

  /** Runs captured for a workflow since `since` (ISO), promoted or not: the daily limit counts these. */
  async countReplayCapturesSince(workflowId: string, since: string): Promise<number> {
    const row = this.queryOne<{ count: number }>(`SELECT COUNT(*) AS count FROM replay_recordings WHERE workflow_id = ? AND captured_at >= ?`, [workflowId, since]);
    return row ? toNumber(row.count) : 0;
  }

  /** The oldest `count` candidates of a workflow (eviction order). */
  async oldestReplayCaptureIds(workflowId: string, count: number): Promise<string[]> {
    if (count <= 0) return [];
    return this.queryAll<{ id: string }>(
      `SELECT id FROM replay_recordings WHERE workflow_id = ? AND status = 'candidate' ORDER BY captured_at ASC, rowid ASC LIMIT ?`,
      [workflowId, count]
    ).map((row) => toString(row.id));
  }

  /** Deletes candidates captured before `before` (retention). Golden runs are never touched. */
  async pruneReplayCaptures(before: string): Promise<number> {
    const row = this.queryOne<{ count: number }>(`SELECT COUNT(*) AS count FROM replay_recordings WHERE status = 'candidate' AND captured_at < ?`, [before]);
    const count = row ? toNumber(row.count) : 0;
    if (count > 0) this.exec(`DELETE FROM replay_recordings WHERE status = 'candidate' AND captured_at < ?`, [before]);
    return count;
  }

  /** Promote: the candidate becomes golden with its re-scrubbed content. Returns false when it is no longer a candidate. */
  async promoteReplayCapture(id: string, input: Pick<ReplayRecordingInsert, "name" | "capturedWorkflowJson" | "inputJson" | "nodeOutputsJson" | "factsJson" | "mcpCassetteJson" | "modelTapeJson" | "memorySeedJson" | "bytes" | "workflowHash"> & {
      createdBy: string | null;
    }): Promise<boolean> {
    return this.promoteReplayCaptureSync(id, input);
  }

  private promoteReplayCaptureSync(id: string, input: Pick<ReplayRecordingInsert, "name" | "capturedWorkflowJson" | "inputJson" | "nodeOutputsJson" | "factsJson" | "mcpCassetteJson" | "modelTapeJson" | "memorySeedJson" | "bytes" | "workflowHash"> & {
      createdBy: string | null;
    }): boolean {
    const before = this.queryOne<{ count: number }>(`SELECT COUNT(*) AS count FROM replay_recordings WHERE id = ? AND status = 'candidate'`, [id]);
    if (!before || toNumber(before.count) === 0) return false;
    this.exec(
      `UPDATE replay_recordings SET status = 'golden', name = ?, captured_workflow_json = ?, input_json = ?, node_outputs_json = ?, facts_json = ?,
         mcp_cassette_json = ?, model_tape_json = ?, memory_seed_json = ?, bytes = ?, workflow_hash = ?, created_by = ?
       WHERE id = ? AND status = 'candidate'`,
      [
        input.name,
        input.capturedWorkflowJson,
        input.inputJson,
        input.nodeOutputsJson,
        input.factsJson,
        input.mcpCassetteJson,
        input.modelTapeJson ?? null,
        input.memorySeedJson ?? null,
        input.bytes,
        input.workflowHash,
        input.createdBy,
        id
      ]
    );
    return true;
  }

  async getReplayCaptureSettings(workflowId: string): Promise<ReplayCaptureSettingsRecord | null> {
    return this.getReplayCaptureSettingsSync(workflowId);
  }

  private getReplayCaptureSettingsSync(workflowId: string): ReplayCaptureSettingsRecord | null {
    const row = this.queryOne<Record<string, unknown>>(`SELECT * FROM replay_capture_settings WHERE workflow_id = ?`, [workflowId]);
    return row ? mapReplayCaptureSettings(row) : null;
  }

  async saveReplayCaptureSettings(input: Omit<ReplayCaptureSettingsRecord, "updatedAt"> & { updatedAt?: string }): Promise<ReplayCaptureSettingsRecord> {
    const updatedAt = input.updatedAt ?? new Date().toISOString();
    this.exec(
      `INSERT INTO replay_capture_settings (workflow_id, enabled, rate, max_per_day, only_statuses_json, dlp, dlp_off_reason, target_dataset_id, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workflow_id) DO UPDATE SET
         enabled = excluded.enabled, rate = excluded.rate, max_per_day = excluded.max_per_day,
         only_statuses_json = excluded.only_statuses_json, dlp = excluded.dlp, dlp_off_reason = excluded.dlp_off_reason,
         target_dataset_id = excluded.target_dataset_id, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      [
        input.workflowId,
        input.enabled ? 1 : 0,
        input.rate,
        input.maxPerDay,
        JSON.stringify(input.onlyStatuses),
        input.dlp ? 1 : 0,
        input.dlpOffReason,
        input.targetDatasetId,
        updatedAt,
        input.updatedBy
      ]
    );
    return this.getReplayCaptureSettingsSync(input.workflowId)!;
  }

  /** Notes the last sampled run capture dropped for a workflow (the settings row only; nothing when there is none). */
  async recordReplayCaptureDrop(workflowId: string, outcome: string, at: string): Promise<void> {
    this.exec(`UPDATE replay_capture_settings SET last_drop_outcome = ?, last_drop_at = ? WHERE workflow_id = ?`, [outcome, at, workflowId]);
  }

  /** A page of one store's searchable text, in rowid order after `afterRowid`, for the data-subject lookup. */
  async subjectTextPage(kind: SubjectStoreKind, afterRowid: number, limit: number): Promise<{ rows: SubjectTextRow[]; lastRowid: number | null }> {
    const query = SUBJECT_QUERIES[kind];
    const rows = this.queryAll<Record<string, unknown>>(`${query.select} AND ${query.rowid} > ? ORDER BY ${query.rowid} ASC LIMIT ?`, [
      afterRowid,
      Math.max(1, Math.min(500, limit))
    ]);
    return { rows: rows.map((row) => mapSubjectTextRow(kind, row)), lastRowid: rows.length > 0 ? toNumber(rows[rows.length - 1]!.rid) : null };
  }

  /** One row's searchable text (null when it is gone or not in the searched set). */
  async subjectTextRow(kind: SubjectStoreKind, id: string): Promise<SubjectTextRow | null> {
    const query = SUBJECT_QUERIES[kind];
    const row = this.queryOne<Record<string, unknown>>(`${query.select} AND ${query.idColumn} = ?`, [id]);
    return row ? mapSubjectTextRow(kind, row) : null;
  }

  /** Rows the data-subject lookup searches, per store. */
  async countSubjectRows(kind: SubjectStoreKind): Promise<number> {
    const query = SUBJECT_QUERIES[kind];
    const row = this.queryOne<{ count: number }>(`SELECT COUNT(*) AS count FROM (${query.select})`, []);
    return row ? toNumber(row.count) : 0;
  }

  /**
   * Deletes one row the data-subject lookup found. A golden run takes the
   * golden-set cases made from it, and the results of those cases, with it.
   */
  async deleteSubjectRow(kind: SubjectStoreKind, id: string): Promise<{ deleted: boolean; cascaded: Array<{ kind: SubjectStoreKind; id: string }> }> {
    // The row and what it cascades to go together, or not at all.
    return this.transaction(() => this.deleteSubjectRowSync(kind, id));
  }

  private deleteSubjectRowSync(kind: SubjectStoreKind, id: string): { deleted: boolean; cascaded: Array<{ kind: SubjectStoreKind; id: string }> } {
    const resultsOf = (fixtureIds: string[]) => {
      if (fixtureIds.length === 0) return [];
      const marks = fixtureIds.map(() => "?").join(", ");
      const ids = this.queryAll<{ id: string }>(`SELECT id FROM eval_results WHERE fixture_id IN (${marks})`, fixtureIds).map((row) => toString(row.id));
      if (ids.length > 0) this.exec(`DELETE FROM eval_results WHERE fixture_id IN (${marks})`, fixtureIds);
      return ids.map((resultId) => ({ kind: "eval_result" as const, id: resultId }));
    };
    const exists = (table: string) => {
      const row = this.queryOne<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table} WHERE id = ?`, [id]);
      return Boolean(row && toNumber(row.count) > 0);
    };
    switch (kind) {
      case "recording": {
        if (!this.getReplayRecordingSummarySync(id)) return { deleted: false, cascaded: [] };
        const fixtureIds = this.queryAll<{ id: string }>(`SELECT id FROM eval_fixtures WHERE recording_id = ?`, [id]).map((row) => toString(row.id));
        const cascaded = [...resultsOf(fixtureIds), ...fixtureIds.map((fixtureId) => ({ kind: "fixture" as const, id: fixtureId }))];
        this.deleteEvalFixturesForRecordingSync(id);
        return { deleted: this.deleteReplayRecordingSync(id), cascaded };
      }
      case "fixture": {
        const cascaded = resultsOf([id]);
        return { deleted: this.deleteEvalFixtureSync(id), cascaded };
      }
      case "eval_result": {
        if (!exists("eval_results")) return { deleted: false, cascaded: [] };
        this.exec(`DELETE FROM eval_results WHERE id = ?`, [id]);
        return { deleted: true, cascaded: [] };
      }
      case "execution": {
        if (!exists("execution_history")) return { deleted: false, cascaded: [] };
        this.exec(`DELETE FROM execution_history WHERE id = ?`, [id]);
        // The run's side rows go with it: tool-call telemetry (arguments and errors), guard events and usage.
        for (const table of ["mcp_tool_calls", "guard_events", "usage_events"]) this.exec(`DELETE FROM ${table} WHERE execution_id = ?`, [id]);
        return { deleted: true, cascaded: [] };
      }
      case "cassette":
        return { deleted: this.deleteMcpCassetteSync(id), cascaded: [] };
    }
  }

  /** Bytes one workflow's captured candidates use (REPLAY_CAPTURES_MAX_BYTES_PER_WORKFLOW). */
  async sumReplayCaptureBytesForWorkflow(workflowId: string): Promise<number> {
    const row = this.queryOne<{ total: number | null }>(`SELECT COALESCE(SUM(bytes), 0) AS total FROM replay_recordings WHERE workflow_id = ? AND status = 'candidate'`, [
      workflowId
    ]);
    return row ? toNumber(row.total ?? 0) : 0;
  }

  /** The oldest candidates of a workflow with their sizes, oldest first (byte-budget eviction). */
  async oldestReplayCaptures(workflowId: string, limit: number): Promise<Array<{ id: string; bytes: number }>> {
    return this.queryAll<{ id: string; bytes: number }>(
      `SELECT id, bytes FROM replay_recordings WHERE workflow_id = ? AND status = 'candidate' ORDER BY captured_at ASC, rowid ASC LIMIT ?`,
      [workflowId, Math.max(1, limit)]
    ).map((row) => ({ id: toString(row.id), bytes: toNumber(row.bytes) }));
  }

  /** Golden-set cases that replay a recording. */
  async evalFixtureIdsForRecording(recordingId: string): Promise<string[]> {
    return this.queryAll<{ id: string }>(`SELECT id FROM eval_fixtures WHERE recording_id = ?`, [recordingId]).map((row) => toString(row.id));
  }

  /** The runs holding a result of one of these cases, or one of these results. */
  async evalRunIdsForResults(input: { fixtureIds?: readonly string[]; resultIds?: readonly string[] }): Promise<string[]> {
    const out = new Set<string>();
    const collect = (column: "fixture_id" | "id", ids: readonly string[] | undefined) => {
      const unique = [...new Set(ids ?? [])];
      for (let start = 0; start < unique.length; start += 500) {
        const chunk = unique.slice(start, start + 500);
        const marks = chunk.map(() => "?").join(", ");
        for (const row of this.queryAll<{ run_id: string }>(`SELECT DISTINCT run_id FROM eval_results WHERE ${column} IN (${marks})`, chunk)) out.add(toString(row.run_id));
      }
    };
    collect("fixture_id", input.fixtureIds);
    collect("id", input.resultIds);
    return [...out];
  }

  /**
   * Release gate admission — runs whose evidence was removed after they ran
   * (a data-subject delete took some of their case results): never release
   * proof again. The reason joins the candidate's release-ineligible reasons.
   * Returns the ids changed.
   */
  async markEvalRunsReleaseIneligible(runIds: readonly string[], reason: string): Promise<string[]> {
    const changed: string[] = [];
    for (const runId of new Set(runIds)) {
      const row = this.queryOne<{ candidate_json: string | null }>(`SELECT candidate_json FROM eval_runs WHERE id = ?`, [runId]);
      if (!row) continue;
      let candidate: Record<string, unknown> = {};
      try {
        const parsed = row.candidate_json ? (JSON.parse(row.candidate_json) as unknown) : null;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) candidate = parsed as Record<string, unknown>;
      } catch {
        candidate = {};
      }
      const reasons = Array.isArray(candidate.releaseIneligibleReasons) ? candidate.releaseIneligibleReasons.map((entry) => String(entry)) : [];
      if (candidate.releaseEligible === false && reasons.includes(reason)) continue;
      const next = { ...candidate, releaseEligible: false, releaseIneligibleReasons: reasons.includes(reason) ? reasons : [...reasons, reason] };
      this.exec(`UPDATE eval_runs SET candidate_json = ? WHERE id = ?`, [JSON.stringify(next), runId]);
      changed.push(runId);
    }
    return changed;
  }

  /** Golden-set cases made from a recording (their input is a copy of the recording's). */
  async deleteEvalFixturesForRecording(recordingId: string): Promise<number> {
    return this.deleteEvalFixturesForRecordingSync(recordingId);
  }

  private deleteEvalFixturesForRecordingSync(recordingId: string): number {
    const row = this.queryOne<{ count: number }>(`SELECT COUNT(*) AS count FROM eval_fixtures WHERE recording_id = ?`, [recordingId]);
    const count = row ? toNumber(row.count) : 0;
    if (count > 0) this.exec(`DELETE FROM eval_fixtures WHERE recording_id = ?`, [recordingId]);
    return count;
  }

  /** Runs-page badges: how many golden runs were saved from each execution. */
  async replayGoldenBadgesForExecutions(executionIds: string[]): Promise<Map<string, ReplayGoldenBadge>> {
    const out = new Map<string, ReplayGoldenBadge>();
    const ids = [...new Set(executionIds.filter(Boolean))].slice(0, 500);
    if (ids.length === 0) return out;
    const rows = this.queryAll<{ id: string; source_execution_id: string }>(
      `SELECT id, source_execution_id FROM replay_recordings
       WHERE status = 'golden' AND source_execution_id IN (${ids.map(() => "?").join(", ")})
       ORDER BY created_at ASC, rowid ASC`,
      ids
    );
    for (const row of rows) {
      const executionId = toString(row.source_execution_id);
      out.set(executionId, { count: (out.get(executionId)?.count ?? 0) + 1, latestId: toString(row.id) });
    }
    return out;
  }

  async deleteReplayRecording(id: string): Promise<boolean> {
    return this.deleteReplayRecordingSync(id);
  }

  private deleteReplayRecordingSync(id: string): boolean {
    if (!this.getReplayRecordingSummarySync(id)) return false;
    this.exec(`DELETE FROM replay_recordings WHERE id = ?`, [id]);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Phase 15.6 — guard policy simulations. Kept GUARD_SIMULATION_RETENTION_DAYS;
  // pruning one deletes its replay jobs and their case results.
  // ---------------------------------------------------------------------------

  async insertGuardSimulation(input: Omit<GuardSimulationRecord, "error" | "finishedAt"> & { error?: string | null; finishedAt?: string | null }): Promise<GuardSimulationRecord> {
    this.exec(
      `INSERT INTO guard_simulations (id, profile_id, source_kind, source_version, simulated_hash, base_version, job_ids_json, summary_json, status, error, created_at, created_by, created_by_user_id, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.profileId,
        input.sourceKind,
        input.sourceVersion,
        input.simulatedHash,
        input.baseVersion,
        JSON.stringify(input.jobIds),
        input.detail ? JSON.stringify(input.detail) : null,
        input.status,
        input.error ?? null,
        input.createdAt,
        input.createdBy,
        input.createdByUserId,
        input.finishedAt ?? null
      ]
    );
    this.persist();
    return this.getGuardSimulationSync(input.id)!;
  }

  /** Updates a simulation; `onlyFrom` limits it to rows still in one of those statuses. Returns whether a row changed. */
  async updateGuardSimulation(input: { id: string; status?: string; jobIds?: string[]; detail?: Record<string, unknown>; error?: string | null; finishedAt?: string | null; onlyFrom?: string[] }): Promise<boolean> {
    const sets: string[] = [];
    const params: BindParams = [];
    if (input.status !== undefined) { sets.push("status = ?"); params.push(input.status); }
    if (input.jobIds !== undefined) { sets.push("job_ids_json = ?"); params.push(JSON.stringify(input.jobIds)); }
    if (input.detail !== undefined) { sets.push("summary_json = ?"); params.push(JSON.stringify(input.detail)); }
    if (input.error !== undefined) { sets.push("error = ?"); params.push(input.error); }
    if (input.finishedAt !== undefined) { sets.push("finished_at = ?"); params.push(input.finishedAt); }
    if (sets.length === 0) return false;
    const guard = input.onlyFrom && input.onlyFrom.length > 0 ? ` AND status IN (${input.onlyFrom.map(() => "?").join(", ")})` : "";
    this.exec(`UPDATE guard_simulations SET ${sets.join(", ")} WHERE id = ?${guard}`, [...params, input.id, ...(input.onlyFrom ?? [])]);
    const row = this.queryOne<{ count: number }>("SELECT changes() as count");
    this.persist();
    return (row ? toNumber(row.count) : 0) > 0;
  }

  async getGuardSimulation(id: string): Promise<GuardSimulationRecord | null> {
    return this.getGuardSimulationSync(id);
  }

  private getGuardSimulationSync(id: string): GuardSimulationRecord | null {
    const row = this.queryOne<Record<string, unknown>>(`SELECT * FROM guard_simulations WHERE id = ?`, [id]);
    return row ? mapGuardSimulationRow(row) : null;
  }

  async listGuardSimulations(options: { profileId: string; limit?: number; offset?: number }): Promise<GuardSimulationRecord[]> {
    const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 20)));
    return this.queryAll<Record<string, unknown>>(`SELECT * FROM guard_simulations WHERE profile_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`, [options.profileId, limit, Math.max(0, Math.floor(options.offset ?? 0))]).map(mapGuardSimulationRow);
  }

  /** Simulations still running (a stopped server left them so). */
  async listRunningGuardSimulations(): Promise<GuardSimulationRecord[]> {
    return this.queryAll<Record<string, unknown>>(`SELECT * FROM guard_simulations WHERE status = 'running' ORDER BY created_at ASC`).map(mapGuardSimulationRow);
  }

  /** Deletes simulations created before `before`, with their replay jobs and case results. Returns how many simulations were deleted. */
  async pruneGuardSimulations(input: { before: string }): Promise<number> {
    const rows = this.queryAll<{ id: string; job_ids_json: string | null }>(`SELECT id, job_ids_json FROM guard_simulations WHERE created_at < ?`, [input.before]);
    if (rows.length === 0) return 0;
    const jobIds: string[] = [];
    for (const row of rows) {
      const parsed = row.job_ids_json ? safeJsonParse(toString(row.job_ids_json)) : null;
      if (Array.isArray(parsed)) jobIds.push(...parsed.map((entry) => String(entry)));
    }
    for (let index = 0; index < jobIds.length; index += 200) {
      const chunk = jobIds.slice(index, index + 200);
      const marks = chunk.map(() => "?").join(", ");
      this.exec(`DELETE FROM eval_results WHERE run_id IN (${marks})`, chunk);
      this.exec(`DELETE FROM eval_runs WHERE id IN (${marks}) AND status NOT IN ('queued', 'running')`, chunk);
    }
    const ids = rows.map((row) => toString(row.id));
    for (let index = 0; index < ids.length; index += 200) {
      const chunk = ids.slice(index, index + 200);
      this.exec(`DELETE FROM guard_simulations WHERE id IN (${chunk.map(() => "?").join(", ")})`, chunk);
    }
    this.persist();
    return ids.length;
  }

  /** MCP tool-call telemetry rows of one execution, oldest first. */
  async listMcpToolCallsForExecution(executionId: string): Promise<McpToolCallRecord[]> {
    return this.queryAll<McpToolCallRow>(`SELECT * FROM mcp_tool_calls WHERE execution_id = ? ORDER BY started_at, id`, [executionId]).map(mapMcpToolCall);
  }

  /**
   * Audit-log entries about this execution: rows whose metadata `executionId`
   * is this execution, or whose resource is this execution. No IP address or
   * user agent; the actor's current role comes from the users table.
   */
  async listAuditLogsForExecution(executionId: string): Promise<Array<{
    eventType: string;
    action: string;
    outcome: string;
    actorUserId: string | null;
    actorRole: string | null;
    actorEmail: string | null;
    actorType: string;
    message: string | null;
    createdAt: string;
  }>> {
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
  async pruneExecutionManifests(options: { before: string }): Promise<number> {
    return this.pruneExecutionManifestsSync(options);
  }

  private pruneExecutionManifestsSync(options: { before: string }): number {
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

  async listAuditSigningKeys(): Promise<AuditSigningKeyRecord[]> {
    return this.queryAll<Record<string, unknown>>(`SELECT * FROM audit_signing_keys ORDER BY created_at DESC, key_id ASC`).map((row) =>
      this.mapAuditSigningKey(row)
    );
  }

  async getAuditSigningKey(keyId: string): Promise<AuditSigningKeyRecord | null> {
    const row = this.queryOne<Record<string, unknown>>(`SELECT * FROM audit_signing_keys WHERE key_id = ?`, [keyId]);
    return row ? this.mapAuditSigningKey(row) : null;
  }

  async getActiveAuditSigningKey(): Promise<AuditSigningKeyRecord | null> {
    return this.getActiveAuditSigningKeySync();
  }

  private getActiveAuditSigningKeySync(): AuditSigningKeyRecord | null {
    const row = this.queryOne<Record<string, unknown>>(`SELECT * FROM audit_signing_keys WHERE status = 'active'`);
    return row ? this.mapAuditSigningKey(row) : null;
  }

  /**
   * Makes `key` the active key and retires the previous one in one
   * transaction. A key id seen before (an env key put back) is re-activated.
   * Returns false when another writer activated a different key first.
   */
  async activateAuditSigningKey(key: Omit<AuditSigningKeyRecord, "status" | "retiredAt">, expectedActiveKeyId: string | null): Promise<boolean> {
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      const current = this.getActiveAuditSigningKeySync();
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
  async ensureDefaultProject(): Promise<Project> {
    const existing = this.getProjectSync(DEFAULT_PROJECT_ID);
    if (existing) {
      this.exec(`UPDATE workflows SET project_id = ? WHERE project_id IS NULL`, [DEFAULT_PROJECT_ID]);
      this.exec(`UPDATE secrets SET project_id = ? WHERE project_id IS NULL`, [DEFAULT_PROJECT_ID]);
      return existing;
    }
    const project = this.upsertProjectSync({
      id: DEFAULT_PROJECT_ID,
      name: "Default Project",
      description: "Personal workspace."
    });
    this.exec(`UPDATE workflows SET project_id = ? WHERE project_id IS NULL`, [DEFAULT_PROJECT_ID]);
    this.exec(`UPDATE secrets SET project_id = ? WHERE project_id IS NULL`, [DEFAULT_PROJECT_ID]);
    this.persist();
    return project;
  }

  // ---------------------------------------------------------------------------
  // Migration 38 — data destinations (Phase 16).
  // ---------------------------------------------------------------------------

  /**
   * Every workflow's draft JSON and, when one is published, the published
   * version's JSON, in one query (the "not classified yet" list reads both).
   */
  async listWorkflowConfigsForDestinations(): Promise<Array<{ id: string; name: string; draftJson: string; publishedJson: string | null }>> {
    return this.queryAll<{ id: string; name: string; workflow_json: string; published_json: string | null }>(
      `SELECT w.id, w.name, w.workflow_json, v.workflow_json AS published_json
       FROM workflows w
       LEFT JOIN workflow_versions v ON v.workflow_id = w.id AND v.version = w.published_version
       ORDER BY w.updated_at DESC`
    ).map((row) => ({
      id: toString(row.id),
      name: toString(row.name),
      draftJson: toString(row.workflow_json),
      publishedJson: row.published_json ? toString(row.published_json) : null
    }));
  }

  async listDataDestinations(): Promise<DataDestinationRow[]> {
    return this.queryAll<Record<string, unknown>>(`SELECT * FROM data_destinations ORDER BY tier, name, id`).map(mapDataDestinationRow);
  }

  async getDataDestination(id: string): Promise<DataDestinationRow | null> {
    return this.getDataDestinationSync(id);
  }

  private getDataDestinationSync(id: string): DataDestinationRow | null {
    const row = this.queryOne<Record<string, unknown>>(`SELECT * FROM data_destinations WHERE id = ?`, [id]);
    return row ? mapDataDestinationRow(row) : null;
  }

  /** The row with exactly this match (kind, target id, host), if any. */
  async findDataDestinationByMatch(kind: string, targetId: string | null, host: string | null): Promise<DataDestinationRow | null> {
    const row = this.queryOne<Record<string, unknown>>(
      `SELECT * FROM data_destinations WHERE kind = ? AND COALESCE(target_id, '') = ? AND COALESCE(host, '') = ?`,
      [kind, targetId ?? "", host ?? ""]
    );
    return row ? mapDataDestinationRow(row) : null;
  }

  async insertDataDestination(input: DataDestinationWrite & { id: string; actor: string | null; at?: string }): Promise<DataDestinationRow> {
    const at = input.at ?? new Date().toISOString();
    this.exec(
      `INSERT INTO data_destinations (id, name, kind, target_id, host, tier, region, holds_data_classes_json, note, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [input.id, input.name, input.kind, input.targetId, input.host, input.tier, input.region, JSON.stringify(input.holdsDataClasses), input.note, at, input.actor, at, input.actor]
    );
    return this.getDataDestinationSync(input.id)!;
  }

  /** Replaces a row's fields; null when it does not exist. */
  async updateDataDestination(id: string, input: DataDestinationWrite & { actor: string | null; at?: string }): Promise<DataDestinationRow | null> {
    if (!this.getDataDestinationSync(id)) return null;
    const at = input.at ?? new Date().toISOString();
    this.exec(
      `UPDATE data_destinations SET name = ?, kind = ?, target_id = ?, host = ?, tier = ?, region = ?, holds_data_classes_json = ?, note = ?, updated_at = ?, updated_by = ?
       WHERE id = ?`,
      [input.name, input.kind, input.targetId, input.host, input.tier, input.region, JSON.stringify(input.holdsDataClasses), input.note, at, input.actor, id]
    );
    return this.getDataDestinationSync(id);
  }

  async deleteDataDestination(id: string): Promise<boolean> {
    if (!this.getDataDestinationSync(id)) return false;
    this.exec(`DELETE FROM data_destinations WHERE id = ?`, [id]);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Atomic multi-step operations (Phase 13.1): each is one db.transaction, so
  // a check and the write it guards cannot interleave with another request.
  // ---------------------------------------------------------------------------

  async claimExecutionAndDecideApproval(executionId: string, decision: ApprovalDecisionInput): Promise<boolean> {
    const lost = Symbol("lost");
    try {
      return this.transaction(() => {
        if (!this.claimWorkflowExecutionForResumeSync(executionId)) return false;
        // Throwing rolls the claim back.
        if (!this.decideApprovalRequestSync(decision)) throw lost;
        return true;
      });
    } catch (error) {
      if (error === lost) return false;
      throw error;
    }
  }

  async releaseExecutionClaimAndReopenApproval(executionId: string, requestId: string): Promise<boolean> {
    return this.transaction(() => {
      if (!this.releaseWorkflowExecutionClaimSync(executionId)) return false;
      this.reopenApprovalRequestSync(requestId);
      return true;
    });
  }

  async saveReleaseGate(input: {
    gate: ReleaseGateRecord | null;
    admittedFixtureIds?: string[] | null;
    expected: ReleaseGateRecord | null;
    updatedAt: string;
    updatedBy: string | null;
  }): Promise<ReleaseGateRecord | null> {
    return this.transaction(() => {
      const current = this.getReleaseGateSync(input.gate?.workflowId ?? input.expected?.workflowId ?? "");
      if (JSON.stringify(current) !== JSON.stringify(input.expected)) return null;
      const saved = input.gate ? this.upsertReleaseGateSync(input.gate) : current;
      if (!saved) return null;
      if (input.admittedFixtureIds !== undefined && !sameIdSet(input.admittedFixtureIds, current?.admittedFixtureIds ?? null)) {
        this.setReleaseGateAdmissionSync(saved.workflowId, input.admittedFixtureIds, input.updatedAt, input.updatedBy);
      }
      return saved;
    });
  }

  async updateReleaseGateCases(change: ReleaseGateCasesChange): Promise<"ok" | "decided" | "changed"> {
    const refused = Symbol("refused");
    let outcome: "decided" | "changed" = "changed";
    try {
      return this.transaction(() => {
        if (change.decideRequest && !this.decideGateCaseRequestSync(change.decideRequest)) {
          outcome = "decided";
          throw refused;
        }
        if (change.expectedAdmittedFixtureIds !== undefined) {
          const gate = this.getReleaseGateSync(change.workflowId);
          if (!gate || !sameIdSet(gate.admittedFixtureIds ?? null, change.expectedAdmittedFixtureIds)) {
            outcome = "changed";
            throw refused;
          }
        }
        if (change.admittedFixtureIds !== undefined) {
          this.setReleaseGateAdmissionSync(change.workflowId, change.admittedFixtureIds, change.updatedAt, change.updatedBy);
        }
        for (const fixtureId of change.deleteFixtureIds ?? []) this.deleteEvalFixtureSync(fixtureId);
        if (change.required) this.setEvalFixtureRequiredSync(change.required.fixtureId, change.required.required);
        return "ok" as const;
      });
    } catch (error) {
      if (error === refused) return outcome;
      throw error;
    }
  }

  async approveReleaseRequestAndPublish(
    decision: ReleaseApprovalDecisionInput,
    release: Omit<WorkflowReleaseRecord, "previousVersion">,
    expectedPrevious: number | null
  ): Promise<{ release: WorkflowReleaseRecord } | { refused: "decided" | "conflict" }> {
    const refused = Symbol("refused");
    let outcome: "decided" | "conflict" = "conflict";
    try {
      return this.transaction(() => {
        if (!this.decideReleaseApprovalRequestSync(decision)) {
          outcome = "decided";
          throw refused;
        }
        const committed = this.publishWorkflowVersionSync(release, expectedPrevious);
        // Throwing rolls the decision back.
        if (!committed) throw refused;
        return { release: committed };
      });
    } catch (error) {
      if (error === refused) return { refused: outcome };
      throw error;
    }
  }

  /** The first golden-run limit a save of `bytes` for `workflowId` would break, checked against the store as it is now. */
  private replayRecordingRefusal(workflowId: string, bytes: number, limits: ReplayRecordingLimits): ReplayRecordingRefusal | null {
    const count = this.countReplayRecordingsForWorkflowSync(workflowId);
    if (count >= limits.maxPerWorkflow) return { refused: "count", used: count, bytes };
    const workflowBytes = this.sumReplayRecordingBytesForWorkflowSync(workflowId);
    if (workflowBytes + bytes > limits.maxBytesPerWorkflow) return { refused: "workflow_bytes", used: workflowBytes, bytes };
    const totalBytes = this.sumReplayRecordingBytesSync();
    if (totalBytes + bytes > limits.maxTotalBytes) return { refused: "total_bytes", used: totalBytes, bytes };
    return null;
  }

  async saveReplayRecordingChecked(
    input: ReplayRecordingInsert,
    checks: { limits?: ReplayRecordingLimits; uniqueExecution?: boolean }
  ): Promise<{ saved: ReplayRecordingSummary } | ReplayRecordingRefusal> {
    return this.transaction((): { saved: ReplayRecordingSummary } | ReplayRecordingRefusal => {
      if (checks.uniqueExecution && input.sourceExecutionId) {
        const existingId = this.findReplayRecordingIdForExecutionSync(input.sourceExecutionId, input.status ?? "golden");
        if (existingId) return { refused: "duplicate", existingId };
      }
      if (checks.limits) {
        const refusal = this.replayRecordingRefusal(input.workflowId, input.bytes, checks.limits);
        if (refusal) return refusal;
      }
      return { saved: this.saveReplayRecordingSync(input) };
    });
  }

  async promoteReplayCaptureToGoldenSet(input: {
    recordingId: string;
    promotion: Parameters<Store["promoteReplayCapture"]>[1];
    target: { datasetId: string } | { findOrCreate: Parameters<Store["createEvalDataset"]>[0] & { workflowId: string } };
    fixture: { id: string; name?: string };
    limits: ReplayRecordingLimits;
  }): Promise<{ datasetId: string; fixtureId: string } | { refused: "not_candidate" } | { refused: "set_gone" } | ReplayRecordingRefusal> {
    type Outcome = { datasetId: string; fixtureId: string } | { refused: "not_candidate" } | { refused: "set_gone" } | ReplayRecordingRefusal;
    const refused = Symbol("refused");
    let outcome: Outcome = { refused: "not_candidate" };
    try {
      return this.transaction((): Outcome => {
        const candidate = this.getReplayRecordingSummarySync(input.recordingId);
        if (!candidate || candidate.status !== "candidate") return { refused: "not_candidate" };
        const refusal = this.replayRecordingRefusal(candidate.workflowId, input.promotion.bytes, input.limits);
        if (refusal) return refusal;
        let datasetId: string;
        if ("datasetId" in input.target) {
          if (!this.getEvalDatasetSync(input.target.datasetId)) return { refused: "set_gone" };
          datasetId = input.target.datasetId;
        } else {
          const wanted = input.target.findOrCreate;
          const existing = this.listEvalDatasetsSync({ workflowId: wanted.workflowId }).find((dataset) => dataset.name === wanted.name);
          if (existing) {
            datasetId = existing.id;
          } else {
            this.createEvalDatasetSync(wanted);
            datasetId = wanted.id;
          }
        }
        if (!this.promoteReplayCaptureSync(input.recordingId, input.promotion)) {
          outcome = { refused: "not_candidate" };
          throw refused;
        }
        const promoted = this.getReplayRecordingSync(input.recordingId)!;
        this.createEvalFixtureSync({
          id: input.fixture.id,
          datasetId,
          name: input.fixture.name ?? promoted.name,
          input: promoted.input ?? null,
          recordingId: promoted.id
        });
        return { datasetId, fixtureId: input.fixture.id };
      });
    } catch (error) {
      if (error === refused) return outcome;
      throw error;
    }
  }

  async importGoldenSet(input: {
    dataset: Parameters<Store["createEvalDataset"]>[0];
    cases: Array<{ recording: ReplayRecordingInsert; fixture: Omit<Parameters<Store["createEvalFixture"]>[0], "datasetId" | "recordingId"> }>;
    limits: ReplayRecordingLimits;
  }): Promise<{ recordingIds: string[] } | ReplayRecordingRefusal> {
    const refused = Symbol("refused");
    let outcome: ReplayRecordingRefusal = { refused: "count", used: 0, bytes: 0 };
    try {
      return this.transaction(() => {
        this.createEvalDatasetSync(input.dataset);
        const recordingIds: string[] = [];
        for (const entry of input.cases) {
          const refusal = this.replayRecordingRefusal(entry.recording.workflowId, entry.recording.bytes, input.limits);
          // Throwing rolls back the set and the cases saved before this one.
          if (refusal) {
            outcome = refusal;
            throw refused;
          }
          const summary = this.saveReplayRecordingSync(entry.recording);
          this.createEvalFixtureSync({ ...entry.fixture, datasetId: input.dataset.id, recordingId: summary.id });
          recordingIds.push(summary.id);
        }
        return { recordingIds };
      });
    } catch (error) {
      if (error === refused) return outcome;
      throw error;
    }
  }
}

/** The fields of a data destination row a write sets (already validated and normalised). */
export type DataDestinationWrite = Pick<DataDestinationRow, "name" | "kind" | "targetId" | "host" | "tier" | "region" | "holdsDataClasses" | "note">;

function mapDataDestinationRow(row: Record<string, unknown>): DataDestinationRow {
  const optionalString = (value: unknown) => (value === null || value === undefined ? null : toString(value));
  const kind = toString(row.kind);
  const tier = toString(row.tier);
  return {
    id: toString(row.id),
    name: toString(row.name),
    kind: (DESTINATION_KINDS as readonly string[]).includes(kind) ? (kind as DataDestinationRow["kind"]) : "http",
    targetId: optionalString(row.target_id),
    host: optionalString(row.host),
    // An unreadable tier is treated as public, the strictest.
    tier: (DESTINATION_TIERS as readonly string[]).includes(tier) ? (tier as DataDestinationRow["tier"]) : "public",
    region: toString(row.region) || "unknown",
    holdsDataClasses: parseJsonArray(row.holds_data_classes_json),
    note: optionalString(row.note),
    builtIn: false,
    createdAt: optionalString(row.created_at),
    updatedAt: optionalString(row.updated_at),
    createdBy: optionalString(row.created_by),
    updatedBy: optionalString(row.updated_by)
  };
}

function mapGuardSimulationRow(row: Record<string, unknown>): GuardSimulationRecord {
  const jobs = typeof row.job_ids_json === "string" ? safeJsonParse(row.job_ids_json) : null;
  const detail = typeof row.summary_json === "string" && row.summary_json ? safeJsonParse(row.summary_json) : null;
  const optionalNumber = (value: unknown) => (value === null || value === undefined ? null : toNumber(value));
  const optionalString = (value: unknown) => (value === null || value === undefined ? null : toString(value));
  return {
    id: toString(row.id),
    profileId: toString(row.profile_id),
    sourceKind: toString(row.source_kind) === "version" ? "version" : "inline",
    sourceVersion: optionalNumber(row.source_version),
    simulatedHash: toString(row.simulated_hash),
    baseVersion: optionalNumber(row.base_version),
    jobIds: Array.isArray(jobs) ? jobs.map((entry) => String(entry)) : [],
    detail: detail && typeof detail === "object" && !Array.isArray(detail) ? (detail as Record<string, unknown>) : null,
    status: toString(row.status),
    error: optionalString(row.error),
    createdAt: toString(row.created_at),
    createdBy: optionalString(row.created_by),
    createdByUserId: optionalString(row.created_by_user_id),
    finishedAt: optionalString(row.finished_at)
  };
}

/** Whether two stored id lists name the same ids (null: nothing stored). */
function sameIdSet(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
