# Reelsaw catalog

The starter pack behind Library → Browse → Reelsaw: sounds, icons and emoji stickers that every install may
redistribute. `sources.json` is the record of every item: where it comes from and under which license, so one can
be removed on a takedown.

| group | items | source | license |
|---|---|---|---|
| Icons (`lucide-*`) | 40 | [Lucide](https://lucide.dev) 0.544.0, raw SVGs | ISC |
| Emoji (`emoji-*`) | 16 | [Noto Emoji](https://github.com/googlefonts/noto-emoji) v2.047, SVGs | Apache 2.0 |
| Sounds (`sfx-*`) | 16 | Kenney [Interface Sounds](https://kenney.nl/assets/interface-sounds) and [UI Audio](https://kenney.nl/assets/ui-audio) | CC0 |

Sounds are named for what they stand in for (pop, ding, whoosh, record scratch, error buzz …). They are the CC0
equivalents; the copyrighted originals people mean by "viral sounds" are never bundled.

## What ships

`apps/server/assets/catalog/index.json` (the manifest) and `apps/server/assets/catalog/files/<id>.<ext>` (about
130 KB in all) are committed and copied into the image. The server serves the files at
`GET /media/catalog/<file>` and searches the manifest with Fuse. An online manifest at `CATALOG_URL`
(default `https://reelsaw.com/catalog/v1/index.json`) supersedes the bundled one when its `version` is higher; see
`apps/server/src/library/catalog.ts`.

Manifest item: `{ id, kind, mime, name, tags, durationSec?, width?, height?, bytes, sha256, url, license:
{ id, name, url }, attribution?, source: { url } }`. Imports verify the `sha256`.

Icons are tinted white (they are laid over video) and sized 512 px; sounds are converted to mono MP3 at 64 kbps.

## Rebuild

```bash
npx tsx catalog/build.ts     # from the repo root; needs the network, ffmpeg and ffprobe
```

The script downloads every source into a fresh temporary directory outside the repo (archives are untrusted data:
they are extracted with `unzip` and read, nothing in them runs), converts, hashes, and replaces
`apps/server/assets/catalog/` only when everything succeeded. Bump `version` in `sources.json` when the content
changes, and publish the same `index.json` and `files/` at `catalog/v1/` on reelsaw.com.

## Adding items

Only **CC0, ISC, MIT or Apache-2.0** items may be bundled; `build.ts` refuses any other license id. CC-BY items may
be listed in an online manifest (their attribution is stored and shown on import), never CC-BY-NC or ND, and never
anything whose terms forbid redistribution (Mixkit, Uppbeat, Pixabay music, the originals of viral sounds).
Pin sources to a release tag or an archive URL so a rebuild is reproducible, and add the item to `sources.json`
with its page URL.
