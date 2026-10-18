---
"@reelsaw/server": patch
---

Escape the caption file path correctly for ffmpeg, so renders work when the data directory contains a colon, quote or backslash. YouTube links are only recognised on youtube.com and its subdomains, and a vulnerable esbuild pulled in by drizzle-kit is overridden.
