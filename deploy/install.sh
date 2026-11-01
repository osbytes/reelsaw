#!/usr/bin/env bash
# Reelsaw installer: Docker Compose stack with the language model in Ollama (local) or at a hosted
# provider, and speech-to-text in Speaches (faster-whisper, local) or at the provider.
#
#   curl -fsSL https://raw.githubusercontent.com/osbytes/reelsaw/main/deploy/install.sh | bash
#
# It looks at the machine (RAM, GPU, Docker's memory, free disk, a running Ollama and its models, the
# port), proposes a setup, asks three questions when run in a terminal (local or hosted, which model,
# go ahead), then writes ~/reelsaw (docker-compose.yml + .env with generated secrets), pulls the model,
# starts the stack and waits until it answers. Without a terminal (CI, `ssh host 'curl … | bash'`) or
# with REELSAW_YES=1 it takes the proposed answers. Re-running is safe and is how you update: the
# existing .env is kept, the newest image is pulled and the app restarts (data stays in Docker volumes).
#
# Answers in advance (environment variables; each one skips its question):
#   REELSAW_AI=local|openai|anthropic|google|groq|gateway   where the language model runs
#     local: Ollama (installed with Homebrew on macOS or ollama.com/install.sh on Linux if missing and
#            you agree; otherwise a container). Hosted: the provider's key is read from the usual
#            variable (OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, GROQ_API_KEY,
#            AI_GATEWAY_API_KEY) or asked for, never echoed. Anthropic and Google have no speech-to-text,
#            so those pair with local Speaches; OpenAI, Groq and the gateway transcribe at the provider.
#   REELSAW_LLM=<model>          local: Ollama model (default by VRAM/RAM, or a good one already pulled);
#                                hosted: provider:model, e.g. anthropic:claude-sonnet-4-5
#   REELSAW_WHISPER=<model>      Speaches model (default faster-whisper-small; medium/large-v3 on a GPU)
#   REELSAW_PORT=3000            port for the web app (a busy port moves to the next free one)
#   REELSAW_DIR=~/reelsaw        where to install
#   REELSAW_IMAGE=ghcr.io/osbytes/reelsaw:latest
#   REELSAW_PROJECT=reelsaw      compose project name (containers/volumes prefix)
#   REELSAW_YES=1                no questions: take every proposed answer (also: bash -s -- --yes)
#   REELSAW_DRY_RUN=1            print the plan and stop before changing anything
set -euo pipefail

# Everything runs inside main(), called on the last line: with `curl … | bash`, bash has then read the
# whole script, so a command that reads stdin can't swallow the rest of it. Questions read /dev/tty,
# never stdin, for the same reason. Written for bash 3.2 (macOS's /bin/bash).
main() {
for a in "$@"; do case "$a" in -y|--yes) REELSAW_YES=1 ;; --dry-run) REELSAW_DRY_RUN=1 ;; esac; done
DIR="${REELSAW_DIR:-$HOME/reelsaw}"
IMAGE="${REELSAW_IMAGE:-ghcr.io/osbytes/reelsaw:latest}"
PORT="${REELSAW_PORT:-3000}"
PROJECT="${REELSAW_PROJECT:-reelsaw}"
YES="${REELSAW_YES:-}"
DRY="${REELSAW_DRY_RUN:-}"

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
has()  { command -v "$1" >/dev/null 2>&1; }

# ---- questions: only with a terminal and without REELSAW_YES; otherwise the default wins ----
INTERACTIVE=""
if [ -z "$YES" ] && [ -t 1 ] && [ -r /dev/tty ] && [ -w /dev/tty ]; then INTERACTIVE=1; fi
# ask VAR "question" "default" -> VAR  (locals are prefixed so VAR can never collide with them)
ask() {
  local __var=$1 __q=$2 __d=$3 __v=""
  if [ -n "$INTERACTIVE" ]; then
    printf '\033[1m?\033[0m %s [%s] ' "$__q" "$__d" >/dev/tty
    IFS= read -r __v </dev/tty || __v=""
  fi
  eval "$__var=\${__v:-\$__d}"
}
# confirm "question" default(y|n) -> exit status
confirm() {
  local answer
  if [ "$2" = y ]; then ask answer "$1 (Y/n)" y; else ask answer "$1 (y/N)" n; fi
  case "$answer" in y|Y|yes|YES|Yes) return 0 ;; *) return 1 ;; esac
}
# choose VAR "question" default "value|label" ... : a numbered menu; the value is stored in VAR
choose() {
  local __var=$1 __q=$2 __d=$3; shift 3
  local __i=1 __dn=1 __v __line
  if [ -n "$INTERACTIVE" ]; then
    printf '\033[1m?\033[0m %s\n' "$__q" >/dev/tty
    for __line in "$@"; do
      [ "${__line%%|*}" = "$__d" ] && __dn=$__i
      printf '    %d) %s\n' "$__i" "${__line#*|}" >/dev/tty
      __i=$((__i + 1))
    done
    printf '    choice [%d]: ' "$__dn" >/dev/tty
    IFS= read -r __v </dev/tty || __v=""
    __v=${__v:-$__dn}
    __i=1
    for __line in "$@"; do
      if [ "$__v" = "$__i" ] || [ "$__v" = "${__line%%|*}" ]; then eval "$__var=\${__line%%|*}"; return; fi
      __i=$((__i + 1))
    done
    warn "'$__v' is not an option; using $__d"
  fi
  eval "$__var=\$__d"
}

