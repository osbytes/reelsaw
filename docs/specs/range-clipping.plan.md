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
- [x] 1.2 Migration 0070: `project_ranges` (`id`, `project_id`, `start_sec`, `end_sec`, `mode`, `origin` user | api |
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
- [x] 1.4 Transcript coverage is spans: `transcripts.covered` (jsonb `[start, end][]`, migration 0071 copies
      `[0, coalesce(covered_sec, duration_sec)]`). Transcribe cuts each stretch the ranges need and the transcript lacks
      (`neededSpans` less `covered`) through `ctx.sourceAt`, chunks it on the source clock (rows keyed by offset in
      tenths of a second), and merges the words in time order (`mergeTranscript` moves every flag and soft-deleted
      fix with its words). Retry, re-pick, "Clip the rest" and clip bounds read `spansCover` / `spanWithin` over the
      ranges. `covered_sec` stays one release, written as before (`legacyCoveredSec`), so a previous-version process
      mid-rollout reads what it expects; dropped with 2.4. Report imports from before spans get `covered` derived.
- [x] 1.5 Analyze picks only in ranges not picked from yet (`project_ranges.picked_at`, set in the commit that adds
      their clips; re-analyze clears it). A **find** range is searched by today's picker with only its own sentences
      (plus padding), so no pick reaches time no range asked for. An **exact clip** range is inserted as an AI clip,
      its ends snapped to sentences inside the padding, and goes through prepare's exact mode (title, hook, caption,
      scores; bounds kept), which renders it. Every new clip gets `range_id`: the find range it overlaps most (a
      range shorter than the shortest clip holds a clip that runs into its padding). A whole-range project keeps the
      extension path; ranges added to a project picked from before converge like an extension (end-to-end with 2.1,
      which is what adds them).
- [x] 1.6 Clip bounds (`assertWithinProcessed`, clips/service.ts) check the ranges and covered spans since 1.4: a clip
      outside them is refused ("outside this project's ranges"), one in a range still transcribing waits. A ranges
      project never gets `source_limit_sec` (ingest sets it only for a whole video), so `processedEndSec`,
      `partialSourceOf`, the "Clip the rest" sentence and the after-upgrade follow-up treat it as not partial, which
      it is not. Left for 2.1: `extend_project` on a ranges project still answers "already covers the whole video".
- [x] 1.7 Surfaces, one service call each: `createProject` (tRPC `projects.create`, MCP `create_project`,
      `reelsaw create-project --range a-b[:clip]`) takes `ranges`, plans them against the announced length (looked up
      for ranges whatever the account's limits), admits them whole (advisory; ingest binds) and stores them
      (`origin` user from the web, api otherwise); the response adds `ranges`, `rangeChanges`, `billedSec`.
      `checkSource` (`check_source`, `reelsaw check-source --range`) prices them: `ranges { seconds, minutes, changes,
      problems }`, fits / refused like a video. `get_project` lists `ranges`; each clip has `rangeId` and `ref`;
      `clip.done` / `clip.failed` (events and webhooks) carry `rangeId` and `ref`. Shared modules index.ts imports
      values from never import index.ts back (test/shared-import-cycle.test.ts): the cycle left `rangeSchema`
      undefined in the bundle and refused every create.
- [x] 1.8 Web, New project: a "What to clip" section (Whole video / Ranges) once a link or file is given. Ranges draws
      the shadow timeline (components/RangeTimeline.tsx) from the length `check_source` looks up (`lookupLength`, and
      `durationSec` in its answer) or the file's own: click or tap to add a 3-minute range, drag either end (44 px
      handles, arrow keys on the focused end), a ruler; the list types exact times, picks Find clips / Exact clip per
      range and removes; under it, what the ranges count and skip, the planner's changes in words and the refusal with
      the upgrade offer, repriced as they change without moving anything (`keepPreviousData`, reserved heights). Ranges
      are sent in source order, so the server's "ranges 1, 2" are the ones numbered 1 and 2. The button says "Clip N
      ranges". Copy goes through lingui (en-XA checked); the track is `dir="ltr"`. Checked in the browser at desktop
      and phone width. Seen on the way, not changed: the page footer's summary and buttons overlap at phone width.
- [x] 1.9 Evals: the `selection` suite runs, on every stored transcript, `ranges-find` (a proposal every 1/80th of the
      video through `snapInRanges`: each kept pick lies inside its find range plus padding, a proposal overlapping no
      range is dropped, every range gets a pick) and `ranges-exact` (short and long exact ranges across the video snap
      inside their own padding, never to nothing), model-free (`--offline`): the bound is the snapper's, so no model
      run is needed to hold it. The first run caught picks that only grazed a range keeping their own start, up to 30 s
      before it, in production analyze too: a proposal is now cut to its range and padding before snapping and dropped
      if it still reaches past them. The range helpers (`rangeSegments`, `rangeOverlapping`, `snapInRanges`,
      `exactRangeBounds`) live in analyze.ts; the suite calls `snapInRanges` and `exactRangeBounds`.
