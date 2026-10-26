/**
 * Phase 13.1 — PostgresStore: MCP registry, probes, telemetry, OAuth, elicitations, policies, toolsets and clients.
 * Plain functions over a PgContext; PostgresStore delegates here. Every method returns what the SqliteStore method
 * returns (same shapes, ordering, null/undefined); the row mappers mirror database.ts.
 *
 * Ordering notes (SQLite parity):
 * - Text sorts use `COLLATE "C"` (SQLite compares TEXT by code point); SQLite's `COLLATE NOCASE` folds ASCII A–Z only,
 *   which `asciiLower` below reproduces.
 * - SQLite breaks timestamp ties by `rowid` (insertion order); Postgres breaks them by `seq`, the identity column v40
 *   adds to probes, snapshots, tool calls, elicitations, tool policies (evaluation order depends on it), toolset
 *   members and gateway clients. `seq` never changes on UPDATE or VACUUM, unlike `xmin` / `ctid`.
 */
import { randomUUID } from "node:crypto";
import {
  MCP_POLICY_KINDS,
  MCP_POLICY_ROLES,
  MCP_TOOL_HINT_CONDITIONS,
  normalizeMcpRuntimeLimits,
  normalizeMcpSandboxSettings,
  type McpClient,
  type McpElicitationSchema,
  type McpElicitationStatus,
  type McpOAuthConnectionState,
  type McpPolicyKind,
  type McpPolicyRole,
  type McpPrompt,
  type McpResource,
  type McpResourceTemplate,
  type McpSandboxSettings,
  type McpSandboxStatus,
  type McpServerCapabilities,
  type McpToolClassificationOverride,
  type McpToolHintCondition,
  type McpToolPolicyRule,
  type McpToolset,
  type McpToolsetMember,
  type McpToolsetMemberSpec
} from "@ai-orchestrator/shared";
import type { PoolClient } from "pg";
import {
  normalizeMcpSamplingSettings,
  type McpClientSecretRecord,
  type McpClientUsageRow,
  type McpElicitationRecord,
  type McpOAuthConnectionRecord,
  type McpServerCatalogRecord,
  type McpServerProbeRecord,
  type McpServerRecord,
  type McpServerStatus,
  type McpToolCallRecord,
  type McpToolCallWrite,
  type McpToolSnapshotRecord,
  type McpUserOAuthConnectionRecord
} from "../database.js";
import { type Store } from "../store.js";
import { parseJsonSafe, toNum, toStr } from "./helpers.js";
import type { PgContext } from "./context.js";

export const UNIMPLEMENTED_METHODS: readonly (keyof Store)[] = [];

type Row = Record<string, unknown>;
type Queryable = Pick<PoolClient, "query">;

/** SQLite `rowid ASC` / `rowid DESC`: v40's identity column. */
const INSERTION_ASC = `seq ASC`;
const INSERTION_DESC = `seq DESC`;

/** SQLite `COLLATE NOCASE`: ASCII letters folded, everything else compared by code point. */
function asciiLower(column: string): string {
  return `translate(${column}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') COLLATE "C"`;
}

/** A timestamp for a TIMESTAMPTZ column: "" (which SQLite stores and reads back as none) becomes NULL. */
function tsOrNull(value: string | null | undefined): string | null {
  return value ? value : null;
}

async function rows<T = Row>(db: Queryable, sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await db.query(sql, params);
  return result.rows as T[];
}

async function one<T = Row>(db: Queryable, sql: string, params: unknown[] = []): Promise<T | null> {
  return (await rows<T>(db, sql, params))[0] ?? null;
}

/** Turns `a = ?, b = ?` field lists into `$n` placeholders starting at 1. */
function numbered(fields: string[]): string[] {
  let n = 0;
  return fields.map((field) => field.replace("?", () => `$${++n}`));
}

// ---------------------------------------------------------------------------
// Row mappers (as in database.ts)
// ---------------------------------------------------------------------------

const MCP_OAUTH_STATES: readonly McpOAuthConnectionState[] = ["not_connected", "connected", "expired", "error"];
const MCP_ELICITATION_STATUSES = new Set<McpElicitationStatus>(["pending", "accepted", "declined", "cancelled", "expired", "auto_declined"]);
const MCP_SERVER_STATUSES = new Set<McpServerStatus>(["unknown", "healthy", "degraded", "down"]);

function optional(value: unknown): string | null {
  return value === null || value === undefined || value === "" ? null : toStr(value);
}

function readStoredSandbox(raw: unknown): McpSandboxSettings | null {
  if (!raw) return null;
  const parsed = parseJsonSafe(toStr(raw));
  if (!parsed || typeof parsed !== "object") return null;
  const normalized = normalizeMcpSandboxSettings(parsed);
  if (normalized) return normalized;
  const record = parsed as Record<string, unknown>;
  return record.mode === "none" ? { mode: "none" } : ({ ...record, mode: "container" } as McpSandboxSettings);
}

function mapMcpServer(row: Row): McpServerRecord {
  const status = toStr(row.status) as McpServerStatus;
  return {
    id: toStr(row.id),
    name: toStr(row.name),
    description: row.description ? toStr(row.description) : null,
    adapterId: toStr(row.adapter_id),
    connection: row.connection_json ? (parseJsonSafe(toStr(row.connection_json)) as Record<string, unknown>) ?? {} : {},
    secretId: row.secret_id ? toStr(row.secret_id) : null,
    owner: row.owner ? toStr(row.owner) : null,
    projectId: row.project_id ? toStr(row.project_id) : null,
    probeEnabled: toNum(row.probe_enabled) === 1,
    probeIntervalMs: row.probe_interval_ms === null || row.probe_interval_ms === undefined ? null : toNum(row.probe_interval_ms),
    blockOnBreakingChange: toNum(row.block_on_breaking_change) === 1,
    status: MCP_SERVER_STATUSES.has(status) ? status : "unknown",
    lastProbeAt: row.last_probe_at ? toStr(row.last_probe_at) : null,
    lastProbeOk: row.last_probe_ok === null || row.last_probe_ok === undefined ? null : toNum(row.last_probe_ok) === 1,
    lastProbeLatencyMs:
      row.last_probe_latency_ms === null || row.last_probe_latency_ms === undefined ? null : toNum(row.last_probe_latency_ms),
    lastProbeError: row.last_probe_error ? toStr(row.last_probe_error) : null,
    toolCount: toNum(row.tool_count),
    currentSnapshotId: row.current_snapshot_id ? toStr(row.current_snapshot_id) : null,
    pendingBreakingSnapshotId: row.pending_breaking_snapshot_id ? toStr(row.pending_breaking_snapshot_id) : null,
    sampling: normalizeMcpSamplingSettings(row.sampling_json ? parseJsonSafe(toStr(row.sampling_json)) : null),
    sandbox: readStoredSandbox(row.sandbox_json),
    sandboxStatus: row.sandbox_status_json ? ((parseJsonSafe(toStr(row.sandbox_status_json)) as McpSandboxStatus | null) ?? null) : null,
    limits: normalizeMcpRuntimeLimits(row.limits_json ? parseJsonSafe(toStr(row.limits_json)) : null),
    credentialMode: row.credential_mode === "delegated" ? "delegated" : "service",
    delegatedFallback: row.delegated_fallback === "owner" ? "owner" : "none",
    createdBy: row.created_by ? toStr(row.created_by) : null,
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at)
  };
}

