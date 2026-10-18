---
"@reelsaw/server": minor
---

Bound background work and growth: progress ticks are persisted at most once per 10 s and removed when a stage completes; `EVENT_RETENTION_DAYS` (90), `LLM_USAGE_RETENTION_DAYS` (180) and `ADMIN_EVENT_RETENTION_DAYS` (365) prune old rows daily in batches; deleted fixes beyond 200 are archived instead of dropped; clip diagnostics are capped; transcript edits write only the columns that changed; the storage sweep looks up directories 1,000 at a time with bounded parallel `stat` and resumes from a cursor after a time budget; retention and the library purge use keyset batches; job lookups use `singleton_key`. Adds migration `0028_event_pruning`.
