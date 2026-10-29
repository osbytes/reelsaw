---
"@reelsaw/server": patch
---

The installers (`install.sh`, `install.ps1`) now find a database volume left by an earlier install under the same project name, keep its data and set its password from `.env` before the app starts, so a lost `.env` or a second install folder no longer leaves the app looping on `password authentication failed`. That boot error now says why and points at the fix. On a first boot the log now says that the speech-to-text model is being downloaded and that the app answers only afterwards, with a line every 20 seconds while it runs and the elapsed time when it is done.
