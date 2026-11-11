/**
 * 13.3 — legal holds in the data layer: the one SQL predicate every purge and delete of holdable data carries, so a
 * held row is never deleted whichever path deletes it. Both stores build their statements from this module.
 *
 * A hold matches a row through its anchors:
 *   - a `project` hold: the row's project, the project of its workflow (or of its golden set), or an agent-memory
 *     namespace of the project (`<projectId>:…`, or a legacy `<workflowId>:…` of one of its workflows);
 *   - a `workflow` hold: the row's workflow, or an agent-memory namespace of the workflow (`<workflowId>:…` or
 *     `<projectId>:<workflowId>:…`);
 *   - an item (`legal_hold_items`, from a `runs` or `subject` hold): the run the row belongs to, or the row itself.
 * Only active holds count. With no hold placed, the predicate is an empty `NOT EXISTS` over a tiny table.
 *
 * Serialising a hold against a purge already under way: on Postgres, placing a hold takes the legal-hold advisory lock
 * exclusively for its transaction, and every purge batch and every delete that checks holds takes it shared first,
 * before any row lock. A batch that started before the hold committed finishes first; any later batch sees the hold.
 * On SQLite every statement runs to its end on one connection, so a hold is seen by the next statement.
 *
 * Everything here is trusted SQL over column names; values never go into it.
 */
import {
  legalHoldRefusalMessage,
  type LegalHoldItemKind,
  type LegalHoldItemView,
  type LegalHoldRef,
  type LegalHoldScopeType,
  type LegalHoldStatus,
  type LegalHoldView
} from "@ai-orchestrator/shared";

/**
 * Phase 13.3 advisory-lock class 0x4c3248 ("L2H"), key hashtext(current_schema()): shared by every purge batch and
 * hold-checked delete, exclusive while a hold is placed. See ADVISORY_LOCK_CLASS_* in postgres-store.ts.
 */
export const ADVISORY_LOCK_CLASS_LEGAL_HOLD = 0x4c3248;
export const LEGAL_HOLD_LOCK_SHARED_SQL = `SELECT pg_advisory_xact_lock_shared(${ADVISORY_LOCK_CLASS_LEGAL_HOLD}, hashtext(current_schema()))`;
export const LEGAL_HOLD_LOCK_EXCLUSIVE_SQL = `SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_CLASS_LEGAL_HOLD}, hashtext(current_schema()))`;

/** A delete refused because a legal hold keeps what it would remove (answered 409 `legal_hold`). */
export class LegalHoldError extends Error {
  readonly code = "legal_hold";
  constructor(
    readonly what: string,
    readonly holds: LegalHoldRef[],
    refused = "deleted"
  ) {
    super(legalHoldRefusalMessage(what, holds, refused));
    this.name = "LegalHoldError";
  }
}

/** How a row of a table names what a hold can cover: SQL expressions over `ref` (the table or its alias). */
interface HoldAnchors {
  projects?: string[];
  workflows?: string[];
  executions?: string[];
  namespace?: string;
  items?: Array<[LegalHoldItemKind, string]>;
  /** A further condition over the hold. */
  extra?: string;
}

/** Every table a hold can keep rows of. */
export const HOLDABLE_TABLES = [
  "execution_history",
  "workflow_executions",
  "mcp_tool_calls",
  "guard_events",
  "approval_requests",
  "mcp_cassettes",
  "mcp_gateway_approvals",
  "execution_queue",
  "execution_queue_dlq",
  "session_memory",
  "session_artifacts",
  "session_tool_cache",
  "usage_events",
  "ai_gateway_requests",
  "replay_recordings",
  "eval_datasets",
  "eval_fixtures",
  "eval_results",
  "eval_runs"
] as const;
export type HoldableTable = (typeof HOLDABLE_TABLES)[number];

type AnchorFn = (ref: string, lh: string) => HoldAnchors;

