# Tech debt and design lens

Debt worth reporting changes what the project can do: it causes bugs, slows changes, or will
break. Style preferences are not debt. Each finding says what it costs now and what paying it
down buys, plus the guard that keeps it paid.

The rules this lens checks against are in `docs/PRINCIPLES.md` and the osbytes playbook's
`stack.md` ("Design rules", "Lint and type checks").

## 1. Measure (scripts first)

Filter each to the scope, and record the counts in the journal.

| Measure | Command | Reads as |
| --- | --- | --- |
| Dead code, unused exports and dependencies | `npx knip --reporter json` | Growth since last run is the finding, not the total |
| Duplication | `npx jscpd --min-tokens 50 --reporters json --output <scratch>/jscpd apps packages` | A clone group with 3 or more members is a third use |
| The duplication ledger | `node scripts/dup-ledger.mjs` | Targets with 3 or more uses are due; markers pointing at missing paths are stale |
| The lint ratchet | `node scripts/lint-ratchet.mjs`, `scripts/lint-baseline.json` | Counts per rule that old code still breaks; report each rule that went down, and propose an error for any rule at 0 |
| Suppressions | `git grep -nE "eslint-disable\|biome-ignore\|oxlint-disable\|@ts-expect-error\|@ts-ignore"` | Count and any without a reason; compare with the journal |
| Casts and `any` | `git grep -nE " as [A-Z]\|: any\b\|<any>"` (excluding `as const`) | Each one in application code needs its comment |
| Empty or log-only `catch` | `git grep -nA2 "catch"` and read | Swallowed errors |
| `Date.now()`, `Math.random()`, `fetch` in domain code | `git grep` outside the modules that own them | Missing `Clock`, `Ids` or adapter |
| Churn × size | `git log --since=<date> --format= --name-only \| sort \| uniq -c \| sort -rn \| head -30`, crossed with line counts | Large and often changed is where debt costs most |
| Co-change | Pairs of files changed together in most commits in the window | Shotgun surgery; a missing module |
| Entry chunk size | The web build's entry chunk against the journal's baseline | Eager imports |
| `TODO`, `FIXME`, `HACK` | `git grep -nE "TODO\|FIXME\|HACK"`, new in scope and old without an issue | Stale promises |

## 2. Judge (reading)

Scripts find candidates; reading decides which matter. For each hotspot, check the smells in
the playbook's "Smells to review for" table, and these, which tools miss:

- **A generalisation that is due.** Three uses of one shape (from jscpd, the ledger, or
  parallel files such as `stripe-webhook.ts` next to `github-webhook.ts` with the same steps).
  Before reporting, check the spec: an early generalisation or a deliberate split recorded
  there is not a finding. The fix names the shared part and the module it moves to.
- **A wrong abstraction (shoe-horning).** A case forced into an existing abstraction: boolean
  parameters that switch behaviour, `if (kind === 'x')` branches growing in a shared helper,
  optional parameters one caller uses, a generic name with one specific use. The fix is to
  inline it into its callers, then extract what is really shared, as its own refactor.
- **Overfitting.** Code, tests, prompts or evals tuned to the cases seen so far: hardcoded
  names of specific providers or inputs in logic, tests asserting one fixture's exact output
  instead of a property, prompt examples matching eval cases word for word, thresholds with no
  comment saying where the number came from.
- **Interface drift.** A service importing a vendor SDK directly; an interface with no fake; a
  fake with no contract test; a pass-through wrapper with one implementation and no fake.
- **Non-exhaustive matches.** A `switch` on a union with neither `assertNever` nor a declared
  return type; a union replaced by a class hierarchy.
- **Speculative generality.** An abstraction, option or plugin point with one caller and
  nothing in the spec saying a second is coming.

## 3. Performance debt

- Server: a query inside a loop or a `Promise.all` over rows (N+1); a predicate or sort on a
  large table without an index; unbounded `limit`s; per-request work that could be cached.
- Web: whole pages imported into the entry chunk; a large dependency used for one function;
  lists over a few hundred rows without virtualisation; providers that re-render the tree on
  every change.

Back each with a number when possible (`EXPLAIN` on the local database with synthetic data, a
bundle size, a render count); otherwise label it "derived from reading".

## 4. Test and eval debt

- Changed logic with no test in scope; tests that mock the thing they claim to test;
  snapshot-only tests of behaviour; tests that pass whatever the code does (a mutation run on
  the hotspot shows it).
- Prompts or models changed without the eval suite run; output fixes with no eval case; suites
  that only cover the cases already fixed (`docs/EVALS.md`).
- Recent fixes that did not add the guard for their class.

## Output

Findings in the run contract's format, ranked by cost, each with **cost now** (bugs caused,
with links; time added to changes; risk), **pay-down** (the change, its size, the guard) and
**trend** (new, growing, stable against the journal).

A **metrics** table for the journal: Knip unused files, exports and dependencies; clone groups
and duplicated lines; ledger targets and how many are due; suppressions; casts and `any`; entry
chunk size; TODOs without issues.

Fixes, when allowed: one debt item per PR, behaviour unchanged, tests green before and after,
and the guard included.
