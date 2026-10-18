---
"@reelsaw/server": patch
---

A cut you made is always applied. When the seam check could not re-find the removed words in the audio (a sentence said twice, "seven" heard as "7"), the cut used to be dropped silently. It is now matched by its position in the audio instead of by text, with numbers, case and punctuation ignored, and if the seam still cannot be confirmed the cut is applied where you set it and marked "▲ cut unverified" on the clip card, in the editor's cuts tab and next to the cut in the transcript, with a notice in the activity feed. Automatic cuts that cannot be verified are still kept in the audio and reported.
