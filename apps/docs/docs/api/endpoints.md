# API Endpoints

## Auth

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

## Workflows

- `GET /api/workflows`
- `GET /api/workflows/:id`
- `POST /api/workflows`
- `PUT /api/workflows/:id`
- `DELETE /api/workflows/:id`
- `POST /api/workflows/:id/duplicate`
- `POST /api/workflows/import`
- `POST /api/workflows/import/external` — convert an export from another builder; see [Importing from another builder](../product/importing-from-another-builder.md)
- `GET /api/workflows/:id/export`
- `POST /api/workflows/:id/validate`
- `POST /api/workflows/:id/execute`

## Execution history

- `GET /api/executions`
- `GET /api/executions/:id`

## Definitions and integrations

- `GET /api/definitions`
- `POST /api/connectors/test`
- `POST /api/mcp/discover-tools`

## MCP server registry

See [MCP server registry](../product/mcp-server-registry.md).

- `GET /api/mcp/servers`
- `POST /api/mcp/servers`
- `GET /api/mcp/servers/:id`
- `PUT /api/mcp/servers/:id`
- `DELETE /api/mcp/servers/:id`
- `POST /api/mcp/servers/:id/probe`
- `GET /api/mcp/servers/:id/tools`
- `GET /api/mcp/servers/:id/snapshots/:snapshotId`
- `POST /api/mcp/servers/:id/accept-change`

## Secrets

- `POST /api/secrets`
- `GET /api/secrets`

## Webhooks

- `POST /api/webhooks/execute`
- `ANY /webhook/:path`
- `ANY /webhook-test/:path`

## Helper

- `GET /helper-chat`

## Error response conventions

- `401`: authentication/session errors
- `403`: authorization/signature/replay errors
- `404`: resource not found
- `409`: idempotency conflicts
