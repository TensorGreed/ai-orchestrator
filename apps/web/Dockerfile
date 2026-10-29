# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the L2M web UI.
#
# - build stage installs deps + compiles the React/Vite SPA to static files.
# - runtime stage is nginx:1.30-alpine-slim serving the built dist/ over HTTP,
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

FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS build
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

RUN pnpm install --frozen-lockfile

COPY apps/web apps/web
COPY packages/shared packages/shared

RUN pnpm --filter @ai-orchestrator/web build

# ---------- runtime stage ----------
FROM nginx:1.30-alpine-slim@sha256:dede8895648b461178c3bc604f7eed4423efe5220b2c4d839f5eb3d34ac3f8f7 AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --quiet --spider http://127.0.0.1/health || exit 1
