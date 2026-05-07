# Changelog

All notable changes to L2M are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Pre-1.0 note**: until L2M reaches `v1.0.0`, minor version bumps may carry small behavior changes that aren't strictly additive. Breaking changes will always be called out under a "Changed" or "Removed" heading and (for workflow JSON) accompanied by a `schemaVersion` bump.

## [Unreleased]

The initial GA release covers production hardening, OSS-growth foundations, and the docs/evangelism flywheel.

### Added

#### MCP, agents, and the niche
- **5-minute MCP agent tutorial** — the conversion path for new visitors. Walks from clone → running agent without any LLM credentials. See [`apps/docs/docs/getting-started/build-your-first-mcp-agent.md`](apps/docs/docs/getting-started/build-your-first-mcp-agent.md).
- **Pattern library** — 10 documented topologies (zero-key MCP, webhook → agent → MCP, supervisor + worker swarm, workflow-as-MCP-tool, RAG, conditional, multi-turn artifacts, structured output, VS Code, Azure OpenAI), each with a runnable sample. See [`apps/docs/docs/patterns/index.md`](apps/docs/docs/patterns/index.md).
- **Zero-key sample workflows**:
  - `mcp-agent-quickstart-flow.json` — manual trigger → agent → output, attached to bundled echo provider + in-process mock-mcp tools.
  - `supervisor-worker-swarm-flow.json` — Supervisor coordinating a researcher worker and a computer worker.
  - `workflow-as-mcp-tool-flow.json` — `mcp_server_trigger` exposing a knowledge-base agent as a callable MCP tool at `/api/mcp-server/kb-helper`.
- **Auto-generated per-node reference docs** — every node's config schema (132 nodes across 8 categories) is rendered from the canonical `nodeDefinitions` registry. CI drift-check fails if `definitions.ts` and the docs diverge.

#### Production hardening
- **Rate limiting** on `/auth/*` (10/min), `/webhook/*`, `/webhook-test/*`, `/api/webhooks/*` (120/min), with global per-IP defaults. Configurable via `RATE_LIMIT_*` env vars; `/health` and `/metrics` are never throttled.
- **Security headers via `@fastify/helmet`** — `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. `HELMET_HSTS_ENABLED` and `HELMET_CSP_ENABLED` opt-in for HTTPS deployments.
- **Multi-stage Dockerfiles** for both API and Web — non-root user, `tini` as PID 1, `HEALTHCHECK` against `/health`, pruned runtime image.
- **Request-ID propagation** — every request gets an `x-request-id` (echoed if supplied), threaded through pino logs and TracingService spans for grep-friendly debugging.
- **Helm chart hardening** — `PersistentVolumeClaim` for `/app/apps/api/data` (was `emptyDir`) so SQLite, git working tree, and binary blobs survive pod restarts. SQLite-vs-Postgres tradeoff documented in [`ops/helm/ai-orchestrator/README.md`](ops/helm/ai-orchestrator/README.md).
- **GHCR multi-arch image publishing** on `v*` tags — `ghcr.io/tensorgreed/ai-orchestrator:<tag>` (API) and `ghcr.io/tensorgreed/ai-orchestrator-web:<tag>` (Web), built for `linux/amd64` + `linux/arm64`.
- **Migration rollback framework** — every migration carries paired `up`/`down` SQL. `pnpm --filter @ai-orchestrator/api db:rollback -- --to <v> --yes` walks a Postgres deployment back to a target schema version for botched-deploy recovery.
- **Backup/restore CLIs** — `pnpm --filter @ai-orchestrator/api db:export` writes a JSON snapshot of the data tier; `db:import` restores. With `--source-master-key` the importer decrypts encrypted blobs (`secrets`, `mfa_secrets`, `log_stream_destinations`) under the source key and re-encrypts under the current `SECRET_MASTER_KEY_BASE64` — supports rotating the master key without losing access to stored secrets.
- **Critical-path integration tests** — multi-node DAG executor with cross-node template interpolation through the public API; master-key rotation end-to-end.

#### First-run UX
- **Welcome modal** on first login (Try a template / Build an MCP agent / Open the docs).
- **Self-contained Basic LLM Flow** — replaces the Ollama-dependent default with the built-in `echo` provider so a fresh install runs end-to-end with no setup.
- **Template-card dependency badges** — gallery cards surface required credentials/services up front.
- **Field-level help in NodeConfigModal** for agent nodes (agent_orchestrator, agent_supervisor, mcp_tool, output_parser).
- **Friendly executor errors** — `WorkflowError` carries `category` + `remediation`; the UI surfaces actionable guidance instead of raw stack traces.
- **Template gallery thumbnails** — auto-generated SVGs from workflow node positions.

#### MCP moat deepening
- **stdio MCP transport** in `@ai-orchestrator/mcp-sdk` — covers the 90% of community MCP servers (filesystem, git, postgres, brave-search, slack, github, etc.).
- **MCP probe / tool inspector** — "Test connection" button on the MCP Tool node lists discovered tools and lets you dry-run with sample args.
- **MCP server registry / preset catalogue** — `/api/mcp/presets` returns curated community servers for one-click install.
- **Swarm visualization** on the canvas — Supervisor → Worker attachment ports get distinct visual treatment.

#### VS Code agent surface
- **Packaging via `vsce` and `ovsx`** — `.vsix` artifact builds in CI, ready for VS Code Marketplace + Open VSX.
- **VS Code coding-agent sample** (`vscode-l2m-coding-agent-flow.json`) promoted as a Featured template.

#### OSS growth foundations
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — concrete onboarding for new contributors with the layering map (which package owns what), quality gates, and recipes for adding nodes / samples / adapters.
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) — Contributor Covenant 2.1.
- [`SECURITY.md`](SECURITY.md) — private vulnerability reporting flow, response timeline, scope.
- [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/) — YAML-form bug and feature templates with required fields; blank issues disabled, questions steered to Discussions.
- [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md) — pre-merge checklist matching the CONTRIBUTING quality gates.

### Changed

- **Default chat-model provider for the Basic LLM Flow** is now `echo` instead of Ollama at `localhost:11434`. Existing instances with the old sample remain functional but no longer error silently when Ollama isn't running.
- **Top-nav Quickstart link** in the docs site now points at the 5-minute MCP-agent tutorial (was the env-vars-and-`pnpm-install` quickstart). The plain quickstart is still in the Getting Started sidebar.

### Security

- **Rate limiting + security headers** described above directly close gaps from the production-readiness audit.
- **Master-key rotation** is now a first-class operation via the `db:export` / `db:import` CLIs.

---

## Changelog discipline

Going forward, every PR with user-visible changes adds an entry under `## [Unreleased]` in the appropriate category (`Added` / `Changed` / `Deprecated` / `Removed` / `Fixed` / `Security`). The PR checklist enforces this for non-trivial changes.

When cutting a release:

1. Move the `[Unreleased]` content under a new heading: `## [vX.Y.Z] — YYYY-MM-DD`.
2. Reset `[Unreleased]` to an empty skeleton.
3. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z` — the [release-images workflow](.github/workflows/release-images.yml) builds and publishes container images, and a GitHub Release should be created with the changelog section as its body.

Versioning rule of thumb pre-1.0:
- **Patch** — backwards-compatible bug fixes only.
- **Minor** — new features, behavior tweaks that don't break workflow JSON or env vars. May include schema-additive migrations.
- **Major** — workflow JSON `schemaVersion` bump, env var renames, removed nodes, or any other change a self-hoster has to adapt to. Will not happen before `v1.0.0`.
