# Layer templates: overlays and sounds that fit any clip length

## Job
When I have a look I like (a logo pop in the first seconds, a follow sticker, a progress bar, a music
bed, a "link in bio" card at the end), I want to save it once and put it on every clip, whatever the
clip's length, without placing each layer by hand. Today layers are per clip, in absolute source seconds,
so the same look is rebuilt clip after clip.

## Prior art (Oct 2026)
Every system that solved "one graphic, any duration" landed on the same model: **fixed head and tail,
elastic middle**. After Effects' Responsive Design – Time keeps *protected regions* (intro, outro) at
their length and stretches the rest; audio is excluded from stretching. Final Cut / Motion titles have
Build In / Build Out markers; the common complaint is builds that stretch with the title's length, fixed
with "mandatory" markers. Creatomate's auto-arrangement sizes static elements to "fill the remaining
time". CapCut templates do the opposite (footage is trimmed to the template's fixed slots), which is wrong
for clipping, where the content decides the length. OpusClip's brand template has a whole-clip logo/CTA
overlay and an "auto headline in the opening seconds", no timed layers, no sounds. Nobody documents a
length-adaptive overlay template; that is the gap.

Short-form structure is fixed-time at the edges: the keep-or-swipe decision falls in the first 1–3 s, the
CTA sits in the last few seconds, and a viewer reads at the same speed on a 15 s and a 90 s clip. So a
hook sticker is "first 3 s", a CTA is "last 4 s", a watermark is "whole clip". Pure proportional scaling
would turn a 3 s hook on a 20 s clip into a 9 s hook on a 60 s clip. Proportional placement exists as one
mode per layer, never the default.

## Decisions
1. **Templates are materialised, never referenced at render.** Applying a template writes ordinary
   `clips.layers` (through `cleanLayers`, with `asset_refs` rows, `editedAt` set so a re-analyze keeps the
   clip). The renderer, the editor's Layers lane, copy/paste, undo and `asset_refs` are unchanged. A clip
   keeps no pointer to the template: its layers are its own afterwards, like a pasted layer. Re-applying
   after a retrim is the user's explicit action (apply again, mode replace).
