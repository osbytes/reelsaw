---
"@reelsaw/server": minor
---

Queue visibility and priority: Settings → System → Queue (`reelsaw queue`, `get_queue`) shows how long jobs waited to be picked up in the last hour per stage (median and 95th percentile), which accounts have work queued and at what priority, and waiting jobs in the order workers take them. Admins can set an account's queue priority (Users → Limits, `reelsaw limits <email> --priority N`, `set_user_queue_priority`), and on hosted plans every paid plan now starts jobs ahead of Free (Starter +2, Creator +3, Pro +5).
