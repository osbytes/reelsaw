---
"@reelsaw/server": minor
---

One library for everything a clip can carry: intros and outros, logos, stickers, b-roll, music and sound effects, now including GIF, animated WebP and SVG. Clips hold one Layers list (image / video, text, sound) on a single editor lane that replaces the Overlays and Music lanes; `update_clip { layers }`, `reelsaw clip-layers`. The library gets categories, tags, format badges, search, license badges and a credits list; usage counts come from an `asset_refs` table instead of scanning clips. A Browse panel searches the Reelsaw catalog (bundled CC0 / permissive sounds, icons and emoji) and, with an admin-provided key, Pexels, Pixabay, Freesound, Iconify, Giphy and Klipy, and imports results into the library with their provenance. New MCP tools: `list_assets`, `add_asset`, `update_asset`, `remove_asset`, `restore_asset`, `asset_usage`, `search_library`, `import_asset` (the `*_bumper` names stay as aliases). Migration 0039.
