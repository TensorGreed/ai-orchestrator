/**
 * Phase 13.1 — PostgresStore: Guard simulations. Each function matches the SqliteStore method of the same name.
 * At most one row is `running` (v39's partial unique index idx_guard_simulations_one_running): an insert or update
 * that would make a second one fails with 23505, which the service maps to GuardSimulationBusyError (409).
 */
import type { GuardSimulationRecord } from "../database.js";
import { type Store } from "../store.js";
import { toNum, toStr } from "./helpers.js";
import type { PgContext } from "./context.js";
import { deleteRunsWhole } from "./prune.js";

type Row = Record<string, unknown>;

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function mapGuardSimulationRow(row: Row): GuardSimulationRecord {
  const jobs = typeof row.job_ids_json === "string" ? safeJsonParse(row.job_ids_json) : null;
  const detail = typeof row.summary_json === "string" && row.summary_json ? safeJsonParse(row.summary_json) : null;
  const optionalNumber = (value: unknown) => (value === null || value === undefined ? null : toNum(value));
  const optionalString = (value: unknown) => (value === null || value === undefined ? null : toStr(value));
  return {
    id: toStr(row.id),
    profileId: toStr(row.profile_id),
    sourceKind: toStr(row.source_kind) === "version" ? "version" : "inline",
    sourceVersion: optionalNumber(row.source_version),
    simulatedHash: toStr(row.simulated_hash),
    baseVersion: optionalNumber(row.base_version),
    jobIds: Array.isArray(jobs) ? jobs.map((entry) => String(entry)) : [],
    detail: detail && typeof detail === "object" && !Array.isArray(detail) ? (detail as Record<string, unknown>) : null,
    status: toStr(row.status),
    error: optionalString(row.error),
    createdAt: toStr(row.created_at),
    createdBy: optionalString(row.created_by),
    createdByUserId: optionalString(row.created_by_user_id),
    finishedAt: optionalString(row.finished_at)
  };
}

export async function insertGuardSimulation(ctx: PgContext, input: Parameters<Store["insertGuardSimulation"]>[0]): Promise<GuardSimulationRecord> {
  const row = await ctx.queryOne<Row>(
    `INSERT INTO guard_simulations (id, profile_id, source_kind, source_version, simulated_hash, base_version, job_ids_json, summary_json, status, error, created_at, created_by, created_by_user_id, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING *`,
    [
      input.id,
      input.profileId,
      input.sourceKind,
      input.sourceVersion,
      input.simulatedHash,
      input.baseVersion,
      JSON.stringify(input.jobIds),
      input.detail ? JSON.stringify(input.detail) : null,
      input.status,
      input.error ?? null,
      input.createdAt,
      input.createdBy,
      input.createdByUserId,
      input.finishedAt ?? null
    ]
  );
  return mapGuardSimulationRow(row!);
}

/** Updates a simulation; `onlyFrom` limits it to rows still in one of those statuses. Returns whether a row changed. */
export async function updateGuardSimulation(ctx: PgContext, input: Parameters<Store["updateGuardSimulation"]>[0]): Promise<boolean> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (input.status !== undefined) set("status", input.status);
  if (input.jobIds !== undefined) set("job_ids_json", JSON.stringify(input.jobIds));
  if (input.detail !== undefined) set("summary_json", JSON.stringify(input.detail));
  if (input.error !== undefined) set("error", input.error);
  if (input.finishedAt !== undefined) set("finished_at", input.finishedAt);
  if (sets.length === 0) return false;
  params.push(input.id);
  let where = `id = $${params.length}`;
  if (input.onlyFrom && input.onlyFrom.length > 0) {
    const marks = input.onlyFrom.map((status) => {
      params.push(status);
      return `$${params.length}`;
    });
    where += ` AND status IN (${marks.join(", ")})`;
  }
  const result = await ctx.pool.query(`UPDATE guard_simulations SET ${sets.join(", ")} WHERE ${where}`, params);
  return (result.rowCount ?? 0) > 0;
}

