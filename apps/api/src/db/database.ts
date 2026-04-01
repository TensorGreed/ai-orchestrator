import fs from "node:fs";
import path from "node:path";
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

function toString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function toNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

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
    const before = this.countWorkflows();
    this.db.run("DELETE FROM workflows WHERE id = ?", [id]);
    const after = this.countWorkflows();
    const changed = after < before;
    if (changed) {
      this.persist();
    }
    return changed;
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
    status: "success" | "error" | "partial";
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
}
