# Enterprise edition and billing

Follows [hosted.md](hosted.md), which left billing to "Later". Plan: [ee.plan.md](ee.plan.md).

## Job
When I run Reelsaw as a service at app.reelsaw.com, I want people to pick a plan, pay for it, and
have that plan set what their account may do, without me touching the admin page, filing sales tax
in forty countries, or forking the code the self-hosters run; so that the hosted service pays for
its models and machines while the open-source product stays whole.

Today an admin sets per-user limits by hand on the Users page, every account on a hosted box gets
the instance quotas, and nothing in the repository is under any licence but the AGPL.

## Appetite
Three phases of 1–3 days each, shippable one at a time. A self-hosted install must not gain a
setting, a screen, a dependency that phones home, or a slower boot. With `REELSAW_EE` unset the
`ee/` code is never imported.

## Non-goals (for now)
- Organisations, seats, SSO. Billing is per user; the data model leaves the door open (see
  "Decisions", 7).
- Overage billing and prepaid minute packs. Plans are hard caps with plain refusals; "Later".
- Paid self-hosted features and licence keys. The first EE feature is hosted-only; the licence
  text already allows the next ones.
- A pricing experiment framework, coupons beyond what Stripe offers, affiliate links.
- Hosted-only pipeline features. The clips a paying user gets are the clips a self-hoster gets.

## Must-be
- A plan is a named set of limits. Changing a plan's limits is a config change, not a migration.
- The account's limits follow the subscription within a minute of Stripe changing it, and an admin
  can still override any single limit for one user (support, abuse) and see why a value applies.
- Every refusal a paying user can hit says what they bought, what they used, when it resets, and
  what the next plan gives, in one sentence with one link.
- A missed webhook never locks a paying user out: a nightly reconcile and a `reelsaw billing sync`
  command re-read Stripe. A failed payment gives a grace period before limits fall to Free.
- The same facts are on the Billing page, in `get_billing` over MCP, and in `reelsaw billing`.
- Free is a plan, not a trial: no card to sign up, and the Free limits are what an abandoned or
  cancelled account falls back to.

## Research: what was weighed (October 2026)

**Payment provider.** Four candidates, all with a Better Auth adapter or an HTTP API:

| | Stripe (processor) | Stripe + Managed Payments | Polar | Paddle / Lemon Squeezy |
|---|---|---|---|---|
| Merchant of record (they file VAT / sales tax) | no (Stripe Tax calculates, you register and file) | yes, 80+ countries | yes | yes |
| Fee on a $15 plan | 2.9% + 30¢ = $0.74 | + about 3.5% = about $1.26 | Starter 5% + 50¢ = $1.25; Pro ($20/mo) 3.8% + 40¢ | 5% + 50¢ = $1.25 |
| Subscriptions, portal, plan change, trial | Billing + Customer Portal | same (Checkout and Payment Links only; subscriptions must start in Checkout) | own portal, meters and credits built in | own portal |
| Better Auth plugin | `@better-auth/stripe` (first party) | same | `@polar-sh/better-auth` (by Polar) | none |
| Lock-in / exit | cards stay with you | toggle per Checkout Session | no import of Stripe subscriptions either way | Lemon Squeezy is now part of Stripe |
| Risk | you owe the tax work | eligibility review; customer sees "Sold through Link" on receipts | young company; fee tiers changed May 2026 | slowest payouts, heaviest onboarding |

Decision: **Stripe through `@better-auth/stripe`, with Managed Payments switched on for the
Checkout Sessions once the account passes Stripe's eligibility review; Stripe Tax if it does not.**
The fees are a wash with the other merchant-of-record options at this size, and Stripe is the only
one where the merchant-of-record choice is a flag on one API call rather than a different
integration. The Better Auth plugin is maintained by the same people as the auth we already run
(1.7.x), stores the subscription next to the user, handles the webhook race on the success URL,
and has a `referenceId` so the organisation plugin can own a subscription later without a data
migration. Polar is the runner-up: its usage meters and credits would do the "minutes per month"
accounting for us, but we already count minutes in Postgres for self-hosted quotas and want one
code path; and if Polar changed its fees again or folded, every card would have to be re-collected.

**Metered billing.** Stripe's own direction for usage-based pricing moved to Metronome in 2026;
the Billing Meters API stays for simple cases. We need neither now: a plan is a monthly allowance
counted from `projects.duration_sec`, which we already store, enforced in the same transaction as
every other quota. Overage, when it comes, is a one-time Checkout for a minute pack written to a
ledger we own ("Later"), not a metered price.

