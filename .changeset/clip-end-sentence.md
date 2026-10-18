---
"@reelsaw/server": patch
---

Clips end on a complete thought. A clip that stopped mid-sentence ("…and you're now so | different") now finishes the sentence when it is within 8 seconds (or steps back to the previous one), and starts at the beginning of a sentence when one is within 3 seconds. Sentence ends come from punctuation, pauses and capital letters after a word that is not a connector like "and" or "so". Your manual edits are never moved. See docs/SELECTION.md.
