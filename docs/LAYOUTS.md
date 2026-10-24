# Framing layouts

One idea runs through the stack layouts: **a stack shows a content region on top and the speaker below.**
A corner webcam over a screen share is the full-frame region; an app screen or title card beside the
speaker is a full-height region on one side. A top strip or an inset are the same thing with other
shapes. The layout decision carries `content: { x1, y1, x2, y2 }` (normalized); the renderer, the
editor preview and the fixtures all read that one region.

How Reelsaw turns a 16:9 (or any) source into 9:16, which layouts it aims to support, how it picks
one, where it is known to fail, and which fixtures guard each case. Line numbers are as of this
writing; search for the function name if they drifted.

## 1. Layouts

| layout | source looks like | 9:16 output | automatic trigger (config) | user override |
|---|---|---|---|---|
| `face` | one speaker, big in frame | full-height 9:16 crop that follows the face (heavy-tripod smoothing) | face in at least `LAYOUT_MIN_FACE_RATIO` (0.6) of sampled frames, median face height at least `LAYOUT_MIN_FACE_SIZE` (0.18), not in a corner, no second face, no side panel (`decideLayout`, `layout.ts:92`) | section mode "Follow speaker"; drag the picture to offset (`offsetX`/`offsetY`), or point at another person (`subjectX`) |
| `split` | two people in one wide shot | two speaker-sized crops, one above the other | a second face (at least 8% tall) in at least 50% of frames (`layout.ts:116`); inside it the crop follows whoever talks when `activeSpeakers` is confident (`render.ts:276`) | section mode "Two stacked" |
| `stack` | small webcam over a screen share or slides | whole frame on top, zoomed speaker below | median face under `LAYOUT_MIN_FACE_SIZE`, or face centre in a corner (x < 0.22 or > 0.78 and y < 0.3 or > 0.7) (`layout.ts:106`) | section mode "Screen + speaker" |
| `stack` with a webcam tile | the speaker is a picture-in-picture box (Zoom, Teams, Meet, OBS) over the screen or in a flat band beside it | the tile alone below, at its own aspect over a blurred copy of itself; on top the whole frame, or the frame without the tile's flat band | the small / corner rule above, or a face seen too rarely for `face` whose tile stands steady; `probeTiles` + `aggregateTile` (`webcam-tile.ts`): see thresholds below | the tile applies to a forced "Screen + speaker" too (it is the speaker's own bounds, not a content region); a drag on the pane moves the tile's window |
| `stack` with a content region | big speaker on one side, app screen / title card / slide on the other (side-by-side composite) | only the panel on top (own aspect, over a blurred copy of itself), speaker below, cropped from the other side | `detectContentRegion` (`content-region.ts`): see thresholds below | none of its own: forcing "Screen + speaker" gives the plain stack (whole frame on top); forcing "Follow speaker" gives `face` |
| `fit` | no usable face: graphics, b-roll, screencasts, slides | whole frame over a blurred background | face in under `LAYOUT_MIN_FACE_RATIO` of frames; or a text-heavy run (`fitTextHeavy`, `layout.ts:605`) | section mode "Whole frame" |
| `center` | anything | static centre crop | only when there is no face detector, or a manual mode found no face | section mode "Centre crop" |
| `none` | anything | original aspect, no reframing | manual / legacy only; mixed with other pieces it becomes `fit` | project reframe setting or legacy per-clip override |

Content-region thresholds (`REGION`, `content-region.ts:41`), all general, none tuned to one video:

| signal | threshold |
|---|---|
| speaker | median face height at least 0.20; one dominant face (two faces would already be `split`) |
| text beside the face | text boxes entirely beyond the face edge by at least 0.05 of the width, and none on the other side |
| text extent | at least 0.35 of the height on its own; at least 0.20 when a divider backs it |
| divider | strongest straight vertical edge per frame (mean luma step across all rows): at least 0.30 to back text, at least 0.40 to count alone; must lie within 0.12 of the text's inner bound to back it |
| persistence | the panel is seen in at least 60% of sampled frames, and its edge stays within 0.04 in at least 70% of those |
| size | panel at least 0.22 of the width; clears the speaker's face by 0.02 |
| decision | `stack` with `content { x1, y1, x2, y2 }` (here a full-height strip on one side); reason "app panel / title card / content beside the speaker (right 32%)" |

Webcam-tile thresholds (`TILE`, `webcam-tile.ts`), from the 320x240 frames the face detector decodes:

