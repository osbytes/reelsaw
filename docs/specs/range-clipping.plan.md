# Clipping sections of a long video — plan

Companion to [range-clipping.md](range-clipping.md). Check items off as they ship. Each slice ships its web screen,
MCP tool change, CLI flag and public copy together (PRINCIPLES: surfaces), behind no flag once merged.

Where the code is today:
- Ingest downloads the **whole** link (at `sourceHeightFor`'s preview height on Free) or keeps the whole upload;
  `admitSource` decides minutes on the full length and may set `projects.source_limit_sec` (partial: the start).
- Transcribe stops at `source_limit_sec` (`extractAudio(untilSec)`, `chunksFrom`), and the transcript records one
  contiguous `coveredSec`.
- Analyze picks up to `processedEndSec` (packages/shared/src/partial.ts), or from `extend_from_sec` after an extend.
- Render already reads from a file plus offset (`renderSource` in pipeline/sections.ts: full-quality windows,
  table `source_sections`). Transcribe, analyze, refine and the scans read one file via `ctx.ensureSource`.
- `extendProject` (projects/service.ts) moves the single limit forward by whole chunks.

## Slice 0 — Names and the seam (no behaviour change)

Goal: "section" means one thing, and no stage assumes one file covers the whole video.

- [ ] 0.1 Rename the render-window module and its words to **windows**: `pipeline/sections.ts` → `pipeline/windows.ts`,
      `SECTION_PAD_SEC` → `WINDOW_PAD_SEC`, `SectionUnavailableError` → `WindowUnavailableError`, metrics and log text.
      The table `source_sections` keeps its name (a rename migration buys nothing); its schema comment says "render windows".
- [ ] 0.2 `ctx.sourceAt(project, [startSec, endSec])` → `{ path, offsetSec }` in pipeline/common.ts; today it returns
      `ensureSource` with offset 0. Move transcribe, analyze (scene and text scans), refine, faces and speaker
      sampling to it; `renderSource` keeps its own lookup and falls back to `sourceAt`.
- [ ] 0.3 Guard: a lint rule (or `pnpm guards` grep) fails a new `ensureSource(` outside common.ts and windows.ts.

## Slice 1 — Sections in, sections billed (the whole file is still downloaded)

Goal: a person or a pipeline gives sections; only they are transcribed, analyzed and counted. The largest saving
(transcription and the language model) lands here, before the download changes.

- [ ] 1.1 Shared: `sectionSchema` (`startSec`, `endSec`, `mode`, `label?`, `ref?`) and pure `planSections(input,
      { durationSec, maxClipSec, padSec, fetchGapSec })` → `{ sections, fetchPieces, billedSec, changes[] }`
      (packages/shared/src/sections.ts). Unit tests for every row of the spec's rules table.
- [ ] 1.2 Migration: `project_sections` (`id`, `project_id`, `start_sec`, `end_sec`, `mode`, `label`, `ref`,
      `origin` user | api | most_replayed | whole, `run_id`, `created_at`; index `(project_id, start_sec)`) and
      `clips.section_id` (nullable, set null on delete). Backfill: every project gets one `whole` section
      `[0, coalesce(source_limit_sec, duration_sec))` so the code below has no "no sections" branch.
- [ ] 1.3 Quota: `admitSource` takes billed seconds (the planner's `billedSec`) instead of the length; the ledger
      row records them. A sections project over the room is refused (`QuotaExceededError` with seconds to remove),
      never trimmed; a whole-video project keeps `partialUntil`. Tests: two sections ingests of one account under the
      quota lock cannot jointly pass the cap.
- [ ] 1.4 Transcript coverage becomes spans: `transcripts.covered` (jsonb `[start, end][]`) replacing `coveredSec`
      (migration copies `[0, coveredSec]`). Transcribe extracts audio per padded section (`extractAudio` gains
      `fromSec`), keeps chunk offsets on the source clock, and appends words only inside spans not yet covered.
- [ ] 1.5 Analyze picks inside **find** sections only (generalise `extend_from_sec` to "sections of this run": the
      sections whose `run_id` is the current run). **Clip** sections become clips directly: bounds snapped to the
      nearest sentence ends within the padding, `origin: "ai"`, `section_id` set, hook and title from the
      existing titling step. Every picked clip gets its section's `section_id`.
- [ ] 1.6 `assertWithinProcessed` (clips/service.ts) checks the clip lies inside a processed section, not before
      `processedEndSec`. `processedEndSec` and the `PartialSource` sentence read the sections.
- [ ] 1.7 Surfaces, one service call each:
      tRPC `projects.create` / MCP `create_project` / `reelsaw create-project --section a-b[:clip]` take `sections`;
      MCP `check_source` and `projects.checkSource` return the plan (`sections`, `changes`); `get_project` returns
      `sections[]` and each clip's `sectionId` and `ref`; webhook `clip.done` carries `sectionId` and `ref`.
- [ ] 1.8 Web, NewProject.tsx: Whole video / Sections toggle, the shadow timeline (track, ruler, click to add,
      drag ends, typed start and end, mode per section, remove), and the "Before you start" panel fed by the same
      `checkSource` call (debounced; the panel's height is reserved so nothing shifts). Phone: tap to add, drag
      handles ≥ 44 px, the start bar pinned at the bottom (`h-dvh` layout, docs/UI.md).
- [ ] 1.9 Evals: an analyze suite case with two find sections asserts no pick outside them; `--offline` covers the
      exact-clip snapping.
- [ ] 1.10 Copy: README feature list, `website/content/` (the "long videos" page), docs/SELECTION.md (how picking is
      bounded), the MCP server instructions line in mcp-tools.ts.

## Slice 2 — Add a section later

Goal: a finished project grows by sections; today's "Clip the rest" is one of them.

- [ ] 2.1 `extendProject(svc, actor, id, { sections? })`: plans the new sections against the processed ones (only
      new time is billed, `recordSourceExtension` with that), inserts them with the new `run_id`, and starts the run
      from transcribe (or ingest when the source expired). No sections: today's next-part section from `partialUntil`.
      `after-upgrade.ts` `finishPartialWork` unchanged in behaviour.
- [ ] 2.2 MCP `extend_project { id, sections? }`, `reelsaw extend-project <id> --section …`, tRPC `projects.extend`.
- [ ] 2.3 Project page (Project.tsx): the timeline with processed sections, clip marks inside them and hatched
      time; drag across hatched time → "New section" popover (mode, cost from `checkSource`, Clip this section);
      clips grouped by section; `#section=<id>` deep link scrolls to and highlights it; "Find more in this section"
      runs analyze for that section only (`reanalyze_project { sectionId }`).
- [ ] 2.4 `partial.ts` keeps its exports for one release, reading the sections; then the `source_limit_sec` and
      `extend_from_sec` columns are dropped in a follow-up migration once nothing reads them.

## Slice 3 — Fetch only the sections

Goal: a link's sections are the only bytes downloaded. Riskiest slice: spike first.

- [ ] 3.1 Spike (1 day, notes in this file): yt-dlp `--download-sections` with and without
      `--force-keyframes-at-cuts` on a 3 h YouTube VOD, a Twitch VOD and a Vimeo link: wall time, bytes, and the
      error between the requested start and the first frame (ffprobe `start_time`, audio cross-check). Decide
      re-encode-at-cuts versus measured offset per piece.
- [ ] 3.2 Ingest for a sections link: no whole download. For each planner `fetchPiece` (padded, close sections
      grouped), download through the proxy pool (reuse windows.ts `downloadPiece` minus `placeSection`, which needs a
      preview), at `sourceHeightFor` height, store as a `source_pieces` row (`project_id`, `start_sec`, `end_sec`,
      `offset_sec`, `key`, `bytes`, `height`). Storage and `assertStorageRoom` count the pieces.
- [ ] 3.3 `sourceAt` returns the piece covering a span (error when none does: a stage asked for unfetched time);
      `ensureSource` is refused for a pieces project. Thumbnail and poster come from the first piece.
- [ ] 3.4 Render: Free renders full quality from windows as today (windows are inside pieces' spans); paid plans
      with no preview fetch pieces at full height and render from them directly.
- [ ] 3.5 Editor playback: `/media/source/:projectId` serves a piece by `?at=<sec>`; the editor's source player
      switches piece at section edges and maps `currentTime` through `offset_sec`. Hatched time is not seekable.
- [ ] 3.6 Retention and re-fetch: an expired pieces project re-fetches only its pieces; `reelsaw status` and Settings
      → System show pieces bytes.
- [ ] 3.7 Uploads: unchanged (whole file stored); `sourceAt` returns it with offset 0.

## Slice 4 — Most replayed

- [ ] 4.1 The length probe (`announcedDuration`) keeps yt-dlp's `heatmap` from the same JSON; stored in
      `source_meta.heatmap` (bins only) at create.
- [ ] 4.2 Shared `replayPeaks(heatmap, { top, minGapSec })`: local maxima above the median, widened to where the
      curve falls under half the peak, merged by the planner. Tests on recorded heatmaps (fixtures, no network).
- [ ] 4.3 `check_source` returns `mostReplayed[]`; `create_project { sectionsFrom: { mostReplayed: n } }` and
      `reelsaw create-project --most-replayed n` add the top peaks as clip sections (`origin: most_replayed`);
      refused with a reason when there is no heatmap.
- [ ] 4.4 Web: heatmap bars on both timelines; peak chips (rank and time) toggle sections; hidden when absent.
- [ ] 4.5 Telemetry: `project.sections` (count, billed minutes, share of the video, origins) for the funnel; no
      per-user detail in public copy.

## Done when
- A 3 h link with three sections downloads, transcribes and bills about the sections' length plus padding, and its
  clips render at the plan's full quality.
- The same sections given on the timeline, over MCP and on the CLI produce the same plan, price and clips.
- A pre-existing partial project behaves as before, and "Clip the rest" is a section.
- No stage reads source media except through `sourceAt`.
