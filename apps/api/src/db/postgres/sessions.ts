/**
 * Phase 13.1 — PostgresStore: Login sessions, session memory, the session tool cache and session artifacts.
 * Plain functions over a PgContext; PostgresStore delegates here. Methods that are not implemented yet throw
 * StoreNotImplementedError and are listed in UNIMPLEMENTED_METHODS (remove both together when implementing one).
 */
import { randomUUID } from "node:crypto";
import { type ChatMessage, type DataLabels, isEmptyDataLabels, labelsForUntrackedSave, mergeDataLabels, parseStoredDataLabels } from "@ai-orchestrator/shared";
import { type Store } from "../store.js";
import { parseJsonSafe, toStr, labelsField } from "./helpers.js";
import type { PgContext } from "./context.js";
import { withReferenceCheck } from "../store-errors.js";

const MAX_SESSION_TOOL_CACHE_RECORDS = 400;

export const UNIMPLEMENTED_METHODS: readonly (keyof Store)[] = [];

export async function getSession(ctx: PgContext, sessionId: string): Promise<{
  id: string;
  userId: string;
  expiresAt: string;
  createdAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
} | null> {
  const row = await ctx.queryOne<{
    id: string;
    user_id: string;
    expires_at: string;
    created_at: string;
    last_seen_at: string;
    revoked_at: string | null;
  }>(
    `SELECT id, user_id, expires_at, created_at, last_seen_at, revoked_at FROM sessions WHERE id = $1`,
    [sessionId]
  );
  if (!row) return null;
  return {
    id: toStr(row.id),
    userId: toStr(row.user_id),
    expiresAt: toStr(row.expires_at),
    createdAt: toStr(row.created_at),
    lastSeenAt: toStr(row.last_seen_at),
    revokedAt: row.revoked_at ? toStr(row.revoked_at) : null
  };
}

export async function saveSession(ctx: PgContext, input: {
  id: string;
  userId: string;
  expiresAt: string;
}): Promise<{
  id: string;
  userId: string;
  expiresAt: string;
  createdAt: string;
  lastSeenAt: string;
}> {
  const now = new Date().toISOString();
  await withReferenceCheck(() => ctx.execute(
    `INSERT INTO sessions (id, user_id, expires_at, created_at, last_seen_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, NULL)`,
    [input.id, input.userId, input.expiresAt, now, now]
  ));
  return { id: input.id, userId: input.userId, expiresAt: input.expiresAt, createdAt: now, lastSeenAt: now };
}

export async function touchSession(ctx: PgContext, sessionId: string): Promise<void> {
  await ctx.execute(
    `UPDATE sessions SET last_seen_at = $1 WHERE id = $2 AND revoked_at IS NULL`,
    [new Date().toISOString(), sessionId]
  );
}

export async function revokeSession(ctx: PgContext, sessionId: string): Promise<void> {
  await ctx.execute(
    `UPDATE sessions SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL`,
    [new Date().toISOString(), sessionId]
  );
}

export async function revokeExpiredSessions(ctx: PgContext): Promise<void> {
  const now = new Date().toISOString();
  await ctx.execute(
    `UPDATE sessions SET revoked_at = $1 WHERE revoked_at IS NULL AND expires_at <= $2`,
    [now, now]
  );
}

export async function loadSessionMemory(ctx: PgContext, namespace: string, sessionId: string): Promise<ChatMessage[]> {
  const row = await ctx.queryOne<{ messages_json: string }>(
    `SELECT messages_json FROM session_memory WHERE namespace = $1 AND session_id = $2`,
    [namespace, sessionId]
  );
  if (!row) return [];
  try {
    const parsed = JSON.parse(toStr(row.messages_json));
    return Array.isArray(parsed) ? (parsed as ChatMessage[]) : [];
  } catch {
    return [];
  }
}

