# Clipping ranges of a long video — plan

Companion to [range-clipping.md](range-clipping.md). Check items off as they ship. Each slice ships its web screen,
MCP tool change, CLI flag and public copy together (PRINCIPLES: surfaces), behind no flag once merged.

Where the code is today:
- Ingest downloads the **whole** link (at `sourceHeightFor`'s preview height on Free) or keeps the whole upload;
  `admitSource` decides minutes on the full length and may set `projects.source_limit_sec` (partial: the start).
- Transcribe stops at `source_limit_sec` (`extractAudio(untilSec)`, `chunksFrom`), and the transcript records one
  contiguous `coveredSec` (now spans: 1.4).
- Analyze picks up to `processedEndSec` (packages/shared/src/partial.ts), or from `extend_from_sec` after an extend.
- Render already reads from a file plus offset (`renderSource` in pipeline/ranges.ts: full-quality windows,
  table `source_sections`). Transcribe, analyze, refine and the scans read one file via `ctx.ensureSource`.
- `extendProject` (projects/service.ts) moves the single limit forward by whole chunks.

## Slice 0 — Names and the seam (no behaviour change)

Goal: "window" names only a render's full-quality fetch, and no stage assumes one file covers the whole video.

- [x] 0.1 Rename the render-window module and its words to **windows**: `pipeline/sections.ts` → `pipeline/windows.ts`,
      `SECTION_PAD_SEC` → `WINDOW_PAD_SEC`, `SectionUnavailableError` → `WindowUnavailableError`, `rendersFromWindows`,
      `dropWindows`, `removeScratchWindows`. Metric (`reelsaw.source.section_bytes`) and event names stay: dashboards
      and webhooks read them. The table `source_sections` keeps its name (a rename migration buys nothing).
- [x] 0.2 `ctx.sourceAt(project, [startSec, endSec])` → `{ path, offsetSec }` in pipeline/common.ts (today: the stored
      source, offset 0) for every read by time: a render's fallback and a window's audio placement. The whole-video
      scans (scene cuts, text scan, transcription) call `ctx.wholeSource(project)`, the one name slice 3 replaces.
- [x] 0.3 Guard: `ensureSource` is `private` on the stage context, so the compiler refuses any other way in.

## Slice 1 — Ranges in, ranges billed (the whole file is still downloaded)

Goal: a person or a pipeline gives ranges; only they are transcribed, analyzed and counted. The largest saving
(transcription and the language model) lands here, before the download changes.

- [x] 1.1 Shared: `rangeSchema` (`startSec`, `endSec`, `mode`, `label?`, `ref?`) and pure `planRanges(input,
      { durationSec, maxClipSec, processed?, padSec?, fetchGapSec? })` → `{ ok, ranges, fetch, billedSec, changes }`
      or `{ ok: false, problems }` (packages/shared/src/ranges.ts), with `mergeSpans` / `subtractSpans` / `spansSec`,
      `parseClock` (now also the clip editor's time fields) and `parseRangeArg` for the CLI. Tests:
      apps/server/test/ranges-plan.test.ts. Named "ranges", not "sections": a clip's framing spans are already
      `sections` in `update_clip`.
- [x] 1.2 Migration 0068: `project_ranges` (`id`, `project_id`, `start_sec`, `end_sec`, `mode`, `origin` user | api |
      most_replayed | whole, `label`, `ref`, `billed_sec`, `picked_at`, `created_at`; index `(project_id, start_sec)`)
      and `clips.range_id` (set null on delete). `picked_at` rather than a run id: a retry starts a new run but must not
      pick again in ranges already picked from. Backfill: every project with a length gets one `whole` range
      `[0, least(source_limit_sec, duration_sec))`, picked when it has AI clips; clips inside it point at it. Ingest
      inserts the `whole` range for a new video, `extendProject` one per part it adds.
- [~] 1.3 Quota: `admitRanges` (quota.ts) admits a ranges project's billed seconds whole or refuses them ("These ranges
      are N minutes…", with the upgrade offer), never trimmed; a whole video keeps `admitSource` / `partialUntil`.
      Ingest settles chosen ranges once the file's length is known (`settleRanges`: clamp, merge, price, admit) in the
      unit that records the seconds, under the quota lock, and the ledger records the billed seconds. Tests:
      test/ranges-stack.test.ts (admit, refuse, other projects counted). Left: two ranges ingests of one account
      racing past the cap (a stack test with two concurrent ingests).
- [x] 1.4 Transcript coverage is spans: `transcripts.covered` (jsonb `[start, end][]`, migration 0069 copies
      `[0, coalesce(covered_sec, duration_sec)]`). Transcribe cuts each stretch the ranges need and the transcript lacks
      (`neededSpans` less `covered`) through `ctx.sourceAt`, chunks it on the source clock (rows keyed by offset in
      tenths of a second), and merges the words in time order (`mergeTranscript` moves every flag and soft-deleted
      fix with its words). Retry, re-pick, "Clip the rest" and clip bounds read `spansCover` / `spanWithin` over the
      ranges. `covered_sec` stays one release, written as before (`legacyCoveredSec`), so a previous-version process
      mid-rollout reads what it expects; dropped with 2.4. Report imports from before spans get `covered` derived.
- [ ] 1.5 Analyze picks inside **find** ranges only (generalise `extend_from_sec` to "ranges of this run": the
      ranges whose `run_id` is the current run). **Clip** ranges become clips directly: bounds snapped to the
      nearest sentence ends within the padding, `origin: "ai"`, `range_id` set, hook and title from the
      existing titling step. Every picked clip gets its range's `range_id`.
- [ ] 1.6 `assertWithinProcessed` (clips/service.ts) checks the clip lies inside a processed range, not before
      `processedEndSec`. `processedEndSec` and the `PartialSource` sentence read the ranges.
- [ ] 1.7 Surfaces, one service call each:
      tRPC `projects.create` / MCP `create_project` / `reelsaw create-project --range a-b[:clip]` take `ranges`;
      MCP `check_source` and `projects.checkSource` return the plan (`ranges`, `changes`); `get_project` returns
      `ranges[]` and each clip's `rangeId` and `ref`; webhook `clip.done` carries `rangeId` and `ref`.
- [ ] 1.8 Web, NewProject.tsx: Whole video / Ranges toggle, the shadow timeline (track, ruler, click to add,
      drag ends, typed start and end, mode per range, remove), and the "Before you start" panel fed by the same
      `checkSource` call (debounced; the panel's height is reserved so nothing shifts). Phone: tap to add, drag
      handles ≥ 44 px, the start bar pinned at the bottom (`h-dvh` layout, docs/UI.md).
- [ ] 1.9 Evals: an analyze suite case with two find ranges asserts no pick outside them; `--offline` covers the
      exact-clip snapping.
- [ ] 1.10 Copy: README feature list, `website/content/` (the "long videos" page), docs/SELECTION.md (how picking is
      bounded), the MCP server instructions line in mcp-tools.ts.

## Slice 2 — Add a range later

Goal: a finished project grows by ranges; today's "Clip the rest" is one of them.

- [ ] 2.1 `extendProject(svc, actor, id, { ranges? })`: plans the new ranges against the processed ones (only
      new time is billed, `recordSourceExtension` with that), inserts them with the new `run_id`, and starts the run
      from transcribe (or ingest when the source expired). No ranges: today's next-part range from `partialUntil`.
      `after-upgrade.ts` `finishPartialWork` unchanged in behaviour.
- [ ] 2.2 MCP `extend_project { id, ranges? }`, `reelsaw extend-project <id> --range …`, tRPC `projects.extend`.
- [ ] 2.3 Project page (Project.tsx): the timeline with processed ranges, clip marks inside them and hatched
      time; drag across hatched time → "New range" popover (mode, cost from `checkSource`, Clip this range);
      clips grouped by range; `#range=<id>` deep link scrolls to and highlights it; "Find more in this range"
      runs analyze for that range only (`reanalyze_project { rangeId }`).
- [ ] 2.4 `partial.ts` keeps its exports for one release, reading the ranges; then the `source_limit_sec`,
      `extend_from_sec` and `transcripts.covered_sec` columns are dropped in a follow-up migration once nothing reads them.

## Slice 3 — Fetch only the ranges

Goal: a link's ranges are the only bytes downloaded. Riskiest slice: spike first.

- [ ] 3.1 Spike (1 day, notes in this file): yt-dlp `--download-sections` with and without
      `--force-keyframes-at-cuts` on a 3 h YouTube VOD, a Twitch VOD and a Vimeo link: wall time, bytes, and the
      error between the requested start and the first frame (ffprobe `start_time`, audio cross-check). Decide
      re-encode-at-cuts versus measured offset per piece.
- [ ] 3.2 Ingest for a ranges link: no whole download. For each planner `fetchPiece` (padded, close ranges
      grouped), download through the proxy pool (reuse windows.ts `downloadPiece` minus `placeWindow`, which needs a
      preview), at `sourceHeightFor` height, store as a `source_pieces` row (`project_id`, `start_sec`, `end_sec`,
      `offset_sec`, `key`, `bytes`, `height`). Storage and `assertStorageRoom` count the pieces.
- [ ] 3.3 `sourceAt` returns the piece covering a span (error when none does: a stage asked for unfetched time);
      `ensureSource` is refused for a pieces project. Thumbnail and poster come from the first piece.
- [ ] 3.4 Render: Free renders full quality from windows as today (windows are inside pieces' spans); paid plans
      with no preview fetch pieces at full height and render from them directly.
- [ ] 3.5 Editor playback: `/media/source/:projectId` serves a piece by `?at=<sec>`; the editor's source player
      switches piece at range edges and maps `currentTime` through `offset_sec`. Hatched time is not seekable.
- [ ] 3.6 Retention and re-fetch: an expired pieces project re-fetches only its pieces; `reelsaw status` and Settings
      → System show pieces bytes.
- [ ] 3.7 Uploads: unchanged (whole file stored); `sourceAt` returns it with offset 0.

## Slice 4 — Most replayed

- [ ] 4.1 The length probe (`announcedDuration`) keeps yt-dlp's `heatmap` from the same JSON; stored in
      `source_meta.heatmap` (bins only) at create.
- [ ] 4.2 Shared `replayPeaks(heatmap, { top, minGapSec })`: local maxima above the median, widened to where the
      curve falls under half the peak, merged by the planner. Tests on recorded heatmaps (fixtures, no network).
- [ ] 4.3 `check_source` returns `mostReplayed[]`; `create_project { rangesFrom: { mostReplayed: n } }` and
      `reelsaw create-project --most-replayed n` add the top peaks as clip ranges (`origin: most_replayed`);
      refused with a reason when there is no heatmap.
- [ ] 4.4 Web: heatmap bars on both timelines; peak chips (rank and time) toggle ranges; hidden when absent.
- [ ] 4.5 Telemetry: `project.ranges` (count, billed minutes, share of the video, origins) for the funnel; no
      per-user detail in public copy.

## Done when
- A 3 h link with three ranges downloads, transcribes and bills about the ranges' length plus padding, and its
  clips render at the plan's full quality.
- The same ranges given on the timeline, over MCP and on the CLI produce the same plan, price and clips.
- A pre-existing partial project behaves as before, and "Clip the rest" is a range.
- No stage reads source media except through `sourceAt`.
