# Webhooks: tell other apps when clips are ready

Signed HTTP callbacks for project and clip events, one set of endpoints per account. They are the
missing trigger for n8n, Zapier, Make, Pipedream and scripts. Today those integrations find out a
project finished by calling `wait_for_project` in a loop.

## Problem

- The only way to learn that a project finished is to ask. The n8n workflow
  ([docs/n8n](../n8n/README.md)) loops `wait_for_project` (110 s per call) for up to about 3 hours.
  That works in n8n. It does not fit Zapier or Make, where a step has a short timeout and a
  trigger must be a webhook or a periodic poll.
- Polling costs every integration a long-running execution, and costs the server a held HTTP
  request plus a `LISTEN` per waiting caller.
- Re-renders, hand-made clips and retries finish later, outside any loop the caller is still
  running. Nobody is told.
- The server has no outbound HTTP to user-chosen URLs except source downloads (`lib/safe-url.ts`).
  Its only webhook is Stripe's, and that one is inbound (`/api/billing/webhook`).

## Prior art and what we take from it

- **Standard Webhooks** (standardwebhooks.com; Svix, Zapier, Twilio, Supabase and others use it):
  headers `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256 of
  "id.timestamp.body">`, secrets `whsec_<base64>`, and several signatures in one header during a
  rotation. → Use it as-is so receivers can verify with an off-the-shelf library instead of ours.
- **Stripe / Svix delivery**: an at-least-once outbox; retries with growing gaps over about a day;
  endpoints that keep failing get disabled and the owner is emailed; a delivery log with the
  response and a Resend button. → All of these.
- **GitHub**: a "ping" event when a hook is created, plus a "Redeliver" button on each delivery.
  → `webhook.test` and resend.
- **Zapier REST Hooks**: an instant trigger subscribes by calling the app's API with Zapier's
  hook URL, and unsubscribes when the Zap is turned off. → Create and delete are MCP tools, so a
  Zapier or Make app subscribes through `/api/mcp` and needs no extra route.
- **Fat vs thin payloads**: thin events (an id only) force a second authenticated call. That is
  awkward in no-code tools and impossible for a scheduler that only takes a URL. → Fat payloads,
  built by the same service code as `get_project` / `get_clip`, with the ids needed to re-fetch.

## Design

### Events (v1)

| type | when | `data` |
|---|---|---|
| `project.created` | `project.created` emitted | project summary (id, title, status, source, settings summary, `url`) |
| `project.done` | a run ends done | project summary plus `run` (`seq`, `reason`, `runSec`) and `clips[]`, the same fields as `get_project`'s clips (id, title, hook, score, durationSec, layout, status, `videoUrl`), plus `exportUrl` |
| `project.failed` | a run ends failed | project summary, `run`, `error` (the sentence the UI shows) |
| `clip.done` | a clip render committed | project id and title, the clip as `get_clip` returns it, `renderGen` |
| `clip.failed` | a clip render failed for good | project id, clip id and title, `error` |
| `webhook.test` | Send test / `test_webhook` | `{ message }` |

These come from events that already exist in `PROJECT_EVENT_TYPES` and are persisted.
`stage.progress` is not offered: it is ephemeral and is not stored. Each type in the list is added
deliberately: a new type means a new row here and in the README.

`clip.done` also fires for re-renders and hand-made clips. Receivers tell those apart by
`renderGen` and by whether a `project.done` is still to come (`project.status`).

### Envelope

```json
{
  "id": "evt_8812",
  "type": "project.done",
  "createdAt": "2026-10-31T15:02:11.204Z",
  "apiVersion": 1,
  "data": { "project": { "id": "…", "title": "Episode 42", "url": "https://app.reelsaw.com/p/…" }, "clips": [] },
  "metadata": { "zap": "episode-pipeline" }
}
```

- `id` is `evt_<project_events.id>`. It is stable across retries and is also the `webhook-id`
  header, so receivers dedupe on it.
- `apiVersion` is bumped only for a breaking change to the shape. Adding a field is not breaking.
- `metadata` is optional: what the project's creator passed to `create_project` (see Open
  questions).
