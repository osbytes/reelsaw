import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { LiveSourceError, NOT_LIVE_FILTER, announcedDuration, forgetAnnouncedDurations } from "../src/projects/peek.js";

describe("NOT_LIVE_FILTER", () => {
  // yt-dlp fails `key!=value` when the extractor left `key` unset; `key!=?value` passes it. A direct .mp4 link has no
  // live_status, so a comparison without the `?` refuses every such file as a live stream (#300)
  it("lets a field the extractor left unset pass every comparison", () => {
    for (const clause of NOT_LIVE_FILTER.split("&").map((c) => c.trim())) {
      if (/^!?\w+$/.test(clause)) continue; // a unary test (`!is_live`) already passes an unset field
      assert.match(clause, /^\w+\s*(?:!?[*^$~]?=|[<>]=?)\s*\?/, `"${clause}" needs a ? after its operator`);
    }
  });
});

/** A yt-dlp that answers the metadata lookup with `answer` (a duration, null for none, an info dict, or an error) and counts its runs. */
function fakeYtdlp(answer: () => number | null | Error | Record<string, unknown>) {
  const runs: string[] = [];
  return {
    runs,
    media: {
      ytdlp: async (args: string[]) => {
        runs.push(args[args.length - 1]!);
        const a = answer();
        if (a instanceof Error) throw a;
        const info = a === null ? { id: "x" } : typeof a === "number" ? { id: "x", duration: a } : { id: "x", ...a };
        const stdout = `[info] noise\n${JSON.stringify(info)}\n`;
        return { stdout, stderr: "", proxyId: "direct" };
      },
    },
  };
}

const LINK = "https://video.example/watch?v=1";

describe("announcedDuration", () => {
  beforeEach(() => forgetAnnouncedDurations());

  it("looks a link up once while checking it, creating it and ingesting it", async () => {
    const y = fakeYtdlp(() => 754);
    assert.equal(await announcedDuration(y.media as never, LINK), 754);
    assert.equal(await announcedDuration(y.media as never, LINK), 754);
    assert.equal(await announcedDuration(y.media as never, LINK), 754);
    assert.equal(y.runs.length, 1);
  });

  it("keeps a link that announces no length too", async () => {
    const y = fakeYtdlp(() => null);
    assert.equal(await announcedDuration(y.media as never, LINK), null);
    assert.equal(await announcedDuration(y.media as never, LINK), null);
    assert.equal(y.runs.length, 1);
  });

  it("looks each link up on its own", async () => {
    const y = fakeYtdlp(() => 60);
    await announcedDuration(y.media as never, LINK);
    await announcedDuration(y.media as never, `${LINK}0`);
    assert.deepEqual(y.runs, [LINK, `${LINK}0`]);
  });

  it("does not keep a failed lookup: the next caller tries again", async () => {
    let fail = true;
    const y = fakeYtdlp(() => (fail ? new Error("yt-dlp exited with 1") : 90));
    await assert.rejects(announcedDuration(y.media as never, LINK));
    fail = false;
    assert.equal(await announcedDuration(y.media as never, LINK), 90);
    assert.equal(y.runs.length, 2);
  });

  it("refuses a live stream, remembered like any other answer", async () => {
    const y = fakeYtdlp(() => ({ is_live: true, live_status: "is_live", duration: null }));
    await assert.rejects(announcedDuration(y.media as never, LINK), LiveSourceError);
    await assert.rejects(announcedDuration(y.media as never, LINK), LiveSourceError);
    assert.equal(y.runs.length, 1);
  });

  it("refuses a stream that has not started yet", async () => {
    const y = fakeYtdlp(() => ({ is_live: false, live_status: "is_upcoming" }));
    await assert.rejects(announcedDuration(y.media as never, LINK), LiveSourceError);
  });

  it("accepts the recording of a stream that has ended", async () => {
    const y = fakeYtdlp(() => ({ is_live: false, live_status: "was_live", was_live: true, duration: 5400 }));
    assert.equal(await announcedDuration(y.media as never, LINK), 5400);
  });
});
