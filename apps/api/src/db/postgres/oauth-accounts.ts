/**
 * v82 — PostgresStore: OAuth apps and connected account details (see SqliteStore for the same methods).
 */
import type { OAuthAccountRecord, OAuthAccountWrite, OAuthAppRecord, OAuthAppWrite } from "../store.js";
import {
  mapOAuthAccountRow,
  mapOAuthAppRow,
  OAUTH_ACCOUNT_COLUMNS,
  OAUTH_APP_COLUMNS,
  oauthAccountValues,
  type OAuthAccountRow,
  type OAuthAppRow
} from "../oauth-rows.js";
import type { PgContext } from "./context.js";

/** SQLite orders by id in byte order; the "C" collation matches it. */
export async function listOAuthApps(ctx: PgContext): Promise<OAuthAppRecord[]> {
  return (await ctx.query<OAuthAppRow>(`SELECT ${OAUTH_APP_COLUMNS} FROM oauth_apps ORDER BY id COLLATE "C"`)).map(mapOAuthAppRow);
}

export async function getOAuthApp(ctx: PgContext, id: string): Promise<OAuthAppRecord | null> {
  const row = await ctx.queryOne<OAuthAppRow>(`SELECT ${OAUTH_APP_COLUMNS} FROM oauth_apps WHERE id = $1`, [id]);
  return row ? mapOAuthAppRow(row) : null;
}

export async function saveOAuthApp(ctx: PgContext, input: OAuthAppWrite): Promise<OAuthAppRecord> {
  const now = new Date().toISOString();
  await ctx.execute(
    `INSERT INTO oauth_apps (${OAUTH_APP_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
     ON CONFLICT (id) DO UPDATE SET client_id = EXCLUDED.client_id, client_secret_id = EXCLUDED.client_secret_id,
       tenant = EXCLUDED.tenant, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
    [input.id, input.providerId, input.projectId, input.clientId, input.clientSecretId, input.tenant, input.updatedBy, now]
  );
  return (await getOAuthApp(ctx, input.id))!;
}

export async function deleteOAuthApp(ctx: PgContext, id: string): Promise<boolean> {
  const result = await ctx.pool.query(`DELETE FROM oauth_apps WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function listOAuthAccounts(ctx: PgContext, secretIds?: readonly string[]): Promise<OAuthAccountRecord[]> {
  if (secretIds && secretIds.length === 0) return [];
  const rows = secretIds
    ? await ctx.query<OAuthAccountRow>(
        `SELECT ${OAUTH_ACCOUNT_COLUMNS} FROM oauth_accounts WHERE secret_id = ANY($1::text[]) ORDER BY secret_id COLLATE "C"`,
        [[...secretIds]]
      )
    : await ctx.query<OAuthAccountRow>(`SELECT ${OAUTH_ACCOUNT_COLUMNS} FROM oauth_accounts ORDER BY secret_id COLLATE "C"`);
  return rows.map(mapOAuthAccountRow);
}

export async function getOAuthAccount(ctx: PgContext, secretId: string): Promise<OAuthAccountRecord | null> {
  const row = await ctx.queryOne<OAuthAccountRow>(`SELECT ${OAUTH_ACCOUNT_COLUMNS} FROM oauth_accounts WHERE secret_id = $1`, [secretId]);
  return row ? mapOAuthAccountRow(row) : null;
}

export async function saveOAuthAccount(ctx: PgContext, input: OAuthAccountWrite): Promise<OAuthAccountRecord> {
  await ctx.execute(
    `INSERT INTO oauth_accounts (${OAUTH_ACCOUNT_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (secret_id) DO UPDATE SET provider_id = EXCLUDED.provider_id, project_id = EXCLUDED.project_id,
       app_id = EXCLUDED.app_id, account_label = EXCLUDED.account_label, scopes = EXCLUDED.scopes, status = EXCLUDED.status,
       last_error = EXCLUDED.last_error, expires_at = EXCLUDED.expires_at, has_refresh_token = EXCLUDED.has_refresh_token,
       connected_by = EXCLUDED.connected_by, connected_at = EXCLUDED.connected_at, last_refresh_at = EXCLUDED.last_refresh_at,
       updated_at = EXCLUDED.updated_at`,
    oauthAccountValues(input, new Date().toISOString())
  );
  return (await getOAuthAccount(ctx, input.secretId))!;
}

export async function deleteOAuthAccount(ctx: PgContext, secretId: string): Promise<boolean> {
  const result = await ctx.pool.query(`DELETE FROM oauth_accounts WHERE secret_id = $1`, [secretId]);
  return (result.rowCount ?? 0) > 0;
}
