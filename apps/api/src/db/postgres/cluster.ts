/**
 * Phase 13.1 — the cluster registry and cross-instance advisory locks on Postgres. Every time comparison uses the
 * database clock (`now()`), so instances whose clocks disagree still agree on who is alive.
 */
import type { Pool, PoolClient } from "pg";
import type { ClusterInstanceHeartbeat, ClusterInstanceRecord } from "../store.js";
import type { PgContext } from "./context.js";
import { parseJsonSafe, toNum, toStr } from "./helpers.js";
import * as queue from "./queue.js";

interface ClusterInstanceRow {
  id: string;
  worker_mode: string;
  ha_enabled: number;
  is_leader: number;
  pools_json: string | null;
  concurrency: number | null;
  running: number;
  app_version: string | null;
  schema_version: number | null;
  capabilities_json: string | null;
  hostname: string | null;
  bus_connected: number;
  started_at: string;
  heartbeat_at: string;
  live: boolean;
}

function stringList(value: string | null): string[] {
  const parsed = parseJsonSafe(value);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

export async function heartbeatClusterInstance(ctx: PgContext, input: ClusterInstanceHeartbeat): Promise<void> {
  await ctx.execute(
    `INSERT INTO cluster_instances
       (id, worker_mode, ha_enabled, is_leader, pools_json, concurrency, running, app_version, schema_version,
        capabilities_json, hostname, bus_connected, started_at, heartbeat_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
     ON CONFLICT (id) DO UPDATE SET
       worker_mode = EXCLUDED.worker_mode, ha_enabled = EXCLUDED.ha_enabled, is_leader = EXCLUDED.is_leader,
       pools_json = EXCLUDED.pools_json, concurrency = EXCLUDED.concurrency, running = EXCLUDED.running,
       app_version = EXCLUDED.app_version, schema_version = EXCLUDED.schema_version,
       capabilities_json = EXCLUDED.capabilities_json, hostname = EXCLUDED.hostname,
       bus_connected = EXCLUDED.bus_connected, started_at = EXCLUDED.started_at, heartbeat_at = now()`,
    [
      input.id,
      input.workerMode,
      input.haEnabled ? 1 : 0,
      input.isLeader ? 1 : 0,
      JSON.stringify(input.pools),
      input.concurrency,
      input.running,
      input.appVersion,
      input.schemaVersion,
      JSON.stringify(input.capabilities),
      input.hostname,
      input.busConnected ? 1 : 0,
      input.startedAt
    ]
  );
}

export async function listClusterInstances(ctx: PgContext, input: { liveWithinMs: number }): Promise<ClusterInstanceRecord[]> {
  const rows = await ctx.query<ClusterInstanceRow>(
    `SELECT *, heartbeat_at >= now() - make_interval(secs => $1::double precision / 1000.0) AS live
       FROM cluster_instances ORDER BY heartbeat_at DESC, id`,
    [input.liveWithinMs]
  );
  return rows.map((row) => ({
    id: toStr(row.id),
    workerMode: toStr(row.worker_mode),
    haEnabled: toNum(row.ha_enabled) === 1,
    isLeader: toNum(row.is_leader) === 1,
    pools: stringList(row.pools_json),
    concurrency: row.concurrency === null ? null : toNum(row.concurrency),
    running: toNum(row.running),
    appVersion: row.app_version,
    schemaVersion: row.schema_version === null ? null : toNum(row.schema_version),
    capabilities: stringList(row.capabilities_json),
    hostname: row.hostname ?? "",
    busConnected: toNum(row.bus_connected) === 1,
    startedAt: toStr(row.started_at),
    heartbeatAt: toStr(row.heartbeat_at),
    live: row.live === true
  }));
}

export async function deleteClusterInstance(ctx: PgContext, id: string): Promise<void> {
  await ctx.execute(`DELETE FROM cluster_instances WHERE id = $1`, [id]);
}

export async function pruneClusterInstances(ctx: PgContext, input: { olderThanMs: number }): Promise<number> {
  const result = await ctx.pool.query(
    `DELETE FROM cluster_instances WHERE heartbeat_at < now() - make_interval(secs => $1::double precision / 1000.0)`,
    [input.olderThanMs]
  );
  return result.rowCount ?? 0;
}

export async function claimClusterRunOwner(ctx: PgContext, input: { executionId: string; instanceId: string }): Promise<void> {
  // A run resumed (or retried under the same id) by another instance takes the row over.
  await ctx.execute(
    `INSERT INTO cluster_run_owners (execution_id, instance_id, started_at) VALUES ($1, $2, now())
     ON CONFLICT (execution_id) DO UPDATE SET instance_id = EXCLUDED.instance_id, started_at = EXCLUDED.started_at`,
    [input.executionId, input.instanceId]
  );
}

export async function releaseClusterRunOwner(ctx: PgContext, input: { executionId: string; instanceId: string }): Promise<void> {
  await ctx.execute(`DELETE FROM cluster_run_owners WHERE execution_id = $1 AND instance_id = $2`, [input.executionId, input.instanceId]);
}

/**
 * Fails the `running` history rows among `ids` with `error`, except runs a live (pending or running) queue job drives
 * (`held`, from `listExecutionIdsWithActiveQueueJob`, keyed on the job's execution id so approval resumes are
 * covered): those belong to the queue's lease, reaper and worker-loss policy. The `UPDATE` re-checks
 * `status = 'running'`, so a job that finishes in between changes nothing.
 */
async function failRunningUnlessQueued(
  client: PoolClient,
  ids: string[],
  held: ReadonlySet<string>,
  error: string
): Promise<{ rows: Array<{ id: string; workflow_id: string }> }> {
  const eligible = ids.filter((id) => !held.has(id));
  if (eligible.length === 0) return { rows: [] };
  return await client.query<{ id: string; workflow_id: string }>(
    `UPDATE execution_history
        SET status = 'error', completed_at = now(), error = $2,
            duration_ms = GREATEST(0, (EXTRACT(EPOCH FROM (now() - started_at::timestamptz)) * 1000)::bigint)
      WHERE id = ANY($1::text[]) AND status = 'running'
      RETURNING id, workflow_id`,
    [eligible, error]
  );
}

/**
 * The queue-held subset of `ids`, read before a reconcile opens its transaction, so the reconcile never holds owner
 * row locks while it waits for a second pool connection. A run that becomes queue-held after this read cannot have an
 * owner row: a queued run never gets one (the consumer registers none), so the locked rows are only ever inline runs
 * and the reconcile acts on them as before.
 */
async function queueHeldAmong(ctx: PgContext, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  return new Set(await queue.listExecutionIdsWithActiveQueueJob(ctx, ids));
}

export async function reconcileDeadExecutorRuns(
  ctx: PgContext,
  input: { error: string; deadAfterMs: number; selfId: string }
): Promise<Array<{ id: string; workflowId: string; instanceId: string }>> {
  const deadSelect = `SELECT o.execution_id, o.instance_id
         FROM cluster_run_owners o
         LEFT JOIN cluster_instances i ON i.id = o.instance_id
        WHERE o.instance_id <> $1
          AND (
            (i.id IS NULL AND o.started_at < now() - make_interval(secs => $2::double precision / 1000.0))
            OR i.heartbeat_at < now() - make_interval(secs => $2::double precision / 1000.0)
          )
        ORDER BY o.execution_id`;
  const params = [input.selfId, input.deadAfterMs];
  const candidates = await ctx.query<{ execution_id: string }>(deadSelect, params);
  if (candidates.length === 0) return [];
  const checked = candidates.map((row) => row.execution_id);
  const held = await queueHeldAmong(ctx, checked);
  return await ctx.withTransaction(async (client) => {
    // The owners of dead instances, locked so two reconciling leaders (a handover) never fail a run twice. Only the
    // candidates whose queue state was read above: an owner that ages past the window in between waits for the next
    // pass, so no run is failed without its queue check.
    const dead = await client.query<{ execution_id: string; instance_id: string }>(
      deadSelect.replace("ORDER BY", "AND o.execution_id = ANY($3::text[])\n        ORDER BY") + "\n        FOR UPDATE OF o SKIP LOCKED",
      [...params, checked]
    );
    if (dead.rows.length === 0) return [];
    const ids = dead.rows.map((row) => row.execution_id);
    const ownerOf = new Map(dead.rows.map((row) => [row.execution_id, row.instance_id]));
    const failed = await failRunningUnlessQueued(client, ids, held, input.error);
    await client.query(`DELETE FROM cluster_run_owners WHERE execution_id = ANY($1::text[])`, [ids]);
    return failed.rows.map((row) => ({ id: row.id, workflowId: row.workflow_id, instanceId: ownerOf.get(row.id) ?? "" }));
  });
}

export async function failRunsOwnedBy(
  ctx: PgContext,
  input: { instanceId: string; error: string }
): Promise<Array<{ id: string; workflowId: string; instanceId: string }>> {
  const candidates = await ctx.query<{ execution_id: string }>(
    `SELECT execution_id FROM cluster_run_owners WHERE instance_id = $1 ORDER BY execution_id`,
    [input.instanceId]
  );
  if (candidates.length === 0) return [];
  const checked = candidates.map((row) => row.execution_id);
  const held = await queueHeldAmong(ctx, checked);
  return await ctx.withTransaction(async (client) => {
    // Only the owner rows whose queue state was read above; one claimed in between is left for the next call.
    const owned = await client.query<{ execution_id: string }>(
      `SELECT execution_id FROM cluster_run_owners WHERE instance_id = $1 AND execution_id = ANY($2::text[]) ORDER BY execution_id FOR UPDATE SKIP LOCKED`,
      [input.instanceId, checked]
    );
    if (owned.rows.length === 0) return [];
    const ids = owned.rows.map((row) => row.execution_id);
    const failed = await failRunningUnlessQueued(client, ids, held, input.error);
    await client.query(`DELETE FROM cluster_run_owners WHERE execution_id = ANY($1::text[]) AND instance_id = $2`, [ids, input.instanceId]);
    return failed.rows.map((row) => ({ id: row.id, workflowId: row.workflow_id, instanceId: input.instanceId }));
  });
}

/**
 * Phase 13.1 — advisory lock classes for cluster-wide mutual exclusion (see the key space in postgres-store.ts):
 *   0x4c3258 ("L2X")  audit export — key: hashtext(schema:destination id). Held while one destination's batch is read,
 *                     delivered and its cursor advanced, so two instances never ship the same rows.
 *   0x4c3247 ("L2G")  git sync — key: hashtext(schema:"git-sync"). Held for a pull or push.
 */
export const ADVISORY_LOCK_CLASS_AUDIT_EXPORT = 0x4c3258;
export const ADVISORY_LOCK_CLASS_GIT_SYNC = 0x4c3247;
/**
 * 0x4c3241 ("L2A")  MCP OAuth token refresh — key: hashtext(schema:server id[:user id]). Held while one connection's
 *                   stored token is re-read and, if still due, refreshed, so two instances never spend one rotating
 *                   refresh token twice.
 */
export const ADVISORY_LOCK_CLASS_MCP_OAUTH_REFRESH = 0x4c3241;

export type AdvisoryLockOutcome<T> = { acquired: true; value: T } | { acquired: false };

/**
 * Runs `fn` while holding the session advisory lock `(lockClass, hashtext(current_schema() || ':' || key))` on one
 * pooled connection, released afterwards (also when `fn` throws). With `waitMs` 0 it tries once and returns
 * `{ acquired: false }` when another session holds the lock; otherwise it retries until `waitMs` has passed. The lock
 * is a session lock, not a transaction lock, so `fn` may take long (a delivery over HTTP, a git push) without keeping a
 * transaction open. A connection whose unlock fails is discarded, which frees the lock with its session.
 */
export async function withAdvisoryLock<T>(
  pool: Pool,
  lockClass: number,
  key: string,
  options: { waitMs: number; retryMs?: number },
  fn: () => Promise<T>
): Promise<AdvisoryLockOutcome<T>> {
  const client: PoolClient = await pool.connect();
  // Dropped (not reused) only when a lock or unlock query failed, which leaves the session's lock state unknown; an
  // error from `fn` itself says nothing about the connection.
  let discard = false;
  try {
    try {
      const deadline = Date.now() + options.waitMs;
      for (;;) {
        const result = await client.query<{ locked: boolean }>(
          `SELECT pg_try_advisory_lock($1, hashtext(current_schema() || ':' || $2::text)) AS locked`,
          [lockClass, key]
        );
        if (result.rows[0]?.locked === true) break;
        if (Date.now() >= deadline) return { acquired: false };
        await new Promise((resolve) => setTimeout(resolve, Math.min(options.retryMs ?? 200, Math.max(1, deadline - Date.now()))));
      }
    } catch (error) {
      discard = true;
      throw error;
    }
    try {
      return { acquired: true, value: await fn() };
    } finally {
      await client
        .query(`SELECT pg_advisory_unlock($1, hashtext(current_schema() || ':' || $2::text))`, [lockClass, key])
        .catch(() => {
          discard = true;
        });
    }
  } finally {
    client.release(discard);
  }
}
