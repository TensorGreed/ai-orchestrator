/**
 * 13.3 — data retention: the classes the retention service purges, in the order one purge takes them, and the admin
 * view of `GET /api/admin/retention`. Every class keeps its data until a setting gives it a number of days.
 */

/** The purge classes, in the order one purge runs them. */
export const RETENTION_PURGE_CLASSES = [
  "runs",
  "tool_calls",
  "rule_events",
  "cassettes_approvals",
  "queue",
  "agent_memory",
  "usage",
  "gateway_requests",
  "eval_runs",
  "captures",
  "simulations"
] as const;

export type RetentionPurgeClass = (typeof RETENTION_PURGE_CLASSES)[number];

/** What each class deletes, for the admin page and the docs. */
export const RETENTION_PURGE_CLASS_LABELS: Record<RetentionPurgeClass, { label: string; what: string }> = {
  runs: { label: "Runs", what: "Run history: inputs, outputs and traces" },
  tool_calls: { label: "Tool calls", what: "MCP tool-call telemetry: argument summaries and errors" },
  rule_events: { label: "Rule events", what: "Content rules events with their masked evidence" },
  cassettes_approvals: { label: "Cassettes and approvals", what: "Recorded MCP cassettes, decided approvals and gateway approvals" },
  queue: { label: "Queue", what: "Finished queue jobs and dead letters" },
  agent_memory: { label: "Agent memory", what: "Simple Memory sessions, agent artifacts and the session tool cache" },
  usage: { label: "Usage", what: "Usage and cost events" },
  gateway_requests: { label: "AI gateway requests", what: "Metadata of /v1 requests" },
  eval_runs: { label: "Eval runs", what: "Finished eval runs and replay jobs; the newest run of every set stays" },
  captures: { label: "Captured runs", what: "Captured runs nobody promoted; golden runs stay" },
  simulations: { label: "Rule simulations", what: "Content rules simulations" }
};

/** How a purge ended: everything due was deleted (`ok`), some steps failed (`partial`), or nothing could run (`error`). */
export type RetentionRunOutcome = "ok" | "partial" | "error";

/** Why a purge ran: at start-up, on the interval, after a finished run, or asked for. */
export type RetentionRunReason = "startup" | "interval" | "write" | "manual";

/** One purge, as `retention_runs` records it. Counts only: never row contents. */
export interface RetentionRunView {
  id: string;
  startedAt: string;
  finishedAt: string;
  instanceId: string;
  reason: RetentionRunReason;
  outcome: RetentionRunOutcome;
  /** Rows deleted per class (classes that deleted nothing are left out). */
  counts: Partial<Record<RetentionPurgeClass, number>>;
  /** Classes that hit the per-purge row cap and still have rows due. */
  capped: RetentionPurgeClass[];
  error: string | null;
}

export interface RetentionClassView {
  class: RetentionPurgeClass;
  label: string;
  what: string;
  /** The environment variable (or constant) the deployment value comes from. */
  setting: string;
  /** Days kept; 0 = kept forever. */
  days: number;
  /** Rows older than this are due; null when the class is kept forever. */
  cutoff: string | null;
  /** Rows due now, counted up to `backlogCap`; null when kept forever or not counted. */
  backlog: number | null;
  backlogCapped: boolean;
}

/** `GET /api/admin/retention` (admin): the deployment values, the last purges and the backlog. Read-only. */
export interface RetentionAdminView {
  intervalMs: number;
  maxRowsPerTick: number;
  bounds: { minDays: number; maxDays: number | null };
  backlogCap: number;
  classes: RetentionClassView[];
  lastRun: RetentionRunView | null;
  /** When the next interval purge is due, from the last recorded one; null before the first. */
  nextRunAt: string | null;
  runs: RetentionRunView[];
}
