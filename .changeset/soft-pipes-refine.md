---
"@reelsaw/server": minor
---

Refine after transcription (name fixes, filler removal, the filler model pass, and scene cuts) is opt-in: turn steps on per project or in Project defaults, with instance ceilings under Settings → System → Pipeline.

**Upgrade:** `TRANSCRIPT_CORRECTION`, `DISFLUENCY_REMOVAL`, `DISFLUENCY_LLM` and `REFINE_SCENES` now default to off (was on). New projects skip refine unless you open those gates and opt the project in. To keep the old behaviour, set them to `true` in `.env` or Settings → System → Pipeline, and turn the matching toggles on in Project defaults.
