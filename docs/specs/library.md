# Library: one asset store, one layer list, a searchable catalog

Status: proposal (Oct 2026). Consolidates `bumper_assets` + `clips.overlays` + `clips.audio` into one
library and one per-clip layer list, and adds system assets (a curated Reelsaw catalog) plus remote
providers (Pexels, Pixabay, Freesound, Iconify, Openverse) that import into the library.
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
| store | `bumper_assets` (`kind` video / image / audio, immutable, soft delete, sha256 dedupe, URL import with SSRF guard, 30-day purge) | right model, wrong name and too narrow: no SVG, GIF, WebP; no tags, category or provenance; "Used by" loads every project and clip of the user (scale.md #11, #12) |
| clip refs | `clips.bumpers {intro, outro}`, `clips.overlays[]` (asset \| text), `clips.audio[]` | two lists with two id spaces, two lanes, two inspector cards, two MCP fields, two CLI commands, two copy/paste paths, for items that share id / start / end / level / fade |
| render | `overlayChain` (images repeat, videos play once), `musicMix` (loop, duck, fade), bumper concat | fine; needs loop for stickers, raster step for SVG |
| surfaces | `list_bumpers` … `set_clip_bumpers`, `update_clip { overlays, audio }`, `reelsaw bumpers`, `clip-overlays`, `clip-audio` | named after the first use case |
| ffmpeg in the image | Debian 12 build has `librsvg`, `gif`, `webp` decoders (checked with `-decoders` / `-buildconf`) | nothing to install |

## Decisions

1. **One table, `libraryAssets`.** The Drizzle export and every identifier are renamed; the SQL table
   keeps the name `bumper_assets` (drizzle-kit can only record a rename through a terminal prompt, and
   nothing reads the name). Rows, ids and storage keys are kept (they are stored in full in
   `source_key` / `thumbnail_key`, so old `bumpers/<id>/…` objects stay where they are and new rows
   write `assets/<id>/…`; derived caches use `keys.assetDir(source_key)`).
   Columns added: `mime` (exact type: `image/svg+xml`, `image/gif`, `image/webp`, `audio/mpeg`…),
   `category` (`intro`, `outro`, `logo`, `sticker`, `icon`, `broll`, `music`, `sfx`; a hint for pickers,
   never enforced by the renderer), `tags text[]`, `provenance jsonb` (`{ provider, externalId, url,
   license: { id, name, url }, attribution, importedAt }`, null for uploads), `system boolean`
   (came from the Reelsaw catalog; shown with a badge, same row otherwise). `kind` stays coarse
   (video / image / audio): it is what the renderer and the pickers branch on. Animated GIF / WebP are
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
   same statement. `update_clip { overlays }` / `{ audio }` and `reelsaw clip-overlays` / `clip-audio`
   keep working for one release as aliases that read-modify-write `layers`, then are dropped with a
   changeset note. Migration: schema only (new column, no backfill); a reconciler batch backfills idle
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
   transactions rule). "Used by N", `bumper_usage`, the purge's "still referenced" test and the credits
   list become indexed lookups instead of jsonb `->>` scans over every clip. Backfilled once by the
   migration's follow-up job.
