# @reelsaw/server

## 0.6.0

### Minor Changes

- [#24](https://github.com/osbytes/reelsaw/pull/24) [`84251b0`](https://github.com/osbytes/reelsaw/commit/84251b0293efbacfa7c6fa971a601af9ab5ef355) Thanks [@dillonstreator](https://github.com/dillonstreator)! - MCP over stdio: `reelsaw mcp` serves the same tools as `/api/mcp` to clients that launch a command instead of calling a URL with a header (Claude Desktop without OAuth, Cursor's stdio entries, registry checks). It forwards every call to a running instance (`REELSAW_URL`, default the app in the same container, with `REELSAW_API_KEY`), so it needs no database or models. Settings → API keys and MCP shows the `docker exec` config next to the HTTP ones.

### Patch Changes

- [#25](https://github.com/osbytes/reelsaw/pull/25) [`711893f`](https://github.com/osbytes/reelsaw/commit/711893fe301cc75662b025cb515175a8778c29e0) Thanks [@dillonstreator](https://github.com/dillonstreator)! - New logo: a sliced "r" monogram on the accent colour, with the wordmark split as reel/saw. Favicon, app icons and the README lockup are redrawn to match.

## 0.5.0

### Minor Changes

- [#18](https://github.com/osbytes/reelsaw/pull/18) [`6cc7335`](https://github.com/osbytes/reelsaw/commit/6cc7335027a90eeb539165ff61b462c8eaf3f363) Thanks [@dillonstreator](https://github.com/dillonstreator)! - A speaker beside an app screen or title card is framed as a stack: that content on top, the speaker below

### Patch Changes

- [#21](https://github.com/osbytes/reelsaw/pull/21) [`af880e7`](https://github.com/osbytes/reelsaw/commit/af880e74f5a12314c8456ab0e26afedd51fc3d5b) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Clips end on a complete thought. A clip that stopped mid-sentence ("…and you're now so | different") now finishes the sentence when it is within 8 seconds (or steps back to the previous one), and starts at the beginning of a sentence when one is within 3 seconds. Sentence ends come from punctuation, pauses and capital letters after a word that is not a connector like "and" or "so". Your manual edits are never moved. See docs/SELECTION.md.

- [#18](https://github.com/osbytes/reelsaw/pull/18) [`6f809da`](https://github.com/osbytes/reelsaw/commit/6f809da1177f71c23ef9313d229b0a2fa7fe9e3c) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Framing is no longer affected by how many clips render at once

- [#23](https://github.com/osbytes/reelsaw/pull/23) [`1d7d51c`](https://github.com/osbytes/reelsaw/commit/1d7d51c56fd0aae1acda259a7ccbe2f9d3a814b2) Thanks [@dillonstreator](https://github.com/dillonstreator)! - A cut you made is always applied. When the seam check could not re-find the removed words in the audio (a sentence said twice, "seven" heard as "7"), the cut used to be dropped silently. It is now matched by its position in the audio instead of by text, with numbers, case and punctuation ignored, and if the seam still cannot be confirmed the cut is applied where you set it and marked "▲ cut unverified" on the clip card, in the editor's cuts tab and next to the cut in the transcript, with a notice in the activity feed. Automatic cuts that cannot be verified are still kept in the audio and reported.

- [#20](https://github.com/osbytes/reelsaw/pull/20) [`da61f0a`](https://github.com/osbytes/reelsaw/commit/da61f0a224981dc24acf7852f690e9ea54f60368) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Fix a deadlock when several clips finish rendering at once (a batch re-render): the render completion no longer fails and re-renders from scratch, and transactions aborted by a lock conflict are retried.

## 0.4.0

### Minor Changes

- [#17](https://github.com/osbytes/reelsaw/pull/17) [`888c6c3`](https://github.com/osbytes/reelsaw/commit/888c6c3d088cd5a7b63a3f2a2ee9b18cfc723fd4) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Select clips on the project page and act on them together: re-render, export a zip of just those clips, copy their titles and captions, set their intro/outro, or retry the failed ones (also `rerender_clips` and `export_project` with `clipIds` over MCP, `reelsaw rerender <clipId…>`, and `?clips=` on the export URL). Clip cards are quieter: one muted summary line (framing, intro/outro, cuts) instead of four rows, Edit and Download up front and everything else in a ⋯ menu. The select-all controls now sit in the sticky "Clips" header.

- [#16](https://github.com/osbytes/reelsaw/pull/16) [`3e55f1f`](https://github.com/osbytes/reelsaw/commit/3e55f1f0b3cb90f66035c68710566886a742ce3c) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Logs now explain what the pipeline decided and why. Every project event (run started, stage completed, clip done or failed) is a log line with the project, run and job ids; at `debug` you also get the moments chosen with their scores, the layout per section and why, each cut accepted or rejected, the ffmpeg commands, framing and bumpers used. API requests, sign-ins, admin actions and MCP tool calls are logged with a request id that is returned in the `x-request-id` header and carried through tRPC errors. `LOG_LEVEL` accepts per-module levels (`info,render=debug`), and `reelsaw log-level render=debug --for 15m` (or Settings, System, Log level) changes them on a running install and puts them back by itself. `reelsaw logs <id>` can filter by time, level and module, issue reports include the level in force, and browser errors are reported to the server log.

- [#11](https://github.com/osbytes/reelsaw/pull/11) [`1fe6a36`](https://github.com/osbytes/reelsaw/commit/1fe6a36fa01fa1e285ed04b3aabc8966ffc29981) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Bound background work and growth: progress ticks are live-only (sent over Postgres NOTIFY, never stored); `EVENT_RETENTION_DAYS` (90), `LLM_USAGE_RETENTION_DAYS` (180) and `ADMIN_EVENT_RETENTION_DAYS` (365) prune old rows daily in batches; deleted fixes beyond 200 are archived instead of dropped; clip diagnostics are capped; transcript edits write only the columns that changed; the storage sweep looks up directories 1,000 at a time with bounded parallel `stat` and resumes from a cursor after a time budget; retention and the library purge use keyset batches; job lookups use `singleton_key`.

- [#11](https://github.com/osbytes/reelsaw/pull/11) [`ba6ada9`](https://github.com/osbytes/reelsaw/commit/ba6ada9e3983dd569713ec241e923f8156cd5550) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Projects and the admin user list load in pages instead of all at once. The Projects page loads 24 at a time as you scroll (or with Load more), shows the true totals in its header, and only polls the projects that are processing. The admin Users page searches on the server (with `%` and `_` matched literally), shows "Showing 50 of N" and loads more on request. The `list_projects` MCP tool takes `limit` and `cursor` and returns `nextCursor` and `total`.

- [#11](https://github.com/osbytes/reelsaw/pull/11) [`8578922`](https://github.com/osbytes/reelsaw/commit/8578922a11425aca0d5168543541a1e4c159f395) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Large projects open and stay fast. The project page no longer re-downloads the whole transcript on every event: the project and its transcript load separately, and each event refreshes only what it changed. The Activity panel replays the last 300 events (configurable with `EVENT_REPLAY_LIMIT`) and shows "Showing the last 300 of N", with a "Load older" button. The command palette (⌘K) now searches on the server as you type (typo-tolerant, best matches first), so it finds every project and clip however many you have, and the MCP server gains `search_clips`. `get_project` returns only a transcript summary; use `get_transcript` for the text. Adds the `pg_trgm` extension and search indexes (migration 0028).

### Patch Changes

- [#11](https://github.com/osbytes/reelsaw/pull/11) [`dc445b7`](https://github.com/osbytes/reelsaw/commit/dc445b70ffd451b0d3fac0513a4a8a00f5f835e0) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Add indexes for the common list, reconcile and retention queries (`projects (user_id, updated_at)`, `projects (status)`, partial retention indexes, `uploads (user_id)`), plus a scale audit (`docs/specs/scale.md`), a Scale section in the engineering principles and a seed script for measuring at 1,000 projects.

## 0.3.1

### Patch Changes

- [#8](https://github.com/osbytes/reelsaw/pull/8) [`d79cf11`](https://github.com/osbytes/reelsaw/commit/d79cf112290aadcd4a73e1f85168fd42db6bcf82) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Pages, lists, pickers and settings now show placeholder skeletons shaped like their content while loading, instead of flashing "No activity yet" or "Nothing found" before the data arrives.

- [#8](https://github.com/osbytes/reelsaw/pull/8) [`de341bb`](https://github.com/osbytes/reelsaw/commit/de341bba6bddda2970cc45dc778cbc9c22493a37) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The Users page is now one aligned list with usage per account, sortable columns and a usage window picker, and the Limits dialog shows how much of each limit an account has used.

## 0.3.0

### Minor Changes

- [#5](https://github.com/osbytes/reelsaw/pull/5) [`02a9343`](https://github.com/osbytes/reelsaw/commit/02a9343f1e42f76e260c1a7db82024cd38033ec8) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Library page for intros and outros: drop several files at once (duplicates are detected), click a thumbnail to view it enlarged, see which projects and clips use each item, remove with Undo. Pickers everywhere are a searchable combobox with thumbnails, and images get a 3 s default that can be changed per item or per use. New projects can pick their intro and outro up front, project cards show the assets in use as small fanned cards, and ⌘K and the New project menu offer library shortcuts. Toasts now use sonner.

- [#5](https://github.com/osbytes/reelsaw/pull/5) [`1241496`](https://github.com/osbytes/reelsaw/commit/12414961d9696616acf3e9979d15963fd233db57) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Intro and outro library: keep several videos or images (PNG or JPG, shown 1 to 10 s) and choose which one new projects start with. Each project can use the default, none, or a specific one, and a single clip can opt out; changes re-render only when confirmed. The editor shows what a clip adds around its source range, and clip cards say when an intro or outro was skipped.

- [#5](https://github.com/osbytes/reelsaw/pull/5) [`02a9343`](https://github.com/osbytes/reelsaw/commit/02a9343f1e42f76e260c1a7db82024cd38033ec8) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Agents and operators can manage intros and outros: MCP tools `list_bumpers`, `add_bumper` (from a URL or an upload), `set_default_bumper`, `remove_bumper`, `restore_bumper`, `bumper_usage`, `set_project_bumpers` and `set_clip_bumpers`; `get_project`, `get_clip` and `create_project` carry intro/outro state. CLI: `reelsaw bumpers …`, `reelsaw project-bumpers`, `reelsaw clip-bumpers`.

- [#5](https://github.com/osbytes/reelsaw/pull/5) [`6a53f17`](https://github.com/osbytes/reelsaw/commit/6a53f1706eb03c180703c19004db7ea554a560b9) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Choose an intro and outro per clip: each clip can follow the project, use none, or use a specific library item, per slot. Set it in the editor, from a clip card, or for several selected clips at once on the project page. Replaces the all-or-nothing opt-out.

- [#5](https://github.com/osbytes/reelsaw/pull/5) [`02a9343`](https://github.com/osbytes/reelsaw/commit/02a9343f1e42f76e260c1a7db82024cd38033ec8) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Command palette (⌘K): rows show status, length, clip counts and age; → or Tab on a project or clip opens its actions (open, export, resume, retry failed clips, re-run refine, delete, edit, re-render, download) with confirms for the destructive ones. "Retry all failed clips" and "Resume failed projects" appear when there is something to retry. A pasted link that matches an existing project offers to open it, and a list of links starts one project each.

- [#5](https://github.com/osbytes/reelsaw/pull/5) [`8e99bb4`](https://github.com/osbytes/reelsaw/commit/8e99bb466c160e68c29325a3aafd6bfb851fd77a) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Intro and outro videos: upload one of each in Settings and every clip of new projects is rendered as intro + clip + outro in a single encode. Bumpers are fitted to vertical with a blurred background, normalised once per asset, and an unusable one is skipped with a plain-language event instead of failing the clip. Exports gain `rendered_duration_sec`.

- [#5](https://github.com/osbytes/reelsaw/pull/5) [`02a9343`](https://github.com/osbytes/reelsaw/commit/02a9343f1e42f76e260c1a7db82024cd38033ec8) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Processing time is measured per run. Every retry, re-render, refine or re-analyze starts an explicit run (`run.started`), stage and project events carry their own durations, and the activity feed groups history by run with its reason and total. A clip re-rendered hours after a project finished now reports its own time instead of the time since the first run. Expected-time estimates, Processing times and `reelsaw status` read the same runs.

- [#5](https://github.com/osbytes/reelsaw/pull/5) [`02a9343`](https://github.com/osbytes/reelsaw/commit/02a9343f1e42f76e260c1a7db82024cd38033ec8) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Storage: superseded render generations and expired sources are removed from the scratch directory too, uploads are released when a project is deleted, and an hourly sweep removes orphaned files. `reelsaw storage` reports unique, leftover, duplicate-source and expired bytes; `reelsaw storage sweep [--dry-run]` runs the sweep on demand. Removed intro/outro assets that nothing references are purged after 30 days.

### Patch Changes

- [#5](https://github.com/osbytes/reelsaw/pull/5) [`02a9343`](https://github.com/osbytes/reelsaw/commit/02a9343f1e42f76e260c1a7db82024cd38033ec8) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Space in the clip preview plays that clip instead of the hidden source video. The "jobs paused" chip sits left of the search box so it no longer shifts the header when it appears. Changing an intro/outro length in the editor now enables Save & re-render.

- [#5](https://github.com/osbytes/reelsaw/pull/5) [`02633c7`](https://github.com/osbytes/reelsaw/commit/02633c732117f2abffe262962d65b08ab575768f) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Windows: a PowerShell one-line installer (`install.ps1`) next to the bash one. Both installers are now served straight from the repository (raw.githubusercontent.com) instead of a gist.

## 0.2.0

### Minor Changes

- [`1fc2886`](https://github.com/osbytes/reelsaw/commit/1fc28860f5c06cec3c57d4b8633d8f55feda2735) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Accounts and roles: the first account is the admin; `SIGNUP_MODE=open|approval|closed` controls sign-ups (approval holds new accounts on a "Waiting for approval" page until an admin approves them on the new Users page). Admins can suspend, reinstate, promote and remove accounts; `reelsaw users|approve|make-admin` from the shell. Optional email (`EMAIL_DRIVER=smtp|resend`) sends approval notices, password resets and verification.
  
  **Upgrade:** existing accounts stay approved; the oldest becomes the admin. `ALLOW_SIGNUP=false` still means `closed`.

- [#4](https://github.com/osbytes/reelsaw/pull/4) [`4142149`](https://github.com/osbytes/reelsaw/commit/41421494ef06858ab96f4e049b830763cf9ee6c2) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Admins can switch models and connect providers without a restart. Settings → System → Models has pickers for the language, transcription and alignment models; each opens provider-first: pick a provider, and if it has no key or server URL yet, enter it right there (stored encrypted with a key derived from `BETTER_AUTH_SECRET`; never shown again; `.env` stays the default) and its models appear. Cloud vendors are listed live (OpenAI, Anthropic, Google, Groq, Deepgram, AssemblyAI, the Vercel AI Gateway with prices); self-hosted Ollama or Speaches show what is installed and download missing models with a progress bar. Saving a key tries it first (lists the provider's models); saving a model verifies it (key, server, word timestamps for transcription). Overrides live in the database so every process picks them up within seconds; a stage that is already running finishes with the model it started with. API: `admin.providers.get/set/clear`, `admin.models.get/catalog/set/test/pull`; changes go to the admin event log.

- [#3](https://github.com/osbytes/reelsaw/pull/3) [`b128b11`](https://github.com/osbytes/reelsaw/commit/b128b11da85c1d62cb52a699dd26ac304369903c) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Expected vs actual processing time: the project page shows elapsed and expected time for the running stage, the activity feed says how long each stage took against its expectation, and Settings → System → Machine (admins) has a per-stage expected vs actual table across recent projects. Expectations start from measured defaults (README, "What to expect") and become the median of your own finished projects that ran with the same models; there is no calibration step. Also a proper not-found page for missing projects and clips.
  
  For contributors: `pnpm eval ... --matrix eval/bench/models.json` runs the suites once per model profile (env overrides on `.env`; cloud models through the Vercel AI Gateway, `gateway:<vendor>/<model>`) with latency, tokens and cost per profile side by side, and `pnpm bench:e2e` times the real pipeline per stage in an isolated compose stack, with `--steps refine,analyze` to re-run just those steps on one transcript. The first result set is in `eval/bench/results/2026-10-17-initial/`.

- [`1fc2886`](https://github.com/osbytes/reelsaw/commit/1fc28860f5c06cec3c57d4b8633d8f55feda2735) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Running Reelsaw for many people: quotas (`MAX_PROJECTS_PER_USER`, `MAX_SOURCE_MINUTES_PER_DAY`, `MAX_NEW_PROJECTS_PER_HOUR`, per-user overrides on the Users page) with plain-sentence refusals; usage per user (projects, source minutes, clips, model calls and tokens, stored bytes); retention (`SOURCE_RETENTION_DAYS`, `CLIP_RETENTION_DAYS`, "fetch again" on the project); captcha on sign-up/sign-in (`CAPTCHA_PROVIDER`); `YTDLP_PROXY` / `YTDLP_COOKIES_FILE` and plain-words download failures; `TERMS_URL` / `PRIVACY_URL`; MCP over OAuth 2.1 (`MCP_OAUTH=true`) so claude.ai and Claude Desktop connectors sign in with the browser. All off by default.

- [`1fc2886`](https://github.com/osbytes/reelsaw/commit/1fc28860f5c06cec3c57d4b8633d8f55feda2735) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Agents can drive Reelsaw over MCP: `POST /api/mcp` (Streamable HTTP) with tools to create projects, wait for them, read timed transcripts, edit, re-render and download clips. API keys (Settings → API keys and MCP) authenticate MCP, tRPC, uploads and media downloads; the page shows the Claude Code and mcp.json config.

- [`1fc2886`](https://github.com/osbytes/reelsaw/commit/1fc28860f5c06cec3c57d4b8633d8f55feda2735) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Settings are per person: everyone gets Account (name, password), Project defaults (vocabulary, instructions, language, clip length, pauses, caption style; applied to every new project, the new-project form starts from them) and API keys. Machine configuration and resource meters are shown to admins only, and `GET /api/health` includes them only for admins (or with `HEALTH_DETAILS=true`).

### Patch Changes

- [`1fc2886`](https://github.com/osbytes/reelsaw/commit/1fc28860f5c06cec3c57d4b8633d8f55feda2735) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Project licensed under AGPL-3.0 with a DCO sign-off for contributions; releases are versioned with changesets (`docs/RELEASING.md`), CI typechecks and builds every PR.
