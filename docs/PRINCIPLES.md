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
  (`requestRender`, `startRun`, `finalizeProjectIfDone`). API routes, workers, the
  reconciler and the CLI call them instead of re-implementing them.
- **Runs are explicit.** A run is one stretch of work on a project, from leaving idle (created,
  or done / failed) until it is done / failed again. It starts in exactly one place,
  `startRun` in `pipeline/lifecycle.ts`: a conditional update on the idle status that bumps
  `projects.run_seq`, stamps `run_started_at` / `run_reason`, and emits `run.started { seq, reason }`
  only for the caller that got a row back. Every API route, worker and CLI path that moves an idle
  project to working goes through it. Durations are facts written into payloads when they happen
  (`stage.completed.durationSec` from `stage_started_at`; `project.done` / `project.failed`
  `runSec`, `runSeq`, `runReason`), never recomputed from event timestamps by a reader. The only
  reader of history is `pipeline/runs.ts` (`runsOf`); it alone falls back to timestamps for old
  events. Expected-time estimates, the Processing times page, `reelsaw status` and the bench use it.
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

#### Logging

Any issue must be debuggable from the logs alone. The logs say *what was decided and why*; they
are not the metrics.

- **Logs are not telemetry.** Logs hold decisions, their inputs and reasons, state transitions,
  recoveries and failures. Durations, throughput and counters belong to the spans and metrics
  (`withSpan`, the OpenTelemetry auto-instrumentation), to `llm_usage`, and to the `durationSec`
  in event payloads; do not log them again. A duration or a count goes on a line only when the
  line is an anomaly (a slow request, a truncated model answer) or the number *is* the reason
  for a decision (`dropped: 3 overlapping`, `confidence 0.4 < 0.5`). Before adding `ms` or a
  total to a log call, ask which span, metric or event already carries it.
- **Levels mean one thing each.**
  - `fatal`: the process cannot continue (a boot self-check failed, uncaught exception).
  - `error`: an operation failed and a person must act, or a user saw a failure (clip failed,
    request 5xx, job dead-lettered, project failed). Always with `err`.
  - `warn`: degraded or recovered automatically, a limit hit, something skipped (retry,
    fallback model, bumper skipped, truncated list, slow request, 4xx that is not routine).
  - `info`: one line per state transition or milestone, countable: project events (run started,
    stage started / completed, clip done), API requests, sign-in, admin actions, MCP tool calls.
  - `debug`: the decisions and inputs you need to explain a wrong result: moments chosen with
    scores, layout per section and why, each cut accepted or rejected and why, ffmpeg argv, the
    framing requested, bumpers used. Never prompt bodies (that is `LLM_TRACE`). Safe to run in
    production for a project for a few minutes.
  - `trace`: per-item loops (per word, per frame, per candidate decision). Never above `trace`.
- **Every line carries its ids.** Derive child loggers per module and per unit of work
  (`module`, `projectId`, `clipId`, `jobId`, `runSeq`, `userId`, `requestId`, `tool` for MCP) so
  one `grep projectId=` (or `reelsaw logs <id>`) reconstructs a project's whole story. A new
  module takes `log` from the composition root or its context (`svc.log`, `ctx.log` in a
  pipeline stage, `c.get("log")` in an HTTP handler, `ctx.log` in a tRPC procedure) and never
  builds its own. No `console.*` in server code (the CLI prints output, it does not log).
  The `module` binding is what runtime levels key on, so name it for the part of the system
  (`render`, `analyze`, `http`, `storage`).
- **Message is a constant phrase; data goes in fields.** `log.info({ cuts }, "applying jump cuts")`,
  never a sentence with the numbers in it. Errors in `err` so the stack serialises. Pure
  decision functions return their reasons; the stage that calls them logs the decision.
- **Secrets never.** Passwords, API keys, tokens, cookies, `Authorization`, proxy URLs. The
  redaction list in `log.ts` stays current when a new kind of secret appears, and argv or URLs
  are logged through a masking helper (`loggableArgv`). Issue-report logs go through the
  redactor again.
- **Level is adjustable without a restart,** globally and per module, for a bounded time:
  `LOG_LEVEL=info,render=debug,http=warn` at boot; `reelsaw log-level render=debug --for 15m`
  (or Settings → System → Log level) at runtime, applied by every process within about five
  seconds and reverted on its own. The default is `info`.
- **A request has one id from edge to job.** `x-request-id` is accepted or generated, returned
  on the response, and carried by the access line, the tRPC error line, the MCP tool line and
  the lines of that handler; the job it enqueues is found by the `projectId` on both sides.
