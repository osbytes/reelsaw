---
"@reelsaw/server": minor
---

Whisper decoder loops (one word or a prompt list cycling for minutes) are collapsed after transcription, and each collapse shows up as a transcript fix. The as-heard repeats stay in the transcript; rejecting the fix puts them back. Captions stay empty across that stretch unless you type replacement text on the flag. Re-transcribe to recover the missing speech.
