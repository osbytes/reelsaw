# Media storage

## Job
When I run Reelsaw for a while, I want disk (and S3) use to track what I actually keep, so that
the data disk does not fill up and a bigger store does not cost more than the videos are worth.

## Appetite
Phase 1 is about half a day. Phase 2 is about 2 days and only if the numbers below still hold.

## Measured today (local stack, read-only, 2026-10-17)
10 projects (9 YouTube, 1 upload), 62 clips, all rendered. `STORAGE_DRIVER=local`, one ext4 volume
for `/data`, so scratch and store are hardlinked.

| What | Files | Bytes | Share of unique bytes |
|---|---|---|---|
| Unique bytes under `/data` (projects + storage) | - | 2.14 GB | 100% |
| Sources (`projects/<id>/source.*`) | 10 | 1.43 GB | 67% |
| Clips, current generation (mp4) | 57 + 5 | 0.70 GB | 33% |
| Thumbnails (jpg) | 62 | 2.6 MB | 0.1% |
| Upload (`uploads/<id>.mp4`), same inode as its source | 1 | 14 MB | 0% (hardlink) |
| Stale render generations, scratch only (see 2.1) | 10 mp4 | 116 MB | 5.4% |
| Duplicate sources (same video, 2 to 3 projects) | 3 | 384 MB | 18% |
| Logs (`/data/logs`) | - | 60 MB | n/a (outside media) |
| `/data/tmp` leftovers (`hear-*.mp4`) | 2 | 11 MB | n/a |

Duplicate sources, checked by sha256: YouTube `nCpr5SBD8CQ` ingested 3 times (3 x 144 MB, one hash),
`2RWHmPYsAvs` twice (2 x 95.7 MB, one hash). Only 6 distinct URLs across 9 URL projects.
Stale clips: 10 files at generation > 0 sit in `projects/*/clips/` with link count 1 (no store copy);
the biggest are 23 to 24 MB each. The volume holds other data too (47 of 59 GB used), so the
2.14 GB is Reelsaw's share only.

## 1. Current layout

| Class | Key / path | Where | Size | Lifetime | Deleted by |
|---|---|---|---|---|---|
| Upload | `uploads/<id><ext>` | store; scratch `DATA_DIR/uploads` | 10 MB to 2 GB | forever | scratch: `finally` in `http.ts:144`; store: never (not even by `deleteProject`) |
| Source | `projects/<id>/source<ext>` | store + scratch copy (hardlink) | 10 MB to 2 GB | until project delete or `SOURCE_RETENTION_DAYS` (default 0 = never) | `deleteProject` (`accounts.ts:29`), `retention.ts:27` (store only, scratch copy stays) |
| Audio, chunks | `projects/<id>/audio.mp3`, `chunks/` | scratch | 10 to 100 MB | until project done | `cleanupWorkdir` (`pipeline/common.ts:114`), when `CLEANUP_WORKDIR` |
| Subtitle files, temp renders | `clips/*.ass`, `*.tmp.mp4` | scratch | KB to MB | until project done | `cleanupWorkdir` |
| Clip render gen N | `projects/<id>/clips/<clip>.<N>.mp4` (gen 0 has no suffix) | scratch + store (hardlink) | 3 to 25 MB | current gen: until project delete or `CLIP_RETENTION_DAYS` (default 0) | store: `requestRender` (`lifecycle.ts:29`), `render.ts:476`; scratch: nobody |
| Thumbnail | same name, `.jpg` | scratch + store | 25 KB | as its clip | same as clip |
| Cut preview | not a file | n/a | n/a | n/a | Previews are rendered on demand; no persisted class found (grep for preview keys in `storage` is empty). Cut ranges live in `clips.diagnostics`. |
| ASR cache | `DATA_DIR/cache/asr` | scratch | under 1 MB | pruned at boot | boot pruning (config.ts) |
| Logs | `DATA_DIR/logs` | scratch | 60 MB, 58 MB on busiest day | rotated | log rotation only |
| Export / hear temp | `DATA_DIR/tmp/export-*`, `hear-*.mp4` | scratch | MB | request | `export.ts:317` (hear files in `cli.ts:281` never) |

Notes:
- `Paths.storage` is `DATA_DIR/storage`; `STORAGE_LOCAL_DIR` overrides it (`config.ts:166-184`,
  `storage/index.ts:213`). Same filesystem means `fsp.link` works; a different volume silently
  falls back to `copyFile` (`storage/index.ts:34-40`), which doubles every file.
- With S3, render.ts deletes the scratch clip right after upload (`render.ts:454`), but the source
  stays in scratch (`ingest.ts:82`, `source.cli`), so a worker keeps one full source per project.
