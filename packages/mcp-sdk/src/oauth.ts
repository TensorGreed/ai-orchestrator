import { createHash, randomBytes } from "node:crypto";
import { MCP_CLIENT_PROTOCOL_VERSION } from "./progress";

/**
 * Phase 10.5 — OAuth 2.1 client for remote MCP servers, following the MCP
 * authorization spec:
 *   1. an unauthenticated request gets 401 with `WWW-Authenticate`, whose
 *      `resource_metadata` names the Protected Resource Metadata (RFC 9728);
 *      without it the well-known URLs are tried
 *   2. the metadata's `authorization_servers` lead to Authorization Server
 *      Metadata (RFC 8414, then OpenID Connect discovery)
 *   3. without a configured client id the client registers itself
 *      (RFC 7591 dynamic client registration)
 *   4. authorization code flow with PKCE (S256) and the `resource`
 *      parameter (RFC 8707), then token exchange and refresh
 *
 * These are pure protocol steps; where state and tokens are kept is up to
 * the caller (the API keeps tokens in SecretService only).
 */

export class McpOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpOAuthError";
  }
}

export interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
  [key: string]: unknown;
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  [key: string]: unknown;
}

export interface McpOAuthDiscovery {
  /** RFC 8707 resource indicator sent with authorization and token requests. */
  resource: string;
  resourceMetadataUrl: string;
  resourceMetadata: ProtectedResourceMetadata;
  authorizationServer: AuthorizationServerMetadata;
  /** Scope the server asked for in its 401, when it named one. */
  scopeHint?: string;
}

export interface OAuthClientRegistration {
  clientId: string;
  clientSecret?: string;
  /** `none`, `client_secret_basic` or `client_secret_post`. */
  tokenEndpointAuthMethod: string;
  /** Unix seconds; 0 or absent = never expires. */
  clientSecretExpiresAt?: number;
}

export interface OAuthTokenSet {
  accessToken: string;
  tokenType: string;
  refreshToken?: string;
  /** ISO 8601 expiry derived from `expires_in`; absent when the server sent none. */
  expiresAt?: string;
  scope?: string;
  /** Display-only identity from an ID token's claims, when one came back. */
  subject?: string;
}

export type FetchLike = typeof fetch;

const DEFAULT_TIMEOUT_MS = 15_000;

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || host.startsWith("127.") || host.endsWith(".localhost");
}

/**
 * OAuth endpoints must use HTTPS. Loopback addresses are the exception the
 * OAuth 2.1 draft allows, so local development and tests can use http.
 */
export function assertSecureOAuthUrl(value: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpOAuthError(`${what} is not a valid URL: ${value}`);
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return url;
  throw new McpOAuthError(`${what} must use https (got ${url.origin}).`);
}

/** The canonical URI of an MCP server for the RFC 8707 `resource` parameter: no fragment, lowercase scheme and host. */
export function canonicalResourceUri(endpoint: string): string {
  const url = new URL(endpoint);
  url.hash = "";
  const path = url.pathname === "/" ? "" : url.pathname;
  // URL already lowercases the scheme and host.
  return `${url.protocol}//${url.host}${path}${url.search}`;
}

