/**
 * 13.3 — the tables the retention service prunes by age, with the timestamp each is aged by and the rows that never
 * age out. Both stores build their batched deletes from this one list, so they cannot drift apart.
 *
 * `filter` is trusted SQL that holds on both dialects. `key` is how a batch names its rows: `id` where the table has
 * one; `row` for the two agent-memory tables keyed by several columns (SQLite rowid, Postgres ctid).
 */
import {
  RETENTION_DATA_CLASSES,
  RETENTION_PURGE_CLASSES,
  type RetentionDataClass,
  type RetentionPolicyRecord,
  type RetentionPurgeClass,
  type RetentionRunOutcome,
  type RetentionRunReason,
  type RetentionRunView
} from "@ai-orchestrator/shared";
import { isHoldableTable, notHeldSql } from "./legal-hold-sql.js";

export interface RetentionTableSpec {
  /** The column a row is aged by. */
  time: string;
  /** Rows that stay whatever their age (trusted SQL). */
  filter?: string;
  key: "id" | "row";
}

export const RETENTION_TABLES = {
  execution_history: { time: "started_at", key: "id" },
  mcp_tool_calls: { time: "started_at", key: "id" },
  guard_events: { time: "created_at", key: "id" },
  // Pending approvals stay with their paused run.
  approval_requests: { time: "created_at", filter: "status <> 'pending'", key: "id" },
  mcp_cassettes: { time: "created_at", key: "id" },
  mcp_gateway_approvals: { time: "requested_at", key: "id" },
  // Only finished jobs: their payload (a dispatched run's spec, with its input) never outlives the history.
  execution_queue: { time: "updated_at", filter: "(status = 'completed' OR status = 'dead')", key: "id" },
  execution_queue_dlq: { time: "failed_at", key: "id" },
  session_memory: { time: "updated_at", key: "row" },
  session_artifacts: { time: "updated_at", key: "row" },
  session_tool_cache: { time: "created_at", key: "id" },
  usage_events: { time: "created_at", key: "id" },
  ai_gateway_requests: { time: "created_at", key: "id" },
  retention_runs: { time: "started_at", key: "id" }
} as const satisfies Record<string, RetentionTableSpec>;

export type RetentionTable = keyof typeof RETENTION_TABLES;

/**
 * Which rows one prune call may delete: those aged before `before`, at most `limit` of them. Per-project retention
 * narrows it to one project's rows (`projectId`), or to every row but those of the listed projects
 * (`excludeProjects`, rows of no project included); only tables in RETENTION_PROJECT_KEYS accept either.
 */
export interface RetentionScope {
  before: string;
  limit: number;
  projectId?: string;
  excludeProjects?: readonly string[];
  /**
   * Agent memory only: older session keys (written before keys carried the project) by exact value. With `projectId`,
   * the keys only that project owns (they go with its rows); with `excludeProjects`, every key an excluded project
   * claims (they stay). Any other older key belongs to no project. The service builds both lists from the workflows'
   * own default namespaces, `<workflowId>:<nodeId>`, as run-scope.ts reads them.
   */
  legacyNamespaces?: readonly string[];
}

/** Rows one batch deletes at most; the store yields between batches. */
export const RETENTION_BATCH_ROWS = 1000;

/**
 * The WHERE clause for `table`'s due rows, with `cutoff` (`?` or `$1`) standing for the cutoff. Rows a legal hold
 * keeps are never due (legal-hold-sql.ts); every table but the purge log can be held.
 */
export function retentionWhere(table: RetentionTable, cutoff: "?" | "$1"): string {
  const spec: RetentionTableSpec = RETENTION_TABLES[table];
  const due = spec.filter ? `${spec.time} < ${cutoff} AND ${spec.filter}` : `${spec.time} < ${cutoff}`;
  return isHoldableTable(table) ? `${due} AND ${notHeldSql(table)}` : due;
}

export function isRetentionTable(value: string): value is RetentionTable {
  return Object.prototype.hasOwnProperty.call(RETENTION_TABLES, value);
}

/** Lets timers and requests run between two batches of a long purge. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A `retention_runs` row as either driver returns it. */
export interface RetentionRunRow {
  id: unknown;
  started_at: unknown;
  finished_at: unknown;
  instance_id: unknown;
  reason: unknown;
  outcome: unknown;
  counts_json: unknown;
  capped_json: unknown;
  error: unknown;
}

