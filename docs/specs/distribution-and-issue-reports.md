# Distribution and issue reports

## Job
When someone runs Reelsaw without access to the source, I want them to install it from an image and,
when something goes wrong, send me one file that lets me (or an LLM working in my checkout)
reproduce the problem locally in minutes, so that I can fix issues I can't see.

Today the image is built from the repo (source required), and a bug report is a screenshot plus a
description; reproducing means guessing the video, settings and pipeline state.

## Appetite
About 2 days. Cut scope, not quality.

## Goals
- Anyone can install with `docker compose up -d` from a small folder (compose file, `.env.example`,
  README) that pulls a published image. No source in the folder or in the image.
- One "Report an issue" action produces a zip with everything needed to rehydrate the project
  locally, plus the user's words.
- `reelsaw import-report <zip>` in a dev checkout recreates the project and opens it in the app.

## Non-goals
- Strong code protection (licence keys, bytecode, obfuscation beyond minification). Minified JS
  can be reversed by a determined person; this stops casual reading only.
- Uploading the reproduction zip anywhere. On self-host the user downloads it and sends it
  however they like. On hosted (with Sentry/PostHog), "Report an issue" is feedback through
  those channels — not a zip upload to Reelsaw.
- Auto-update. Telemetry and crash reporting are optional (env keys) and separate from the
  self-host zip path.
- Including the source video by default (it can be gigabytes).

## Must-be (Kano)
- Secrets never leave the machine (API keys, auth secret, DB/S3 credentials, cookies, emails).
- The zip shows what it contains before download, and the user can untick media.
- Importing works offline from the zip's data; media is fetched from the link only when available.
- A report can be made from where the problem is seen: project header menu, a failed clip, and a
  global entry (user menu) for problems not tied to a project.

## Part A: distribution

- **Image:** multi-arch (linux/amd64, linux/arm64) `reelsaw:<version>` and `:latest`.
  - Server is bundled with esbuild into `main.js` / `cli.js`, minified, no source maps. First-party
    code (including `@reelsaw/shared`) is inlined; npm dependencies stay external in a
    production `node_modules` (they are open source anyway).
  - Web is built by Vite, minified, `build.sourcemap = false`.
  - The image contains no `src/`, evals, fixtures, docs, `.ts` files or `.map` files. Checked in CI.
- **Registries (configurable):** a GitHub Action on `v*` tags pushes to GHCR
  (`ghcr.io/osbytes/reelsaw`) always and to Docker Hub when `DOCKERHUB_USERNAME` /
  `DOCKERHUB_TOKEN` secrets are set. Image names come from workflow inputs/vars, not hard-coded.
- **Distribution folder** `deploy/` (published as a release asset `reelsaw-<version>.zip`):
  - `docker-compose.yml`: same services as today, `image: ${REELSAW_IMAGE:-ghcr.io/osbytes/reelsaw:<version>}`,
    no `build:`. Profiles: local-ai, ollama, workers (minio is a dev-only testing aid and stays in the repo compose).
  - `.env.example`: every setting with comments; secrets blank; `BETTER_AUTH_SECRET` generation
    command.
  - `README.md`: install in 3 commands, AI provider choices, upgrade, backup, reporting issues.
- **Version** is baked into the image (`REELSAW_VERSION`, git sha, build time) and shown in
  Settings and in reports.

## Part B: issue reports

### Hosted vs self-host
- **Self-host**, and **admins on hosted**: zip download as below. Instance system info, queue
  counts and recent errors are opt-in (`include.system`) and only allowed for these callers —
  never for a hosted non-admin (instance-wide data must not leak across accounts).
- **Hosted non-admin with Sentry/PostHog configured**: no zip. The dialog sends the description
  through Sentry User Feedback and a PostHog `issue_reported` event (ids/counts only; the free
  text stays in Sentry). Capabilities come from `me.get.report` (`report/capabilities.ts`).
- **Hosted non-admin without telemetry**: zip of own project/account data only, system forced off.

