/**
 * The decision log's pure parts (docs/specs/decision-log.md): the word window a fix decision keeps, the source
 * snapshot, and the conversion of exported decisions into disfluency eval cases (labels, split by project, dedupe).
 * Run: node --import tsx --test test/decision-cases.test.ts   (no database)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptFlag, Word } from "@reelsaw/shared";
import { fixContext, flagSnapshot, sourceRefOf } from "../src/decisions/service.js";
import { caseKey, disfluencyCaseOf, disfluencyCases, parseExport, splitOf, type ExportedDecision } from "../src/decisions/cases.js";

const words: Word[] = Array.from({ length: 100 }, (_, i) => ({ text: `w${i}`, start: i, end: i + 0.5 }));
const flag = (o: Partial<TranscriptFlag> = {}): TranscriptFlag => ({
  id: "f1",
  kind: "disfluency",
  subkind: "repetition",
  wordIndex: 50,
  span: 2,
  start: 50,
  end: 51.5,
  heard: "w50 w51",
  suggested: "",
  confidence: 0.8,
  status: "pending",
  ...o,
});

function decision(o: Partial<ExportedDecision> & { flag?: TranscriptFlag } = {}): ExportedDecision {
  const f = o.flag ?? flag();
  return {
    id: 1,
    projectId: "p1",
    kind: "fix.reject",
    explicit: true,
    before: flagSnapshot(f),
    after: null,
    context: { flagId: f.id, flagKind: f.kind, subkind: f.subkind ?? null, ...fixContext(words, f) },
    models: {},
    source: { type: "url", url: "https://www.youtube.com/watch?v=abc", videoId: "abc", sha256: "ff" },
    createdAt: "2026-10-27T10:00:00.000Z",
    ...o,
  };
}

describe("fix context", () => {
  it("keeps 30 words each side and the fix's place in the window", () => {
    const c = fixContext(words, flag());
    assert.equal(c.words.length, 30 + 2 + 30);
    assert.deepEqual(c.target, { index: 30, span: 2 });
    assert.equal(c.words[c.target.index]!.text, "w50");
  });
  it("clips at the edges of the transcript", () => {
    const c = fixContext(words, flag({ wordIndex: 3, span: 1 }));
    assert.equal(c.offset, 0);
    assert.deepEqual(c.target, { index: 3, span: 1 });
    assert.equal(fixContext(words, flag({ wordIndex: 98, span: 2 })).words.length, 32);
  });
  it("drops the flags a manual cut absorbed", () => {
    assert.equal("absorbed" in flagSnapshot(flag({ subkind: "manual", absorbed: [{ id: "x" }] })), false);
  });
});

describe("source snapshot", () => {
  it("reads the ingest fingerprint and the canonical link", () => {
    const ref = sourceRefOf({
      sourceType: "url",
      sourceUrl: "https://youtu.be/abc",
      durationSec: 600,
      title: "T",
      sourceMeta: {
        webpage_url: "https://www.youtube.com/watch?v=abc",
        extractor: "Youtube",
        videoId: "abc",
        formatId: "137+140",
        sha256: "ff",
        uploader: "Chan",
      },
    });
    assert.deepEqual(
      { ...ref },
      {
        type: "url",
        url: "https://www.youtube.com/watch?v=abc",
        extractor: "Youtube",
        videoId: "abc",
        formatId: "137+140",
        durationSec: 600,
        sha256: "ff",
        title: "T",
        uploader: "Chan",
      },
    );
  });
  it("gives an upload no url", () => {
    const ref = sourceRefOf({ sourceType: "upload", sourceUrl: null, durationSec: null, title: "file.mp4", sourceMeta: { sha256: "aa" } });
    assert.equal(ref.url, undefined);
    assert.equal(ref.sha256, "aa");
  });
});

describe("disfluency cases from decisions", () => {
  it("labels by what the user did", () => {
    assert.equal(disfluencyCaseOf(decision({ kind: "fix.reject" }))?.expect, "keep");
    assert.equal(disfluencyCaseOf(decision({ kind: "fix.accept" }))?.expect, "cut");
    assert.equal(disfluencyCaseOf(decision({ kind: "fix.delete" }))?.expect, "keep");
    assert.equal(disfluencyCaseOf(decision({ kind: "fix.manual", flag: flag({ subkind: "manual" }) }))?.expect, "cut");
  });
  it("skips undoing your own cut, inferred decisions, name fixes and clip decisions", () => {
    assert.equal(disfluencyCaseOf(decision({ kind: "fix.delete", flag: flag({ subkind: "manual" }) })), null);
    assert.equal(disfluencyCaseOf(decision({ explicit: false })), null);
    assert.equal(disfluencyCaseOf(decision({ flag: flag({ kind: "entity", subkind: undefined }) })), null);
    assert.equal(disfluencyCaseOf(decision({ kind: "clip.delete", context: { text: "x" } })), null);
  });
  it("keeps provenance with a link at the moment", () => {
    const c = disfluencyCaseOf(decision())!;
    assert.equal(c.source?.url, "https://www.youtube.com/watch?v=abc&t=50");
    assert.equal(c.source?.decidedAt, "2026-10-27");
    assert.equal(c.source?.sha256, "ff");
    assert.match(c.id, /^d1-w50-w51$/);
  });
  it("splits by project, so one video never lands on both sides", () => {
    const a = disfluencyCaseOf(decision({ id: 1, projectId: "p-x" }))!;
    const b = disfluencyCaseOf(decision({ id: 2, projectId: "p-x", flag: flag({ wordIndex: 10 }) }))!;
    assert.equal(a.split, b.split);
    assert.equal(a.split, splitOf("p-x"));
    const splits = new Set(Array.from({ length: 40 }, (_, i) => splitOf(`project-${i}`)));
    assert.deepEqual([...splits].sort(), ["dev", "heldout"]);
  });
  it("dedupes a window decided twice (latest wins) and windows already committed", () => {
    const first = decision({ id: 1, kind: "fix.accept" });
    const later = decision({ id: 2, kind: "fix.reject" });
    const cases = disfluencyCases([first, later]);
    assert.equal(cases.length, 1);
    assert.equal(cases[0]!.expect, "keep");
    assert.equal(disfluencyCases([first], [caseKey(disfluencyCaseOf(first)!)]).length, 0);
  });
  it("an undo takes the older label back: deleting your manual cut, restoring a deleted cut", () => {
    const manual = flag({ id: "m1", subkind: "manual", status: "accepted" });
    assert.equal(disfluencyCases([decision({ id: 1, kind: "fix.manual", flag: manual }), decision({ id: 2, kind: "fix.delete", flag: manual })]).length, 0);
    const auto = flag({ status: "auto" });
    assert.equal(disfluencyCases([decision({ id: 1, kind: "fix.delete", flag: auto }), decision({ id: 2, kind: "fix.restore", flag: auto })]).length, 0);
    // a decision after the undo labels again
    assert.equal(
      disfluencyCases([
        decision({ id: 1, kind: "fix.delete", flag: auto }),
        decision({ id: 2, kind: "fix.restore", flag: auto }),
        decision({ id: 3, kind: "fix.reject", flag: auto }),
      ])[0]?.expect,
      "keep",
    );
  });
  it("parses an export, counting lines that are not decisions", () => {
    const text = [JSON.stringify(decision()), "not json", JSON.stringify({ id: 2 }), ""].join("\n");
    const r = parseExport(text);
    assert.equal(r.rows.length, 1);
    assert.equal(r.bad, 2);
  });
});
