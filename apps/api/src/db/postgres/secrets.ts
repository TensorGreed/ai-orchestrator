/**
 * Phase 13.1 — PostgresStore: Secrets, external secret providers and secret shares.
 * Plain functions over a PgContext; PostgresStore delegates here. Every method is implemented, so
 * UNIMPLEMENTED_METHODS is empty.
 */
import { DEFAULT_PROJECT_ID } from "@ai-orchestrator/shared";
import { type Store } from "../store.js";
import { toNum, toStr } from "./helpers.js";
import type { PgContext } from "./context.js";

export const UNIMPLEMENTED_METHODS: readonly (keyof Store)[] = [];

interface SecretDbRow {
  id: string;
  name: string;
  provider: string;
  iv: string;
  auth_tag: string;
  ciphertext: string;
  created_at: string;
  project_id: string | null;
  source: string | null;
  external_provider_id: string | null;
  external_key: string | null;
}

const nullableStr = (value: unknown): string | null => (value ? toStr(value) : null);

/** SQLite's parseJsonObject: a stored JSON object, anything else reads as {}. */
function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(typeof raw === "string" ? raw : String(raw));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // not JSON: empty
  }
  return {};
}

export async function listSecrets(
  ctx: PgContext,
  options: { projectId?: string } = {}
): ReturnType<Store["listSecrets"]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.projectId) {
    params.push(DEFAULT_PROJECT_ID, options.projectId);
    clauses.push(`COALESCE(project_id, $${params.length - 1}) = $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = await ctx.query<SecretDbRow>(
    `SELECT id, name, provider, created_at, project_id, source, external_provider_id, external_key
       FROM secrets ${where} ORDER BY created_at DESC`,
    params
  );
  return rows.map((row) => ({
    id: toStr(row.id),
    name: toStr(row.name),
    provider: toStr(row.provider),
    created_at: toStr(row.created_at),
    projectId: row.project_id ? toStr(row.project_id) : DEFAULT_PROJECT_ID,
    source: row.source === "external" ? ("external" as const) : ("local" as const),
    externalProviderId: nullableStr(row.external_provider_id),
    externalKey: nullableStr(row.external_key)
  }));
}

export async function getSecret(ctx: PgContext, id: string): ReturnType<Store["getSecret"]> {
  const row = await ctx.queryOne<SecretDbRow>(
    `SELECT id, name, provider, iv, auth_tag, ciphertext, created_at, project_id, source, external_provider_id, external_key
       FROM secrets WHERE id = $1`,
    [id]
  );
  if (!row) return null;
  const projectId = row.project_id ? toStr(row.project_id) : DEFAULT_PROJECT_ID;
  return {
    id: toStr(row.id),
    name: toStr(row.name),
    provider: toStr(row.provider),
    iv: toStr(row.iv),
    auth_tag: toStr(row.auth_tag),
    ciphertext: toStr(row.ciphertext),
    created_at: toStr(row.created_at),
    project_id: projectId,
    projectId,
    source: row.source === "external" ? "external" : "local",
    externalProviderId: nullableStr(row.external_provider_id),
    externalKey: nullableStr(row.external_key)
  };
}

export async function saveSecret(ctx: PgContext, input: Parameters<Store["saveSecret"]>[0]): Promise<void> {
  await ctx.execute(
    `INSERT INTO secrets (id, name, provider, iv, auth_tag, ciphertext, created_at, project_id, source, external_provider_id, external_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         provider = EXCLUDED.provider,
         iv = EXCLUDED.iv,
         auth_tag = EXCLUDED.auth_tag,
         ciphertext = EXCLUDED.ciphertext,
         project_id = EXCLUDED.project_id,
         source = EXCLUDED.source,
         external_provider_id = EXCLUDED.external_provider_id,
         external_key = EXCLUDED.external_key`,
    [
      input.id,
      input.name,
      input.provider,
      input.iv,
      input.authTag,
      input.ciphertext,
      new Date().toISOString(),
      input.projectId ?? DEFAULT_PROJECT_ID,
      input.source ?? "local",
      input.externalProviderId ?? null,
      input.externalKey ?? null
    ]
  );
}

/** Removes the secret with its shares and its external cache entry, in one transaction. */
export async function deleteSecret(ctx: PgContext, id: string): ReturnType<Store["deleteSecret"]> {
  return ctx.withTransaction(async (client) => {
    const result = await client.query(`DELETE FROM secrets WHERE id = $1`, [id]);
    if ((result.rowCount ?? 0) === 0) return false;
    await client.query(`DELETE FROM secret_shares WHERE secret_id = $1`, [id]);
    await client.query(`DELETE FROM external_secret_cache WHERE secret_id = $1`, [id]);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Secret shares
// ---------------------------------------------------------------------------

export async function listSecretShares(ctx: PgContext, secretId: string): ReturnType<Store["listSecretShares"]> {
  // SQLite reads these through the (secret_id, project_id) primary key, so in project id order.
  const rows = await ctx.query<{ secret_id: string; project_id: string; shared_by: string | null; created_at: string }>(
    `SELECT secret_id, project_id, shared_by, created_at FROM secret_shares WHERE secret_id = $1 ORDER BY project_id COLLATE "C"`,
    [secretId]
  );
  return rows.map((row) => ({
    secretId: toStr(row.secret_id),
    projectId: toStr(row.project_id),
    sharedBy: nullableStr(row.shared_by),
    createdAt: toStr(row.created_at)
  }));
}

export async function listSecretsSharedToProject(ctx: PgContext, projectId: string): ReturnType<Store["listSecretsSharedToProject"]> {
  // SQLite reads these through its project_id index, so in insertion order: share time, then id.
  const rows = await ctx.query<{ secret_id: string }>(
    `SELECT secret_id FROM secret_shares WHERE project_id = $1 ORDER BY created_at ASC, secret_id COLLATE "C"`,
    [projectId]
  );
  return rows.map((row) => toStr(row.secret_id));
}

export async function upsertSecretShare(ctx: PgContext, input: Parameters<Store["upsertSecretShare"]>[0]): ReturnType<Store["upsertSecretShare"]> {
  await ctx.execute(
    `INSERT INTO secret_shares (secret_id, project_id, shared_by, created_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (secret_id, project_id) DO NOTHING`,
    [input.secretId, input.projectId, input.sharedBy ?? null, new Date().toISOString()]
  );
}

export async function removeSecretShare(ctx: PgContext, secretId: string, projectId: string): ReturnType<Store["removeSecretShare"]> {
  const result = await ctx.pool.query(`DELETE FROM secret_shares WHERE secret_id = $1 AND project_id = $2`, [secretId, projectId]);
  return (result.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// External secret providers and their rotation cache
// ---------------------------------------------------------------------------

interface ExternalProviderRow {
  id: string;
  name: string;
  type: string;
  config_json: string;
  credentials_secret_id: string | null;
  cache_ttl_ms: number;
  enabled: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const PROVIDER_COLUMNS = `id, name, type, config_json, credentials_secret_id, cache_ttl_ms, enabled, created_by, created_at, updated_at`;

function mapProvider(row: ExternalProviderRow) {
  return {
    id: toStr(row.id),
    name: toStr(row.name),
    type: toStr(row.type),
    config: parseJsonObject(row.config_json),
    credentialsSecretId: nullableStr(row.credentials_secret_id),
    cacheTtlMs: toNum(row.cache_ttl_ms),
    enabled: toNum(row.enabled) === 1,
    createdBy: nullableStr(row.created_by),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at)
  };
}

export async function listExternalSecretProviders(ctx: PgContext): ReturnType<Store["listExternalSecretProviders"]> {
  const rows = await ctx.query<ExternalProviderRow>(`SELECT ${PROVIDER_COLUMNS} FROM external_secret_providers ORDER BY created_at DESC`);
  return rows.map(mapProvider);
}

export async function getExternalSecretProvider(ctx: PgContext, id: string): ReturnType<Store["getExternalSecretProvider"]> {
  const row = await ctx.queryOne<ExternalProviderRow>(`SELECT ${PROVIDER_COLUMNS} FROM external_secret_providers WHERE id = $1`, [id]);
  return row ? mapProvider(row) : null;
}

export async function upsertExternalSecretProvider(
  ctx: PgContext,
  input: Parameters<Store["upsertExternalSecretProvider"]>[0]
): ReturnType<Store["upsertExternalSecretProvider"]> {
  const now = new Date().toISOString();
  // created_by and created_at are kept on update, as in SQLite.
  await ctx.execute(
    `INSERT INTO external_secret_providers (${PROVIDER_COLUMNS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         type = EXCLUDED.type,
         config_json = EXCLUDED.config_json,
         credentials_secret_id = EXCLUDED.credentials_secret_id,
         cache_ttl_ms = EXCLUDED.cache_ttl_ms,
         enabled = EXCLUDED.enabled,
         updated_at = EXCLUDED.updated_at`,
    [
      input.id,
      input.name,
      input.type,
      JSON.stringify(input.config ?? {}),
      input.credentialsSecretId ?? null,
      input.cacheTtlMs ?? 300000,
      input.enabled === false ? 0 : 1,
      input.createdBy ?? null,
      now
    ]
  );
}

export async function deleteExternalSecretProvider(ctx: PgContext, id: string): ReturnType<Store["deleteExternalSecretProvider"]> {
  const result = await ctx.pool.query(`DELETE FROM external_secret_providers WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function countSecretsUsingExternalProvider(ctx: PgContext, providerId: string): ReturnType<Store["countSecretsUsingExternalProvider"]> {
  const row = await ctx.queryOne<{ count: string }>(`SELECT COUNT(*) AS count FROM secrets WHERE external_provider_id = $1`, [providerId]);
  return row ? toNum(row.count) : 0;
}

export async function getExternalSecretCacheEntry(ctx: PgContext, secretId: string): ReturnType<Store["getExternalSecretCacheEntry"]> {
  const row = await ctx.queryOne<{ secret_id: string; iv: string; auth_tag: string; ciphertext: string; fetched_at: string; expires_at: string }>(
    `SELECT secret_id, iv, auth_tag, ciphertext, fetched_at, expires_at FROM external_secret_cache WHERE secret_id = $1`,
    [secretId]
  );
  if (!row) return null;
  return {
    secretId: toStr(row.secret_id),
    iv: toStr(row.iv),
    authTag: toStr(row.auth_tag),
    ciphertext: toStr(row.ciphertext),
    fetchedAt: toStr(row.fetched_at),
    expiresAt: toStr(row.expires_at)
  };
}

export async function upsertExternalSecretCacheEntry(
  ctx: PgContext,
  input: Parameters<Store["upsertExternalSecretCacheEntry"]>[0]
): ReturnType<Store["upsertExternalSecretCacheEntry"]> {
  await ctx.execute(
    `INSERT INTO external_secret_cache (secret_id, iv, auth_tag, ciphertext, fetched_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (secret_id) DO UPDATE SET
         iv = EXCLUDED.iv,
         auth_tag = EXCLUDED.auth_tag,
         ciphertext = EXCLUDED.ciphertext,
         fetched_at = EXCLUDED.fetched_at,
         expires_at = EXCLUDED.expires_at`,
    [input.secretId, input.iv, input.authTag, input.ciphertext, new Date().toISOString(), input.expiresAt]
  );
}

export async function deleteExternalSecretCacheEntry(ctx: PgContext, secretId: string): ReturnType<Store["deleteExternalSecretCacheEntry"]> {
  await ctx.execute(`DELETE FROM external_secret_cache WHERE secret_id = $1`, [secretId]);
}
