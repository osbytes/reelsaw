# Clipping sections of a long video

Designs and workflow mockups: the "Range clipping" design canvas (flow, MCP/API/CLI, new project, phone, project
page, edge cases). Build order: [range-clipping.plan.md](range-clipping.plan.md).

## Job
When a video is hours long and I (or a system upstream of Reelsaw) already know which parts are worth clipping, I
want Reelsaw to fetch, transcribe, pick from and count only those parts, so that a 3-hour stream with three good
moments costs three moments of minutes and time, not three hours. Reelsaw is then the framing, caption and render
step of a larger workflow, and a person on a small plan can spend their minutes where the video is good.

## Goals
- A project can be **sections** of its video instead of all of it. Each section is `[startSec, endSec]` on the
  source's clock with a mode: **find** (pick moments inside it, today's picker) or **clip** (the section is the
  clip; ends snap to sentence boundaries, no picking).
- Sections come from three places with one meaning: a person on the **shadow timeline** (the video's length is
  known before anything is downloaded), an upstream pipeline over **MCP / API / CLI**, and YouTube's **Most
  replayed** heatmap as suggestions.
- **Minutes count the sections**, not the video. Context padding is fetched but not counted.
- **Only the sections are fetched** for a link (yt-dlp `--download-sections`), transcribed and analyzed. An upload
  still uploads whole; only its sections are transcribed, analyzed and counted.
- **Add a section later** to a finished project: only the new time is fetched and counted; clips, transcript fixes
  and decisions stay. Today's partial project ("first N minutes, clip the rest") becomes the special case: one
  section `[0, N)`, and `extend_project` with no sections keeps its meaning.
- Every clip knows its section (`sectionId`), and a caller's `ref` comes back on the clip, `get_project` and clip
  webhooks so a pipeline can join results to its own records.

## Non-goals
- Detecting good moments from viewer signals other than YouTube's heatmap (chat velocity, comments). The heatmap
  is a suggestion source, not a picker input.
- Partial uploads (cutting a file in the browser before upload).
- Sections on a live stream while it is live.
- A clip that spans two sections.

## Must-be
- One planner (`planSections`, `packages/shared`) decides validation, merging, padding, fetch grouping and the
  billed seconds. The web timeline, `check_source`, `create_project`, `extend_project` and the CLI all call it, so
  the price a person sees is the price charged.
- Nothing is changed quietly: merges, an exact clip turned into find, a section past the end are listed in the
  planner's `changes` and shown (timeline) or returned (API). Over the minutes left, a sections project is refused
  with how much to remove and the upgrade offer; it is never trimmed. (Whole-video keeps today's partial rule.)
- Every stage reads source media through one helper that maps source seconds to a file and offset
  (`sourceAt`), so no stage assumes one file covering the whole video.
- Search and sort over sections and clips in the database; versioned jobs (a stage for an old section set commits
  nothing); the quota check stays under the account's quota lock in the unit that records the seconds.
- No layout shift on the timeline while the probe answers; the timeline works at 390 px (tap to add, drag ends);
  deep link `#section=<id>` on the project page.

## What the user sees

### New project
After a link is pasted, the length probe answers (it runs today for the minutes check). Then:
- **Whole video / Sections** toggle. Whole video is today's behaviour, with the part the minutes cover drawn on the
  timeline and the rest hatched.
- **Shadow timeline**: the video's length as a hatched track, the Most replayed heatmap drawn over it when there is
  one. Click (tap) to add a 3-minute section, drag its ends; or type start and end; or toggle a **Most replayed**
  peak chip (added as an exact clip).
- **Sections list**: number, times, length, where it came from, Find clips / Exact clip, remove.
- **Before you start**: seconds fetched, sections count, share of the video skipped, the minutes meter (needed, left,
  left after), the padding note, and the start button ("Clip 3 sections"), off with a reason when over the minutes.

### Project page
The timeline shows processed sections (clips marked inside them) and hatched unprocessed time. Dragging across
hatched time opens **New section** with its mode and cost; "Clip this section" runs only that part. Clips are
grouped by section; a find section offers "Find more in this section".

### Agents and integrations
- `check_source { sourceUrl | durationSec, sections? }` → adds `mostReplayed[]` (peaks, when the site has them) and
  `sections { seconds, minutes, fits, changes[] }`.
- `create_project { …, sections?: Section[], sectionsFrom?: { mostReplayed: n } }` → adds `sections[]` (ids, billed
  minutes) and `changes[]`.
- `extend_project { id, sections? }`: with sections, adds them; without, today's "next part".
- `get_project` → `sections[]`; every clip carries `sectionId` and the section's `ref`.
- `Section = { startSec, endSec, mode: "find" | "clip", label?, ref? }` (`packages/shared`).
- CLI: `reelsaw create-project <url> --section 25:00-26:50:clip --section 1:15:00-1:30:00`,
  `--most-replayed 5`, `reelsaw extend-project <id> --section 2:40:00-2:52:00`.

## Rules (the planner)
| Case | Rule |
| --- | --- |
| Overlap | Overlapping sections merge into one (find wins over clip); listed in `changes`. |
| Close sections | Under `SECTION_FETCH_GAP_SEC` (60) apart: one download, separate sections, separate billing. |
| Padding | `SECTION_PAD_SEC` (15) each side fetched and transcribed, not billed; a clip may extend into it only to finish a sentence. |
| Too short | Under 10 s: refused. |
| Exact clip too long | Longer than the project's longest clip setting: becomes find; listed in `changes`. |
| Past the end | Clamped to the length when known; refused when it starts past the end. Unknown length (live, some sites): accepted, checked after the probe on the file. |
| Over the minutes | Refused with the seconds to remove and the upgrade offer. |
| Already processed | A new section over processed time bills and fetches only the new part. |
| No heatmap | `mostReplayed` is empty; `sectionsFrom.mostReplayed` is refused with the reason. |

## Open questions
- Keyframe accuracy without a preview copy to align against: `--force-keyframes-at-cuts` (re-encodes the cut
  points, slower) versus aligning on the stream's reported start time. Spike in plan 3.1.
- Whether Free's first-video allowance applies per video or per minutes of sections (proposal: per minutes, as now).
- Whether "Exact clip" sections count against the manual-clip quota (proposal: no, they are picked moments).
