---
description: "How L2M stores secrets: AES-256-GCM encryption at rest, secret references in workflow configs instead of values, project scope, the secrets API and operational guidance."
---

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

A secret belongs to a project: the one in the request's `projectId`, or the
default project when none is given. The UI sends the workflow's project (node
credential picker) or the project the Secrets page shows. When a secret lands
in the default project because no project was given, the response carries a
`warnings` entry saying so.

A running workflow can use secrets of its own project and secrets shared to its
project. Default-project secrets count as shared with every project only when
`PROJECT_ISOLATION=role` (the default); with `strict`, share them explicitly
(`POST /api/secrets/:id/shares` with `{ "projectId": "..." }`) to each project
that uses them, before switching. A run started by a signed-in user also needs
that user to hold `secret:use` in the workflow's project, or in a project the
workflow is shared to with `execute`. See
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
  "value": "{\"apiKey\":\"...\"}",
  "projectId": "search-team"
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
