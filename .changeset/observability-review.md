---
"@reelsaw/server": patch
---

Observability fixes from a review of Sentry, PostHog and Langfuse data:

- AI SDK calls are traced again. AI SDK 7 only emits spans through a registered integration, so `OTEL_ENABLED` had produced no model-call spans since the upgrade. `@ai-sdk/otel` is now registered at boot, and spans are named for the call (`invoke_agent analyze.map`) and carry model, tokens, finish reason and the project, stage, step and prompt-version ids. Prompts and answers are never recorded on a span, whatever a call site asks for.
- Langfuse generations carry their step's prompt version, and a user's decisions about the output (a clip deleted, restored, retimed or added; a fix accepted or rejected) become boolean scores on the project's session, for accounts with learning on.
- A failed model call's log line names the error class, HTTP status and provider error code, which stay readable when error reporting scrubs the message.
- A 4xx a handler throws (an MCP client asking for an unsupported protocol version) is a warn with its reason and the requested version, no longer an error report.
- A missing object on a cache probe (the shared transcription cache) logs at debug instead of warn.
- With `DB_POOL_MAX` unset, a worker sizes its Postgres pool to its job slots.
- Browser API spans are named for the endpoint (`GET /api/trpc/projects.get`), calls to other hosts are no longer traced, and DOM errors from browser page translation no longer reach Sentry.
- Transient download failures are reported as `DownloadFailedError` rather than a bare `Error`.
