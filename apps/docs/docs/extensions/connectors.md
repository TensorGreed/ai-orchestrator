# Connector SDK

Connectors are adapter-based and used by connector nodes and RAG workflows.

## Adapter responsibilities

- metadata + category
- config schema + auth schema
- `testConnection`
- `fetchData`
- optional demo fallback behavior

## Built-in connectors

- `google-drive`
- `sql-db`
- `nosql-db`
- `azure-storage`
- `azure-cosmos-db`
- `azure-monitor`
- `azure-ai-search`

## Connector test endpoint

- `POST /api/connectors/test`

This endpoint validates credentials/config without executing an entire workflow.

## Add a new connector

1. Add adapter in `packages/connector-sdk/src/adapters`
2. Register in `packages/connector-sdk/src/index.ts`
3. Add node definition/config in shared definitions
4. Add UI config form
5. Add execution + validation support
6. Add tests
