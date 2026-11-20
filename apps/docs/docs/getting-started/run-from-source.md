---
title: "Run from source: set up, start and test the monorepo"
description: "Work on L2M itself: prerequisites, the .env file, Postgres and queue settings, starting the API, studio and docs, tests, builds and Docker builds."
---

# Run from source

Use this page to work on L2M itself. To just run it, use [Install with Docker](./install.md). The shorter
[Quickstart](./quickstart.md) covers the first sign-in; this page is the full setup reference.

## Prerequisites

- Node.js 24+
- pnpm 10+
- Optional for a local model: Ollama running at `http://localhost:11434/v1`

## 1) Configure the environment

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

Increase the workflow timeout for long-running MCP or model executions (example, 20 minutes):

```bash
WORKFLOW_EXECUTION_TIMEOUT_MS=1200000
```

Every variable is listed on [Environment](./environment.md).

### Optional: PostgreSQL storage

```bash
DB_TYPE=postgres
# Defaults shown; uncomment only what you change.
# DB_POSTGRESDB_HOST=localhost
# DB_POSTGRESDB_PORT=5432
# DB_POSTGRESDB_DATABASE=ai_orchestrator
# DB_POSTGRESDB_USER=postgres
# DB_POSTGRESDB_PASSWORD=
# DB_POSTGRESDB_SSL=false
# DB_POSTGRESDB_POOL_SIZE=10
# Or one URL (wins over the settings above). sslmode require / verify-ca / verify-full turn TLS on and verify the
# certificate and host name; disable turns it off; allow / prefer are refused. DB_POSTGRESDB_SSL, if set, must agree.
# DB_POSTGRESDB_URL=postgres://user:password@host:5432/ai_orchestrator?sslmode=verify-full
# Private CA (PEM or path of a PEM file):
# DB_POSTGRESDB_SSL_CA=/etc/ssl/certs/my-db-ca.pem
# Not recommended: skip certificate verification (a startup warning says so).
# DB_POSTGRESDB_SSL_REJECT_UNAUTHORIZED=false
```

See [Postgres](../operations/postgres.md) for the full guide. Without `DB_TYPE=postgres`, L2M uses SQLite through
`sql.js`, persisted to `apps/api/data/orchestrator.db`.

### Optional: execution queue concurrency

```bash
QUEUE_CONCURRENCY=5
```

See [Queue and workers](../operations/queue-and-workers.md).

## 2) Install

```bash
pnpm install
```

For rich HTML and image PDF rendering in the `PDF Output` node (`renderMode=html`), install Chromium for Playwright:

```bash
pnpm exec playwright install chromium
```

## 3) Start the servers

Start the API, the web studio and the docs together:

```bash
pnpm dev
```

- API: `http://localhost:4000`
- Web UI: `http://localhost:5173`
- Docs UI: `http://localhost:4173`

Set `VITE_DOCS_URL` (in `apps/web/.env` or your build environment) to override the target of the studio's top-bar Docs link.

Start the product only (API and web UI):

```bash
pnpm dev:product
```

Start one part alone:

```bash
pnpm --filter @ai-orchestrator/api start     # API only
pnpm --filter @ai-orchestrator/web dev       # web UI only
pnpm docs:dev                                # docs site only, http://localhost:4173
```

## 4) Run the tests

```bash
pnpm test
```

Only the web unit and component tests:

```bash
pnpm --filter @ai-orchestrator/web test
```

The web Playwright golden-journey end-to-end test:

```bash
pnpm --filter @ai-orchestrator/web e2e
```

## 5) Build everything

```bash
pnpm build
```

The [CI pipeline](../operations/ci.md) runs lint, test, build, the docs build and the end-to-end test.

## Docker from source

```bash
docker compose up --build
```

- Web: `http://localhost:5173`
- API: `http://localhost:4000`

This builds the images from source. Tagged releases also publish signed multi-arch images to GHCR
(`ghcr.io/tensorgreed/l2m`, `ghcr.io/tensorgreed/l2m-web`) with SBOMs and build provenance, and the same images on
Docker Hub (`lsquarem/l2m`, `lsquarem/l2m-web`); see [Verify a release](../operations/verify-a-release.md) to check one
and pin its digest.

## Next

- [Architecture overview](../architecture/overview.md) and the repository layout
- [Environment](./environment.md)
