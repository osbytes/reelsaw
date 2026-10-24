# Library: one asset store, one layer list, a searchable catalog

Status: implemented Oct 2026 on `feat/library` (phases 0 to 3b; the reelsaw.com catalog publish and the `suggest_layers` tool are still open). Consolidates `bumper_assets` + `clips.overlays` + `clips.audio` into one
library and one per-clip layer list, and adds system assets (a curated Reelsaw catalog) plus remote
providers (Pexels, Pixabay, Freesound, Iconify, Openverse) that materialize as instance-shared rows when a clip uses them.
Builds on [bumpers.md](bumpers.md) and [editor-tracks.md](editor-tracks.md); nothing about the render
graph's shape changes.

## Job
When I dress a clip, I want one place that holds everything I can put on it (intro/outro videos,
logos, stickers, icons, b-roll, music, sound effects) and one timeline lane where I lay them over the
clip, so I stop thinking "is this a bumper, an overlay or music?" and start from "what do I want to
show or hear here?". And I want a starter set of common sounds and graphics I can search and drop in
without leaving the editor or finding files on my disk.

## Where we are

| piece | today | problem |
|---|---|---|
| store | `bumper_assets`, now `assets` (`kind` video / image / audio, immutable, soft delete, sha256 dedupe, URL import with SSRF guard, 30-day purge) | right model, wrong name and too narrow: no SVG, GIF, WebP; no tags or provenance; "Used by" loads every project and clip of the user (scale.md #11, #12) |
| clip refs | `clips.bumpers {intro, outro}`, `clips.overlays[]` (asset \| text), `clips.audio[]` | two lists with two id spaces, two lanes, two inspector cards, two MCP fields, two CLI commands, two copy/paste paths, for items that share id / start / end / level / fade |
| render | `overlayChain` (images repeat, videos play once), `musicMix` (loop, duck, fade), bumper concat | fine; needs loop for stickers, raster step for SVG |
| surfaces | `list_bumpers` … `set_clip_bumpers`, `update_clip { overlays, audio }`, `reelsaw bumpers`, `clip-overlays`, `clip-audio` | named after the first use case (consolidated: see Surfaces) |
| ffmpeg in the image | Debian 12 build has `librsvg`, `gif`, `webp` decoders (checked with `-decoders` / `-buildconf`) | nothing to install |

## Decisions

1. **One table, `assets`.** `bumper_assets` is renamed (migration 0039, hand-written rename lines:
   drizzle-kit can only record a rename through a terminal prompt); `asset_refs` sits
   beside it. Rows, ids and storage keys are kept (they are stored in full in
   `source_key` / `thumbnail_key`, so old `bumpers/<id>/…` objects stay where they are and new rows
   write `assets/<id>/…`; derived caches use `keys.assetDir(source_key)`).
   Columns added: `mime` (exact type: `image/svg+xml`, `image/gif`, `image/webp`, `audio/mpeg`…),
   `tags text[]`, `provenance jsonb` (`{ provider, externalId, variant, url,
   license: { id, name, url }, attribution, importedAt }`, null for uploads), `system boolean`
   (came from the Reelsaw catalog; the tile source line says Catalog). `kind` stays coarse
   (video / image / audio): it is what the renderer and the pickers branch on, and the only classification:
   there are no categories (a sound of 8 s or less gets one-shot layer defaults, longer is music; that is
   a default, not a label). Search is by name, tags and credit. Animated GIF / WebP are
   `kind: "video"` with the mime saying what they are.
2. **One per-clip list, `clips.layers`.** A discriminated union on `kind`:

   | kind | shared | own |
   |---|---|---|
   | `asset` | `id`, `start`, `end` (source seconds), `opacity` | `assetId`, `x`, `y`, `w`, `loop` (default true for gif/webp, false for video), `fit` (later: `pip` \| `fill` for b-roll) |
   | `text` | same | `text`, `size`, `color`, `box`, `font`, `x`, `y` |
   | `audio` | `id`, `start`, `end`, `volume`, `fade` | `assetId`, `offset`, `duck`, `loop` |

   The "various treatments" are the per-kind fields; the shared ones are what the lane, drag, trim,
   snap, copy / paste, undo and the context menu operate on, once. A sound effect is an `audio` layer
   with `loop: false, duck: false, fade: 0`; the SFX picker sets those defaults, the schema does not
   know about "sfx". Intro / outro stay in `clips.bumpers`: they are outside the clip's time range and
   are concatenated, not composited, so they are not layers (the timeline already draws them as blocks
   on the clip lane).
   Read path: `clipLayers(clip)` returns `layers` when set, otherwise `overlays` + `clipAudioList(audio)`
   mapped to the union (ids are already unique per list; prefix `a:` on audio ids when merging to keep
   them unique). Write path: `clips.update { layers }` writes `layers` and nulls the old columns in the
   same statement. `update_clip { overlays }` / `{ audio }` and `reelsaw clip-overlays` / `clip-audio` were
   aliases for one release and are dropped (changeset note); `publicClip` and `get_clip` return `layers` only. Migration: schema only (new column, no backfill); a reconciler batch backfills idle
   clips with cursors (scale.md #10 rule), and the read path makes the backfill optional.
3. **One lane, "Layers".** Replaces the Overlays and Music lanes. Packed rows as today (cap three →
   four), packing visual items first so sounds sit on the bottom rows; audio blocks get the waveform
   glyph and the music tint, text the `T` glyph, assets their thumbnail. One `+` menu: Image or video,
   Text, Sound, Browse library…. The inspector's Overlays tab becomes Layers with one card component
   that shows the fields for the selected kind. Preview: unchanged for visuals; audio plays inside its
   window as today.
4. **Asset refs table, maintained in the write transaction.** `asset_refs (asset_id, project_id,
   clip_id null, role)` rows are rewritten whenever `clips.layers`, `clips.bumpers` or project
   `introAssetId` / `outroAssetId` change (same unit of work, [PRINCIPLES](../PRINCIPLES.md)
   transactions rule). "Used by N", `asset_usage`, the purge's "still referenced" test and the credits
   list become indexed lookups instead of jsonb `->>` scans over every clip. Backfilled once by the
   migration's follow-up job.
   Built (`library/refs.ts`): a clip row exists only for what the clip names itself (its own
   `bumpers.intro` / `outro` strings and every asset / audio layer, legacy overlays + audio read as
   layers); a clip that inherits the project's intro has no row, the project row (`clip_id` null)
   stands for it, so "used by N clips" counts clips that name the asset and the project count covers
   inheritance. Clips a re-analyze replaced (`deleted_at`) keep their rows, so the purge never removes
   an asset a restorable clip still uses; `usage` and the counts skip them. The backfill walks projects
   by keyset (200 per batch, a time budget per tick, cursor in instance state) and the purge of removed
   assets does nothing until it has finished; `reelsaw library reindex` runs it to the end.
5. **Accepted types widen.** Images: png, jpg, **webp, gif, svg**. Video: mp4, mov, webm. Audio:
   mp3, m4a, aac, wav, ogg, flac. Probed by ffprobe, never by extension (as today), except an SVG,
   which ffprobe cannot size and is measured by resvg.
   - **Kind from the probe** (`assetKind(ext, probe)`): an animated GIF or WebP (more than one frame, or
     longer than 0.1 s) is `kind: video` with its own duration and no audio; a still GIF / WebP and every
     SVG is `kind: image`.
   - **SVG**: built, not as first written, with **`@resvg/resvg-wasm`** (MIT, resvg compiled to WebAssembly: no per-platform binary, so a multi-arch image built on one host works on both) instead of ffmpeg's librsvg: the dev Macs' ffmpeg has no librsvg and the
     Docker image's would differ in fonts and features, so one renderer everywhere. Rasterised once into
     `assets/<id>/raster.v1.1080.png` (`keys.assetRaster`, `ensureRaster`, idempotent like
     `ensureNormalised`) at 1080 px wide, the output frame's width. The compositor, the 270x480 thumbnail
     and an SVG used as an intro / outro image (through `ensureNormalised`) all use that PNG; the editor
     preview uses the SVG itself. Width and height come from resvg (width/height, else viewBox, else its
     content); a very tall drawing is capped at 8192 px high. Fonts: system fonts are not loaded, so
     `<text>` falls back to resvg's defaults; convert text to paths for exact type. An SVG that links to
     other files (`<image>`, `<use>`, `<feImage>` with an href that is not `#id` or `data:`) is refused
     at upload and at render, so an uploaded file cannot make the server open paths.
   - **GIF / animated WebP**: fed to the overlay chain with `loop` on by default (`layer.loop ?? isStickerAsset`:
     gif/webp mime, or a video under 8 s — Giphy stores GIFs as mp4, often with a silent AAC track, so duration
     is the split, not `hasAudio`; longer video is b-roll and defaults off; stills never loop). A looped input is always finite: GIF gets
     `-ignore_loop 0`, any looped input gets `-stream_loop N` with N = `ceil(window / assetDuration)`
     (never -1) and `-t window`, and the chain trims it to the window (`trim=duration`) before
     `setpts`, with `eof_action=repeat`; a video that plays once keeps `eof_action=pass`. `format=rgba`
     keeps the alpha. An animated GIF as an intro / outro normalises like any silent video.
   - **Known gap**: ffmpeg 7.1 cannot decode *animated* WebP (the probe reports width 0), so such a file
     is refused with "save it as a GIF or an MP4 instead"; a build that can decode it works unchanged.
6. **Providers import, never hotlink.** A remote result becomes a normal immutable library row via
   the existing `downloadAsUpload` → `createAsset` path (SSRF guard, size and duration limits, sha256
   dedupe), with `provenance` filled. **Imports are instance-shared rows**: one `assets` row with
   `user_id` null per `(provider, externalId, variant)` (variant = the Iconify colour; a unique partial
   index and a lock keyed on it make two accounts importing at once converge). Any signed-in account may
   use a shared row (media routes, project and clip pickers, renders); it never counts toward a
   storage quota, and it cannot be renamed or retagged ("Shared items keep the name they came with").
   The hourly sweep (`purgeBumperAssets`) hard
   deletes a shared row, its files and its cache once it is over 30 days old and no `asset_refs` row
   names it (`reelsaw storage sweep --dry-run` lists them). Renders only ever read the library. Pixabay forbids permanent
   hotlinking and requires a 24 h cache of search results; Pexels wants a visible "Photos provided by
   Pexels" link and photographer credit; both are satisfied by the Browse panel's footer and the
   stored attribution, not by anything at render time. Self-hosted instances with no keys still get
   the Reelsaw catalog and Openverse.

## System assets: the Reelsaw catalog

A static, versioned manifest plus files, published from `website/` (or a release asset) and
mirrored on a CDN: `catalog/v1/index.json` with `{ id, kind, mime, name, tags,
durationSec, width, height, bytes, sha256, url, license: { id, name, url }, attribution }` per item,
`ETag`/`max-age`. The server fetches and caches it (hourly, `reelsaw catalog refresh`), serves it at
`GET /api/catalog` and searches it with the same Fuse index the Library page already uses (a few
thousand entries is instant client-side; the MCP tool searches server-side with the same code).
Downloads verify the sha256. A **starter pack** (about 20 sounds, 60 icons / stickers, a handful of
transitions) ships inside the Docker image under `apps/server/assets/catalog/` so an offline install
has something on day one; the online manifest supersedes it by version.

Content rules, so the catalog can be redistributed by every install:
- **CC0 or permissive only** for anything bundled: Freesound CC0 sounds (filter
  `license:"Creative Commons 0"`), Kenney packs (CC0), Lucide and Tabler icons (ISC / MIT), Noto Emoji
  (Apache 2.0 / OFL) for emoji stickers. CC-BY items may be listed but are marked and their attribution
  is stored and shown; nothing CC-BY-NC or ND.
- **"Viral sounds" means the public-domain remakes, not the originals.** The TikTok / Instagram sounds
  people mean (songs, show clips, the actual Vine boom sample) are copyrighted and are not in any API
  we could ship. The catalog carries CC0 equivalents (boom, airhorn, record scratch, ding, whoosh,
  cartoon pop, crowd gasp, sad trombone, typing, cash register, notification chimes) found and vetted
  from Freesound and Kenney, named by the meme they stand in for and tagged for search. A `catalog/`
  build script (`pnpm catalog:build`) pulls sources by id, normalises audio to the music chain's
  −20 LUFS, trims silence, writes the manifest, and records every source url and license so an item
  can be removed on a takedown.

## Remote providers

One interface in `apps/server/src/library/providers/`:
`search(q, { kind, cursor }) → { items: ProviderItem[], nextCursor, attributionLine }` and
`resolve(externalId) → { url, mime, name, license, attribution }` feeding `downloadAsUpload`.
Keys are runtime settings (`RUNTIME_SETTINGS`, secret, optional): an admin pastes them under
Settings → System; a provider with no key is hidden. Search responses are cached (`library_search_cache`
or the pg-boss-free `cache` table used elsewhere) for 24 h per `(provider, q, kind, page)`, which
Pixabay requires and which keeps us inside everyone's hourly limits; rate-limit headers are logged and
a 429 hides the provider for the reset window with a sentence in the panel.

| provider | gives | key | limits (as documented Oct 2026) | license posture | notes |
|---|---|---|---|---|---|
| **Reelsaw catalog** | sfx, icons, stickers, transitions | none | none (static files) | CC0 / permissive, vetted | listed on an empty search; works offline with the starter pack |
| **Pexels** | photos, **portrait videos** (b-roll) | free, `PEXELS_API_KEY` | 200 req/h, 20k/month; more on request | Pexels License: free commercial use; show a Pexels link; no standalone redistribution, no competing service | `videos/search?orientation=portrait&size=medium` fits 9:16; store photographer + photo url |
| **Pixabay** | photos, illustrations, **vectors**, videos | free, `PIXABAY_API_KEY` | 100 req/min; search results must be cached 24 h | Pixabay Content License: no attribution needed, show source in results; must download, never hotlink | API has no music / sfx; full-resolution URLs need approval, the standard `largeImageURL` / video sizes are enough |
| **Freesound** | sound effects, loops | free, `FREESOUND_API_KEY` | per-app quota | per-sound CC0 / CC-BY / CC-BY-NC; filter CC0 by default, allow CC-BY with attribution, never NC | original downloads need per-user OAuth2; import the HQ preview (`previews.preview-hq-mp3`, 128 kbps), fine under speech |
| **Iconify** | 200k+ icons, search, SVG with colour / size | none (public api.iconify.design) or self-hosted | public API fair use; self-host when it matters | per icon set; allowlist permissive sets (lucide, tabler, mdi, ph, heroicons…) | fetch `…/icon.svg?color=%23ffffff&width=512`; imported as it comes (white by default); colour is a use-side concern (a tint on the layer, later), not a library setting |
| **Openverse** | CC images and audio (Freesound, Jamendo, Wikimedia) | none for low rates; free registered key raises limits (figures unverified; sources conflict) | see docs before shipping | CC with license fields per result | the keyless fallback for images and sound; audio URLs may point at originals that need auth, so test per source before enabling |
| **Giphy** | GIF search, stickers (transparent), mp4 renditions | per instance, `GIPHY_API_KEY` | beta key: 100 calls/h, enough for a self-hosted install; production needs an application and a pricing talk | Giphy terms: show a "Powered by GIPHY" mark in the Browse panel; content is Giphy's to license, store the source url | import the `original.mp4` rendition for opaque GIFs (smaller, same loop), the `.gif` for stickers so the alpha survives; phase 3b, behind its key |
| **Klipy** | GIF search, Tenor-compatible API | per instance, `KLIPY_API_KEY` | free, ad-supported tier (terms, attribution and ad obligations unverified) | unverified | Tenor's successor for most apps after Tenor's API shut down 30 June 2026; verify the developer terms before enabling; phase 3b |
| Tenor | — | — | API shut down 30 June 2026 | — | gone |
| Jamendo, Mixkit, Uppbeat, Pixabay music | music | Jamendo has an API (35k req/month, non-commercial apps, CC-BY/NC/SA mixes, no CC0); the others have no API and licenses that forbid redistribution | | | **not in v1**; music stays user-uploaded, the catalog may carry CC0 loops later |

## What the user sees

- **Library page** (`/library`): the title and one short line. Row 1 is the search
  box ("Search uploads, the catalog and providers…") and an **Upload** button (files can also be
  dropped anywhere on the page); row 2 is kind chips (All / Video / Image / Audio). Upload progress is a compact row
  under the chips, only while there are jobs. Below is **one grid** of identical tiles (`AssetTile`),
  no section headers: your uploads first (fuzzy search over name and tags), then catalog results
  (everything on an empty search), then provider results
  (only with a query; each provider's query starts when its first slot scrolls into view). Skeleton
  tiles trail the grid while a source loads; "Nothing matches" shows only once every active source came
  back empty; one "Show more" loads the next page of the first source that has one. Attribution lines
  (Pexels, Pixabay, Giphy) are one muted footer under the grid. A tile shows the thumbnail or preview,
  a one-line name and one muted meta line `kind · length or size · source · license` (source is
  Yours, Catalog or the provider; audio and video show their length, an image shows its pixel size and
  never a length, since an image's stored duration is only how long it shows as an intro / outro). Uploads
  that are in use carry a small muted badge at the thumbnail's bottom-left ("2 clips" or
  "1 project"). Catalog and provider results have no add control on this page (they are imported when a
  clip uses them). Clicking an upload opens the viewer, which keeps rename, tags,
  usage, remove and "Used by N". Deep links: `#asset=<id>`,
  `?kind=&q=`.
- **Editor**: the Layers lane; `+` -> Image or video... / Text / Sound.... Image or video ("Add to
  clip") and Sound ("Add a sound") open the same single-grid finder in a dialog
  (`AssetFinderDialog`, kinds preset, kind chips hidden when limited to one kind, no Upload button).
  When limited to kinds, only providers that serve those kinds are queried (no Iconify in
  the sound dialog) and results of other kinds are dropped. Every tile has one primary "Add to clip"
  button on the thumbnail's top-right corner (clicking the thumbnail does the same): on an
  upload it adds the layer at the playhead the dialog was opened at; on a catalog / provider
  result it materializes the instance-shared file first ("Adding..." on the tile), then adds the layer. Overlay
  stacking rules in [UI.md](../UI.md).
- **Project settings**: intro / outro pickers unchanged, filtered to video / image.

## Surfaces

| action | tRPC | MCP | CLI |
|---|---|---|---|
| list own library | `library.list` | `search_assets { source: "library" }` (empty `q` = everything) | `reelsaw library list [--kind] [--q]` |
| resolve ids (own, shared, removed-in-use) | `library.get { ids }` | `get_clip` / `get_project` already resolve names | |
| search library, catalog, providers | `library.search { q, source?: "library" \| "catalog" \| <providerId>, kind?, cursor?, limit?, license? }`, `library.providers` | `search_assets` | `reelsaw library search <q> [--source] [--kind] [--license]` |
| add (upload, URL, catalog / provider hit) | `library.add { uploadId \| url \| provider + externalId, name?, tags?, imageSeconds?, setDefault?, color? }` (exactly one source) | `add_asset` | `reelsaw library add <file\|url\|provider:externalId>` |
| rename, tag, remove, restore, usage | `library.update / remove / restore / usage` | `update_asset`, `remove_asset`, `restore_asset`, `asset_usage` | `reelsaw library rename\|update\|remove\|restore\|usage` |
| default intro / outro | `library.setDefault` | `set_default_bumper` | `reelsaw library default <intro\|outro> <id\|none>` |
| rebuild the refs table | none (reconciler backfill, bounded ticks) | none | `reelsaw library reindex` |
| clip layers | `clips.update { layers }` | `update_clip { layers }`, `get_clip` | `reelsaw clip-layers <p> <c> --set '<json>' \| --add <assetId> … \| --add-text … \| --add-sound <assetId> … \| --remove <id> \| --clear [--rerender]` |
| catalog ops | admin: `catalog.refresh`, `catalog.status` | `get_instance_settings` shows catalog version | `reelsaw catalog refresh\|status` |

`library.list` is this account's uploads. Catalog and provider files are instance-shared (`user_id` null)
and stay as long as a clip or project names them. "Bumper" stays the name of the intro / outro slot (`set_default_bumper`,
`set_project_bumpers`, `set_clip_bumpers`, `project-bumpers`, `clip-bumpers`).

All surfaces call `apps/server/src/library/service.ts` (renamed from `bumpers/service.ts`), per the
surfaces rule.

## Render changes (small)

- `overlayChain`: `loop` adds `-ignore_loop 0` for gif inputs, a finite `-stream_loop`, a `trim` to the
  window and `eof_action=repeat` (see decision 5); svg assets are replaced by their `raster.v1.1080.png`
  before the inputs are built; failure rule unchanged (skip with
  `clip.layer_skipped`, retry without layers).
- `musicMix`: reads `audio` layers; nothing else changes.
- Diagnostics record layer ids and asset ids used, as today for overlays and music.

## Phases

| phase | appetite | ships |
|---|---|---|
| 0. Widen the store | 1 day | table rename + `mime`, `tags`, `provenance`, `system`; svg / gif / webp accepted; svg raster cache; gif loop; `library.*` procedures; `search_assets` / `add_asset` MCP; `reelsaw library` |
| 1. Layers | 3 days | `clipLayerSchema`, `clips.layers`, read-path merge, write-path null-out, `asset_refs` + backfill job, one lane, one inspector card, `+ Sound`, spec update, eval fixture renders with a gif sticker, an svg logo and a sound effect |
| 2. Library page | 2 days | chips, search, license badges, credits in export and `get_project` |
| 3. Catalog + providers | 3 days | provider interface, 24 h search cache, runtime key settings, Browse tab + dialog, Reelsaw manifest + `catalog:build` + starter pack in the image, Pexels, Freesound, Iconify; Openverse and Pixabay behind a flag until their limits are verified in practice |
| 3b. GIF search | 1 day | Giphy and Klipy providers (bring your own key), sticker vs GIF import rule, attribution mark; a GIF layer previews with `<img>` (browsers loop GIFs natively) and renders through the looped overlay input |
| later | — | `suggest_layers` (LLM picks b-roll / sfx moments from the transcript and searches the catalog; RESEARCH.md #12 becomes cheap once search exists), b-roll `fit: fill` as a layout piece, CC0 music loops in the catalog |

## Risks and open questions

- **Licensing drift**: provider terms change (Tenor died in 2026; Pixabay left CC0 earlier). The
  provider table above is the record of what was checked and when; re-check before each release and
  keep every provider behind its own key and a kill flag.
- **Openverse audio**: results point at origin files; some origins need auth or rate-limit downloads.
  Verify Freesound and Jamendo items import end-to-end before enabling, otherwise ship images only.
- **Catalog takedowns**: the manifest is versioned and items carry their source; removing an item from
  the manifest does not delete imported copies (they are the user's library rows now). Document it.
- **Layer migration**: two code paths for one release. The read-path merge is the only place that knows
  about the old columns; it has its own tests, and the backfill job removes the second path over time.
- **Lane density**: four packed rows of mixed kinds may feel busy on a phone. Measure at 390 px; the
  fallback is a per-kind filter chip on the lane label, not a second lane.