/** Migration 37 — the labels stored with a session's memory; null when none were recorded. */
export async function loadSessionMemoryLabels(ctx: PgContext, namespace: string, sessionId: string): Promise<DataLabels | null> {
  const row = await ctx.queryOne<{ labels_json: string | null }>(
    `SELECT labels_json FROM session_memory WHERE namespace = $1 AND session_id = $2`,
    [namespace, sessionId]
  );
  return row ? parseStoredDataLabels(row.labels_json) : null;
}

/** Saves a session's memory; `labels` (Phase 16) only while the run tracks labels, merged with the stored ones; none keeps stored labels plus `untrusted_external`. */
export async function saveSessionMemory(ctx: PgContext, namespace: string, sessionId: string, messages: ChatMessage[], labels?: DataLabels): Promise<void> {
  const row = await ctx.queryOne<{ created_at: string; labels_json: string | null }>(
    `SELECT created_at, labels_json FROM session_memory WHERE namespace = $1 AND session_id = $2`,
    [namespace, sessionId]
  );
  const now = new Date().toISOString();
  const createdAt = row ? toStr(row.created_at) : now;
  if (labels) {
    const merged = mergeDataLabels([parseStoredDataLabels(row?.labels_json ?? null), labels].filter((entry): entry is DataLabels => Boolean(entry)));
    const labelsJson = merged && !isEmptyDataLabels(merged) ? JSON.stringify({ ...merged, source: "propagated" }) : row?.labels_json ?? null;
    await ctx.execute(
      `INSERT INTO session_memory (namespace, session_id, messages_json, labels_json, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (namespace, session_id) DO UPDATE SET
           messages_json = EXCLUDED.messages_json,
           labels_json = EXCLUDED.labels_json,
           updated_at = EXCLUDED.updated_at`,
      [namespace, sessionId, JSON.stringify(messages), labelsJson, createdAt, now]
    );
    return;
  }
  // An untracked save keeps the stored labels and adds `untrusted_external` (the old messages are still in memory).
  const kept = labelsForUntrackedSave(parseStoredDataLabels(row?.labels_json ?? null));
  await ctx.execute(
    `INSERT INTO session_memory (namespace, session_id, messages_json, labels_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (namespace, session_id) DO UPDATE SET
         messages_json = EXCLUDED.messages_json,
         labels_json = EXCLUDED.labels_json,
         updated_at = EXCLUDED.updated_at`,
    [namespace, sessionId, JSON.stringify(messages), kept ? JSON.stringify(kept) : null, createdAt, now]
  );
}

export async function saveSessionToolCall(ctx: PgContext, input: {
  namespace: string;
  sessionId: string;
  toolName: string;
  toolCallId?: string;
  args: Record<string, unknown>;
  output: unknown;
  error?: string;
  summary?: unknown;
  labels?: DataLabels;
}): Promise<{
  id: string;
  namespace: string;
  sessionId: string;
  toolName: string;
  toolCallId?: string;
  args: Record<string, unknown>;
  output: unknown;
  error?: string;
  summary?: unknown;
  createdAt: string;
}> {
  const now = new Date().toISOString();
  const id = randomUUID();
  // Calls saved within one millisecond keep their order: the cap and the newest-first lists below break created_at
  // ties by `seq` (v40's identity column, SQLite's rowid).
  const inserted = await ctx.query<{ created_at: string }>(
    `INSERT INTO session_tool_cache (id, namespace, session_id, tool_name, tool_call_id, args_json, output_json, error, summary_json, labels_json, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING created_at`,
    [
      id,
      input.namespace,
      input.sessionId,
      input.toolName,
      input.toolCallId ?? null,
      JSON.stringify(input.args ?? {}),
      JSON.stringify(input.output ?? null),
      input.error ?? null,
      input.summary === undefined ? null : JSON.stringify(input.summary),
      input.labels && !isEmptyDataLabels(input.labels) ? JSON.stringify(input.labels) : null,
      now
    ]
  );
  const createdAt = inserted[0] ? toStr(inserted[0].created_at) : now;

  // Prune old records
  await ctx.execute(
    `DELETE FROM session_tool_cache
       WHERE namespace = $1 AND session_id = $2
         AND id NOT IN (
           SELECT id FROM session_tool_cache
           WHERE namespace = $1 AND session_id = $2
           ORDER BY created_at DESC, seq DESC
           LIMIT $3
         )`,
    [input.namespace, input.sessionId, MAX_SESSION_TOOL_CACHE_RECORDS]
  );

  return {
    id,
    namespace: input.namespace,
    sessionId: input.sessionId,
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    args: input.args ?? {},
    output: input.output ?? null,
    error: input.error,
    summary: input.summary,
    ...(input.labels && !isEmptyDataLabels(input.labels) ? { labels: input.labels } : {}),
    createdAt
  };
}

