# Contributing to Reelsaw

Thanks for helping. A few things keep the project easy to run and easy to license.

## Before you start

- Read [docs/PRINCIPLES.md](docs/PRINCIPLES.md): the consistency, concurrency and UI rules every
  change follows. Agent instructions live in `AGENTS.md` / `CLAUDE.md`.
- Everyday commands (typecheck, build, deploy, evals, tests) are listed in `AGENTS.md`.
- Pipeline behaviour (selection, cuts, framing, transcription) changes only with an eval run
  (`docs/EVALS.md`). Add a fixture for the failure you are fixing.

## Pull requests

- One change per PR, with a description of what and why.
- Typecheck both apps, run `pnpm --filter @reelsaw/server test` against a local stack, and check
  UI changes in the browser at phone width. CI runs only the stack-free tests
  (`test:unit`) and `eval:offline` (all model-free eval suites against the baselines), so the stack
  tests and `pnpm eval` with a model are on you.
- `pnpm eval <suite> --update` refuses to record regressions; pass `--accept-regressions "<reason>"`
  when a worse number is intended. Never read the `heldout` disfluency cases while tuning (see
  `docs/EVALS.md`).
- The consistency-core tests (`uow-atomic`, `render-gen`, `finalize-race`, `reopen-transitions`,
  `reconcile-idempotent`) call `svc.tx`, the lifecycle functions and the reconciler in-process through
  `test/lifecycle-harness.ts`, needing only Postgres (no models, no running app). They skip with a reason when
  the database schema is older than the checkout (the running stack is an older build); to test newer code,
  create a scratch database, run the migrations into it and set `TEST_DATABASE_URL` to it. Their jobs are held
  an hour in the future and removed afterwards, so workers never touch the fake clips.
- Keep docs current: `README.md`, `docs/TROUBLESHOOTING.md`, `docs/EVALS.md`, `docs/RESEARCH.md`.

## Licensing and the Developer Certificate of Origin

Reelsaw is licensed under the [GNU AGPL-3.0](LICENSE). By contributing you agree that your
contribution is licensed under the same terms, and you certify the
[Developer Certificate of Origin 1.1](https://developercertificate.org/): that you wrote the
change or have the right to submit it under the project licence.

Sign off every commit to say so:

```bash
git commit -s -m "Describe the change"
```

This adds a `Signed-off-by: Your Name <you@example.com>` trailer. No CLA, no paperwork.

Code under a future `ee/` directory (hosted-only features such as billing) is licensed
separately; contributions there are accepted under its own licence terms, stated in that
directory. Everything else, including every feature in this repository today, is AGPL.
