---
"@reelsaw/server": patch
---

Browser traces name uploads correctly. An upload used to show up as `GET /api/upload`, or as a bare `POST` when the connection dropped partway. It is now `POST /api/upload` either way, so failed uploads group together with the ones that finished.
