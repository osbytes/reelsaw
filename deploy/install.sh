#!/usr/bin/env bash
# Reelsaw, fully local: Ollama for the language model, Speaches (faster-whisper) for speech-to-text.
#
#   curl -fsSL https://raw.githubusercontent.com/osbytes/reelsaw/main/deploy/install.sh | bash
#
# Creates ~/reelsaw (docker-compose.yml + .env with generated secrets), pulls the model, starts the
# stack and waits until it answers. Re-running is safe and is how you update: the existing .env is
# kept, the newest image is pulled and the app restarts (data stays in Docker volumes).
#
# Options (environment variables):
#   REELSAW_DIR=~/reelsaw                         where to install
#   REELSAW_IMAGE=ghcr.io/osbytes/reelsaw:latest  image to run
#   REELSAW_LLM=<model>                           Ollama model; default by RAM: >=24 GB qwen2.5:14b (~9 GB),
#                                                 >=12 GB qwen2.5:7b (~5 GB), otherwise gemma3:4b (~3 GB)
#   REELSAW_WHISPER=Systran/faster-whisper-small  speech-to-text model (downloaded on first boot)
#   REELSAW_PORT=3000                             port for the web app
#   REELSAW_PROJECT=reelsaw                       compose project name (containers/volumes prefix)
set -euo pipefail

# everything runs inside main(), called on the last line: with `curl … | bash`, bash has then read
# the whole script, so a command that reads stdin can't swallow the rest of it
main() {
DIR="${REELSAW_DIR:-$HOME/reelsaw}"
IMAGE="${REELSAW_IMAGE:-ghcr.io/osbytes/reelsaw:latest}"
WHISPER="${REELSAW_WHISPER:-Systran/faster-whisper-small}"
PORT="${REELSAW_PORT:-3000}"
PROJECT="${REELSAW_PROJECT:-reelsaw}"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "Docker is required: https://docs.docker.com/get-docker/"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (included with Docker Desktop)"
docker info >/dev/null 2>&1 || die "Docker is installed but not running: start Docker and run this again"
command -v curl >/dev/null || die "curl is required"

# ---- language model: the default follows the machine's RAM unless REELSAW_LLM says otherwise ----
ram_gb() {
  if [ "$(uname -s)" = "Darwin" ]; then echo $(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1073741824 ))
  else echo $(( $(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0) / 1048576 )); fi
}
RAM=$(ram_gb)
if [ -n "${REELSAW_LLM:-}" ]; then LLM="$REELSAW_LLM"; WHY="from REELSAW_LLM"
elif existing=$(sed -n 's/^AI_MODEL=compat://p' "$DIR/.env" 2>/dev/null | tail -1) && [ -n "$existing" ]; then LLM="$existing"; WHY="kept from the existing $DIR/.env"
elif [ "$RAM" -ge 24 ]; then LLM="qwen2.5:14b"; WHY="detected ${RAM} GB RAM"
elif [ "$RAM" -ge 12 ]; then LLM="qwen2.5:7b"; WHY="detected ${RAM} GB RAM"
else LLM="gemma3:4b"; WHY="detected ${RAM} GB RAM (unknown or under 12 GB)"; fi
say "Language model: $LLM ($WHY; set REELSAW_LLM to choose another)"

# ---- Ollama: native on macOS (Metal GPU), native or in a container on Linux ----
PROFILES=(--profile local-ai)
if curl -fsS http://localhost:11434/api/tags >/dev/null 2>&1; then
  OLLAMA_MODE=host
elif [ "$(uname -s)" = "Darwin" ]; then
  if command -v ollama >/dev/null; then
    say "Starting Ollama"
    (nohup ollama serve >/tmp/ollama.log 2>&1 &)
    for _ in $(seq 1 30); do curl -fsS http://localhost:11434/api/tags >/dev/null 2>&1 && break; sleep 1; done
    curl -fsS http://localhost:11434/api/tags >/dev/null 2>&1 || die "Ollama didn't start; see /tmp/ollama.log"
    OLLAMA_MODE=host
  else
    die "Install Ollama first (https://ollama.com/download, or: brew install ollama), then run this again"
  fi
else
  OLLAMA_MODE=container
  PROFILES+=(--profile ollama)
fi
if [ "$OLLAMA_MODE" = host ]; then OLLAMA_URL="http://host.docker.internal:11434/v1"; else OLLAMA_URL="http://ollama:11434/v1"; fi

# On Linux the container reaches the host through the docker bridge, but Ollama listens on 127.0.0.1
# by default, which the container cannot see (the app would then exit at boot). Probe it the way the
# app will: from inside a container. Docker Desktop (macOS) forwards host.docker.internal to loopback.
if [ "$OLLAMA_MODE" = host ] && [ "$(uname -s)" != "Darwin" ]; then
  say "Checking that containers can reach Ollama on this host"
  if ! docker run --rm --add-host host.docker.internal:host-gateway busybox:1.36 wget -q -T 5 -O /dev/null http://host.docker.internal:11434/api/tags </dev/null >/dev/null 2>&1; then
    die "Ollama runs on this host but only listens on 127.0.0.1, so the Reelsaw container can't reach it.
  Make it listen on all interfaces, then run this again:
    one-off:   OLLAMA_HOST=0.0.0.0 ollama serve
    systemd:   sudo systemctl edit ollama   # add: [Service] Environment=\"OLLAMA_HOST=0.0.0.0\"
               sudo systemctl restart ollama
  (restrict port 11434 with your firewall if this host is reachable from other machines), or stop the host
  Ollama and re-run to let the installer run Ollama in a container instead."
  fi
