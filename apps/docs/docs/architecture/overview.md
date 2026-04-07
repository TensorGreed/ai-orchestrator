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

This design is intended to avoid core-engine rewrites for each new integration.
