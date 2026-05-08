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
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
      ALTER TABLE audit_logs ADD COLUMN prev_hash TEXT;
      ALTER TABLE audit_logs ADD COLUMN entry_hash TEXT;

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
    description: "Phase 9.3 — FTS5 BM25 index over knowledge_base_chunks for hybrid search",
    up: `
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_base_chunks_fts USING fts5(
        content,
        kb_id UNINDEXED,
        content='knowledge_base_chunks',
        content_rowid='rowid',
        tokenize='porter unicode61'
      );

      INSERT INTO knowledge_base_chunks_fts(rowid, content, kb_id)
        SELECT rowid, content, knowledge_base_id FROM knowledge_base_chunks;

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
    `,
    down: `
      DROP TRIGGER IF EXISTS kb_chunks_fts_au;
      DROP TRIGGER IF EXISTS kb_chunks_fts_ad;
      DROP TRIGGER IF EXISTS kb_chunks_fts_ai;
      DROP TABLE IF EXISTS knowledge_base_chunks_fts;
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
