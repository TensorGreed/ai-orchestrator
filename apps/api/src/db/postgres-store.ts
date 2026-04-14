import { Pool, type PoolConfig } from "pg";
import { randomUUID } from "node:crypto";
import type { ChatMessage, Workflow, WorkflowListItem } from "@ai-orchestrator/shared";
import { runMigrations } from "./migrations.js";

export interface PostgresStoreConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean;
  maxConnections?: number;
}

// Helper to safely parse JSON
function parseJsonSafe(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toNum(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function toStr(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

const MAX_SESSION_TOOL_CACHE_RECORDS = 400;

export class PostgresStore {
  private readonly pool: Pool;

  private constructor(pool: Pool) {
    this.pool = pool;
  }

  static async create(config: PostgresStoreConfig): Promise<PostgresStore> {
    const poolConfig: PoolConfig = {
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: false } : false,
      max: config.maxConnections ?? 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000
    };
    const pool = new Pool(poolConfig);
    const store = new PostgresStore(pool);
    await store.migrate();
    return store;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async query<T extends object>(
    sql: string,
    params?: unknown[]
  ): Promise<T[]> {
    const result = await this.pool.query(sql, params);
    return result.rows as T[];
  }

  private async queryOne<T extends object>(
    sql: string,
    params?: unknown[]
  ): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  private async execute(sql: string, params?: unknown[]): Promise<void> {
    await this.pool.query(sql, params);
  }

  private async migrate(): Promise<void> {
    // Ensure schema_migrations table exists
    await this.execute(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await runMigrations(
      async (sql) => { await this.execute(sql); },
      async () => {
        const row = await this.queryOne<{ version: number }>(
          `SELECT COALESCE(MAX(version), 0) as version FROM schema_migrations`
        );
        return row ? toNum(row.version) : 0;
      },
      async (version) => {
        await this.execute(
          `INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`,
          [version]
        );
      }
    );
  }

  // ---------------------------------------------------------------------------
  // Workflow methods
  // ---------------------------------------------------------------------------

  async listWorkflows(): Promise<WorkflowListItem[]> {
    const rows = await this.query<{
      id: string;
      name: string;
      schema_version: string;
      workflow_version: number;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, name, schema_version, workflow_version, created_at, updated_at
       FROM workflows
       ORDER BY updated_at DESC`
    );
    return rows.map((row) => ({
      id: toStr(row.id),
      name: toStr(row.name),
      schemaVersion: toStr(row.schema_version),
      workflowVersion: toNum(row.workflow_version),
      createdAt: toStr(row.created_at),
      updatedAt: toStr(row.updated_at)
    }));
  }

  async getWorkflow(id: string): Promise<Workflow | null> {
    const row = await this.queryOne<{
      id: string;
      workflow_json: string;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, workflow_json, created_at, updated_at FROM workflows WHERE id = $1`,
      [id]
    );
    if (!row) return null;
    const parsed = JSON.parse(toStr(row.workflow_json)) as Workflow;
    parsed.createdAt = toStr(row.created_at);
    parsed.updatedAt = toStr(row.updated_at);
    return parsed;
  }

  async upsertWorkflow(workflow: Workflow): Promise<Workflow> {
    const now = new Date().toISOString();
    const existing = await this.getWorkflow(workflow.id);
    const createdAt = existing?.createdAt ?? now;
    const payload: Workflow = { ...workflow, createdAt, updatedAt: now };

    await this.execute(
      `INSERT INTO workflows (id, name, schema_version, workflow_version, workflow_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         schema_version = EXCLUDED.schema_version,
         workflow_version = EXCLUDED.workflow_version,
         workflow_json = EXCLUDED.workflow_json,
         updated_at = EXCLUDED.updated_at`,
      [payload.id, payload.name, payload.schemaVersion, payload.workflowVersion, JSON.stringify(payload), createdAt, now]
    );
    return payload;
  }

  async deleteWorkflow(id: string): Promise<boolean> {
    await this.execute(`DELETE FROM execution_history WHERE workflow_id = $1`, [id]);
    await this.execute(`DELETE FROM workflow_executions WHERE workflow_id = $1`, [id]);
    const result = await this.pool.query(`DELETE FROM workflows WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async countWorkflows(): Promise<number> {
    const row = await this.queryOne<{ count: string }>(`SELECT COUNT(*) as count FROM workflows`);
    return row ? toNum(row.count) : 0;
  }

  // ---------------------------------------------------------------------------
  // Secrets
  // ---------------------------------------------------------------------------

  async listSecrets(): Promise<Array<{ id: string; name: string; provider: string; created_at: string }>> {
    const rows = await this.query<{ id: string; name: string; provider: string; created_at: string }>(
      `SELECT id, name, provider, created_at FROM secrets ORDER BY created_at DESC`
    );
    return rows.map((row) => ({
      id: toStr(row.id),
      name: toStr(row.name),
      provider: toStr(row.provider),
      created_at: toStr(row.created_at)
    }));
  }

  async getSecret(id: string): Promise<{
    id: string;
    name: string;
    provider: string;
    iv: string;
    auth_tag: string;
    ciphertext: string;
    created_at: string;
  } | null> {
    const row = await this.queryOne<{
      id: string;
      name: string;
      provider: string;
      iv: string;
      auth_tag: string;
      ciphertext: string;
      created_at: string;
    }>(`SELECT id, name, provider, iv, auth_tag, ciphertext, created_at FROM secrets WHERE id = $1`, [id]);
    if (!row) return null;
    return {
      id: toStr(row.id),
      name: toStr(row.name),
      provider: toStr(row.provider),
      iv: toStr(row.iv),
      auth_tag: toStr(row.auth_tag),
      ciphertext: toStr(row.ciphertext),
      created_at: toStr(row.created_at)
    };
  }

  async saveSecret(input: {
    id: string;
    name: string;
    provider: string;
    iv: string;
    authTag: string;
    ciphertext: string;
  }): Promise<void> {
    await this.execute(
      `INSERT INTO secrets (id, name, provider, iv, auth_tag, ciphertext, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         provider = EXCLUDED.provider,
         iv = EXCLUDED.iv,
         auth_tag = EXCLUDED.auth_tag,
         ciphertext = EXCLUDED.ciphertext`,
      [input.id, input.name, input.provider, input.iv, input.authTag, input.ciphertext, new Date().toISOString()]
    );
  }

  // ---------------------------------------------------------------------------
  // Users
  // ---------------------------------------------------------------------------

  async countUsers(): Promise<number> {
    const row = await this.queryOne<{ count: string }>(`SELECT COUNT(*) as count FROM users`);
    return row ? toNum(row.count) : 0;
  }

  async getUserByEmail(email: string): Promise<{
    id: string;
    email: string;
    passwordHash: string;
    role: string;
    createdAt: string;
    updatedAt: string;
  } | null> {
    const row = await this.queryOne<{
      id: string;
      email: string;
      password_hash: string;
      role: string;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, email, password_hash, role, created_at, updated_at FROM users WHERE lower(email) = lower($1)`,
      [email]
    );
    if (!row) return null;
    return {
      id: toStr(row.id),
      email: toStr(row.email),
      passwordHash: toStr(row.password_hash),
      role: toStr(row.role),
      createdAt: toStr(row.created_at),
      updatedAt: toStr(row.updated_at)
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
    const row = await this.queryOne<{
      id: string;
      email: string;
      password_hash: string;
      role: string;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, email, password_hash, role, created_at, updated_at FROM users WHERE id = $1`,
      [id]
    );
    if (!row) return null;
    return {
      id: toStr(row.id),
      email: toStr(row.email),
      passwordHash: toStr(row.password_hash),
      role: toStr(row.role),
      createdAt: toStr(row.created_at),
      updatedAt: toStr(row.updated_at)
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
    const existing = await this.getUserById(input.id);
    const createdAt = existing?.createdAt ?? now;
    await this.execute(
      `INSERT INTO users (id, email, password_hash, role, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         password_hash = EXCLUDED.password_hash,
         role = EXCLUDED.role,
         updated_at = EXCLUDED.updated_at`,
      [input.id, input.email.toLowerCase(), input.passwordHash, input.role, createdAt, now]
    );
    return { id: input.id, email: input.email.toLowerCase(), role: input.role, createdAt, updatedAt: now };
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  async getSession(sessionId: string): Promise<{
    id: string;
    userId: string;
    expiresAt: string;
    createdAt: string;
    lastSeenAt: string;
    revokedAt: string | null;
  } | null> {
    const row = await this.queryOne<{
      id: string;
      user_id: string;
      expires_at: string;
      created_at: string;
      last_seen_at: string;
      revoked_at: string | null;
    }>(
      `SELECT id, user_id, expires_at, created_at, last_seen_at, revoked_at FROM sessions WHERE id = $1`,
      [sessionId]
    );
    if (!row) return null;
    return {
      id: toStr(row.id),
      userId: toStr(row.user_id),
      expiresAt: toStr(row.expires_at),
      createdAt: toStr(row.created_at),
      lastSeenAt: toStr(row.last_seen_at),
      revokedAt: row.revoked_at ? toStr(row.revoked_at) : null
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
    await this.execute(
      `INSERT INTO sessions (id, user_id, expires_at, created_at, last_seen_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, NULL)`,
      [input.id, input.userId, input.expiresAt, now, now]
    );
    return { id: input.id, userId: input.userId, expiresAt: input.expiresAt, createdAt: now, lastSeenAt: now };
  }

  async touchSession(sessionId: string): Promise<void> {
    await this.execute(
      `UPDATE sessions SET last_seen_at = $1 WHERE id = $2 AND revoked_at IS NULL`,
      [new Date().toISOString(), sessionId]
    );
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.execute(
      `UPDATE sessions SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL`,
      [new Date().toISOString(), sessionId]
    );
  }

  async revokeExpiredSessions(): Promise<void> {
    const now = new Date().toISOString();
    await this.execute(
      `UPDATE sessions SET revoked_at = $1 WHERE revoked_at IS NULL AND expires_at <= $2`,
      [now, now]
    );
  }

  // ---------------------------------------------------------------------------
  // Session Memory
  // ---------------------------------------------------------------------------

  async loadSessionMemory(namespace: string, sessionId: string): Promise<ChatMessage[]> {
    const row = await this.queryOne<{ messages_json: string }>(
      `SELECT messages_json FROM session_memory WHERE namespace = $1 AND session_id = $2`,
      [namespace, sessionId]
    );
    if (!row) return [];
    try {
      const parsed = JSON.parse(toStr(row.messages_json));
      return Array.isArray(parsed) ? (parsed as ChatMessage[]) : [];
    } catch {
      return [];
    }
  }

  async saveSessionMemory(namespace: string, sessionId: string, messages: ChatMessage[]): Promise<void> {
    const row = await this.queryOne<{ created_at: string }>(
      `SELECT created_at FROM session_memory WHERE namespace = $1 AND session_id = $2`,
      [namespace, sessionId]
    );
    const now = new Date().toISOString();
    const createdAt = row ? toStr(row.created_at) : now;
    await this.execute(
      `INSERT INTO session_memory (namespace, session_id, messages_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (namespace, session_id) DO UPDATE SET
         messages_json = EXCLUDED.messages_json,
         updated_at = EXCLUDED.updated_at`,
      [namespace, sessionId, JSON.stringify(messages), createdAt, now]
    );
  }

  // ---------------------------------------------------------------------------
  // Session Tool Cache
  // ---------------------------------------------------------------------------

  async saveSessionToolCall(input: {
    namespace: string;
    sessionId: string;
    toolName: string;
    toolCallId?: string;
    args: Record<string, unknown>;
    output: unknown;
    error?: string;
    summary?: unknown;
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
    createdAt: string;
  }> {
    const now = new Date().toISOString();
    const id = randomUUID();
    await this.execute(
      `INSERT INTO session_tool_cache (id, namespace, session_id, tool_name, tool_call_id, args_json, output_json, error, summary_json, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
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

    // Prune old records
    await this.execute(
      `DELETE FROM session_tool_cache
       WHERE namespace = $1 AND session_id = $2
         AND id NOT IN (
           SELECT id FROM session_tool_cache
           WHERE namespace = $1 AND session_id = $2
           ORDER BY created_at DESC
           LIMIT $3
         )`,
      [input.namespace, input.sessionId, MAX_SESSION_TOOL_CACHE_RECORDS]
    );

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
    createdAt: string;
  }>> {
    const limit =
      typeof input.limit === "number" && Number.isFinite(input.limit) && input.limit > 0
        ? Math.min(Math.floor(input.limit), 200)
        : 20;

    let rows: Array<{
      id: string;
      namespace: string;
      session_id: string;
      tool_name: string;
      tool_call_id: string | null;
      args_json: string;
      error: string | null;
      summary_json: string | null;
      created_at: string;
    }>;

    if (input.toolName) {
      rows = await this.query(
        `SELECT id, namespace, session_id, tool_name, tool_call_id, args_json, error, summary_json, created_at
         FROM session_tool_cache
         WHERE namespace = $1 AND session_id = $2 AND tool_name = $3
         ORDER BY created_at DESC LIMIT $4`,
        [input.namespace, input.sessionId, input.toolName, limit]
      );
    } else {
      rows = await this.query(
        `SELECT id, namespace, session_id, tool_name, tool_call_id, args_json, error, summary_json, created_at
         FROM session_tool_cache
         WHERE namespace = $1 AND session_id = $2
         ORDER BY created_at DESC LIMIT $3`,
        [input.namespace, input.sessionId, limit]
      );
    }

    return rows.map((row) => {
      const argsParsed = parseJsonSafe(row.args_json);
      const args =
        argsParsed && typeof argsParsed === "object" && !Array.isArray(argsParsed)
          ? (argsParsed as Record<string, unknown>)
          : {};
      return {
        id: toStr(row.id),
        namespace: toStr(row.namespace),
        sessionId: toStr(row.session_id),
        toolName: toStr(row.tool_name),
        toolCallId: row.tool_call_id ? toStr(row.tool_call_id) : undefined,
        args,
        error: row.error ? toStr(row.error) : undefined,
        summary: row.summary_json ? parseJsonSafe(row.summary_json) : undefined,
        createdAt: toStr(row.created_at)
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
    createdAt: string;
  } | null> {
    const row = await this.queryOne<{
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
    }>(
      `SELECT id, namespace, session_id, tool_name, tool_call_id, args_json, output_json, error, summary_json, created_at
       FROM session_tool_cache
       WHERE namespace = $1 AND session_id = $2 AND id = $3`,
      [input.namespace, input.sessionId, input.id]
    );
    if (!row) return null;

    const argsParsed = parseJsonSafe(row.args_json);
    const args =
      argsParsed && typeof argsParsed === "object" && !Array.isArray(argsParsed)
        ? (argsParsed as Record<string, unknown>)
        : {};

    return {
      id: toStr(row.id),
      namespace: toStr(row.namespace),
      sessionId: toStr(row.session_id),
      toolName: toStr(row.tool_name),
      toolCallId: row.tool_call_id ? toStr(row.tool_call_id) : undefined,
      args,
      output: parseJsonSafe(row.output_json),
      error: row.error ? toStr(row.error) : undefined,
      summary: row.summary_json ? parseJsonSafe(row.summary_json) : undefined,
      createdAt: toStr(row.created_at)
    };
  }

  // ---------------------------------------------------------------------------
  // Webhook security
  // ---------------------------------------------------------------------------

  async clearExpiredWebhookSecurityState(nowIso = new Date().toISOString()): Promise<void> {
    await this.execute(`DELETE FROM webhook_replay_keys WHERE expires_at <= $1`, [nowIso]);
    await this.execute(`DELETE FROM webhook_idempotency WHERE expires_at <= $1`, [nowIso]);
  }

  async hasWebhookReplayKey(replayKey: string): Promise<boolean> {
    const row = await this.queryOne<{ replay_key: string }>(
      `SELECT replay_key FROM webhook_replay_keys WHERE replay_key = $1`,
      [replayKey]
    );
    return Boolean(row);
  }

  async saveWebhookReplayKey(input: { replayKey: string; endpointKey: string; expiresAt: string }): Promise<void> {
    await this.execute(
      `INSERT INTO webhook_replay_keys (replay_key, endpoint_key, created_at, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (replay_key) DO NOTHING`,
      [input.replayKey, input.endpointKey, new Date().toISOString(), input.expiresAt]
    );
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
    const row = await this.queryOne<{
      endpoint_key: string;
      idempotency_key: string;
      request_hash: string;
      status: string;
      result_json: string | null;
      created_at: string;
      updated_at: string;
      expires_at: string;
    }>(
      `SELECT endpoint_key, idempotency_key, request_hash, status, result_json, created_at, updated_at, expires_at
       FROM webhook_idempotency
       WHERE endpoint_key = $1 AND idempotency_key = $2`,
      [input.endpointKey, input.idempotencyKey]
    );
    if (!row) return null;
    return {
      endpointKey: toStr(row.endpoint_key),
      idempotencyKey: toStr(row.idempotency_key),
      requestHash: toStr(row.request_hash),
      status: toStr(row.status),
      result: row.result_json ? parseJsonSafe(row.result_json) : null,
      createdAt: toStr(row.created_at),
      updatedAt: toStr(row.updated_at),
      expiresAt: toStr(row.expires_at)
    };
  }

  async saveWebhookIdempotencyPending(input: {
    endpointKey: string;
    idempotencyKey: string;
    requestHash: string;
    expiresAt: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.execute(
      `INSERT INTO webhook_idempotency (endpoint_key, idempotency_key, request_hash, status, result_json, created_at, updated_at, expires_at)
       VALUES ($1, $2, $3, 'pending', NULL, $4, $5, $6)`,
      [input.endpointKey, input.idempotencyKey, input.requestHash, now, now, input.expiresAt]
    );
  }

  async saveWebhookIdempotencyResult(input: {
    endpointKey: string;
    idempotencyKey: string;
    status: "success" | "error" | "partial" | "waiting_approval";
    result: unknown;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.execute(
      `UPDATE webhook_idempotency SET status = $1, result_json = $2, updated_at = $3
       WHERE endpoint_key = $4 AND idempotency_key = $5`,
      [input.status, JSON.stringify(input.result ?? null), now, input.endpointKey, input.idempotencyKey]
    );
  }

  // ---------------------------------------------------------------------------
  // Execution History
  // ---------------------------------------------------------------------------

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
    error?: string;
  }): Promise<void> {
    await this.execute(
      `INSERT INTO execution_history (id, workflow_id, workflow_name, status, started_at, completed_at, duration_ms, trigger_type, triggered_by, input_json, output_json, node_results_json, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (id) DO UPDATE SET
         workflow_id = EXCLUDED.workflow_id,
         workflow_name = EXCLUDED.workflow_name,
         status = EXCLUDED.status,
         started_at = EXCLUDED.started_at,
         completed_at = EXCLUDED.completed_at,
         duration_ms = EXCLUDED.duration_ms,
         trigger_type = EXCLUDED.trigger_type,
         triggered_by = EXCLUDED.triggered_by,
         input_json = EXCLUDED.input_json,
         output_json = EXCLUDED.output_json,
         node_results_json = EXCLUDED.node_results_json,
         error = EXCLUDED.error`,
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
        input.error ?? null
      ]
    );
  }

  async listExecutionHistory(input: {
    page?: number;
    pageSize?: number;
    status?: string;
    workflowId?: string;
    triggerType?: string;
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
      error: string | null;
      createdAt: string;
    }>;
  }> {
    const page = Math.max(1, Math.floor(input.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(input.pageSize ?? 20)));
    const offset = (page - 1) * pageSize;

    const whereParts: string[] = [];
    const whereParams: unknown[] = [];
    let paramIdx = 1;

    if (input.status) {
      whereParts.push(`status = $${paramIdx++}`);
      whereParams.push(input.status);
    }
    if (input.workflowId) {
      whereParts.push(`workflow_id = $${paramIdx++}`);
      whereParams.push(input.workflowId);
    }
    if (input.triggerType) {
      whereParts.push(`trigger_type = $${paramIdx++}`);
      whereParams.push(input.triggerType);
    }

    const whereClause = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";
    const countRow = await this.queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM execution_history ${whereClause}`,
      whereParams
    );
    const total = countRow ? toNum(countRow.count) : 0;

    const rows = await this.query<{
      id: string;
      workflow_id: string;
      workflow_name: string | null;
      status: string;
      started_at: string;
      completed_at: string | null;
      duration_ms: number | null;
      trigger_type: string | null;
      triggered_by: string | null;
      error: string | null;
      created_at: string;
    }>(
      `SELECT id, workflow_id, workflow_name, status, started_at, completed_at, duration_ms, trigger_type, triggered_by, error, created_at
       FROM execution_history
       ${whereClause}
       ORDER BY started_at DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...whereParams, pageSize, offset]
    );

    return {
      total,
      page,
      pageSize,
      items: rows.map((row) => ({
        id: toStr(row.id),
        workflowId: toStr(row.workflow_id),
        workflowName: row.workflow_name ? toStr(row.workflow_name) : null,
        status: toStr(row.status),
        startedAt: toStr(row.started_at),
        completedAt: row.completed_at ? toStr(row.completed_at) : null,
        durationMs: row.duration_ms === null ? null : toNum(row.duration_ms),
        triggerType: row.trigger_type ? toStr(row.trigger_type) : null,
        triggeredBy: row.triggered_by ? toStr(row.triggered_by) : null,
        error: row.error ? toStr(row.error) : null,
        createdAt: toStr(row.created_at)
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
    error: string | null;
    createdAt: string;
  } | null> {
    const row = await this.queryOne<{
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
      error: string | null;
      created_at: string;
    }>(
      `SELECT id, workflow_id, workflow_name, status, started_at, completed_at, duration_ms, trigger_type, triggered_by, input_json, output_json, node_results_json, error, created_at
       FROM execution_history WHERE id = $1`,
      [id]
    );
    if (!row) return null;
    return {
      id: toStr(row.id),
      workflowId: toStr(row.workflow_id),
      workflowName: row.workflow_name ? toStr(row.workflow_name) : null,
      status: toStr(row.status),
      startedAt: toStr(row.started_at),
      completedAt: row.completed_at ? toStr(row.completed_at) : null,
      durationMs: row.duration_ms === null ? null : toNum(row.duration_ms),
      triggerType: row.trigger_type ? toStr(row.trigger_type) : null,
      triggeredBy: row.triggered_by ? toStr(row.triggered_by) : null,
      input: parseJsonSafe(row.input_json),
      output: parseJsonSafe(row.output_json),
      nodeResults: parseJsonSafe(row.node_results_json),
      error: row.error ? toStr(row.error) : null,
      createdAt: toStr(row.created_at)
    };
  }

  // ---------------------------------------------------------------------------
  // Workflow execution state (approval flows)
  // ---------------------------------------------------------------------------

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
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.execute(
      `INSERT INTO workflow_executions (id, workflow_id, workflow_name, status, waiting_node_id, approval_message, timeout_minutes, trigger_type, triggered_by, started_at, state_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (id) DO UPDATE SET
         workflow_id = EXCLUDED.workflow_id,
         workflow_name = EXCLUDED.workflow_name,
         status = EXCLUDED.status,
         waiting_node_id = EXCLUDED.waiting_node_id,
         approval_message = EXCLUDED.approval_message,
         timeout_minutes = EXCLUDED.timeout_minutes,
         trigger_type = EXCLUDED.trigger_type,
         triggered_by = EXCLUDED.triggered_by,
         started_at = EXCLUDED.started_at,
         state_json = EXCLUDED.state_json,
         updated_at = EXCLUDED.updated_at`,
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
    const row = await this.queryOne<{
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
    }>(
      `SELECT id, workflow_id, workflow_name, status, waiting_node_id, approval_message, timeout_minutes, trigger_type, triggered_by, started_at, state_json, created_at, updated_at
       FROM workflow_executions WHERE id = $1`,
      [id]
    );
    if (!row) return null;
    let state: unknown = null;
    try { state = JSON.parse(toStr(row.state_json)); } catch { state = null; }
    return {
      id: toStr(row.id),
      workflowId: toStr(row.workflow_id),
      workflowName: row.workflow_name ? toStr(row.workflow_name) : null,
      status: toStr(row.status),
      waitingNodeId: toStr(row.waiting_node_id),
      approvalMessage: row.approval_message ? toStr(row.approval_message) : null,
      timeoutMinutes: row.timeout_minutes === null ? null : toNum(row.timeout_minutes),
      triggerType: row.trigger_type ? toStr(row.trigger_type) : null,
      triggeredBy: row.triggered_by ? toStr(row.triggered_by) : null,
      startedAt: toStr(row.started_at),
      state,
      createdAt: toStr(row.created_at),
      updatedAt: toStr(row.updated_at)
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
    const rows = await this.query<{
      id: string;
      workflow_id: string;
      workflow_name: string | null;
      waiting_node_id: string;
      approval_message: string | null;
      timeout_minutes: number | null;
      trigger_type: string | null;
      triggered_by: string | null;
      started_at: string;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, workflow_id, workflow_name, waiting_node_id, approval_message, timeout_minutes, trigger_type, triggered_by, started_at, created_at, updated_at
       FROM workflow_executions
       WHERE status = 'waiting_approval'
       ORDER BY created_at DESC`
    );
    return rows.map((row) => ({
      id: toStr(row.id),
      workflowId: toStr(row.workflow_id),
      workflowName: row.workflow_name ? toStr(row.workflow_name) : null,
      waitingNodeId: toStr(row.waiting_node_id),
      approvalMessage: row.approval_message ? toStr(row.approval_message) : null,
      timeoutMinutes: row.timeout_minutes === null ? null : toNum(row.timeout_minutes),
      triggerType: row.trigger_type ? toStr(row.trigger_type) : null,
      triggeredBy: row.triggered_by ? toStr(row.triggered_by) : null,
      startedAt: toStr(row.started_at),
      createdAt: toStr(row.created_at),
      updatedAt: toStr(row.updated_at)
    }));
  }

  async deleteWorkflowExecution(id: string): Promise<boolean> {
    const result = await this.pool.query(`DELETE FROM workflow_executions WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  // ---------------------------------------------------------------------------
  // Execution Queue
  // ---------------------------------------------------------------------------

  async enqueueExecution(input: {
    id: string;
    workflowId: string;
    workflowName?: string;
    payload: Record<string, unknown>;
    priority?: number;
    maxAttempts?: number;
    scheduledAt?: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.execute(
      `INSERT INTO execution_queue (id, workflow_id, workflow_name, payload_json, status, priority, attempts, max_attempts, last_error, scheduled_at, started_at, completed_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'pending', $5, 0, $6, NULL, $7, NULL, NULL, $8, $9)
       ON CONFLICT (id) DO NOTHING`,
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
    const rows = await this.query<{
      id: string;
      workflow_id: string;
      workflow_name: string | null;
      payload_json: string;
      attempts: number;
      max_attempts: number;
      scheduled_at: string;
    }>(
      `SELECT id, workflow_id, workflow_name, payload_json, attempts, max_attempts, scheduled_at
       FROM execution_queue
       WHERE status = 'pending' AND scheduled_at <= $1
       ORDER BY priority DESC, scheduled_at ASC
       LIMIT $2`,
      [now, limit]
    );

    if (rows.length === 0) return [];

    for (const row of rows) {
      await this.execute(
        `UPDATE execution_queue SET status = 'running', started_at = $1, updated_at = $2 WHERE id = $3`,
        [now, now, row.id]
      );
    }

    return rows.map((row) => {
      let payload: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(toStr(row.payload_json));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          payload = parsed as Record<string, unknown>;
        }
      } catch { /* ignore */ }
      return {
        id: toStr(row.id),
        workflowId: toStr(row.workflow_id),
        workflowName: row.workflow_name ? toStr(row.workflow_name) : null,
        payload,
        attempts: toNum(row.attempts),
        maxAttempts: toNum(row.max_attempts),
        scheduledAt: toStr(row.scheduled_at)
      };
    });
  }

  async markQueueItemRunning(id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.execute(
      `UPDATE execution_queue SET status = 'running', started_at = $1, updated_at = $2 WHERE id = $3`,
      [now, now, id]
    );
  }

  async markQueueItemCompleted(id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.execute(
      `UPDATE execution_queue SET status = 'completed', completed_at = $1, updated_at = $2 WHERE id = $3`,
      [now, now, id]
    );
  }

  async markQueueItemFailed(id: string, error: string): Promise<void> {
    const now = new Date().toISOString();
    const row = await this.queryOne<{
      id: string;
      workflow_id: string;
      workflow_name: string | null;
      payload_json: string;
      attempts: number;
      max_attempts: number;
    }>(
      `SELECT id, workflow_id, workflow_name, payload_json, attempts, max_attempts FROM execution_queue WHERE id = $1`,
      [id]
    );
    if (!row) return;

    const attempts = toNum(row.attempts) + 1;
    const maxAttempts = toNum(row.max_attempts);

    if (attempts >= maxAttempts) {
      const dlqId = randomUUID();
      await this.execute(
        `INSERT INTO execution_queue_dlq (id, original_id, workflow_id, workflow_name, payload_json, attempts, final_error, failed_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          dlqId,
          toStr(row.id),
          toStr(row.workflow_id),
          row.workflow_name ? toStr(row.workflow_name) : null,
          toStr(row.payload_json),
          attempts,
          error,
          now,
          now
        ]
      );
      await this.execute(
        `UPDATE execution_queue SET status = 'dead', attempts = $1, last_error = $2, updated_at = $3 WHERE id = $4`,
        [attempts, error, now, id]
      );
    } else {
      const backoffMs = 1000 * Math.pow(2, attempts - 1);
      const retryAt = new Date(Date.now() + backoffMs).toISOString();
      await this.execute(
        `UPDATE execution_queue SET status = 'pending', attempts = $1, last_error = $2, scheduled_at = $3, updated_at = $4 WHERE id = $5`,
        [attempts, error, retryAt, now, id]
      );
    }
  }

  async requeueStuckItems(stuckAfterMs = 600_000): Promise<number> {
    const stuckBefore = new Date(Date.now() - stuckAfterMs).toISOString();
    const now = new Date().toISOString();
    const result = await this.pool.query(
      `UPDATE execution_queue SET status = 'pending', started_at = NULL, updated_at = $1
       WHERE status = 'running' AND started_at <= $2`,
      [now, stuckBefore]
    );
    return result.rowCount ?? 0;
  }

  async getQueueDepth(): Promise<{ pending: number; running: number; dlq: number }> {
    const pendingRow = await this.queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM execution_queue WHERE status = 'pending'`
    );
    const runningRow = await this.queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM execution_queue WHERE status = 'running'`
    );
    const dlqRow = await this.queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM execution_queue_dlq`
    );
    return {
      pending: pendingRow ? toNum(pendingRow.count) : 0,
      running: runningRow ? toNum(runningRow.count) : 0,
      dlq: dlqRow ? toNum(dlqRow.count) : 0
    };
  }

  async listDlqItems(limit = 50): Promise<Array<{
    id: string;
    originalId: string;
    workflowId: string;
    workflowName: string | null;
    attempts: number;
    finalError: string;
    failedAt: string;
  }>> {
    const rows = await this.query<{
      id: string;
      original_id: string;
      workflow_id: string;
      workflow_name: string | null;
      attempts: number;
      final_error: string;
      failed_at: string;
    }>(
      `SELECT id, original_id, workflow_id, workflow_name, attempts, final_error, failed_at
       FROM execution_queue_dlq
       ORDER BY failed_at DESC
       LIMIT $1`,
      [limit]
    );
    return rows.map((row) => ({
      id: toStr(row.id),
      originalId: toStr(row.original_id),
      workflowId: toStr(row.workflow_id),
      workflowName: row.workflow_name ? toStr(row.workflow_name) : null,
      attempts: toNum(row.attempts),
      finalError: toStr(row.final_error),
      failedAt: toStr(row.failed_at)
    }));
  }
}
