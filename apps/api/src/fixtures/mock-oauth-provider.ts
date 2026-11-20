/**
 * A local stand-in for the connected-account providers (Slack, Google, GitHub, Microsoft, Notion), for API tests and
 * the web end-to-end run. Point the API at it with CONNECTED_ACCOUNTS_TEST_PROVIDER_URL; nothing here talks to a real
 * provider.
 *
 *   GET  /<provider>/…authorize|auth          signs in at once and redirects to redirect_uri with a code and the state
 *   POST /<provider>/…token|access|oauth.v2.access  code (PKCE checked) or refresh token → tokens in that provider's format
 *   GET  /<provider>/…user|userinfo|me         the account (identity endpoints)
 *   POST|DELETE …revoke|grant                  revokes the account's tokens
 *   GET  /resource/whoami                      a protected API: 200 for a live access token, 401 otherwise
 *   POST /__control                            { accessTtl, expireAccess, refuseRefresh, client } test controls
 *   GET  /__control                            counters
 *
 * Run alone: `tsx src/fixtures/mock-oauth-provider.ts --port 4532` (binds 127.0.0.1).
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

interface IssuedCode {
  provider: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  scope: string;
}

interface Account {
  provider: string;
  generation: number;
  accessToken: string;
  refreshToken: string;
  revoked: boolean;
  email?: string;
}

export interface MockOAuthControl {
  accessTtl?: number;
  expireAccess?: boolean;
  /** Refresh answers 400 invalid_grant (the grant is gone). */
  refuseRefresh?: boolean;
  /** Refresh answers 429 (rate limited: a transient failure). */
  rateLimitRefresh?: boolean;
  /** New sign-ins get no refresh token (as GitHub OAuth apps and Notion). */
  noRefreshToken?: boolean;
  /** Refresh answers this status and body instead (GitHub answers errors under a 200). */
  refuseRefreshWith?: { status: number; body: Record<string, unknown> } | null;
  /** Refresh answers only after this many ms. */
  refreshDelayMs?: number;
  /** The identity endpoints answer 500. */
  identityDown?: boolean;
  /** Google: the email the next sign-ins report (default person@mock.example). */
  googleEmail?: string;
  client?: { id: string; secret: string };
}

export interface MockOAuthProvider {
  url: string;
  close: () => Promise<void>;
  /** Counters for assertions. */
  stats: { codes: number; tokenExchanges: number; refreshes: number; revocations: number; whoami: number };
  /** Test controls (also over HTTP: POST /__control). */
  control: (input: MockOAuthControl) => void;
  /** The authorization requests seen (query parameters), latest last. */
  authorizations: Array<Record<string, string>>;
}

const LABELS: Record<string, Record<string, unknown>> = {
  slack: { team: { id: "T1", name: "Mock Workspace" } },
  notion: { workspace_name: "Mock Notion", workspace_id: "w1" }
};

function jwt(claims: Record<string, unknown>): string {
  return `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.`;
}

function send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body;
}

