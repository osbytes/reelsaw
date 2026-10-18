# Intro and outro scenes (bumpers)

## Job
When I publish clips, I want my own intro and/or outro (a short video, or an image shown for a few
seconds) attached to every clip automatically, so that every export is on-brand without opening
another editor. Today branding is added by hand. Appetite: about 3 days for phase 1.

## Goals
- Upload once in Settings; new projects use it. Every clip is `intro + clip + outro` in one MP4 with
  today's size, fps and audio format, no visible seam, no audio click.
- A project can turn it off or pick another; one clip can opt out; changes re-render normally.

## Non-goals
- Animated templates, text on a bumper, watermarks over the clip, per-clip custom bumpers.
- Transitions beyond a hard cut (phase 1); trimming or cropping the bumper in the editor.

## Must-be
- Captions, hook and cuts are untouched. Deleting an asset never breaks a render. An unusable bumper
  never fails a clip (it renders without it and says so). No layout shift; works at 390 px.

## What the user sees

### Where it is set
- **Settings > Project defaults**: "Intro" and "Outro" rows (`userProjectDefaultsSchema`,
  `me.updateProjectDefaults`). Applies to new projects only, like every other default.
- **Project settings**: same rows with Default / Custom / None. A change asks "Re-render N clips?"
  like other style changes.
- **Per clip**: each clip can choose its own intro and outro, per slot: Project default (inherit),
  None, or a library asset. This replaces the earlier all-or-nothing opt-out, so "only an intro, only
  on these clips" is expressible. The choice is stored on the clip (`clips.bumpers`), so it survives
  pipeline re-runs. Set it in the editor (two selects under the transport), from the clip card's
  ⋯ menu ("Intro / outro..." dialog), or for many clips at once from the selection bar's "Intro/outro..." popover
  (`#sel=id1,id2` in the hash, `clips.setBumpersMany`). Each goes through Save / Save & re-render.

### Accepted assets and limits
| Type | Accepted | Limits |
|---|---|---|
| Video | mp4, mov, webm | at most 10 s, at most 50 MB, any size/fps/codec ffmpeg reads |
| Image | png, jpg | shown 1 to 10 s, default 3 s, user sets seconds |
| Sound (phase 3) | mp3, m4a, wav | under an image, clipped to its length |

Checked server-side with ffprobe, not by file name. Errors are sentences: "This video is 14 s long.
Intros can be at most 10 s." The 50 MB cap sits under the existing `MAX_UPLOAD_MB`.

### Mismatched aspect ratio (automatic)
The canvas is fixed 1080x1920 at 30 fps (`OUT_W`/`OUT_H`, `-r 30` in `render.ts`). The bumper is
scaled to fit inside it and the bands are filled with a blurred enlarged copy of the same frame.
That is exactly the existing `FIT_CHAIN` in `render.ts`, so it is reused, not rewritten. The preview
says "Fitted to vertical with a blurred background." No crop option: cropping a logo is a wrong
automatic edit, blur-fill removes nothing.

### Audio
Video bumpers keep their audio; silent video and images get generated silence. Audio is sequential, never
mixed: the clip does not play under the outro, and its last 0.2 s fades out when an outro follows.
Loudness is not changed; a bumper far louder than speech gets a plain warning in the preview.

## Data model
New table `bumper_assets` in `db/schema.ts` (`npx drizzle-kit generate --name bumper_assets`):
`id`, `user_id` (references user, cascade), `kind` (video|image), `name`, `duration_sec`, `width`,
`height`, `has_audio`, `source_key` (`bumpers/{id}/source{ext}`), `size_bytes`, `created_at`,
`deleted_at`.

Assets are immutable: replacing one is a new row and new id. That makes a cache keyed by id correct and
answers "which version did this clip use".

Settings (shared zod; rebuild `@reelsaw/shared`):
- `projectSettingsSchema`: `introAssetId`, `outroAssetId`, each `string | null | undefined`. Unset =
  nothing; `null` = "None, although my default has one".
- `userProjectDefaultsSchema`: the same two fields. `resolveProjectSettings` copies them into the new
  project, so later default changes never alter old projects.
