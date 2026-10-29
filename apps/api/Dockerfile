# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the L2M API.
#
# - toolchain stage: node:24-alpine with the build tools better-sqlite3 needs
#   (it has no prebuilt binary for Node 24 on musl and compiles from source),
#   plus the workspace manifests and the lockfile.
# - deps stage installs every dependency, dev tools included, for the build.
# - build stage runs `pnpm --filter api build` (tsc --noEmit) so a TS error
#   fails the image build instead of crashing the container at startup, and
#   collects the api and workspace package sources (without node_modules).
# - prod-deps stage installs the production dependencies of the api and the
#   workspace packages it loads (`--prod --filter @ai-orchestrator/api...`), so
#   no test or build tool (vitest, vite, typescript, concurrently, ...) reaches
#   the image. tsx is a production dependency: the api runs its TS source
#   through it.
# - runtime stage is a slim node:24-alpine that runs as a non-root user,
#   includes a /health HEALTHCHECK, and carries the production node_modules and
#   the sources of the api and workspace packages (no apps/web, apps/docs or
#   apps/vscode-l2m-agent), at the same /app/apps/api path as before.
#
# Build:   docker build -f apps/api/Dockerfile -t l2m-api .
# Run:     docker run -p 4000:4000 -e SECRET_MASTER_KEY_BASE64=... l2m-api
#
# Dependencies install from the committed pnpm-lock.yaml (--frozen-lockfile),
# so an image gets exactly the versions the lockfile, CI and the source SBOM
# name; a lockfile out of step with a package.json fails the build. Every
# workspace package the api depends on (directly or through another package)
# needs its package.json copied into the toolchain stage.
#
# Base images are pinned by digest (the multi-arch index, so amd64 and arm64
# builds use the same release), keeping release builds reproducible;
# Dependabot (.github/dependabot.yml) proposes digest updates weekly.

FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS toolchain
WORKDIR /app
RUN corepack enable \
    && apk add --no-cache python3 make g++ libc6-compat
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
COPY packages/provider-sdk/package.json packages/provider-sdk/
COPY packages/mcp-sdk/package.json packages/mcp-sdk/
COPY packages/connector-sdk/package.json packages/connector-sdk/
COPY packages/agent-runtime/package.json packages/agent-runtime/
COPY packages/workflow-engine/package.json packages/workflow-engine/
COPY packages/guard-sdk/package.json packages/guard-sdk/
COPY packages/community-sdk/package.json packages/community-sdk/

FROM toolchain AS deps
RUN pnpm install --frozen-lockfile

# ---------- build stage ----------
FROM deps AS build
COPY apps/api apps/api
COPY packages packages
RUN pnpm --filter @ai-orchestrator/api build \
    && mkdir /sources \
    && tar -cf - --exclude=node_modules apps/api packages | tar -xf - -C /sources

# ---------- production dependencies ----------
FROM toolchain AS prod-deps
RUN pnpm install --prod --frozen-lockfile --filter "@ai-orchestrator/api..."

# ---------- runtime stage ----------
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache wget tini \
    && corepack enable \
    && addgroup -S nodeuser \
    && adduser -S nodeuser -G nodeuser

# Production node_modules (root virtual store plus each package's links), then
# the type-checked sources from the build stage on top.
COPY --from=prod-deps --chown=nodeuser:nodeuser /app ./
COPY --from=build --chown=nodeuser:nodeuser /sources ./

# SQLite database lives here when DB_TYPE=sqlite. Mount a volume in production
# to persist across container restarts (or set DB_TYPE=postgres).
RUN mkdir -p /app/apps/api/data && chown -R nodeuser:nodeuser /app/apps/api/data

USER nodeuser
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget --quiet --spider http://127.0.0.1:4000/health || exit 1

# tini reaps zombie processes from the spawned MCP stdio child processes.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["pnpm", "--filter", "@ai-orchestrator/api", "start"]