- `videoUrl` and `exportUrl` need the account's API key, as they do today. Each clip also carries
  `shareUrl` and `thumbnailShareUrl`, and `project.done` carries `exportShareUrl`: signed links
  that work without a header ([media-links.md](media-links.md); 90 days by default, revocable one
  at a time). They are the clip's shared `source: webhook` link, fetched or created when the body is
  built, so retries and other endpoints carry the same URL.
- Size is bounded: at most 50 clips (the `maxClips` ceiling), and text fields keep their existing
  caps. Under 64 KB in practice. Bodies are built and checked against a 256 KB cap.

### Tables

```
webhook_endpoints
  id              text pk                  ("whk_…")
  user_id         text not null → user.id on delete cascade
  url             text not null            (https; http only when ALLOW_PRIVATE_WEBHOOK_URLS)
  description     text                     (≤120 chars, the user's label)
  events          text[] not null          (subset of WEBHOOK_EVENT_TYPES; never empty)
  secret_enc      text not null            (SecretBox, purpose "webhooks")
  prev_secret_enc text                     (rotation: still signed with until prev_secret_until)
  prev_secret_until timestamptz
  enabled         boolean not null default true
  disabled_reason text                     (sentence shown in the UI: "Turned off after 3 days of failed deliveries")
  failing_since   timestamptz              (first failed delivery of the current streak, null when healthy)
  created_at, updated_at
index (user_id, id)

webhook_deliveries
  id              bigserial pk
  endpoint_id     text not null → webhook_endpoints.id on delete cascade
  user_id         text not null            (for ownership checks and per-user listing, no join)
  event_id        bigint                   (project_events.id; no FK: events are pruned and projects purged)
  project_id      text                     (no FK, for filtering the log)
  type            text not null
  status          text not null            (pending | sending | delivered | failed | cancelled)
  attempt         int not null default 0
  body            text                     (built at the first attempt, then reused byte for byte)
  last_status_code int
  last_error      text                     (plain sentence: "Timed out after 10 s", "Answered 500")
  last_response   text                     (first 2 KB of the response body, for the log)
  next_attempt_at timestamptz
  delivered_at    timestamptz
  created_at      timestamptz not null
index (endpoint_id, id), (user_id, id)
```

Retention: `WEBHOOK_DELIVERY_RETENTION_DAYS` (runtime setting, default 14), pruned by the daily
history pruner (`events-retention.ts`) by id, the same way as `project_events`. A delivery row is
about 2–10 KB. At 1,000 active users × 50 events/day × 14 days that is 700k rows and a few GB at
most, so the default stays short. A user can resend from the log while the row exists.

### Outbox: deliveries commit with the event

`u.emit` (in `uow.ts`) already inserts the event and calls NOTIFY inside the unit of work. For a
type in `WEBHOOK_EVENT_TYPES` it also runs:

```sql
insert into webhook_deliveries (endpoint_id, user_id, event_id, project_id, type, status, next_attempt_at, created_at)
select e.id, e.user_id, $eventId, $projectId, $type, 'pending', now(), now()
from webhook_endpoints e join projects p on p.user_id = e.user_id
where p.id = $projectId and e.enabled and $type = any(e.events)
returning id
```

It then calls `u.send("webhooks.deliver", { deliveryId }, { singletonKey: deliveryId })` for each
returned row. An account with no endpoints pays one indexed read and gets no job. Because this
is a statement inside the unit, a rollback leaves no delivery, and a commit always has its jobs
(PRINCIPLES: state, its event and its jobs commit together). `svc.tx` re-running a unit after a
deadlock re-runs these statements too.

`webhook.test` does not go through `project_events`. `testWebhook` inserts the delivery itself,
in its own unit, with `event_id` null and the id `evt_test_<deliveryId>`.

### Delivery job (`webhooks.deliver`)

A queue outside the pipeline, like billing's: no project admission and no `USER_RERUN_QUEUES`.

1. **Claim.** `update webhook_deliveries set status = 'sending', attempt = attempt + 1 where id = $1
   and status = 'pending' returning …`. No row back means another run owns it or it already
   finished: exit. A job that runs twice therefore sends once per attempt.
