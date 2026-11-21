---
"@reelsaw/server": patch
---

Reelsaw now knows what each spoken language needs and says what it cannot do for it yet. The language picker, `list_languages` and `reelsaw languages` show each language's gaps (for example "captions: no font on this server draws Devanagari", or that filler removal is English only), the activity feed repeats them once the transcript is in, and a render that draws characters no font has says so instead of burning in empty boxes. Captions in Japanese, Chinese and Thai no longer get spaces between their words and break lines by the width of the text, Arabic and Hebrew captions are laid out right to left, hooks use the language's own capitals (Turkish İ) or stay as written in scripts without capitals, and subtitle files in Thai or Japanese are split into words by dictionary.
