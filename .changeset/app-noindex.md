---
"@reelsaw/server": patch
---

The app now asks search engines not to index it (`<meta name="robots" content="noindex">`) and serves a `robots.txt` instead of a 404. Its pages are sign-in screens and private workspaces, so search results should point to the website, and this applies to self-hosted installs too. App links pasted into chat now get a title and description preview.
