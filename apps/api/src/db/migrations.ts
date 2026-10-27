export interface Migration {
  version: number;
  description: string;
  up: string;
  /**
   * SQL that reverses `up`. DESTRUCTIVE — running rollbackMigrations drops
   * the tables/columns created by this migration AND any data they hold.
   *
   * Provided for every migration so `pnpm --filter @ai-orchestrator/api
   * db:rollback --to <version> --yes` can walk a Postgres deployment back
   * to an older schema during a botched-deploy recovery.
   *
   * IMPORTANT: the SQLite store (apps/api/src/db/database.ts) does NOT use
   * this migration array — it has its own embedded `migrate()` method that
   * `CREATE TABLE IF NOT EXISTS`-es the entire schema in one shot. SQLite
   * users running the rollback CLI will get a clear error; the SQLite
   * "rollback" recipe is `rm apps/api/data/orchestrator.db && restart`.
   */
  down: string;
}

/**
 * v40: the Postgres tables whose SQLite queries order by rowid (insertion order). `backfillOrder` numbers the rows
 * that exist when v40 runs, in the order the store listed them before (created_at / started_at, then id).
 */
export const INSERTION_SEQ_TABLES: ReadonlyArray<{ table: string; backfillOrder: string }> = [
  { table: "audit_logs", backfillOrder: `created_at, id COLLATE "C"` },
  { table: "knowledge_base_chunks", backfillOrder: `created_at, id COLLATE "C"` },
  { table: "session_tool_cache", backfillOrder: `created_at, id COLLATE "C"` },
  { table: "mcp_server_probes", backfillOrder: `started_at, id COLLATE "C"` },
  { table: "mcp_tool_snapshots", backfillOrder: `created_at, id COLLATE "C"` },
  { table: "mcp_tool_calls", backfillOrder: `started_at, created_at, id COLLATE "C"` },
  { table: "mcp_elicitations", backfillOrder: `created_at, id COLLATE "C"` },
  { table: "mcp_tool_policies", backfillOrder: `created_at, id COLLATE "C"` },
  { table: "mcp_toolset_members", backfillOrder: `toolset_id COLLATE "C", position, id COLLATE "C"` },
  { table: "mcp_clients", backfillOrder: `created_at, id COLLATE "C"` },
  // Governance tables (q3b): eval, replay, capture, guard simulations and the data-subject lookup.
  { table: "eval_fixtures", backfillOrder: `created_at, id COLLATE "C"` },
  { table: "eval_runs", backfillOrder: `started_at, id COLLATE "C"` },
  { table: "eval_results", backfillOrder: `created_at, id COLLATE "C"` },
  { table: "mcp_cassettes", backfillOrder: `created_at, id COLLATE "C"` },
  { table: "replay_recordings", backfillOrder: `created_at, id COLLATE "C"` },
  { table: "guard_simulations", backfillOrder: `created_at, id COLLATE "C"` },
  { table: "execution_history", backfillOrder: `started_at, id COLLATE "C"` }
];

/**
 * v40: the Postgres columns created as REAL (float4, about 7 significant digits) where SQLite's REAL is an 8-byte
 * double. Up widens them through text, so a stored 0.1 stays 0.1; down narrows them back.
 */
export const WIDENED_REAL_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: "usage_events", column: "cost_usd" },
  { table: "budgets", column: "limit_value" },
  { table: "budgets", column: "warn_threshold_pct" },
  { table: "budget_alerts", column: "usage_value" },
  { table: "budget_alerts", column: "limit_value" }
];

/** v40: the tables the data-subject lookup pages by `seq` (postgres/data-labels.ts); each gets a unique seq index. */
export const SUBJECT_SEQ_TABLES: ReadonlyArray<string> = [
  "replay_recordings",
  "eval_fixtures",
  "eval_results",
  "execution_history",
  "mcp_cassettes"
];

