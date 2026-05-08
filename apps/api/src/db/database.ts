import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import Database, { type Database as BetterSqlite3Database } from "better-sqlite3";
import type { ChatMessage, Folder, Project, Workflow, WorkflowListItem } from "@ai-orchestrator/shared";
import { DEFAULT_PROJECT_ID } from "@ai-orchestrator/shared";

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

  upsertWorkflow(workflow: Workflow): Workflow {
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
      `INSERT INTO workflows (id, name, schema_version, workflow_version, workflow_json, created_at, updated_at, tags_json, project_id, folder_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        payload.folderId ?? null
      ]
    );

    this.persist();
    return payload;
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

  requeueStuckItems(stuckAfterMs = 600_000): number {
    const stuckBefore = new Date(Date.now() - stuckAfterMs).toISOString();
    const now = new Date().toISOString();
    const stuck = this.queryAll<ExecutionQueueRow>(
      `SELECT id FROM execution_queue WHERE status = 'running' AND started_at <= ?`,
      [stuckBefore]
    );

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

  listDlqItems(limit = 50): Array<{
    id: string;
    originalId: string;
    workflowId: string;
    workflowName: string | null;
    attempts: number;
    finalError: string;
    failedAt: string;
  }> {
    const rows = this.queryAll<ExecutionQueueDlqRow>(
      `SELECT id, original_id, workflow_id, workflow_name, attempts, final_error, failed_at
       FROM execution_queue_dlq
       ORDER BY failed_at DESC
       LIMIT ?`,
      [limit]
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
