---
"@reelsaw/server": minor
---

OpenCode is a model provider. Paste one OpenCode Console key under Settings → Models (or set `OPENCODE_API_KEY`) and the picker lists both plans as sections of one card: pay-per-token Zen models as `opencode:<model>` and, if the key has a Go subscription, Go models as `opencode-go:<model>`. The prefix records which plan pays. Reelsaw talks to OpenCode over Chat Completions, so the picker shows the paid chat models OpenCode itself lists as served natively on Chat Completions (Kimi, GLM, DeepSeek and others); models it serves on other APIs lose structured output in translation and are left out, decided from OpenCode's listing, not from model names. Go is meant for coding agents and caps any 5 hours at 20% of the month, so its section says so; Reelsaw sends Go its own user agent and one `x-opencode-session` per project, as OpenCode asks. Language models only: keep a transcription provider for speech. The same listing is in `list_models` and `reelsaw models --provider opencode`.

Structured output to OpenAI-compatible servers (the compat server, OpenCode) now asks for lenient JSON schemas like OpenAI already did, so models behind them no longer reject schemas with optional fields. A stage that times out now suggests the remedy that fits a cloud model too.