**`ee/` layout and licence.** Cal.com, PostHog, Formbricks, Twenty, Docmost and LLM Gateway all
keep the commercial code inside the open repository under an `ee/` folder with its own licence
file, shipped in the same image, and switch it on with an environment variable or a licence key.
The PostHog text is the shortest workable model: production use needs an agreement with the
vendor, modification and development use are free, redistribution is not. Formbricks adds a
licence-key check against its own server with a grace period; that is the shape a paid
self-hosted EE would take later, not now.

**What competitors sell.** Opus Clip: Free 60 processing minutes a month with a watermark,
Starter $15 (150 minutes), Pro $29, credits beyond that. Vizard: Free 60 upload minutes at 720p
with 3-day storage, Creator from about 600 minutes. Klap: 100 / 300 / 1,000 clips a month at
$14 / $39 / $94 billed yearly. The market unit is **minutes of source per month**; clips, storage
and retention are the secondary dials. Our bench (`eval/bench/results/2026-10-17-initial`) puts
the model cost of a cloud run at roughly $0.02–0.04 per source minute (Deepgram or whisper-1 plus
Haiku-class selection and refinement), before compute and storage.

## Decisions, in order of how hard they are to reverse

1. **Billing code lives in `apps/server/src/ee/` and `apps/web/src/ee/`, each with a `LICENSE`
   (the Reelsaw Enterprise License, below), and is imported only when `REELSAW_EE=true`.** The
   image is the same; the self-hosted boot path never touches the folder. `README.md` "License"
   and a root `LICENSING.md` say which folder is under which licence; `package.json` `license`
   stays `AGPL-3.0-only` because that is the licence of the package as a whole, with the `ee/`
   exception named in the README (what Cal.com and PostHog do).
