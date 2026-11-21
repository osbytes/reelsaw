---
"@reelsaw/server": patch
---

The spoken language picker lists the languages the transcription model in force takes: a self-hosted server (Speaches) and Deepgram say which, and Whisper's own set is assumed for the rest. New `list_languages` tool and `reelsaw languages` command. Language codes are canonicalised with the standard aliases ("iw" is Hebrew, "jw" Javanese), and a misspelt language is now left to detection instead of being sent to the model.
