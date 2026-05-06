# Why L2M?

Most AI workflow tools were designed before the Model Context Protocol existed and before "multi-agent" meant anything more than chained prompts. L2M was built around both, and ships with the production basics that closed-source agent platforms charge for.

This page is the long answer to "what makes this different from other visual workflow tools?"

## 1. MCP-first, not bolted on

The [Model Context Protocol](https://modelcontextprotocol.io) is how an agent discovers and calls tools defined by an external server. L2M treats it as a primary node type, not an integration.

What you get:

- **Adapter registry.** Wire any MCP server in via the `MCP Tool` node. The `http_mcp` adapter speaks the streamable-HTTP transport; `mock-mcp` ships demo tools (`get_current_time`, `calculator`, `lookup_kb`) so you can build a flow before pointing at a real server. New transports plug into [`packages/mcp-sdk/src/`](https://github.com/TensorGreed/ai-orchestrator/tree/main/packages/mcp-sdk/src).
- **Schema compaction & tool shortlisting.** When a server exposes many tools, the runtime compacts schemas before sending them to the model and shortlists tools by prompt relevance. This avoids context blowups and the "wrong tool picked from 30 similarly-named endpoints" problem.
- **Session tool cache.** Full tool outputs are cached outside the LLM prompt window in `session_tool_cache`. The model sees compact summaries and can fetch the full payload via auto-injected `session_cache_list` / `session_cache_get` tools when it needs detail. Multi-turn conversations stay grounded without re-calling expensive endpoints.
- **Workflow → MCP-tool exposure.** The `mcp_server_trigger` node exposes any workflow as an MCP tool at `POST /api/mcp-server/:path/invoke` with a manifest at `GET /api/mcp-server/:path/manifest`. Other agents — including other L2M instances — can then call your workflow as a tool. This is an agent-composability story most visual workflow tools don't have.
- **Security on the boundary.** Secrets used by MCP adapters go through the same AES-256-GCM `SecretService` as everything else; never echoed in API responses.

What this looks like in practice that competing tools generally don't:

- A first-class MCP Client node with schema compaction and prompt-aware tool shortlisting (rather than a basic pass-through tool wrapper, or none at all).
- The ability to expose a workflow back out as an MCP tool other agents invoke.
- A session-scoped tool output cache that keeps multi-turn agents grounded without re-calling expensive endpoints.

## 2. Multi-agent Swarm

Most "multi-agent" support in workflow tools is just chained prompts. L2M implements a real Supervisor → Worker model via dedicated attachment ports on Agent Orchestrator and Supervisor nodes:

- `chat_model` (required) — the LLM provider node attached to the agent.
- `memory` — a `Simple Memory` node that persists conversation turns in the configured database by `namespace + session_id`.
- `tool` (0..N) — `MCP Tool` nodes whose discovered tools become available to the agent loop.
- `worker` (0..N, Supervisor only) — other Agent Orchestrator or Supervisor nodes, recursively.

Connected workers are dynamically exposed to the parent Supervisor as **synthetic tool calls**. The Supervisor decides when to delegate, the Worker runs its own loop with its own tools, and results flow back as tool messages. You can nest Supervisors inside Workers.

Attachment edges are *not* walked as DAG steps — they're consumed by the agent runtime at execution time and shown as `skipped` in traces. This keeps your visual graph readable while supporting arbitrary agent hierarchies.

## 3. VS Code agent surface

The repository ships a first-party VS Code extension at [`apps/vscode-l2m-agent`](https://github.com/TensorGreed/ai-orchestrator/tree/main/apps/vscode-l2m-agent) that turns any workflow into a coding agent inside the editor:

- **Sidebar chat** with workspace-scoped session IDs and persistent history across reloads.
- **Streaming responses** via `POST /api/webhooks/execute/stream` (SSE) — the agent's progress, LLM deltas, and per-node activity are visible inline.
- **Bounded context bundling.** The extension collects active file, selection, open tabs, diagnostics, git state, and pinned files, then truncates predictably to a configured budget. Older turns are compacted locally before being sent.
- **Patch previews** with strict workspace-path validation — generated patches cannot write outside the workspace, and apply only after explicit user approval.
- **Command approval.** Commands suggested by the agent run in a VS Code terminal, only after the user clicks Run.
- **Bring your own backend topology.** Unlike Cursor or Continue, the agent's reasoning lives in a workflow you own and can edit visually. Swap the model, tools, memory, and routing without changing the extension.

A bundled `vscode-l2m-coding-agent-flow` template gives you a working agent in one click from the Template Gallery.

## 4. Webhook security that actually validates

Webhook nodes ship with HMAC-SHA256 signing, replay protection (timestamp tolerance window, default 5 min), and an idempotency layer (cached results for repeated `Idempotency-Key` headers). On top of that, the integration-specific webhook routes do the right validation per provider:

- **Stripe** — HMAC-SHA256 against the configured signing secret.
- **Discord** — Ed25519 signature verification (handles PING `interaction.type=1` echo).
- **Telegram** — `X-Telegram-Bot-Api-Secret-Token` match.
- **GitHub** — `X-Hub-Signature-256` HMAC.
- **Slack** — Slack signing-secret HMAC.

This is harder to get right than it looks. Most workflow tools' webhook auth stops at a shared bearer token.

## 5. Production basics, not paid add-ons

The features that closed-source agent platforms put behind enterprise SKUs are open here:

- **SSO** — SAML 2.0 (Okta, Azure AD, OneLogin) and LDAP / Active Directory, both as optional dependencies.
- **MFA / TOTP** — RFC 6238, AES-256-GCM-encrypted secret at rest, single-use SHA-256-hashed backup codes, optional `MFA_ENFORCE`.
- **API keys** — `Authorization: Bearer ao_<prefix>.<secret>` works on any `/api/*` route alongside session cookies.
- **External secret managers** — HashiCorp Vault (KV v1/v2), AWS Secrets Manager, Google Secret Manager, Azure Key Vault, with TTL-based rotation cache.
- **RBAC** — global roles (admin/builder/operator/viewer) plus per-project roles (project_admin/editor/viewer) plus custom roles with a granular permission vocabulary.
- **Audit log** — auth, MFA, SSO, API keys, secrets, workflow CRUD, execution outcomes, sharing changes, and more — with category/event-type/outcome filters and CSV export.
- **Observability** — Prometheus `/metrics` endpoint with histograms, OTEL-compatible spans (in-memory or OTLP/HTTP export), SLO tracking with budgets surfaced as gauges.
- **HA** — multi-main leader election via a `leader_leases` table; only the leader runs the scheduler and trigger services. Webhook-process separation via `WORKER_MODE=webhook`.
- **Source control** — Git push/pull workflows with credential stubbing, plus per-workflow versioning with restore.

## 6. Honest about what's still rough

For transparency:

- The first-run experience needs work — see Phase 2 of the GA plan.
- Rate limiting and security headers are not yet wired on public webhook routes — see Phase 4.
- A community node SDK (so connectors can ship as installable npm packages) is on the roadmap as Phase 6 — currently every new connector is a PR to this repo.
- Broad pre-built SaaS connector catalogue is intentionally not the goal; the community SDK is the bet for closing that gap.

The active GA plan and per-phase status live on the [public project board](https://github.com/orgs/TensorGreed/projects/1).

## Who this is for

You'll get the most out of L2M if you:

- Want to compose **agents that call tools via MCP**, not just chained prompts.
- Want to **self-host** an agent platform with real auth, audit, and observability.
- Want a **developer surface** (VS Code) on top of a visual builder, not just one or the other.
- Are comfortable with a TypeScript monorepo and willing to extend SDK packages for new adapters.

You'll be happier with another tool if you:

- Need a catalogue of 400+ pre-built SaaS connectors today.
- Want a fully-managed cloud SaaS with no self-hosting (this project is OSS-only; community-run hosted instances may emerge).
- Are looking for purely no-code agent design with no MCP awareness.
