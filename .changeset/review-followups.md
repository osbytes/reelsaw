---
"@reelsaw/server": patch
---
Follow-up fixes from review: a lost job no longer burns a retry when it was still running, uploads without a size reserve disk for the largest allowed file, a deleted project's late job is no longer reported as a failure, and the analysis step no longer times out on work that follows a finished step. Changing source text or caption style now tells you which clips were still rendering and need a re-render, cancelling uploads keeps projects that were already being created, and API keys without a permission record are no longer administrators (older keys were granted it explicitly, visible in Settings).
