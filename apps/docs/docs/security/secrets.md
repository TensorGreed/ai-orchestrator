# Secrets

## Design

- Secrets are encrypted at rest using AES-256-GCM.
- Encryption key source: `SECRET_MASTER_KEY_BASE64`.
- Workflows store only `secretRef.secretId`.
- API never returns plaintext secret values.
- Logs redact sensitive errors where applicable.

## API

- `POST /api/secrets`
- `GET /api/secrets`

## Creating secrets

Use the UI secret picker inline in node config, or call API directly.

Example:

```http
POST /api/secrets
Content-Type: application/json
Cookie: ao_session=...

{
  "name": "azure-search-prod",
  "provider": "azure_ai_search",
  "value": "{\"apiKey\":\"...\"}"
}
```

## Operational guidance

- Separate secrets by environment (dev/stage/prod).
- Rotate keys periodically.
- Avoid sharing one secret across unrelated nodes/providers.
