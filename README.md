# AI Orchestrator V1

A runnable V1 visual AI workflow builder and runtime inspired by n8n/Langflow, focused on agent orchestration, MCP tools, LLM providers, RAG nodes, connector nodes, and webhook-triggered execution.

## What this V1 includes

- Drag-and-drop node editor (`React Flow`) with connectable edges and persisted node positions
- Workflow CRUD, import/export JSON, graph validation, and execution tracing
- LLM provider adapter model with built-in adapters for:
  - Ollama (real)
  - OpenAI-compatible endpoints (real)
  - OpenAI cloud (real)
  - Azure OpenAI (real)
  - Gemini (basic)
- MCP adapter model with:
  - `http_mcp` (real remote MCP endpoint over HTTP streamable)
  - `mock-mcp` (local demo tools)
- Agent Orchestrator & Supervisor Nodes with iterative tool-calling loop and Swarm delegation
- Agent port attachments (auxiliary edges):
  - `chat_model` -> attach `LLM Call` or `Azure OpenAI Chat Model` node
  - `memory` -> attach `Simple Memory` node
  - `tool` -> attach one or more `MCP Tool` nodes
  - `worker` -> attach worker `Agent Orchestrator` or `Supervisor` nodes (applies to Supervisor nodes only)
- RAG path with connector source + in-memory retriever/vector similarity
- Connector SDK + connectors (`google-drive`, `sql-db`, `nosql-db`, `azure-storage`, `azure-cosmos-db`, `azure-monitor`, `azure-ai-search`)
- Webhook execution endpoint (`system_prompt` + `user_prompt` payload)
- Secret abstraction with encrypted server-side storage (AES-256-GCM)
- Session-based authentication (`httpOnly` cookie) with RBAC (`admin`, `builder`, `operator`, `viewer`)
- Monorepo with shared schemas/types and package-level extension points

## Architecture overview

- Frontend (`apps/web`): React + TypeScript + React Flow
- Backend (`apps/api`): Fastify + TypeScript
- Product docs (`apps/docs`): VitePress documentation site
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
|  +- basic-flow.json
|  +- rag-flow.json
|  +- agentic-mcp-flow.json
+- docs/
|  +- (legacy static site)
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

Set bootstrap admin credentials in `.env` (recommended for local dev):

```bash
BOOTSTRAP_ADMIN_EMAIL=admin@example.com
BOOTSTRAP_ADMIN_PASSWORD=ChangeThisPassword123!
```

### 2) Install

```bash
pnpm install
```

### 3) Start servers

Start API + UI + docs together:

```bash
pnpm dev
```

- API: `http://localhost:4000`
- Web UI: `http://localhost:5173`
- Docs UI: `http://localhost:4173`

Optional: set `VITE_DOCS_URL` (in `apps/web/.env` or your build env) to override the top-bar Docs link target.

Start product only (API + UI):

```bash
pnpm dev:product
```

Start API only:

```bash
pnpm --filter @ai-orchestrator/api start
```

Start UI only:

```bash
pnpm --filter @ai-orchestrator/web dev
```

Start docs site only:

```bash
pnpm docs:dev
```

- Docs UI: `http://localhost:4173`

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

## Authentication and RBAC

Session model:
- Login creates a server-side `sessions` record and sets `SESSION_COOKIE_NAME` as an `httpOnly` cookie.
- Frontend uses `credentials: "include"` for API calls.
- Session state is persisted in SQLite (`users`, `sessions` tables).

Auth endpoints:
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

`POST /api/auth/register` payload:
- `email` (required)
- `password` (required, min 8)
- `role` (optional: `admin|builder|operator|viewer`)
- `admin` (optional boolean shortcut; equivalent to `role: "admin"`)

Bootstrap credentials strategy:
- If `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` are set and there are no users yet, API bootstraps the first admin account on startup.
- If bootstrap values are not set, you can create the first user with `POST /api/auth/register`; first user defaults to `admin`.
- Keep `AUTH_ALLOW_PUBLIC_REGISTER=false` in non-dev environments.

Role permissions:

| Area | viewer | operator | builder | admin |
| --- | --- | --- | --- | --- |
| Workflow list/get/export/validate | yes | yes | yes | yes |
| Workflow create/update/delete | no | no | yes | yes |
| Execute workflow | no | no | yes | yes |
| Execute `/api/webhooks/execute` | no | no | yes | yes |
| Secrets list/create | no | no | yes | yes |
| Register users | first-user only or when public register enabled | first-user only or when public register enabled | no (except public register viewer-level) | yes |

API error behavior:
- `401` for missing/invalid/expired session
- `403` for authenticated users without required role

## Core API endpoints

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
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
- `ANY /webhook/:path` (configured production webhook URL)
- `ANY /webhook-test/:path` (configured test webhook URL)
- `POST /api/secrets`
- `GET /api/secrets`
- `POST /api/connectors/test`
- `POST /api/mcp/discover-tools`