export async function listSessionToolCalls(ctx: PgContext, input: {
  namespace: string;
  sessionId: string;
  toolName?: string;
  limit?: number;
}): Promise<Array<{
  id: string;
  namespace: string;
  sessionId: string;
  toolName: string;
  toolCallId?: string;
  args: Record<string, unknown>;
  error?: string;
  summary?: unknown;
  createdAt: string;
}>> {
  const limit =
    typeof input.limit === "number" && Number.isFinite(input.limit) && input.limit > 0
      ? Math.min(Math.floor(input.limit), 200)
      : 20;

  let rows: Array<{
    id: string;
    namespace: string;
    session_id: string;
    tool_name: string;
    tool_call_id: string | null;
    args_json: string;
    error: string | null;
    summary_json: string | null;
    labels_json: string | null;
    created_at: string;
  }>;

  if (input.toolName) {
    rows = await ctx.query(
      `SELECT id, namespace, session_id, tool_name, tool_call_id, args_json, error, summary_json, labels_json, created_at
         FROM session_tool_cache
         WHERE namespace = $1 AND session_id = $2 AND tool_name = $3
         ORDER BY created_at DESC, seq DESC LIMIT $4`,
      [input.namespace, input.sessionId, input.toolName, limit]
    );
  } else {
    rows = await ctx.query(
      `SELECT id, namespace, session_id, tool_name, tool_call_id, args_json, error, summary_json, labels_json, created_at
         FROM session_tool_cache
         WHERE namespace = $1 AND session_id = $2
         ORDER BY created_at DESC, seq DESC LIMIT $3`,
      [input.namespace, input.sessionId, limit]
    );
  }

  return rows.map((row) => {
    const argsParsed = parseJsonSafe(row.args_json);
    const args =
      argsParsed && typeof argsParsed === "object" && !Array.isArray(argsParsed)
        ? (argsParsed as Record<string, unknown>)
        : {};
    return {
      id: toStr(row.id),
      namespace: toStr(row.namespace),
      sessionId: toStr(row.session_id),
      toolName: toStr(row.tool_name),
      toolCallId: row.tool_call_id ? toStr(row.tool_call_id) : undefined,
      args,
      error: row.error ? toStr(row.error) : undefined,
      summary: row.summary_json ? parseJsonSafe(row.summary_json) : undefined,
      ...labelsField(row.labels_json),
      createdAt: toStr(row.created_at)
    };
  });
}

