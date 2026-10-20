# Clip boundaries

How a clip's start and end are chosen, and where to add a fixture when one is wrong.

## Pipeline

1. The model proposes moments in **seconds** (`startSec`, `endSec`, `analyze.ts` map step). It may
   propose fewer seconds than the minimum; it never sees word timings. Each map call sees a ~3
   minute overlapping window (also capped at 4000 characters), not the whole transcript — a
   structural guard against primacy bias in long prompts, not a request to spread clips evenly.
   A second map pass runs only when that window's first picks leave a long uncovered tail.
2. `snapCandidate` (`pipeline/analyze.ts`) turns a proposal into a clip: snap to transcript
   segment boundaries, scene cuts, 0.25 s / 0.35 s of breathing room, trim to the maximum, grow to
   the minimum. Every candidate passes through it: the AI picks (`analyze`) and "Re-pick moments"
   inside a selection (`manual.ts`, with the selection as `bounds`).
3. Last step of `snapCandidate`: `finishThought` (`pipeline/thought.ts`, pure, unit tested in
   `test/thought.test.ts`) moves the edges onto sentence boundaries. The editor's manual edits never
   go through it (user decisions are durable).

## Why segment boundaries are not enough

Stored `transcripts.segments` are `toSentences(words)` (`transcript.ts`): split at terminal
punctuation, at a 1.2 s gap, or after **28 words**. Most STT models used here return no
punctuation, so the 28-word cap decides, and a boundary lands mid-sentence ("…you're now so |
different that…"). Growing a too-short proposal "to the first segment end that reaches the
minimum" then ends the clip there.

## The rule: a clip ends on a complete thought

A sentence ends after a word when, in order:

1. the word has terminal punctuation (`. ! ? …`);
2. otherwise it is **not a connector** (`CONNECTOR_WORDS` in `packages/shared`: "and", "so", "the",
   "to", "of", "you're", …) and either a pause of at least 0.6 s follows, or the next word starts with
   a capital letter (not "I") after a gap of at least 0.05 s. Capitalised sentence starts are the only
   signal when the STT gives no punctuation; a name right after a word with no gap does not count.

When the clip end is inside a sentence: extend to the next sentence end if it is within +8 s and keeps
the clip under the maximum; otherwise pull back to the previous sentence end if that keeps 70% of the
clip (and the minimum); otherwise leave it and log `clip end left inside a sentence` with the reason.
The start mirrors it: the nearest sentence start within 3 s (earlier first), else left. A move is logged
at debug as `clip end moved to finish the sentence` with `from`, `to`, `action` and `reason`
(`punctuation`, `pause`, `capital`).

Precision over recall: a missed extension leaves the old boundary, a wrong one cuts a thought. Add a
word to `CONNECTOR_WORDS` only when a real clip ended on it.

## Adding a fixture for a bad boundary

1. Find the clip's original boundaries in the `analyze` `candidates` artifact (`proposed`, `snapped`
   per candidate) and the user's corrected ones on the clip row.
2. Export `transcripts.segments`, `words` and `scene_cuts` for a window around it into
   `eval/fixtures/selection/<name>/transcript.json` (keep it under 1 MB) with a `note`, and a case:
   `{ "id", "propose": [start, end], "expectEnd", "tolerance", "windowStart" }`. See
   `lonely-chapter`.
3. `pnpm eval selection --offline`: the case runs the real `snapCandidate` with the words, so it needs
   no model. It fails when the end is inside a sentence or farther than `tolerance` from the user's end.
4. `selection-model` still tests the proposal side (candidates parse, land in the chunk, snap); it does
   not judge boundaries.