2. **A template layer is a clip layer whose window is a timing, not seconds** (`templateLayerSchema`,
   `packages/shared`): the same `kind` / `assetId` / `text` / position / size / sound fields, plus
   `timing`:

   | mode | `start` / `end` mean | for |
   |---|---|---|
   | `head` | seconds after the clip starts (end above start) | logo pop, hook sticker, whoosh |
   | `tail` | seconds before the clip ends (start above end; `end` 0 = the very end) | CTA, follow card, outro swipe |
   | `fill` | the whole clip | watermark, progress bar, music bed |
   | `relative` | fractions 0–1 of the clip length, held between `minSec` / `maxSec` | a mid-clip pattern interrupt |

   `templateWindow(timing, len, kind)` gives the window on a clip `len` seconds long, clamped to the clip;
   a layer with no room (a tail longer than the clip, a relative window under the layer minimum) is left
   out and counted (`layersSkipped`, the apply result says so). Overlapping head and tail windows on a
   very short clip are both kept: overlapping layers are legal on the lane and visible. Music is a `fill`
   audio layer with `loop` on and a fade: it is cut to length, never time-stretched (Adobe's rule).
3. **Length basis is the clip's source span** (`endSec - startSec`), the ruler the editor shows. Jump cuts
   shorten the rendered body by at most a few seconds; `mapTime` already moves every layer into post-cut
   time at render, exactly as it does for hand-placed layers.
4. **From a clip** (`templateFromLayers`): a layer that spans the clip fills; one touching the start is
   head; one touching the end is tail; anything else is anchored to the nearer edge *with its length* (a
   sticker three seconds in stays three seconds long). Nothing is made proportional by default; the user
   switches a layer to Proportional in the template editor.
5. **Precedence chain** (PRINCIPLES "one chain per setting"): Settings → Project defaults
   `layerTemplateId` → snapshotted into `projects.settings.layerTemplateId` at creation → every clip the
   project creates afterwards (analyze picks, manual clips once prepared) gets the template's layers.
   Existing clips are never changed by a settings change: `apply_layer_template` / the selection bar does
   those, explicitly. A removed template is dropped from the user's defaults; a project that still names
   it creates clips without layers and logs a warning (never fails).
6. **Storage.** `layer_templates (id, user_id, name, layers jsonb, created_at, updated_at, deleted_at)`,
   migration `0042_layer_templates`. Soft delete, restorable for 30 days (`restore_layer_template`). The
   asset purge keeps any asset a live template names (a `jsonb_array_elements` exists-check beside the
   `asset_refs` one; the table is small and per user). Templates are not in `asset_refs`: that table is
   keyed by project.
7. **Smart layers come later, not first.** A later phase can mark a template layer "smart": placed by the
   renderer against the clip's framing (away from the followed face, inside the platform safe zones,
   opposite the captions) instead of at a fixed `x`/`y`. The data model leaves room (`timing` is one field
   among the layer's own; a `placement` field would sit beside it) and nothing in this phase depends on
   it. Build the fixed-position template first and learn from use.

## What the user sees
- **Templates page** (`/templates`, nav next to Library; `#template=<id>` deep link): a list of templates
  (name, layer count, updated), New template, and per row Edit / Rename / Duplicate / Remove. Removed
  templates are restorable from Deleted (`/deleted`) for 30 days. Loading is a skeleton, empty is a sentence only after the query resolves.
- **Template editor** (`/templates/:id`): the clip editor slimmed to what a template is. A 9:16 canvas with
  a neutral stand-in frame (no source video), the Layers lane (reused `Timeline`, one "auto" section, no
  words or scene cuts, clip handles disabled) and the Layers inspector (reused `LayerCard` fields plus a
  **Timing** row: Segmented From the start / Before the end / Whole clip / Proportional, with the mode's
  fields). A **Preview length** control (15 / 30 / 45 / 60 / 90 s) re-lays the lane and the canvas so the
  user sees the template stretch and contract; dragging a block edits the timing in the current mode
  (seconds from the anchor, or fractions). Save writes `layerTemplates.update`; the unsaved-changes guard
  is the editor's.
- **Putting a template on a clip is one dialog everywhere** (`ApplyTemplateDialog`, `TemplatePicker.tsx`):
  the templates as cards, each with a small map of where its layers sit on the 9:16 frame and a line per
  layer ("copia-qr · First 3 s", "“Link in bio” · Last 4 s", "Music · Whole clip"), so the choice is not
  blind. The Keep-and-add / Replace question (two radio rows, Keep the default) appears only when the
  target already has layers, worded with the count ("This clip has 3 layers." / "4 of the 10 selected
  clips already have layers."); a clean clip gets no question, and a template never wipes hand-placed
  layers unless Replace is chosen. Second design pass: the first cut had three plain dropdowns, asked
  Replace / Add on every clip with Replace preselected (so the lane's `+` → Template wiped the clip's
  layers), could wipe hand-placed layers from the selection bar without saying so, and left nothing
  selected after applying in the editor.
  - **Clip editor**: "Template" sits in the Layers tab's add row, in the lane's `+` menu and in the lane's
    right-click menu, because a template is a set of layers (editor-tracks rule: a control sits next to the
    thing it changes). Applying
    writes into the editor's document (one undo step, saved with the clip), selects the first new layer and
    parks the playhead on it so the canvas shows the change. "Save as template…" sits under the layer cards
    (`templateFromLayers` decides the timings; the Templates page fixes them).
  - **Project page**: a clip card's ⋯ menu has "Layer template…" next to "Intro / outro…" (one clip,
    server side, Apply or Apply & re-render); the selection bar's "Template…" slot does the same for the
    selection (`layerTemplates.applyToClips`; `apply` is a word tRPC reserves). Both say what happened in
    one sentence (updated, re-rendering, skipped while preparing, layers without room).
- **Settings → Project defaults** and **Project settings**: a "Layer template" row (None / a template) with
  the sentence "Applies to clips created from now on. Existing clips: select them and choose Template…".

## Surfaces
| what | web | tRPC | MCP | CLI |
|---|---|---|---|---|
| list / get | Templates page | `layerTemplates.list` / `get` | `list_layer_templates` | `reelsaw templates list` / `show <id>` |
| create (from layers or a clip) | editor "Save as template…", page "New template" | `create` / `fromClip` | `save_layer_template { name, clipId \| layers }` | `templates save <projectId> <clipId> <name…>` |
| edit | template editor | `update` | `update_layer_template` | `templates rename <id> <name…>` / `templates set <id> --layers '<json>'` |
| remove / restore / purge | page (toast: Undo / Wipe / See deletions); restore and wipe on Deleted (compact bar, Wipe in ⋯) | `remove` / `restore` / `purge`; bulk `deleted.restore` / `deleted.purge` | `remove_layer_template` / `restore_layer_template` / `purge_layer_template` | `templates remove <id>` / `restore <id>` / `purge <id>` |
| apply to clips | editor, selection bar | `applyToClips` | `apply_layer_template { templateId, projectId, clipIds?, mode, rerender }` | `templates apply <templateId> <projectId> [clipId…] [--add] [--rerender]` |
| default for new clips | Settings, project settings | `me.updateProjectDefaults`, `projects.update { settings.layerTemplateId }` | `update_project { settings: { layerTemplateId } }` | `update-project` |

One implementation: `apps/server/src/library/templates.ts` (`listLayerTemplates`, `createLayerTemplate`,
`updateLayerTemplate`, `removeLayerTemplate`, `restoreLayerTemplate`, `purgeLayerTemplate`, `layerTemplateFromClip`,
`applyLayerTemplate`, `templateForNewClips` + `layersForNewClip` for the pipeline); the pure parts
(`templateWindow`, `resolveTemplateLayers`, `templateFromLayers`, `timingText`) live in `packages/shared`
so the editor previews exactly what the server writes. `cleanLayers` moved from the router to
`library/layers.ts` so the apply path and `clips.update` store layers the same way.

## Must-be
- Applying never fails a clip: a layer without room is skipped and counted; an asset that is gone is
  skipped at render as today (`clip.overlay_skipped`). A clip still being prepared is skipped with a reason.
- Clips are locked in id order in one transaction with their `asset_refs` rewrite; re-renders only for
  finished clips and only when asked.
- No layout shift on the Templates page. The clips selection bar stays one compact row; Template… is in its ⋯ menu.
- Works at 390 px: the template editor stacks like the clip editor's compact layout.

## Open
- Smart (framing-aware) placement, decision 7.
- A template thumbnail (render the canvas at 30 s to a PNG) for the list and the pickers.
- Sharing templates between accounts or shipping a few in the catalog.