2. **Load the endpoint.** Disabled or gone: set `cancelled` and exit.
3. **Build the body on the first attempt.** Build the payload from the event row and the current
   project and clip state (`projects/service.ts` / the `get_project` builder) and store it in
   `body`. Later attempts resend exactly those bytes, so the content does not drift between retries.
   If the project or clip no longer exists at the first attempt, send what the event row carries
   (`data.project.deleted: true`) rather than dropping the event.
4. **Send.** `POST` with `content-type: application/json`, `user-agent: Reelsaw-Webhooks/<version>`
   and the three Standard Webhooks headers. The secret is signed with the current secret, plus the
   previous one while a rotation is open. The request goes through `resolvePublicHttpUrl` again on
   every attempt, connecting to the address it resolved (DNS rebinding), with no redirects (a 3xx
   is a failure: "Answered with a redirect to …"), a 10 s total timeout, and at most 2 KB of the
   response body read.
5. **Record.** On 2xx: `delivered`, `delivered_at`, and clear the endpoint's `failing_since`. On a
   timeout, network error or non-2xx: store the code, a sentence and the response excerpt, then
   schedule the next attempt (below) and set `failing_since` if it is null. A 410 Gone disables
   the endpoint at once ("The receiver said this URL is gone (410)").

Retry schedule after the first attempt: 30 s, 2 min, 10 min, 1 h, 3 h, 6 h, 12 h (8 attempts over
about 22 h). Each retry is a new `webhooks.deliver` job with `startAfter` (status back to `pending`).
pg-boss's own retry is set to 0 for this queue, so the schedule lives in one place and is
visible in the row. After the last attempt the row is `failed`.

Every state change that schedules a send writes the row and its job in one transaction: the
outbox (above), a retry, Resend, an attempt that threw inside Reelsaw (back on the same schedule,
`failed` after the last attempt), and the sweep. The sweep runs every 5 minutes for rows whose job
was lost (a process died mid-send): it resets them to `pending` and queues their job in one unit,
`for update skip locked` so two processes never take the same rows, and fails a lost
`webhook.test` rather than sending it later. Rotating a secret reads and writes the endpoint
under its row lock.

**Auto-disable.** When a delivery fails and `failing_since` is more than 3 days old (with at least 5
failed deliveries since then), the endpoint is disabled in the same unit. `disabled_reason` is set,
the owner gets an email (`email.ts` template "A webhook was turned off") and its pending deliveries
are cancelled. Turning it back on clears the streak. Deliveries that failed while it was off can be
resent from the log.

**Fairness.** Worker concurrency for the queue is `WEBHOOK_CONCURRENCY` (env, default 8). A
receiver that times out holds a slot for 10 s at most. An endpoint whose last delivery failed
waits out its backoff before it is tried again, so a dead receiver does not crowd out healthy
ones. If one account floods the queue, a per-endpoint limit of in-flight deliveries (a conditional
claim on a counter column) is the next step. It is not built until a measurement shows it is needed.

**Ordering.** Not guaranteed, as with Stripe and Svix. `createdAt` and the monotonic event id let a
receiver order events, and `clip.done` carries `renderGen`.

### Security

- **SSRF.** URLs go through `lib/safe-url.ts`: on save (`assertPublicHttpUrl`, a sentence the user
  can act on) and again on every attempt. `ALLOW_PRIVATE_WEBHOOK_URLS` (a runtime instance
  setting, default off) lets a self-hosted box call `http://n8n:5678/webhook/…` on its own
  network. It is separate from `ALLOW_PRIVATE_SOURCE_URLS` because it is a different direction of
  trust. With it off, `https` is required.
- **Secrets.** Generated server-side (`whsec_` plus 32 random bytes) and stored with
  `createSecretBox(…, "webhooks")`. The secret is shown in full once, at creation and at rotation,
  and after that only its first characters. Rotation keeps the previous secret signing for 24 h;
  a second rotation is refused until that window closes, so the promised overlap always holds.
