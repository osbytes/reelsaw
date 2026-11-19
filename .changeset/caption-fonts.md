---
"@reelsaw/server": minor
---

Pick the caption font in the app. The editor's Style tab has a Font picker for captions and the hook, for one clip or the whole project, and Project defaults has one for new projects. Admins set the instance's default font under Settings → System → Captions without a restart (`CAPTION_FONT` is now a runtime setting) and can upload `.ttf`, `.otf`, `.woff` or `.woff2` files there, which every account can then pick for captions, hooks and text layers. The watermark always uses the instance's font. A font that is no longer available falls back to the instance font and then DejaVu Sans. The same works through `list_fonts`, `add_font`, `remove_fonts`, `style.font` on `update_project_style` / `update_clip` / `set_project_defaults`, and `reelsaw fonts`.
