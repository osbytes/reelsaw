/**
 * The Deleted page service: listDeleted is one newest-first list; restoreDeleted / purgeDeleted
 * dispatch to the per-kind services; purgeOwnedClip / purgeOwnedAsset / purgeLayerTemplate only
 * accept already-deleted rows.
 * Postgres only.  node --import tsx --test test/deleted.test.ts
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lifecycleHarness } from "./lifecycle-harness.js";
import { listDeleted, purgeDeleted, restoreDeleted } from "../src/deleted.js";
import { QuotaError } from "../src/quota.js";
import { deleteClip, purgeOwnedClip, purgeOwnedProject, restoreClip } from "../src/projects/service.js";
import { purgeOwnedAsset } from "../src/library/service.js";
import { purgeLayerTemplate, removeLayerTemplate } from "../src/library/templates.js";

const h = lifecycleHarness();
const notReady = await h.ready();
(h.svc.settings.get() as { DELETED_RETENTION_DAYS: number }).DELETED_RETENTION_DAYS = 7;

after(() => h.cleanup());

describe("listDeleted and purge", { skip: notReady ?? false }, () => {
  let userId: string;
  before(async () => {
    userId = await h.makeUser();
  });

  it("lists a deleted project with a purge date, and a clip of a live project", async () => {
    const gone = await h.makeProject(userId, "done");
    await h.pool.query(`update projects set deleted_at = now() - interval '1 day', title = 'Gone project' where id = $1`, [gone]);
    const live = await h.makeProject(userId, "done");
    const clip = await h.makeClip(live, 0, "done", { outputKey: "clips/x.mp4" });
    await deleteClip(h.svc, { id: userId, admin: false }, clip);

    const page = await listDeleted(h.svc, userId);
    assert.equal(page.keepDays, 7);
    const project = page.items.find((p) => p.kind === "project" && p.id === gone);
    assert.ok(project?.purgeAt);
    const row = page.items.find((c) => c.kind === "clip" && c.id === clip);
    assert.ok(row);
    assert.equal(row!.projectId, live);
    assert.ok(row!.purgeAt);

    const purged = await purgeOwnedClip(h.svc, { id: userId, admin: false }, clip);
    assert.equal(purged.ok, true);
    const after = await listDeleted(h.svc, userId);
    assert.ok(!after.items.some((c) => c.kind === "clip" && c.id === clip));
  });

  it("restores and purges a mixed selection", async () => {
    const actor = { id: userId, admin: false };
    const gone = await h.makeProject(userId, "done");
    await h.pool.query(`update projects set deleted_at = now() - interval '1 hour', title = 'Bulk gone' where id = $1`, [gone]);
    const live = await h.makeProject(userId, "done");
    const clip = await h.makeClip(live, 0, "done", { outputKey: "clips/bulk.mp4" });
    await deleteClip(h.svc, actor, clip);

    const restored = await restoreDeleted(h.svc, actor, [
      { kind: "project", id: gone },
      { kind: "clip", id: clip },
    ]);
    assert.equal(restored.restored, 2);
    const afterRestore = await listDeleted(h.svc, userId);
    assert.ok(!afterRestore.items.some((r) => r.id === gone || r.id === clip));

    await h.pool.query(`update projects set deleted_at = now() where id = $1`, [gone]);
    await deleteClip(h.svc, actor, clip);
    const purged = await purgeDeleted(h.svc, actor, [
      { kind: "project", id: gone },
      { kind: "clip", id: clip },
    ]);
    assert.equal(purged.purged, 2);
    const goneRow = await h.pool.query(`select id from projects where id = $1`, [gone]);
    assert.equal(goneRow.rows.length, 0);
  });

  it("keeps a lone failure's own error, so a restore over the project cap still carries its quota actions", async () => {
    const owner = await h.makeUser();
    const actor = { id: owner, admin: false };
    await h.makeProject(owner, "done");
    const gone = await h.makeProject(owner, "done");
    await h.pool.query(`update projects set deleted_at = now() where id = $1`, [gone]);
    const settings = h.svc.settings.get() as { MAX_PROJECTS_PER_USER: number };
    const was = settings.MAX_PROJECTS_PER_USER;
    settings.MAX_PROJECTS_PER_USER = 1;
    try {
      await assert.rejects(restoreDeleted(h.svc, actor, [{ kind: "project", id: gone }]), (err: unknown) => {
        assert.ok(err instanceof QuotaError);
        assert.equal(err.quota?.key, "MAX_PROJECTS_PER_USER");
        return true;
      });
    } finally {
      settings.MAX_PROJECTS_PER_USER = was;
    }
  });

  it("says to restore the project when a clip's project is still deleted, and refuses to wipe a live project", async () => {
    const actor = { id: userId, admin: false };
    const p = await h.makeProject(userId, "done");
    const clip = await h.makeClip(p, 0, "done");
    await deleteClip(h.svc, actor, clip);
    await h.pool.query(`update projects set deleted_at = now() where id = $1`, [p]);
    await assert.rejects(restoreClip(h.svc, actor, clip), /restore_project/);
    await h.pool.query(`update projects set deleted_at = null where id = $1`, [p]);
    await assert.rejects(purgeOwnedProject(h.svc, actor, p), /Delete it first/);
    const still = await h.pool.query(`select id from projects where id = $1`, [p]);
    assert.equal(still.rows.length, 1);
  });

  it("purges a removed library item and refuses one that is still live", async () => {
    // purge trusts asset_refs only once its backfill is done (a booted app does it; a bare migrated DB has not)
    await h.pool.query(`insert into instance_settings (key, value, updated_by) values ('asset_refs.backfill', '{"done": true}'::jsonb, 'system') on conflict (key) do nothing`);
    const liveId = `a-${randomUUID().slice(0, 8)}`;
    const goneId = `a-${randomUUID().slice(0, 8)}`;
    await h.pool.query(
      `insert into assets (id, user_id, kind, name, duration_sec, width, height, has_audio, source_key, size_bytes) values ($1, $2, 'image', 'Live', 3, 10, 10, false, 'assets/live/source.png', 12)`,
      [liveId, userId],
    );
    await h.pool.query(
      `insert into assets (id, user_id, kind, name, duration_sec, width, height, has_audio, source_key, size_bytes, deleted_at) values ($1, $2, 'image', 'Gone', 3, 10, 10, false, 'assets/gone/source.png', 40, now())`,
      [goneId, userId],
    );
    await assert.rejects(purgeOwnedAsset(h.svc, userId, liveId), /Remove it first/);
    const r = await purgeOwnedAsset(h.svc, userId, goneId);
    assert.equal(r.storedBytes, 40);
    const gone = await h.pool.query(`select id from assets where id = $1`, [goneId]);
    assert.equal(gone.rows.length, 0);
  });

  it("purges a removed layer template", async () => {
    const id = `t-${randomUUID().slice(0, 8)}`;
    await h.pool.query(`insert into layer_templates (id, user_id, name, layers) values ($1, $2, 'Card', '[]'::jsonb)`, [id, userId]);
    await removeLayerTemplate(h.svc, userId, id);
    const page = await listDeleted(h.svc, userId);
    const row = page.items.find((t) => t.kind === "template" && t.id === id);
    assert.ok(row?.purgeAt);
    await purgeLayerTemplate(h.svc, userId, id);
    const gone = await h.pool.query(`select id from layer_templates where id = $1`, [id]);
    assert.equal(gone.rows.length, 0);
  });
});