# ---- prerequisites: Docker is the one thing this script does not install (desktop app, group membership) ----
OS=$(uname -s); ARCH=$(uname -m)
has docker || die "Docker is required: https://docs.docker.com/get-docker/ (then run this again)"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (included with Docker Desktop)"
docker info >/dev/null 2>&1 || die "Docker is installed but not running: start Docker and run this again"
has curl || die "curl is required"

# ---- the machine: RAM, Docker's memory, GPU, disk ----
ram_gb() {
  local k v _
  if [ "$OS" = Darwin ]; then echo $(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1073741824 ))
  else while read -r k v _; do if [ "$k" = MemTotal: ]; then echo $(( v / 1048576 )); return; fi; done </proc/meminfo 2>/dev/null; echo 0; fi
}
RAM=$(ram_gb)
DOCKER_GB=$(( $(docker info --format '{{.MemTotal}}' 2>/dev/null || echo 0) / 1073741824 ))
DOCKER_DESKTOP=""; docker info --format '{{.OperatingSystem}}' 2>/dev/null | grep -qi 'docker desktop' && DOCKER_DESKTOP=1
APPLE_SILICON=""; [ "$OS" = Darwin ] && [ "$ARCH" = arm64 ] && APPLE_SILICON=1

# NVIDIA GPU (Linux and WSL2): VRAM decides the model size; the container toolkit decides whether
# containers can use it. macOS has no GPU passthrough: a native Ollama uses Metal, Speaches stays on CPU.
VRAM=0; GPU_NAME=""; NVIDIA_RUNTIME=""
if [ "$OS" = Linux ] && has nvidia-smi; then
  GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || true)
  mib=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d ' ' || true)
  case "$mib" in ''|*[!0-9]*) mib=0 ;; esac   # "[N/A]" or nothing: no usable GPU
  VRAM=$(( mib / 1024 ))
  [ "$VRAM" -gt 0 ] || GPU_NAME=""
  docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q nvidia && NVIDIA_RUNTIME=1
fi
# installing software (Ollama) needs a yes: from you at the prompt, or REELSAW_YES; a run with neither
# never installs anything beyond containers
MAY_INSTALL=""; if [ -n "$INTERACTIVE" ] || [ -n "$YES" ]; then MAY_INSTALL=1; fi

free_gb() { local kb; kb=$(df -Pk "$1" 2>/dev/null | tail -1 | tr -s ' ' | cut -d' ' -f4); echo $(( ${kb:-0} / 1048576 )); }
mkdir -p "$DIR" 2>/dev/null || true
DISK=$(free_gb "$DIR"); DISK=${DISK:-0}

# ---- an existing install answers for itself (re-run = update) ----
ENV_FILE="$DIR/.env"
envget() { sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | tail -1; }
EXISTING=""
if [ -f "$ENV_FILE" ]; then
  EXISTING=1
  PORT=$(envget PORT); PORT=${PORT:-3000}
  pinned=$(envget REELSAW_IMAGE); [ -n "$pinned" ] && IMAGE="$pinned"
