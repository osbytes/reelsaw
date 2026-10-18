---
"@reelsaw/server": minor
---
Deleting a project can be undone for 7 days, and re-picking moments keeps every clip you made or edited, replacing only untouched AI picks (which can be restored too); the same through MCP (`restore_project`, `restore_clip`) and the CLI (`reelsaw deleted`, `restore`, `restore-clip`, `purge`).

**Upgrade:** deleted projects now keep their files for `DELETED_RETENTION_DAYS` (default 7; 0 keeps them forever) before the hourly sweep removes them, so disk is freed a week after a delete instead of at once; lower the setting to free it sooner. The migration adds `deleted_at` to projects and clips and `edited_at` to clips. Clips edited before this release are only recognised as edited by their framing, style or intro/outro choice.
