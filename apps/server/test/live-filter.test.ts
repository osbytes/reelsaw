import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { LIVE_STATUSES, NOT_LIVE_FILTER, isUnfinishedStream } from "../src/projects/peek.js";

const run = promisify(execFile);
const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
/** CI installs the Dockerfile's pinned yt-dlp and sets this, so a missing binary fails there instead of skipping. */
const REQUIRED = process.env.REQUIRE_YTDLP === "1";

/**
 * The live fields of every kind of link ingest meets. `null` leaves both fields unset: a direct .mp4 through the generic
 * extractor (the regression 0fcb639 fixed), and anything else yt-dlp does not label.
 */
const CASES: Array<{ name: string; fields: { live_status?: string; is_live?: boolean | null; was_live?: boolean } }> = [
  { name: "direct file, no live fields", fields: {} },
  { name: "is_live explicitly null", fields: { is_live: null } },
  { name: "a value yt-dlp may add later", fields: { live_status: "some_new_status", is_live: false } },
  ...Object.keys(LIVE_STATUSES).map((status) => ({
    name: status,
    fields: { live_status: status, is_live: status === "is_live", was_live: status === "was_live" || status === "post_live" },
  })),
];

async function ytdlpVersion(): Promise<string | null> {
  try {
    return (await run(YTDLP, ["--version"])).stdout.trim();
  } catch {
    return null;
  }
}

const version = await ytdlpVersion();
if (!version && REQUIRED) throw new Error(`REQUIRE_YTDLP=1 but ${YTDLP} does not run`);

describe("LIVE_STATUSES", () => {
  it("lets a direct file and an unknown status through, like an ordinary video", () => {
    assert.equal(isUnfinishedStream({}), false);
    assert.equal(isUnfinishedStream({ live_status: "some_new_status" }), false);
    assert.equal(isUnfinishedStream({ is_live: true }), true);
  });
});

// yt-dlp's own --match-filter evaluates each case offline (--load-info-json, --simulate): the filter must skip exactly
// the links the lookup refuses, so a link is never refused by one and downloaded by the other
describe("NOT_LIVE_FILTER in the real yt-dlp", { skip: version ? false : `${YTDLP} not installed` }, () => {
  let dir = "";
  after(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  for (const c of CASES) {
    it(`${isUnfinishedStream(c.fields) ? "skips" : "downloads"} ${c.name}`, async () => {
      dir ||= await fs.mkdtemp(path.join(os.tmpdir(), "live-filter-"));
      const file = path.join(dir, `${c.name.replace(/\W+/g, "_")}.json`);
      const info = {
        id: "x",
        title: "x",
        extractor: "generic",
        extractor_key: "Generic",
        url: "https://example.com/x.mp4",
        ext: "mp4",
        duration: 60,
        ...c.fields,
      };
      await fs.writeFile(file, JSON.stringify(info));
      const { stdout } = await run(YTDLP, [
        "--no-warnings",
        "--ignore-config",
        "--load-info-json",
        file,
        "--match-filter",
        NOT_LIVE_FILTER,
        "--simulate",
        "--print",
        "id",
      ]);
      const downloaded = stdout.trim() === "x";
      assert.equal(downloaded, !isUnfinishedStream(c.fields), `yt-dlp ${version}: ${JSON.stringify(c.fields)}`);
    });
  }
});
