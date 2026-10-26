---
"@reelsaw/server": patch
---

A job leases the disk it is about to write before it writes it. `statfs` sees only bytes already on disk, so two
ingests of large videos that both passed the free-space check on the same volume could both run out mid-download
and both fail. The governor now checks a job's need against the volume's live leases and records its own claim in
the same locked transaction (`disk_leases`, one advisory lock per volume): the second job waits for the first
("Waiting for resources: … leased to 1 job in flight"), evicting idle cache copies once first, and gives up after
`RESOURCE_WAIT_MAX_SECONDS` for pg-boss to retry. Stages release the lease when they end (ingest as soon as the
source is on disk), and a stage that has to pull the source from the S3 store leases that pull too; a lease counts
while its worker has heartbeated within 10 minutes and expires after the longest a stage job may run, a process
drops its own at boot and once its jobs have stopped at shutdown, so a crash leaks nothing for long. Processes
sharing a volume (the `DATA_DIR/.volume-id` marker) share one ledger;
a worker on another host never contends. The heartbeat reports the volume's leased total (`diskLeasedMB`: Workers
page, `reelsaw workers`, `list_workers`), a hand-off counts it as used, and `reelsaw storage` shows "leased to jobs
in flight on this volume". Migration `0045_disk_leases`.
