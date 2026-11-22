---
"@reelsaw/server": patch
---

Hosted plans bound how much of a machine one account's jobs hold at once: Free 2 cores and 2400 MB, Starter 4 / 4800, Creator 6 / 7200, Pro 8 / 9600. A scan past the ceiling runs with fewer threads; a render past it goes back to the queue until the account's other work ends, so it never holds a worker slot while another account's render waits. `FREE_RESERVE_CORES` keeps the last cores of each machine for paid plans. Admins can override an account's ceiling in Users → Limits, `reelsaw limits <email> --cores N --mem-mb M` or `set_user_resources`. Self-hosted instances are unchanged: the host's capacity is the only limit.
