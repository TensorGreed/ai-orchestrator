# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the L2M API.
#
# - deps stage installs every workspace package's deps so the api can import
#   from packages/* at runtime (the api uses tsx to load TS source directly,
#   no separate compile step ships JS to disk).
# - build stage runs `pnpm --filter api build` (tsc --noEmit) so a TS error
#   fails the image build instead of crashing the container at startup.
# - runtime stage is a slim node:20-alpine that runs as a non-root user,
#   includes a /health HEALTHCHECK, and only carries the api app + the
#   workspace packages it actually depends on (drops apps/web, apps/docs,
#   apps/vscode-l2m-agent that aren't needed at runtime).
#
# Build:   docker build -f apps/api/Dockerfile -t l2m-api .
# Run:     docker run -p 4000:4000 -e SECRET_MASTER_KEY_BASE64=... l2m-api
#
# Dependencies install from the committed pnpm-lock.yaml (--frozen-lockfile),
# so an image gets exactly the versions the lockfile, CI and the source SBOM
# name; a lockfile out of step with a package.json fails the build. Every
# workspace package the api depends on (directly or through another package)
# needs its package.json copied into the deps stage.
#
# Base images are pinned by digest (the multi-arch index, so amd64 and arm64
# builds use the same release), keeping release builds reproducible;
# Dependabot (.github/dependabot.yml) proposes digest updates weekly.

FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS deps
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
RUN pnpm install --frozen-lockfile

# ---------- build stage ----------
FROM deps AS build
COPY apps/api apps/api
COPY packages packages
RUN pnpm --filter @ai-orchestrator/api build

# ---------- runtime stage ----------
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache wget tini \
    && corepack enable \
    && addgroup -S nodeuser \
    && adduser -S nodeuser -G nodeuser

# Carry over installed deps (incl. tsx, which the start script uses to load
# TS source directly) and only the workspace packages the api needs at runtime.
COPY --from=build --chown=nodeuser:nodeuser /app/node_modules ./node_modules
COPY --from=build --chown=nodeuser:nodeuser /app/package.json /app/pnpm-workspace.yaml /app/tsconfig.base.json ./
COPY --from=build --chown=nodeuser:nodeuser /app/apps/api ./apps/api
COPY --from=build --chown=nodeuser:nodeuser /app/packages ./packages

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