## Azure node suite (implemented)

The Azure suite from the n8n-style screenshot is implemented end-to-end in this V1:

- `Azure OpenAI Chat Model` (`azure_openai_chat_model`)
- `Embeddings Azure OpenAI` (`embeddings_azure_openai`)
- `Azure Storage` (`azure_storage`)
- `Azure Cosmos DB` (`azure_cosmos_db`)
- `Microsoft Azure Monitor` (`azure_monitor_http`)
- `Azure AI Search Vector Store` (`azure_ai_search_vector_store`)

## Qdrant node suite (implemented)

- `Qdrant Vector Store` (`qdrant_vector_store`) with actions:
  - `get_ranked_documents`
  - `add_documents`
  - `retrieve_for_chain_tool`
  - `retrieve_for_ai_agent_tool`

Qdrant is also available in `RAG Retrieve` via `vectorStoreId = qdrant-vector-store`.
For env-backed local defaults you can set `QDRANT_ENDPOINT` and `QDRANT_API_KEY`.

What is included for these nodes:

- structured node config forms in the editor (no free-form JSON required for normal use)
- dedicated node icons on canvas and in node library
- secret-backed credentials via `secretRef.secretId`
- `Test Connection` action for connector nodes (`/api/connectors/test`)
- execution support in the workflow engine (including demo fallback mode for local development)

## Webhook execution

Configure the `Webhook Input` node with:
- `method` (default `POST`)
- `path` (example: `agent-demo`)

Then call the generated URL from Postman:
- Test URL: `http://localhost:4000/webhook-test/<path>`
- Production URL: `http://localhost:4000/webhook/<path>`

Webhook payload (minimum):

```json
{
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
curl -X POST http://localhost:4000/webhook/agent-demo \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "demo-session-1",
    "system_prompt": "You are a tool-using agent. Use tools when required.",
    "user_prompt": "What time is it in America/Toronto and what is 12*7?"
  }'
```

Compatibility endpoint (still supported): `POST /api/webhooks/execute` with `workflow_id`.

### Webhook security modes

Webhook Input node now supports:
- `none`
- `bearer_token`
- `hmac_sha256`

Configure these in the Webhook node modal:
- auth mode
- header names
- secret reference
- idempotency toggle + header name

#### Postman example: bearer token

Headers:
- `Authorization: Bearer <token>`

Body:

```json
{
  "user_prompt": "hello",
  "system_prompt": "You are concise."
}
```

#### Postman example: HMAC SHA256

Assume:
- timestamp header: `x-webhook-timestamp`
- signature header: `x-webhook-signature`
- signing secret: `<shared_secret>`

Signature formula:
- `signature = hex(HMAC_SHA256(secret, timestamp + "." + raw_body))`

Headers:
- `x-webhook-timestamp: <unix_seconds_or_iso>`
- `x-webhook-signature: <hex_signature>` (or `sha256=<hex_signature>`)

Body (raw JSON):

```json
{
  "user_prompt": "hello",
  "system_prompt": "You are concise."
}
```

Replay/idempotency behavior:
- signed requests require timestamp and are rejected outside tolerance window (default 5 minutes)
- duplicate signed fingerprint within TTL is rejected as replay (`403`)
- when idempotency is enabled, repeated `Idempotency-Key` for same endpoint returns cached result instead of re-running

## Agent loop behavior (Agent Orchestrator node)

1. Resolve system prompt + user prompt templates
2. Discover attached MCP tools from configured MCP servers
3. Expose tool metadata to selected LLM provider
4. Call model with conversation + tools
5. If model returns tool calls, invoke tools and append tool outputs as tool messages
6. Repeat model call with updated context
7. Stop on final answer or `maxIterations`

The runtime supports zero, one, or multiple tool calls per iteration.

## Swarm Multi-Agent & Port Attachments

The Agent Orchestrator and Supervisor Nodes support dedicated attachment ports. These are auxiliary edges and are not part of linear DAG execution.

- `chat_model` port:
  - attach an `LLM Call` or `Azure OpenAI Chat Model` node
  - this attachment is required; the agent runtime always uses this node's `provider` config
- `memory` port:
  - attach a `Simple Memory` node
  - memory persists conversation turns in SQLite by `namespace + session_id`
- `tool` port:
  - attach one or more `MCP Tool` nodes
  - attached tool configs are converted into available MCP tools for the agent loop
- `worker` port (Supervisor Node only):
  - attach worker `Agent Orchestrator` or `Supervisor` nodes
  - connected workers are dynamically exposed as tool calls to the parent Supervisor, allowing it to delegate tasks downstream recursively for Swarm coordination.

Attachment-only helper nodes are marked as skipped in execution traces because they are consumed by the agent runtime rather than executed as direct steps.