function mapMcpServerProbe(row: Row): McpServerProbeRecord {
  return {
    id: toStr(row.id),
    serverId: toStr(row.server_id),
    startedAt: toStr(row.started_at),
    ok: toNum(row.ok) === 1,
    latencyMs: toNum(row.latency_ms),
    toolCount: toNum(row.tool_count),
    error: row.error ? toStr(row.error) : null,
    snapshotId: row.snapshot_id ? toStr(row.snapshot_id) : null
  };
}

function mapMcpToolSnapshot(row: Row): McpToolSnapshotRecord {
  const tools = parseJsonSafe(toStr(row.tools_json));
  const changes = row.changes_json ? parseJsonSafe(toStr(row.changes_json)) : [];
  return {
    id: toStr(row.id),
    serverId: toStr(row.server_id),
    hash: toStr(row.hash),
    tools: Array.isArray(tools) ? (tools as McpToolSnapshotRecord["tools"]) : [],
    toolCount: toNum(row.tool_count),
    previousSnapshotId: row.previous_snapshot_id ? toStr(row.previous_snapshot_id) : null,
    changes: Array.isArray(changes) ? (changes as McpToolSnapshotRecord["changes"]) : [],
    breaking: toNum(row.breaking) === 1,
    acknowledgedAt: row.acknowledged_at ? toStr(row.acknowledged_at) : null,
    acknowledgedBy: row.acknowledged_by ? toStr(row.acknowledged_by) : null,
    createdAt: toStr(row.created_at)
  };
}

function nullableNum(value: unknown): number | null {
  return value === null || value === undefined ? null : toNum(value);
}

function mapMcpToolCall(row: Row): McpToolCallRecord {
  return {
    id: toStr(row.id),
    executionId: toStr(row.execution_id),
    workflowId: toStr(row.workflow_id),
    nodeId: toStr(row.node_id),
    registryServerId: row.registry_server_id ? toStr(row.registry_server_id) : null,
    adapterId: toStr(row.adapter_id),
    toolName: toStr(row.tool_name),
    startedAt: toStr(row.started_at),
    durationMs: nullableNum(row.duration_ms),
    ok: toNum(row.ok) === 1,
    error: row.error ? toStr(row.error) : null,
    turnInputTokens: nullableNum(row.turn_input_tokens),
    turnOutputTokens: nullableNum(row.turn_output_tokens),
    estimatedCostUsd: row.estimated_cost_usd === null || row.estimated_cost_usd === undefined ? null : Number(row.estimated_cost_usd),
    samplingRequests: nullableNum(row.sampling_requests),
    samplingInputTokens: nullableNum(row.sampling_input_tokens),
    samplingOutputTokens: nullableNum(row.sampling_output_tokens),
    source: row.source === "gateway" || row.source === "playground" ? row.source : "workflow",
    clientId: row.client_id ? toStr(row.client_id) : null,
    rejection:
      row.rejection === "rate_limited" || row.rejection === "concurrency_limited" || row.rejection === "circuit_open" ? row.rejection : null,
    createdAt: toStr(row.created_at)
  };
}

function mapMcpOAuthConnection(row: Row): McpOAuthConnectionRecord {
  const state = toStr(row.state) as McpOAuthConnectionState;
  const registration = row.client_registration ? toStr(row.client_registration) : null;
  return {
    serverId: toStr(row.server_id),
    secretId: optional(row.secret_id),
    state: MCP_OAUTH_STATES.includes(state) ? state : "not_connected",
    subject: optional(row.subject),
    scope: optional(row.scope),
    authorizationServer: optional(row.authorization_server),
    clientRegistration: registration === "dynamic" || registration === "pre_registered" ? registration : null,
    clientId: optional(row.client_id),
    expiresAt: optional(row.expires_at),
    hasRefreshToken: toNum(row.has_refresh_token) === 1,
    lastRefreshAt: optional(row.last_refresh_at),
    connectedAt: optional(row.connected_at),
    connectedBy: optional(row.connected_by),
    lastError: optional(row.last_error),
    updatedAt: toStr(row.updated_at)
  };
}

function mapMcpUserOAuthConnection(row: Row): McpUserOAuthConnectionRecord {
  const state = toStr(row.state) as McpOAuthConnectionState;
  const registration = row.client_registration ? toStr(row.client_registration) : null;
  return {
    serverId: toStr(row.server_id),
    userId: toStr(row.user_id),
    secretId: optional(row.secret_id),
    state: MCP_OAUTH_STATES.includes(state) ? state : "not_connected",
    subject: optional(row.subject),
    scope: optional(row.scope),
    authorizationServer: optional(row.authorization_server),
    clientRegistration: registration === "dynamic" || registration === "pre_registered" ? registration : null,
    clientId: optional(row.client_id),
    expiresAt: optional(row.expires_at),
    hasRefreshToken: toNum(row.has_refresh_token) === 1,
    lastRefreshAt: optional(row.last_refresh_at),
    connectedAt: optional(row.connected_at),
    lastError: optional(row.last_error),
    updatedAt: toStr(row.updated_at)
  };
}

function mapMcpServerCatalog(row: Row): McpServerCatalogRecord {
  const parse = <T>(value: unknown, fallback: T): T => {
    if (!value) return fallback;
    const parsed = parseJsonSafe(toStr(value));
    return (parsed ?? fallback) as T;
  };
  return {
    serverId: toStr(row.server_id),
    capabilities: parse<McpServerCapabilities>(row.capabilities_json, {}),
    resources: parse<McpResource[]>(row.resources_json, []),
    resourceTemplates: parse<McpResourceTemplate[]>(row.resource_templates_json, []),
    prompts: parse<McpPrompt[]>(row.prompts_json, []),
    updatedAt: toStr(row.updated_at)
  };
}

