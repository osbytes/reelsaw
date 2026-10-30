# Base images are pinned by digest (multi-arch index digests; Dependabot bumps the digests, never the
# major: Node stays on the LTS line chosen here, bumped by hand with a release note).
# Multi-arch builds: only the `system` and `runtime` stages run per target architecture (under
# emulation in CI). Everything architecture-independent (model files, the JS build and production
# node_modules; the one native dependency, onnxruntime-node, ships binaries for every platform)
# runs once on the build machine's own architecture ($BUILDPLATFORM).

# ---------- models: downloaded once, natively ----------
FROM --platform=$BUILDPLATFORM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc AS models
RUN apk add --no-cache curl
COPY scripts/download-models.sh /tmp/download-models.sh
RUN sh /tmp/download-models.sh /models

# ---------- system: OS packages and media tools (shared by dev and runtime) ----------
FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS system
# yt-dlp is pinned and verified. To bump: take the tag from https://github.com/yt-dlp/yt-dlp/releases,
# then the linux `yt-dlp` line of that release's SHA2-256SUMS file, and update both args (and THIRD_PARTY.md).
# The `yt-dlp` file is a Python zipapp, the same for amd64 and arm64.
ARG YTDLP_VERSION=2026.08.19
ARG YTDLP_SHA256=1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6
ENV DATA_DIR=/data \
    FACE_MODEL_PATH=/app/server/models/ultraface-rfb-320.onnx \
    TEXT_MODEL_PATH=/app/server/models/ppocrv4-det.onnx \
    VAD_MODEL_PATH=/app/server/models/silero-vad.onnx \
    ALIGN_MODEL_DIR=/app/server/models/wav2vec2-base-960h \
    NVIDIA_DRIVER_CAPABILITIES=compute,video,utility \
    PORT=3000
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core fonts-liberation2 fonts-roboto fonts-open-sans fonts-lato fonts-inter fonts-bebas-neue ca-certificates curl python3 \
 && curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp" -o /usr/local/bin/yt-dlp \
 && echo "${YTDLP_SHA256}  /usr/local/bin/yt-dlp" | sha256sum -c - \
 && chmod +x /usr/local/bin/yt-dlp \
 && rm -rf /var/lib/apt/lists/*
COPY --from=models /models /app/server/models

# ---------- build: once, natively ----------
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate
WORKDIR /app
# pnpm fetch reads only the lockfile, so a version bump in a package.json (every Release PR) keeps
# the download layer cached; the install after it links from the store without the network
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY package.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --offline
COPY . .
# Release builds (release.yml) pass a Sentry token as a build secret: the bundles get debug ids and their source maps
# go to Sentry, so production stacks read as source. Without the secret (local, CI, self-built) this is skipped.
# Either way no map reaches the image: the web maps are deleted here, the server's with the rest below.
ARG REELSAW_VERSION=dev
ARG SENTRY_ORG
ARG SENTRY_PROJECT
RUN --mount=type=secret,id=sentry_auth_token,required=false \
    pnpm -r build \
 && pnpm --filter @reelsaw/server bundle \
 && if [ -s /run/secrets/sentry_auth_token ] && [ -n "$SENTRY_ORG" ] && [ -n "$SENTRY_PROJECT" ]; then \
      export SENTRY_AUTH_TOKEN="$(cat /run/secrets/sentry_auth_token)" \
      && npx --yes @sentry/cli@2.39.1 sourcemaps inject apps/server/dist-bundle apps/web/dist \
      && npx --yes @sentry/cli@2.39.1 sourcemaps upload --org "$SENTRY_ORG" --project "$SENTRY_PROJECT" --release "reelsaw@${REELSAW_VERSION}" apps/server/dist-bundle apps/web/dist; \
    fi \
 && find apps/web/dist -name "*.map" -delete \
 && pnpm --filter @reelsaw/server --prod deploy --legacy /out/server \
 # ship the minified bundle only: no tsc output, sources, maps, or the inlined workspace package
 && rm -rf /out/server/dist /out/server/dist-bundle /out/server/src /out/server/test /out/server/scripts /out/server/tsconfig*.json /out/server/node_modules/@reelsaw \
 && cp -r apps/server/dist-bundle /out/server/dist \
 && find /out/server -path /out/server/node_modules -prune -o \( -name "*.ts" -o -name "*.map" \) -print | xargs -r rm -f

