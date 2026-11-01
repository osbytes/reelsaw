/* globals describe, it, expect, afterEach */
"use strict";

const zapier = require("zapier-platform-core");
const App = require("../index");
const { authData, ok, toolError, mockTool, nock } = require("./helpers");

const appTester = zapier.createAppTester(App);

afterEach(() => nock.cleanAll());

describe("Create Project", () => {
  const perform = App.creates.create_project.operation.perform;
  const created = {
    id: "p9",
    title: null,
    status: "queued",
    sourceUrl: "https://www.youtube.com/watch?v=abc",
    metadata: { runId: "zap-1" },
    createdAt: "2026-10-31T10:00:00.000Z",
    next: "wait_for_project",
  };

  it("calls create_project with the URL, title, metadata and settings", async () => {
    const seen = mockTool("create_project", ok(created));
    const r = await appTester(perform, {
      authData,
      inputData: {
        sourceUrl: " https://www.youtube.com/watch?v=abc ",
        title: "Episode 43",
        metadata: { runId: "zap-1", "": "dropped" },
        maxClips: "5",
        focus: "pricing",
      },
    });
    expect(seen.arguments).toEqual({
      sourceUrl: "https://www.youtube.com/watch?v=abc",
      title: "Episode 43",
      metadata: { runId: "zap-1" },
      settings: { maxClips: 5, focus: "pricing" },
    });
    expect(r).toEqual({
      id: "p9",
      title: null,
      status: "queued",
      url: "https://reelsaw.test/p/p9",
      sourceUrl: "https://www.youtube.com/watch?v=abc",
      metadata: { runId: "zap-1" },
      createdAt: "2026-10-31T10:00:00.000Z",
    });
  });

  it("sends only the URL when nothing else is filled in", async () => {
    const seen = mockTool("create_project", ok(created));
    await appTester(perform, { authData, inputData: { sourceUrl: "https://www.youtube.com/watch?v=abc", title: "", metadata: {}, focus: " " } });
    expect(seen.arguments).toEqual({ sourceUrl: "https://www.youtube.com/watch?v=abc" });
  });

  it("surfaces Reelsaw's refusal as the step's error", async () => {
    mockTool(
      "create_project",
      toolError('TOO_MANY_REQUESTS: You have used all 120 source minutes this month. They come back on Nov 1.\n{"quota":{"key":"minutes"}}'),
    );
    const run = appTester(perform, { authData, inputData: { sourceUrl: "https://www.youtube.com/watch?v=abc" } });
    await expect(run).rejects.toThrow(/You have used all 120 source minutes this month\. They come back on Nov 1\./);
    nock.cleanAll();
    mockTool("create_project", toolError("BAD_REQUEST: Metadata keys are 1-40 letters, digits, _ . or -"));
    await expect(appTester(perform, { authData, inputData: { sourceUrl: "https://x.test/v", metadata: { "bad key": "v" } } })).rejects.toThrow(
      /Metadata keys are 1-40 letters/,
    );
  });
});

describe("Get Share Links", () => {
  const perform = App.creates.get_share_links.operation.perform;

  it("asks get_media_links for one clip and flattens the links", async () => {
    const seen = mockTool(
      "get_media_links",
      ok({
        clips: [
          {
            clipId: "c1",
            title: "One",
            links: {
              clip: { linkId: "lnk_a", url: "https://reelsaw.test/m/tokA/one.mp4", expiresAt: "2027-01-29T00:00:00.000Z" },
              thumb: { linkId: "lnk_b", url: "https://reelsaw.test/m/tokB/one.jpg", expiresAt: "2027-01-29T00:00:00.000Z" },
            },
          },
        ],
        hint: "Anyone with a link can download the file until it expires",
      }),
    );
    const r = await appTester(perform, { authData, inputData: { projectId: "p1", clipId: "c1", kinds: ["clip", "thumb"] } });
    expect(seen.arguments).toEqual({ projectId: "p1", clipIds: ["c1"], kinds: ["clip", "thumb"] });
    expect(r).toMatchObject({
      id: "c1",
      clipId: "c1",
      projectId: "p1",
      title: "One",
      clipUrl: "https://reelsaw.test/m/tokA/one.mp4",
      clipLinkId: "lnk_a",
      thumbUrl: "https://reelsaw.test/m/tokB/one.jpg",
      srtUrl: null,
      vttUrl: null,
    });
  });

  it("defaults to the video and passes a lifetime when given", async () => {
    const seen = mockTool("get_media_links", ok({ clips: [{ clipId: "c1", title: "One", links: { clip: { linkId: "l", url: "u", expiresAt: null } } }] }));
    await appTester(perform, { authData, inputData: { projectId: "p1", clipId: "c1", ttlDays: "7" } });
    expect(seen.arguments).toEqual({ projectId: "p1", clipIds: ["c1"], kinds: ["clip"], ttlDays: 7 });
  });

  it("fails with Reelsaw's sentence when the clip is not rendered yet", async () => {
    mockTool("get_media_links", ok({ clips: [{ clipId: "c1", title: "One", notReady: "Not rendered (rendering); wait for it, then ask again." }] }));
    await expect(appTester(perform, { authData, inputData: { projectId: "p1", clipId: "c1" } })).rejects.toThrow(/Not rendered \(rendering\)/);
  });

  it("fails with Reelsaw's sentence for a clip of another project", async () => {
    mockTool("get_media_links", toolError("NOT_FOUND: Not clips of this project: c9. get_project lists its clips."));
    await expect(appTester(perform, { authData, inputData: { projectId: "p1", clipId: "c9" } })).rejects.toThrow(/Not clips of this project: c9/);
  });
});

