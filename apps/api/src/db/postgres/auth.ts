/**
 * Phase 13.1 — PostgresStore: Users, RBAC, API keys, MFA and SSO identities.
 * Plain functions over a PgContext; PostgresStore delegates here. Every method is implemented, so
 * UNIMPLEMENTED_METHODS is empty.
 */
import { type Store } from "../store.js";
import { toNum, toStr } from "./helpers.js";
import type { PgContext } from "./context.js";

export const UNIMPLEMENTED_METHODS: readonly (keyof Store)[] = [];

export async function countUsers(ctx: PgContext): Promise<number> {
  const row = await ctx.queryOne<{ count: string }>(`SELECT COUNT(*) as count FROM users`);
  return row ? toNum(row.count) : 0;
}

export async function getUserByEmail(ctx: PgContext, email: string): Promise<{
  id: string;
  email: string;
  passwordHash: string;
  role: string;
  createdAt: string;
  updatedAt: string;
} | null> {
  const row = await ctx.queryOne<{
    id: string;
    email: string;
    password_hash: string;
    role: string;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, email, password_hash, role, created_at, updated_at FROM users WHERE lower(email) = lower($1)`,
    [email]
  );
  if (!row) return null;
  return {
    id: toStr(row.id),
    email: toStr(row.email),
    passwordHash: toStr(row.password_hash),
    role: toStr(row.role),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at)
  };
}

export async function getUserById(ctx: PgContext, id: string): Promise<{
  id: string;
  email: string;
  passwordHash: string;
  role: string;
  createdAt: string;
  updatedAt: string;
} | null> {
  const row = await ctx.queryOne<{
    id: string;
    email: string;
    password_hash: string;
    role: string;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, email, password_hash, role, created_at, updated_at FROM users WHERE id = $1`,
    [id]
  );
  if (!row) return null;
  return {
    id: toStr(row.id),
    email: toStr(row.email),
    passwordHash: toStr(row.password_hash),
    role: toStr(row.role),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at)
  };
}

export async function saveUser(ctx: PgContext, input: {
  id: string;
  email: string;
  passwordHash: string;
  role: string;
}): Promise<{
  id: string;
  email: string;
  role: string;
  createdAt: string;
  updatedAt: string;
}> {
  const now = new Date().toISOString();
  const existing = await ctx.store.getUserById(input.id);
  const createdAt = existing?.createdAt ?? now;
  await ctx.execute(
    `INSERT INTO users (id, email, password_hash, role, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         password_hash = EXCLUDED.password_hash,
         role = EXCLUDED.role,
         updated_at = EXCLUDED.updated_at`,
    [input.id, input.email.toLowerCase(), input.passwordHash, input.role, createdAt, now]
  );
  return { id: input.id, email: input.email.toLowerCase(), role: input.role, createdAt, updatedAt: now };
}

export async function listUsers(ctx: PgContext): Promise<Array<{
  id: string;
  email: string;
  role: string;
  createdAt: string;
  updatedAt: string;
}>> {
  const rows = await ctx.query<{
    id: string;
    email: string;
    role: string;
    created_at: string;
    updated_at: string;
  }>(`SELECT id, email, role, created_at, updated_at FROM users ORDER BY created_at DESC`);
  return rows.map((r: { id: string; email: string; role: string; created_at: string; updated_at: string }) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }));
}

export async function updateUserRole(ctx: PgContext, id: string, role: string): Promise<boolean> {
  const existing = await ctx.store.getUserById(id);
  if (!existing) return false;
  const now = new Date().toISOString();
  await ctx.execute(
    `UPDATE users SET role = $1, updated_at = $2 WHERE id = $3`,
    [role, now, id]
  );
  return true;
}

/**
 * Phase 13.1 — removes the user with its sessions, API keys, MFA secret, SSO identities and project roles in one
 * transaction (the api_keys / mfa_secrets / sso_identities / user_project_roles foreign keys would refuse otherwise).
 */
