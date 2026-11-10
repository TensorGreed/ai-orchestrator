# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the L2M web UI.
#
# - build stage installs deps + compiles the React/Vite SPA to static files.
# - runtime stage is nginx:1.31-alpine-slim serving the built dist/ over HTTP,
#   with the nginx.conf from this folder proxying /api, /webhook, /webhook-test,
#   and /health to the upstream `api` service (the docker-compose.yml service
#   name). The HEALTHCHECK uses BusyBox's built-in wget, so nothing is added
#   with apk.
#
# Build:   docker build -f apps/web/Dockerfile -t l2m-web .
# Run:     docker run -p 5173:80 l2m-web
#
# Dependencies install from the committed pnpm-lock.yaml (--frozen-lockfile),
# so an image gets exactly the versions the lockfile, CI and the source SBOM
# name; a lockfile out of step with a package.json fails the build.
#
# Base images are pinned by digest (the multi-arch index, so amd64 and arm64
# builds use the same release), keeping release builds reproducible;
# Dependabot (.github/dependabot.yml) proposes digest updates weekly.

FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS build
WORKDIR /app
RUN npm install --global corepack@0.36.0 \
    && corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

RUN pnpm install --frozen-lockfile

COPY apps/web apps/web
COPY packages/shared packages/shared

RUN pnpm --filter @ai-orchestrator/web build

# ---------- runtime stage ----------
FROM nginx:1.31-alpine-slim@sha256:f45171d36c76a8b2f5ef97108a3a8a2294248a6578a0a180edc2d78f7d2edc26 AS runtime
# zlib from the Alpine repository: the base image ships 1.3.2-r1, affected by
# CVE-2026-4738 (critical, fixed in 1.4-r0). Drop once the pinned base has it.
RUN apk upgrade --no-cache zlib
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --quiet --spider http://127.0.0.1/health || exit 1