const ANCHORS: Record<HoldableTable, AnchorFn> = {
  execution_history: (r) => ({ workflows: [`${r}.workflow_id`], executions: [`${r}.id`] }),
  workflow_executions: (r) => ({ workflows: [`${r}.workflow_id`], executions: [`${r}.id`] }),
  mcp_tool_calls: (r) => ({ projects: [`${r}.project_id`], workflows: [`${r}.workflow_id`], executions: [`${r}.execution_id`] }),
  guard_events: (r) => ({ projects: [`${r}.project_id`], workflows: [`${r}.workflow_id`], executions: [`${r}.execution_id`] }),
  approval_requests: (r) => ({ projects: [`${r}.project_id`], workflows: [`${r}.workflow_id`], executions: [`${r}.execution_id`] }),
  mcp_cassettes: (r) => ({
    projects: [`${r}.project_id`],
    workflows: [`${r}.workflow_id`],
    executions: [`${r}.execution_id`],
    items: [["cassette", `${r}.id`]]
  }),
  mcp_gateway_approvals: (r) => ({ projects: [`${r}.project_id`] }),
  execution_queue: (r) => ({ workflows: [`${r}.workflow_id`], executions: [`${r}.execution_id`] }),
  execution_queue_dlq: (r) => ({ workflows: [`${r}.workflow_id`] }),
  session_memory: (r) => ({ namespace: `${r}.namespace` }),
  session_artifacts: (r) => ({ namespace: `${r}.namespace` }),
  session_tool_cache: (r) => ({ namespace: `${r}.namespace` }),
  usage_events: (r) => ({ projects: [`${r}.project_id`], workflows: [`${r}.workflow_id`], executions: [`${r}.execution_id`] }),
  ai_gateway_requests: (r) => ({ projects: [`${r}.project_id`] }),
  replay_recordings: (r, lh) => ({
    projects: [`${r}.project_id`],
    workflows: [`${r}.workflow_id`],
    executions: [`${r}.source_execution_id`],
    items: [["recording", `${r}.id`]],
    // A golden run whose golden-set case is held stays with it.
    extra: `EXISTS (SELECT 1 FROM eval_fixtures lhf WHERE lhf.recording_id = ${r}.id AND ${holdMatchSql("eval_fixtures", "lhf", lh)})`
  }),
  eval_datasets: (r) => ({ projects: [`${r}.project_id`], workflows: [`${r}.workflow_id`] }),
  eval_fixtures: (r) => ({
    projects: [`(SELECT lhd.project_id FROM eval_datasets lhd WHERE lhd.id = ${r}.dataset_id)`],
    workflows: [`(SELECT lhd.workflow_id FROM eval_datasets lhd WHERE lhd.id = ${r}.dataset_id)`],
    items: [
      ["fixture", `${r}.id`],
      ["recording", `${r}.recording_id`]
    ]
  }),
  eval_results: (r) => ({
    workflows: [`(SELECT lhr.workflow_id FROM eval_runs lhr WHERE lhr.id = ${r}.run_id)`],
    projects: [`(SELECT lhd.project_id FROM eval_runs lhr JOIN eval_datasets lhd ON lhd.id = lhr.dataset_id WHERE lhr.id = ${r}.run_id)`],
    executions: [`${r}.execution_id`],
    items: [
      ["eval_result", `${r}.id`],
      ["recording", `${r}.recording_id`],
      ["fixture", `${r}.fixture_id`]
    ]
  }),
  // An eval run or replay job goes whole or not at all: it is held when its workflow, project or any of its results is.
  eval_runs: (r, lh) => ({
    workflows: [`${r}.workflow_id`],
    projects: [`(SELECT lhd.project_id FROM eval_datasets lhd WHERE lhd.id = ${r}.dataset_id)`],
    extra:
      `EXISTS (SELECT 1 FROM eval_results lher JOIN legal_hold_items lhi ON lhi.hold_id = ${lh}.id WHERE lher.run_id = ${r}.id AND (` +
      `(lhi.kind = 'execution' AND lhi.row_id = lher.execution_id) OR (lhi.kind = 'eval_result' AND lhi.row_id = lher.id) OR ` +
      `(lhi.kind = 'recording' AND lhi.row_id = lher.recording_id) OR (lhi.kind = 'fixture' AND lhi.row_id = lher.fixture_id)))`
  })
};

