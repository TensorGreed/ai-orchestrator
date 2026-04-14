# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repo orientation

This is a pnpm + TypeScript monorepo (`pnpm-workspace.yaml` globs `apps/*` + `packages/*`). It implements a visual AI workflow builder/runtime inspired by n8n / Langflow. Node.js 20+ and pnpm 10+ required.

## Common commands

All commands run from the repo root unless noted.

- `pnpm install` — install workspace deps.
- `pnpm dev` — start API (4000) + Web (5173) + Docs (4173) concurrently.
- `pnpm dev:product` — API + Web only (no docs).
- `pnpm --filter @ai-orchestrator/api dev` / `start` — run API alone (tsx watch / tsx).
- `pnpm --filter @ai-orchestrator/web dev` — run web UI alone (vite).
- `pnpm build` — recursive `build` across workspace (API uses `tsc --noEmit`; web runs `tsc -b && vite build`).
- `pnpm test` — recursive vitest (`--passWithNoTests` in most packages). Scope a single package: `pnpm --filter @ai-orchestrator/workflow-engine test`. Single test file: `pnpm --filter @ai-orchestrator/workflow-engine exec vitest run src/phase2.test.ts`. Filter by name: `... vitest run -t "fragment of test name"`.
- `pnpm lint` — recursive (only runs in packages that define `lint`).
- Docker: `docker compose up --build` (docker-compose.yml in root).

## Environment (minimum for local dev)

Copy `.env.example` → `.env`. Required / important vars (validated via zod in [apps/api/src/config.ts](apps/api/src/config.ts)):

- `SECRET_MASTER_KEY_BASE64` — base64(32 random bytes). Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Required for secret encryption/decryption at rest (AES-256-GCM).
- `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` — first admin user is created on startup if user table is empty.
- `WORKFLOW_EXECUTION_TIMEOUT_MS` — bump for long MCP/LLM runs (default 300000).
- `AUTH_ALLOW_PUBLIC_REGISTER` — keep `false` outside dev.
- SQLite DB file: `apps/api/data/orchestrator.db` (auto-created via `sql.js`).

Optional: `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OLLAMA_BASE_URL`, `QDRANT_ENDPOINT`/`QDRANT_API_KEY`, `PDF_CHROMIUM_EXECUTABLE_PATH`. For HTML-render PDF output: `pnpm exec playwright install chromium`.

## Architecture (big picture)

The split between SDK packages, the execution engine, and the Fastify app is deliberate — each layer has a registry that the next layer composes. New adapters slot into existing registries; avoid bypassing them.

### Layering

1. **`packages/shared`** — zod schemas, TypeScript types, node definitions (`nodeDefinitions`), error classes. Single source of truth for the workflow JSON contract (`schemaVersion 1.0.0`). All cross-package types come from here.

2. **SDK packages** — each exposes `createDefault<X>Registry()` which is the extension seam. New integrations register here and are then consumed by the runtime.
   - [packages/provider-sdk](packages/provider-sdk/src/) — LLM adapters (`openai`, `openai-compatible`, `azure-openai`, `anthropic`, `gemini`, `ollama`). Also houses `resilient-fetch.ts` (retry/backoff) and `tool-arg-parser.ts`.
   - [packages/mcp-sdk](packages/mcp-sdk/src/) — MCP server adapters (`http-mcp`, `mock-mcp`). `tool-resolution.ts` is used for prompt-aware tool shortlisting.
   - [packages/connector-sdk](packages/connector-sdk/src/) — data connectors (google-drive, sql, nosql, qdrant, azure-*). Used by RAG + connector nodes.

3. **`packages/agent-runtime`** — implements the tool-calling agent loop. Consumes a provider registry, MCP registry, memory, and a session tool cache. Loop: resolve prompts → discover tools → call model with tools → execute tool calls → append tool messages → repeat until final answer or `maxIterations`. Supports zero/one/many tool calls per iteration and Supervisor→worker delegation (workers are exposed to the parent as synthetic tools). Automatically injects `session_cache_list` / `session_cache_get` internal tools when a `session_id` is present.

4. **`packages/workflow-engine`** — pure DAG executor. `executor.ts` walks nodes in topological order; `graph.ts` + `validation.ts` enforce structure; `template.ts` + `expression.ts` handle `{{results.nodeId.key}}` interpolation between nodes; `serialization.ts` handles import/export. `connectors/tier1*.ts` and `phase2-dispatch.ts` are dispatch tables mapping node type → execution handler. `rag-adapters.ts` wires the in-memory retriever + vector-similarity path. `python-runner.ts` executes code-node sandboxes.

