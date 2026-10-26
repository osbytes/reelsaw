# @reelsaw/server

## 0.25.0

### Minor Changes

- [#174](https://github.com/osbytes/reelsaw/pull/174) [`70d326d`](https://github.com/osbytes/reelsaw/commit/70d326d76b0013f74f98af38e21579cded12e50c) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Tabs left open across an upgrade keep working: the command palette and other lazily loaded parts no longer fail with a missing-file error, and a tab on an older version reloads itself on its next page change when nothing is unsaved. Library tags use a picker that suggests tags you already use and creates new ones. Deleting library items and templates is now called Delete everywhere, matching projects and clips, and the MCP tools are `delete_asset` and `delete_layer_template` (the CLI's `library delete` and `templates delete`); `refine_project` is a new MCP tool. Large uploads are no longer cut off after five minutes, migrations are safe when several workers start at once, container logs rotate, and leftover temporary files are cleaned up. Adding a library item from a URL now refuses every internal address form, pages can no longer be framed by other sites, and password-reset tokens stay out of the access log. Re-picking or retrying a project while it is still working no longer leaves two sets of clips or brings back a deleted project, and edits made to a new clip while it is being prepared are kept. Project actions that fail now say why, and leaving the clip or template editor with unsaved edits asks first, from any link, ⌘K or the browser's Back button.

## 0.24.0

### Minor Changes

- [#171](https://github.com/osbytes/reelsaw/pull/171) [`ee190fb`](https://github.com/osbytes/reelsaw/commit/ee190fbfb99cb946620dbce9d7fb9c2df2a2d998) Thanks [@dillonstreator](https://github.com/dillonstreator)! - A Deleted page lists deleted projects, clips, library assets and layer templates in one place, with bulk restore and delete forever. Deleting clips from a project offers Undo, Delete forever and a link to the page, and the same restore, delete forever and list actions are MCP tools and CLI commands. Deleted items keep counting toward storage until they are deleted forever, and minutes used stay counted after a delete forever.

## 0.23.3

### Patch Changes

- [#167](https://github.com/osbytes/reelsaw/pull/167) [`608c446`](https://github.com/osbytes/reelsaw/commit/608c4467498e351c3066f71bf5c89237495631c5) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Renders of many clips at once no longer fail inside ffmpeg on large machines (filter-graph thread races and face-frame sampling).

## 0.23.2

### Patch Changes

- [#165](https://github.com/osbytes/reelsaw/pull/165) [`7565d38`](https://github.com/osbytes/reelsaw/commit/7565d38817f95b37cdc8c7de3b2a1d9c7639bde6) Thanks [@dillonstreator](https://github.com/dillonstreator)! - `YTDLP_PROXY` URLs may include `{session}`, replaced with a fresh id on every yt-dlp download so a residential gateway can pin that process to one IP and give the next video a different one. Ingest also passes `--js-runtimes node` (YouTube JS challenges) the same way eval already did.

## 0.23.1

### Patch Changes

- [#163](https://github.com/osbytes/reelsaw/pull/163) [`8943cca`](https://github.com/osbytes/reelsaw/commit/8943cca9d7e19d2b349e10cc850655deaa8fd2e5) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The Docker image and production bundle now run Node 24 LTS (the same line CI already uses). The base image stays digest-pinned on the 24 line so Dependabot can pick up 24.x security releases.

## 0.23.0

### Minor Changes

- [#161](https://github.com/osbytes/reelsaw/pull/161) [`7fe603f`](https://github.com/osbytes/reelsaw/commit/7fe603f4666a70dcdbc1f64f869b3ca63aa86049) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Whisper decoder loops (one word or a prompt list cycling for minutes) are collapsed after transcription, and each collapse shows up as a transcript fix. The as-heard repeats stay in the transcript; rejecting the fix puts them back. Captions stay empty across that stretch unless you type replacement text on the flag. Re-transcribe to recover the missing speech.

- [#159](https://github.com/osbytes/reelsaw/pull/159) [`bdd11ae`](https://github.com/osbytes/reelsaw/commit/bdd11aee514abaf3d5b0ba3f9860a20fecfd4646) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Framing follows the source's cutting. Shot cuts are now detected for every project before clip selection (they used to exist only when a project opted into the scenes refine step, which is now just the on-screen text scan), clip boundaries snap to them, a render detects them on the clip when an older project or an imported report has none, and the layout may change at every cut: a multi-camera talk show that alternates a close-up with a wide shot every second or two gets a full-frame close-up, then the wide shot, then the close-up again, instead of one split held across a dozen shots with a pane framed on an empty seat. A wide shot of three or more people is shown whole rather than split between two of them. Name fixes and the on-screen text scan now run by default (instance gates `TRANSCRIPT_CORRECTION` and `REFINE_SCENES`, project settings `refineEntities` and `refineScenes`); filler removal stays opt-in. Importing an issue report whose project was re-rendered no longer fails on its timestamps.

## 0.22.0

### Minor Changes

- [#157](https://github.com/osbytes/reelsaw/pull/157) [`88481f0`](https://github.com/osbytes/reelsaw/commit/88481f053a1c602b7902e224bba9644c66527bd9) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Crops can be set by hand on top of what framing decides. Right-click the picture in the editor (or a section on the timeline, or the Crop… button on a section) for Set crop…, which fixes the pane under the pointer to an exact part of the source: a box to drag, resize or draw over the whole source frame, with the numbers beside it, starting from what shows now; a split's two panes, a stack's screen and speaker, and a fitted frame each take their own. A crop shaped like the pane fills it, any other shape is fitted over a blurred copy like a webcam tile, and dragging the picture moves a fixed crop. Over MCP, `update_clip` sections take `crop`, `crop2` and `contentCrop`. The hook on the preview has the same right-click menu as a text layer: edit it in place (or double-click it), centre it, reset its position, or hide it.

- [#157](https://github.com/osbytes/reelsaw/pull/157) [`c1501c1`](https://github.com/osbytes/reelsaw/commit/c1501c164a0d4b39fd20d2d08d65d4254e0d04c8) Thanks [@dillonstreator](https://github.com/dillonstreator)! - One clip's framing for the whole project. For a recording whose layout never changes (a slide deck with a webcam tile, a fixed camera), set the framing on one clip and pick "Use for all N clips…" on its Framing tab: the section's mode and its nudge, subject or crop become the project's framing (`reframe` and the new `reframeAdjust` setting), every clip's own sections are cleared, the finished clips re-render, and clips added later get it too. A clip without framing of its own now shows and renders the project's framing; editing it makes the clip's own, and "Use the project framing" takes it back. Over MCP `apply_framing` does the same from a clip id, `reframeAdjust` is a project setting like the others, and the CLI has `apply-framing`.

- [#157](https://github.com/osbytes/reelsaw/pull/157) [`6735b9a`](https://github.com/osbytes/reelsaw/commit/6735b9a99b096bce13a402e5530a1caae9614cbc) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Screen + speaker framing finds the webcam tile (the picture-in-picture box of a Zoom, Teams, Meet or OBS recording) around the speaker's face and shows just that tile in the speaker pane, instead of a face-sized crop that reached into the slides, the black column or the name plate. A tile in a flat band along a frame edge drops that band from the top pane, so the speaker is not shown twice, and a webcam too small for the face detector most of the time is still framed as a stack when its tile stands steady. A forced Screen + speaker section gets the same tile, and a drag on the speaker pane still nudges it. The framing eval gained `tile` cases for a webinar recording and a corner-webcam screencast.

### Patch Changes

- [#157](https://github.com/osbytes/reelsaw/pull/157) [`d75a456`](https://github.com/osbytes/reelsaw/commit/d75a456f3b66441e6453959fe4432f64043176fd) Thanks [@dillonstreator](https://github.com/dillonstreator)! - A re-rendered clip plays at once. The clip's video and thumbnail are served at a URL that never changes, with an hour-long cache, so after a re-render the project page and the clip preview could replay the previous render for up to an hour (a moved caption or a new crop looked as if it had not been applied). The clip media now carries an ETag and asks the browser to check before replaying, so an unchanged file still costs one small request and a re-rendered one is fetched anew.

## 0.21.0

### Minor Changes

- [#155](https://github.com/osbytes/reelsaw/pull/155) [`1a5a370`](https://github.com/osbytes/reelsaw/commit/1a5a3701841b1e6691d19a83fce726866f8134f8) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Changelog at reelsaw.com/releases (GitHub feed, 90-day commit heatmap). The app's What's new, version line and update banner link there; `list_releases` and `reelsaw releases` read the same feed.

## 0.20.0

### Minor Changes

- [#153](https://github.com/osbytes/reelsaw/pull/153) [`90ef339`](https://github.com/osbytes/reelsaw/commit/90ef3393e0417df2fd0c66ea3f34543895887fdf) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Layers on the editor's 9:16 preview have a right-click menu (edit text, centre, show for the whole clip, bring to front / send to back, copy, duplicate, remove) and a text layer can be retyped in place with a double-click. The Layers lane's right-click menu gained Template…, and applying a template keeps a clip's existing layers unless Replace is chosen.

- [#153](https://github.com/osbytes/reelsaw/pull/153) [`d64e671`](https://github.com/osbytes/reelsaw/commit/d64e6712b49fbc9061b1a7b2d57ccaecea0a4a9e) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Layer templates: save a look once (a logo pop in the first seconds, a follow card at the end, a watermark or a music bed) and put it on any clip whatever its length. Template layers are timed from the start, from the end, over the whole clip or as a share of the clip, so they stretch and contract with each clip. Build one from a clip's layers or in the template editor, apply it to selected clips (replacing or adding to their layers, with an optional re-render) or set it on a project so every new clip gets it. Also available as the `list_layer_templates`, `save_layer_template`, `update_layer_template`, `remove_layer_template`, `restore_layer_template` and `apply_layer_template` MCP tools and the `reelsaw templates` command.

## 0.19.1

### Patch Changes

- [#151](https://github.com/osbytes/reelsaw/pull/151) [`d579380`](https://github.com/osbytes/reelsaw/commit/d579380a691c35e615a04b0293ce8824646df6b3) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Giphy GIFs play in the library and land on a clip as a small looping sticker you can drag and resize. Adding a catalog or provider item no longer shows it as removed from the library.

## 0.19.0

### Minor Changes

- [#147](https://github.com/osbytes/reelsaw/pull/147) [`d08a8e5`](https://github.com/osbytes/reelsaw/commit/d08a8e5f7a7e3cdd2b7afb6b49eba773d7bd5644) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Operators can set a forgotten password from the shell without email: `reelsaw set-password you@example.com`. `--must-change` signs them in with that temporary password and then a blocking page asks for a new one (no current-password field). Other devices are signed out; API keys keep working.
  
  **Upgrade:** existing databases add `user.must_change_password` at boot (default off). On a box without email, `docker compose exec app reelsaw set-password you@example.com` replaces a forgotten password; pass `--must-change` when the operator invented it.

- [#147](https://github.com/osbytes/reelsaw/pull/147) [`d08a8e5`](https://github.com/osbytes/reelsaw/commit/d08a8e5f7a7e3cdd2b7afb6b49eba773d7bd5644) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Sign-in has Forgot password. When email is on, it sends a 24-hour reset link, and choosing a new password signs out other devices.

### Patch Changes

- [#150](https://github.com/osbytes/reelsaw/pull/150) [`31a78a1`](https://github.com/osbytes/reelsaw/commit/31a78a123958769f5a7247cefc66ee7c26799282) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Catalog and provider items are no longer saved into your library. Search them from the library or editor and add them to a clip; they stay on the instance while a clip uses them.
  
  **Upgrade:** Shared items you had bookmarked under Yours drop out of that list. Clips that already use them are unchanged, and the files still appear in catalog and provider search.

- [#149](https://github.com/osbytes/reelsaw/pull/149) [`99e57c4`](https://github.com/osbytes/reelsaw/commit/99e57c416053f1bc0c3d729b7da5408d1354cf87) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Searching the library no longer calls Iconify (or other remote providers) with an empty query, which used to return an error as you started typing.

- [#149](https://github.com/osbytes/reelsaw/pull/149) [`99e57c4`](https://github.com/osbytes/reelsaw/commit/99e57c416053f1bc0c3d729b7da5408d1354cf87) Thanks [@dillonstreator](https://github.com/dillonstreator)! - After a deploy, a tab that still has the old page reloads itself when nothing is unsaved. If you are in the middle of editing a clip, a header chip asks you to save first, then refresh.

## 0.18.2

### Patch Changes

- [#135](https://github.com/osbytes/reelsaw/pull/135) [`ba237ac`](https://github.com/osbytes/reelsaw/commit/ba237acf2b07599e09d93eee6577d1643280d59e) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Dependency updates across the app: AI SDK providers and `ai` 7.0.150, AWS S3 SDK 3.1156, better-auth 1.7.12, posthog, react 19.3.1, react-router 8.5, react-query, lucide icons, vite 8.3.5. OpenTelemetry stays on the 2.12 / 0.223 line and API 1.9 until the SDK moves to 3.0 as a set.

- [#117](https://github.com/osbytes/reelsaw/pull/117) [`1f2cdbe`](https://github.com/osbytes/reelsaw/commit/1f2cdbee0664e4a380690192c9437262e2d23b17) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Dependency fix: body-parser 2.4.0 (GHSA-27r3-jxmh-p828, a denial of service through trailing bytes after a compressed request, reachable through the MCP endpoint's Express layer). The image's base layers are now pinned by digest and Dependabot keeps them, the npm packages and the workflow actions current.

- [#111](https://github.com/osbytes/reelsaw/pull/111) [`ff53ef5`](https://github.com/osbytes/reelsaw/commit/ff53ef55c152786f62212bc10201d393d1e164c8) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Reelsaw is published to the official MCP registry as `io.github.osbytes/reelsaw` on every release, and the Docker image carries the registry's server-name label, so registry-aware clients can install the `reelsaw mcp` bridge straight from the image.

- [#124](https://github.com/osbytes/reelsaw/pull/124) [`2a50493`](https://github.com/osbytes/reelsaw/commit/2a50493325aef3ed6db385a61a1055b0b9e98e04) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The image is back on Node 22 LTS (an automated bump had moved it to Node 25, which is not an LTS line and was never built by CI). Automated base-image updates now stay within the major.

- [#131](https://github.com/osbytes/reelsaw/pull/131) [`4cc0fb7`](https://github.com/osbytes/reelsaw/commit/4cc0fb7d22c046f114353e476345493918ec824b) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Dependency fixes: nodemailer 10.2.1 (three address-parser advisories, GHSA-8c8m-p3m8-cjg8, GHSA-m943-m63m-w62w, GHSA-85x2-q946-cp5h) and fast-uri 3.1.9 (four URI parsing advisories reached through the MCP SDK's ajv). Each release's install folder now ships with a provenance attestation next to the zip.

## 0.18.1

### Patch Changes

- [#105](https://github.com/osbytes/reelsaw/pull/105) [`b8f29a7`](https://github.com/osbytes/reelsaw/commit/b8f29a7bde05d78c7b8db91811ecc0f200a64799) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The arm64 image starts again: SVG rasterising uses resvg compiled to WebAssembly instead of a native package that only existed for the build host's architecture.

## 0.18.0

### Minor Changes

- [#102](https://github.com/osbytes/reelsaw/pull/102) [`0f27072`](https://github.com/osbytes/reelsaw/commit/0f270722b001dbbc2666cc51671edd3ce9ad5824) Thanks [@dillonstreator](https://github.com/dillonstreator)! - One library for everything a clip can carry: intros and outros, logos, stickers, b-roll, music and sound effects, now including GIF, WebP and SVG. Clips hold one Layers list (image / video, text, sound) on a single editor lane that replaces the Overlays and Music lanes (`update_clip { layers }`, `reelsaw clip-layers`). The Library page and the editor pickers share one finder that searches your items, the bundled Reelsaw catalog (CC0 / permissive sounds, icons and emoji) and, with an admin-provided key, Pexels, Pixabay, Freesound, Iconify, Giphy and Klipy; adding a result imports it once per instance as a shared asset with its license and credit recorded, and "Add to clip" in the editor does both in one step. Usage counts come from an `asset_refs` table instead of scanning clips. New MCP tools: `list_assets`, `add_asset`, `update_asset`, `remove_asset`, `restore_asset`, `asset_usage`, `search_library`, `import_asset` `search_assets` finds items in your library, the catalog and providers (`library.search`), and `add_asset` adds from an upload, a link or a search hit (`library.add`). One `library` router replaces `bumpers` and the user-facing `catalog` router. Migration 0039.
  
  Removed: the MCP tools `list_assets` (use `search_assets` with `source: "library"` and an empty `q`), `search_library` (`search_assets`), `import_asset` (`add_asset` with `provider` + `externalId`) and the `*_bumper` aliases (`list_bumpers`, `add_bumper`, `rename_bumper`, `remove_bumper`, `restore_bumper`, `bumper_usage`; use the `*_asset` tools); the CLI commands `reelsaw bumpers`, `clip-overlays` and `clip-audio` (use `reelsaw library …` and `clip-layers`; `library import` is now `library add <provider:externalId>` and `--provider` is `--source`); and the `overlays` / `audio` inputs of `update_clip` and fields of `get_clip` (use `layers`).

### Patch Changes

- [#103](https://github.com/osbytes/reelsaw/pull/103) [`a9cb821`](https://github.com/osbytes/reelsaw/commit/a9cb8211674b64c658bc31d2d1b8f964c9a9ad5b) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Confirmation links work for 24 hours and only once. An expired or superseded link opens a page that sends a new one, and sign-in offers the same when the mailbox is not confirmed yet.

## 0.17.2

### Patch Changes

- [#100](https://github.com/osbytes/reelsaw/pull/100) [`4f94838`](https://github.com/osbytes/reelsaw/commit/4f9483893ed58474de7a1a885035ba6b564e7923) Thanks [@dillonstreator](https://github.com/dillonstreator)! - On a phone, the selected-clips action bar stays on screen while the browser URL bar is showing. Full-height shells now follow the visible viewport (`100dvh`) instead of `100vh`, which is taller than the screen with chrome visible.

## 0.17.1

### Patch Changes

- [#97](https://github.com/osbytes/reelsaw/pull/97) [`11c78d7`](https://github.com/osbytes/reelsaw/commit/11c78d7f3252196660bcedcd5a2c5ca3a658a12a) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Project failures show a short plain-language message instead of a wall of yt-dlp stderr. Admins see operator hints (env keys) and optional technical details; everyone else gets a generic line with no platform details. Download errors from a broken proxy are explained clearly.

- [#99](https://github.com/osbytes/reelsaw/pull/99) [`bd478e4`](https://github.com/osbytes/reelsaw/commit/bd478e43bd06324f48bbe72b99d7fdde0a22419b) Thanks [@dillonstreator](https://github.com/dillonstreator)! - App and transactional emails link to the source on GitHub (`github.com/osbytes/reelsaw`): login and pending pages, the account menu, Settings next to the version, and the email footer (HTML and plain text).

## 0.17.0

### Minor Changes

- [#95](https://github.com/osbytes/reelsaw/pull/95) [`2c67f49`](https://github.com/osbytes/reelsaw/commit/2c67f499f416765455ca17701c42375d6fd3838b) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Library: "used by" now counts every role an item plays (intro, outro, overlay, music track) and the usage list says which, per project and clip; items can be renamed from the card or the viewer; music plays in place on the card and in the viewer. `list_bumpers` adds `usedByClips` and `url` (the file), `bumper_usage` returns the roles per clip with overlay and music counts.

## 0.16.0

### Minor Changes

- Background music from the library plays under a clip: several tracks per clip on their own lane, each with window, offset, level, fade and loop, loudness-normalised and ducked while someone speaks. Captions and transcripts export as SRT/VTT (routes, zip, MCP, CLI), and an SRT/VTT file can be imported as a project's transcript. Text overlays take a font from the image (DejaVu, Liberation, Roboto, Open Sans, Lato, Inter, Bebas Neue), and ⌘C/⌘V copy and paste overlays and tracks in the editor. New: `clips.audio`, `clips.captions`, `update_clip { audio }`, `get_clip_captions`, `get_project_transcript_file`, `import_transcript`, `reelsaw clip-audio`, `captions`, `transcript-file`, `import-transcript`, `GET /api/fonts/:family`.

### Patch Changes

- [#92](https://github.com/osbytes/reelsaw/pull/92) [`0f3a7dd`](https://github.com/osbytes/reelsaw/commit/0f3a7dddd51a372b50772fe496f26b9b4b90faa5) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Keyboard shortcuts go through one binding helper (react-hotkeys-hook) instead of hand-rolled listeners, so the typing rule and the platform modifier are the same on every screen. ⌘K no longer splits framing in the clip editor; it only opens the command palette (⌘B splits, as the `?` sheet says).

## 0.15.0

### Minor Changes

- [#89](https://github.com/osbytes/reelsaw/pull/89) [`43ecc28`](https://github.com/osbytes/reelsaw/commit/43ecc28607fb0ba1a1c3304cfabf65dc5883c51d) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Clip editor: per-pane focus in split framing with follow awareness (drag either speaker; drop a pane on someone else to follow them), an Overlays lane for library images, videos and lines of text, intro/outro as blocks on the clip track, and one action bar with the preview's controls in a canvas header. The watermark is now the logo with the site name under it, top-left outside the platforms' dead zones. New: `clips.overlays`, `update_clip { overlays }`, `reelsaw clip-overlays`, `WATERMARK_LOGO_PATH`.

## 0.14.0

### Minor Changes

- [#83](https://github.com/osbytes/reelsaw/pull/83) [`65c0b7e`](https://github.com/osbytes/reelsaw/commit/65c0b7eb8a562f5ac1a842f4274324b3942e3a87) Thanks [@dillonstreator](https://github.com/dillonstreator)! - When OpenTelemetry points at Sentry, traces and logs go to Sentry's OTLP endpoint, and metrics go through the Sentry SDK. Sentry does not accept OTLP metrics. Logs are the same pino lines as the local log, with prompts, transcripts and secret values left out. The browser records traces on the same rate (`OTEL_TRACES_SAMPLE_RATE`, default all of them) and its API calls, including live subscriptions, stay on the server's trace.
  
  **Upgrade:** With `OTEL_ENABLED=true`, a Sentry OTLP endpoint and `SENTRY_DSN` set, the server starts sending logs and, unless `OTEL_METRICS_ENABLED=false`, runtime gauges and span durations. The browser starts sending traces too. Set `OTEL_METRICS_ENABLED=false` to keep traces and logs only, or `OTEL_TRACES_SAMPLE_RATE` below 1 to keep fewer traces.

### Patch Changes

- [#85](https://github.com/osbytes/reelsaw/pull/85) [`dd23f2b`](https://github.com/osbytes/reelsaw/commit/dd23f2b7f9c8c96a8a904e3ff11bfcd77771e77e) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Signing in to an account that is waiting for approval shows that waiting message instead of "Email not verified". The sign-in form asks for the current password, so a password manager does not generate a new one that was never stored. A repeat sign-up for an existing email is refused instead of looking successful.

## 0.13.0

### Minor Changes

- [#80](https://github.com/osbytes/reelsaw/pull/80) [`8ba227c`](https://github.com/osbytes/reelsaw/commit/8ba227caa5c4008ef5a3a5e103b9c68b293f3801) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Show each API and worker process under Settings → System → Workers, and a Queue section for live job depth, failed work, and bulk retry after a platform fix. A failed-work row opens the recorded reason (Retry, Copy, Open project); `#queue&fail=kind:id` deep-links it. Admins get the same from `list_workers` / `get_queue` / `list_failures` / `get_failure` / `retry_failures` and `reelsaw workers` / `reelsaw queue` / `reelsaw failure` / `reelsaw retry-failures`.

### Patch Changes

- [#80](https://github.com/osbytes/reelsaw/pull/80) [`8ba227c`](https://github.com/osbytes/reelsaw/commit/8ba227caa5c4008ef5a3a5e103b9c68b293f3801) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Admins can tick **Instance-wide diagnostics** on Report an issue to include unfinished work, failed jobs, usage and error logs across every account — not only their own projects. `reelsaw report --instance` and the `report_issue` MCP tool do the same.

## 0.12.0

### Minor Changes

- [#77](https://github.com/osbytes/reelsaw/pull/77) [`16f9d5b`](https://github.com/osbytes/reelsaw/commit/16f9d5b3e22f323157d2d2960f62b1fd0b5e0335) Thanks [@dillonstreator](https://github.com/dillonstreator)! - `YTDLP_PROXY` accepts one URL or an operator-ranked pool. Priority is what you set; a circuit breaker skips a candidate after consecutive faults and never lets a more reliable expensive proxy overtake a healthy cheaper one. `reelsaw ytdlp-proxies` shows the pool without URLs.

### Patch Changes

- [#76](https://github.com/osbytes/reelsaw/pull/76) [`c3b33b4`](https://github.com/osbytes/reelsaw/commit/c3b33b437bb3f6914806472a653a3a9ed8877c82) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Ingest fails immediately when the worker disk cannot hold `MIN_FREE_DISK_MB` plus the source (instead of waiting 900 s and retrying). Uploads reserve their actual size, and the UI says Preparing rather than Downloading.

## 0.11.6

### Patch Changes

- [#74](https://github.com/osbytes/reelsaw/pull/74) [`eb5ee1f`](https://github.com/osbytes/reelsaw/commit/eb5ee1ff2579123cf98f966b713a599d71362458) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Admins can turn the watermark off (or on) for one account from Users → Limits. Follow / Always / Never saves and applies on the next render; `reelsaw limits <email> --watermark always|never|follow` does the same.

## 0.11.5

### Patch Changes

- [#73](https://github.com/osbytes/reelsaw/pull/73) [`31561b7`](https://github.com/osbytes/reelsaw/commit/31561b7706d48d73dbd4f84c17d16d0a98dfb178) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Clips are picked throughout the video instead of clustering in the first couple of minutes. Each map pass now looks at a short overlapping window, and a second pass only runs when the first picks leave a long uncovered stretch. Existing projects pick this up on re-analyze.

## 0.11.4

### Patch Changes

- [#69](https://github.com/osbytes/reelsaw/pull/69) [`f841d61`](https://github.com/osbytes/reelsaw/commit/f841d610280bd080f80c166574c81476f964464c) Thanks [@dillonstreator](https://github.com/dillonstreator)! - OpenTelemetry is clearer to wire and works in the browser too: the server exports traces with explicit OTLP URLs/headers (Sentry destinations skip metrics), and when OTEL is on the web app gets the same public endpoint from `system.status` and sends browser traces. `SENTRY_DSN` stays separate from OTEL — set `OTEL_EXPORTER_OTLP_*` yourself.

## 0.11.3

### Patch Changes

- [#67](https://github.com/osbytes/reelsaw/pull/67) [`4ca10a5`](https://github.com/osbytes/reelsaw/commit/4ca10a5db563bcf4da39a8fb69791e135b847df2) Thanks [@dillonstreator](https://github.com/dillonstreator)! - On hosted instances with Sentry or PostHog, "Report an issue" sends feedback through those channels instead of a zip download. Instance system info and recent errors stay available only for self-host and admins, so a hosted account cannot export another user's diagnostics.

## 0.11.2

### Patch Changes

- [#64](https://github.com/osbytes/reelsaw/pull/64) [`c093611`](https://github.com/osbytes/reelsaw/commit/c0936116cdf7f12563d75ccc993c49a78c9a4b3f) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Transactional emails (verify, reset password, approved, waiting for approval) now send branded HTML with a clear button, plus the same links in plain text. No tracking.

- [#65](https://github.com/osbytes/reelsaw/pull/65) [`bbbae38`](https://github.com/osbytes/reelsaw/commit/bbbae387d6457283f58fac6141f304abfbdbc258) Thanks [@dillonstreator](https://github.com/dillonstreator)! - `pnpm stripe:setup` rebuilds `@reelsaw/shared` first so a stale shared build cannot miss exports like `billingPath`.

## 0.11.1

### Patch Changes

- [#62](https://github.com/osbytes/reelsaw/pull/62) [`673bd6d`](https://github.com/osbytes/reelsaw/commit/673bd6d0ad2bdbdff788868caa04bc840364f8d0) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The image entrypoint now `chown`s a volume-mounted `DATA_DIR` (e.g. Railway) before dropping to `node`, so boot no longer fails with `EACCES` on `/data/uploads`.

- [#60](https://github.com/osbytes/reelsaw/pull/60) [`df7d4ab`](https://github.com/osbytes/reelsaw/commit/df7d4ab57a515bd128e28808623854c5b5929a40) Thanks [@dillonstreator](https://github.com/dillonstreator)! - A budgeted batch loop (retention sweeps, purges) always makes one batch of progress before honouring its deadline, so a budget that is already spent when the loop starts cannot leave the cursor in place forever. Also fixes the timing-sensitive unit test that failed on a slow CI runner.

## 0.11.0

### Minor Changes

- [#53](https://github.com/osbytes/reelsaw/pull/53) [`1ac8156`](https://github.com/osbytes/reelsaw/commit/1ac815672b7ddd9c4e183302442c141aa05d5eb3) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Plans and billing for hosted instances (enterprise edition), a monthly minutes quota, and a watermark for accounts that are not admins.
  
  - `MAX_SOURCE_MINUTES_PER_MONTH` joins the quotas: minutes of source video per billing period (or UTC calendar month), with the usual refusal sentence and per-user override.
  - `WATERMARK_NON_ADMINS` (default on) burns `WATERMARK_TEXT` into the clips of non-admin accounts through the caption file; admins switch it per user on the Users page (Limits), a paid plan removes it, and each clip records whether it was rendered with it. **Upgrade:** multi-user installs that do not want this set `WATERMARK_NON_ADMINS=false` (Settings → System → Limits works without a restart).
  - `REELSAW_EE=true` with `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` loads `apps/server/src/ee` (its own licence, see LICENSING.md): Free / Starter / Creator / Pro plans (priced like OpenShorts Cloud) whose limits sit between the instance setting and the admin's per-user override, Stripe Checkout and Billing Portal from Settings → Billing, `get_billing` / `billing_checkout_url` over MCP, `reelsaw billing` on the CLI. Webhooks are recorded and queued in one transaction and the account's row is rewritten from Stripe by a job, so late, duplicate or reordered events converge; a daily reconcile and `reelsaw billing sync` repair lost ones. `pnpm stripe:setup` creates the Stripe objects; `pnpm stripe:mock` stands in for Stripe in development. Self-hosted installs are unchanged apart from the two settings above.
  - Free-tier abuse guards, off unless set: `MAX_SIGNUPS_PER_IP_PER_DAY`, `BLOCK_DISPOSABLE_EMAILS`, one account per real mailbox (`user.email_key`, backfilled by the migration), `MAX_REQUESTS_PER_MINUTE` / `_HOUR` on changes per account, and hourly abuse flags on the Users page (`reelsaw abuse`). `TRUST_PROXY` (default on) names which headers carry the client address.
  - Optional Sentry (`SENTRY_DSN`) and PostHog (`POSTHOG_KEY`, `POSTHOG_HOST`) across server and web: errors from boot, 5xx API calls, final job failures and render crashes; product events for sign-ups, projects, billing and abuse flags; page views and a few actions in the browser. Off unless set.

- [#51](https://github.com/osbytes/reelsaw/pull/51) [`defa355`](https://github.com/osbytes/reelsaw/commit/defa355d665e4d95dbf9a4ae5f2f6faf8b830269) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Refine after transcription (name fixes, filler removal, the filler model pass, and scene cuts) is opt-in: turn steps on per project or in Project defaults, with instance ceilings under Settings → System → Pipeline.
  
  **Upgrade:** `TRANSCRIPT_CORRECTION`, `DISFLUENCY_REMOVAL`, `DISFLUENCY_LLM` and `REFINE_SCENES` now default to off (was on). New projects skip refine unless you open those gates and opt the project in. To keep the old behaviour, set them to `true` in `.env` or Settings → System → Pipeline, and turn the matching toggles on in Project defaults.

### Patch Changes

- [#57](https://github.com/osbytes/reelsaw/pull/57) [`57528f2`](https://github.com/osbytes/reelsaw/commit/57528f2e3de406830e0d0372670325a865a9bf2d) Thanks [@dillonstreator](https://github.com/dillonstreator)! - CTC forced alignment no longer treats adjacent repeated letters without a blank as a valid path, so words like "hello" get legal letter spans at cut seams.

## 0.10.2

### Patch Changes

- [#47](https://github.com/osbytes/reelsaw/pull/47) [`8dfaeae`](https://github.com/osbytes/reelsaw/commit/8dfaeaec5d637997ba22b9ed1751ad538705711f) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Add `local-qwen14-cpu` / `local-qwen14-gpu` bench profiles and `bench:e2e --gpu` (NVENC for the isolated bench app). Fix the e2e driver on Windows (`fileURLToPath` for the repo root cwd, resolve `docker.exe` via `where.exe`).

## 0.10.1

### Patch Changes

- [#45](https://github.com/osbytes/reelsaw/pull/45) [`eeb1933`](https://github.com/osbytes/reelsaw/commit/eeb1933b430ccbd3a7d6e7ef317aba4887a76da7) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Link downloads now report progress ("Downloading 42% of 1.57GiB at 5.00MiB/s"): yt-dlp's `--print-json` silenced its progress lines, and they were read from the wrong stream. "Download finished in …" shows the download's wall clock instead of the video's length, and processing-time estimates no longer learn from the bad ingest samples.

## 0.10.0

### Minor Changes

- [#41](https://github.com/osbytes/reelsaw/pull/41) [`c48aeb5`](https://github.com/osbytes/reelsaw/commit/c48aeb59469910235ece5b17da377997cf0db14d) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Use the GPU where it pays. `docker-compose.gpu.yml` hands an NVIDIA card to Speaches (`SPEACHES_IMAGE=ghcr.io/speaches-ai/speaches:latest-cuda`, so `faster-whisper-large-v3` transcribes faster than `small` did on the CPU), to Ollama in a container, and to the app, where ffmpeg now encodes clips, intros and outros with `h264_nvenc` when `FFMPEG_ENCODER=auto` finds it at boot (VideoToolbox on a Mac outside Docker); a hardware encoder that fails mid-render falls back to libx264 for that clip. `ONNX_EXECUTION_PROVIDER` moves the face, text and alignment models to CUDA, CoreML or DirectML with a CPU fallback (CPU stays the default: measured faster on Apple silicon). Settings → System → Overview and the new `reelsaw machine` command show the GPU the process sees, the encoder in use and why, and where each on-device model runs.

- [#41](https://github.com/osbytes/reelsaw/pull/41) [`9324f80`](https://github.com/osbytes/reelsaw/commit/9324f80d74cd125fbc74656e7fe010e4949c2566) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The one-command installers (`install.sh`, `install.ps1`) now look at the machine before doing anything: RAM, an NVIDIA GPU and its VRAM, Docker's memory, free disk, an Ollama already running and the models it has, and the port. They print a plan and ask three questions (local Ollama or a hosted provider, which model, go ahead), install Ollama when it is missing and you chose local, reuse a good model Ollama already has, pick the model by VRAM when a GPU serves it, move a busy port, and put Ollama, Speaches and the app on the GPU when the NVIDIA Container Toolkit is present. Hosted providers (OpenAI, Anthropic, Google, Groq, Vercel AI Gateway) are a choice in the same prompt. `REELSAW_YES=1` takes the proposed answers, `REELSAW_DRY_RUN=1` prints the plan and stops; re-running upgrades an existing install.

### Patch Changes

- [#44](https://github.com/osbytes/reelsaw/pull/44) [`9ba8669`](https://github.com/osbytes/reelsaw/commit/9ba86694b3447e8f34b3f26192bdc7c82fdd9209) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Detect the GPU on Docker Desktop (WSL2) via `/dev/dxg` when `nvidia-smi` and `/dev/nvidia0` are missing, document that Windows `.env` must use `;` in `COMPOSE_FILE` (a colon is the drive-letter separator), and keep `pnpm docs:gen` defaults as POSIX paths on Windows.

## 0.9.0

### Minor Changes

- [#35](https://github.com/osbytes/reelsaw/pull/35) [`21cc500`](https://github.com/osbytes/reelsaw/commit/21cc5006a428ec4b56247f6865f579ab38ca8390) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Admins can change instance settings without a restart: sign-up mode, email verification, captcha, legal links, per-account quotas, upload limits, retention, the stall watchdog, the update check and whether /api/health shows machine numbers. The environment stays the default; what an admin saves under Settings → System, with `reelsaw settings` or the `set_instance_settings` MCP tool overrides it for every process within seconds, is validated as a whole and audited. The Settings page is split into Account and System tabs, and project cards keep one height whatever the title length.

## 0.8.0

### Minor Changes

- [#32](https://github.com/osbytes/reelsaw/pull/32) [`af4f780`](https://github.com/osbytes/reelsaw/commit/af4f78091503582bfa6435d96c82dd0e2e8a959e) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Admins are told when a newer Reelsaw is published: Settings → System shows the release with its notes link and the one command to upgrade, and the account menu marks Settings with the waiting version (a dot on the account button) until it is done. Settings itself moved from the top bar into the account menu. `reelsaw version` prints the same from the shell and the `check_for_update` MCP tool returns it to agents. The app asks GitHub's releases API every 6 hours, sending nothing but the request; `UPDATE_CHECK=false` turns it off.

### Patch Changes

- [#34](https://github.com/osbytes/reelsaw/pull/34) [`37f2f59`](https://github.com/osbytes/reelsaw/commit/37f2f591b489f98a96efadb03b243503c03406e9) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Escape the caption file path correctly for ffmpeg, so renders work when the data directory contains a colon, quote or backslash. YouTube links are only recognised on youtube.com and its subdomains, and a vulnerable esbuild pulled in by drizzle-kit is overridden.

## 0.7.0

### Minor Changes

- [#29](https://github.com/osbytes/reelsaw/pull/29) [`c6fe768`](https://github.com/osbytes/reelsaw/commit/c6fe768e6f515ce16c5412412528e0e027500005) Thanks [@dillonstreator](https://github.com/dillonstreator)! - MCP tools say what they return, whether they run in the background and which neighbouring tool to use instead, every input is described, and three new tools (with tRPC and CLI twins) fill gaps: `delete_clip` (restorable with `restore_clip`), `update_project` (title and settings without re-running anything) and `rename_bumper`; a partial caption style on a clip or project no longer resets the other style fields to their defaults.

- [#29](https://github.com/osbytes/reelsaw/pull/29) [`dda5789`](https://github.com/osbytes/reelsaw/commit/dda5789d01bc791e3c1bc5396e8777ab4094554f) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Deleting a project can be undone for 7 days, and re-picking moments keeps every clip you made or edited, replacing only untouched AI picks (which can be restored too); the same through MCP (`restore_project`, `restore_clip`) and the CLI (`reelsaw deleted`, `restore`, `restore-clip`, `purge`).
  
  **Upgrade:** deleted projects now keep their files for `DELETED_RETENTION_DAYS` (default 7; 0 keeps them forever) before the hourly sweep removes them, so disk is freed a week after a delete instead of at once; lower the setting to free it sooner. The migration adds `deleted_at` to projects and clips and `edited_at` to clips. Clips edited before this release are only recognised as edited by their framing, style or intro/outro choice.

### Patch Changes

- [#29](https://github.com/osbytes/reelsaw/pull/29) [`e76241c`](https://github.com/osbytes/reelsaw/commit/e76241ce41181383359991e5630cc748aaa6a666) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Boot checks the models that will actually run (including an admin override), rejects transcription models without word timestamps, and the installer picks the language model by RAM, verifies the container can reach a host Ollama, and the image pins yt-dlp and every model weight by checksum.

- [#29](https://github.com/osbytes/reelsaw/pull/29) [`0b3fefb`](https://github.com/osbytes/reelsaw/commit/0b3fefb14d446e4886e56900577ce711178a8db7) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Evals: real-speech transcription cases graded against human captions (raw and normalised WER, names-only error rate) and 48 disfluency cases from caption diffs, with a caption-diff tool to make more.

- [#29](https://github.com/osbytes/reelsaw/pull/29) [`8589266`](https://github.com/osbytes/reelsaw/commit/8589266810bb065ff02001e7f51c62eb14be2e51) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Caption lines now stay up long enough to read (0.3 s per word, 20 characters per second), face-size thresholds adapt to non-16:9 sources, and the renderer and preview share one crop and font definition.

- [#29](https://github.com/osbytes/reelsaw/pull/29) [`57087ee`](https://github.com/osbytes/reelsaw/commit/57087eea86f8425ed363ffecd1f431c77eb7515e) Thanks [@dillonstreator](https://github.com/dillonstreator)! - CI now runs every stack-free test and the offline eval suites, and `eval --update` refuses to record regressions without a stated reason.

- [#29](https://github.com/osbytes/reelsaw/pull/29) [`8b64662`](https://github.com/osbytes/reelsaw/commit/8b646628ba8a021cbbd82dc386c5357f39b5bb86) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Jobs are served fairly between accounts (someone with nothing in flight goes ahead of another account's backlog), model calls are capped per provider across all processes (`PROVIDER_CONCURRENCY`, self-hosted default 2), new per-user limits `MAX_LIVE_JOBS_PER_USER`, `MAX_RERENDERS_PER_HOUR` and `MAX_STORAGE_MB`, and usage now shows reported LLM cost, minutes transcribed and rendered-clip storage (`reelsaw usage`, `reelsaw limits <email>`).
  
  **Upgrade:** migration adds `llm_usage.cost_usd`, `clips.output_bytes` and the `stt_usage` table; the new limits default to 0 (unlimited), so a single-operator install behaves as before. Jobs already queued carry no owner and are not counted toward the new limits. A self-hosted model now serves at most 2 calls at once across all workers unless `PROVIDER_CONCURRENCY` says otherwise.

- [#29](https://github.com/osbytes/reelsaw/pull/29) [`93084c7`](https://github.com/osbytes/reelsaw/commit/93084c7195bab2937b6f2e6d73ab84d161ee8835) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The framing eval now scores non-podcast sources (multi-camera talk show, screencast with a corner webcam, 4:3 interview, hands-only POV, vertical short) against hand-labelled shot windows.

- [#29](https://github.com/osbytes/reelsaw/pull/29) [`527c02e`](https://github.com/osbytes/reelsaw/commit/527c02e941cedf754dff51be0090f64dac5758a0) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Docs: every environment variable, operator CLI command and eval suite is now documented from generated tables (docs/CONFIG.md, both .env.example files; `pnpm docs:check`), with a "Settings and precedence" section and corrected install, heartbeat and boot-check notes.

- [#29](https://github.com/osbytes/reelsaw/pull/29) [`d3fb6f7`](https://github.com/osbytes/reelsaw/commit/d3fb6f7f5a1d09e30ee941715ceff4c1f51a1ba8) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Harden ingress: streamed uploads are size-capped, link sources must be public http(s) URLs, the first sign-up race cannot create two admins, and admin-entered provider keys are scrubbed from issue reports.

- [#29](https://github.com/osbytes/reelsaw/pull/29) [`abca9fe`](https://github.com/osbytes/reelsaw/commit/abca9fef6d3cd50f5235092b92285f7f2ff29ff0) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Changing a project's style, intro/outro or source-text setting while clips finish rendering no longer risks a stalled or failed request, and project limits now hold when several projects are created at once.

- [#29](https://github.com/osbytes/reelsaw/pull/29) [`8870362`](https://github.com/osbytes/reelsaw/commit/88703621943f8ab340a4b3970507abc4e5e60723) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Add overlay and active-speaker eval fixtures from talk-show, street-interview, screencast, sport, podcast and news sources.

- [#29](https://github.com/osbytes/reelsaw/pull/29) [`bb8a613`](https://github.com/osbytes/reelsaw/commit/bb8a6133226731545f4bbd2a87e1aab693761170) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Auto mode now drops weak clips relative to the run's own scores (median − MAD, floor 25) instead of a fixed 45, so switching the judge model no longer empties projects or keeps every clip; the pairwise pass places the top 3 reliably and a separate judge model can be set.

- [#29](https://github.com/osbytes/reelsaw/pull/29) [`5a52f25`](https://github.com/osbytes/reelsaw/commit/5a52f25398e0d3baf22c269d779a15f9420b1e11) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The scenes eval now covers bright football highlights, a news package and a multi-camera studio show, and can exclude dissolves and wipes from the hard-cut metric.

- [#29](https://github.com/osbytes/reelsaw/pull/29) [`d744ee1`](https://github.com/osbytes/reelsaw/commit/d744ee1e053becb6ea24855d11f5c2ab5e8b8404) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The selection eval now measures whether clip picking finds the moments podcast creators cut their own shorts from (creator-picks cases, labelled with the new `creator-spans` tool).

- [#29](https://github.com/osbytes/reelsaw/pull/29) [`6f61191`](https://github.com/osbytes/reelsaw/commit/6f611913bc24ec1e5eb8b974ea3c59c697854b73) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Filler removal, name fixes and CTC cut alignment now skip with a plain-language notice for non-English transcripts instead of running silently, and text matching and sentence splitting understand non-Latin scripts.

- [#29](https://github.com/osbytes/reelsaw/pull/29) [`4ad75e2`](https://github.com/osbytes/reelsaw/commit/4ad75e2c868227f02b294ca713d8fce423eab00a) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The web app loads faster and plays smoother: pages and the command palette load on demand, the clip editor and transcript no longer re-render every frame during playback, and the interface follows the layout-shift, loading-state and scrolling rules more closely.

## 0.6.0

### Minor Changes

- [#24](https://github.com/osbytes/reelsaw/pull/24) [`84251b0`](https://github.com/osbytes/reelsaw/commit/84251b0293efbacfa7c6fa971a601af9ab5ef355) Thanks [@dillonstreator](https://github.com/dillonstreator)! - MCP over stdio: `reelsaw mcp` serves the same tools as `/api/mcp` to clients that launch a command instead of calling a URL with a header (Claude Desktop without OAuth, Cursor's stdio entries, registry checks). It forwards every call to a running instance (`REELSAW_URL`, default the app in the same container, with `REELSAW_API_KEY`), so it needs no database or models. Settings → API keys and MCP shows the `docker exec` config next to the HTTP ones.

### Patch Changes

- [#25](https://github.com/osbytes/reelsaw/pull/25) [`711893f`](https://github.com/osbytes/reelsaw/commit/711893fe301cc75662b025cb515175a8778c29e0) Thanks [@dillonstreator](https://github.com/dillonstreator)! - New logo: a sliced "r" monogram on the accent colour, with the wordmark split as reel/saw. Favicon, app icons and the README lockup are redrawn to match.

## 0.5.0

### Minor Changes

- [#18](https://github.com/osbytes/reelsaw/pull/18) [`6cc7335`](https://github.com/osbytes/reelsaw/commit/6cc7335027a90eeb539165ff61b462c8eaf3f363) Thanks [@dillonstreator](https://github.com/dillonstreator)! - A speaker beside an app screen or title card is framed as a stack: that content on top, the speaker below

### Patch Changes

- [#21](https://github.com/osbytes/reelsaw/pull/21) [`af880e7`](https://github.com/osbytes/reelsaw/commit/af880e74f5a12314c8456ab0e26afedd51fc3d5b) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Clips end on a complete thought. A clip that stopped mid-sentence ("…and you're now so | different") now finishes the sentence when it is within 8 seconds (or steps back to the previous one), and starts at the beginning of a sentence when one is within 3 seconds. Sentence ends come from punctuation, pauses and capital letters after a word that is not a connector like "and" or "so". Your manual edits are never moved. See docs/SELECTION.md.

- [#18](https://github.com/osbytes/reelsaw/pull/18) [`6f809da`](https://github.com/osbytes/reelsaw/commit/6f809da1177f71c23ef9313d229b0a2fa7fe9e3c) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Framing is no longer affected by how many clips render at once

- [#23](https://github.com/osbytes/reelsaw/pull/23) [`1d7d51c`](https://github.com/osbytes/reelsaw/commit/1d7d51c56fd0aae1acda259a7ccbe2f9d3a814b2) Thanks [@dillonstreator](https://github.com/dillonstreator)! - A cut you made is always applied. When the seam check could not re-find the removed words in the audio (a sentence said twice, "seven" heard as "7"), the cut used to be dropped silently. It is now matched by its position in the audio instead of by text, with numbers, case and punctuation ignored, and if the seam still cannot be confirmed the cut is applied where you set it and marked "▲ cut unverified" on the clip card, in the editor's cuts tab and next to the cut in the transcript, with a notice in the activity feed. Automatic cuts that cannot be verified are still kept in the audio and reported.

- [#20](https://github.com/osbytes/reelsaw/pull/20) [`da61f0a`](https://github.com/osbytes/reelsaw/commit/da61f0a224981dc24acf7852f690e9ea54f60368) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Fix a deadlock when several clips finish rendering at once (a batch re-render): the render completion no longer fails and re-renders from scratch, and transactions aborted by a lock conflict are retried.

## 0.4.0

### Minor Changes

- [#17](https://github.com/osbytes/reelsaw/pull/17) [`888c6c3`](https://github.com/osbytes/reelsaw/commit/888c6c3d088cd5a7b63a3f2a2ee9b18cfc723fd4) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Select clips on the project page and act on them together: re-render, export a zip of just those clips, copy their titles and captions, set their intro/outro, or retry the failed ones (also `rerender_clips` and `export_project` with `clipIds` over MCP, `reelsaw rerender <clipId…>`, and `?clips=` on the export URL). Clip cards are quieter: one muted summary line (framing, intro/outro, cuts) instead of four rows, Edit and Download up front and everything else in a ⋯ menu. The select-all controls now sit in the sticky "Clips" header.

- [#16](https://github.com/osbytes/reelsaw/pull/16) [`3e55f1f`](https://github.com/osbytes/reelsaw/commit/3e55f1f0b3cb90f66035c68710566886a742ce3c) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Logs now explain what the pipeline decided and why. Every project event (run started, stage completed, clip done or failed) is a log line with the project, run and job ids; at `debug` you also get the moments chosen with their scores, the layout per section and why, each cut accepted or rejected, the ffmpeg commands, framing and bumpers used. API requests, sign-ins, admin actions and MCP tool calls are logged with a request id that is returned in the `x-request-id` header and carried through tRPC errors. `LOG_LEVEL` accepts per-module levels (`info,render=debug`), and `reelsaw log-level render=debug --for 15m` (or Settings, System, Log level) changes them on a running install and puts them back by itself. `reelsaw logs <id>` can filter by time, level and module, issue reports include the level in force, and browser errors are reported to the server log.

- [#11](https://github.com/osbytes/reelsaw/pull/11) [`1fe6a36`](https://github.com/osbytes/reelsaw/commit/1fe6a36fa01fa1e285ed04b3aabc8966ffc29981) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Bound background work and growth: progress ticks are live-only (sent over Postgres NOTIFY, never stored); `EVENT_RETENTION_DAYS` (90), `LLM_USAGE_RETENTION_DAYS` (180) and `ADMIN_EVENT_RETENTION_DAYS` (365) prune old rows daily in batches; deleted fixes beyond 200 are archived instead of dropped; clip diagnostics are capped; transcript edits write only the columns that changed; the storage sweep looks up directories 1,000 at a time with bounded parallel `stat` and resumes from a cursor after a time budget; retention and the library purge use keyset batches; job lookups use `singleton_key`.

- [#11](https://github.com/osbytes/reelsaw/pull/11) [`ba6ada9`](https://github.com/osbytes/reelsaw/commit/ba6ada9e3983dd569713ec241e923f8156cd5550) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Projects and the admin user list load in pages instead of all at once. The Projects page loads 24 at a time as you scroll (or with Load more), shows the true totals in its header, and only polls the projects that are processing. The admin Users page searches on the server (with `%` and `_` matched literally), shows "Showing 50 of N" and loads more on request. The `list_projects` MCP tool takes `limit` and `cursor` and returns `nextCursor` and `total`.

- [#11](https://github.com/osbytes/reelsaw/pull/11) [`8578922`](https://github.com/osbytes/reelsaw/commit/8578922a11425aca0d5168543541a1e4c159f395) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Large projects open and stay fast. The project page no longer re-downloads the whole transcript on every event: the project and its transcript load separately, and each event refreshes only what it changed. The Activity panel replays the last 300 events (configurable with `EVENT_REPLAY_LIMIT`) and shows "Showing the last 300 of N", with a "Load older" button. The command palette (⌘K) now searches on the server as you type (typo-tolerant, best matches first), so it finds every project and clip however many you have, and the MCP server gains `search_clips`. `get_project` returns only a transcript summary; use `get_transcript` for the text. Adds the `pg_trgm` extension and search indexes (migration 0028).

### Patch Changes

- [#11](https://github.com/osbytes/reelsaw/pull/11) [`dc445b7`](https://github.com/osbytes/reelsaw/commit/dc445b70ffd451b0d3fac0513a4a8a00f5f835e0) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Add indexes for the common list, reconcile and retention queries (`projects (user_id, updated_at)`, `projects (status)`, partial retention indexes, `uploads (user_id)`), plus a scale audit (`docs/specs/scale.md`), a Scale section in the engineering principles and a seed script for measuring at 1,000 projects.

## 0.3.1

### Patch Changes

- [#8](https://github.com/osbytes/reelsaw/pull/8) [`d79cf11`](https://github.com/osbytes/reelsaw/commit/d79cf112290aadcd4a73e1f85168fd42db6bcf82) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Pages, lists, pickers and settings now show placeholder skeletons shaped like their content while loading, instead of flashing "No activity yet" or "Nothing found" before the data arrives.

- [#8](https://github.com/osbytes/reelsaw/pull/8) [`de341bb`](https://github.com/osbytes/reelsaw/commit/de341bba6bddda2970cc45dc778cbc9c22493a37) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The Users page is now one aligned list with usage per account, sortable columns and a usage window picker, and the Limits dialog shows how much of each limit an account has used.

## 0.3.0

### Minor Changes

- [#5](https://github.com/osbytes/reelsaw/pull/5) [`02a9343`](https://github.com/osbytes/reelsaw/commit/02a9343f1e42f76e260c1a7db82024cd38033ec8) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Library page for intros and outros: drop several files at once (duplicates are detected), click a thumbnail to view it enlarged, see which projects and clips use each item, remove with Undo. Pickers everywhere are a searchable combobox with thumbnails, and images get a 3 s default that can be changed per item or per use. New projects can pick their intro and outro up front, project cards show the assets in use as small fanned cards, and ⌘K and the New project menu offer library shortcuts. Toasts now use sonner.

- [#5](https://github.com/osbytes/reelsaw/pull/5) [`1241496`](https://github.com/osbytes/reelsaw/commit/12414961d9696616acf3e9979d15963fd233db57) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Intro and outro library: keep several videos or images (PNG or JPG, shown 1 to 10 s) and choose which one new projects start with. Each project can use the default, none, or a specific one, and a single clip can opt out; changes re-render only when confirmed. The editor shows what a clip adds around its source range, and clip cards say when an intro or outro was skipped.

- [#5](https://github.com/osbytes/reelsaw/pull/5) [`02a9343`](https://github.com/osbytes/reelsaw/commit/02a9343f1e42f76e260c1a7db82024cd38033ec8) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Agents and operators can manage intros and outros: MCP tools `list_bumpers`, `add_bumper` (from a URL or an upload), `set_default_bumper`, `remove_bumper`, `restore_bumper`, `bumper_usage`, `set_project_bumpers` and `set_clip_bumpers`; `get_project`, `get_clip` and `create_project` carry intro/outro state. CLI: `reelsaw bumpers …`, `reelsaw project-bumpers`, `reelsaw clip-bumpers`.

- [#5](https://github.com/osbytes/reelsaw/pull/5) [`6a53f17`](https://github.com/osbytes/reelsaw/commit/6a53f1706eb03c180703c19004db7ea554a560b9) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Choose an intro and outro per clip: each clip can follow the project, use none, or use a specific library item, per slot. Set it in the editor, from a clip card, or for several selected clips at once on the project page. Replaces the all-or-nothing opt-out.

- [#5](https://github.com/osbytes/reelsaw/pull/5) [`02a9343`](https://github.com/osbytes/reelsaw/commit/02a9343f1e42f76e260c1a7db82024cd38033ec8) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Command palette (⌘K): rows show status, length, clip counts and age; → or Tab on a project or clip opens its actions (open, export, resume, retry failed clips, re-run refine, delete, edit, re-render, download) with confirms for the destructive ones. "Retry all failed clips" and "Resume failed projects" appear when there is something to retry. A pasted link that matches an existing project offers to open it, and a list of links starts one project each.

- [#5](https://github.com/osbytes/reelsaw/pull/5) [`8e99bb4`](https://github.com/osbytes/reelsaw/commit/8e99bb466c160e68c29325a3aafd6bfb851fd77a) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Intro and outro videos: upload one of each in Settings and every clip of new projects is rendered as intro + clip + outro in a single encode. Bumpers are fitted to vertical with a blurred background, normalised once per asset, and an unusable one is skipped with a plain-language event instead of failing the clip. Exports gain `rendered_duration_sec`.

- [#5](https://github.com/osbytes/reelsaw/pull/5) [`02a9343`](https://github.com/osbytes/reelsaw/commit/02a9343f1e42f76e260c1a7db82024cd38033ec8) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Processing time is measured per run. Every retry, re-render, refine or re-analyze starts an explicit run (`run.started`), stage and project events carry their own durations, and the activity feed groups history by run with its reason and total. A clip re-rendered hours after a project finished now reports its own time instead of the time since the first run. Expected-time estimates, Processing times and `reelsaw status` read the same runs.

- [#5](https://github.com/osbytes/reelsaw/pull/5) [`02a9343`](https://github.com/osbytes/reelsaw/commit/02a9343f1e42f76e260c1a7db82024cd38033ec8) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Storage: superseded render generations and expired sources are removed from the scratch directory too, uploads are released when a project is deleted, and an hourly sweep removes orphaned files. `reelsaw storage` reports unique, leftover, duplicate-source and expired bytes; `reelsaw storage sweep [--dry-run]` runs the sweep on demand. Removed intro/outro assets that nothing references are purged after 30 days.

### Patch Changes

- [#5](https://github.com/osbytes/reelsaw/pull/5) [`02a9343`](https://github.com/osbytes/reelsaw/commit/02a9343f1e42f76e260c1a7db82024cd38033ec8) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Space in the clip preview plays that clip instead of the hidden source video. The "jobs paused" chip sits left of the search box so it no longer shifts the header when it appears. Changing an intro/outro length in the editor now enables Save & re-render.

- [#5](https://github.com/osbytes/reelsaw/pull/5) [`02633c7`](https://github.com/osbytes/reelsaw/commit/02633c732117f2abffe262962d65b08ab575768f) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Windows: a PowerShell one-line installer (`install.ps1`) next to the bash one. Both installers are now served straight from the repository (raw.githubusercontent.com) instead of a gist.

## 0.2.0

### Minor Changes

- [`1fc2886`](https://github.com/osbytes/reelsaw/commit/1fc28860f5c06cec3c57d4b8633d8f55feda2735) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Accounts and roles: the first account is the admin; `SIGNUP_MODE=open|approval|closed` controls sign-ups (approval holds new accounts on a "Waiting for approval" page until an admin approves them on the new Users page). Admins can suspend, reinstate, promote and remove accounts; `reelsaw users|approve|make-admin` from the shell. Optional email (`EMAIL_DRIVER=smtp|resend`) sends approval notices, password resets and verification.
  
  **Upgrade:** existing accounts stay approved; the oldest becomes the admin. `ALLOW_SIGNUP=false` still means `closed`.

- [#4](https://github.com/osbytes/reelsaw/pull/4) [`4142149`](https://github.com/osbytes/reelsaw/commit/41421494ef06858ab96f4e049b830763cf9ee6c2) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Admins can switch models and connect providers without a restart. Settings → System → Models has pickers for the language, transcription and alignment models; each opens provider-first: pick a provider, and if it has no key or server URL yet, enter it right there (stored encrypted with a key derived from `BETTER_AUTH_SECRET`; never shown again; `.env` stays the default) and its models appear. Cloud vendors are listed live (OpenAI, Anthropic, Google, Groq, Deepgram, AssemblyAI, the Vercel AI Gateway with prices); self-hosted Ollama or Speaches show what is installed and download missing models with a progress bar. Saving a key tries it first (lists the provider's models); saving a model verifies it (key, server, word timestamps for transcription). Overrides live in the database so every process picks them up within seconds; a stage that is already running finishes with the model it started with. API: `admin.providers.get/set/clear`, `admin.models.get/catalog/set/test/pull`; changes go to the admin event log.

- [#3](https://github.com/osbytes/reelsaw/pull/3) [`b128b11`](https://github.com/osbytes/reelsaw/commit/b128b11da85c1d62cb52a699dd26ac304369903c) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Expected vs actual processing time: the project page shows elapsed and expected time for the running stage, the activity feed says how long each stage took against its expectation, and Settings → System → Machine (admins) has a per-stage expected vs actual table across recent projects. Expectations start from measured defaults (README, "What to expect") and become the median of your own finished projects that ran with the same models; there is no calibration step. Also a proper not-found page for missing projects and clips.
  
  For contributors: `pnpm eval ... --matrix eval/bench/models.json` runs the suites once per model profile (env overrides on `.env`; cloud models through the Vercel AI Gateway, `gateway:<vendor>/<model>`) with latency, tokens and cost per profile side by side, and `pnpm bench:e2e` times the real pipeline per stage in an isolated compose stack, with `--steps refine,analyze` to re-run just those steps on one transcript. The first result set is in `eval/bench/results/2026-10-17-initial/`.

- [`1fc2886`](https://github.com/osbytes/reelsaw/commit/1fc28860f5c06cec3c57d4b8633d8f55feda2735) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Running Reelsaw for many people: quotas (`MAX_PROJECTS_PER_USER`, `MAX_SOURCE_MINUTES_PER_DAY`, `MAX_NEW_PROJECTS_PER_HOUR`, per-user overrides on the Users page) with plain-sentence refusals; usage per user (projects, source minutes, clips, model calls and tokens, stored bytes); retention (`SOURCE_RETENTION_DAYS`, `CLIP_RETENTION_DAYS`, "fetch again" on the project); captcha on sign-up/sign-in (`CAPTCHA_PROVIDER`); `YTDLP_PROXY` / `YTDLP_COOKIES_FILE` and plain-words download failures; `TERMS_URL` / `PRIVACY_URL`; MCP over OAuth 2.1 (`MCP_OAUTH=true`) so claude.ai and Claude Desktop connectors sign in with the browser. All off by default.

- [`1fc2886`](https://github.com/osbytes/reelsaw/commit/1fc28860f5c06cec3c57d4b8633d8f55feda2735) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Agents can drive Reelsaw over MCP: `POST /api/mcp` (Streamable HTTP) with tools to create projects, wait for them, read timed transcripts, edit, re-render and download clips. API keys (Settings → API keys and MCP) authenticate MCP, tRPC, uploads and media downloads; the page shows the Claude Code and mcp.json config.

- [`1fc2886`](https://github.com/osbytes/reelsaw/commit/1fc28860f5c06cec3c57d4b8633d8f55feda2735) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Settings are per person: everyone gets Account (name, password), Project defaults (vocabulary, instructions, language, clip length, pauses, caption style; applied to every new project, the new-project form starts from them) and API keys. Machine configuration and resource meters are shown to admins only, and `GET /api/health` includes them only for admins (or with `HEALTH_DETAILS=true`).

### Patch Changes

- [`1fc2886`](https://github.com/osbytes/reelsaw/commit/1fc28860f5c06cec3c57d4b8633d8f55feda2735) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Project licensed under AGPL-3.0 with a DCO sign-off for contributions; releases are versioned with changesets (`docs/RELEASING.md`), CI typechecks and builds every PR.
