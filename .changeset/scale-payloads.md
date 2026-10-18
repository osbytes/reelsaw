---
"@reelsaw/server": minor
---

Large projects open and stay fast. The project page no longer re-downloads the whole transcript on every event: the project and its transcript load separately, and each event refreshes only what it changed. The Activity panel replays the last 300 events (configurable with `EVENT_REPLAY_LIMIT`) and shows "Showing the last 300 of N", with a "Load older" button. The command palette (⌘K) now searches on the server as you type (typo-tolerant, best matches first), so it finds every project and clip however many you have, and the MCP server gains `search_clips`. `get_project` returns only a transcript summary; use `get_transcript` for the text. Adds the `pg_trgm` extension and search indexes (migration 0028).
