# Plan: hosted Reelsaw

Spec: [hosted.md](hosted.md). Check off as done. Each phase ships on its own.

## 0. Agents (done 2026-10-16)
- [x] API keys (`@better-auth/api-key`, `apikey` table, migration 0014), `requester()` in
      `auth.ts` resolves cookie or `Authorization: Bearer rs_…` for tRPC, MCP, upload, media,
      export and report routes.
- [x] MCP server `src/mcp.ts` at `POST /api/mcp` (Streamable HTTP, stateless, JSON responses),
      tools over `appRouter.createCaller`. Settings page: create / list / revoke keys with
      Claude Code and mcp.json snippets. Test `test/mcp.test.ts`. README + deploy README.

## A. Accounts
- [x] A1 `LICENSE` (AGPL-3.0-only, 2026-10-17), `CONTRIBUTING.md` with DCO sign-off, README "License", `license` in every package.json.
- [x] A2 Schema: `user.role`, `user.banned`/`banReason`/`banExpires` (admin plugin), `user.approvedAt`;
      migration. `SIGNUP_MODE` in `config.ts` with `ALLOW_SIGNUP` alias; boot log prints it.
- [x] A3 `auth.ts`: `admin()` plugin, `additionalFields`, `databaseHooks.user.create.after`
      (first user → admin + approved; else by mode). Sign-up refused when `closed` (today's
      `disableSignUp`). Test: first user admin, second pending under `approval`.
- [x] A4 Gate: `requester()` returns `{ user, pending, banned }`; `protectedProcedure` and every
      HTTP route refuse pending/banned with a sentence; `adminProcedure`. Test: pending user gets
      403 on tRPC, MCP, media; admin passes.
- [x] A5 tRPC `admin.users.list/approve/setRole/ban/remove` over `auth.api.*` (admin plugin
      endpoints); `admin_events` table written in the same unit of work.
- [x] A6 Web: `/pending` page, `Protected` redirect, `/admin/users` (pending first, approve in
      one click, confirm dialogs for ban/delete), user-menu badge with the pending count.
      Verify in browser at 390 px.
- [x] A7 Email (optional): `EMAIL_DRIVER=none|smtp|resend`, `email.ts` service with self-check
      at boot, templates for "waiting", "approved", reset, verify. Off by default.
- [x] A8 Docs: README "Accounts and roles", deploy README `.env.example` (`SIGNUP_MODE`).

## B. Settings for everyone
- [x] B1 `user_settings` table (`user_id` pk, `project_defaults` jsonb, `limits` jsonb,
      `updated_at`); migration. Shared `userSettingsSchema` (partial `ProjectSettings` subset:
      language, vocabulary, pauses, sourceText, style fields, instructions).
- [x] B2 tRPC `me.get` (user, role, settings), `me.updateSettings` (atomic jsonb merge),
      `me.updateProfile`; `projects.create` resolves defaults ← user ← input (one function in
      `pipeline/settings.ts`, also used by `reanalyze`). Test: defaults applied, input wins.
- [x] B3 `admin.system` replaces today's `settings.get` for admins; `system.status` (public, just
      `{ ok, pausedReason? }`) feeds the top-bar chip. `/api/health` returns resources to admins
      only (or with `HEALTH_DETAILS=true` for load balancers on a private network).
- [x] B4 Web `/settings`: Account (profile, password, theme, API keys, project defaults form with
      "save as my defaults" also offered on the new-project page), System (admin), Users (admin,
      link to A6). Verify at 390 px.
- [x] B5 Docs: README settings section; PRINCIPLES "settings are overrides" gets the user layer.

## C. Hosted readiness
- [x] C1 Usage: computed on demand (`admin.usage`) from `projects`, `clips`, `uploads` and a new
      `llm_usage` row per model call (written by the LLM middleware, attributed to the owner);
      `projects.source_bytes` recorded at ingest. Users → Usage tab. No nightly table needed at
      this scale; add one when the query gets slow.
- [x] C2 Quotas: `MAX_PROJECTS_PER_USER`, `MAX_SOURCE_MINUTES_PER_DAY` + per-user `limits`
      override; checked in `projects.create` / ingest (duration known after ffprobe → fail the
      project with a plain reason). Test: limit reached refuses with the sentence.
- [x] C3 Retention: `SOURCE_RETENTION_DAYS`, `CLIP_RETENTION_DAYS`; reconciler sweep deletes
      storage objects after commit (`u.afterCommit`), marks rows, UI "re-fetch". Test with
      backdated rows.
- [x] C4 Abuse: email verification when `EMAIL_DRIVER` set, `captcha` plugin behind
      `CAPTCHA_PROVIDER`/keys, per-user rate limit on `projects.create`.
- [x] C5 yt-dlp: `YTDLP_PROXY`, `YTDLP_COOKIES_FILE`; ingest error for blocked downloads says
      "upload the file instead" with the upload link.
- [x] C6 `TERMS_URL` / `PRIVACY_URL` on the sign-up page.
- [x] C7 MCP OAuth (verified end to end locally: DCR → consent page → code → token → MCP tool call): `@better-auth/mcp` + `@better-auth/oauth-provider`, DCR on, protected-resource
      metadata, `requester()` accepts the OAuth access token; keys unchanged. Test with the MCP
      inspector and a claude.ai custom connector.

## D. Running it
- [x] D1 `reelsaw-infra` skeleton at ~/workspace/reelsaw-infra (local git init, not pushed): compose for
      app + workers + Caddy, .env.example, deploy.sh, runbooks (backup/restore, upgrade, incidents).
      Provisioning (VM, managed Postgres, bucket, DNS) still to do.
- [ ] D2 Release `v0.2.0` with A+B; deploy with `SIGNUP_MODE=approval`; admin = first sign-up.
- [ ] D3 Smoke: sign up a second account, approve it from the admin page, run one project end to
      end through the MCP tools with that account's key.

## Done gate
- Fresh self-hosted install (`deploy/`) behaves as before with no new env; first user is admin.
- A pending user cannot reach any data by any route (tRPC, MCP, media, export, upload).
- Plain users never see machine configuration or resource numbers.
- Typecheck both apps, `pnpm --filter @reelsaw/server test`, browser check at 390 px.
