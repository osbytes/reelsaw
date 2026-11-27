---
"@reelsaw/server": minor
---

Admins now see when a model in use is being retired by its provider. The date shows under the model picker and on the model's row in Settings → System → Models, as a dot on the System tab, and as a chip in the top bar (red within 30 days). It is read from the providers' own model lists: OpenAI, Anthropic, the Vercel AI Gateway and OpenRouter publish dates; providers that don't are shown as "no dates published". `reelsaw models retirements`, `reelsaw version` and the new `check_model_retirements` MCP tool report the same.
