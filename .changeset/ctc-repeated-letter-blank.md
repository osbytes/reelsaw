---
"@reelsaw/server": patch
---

CTC forced alignment no longer treats adjacent repeated letters without a blank as a valid path, so words like "hello" get legal letter spans at cut seams.
