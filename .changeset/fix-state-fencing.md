---
"@reelsaw/server": patch
---
Fixes several races that could leave a project stuck or out of date: re-analyze no longer overwrites a settings change made at the same time, Retry after a failed re-analyze picks clips again, deleting the last clip of a rendering project finishes it, and a rename during the download survives. Refining a busy project is refused instead of overwriting its status.