fi
# Volumes outlive a deleted folder or .env: a database from an earlier install under the same project
# name keeps the password it was created with. The installer keeps that data and resets the password
# from .env once the database is up (below), so .env is always the source of truth.
PRIOR_DB=""; PRIOR_DIR=""
docker volume inspect "${PROJECT}_pgdata" >/dev/null 2>&1 && PRIOR_DB=1
PRIOR_DIR=$(docker ps -a --filter "label=com.docker.compose.project=$PROJECT" \
  --format '{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null | grep -v "^$DIR\$" | head -1 || true)

# ---- Ollama on this host: running, installed, and which models are already pulled ----
OLLAMA_API=http://localhost:11434
ollama_up() { curl -fsS "$OLLAMA_API/api/tags" >/dev/null 2>&1; }
ollama_models() {   # names of pulled models, one per line
  curl -fsS "$OLLAMA_API/api/tags" 2>/dev/null | tr ',' '\n' | sed -n 's/.*"name":"\([^"]*\)".*/\1/p' | sort -u
}
start_host_ollama() {
  say "Starting Ollama"
  if [ "$OS" = Linux ] && has systemctl && systemctl list-unit-files ollama.service >/dev/null 2>&1; then
    sudo systemctl start ollama </dev/null 2>/dev/null || (nohup ollama serve >/tmp/ollama.log 2>&1 &)   # sudo asks on /dev/tty itself
  else
    (nohup ollama serve >/tmp/ollama.log 2>&1 &)
  fi
  for _ in $(seq 1 30); do ollama_up && break; sleep 1; done
  ollama_up || die "Ollama didn't start; see /tmp/ollama.log"
}

# ---- where should the language model run? ----
# Local wins when the machine can carry a useful model; a small box with a hosted key gets far better
# clips from the provider, so the default moves there (local still works, with gemma3:4b).
CAN_LOCAL=""
if [ "$VRAM" -ge 6 ] || [ "$RAM" -ge 12 ]; then CAN_LOCAL=1; fi
say "This machine: ${RAM} GB RAM${GPU_NAME:+, $GPU_NAME (${VRAM} GB)}${APPLE_SILICON:+, Apple Silicon (Metal)}, Docker gets ${DOCKER_GB} GB, ${DISK} GB free in $DIR"
AI="${REELSAW_AI:-}"
if [ -n "$EXISTING" ] && [ -z "$AI" ]; then
  case "$(envget AI_MODEL)" in
    compat:*) AI=local ;;
    openai:*) AI=openai ;; anthropic:*) AI=anthropic ;; google:*) AI=google ;; groq:*) AI=groq ;; gateway:*) AI=gateway ;;
    *) AI=local ;;
  esac
  AI_WHY="kept from $ENV_FILE"
elif [ -n "$AI" ]; then
  AI_WHY="from REELSAW_AI"
else
  if [ -n "$CAN_LOCAL" ]; then d=local; rec_local=" (recommended here)"; rec_hosted=""
  else d=openai; rec_local=""; rec_hosted=" (recommended: with under 12 GB RAM a local model is weak)"; fi
  [ -z "$INTERACTIVE" ] && d=local   # unattended runs stay local: nothing leaves the machine and no key is needed
  choose AI "Where should the language model run?" "$d" \
    "local|On this machine with Ollama: private, free, slower$rec_local" \
    "openai|OpenAI (gpt-4o-mini + whisper-1): one key, fast, good quality$rec_hosted" \
    "anthropic|Anthropic (claude-sonnet-4-5) for language, local Speaches for speech-to-text" \
    "google|Google (gemini-2.5-flash) for language, local Speaches for speech-to-text" \
    "groq|Groq (llama-3.3-70b + whisper-large-v3-turbo): one key, very fast" \
    "gateway|Vercel AI Gateway (claude-sonnet-4-5 + whisper-1): one key for every vendor"
  AI_WHY="your choice"; [ -z "$INTERACTIVE" ] && AI_WHY="default; REELSAW_AI picks another"
fi
case "$AI" in local|openai|anthropic|google|groq|gateway) ;; *) die "REELSAW_AI must be local, openai, anthropic, google, groq or gateway (got '$AI')" ;; esac

