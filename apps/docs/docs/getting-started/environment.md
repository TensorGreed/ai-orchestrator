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
see [OIDC single sign-on](../security/auth-rbac.md#oidc-single-sign-on).

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
