# AI Orchestrator V1

A runnable V1 visual AI workflow builder and runtime inspired by n8n/Langflow, focused on agent orchestration, MCP tools, LLM providers, RAG nodes, connector nodes, and webhook-triggered execution.

## What this V1 includes

- Drag-and-drop node editor (`React Flow`) with connectable edges and persisted node positions
- Workflow CRUD, import/export JSON, graph validation, and execution tracing
- LLM provider adapter model with built-in adapters for:
  - Ollama (real)
  - OpenAI-compatible endpoints (real)
  - OpenAI cloud (real)
  - Gemini (basic)
- MCP adapter model with a runnable demo MCP server (`mock-mcp`) and tool discovery/invocation
- Agent Orchestrator node with iterative tool-calling loop (zero/one/many tool calls)
- Agent port attachments:
  - `chat_model` -> attach `LLM Call` node
  - `memory` -> attach `Simple Memory` node
  - `tool` -> attach one or more `MCP Tool` nodes
- RAG path with connector source + in-memory retriever/vector similarity
- Connector SDK + sample connectors (`google-drive`, `sql-db`, `nosql-db`)
- Webhook execution endpoint (`system_prompt` + `user_prompt` payload)
- Secret abstraction with encrypted server-side storage (AES-256-GCM)
- Monorepo with shared schemas/types and package-level extension points

## Architecture overview

- Frontend (`apps/web`): React + TypeScript + React Flow
- Backend (`apps/api`): Fastify + TypeScript
- DB: local SQLite database file using `sql.js` (persisted to `apps/api/data/orchestrator.db`)
- Shared contracts: `packages/shared`
- Runtime/SDK packages:
  - `packages/provider-sdk`
  - `packages/mcp-sdk`
  - `packages/connector-sdk`
  - `packages/agent-runtime`
  - `packages/workflow-engine`

## Monorepo structure

```text
.
+- apps/
¦  +- api/
¦  ¦  +- src/
¦  ¦  ¦  +- app.ts
¦  ¦  ¦  +- index.ts
¦  ¦  ¦  +- db/database.ts
¦  ¦  ¦  +- services/
¦  ¦  +- Dockerfile
¦  +- web/
¦     +- src/
¦     ¦  +- App.tsx
¦     ¦  +- styles.css
¦     ¦  +- lib/
¦     +- Dockerfile
¦     +- nginx.conf
+- packages/
¦  +- shared/
¦  +- provider-sdk/
¦  +- mcp-sdk/
¦  +- connector-sdk/
¦  +- agent-runtime/
¦  +- workflow-engine/
+- samples/workflows/
¦  +- basic-flow.json
¦  +- rag-flow.json
¦  +- agentic-mcp-flow.json
+- docker-compose.yml
+- .env.example
+- README.md
```

## Setup (local)

### Prerequisites

- Node.js 20+
- pnpm 10+
- Optional for local LLM: Ollama running at `http://localhost:11434/v1`

### 1) Configure environment

```bash
cp .env.example .env
```

Generate a master key and put it in `.env` as `SECRET_MASTER_KEY_BASE64`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### 2) Install

```bash
pnpm install
```

### 3) Start servers

Start both API and UI together:

```bash
pnpm dev
```

- API: `http://localhost:4000`
- Web UI: `http://localhost:5173`

Start API only:

```bash
pnpm --filter @ai-orchestrator/api start
```

Start UI only:

```bash
pnpm --filter @ai-orchestrator/web dev
```

### 4) Run tests

```bash
pnpm test
```

### 5) Build all packages/apps

```bash
pnpm build
```

## Docker (optional)

```bash
docker compose up --build
```

- Web: `http://localhost:5173`
- API: `http://localhost:4000`

## Core API endpoints

- `GET /api/definitions`
- `GET /api/workflows`
- `GET /api/workflows/:id`
- `POST /api/workflows`
- `PUT /api/workflows/:id`
- `DELETE /api/workflows/:id`
- `POST /api/workflows/import`
- `GET /api/workflows/:id/export`
- `POST /api/workflows/:id/validate`
- `POST /api/workflows/:id/execute`
- `POST /api/webhooks/execute`
- `POST /api/secrets`
- `GET /api/secrets`
- `POST /api/mcp/discover-tools`

## Webhook execution

Webhook payload (minimum):

