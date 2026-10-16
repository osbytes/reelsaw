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

Missing: a cheap, queryable decision log. Today some signals are only inferable (a clip that was
edited isn't marked as such, and its original range is gone once edited). First step below.

## Where we are

- Done: rejected disfluency cuts from the user's other projects are shown to the verifier as "keep"
  examples (`refine.ts` `rejectedCutExamples`). Decisions survive re-runs; deleted fixes stay
  deleted; manual fixes are never overwritten.
- Not yet: accepted cuts, name-fix verdicts, clip edits/deletes, framing overrides and acceptance
  rates feed nothing. Evals use real decisions but are rebuilt by hand.

## Roadmap

### 0. Decision log (foundation)
Append-only `user_decisions` rows written in the same unit of work as the action: user, project,
kind (fix.accept, fix.reject, fix.delete, fix.manual, clip.delete, clip.edit, clip.repick,
layout.override, style.edit), the before/after values, and the stage artifact the item came from.
Gives every later item one query instead of a reconstruction, and an export for evals.
*Measure:* none (plumbing); a test that each action writes exactly one row.

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

### 6. Self-maintaining evals (ongoing)
Periodically turn new decisions into eval fixtures automatically (deduped, held out from what the
models were shown), so every change to prompts or heuristics is measured against what users
actually wanted, and drift shows up in numbers.

## Guardrails

- Per-user isolation in every query (owner-scoped, like the rest of the app).
- Cold start: nothing changes until enough decisions exist; a learned adjustment always has a
  visible reset.
- Prompt hygiene: user-derived examples are data inside delimited sections, capped in count and
  length, never instructions.
- Privacy: learning data stays in the instance; issue reports include it like other project data,
  under the same redaction.

## Order and effort

| # | Item | Effort | Depends on |
|---|---|---|---|
| 0 | Decision log | S | - |
| 1 | Name-fix memory + channel vocabulary | S | 0 (can start without) |
| 2 | Balanced verifier examples | S | - |
| 3 | Per-user auto-apply calibration | M | 0 |
| 5 | Layout/style channel defaults | M | 0 |
| 4 | Clip selection feedback | L | 0, stage_artifacts |
| 6 | Self-maintaining evals | M | 0 |
