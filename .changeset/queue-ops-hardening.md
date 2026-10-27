---
"@reelsaw/server": patch
---
A job that keeps crashing its worker now fails with "Processing was interrupted 4 times" and a Retry button instead of being re-queued forever, and a worker short of disk no longer hangs while handing its job to another worker. `/api/health` now checks the database, live-update connection, job queue and worker heartbeat and answers 503 when one is down, and the live-update connection keeps retrying after a failed reconnect.
