/**
 * The "own runs" test in SQL, the same rule as run-access.ts `runOwnedBy`, for both stores. `bind` adds one parameter
 * and returns its placeholder; it is called once per placeholder, in the order they appear in the text (SQLite binds
 * `?` by position).
 *
 * A run is the person's when it ran in their sessions (`session_owner`), or when it records who started it
 * (`triggered_by_user_id`, v80) and that is them. A run without it (recorded before v80) is theirs when `triggered_by`
 * is their user id, or their email and their account was created before the run started: an email given to a new
 * account later does not bring the old account's runs with it.
 */
import type { OwnRunsFilter } from "./database.js";

export type BindParameter = (value: string, cast?: "timestamptz") => string;

/** True for an `execution_history` row that is the person's own. */
export function ownHistoryRunSql(own: OwnRunsFilter, bind: BindParameter): string {
  const byId = `triggered_by_user_id = ${bind(own.userId)} OR session_owner = ${bind(own.userId)}`;
  return `(${byId} OR (triggered_by_user_id IS NULL AND ${startedByEmailOrIdSql(own, bind)}))`;
}

/** True for a `workflow_executions` row (a paused run) the person started, judged as a run recorded before v80. */
export function ownPausedRunSql(own: OwnRunsFilter, bind: BindParameter): string {
  return startedByEmailOrIdSql(own, bind);
}

function startedByEmailOrIdSql(own: OwnRunsFilter, bind: BindParameter): string {
  const byId = `triggered_by = ${bind(own.userId)}`;
  if (!own.userCreatedAt) return `(${byId})`;
  return `(${byId} OR (LOWER(triggered_by) = ${bind(own.email.toLowerCase())} AND started_at >= ${bind(own.userCreatedAt, "timestamptz")}))`;
}