/** Params of a `Bearer` challenge in a `WWW-Authenticate` header. */
export function parseWwwAuthenticate(header: string | null | undefined): Record<string, string> | null {
  if (!header) return null;
  const match = /bearer\s*(.*)$/i.exec(header);
  if (!match) return null;
  const params: Record<string, string> = {};
  const pattern = /([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  let entry = pattern.exec(match[1]);
  while (entry) {
    params[entry[1].toLowerCase()] = (entry[2] ?? entry[3] ?? "").replace(/\\(.)/g, "$1");
    entry = pattern.exec(match[1]);
  }
  return params;
}

async function fetchWithTimeout(fetchImpl: FetchLike, input: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal, redirect: "error" });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new McpOAuthError(`Request to ${new URL(input).origin} timed out after ${timeoutMs} ms.`);
    }
    throw new McpOAuthError(`Request to ${new URL(input).origin} failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response: Response, what: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Reported below.
  }
  throw new McpOAuthError(`${what} did not return a JSON object (HTTP ${response.status}).`);
}

/** RFC 9728 §3.1 well-known URLs for a resource: path-specific first, then the origin root. */
export function protectedResourceMetadataUrls(endpoint: string): string[] {
  const url = new URL(endpoint);
  const path = url.pathname.replace(/\/+$/, "");
  const urls = [];
  if (path) urls.push(`${url.origin}/.well-known/oauth-protected-resource${path}`);
  urls.push(`${url.origin}/.well-known/oauth-protected-resource`);
  return urls;
}

/** RFC 8414 §3.1 and OpenID Connect discovery URLs for an issuer, in the order the MCP spec gives. */
export function authorizationServerMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, "");
  if (!path) {
    return [`${url.origin}/.well-known/oauth-authorization-server`, `${url.origin}/.well-known/openid-configuration`];
  }
  return [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}/.well-known/openid-configuration${path}`,
    `${url.origin}${path}/.well-known/openid-configuration`
  ];
}

/**
 * Ask the MCP endpoint, without credentials, where its metadata lives. A 401
 * challenge with `resource_metadata` wins; otherwise the well-known URLs are
 * tried. Extra headers (the server's configured custom headers) are sent so
 * gateways that route on them still answer.
 */
export async function discoverProtectedResource(
  endpoint: string,
  options: { fetchImpl?: FetchLike; headers?: Record<string, string> } = {}
): Promise<{ resourceMetadataUrl: string; metadata: ProtectedResourceMetadata; scopeHint?: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let challenge: Record<string, string> | null = null;
  try {
    const probe = await fetchWithTimeout(fetchImpl, endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(options.headers ?? {}) },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "l2m-oauth-probe",
        method: "initialize",
        params: { protocolVersion: MCP_CLIENT_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "ai-orchestrator", version: "0.1.0" } }
      })
    });
    await probe.text().catch(() => "");
    if (probe.status === 401) {
      challenge = parseWwwAuthenticate(probe.headers.get("www-authenticate"));
    }
  } catch {
    // Fall back to the well-known URLs.
  }

  const candidates = challenge?.resource_metadata
    ? [challenge.resource_metadata]
    : protectedResourceMetadataUrls(endpoint);
  let lastError = "no metadata URL answered";
  for (const candidate of candidates) {
    assertSecureOAuthUrl(candidate, "Protected resource metadata URL");
    const response = await fetchWithTimeout(fetchImpl, candidate, { headers: { accept: "application/json" } });
    if (!response.ok) {
      lastError = `${candidate} answered HTTP ${response.status}`;
      continue;
    }
    const metadata = (await readJson(response, "Protected resource metadata")) as ProtectedResourceMetadata;
    if (!Array.isArray(metadata.authorization_servers) || metadata.authorization_servers.length === 0) {
      throw new McpOAuthError("The server's protected resource metadata names no authorization server.");
    }
    if (typeof metadata.resource === "string" && metadata.resource) {
      const declared = new URL(metadata.resource);
      if (declared.origin !== new URL(endpoint).origin) {
        throw new McpOAuthError(
          `The protected resource metadata is for ${declared.origin}, not ${new URL(endpoint).origin}; refusing to use it.`
        );
      }
    }
    return {
      resourceMetadataUrl: candidate,
      metadata,
      ...(challenge?.scope ? { scopeHint: challenge.scope } : {})
    };
  }
  throw new McpOAuthError(
    `Could not find OAuth protected resource metadata for ${endpoint} (${lastError}). The server may not support OAuth.`
  );
}

