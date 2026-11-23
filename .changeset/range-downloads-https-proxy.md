---
"@reelsaw/server": patch
---

Projects with ranges (and Most replayed peaks) download again behind an `https://` download proxy: the parts of the video are now fetched through the same proxy as the rest of the download instead of straight from the server, which the site refused. When no configured proxy can fetch parts of a video, the project says so instead of "the site blocked the download".
