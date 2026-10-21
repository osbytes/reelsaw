---
"@reelsaw/server": minor
---

Clip editor: per-pane focus in split framing with follow awareness (drag either speaker; drop a pane on someone else to follow them), an Overlays lane for library images, videos and lines of text, intro/outro as blocks on the clip track, and one action bar with the preview's controls in a canvas header. The watermark is now the logo with the site name under it, top-left outside the platforms' dead zones. Background music from the library plays under a clip (own lane, ducked while someone speaks), captions and transcripts export as SRT/VTT (routes, zip, MCP, CLI), and an SRT/VTT file can be imported as a project's transcript. New: `clips.overlays`, `clips.audio`, `clips.captions`, `update_clip { overlays, audio }`, `get_clip_captions`, `get_project_transcript_file`, `import_transcript`, `reelsaw clip-overlays`, `clip-audio`, `captions`, `transcript-file`, `import-transcript`, `WATERMARK_LOGO_PATH`.
