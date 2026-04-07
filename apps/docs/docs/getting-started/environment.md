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

## Provider/connector env fallbacks

Some adapters support env fallback values. Examples:

- `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_API_VERSION`
- `AZURE_AI_SEARCH_API_KEY`
- `AZURE_AI_SEARCH_ENDPOINT`

Use secrets for production. Env fallbacks are mainly for local development.
