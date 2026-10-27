---
"@reelsaw/server": patch
---
Transcription now saves each audio chunk as a step, so its progress, time left and timeouts behave like finding moments and a retry continues after the last finished chunk. With S3 storage the speech-to-text cache is shared across hosts. A "no progress" warning now says which stage is stuck, how many parts are done and when the last one finished, and it also fires when a model keeps ticking but finishes no part.
