# Reelsaw, fully local on Windows: Ollama for the language model, Speaches (faster-whisper) for
# speech-to-text. PowerShell 5.1+ or 7, Docker Desktop. Same behaviour as install.sh.
#
#   irm <this script's raw URL> | iex
#
# Creates ~\reelsaw (docker-compose.yml + .env with generated secrets), pulls the model, starts the
# stack and waits until it answers. Re-running is safe and is how you update: the existing .env is
# kept, the newest image is pulled and the app restarts (data stays in Docker volumes).
#
# Options (environment variables, set before running, e.g. $env:REELSAW_LLM = "qwen2.5:7b"):
#   REELSAW_DIR=$HOME\reelsaw                     where to install
#   REELSAW_IMAGE=ghcr.io/osbytes/reelsaw:latest  image to run
#   REELSAW_LLM=qwen2.5:14b                       Ollama model (~9 GB; qwen2.5:7b or gemma3:4b for less RAM)
#   REELSAW_WHISPER=Systran/faster-whisper-small  speech-to-text model (downloaded on first boot)
#   REELSAW_PORT=3000                             port for the web app
#   REELSAW_PROJECT=reelsaw                       compose project name (containers/volumes prefix)

# everything runs inside functions, invoked on the last line: with `irm ... | iex` the whole script
# has been read by then, and `exit` is never used (it would close the user's terminal)
function Install-Reelsaw {
$ErrorActionPreference = 'Continue'   # native commands are checked through $LASTEXITCODE
function Opt($name, $default) { $v = [Environment]::GetEnvironmentVariable($name); if ($v) { $v } else { $default } }
$Dir     = Opt 'REELSAW_DIR' (Join-Path $HOME 'reelsaw')
$Image   = Opt 'REELSAW_IMAGE' 'ghcr.io/osbytes/reelsaw:latest'
$Llm     = Opt 'REELSAW_LLM' 'qwen2.5:14b'
$Whisper = Opt 'REELSAW_WHISPER' 'Systran/faster-whisper-small'
$Port    = Opt 'REELSAW_PORT' '3000'
$Project = Opt 'REELSAW_PROJECT' 'reelsaw'

function Say($m) { Write-Host '==> ' -NoNewline -ForegroundColor Cyan; Write-Host $m }
function Die($m) { throw [System.InvalidOperationException]::new($m) }
function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Ok { param([scriptblock]$Run) try { & $Run *>$null; $LASTEXITCODE -eq 0 } catch { $false } }
function Url-Ok($url) { try { $null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri $url; $true } catch { $false } }
function Write-Lf($path, $text) {   # LF line endings, UTF-8 without BOM: what the containers expect
  $full = Join-Path (Get-Location).Path $path
  [IO.File]::WriteAllText($full, ($text -replace "`r`n", "`n"), (New-Object Text.UTF8Encoding($false)))
}
function Rand($n) {
  $chars = [char[]](48..57 + 65..90 + 97..122)
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  $out = ''
  $b = New-Object byte[] 1
  while ($out.Length -lt $n) { $rng.GetBytes($b); if ($b[0] -lt 248) { $out += $chars[$b[0] % 62] } }
  $out
}

if (-not (Has docker)) { Die 'Docker is required: https://docs.docker.com/desktop/setup/install/windows-install/' }
if (-not (Ok { docker compose version })) { Die 'Docker Compose v2 is required (included with Docker Desktop)' }
if (-not (Ok { docker info })) { Die 'Docker is installed but not running: start Docker Desktop and run this again' }

# ---- Ollama: native on Windows if present, otherwise in a container (like Linux) ----
$Profiles = @('--profile', 'local-ai')
$ollamaApi = 'http://localhost:11434/api/tags'
if (Url-Ok $ollamaApi) {
  $OllamaMode = 'host'
} elseif (Has ollama) {
  Say 'Starting Ollama'
  $log = Join-Path $env:TEMP 'ollama.log'
  Start-Process -FilePath (Get-Command ollama).Source -ArgumentList 'serve' -WindowStyle Hidden `
    -RedirectStandardOutput $log -RedirectStandardError "$log.err" | Out-Null
  for ($i = 0; $i -lt 30 -and -not (Url-Ok $ollamaApi); $i++) { Start-Sleep -Seconds 1 }
  if (-not (Url-Ok $ollamaApi)) { Die "Ollama didn't start; see $log" }
  $OllamaMode = 'host'
} else {
  $OllamaMode = 'container'
  $Profiles += @('--profile', 'ollama')
}
if ($OllamaMode -eq 'host') { $OllamaUrl = 'http://host.docker.internal:11434/v1' } else { $OllamaUrl = 'http://ollama:11434/v1' }

Say "Installing into $Dir"
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
Push-Location $Dir
try {

$composeYaml = @'
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
'@
Write-Lf 'docker-compose.yml' $composeYaml

if (Test-Path '.env') {
  Say 'Keeping the existing .env (delete it to regenerate)'
  # an existing install may pin a version: use the image it runs
  $pinned = Get-Content '.env' | Where-Object { $_ -match '^REELSAW_IMAGE=' } | Select-Object -Last 1
  if ($pinned) { $Image = $pinned -replace '^REELSAW_IMAGE=', '' }
} else {
  $envText = @"
# Generated by install.sh. Restart after changes: docker compose --profile local-ai up -d
BETTER_AUTH_SECRET=$(Rand 48)
POSTGRES_PASSWORD=$(Rand 24)
APP_URL=http://localhost:$Port
PORT=$Port
REELSAW_IMAGE=$Image
ALLOW_SIGNUP=true

# language model: Ollama ($OllamaMode)
AI_MODEL=compat:$Llm
OPENAI_COMPATIBLE_BASE_URL=$OllamaUrl
OPENAI_COMPATIBLE_API_KEY=ollama

# speech-to-text: Speaches (OpenAI-compatible audio API)
TRANSCRIPTION_MODEL=openai:$Whisper
WHISPER_MODEL=$Whisper
OPENAI_BASE_URL=http://speaches:8000/v1
OPENAI_API_KEY=local

# model calls go to the log so "Report an issue" can include them (prompts contain transcript text)
LLM_TRACE=logs
"@
  Write-Lf '.env' ($envText + "`n")
}

function Compose { docker compose -p $Project @Profiles @args }

Say 'Pulling images (first run downloads a few GB)'
Compose pull --quiet --ignore-pull-failures 2>&1 | Out-Null
if (-not (Ok { docker image inspect $Image })) { Die "couldn't pull ${Image}: check the name, or 'docker login ghcr.io' if the image is private" }

Say "Pulling the language model $Llm (first run only; several GB)"
if ($OllamaMode -eq 'host') {
  if (Has ollama) {
    ollama pull $Llm
    if ($LASTEXITCODE -ne 0) { Die "couldn't pull $Llm with ollama" }
  } else {
    try {
      $null = Invoke-RestMethod -Method Post -Uri 'http://localhost:11434/api/pull' -ContentType 'application/json' `
        -Body (@{ name = $Llm; stream = $false } | ConvertTo-Json) -TimeoutSec 7200
    } catch { Die "couldn't pull $Llm from the Ollama server" }
  }
} else {
  Compose up -d ollama
  for ($i = 0; $i -lt 30 -and -not (Ok { Compose exec -T ollama ollama list }); $i++) { Start-Sleep -Seconds 1 }
  Compose exec -T ollama ollama pull $Llm
  if ($LASTEXITCODE -ne 0) { Die "couldn't pull $Llm in the Ollama container" }
}

Say 'Starting Reelsaw'
Compose up -d
if ($LASTEXITCODE -ne 0) { Die 'docker compose up failed; the output above says why' }

Say 'Waiting for the app (the first boot downloads the speech model)'
$p = $Profiles -join ' '
for ($i = 0; $i -lt 120; $i++) {
  if (Url-Ok "http://localhost:$Port/api/health") {
    Say "Reelsaw is running: http://localhost:$Port"
    Write-Host @"

  Create your account, then set ALLOW_SIGNUP=false in $Dir\.env and restart.

  cd $Dir
  docker compose -p $Project $p logs -f app   # logs
  docker compose -p $Project $p pull; docker compose -p $Project $p up -d   # upgrade
  docker compose -p $Project $p down   # stop (data is kept in volumes)
"@
    return
  }
  Start-Sleep -Seconds 5
}
Compose logs --tail 40 app
Die "the app didn't come up within 10 minutes; the log above usually says why"

} finally { Pop-Location }
}

try { Install-Reelsaw } catch {
  Write-Host 'error: ' -NoNewline -ForegroundColor Red; Write-Host $_.Exception.Message
  $global:LASTEXITCODE = 1
}
