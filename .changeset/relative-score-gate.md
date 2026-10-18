---
"@reelsaw/server": patch
---
Auto mode now drops weak clips relative to the run's own scores (median − MAD, floor 25) instead of a fixed 45, so switching the judge model no longer empties projects or keeps every clip; the pairwise pass places the top 3 reliably and a separate judge model can be set.
