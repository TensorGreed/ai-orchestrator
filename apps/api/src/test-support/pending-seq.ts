/**
 * Phase 13.1 (q3b, test only) — the `seq` identity columns the q3b Postgres modules order by where SQLite uses rowid.
 * Migration v40 (q3a's branch) adds `seq` to Postgres's insertion-ordered tables; these q3b tables join v40 when
 * q3b is stacked on q3a, and this file is removed then. Until that, contract and concurrency tests add the columns to
 * their own schema here (`IF NOT EXISTS`, so it is a no-op once v40 has them). Schema-parity tests never call it.
 */
import type { Pool } from "pg";
import { testPostgresPool, type TestStore } from "./test-store.js";

export const PENDING_SEQ_TABLES = [
  "eval_fixtures",
  "eval_runs",
  "eval_results",
  "mcp_cassettes",
  "replay_recordings",
  "guard_simulations",
  "execution_history"
] as const;

export const PENDING_SEQ_SQL = PENDING_SEQ_TABLES.map(
  (table) => `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS seq BIGINT GENERATED ALWAYS AS IDENTITY;`
).join("\n");

/** Adds the pending `seq` columns to a Postgres test store's schema (SQLite: nothing to do). */
export async function applyPendingSeqColumns(test: TestStore): Promise<void> {
  if (test.kind !== "postgres" || !test.schema) return;
  const pool: Pool = testPostgresPool(test.schema);
  try {
    await pool.query(PENDING_SEQ_SQL);
  } finally {
    await pool.end();
  }
}
