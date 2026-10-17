# Engineering principles

How Reelsaw is built. These are defaults, not afterthoughts: new code follows them, reviews check
for them, and a change that has to break one says why in the code. Each rule exists because the
project already hit the problem it prevents.

## Product

- **Decide automatically; settings are overrides.** If the app can work something out (framing,
  slides vs. captions, which text to hide), it does, explains what it chose, and offers a one-click
  override where the user is looking. A new setting needs a reason the app can't decide.
- **A wrong automatic edit is worse than a missed one.** Destructive automation (jump cuts,
  blurring, deleting) favours precision. Anything uncertain goes to review instead of being applied.
- **The user's decisions are durable.** Their fixes, cuts and rejections survive re-runs of the
  pipeline. User content is soft-deleted and restorable, and an edit that replaced something gives
  it back when undone.
- **Plain language.** Events, errors and notices are sentences a user understands ("No clean cut
  after 8 tries: it clipped the next word"), with the raw detail one click away. Say
  "disfluencies", not "stutters".

## Backend

### Consistency: one unit of work per state change

- **State, its event and its jobs commit together.** Anything that changes rows *and* emits an
  event *and/or* enqueues or cancels jobs runs in `svc.tx(async (u) => …)` (see `src/uow.ts`) and
  uses `u.db`, `u.emit`, `u.enqueue` and `u.cancelLiveJobs`. Never update with `svc.database.db`
  and then call `svc.events.emit` or `svc.queue.enqueue` afterwards. A crash between them leaves
  an event for a change that didn't happen, or a "pending" clip with no job.
- **Standalone `svc.events.emit` is only for notifications** that describe no state change, such as
  progress ticks. It is a single atomic statement (insert + NOTIFY).
- **NOTIFY happens inside the transaction**, so listeners are only woken once the data they will
  read has committed.
- **Files and other non-database side effects run after commit** (`u.afterCommit(…)`), or are
  written under a versioned name. A rollback must never leave rows pointing at deleted files, or
  files overwritten under a live row.
- **A stage ends with its hand-off.** `ctx.complete(extra, async (u) => …)` writes the stage's
  results, emits `stage.completed` and enqueues the next stage in one commit.

### Concurrency

- **Lock before read-modify-write.** Reading a row, changing it in memory and writing it back must
  happen under `select … for("update")` in the same unit of work (`withTranscript` does this for
  transcript flags).
- **Better: don't read-modify-write.** Use atomic SQL: `settings || patch::jsonb` for JSON merges,
  `count + 1` for counters.
- **Exactly-once transitions are conditional updates.** For example,
  `update … set status = 'analyzing' where status = 'refining' returning id`. Only the caller
  that gets a row back emits and enqueues. Races (last step vs. reconciler, two clips finishing
  together) then resolve themselves.
- **Lock order is fixed: transcript → clip → project.** Taking locks in a different order
  elsewhere can deadlock. If you need a project-level change while holding clip locks, use an
  atomic update rather than a lock.
- **Work carries a version; stale work exits.** Each render request bumps `clips.render_gen`. A
  job renders a specific generation into files named for it, and commits only while that
  generation is still current. Otherwise it deletes its own output. Use the same pattern for any
  job that can be superseded while running, because cancelling a pg-boss job does not stop a
  process that is already running.
- **Jobs are idempotent.** A job may run twice (retries, the reconciler, restarts). It checks
  for existing output and either skips or converges.
- **The reconciler is a safety net, not the mechanism.** Correctness can't depend on it
  repairing things five minutes later.

### Structure

- **12-factor and explicit dependency injection.** Services are built in `createServices()`,
  self-check at boot, and fail fast with a readable reason. Config comes from the environment and
  nothing else.
- **One path per transition.** Shared transitions live in `pipeline/lifecycle.ts`
  (`requestRender`, `reopenProject`, `finalizeProjectIfDone`). API routes, workers, the
  reconciler and the CLI call them instead of re-implementing them.
- **Validate at the edge.** Inputs are zod schemas on the tRPC procedure. Ownership is checked
  in the same transaction as the write.
- **Migrations come from the schema.** Change `db/schema.ts`, then run
  `npx drizzle-kit generate --name <what>`. Never edit an applied migration.
- **Don't rebuild what exists.** Before writing a utility, matcher, parser, retry loop or UI
  primitive, look in this order: something in the repo already does it (`apps/*/src/lib`,
  `components`, `packages/shared`, the `reelsaw` CLI); a dependency already in a `package.json`
  does it (fuzzy search is Fuse.js, comboboxes are Radix + cmdk, schemas are zod, dates are
  the platform); a canonical, maintained library does it. Only then write it, and put it where the
  next person will look (`lib/`, `packages/shared`), with the one caller that proves it. The
  question to answer in review is "what did you search for first?"

### Quality

- **Measure before and after.** Model-facing or heuristic behaviour (selection, cuts, framing,
  text masking, disfluencies) changes only with an eval run (`pnpm eval <suite>`). Real
  failures become fixtures; build them from user decisions (accepted/rejected) where possible.
  Update baselines deliberately with `--update`.
- **Don't overfit.** A fix should be a general rule that explains the failure, not a special
  case for one video. The regression fixture proves the case. Other fixtures prove you didn't
  break them.
- **Prompted models over-delete and over-claim.** Put structural guards (rules) in front and a
  verifier behind, and keep only verified uncertain results, for review.
- **Operable by default.** Structured logs carry ids (project, clip, job). Every diagnosis you
  need more than once becomes a `reelsaw` CLI command. Events are readable in the activity feed.

## Frontend

- **Tokens, not colours.** Use only the theme tokens from `index.css` (`bg-panel`, `text-ink2`,
  `bg-acc-soft`, …) so light and dark both work. Global styles live in `@layer base` so
  utilities can override them.
- **Primitives:** Radix and shadcn-style components. Scrolling regions use the `ScrollArea`
  component, never native `overflow-auto`. To cap a ScrollArea's height, give the ScrollArea
  itself a max height.
- **No layout shift.**
  - Nothing appears *above* what the user is interacting with and pushes it down.
  - Follow-up actions go into space reserved for them (a label row, a status line that's always
    present).
  - Transient warnings are overlays.
  - Buttons whose label changes get a minimum width.
  - Remember that popovers anchored above their trigger grow upward.
- **One source of truth.** State shared by several components lives in one store (for example
  the theme in `lib/theme.ts`), not in separate copies of local state that can drift apart.
- **The URL is state.** Anything worth linking to (a fix, a selection, a clip, a time, an editor
  tab) is in hash params, kept in sync with `replaceState`, and re-applied from the router
  location. Offer a copy-link button where it's useful.
- **Status is a glyph plus a word**, never colour alone. Every icon-only control has an
  `aria-label` and a tooltip.
- **Responsive by default.** Check every screen at 390 px wide: the important content gets the
  space, secondary panels collapse into tabs, and rows that would wrap become scrollable rows
  instead.
- **Live data comes from events.** Mutations invalidate queries, and the project event stream
  drives refreshes and progress. Don't poll when an event exists.
- **Keyboard first in editors.** Shortcuts are consistent across views and listed in the UI
  (`?`). Typing in an input never triggers a shortcut.

## Process

- Typecheck both apps, build, deploy (`docker compose --profile local-ai up -d --build app`) and
  check the change in the browser, including at phone width for UI work. Run the relevant
  evals for pipeline work.
- Commit and push only when asked. Commit messages describe the change and why; no
  tool-attribution trailers.
- Keep docs current: `EVALS.md` for suites, `TROUBLESHOOTING.md` for operator recipes,
  `RESEARCH.md` for findings, and this file for principles.