- **Logs.** Hook URLs carry secrets in their path (Zapier's catch hooks are
  `hooks.zapier.com/hooks/catch/<account>/<secret>/`), so logs and the UI show the origin and a
  masked path (`hooks.zapier.com/…/3f2a`). `webhook-signature` and the secret are added to the
  redaction list in `log.ts`. The issue-report export drops `webhook_endpoints.url` and
  `secret_enc`.
- **Ownership.** Every read and write is scoped by `user_id` inside the unit that uses it. An admin
  sees an account's endpoints through the CLI, not the app.
- **Replay.** The signed timestamp lets receivers reject old deliveries (the reference libraries
  default to a 5 min tolerance). Resend signs again with a fresh timestamp and keeps the same
  `webhook-id`.

### Limits and precedence

`MAX_WEBHOOKS_PER_USER` (runtime instance setting, default 10, 0 = unlimited), then what the plan
grants on hosted (`svc.entitlements`), then a per-user override an admin sets. That is the same
chain as the other limits (README, "Settings and precedence"). Webhooks are on every hosted plan,
Free included; that is the point of the feature and how it compares to plan-gated Zapier support
elsewhere. Counted inside the create transaction under `txLock.webhooks(userId)`.

### Surfaces

One service, `apps/server/src/webhooks/service.ts`: `listEndpoints`, `createEndpoint`,
`updateEndpoint` (url, description, events, enabled), `deleteEndpoint`, `rotateSecret`,
`testEndpoint`, `listDeliveries` (keyset by id, filter by endpoint, status, project), `resendDelivery`.
tRPC, MCP and the CLI call it. None of them repeats its checks.

**UI.** Settings → **API keys and MCP** gets a **Webhooks** section below the keys:

- A table (shared column grid): endpoint (description over the masked URL), events (chips,
  collapsing to "5 events"), status (glyph + word: Active, Failing since Tue, Off: reason), last
  delivery (time and code), and actions (Send test, Edit, ⋯ with Rotate secret, Turn off/on,
  Delete). At 390 px the events and last-delivery columns fold into the endpoint cell's second line.
- **Add webhook** dialog: URL, description, event checkboxes (`project.done` preselected). Saving
  shows the secret once, with a copy button, in space the dialog reserves for it, plus a "Send test"
  button. The dialog follows UI.md: no Select inside it, the events are checkboxes.
- Clicking an endpoint opens its delivery log: "Showing 50 of 1,204", status, type, project, attempt
  count, code and time. A row expands to show the request body, the response excerpt and the next
  attempt time, with **Resend**. The URL hash holds the endpoint and delivery
  (`#webhook=whk_…&delivery=…`) so a delivery can be linked.
