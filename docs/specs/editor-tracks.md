# Editor tracks: per-pane focus, overlays, intro/outro on the timeline

Status: implemented (Oct 2026). What the competitor editors do, what we took from them, and how the
three features are modelled. Framing internals stay in [LAYOUTS.md](../LAYOUTS.md).

## What competitors do (Oct 2026)

Sources: OpusClip help centre and homepage editor mock, Restream clips, Quso (vidyo.ai), Vizard,
Descript. Only public docs were used; nothing here comes from a logged-in trial.

| | OpusClip | Restream | Quso | Vizard / Descript |
|---|---|---|---|---|
| Follow by default | yes, AI active-speaker tracking, "Track: ON" toggle | yes | yes (CutMagic) | yes (Descript "center active speaker", no override) |
| Unit of manual override | the scene (scene detection); shift-select scenes, right-click to change several | the section (split the clip at the playhead first) | the scene cut you add | none |
| Direct manipulation | crop window with four handles over the source frame (`X`, double-click), aspect presets, speaker name labels | click a speaker's box, drag or zoom it; repeat per speaker | "readjust the frame" per scene | no |
| Per-speaker focus in split | not documented | yes, per speaker per section | split toggle per scene | no |
| Manual tracker | "Tracker": pick the subject to follow, per scene; falls back to auto | no | no | no |
| Overlays / b-roll | overlays auto-placed on the first free track (up to 5), edge-drag to resize; b-roll dragged on the timeline, Fill / PiP / Split framing per b-roll segment | — | b-roll tab | — |
| Intro / outro | brand template (one each, ≤1 min); the homepage editor mock shows the intro as a thumbnail block at the head of the video track | — | — | — |
| Timeline | filmstrip video track with the layout name ("Fill", "Split") as a strip over each segment, b-roll track above, waveform below, zoom slider, transport centred | — | subtitles editable on the timeline | — |

Patterns taken: auto-follow stays the default; the section is the unit of override; per-pane
drag inside a split; a subject tracker that follows the person you point at; overlays on their own
track with edge-drag; intro/outro as blocks on the clip track instead of selects.

Patterns not taken: a modal crop window with aspect presets (our output is always 9:16 and the
preview already is the crop); five overlay tracks (we pack rows automatically, capped at three).

## 1. Per-pane focus with follow awareness

A `split` section has two panes (top and bottom speaker), a `stack` section has one speaker pane.
Each pane now has its own adjustment, stored on the section (`layoutSectionSchema`):

| field | pane | meaning |
|---|---|---|
| `offsetX`, `offsetY` | 1 (top / only) | shift of the crop, fractions of the source width / height, relative to the tracked face |
| `offsetX2`, `offsetY2` | 2 (bottom of a split) | same for the second pane |
| `subjectX`, `subjectX2` | 1, 2 | "follow the person at this x": the renderer re-assigns the pane's track to the face nearest that x; no face there → a fixed crop at that x |

Precedence inside a pane: the tracked face (auto or subject) gives the centre, then the offset
shifts it. An offset is *relative*, so the crop keeps following after a nudge. A subject replaces
which face is followed; the offset still applies on top.

**Drag semantics (editor preview).** The pointer's half of a split picks the pane. Dragging moves
the crop (x and y). On release, "follow awareness" decides what the drag meant:

- the tracked face is still inside the pane's crop window → keep it as an offset (a nudge: the
  pane keeps following the same person, shifted);
- the tracked face left the crop window → the user pointed the pane at someone else: the drop
  position becomes `subjectX`, the offset resets, and the renderer follows the face found there.

The preview explains the result in the frame tag ("Top: following the person at 72%"), the
framing card shows per-pane state with a Reset per pane, and the MCP `update_clip` tool accepts
the same fields.

**Renderer.** `offsetDecision` shifts `track` by pane 1 and `track2` by pane 2 (before this change
one `offsetX` shifted both). `subjectTrack` (`layout.ts`) builds a pane's track from the face
samples by continuity from `subjectX` (the same rule `assignPair` uses), smoothed by `tripodTrack`;
if the face is missing in most samples the pane becomes a fixed crop at `subjectX`
("manual, no face at 0.72, fixed crop"). Vertical offsets move the `speakerCrop` centre; a
full-height face crop ignores them.

Compatibility: an old split section with only `offsetX` now shifts the top pane only. Such
sections are rare (one offset for two panes was never a good edit) and the user sees the result in
the preview before re-rendering.

## 2. Overlays (own track)

An overlay is a library asset (image or video, the same library as intros and outros) composited
over the clip for a time range. Stored on the clip as `clips.overlays` (`clipOverlaySchema[]`,
max 20):

