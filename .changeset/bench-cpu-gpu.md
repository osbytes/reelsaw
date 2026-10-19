---
"@reelsaw/server": patch
---

Add `local-qwen14-cpu` / `local-qwen14-gpu` bench profiles and `bench:e2e --gpu` (NVENC for the isolated bench app). Fix the e2e driver on Windows (`fileURLToPath` for the repo root cwd, resolve `docker.exe` via `where.exe`).
