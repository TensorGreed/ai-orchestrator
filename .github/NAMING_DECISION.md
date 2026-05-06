# Product Name: L2M

**Decision date:** 2026-05-06
**Status:** decided. Surface text (README, docs site hero, Why page, CLAUDE.md, VitePress config) updated. Repo, package names, env-var prefix, Helm chart, Docker tags, and VS Code extension publisher are still on the legacy `ai-orchestrator` identifiers — those are out of scope for the surface-text change and will land as a single focused rename PR later.

## The name

**L2M** (written as **L²M**, pronounced "LsquareM") is the product name. The VS Code extension package already uses the name (`apps/vscode-l2m-agent`), and the legacy static site at `docs/integrations.html` already brands the footer as `L²M`.

## Out of scope for the surface-text update

The following identifiers were intentionally left unchanged. Touching them is a separate, atomic rename PR — never half-rename:

- Every `package.json` `name` and `dependencies` reference (the `@ai-orchestrator/*` scope)
- `pnpm-workspace.yaml` (no changes needed — globs are by directory)
- `.env.example` and [apps/api/src/config.ts](../apps/api/src/config.ts) env prefix
- Helm chart name in [ops/helm/ai-orchestrator/](../ops/helm/ai-orchestrator/)
- Docker image tags in [docker-compose.yml](../docker-compose.yml), [docker-compose.prod.yml](../docker-compose.prod.yml), and [.github/workflows/ci.yml](workflows/ci.yml)
- VS Code extension publisher + identifier in [apps/vscode-l2m-agent/package.json](../apps/vscode-l2m-agent/package.json)
- The GitHub repo name itself (`TensorGreed/ai-orchestrator`)

When the rename PR happens, all of the above must move together in one commit.