export async function discoverAuthorizationServer(
  issuer: string,
  options: { fetchImpl?: FetchLike } = {}
): Promise<AuthorizationServerMetadata> {
  const fetchImpl = options.fetchImpl ?? fetch;
  assertSecureOAuthUrl(issuer, "Authorization server");
  let lastError = "no metadata URL answered";
  for (const candidate of authorizationServerMetadataUrls(issuer)) {
    const response = await fetchWithTimeout(fetchImpl, candidate, { headers: { accept: "application/json" } });
    if (!response.ok) {
      lastError = `${candidate} answered HTTP ${response.status}`;
      continue;
    }
    const metadata = (await readJson(response, "Authorization server metadata")) as AuthorizationServerMetadata;
    if (typeof metadata.authorization_endpoint !== "string" || typeof metadata.token_endpoint !== "string") {
      throw new McpOAuthError("Authorization server metadata lacks authorization_endpoint or token_endpoint.");
    }
    assertSecureOAuthUrl(metadata.authorization_endpoint, "Authorization endpoint");
    assertSecureOAuthUrl(metadata.token_endpoint, "Token endpoint");
    if (metadata.registration_endpoint) assertSecureOAuthUrl(metadata.registration_endpoint, "Registration endpoint");
    const methods = metadata.code_challenge_methods_supported;
    if (!Array.isArray(methods) || !methods.includes("S256")) {
      throw new McpOAuthError(
        "The authorization server does not advertise PKCE with S256 (code_challenge_methods_supported), which MCP requires."
      );
    }
    return { ...metadata, issuer: typeof metadata.issuer === "string" ? metadata.issuer : issuer };
  }
  throw new McpOAuthError(`Could not load authorization server metadata for ${issuer} (${lastError}).`);
}

/** Steps 1 and 2: protected resource metadata, then the first authorization server's metadata. */
export async function discoverMcpOAuth(
  endpoint: string,
  options: { fetchImpl?: FetchLike; headers?: Record<string, string> } = {}
): Promise<McpOAuthDiscovery> {
  const resourceInfo = await discoverProtectedResource(endpoint, options);
  const issuer = resourceInfo.metadata.authorization_servers![0];
  const authorizationServer = await discoverAuthorizationServer(issuer, options);
  const resource =
    typeof resourceInfo.metadata.resource === "string" && resourceInfo.metadata.resource
      ? resourceInfo.metadata.resource
      : canonicalResourceUri(endpoint);
  return {
    resource,
    resourceMetadataUrl: resourceInfo.resourceMetadataUrl,
    resourceMetadata: resourceInfo.metadata,
    authorizationServer,
    ...(resourceInfo.scopeHint ? { scopeHint: resourceInfo.scopeHint } : {})
  };
}

/** RFC 7591 dynamic client registration as a public client (PKCE, no secret) when the server allows it. */
export async function registerOAuthClient(
  registrationEndpoint: string,
  input: { redirectUri: string; clientName?: string; scope?: string },
  options: { fetchImpl?: FetchLike } = {}
): Promise<OAuthClientRegistration> {
  const fetchImpl = options.fetchImpl ?? fetch;
  assertSecureOAuthUrl(registrationEndpoint, "Registration endpoint");
  const response = await fetchWithTimeout(fetchImpl, registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: input.clientName ?? "L2M",
      redirect_uris: [input.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(input.scope ? { scope: input.scope } : {})
    })
  });
  const body = await readJson(response, "Client registration");
  if (!response.ok) {
    const reason = typeof body.error_description === "string" ? body.error_description : String(body.error ?? response.status);
    throw new McpOAuthError(`Dynamic client registration failed: ${reason}`);
  }
  if (typeof body.client_id !== "string" || !body.client_id) {
    throw new McpOAuthError("Dynamic client registration returned no client_id.");
  }
  const clientSecret = typeof body.client_secret === "string" && body.client_secret ? body.client_secret : undefined;
  const method =
    typeof body.token_endpoint_auth_method === "string" && body.token_endpoint_auth_method
      ? body.token_endpoint_auth_method
      : clientSecret
        ? "client_secret_basic"
        : "none";
  return {
    clientId: body.client_id,
    ...(clientSecret ? { clientSecret } : {}),
    tokenEndpointAuthMethod: method,
    ...(typeof body.client_secret_expires_at === "number" ? { clientSecretExpiresAt: body.client_secret_expires_at } : {})
  };
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function createPkcePair(): { verifier: string; challenge: string; method: "S256" } {
  const verifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

/** Unguessable value for the OAuth `state` parameter. */
export function createOAuthState(): string {
  return base64Url(randomBytes(32));
}

export function buildAuthorizationUrl(input: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  resource: string;
  scope?: string;
}): string {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", input.resource);
  if (input.scope) url.searchParams.set("scope", input.scope);
  return url.toString();
}

