# Changelog

All notable changes to L2M are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Pre-1.0 note**: until L2M reaches `v1.0.0`, minor version bumps may carry small behavior changes that aren't strictly additive. Breaking changes will always be called out under a "Changed" or "Removed" heading and (for workflow JSON) accompanied by a `schemaVersion` bump.

## [Unreleased]

The initial GA release covers production hardening, OSS-growth foundations, and the docs/evangelism flywheel.

### Added

#### MCP, agents, and the niche
- **5-minute MCP agent tutorial** — the conversion path for new visitors. Walks from clone → running agent without any LLM credentials. See [`apps/docs/docs/getting-started/build-your-first-mcp-agent.md`](apps/docs/docs/getting-started/build-your-first-mcp-agent.md).
- **Pattern library** — 10 documented topologies (zero-key MCP, webhook → agent → MCP, supervisor + worker swarm, workflow-as-MCP-tool, RAG, conditional, multi-turn artifacts, structured output, VS Code, Azure OpenAI), each with a runnable sample. See [`apps/docs/docs/patterns/index.md`](apps/docs/docs/patterns/index.md).
- **Sample projects companion repo** — [`l2m-samples`](https://github.com/TensorGreed/l2m-samples) ships three full reference implementations (internal helpdesk agent, MCP-powered support triage, VS Code repo-aware reviewer) with end-to-end READMEs and production deployment notes. Independent from the main repo's `samples/workflows/` (which is the seed catalog) so heavy use-case content doesn't bloat the primary install.

#### Phase 6 — Community node SDK
- **`@ai-orchestrator/community-sdk` package** — stable contract for `l2m-nodes-*` community packages. Default-export a `CommunityNodePackage` whose `register()` receives a `RegistrationApi` with `registerProvider` / `registerMCPAdapter` / `registerConnector`. Versioned via `apiVersion` (currently `1`).
- **Plugin loader** in `apps/api` scans a configured plugins directory, validates each package's `l2m` manifest, dynamic-imports the entry point, and calls `register()`. Off by default — set `COMMUNITY_NODES_ENABLED=true` to enable.
- **Admin install/uninstall** via Studio Settings → Community Nodes (admin-only) or `POST /api/community-nodes/install`. Backed by `npm install --ignore-scripts`. Supports a comma-separated `COMMUNITY_NODES_ALLOWLIST` of permitted package names.
- **Hot-extend semantics**: install registers new adapters into the live registries (no restart needed); uninstall removes files but adapters stay loaded until next restart. Documented.
- **Template scaffold repo** — [`l2m-nodes-template`](https://github.com/TensorGreed/l2m-nodes-template) ships a working starter package (sample connector, manifest, build/test setup, README walkthrough). Authors clone → rename → customize → `npm publish`.
- **Threat model + authoring guide** at [`/docs/extensions/community-nodes`](apps/docs/docs/extensions/community-nodes.md).

#### Reporting capabilities
- **Web Browse node** — drives a headless Chromium (via Playwright, the same dep `pdf_output` already uses) to fetch a URL, wait for JS, and return rendered HTML, page text, screenshot (PNG data URL), title, meta tags, link tags (favicon / canonical / etc.), `<a>` links, and `<img>` images. Supports `waitForSelector` for SPA hydration, `viewport` overrides, custom headers + UA, and per-call extraction toggles to keep the output lean. Protocol allowlist blocks `file://` (SSRF threat model). Sample at `samples/workflows/branding-extract-flow.json` chains web_browse → prompt_template → LLM → output_parser to extract structured brand data (logo URL, primary/accent colors, fonts, tagline) from any URL — directly addresses the "use the branding from thalesgroup.com" leg of the CipherTrust scenario.
- **Chart node** — server-side Vega-Lite rendering. Renders any Vega-Lite spec (bar / line / pie / scatter / heatmap / faceted small-multiples) to SVG without a browser, no native canvas, no Python deps. Pairs naturally with `pdf_output` (which already runs Chromium for HTML→PDF) for branded reports. Two ways to feed data: inline in the spec, or upstream + `dataPath`. Output exposes `svg`, `dataUrl`, and a ready-to-embed `imgTag`. Same JSON dialect as Altair / Streamlit / Observable / the Vega Editor — operators paste specs verbatim, LLMs produce specs directly. Sample at `samples/workflows/report-with-charts-flow.json` shows three charts (bar / arc / age-bucket) composing into one PDF report.

#### Phase 9 — RAG depth
- **Built-in persistent knowledge bases** (Phase 9.1) — RAG now works out of the box with no external vector DB. New `knowledge_bases` and `knowledge_base_chunks` tables back a SQLite-only `KnowledgeBaseVectorStoreAdapter` that plugs into the existing `rag_retrieve` node via `vectorStoreId: "knowledge-base"` + `vectorStoreConfig.knowledgeBaseId`. Append-only ingestion, locked vector dimensions, source-id grouping (delete by source), every retrieved document carries `knowledgeBaseId` / `chunkId` / `sourceId` / `similarityScore` provenance. Hand-rolled cosine search in JS — fine up to ~10k chunks per KB; pgvector / Qdrant / Azure AI Search are still available unchanged for larger corpora. New REST endpoints: `/api/knowledge-bases` (CRUD), `/api/knowledge-bases/:id/ingest` (server-side embedding via the KB's configured embedder, or pre-embedded chunks), `/api/knowledge-bases/:id/search` (standalone similarity), `/api/knowledge-bases/:id/sources/:sourceId` (DELETE by source). Migration v18.
- **Document ingestion pipeline + Studio UI** (Phase 9.2) — managing a KB no longer requires `curl`. New top-level **KB** sidebar entry opens a dedicated page: list, create (with embedder picker + JSON config), upload, browse chunks, delete sources, run a test similarity search. New `POST /api/knowledge-bases/:id/upload` chains load → chunk → embed → ingest in one round-trip; loaders cover Plain text, Markdown, HTML (regex-stripped to avoid a cheerio dep), CSV (with optional `textColumn`/`metadataColumns`), and JSON / NDJSON. Chunker is now a shared helper in `@ai-orchestrator/workflow-engine` so the upload endpoint and the existing `document_chunker` workflow node share one implementation. PDF + DOCX intentionally deferred — each needs a binary parser; will land as 9.2.x follow-ups.
- **Citation tracking through the agent chain** (Phase 9.4) — every chunk retrieved by `rag_retrieve` / `hybrid_search` / `rerank` already carries stable provenance from Phase 9.1; this phase turns it into clickable footnotes in the chat UI. New `extract_citations` node resolves `[N]` (or `[chunkId]`) markers in an LLM answer back to the upstream documents and emits structured citations with char offsets, source IDs, similarity / reranker scores, and retrieval mode. `rag_retrieve` and `rerank` now emit a `citationInstructions` string operators can drop into prompt templates so the model knows to cite. Chat bubble renders `[N]` markers as clickable `<sup>` links that scroll to a footnote panel below the bubble (source ID, retrieval mode, score, chunk preview). Backed by a tolerant marker scanner (numeric brackets win on collision; out-of-range markers ignored) and 13 unit + 2 integration tests. Sample at `samples/workflows/rag-with-citations-flow.json`. Also added `rerank` and `extract_citations` to the `WorkflowNodeType` zod schema enum so workflow upserts via REST accept them.
- **Hybrid search + reranker nodes** (Phase 9.3) — built-in KBs now index every chunk in a SQLite FTS5 virtual table at insert time (kept in sync via triggers, no rebuild needed). `rag_retrieve` accepts a new `searchMode: "vector" | "bm25" | "hybrid"` config. `hybrid` fuses BM25 + dense via Reciprocal Rank Fusion (canonical RRF, k=60 default) — catches both keyword-exact matches and semantic paraphrases in one call. New `rerank` node sits after retrieval and reorders candidates via a hosted cross-encoder; three providers wired today (Cohere Rerank v3 / Jina Reranker v2 / Voyage rerank-2). Result metadata propagates `retrieval.mode`, `rrfScore`, `rankers[]` for hybrid hits and `rerankerScore`, `reranker.providerId` after rerank. Migration v19 adds the FTS5 index. Sample at `samples/workflows/rag-hybrid-rerank-flow.json` showcases the canonical retrieve → rerank pipeline.
- **RAG-specific eval scorers** (Phase 9.5) — closes the quality loop on the Phase 7.3 eval framework. Four new `ScorerSpec` variants: `context_precision` and `context_recall` (programmatic, token-overlap with stopword filtering — free, deterministic), plus `faithfulness` and `answer_relevance` (LLM-judge, gated on `EVAL_JUDGE_ENABLED`). Every RAG scorer returns a numeric `score ∈ [0, 1]` (in addition to pass/fail) so dashboards can chart trends, not just counts. Judge plumbing uses the existing provider registry + secret resolution; per-scorer `providerId` / `model` / `threshold` overrides. Settings → Evals run launcher exposes the new scorer types as toggles with cost hints. JSON-tolerant judge response parser handles markdown fences, surrounding prose, and trailing commas so weaker models don't fail loudly on the format.

#### Phase 8 — Observability & FinOps
- **OpenTelemetry-grade observability** (Phase 8.1) — `OTEL_EXPORTER_OTLP_ENDPOINT` and friends ship traces (and optionally metrics) to any OTLP/HTTP collector. Resource attributes (`service.version`, `deployment.environment`, `host.name`, `service.instance.id`) flow into every span/metric. W3C `traceparent` is honored on incoming HTTP requests so traces stay continuous across nginx/ALB/Cloudflare → L2M → downstream LLM/MCP calls. Per-request OTel `SERVER` spans, span kinds (server/client/internal/producer/consumer), per-signal endpoint overrides, and `OTEL_EXPORTER_OTLP_HEADERS` for Honeycomb / Grafana Cloud auth. Legacy `TRACING_*` vars still work.
- **FinOps cost rollups + dashboard** (Phase 8.2) — every workflow execution now writes a `usage_events` row summed across all `_telemetry` blobs from llm_call / agent_orchestrator / supervisor_node nodes. List-price pricing for OpenAI, Anthropic, Gemini ships out of the box; operators with negotiated rates override via `LLM_PRICING_OVERRIDES_JSON`. New Settings → FinOps tab shows total spend / tokens / LLM-call count / avg latency / cached-token share over a selectable window (24h / 7d / 30d / 90d), a daily spend chart, and dimensional breakdown by workflow / user / provider+model / project. New API endpoints: `/api/usage/totals`, `/api/usage/rollup`, `/api/usage/recent`, `/api/usage/pricing` (all admin-only).
- **Budget caps + alerts** (Phase 8.3) — operators can now configure spend / token caps per scope (global, project, workflow, user) and period (day, week, month). `block`-action budgets pre-empt the manual `/api/workflows/:id/execute` endpoint with HTTP 402 when the current period's usage already meets the cap and add a `Retry-After` header pointing at the next period boundary; near-limit budgets surface in `x-budget-warning` response headers. `warn`-action budgets only fire post-execution alerts. Threshold crossings POST to a per-budget webhook URL (Slack/Discord/Teams compatible) and write debounced rows to `budget_alerts`. New Settings → FinOps → Budgets sub-section drives CRUD + recent alerts. Migration v16 adds `budgets` and `budget_alerts` tables.
- **Audit-log tamper-evidence + export pipeline** (Phase 8.4) — every `audit_logs` row now stores `prev_hash` and `entry_hash` (`SHA-256(prev_hash + canonical_payload)`); admins can verify the chain via `GET /api/audit-log/verify-chain` or the new "Verify chain integrity" button in Settings → Audit Log. New `audit_export_destinations` table drives bulk NDJSON export to HTTP sinks (Splunk HEC, Datadog Logs, Logstash) or local files (paired with Filebeat / Vector). Cursor-based incremental delivery via `last_export_id`; per-destination interval scheduler (`AUDIT_EXPORT_ENABLED=true`) plus an admin "Run now" endpoint. Each NDJSON record carries `entryHash` so downstream consumers can re-verify the chain. File-kind paths are sandboxed under `AUDIT_EXPORT_FILE_ROOT`. Migration v17 adds chain columns + export tables.

#### Phase 7 — Differentiation deepening
- **Inline cost & latency telemetry** (Phase 7.1) — `LLMCallResponse` carries `usage` (input/output/total/cached tokens) + `latencyMs` from every provider. The agent runtime accumulates across iterations. Studio canvas shows pills (`1.2k tok` · `840ms` · `×3`) on llm_call and agent_orchestrator nodes after a run, with a tooltip carrying the full breakdown.
- **Time-travel debugging** (Phase 7.2) — execution history detail rows expand to show per-node input/output JSON; each row gets a "▶ Replay from here" button that re-runs the workflow starting at that node, seeding upstream outputs from the source execution.
- **Agent eval framework** (Phase 7.3) — new Settings → Evals tab. Group fixtures (input + expected) into datasets; run any workflow against a dataset; bundled scorers (exact_match / contains / regex) grade each result. Per-run summary shows pass/fail/error counts, total tokens, and avg latency. SQLite-only at the moment; Postgres parity is a follow-up.
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