const RUN_REASONS: ReadonlySet<string> = new Set<RetentionRunReason>(["startup", "interval", "write", "manual"]);
const RUN_OUTCOMES: ReadonlySet<string> = new Set<RetentionRunOutcome>(["ok", "partial", "error"]);

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function timestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

export function retentionRunFromRow(row: RetentionRunRow): RetentionRunView {
  const counts: RetentionRunView["counts"] = {};
  const rawCounts = parseJson(row.counts_json);
  if (rawCounts && typeof rawCounts === "object" && !Array.isArray(rawCounts)) {
    for (const [key, value] of Object.entries(rawCounts as Record<string, unknown>)) {
      const n = Number(value);
      if ((RETENTION_PURGE_CLASSES as readonly string[]).includes(key) && Number.isFinite(n)) counts[key as RetentionPurgeClass] = n;
    }
  }
  const rawCapped = parseJson(row.capped_json);
  const capped = Array.isArray(rawCapped)
    ? rawCapped.filter((value): value is RetentionPurgeClass => (RETENTION_PURGE_CLASSES as readonly string[]).includes(String(value)))
    : [];
  const reason = String(row.reason);
  const outcome = String(row.outcome);
  return {
    id: String(row.id),
    startedAt: timestamp(row.started_at),
    finishedAt: timestamp(row.finished_at),
    instanceId: String(row.instance_id),
    reason: (RUN_REASONS.has(reason) ? reason : "interval") as RetentionRunReason,
    outcome: (RUN_OUTCOMES.has(outcome) ? outcome : "error") as RetentionRunOutcome,
    counts,
    capped,
    error: row.error === null || row.error === undefined ? null : String(row.error)
  };
}

/**
 * 13.3 R1 — how a retention table's rows belong to a project:
 * - `project_id`: the row's own column (rows without one belong to no project and follow the deployment);
 * - `workflow`: the project of the row's workflow, now (a workflow moved to another project takes its rows along);
 * - `workflow_or_project`: the project of the row's workflow while it exists, else the row's own `project_id`, so
 *   cassettes and decided approvals go with the runs they belong to (a moved workflow takes them along too);
 * - `namespace`: agent memory, by session key. Keys written since sessions were scoped start with the project
 *   (`project:<length>:<id>:`, run-scope.ts); older keys follow `RetentionScope.legacyNamespaces`.
 */
export const RETENTION_PROJECT_KEYS: Partial<Record<RetentionTable, "project_id" | "workflow" | "workflow_or_project" | "namespace">> = {
  execution_history: "workflow",
  mcp_tool_calls: "project_id",
  guard_events: "project_id",
  approval_requests: "workflow_or_project",
  mcp_cassettes: "workflow_or_project",
  mcp_gateway_approvals: "project_id",
  execution_queue: "workflow",
  execution_queue_dlq: "workflow",
  session_memory: "namespace",
  session_artifacts: "namespace",
  session_tool_cache: "namespace"
};

/** A `retention_policies` row as either driver returns it. */
export interface RetentionPolicyRow {
  scope_type: unknown;
  scope_id: unknown;
  data_class: unknown;
  days: unknown;
  updated_by: unknown;
  updated_at: unknown;
}

/** A stored per-project value; null for a row of another scope or an unknown class (never applied). */
export function retentionPolicyFromRow(row: RetentionPolicyRow): RetentionPolicyRecord | null {
  const dataClass = String(row.data_class);
  const days = Number(row.days);
  if (String(row.scope_type) !== "project" || !(RETENTION_DATA_CLASSES as readonly string[]).includes(dataClass) || !Number.isFinite(days)) return null;
  return {
    scopeType: "project",
    scopeId: String(row.scope_id),
    dataClass: dataClass as RetentionDataClass,
    days: Math.max(0, Math.floor(days)),
    updatedBy: row.updated_by === null || row.updated_by === undefined ? null : String(row.updated_by),
    updatedAt: timestamp(row.updated_at)
  };
}

/** The session-key prefix of a project's agent memory (run-scope.ts `projectSessionNamespace`). */
export function projectNamespacePrefix(projectId: string): string {
  return `project:${projectId.length}:${projectId}:`;
}

export type RetentionDialect = "sqlite" | "postgres";

/**
 * The WHERE clause for the rows of `table` that `scope` names (their age, the table's never-aged filter and, when the
 * scope has one, the project condition), with its parameters. SQLite binds `?` in order; Postgres numbers from `$1`.
 * A project condition on a table no project owns throws.
 */
