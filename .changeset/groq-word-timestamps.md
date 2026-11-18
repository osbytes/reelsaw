---
"@reelsaw/server": patch
---

Groq transcription models (`groq:whisper-large-v3`, `groq:whisper-large-v3-turbo`) pass the boot word-timestamp check again, and cuts and captions on them get per-word timing instead of times spread over each phrase. Reelsaw asked Groq for word and segment timestamps, and the provider package keeps the segments and drops the words when an answer has both. Reelsaw now asks Groq for words only, and reads words before segments from OpenAI and Groq answers whatever they contain, as it already did for OpenAI-compatible servers. Stored word-timestamp results now record the request that made them, so a model refused under the old request is tested again at the next boot instead of staying refused for 30 days.
