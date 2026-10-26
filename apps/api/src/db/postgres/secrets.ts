/**
 * Phase 13.1 — PostgresStore: Secrets, external secret providers and secret shares.
 * Plain functions over a PgContext; PostgresStore delegates here. Methods that are not implemented yet throw
 * StoreNotImplementedError and are listed in UNIMPLEMENTED_METHODS (remove both together when implementing one).
 */
import { DEFAULT_PROJECT_ID } from "@ai-orchestrator/shared";
import { StoreNotImplementedError } from "../store-errors.js";
import { type Store } from "../store.js";
import { toStr } from "./helpers.js";
import type { PgContext } from "./context.js";

export const UNIMPLEMENTED_METHODS: readonly (keyof Store)[] = [
  "listSecretShares",
  "listSecretsSharedToProject",
  "upsertSecretShare",
  "removeSecretShare",
  "deleteSecret",
  "listExternalSecretProviders",
  "getExternalSecretProvider",
  "upsertExternalSecretProvider",
  "deleteExternalSecretProvider",
  "countSecretsUsingExternalProvider",
  "getExternalSecretCacheEntry",
  "upsertExternalSecretCacheEntry",
  "deleteExternalSecretCacheEntry"
];

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
  const rows = await ctx.query<{
    id: string;
    name: string;
    provider: string;
    created_at: string;
    project_id: string | null;
  }>(
    `SELECT id, name, provider, created_at, project_id FROM secrets ${where} ORDER BY created_at DESC`,
    params
  );
  return rows.map((row) => ({
    id: toStr(row.id),
    name: toStr(row.name),
    provider: toStr(row.provider),
    created_at: toStr(row.created_at),
    projectId: row.project_id ? toStr(row.project_id) : DEFAULT_PROJECT_ID,
    // External secret providers are SQLite only in this release: every Postgres secret is a local one.
    source: "local" as const,
    externalProviderId: null,
    externalKey: null
  }));
}

export async function getSecret(ctx: PgContext, id: string): ReturnType<Store["getSecret"]> {
  const row = await ctx.queryOne<{
    id: string;
    name: string;
    provider: string;
    iv: string;
    auth_tag: string;
    ciphertext: string;
    created_at: string;
    project_id: string | null;
  }>(
    `SELECT id, name, provider, iv, auth_tag, ciphertext, created_at, project_id FROM secrets WHERE id = $1`,
    [id]
  );
  if (!row) return null;
  return {
    id: toStr(row.id),
    name: toStr(row.name),
    provider: toStr(row.provider),
    iv: toStr(row.iv),
    auth_tag: toStr(row.auth_tag),
    ciphertext: toStr(row.ciphertext),
    created_at: toStr(row.created_at),
    projectId: row.project_id ? toStr(row.project_id) : DEFAULT_PROJECT_ID,
    source: "local",
    externalProviderId: null,
    externalKey: null
  };
}

export async function saveSecret(ctx: PgContext, input: {
  id: string;
  name: string;
  provider: string;
  iv: string;
  authTag: string;
  ciphertext: string;
  projectId?: string;
}): Promise<void> {
  await ctx.execute(
    `INSERT INTO secrets (id, name, provider, iv, auth_tag, ciphertext, created_at, project_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         provider = EXCLUDED.provider,
         iv = EXCLUDED.iv,
         auth_tag = EXCLUDED.auth_tag,
         ciphertext = EXCLUDED.ciphertext,
         project_id = EXCLUDED.project_id`,
    [
      input.id,
      input.name,
      input.provider,
      input.iv,
      input.authTag,
      input.ciphertext,
      new Date().toISOString(),
      input.projectId ?? DEFAULT_PROJECT_ID
    ]
  );
}

export async function listSecretShares(_ctx: PgContext, ..._args: Parameters<Store["listSecretShares"]>): ReturnType<Store["listSecretShares"]> {
  throw new StoreNotImplementedError("listSecretShares");
}

export async function listSecretsSharedToProject(_ctx: PgContext, ..._args: Parameters<Store["listSecretsSharedToProject"]>): ReturnType<Store["listSecretsSharedToProject"]> {
  throw new StoreNotImplementedError("listSecretsSharedToProject");
}

export async function upsertSecretShare(_ctx: PgContext, ..._args: Parameters<Store["upsertSecretShare"]>): ReturnType<Store["upsertSecretShare"]> {
  throw new StoreNotImplementedError("upsertSecretShare");
}

export async function removeSecretShare(_ctx: PgContext, ..._args: Parameters<Store["removeSecretShare"]>): ReturnType<Store["removeSecretShare"]> {
  throw new StoreNotImplementedError("removeSecretShare");
}

export async function deleteSecret(_ctx: PgContext, ..._args: Parameters<Store["deleteSecret"]>): ReturnType<Store["deleteSecret"]> {
  throw new StoreNotImplementedError("deleteSecret");
}

export async function listExternalSecretProviders(_ctx: PgContext, ..._args: Parameters<Store["listExternalSecretProviders"]>): ReturnType<Store["listExternalSecretProviders"]> {
  throw new StoreNotImplementedError("listExternalSecretProviders");
}

export async function getExternalSecretProvider(_ctx: PgContext, ..._args: Parameters<Store["getExternalSecretProvider"]>): ReturnType<Store["getExternalSecretProvider"]> {
  throw new StoreNotImplementedError("getExternalSecretProvider");
}

export async function upsertExternalSecretProvider(_ctx: PgContext, ..._args: Parameters<Store["upsertExternalSecretProvider"]>): ReturnType<Store["upsertExternalSecretProvider"]> {
  throw new StoreNotImplementedError("upsertExternalSecretProvider");
}

export async function deleteExternalSecretProvider(_ctx: PgContext, ..._args: Parameters<Store["deleteExternalSecretProvider"]>): ReturnType<Store["deleteExternalSecretProvider"]> {
  throw new StoreNotImplementedError("deleteExternalSecretProvider");
}

export async function countSecretsUsingExternalProvider(_ctx: PgContext, ..._args: Parameters<Store["countSecretsUsingExternalProvider"]>): ReturnType<Store["countSecretsUsingExternalProvider"]> {
  throw new StoreNotImplementedError("countSecretsUsingExternalProvider");
}

export async function getExternalSecretCacheEntry(_ctx: PgContext, ..._args: Parameters<Store["getExternalSecretCacheEntry"]>): ReturnType<Store["getExternalSecretCacheEntry"]> {
  throw new StoreNotImplementedError("getExternalSecretCacheEntry");
}

export async function upsertExternalSecretCacheEntry(_ctx: PgContext, ..._args: Parameters<Store["upsertExternalSecretCacheEntry"]>): ReturnType<Store["upsertExternalSecretCacheEntry"]> {
  throw new StoreNotImplementedError("upsertExternalSecretCacheEntry");
}

export async function deleteExternalSecretCacheEntry(_ctx: PgContext, ..._args: Parameters<Store["deleteExternalSecretCacheEntry"]>): ReturnType<Store["deleteExternalSecretCacheEntry"]> {
  throw new StoreNotImplementedError("deleteExternalSecretCacheEntry");
}
