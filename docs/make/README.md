# Make: new YouTube upload → vertical shorts → posted

Two [Make](https://www.make.com) scenarios that clip every new upload on a YouTube channel and post
the clips, built from Make's own modules (no custom app to install):

- **Start** watches the channel's RSS feed and creates a Reelsaw project for each new video, tagged
  with `metadata`. Then it ends.
- **Publish** starts at a **Custom webhook** that Reelsaw calls with `project.done` when the clips are
  rendered. It keeps only projects the start scenario created and queues each clip in
  [Buffer](https://buffer.com) with its caption and hashtags.

They work with a self-hosted instance or the hosted plan (app.reelsaw.com, including Free). Make runs
in the cloud, so a self-hosted Reelsaw must be reachable from the internet for the start scenario;
the publish scenario only needs Reelsaw to reach Make, which it always can.

```
Start    RSS: Watch RSS feed items ─ MCP Client: Call a tool (create_project, metadata.workflow = "make-shorts")

        … Reelsaw picks, reframes, captions and renders …

Publish  Webhooks: Custom webhook ─ Webhook response (200) ─ Iterator (data.clips) ─ JSON: Create JSON ─ HTTP: Make a request (Buffer)
                                 filter: type = project.done and metadata.workflow = make-shorts
```

It is the same pipeline as the [n8n workflows](../n8n/README.md); read that page for why Buffer, and
for Metricool and YouTube alternatives.

## Setup

1. **Reelsaw API key.** In Reelsaw, **Settings → API keys and MCP**, create a key (shown once).

### Start scenario

2. **Trigger.** Add **RSS → Watch RSS feed items** with the URL
   `https://www.youtube.com/feeds/videos.xml?channel_id=UC…` (the id is in the channel's `/channel/UC…`
   URL or page source). Choose where to start ("From now on") so the channel's back catalogue is not
   clipped, and a schedule (every 15-60 minutes is plenty).
3. **Create the project.** Add **MCP Client → Call a tool**. Create a connection: **+ New MCP Server**,
   URL `https://app.reelsaw.com/api/mcp` (or `https://<your host>/api/mcp`), and the `rs_…` key in
   **API Key / Access token**. Reelsaw accepts it as a Bearer token or an `x-api-key` header. Make loads
   Reelsaw's tools; pick **create_project** and fill its arguments:

   | argument | value |
   |---|---|
   | `sourceUrl` | the RSS item's **URL** (`https://www.youtube.com/watch?v=…`) |
   | `settings` | `{ "maxClips": 5 }`, plus `"focus": "Find clips about …"` if you want one |
   | `metadata` | `{ "source": "youtube", "workflow": "make-shorts" }` |

   `metadata` is a flat map of strings (at most 20 keys, 1 KB) that Reelsaw sends back in every
   webhook for this project; the publish scenario filters on `workflow`.
4. Run the scenario once with one video, check that the project appears in Reelsaw, then turn
   scheduling on.

The MCP Client app has no trigger of its own and is in open beta at Make. If you would rather not
use it, an **HTTP → Make a request** module does the same call, because `/api/mcp` is stateless and
answers plain JSON: `POST https://app.reelsaw.com/api/mcp`, headers `Authorization: Bearer rs_…`
and `Accept: application/json, text/event-stream`, body type **Raw**, content type JSON:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "create_project", "arguments": { "sourceUrl": "{{1.url}}", "settings": { "maxClips": 5 }, "metadata": { "source": "youtube", "workflow": "make-shorts" } } } }
```

A tool error (quota reached, a URL Reelsaw cannot fetch) still answers HTTP 200, with
`result.isError: true` and the reason in `result.content[0].text`. Parse the response and add a
filter on `isError` if you want the scenario to stop on it.

### Publish scenario

5. **Trigger.** Add **Webhooks → Custom webhook**, add a webhook and copy its address
   (`https://hook.<zone>.make.com/…`).
6. **Subscribe it in Reelsaw.** **Settings → Webhooks → Add webhook**, paste the address and keep
   `project.done`. Or call `create_webhook` from an MCP Client module once:
   `{ "url": "https://hook.…make.com/…", "events": ["project.done"], "description": "Make: publish shorts" }`.
7. **Teach Make the payload.** With the webhook module listening (**Redetermine data structure**),
   finish one project, or press **Resend** on a past `project.done` in the webhook's delivery log.
   **Send test** sends a `webhook.test` event, which has no clips, so it is no use for this step.
