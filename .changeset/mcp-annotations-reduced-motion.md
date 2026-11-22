---
"@reelsaw/server": patch
---

Every MCP tool now tells clients whether it only reads, adds something, or can replace or remove data. 23 tools had no annotations, so clients had to assume each one might destroy data: `create_project`, `create_clip`, `add_asset`, `retry_project` and the other additive tools now say they are not destructive, and `reanalyze_project` and `add_transcript_cut` say they are. The web app also honours your system's reduced-motion setting everywhere: transitions and animations end at once, and loading spinners keep turning.
