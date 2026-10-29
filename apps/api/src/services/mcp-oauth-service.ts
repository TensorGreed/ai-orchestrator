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
 * may show. Pending authorizations (state, PKCE verifier) are single-use,
 * bound to the admin's session and the server, short-lived, and kept in a
 * ChallengeStore: in memory, or (Phase 13.1 cluster mode) in the database,
 * sealed, so the callback may land on any instance.
 *
 * Phase 13.1 — in cluster mode a refresh runs under a cluster-wide lock per
 * connection and re-reads the stored token first: when another instance has
 * refreshed meanwhile, its token is used, so a rotating refresh token is
 * never spent twice. The in-process de-dup map stays as the fast path.
 *
 * Phase 10.7 — delegated credentials. A server with `credentialMode:
 * "delegated"` has no service connection; every user connects their own
 * account through the same flow (discovery, client registration, PKCE,
 * state bound to their session), and the tokens go into an internal secret
 * of their own (provider `mcp_oauth_user`) with a row in
 * `mcp_user_oauth_connections`. `getAccessToken` with a `userId` reads only
 * that user's connection, and never the service one.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  McpDelegatedCredentialError,
  McpOAuthError,
  buildAuthorizationUrl,
  createOAuthState,
  createPkcePair,
  discoverMcpOAuth,
  exchangeAuthorizationCode,
  refreshOAuthToken,
  registerOAuthClient,
  type FetchLike,
  type McpAccessTokenOptions,
  type McpOAuthTokenProvider,
  type OAuthTokenSet
} from "@ai-orchestrator/mcp-sdk";
import type { McpOAuthConnectionStatus, McpUserConnectionView } from "@ai-orchestrator/shared";
import type { McpOAuthConnectionRecord, McpServerRecord, McpUserOAuthConnectionRecord } from "../db/database.js";
import type { SecretService } from "./secret-service.js";
import type { Store } from "../db/store.js";
import { MemoryChallengeStore, type ChallengeStore } from "./challenge-store.js";

export const MCP_OAUTH_CALLBACK_PATH = "/api/mcp/oauth/callback";
export const MCP_OAUTH_SECRET_PROVIDER = "mcp_oauth";
/** Phase 10.7 — internal secrets holding one user's tokens for a delegated server. */
export const MCP_OAUTH_USER_SECRET_PROVIDER = "mcp_oauth_user";

/** Where the authorization server sends the browser back: MCP_OAUTH_REDIRECT_BASE_URL, else MCP_GATEWAY_PUBLIC_URL, else the first WEB_ORIGIN. */
/** Phase 10.7 — the web page where users connect their own accounts to delegated servers. */
export function resolveMcpConnectionsUrl(config: { WEB_ORIGIN: string }): string {
  const base = config.WEB_ORIGIN.split(",").map((entry) => entry.trim()).find(Boolean) || "http://localhost:5173";
  return `${base.replace(/\/+$/, "")}/?mode=connections`;
}

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
  /** Phase 10.7 — set for a user's own connection to a delegated server. */
  userId?: string;
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
  onAudit?: (event: { eventType: string; serverId: string; outcome: "success" | "failure"; metadata: Record<string, unknown> }) => void | Promise<void>;
  /** Phase 10.7 — where a user connects their own account; named in "not connected" errors. */
  connectionsUrl?: string;
  /** Phase 13.1 — where pending authorizations wait for their callback. Default: in this process. */
  challenges?: ChallengeStore;
  /**
   * Phase 13.1 — cluster mode: runs a refresh while holding a cluster-wide lock for `key` (one connection). With it,
   * the refresh re-reads the stored token and keeps one another instance stored meanwhile.
   */
  refreshLock?: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
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
  /** Phase 10.7 — the user whose own connection this was, for delegated servers. */
  userId?: string;
}

