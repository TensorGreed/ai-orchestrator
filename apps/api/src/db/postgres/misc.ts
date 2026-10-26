/**
 * Phase 13.1 — PostgresStore: Store lifecycle, git sync, leases, variables, usage and budgets, notification configs.
 * Plain functions over a PgContext; PostgresStore delegates here. Methods that are not implemented yet throw
 * StoreNotImplementedError and are listed in UNIMPLEMENTED_METHODS (remove both together when implementing one).
 */
import { type Store } from "../store.js";
import type { BudgetRecord } from "../database.js";
import { toNum, toStr } from "./helpers.js";
import type { PgContext } from "./context.js";
import { clampLimit, LIMIT_MAX } from "../store-limits.js";

export const UNIMPLEMENTED_METHODS: readonly (keyof Store)[] = [];

export async function listNotificationConfigs(ctx: PgContext): Promise<Array<{
  id: string; channel: string; enabled: boolean;
  config: Record<string, unknown>; events: string[];
  createdAt: string; updatedAt: string;
}>> {
  const rows = await ctx.query<{
    id: string; channel: string; enabled: number;
    config_json: string; events: string;
    created_at: string; updated_at: string;
  }>(`SELECT id, channel, enabled, config_json, events, created_at, updated_at FROM notification_configs ORDER BY created_at`);
  return rows.map(r => ({
    id: toStr(r.id),
    channel: toStr(r.channel),
    enabled: toNum(r.enabled) === 1,
    config: JSON.parse(toStr(r.config_json) || "{}"),
    events: JSON.parse(toStr(r.events) || '["execution.failure"]'),
    createdAt: toStr(r.created_at),
    updatedAt: toStr(r.updated_at)
  }));
}

export async function upsertNotificationConfig(ctx: PgContext, input: {
  id: string; channel: string; enabled: boolean;
  config: Record<string, unknown>; events: string[];
}): Promise<void> {
  const now = new Date().toISOString();
  await ctx.execute(
    `INSERT INTO notification_configs (id, channel, enabled, config_json, events, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT(id) DO UPDATE SET channel=EXCLUDED.channel, enabled=EXCLUDED.enabled,
         config_json=EXCLUDED.config_json, events=EXCLUDED.events, updated_at=EXCLUDED.updated_at`,
    [input.id, input.channel, input.enabled ? 1 : 0,
     JSON.stringify(input.config), JSON.stringify(input.events), now, now]
  );
}

