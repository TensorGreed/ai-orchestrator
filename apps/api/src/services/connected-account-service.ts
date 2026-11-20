/**
 * Connected accounts: people press "Connect Slack" (Google, GitHub, Microsoft, Notion), sign in at the provider in a
 * popup, and get a credential nodes can use like any secret. OAuth 2.0 authorization code with PKCE (S256) and `state`.
 *
 * Self-hosted: each deployment registers its own OAuth app with the provider. An admin enters the client id and secret
 * once for the whole instance, or someone with `secret:write` in a project for that project (a project's own app wins).
 * The client secret is an internal secret (provider `oauth_client`): never returned, never handed to a node.
 *
 * A connected account is a secret with provider `oauth_account` in the project it was connected for. Its encrypted
 * value is the token set (access token, refresh token, expiry, scopes); nothing returns it. `resolveSecret` of such a
 * secret asks this service for the current access token, renewed shortly before it expires; a server's 401 to a token
 * a run sent renews it once more (refreshRejectedForRun). A refresh the provider refuses marks the account "needs
 * reconnect"; Reconnect runs the sign-in again and keeps the same secret id, so nodes keep working.
 *
 * Shared with MCP OAuth (mcp-oauth-service.ts): PKCE and state (`createPkcePair`, `createOAuthState`), the pending
 * authorization store (ChallengeStore, kind `oauth_account`: single use, bound to the signed-in session and user,
 * short-lived, in the database in cluster mode), the cluster-wide refresh lock (createClusterRefreshLock), and the
 * callback page's shape. What differs is kept here: fixed provider endpoints from the provider registry
 * (@ai-orchestrator/connector-sdk) instead of discovery, each provider's own token request and response format, and
 * egress limited to the provider's own hosts with redirects refused.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  OAuthProviderError,
  buildProviderAuthorizationUrl,
  buildProviderTokenRequest,
  isProviderUrl,
  isValidMicrosoftTenant,
  providerUrl,
  scopesFor,
  type OAuthProviderDefinition,
  type OAuthProviderRegistry,
  type OAuthProviderTokens
} from "@ai-orchestrator/connector-sdk";
import { createOAuthState, createPkcePair, type FetchLike } from "@ai-orchestrator/mcp-sdk";
import {
  CONNECTED_ACCOUNT_SECRET_PROVIDER,
  isConnectedAccountProviderId,
  type ConnectedAccountProviderId,
  type ConnectedAccountProviderView,
  type ConnectedAccountView
} from "@ai-orchestrator/shared";
import type { OAuthAccountRecord, OAuthAppRecord, Store } from "../db/store.js";
import type { ChallengeStore } from "./challenge-store.js";
import { OAUTH_CLIENT_SECRET_PROVIDER, type SecretService } from "./secret-service.js";

export const CONNECT_CALLBACK_PATH = "/api/connect/callback";

/** `<APP_PUBLIC_URL or the first WEB_ORIGIN>/api/connect/callback`: the exact redirect URL people register. */
export function resolveConnectRedirectUri(config: { APP_PUBLIC_URL: string; WEB_ORIGIN: string }): string {
  const base =
    config.APP_PUBLIC_URL.trim() || config.WEB_ORIGIN.split(",").map((entry) => entry.trim()).find(Boolean) || "http://localhost:5173";
  return `${base.replace(/\/+$/, "")}${CONNECT_CALLBACK_PATH}`;
}

export class ConnectedAccountError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400
  ) {
    super(message);
    this.name = "ConnectedAccountError";
  }
}

/** The encrypted value of an `oauth_account` secret. */
interface StoredAccountTokens {
  version: 1;
  providerId: ConnectedAccountProviderId;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scopes: string[];
}

interface PendingConnect {
  providerId: ConnectedAccountProviderId;
  projectId: string;
  userId: string;
  userEmail: string;
  /** sha256 of the session id that started it; the callback must come from the same session. */
  sessionHash: string;
  codeVerifier: string;
  redirectUri: string;
  appId: string;
  scopes: string[];
  /** Reconnect: the account secret whose tokens the sign-in replaces. */
  reconnectSecretId?: string;
  /** The web origin (one of WEB_ORIGIN) the sign-in was started from: the callback page's message goes there. */
  openerOrigin?: string;
  expiresAtMs: number;
}

export interface ConnectCallbackOutcome {
  ok: boolean;
  providerId: ConnectedAccountProviderId | null;
  secretId?: string;
  projectId?: string;
  accountLabel?: string | null;
  reconnected?: boolean;
  /** Reconnect: the label before, and whether a different account signed in. */
  previousAccountLabel?: string | null;
  accountChanged?: boolean;
  /** Where the callback page posts its message (the starting page's origin); unset = the first WEB_ORIGIN. */
  openerOrigin?: string;
  error?: string;
}

export interface ConnectedAccountAuditEvent {
  eventType: string;
  outcome: "success" | "failure";
  secretId: string;
  projectId: string;
  metadata: Record<string, unknown>;
}

