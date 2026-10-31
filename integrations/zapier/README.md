# Reelsaw for Zapier

A [Zapier Platform CLI](https://docs.zapier.com/platform/build-cli/overview) app for Reelsaw. It works
with hosted Reelsaw (app.reelsaw.com) and self-hosted instances, and talks to Reelsaw only through
the MCP endpoint (`POST {address}/api/mcp`, JSON-RPC `tools/call`), the same tools agents and the
[n8n workflow](../../docs/n8n/README.md) use. It is not in the workspace (`pnpm-workspace.yaml`
covers `apps/*` and `packages/*`): it has its own `package.json` and npm lockfile, like `website/`.

## What it does

**Connection.** Two fields: the Reelsaw address (default `https://app.reelsaw.com`) and an API key
from **Settings → API keys and MCP**. The key goes out as `Authorization: Bearer rs_…`, and only to
that address. The connection test calls `list_projects` with `limit: 1`.

**Triggers.** These are instant (REST Hooks). Turning a Zap on calls `create_webhook` with Zapier's
hook URL and one event, and turning it off calls `delete_webhook`. A webhook that is already gone
counts as unsubscribed. The subscription shows in Reelsaw under **Settings → Webhooks** as "Zapier: …",
with its delivery log.

| Trigger | Event | Item |
|---|---|---|
| Project Finished | `project.done` | One item per project: `project`, `run`, `clips` (line items with `shareUrl` / `thumbnailShareUrl`), `exportShareUrl`, `clipCount`, `renderedClipCount`, `metadata` |
| Clip Rendered | `clip.done` | `project` and `clip`, including re-renders (`clip.renderGen`) and clips added by hand |
| Project Failed | `project.failed` | `project`, `run`, `stage`, `error` (the sentence the app shows) |

An item is the [webhook envelope](../../docs/specs/webhooks.md#envelope) with `data` moved up a level.
`id` is the event id (`evt_…`), and `metadata` is what **Create Project** (or `create_project`) was given.
**Project Finished** is one item per project, not one per clip. The clips arrive together as line items,
so a Zap can post a summary, loop over them (Looping by Zapier) or take the first one, and **Clip Rendered**
already covers "do this for every clip". Deliveries of other types (for example **Send test** in Reelsaw)
start nothing.

When a Zap is being set up, the samples come from the account's own recent projects (`list_projects` and
`get_project`). Samples leave `caption`, `hashtags` and the share links empty, because loading a sample
should not create public links to someone's videos. Real deliveries fill them in.

Signatures are not verified. The Zapier hook URL is itself a secret, and the `whsec_` secret that
`create_webhook` returns is not stored.

**Actions.**

- **Create Project** (`create_project`): video URL, plus an optional title, metadata (key/value pairs that
  come back on every trigger for the project), max clips and focus. Returns the project id, status
  (`queued`) and its URL.
- **Get Share Links** (`get_media_links`): project id and clip id, plus which files (video, thumbnail,
  SRT, WebVTT) and an optional lifetime. Returns links that download without signing in, for Instagram,
  Buffer, Metricool or a file field. A clip that is not rendered fails the step with Reelsaw's sentence.

**Search.** **Find Project** (`get_project`) finds a project by id. Not found gives an empty result, so
"continue if nothing is found" works.

Errors are Reelsaw's own sentences. A tool error (`result.isError`, "CODE: sentence") becomes a Zapier error
with that sentence. A 401 marks the connection expired, and a wrong address says to check it.

## Develop and test

```bash
cd integrations/zapier
npm ci
npm test                                   # jest + nock; no network, no Zapier account
zapier-platform validate --without-style   # schema check, local only
```

The tests mock `/api/mcp` and cover the connection (including errors), subscribe and unsubscribe for
each trigger, `perform` with sample bodies, the samples, both actions and the search. The CLI is
`npm i -g zapier-platform-cli`; older versions call the binary `zapier` instead of `zapier-platform`.
Biome does not cover this folder (`biome.json` lists the workspace folders), so it is formatted by hand
in the repo's style.

To try it against a running instance without uploading anything, put `authData_baseUrl=…` and
`authData_apiKey=rs_…` in a `.env` here (git-ignored) and run `zapier-platform invoke auth test`, or
`zapier-platform invoke search find_project --inputData '{"projectId":"…"}'`.

## Publish (maintainers)

Nothing here has been registered or pushed. To do it, a maintainer signed in to the Reelsaw Zapier
account runs:

```bash
cd integrations/zapier
npm ci && npm test && zapier-platform validate
zapier-platform login                    # once per machine
zapier-platform register "Reelsaw"       # once: creates the app and writes .zapierapprc (commit it)
zapier-platform push                     # uploads version 1.0.0 (from package.json) as a private version
```

Then test it in the Zap editor with a real account. Invite testers with `zapier-platform users:add` or
`zapier-platform users:links`. For later versions, bump `version` in `package.json`, `push`, then
`zapier-platform promote <version>` and `zapier-platform migrate <old> <new>`. A public listing goes
through Zapier's review (`zapier-platform validate` without `--without-style` runs their publishing checks).
