/** GitHub release feed: note parsing, heatmap, and the cached fetcher against a fake GitHub. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import {
  addUtcDays,
  buildActivity,
  formatUtcDate,
  levelsFor,
  loadReleasesFeed,
  parseReleaseNotes,
  summarizeNotes,
  utcWeekStart,
  versionOfTag,
} from "@reelsaw/shared";
import { createLogger } from "../src/log.js";
import { createReleaseFeed, listReleasesResult } from "../src/releases.js";

const log = createLogger({ LOG_LEVEL: "silent", LOG_FORMAT: "json" } as never, {}, new Writable({ write: (_c, _e, cb) => cb() }));

describe("parseReleaseNotes", () => {
  it("reads Changesets headings, PRs and shas, and drops the install footer", () => {
    const body = `### Minor Changes

- #147 \`d08a8e5\` Operators can set a forgotten password.

- #147 \`d08a8e5\` Sign-in has Forgot password.

### Patch Changes

- #150 \`31a78a1\` Catalog items stay on the instance.

---

**Install or upgrade:** docker compose pull.
`;
    const { kinds, notes } = parseReleaseNotes(body);
    assert.deepEqual(kinds, ["minor", "patch"]);
    assert.equal(notes.length, 3);
    assert.equal(notes[0]?.kind, "minor");
    assert.equal(notes[0]?.pr, 147);
    assert.equal(notes[0]?.sha, "d08a8e5");
    assert.match(notes[0]?.text ?? "", /forgotten password/);
    assert.equal(notes[2]?.kind, "patch");
    assert.equal(summarizeNotes(notes), "Operators can set a forgotten password.");
  });

  it("falls back to bullet lines when the body is not Changesets", () => {
    const { notes } = parseReleaseNotes("- first thing\n- second thing");
    assert.equal(notes.length, 2);
    assert.equal(notes[0]?.text, "first thing");
  });

  it("reads GitHub's markdown-link Changesets bullets", () => {
    const body = `### Minor Changes

- [#153](https://github.com/osbytes/reelsaw/pull/153) [\`90ef339\`](https://github.com/osbytes/reelsaw/commit/90ef3393e0417df2fd0c66ea3f34543895887fdf) Layers on the editor's 9:16 preview.

`;
    const { kinds, notes } = parseReleaseNotes(body);
    assert.deepEqual(kinds, ["minor"]);
    assert.equal(notes[0]?.pr, 153);
    assert.equal(notes[0]?.sha, "90ef339");
    assert.equal(notes[0]?.text, "Layers on the editor's 9:16 preview.");
  });
});

describe("versionOfTag", () => {
  it("strips a leading v", () => {
    assert.equal(versionOfTag("v0.19.1"), "0.19.1");
    assert.equal(versionOfTag("0.19.1"), "0.19.1");
  });
});

describe("formatUtcDate", () => {
  it("uses short English month names, including Sep", () => {
    assert.equal(formatUtcDate("2026-09-01"), "1 Sep 2026");
    assert.equal(formatUtcDate("2026-10-24T05:31:02Z", true), "Sat, 24 Oct 2026");
  });
});

describe("activity grid", () => {
  it("pads to Sunday, marks days outside the window, and highlights release days", () => {
    const until = "2026-10-24";
    const since = addUtcDays(until, -89);
    assert.equal(since, "2026-07-27");
    assert.equal(utcWeekStart(since), "2026-07-26");
    const { weeks, months, commits, releaseDays } = buildActivity({
      until,
      commitDays: new Map([
        ["2026-10-24", 4],
        ["2026-10-23", 1],
      ]),
      releases: [
        {
          tag: "v0.19.1",
          version: "0.19.1",
          name: "v0.19.1",
          url: "https://github.com/osbytes/reelsaw/releases/tag/v0.19.1",
          publishedAt: "2026-10-24T05:31:02Z",
          prerelease: false,
          kinds: ["patch"],
          notes: [],
          summary: "Giphy GIFs",
        },
      ],
    });
    assert.equal(weeks[0]?.start, "2026-07-26");
    assert.equal(weeks[0]?.days[0]?.date, "2026-07-26");
    assert.equal(weeks[0]?.days[0]?.inWindow, false);
    const last = weeks.at(-1)?.days.find((d) => d.date === "2026-10-24");
    assert.equal(last?.commits, 4);
    assert.equal(last?.releases[0]?.version, "0.19.1");
    assert.equal(commits, 5);
    assert.equal(releaseDays, 1);
    assert.ok(months.some((m) => m.label === "Jul"));
    assert.ok(months.some((m) => m.label === "Oct"));
  });

  it("maps zero to level 0 and splits the rest into quartiles", () => {
    assert.deepEqual(levelsFor([0, 1, 2, 8, 20]), [0, 1, 2, 3, 4]);
    assert.deepEqual(levelsFor([0, 0, 0]), [0, 0, 0]);
  });
});

function json(body: unknown, link?: string) {
  return {
    ok: true,
    status: 200,
    headers: { get: (n: string) => (n.toLowerCase() === "link" ? (link ?? null) : null) },
    json: async () => body,
  };
}

describe("loadReleasesFeed", () => {
  it("skips drafts, buckets commits by UTC day, and follows a commit next-page", async () => {
    const calls: string[] = [];
    const feed = await loadReleasesFeed({
      userAgent: "reelsaw/test",
      now: new Date("2026-10-24T12:00:00Z"),
      fetch: async (url) => {
        calls.push(url);
        if (url.includes("/releases")) {
          return json([
            { tag_name: "v0.19.1", name: "v0.19.1", html_url: "https://github.com/osbytes/reelsaw/releases/tag/v0.19.1", published_at: "2026-10-24T05:31:02Z", draft: false, prerelease: false, body: "### Patch Changes\n\n- #151 `d579380` Giphy GIFs play.\n" },
            { tag_name: "nightly", name: "nightly", html_url: "https://example.test/nightly", published_at: "2026-10-23T00:00:00Z", draft: true, prerelease: false, body: "" },
          ]);
        }
        if (url.includes("page=2") || url.includes("sha=")) {
          return json([{ sha: "b".repeat(40), commit: { committer: { date: "2026-10-23T18:00:00Z" }, author: { date: "2026-10-23T18:00:00Z" } } }]);
        }
        return json([{ sha: "a".repeat(40), commit: { committer: { date: "2026-10-24T01:00:00Z" }, author: { date: "2026-10-24T01:00:00Z" } } }], '<https://api.github.com/repos/osbytes/reelsaw/commits?page=2>; rel="next"');
      },
    });
    assert.equal(feed.releases.length, 1);
    assert.equal(feed.releases[0]?.version, "0.19.1");
    assert.equal(feed.commits, 2);
    assert.equal(feed.releaseDays, 1);
    assert.equal(feed.truncated, false);
    assert.ok(calls.some((u) => u.includes("/releases")));
    assert.ok(calls.some((u) => u.includes("/commits")));
  });
});

describe("createReleaseFeed", () => {
  it("reuses a fresh answer and keeps it when a later check fails", async () => {
    let fail = false;
    let n = 0;
    const u = createReleaseFeed({ REELSAW_VERSION: "0.19.0" }, log, {
      now: () => 1_000_000,
      fetch: async (url) => {
        n++;
        if (fail) return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) };
        if (url.includes("/releases")) {
          return json([{ tag_name: "v0.19.1", name: "v0.19.1", html_url: "https://github.com/osbytes/reelsaw/releases/tag/v0.19.1", published_at: "2026-10-24T05:31:02Z", draft: false, prerelease: false, body: "### Patch Changes\n\n- hello\n" }]);
        }
        return json([]);
      },
    });
    const first = await u.get();
    assert.equal(first.feed?.releases[0]?.version, "0.19.1");
    assert.equal(first.error, null);
    const listed = listReleasesResult(first, { limit: 5 });
    assert.equal(listed.releases[0]?.summary, "hello");
    const nAfter = n;
    await u.get();
    assert.equal(n, nAfter);
    fail = true;
    const stale = await u.get({ force: true });
    assert.equal(stale.feed?.releases[0]?.version, "0.19.1");
    assert.equal(stale.error, "GitHub answered 503");
  });
});
