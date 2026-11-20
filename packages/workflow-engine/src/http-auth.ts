/**
 * Credentials that renew themselves, for the HTTP Request node and the connector nodes.
 *
 *   - `withCredentialRefresh`: a fetch that, when a server answers 401 to a bearer token, asks the caller for a fresh
 *     token once (`refreshRejectedCredential`: the API renews a connected account's token and answers only for tokens
 *     it handed out) and sends the request again with it. Anything else passes through untouched.
 *   - `getClientCredentialsToken`: the OAuth 2.0 client credentials grant for the HTTP Request node's preset, cached
 *     in this process until shortly before the token expires. The cache key holds a hash of the client secret, never
 *     the secret, so a rotated secret gets its own token.
 */
import { createHash } from "node:crypto";

export type RefreshRejectedCredential = (token: string) => Promise<string | undefined>;

function bearerOf(headers: Headers): string | null {
  const value = headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(value.trim());
  return match ? match[1]! : null;
}

/**
 * Sends `send(headers)`; on a 401 to a bearer token, asks `refresh` for a fresh token and, when it gives a different
 * one, sends once more with it. The refused response's body is dropped.
 */
export async function sendWithCredentialRefresh(
  headers: Headers,
  send: (headers: Headers) => Promise<Response>,
  refresh: RefreshRejectedCredential | undefined
): Promise<Response> {
  const response = await send(headers);
  if (response.status !== 401 || !refresh) return response;
  const token = bearerOf(headers);
  if (!token) return response;
  let fresh: string | undefined;
  try {
    fresh = await refresh(token);
  } catch {
    // The refresh failed (the account needs reconnecting): the 401 stands, and the caller's message names it.
    return response;
  }
  if (!fresh || fresh === token) return response;
  await response.body?.cancel().catch(() => undefined);
  const retried = new Headers(headers);
  retried.set("authorization", `Bearer ${fresh}`);
  return await send(retried);
}

/** A fetch that retries once with a fresh bearer token after a 401 (see sendWithCredentialRefresh). */
export function withCredentialRefresh(fetchImpl: typeof fetch, refresh: RefreshRejectedCredential | undefined): typeof fetch {
  if (!refresh) return fetchImpl;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    return await sendWithCredentialRefresh(headers, (next) => fetchImpl(input, { ...init, headers: next }), refresh);
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------------------------------------------------
// OAuth 2.0 client credentials
// ---------------------------------------------------------------------------------------------------------------------

export interface ClientCredentialsRequest {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  clientAuth: "body" | "basic";
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

/** A token is not reused within this margin of its expiry. */
const EXPIRY_MARGIN_MS = 30_000;
/** Without an `expires_in`, a token is reused for this long. */
const DEFAULT_LIFETIME_MS = 5 * 60_000;
const MAX_CACHED = 500;
const cache = new Map<string, CachedToken>();
const inFlight = new Map<string, Promise<string>>();

function cacheKey(request: ClientCredentialsRequest): string {
  return createHash("sha256")
    .update(JSON.stringify([request.tokenUrl, request.clientId, request.scope ?? "", request.clientAuth, request.clientSecret]))
    .digest("hex");
}

/** Tests: forget every cached token. */
export function clearClientCredentialsTokenCache(): void {
  cache.clear();
  inFlight.clear();
}

/** Forget the cached token for this request (the API refused it). */
export function dropClientCredentialsToken(request: ClientCredentialsRequest): void {
  cache.delete(cacheKey(request));
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the token URL";
  }
}

/**
 * The access token for `request`: from the cache while it is valid, else from the token endpoint (one request at a
 * time per key). `post` sends the token request (the HTTP Request node passes its outbound-checked fetch).
 */
export async function getClientCredentialsToken(
  request: ClientCredentialsRequest,
  post: (url: string, init: RequestInit) => Promise<Response>,
  nowMs: () => number = Date.now
): Promise<string> {
  const key = cacheKey(request);
  const cached = cache.get(key);
  if (cached && cached.expiresAtMs - EXPIRY_MARGIN_MS > nowMs()) return cached.token;
  const running = inFlight.get(key);
  if (running) return await running;
  const fetching = (async () => {
    const body = new URLSearchParams({ grant_type: "client_credentials" });
    if (request.scope) body.set("scope", request.scope);
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    if (request.clientAuth === "basic") {
      const encode = (value: string) => encodeURIComponent(value).replace(/%20/g, "+");
      headers.authorization = `Basic ${Buffer.from(`${encode(request.clientId)}:${encode(request.clientSecret)}`).toString("base64")}`;
    } else {
      body.set("client_id", request.clientId);
      body.set("client_secret", request.clientSecret);
    }
    const host = hostOf(request.tokenUrl);
    const response = await post(request.tokenUrl, { method: "POST", headers, body: body.toString() });
    let json: Record<string, unknown> = {};
    try {
      json = (await response.json()) as Record<string, unknown>;
    } catch {
      json = {};
    }
    if (!response.ok) {
      const reason = typeof json.error === "string" ? `: ${json.error.slice(0, 100)}` : "";
      throw new Error(`OAuth2 token request to ${host} failed (${response.status})${reason}. Check the token URL, client id and client secret.`);
    }
    const token = typeof json.access_token === "string" ? json.access_token : "";
    if (!token) throw new Error(`OAuth2 token request to ${host} returned no access_token.`);
    const expiresIn = Number(json.expires_in);
    const lifetimeMs = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : DEFAULT_LIFETIME_MS;
    if (cache.size >= MAX_CACHED) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { token, expiresAtMs: nowMs() + lifetimeMs });
    return token;
  })();
  inFlight.set(key, fetching);
  try {
    return await fetching;
  } finally {
    inFlight.delete(key);
  }
}
