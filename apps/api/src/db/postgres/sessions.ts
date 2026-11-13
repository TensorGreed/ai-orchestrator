/**
 * Phase 13.1 — PostgresStore: Login sessions, session memory, the session tool cache and session artifacts.
 * Plain functions over a PgContext; PostgresStore delegates here. Every method is implemented.
 */
import { randomUUID } from "node:crypto";
import { type ChatMessage, type DataLabels, isEmptyDataLabels, labelsForUntrackedSave, labelsMarkSensitive, mergeDataLabels, parseStoredDataLabels } from "@ai-orchestrator/shared";
import type { LoginSession, LoginSessionInput, SessionAuthMethod, SessionEndReason } from "../store.js";
import { parseJsonSafe, toStr, labelsField } from "./helpers.js";
import type { PgContext } from "./context.js";
import { LEGAL_HOLD_LOCK_SHARED_SQL, heldRowSql, mergeHeldMemory, notHeldSql } from "../legal-hold-sql.js";
import { withReferenceCheck } from "../store-errors.js";
import { sessionsToEvict } from "../session-eviction.js";

const MAX_SESSION_TOOL_CACHE_RECORDS = 400;

interface SessionRow {
  id: string;
  user_id: string;
  expires_at: string;
  created_at: string;
  last_seen_at: string;
  revoked_at: string | null;
  auth_method: string | null;
  ip_address: string | null;
  user_agent: string | null;
  mfa_verified_at: string | null;
  break_glass: number | null;
  ended_reason: string | null;
}

const SESSION_COLUMNS =
  "id, user_id, expires_at, created_at, last_seen_at, revoked_at, auth_method, ip_address, user_agent, mfa_verified_at, break_glass, ended_reason";

function sessionFromRow(row: SessionRow): LoginSession {
  return {
    id: toStr(row.id),
    userId: toStr(row.user_id),
    expiresAt: toStr(row.expires_at),
    createdAt: toStr(row.created_at),
    lastSeenAt: toStr(row.last_seen_at),
    revokedAt: row.revoked_at ? toStr(row.revoked_at) : null,
    authMethod: row.auth_method ? (toStr(row.auth_method) as SessionAuthMethod) : null,
    ipAddress: row.ip_address ? toStr(row.ip_address) : null,
    userAgent: row.user_agent ? toStr(row.user_agent) : null,
    mfaVerifiedAt: row.mfa_verified_at ? toStr(row.mfa_verified_at) : null,
    breakGlass: Number(row.break_glass ?? 0) === 1,
    endedReason: row.ended_reason ? (toStr(row.ended_reason) as SessionEndReason) : null
  };
}

export async function getSession(ctx: PgContext, sessionId: string): Promise<LoginSession | null> {
  const row = await ctx.queryOne<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = $1`, [sessionId]);
  return row ? sessionFromRow(row) : null;
}

export async function saveSession(ctx: PgContext, input: LoginSessionInput): Promise<LoginSession> {
  const now = new Date().toISOString();
  const session: LoginSession = {
    id: input.id,
    userId: input.userId,
    expiresAt: input.expiresAt,
    createdAt: now,
    lastSeenAt: now,
    revokedAt: null,
    authMethod: input.authMethod ?? null,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    mfaVerifiedAt: input.mfaVerifiedAt ?? null,
    breakGlass: input.breakGlass === true,
    endedReason: null
  };
  await withReferenceCheck(() => ctx.execute(
    `INSERT INTO sessions (${SESSION_COLUMNS})
       VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, $9, $10, NULL)`,
    [
      session.id,
      session.userId,
      session.expiresAt,
      now,
      now,
      session.authMethod,
      session.ipAddress,
      session.userAgent,
      session.mfaVerifiedAt,
      session.breakGlass ? 1 : 0
    ]
  ));
  return session;
}

export async function touchSession(ctx: PgContext, sessionId: string): Promise<void> {
  await ctx.execute(
    `UPDATE sessions SET last_seen_at = $1 WHERE id = $2 AND revoked_at IS NULL`,
    [new Date().toISOString(), sessionId]
  );
}

export async function revokeSession(ctx: PgContext, sessionId: string, reason?: SessionEndReason): Promise<boolean> {
  const rows = await ctx.query<{ id: string }>(
    `UPDATE sessions SET revoked_at = $1, ip_address = NULL, user_agent = NULL, ended_reason = $2 WHERE id = $3 AND revoked_at IS NULL RETURNING id`,
    [new Date().toISOString(), reason ?? null, sessionId]
  );
  return rows.length > 0;
}

export async function revokeExpiredSessions(ctx: PgContext): Promise<void> {
  const now = new Date().toISOString();
  await ctx.execute(
    `UPDATE sessions SET revoked_at = $1, ip_address = NULL, user_agent = NULL, ended_reason = 'expired' WHERE revoked_at IS NULL AND expires_at <= $2`,
    [now, now]
  );
}

export async function listUserSessions(
  ctx: PgContext,
  userId: string,
  options: { liveOnly?: boolean; now?: string } = {}
): Promise<LoginSession[]> {
  const live = options.liveOnly === true;
  const rows = await ctx.query<SessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM sessions
       WHERE user_id = $1${live ? " AND revoked_at IS NULL AND expires_at > $2" : ""}
       ORDER BY created_at DESC, id DESC`,
    live ? [userId, options.now ?? new Date().toISOString()] : [userId]
  );
  return rows.map(sessionFromRow);
}

