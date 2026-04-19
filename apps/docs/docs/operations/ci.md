# CI Pipeline

This repository uses GitHub Actions to enforce build and test gates on pull requests and pushes to `main`.

## Workflow coverage

The CI workflow runs:

- Node.js 20 setup with `corepack` and pnpm from `packageManager`
- Dependency install with `pnpm install --frozen-lockfile`
- Monorepo lint (`pnpm lint`)
- Monorepo tests (`pnpm test`)
- Monorepo build (`pnpm build`)
- Docs build (`pnpm docs:build`)
- Playwright browser install for web E2E (`chromium`)
- Web golden-journey E2E (`pnpm --filter @ai-orchestrator/web e2e`)

## Local command parity

Use the same commands locally before opening a PR:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm test
pnpm build
pnpm docs:build
pnpm --filter @ai-orchestrator/web e2e
```

## CI notes

- E2E uses an isolated SQLite reset step (`pnpm e2e:prepare`) before server startup.
- The test server bootstraps a deterministic admin user for Playwright runs.
- CI intentionally fails fast on test/build regressions.
