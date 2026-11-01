# n8n: new YouTube upload → vertical shorts → posted

Two [n8n](https://n8n.io) workflows that clip every new upload on a YouTube channel and post the clips,
with nothing waiting in between:

- [`reelsaw-shorts-start.json`](reelsaw-shorts-start.json) (**1/2, start**) watches the channel's RSS
  feed and creates a Reelsaw project for each new video, tagged with `metadata`. Then it ends.
- [`reelsaw-shorts-publish.json`](reelsaw-shorts-publish.json) (**2/2, publish**) starts at an n8n
  **Webhook** that Reelsaw calls with `project.done` when the clips are rendered. It checks the
  signature, keeps only projects workflow 1 started, and queues each clip in
  [Buffer](https://buffer.com) with its caption and hashtags. Disabled alternatives upload to YouTube
  Shorts or POST each clip to your own endpoint.

[`reelsaw-youtube-to-shorts.json`](reelsaw-youtube-to-shorts.json) is the older single workflow that
polls `wait_for_project` instead. Use it when Reelsaw cannot reach your n8n: an n8n on a laptop or
behind NAT has no public URL for the webhook (see [Polling fallback](#polling-fallback)).

They work with a self-hosted instance or the hosted plan (app.reelsaw.com, including Free), on n8n
Cloud or self-hosted n8n, with stock nodes only (Webhook, HTTP Request, Code, YouTube).

```
1/2  RSS trigger ─┐
                  ├─ Settings ─ create_project (metadata.workflow = "n8n-shorts")
     Manual test ─┘

        … Reelsaw picks, reframes, captions and renders …

2/2  Webhook ─ Verify signature ─┬─ valid ─ Accept (200) ─ Settings ─ Pick clips ─┬─ Build Buffer post ─ Post to Buffer ─ Check answer
                                 └─ invalid ─ Reject (401)                        ├─ Download clip ─ Upload to YouTube Shorts  (disabled)
                                                                                  └─ POST each clip to your endpoint          (disabled)
```

## Setup

1. **Reelsaw API key.** In Reelsaw, **Settings → API keys and MCP**, create a key (shown once). In
   n8n, add a **Header Auth** credential: name `Authorization`, value `Bearer rs_…`.
2. **Import both files** (**Workflows → Import from file**).
3. **Start workflow (1/2).** Pick the Reelsaw credential in **Create project**. In **Settings**, set
   `reelsawUrl` (default `https://app.reelsaw.com`), `maxClips` (1-50) and an optional `focus`
   ("Find clips about …"). Put your channel id in the RSS trigger
   (`https://www.youtube.com/feeds/videos.xml?channel_id=UC…`; the id is in the channel's
   `/channel/UC…` URL or page source).
4. **Subscribe the publish workflow (2/2).** Open its **Reelsaw webhook** node and copy the
   **Production URL** (`https://<your n8n>/webhook/reelsaw-clips`). Then either:
   - in Reelsaw, **Settings → Webhooks → Add webhook**, paste the URL and keep `project.done`; or
   - from n8n: paste the URL into **Subscribe settings** (`webhookUrl`, and `reelsawUrl`), pick the
     Reelsaw credential in **Create webhook**, and run **Add this webhook to Reelsaw (run once)**. It
     calls the `create_webhook` MCP tool.

   Either way Reelsaw shows a signing secret (`whsec_…`) **once**.
5. **Put the secret in Verify signature.** Paste it into `SECRETS` at the top of the **Verify
   signature** Code node. On self-hosted n8n you can set the environment variable
   `REELSAW_WEBHOOK_SECRET` instead (comma-separated during a rotation); the node reads it when
   `$env` is allowed. Self-hosted n8n also needs `NODE_FUNCTION_ALLOW_BUILTIN=crypto` so the Code
   node can load `crypto` (n8n Cloud allows it already).
6. **Buffer.** Create an API key at [publish.buffer.com/settings/api](https://publish.buffer.com/settings/api)
   and add a second **Header Auth** credential (`Authorization` / `Bearer …`) on **Post to Buffer**.
   In the publish **Settings** node, put your Buffer channel ids in `bufferChannelIds`
   (comma-separated; Instagram, TikTok, LinkedIn, …) and YouTube channels in
   `bufferYoutubeChannelIds` (those posts also get a title and `youtubeCategoryId`, which Buffer
   requires for YouTube). Channel ids come from Buffer's
   [channels query](https://developers.buffer.com/examples/get-channels.html).
7. **Activate** the publish workflow (webhooks only reach active workflows at the production URL),
   then press **Send test** on the webhook in Reelsaw. The delivery log should show **200**. A 401
   means the secret is wrong (the answer says why); see [Troubleshooting](#troubleshooting).
8. Run **Test with one video** in the start workflow (set a URL in its `videoUrl` fallback), then
   activate it too.

### Publish settings

| setting | default | |
|---|---|---|
| `workflowTag` | `n8n-shorts` | only projects whose `metadata.workflow` equals this are posted; empty posts every project |
| `publishOn` | `project.done` | or `clip.done` to post each clip as it renders (subscribe the webhook to `clip.done` then) |
| `minScore` | `0` | skip clips Reelsaw scored lower (0-100) |
| `maxClipsPerVideo` | `5` | the best-scored clips of each video |
| `addHashtags` | `true` | append `#tag`s to the caption |
| `bufferChannelIds` / `bufferYoutubeChannelIds` | | where to post |
| `bufferMode` | `addToQueue` | Buffer's next free queue slot; `shareNow` posts at once |
| `bufferSaveToDraft` | `false` | `true` puts each clip in Buffer as a draft to review first |
| `youtubeCategoryId` | `22` | People & Blogs |

## Routing by metadata

`create_project` takes `metadata`, a flat map of strings (at most 20 keys, 1 KB) that Reelsaw
never interprets and sends back in every webhook for that project. The start workflow sets:

```json
{ "source": "youtube", "videoId": "dQw4w9WgXcQ", "workflow": "n8n-shorts" }
```

One webhook endpoint gets every project on the account, including ones made in the app or by
other automations. **Pick clips** posts only projects whose `metadata.workflow` matches its
`workflowTag`, so a project you start by hand is not auto-posted. To run two pipelines (say, a
podcast channel to Buffer and a gaming channel to YouTube), import the pair twice with different
tags; one webhook can feed both, or give each its own. Add your own keys (a playlist, a campaign)
and branch on them with an IF node after **Pick clips**.

## What gets posted

**Pick clips** emits one item per clip: the rendered clips of the video, the best
`maxClipsPerVideo` by score, minus clips this workflow already handed on. It remembers clip ids in
the workflow's static data (kept between production executions, not manual test runs), so a re-run
of the project, or **Resend** in Reelsaw's delivery log, does not post a clip twice. A clip that
Buffer refused on every channel is forgotten again, so a Resend retries it.

```json
{
  "projectId": "…", "projectTitle": "Episode 42", "projectUrl": "https://app.reelsaw.com/p/…",
  "metadata": { "source": "youtube", "videoId": "…", "workflow": "n8n-shorts" },
  "clipId": "…", "title": "…", "caption": "…", "hashtags": ["#podcast", "#shorts"],
  "text": "caption\n\n#podcast #shorts",
  "shareUrl": "https://app.reelsaw.com/m/…/….mp4", "thumbnailShareUrl": "…", "durationSec": 31.5, "score": 84
}
```

`shareUrl` is a [share link](../specs/media-links.md): it downloads the MP4 with a plain GET, no
credential, for 90 days by default.

### Why Buffer

A scheduler has to fetch the video from a URL, because n8n cannot hand it a Reelsaw credential.
Checked on 2026-10-31:

- **Buffer** (default): one GraphQL call, `createPost` with `assets: [{ video: { url } }]`, and a
  personal API key, no app review
  ([create a video post](https://developers.buffer.com/examples/create-video-post.html),
  [authentication](https://developers.buffer.com/guides/authentication.html)). Buffer has no upload
  endpoint and fetches the file **when the post publishes**, so the URL must stay valid until then
  ([hosting media](https://developers.buffer.com/guides/hosting-media.html)); share links last 90
  days. The API is on every Buffer plan, Free included, with plan-based
  [rate limits](https://developers.buffer.com/guides/api-limits.html).
- **Metricool** also takes a URL, in two steps: `GET /api/actions/normalize/image/url?url=…` copies
  the file into Metricool and returns the media to reference in `POST /api/v2/scheduler/posts`
  ([Metricool API help](https://help.metricool.com/common-questions-and-errors-when-using-the-api-8x9nq)).
  That is two calls per clip, and a post whose media failed to normalize is scheduled without it. To
  use it, swap **Build Buffer post** / **Post to Buffer** for those two HTTP Request nodes with the
  `X-Mc-Auth` header.

### Other places to publish

Both are disabled; enable them next to or instead of Buffer (disable **Build Buffer post** to
switch Buffer off). They sit above the Buffer branch so they still run when Buffer refuses a post.

- **Download clip → Upload to YouTube Shorts.** The HTTP Request node downloads `shareUrl` as
  binary, and n8n's **YouTube** node uploads it (a YouTube OAuth2 credential, which needs a Google
  Cloud OAuth client with the YouTube Data API enabled). Uploads are `private` until you change
  `privacyStatus`; a vertical video under 3 minutes is a Short.
- **POST each clip to your endpoint.** The item above as JSON, for your own service.

## Polling fallback

Reelsaw has to reach the publish workflow's URL. n8n Cloud and a self-hosted n8n with a public
`WEBHOOK_URL` work. An n8n on a laptop or behind NAT does not: use
[`reelsaw-youtube-to-shorts.json`](reelsaw-youtube-to-shorts.json) instead. It creates the project,
loops `wait_for_project` (up to 110 s per call, about 3 hours at most) and outputs the clips, a zip
link and a summary for a Discord node. To post from it, call `get_media_links` for share links and
reuse the publish workflow's Buffer nodes. Setup: the same Header Auth credential on its four
Reelsaw nodes, `reelsawUrl` / `maxClips` / `focus` in **Settings**, and the channel id in the RSS
trigger.

If Reelsaw and n8n are on the same machine or LAN (self-hosted both), the webhook works when the
admin allows private URLs: `ALLOW_PRIVATE_WEBHOOK_URLS` (Settings → System → Limits), then
`http://n8n:5678/webhook/reelsaw-clips` or the LAN address.

## How it talks to Reelsaw

The Reelsaw nodes are HTTP Requests to `/api/mcp` with an MCP `tools/call` body:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "create_project", "arguments": { "sourceUrl": "https://www.youtube.com/watch?v=…", "settings": { "maxClips": 5 }, "metadata": { "workflow": "n8n-shorts" } } } }
```

The endpoint is stateless and answers plain JSON, so no MCP client node is needed. A tool's answer
is JSON in `result.content[0].text`; the Code nodes turn `isError` answers (quota reached, bad URL)
into a failed execution with Reelsaw's message. Any other tool from the
[MCP list](../../README.md#mcp-drive-reelsaw-from-an-agent) works the same way.

Webhook deliveries ([spec](../specs/webhooks.md)) carry `webhook-id`, `webhook-timestamp` and
`webhook-signature: v1,<base64>`: an HMAC-SHA256 of `id.timestamp.body` keyed with the base64 part
of the `whsec_` secret. **Verify signature** recomputes it over the raw body (the Webhook node's
**Raw Body** option), compares in constant time, accepts either signature while Reelsaw signs with
an old and a new secret after a rotation, and refuses deliveries more than 5 minutes old. It
answers Reelsaw right after the check (Reelsaw waits 10 s at most), then posts.

## Troubleshooting

- **Reelsaw's delivery log says "Answered 401".** The answer body names the cause: "Signature does
  not match" (the secret in **Verify signature** is not this webhook's; rotated secrets need the new
  one, or both), "No signing secret set", or "older than 5 minutes" (n8n's clock is off, or an n8n
  queue held the request). If the Code node fails with `Cannot find module 'crypto'`, set
  `NODE_FUNCTION_ALLOW_BUILTIN=crypto` on self-hosted n8n.
- **"Answered 404".** The publish workflow is not active, or the URL is the **Test URL**
  (`/webhook-test/…`, only live while the editor listens). Activate it and use the Production URL.
- **Timed out, or "That address points inside this server's network".** Reelsaw cannot reach n8n:
  check the URL from outside your network, set n8n's `WEBHOOK_URL` to its public address, or
  allow private URLs for a LAN setup (above). Otherwise use the polling fallback.
- **200 in the log but nothing posted.** Check the execution in n8n: the project's
  `metadata.workflow` must match `workflowTag` (projects made in the app have none), the clips must
  be rendered, and clips already posted are skipped. **Send test** is meant to post nothing.
- **Buffer refused a post.** The execution fails with Buffer's message per clip and channel, after
  the other posts went out. "Failed to fetch … Not Found" means Buffer could not download the
  share link.
- **A queued post fails later, or a share link gives 404.** The link was revoked (Settings → Share
  links, or `revoke_media_link`), it expired (`MEDIA_LINK_TTL_DAYS`, 90 days by default), or the
  clip or project was deleted. Every miss answers the same 404, on purpose. Buffer fetches when it
  publishes, so keep links alive past your queue; get fresh ones with `get_media_links`.
- **Everything else about deliveries** (retries, auto-disable, Resend):
  [TROUBLESHOOTING.md](../TROUBLESHOOTING.md#5-lessons-operations), "A webhook isn't arriving".

On Zapier instead of n8n, [integrations/zapier](../../integrations/zapier/README.md) wraps the same
tools and webhooks as a Zapier app.

## Notes

- The RSS trigger fires once per new feed entry. Shorts and live streams appear in the feed too; add
  an IF node on `title` or `link` before **Settings** to skip them.
- Every new video costs source minutes on a hosted plan; quota errors fail the start execution.
- Checked on n8n 1.118.2 (Docker) against a mock of `/api/mcp`, Buffer's endpoint and a share link:
  the start workflow's `create_project` call and metadata, the `create_webhook` branch, and signed
  `project.done` deliveries (valid, forged, tampered, stale, other workflow's project, Send test,
  `clip.done`, Resend, a Buffer refusal). The signature node was also checked against the
  `standardwebhooks` npm package, including rotation headers. Not checked against Buffer itself or
  a live YouTube upload.
