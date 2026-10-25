---
"@reelsaw/server": patch
---

`YTDLP_PROXY` URLs may include `{session}`, replaced with a fresh id on every yt-dlp download so a residential gateway can pin that process to one IP and give the next video a different one. Ingest also passes `--js-runtimes node` (YouTube JS challenges) the same way eval already did.