- Loading, empty ("No webhooks yet. Add one to tell n8n, Zapier or your own script when clips are
  ready.") and data are separate states. The list refreshes after mutations, and the delivery log
  refetches on focus. No new event stream is needed in v1.

**MCP** (`mcp-tools.ts`, the same semantics as the screen):

| tool | |
|---|---|
| `list_webhooks` | endpoints with masked URL, events, status, failing-since, last delivery |
| `create_webhook` | `{ url, events, description? }` → the endpoint and its `secret` (only this once). This is how a Zapier or Make app subscribes |
| `update_webhook` | change url, events, description, enabled; says what changed |
| `delete_webhook` | unsubscribe (Zapier's "turn Zap off") |
| `rotate_webhook_secret` | the new secret, and when the old one stops signing |
| `test_webhook` | sends `webhook.test` now and waits up to 15 s for the outcome (code, sentence) |
| `list_webhook_deliveries` | paginated log, filter by endpoint, status, project |
| `resend_webhook_delivery` | queue a delivery again (a new attempt series, same `webhook-id`) |

**CLI** (operator, on the box; mirrors the tools with an account selector):
`reelsaw webhooks <email> [--json]`, `reelsaw webhooks deliveries <endpointId> [--status failed]`,
`reelsaw webhooks resend <deliveryId>`, `reelsaw webhooks test <endpointId>`,
`reelsaw webhooks enable|disable <endpointId>`.

### Logging

Module `webhooks`. `info` "webhook delivered" with `endpointId`, `deliveryId`, `eventId`,
`projectId`, `userId`, `attempt` and the code. `warn` "webhook attempt failed" with the code or
error and the next attempt time, on every attempt including the last (a receiver that fails
belongs to the user, not the operator, so it is not an `error` and not a Sentry report). `warn`
"webhook disabled" with the reason. `debug` for the resolved address and the masked URL. Never the
secret, the signature or the body.

## Integrations this unlocks (same change or right after)

- **n8n**: a second workflow in `docs/n8n` that starts at an n8n **Webhook** trigger on
  `project.done`, with no wait loop. The RSS workflow keeps `create_project` and ends there. It
  ships with a Code node that verifies the signature.
- **Zapier / Make apps**: instant triggers ("New finished project", "New rendered clip") whose
  subscribe step calls `create_webhook` through `/api/mcp` and whose unsubscribe step calls
  `delete_webhook`. Actions: create project, export. The app listings are their own task. This
  spec only makes them possible.
- **Scripts**: the README gets a 15-line verify-and-handle example in Node (the `standardwebhooks`
  package) and one in Python.

## Docs that change with it

README (features, MCP table, CLI table, "Settings and precedence" for the two settings),
`docs/CONFIG.md` via `pnpm docs:gen`, `docs/n8n/README.md` (the webhook variant, with polling as
the fallback), `docs/TROUBLESHOOTING.md` ("A webhook isn't arriving": the delivery log,
`reelsaw webhooks deliveries`, SSRF refusals, the private-URL setting), website
`content/guides.ts` (the n8n page FAQ on Make/Zapier, "does it post for me"),
`content/competitors.ts` (Opus Clip Zapier and API rows), and the home page MCP chips if the new
tools are listed.

## Tests

- Signing matches the Standard Webhooks reference test vectors, including two signatures during a
  rotation.
- The outbox: a unit that emits `project.done` and then throws leaves no delivery row and no job.
  A committed one leaves exactly one delivery per matching endpoint. Endpoints for other events,
  disabled endpoints and other users' endpoints get none.
- Claim is exactly-once: two concurrent runs of one job send once.
- Retry schedule, 410 disabling, auto-disable after the streak (with the email), and re-enabling
  clearing it.
- SSRF: private, internal-name, IPv6-mapped and rebinding addresses are refused on save and on send
  unless the setting is on. Redirects are not followed.
- The body is built once and resent byte for byte. A project deleted before the first attempt
  still sends.
- Pruning by id leaves rows newer than the cutoff.
- The MCP tools and tRPC procedures share service tests (ownership, limits, masked URLs).
- The n8n webhook workflow is checked against a local n8n, as the current one was.

### Project `metadata`

`create_project` (and the create form's API, `projects.create`) takes an optional `metadata`: a
flat map of string keys to string values. There are at most 20 keys, each key matches
`^[A-Za-z0-9_.-]{1,40}$`, each value is at most 500 chars, and the serialised map is at most 1 KB
(zod at the edge). It is stored in `projects.metadata jsonb not null default '{}'`, returned by
`get_project` / `list_projects`, and echoed as `metadata` in every webhook for that project. A
Zap or workflow can then match "the project I started" to its result without keeping its own
table. `update_project` can replace it (no merge, so there is no read-modify-write). It is the
caller's data: never interpreted, never logged at `info` (only its keys at `debug`), and it is in
the issue-report export like the title.

## Decisions

1. **`metadata` on `create_project`: yes, in v1** (above).
2. **No one-off `notifyUrl` on `create_project`.** Endpoints plus `metadata` cover it, and a
   per-project URL would mean a second secret and a second SSRF path to keep right.
3. **No per-project filters on an endpoint in v1.** Receivers filter on `metadata` or `type`.
   Revisit if users ask for "only projects from this channel" often.
4. **Signed media links are needed alongside this:** [media-links.md](media-links.md). Without
   them, Metricool, Buffer and Instagram cannot fetch the clip a webhook announces. Media links
   ship first or in the same release. When they do, the payload's clips carry `shareUrl` and
   `project.done` carries `exportShareUrl`.