| field | meaning |
|---|---|
| `id` | short id, stable across edits (undo, MCP patches) |
| `assetId` | library asset |
| `start`, `end` | absolute source seconds, like sections (survive retrims; a cut inside the range just shortens it) |
| `x`, `y` | centre, fractions of the output frame |
| `w` | width, fraction of the output width (height follows the asset's aspect) |
| `opacity` | 0.1–1, default 1 |

Render: each overlay is an extra ffmpeg input after the source and before the intro/outro
(`overlayInputs`, `render.ts`); the filter scales it to `w`, applies the opacity, and composites it
over the body *before* the captions (`ass=`) so captions stay readable, with
`enable='between(t,a,b)'` in post-cut body time (`plan.mapTime`). A video overlay plays from its
own start (`setpts` shifted to `a`) and passes through after its end (`eof_action=pass`); an image
repeats. A missing or unreadable asset is skipped with a `clip.overlay_skipped` event; if the
render with overlays fails, the clip is rendered without them (same rule as bumpers), never failed.

Editor: an "Overlays" lane above the clip lane. Blocks show the asset thumbnail and name; drag to
move, drag an edge to trim (snaps), Delete removes the selected one, double-click the lane (or the
"+ Overlay" button) adds one at that time. Overlapping blocks pack into rows (up to three). The
selected overlay is drawn on the preview and can be dragged there to move it and resized from its
corner handle. Overlays are part of the undoable document and need a re-render.

**Text overlays** share the list and the lane (`kind: "text"`, with `text`, `size` as a fraction
of the frame height, `color`, `box`, `opacity`; `x`/`y` are the centre). They are not an ffmpeg
input: the renderer writes them into the caption file as `Dialogue` events on layer 1 (`Text` /
`TextBox` styles in `captions.ts`, the caption font and plate), so they match the captions and the
preview draws them with the same CSS as the caption line. On the preview the corner handle changes
the size instead of the width.

Surfaces: `clips.update { overlays }`, MCP `update_clip { overlays }` and `get_clip`, CLI
`reelsaw clip-overlays <projectId> <clipId> --set '<json>' | --add <assetId> … | --add-text <text> … | --clear [--rerender]`.

## 3. Intro and outro on the timeline

The clip lane shows the effective intro as a block attached to the left of the clip range and the
outro to the right, each with the asset's thumbnail, name and length, and a "project" badge when it
comes from the project. Empty slots show a ghost "+ Intro" / "+ Outro" chip. Clicking a block or
chip opens a popover with the same Intro / Outro choices as before (project default, none, any
library asset, seconds for images) and the "Project settings…" link. Dragging the outer edge of an
image bumper block changes its seconds (1–10). While a block is selected the preview shows the
asset's poster with an "Intro · 3 s" tag; seeking or playing returns to the video.

The ruler stays in source seconds: the blocks sit outside the clip range on purpose, like the
intro thumbnail at the head of OpusClip's video track. Nothing about the stored model changed
(`clips.bumpers`, project settings); only where it is edited.

## 2b. Music lane

One background track per clip (`clips.audio`, `clipAudioSchema`): a library audio asset (the
library now takes MP3 / M4A / AAC / WAV / OGG / FLAC up to 15 min and 30 MB; an audio item can never
be an intro or outro), a window in source seconds, `offset` into the track, `volume` (default 0.25),
`duck` (default on), `fade` (default 0.5 s) and `loop` (default on). The editor shows it as the
"Music" lane under the framing lane (one block: drag, trim, `+` or double-click to pick a track,
Delete to remove) with a card in the Overlays tab for level, fades, ducking, looping and the track
offset; the preview plays the track along with the video inside its window (no ducking in the
preview).

Render (`musicMix`, `render.ts`): the track is an extra ffmpeg input after the overlays and the
logo (`-stream_loop -1` when looping), trimmed to the window, faded in and out, set to its level,
delayed to its start and padded to the body; with ducking the body's speech keys a
`sidechaincompress` on the music (roughly 10-15 dB down while someone talks, back within half a second), and
`amix … normalize=0` keeps the speech at its own level. The mix replaces the body audio before the
intro/outro are joined, so bumpers keep their own sound. An unusable track is skipped with a
`clip.overlay_skipped` event, and the "render with overlays failed" retry drops the music together
with the overlays.

Surfaces: `clips.update { audio }`, MCP `update_clip { audio }` / `get_clip`, CLI
`reelsaw clip-audio <projectId> <clipId> --track <assetId> [--from] [--to] [--volume] [--offset] [--fade] [--no-duck] [--no-loop] | --clear [--rerender]`.

**Watermark.** The instance watermark reuses the overlay compositor: when a render carries it, the
logo (`WATERMARK_LOGO_PATH`, `apps/server/assets/watermark.png`) is appended as the last overlay
input for the whole body (top-left under the platform top band, 18% of the width, 95% opacity; `WATERMARK_LOGO` in
`captions.ts`) and the `WATERMARK_TEXT` line is written smaller right under it in the caption file.
A missing logo file logs a warning and keeps the text-only watermark.

## 4. Where actions live

The rule, taken from OpusClip's editor: **a control sits next to the thing it changes.** The frame
has a header, the tracks have a bar, things are added where they appear, and the inspector holds
the long forms.

| place | what | why there |
|---|---|---|
| canvas header (above the preview) | framing mode of the section under the playhead (with what Auto chose), crop status + Reset, safe zones / platform / burned-in text | they describe or change the frame being looked at (OpusClip's `Layout: Fit · Tracker: OFF` strip) |
| on the preview | drag a pane, drag / resize an overlay, drag the caption or hook | direct manipulation of what is drawn |
| timeline bar | Split (`⌘B`), Remove (`Delete`) on the left; transport, time, `[ In` / `Out ]` in the centre; snap toggle (`S`), zoom, Fit on the right | they act on the tracks or the playhead; nothing additive, nothing about the view |
| on the lanes | `+` on the Overlays lane (image or video / text), double-click the lane, right-click; intro / outro blocks and ghost chips on the clip lane; the clip block's length label opens the in / out editor (fields, ±1 s, ±0.1 s) | things are added and edited where they will show |
| inspector tabs | Captions, Framing (per section, per pane), Overlays (per item), Details (title, hook, post caption, hashtags), Cuts, Transcript | long forms, lists, explanations |
| header | undo / redo, dirty state, layout toggle, copy link, shortcuts, theme, Save | document-level |

The snap toggle is persisted per browser (`rs-editor-snap`). On narrow screens the bar and the
header wrap into rows; nothing in them changes width while dragging (the snap pill has a minimum
width).
