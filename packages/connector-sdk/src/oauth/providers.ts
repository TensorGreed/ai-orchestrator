/**
 * Connected accounts — the OAuth 2.0 providers people can sign in to (authorization code + PKCE). Data and pure
 * parsing only: the API keeps state, tokens and egress (apps/api/src/services/connected-account-service.ts).
 *
 * L2M is self-hosted and ships no client ids: every deployment registers its own app with the provider and enters
 * the client id and secret. Each definition says where that is done and which redirect URL to register.
 *
 * Endpoints are fixed per provider. `createDefaultOAuthProviderRegistry({ testBaseUrl })` points every endpoint of
 * every provider at one local mock server instead (tests and local end-to-end runs only; the API accepts only a
 * loopback URL for it).
 */
import { CONNECTED_ACCOUNT_PROVIDER_LABELS, type ConnectedAccountProviderId, type ConnectedAccountScopeSet } from "@ai-orchestrator/shared";

export class OAuthProviderError extends Error {
  /** The provider's own error code (`invalid_grant`, Slack's `token_revoked`, …), when it sent one. */
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "OAuthProviderError";
    this.code = code;
  }
}

export interface OAuthProviderScopeSet extends ConnectedAccountScopeSet {
  scopes: string[];
}

/** Tokens as one provider's token endpoint returned them, normalised. */
export interface OAuthProviderTokens {
  accessToken: string;
  refreshToken?: string;
  /** Seconds, when the provider said. */
  expiresIn?: number;
  scopes: string[];
  /** A label read from the token response itself (Slack team, Notion workspace, an ID token's email). */
  accountLabel?: string;
}

export interface OAuthProviderDefinition {
  id: ConnectedAccountProviderId;
  label: string;
  authorizationUrl: string;
  tokenUrl: string;
  /** Read with the access token to name the account, when the token response does not. */
  identityUrl?: string;
  /** Where disconnect revokes the token, when the provider offers it. */
  revoke?: { url: string; style: "form_token" | "slack" | "github_grant" };
  /** Every host L2M may contact for this provider (token, identity, revoke). Nothing else is reached. */
  hosts: string[];
  /** Scopes always asked for (identity, refresh). */
  baseScopes: string[];
  scopeSets: OAuthProviderScopeSet[];
  /** Query parameter the scopes go in (Slack bot scopes: `scope`). Absent: the provider takes no scopes. */
  scopeParam?: "scope";
  scopeSeparator: " " | ",";
  /** Extra authorization request parameters (Google: offline access and consent for a refresh token). */
  authorizationParams: Record<string, string>;
  /** How the token endpoint wants the request: a form (`client_secret` in the body or Basic), or JSON with Basic auth. */
  tokenRequest: { body: "form" | "json"; clientAuth: "body" | "basic" };
  /** Microsoft: the tenant goes in the endpoint path. */
  tenantInPath: boolean;
  /** Where the provider's app console is, and the setup steps. `{redirectUrl}` is replaced when shown. */
  consoleUrl: string;
  setupSteps: string[];
  parseTokenResponse(json: Record<string, unknown>): OAuthProviderTokens;
  readIdentity?(json: Record<string, unknown>): string | undefined;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Display-only claims of an ID token (not verified: the token came straight from the provider's token endpoint over TLS). */
export function idTokenLabel(idToken: unknown): string | undefined {
  if (typeof idToken !== "string") return undefined;
  const payload = idToken.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    for (const key of ["email", "preferred_username", "upn", "name"]) {
      const value = str(claims[key]);
      if (value) return value.slice(0, 200);
    }
  } catch {
    // Not a readable JWT: no label from it.
  }
  return undefined;
}

function splitScopes(value: unknown, separator: RegExp = /[\s,]+/): string[] {
  return str(value)
    .split(separator)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** The standard OAuth 2.0 token response, refusing an `error` even under a 200 (GitHub answers errors that way). */
function parseStandardTokens(json: Record<string, unknown>): OAuthProviderTokens {
  const error = str(json.error);
  if (error) throw new OAuthProviderError(`The provider refused: ${str(json.error_description) || error}`.slice(0, 300), error);
  const accessToken = str(json.access_token);
  if (!accessToken) throw new OAuthProviderError("The provider returned no access token.");
  const expiresIn = Number(json.expires_in);
  const refreshToken = str(json.refresh_token);
  const label = idTokenLabel(json.id_token);
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresIn } : {}),
    scopes: splitScopes(json.scope),
    ...(label ? { accountLabel: label } : {})
  };
}

const REDIRECT_STEP = "Add this exact redirect URL: {redirectUrl}";

