# Plan: distribution and issue reports

Spec: [distribution-and-issue-reports.md](distribution-and-issue-reports.md). Check off as done.

## A. Distribution
- [x] A1 Server bundle: `apps/server/scripts/bundle.mjs` (esbuild 0.28, entries main/cli, ESM, node22,
      minify, no sourcemap, npm deps external, `@reelsaw/shared` inlined). Migrations dir resolves
      from `dist/` bundle and from `src/`.
      Verify: `node scripts/bundle.mjs && node bundle/cli.js` prints usage.
- [x] A2 Dockerfile runtime ships the bundle only (no tsc dist, no `.map`, no `@reelsaw/shared`
      sources), version baked in (`REELSAW_VERSION`, `REELSAW_COMMIT`, `REELSAW_BUILT_AT` build args).
      Verify: `scripts/check-image.sh reelsaw:latest` finds no `.ts`/`.map`/`src`/`eval` under /app;
      app boots, `/api/health` 200, `reelsaw status` runs.
- [x] A3 Version exposed: `/api/health` and Settings show version + commit.
- [x] A4 `deploy/`: docker-compose.yml (image from `REELSAW_IMAGE`), .env.example, README.
      Verify: fresh dir with only `.env` → `docker compose up -d` → app serves.
- [x] A5 `.github/workflows/release.yml`: on `v*` tags, buildx amd64+arm64, push GHCR always and
      Docker Hub when secrets set, run check-image, attach `reelsaw-<version>.zip` (deploy/) to the
      GitHub release. Verified: actionlint clean (one style note); first real run on the first `v*` tag.

## B. Stage artifacts
- [x] B1 `stage_artifacts` table + migration; helper `u.artifact(stage, data)` in the unit of work.
- [x] B2 analyze: all candidates with scores, drop reason, models. refine: entity/disfluency
      candidates + verdicts, models. render: link diagnostics (no new data). Verify on a real
      project re-run: rows present.

## C. Reports
- [x] C1 `pipeline/report.ts` builder (streams zip with yazl): files per spec, manifest with sha256,
      redaction (config, logs, events). Test: integration test that every secret value is absent.
- [x] C2 Route `POST /api/projects/:id/report` (owner only) + global `POST /api/report`.
      Tests: owner 200, other user 404, anonymous 401.
- [x] C3 Client error ring buffer (`lib/diagnostics.ts`) sent with the request.
- [x] C4 UI: Report dialog (project ⋯ menu, failed clip, user menu), contents with sizes, states.
      Verify in browser incl. 390 px.
- [x] C5 `reelsaw import-report <zip>`: yauzl, archive checks, zod per file, fresh ids, media,
      source download rules, injection warnings, structured summary, refuses in production.
      Tests: round trip equals originals; `..` entry refused; `file://` refused; warning printed.
- [x] C6 Docs: README section, TROUBLESHOOTING (investigating reports safely), zip README template.

## D. Review and done gate
- [x] D1 Independent reviewers (spec/correctness, security) on the diff; fix blocking issues.
- [x] D2 Done gate with evidence; report.
