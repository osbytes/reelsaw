---
"@reelsaw/server": minor
"@reelsaw/web": minor
---

New per-account limit `MAX_MANUAL_CLIPS_PER_USER`: how many clips an account may add from its own time ranges, deleted ones included (0 = unlimited, the default). Past it, `create_clip`, the editor and `reelsaw create-clip` explain the limit and offer the plan that lifts it. Quota refusals in the web now show their sentence next to the offer's button instead of repeating the link in the text.
