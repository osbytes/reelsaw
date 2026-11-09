---
"@reelsaw/server": minor
---

Fades and transitions. A clip can fade in from black and out to black, picture and sound together, and its intro and outro can join it with a cut, a dip to black or a crossfade. Picture and text layers can fade in and out over their window. Set them in the editor's Style tab (renamed from Captions) for one clip or every clip, previewed live while the clip plays, and in Settings → Project defaults for new projects. Over MCP and the CLI they are style fields (`fadeIn`, `fadeOut`, `bumperTransition`, `bumperTransitionSec` on `update_clip { style }`, `update_project_style`, `set_project_defaults` and `reelsaw update-style --set`) and a layer `fade` (`reelsaw clip-layers --add … --fade 0.5`). Off by default; the render reports what it burned in under `diagnostics.transitions`.