function decodeIdTokenSubject(idToken: unknown): string | undefined {
  if (typeof idToken !== "string") return undefined;
  const payload = idToken.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    for (const key of ["email", "preferred_username", "name", "sub"]) {
      if (typeof claims[key] === "string" && claims[key]) return (claims[key] as string).slice(0, 200);
    }
  } catch {
    // Not a readable JWT; no display identity.
  }
  return undefined;
}

interface TokenRequestClient {
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod?: string;
}

async function tokenRequest(
  tokenEndpoint: string,
  client: TokenRequestClient,
  params: Record<string, string>,
  options: { fetchImpl?: FetchLike }
): Promise<OAuthTokenSet> {
  const fetchImpl = options.fetchImpl ?? fetch;
  assertSecureOAuthUrl(tokenEndpoint, "Token endpoint");
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json"
  };
  const method = client.tokenEndpointAuthMethod ?? (client.clientSecret ? "client_secret_basic" : "none");
  if (client.clientSecret && method === "client_secret_basic") {
    const encode = (value: string) => encodeURIComponent(value).replace(/%20/g, "+");
    headers.authorization = `Basic ${Buffer.from(`${encode(client.clientId)}:${encode(client.clientSecret)}`).toString("base64")}`;
  } else {
    body.set("client_id", client.clientId);
    if (client.clientSecret && method === "client_secret_post") body.set("client_secret", client.clientSecret);
  }
  const response = await fetchWithTimeout(fetchImpl, tokenEndpoint, { method: "POST", headers, body: body.toString() });
  const json = await readJson(response, "Token endpoint");
  if (!response.ok) {
    const reason = typeof json.error_description === "string" ? json.error_description : String(json.error ?? response.status);
    throw new McpOAuthError(`Token request failed: ${reason}`);
  }
  if (typeof json.access_token !== "string" || !json.access_token) {
    throw new McpOAuthError("Token endpoint returned no access_token.");
  }
  const expiresIn = Number(json.expires_in);
  const subject = decodeIdTokenSubject(json.id_token);
  return {
    accessToken: json.access_token,
    tokenType: typeof json.token_type === "string" ? json.token_type : "Bearer",
    ...(typeof json.refresh_token === "string" && json.refresh_token ? { refreshToken: json.refresh_token } : {}),
    ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() } : {}),
    ...(typeof json.scope === "string" && json.scope ? { scope: json.scope } : {}),
    ...(subject ? { subject } : {})
  };
}

export function exchangeAuthorizationCode(
  input: TokenRequestClient & {
    tokenEndpoint: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
    resource: string;
  },
  options: { fetchImpl?: FetchLike } = {}
): Promise<OAuthTokenSet> {
  return tokenRequest(
    input.tokenEndpoint,
    input,
    {
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
      resource: input.resource
    },
    options
  );
}

/**
 * Refresh grant. Authorization servers may rotate the refresh token (OAuth
 * 2.1 requires it for public clients); when the response carries none, the
 * old one stays valid and the caller keeps it.
 */
export function refreshOAuthToken(
  input: TokenRequestClient & { tokenEndpoint: string; refreshToken: string; resource: string; scope?: string },
  options: { fetchImpl?: FetchLike } = {}
): Promise<OAuthTokenSet> {
  return tokenRequest(
    input.tokenEndpoint,
    input,
    {
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      resource: input.resource,
      ...(input.scope ? { scope: input.scope } : {})
    },
    options
  );
}
