# Reelsaw

Turns long videos into short vertical clips: finds the moments, cleans up the transcript, frames
speakers and burns in captions. Runs on your machine with Docker.

## Install

Requires Docker with Compose (Docker Desktop on macOS/Windows) and ~10 GB disk. RAM depends on where the
language model runs: 8 GB is enough with a hosted provider; the fully local stack also needs room for the
Ollama model (the installer picks it by RAM, see below).

### One command

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
as `$env:REELSAW_AI = "openai"` before running.

The script looks at the machine first: RAM, an NVIDIA GPU and its VRAM, how much memory Docker gets,
free disk, whether Ollama is already running and which models it has, and whether the port is free.
It prints a plan and, in a terminal, asks three questions:

1. **Where the language model runs.** Local Ollama (private, free, slower) is the default when the
   machine can carry a useful model; otherwise OpenAI is suggested. Hosted choices are OpenAI, Anthropic,
   Google, Groq and Vercel AI Gateway; the key is asked for (never echoed) or taken from the usual
   variable (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …). Anthropic and Google have no speech-to-text, so
   they pair with local Speaches; OpenAI, Groq and the gateway transcribe at the provider.
2. **Which model** (local only). The recommendation follows VRAM when a GPU serves the model
   (`qwen2.5:14b` from 12 GB, `qwen2.5:7b` from 6 GB) and RAM otherwise (`qwen2.5:14b` from 24 GB,
   `qwen2.5:7b` from 12 GB, `gemma3:4b` below); a good model already pulled into Ollama is preferred
   over a new download, and any Ollama model can be typed.
3. **Go ahead?** after the plan.

Without a terminal (CI, `ssh host 'curl … | bash'`) or with `REELSAW_YES=1` the proposed answers are
taken and nothing is installed beyond containers; `REELSAW_DRY_RUN=1` prints the plan and stops.
Every answer can be given in advance (`REELSAW_AI`, `REELSAW_LLM`, `REELSAW_WHISPER`, `REELSAW_PORT`,
`REELSAW_DIR`, `REELSAW_IMAGE`, `REELSAW_PROJECT`; see the top of the script).

What it does with the answers:

- **Ollama**: a running one is used as is. If none is installed and you chose local, it offers to
  install it (Homebrew on macOS, `ollama.com/install.sh` on Linux when a GPU would otherwise go unused,
  winget on Windows); on Linux without a GPU it runs Ollama in a container. On Linux a host Ollama must
  listen beyond loopback so the container can reach it; the script checks and offers to set
  `OLLAMA_HOST=0.0.0.0` in the systemd unit for you.
- **GPU**: with an NVIDIA GPU and the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html),
  the Ollama container, Speaches and the app get the GPU (`docker-compose.gpu.yml`, `SPEACHES_IMAGE=…:latest-cuda`,
  `faster-whisper-medium` or `large-v3` from 16 GB VRAM; renders encode with NVENC). A native Ollama uses
  the GPU by itself.
- **Port**: a busy port moves to the next free one (`REELSAW_PORT` sets the first to try).
- **Disk and memory**: it stops before downloading when the disk is short (about 10 GB plus the models)
  and warns when Docker Desktop has under 4 GB.

Then it writes `~/reelsaw` (compose file + `.env` with generated secrets, mode 600), pulls the image and
the model, starts everything and waits until the app answers. Re-running updates: the existing `.env`
decides everything, the newest image is pulled and the app restarts.

### By hand

```bash
cp .env.example .env          # set BETTER_AUTH_SECRET, POSTGRES_PASSWORD and an AI provider
docker compose up -d
open http://localhost:3000    # the first account is the admin; then set SIGNUP_MODE=closed or approval
```

### AI providers

- **Hosted:** set `AI_MODEL` / `TRANSCRIPTION_MODEL` and the matching API key in `.env`.
- **Fully local:** install [Ollama](https://ollama.com), `ollama pull qwen2.5:14b` (`qwen2.5:7b` or
  `gemma3:4b` on less RAM), uncomment the "fully local" block in `.env`, and start with
  `docker compose --profile local-ai up -d`.

The app checks every provider at startup and exits with a message naming what's wrong. See it with
`docker compose logs app`.

### NVIDIA GPU by hand

The installer does this when it finds the card. For a manual install: the NVIDIA driver and the
[NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
on the host (`sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker`;
Windows: Docker Desktop on WSL2 with the Windows driver), then add to `.env`:

```
# Linux/macOS (colon). On Windows use a semicolon: docker-compose.yml;docker-compose.gpu.yml
COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml
SPEACHES_IMAGE=ghcr.io/speaches-ai/speaches:latest-cuda
WHISPER_MODEL=Systran/faster-whisper-large-v3
TRANSCRIPTION_MODEL=openai:Systran/faster-whisper-large-v3
```

and start as usual. Speaches then transcribes on the card with the large model, Ollama in a
container uses it for the language model, and renders encode with NVENC. Check with
`docker compose exec app reelsaw machine` or Settings → System → Overview (GPU, video encoder).
On Docker Desktop (Windows), `gpu` may show `/dev/dxg` rather than a named card, and
`nvidia-smi` is usually not in the app image — trust `video encoder: h264_nvenc` instead.
macOS has no CUDA in Docker: run Ollama natively (Metal) and leave Speaches on the CPU.

## Configuration

`.env.example` lists every variable with its default and meaning; the same list as a table is
[docs/CONFIG.md](../docs/CONFIG.md) in the repository.

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

A client that launches a command instead of calling a URL (Claude Desktop without `MCP_OAUTH`,
Cursor's stdio entries) runs `reelsaw mcp` inside the app container; Settings shows the config:

```json
{ "mcpServers": { "reelsaw": { "command": "docker", "args": ["exec", "-i", "-e", "REELSAW_API_KEY=rs_…", "reelsaw-app-1", "reelsaw", "mcp"] } } }
```

## Upgrade

```bash
docker compose pull && docker compose up -d
```

Pin a version with `REELSAW_IMAGE=ghcr.io/osbytes/reelsaw:<version>` in `.env`. Settings shows
the running version, and when a newer release is published admins see it there (Settings → System,
plus a dot on the account button and the version next to Settings in its menu) with the release notes link and this command; `reelsaw version`
prints the same from the shell, and agents can ask with the `check_for_update` MCP tool. The app
asks GitHub's releases API every 6 hours (`UPDATE_CHECK_HOURS`) sending nothing but the request;
`UPDATE_CHECK=false` turns it off.

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
docker compose exec app reelsaw machine      # cpus, memory, disk, GPU, ffmpeg encoder in use
```