- `/media` streams the local file or redirects to a presigned URL (`media.ts`, `Storage.resolve`).

## 2. Where space is lost, ranked

| # | Loss | Evidence | Measured | Grows with |
|---|---|---|---|---|
| 1 | Same source stored once per project | key is `projects/<projectId>/source<ext>` (`storage/index.ts:keys.source`); `ingest.ts:80-82` always puts a new object; no lookup by URL or hash | 384 MB (18% of all, 27% of sources) | repeat ingests, re-imports, several users clipping popular videos |
| 2 | Sources never expire by default | `SOURCE_RETENTION_DAYS` default 0 (`config.ts:109`); a source is 67% of bytes but only needed to re-render | 1.43 GB held for 10 finished projects | projects |
| 3 | Stale render generations left in scratch | `requestRender` deletes only the store key (`lifecycle.ts:29`); `render.ts:476` same; scratch file stays. Works only while the hardlink exists, so each re-render leaves one orphan inode | 116 MB, 10 files (5.4%) | re-renders; ~23 MB per re-render of a long clip |
| 4 | Source copy on S3 workers and after retention | `retention.ts:27` deletes the store key but not `projects/<id>/source.*` in scratch; with the local driver the hardlink keeps the inode alive, so expiry frees nothing | 0 today (retention off); would be 100% of sources if turned on | retention use |
| 5 | Upload object outlives its use | `keys.upload` is written at `http.ts:138`, never removed; `deleteProject` deletes only `projects/<id>` (`accounts.ts:30`). On S3 the bytes exist twice (upload + source); on local they share an inode | 14 MB local; 2x on S3 | uploads |
| 6 | Scratch + store on separate volumes | `linkOrCopy` falls back to copy (`storage/index.ts:34-40`) | 0 here; up to 2x total if the compose volumes are split | config |
| 7 | Misc: `tmp/hear-*`, logs | `cli.ts:281` | 11 MB + 60 MB | slowly |

Thumbnails and audio extracts are not worth any work.

## 3. Options

### (a) Cheap cleanups (no schema change, no key change)
| Change | Saves | Risk |
|---|---|---|
| After `requestRender`/render commit, also `fs.rm` the superseded scratch file in the same `afterCommit` as the store delete | the 116 MB class (5%), unbounded growth with re-renders | low; scratch is a cache, `ensureLocal` restores from store |
| `retention.ts` also removes the scratch `source.*` (and `source.cli`) after commit | makes retention actually free local disk | low |
| Delete the upload object once its project has `sourceKey` (or when the project is deleted) in the ingest hand-off, `afterCommit` | 1x source on S3 per upload | low; the `uploads` row must go in the same transaction, or `ingest` retry loses its input (`ingest.ts:77`) |
| A reconciler sweep: list scratch `projects/*/clips/*.N.mp4` not referenced by `clips.output_key` and older than 1 hour; delete | catches crashes between commit and delete | low; compare by key, skip files newer than the grace period |
| Delete `tmp/hear-*` after use; cap log directory | 70 MB | trivial |
| Turn on `SOURCE_RETENTION_DAYS` (e.g. 30) as a documented default for hosted | most of the 1.43 GB for old projects | user must re-fetch on retry (already supported) |

Total expected: about 120 MB now, and it stops the leak. Retention default changes the biggest lever.

### (b) Source dedupe with a refcount table
Idea: one stored source per distinct video, shared by projects.

Key choice:
| Key | Cost | Catches | Misses |
|---|---|---|---|
| YouTube id + chosen format (from `sourceMeta`) | free, known before download, skips the download too | repeat YouTube ingests (all 384 MB here) | uploads, other sites, different format picks |
| sha256 of the file | one read pass (~1 s per 500 MB, after download) | any identical bytes | saves storage only, not the download |
| Both: look up id+format first, hash as the fallback | small | most | - |

Schema (one migration, `drizzle-kit generate --name source_objects`):
```
source_objects(hash text pk, key text unique, bytes bigint, ref_count int, created_at)
projects.source_hash text null   -- replaces nothing; sourceKey stays as the resolved key
```
`sourceKey` would be `sources/<hash><ext>` for new projects; old rows keep `projects/<id>/source.*`.

How it fits the principles:
- Ingest: download to scratch, hash, then in one transaction `insert ... on conflict do update set
  ref_count = ref_count + 1`, set `projects.source_key/source_hash`. The file is put to the store
  before that transaction under the content name (a versioned name), so a rollback leaves an
  orphan object, not a row without a file; the orphan sweep removes it. Idempotent: a retry
  hashes the same bytes and hits the same row.