8. **Answer Reelsaw at once.** Add **Webhooks → Webhook response** right after the trigger, status
   `200`. Reelsaw waits 10 seconds for an answer; without this module Make answers `Accepted` when
   the delivery is queued, which also counts, but an explicit response keeps that true if you later
   add slow steps before it.
9. **Filter** on the link after the trigger: `type` equal to `project.done` and `metadata: workflow`
   equal to `make-shorts`. One webhook gets every project on the account, including ones made in the
   app, so this keeps a project you start by hand from being posted.
10. **Iterator** over `data: clips`. Add a filter after it: `status` equal to `done`, `shareUrl` exists,
    and `score` greater than or equal to your minimum (0-100). To post only the best few, set the
    iterator's array to `slice(sort(data.clips; desc; score); 0; 5)`.
11. **Build the Buffer post** with **JSON → Create JSON** (it escapes quotes in captions, which typing
    the JSON by hand does not). Data structure: `query` (text) and `variables` (collection), and map:
    - `query`:
      ```graphql
      mutation CreatePost($input: CreatePostInput!) {
        createPost(input: $input) {
          ... on PostActionSuccess { post { id dueAt } }
          ... on MutationError { message }
        }
      }
      ```
    - `variables.input`: `channelId` (your Buffer channel id), `text` =
      `{{caption}}` + two new lines + `{{if(length(hashtags) > 0; "#" + join(hashtags; " #"); "")}}`
      (Reelsaw's hashtags have no `#`), `schedulingType` `automatic`, `mode` `addToQueue` (or
      `shareNow`), `saveToDraft` `false`, `assets` = `[{ "video": { "url": "{{shareUrl}}" } }]`.
      For a YouTube channel in Buffer also add `metadata.youtube` with `title` (`{{title}}`, at most
      100 characters) and `categoryId` (`22`, People & Blogs).
12. **Send it.** **HTTP → Make a request**: `POST https://api.buffer.com`, header
    `Authorization: Bearer <Buffer API key>` (create one at
    [publish.buffer.com/settings/api](https://publish.buffer.com/settings/api)), body type **Raw**,
    content type JSON, request content = the Create JSON output. Buffer answers 200 even when it
    refuses a post; the reason is in `data.createPost.message`. For several channels, add a router
    with one Create JSON / HTTP pair per channel.
13. Turn the scenario on, then finish a project from the start scenario.

`shareUrl` is a [share link](../specs/media-links.md): a plain GET downloads the MP4 with no
credential, for 90 days by default. Buffer fetches the video when the post publishes, so a link
revoked before then breaks the queued post.

### Instead of Buffer

- **Instagram for Business → Create a Reel Post** takes a video URL: map `shareUrl`.
- **HTTP → Get a file** on `shareUrl`, then **YouTube → Upload a Video** (or any module with a file
  field) for a direct upload; a vertical video under 3 minutes is a Short.

## Webhook signatures

Deliveries carry `webhook-id`, `webhook-timestamp` and `webhook-signature` (Standard Webhooks; see
[the spec](../specs/webhooks.md)). The scenarios above do not verify them, like the
[Zapier app](../../integrations/zapier/README.md): the `hook.make.com` address is a long random
secret, so treat it like a password and rotate it (a new webhook in Make, then update the URL in
Reelsaw) if it leaks. `webhook-id` is stable across retries; a **Data store** keyed on it, checked
before posting, keeps a retried or resent delivery from posting twice.

## Troubleshooting

- **Reelsaw's delivery log says "Answered 400" or "Queue is full".** The data structure Make
  learned does not match the delivery, or the scenario is off and its queue filled up. Redetermine
  the data structure (step 7), turn the scenario on, then **Resend**.
- **200 in the log but nothing posted.** Check the scenario's history: `metadata.workflow` must be
  `make-shorts` (projects made in the app have none), the clips must be rendered, and Buffer's
  answer may hold a `message` saying why it refused the post.
- **The MCP Client cannot connect.** Use the address ending in `/api/mcp`, and check the key in a
  terminal:
  `curl -s https://app.reelsaw.com/api/mcp -H "Authorization: Bearer rs_…" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`.
  A 401 is the key; a timeout on a self-hosted instance means Make cannot reach it.
