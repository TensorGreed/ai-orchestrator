# syntax=docker/dockerfile:1.7
#
# l2m-ner: the optional names and addresses service (POST /v1/entities, GET /health). Built from the repo root:
#
#   docker build -f apps/ner/Dockerfile -t l2m-ner .
#
# The image carries NO model weights. Models are pulled from their publisher into the /models volume with
# `docker run --rm -v l2m-ner-models:/models l2m-ner models pull --accept-licence` (or `l2m models pull`), checked
# against the SHA-256 in models.json, and loaded by the service. Until a model is there, /health reports
# `ready: false` and the service keeps looking.
#
# - Debian slim (glibc): the native ONNX Runtime binary for Node needs glibc and does not load on musl.
# - onnxruntime-node ships prebuilt CPU binaries for every platform in its npm package; the install script (which
#   only fetches GPU libraries) does not run (pnpm onlyBuiltDependencies), and every binary except this image's
#   own platform is deleted. ONNX Runtime's licence and third-party notices are in /usr/share/doc/l2m-ner.
# - ONNX Runtime's usage telemetry is switched off (ORT_DISABLE_TELEMETRY=1, also set by the service itself). At run
#   time the service makes no outbound connection; only `models pull` downloads, from the URLs in models.json.
# - The base image is pinned by digest (multi-arch index); Dependabot proposes updates.
# - Runs as the image's unprivileged `node` user; the code and node_modules are read-only to it.

FROM node:26-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS toolchain
WORKDIR /app
RUN npm install --global corepack@0.36.0 && corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/ner/package.json apps/ner/
# The entity endpoint contract's types live in packages/shared; the build type-checks against that one file (type
# imports only, so nothing of the shared package is in the image).
COPY packages/shared/package.json packages/shared/

# ---------- build: type-check and compile to dist/ ----------
FROM toolchain AS build
RUN pnpm install --frozen-lockfile --filter "@ai-orchestrator/ner..." --filter "ai-orchestrator"
COPY packages/shared/src/guard-entity-endpoint.ts packages/shared/src/
COPY apps/ner apps/ner
RUN pnpm --filter @ai-orchestrator/ner compile

# ---------- production dependencies, this platform's ONNX Runtime binary only ----------
FROM toolchain AS prod-deps
ARG TARGETARCH
RUN pnpm install --prod --frozen-lockfile --filter "@ai-orchestrator/ner" \
    && case "$TARGETARCH" in amd64) keep=x64 ;; arm64) keep=arm64 ;; *) echo "unsupported TARGETARCH=$TARGETARCH" >&2; exit 1 ;; esac \
    && for bin in node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/bin/napi-v*; do \
         find "$bin" -mindepth 1 -maxdepth 1 ! -name linux -exec rm -rf {} + ; \
         find "$bin/linux" -mindepth 1 -maxdepth 1 ! -name "$keep" -exec rm -rf {} + ; \
         test -f "$bin/linux/$keep/onnxruntime_binding.node" ; \
       done \
    && rm -rf /root/.local/share/pnpm /root/.cache

# ---------- runtime ----------
FROM node:26-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS runtime
ENV NODE_ENV=production \
    ORT_DISABLE_TELEMETRY=1 \
    NER_HOST=0.0.0.0 \
    NER_PORT=8000 \
    NER_MODEL_DIR=/models
COPY --from=prod-deps /app /app
COPY --from=build /app/apps/ner/dist /app/apps/ner/dist
COPY apps/ner/models.json apps/ner/openapi.json /app/apps/ner/
COPY LICENSE /usr/share/doc/l2m-ner/LICENSE
COPY apps/ner/third-party /usr/share/doc/l2m-ner/third-party
RUN mkdir -p /models && chown node:node /models
WORKDIR /app/apps/ner
USER node
VOLUME ["/models"]
EXPOSE 8000

# Healthy while the service runs, with or without a model (/health says `ready` separately).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.NER_PORT || 8000) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

ENTRYPOINT ["node", "dist/main.js"]
CMD ["serve"]