# ---- hosted provider: model defaults and the key (asked for, never echoed; or from the environment) ----
KEY_VAR=""; KEY=""; PROVIDER_STT=""
if [ "$AI" != local ]; then
  case "$AI" in
    openai)    KEY_VAR=OPENAI_API_KEY;               LLM_DEFAULT=openai:gpt-4o-mini;                    PROVIDER_STT=openai:whisper-1 ;;
    anthropic) KEY_VAR=ANTHROPIC_API_KEY;            LLM_DEFAULT=anthropic:claude-sonnet-4-5 ;;
    google)    KEY_VAR=GOOGLE_GENERATIVE_AI_API_KEY; LLM_DEFAULT=google:gemini-2.5-flash ;;
    groq)      KEY_VAR=GROQ_API_KEY;                 LLM_DEFAULT=groq:llama-3.3-70b-versatile;          PROVIDER_STT=groq:whisper-large-v3-turbo ;;
    gateway)   KEY_VAR=AI_GATEWAY_API_KEY;           LLM_DEFAULT=gateway:anthropic/claude-sonnet-4-5;   PROVIDER_STT=gateway:openai/whisper-1 ;;
  esac
  if [ -n "$EXISTING" ]; then
    LLM=$(envget AI_MODEL); LLM=${REELSAW_LLM:-$LLM}
    KEY=$(envget "$KEY_VAR")
  else
    LLM="${REELSAW_LLM:-$LLM_DEFAULT}"
    case "$LLM" in "$AI":*) ;; *) die "REELSAW_LLM must start with '$AI:' for REELSAW_AI=$AI (got '$LLM')" ;; esac
    KEY=${!KEY_VAR:-}
    if [ -z "$KEY" ]; then
      [ -n "$INTERACTIVE" ] || die "set $KEY_VAR in the environment for REELSAW_AI=$AI (or run in a terminal to be asked)"
      while [ -z "$KEY" ]; do
        printf '\033[1m?\033[0m %s (input hidden): ' "$KEY_VAR" >/dev/tty
        IFS= read -rs KEY </dev/tty || KEY=""; printf '\n' >/dev/tty
      done
    fi
  fi
fi

