# Contributing to L2M

Thanks for considering a contribution. L2M is **pure OSS** (MIT) and the project's growth depends on community contributions — connectors, MCP adapters, docs, bug reports, real-world patterns. This page is the practical "how" for adding to it.

## What we're building

L2M is **the MCP-native agent runtime**: visual workflow builder, multi-agent Swarm, and a first-party VS Code surface. The differentiators we deepen on every PR are first-class [MCP](https://modelcontextprotocol.io/) integration, multi-agent topologies, and IDE composability.

We're explicitly **not** chasing n8n connector parity for its own sake — community-authored nodes (see [Phase 6 of the GA roadmap](.github/ROADMAP_BOARD.md)) are the answer to the long tail. If your contribution targets a generic SaaS connector, please open a Discussion first to align on whether it belongs in-tree or as a `l2m-nodes-*` package.

## Where to start

- **Bug?** Open a [bug report](https://github.com/TensorGreed/ai-orchestrator/issues/new?template=bug_report.yml). Include reproduction steps, what you expected, what you got, and the L2M version (`git rev-parse --short HEAD` if you're on `main`).
- **Question or design discussion?** Use [GitHub Discussions](https://github.com/TensorGreed/ai-orchestrator/discussions). Don't open an issue for "how do I…" questions.
- **First contribution?** Look for issues labeled [`good first issue`](https://github.com/TensorGreed/ai-orchestrator/labels/good%20first%20issue) — these are scoped, well-described, and don't require deep familiarity with the runtime.
- **Want to ship something larger?** Open a Discussion first describing the change. Saves both of us from a 600-line PR that doesn't land.

## Setting up

Prerequisites: **Node 20+**, **pnpm 10+**.

```bash
git clone https://github.com/TensorGreed/ai-orchestrator.git
cd ai-orchestrator
pnpm install
cp .env.example .env  # edit SECRET_MASTER_KEY_BASE64 — see docs site
pnpm dev               # API + Web + Docs concurrently
```

The [5-minute MCP agent tutorial](https://lsquarem.com/docs/getting-started/build-your-first-mcp-agent) is the canonical onboarding path — verify it works on your machine before changing anything.

## Layering and where things go

Read the **Repo orientation** + **Architecture** sections of [CLAUDE.md](./CLAUDE.md) — that's the canonical map. The short version:

| You're adding... | Land it in... |
|---|---|
| A new LLM provider | `packages/provider-sdk/src/providers/` + register in `createDefaultProviderRegistry()` |
| A new MCP transport / adapter | `packages/mcp-sdk/src/adapters/` + register in `createDefaultMCPRegistry()` |
| A new connector (HTTP/SQL/SaaS) | `packages/connector-sdk/src/` + register in `createDefault<X>Registry()` |
| A new node type | Schema in `packages/shared/src/definitions.ts`, executor handler in `packages/workflow-engine/src/connectors/` (Tier-1 dispatch table or `phase2-dispatch.ts`), UI in `apps/web/src/components/NodeConfigModal.tsx` |
| API route changes | `apps/api/src/app.ts`, with paired tests in `apps/api/src/*.test.ts` |
| Workflow JSON contract changes | `packages/shared/src/schemas.ts` — bump `schemaVersion` if breaking |
| DB schema changes | New `Migration` entry in `apps/api/src/db/migrations.ts` (with paired `up`/`down`) **and** the embedded SQLite schema in `apps/api/src/db/database.ts` |

**Don't bypass the registries.** Wiring an adapter directly inside `apps/api` instead of through the matching SDK package's `createDefault<X>Registry()` is the fastest way to get a PR sent back.

## Quality gates

Every PR must pass:

```bash
pnpm lint            # recursive
pnpm build           # recursive type-check
pnpm test            # recursive vitest
```

CI runs the same. Tests live next to source as `*.test.ts`. Logic changes require a corresponding test — `pnpm --filter <pkg> test` to scope.

For the workflow engine specifically, schema/dispatch changes must round-trip through the executor:
```bash
pnpm --filter @ai-orchestrator/workflow-engine test
```

For the API, integration tests cover RBAC, executor flows, webhook signatures, leader election, request-ID propagation, and master-key rotation. Add cases that fail before your change and pass after.

## Coding conventions

- **TypeScript-first.** ESM modules, NodeNext resolution. The trailing `.js` on relative imports in `.ts` source is intentional — don't strip them.
- **No "TODO" comments in merged code.** Open a follow-up issue if the work is genuinely deferrable.
- **Don't write comments that restate what the code does.** Comments are for non-obvious **why** — a hidden constraint, a historical workaround, a subtle invariant.
- **No emojis in code or commit messages** unless explicitly requested.
- **Secrets:** never bypass `SecretService`. Never echo raw values from API responses. New env vars go in `.env.example` AND `apps/api/src/config.ts` (zod-validated).
- **Errors:** use `WorkflowError` with a `category` and a `remediation` so users see actionable messages instead of stack traces.
- **DAG edges vs attachment ports:** in agent runtime work, preserve the distinction. `chat_model`, `memory`, `tool`, `worker` are attachment ports consumed by the agent runtime, not DAG steps.

## Commit + PR style

- **Commits**: imperative mood, focused, one logical change per commit. Bug fixes don't need surrounding cleanup; refactors don't need feature additions. Keep diffs reviewable.
- **Commit messages**: title under 72 chars, body explains the *why* not the *what*. Reference issues with `Fixes #NN` when applicable.
- **PR title**: same shape as a commit title. PR description: what changed, why, how it was tested. Link to the Discussion if there was one.
- **Squash on merge** is the default. If your PR is a series of meaningful intermediate commits (e.g. a refactor that lands cleanly in steps), say so — we'll rebase-merge instead.
- **Update [CHANGELOG.md](./CHANGELOG.md)** for any user-visible change. Add a one-line entry under `## [Unreleased]` in the appropriate category (`Added` / `Changed` / `Fixed` / etc.). Skip this only for pure-internal refactors, doc-only edits, and CI tweaks.

## Adding a sample workflow

Drop the JSON into [samples/workflows/](./samples/workflows/) and register it in [apps/api/src/services/seed-service.ts](./apps/api/src/services/seed-service.ts) (`TEMPLATE_CATEGORY_MAP` + `TEMPLATE_DESCRIPTION_MAP`). The drift-checking docs build will fail CI if your sample uses a node type that doesn't exist in `definitions.ts`. Aim for **zero-key** samples (echo provider + mock-mcp adapter) where possible — they make the project welcoming.

## Adding a new node type

1. Schema entry in `packages/shared/src/definitions.ts` (you must include `description`, `configSchema`, and `sampleConfig` — the docs auto-generator reads them).
2. Executor handler in `packages/workflow-engine/src/connectors/tier1-dispatch.ts` or `phase2-dispatch.ts`.
3. UI handling in `apps/web/src/components/NodeConfigModal.tsx`.
4. **Run `pnpm --filter @ai-orchestrator/docs gen:nodes`** to regenerate the per-node reference. The shared package's drift test will fail CI otherwise.
5. Add a test that runs the new node end-to-end through the executor.

## Reporting security issues

**Do not open a public issue for vulnerabilities.** Use [GitHub's private vulnerability reporting](https://github.com/TensorGreed/ai-orchestrator/security/advisories/new) — see [SECURITY.md](./SECURITY.md) for the full policy.

## License

By contributing, you agree your contributions will be licensed under the [MIT License](./LICENSE) — the same license as the rest of the project. We don't require a separate CLA.

## Code of Conduct

Participation in this project is governed by the [Code of Conduct](./CODE_OF_CONDUCT.md). In short: be respectful, focus on the work, and assume good intent.
