---
"@reelsaw/server": patch
---

The container gives the app a writable home directory. It used to keep root's, which the app's user cannot write, so every ffmpeg run that drew captions printed a "Fontconfig error: No writable cache directories" line per font lookup, filling the start of render error messages and hiding the real cause, and yt-dlp could not keep its cache between downloads.