function mapMcpElicitation(row: Row): McpElicitationRecord {
  const status = toStr(row.status) as McpElicitationStatus;
  const schema = parseJsonSafe(toStr(row.schema_json)) as McpElicitationSchema | null;
  return {
    id: toStr(row.id),
    executionId: toStr(row.execution_id),
    workflowId: toStr(row.workflow_id),
    ...(row.workflow_name ? { workflowName: toStr(row.workflow_name) } : {}),
    nodeId: toStr(row.node_id),
    serverId: toStr(row.server_id),
    ...(row.registry_server_id ? { registryServerId: toStr(row.registry_server_id) } : {}),
    ...(row.server_name ? { serverName: toStr(row.server_name) } : {}),
    toolName: toStr(row.tool_name),
    message: toStr(row.message),
    requestedSchema: schema ?? { type: "object", properties: {} },
    status: MCP_ELICITATION_STATUSES.has(status) ? status : "pending",
    createdAt: toStr(row.created_at),
    expiresAt: toStr(row.expires_at),
    ...(row.answered_at ? { answeredAt: toStr(row.answered_at) } : {}),
    ...(row.answered_by ? { answeredBy: toStr(row.answered_by) } : {}),
    ...(row.reason ? { reason: toStr(row.reason) } : {}),
    createdBy: row.created_by ? toStr(row.created_by) : null,
    triggerType: row.trigger_type ? toStr(row.trigger_type) : null
  };
}

function mapMcpToolPolicy(row: Row): McpToolPolicyRule {
  const hint = row.annotation_hint ? toStr(row.annotation_hint) : null;
  const kind = row.kind ? toStr(row.kind) : "tool";
  const roles = row.roles_json ? parseJsonSafe(toStr(row.roles_json)) : [];
  return {
    id: toStr(row.id),
    name: row.name ? toStr(row.name) : null,
    description: row.description ? toStr(row.description) : null,
    effect: toStr(row.effect) === "allow" ? "allow" : "deny",
    projectId: row.project_id ? toStr(row.project_id) : null,
    roles: Array.isArray(roles) ? roles.filter((role): role is McpPolicyRole => MCP_POLICY_ROLES.includes(role as McpPolicyRole)) : [],
    serverId: row.server_id ? toStr(row.server_id) : null,
    toolPattern: toStr(row.tool_pattern) || "*",
    annotationHint: hint && MCP_TOOL_HINT_CONDITIONS.includes(hint as McpToolHintCondition) ? (hint as McpToolHintCondition) : null,
    kind: MCP_POLICY_KINDS.includes(kind as McpPolicyKind) ? (kind as McpPolicyKind) : "tool",
    enabled: toNum(row.enabled) === 1,
    createdBy: row.created_by ? toStr(row.created_by) : null,
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at)
  };
}

function mapMcpToolClassification(row: Row): McpToolClassificationOverride {
  return {
    registryServerId: toStr(row.server_id),
    toolName: toStr(row.tool_name),
    readOnly: toNum(row.read_only) === 1,
    setBy: row.set_by ? toStr(row.set_by) : null,
    setAt: toStr(row.set_at)
  };
}

function mapMcpToolsetMember(row: Row): McpToolsetMember | null {
  if (toStr(row.kind) === "workflow" && row.workflow_id) {
    return { id: toStr(row.id), kind: "workflow", workflowId: toStr(row.workflow_id) };
  }
  if (toStr(row.kind) === "server" && row.server_id) {
    return { id: toStr(row.id), kind: "server", serverId: toStr(row.server_id), toolGlob: row.tool_glob ? toStr(row.tool_glob) : null };
  }
  return null;
}

function mapMcpToolset(row: Row, members: McpToolsetMember[]): McpToolset {
  return {
    id: toStr(row.id),
    slug: toStr(row.slug),
    name: toStr(row.name),
    description: row.description ? toStr(row.description) : null,
    projectId: row.project_id ? toStr(row.project_id) : null,
    enabled: toNum(row.enabled) === 1,
    members,
    createdBy: row.created_by ? toStr(row.created_by) : null,
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at)
  };
}

function mapMcpClient(row: Row): McpClientSecretRecord {
  const toolsetIds = row.toolset_ids_json ? parseJsonSafe(toStr(row.toolset_ids_json)) : [];
  const role = toStr(row.role) as McpPolicyRole;
  return {
    id: toStr(row.id),
    name: toStr(row.name),
    tokenPrefix: toStr(row.token_prefix),
    tokenHash: toStr(row.token_hash),
    toolsetIds: Array.isArray(toolsetIds) ? toolsetIds.filter((id): id is string => typeof id === "string") : [],
    role: MCP_POLICY_ROLES.includes(role) ? role : "viewer",
    createdBy: row.created_by ? toStr(row.created_by) : null,
    createdByEmail: row.created_by_email ? toStr(row.created_by_email) : null,
    expiresAt: row.expires_at ? toStr(row.expires_at) : null,
    lastUsedAt: row.last_used_at ? toStr(row.last_used_at) : null,
    revokedAt: row.revoked_at ? toStr(row.revoked_at) : null,
    createdAt: toStr(row.created_at)
  };
}

function withoutHash(record: McpClientSecretRecord): McpClient {
  const { tokenHash: _hash, ...client } = record;
  return client;
}

// ---------------------------------------------------------------------------
// Phase 10.1 — MCP server registry
// ---------------------------------------------------------------------------

