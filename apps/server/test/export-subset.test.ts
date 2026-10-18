import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClipIds, pickExportClips, EXPORT_CLIP_IDS_MAX } from "../src/export.js";
import type { Clip } from "../src/db/schema.js";

const clip = (id: string, status: string, outputKey: string | null) => ({ id, status, outputKey }) as unknown as Clip;

test("parseClipIds: empty means all, trims, de-duplicates, rejects junk", () => {
  assert.deepEqual(parseClipIds(undefined), []);
  assert.deepEqual(parseClipIds(""), []);
  assert.deepEqual(parseClipIds(" a1, b-2 ,a1,,"), ["a1", "b-2"]);
  assert.equal(parseClipIds("a/../b"), null);
  assert.equal(parseClipIds(Array.from({ length: EXPORT_CLIP_IDS_MAX + 1 }, (_, i) => `c${i}`).join(",")), null);
});

test("pickExportClips: empty list keeps everything and no subset note", () => {
  const all = [clip("a", "done", "k"), clip("b", "failed", null)];
  const r = pickExportClips(all, []);
  assert.equal(r.clips.length, 2);
  assert.equal(r.subset, undefined);
});

test("pickExportClips: narrows to the allow-list and reports unknown ids and the total rendered", () => {
  const all = [clip("a", "done", "k"), clip("b", "done", "k2"), clip("c", "failed", null)];
  const r = pickExportClips(all, ["b", "c", "zzz"]);
  assert.deepEqual(r.clips.map((c) => c.id), ["b", "c"]);
  assert.deepEqual(r.unknown, ["zzz"]);
  assert.deepEqual(r.subset, { requested: 3, total: 2 });
});
