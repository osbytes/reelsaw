---
"@reelsaw/server": patch
---

The spoken language in a project's settings (or your project defaults) is now sent to the transcription model instead of being ignored. Every model auto-detected the language before, so a video that opened with music or a greeting in another language could be transcribed, or translated, in the wrong language, and the filler, name and cut steps were then turned on or off for the wrong language. The clip cut search transcribes in the same language, and a transcript's language is always saved as a code ("en"), not the name some models answer with ("english").
 Because the cut search now names the language, the first re-render or exact preview of an existing project transcribes its cut windows again (once). Imported subtitles take the project's language when the file has none, and chunks transcribed before the language was changed are transcribed again on a retry instead of being reused.