# ---- local: Ollama placement, GPU, model ----
# host = Ollama runs on this machine (Metal on Apple Silicon, CUDA when the native Linux build sees the GPU);
# container = the ollama service in the compose file (GPU only with the NVIDIA container toolkit).
OLLAMA_MODE=""; OLLAMA_INSTALL=""; OLLAMA_URL=""; GPU_COMPOSE=""; FIX_LOOPBACK=""
if [ "$AI" = local ]; then
  if [ -n "$EXISTING" ]; then
    case "$(envget OPENAI_COMPATIBLE_BASE_URL)" in *ollama:11434*) OLLAMA_MODE=container ;; *) OLLAMA_MODE=host ;; esac
  elif ollama_up; then
    OLLAMA_MODE=host
  elif has ollama; then
    OLLAMA_MODE=host
  elif [ "$OS" = Darwin ]; then
    # a container on macOS has no GPU: native Ollama is the only sensible choice
    if has brew && [ -n "$MAY_INSTALL" ] && confirm "Ollama is not installed. Install it with Homebrew (brew install ollama)?" y; then
      OLLAMA_INSTALL=brew; OLLAMA_MODE=host
    elif has brew; then
      die "Install Ollama (https://ollama.com/download or: brew install ollama), then run this again"
    else
      die "Install Ollama first (https://ollama.com/download, or install Homebrew and re-run to have it installed for you), then run this again"
    fi
  elif [ "$VRAM" -gt 0 ] && [ -z "$NVIDIA_RUNTIME" ]; then
    # a GPU that containers cannot see: the native build uses it out of the box
    if [ -n "$MAY_INSTALL" ] && confirm "An NVIDIA GPU was found but Docker has no NVIDIA runtime. Install Ollama natively (ollama.com/install.sh, uses sudo) so it can use the GPU?" y; then
      OLLAMA_INSTALL=native; OLLAMA_MODE=host
    else
      warn "Ollama will run in a container on the CPU. For the GPU: install Ollama natively (https://ollama.com/download) or the NVIDIA Container Toolkit (https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) and re-run"
      OLLAMA_MODE=container
    fi
  else
    OLLAMA_MODE=container
  fi
  if [ "$OLLAMA_MODE" = container ] && [ -n "$NVIDIA_RUNTIME" ]; then GPU_COMPOSE=1; fi
  if [ "$OLLAMA_MODE" = host ]; then OLLAMA_URL="http://host.docker.internal:11434/v1"; else OLLAMA_URL="http://ollama:11434/v1"; fi

  # memory the model can use: VRAM when a GPU serves it, the host's RAM for a native Ollama, Docker's
  # share of it (Docker Desktop, WSL2) for the container
  MEM_IS_VRAM=""
  if [ "$OLLAMA_MODE" = host ] && [ "$VRAM" -gt 0 ]; then MEM=$VRAM; MEM_WHAT="${VRAM} GB VRAM"; MEM_IS_VRAM=1
  elif [ "$OLLAMA_MODE" = container ] && [ -n "$GPU_COMPOSE" ]; then MEM=$VRAM; MEM_WHAT="${VRAM} GB VRAM"; MEM_IS_VRAM=1
  elif [ "$OLLAMA_MODE" = container ] && [ "$DOCKER_GB" -gt 0 ] && [ "$DOCKER_GB" -lt "$RAM" ]; then MEM=$DOCKER_GB; MEM_WHAT="${DOCKER_GB} GB for Docker (of ${RAM} GB RAM)"
  else MEM=$RAM; MEM_WHAT="${RAM} GB RAM"; fi
  # the GPU rule is about fitting the whole model in VRAM; the RAM rule leaves room for the app and OS
  if [ -n "$MEM_IS_VRAM" ]; then
    if [ "$MEM" -ge 12 ]; then REC=qwen2.5:14b; elif [ "$MEM" -ge 6 ]; then REC=qwen2.5:7b; else REC=gemma3:4b; fi
  else
    if [ "$MEM" -ge 24 ]; then REC=qwen2.5:14b; elif [ "$MEM" -ge 12 ]; then REC=qwen2.5:7b; else REC=gemma3:4b; fi
  fi
  if [ "$OS" = Darwin ] && [ -z "$APPLE_SILICON" ] && [ "$REC" = qwen2.5:14b ]; then REC=qwen2.5:7b; MEM_WHAT="$MEM_WHAT, Intel Mac (no GPU)"; fi

  # a good model that is already pulled beats a 9 GB download, when it fits
  PULLED=""; [ "$OLLAMA_MODE" = host ] && ollama_up && PULLED=$(ollama_models)
  fits() {   # fits <model>: known models by memory need (download size + headroom)
    case "$1" in
      qwen2.5:14b|gemma3:12b|*:14b|*:13b|*:12b) [ "$MEM" -ge 12 ] ;;
      llama3.1:8b|qwen2.5:7b|*:8b|*:7b)         [ "$MEM" -ge 6 ] ;;
      *) true ;;
    esac
  }
  BEST_PULLED=""
  for m in qwen2.5:14b gemma3:12b llama3.1:8b qwen2.5:7b gemma3:4b; do
    if printf '%s\n' "$PULLED" | grep -qx "$m" && fits "$m"; then BEST_PULLED=$m; break; fi
  done

  if [ -n "${REELSAW_LLM:-}" ]; then LLM="$REELSAW_LLM"; LLM_WHY="from REELSAW_LLM"
  elif [ -n "$EXISTING" ] && existing=$(envget AI_MODEL) && [ -n "$existing" ]; then LLM="${existing#compat:}"; LLM_WHY="kept from $ENV_FILE"
  else
    d=${BEST_PULLED:-$REC}
    rec_pulled=""; printf '%s\n' "$PULLED" | grep -qx "$REC" && rec_pulled=", already pulled"
    opts=("$REC|$REC: recommended for $MEM_WHAT$rec_pulled")
    if [ -n "$BEST_PULLED" ] && [ "$BEST_PULLED" != "$REC" ]; then opts=("$BEST_PULLED|$BEST_PULLED: already pulled, no download" "${opts[@]}"); fi
    for m in qwen2.5:14b gemma3:12b llama3.1:8b qwen2.5:7b gemma3:4b; do
      if [ "$m" = "$REC" ] || [ "$m" = "$BEST_PULLED" ]; then continue; fi
      case "$m" in qwen2.5:14b) sz="9 GB, best quality" ;; gemma3:12b) sz="8 GB, close second" ;; llama3.1:8b) sz="5 GB, good" ;; qwen2.5:7b) sz="5 GB, good" ;; gemma3:4b) sz="3 GB, basic" ;; esac
      pulled=""; printf '%s\n' "$PULLED" | grep -qx "$m" && pulled=", pulled"
      fit=""; fits "$m" || fit=", too big for $MEM_WHAT"
      opts=("${opts[@]}" "$m|$m: $sz$pulled$fit")
    done
    opts=("${opts[@]}" "other|Another Ollama model (typed)")
    choose LLM "Which language model?" "$d" "${opts[@]}"
    [ "$LLM" = other ] && ask LLM "Ollama model name (see https://ollama.com/library)" "$REC"
    LLM_WHY="your choice"; [ -z "$INTERACTIVE" ] && LLM_WHY="detected $MEM_WHAT${BEST_PULLED:+, already pulled}"
  fi
fi

# ---- speech-to-text: Speaches unless the hosted provider has it ----
SPEACHES=""; SPEACHES_IMAGE=ghcr.io/speaches-ai/speaches:latest-cpu; WHISPER="${REELSAW_WHISPER:-}"
if [ -z "$PROVIDER_STT" ]; then
  SPEACHES=1
  if [ -n "$EXISTING" ] && [ -z "$WHISPER" ]; then WHISPER=$(envget WHISPER_MODEL); fi
  if [ -n "$NVIDIA_RUNTIME" ]; then
    SPEACHES_IMAGE=ghcr.io/speaches-ai/speaches:latest-cuda; GPU_COMPOSE=1
    if [ -z "$WHISPER" ]; then if [ "$VRAM" -ge 16 ]; then WHISPER=Systran/faster-whisper-large-v3; else WHISPER=Systran/faster-whisper-medium; fi; fi
  fi
  WHISPER=${WHISPER:-Systran/faster-whisper-small}
  STT="openai:$WHISPER"; STT_WHERE="Speaches${NVIDIA_RUNTIME:+ on the GPU}"
