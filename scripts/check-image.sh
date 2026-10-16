#!/usr/bin/env sh
# Fails if a built image carries source: TypeScript, source maps, src/ or eval/ trees under /app
# (outside node_modules). Usage: scripts/check-image.sh <image>
set -eu
IMAGE="${1:?usage: check-image.sh <image>}"
FOUND=$(docker run --rm --entrypoint sh "$IMAGE" -c \
  'find /app -path "*/node_modules" -prune -o \( -name "*.ts" -o -name "*.tsx" -o -name "*.map" -o -type d -name src -o -type d -name eval \) -print')
if [ -n "$FOUND" ]; then
  echo "source found in $IMAGE:"; echo "$FOUND"; exit 1
fi
echo "check-image: no source in $IMAGE"
docker run --rm --entrypoint sh "$IMAGE" -c 'ls /app/server/dist /app/server/dist/chunks | head -20; echo version=$REELSAW_VERSION commit=$REELSAW_COMMIT'
