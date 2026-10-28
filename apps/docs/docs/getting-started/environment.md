# Environment

## Required

- `SECRET_MASTER_KEY_BASE64`: base64-encoded 32-byte key for encrypted secret storage

## Runtime defaults (recommended for local)

- `API_HOST=127.0.0.1`
- `API_PORT=4000`
- `WEB_ORIGIN=http://localhost:5173`
- `COOKIE_SECURE=false`

## Auth bootstrap (optional, recommended)

- `BOOTSTRAP_ADMIN_EMAIL`
- `BOOTSTRAP_ADMIN_PASSWORD`

Use this to create an initial admin automatically when DB is empty.

## Single sign-on (optional)

SAML (`SAML_*`), LDAP (`LDAP_*`) and OpenID Connect (`OIDC_*`) are all off by
default. OIDC needs `OIDC_ENABLED=true`, `OIDC_ISSUER` and `OIDC_CLIENT_ID`;
the optional `OIDC_ALLOWED_EMAIL_DOMAINS` and `OIDC_ALLOWED_GROUPS` limit who
can sign in (recommended for shared or self-registration IdPs); see
[OIDC single sign-on](../security/auth-rbac.md#oidc-single-sign-on). SAML has
the same optional allow-lists (`SAML_ALLOWED_EMAIL_DOMAINS`,
`SAML_ALLOWED_GROUPS`) and an optional `SAML_IDP_ISSUER` pin; see
[SAML single sign-on](../security/auth-rbac.md#saml-single-sign-on).

`SSO_MFA` (`off` by default, `idp` or `idp_or_local`) requires MFA on OIDC and
SAML logins, from the IdP or the local TOTP step; `SSO_MFA_OIDC_AMR`,
`SSO_MFA_OIDC_ACR` and `SSO_MFA_SAML_AUTHN_CONTEXTS` tune what counts as IdP
MFA. See [MFA on SSO](../security/auth-rbac.md#mfa-on-sso).

## Rate limits (on by default)

`RATE_LIMIT_ENABLED=true` (the default) limits requests per client address in
three buckets. The auth and webhook limits are counted per route and address
(for example 10 password sign-ins and, separately, 10 TOTP steps a minute);
the global limit is one count per address across all its routes. A request
over a limit gets `429 Too Many Requests` with `Retry-After` and
`x-ratelimit-*` headers.

| Bucket | Routes | Default |
|---|---|---|
| Auth (`RATE_LIMIT_AUTH_MAX`, `RATE_LIMIT_AUTH_WINDOW_MS`) | password sign-in and its TOTP step (`/api/auth/login`, `/api/auth/login/mfa`), registration, LDAP, OIDC and SAML sign-in and callbacks, TOTP enrolment and removal checks (`/api/auth/mfa/activate`, `/api/auth/mfa/disable`) | 10 a minute |
| Webhook (`RATE_LIMIT_WEBHOOK_MAX`, `RATE_LIMIT_WEBHOOK_WINDOW_MS`) | `/webhook/*`, `/webhook-test/*`, `/api/webhooks/*` | 120 a minute |
| Global (`RATE_LIMIT_GLOBAL_MAX`, `RATE_LIMIT_GLOBAL_WINDOW_MS`) | every other route, for unauthenticated and API-key or bearer-token requests | 600 a minute |

`/health` and `/metrics` are never limited. Requests from a signed-in browser
(a live session cookie and no `Authorization` or `X-API-Key` header) do not
count against the global bucket: a busy studio tab was measured at up to about
290 requests a minute, and everyone behind one proxy or NAT shares an address.
They still count in the auth and webhook buckets. Set `RATE_LIMIT_ENABLED=false`
to turn all three off.

The client address is the one that connected. Behind a reverse proxy (the
`web` image's nginx, a load balancer) every client then shares the proxy's
address, so set `TRUST_PROXY` to let the proxy's `X-Forwarded-For` name the
client: a comma list of proxy addresses or CIDR ranges (for example
`TRUST_PROXY=10.0.0.0/8`, or `loopback`, `linklocal`, `uniquelocal`), a hop
count, or `true` to trust every hop. Trust only proxies that overwrite the
header and keep the API unreachable except through them: a client that can
reach the API directly could otherwise pick its own address. Unset (the
default) trusts no proxy.

## MCP server registry probes (optional)

- `MCP_PROBE_INTERVAL_MS` (default `300000`; `0` turns scheduled probes off)
- `MCP_PROBE_TIMEOUT_MS` (default `30000`)
- `MCP_PROBE_HISTORY_LIMIT` (default `500` probes kept per server)

See [MCP server registry](../product/mcp-server-registry.md).

## Provider/connector env fallbacks

Some adapters support env fallback values. Examples:

- `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_API_VERSION`
- `AZURE_AI_SEARCH_API_KEY`
- `AZURE_AI_SEARCH_ENDPOINT`

Use secrets for production. Env fallbacks are mainly for local development.