- `clips.bumpers jsonb` (nullable): `{ intro?: string | null, outro?: string | null }`. A missing key
  inherits the project, `null` means none, a string is a library asset. Resolved by the pure
  `resolveClipBumpers(project, clip)` in `pipeline/bumpers.ts`. (An interim `bumpers_off` boolean
  shipped first; its migration maps `true` to `{"intro":null,"outro":null}` and drops it.)

Ownership is checked in the same transaction as the write (`user_id = ctx.user.id`).

### Upload path (no new route)
1. Web calls the existing `POST /api/upload` through `uploadFile` (`lib/uploads.tsx`); it returns an
   `uploadId` and an `uploads` row (`uploads/{id}{ext}`).
2. New tRPC `bumpers.create({ uploadId, imageSeconds? })`, one unit of work: load the upload for this
   user, ffprobe, enforce type and limits, insert the row, copy the file to `bumpers/{id}/source{ext}`
   in `u.afterCommit`.
3. `bumpers.list`, `bumpers.delete` (sets `deleted_at`), `bumpers.restore`.

### Soft delete
Delete hides the asset from pickers and defaults, but render still resolves soft-deleted ids, so
projects using it keep working. The UI shows "Used by N projects" first and offers restore. The web offers Undo in a toast
for about 8 s after removal. The storage sweep (hourly, or `reelsaw storage sweep`) hard-deletes assets deleted over
30 days ago that no project setting or clip references, with their `bumpers/<id>/…` objects and local cache.

### Duplicates
`bumper_assets.content_hash` is the sha256 of the uploaded file, computed in `bumpers.create`. A live asset with the
same hash is returned with `duplicate: true` instead of inserting; a soft-deleted one is restored (`restored: true`).
Assets added before this column have a null hash and are not backfilled, so re-uploading one of those is not caught.

## Render pipeline

### Today
One `filter_complex` (layout chains, piece `concat`, `ass=` captions, label `[v]`), one libx264 veryfast
crf 21 / AAC 48 kHz encode to `clips/{clipId}.{gen}.mp4` via `.tmp.mp4`, thumbnail at one third,
commit only while `render_gen` is current.

### Chosen: normalise once, concat in the same single encode
1. **Normalise per asset, once.** Produce `bumpers/{id}/norm.v1.mp4`: 1080x1920, 30 fps CFR, yuv420p,
   AAC stereo 48 kHz (silence if none), blur-fill as above, exact duration; images become an N-second
   video. `v1` is a constant tied to the canvas and encode settings in `render.ts`; bump it if those
   change, so the cache cannot mismatch. Write to a temp name, then rename; if the key exists, skip
   (idempotent, and two racing renders converge). Cost: seconds, once per asset, not per clip.
2. **Concat in the existing graph.** Rename the current final label `[v]` to `[body]`, add the
   normalised files as extra `-i` inputs, append
   `[iv][ia][body][ca][ov][oa]concat=n=3:v=1:a=1[v][a]`, and map `[v]` and `[a]`. The no-cuts branch
   maps `0:a:0?` (audio optional); with bumpers it must get a guaranteed audio label
   (`anullsrc` when the source has none), because concat needs audio in every slot.
3. Everything is encoded once, by the encode that already exists.

### Why not the alternatives
- **Demuxer concat, stream copy:** needs identical codec params, GOP and timebase, and AAC encoder
  delay gives a gap or click at each join, on every clip. It also forces a separate body file.
- **Body first, then a second re-encoding pass:** encodes the clip twice (quality loss, double time).

### Render time
About the cost of encoding the extra seconds, plus one-time normalisation. Progress divides by
`outDuration`; it must include intro and outro or the bar finishes early. Measure on a fixture.

### Render generations and idempotency
- Naming is unchanged: `{clipId}.{gen}.mp4`, committed only while `render_gen` is current. Bumper
  ids are read at job start from `projects.settings` and `clips.bumpers`, and recorded in
  `clips.diagnostics` (`bumpers: { introId, outroId, introSec, outroSec }`) so reports and the CLI show
  what was attached.
