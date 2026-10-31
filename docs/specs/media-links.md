# Media links: a clip URL another app can fetch

Share links to a rendered clip, its thumbnail, its captions or a project's export zip. They work
without an `Authorization` header, so a scheduler (Metricool, Buffer, Publer), a platform that pulls
media from a URL (Instagram's Graph API), a no-code step or a teammate can download the file. Each
link can be revoked on its own. Webhooks ([webhooks.md](webhooks.md)) announce a clip and carry its
link.

## Problem

- Every media URL needs the owner's session or API key: `/media/clips/:projectId/:file` and
  `/api/projects/:projectId/export.zip` start with `actor(c)` and return 401 without one
  (`http.ts`).
- Many consumers take only a URL. Instagram creates a Reels media container from a `video_url` that
  Meta's servers fetch. Buffer's API has no upload endpoint and takes asset URLs. Zapier and Make
  file fields are URLs. None of them can send our Bearer token, and putting an API key in a URL
  hands out the whole account.
- With S3 storage the media route already redirects to a presigned URL, but only after the owner is
  authenticated. The presigned URL lasts `S3_PRESIGN_EXPIRES` (1 h by default, 7 days at most under
  SigV4), and on local storage there is nothing to presign.

## What consumers need (researched 2026-10-31)

| consumer | when it fetches | what it requires |
|---|---|---|
| Instagram Graph API (Reels) | when the media container is created (then processes for minutes) | a URL on a public server reachable without auth; MP4/MOV, H.264 + AAC, moov atom first (our renders use `+faststart`). Meta documents nothing about redirects; fetch failures come back as generic errors (2207052 / 2207076) |
| Buffer API | **at publish time**, which for a queued post can be weeks later | public, no auth; Buffer's own troubleshooting names presigned S3 and signed CDN URLs as links that "work at setup and fail silently before publishing" |
| Metricool API | once: its normalize step copies the file to Metricool's storage and returns a `mediaId` | public and not expiring at the moment it is normalized |
| Zapier / Make / n8n file fields | when the step runs | public; a correct `Content-Type` and filename |
| TikTok `PULL_FROM_URL` | at post init | a URL on a **domain verified in the TikTok developer app**: fine for a self-hoster's own domain or Reelsaw's own TikTok app, not for a user's app pointing at app.reelsaw.com (they use `FILE_UPLOAD` instead) |

Two conclusions shape the design:

1. **Serve 200 with the file at the link URL itself, no redirect.** No consumer documents following
   redirects, and the one that discusses signed URLs says they break. The safe answer is the one
   every guide checks for: a plain GET returns 200, `video/mp4` and the bytes.
2. **Links must outlive a scheduler's queue and still be revocable one at a time.** A seven-day
   stateless token fails Buffer's publish-time fetch for posts queued further out. A long-lived
   token that can only be revoked all at once is the wrong trade. Both point to stored links.

## Prior art and what we take from it

- **W3C TAG, "Good Practices for Capability URLs"**: a capability URL needs enough entropy that it
  cannot be guessed; it should expire eventually; it should be revocable when it leaks; it should
  stay out of referrers and logs. → 256-bit random tokens, a default expiry, per-link revoke,
  `no-referrer`, tokens redacted from logs.
- **Dropbox / Google Drive / Frame.io share links**: a stored link record per shared item; the owner
  can list, re-copy and disable each link and set an optional expiry; the link names the item, not
  a byte version. → A `media_links` table, a Share links list in Settings, and the current render
  served.
- **Stripe / GitHub tokens at rest**: look a token up by its hash, never by the plaintext. → A
  `token_hash` column for lookup. The token itself is also kept sealed (the secret box), so the
  owner can copy the link again the way Drive and Dropbox allow. An API key, by contrast, is shown
  once.

## Design

### URL

```
https://<PUBLIC_URL>/m/<token>/<name>.<ext>
```

- `token` is 32 random bytes, base64url (43 chars).
- `<name>.<ext>` is cosmetic but required. Some fetchers decide the type from the extension, and a
  person downloading gets the same filename as `?download` (`03-the-hook-title.mp4`). The server
  ignores the name and checks the extension against the link's kind.

### Table

```
media_links
  id            text pk                 ("lnk_…", shown in the UI and tools; not the secret)
  user_id       text not null → user.id on delete cascade
  project_id    text not null → projects.id on delete cascade
  clip_id       text → clips.id on delete cascade   (null for kind export)
  kind          text not null           (clip | thumb | srt | vtt | export)
  clip_ids      text[]                  (export only: the subset, ≤50, as for ?clips=; null = every rendered clip)
  token_hash    bytea not null unique   (sha256 of the token)
  token_sealed  text not null           (createSecretBox(…, "media-links")), so the owner can copy it again
  source        text not null           (ui | mcp | cli | webhook)
  label         text                    (≤120 chars, optional: "Buffer queue")
  expires_at    timestamptz             (null = never, only where the instance allows it)
  revoked_at    timestamptz
  last_used_at  timestamptz
  use_count     int not null default 0
  created_at    timestamptz not null
index (user_id, id), (project_id), (clip_id, kind) where revoked_at is null
```

Size: about 300 bytes a row. Links are reused (below), so there are a few per clip, not one per
read. Retention: revoked and expired rows are deleted
`MEDIA_LINK_RETENTION_DAYS` (default 30) after they stopped working, by the daily history pruner.
Until then the list can still say "Revoked on …" when someone asks why a link stopped.

### Minting and reuse

`getOrCreateLink(owner, target, { ttlDays?, source, label? })`, in one unit of work:

- With no `label`, it returns the owner's active link for the same target (`clip_id` + `kind`, or
  the project and subset for `export`), from the same `source` family, if one exists with at least
  7 days left (or no expiry). Otherwise it inserts one. Copying a share link twice, an agent
  calling `get_media_links` in a loop, or webhooks for every re-render all reuse one link. That
  keeps the table small and the URL stable, which a scheduler queue needs.