else
  STT="$PROVIDER_STT"; STT_WHERE="$AI"
fi

# ---- port: an existing install owns its port; otherwise a busy one moves to the next free ----
port_busy() {
  if (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; then exec 3>&- 2>/dev/null; return 0; fi
  if has lsof; then lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; return; fi
  return 1
}
PORT_WHY=""
if [ -z "$EXISTING" ] && port_busy "$PORT"; then
  if curl -fsS "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
    warn "something already answers like Reelsaw on port $PORT; this install will use another port (set REELSAW_DIR to update that one instead)"
  fi
  orig=$PORT
  while port_busy "$PORT"; do PORT=$((PORT + 1)); [ "$PORT" -gt $((orig + 50)) ] && die "no free port between $orig and $PORT"; done
  PORT_WHY=" (port $orig is in use)"
fi

# ---- disk and memory sanity, before anything is downloaded ----
NEED=10
if [ "$AI" = local ]; then case "$LLM" in *:14b|gemma3:12b|*:12b|*:13b) NEED=$((NEED + 10)) ;; *:8b|*:7b) NEED=$((NEED + 6)) ;; *) NEED=$((NEED + 4)) ;; esac; fi
[ -n "$SPEACHES" ] && case "$WHISPER" in *large*) NEED=$((NEED + 3)) ;; *medium*) NEED=$((NEED + 2)) ;; esac
if [ -z "$EXISTING" ] && [ "$DISK" -gt 0 ] && [ "$DISK" -lt "$NEED" ]; then
  die "about ${NEED} GB of free disk are needed (images, the models, your videos); $DIR has ${DISK} GB. Free some space or set REELSAW_DIR to another disk"
fi
if [ -n "$DOCKER_DESKTOP" ] && [ "$DOCKER_GB" -gt 0 ] && [ "$DOCKER_GB" -lt 4 ]; then
  warn "Docker Desktop is limited to ${DOCKER_GB} GB of memory; the app, Postgres and Speaches share it. Raise it under Settings → Resources (6 GB or more) if clips fail or renders crawl"
fi

# ---- the plan ----
PROFILES=()
[ -n "$SPEACHES" ] && PROFILES=(--profile local-ai)
[ "$OLLAMA_MODE" = container ] && PROFILES=("${PROFILES[@]}" --profile ollama)
profiles() { printf '%s' "${PROFILES[@]+"${PROFILES[*]}"}"; }
compose() { docker compose -p "$PROJECT" ${PROFILES[@]+"${PROFILES[@]}"} "$@"; }

say "Plan"
if [ -n "$EXISTING" ]; then note "Update the install in $DIR (its .env is kept; delete it to start over)"; else note "Install into $DIR"; fi
note "Image: $IMAGE"
if [ -z "$EXISTING" ] && [ -n "$PRIOR_DB" ]; then note "Database: keeping ${PROJECT}_pgdata from an earlier install; its password is set from the new .env"; fi
if [ -n "$PRIOR_DIR" ]; then note "Containers started from $PRIOR_DIR are replaced (their volumes are kept)"; fi
if [ "$AI" = local ]; then
  note "Language model: $LLM in Ollama ($LLM_WHY)"
  case "$OLLAMA_INSTALL" in
    brew)   note "Ollama: install with Homebrew, run natively (Metal)" ;;
    native) note "Ollama: install natively from ollama.com (sudo), uses the GPU" ;;
    *) if [ "$OLLAMA_MODE" = host ]; then note "Ollama: the one on this machine${APPLE_SILICON:+ (Metal)}${GPU_NAME:+ ($GPU_NAME)}"
       elif [ -n "$GPU_COMPOSE" ]; then note "Ollama: in a container with the GPU ($GPU_NAME)"
       else note "Ollama: in a container on the CPU"; fi ;;
  esac
else
  note "Language model: $LLM at $AI ($AI_WHY; key: $KEY_VAR, stored in $ENV_FILE)"