export function isHoldableTable(value: string): value is HoldableTable {
  return Object.prototype.hasOwnProperty.call(ANCHORS, value);
}

/** The table each kind of item names (the data-subject lookup's stores). */
export const ITEM_KIND_TABLES: Record<LegalHoldItemKind, HoldableTable> = {
  execution: "execution_history",
  recording: "replay_recordings",
  fixture: "eval_fixtures",
  eval_result: "eval_results",
  cassette: "mcp_cassettes"
};

/** `ns` starts with `prefix` followed by a colon (no LIKE: ids may hold `_` or `%`). */
function hasPrefix(ns: string, prefix: string): string {
  return `substr(${ns}, 1, length(${prefix}) + 1) = ${prefix} || ':'`;
}

/** The condition under which hold `lh` (an alias of legal_holds) covers the row `ref` of `table`. */
export function holdMatchSql(table: HoldableTable, ref: string, lh = "lh"): string {
  const anchors: HoldAnchors = ANCHORS[table](ref, lh);
  const extra = anchors.extra;
  const parts: string[] = [];
  const projectExprs = [...(anchors.projects ?? []), ...(anchors.workflows ?? []).map((w) => `(SELECT lhw.project_id FROM workflows lhw WHERE lhw.id = ${w})`)];
  if (projectExprs.length > 0) parts.push(`(${lh}.scope_type = 'project' AND ${lh}.scope_id IN (${projectExprs.join(", ")}))`);
  if (anchors.workflows?.length) parts.push(`(${lh}.scope_type = 'workflow' AND ${lh}.scope_id IN (${anchors.workflows.join(", ")}))`);
  if (anchors.namespace) {
    const ns = anchors.namespace;
    // Session keys are `project:<length>:<projectId>:<namespace>` (run-scope.ts projectSessionNamespace), where the
    // namespace is by default `<workflowId>:<nodeId>`; older keys are that namespace alone.
    const projectKey = (projectId: string) => `('project:' || length(${projectId}) || ':' || ${projectId})`;
    parts.push(
      `(${lh}.scope_type = 'project' AND (${hasPrefix(ns, projectKey(`${lh}.scope_id`))} OR ${hasPrefix(ns, `${lh}.scope_id`)} OR EXISTS (SELECT 1 FROM workflows lhw WHERE lhw.project_id = ${lh}.scope_id AND ${hasPrefix(ns, "lhw.id")})))`,
      `(${lh}.scope_type = 'workflow' AND (${hasPrefix(ns, `${lh}.scope_id`)} OR EXISTS (SELECT 1 FROM workflows lhw WHERE lhw.id = ${lh}.scope_id AND (${hasPrefix(ns, `(${projectKey("lhw.project_id")} || ':' || lhw.id)`)} OR ${hasPrefix(ns, "lhw.project_id || ':' || lhw.id")}))))`
    );
  }
  const itemConditions = [
    ...(anchors.executions ?? []).map((e) => `(lhi.kind = 'execution' AND lhi.row_id = ${e})`),
    ...(anchors.items ?? []).map(([kind, column]) => `(lhi.kind = '${kind}' AND lhi.row_id = ${column})`)
  ];
  if (itemConditions.length > 0) parts.push(`EXISTS (SELECT 1 FROM legal_hold_items lhi WHERE lhi.hold_id = ${lh}.id AND (${itemConditions.join(" OR ")}))`);
  if (extra) parts.push(`(${extra})`);
  return parts.length > 0 ? `(${parts.join(" OR ")})` : "(1 = 0)";
}

/** True when an active hold covers the row `ref` of `table`. */
export function heldRowSql(table: HoldableTable, ref: string = table, lh = "lh"): string {
  return `EXISTS (SELECT 1 FROM legal_holds ${lh} WHERE ${lh}.status = 'active' AND ${holdMatchSql(table, ref, lh)})`;
}

/**
 * 13.3 — the agent memory to store for a held session: the runtime saves only its last `maxMessages`, so while held
 * the stored history only grows. `next` is appended after the longest stored tail it starts with (compared as JSON);
 * when none matches, all of it is appended. Nothing stored is ever dropped. Loading still reads the last messages
 * only, so the agent sees what it would without the hold.
 */
