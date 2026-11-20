---
title: "Quickstart: install and run L2M locally"
description: "Install and run L2M locally: prerequisites (Node.js 24+, pnpm 10+), environment setup, starting the API and web studio, the docs site, build and tests."
---

# Quickstart

## Prerequisites

- Node.js 24+
- pnpm 10+
- Optional: Ollama for local model execution

## Install

```bash
pnpm install
```

pnpm may warn that it ignored build scripts (for example `onnxruntime-node`, `esbuild`, `keytar`, `@vscode/vsce-sign`): that is safe to ignore. They belong to optional parts (the names service, the VS Code extension's packaging) and are not needed to run L2M.

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

## Sign in and run your first workflow

1. Open `http://localhost:5173`. Sign in with the admin account `.env` sets up on first start: **Email** is `BOOTSTRAP_ADMIN_EMAIL` and **Password** is `BOOTSTRAP_ADMIN_PASSWORD` (`admin@example.com` and `ChangeThisPassword123!` in `.env.example`; change them before anyone else can reach the studio). Click **Sign in**.
2. The **Welcome to L2M** window opens. Click **Run a starter**.
3. **Templates** opens on the **Starters**: small workflows that run on built-in sample data, with no model, key or server. On **CSV to JSON: parse, sort and total**, click **Use Template**. The new workflow opens in the editor.
4. Click **Run workflow** (the play button at the top right). The run takes a moment; the status next to the workflow name then reads **last run** with the number of nodes that ran, all **ok**.
5. Double-click a node, such as **Units per region**, to see what went in and what came out.

Closed the welcome window? **Home** lists the same **Starters** first: click **Use** on one. To build your own, click **Describe it…** on **Home** (it needs a model key, added under **Secrets**) or **New workflow**. See [Starter templates](./starter-templates.md).

## Run the released images

Each `v*` release also ships signed, multi-arch API and web images on GHCR with SBOMs and build provenance, also on Docker Hub as `lsquarem/l2m` and `lsquarem/l2m-web`. Check them and pin their digests before deploying: [Verify a release](../operations/verify-a-release.md).

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
