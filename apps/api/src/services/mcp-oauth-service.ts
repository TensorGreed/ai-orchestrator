/**
 * Phase 10.5 — OAuth 2.1 connections for remote (HTTP) MCP servers in the
 * registry. One service-level connection per registry server.
 *
 * Flow: an admin presses Connect → discovery (RFC 9728 protected resource
 * metadata → RFC 8414 / OIDC authorization server metadata) → the client id
 * the admin configured, or RFC 7591 dynamic registration → an authorization
 * URL with PKCE (S256), `state` and the RFC 8707 `resource` → the
 * authorization server redirects to `/api/mcp/oauth/callback` → the code is
 * exchanged for tokens. Access tokens are refreshed shortly before they
 * expire and whenever the server answers 401.
 *
 * Storage: tokens, refresh tokens and the client registration live only in a
 * SecretService secret (provider `mcp_oauth`), which `resolveSecret` refuses
 * to hand to node configs. The `mcp_oauth_connections` row keeps what the UI
 * may show. Pending authorizations (state, PKCE verifier) stay in memory:
 * single-use, bound to the admin's session and the server, short-lived.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  McpOAuthError,
  buildAuthorizationUrl,
  createOAuthState,
  createPkcePair,
  discoverMcpOAuth,
  exchangeAuthorizationCode,
  refreshOAuthToken,
  registerOAuthClient,
  type FetchLike,
  type McpOAuthTokenProvider,
  type OAuthTokenSet
} from "@ai-orchestrator/mcp-sdk";
import type { McpOAuthConnectionStatus } from "@ai-orchestrator/shared";
import type { McpOAuthConnectionRecord, McpServerRecord, SqliteStore } from "../db/database.js";
import type { SecretService } from "./secret-service.js";

export const MCP_OAUTH_CALLBACK_PATH = "/api/mcp/oauth/callback";
export const MCP_OAUTH_SECRET_PROVIDER = "mcp_oauth";

/** Where the authorization server sends the browser back: MCP_OAUTH_REDIRECT_BASE_URL, else MCP_GATEWAY_PUBLIC_URL, else the first WEB_ORIGIN. */
export function resolveMcpOAuthRedirectUri(config: {
  MCP_OAUTH_REDIRECT_BASE_URL: string;
  MCP_GATEWAY_PUBLIC_URL: string;
  WEB_ORIGIN: string;
}): string {
  const base =
    config.MCP_OAUTH_REDIRECT_BASE_URL.trim() ||
    config.MCP_GATEWAY_PUBLIC_URL.trim() ||
    config.WEB_ORIGIN.split(",").map((entry) => entry.trim()).find(Boolean) ||
    "http://localhost:5173";
  return `${base.replace(/\/+$/, "")}${MCP_OAUTH_CALLBACK_PATH}`;
}

/** What the secret holds. Never returned by any API. */
interface StoredOAuthSecret {
  version: 1;
  accessToken: string;
  tokenType: string;
  refreshToken?: string;
  expiresAt?: string;
  scope?: string;
  tokenEndpoint: string;
  issuer: string;
  resource: string;
  client: {
    clientId: string;
    clientSecret?: string;
    tokenEndpointAuthMethod: string;
    registration: "dynamic" | "pre_registered";
    redirectUri: string;
  };
}

interface PendingAuthorization {
  serverId: string;
  /** sha256 of the admin's session id; the callback must come from the same session. */
  sessionHash: string;
  userEmail: string;
  codeVerifier: string;
  redirectUri: string;
  resource: string;
  tokenEndpoint: string;
  issuer: string;
  scope?: string;
  client: StoredOAuthSecret["client"];
  expiresAtMs: number;
}

export interface McpOAuthServiceOptions {
  redirectUri: string;
  stateTtlMs: number;
  /** Refresh access tokens this long before they expire. */
  refreshSkewMs: number;
  fetchImpl?: FetchLike;
  /** Audit hook for events without a request (background refresh failures). */
  onAudit?: (event: { eventType: string; serverId: string; outcome: "success" | "failure"; metadata: Record<string, unknown> }) => void;
}

export class McpOAuthUserError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400
  ) {
    super(message);
    this.name = "McpOAuthUserError";
  }
}

export interface OAuthCallbackOutcome {
  serverId: string | null;
  ok: boolean;
  error?: string;
}