fi

say "Installing into $DIR"
mkdir -p "$DIR"
cd "$DIR"

cat > docker-compose.yml <<'YAML'
# Reelsaw, fully local (written by install.sh). Start/stop: docker compose --profile local-ai up -d / down
name: reelsaw

x-app: &app
  image: ${REELSAW_IMAGE:-ghcr.io/osbytes/reelsaw:latest}
  stop_grace_period: 330s
  restart: unless-stopped
  depends_on:
    db:
      condition: service_healthy
  env_file:
    - path: .env
      required: false
  extra_hosts:
    - "host.docker.internal:host-gateway"   # Ollama on the host (Linux; Docker Desktop has it built in)
  volumes:
    - data:/data

services:
  db:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: reelsaw
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-reelsaw}
      POSTGRES_DB: reelsaw
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U reelsaw -d reelsaw"]
      interval: 5s
      timeout: 3s
      retries: 20

  app:
    <<: *app
    environment:
      DATABASE_URL: postgres://reelsaw:${POSTGRES_PASSWORD:-reelsaw}@db:5432/reelsaw
      PORT: "3000"
      DATA_DIR: /data
      LOG_FILE: /data/logs/reelsaw.log
      RUN_HTTP: "true"
      RUN_WORKERS: "true"
    ports:
      - "${PORT:-3000}:3000"

  speaches:
    image: ghcr.io/speaches-ai/speaches:latest-cpu   # :latest-cuda with an NVIDIA GPU
    profiles: ["local-ai"]
    restart: unless-stopped
    environment:
      WHISPER__MODEL: ${WHISPER_MODEL:-Systran/faster-whisper-small}
      LOG_LEVEL: info
    volumes:
      - speaches:/home/ubuntu/.cache/huggingface

  ollama:
    image: ollama/ollama:latest
    profiles: ["ollama"]
    restart: unless-stopped
    volumes:
      - ollama:/root/.ollama

volumes:
  pgdata:
  data:
  speaches:
  ollama:
YAML

if [ -f .env ]; then
  say "Keeping the existing .env (delete it to regenerate)"
  # an existing install may pin a version: use the image it runs
  pinned=$(sed -n 's/^REELSAW_IMAGE=//p' .env | tail -1)
  [ -n "$pinned" ] && IMAGE="$pinned"
else
  rand() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c "$1"; }
  cat > .env <<ENV
# Generated by install.sh. Restart after changes: docker compose --profile local-ai up -d
BETTER_AUTH_SECRET=$(rand 48)
POSTGRES_PASSWORD=$(rand 24)
APP_URL=http://localhost:$PORT
PORT=$PORT
REELSAW_IMAGE=$IMAGE
ALLOW_SIGNUP=true

# language model: Ollama ($OLLAMA_MODE)
AI_MODEL=compat:$LLM
OPENAI_COMPATIBLE_BASE_URL=$OLLAMA_URL
OPENAI_COMPATIBLE_API_KEY=ollama

# speech-to-text: Speaches (OpenAI-compatible audio API)
TRANSCRIPTION_MODEL=openai:$WHISPER
WHISPER_MODEL=$WHISPER
OPENAI_BASE_URL=http://speaches:8000/v1
OPENAI_API_KEY=local

# model calls go to the log so "Report an issue" can include them (prompts contain transcript text)
LLM_TRACE=logs
ENV
fi

compose() { docker compose -p "$PROJECT" "${PROFILES[@]}" "$@"; }

say "Pulling images (first run downloads a few GB)"
compose pull --quiet --ignore-pull-failures </dev/null || true
docker image inspect "$IMAGE" >/dev/null 2>&1 || die "couldn't pull $IMAGE: check the name, or 'docker login ghcr.io' if the image is private"
say "Image: $(docker image inspect --format '{{index .RepoDigests 0}}' "$IMAGE" 2>/dev/null || echo "$IMAGE (no registry digest)")"

say "Pulling the language model $LLM (first run only; several GB)"
if [ "$OLLAMA_MODE" = host ]; then
  if command -v ollama >/dev/null; then ollama pull "$LLM" </dev/null
  else curl -fsS http://localhost:11434/api/pull -d "{\"name\":\"$LLM\",\"stream\":false}" >/dev/null || die "couldn't pull $LLM from the Ollama server"; fi
else
  compose up -d ollama </dev/null
  for _ in $(seq 1 30); do compose exec -T ollama ollama list >/dev/null 2>&1 && break; sleep 1; done
  compose exec -T ollama ollama pull "$LLM" </dev/null
fi

say "Starting Reelsaw"
compose up -d </dev/null

say "Waiting for the app (the first boot downloads the speech model)"
for _ in $(seq 1 120); do
  if curl -fsS "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
    say "Reelsaw is running: http://localhost:$PORT"
    cat <<DONE

  Create your account, then set ALLOW_SIGNUP=false in $DIR/.env and restart.

  cd $DIR
  docker compose -p $PROJECT ${PROFILES[*]} logs -f app   # logs
  docker compose -p $PROJECT ${PROFILES[*]} pull && docker compose -p $PROJECT ${PROFILES[*]} up -d   # upgrade
  docker compose -p $PROJECT ${PROFILES[*]} down   # stop (data is kept in volumes)
DONE
    exit 0
  fi
  sleep 5
done
compose logs --tail 40 app
die "the app didn't come up within 10 minutes; the log above usually says why"
}

main "$@"
