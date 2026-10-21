---
"@reelsaw/server": minor
---

Background music from the library plays under a clip: several tracks per clip on their own lane, each with window, offset, level, fade and loop, loudness-normalised and ducked while someone speaks. Captions and transcripts export as SRT/VTT (routes, zip, MCP, CLI), and an SRT/VTT file can be imported as a project's transcript. Text overlays take a font from the image (DejaVu, Liberation, Roboto, Open Sans, Lato, Inter, Bebas Neue), and ⌘C/⌘V copy and paste overlays and tracks in the editor. New: `clips.audio`, `clips.captions`, `update_clip { audio }`, `get_clip_captions`, `get_project_transcript_file`, `import_transcript`, `reelsaw clip-audio`, `captions`, `transcript-file`, `import-transcript`, `GET /api/fonts/:family`.
