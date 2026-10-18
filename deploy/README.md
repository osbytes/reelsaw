# Reelsaw

Turns long videos into short vertical clips: finds the moments, cleans up the transcript, frames
speakers and burns in captions. Runs on your machine with Docker.

## Install

Requires Docker with Compose (Docker Desktop on macOS/Windows), 8 GB RAM for hosted providers or the smallest local model (`gemma3:4b`), 12 GB or more for `qwen2.5:7b`, 24 GB or more for `qwen2.5:14b`, and ~10 GB disk.

### Fully local in one command (Ollama + Speaches)

On macOS install [Ollama](https://ollama.com/download) first; on Linux and Windows the script uses
a host Ollama if there is one and otherwise runs it in a container.

```bash
curl -fsSL https://raw.githubusercontent.com/osbytes/reelsaw/main/deploy/install.sh | bash
```

(or `bash install.sh` from this folder; same script)

On Windows, in PowerShell with Docker Desktop running:

```powershell
irm https://raw.githubusercontent.com/osbytes/reelsaw/main/deploy/install.ps1 | iex
```

(or `.\install.ps1` from this folder; same script. If script execution is blocked, run
`powershell -ExecutionPolicy Bypass -File .\install.ps1`.) WSL2 users can use the bash one-liner
above as is. `~/reelsaw` is `$HOME\reelsaw` on Windows; the same `REELSAW_*` options apply, set
as `$env:REELSAW_LLM = "qwen2.5:7b"` before running.

It writes `~/reelsaw` (compose file + `.env` with generated secrets), pulls a language model sized to your RAM (`qwen2.5:14b` from 24 GB, `qwen2.5:7b` from 12 GB, else `gemma3:4b`; the script prints its choice), starts
everything and waits until the app answers. `REELSAW_LLM=<model>` overrides the choice. On Linux with Ollama already running on the host, it must
listen beyond loopback (`OLLAMA_HOST=0.0.0.0`) so the container can reach it; the script checks this and
says how to fix it. See the top of
the script for the other options.

### By hand

```bash
cp .env.example .env          # set BETTER_AUTH_SECRET, POSTGRES_PASSWORD and an AI provider
docker compose up -d
open http://localhost:3000    # the first account is the admin; then set SIGNUP_MODE=closed or approval
```

### AI providers

- **Hosted:** set `AI_MODEL` / `TRANSCRIPTION_MODEL` and the matching API key in `.env`.
- **Fully local:** install [Ollama](https://ollama.com), `ollama pull qwen2.5:14b`, uncomment the
  "fully local" block in `.env`, and start with `docker compose --profile local-ai up -d`.

The app checks every provider at startup and exits with a message naming what's wrong. See it with
`docker compose logs app`.

## Accounts

The first account is the admin. `SIGNUP_MODE=open|approval|closed` in `.env` controls sign-ups;
with `approval`, new people wait until you approve them on the **Users** page (or
`docker compose exec app reelsaw approve them@example.com`). Set `EMAIL_DRIVER` to get an email
when someone is waiting. Locked out: `docker compose exec app reelsaw make-admin you@example.com`.

## Agents (MCP)

Settings → *API keys and MCP* creates a key for Claude Code, Claude Desktop, Cursor or scripts;
the page shows the exact client config. The MCP endpoint is `<APP_URL>/api/mcp`, so `APP_URL`
must be the address agents can reach. Agents can also manage your intro/outro library and assign it to
projects and clips (`list_bumpers`, `add_bumper`, `set_project_bumpers`, `set_clip_bumpers`, …).

## Upgrade

```bash
docker compose pull && docker compose up -d
```

Pin a version with `REELSAW_IMAGE=ghcr.io/osbytes/reelsaw:<version>` in `.env`. Settings shows
the running version.

## Back up

Everything lives in two volumes: `reelsaw_pgdata` (database) and `reelsaw_data` (videos, clips).

```bash
docker compose exec -T db pg_dump -U reelsaw reelsaw > reelsaw.sql
```

## Reporting an issue

Use **Report an issue** in the app (project ⋯ menu, a failed clip, or your account menu). It
saves a zip with the project's data, logs and your description. API keys and passwords are never
included; you can see the contents before saving. Send the zip to the Reelsaw team.

## Troubleshooting

```bash
docker compose logs app                      # boot and job logs
docker compose exec app reelsaw status <id>  # one project's pipeline state (id from the URL)
```