fi
note "Speech-to-text: $STT via $STT_WHERE"
note "Web app: http://localhost:$PORT$PORT_WHY"
[ -n "$DRY" ] && { say "Dry run: stopping here (REELSAW_DRY_RUN)"; exit 0; }
confirm "Go ahead?" y || die "stopped; nothing was changed"

# ---- Ollama: install, start, make reachable from containers ----
if [ "$OLLAMA_INSTALL" = brew ]; then
  say "Installing Ollama with Homebrew"
  brew install ollama </dev/null || die "brew install ollama failed"
elif [ "$OLLAMA_INSTALL" = native ]; then
  say "Installing Ollama (ollama.com/install.sh; sudo asks for your password)"
  curl -fsSL https://ollama.com/install.sh | sh || die "the Ollama installer failed"
  hash -r
fi
if [ "$OLLAMA_MODE" = host ] && ! ollama_up; then
  has ollama || die "Ollama is not installed; install it (https://ollama.com/download) and run this again"
  start_host_ollama
fi

# On Linux the container reaches the host through the docker bridge, but Ollama listens on 127.0.0.1
# by default, which the container cannot see (the app would then exit at boot). Probe it the way the
# app will: from inside a container. Docker Desktop (macOS, Windows) forwards host.docker.internal to loopback.
if [ "$OLLAMA_MODE" = host ] && [ "$OS" != Darwin ]; then
  say "Checking that containers can reach Ollama on this host"
  reachable() { docker run --rm --add-host host.docker.internal:host-gateway busybox:1.36 wget -q -T 5 -O /dev/null http://host.docker.internal:11434/api/tags </dev/null >/dev/null 2>&1; }
  if ! reachable; then
    fixed=""
    if has systemctl && systemctl list-unit-files ollama.service >/dev/null 2>&1 \
       && confirm "Ollama only listens on 127.0.0.1, so containers can't reach it. Set OLLAMA_HOST=0.0.0.0 in its systemd unit and restart it (sudo)?" y; then
      sudo mkdir -p /etc/systemd/system/ollama.service.d \
        && printf '[Service]\nEnvironment="OLLAMA_HOST=0.0.0.0"\n' | sudo tee /etc/systemd/system/ollama.service.d/reelsaw.conf >/dev/null \
        && sudo systemctl daemon-reload && sudo systemctl restart ollama \
        && for _ in $(seq 1 30); do ollama_up && break; sleep 1; done \
        && reachable && fixed=1
      [ -n "$fixed" ] && warn "Ollama now listens on every interface: restrict port 11434 with your firewall if this host is reachable from other machines"
    fi
    [ -n "$fixed" ] || die "Ollama runs on this host but only listens on 127.0.0.1, so the Reelsaw container can't reach it.
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
# Reelsaw (written by the installer). Start/stop: docker compose up -d / down (profiles come from .env)
name: reelsaw

x-app: &app
  image: ${REELSAW_IMAGE:-ghcr.io/osbytes/reelsaw:latest}
  stop_grace_period: ${STOP_GRACE_PERIOD:-330s}
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
    image: ${SPEACHES_IMAGE:-ghcr.io/speaches-ai/speaches:latest-cpu}   # :latest-cuda with an NVIDIA GPU
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

# the GPU reservation lives in an override file that .env's COMPOSE_FILE pulls in, so the base file
# is the same everywhere and `docker compose …` in this folder keeps working as printed
if [ -n "$GPU_COMPOSE" ]; then
  cat > docker-compose.gpu.yml <<'YAML'
# NVIDIA GPU for Ollama, Speaches and the app's ffmpeg (written by install.sh; needs the NVIDIA Container
# Toolkit). `video` is the NVENC capability: FFMPEG_ENCODER=auto then encodes clips with h264_nvenc.
x-gpu: &gpu
  deploy:
    resources:
      reservations:
        devices:
          - driver: nvidia
            count: all
            capabilities: [gpu, video]
services:
  app:
    <<: *gpu
    environment:
      NVIDIA_DRIVER_CAPABILITIES: compute,video,utility
  ollama:
    <<: *gpu
  speaches:
    <<: *gpu
YAML
fi

if [ -n "$EXISTING" ]; then
  say "Keeping the existing .env (delete it to regenerate)"
else
  rand() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c "$1"; }
  umask 077
  {
    cat <<ENV
# Generated by install.sh. Restart after changes: docker compose up -d (in this folder)
COMPOSE_PROJECT_NAME=$PROJECT
COMPOSE_PROFILES=$(printf '%s' "${PROFILES[@]+"${PROFILES[*]}"}" | sed 's/--profile //g; s/ /,/g')
BETTER_AUTH_SECRET=$(rand 48)
POSTGRES_PASSWORD=$(rand 24)
APP_URL=http://localhost:$PORT
PORT=$PORT
REELSAW_IMAGE=$IMAGE
SIGNUP_MODE=open
ENV
    [ -n "$GPU_COMPOSE" ] && echo "COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml"
    echo
    if [ "$AI" = local ]; then
      cat <<ENV
# language model: Ollama ($OLLAMA_MODE)
AI_MODEL=compat:$LLM
OPENAI_COMPATIBLE_BASE_URL=$OLLAMA_URL
OPENAI_COMPATIBLE_API_KEY=ollama
ENV
    else
      cat <<ENV
# language model: $AI
AI_MODEL=$LLM
$KEY_VAR=$KEY
ENV
    fi
    echo
    if [ -n "$SPEACHES" ]; then
      cat <<ENV
# speech-to-text: Speaches (OpenAI-compatible audio API)
TRANSCRIPTION_MODEL=$STT
WHISPER_MODEL=$WHISPER
SPEACHES_IMAGE=$SPEACHES_IMAGE
OPENAI_BASE_URL=http://speaches:8000/v1
OPENAI_API_KEY=local
ENV
    else
      cat <<ENV
# speech-to-text: $AI
TRANSCRIPTION_MODEL=$STT
ENV
    fi
    cat <<'ENV'

# model calls go to the log so "Report an issue" can include them (prompts contain transcript text)
LLM_TRACE=logs
ENV
  } > .env
  umask 022