export async function deleteNotificationConfig(ctx: PgContext, id: string): Promise<boolean> {
  const result = await ctx.pool.query(`DELETE FROM notification_configs WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Store lifecycle
// ---------------------------------------------------------------------------

/**
 * Where the database lives, as `postgres://<host>:<port>/<database>?schema=<schema>` (never the user or password).
 * The sandbox launchers hash it into their instance label, so it names one deployment: every instance on the same
 * database and schema reports the same value.
 */
export async function storageLocation(ctx: PgContext): Promise<string> {
  const row = await ctx.queryOne<{ database: string; schema: string | null }>(
    `SELECT current_database() AS database, current_schema() AS schema`
  );
  const options = ctx.pool.options as { host?: string; port?: number };
  const host = options.host ?? "localhost";
  const port = options.port ?? 5432;
  const schema = row?.schema ?? "public";
  return `postgres://${host}:${port}/${toStr(row?.database)}?schema=${encodeURIComponent(schema)}`;
}

export async function getSchemaMarker(ctx: PgContext, name: string): Promise<string | null> {
  const row = await ctx.queryOne<{ created_at: string }>(`SELECT created_at FROM schema_markers WHERE name = $1`, [name]);
  return row ? toStr(row.created_at) : null;
}

// ---------------------------------------------------------------------------
// Git config (singleton row keyed by literal 'default')
// ---------------------------------------------------------------------------

type GitConfig = NonNullable<Awaited<ReturnType<Store["getGitConfig"]>>>;

export async function getGitConfig(ctx: PgContext): Promise<GitConfig | null> {
  const row = await ctx.queryOne<{
    id: string; repo_url: string; default_branch: string; auth_secret_id: string | null;
    workflows_dir: string; variables_file: string; user_name: string; user_email: string;
    enabled: number; last_push_at: string | null; last_pull_at: string | null; last_error: string | null;
    updated_at: string;
  }>(`SELECT id, repo_url, default_branch, auth_secret_id, workflows_dir, variables_file,
        user_name, user_email, enabled, last_push_at, last_pull_at, last_error, updated_at
        FROM git_configs WHERE id = 'default'`);
  if (!row) return null;
  return {
    id: toStr(row.id),
    repoUrl: toStr(row.repo_url),
    defaultBranch: toStr(row.default_branch),
    authSecretId: row.auth_secret_id ? toStr(row.auth_secret_id) : null,
    workflowsDir: toStr(row.workflows_dir),
    variablesFile: toStr(row.variables_file),
    userName: toStr(row.user_name),
    userEmail: toStr(row.user_email),
    enabled: toNum(row.enabled) === 1,
    lastPushAt: row.last_push_at ? toStr(row.last_push_at) : null,
    lastPullAt: row.last_pull_at ? toStr(row.last_pull_at) : null,
    lastError: row.last_error ? toStr(row.last_error) : null,
    updatedAt: toStr(row.updated_at)
  };
}

export async function upsertGitConfig(ctx: PgContext, input: Parameters<Store["upsertGitConfig"]>[0]): Promise<void> {
  const now = new Date().toISOString();
  await ctx.execute(
    `INSERT INTO git_configs (id, repo_url, default_branch, auth_secret_id, workflows_dir, variables_file,
        user_name, user_email, enabled, updated_at)
     VALUES ('default', $1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET
       repo_url = EXCLUDED.repo_url,
       default_branch = EXCLUDED.default_branch,
       auth_secret_id = EXCLUDED.auth_secret_id,
       workflows_dir = EXCLUDED.workflows_dir,
       variables_file = EXCLUDED.variables_file,
       user_name = EXCLUDED.user_name,
       user_email = EXCLUDED.user_email,
       enabled = EXCLUDED.enabled,
       updated_at = EXCLUDED.updated_at`,
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
}

export async function deleteGitConfig(ctx: PgContext): Promise<boolean> {
  const result = await ctx.pool.query(`DELETE FROM git_configs WHERE id = 'default'`);
  return (result.rowCount ?? 0) > 0;
}

export async function recordGitSync(ctx: PgContext, input: { kind: "push" | "pull"; error?: string | null }): Promise<void> {
  const now = new Date().toISOString();
  const column = input.kind === "push" ? "last_push_at" : "last_pull_at";
  await ctx.execute(
    `UPDATE git_configs SET ${column} = $1, last_error = $2, updated_at = $1 WHERE id = 'default'`,
    [now, input.error ?? null]
  );
}

// ---------------------------------------------------------------------------
// Leader leases
// ---------------------------------------------------------------------------

type LeaseRow = { lease_name: string; holder_id: string; expires_at: string; acquired_at: string; renewed_at: string };

function mapLease(row: LeaseRow) {
  return {
    leaseName: toStr(row.lease_name),
    holderId: toStr(row.holder_id),
    expiresAt: toStr(row.expires_at),
    acquiredAt: toStr(row.acquired_at),
    renewedAt: toStr(row.renewed_at)
  };
}

export async function getLease(ctx: PgContext, leaseName: string): ReturnType<Store["getLease"]> {
  const row = await ctx.queryOne<LeaseRow>(
    `SELECT lease_name, holder_id, expires_at, acquired_at, renewed_at FROM leader_leases WHERE lease_name = $1`,
    [leaseName]
  );
  return row ? mapLease(row) : null;
}

/**
 * One conditional upsert, so two instances racing for a lease can never both win: a missing lease is inserted, the
 * holder renews its own (keeping `acquired_at`), and an expired one is taken over; a live lease held by someone else
 * leaves the row untouched and returns no row. Leases are the cross-instance mechanism, so "now" and the expiry come
 * from the database clock (clock_timestamp(), to the millisecond), never from an instance's own clock: an instance
 * running ahead cannot take a live lease and one running behind cannot keep an expired one. (SQLite runs in one
 * process, so its clock is the process's.)
 */
export async function tryAcquireLease(ctx: PgContext, input: { leaseName: string; holderId: string; ttlMs: number }): Promise<boolean> {
  const result = await ctx.pool.query(
    `INSERT INTO leader_leases (lease_name, holder_id, expires_at, acquired_at, renewed_at)
     SELECT $1, $2, t.now + $3 * interval '1 millisecond', t.now, t.now
       FROM (SELECT date_trunc('milliseconds', clock_timestamp()) AS now) AS t
     ON CONFLICT (lease_name) DO UPDATE SET
       holder_id = EXCLUDED.holder_id,
       expires_at = EXCLUDED.expires_at,
       acquired_at = CASE WHEN leader_leases.holder_id = EXCLUDED.holder_id THEN leader_leases.acquired_at ELSE EXCLUDED.acquired_at END,
       renewed_at = EXCLUDED.renewed_at
     WHERE leader_leases.holder_id = EXCLUDED.holder_id OR leader_leases.expires_at <= EXCLUDED.renewed_at
     RETURNING lease_name`,
    [input.leaseName, input.holderId, Math.max(0, Math.floor(input.ttlMs))]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function releaseLease(ctx: PgContext, leaseName: string, holderId: string): Promise<boolean> {
  const result = await ctx.pool.query(`DELETE FROM leader_leases WHERE lease_name = $1 AND holder_id = $2`, [leaseName, holderId]);
  return (result.rowCount ?? 0) > 0;
}

export async function listLeases(ctx: PgContext): ReturnType<Store["listLeases"]> {
  const rows = await ctx.query<LeaseRow>(
    `SELECT lease_name, holder_id, expires_at, acquired_at, renewed_at FROM leader_leases ORDER BY lease_name COLLATE "C"`
  );
  return rows.map(mapLease);
}

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

type VariableRow = {
  id: string; project_id: string; key: string; value: string;
  created_by: string | null; created_at: string; updated_at: string;
};

function mapVariable(row: VariableRow) {
  return {
    id: toStr(row.id),
    projectId: toStr(row.project_id),
    key: toStr(row.key),
    value: toStr(row.value),
    createdBy: row.created_by ? toStr(row.created_by) : null,
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at)
  };
}

const VARIABLE_COLUMNS = `id, project_id, key, value, created_by, created_at, updated_at`;

export async function listVariables(ctx: PgContext, projectId?: string): ReturnType<Store["listVariables"]> {
  const rows = projectId
    ? await ctx.query<VariableRow>(`SELECT ${VARIABLE_COLUMNS} FROM variables WHERE project_id = $1 ORDER BY key COLLATE "C"`, [projectId])
    : await ctx.query<VariableRow>(`SELECT ${VARIABLE_COLUMNS} FROM variables ORDER BY project_id COLLATE "C", key COLLATE "C"`);
  return rows.map(mapVariable);
}

export async function getVariable(ctx: PgContext, id: string): ReturnType<Store["getVariable"]> {
  const row = await ctx.queryOne<VariableRow>(`SELECT ${VARIABLE_COLUMNS} FROM variables WHERE id = $1`, [id]);
  return row ? mapVariable(row) : null;
}

/** An existing id keeps its project, creator and creation time; key, value and updated_at change. */
export async function upsertVariable(ctx: PgContext, input: Parameters<Store["upsertVariable"]>[0]): Promise<void> {
  const now = new Date().toISOString();
  await ctx.execute(
    `INSERT INTO variables (id, project_id, key, value, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     ON CONFLICT (id) DO UPDATE SET
       key = EXCLUDED.key,
       value = EXCLUDED.value,
       updated_at = EXCLUDED.updated_at`,
    [input.id, input.projectId, input.key, input.value, input.createdBy ?? null, now]
  );
}

export async function deleteVariable(ctx: PgContext, id: string): Promise<boolean> {
  const result = await ctx.pool.query(`DELETE FROM variables WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function findVariableByKey(ctx: PgContext, projectId: string, key: string): ReturnType<Store["findVariableByKey"]> {
  const row = await ctx.queryOne<{ id: string; key: string; value: string }>(
    `SELECT id, key, value FROM variables WHERE project_id = $1 AND key = $2`,
    [projectId, key]
  );
  return row ? { id: toStr(row.id), key: toStr(row.key), value: toStr(row.value) } : null;
}

// ---------------------------------------------------------------------------
// Usage events (FinOps rollups)
// ---------------------------------------------------------------------------

export async function writeUsageEvent(ctx: PgContext, input: Parameters<Store["writeUsageEvent"]>[0]): Promise<void> {
  await ctx.execute(
    `INSERT INTO usage_events (
       id, execution_id, workflow_id, workflow_name, user_id, user_email,
       project_id, trigger_type, status, input_tokens, output_tokens,
       cached_input_tokens, total_tokens, cost_usd, llm_call_count,
       duration_ms, providers_json, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
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
}

/** `cost_usd` is double precision (v40), the same 8-byte float as SQLite's REAL, so sums match SQLite's. */
const AGGREGATES = `COUNT(*) AS execs,
  SUM(input_tokens) AS ti, SUM(output_tokens) AS "to",
  SUM(cached_input_tokens) AS ci, SUM(total_tokens) AS tt,
  SUM(cost_usd) AS cost, SUM(llm_call_count) AS calls,
  AVG(duration_ms) AS avgd`;

type AggregateRow = {
  execs: string | number; ti: string | number | null; to: string | number | null; ci: string | number | null;
  tt: string | number | null; cost: number | null; calls: string | number | null; avgd: string | number | null;
};

function mapAggregates(r: AggregateRow) {
  return {
    executions: toNum(r.execs),
    inputTokens: toNum(r.ti ?? 0),
    outputTokens: toNum(r.to ?? 0),
    cachedInputTokens: toNum(r.ci ?? 0),
    totalTokens: toNum(r.tt ?? 0),
    costUsd: Number(r.cost ?? 0),
    llmCallCount: toNum(r.calls ?? 0),
    avgDurationMs: Math.round(Number(r.avgd ?? 0))
  };
}

export async function queryUsageRollup(ctx: PgContext, input: Parameters<Store["queryUsageRollup"]>[0]): ReturnType<Store["queryUsageRollup"]> {
  const params: Array<string | number> = [input.from, input.to];
  const filters: string[] = ["created_at >= $1::timestamptz", "created_at < $2::timestamptz"];
  if (input.workflowId) { params.push(input.workflowId); filters.push(`workflow_id = $${params.length}`); }
  if (input.userId) { params.push(input.userId); filters.push(`user_id = $${params.length}`); }
  if (input.projectId) { params.push(input.projectId); filters.push(`project_id = $${params.length}`); }
  const where = `WHERE ${filters.join(" AND ")}`;
  const limit = clampLimit(input.limit, { fallback: 100, max: LIMIT_MAX.usageRollup });

  if (input.groupBy === "day" || input.groupBy === "hour") {
    // The same bucket strings SQLite's strftime gives, in UTC.
    const fmt = input.groupBy === "day" ? `'YYYY-MM-DD'` : `'YYYY-MM-DD"T"HH24":00:00"'`;
    const rows = await ctx.query<AggregateRow & { bucket: string }>(
      `SELECT to_char(created_at AT TIME ZONE 'UTC', ${fmt}) AS bucket, ${AGGREGATES}
       FROM usage_events ${where}
       GROUP BY bucket
       ORDER BY 1 ASC
       LIMIT ${limit}`,
      params
    );
    return rows.map((r) => ({ bucket: toStr(r.bucket), ...mapAggregates(r) }));
  }

  if (input.groupBy === "workflow") {
    const rows = await ctx.query<AggregateRow & { workflow_id: string; workflow_name: string | null }>(
      `SELECT workflow_id, MAX(workflow_name) AS workflow_name, ${AGGREGATES}
       FROM usage_events ${where}
       GROUP BY workflow_id
       ORDER BY cost DESC, tt DESC
       LIMIT ${limit}`,
      params
    );
    return rows.map((r) => ({
      bucket: toStr(r.workflow_id),
      workflowId: toStr(r.workflow_id),
      workflowName: r.workflow_name ? toStr(r.workflow_name) : null,
      ...mapAggregates(r)
    }));
  }

  if (input.groupBy === "user") {
    const rows = await ctx.query<AggregateRow & { user_id: string | null; user_email: string | null }>(
      `SELECT user_id, MAX(user_email) AS user_email, ${AGGREGATES}
       FROM usage_events ${where}
       GROUP BY user_id
       ORDER BY cost DESC, tt DESC
       LIMIT ${limit}`,
      params
    );
    return rows.map((r) => ({
      bucket: r.user_id ? toStr(r.user_id) : "(anonymous)",
      userId: r.user_id ? toStr(r.user_id) : null,
      userEmail: r.user_email ? toStr(r.user_email) : null,
      ...mapAggregates(r)
    }));
  }

  if (input.groupBy === "project") {
    const rows = await ctx.query<AggregateRow & { project_id: string | null }>(
      `SELECT project_id, ${AGGREGATES}
       FROM usage_events ${where}
       GROUP BY project_id
       ORDER BY cost DESC, tt DESC
       LIMIT ${limit}`,
      params
    );
    return rows.map((r) => ({
      bucket: r.project_id ? toStr(r.project_id) : "(none)",
      projectId: r.project_id ? toStr(r.project_id) : null,
      ...mapAggregates(r)
    }));
  }

  // groupBy === "provider": providers_json is per execution, so it is unfolded here, as the SQLite store does.
  const rows = await ctx.query<{
    providers_json: string | null; ti: number; to: number; ci: number; tt: number;
    cost: number; calls: number; duration: number;
  }>(
    `SELECT providers_json, input_tokens AS ti, output_tokens AS "to",
            cached_input_tokens AS ci, total_tokens AS tt,
            cost_usd AS cost, llm_call_count AS calls, duration_ms AS duration
     FROM usage_events ${where}
     ORDER BY created_at ASC, id COLLATE "C" ASC`,
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
      ? (JSON.parse(toStr(r.providers_json)) as Array<{ providerId: string; model: string; calls: number }>)
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
      cur.inputTokens += Math.round(toNum(r.ti ?? 0) * share);
      cur.outputTokens += Math.round(toNum(r.to ?? 0) * share);
      cur.cachedInputTokens += Math.round(toNum(r.ci ?? 0) * share);
      cur.totalTokens += Math.round(toNum(r.tt ?? 0) * share);
      cur.costUsd += Number(r.cost ?? 0) * share;
      cur.llmCallCount += p.calls || 0;
      cur.totalDurationMs += Math.round(toNum(r.duration ?? 0) * share);
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

export async function queryUsageTotals(ctx: PgContext, input: Parameters<Store["queryUsageTotals"]>[0]): ReturnType<Store["queryUsageTotals"]> {
  const params: Array<string | number> = [input.from, input.to];
  const filters: string[] = ["created_at >= $1::timestamptz", "created_at < $2::timestamptz"];
  if (input.workflowId) { params.push(input.workflowId); filters.push(`workflow_id = $${params.length}`); }
  if (input.userId) { params.push(input.userId); filters.push(`user_id = $${params.length}`); }
  if (input.userKey) { params.push(input.userKey); filters.push(`(user_id = $${params.length} OR user_email = $${params.length})`); }
  if (input.projectId) { params.push(input.projectId); filters.push(`project_id = $${params.length}`); }
  const row = await ctx.queryOne<AggregateRow>(`SELECT ${AGGREGATES} FROM usage_events WHERE ${filters.join(" AND ")}`, params);
  return mapAggregates(row ?? { execs: 0, ti: 0, to: 0, ci: 0, tt: 0, cost: 0, calls: 0, avgd: 0 });
}

export async function listUsageEvents(ctx: PgContext, input: Parameters<Store["listUsageEvents"]>[0] = {}): ReturnType<Store["listUsageEvents"]> {
  const params: Array<string | number> = [];
  const filters: string[] = [];
  if (input.workflowId) { params.push(input.workflowId); filters.push(`workflow_id = $${params.length}`); }
  if (input.userId) { params.push(input.userId); filters.push(`user_id = $${params.length}`); }
  if (input.projectId) { params.push(input.projectId); filters.push(`project_id = $${params.length}`); }
  const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  const limit = clampLimit(input.limit, { fallback: 50, max: LIMIT_MAX.usageEvents });
  const rows = await ctx.query<{
    id: string; execution_id: string; workflow_id: string; workflow_name: string | null;
    user_id: string | null; user_email: string | null; project_id: string | null;
    trigger_type: string | null; status: string;
    input_tokens: number; output_tokens: number; cached_input_tokens: number;
    total_tokens: number; cost_usd: number; llm_call_count: number; duration_ms: number;
    providers_json: string | null; created_at: string;
  }>(`SELECT * FROM usage_events ${where} ORDER BY created_at DESC, id COLLATE "C" DESC LIMIT ${limit}`, params);
  return rows.map((r) => ({
    id: toStr(r.id),
    executionId: toStr(r.execution_id),
    workflowId: toStr(r.workflow_id),
    workflowName: r.workflow_name ? toStr(r.workflow_name) : null,
    userId: r.user_id ? toStr(r.user_id) : null,
    userEmail: r.user_email ? toStr(r.user_email) : null,
    projectId: r.project_id ? toStr(r.project_id) : null,
    triggerType: r.trigger_type ? toStr(r.trigger_type) : null,
    status: toStr(r.status),
    inputTokens: toNum(r.input_tokens),
    outputTokens: toNum(r.output_tokens),
    cachedInputTokens: toNum(r.cached_input_tokens),
    totalTokens: toNum(r.total_tokens),
    costUsd: Number(r.cost_usd),
    llmCallCount: toNum(r.llm_call_count),
    durationMs: toNum(r.duration_ms),
    providers: r.providers_json
      ? (JSON.parse(toStr(r.providers_json)) as Array<{ providerId: string; model: string; calls: number }>)
      : [],
    createdAt: toStr(r.created_at)
  }));
}

// ---------------------------------------------------------------------------
// Budgets and budget alerts
// ---------------------------------------------------------------------------

type BudgetRow = {
  id: string; name: string; scope_type: string; scope_id: string | null; period: string; limit_type: string;
  limit_value: number; warn_threshold_pct: number; action: string; notify_channel: string | null;
  enabled: number; created_by: string | null; created_at: string; updated_at: string;
};

function mapBudget(row: BudgetRow): BudgetRecord {
  return {
    id: toStr(row.id),
    name: toStr(row.name),
    scopeType: toStr(row.scope_type) as BudgetRecord["scopeType"],
    scopeId: row.scope_id ? toStr(row.scope_id) : null,
    period: toStr(row.period) as BudgetRecord["period"],
    limitType: toStr(row.limit_type) as BudgetRecord["limitType"],
    limitValue: Number(row.limit_value),
    warnThresholdPct: Number(row.warn_threshold_pct),
    action: toStr(row.action) as BudgetRecord["action"],
    notifyChannel: row.notify_channel ? toStr(row.notify_channel) : null,
    enabled: toNum(row.enabled) === 1,
    createdBy: row.created_by ? toStr(row.created_by) : null,
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at)
  };
}

export async function createBudget(ctx: PgContext, input: Parameters<Store["createBudget"]>[0]): Promise<void> {
  const now = new Date().toISOString();
  await ctx.execute(
    `INSERT INTO budgets (
       id, name, scope_type, scope_id, period, limit_type, limit_value,
       warn_threshold_pct, action, notify_channel, enabled, created_by,
       created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)`,
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
      now
    ]
  );
}

/** As on SQLite: true whenever the patch names a field, whether or not a budget has this id. */
export async function updateBudget(ctx: PgContext, id: string, patch: Parameters<Store["updateBudget"]>[1]): Promise<boolean> {
  const fields: string[] = [];
  const params: Array<string | number | null> = [];
  const set = (column: string, value: string | number | null) => {
    params.push(value);
    fields.push(`${column} = $${params.length}`);
  };
  if (patch.name !== undefined) set("name", patch.name);
  if (patch.limitValue !== undefined) set("limit_value", patch.limitValue);
  if (patch.warnThresholdPct !== undefined) set("warn_threshold_pct", patch.warnThresholdPct);
  if (patch.action !== undefined) set("action", patch.action);
  if (patch.notifyChannel !== undefined) set("notify_channel", patch.notifyChannel);
  if (patch.enabled !== undefined) set("enabled", patch.enabled ? 1 : 0);
  if (fields.length === 0) return false;
  set("updated_at", new Date().toISOString());
  params.push(id);
  await ctx.execute(`UPDATE budgets SET ${fields.join(", ")} WHERE id = $${params.length}`, params);
  return true;
}

/** Removes the budget and its alerts together; true, as on SQLite, whether or not it existed. */
export async function deleteBudget(ctx: PgContext, id: string): Promise<boolean> {
  await ctx.withTransaction(async (client) => {
    await client.query(`DELETE FROM budget_alerts WHERE budget_id = $1`, [id]);
    await client.query(`DELETE FROM budgets WHERE id = $1`, [id]);
  });
  return true;
}

export async function getBudget(ctx: PgContext, id: string): Promise<BudgetRecord | null> {
  const row = await ctx.queryOne<BudgetRow>(`SELECT * FROM budgets WHERE id = $1`, [id]);
  return row ? mapBudget(row) : null;
}

export async function listBudgets(ctx: PgContext, filter: Parameters<Store["listBudgets"]>[0] = {}): Promise<BudgetRecord[]> {
  const filters: string[] = [];
  const params: Array<string | number> = [];
  if (filter.enabledOnly) filters.push("enabled = 1");
  if (filter.scopeType) { params.push(filter.scopeType); filters.push(`scope_type = $${params.length}`); }
  if (filter.scopeId !== undefined) {
    if (filter.scopeId === "") {
      filters.push("(scope_id IS NULL OR scope_id = '')");
    } else {
      params.push(filter.scopeId);
      filters.push(`scope_id = $${params.length}`);
    }
  }
  const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  const rows = await ctx.query<BudgetRow>(`SELECT * FROM budgets ${where} ORDER BY scope_type COLLATE "C", name COLLATE "C"`, params);
  return rows.map(mapBudget);
}

/**
 * Records a budget alert at most once per (budget, period, severity). BudgetService checks getLatestBudgetAlert and
 * then calls this, and two API instances (or two runs in one) can both pass that check; here the budget's row is
 * locked for the transaction and the insert happens only when no alert for the window exists yet, so the second
 * caller records nothing and gets false, so BudgetService sends no second notification. A budget deleted meanwhile
 * has no row to lock, so nothing would serialise the inserts: that alert is not recorded either (false), which leaves
 * no orphan alert and sends no notification for a deleted budget. (The SQLite store inserts unconditionally; it runs
 * in one process.)
 */
export async function recordBudgetAlert(ctx: PgContext, input: Parameters<Store["recordBudgetAlert"]>[0]): Promise<boolean> {
  return ctx.withTransaction(async (client) => {
    const locked = await client.query(`SELECT id FROM budgets WHERE id = $1 FOR UPDATE`, [input.budgetId]);
    if ((locked.rowCount ?? 0) === 0) return false;
    const result = await client.query(
      `INSERT INTO budget_alerts (
         id, budget_id, period_start, severity, usage_value, limit_value,
         workflow_id, execution_id, message, fired_at
       )
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
       WHERE NOT EXISTS (
         SELECT 1 FROM budget_alerts WHERE budget_id = $2 AND period_start = $3 AND severity = $4
       )`,
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
    return (result.rowCount ?? 0) > 0;
  });
}

export async function getLatestBudgetAlert(ctx: PgContext, budgetId: string, periodStart: string, severity: "warn" | "block"): Promise<{ id: string; firedAt: string } | null> {
  const row = await ctx.queryOne<{ id: string; fired_at: string }>(
    `SELECT id, fired_at FROM budget_alerts
     WHERE budget_id = $1 AND period_start = $2 AND severity = $3
     ORDER BY fired_at DESC, id COLLATE "C" DESC LIMIT 1`,
    [budgetId, periodStart, severity]
  );
  return row ? { id: toStr(row.id), firedAt: toStr(row.fired_at) } : null;
}

export async function listBudgetAlerts(ctx: PgContext, filter: Parameters<Store["listBudgetAlerts"]>[0] = {}): ReturnType<Store["listBudgetAlerts"]> {
  const params: Array<string | number> = [];
  const filters: string[] = [];
  if (filter.budgetId) { params.push(filter.budgetId); filters.push(`budget_id = $${params.length}`); }
  const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  const limit = clampLimit(filter.limit, { fallback: 100, max: LIMIT_MAX.budgetAlerts });
  const rows = await ctx.query<{
    id: string; budget_id: string; period_start: string; severity: string; usage_value: number; limit_value: number;
    workflow_id: string | null; execution_id: string | null; message: string | null; fired_at: string;
  }>(`SELECT * FROM budget_alerts ${where} ORDER BY fired_at DESC, id COLLATE "C" DESC LIMIT ${limit}`, params);
  return rows.map((r) => ({
    id: toStr(r.id),
    budgetId: toStr(r.budget_id),
    periodStart: toStr(r.period_start),
    severity: toStr(r.severity),
    usageValue: Number(r.usage_value),
    limitValue: Number(r.limit_value),
    workflowId: r.workflow_id ? toStr(r.workflow_id) : null,
    executionId: r.execution_id ? toStr(r.execution_id) : null,
    message: r.message ? toStr(r.message) : null,
    firedAt: toStr(r.fired_at)
  }));
}
