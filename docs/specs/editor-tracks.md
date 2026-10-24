# Editor tracks: per-pane focus, layers, intro/outro on the timeline

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

## 2. Layers lane

Overlays and music used to be two lists, two lanes and two inspector cards. They are now one list,
`clips.layers` (asset, text and audio layers, max 30), edited on one lane. The model, the read path
over old `overlays` / `audio` rows, the render changes and the surfaces are in
[library.md](library.md) (decision 2); this section is what the editor does.

- **Lane.** One "Layers" lane above the clip lane (`data-lane="layers"`). Overlapping blocks pack
  into rows (up to four), visual layers first so sounds settle on the bottom rows. An asset block
  shows its thumbnail and name (the Film glyph for a GIF, WebP or video without one), text shows the
  `T` glyph and the text, audio shows the music glyph and the name. Drag to move, drag an edge to trim
  (snaps; at least 0.1 s for pictures and text, 0.5 s for sounds), Delete removes the selected block,
  double-click the lane adds an image or video at that time, right-click offers Add image or video /
  Add text / Add sound / Remove. The `+` on the lane label opens Image or video, Text, Sound and
  Browse library… (which opens the Library page until the Browse dialog exists).
- **Inspector.** One "Layers" tab with one card per layer; the card shows the fields of its kind:
  asset (position, width, opacity, repeat for GIF / WebP / video), text (text, size, colour, plate,
  font, opacity), audio (level, fade, ducking, repeat, offset into the track; "Sound effect" in the
  header when the file is a one-shot, see `audioLayerDefaultsFor`), and the from / to / whole-clip time
  fields every layer shares.
- **Preview.** Visual layers are drawn on the frame and dragged there to move, with the corner
  handle to resize (width for pictures, size for text). A GIF or animated WebP is an `<img>`, which
  loops natively. Audio layers play along inside their windows, one `<audio>` per layer, no ducking.
- **Editing.** Layers are part of the undoable document and need a re-render. A retrim clamps every
  layer to the new range and drops one that is left under 0.1 s (pictures and text) or 0.5 s (sounds).
  Ids are `ly-xxxx`.

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

## 3b. Layer details

**Text fonts.** A text overlay has a `font` from `TEXT_FONTS` (DejaVu Sans, Liberation Sans/Serif,
Roboto, Open Sans, Lato, Inter, Bebas Neue, DejaVu Sans Mono): fonts installed in the image
(Dockerfile), written as `\fn` in the caption file, and served to the editor from the same
fontconfig lookup (`GET /api/fonts/:family`, `lib/fonts.ts` registers them as `FontFace`s), so the
preview draws the face libass will. A family the image lacks is refused by the route and the preview
falls back to the caption font, like the render.

**Copy / paste.** `⌘C` on a selected layer stores it in the editor's own clipboard
(`localStorage`, so it works across clips and tabs); `⌘V` pastes a copy at the playhead with a new
id and the original length, clamped to the clip. Typing in a field keeps the browser clipboard.

Render (`overlayChain`, `musicMix`, `render.ts`): each visual layer is an extra ffmpeg input,
scaled to `w`, faded by `opacity` and composited over the body before the captions (`ass=`) with
`enable='between(t,a,b)'` in post-cut time; text layers are `Dialogue` events in the caption file
(layer 1, the caption font and plate). An audio layer is trimmed to its window, faded, set to its
level, delayed to its start and mixed under the speech (with ducking the speech keys a
`sidechaincompress`); the mix replaces the body audio before the intro/outro are joined. A layer that
cannot be used is skipped with an event, and the "render with layers failed" retry drops them all.

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
| on the preview | drag a pane, drag / resize a layer, drag the caption or hook; double-click a text layer or the hook to retype it in place; right-click a layer for its menu (edit text, centre, whole clip, front / back, copy, duplicate, remove), the hook for its (edit text, centre, reset position, hide), the picture for the pane's crop (Set crop…: a box dragged, resized or drawn over the whole source frame, with the numbers beside it; back to automatic) | direct manipulation of what is drawn |
| timeline bar | Split (`⌘B`), Remove (`Delete`) on the left; transport, time, `[ In` / `Out ]` in the centre; snap toggle (`S`), zoom, Fit on the right | they act on the tracks or the playhead; nothing additive, nothing about the view |
| on the lanes | `+` on the Layers lane (image or video / text / sound / browse library), double-click the lane, right-click; intro / outro blocks and ghost chips on the clip lane; the clip block's length label opens the in / out editor (fields, ±1 s, ±0.1 s) | things are added and edited where they will show |
| inspector tabs | Captions, Framing (per section, per pane), Layers (per item), Details (title, hook, post caption, hashtags), Cuts, Transcript | long forms, lists, explanations |
| header | undo / redo, dirty state, layout toggle, copy link, shortcuts, theme, Save | document-level |

The snap toggle is persisted per browser (`rs-editor-snap`). On narrow screens the bar and the
header wrap into rows; nothing in them changes width while dragging (the snap pill has a minimum
width).
