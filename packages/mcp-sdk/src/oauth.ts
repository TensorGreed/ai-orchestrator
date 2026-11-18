import { createHash, randomBytes } from "node:crypto";
import { MCP_CLIENT_PROTOCOL_VERSION } from "./progress";
import {
  MCP_CLIENT_INFO,
  MCP_CLIENT_MODERN_PROTOCOL_VERSION,
  MCP_META_CLIENT_CAPABILITIES,
  MCP_META_CLIENT_INFO,
  MCP_META_PROTOCOL_VERSION
} from "./protocol/constants";
import { buildMcpStandardHeaders } from "./protocol/headers";

/**
 * Phase 10.5 — OAuth 2.1 client for remote MCP servers, following the MCP
 * authorization spec:
 *   1. an unauthenticated request gets 401 with `WWW-Authenticate`, whose
 *      `resource_metadata` names the Protected Resource Metadata (RFC 9728);
 *      without it the well-known URLs are tried
 *   2. the metadata's `authorization_servers` lead to Authorization Server
 *      Metadata (RFC 8414, then OpenID Connect discovery)
 *   3. without a configured client id the client registers itself
 *      (RFC 7591 dynamic client registration, with `application_type`), or
 *      names its Client ID Metadata Document when the caller enables that
 *   4. authorization code flow with PKCE (S256) and the `resource`
 *      parameter (RFC 8707), then token exchange and refresh
 *
 * MCP 2026-07-28 rules that hold in every protocol era: authorization server
 * metadata is used only when its `issuer` is exactly the issuer it was
 * fetched for (RFC 8414 section 3.3), and the authorization response's `iss`
 * is checked against that issuer before the code goes to any token endpoint
 * (RFC 9207, `validateAuthorizationResponseIssuer`).
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
  /** RFC 9207: the server puts `iss` in every authorization response. Absent means false. */
  authorization_response_iss_parameter_supported?: boolean;
  /** The server accepts an https URL naming a Client ID Metadata Document as `client_id`. */
  client_id_metadata_document_supported?: boolean;
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

/**
 * True for `localhost`, `*.localhost`, an IPv4 address in 127.0.0.0/8 and `::1` (as a URL hostname, brackets
 * allowed). A name that merely starts with `127.` (such as `127.example.com`) is not loopback.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  const octets = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return octets !== null && octets.slice(1).every((part) => Number(part) <= 255);
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

/** What a 403 `insufficient_scope` challenge (RFC 6750 section 3.1) asks for. */
export interface McpInsufficientScopeChallenge {
  /** The scopes the server needs for the refused operation, space separated (only well-formed scope tokens). */
  scope?: string;
  /** The protected resource metadata URL the challenge names. */
  resourceMetadata?: string;
}

/** RFC 6749 section 3.3 scope-token characters. */
const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]{1,200}$/;
/** At most this many scope tokens are kept from server-supplied or stored scope strings. */
const MAX_SCOPE_TOKENS = 64;

function scopeTokens(value: string | null | undefined): string[] {
  if (typeof value !== "string") return [];
  return value.split(/\s+/).filter((token) => SCOPE_TOKEN.test(token));
}

/**
 * MCP authorization, scope challenge handling: a 403 whose `WWW-Authenticate` Bearer challenge says
 * `error="insufficient_scope"` means the token is valid but lacks scope for this operation. Anything else (another
 * status, another error, no challenge) is not one.
 */
export function readInsufficientScopeChallenge(status: number, header: string | null | undefined): McpInsufficientScopeChallenge | null {
  if (status !== 403) return null;
  const params = parseWwwAuthenticate(header);
  if (!params || params.error !== "insufficient_scope") return null;
  const scope = unionOAuthScopes(params.scope);
  return {
    ...(scope ? { scope } : {}),
    ...(params.resource_metadata ? { resourceMetadata: params.resource_metadata.slice(0, 2000) } : {})
  };
}

/**
 * The step-up scope set: the union of the given scope strings in first-seen order (MCP 2026-07-28 step-up
 * authorization: previously requested scopes plus the challenged ones). Malformed tokens are dropped; undefined when
 * nothing is left.
 */