- **Logs are the first thing a report carries.** The issue-report zip bundles the project's lines
  from the last seven days and the level in force; `docs/TROUBLESHOOTING.md` ("Reading the logs")
  says how to read them. A change that adds a decision point adds its `debug` line in the same
  change.

### Scale

Findings and the fix plan: [docs/specs/scale.md](specs/scale.md). Today's data is small, so
nothing below hurts yet; every rule exists because a query or screen we already ship would.

- **Every list is paginated or bounded, and the UI says so.** A list endpoint takes a `limit` and
  a keyset `cursor` (ordered by an indexed column plus `id`) and returns `{ items, nextCursor,
  total }`. The screen shows "Showing 50 of 1,204" and a way to load more. A bare `findMany` on a
  table that grows with usage is a bug, and so is a magic `limit: 500` nobody can see.
- **A hard limit is never silent.** If a cap cuts data off (an index, a replay, a jsonb array,
  a batch), the response says it was truncated and the UI or CLI says so in a sentence. Silent
  `slice(-500)` loses user data without anyone noticing; `get_transcript` ("truncated at 4:12,
  call again with fromSec") is the model.
- **Search and filtering happen in the database.** Matching runs in SQL against an index
  (`ILIKE` with `pg_trgm`, or `tsvector`), scoped by `user_id`, and returns a page. The client
  may narrow what it already fetched (Fuse over 20 results), never fetch everything to search it.
  Debounce typing, keep the previous results while the next page loads.
- **Payload shape follows the screen.** List rows carry list fields; detail queries carry detail
  fields; heavy blobs (transcript words, diagnostics, settings) have their own query. An event
  invalidates the smallest query that changed (a clip event refetches clips, not the project and
  its 5 MB transcript). Estimate the bytes at 1,000 projects before adding a field to a list.
- **Anything that grows with time has a retention rule.** Event and usage tables prune what no
  screen shows (progress ticks are not history) and roll the rest up. jsonb arrays that grow
  with usage get a cap *and* an archive path (`stage_artifacts`), not `slice(-500)`. Decide the
  rule when the column is added, not after the table is large.
- **Don't rewrite big rows for small edits.** A value over about 100 KB (transcript words) is
  stored in ranges or chunks, read by range, and changed by patch, so an edit moves kilobytes
  and holds a lock for milliseconds.
- **Background loops work per batch with a stable cursor, never "all rows".** A sweep, retention
  or reconcile step selects a bounded batch ordered by an indexed key, remembers where it
  stopped, and cannot be starved by rows that never qualify. No `inArray` over an unbounded id
  list (Postgres stops at 65,535 parameters); no per-row query inside the loop when one grouped
  query does it; no directory walk without a bound on concurrency.
- **Per-tenant resources are enforced in the database.** Quotas, rate limits, job concurrency
  and stream counts are counted from rows in the transaction that consumes them, keyed by
  `user_id`, so they hold across replicas. A process-local counter is a per-process limit, not a
  tenant limit. One user's burst queues behind others instead of ahead of them.
- **Every query a hot path runs has an index.** New predicate or sort on a growing table means an
  index in the same migration (`user_id` first, then the sort column). jsonb `->>` filters on
  big tables are a smell: promote the key to a column. Check with `EXPLAIN (ANALYZE, BUFFERS)`.
- **Measure with realistic data before and after.** Performance work states its numbers (rows
  scanned, payload bytes, ms) from `apps/server/scripts/seed-scale.ts` at 1,000 projects / 50,000
  clips, and the change keeps them in its description.

### Quality

- **Measure before and after.** Model-facing or heuristic behaviour (selection, cuts, framing,
  text masking, disfluencies) changes only with an eval run (`pnpm eval <suite>`). Real
  failures become fixtures; build them from user decisions (accepted/rejected) where possible.
  Framing layouts, triggers and their fixture coverage: [LAYOUTS.md](LAYOUTS.md).
  Update baselines deliberately with `--update`.
- **Don't overfit.** A fix should be a general rule that explains the failure, not a special
  case for one video. The regression fixture proves the case. Other fixtures prove you didn't
  break them.
- **Prompted models over-delete and over-claim.** Put structural guards (rules) in front and a
  verifier behind, and keep only verified uncertain results, for review.
- **Operable by default.** Logs are the first debugging tool (see "Logging" under Backend /
  Structure). Every diagnosis you need more than once becomes a `reelsaw` CLI command. Events are
  readable in the activity feed.

## Frontend

- **Tokens, not colours.** Use only the theme tokens from `index.css` (`bg-panel`, `text-ink2`,
  `bg-acc-soft`, …) so light and dark both work. Global styles live in `@layer base` so
  utilities can override them.
- **Primitives:** Radix and shadcn-style components. Scrolling regions use the `ScrollArea`
  component, never native `overflow-auto`. To cap a ScrollArea's height, give the ScrollArea
  itself a max height. For any UI control (select, menu, tooltip, tabs, date picker, toggle…)
  look first in `components/ui.tsx` and `components/`, then at what shadcn/ui or Radix already
  ships for it (add the Radix package, wrap it once in `ui.tsx`, style it with our tokens), then
  at a maintained library. Browser-native widgets with their own OS chrome (`<select>`,
  `<input type="date">`) are not used where a themed primitive exists. See "Don't rebuild what
  exists".
- **No layout shift.**
  - Nothing appears *above* what the user is interacting with and pushes it down.
  - Follow-up actions go into space reserved for them (a label row, a status line that's always
    present).
  - Transient warnings are overlays.
  - Buttons whose label changes get a minimum width.
  - Remember that popovers anchored above their trigger grow upward.
- **Loading is not empty.** A region backed by a query has three states and renders each one
  distinctly: loading (a skeleton with the approximate size and shape of the content: same row
  count, line widths, thumbnail boxes), empty (the "nothing here yet" message, only once the query
  has resolved with no data), and data.
  - Never show the empty-state text while `isPending`/`isLoading`; never collapse a region's height
    while it loads.
  - Refetches and background updates keep the current content (`placeholderData: keepPreviousData`
    or the query's previous data); they do not flash a skeleton.
  - Skeletons use the `Skeleton` primitive in `components/ui.tsx` (wrap a region in
    `SkeletonRegion` for the screen-reader "Loading…") and the same layout classes as the real rows,
    so the swap is a content change, not a layout change.
- **Lists align.**
  - Rows of one list share one column grid (a `<table>` with fixed layout, or CSS grid with fixed
    tracks), never per-row flex that wraps differently. Every column has a fixed or minimum width
    and an explicit alignment: text left, numbers right with `tabular-nums`, status glyph plus word
    left, actions right. Headers take the alignment of their data.
  - Conditional cells keep their slot. An action that does not apply renders disabled (with a title
    saying why) or as an invisible placeholder of the same width, so buttons line up down the list.
    Badges ("admin", "you") live inside the name cell and never move another column.
  - One row height per list. Secondary text goes on a second line inside the cell, not into extra
    height for some rows.
  - Actions: up to three primary inline, the rest in a ⋯ menu. Never hover-only: touch and keyboard
    users cannot find them.
  - Responsive: columns collapse in a defined order. Hide the least important first, then fold them
    into a second line inside the row, then scroll the row. The actions column stays reachable.
  - Semantics: a real `<table>` when the data is tabular and column headers help (add `scope`,
    `aria-sort` and a caption); `role="grid"` only for a keyboard-navigable widget. Headers are
    sticky inside the list's `ScrollArea`.
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

## Surfaces: UI, MCP, CLI

- **MCP is the UI for agents, and the glue for integrations.** Anything a person can do in the app
  (create a project, pick moments, assign an intro, re-render, export) exists as an MCP tool with
  the same semantics, and the CLI mirrors it for operators. A feature is not finished until its MCP
  surface exists. Ship the tool in the same change as the screen, not as a follow-up.
- **One implementation behind every surface.** tRPC procedures, MCP tools and CLI commands call the
  same service functions (`pipeline/lifecycle.ts`, `*/service.ts`); none of them re-implements
  validation, ownership checks, transitions or re-render rules. If a tool needs logic the route has
  inline, move the logic into a service function and call it from both.
- **Tools describe state before changing it.** Read tools return the effective state an agent
  needs to decide (for example the intro/outro a clip will actually render with and where it came
  from), and write tools say what they changed and what still needs a re-render, in the same plain
  language the UI uses. Inputs are zod schemas; results are structured.
- **Integrations go through MCP, not around it.** Automations, other apps and scripts use the MCP
  endpoint (or the CLI on the box), never the database or internal routes, so every path gets the
  same guards, events and runs.

## Process

- Typecheck both apps, build, deploy (`docker compose --profile local-ai up -d --build app`) and
  check the change in the browser, including at phone width for UI work. Run the relevant
  evals for pipeline work.
- Commit and push only when asked. Commit messages describe the change and why; no
  tool-attribution trailers.
- Keep docs current: `EVALS.md` for suites, `TROUBLESHOOTING.md` for operator recipes,
  `RESEARCH.md` for findings, and this file for principles.
