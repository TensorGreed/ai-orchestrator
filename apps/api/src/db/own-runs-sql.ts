/**
 * The "own runs" test in SQL, the same rule as run-access.ts `runOwnedBy`, for both stores. `bind` adds one parameter
 * and returns its placeholder; it is called once per placeholder, in the order they appear in the text (SQLite binds
 * `?` by position).
 *
 * A run is the person's when it ran in their sessions (`session_owner`), or when it records them as the person who
 * started it (`triggered_by_user_id`, v80; migration 80 set it on the runs recorded before). Nothing else counts: a run
 * without either is nobody's own run, so an email given to another account never brings runs with it.
 */
import type { OwnRunsFilter } from "./database.js";

export type BindParameter = (value: string) => string;

/** True for an `execution_history` row that is the person's own. */
export function ownHistoryRunSql(own: OwnRunsFilter, bind: BindParameter): string {
  return `(triggered_by_user_id = ${bind(own.userId)} OR session_owner = ${bind(own.userId)})`;
}
