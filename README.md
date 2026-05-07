# L2M

**The MCP-native agent runtime.** Visual workflow builder, multi-agent Swarm, and a first-party VS Code surface — for developers composing AI agents that do real work in real systems via the [Model Context Protocol](https://modelcontextprotocol.io).

## What makes it different

- **MCP-first.** Wire any MCP server into an agent as a tool. The runtime compacts schemas, shortlists tools by prompt relevance, and caches full tool outputs across multi-turn sessions so models stay grounded without re-calling expensive endpoints. You can also expose your own workflows back out as MCP tools that other agents invoke (`mcp_server_trigger`).
- **Multi-agent Swarm.** Compose Supervisor → Worker hierarchies via dedicated attachment ports. Workers are exposed to the parent as synthetic tools, recursively. Other visual workflow tools either lack MCP integration entirely or treat agent delegation as chained prompts rather than first-class topology.
- **VS Code agent surface.** First-party extension at [`apps/vscode-l2m-agent`](apps/vscode-l2m-agent) turns any workflow into a coding agent inside the editor — streaming responses, patch previews with workspace-path safety, command approval, and bounded context bundling.

Plus the production basics: SAML/LDAP SSO, MFA/TOTP, encrypted secrets with rotation, external secret providers (Vault, AWS, GCP, Azure), RBAC + projects + custom roles, comprehensive audit log, Prometheus metrics, OTEL tracing, multi-main HA via leader election, Postgres or SQLite, Helm chart, Docker Compose prod template, and webhook signature validation (HMAC, Stripe, Discord Ed25519, Telegram).

## What's in the box

- Drag-and-drop node editor (`React Flow`) with mini-map, multi-select, copy/paste/duplicate, undo/redo, sticky notes, dark mode, and a keyboard shortcut panel
- Workflow CRUD with import/export, duplication, projects, folders, tags, search, debug replay, pinned node data, single-node execution, and streaming execution progress
- Runtime: sub-workflows, flow-control nodes, queue-backed execution with DLQ, per-node retry/continue-on-fail, error workflows, parallel-branch execution, and binary-data passthrough
- Triggers: schedule, webhook, form, chat, file, RSS, SSE, MCP-server, manual, and signed Slack/GitHub/Stripe/Telegram/Discord webhooks
- LLM providers: OpenAI, Azure OpenAI, Anthropic, Gemini, Ollama, and OpenAI-compatible endpoints
- MCP adapters: `http_mcp` (remote streamable HTTP) and `mock-mcp` (local demo tools)
- RAG: chunking, embeddings, in-memory + Azure AI Search + Qdrant + Pinecone + PGVector + Chroma + Weaviate retrievers
- 50+ data-transformation, code, crypto, JWT, XML/HTML, file, and compression nodes
- Source control sync (Git push/pull workflows + variables), workflow versioning, log streaming (Syslog/Webhook/Sentry), and a Settings UI for everything

For the GA roadmap, see the [public project board](https://github.com/orgs/TensorGreed/projects/1).

## Architecture overview

- Frontend (`apps/web`): React + TypeScript + React Flow
- Backend (`apps/api`): Fastify + TypeScript
- Product docs (`apps/docs`): VitePress documentation site
- DB: SQLite by default using `sql.js` (persisted to `apps/api/data/orchestrator.db`) or PostgreSQL via `DB_TYPE=postgres`
- Background services: scheduler service, trigger service, and in-process execution queue with persisted queue/DLQ tables
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
|  +- conditional-flow.json
|  +- rag-flow.json
|  +- rag-pinecone-flow.json
|  +- agentic-mcp-flow.json
|  +- structured-output-flow.json
|  +- azure-openai-flow.json
|  +- azure-connectors-demo-flow.json
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

Increase workflow timeout for long-running MCP/LLM executions (example 20 min):

```bash
WORKFLOW_EXECUTION_TIMEOUT_MS=1200000
```

Optional PostgreSQL storage:

```bash
DB_TYPE=postgres
DB_POSTGRESDB_HOST=localhost
DB_POSTGRESDB_PORT=5432
DB_POSTGRESDB_DATABASE=ai_orchestrator
DB_POSTGRESDB_USER=postgres
DB_POSTGRESDB_PASSWORD=
DB_POSTGRESDB_SSL=false
DB_POSTGRESDB_POOL_SIZE=10
```

Optional execution queue concurrency:

```bash
QUEUE_CONCURRENCY=5
```

### 2) Install

```bash
pnpm install
```

If you want rich HTML/image PDF rendering in `PDF Output` node (`renderMode=html`), install Chromium for Playwright:

```bash
pnpm exec playwright install chromium
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

Run only web unit/component tests:

```bash
pnpm --filter @ai-orchestrator/web test
```

Run web Playwright golden-journey E2E:

```bash
pnpm --filter @ai-orchestrator/web e2e
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

## CI

GitHub Actions CI is defined in `.github/workflows/ci.yml` and runs:

- `pnpm lint`
- `pnpm test`
- `pnpm build`
- `pnpm docs:build`
- `pnpm --filter @ai-orchestrator/web e2e`

## Authentication and RBAC

Session model:
- Login creates a server-side `sessions` record and sets `SESSION_COOKIE_NAME` as an `httpOnly` cookie.
- Frontend uses `credentials: "include"` for API calls.
- Session state is persisted in the configured database (`users`, `sessions` tables).

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
| Project/folder/tag list | yes | yes | yes | yes |
| Project/folder/tag create/update/delete | no | no | yes | yes |
| Pinned data list | yes | yes | yes | yes |
| Pin/unpin node data | no | no | yes | yes |
| Execute workflow | no | no | yes | yes |
| Enqueue workflow / queue depth / DLQ | no | yes | yes | yes |
| Execution history/debug load | yes | yes | yes | yes |
| Human approvals | no | yes | yes | yes |
| Execute `/api/webhooks/execute` | no | no | yes | yes |
| Secrets list/create | no | no | yes | yes |
| Register users | first-user only or when public register enabled | first-user only or when public register enabled | no (except public register viewer-level) | yes |

API error behavior:
- `401` for missing/invalid/expired session
- `403` for authenticated users without required role

## Core API endpoints

Health and metadata:
- `GET /health`
- `GET /api/definitions`
- `GET /api/integrations`

Auth:
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

Workflows:
- `GET /api/workflows?projectId=&folderId=&tag=&search=`
- `GET /api/workflows/:id`
- `GET /api/workflows/:id/variables`
- `PUT /api/workflows/:id/variables`
- `POST /api/workflows`
- `PUT /api/workflows/:id`
- `DELETE /api/workflows/:id`
- `POST /api/workflows/:id/duplicate`
- `POST /api/workflows/:id/move`
- `POST /api/workflows/import`
- `GET /api/workflows/:id/export`
- `POST /api/workflows/:id/validate`
- `POST /api/workflows/:id/execute`
- `POST /api/workflows/:id/execute/stream`
- `POST /api/workflows/:id/enqueue`

Projects, folders, tags, and pins:
- `GET /api/projects`
- `POST /api/projects`
- `PUT /api/projects/:id`
- `DELETE /api/projects/:id`
- `GET /api/folders?projectId=`
- `POST /api/folders`
- `PUT /api/folders/:id`
- `DELETE /api/folders/:id`
- `GET /api/workflows/:id/pins`
- `PUT /api/workflows/:id/pins/:nodeId`
- `DELETE /api/workflows/:id/pins/:nodeId`

Execution history, debug helpers, and approvals:
- `GET /api/executions?page=&pageSize=&status=&workflowId=&triggerType=`
- `GET /api/executions/:id`
- `POST /api/code-node/test`
- `POST /api/expressions/preview`
- `GET /api/approvals`
- `POST /api/approvals/:id/approve`
- `POST /api/approvals/:id/reject`

Trigger and webhook entry points:
- `POST /api/webhooks/execute`
- `POST /api/webhooks/execute/stream`
- `POST /api/webhooks/slack/:workflowId`
- `POST /api/webhooks/github/:workflowId`
- `POST /api/triggers/manual/:workflowId`
- `GET /api/forms/:path`
- `POST /api/forms/:path`
- `POST /api/chat/:workflowId`
- `GET /api/mcp-server/:path/manifest`
- `POST /api/mcp-server/:path/invoke`
- `ANY /webhook/:path` (configured production webhook URL)
- `ANY /webhook-test/:path` (configured test webhook URL)

Queue and services:
- `GET /api/queue/depth`
- `GET /api/queue/dlq`

Secrets and connection tests:
- `POST /api/secrets`
- `GET /api/secrets?projectId=`
- `POST /api/connectors/test`
- `POST /api/providers/test`
- `POST /api/mcp/discover-tools`

## Workflow organization and debugging

- Projects isolate workflows and secrets. The API bootstraps a default project and backfills legacy rows on startup.
- Folders organize workflows inside a project. Deleting a folder moves contained workflows back to the project root.
- Tags are stored on workflows and can be edited or filtered from the dashboard.
- The dashboard supports project switching, folder filtering, tag filtering, and search by name, ID, or tag.
- Pinned node data is stored in `workflow.pinnedData` and reused during test runs unless `usePinnedData=false`.
- Single-node execution uses `runMode: "single_node"` with a selected `startNodeId` and supplied previous node outputs or pinned parent data.
- Execution history can be loaded back into the editor for failed-run debugging or re-run with `sourceExecutionId`.
- Debug mode shows compact node input/output/error previews on the canvas and schema/table views in the node inspector.

## Connector and trigger coverage

Tier 1 integrations exposed through `/api/integrations`:

- HTTP request, configured webhook input, and webhook response
- Slack send message and Slack Events API trigger
- SMTP send email and IMAP email trigger
- Google Sheets read/append/update and polling trigger
- PostgreSQL query and polling trigger
- MySQL query
- MongoDB find/insert/update/aggregate
- Redis commands and Redis trigger
- GitHub issue/PR/repo actions and signed GitHub webhook trigger

General trigger nodes:

- `schedule_trigger`
- `manual_trigger`
- `webhook_input`
- `form_trigger`
- `chat_trigger`
- `file_trigger`
- `rss_trigger`
- `sse_trigger`
- `mcp_server_trigger`
- `slack_trigger`
- `github_webhook_trigger`
- `google_sheets_trigger`
- `postgres_trigger`
- `redis_trigger`
- `imap_email_trigger`
- `error_trigger`

Message queue trigger nodes are registered for Kafka, RabbitMQ, and MQTT with optional-dependency detection. Their long-lived consumers are intentionally guarded until the corresponding client dependency and deployment path are configured.

## Chat model nodes (implemented)

Agent Chat Model attachments can use dedicated provider nodes:

- `OpenAI Chat Model` (`openai_chat_model`)
- `Anthropic Chat Model` (`anthropic_chat_model`)
- `Ollama Chat Model` (`ollama_chat_model`)
- `OpenAI Compatible Chat Model` (`openai_compatible_chat_model`)
- `AI Gateway Chat Model` (`ai_gateway_chat_model`)
- `Azure OpenAI Chat Model` (`azure_openai_chat_model`)
- `Google Gemini Chat Model` (`google_gemini_chat_model`)
- Legacy generic `LLM Call` (`llm_call`)

## Azure node suite (implemented)

The Azure suite is implemented end-to-end:

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
- `Test Connection` action for LLM model nodes (`/api/providers/test`)
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

Optional payload field for long runs:

```json
{
  "executionTimeoutMs": 1200000
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

## Rich PDF output (HTML + images)

`PDF Output` node supports two render modes:

- `text` (default): fast plain-text PDF
- `html`: renders HTML/CSS/images using headless Chromium

Recommended config for charts/reports:

- Set `renderMode = html`
- Put report HTML in `htmlTemplate` or upstream `inputKey`
- Keep `printBackground = true`
- Choose `pageFormat` (`A4` default)

If Chromium is not auto-detected, set:

```bash
PDF_CHROMIUM_EXECUTABLE_PATH=/absolute/path/to/chrome-or-chromium
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
  - memory persists conversation turns in the configured database by `namespace + session_id`
- `tool` port:
  - attach one or more `MCP Tool` nodes
  - attached tool configs are converted into available MCP tools for the agent loop
- `worker` port (Supervisor Node only):
  - attach worker `Agent Orchestrator` or `Supervisor` nodes
  - connected workers are dynamically exposed as tool calls to the parent Supervisor, allowing it to delegate tasks downstream recursively for Swarm coordination.

Attachment-only helper nodes are marked as skipped in execution traces because they are consumed by the agent runtime rather than executed as direct steps.

## Node Input Mapping (Data Passing)

Nodes can dynamically read outputs from previous nodes in the DAG layout.

In a node's configuration, use `{{ ... }}` templates or dedicated mapping blocks to inject upstream data into prompts, tool arguments, connector parameters, and output templates.

Supported template forms:

- Simple dotted paths for back compatibility, for example `{{user_prompt}}` or `{{parent_outputs.nodeId.answer}}`
- JavaScript-like expressions for richer logic, for example `{{ $if($json.status === "ok", "continue", "stop") }}`
- Built-ins: `$input`, `$json`, `$node`, `$workflow`, `$execution`, `$env`, `$vars`, `$now`, `$today`, `$itemIndex`
- Helpers: `$jmespath(input, path)`, `$if(condition, trueValue, falseValue)`, `$ifEmpty(value, fallback)`

The expression preview endpoint (`POST /api/expressions/preview`) lets the editor evaluate expression fields against sample data before saving a workflow.

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

`Simple Memory` (`local_memory`) is a real database-backed session memory node.

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
- On each external MCP tool call, runtime stores full tool args/output in the configured database by `namespace + session_id`.
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

- `samples/workflows/basic-flow.json` — text-in / LLM / text-out, runs zero-key with the bundled echo provider.
- `samples/workflows/mcp-agent-quickstart-flow.json` — zero-key MCP agent (target of the [5-minute tutorial](apps/docs/docs/getting-started/build-your-first-mcp-agent.md)).
- `samples/workflows/supervisor-worker-swarm-flow.json` — multi-agent: a Supervisor delegating to a researcher and a computer worker.
- `samples/workflows/workflow-as-mcp-tool-flow.json` — `mcp_server_trigger` exposing a workflow as a callable MCP tool.
- `samples/workflows/agentic-mcp-flow.json` — webhook → agent → MCP tools + memory.
- `samples/workflows/two-turn-report-code-helper-flow.json` — multi-turn helper with deterministic session artifacts.
- `samples/workflows/vscode-l2m-coding-agent-flow.json` — canonical wiring for the VS Code extension.
- `samples/workflows/conditional-flow.json` — branching from a webhook trigger.
- `samples/workflows/rag-flow.json` — RAG with Google Drive + in-memory vector store.
- `samples/workflows/rag-pinecone-flow.json` — RAG backed by Pinecone.
- `samples/workflows/structured-output-flow.json` — schema-validated structured output extraction.
- `samples/workflows/azure-openai-flow.json` — basic LLM flow using Azure OpenAI.
- `samples/workflows/azure-connectors-demo-flow.json` — Azure Storage / Cosmos DB / Monitor / AI Search.

Set `SEED_SAMPLE_WORKFLOWS=true` to load these into the database when the workflow table is empty. See the [pattern library](apps/docs/docs/patterns/index.md) for when to use which.

For full real-world reference projects (helpdesk agent, support triage, VS Code repo reviewer) with end-to-end READMEs and production-deployment notes, see the dedicated [**l2m-samples**](https://github.com/TensorGreed/l2m-samples) repo.

## Contributing

L2M is **pure OSS (MIT)** and the project's growth depends on community contributions — adapters, MCP integrations, docs, bug reports, real-world patterns. Start with [CONTRIBUTING.md](CONTRIBUTING.md). Bug? File a [bug report](https://github.com/TensorGreed/ai-orchestrator/issues/new?template=bug_report.yml). Question or design discussion? Use [GitHub Discussions](https://github.com/TensorGreed/ai-orchestrator/discussions). Security issue? Use a [private advisory](https://github.com/TensorGreed/ai-orchestrator/security/advisories/new) — see [SECURITY.md](SECURITY.md). Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). Notable changes are tracked in [CHANGELOG.md](CHANGELOG.md).

## Status and roadmap

L2M ships a deep capability surface today. Enterprise capabilities — SAML/LDAP SSO, MFA, audit logging, external secret managers, source control sync, OpenAPI coverage, multi-main HA via leader election — are implemented. The active focus is GA polish: deepening the MCP/Swarm/VS Code differentiators, first-run UX, production hardening (rate limiting, security headers, image build automation), and a community node SDK so connectors can be shipped as npm packages.

The horizontal-scaling story moves further along when the in-process queue backend is swapped for Redis/BullMQ; the Helm chart and Docker Compose prod template already assume webhook process separation and leader-elected schedulers.