- With a `label`, it always creates a new link. This is for "a separate link for Buffer that I can
  revoke without breaking the one I sent a teammate".
- Webhook links are `source: webhook` and are shared by every endpoint and delivery for that clip.
  Revoking one stops it for webhook bodies already sent; the next body gets a fresh link.

Ownership is checked in the same unit: the project must be the owner's and not deleted, and the
clip must belong to it.

### Expiry

`MEDIA_LINK_TTL_DAYS`: a runtime instance setting, default 90, 1–3650. A link may ask for less
(`ttlDays`: 1, 7, 30, 90 in the UI; any value up to the ceiling in tools). `MEDIA_LINK_ALLOW_NEVER`
(runtime, default `true` self-hosted and `false` hosted) lets the owner pick "Never expires". The
precedence is the usual chain: `.env`, the instance setting, the plan (hosted), then a per-user
override.

90 days covers a scheduler queue. The capability-URL guidance is still met: links expire, and the
owner can see and revoke them.

### Serving (`GET` and `HEAD /m/:token/:file`)

1. Hash the token and run one query: the link by `token_hash`, joined to its project, clip and
   owner. It requires the link to be not revoked and not expired, the project not deleted, the owner
   not banned, and the extension to match `kind`. A miss on any of these gets the same 404 "This link
   is invalid, expired or was turned off.", so a guess learns nothing. The lookup is a unique index
   on a hash, so its timing does not depend on how close the guess was.
2. Two states get their own sentence because the owner can fix them: a clip that is re-rendering
   right now → 409 "This clip is being re-rendered; try again in a few minutes", and files removed by
   retention → 410 "This clip's files were removed after N days; re-render it to bring the link back".
3. **The current render.** The link names the clip. A re-render the owner asked for is what it serves
   next, and render outputs are versioned by `render_gen`, so a fetch never sees a half-written file.
