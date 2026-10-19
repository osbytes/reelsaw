---
"@reelsaw/server": patch
---

Detect the GPU on Docker Desktop (WSL2) via `/dev/dxg` when `nvidia-smi` and `/dev/nvidia0` are missing, document that Windows `.env` must use `;` in `COMPOSE_FILE` (a colon is the drive-letter separator), and keep `pnpm docs:gen` defaults as POSIX paths on Windows.