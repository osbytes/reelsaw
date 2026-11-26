---
"@reelsaw/server": patch
---

A clip whose picture ends before its sound no longer fails after rendering: its thumbnail is taken from an earlier frame instead of a point past the last one. A clip with no picture at all now fails at once with a plain reason instead of retrying.
