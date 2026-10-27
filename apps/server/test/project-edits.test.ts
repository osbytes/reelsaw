/**
 * The service functions behind delete_clip and update_project (and clips.delete / projects.update / the CLI):
 * a deleted clip stops its render, finishes a project that was only waiting for it and comes back with
 * restoreClip; a project update writes only the keys it is given and re-runs nothing.
 * Postgres only.  node --import tsx --test test/project-edits.test.ts
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { lifecycleHarness } from "./lifecycle-harness.js";
import { schema } from "../src/db/index.js";
import { applyProjectFraming, deleteClip, deleteClips, restoreClip, updateProject } from "../src/projects/service.js";
import { requestRender } from "../src/pipeline/lifecycle.js";

const h = lifecycleHarness();
const notReady = await h.ready();
(h.svc.settings.get() as { DELETED_RETENTION_DAYS: number }).DELETED_RETENTION_DAYS = 7;

after(() => h.cleanup());

const clipRow = async (id: string) => (await h.pool.query(`select status, deleted_at, render_gen from clips where id = $1`, [id])).rows[0];
const projectRow = async (id: string) => (await h.pool.query(`select title, status, settings from projects where id = $1`, [id])).rows[0];

describe("deleteClip", { skip: notReady ?? false }, () => {
  let userId: string;
  before(async () => {
    userId = await h.makeUser();
  });

  it("stops the render, finishes the project it was holding up, and restores", async () => {
    const projectId = await h.makeProject(userId, "rendering");
    const done = await h.makeClip(projectId, 0, "done", { outputKey: "x.mp4" });
    const busy = await h.makeClip(projectId, 1, "done", { outputKey: "y.mp4" });
    await h.tx((u) => requestRender(h.svc, u, projectId, busy)); // busy is now pending with a live render job
    const gen = (await clipRow(busy)).render_gen;
    const r = await deleteClip(h.svc, { id: userId, admin: false }, busy);
    assert.equal(r.changed, true);
    assert.match(r.restorable, /7 days/);
    const row = await clipRow(busy);
    assert.ok(row.deleted_at);
    assert.equal(row.status, "failed"); // it never finished
    assert.equal(row.render_gen, gen + 1); // a render still running discards its output
    assert.deepEqual((await h.jobsFor([busy])).filter((j) => j.state === "created" || j.state === "active"), []);
    assert.equal((await projectRow(projectId)).status, "done"); // the remaining clip was the only one left
    assert.equal(await h.eventCount(projectId, "clip.deleted"), 1);
    assert.equal((await deleteClip(h.svc, { id: userId, admin: false }, busy)).changed, false);
    assert.equal((await clipRow(done)).deleted_at, null);
    const back = await restoreClip(h.svc, { id: userId, admin: false }, busy);
    assert.equal(back.changed, true);
    assert.equal(back.needsRerender, true);
  });

  it("deletes several clips of one project in one step", async () => {
    const projectId = await h.makeProject(userId, "done");
    const a = await h.makeClip(projectId, 0, "done", { outputKey: "a.mp4" });
    const b = await h.makeClip(projectId, 1, "done", { outputKey: "b.mp4" });
    const r = await deleteClips(h.svc, { id: userId, admin: false }, projectId, [a, b, a]);
    assert.equal(r.deleted, 2);
    assert.equal(r.skipped, 0);
    assert.ok((await clipRow(a)).deleted_at);
    assert.ok((await clipRow(b)).deleted_at);
    const again = await deleteClips(h.svc, { id: userId, admin: false }, projectId, [a, b]);
    assert.equal(again.deleted, 0);
    assert.equal(again.skipped, 2);
  });

  it("refuses someone else's clip", async () => {
    const projectId = await h.makeProject(userId, "done");
    const clip = await h.makeClip(projectId, 0, "done");
    const stranger = await h.makeUser();
    await assert.rejects(deleteClip(h.svc, { id: stranger, admin: false }, clip), /NOT_FOUND|No project with that id/);
    assert.equal((await clipRow(clip)).deleted_at, null);
  });
});

describe("updateProject", { skip: notReady ?? false }, () => {
  let userId: string;
  let projectId: string;
  before(async () => {
    userId = await h.makeUser();
    projectId = await h.makeProject(userId, "done");
    await h.pool.query(`update projects set settings = '{"captions":"box","maxClips":5}'::jsonb where id = $1`, [projectId]);
  });

  const me = () => ({ id: userId, admin: false });

  it("writes only the given keys and re-runs nothing", async () => {
    const r = await updateProject(h.svc, me(), projectId, { title: " New title ", settings: { focus: "money", captionSize: 1.2 } });
    assert.deepEqual(r.changed, ["title", "focus", "captionSize"]);
    assert.equal(r.needsReanalyze, true);
    assert.equal(r.needsRerender, true);
    const p = await projectRow(projectId);
    assert.equal(p.title, "New title");
    assert.equal(p.status, "done");
    assert.deepEqual(p.settings, { captions: "box", maxClips: 5, focus: "money", captionSize: 1.2 });
    assert.equal(await h.eventCount(projectId, "project.updated"), 1);
    assert.deepEqual(await h.jobsFor([projectId]), []);
  });

  it("clears optional settings and reports no change for a no-op", async () => {
    const r = await updateProject(h.svc, me(), projectId, { clear: ["maxClips", "language"] });
    assert.deepEqual(r.changed, ["maxClips"]);
    assert.equal((await projectRow(projectId)).settings.maxClips, undefined);
    const same = await updateProject(h.svc, me(), projectId, { settings: { focus: "money" } });
    assert.deepEqual(same.changed, []);
    assert.equal(await h.eventCount(projectId, "project.updated"), 2);
  });

  it("refuses intro/outro keys, bad clip lengths and other people's projects", async () => {
    await assert.rejects(updateProject(h.svc, me(), projectId, { settings: { introAssetId: "x" } }), /set_project_bumpers/);
    await assert.rejects(updateProject(h.svc, me(), projectId, { settings: { minClipSeconds: 90, maxClipSeconds: 60 } }), /minClipSeconds/);
    await assert.rejects(updateProject(h.svc, me(), projectId, { settings: { captionSize: 9 } as never }), /captionSize/);
    const stranger = await h.makeUser();
    await assert.rejects(updateProject(h.svc, { id: stranger, admin: false }, projectId, { title: "Mine" }), /No project with that id/);
    assert.equal((await projectRow(projectId)).title, "New title");
  });
});

describe("applyProjectFraming", { skip: notReady ?? false }, () => {
  let userId: string;
  let projectId: string;
  let done: string;
  let own: string;
  let rendering: string;
  const tile = { x1: 0.869, y1: 0.083, x2: 1, y2: 0.217 };
  before(async () => {
    userId = await h.makeUser();
    projectId = await h.makeProject(userId, "done");
    done = await h.makeClip(projectId, 0, "done", { outputKey: "k0" });
    own = await h.makeClip(projectId, 1, "done", { outputKey: "k1" });
    rendering = await h.makeClip(projectId, 2, "rendering");
    await h.pool.query(`update clips set layout_sections = '[{"start":0,"end":10,"mode":"face","offsetX":0.1}]'::jsonb, layout_override = 'face' where id = $1`, [own]);
  });
  const me = () => ({ id: userId, admin: false });

  it("sets the project's framing, clears the clips' own, and re-renders the finished ones", async () => {
    const r = await applyProjectFraming(h.svc, me(), projectId, { reframe: "stack", adjust: { crop: tile, offsetX: 0 } });
    assert.deepEqual(r, { ok: true, reframe: "stack", adjust: { crop: tile }, cleared: 1, rerendered: 2 });
    const p = await projectRow(projectId);
    assert.equal(p.settings.reframe, "stack");
    assert.deepEqual(p.settings.reframeAdjust, { crop: tile });
    const ownRow = (await h.pool.query(`select layout_sections, layout_override from clips where id = $1`, [own])).rows[0];
    assert.equal(ownRow.layout_sections, null);
    assert.equal(ownRow.layout_override, null);
    assert.equal((await clipRow(done)).status, "pending");
    assert.equal((await clipRow(rendering)).status, "rendering");
    assert.equal(await h.eventCount(projectId, "project.updated"), 1);
  });

  it("can leave the clips' own sections alone and skip the re-render", async () => {
    await h.pool.query(`update clips set layout_sections = '[{"start":0,"end":10,"mode":"face"}]'::jsonb, status = 'done' where id = $1`, [own]);
    const r = await applyProjectFraming(h.svc, me(), projectId, { reframe: "fit", keepOverrides: true, rerender: false });
    assert.deepEqual(r, { ok: true, reframe: "fit", adjust: null, cleared: 0, rerendered: 0 });
    assert.equal((await projectRow(projectId)).settings.reframeAdjust, null);
    assert.notEqual((await h.pool.query(`select layout_sections from clips where id = $1`, [own])).rows[0].layout_sections, null);
    assert.equal((await clipRow(own)).status, "done");
  });

  it("refuses other people's projects", async () => {
    const stranger = await h.makeUser();
    await assert.rejects(applyProjectFraming(h.svc, { id: stranger, admin: false }, projectId, { reframe: "fit" }), /No project with that id/);
  });
});