export function unionOAuthScopes(...scopes: Array<string | null | undefined>): string | undefined {
  const seen = new Set<string>();
  for (const value of scopes) {
    for (const token of scopeTokens(value)) {
      if (seen.size >= MAX_SCOPE_TOKENS) break;
      seen.add(token);
    }
  }
  return seen.size > 0 ? [...seen].join(" ") : undefined;
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

/** The endpoint's URL without its fragment (RFC 9728 section 1.2: a resource identifier "has no fragment component"). */
function withoutFragment(endpoint: string): string {
  const hash = endpoint.indexOf("#");
  return hash === -1 ? endpoint : endpoint.slice(0, hash);
}

/**
 * Where to look for an MCP server's protected resource metadata when its 401 names none, in the order MCP 2026-07-28
 * gives (Authorization Server Discovery, "Protected Resource Metadata Discovery Requirements"): at the path of the
 * endpoint, then at the root. Each comes with the resource identifiers its document may name (RFC 9728 section 3.3).
 *
 * The path-specific URL follows RFC 9728 section 3.1: `/.well-known/oauth-protected-resource` goes "between the host
 * component and the path and/or query components", and a query is kept. Section 3.1 says "any terminating slash (/)
 * following the host component MUST be removed", which can be read as the slash after the host only or (as RFC 8414
 * section 3.1 has it) the slash ending the path; servers use both, so an endpoint ending in a slash tries
 * `https://h/.well-known/oauth-protected-resource/mcp/` and then `.../mcp`. Either document must still name the
 * endpoint itself (section 3.3).
 */
function protectedResourceMetadataCandidates(endpoint: string): Array<{ url: string; resources: string[] }> {
  const url = new URL(endpoint);
  url.hash = "";
  const path = url.pathname === "/" ? "" : url.pathname;
  const root = `${url.origin}/.well-known/oauth-protected-resource`;
  const serverForms = endpointResourceForms(endpoint);
  // The root document's identifier is the origin (with or without the slash RFC 9728 section 3.1 removes). MCP also
  // lets a server whose endpoint has a path publish its metadata there, so the endpoint itself is accepted as well:
  // it is still the URL the client uses, which is what section 7.3 protects.
  const rootForms = [...new Set([url.origin, `${url.origin}/`, ...serverForms])];
  if (!path && !url.search) return [{ url: root, resources: rootForms }];
  const trimmed = path.replace(/\/+$/, "");
  const pathUrls = [...new Set([`${root}${path}${url.search}`, `${root}${trimmed}${url.search}`])].filter((candidate) => candidate !== root);
  return [...pathUrls.map((candidate) => ({ url: candidate, resources: serverForms })), { url: root, resources: rootForms }];
}

/**
 * The strings that count as "the URL that the client used to make the request" for an endpoint: as configured
 * (fragment removed) and as the request actually goes out (WHATWG URL serialisation: lower-case scheme and host, no
 * default port). For a server at the root, the forms with and without the trailing slash, which RFC 9728 section 3.1
 * treats alike and MCP 2026-07-28 ("Canonical Server URI") prefers without.
 */
function endpointResourceForms(endpoint: string): string[] {
  const url = new URL(endpoint);
  url.hash = "";
  const forms = [withoutFragment(endpoint), url.href, canonicalResourceUri(endpoint)];
  if (url.pathname === "/" && !url.search) forms.push(url.origin, `${url.origin}/`);
  return [...new Set(forms)];
}

/**
 * MCP 2026-07-28 ("Canonical Server URI"): "implementations SHOULD accept uppercase scheme and host components". The
 * scheme and authority are lower-cased for the comparison; the path and query are compared exactly.
 */
function foldSchemeAndHost(value: string): string {
  return value.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*)/, (prefix) => prefix.toLowerCase());
}

/**
 * RFC 9728 section 3.3: the document's `resource` "MUST be identical" to the resource identifier its URL was built
 * from, or, for a URL the server named in `WWW-Authenticate`, to "the URL that the client used to make the request";
 * otherwise "the data contained in the response MUST NOT be used". Compared code point by code point (section 6),
 * apart from the scheme and host case MCP says implementations SHOULD accept, and with one interoperability exception
 * (`isSameOriginPathPrefix`). `resource` is REQUIRED (section 2), must be a URL
 * with no fragment (section 1.2; RFC 8707 section 2), and must be `https` (loopback `http` allowed for local use).
 */
function assertProtectedResourceIdentifier(metadata: ProtectedResourceMetadata, accepted: string[], metadataUrl: string, endpoint: string): void {
  const resource = metadata.resource;
  if (typeof resource !== "string" || !resource) {
    throw new McpOAuthError(
      `The protected resource metadata at ${metadataUrl} names no resource (RFC 9728 section 2 requires one); refusing to use it.`
    );
  }
  if (resource.includes("#")) {
    throw new McpOAuthError(`The protected resource metadata at ${metadataUrl} names a resource with a fragment; refusing to use it.`);
  }
  assertSecureOAuthUrl(resource, "The resource in the protected resource metadata");
  const folded = foldSchemeAndHost(resource);
  if (accepted.some((form) => foldSchemeAndHost(form) === folded)) return;
  if (isSameOriginPathPrefix(resource, endpoint)) return;
  throw new McpOAuthError(
    `The protected resource metadata at ${metadataUrl} names the resource ${JSON.stringify(resource.slice(0, 300))}, which is ` +
      `neither ${JSON.stringify(withoutFragment(endpoint).slice(0, 300))} nor a parent path of it on the same origin (RFC 9728 ` +
      `section 3.3), so it was not used.`
  );
}