```json
{
  "workflow_id": "wf-agent-mcp-webhook",
  "session_id": "demo-session-1",
  "system_prompt": "You are a tool-using agent. Use tools when required.",
  "user_prompt": "What time is it in America/Toronto and what is 12*7?",
  "variables": {
    "tenant": "local-dev"
  }
}
```

Example curl:

```bash
curl -X POST http://localhost:4000/api/webhooks/execute \
  -H "Content-Type: application/json" \
  -d '{
    "workflow_id": "wf-agent-mcp-webhook",
    "session_id": "demo-session-1",
    "system_prompt": "You are a tool-using agent. Use tools when required.",
    "user_prompt": "What time is it in America/Toronto and what is 12*7?"
  }'
```

## Agent loop behavior (Agent Orchestrator node)

1. Resolve system prompt + user prompt templates
2. Discover attached MCP tools from configured MCP servers
3. Expose tool metadata to selected LLM provider
4. Call model with conversation + tools
5. If model returns tool calls, invoke tools and append tool outputs as tool messages
6. Repeat model call with updated context
7. Stop on final answer or `maxIterations`

The runtime supports zero, one, or multiple tool calls per iteration.

## Agent Port Attachments (Chat Model / Memory / Tool)

The AI Agent node supports dedicated attachment ports. These are auxiliary edges and are not part of linear DAG execution.

- `chat_model` port:
  - attach an `LLM Call` node
  - its `provider` config is used by the agent runtime (overrides inline agent provider if both are present)
- `memory` port:
  - attach a `Simple Memory` node
  - memory persists conversation turns in SQLite by `namespace + session_id`
- `tool` port:
  - attach one or more `MCP Tool` nodes
  - attached tool configs are converted into available MCP tools for the agent loop

Attachment-only helper nodes are marked as skipped in execution traces because they are consumed by the agent runtime rather than executed as direct steps.

## Simple Memory Node

`Simple Memory` (`local_memory`) is a real SQLite-backed session memory node.

Config:
- `namespace`: memory bucket key (default `default`)
- `sessionIdTemplate`: defaults to `{{session_id}}`
- `maxMessages`: max persisted turns retained
- `persistToolMessages`: whether tool messages are saved in memory

DB storage table:
- `session_memory(namespace, session_id, messages_json, created_at, updated_at)`

## Secrets handling

- Secrets are created with `POST /api/secrets`
- Secret values are encrypted server-side using AES-256-GCM
- Workflow/provider configs reference `secretRef.secretId` only
- API responses never return raw secret values
- Error logging passes through redaction helper

## Extension points

### Add a new LLM provider adapter

1. Implement `LLMProviderAdapter` in `packages/provider-sdk/src/types.ts`
2. Add adapter implementation under `packages/provider-sdk/src/providers/`
3. Register in `createDefaultProviderRegistry()` in `packages/provider-sdk/src/index.ts`

### Add a new connector adapter

1. Implement `ConnectorAdapter` in `packages/connector-sdk/src/types.ts`
2. Add adapter file under `packages/connector-sdk/src/adapters/`
3. Register in `createDefaultConnectorRegistry()` in `packages/connector-sdk/src/index.ts`

### Add a new MCP server adapter

1. Implement `MCPServerAdapter` in `packages/mcp-sdk/src/types.ts`
2. Add adapter file under `packages/mcp-sdk/src/adapters/`
3. Register in `createDefaultMCPRegistry()` in `packages/mcp-sdk/src/index.ts`

## Workflow JSON format

Export format is stable and explicit:

```json
{
  "schemaVersion": "1.0.0",
  "workflowVersion": 1,
  "workflow": {
    "id": "wf-basic-llm",
    "name": "Basic LLM Flow",
    "schemaVersion": "1.0.0",
    "workflowVersion": 1,
    "nodes": [],
    "edges": []
  },
  "exportedAt": "2026-03-30T00:00:00.000Z"
}
```

Includes node types/config, edge graph, and node positions for canvas restoration.

## Sample workflows

- `samples/workflows/basic-flow.json`
- `samples/workflows/rag-flow.json`
- `samples/workflows/agentic-mcp-flow.json`

The seed service auto-loads these into DB when the workflow table is empty.

## Notes

- V1 is intentionally a working vertical slice with clear extension seams.
- Auth/RBAC/scheduling/distributed execution are out of V1 scope.
