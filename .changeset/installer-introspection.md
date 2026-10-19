---
"@reelsaw/server": minor
---

The one-command installers (`install.sh`, `install.ps1`) now look at the machine before doing anything: RAM, an NVIDIA GPU and its VRAM, Docker's memory, free disk, an Ollama already running and the models it has, and the port. They print a plan and ask three questions (local Ollama or a hosted provider, which model, go ahead), install Ollama when it is missing and you chose local, reuse a good model Ollama already has, pick the model by VRAM when a GPU serves it, move a busy port, and put Ollama, Speaches and the app on the GPU when the NVIDIA Container Toolkit is present. Hosted providers (OpenAI, Anthropic, Google, Groq, Vercel AI Gateway) are a choice in the same prompt. `REELSAW_YES=1` takes the proposed answers, `REELSAW_DRY_RUN=1` prints the plan and stops; re-running upgrades an existing install.
