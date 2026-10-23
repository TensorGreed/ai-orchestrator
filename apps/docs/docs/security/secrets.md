# Secrets

## Design

- Secrets are encrypted at rest using AES-256-GCM.
- Encryption key source: `SECRET_MASTER_KEY_BASE64`.
- Workflows store only `secretRef.secretId`.
- API never returns plaintext secret values.
- Logs redact sensitive errors where applicable.

## API

- `POST /api/secrets` (needs `secret:write` in the target project)
- `GET /api/secrets` (lists secrets you have `secret:read` for, in their project or a project they are shared to)
- `DELETE /api/secrets/:id`, `POST /api/secrets/:id/shares`, `DELETE /api/secrets/:id/shares/:projectId` (need `secret:write` in the secret's project)

## Project scope

A secret belongs to a project (the default project when none is given). A
running workflow can use secrets of its own project, of the default project,
and secrets shared to its project. A run started by a signed-in user also needs
that user to hold `secret:use` in the workflow's project. See
[Authentication and RBAC](./auth-rbac.md#what-a-running-workflow-can-reach).

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

Qdrant example:

```http
POST /api/secrets
Content-Type: application/json
Cookie: ao_session=...

{
  "name": "qdrant-prod",
  "provider": "qdrant",
  "value": "{\"apiKey\":\"...\"}"
}
```

## Operational guidance

- Separate secrets by environment (dev/stage/prod).
- Rotate keys periodically.
- Avoid sharing one secret across unrelated nodes/providers.