# ---------- server for one target architecture: drop the other platforms' native binaries ----------
# A separate stage (not a RUN in `runtime`): deleting files in a later layer wouldn't shrink the image.
FROM --platform=$BUILDPLATFORM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc AS server
ARG TARGETARCH
COPY --from=build /out/server /out/server
RUN set -eu; \
    case "$TARGETARCH" in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) echo "unsupported arch $TARGETARCH"; exit 1 ;; esac; \
    bins=$(find /out/server/node_modules/.pnpm -path "*/onnxruntime-node/bin/napi-v*" -maxdepth 6 -type d -name "napi-v*"); \
    [ -n "$bins" ] || { echo "onnxruntime-node binaries not found: layout changed?"; exit 1; }; \
    for b in $bins; do \
      find "$b" -mindepth 1 -maxdepth 1 -type d ! -name linux -exec rm -rf {} +; \
      find "$b/linux" -mindepth 1 -maxdepth 1 -type d ! -name "$arch" -exec rm -rf {} +; \
      ls "$b/linux/$arch"/*.node >/dev/null || { echo "no onnxruntime binary for linux/$arch in $b"; exit 1; }; \
    done; \
    # better-auth declares drizzle-kit as an optional peer and pnpm links the server's dev copy into the
    # production tree; nothing imports it at runtime, and it drags in tsx and esbuild (Go binaries the
    # image scanner flags). The dangling peer symlink left behind is never resolved.
    cd /out/server/node_modules/.pnpm; \
    rm -rf drizzle-kit@* tsx@* esbuild@* @esbuild+* @esbuild-kit+* node_modules/.bin/esbuild node_modules/.bin/tsx node_modules/.bin/drizzle-kit; \
    ! ls -d *esbuild* 2>/dev/null || { echo "esbuild still in the production tree"; exit 1; }

# ---------- dev: source mounted, live reload (docker-compose.dev.yml) ----------
FROM system AS dev
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate
WORKDIR /app
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node apps/server/package.json apps/server/
COPY --chown=node:node apps/web/package.json apps/web/
COPY --chown=node:node packages/shared/package.json packages/shared/
RUN chown node:node /app && mkdir -p /data && chown node:node /data /app/server /app/server/models
USER node
RUN pnpm install --frozen-lockfile
COPY --chown=node:node . .
RUN pnpm --filter @reelsaw/shared build
USER root
RUN printf '#!/bin/sh\ncd /app/apps/server && exec node --import tsx src/cli.ts "$@"\n' > /usr/local/bin/reelsaw && chmod +x /usr/local/bin/reelsaw
USER node
ENV NODE_ENV=development
EXPOSE 3000 5173
CMD ["sh", "-c", "pnpm --filter @reelsaw/shared dev & pnpm --filter @reelsaw/web exec vite --host 0.0.0.0 & cd apps/server && exec pnpm exec tsx watch --clear-screen=false src/main.ts"]

# ---------- runtime ----------
FROM system AS runtime
ARG REELSAW_VERSION=dev
ARG REELSAW_COMMIT=unknown
ARG REELSAW_BUILT_AT=unknown
ENV NODE_ENV=production \
    WEB_DIST=/app/web \
    REELSAW_VERSION=${REELSAW_VERSION} \
    REELSAW_COMMIT=${REELSAW_COMMIT} \
    REELSAW_BUILT_AT=${REELSAW_BUILT_AT}
LABEL org.opencontainers.image.title="Reelsaw" \
      org.opencontainers.image.version="${REELSAW_VERSION}" \
      org.opencontainers.image.revision="${REELSAW_COMMIT}" \
      org.opencontainers.image.source="https://github.com/osbytes/reelsaw" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      io.modelcontextprotocol.server.name="io.github.osbytes/reelsaw"
WORKDIR /app
# --chown on the copy (not a recursive chown afterwards) so the app layer is not stored twice
COPY --from=server --chown=node:node /out/server /app/server
COPY --from=build --chown=node:node /app/apps/server/drizzle /app/server/drizzle
# the watermark logo (WATERMARK_LOGO_PATH)
COPY --from=build --chown=node:node /app/apps/server/assets /app/server/assets
COPY --from=build --chown=node:node /app/apps/web/dist /app/web
COPY --chown=node:node THIRD_PARTY.md /app/THIRD_PARTY.md
# operator CLI: docker compose exec app reelsaw status <projectId> (drops to node when invoked as root)
# setpriv (util-linux, in the base image) drops privileges; the app never runs npm, npx, corepack or yarn,
# so the copies bundled with the Node image go (their own dependencies carry scanner findings).
RUN printf '%s\n' '#!/bin/sh' 'if [ "$(id -u)" = "0" ]; then exec setpriv --reuid=node --regid=node --init-groups node /app/server/dist/cli.js "$@"; fi' 'exec node /app/server/dist/cli.js "$@"' > /usr/local/bin/reelsaw \
 && chmod +x /usr/local/bin/reelsaw \
 && mkdir -p /data && chown node:node /data /app \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
 && setpriv --reuid=node --regid=node --init-groups true
# Root entrypoint chowns volume-mounted DATA_DIR (Railway etc.), then drops to node. Process still runs as node.
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
USER root
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD setpriv --reuid=node --regid=node --init-groups node -e "fetch('http://localhost:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "/app/server/dist/main.js"]