export interface ConnectedAccountServiceOptions {
  registry: OAuthProviderRegistry;
  redirectUri: string;
  stateTtlMs: number;
  refreshSkewMs: number;
  challenges: ChallengeStore;
  /** Cluster mode: one refresh per account across the instances (a rotating refresh token is spent once). */
  refreshLock?: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
  /** Tests: the fetch for provider requests (still limited to the provider's hosts). */
  fetchImpl?: FetchLike;
  /** Audit for events without a request (a background refresh the provider refused). */
  onAudit?: (event: ConnectedAccountAuditEvent) => void | Promise<void>;
}

const PROVIDER_TIMEOUT_MS = 15_000;
/** Access tokens handed to runs, remembered (as hashes) so a 401 to one can be answered with a fresh token. */
const MAX_ISSUED = 10_000;
/** After a renewal, a run's 401 does not renew the account again for this long. */
const REJECTION_REFRESH_COOLDOWN_MS = 60_000;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function appIdFor(providerId: string, projectId: string | null): string {
  return `${providerId}:${projectId ?? "*"}`;
}

function cleanClientId(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new ConnectedAccountError("Enter the client id from the provider's app settings.");
  if (text.length > 512 || /[\s\u0000-\u001f]/.test(text)) throw new ConnectedAccountError("The client id is not valid: it must be one line without spaces.");
  return text;
}

function parseStored(raw: string | undefined): StoredAccountTokens | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredAccountTokens>;
    if (value.version !== 1 || typeof value.accessToken !== "string" || !isConnectedAccountProviderId(value.providerId)) return null;
    return {
      version: 1,
      providerId: value.providerId,
      accessToken: value.accessToken,
      ...(typeof value.refreshToken === "string" && value.refreshToken ? { refreshToken: value.refreshToken } : {}),
      ...(typeof value.expiresAt === "string" && value.expiresAt ? { expiresAt: value.expiresAt } : {}),
      scopes: Array.isArray(value.scopes) ? value.scopes.filter((scope): scope is string => typeof scope === "string") : []
    };
  } catch {
    return null;
  }
}

/** A plain one-line message from a provider failure, without anything from the response but its short error code. */
function failureMessage(error: unknown): string {
  if (error instanceof OAuthProviderError || error instanceof ConnectedAccountError) return error.message;
  if (error instanceof Error && error.name === "TimeoutError") return "The provider did not answer in time.";
  return "The provider could not be reached.";
}

export class ConnectedAccountService {
  /** sha256(access token) → secret id, for tokens handed to runs (bounded; oldest first out). */
  private readonly issued = new Map<string, string>();
  private readonly refreshing = new Map<string, Promise<string>>();

  constructor(
    private readonly store: Store,
    private readonly secretService: SecretService,
    private readonly options: ConnectedAccountServiceOptions
  ) {}

  get redirectUri(): string {
    return this.options.redirectUri;
  }

  private provider(providerId: string): OAuthProviderDefinition {
    const definition = isConnectedAccountProviderId(providerId) ? this.options.registry.get(providerId) : undefined;
    if (!definition) throw new ConnectedAccountError(`Unknown provider '${providerId}'.`, 404);
    return definition;
  }

  /**
   * Every request to a provider: only to its own hosts (https, or a loopback mock in tests), never following a
   * redirect, with a time limit.
   */
  private async providerFetch(definition: OAuthProviderDefinition, url: string, init: RequestInit): Promise<Response> {
    if (!isProviderUrl(definition, url)) {
      throw new ConnectedAccountError(`L2M only contacts ${definition.label}'s own servers for this account.`, 502);
    }
    const fetchImpl = this.options.fetchImpl ?? fetch;
    return await fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  }