fi

say "Pulling images (first run downloads a few GB)"
compose pull --quiet --ignore-pull-failures </dev/null || true
docker image inspect "$IMAGE" >/dev/null 2>&1 || die "couldn't pull $IMAGE: check the name, or 'docker login ghcr.io' if the image is private"
say "Image: $(docker image inspect --format '{{index .RepoDigests 0}}' "$IMAGE" 2>/dev/null || echo "$IMAGE (no registry digest)")"

if [ "$AI" = local ]; then
  if [ "$OLLAMA_MODE" = host ]; then
    if ollama_models | grep -qx "$LLM"; then say "Language model $LLM is already pulled"
    else
      say "Pulling the language model $LLM (first run only; several GB)"
      if has ollama; then ollama pull "$LLM" </dev/null
      else curl -fsS "$OLLAMA_API/api/pull" -d "{\"name\":\"$LLM\",\"stream\":false}" >/dev/null || die "couldn't pull $LLM from the Ollama server"; fi
    fi
  else
    say "Pulling the language model $LLM (first run only; several GB)"
    compose up -d ollama </dev/null
    for _ in $(seq 1 30); do compose exec -T ollama ollama list >/dev/null 2>&1 && break; sleep 1; done
    compose exec -T ollama ollama pull "$LLM" </dev/null
  fi
fi

# the database first: an existing volume keeps the password it was created with, so set it from .env
# before the app connects (idempotent; psql over the container's socket needs no password)
say "Starting the database"
compose up -d db </dev/null
for _ in $(seq 1 60); do compose exec -T db pg_isready -U reelsaw -d reelsaw >/dev/null 2>&1 && break; sleep 1; done
pw=$(envget POSTGRES_PASSWORD); pw=${pw//\'/\'\'}
if [ -n "$pw" ]; then
  compose exec -T db psql -U reelsaw -d reelsaw -q -v ON_ERROR_STOP=1 -c "alter user reelsaw password '$pw'" </dev/null >/dev/null 2>&1 \
    || warn "couldn't set the database password from .env; if the app logs 'password authentication failed', see the troubleshooting section of deploy/README.md"
fi

say "Starting Reelsaw"
compose up -d </dev/null

say "Waiting for the app${SPEACHES:+ (the first boot downloads the speech model)}"
for _ in $(seq 1 120); do
  if curl -fsS "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
    say "Reelsaw is running: http://localhost:$PORT"
    cat <<DONE

  Create your account, then set SIGNUP_MODE=closed (or approval) in $DIR/.env and restart.
  Models and providers can be changed later under Settings → System → Models, no restart needed.

  cd $DIR
  docker compose -p $PROJECT $(profiles) logs -f app   # logs
  docker compose -p $PROJECT $(profiles) pull && docker compose -p $PROJECT $(profiles) up -d   # upgrade
  docker compose -p $PROJECT $(profiles) down   # stop (data is kept in volumes)
DONE
    exit 0
  fi
  sleep 5
done
compose logs --tail 40 app
die "the app didn't come up within 10 minutes; the log above usually says why"
}

main "$@"
