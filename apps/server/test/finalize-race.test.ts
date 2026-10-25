/**
 * Two clips finishing together: finalizeProjectIfDone serialises on the project row, so exactly one transaction
 * sees "every clip terminal" and emits project.done (or project.failed); the project ends in that state.
 * Postgres only.  node --import tsx --test test/finalize-race.test.ts
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { lifecycleHarness } from "./lifecycle-harness.js";
import { schema } from "../src/db/index.js";
import { finalizeProjectIfDone } from "../src/pipeline/lifecycle.js";

const h = lifecycleHarness();
const notReady = await h.ready();

describe("finalizeProjectIfDone under concurrency", { skip: notReady ?? false }, () => {
  let userId: string;
  before(async () => {
    userId = await h.makeUser();
  });
  after(() => h.cleanup());

  /** each unit marks its clip, emits clip.done, waits until the other has too (both now hold the project's key share), then finalizes */
  async function finishTogether(projectId: string, clipIds: string[], outcome: "done" | "failed" = "done") {
    let arrived = 0;
    let open!: () => void;
    const both = new Promise<void>((r) => (open = r));
    // a deadlock retry re-runs the unit; the barrier must not wait for a peer that already finished
    let released = false;
    await Promise.all(
      clipIds.map((clipId) =>
        h.tx(async (u) => {
          await u.db.update(schema.clips).set({ status: outcome }).where(eq(schema.clips.id, clipId));
          await u.emit(projectId, outcome === "done" ? "clip.done" : "clip.failed", { clipId });
          if (!released) {
            if (++arrived === clipIds.length) {
              released = true;
              open();
            }
            await Promise.race([both, new Promise((r) => setTimeout(r, 2000))]);
          }
          await finalizeProjectIfDone(h.svc, u, projectId);
        }),
      ),
    );
  }

  const state = async (projectId: string) => (await h.pool.query(`select status, stage from projects where id = $1`, [projectId])).rows[0];

  it("two clips finishing together emit project.done exactly once and the project ends done", async () => {
    for (let round = 0; round < 5; round++) {
      const projectId = await h.makeProject(userId, "rendering");
      const clips = [await h.makeClip(projectId, 0, "rendering"), await h.makeClip(projectId, 1, "rendering")];
      await finishTogether(projectId, clips);
      assert.equal((await state(projectId)).status, "done", `round ${round}`);
      assert.equal(await h.eventCount(projectId, "project.done"), 1, `round ${round}: one project.done`);
      assert.equal(await h.eventCount(projectId, "project.failed"), 0);
      assert.equal(await h.eventCount(projectId, "clip.done"), 2);
    }
  });

  it("four clips finishing together still emit once", async () => {
    const projectId = await h.makeProject(userId, "rendering");
    const clips = await Promise.all([0, 1, 2, 3].map((i) => h.makeClip(projectId, i, "rendering")));
    await finishTogether(projectId, clips);
    assert.equal((await state(projectId)).status, "done");
    assert.equal(await h.eventCount(projectId, "project.done"), 1);
    // the milestone ledger (notify/completion.ts) gets one row, pointing at that project.done
    const ledger = await h.pool.query(`select f.first_event_id::text as e, (select id::text from project_events where project_id = $1 and type = 'project.done') as done from finished_projects f where f.project_id = $1`, [projectId]);
    assert.equal(ledger.rows.length, 1);
    assert.equal(ledger.rows[0].e, ledger.rows[0].done);
  });

  it("every clip failing together emits project.failed exactly once", async () => {
    const projectId = await h.makeProject(userId, "rendering");
    const clips = [await h.makeClip(projectId, 0, "rendering"), await h.makeClip(projectId, 1, "rendering")];
    await finishTogether(projectId, clips, "failed");
    assert.equal((await state(projectId)).status, "failed");
    assert.equal(await h.eventCount(projectId, "project.failed"), 1);
    assert.equal(await h.eventCount(projectId, "project.done"), 0);
  });

  it("a clip still rendering keeps the project rendering; the last one to finish completes it", async () => {
    const projectId = await h.makeProject(userId, "rendering");
    const [a, b] = [await h.makeClip(projectId, 0, "rendering"), await h.makeClip(projectId, 1, "rendering")];
    await finishTogether(projectId, [a]);
    assert.equal((await state(projectId)).status, "rendering");
    assert.equal(await h.eventCount(projectId, "project.done"), 0);
    await finishTogether(projectId, [b]);
    assert.equal((await state(projectId)).status, "done");
    assert.equal(await h.eventCount(projectId, "project.done"), 1);
  });

  it("finalizing an already-done project again is a no-op (no second event)", async () => {
    const projectId = await h.makeProject(userId, "rendering");
    const clips = [await h.makeClip(projectId, 0, "rendering")];
    await finishTogether(projectId, clips);
    await Promise.all([h.tx((u) => finalizeProjectIfDone(h.svc, u, projectId)), h.tx((u) => finalizeProjectIfDone(h.svc, u, projectId))]);
    assert.equal(await h.eventCount(projectId, "project.done"), 1);
  });
});
