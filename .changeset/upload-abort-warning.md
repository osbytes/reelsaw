---
"@reelsaw/server": patch
---

An upload cut off by the browser or the network (a dropped connection, a closed tab) is now logged as a warning, "upload aborted by the client", instead of an error, so it no longer shows up as an error report.