- [ ] 1.10 Copy: README feature list, `website/content/` (the "long videos" page), docs/SELECTION.md (how picking is
      bounded), the MCP server instructions line in mcp-tools.ts.

## Slice 2 — Add a range later

Goal: a finished project grows by ranges; today's "Clip the rest" is one of them.

- [x] 2.1 `extendProject(svc, actor, id, { ranges })` (`addRanges`): plans the new ranges against the project's own
      (only time no range covers is billed), admits them whole against every project's minutes, records the
      extension, inserts them unpicked and restarts from transcribe (ingest when the source expired). Without ranges,
      today's next part; a ranges project asked for that is told to give ranges.
- [x] 2.2 MCP `extend_project { id, ranges? }`, `reelsaw extend-project <id> --range …`, tRPC `projects.extend`.
- [x] 2.3 Project page: a Ranges panel (components/ProjectRanges.tsx) when the project chose ranges or has time not
      processed yet: the timeline with what was processed (solid), its clips (marks) and hatched time; "Add a range"
      draws new ones, shows the new time they count, and "Clip N ranges" adds them (refusals with the upgrade offer
      inline). Clips are grouped under their range (number, times, label or mode); `#range=<id>` opens the page there.
      Picking again in one range: re-analyze picks in every range again (1.5); a per-range re-pick is not built.
- [ ] 2.4 (next release, by design) `partial.ts` keeps its exports for one release, reading the ranges; then the `source_limit_sec`,
      `extend_from_sec` and `transcripts.covered_sec` columns are dropped in a follow-up migration once nothing reads them.

## Slice 3 — Fetch only the ranges

Goal: a link's ranges are the only bytes downloaded.

- [x] 3.1 Spike (2026-11-22, Big Buck Bunny on YouTube, inside the app container): `--download-sections "*120-150"`
      with and without `--force-keyframes-at-cuts` both start at source 120.00 s against the full download (audio
      envelope correlation 1.0 / 0.999), each 30.0 s; plain is as fast. So a section is placed at its requested start,
      no audio alignment or re-encode at cuts. The format chosen without the app's preference was AV1 / Opus, so the
      app's `sourceFormat` (H.264 / AAC first) matters for joining. Not tried: Twitch, Vimeo.
- [x] 3.2–3.4 Instead of pieces every stage reads separately, a **sparse source** (pipeline/sparse.ts): the padded
      ranges are downloaded (`mergeSpans(transcriptSpans(…), RANGE_FETCH_GAP_SEC)`, close ones in one section) and
      joined on the source clock by stream copy (concat, each part cut with `outpoint`) with black, silent filler at 1
      fps between them, so the project keeps one ordinary source file as long as the video and every stage, the
      editor's player and render read it unchanged. In the spike the join took 3 s, filler cost ~25 KB a minute and
      the clock held within 0.05 s. A piece in another shape is re-encoded to H.264 / AAC at the first's size.
      `source_meta.sparse.spans` says what it holds; the poster is taken inside the first range. Without an announced
      length the whole video is downloaded as before.
- [x] 3.5 The editor's player plays black in time not fetched; both timelines hatch it.
- [x] 3.6 Ranges added later that the sparse source does not hold restart the run from ingest, which downloads the
      ranges again (all of them: nothing but network is spent twice; transcription and minutes count only new time);
      a source removed by retention is fetched again the same way.
- [x] 3.7 Uploads: unchanged (the whole file is stored); only the ranges are transcribed and counted.

## Slice 4 — Most replayed

- [x] 4.1 The length lookup (`announcedDuration`, projects/peek.ts) keeps yt-dlp's `heatmap` from the same answer;
      `announcedHeatmap` reads it from the same cache.
- [x] 4.2 Shared `replayPeaks(heatmap, { top })`: local maxima above the median, widened over neighbours at half their
      height, at most 120 s around the peak, grown to RANGE_MIN_SEC; overlapping ones keep the hotter. Unit tested.
- [x] 4.3 `check_source` returns `mostReplayed[]` when the length was looked up for ranges; `create_project {
      rangesFrom: { mostReplayed: n } }` and `reelsaw create-project --most-replayed n` add the top peaks as exact-clip
      ranges (`origin: most_replayed`, labelled "Most replayed #n"); refused with the reason when there is no heatmap.
- [x] 4.4 Web: New project shows the peaks as bars on the timeline and as chips that add or remove them.
- [x] 4.5 Telemetry: `project.ranges` (count, billed minutes, share of the video, peaks used, surface); no per-user detail.

## Done when
- A 3 h link with three ranges downloads, transcribes and bills about the ranges' length plus padding, and its
  clips render at the plan's full quality.
- The same ranges given on the timeline, over MCP and on the CLI produce the same plan, price and clips.
- A pre-existing partial project behaves as before, and "Clip the rest" is a range.
- No stage reads source media except through `sourceAt`.
