---
"@reelsaw/server": minor
---

Punch-in zooms: turn on "Zoom in on key words" in the editor's Captions tab (or `punchIn` in `update_clip` / `update_project_style`, `reelsaw update-style --set punchIn=true`) and the picture eases in briefly on each key word, by 1.05-1.3x (default 1.12x). Zooms happen on face and centre crops and on a phone inset that fills the frame, never on split or stack panes and never across a cut or a change of framing. Off by default, so existing clips re-render unchanged. The editor preview zooms the same way, and `get_clip` lists the zooms the last render burned in.
