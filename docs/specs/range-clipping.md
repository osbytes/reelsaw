# Clipping ranges of a long video

Designs and workflow mockups: the "Range clipping" design canvas (flow, MCP/API/CLI, new project, phone, project
page, edge cases). Build order: [range-clipping.plan.md](range-clipping.plan.md).

## Job
When a video is hours long and I (or a system upstream of Reelsaw) already know which parts are worth clipping, I
want Reelsaw to fetch, transcribe, pick from and count only those parts, so that a 3-hour stream with three good
moments costs three moments of minutes and time, not three hours. Reelsaw is then the framing, caption and render
step of a larger workflow, and a person on a small plan can spend their minutes where the video is good.

## Goals
- A project can be **ranges** of its video instead of all of it. Each range is `[startSec, endSec]` on the
  source's clock with a mode: **find** (pick moments inside it, today's picker) or **clip** (the range is the
  clip; ends snap to sentence boundaries, no picking).
- Ranges come from three places with one meaning: a person on the **shadow timeline** (the video's length is
  known before anything is downloaded), an upstream pipeline over **MCP / API / CLI**, and YouTube's **Most
  replayed** heatmap as suggestions.
- **Minutes count the ranges**, not the video. Context padding is fetched but not counted.
- **Only the ranges are fetched** for a link (yt-dlp `--download-sections`), transcribed and analyzed. An upload
  still uploads whole; only its ranges are transcribed, analyzed and counted.
- **Add a range later** to a finished project: only the new time is fetched and counted; clips, transcript fixes
  and decisions stay. Today's partial project ("first N minutes, clip the rest") becomes the special case: one
  range `[0, N)`, and `extend_project` with no ranges keeps its meaning.
- Every clip knows its range (`rangeId`), and a caller's `ref` comes back on the clip, `get_project` and clip
  webhooks so a pipeline can join results to its own records.

## Non-goals
- Detecting good moments from viewer signals other than YouTube's heatmap (chat velocity, comments). The heatmap
  is a suggestion source, not a picker input.
- Partial uploads (cutting a file in the browser before upload).
- Ranges on a live stream while it is live.
- A clip that spans two ranges.

## Must-be
- One planner (`planRanges`, `packages/shared`) decides validation, merging, padding, fetch grouping and the
  billed seconds. The web timeline, `check_source`, `create_project`, `extend_project` and the CLI all call it, so
  the price a person sees is the price charged.
- Nothing is changed quietly: merges, an exact clip turned into find, a range past the end are listed in the
  planner's `changes` and shown (timeline) or returned (API). Over the minutes left, a ranges project is refused
  with how much to remove and the upgrade offer; it is never trimmed. (Whole-video keeps today's partial rule.)
- Every stage reads source media through one helper that maps source seconds to a file and offset
  (`sourceAt`), so no stage assumes one file covering the whole video.
- Search and sort over ranges and clips in the database; versioned jobs (a stage for an old range set commits
  nothing); the quota check stays under the account's quota lock in the unit that records the seconds.
- No layout shift on the timeline while the probe answers; the timeline works at 390 px (tap to add, drag ends);
  deep link `#range=<id>` on the project page.

## What the user sees

### New project
After a link is pasted, the length probe answers (it runs today for the minutes check). Then:
- **Whole video / Ranges** toggle. Whole video is today's behaviour, with the part the minutes cover drawn on the
  timeline and the rest hatched.
- **Shadow timeline**: the video's length as a hatched track, the Most replayed heatmap drawn over it when there is
  one. Click (tap) to add a 3-minute range, drag its ends; or type start and end; or toggle a **Most replayed**
  peak chip (added as an exact clip).
- **Ranges list**: number, times, length, where it came from, Find clips / Exact clip, remove.
- **Before you start**: seconds fetched, ranges count, share of the video skipped, the minutes meter (needed, left,
  left after), the padding note, and the start button ("Clip 3 ranges"), off with a reason when over the minutes.

### Project page
The timeline shows processed ranges (clips marked inside them) and hatched unprocessed time. Dragging across
hatched time opens **New range** with its mode and cost; "Clip this range" runs only that part. Clips are
grouped by range; a find range offers "Find more in this range".

### Projects list and ⌘K
A project that processed only part of its video (`rangeCoverage`: chosen ranges, or the start of a long one) says
so wherever it is listed: the card's length badge reads "3 ranges · 4:30 of 1:02:33" with a strip of the clipped
parts along the thumbnail's bottom edge, the ⌘K row's hint says the same, and `list_projects` adds
`processed { seconds, ranges }`.

### Agents and integrations
- `check_source { sourceUrl | durationSec, ranges? }` → adds `mostReplayed[]` (peaks, when the site has them) and
  `ranges { seconds, minutes, fits, changes[] }`.
- `create_project { …, ranges?: Range[], rangesFrom?: { mostReplayed: n } }` → adds `ranges[]` (ids, billed
  minutes) and `changes[]`.
- `extend_project { id, ranges? }`: with ranges, adds them; without, today's "next part".
- `get_project` → `ranges[]`; every clip carries `rangeId` and the range's `ref`.
- `Range = { startSec, endSec, mode: "find" | "clip", label?, ref? }` (`packages/shared`).
- CLI: `reelsaw create-project <url> --range 25:00-26:50:clip --range 1:15:00-1:30:00`,
  `--most-replayed 5`, `reelsaw extend-project <id> --range 2:40:00-2:52:00`.

## Rules (the planner)
| Case | Rule |
| --- | --- |
| Overlap | Overlapping ranges merge into one (find wins over clip); listed in `changes`. |
| Close ranges | Under `RANGE_FETCH_GAP_SEC` (60) apart: one download, separate ranges, separate billing. |
| Padding | `RANGE_PAD_SEC` (15) each side fetched and transcribed, not billed; a clip may extend into it only to finish a sentence. |
| Too short | Under 10 s: refused. |
| Exact clip too long | Longer than the project's longest clip setting: becomes find; listed in `changes`. |
| Past the end | Clamped to the length when known; refused when it starts past the end. Unknown length (live, some sites): accepted, checked after the probe on the file. |
| Over the minutes | Refused with the seconds to remove and the upgrade offer. |
| Already processed | A new range over processed time bills and fetches only the new part. |
| No heatmap | `mostReplayed` is empty; `rangesFrom.mostReplayed` is refused with the reason. |

## Open questions
- Keyframe accuracy without a preview copy to align against: `--force-keyframes-at-cuts` (re-encodes the cut
  points, slower) versus aligning on the stream's reported start time. Spike in plan 3.1.
- Whether Free's first-video allowance applies per video or per minutes of ranges (proposal: per minutes, as now).
- Whether "Exact clip" ranges count against the manual-clip quota (proposal: no, they are picked moments).
