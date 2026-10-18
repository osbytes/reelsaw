# Hosted Reelsaw

## Job
When I run one Reelsaw for people I don't sit next to, I want to decide who gets in, keep the
machine-level settings to myself, and give each person their own settings, so that the same code
that people self-host can also be offered as a service. No payments yet.

Today every signed-in user sees the whole server configuration and the resource meters, sign-ups
are either open to anyone or closed, and the only per-user state is the user's projects.

## Appetite
Three phases of 1–2 days each, shippable one at a time. The self-hosted single-user experience
must not get a single extra click.

## Non-goals (for now)
- Billing, plans, quotas enforced by money. The design leaves room for them (see "Later").
- Organisations / shared workspaces. Projects stay per user.
- Hosted-only features. Everything below is in the open-source build and switched by config.

## Must-be
- A fresh install still works with zero new settings: first sign-up is the admin, sign-ups default
  to `open` so a single-user box behaves exactly as today.
- A pending user can sign in, sees one page ("Waiting for approval"), and nothing else works for
  them (tRPC, MCP, media, uploads all refuse).
- System settings (models, storage, limits, resource meters, version, sign-up mode) are visible
  to admins only. Nothing about the machine leaks to a plain user, including via `settings.get`
  and `/api/health` (health keeps `ok` + version; resources move behind admin).
- Every user has settings of their own, and project creation applies them.

## One codebase, one image

Decisions, in order of how hard they are to reverse:

1. **One repository, one image, no fork.** The hosted service runs the same `ghcr.io/osbytes/reelsaw`
   image as everyone else with different environment: `SIGNUP_MODE=approval`, `STORAGE_DRIVER=s3`,
   extra `worker` replicas, cloud models. A long-lived "hosted" branch or a second repo that copies
   code would diverge within weeks and double every fix. This is how Plausible, Umami, Postiz and
   n8n run their cloud.
2. **Hosted-only code, when it exists, lives in this repo under `ee/`** (one folder per app:
   `apps/server/src/ee`, `apps/web/src/ee`) with its own licence file, loaded only when
   `REELSAW_EE=true`. Billing is the first thing that goes there; nothing in this spec does. This is
   the Cal.com / PostHog / Formbricks / Twenty layout. A separate private wrapper repo (Sentry's
   `getsentry`) only pays off with a large team.
3. **Infrastructure is a separate private repo** (`reelsaw-infra`: compose/terraform, DNS, secrets,
   backups, runbooks). It contains no application code; it pins an image tag.
4. **Licence: AGPL-3.0 for the core (decided 2026-10-17).** Anyone may host it; anyone who hosts a
   modified version must publish the modifications (section 13 closes the SaaS loophole), which
   removes the incentive to fork-and-host privately. Most open-core SaaS (Plausible, Cal.com,
   Twenty, Infisical) chose it. Contributions carry a DCO sign-off so the project keeps the right
   to dual-license. `ee/` later gets a commercial licence.
5. **Config over editions.** No `EDITION=cloud` switch that changes behaviour in many places. Each
   hosted need is its own setting with a self-hosted default (`SIGNUP_MODE`, `EMAIL_DRIVER`,
   `SOURCE_RETENTION_DAYS`, `YTDLP_PROXY`). The hosted deployment is just a particular `.env`.

## Part A: accounts (roles and approval)

- `user.role`: `admin` | `user` (Better Auth `admin` plugin; also gives ban, list users, set role,
  impersonate for support). `user.approvedAt` (nullable timestamp, additional field).
- `SIGNUP_MODE=open|approval|closed` replaces `ALLOW_SIGNUP` (kept as an alias: `true`→`open`,
  `false`→`closed`). Default `open`.
- On user creation (database hook): the first user becomes `admin` + approved; otherwise approved
  when the mode is `open`, pending when `approval`. Sign-up is refused when `closed`.
- Gate in one place: `requester()` returns `pending: true`; `protectedProcedure`, `/api/mcp`,
  media, upload and export routes refuse with `FORBIDDEN` / 403 "waiting for approval". Only
  `me.get` and sign-out work for a pending user. Admin-only procedures use `adminProcedure`.