2. **Stripe, through the `stripe` SDK directly, not the Better Auth plugin** (changed 2026-10-19
   while building it). The plugin's webhook handler writes rows outside our unit of work, has no
   idempotency store and applies payloads in arrival order; billing had to meet the consistency
   rules every other state change meets. What we use from Stripe: Checkout, the Billing Portal
   (including its confirm-update flow for plan changes), webhooks, `subscriptions.retrieve`. Stripe
   is the source of truth; `billing_subscriptions` is a cache that only the sync job writes, whole,
   from Stripe. Nothing reads Stripe on a request path.
   - **Webhook durability.** `POST /api/billing/webhook` verifies the signature, then in one
     transaction inserts the event (`billing_events`, Stripe's event id as primary key, so a
     redelivery conflicts and is acknowledged without a second job) and enqueues `billing.sync`
     for the subscription (pg-boss `send` on the transaction's connection). 2xx only after commit;
     any failure is a 5xx and Stripe redelivers for up to three days.
   - **Convergent sync.** The job retrieves the subscription from Stripe at run time, takes a
     per-account advisory lock, locks the row, rewrites it, writes `admin_events` for what
     changed (`billing.subscribed`, `.changed`, `.payment_failed`, `.canceled`) and marks the
     events processed, in one transaction. Events late, twice or out of order give the same row.
     One sync per subscription at a time (`exclusive` + singletonKey); a sync queued during
     another waits and reads the newer state. pg-boss retries a failed sync eight times with
     backoff; the error is kept on the pending event rows.
   - **Reconcile.** Daily at 04:17 UTC and on `reelsaw billing sync`: every subscription at Stripe
     vs our rows, rows Stripe no longer lists, and events pending for over an hour. Orphans
     (subscriptions with no account) are listed, never guessed.
   - **Two live subscriptions** for one account (two checkouts racing) are logged as an error with
     both ids; the one Stripe created later owns the row (`stripe_created`), whichever event arrives
     last; the operator cancels the other in Stripe.
   - **Events during an active sync.** The sync queue is `stately` (one queued and one active job per
     subscription), and a sync only marks events received before its own read of Stripe, so an event
     that lands while a sync runs queues the next sync instead of being swallowed.
   - **Complimentary grants** outrank the history of an ended Stripe subscription: a late `deleted`
     for the old subscription, or an admin "sync", leaves the grant in place.
   - **Removed accounts.** A subscription whose account no longer exists is handled like one with
     no account: its events are marked processed with a reason and the reconcile lists it as an
     orphan (the after-commit cancel at Stripe normally ends it first).
   - **Reconcile scope.** The daily walk lists only the statuses that matter (active, trialing,
     past_due, unpaid, paused), never every subscription the account ever had, and refuses to cancel
     rows en masse when more than a few are unknown to Stripe (a wrong or rotated key).
   - **Yearly plans** count their minutes per month of the year (anchored on the period start), not
     once per year.
   - **The webhook body is capped** at 1 MB before it is read; the signature is checked after.
   - **Account removal** cancels the Stripe subscription after commit (best effort, logged); the
     reconcile lists what remains.
   - **Checked against Stripe's docs (2026-10-19):** ordering is not guaranteed and `created` must not
     be used to order (we key on event id and retrieve the object); respond 2xx before complex work
     (we commit one row + one job, then answer); handle events asynchronously (pg-boss); verify the
     signature on the raw body (`constructEventAsync`, 5-minute tolerance); events follow the
     endpoint's API version, not the SDK's (the setup script pins it; invoice parsing also accepts
     the pre-2025 `subscription` field); idempotency keys expire after 24 hours (customer creation
     also looks the customer up by email + metadata); IP allowlisting is recommended on top of
     signatures (infra runbook).
3. **A plan is config, not a row.** `ee/billing/plans.ts` holds the plan list: name, Stripe price
   lookup keys (monthly, yearly), the limits it grants, and the marketing line. The lookup keys
   are stable; the Stripe prices behind them can be rotated without a deploy. Free is in the same
   list with no price.
4. **Plan limits are the limits we already have.** A plan sets `MAX_SOURCE_MINUTES_PER_MONTH`
   (new; see Part A), `MAX_STORAGE_MB`, `MAX_PROJECTS_PER_USER`, `MAX_LIVE_JOBS_PER_USER`,
   `MAX_RERENDERS_PER_HOUR`, `MAX_NEW_PROJECTS_PER_HOUR`. No new kind of limit for billing alone;
   features (MCP, intros/outros, every layout) are the same on every plan. What differs is how
   much, how fast (queue priority) and how long files are kept.
5. **Precedence: environment → instance setting → plan → admin's per-user override.** The admin
   override wins so support can grant a customer more without touching Stripe, and the Users
   page shows the source of each effective value ("Pro plan", "override by Dana"). This is the
   one line that changes in `quota.ts`: `limitsFor()` asks an optional entitlements provider
   before it applies the per-user override.
6. **Subscription state → limits**: `active` and `trialing` grant the plan; `past_due` keeps the
   plan for `BILLING_GRACE_DAYS` (7) after the first failed payment, then Free; `canceled`,
   `unpaid`, `incomplete_expired` and no row mean Free. Cancelling keeps the plan until the period
   end (Stripe's `cancel_at_period_end`), which the plugin stores.
7. **Per user now, organisations later.** The plugin's `referenceId` is the user id today. When
   organisations arrive, a workspace's subscription carries its organisation id and
   `limitsFor()` resolves the owner's workspace; nothing about the plan list or the limits
   changes.
8. **No money logic in the core.** The core gains two seams only: the entitlements hook in
   `quota.ts` (`svc.entitlements`, null self-hosted) and an "upgrade hint" the quota sentences
   append when a plan gives one. Both are no-ops self-hosted.
9. **Watermark (added 2026-10-19).** Accounts that are not admins get a small text watermark
   (`WATERMARK_NON_ADMINS`, default on; `WATERMARK_TEXT`) burned into their clips through the same
   ASS file as the captions, so no new ffmpeg filter. A paid plan removes it (`watermark: false`
   in `plans.ts`); an admin can force it on or off per user (Users → Limits, `user_settings.watermark`).
   Same chain as the quotas: override, plan, instance setting. Decided at render time and recorded
   on the clip (`clips.watermark`), so a re-render after an upgrade drops it and the card says so. The flag is the other way round too: a lapse
   or downgrade does not re-watermark clips already rendered; only new renders get the watermark.

## Part A: a monthly allowance in the core

The one core change billing needs, useful on any shared box:

- `MAX_SOURCE_MINUTES_PER_MONTH` joins `LIMIT_KEYS`, `config.ts`, `instance-settings.ts`
  ("limits" group) and the per-user override dialog. 0 = unlimited. The daily limit stays.
- The window is the account's billing period when there is one (`subscription.periodStart` /
  `periodEnd`, which the Stripe plugin keeps) and the calendar month in UTC otherwise. One
  function, `periodFor(userId)`, returns `{ start, end, source }`; `quota.ts` uses it for the
  count and the "resets at" part of the sentence.
- Checked where the daily limit is checked: an early advisory check at project creation, the
  real check once ffprobe knows the length (fails the project with the sentence). `limitUsage`
  reports minutes this period; the Users → Usage tab shows it.
- Refusal: "Monthly limit of 300 minutes reached (312 used); resets on 1 November." With an
  entitlements provider: "… Pro gives 1,200 minutes a month: app.reelsaw.com/settings/billing."

## Part B: the `ee/` module

Built 2026-10-19 (see the plan). `apps/server/src/ee/index.ts` exports `createEE(svc)`;
`services.ts` imports it dynamically only when `config.REELSAW_EE` is true, after the database and
queue are up, and keeps the result as `svc.ee` (typed optional) with `svc.entitlements`. The
description below was the design; where it names the Better Auth plugin, decision 2 applies
(direct SDK, `billing_customers` / `billing_subscriptions` / `billing_events` tables,
`POST /api/billing/webhook`). It registers:

- **Auth plugin.** `stripe({ stripeClient, stripeWebhookSecret, createCustomerOnSignUp: true,
  subscription: { enabled: true, plans } })` is appended to the Better Auth plugin list by
  `createAuth` when `ee` passes it one. Webhook route: `POST /api/auth/stripe/webhook`
  (events `checkout.session.completed`, `customer.subscription.created/updated/deleted`). The
  plugin's `onSubscriptionComplete/Update/Cancel/Deleted` hooks write `admin_events`
  (`billing.subscribed`, `billing.changed`, `billing.canceled`, `billing.payment_failed`) with the
  plan and Stripe ids in the payload, and an `info` line on `module: "billing"`.
- **Schema.** The plugin's `subscription` table (`referenceId`, `stripeCustomerId`,
  `stripeSubscriptionId`, `status`, `plan`, `periodStart`, `periodEnd`, `cancelAtPeriodEnd`,
  `trialStart`, `trialEnd`, `seats`) and `user.stripeCustomerId`. Both are in `db/schema.ts` and the
  migration like every other table: an empty table on a self-hosted box costs nothing and keeps
  one schema for one image. (Cal.com and PostHog do the same; a conditional schema would mean two
  migration histories.)
