#!/bin/sh
# Fix DATA_DIR ownership when a host/volume mount is root-owned (Railway, some K8s PVs),
# then drop to the node user. Idempotent and cheap on an already-writable directory.
set -eu

if [ "$(id -u)" = "0" ]; then
  dir="${DATA_DIR:-/data}"
  mkdir -p "$dir"
  # Mount roots are often root:root 0755; chown the directory itself so node can mkdir under it.
  # Avoid a recursive walk every boot (large stores). Only deepen if node still cannot write.
  chown node:node "$dir" 2>/dev/null || true
  if ! setpriv --reuid=node --regid=node --init-groups test -w "$dir"; then
    chown -R node:node "$dir"
  fi
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

exec "$@"