/**
 * The one exception to exact matching, for interoperability with servers built on the reference MCP TypeScript SDK:
 * its client (`checkResourceAllowed` in src/shared/auth-utils.ts, called from `selectResourceURL` in
 * src/client/auth.ts; tag 1.32.2) accepts a `resource` with the same origin whose path is a prefix of the server
 * URL's path, so such servers commonly name their origin (`https://h`) for an endpoint such as `https://h/mcp`. This
 * accepts the same, on a path-segment boundary only: `https://h` and `https://h/mcp` both cover `https://h/mcp`
 * (and `https://h/mcp/x`), `https://h/m` and `https://h/mcp/` do not. A resource with a query is never a prefix.
 * The identifier still names this server's origin and a path that contains the endpoint, so a document cannot claim
 * another server (RFC 9728 section 7.3).
 */
function isSameOriginPathPrefix(resource: string, endpoint: string): boolean {
  let named: URL;
  let target: URL;
  try {
    named = new URL(resource);
    target = new URL(endpoint);
  } catch {
    return false;
  }
  if (named.origin !== target.origin || named.search !== "" || named.username !== "" || named.password !== "") return false;
  const prefix = named.pathname;
  if (prefix === "/") return true;
  if (target.pathname === prefix) return true;
  return target.pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}

