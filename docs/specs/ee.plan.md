# Plan: enterprise edition and billing

Spec: [ee.md](ee.md). Check off as done. Each phase ships on its own; A ships to self-hosters too.

## A. Monthly allowance (core, no EE)
- [x] A1 (2026-10-19) `MAX_SOURCE_MINUTES_PER_MONTH` in `config.ts`, `instance-settings.ts` ("limits"), `LIMIT_KEYS`
      in `quota.ts`, the per-user Limits dialog, `deploy/.env.example`, README "Hosting for many
      people" and "Settings and precedence". 0 = unlimited.
- [x] A2 (2026-10-19) `periodFor(db, userId)` in `quota.ts`: billing period when a `subscription` row with a
      period exists, else the UTC calendar month; `minutesInPeriod` next to `minutesToday`.
      Early check in `checkProjectQuota`, real check in `sourceMinutesExceeded`, both with the
      sentence from the spec; `limitUsage` reports it. Test: cap reached refuses with the date.
- [x] A3 (2026-10-19; the toast shows the URL as text, not a link) Quota sentences take an optional `upgradeHint` (a sentence + URL) from an entitlements
      provider; `undefined` self-hosted. The web `QuotaError` toast renders the link.

## B. `ee/` module
- [x] B1 (2026-10-19) Folders `apps/server/src/ee/` and `apps/web/src/ee/` with `LICENSE` (spec text), root
      `LICENSING.md`, README "License" paragraph updated (it still says nothing is there yet).
      `REELSAW_EE` in `config.ts` (boolFalse) plus `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
      `STRIPE_MANAGED_PAYMENTS`, `BILLING_GRACE_DAYS`; cross-checks: EE on requires the Stripe keys.
- [x] B2 (2026-10-19, changed) `stripe@23` only, no Better Auth plugin (spec decision 2). Tables
      `billing_customers`, `billing_subscriptions`, `billing_events` in `db/schema.ts`; migration
      `0032_billing_watermark` (also `clips.watermark`, `user_settings.watermark`).
- [x] B3 (2026-10-19; tests in `test/billing.test.ts`) `ee/billing/plans.ts` (Free, Creator, Pro; lookup keys; limits; copy) and
      `ee/billing/entitlements.ts` (`limitsFor`, status → plan rule, grace days). `quota.ts`
      `limitsFor` consults `svc.ee?.entitlements` between instance settings and the override;
      the admin Limits dialog shows the source per value. Tests: active → plan limits, past_due
      inside and outside grace, canceled at period end, override beats plan.
- [x] B4 (2026-10-19, changed) `ee/billing/service.ts`: customer on first checkout, Checkout /
      Portal URLs, `POST /api/billing/webhook` (event row + sync job in one transaction),
      `billing.sync` job (retrieve from Stripe, lock, rewrite, admin events), `billing.reconcile`
      daily. Boot self-check resolves every lookup key.
- [x] B4b (2026-10-19, against the mock) `test/stripe-mock.ts` stands in for api.stripe.com
      (`STRIPE_API_BASE`) and delivers signed webhooks in reverse and twice;
      `test/billing-stack.test.ts` runs checkout → plan change → failed payment → recovery →
      redelivery → unsigned → cancel → reconcile against the running app. Still to do once a Stripe
      account exists: the same run with `stripe listen` and a test clock.
- [x] B5 (2026-10-19) `billing.reconcile` daily job and `reelsaw billing sync [user]` (pages of Stripe
      subscriptions, update rows that differ, `warn` per fix). `reelsaw billing <user>`,
      `reelsaw billing set-plan <user> <plan>` (complimentary row, audited).
- [x] B6 (2026-10-19; `admin.billing.setPlan/sync`) tRPC `billing.get/checkout/portal`, `admin.billing.list/setPlan`; MCP `get_billing`,
      `billing_checkout_url`; all on `ee/billing/service.ts`. `me.get` returns `ee: { billing }`.
- [x] B7 (2026-10-19; Billing tab at /settings/billing, checked in the browser against the mock; the 390 px pass still to do on a real phone) Web Settings → Billing (`apps/web/src/ee/billing/`, `React.lazy` behind `me.ee.billing`):
      plan card, usage bars (skeleton while pending), plan grid with one button per plan,
      `?checkout=success` toast that refetches until the row shows the plan (webhook race).
      Users page: plan column and "comp a plan" in the ⋯ menu. 390 px check.
- [x] B8 (2026-10-19) `ADMIN_EVENT_TYPES` gains the `billing.*` types; Users → Events shows them.

## C. app.reelsaw.com
- [ ] C1 Stripe account: `pnpm stripe:setup --webhook --portal` (scripts/stripe-setup.ts, written
      2026-10-19: products, prices under the lookup keys, tax code `txcd_10103000`, webhook endpoint,
      portal configuration), Managed Payments eligibility request; `STRIPE_MANAGED_PAYMENTS` follows
      it. Runbook: `reelsaw-infra/runbooks/billing.md`.
- [x] C2 (2026-10-19, `.env.example` + runbook in reelsaw-infra; the real `.env` waits for the keys)
      `REELSAW_EE=true`, Stripe keys, `TERMS_URL` / `PRIVACY_URL` to reelsaw.com.
- [x] C3 (2026-10-19; `/terms` and `/privacy` drafted in `website/content/legal.ts`, bracketed facts
      and a counsel read still open) Website: `/pricing`
      from `website/content/pricing.ts` (server test asserts it matches `plans.ts`), `SITE.app`,
      sign-up buttons, the "no hosted plan" copy reworded; footer and nav links.
- [x] C4 (2026-10-19) `/signup?plan=<name>&interval=` remembered in localStorage for a day, applied
      after the first sign-in (or the verification link), Billing page starts the Checkout.
- [ ] C5 (rehearsed locally 2026-10-19 with `test/billing-stack.test.ts`, 10/10) Smoke on production with a test card before the keys go live: Free account hits the
      60-minute cap and sees the hint; upgrade to Creator; the cap moves within a minute; cancel at
      period end; `reelsaw billing sync` reports nothing to fix.

## W. Watermark (added 2026-10-19)
- [x] W1 `WATERMARK_NON_ADMINS` (default on), `WATERMARK_TEXT`; `user_settings.watermark` override;
      `watermarkFor` in `quota.ts` (override → plan → instance, admins never by default).
- [x] W2 Rendered through the ASS file (`captions.ts`, Watermark style, bottom centre); recorded in
      `clips.watermark`; the clip card shows "◇ wm" with a tooltip.
- [x] W3 Users → Limits: watermark select (follow / always / never) with the decision and its source;
      `admin.users.setWatermark`; admin event `user.watermark_changed`.
- [x] W4 (2026-10-19) Rendered a 1080×1920 frame through `buildAss`: bottom centre at 91% height,
      46 px, under the captions, clear of the hook.

## Done gate
- Self-hosted boot with `REELSAW_EE` unset: no `ee/` import (assert in a test by stubbing
  `import()`), no new env needed, the Settings page has no Billing tab, `subscription` is empty.
- A paying user's limits are the plan's, an admin override still wins, and the Users page says
  which applies.
- A webhook dropped on purpose is repaired by the nightly reconcile and by `reelsaw billing sync`.
- Typecheck both apps, `pnpm --filter @reelsaw/server test`, browser check at 390 px, and
  `LICENSING.md` plus README agree with the folders on disk.

## P. Pricing (2026-10-19)
- [x] P1 Plans match OpenShorts Cloud: Free (first video up to 60 min, then 20 min/mo, watermark),
      Starter $12 / 100 min, Creator $29 / 300 min, Pro $59 / 750 min + priority queue; yearly = two
      months free. `plans.ts`, `website/content/pricing.ts`, the OpenShorts comparison, the feature
      column, the no-watermark guide and the landing page all say the same thing.
- [x] P2 First-video allowance (`firstVideoFreeMinutes`) in `quota.ts` `monthlyMinutes`; Pro queue boost
      (`queuePriority`) added to the fair-share priority in `uow.ts`. Stack test covers the allowance.
- [ ] P3 Free clips kept 7 days (OpenShorts does this): needs `CLIP_RETENTION_DAYS` per user; also the
      first-video allowance resets never (one per account), which is what OpenShorts' copy implies.

## X. Free-tier abuse and telemetry (2026-10-19)
- [x] X1 Sign-up guards in `abuse.ts` (accounts per address per day, disposable domains, one account per
      mailbox via `user.email_key` + unique index with a backfill in migration 0033), `TRUST_PROXY`.
- [x] X2 Per-account change rate (`user_rate` minute buckets; `MAX_REQUESTS_PER_MINUTE` / `_HOUR`) on
      tRPC mutations and MCP tool calls.
- [x] X3 Hourly flags (`user.flags`, admin event `user.flagged`), Users page chips + "Flagged only",
      `reelsaw abuse [--run]`. Stack test `test/abuse-stack.test.ts`.
- [x] X4 Sentry + PostHog (`telemetry.ts`, `lib/telemetry.ts`), off unless keyed; infra env + runbook
      `abuse.md` with the Cloudflare rules.
- [ ] X5 Cloudflare in front of app.reelsaw.com (rules in the runbook); origin firewall to Cloudflare
      ranges.
- [ ] X6 Free-plan retention (clips 7 days) and a lower `MAX_SOURCE_FILE_MB` on Free: both need per-user
      overrides of non-quota settings.