4. **200 with the bytes, no redirect.** Local storage: `sendFile` (Range, ETag, Content-Length). S3:
   the object is streamed through the server (`GetObject` with the incoming Range passed on), with
   `Content-Length`, `Accept-Ranges` and the ETag from the object. `export` streams `createExportZip`
   from the same `exportPlan` as the authenticated route. Headers: `Content-Type` by kind,
   `Content-Disposition` (`inline` for mp4/jpg, `attachment` for zip/srt/vtt), `Cache-Control:
   private, max-age=300`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`.
   `MEDIA_LINKS_REDIRECT` (env, default `false`) switches S3 serving to a 302 to a presigned URL that
   expires within an hour. It is for an operator who has checked that their consumers follow
   redirects and wants egress to leave from the bucket, not the app.
5. **Usage.** `last_used_at` and `use_count` are updated with one atomic statement, at most once a
   minute per link (`where last_used_at < now() - interval '1 minute'`, or an in-memory skip for
   Range requests within the same minute), so streaming a video in parts does not write a row per
   chunk.

The route sits outside `/api` and before the auth middleware. It takes no cookies and sets none.

### Revocation

- **One link:** `revoked_at = now()` on that link. The next request gets the 404.
- **A project's or a clip's links:** a bulk revoke scoped by `project_id` or `clip_id`. Deleting the
  clip or project also stops them (the serve query requires both to exist and not be deleted), and
  restoring them within the undo window brings the links back.
- **Everything:** "Revoke all share links" revokes every active link of the account in one
  statement over the `(user_id, …)` index.
- Banning or removing an account stops its links through the owner check (removal cascades the rows).

### Abuse and cost

- Serving through the app costs egress on hosted. The cost is bounded by what the owner could
  already download, and it is measured: a `media_link.served` counter by kind, bytes on the request
  span, and `use_count` per link, so a hot-linked clip shows up in the Share links list and in
  `reelsaw media-links <email>`.
- A per-account daily cap on bytes served through links (`MAX_LINK_GB_PER_DAY`, counted in the
  database) is left out until the metric shows a need. When it is reached, links answer 429 with a
  sentence, never silently.
- Tokens cannot be enumerated: 256 bits, unique-hash lookup, the same 404 for every miss. The request
  log line for a 404 under `/m/` is `debug`, because scanners send noise.

### Logging and redaction

- `redactPath` (`request-log.ts`) learns `/m/<token>/…` → `/m/[token]/…`, the same treatment as reset
  links, and `report/redact.ts` drops them from issue reports. `token_sealed` and `token_hash` are
  never exported.
- Module `media-links`. `info` "media link created" and "media link revoked" (`linkId`, `userId`,
  `projectId`, `clipId`, kind, source). `info` "media link served" (`linkId`, kind, status; countable,
  one per request, not per Range chunk). `debug` for refusals with the reason.

### Surfaces

One module, `apps/server/src/media-links/service.ts`: `getOrCreateLink`, `listLinks` (keyset by id,
filter by project, clip, active), `revokeLink`, `revokeLinks({ projectId | clipId | all })`, `serveLink`.
tRPC, MCP, the CLI and the webhook body builder call it.

**UI.**
- A clip's ⋯ menu (editor and project list): **Copy share link**. A toast confirms: "Link copied. Anyone
  with it can download this clip until 29 Jan." The menu item has a fixed slot. **Share link options…**
  opens a dialog with expiry, label, "separate link" and the clip's existing links.
- The export dialog: **Copy link to zip** next to Download, for the same subset.
- Settings → **API keys and MCP** → **Share links**: a paginated table ("Showing 50 of 312") with the
  target (project / clip title, kind), label, source, expires, last used and uses (right-aligned,
  `tabular-nums`), and actions Copy and Revoke (⋯: Revoke all for this project). Above it: **Revoke all
  share links**, with a confirm. At 390 px, source and uses fold into the target cell's second line.
  Loading, empty ("No share links yet. Copy one from a clip's menu.") and data are distinct states.
- The project page's ⋯ menu: **Revoke this project's share links**.

**MCP.**

| tool | |
|---|---|
| `get_media_links` | `{ projectId, clipIds?, kinds?: ["clip","thumb","srt","vtt"], export?: boolean, ttlDays?, label? }` → for each clip, its link per kind with `linkId` and `expiresAt` (reusing active links as above); with `export`, the zip link for that subset. Clips not rendered are listed with the reason instead of a link |
| `list_media_links` | paginated, filter by project, clip, active; masked URLs (`/m/…3f2a/…`) plus `linkId` |
| `revoke_media_link` | `{ linkId }`, or `{ projectId }`, `{ clipId }` or `{ all: true }`; says how many links stopped working |

`get_project` and `get_clip` do not add links on their own: a read tool should not create public URLs
the caller did not ask for. Their descriptions point at `get_media_links`. Webhook payloads are the
exception, because the receiver is an endpoint the owner registered.

**CLI.** `reelsaw media-links <email> [--project <id>] [--active] [--json]`,
`reelsaw media-links create <projectId> [clipId…] [--kind clip|thumb|srt|vtt|export] [--ttl <days>] [--label …]`,
`reelsaw media-links revoke <linkId | --project <id> | --all <email>>`.

## Docs that change with it

README (features, MCP table, CLI table, the settings in "Settings and precedence"), `docs/CONFIG.md`
via `pnpm docs:gen`, `docs/n8n/README.md` (fetch by share link, no credential on the download step),
`docs/TROUBLESHOOTING.md` ("A share link stopped working": the Share links list, the 404/409/410
meanings, `reelsaw media-links`), and website `content/guides.ts` (the n8n FAQ on posting) once the
scheduler templates exist.

## Tests

- Mint and reuse: a second `get_media_links` returns the same link, and a label makes a new one. A
  link with less than 7 days left is not reused. Webhook links are shared across endpoints.
- Serve: local storage (Range, HEAD, ETag) and S3 streamed (Range passed through, Content-Length
  right). With `MEDIA_LINKS_REDIRECT` on, the presign expires within the hour.
- The same 404 for an unknown token, a wrong extension, an expired link, a revoked link, a deleted
  project or clip and a banned owner. Restoring a deleted project brings its links back.
- 409 during a re-render, then the new file after it commits. 410 after retention removed the files.
- `use_count` moves once per minute under a burst of Range requests.
- Revoking one link, a project's, a clip's or all of them stops exactly those.
- `redactPath` and the issue-report redactor remove tokens. The pruner deletes rows only after
  `MEDIA_LINK_RETENTION_DAYS`.
- A plain `curl` of a clip link (no headers, no redirect following) gets 200 and `video/mp4`. This is
  the check Instagram's and Buffer's guides tell users to run.

## Decisions

- **Direct 200, no redirect, by default** (research above). A redirect is an operator opt-in.
- **Stored, individually revocable links** with a 90-day default expiry and an optional "never" where
  the instance allows it. This replaces the earlier stateless-token draft: a seven-day token breaks
  Buffer's publish-time fetch, and revoke-all-only is the wrong trade for links that last months.
- **The link names the clip** and serves its current render.
- **Read tools do not create links unless asked;** webhook bodies do.

## Before calling it done

Post a test Reel through the Graph API and a queued Buffer post (scheduled a day or more out), both
from a hosted share link, and record the result here.

## Sources

- [Instagram Platform: Content Publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing/)
- [Instagram Graph API error codes](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/error-codes/)
- [Buffer API: Hosting media](https://developers.buffer.com/guides/hosting-media.md)
- [Troubleshooting Buffer's API](https://support.buffer.com/article/983-troubleshooting-buffers-api)
- [Metricool: API questions and errors](https://help.metricool.com/nl/common-questions-and-errors-when-using-the-api-8x9nq)
- [W3C TAG: Good Practices for Capability URLs](https://www.w3.org/2001/tag/doc/capability-urls/)
- [Postpeer: Instagram publishing errors](https://www.postpeer.dev/errors/instagram)
