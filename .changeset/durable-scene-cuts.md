---
"@reelsaw/server": patch
---
Shot cuts are saved the moment they are found and the on-screen text scan is its own resumable step, so a text-scan timeout no longer loses them. A failed shot-change decode now retries and, if it keeps failing, shows as a failed scenes step with its reason instead of being stored as "no cuts".
