---
"@reelsaw/server": patch
---

Searching the library no longer calls Iconify (or other remote providers) with an empty query, which used to return an error as you started typing.
