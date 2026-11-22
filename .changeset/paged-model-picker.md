---
"@reelsaw/server": patch
---

The Settings → Models picker no longer lags when you click a provider. A self-hosted Speaches server lists hundreds of downloadable models, and the picker used to draw all of them at once; it now shows the first 50 per provider, loads more as you scroll ("Showing 50 of 729"), and searches every provider on the server as you type. The models in use always come first. The same listing is the new MCP tool `list_models` and the `reelsaw models` command.