| signal | threshold |
|---|---|
| candidate edges | per side of the face, the 4 nearest columns (rows) whose mean luma step over the face's rows (columns) is at least 0.16 and 2.5x the typical column in reach (0.45 of the frame), or the frame edge |
| rectangle | encloses the face box with a 10% margin, at least 1.4 face widths / heights, at most 0.6 of the frame on either axis, 1.2 to 2.1 wide:high in source pixels (a landscape camera) |
| edges hold | each quarter of every edge's span steps at least 0.04 and 1.4x the column (row) 3 px outside the rectangle (texture and a flat band both fail), and the row (column) 3 px inside shows a picture (step at least 0.004 in 3 of 4 quarters) |
| frames | a frame without a face is probed around the last face up to 30 s before it, or the next face up to 10 s after it; the tile does not move when the detector blinks |
| per clip | rectangles clustered by position (every edge within 0.04); the cluster seen in at least 60% of the frames with the most frames wins, and a cluster seen in at least 90% as many frames that lies outside it wins over it (a line inside the webcam picture is a rectangle in some frames, the border in all) |
| band | the strip from the tile to the frame edge it is flush with is a flat band when at most 10% of its pixels differ from its median luma by more than 0.08 (a name plate is a few percent), and the rest of the frame is at least 0.4 wide / tall; the top pane is then the frame without the band |
| decision | `stack` with `tile { x1, y1, x2, y2 }` (and `content` = the frame minus the band); reason "… ; webcam tile top-right (x 0.87-1.00, y 0.08-0.22), in a flat band on the right" |

Where the user can override: project setting `reframe` (`reframeModeSchema`, `packages/shared/src/index.ts:50`),
per-clip layout sections and offset (`layoutSectionSchema`, same file line 109; `coverTimeline`,
`layout.ts:418`), the editor's section mode select and drag-to-offset, and the MCP `layoutOverride` /
`layoutSections` fields. A section in any mode but Auto is "manual": automatic post-passes leave it alone.
Each pane of a section has its own adjustment: `offsetX` / `offsetY` for the top (or only) pane,
`offsetX2` / `offsetY2` for the bottom of a split, and `subjectX` / `subjectX2` to follow the person at that
x (a fixed crop there when no face is found). See [specs/editor-tracks.md](specs/editor-tracks.md).

## 2. How the decision is made

**Sampling** (all in `renderClip`, `render.ts`). One ffmpeg pass decodes the clip at 4 fps, 320x240,
for UltraFace (`sampleFaces`, `layout.ts`); the same frames feed a per-frame vertical-divider probe
(`probeDivider`, `content-region.ts`) and the webcam-tile probe around the largest face
(`probeTiles`, `webcam-tile.ts`; a frame without a face is probed around the last or next face seen). One more pass at 2 fps, 640x352, runs the PP-OCR text detector
(`sampleClipText`, `overlays.ts:335`); its boxes are attached to the nearest face sample
(`attachText`) and are the only text input the layout reads. Scene cuts come from the transcript
stage (`scenes.ts`, adaptive threshold). Active-speaker detection (`speaker.ts`, 10 fps mouth motion
correlated with the audio envelope) runs only on `split` segments of 3 s or more. Static "faces"
(posters, photos) are dropped first (`dropStaticFaces`).

**Order of rules in `decideLayout`** (first match wins):

1. face in fewer than `LAYOUT_MIN_FACE_RATIO` of frames: `fit`
2. a second face (at least 8% tall) in at least 50% of frames: `split`
3. face under `LAYOUT_MIN_FACE_SIZE`, or parked in a corner: `stack` (whole frame on top, or the webcam tile and the frame without its band when `aggregateTile` finds one). Rule 1 defers to this when the face is rare but its tile stands steady.
4. big face with a content region (`detectContentRegion`): `stack` with `panel`
5. otherwise `face`

**Segmenting** (`segmentLayouts`, `layout.ts:299`): each sample is `face`, `split`, `panel` or `none`;
states are smoothed over 2 samples either side (split holds across a missed second face for 3 s),
boundaries snap to a scene cut within 1 s, pieces under 2.5 s fold into a neighbour, each piece
runs `decideLayout` on its own samples, and neighbours with the same layout (and panel side) merge.
Content regions are segmented separately (`contentRuns`, `content-runs.ts`): runs of frames that voted for a
panel (holes up to 0.75 s closed; gaps up to 4 s bridged when the divider stays at the same x),
trimmed to the last voting frame plus one sample and snapped to a scene cut within 0.25 s. A run under
2.5 s, or with the speaker in under 60% of its frames, is dropped. A panel stack only exists inside a
run, so a short tail or lead-in next to a panel is the plain face crop, never folded into the stack.
A short one-face stretch beside a split that is one of its speakers is held as split.

