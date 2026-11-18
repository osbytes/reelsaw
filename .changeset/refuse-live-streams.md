---
"@reelsaw/server": patch
---

Links to a live stream, or a stream that has not started yet, are now refused with a message saying to add the link again once the recording is up. Before, ingest recorded the stream through the download proxy until the stream ended, which could take hours and use up proxy traffic. The project sat in ingest with no progress. The recording of a stream that has ended downloads as before. Accounts with a minutes limit see the refusal as soon as they check the link or create the project (check_source, the New project form). Every other account sees it when ingest starts, before anything is downloaded.
