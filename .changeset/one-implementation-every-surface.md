---
"@reelsaw/server": patch
---
"Not found" answers now say what is missing in plain words, and the MCP clip tools report what changed and whether a render was queued (`update_clip`, `create_clip`, `delete_clip(s)`, `rerender_clip(s)`; `get_clip` also shows the style and framing it will render with and where they come from). Editing a clip's length now has the same 3 second to 10 minute limits as creating one. The command line can create projects, retry, re-analyze, refine, delete, export and create or edit clips, `rerender` prepares clips that never got a title, and `recover` retries a failed project. The templates and library lists load a page at a time.
