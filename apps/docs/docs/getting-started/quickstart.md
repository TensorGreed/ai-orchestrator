---
description: "Install and run L2M locally: prerequisites (Node.js 20+, pnpm 10+), environment setup, starting the API and web studio, the docs site, and the build and test gates."
---

# Quickstart

## Prerequisites

- Node.js 20+
- pnpm 10+
- Optional: Ollama for local model execution

## Install

```bash
pnpm install
```

## Configure env

```bash
cp .env.example .env
```

Generate a 32-byte base64 key for secret encryption:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Set `SECRET_MASTER_KEY_BASE64` in `.env`.

## Run API + Web

```bash
pnpm dev
```

- API: `http://localhost:4000`
- Web UI: `http://localhost:5173`

## Run the released images

Each `v*` release also ships signed, multi-arch API and web images on GHCR with SBOMs and build provenance. Check them and pin their digests before deploying: [Verify a release](../operations/verify-a-release.md).

## Run docs site

```bash
pnpm docs:dev
```

- Docs UI: `http://localhost:4173`

## Build/test quality gates

```bash
pnpm -r --if-present build
pnpm -r --if-present test
```
