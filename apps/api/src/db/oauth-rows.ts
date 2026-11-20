/**
 * v82 — the oauth_apps and oauth_accounts row shapes and their mapping, shared by the SQLite and Postgres stores.
 */
import type { OAuthAccountRecord, OAuthAppRecord } from "./store.js";

export interface OAuthAppRow {
  id: string;
  provider_id: string;
  project_id: string | null;
  client_id: string;
  client_secret_id: string | null;
  tenant: string | null;
  updated_by: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface OAuthAccountRow {
  secret_id: string;
  provider_id: string;
  project_id: string;
  app_id: string | null;
  account_label: string | null;
  scopes: string | null;
  status: string;
  last_error: string | null;
  expires_at: string | Date | null;
  has_refresh_token: number | string | boolean;
  connected_by: string | null;
  connected_at: string | Date;
  last_refresh_at: string | Date | null;
  updated_at: string | Date;
}

export const OAUTH_APP_COLUMNS = "id, provider_id, project_id, client_id, client_secret_id, tenant, updated_by, created_at, updated_at";
export const OAUTH_ACCOUNT_COLUMNS =
  "secret_id, provider_id, project_id, app_id, account_label, scopes, status, last_error, expires_at, has_refresh_token, connected_by, connected_at, last_refresh_at, updated_at";

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function isoOrNull(value: string | Date | null): string | null {
  return value === null || value === undefined || value === "" ? null : iso(value);
}

export function mapOAuthAppRow(row: OAuthAppRow): OAuthAppRecord {
  return {
    id: String(row.id),
    providerId: String(row.provider_id),
    projectId: row.project_id ? String(row.project_id) : null,
    clientId: String(row.client_id),
    clientSecretId: row.client_secret_id ? String(row.client_secret_id) : null,
    tenant: row.tenant ? String(row.tenant) : null,
    updatedBy: row.updated_by ? String(row.updated_by) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

export function mapOAuthAccountRow(row: OAuthAccountRow): OAuthAccountRecord {
  return {
    secretId: String(row.secret_id),
    providerId: String(row.provider_id),
    projectId: String(row.project_id),
    appId: row.app_id ? String(row.app_id) : null,
    accountLabel: row.account_label ? String(row.account_label) : null,
    scopes: String(row.scopes ?? "")
      .split(" ")
      .filter(Boolean),
    status: row.status === "needs_reconnect" ? "needs_reconnect" : "connected",
    lastError: row.last_error ? String(row.last_error) : null,
    expiresAt: isoOrNull(row.expires_at),
    hasRefreshToken: row.has_refresh_token === true || Number(row.has_refresh_token) === 1,
    connectedBy: row.connected_by ? String(row.connected_by) : null,
    connectedAt: iso(row.connected_at),
    lastRefreshAt: isoOrNull(row.last_refresh_at),
    updatedAt: iso(row.updated_at)
  };
}

/** The values of an oauth_accounts upsert, in OAUTH_ACCOUNT_COLUMNS order (updated_at last). */
export function oauthAccountValues(input: Omit<OAuthAccountRecord, "updatedAt">, now: string): unknown[] {
  return [
    input.secretId,
    input.providerId,
    input.projectId,
    input.appId,
    input.accountLabel,
    input.scopes.join(" "),
    input.status,
    input.lastError,
    input.expiresAt,
    input.hasRefreshToken ? 1 : 0,
    input.connectedBy,
    input.connectedAt,
    input.lastRefreshAt,
    now
  ];
}
