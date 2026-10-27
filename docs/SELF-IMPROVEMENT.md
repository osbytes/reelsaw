# Roadmap: getting better from what users do

Every accept, reject, edit and delete is a label the user gave for free. Reelsaw should turn them
into fewer fixes to review, better clips and settings it no longer has to ask for, without becoming
unpredictable. This is the plan; items move to "done" with their eval numbers.

## Principles

- **User decisions are ground truth, applied narrowly first.** Learn per user (and per channel
  where it fits) before anything global. A habit of one user must never change another's results.
- **Explainable.** Anything learned shows up as a reason the user can read ("kept: you rejected this
  cut 3 times") and can undo. No silent drift.
- **Bounded.** Learned adjustments move thresholds and examples within fixed limits; they never
  turn a review item into an automatic destructive edit on their own (precision first, see
  PRINCIPLES.md).
- **Measured.** Each mechanism ships with an eval built from real decisions, a held-out split (no
  testing on the examples it learned from), and before/after numbers. Regressions block it.
- **Durable and local.** Learning lives in the user's own database, survives re-runs, travels with
  the project in issue reports, and never leaves the machine.

## Signals we already record

| Signal | Where | What it says |
|---|---|---|
| Fix accepted / rejected | `transcripts.flags[].status` | this cut or name fix was right / wrong |
| Fix deleted (soft) | `transcripts.deleted_flags` | the detector should not have proposed it |
| Manual cut / correction | flags with `subkind: "manual"` | a miss: the detector should have found it |
| Clip deleted, re-picked, re-analyzed | clips rows, `stage.*` events (`repick`) | the moment wasn't good enough |
| Clip range / title / hook / caption edited | `clips` update | what a better clip or hook looks like |
| Framing overridden per section | `clips.layout_sections` | the automatic layout was wrong there |
| Style edits, burned-in text hide/keep | `clips.style`, `settings.sourceText` | the defaults don't fit this user/channel |
| Names & terms typed | `settings.vocabulary` | spelling the transcriber should know |
| What each stage decided and why | `stage_artifacts` | the candidate set the decision was made from |

Since the decision log (item 0), the fix and clip signals above are also written as rows of
`user_decisions`, with their before/after values and context, and outlive the project. Framing and
style edits are in `clip.edit` rows; project-level style and vocabulary are not decisions yet.

## Where we are

- Done: rejected disfluency cuts from the user's other projects are shown to the verifier as "keep"
  examples (`refine.ts` `rejectedCutExamples`, read from the decision log, so rejections from
  purged projects still count). Decisions survive re-runs; deleted fixes stay deleted; manual fixes
  are never overwritten.
- Done: the decision log (item 0, [specs/decision-log.md](specs/decision-log.md)), the source
  fingerprint at ingest, harvest of disfluency candidates and the `decisions` replay suite.
- Not yet: accepted cuts, name-fix verdicts, clip edits/deletes, framing overrides and acceptance
  rates feed nothing. Evals use real decisions but are rebuilt by hand.

## Roadmap

### 0. Decision log (foundation) — done
Append-only `user_decisions` rows written in the same unit of work as the action: user, project,
kind (`fix.accept|reject|manual|delete|restore`, `clip.edit|create|delete|restore|replaced`), whether a
person clicked (`explicit`), the before/after values, the context needed to judge it without the
project (word window, clip text and the model's reasoning), the models and app version, and a
snapshot of the source. Spec: [specs/decision-log.md](specs/decision-log.md).

Decisions deliberately **outlive their project**: `project_id` has no foreign key, so "Delete
forever" and the retention purge remove the media and rows but keep what the user taught. The user
can forget them: per project in the "Delete forever" dialog (`forgetDecisions`), all at once in
Settings → Learning, or by turning "Learn from my decisions" off (stops recording). Deleting the
account cascades. `DECISION_RETENTION_DAYS` (default 0, keep) prunes old rows.

Sources are fingerprinted at ingest (`sourceMeta.extractor`, `videoId`, `formatId`, `sha256`), since a
re-download from YouTube is not byte-identical: `videoId` gets the video back, `sha256` proves the
same bytes (timestamps line up), and a mismatch means re-anchoring by the words each decision stores.
An upload's hash only links a later re-upload; text-level decisions work without the media.

Surfaces: `decisions.*` (tRPC), `list_decisions` / `export_decisions` / `forget_decisions` (MCP),
`reelsaw decisions …` (list, export, forget, backfill of existing transcripts).
*Measure:* none (plumbing); tests that each action writes one row in its transaction.

### 1. Name fixes remember verdicts (small, high value)
- A rejected heard → suggested pair is not proposed again for that user (or channel).
- Accepted names join a per-channel vocabulary passed to the transcriber (`TRANSCRIPT_BIAS`), so
  the next video spells them right before any fix is needed.
*Measure:* new `names` eval from decisions: repeat-suggestion rate after rejection (target 0), entity
recall on the next video of the same channel, fixes per hour of video.

### 2. Balanced verifier examples for cuts (small)
Show a few accepted cuts next to the rejected ones (similar contexts first). One-sided examples
skewed the verifier in earlier experiments; accepted ones help recall.
*Measure:* `disfluency` eval with a held-out split of the user's decisions: precision may not drop,
recall should rise; auto-applied false positives stay 0.

### 3. Per-user calibration of auto-apply (medium)
With enough decisions (e.g. 50+), adjust the auto-apply confidence within bounds from the user's
actual acceptance rate per fix type: users who reject most auto cuts get fewer, users who accept
everything get more applied automatically. Shown in Settings as "learned from N of your decisions"
with a reset.
*Measure:* simulated replay over historical decisions: review items per hour vs wrong auto edits;
ship only if wrong auto edits don't rise.

### 4. Clip selection feedback (larger)
- Deleted and re-picked clips, and edits that move a range a lot, become weak negatives; kept,
  exported and lightly edited clips become positives.
- Use them as few-shot examples and as a per-user re-ranking feature over the analyze candidates
  (`stage_artifacts` holds the full candidate set, so offline replay is possible).
- Learn preferred clip length and hook style from edits.
*Measure:* `selection` eval extended with decision-derived pairs (pairwise accuracy on held-out
choices), plus a guard that topic coverage doesn't collapse onto one theme.

### 5. Layout and style defaults (medium)
Repeated framing overrides for a channel (e.g. always split for this podcast) and repeated style
edits become that channel's defaults, proposed once ("Use split for this channel by default?")
rather than applied silently.
*Measure:* overrides per clip on later videos of the channel.

### 6. Self-maintaining evals (started)
Turn new decisions into eval fixtures (deduped, held out from what the models were shown), so every
change to prompts or heuristics is measured against what users actually wanted, and drift shows up
in numbers.
- Done: `reelsaw decisions export` → `src/eval/tools/harvest-decisions.ts` writes disfluency
  candidates (split by project, deduped against committed cases) for a person to promote; the
  `decisions` suite replays today's rules over an export (`EVAL_DECISIONS=…`) and reports agreement.
- Next: harvest for names and selection pairs; a scheduled export + replay with the numbers on the
  admin page; promotion without hand-editing JSON.

## Guardrails

- Per-user isolation in every query (owner-scoped, like the rest of the app).
- Cold start: nothing changes until enough decisions exist; a learned adjustment always has a
  visible reset.
- Prompt hygiene: user-derived examples are data inside delimited sections, capped in count and
  length, never instructions.
- Privacy: learning data stays in the instance. Issue reports do not include the decision log yet;
  when they do, under the same redaction. The user can turn recording off and forget at any time.

## Order and effort

| # | Item | Effort | Depends on |
|---|---|---|---|
| 0 | Decision log | S | - (done) |
| 1 | Name-fix memory + channel vocabulary | S | 0 (can start without) |
| 2 | Balanced verifier examples | S | - |
| 3 | Per-user auto-apply calibration | M | 0 |
| 5 | Layout/style channel defaults | M | 0 |
| 4 | Clip selection feedback | L | 0, stage_artifacts |
| 6 | Self-maintaining evals | M | 0 (started) |