const BUILT_IN: OAuthProviderDefinition[] = [
  {
    id: "slack",
    label: CONNECTED_ACCOUNT_PROVIDER_LABELS.slack,
    authorizationUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    revoke: { url: "https://slack.com/api/auth.revoke", style: "slack" },
    hosts: ["slack.com"],
    baseScopes: [],
    scopeSets: [
      { id: "messages", label: "Send messages", description: "Post to channels the app is in, and public channels.", default: true, scopes: ["chat:write", "chat:write.public"] },
      { id: "channels", label: "Read channel names", description: "List public channels.", default: false, scopes: ["channels:read"] }
    ],
    scopeParam: "scope",
    scopeSeparator: ",",
    authorizationParams: {},
    tokenRequest: { body: "form", clientAuth: "body" },
    tenantInPath: false,
    consoleUrl: "https://api.slack.com/apps",
    setupSteps: [
      "Open api.slack.com/apps and create an app (From scratch) in your workspace.",
      "Under OAuth & Permissions, add this exact redirect URL: {redirectUrl}",
      "Under Bot Token Scopes, add chat:write (and chat:write.public to post without joining channels).",
      "Optional: turn on token rotation so L2M renews the token on its own.",
      "Copy the Client ID and Client Secret from Basic Information into L2M."
    ],
    parseTokenResponse(json) {
      if (json.ok === false) throw new OAuthProviderError(`Slack refused: ${str(json.error) || "unknown error"}`.slice(0, 300), str(json.error) || undefined);
      const tokens = parseStandardTokens(json);
      const team = str(record(json.team).name);
      return { ...tokens, ...(team ? { accountLabel: team } : {}) };
    }
  },
  {
    id: "google",
    label: CONNECTED_ACCOUNT_PROVIDER_LABELS.google,
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    identityUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    revoke: { url: "https://oauth2.googleapis.com/revoke", style: "form_token" },
    hosts: ["oauth2.googleapis.com", "openidconnect.googleapis.com"],
    baseScopes: ["openid", "email"],
    scopeSets: [
      { id: "sheets", label: "Sheets", description: "Read and write spreadsheets.", default: true, scopes: ["https://www.googleapis.com/auth/spreadsheets"] },
      { id: "drive", label: "Drive (read)", description: "List and read files.", default: true, scopes: ["https://www.googleapis.com/auth/drive.readonly"] },
      { id: "gmail", label: "Gmail", description: "Read and send mail (with the HTTP Request node).", default: false, scopes: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"] },
      { id: "calendar", label: "Calendar", description: "Read and create events.", default: false, scopes: ["https://www.googleapis.com/auth/calendar.events"] }
    ],
    scopeParam: "scope",
    scopeSeparator: " ",
    // A refresh token comes only with offline access, and again on a reconnect only with consent.
    authorizationParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    tokenRequest: { body: "form", clientAuth: "body" },
    tenantInPath: false,
    consoleUrl: "https://console.cloud.google.com/apis/credentials",
    setupSteps: [
      "In Google Cloud console, pick or create a project and enable the APIs you need (Sheets, Drive, Gmail, Calendar).",
      "Set up the OAuth consent screen (Internal for a Workspace organisation, or External with test users).",
      "Create credentials: OAuth client ID, application type Web application.",
      REDIRECT_STEP,
      "Copy the Client ID and Client Secret into L2M."
    ],
    parseTokenResponse: parseStandardTokens,
    readIdentity: (json) => str(json.email) || str(json.name) || undefined
  },
  {
    id: "github",
    label: CONNECTED_ACCOUNT_PROVIDER_LABELS.github,
    authorizationUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    identityUrl: "https://api.github.com/user",
    revoke: { url: "https://api.github.com/applications/{clientId}/grant", style: "github_grant" },
    hosts: ["github.com", "api.github.com"],
    baseScopes: [],
    scopeSets: [
      { id: "repo", label: "Repositories", description: "Issues, pull requests, files and commits.", default: true, scopes: ["repo"] },
      { id: "read_org", label: "Organisations (read)", description: "Read organisation membership.", default: false, scopes: ["read:org"] }
    ],
    scopeParam: "scope",
    scopeSeparator: " ",
    authorizationParams: {},
    tokenRequest: { body: "form", clientAuth: "body" },
    tenantInPath: false,
    consoleUrl: "https://github.com/settings/developers",
    setupSteps: [
      "Open GitHub Settings → Developer settings → OAuth Apps (or your organisation's) and register a new app.",
      "Set Authorization callback URL to this exact URL: {redirectUrl}",
      "Generate a client secret.",
      "Copy the Client ID and Client Secret into L2M."
    ],
    parseTokenResponse: parseStandardTokens,
    readIdentity: (json) => str(json.login) || str(json.name) || undefined
  },
  {
    id: "microsoft",
    label: CONNECTED_ACCOUNT_PROVIDER_LABELS.microsoft,
    authorizationUrl: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
    identityUrl: "https://graph.microsoft.com/v1.0/me",
    hosts: ["login.microsoftonline.com", "graph.microsoft.com"],
    baseScopes: ["openid", "email", "offline_access", "User.Read"],
    scopeSets: [
      { id: "teams", label: "Teams", description: "Post messages to channels.", default: true, scopes: ["ChannelMessage.Send"] },
      { id: "mail", label: "Outlook mail", description: "Read and send mail (with the HTTP Request node).", default: false, scopes: ["Mail.Read", "Mail.Send"] },
      { id: "files", label: "OneDrive and SharePoint files (read)", description: "Read files (with the HTTP Request node).", default: false, scopes: ["Files.Read.All"] }
    ],
    scopeParam: "scope",
    scopeSeparator: " ",
    authorizationParams: {},
    tokenRequest: { body: "form", clientAuth: "body" },
    tenantInPath: true,
    consoleUrl: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
    setupSteps: [
      "In Microsoft Entra admin center, open App registrations and create a registration.",
      "Under Authentication, add the Web platform with this exact redirect URL: {redirectUrl}",
      "Under Certificates & secrets, create a client secret.",
      "Under API permissions, add the delegated Microsoft Graph permissions you need (ChannelMessage.Send, Mail.Send, Files.Read.All).",
      "Copy the Application (client) ID and the secret value into L2M. For a single-tenant app, also enter the Directory (tenant) ID."
    ],
    parseTokenResponse: parseStandardTokens,
    readIdentity: (json) => str(json.userPrincipalName) || str(json.mail) || str(json.displayName) || undefined
  },
  {
    id: "notion",
    label: CONNECTED_ACCOUNT_PROVIDER_LABELS.notion,
    authorizationUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    hosts: ["api.notion.com"],
    baseScopes: [],
    scopeSets: [],
    scopeSeparator: " ",
    authorizationParams: { owner: "user" },
    tokenRequest: { body: "json", clientAuth: "basic" },
    tenantInPath: false,
    consoleUrl: "https://www.notion.so/profile/integrations",
    setupSteps: [
      "Open notion.so/profile/integrations and create a new integration of type Public.",
      REDIRECT_STEP,
      "Choose the capabilities your workflows need (read, update, insert content).",
      "Copy the OAuth Client ID and Client Secret into L2M. When connecting, pick the pages the integration may use."
    ],
    parseTokenResponse(json) {
      const tokens = parseStandardTokens(json);
      const workspace = str(json.workspace_name);
      return { ...tokens, ...(workspace ? { accountLabel: workspace } : {}) };
    }
  }
];

/** Microsoft tenants: `common`, `organizations`, `consumers`, a domain or a GUID. Nothing that changes the URL's shape. */
export function isValidMicrosoftTenant(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/.test(value);
}

export interface OAuthProviderRegistryOptions {
  /**
   * Tests and local end-to-end runs only: every endpoint of every provider moves to this base URL, under
   * `/<provider id>` plus the endpoint's own path (https://slack.com/api/oauth.v2.access →
   * <base>/slack/api/oauth.v2.access), and `hosts` becomes the base URL's host.
   */
  testBaseUrl?: string;
}

function rebase(url: string, base: URL, providerId: string): string {
  const original = new URL(url.replace("{tenant}", "tenant").replace("{clientId}", "client"));
  const path = `${base.pathname.replace(/\/+$/, "")}/${providerId}${original.pathname}`;
  // Keep the placeholders the API fills in later.
  return `${base.origin}${path}`.replace("/tenant/", "/{tenant}/").replace("/client/", "/{clientId}/");
}

export class OAuthProviderRegistry {
  private readonly providers = new Map<ConnectedAccountProviderId, OAuthProviderDefinition>();

  register(definition: OAuthProviderDefinition): void {
    this.providers.set(definition.id, definition);
  }

  get(id: string): OAuthProviderDefinition | undefined {
    return this.providers.get(id as ConnectedAccountProviderId);
  }

  list(): OAuthProviderDefinition[] {
    return [...this.providers.values()];
  }
}

export function createDefaultOAuthProviderRegistry(options: OAuthProviderRegistryOptions = {}): OAuthProviderRegistry {
  const registry = new OAuthProviderRegistry();
  const base = options.testBaseUrl ? new URL(options.testBaseUrl) : null;
  for (const definition of BUILT_IN) {
    if (!base) {
      registry.register(definition);
      continue;
    }
    registry.register({
      ...definition,
      authorizationUrl: rebase(definition.authorizationUrl, base, definition.id),
      tokenUrl: rebase(definition.tokenUrl, base, definition.id),
      ...(definition.identityUrl ? { identityUrl: rebase(definition.identityUrl, base, definition.id) } : {}),
      ...(definition.revoke ? { revoke: { ...definition.revoke, url: rebase(definition.revoke.url, base, definition.id) } } : {}),
      hosts: [base.host]
    });
  }
  return registry;
}

/** The scopes to ask for: the provider's base scopes plus those of the chosen sets (the defaults when none is chosen). */
export function scopesFor(definition: OAuthProviderDefinition, scopeSetIds: readonly string[] | undefined): string[] {
  const chosen =
    scopeSetIds && scopeSetIds.length > 0
      ? definition.scopeSets.filter((set) => scopeSetIds.includes(set.id))
      : definition.scopeSets.filter((set) => set.default);
  const scopes = new Set<string>(definition.baseScopes);
  for (const set of chosen) for (const scope of set.scopes) scopes.add(scope);
  return [...scopes];
}

/** The provider's endpoint with its placeholders filled in (Microsoft's tenant, GitHub's client id). */
export function providerUrl(template: string, values: { tenant?: string; clientId?: string }): string {
  let url = template;
  if (url.includes("{tenant}")) {
    const tenant = values.tenant?.trim() || "common";
    if (!isValidMicrosoftTenant(tenant)) throw new OAuthProviderError("The tenant is not a valid Microsoft tenant id or domain.");
    url = url.replace("{tenant}", encodeURIComponent(tenant));
  }
  if (url.includes("{clientId}")) url = url.replace("{clientId}", encodeURIComponent(values.clientId ?? ""));
  return url;
}

/** The authorization request URL: response type code, PKCE (S256), state, the scopes and the provider's own parameters. */
export function buildProviderAuthorizationUrl(
  definition: OAuthProviderDefinition,
  input: { clientId: string; redirectUri: string; state: string; codeChallenge: string; scopes: string[]; tenant?: string }
): string {
  const url = new URL(providerUrl(definition.authorizationUrl, { tenant: input.tenant }));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (definition.scopeParam && input.scopes.length > 0) url.searchParams.set(definition.scopeParam, input.scopes.join(definition.scopeSeparator));
  for (const [key, value] of Object.entries(definition.authorizationParams)) url.searchParams.set(key, value);
  return url.toString();
}

/** The token endpoint request for an authorization code or a refresh token, in the provider's own format. */
export function buildProviderTokenRequest(
  definition: OAuthProviderDefinition,
  input: {
    clientId: string;
    clientSecret: string;
    tenant?: string;
    grant: { type: "authorization_code"; code: string; codeVerifier: string; redirectUri: string } | { type: "refresh_token"; refreshToken: string };
  }
): { url: string; init: { method: "POST"; headers: Record<string, string>; body: string } } {
  const params: Record<string, string> =
    input.grant.type === "authorization_code"
      ? { grant_type: "authorization_code", code: input.grant.code, code_verifier: input.grant.codeVerifier, redirect_uri: input.grant.redirectUri }
      : { grant_type: "refresh_token", refresh_token: input.grant.refreshToken };
  const headers: Record<string, string> = { accept: "application/json" };
  if (definition.tokenRequest.clientAuth === "basic") {
    headers.authorization = `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString("base64")}`;
  } else {
    params.client_id = input.clientId;
    params.client_secret = input.clientSecret;
  }
  let body: string;
  if (definition.tokenRequest.body === "json") {
    headers["content-type"] = "application/json";
    body = JSON.stringify(params);
  } else {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(params).toString();
  }
  return { url: providerUrl(definition.tokenUrl, { tenant: input.tenant }), init: { method: "POST", headers, body } };
}

/** The host of `url` (with port when it has one), lowercased; null when it does not parse. */
export function urlHost(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/** True when `url` is https (or http on a loopback host) and its host is one of the provider's. */
export function isProviderUrl(definition: Pick<OAuthProviderDefinition, "hosts">, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const loopback = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) return false;
  if (parsed.username || parsed.password) return false;
  return definition.hosts.map((host) => host.toLowerCase()).includes(parsed.host.toLowerCase());
}
