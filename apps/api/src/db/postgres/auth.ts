/**
 * Phase 13.1 — PostgresStore: Users, RBAC, API keys, MFA and SSO identities.
 * Plain functions over a PgContext; PostgresStore delegates here. Methods that are not implemented yet throw
 * StoreNotImplementedError and are listed in UNIMPLEMENTED_METHODS (remove both together when implementing one).
 */
import { StoreNotImplementedError } from "../store-errors.js";
import { type Store } from "../store.js";
import { toNum, toStr } from "./helpers.js";
import type { PgContext } from "./context.js";

export const UNIMPLEMENTED_METHODS: readonly (keyof Store)[] = [
  "countProjectMemberships",
  "listProjectMembers",
  "listUserProjectRoles",
  "getProjectRole",
  "upsertProjectRole",
  "removeProjectRole",
  "listCustomRoles",
  "getCustomRole",
  "upsertCustomRole",
  "deleteCustomRole",
  "listSsoGroupMappings",
  "upsertSsoGroupMapping",
  "deleteSsoGroupMapping",
  "saveApiKey",
  "listApiKeys",
  "findApiKeyByPrefix",
  "touchApiKey",
  "revokeApiKey",
  "getMfaSecret",
  "upsertMfaSecret",
  "replaceMfaBackupCodes",
  "deleteMfaSecret",
  "findSsoIdentity",
  "upsertSsoIdentity"
];

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

export async function deleteUser(ctx: PgContext, id: string): Promise<boolean> {
  const existing = await ctx.store.getUserById(id);
  if (!existing) return false;
  await ctx.execute(`DELETE FROM sessions WHERE user_id = $1`, [id]);
  await ctx.execute(`DELETE FROM users WHERE id = $1`, [id]);
  return true;
}

export async function countProjectMemberships(_ctx: PgContext, ..._args: Parameters<Store["countProjectMemberships"]>): ReturnType<Store["countProjectMemberships"]> {
  throw new StoreNotImplementedError("countProjectMemberships");
}

export async function listProjectMembers(_ctx: PgContext, ..._args: Parameters<Store["listProjectMembers"]>): ReturnType<Store["listProjectMembers"]> {
  throw new StoreNotImplementedError("listProjectMembers");
}

export async function listUserProjectRoles(_ctx: PgContext, ..._args: Parameters<Store["listUserProjectRoles"]>): ReturnType<Store["listUserProjectRoles"]> {
  throw new StoreNotImplementedError("listUserProjectRoles");
}

export async function getProjectRole(_ctx: PgContext, ..._args: Parameters<Store["getProjectRole"]>): ReturnType<Store["getProjectRole"]> {
  throw new StoreNotImplementedError("getProjectRole");
}

export async function upsertProjectRole(_ctx: PgContext, ..._args: Parameters<Store["upsertProjectRole"]>): ReturnType<Store["upsertProjectRole"]> {
  throw new StoreNotImplementedError("upsertProjectRole");
}

export async function removeProjectRole(_ctx: PgContext, ..._args: Parameters<Store["removeProjectRole"]>): ReturnType<Store["removeProjectRole"]> {
  throw new StoreNotImplementedError("removeProjectRole");
}

export async function listCustomRoles(_ctx: PgContext, ..._args: Parameters<Store["listCustomRoles"]>): ReturnType<Store["listCustomRoles"]> {
  throw new StoreNotImplementedError("listCustomRoles");
}

export async function getCustomRole(_ctx: PgContext, ..._args: Parameters<Store["getCustomRole"]>): ReturnType<Store["getCustomRole"]> {
  throw new StoreNotImplementedError("getCustomRole");
}

export async function upsertCustomRole(_ctx: PgContext, ..._args: Parameters<Store["upsertCustomRole"]>): ReturnType<Store["upsertCustomRole"]> {
  throw new StoreNotImplementedError("upsertCustomRole");
}

export async function deleteCustomRole(_ctx: PgContext, ..._args: Parameters<Store["deleteCustomRole"]>): ReturnType<Store["deleteCustomRole"]> {
  throw new StoreNotImplementedError("deleteCustomRole");
}

export async function listSsoGroupMappings(_ctx: PgContext, ..._args: Parameters<Store["listSsoGroupMappings"]>): ReturnType<Store["listSsoGroupMappings"]> {
  throw new StoreNotImplementedError("listSsoGroupMappings");
}

export async function upsertSsoGroupMapping(_ctx: PgContext, ..._args: Parameters<Store["upsertSsoGroupMapping"]>): ReturnType<Store["upsertSsoGroupMapping"]> {
  throw new StoreNotImplementedError("upsertSsoGroupMapping");
}

export async function deleteSsoGroupMapping(_ctx: PgContext, ..._args: Parameters<Store["deleteSsoGroupMapping"]>): ReturnType<Store["deleteSsoGroupMapping"]> {
  throw new StoreNotImplementedError("deleteSsoGroupMapping");
}

export async function saveApiKey(_ctx: PgContext, ..._args: Parameters<Store["saveApiKey"]>): ReturnType<Store["saveApiKey"]> {
  throw new StoreNotImplementedError("saveApiKey");
}

export async function listApiKeys(_ctx: PgContext, ..._args: Parameters<Store["listApiKeys"]>): ReturnType<Store["listApiKeys"]> {
  throw new StoreNotImplementedError("listApiKeys");
}

export async function findApiKeyByPrefix(_ctx: PgContext, ..._args: Parameters<Store["findApiKeyByPrefix"]>): ReturnType<Store["findApiKeyByPrefix"]> {
  throw new StoreNotImplementedError("findApiKeyByPrefix");
}

export async function touchApiKey(_ctx: PgContext, ..._args: Parameters<Store["touchApiKey"]>): ReturnType<Store["touchApiKey"]> {
  throw new StoreNotImplementedError("touchApiKey");
}

export async function revokeApiKey(_ctx: PgContext, ..._args: Parameters<Store["revokeApiKey"]>): ReturnType<Store["revokeApiKey"]> {
  throw new StoreNotImplementedError("revokeApiKey");
}

export async function getMfaSecret(_ctx: PgContext, ..._args: Parameters<Store["getMfaSecret"]>): ReturnType<Store["getMfaSecret"]> {
  throw new StoreNotImplementedError("getMfaSecret");
}

export async function upsertMfaSecret(_ctx: PgContext, ..._args: Parameters<Store["upsertMfaSecret"]>): ReturnType<Store["upsertMfaSecret"]> {
  throw new StoreNotImplementedError("upsertMfaSecret");
}

export async function replaceMfaBackupCodes(_ctx: PgContext, ..._args: Parameters<Store["replaceMfaBackupCodes"]>): ReturnType<Store["replaceMfaBackupCodes"]> {
  throw new StoreNotImplementedError("replaceMfaBackupCodes");
}

export async function deleteMfaSecret(_ctx: PgContext, ..._args: Parameters<Store["deleteMfaSecret"]>): ReturnType<Store["deleteMfaSecret"]> {
  throw new StoreNotImplementedError("deleteMfaSecret");
}

export async function findSsoIdentity(_ctx: PgContext, ..._args: Parameters<Store["findSsoIdentity"]>): ReturnType<Store["findSsoIdentity"]> {
  throw new StoreNotImplementedError("findSsoIdentity");
}

export async function upsertSsoIdentity(_ctx: PgContext, ..._args: Parameters<Store["upsertSsoIdentity"]>): ReturnType<Store["upsertSsoIdentity"]> {
  throw new StoreNotImplementedError("upsertSsoIdentity");
}
