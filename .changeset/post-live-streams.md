---
"@reelsaw/server": patch
---

A link to a stream that has just ended is refused instead of downloading for hours. YouTube lists such a stream as still being processed (`post_live`) and reports no length for it, so the live-stream refusal let it through and the minutes limit could not be checked before the download. Its recording then came down fragment by fragment, a day-long stream in hours, while holding an ingest slot. It is now refused like a live stream, with a message to add it again once the recording is up.

A download whose size is not known up front (a fragmented recording) is stopped once what has arrived passes `MAX_SOURCE_FILE_MB`. `--max-filesize` only refuses a size yt-dlp knows before it starts.
