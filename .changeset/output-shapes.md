---
"@reelsaw/server": minor
---

Clips can now render as 4:5, 1:1 or 16:9 as well as 9:16: pick the Shape in the editor's Captions tab, for one clip or all of them, or set `shape` with `update_clip` / `update_project_style` (`reelsaw update-style --set shape=1:1`). Framing follows the shape: the speaker crop is a window of that shape, split and stack stay two stacked panes in 4:5 and 1:1 and show the whole frame in 16:9, so a 16:9 source comes out as itself. Captions keep their size and position, the editor previews the clip at its shape, and a 16:9 clip's export text drops `#Shorts`.