export async function revokeUserSessions(
  ctx: PgContext,
  userId: string,
  options: { exceptId?: string; reason: SessionEndReason }
): Promise<number> {
  const rows = await ctx.query<{ id: string }>(
    `UPDATE sessions SET revoked_at = $1, ip_address = NULL, user_agent = NULL, ended_reason = $2
       WHERE user_id = $3 AND revoked_at IS NULL AND id <> $4
       RETURNING id`,
    [new Date().toISOString(), options.reason, userId, options.exceptId ?? ""]
  );
  return rows.length;
}

export async function markSessionMfaVerified(ctx: PgContext, sessionId: string, input: { userId: string; at: string }): Promise<boolean> {
  const rows = await ctx.query<{ id: string }>(
    `UPDATE sessions SET mfa_verified_at = $1
       WHERE id = $2 AND user_id = $3 AND revoked_at IS NULL AND expires_at > $4
       RETURNING id`,
    [input.at, sessionId, input.userId, new Date().toISOString()]
  );
  return rows.length > 0;
}

export async function clearSessionMfaVerified(ctx: PgContext, sessionId: string): Promise<boolean> {
  const rows = await ctx.query<{ id: string }>(`UPDATE sessions SET mfa_verified_at = NULL WHERE id = $1 RETURNING id`, [sessionId]);
  return rows.length > 0;
}

export async function purgeEndedSessions(ctx: PgContext, before: string): Promise<number> {
  const rows = await ctx.query<{ id: string }>(
    `DELETE FROM sessions WHERE (revoked_at IS NOT NULL AND revoked_at < $1) OR expires_at < $1 RETURNING id`,
    [before]
  );
  return rows.length;
}

/**
 * Keeps the user's `keep` newest live sessions (never ending `protectId`) and ends the rest. The user row is locked
 * for the transaction, so two instances signing the same user in at once take turns: the second sees the first's
 * session and its evictions.
 */
export async function revokeOldestUserSessions(
  ctx: PgContext,
  userId: string,
  keep: number,
  reason: SessionEndReason,
  options: { protectId?: string } = {}
): Promise<string[]> {
  const kept = Math.max(0, Math.floor(keep));
  return ctx.withTransaction(async (client) => {
    await client.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [userId]);
    const now = new Date().toISOString();
    const live = await client.query<{ id: string }>(
      `SELECT id FROM sessions
         WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > $2 AND break_glass = 0
         ORDER BY created_at DESC, id DESC`,
      [userId, now]
    );
    const ended = sessionsToEvict(live.rows.map((row) => toStr(row.id)), kept, options.protectId);
    if (ended.length > 0) {
      await client.query(
        `UPDATE sessions SET revoked_at = $1, ip_address = NULL, user_agent = NULL, ended_reason = $2
           WHERE id = ANY($3::text[]) AND revoked_at IS NULL`,
        [now, reason, ended]
      );
    }
    return ended;
  });
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