## Node Input Mapping (Data Passing)

Nodes can dynamically read outputs from previous nodes in the DAG layout. 
In a node's configuration, you can use handlebars-style templates or dedicated mapping blocks to pass `results.nodeId.someKey` to dynamically inject an upstream agent's output into a downstream agent's prompt or a tool's parameters.

## Output Parser Robust Parsing

`Output Parser` now supports parser strictness profiles (independent of parser `mode`):

- `strict`: accepts only valid JSON
- `lenient`: repairs common JSON-like output (single quotes, python booleans/None, trailing commas, unquoted keys)
- `anything_goes`: includes `lenient` and best-effort `key: value` parsing

`inputKey` supports path forms:

- `debug.agent_answer`
- `messages[5].content`
- `{{debug.agent_answer}}`

When parsing succeeds/fails, node output includes `parserTrace` with strategy/confidence/attempt metadata for debugging.

## MCP Node Setup (real endpoint)

Use an `MCP Tool` node attached to the Agent `tool` port.

1. Open MCP node config.
2. Set `MCP Server Adapter` to `HTTP MCP Server (http_mcp)`.
3. Set `Endpoint` to your MCP server URL.
4. Set `Request Timeout (ms)` based on tool latency (for large fetches use `60000`-`300000`).
5. Set `Authentication` (`None` / `Bearer` / `Basic`) and choose `Auth Secret` if needed.
6. Click `Discover Tools`, then select the discovered tool.
7. To expose every discovered tool to the agent, set `Tools To Include` to `All discovered tools (agent decides)`.

Notes:
- `mock-mcp` is a demo adapter and always returns demo tools (`get_current_time`, `calculator`, `lookup_kb`).
- If you want a brand-new adapter implementation, select `Custom Adapter ID` and register that adapter in `packages/mcp-sdk/src/index.ts`.
- If your MCP server exposes many large tool schemas, model context limits can be hit. The runtime now compacts tool schemas, truncates oversized tool outputs in conversation memory, and caps tool metadata sent to the model.
- In all-tools mode, runtime also shortlists tools by prompt relevance to reduce wrong tool picks across similarly named endpoints.

### Configurable Tool Output Limits (Agent Orchestrator)

In Agent Orchestrator node config, use **Tool Output Limits (Advanced)** to control truncation:

- `toolMessageMaxChars`
- `toolPayloadMaxDepth`
- `toolPayloadMaxObjectKeys`
- `toolPayloadMaxArrayItems`
- `toolPayloadMaxStringChars`

These values are passed directly to the runtime and validated server-side.

Recommended starting point for large-context local models (~92k available context):

- `toolMessageMaxChars`: `90000`
- `toolPayloadMaxDepth`: `8`
- `toolPayloadMaxObjectKeys`: `256`
- `toolPayloadMaxArrayItems`: `256`
- `toolPayloadMaxStringChars`: `4096`

If you still hit provider context errors, reduce these values first (especially `toolMessageMaxChars`), then reduce attached tool count.

## Simple Memory Node

`Simple Memory` (`local_memory`) is a real SQLite-backed session memory node.

Config:
- `namespace`: memory bucket key (default `default`)
- `sessionIdTemplate`: defaults to `{{session_id}}`
- `maxMessages`: max persisted turns retained
- `persistToolMessages`: whether tool messages are saved in memory

DB storage table:
- `session_memory(namespace, session_id, messages_json, created_at, updated_at)`

## Session Tool Cache (Automatic)

To support multi-turn agent conversations without flooding model context, the runtime now caches full MCP tool outputs outside the LLM prompt window.

How it works:
- On each external MCP tool call, runtime stores full tool args/output in SQLite by `namespace + session_id`.
- The model sees compact tool messages in-context (for token safety), but full payload remains retrievable.
- Runtime injects two internal tools automatically (when `session_id` is present):
  - `session_cache_list`
  - `session_cache_get`
- On follow-up turns, the model can fetch prior tool data from cache instead of re-calling MCP endpoints.

Requirements for reuse across turns:
- Use the same `session_id` on follow-up webhook/UI runs.
- Keep agent memory namespace stable (default is stable per workflow/agent attachment).

DB storage table:
- `session_tool_cache(id, namespace, session_id, tool_name, tool_call_id, args_json, output_json, error, summary_json, created_at)`

Why this helps:
- reduces repeated expensive MCP calls
- avoids large-context crashes for local models
- keeps follow-up questions grounded in previously fetched data

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
- `samples/workflows/azure-openai-flow.json`
- `samples/workflows/azure-connectors-demo-flow.json`

The seed service auto-loads these into DB when the workflow table is empty.

## Notes

- V1 is intentionally a working vertical slice with clear extension seams.
- Scheduling/distributed execution/multi-tenant auth remain out of V1 scope.