- **Entitlements.** `svc.ee.entitlements.limitsFor(userId)` → `{ plan, status, limits, periodStart,
  periodEnd, upgradeHint }` from the cached `subscription` row and `plans.ts`, in one indexed
  query (`subscription (reference_id, status)`). `quota.ts` calls it between the instance
  settings and the per-user override.
- **Reconcile.** A daily job (`billing.reconcile`, the queue's cron) lists active and past-due
  subscriptions from Stripe in pages and updates rows that differ, logging each at `warn`. The
  same function behind `reelsaw billing sync [user]`.
- **tRPC `billing` router.** `get` (plan, status, period, limits, usage this period, Stripe
  portal availability), `checkout({ plan, interval })` → Checkout URL (the plugin's
  `upgradeSubscription`, with `subscriptionId` when one exists so a plan change updates rather
  than duplicates; `successUrl` `/settings/billing?checkout=success`, `cancelUrl`
  `/settings/billing`), `portal()` → Billing Portal URL. Admin: `admin.billing.list` (plan,
  status, period end, MRR), `admin.billing.setPlan` (comp a plan without Stripe: writes a
  `subscription` row with `stripeSubscriptionId` null and `status: "complimentary"`, audited).
- **MCP tools and CLI** on the same functions: `get_billing` (read), `billing_checkout_url`
  (returns the URL for a person to open; agents cannot pay), `reelsaw billing <user>`,
  `reelsaw billing sync`, `reelsaw billing set-plan <user> <plan>`.
- **Web.** `apps/web/src/ee/billing/` renders Settings → Billing: the plan card (name, price,
  renews or ends on, "Manage billing" to the portal), usage this period (minutes bar, storage
  bar, projects; the same numbers as the Users → Usage tab), the plan grid with the one button
  that applies (Upgrade, Downgrade at period end, Current). Loaded with `React.lazy` behind
  `me.get().ee.billing`; the open-source bundle keeps the chunk but never requests it. Quota
  refusals in the UI link to it.

### Plans (set 2026-10-19 to match OpenShorts Cloud, the other open-source clipper's hosted tier)

| plan | price | minutes / month | storage | projects | live jobs | priority | watermark |
|---|---|---|---|---|---|---|---|
| Free | $0 | 20, and the first video free up to 60 | 2 GB | 10 | 2 | normal | yes |
| Starter | $12 / mo, $120 / yr | 100 | 10 GB | 50 | 4 | normal | no |
| Creator | $29 / mo, $290 / yr | 300 | 30 GB | 200 | 6 | normal | no |
| Pro | $59 / mo, $590 / yr | 750 | 100 GB | unlimited | 12 | +5 | no |

Yearly is ten months for twelve. At $0.02–0.04 of model cost per minute, Starter carries up to $4
of models at full use, Creator $12, Pro $30; most accounts use a fraction. The first-video
allowance is a plan field (`firstVideoFreeMinutes`) applied in `quota.ts` `monthlyMinutes`; the
priority is a plan field (`queuePriority`) added to the fair-share priority of the account's jobs
in `uow.ts`. Retention per plan (OpenShorts keeps free clips 7 days) still needs
`CLIP_RETENTION_DAYS` to become per-user; until then retention is instance-wide.

## Part C: app.reelsaw.com

- `APP_URL=https://app.reelsaw.com` is the Better Auth base URL, the MCP OAuth resource
  (`https://app.reelsaw.com/api/mcp`), the Stripe success and cancel URLs and the webhook
  endpoint. reelsaw.com stays the Next.js site on Vercel; no cookie is shared between them (a
  link to the app is a link, not a session).
- Website: a `/pricing` page from the same plan list (`website/content/pricing.ts` mirrors
  `plans.ts`; a test in the server package compares the two), `SITE.app`, "Sign up" and "Open the
  app" buttons to `https://app.reelsaw.com`, `/terms` and `/privacy` pages (the app's
  `TERMS_URL` / `PRIVACY_URL` point at them). The copy that says there is "no hosted plan to
  upsell you to" (`website/content/reelsaw.ts`) becomes "self-host for free, or let us host it".
