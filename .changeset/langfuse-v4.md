---
"@reelsaw/server": patch
---

`LLM_TRACE=langfuse` sends traces again: Langfuse Cloud stopped accepting traces from the old SDK, so model calls and decision scores now go through Langfuse's current OpenTelemetry SDK. A self-hosted Langfuse needs version 4.59.0 or later.