- Web: `/pending` page; `Protected` redirects there. Admins get a badge on the user menu while
  users wait, and `/admin/users` (list, approve, make admin, ban, delete; search; "pending" first).
- Events: `user.signed_up`, `user.approved` in a new `admin_events` table (feeds the admin page
  and, later, email). Email is optional: `EMAIL_DRIVER=none|smtp|resend`; when set, the admin gets
  "X is waiting" and the user gets "you're in". Password reset and verification turn on with it.
- MCP keys: a pending or banned user's keys verify but the gate refuses, so no special casing.

## Part B: settings for everyone

- Three settings surfaces, one page with sections that appear by role:
  - **Account** (every user): name, email, password, theme (already local), API keys and MCP,
    **project defaults** (language, vocabulary, pauses, source text, caption style, focus
    instructions): a partial `ProjectSettings` stored in `user_settings.project_defaults` (jsonb,
    atomic merge). `projects.create` resolves `defaults ← user defaults ← input`. The new-project
    form is pre-filled from them and offers "save as my defaults".
  - **System** (admins): what `/settings` shows today (models, storage, limits, resource meters,
    render concurrency, version), plus sign-up mode and the email driver, read-only from env.
  - **Users** (admins, hosted or not): Part A.
- `settings.get` splits into `me.get` (user + user settings) and `admin.system` (admin only).
  The "jobs paused" chip in the top bar reads a tiny public `system.status` (`ok` boolean) so
  plain users still learn why nothing is moving, without the numbers.

## Part C: hosted readiness (still open source, still config)

- **Usage per user** (admin "Usage" tab): projects, source minutes ingested, clips rendered,
  storage bytes (sum of stored keys), LLM calls and tokens (from `stage_artifacts` / the LLM
  trace middleware: one `llm_usage` row per call, attributed to the project's owner). Computed on
  demand for the last 30 days; a materialised daily table comes when the query gets slow. This is
  the basis for quotas and, later, billing.
- **Quotas as settings** (`MAX_PROJECTS_PER_USER`, `MAX_SOURCE_MINUTES_PER_DAY`, `MAX_UPLOAD_MB`
  already exists), with per-user overrides in `user_settings.limits` an admin edits. Refusals are
  plain sentences ("Daily limit of 120 minutes reached; resets at 00:00 UTC").
- **Retention** (`SOURCE_RETENTION_DAYS`, `CLIP_RETENTION_DAYS`, default off): the reconciler
  deletes stored sources / renders past the age, keeps rows, and the UI offers "re-fetch".
- **Abuse**: email verification required when `EMAIL_DRIVER` is set, Better Auth `captcha`
  plugin behind `CAPTCHA_PROVIDER`, rate limits on sign-up and project creation per user.
- **yt-dlp from a datacentre IP** gets blocked by YouTube: `YTDLP_PROXY` and `YTDLP_COOKIES_FILE`
  settings, and "upload the file" as the first-class fallback with a clear error.
- **Legal**: `TERMS_URL` / `PRIVACY_URL` shown on sign-up when set.
- **MCP over OAuth 2.1** (`@better-auth/mcp` + `@better-auth/oauth-provider`, dynamic client
  registration) so claude.ai and Claude Desktop connectors sign in with the browser; API keys
  stay for CLIs and scripts. Resource metadata at `/.well-known/oauth-protected-resource/api/mcp`.

## Part D: running it

- Image from the release workflow, `reelsaw-infra` pins the tag. Managed Postgres (point-in-time
  recovery), S3-compatible storage (`STORAGE_DRIVER=s3`), one `app` replica with `RUN_WORKERS=false`
  and 2–4 `worker` replicas (`docker compose --profile workers`, later k8s). Models through the AI
  Gateway or a cloud vendor per `AI_MODEL` / `TRANSCRIPTION_MODEL`; no GPU needed.
- OpenTelemetry on; Langfuse traces tagged by user; `/api/health` for the load balancer.
- Backups: Postgres nightly + S3 versioning; restore drill documented in the infra repo.
- Deploys honour `SHUTDOWN_GRACE_SECONDS`; roll one worker at a time.

## Later (needs the above first)
- Billing in `ee/` (Stripe, plan → quota), organisations (Better Auth `organization` plugin:
  projects get an `organizationId`), SSO.