- A change is `rerenderClips` -> `requestRender` (bumps `render_gen`, cancels live jobs, enqueues, one
  commit). No new transition.
- Normalised files are content-addressed by asset id, not generation, so a superseded render never
  creates or deletes one. They are a derived cache, not row-referenced files.

### Failure rule
A missing, unreadable or un-normalisable asset means the clip renders without that bumper, with the
event "Intro skipped: the file could not be read" (raw error one click away) and "no intro" on the card.

### Thumbnails and captions
- Thumbnail is a still of the clip body: seek `introSec + outDuration / 3` in the final file (today
  `outDuration / 3` would grab the intro).
- Captions and the hook are burned by `ass` before the concat, on the body's own timeline, so intro
  length never shifts them. Burning after the concat would need every event shifted and would put
  captions over the bumpers.

## Export and metadata
`export.ts` writes `start_sec`/`end_sec` as source positions and `durationSec = endSec - startSec`.
These stay about the source and exclude bumpers (parent timestamp links depend on them). Add
`rendered_duration_sec` (from `diagnostics.outDurationSec` plus bumpers) to the JSON and CSV for people
checking platform length limits, and a README line saying clips include the intro/outro. The zip layout
is unchanged.

## Frontend
- **Settings:** a `BumperField` in `ProjectDefaultsSection` using `uploadFile` and its progress. Shows
  thumbnail, name, duration, the fit note, Replace / Remove. The preview is a `<video>` or `<img>` in a
  fixed 9:16 box so nothing moves when the file arrives. Images get a seconds field. Remove confirms
  with the project count.
- **Project settings:** same field with Default / Custom / None; status in an always-present line; the
  existing re-render prompt.
- **Editor:** `ClipEditor` plays the source video (not the render) and `Timeline` edits source ranges,
  so bumpers would be fake segments the user can't edit. Show a fixed-height label row above the
  transport: "+ intro 2 s  + outro 3 s" (or "No intro or outro" with an Add link). Rendered MP4s on clip
  cards and downloads include them naturally.
- Tokens only, `ScrollArea` for lists, labelled icon buttons, status as glyph plus word.

## API, MCP, CLI
tRPC `bumpers.*`; the ids ride on project settings and user defaults. MCP gets optional ids on project
creation and read-only `list_bumpers` (uploading stays in the web UI). CLI: `reelsaw bumpers`.

## Edge cases
- Source without audio: body gets generated silence, so concat always has audio.
- VFR or rotated phone video: normalising forces 30 fps CFR and autorotates. GIF/WebP: rejected.
- Imported issue report: asset ids don't exist locally; the failure rule skips them.

## Plan
**Phase 1 (smallest useful slice, ~2 days):** video bumpers only, intro and outro, one each per user,
applied to new projects. Schema + migration, `bumpers.create/list/delete` reusing `/api/upload`,
normalise + cache, one-pass concat, thumbnail offset, progress total, diagnostics, failure rule,
Settings upload/preview/remove, `rendered_duration_sec`. Verify on a fixture: duration equals intro +
body + outro within a frame, no click at the seams (ffprobe packet timestamps plus a listen), caption
timing identical to a render without bumpers.

**Phase 2 (~1 day):** image bumpers with seconds, project override with re-render prompt, per-clip
selection (inherit / none / asset per slot, replacing the opt-out) with bulk apply and a card
popover, editor label, a library of several assets with restore, "Used by N projects".

**Phase 3:** image + sound, loudness warning, MCP and CLI (done: `list_bumpers`, `add_bumper`, `set_default_bumper`, `remove_bumper`, `restore_bumper`, `bumper_usage`, `set_project_bumpers`, `set_clip_bumpers`, effective bumpers in `get_project`/`get_clip`; `reelsaw bumpers|project-bumpers|clip-bumpers`), cleanup job, optional 0.15 s crossfade.

## Risks
- Concat needs audio in every slot; the no-cuts branch has optional audio today.
- Future changes to canvas, fps or audio rate in `render.ts` must bump `norm.vN`.
