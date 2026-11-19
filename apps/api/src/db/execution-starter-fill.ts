/**
 * v80 — who started the runs recorded before v80: filled in after start-up by a background job
 * (services/execution-starter-fill-service.ts), not inside the migration, so an upgrade never locks
 * `execution_history` for the whole fill.
 *
 * The job's state is kept in `schema_markers`, so both stores, backups and db:copy carry it without a table of its own:
 *   - `execution_starter_fill_upto:<n>` — the fill is to do; it visits the runs up to insertion number `n` (Postgres
 *     `seq`, SQLite `rowid`): the runs recorded when the upgrade ran. A run recorded after records its starter itself,
 *     so the fill never touches it, also when it records nobody (a webhook, a schedule, a public form).
 *   - `execution_starter_fill_after:<n>` — how far it got: the runs up to `n` were visited. Saved in the same
 *     transaction as each batch, so a stop or a crash resumes after the last batch that committed, and a run visited
 *     once is never judged again (a rename after it was visited changes nothing).
 *   - `execution_starter_backfill` — done (an older build wrote this name when it filled the runs at start-up).
 * No marker at all: a Postgres database that took v80 before the fill moved here (its migration filled the runs), so
 * there is nothing to do.
 *
 * Until a run is visited its `triggered_by_user_id` is NULL, which counts as nobody's own run (fail closed): someone
 * who sees only their own runs does not see it yet, and a retry of it uses the retrying person's sessions.
 */

export const STARTER_FILL_DONE_MARKER = "execution_starter_backfill";
export const STARTER_FILL_UPTO_PREFIX = "execution_starter_fill_upto:";
export const STARTER_FILL_AFTER_PREFIX = "execution_starter_fill_after:";

/** Runs one fill batch visits (each batch is one short transaction). */
export const STARTER_FILL_BATCH_SIZE = 2000;

export interface ExecutionStarterFillState {
  /** Nothing (left) to fill. */
  done: boolean;
  /** The last insertion number the fill visits (null when done). */
  upTo: number | null;
  /** The last insertion number it visited (0 before the first batch). */
  after: number;
}

export interface ExecutionStarterFillBatch {
  /** Runs visited in this batch (still without a starter when it began). */
  visited: number;
  /** Of those, the runs that got a starter. */
  filled: number;
  /** The fill is finished (this batch found nothing left, or it was already done). */
  done: boolean;
  /** How long the batch's transaction held its locks, in milliseconds. */
  transactionMs: number;
}

/** Whether a `schema_markers` name belongs to the fill (its progress, not the done marker). */
export function isStarterFillProgressMarker(name: string): boolean {
  return name.startsWith(STARTER_FILL_UPTO_PREFIX) || name.startsWith(STARTER_FILL_AFTER_PREFIX);
}

function numberAfter(name: string, prefix: string): number | null {
  if (!name.startsWith(prefix)) return null;
  const value = Number(name.slice(prefix.length));
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** The fill's state from the `schema_markers` names. */
export function starterFillState(names: Iterable<string>): ExecutionStarterFillState {
  let upTo: number | null = null;
  let after = 0;
  for (const name of names) {
    if (name === STARTER_FILL_DONE_MARKER) return { done: true, upTo: null, after: 0 };
    const limit = numberAfter(name, STARTER_FILL_UPTO_PREFIX);
    if (limit !== null) upTo = upTo === null ? limit : Math.max(upTo, limit);
    const reached = numberAfter(name, STARTER_FILL_AFTER_PREFIX);
    if (reached !== null) after = Math.max(after, reached);
  }
  if (upTo === null) return { done: true, upTo: null, after: 0 };
  return { done: false, upTo, after };
}

/** The marker that starts a fill of the runs up to `upTo`, or the done marker when there are none. */
export function starterFillStartMarker(upTo: number | null): string {
  return upTo === null || upTo <= 0 ? STARTER_FILL_DONE_MARKER : `${STARTER_FILL_UPTO_PREFIX}${upTo}`;
}
