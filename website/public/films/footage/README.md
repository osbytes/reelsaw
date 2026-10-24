# Footage for the demo films

Short excerpts of real Reelsaw renders (and of their 16:9 sources) that `components/films/*.tsx`
play as `<video>` elements. They are the only inputs the films need besides fonts, so a film can be
re-rendered any time with `pnpm render:film <name>`.

Both sources are published on YouTube under the Creative Commons Attribution licence (CC BY), which
is why they were chosen over the creator videos in a typical test run:

| file(s) | source | what it is |
| --- | --- | --- |
| `hero-source.jpg`, `hero-1…4.mp4`, `captions-raw.mp4`, `reframe-face-*.mp4` | ["Foreigners STUNNED by Life in the UK (Oxford Edition)"](https://www.youtube.com/watch?v=jd5bCpWWBXA) by MrUniverse, CC BY | street interviews; `hero-N` are the first 8 s of Reelsaw's clips #5, #3, #1, #4 (hook, captions, score 63 / 62 / 67 / 61); `captions-raw` is the same seconds as `hero-1` cropped to 9:16 by ffmpeg with no processing |
| `reframe-split-*.mp4`, `reframe-fit-*.mp4` | ["Sister Circle \| Roland Martin on The Couch \| TVONE"](https://www.youtube.com/watch?v=uYFjIHelrH0) by Sister Circle TV, CC BY | studio talk show; the split pair is clip #1 (two faces in 51% of frames), the fit pair is the first segment of clip #2 (a social-media graphic, face in 58% of frames) |

The renders were made by a stock install with cloud models through the Vercel AI Gateway (OpenAI
`gpt-6-luna` for picking moments, `whisper-1` for transcription; 5:32 end to end). Face detection,
framing and rendering are always local. Default project settings plus `reelsaw overlays <projectId> --store` so the sources' burned-in
subtitles and logo are blurred). `*-before.mp4` are 720×406 cuts of the source at the clip's start;
`*-after.mp4` and `hero-*.mp4` are 540×960 cuts of the rendered clip from its first frame. Face
positions drawn in the reframing film are the tracks the pipeline stored on the clips
(`clips.layout_segments`), copied into `components/films/reframe.tsx`.