export async function deleteUser(ctx: PgContext, id: string): Promise<boolean> {
  return ctx.withTransaction(async (client) => {
    await client.query(`DELETE FROM sessions WHERE user_id = $1`, [id]);
    await client.query(`DELETE FROM api_keys WHERE user_id = $1`, [id]);
    await client.query(`DELETE FROM mfa_secrets WHERE user_id = $1`, [id]);
    await client.query(`DELETE FROM sso_identities WHERE user_id = $1`, [id]);
    await client.query(`DELETE FROM user_project_roles WHERE user_id = $1`, [id]);
    const result = await client.query(`DELETE FROM users WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  });
}

/** A stored JSON array of strings (SQLite's parseJsonArray): anything else reads as []. */
function parseJsonArray(raw: unknown): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(typeof raw === "string" ? raw : String(raw));
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    // not JSON: none
  }
  return [];
}

const nullableStr = (value: unknown): string | null => (value ? toStr(value) : null);

// ---------------------------------------------------------------------------
// Project-level roles
// ---------------------------------------------------------------------------

interface ProjectRoleRow {
  user_id: string;
  project_id: string;
  role: string;
  custom_role_id: string | null;
  created_at: string;
  updated_at: string;
}

function mapProjectRole(row: ProjectRoleRow) {
  return {
    userId: toStr(row.user_id),
    projectId: toStr(row.project_id),
    role: toStr(row.role),
    customRoleId: nullableStr(row.custom_role_id)
  };
}

export async function countProjectMemberships(ctx: PgContext): ReturnType<Store["countProjectMemberships"]> {
  const row = await ctx.queryOne<{ count: string }>(`SELECT COUNT(*) AS count FROM user_project_roles`);
  return row ? toNum(row.count) : 0;
}

export async function listProjectMembers(ctx: PgContext, projectId: string): ReturnType<Store["listProjectMembers"]> {
  const rows = await ctx.query<ProjectRoleRow>(
    `SELECT user_id, project_id, role, custom_role_id, created_at, updated_at
       FROM user_project_roles WHERE project_id = $1 ORDER BY created_at ASC`,
    [projectId]
  );
  return rows.map((row) => ({ ...mapProjectRole(row), createdAt: toStr(row.created_at), updatedAt: toStr(row.updated_at) }));
}

export async function listUserProjectRoles(ctx: PgContext, userId: string): ReturnType<Store["listUserProjectRoles"]> {
  // SQLite reads these through the (user_id, project_id) primary key, so in project id order.
  const rows = await ctx.query<ProjectRoleRow>(
    `SELECT user_id, project_id, role, custom_role_id
       FROM user_project_roles WHERE user_id = $1 ORDER BY project_id COLLATE "C"`,
    [userId]
  );
  return rows.map(mapProjectRole);
}

export async function getProjectRole(ctx: PgContext, userId: string, projectId: string): ReturnType<Store["getProjectRole"]> {
  const row = await ctx.queryOne<ProjectRoleRow>(
    `SELECT user_id, project_id, role, custom_role_id FROM user_project_roles WHERE user_id = $1 AND project_id = $2`,
    [userId, projectId]
  );
  return row ? mapProjectRole(row) : null;
}

export async function upsertProjectRole(ctx: PgContext, input: Parameters<Store["upsertProjectRole"]>[0]): ReturnType<Store["upsertProjectRole"]> {
  const now = new Date().toISOString();
  await ctx.execute(
    `INSERT INTO user_project_roles (user_id, project_id, role, custom_role_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT (user_id, project_id) DO UPDATE SET
         role = EXCLUDED.role,
         custom_role_id = EXCLUDED.custom_role_id,
         updated_at = EXCLUDED.updated_at`,
    [input.userId, input.projectId, input.role, input.customRoleId ?? null, now]
  );
}

export async function removeProjectRole(ctx: PgContext, userId: string, projectId: string): ReturnType<Store["removeProjectRole"]> {
  const result = await ctx.pool.query(`DELETE FROM user_project_roles WHERE user_id = $1 AND project_id = $2`, [userId, projectId]);
  return (result.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Custom roles
// ---------------------------------------------------------------------------

interface CustomRoleRow {
  id: string;
  project_id: string | null;
  name: string;
  description: string | null;
  permissions_json: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const CUSTOM_ROLE_COLUMNS = `id, project_id, name, description, permissions_json, created_by, created_at, updated_at`;

function mapCustomRole(row: CustomRoleRow) {
  return {
    id: toStr(row.id),
    projectId: nullableStr(row.project_id),
    name: toStr(row.name),
    description: nullableStr(row.description),
    permissions: parseJsonArray(row.permissions_json),
    createdBy: nullableStr(row.created_by),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at)
  };
}

export async function listCustomRoles(ctx: PgContext, projectId?: string | null): ReturnType<Store["listCustomRoles"]> {
  const rows =
    projectId === undefined
      ? await ctx.query<CustomRoleRow>(`SELECT ${CUSTOM_ROLE_COLUMNS} FROM custom_roles ORDER BY name COLLATE "C" ASC`)
      : projectId === null
        ? await ctx.query<CustomRoleRow>(
            `SELECT ${CUSTOM_ROLE_COLUMNS} FROM custom_roles WHERE project_id IS NULL ORDER BY name COLLATE "C" ASC`
          )
        : await ctx.query<CustomRoleRow>(
            `SELECT ${CUSTOM_ROLE_COLUMNS} FROM custom_roles WHERE project_id = $1 OR project_id IS NULL ORDER BY name COLLATE "C" ASC`,
            [projectId]
          );
  return rows.map(mapCustomRole);
}

export async function getCustomRole(ctx: PgContext, id: string): ReturnType<Store["getCustomRole"]> {
  const row = await ctx.queryOne<CustomRoleRow>(`SELECT ${CUSTOM_ROLE_COLUMNS} FROM custom_roles WHERE id = $1`, [id]);
  return row ? mapCustomRole(row) : null;
}

export async function upsertCustomRole(ctx: PgContext, input: Parameters<Store["upsertCustomRole"]>[0]): ReturnType<Store["upsertCustomRole"]> {
  const now = new Date().toISOString();
  // created_by and created_at are kept on update (SQLite writes the stored values back; the conflict update omits them).
  await ctx.execute(
    `INSERT INTO custom_roles (id, project_id, name, description, permissions_json, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       ON CONFLICT (id) DO UPDATE SET
         project_id = EXCLUDED.project_id,
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         permissions_json = EXCLUDED.permissions_json,
         updated_at = EXCLUDED.updated_at`,
    [input.id, input.projectId ?? null, input.name, input.description ?? null, JSON.stringify(input.permissions), input.createdBy ?? null, now]
  );
}

export async function deleteCustomRole(ctx: PgContext, id: string): ReturnType<Store["deleteCustomRole"]> {
  return ctx.withTransaction(async (client) => {
    const result = await client.query(`DELETE FROM custom_roles WHERE id = $1`, [id]);
    if ((result.rowCount ?? 0) === 0) return false;
    await client.query(`UPDATE user_project_roles SET custom_role_id = NULL WHERE custom_role_id = $1`, [id]);
    return true;
  });
}

// ---------------------------------------------------------------------------
// SSO group-to-role mappings
// ---------------------------------------------------------------------------

interface SsoGroupMappingRow {
  id: string;
  provider: string;
  group_name: string;
  project_id: string | null;
  role: string;
  custom_role_id: string | null;
  created_at: string;
  updated_at: string;
}

export async function listSsoGroupMappings(ctx: PgContext, provider?: string): ReturnType<Store["listSsoGroupMappings"]> {
  const columns = `id, provider, group_name, project_id, role, custom_role_id, created_at, updated_at`;
  const rows = provider
    ? await ctx.query<SsoGroupMappingRow>(
        `SELECT ${columns} FROM sso_group_mappings WHERE provider = $1 ORDER BY group_name COLLATE "C" ASC`,
        [provider]
      )
    : await ctx.query<SsoGroupMappingRow>(
        `SELECT ${columns} FROM sso_group_mappings ORDER BY provider COLLATE "C", group_name COLLATE "C" ASC`
      );
  return rows.map((row) => ({
    id: toStr(row.id),
    provider: toStr(row.provider),
    groupName: toStr(row.group_name),
    projectId: nullableStr(row.project_id),
    role: toStr(row.role),
    customRoleId: nullableStr(row.custom_role_id),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at)
  }));
}

export async function upsertSsoGroupMapping(ctx: PgContext, input: Parameters<Store["upsertSsoGroupMapping"]>[0]): ReturnType<Store["upsertSsoGroupMapping"]> {
  const now = new Date().toISOString();
  await ctx.execute(
    `INSERT INTO sso_group_mappings (id, provider, group_name, project_id, role, custom_role_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       ON CONFLICT (id) DO UPDATE SET
         provider = EXCLUDED.provider,
         group_name = EXCLUDED.group_name,
         project_id = EXCLUDED.project_id,
         role = EXCLUDED.role,
         custom_role_id = EXCLUDED.custom_role_id,
         updated_at = EXCLUDED.updated_at`,
    [input.id, input.provider, input.groupName, input.projectId ?? null, input.role, input.customRoleId ?? null, now]
  );
}

export async function deleteSsoGroupMapping(ctx: PgContext, id: string): ReturnType<Store["deleteSsoGroupMapping"]> {
  const result = await ctx.pool.query(`DELETE FROM sso_group_mappings WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

interface ApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  scopes_json: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

function mapApiKey(row: ApiKeyRow) {
  return {
    id: toStr(row.id),
    userId: toStr(row.user_id),
    name: toStr(row.name),
    keyPrefix: toStr(row.key_prefix),
    scopes: parseJsonArray(row.scopes_json),
    lastUsedAt: nullableStr(row.last_used_at),
    expiresAt: nullableStr(row.expires_at),
    revokedAt: nullableStr(row.revoked_at),
    createdAt: toStr(row.created_at)
  };
}

export async function saveApiKey(ctx: PgContext, input: Parameters<Store["saveApiKey"]>[0]): ReturnType<Store["saveApiKey"]> {
  await ctx.execute(
    `INSERT INTO api_keys (id, user_id, name, key_prefix, key_hash, scopes_json, last_used_at, expires_at, revoked_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, NULL, $8)`,
    [input.id, input.userId, input.name, input.keyPrefix, input.keyHash, JSON.stringify(input.scopes ?? []), input.expiresAt ?? null, new Date().toISOString()]
  );
}

export async function listApiKeys(ctx: PgContext, userId?: string): ReturnType<Store["listApiKeys"]> {
  const columns = `id, user_id, name, key_prefix, scopes_json, last_used_at, expires_at, revoked_at, created_at`;
  const rows = userId
    ? await ctx.query<ApiKeyRow>(`SELECT ${columns} FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`, [userId])
    : await ctx.query<ApiKeyRow>(`SELECT ${columns} FROM api_keys ORDER BY created_at DESC`);
  return rows.map(mapApiKey);
}

export async function findApiKeyByPrefix(ctx: PgContext, prefix: string): ReturnType<Store["findApiKeyByPrefix"]> {
  const row = await ctx.queryOne<ApiKeyRow>(
    `SELECT id, user_id, name, key_prefix, key_hash, scopes_json, last_used_at, expires_at, revoked_at, created_at
       FROM api_keys WHERE key_prefix = $1 AND revoked_at IS NULL ORDER BY created_at ASC LIMIT 1`,
    [prefix]
  );
  if (!row) return null;
  const mapped = mapApiKey(row);
  return {
    id: mapped.id,
    userId: mapped.userId,
    name: mapped.name,
    keyPrefix: mapped.keyPrefix,
    keyHash: toStr(row.key_hash),
    scopes: mapped.scopes,
    lastUsedAt: mapped.lastUsedAt,
    expiresAt: mapped.expiresAt,
    revokedAt: mapped.revokedAt,
    createdAt: mapped.createdAt
  };
}

export async function touchApiKey(ctx: PgContext, id: string): ReturnType<Store["touchApiKey"]> {
  await ctx.execute(`UPDATE api_keys SET last_used_at = $1 WHERE id = $2`, [new Date().toISOString(), id]);
}

export async function revokeApiKey(ctx: PgContext, id: string, userId?: string): ReturnType<Store["revokeApiKey"]> {
  // Like SQLite, a key that is already revoked is revoked again (true, with a new revoked_at).
  const result = userId
    ? await ctx.pool.query(`UPDATE api_keys SET revoked_at = $1 WHERE id = $2 AND user_id = $3`, [new Date().toISOString(), id, userId])
    : await ctx.pool.query(`UPDATE api_keys SET revoked_at = $1 WHERE id = $2`, [new Date().toISOString(), id]);
  return (result.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// MFA
// ---------------------------------------------------------------------------

export async function getMfaSecret(ctx: PgContext, userId: string): ReturnType<Store["getMfaSecret"]> {
  const row = await ctx.queryOne<{
    user_id: string;
    secret_iv: string;
    secret_auth_tag: string;
    secret_ciphertext: string;
    backup_codes_json: string;
    enabled: number;
    activated_at: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT user_id, secret_iv, secret_auth_tag, secret_ciphertext, backup_codes_json, enabled, activated_at, created_at, updated_at
       FROM mfa_secrets WHERE user_id = $1`,
    [userId]
  );
  if (!row) return null;
  return {
    userId: toStr(row.user_id),
    secretIv: toStr(row.secret_iv),
    secretAuthTag: toStr(row.secret_auth_tag),
    secretCiphertext: toStr(row.secret_ciphertext),
    backupCodes: parseJsonArray(row.backup_codes_json),
    enabled: toNum(row.enabled) === 1,
    activatedAt: nullableStr(row.activated_at),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at)
  };
}

export async function upsertMfaSecret(ctx: PgContext, input: Parameters<Store["upsertMfaSecret"]>[0]): ReturnType<Store["upsertMfaSecret"]> {
  const now = new Date().toISOString();
  await ctx.execute(
    `INSERT INTO mfa_secrets (user_id, secret_iv, secret_auth_tag, secret_ciphertext, backup_codes_json, enabled, activated_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       ON CONFLICT (user_id) DO UPDATE SET
         secret_iv = EXCLUDED.secret_iv,
         secret_auth_tag = EXCLUDED.secret_auth_tag,
         secret_ciphertext = EXCLUDED.secret_ciphertext,
         backup_codes_json = EXCLUDED.backup_codes_json,
         enabled = EXCLUDED.enabled,
         activated_at = EXCLUDED.activated_at,
         updated_at = EXCLUDED.updated_at`,
    [
      input.userId,
      input.secretIv,
      input.secretAuthTag,
      input.secretCiphertext,
      JSON.stringify(input.backupCodes),
      input.enabled ? 1 : 0,
      input.activatedAt,
      now
    ]
  );
}

/** Compare-and-set on the stored backup codes: true only for the one writer whose `expected` was still stored. */
export async function replaceMfaBackupCodes(ctx: PgContext, input: Parameters<Store["replaceMfaBackupCodes"]>[0]): ReturnType<Store["replaceMfaBackupCodes"]> {
  const result = await ctx.pool.query(
    `UPDATE mfa_secrets SET backup_codes_json = $1, updated_at = $2 WHERE user_id = $3 AND backup_codes_json = $4`,
    [JSON.stringify(input.next), new Date().toISOString(), input.userId, JSON.stringify(input.expected)]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function deleteMfaSecret(ctx: PgContext, userId: string): ReturnType<Store["deleteMfaSecret"]> {
  const result = await ctx.pool.query(`DELETE FROM mfa_secrets WHERE user_id = $1`, [userId]);
  return (result.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// SSO identities
// ---------------------------------------------------------------------------

export async function findSsoIdentity(ctx: PgContext, provider: string, subject: string): ReturnType<Store["findSsoIdentity"]> {
  const row = await ctx.queryOne<{
    id: string;
    user_id: string;
    provider: string;
    subject: string;
    email: string | null;
    attributes_json: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, user_id, provider, subject, email, attributes_json, created_at, updated_at
       FROM sso_identities WHERE provider = $1 AND subject = $2`,
    [provider, subject]
  );
  if (!row) return null;
  let attributes: unknown = null;
  if (row.attributes_json) {
    try {
      attributes = JSON.parse(toStr(row.attributes_json));
    } catch {
      attributes = null;
    }
  }
  return {
    id: toStr(row.id),
    userId: toStr(row.user_id),
    provider: toStr(row.provider),
    subject: toStr(row.subject),
    email: nullableStr(row.email),
    attributes,
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at)
  };
}

export async function upsertSsoIdentity(ctx: PgContext, input: Parameters<Store["upsertSsoIdentity"]>[0]): ReturnType<Store["upsertSsoIdentity"]> {
  const now = new Date().toISOString();
  // An existing (provider, subject) keeps its id and created_at, as in SQLite.
  await ctx.execute(
    `INSERT INTO sso_identities (id, user_id, provider, subject, email, attributes_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       ON CONFLICT (provider, subject) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         email = EXCLUDED.email,
         attributes_json = EXCLUDED.attributes_json,
         updated_at = EXCLUDED.updated_at`,
    [
      input.id,
      input.userId,
      input.provider,
      input.subject,
      input.email ?? null,
      input.attributes === undefined ? null : JSON.stringify(input.attributes),
      now
    ]
  );
}
