---
"@reelsaw/server": patch
---
Filler and repeat removal with the language model (`DISFLUENCY_LLM`) and the AI packaging of clips you cut by hand now save their work as they go, so a timeout or restart continues where it stopped. A timeout used to finish the filler pass with only part of the transcript checked and no warning; it now fails the step so Retry completes it. A long selection for "find the best moment" is searched in parts instead of one prompt.
