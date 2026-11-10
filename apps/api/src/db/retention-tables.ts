/**
 * 13.3 — the tables the retention service prunes by age, with the timestamp each is aged by and the rows that never
 * age out. Both stores build their batched deletes from this one list, so they cannot drift apart.
 *
 * `filter` is trusted SQL that holds on both dialects. `key` is how a batch names its rows: `id` where the table has
 * one; `row` for the two agent-memory tables keyed by several columns (SQLite rowid, Postgres ctid).
 */
import {
  RETENTION_PURGE_CLASSES,
  type RetentionPurgeClass,
  type RetentionRunOutcome,
  type RetentionRunReason,
  type RetentionRunView
} from "@ai-orchestrator/shared";

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
 * Which rows one prune call may delete: those aged before `before`, at most `limit` of them. Per-project scopes
 * (a project's own cutoff, or every project but those with their own) extend this type.
 */
export interface RetentionScope {
  before: string;
  limit: number;
}

/** Rows one batch deletes at most; the store yields between batches. */
export const RETENTION_BATCH_ROWS = 1000;

/** The WHERE clause for `table`'s due rows, with `cutoff` (`?` or `$1`) standing for the cutoff. */
export function retentionWhere(table: RetentionTable, cutoff: "?" | "$1"): string {
  const spec: RetentionTableSpec = RETENTION_TABLES[table];
  return spec.filter ? `${spec.time} < ${cutoff} AND ${spec.filter}` : `${spec.time} < ${cutoff}`;
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
