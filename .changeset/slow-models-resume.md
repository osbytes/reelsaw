---
"@reelsaw/server": patch
---
Long videos on slow local models no longer fail after 30 minutes: finding moments now saves each part of the transcript as it finishes, so Retry (and any automatic retry) continues where it stopped instead of starting over, and the project page shows "13 of 43 parts, about 1 h left". A timeout now says how far it got and what to do, and two new settings, `LLM_CALL_TIMEOUT_SECONDS` and `STAGE_IDLE_TIMEOUT_MINUTES`, set how long a model call and a stage without progress may take.
