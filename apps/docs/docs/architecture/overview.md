---
title: "Architecture: how the editor, API and runtime fit"
description: "How L2M is built: the monorepo layout, the data flow from the editor through the API and workflow engine to the agent runtime, and the adapter registries."
---

# Architecture Overview

## Monorepo layout

- `apps/api`: Fastify API and execution endpoints
- `apps/web`: React + React Flow visual editor
- `apps/docs`: VitePress docs site
- `packages/shared`: types, schemas, node definitions
- `packages/workflow-engine`: DAG execution + node runners + validation
- `packages/agent-runtime`: iterative LLM tool-calling loop
- `packages/provider-sdk`: LLM adapter interfaces + implementations
- `packages/connector-sdk`: connector adapter interfaces + implementations
- `packages/mcp-sdk`: MCP adapter interfaces + implementations

## Components

- Frontend (`apps/web`): React + TypeScript + React Flow
- Backend (`apps/api`): Fastify + TypeScript
- Product docs (`apps/docs`): VitePress documentation site
- Database: SQLite by default using `sql.js` (persisted to `apps/api/data/orchestrator.db`), or PostgreSQL via `DB_TYPE=postgres`
- Background services: scheduler service, trigger service, and an in-process execution queue with persisted queue and DLQ tables
- Shared contracts: `packages/shared`
- Runtime and SDK packages: `packages/provider-sdk`, `packages/mcp-sdk`, `packages/connector-sdk`, `packages/agent-runtime`, `packages/workflow-engine`

## Repository layout

```text
.
+- apps/
|  +- api/
|  |  +- src/
|  |  |  +- app.ts
|  |  |  +- index.ts
|  |  |  +- db/database.ts
|  |  |  +- services/
|  |  +- Dockerfile
|  +- web/
|  |  +- src/
|  |  |  +- App.tsx
|  |  |  +- styles.css
|  |  |  +- lib/
|  |  +- Dockerfile
|  |  +- nginx.conf
|  +- docs/
|     +- docs/
|     |  +- .vitepress/config.ts
|     |  +- index.md
|     +- package.json
+- packages/
|  +- shared/
|  +- provider-sdk/
|  +- mcp-sdk/
|  +- connector-sdk/
|  +- agent-runtime/
|  +- workflow-engine/
+- samples/workflows/
+- docs/            (the lsquarem.com landing page)
+- docker-compose.yml
+- .env.example
+- README.md
```

To run and test the repository, see [Run from source](../getting-started/run-from-source.md). The workflow file
format and the sample workflows are on [Workflow JSON and samples](./workflow-json.md).

## Data flow

1. UI saves workflow JSON to API
2. API validates and persists workflow in SQLite
3. API starts execution (manual, webhook, or API trigger)
4. Workflow engine resolves execution order and executes node handlers
5. Agent runtime handles iterative tool-calling for agent nodes
6. Results and execution history are persisted and exposed to UI

## Extension model

Core engine remains stable while adding:

- new LLM providers via provider adapters
- new connectors via connector adapters
- new MCP integrations via MCP adapters
- new node definitions via shared schemas and node runners

Each SDK package exposes a registry that the runtime composes. Add an integration by implementing the adapter
interface in the matching package and registering it there; do not wire adapters directly inside `apps/api`.

| Extension | Interface | Adapter files | Register in |
| --- | --- | --- | --- |
| LLM provider | `LLMProviderAdapter` in `packages/provider-sdk/src/types.ts` | `packages/provider-sdk/src/providers/` | `createDefaultProviderRegistry()` in `packages/provider-sdk/src/index.ts` |
| Connector | `ConnectorAdapter` in `packages/connector-sdk/src/types.ts` | `packages/connector-sdk/src/adapters/` | `createDefaultConnectorRegistry()` in `packages/connector-sdk/src/index.ts` |
| MCP server | `MCPServerAdapter` in `packages/mcp-sdk/src/types.ts` | `packages/mcp-sdk/src/adapters/` | `createDefaultMCPRegistry()` in `packages/mcp-sdk/src/index.ts` |

Details: [Provider SDK](../extensions/providers.md), [Connector SDK](../extensions/connectors.md),
[MCP integration](../extensions/mcp.md). To ship adapters without a fork, see [Community nodes](../extensions/community-nodes.md).

This design is intended to avoid core-engine rewrites for each new integration.