export async function createMcpServer(ctx: PgContext, ...[input]: Parameters<Store["createMcpServer"]>): ReturnType<Store["createMcpServer"]> {
  const now = new Date().toISOString();
  await ctx.execute(
    `INSERT INTO mcp_servers (
       id, name, description, adapter_id, connection_json, secret_id, owner, project_id,
       probe_enabled, probe_interval_ms, block_on_breaking_change, status, tool_count,
       sampling_json, sandbox_json, limits_json, credential_mode, delegated_fallback,
       created_by, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'unknown', 0, $12, $13, $14, $15, $16, $17, $18, $19)`,
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

export async function updateMcpServer(ctx: PgContext, ...[id, patch]: Parameters<Store["updateMcpServer"]>): ReturnType<Store["updateMcpServer"]> {
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
  await ctx.execute(`UPDATE mcp_servers SET ${numbered(fields).join(", ")} WHERE id = $${params.length}`, params);
  return true;
}

export async function deleteMcpServer(ctx: PgContext, ...[id]: Parameters<Store["deleteMcpServer"]>): ReturnType<Store["deleteMcpServer"]> {
  return ctx.withTransaction(async (client) => {
    const existing = await one(client, `SELECT id FROM mcp_servers WHERE id = $1 FOR UPDATE`, [id]);
    if (!existing) return false;
    await client.query(`DELETE FROM mcp_server_probes WHERE server_id = $1`, [id]);
    await client.query(`DELETE FROM mcp_tool_snapshots WHERE server_id = $1`, [id]);
    await client.query(`DELETE FROM mcp_tool_calls WHERE registry_server_id = $1`, [id]);
    await client.query(`DELETE FROM mcp_tool_classifications WHERE server_id = $1`, [id]);
    await client.query(`DELETE FROM mcp_toolset_members WHERE kind = 'server' AND server_id = $1`, [id]);
    await client.query(`DELETE FROM mcp_oauth_connections WHERE server_id = $1`, [id]);
    await client.query(`DELETE FROM mcp_user_oauth_connections WHERE server_id = $1`, [id]);
    await client.query(`DELETE FROM mcp_server_catalogs WHERE server_id = $1`, [id]);
    await client.query(`DELETE FROM mcp_servers WHERE id = $1`, [id]);
    return true;
  });
}

export async function setMcpServerSandboxStatus(ctx: PgContext, ...[id, status]: Parameters<Store["setMcpServerSandboxStatus"]>): ReturnType<Store["setMcpServerSandboxStatus"]> {
  await ctx.execute(`UPDATE mcp_servers SET sandbox_status_json = $1 WHERE id = $2`, [status ? JSON.stringify(status) : null, id]);
}

async function getMcpServerOn(db: Queryable, id: string): Promise<McpServerRecord | null> {
  const row = await one(db, `SELECT * FROM mcp_servers WHERE id = $1`, [id]);
  return row ? mapMcpServer(row) : null;
}

export async function getMcpServer(ctx: PgContext, ...[id]: Parameters<Store["getMcpServer"]>): ReturnType<Store["getMcpServer"]> {
  return getMcpServerOn(ctx.pool, id);
}

export async function listMcpServers(ctx: PgContext, ...[filter = {}]: Parameters<Store["listMcpServers"]>): ReturnType<Store["listMcpServers"]> {
  const order = `ORDER BY name COLLATE "C", created_at, id COLLATE "C"`;
  const result = filter.projectId
    ? await ctx.query<Row>(`SELECT * FROM mcp_servers WHERE project_id = $1 OR project_id IS NULL ${order}`, [filter.projectId])
    : await ctx.query<Row>(`SELECT * FROM mcp_servers ${order}`);
  return result.map(mapMcpServer);
}

export async function recordMcpServerProbe(ctx: PgContext, ...[input]: Parameters<Store["recordMcpServerProbe"]>): ReturnType<Store["recordMcpServerProbe"]> {
  const { probe, snapshot } = input;
  await ctx.withTransaction(async (client) => {
    if (snapshot) {
      await client.query(
        `INSERT INTO mcp_tool_snapshots (
           id, server_id, hash, tools_json, tool_count, previous_snapshot_id, changes_json, breaking, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
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
    await client.query(
      `INSERT INTO mcp_server_probes (id, server_id, started_at, ok, latency_ms, tool_count, error, snapshot_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [probe.id, probe.serverId, probe.startedAt, probe.ok ? 1 : 0, probe.latencyMs, probe.toolCount, probe.error, probe.snapshotId]
    );
    const fields = ["status = ?", "last_probe_at = ?", "last_probe_ok = ?", "last_probe_latency_ms = ?", "last_probe_error = ?"];
    const params: Array<string | number | null> = [input.status, probe.startedAt, probe.ok ? 1 : 0, probe.latencyMs, probe.error];
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
    await client.query(`UPDATE mcp_servers SET ${numbered(fields).join(", ")} WHERE id = $${params.length}`, params);
    await client.query(
      `DELETE FROM mcp_server_probes WHERE server_id = $1 AND id NOT IN (
         SELECT id FROM mcp_server_probes WHERE server_id = $1 ORDER BY started_at DESC, ${INSERTION_DESC} LIMIT $2
       )`,
      [probe.serverId, input.keepProbes]
    );
  });
}

export async function listMcpServerProbes(ctx: PgContext, ...[serverId, limit = 100]: Parameters<Store["listMcpServerProbes"]>): ReturnType<Store["listMcpServerProbes"]> {
  const result = await ctx.query<Row>(
    `SELECT * FROM mcp_server_probes WHERE server_id = $1 ORDER BY started_at DESC, ${INSERTION_DESC} LIMIT $2`,
    [serverId, limit]
  );
  return result.map(mapMcpServerProbe);
}

async function getMcpToolSnapshotOn(db: Queryable, id: string): Promise<McpToolSnapshotRecord | null> {
  const row = await one(db, `SELECT * FROM mcp_tool_snapshots WHERE id = $1`, [id]);
  return row ? mapMcpToolSnapshot(row) : null;
}

export async function getMcpToolSnapshot(ctx: PgContext, ...[id]: Parameters<Store["getMcpToolSnapshot"]>): ReturnType<Store["getMcpToolSnapshot"]> {
  return getMcpToolSnapshotOn(ctx.pool, id);
}

export async function listMcpToolSnapshots(ctx: PgContext, ...[serverId, limit = 50]: Parameters<Store["listMcpToolSnapshots"]>): ReturnType<Store["listMcpToolSnapshots"]> {
  const result = await ctx.query<Row>(
    `SELECT * FROM mcp_tool_snapshots WHERE server_id = $1 ORDER BY created_at DESC, ${INSERTION_DESC} LIMIT $2`,
    [serverId, limit]
  );
  return result.map(mapMcpToolSnapshot);
}

export async function acknowledgeMcpBreakingChange(ctx: PgContext, ...[serverId, acknowledgedBy]: Parameters<Store["acknowledgeMcpBreakingChange"]>): ReturnType<Store["acknowledgeMcpBreakingChange"]> {
  return ctx.withTransaction(async (client) => {
    const server = await one<{ pending_breaking_snapshot_id: string | null }>(
      client,
      `SELECT pending_breaking_snapshot_id FROM mcp_servers WHERE id = $1 FOR UPDATE`,
      [serverId]
    );
    const snapshotId = server?.pending_breaking_snapshot_id ? toStr(server.pending_breaking_snapshot_id) : null;
    if (!snapshotId) return null;
    const now = new Date().toISOString();
    await client.query(`UPDATE mcp_tool_snapshots SET acknowledged_at = $1, acknowledged_by = $2 WHERE id = $3`, [now, acknowledgedBy, snapshotId]);
    await client.query(`UPDATE mcp_servers SET pending_breaking_snapshot_id = NULL, updated_at = $1 WHERE id = $2`, [now, serverId]);
    return getMcpToolSnapshotOn(client, snapshotId);
  });
}

// ---------------------------------------------------------------------------
// Tool-call telemetry
// ---------------------------------------------------------------------------

async function insertMcpToolCallRow(db: Queryable, call: McpToolCallWrite): Promise<void> {
  await db.query(
    `INSERT INTO mcp_tool_calls (
       id, execution_id, workflow_id, node_id, registry_server_id, adapter_id, tool_name,
       started_at, duration_ms, ok, error, turn_input_tokens, turn_output_tokens,
       estimated_cost_usd, sampling_requests, sampling_input_tokens, sampling_output_tokens,
       source, client_id, rejection, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
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
      new Date().toISOString()
    ]
  );
}

export async function replaceMcpToolCallsForExecution(ctx: PgContext, ...[executionId, calls]: Parameters<Store["replaceMcpToolCallsForExecution"]>): ReturnType<Store["replaceMcpToolCallsForExecution"]> {
  await ctx.withTransaction(async (client) => {
    // The gateway's own row for a workflow tool shares the execution id and is kept.
    await client.query(`DELETE FROM mcp_tool_calls WHERE execution_id = $1 AND source = 'workflow'`, [executionId]);
    for (const call of calls) {
      await insertMcpToolCallRow(client, { ...call, executionId });
    }
  });
}

export async function insertMcpToolCall(ctx: PgContext, ...[call]: Parameters<Store["insertMcpToolCall"]>): ReturnType<Store["insertMcpToolCall"]> {
  await insertMcpToolCallRow(ctx.pool, call);
}

export async function listMcpToolCallsForClient(ctx: PgContext, ...[clientId, since]: Parameters<Store["listMcpToolCallsForClient"]>): ReturnType<Store["listMcpToolCallsForClient"]> {
  const result = await ctx.query<Row>(
    `SELECT * FROM mcp_tool_calls WHERE client_id = $1 AND started_at >= $2 ORDER BY started_at, ${INSERTION_ASC}`,
    [clientId, since]
  );
  return result.map(mapMcpToolCall);
}

export async function summarizeMcpClientUsage(ctx: PgContext, ...[since]: Parameters<Store["summarizeMcpClientUsage"]>): ReturnType<Store["summarizeMcpClientUsage"]> {
  const result = await ctx.query<{ client_id: string; calls: string | number; errors: string | number | null; last_called_at: string | null }>(
    `SELECT client_id, COUNT(*) AS calls, SUM(CASE WHEN ok = 1 THEN 0 ELSE 1 END) AS errors,
            MAX(started_at) AS last_called_at
       FROM mcp_tool_calls
      WHERE client_id IS NOT NULL AND started_at >= $1
      GROUP BY client_id
      ORDER BY client_id COLLATE "C"`,
    [since]
  );
  return result.map((row): McpClientUsageRow => ({
    clientId: toStr(row.client_id),
    calls: toNum(row.calls),
    errors: toNum(row.errors),
    lastCalledAt: row.last_called_at ? toStr(row.last_called_at) : null
  }));
}

export async function listMcpToolCalls(ctx: PgContext, ...[filter]: Parameters<Store["listMcpToolCalls"]>): ReturnType<Store["listMcpToolCalls"]> {
  const result = filter.registryServerId === null
    ? await ctx.query<Row>(
        // Gateway rows without a registry server are workflow tools, not inline servers.
        `SELECT * FROM mcp_tool_calls WHERE registry_server_id IS NULL AND source = 'workflow' AND started_at >= $1 ORDER BY started_at, ${INSERTION_ASC}`,
        [filter.since]
      )
    : await ctx.query<Row>(
        `SELECT * FROM mcp_tool_calls WHERE registry_server_id = $1 AND started_at >= $2 ORDER BY started_at, ${INSERTION_ASC}`,
        [filter.registryServerId, filter.since]
      );
  return result.map(mapMcpToolCall);
}

export async function listMcpToolCallsForExecution(ctx: PgContext, ...[executionId]: Parameters<Store["listMcpToolCallsForExecution"]>): ReturnType<Store["listMcpToolCallsForExecution"]> {
  const result = await ctx.query<Row>(
    `SELECT * FROM mcp_tool_calls WHERE execution_id = $1 ORDER BY started_at, id COLLATE "C"`,
    [executionId]
  );
  return result.map(mapMcpToolCall);
}

// ---------------------------------------------------------------------------
// Phase 10.5 / 10.7 — OAuth connection status rows (no tokens)
// ---------------------------------------------------------------------------

async function getMcpOAuthConnectionOn(db: Queryable, serverId: string): Promise<McpOAuthConnectionRecord | null> {
  const row = await one(db, `SELECT * FROM mcp_oauth_connections WHERE server_id = $1`, [serverId]);
  return row ? mapMcpOAuthConnection(row) : null;
}

export async function getMcpOAuthConnection(ctx: PgContext, ...[serverId]: Parameters<Store["getMcpOAuthConnection"]>): ReturnType<Store["getMcpOAuthConnection"]> {
  return getMcpOAuthConnectionOn(ctx.pool, serverId);
}

export async function upsertMcpOAuthConnection(ctx: PgContext, ...[record]: Parameters<Store["upsertMcpOAuthConnection"]>): ReturnType<Store["upsertMcpOAuthConnection"]> {
  const now = new Date().toISOString();
  const row = await ctx.queryOne<Row>(
    `INSERT INTO mcp_oauth_connections (
       server_id, secret_id, state, subject, scope, authorization_server, client_registration, client_id,
       expires_at, has_refresh_token, last_refresh_at, connected_at, connected_by, last_error, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (server_id) DO UPDATE SET
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
       updated_at = excluded.updated_at
     RETURNING *`,
    [
      record.serverId,
      record.secretId,
      record.state,
      record.subject,
      record.scope,
      record.authorizationServer,
      record.clientRegistration,
      record.clientId,
      tsOrNull(record.expiresAt),
      record.hasRefreshToken ? 1 : 0,
      tsOrNull(record.lastRefreshAt),
      tsOrNull(record.connectedAt),
      record.connectedBy,
      record.lastError,
      now
    ]
  );
  return mapMcpOAuthConnection(row!);
}

async function getMcpUserOAuthConnectionOn(db: Queryable, serverId: string, userId: string): Promise<McpUserOAuthConnectionRecord | null> {
  const row = await one(db, `SELECT * FROM mcp_user_oauth_connections WHERE server_id = $1 AND user_id = $2`, [serverId, userId]);
  return row ? mapMcpUserOAuthConnection(row) : null;
}

export async function getMcpUserOAuthConnection(ctx: PgContext, ...[serverId, userId]: Parameters<Store["getMcpUserOAuthConnection"]>): ReturnType<Store["getMcpUserOAuthConnection"]> {
  return getMcpUserOAuthConnectionOn(ctx.pool, serverId, userId);
}

export async function listMcpUserOAuthConnections(ctx: PgContext, ...[filter = {}]: Parameters<Store["listMcpUserOAuthConnections"]>): ReturnType<Store["listMcpUserOAuthConnections"]> {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filter.serverId) {
    params.push(filter.serverId);
    clauses.push(`server_id = $${params.length}`);
  }
  if (filter.userId) {
    params.push(filter.userId);
    clauses.push(`user_id = $${params.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await ctx.query<Row>(
    `SELECT * FROM mcp_user_oauth_connections ${where} ORDER BY server_id COLLATE "C", user_id COLLATE "C"`,
    params
  );
  return result.map(mapMcpUserOAuthConnection);
}

export async function upsertMcpUserOAuthConnection(ctx: PgContext, ...[record]: Parameters<Store["upsertMcpUserOAuthConnection"]>): ReturnType<Store["upsertMcpUserOAuthConnection"]> {
  const now = new Date().toISOString();
  const row = await ctx.queryOne<Row>(
    `INSERT INTO mcp_user_oauth_connections (
       server_id, user_id, secret_id, state, subject, scope, authorization_server, client_registration,
       client_id, expires_at, has_refresh_token, last_refresh_at, connected_at, last_error, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (server_id, user_id) DO UPDATE SET
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
       updated_at = excluded.updated_at
     RETURNING *`,
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
      tsOrNull(record.expiresAt),
      record.hasRefreshToken ? 1 : 0,
      tsOrNull(record.lastRefreshAt),
      tsOrNull(record.connectedAt),
      record.lastError,
      now
    ]
  );
  return mapMcpUserOAuthConnection(row!);
}

export async function deleteMcpUserOAuthConnection(ctx: PgContext, ...[serverId, userId]: Parameters<Store["deleteMcpUserOAuthConnection"]>): ReturnType<Store["deleteMcpUserOAuthConnection"]> {
  const result = await ctx.pool.query(`DELETE FROM mcp_user_oauth_connections WHERE server_id = $1 AND user_id = $2`, [serverId, userId]);
  return (result.rowCount ?? 0) > 0;
}

export async function deleteMcpOAuthConnection(ctx: PgContext, ...[serverId]: Parameters<Store["deleteMcpOAuthConnection"]>): ReturnType<Store["deleteMcpOAuthConnection"]> {
  const result = await ctx.pool.query(`DELETE FROM mcp_oauth_connections WHERE server_id = $1`, [serverId]);
  return (result.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Phase 10.5 — server catalogs and elicitations
// ---------------------------------------------------------------------------

export async function getMcpServerCatalog(ctx: PgContext, ...[serverId]: Parameters<Store["getMcpServerCatalog"]>): ReturnType<Store["getMcpServerCatalog"]> {
  const row = await ctx.queryOne<Row>(`SELECT * FROM mcp_server_catalogs WHERE server_id = $1`, [serverId]);
  return row ? mapMcpServerCatalog(row) : null;
}

export async function upsertMcpServerCatalog(ctx: PgContext, ...[serverId, catalog]: Parameters<Store["upsertMcpServerCatalog"]>): ReturnType<Store["upsertMcpServerCatalog"]> {
  const now = new Date().toISOString();
  const row = await ctx.queryOne<Row>(
    `INSERT INTO mcp_server_catalogs (server_id, capabilities_json, resources_json, resource_templates_json, prompts_json, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (server_id) DO UPDATE SET
       capabilities_json = excluded.capabilities_json,
       resources_json = excluded.resources_json,
       resource_templates_json = excluded.resource_templates_json,
       prompts_json = excluded.prompts_json,
       updated_at = excluded.updated_at
     RETURNING *`,
    [
      serverId,
      JSON.stringify(catalog.capabilities ?? {}),
      JSON.stringify(catalog.resources ?? []),
      JSON.stringify(catalog.resourceTemplates ?? []),
      JSON.stringify(catalog.prompts ?? []),
      now
    ]
  );
  return mapMcpServerCatalog(row!);
}

export async function createMcpElicitation(ctx: PgContext, ...[input]: Parameters<Store["createMcpElicitation"]>): ReturnType<Store["createMcpElicitation"]> {
  const row = await ctx.queryOne<Row>(
    `INSERT INTO mcp_elicitations (
       id, execution_id, workflow_id, workflow_name, node_id, server_id, registry_server_id, server_name,
       tool_name, message, schema_json, status, created_at, expires_at, created_by, trigger_type
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', $12, $13, $14, $15)
     RETURNING *`,
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
      input.triggerType ?? null
    ]
  );
  return mapMcpElicitation(row!);
}

export async function getMcpElicitation(ctx: PgContext, ...[id]: Parameters<Store["getMcpElicitation"]>): ReturnType<Store["getMcpElicitation"]> {
  const row = await ctx.queryOne<Row>(`SELECT * FROM mcp_elicitations WHERE id = $1`, [id]);
  return row ? mapMcpElicitation(row) : null;
}

export async function listMcpElicitations(ctx: PgContext, ...[filter = {}]: Parameters<Store["listMcpElicitations"]>): ReturnType<Store["listMcpElicitations"]> {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (filter.status) { params.push(filter.status); where.push(`status = $${params.length}`); }
  if (filter.executionId) { params.push(filter.executionId); where.push(`execution_id = $${params.length}`); }
  const limit = Math.max(1, Math.min(500, Math.floor(filter.limit ?? 100)));
  params.push(limit);
  const result = await ctx.query<Row>(
    `SELECT * FROM mcp_elicitations ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC, ${INSERTION_DESC} LIMIT $${params.length}`,
    params
  );
  return result.map(mapMcpElicitation);
}

/** First answer wins: only a still-pending elicitation is settled, in one conditional UPDATE. */
export async function settleMcpElicitation(ctx: PgContext, ...[id, outcome]: Parameters<Store["settleMcpElicitation"]>): ReturnType<Store["settleMcpElicitation"]> {
  const result = await ctx.pool.query(
    `UPDATE mcp_elicitations SET status = $1, answered_at = $2, answered_by = $3, reason = $4 WHERE id = $5 AND status = 'pending'`,
    [outcome.status, new Date().toISOString(), outcome.answeredBy ?? null, outcome.reason ?? null, id]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function expireMcpElicitationsForExecution(ctx: PgContext, ...[executionId, reason]: Parameters<Store["expireMcpElicitationsForExecution"]>): ReturnType<Store["expireMcpElicitationsForExecution"]> {
  const result = await ctx.pool.query(
    `UPDATE mcp_elicitations SET status = 'expired', answered_at = $1, answered_by = NULL, reason = $2
      WHERE status = 'pending' AND id IN (
        SELECT id FROM mcp_elicitations WHERE status = 'pending' AND execution_id = $3
         ORDER BY created_at DESC, ${INSERTION_DESC} LIMIT 500
      )`,
    [new Date().toISOString(), reason, executionId]
  );
  return result.rowCount ?? 0;
}

export async function listExpiredMcpElicitations(ctx: PgContext, ...[now]: Parameters<Store["listExpiredMcpElicitations"]>): ReturnType<Store["listExpiredMcpElicitations"]> {
  const result = await ctx.query<Row>(
    `SELECT * FROM mcp_elicitations WHERE status = 'pending' AND expires_at <= $1 ORDER BY ${INSERTION_ASC}`,
    [now]
  );
  return result.map(mapMcpElicitation);
}

// ---------------------------------------------------------------------------
// Phase 10.2 — MCP tool policy and read-only classifications
// ---------------------------------------------------------------------------

/** Rules in evaluation order: oldest first, ties in insertion order (see the header). */
export async function listMcpToolPolicies(ctx: PgContext, ..._args: Parameters<Store["listMcpToolPolicies"]>): ReturnType<Store["listMcpToolPolicies"]> {
  const result = await ctx.query<Row>(`SELECT * FROM mcp_tool_policies ORDER BY created_at ASC, ${INSERTION_ASC}`);
  return result.map(mapMcpToolPolicy);
}

async function getMcpToolPolicyOn(db: Queryable, id: string): Promise<McpToolPolicyRule | null> {
  const row = await one(db, `SELECT * FROM mcp_tool_policies WHERE id = $1`, [id]);
  return row ? mapMcpToolPolicy(row) : null;
}

export async function getMcpToolPolicy(ctx: PgContext, ...[id]: Parameters<Store["getMcpToolPolicy"]>): ReturnType<Store["getMcpToolPolicy"]> {
  return getMcpToolPolicyOn(ctx.pool, id);
}

export async function createMcpToolPolicy(ctx: PgContext, ...[input]: Parameters<Store["createMcpToolPolicy"]>): ReturnType<Store["createMcpToolPolicy"]> {
  const now = new Date().toISOString();
  const row = await ctx.queryOne<Row>(
    `INSERT INTO mcp_tool_policies (
       id, name, description, effect, project_id, roles_json, server_id, tool_pattern, annotation_hint, kind, enabled,
       created_by, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)
     RETURNING *`,
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
      input.createdBy ?? null,
      now
    ]
  );
  return mapMcpToolPolicy(row!);
}

export async function updateMcpToolPolicy(ctx: PgContext, ...[id, patch]: Parameters<Store["updateMcpToolPolicy"]>): ReturnType<Store["updateMcpToolPolicy"]> {
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
  if (fields.length > 0) {
    fields.push("updated_at = ?");
    params.push(new Date().toISOString());
    params.push(id);
    const row = await ctx.queryOne<Row>(
      `UPDATE mcp_tool_policies SET ${numbered(fields).join(", ")} WHERE id = $${params.length} RETURNING *`,
      params
    );
    return row ? mapMcpToolPolicy(row) : null;
  }
  return getMcpToolPolicyOn(ctx.pool, id);
}

export async function deleteMcpToolPolicy(ctx: PgContext, ...[id]: Parameters<Store["deleteMcpToolPolicy"]>): ReturnType<Store["deleteMcpToolPolicy"]> {
  const result = await ctx.pool.query(`DELETE FROM mcp_tool_policies WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function listMcpToolClassifications(ctx: PgContext, ...[registryServerId]: Parameters<Store["listMcpToolClassifications"]>): ReturnType<Store["listMcpToolClassifications"]> {
  const result = registryServerId
    ? await ctx.query<Row>(`SELECT * FROM mcp_tool_classifications WHERE server_id = $1 ORDER BY tool_name COLLATE "C"`, [registryServerId])
    : await ctx.query<Row>(`SELECT * FROM mcp_tool_classifications ORDER BY server_id COLLATE "C", tool_name COLLATE "C"`);
  return result.map(mapMcpToolClassification);
}

export async function setMcpToolClassification(ctx: PgContext, ...[input]: Parameters<Store["setMcpToolClassification"]>): ReturnType<Store["setMcpToolClassification"]> {
  if (input.readOnly === null) {
    await ctx.execute(`DELETE FROM mcp_tool_classifications WHERE server_id = $1 AND tool_name = $2`, [input.registryServerId, input.toolName]);
    return null;
  }
  const now = new Date().toISOString();
  await ctx.execute(
    `INSERT INTO mcp_tool_classifications (server_id, tool_name, read_only, set_by, set_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (server_id, tool_name) DO UPDATE SET
       read_only = excluded.read_only,
       set_by = excluded.set_by,
       set_at = excluded.set_at`,
    [input.registryServerId, input.toolName, input.readOnly ? 1 : 0, input.setBy, now]
  );
  return { registryServerId: input.registryServerId, toolName: input.toolName, readOnly: input.readOnly, setBy: input.setBy, setAt: now };
}

// ---------------------------------------------------------------------------
// Phase 10.4 — MCP gateway toolsets and client credentials
// ---------------------------------------------------------------------------

async function listMcpToolsetMembers(db: Queryable, toolsetIds: string[]): Promise<Map<string, McpToolsetMember[]>> {
  const byToolset = new Map<string, McpToolsetMember[]>(toolsetIds.map((id) => [id, []]));
  if (toolsetIds.length === 0) return byToolset;
  const memberRows = await rows(
    db,
    `SELECT * FROM mcp_toolset_members WHERE toolset_id = ANY($1::text[]) ORDER BY position ASC, ${INSERTION_ASC}`,
    [toolsetIds]
  );
  for (const row of memberRows) {
    const member = mapMcpToolsetMember(row);
    if (member) byToolset.get(toStr(row.toolset_id))?.push(member);
  }
  return byToolset;
}

async function toolsetsWithMembers(db: Queryable, toolsetRows: Row[]): Promise<McpToolset[]> {
  const members = await listMcpToolsetMembers(db, toolsetRows.map((row) => toStr(row.id)));
  return toolsetRows.map((row) => mapMcpToolset(row, members.get(toStr(row.id)) ?? []));
}

async function getMcpToolsetOn(db: Queryable, id: string): Promise<McpToolset | null> {
  const row = await one(db, `SELECT * FROM mcp_toolsets WHERE id = $1`, [id]);
  return row ? (await toolsetsWithMembers(db, [row]))[0]! : null;
}

async function writeMcpToolsetMembers(db: Queryable, toolsetId: string, members: Array<McpToolsetMemberSpec & { id?: string }>): Promise<void> {
  await db.query(`DELETE FROM mcp_toolset_members WHERE toolset_id = $1`, [toolsetId]);
  for (const [index, member] of members.entries()) {
    await db.query(
      `INSERT INTO mcp_toolset_members (id, toolset_id, kind, workflow_id, server_id, tool_glob, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
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
  }
}

export async function listMcpToolsets(ctx: PgContext, ..._args: Parameters<Store["listMcpToolsets"]>): ReturnType<Store["listMcpToolsets"]> {
  const toolsetRows = await ctx.query<Row>(`SELECT * FROM mcp_toolsets ORDER BY ${asciiLower("name")}, slug COLLATE "C"`);
  return toolsetsWithMembers(ctx.pool, toolsetRows);
}

export async function getMcpToolset(ctx: PgContext, ...[id]: Parameters<Store["getMcpToolset"]>): ReturnType<Store["getMcpToolset"]> {
  return getMcpToolsetOn(ctx.pool, id);
}

export async function getMcpToolsetBySlug(ctx: PgContext, ...[slug]: Parameters<Store["getMcpToolsetBySlug"]>): ReturnType<Store["getMcpToolsetBySlug"]> {
  const row = await ctx.queryOne<Row>(`SELECT * FROM mcp_toolsets WHERE slug = $1`, [slug]);
  return row ? (await toolsetsWithMembers(ctx.pool, [row]))[0]! : null;
}

export async function createMcpToolset(ctx: PgContext, ...[input]: Parameters<Store["createMcpToolset"]>): ReturnType<Store["createMcpToolset"]> {
  const now = new Date().toISOString();
  return ctx.withTransaction(async (client) => {
    await client.query(
      `INSERT INTO mcp_toolsets (id, slug, name, description, project_id, enabled, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [input.id, input.slug, input.name, input.description, input.projectId, input.enabled ? 1 : 0, input.createdBy, now, now]
    );
    await writeMcpToolsetMembers(client, input.id, input.members);
    return (await getMcpToolsetOn(client, input.id))!;
  });
}

export async function updateMcpToolset(ctx: PgContext, ...[id, patch]: Parameters<Store["updateMcpToolset"]>): ReturnType<Store["updateMcpToolset"]> {
  return ctx.withTransaction(async (client) => {
    const existing = await one(client, `SELECT id FROM mcp_toolsets WHERE id = $1 FOR UPDATE`, [id]);
    if (!existing) return null;
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
    await client.query(`UPDATE mcp_toolsets SET ${numbered(fields).join(", ")} WHERE id = $${params.length}`, params);
    if (patch.members !== undefined) {
      await writeMcpToolsetMembers(client, id, patch.members);
    }
    return getMcpToolsetOn(client, id);
  });
}

/** Deletes the toolset and its members, and drops it from every client's scope. */
export async function deleteMcpToolset(ctx: PgContext, ...[id]: Parameters<Store["deleteMcpToolset"]>): ReturnType<Store["deleteMcpToolset"]> {
  return ctx.withTransaction(async (client) => {
    const existing = await one(client, `SELECT id FROM mcp_toolsets WHERE id = $1 FOR UPDATE`, [id]);
    if (!existing) return false;
    await client.query(`DELETE FROM mcp_toolset_members WHERE toolset_id = $1`, [id]);
    await client.query(`DELETE FROM mcp_toolsets WHERE id = $1`, [id]);
    const clients = await rows(client, `SELECT * FROM mcp_clients FOR UPDATE`);
    for (const row of clients) {
      const record = mapMcpClient(row);
      if (!record.toolsetIds.includes(id)) continue;
      await client.query(`UPDATE mcp_clients SET toolset_ids_json = $1 WHERE id = $2`, [
        JSON.stringify(record.toolsetIds.filter((entry) => entry !== id)),
        record.id
      ]);
    }
    return true;
  });
}

async function getMcpClientOn(db: Queryable, id: string): Promise<McpClient | null> {
  const row = await one(db, `SELECT * FROM mcp_clients WHERE id = $1`, [id]);
  return row ? withoutHash(mapMcpClient(row)) : null;
}

export async function createMcpClient(ctx: PgContext, ...[input]: Parameters<Store["createMcpClient"]>): ReturnType<Store["createMcpClient"]> {
  const row = await ctx.queryOne<Row>(
    `INSERT INTO mcp_clients (
       id, name, token_prefix, token_hash, toolset_ids_json, role, created_by, created_by_email, expires_at, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      input.id,
      input.name,
      input.tokenPrefix,
      input.tokenHash,
      JSON.stringify(input.toolsetIds),
      input.role,
      input.createdBy,
      input.createdByEmail,
      tsOrNull(input.expiresAt),
      new Date().toISOString()
    ]
  );
  return withoutHash(mapMcpClient(row!));
}

/** Without the token hash. */
export async function getMcpClient(ctx: PgContext, ...[id]: Parameters<Store["getMcpClient"]>): ReturnType<Store["getMcpClient"]> {
  return getMcpClientOn(ctx.pool, id);
}

/** With the token hash; for the credential check only. */
export async function findMcpClientByTokenPrefix(ctx: PgContext, ...[prefix]: Parameters<Store["findMcpClientByTokenPrefix"]>): ReturnType<Store["findMcpClientByTokenPrefix"]> {
  const row = await ctx.queryOne<Row>(`SELECT * FROM mcp_clients WHERE token_prefix = $1`, [prefix]);
  return row ? mapMcpClient(row) : null;
}

export async function listMcpClients(ctx: PgContext, ..._args: Parameters<Store["listMcpClients"]>): ReturnType<Store["listMcpClients"]> {
  const result = await ctx.query<Row>(`SELECT * FROM mcp_clients ORDER BY created_at DESC, ${INSERTION_DESC}`);
  return result.map((row) => withoutHash(mapMcpClient(row)));
}

export async function revokeMcpClient(ctx: PgContext, ...[id]: Parameters<Store["revokeMcpClient"]>): ReturnType<Store["revokeMcpClient"]> {
  await ctx.execute(`UPDATE mcp_clients SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL`, [new Date().toISOString(), id]);
  return getMcpClientOn(ctx.pool, id);
}

export async function touchMcpClient(ctx: PgContext, ...[id, at]: Parameters<Store["touchMcpClient"]>): ReturnType<Store["touchMcpClient"]> {
  await ctx.execute(`UPDATE mcp_clients SET last_used_at = $1 WHERE id = $2`, [at, id]);
}
