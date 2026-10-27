# Decision log: user decisions that outlive their projects

Roadmap item 0 of [SELF-IMPROVEMENT.md](../SELF-IMPROVEMENT.md). Every accept, reject, delete, manual fix
and clip edit becomes one append-only row in `user_decisions`. Each row carries enough context to work as an
eval case or a prompt example on its own, and survives the project it came from being deleted forever.

## Problem

- Decisions live inside the rows they decided: `transcripts.flags[].status`, `deleted_flags`, `subkind:
  "manual"`, `clips.*`. The only consumer (`refine.ts` `rejectedCutExamples`) scans the user's last 20
  transcripts.
- `purgeProject` deletes the project row and cascades to `transcripts`, `clips`, `project_events` and
  `stage_artifacts`. After `DELETED_RETENTION_DAYS` (or "Delete forever") every label from that project is
  gone, along with the candidate set that would let us replay it.
- Edits overwrite in place. An edited clip keeps `edited_at`; its AI range and hook are gone, so "what the
  model proposed vs what the user wanted" cannot be reconstructed even without a delete.
- Evals use real decisions but are rebuilt by hand (`disfluency` cases 01–50).
- The source of a URL project is identified only by `webpage_url`. Nothing says which exact file the
  timestamps of a decision refer to.

## Prior art and what we take from it

- **LLM eval platforms (LangSmith, Braintrust, Humanloop)**: feedback is a separate, append-only record keyed
  to a trace, not a column on the product row. Datasets are built by promoting feedback into cases, and
  online evals score the current system against recent feedback. → separate table, promotion pipeline,
  replay suite.
- **Labelling tools (Label Studio, Prodigy)**: an annotation stores the input it labelled with it, plus who,
  when and which model's prediction it judged. → `context` and `models` on every row.
- **Preference data (RLHF / DPO)**: an edit is a pair, the proposed version and the chosen one. Keep both.
  → `before` / `after` on every edit.
- **Implicit feedback (search and recommender logs)**: a click is not a label; an untouched item is weaker
  still, and it is biased by what was shown. → `explicit` flag; implicit signals (re-analyze replaced a
  clip) are recorded but kept apart.
- **Leakage**: near-duplicate windows from one video in both train and test inflate scores. → split by
  project / channel, never by row.
- **Media identity**: content hashes identify exact bytes, but a re-download from YouTube is not
  byte-identical (format choice, re-encodes, the ffmpeg merge). Store the platform id to get the video
  back, the format and duration to detect a different encode, and the hash to prove an exact match. When it
  does not match, re-anchor by the stored words (each label carries its words), not by seconds.

## Design

### Table

```
user_decisions
  id            bigserial pk
  user_id       text not null  → user.id on delete cascade   (account deletion forgets everything)
  project_id    text not null  (no FK: survives the purge)
  clip_id       text           (no FK)
  kind          text not null  (see below)
  explicit      boolean not null  (a person clicked; false = inferred, e.g. replaced by a re-analyze)
  before        jsonb          what the pipeline proposed / the state before
  after         jsonb          what the user chose / the state after
  context       jsonb not null the inputs needed to judge it without the project (word window, clip text)
  models        jsonb not null what produced the item, when known (stage_artifacts models of the stage)
  source        jsonb not null SourceRef snapshot (below)
  app_version   text not null
  created_at    timestamptz
index (user_id, id), (user_id, kind, id), (project_id, id)
```

Size: a fix row is about 1.5 KB (±30 words of context), a clip row about 3 KB (clip text capped at 4,000
chars). 10,000 decisions per active user is ~20 MB. Retention: `DECISION_RETENTION_DAYS` (runtime setting,
default 0 = keep), pruned by the daily history pruner like `project_events`.

### Kinds

| kind | written by | explicit | before → after |
|---|---|---|---|
| `fix.accept` / `fix.reject` | `review` (UI, MCP `review_transcript_flags`) | yes | the flag as proposed (status, suggested, replacement) → status, replacement |
| `fix.manual` | `addCut`, `addCorrection` | yes | null → the manual flag (`kind` says cut or correction) |
| `fix.delete` / `fix.restore` | `deleteFlag`, `restoreFlag` | yes | the flag → null / null → the flag |
| `clip.edit` | `updateClip` | yes | the changed fields as they were → as they are (`fields` lists them) |
| `clip.create` | `createClip` | yes | null → range + mode (a moment the model missed) |
| `clip.delete` / `clip.restore` | `deleteClip`, `deleteClips`, `restoreClip` | yes | the clip summary → null / null → summary |
| `clip.replaced` | `reanalyzeProject` | **no** | clip summary → null (the user asked for new picks; weak negative) |

Settings and style changes are not decisions about a model output and stay out of v1 (roadmap item 5 adds
`style.edit` when it has a consumer).

### Context

- Fixes: `{ words: [{text,start,end}], target: {index, span} }`, the raw words ±30 around the flag,
  `target.index` relative to the window. This is the shape `eval/fixtures/disfluency/cases.json` already
  uses, so a row converts to a case without the transcript.
- Clips: `{ text, startSec, endSec, score, scores, reasoning, origin, index }`, the cleaned transcript text
  of the clip's range (capped at 4,000 chars) and the model's own justification.

### SourceRef

Snapshotted from `projects.source_*` at write time:

```
{ type: "url" | "upload", url?, extractor?, videoId?, formatId?, durationSec?, sha256?, title?, uploader? }
```