/** v74 — the messages and loadSessionMemorySensitive's answer, from one SELECT. */
export async function loadSessionMemoryMarked(ctx: PgContext, namespace: string, sessionId: string): Promise<{ messages: ChatMessage[]; sensitive: boolean }> {
  const row = await ctx.queryOne<{ messages_json: string; sensitive: number | string | null; labels_json: string | null }>(
    `SELECT messages_json, sensitive, labels_json FROM session_memory WHERE namespace = $1 AND session_id = $2`,
    [namespace, sessionId]
  );
  if (!row) return { messages: [], sensitive: false };
  let messages: ChatMessage[] = [];
  try {
    const parsed = JSON.parse(toStr(row.messages_json));
    if (Array.isArray(parsed)) messages = parsed as ChatMessage[];
  } catch {
    messages = [];
  }
  return { messages, sensitive: Number(row.sensitive ?? 0) === 1 || labelsMarkSensitive(parseStoredDataLabels(row.labels_json)) };
}

/** v73 — the memory was written by sensitive work, or its stored labels say sensitive. False when there is none. */
export async function loadSessionMemorySensitive(ctx: PgContext, namespace: string, sessionId: string): Promise<boolean> {
  const row = await ctx.queryOne<{ sensitive: number | string | null; labels_json: string | null }>(
    `SELECT sensitive, labels_json FROM session_memory WHERE namespace = $1 AND session_id = $2`,
    [namespace, sessionId]
  );
  return row ? Number(row.sensitive ?? 0) === 1 || labelsMarkSensitive(parseStoredDataLabels(row.labels_json)) : false;
}

/** v73 — `{ sensitive: true }` for a row written by sensitive work, else nothing. */
function sensitiveField(value: unknown): { sensitive?: true } {
  return Number(value ?? 0) === 1 ? { sensitive: true } : {};
}

/**
 * Saves a session's memory; `labels` (Phase 16) only while the run tracks labels, merged with the stored ones; none
 * keeps stored labels plus `untrusted_external`. 13.3 — under a legal hold the stored history only grows: the read,
 * the hold check and the write share a transaction under the legal-hold lock. `options.sensitive` (v73) marks the row
 * as written by sensitive work; a marked row stays marked.
 */
