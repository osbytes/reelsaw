---
"@reelsaw/server": patch
---

Clips are picked throughout the video instead of clustering in the first couple of minutes. Each map pass now looks at a short overlapping window, and a second pass only runs when the first picks leave a long uncovered stretch. Existing projects pick this up on re-analyze.
