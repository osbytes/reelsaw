# Run contract

How every review and audit skill in `.agents/skills/` picks its scope and depth, what counts as
evidence, and how findings are written. A skill's own text wins where it is more specific.

## Scope

Resolve the scope first and print it as the first line of the report, with how it was chosen.

| Scope | Words that mean it | Change set | Telemetry window |
| --- | --- | --- | --- |
| `working` | "my changes" | `git diff HEAD` plus untracked files | none |
| `branch` | "this branch", "before I open the PR" | `git diff $(git merge-base HEAD origin/main)...HEAD` plus `working` | none |
| `pr <n>` | a PR number or URL | `gh pr diff <n>`, `gh pr view <n> --json title,body,files,commits` | from the release containing its merge commit |
| `range <a>..<b>` | two refs | `git log --first-parent <a>..<b>` | the refs' dates |
| `since <when>` | "last week", "since the last run" | first-parent commits on `origin/main` since then, and PRs merged since then | the same dates, compared with the 4 windows of the same length before |
| `release <tag>` | "the last release" | previous tag `..<tag>` | from the tag's date |
| `paths <glob>` | "the billing feature" | combined with any scope above, or the whole tree under the glob | the combined scope's |
| `all` | "everything" | the whole tree at `origin/main` | the skill's default |

When nothing is named, take the first that applies and say which: the invoking prompt's scope;
`branch` when the checkout has work not on `origin/main`; `since <last run>` from the journal;
`since <latest release tag>`.

**A diff is the trigger, not the boundary.** For each changed symbol, read its callers and the
other implementations of anything whose contract moved. Report a finding outside the diff when
the change caused or exposed it, and say so.

## Depth

| Depth | When | Shape |
| --- | --- | --- |
| quick | A small diff, a triage pass | Inline, top checks only; every finding still has evidence |
| standard | A PR, a feature, a time window | Every check in the skill |
| deep | Money, auth, identity, migrations, the licence boundary, pre-release | Standard, plus an adversarial check of each finding and a pass asking what the run did not look at |

## Evidence

- **A check without evidence was not run.** Never report "clean" for something not executed or
  read. "Not checked: no analytics key" is a result.
- **Cite it.** Code findings give `file:line` at the cause, and at the effect when elsewhere.
  Telemetry findings give the number, window and source id. UI findings give the page, width
  and a screenshot or DOM excerpt.
- **Trust a zero only after it has caught something.** Run the same query over a window or
  fixture where the problem is known to exist, and see it return non-zero.
- **Default to false positive.** A suspicion becomes a finding only once it is shown reachable,
  not already handled upstream, and with real impact. Otherwise label it "derived from reading".
- **Instrumentation can be the bug.** A flat or empty signal may mean broken telemetry.

## Findings

```markdown
### [P1] <short title in plain words>
- **Area:** observability | qa | ai | security | ux | parity | docs | tech-debt | ci
- **Key:** <stable slug, e.g. `dup-ledger-build-manifest-due`>
- **Status:** new | recurring | regressed | fixed-since-last-run
- **Confidence:** high | medium | low, and why
- **Evidence:** <citations; numbers with window and source>
- **Impact:** <who is affected, how many, what they see or lose>
- **Fix:** <the change, where, and the guard that stops the class>
- **Effort:** S | M | L
```

| Severity | Means |
| --- | --- |
| P0 | Harm now: users blocked, data lost or wrong, money wrong, security exposure, outage |
| P1 | Harm soon, or a meaningful share of users affected: a rising error, a broken funnel step, an exploitable path behind one precondition |
| P2 | Latent risk or real quality cost: a missing guard, a parity gap, a generalisation that is due, a wrong abstraction slowing changes |
| P3 | Polish and hygiene |

Rank by severity, then confidence, then effort (smaller first). Fold P3s into one list.