export async function saveSessionMemory(ctx: PgContext, namespace: string, sessionId: string, messages: ChatMessage[], labels?: DataLabels, options?: { sensitive?: boolean }): Promise<void> {
  await ctx.withTransaction(async (client) => {
    await client.query(LEGAL_HOLD_LOCK_SHARED_SQL);
    const row = (
      await client.query<{ created_at: string; labels_json: string | null; messages_json: string; held: boolean }>(
        `SELECT created_at, labels_json, messages_json, ${heldRowSql("session_memory")} AS held
           FROM session_memory WHERE namespace = $1 AND session_id = $2 FOR UPDATE`,
        [namespace, sessionId]
      )
    ).rows[0];
    const now = new Date().toISOString();
    const createdAt = row ? toStr(row.created_at) : now;
    const stored = row?.held ? parseJsonSafe(row.messages_json) : null;
    const toStore = row?.held ? mergeHeldMemory(Array.isArray(stored) ? (stored as ChatMessage[]) : [], messages) : messages;
    let labelsJson: string | null;
    if (labels) {
      const merged = mergeDataLabels([parseStoredDataLabels(row?.labels_json ?? null), labels].filter((entry): entry is DataLabels => Boolean(entry)));
      labelsJson = merged && !isEmptyDataLabels(merged) ? JSON.stringify({ ...merged, source: "propagated" }) : row?.labels_json ?? null;
    } else {
      // An untracked save keeps the stored labels and adds `untrusted_external` (the old messages are still in memory).
      const kept = labelsForUntrackedSave(parseStoredDataLabels(row?.labels_json ?? null));
      labelsJson = kept ? JSON.stringify(kept) : null;
    }
    await client.query(
      `INSERT INTO session_memory (namespace, session_id, messages_json, labels_json, sensitive, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (namespace, session_id) DO UPDATE SET
           messages_json = EXCLUDED.messages_json,
           labels_json = EXCLUDED.labels_json,
           sensitive = CASE WHEN session_memory.sensitive = 1 OR EXCLUDED.sensitive = 1 THEN 1 ELSE 0 END,
           updated_at = EXCLUDED.updated_at`,
      [namespace, sessionId, JSON.stringify(toStore), labelsJson, options?.sensitive === true ? 1 : 0, createdAt, now]
    );
  });
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
  /** v73 — written by sensitive work. */
  sensitive?: boolean;
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
  sensitive?: boolean;
  createdAt: string;
}> {
  const now = new Date().toISOString();
  const id = randomUUID();
  // Calls saved within one millisecond keep their order: the cap and the newest-first lists below break created_at
  // ties by `seq` (v40's identity column, SQLite's rowid).
  const inserted = await ctx.query<{ created_at: string }>(
    `INSERT INTO session_tool_cache (id, namespace, session_id, tool_name, tool_call_id, args_json, output_json, error, summary_json, labels_json, sensitive, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
      input.sensitive === true ? 1 : 0,
      now
    ]
  );
  const createdAt = inserted[0] ? toStr(inserted[0].created_at) : now;

  // Prune old records, never a held one (13.3: under the legal-hold lock, so a hold placed meanwhile binds it).
  await ctx.withTransaction(async (client) => {
    await client.query(LEGAL_HOLD_LOCK_SHARED_SQL);
    await client.query(
    `DELETE FROM session_tool_cache
       WHERE namespace = $1 AND session_id = $2
         AND id NOT IN (
           SELECT id FROM session_tool_cache
           WHERE namespace = $1 AND session_id = $2
           ORDER BY created_at DESC, seq DESC
           LIMIT $3
         )
         AND ${notHeldSql("session_tool_cache")}`,
      [input.namespace, input.sessionId, MAX_SESSION_TOOL_CACHE_RECORDS]
    );
  });

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
    ...(input.sensitive === true ? { sensitive: true } : {}),
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
  sensitive?: boolean;
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
    sensitive: number | string | null;
    created_at: string;
  }>;

  if (input.toolName) {
    rows = await ctx.query(
      `SELECT id, namespace, session_id, tool_name, tool_call_id, args_json, error, summary_json, labels_json, sensitive, created_at
         FROM session_tool_cache
         WHERE namespace = $1 AND session_id = $2 AND tool_name = $3
         ORDER BY created_at DESC, seq DESC LIMIT $4`,
      [input.namespace, input.sessionId, input.toolName, limit]
    );
  } else {
    rows = await ctx.query(
      `SELECT id, namespace, session_id, tool_name, tool_call_id, args_json, error, summary_json, labels_json, sensitive, created_at
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
      ...sensitiveField(row.sensitive),
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
  sensitive?: boolean;
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
    sensitive: number | string | null;
    created_at: string;
  }>(
    `SELECT id, namespace, session_id, tool_name, tool_call_id, args_json, output_json, error, summary_json, labels_json, sensitive, created_at
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
    ...sensitiveField(row.sensitive),
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
  /** v73 — written by sensitive work; a marked row stays marked. */
  sensitive?: boolean;
}): Promise<{
  namespace: string;
  sessionId: string;
  artifactKey: string;
  value: unknown;
  labels?: DataLabels | null;
  sensitive?: boolean;
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
  // v73 — a marked artifact stays marked: the new value may carry the old one forward.
  const saved = await ctx.query<{ sensitive: number | string | null }>(
    `INSERT INTO session_artifacts (namespace, session_id, artifact_key, value_json, labels_json, sensitive, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (namespace, session_id, artifact_key) DO UPDATE SET
         value_json = EXCLUDED.value_json,
         labels_json = EXCLUDED.labels_json,
         sensitive = CASE WHEN session_artifacts.sensitive = 1 OR EXCLUDED.sensitive = 1 THEN 1 ELSE 0 END,
         updated_at = EXCLUDED.updated_at
       RETURNING sensitive`,
    [
      input.namespace,
      input.sessionId,
      input.artifactKey,
      JSON.stringify(input.value ?? null),
      labels ? JSON.stringify({ ...labels, source: "propagated" }) : null,
      input.sensitive === true ? 1 : 0,
      createdAt,
      now
    ]
  );

  return {
    namespace: input.namespace,
    sessionId: input.sessionId,
    artifactKey: input.artifactKey,
    value: input.value ?? null,
    ...(labels ? { labels } : {}),
    ...sensitiveField(saved[0]?.sensitive),
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
  sensitive?: boolean;
  createdAt: string;
  updatedAt: string;
} | null> {
  const row = await ctx.queryOne<{
    namespace: string;
    session_id: string;
    artifact_key: string;
    value_json: string;
    labels_json: string | null;
    sensitive: number | string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT namespace, session_id, artifact_key, value_json, labels_json, sensitive, created_at, updated_at
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
    ...sensitiveField(row.sensitive),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at)
  };
}
