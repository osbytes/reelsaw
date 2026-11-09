# Fades and transitions

## Job
When I publish a clip, I want it to fade in and out (and the intro and outro to blend into it) the way I would do it
in my own editor, so that I don't have to re-edit every export. Asked for by a user ("just fading in and out of the
video, something basic").

## What ships
Three places a transition can go, each burned into the clip's one encode:

| Where | Setting | Effect |
| --- | --- | --- |
| Start / end of the video | style `fadeIn`, `fadeOut` (seconds, 0-2, default 0 = off) | Picture from / to black and sound from / to silence. Applied to the finished video, so with an intro the fade-in is on the intro's first frame and with an outro the fade-out is on the outro's last. Captions, hook and layers fade with the picture. |
| Intro / outro join | style `bumperTransition` (`cut`, `dip`, `crossfade`), `bumperTransitionSec` (0.2-2, default 0.5) | `dip` fades the outgoing piece to black over half the length and the incoming one up over the other half, so the video keeps its length. `crossfade` overlaps the two (`xfade` + `acrossfade`), so the video is shorter by the length at each join and the clip starts that much earlier. `cut` is the straight join from before (with the body's 0.2 s audio tail fade before an outro). |
| Picture and text layers | layer `fade` (seconds, 0-2) | The layer fades in when its window opens and out when it closes: the overlay's alpha (`fade=...:alpha=1`) for an image or video, ASS `\fad` for text. Sound layers already had their own `fade`. |

Not in this change: transitions at the source's own shot cuts (a dip at a detected cut works without extra footage; a
crossfade there would have to blend frames on both sides and shorten the clip), and crossfades at transcript cuts
(those have the source on both sides). Both are follow-ups on the same model.

## Decisions
1. **The fades are style, not a new setting family.** They sit in `styleSchema`, so they follow the style's precedence
   (project, then the clip's override), "Apply style to: This clip / All clips" in the editor, `update_clip { style }`,
   `update_project_style`, `reelsaw update-style --set fadeIn=0.5` and Project defaults without new plumbing. `get_clip`
   returns them in `style.effective`.
2. **Off by default.** The first second of a short is the hook, and a platform loop shows a fade to black as a seam.
   The editor says so next to the controls instead of refusing or nudging.
3. **Presets, not a slider.** Off / Quick 0.3 s / Smooth 0.6 s / Slow 1 s cover what editors use (a 30-frame cross
   dissolve is the classic default); any value 0-2 s still works over MCP and the CLI and shows as seconds in the label.
4. **Fitted, never refused.** `planTransitions` (bumpers.ts) clamps: a join is at most half of the shorter side, each
   fade at most half of the video. The render, its `transitions` debug line and `diagnostics.transitions` all read the
   same plan, and the SRT/VTT export and the thumbnail use its `bodyStartSec`.
5. **The preview plays it.** While the clip plays, the editor dims the picture and the source's volume along the same
   curve (`fadeLevel`, `bodyEdgeFades` in @reelsaw/shared); paused, it shows the full frame so captions can be placed.
   "Play start" / "Play end" jump to the edges. A paused, selected layer shows at full opacity for the same reason.
6. **No layout shift.** The join's length control is always present and greyed out for a cut or with no intro/outro.

## Tests
`apps/server/test/bumpers.test.ts` encodes real joins with ffmpeg: lengths for dip and crossfade, a black frame at a
dip's midpoint and none in a crossfade, black and silent first frames, and fades with no bumpers. `editor-tracks.test.ts`
covers the layer alpha fade and `\fad`.