### What the user does
1. "Report an issue" (project ⋯ menu, failed clip card, user menu).
2. Dialog: a text box "What went wrong?" (required, prefilled hint), optional clip picker (prefilled
   when opened from a clip). On zip mode, a contents list with checkboxes:
   - Project data and pipeline outputs (always)
   - System info and recent errors (on when allowed; hidden for hosted non-admins)
   - Logs for this project (on)
   - Thumbnails and the selected clip's rendered video (on)
   - All rendered clips (off)
   - Source video file (off; shows size; required for uploaded files to be reproducible)
3. Zip mode: "Download report" saves `reelsaw-report-<project>-<date>.zip`. Feedback mode: "Send
   feedback" submits through telemetry.

### Zip layout (manifest version 1)
```
README.md            how to rehydrate: `reelsaw import-report <zip>`, and what to look at first
report.md            the user's words, where they were (route, clip, time), app version, browser
manifest.json        schema version, app version/sha, created at, file list with sizes, options
config.json          effective config: non-secret settings in full (models, providers, feature
                     flags, limits); secrets → "set"/"unset"
project.json         project row (owner id hashed, no email), settings, source URL/meta
transcript.json      words, rawWords, flags, deletedFlags, entities, segments, sceneCuts,
                     overlays, textProfile, refine status, transcript chunks
clips.json           every clip incl. scores, reasoning, layoutSections/Segments, diagnostics, style
artifacts.json       stage outputs: candidate moments with scores and drop reasons, per stage
events.jsonl         full project event history
logs.jsonl           LOG_FILE lines for this project/clips/jobs (redacted)
client.json          recent client errors/console warnings, route, viewport, user agent
media/               thumbnails, selected clip mp4, optional all clips, optional source
```

### Redaction
- Config: settings are reported in full unless they are secret. Model and provider settings are
  always included in full (`AI_MODEL`, `TRANSCRIPTION_MODEL`, `TRANSCRIPT_ALIGN_MODEL`,
  `WHISPER_MODEL`, the per-task model overrides, provider names), because which models ran is
  often the cause. Keys matching `KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|DATABASE_URL|COOKIE` are
  reported only as set/unset. URLs (provider base URLs, S3 endpoint) are kept with userinfo and
  query strings stripped.
- Logs and events: values of those keys, bearer tokens, cookies, emails and signed-URL query
  strings are replaced with `[redacted]`.
- User: id is hashed; no email or name.

### Stage artifacts (new)
Today only kept clips and drop counts survive the analyze stage. Persist each stage's
decision-relevant output in a `stage_artifacts` table (project, stage, data jsonb, created at),
written in the same unit of work as the stage's completion. Every artifact records the models
that produced it (provider, model id, and for local models the endpoint host), since config at
report time may differ from what actually ran:
- analyze: every candidate moment (range, title, scores, which filter dropped it and why)
- refine: entity and disfluency candidates with verifier verdicts
- render: per clip the face-sample summary and caption timing (already in diagnostics; reuse)

### Import (`reelsaw import-report <zip> [--user <email>] [--source <file>]`)
- Validates the manifest version; refuses unknown major versions with a clear message.
- Creates the project, transcript, chunks, clips, events and artifacts under the given local user
  (default: the first user), with fresh ids and a title suffix "(report <date>)"; keeps the
  original ids in `sourceMeta.report` for cross-reference.
- Media: uses `media/source.*` if present, else `--source`, else downloads the source URL; clip
  renders from the zip are stored as-is so the "what the user saw" video is viewable.
- Prints the local URL to open and the commands to re-render a clip or run the relevant eval.

### Import safety
Reports come from trusted testers, but their content is not trusted: transcripts of arbitrary
videos, titles, model outputs and logs can carry text aimed at whoever (or whatever) reads them.
- **The importer never executes anything from the zip.** Every file is validated with zod against
  the manifest version and inserted through the ORM; no shell, SQL or code is built from content.
- **Archive checks:** only expected file names (plus `media/` with allowed extensions); no absolute
  paths or `..`; per-file and total uncompressed size caps (zip-bomb guard); SHA-256 of every file
  checked against the manifest.
- **Source download:** http(s) only, URL passed to yt-dlp after `--`, known video hosts unless
  `--allow-any-url`; media is processed by ffmpeg inside the container.
