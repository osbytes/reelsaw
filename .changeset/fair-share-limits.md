---
"@reelsaw/server": patch
"@reelsaw/web": patch
---
Jobs are served fairly between accounts (someone with nothing in flight goes ahead of another account's backlog), model calls are capped per provider across all processes (`PROVIDER_CONCURRENCY`, self-hosted default 2), new per-user limits `MAX_LIVE_JOBS_PER_USER`, `MAX_RERENDERS_PER_HOUR` and `MAX_STORAGE_MB`, and usage now shows reported LLM cost, minutes transcribed and rendered-clip storage (`reelsaw usage`, `reelsaw limits <email>`).

**Upgrade:** migration adds `llm_usage.cost_usd`, `clips.output_bytes` and the `stt_usage` table; the new limits default to 0 (unlimited), so a single-operator install behaves as before. Jobs already queued carry no owner and are not counted toward the new limits. A self-hosted model now serves at most 2 calls at once across all workers unless `PROVIDER_CONCURRENCY` says otherwise.
