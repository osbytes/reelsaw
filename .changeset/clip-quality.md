---
"@reelsaw/server": minor
---

Clips sound even and end cleanly. Every clip's speech is now brought to −14 LUFS (the level TikTok, Reels and Shorts play at) and the finished mix goes through a peak limiter, so clips no longer range from whisper-quiet to clipping. Pause trimming only cuts quiet gaps: game sound, music or laughter between lines stays, and a clip that is mostly sound without speech (gameplay, trailers) keeps its timing instead of shrinking to a few seconds; the clip's Cuts tab says why. A clip's ending no longer takes along the first words of the next sentence, clips of one project no longer share a title, text printed on a shirt in a multi-camera video is no longer blurred as if it were subtitles, and a render stopped by the server (for example running out of memory) says so instead of "exited with null".