export async function getSessionToolCall(ctx: PgContext, input: {
  namespace: string;
  sessionId: string;
  id: string;
}): Promise<{
  id: string;
  namespace: string;
  sessionId: string;
  toolName: string;
  toolCallId?: string;
  args: Record<string, unknown>;
  output: unknown;
  error?: string;
  summary?: unknown;
  createdAt: string;
} | null> {
  const row = await ctx.queryOne<{
    id: string;
    namespace: string;
    session_id: string;
    tool_name: string;
    tool_call_id: string | null;
    args_json: string;
    output_json: string;
    error: string | null;
    summary_json: string | null;
    labels_json: string | null;
    created_at: string;
  }>(
    `SELECT id, namespace, session_id, tool_name, tool_call_id, args_json, output_json, error, summary_json, labels_json, created_at
       FROM session_tool_cache
       WHERE namespace = $1 AND session_id = $2 AND id = $3`,
    [input.namespace, input.sessionId, input.id]
  );
  if (!row) return null;

  const argsParsed = parseJsonSafe(row.args_json);
  const args =
    argsParsed && typeof argsParsed === "object" && !Array.isArray(argsParsed)
      ? (argsParsed as Record<string, unknown>)
      : {};

  return {
    id: toStr(row.id),
    namespace: toStr(row.namespace),
    sessionId: toStr(row.session_id),
    toolName: toStr(row.tool_name),
    toolCallId: row.tool_call_id ? toStr(row.tool_call_id) : undefined,
    args,
    output: parseJsonSafe(row.output_json),
    error: row.error ? toStr(row.error) : undefined,
    summary: row.summary_json ? parseJsonSafe(row.summary_json) : undefined,
    ...labelsField(row.labels_json),
    createdAt: toStr(row.created_at)
  };
}

/** Saves a session artifact; `labels` (Phase 16) only while the run tracks labels, replacing the stored ones (none keeps stored labels plus `untrusted_external`). */
export async function saveSessionArtifact(ctx: PgContext, input: {
  namespace: string;
  sessionId: string;
  artifactKey: string;
  value: unknown;
  labels?: DataLabels;
}): Promise<{
  namespace: string;
  sessionId: string;
  artifactKey: string;
  value: unknown;
  labels?: DataLabels | null;
  createdAt: string;
  updatedAt: string;
}> {
  const existing = await ctx.queryOne<{ created_at: string; labels_json: string | null }>(
    `SELECT created_at, labels_json
       FROM session_artifacts
       WHERE namespace = $1 AND session_id = $2 AND artifact_key = $3`,
    [input.namespace, input.sessionId, input.artifactKey]
  );
  const now = new Date().toISOString();
  const createdAt = existing ? toStr(existing.created_at) : now;

  // A tracked save replaces the labels; an untracked one (none given) keeps the stored labels plus `untrusted_external`.
  const labels = input.labels === undefined ? labelsForUntrackedSave(parseStoredDataLabels(existing?.labels_json ?? null)) ?? undefined : !isEmptyDataLabels(input.labels) ? input.labels : undefined;
  await ctx.execute(
    `INSERT INTO session_artifacts (namespace, session_id, artifact_key, value_json, labels_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (namespace, session_id, artifact_key) DO UPDATE SET
         value_json = EXCLUDED.value_json,
         labels_json = EXCLUDED.labels_json,
         updated_at = EXCLUDED.updated_at`,
    [input.namespace, input.sessionId, input.artifactKey, JSON.stringify(input.value ?? null), labels ? JSON.stringify({ ...labels, source: "propagated" }) : null, createdAt, now]
  );

  return {
    namespace: input.namespace,
    sessionId: input.sessionId,
    artifactKey: input.artifactKey,
    value: input.value ?? null,
    ...(labels ? { labels } : {}),
    createdAt,
    updatedAt: now
  };
}

export async function loadSessionArtifact(ctx: PgContext, input: {
  namespace: string;
  sessionId: string;
  artifactKey: string;
}): Promise<{
  namespace: string;
  sessionId: string;
  artifactKey: string;
  value: unknown;
  labels?: DataLabels | null;
  createdAt: string;
  updatedAt: string;
} | null> {
  const row = await ctx.queryOne<{
    namespace: string;
    session_id: string;
    artifact_key: string;
    value_json: string;
    labels_json: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT namespace, session_id, artifact_key, value_json, labels_json, created_at, updated_at
       FROM session_artifacts
       WHERE namespace = $1 AND session_id = $2 AND artifact_key = $3`,
    [input.namespace, input.sessionId, input.artifactKey]
  );

  if (!row) {
    return null;
  }

  return {
    namespace: toStr(row.namespace),
    sessionId: toStr(row.session_id),
    artifactKey: toStr(row.artifact_key),
    value: parseJsonSafe(row.value_json),
    ...labelsField(row.labels_json),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at)
  };
}
