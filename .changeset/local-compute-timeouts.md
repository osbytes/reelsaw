---
"@reelsaw/server": patch
---

Several projects at once on a CPU-only box no longer time out over and over while transcribing: a call waiting its turn for a local model no longer counts against its time limit, a local whisper (Speaches) now takes one transcription at a time unless `PROVIDER_CONCURRENCY` says otherwise, and a self-hosted transcription gets at least twice the chunk's audio length before it times out. An admin's issue report with instance-wide diagnostics no longer fails while projects are in progress, and a report that fails now logs why.
