export interface Migration {
  version: number;
  description: string;
  up: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "Initial schema",
    up: `
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        workflow_version INTEGER NOT NULL,
        workflow_json TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS secrets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_memory (
        namespace TEXT NOT NULL,
        session_id TEXT NOT NULL,
        messages_json TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
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
        created_at TIMESTAMPTZ NOT NULL
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
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        last_seen_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS webhook_replay_keys (
        replay_key TEXT PRIMARY KEY,
        endpoint_key TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_webhook_replay_expires_at
      ON webhook_replay_keys(expires_at);

      CREATE TABLE IF NOT EXISTS webhook_idempotency (
        endpoint_key TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (endpoint_key, idempotency_key)
      );

      CREATE INDEX IF NOT EXISTS idx_webhook_idempotency_expires_at
      ON webhook_idempotency(expires_at);

      CREATE TABLE IF NOT EXISTS execution_history (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        workflow_name TEXT,
        status TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ,
        duration_ms INTEGER,
        trigger_type TEXT,
        triggered_by TEXT,
        input_json TEXT,
        output_json TEXT,
        node_results_json TEXT,
        error TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
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
        started_at TIMESTAMPTZ NOT NULL,
        state_json TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_workflow_executions_status
      ON workflow_executions(status);
    `
  },
  {
    version: 2,
    description: "Add execution queue tables",
    up: `
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
        scheduled_at TIMESTAMPTZ NOT NULL,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
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
        failed_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      );
    `
  },
  {
    version: 3,
    description: "Add trigger state (Phase 3.5)",
    up: `
      CREATE TABLE IF NOT EXISTS trigger_state (
        workflow_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        trigger_type TEXT NOT NULL,
        state_json TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (workflow_id, node_id)
      );
    `
  }
];

export async function runMigrations(
  runSql: (sql: string) => Promise<void>,
  getCurrentVersion: () => Promise<number>,
  setVersion: (version: number) => Promise<void>
): Promise<void> {
  const currentVersion = await getCurrentVersion();
  const pending = MIGRATIONS.filter((m) => m.version > currentVersion).sort((a, b) => a.version - b.version);
  for (const migration of pending) {
    await runSql(migration.up);
    await setVersion(migration.version);
  }
}
