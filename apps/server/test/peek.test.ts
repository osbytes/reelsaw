import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { announcedDuration, forgetAnnouncedDurations } from "../src/projects/peek.js";

/** A yt-dlp that answers the metadata lookup with `answer` (a duration, null for none, or an error) and counts its runs. */
function fakeYtdlp(answer: () => number | null | Error) {
  const runs: string[] = [];
  return {
    runs,
    media: {
      ytdlp: async (args: string[]) => {
        runs.push(args[args.length - 1]!);
        const a = answer();
        if (a instanceof Error) throw a;
        const stdout = `[info] noise\n${JSON.stringify(a === null ? { id: "x" } : { id: "x", duration: a })}\n`;
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
});
