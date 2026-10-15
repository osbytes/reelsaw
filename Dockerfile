# ---------- system: OS packages, media tools, models (shared by dev and runtime) ----------
FROM node:22-bookworm-slim AS system
ENV DATA_DIR=/data \
    FACE_MODEL_PATH=/app/server/models/ultraface-rfb-320.onnx \
    TEXT_MODEL_PATH=/app/server/models/ppocrv4-det.onnx \
    VAD_MODEL_PATH=/app/server/models/silero-vad.onnx \
    ALIGN_MODEL_DIR=/app/server/models/wav2vec2-base-960h \
    PORT=3000
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates curl python3 \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp \
 && rm -rf /var/lib/apt/lists/*
COPY scripts/download-models.sh /tmp/download-models.sh
RUN sh /tmp/download-models.sh /app/server/models && rm /tmp/download-models.sh

# ---------- build ----------
FROM node:22-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm -r build \
 && pnpm --filter @reelsaw/server --prod deploy --legacy /out/server

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
ENV NODE_ENV=production \
    WEB_DIST=/app/web
WORKDIR /app
COPY --from=build /out/server /app/server
COPY --from=build /app/apps/server/drizzle /app/server/drizzle
COPY --from=build /app/apps/web/dist /app/web
# operator CLI: docker compose exec app reelsaw status <projectId>
RUN printf '#!/bin/sh\nexec node /app/server/dist/cli.js "$@"\n' > /usr/local/bin/reelsaw && chmod +x /usr/local/bin/reelsaw \
 && mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://localhost:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "/app/server/dist/main.js"]
