---
"@reelsaw/server": minor
---

Clip only the parts of a long video that matter. New project draws the video's length as a timeline before anything downloads: pick ranges on it (click, drag or type), take YouTube's Most replayed peaks as suggestions, and set each range to find clips inside it or to be the clip. Pipelines send the same ranges with `create_project { ranges, rangesFrom }`, `check_source` prices them, and `reelsaw create-project --range … --most-replayed n` does it from the CLI. Only the ranges are downloaded, transcribed, picked from and counted against minutes; each range's `ref` comes back on its clips, `get_project` and the `clip.done` / `clip.failed` webhooks. The project page shows the ranges with their clips and adds more (`extend_project { ranges }`), counting only new time.