/** RFC 9728 section 3.1 well-known URLs for a resource, in the order MCP 2026-07-28 tries them: path-specific (both slash forms), then root. */
export function protectedResourceMetadataUrls(endpoint: string): string[] {
  return protectedResourceMetadataCandidates(endpoint).map((candidate) => candidate.url);
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
 * The unauthenticated requests that ask an MCP endpoint for its 401 challenge, in order: the legacy `initialize`
 * (unchanged from earlier releases), then a 2026-07-28 `server/discover` with the modern headers and `_meta`. A
 * modern-only server may answer `initialize` with 400 instead of 401 (it is not a 2026-07-28 method), and some
 * servers let `initialize` through without a token; both challenge the modern request. The second probe is sent only
 * when the first did not get a 401.
 */
function oauthProbeRequests(): Array<{ headers: Record<string, string>; body: Record<string, unknown> }> {
  const modernParams = {
    _meta: {
      [MCP_META_PROTOCOL_VERSION]: MCP_CLIENT_MODERN_PROTOCOL_VERSION,
      [MCP_META_CLIENT_CAPABILITIES]: {},
      [MCP_META_CLIENT_INFO]: { ...MCP_CLIENT_INFO }
    }
  };
  return [
    {
      headers: {},
      body: {
        jsonrpc: "2.0",
        id: "l2m-oauth-probe",
        method: "initialize",
        params: { protocolVersion: MCP_CLIENT_PROTOCOL_VERSION, capabilities: {}, clientInfo: { ...MCP_CLIENT_INFO } }
      }
    },
    {
      headers: buildMcpStandardHeaders(MCP_CLIENT_MODERN_PROTOCOL_VERSION, "server/discover", modernParams),
      body: { jsonrpc: "2.0", id: "l2m-oauth-probe-discover", method: "server/discover", params: modernParams }
    }
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
  for (const request of oauthProbeRequests()) {
    try {
      const probe = await fetchWithTimeout(fetchImpl, endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...request.headers,
          ...(options.headers ?? {})
        },
        body: JSON.stringify(request.body)
      });
      await probe.text().catch(() => "");
      if (probe.status === 401) {
        challenge = parseWwwAuthenticate(probe.headers.get("www-authenticate"));
        break;
      }
    } catch {
      // No answer at all (unreachable, timed out): a second probe would wait as long again. Go to the well-known URLs.
      break;
    }
  }

  // RFC 9728 section 3.3: a document found through the server's challenge must name the URL the request went to; one
  // found at a well-known URL must name the identifier that URL was built from.
  const candidates = challenge?.resource_metadata
    ? [{ url: challenge.resource_metadata, resources: endpointResourceForms(endpoint) }]
    : protectedResourceMetadataCandidates(endpoint);
  let lastError = "no metadata URL answered";
  for (const candidate of candidates) {
    assertSecureOAuthUrl(candidate.url, "Protected resource metadata URL");
    const response = await fetchWithTimeout(fetchImpl, candidate.url, { headers: { accept: "application/json" } });
    if (!response.ok) {
      lastError = `${candidate.url} answered HTTP ${response.status}`;
      continue;
    }
    const metadata = (await readJson(response, "Protected resource metadata")) as ProtectedResourceMetadata;
    // A document that fails a check is refused outright, not skipped for the next URL: it was the server's answer.
    assertProtectedResourceIdentifier(metadata, candidate.resources, candidate.url, endpoint);
    if (!Array.isArray(metadata.authorization_servers) || metadata.authorization_servers.length === 0) {
      throw new McpOAuthError("The server's protected resource metadata names no authorization server.");
    }
    return {
      resourceMetadataUrl: candidate.url,
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
    // RFC 8414 section 3.3 / OpenID Connect Discovery 4.3: the document must name exactly the issuer it was fetched
    // for, compared as plain strings; otherwise one server could hand out another's endpoints (mix-up).
    if (typeof metadata.issuer !== "string" || metadata.issuer !== issuer) {
      throw new McpOAuthError(
        typeof metadata.issuer === "string"
          ? `The authorization server metadata at ${candidate} names the issuer ${JSON.stringify(metadata.issuer.slice(0, 200))}, not ${JSON.stringify(issuer)}; refusing to use it.`
          : `The authorization server metadata at ${candidate} names no issuer; refusing to use it.`
      );
    }
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
    return metadata;
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
  return {
    // RFC 8707 / MCP 2026-07-28 "Resource Parameter Implementation": the resource the server's metadata names, which
    // discoverProtectedResource has checked is identical to the server's URL (RFC 9728 section 3.3).
    // Sent exactly as the server named it: an authorization server matches its registered resource as a string, so
    // any rewriting (case, slash, default port) risks a rejection.
    resource: resourceInfo.metadata.resource as string,
    resourceMetadataUrl: resourceInfo.resourceMetadataUrl,
    resourceMetadata: resourceInfo.metadata,
    authorizationServer,
    ...(resourceInfo.scopeHint ? { scopeHint: resourceInfo.scopeHint } : {})
  };
}

/**
 * The OpenID Connect `application_type` for a redirect URL: `native` when the browser comes back to a loopback
 * address (a locally run L2M), `web` otherwise. MCP 2026-07-28 requires dynamic registration to send one.
 */
export function oauthApplicationType(redirectUri: string): "web" | "native" {
  let hostname: string;
  try {
    hostname = new URL(redirectUri).hostname;
  } catch {
    return "web";
  }
  return isLoopbackHost(hostname) ? "native" : "web";
}

/** RFC 7591 dynamic client registration as a public client (PKCE, no secret) when the server allows it. */
export async function registerOAuthClient(
  registrationEndpoint: string,
  input: { redirectUri: string; clientName?: string; scope?: string; applicationType?: "web" | "native" },
  options: { fetchImpl?: FetchLike } = {}
): Promise<OAuthClientRegistration> {
  const fetchImpl = options.fetchImpl ?? fetch;
  assertSecureOAuthUrl(registrationEndpoint, "Registration endpoint");
  const response = await fetchWithTimeout(fetchImpl, registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: input.clientName ?? "L2M",
      application_type: input.applicationType ?? oauthApplicationType(input.redirectUri),
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

export type AuthorizationResponseIssuerCheck =
  | { ok: true }
  | { ok: false; reason: "missing" | "mismatch" | "malformed"; message: string };

/**
 * RFC 9207 section 2.4 as MCP 2026-07-28 applies it, run on the authorization response before its code goes to any
 * token endpoint (and before its error fields are shown):
 *
 * | server advertises `iss` | `iss` in response | result                             |
 * | true                    | present           | must equal the recorded issuer     |
 * | true                    | absent            | rejected                           |
 * | false or absent         | present           | must equal the recorded issuer     |
 * | false or absent         | absent            | accepted                           |
 *
 * `iss` is the decoded query value as the router parsed it. The comparison is plain string equality: no case
 * folding, default-port, trailing-slash or percent-encoding normalisation. A repeated `iss` (an array) is rejected.
 */
export function validateAuthorizationResponseIssuer(input: {
  recordedIssuer: string;
  issParameterSupported: boolean;
  iss: unknown;
}): AuthorizationResponseIssuerCheck {
  if (input.iss === undefined || input.iss === null) {
    if (!input.issParameterSupported) return { ok: true };
    return {
      ok: false,
      reason: "missing",
      message: "The authorization server says it identifies itself in its responses, but this response named no issuer, so it was discarded."
    };
  }
  if (typeof input.iss !== "string") {
    return { ok: false, reason: "malformed", message: "The authorization response named its issuer more than once, so it was discarded." };
  }
  if (input.iss !== input.recordedIssuer) {
    return {
      ok: false,
      reason: "mismatch",
      message: "The authorization response came from a different authorization server than the one this connection started with, so it was discarded."
    };
  }
  return { ok: true };
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
