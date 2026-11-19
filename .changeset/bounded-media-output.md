---
"@reelsaw/server": patch
---

A long link download no longer crashes the server. Ingest buffered yt-dlp's whole stdout, which now carries a progress line per tick; on a long enough download the buffer passed Node's string limit and the uncaught `RangeError` took the process down (the app and its workers), and the reconciler re-queued the same project into the same crash. Commands now keep only bounded output: a caller that reads lines keeps what it needs, and anything else that writes too much is stopped with an error instead of crashing.

When yt-dlp gives up on the full-quality download of a clip's window because of a bot check or a refused page, the clip renders from the preview copy right away instead of retrying into the same block and failing, and the project's other clips go straight to the preview copy for the next half hour instead of each trying again. Rate limits and expired media links still retry. Downloads that do not read yt-dlp's progress no longer ask for it, and command output is decoded across chunk boundaries, so non-Latin titles are no longer garbled.

Frame sampling (face tracking, on-screen text, speaker detection) no longer fails now and then with `ff_frame_thread_encoder_init`: the single-thread setting reached only the decoder, not the rawvideo encoder.
