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
