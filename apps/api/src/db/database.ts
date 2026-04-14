import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import initSqlJs, { type BindParams, type Database as SQLDatabase } from "sql.js";
import type { ChatMessage, Workflow, WorkflowListItem } from "@ai-orchestrator/shared";

const require = createRequire(import.meta.url);

interface WorkflowRow {
  id: string;
  name: string;
  schema_version: string;
  workflow_version: number;
  workflow_json: string;
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

function toString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function toNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function parseJsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(toString(value));
  } catch {
    return null;
  }
}

const MAX_SESSION_TOOL_CACHE_RECORDS = 400;

export class SqliteStore {
  private constructor(
    private readonly db: SQLDatabase,
    private readonly dbFilePath: string
  ) {
    this.migrate();
  }

  static async create(dbFilePath: string): Promise<SqliteStore> {
    const absolutePath = path.resolve(dbFilePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });

    const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
    const SQL = await initSqlJs({
      locateFile: () => wasmPath
    });

    const dbBuffer = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath) : undefined;
    const db = dbBuffer ? new SQL.Database(dbBuffer) : new SQL.Database();

    return new SqliteStore(db, absolutePath);
  }

  private migrate(): void {
    this.db.run(`
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
    `);

    this.persist();
  }

  private persist(): void {
    const data = this.db.export();
    fs.writeFileSync(this.dbFilePath, Buffer.from(data));
  }

  private queryAll<T extends object>(sql: string, params?: BindParams): T[] {
    const stmt = this.db.prepare(sql);
    try {
      if (params !== undefined) {
        stmt.bind(params);
      }

      const rows: T[] = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject() as T);
      }
      return rows;
    } finally {
      stmt.free();
    }
  }

  private queryOne<T extends object>(sql: string, params?: BindParams): T | null {
    const rows = this.queryAll<T>(sql, params);
    return rows[0] ?? null;
  }

  listWorkflows(): WorkflowListItem[] {
    const rows = this.queryAll<WorkflowRow>(
      `SELECT id, name, schema_version, workflow_version, created_at, updated_at, workflow_json
       FROM workflows
       ORDER BY updated_at DESC`
    );

    return rows.map((row) => ({
      id: toString(row.id),
      name: toString(row.name),
      schemaVersion: toString(row.schema_version),
      workflowVersion: toNumber(row.workflow_version),
      createdAt: toString(row.created_at),
      updatedAt: toString(row.updated_at)
    }));
  }

  getWorkflow(id: string): Workflow | null {
    const row = this.queryOne<WorkflowRow>(
      `SELECT id, name, schema_version, workflow_version, workflow_json, created_at, updated_at
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
    return parsed;
  }

  upsertWorkflow(workflow: Workflow): Workflow {
    const now = new Date().toISOString();
    const existing = this.getWorkflow(workflow.id);
    const createdAt = existing?.createdAt ?? now;
    const updatedAt = now;

    const payload: Workflow = {
      ...workflow,
      createdAt,
      updatedAt
    };

    this.db.run(
      `INSERT INTO workflows (id, name, schema_version, workflow_version, workflow_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         schema_version = excluded.schema_version,
         workflow_version = excluded.workflow_version,
         workflow_json = excluded.workflow_json,
         updated_at = excluded.updated_at`,
      [
        payload.id,
        payload.name,
        payload.schemaVersion,
        payload.workflowVersion,
        JSON.stringify(payload),
        createdAt,
        updatedAt
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
        this.db.run("PRAGMA foreign_keys = OFF");
      }

      if (hasTable("execution_history")) {
        this.db.run("DELETE FROM execution_history WHERE workflow_id = ?", [id]);
      }

      if (hasTable("workflow_executions")) {
        this.db.run("DELETE FROM workflow_executions WHERE workflow_id = ?", [id]);
      }

      this.db.run("DELETE FROM workflows WHERE id = ?", [id]);

      const changesRow = this.queryOne<{ count: number }>("SELECT changes() as count");
      const changed = (changesRow ? toNumber(changesRow.count) : 0) > 0;
      this.persist();
      return changed;
    } finally {
      if (foreignKeysWereOn) {
        this.db.run("PRAGMA foreign_keys = ON");
      }
    }
  }

  countWorkflows(): number {
    const row = this.queryOne<{ count: number }>("SELECT COUNT(*) as count FROM workflows");
    return row ? toNumber(row.count) : 0;
  }

  listSecrets(): Array<Pick<SecretRow, "id" | "name" | "provider" | "created_at">> {
    const rows = this.queryAll<SecretRow>(
      `SELECT id, name, provider, iv, auth_tag, ciphertext, created_at FROM secrets ORDER BY created_at DESC`
    );

    return rows.map((row) => ({
      id: toString(row.id),
      name: toString(row.name),
      provider: toString(row.provider),
      created_at: toString(row.created_at)
    }));
  }

  getSecret(id: string): SecretRow | null {
    const row = this.queryOne<SecretRow>(
      `SELECT id, name, provider, iv, auth_tag, ciphertext, created_at FROM secrets WHERE id = ?`,
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
      created_at: toString(row.created_at)
    };
  }

  saveSecret(input: {
    id: string;
    name: string;
    provider: string;
    iv: string;
    authTag: string;
    ciphertext: string;
  }): void {
    this.db.run(
      `INSERT INTO secrets (id, name, provider, iv, auth_tag, ciphertext, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         provider = excluded.provider,
         iv = excluded.iv,
         auth_tag = excluded.auth_tag,
         ciphertext = excluded.ciphertext`,
      [
        input.id,
        input.name,
        input.provider,
        input.iv,
        input.authTag,
        input.ciphertext,
        new Date().toISOString()
      ]
    );

    this.persist();
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

    this.db.run(
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

    this.db.run(
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
    this.db.run(
      `UPDATE sessions
       SET last_seen_at = ?
       WHERE id = ? AND revoked_at IS NULL`,
      [new Date().toISOString(), sessionId]
    );
    this.persist();
  }

  revokeSession(sessionId: string): void {
    this.db.run(
      `UPDATE sessions
       SET revoked_at = ?
       WHERE id = ? AND revoked_at IS NULL`,
      [new Date().toISOString(), sessionId]
    );
    this.persist();
  }

  revokeExpiredSessions(): void {
    this.db.run(
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

    this.db.run(
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

    this.db.run(
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

    this.db.run(
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

  clearExpiredWebhookSecurityState(nowIso = new Date().toISOString()): void {
    this.db.run(`DELETE FROM webhook_replay_keys WHERE expires_at <= ?`, [nowIso]);
    this.db.run(`DELETE FROM webhook_idempotency WHERE expires_at <= ?`, [nowIso]);
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
    this.db.run(
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
    this.db.run(
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
    status: "success" | "error" | "partial" | "waiting_approval";
    result: unknown;
  }): void {
    const now = new Date().toISOString();
    this.db.run(
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
    error?: string;
  }): void {
    this.db.run(
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
          error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      error: row.error ? toString(row.error) : null,
      createdAt: toString(row.created_at)
    };
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
    this.db.run(
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
    this.db.run("DELETE FROM workflow_executions WHERE id = ?", [id]);
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
    this.db.run(
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
      this.db.run(
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
    this.db.run(
      `UPDATE execution_queue SET status = 'running', started_at = ?, updated_at = ? WHERE id = ?`,
      [now, now, id]
    );
    this.persist();
  }

  markQueueItemCompleted(id: string): void {
    const now = new Date().toISOString();
    this.db.run(
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
      this.db.run(
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
      this.db.run(`UPDATE execution_queue SET status = 'dead', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?`, [
        attempts,
        error,
        now,
        id
      ]);
    } else {
      // Exponential backoff: 1000 * 2^(attempts-1) ms
      const backoffMs = 1000 * Math.pow(2, attempts - 1);
      const retryAt = new Date(Date.now() + backoffMs).toISOString();
      this.db.run(
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
      this.db.run(
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
}