5. **Accepted types widen.** Images: png, jpg, **webp, gif, svg**. Video: mp4, mov, webm. Audio:
   mp3, m4a, aac, wav, ogg, flac. Probed by ffprobe, never by extension (as today).
   - **SVG**: rasterised once into `assets/<id>/norm.v1.png` at 1080 px wide (`ffmpeg -i x.svg`
     with the librsvg decoder's `-width 1080`), the same "normalise once, cache by id" rule as bumpers
     (`v1` tied to the canvas). The compositor and the thumbnail use the PNG; the editor preview uses
     the SVG itself. Fonts inside an SVG are whatever fontconfig finds in the image; the upload warns
     when the SVG references `<text>` with a family the image lacks.
   - **GIF / animated WebP**: fed to the overlay chain as they are, with `-ignore_loop 0` so they
     repeat, and `eof_action=repeat`; `format=rgba` already keeps the alpha. Static WebP is an image.
6. **Providers import, never hotlink.** A remote result becomes a normal immutable library row via
   the existing `downloadAsUpload` → `create` path (SSRF guard, size and duration limits, sha256
   dedupe), with `provenance` filled. Renders only ever read the library. Pixabay forbids permanent
   hotlinking and requires a 24 h cache of search results; Pexels wants a visible "Photos provided by
   Pexels" link and photographer credit; both are satisfied by the Browse panel's footer and the
   stored attribution, not by anything at render time. Self-hosted instances with no keys still get
   the Reelsaw catalog and Openverse.

## System assets: the Reelsaw catalog

A static, versioned manifest plus files, published from `website/` (or a release asset) and
mirrored on a CDN: `catalog/v1/index.json` with `{ id, kind, mime, name, tags, category,
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
| **Reelsaw catalog** | sfx, icons, stickers, transitions | none | none (static files) | CC0 / permissive, vetted | default tab; works offline with the starter pack |
| **Pexels** | photos, **portrait videos** (b-roll) | free, `PEXELS_API_KEY` | 200 req/h, 20k/month; more on request | Pexels License: free commercial use; show a Pexels link; no standalone redistribution, no competing service | `videos/search?orientation=portrait&size=medium` fits 9:16; store photographer + photo url |
| **Pixabay** | photos, illustrations, **vectors**, videos | free, `PIXABAY_API_KEY` | 100 req/min; search results must be cached 24 h | Pixabay Content License: no attribution needed, show source in results; must download, never hotlink | API has no music / sfx; full-resolution URLs need approval, the standard `largeImageURL` / video sizes are enough |
| **Freesound** | sound effects, loops | free, `FREESOUND_API_KEY` | per-app quota | per-sound CC0 / CC-BY / CC-BY-NC; filter CC0 by default, allow CC-BY with attribution, never NC | original downloads need per-user OAuth2; import the HQ preview (`previews.preview-hq-mp3`, 128 kbps), fine under speech |
| **Iconify** | 200k+ icons, search, SVG with colour / size | none (public api.iconify.design) or self-hosted | public API fair use; self-host when it matters | per icon set; allowlist permissive sets (lucide, tabler, mdi, ph, heroicons…) | fetch `…/icon.svg?color=%23ffffff&width=512`; a colour picker in the import dialog |
| **Openverse** | CC images and audio (Freesound, Jamendo, Wikimedia) | none for low rates; free registered key raises limits (figures unverified; sources conflict) | see docs before shipping | CC with license fields per result | the keyless fallback for images and sound; audio URLs may point at originals that need auth, so test per source before enabling |
| **Giphy** | GIF search, stickers (transparent), mp4 renditions | per instance, `GIPHY_API_KEY` | beta key: 100 calls/h, enough for a self-hosted install; production needs an application and a pricing talk | Giphy terms: show a "Powered by GIPHY" mark in the Browse panel; content is Giphy's to license, store the source url | import the `original.mp4` rendition for opaque GIFs (smaller, same loop), the `.gif` for stickers so the alpha survives; phase 3b, behind its key |
| **Klipy** | GIF search, Tenor-compatible API | per instance, `KLIPY_API_KEY` | free, ad-supported tier (terms, attribution and ad obligations unverified) | unverified | Tenor's successor for most apps after Tenor's API shut down 30 June 2026; verify the developer terms before enabling; phase 3b |
| Tenor | — | — | API shut down 30 June 2026 | — | gone |
| Jamendo, Mixkit, Uppbeat, Pixabay music | music | Jamendo has an API (35k req/month, non-commercial apps, CC-BY/NC/SA mixes, no CC0); the others have no API and licenses that forbid redistribution | | | **not in v1**; music stays user-uploaded, the catalog may carry CC0 loops later |

## What the user sees

- **Library page** (`/library`): one grid, chips All / Video / Image / Audio and category chips
  (Intros & outros, Logos, Stickers & icons, B-roll, Music, Sounds), a search box (name, tags), the
  upload drop zone (every accepted type) and "Add from URL". Cards show kind, length / size, the
  license badge for imported items (`CC0 · Freesound · author`), "Used by N" from `asset_refs`, rename,
  remove / restore. A **Browse** tab holds the catalog and the enabled providers with the attribution
  footer; "Add to library" imports with progress, duplicates resolve to the existing row.
- **Editor**: the Layers lane; `+` → Image or video / Text / Sound / Browse…; the picker is the same
  combobox as today filtered by kind and category, with a Browse row at the bottom that opens the same
  Browse panel in a dialog (overlay stacking rules in [UI.md](../UI.md)); an imported item lands on the
  lane at the playhead.
- **Project settings**: intro / outro pickers unchanged, filtered to video / image.
- **Credits**: `get_project` / project export include a credits list built from `provenance` for
  every CC-BY item used by its clips; the export dialog offers "Copy credits".

## Surfaces

| action | tRPC | MCP | CLI |
|---|---|---|---|
| list / search own library | `library.list { kind?, category?, q?, cursor }` | `list_assets` (alias `list_bumpers` for one release) | `reelsaw library list [--kind] [--q]` |
| upload / import by URL | `library.create { uploadId \| url, name?, category?, tags? }` | `add_asset` (alias `add_bumper`) | `reelsaw library add <file\|url>` |
| rename, tag, remove, restore, usage | `library.update / delete / restore / usage` | `update_asset`, `remove_asset`, `restore_asset`, `asset_usage` | `reelsaw library rename\|remove\|restore\|usage` |
| search catalog and providers | `library.search { provider, q, kind?, cursor? }` | `search_library { provider?, q, kind? }` | `reelsaw library search <q> [--provider] [--kind]` |
| import a result | `library.import { provider, externalId, color? }` | `import_asset` | `reelsaw library import <provider> <id>` |
| clip layers | `clips.update { layers }` | `update_clip { layers }`, `get_clip` | `reelsaw clip-layers <p> <c> --set '<json>' \| --add <assetId> … \| --add-text … \| --add-sound <assetId> … \| --remove <id> \| --clear [--rerender]` |
| catalog ops | admin: `catalog.refresh`, `catalog.status` | `get_instance_settings` shows catalog version | `reelsaw catalog refresh\|status` |

All surfaces call `apps/server/src/library/service.ts` (renamed from `bumpers/service.ts`), per the
surfaces rule.

## Render changes (small)

- `overlayChain`: `loop` adds `-ignore_loop 0` for gif inputs and `eof_action=repeat`; svg assets are
  replaced by their `norm.v1.png` before the inputs are built; failure rule unchanged (skip with
  `clip.layer_skipped`, retry without layers).
- `musicMix`: reads `audio` layers; nothing else changes.
- Diagnostics record layer ids and asset ids used, as today for overlays and music.

## Phases

| phase | appetite | ships |
|---|---|---|
| 0. Widen the store | 1 day | table rename + `mime`, `category`, `tags`, `provenance`, `system`; svg / gif / webp accepted; svg raster cache; gif loop; `library.*` procedures with the old names as aliases; `list_assets` / `add_asset` MCP (+ aliases); `reelsaw library` |
| 1. Layers | 3 days | `clipLayerSchema`, `clips.layers`, read-path merge, write-path null-out, `asset_refs` + backfill job, one lane, one inspector card, `+ Sound`, MCP / CLI aliases, spec update, eval fixture renders with a gif sticker, an svg logo and a sound effect |
| 2. Library page | 2 days | chips, search, categories, license badges, credits in export and `get_project` |
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
