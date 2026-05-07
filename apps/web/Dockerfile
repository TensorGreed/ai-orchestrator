# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the L2M web UI.
#
# - build stage installs deps + compiles the React/Vite SPA to static files.
# - runtime stage is nginx:alpine serving the built dist/ over HTTP, with the
#   nginx.conf from this folder proxying /api, /webhook, /webhook-test, and
#   /health to the upstream `api` service (the docker-compose.yml service name).
#
# Build:   docker build -f apps/web/Dockerfile -t l2m-web .
# Run:     docker run -p 5173:80 l2m-web
#
# Note: pnpm-lock.yaml is gitignored in this repo, so the install uses
# --no-frozen-lockfile. Commit a lockfile and switch to --frozen-lockfile if
# you want fully reproducible image builds.

FROM node:20-alpine AS build
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

RUN pnpm install --no-frozen-lockfile

COPY apps/web apps/web
COPY packages/shared packages/shared

RUN pnpm --filter @ai-orchestrator/web build

# ---------- runtime stage ----------
FROM nginx:1.27-alpine AS runtime
RUN apk add --no-cache wget
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --quiet --spider http://127.0.0.1/health || exit 1