export function retentionScopeWhere(
  table: RetentionTable,
  scope: Pick<RetentionScope, "before" | "projectId" | "excludeProjects" | "legacyNamespaces">,
  dialect: RetentionDialect
): { sql: string; params: unknown[] } {
  const params: unknown[] = [scope.before];
  const clauses = [retentionWhere(table, dialect === "sqlite" ? "?" : "$1")];
  const bind = (value: unknown): string => {
    params.push(value);
    return dialect === "sqlite" ? "?" : `$${params.length}`;
  };
  // A list is one parameter: JSON text on SQLite (json_each), text[] on Postgres.
  const inList = (values: readonly string[]): string =>
    dialect === "sqlite" ? `IN (SELECT value FROM json_each(${bind(JSON.stringify(values))}))` : `= ANY(${bind([...values])}::text[])`;
  const startsWithAny = (column: string, prefixes: readonly string[]): string =>
    dialect === "sqlite"
      ? `EXISTS (SELECT 1 FROM json_each(${bind(JSON.stringify(prefixes))}) WHERE substr(${column}, 1, length(value)) = value)`
      : `EXISTS (SELECT 1 FROM unnest(${bind([...prefixes])}::text[]) AS p(prefix) WHERE substr(${column}, 1, length(p.prefix)) = p.prefix)`;
  // The row's project by its workflow while the workflow exists, else by its own column; columns are qualified with the
  // table, since workflows has a project_id of its own.
  const viaWorkflow = (projectMatch: string): string =>
    `EXISTS (SELECT 1 FROM workflows w WHERE w.id = ${table}.workflow_id AND w.project_id ${projectMatch})`;
  const viaOwnColumn = (projectMatch: string): string =>
    `(${table}.project_id IS NOT NULL AND ${table}.project_id ${projectMatch} AND NOT EXISTS (SELECT 1 FROM workflows w WHERE w.id = ${table}.workflow_id))`;
  const legacy = scope.legacyNamespaces ?? [];

  const excluded = scope.excludeProjects ?? [];
  if (scope.projectId === undefined && excluded.length === 0) return { sql: clauses[0], params };
  const key = RETENTION_PROJECT_KEYS[table];
  if (!key) throw new Error(`Rows of ${table} belong to no project`);
  if (scope.projectId !== undefined) {
    const projectId = scope.projectId;
    if (key === "project_id") clauses.push(`project_id = ${bind(projectId)}`);
    else if (key === "workflow") clauses.push(`workflow_id IN (SELECT id FROM workflows WHERE project_id = ${bind(projectId)})`);
    else if (key === "workflow_or_project") clauses.push(`(${viaWorkflow(`= ${bind(projectId)}`)} OR ${viaOwnColumn(`= ${bind(projectId)}`)})`);
    else {
      const own = startsWithAny("namespace", [projectNamespacePrefix(projectId)]);
      clauses.push(legacy.length > 0 ? `(${own} OR namespace ${inList(legacy)})` : own);
    }
  }
  if (excluded.length > 0) {
    if (key === "project_id") clauses.push(`(project_id IS NULL OR NOT (project_id ${inList(excluded)}))`);
    else if (key === "workflow") clauses.push(`workflow_id NOT IN (SELECT id FROM workflows WHERE project_id ${inList(excluded)})`);
    else if (key === "workflow_or_project") clauses.push(`NOT ${viaWorkflow(inList(excluded))} AND NOT ${viaOwnColumn(inList(excluded))}`);
    else {
      clauses.push(`NOT ${startsWithAny("namespace", excluded.map(projectNamespacePrefix))}`);
      if (legacy.length > 0) clauses.push(`NOT (namespace ${inList(legacy)})`);
    }
  }
  return { sql: clauses.join(" AND "), params };
}

/**
 * 13.3 R1 — the eval runs that back a workflow's current or previous published version, which the eval-run purge keeps
 * whatever their age: the replay runs named by each workflow's two latest releases, and by the release of the version
 * it publishes now. Holds on both dialects.
 */
export const RELEASE_EVIDENCE_RUN_IDS_SQL = `
  SELECT replay_run_id FROM (
    SELECT replay_run_id, ROW_NUMBER() OVER (PARTITION BY workflow_id ORDER BY published_at DESC, id DESC) AS position
    FROM workflow_releases WHERE replay_run_id IS NOT NULL
  ) ranked WHERE position <= 2
  UNION
  SELECT r.replay_run_id FROM workflow_releases r JOIN workflows w ON w.id = r.workflow_id AND w.published_version = r.version
  WHERE r.replay_run_id IS NOT NULL`;