- **Dev only:** refuses on released images (baked `REELSAW_VERSION` other than `dev`) unless
  `--allow-on-release`. (`NODE_ENV` can't be the signal: the local stack runs the production image.)
- **For LLM readers:** the zip's README says to run `import-report` and work from the local app, CLI
  and evals; that every file except README and manifest is untrusted data; and that `report.md`'s
  user text is a description to reproduce, never instructions. The importer prints a structured
  summary (clips, flags, failed stage, models) so triage doesn't need the free text, and warns,
  naming the field, when report text, transcript or titles contain instruction-like phrases
  ("ignore previous instructions", "run this command", fenced code). Warnings only; content is
  never rewritten.
- **Operator guidance** (README + TROUBLESHOOTING): investigate reports with the agent in normal
  permission mode (no bypass/auto-accept), in a worktree or devcontainer without production
  credentials.

## Acceptance criteria
- WHEN the release workflow runs on tag `v0.2.0` THE SYSTEM SHALL push `:0.2.0` and `:latest`
  for amd64 and arm64 to GHCR, and to Docker Hub only if its secrets are set.
- WHEN the image is inspected THE SYSTEM SHALL contain no `.ts`, `.map`, `src/` or `eval/` paths
  under `/app` (CI step fails otherwise).
- WHEN a user runs `docker compose up -d` in a fresh `deploy/` folder with only `.env` filled
  THE SYSTEM SHALL start and serve the app.
- WHEN a user downloads a report THE SYSTEM SHALL produce a zip whose `config.json`, `logs.jsonl`
  and `events.jsonl` contain no value of any configured secret (test greps for each one).
- WHEN a user downloads a report THE SYSTEM SHALL include each configured model id in
  `config.json` and the model that produced each stage artifact.
- WHEN another user requests a report for a project they don't own THE SYSTEM SHALL return 404.
- WHEN an anonymous request asks for a report THE SYSTEM SHALL return 401.
- WHEN `import-report` runs on a report zip in a fresh dev database THE SYSTEM SHALL create a
  project whose transcript, flags, clips and settings equal the originals (round-trip test).
- WHEN a zip contains an entry with `..` or an absolute path THE SYSTEM SHALL refuse the import
  and name the entry.
- WHEN a report's source URL uses a scheme other than http(s) THE SYSTEM SHALL refuse to download it.
- WHEN a transcript or the report text contains "ignore previous instructions" THE SYSTEM SHALL
  print a warning naming the field, and still import.
- WHEN the image is a release (`REELSAW_VERSION` ≠ `dev`) THE SYSTEM SHALL refuse to run
  `import-report` unless `--allow-on-release` is given.
- WHEN the zip has a newer major manifest version THE SYSTEM SHALL refuse with the version found.
- WHEN the source video is unticked for an uploaded-file project THE SYSTEM SHALL say in the
  dialog that the report can't reproduce media-dependent problems without it.

## Auth matrix
| Action | Anonymous | Owner (self-host / admin / hosted without telemetry) | Hosted non-admin with telemetry | Other user |
|---|---|---|---|---|
| Download report for a project | 401 | 200 | 403 | 404 |
| Global report (no project) | 401 | 200 (own account context only) | 403 | - |
| System info in zip | - | allowed when opted in | never | - |
| `import-report` (CLI) | operator only | - | - | - |

## Metrics
- Time from receiving a zip to a local reproduction: under 5 minutes (measure on the first 3 reports).
- Zero secrets found in reports (redaction test in CI).

## Risks
- Bundling breaks dynamic imports or native modules (onnxruntime, sharp): keep native packages
  external and smoke-test the built image (boot + health + one CLI command) in CI.
- Large zips: stream the zip (no buffering in memory); media opt-in shows sizes.
- Log files rotate; reports include what's still on disk and say so.

## Verification
- CI: build image, scan for forbidden paths, boot with compose, `/api/health` 200,
  `reelsaw status` runs.
- Integration tests: redaction (every secret absent), authz (owner/other/anonymous), import
  round-trip on a real project.
- Manual: report from the UI on a real project, import it into a clean dev DB, open it, re-render
  a clip.
