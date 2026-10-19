---
"@reelsaw/server": patch
---

Link downloads now report progress ("Downloading 42% of 1.57GiB at 5.00MiB/s"): yt-dlp's `--print-json` silenced its progress lines, and they were read from the wrong stream. "Download finished in …" shows the download's wall clock instead of the video's length, and processing-time estimates no longer learn from the bad ingest samples.
