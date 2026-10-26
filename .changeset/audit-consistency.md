---
"@reelsaw/server": minor
---

Tabs left open across an upgrade keep working: the command palette and other lazily loaded parts no longer fail with a missing-file error, and a tab on an older version reloads itself on its next page change when nothing is unsaved. Library tags use a picker that suggests tags you already use and creates new ones. Deleting library items and templates is now called Delete everywhere, matching projects and clips, and the MCP tools are `delete_asset` and `delete_layer_template` (the CLI's `library delete` and `templates delete`); `refine_project` is a new MCP tool. Large uploads are no longer cut off after five minutes, migrations are safe when several workers start at once, container logs rotate, and leftover temporary files are cleaned up. Adding a library item from a URL now refuses every internal address form, pages can no longer be framed by other sites, and password-reset tokens stay out of the access log.