5. **`apps/api`** (Fastify + `sql.js` SQLite + optional `pg`) — composes everything:
   - [apps/api/src/app.ts](apps/api/src/app.ts) builds the Fastify instance, wires registries, schemas, and routes. `index.ts` boots it.
   - [apps/api/src/db](apps/api/src/db/) — `create-store.ts` picks SQLite vs Postgres; `migrations.ts` owns schema evolution; tables include `users`, `sessions`, `workflows`, `secrets`, `session_memory`, `session_tool_cache`, execution/approval tables.
   - [apps/api/src/services](apps/api/src/services/) — `auth-service` (session cookies, RBAC: admin/builder/operator/viewer), `secret-service` (AES-256-GCM encrypt at rest, `secretRef.secretId` only in configs, never echo raw values), `seed-service` (loads `samples/workflows/*.json` when workflow table is empty if `SEED_SAMPLE_WORKFLOWS=true`), `scheduler-service` (cron via `node-cron`), `queue-service`.
   - Webhook routing: `ANY /webhook/:path` (prod), `ANY /webhook-test/:path` (test), `POST /api/webhooks/execute` (compat). Webhook nodes support `none` / `bearer_token` / `hmac_sha256` auth + replay/idempotency windows.

6. **`apps/web`** — React 19 + React Flow + Zustand. `WorkflowCanvasArea.tsx`, `WorkflowCanvasNode.tsx`, `NodeConfigModal.tsx` are the editor core. `lib/api.ts` is the thin API client (uses `credentials: "include"` for session cookies). `build:widget` produces an embeddable bundle via `widget/`.

7. **`apps/docs`** — VitePress product docs. The repo-root `docs/` folder is a **legacy static site** — don't edit it unless specifically asked.

### Agent port semantics (non-DAG edges)

Agent Orchestrator / Supervisor nodes expose attachment ports that are **not** walked as DAG steps — they're consumed by the agent runtime at node execution time and marked `skipped` in traces:

- `chat_model` (required) → `LLM Call` / `Azure OpenAI Chat Model` node. Provider config lives on the attached node.
- `memory` → `Simple Memory` node (SQLite `session_memory` keyed by namespace + session_id).
- `tool` (0..N) → `MCP Tool` nodes. Discovered tools are compacted + shortlisted by prompt relevance in all-tools mode.
- `worker` (Supervisor only, 0..N) → other Agent/Supervisor nodes exposed as synthetic tools to the parent.

When editing the engine or runtime, preserve this distinction: linear-DAG edges vs attachment edges.

### Workflow JSON

Stable contract — `schemaVersion: "1.0.0"`, includes nodes, edges, and node positions. Import/export through `serialization.ts`. Samples under [samples/workflows](samples/workflows/) are also the seed dataset.

## Conventions worth knowing

- `.js`-suffixed imports in TS source are intentional (NodeNext/ESM resolution) — don't strip them.
- Never return raw secret values from API responses; always go through `SecretService` and pass `secretRef.secretId` in configs.
- Adding an integration = implement the adapter interface in the matching SDK package, then register it in that package's `createDefault<X>Registry()` in `src/index.ts`. Don't wire new adapters directly inside `apps/api`.
- Node types referenced in [apps/api/src/app.ts](apps/api/src/app.ts) `TIER1_INTEGRATIONS` must match definitions in `packages/shared` and dispatch handlers in `packages/workflow-engine/src/connectors/tier1-dispatch.ts` or `phase2-dispatch.ts`.
- Tests live beside source as `*.test.ts` and run under vitest.

## Development Standards & "Definition of Done"

Whenever implementing a feature, bug fix, or schema change, you must provide a **full end-to-end implementation**.

### 1. The Full-Stack Ripple Effect
- **Schema & Types:** Start in `packages/shared`. Update Zod schemas first. Ensure the `schemaVersion` is considered if changing the workflow contract.
- **Database & Migrations:** - Update `apps/api/src/db/migrations.ts`.
    - **Automatic Execution:** After modifying migration files, you must attempt to run the server or a migration script (e.g., via `pnpm --filter @ai-orchestrator/api dev`) to ensure the SQLite schema updates successfully.
- **Engine Logic:** If adding/modifying nodes, update the dispatch tables in `packages/workflow-engine/src/connectors/`. Respect the distinction between **DAG edges** and **Attachment ports** (chat_model, memory, tool).
- **Frontend:** Update React components in `apps/web`. Ensure UI components correctly reflect new Zod schema properties.

### 2. Quality & Verification
- **Production Readiness:** No "TODO" comments. Include proper error boundaries and Fastify error handling.
- **Testing:** - Every logic change requires a corresponding `*.test.ts`. 
    - For engine changes, run: `pnpm --filter @ai-orchestrator/workflow-engine test`.
- **Secrets:** Never bypass `SecretService`. Ensure new config variables are added to `.env.example` and validated in `apps/api/src/config.ts`.
- **Validation:** Run `pnpm lint` before finishing to ensure ESM `.js` imports are correct.