export async function getGuardSimulation(ctx: PgContext, id: string): Promise<GuardSimulationRecord | null> {
  const row = await ctx.queryOne<Row>(`SELECT * FROM guard_simulations WHERE id = $1`, [id]);
  return row ? mapGuardSimulationRow(row) : null;
}

/** Newest first; rows created at the same instant come in reverse insertion order (`seq`, v40; SQLite: rowid). */
export async function listGuardSimulations(ctx: PgContext, options: Parameters<Store["listGuardSimulations"]>[0]): Promise<GuardSimulationRecord[]> {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 20)));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const rows = await ctx.query<Row>(
    `SELECT * FROM guard_simulations WHERE profile_id = $1 ORDER BY created_at DESC, seq DESC LIMIT $2 OFFSET $3`,
    [options.profileId, limit, offset]
  );
  return rows.map(mapGuardSimulationRow);
}

/** Simulations still running (a stopped server left them so). */
export async function listRunningGuardSimulations(ctx: PgContext): Promise<GuardSimulationRecord[]> {
  const rows = await ctx.query<Row>(`SELECT * FROM guard_simulations WHERE status = 'running' ORDER BY created_at ASC`);
  return rows.map(mapGuardSimulationRow);
}

/** Simulations one pruneGuardSimulations transaction deletes at most, with their jobs. */
const SIMULATION_PRUNE_CHUNK = 50;

/**
 * Deletes simulations created before `before`, with their finished replay jobs and case results. Returns the
 * simulations deleted.
 *
 * Never waits for a row lock (see prune.ts): the simulations are read without locking, then each chunk goes in its
 * own short transaction. It locks the simulation rows it can get, then deletes their finished jobs whole or not at
 * all (deleteRunsWhole). A simulation is deleted only when none of its finished jobs is left: one whose job another
 * transaction holds (a workflow delete under way, a data-subject delete marking it ineligible) stays, with that job,
 * for a later run, so its job list is never lost while the job remains. Queued or running jobs are not waited for and
 * do not keep a simulation, as on SQLite.
 */
export async function pruneGuardSimulations(ctx: PgContext, input: { before: string }): Promise<number> {
  const candidates = (await ctx.query<{ id: string }>(`SELECT id FROM guard_simulations WHERE created_at < $1 ORDER BY created_at, id`, [input.before])).map((row) =>
    toStr(row.id)
  );
  let deleted = 0;
  for (let index = 0; index < candidates.length; index += SIMULATION_PRUNE_CHUNK) {
    const chunk = candidates.slice(index, index + SIMULATION_PRUNE_CHUNK);
    deleted += await ctx.withTransaction(async (client) => {
      const rows = (
        await client.query<{ id: string; job_ids_json: string | null }>(
          `SELECT id, job_ids_json FROM guard_simulations WHERE id = ANY($1::text[]) AND created_at < $2 ORDER BY id FOR UPDATE SKIP LOCKED`,
          [chunk, input.before]
        )
      ).rows;
      if (rows.length === 0) return 0;
      const jobsOf = new Map<string, string[]>();
      for (const row of rows) {
        const parsed = row.job_ids_json ? safeJsonParse(toStr(row.job_ids_json)) : null;
        jobsOf.set(toStr(row.id), Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : []);
      }
      const jobIds = [...new Set([...jobsOf.values()].flat())];
      const gone = await deleteRunsWhole(client, jobIds);
      const kept = jobIds.filter((id) => !gone.has(id));
      const left = new Set(
        kept.length === 0
          ? []
          : (await client.query<{ id: string }>(`SELECT id FROM eval_runs WHERE id = ANY($1::text[]) AND status NOT IN ('queued', 'running')`, [kept])).rows.map((row) =>
              toStr(row.id)
            )
      );
      const doomed = [...jobsOf].filter(([, jobs]) => !jobs.some((job) => left.has(job))).map(([id]) => id);
      if (doomed.length === 0) return 0;
      // Every doomed row is locked above, so this never waits.
      const result = await client.query(`DELETE FROM guard_simulations WHERE id = ANY($1::text[])`, [doomed]);
      return result.rowCount ?? 0;
    });
  }
  return deleted;
}
