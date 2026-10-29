/**
 * Phase 13.1 — PostgresStore: state a flow keeps between two requests that may land on different instances (cluster
 * mode only): pending challenges (a sign-in's TOTP step, an MCP OAuth authorization), shared rate-limit buckets and
 * replay-capture reservations. Every check-and-act is one statement or one transaction under a per-key lock, and every
 * time comparison uses the database clock (`now()`), so instances whose clocks disagree still agree.
 */
import type { ConsumedPendingChallenge, PendingChallengeInput } from "../store.js";
import type { PgContext } from "./context.js";
import { toNum, toStr } from "./helpers.js";

/**
 * Advisory lock class for replay-capture reservations (see the key space in postgres-store.ts):
 *   0x4c3243 ("L2C")  key: hashtext(schema:workflow id). Held for the reserving transaction (pg_advisory_xact_lock), so
 *                     the count of captures and live reservations and the insert that follows it are one step.
 */
export const ADVISORY_LOCK_CLASS_CAPTURE_RESERVATION = 0x4c3243;

const MS_INTERVAL = `make_interval(secs => $2::double precision / 1000.0)`;

export async function createPendingChallenge(ctx: PgContext, input: PendingChallengeInput): Promise<void> {
  await ctx.execute(
    `INSERT INTO pending_challenges (id_hash, kind, user_id, scope, payload_sealed, created_at, expires_at)
     VALUES ($1, $3, $4, $5, $6, now(), now() + ${MS_INTERVAL})
     ON CONFLICT (id_hash) DO UPDATE SET kind = EXCLUDED.kind, user_id = EXCLUDED.user_id, scope = EXCLUDED.scope,
       payload_sealed = EXCLUDED.payload_sealed, created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at`,
    [input.idHash, Math.max(0, input.ttlMs), input.kind, input.userId, input.scope, input.payloadSealed]
  );
}

/** One DELETE … RETURNING: two instances consuming the same challenge at once get it once between them. */
export async function consumePendingChallenge(ctx: PgContext, input: { idHash: string; kind: string }): Promise<ConsumedPendingChallenge | null> {
  const row = await ctx.queryOne<{ user_id: string | null; scope: string | null; payload_sealed: string; expired: boolean }>(
    `DELETE FROM pending_challenges WHERE id_hash = $1 AND kind = $2
     RETURNING user_id, scope, payload_sealed, expires_at <= now() AS expired`,
    [input.idHash, input.kind]
  );
  if (!row) return null;
  return {
    userId: row.user_id === null ? null : toStr(row.user_id),
    scope: row.scope === null ? null : toStr(row.scope),
    payloadSealed: toStr(row.payload_sealed),
    expired: row.expired === true
  };
}

export async function deletePendingChallenges(ctx: PgContext, input: { kind: string; scope: string; userId: string | null }): Promise<number> {
  const result = await ctx.pool.query(
    `DELETE FROM pending_challenges WHERE kind = $1 AND scope = $2 AND user_id IS NOT DISTINCT FROM $3`,
    [input.kind, input.scope, input.userId]
  );
  return result.rowCount ?? 0;
}

export async function prunePendingChallenges(ctx: PgContext): Promise<number> {
  const result = await ctx.pool.query(`DELETE FROM pending_challenges WHERE expires_at <= now()`);
  return result.rowCount ?? 0;
}

/**
 * One upsert: a new key, or one whose window has passed, starts at 1 with a fresh window; otherwise the count goes up
 * by one. The row lock the upsert takes orders concurrent hits, so N hits across any number of instances count N.
 */
export async function hitRateLimitBucket(ctx: PgContext, input: { key: string; windowMs: number }): Promise<{ count: number; ttlMs: number }> {
  const windowMs = Math.max(1, Math.floor(input.windowMs));
  const row = await ctx.queryOne<{ count: number; ttl_ms: string }>(
    `INSERT INTO rate_limit_buckets AS b (key, window_start, expires_at, count)
     VALUES ($1, now(), now() + ${MS_INTERVAL}, 1)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN b.expires_at <= now() THEN 1 ELSE b.count + 1 END,
       window_start = CASE WHEN b.expires_at <= now() THEN now() ELSE b.window_start END,
       expires_at = CASE WHEN b.expires_at <= now() THEN now() + ${MS_INTERVAL} ELSE b.expires_at END
     RETURNING b.count, GREATEST(0, CEIL(EXTRACT(EPOCH FROM (b.expires_at - now())) * 1000))::bigint AS ttl_ms`,
    [input.key, windowMs]
  );
  return { count: row ? toNum(row.count) : 1, ttlMs: row ? toNum(row.ttl_ms) : windowMs };
}

export async function pruneRateLimitBuckets(ctx: PgContext): Promise<number> {
  const result = await ctx.pool.query(`DELETE FROM rate_limit_buckets WHERE expires_at <= now()`);
  return result.rowCount ?? 0;
}

/**
 * Under a transaction lock per workflow: the captures since `since` plus the live reservations, then the insert only
 * when they are below the limit. A second instance reserving for the same workflow waits for the lock and then counts
 * this reservation, so the daily limit holds across instances.
 */
export async function reserveReplayCapture(
  ctx: PgContext,
  input: { id: string; workflowId: string; since: string; maxPerDay: number; ttlMs: number }
): Promise<boolean> {
  return await ctx.withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock($1, hashtext(current_schema() || ':' || $2::text))`, [
      ADVISORY_LOCK_CLASS_CAPTURE_RESERVATION,
      input.workflowId
    ]);
    const used = await client.query<{ captured: string; reserved: string }>(
      `SELECT (SELECT COUNT(*) FROM replay_recordings WHERE workflow_id = $1 AND captured_at >= $2) AS captured,
              (SELECT COUNT(*) FROM capture_reservations WHERE workflow_id = $1 AND expires_at > now()) AS reserved`,
      [input.workflowId, input.since]
    );
    const row = used.rows[0];
    const total = row ? toNum(row.captured) + toNum(row.reserved) : 0;
    if (total >= input.maxPerDay) return false;
    await client.query(
      `INSERT INTO capture_reservations (id, workflow_id, created_at, expires_at)
       VALUES ($1, $3, now(), now() + ${MS_INTERVAL})`,
      [input.id, Math.max(0, input.ttlMs), input.workflowId]
    );
    return true;
  });
}

export async function releaseReplayCaptureReservation(ctx: PgContext, id: string): Promise<void> {
  await ctx.execute(`DELETE FROM capture_reservations WHERE id = $1`, [id]);
}

export async function countReplayCaptureReservations(ctx: PgContext, workflowId: string): Promise<number> {
  const row = await ctx.queryOne<{ count: string }>(
    `SELECT COUNT(*) AS count FROM capture_reservations WHERE workflow_id = $1 AND expires_at > now()`,
    [workflowId]
  );
  return row ? toNum(row.count) : 0;
}

export async function pruneReplayCaptureReservations(ctx: PgContext): Promise<number> {
  const result = await ctx.pool.query(`DELETE FROM capture_reservations WHERE expires_at <= now()`);
  return result.rowCount ?? 0;
}
