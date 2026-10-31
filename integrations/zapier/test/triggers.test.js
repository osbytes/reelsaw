/* globals describe, it, expect, afterEach */
"use strict";

const zapier = require("zapier-platform-core");
const App = require("../index");
const { SAMPLE_BODIES } = require("../lib/payloads");
const { authData, ok, toolError, mockTool, nock } = require("./helpers");

const appTester = zapier.createAppTester(App);
const TARGET = "https://hooks.zapier.com/hooks/standard/123/abc/";

afterEach(() => nock.cleanAll());

const op = (key) => App.triggers[key].operation;

describe("REST hook subscribe / unsubscribe", () => {
  const cases = [
    ["project_done", "project.done", "Zapier: Project Finished"],
    ["clip_done", "clip.done", "Zapier: Clip Rendered"],
    ["project_failed", "project.failed", "Zapier: Project Failed"],
  ];

  it.each(cases)("%s subscribes with create_webhook for %s only", async (key, event, description) => {
    const seen = mockTool(
      "create_webhook",
      ok({
        endpoint: { id: "whk_1", url: "hooks.zapier.com/…/abc", description, events: [event], status: "active" },
        secret: `whsec_${Buffer.from("secret").toString("base64")}`,
        hint: "Keep the secret",
      }),
    );
    const sub = await appTester(op(key).performSubscribe, { authData, targetUrl: TARGET });
    expect(seen.arguments).toEqual({ url: TARGET, events: [event], description });
    expect(sub).toEqual({ id: "whk_1", events: [event] });
    expect(JSON.stringify(sub)).not.toContain("whsec_");
  });

  it("surfaces create_webhook's refusal (e.g. the webhook limit) as the error", async () => {
    mockTool("create_webhook", toolError("FORBIDDEN: You have 10 webhooks, the most your plan allows. Delete one first."));
    await expect(appTester(op("project_done").performSubscribe, { authData, targetUrl: TARGET })).rejects.toThrow(/You have 10 webhooks/);
  });

  it("unsubscribes with delete_webhook and the subscribed id", async () => {
    const seen = mockTool("delete_webhook", ok({ ok: true, message: "Webhook deleted; nothing more is sent to it." }));
    const r = await appTester(op("project_done").performUnsubscribe, { authData, subscribeData: { id: "whk_1" } });
    expect(seen.arguments).toEqual({ id: "whk_1" });
    expect(r.ok).toBe(true);
  });

  it("treats an already-deleted webhook as unsubscribed", async () => {
    mockTool("delete_webhook", toolError("NOT_FOUND: No such webhook"));
    const r = await appTester(op("clip_done").performUnsubscribe, { authData, subscribeData: { id: "whk_gone" } });
    expect(r.ok).toBe(true);
  });

  it("does not swallow other unsubscribe errors", async () => {
    mockTool("delete_webhook", toolError("INTERNAL_SERVER_ERROR: Database is restarting"));
    await expect(appTester(op("clip_done").performUnsubscribe, { authData, subscribeData: { id: "whk_1" } })).rejects.toThrow(
      /Database is restarting/,
    );
  });
});

describe("trigger perform (a delivery arrives)", () => {
  it("project_done gives one item per project, clips as line items, data lifted to the top", async () => {
    const body = SAMPLE_BODIES["project.done"];
    const items = await appTester(op("project_done").perform, { authData, cleanedRequest: body });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item.id).toBe(body.id);
    expect(item.type).toBe("project.done");
    expect(item.project.title).toBe(body.data.project.title);
    expect(item.clips[0].shareUrl).toBe(body.data.clips[0].shareUrl);
    expect(item.exportShareUrl).toBe(body.data.exportShareUrl);
    expect(item.metadata).toEqual({ runId: "zap-episode-pipeline" });
    expect(item.clipCount).toBe(1);
    expect(item.renderedClipCount).toBe(1);
    expect(item.data).toBeUndefined();
  });

  it("clip_done gives the clip and its project", async () => {
    const body = SAMPLE_BODIES["clip.done"];
    const [item] = await appTester(op("clip_done").perform, { authData, cleanedRequest: body });
    expect(item.id).toBe(body.id);
    expect(item.clip.id).toBe(body.data.clip.id);
    expect(item.clip.thumbnailShareUrl).toBe(body.data.clip.thumbnailShareUrl);
    expect(item.project.id).toBe(body.data.project.id);
  });

  it("project_failed gives the stage and Reelsaw's reason", async () => {
    const body = SAMPLE_BODIES["project.failed"];
    const [item] = await appTester(op("project_failed").perform, { authData, cleanedRequest: body });
    expect(item.stage).toBe("ingest");
    expect(item.error).toMatch(/could not be downloaded/);
  });

  it("ignores a webhook.test delivery and events it did not subscribe to", async () => {
    const test = { id: "evt_test_9", type: "webhook.test", createdAt: "2026-10-31T00:00:00Z", apiVersion: 1, data: { message: "hi" }, metadata: {} };
    expect(await appTester(op("project_done").perform, { authData, cleanedRequest: test })).toEqual([]);
    expect(await appTester(op("project_done").perform, { authData, cleanedRequest: SAMPLE_BODIES["clip.done"] })).toEqual([]);
  });

  it("every trigger's static sample has an id and the shape perform returns", () => {
    for (const key of Object.keys(App.triggers)) {
      const { sample } = op(key);
      expect(sample.id).toBeTruthy();
      expect(sample.project).toBeTruthy();
    }
  });
});

describe("trigger performList (samples in the Zap editor)", () => {
  const project = {
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
    exportZipUrl: "https://reelsaw.test/api/projects/p1/export.zip",
    clips: [
      { id: "c1", index: 0, title: "One", hook: "h", startSec: 1, endSec: 31, durationSec: 30, score: 80, status: "done", layout: "face", videoUrl: "https://reelsaw.test/media/clips/p1/c1.mp4", thumbnailUrl: null },
      { id: "c2", index: 1, title: "Two", hook: "h", startSec: 40, endSec: 70, durationSec: 30, score: 70, status: "failed", layout: "face", videoUrl: null, thumbnailUrl: null },
    ],
  };
  const list = ok({
    projects: [
      { id: "p0", title: "Running", status: "rendering" },
      { id: "p1", title: "Episode 42", status: "done" },
    ],
    total: 2,
    nextCursor: null,
  });

  it("project_done samples finished projects in the delivery shape", async () => {
    mockTool("list_projects", list);
    const get = mockTool("get_project", ok(project));
    const items = await appTester(op("project_done").performList, { authData });
    expect(get.arguments).toEqual({ id: "p1" });
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("project.done");
    expect(items[0].project).toMatchObject({ id: "p1", title: "Episode 42", url: "https://reelsaw.test/p/p1" });
    expect(items[0].clips.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(items[0].clips[0].url).toBe("https://reelsaw.test/p/p1/clips/c1");
    expect(items[0].metadata).toEqual({ runId: "r1" });
    expect(items[0].exportUrl).toBe(project.exportZipUrl);
  });

  it("clip_done samples the rendered clips of the latest finished project", async () => {
    mockTool("list_projects", list);
    mockTool("get_project", ok(project));
    const items = await appTester(op("clip_done").performList, { authData });
    expect(items.map((i) => i.clip.id)).toEqual(["c1"]);
    expect(items[0].id).toBe("sample_clip.done_c1");
  });

  it("project_failed returns nothing when no project failed", async () => {
    mockTool("list_projects", list);
    expect(await appTester(op("project_failed").performList, { authData })).toEqual([]);
  });
});
