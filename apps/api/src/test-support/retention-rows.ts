/**
 * 13.3 — SQL that seeds one row of a retention table, aged `at`, on either store (retention contract and service tests).
 */
import type { RetentionTable } from "../db/retention-tables.js";

/** One INSERT of a row of `table` aged `at`, tagged `tag`, with whatever else the table needs. */
export function retentionRowSql(table: RetentionTable, tag: string, at: string, extra: { status?: string } = {}): string {
  switch (table) {
    case "execution_history":
      return `INSERT INTO execution_history (id, workflow_id, status, started_at) VALUES ('${tag}', 'wf', 'success', '${at}')`;
    case "mcp_tool_calls":
      return `INSERT INTO mcp_tool_calls (id, execution_id, workflow_id, node_id, adapter_id, tool_name, started_at, ok, created_at)
        VALUES ('${tag}', 'run', 'wf', 'n', 'http-mcp', 't', '${at}', 1, '${at}')`;
    case "guard_events":
      return `INSERT INTO guard_events (id, verdict_id, execution_id, node_id, placement, channel, requested_action, effective_action, verdict_action,
        profile_id, profile_version, profile_hash, created_at)
        VALUES ('${tag}', 'v', 'run', 'n', 'input', 'prompt', 'allow', 'allow', 'allow', 'p', 1, 'h', '${at}')`;
    case "approval_requests":
      return `INSERT INTO approval_requests (id, execution_id, workflow_id, project_id, node_id, kind, status, spec_json, created_at, updated_at)
        VALUES ('${tag}', 'run', 'wf', 'default', 'gate', 'approval_gate', '${extra.status ?? "approved"}', '{}', '${at}', '${at}')`;
    case "mcp_cassettes":
      return `INSERT INTO mcp_cassettes (id, execution_id, workflow_id, cassette_json, created_at) VALUES ('${tag}', 'run', 'wf', '{}', '${at}')`;
    case "mcp_gateway_approvals":
      return `INSERT INTO mcp_gateway_approvals (id, client_id, toolset_id, server_id, tool_name, gateway_tool_name, args_hash, status, requested_at, expires_at)
        VALUES ('${tag}', 'c', 'ts', 's', 't', 'gt', 'h-${tag}', '${extra.status ?? "approved"}', '${at}', '${at}')`;
    case "execution_queue":
      return `INSERT INTO execution_queue (id, workflow_id, payload_json, status, attempts, max_attempts, scheduled_at, created_at, updated_at)
        VALUES ('${tag}', 'wf', '{}', '${extra.status ?? "completed"}', 1, 3, '${at}', '${at}', '${at}')`;
    case "execution_queue_dlq":
      return `INSERT INTO execution_queue_dlq (id, original_id, workflow_id, payload_json, attempts, final_error, failed_at, created_at)
        VALUES ('${tag}', 'q', 'wf', '{}', 3, 'x', '${at}', '${at}')`;
    case "session_memory":
      return `INSERT INTO session_memory (namespace, session_id, messages_json, created_at, updated_at) VALUES ('ns', '${tag}', '[]', '${at}', '${at}')`;
    case "session_artifacts":
      return `INSERT INTO session_artifacts (namespace, session_id, artifact_key, value_json, created_at, updated_at)
        VALUES ('ns', 's', '${tag}', '{}', '${at}', '${at}')`;
    case "session_tool_cache":
      return `INSERT INTO session_tool_cache (id, namespace, session_id, tool_name, args_json, output_json, created_at)
        VALUES ('${tag}', 'ns', 's', 't', '{}', '{}', '${at}')`;
    case "usage_events":
      return `INSERT INTO usage_events (id, execution_id, workflow_id, status, created_at) VALUES ('${tag}', 'run', 'wf', 'success', '${at}')`;
    case "ai_gateway_requests":
      return `INSERT INTO ai_gateway_requests (id, created_at, client_id, route_set_id, route_id, alias, kind, provider_id, model, status, http_status)
        VALUES ('${tag}', '${at}', 'c', 'rs', 'r', 'a', 'chat', 'openai', 'm', 'ok', 200)`;
    case "retention_runs":
      return `INSERT INTO retention_runs (id, started_at, finished_at, instance_id, reason, outcome) VALUES ('${tag}', '${at}', '${at}', 'i', 'interval', 'ok')`;
  }
}

