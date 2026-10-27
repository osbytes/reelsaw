---
"@reelsaw/server": patch
---
A crash during audio extraction can no longer leave a truncated file that a retry transcribes silently. Clip retention now frees the disk it promised (clips and thumbnails, local and S3 scratch), a project whose source was removed by retention is fetched again by Retry (clips then re-render on demand, with a clear message until then), abandoned uploads are cleaned up after a day, and S3 storage checks write access at boot and handles concurrent source pulls safely.
