# Reelsaw installer for Windows (PowerShell 5.1+ or 7, Docker Desktop). Same behaviour as install.sh:
# the language model in Ollama (local) or at a hosted provider, speech-to-text in Speaches (local) or
# at the provider.
#
#   irm https://raw.githubusercontent.com/osbytes/reelsaw/main/deploy/install.ps1 | iex
#
# It looks at the machine (RAM, GPU, Docker's memory, free disk, a running Ollama and its models, the
# port), proposes a setup, asks three questions when run in a terminal (local or hosted, which model,
# go ahead), then writes ~\reelsaw (docker-compose.yml + .env with generated secrets), pulls the model,
# starts the stack and waits until it answers. Without a terminal or with REELSAW_YES=1 it takes the
# proposed answers. Re-running is safe and is how you update: the existing .env is kept, the newest
# image is pulled and the app restarts (data stays in Docker volumes).
#
# Answers in advance (environment variables, e.g. $env:REELSAW_AI = "openai"; each skips its question):
#   REELSAW_AI=local|openai|anthropic|google|groq|gateway   where the language model runs
#     local: Ollama (installed with winget if missing and you agree; otherwise a container). Hosted: the
#            provider's key is read from the usual variable (OPENAI_API_KEY, ANTHROPIC_API_KEY,
#            GOOGLE_GENERATIVE_AI_API_KEY, GROQ_API_KEY, AI_GATEWAY_API_KEY) or asked for, never echoed.
#            Anthropic and Google have no speech-to-text, so those pair with local Speaches.
#   REELSAW_LLM=<model>          local: Ollama model (default by VRAM/RAM, or a good one already pulled);
#                                hosted: provider:model, e.g. anthropic:claude-sonnet-4-5
#   REELSAW_WHISPER=<model>      Speaches model (default faster-whisper-small; medium/large-v3 on a GPU)
#   REELSAW_PORT=3000            port for the web app (a busy port moves to the next free one)
#   REELSAW_DIR=$HOME\reelsaw    where to install
#   REELSAW_IMAGE=ghcr.io/osbytes/reelsaw:latest
#   REELSAW_PROJECT=reelsaw      compose project name (containers/volumes prefix)
#   REELSAW_YES=1                no questions: take every proposed answer
#   REELSAW_DRY_RUN=1            print the plan and stop before changing anything

# everything runs inside functions, invoked on the last line: with `irm ... | iex` the whole script
# has been read by then, and `exit` is never used (it would close the user's terminal)
function Install-Reelsaw {
$ErrorActionPreference = 'Continue'   # native commands are checked through $LASTEXITCODE
function Opt($name, $default) { $v = [Environment]::GetEnvironmentVariable($name); if ($v) { $v } else { $default } }
$Dir     = Opt 'REELSAW_DIR' (Join-Path $HOME 'reelsaw')
$Image   = Opt 'REELSAW_IMAGE' 'ghcr.io/osbytes/reelsaw:latest'
$Port    = [int](Opt 'REELSAW_PORT' '3000')
$Project = Opt 'REELSAW_PROJECT' 'reelsaw'
$Yes     = [bool](Opt 'REELSAW_YES' '')
$Dry     = [bool](Opt 'REELSAW_DRY_RUN' '')

function Say($m)  { Write-Host '==> ' -NoNewline -ForegroundColor Cyan; Write-Host $m }
function Note($m) { Write-Host "    $m" }
function Warn($m) { Write-Host 'warning: ' -NoNewline -ForegroundColor Yellow; Write-Host $m }
function Die($m)  { throw [System.InvalidOperationException]::new($m) }
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

# ---- questions: only in a terminal and without REELSAW_YES; otherwise the default wins ----
$Interactive = (-not $Yes) -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected
function Ask($q, $d) {
  if (-not $Interactive) { return $d }
  Write-Host '? ' -NoNewline -ForegroundColor Cyan
  $v = Read-Host "$q [$d]"
  if ($v) { $v } else { $d }
}
function Confirm-Step($q, [bool]$d) {
  $v = if ($d) { Ask "$q (Y/n)" 'y' } else { Ask "$q (y/N)" 'n' }
  $v -match '^(y|yes)$'
}
# Choose "question" default @(@('value','label'), ...): a numbered menu, returns the value
function Choose($q, $d, $options) {
  if (-not $Interactive) { return $d }
  Write-Host '? ' -NoNewline -ForegroundColor Cyan; Write-Host $q
  $dn = 1
  for ($i = 0; $i -lt $options.Count; $i++) {
    if ($options[$i][0] -eq $d) { $dn = $i + 1 }
    Write-Host ("    {0}) {1}" -f ($i + 1), $options[$i][1])
  }
  $v = Read-Host "    choice [$dn]"
  if (-not $v) { $v = "$dn" }
  for ($i = 0; $i -lt $options.Count; $i++) {
    if ($v -eq "$($i + 1)" -or $v -eq $options[$i][0]) { return $options[$i][0] }
  }
  Warn "'$v' is not an option; using $d"
  $d
}
function Read-Secret($label) {
  Write-Host '? ' -NoNewline -ForegroundColor Cyan
  $s = Read-Host "$label (input hidden)" -AsSecureString
  $p = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($p) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }
}

