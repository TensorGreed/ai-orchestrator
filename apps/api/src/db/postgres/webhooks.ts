/**
 * Phase 13.1 — PostgresStore: Webhook replay keys and idempotency state.
 * Plain functions over a PgContext; PostgresStore delegates here. Methods that are not implemented yet throw
 * StoreNotImplementedError and are listed in UNIMPLEMENTED_METHODS (remove both together when implementing one).
 */
import { type Store } from "../store.js";
import { parseJsonSafe, toStr } from "./helpers.js";
import type { PgContext } from "./context.js";

export const UNIMPLEMENTED_METHODS: readonly (keyof Store)[] = [];

export async function clearExpiredWebhookSecurityState(ctx: PgContext, nowIso = new Date().toISOString()): Promise<void> {
  await ctx.execute(`DELETE FROM webhook_replay_keys WHERE expires_at <= $1`, [nowIso]);
  await ctx.execute(`DELETE FROM webhook_idempotency WHERE expires_at <= $1`, [nowIso]);
}

export async function hasWebhookReplayKey(ctx: PgContext, replayKey: string): Promise<boolean> {
  const row = await ctx.queryOne<{ replay_key: string }>(
    `SELECT replay_key FROM webhook_replay_keys WHERE replay_key = $1`,
    [replayKey]
  );
  return Boolean(row);
}

export async function saveWebhookReplayKey(ctx: PgContext, input: { replayKey: string; endpointKey: string; expiresAt: string }): Promise<boolean> {
  const result = await ctx.pool.query(
    `INSERT INTO webhook_replay_keys (replay_key, endpoint_key, created_at, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (replay_key) DO NOTHING`,
    [input.replayKey, input.endpointKey, new Date().toISOString(), input.expiresAt]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getWebhookIdempotency(ctx: PgContext, input: { endpointKey: string; idempotencyKey: string }): Promise<{
  endpointKey: string;
  idempotencyKey: string;
  requestHash: string;
  status: string;
  result: unknown;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
} | null> {
  const row = await ctx.queryOne<{
    endpoint_key: string;
    idempotency_key: string;
    request_hash: string;
    status: string;
    result_json: string | null;
    created_at: string;
    updated_at: string;
    expires_at: string;
  }>(
    `SELECT endpoint_key, idempotency_key, request_hash, status, result_json, created_at, updated_at, expires_at
       FROM webhook_idempotency
       WHERE endpoint_key = $1 AND idempotency_key = $2`,
    [input.endpointKey, input.idempotencyKey]
  );
  if (!row) return null;
  return {
    endpointKey: toStr(row.endpoint_key),
    idempotencyKey: toStr(row.idempotency_key),
    requestHash: toStr(row.request_hash),
    status: toStr(row.status),
    result: row.result_json ? parseJsonSafe(row.result_json) : null,
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
    expiresAt: toStr(row.expires_at)
  };
}

export async function saveWebhookIdempotencyPending(ctx: PgContext, input: {
  endpointKey: string;
  idempotencyKey: string;
  requestHash: string;
  expiresAt: string;
}): Promise<void> {
  const now = new Date().toISOString();
  await ctx.execute(
    `INSERT INTO webhook_idempotency (endpoint_key, idempotency_key, request_hash, status, result_json, created_at, updated_at, expires_at)
       VALUES ($1, $2, $3, 'pending', NULL, $4, $5, $6)`,
    [input.endpointKey, input.idempotencyKey, input.requestHash, now, now, input.expiresAt]
  );
}

export async function saveWebhookIdempotencyResult(ctx: PgContext, input: {
  endpointKey: string;
  idempotencyKey: string;
  status: "success" | "error" | "partial" | "waiting_approval" | "canceled";
  result: unknown;
}): Promise<void> {
  const now = new Date().toISOString();
  await ctx.execute(
    `UPDATE webhook_idempotency SET status = $1, result_json = $2, updated_at = $3
       WHERE endpoint_key = $4 AND idempotency_key = $5`,
    [input.status, JSON.stringify(input.result ?? null), now, input.endpointKey, input.idempotencyKey]
  );
}