function hashSession(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const MAX_PENDING = 200;
/** Pending authorizations kept in memory at most (the oldest go first). */
export const MCP_OAUTH_MAX_PENDING = MAX_PENDING;
/** Phase 13.1 — how long a refresh waits for another instance's refresh of the same connection (cluster mode). */
export const MCP_OAUTH_REFRESH_LOCK_WAIT_MS = 30_000;

export class McpOAuthService implements McpOAuthTokenProvider {
  private readonly pending: ChallengeStore;
  private readonly refreshing = new Map<string, Promise<string>>();

  constructor(
    private readonly store: Store,
    private readonly secretService: SecretService,
    private readonly options: McpOAuthServiceOptions
  ) {
    this.pending = options.challenges ?? new MemoryChallengeStore({ maxPerKind: { mcp_oauth: MAX_PENDING } });
  }

  get redirectUri(): string {
    return this.options.redirectUri;
  }

  /** True when the server's connection is set up for OAuth. */
  static usesOAuth(server: Pick<McpServerRecord, "adapterId" | "connection">): boolean {
    return server.adapterId === "http_mcp" && String(server.connection.authType ?? "").trim().toLowerCase() === "oauth";
  }

  /** Phase 10.7 — true when every user connects their own account to the server. */
  static isDelegated(server: Pick<McpServerRecord, "adapterId" | "connection" | "credentialMode">): boolean {
    return server.credentialMode === "delegated" && McpOAuthService.usesOAuth(server);
  }

  private connectHint(): string {
    return this.options.connectionsUrl ? ` Connect it under My connections: ${this.options.connectionsUrl}` : " Connect it under My connections.";
  }

  /** Phase 10.7 — one user's connection to a delegated server, as the UI may show it (never a token). */
  async userStatus(server: Pick<McpServerRecord, "id" | "name">, userId: string, userEmail: string | null = null): Promise<McpUserConnectionView> {
    const row = await this.store.getMcpUserOAuthConnection(server.id, userId);
    return userConnectionView(server, row, userId, userEmail);
  }

  async status(serverId: string): Promise<McpOAuthConnectionStatus> {
    const row = await this.store.getMcpOAuthConnection(serverId);
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

  private async readSecret(row: Pick<McpOAuthConnectionRecord, "secretId"> | null): Promise<StoredOAuthSecret | null> {
    if (!row?.secretId) return null;
    const raw = await this.secretService.resolveInternalSecret(row.secretId);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as StoredOAuthSecret;
      return parsed && typeof parsed.accessToken === "string" ? parsed : null;
    } catch {
      return null;
    }
  }

  private async writeSecret(server: McpServerRecord, existingSecretId: string | null, value: StoredOAuthSecret, owner?: { userId: string; email?: string }): Promise<string> {
    const json = JSON.stringify(value);
    if (existingSecretId && await this.secretService.updateInternalSecret(existingSecretId, json)) {
      return existingSecretId;
    }
    return (await this.secretService.createSecret({
      name: (owner ? `MCP OAuth · ${server.name} · ${owner.email ?? owner.userId}` : `MCP OAuth · ${server.name}`).slice(0, 120),
      provider: owner ? MCP_OAUTH_USER_SECRET_PROVIDER : MCP_OAUTH_SECRET_PROVIDER,
      value: json,
      projectId: server.projectId ?? undefined
    })).secretId;
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
    /** Phase 10.7 — connect this user's own account to a delegated server. */
    userId?: string;
  }): Promise<{ authorizationUrl: string; expiresAt: string; redirectUri: string }> {
    const { server } = input;
    if (!McpOAuthService.usesOAuth(server)) {
      throw new McpOAuthUserError(`MCP server '${server.name}' does not use OAuth. Set its auth type to OAuth first.`);
    }
    if (input.userId && server.credentialMode !== "delegated") {
      throw new McpOAuthUserError(`MCP server '${server.name}' uses one shared connection; an admin connects it on the MCP servers page.`);
    }
    if (!input.userId && server.credentialMode === "delegated") {
      throw new McpOAuthUserError(`MCP server '${server.name}' uses each user's own account. Users connect under My connections.`);
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
      const previous = input.userId
        ? await this.readSecret(await this.store.getMcpUserOAuthConnection(server.id, input.userId))
        : await this.readSecret(await this.store.getMcpOAuthConnection(server.id));
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
    const authorization: PendingAuthorization = {
      serverId: server.id,
      ...(input.userId ? { userId: input.userId } : {}),
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
    };
    await this.pending.issue({
      kind: "mcp_oauth",
      id: state,
      userId: input.userId ?? null,
      scope: server.id,
      payload: authorization,
      ttlMs: this.options.stateTtlMs
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
    /**
     * Phase 10.7 — who is signed in to the browser finishing the flow. A
     * user's own connection completes only for that same user; the shared
     * service connection only for an admin.
     */
    actor?: { userId: string; isAdmin: boolean } | null;
  }): Promise<OAuthCallbackOutcome> {
    const state = typeof input.state === "string" ? input.state : "";
    const consumed = state ? await this.pending.consume<PendingAuthorization>("mcp_oauth", state) : null;
    if (!consumed) {
      return { serverId: null, ok: false, error: "This authorization link is unknown or was already used. Start again from the MCP servers page." };
    }
    const pending = consumed.payload;
    if (consumed.expired || pending.expiresAtMs <= Date.now()) {
      return { serverId: pending.serverId, ok: false, error: "This authorization link expired. Start again from the MCP servers page." };
    }
    if (!input.sessionId || hashSession(input.sessionId) !== pending.sessionHash) {
      return {
        serverId: pending.serverId,
        ok: false,
        error: "This authorization was started from a different session. Start again from the MCP servers page."
      };
    }
    if (input.actor !== undefined) {
      if (pending.userId ? input.actor?.userId !== pending.userId : !input.actor?.isAdmin) {
        return {
          serverId: pending.serverId,
          ok: false,
          error: pending.userId
            ? "This authorization belongs to a different user. Sign in as the user who started it and connect again."
            : "Sign in to L2M as an admin in this browser, then connect the server again."
        };
      }
    }
    const server = await this.store.getMcpServer(pending.serverId);
    if (!server) {
      return { serverId: pending.serverId, ok: false, error: "The MCP server no longer exists." };
    }
    const userId = pending.userId;
    if (!userId && server.credentialMode === "delegated") {
      return { serverId: server.id, ok: false, error: "The MCP server now uses each user's own account; users connect under My connections." };
    }
    const recordError = async (message: string) => (userId ? await this.recordUserError(server.id, userId, message) : await this.recordError(server.id, message));
    const failed = (message: string): OAuthCallbackOutcome => ({ serverId: server.id, ok: false, error: message, ...(userId ? { userId } : {}) });
    if (userId && server.credentialMode !== "delegated") {
      return failed("The MCP server no longer uses each user's own account.");
    }
    if (input.error) {
      const message = `The authorization server refused: ${(input.errorDescription || input.error).slice(0, 300)}`;
      await recordError(message);
      return failed(message);
    }
    if (!input.code) {
      return failed("The authorization server sent no code.");
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
      await recordError(message);
      return failed(message);
    }

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
    const now = new Date().toISOString();
    if (userId) {
      const existingUser = await this.store.getMcpUserOAuthConnection(server.id, userId);
      const userSecretId = await this.writeSecret(server, existingUser?.secretId ?? null, secret, { userId, email: pending.userEmail });
      await this.store.upsertMcpUserOAuthConnection({
        serverId: server.id,
        userId,
        secretId: userSecretId,
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
        lastError: null
      });
      return { serverId: server.id, ok: true, userId };
    }
    const existing = await this.store.getMcpOAuthConnection(server.id);
    const secretId = await this.writeSecret(server, existing?.secretId ?? null, secret);
    await this.store.upsertMcpOAuthConnection({
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

  private async recordUserError(serverId: string, userId: string, message: string): Promise<void> {
    const row = await this.store.getMcpUserOAuthConnection(serverId, userId);
    await this.store.upsertMcpUserOAuthConnection({
      serverId,
      userId,
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
      lastError: message.slice(0, 500)
    });
  }

  private async recordError(serverId: string, message: string): Promise<void> {
    const row = await this.store.getMcpOAuthConnection(serverId);
    await this.store.upsertMcpOAuthConnection({
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

  /**
   * McpOAuthTokenProvider: the access token for a registry server, refreshed
   * when due or when forced. Phase 10.7 — a delegated server answers only
   * with the given user's own token; without a user, or for a user who has
   * not connected, it fails with a message that links to My connections.
   */
  async getAccessToken(registryServerId: string, options?: McpAccessTokenOptions): Promise<string> {
    const server = await this.store.getMcpServer(registryServerId);
    const label = server?.name ?? registryServerId;
    if (server?.credentialMode === "delegated") {
      if (!options?.userId) {
        throw new McpDelegatedCredentialError(`MCP server '${label}' uses each user's own account, and this call has no user to act for.`);
      }
      return this.getUserAccessToken(server, options.userId, options.forceRefresh === true);
    }
    const row = await this.store.getMcpOAuthConnection(registryServerId);
    const secret = await this.readSecret(row);
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
      await this.markExpired(row, `The access token for '${label}' expired and the server issued no refresh token. Reconnect it.`);
      throw new Error(`MCP server '${label}': the OAuth access token expired and cannot be refreshed. An admin must reconnect it.`);
    }
    const running = this.refreshing.get(registryServerId);
    if (running) return running;
    const refresh = this.underRefreshLock(registryServerId, () => this.refresh(registryServerId, label, secret.accessToken)).finally(() => {
      this.refreshing.delete(registryServerId);
    });
    this.refreshing.set(registryServerId, refresh);
    return refresh;
  }

  private async markExpired(row: McpOAuthConnectionRecord, message: string): Promise<void> {
    await this.store.upsertMcpOAuthConnection({ ...row, state: "expired", lastError: message.slice(0, 500) });
  }

  /** Runs `fn` under the cluster-wide refresh lock for `key` when there is one (cluster mode), else directly. */
  private async underRefreshLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.options.refreshLock ? await this.options.refreshLock(key, fn) : await fn();
  }

  /**
   * Cluster mode, under the refresh lock: the token another instance stored while this one waited, if any. `seen` is
   * the access token that made this instance decide to refresh; a different, not yet due token replaces it.
   */
  private refreshedElsewhere(secret: StoredOAuthSecret, seen: string | undefined): string | null {
    if (!this.options.refreshLock || seen === undefined || secret.accessToken === seen) return null;
    const expiresAtMs = secret.expiresAt ? Date.parse(secret.expiresAt) : Number.POSITIVE_INFINITY;
    return expiresAtMs - Date.now() > this.options.refreshSkewMs ? secret.accessToken : null;
  }

  private async refresh(serverId: string, label: string, seenAccessToken?: string): Promise<string> {
    const row = await this.store.getMcpOAuthConnection(serverId);
    const secret = await this.readSecret(row);
    if (!row || !secret?.refreshToken) {
      throw new Error(`MCP server '${label}' is not connected.`);
    }
    const current = this.refreshedElsewhere(secret, seenAccessToken);
    if (current !== null) return current;
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
      await this.store.upsertMcpOAuthConnection({ ...row, state: "error", lastError: message.slice(0, 500) });
      await this.options.onAudit?.({
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
    const server = await this.store.getMcpServer(serverId);
    const secretId = server ? await this.writeSecret(server, row.secretId, next) : row.secretId;
    await this.store.upsertMcpOAuthConnection({
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

  private async getUserAccessToken(server: McpServerRecord, userId: string, forceRefresh: boolean): Promise<string> {
    const label = server.name;
    const row = await this.store.getMcpUserOAuthConnection(server.id, userId);
    const secret = await this.readSecret(row);
    if (!row || !secret) {
      throw new McpDelegatedCredentialError(
        `MCP server '${label}' uses each user's own account, and the user this run acts for has not connected theirs.${this.connectHint()}`,
        this.options.connectionsUrl
      );
    }
    const expiresAtMs = secret.expiresAt ? Date.parse(secret.expiresAt) : Number.POSITIVE_INFINITY;
    const due = expiresAtMs - Date.now() <= this.options.refreshSkewMs;
    if (!forceRefresh && !due) return secret.accessToken;
    if (!secret.refreshToken) {
      await this.store.upsertMcpUserOAuthConnection({
        ...row,
        state: "expired",
        lastError: `The access token for '${label}' expired and the server issued no refresh token. Reconnect it.`
      });
      throw new McpDelegatedCredentialError(
        `MCP server '${label}': the user's access token expired and cannot be refreshed.${this.connectHint()}`,
        this.options.connectionsUrl
      );
    }
    const key = `${server.id}::${userId}`;
    const running = this.refreshing.get(key);
    if (running) return running;
    const refresh = this.underRefreshLock(key, () => this.refreshUser(server, userId, secret.accessToken)).finally(() => {
      this.refreshing.delete(key);
    });
    this.refreshing.set(key, refresh);
    return refresh;
  }

  private async refreshUser(server: McpServerRecord, userId: string, seenAccessToken?: string): Promise<string> {
    const row = await this.store.getMcpUserOAuthConnection(server.id, userId);
    const secret = await this.readSecret(row);
    if (!row || !secret?.refreshToken) {
      throw new McpDelegatedCredentialError(`MCP server '${server.name}': the user's account is not connected.${this.connectHint()}`, this.options.connectionsUrl);
    }
    const current = this.refreshedElsewhere(secret, seenAccessToken);
    if (current !== null) return current;
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
      await this.store.upsertMcpUserOAuthConnection({ ...row, state: "error", lastError: message.slice(0, 500) });
      await this.options.onAudit?.({
        eventType: "mcp_server.user_oauth_refresh_failed",
        serverId: server.id,
        outcome: "failure",
        metadata: { userId, error: message.slice(0, 300) }
      });
      throw new McpDelegatedCredentialError(`MCP server '${server.name}': ${message}.${this.connectHint()}`, this.options.connectionsUrl);
    }
    const next: StoredOAuthSecret = {
      ...secret,
      accessToken: tokens.accessToken,
      tokenType: tokens.tokenType,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
      expiresAt: tokens.expiresAt,
      ...(tokens.scope ? { scope: tokens.scope } : {})
    };
    if (!tokens.expiresAt) delete next.expiresAt;
    const secretId = await this.writeSecret(server, row.secretId, next, { userId });
    await this.store.upsertMcpUserOAuthConnection({
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

  /** Phase 10.7 — forget one user's tokens for a delegated server. Returns false when they had none. */
  async disconnectUser(serverId: string, userId: string): Promise<boolean> {
    const row = await this.store.getMcpUserOAuthConnection(serverId, userId);
    if (row?.secretId) {
      await this.secretService.deleteSecret(row.secretId);
    }
    const removed = await this.store.deleteMcpUserOAuthConnection(serverId, userId);
    await this.pending.discard("mcp_oauth", { scope: serverId, userId });
    return removed || Boolean(row);
  }

  /** Phase 10.7 — forget every user's tokens for a server (it was deleted or left delegated mode). */
  async disconnectAllUsers(serverId: string): Promise<number> {
    const rows = await this.store.listMcpUserOAuthConnections({ serverId });
    for (const row of rows) await this.disconnectUser(serverId, row.userId);
    return rows.length;
  }

  /** Phase 10.7 — forget a user's tokens for every server (the user was deleted). */
  async disconnectUserEverywhere(userId: string): Promise<number> {
    const rows = await this.store.listMcpUserOAuthConnections({ userId });
    for (const row of rows) await this.disconnectUser(row.serverId, userId);
    return rows.length;
  }

  /** Manual refresh from the UI. */
  async refreshNow(serverId: string): Promise<McpOAuthConnectionStatus> {
    await this.getAccessToken(serverId, { forceRefresh: true });
    return await this.status(serverId);
  }

  /** Forget the tokens and the client registration. */
  async disconnect(serverId: string): Promise<McpOAuthConnectionStatus> {
    const row = await this.store.getMcpOAuthConnection(serverId);
    if (row?.secretId) {
      await this.secretService.deleteSecret(row.secretId);
    }
    await this.store.deleteMcpOAuthConnection(serverId);
    await this.pending.discard("mcp_oauth", { scope: serverId, userId: null });
    return await this.status(serverId);
  }
}

/** Phase 10.7 — the shape the UI sees for one user's connection (never a token or secret id). */
export function userConnectionView(
  server: Pick<McpServerRecord, "id" | "name">,
  row: McpUserOAuthConnectionRecord | null,
  userId: string,
  userEmail: string | null
): McpUserConnectionView {
  let state: McpUserConnectionView["state"] = row?.state ?? "not_connected";
  if (row && state === "connected" && row.expiresAt && Date.parse(row.expiresAt) <= Date.now() && !row.hasRefreshToken) {
    state = "expired";
  }
  return {
    serverId: server.id,
    serverName: server.name,
    userId,
    userEmail,
    state,
    subject: row?.subject ?? null,
    scope: row?.scope ?? null,
    expiresAt: row?.expiresAt ?? null,
    hasRefreshToken: row?.hasRefreshToken ?? false,
    connectedAt: row?.connectedAt ?? null,
    lastRefreshAt: row?.lastRefreshAt ?? null,
    lastError: row?.lastError ?? null
  };
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