function hashSession(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const MAX_PENDING = 200;

export class McpOAuthService implements McpOAuthTokenProvider {
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly refreshing = new Map<string, Promise<string>>();

  constructor(
    private readonly store: SqliteStore,
    private readonly secretService: SecretService,
    private readonly options: McpOAuthServiceOptions
  ) {}

  get redirectUri(): string {
    return this.options.redirectUri;
  }

  /** True when the server's connection is set up for OAuth. */
  static usesOAuth(server: Pick<McpServerRecord, "adapterId" | "connection">): boolean {
    return server.adapterId === "http_mcp" && String(server.connection.authType ?? "").trim().toLowerCase() === "oauth";
  }

  status(serverId: string): McpOAuthConnectionStatus {
    const row = this.store.getMcpOAuthConnection(serverId);
    const base: McpOAuthConnectionStatus = {
      serverId,
      state: "not_connected",
      subject: null,
      scope: null,
      authorizationServer: null,
      clientRegistration: null,
      clientId: null,
      expiresAt: null,
      hasRefreshToken: false,
      lastRefreshAt: null,
      connectedAt: null,
      connectedBy: null,
      lastError: null,
      updatedAt: null,
      redirectUri: this.options.redirectUri
    };
    if (!row) return base;
    let state = row.state;
    if (state === "connected" && row.expiresAt && Date.parse(row.expiresAt) <= Date.now() && !row.hasRefreshToken) {
      state = "expired";
    }
    return {
      ...base,
      state,
      subject: row.subject,
      scope: row.scope,
      authorizationServer: row.authorizationServer,
      clientRegistration: row.clientRegistration,
      clientId: row.clientId,
      expiresAt: row.expiresAt,
      hasRefreshToken: row.hasRefreshToken,
      lastRefreshAt: row.lastRefreshAt,
      connectedAt: row.connectedAt,
      connectedBy: row.connectedBy,
      lastError: row.lastError,
      updatedAt: row.updatedAt
    };
  }

  private readSecret(row: McpOAuthConnectionRecord | null): StoredOAuthSecret | null {
    if (!row?.secretId) return null;
    const raw = this.secretService.resolveInternalSecret(row.secretId);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as StoredOAuthSecret;
      return parsed && typeof parsed.accessToken === "string" ? parsed : null;
    } catch {
      return null;
    }
  }

  private writeSecret(server: McpServerRecord, existingSecretId: string | null, value: StoredOAuthSecret): string {
    const json = JSON.stringify(value);
    if (existingSecretId && this.secretService.updateInternalSecret(existingSecretId, json)) {
      return existingSecretId;
    }
    return this.secretService.createSecret({
      name: `MCP OAuth · ${server.name}`.slice(0, 120),
      provider: MCP_OAUTH_SECRET_PROVIDER,
      value: json,
      projectId: server.projectId ?? undefined
    }).secretId;
  }

  private prunePending(now = Date.now()): void {
    for (const [state, entry] of this.pending) {
      if (entry.expiresAtMs <= now) this.pending.delete(state);
    }
    while (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
  }

  /**
   * Start the authorization code flow for a registry server: discovery,
   * client registration when needed, then an authorization URL for the
   * admin's browser.
   */
  async startAuthorization(input: {
    server: McpServerRecord;
    sessionId: string;
    userEmail: string;
    scope?: string;
  }): Promise<{ authorizationUrl: string; expiresAt: string; redirectUri: string }> {
    const { server } = input;
    if (!McpOAuthService.usesOAuth(server)) {
      throw new McpOAuthUserError(`MCP server '${server.name}' does not use OAuth. Set its auth type to OAuth first.`);
    }
    const endpoint = String(server.connection.endpoint ?? "").trim();
    if (!endpoint) {
      throw new McpOAuthUserError(`MCP server '${server.name}' has no endpoint.`);
    }
    const oauthSettings = toRecord(server.connection.oauth);
    const customHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(toRecord(server.connection.headers))) {
      if (typeof value === "string" && key.trim() && key.toLowerCase() !== "authorization") customHeaders[key] = value;
    }

    const fetchOptions = this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {};
    let discovery;
    try {
      discovery = await discoverMcpOAuth(endpoint, { ...fetchOptions, headers: customHeaders });
    } catch (error) {
      throw new McpOAuthUserError(error instanceof Error ? error.message : "OAuth discovery failed.", 502);
    }
    const metadata = discovery.authorizationServer;
    const redirectUri = this.options.redirectUri;
    const configuredScope =
      input.scope?.trim() ||
      (typeof oauthSettings.scope === "string" && oauthSettings.scope.trim()) ||
      discovery.scopeHint ||
      (Array.isArray(discovery.resourceMetadata.scopes_supported) ? discovery.resourceMetadata.scopes_supported.join(" ") : "") ||
      undefined;

    let client: StoredOAuthSecret["client"];
    const configuredClientId = typeof oauthSettings.clientId === "string" ? oauthSettings.clientId.trim() : "";
    if (configuredClientId) {
      const clientSecret = server.secretId ? await this.secretService.resolveSecret({ secretId: server.secretId }) : undefined;
      const method =
        typeof oauthSettings.tokenEndpointAuthMethod === "string" && oauthSettings.tokenEndpointAuthMethod.trim()
          ? oauthSettings.tokenEndpointAuthMethod.trim()
          : clientSecret
            ? "client_secret_basic"
            : "none";
      client = {
        clientId: configuredClientId,
        ...(clientSecret ? { clientSecret } : {}),
        tokenEndpointAuthMethod: method,
        registration: "pre_registered",
        redirectUri
      };
    } else {
      // Reuse an earlier dynamic registration for the same authorization server and redirect URL.
      const previous = this.readSecret(this.store.getMcpOAuthConnection(server.id));
      if (
        previous?.client.registration === "dynamic" &&
        previous.issuer === metadata.issuer &&
        previous.client.redirectUri === redirectUri
      ) {
        client = previous.client;
      } else {
        if (!metadata.registration_endpoint) {
          throw new McpOAuthUserError(
            "The authorization server does not support dynamic client registration. Register L2M as a client there and enter its client id on the server.",
            502
          );
        }
        try {
          const registration = await registerOAuthClient(
            metadata.registration_endpoint,
            { redirectUri, clientName: "L2M", ...(configuredScope ? { scope: configuredScope } : {}) },
            fetchOptions
          );
          client = { ...registration, registration: "dynamic", redirectUri };
        } catch (error) {
          throw new McpOAuthUserError(error instanceof Error ? error.message : "Client registration failed.", 502);
        }
      }
    }

    const pkce = createPkcePair();
    const state = createOAuthState();
    const expiresAtMs = Date.now() + this.options.stateTtlMs;
    this.prunePending();
    this.pending.set(state, {
      serverId: server.id,
      sessionHash: hashSession(input.sessionId),
      userEmail: input.userEmail,
      codeVerifier: pkce.verifier,
      redirectUri,
      resource: discovery.resource,
      tokenEndpoint: metadata.token_endpoint,
      issuer: metadata.issuer,
      ...(configuredScope ? { scope: configuredScope } : {}),
      client,
      expiresAtMs
    });
    const authorizationUrl = buildAuthorizationUrl({
      authorizationEndpoint: metadata.authorization_endpoint,
      clientId: client.clientId,
      redirectUri,
      state,
      codeChallenge: pkce.challenge,
      resource: discovery.resource,
      ...(configuredScope ? { scope: configuredScope } : {})
    });
    return { authorizationUrl, expiresAt: new Date(expiresAtMs).toISOString(), redirectUri };
  }

  /**
   * Finish the flow. The state must exist, be unexpired, belong to the
   * caller's session and is consumed on first use, whatever the outcome.
   */
  async completeAuthorization(input: {
    state: string | undefined;
    code: string | undefined;
    error?: string;
    errorDescription?: string;
    sessionId: string | null;
  }): Promise<OAuthCallbackOutcome> {
    const state = typeof input.state === "string" ? input.state : "";
    const pending = state ? this.pending.get(state) : undefined;
    if (pending) this.pending.delete(state);
    if (!pending) {
      return { serverId: null, ok: false, error: "This authorization link is unknown or was already used. Start again from the MCP servers page." };
    }
    if (pending.expiresAtMs <= Date.now()) {
      return { serverId: pending.serverId, ok: false, error: "This authorization link expired. Start again from the MCP servers page." };
    }
    if (!input.sessionId || hashSession(input.sessionId) !== pending.sessionHash) {
      return {
        serverId: pending.serverId,
        ok: false,
        error: "This authorization was started from a different session. Start again from the MCP servers page."
      };
    }
    const server = this.store.getMcpServer(pending.serverId);
    if (!server) {
      return { serverId: pending.serverId, ok: false, error: "The MCP server no longer exists." };
    }
    if (input.error) {
      const message = `The authorization server refused: ${(input.errorDescription || input.error).slice(0, 300)}`;
      this.recordError(server.id, message);
      return { serverId: server.id, ok: false, error: message };
    }
    if (!input.code) {
      return { serverId: server.id, ok: false, error: "The authorization server sent no code." };
    }

    let tokens: OAuthTokenSet;
    try {
      tokens = await exchangeAuthorizationCode(
        {
          tokenEndpoint: pending.tokenEndpoint,
          clientId: pending.client.clientId,
          ...(pending.client.clientSecret ? { clientSecret: pending.client.clientSecret } : {}),
          tokenEndpointAuthMethod: pending.client.tokenEndpointAuthMethod,
          code: input.code,
          codeVerifier: pending.codeVerifier,
          redirectUri: pending.redirectUri,
          resource: pending.resource
        },
        this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}
      );
    } catch (error) {
      const message = error instanceof McpOAuthError ? error.message : "Token exchange failed.";
      this.recordError(server.id, message);
      return { serverId: server.id, ok: false, error: message };
    }

    const existing = this.store.getMcpOAuthConnection(server.id);
    const secret: StoredOAuthSecret = {
      version: 1,
      accessToken: tokens.accessToken,
      tokenType: tokens.tokenType,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
      ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
      ...((tokens.scope ?? pending.scope) ? { scope: tokens.scope ?? pending.scope } : {}),
      tokenEndpoint: pending.tokenEndpoint,
      issuer: pending.issuer,
      resource: pending.resource,
      client: pending.client
    };
    const secretId = this.writeSecret(server, existing?.secretId ?? null, secret);
    const now = new Date().toISOString();
    this.store.upsertMcpOAuthConnection({
      serverId: server.id,
      secretId,
      state: "connected",
      subject: tokens.subject ?? null,
      scope: secret.scope ?? null,
      authorizationServer: pending.issuer,
      clientRegistration: pending.client.registration,
      clientId: pending.client.clientId,
      expiresAt: tokens.expiresAt ?? null,
      hasRefreshToken: Boolean(tokens.refreshToken),
      lastRefreshAt: null,
      connectedAt: now,
      connectedBy: pending.userEmail,
      lastError: null
    });
    return { serverId: server.id, ok: true };
  }

  private recordError(serverId: string, message: string): void {
    const row = this.store.getMcpOAuthConnection(serverId);
    this.store.upsertMcpOAuthConnection({
      serverId,
      secretId: row?.secretId ?? null,
      state: row?.secretId ? "error" : "not_connected",
      subject: row?.subject ?? null,
      scope: row?.scope ?? null,
      authorizationServer: row?.authorizationServer ?? null,
      clientRegistration: row?.clientRegistration ?? null,
      clientId: row?.clientId ?? null,
      expiresAt: row?.expiresAt ?? null,
      hasRefreshToken: row?.hasRefreshToken ?? false,
      lastRefreshAt: row?.lastRefreshAt ?? null,
      connectedAt: row?.connectedAt ?? null,
      connectedBy: row?.connectedBy ?? null,
      lastError: message.slice(0, 500)
    });
  }

  /** McpOAuthTokenProvider: the access token for a registry server, refreshed when due or when forced. */
  async getAccessToken(registryServerId: string, options?: { forceRefresh?: boolean }): Promise<string> {
    const server = this.store.getMcpServer(registryServerId);
    const label = server?.name ?? registryServerId;
    const row = this.store.getMcpOAuthConnection(registryServerId);
    const secret = this.readSecret(row);
    if (!row || !secret) {
      throw new Error(
        `MCP server '${label}' uses OAuth but is not connected. An admin can connect it on the MCP servers page.`
      );
    }
    const expiresAtMs = secret.expiresAt ? Date.parse(secret.expiresAt) : Number.POSITIVE_INFINITY;
    const due = expiresAtMs - Date.now() <= this.options.refreshSkewMs;
    if (!options?.forceRefresh && !due) {
      return secret.accessToken;
    }
    if (!secret.refreshToken) {
      if (!due && !options?.forceRefresh) return secret.accessToken;
      this.markExpired(row, `The access token for '${label}' expired and the server issued no refresh token. Reconnect it.`);
      throw new Error(`MCP server '${label}': the OAuth access token expired and cannot be refreshed. An admin must reconnect it.`);
    }
    const running = this.refreshing.get(registryServerId);
    if (running) return running;
    const refresh = this.refresh(registryServerId, label).finally(() => {
      this.refreshing.delete(registryServerId);
    });
    this.refreshing.set(registryServerId, refresh);
    return refresh;
  }

  private markExpired(row: McpOAuthConnectionRecord, message: string): void {
    this.store.upsertMcpOAuthConnection({ ...row, state: "expired", lastError: message.slice(0, 500) });
  }

  private async refresh(serverId: string, label: string): Promise<string> {
    const row = this.store.getMcpOAuthConnection(serverId);
    const secret = this.readSecret(row);
    if (!row || !secret?.refreshToken) {
      throw new Error(`MCP server '${label}' is not connected.`);
    }
    let tokens: OAuthTokenSet;
    try {
      tokens = await refreshOAuthToken(
        {
          tokenEndpoint: secret.tokenEndpoint,
          clientId: secret.client.clientId,
          ...(secret.client.clientSecret ? { clientSecret: secret.client.clientSecret } : {}),
          tokenEndpointAuthMethod: secret.client.tokenEndpointAuthMethod,
          refreshToken: secret.refreshToken,
          resource: secret.resource
        },
        this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}
      );
    } catch (error) {
      const message = `Token refresh failed: ${error instanceof Error ? error.message : "unknown error"}`;
      this.store.upsertMcpOAuthConnection({ ...row, state: "error", lastError: message.slice(0, 500) });
      this.options.onAudit?.({
        eventType: "mcp_server.oauth_refresh_failed",
        serverId,
        outcome: "failure",
        metadata: { error: message.slice(0, 300) }
      });
      throw new Error(`MCP server '${label}': ${message}. An admin may need to reconnect it.`);
    }
    // Refresh token rotation: keep the new one when the server issued one.
    const next: StoredOAuthSecret = {
      ...secret,
      accessToken: tokens.accessToken,
      tokenType: tokens.tokenType,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
      expiresAt: tokens.expiresAt,
      ...(tokens.scope ? { scope: tokens.scope } : {})
    };
    if (!tokens.expiresAt) delete next.expiresAt;
    const server = this.store.getMcpServer(serverId);
    const secretId = server ? this.writeSecret(server, row.secretId, next) : row.secretId;
    this.store.upsertMcpOAuthConnection({
      ...row,
      secretId,
      state: "connected",
      scope: next.scope ?? row.scope,
      expiresAt: next.expiresAt ?? null,
      hasRefreshToken: Boolean(next.refreshToken),
      lastRefreshAt: new Date().toISOString(),
      lastError: null
    });
    return next.accessToken;
  }

  /** Manual refresh from the UI. */
  async refreshNow(serverId: string): Promise<McpOAuthConnectionStatus> {
    await this.getAccessToken(serverId, { forceRefresh: true });
    return this.status(serverId);
  }

  /** Forget the tokens and the client registration. */
  disconnect(serverId: string): McpOAuthConnectionStatus {
    const row = this.store.getMcpOAuthConnection(serverId);
    if (row?.secretId) {
      this.secretService.deleteSecret(row.secretId);
    }
    this.store.deleteMcpOAuthConnection(serverId);
    for (const [state, entry] of this.pending) {
      if (entry.serverId === serverId) this.pending.delete(state);
    }
    return this.status(serverId);
  }

  /** Test seam: number of pending authorizations. */
  pendingCount(): number {
    this.prunePending();
    return this.pending.size;
  }
}