export async function startMockOAuthProvider(options: { port?: number; host?: string } = {}): Promise<MockOAuthProvider> {
  const codes = new Map<string, IssuedCode>();
  const accounts: Account[] = [];
  let counter = 0;
  let accessTtl = 3600;
  let refuseRefresh = false;
  let rateLimitRefresh = false;
  let noRefreshToken = false;
  let googleEmail = "person@mock.example";
  let refuseRefreshWith: { status: number; body: Record<string, unknown> } | null = null;
  let refreshDelayMs = 0;
  let identityDown = false;
  let client = { id: "l2m-test-client", secret: "l2m-test-secret" };
  const stats = { codes: 0, tokenExchanges: 0, refreshes: 0, revocations: 0, whoami: 0 };
  const authorizations: Array<Record<string, string>> = [];

  const control: MockOAuthProvider["control"] = (input) => {
    if (typeof input.accessTtl === "number") accessTtl = input.accessTtl;
    if (typeof input.refuseRefresh === "boolean") refuseRefresh = input.refuseRefresh;
    if (typeof input.rateLimitRefresh === "boolean") rateLimitRefresh = input.rateLimitRefresh;
    if (typeof input.noRefreshToken === "boolean") noRefreshToken = input.noRefreshToken;
    if (typeof input.googleEmail === "string") googleEmail = input.googleEmail;
    if (input.refuseRefreshWith !== undefined) refuseRefreshWith = input.refuseRefreshWith;
    if (typeof input.refreshDelayMs === "number") refreshDelayMs = input.refreshDelayMs;
    if (typeof input.identityDown === "boolean") identityDown = input.identityDown;
    if (input.client) client = input.client;
    if (input.expireAccess) for (const account of accounts) account.accessToken = `expired-${account.accessToken}`;
  };

  const tokenResponse = (provider: string, account: Account, scope: string): Record<string, unknown> => {
    const base: Record<string, unknown> = {
      access_token: account.accessToken,
      token_type: "Bearer",
      ...(account.refreshToken ? { refresh_token: account.refreshToken } : {}),
      expires_in: accessTtl,
      ...(scope ? { scope } : {})
    };
    if (provider === "slack") return { ok: true, ...base, token_type: "bot", ...LABELS.slack };
    if (provider === "notion") return { ...base, ...LABELS.notion };
    if (provider === "google") return { ...base, id_token: jwt({ email: account.email ?? "person@mock.example" }) };
    if (provider === "microsoft") return { ...base, id_token: jwt({ preferred_username: "person@contoso.example" }) };
    return base; // github: label from /user
  };

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://mock");
      const [, provider = "", ...rest] = url.pathname.split("/");
      const tail = `/${rest.join("/")}`;
      const body = request.method === "GET" ? "" : await readBody(request);

      if (url.pathname === "/__control") {
        if (request.method === "POST") control(body ? (JSON.parse(body) as MockOAuthControl) : {});
        send(response, 200, { ...stats, accounts: accounts.length });
        return;
      }
      if (url.pathname === "/resource/whoami") {
        stats.whoami += 1;
        const token = /^Bearer (\S+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "";
        const account = accounts.find((entry) => !entry.revoked && entry.accessToken === token);
        if (!account) {
          send(response, 401, { error: "invalid_token" }, { "www-authenticate": 'Bearer error="invalid_token"' });
          return;
        }
        send(response, 200, { ok: true, provider: account.provider, generation: account.generation });
        return;
      }

      // Authorization: sign in at once and send the browser back.
      if (request.method === "GET" && /(authorize|\/auth)$/.test(tail)) {
        const params = Object.fromEntries(url.searchParams);
        authorizations.push(params);
        const redirect = new URL(params.redirect_uri ?? "");
        if (params.client_id !== client.id) {
          redirect.searchParams.set("error", "invalid_client");
          redirect.searchParams.set("state", params.state ?? "");
        } else if (params.code_challenge_method !== "S256" || !params.code_challenge) {
          redirect.searchParams.set("error", "invalid_request");
          redirect.searchParams.set("error_description", "PKCE is required");
          redirect.searchParams.set("state", params.state ?? "");
        } else {
          counter += 1;
          stats.codes += 1;
          const code = `code-${provider}-${counter}`;
          codes.set(code, { provider, clientId: params.client_id, redirectUri: params.redirect_uri ?? "", challenge: params.code_challenge, scope: params.scope ?? "" });
          redirect.searchParams.set("code", code);
          redirect.searchParams.set("state", params.state ?? "");
        }
        response.writeHead(302, { location: redirect.toString() });
        response.end();
        return;
      }

      // Token endpoint.
      if (request.method === "POST" && /(token|access_token|oauth\.v2\.access)$/.test(tail)) {
        const params: Record<string, string> = request.headers["content-type"]?.includes("json")
          ? (JSON.parse(body || "{}") as Record<string, string>)
          : Object.fromEntries(new URLSearchParams(body));
        const basic = /^Basic (\S+)$/.exec(request.headers.authorization ?? "")?.[1];
        const [clientId, clientSecret] = basic ? Buffer.from(basic, "base64").toString().split(":") : [params.client_id, params.client_secret];
        if (clientId !== client.id || clientSecret !== client.secret) {
          send(response, 401, { error: "invalid_client", error_description: "Unknown client or wrong secret" });
          return;
        }
        if (params.grant_type === "authorization_code") {
          const issued = codes.get(params.code ?? "");
          codes.delete(params.code ?? "");
          const verifierHash = createHash("sha256").update(params.code_verifier ?? "").digest("base64url");
          if (!issued || issued.provider !== provider || issued.redirectUri !== params.redirect_uri || verifierHash !== issued.challenge) {
            send(response, 400, { error: "invalid_grant", error_description: "Bad code, redirect URL or PKCE verifier" });
            return;
          }
          stats.tokenExchanges += 1;
          counter += 1;
          const account: Account = { provider, generation: 1, accessToken: `at-${provider}-${counter}`, refreshToken: noRefreshToken ? "" : `rt-${provider}-${counter}`, revoked: false, email: googleEmail };
          accounts.push(account);
          send(response, 200, tokenResponse(provider, account, issued.scope));
          return;
        }
        if (params.grant_type === "refresh_token") {
          if (refreshDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, refreshDelayMs));
          if (refuseRefreshWith) {
            send(response, refuseRefreshWith.status, refuseRefreshWith.body);
            return;
          }
          if (rateLimitRefresh) {
            send(response, 429, { error: "rate_limited" }, { "retry-after": "1" });
            return;
          }
          const account = accounts.find((entry) => entry.refreshToken && entry.refreshToken === params.refresh_token && !entry.revoked);
          if (!account || refuseRefresh) {
            send(response, 400, { error: "invalid_grant", error_description: "The refresh token is not valid" });
            return;
          }
          stats.refreshes += 1;
          counter += 1;
          account.generation += 1;
          account.accessToken = `at-${provider}-${counter}`;
          account.refreshToken = `rt-${provider}-${counter}`; // rotating
          send(response, 200, tokenResponse(provider, account, ""));
          return;
        }
        send(response, 400, { error: "unsupported_grant_type" });
        return;
      }

      // Revocation.
      if ((request.method === "POST" || request.method === "DELETE") && /(revoke|grant)$/.test(tail)) {
        const bearer = /^Bearer (\S+)$/.exec(request.headers.authorization ?? "")?.[1];
        const form = request.headers["content-type"]?.includes("json") ? (JSON.parse(body || "{}") as Record<string, string>) : Object.fromEntries(new URLSearchParams(body));
        const token = bearer ?? form.token ?? form.access_token ?? "";
        const account = accounts.find((entry) => entry.accessToken === token || (entry.refreshToken && entry.refreshToken === token));
        if (account) {
          account.revoked = true;
          stats.revocations += 1;
        }
        if (provider === "github") {
          response.writeHead(account ? 204 : 404);
          response.end();
          return;
        }
        send(response, account ? 200 : 400, provider === "slack" ? { ok: Boolean(account), revoked: Boolean(account) } : {});
        return;
      }

      // Identity.
      if (request.method === "GET" && /(user|userinfo|me)$/.test(tail)) {
        if (identityDown) {
          send(response, 500, { error: "down" });
          return;
        }
        const token = /^Bearer (\S+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "";
        if (!accounts.some((entry) => entry.accessToken === token && !entry.revoked)) {
          send(response, 401, { error: "invalid_token" });
          return;
        }
        send(response, 200, { login: "mock-octo", email: "person@mock.example", userPrincipalName: "person@contoso.example" });
        return;
      }

      send(response, 404, { error: "not_found", path: url.pathname });
    })().catch((error: unknown) => send(response, 500, { error: error instanceof Error ? error.message : "error" }));
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    stats,
    control,
    authorizations,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

// Run alone for the end-to-end run.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const index = process.argv.indexOf("--port");
  const port = index >= 0 ? Number(process.argv[index + 1]) : 4532;
  void startMockOAuthProvider({ port }).then((mock) => {
    process.stdout.write(`mock OAuth provider on ${mock.url}\n`);
  });
}