export function mergeHeldMemory<T>(stored: readonly T[], next: readonly T[]): T[] {
  const storedJson = stored.map((message) => JSON.stringify(message));
  const nextJson = next.map((message) => JSON.stringify(message));
  for (let overlap = Math.min(storedJson.length, nextJson.length); overlap > 0; overlap -= 1) {
    let same = true;
    for (let index = 0; index < overlap && same; index += 1) {
      same = storedJson[storedJson.length - overlap + index] === nextJson[index];
    }
    if (same) return [...stored, ...next.slice(overlap)];
  }
  return [...stored, ...next];
}

/** What a purge or delete appends: the row is not held. */
export function notHeldSql(table: HoldableTable, ref: string = table): string {
  return `NOT ${heldRowSql(table, ref, "lhn")}`;
}

/**
 * The holds that keep a row of `table` named by `idColumn = ?`: SELECT lh.id, lh.name. One `?` parameter (the id).
 */
export function holdsOnRowSql(table: HoldableTable, idColumn = "id"): string {
  return `SELECT DISTINCT lh.id, lh.name, lh.created_at FROM legal_holds lh, ${table} lht
    WHERE lht.${idColumn} = ? AND lh.status = 'active' AND ${holdMatchSql(table, "lht", "lh")} ORDER BY lh.created_at, lh.id`;
}

/**
 * The holds that keep anything a workflow delete removes: a hold on the workflow or its project, or a hold on any of
 * its runs, golden runs, cassettes or eval runs. Parameters: the workflow id, six times. (Agent memory a workflow delete
 * removes is under its legacy namespaces, which a workflow or project hold covers.)
 */
export const HOLDS_ON_WORKFLOW_SQL = `SELECT DISTINCT lh.id, lh.name, lh.created_at FROM legal_holds lh WHERE lh.status = 'active' AND (
    (lh.scope_type = 'workflow' AND lh.scope_id = ?)
    OR (lh.scope_type = 'project' AND lh.scope_id = (SELECT w.project_id FROM workflows w WHERE w.id = ?))
    OR EXISTS (SELECT 1 FROM execution_history lht WHERE lht.workflow_id = ? AND ${holdMatchSql("execution_history", "lht", "lh")})
    OR EXISTS (SELECT 1 FROM replay_recordings lht WHERE lht.workflow_id = ? AND ${holdMatchSql("replay_recordings", "lht", "lh")})
    OR EXISTS (SELECT 1 FROM mcp_cassettes lht WHERE lht.workflow_id = ? AND ${holdMatchSql("mcp_cassettes", "lht", "lh")})
    OR EXISTS (SELECT 1 FROM eval_runs lht WHERE lht.workflow_id = ? AND ${holdMatchSql("eval_runs", "lht", "lh")})
  ) ORDER BY lh.created_at, lh.id`;

/** The holds on a project itself (a project delete). One parameter: the project id. */
export const HOLDS_ON_PROJECT_SQL = `SELECT id, name, created_at FROM legal_holds WHERE status = 'active' AND scope_type = 'project' AND scope_id = ? ORDER BY created_at, id`;

/**
 * The holds that keep anything a golden-set delete removes: the set's project or workflow, its cases, or its runs.
 * Parameters: the dataset id, three times.
 */
export const HOLDS_ON_DATASET_SQL = `SELECT DISTINCT lh.id, lh.name, lh.created_at FROM legal_holds lh WHERE lh.status = 'active' AND (
    EXISTS (SELECT 1 FROM eval_datasets lht WHERE lht.id = ? AND ${holdMatchSql("eval_datasets", "lht", "lh")})
    OR EXISTS (SELECT 1 FROM eval_fixtures lht WHERE lht.dataset_id = ? AND ${holdMatchSql("eval_fixtures", "lht", "lh")})
    OR EXISTS (SELECT 1 FROM eval_runs lht WHERE lht.dataset_id = ? AND ${holdMatchSql("eval_runs", "lht", "lh")})
  ) ORDER BY lh.created_at, lh.id`;

/** `?` placeholders as Postgres `$1, $2, …` (the SQL here never holds a literal `?`). */
export function toPgPlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