# ---- prerequisites: Docker Desktop is the one thing this script does not install ----
if (-not (Has docker)) { Die 'Docker is required: https://docs.docker.com/desktop/setup/install/windows-install/ (then run this again)' }
if (-not (Ok { docker compose version })) { Die 'Docker Compose v2 is required (included with Docker Desktop)' }
if (-not (Ok { docker info })) { Die 'Docker is installed but not running: start Docker Desktop and run this again' }

# ---- the machine: RAM, Docker's memory, GPU, disk ----
$RamGb = 0
try { $RamGb = [math]::Floor((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB) } catch { }
$DockerGb = 0
try { $DockerGb = [math]::Floor([double](docker info --format '{{.MemTotal}}' 2>$null) / 1GB) } catch { }
# NVIDIA GPU: VRAM decides the model size; Docker Desktop's nvidia runtime decides whether containers see it.
# A native Ollama uses the GPU by itself.
$Vram = 0; $GpuName = ''; $NvidiaRuntime = $false
if (Has nvidia-smi) {
  try {
    $GpuName = (nvidia-smi --query-gpu=name --format=csv,noheader 2>$null | Select-Object -First 1).Trim()
    $Vram = [math]::Floor([double]((nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>$null | Select-Object -First 1).Trim()) / 1024)
  } catch { }
  $NvidiaRuntime = ((docker info --format '{{json .Runtimes}}' 2>$null) -match 'nvidia')
}
$DiskGb = 0; $Drive = $Dir
try {
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  $q = Split-Path -Qualifier $Dir -ErrorAction Stop
  $Drive = $q
  $DiskGb = [math]::Floor((Get-PSDrive ($q.TrimEnd(':')) -ErrorAction Stop).Free / 1GB)
} catch { }

# ---- an existing install answers for itself (re-run = update) ----
$EnvFile = Join-Path $Dir '.env'
function EnvGet($k) {
  if (-not (Test-Path $EnvFile)) { return '' }
  $line = Get-Content $EnvFile | Where-Object { $_ -match "^$k=" } | Select-Object -Last 1
  if ($line) { $line.Substring($k.Length + 1) } else { '' }
}
$Existing = Test-Path $EnvFile
if ($Existing) {
  $p = EnvGet 'PORT'; if ($p) { $Port = [int]$p }
  $pinned = EnvGet 'REELSAW_IMAGE'; if ($pinned) { $Image = $pinned }
}

# ---- Ollama on this host: running, installed, and which models are already pulled ----
$OllamaApi = 'http://localhost:11434'
function Ollama-Up { Url-Ok "$OllamaApi/api/tags" }
function Ollama-Models {
  try { @((Invoke-RestMethod -Uri "$OllamaApi/api/tags" -TimeoutSec 3).models | ForEach-Object { $_.name }) } catch { @() }
}
function Find-Ollama {   # the exe, even when PATH has not been refreshed since winget installed it
  if (Has ollama) { return (Get-Command ollama).Source }
  if ($env:LOCALAPPDATA) {
    $c = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
    if (Test-Path $c) { $env:Path = "$env:Path;$(Split-Path $c)"; return $c }
  }
  ''
}
function Start-HostOllama {
  Say 'Starting Ollama'
  $exe = Find-Ollama
  if (-not $exe) { Die 'Ollama is not installed; install it (https://ollama.com/download) and run this again' }
  $log = Join-Path $env:TEMP 'ollama.log'
  Start-Process -FilePath $exe -ArgumentList 'serve' -WindowStyle Hidden `
    -RedirectStandardOutput $log -RedirectStandardError "$log.err" | Out-Null
  for ($i = 0; $i -lt 30 -and -not (Ollama-Up); $i++) { Start-Sleep -Seconds 1 }
  if (-not (Ollama-Up)) { Die "Ollama didn't start; see $log" }
}

# ---- where should the language model run? ----
$CanLocal = ($Vram -ge 6) -or ($RamGb -ge 12)
$gpuText = if ($GpuName) { ", $GpuName ($Vram GB)" } else { '' }
Say "This machine: $RamGb GB RAM$gpuText, Docker gets $DockerGb GB, $DiskGb GB free on $Drive"
$Ai = Opt 'REELSAW_AI' ''
if ($Existing -and -not $Ai) {
  $Ai = switch -Wildcard (EnvGet 'AI_MODEL') {
    'compat:*' { 'local' } 'openai:*' { 'openai' } 'anthropic:*' { 'anthropic' } 'google:*' { 'google' } 'groq:*' { 'groq' } 'gateway:*' { 'gateway' } default { 'local' }
  }
  $AiWhy = "kept from $EnvFile"
} elseif ($Ai) {
  $AiWhy = 'from REELSAW_AI'
} else {
  if ($CanLocal) { $d = 'local'; $recLocal = ' (recommended here)'; $recHosted = '' }
  else { $d = 'openai'; $recLocal = ''; $recHosted = ' (recommended: with under 12 GB RAM a local model is weak)' }
  if (-not $Interactive) { $d = 'local' }   # unattended runs stay local: nothing leaves the machine and no key is needed
  $Ai = Choose 'Where should the language model run?' $d @(
    @('local',     "On this machine with Ollama: private, free, slower$recLocal"),
    @('openai',    "OpenAI (gpt-4o-mini + whisper-1): one key, fast, good quality$recHosted"),
    @('anthropic', 'Anthropic (claude-sonnet-4-5) for language, local Speaches for speech-to-text'),
    @('google',    'Google (gemini-2.5-flash) for language, local Speaches for speech-to-text'),
    @('groq',      'Groq (llama-3.3-70b + whisper-large-v3-turbo): one key, very fast'),
    @('gateway',   'Vercel AI Gateway (claude-sonnet-4-5 + whisper-1): one key for every vendor'))
  $AiWhy = if ($Interactive) { 'your choice' } else { 'default; REELSAW_AI picks another' }
}
if ($Ai -notin @('local', 'openai', 'anthropic', 'google', 'groq', 'gateway')) { Die "REELSAW_AI must be local, openai, anthropic, google, groq or gateway (got '$Ai')" }

# ---- hosted provider: model defaults and the key (asked for, never echoed; or from the environment) ----
$KeyVar = ''; $Key = ''; $ProviderStt = ''; $Llm = ''
if ($Ai -ne 'local') {
  switch ($Ai) {
    'openai'    { $KeyVar = 'OPENAI_API_KEY';               $LlmDefault = 'openai:gpt-4o-mini';                  $ProviderStt = 'openai:whisper-1' }
    'anthropic' { $KeyVar = 'ANTHROPIC_API_KEY';            $LlmDefault = 'anthropic:claude-sonnet-4-5' }
    'google'    { $KeyVar = 'GOOGLE_GENERATIVE_AI_API_KEY'; $LlmDefault = 'google:gemini-2.5-flash' }
    'groq'      { $KeyVar = 'GROQ_API_KEY';                 $LlmDefault = 'groq:llama-3.3-70b-versatile';        $ProviderStt = 'groq:whisper-large-v3-turbo' }
    'gateway'   { $KeyVar = 'AI_GATEWAY_API_KEY';           $LlmDefault = 'gateway:anthropic/claude-sonnet-4-5'; $ProviderStt = 'gateway:openai/whisper-1' }
  }
  if ($Existing) {
    $Llm = Opt 'REELSAW_LLM' (EnvGet 'AI_MODEL')
    $Key = EnvGet $KeyVar
  } else {
    $Llm = Opt 'REELSAW_LLM' $LlmDefault
    if (-not $Llm.StartsWith("${Ai}:")) { Die "REELSAW_LLM must start with '${Ai}:' for REELSAW_AI=$Ai (got '$Llm')" }
    $Key = Opt $KeyVar ''
    if (-not $Key) {
      if (-not $Interactive) { Die "set $KeyVar in the environment for REELSAW_AI=$Ai (or run in a terminal to be asked)" }
      while (-not $Key) { $Key = Read-Secret $KeyVar }
    }
  }
}

# ---- local: Ollama placement, GPU, model ----
# host = Ollama runs on Windows (uses the GPU by itself); container = the ollama service in the compose
# file (GPU only when Docker Desktop exposes the nvidia runtime).
$OllamaMode = ''; $OllamaInstall = ''; $OllamaUrl = ''; $GpuCompose = $false; $LlmWhy = ''
if ($Ai -eq 'local') {
  if ($Existing) {
    $OllamaMode = if ((EnvGet 'OPENAI_COMPATIBLE_BASE_URL') -match 'ollama:11434') { 'container' } else { 'host' }
  } elseif (Ollama-Up) { $OllamaMode = 'host' }
  elseif (Find-Ollama) { $OllamaMode = 'host' }
  elseif ((Has winget) -and ($Interactive -or $Yes) -and (Confirm-Step 'Ollama is not installed. Install it with winget (Ollama.Ollama)?' $true)) {
    # installing software needs a yes: at the prompt, or REELSAW_YES; a run with neither stays with containers
    $OllamaInstall = 'winget'; $OllamaMode = 'host'
  } else {
    if ($Vram -gt 0 -and -not $NvidiaRuntime) { Warn 'Ollama will run in a container on the CPU; install Ollama for Windows (https://ollama.com/download) and re-run to use the GPU' }
    $OllamaMode = 'container'
  }
  if ($OllamaMode -eq 'container' -and $NvidiaRuntime) { $GpuCompose = $true }
  $OllamaUrl = if ($OllamaMode -eq 'host') { 'http://host.docker.internal:11434/v1' } else { 'http://ollama:11434/v1' }

  # memory the model can use: VRAM when a GPU serves it, RAM for a native Ollama, Docker's share for the container
  $MemIsVram = $false
  if ($OllamaMode -eq 'host' -and $Vram -gt 0) { $Mem = $Vram; $MemWhat = "$Vram GB VRAM"; $MemIsVram = $true }
  elseif ($OllamaMode -eq 'container' -and $GpuCompose) { $Mem = $Vram; $MemWhat = "$Vram GB VRAM"; $MemIsVram = $true }
  elseif ($OllamaMode -eq 'container' -and $DockerGb -gt 0 -and $DockerGb -lt $RamGb) { $Mem = $DockerGb; $MemWhat = "$DockerGb GB for Docker (of $RamGb GB RAM)" }
  else { $Mem = $RamGb; $MemWhat = "$RamGb GB RAM" }
  # the GPU rule is about fitting the whole model in VRAM; the RAM rule leaves room for the app and OS
  $Rec = if ($MemIsVram) { if ($Mem -ge 12) { 'qwen2.5:14b' } elseif ($Mem -ge 6) { 'qwen2.5:7b' } else { 'gemma3:4b' } }
         else            { if ($Mem -ge 24) { 'qwen2.5:14b' } elseif ($Mem -ge 12) { 'qwen2.5:7b' } else { 'gemma3:4b' } }

  # a good model that is already pulled beats a 9 GB download, when it fits
  $Pulled = @(); if ($OllamaMode -eq 'host' -and (Ollama-Up)) { $Pulled = Ollama-Models }
  function Fits($m) {
    if ($m -match ':(14b|13b|12b)$') { return $Mem -ge 12 }
    if ($m -match ':(8b|7b)$') { return $Mem -ge 6 }
    $true
  }
  $Known = @('qwen2.5:14b', 'gemma3:12b', 'llama3.1:8b', 'qwen2.5:7b', 'gemma3:4b')
  $Sizes = @{ 'qwen2.5:14b' = '9 GB, best quality'; 'gemma3:12b' = '8 GB, close second'; 'llama3.1:8b' = '5 GB, good'; 'qwen2.5:7b' = '5 GB, good'; 'gemma3:4b' = '3 GB, basic' }
  $BestPulled = ''
  foreach ($m in $Known) { if ($Pulled -contains $m -and (Fits $m)) { $BestPulled = $m; break } }

  if (Opt 'REELSAW_LLM' '') { $Llm = Opt 'REELSAW_LLM' ''; $LlmWhy = 'from REELSAW_LLM' }
  elseif ($Existing -and (EnvGet 'AI_MODEL')) { $Llm = (EnvGet 'AI_MODEL') -replace '^compat:', ''; $LlmWhy = "kept from $EnvFile" }
  else {
    $d = if ($BestPulled) { $BestPulled } else { $Rec }
    $recPulled = if ($Pulled -contains $Rec) { ', already pulled' } else { '' }
    $opts = @(, @($Rec, "${Rec}: recommended for $MemWhat$recPulled"))
    if ($BestPulled -and $BestPulled -ne $Rec) { $opts = @(, @($BestPulled, "${BestPulled}: already pulled, no download")) + $opts }
    foreach ($m in $Known) {
      if ($m -eq $Rec -or $m -eq $BestPulled) { continue }
      $extra = ''
      if ($Pulled -contains $m) { $extra += ', pulled' }
      if (-not (Fits $m)) { $extra += ", too big for $MemWhat" }
      $opts += , @($m, "${m}: $($Sizes[$m])$extra")
    }
    $opts += , @('other', 'Another Ollama model (typed)')
    $Llm = Choose 'Which language model?' $d $opts
    if ($Llm -eq 'other') { $Llm = Ask 'Ollama model name (see https://ollama.com/library)' $Rec }
    $LlmWhy = if ($Interactive) { 'your choice' } else { "detected $MemWhat" + $(if ($BestPulled) { ', already pulled' } else { '' }) }
  }
}

# ---- speech-to-text: Speaches unless the hosted provider has it ----
$Speaches = $false; $SpeachesImage = 'ghcr.io/speaches-ai/speaches:latest-cpu'; $Whisper = Opt 'REELSAW_WHISPER' ''
if (-not $ProviderStt) {
  $Speaches = $true
  if ($Existing -and -not $Whisper) { $Whisper = EnvGet 'WHISPER_MODEL' }
  if ($NvidiaRuntime) {
    $SpeachesImage = 'ghcr.io/speaches-ai/speaches:latest-cuda'; $GpuCompose = $true
    if (-not $Whisper) { $Whisper = if ($Vram -ge 16) { 'Systran/faster-whisper-large-v3' } else { 'Systran/faster-whisper-medium' } }
  }
  if (-not $Whisper) { $Whisper = 'Systran/faster-whisper-small' }
  $Stt = "openai:$Whisper"; $SttWhere = if ($NvidiaRuntime) { 'Speaches on the GPU' } else { 'Speaches' }
} else {
  $Stt = $ProviderStt; $SttWhere = $Ai
}

# ---- port: an existing install owns its port; otherwise a busy one moves to the next free ----
function Port-Busy($p) {
  $c = New-Object Net.Sockets.TcpClient
  try { $r = $c.BeginConnect('127.0.0.1', $p, $null, $null); $ok = $r.AsyncWaitHandle.WaitOne(300) -and $c.Connected; $ok } catch { $false } finally { $c.Close() }
}
$PortWhy = ''
if (-not $Existing -and (Port-Busy $Port)) {
  if (Url-Ok "http://localhost:$Port/api/health") { Warn "something already answers like Reelsaw on port $Port; this install will use another port (set REELSAW_DIR to update that one instead)" }
  $orig = $Port
  while (Port-Busy $Port) { $Port++; if ($Port -gt $orig + 50) { Die "no free port between $orig and $Port" } }
  $PortWhy = " (port $orig is in use)"
}

# ---- disk and memory sanity, before anything is downloaded ----
$Need = 10
if ($Ai -eq 'local') { $Need += $(if ($Llm -match ':(14b|13b|12b)$') { 10 } elseif ($Llm -match ':(8b|7b)$') { 6 } else { 4 }) }
if ($Speaches) { if ($Whisper -match 'large') { $Need += 3 } elseif ($Whisper -match 'medium') { $Need += 2 } }
if (-not $Existing -and $DiskGb -gt 0 -and $DiskGb -lt $Need) {
  Die "about $Need GB of free disk are needed (images, the models, your videos); $Drive has $DiskGb GB. Free some space or set REELSAW_DIR to another drive"
}
if ($DockerGb -gt 0 -and $DockerGb -lt 4) {
  Warn "Docker Desktop is limited to $DockerGb GB of memory; the app, Postgres and Speaches share it. Raise it under Settings -> Resources (or .wslconfig) to 6 GB or more if clips fail or renders crawl"
}

# ---- the plan ----
$Profiles = @()
if ($Speaches) { $Profiles += @('--profile', 'local-ai') }
if ($OllamaMode -eq 'container') { $Profiles += @('--profile', 'ollama') }
$ProfilesText = $Profiles -join ' '
$ProfilesCsv = (($Profiles | Where-Object { $_ -ne '--profile' }) -join ',')
function Compose { docker compose -p $Project @Profiles @args }

Say 'Plan'
if ($Existing) { Note "Update the install in $Dir (its .env is kept; delete it to start over)" } else { Note "Install into $Dir" }
Note "Image: $Image"
if ($Ai -eq 'local') {
  Note "Language model: $Llm in Ollama ($LlmWhy)"
  if ($OllamaInstall -eq 'winget') { Note 'Ollama: install with winget, run natively' }
  elseif ($OllamaMode -eq 'host') { Note ("Ollama: the one on this machine" + $(if ($GpuName) { " ($GpuName)" } else { '' })) }
  else { Note ("Ollama: in a container " + $(if ($GpuCompose) { "with the GPU ($GpuName)" } else { 'on the CPU' })) }
} else {
  Note "Language model: $Llm at $Ai ($AiWhy; key: $KeyVar, stored in $EnvFile)"
}
Note "Speech-to-text: $Stt via $SttWhere"
Note "Web app: http://localhost:$Port$PortWhy"
if ($Dry) { Say 'Dry run: stopping here (REELSAW_DRY_RUN)'; return }
if (-not (Confirm-Step 'Go ahead?' $true)) { Die 'stopped; nothing was changed' }

# ---- Ollama: install and start ----
if ($OllamaInstall -eq 'winget') {
  Say 'Installing Ollama with winget'
  winget install --id Ollama.Ollama --exact --accept-source-agreements --accept-package-agreements
  if ($LASTEXITCODE -ne 0 -and -not (Find-Ollama)) { Die 'winget install Ollama.Ollama failed' }
}
if ($OllamaMode -eq 'host' -and -not (Ollama-Up)) { Start-HostOllama }

Say "Installing into $Dir"
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
Push-Location $Dir
try {

$composeYaml = @'
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
'@
Write-Lf 'docker-compose.yml' $composeYaml

# the GPU reservation lives in an override file that .env's COMPOSE_FILE pulls in (";" separates paths
# on Windows), so the base file is the same everywhere and `docker compose` in this folder keeps working
if ($GpuCompose) {
  Write-Lf 'docker-compose.gpu.yml' @'
# NVIDIA GPU for Ollama, Speaches and the app's ffmpeg (written by install.ps1; needs Docker Desktop's
# nvidia runtime). `video` is the NVENC capability: FFMPEG_ENCODER=auto then encodes clips with h264_nvenc.
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
'@
}

if ($Existing) {
  Say 'Keeping the existing .env (delete it to regenerate)'
} else {
  $lines = @(
    '# Generated by install.ps1. Restart after changes: docker compose up -d (in this folder)',
    "COMPOSE_PROJECT_NAME=$Project",
    "COMPOSE_PROFILES=$ProfilesCsv",
    "BETTER_AUTH_SECRET=$(Rand 48)",
    "POSTGRES_PASSWORD=$(Rand 24)",
    "APP_URL=http://localhost:$Port",
    "PORT=$Port",
    "REELSAW_IMAGE=$Image",
    'SIGNUP_MODE=open')
  if ($GpuCompose) { $lines += 'COMPOSE_FILE=docker-compose.yml;docker-compose.gpu.yml' }
  $lines += ''
  if ($Ai -eq 'local') {
    $lines += @("# language model: Ollama ($OllamaMode)", "AI_MODEL=compat:$Llm", "OPENAI_COMPATIBLE_BASE_URL=$OllamaUrl", 'OPENAI_COMPATIBLE_API_KEY=ollama')
  } else {
    $lines += @("# language model: $Ai", "AI_MODEL=$Llm", "$KeyVar=$Key")
  }
  $lines += ''
  if ($Speaches) {
    $lines += @('# speech-to-text: Speaches (OpenAI-compatible audio API)', "TRANSCRIPTION_MODEL=$Stt", "WHISPER_MODEL=$Whisper", "SPEACHES_IMAGE=$SpeachesImage", 'OPENAI_BASE_URL=http://speaches:8000/v1', 'OPENAI_API_KEY=local')
  } else {
    $lines += @("# speech-to-text: $Ai", "TRANSCRIPTION_MODEL=$Stt")
  }
  $lines += @('', '# model calls go to the log so "Report an issue" can include them (prompts contain transcript text)', 'LLM_TRACE=logs')
  Write-Lf '.env' (($lines -join "`n") + "`n")
}

Say 'Pulling images (first run downloads a few GB)'
Compose pull --quiet --ignore-pull-failures 2>&1 | Out-Null
if (-not (Ok { docker image inspect $Image })) { Die "couldn't pull ${Image}: check the name, or 'docker login ghcr.io' if the image is private" }

if ($Ai -eq 'local') {
  if ($OllamaMode -eq 'host') {
    if ((Ollama-Models) -contains $Llm) { Say "Language model $Llm is already pulled" }
    else {
      Say "Pulling the language model $Llm (first run only; several GB)"
      $exe = Find-Ollama
      if ($exe) {
        & $exe pull $Llm
        if ($LASTEXITCODE -ne 0) { Die "couldn't pull $Llm with ollama" }
      } else {
        try {
          $null = Invoke-RestMethod -Method Post -Uri "$OllamaApi/api/pull" -ContentType 'application/json' `
            -Body (@{ name = $Llm; stream = $false } | ConvertTo-Json) -TimeoutSec 7200
        } catch { Die "couldn't pull $Llm from the Ollama server" }
      }
    }
  } else {
    Say "Pulling the language model $Llm (first run only; several GB)"
    Compose up -d ollama
    for ($i = 0; $i -lt 30 -and -not (Ok { Compose exec -T ollama ollama list }); $i++) { Start-Sleep -Seconds 1 }
    Compose exec -T ollama ollama pull $Llm
    if ($LASTEXITCODE -ne 0) { Die "couldn't pull $Llm in the Ollama container" }
  }
}

Say 'Starting Reelsaw'
Compose up -d
if ($LASTEXITCODE -ne 0) { Die 'docker compose up failed; the output above says why' }

Say ('Waiting for the app' + $(if ($Speaches) { ' (the first boot downloads the speech model)' } else { '' }))
for ($i = 0; $i -lt 120; $i++) {
  if (Url-Ok "http://localhost:$Port/api/health") {
    Say "Reelsaw is running: http://localhost:$Port"
    Write-Host @"

  Create your account, then set SIGNUP_MODE=closed (or approval) in $Dir\.env and restart.
  Models and providers can be changed later under Settings -> System -> Models, no restart needed.

  cd $Dir
  docker compose -p $Project $ProfilesText logs -f app   # logs
  docker compose -p $Project $ProfilesText pull; docker compose -p $Project $ProfilesText up -d   # upgrade
  docker compose -p $Project $ProfilesText down   # stop (data is kept in volumes)
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
