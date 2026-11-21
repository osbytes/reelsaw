---
"@reelsaw/server": patch
---

Clips start and end on sentences in every language: the full stops of every script count ("।" in Hindi, "。" in Japanese, "؟" in Arabic), where before only ". ! ?" did, so a Hindi transcript with its full stops now puts nearly every clip edge on a sentence. A transcript without punctuation (most transcription models return Hindi without it) is split into sentences on its speaker's pauses instead of every 28 words, the English rules for capitals and "and"/"so" no longer apply to other languages, and the activity feed says when clip edges had only pauses to go on.
