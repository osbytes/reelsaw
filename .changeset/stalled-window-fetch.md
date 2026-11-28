---
"@reelsaw/server": patch
---

A full-quality video download that stops making progress during a render is now stopped after 5 minutes and tried again. It used to hold the clip, and the rest of the project's clips waiting behind it, for up to an hour.
