FROM node:20-alpine AS base
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/provider-sdk/package.json packages/provider-sdk/package.json
COPY packages/mcp-sdk/package.json packages/mcp-sdk/package.json
COPY packages/connector-sdk/package.json packages/connector-sdk/package.json
COPY packages/agent-runtime/package.json packages/agent-runtime/package.json
COPY packages/workflow-engine/package.json packages/workflow-engine/package.json

RUN pnpm install --frozen-lockfile

COPY . .

EXPOSE 4000
CMD ["pnpm", "--filter", "@ai-orchestrator/api", "start"]
