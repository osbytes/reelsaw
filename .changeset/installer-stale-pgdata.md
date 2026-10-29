---
"@reelsaw/server": patch
---

The installers (`install.sh`, `install.ps1`) now find a database volume left by an earlier install under the same project name, keep its data and set its password from `.env` before the app starts, so a lost `.env` or a second install folder no longer leaves the app looping on `password authentication failed`. That boot error now says why and points at the fix.
