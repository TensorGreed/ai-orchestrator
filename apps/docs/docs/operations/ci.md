---
description: "The L2M GitHub Actions pipeline: install, lint, test and build gates on pull requests and main, and the local commands that match each CI step."
---

# CI Pipeline

This repository uses GitHub Actions to enforce build and test gates on pull requests and pushes to `main`.

## Workflow coverage

The CI workflow runs:

- Node.js 24 setup with `corepack` and pnpm from `packageManager`
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

## Release workflow

`.github/workflows/release-images.yml` runs on every `v*` tag. It builds the API and web images for `linux/amd64` and `linux/arm64`, each on a native runner (no emulation), merges them into one multi-arch image each, starts the API image on SQLite and on Postgres to check it works (`scripts/release/smoke-api.sh`: health, readiness, sign-in, a sample workflow run, the code-node sandbox, the guard and community nodes), writes a CycloneDX SBOM per platform image and one for the source tree, scans every platform image with Grype (SARIF to code scanning; a fixable CRITICAL finding stops the release), signs the digests with keyless cosign, attests SLSA build provenance and the SBOMs, verifies all of it, and only then tags the images and attaches the SBOMs to the GitHub Release. Pull requests that change the release files or dependencies run the same build, smoke test, SBOM, scan and gate against a registry on the runner, without publishing; a manual run on a branch is a staging dry run that publishes `0.0.0-ci-<sha>` images only. `.github/workflows/image-scan.yml` rescans the published images weekly. How to check a release: [Verify a release](./verify-a-release.md).

## CI notes

- E2E uses an isolated SQLite reset step (`pnpm e2e:prepare`) before server startup.
- The test server bootstraps a deterministic admin user for Playwright runs.
- CI intentionally fails fast on test/build regressions.