describe("Find Project", () => {
  const perform = App.searches.find_project.operation.perform;

  it("returns the project trimmed for mapping", async () => {
    const seen = mockTool(
      "get_project",
      ok({
        id: "p1",
        title: "Episode 42",
        status: "done",
        stage: null,
        error: null,
        url: "https://reelsaw.test/p/p1",
        sourceUrl: "https://youtu.be/x",
        durationSec: 100,
        createdAt: "2026-10-30T00:00:00Z",
        updatedAt: "2026-10-30T01:00:00Z",
        metadata: { runId: "r1" },
        settings: { maxClips: 5 },
        transcript: { words: 9000 },
        exportZipUrl: "https://reelsaw.test/api/projects/p1/export.zip",
        clips: [{ id: "c1", index: 0, title: "One", startSec: 0, endSec: 30, durationSec: 30, status: "done", videoUrl: "v" }],
      }),
    );
    const r = await appTester(perform, { authData, inputData: { projectId: " p1 " } });
    expect(seen.arguments).toEqual({ id: "p1" });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ id: "p1", title: "Episode 42", clipCount: 1, renderedClipCount: 1, metadata: { runId: "r1" } });
    expect(r[0].clips[0].url).toBe("https://reelsaw.test/p/p1/clips/c1");
    expect(r[0].transcript).toBeUndefined();
    expect(r[0].settings).toBeUndefined();
  });

  it("returns nothing when the project does not exist", async () => {
    mockTool("get_project", toolError("NOT_FOUND: Project not found"));
    expect(await appTester(perform, { authData, inputData: { projectId: "nope" } })).toEqual([]);
  });
});

describe("Dropdowns", () => {
  it("lists the 100 most recent projects", async () => {
    const first = mockTool("list_projects", ok({ projects: [{ id: "p1", title: "One", status: "done", clips: "2/2 rendered" }], total: 2, nextCursor: "c1" }));
    const page0 = await appTester(App.triggers.project_list.operation.perform, { authData });
    expect(first.arguments).toEqual({ limit: 100 });
    expect(page0).toEqual([{ id: "p1", title: "One", status: "done", clips: "2/2 rendered" }]);
  });

  it("lists only the rendered clips of the picked project", async () => {
    const seen = mockTool(
      "get_project",
      ok({
        id: "p1",
        clips: [
          { id: "c1", index: 0, title: "Hook", status: "done", durationSec: 30 },
          { id: "c2", index: 1, title: "Later", status: "rendering" },
        ],
      }),
    );
    const clips = await appTester(App.triggers.clip_list.operation.perform, { authData, inputData: { projectId: "p1" } });
    expect(seen.arguments).toEqual({ id: "p1" });
    expect(clips).toEqual([{ id: "c1", title: "#1 Hook", index: 0, durationSec: 30 }]);
  });

  it("lists no clips before a project is picked, or for a project that is gone", async () => {
    expect(await appTester(App.triggers.clip_list.operation.perform, { authData, inputData: {} })).toEqual([]);
    mockTool("get_project", toolError("NOT_FOUND: Project not found"));
    expect(await appTester(App.triggers.clip_list.operation.perform, { authData, inputData: { projectId: "gone" } })).toEqual([]);
  });
});