/** Escape text for the callback page. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/**
 * The page the authorization server's redirect lands on. It tells the
 * opener (the MCP servers page) how it went and closes itself; opened
 * without an opener it links back to the studio.
 */
export function renderOAuthCallbackPage(outcome: OAuthCallbackOutcome, webOrigin: string): { html: string; nonce: string } {
  const nonce = randomUUID().replace(/-/g, "");
  const message = JSON.stringify({ type: "l2m:mcp-oauth", serverId: outcome.serverId, ok: outcome.ok, ...(outcome.error ? { error: outcome.error } : {}) });
  const title = outcome.ok ? "MCP server connected" : "MCP server not connected";
  const body = outcome.ok
    ? "The MCP server is connected. You can close this window."
    : `Connecting the MCP server failed: ${outcome.error ?? "unknown error"}`;
  const safeMessage = message.replace(/</g, "\\u003c");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:32px 16px;background:#f7f7f5;color:#1d1d1b}@media (prefers-color-scheme: dark){body{background:#151513;color:#ecebe7}}main{max-width:480px;margin:0 auto}a{color:inherit}</style>
</head><body><main><h1 style="font-size:18px">${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p><p><a href="${escapeHtml(webOrigin)}">Back to L2M</a></p></main>
<script nonce="${nonce}">(function(){try{if(window.opener){window.opener.postMessage(${safeMessage}, ${JSON.stringify(webOrigin)});${outcome.ok ? "setTimeout(function(){window.close();},400);" : ""}}}catch(e){}})();</script>
</body></html>`;
  return { html, nonce };
}