**Post-passes** (`render.ts`): active-speaker expansion of splits; `fitTextHeavy` turns auto
segments into `fit` where text fills the frame (a slide, or a paragraph of 4+ lines) for at least 2 s,
snapped to scene cuts, but never over a segment that has a content region (its text is why the frame
looks text-heavy); a clip with several pieces becomes 9:16 throughout. `tripodTrack` smooths the face
path: dead zone 0.025, capped pan speed. **Tripod.** The camera never pans across a break: a scene
cut, or a face that jumps more than 0.15 of the width between consecutive samples and stays there for
the next two (a cut the detector missed; a one-frame flip to another box is not a break). Each stretch
between breaks is smoothed on its own, so no average straddles the cut, and the camera jumps to the
median of the new stretch's first half second as a hard step (two crop-expression points 3 ms apart),
not a lerp between two samples. A segment's track is re-based to its own clock and holds its first
position back to t=0. Segments are joined by a plain concat (no wipe or fade) unless the user adds a
transition, and ffmpeg's `crop` clamps x/y to the frame, so a crop never shows black.

**Logged** at `trace` per sample (`content vote`: text beside the face per side, text span, divider x and
strength, face centre and height, the vote and its side) and at `debug` once per render (`content runs`:
frames, voting frames, text frames attached, each candidate run with its votes and why it was dropped,
and the decision made for each kept run). `reelsaw faces <clipId> <range> --votes` prints the same from
the CLI. **Logged at debug** (`layout per section`, `render.ts:310`): per section the layout, manual flag,
reason, average faces per frame, and for face / panel decisions the content-region signals (share of
frames, side, evidence, text beside per side, text extent, divider x and share, or why it was
rejected). At info, `layout resolved` carries the per-piece summary and the first reason. The
decision is stored per clip (`layoutSegments`, with `content`) and shown in the editor
("Stack · content right 32%").

## 3. Known caveats

- Two faces close together or overlapping read as one wide face, or as a spurious second box; the
  second-face minimum of 8% height and the pair assignment keep most, not all, of it out.
- Profile, turned-away or looking-down faces drop out of UltraFace; under 60% of frames becomes `fit`.
- Glasses glare, backlight and heavy compression lower detection; the 5-sample smoothing hides short
  gaps, not long ones.
- Very small webcams are often missed by UltraFace at 320x240; the shot is still a `stack` when the webcam's tile is found around the few faces seen, else it becomes `fit`.
- A webcam tile needs straight edges on all four sides (or the frame edge) and a landscape shape: a circular or portrait webcam, a tile with a rounded or shadowed border, or one whose border is lost against a dark panel in part of its span (a dark room beside a dark editor still measures ~1.5x) gets the face-sized crop as before. A thin flat margin under ~3 px at 320 wide between the tile and a strong edge counts as part of the tile. The tile is one rectangle per clip segment: a webcam that moves or resizes mid-segment is not followed.
- A presenter who switches sides mid-clip is handled by the tripod snap at scene cuts only; without a
  cut the crop pans at the capped speed.
- More than two speakers: only the two largest faces get crops.
- Speaker swaps faster than the 2.5 s minimum shot are smoothed away, so a quick back-and-forth stays
  on one speaker or the split.
- Panels that animate (scrolling feeds, video) are fine for the divider but make text detection
  flaky; in the app-screen fixture text was found in only some frames and the divider carried the rest.
- Text on both sides of the speaker, or text under the face (lower thirds, burned-in captions), is
  deliberately not a panel.
- Burned-in captions inside the speaker crop band: crops avoid bands present for 50%+ of the clip,
  but a panel crop does not look at them.
- Dark or low-contrast title cards where text detection fails still pass on the divider alone only
  when the edge is strong (0.40+); a card nearly the colour of the room is missed (stays `face`).
- Panel narrower than 0.22 of the width stays `face`; a panel not spanning the full height is cropped
  as if it did (the crop is always full height).
- The divider probe takes the single strongest vertical edge per frame at 320 px width, so a panel
  edge weaker than a window frame or door in the room is not seen, and edge position is good to about
  1% of the width (both crops keep 1.2% clear of it).
