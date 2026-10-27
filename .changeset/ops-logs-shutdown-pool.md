---
"@reelsaw/server": patch
---
Each Reelsaw process now writes its own log file (`reelsaw.<worker id>.<date>.log`), so scaled workers no longer delete each other's logs; `reelsaw logs` and issue reports read and merge them all. Stopping the app now ends open event streams and waits briefly for open requests before draining jobs, and `STOP_GRACE_PERIOD` in `.env` sets how long Docker waits (raise it with `SHUTDOWN_GRACE_SECONDS`). Analysis and refine steps get more time on long videos (up to 3 hours, twice the video length), and the database pool is configurable with `DB_POOL_MAX`, with connect and idle-transaction timeouts, so model calls cannot starve job heartbeats. **Upgrade:** the release notes now list the irreversible migrations; take a `pg_dump` before upgrading.