- Stripe: products Starter, Creator and Pro with monthly and yearly prices under lookup keys
  `starter_monthly`, `starter_yearly`, `creator_*`, `pro_*` (six prices; `pnpm stripe:setup`); tax code SaaS personal use
  (`txcd_10103000`); Managed Payments requested for the account; Customer Portal configured to
  allow plan switching among the four prices, cancellation at period end, invoice history.
- Environment, hosted only: `REELSAW_EE=true`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `STRIPE_MANAGED_PAYMENTS=true|false`, `BILLING_GRACE_DAYS=7`. Boot self-check: the key works
  (`prices.list` by the lookup keys finds every plan) or boot fails, like the models.
- Sign-up with a plan in mind: `/signup?plan=pro` keeps the plan in the URL through sign-up and
  verification and lands on the Checkout; abandoning it leaves a Free account.

## Later
- Overage: minute packs as one-time Checkouts credited to a `minute_credits` ledger that
  `periodFor` adds to the allowance; expiry at period end.
- Organisations (Better Auth `organization` plugin): a workspace owns the subscription
  (`referenceId` = organisation id, `seats`), members share its minutes.
- Paid self-hosted EE (SSO, audit log export, priority support): a licence key issued by
  app.reelsaw.com, checked daily with a 3-day grace, Formbricks-style. `REELSAW_EE` becomes
  `REELSAW_LICENSE_KEY` for those installs; billing stays hosted-only.
- Trials of Pro (7 days, card up front) with the plugin's one-trial-per-user guard, once Free
  conversion is measured.

## The Reelsaw Enterprise License (text for `ee/LICENSE`)

> The Reelsaw Enterprise License (the "Enterprise License")
> Copyright (c) 2026 osbytes
>
> With regard to the Reelsaw software in this directory and its subdirectories (the "Software"):
>
> This Software may only be used in production if you (and any entity you represent) have
> agreed to, and are in compliance with, a Reelsaw subscription or other agreement governing the
> use of the Software, as agreed between you and osbytes. Subject to that, you are free to modify
> this Software and publish patches to it; osbytes retains all right, title and interest in and to
> such modifications and patches, which may only be used, copied, modified, displayed, distributed
> or otherwise exploited under a valid agreement. Notwithstanding the foregoing, you may copy and
> modify the Software for development and testing purposes without an agreement. You are granted no
> other rights, and it is forbidden to copy, merge, publish, distribute, sublicense or sell the
> Software except as stated here.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
> BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
> NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
> DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
>
> Third-party components incorporated into the Software remain under their original licences.

Not legal advice; have it read once before the first paying customer. Everything outside `ee/`
stays AGPL-3.0, and the DCO sign-off in `CONTRIBUTING.md` is what lets `ee/` reuse contributed
code.

## Sources
- Better Auth Stripe plugin: https://better-auth.com/docs/plugins/stripe
- Polar Better Auth adapter: https://polar.sh/docs/integrate/sdk/adapters/better-auth; fees:
  https://polar.sh/docs/merchant-of-record/fees
- Stripe Managed Payments: https://docs.stripe.com/payments/managed-payments (how it works,
  eligibility, tax codes)
- PostHog `ee/LICENSE`: https://github.com/PostHog/posthog/blob/master/ee/LICENSE; Formbricks
  licence activation: https://formbricks.com/docs/self-hosting/advanced/license-activation
- Competitor prices: `website/content/competitors.ts` (checked October 2026)
