# n8n: new YouTube upload → vertical shorts

[`reelsaw-youtube-to-shorts.json`](reelsaw-youtube-to-shorts.json) is an [n8n](https://n8n.io)
workflow that clips every new upload on a YouTube channel. It watches the channel's RSS feed,
creates a Reelsaw project for each new video, waits for the render, and outputs the clips plus a
zip link with YouTube/TikTok metadata. A disabled Discord node at the end posts a summary; swap it
for Slack, Telegram, email or an upload step.

It works with a self-hosted instance or the hosted plan (app.reelsaw.com, including Free), and only
uses plain HTTP Request and Code nodes, so it runs on n8n Cloud and self-hosted n8n alike. No
community nodes are needed.

```
RSS trigger ─┐
             ├─ Settings ─ create_project ─ wait_for_project ⟲ ─ get_project ─ export_project ─ Summary ─ Discord
Manual test ─┘                                   (until done)        └─ failed → Stop and Error
```

## Setup

1. **API key.** In Reelsaw, **Settings → API keys and MCP**, create a key (it is shown once). It
   does not need instance administration.
2. **Import.** In n8n, **Workflows → Import from file** (or paste the JSON onto the canvas).
3. **Credential.** Create a **Header Auth** credential with name `Authorization` and value
   `Bearer rs_…`, and select it in the four Reelsaw nodes (Create project, Wait for project, Get
   clips, Export zip).
4. **Settings node.** `reelsawUrl` is your instance's public URL (default
   `https://app.reelsaw.com`). `maxClips` caps the picks (1-50). `focus` is optional ("Find clips
   about …"); leave it empty to let Reelsaw pick the best moments.
5. **Trigger.** Put your channel id in the RSS trigger's feed URL
   (`https://www.youtube.com/feeds/videos.xml?channel_id=UC…`; the id is in the channel's page source
   or its `/channel/UC…` URL). To try it first, set a video URL in the Settings node's `videoUrl`
   fallback and run **Test with one video**.

## How it talks to Reelsaw

Each Reelsaw node is an HTTP Request to `/api/mcp` with an MCP `tools/call` body:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "create_project", "arguments": { "sourceUrl": "https://www.youtube.com/watch?v=…", "settings": { "maxClips": 5 } } } }
```

The endpoint is stateless and answers with plain JSON (no session handshake), so no MCP client
node is needed. A tool's answer is JSON in `result.content[0].text`; the Code nodes after each call
parse it and turn `isError` answers (quota reached, bad URL, project not found) into a failed
execution with Reelsaw's message.

`wait_for_project` blocks for up to 110 s per call, and the workflow loops on it until the project
is `done` or `failed` (about 3 hours at most, which covers multi-hour sources on a busy instance).
Any other tool from the [MCP list](../../README.md#mcp-drive-reelsaw-from-an-agent) can be added
the same way, for example `update_project_style` before rendering or `get_clip_captions` for SRT
files.

## Output

The **Summary** node emits one item per video:

```json
{
  "title": "Episode 42",
  "projectUrl": "https://app.reelsaw.com/p/…",
  "exportUrl": "https://app.reelsaw.com/api/projects/…/export.zip",
  "clips": [{ "title": "…", "hook": "…", "score": 81, "durationSec": 32.5, "layout": "face", "videoUrl": "…" }],
  "message": "Reelsaw cut 5 clips from \"Episode 42\"\n1. …\nReview: https://app.reelsaw.com/p/…"
}
```

`videoUrl` and `exportUrl` need the same `Authorization` header to download: use an HTTP Request
node with the same credential and **Response format: File** to fetch the MP4s or the zip and hand
them to an upload node. The zip carries a `.youtube.json` (YouTube Data API `videos.insert` body,
private by default) and a `.tiktok.json` per clip.

## Notes

- The RSS trigger fires once per new feed entry. Shorts and live streams on the channel appear in
  the feed too; add an IF node on `title` or `link` if you only want long uploads.
- Every new video costs source minutes on a hosted plan; quota errors fail the execution with the
  reason.
- The workflow was checked on n8n 1.118 against a mock of the MCP endpoint (create → three waits →
  get → export).
