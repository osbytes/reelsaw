# Gold-standard references

Clips from other channels that we think are what a Reelsaw clip *should* look like. Each one is a
hand-curated example of patterns worth copying: cut cadence, caption placement and emphasis,
B-roll triggers, sound. They are not fixtures with a pass/fail (we have no source video and no
"right answer"), they are targets. Specs cite them, prompts can borrow examples from them, and a
future `style` suite can compare our renders against their measured envelope.

```
eval/references/
  capture.sh                     measures a clip: cuts, loudness, silences, contact sheet
  <slug>/
    reference.json               what to copy: observed patterns, hand-written, the valuable part
    measured.json                what capture.sh measured (cuts, LUFS, silences, views at capture)
    cuts.txt                     scene-cut timestamps, one per line
    sheet.jpg                    contact sheet, one frame every 3 s, so the patterns are visible without the video
```

The video itself never goes in git (copyright and size). `capture.sh` downloads it to
`eval/.cache/references/<slug>/` with yt-dlp, which is gitignored like all eval media.

## Adding one

1. `eval/references/capture.sh <url> <slug>` (slug = `<channel>-<a-few-title-words>`).
2. Watch the clip and look at `sheet.jpg`. Write `reference.json`:
   - `why`: one line on what makes it a reference.
   - `patterns`: one entry per thing worth copying, with `area` (one of `cuts`, `captions`,
     `framing`, `broll`, `audio`, `hook`, `pacing`), what you see, and where in the clip (timestamps)
     so a reader can check. Numbers where you can get them (caption centre as a fraction of the
     frame, words on screen, cut interval).
   - `gaps`: what Reelsaw does differently today, pointing at the stage or setting, and the
     docs/RESEARCH.md gap number when there is one. This is the list a spec starts from.
3. Keep `sheet.jpg` under 300 KB (`capture.sh` already uses a small tile).

Observed patterns are the point; measured numbers back them up. When a pattern ships, note it in
the entry (`shipped: "<version or PR>"`) rather than deleting it, so the reference keeps showing
what the target was.

## Using them

- **Specs**: a caption, B-roll or pacing spec names the references it is built from and the
  numbers it is aiming at. No taste arguments without a reference.
- **Prompts**: emphasis words, hook lines and B-roll cue words from references are the few-shot
  examples for the analyze stage, not invented ones.
- **Style eval (planned)**: render a fixture source with our pipeline, compute the same measures
  (`cuts.perMinute`, `medianShotSeconds`, caption centre, words on screen, LUFS, LRA, silence
  seconds) and compare with the envelope across references. Same runner and baseline mechanism as
  the other suites (docs/EVALS.md).