- Ordinary pieces under 2.5 s fold into the safe neighbour; a panel never outlives the panel: a 1 s
  face tail after a title card stays a face crop, and a panel that appears under 2.5 s before the end
  never becomes a stack.
- A gap of up to 4 s inside a panel (OCR loses the title, divider soft) is held only while the divider
  stays within 0.03 of the panel edge in 60% of the gap frames; a longer gap, or one without the
  divider, splits the stack.
- The reason text "app panel" vs "title card" is a guess from the number of text lines (5+ is an app).
- 4:3 and vertical sources: the full-height crop is narrower than the source, so `face` barely moves;
  nothing special is done for vertical input, and content-region detection assumes a landscape composite.
- Letterboxed or pillarboxed sources: the black bars are part of the frame; a pillar can look like a
  divider (a bar is a strong straight edge) and the face-size thresholds are measured against the full
  frame, not the picture. No fixture yet.
- Screen recordings with only a cursor have no face: `fit`.
- Captions default to 72% of the height, over the speaker half of a panel stack; moved to the top they
  would sit on the panel.
- Forced "Screen + speaker" on a side-panel shot gives the plain stack (the panel is not applied to
  manual modes), so the user can always get the old behaviour.

## 4. Eval coverage

The framing suite (`pnpm eval framing`, suite code `apps/server/src/eval/suites/framing.ts`) runs on
committed samples (faces, plus text boxes and divider for `panel` cases), so it needs no media or model.

| layout / caveat | fixture in `eval/fixtures/framing/` |
|---|---|
| `face`: tripod settles on the face, no fast pans | `track-closeup-settle` |
| `split`: wide two-speaker shot, speakers at the edges, caption band kept out | `split-wide-two-speakers` |
| `split`: spurious box beside a speaker must not swap crops | `split-spurious-box-beside-speaker` |
| `stack` with panel, right (app screen, panel appears mid-range) | `panel-right-app-screen` |
| `stack` with panel, left (title card, appears and goes away) | `panel-left-title-card` |
| panel held through a short gap in the evidence; full-screen table with no face is `fit` | `panel-left-hold-through-gap` |
| panel ends 1-3 s before the clip: the tail stays `face` | `panel-left-card-ends-before-clip`, `panel-left-card-ends-before-clip-2` |
| `stack` with a webcam tile in a flat band (Zoom webinar, face seen in 3% of frames) | `tile-webinar-black-band` |
| `stack` with a corner webcam tile over a screencast, no band | `tile-screencast-corner-webcam`, `shots-screencast-corner-webcam` (the tile check; the case still fails on the split, see below) |
| `fit`: no face (b-roll, graphics) | no fixture yet |
| `fit`: text-heavy run over a speaker | no fixture yet |
| negatives: lower-third text, text on both sides, room edges, narrow panel | unit tests only (`apps/server/test/side-panel.test.ts`); no real-footage fixture yet |
| two faces close together, profile faces, glare, tiny webcam | no fixture yet |
| presenter switching sides mid-clip, more than two speakers, fast swaps | no fixture yet |
| dark title card without text detection, panel under the width threshold | no fixture yet |
| letterboxed or pillarboxed source, 4:3 / vertical source | no fixture yet |
| active-speaker following (needs audio) | covered by `speakers` suite, not framing |

Adding a case from a bad clip: read what was decided with `docker compose exec app reelsaw clip <clipId>`
(layout segments and reasons) and, with `reelsaw log-level render=debug --for 15m` and a re-render, the
`layout per section` line. Extract frames at the interesting moments
(`ffmpeg -ss T -i source.mp4 -frames:v 1 -vf scale=960:-2 tT.jpg`), find the exact range, then add
`eval/fixtures/framing/<name>/case.json` with a media source (`id`, `url`, `localPath`, `start`, `end`),
the range inside it, `srcW`/`srcH` and an `expect` block (`layout`, `content`, `segments`, offsets).
Run `pnpm eval framing`: the case must fail first, and it generates `samples.json` on the first run
(commit it). Fix the rule, rerun, then `--update` the baseline. Details and what stays out of git:
[EVALS.md](EVALS.md#adding-a-case-when-a-bug-shows-up).

## 5. Principles that apply

- Precision over recall: a wrong automatic reframe is worse than a missed one, so any doubt keeps the
  simpler layout (`face`, or `fit`) and the user can force the rest.
- Every framing fix ships with a fixture, and the rule that fixes it is general, not tuned to one video.
  See [PRINCIPLES.md](PRINCIPLES.md#quality).
