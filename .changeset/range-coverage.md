---
"@reelsaw/server": patch
---

Projects that clipped only ranges or the start of a long video now say so on their Projects card (how much of the
video, with a strip of the clipped parts, and how many ranges), in the ⌘K palette and in `list_projects`
(`processed`). Range fixes: Most replayed peaks longer than the longest clip are added as ranges to find clips in
instead of exact clips the planner then rejects (also for `rangesFrom` over MCP and the CLI); ranges keep their
numbers when one is added later; expected processing times count the ranges, not the whole video, and no longer
skew the estimates of other projects; each range's download says which part it is; a range that found no moments
keeps its heading. On a phone, New project's footer no longer overlaps itself, Most replayed chips scroll in one
row, range handles stay grabbable when a range is narrow, and the timeline's tick labels no longer collide.