- `deleteProject`: in the same transaction decrement the count; `afterCommit` deletes the object
  only when this transaction saw the count reach 0 (lock the row `for update`). It must stop
  deleting `projects/<id>` blindly only for the source; clips still live under the project prefix.
- Retention expiry (`retention.ts:27`): `sourceExpiredAt` stays per project. Expiry decrements the
  count the same way. A project whose source was shared keeps working because the object is still
  there; `sourceExpiredAt` on that project should then be left null until the object is really
  gone, or the UI would say "expired" for a file that is present. Simplest: expiry is per object
  (`source_objects.expired_at`), and projects read it.
- S3: same logic; the object key is the hash, so no copy is needed for a second project, and
  `putFile` can be skipped after a `HeadObject`. Concurrent first-ingests of the same video race
  on the insert; both upload the same bytes to the same key, harmless (idempotent put).
- Local hardlinks: scratch `source.*` stays a per-project link to the shared inode; a delete of one
  link frees nothing until the last link goes, which matches the refcount.
- Migration of existing rows: optional backfill job hashes old sources and re-points rows; or do
  nothing and let only new ingests dedupe. Backfill saves the 384 MB here, but needs the
  put-then-repoint-then-delete order per project.

Benefit: 18% here, more on a hosted instance where users clip the same popular videos. Cost: a
table, a refcount that can drift (needs a repair sweep: recount from `projects.source_hash`),
more branches in delete and retention, an extra delete race to test.

### (c) Full content-addressed store (clips, thumbnails too)
| Item | Dedupe gain | Why not |
|---|---|---|
| Clips | near zero: each render is a fresh ffmpeg encode with captions, crops and cuts; two renders of one clip are not byte-identical, even with the same inputs | no reuse |
| Re-render of an unchanged clip | would only help if the output is deterministic; the 3 matching-size generations (`c2986c5d...1`, `.2`: 3,146,371 bytes) suggest a near-no-op rerender, but equal size is not equal hash | needs a hash check and still pays the encode |
| Thumbnails | 0.1% of bytes | none |

Changes it would need: all five `keys.*` helpers, `outputKey`/`thumbnailKey` semantics (today a
versioned name per generation is what makes stale renders safe, `PRINCIPLES.md` "work carries a
version"), media routes (`/media/clips/:projectId/:file` maps a project and clip to a file), export
and issue-report bundling (`export.ts`, `report/bundle.ts`, `report/import.ts:336-349`), a refcount
for every object, and a migration of all `clips` rows. Verdict: not worth it. The only win is
sources, which (b) covers.

## 4. Recommendation and plan

Do (a) now, measure, then do (b) with the YouTube id key only if sources are still the main cost.
Skip (c).

| Phase | What | Measure first / after | Done when |
|---|---|---|---|
| 1 | The scratch deletes and the orphan sweep from (a); `tmp/hear-*` cleanup; document `SOURCE_RETENTION_DAYS` | Add one CLI line, `reelsaw status` -> "scratch-only bytes, duplicate-source bytes, expired-but-present bytes". Baseline today: 116 MB / 384 MB / 0 | scratch-only bytes ~0 after a re-render test; retention frees local disk |
| 2 | Source dedupe, YouTube id + format first (`source_objects`, `source_hash`), `deleteProject` and retention decrement, repair sweep | Duplicate-source bytes on the hosted instance (real traffic) vs. refcount code size; skip if under ~10% of stored bytes | New ingest of a known URL does not download or store again; delete of the last project frees the object; evals and a delete/re-render race test pass |
| 3 (optional) | sha256 as the fallback key for uploads; backfill job for old projects | Hit rate of the hash fallback | Hit rate above ~5% |

What not to do:
- Do not change the clip key scheme or content-address clips and thumbnails.
- Do not delete a store object before the transaction that drops its last reference has committed
  (`afterCommit` only), and never overwrite a key that a live row points at.
- Do not move source expiry into the refcount without keeping `sourceExpiredAt` honest for shared
  sources (a project must never read "expired" while its file is there, or the reverse).
- Do not add a second volume for scratch without a one-line note: `linkOrCopy` then copies and the
  footprint doubles (loss 6).
- Do not trust a size match as equal content.

## Open questions
- Is the hosted instance expected to see the same video from several users often? That decides
  phase 2; one number from production (distinct `source_meta->>'webpage_url'` versus project
  count) answers it.
- Should the default `SOURCE_RETENTION_DAYS` change for self-hosters, or only for hosted?