/** Adds `seq BIGINT NOT NULL GENERATED ALWAYS AS IDENTITY` to `table`, numbering existing rows by `backfillOrder`. */
function insertionSeqUp(table: string, backfillOrder: string): string {
  return `
      ALTER TABLE ${table} ADD COLUMN seq BIGINT;
      UPDATE ${table} AS t SET seq = o.n
        FROM (SELECT id, row_number() OVER (ORDER BY ${backfillOrder}) AS n FROM ${table}) AS o
       WHERE t.id = o.id;
      ALTER TABLE ${table} ALTER COLUMN seq SET NOT NULL;
      ALTER TABLE ${table} ALTER COLUMN seq ADD GENERATED ALWAYS AS IDENTITY;
      SELECT setval(pg_get_serial_sequence('${table}', 'seq'), COALESCE((SELECT MAX(seq) FROM ${table}), 0) + 1, false);`;
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
        custom_data_json TEXT,
        error TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_execution_history_started_at
      ON execution_history(started_at DESC);

      CREATE INDEX IF NOT EXISTS idx_execution_history_status
      ON execution_history(status);

      CREATE INDEX IF NOT EXISTS idx_execution_history_workflow_id
      ON execution_history(workflow_id);

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
    `,
    down: `
      DROP TABLE IF EXISTS workflow_executions;
      DROP TABLE IF EXISTS execution_history;
      DROP TABLE IF EXISTS webhook_idempotency;
      DROP TABLE IF EXISTS webhook_replay_keys;
      DROP TABLE IF EXISTS sessions;
      DROP TABLE IF EXISTS users;
      DROP TABLE IF EXISTS session_tool_cache;
      DROP TABLE IF EXISTS session_memory;
      DROP TABLE IF EXISTS secrets;
      DROP TABLE IF EXISTS workflows;
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
    `,
    down: `
      DROP TABLE IF EXISTS execution_queue_dlq;
      DROP TABLE IF EXISTS execution_queue;
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
    `,
    down: `
      DROP TABLE IF EXISTS trigger_state;
    `
  },
  {
    version: 4,
    description: "Workflow organization — projects, folders, tags, workflow project/folder FKs (Phase 4.2)",
    up: `
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS folders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        parent_id TEXT,
        project_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_folders_project_id ON folders(project_id);
      CREATE INDEX IF NOT EXISTS idx_folders_parent_id ON folders(parent_id);

      ALTER TABLE workflows ADD COLUMN tags_json TEXT DEFAULT '[]';
      ALTER TABLE workflows ADD COLUMN project_id TEXT DEFAULT 'default';
      ALTER TABLE workflows ADD COLUMN folder_id TEXT;

      ALTER TABLE secrets ADD COLUMN project_id TEXT DEFAULT 'default';

      CREATE INDEX IF NOT EXISTS idx_workflows_project_id ON workflows(project_id);
      CREATE INDEX IF NOT EXISTS idx_workflows_folder_id ON workflows(folder_id);
      CREATE INDEX IF NOT EXISTS idx_secrets_project_id ON secrets(project_id);
    `,
    down: `
      DROP INDEX IF EXISTS idx_secrets_project_id;
      DROP INDEX IF EXISTS idx_workflows_folder_id;
      DROP INDEX IF EXISTS idx_workflows_project_id;
      ALTER TABLE secrets DROP COLUMN IF EXISTS project_id;
      ALTER TABLE workflows DROP COLUMN IF EXISTS folder_id;
      ALTER TABLE workflows DROP COLUMN IF EXISTS project_id;
      ALTER TABLE workflows DROP COLUMN IF EXISTS tags_json;
      DROP INDEX IF EXISTS idx_folders_parent_id;
      DROP INDEX IF EXISTS idx_folders_project_id;
      DROP TABLE IF EXISTS folders;
      DROP TABLE IF EXISTS projects;
    `
  },
  {
    version: 5,
    description: "Execution history custom metadata and filter indexes (Phase 4.4)",
    up: `
      ALTER TABLE execution_history ADD COLUMN IF NOT EXISTS custom_data_json TEXT;

      CREATE INDEX IF NOT EXISTS idx_execution_history_status
      ON execution_history(status);

      CREATE INDEX IF NOT EXISTS idx_execution_history_workflow_id
      ON execution_history(workflow_id);
    `,
    down: `
      -- v1 already created these indexes; v5 is a no-op re-create. Don't drop
      -- them on rollback or v1's invariants break. We only undo the column add.
      ALTER TABLE execution_history DROP COLUMN IF EXISTS custom_data_json;
    `
  },
  {
    version: 6,
    description: "Enterprise auth + advanced RBAC (Phase 5.1/5.2): API keys, MFA, SSO identities, project roles, custom roles, workflow/secret sharing",
    up: `
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        scopes_json TEXT NOT NULL DEFAULT '[]',
        last_used_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
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
        activated_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS sso_identities (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        subject TEXT NOT NULL,
        email TEXT,
        attributes_json TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE(provider, subject),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE INDEX IF NOT EXISTS idx_sso_identities_user_id ON sso_identities(user_id);

      CREATE TABLE IF NOT EXISTS user_project_roles (
        user_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        role TEXT NOT NULL,
        custom_role_id TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (user_id, project_id),
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (project_id) REFERENCES projects(id)
      );

      CREATE INDEX IF NOT EXISTS idx_user_project_roles_project_id ON user_project_roles(project_id);

      CREATE TABLE IF NOT EXISTS custom_roles (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        name TEXT NOT NULL,
        description TEXT,
        permissions_json TEXT NOT NULL DEFAULT '[]',
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_custom_roles_project_id ON custom_roles(project_id);

      CREATE TABLE IF NOT EXISTS workflow_shares (
        workflow_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        access_level TEXT NOT NULL DEFAULT 'read',
        shared_by TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (workflow_id, project_id)
      );

      CREATE INDEX IF NOT EXISTS idx_workflow_shares_project_id ON workflow_shares(project_id);

      CREATE TABLE IF NOT EXISTS secret_shares (
        secret_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        shared_by TEXT,
        created_at TIMESTAMPTZ NOT NULL,
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
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sso_group_mappings_provider_group ON sso_group_mappings(provider, group_name);
    `,
    down: `
      DROP TABLE IF EXISTS sso_group_mappings;
      DROP TABLE IF EXISTS secret_shares;
      DROP TABLE IF EXISTS workflow_shares;
      DROP TABLE IF EXISTS custom_roles;
      DROP TABLE IF EXISTS user_project_roles;
      DROP TABLE IF EXISTS sso_identities;
      DROP TABLE IF EXISTS mfa_secrets;
      DROP TABLE IF EXISTS api_keys;
    `
  },
  {
    version: 7,
    description: "External secrets providers + rotation cache + comprehensive audit log (Phase 5.3/5.4)",
    up: `
      CREATE TABLE IF NOT EXISTS external_secret_providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        config_json TEXT NOT NULL DEFAULT '{}',
        credentials_secret_id TEXT,
        cache_ttl_ms INTEGER NOT NULL DEFAULT 300000,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_external_secret_providers_type ON external_secret_providers(type);

      CREATE TABLE IF NOT EXISTS external_secret_cache (
        secret_id TEXT PRIMARY KEY,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        fetched_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_external_secret_cache_expires_at ON external_secret_cache(expires_at);

      ALTER TABLE secrets ADD COLUMN source TEXT DEFAULT 'local';
      ALTER TABLE secrets ADD COLUMN external_provider_id TEXT;
      ALTER TABLE secrets ADD COLUMN external_key TEXT;

      CREATE INDEX IF NOT EXISTS idx_secrets_external_provider_id ON secrets(external_provider_id);

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
        created_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_category ON audit_logs(category);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_user_id ON audit_logs(actor_user_id);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_resource_type ON audit_logs(resource_type);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_outcome ON audit_logs(outcome);
    `,
    down: `
      DROP TABLE IF EXISTS audit_logs;
      DROP INDEX IF EXISTS idx_secrets_external_provider_id;
      ALTER TABLE secrets DROP COLUMN IF EXISTS external_key;
      ALTER TABLE secrets DROP COLUMN IF EXISTS external_provider_id;
      ALTER TABLE secrets DROP COLUMN IF EXISTS source;
      DROP TABLE IF EXISTS external_secret_cache;
      DROP TABLE IF EXISTS external_secret_providers;
    `
  },
  {
    version: 8,
    description: "Log streaming destinations + delivery history (Phase 5.5)",
    up: `
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
        last_success_at TIMESTAMPTZ,
        last_error_at TIMESTAMPTZ,
        last_error TEXT,
        dispatched_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
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
        created_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_log_stream_events_destination_created
        ON log_stream_events(destination_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_log_stream_events_status ON log_stream_events(status);
      CREATE INDEX IF NOT EXISTS idx_log_stream_events_created_at ON log_stream_events(created_at);
    `,
    down: `
      DROP TABLE IF EXISTS log_stream_events;
      DROP TABLE IF EXISTS log_stream_destinations;
    `
  },
  {
    version: 9,
    description: "Version control & environments (Phase 5.6): variables, workflow_versions, git_configs",
    up: `
      CREATE TABLE IF NOT EXISTS variables (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
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
        created_at TIMESTAMPTZ NOT NULL,
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
        last_push_at TIMESTAMPTZ,
        last_pull_at TIMESTAMPTZ,
        last_error TEXT,
        updated_at TIMESTAMPTZ NOT NULL
      );
    `,
    down: `
      DROP TABLE IF EXISTS git_configs;
      DROP TABLE IF EXISTS workflow_versions;
      DROP TABLE IF EXISTS variables;
    `
  },
  {
    version: 10,
    description: "Multi-main HA leader election (Phase 7.1)",
    up: `
      CREATE TABLE IF NOT EXISTS leader_leases (
        lease_name TEXT PRIMARY KEY,
        holder_id TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        acquired_at TIMESTAMPTZ NOT NULL,
        renewed_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_leader_leases_expires_at ON leader_leases(expires_at);
    `,
    down: `
      DROP TABLE IF EXISTS leader_leases;
    `
  },
  {
    version: 11,
    description: "Workflow templates & sharing (Phase 7.4)",
    up: `
      CREATE TABLE IF NOT EXISTS workflow_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT 'General',
        tags TEXT NOT NULL DEFAULT '[]',
        author TEXT NOT NULL DEFAULT 'ai-orchestrator',
        workflow_json TEXT NOT NULL,
        node_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_workflow_templates_category ON workflow_templates(category);
    `,
    down: `
      DROP TABLE IF EXISTS workflow_templates;
    `
  },
  {
    version: 12,
    description: "Notification configs (Phase 7.5)",
    up: `
      CREATE TABLE IF NOT EXISTS notification_configs (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        config_json TEXT NOT NULL DEFAULT '{}',
        events TEXT NOT NULL DEFAULT '["execution.failure"]',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
    down: `
      DROP TABLE IF EXISTS notification_configs;
    `
  },
  {
    version: 13,
    description: "Session artifact storage for deterministic multi-turn workflows",
    up: `
      CREATE TABLE IF NOT EXISTS session_artifacts (
        namespace TEXT NOT NULL,
        session_id TEXT NOT NULL,
        artifact_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (namespace, session_id, artifact_key)
      );

      CREATE INDEX IF NOT EXISTS idx_session_artifacts_namespace_session_updated_at
      ON session_artifacts(namespace, session_id, updated_at DESC);
    `,
    down: `
      DROP TABLE IF EXISTS session_artifacts;
    `
  },
  {
    version: 14,
    description: "Agent eval framework — datasets, fixtures, runs, per-fixture results (Phase 7.3)",
    up: `
      CREATE TABLE IF NOT EXISTS eval_datasets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        project_id TEXT,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_eval_datasets_project ON eval_datasets(project_id);

      CREATE TABLE IF NOT EXISTS eval_fixtures (
        id TEXT PRIMARY KEY,
        dataset_id TEXT NOT NULL,
        name TEXT NOT NULL,
        input_json TEXT NOT NULL,
        expected_json TEXT,
        scorers_json TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_eval_fixtures_dataset ON eval_fixtures(dataset_id);

      CREATE TABLE IF NOT EXISTS eval_runs (
        id TEXT PRIMARY KEY,
        dataset_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        workflow_name TEXT,
        status TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ,
        triggered_by TEXT,
        scorers_json TEXT,
        summary_json TEXT,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL
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
        created_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_eval_results_run ON eval_results(run_id);
      CREATE INDEX IF NOT EXISTS idx_eval_results_fixture ON eval_results(fixture_id);
    `,
    down: `
      DROP TABLE IF EXISTS eval_results;
      DROP TABLE IF EXISTS eval_runs;
      DROP TABLE IF EXISTS eval_fixtures;
      DROP TABLE IF EXISTS eval_datasets;
    `
  },
  {
    version: 15,
    description: "Phase 8.2 — usage_events for FinOps cost rollups (one row per execution)",
    up: `
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
        created_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_usage_events_created_at ON usage_events(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_usage_events_workflow_created ON usage_events(workflow_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_usage_events_user_created ON usage_events(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_usage_events_project_created ON usage_events(project_id, created_at DESC);
    `,
    down: `
      DROP TABLE IF EXISTS usage_events;
    `
  },
  {
    version: 16,
    description: "Phase 8.3 — budgets + budget_alerts (spend caps with warn/block actions)",
    up: `
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
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
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
        fired_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_budget_alerts_budget ON budget_alerts(budget_id);
      CREATE INDEX IF NOT EXISTS idx_budget_alerts_fired_at ON budget_alerts(fired_at DESC);
    `,
    down: `
      DROP TABLE IF EXISTS budget_alerts;
      DROP TABLE IF EXISTS budgets;
    `
  },
  {
    version: 17,
    description: "Phase 8.4 — audit log hash chain (tamper-evidence) + export destinations",
    up: `
      -- IF NOT EXISTS: the down keeps these columns (tamper evidence), so a rollback past v17 and a re-apply must not fail.
      ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS prev_hash TEXT;
      ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS entry_hash TEXT;

      CREATE TABLE IF NOT EXISTS audit_export_destinations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        config_json TEXT NOT NULL,
        interval_seconds INTEGER NOT NULL DEFAULT 3600,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_export_id TEXT,
        last_export_at TIMESTAMPTZ,
        last_status TEXT,
        last_error TEXT,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_export_destinations_enabled ON audit_export_destinations(enabled);

      CREATE TABLE IF NOT EXISTS audit_export_runs (
        id TEXT PRIMARY KEY,
        destination_id TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ,
        status TEXT NOT NULL,
        rows_exported INTEGER NOT NULL DEFAULT 0,
        first_id TEXT,
        last_id TEXT,
        error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_audit_export_runs_dest ON audit_export_runs(destination_id, started_at DESC);
    `,
    down: `
      DROP TABLE IF EXISTS audit_export_runs;
      DROP TABLE IF EXISTS audit_export_destinations;
      -- ALTER TABLE DROP COLUMN is unsupported on Postgres pre-9.x and SQLite
      -- pre-3.35; rolling back the chain columns is intentionally a no-op so
      -- we don't lose tamper-evidence data on a downgrade.
    `
  },
  {
    version: 18,
    description: "Phase 9.1 — built-in persistent vector store (knowledge_bases + knowledge_base_chunks)",
    up: `
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
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
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
        created_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_kb_chunks_kb_id ON knowledge_base_chunks(knowledge_base_id);
      CREATE INDEX IF NOT EXISTS idx_kb_chunks_source ON knowledge_base_chunks(knowledge_base_id, source_id);
    `,
    down: `
      DROP TABLE IF EXISTS knowledge_base_chunks;
      DROP TABLE IF EXISTS knowledge_bases;
    `
  },
  {
    version: 19,
    description: "Phase 9.3 — full-text index over knowledge_base_chunks for hybrid search (a generated tsvector + GIN; SQLite uses FTS5 BM25)",
    up: `
      ALTER TABLE knowledge_base_chunks
        ADD COLUMN IF NOT EXISTS content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;
      CREATE INDEX IF NOT EXISTS idx_kb_chunks_content_tsv ON knowledge_base_chunks USING GIN (content_tsv);
    `,
    down: `
      DROP INDEX IF EXISTS idx_kb_chunks_content_tsv;
      ALTER TABLE knowledge_base_chunks DROP COLUMN IF EXISTS content_tsv;
    `
  },
  {
    version: 20,
    description: "Phase 10.1 — MCP server registry (mcp_servers, mcp_server_probes, mcp_tool_snapshots)",
    up: `
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
        last_probe_at TIMESTAMPTZ,
        last_probe_ok INTEGER,
        last_probe_latency_ms INTEGER,
        last_probe_error TEXT,
        tool_count INTEGER NOT NULL DEFAULT 0,
        current_snapshot_id TEXT,
        pending_breaking_snapshot_id TEXT,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_mcp_servers_project ON mcp_servers(project_id);

      CREATE TABLE IF NOT EXISTS mcp_server_probes (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL,
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
        acknowledged_at TIMESTAMPTZ,
        acknowledged_by TEXT,
        created_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_mcp_tool_snapshots_server ON mcp_tool_snapshots(server_id, created_at DESC);
    `,
    down: `
      DROP TABLE IF EXISTS mcp_tool_snapshots;
      DROP TABLE IF EXISTS mcp_server_probes;
      DROP TABLE IF EXISTS mcp_servers;
    `
  },
  {
    version: 21,
    description: "Phase 10.1 — per-tool MCP call telemetry (mcp_tool_calls)",
    up: `
      CREATE TABLE IF NOT EXISTS mcp_tool_calls (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        registry_server_id TEXT,
        adapter_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL,
        duration_ms INTEGER,
        ok INTEGER NOT NULL,
        error TEXT,
        turn_input_tokens INTEGER,
        turn_output_tokens INTEGER,
        estimated_cost_usd DOUBLE PRECISION,
        created_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_registry ON mcp_tool_calls(registry_server_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_adapter_tool ON mcp_tool_calls(adapter_id, tool_name, started_at);
      CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_execution ON mcp_tool_calls(execution_id);
    `,
    down: `
      DROP TABLE IF EXISTS mcp_tool_calls;
    `
  },
  {
    version: 22,
    description: "Phase 10.2 — MCP tool policy (mcp_tool_policies, mcp_tool_classifications, workflows.created_by)",
    up: `
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
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mcp_tool_classifications (
        server_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        read_only INTEGER NOT NULL,
        set_by TEXT,
        set_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (server_id, tool_name)
      );

      ALTER TABLE workflows ADD COLUMN IF NOT EXISTS created_by TEXT;

      UPDATE workflows SET created_by = (
        SELECT wv.created_by FROM workflow_versions wv
        WHERE wv.workflow_id = workflows.id AND wv.created_by IS NOT NULL
        ORDER BY wv.created_at ASC, wv.version ASC
        LIMIT 1
      )
      WHERE created_by IS NULL;
    `,
    down: `
      ALTER TABLE workflows DROP COLUMN IF EXISTS created_by;
      DROP TABLE IF EXISTS mcp_tool_classifications;
      DROP TABLE IF EXISTS mcp_tool_policies;
    `
  },
  {
    version: 23,
    description: "Phase 10.4 — MCP gateway (mcp_toolsets, mcp_toolset_members, mcp_clients, mcp_tool_calls.source/client_id)",
    up: `
      CREATE TABLE IF NOT EXISTS mcp_toolsets (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT,
        project_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
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
        expires_at TIMESTAMPTZ,
        last_used_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL
      );

      ALTER TABLE mcp_tool_calls ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'workflow';
      ALTER TABLE mcp_tool_calls ADD COLUMN IF NOT EXISTS client_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_client ON mcp_tool_calls(client_id, started_at);
    `,
    down: `
      DROP INDEX IF EXISTS idx_mcp_tool_calls_client;
      ALTER TABLE mcp_tool_calls DROP COLUMN IF EXISTS client_id;
      ALTER TABLE mcp_tool_calls DROP COLUMN IF EXISTS source;
      DROP TABLE IF EXISTS mcp_clients;
      DROP TABLE IF EXISTS mcp_toolset_members;
      DROP TABLE IF EXISTS mcp_toolsets;
    `
  },
  {
    version: 24,
    description: "Phase 10.5 — MCP client protocol coverage (mcp_tool_policies.annotation_hint, mcp_oauth_connections)",
    up: `
      ALTER TABLE mcp_tool_policies ADD COLUMN IF NOT EXISTS annotation_hint TEXT;

      CREATE TABLE IF NOT EXISTS mcp_oauth_connections (
        server_id TEXT PRIMARY KEY,
        secret_id TEXT,
        state TEXT NOT NULL DEFAULT 'not_connected',
        subject TEXT,
        scope TEXT,
        authorization_server TEXT,
        client_registration TEXT,
        client_id TEXT,
        expires_at TIMESTAMPTZ,
        has_refresh_token INTEGER NOT NULL DEFAULT 0,
        last_refresh_at TIMESTAMPTZ,
        connected_at TIMESTAMPTZ,
        connected_by TEXT,
        last_error TEXT,
        updated_at TIMESTAMPTZ NOT NULL
      );
    `,
    down: `
      DROP TABLE IF EXISTS mcp_oauth_connections;
      ALTER TABLE mcp_tool_policies DROP COLUMN IF EXISTS annotation_hint;
    `
  },
  {
    version: 25,
    description:
      "Phase 10.5 — MCP resources, prompts, elicitation and sampling (mcp_tool_policies.kind, mcp_servers.sampling_json, mcp_server_catalogs, mcp_elicitations, mcp_tool_calls sampling columns)",
    up: `
      ALTER TABLE mcp_tool_policies ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'tool';
      ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS sampling_json TEXT;
      ALTER TABLE mcp_tool_calls ADD COLUMN IF NOT EXISTS sampling_requests INTEGER;
      ALTER TABLE mcp_tool_calls ADD COLUMN IF NOT EXISTS sampling_input_tokens INTEGER;
      ALTER TABLE mcp_tool_calls ADD COLUMN IF NOT EXISTS sampling_output_tokens INTEGER;

      CREATE TABLE IF NOT EXISTS mcp_server_catalogs (
        server_id TEXT PRIMARY KEY,
        capabilities_json TEXT,
        resources_json TEXT,
        resource_templates_json TEXT,
        prompts_json TEXT,
        updated_at TIMESTAMPTZ NOT NULL
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
        created_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        answered_at TIMESTAMPTZ,
        answered_by TEXT,
        reason TEXT,
        created_by TEXT,
        trigger_type TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_elicitations_status ON mcp_elicitations(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mcp_elicitations_execution ON mcp_elicitations(execution_id);
    `,
    down: `
      DROP TABLE IF EXISTS mcp_elicitations;
      DROP TABLE IF EXISTS mcp_server_catalogs;
      ALTER TABLE mcp_tool_calls DROP COLUMN IF EXISTS sampling_output_tokens;
      ALTER TABLE mcp_tool_calls DROP COLUMN IF EXISTS sampling_input_tokens;
      ALTER TABLE mcp_tool_calls DROP COLUMN IF EXISTS sampling_requests;
      ALTER TABLE mcp_servers DROP COLUMN IF EXISTS sampling_json;
      ALTER TABLE mcp_tool_policies DROP COLUMN IF EXISTS kind;
    `
  },
  {
    version: 26,
    description: "Phase 10.8 — MCP cassettes for record and replay (mcp_cassettes)",
    up: `
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
        created_at TIMESTAMPTZ NOT NULL,
        created_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_cassettes_execution ON mcp_cassettes(execution_id);
      CREATE INDEX IF NOT EXISTS idx_mcp_cassettes_eval ON mcp_cassettes(eval_run_id, fixture_id);
      CREATE INDEX IF NOT EXISTS idx_mcp_cassettes_created ON mcp_cassettes(created_at DESC);
    `,
    down: `
      DROP TABLE IF EXISTS mcp_cassettes;
    `
  },
  {
    version: 27,
    description:
      "Phase 10.7 — MCP runtime safety (mcp_servers sandbox, limits and credential mode; mcp_tool_calls.rejection; mcp_user_oauth_connections)",
    up: `
      ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS sandbox_json TEXT;
      ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS sandbox_status_json TEXT;
      ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS limits_json TEXT;
      ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS credential_mode TEXT NOT NULL DEFAULT 'service';
      ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS delegated_fallback TEXT NOT NULL DEFAULT 'none';
      ALTER TABLE mcp_tool_calls ADD COLUMN IF NOT EXISTS rejection TEXT;

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
        expires_at TIMESTAMPTZ,
        has_refresh_token INTEGER NOT NULL DEFAULT 0,
        last_refresh_at TIMESTAMPTZ,
        connected_at TIMESTAMPTZ,
        last_error TEXT,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (server_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_user_oauth_user ON mcp_user_oauth_connections(user_id);
    `,
    down: `
      DROP INDEX IF EXISTS idx_mcp_user_oauth_user;
      DROP TABLE IF EXISTS mcp_user_oauth_connections;
      ALTER TABLE mcp_tool_calls DROP COLUMN IF EXISTS rejection;
      ALTER TABLE mcp_servers DROP COLUMN IF EXISTS delegated_fallback;
      ALTER TABLE mcp_servers DROP COLUMN IF EXISTS credential_mode;
      ALTER TABLE mcp_servers DROP COLUMN IF EXISTS limits_json;
      ALTER TABLE mcp_servers DROP COLUMN IF EXISTS sandbox_status_json;
      ALTER TABLE mcp_servers DROP COLUMN IF EXISTS sandbox_json;
    `
  },
  {
    version: 28,
    description:
      "Phase 12.1 — Guard wiring (guard_profiles, guard_profile_versions, guard_bindings, guard_events, guard_token_vault)",
    up: `
      CREATE TABLE IF NOT EXISTS guard_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        built_in INTEGER NOT NULL DEFAULT 0,
        latest_version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL,
        created_by TEXT,
        updated_at TIMESTAMPTZ NOT NULL,
        updated_by TEXT
      );

      CREATE TABLE IF NOT EXISTS guard_profile_versions (
        profile_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        hash TEXT NOT NULL,
        document_json TEXT NOT NULL,
        note TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        created_by TEXT,
        PRIMARY KEY (profile_id, version)
      );

      CREATE TABLE IF NOT EXISTS guard_bindings (
        scope TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'inherit',
        profile_id TEXT,
        updated_at TIMESTAMPTZ NOT NULL,
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
        score DOUBLE PRECISION,
        requested_action TEXT NOT NULL,
        effective_action TEXT NOT NULL,
        verdict_action TEXT NOT NULL,
        shadow INTEGER NOT NULL DEFAULT 0,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        profile_id TEXT NOT NULL,
        profile_version INTEGER NOT NULL,
        profile_hash TEXT NOT NULL,
        latency_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
        budget_exceeded INTEGER NOT NULL DEFAULT 0,
        skipped_detectors_json TEXT NOT NULL DEFAULT '[]',
        created_at TIMESTAMPTZ NOT NULL
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
        created_at TIMESTAMPTZ NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_guard_token_vault_hash ON guard_token_vault(value_hash);
    `,
    down: `
      DROP INDEX IF EXISTS idx_guard_token_vault_hash;
      DROP TABLE IF EXISTS guard_token_vault;
      DROP INDEX IF EXISTS idx_guard_events_profile;
      DROP INDEX IF EXISTS idx_guard_events_scope;
      DROP INDEX IF EXISTS idx_guard_events_created;
      DROP INDEX IF EXISTS idx_guard_events_execution;
      DROP TABLE IF EXISTS guard_events;
      DROP INDEX IF EXISTS idx_guard_bindings_profile;
      DROP TABLE IF EXISTS guard_bindings;
      DROP TABLE IF EXISTS guard_profile_versions;
      DROP TABLE IF EXISTS guard_profiles;
    `
  },
  {
    version: 29,
    description: "Phase 11.1 — Signed run manifests (execution_manifests, audit_signing_keys)",
    up: `
      CREATE TABLE IF NOT EXISTS execution_manifests (
        execution_id TEXT PRIMARY KEY,
        run_context_json TEXT,
        manifest_json TEXT,
        manifest_digest TEXT,
        key_id TEXT,
        signature TEXT,
        signed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_execution_manifests_created ON execution_manifests(created_at);

      CREATE TABLE IF NOT EXISTS audit_signing_keys (
        key_id TEXT PRIMARY KEY,
        algorithm TEXT NOT NULL,
        public_key TEXT NOT NULL,
        source TEXT NOT NULL,
        secret_id TEXT,
        status TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        retired_at TIMESTAMPTZ
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_signing_keys_active ON audit_signing_keys(status) WHERE status = 'active';
    `,
    down: `
      DROP INDEX IF EXISTS idx_audit_signing_keys_active;
      DROP TABLE IF EXISTS audit_signing_keys;
      DROP INDEX IF EXISTS idx_execution_manifests_created;
      DROP TABLE IF EXISTS execution_manifests;
    `
  },
  {
    version: 30,
    description: "Phase 15.1 — Golden runs (replay_recordings)",
    up: `
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
        created_at TIMESTAMPTZ NOT NULL,
        created_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_replay_recordings_workflow ON replay_recordings(workflow_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_replay_recordings_source ON replay_recordings(source_execution_id);
    `,
    down: `
      DROP INDEX IF EXISTS idx_replay_recordings_source;
      DROP INDEX IF EXISTS idx_replay_recordings_workflow;
      DROP TABLE IF EXISTS replay_recordings;
    `
  },
  {
    version: 31,
    description: "Phase 15.2 — Golden sets and background replay jobs on the eval tables",
    up: `
      ALTER TABLE eval_datasets ADD COLUMN IF NOT EXISTS workflow_id TEXT;
      ALTER TABLE eval_fixtures ADD COLUMN IF NOT EXISTS recording_id TEXT;
      ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'eval';
      ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS triggered_by_user_id TEXT;
      ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS dataset_ids_json TEXT;
      ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS candidate_json TEXT;
      ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS workflow_hash TEXT;
      ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS workflow_version INTEGER;
      ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS options_json TEXT;
      ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS progress_json TEXT;
      ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS recording_id TEXT;
      ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS verdict TEXT;
      ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS diff_json TEXT;
      ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS cost_usd DOUBLE PRECISION;
      CREATE INDEX IF NOT EXISTS idx_eval_datasets_workflow ON eval_datasets(workflow_id);
      CREATE INDEX IF NOT EXISTS idx_eval_fixtures_recording ON eval_fixtures(recording_id);
      CREATE INDEX IF NOT EXISTS idx_eval_runs_kind ON eval_runs(kind, workflow_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_eval_runs_status ON eval_runs(status);
    `,
    down: `
      DROP INDEX IF EXISTS idx_eval_runs_status;
      DROP INDEX IF EXISTS idx_eval_runs_kind;
      DROP INDEX IF EXISTS idx_eval_fixtures_recording;
      DROP INDEX IF EXISTS idx_eval_datasets_workflow;
      ALTER TABLE eval_results DROP COLUMN IF EXISTS cost_usd;
      ALTER TABLE eval_results DROP COLUMN IF EXISTS diff_json;
      ALTER TABLE eval_results DROP COLUMN IF EXISTS verdict;
      ALTER TABLE eval_results DROP COLUMN IF EXISTS recording_id;
      ALTER TABLE eval_runs DROP COLUMN IF EXISTS progress_json;
      ALTER TABLE eval_runs DROP COLUMN IF EXISTS options_json;
      ALTER TABLE eval_runs DROP COLUMN IF EXISTS workflow_version;
      ALTER TABLE eval_runs DROP COLUMN IF EXISTS workflow_hash;
      ALTER TABLE eval_runs DROP COLUMN IF EXISTS candidate_json;
      ALTER TABLE eval_runs DROP COLUMN IF EXISTS dataset_ids_json;
      ALTER TABLE eval_runs DROP COLUMN IF EXISTS triggered_by_user_id;
      ALTER TABLE eval_runs DROP COLUMN IF EXISTS kind;
      ALTER TABLE eval_fixtures DROP COLUMN IF EXISTS recording_id;
      ALTER TABLE eval_datasets DROP COLUMN IF EXISTS workflow_id;
    `
  },
  {
    version: 32,
    description: "Phase 11.2 — Approval gates (approval_requests)",
    up: `
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
        expires_at TIMESTAMPTZ,
        decided_by_user_id TEXT,
        decided_by TEXT,
        decided_at TIMESTAMPTZ,
        reason TEXT,
        edits_json TEXT,
        edited_fields_json TEXT,
        asking_workflow_id TEXT,
        edits_salt TEXT,
        workflow_deleted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_approval_requests_status_expires ON approval_requests(status, expires_at);
      CREATE INDEX IF NOT EXISTS idx_approval_requests_execution ON approval_requests(execution_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_approval_requests_project ON approval_requests(project_id, status, created_at DESC);
      -- When approval requests came up: runs paused before it get one full timeout from here.
      CREATE TABLE IF NOT EXISTS schema_markers (
        name TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL
      );
      INSERT INTO schema_markers (name, created_at) VALUES ('approval_requests', CURRENT_TIMESTAMP) ON CONFLICT (name) DO NOTHING;
    `,
    down: `
      DROP TABLE IF EXISTS schema_markers;
      DROP INDEX IF EXISTS idx_approval_requests_project;
      DROP INDEX IF EXISTS idx_approval_requests_execution;
      DROP INDEX IF EXISTS idx_approval_requests_status_expires;
      DROP TABLE IF EXISTS approval_requests;
    `
  },
  {
    version: 33,
    description: "Phase 15.4 — Release gate and publish (published versions, gates, releases, release approval requests)",
    up: `
      ALTER TABLE workflows ADD COLUMN IF NOT EXISTS published_version INTEGER;
      ALTER TABLE workflow_versions ADD COLUMN IF NOT EXISTS pinned INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS set_snapshot_json TEXT;
      ALTER TABLE execution_history ADD COLUMN IF NOT EXISTS release_channel TEXT;
      ALTER TABLE execution_history ADD COLUMN IF NOT EXISTS release_version INTEGER;
      CREATE TABLE IF NOT EXISTS release_gates (
        workflow_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        enforced INTEGER NOT NULL DEFAULT 0,
        dataset_ids_json TEXT NOT NULL,
        candidate_options_json TEXT,
        policy_json TEXT NOT NULL,
        require_approval INTEGER NOT NULL DEFAULT 0,
        approvers_json TEXT,
        updated_at TIMESTAMPTZ NOT NULL,
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
        published_at TIMESTAMPTZ NOT NULL,
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
        gate_updated_at TIMESTAMPTZ,
        published_version_at_request INTEGER,
        spec_json TEXT NOT NULL,
        status TEXT NOT NULL,
        request_reason TEXT,
        requested_by_user_id TEXT,
        requested_by TEXT,
        expires_at TIMESTAMPTZ,
        decided_by_user_id TEXT,
        decided_by TEXT,
        decided_at TIMESTAMPTZ,
        decision_reason TEXT,
        release_id TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_release_approval_requests_workflow ON release_approval_requests(workflow_id, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_release_approval_requests_status ON release_approval_requests(status, created_at DESC);
    `,
    down: `
      DROP INDEX IF EXISTS idx_release_approval_requests_status;
      DROP INDEX IF EXISTS idx_release_approval_requests_workflow;
      DROP TABLE IF EXISTS release_approval_requests;
      DROP INDEX IF EXISTS idx_workflow_releases_workflow;
      DROP TABLE IF EXISTS workflow_releases;
      DROP TABLE IF EXISTS release_gates;
      ALTER TABLE execution_history DROP COLUMN IF EXISTS release_version;
      ALTER TABLE execution_history DROP COLUMN IF EXISTS release_channel;
      ALTER TABLE eval_runs DROP COLUMN IF EXISTS set_snapshot_json;
      ALTER TABLE workflow_versions DROP COLUMN IF EXISTS pinned;
      ALTER TABLE workflows DROP COLUMN IF EXISTS published_version;
    `
  },
  {
    version: 34,
    description: "Phase 15.6 — Production capture (capture settings, candidate recordings)",
    up: `
      ALTER TABLE replay_recordings ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'golden' CHECK (status IN ('candidate', 'golden'));
      ALTER TABLE replay_recordings ADD COLUMN IF NOT EXISTS captured_at TIMESTAMPTZ;
      CREATE INDEX IF NOT EXISTS idx_replay_recordings_status ON replay_recordings(workflow_id, status, captured_at DESC);
      CREATE TABLE IF NOT EXISTS replay_capture_settings (
        workflow_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        rate DOUBLE PRECISION NOT NULL DEFAULT 0.1,
        max_per_day INTEGER NOT NULL DEFAULT 20,
        only_statuses_json TEXT NOT NULL,
        dlp INTEGER NOT NULL DEFAULT 1,
        dlp_off_reason TEXT,
        target_dataset_id TEXT,
        updated_at TIMESTAMPTZ NOT NULL,
        updated_by TEXT,
        last_drop_outcome TEXT,
        last_drop_at TIMESTAMPTZ
      );
    `,
    down: `
      DROP TABLE IF EXISTS replay_capture_settings;
      DROP INDEX IF EXISTS idx_replay_recordings_status;
      ALTER TABLE replay_recordings DROP COLUMN IF EXISTS captured_at;
      ALTER TABLE replay_recordings DROP COLUMN IF EXISTS status;
    `
  },
  {
    version: 35,
    description: "Phase 15.6 — Guard policy simulations (one row grouping a simulation's replay jobs)",
    up: `
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
        created_at TIMESTAMPTZ NOT NULL,
        created_by TEXT,
        created_by_user_id TEXT,
        finished_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_guard_simulations_profile ON guard_simulations(profile_id, created_at DESC);
    `,
    down: `
      DROP INDEX IF EXISTS idx_guard_simulations_profile;
      DROP TABLE IF EXISTS guard_simulations;
    `
  },
  {
    version: 36,
    description: "Release gate admission: required cases, the admitted cases of enforced gates, and gate case requests",
    up: `
      ALTER TABLE eval_fixtures ADD COLUMN IF NOT EXISTS required INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE release_gates ADD COLUMN IF NOT EXISTS admitted_fixture_ids_json TEXT;
      ALTER TABLE release_gates ADD COLUMN IF NOT EXISTS admission_updated_at TIMESTAMPTZ;
      ALTER TABLE release_gates ADD COLUMN IF NOT EXISTS admission_updated_by TEXT;
      ALTER TABLE release_approval_requests ADD COLUMN IF NOT EXISTS gate_checks_json TEXT;
      ALTER TABLE release_approval_requests ADD COLUMN IF NOT EXISTS gate_authority TEXT;
      UPDATE release_gates g
         SET admitted_fixture_ids_json = (
           SELECT COALESCE(json_agg(f.id ORDER BY f.id)::text, '[]')
             FROM eval_fixtures f
            WHERE f.dataset_id IN (SELECT json_array_elements_text(g.dataset_ids_json::json))
         ),
             admission_updated_at = CURRENT_TIMESTAMP,
             admission_updated_by = 'migration 36'
       WHERE g.enforced = 1 AND g.admitted_fixture_ids_json IS NULL;
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
        expires_at TIMESTAMPTZ,
        decided_by_user_id TEXT,
        decided_by TEXT,
        decided_at TIMESTAMPTZ,
        decision_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_gate_case_requests_workflow ON gate_case_requests(workflow_id, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_gate_case_requests_status ON gate_case_requests(status, created_at DESC);
    `,
    down: `
      DROP INDEX IF EXISTS idx_gate_case_requests_status;
      DROP INDEX IF EXISTS idx_gate_case_requests_workflow;
      DROP TABLE IF EXISTS gate_case_requests;
      ALTER TABLE release_approval_requests DROP COLUMN IF EXISTS gate_authority;
      ALTER TABLE release_approval_requests DROP COLUMN IF EXISTS gate_checks_json;
      ALTER TABLE release_gates DROP COLUMN IF EXISTS admission_updated_by;
      ALTER TABLE release_gates DROP COLUMN IF EXISTS admission_updated_at;
      ALTER TABLE release_gates DROP COLUMN IF EXISTS admitted_fixture_ids_json;
      ALTER TABLE eval_fixtures DROP COLUMN IF EXISTS required;
    `
  },
  {
    version: 37,
    description: "Phase 16 — data labels on session memory, the session tool cache and session artifacts (null: none recorded); a guard profile revision counter kept by triggers",
    up: `
      ALTER TABLE session_memory ADD COLUMN IF NOT EXISTS labels_json TEXT;
      ALTER TABLE session_tool_cache ADD COLUMN IF NOT EXISTS labels_json TEXT;
      ALTER TABLE session_artifacts ADD COLUMN IF NOT EXISTS labels_json TEXT;
      CREATE TABLE IF NOT EXISTS guard_profile_revision (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision BIGINT NOT NULL DEFAULT 0
      );
      INSERT INTO guard_profile_revision (id, revision) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
      CREATE OR REPLACE FUNCTION guard_profile_revision_bump() RETURNS trigger AS $$
      BEGIN
        UPDATE guard_profile_revision SET revision = revision + 1 WHERE id = 1;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS guard_profiles_revision ON guard_profiles;
      CREATE TRIGGER guard_profiles_revision AFTER INSERT OR UPDATE OR DELETE ON guard_profiles
        FOR EACH STATEMENT EXECUTE FUNCTION guard_profile_revision_bump();
      DROP TRIGGER IF EXISTS guard_profile_versions_revision ON guard_profile_versions;
      CREATE TRIGGER guard_profile_versions_revision AFTER INSERT OR UPDATE OR DELETE ON guard_profile_versions
        FOR EACH STATEMENT EXECUTE FUNCTION guard_profile_revision_bump();
    `,
    down: `
      DROP TRIGGER IF EXISTS guard_profile_versions_revision ON guard_profile_versions;
      DROP TRIGGER IF EXISTS guard_profiles_revision ON guard_profiles;
      DROP FUNCTION IF EXISTS guard_profile_revision_bump();
      DROP TABLE IF EXISTS guard_profile_revision;
      ALTER TABLE session_artifacts DROP COLUMN IF EXISTS labels_json;
      ALTER TABLE session_tool_cache DROP COLUMN IF EXISTS labels_json;
      ALTER TABLE session_memory DROP COLUMN IF EXISTS labels_json;
    `
  },
  {
    version: 38,
    description: "Phase 16 — Data destinations (admin rows classifying where outgoing data goes)",
    up: `
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
        created_at TIMESTAMPTZ NOT NULL,
        created_by TEXT,
        updated_at TIMESTAMPTZ NOT NULL,
        updated_by TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_data_destinations_match ON data_destinations(kind, COALESCE(target_id, ''), COALESCE(host, ''));
    `,
    down: `
      DROP INDEX IF EXISTS idx_data_destinations_match;
      DROP TABLE IF EXISTS data_destinations;
    `
  },
  {
    version: 39,
    description: "Phase 13.1 — Postgres schema parity with SQLite; at most one running guard simulation per deployment",
    // Brings a Postgres database to the schema the SQLite store creates: the one index the chain lacked, and the
    // partial unique index that lets the database (not only the process) refuse a second running simulation. A
    // database that already holds several running rows keeps the newest running; the others become `interrupted`,
    // as a restart would have finished them, so the index can be built. SQLite's embedded migrate() does the same.
    // The NOT NULL timestamps that SQLite fills with datetime('now') when an insert leaves them out get the same
    // default here (now()), so such an insert cannot succeed on one store and fail on the other.
    up: `
      CREATE INDEX IF NOT EXISTS idx_sessions_revoked_expires ON sessions(revoked_at, expires_at);
      ALTER TABLE audit_export_destinations ALTER COLUMN created_at SET DEFAULT now();
      ALTER TABLE audit_export_destinations ALTER COLUMN updated_at SET DEFAULT now();
      ALTER TABLE budget_alerts ALTER COLUMN fired_at SET DEFAULT now();
      ALTER TABLE budgets ALTER COLUMN created_at SET DEFAULT now();
      ALTER TABLE budgets ALTER COLUMN updated_at SET DEFAULT now();
      ALTER TABLE eval_datasets ALTER COLUMN created_at SET DEFAULT now();
      ALTER TABLE eval_datasets ALTER COLUMN updated_at SET DEFAULT now();
      ALTER TABLE eval_fixtures ALTER COLUMN created_at SET DEFAULT now();
      ALTER TABLE eval_fixtures ALTER COLUMN updated_at SET DEFAULT now();
      ALTER TABLE eval_results ALTER COLUMN created_at SET DEFAULT now();
      ALTER TABLE eval_runs ALTER COLUMN created_at SET DEFAULT now();
      ALTER TABLE knowledge_base_chunks ALTER COLUMN created_at SET DEFAULT now();
      ALTER TABLE knowledge_bases ALTER COLUMN created_at SET DEFAULT now();
      ALTER TABLE knowledge_bases ALTER COLUMN updated_at SET DEFAULT now();
      ALTER TABLE mcp_servers ALTER COLUMN created_at SET DEFAULT now();
      ALTER TABLE mcp_servers ALTER COLUMN updated_at SET DEFAULT now();
      ALTER TABLE mcp_tool_calls ALTER COLUMN created_at SET DEFAULT now();
      ALTER TABLE mcp_tool_snapshots ALTER COLUMN created_at SET DEFAULT now();
      ALTER TABLE usage_events ALTER COLUMN created_at SET DEFAULT now();
      DO $$
      DECLARE interrupted integer;
      BEGIN
        UPDATE guard_simulations
           SET status = 'interrupted',
               error = COALESCE(error, 'Stopped by an upgrade: only one simulation can run at a time.'),
               finished_at = COALESCE(finished_at, now())
         WHERE status = 'running'
           AND id <> (SELECT id FROM guard_simulations WHERE status = 'running' ORDER BY created_at DESC, id DESC LIMIT 1);
        GET DIAGNOSTICS interrupted = ROW_COUNT;
        -- PostgresStore turns NOTICEs starting with "L2M " into one startup log line each.
        IF interrupted > 0 THEN
          RAISE NOTICE 'L2M v39 upgrade: % running guard simulation% interrupted (only one can run at a time).',
            interrupted, CASE WHEN interrupted = 1 THEN ' was' ELSE 's were' END;
        END IF;
      END
      $$;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_guard_simulations_one_running ON guard_simulations(status) WHERE status = 'running';
    `,
    down: `
      ALTER TABLE audit_export_destinations ALTER COLUMN created_at DROP DEFAULT;
      ALTER TABLE audit_export_destinations ALTER COLUMN updated_at DROP DEFAULT;
      ALTER TABLE budget_alerts ALTER COLUMN fired_at DROP DEFAULT;
      ALTER TABLE budgets ALTER COLUMN created_at DROP DEFAULT;
      ALTER TABLE budgets ALTER COLUMN updated_at DROP DEFAULT;
      ALTER TABLE eval_datasets ALTER COLUMN created_at DROP DEFAULT;
      ALTER TABLE eval_datasets ALTER COLUMN updated_at DROP DEFAULT;
      ALTER TABLE eval_fixtures ALTER COLUMN created_at DROP DEFAULT;
      ALTER TABLE eval_fixtures ALTER COLUMN updated_at DROP DEFAULT;
      ALTER TABLE eval_results ALTER COLUMN created_at DROP DEFAULT;
      ALTER TABLE eval_runs ALTER COLUMN created_at DROP DEFAULT;
      ALTER TABLE knowledge_base_chunks ALTER COLUMN created_at DROP DEFAULT;
      ALTER TABLE knowledge_bases ALTER COLUMN created_at DROP DEFAULT;
      ALTER TABLE knowledge_bases ALTER COLUMN updated_at DROP DEFAULT;
      ALTER TABLE mcp_servers ALTER COLUMN created_at DROP DEFAULT;
      ALTER TABLE mcp_servers ALTER COLUMN updated_at DROP DEFAULT;
      ALTER TABLE mcp_tool_calls ALTER COLUMN created_at DROP DEFAULT;
      ALTER TABLE mcp_tool_snapshots ALTER COLUMN created_at DROP DEFAULT;
      ALTER TABLE usage_events ALTER COLUMN created_at DROP DEFAULT;
      DROP INDEX IF EXISTS idx_guard_simulations_one_running;
      DROP INDEX IF EXISTS idx_sessions_revoked_expires;
    `
  },
  {
    version: 40,
    description:
      "Phase 13.1 — Postgres insertion order: an identity `seq` column on the tables SQLite orders by rowid; REAL budget and usage columns widened to double precision",
    // Postgres only (SQLite's rowid already plays this role; its embedded migrate() is unchanged). Existing rows are
    // numbered in the order the store read them before this column existed, then new rows take the identity's next
    // value, so insertion order no longer depends on created_at, transaction ids or row positions.
    up: [
      ...INSERTION_SEQ_TABLES.map(({ table, backfillOrder }) => insertionSeqUp(table, backfillOrder)),
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_logs_seq ON audit_logs(seq);`,
      `CREATE INDEX IF NOT EXISTS idx_kb_chunks_kb_seq ON knowledge_base_chunks(knowledge_base_id, seq);`,
      ...SUBJECT_SEQ_TABLES.map((table) => `CREATE UNIQUE INDEX IF NOT EXISTS idx_${table}_seq ON ${table}(seq);`),
      ...WIDENED_REAL_COLUMNS.map(
        ({ table, column }) => `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE DOUBLE PRECISION USING ${column}::text::double precision;`
      )
    ].join("\n"),
    down: [
      ...WIDENED_REAL_COLUMNS.map(({ table, column }) => `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE REAL;`),
      ...SUBJECT_SEQ_TABLES.map((table) => `DROP INDEX IF EXISTS idx_${table}_seq;`),
      `DROP INDEX IF EXISTS idx_kb_chunks_kb_seq;`,
      `DROP INDEX IF EXISTS idx_audit_logs_seq;`,
      ...INSERTION_SEQ_TABLES.map(({ table }) => `ALTER TABLE ${table} DROP COLUMN IF EXISTS seq;`)
    ].join("\n")
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

/**
 * Walk a Postgres deployment back from the current schema version to
 * `targetVersion` by running each migration's `down` SQL in reverse order.
 *
 * DESTRUCTIVE — drops tables/columns and the data they hold. Intended for
 * recovering from a botched deploy: rollback to the last-known-good schema,
 * restore data from backup, then re-apply migrations.
 *
 * Safety:
 *   - No-op when the current version is already <= targetVersion.
 *   - Throws if any migration in the rollback path is missing its `down`
 *     (every migration in MIGRATIONS provides one, but a future contributor
 *     could omit it — this guard catches that before partial damage).
 *   - Caller is responsible for confirming the destructive intent (the CLI
 *     enforces a `--yes` flag).
 *
 * Does NOT support SQLite — see the `Migration.down` JSDoc for why.
 */
export async function rollbackMigrations(
  runSql: (sql: string) => Promise<void>,
  getCurrentVersion: () => Promise<number>,
  setVersion: (version: number) => Promise<void>,
  targetVersion: number
): Promise<{ rolledBack: number[]; from: number; to: number }> {
  if (targetVersion < 0) {
    throw new Error(`rollbackMigrations: targetVersion must be >= 0, got ${targetVersion}`);
  }
  const currentVersion = await getCurrentVersion();
  if (currentVersion <= targetVersion) {
    return { rolledBack: [], from: currentVersion, to: currentVersion };
  }

  const toRollBack = MIGRATIONS
    .filter((m) => m.version > targetVersion && m.version <= currentVersion)
    .sort((a, b) => b.version - a.version);

  const missingDown = toRollBack.find((m) => !m.down || !m.down.trim());
  if (missingDown) {
    throw new Error(
      `rollbackMigrations: migration v${missingDown.version} (${missingDown.description}) has no \`down\` SQL — refusing to roll back partially.`
    );
  }

  const rolledBack: number[] = [];
  for (const migration of toRollBack) {
    await runSql(migration.down);
    const newVersion = migration.version - 1;
    await setVersion(newVersion);
    rolledBack.push(migration.version);
    if (newVersion <= targetVersion) break;
  }

  return { rolledBack, from: currentVersion, to: targetVersion };
}
