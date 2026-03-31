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
}
