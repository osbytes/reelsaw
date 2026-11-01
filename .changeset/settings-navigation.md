---
"@reelsaw/server": minor
---

Settings and the navigation menus are reorganised. Account settings get a side nav like System's, and Plan and billing moves into Account (`/settings/billing` still lands on it); System stays its own tab. The account menu is grouped (you, the instance for admins, theme, help, sign out), and the top bar keeps only nav, search and the menu. Settings → System → Overview replaces the CPU / memory / disk gauges of the process that served the page with fleet tiles (workers, jobs, render slots, failures this week); Workers shows each process's status, why it is paused and a version mismatch; the Queue shows only stages with work (one "Idle" line otherwise), the longest wait, a stage no worker takes, and a retrying job's last error. `get_queue` and `reelsaw queue` gain `oldestWaitingAt` and `lastError` and no longer list pg-boss's internal queues; `list_workers` gains `paused`.
