# Contributing to Reelsaw

Thanks for helping. A few things keep the project easy to run and easy to license.

## Before you start

- Read [docs/PRINCIPLES.md](docs/PRINCIPLES.md): the consistency, concurrency and UI rules every
  change follows. Agent instructions live in `AGENTS.md` (the only agent file; see the process principles).
- Everyday commands (typecheck, build, deploy, evals, tests) are listed in `AGENTS.md`.
- Pipeline behaviour (selection, cuts, framing, transcription) changes only with an eval run
  (`docs/EVALS.md`). Add a fixture for the failure you are fixing.

## Pull requests

- One change per PR, with a description of what and why.
- Typecheck both apps, run `pnpm --filter @reelsaw/server test` against a local stack, and check
  UI changes in the browser at phone width. Desktop device mode does not simulate the URL bar;
  a bottom bar that only fails on a real phone is the `100vh` gap ([docs/UI.md](docs/UI.md)).
  CI runs only the stack-free tests
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
- Changed an env var, a CLI command or an eval suite? Run `pnpm docs:gen` (CI runs `pnpm docs:check`):
  `.env.example`, `docs/CONFIG.md` and the command/suite tables are generated from the code.
- Keep docs current: `README.md`, `docs/CONFIG.md` (generated), `docs/TROUBLESHOOTING.md`, `docs/EVALS.md`, `docs/RESEARCH.md`, `docs/UI.md` (overlay/portal/stacking and mobile-viewport gotchas).

## Licensing: the CLA and the Developer Certificate of Origin

Reelsaw's core is licensed under the [GNU AGPL-3.0](LICENSE) and the `ee/` folders under the
Reelsaw Enterprise License ([LICENSING.md](LICENSING.md)). Two things keep that possible, and CI
checks both on every pull request (`contributors` workflow: `DCO` and `CLA`):

1. **Sign the [Contributor License Agreement](CLA.md) once.** In your first pull request, add a
   line with your GitHub login to `.github/cla-signatures.json`. The CLA is a licence, not an
   assignment: you keep your copyright and grant osbytes the right to distribute your contribution
   under the project's licences, which is what lets the AGPL part and `ee/` ship as one program.
2. **Certify the [Developer Certificate of Origin 1.1](https://developercertificate.org/) on every
   commit:** that you wrote the change or have the right to submit it.

Sign off every commit to say so:

```bash
git commit -s -m "Describe the change"
```

This adds a `Signed-off-by: Your Name <you@example.com>` trailer; the email must be the commit's
author email. Forgot? `git rebase --signoff origin/main && git push --force-with-lease`.

Contributions to `apps/server/src/ee` and `apps/web/src/ee` are accepted under the Reelsaw
Enterprise License in those folders; everything else is AGPL.
