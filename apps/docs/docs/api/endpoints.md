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
- `POST /api/mcp/discover-tools` (optional `projectId`; each tool carries `classification` and an `access` mark for the caller's role)

## MCP server registry

See [MCP server registry](../product/mcp-server-registry.md).

- `GET /api/mcp/servers`
- `POST /api/mcp/servers`
- `GET /api/mcp/servers/:id`
- `PUT /api/mcp/servers/:id`
- `DELETE /api/mcp/servers/:id`
- `POST /api/mcp/servers/:id/probe`
- `GET /api/mcp/servers/:id/tools?projectId=` (each tool carries `classification`, `manualReadOnly` and an `access` mark for the caller's role)
- `PUT /api/mcp/servers/:id/tools/:toolName/classification` (admin; `{ readOnly: true | false | null }`)
- `GET /api/mcp/servers/:id/snapshots/:snapshotId`
- `POST /api/mcp/servers/:id/accept-change`
- `GET /api/mcp/servers/:id/telemetry?window=24h|7d|30d`
- `GET /api/mcp/telemetry?window=24h|7d|30d` (servers configured inline on nodes)

## MCP tool policy

See [MCP tool policy](../product/mcp-tool-policy.md).

- `GET /api/mcp/policies` (builder)
- `POST /api/mcp/policies` (admin)
- `PUT /api/mcp/policies/:id` (admin)
- `DELETE /api/mcp/policies/:id` (admin)
- `POST /api/mcp/policies/evaluate` (builder; `{ projectId, role, serverId, toolName, noWriteTools? }`)

## MCP gateway

See [MCP gateway](../product/mcp-gateway.md).

MCP endpoint (client token, `Authorization: Bearer l2m_mcp_...`):

- `POST /mcp/:toolset` (Streamable HTTP, JSON-RPC 2.0: `initialize`, `ping`, `tools/list`, `tools/call`, notifications; JSON or SSE responses)
- `DELETE /mcp/:toolset` (ends the session named by `Mcp-Session-Id`)
- `GET /mcp/:toolset` (405)

Toolsets:

- `GET /api/mcp/toolsets` (builder)
- `POST /api/mcp/toolsets` (admin; `{ name, slug?, description?, projectId?, enabled?, members? }`)
- `GET /api/mcp/toolsets/candidates` (builder; workflows with an Expose as MCP Tool trigger)
- `GET /api/mcp/toolsets/:id` (builder)
- `PUT /api/mcp/toolsets/:id` (admin; `members` replaces the member list)
- `DELETE /api/mcp/toolsets/:id` (admin)
- `GET /api/mcp/toolsets/:id/preview?role=` (builder; tools visible to a role and tools hidden by policy)
- `POST /api/mcp/toolsets/:id/members` (admin; `{ kind: "workflow", workflowId }` or `{ kind: "server", serverId, toolGlob? }`)
- `DELETE /api/mcp/toolsets/:id/members/:memberId` (admin)

Clients:

- `GET /api/mcp/clients` (builder; status, effective role, open sessions, 7-day calls and errors)
- `POST /api/mcp/clients` (admin; `{ name, toolsetIds, role, expiresAt? }`; the response carries the token once)
- `POST /api/mcp/clients/:id/revoke` (admin)
- `GET /api/mcp/clients/:id/usage?window=24h|7d|30d` (builder)

Legacy workflow tool routes (configured on the `mcp_server_trigger` node):

- `GET /api/mcp-server/:path/manifest`
- `POST /api/mcp-server/:path/invoke`

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
