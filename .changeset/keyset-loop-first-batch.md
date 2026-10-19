---
"@reelsaw/server": patch
---

A budgeted batch loop (retention sweeps, purges) always makes one batch of progress before honouring its deadline, so a budget that is already spent when the loop starts cannot leave the cursor in place forever. Also fixes the timing-sensitive unit test that failed on a slow CI runner.