/** Rows of `SELECT id, name` as hold references, each once, in order. */
export function holdRefs(rows: ReadonlyArray<{ id: unknown; name: unknown }>): LegalHoldRef[] {
  const seen = new Set<string>();
  const out: LegalHoldRef[] = [];
  for (const row of rows) {
    const id = String(row.id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: String(row.name) });
  }
  return out;
}

/** A hold as placed: its items are written in the same transaction. */
export interface LegalHoldInsert {
  id: string;
  name: string;
  reason: string;
  matterRef: string | null;
  scopeType: LegalHoldScopeType;
  scopeId: string;
  endsAt: string | null;
  createdBy: string | null;
  createdAt: string;
  items: Array<{ kind: LegalHoldItemKind; rowId: string }>;
}

/** What a delete would remove, for the holds that keep it (legalHoldsOn). */
export type LegalHoldTarget =
  | { kind: "workflow"; id: string }
  | { kind: "project"; id: string }
  | { kind: "dataset"; id: string }
  | { kind: "row"; table: HoldableTable; id: string };

/** The holds on a target: the SQL (with `?` placeholders) and its parameters. */
export function legalHoldsOnSql(target: LegalHoldTarget): { sql: string; params: string[] } {
  switch (target.kind) {
    case "workflow":
      return { sql: HOLDS_ON_WORKFLOW_SQL, params: Array.from({ length: 6 }, () => target.id) };
    case "project":
      return { sql: HOLDS_ON_PROJECT_SQL, params: [target.id] };
    case "dataset":
      return { sql: HOLDS_ON_DATASET_SQL, params: [target.id, target.id, target.id] };
    case "row":
      if (!isHoldableTable(target.table)) throw new Error(`Not a holdable table: ${String(target.table)}`);
      return { sql: holdsOnRowSql(target.table), params: [target.id] };
  }
}

/** A legal_holds row as either driver returns it, with its item count. */
export interface LegalHoldRow {
  id: unknown;
  name: unknown;
  reason: unknown;
  matter_ref: unknown;
  scope_type: unknown;
  scope_id: unknown;
  status: unknown;
  ends_at: unknown;
  created_by: unknown;
  created_at: unknown;
  released_by: unknown;
  released_at: unknown;
  release_reason: unknown;
  item_count: unknown;
}

/** SELECT list for LegalHoldRow (alias `h`). */
export const LEGAL_HOLD_COLUMNS = `h.id, h.name, h.reason, h.matter_ref, h.scope_type, h.scope_id, h.status, h.ends_at, h.created_by, h.created_at,
  h.released_by, h.released_at, h.release_reason, (SELECT COUNT(*) FROM legal_hold_items i WHERE i.hold_id = h.id) AS item_count`;

function optionalText(value: unknown): string | null {
  return value === null || value === undefined ? null : value instanceof Date ? value.toISOString() : String(value);
}

export function legalHoldFromRow(row: LegalHoldRow): LegalHoldView {
  // The stored scope as it is, even one this version does not know (a newer version's, after a downgrade): never
  // shown as another scope. Here it holds only the rows it names one by one (its items).
  const scopeType = String(row.scope_type) as LegalHoldScopeType;
  return {
    id: String(row.id),
    name: String(row.name),
    reason: String(row.reason),
    matterRef: optionalText(row.matter_ref),
    scopeType,
    scopeId: String(row.scope_id),
    status: String(row.status) === "active" ? "active" : "released",
    endsAt: optionalText(row.ends_at),
    createdBy: optionalText(row.created_by),
    createdAt: optionalText(row.created_at) ?? "",
    releasedBy: optionalText(row.released_by),
    releasedAt: optionalText(row.released_at),
    releaseReason: optionalText(row.release_reason),
    itemCount: Number(row.item_count ?? 0)
  };
}

export function legalHoldItemFromRow(row: { kind: unknown; row_id: unknown; added_at: unknown }): LegalHoldItemView {
  return { kind: String(row.kind) as LegalHoldItemKind, rowId: String(row.row_id), addedAt: optionalText(row.added_at) ?? "" };
}