Ingest now records `extractor` (yt-dlp `extractor_key`), `videoId` (`id`), `formatId` (`format_id`) and the
`sha256` of the stored source, streamed (`sha256File`), for both URL downloads and uploads. A re-download
with the same `videoId` but another `sha256` means "same video, different bytes": consumers re-anchor by the
stored words. An upload's hash only links a later re-upload of the same file; text-level decisions stay
usable without the media.

### Writes

`recordDecisions(u, rows)` in `decisions/service.ts`, called inside the same unit of work as the action
(PRINCIPLES.md: state and its record commit together). A rolled-back edit writes no decision; a decision
never exists for an edit that did not happen. When the user has turned learning off, it writes nothing.

### Purge and forgetting

- Delete and "Delete forever" remove media and project rows; decisions stay by default (that is the point).
- **At delete time.** The "Delete this project?" confirmation (project page, ⌘K) has **Also forget what Reelsaw
  learned from it**. Deleted projects are purged automatically after `DELETED_RETENTION_DAYS`, so the choice
  can't wait for a later "Delete forever" the user may never click. It is stored on the project
  (`projects.forget_decisions_on_purge`), and `purgeProject` honours it on every path: Delete forever from the
  Deleted page or the toast, `purge_project`, and the retention sweep. Until then the decisions stay in the
  table (a restore loses nothing; restore clears the flag), but learning (`rejectedCutRows`) and exports skip
  them. The Deleted page marks such rows "forgets what Reelsaw learned from it". Same option on `delete_project`
  (MCP) and `reelsaw delete-project --forget-decisions`.
- **At purge time.** The Deleted page's "Delete forever" confirmation offers the same box for projects deleted
  without it, and deletes those decisions in the purge's transaction. Same option on `purge_project` and
  `reelsaw purge-project --forget-decisions`.
- Settings → Learning: **Learn from my decisions** (user setting, default on; off stops recording, keeps what
  exists), the count of decisions kept, and **Forget everything** (deletes all of the user's rows).
- Deleting the account cascades.
- Decisions never leave the instance on their own. Issue reports do not include them in v1.

### Surfaces (one service, three surfaces)

| | tRPC | MCP | CLI |
|---|---|---|---|
| list / summary | `decisions.list`, `decisions.summary` | `list_decisions` | `reelsaw decisions <email>` |
| export as eval cases | `decisions.export` | `export_decisions` | `reelsaw decisions export <email> [--out f.jsonl]` |
| forget | `decisions.forget` | `forget_decisions` | `reelsaw decisions forget <email> [--project id]` |
| forget at delete (applied at the purge) | `projects.delete` `forgetDecisions` | `delete_project` `forgetDecisions` | `reelsaw delete-project <id> --forget-decisions` |
| forget with the purge | `projects.purge` / `deleted.purge` `forgetDecisions` | `purge_project` `forgetDecisions` | `reelsaw purge-project <id> --forget-decisions` |
| setting | `decisions.setLearning` | `set_learning` | |
| backfill existing projects | | | `reelsaw decisions backfill [--dry-run]` |

Only the project owner's own actions are recorded: an admin or the operator CLI acting on someone's project
(`deleteClip(svc, null, …)`) writes no decision. The toast's one-click "Delete forever" has no option of its
own: it follows what was chosen when the project was deleted.

`list` is keyset-paginated (`{ items, nextCursor, total }`), filterable by kind and project.

### Backfill

Existing transcripts already hold decisions. `reelsaw decisions backfill` walks live and soft-deleted
projects in batches and writes `fix.accept` / `fix.reject` / `fix.manual` / `fix.delete` rows from
`flags` and `deleted_flags` (with `context.backfilled: true` and the project's `updated_at` as the time),
skipping projects that already have decisions. Clip edits cannot be backfilled: their before-values are gone.

### Consumers

1. **`rejectedCutExamples`** reads `fix.reject` rows for disfluency cuts (newest first, other projects of the
   user), falling back to the transcript scan for users with none. Rejections from purged projects keep
   working.
2. **Eval harvest**: `src/eval/tools/harvest-decisions.ts <export.jsonl>` turns an export into candidate
   cases for `disfluency` (from explicit `fix.*` rows on cuts) with `source` provenance, deduped against the
   committed cases, split dev / heldout **by project**. Output goes to `eval/fixtures/disfluency/candidates.json`
   for review; a person promotes them.
3. **Live replay**: the `decisions` eval suite reads `EVAL_DECISIONS=<export.jsonl>` and runs today's
   disfluency rules over every explicit cut decision, reporting agreement (precision / recall against what
   users accepted and rejected, Wilson intervals). It never commits or updates a baseline from user data;
   without the file it is skipped.

## Not in v1

- Name-fix memory, balanced examples, per-user calibration, selection re-ranking (roadmap items 1–5) consume
  this table later; each ships with its own eval.
- Weak positives (exported, untouched clips) and dwell/visibility signals.
- Including decisions in issue reports.
- Audio fingerprints (chromaprint) for re-anchoring media decisions; word re-anchoring covers text labels.

## Tests

- Each action writes exactly one row per decided item, in its transaction (rolled back with it).
- Learning off writes nothing; forget removes rows; purge keeps them unless asked; account delete cascades.
- Backfill is idempotent.
- Export → harvest round-trips into the disfluency case shape.