  private async readJson(response: Response): Promise<Record<string, unknown>> {
    const text = await response.text();
    if (!text.trim()) return {};
    try {
      const parsed = JSON.parse(text) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      // GitHub answers a form unless asked for JSON; anything else unreadable is an error below.
      return Object.fromEntries(new URLSearchParams(text));
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // OAuth apps
  // ---------------------------------------------------------------------------------------------------------------

  /** The app people connect with in this project: the project's own, else the instance's. */
  async appFor(providerId: string, projectId: string): Promise<OAuthAppRecord | null> {
    return (await this.store.getOAuthApp(appIdFor(providerId, projectId))) ?? (await this.store.getOAuthApp(appIdFor(providerId, null)));
  }

  async listProviders(projectId: string, permissions: { canConfigureProject: boolean; canConfigureInstance: boolean }): Promise<ConnectedAccountProviderView[]> {
    const views: ConnectedAccountProviderView[] = [];
    for (const definition of this.options.registry.list()) {
      const app = await this.appFor(definition.id, projectId);
      views.push({
        id: definition.id,
        label: definition.label,
        configured: Boolean(app?.clientSecretId),
        appScope: app ? (app.projectId ? "project" : "instance") : null,
        clientId: app?.clientId ?? null,
        tenant: definition.tenantInPath ? (app?.tenant ?? null) : null,
        redirectUrl: this.options.redirectUri,
        consoleUrl: definition.consoleUrl,
        setupSteps: definition.setupSteps.map((step) => step.replace("{redirectUrl}", this.options.redirectUri)),
        scopeSets: definition.scopeSets.map(({ id, label, description, default: isDefault }) => ({ id, label, description, default: isDefault })),
        canConfigureProject: permissions.canConfigureProject,
        canConfigureInstance: permissions.canConfigureInstance
      });
    }
    return views;
  }

  /** Sets up (or changes) the app for a project or, with `projectId` null, the instance. The client secret is kept when not sent. */
  async saveApp(input: {
    providerId: string;
    projectId: string | null;
    clientId: unknown;
    clientSecret?: unknown;
    tenant?: unknown;
    actorEmail: string;
  }): Promise<OAuthAppRecord> {
    const definition = this.provider(input.providerId);
    const clientId = cleanClientId(input.clientId);
    const clientSecret = typeof input.clientSecret === "string" ? input.clientSecret.trim() : "";
    if (clientSecret.length > 4096) throw new ConnectedAccountError("The client secret is too long.");
    let tenant: string | null = null;
    if (definition.tenantInPath) {
      const raw = typeof input.tenant === "string" ? input.tenant.trim() : "";
      if (raw && !isValidMicrosoftTenant(raw)) throw new ConnectedAccountError("The tenant must be a directory (tenant) id, a domain, or common.");
      tenant = raw && raw.toLowerCase() !== "common" ? raw : null;
    }
    const id = appIdFor(definition.id, input.projectId);
    const existing = await this.store.getOAuthApp(id);
    let clientSecretId = existing?.clientSecretId ?? null;
    if (clientSecret) {
      if (clientSecretId && (await this.secretService.updateInternalSecret(clientSecretId, clientSecret))) {
        // Replaced in place.
      } else {
        clientSecretId = (
          await this.secretService.createSecret({ name: `${definition.label} OAuth app (${input.projectId ?? "instance"})`, provider: OAUTH_CLIENT_SECRET_PROVIDER, value: clientSecret })
        ).secretId;
      }
    }
    if (!clientSecretId) throw new ConnectedAccountError("Enter the client secret from the provider's app settings.");
    return await this.store.saveOAuthApp({ id, providerId: definition.id, projectId: input.projectId, clientId, clientSecretId, tenant, updatedBy: input.actorEmail });
  }

  /** Removes the app and its client secret. Accounts connected with it need reconnecting once their token expires. */
  async deleteApp(providerId: string, projectId: string | null): Promise<boolean> {
    const definition = this.provider(providerId);
    const app = await this.store.getOAuthApp(appIdFor(definition.id, projectId));
    if (!app) return false;
    await this.store.deleteOAuthApp(app.id);
    if (app.clientSecretId) await this.secretService.deleteSecret(app.clientSecretId);
    return true;
  }

  private async clientSecretFor(app: OAuthAppRecord): Promise<string | null> {
    return app.clientSecretId ? ((await this.secretService.resolveInternalSecret(app.clientSecretId)) ?? null) : null;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Connect
  // ---------------------------------------------------------------------------------------------------------------

  /** Starts a sign-in: returns the provider's authorization URL for the popup. */
  async startConnect(input: {
    providerId: string;
    projectId: string;
    scopeSetIds?: readonly string[];
    sessionId: string;
    userId: string;
    userEmail: string;
    reconnectSecretId?: string;
    /** Already checked against WEB_ORIGIN by the route. */
    openerOrigin?: string;
  }): Promise<{ authorizationUrl: string; expiresAt: string; redirectUri: string }> {
    const definition = this.provider(input.providerId);
    let projectId = input.projectId;
    let scopeSetIds = input.scopeSetIds;
    if (input.reconnectSecretId) {
      const account = await this.store.getOAuthAccount(input.reconnectSecretId);
      if (!account || account.providerId !== definition.id) throw new ConnectedAccountError("That connected account no longer exists.", 404);
      // A reconnect stays in the account's project and asks for what was granted before (plus any new sets chosen).
      projectId = account.projectId;
      if (!scopeSetIds || scopeSetIds.length === 0) {
        scopeSetIds = definition.scopeSets.filter((set) => set.scopes.every((scope) => account.scopes.includes(scope))).map((set) => set.id);
      }
    }
    const unknown = (scopeSetIds ?? []).filter((id) => !definition.scopeSets.some((set) => set.id === id));
    if (unknown.length > 0) throw new ConnectedAccountError(`Unknown permission set '${unknown[0]}' for ${definition.label}.`);
    const app = await this.appFor(definition.id, projectId);
    if (!app || !app.clientSecretId) {
      throw new ConnectedAccountError(`${definition.label} is not set up yet. An admin (or someone who manages secrets in this project) enters the OAuth app's client id and secret first.`, 409);
    }
    const scopes = scopesFor(definition, scopeSetIds);
    const pkce = createPkcePair();
    const state = createOAuthState();
    const expiresAtMs = Date.now() + this.options.stateTtlMs;
    const pending: PendingConnect = {
      providerId: definition.id,
      projectId,
      userId: input.userId,
      userEmail: input.userEmail,
      sessionHash: hash(input.sessionId),
      codeVerifier: pkce.verifier,
      redirectUri: this.options.redirectUri,
      appId: app.id,
      scopes,
      ...(input.reconnectSecretId ? { reconnectSecretId: input.reconnectSecretId } : {}),
      ...(input.openerOrigin ? { openerOrigin: input.openerOrigin } : {}),
      expiresAtMs
    };
    await this.options.challenges.issue({ kind: "oauth_account", id: state, userId: input.userId, scope: projectId, payload: pending, ttlMs: this.options.stateTtlMs });
    let authorizationUrl: string;
    try {
      authorizationUrl = buildProviderAuthorizationUrl(definition, {
        clientId: app.clientId,
        redirectUri: this.options.redirectUri,
        state,
        codeChallenge: pkce.challenge,
        scopes,
        ...(app.tenant ? { tenant: app.tenant } : {})
      });
    } catch (error) {
      throw new ConnectedAccountError(failureMessage(error));
    }
    return { authorizationUrl, expiresAt: new Date(expiresAtMs).toISOString(), redirectUri: this.options.redirectUri };
  }

  /**
   * The provider sent the browser back. The state must exist, be unexpired, come from the session and user that
   * started it, and is used up whatever happens. `authorize` re-checks that the person may still add secrets to the
   * project (a role may have changed while they were away); it returns a refusal message or null.
   */
  async completeConnect(input: {
    state: unknown;
    code: unknown;
    error?: unknown;
    errorDescription?: unknown;
    sessionId: string | null;
    userId: string | null;
    authorize: (pending: { projectId: string; reconnectSecretId?: string }) => Promise<string | null>;
  }): Promise<ConnectCallbackOutcome> {
    const state = typeof input.state === "string" ? input.state : "";
    const consumed = state ? await this.options.challenges.consume<PendingConnect>("oauth_account", state) : null;
    if (!consumed) return { ok: false, providerId: null, error: "This sign-in link is unknown or was already used. Start again from Connected accounts." };
    const pending = consumed.payload;
    const outcome = await this.finishConnect(input, pending, consumed.expired);
    return pending.openerOrigin ? { ...outcome, openerOrigin: pending.openerOrigin } : outcome;
  }

  private async finishConnect(
    input: Parameters<ConnectedAccountService["completeConnect"]>[0],
    pending: PendingConnect,
    expired: boolean
  ): Promise<ConnectCallbackOutcome> {
    const fail = (error: string): ConnectCallbackOutcome => ({ ok: false, providerId: pending.providerId, projectId: pending.projectId, error });
    if (expired || pending.expiresAtMs <= Date.now()) return fail("This sign-in took too long. Start again from Connected accounts.");
    if (!input.sessionId || hash(input.sessionId) !== pending.sessionHash || input.userId !== pending.userId) {
      return fail("This sign-in was started by another session. Sign in to L2M as the person who started it and connect again.");
    }
    const refusal = await input.authorize({ projectId: pending.projectId, ...(pending.reconnectSecretId ? { reconnectSecretId: pending.reconnectSecretId } : {}) });
    if (refusal) return fail(refusal);
    const definition = this.options.registry.get(pending.providerId);
    if (!definition) return fail("The provider is no longer available.");
    if (typeof input.error === "string" && input.error) {
      const detail = typeof input.errorDescription === "string" && input.errorDescription ? input.errorDescription : input.error;
      return fail(`${definition.label} did not connect: ${detail.slice(0, 200)}`);
    }
    const code = typeof input.code === "string" ? input.code : "";
    if (!code) return fail(`${definition.label} sent no authorization code.`);
    const app = await this.store.getOAuthApp(pending.appId);
    const clientSecret = app ? await this.clientSecretFor(app) : null;
    if (!app || !clientSecret) return fail(`The ${definition.label} OAuth app was removed while signing in. Set it up again and connect.`);

    let tokens: OAuthProviderTokens;
    try {
      tokens = await this.tokenRequest(definition, app, clientSecret, {
        type: "authorization_code",
        code,
        codeVerifier: pending.codeVerifier,
        redirectUri: pending.redirectUri
      });
    } catch (error) {
      return fail(`${definition.label} did not connect: ${failureMessage(error)}`);
    }
    const accountLabel = tokens.accountLabel ?? (await this.readIdentity(definition, tokens.accessToken));
    const now = new Date().toISOString();
    const scopes = tokens.scopes.length > 0 ? tokens.scopes : pending.scopes;

    if (pending.reconnectSecretId) {
      const account = await this.store.getOAuthAccount(pending.reconnectSecretId);
      if (!account || account.providerId !== definition.id) return fail("That connected account was removed while signing in. Connect it again.");
      const previous = parseStored(await this.secretService.readConnectedAccountValue(account.secretId));
      // Someone else signed in: their tokens only. The old account's refresh token is never kept with them.
      const accountChanged = Boolean(accountLabel && account.accountLabel && accountLabel !== account.accountLabel);
      const stored = this.storedTokens(definition.id, tokens, scopes, accountChanged ? undefined : previous?.refreshToken);
      await this.writeAccountSecret(account.secretId, stored);
      await this.store.saveOAuthAccount({
        ...account,
        appId: app.id,
        accountLabel: accountLabel ?? account.accountLabel,
        scopes,
        status: "connected",
        lastError: null,
        expiresAt: stored.expiresAt ?? null,
        hasRefreshToken: Boolean(stored.refreshToken),
        connectedBy: pending.userEmail,
        connectedAt: now,
        lastRefreshAt: null
      });
      return {
        ok: true,
        providerId: definition.id,
        secretId: account.secretId,
        projectId: account.projectId,
        accountLabel: accountLabel ?? account.accountLabel,
        reconnected: true,
        previousAccountLabel: account.accountLabel,
        accountChanged
      };
    }

    const stored = this.storedTokens(definition.id, tokens, scopes);
    const name = `${definition.label} · ${accountLabel ?? "account"}`.slice(0, 120);
    const { secretId } = await this.secretService.createSecret({ name, provider: CONNECTED_ACCOUNT_SECRET_PROVIDER, value: JSON.stringify(stored), projectId: pending.projectId });
    await this.store.saveOAuthAccount({
      secretId,
      providerId: definition.id,
      projectId: pending.projectId,
      appId: app.id,
      accountLabel: accountLabel ?? null,
      scopes,
      status: "connected",
      lastError: null,
      expiresAt: stored.expiresAt ?? null,
      hasRefreshToken: Boolean(stored.refreshToken),
      connectedBy: pending.userEmail,
      connectedAt: now,
      lastRefreshAt: null
    });
    return { ok: true, providerId: definition.id, secretId, projectId: pending.projectId, accountLabel: accountLabel ?? null };
  }

  private storedTokens(providerId: ConnectedAccountProviderId, tokens: OAuthProviderTokens, scopes: string[], keepRefreshToken?: string): StoredAccountTokens {
    const refreshToken = tokens.refreshToken ?? keepRefreshToken;
    return {
      version: 1,
      providerId,
      accessToken: tokens.accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      ...(tokens.expiresIn ? { expiresAt: new Date(Date.now() + tokens.expiresIn * 1000).toISOString() } : {}),
      scopes
    };
  }

  private async writeAccountSecret(secretId: string, value: StoredAccountTokens): Promise<void> {
    if (!(await this.secretService.updateConnectedAccountValue(secretId, JSON.stringify(value)))) {
      throw new ConnectedAccountError("The connected account's secret is missing.", 404);
    }
  }

  private async tokenRequest(
    definition: OAuthProviderDefinition,
    app: OAuthAppRecord,
    clientSecret: string,
    grant: Parameters<typeof buildProviderTokenRequest>[1]["grant"]
  ): Promise<OAuthProviderTokens> {
    const request = buildProviderTokenRequest(definition, { clientId: app.clientId, clientSecret, ...(app.tenant ? { tenant: app.tenant } : {}), grant });
    const response = await this.providerFetch(definition, request.url, request.init);
    const json = await this.readJson(response);
    if (!response.ok) {
      const code = typeof json.error === "string" ? json.error.slice(0, 80) : `HTTP ${response.status}`;
      const description = typeof json.error_description === "string" ? `: ${json.error_description.slice(0, 160)}` : "";
      throw new TokenRefusedError(`${definition.label} refused the request (${code}${description}).`, response.status, typeof json.error === "string" ? json.error : undefined);
    }
    return definition.parseTokenResponse(json);
  }

  /** Best effort: the account's name from the provider's identity endpoint. */
  private async readIdentity(definition: OAuthProviderDefinition, accessToken: string): Promise<string | null> {
    if (!definition.identityUrl || !definition.readIdentity) return null;
    try {
      const response = await this.providerFetch(definition, definition.identityUrl, {
        method: "GET",
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/json", "user-agent": "L2M" }
      });
      if (!response.ok) return null;
      return definition.readIdentity(await this.readJson(response))?.slice(0, 200) ?? null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Tokens for runs
  // ---------------------------------------------------------------------------------------------------------------

  private remember(token: string, secretId: string): void {
    const key = hash(token);
    this.issued.delete(key);
    this.issued.set(key, secretId);
    if (this.issued.size > MAX_ISSUED) {
      const oldest = this.issued.keys().next().value;
      if (oldest !== undefined) this.issued.delete(oldest);
    }
  }

  /** The secret id a token handed out by this service belongs to, or null. */
  issuedFor(token: string): string | null {
    return this.issued.get(hash(token)) ?? null;
  }

  private reconnectMessage(definition: OAuthProviderDefinition | undefined, account: OAuthAccountRecord): string {
    const label = definition?.label ?? account.providerId;
    return `The ${label} account${account.accountLabel ? ` '${account.accountLabel}'` : ""} needs to be reconnected: open Secrets → Connected accounts and press Reconnect.`;
  }

  /**
   * The current access token of a connected account, renewed when it is due (or when `force`). Throws a plain message
   * when the account needs reconnecting. Several callers wanting a renewal share one request.
   */
  async getAccessToken(secretId: string, options: { force?: boolean; seenToken?: string; afterRejection?: boolean } = {}): Promise<string> {
    const account = await this.store.getOAuthAccount(secretId);
    const stored = parseStored(await this.secretService.readConnectedAccountValue(secretId));
    if (!account || !stored) throw new ConnectedAccountError("This connected account is missing its sign-in. Connect it again under Secrets → Connected accounts.", 404);
    const definition = this.options.registry.get(account.providerId);
    if (account.status === "needs_reconnect") throw new ConnectedAccountError(this.reconnectMessage(definition, account), 409);
    // Another caller already renewed the token this one was refused with.
    if (options.seenToken !== undefined && stored.accessToken !== options.seenToken && !this.isDue(stored)) {
      this.remember(stored.accessToken, secretId);
      return stored.accessToken;
    }
    if (!options.force && !this.isDue(stored)) {
      this.remember(stored.accessToken, secretId);
      return stored.accessToken;
    }
    if (!stored.refreshToken) {
      if (!this.isExpired(stored)) {
        // Nothing to renew with. A 401 from some server says nothing about the account itself: it stands.
        if (!options.force) {
          this.remember(stored.accessToken, secretId);
          return stored.accessToken;
        }
        throw new ConnectedAccountError(`This ${definition?.label ?? account.providerId} account has no refresh token, so its access token cannot be renewed here.`, 409);
      }
      await this.markNeedsReconnect(account, "The access token expired and the provider gave no way to renew it.", "expired");
      throw new ConnectedAccountError(this.reconnectMessage(definition, account), 409);
    }
    // A run's 401 to a token renewed moments ago: renewing again would not help (the server refuses this account for
    // another reason), and a server that answers 401 to everything must not churn the provider's refresh tokens.
    if (options.afterRejection && !this.isDue(stored) && account.lastRefreshAt && Date.now() - Date.parse(account.lastRefreshAt) < REJECTION_REFRESH_COOLDOWN_MS) {
      throw new ConnectedAccountError(`The ${definition?.label ?? account.providerId} account's token was renewed less than a minute ago and was refused again; it is not renewed again yet.`, 409);
    }
    const running = this.refreshing.get(secretId);
    if (running) return await running;
    const refresh = this.underLock(secretId, () => this.refresh(secretId, stored.accessToken)).finally(() => this.refreshing.delete(secretId));
    this.refreshing.set(secretId, refresh);
    const token = await refresh;
    this.remember(token, secretId);
    return token;
  }

  private isDue(stored: StoredAccountTokens): boolean {
    return stored.expiresAt ? Date.parse(stored.expiresAt) - Date.now() <= this.options.refreshSkewMs : false;
  }

  private isExpired(stored: StoredAccountTokens): boolean {
    return stored.expiresAt ? Date.parse(stored.expiresAt) <= Date.now() : false;
  }

  private async underLock<T>(secretId: string, fn: () => Promise<T>): Promise<T> {
    return this.options.refreshLock ? await this.options.refreshLock(`oauth-account:${secretId}`, fn) : await fn();
  }

  /** Under the refresh lock: re-reads the stored tokens (another instance may have renewed them) and renews. */
  private async refresh(secretId: string, seenToken: string): Promise<string> {
    const account = await this.store.getOAuthAccount(secretId);
    const stored = parseStored(await this.secretService.readConnectedAccountValue(secretId));
    if (!account || !stored) throw new ConnectedAccountError("This connected account was removed.", 404);
    const definition = this.options.registry.get(account.providerId);
    if (account.status === "needs_reconnect") throw new ConnectedAccountError(this.reconnectMessage(definition, account), 409);
    if (stored.accessToken !== seenToken && !this.isDue(stored)) return stored.accessToken;
    if (!definition || !stored.refreshToken) {
      await this.markNeedsReconnect(account, "The access token cannot be renewed.", "unrefreshable");
      throw new ConnectedAccountError(this.reconnectMessage(definition, account), 409);
    }
    const app = account.appId ? await this.store.getOAuthApp(account.appId) : null;
    const clientSecret = app ? await this.clientSecretFor(app) : null;
    if (!app || !clientSecret) {
      await this.markNeedsReconnect(account, `The ${definition.label} OAuth app this account was connected with was removed.`, "app_removed");
      throw new ConnectedAccountError(this.reconnectMessage(definition, account), 409);
    }
    let tokens: OAuthProviderTokens;
    try {
      tokens = await this.tokenRequest(definition, app, clientSecret, { type: "refresh_token", refreshToken: stored.refreshToken });
    } catch (error) {
      // A refusal (a revoked or used refresh token, a changed app) needs a new sign-in; an outage does not.
      const refused = isGrantRefusal(error);
      const message = failureMessage(error);
      if (refused) {
        await this.markNeedsReconnect(account, `Renewing the token failed: ${message}`, "refused");
        throw new ConnectedAccountError(this.reconnectMessage(definition, account), 409);
      }
      await this.patchAccount(secretId, { lastError: `Renewing the token failed: ${message} L2M tries again on the next use.`.slice(0, 500) });
      throw new ConnectedAccountError(`The ${definition.label} account could not be renewed just now: ${message} Try again shortly.`, 502);
    }
    const next = this.storedTokens(definition.id, tokens, tokens.scopes.length > 0 ? tokens.scopes : stored.scopes, stored.refreshToken);
    // A Reconnect or Disconnect that finished while the provider answered wins: these tokens are dropped.
    const latest = parseStored(await this.secretService.readConnectedAccountValue(secretId));
    if (!latest) throw new ConnectedAccountError("This connected account was removed.", 404);
    if (latest.accessToken !== stored.accessToken) return latest.accessToken;
    await this.writeAccountSecret(secretId, next);
    await this.patchAccount(secretId, {
      scopes: next.scopes,
      expiresAt: next.expiresAt ?? null,
      hasRefreshToken: Boolean(next.refreshToken),
      lastRefreshAt: new Date().toISOString(),
      lastError: null
    });
    return next.accessToken;
  }

  /** Saves `patch` over the account's current row; nothing when the account (or its secret) is gone meanwhile. */
  private async patchAccount(secretId: string, patch: Partial<OAuthAccountRecord>): Promise<boolean> {
    const current = await this.store.getOAuthAccount(secretId);
    if (!current || !(await this.store.getSecret(secretId))) return false;
    await this.store.saveOAuthAccount({ ...current, ...patch });
    return true;
  }

  private async markNeedsReconnect(account: OAuthAccountRecord, message: string, reason: string): Promise<void> {
    if (!(await this.patchAccount(account.secretId, { status: "needs_reconnect", lastError: message.slice(0, 500) }))) return;
    await this.options.onAudit?.({
      eventType: "oauth_account.refresh_failed",
      outcome: "failure",
      secretId: account.secretId,
      projectId: account.projectId,
      metadata: { providerId: account.providerId, reason, error: message.slice(0, 300) }
    });
  }

  /** "Refresh now" from the Secrets page. */
  async refreshNow(secretId: string): Promise<ConnectedAccountView> {
    await this.getAccessToken(secretId, { force: true });
    return await this.view(secretId);
  }

  /**
   * For one run: `wrap` notes every connected-account token the run's resolveSecret hands out; `refreshRejected`
   * renews only those (a token a node merely typed into a header is never renewed or answered).
   */
  runCredentials(): {
    wrap: (resolve: (ref?: { secretId: string }) => Promise<string | undefined>) => (ref?: { secretId: string }) => Promise<string | undefined>;
    refreshRejected: (token: string) => Promise<string | undefined>;
  } {
    const mine = new Map<string, string>();
    return {
      wrap: (resolve) => async (ref) => {
        const value = await resolve(ref);
        if (value) {
          const secretId = this.issuedFor(value);
          if (secretId && ref?.secretId === secretId) mine.set(hash(value), secretId);
        }
        return value;
      },
      refreshRejected: async (token) => {
        const secretId = mine.get(hash(token));
        if (!secretId) return undefined;
        const fresh = await this.getAccessToken(secretId, { force: true, seenToken: token, afterRejection: true });
        mine.set(hash(fresh), secretId);
        return fresh;
      }
    };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Views and disconnect
  // ---------------------------------------------------------------------------------------------------------------

  toView(account: OAuthAccountRecord): ConnectedAccountView {
    return {
      providerId: isConnectedAccountProviderId(account.providerId) ? account.providerId : "slack",
      accountLabel: account.accountLabel,
      scopes: account.scopes,
      status: account.status,
      expiresAt: account.expiresAt,
      refreshable: account.hasRefreshToken,
      lastError: account.lastError,
      connectedBy: account.connectedBy,
      connectedAt: account.connectedAt,
      lastRefreshAt: account.lastRefreshAt
    };
  }

  async view(secretId: string): Promise<ConnectedAccountView> {
    const account = await this.store.getOAuthAccount(secretId);
    if (!account) throw new ConnectedAccountError("Connected account not found.", 404);
    return this.toView(account);
  }

  /** Views for the secrets list, by secret id. */
  async viewsFor(secretIds: readonly string[]): Promise<Map<string, ConnectedAccountView>> {
    const map = new Map<string, ConnectedAccountView>();
    for (const account of await this.store.listOAuthAccounts(secretIds)) map.set(account.secretId, this.toView(account));
    return map;
  }

  /**
   * Revokes the token at the provider where it offers that (best effort: the account goes either way) and deletes the
   * secret with its details. Returns whether the provider confirmed the revocation.
   */
  async disconnect(secretId: string): Promise<{ revoked: boolean; providerId: string; projectId: string }> {
    const account = await this.store.getOAuthAccount(secretId);
    if (!account) {
      // The details row went missing (an interrupted connect, a partial restore): the secret still goes.
      const secret = await this.store.getSecret(secretId);
      if (!secret || secret.provider !== CONNECTED_ACCOUNT_SECRET_PROVIDER) throw new ConnectedAccountError("Connected account not found.", 404);
      for (const [key, id] of this.issued) if (id === secretId) this.issued.delete(key);
      await this.secretService.deleteSecret(secretId);
      return { revoked: false, providerId: "unknown", projectId: secret.projectId ?? "default" };
    }
    const stored = parseStored(await this.secretService.readConnectedAccountValue(secretId));
    const definition = this.options.registry.get(account.providerId);
    let revoked = false;
    if (definition?.revoke && stored) {
      try {
        revoked = await this.revoke(definition, account, stored);
      } catch {
        revoked = false;
      }
    }
    for (const [key, id] of this.issued) if (id === secretId) this.issued.delete(key);
    await this.secretService.deleteSecret(secretId);
    // A refresh that failed while this ran may have written the row back.
    await this.store.deleteOAuthAccount(secretId);
    return { revoked, providerId: account.providerId, projectId: account.projectId };
  }

  private async revoke(definition: OAuthProviderDefinition, account: OAuthAccountRecord, stored: StoredAccountTokens): Promise<boolean> {
    const revoke = definition.revoke!;
    const app = account.appId ? await this.store.getOAuthApp(account.appId) : null;
    if (revoke.style === "slack") {
      const response = await this.providerFetch(definition, revoke.url, { method: "POST", headers: { authorization: `Bearer ${stored.accessToken}` } });
      return response.ok && (await this.readJson(response)).ok === true;
    }
    if (revoke.style === "form_token") {
      const response = await this.providerFetch(definition, revoke.url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: stored.refreshToken ?? stored.accessToken }).toString()
      });
      return response.ok;
    }
    // GitHub: delete the app's grant for this token (needs the app's client id and secret).
    const clientSecret = app ? await this.clientSecretFor(app) : null;
    if (!app || !clientSecret) return false;
    const response = await this.providerFetch(definition, providerUrl(revoke.url, { clientId: app.clientId }), {
      method: "DELETE",
      headers: {
        authorization: `Basic ${Buffer.from(`${app.clientId}:${clientSecret}`).toString("base64")}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "L2M"
      },
      body: JSON.stringify({ access_token: stored.accessToken })
    });
    return response.status === 204 || response.ok;
  }
}

/** A refresh the provider answered with one of these needs a new sign-in; anything else (429, 5xx, timeouts) is retried. */
const GRANT_REFUSAL_CODES = new Set(["invalid_grant", "invalid_client", "unauthorized_client", "invalid_refresh_token", "token_revoked", "token_expired", "account_inactive", "invalid_client_id", "bad_client_secret", "invalid_token"]);

function isGrantRefusal(error: unknown): boolean {
  if (error instanceof TokenRefusedError) {
    if (error.code) return GRANT_REFUSAL_CODES.has(error.code);
    return error.status === 400 || error.status === 401;
  }
  if (error instanceof OAuthProviderError) return error.code === undefined || GRANT_REFUSAL_CODES.has(error.code);
  return false;
}

/** The token endpoint answered with an error status. */
class TokenRefusedError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
    this.name = "TokenRefusedError";
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** The page the provider's redirect lands on: tells the opener how it went and closes; without an opener it links back. */
export function renderConnectCallbackPage(outcome: ConnectCallbackOutcome, webOrigin: string): { html: string; nonce: string } {
  const nonce = randomUUID().replace(/-/g, "");
  const message = JSON.stringify({
    type: "l2m:oauth-account",
    ok: outcome.ok,
    providerId: outcome.providerId,
    ...(outcome.secretId ? { secretId: outcome.secretId } : {}),
    ...(outcome.error ? { error: outcome.error } : {})
  }).replace(/</g, "\\u003c");
  const title = outcome.ok ? "Account connected" : "Account not connected";
  const body = outcome.ok
    ? `${outcome.accountLabel ? `${outcome.accountLabel} is` : "The account is"} connected. You can close this window.`
    : `Connecting failed: ${outcome.error ?? "unknown error"}`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:32px 16px;background:#f7f7f5;color:#1d1d1b}@media (prefers-color-scheme: dark){body{background:#151513;color:#ecebe7}}main{max-width:480px;margin:0 auto}a{color:inherit}</style>
</head><body><main><h1 style="font-size:18px">${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p><p><a href="${escapeHtml(webOrigin)}">Back to L2M</a></p></main>
<script nonce="${nonce}">(function(){try{if(window.opener){window.opener.postMessage(${message}, ${JSON.stringify(webOrigin)});${outcome.ok ? "setTimeout(function(){window.close();},400);" : ""}}}catch(e){}})();</script>
</body></html>`;
  return { html, nonce };
}
